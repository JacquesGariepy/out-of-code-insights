// SPDX-License-Identifier: MPL-2.0
//
// Pure licensing logic for the Pro entitlement scaffold. NO vscode import —
// every function here is unit-testable in plain Node (test:unit pass).
//
// Design rule (scaffold phase): the extension stays fully free. A feature is
// gated ONLY when its id appears in `annotation.pro.gatedFeatures` (default
// empty), so until the product flips features on, `resolveEntitlement`
// returns true for everything.

/** Response contract of the license validation server. */
export interface LicenseValidationResponse {
    valid: boolean;
    entitlements: string[];
    /** ISO-8601 license expiry. Absent = perpetual. */
    expiresAt?: string;
}

/** Entitlement cache persisted in `globalState` between validations. */
export interface EntitlementCache {
    /** Outcome of the last server validation. */
    valid: boolean;
    /** Feature ids granted by the last successful validation. */
    entitlements: string[];
    /** ISO-8601 timestamp of the last successful server round-trip. */
    validatedAt: string;
    /** ISO-8601 license expiry mirrored from the server response. */
    expiresAt?: string;
}

/** Default for `annotation.pro.offlineGraceDays`. */
export const DEFAULT_OFFLINE_GRACE_DAYS = 7;

export const MS_PER_DAY = 86_400_000;

/**
 * Convert the offline grace period (days) to milliseconds. Negative or
 * non-finite inputs fall back to {@link DEFAULT_OFFLINE_GRACE_DAYS} so a
 * corrupted setting can never produce an always-stale (or infinite) window.
 */
export function graceDaysToMs(days: number): number {
    if (!Number.isFinite(days) || days < 0) {
        return DEFAULT_OFFLINE_GRACE_DAYS * MS_PER_DAY;
    }
    return days * MS_PER_DAY;
}

/**
 * True when the cached validation is still inside the offline grace window:
 * `nowMs - validatedAt <= graceDays`. A cache with an unparseable
 * `validatedAt` is treated as stale (never trusted).
 */
export function isCacheWithinGrace(cache: EntitlementCache, graceDays: number, nowMs: number): boolean {
    const validatedAtMs = Date.parse(cache.validatedAt);
    if (Number.isNaN(validatedAtMs)) {
        return false;
    }
    return nowMs - validatedAtMs <= graceDaysToMs(graceDays);
}

/**
 * True when the license itself has expired (`expiresAt` reached). An absent
 * or unparseable `expiresAt` means "no expiry" — the grace window is the
 * only time bound in that case.
 */
export function isLicenseExpired(expiresAt: string | undefined, nowMs: number): boolean {
    if (!expiresAt) {
        return false;
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
        return false;
    }
    return nowMs >= expiresAtMs;
}

/** Inputs needed to decide an entitlement without touching vscode APIs. */
export interface EntitlementContext {
    /** `annotation.pro.gatedFeatures` — feature ids that require a license. */
    gatedFeatures: readonly string[];
    /** Last persisted validation outcome, if any. */
    cache: EntitlementCache | undefined;
    /** `annotation.pro.offlineGraceDays`. */
    graceDays: number;
    /** Injected clock (wall-clock ms epoch). */
    nowMs: number;
}

/**
 * Core gating decision:
 *  - a feature NOT listed in `gatedFeatures` is always available (free);
 *  - a gated feature requires a cached VALID validation that (a) has not
 *    expired, (b) is inside the offline grace window, and (c) actually
 *    grants the feature id.
 */
export function resolveEntitlement(featureId: string, ctx: EntitlementContext): boolean {
    if (!ctx.gatedFeatures.includes(featureId)) {
        return true;
    }
    const cache = ctx.cache;
    if (!cache || !cache.valid) {
        return false;
    }
    if (isLicenseExpired(cache.expiresAt, ctx.nowMs)) {
        return false;
    }
    if (!isCacheWithinGrace(cache, ctx.graceDays, ctx.nowMs)) {
        return false;
    }
    return cache.entitlements.includes(featureId);
}

/**
 * Defensive parse of the license-server payload. Returns null when the
 * shape is unusable (no boolean `valid`); non-string entries in
 * `entitlements` are dropped rather than failing the whole response.
 */
export function parseValidationResponse(payload: unknown): LicenseValidationResponse | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.valid !== 'boolean') {
        return null;
    }
    const entitlements = Array.isArray(record.entitlements)
        ? record.entitlements.filter((e): e is string => typeof e === 'string')
        : [];
    const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : undefined;
    return {
        valid: record.valid,
        entitlements,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
}

/** Build the persistable cache entry from a server response, with an injected clock. */
export function cacheFromResponse(response: LicenseValidationResponse, validatedAtMs: number): EntitlementCache {
    return {
        valid: response.valid,
        entitlements: [...response.entitlements],
        validatedAt: new Date(validatedAtMs).toISOString(),
        ...(response.expiresAt !== undefined ? { expiresAt: response.expiresAt } : {}),
    };
}
