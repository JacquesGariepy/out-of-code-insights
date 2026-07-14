// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AnnotationPersistence,
    AnnotationPersistenceError,
    DEFAULT_ANNOTATION_FILE_RELATIVE_PATH,
    type AnnotationPersistenceIo,
    type PersistenceWorkspaceFolder,
} from '../AnnotationPersistence';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2, type AnnotationV2 } from '../types';

const temporaryRoots = new Set<string>();

async function makeWorkspaceAsync(): Promise<PersistenceWorkspaceFolder> {
    const fsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oocodebenh-'));
    temporaryRoots.add(fsPath);
    return { uri: { fsPath } };
}

async function makeExternalDirectory(): Promise<string> {
    const fsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oocodebenh-external-'));
    temporaryRoots.add(fsPath);
    return fsPath;
}

async function removeLink(linkPath: string): Promise<void> {
    try {
        await fs.unlink(linkPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function createHostileFileLink(target: string, linkPath: string): Promise<void> {
    try {
        await fs.symlink(target, linkPath, 'file');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) {
            throw error;
        }
        // A directory junction is available without Developer Mode. Naming it
        // annotations.json still exercises final-target reparse-point refusal.
        await createDirectoryLink(path.dirname(target), linkPath);
    }
}

async function assertNoAtomicTemporaryFiles(target: string): Promise<void> {
    let entries: string[] = [];
    try {
        entries = await fs.readdir(path.dirname(target));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    const prefix = `.${path.basename(target)}.`;
    assert.deepStrictEqual(
        entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp')),
        [],
        'atomic save must not leave a temporary file behind'
    );
}

teardown(async () => {
    const roots = [...temporaryRoots];
    temporaryRoots.clear();
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

function sampleAnnotation(id: string, message = 'hello'): AnnotationV2 {
    return {
        id,
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        fileUri: 'file:///x.ts',
        file: 'x.ts',
        startOffset: 0,
        endOffset: 5,
        lineHash: '5b8a91e0',
        contextBefore: [],
        contextAfter: [],
        state: 'active',
        origin: { kind: 'manual' },
        message,
        timestamp: '2026-05-06T12:00:00.000Z',
    };
}

function fileSystemError(code: string, message: string): NodeJS.ErrnoException {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

suite('AnnotationPersistence — path resolution', () => {
    test('default relative path is .out-of-code-insights/annotations.json', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        assert.strictEqual(persistence.getPath(), path.join(ws.uri.fsPath, DEFAULT_ANNOTATION_FILE_RELATIVE_PATH));
    });

    test('rejects an absolute relative path', async () => {
        const ws = await makeWorkspaceAsync();
        assert.throws(() => new AnnotationPersistence(ws, '/etc/passwd'), /must not be absolute/);
    });

    test("rejects a relative path with '..' segments", async () => {
        const ws = await makeWorkspaceAsync();
        assert.throws(() => new AnnotationPersistence(ws, '../../etc/passwd'), /must not contain '\.\.'/);
        assert.throws(() => new AnnotationPersistence(ws, 'safe/../../etc/passwd'), /must not contain '\.\.'/);
    });
});

suite('AnnotationPersistence — physical workspace confinement', () => {
    test('refuses a hostile annotations.json link for both load and save', async () => {
        const ws = await makeWorkspaceAsync();
        const external = await makeExternalDirectory();
        const persistence = new AnnotationPersistence(ws);
        const target = persistence.getPath();
        const externalTarget = path.join(external, 'outside.json');
        const sentinel = JSON.stringify({ outside: 'must remain unchanged' });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(externalTarget, sentinel, 'utf8');
        await createHostileFileLink(externalTarget, target);

        try {
            await assert.rejects(persistence.load(), /symbolic link|junction|reparse point/i);
            await assert.rejects(
                persistence.save({ schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: [] }),
                /symbolic link|junction|reparse point/i
            );
            assert.strictEqual(await fs.readFile(externalTarget, 'utf8'), sentinel);
            await assertNoAtomicTemporaryFiles(target);
        } finally {
            await removeLink(target);
        }
    });

    test('refuses an annotation parent directory junction that leaves the workspace', async () => {
        const ws = await makeWorkspaceAsync();
        const external = await makeExternalDirectory();
        const persistence = new AnnotationPersistence(ws);
        const target = persistence.getPath();
        const linkedParent = path.dirname(target);
        const externalTarget = path.join(external, path.basename(target));
        const sentinel = JSON.stringify({ outside: 'parent link sentinel' });
        await fs.writeFile(externalTarget, sentinel, 'utf8');
        await createDirectoryLink(external, linkedParent);

        try {
            await assert.rejects(persistence.load(), /symbolic link|junction|reparse point/i);
            await assert.rejects(
                persistence.save({ schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: [] }),
                /symbolic link|junction|reparse point/i
            );
            assert.strictEqual(await fs.readFile(externalTarget, 'utf8'), sentinel);
            assert.deepStrictEqual(
                (await fs.readdir(external)).filter((entry) => entry.endsWith('.tmp')),
                [],
                'an unsafe parent must not receive an external temporary file'
            );
        } finally {
            await removeLink(linkedParent);
        }
    });
});

suite('AnnotationPersistence — load', () => {
    test('returns an empty envelope when the file does not exist', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const loaded = await persistence.load();
        assert.strictEqual(loaded.schemaVersion, ANNOTATION_SCHEMA_VERSION);
        assert.deepStrictEqual(loaded.annotations, []);
    });

    test('reads a valid v2 envelope from disk', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const target = persistence.getPath();
        await fs.mkdir(path.dirname(target), { recursive: true });
        const original: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('a1'), sampleAnnotation('a2', 'second')],
        };
        await fs.writeFile(target, JSON.stringify(original), 'utf8');
        const loaded = await persistence.load();
        assert.strictEqual(loaded.annotations.length, 2);
        assert.strictEqual(loaded.annotations[0].id, 'a1');
        assert.strictEqual(loaded.annotations[1].message, 'second');
    });

    test('throws on schemaVersion mismatch', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const target = persistence.getPath();
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify({ schemaVersion: 1, annotations: [] }), 'utf8');
        await assert.rejects(persistence.load(), /unsupported schemaVersion/);
    });

    test('throws on malformed envelope (missing annotations array)', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const target = persistence.getPath();
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify({ schemaVersion: ANNOTATION_SCHEMA_VERSION }), 'utf8');
        await assert.rejects(persistence.load(), /malformed envelope/);
    });
});

suite('AnnotationPersistence — save', () => {
    test('writes JSON pretty-printed (indent=2) and creates the parent dir', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const payload: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('save-1')],
        };
        await persistence.save(payload);
        const written = await fs.readFile(persistence.getPath(), 'utf8');
        assert.ok(written.includes('  "schemaVersion": 2'));
        const reparsed = JSON.parse(written) as AnnotationStoreFileV2;
        assert.strictEqual(reparsed.annotations[0].id, 'save-1');
        await assertNoAtomicTemporaryFiles(persistence.getPath());
    });

    test('round-trip: save then load preserves contents', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const original: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('rt-1'), sampleAnnotation('rt-2', 'second')],
        };
        await persistence.save(original);
        const reloaded = await persistence.load();
        assert.deepStrictEqual(reloaded, original);
    });

    test('a partial temporary write failure preserves the last good file and removes the temporary', async () => {
        const ws = await makeWorkspaceAsync();
        const original: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('last-good', 'keep me')],
        };
        const replacement: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('partial', 'must not commit')],
        };
        const initialPersistence = new AnnotationPersistence(ws);
        await initialPersistence.save(original);

        const failingIo: Partial<AnnotationPersistenceIo> = {
            writeFile: async (handle, content) => {
                await handle.writeFile(content.slice(0, 17), { encoding: 'utf8' });
                throw new Error('simulated partial temporary write');
            },
        };
        const failingPersistence = new AnnotationPersistence(ws, DEFAULT_ANNOTATION_FILE_RELATIVE_PATH, failingIo);
        await assert.rejects(
            failingPersistence.save(replacement),
            (error: unknown) =>
                error instanceof AnnotationPersistenceError && /simulated partial temporary write/.test(error.message)
        );

        assert.deepStrictEqual(JSON.parse(await fs.readFile(initialPersistence.getPath(), 'utf8')), original);
        await assertNoAtomicTemporaryFiles(initialPersistence.getPath());
    });

    test('transient Windows rename errors are retried with destination revalidation', async () => {
        const ws = await makeWorkspaceAsync();
        const original: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('retry-last-good', 'replace after retry')],
        };
        const replacement: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('retry-success', 'committed atomically')],
        };
        const initialPersistence = new AnnotationPersistence(ws);
        await initialPersistence.save(original);

        const target = initialPersistence.getPath();
        let destinationValidations = 0;
        const validationsAtRename: number[] = [];
        const transientCodes = ['EPERM', 'EACCES', 'EBUSY'] as const;
        let renameAttempts = 0;
        const retryingPersistence = new AnnotationPersistence(ws, DEFAULT_ANNOTATION_FILE_RELATIVE_PATH, {
            lstat: async (candidate) => {
                if (path.resolve(candidate) === path.resolve(target)) {
                    destinationValidations++;
                }
                return fs.lstat(candidate);
            },
            rename: async (from, to) => {
                validationsAtRename.push(destinationValidations);
                const code = transientCodes[renameAttempts];
                renameAttempts++;
                if (code) {
                    throw fileSystemError(code, `simulated transient ${code}`);
                }
                await fs.rename(from, to);
            },
        });

        await retryingPersistence.save(replacement);

        assert.strictEqual(renameAttempts, 4, 'three transient failures must be followed by one successful rename');
        assert.deepStrictEqual(
            validationsAtRename,
            [...validationsAtRename].sort((left, right) => left - right),
            'destination validation counts must progress monotonically'
        );
        assert.strictEqual(
            new Set(validationsAtRename).size,
            renameAttempts,
            'the destination must be revalidated immediately before every rename attempt'
        );
        assert.deepStrictEqual(JSON.parse(await fs.readFile(target, 'utf8')), replacement);
        await assertNoAtomicTemporaryFiles(target);
    });

    test('an exhausted transient rename failure preserves the last good file and removes the temporary', async () => {
        const ws = await makeWorkspaceAsync();
        const original: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('busy-last-good', 'keep during permanent lock')],
        };
        const replacement: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('busy-failed', 'must not replace')],
        };
        const initialPersistence = new AnnotationPersistence(ws);
        await initialPersistence.save(original);

        let renameAttempts = 0;
        const failingPersistence = new AnnotationPersistence(ws, DEFAULT_ANNOTATION_FILE_RELATIVE_PATH, {
            rename: async () => {
                renameAttempts++;
                throw fileSystemError('EPERM', 'simulated permanent destination lock');
            },
        });
        await assert.rejects(
            failingPersistence.save(replacement),
            (error: unknown) =>
                error instanceof AnnotationPersistenceError && /permanent destination lock/.test(error.message)
        );

        assert.strictEqual(renameAttempts, 5, 'the initial attempt plus four bounded retries must run');
        assert.deepStrictEqual(JSON.parse(await fs.readFile(initialPersistence.getPath(), 'utf8')), original);
        await assertNoAtomicTemporaryFiles(initialPersistence.getPath());
    });

    test('a non-transient rename failure is not retried and preserves the last good file', async () => {
        const ws = await makeWorkspaceAsync();
        const original: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('rename-last-good', 'keep me too')],
        };
        const replacement: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [sampleAnnotation('rename-failed', 'must not replace')],
        };
        const initialPersistence = new AnnotationPersistence(ws);
        await initialPersistence.save(original);

        let renameAttempts = 0;
        const failingPersistence = new AnnotationPersistence(ws, DEFAULT_ANNOTATION_FILE_RELATIVE_PATH, {
            rename: async () => {
                renameAttempts++;
                throw fileSystemError('EIO', 'simulated non-transient atomic rename failure');
            },
        });
        await assert.rejects(
            failingPersistence.save(replacement),
            (error: unknown) =>
                error instanceof AnnotationPersistenceError && /non-transient atomic rename failure/.test(error.message)
        );

        assert.strictEqual(renameAttempts, 1, 'non-transient errors must fail immediately');
        assert.deepStrictEqual(JSON.parse(await fs.readFile(initialPersistence.getPath(), 'utf8')), original);
        await assertNoAtomicTemporaryFiles(initialPersistence.getPath());
    });

    test('refuses to save a payload with a non-2 schemaVersion', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        await assert.rejects(
            persistence.save({
                schemaVersion: 1 as unknown as typeof ANNOTATION_SCHEMA_VERSION,
                annotations: [],
            }),
            /payload schemaVersion must be 2/
        );
    });
});

suite('AnnotationPersistence — events', () => {
    test('onDidLoad fires after a successful load', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const events: AnnotationStoreFileV2[] = [];
        const sub = persistence.onDidLoad((e) => events.push(e));
        await persistence.load();
        sub.dispose();
        assert.strictEqual(events.length, 1);
    });

    test('onDidSave fires after a successful save', async () => {
        const ws = await makeWorkspaceAsync();
        const persistence = new AnnotationPersistence(ws);
        const events: AnnotationStoreFileV2[] = [];
        const sub = persistence.onDidSave((e) => events.push(e));
        await persistence.save({ schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: [] });
        sub.dispose();
        assert.strictEqual(events.length, 1);
    });
});
