/**
 * Pure-logic tests for the Pro licensing scaffold (entitlement resolution,
 * cache expiry, offline grace period math with an injected clock).
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import {
    cacheFromResponse,
    DEFAULT_OFFLINE_GRACE_DAYS,
    graceDaysToMs,
    isCacheWithinGrace,
    isLicenseExpired,
    MS_PER_DAY,
    parseValidationResponse,
    resolveEntitlement,
    type EntitlementCache,
} from '../../../pro/licensing';

const NOW = Date.parse('2026-06-11T12:00:00.000Z');

function makeCache(overrides: Partial<EntitlementCache> = {}): EntitlementCache {
    return {
        valid: true,
        entitlements: ['kanban-pro', 'ai-batch'],
        validatedAt: new Date(NOW - 1 * MS_PER_DAY).toISOString(),
        ...overrides,
    };
}

suite('licensing — resolveEntitlement', () => {
    test('feature absent from gatedFeatures is always free (default empty list)', () => {
        assert.strictEqual(
            resolveEntitlement('kanban-pro', { gatedFeatures: [], cache: undefined, graceDays: 7, nowMs: NOW }),
            true
        );
    });

    test('feature absent from a non-empty gatedFeatures list stays free', () => {
        assert.strictEqual(
            resolveEntitlement('free-feature', {
                gatedFeatures: ['kanban-pro'],
                cache: undefined,
                graceDays: 7,
                nowMs: NOW,
            }),
            true
        );
    });

    test('gated feature without any cache is locked', () => {
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache: undefined,
                graceDays: 7,
                nowMs: NOW,
            }),
            false
        );
    });

    test('gated feature with a fresh valid cache containing the id is unlocked', () => {
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache: makeCache(),
                graceDays: 7,
                nowMs: NOW,
            }),
            true
        );
    });

    test('gated feature missing from the cached entitlements is locked', () => {
        assert.strictEqual(
            resolveEntitlement('multi-root', {
                gatedFeatures: ['multi-root'],
                cache: makeCache(),
                graceDays: 7,
                nowMs: NOW,
            }),
            false
        );
    });

    test('cache with valid=false never unlocks', () => {
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache: makeCache({ valid: false }),
                graceDays: 7,
                nowMs: NOW,
            }),
            false
        );
    });

    test('expired license (expiresAt in the past) is locked despite a fresh cache', () => {
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache: makeCache({ expiresAt: new Date(NOW - 1).toISOString() }),
                graceDays: 7,
                nowMs: NOW,
            }),
            false
        );
    });

    test('cache validated beyond the grace window is locked', () => {
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache: makeCache({ validatedAt: new Date(NOW - 8 * MS_PER_DAY).toISOString() }),
                graceDays: 7,
                nowMs: NOW,
            }),
            false
        );
    });
});

suite('licensing — grace period math (injected clock)', () => {
    test('graceDaysToMs converts days and falls back on bad input', () => {
        assert.strictEqual(graceDaysToMs(7), 7 * MS_PER_DAY);
        assert.strictEqual(graceDaysToMs(0), 0);
        assert.strictEqual(graceDaysToMs(-3), DEFAULT_OFFLINE_GRACE_DAYS * MS_PER_DAY);
        assert.strictEqual(graceDaysToMs(Number.NaN), DEFAULT_OFFLINE_GRACE_DAYS * MS_PER_DAY);
        assert.strictEqual(graceDaysToMs(Number.POSITIVE_INFINITY), DEFAULT_OFFLINE_GRACE_DAYS * MS_PER_DAY);
    });

    test('cache exactly at the grace boundary is still fresh (inclusive)', () => {
        const cache = makeCache({ validatedAt: new Date(NOW - 7 * MS_PER_DAY).toISOString() });
        assert.strictEqual(isCacheWithinGrace(cache, 7, NOW), true);
        assert.strictEqual(isCacheWithinGrace(cache, 7, NOW + 1), false);
    });

    test('grace of 0 days only trusts a same-instant validation', () => {
        assert.strictEqual(isCacheWithinGrace(makeCache({ validatedAt: new Date(NOW).toISOString() }), 0, NOW), true);
        assert.strictEqual(
            isCacheWithinGrace(makeCache({ validatedAt: new Date(NOW - 1).toISOString() }), 0, NOW),
            false
        );
    });

    test('unparseable validatedAt is never trusted', () => {
        assert.strictEqual(isCacheWithinGrace(makeCache({ validatedAt: 'not-a-date' }), 7, NOW), false);
    });

    test('isLicenseExpired handles absent, future, past and unparseable expiry', () => {
        assert.strictEqual(isLicenseExpired(undefined, NOW), false);
        assert.strictEqual(isLicenseExpired(new Date(NOW + MS_PER_DAY).toISOString(), NOW), false);
        assert.strictEqual(isLicenseExpired(new Date(NOW - MS_PER_DAY).toISOString(), NOW), true);
        assert.strictEqual(isLicenseExpired(new Date(NOW).toISOString(), NOW), true);
        assert.strictEqual(isLicenseExpired('garbage', NOW), false);
    });
});

suite('licensing — parseValidationResponse', () => {
    test('accepts the documented shape', () => {
        assert.deepStrictEqual(
            parseValidationResponse({ valid: true, entitlements: ['a', 'b'], expiresAt: '2027-01-01T00:00:00.000Z' }),
            { valid: true, entitlements: ['a', 'b'], expiresAt: '2027-01-01T00:00:00.000Z' }
        );
    });

    test('rejects non-objects and payloads without a boolean valid flag', () => {
        assert.strictEqual(parseValidationResponse(null), null);
        assert.strictEqual(parseValidationResponse('valid'), null);
        assert.strictEqual(parseValidationResponse({ entitlements: [] }), null);
        assert.strictEqual(parseValidationResponse({ valid: 'yes' }), null);
    });

    test('normalizes missing or dirty entitlements to a string array', () => {
        assert.deepStrictEqual(parseValidationResponse({ valid: true }), { valid: true, entitlements: [] });
        assert.deepStrictEqual(parseValidationResponse({ valid: false, entitlements: ['a', 1, null, 'b'] }), {
            valid: false,
            entitlements: ['a', 'b'],
        });
    });

    test('drops a non-string expiresAt', () => {
        assert.deepStrictEqual(parseValidationResponse({ valid: true, entitlements: [], expiresAt: 12345 }), {
            valid: true,
            entitlements: [],
        });
    });
});

suite('licensing — cacheFromResponse', () => {
    test('stamps validatedAt from the injected clock and copies entitlements', () => {
        const response = { valid: true, entitlements: ['a'] };
        const cache = cacheFromResponse(response, NOW);
        assert.strictEqual(cache.validatedAt, new Date(NOW).toISOString());
        assert.deepStrictEqual(cache.entitlements, ['a']);
        assert.notStrictEqual(cache.entitlements, response.entitlements, 'entitlements must be copied');
        assert.strictEqual(cache.expiresAt, undefined);
    });

    test('round-trips into resolveEntitlement with the same clock', () => {
        const cache = cacheFromResponse({ valid: true, entitlements: ['kanban-pro'] }, NOW);
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache,
                graceDays: 7,
                nowMs: NOW + 6 * MS_PER_DAY,
            }),
            true
        );
        assert.strictEqual(
            resolveEntitlement('kanban-pro', {
                gatedFeatures: ['kanban-pro'],
                cache,
                graceDays: 7,
                nowMs: NOW + 8 * MS_PER_DAY,
            }),
            false
        );
    });
});
