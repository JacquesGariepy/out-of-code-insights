// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'crypto';
import { lstat, realpath } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    createDocumentationManifest,
    DOCUMENTATION_MANIFEST_FILE,
    normalizeDocumentationFiles,
    normalizeDocumentationPath,
    parseDocumentationManifest,
    serializeDocumentationManifest,
    type DocumentationManifestEntry,
    type DocumentationManifestOptions,
} from './DocumentationManifest';

export interface DocumentationWriteResult {
    written: number;
    removed: number;
    warnings: string[];
}

export type DocumentationWritePhase =
    | 'queue-wait'
    | 'preflight'
    | 'journal'
    | 'prepare-stage'
    | 'write-stage'
    | 'prepare-backup'
    | 'backup'
    | 'prepare-install'
    | 'install'
    | 'cleanup';

export interface DocumentationWritePhaseEvent {
    outputUri: string;
    phase: DocumentationWritePhase;
    status: 'start' | 'complete' | 'failed';
    elapsedMs: number;
    durationMs?: number;
    details?: Readonly<Record<string, string | number | boolean>>;
}

export interface DocumentationWriteInstrumentation {
    onPhase(event: DocumentationWritePhaseEvent): void;
}

/** Stable, writer-owned recovery area inside the selected output directory. */
export const DOCUMENTATION_TRANSACTION_DIRECTORY = '.ooci-docs-transaction';

const TRANSACTION_JOURNAL_FILE = 'journal.json';
const TRANSACTION_JOURNAL_TEMP_FILE = 'journal.json.tmp';
const TRANSACTION_STAGING_DIRECTORY = 'stage';
const TRANSACTION_BACKUP_DIRECTORY = 'backup';

/**
 * Workspace FS calls cross the extension-host/provider boundary. A complete
 * documentation bundle contains dozens of independent files, so processing
 * every path serially turns the security checks themselves into the dominant
 * generation cost. Keep the fan-out deliberately small: paths remain fully
 * validated and transactions remain recoverable, while unrelated files can
 * make progress together without overwhelming remote file-system providers.
 */
const DOCUMENTATION_IO_CONCURRENCY = 8;

type PhaseDetails = Readonly<Record<string, string | number | boolean>>;

class DocumentationPhaseReporter {
    private readonly startedAt = performance.now();
    private phaseStartedAt = this.startedAt;
    private current: DocumentationWritePhase | undefined;

    constructor(
        private readonly outputUri: string,
        private readonly sink: ((event: DocumentationWritePhaseEvent) => void) | undefined
    ) {}

    public start(phase: DocumentationWritePhase, details?: PhaseDetails): void {
        if (!this.sink) {
            return;
        }
        this.current = phase;
        this.phaseStartedAt = performance.now();
        this.emit({ phase, status: 'start', elapsedMs: this.phaseStartedAt - this.startedAt, details });
    }

    public complete(details?: PhaseDetails): void {
        if (!this.sink || !this.current) {
            return;
        }
        const now = performance.now();
        this.emit({
            phase: this.current,
            status: 'complete',
            elapsedMs: now - this.startedAt,
            durationMs: now - this.phaseStartedAt,
            details,
        });
        this.current = undefined;
    }

    public fail(details?: PhaseDetails): void {
        if (!this.sink || !this.current) {
            return;
        }
        const now = performance.now();
        this.emit({
            phase: this.current,
            status: 'failed',
            elapsedMs: now - this.startedAt,
            durationMs: now - this.phaseStartedAt,
            details,
        });
        this.current = undefined;
    }

    private emit(event: Omit<DocumentationWritePhaseEvent, 'outputUri'>): void {
        try {
            this.sink?.({
                ...event,
                outputUri: this.outputUri,
                elapsedMs: Math.round(event.elapsedMs * 1000) / 1000,
                ...(event.durationMs === undefined ? {} : { durationMs: Math.round(event.durationMs * 1000) / 1000 }),
            });
        } catch {
            // Diagnostics must never alter transaction behaviour.
        }
    }
}

function createPhaseReporter(
    outputDirectory: vscode.Uri,
    instrumentation?: DocumentationWriteInstrumentation
): DocumentationPhaseReporter {
    const sink =
        instrumentation?.onPhase ??
        (process.env.OOCI_DOCS_WRITER_PROFILE === '1'
            ? (event: DocumentationWritePhaseEvent): void => {
                  // eslint-disable-next-line no-console
                  console.info(`[ooci-docs-writer] ${JSON.stringify(event)}`);
              }
            : undefined);
    return new DocumentationPhaseReporter(outputDirectory.toString(), sink);
}

/**
 * Run independent operations with bounded concurrency and fail as one phase.
 * Once an operation fails no new work is scheduled, but already-started work
 * is awaited before the error is rethrown. This is essential for transaction
 * recovery: rollback must never race an in-flight rename or write.
 */
async function mapDocumentationFiles<T, TResult>(
    items: readonly T[],
    operation: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
    if (items.length === 0) {
        return [];
    }

    const results = new Array<TResult>(items.length);
    let nextIndex = 0;
    let failed = false;
    let failure: unknown;

    const worker = async (): Promise<void> => {
        while (!failed) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            try {
                results[index] = await operation(items[index], index);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                }
            }
        }
    };

    const workerCount = Math.min(DOCUMENTATION_IO_CONCURRENCY, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed) {
        throw failure;
    }
    return results;
}

interface FileFingerprint {
    sha256: string;
    bytes: number;
}

interface TransactionFile {
    path: string;
    previous?: FileFingerprint;
    next?: FileFingerprint;
}

interface TransactionJournal {
    schemaVersion: 1;
    writer: 'out-of-code-insights';
    outputUri: string;
    files: TransactionFile[];
}

interface RecoveryResult {
    status: 'none' | 'committed' | 'rolled-back' | 'incomplete';
    errors: Error[];
}

/** An operation plus every independent recovery failure, without hiding the primary cause. */
export class DocumentationTransactionError extends Error {
    public readonly errors: readonly Error[];

    constructor(message: string, errors: readonly Error[]) {
        super(`${message}\n${errors.map((error, index) => `${index + 1}. ${error.message}`).join('\n')}`);
        this.name = 'DocumentationTransactionError';
        this.errors = [...errors];
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
        return await vscode.workspace.fs.stat(uri);
    } catch (error) {
        if (isMissingFileSystemError(error)) {
            return undefined;
        }
        throw error;
    }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    return (await stat(uri)) !== undefined;
}

function isSymbolicLink(fileStat: vscode.FileStat): boolean {
    return (fileStat.type & vscode.FileType.SymbolicLink) !== 0;
}

function isFile(fileStat: vscode.FileStat): boolean {
    return !isSymbolicLink(fileStat) && (fileStat.type & vscode.FileType.File) !== 0;
}

function isDirectory(fileStat: vscode.FileStat): boolean {
    return !isSymbolicLink(fileStat) && (fileStat.type & vscode.FileType.Directory) !== 0;
}

function child(root: vscode.Uri, relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(root, ...relativePath.split('/'));
}

function isInsideNativePath(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
}

function isMissingFileSystemError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'FileNotFound';
}

/**
 * Enforce both lexical containment and physical containment for local files.
 * The selected workspace root itself is trusted (and may itself have been
 * opened through a symlink), but no existing descendant may be a symlink or
 * junction. The nearest existing ancestor is also resolved to defeat aliases.
 */
async function assertFileWorkspaceConfinement(workspaceRoot: vscode.Uri, candidate: vscode.Uri): Promise<void> {
    const lexicalRoot = path.resolve(workspaceRoot.fsPath);
    const lexicalCandidate = path.resolve(candidate.fsPath);
    if (!isInsideNativePath(lexicalRoot, lexicalCandidate)) {
        throw new Error(`Documentation path escapes the selected workspace: ${candidate.fsPath}`);
    }

    let physicalRoot: string;
    try {
        physicalRoot = await realpath(lexicalRoot);
        const physicalRootStat = await lstat(physicalRoot);
        if (!physicalRootStat.isDirectory()) {
            throw new Error('The selected workspace root is not a directory.');
        }
    } catch (error) {
        throw new Error(`Cannot resolve the selected workspace root: ${asError(error).message}`);
    }

    const relative = path.relative(lexicalRoot, lexicalCandidate);
    const segments = relative === '' ? [] : relative.split(path.sep).filter(Boolean);
    let current = lexicalRoot;
    let nearestExisting = lexicalRoot;
    for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);
        try {
            const currentStat = await lstat(current);
            if (currentStat.isSymbolicLink()) {
                throw new Error(`Documentation path crosses a symbolic link or junction: ${current}`);
            }
            if (index < segments.length - 1 && !currentStat.isDirectory()) {
                throw new Error(`Documentation path crosses a non-directory: ${current}`);
            }
            nearestExisting = current;
        } catch (error) {
            if (isMissingFileSystemError(error)) {
                break;
            }
            throw error;
        }
    }

    const physicalAncestor = await realpath(nearestExisting);
    if (!isInsideNativePath(physicalRoot, physicalAncestor)) {
        throw new Error(`Documentation path resolves outside the selected workspace: ${candidate.fsPath}`);
    }
}

async function assertProviderWorkspaceConfinement(workspaceRoot: vscode.Uri, candidate: vscode.Uri): Promise<void> {
    if (workspaceRoot.scheme !== candidate.scheme || workspaceRoot.authority !== candidate.authority) {
        throw new Error('Documentation output must use the same workspace file system provider.');
    }
    const rootPath = path.posix.resolve('/', workspaceRoot.path);
    const candidatePath = path.posix.resolve('/', candidate.path);
    const relative = path.posix.relative(rootPath, candidatePath);
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
        throw new Error(`Documentation path escapes the selected workspace: ${candidate.toString()}`);
    }

    const rootStat = await stat(workspaceRoot);
    if (!rootStat || !isDirectory(rootStat)) {
        throw new Error('The selected workspace root is not a real directory.');
    }
    let current = workspaceRoot;
    const segments = relative === '' ? [] : relative.split('/');
    for (let index = 0; index < segments.length; index++) {
        current = vscode.Uri.joinPath(current, segments[index]);
        const currentStat = await stat(current);
        if (!currentStat) {
            break;
        }
        if (isSymbolicLink(currentStat)) {
            throw new Error(`Documentation path crosses a symbolic link: ${current.toString()}`);
        }
        if (index < segments.length - 1 && !isDirectory(currentStat)) {
            throw new Error(`Documentation path crosses a non-directory: ${current.toString()}`);
        }
    }
}

async function assertWorkspaceConfinement(workspaceRoot: vscode.Uri, candidate: vscode.Uri): Promise<void> {
    if (workspaceRoot.scheme === 'file' && candidate.scheme === 'file') {
        if (workspaceRoot.authority.toLocaleLowerCase('en-US') !== candidate.authority.toLocaleLowerCase('en-US')) {
            throw new Error('Documentation output must use the same local file-system authority as the workspace.');
        }
        await assertFileWorkspaceConfinement(workspaceRoot, candidate);
        return;
    }
    await assertProviderWorkspaceConfinement(workspaceRoot, candidate);
}

function parentDirectoryPaths(relativePaths: Iterable<string>): string[] {
    const directories = new Set<string>();
    for (const relativePath of relativePaths) {
        const parts = relativePath.split('/');
        parts.pop();
        for (let length = 1; length <= parts.length; length++) {
            directories.add(parts.slice(0, length).join('/'));
        }
    }
    return [...directories].sort((left, right) => {
        const depth = left.split('/').length - right.split('/').length;
        return depth === 0 ? left.localeCompare(right) : depth;
    });
}

async function realDirectoryState(uri: vscode.Uri): Promise<'missing' | 'directory'> {
    if (uri.scheme === 'file') {
        try {
            const fileStat = await lstat(uri.fsPath);
            if (fileStat.isSymbolicLink() || !fileStat.isDirectory()) {
                throw new Error(`Documentation parent is not a real directory: ${uri.fsPath}`);
            }
            return 'directory';
        } catch (error) {
            if (isMissingFileSystemError(error)) {
                return 'missing';
            }
            throw error;
        }
    }

    const fileStat = await stat(uri);
    if (!fileStat) {
        return 'missing';
    }
    if (!isDirectory(fileStat)) {
        throw new Error(`Documentation parent is not a real directory: ${uri.toString()}`);
    }
    return 'directory';
}

/**
 * Validate a bundle's shared directory graph once per transaction phase.
 * Paths already passed normalizeDocumentationPath, so checking each unique
 * ancestor is equivalent to walking every file's parent chain without doing
 * the same realpath/lstat work dozens of times.
 */
async function prepareParentDirectories(
    workspaceRoot: vscode.Uri,
    root: vscode.Uri,
    relativePaths: Iterable<string>,
    createMissing: boolean
): Promise<void> {
    await assertWorkspaceConfinement(workspaceRoot, root);
    let rootState = await realDirectoryState(root);
    if (rootState === 'missing') {
        if (!createMissing) {
            return;
        }
        await vscode.workspace.fs.createDirectory(root);
        rootState = await realDirectoryState(root);
    }
    if (rootState !== 'directory') {
        throw new Error('Documentation parent root could not be created safely.');
    }

    const directories = parentDirectoryPaths(relativePaths);
    for (const directoryPath of directories) {
        const directory = child(root, directoryPath);
        const state = await realDirectoryState(directory);
        if (state === 'directory') {
            continue;
        }
        if (!createMissing) {
            continue;
        }
        await vscode.workspace.fs.createDirectory(directory);
        if ((await realDirectoryState(directory)) !== 'directory') {
            throw new Error(`Documentation parent could not be created safely: ${directory.toString()}`);
        }
    }
    await mapDocumentationFiles(directories, (directoryPath) =>
        assertWorkspaceConfinement(workspaceRoot, child(root, directoryPath))
    );
    await assertWorkspaceConfinement(workspaceRoot, root);
}

/** Recheck the rename endpoint's immediate parent without repeating full workspace realpath traversal. */
async function assertImmediateParentDirectory(root: vscode.Uri, relativePath: string): Promise<void> {
    const parts = relativePath.split('/');
    parts.pop();
    const parent = parts.length === 0 ? root : vscode.Uri.joinPath(root, ...parts);
    if ((await realDirectoryState(parent)) !== 'directory') {
        throw new Error(`Documentation rename parent is missing: ${parent.toString()}`);
    }
}

async function createParent(workspaceRoot: vscode.Uri, root: vscode.Uri, relativePath: string): Promise<void> {
    const parts = relativePath.split('/');
    parts.pop();
    if (parts.length === 0) {
        return;
    }
    const parent = vscode.Uri.joinPath(root, ...parts);
    await assertWorkspaceConfinement(workspaceRoot, parent);
    await assertSafeParentChain(root, relativePath);
    await vscode.workspace.fs.createDirectory(parent);
    await assertWorkspaceConfinement(workspaceRoot, parent);
    await assertSafeParentChain(root, relativePath);
}

async function assertSafeParentChain(root: vscode.Uri, relativePath: string): Promise<void> {
    const rootStat = await stat(root);
    if (!rootStat) {
        return;
    }
    if (!isDirectory(rootStat)) {
        throw new Error('Documentation output path exists but is not a real directory.');
    }
    const parts = relativePath.split('/');
    parts.pop();
    let current = root;
    for (const part of parts) {
        current = vscode.Uri.joinPath(current, part);
        const currentStat = await stat(current);
        if (!currentStat) {
            return;
        }
        if (!isDirectory(currentStat)) {
            throw new Error(`Documentation parent path "${relativePath}" crosses a file or symbolic link.`);
        }
    }
}

function fingerprintBytes(bytes: Uint8Array): FileFingerprint {
    const buffer = Buffer.from(bytes);
    return {
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.byteLength,
    };
}

function fingerprintText(content: string): FileFingerprint {
    return fingerprintBytes(Buffer.from(content, 'utf8'));
}

async function fingerprintUri(uri: vscode.Uri): Promise<FileFingerprint> {
    const fileStat = await stat(uri);
    if (!fileStat || !isFile(fileStat)) {
        throw new Error(`Expected a real file at ${uri.toString()}.`);
    }
    return fingerprintBytes(await vscode.workspace.fs.readFile(uri));
}

function fingerprintsEqual(left: FileFingerprint, right: FileFingerprint): boolean {
    return left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function fingerprintFromEntry(entry: DocumentationManifestEntry): FileFingerprint {
    return { sha256: entry.sha256, bytes: entry.bytes };
}

function isValidFingerprint(value: unknown): value is FileFingerprint {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<FileFingerprint>;
    return (
        typeof candidate.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(candidate.sha256) &&
        typeof candidate.bytes === 'number' &&
        Number.isSafeInteger(candidate.bytes) &&
        candidate.bytes >= 0
    );
}

function isTransactionPath(filePath: string): boolean {
    const folded = filePath.toLocaleLowerCase('en-US');
    const transaction = DOCUMENTATION_TRANSACTION_DIRECTORY.toLocaleLowerCase('en-US');
    return folded === transaction || folded.startsWith(`${transaction}/`);
}

function parseTransactionJournal(input: string): TransactionJournal | undefined {
    try {
        const value = JSON.parse(input) as Partial<TransactionJournal>;
        if (
            value.schemaVersion !== 1 ||
            value.writer !== 'out-of-code-insights' ||
            typeof value.outputUri !== 'string' ||
            !Array.isArray(value.files)
        ) {
            return undefined;
        }
        const files: TransactionFile[] = [];
        const seen = new Set<string>();
        for (const entry of value.files) {
            if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string') {
                return undefined;
            }
            const filePath = normalizeDocumentationPath(entry.path);
            const folded = filePath.toLocaleLowerCase('en-US');
            if (seen.has(folded) || isTransactionPath(filePath)) {
                return undefined;
            }
            seen.add(folded);
            const previous = isValidFingerprint(entry.previous) ? { ...entry.previous } : undefined;
            const next = isValidFingerprint(entry.next) ? { ...entry.next } : undefined;
            if (
                (!previous && !next) ||
                (entry.previous !== undefined && !previous) ||
                (entry.next !== undefined && !next)
            ) {
                return undefined;
            }
            files.push({ path: filePath, ...(previous ? { previous } : {}), ...(next ? { next } : {}) });
        }
        const manifest = files.find((entry) => entry.path === DOCUMENTATION_MANIFEST_FILE);
        if (!manifest?.next) {
            return undefined;
        }
        return {
            schemaVersion: 1,
            writer: 'out-of-code-insights',
            outputUri: value.outputUri,
            files,
        };
    } catch {
        return undefined;
    }
}

function serializeTransactionJournal(journal: TransactionJournal): string {
    return JSON.stringify(journal, null, 2) + '\n';
}

async function assertOwnedDestination(
    outputDirectory: vscode.Uri,
    filePath: string,
    previousEntries: ReadonlyMap<string, DocumentationManifestEntry>,
    previousManifestContent: string | undefined
): Promise<boolean> {
    const destination = child(outputDirectory, filePath);
    const destinationStat = await stat(destination);
    if (!destinationStat) {
        return false;
    }
    if (!isFile(destinationStat)) {
        throw new Error(
            `Refusing to replace documentation path "${filePath}" because it is a directory or symbolic link.`
        );
    }
    if (filePath === DOCUMENTATION_MANIFEST_FILE) {
        if (previousManifestContent === undefined) {
            throw new Error(
                `Refusing to replace unmanaged ${DOCUMENTATION_MANIFEST_FILE}; move or remove it explicitly.`
            );
        }
        const current = Buffer.from(await vscode.workspace.fs.readFile(destination)).toString('utf8');
        if (current !== previousManifestContent) {
            throw new Error(`Refusing to replace ${DOCUMENTATION_MANIFEST_FILE} because it changed during generation.`);
        }
        return true;
    }
    const expected = previousEntries.get(filePath.toLocaleLowerCase('en-US'));
    if (!expected) {
        throw new Error(
            `Refusing to overwrite unmanaged documentation file "${filePath}". ` +
                'Choose another output folder or move the file explicitly.'
        );
    }
    const current = await fingerprintUri(destination);
    if (!fingerprintsEqual(current, fingerprintFromEntry(expected))) {
        throw new Error(
            `Refusing to overwrite managed documentation file "${filePath}" because its content changed after generation.`
        );
    }
    return true;
}

async function assertNoSymbolicLinks(uri: vscode.Uri): Promise<void> {
    const rootStat = await stat(uri);
    if (!rootStat) {
        return;
    }
    if (!isDirectory(rootStat)) {
        throw new Error(`Transaction path is not a real directory: ${uri.toString()}`);
    }
    const pending = [uri];
    while (pending.length > 0) {
        const directory = pending.pop();
        if (!directory) {
            continue;
        }
        for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
            const entry = vscode.Uri.joinPath(directory, name);
            const entryStat = type === vscode.FileType.Unknown ? await stat(entry) : { type };
            if (!entryStat || isSymbolicLink(entryStat as vscode.FileStat)) {
                throw new Error(`Transaction directory contains a symbolic link: ${entry.toString()}`);
            }
            if ((entryStat.type & vscode.FileType.Directory) !== 0) {
                pending.push(entry);
            }
        }
    }
}

async function removeTransactionDirectory(workspaceRoot: vscode.Uri, transactionDirectory: vscode.Uri): Promise<void> {
    await assertWorkspaceConfinement(workspaceRoot, transactionDirectory);
    await assertNoSymbolicLinks(transactionDirectory);
    if (await exists(transactionDirectory)) {
        await vscode.workspace.fs.delete(transactionDirectory, { recursive: true, useTrash: false });
    }
}

async function readFingerprintIfPresent(uri: vscode.Uri): Promise<FileFingerprint | undefined> {
    const fileStat = await stat(uri);
    if (!fileStat) {
        return undefined;
    }
    if (!isFile(fileStat)) {
        throw new Error(`Recovery path is a directory or symbolic link: ${uri.toString()}`);
    }
    return fingerprintUri(uri);
}

async function recoverTransaction(workspaceRoot: vscode.Uri, outputDirectory: vscode.Uri): Promise<RecoveryResult> {
    const transactionDirectory = child(outputDirectory, DOCUMENTATION_TRANSACTION_DIRECTORY);
    const transactionStat = await stat(transactionDirectory);
    if (!transactionStat) {
        return { status: 'none', errors: [] };
    }
    const errors: Error[] = [];
    try {
        await assertWorkspaceConfinement(workspaceRoot, transactionDirectory);
        if (!isDirectory(transactionStat)) {
            throw new Error('The documentation transaction path is not a real directory.');
        }
        // The journal and backups are security-sensitive inputs during
        // recovery. Reject a planted link anywhere below the stable
        // transaction root before reading or moving any of them.
        await assertNoSymbolicLinks(transactionDirectory);
        const journalUri = child(transactionDirectory, TRANSACTION_JOURNAL_FILE);
        const journalStat = await stat(journalUri);
        if (!journalStat || !isFile(journalStat)) {
            throw new Error('The existing documentation transaction has no trustworthy journal.');
        }
        const journal = parseTransactionJournal(
            Buffer.from(await vscode.workspace.fs.readFile(journalUri)).toString('utf8')
        );
        if (!journal || journal.outputUri !== outputDirectory.toString()) {
            throw new Error('The existing documentation transaction journal is invalid or belongs to another output.');
        }

        const manifestRecord = journal.files.find((entry) => entry.path === DOCUMENTATION_MANIFEST_FILE);
        if (!manifestRecord?.next) {
            throw new Error('The documentation transaction journal has no next manifest fingerprint.');
        }
        const currentManifest = await readFingerprintIfPresent(child(outputDirectory, DOCUMENTATION_MANIFEST_FILE));
        if (currentManifest && fingerprintsEqual(currentManifest, manifestRecord.next)) {
            try {
                await removeTransactionDirectory(workspaceRoot, transactionDirectory);
            } catch (error) {
                errors.push(asError(error));
            }
            return { status: errors.length === 0 ? 'committed' : 'incomplete', errors };
        }

        const backupDirectory = child(transactionDirectory, TRANSACTION_BACKUP_DIRECTORY);

        // First remove only byte-identical newly installed files. Anything
        // else may have been edited after the interrupted generation and is
        // deliberately preserved for manual reconciliation.
        for (const file of [...journal.files].reverse()) {
            if (!file.next) {
                continue;
            }
            const destination = child(outputDirectory, file.path);
            try {
                const current = await readFingerprintIfPresent(destination);
                if (!current || (file.previous && fingerprintsEqual(current, file.previous))) {
                    continue;
                }
                if (!fingerprintsEqual(current, file.next)) {
                    throw new Error(`Refusing to remove modified recovery destination "${file.path}".`);
                }
                await vscode.workspace.fs.delete(destination, { recursive: false, useTrash: false });
            } catch (error) {
                errors.push(asError(error));
            }
        }

        // Restore every previous file independently. A failed path does not
        // prevent other paths from being repaired, and rename never uses
        // overwrite so a concurrent/user modification cannot be destroyed.
        for (const file of journal.files) {
            if (!file.previous) {
                continue;
            }
            const destination = child(outputDirectory, file.path);
            const backup = child(backupDirectory, file.path);
            try {
                const destinationState = await readFingerprintIfPresent(destination);
                if (destinationState) {
                    if (!fingerprintsEqual(destinationState, file.previous)) {
                        throw new Error(`Refusing to overwrite modified recovery destination "${file.path}".`);
                    }
                    continue;
                }
                const backupState = await readFingerprintIfPresent(backup);
                if (!backupState) {
                    throw new Error(`Recovery backup is missing for "${file.path}".`);
                }
                if (!fingerprintsEqual(backupState, file.previous)) {
                    throw new Error(`Recovery backup was modified for "${file.path}".`);
                }
                await createParent(workspaceRoot, outputDirectory, file.path);
                await vscode.workspace.fs.rename(backup, destination, { overwrite: false });
            } catch (error) {
                errors.push(asError(error));
            }
        }

        if (errors.length === 0) {
            try {
                await removeTransactionDirectory(workspaceRoot, transactionDirectory);
            } catch (error) {
                errors.push(asError(error));
            }
        }
        return { status: errors.length === 0 ? 'rolled-back' : 'incomplete', errors };
    } catch (error) {
        errors.push(asError(error));
        return { status: 'incomplete', errors };
    }
}

function transactionError(message: string, errors: readonly Error[]): DocumentationTransactionError {
    return new DocumentationTransactionError(message, errors.length > 0 ? errors : [new Error('Unknown failure.')]);
}

const documentationWriteQueues = new Map<string, Promise<void>>();

function documentationOutputKey(outputDirectory: vscode.Uri): string {
    if (outputDirectory.scheme === 'file') {
        const nativePath = path.resolve(outputDirectory.fsPath);
        return process.platform === 'win32' ? nativePath.toLocaleLowerCase('en-US') : nativePath;
    }
    return outputDirectory.toString(true);
}

/** Serialize writers that share an output so their stable transaction area can never overlap. */
export async function writeDocumentationBundle(
    workspaceRoot: vscode.Uri,
    outputDirectory: vscode.Uri,
    files: ReadonlyMap<string, string>,
    options: DocumentationManifestOptions,
    instrumentation?: DocumentationWriteInstrumentation
): Promise<DocumentationWriteResult> {
    const key = documentationOutputKey(outputDirectory);
    const queued = documentationWriteQueues.has(key);
    const predecessor = documentationWriteQueues.get(key) ?? Promise.resolve();
    const phases = createPhaseReporter(outputDirectory, instrumentation);
    phases.start('queue-wait', { queued });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    documentationWriteQueues.set(key, tail);

    await predecessor.catch(() => undefined);
    phases.complete({ queued });
    try {
        return await writeDocumentationBundleExclusive(workspaceRoot, outputDirectory, files, options, phases);
    } catch (error) {
        phases.fail({ error: asError(error).name });
        throw error;
    } finally {
        release();
        if (documentationWriteQueues.get(key) === tail) {
            documentationWriteQueues.delete(key);
        }
    }
}

/**
 * Commit a generated bundle through a stable, recoverable transaction inside
 * the selected workspace. Only files listed by the previous manifest can
 * become stale; unrelated files in the output directory remain untouched.
 */
async function writeDocumentationBundleExclusive(
    workspaceRoot: vscode.Uri,
    outputDirectory: vscode.Uri,
    files: ReadonlyMap<string, string>,
    options: DocumentationManifestOptions,
    phases: DocumentationPhaseReporter
): Promise<DocumentationWriteResult> {
    phases.start('preflight', { requestedFiles: files.size });
    await assertWorkspaceConfinement(workspaceRoot, outputDirectory);
    const normalized = normalizeDocumentationFiles(files);
    for (const filePath of normalized.keys()) {
        if (isTransactionPath(filePath)) {
            throw new Error(`Generated documentation path "${filePath}" is reserved for transaction recovery.`);
        }
    }

    const warnings: string[] = [];
    const priorRecovery = await recoverTransaction(workspaceRoot, outputDirectory);
    if (priorRecovery.errors.length > 0) {
        throw transactionError('Cannot safely recover the previous documentation generation.', priorRecovery.errors);
    }
    if (priorRecovery.status === 'committed') {
        warnings.push('Completed cleanup for a previously committed documentation generation.');
    } else if (priorRecovery.status === 'rolled-back') {
        warnings.push('Recovered and rolled back an interrupted documentation generation.');
    }

    const manifest = createDocumentationManifest(normalized, options);
    const manifestContent = serializeDocumentationManifest(manifest);
    let previousPaths: string[] = [];
    let previousManifestContent: string | undefined;
    const previousEntries = new Map<string, DocumentationManifestEntry>();
    const outputStat = await stat(outputDirectory);
    if (outputStat && !isDirectory(outputStat)) {
        throw new Error('Documentation output path exists but is not a real directory.');
    }
    const previousManifestUri = child(outputDirectory, DOCUMENTATION_MANIFEST_FILE);
    const previousManifestStat = await stat(previousManifestUri);
    if (previousManifestStat) {
        if (!isFile(previousManifestStat)) {
            throw new Error(`Refusing to read ${DOCUMENTATION_MANIFEST_FILE} through a directory or symbolic link.`);
        }
        const raw = Buffer.from(await vscode.workspace.fs.readFile(previousManifestUri)).toString('utf8');
        const previous = parseDocumentationManifest(raw);
        if (!previous) {
            throw new Error(`The existing ${DOCUMENTATION_MANIFEST_FILE} is invalid; it was not trusted or replaced.`);
        }
        previousManifestContent = raw;
        previousPaths = previous.files.map((entry) => entry.path);
        for (const entry of previous.files) {
            if (isTransactionPath(entry.path)) {
                throw new Error(`The existing manifest claims reserved transaction path "${entry.path}".`);
            }
            previousEntries.set(entry.path.toLocaleLowerCase('en-US'), entry);
        }
    }

    const nextPathsByFold = new Map(
        [...normalized.keys()].map((filePath) => [filePath.toLocaleLowerCase('en-US'), filePath] as const)
    );
    for (const previousPath of previousPaths) {
        const nextPath = nextPathsByFold.get(previousPath.toLocaleLowerCase('en-US'));
        if (nextPath && nextPath !== previousPath) {
            throw new Error(`Refusing unsafe case-only documentation rename from "${previousPath}" to "${nextPath}".`);
        }
    }
    const stalePaths = previousPaths.filter((filePath) => !nextPathsByFold.has(filePath.toLocaleLowerCase('en-US')));
    const affected = [...new Set([...normalized.keys(), ...stalePaths, DOCUMENTATION_MANIFEST_FILE])].sort(
        (left, right) => {
            if (left === DOCUMENTATION_MANIFEST_FILE) {
                return 1;
            }
            if (right === DOCUMENTATION_MANIFEST_FILE) {
                return -1;
            }
            return left.localeCompare(right);
        }
    );
    const staleExisting = new Set<string>();

    // Complete ownership/type checks before creating any transaction state.
    const stalePathSet = new Set(stalePaths);
    await prepareParentDirectories(workspaceRoot, outputDirectory, affected, false);
    const ownership = await mapDocumentationFiles(affected, (filePath) =>
        assertOwnedDestination(outputDirectory, filePath, previousEntries, previousManifestContent)
    );
    const initiallyPresent = new Map<string, boolean>();
    for (let index = 0; index < affected.length; index++) {
        initiallyPresent.set(affected[index], ownership[index]);
        if (ownership[index] && stalePathSet.has(affected[index])) {
            staleExisting.add(affected[index]);
        }
    }

    const nextEntries = new Map(manifest.files.map((entry) => [entry.path.toLocaleLowerCase('en-US'), entry] as const));
    const journal: TransactionJournal = {
        schemaVersion: 1,
        writer: 'out-of-code-insights',
        outputUri: outputDirectory.toString(),
        files: affected
            .map((filePath): TransactionFile => {
                const previousEntry = previousEntries.get(filePath.toLocaleLowerCase('en-US'));
                const nextEntry = nextEntries.get(filePath.toLocaleLowerCase('en-US'));
                const previous: FileFingerprint | undefined =
                    initiallyPresent.get(filePath) === true
                        ? filePath === DOCUMENTATION_MANIFEST_FILE
                            ? previousManifestContent === undefined
                                ? undefined
                                : fingerprintText(previousManifestContent)
                            : previousEntry
                              ? fingerprintFromEntry(previousEntry)
                              : undefined
                        : undefined;
                const next: FileFingerprint | undefined =
                    filePath === DOCUMENTATION_MANIFEST_FILE
                        ? fingerprintText(manifestContent)
                        : nextEntry
                          ? fingerprintFromEntry(nextEntry)
                          : undefined;
                return {
                    path: filePath,
                    ...(previous ? { previous } : {}),
                    ...(next ? { next } : {}),
                };
            })
            .filter((file) => file.previous !== undefined || file.next !== undefined),
    };

    phases.complete({
        normalizedFiles: normalized.size,
        affectedFiles: affected.length,
        staleFiles: stalePaths.length,
        presentFiles: ownership.filter(Boolean).length,
    });
    phases.start('journal', { journalFiles: journal.files.length });

    await vscode.workspace.fs.createDirectory(outputDirectory);
    await assertWorkspaceConfinement(workspaceRoot, outputDirectory);
    const transactionDirectory = child(outputDirectory, DOCUMENTATION_TRANSACTION_DIRECTORY);
    const staging = child(transactionDirectory, TRANSACTION_STAGING_DIRECTORY);
    const backup = child(transactionDirectory, TRANSACTION_BACKUP_DIRECTORY);
    let ownsTransactionDirectory = false;
    let destinationMutationStarted = false;

    try {
        if (await exists(transactionDirectory)) {
            throw new Error('A documentation transaction already exists after recovery.');
        }
        await vscode.workspace.fs.createDirectory(transactionDirectory);
        await assertWorkspaceConfinement(workspaceRoot, transactionDirectory);
        ownsTransactionDirectory = true;
        const journalContent = serializeTransactionJournal(journal);
        const expectedJournal = fingerprintText(journalContent);
        const journalTemp = child(transactionDirectory, TRANSACTION_JOURNAL_TEMP_FILE);
        const journalDestination = child(transactionDirectory, TRANSACTION_JOURNAL_FILE);
        await vscode.workspace.fs.writeFile(journalTemp, Buffer.from(journalContent, 'utf8'));
        if (!fingerprintsEqual(await fingerprintUri(journalTemp), expectedJournal)) {
            throw new Error('Documentation transaction journal staging failed integrity verification.');
        }
        await assertImmediateParentDirectory(transactionDirectory, TRANSACTION_JOURNAL_TEMP_FILE);
        await vscode.workspace.fs.rename(journalTemp, journalDestination, { overwrite: false });
        if (!fingerprintsEqual(await fingerprintUri(journalDestination), expectedJournal)) {
            throw new Error('Documentation transaction journal failed integrity verification.');
        }

        phases.complete({ journalFiles: journal.files.length });
        phases.start('prepare-stage', { files: normalized.size + 1 });
        await vscode.workspace.fs.createDirectory(staging);
        await vscode.workspace.fs.createDirectory(backup);

        const installPaths = [...normalized.keys(), DOCUMENTATION_MANIFEST_FILE];
        await prepareParentDirectories(workspaceRoot, staging, installPaths, true);

        phases.complete({ files: installPaths.length });
        phases.start('write-stage', { files: installPaths.length });
        await mapDocumentationFiles([...normalized], async ([filePath, content]) => {
            const staged = child(staging, filePath);
            await vscode.workspace.fs.writeFile(staged, Buffer.from(content, 'utf8'));
            const expected = nextEntries.get(filePath.toLocaleLowerCase('en-US'));
            if (!expected || !fingerprintsEqual(await fingerprintUri(staged), fingerprintFromEntry(expected))) {
                throw new Error(`Staged documentation file "${filePath}" failed integrity verification.`);
            }
        });
        const stagedManifest = child(staging, DOCUMENTATION_MANIFEST_FILE);
        await vscode.workspace.fs.writeFile(stagedManifest, Buffer.from(manifestContent, 'utf8'));
        if (!fingerprintsEqual(await fingerprintUri(stagedManifest), fingerprintText(manifestContent))) {
            throw new Error('Staged documentation manifest failed integrity verification.');
        }

        phases.complete({ files: installPaths.length });
        phases.start('prepare-backup', { files: affected.length });
        await prepareParentDirectories(workspaceRoot, backup, affected, true);
        await prepareParentDirectories(workspaceRoot, outputDirectory, affected, false);
        const backupDestination = async (filePath: string): Promise<void> => {
            const destination = child(outputDirectory, filePath);
            const present = await assertOwnedDestination(
                outputDirectory,
                filePath,
                previousEntries,
                previousManifestContent
            );
            if (present !== initiallyPresent.get(filePath)) {
                throw new Error(`Documentation destination "${filePath}" changed before transaction backup.`);
            }
            if (present) {
                await assertImmediateParentDirectory(outputDirectory, filePath);
                await assertImmediateParentDirectory(backup, filePath);
                await vscode.workspace.fs.rename(destination, child(backup, filePath), { overwrite: false });
            }
        };

        phases.complete({ files: affected.length });
        phases.start('backup', { files: ownership.filter(Boolean).length });
        // Keep the previous manifest visible until every owned content file is
        // safely backed up. It remains the old generation's validity marker.
        destinationMutationStarted = true;
        await mapDocumentationFiles(
            affected.filter((filePath) => filePath !== DOCUMENTATION_MANIFEST_FILE),
            backupDestination
        );
        await backupDestination(DOCUMENTATION_MANIFEST_FILE);

        phases.complete({ files: ownership.filter(Boolean).length });
        phases.start('prepare-install', { files: installPaths.length });
        // The manifest is the commit marker and is deliberately installed last.
        await prepareParentDirectories(workspaceRoot, staging, installPaths, false);
        await prepareParentDirectories(workspaceRoot, outputDirectory, installPaths, true);

        phases.complete({ files: installPaths.length });
        phases.start('install', { files: installPaths.length });
        const records = new Map(journal.files.map((entry) => [entry.path, entry] as const));
        const installStagedFile = async (filePath: string): Promise<void> => {
            if (await exists(child(outputDirectory, filePath))) {
                throw new Error(`Documentation destination "${filePath}" changed during generation.`);
            }
            const staged = child(staging, filePath);
            const record = records.get(filePath);
            if (!record?.next || !fingerprintsEqual(await fingerprintUri(staged), record.next)) {
                throw new Error(`Staged documentation file "${filePath}" changed during generation.`);
            }
            await assertImmediateParentDirectory(staging, filePath);
            await assertImmediateParentDirectory(outputDirectory, filePath);
            await vscode.workspace.fs.rename(staged, child(outputDirectory, filePath), { overwrite: false });
        };
        await mapDocumentationFiles([...normalized.keys()], installStagedFile);
        await installStagedFile(DOCUMENTATION_MANIFEST_FILE);

        phases.complete({ files: installPaths.length });
        phases.start('cleanup');
        try {
            await removeTransactionDirectory(workspaceRoot, transactionDirectory);
        } catch (error) {
            // The manifest is already committed. A later run will retry this
            // cleanup before beginning a new transaction.
            warnings.push(`Documentation committed, but transaction cleanup is pending: ${asError(error).message}`);
        }
        phases.complete({ warnings: warnings.length });
        return { written: normalized.size, removed: staleExisting.size, warnings };
    } catch (error) {
        const primary = asError(error);
        phases.fail({ error: primary.name });
        if (ownsTransactionDirectory && !destinationMutationStarted) {
            try {
                await removeTransactionDirectory(workspaceRoot, transactionDirectory);
            } catch (cleanupError) {
                throw transactionError('Documentation generation failed before commit and cleanup was incomplete.', [
                    primary,
                    asError(cleanupError),
                ]);
            }
            throw primary;
        }
        const recovery = await recoverTransaction(workspaceRoot, outputDirectory);
        if (recovery.status === 'committed' && recovery.errors.length === 0) {
            warnings.push(
                `Documentation generation committed after an interrupted final operation: ${primary.message}`
            );
            return { written: normalized.size, removed: staleExisting.size, warnings };
        }
        if (recovery.errors.length > 0) {
            throw transactionError('Documentation generation failed and recovery was incomplete.', [
                primary,
                ...recovery.errors,
            ]);
        }
        throw primary;
    }
}
