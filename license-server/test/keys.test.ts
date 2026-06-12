// SPDX-License-Identifier: MPL-2.0
import * as assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { issueKey, verifyKey, KEY_PREFIX, type LicensePayload } from '../src/keys';

const SECRET = 'test-secret-0123456789';

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
    return { id: 'key-1', entitlements: ['sync', 'pro'], ...overrides };
}

test('issueKey produces the documented three-segment format', () => {
    const key = issueKey(payload(), SECRET);
    const parts = key.split('.');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], KEY_PREFIX);
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    assert.deepEqual(decoded, payload());
});

test('verifyKey round-trips a valid key', () => {
    const key = issueKey(payload(), SECRET);
    const verified = verifyKey(key, SECRET);
    assert.deepEqual(verified, payload());
});

test('verifyKey preserves exp in the returned payload', () => {
    const exp = '2999-01-01T00:00:00.000Z';
    const key = issueKey(payload({ exp }), SECRET);
    const verified = verifyKey(key, SECRET);
    assert.ok(verified);
    assert.equal(verified.exp, exp);
});

test('verifyKey rejects a key signed with another secret', () => {
    const key = issueKey(payload(), 'other-secret');
    assert.equal(verifyKey(key, SECRET), null);
});

test('verifyKey rejects a tampered payload segment', () => {
    const key = issueKey(payload(), SECRET);
    const parts = key.split('.');
    const forged: LicensePayload = payload({ entitlements: ['sync', 'pro', 'admin'] });
    parts[1] = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
    assert.equal(verifyKey(parts.join('.'), SECRET), null);
});

test('verifyKey rejects garbage input', () => {
    for (const garbage of [
        '',
        'OOCI',
        'OOCI.',
        'OOCI..',
        'OOCI.abc',
        'OOCI.abc.def',
        'not-a-key',
        'WRONG.abc.def',
        'OOCI.abc.def.ghi',
    ]) {
        assert.equal(verifyKey(garbage, SECRET), null, `expected null for ${JSON.stringify(garbage)}`);
    }
});

test('verifyKey rejects an empty secret', () => {
    const key = issueKey(payload(), SECRET);
    assert.equal(verifyKey(key, ''), null);
});

test('verifyKey enforces expiry against the injected clock', () => {
    const key = issueKey(payload({ exp: '2026-01-01T00:00:00.000Z' }), SECRET);
    assert.deepEqual(
        verifyKey(key, SECRET, new Date('2025-12-31T23:59:59.000Z')),
        payload({ exp: '2026-01-01T00:00:00.000Z' })
    );
    assert.equal(verifyKey(key, SECRET, new Date('2026-01-01T00:00:00.000Z')), null);
    assert.equal(verifyKey(key, SECRET, new Date('2026-06-01T00:00:00.000Z')), null);
});

test('verifyKey rejects a signed payload with an unparsable exp', () => {
    const key = issueKey(payload({ exp: 'not-a-date' }), SECRET);
    assert.equal(verifyKey(key, SECRET), null);
});

test('verifyKey rejects correctly signed but structurally invalid payloads', () => {
    // Forge keys with the documented algorithm (HMAC-SHA256 over the
    // base64url payload segment) so only the shape validation can fail.
    const forge = (json: string): string => {
        const segment = Buffer.from(json, 'utf8').toString('base64url');
        const signature = createHmac('sha256', SECRET).update(segment, 'utf8').digest('base64url');
        return `${KEY_PREFIX}.${segment}.${signature}`;
    };
    for (const json of [
        'null',
        '[]',
        '"key"',
        '{}',
        '{"id":""}',
        '{"id":"k"}',
        '{"id":"k","entitlements":"sync"}',
        '{"id":"k","entitlements":["sync",42]}',
        '{"id":"k","entitlements":[],"exp":123}',
        'not json at all',
    ]) {
        assert.equal(verifyKey(forge(json), SECRET), null, `expected null for payload ${json}`);
    }
    // Sanity: the forge helper itself produces verifiable keys for valid payloads.
    assert.deepEqual(verifyKey(forge(JSON.stringify(payload())), SECRET), payload());
});

test('issueKey validates its inputs', () => {
    assert.throws(() => issueKey(payload(), ''));
    assert.throws(() => issueKey({ id: '', entitlements: [] }, SECRET));
    assert.throws(() => issueKey({ id: 'k', entitlements: 'sync' as unknown as string[] }, SECRET));
});
