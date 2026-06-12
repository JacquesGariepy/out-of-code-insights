// SPDX-License-Identifier: MPL-2.0
//
// Stripe webhook — pure signature verification + checkout parsing, and the
// end-to-end POST /v1/webhooks/stripe flow against a real server instance.

import * as assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { verifyKey } from '../src/keys';
import { startServer } from '../src/server';
import { FileStore } from '../src/store';
import { parseCheckoutEvent, verifyStripeSignature } from '../src/stripe';

const WEBHOOK_SECRET = 'whsec_test_secret';

function signedHeader(rawBody: string, secret: string, timestampSeconds: number): string {
    const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`, 'utf8').digest('hex');
    return `t=${timestampSeconds},v1=${mac}`;
}

function checkoutEvent(eventId: string, metadata?: Record<string, string>): Record<string, unknown> {
    return {
        id: eventId,
        type: 'checkout.session.completed',
        data: {
            object: {
                customer_details: { email: 'dev@example.com' },
                metadata,
            },
        },
    };
}

// ── Pure helpers ───────────────────────────────────────────────────────────

test('verifyStripeSignature accepts a valid signature within tolerance', () => {
    const body = '{"id":"evt_1"}';
    const now = 1_750_000_000_000;
    const header = signedHeader(body, WEBHOOK_SECRET, Math.floor(now / 1000));
    assert.equal(verifyStripeSignature(body, header, WEBHOOK_SECRET, 300, now), true);
});

test('verifyStripeSignature rejects a wrong secret, tampered body and stale timestamp', () => {
    const body = '{"id":"evt_1"}';
    const now = 1_750_000_000_000;
    const ts = Math.floor(now / 1000);
    const header = signedHeader(body, WEBHOOK_SECRET, ts);
    assert.equal(verifyStripeSignature(body, header, 'whsec_other', 300, now), false);
    assert.equal(verifyStripeSignature('{"id":"evt_2"}', header, WEBHOOK_SECRET, 300, now), false);
    const staleHeader = signedHeader(body, WEBHOOK_SECRET, ts - 1000);
    assert.equal(verifyStripeSignature(body, staleHeader, WEBHOOK_SECRET, 300, now), false);
    assert.equal(verifyStripeSignature(body, 'garbage', WEBHOOK_SECRET, 300, now), false);
    assert.equal(verifyStripeSignature(body, '', WEBHOOK_SECRET, 300, now), false);
});

test('verifyStripeSignature accepts any matching v1 during secret rotation', () => {
    const body = '{"id":"evt_1"}';
    const now = 1_750_000_000_000;
    const ts = Math.floor(now / 1000);
    const goodMac = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`, 'utf8').digest('hex');
    const header = `t=${ts},v1=${'0'.repeat(64)},v1=${goodMac}`;
    assert.equal(verifyStripeSignature(body, header, WEBHOOK_SECRET, 300, now), true);
});

test('parseCheckoutEvent extracts email, metadata entitlements and days', () => {
    const parsed = parseCheckoutEvent(checkoutEvent('evt_meta', { entitlements: 'sync, docs.watch', days: '30' }));
    assert.ok(parsed);
    assert.equal(parsed.eventId, 'evt_meta');
    assert.equal(parsed.email, 'dev@example.com');
    assert.deepEqual(parsed.entitlements, ['sync', 'docs.watch']);
    assert.equal(parsed.days, 30);
});

test('parseCheckoutEvent falls back to defaults and ignores foreign events', () => {
    const parsed = parseCheckoutEvent(checkoutEvent('evt_defaults'));
    assert.ok(parsed);
    assert.deepEqual(parsed.entitlements, ['sync', 'pro']);
    assert.equal(parsed.days, 365);
    assert.equal(parseCheckoutEvent({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } }), null);
    assert.equal(parseCheckoutEvent('garbage'), null);
});

// ── End-to-end webhook ─────────────────────────────────────────────────────

const LICENSE_SECRET = 'license-secret-for-webhook-tests';
let baseUrl = '';
let dataDir = '';
let close: (() => Promise<void>) | undefined;

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-webhook-'));
    const { server, port } = await startServer(
        { secret: LICENSE_SECRET, store: new FileStore(dataDir), stripeWebhookSecret: WEBHOOK_SECRET },
        0
    );
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
});

after(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function postWebhook(rawBody: string, header: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
        body: rawBody,
    });
}

test('a signed checkout.session.completed issues a validatable key, idempotently', async () => {
    const rawBody = JSON.stringify(checkoutEvent('evt_e2e', { entitlements: 'sync,pro', days: '10' }));
    const header = signedHeader(rawBody, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const first = await postWebhook(rawBody, header);
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { received: boolean; keyId?: string };
    assert.equal(firstBody.received, true);
    assert.ok(firstBody.keyId, 'a key id is reported');

    const issued = new FileStore(dataDir).listIssuedKeys();
    assert.equal(issued.length, 1);
    assert.equal(issued[0].eventId, 'evt_e2e');
    assert.equal(issued[0].email, 'dev@example.com');
    const payload = verifyKey(issued[0].key, LICENSE_SECRET);
    assert.ok(payload, 'issued key verifies against the license secret');
    assert.deepEqual(payload.entitlements, ['sync', 'pro']);

    // The issued key passes the same /v1/validate the extension calls.
    const validate = await fetch(`${baseUrl}/v1/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: issued[0].key, product: 'out-of-code-insights' }),
    });
    const validateBody = (await validate.json()) as { valid: boolean; entitlements: string[] };
    assert.equal(validateBody.valid, true);
    assert.deepEqual(validateBody.entitlements, ['sync', 'pro']);

    // Replay: same event id → acknowledged, no second key.
    const replay = await postWebhook(rawBody, header);
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as { duplicate?: boolean };
    assert.equal(replayBody.duplicate, true);
    assert.equal(new FileStore(dataDir).listIssuedKeys().length, 1);
});

test('a bad signature is rejected and foreign events are acknowledged without issuing', async () => {
    const rawBody = JSON.stringify(checkoutEvent('evt_bad'));
    const bad = await postWebhook(rawBody, `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`);
    assert.equal(bad.status, 400);

    const foreign = JSON.stringify({ id: 'evt_foreign', type: 'invoice.paid', data: { object: {} } });
    const ok = await postWebhook(foreign, signedHeader(foreign, WEBHOOK_SECRET, Math.floor(Date.now() / 1000)));
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { ignored?: boolean };
    assert.equal(okBody.ignored, true);
    assert.equal(new FileStore(dataDir).listIssuedKeys().length, 1, 'still only the e2e key');
});

test('the webhook route does not exist when no webhook secret is configured', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-nowebhook-'));
    const { server, port } = await startServer({ secret: LICENSE_SECRET, store: new FileStore(plainDir) }, 0);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/webhooks/stripe`, { method: 'POST', body: '{}' });
        assert.equal(res.status, 404);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(plainDir, { recursive: true, force: true });
    }
});
