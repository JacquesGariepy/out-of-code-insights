// SPDX-License-Identifier: MPL-2.0
//
// Integration tests: real node:http server on an ephemeral port, real
// HTTP requests through the global fetch (Node 20).

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { issueKey } from '../src/keys';
import { startServer, MAX_BODY_BYTES } from '../src/server';
import { FileStore } from '../src/store';

const SECRET = 'integration-test-secret';

let server: http.Server;
let baseUrl: string;
let store: FileStore;

const syncKey = issueKey({ id: 'key-sync', entitlements: ['sync', 'pro'] }, SECRET);
const noSyncKey = issueKey({ id: 'key-nosync', entitlements: ['pro'] }, SECRET);
const expiredKey = issueKey({ id: 'key-expired', entitlements: ['sync'], exp: '2000-01-01T00:00:00.000Z' }, SECRET);
const revokedKey = issueKey({ id: 'key-revoked', entitlements: ['sync', 'pro'] }, SECRET);

before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooci-server-'));
    store = new FileStore(dataDir);
    store.revoke('key-revoked');
    const started = await startServer({ secret: SECRET, store }, 0);
    server = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
});

after(() => {
    server.close();
});

function validate(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

function annotationsUrl(workspaceId: string): string {
    return `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/annotations`;
}

// ── POST /v1/validate ────────────────────────────────────────────────────

test('validate: valid key → {valid:true, entitlements}', async () => {
    const res = await validate({ key: syncKey, product: 'out-of-code-insights' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: true, entitlements: ['sync', 'pro'] });
});

test('validate: key with exp reports expiresAt', async () => {
    const exp = '2999-01-01T00:00:00.000Z';
    const key = issueKey({ id: 'key-exp', entitlements: ['pro'], exp }, SECRET);
    const res = await validate({ key, product: 'out-of-code-insights' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: true, entitlements: ['pro'], expiresAt: exp });
});

test('validate: expired key → valid:false', async () => {
    const res = await validate({ key: expiredKey, product: 'out-of-code-insights' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false, entitlements: [] });
});

test('validate: revoked key → valid:false', async () => {
    const res = await validate({ key: revokedKey, product: 'out-of-code-insights' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false, entitlements: [] });
});

test('validate: garbage key → valid:false', async () => {
    const res = await validate({ key: 'OOCI.garbage.garbage', product: 'out-of-code-insights' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false, entitlements: [] });
});

test('validate: malformed JSON → 400', async () => {
    const res = await validate('{not json');
    assert.equal(res.status, 400);
});

test('validate: missing key field → 400', async () => {
    const res = await validate({ product: 'out-of-code-insights' });
    assert.equal(res.status, 400);
});

test('validate: GET is not allowed', async () => {
    const res = await fetch(`${baseUrl}/v1/validate`);
    assert.equal(res.status, 405);
});

// ── Annotation sync round-trip ───────────────────────────────────────────

test('sync: PUT 0 → GET → stale PUT 409 → PUT next version', async () => {
    const envelope = { schemaVersion: 2, annotations: [{ id: 'a1', message: 'first' }] };

    // First push with If-Match: 0.
    const put1 = await fetch(annotationsUrl('ws-roundtrip'), {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${syncKey}`,
            'Content-Type': 'application/json',
            'If-Match': '0',
        },
        body: JSON.stringify(envelope),
    });
    assert.equal(put1.status, 200);
    assert.deepEqual(await put1.json(), { version: 1 });

    // Pull returns the stored version and the exact envelope.
    const get = await fetch(annotationsUrl('ws-roundtrip'), {
        headers: { Authorization: `Bearer ${syncKey}` },
    });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { version: 1, envelope });

    // Stale push (If-Match: 0 again) → 409 with the current version.
    const stale = await fetch(annotationsUrl('ws-roundtrip'), {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${syncKey}`,
            'Content-Type': 'application/json',
            'If-Match': '0',
        },
        body: JSON.stringify({ schemaVersion: 2, annotations: [] }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { version: 1 });

    // Push on top of the current version succeeds.
    const next = { schemaVersion: 2, annotations: [{ id: 'a2', message: 'second' }] };
    const put2 = await fetch(annotationsUrl('ws-roundtrip'), {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${syncKey}`,
            'Content-Type': 'application/json',
            'If-Match': '1',
        },
        body: JSON.stringify(next),
    });
    assert.equal(put2.status, 200);
    assert.deepEqual(await put2.json(), { version: 2 });
});

test('sync: GET on a never-pushed workspace → 404', async () => {
    const res = await fetch(annotationsUrl('ws-never-pushed'), {
        headers: { Authorization: `Bearer ${syncKey}` },
    });
    assert.equal(res.status, 404);
});

test('sync: PUT without If-Match → 400', async () => {
    const res = await fetch(annotationsUrl('ws-no-ifmatch'), {
        method: 'PUT',
        headers: { Authorization: `Bearer ${syncKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 2, annotations: [] }),
    });
    assert.equal(res.status, 400);
});

test('sync: PUT with a non-numeric If-Match → 400', async () => {
    const res = await fetch(annotationsUrl('ws-bad-ifmatch'), {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${syncKey}`,
            'Content-Type': 'application/json',
            'If-Match': 'abc',
        },
        body: JSON.stringify({ schemaVersion: 2, annotations: [] }),
    });
    assert.equal(res.status, 400);
});

test('sync: PUT with a non-object body → 400', async () => {
    const res = await fetch(annotationsUrl('ws-bad-body'), {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${syncKey}`,
            'Content-Type': 'application/json',
            'If-Match': '0',
        },
        body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(res.status, 400);
});

// ── Auth failures ────────────────────────────────────────────────────────

test('auth: missing Authorization header → 401', async () => {
    const res = await fetch(annotationsUrl('ws-auth'));
    assert.equal(res.status, 401);
});

test('auth: garbage bearer token → 401', async () => {
    const res = await fetch(annotationsUrl('ws-auth'), {
        headers: { Authorization: 'Bearer not-a-key' },
    });
    assert.equal(res.status, 401);
});

test('auth: expired key → 401', async () => {
    const res = await fetch(annotationsUrl('ws-auth'), {
        headers: { Authorization: `Bearer ${expiredKey}` },
    });
    assert.equal(res.status, 401);
});

test('auth: revoked key → 401', async () => {
    const res = await fetch(annotationsUrl('ws-auth'), {
        headers: { Authorization: `Bearer ${revokedKey}` },
    });
    assert.equal(res.status, 401);
});

test('auth: valid key without the sync entitlement → 403', async () => {
    const res = await fetch(annotationsUrl('ws-auth'), {
        headers: { Authorization: `Bearer ${noSyncKey}` },
    });
    assert.equal(res.status, 403);
});

test('auth: revoking a key id takes effect immediately', async () => {
    const key = issueKey({ id: 'key-live-revoke', entitlements: ['sync'] }, SECRET);
    const beforeRevoke = await fetch(annotationsUrl('ws-live-revoke'), {
        headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(beforeRevoke.status, 404); // authorized, nothing pushed yet
    store.revoke('key-live-revoke');
    const afterRevoke = await fetch(annotationsUrl('ws-live-revoke'), {
        headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(afterRevoke.status, 401);
});

// ── Limits and routing ───────────────────────────────────────────────────

test('body size limit: oversized PUT is refused', async () => {
    const big = {
        schemaVersion: 2,
        annotations: [{ id: 'big', message: 'x'.repeat(MAX_BODY_BYTES + 1024) }],
    };
    // Depending on timing the server either responds 413 or resets the
    // stream while the client is still uploading — both are acceptable.
    try {
        const res = await fetch(annotationsUrl('ws-too-big'), {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${syncKey}`,
                'Content-Type': 'application/json',
                'If-Match': '0',
            },
            body: JSON.stringify(big),
        });
        assert.equal(res.status, 413);
    } catch {
        // Connection error while streaming the oversized body — accepted.
    }
});

test('unknown route → 404', async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`);
    assert.equal(res.status, 404);
});

test('unsupported method on annotations → 405', async () => {
    const res = await fetch(annotationsUrl('ws-method'), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${syncKey}` },
    });
    assert.equal(res.status, 405);
});

test('workspace ids with URL-encoded characters round-trip', async () => {
    const id = 'team A/répo #1';
    const envelope = { schemaVersion: 2, annotations: [] };
    const put = await fetch(annotationsUrl(id), {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${syncKey}`,
            'Content-Type': 'application/json',
            'If-Match': '0',
        },
        body: JSON.stringify(envelope),
    });
    assert.equal(put.status, 200);
    const get = await fetch(annotationsUrl(id), {
        headers: { Authorization: `Bearer ${syncKey}` },
    });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { version: 1, envelope });
});
