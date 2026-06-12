// SPDX-License-Identifier: MPL-2.0
//
// HTTP API — node:http only, zero runtime dependencies.
//
// Endpoints (all JSON):
//     POST /v1/validate
//         Body {key, product} → 200 {valid, entitlements, expiresAt?}.
//         Mirrors the extension contract (src/pro/LicenseManager.ts):
//         `valid` is false when the signature or expiry fails or the key id
//         is revoked — bad keys are a 200 with valid=false, never a 4xx.
//     GET /v1/workspaces/:id/annotations
//         Authorization: Bearer <license key> with the 'sync' entitlement.
//         → 200 {version, envelope} | 404 when never pushed.
//     PUT /v1/workspaces/:id/annotations
//         Same auth. `If-Match: <version>` (0 for the first push), JSON body
//         is the schema-v2 annotations envelope.
//         → 200 {version: n+1} | 409 {version} on optimistic-concurrency
//         mismatch | 401/403 on auth failures.
//
// Request bodies are capped at 1 MB. Malformed JSON is a 400. License keys
// are never logged — error paths only emit static reason codes.

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { issueKey, verifyKey, type LicensePayload } from './keys';
import { FileStore } from './store';
import { parseCheckoutEvent, verifyStripeSignature } from './stripe';

export const DEFAULT_PORT = 8787;
export const MAX_BODY_BYTES = 1024 * 1024;

/** Entitlement required by the annotation sync endpoints. */
export const SYNC_ENTITLEMENT = 'sync';

export interface ServerOptions {
    /** HMAC secret used to verify license keys (env LICENSE_SECRET). */
    secret: string;
    /** Backing JSON-file store (revocations + workspace envelopes). */
    store: FileStore;
    /**
     * Stripe webhook signing secret (env STRIPE_WEBHOOK_SECRET). When unset,
     * POST /v1/webhooks/stripe does not exist (404) — payments are opt-in.
     */
    stripeWebhookSecret?: string;
}

/** Response shape of POST /v1/validate — must match the extension contract. */
export interface ValidateResponse {
    valid: boolean;
    entitlements: string[];
    expiresAt?: string;
}

/** Internal control-flow error carrying an HTTP status and JSON body. */
class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: Record<string, unknown>
    ) {
        super(`HTTP ${status}`);
    }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

/**
 * Buffer the request body, enforcing MAX_BODY_BYTES. A Content-Length that
 * already exceeds the limit short-circuits to 413; bodies that cross the
 * limit mid-stream are discarded and rejected at end-of-stream so the
 * connection stays in a readable state for the response.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            reject(new HttpError(413, { error: 'payload-too-large' }));
            return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let overflow = false;
        req.on('data', (chunk: Buffer) => {
            if (overflow) {
                return; // keep draining, body already rejected below
            }
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                overflow = true;
                chunks.length = 0;
                reject(new HttpError(413, { error: 'payload-too-large' }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!overflow) {
                resolve(Buffer.concat(chunks));
            }
        });
        req.on('error', (err) => reject(err));
    });
}

function parseJsonBody(body: Buffer): unknown {
    try {
        return JSON.parse(body.toString('utf8'));
    } catch {
        throw new HttpError(400, { error: 'invalid-json' });
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the Bearer license key into a verified, non-revoked payload.
 * Throws 401 on any failure — the reason is intentionally not detailed and
 * the key itself never reaches a log line.
 */
function authenticate(options: ServerOptions, req: http.IncomingMessage): LicensePayload {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
        throw new HttpError(401, { error: 'unauthorized' });
    }
    const key = header.slice('Bearer '.length).trim();
    const payload = verifyKey(key, options.secret);
    if (payload === null || options.store.isRevoked(payload.id)) {
        throw new HttpError(401, { error: 'unauthorized' });
    }
    return payload;
}

function requireEntitlement(payload: LicensePayload, featureId: string): void {
    if (!payload.entitlements.includes(featureId)) {
        throw new HttpError(403, { error: 'forbidden', missingEntitlement: featureId });
    }
}

// ── Route handlers ───────────────────────────────────────────────────────

async function handleValidate(
    options: ServerOptions,
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const body = parseJsonBody(await readBody(req));
    if (!isPlainObject(body) || typeof body.key !== 'string') {
        throw new HttpError(400, { error: 'missing-key' });
    }
    // `product` is echoed by the extension ('out-of-code-insights') but not
    // enforced: a self-hosted instance serves exactly one product.
    const payload = verifyKey(body.key, options.secret);
    if (payload === null || options.store.isRevoked(payload.id)) {
        const invalid: ValidateResponse = { valid: false, entitlements: [] };
        sendJson(res, 200, invalid);
        return;
    }
    const valid: ValidateResponse = { valid: true, entitlements: payload.entitlements };
    if (payload.exp !== undefined) {
        valid.expiresAt = payload.exp;
    }
    sendJson(res, 200, valid);
}

function handleGetAnnotations(options: ServerOptions, workspaceId: string, res: http.ServerResponse): void {
    const record = options.store.getWorkspace(workspaceId);
    if (record === null) {
        sendJson(res, 404, { error: 'not-found' });
        return;
    }
    sendJson(res, 200, { version: record.version, envelope: record.envelope });
}

async function handlePutAnnotations(
    options: ServerOptions,
    workspaceId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string') {
        throw new HttpError(400, { error: 'missing-if-match' });
    }
    const match = /^"?(\d+)"?$/.exec(ifMatch.trim());
    if (match === null) {
        throw new HttpError(400, { error: 'invalid-if-match' });
    }
    const expectedVersion = Number(match[1]);

    const envelope = parseJsonBody(await readBody(req));
    if (!isPlainObject(envelope)) {
        throw new HttpError(400, { error: 'invalid-envelope' });
    }

    const result = options.store.putWorkspace(workspaceId, expectedVersion, envelope);
    if (!result.ok) {
        sendJson(res, 409, { version: result.version });
        return;
    }
    sendJson(res, 200, { version: result.version });
}

/**
 * POST /v1/webhooks/stripe — issue a license key when a checkout completes.
 *
 * Verifies the Stripe-Signature header over the RAW request bytes, then:
 *   - non-checkout events → 200 {received, ignored} (stops Stripe retries),
 *   - replayed event ids → 200 {received, duplicate} (idempotent),
 *   - otherwise issue a key with the entitlements/lifetime from the session
 *     metadata and persist it in the issued-keys store for the operator to
 *     deliver (`cli.js issued`). The key itself is never logged.
 */
async function handleStripeWebhook(
    options: ServerOptions,
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const webhookSecret = options.stripeWebhookSecret;
    if (webhookSecret === undefined || webhookSecret.length === 0) {
        throw new HttpError(404, { error: 'not-found' });
    }
    const rawBody = (await readBody(req)).toString('utf8');
    const signatureHeader = req.headers['stripe-signature'];
    if (typeof signatureHeader !== 'string' || !verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
        throw new HttpError(400, { error: 'invalid-signature' });
    }
    const checkout = parseCheckoutEvent(parseJsonBody(Buffer.from(rawBody, 'utf8')));
    if (checkout === null) {
        sendJson(res, 200, { received: true, ignored: true });
        return;
    }
    if (options.store.listIssuedKeys().some((r) => r.eventId === checkout.eventId)) {
        sendJson(res, 200, { received: true, duplicate: true });
        return;
    }
    const keyId = randomUUID();
    const expiresAt = new Date(Date.now() + checkout.days * 24 * 60 * 60 * 1000).toISOString();
    const key = issueKey({ id: keyId, entitlements: checkout.entitlements, exp: expiresAt }, options.secret);
    options.store.recordIssuedKey({
        eventId: checkout.eventId,
        keyId,
        key,
        email: checkout.email,
        entitlements: checkout.entitlements,
        expiresAt,
        createdAt: new Date().toISOString(),
    });
    sendJson(res, 200, { received: true, keyId });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

const WORKSPACE_ROUTE = /^\/v1\/workspaces\/([^/]+)\/annotations$/;

async function dispatch(
    options: ServerOptions,
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const urlPath = (req.url ?? '/').split('?')[0];

    if (urlPath === '/v1/validate') {
        if (req.method !== 'POST') {
            throw new HttpError(405, { error: 'method-not-allowed' });
        }
        await handleValidate(options, req, res);
        return;
    }

    if (urlPath === '/v1/webhooks/stripe') {
        if (req.method !== 'POST') {
            throw new HttpError(405, { error: 'method-not-allowed' });
        }
        await handleStripeWebhook(options, req, res);
        return;
    }

    const workspaceMatch = WORKSPACE_ROUTE.exec(urlPath);
    if (workspaceMatch !== null) {
        let workspaceId: string;
        try {
            workspaceId = decodeURIComponent(workspaceMatch[1]);
        } catch {
            throw new HttpError(400, { error: 'invalid-workspace-id' });
        }
        const payload = authenticate(options, req);
        requireEntitlement(payload, SYNC_ENTITLEMENT);
        if (req.method === 'GET') {
            handleGetAnnotations(options, workspaceId, res);
            return;
        }
        if (req.method === 'PUT') {
            await handlePutAnnotations(options, workspaceId, req, res);
            return;
        }
        throw new HttpError(405, { error: 'method-not-allowed' });
    }

    throw new HttpError(404, { error: 'not-found' });
}

/** Build the HTTP server. Callers own listen()/close(). */
export function createServer(options: ServerOptions): http.Server {
    if (typeof options.secret !== 'string' || options.secret.length === 0) {
        throw new Error('createServer: secret must be a non-empty string');
    }
    return http.createServer((req, res) => {
        dispatch(options, req, res).catch((err: unknown) => {
            if (err instanceof HttpError) {
                if (!res.headersSent) {
                    sendJson(res, err.status, err.body);
                }
            } else {
                // Never include request data (keys, bodies) in the log line.
                console.error('license-server: request failed:', err instanceof Error ? err.message : String(err));
                if (!res.headersSent) {
                    sendJson(res, 500, { error: 'internal' });
                }
            }
            // Drain whatever the client is still sending so the response can
            // be read; the socket stays usable for keep-alive.
            req.resume();
        });
    });
}

/** Listen helper used by tests and the production entry point. */
export function startServer(options: ServerOptions, port: number): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = createServer(options);
        server.once('error', reject);
        server.listen(port, () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('startServer: could not determine bound port'));
                return;
            }
            resolve({ server, port: address.port });
        });
    });
}

function main(): void {
    const secret = process.env.LICENSE_SECRET;
    if (secret === undefined || secret.length === 0) {
        console.error('license-server: the LICENSE_SECRET environment variable is required');
        process.exit(1);
    }
    const dataDir = process.env.DATA_DIR ?? path.resolve('data');
    const port = Number(process.env.PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`license-server: invalid PORT value: ${process.env.PORT}`);
        process.exit(1);
    }
    const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    startServer({ secret, store: new FileStore(dataDir), stripeWebhookSecret }, port)
        .then(({ port: boundPort }) => {
            console.log(`license-server listening on port ${boundPort} (data dir: ${dataDir})`);
        })
        .catch((err: unknown) => {
            console.error('license-server: failed to start:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
}

if (require.main === module) {
    main();
}
