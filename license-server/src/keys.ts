// SPDX-License-Identifier: MPL-2.0
//
// Offline-verifiable license keys.
//
// Key format:
//
//     OOCI.<base64url(JSON payload)>.<base64url(HMAC-SHA256(payload segment, LICENSE_SECRET))>
//
// The HMAC is computed over the base64url-encoded payload segment — the exact
// bytes that travel inside the key — so verification never depends on JSON
// canonicalization. The payload is `LicensePayload`; `exp` (ISO-8601 date) is
// optional and absent means the key never expires.
//
// Pure module: no I/O, no environment access. Tested in test/keys.test.ts.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** First segment of every key — cheap discriminator for foreign tokens. */
export const KEY_PREFIX = 'OOCI';

export interface LicensePayload {
    /** Stable key identifier. Revocation targets this id, never the full key. */
    id: string;
    /** Feature ids unlocked by this key (e.g. ['sync', 'pro']). */
    entitlements: string[];
    /** Optional ISO-8601 expiry. Absent = perpetual key. */
    exp?: string;
}

/** Structural validation of a decoded payload. Exported for reuse by the CLI. */
export function isLicensePayload(value: unknown): value is LicensePayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string' || v.id.length === 0) {
        return false;
    }
    if (!Array.isArray(v.entitlements) || !v.entitlements.every((e) => typeof e === 'string')) {
        return false;
    }
    if (v.exp !== undefined && typeof v.exp !== 'string') {
        return false;
    }
    return true;
}

function sign(payloadSegment: string, secret: string): Buffer {
    return createHmac('sha256', secret).update(payloadSegment, 'utf8').digest();
}

/**
 * Issue a signed license key for `payload`.
 * Throws on an empty secret or a structurally invalid payload — issuing is a
 * trusted operation (CLI/server side) and must fail loudly.
 */
export function issueKey(payload: LicensePayload, secret: string): string {
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('issueKey: secret must be a non-empty string');
    }
    if (!isLicensePayload(payload)) {
        throw new Error('issueKey: payload must have a non-empty id and a string[] entitlements');
    }
    const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signatureSegment = sign(payloadSegment, secret).toString('base64url');
    return `${KEY_PREFIX}.${payloadSegment}.${signatureSegment}`;
}

/**
 * Verify a license key offline.
 *
 * Returns the decoded payload when the prefix, signature and (optional)
 * expiry all check out; `null` otherwise. Never throws on malformed input —
 * any garbage simply yields `null`. `now` is injectable for deterministic
 * expiry tests.
 */
export function verifyKey(key: string, secret: string, now: Date = new Date()): LicensePayload | null {
    if (typeof key !== 'string' || typeof secret !== 'string' || secret.length === 0) {
        return null;
    }
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX || parts[1].length === 0 || parts[2].length === 0) {
        return null;
    }
    const [, payloadSegment, signatureSegment] = parts;

    const expected = sign(payloadSegment, secret);
    let actual: Buffer;
    try {
        actual = Buffer.from(signatureSegment, 'base64url');
    } catch {
        return null;
    }
    // Length mismatch reveals nothing useful; timingSafeEqual requires equal lengths.
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return null;
    }

    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!isLicensePayload(decoded)) {
        return null;
    }
    if (decoded.exp !== undefined) {
        const expMs = Date.parse(decoded.exp);
        if (Number.isNaN(expMs) || expMs <= now.getTime()) {
            return null;
        }
    }
    return decoded;
}
