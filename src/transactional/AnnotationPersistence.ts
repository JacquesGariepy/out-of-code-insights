// SPDX-License-Identifier: MPL-2.0
//
// AnnotationPersistence - load/save the v2 envelope to disk.
//
// Persistence is deliberately implemented without a vscode dependency so it
// can be security-tested with the native file system. Configured paths are
// workspace-relative, physically confined, and committed through a same-
// directory temporary file so a failed save never truncates the last good
// annotations file.

import { randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import type { Stats } from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { TypedEventEmitter } from './internal/event-emitter';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2 } from './types';

/** Default location relative to the workspace root. */
export const DEFAULT_ANNOTATION_FILE_RELATIVE_PATH = '.out-of-code-insights/annotations.json';

/**
 * Structural shape used by AnnotationPersistence - matches
 * `vscode.WorkspaceFolder` but free of a runtime dependency on `vscode`.
 */
export interface PersistenceWorkspaceFolder {
    readonly uri: { readonly fsPath: string };
}

/**
 * Narrow I/O seam used by failure-path tests. Production callers should rely
 * on the native defaults and omit the third constructor argument.
 */
export interface AnnotationPersistenceIo {
    lstat(filePath: string): Promise<Stats>;
    realpath(filePath: string): Promise<string>;
    mkdir(filePath: string, options?: { recursive?: boolean }): Promise<string | undefined>;
    open(filePath: string, flags: string | number, mode?: number): Promise<FileHandle>;
    readFile(handle: FileHandle): Promise<string>;
    writeFile(handle: FileHandle, content: string): Promise<void>;
    sync(handle: FileHandle): Promise<void>;
    close(handle: FileHandle): Promise<void>;
    stat(handle: FileHandle): ReturnType<FileHandle['stat']>;
    rename(from: string, to: string): ReturnType<typeof fs.rename>;
    unlink(filePath: string): ReturnType<typeof fs.unlink>;
}

const NODE_IO: AnnotationPersistenceIo = {
    lstat: (filePath) => fs.lstat(filePath),
    realpath: (filePath) => fs.realpath(filePath),
    mkdir: (filePath, options) => fs.mkdir(filePath, options),
    open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
    readFile: (handle) => handle.readFile({ encoding: 'utf8' }),
    writeFile: async (handle, content) => {
        await handle.writeFile(content, { encoding: 'utf8' });
    },
    sync: (handle) => handle.sync(),
    close: (handle) => handle.close(),
    stat: (handle) => handle.stat(),
    rename: (from, to) => fs.rename(from, to),
    unlink: (filePath) => fs.unlink(filePath),
};

/** An atomic save failure plus any independent cleanup failure. */
export class AnnotationPersistenceError extends Error {
    readonly errors: readonly Error[];

    constructor(message: string, errors: readonly Error[]) {
        super(`${message}: ${errors.map((error) => error.message).join('; ')}`);
        this.name = 'AnnotationPersistenceError';
        this.errors = [...errors];
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}

function isAlreadyPresent(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
    );
}

const ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;
const TRANSIENT_ATOMIC_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function isTransientAtomicRenameError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' && TRANSIENT_ATOMIC_RENAME_CODES.has(code);
}

async function waitBeforeAtomicRenameRetry(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isInsideNativePath(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
}

function readOnlyNoFollowFlags(): number {
    // O_NOFOLLOW is not exposed by Node on Windows. The lstat-before/open and
    // lstat-after/open checks below still prevent a stable hostile link from
    // being read; platforms that expose O_NOFOLLOW also get kernel enforcement.
    const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    return constants.O_RDONLY | noFollow;
}

function emptyEnvelope(): AnnotationStoreFileV2 {
    return {
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        annotations: [],
    };
}

export class AnnotationPersistence {
    private readonly workspaceRoot: string;
    private readonly absolutePath: string;
    private readonly io: AnnotationPersistenceIo;
    private readonly _onDidLoad = new TypedEventEmitter<AnnotationStoreFileV2>();
    private readonly _onDidSave = new TypedEventEmitter<AnnotationStoreFileV2>();

    readonly onDidLoad = this._onDidLoad.event;
    readonly onDidSave = this._onDidSave.event;

    constructor(
        workspaceFolder: PersistenceWorkspaceFolder,
        relativePath: string = DEFAULT_ANNOTATION_FILE_RELATIVE_PATH,
        ioOverrides: Partial<AnnotationPersistenceIo> = {}
    ) {
        if (!workspaceFolder.uri.fsPath) {
            throw new Error('AnnotationPersistence: workspace path must not be empty');
        }
        if (!relativePath) {
            throw new Error('AnnotationPersistence: relative path must not be empty');
        }
        if (path.isAbsolute(relativePath)) {
            throw new Error(`AnnotationPersistence: relative path must not be absolute (got ${relativePath})`);
        }
        const segments = relativePath.split(/[\\/]/);
        if (segments.includes('..')) {
            throw new Error(
                `AnnotationPersistence: relative path must not contain '..' segments (got ${relativePath})`
            );
        }

        this.workspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
        this.absolutePath = path.resolve(this.workspaceRoot, relativePath);
        if (!isInsideNativePath(this.workspaceRoot, this.absolutePath) || this.absolutePath === this.workspaceRoot) {
            throw new Error(`AnnotationPersistence: relative path escapes the workspace (got ${relativePath})`);
        }
        this.io = { ...NODE_IO, ...ioOverrides };
    }

    /** Absolute on-disk path for the annotations file. Stable for the lifetime of the instance. */
    getPath(): string {
        return this.absolutePath;
    }

    /** Resolve and validate the trusted workspace root itself. */
    private async resolvePhysicalWorkspaceRoot(allowMissing: boolean): Promise<string | undefined> {
        let physicalRoot: string;
        try {
            physicalRoot = await this.io.realpath(this.workspaceRoot);
        } catch (error) {
            if (allowMissing && isMissing(error)) {
                return undefined;
            }
            throw new Error(`Cannot resolve the annotation workspace root: ${asError(error).message}`);
        }

        const rootStat = await this.io.lstat(physicalRoot);
        if (!rootStat.isDirectory()) {
            throw new Error(`Annotation workspace root is not a directory: ${this.workspaceRoot}`);
        }
        return physicalRoot;
    }

    /**
     * Validate every existing descendant without following a symbolic link or
     * junction. Resolving each real component also catches aliases/reparse
     * points that a platform does not expose as an ordinary symbolic link.
     */
    private async inspectFileCandidate(candidate: string, physicalRoot: string): Promise<boolean> {
        const lexicalCandidate = path.resolve(candidate);
        if (!isInsideNativePath(this.workspaceRoot, lexicalCandidate) || lexicalCandidate === this.workspaceRoot) {
            throw new Error(`Annotation path escapes the selected workspace: ${candidate}`);
        }

        const relative = path.relative(this.workspaceRoot, lexicalCandidate);
        const segments = relative.split(path.sep).filter(Boolean);
        let current = this.workspaceRoot;

        for (let index = 0; index < segments.length; index++) {
            current = path.join(current, segments[index]);
            let currentStat: Awaited<ReturnType<AnnotationPersistenceIo['lstat']>>;
            try {
                currentStat = await this.io.lstat(current);
            } catch (error) {
                if (isMissing(error)) {
                    return false;
                }
                throw new Error(`Cannot inspect annotation path component "${current}": ${asError(error).message}`);
            }

            if (currentStat.isSymbolicLink()) {
                throw new Error(`Annotation path crosses a symbolic link, junction, or reparse point: ${current}`);
            }

            const isDestination = index === segments.length - 1;
            if (!isDestination && !currentStat.isDirectory()) {
                throw new Error(`Annotation path crosses a non-directory component: ${current}`);
            }
            if (isDestination && !currentStat.isFile()) {
                throw new Error(`Annotation file target is not a regular file: ${current}`);
            }

            const physicalComponent = await this.io.realpath(current);
            if (!isInsideNativePath(physicalRoot, physicalComponent)) {
                throw new Error(`Annotation path resolves outside the selected workspace: ${candidate}`);
            }
        }
        return true;
    }

    /** Create missing parent directories one at a time, checking each before continuing. */
    private async ensureSafeParentDirectory(): Promise<string> {
        try {
            await this.io.mkdir(this.workspaceRoot, { recursive: true });
        } catch (error) {
            throw new Error(`Cannot create the annotation workspace root: ${asError(error).message}`);
        }
        const physicalRoot = await this.resolvePhysicalWorkspaceRoot(false);
        if (!physicalRoot) {
            throw new Error('Cannot resolve the annotation workspace root after creating it.');
        }

        const parent = path.dirname(this.absolutePath);
        const relative = path.relative(this.workspaceRoot, parent);
        const segments = relative === '' ? [] : relative.split(path.sep).filter(Boolean);
        let current = this.workspaceRoot;
        for (const segment of segments) {
            current = path.join(current, segment);
            let currentStat: Awaited<ReturnType<AnnotationPersistenceIo['lstat']>>;
            try {
                currentStat = await this.io.lstat(current);
            } catch (error) {
                if (!isMissing(error)) {
                    throw new Error(`Cannot inspect annotation directory "${current}": ${asError(error).message}`);
                }
                try {
                    await this.io.mkdir(current);
                } catch (mkdirError) {
                    if (!isAlreadyPresent(mkdirError)) {
                        throw new Error(
                            `Cannot create annotation directory "${current}": ${asError(mkdirError).message}`
                        );
                    }
                }
                currentStat = await this.io.lstat(current);
            }

            if (currentStat.isSymbolicLink()) {
                throw new Error(`Annotation path crosses a symbolic link, junction, or reparse point: ${current}`);
            }
            if (!currentStat.isDirectory()) {
                throw new Error(`Annotation path crosses a non-directory component: ${current}`);
            }

            const physicalComponent = await this.io.realpath(current);
            if (!isInsideNativePath(physicalRoot, physicalComponent)) {
                throw new Error(`Annotation directory resolves outside the selected workspace: ${current}`);
            }
        }

        // Refuse a pre-existing hostile annotations.json before creating any
        // temporary file alongside it.
        await this.inspectFileCandidate(this.absolutePath, physicalRoot);
        return physicalRoot;
    }

    private fireEmptyLoad(): AnnotationStoreFileV2 {
        const empty = emptyEnvelope();
        this._onDidLoad.fire(empty);
        return empty;
    }

    /**
     * Commit a closed, synchronized temporary file through one atomic rename.
     *
     * Windows can briefly reject a replacement while an indexer, antivirus or
     * another reader still owns a handle. Retry only the three errors known to
     * represent that condition. Every attempt revalidates both directory
     * entries, and the temporary remains untouched until rename succeeds or
     * the bounded retry budget is exhausted.
     */
    private async commitTemporaryFile(temporaryPath: string, physicalRoot: string): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            if (!(await this.inspectFileCandidate(temporaryPath, physicalRoot))) {
                throw new Error('Atomic annotation temporary file disappeared before commit.');
            }

            // Revalidate the configured destination immediately before every
            // attempt. rename replaces the directory entry and never writes
            // through a pre-existing target.
            await this.inspectFileCandidate(this.absolutePath, physicalRoot);

            try {
                await this.io.rename(temporaryPath, this.absolutePath);
                return;
            } catch (error) {
                const retryDelay = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
                if (!isTransientAtomicRenameError(error) || retryDelay === undefined) {
                    throw error;
                }
                await waitBeforeAtomicRenameRetry(retryDelay);
            }
        }
    }

    /**
     * Read the annotations envelope from disk.
     * - Missing workspace/file -> return an empty v2 envelope.
     * - Links, junctions, path escapes, malformed JSON/schema -> throw.
     */
    async load(): Promise<AnnotationStoreFileV2> {
        const physicalRoot = await this.resolvePhysicalWorkspaceRoot(true);
        if (!physicalRoot || !(await this.inspectFileCandidate(this.absolutePath, physicalRoot))) {
            return this.fireEmptyLoad();
        }

        let handle: FileHandle | undefined;
        let content: string;
        try {
            try {
                handle = await this.io.open(this.absolutePath, readOnlyNoFollowFlags());
            } catch (error) {
                if (isMissing(error)) {
                    // Re-check the path so a concurrent replacement with a
                    // hostile parent cannot be misreported as an empty store.
                    if (!(await this.inspectFileCandidate(this.absolutePath, physicalRoot))) {
                        return this.fireEmptyLoad();
                    }
                }
                throw error;
            }

            // On platforms without O_NOFOLLOW, validate again after opening
            // and before reading. A stable hostile link is therefore never
            // followed for content.
            if (!(await this.inspectFileCandidate(this.absolutePath, physicalRoot))) {
                throw new Error('Annotation file disappeared while it was being opened.');
            }
            const openedStat = await this.io.stat(handle);
            if (!openedStat.isFile()) {
                throw new Error('Annotation file target is not a regular file.');
            }
            content = await this.io.readFile(handle);
        } catch (error) {
            throw new Error(
                `AnnotationPersistence.load: refused or failed to read annotations: ${asError(error).message}`
            );
        } finally {
            if (handle) {
                try {
                    await this.io.close(handle);
                } catch {
                    // A close failure cannot make a completed read unsafe.
                }
            }
        }

        const parsed = JSON.parse(content) as AnnotationStoreFileV2;
        if (parsed.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new Error(
                `AnnotationPersistence.load: unsupported schemaVersion ${String(parsed.schemaVersion)} ` +
                    `(expected ${ANNOTATION_SCHEMA_VERSION}, no migration path in v2)`
            );
        }
        if (!Array.isArray(parsed.annotations)) {
            throw new Error('AnnotationPersistence.load: malformed envelope - `annotations` must be an array');
        }
        this._onDidLoad.fire(parsed);
        return parsed;
    }

    /**
     * Persist the envelope through a synchronized, same-directory temporary
     * file and atomic rename. If any preparation or rename step fails, the
     * previous annotations file is left untouched and the temporary is removed.
     */
    async save(payload: AnnotationStoreFileV2): Promise<void> {
        if (payload.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new Error(
                `AnnotationPersistence.save: payload schemaVersion must be ${ANNOTATION_SCHEMA_VERSION} ` +
                    `(got ${String(payload.schemaVersion)})`
            );
        }

        // Serialize before touching the file system so invalid/cyclic runtime
        // payloads cannot leave transaction artifacts.
        const serialized = JSON.stringify(payload, null, 2);
        const physicalRoot = await this.ensureSafeParentDirectory();
        const directory = path.dirname(this.absolutePath);
        const temporaryPath = path.join(
            directory,
            `.${path.basename(this.absolutePath)}.${process.pid}.${randomUUID()}.tmp`
        );
        let handle: FileHandle | undefined;
        let temporaryExists = false;

        try {
            handle = await this.io.open(
                temporaryPath,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o600
            );
            temporaryExists = true;
            await this.io.writeFile(handle, serialized);
            await this.io.sync(handle);
            await this.io.close(handle);
            handle = undefined;

            await this.commitTemporaryFile(temporaryPath, physicalRoot);
            temporaryExists = false;

            if (!(await this.inspectFileCandidate(this.absolutePath, physicalRoot))) {
                throw new Error('Atomic annotation commit did not create the destination file.');
            }
        } catch (error) {
            const failures = [asError(error)];
            if (handle) {
                try {
                    await this.io.close(handle);
                } catch (closeError) {
                    failures.push(new Error(`cannot close temporary file: ${asError(closeError).message}`));
                }
            }
            if (temporaryExists) {
                try {
                    await this.io.unlink(temporaryPath);
                } catch (unlinkError) {
                    if (!isMissing(unlinkError)) {
                        failures.push(new Error(`cannot remove temporary file: ${asError(unlinkError).message}`));
                    }
                }
            }
            throw new AnnotationPersistenceError('AnnotationPersistence.save atomic commit failed', failures);
        }

        this._onDidSave.fire(payload);
    }

    dispose(): void {
        this._onDidLoad.dispose();
        this._onDidSave.dispose();
    }
}
