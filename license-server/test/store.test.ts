// SPDX-License-Identifier: MPL-2.0
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { FileStore } from '../src/store';

function tempStore(): { store: FileStore; dataDir: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooci-store-'));
    return { store: new FileStore(dataDir), dataDir };
}

test('revocation list starts empty and persists across instances', () => {
    const { store, dataDir } = tempStore();
    assert.deepEqual(store.listRevoked(), []);
    assert.equal(store.isRevoked('key-1'), false);

    store.revoke('key-1');
    store.revoke('key-2');
    store.revoke('key-1'); // idempotent

    assert.deepEqual(store.listRevoked(), ['key-1', 'key-2']);
    assert.equal(store.isRevoked('key-1'), true);
    assert.equal(store.isRevoked('key-3'), false);

    const reopened = new FileStore(dataDir);
    assert.deepEqual(reopened.listRevoked(), ['key-1', 'key-2']);
});

test('revoke rejects an empty key id', () => {
    const { store } = tempStore();
    assert.throws(() => store.revoke(''));
});

test('getWorkspace returns null when never pushed', () => {
    const { store } = tempStore();
    assert.equal(store.getWorkspace('ws-1'), null);
});

test('putWorkspace enforces optimistic concurrency', () => {
    const { store } = tempStore();
    const envelope = { schemaVersion: 2, annotations: [] };

    // First push must use expected version 0.
    assert.deepEqual(store.putWorkspace('ws-1', 1, envelope), { ok: false, version: 0 });
    assert.deepEqual(store.putWorkspace('ws-1', 0, envelope), { ok: true, version: 1 });

    // Stale write reports the current version and does not overwrite.
    const stale = { schemaVersion: 2, annotations: [{ id: 'stale' }] };
    assert.deepEqual(store.putWorkspace('ws-1', 0, stale), { ok: false, version: 1 });
    assert.deepEqual(store.getWorkspace('ws-1'), { version: 1, envelope });

    // Sequential writes bump the version.
    const next = { schemaVersion: 2, annotations: [{ id: 'a' }] };
    assert.deepEqual(store.putWorkspace('ws-1', 1, next), { ok: true, version: 2 });
    assert.deepEqual(store.getWorkspace('ws-1'), { version: 2, envelope: next });
});

test('workspace records persist across instances', () => {
    const { store, dataDir } = tempStore();
    const envelope = { schemaVersion: 2, annotations: [{ id: 'x' }] };
    store.putWorkspace('ws-1', 0, envelope);

    const reopened = new FileStore(dataDir);
    assert.deepEqual(reopened.getWorkspace('ws-1'), { version: 1, envelope });
});

test('hostile workspace ids stay inside the data directory', () => {
    const { store, dataDir } = tempStore();
    const hostile = ['../../etc/passwd', '..\\..\\windows', 'a/b/c', 'C:\\temp\\x', '. .', 'é🚀'];
    for (const id of hostile) {
        assert.deepEqual(store.putWorkspace(id, 0, { ok: true }), { ok: true, version: 1 });
    }
    const workspacesDir = path.join(dataDir, 'workspaces');
    const files = fs.readdirSync(workspacesDir);
    assert.equal(files.length, hostile.length, 'every id maps to a distinct file');
    for (const file of files) {
        const resolved = path.resolve(workspacesDir, file);
        assert.ok(resolved.startsWith(path.resolve(workspacesDir) + path.sep), `escaped data dir: ${file}`);
    }
    // Records remain individually addressable.
    for (const id of hostile) {
        assert.deepEqual(store.getWorkspace(id), { version: 1, envelope: { ok: true } });
    }
});

test('distinct ids with the same sanitized slug do not collide', () => {
    const { store } = tempStore();
    store.putWorkspace('a/b', 0, { which: 'slash' });
    store.putWorkspace('a?b', 0, { which: 'question' });
    assert.deepEqual(store.getWorkspace('a/b'), { version: 1, envelope: { which: 'slash' } });
    assert.deepEqual(store.getWorkspace('a?b'), { version: 1, envelope: { which: 'question' } });
});

test('atomic writes leave no temp files behind', () => {
    const { store, dataDir } = tempStore();
    store.revoke('key-1');
    store.putWorkspace('ws-1', 0, { schemaVersion: 2, annotations: [] });
    const leftovers: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.tmp')) {
                leftovers.push(full);
            }
        }
    };
    walk(dataDir);
    assert.deepEqual(leftovers, []);
});

test('empty workspace id is rejected', () => {
    const { store } = tempStore();
    assert.throws(() => store.getWorkspace(''));
    assert.throws(() => store.putWorkspace('', 0, {}));
});
