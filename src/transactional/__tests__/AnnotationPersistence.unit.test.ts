// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AnnotationPersistence,
    DEFAULT_ANNOTATION_FILE_RELATIVE_PATH,
    type PersistenceWorkspaceFolder,
} from '../AnnotationPersistence';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2, type AnnotationV2 } from '../types';

function makeWorkspace(): PersistenceWorkspaceFolder & { fsPath: string } {
    const fsPath = fs.mkdtemp(path.join(os.tmpdir(), 'oocodebenh-')) as unknown as string;
    // mkdtemp returns a Promise; resolve it synchronously is impossible — use
    // a sync alternative for tests.
    return { uri: { fsPath: '' }, fsPath: fsPath as string };
}

async function makeWorkspaceAsync(): Promise<PersistenceWorkspaceFolder> {
    const fsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oocodebenh-'));
    return { uri: { fsPath } };
}

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

// Silence unused-import warning on the synchronous mkdtemp helper that we
// kept for shape symmetry with the async variant.
void makeWorkspace;
