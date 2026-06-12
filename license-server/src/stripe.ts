// SPDX-License-Identifier: MPL-2.0
//
// Stripe webhook support — pure helpers, zero dependencies.
//
// Signature scheme (Stripe-Signature header):
//     t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]
// The signed payload is `${t}.${rawBody}` and the HMAC is SHA-256 keyed with
// the endpoint's webhook signing secret (whsec_...). Multiple v1 entries are
// allowed during secret rotation — any single match passes. Comparison is
// timing-safe and the timestamp must be within `toleranceSeconds` of `nowMs`
// to defeat replay of captured deliveries.
//
// Event parsing extracts exactly what key issuance needs from
// `checkout.session.completed`; every other event type is acknowledged and
// ignored by the caller.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Parse the Stripe-Signature header into its timestamp and v1 signatures. */
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
    const parts = header.split(',').map((p) => p.trim());
    let timestamp: number | null = null;
    const signatures: string[] = [];
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq === -1) {
            return null;
        }
        const k = part.slice(0, eq);
        const v = part.slice(eq + 1);
        if (k === 't') {
            const t = Number(v);
            if (!Number.isInteger(t) || t <= 0) {
                return null;
            }
            timestamp = t;
        } else if (k === 'v1') {
            if (!/^[0-9a-f]{64}$/i.test(v)) {
                return null;
            }
            signatures.push(v.toLowerCase());
        }
        // Unknown schemes (v0, ...) are ignored, per Stripe's guidance.
    }
    if (timestamp === null || signatures.length === 0) {
        return null;
    }
    return { timestamp, signatures };
}

/**
 * Verify a Stripe webhook delivery. `rawBody` must be the exact request
 * bytes (signature breaks on any re-serialization). `nowMs` is injectable
 * for deterministic tests.
 */
export function verifyStripeSignature(
    rawBody: string,
    signatureHeader: string,
    webhookSecret: string,
    toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
    nowMs: number = Date.now()
): boolean {
    if (webhookSecret.length === 0 || signatureHeader.length === 0) {
        return false;
    }
    const parsed = parseSignatureHeader(signatureHeader);
    if (parsed === null) {
        return false;
    }
    if (Math.abs(nowMs / 1000 - parsed.timestamp) > toleranceSeconds) {
        return false;
    }
    const expected = createHmac('sha256', webhookSecret).update(`${parsed.timestamp}.${rawBody}`, 'utf8').digest();
    for (const signature of parsed.signatures) {
        const candidate = Buffer.from(signature, 'hex');
        if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
            return true;
        }
    }
    return false;
}

/** What key issuance needs from a completed checkout. */
export interface CheckoutSummary {
    /** Stripe event id — the idempotency key for issuance. */
    eventId: string;
    /** Customer email when Stripe provided one. */
    email: string | null;
    /** Entitlements from session metadata (`entitlements`, CSV). */
    entitlements: string[];
    /** Key lifetime in days from session metadata (`days`). */
    days: number;
}

export const DEFAULT_ENTITLEMENTS = ['sync', 'pro'];
export const DEFAULT_KEY_DAYS = 365;

/**
 * Extract a `CheckoutSummary` from a Stripe event body. Returns null for
 * anything that is not a well-formed `checkout.session.completed` event —
 * the webhook acknowledges those with 200 so Stripe stops retrying.
 */
export function parseCheckoutEvent(body: unknown): CheckoutSummary | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return null;
    }
    const event = body as Record<string, unknown>;
    if (typeof event.id !== 'string' || event.id.length === 0 || event.type !== 'checkout.session.completed') {
        return null;
    }
    const data = event.data;
    if (typeof data !== 'object' || data === null) {
        return null;
    }
    const session = (data as Record<string, unknown>).object;
    if (typeof session !== 'object' || session === null) {
        return null;
    }
    const s = session as Record<string, unknown>;

    let email: string | null = null;
    const details = s.customer_details;
    if (typeof details === 'object' && details !== null) {
        const detailEmail = (details as Record<string, unknown>).email;
        if (typeof detailEmail === 'string' && detailEmail.length > 0) {
            email = detailEmail;
        }
    }
    if (email === null && typeof s.customer_email === 'string' && s.customer_email.length > 0) {
        email = s.customer_email;
    }

    let entitlements = DEFAULT_ENTITLEMENTS;
    let days = DEFAULT_KEY_DAYS;
    const metadata = s.metadata;
    if (typeof metadata === 'object' && metadata !== null) {
        const m = metadata as Record<string, unknown>;
        if (typeof m.entitlements === 'string') {
            const parsedEntitlements = m.entitlements
                .split(',')
                .map((e) => e.trim())
                .filter((e) => e.length > 0);
            if (parsedEntitlements.length > 0) {
                entitlements = parsedEntitlements;
            }
        }
        const parsedDays = Number(m.days);
        if (Number.isFinite(parsedDays) && parsedDays > 0) {
            days = parsedDays;
        }
    }

    return { eventId: event.id, email, entitlements, days };
}
