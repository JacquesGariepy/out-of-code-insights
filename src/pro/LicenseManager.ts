// SPDX-License-Identifier: MPL-2.0
//
// Pro license / entitlement scaffold. Everything is OFF by default:
//  - `annotation.pro.licenseServerUrl` defaults to "" → validation is skipped;
//  - `annotation.pro.gatedFeatures` defaults to [] → no feature is gated.
// The extension therefore stays fully free until the product flips features
// on. Pure decision logic lives in ./licensing (unit-testable without vscode).

import * as vscode from 'vscode';
import { TypedEventEmitter } from '../transactional/internal/event-emitter';
import { loc } from '../managers/LocalizationManager';
import { getLogger } from '../utils/logger';
import {
    cacheFromResponse,
    DEFAULT_OFFLINE_GRACE_DAYS,
    parseValidationResponse,
    resolveEntitlement,
    type EntitlementCache,
    type LicenseValidationResponse,
} from './licensing';

/** SecretStorage key holding the raw license key. */
export const LICENSE_SECRET_KEY = 'outOfCodeInsights.licenseKey';

/** globalState key holding the persisted {@link EntitlementCache}. */
export const ENTITLEMENT_CACHE_KEY = 'outOfCodeInsights.pro.entitlementCache';

/** Product identifier sent to the license server. */
export const LICENSE_PRODUCT_ID = 'out-of-code-insights';

/** Network timeout for a validation round-trip. */
const VALIDATION_TIMEOUT_MS = 10_000;

/** Validation outcome surfaced to callers of validate()/refresh(). */
export interface LicenseValidationOutcome extends LicenseValidationResponse {
    /** True when no license server is configured and validation was skipped. */
    skipped: boolean;
}

// Module-level slot so requireEntitlement() can resolve the live instance
// without importing extension.ts (which would create an import cycle).
let activeLicenseManager: LicenseManager | undefined;

/**
 * Lookup hook for the in-process LicenseManager, mirroring the
 * `getAnnotationStore()` pattern. Returns `undefined` before activation
 * constructs the manager (and after dispose).
 */
export function getLicenseManager(): LicenseManager | undefined {
    return activeLicenseManager;
}

export class LicenseManager {
    private readonly _onDidChangeEntitlements = new TypedEventEmitter<readonly string[]>();
    /** Fires with the new entitlement list every time the cache is rewritten. */
    readonly onDidChangeEntitlements = this._onDidChangeEntitlements.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        activeLicenseManager = this;
    }

    // ── License key (SecretStorage) ──────────────────────────────────────

    getLicenseKey(): Thenable<string | undefined> {
        return this.context.secrets.get(LICENSE_SECRET_KEY);
    }

    async storeLicenseKey(key: string): Promise<void> {
        await this.context.secrets.store(LICENSE_SECRET_KEY, key);
    }

    // ── Entitlement cache (globalState) ──────────────────────────────────

    getCachedEntitlements(): EntitlementCache | undefined {
        return this.context.globalState.get<EntitlementCache>(ENTITLEMENT_CACHE_KEY);
    }

    /**
     * Synchronous gating decision. TRUE when the feature is not listed in
     * `annotation.pro.gatedFeatures` (everything free by default); otherwise
     * requires a cached valid entitlement containing `featureId`, within the
     * offline grace window (`annotation.pro.offlineGraceDays`).
     */
    isEntitled(featureId: string): boolean {
        const cfg = vscode.workspace.getConfiguration('annotation');
        return resolveEntitlement(featureId, {
            gatedFeatures: cfg.get<string[]>('pro.gatedFeatures', []),
            cache: this.getCachedEntitlements(),
            graceDays: cfg.get<number>('pro.offlineGraceDays', DEFAULT_OFFLINE_GRACE_DAYS),
            nowMs: Date.now(),
        });
    }

    // ── Server validation ────────────────────────────────────────────────

    /**
     * POST `{key, product}` to `annotation.pro.licenseServerUrl`. When the
     * setting is empty the call is skipped (`skipped: true`, empty
     * entitlements, cache untouched). On a successful round-trip the
     * entitlement cache is rewritten and `onDidChangeEntitlements` fires.
     * Network/shape errors reject — the caller decides how to surface them;
     * the existing cache keeps serving `isEntitled` through the grace window.
     */
    async validate(key: string): Promise<LicenseValidationOutcome> {
        const serverUrl = vscode.workspace
            .getConfiguration('annotation')
            .get<string>('pro.licenseServerUrl', '')
            .trim();
        if (serverUrl.length === 0) {
            return { valid: false, entitlements: [], skipped: true };
        }

        // The extension polyfills AbortController before any other import
        // (src/extension.ts), so globalThis.AbortController is always set.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
        try {
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, product: LICENSE_PRODUCT_ID }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`license server responded with HTTP ${response.status}`);
            }
            const parsed = parseValidationResponse(await response.json());
            if (!parsed) {
                throw new Error('license server returned an unexpected payload');
            }
            await this.updateCache(cacheFromResponse(parsed, Date.now()));
            return { ...parsed, skipped: false };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Revalidate the stored key and refresh the cache. Returns `undefined`
     * when no key is stored or when validation fails (the cached
     * entitlements keep serving through the offline grace period).
     */
    async refresh(): Promise<LicenseValidationOutcome | undefined> {
        const key = await this.getLicenseKey();
        if (!key) {
            return undefined;
        }
        try {
            return await this.validate(key);
        } catch (err) {
            getLogger().warn('LicenseManager.refresh: validation failed; relying on cached entitlements', err);
            return undefined;
        }
    }

    private async updateCache(cache: EntitlementCache): Promise<void> {
        await this.context.globalState.update(ENTITLEMENT_CACHE_KEY, cache);
        this._onDidChangeEntitlements.fire(cache.valid ? [...cache.entitlements] : []);
    }

    dispose(): void {
        this._onDidChangeEntitlements.dispose();
        if (activeLicenseManager === this) {
            activeLicenseManager = undefined;
        }
    }
}

/**
 * Gate helper for command handlers. Returns true when `featureId` is
 * entitled (which, with the default empty `annotation.pro.gatedFeatures`,
 * is always). When gated and not entitled, shows a localized "Pro feature"
 * toast with an "Enter license" button wired to `annotations.enterLicenseKey`
 * and returns false.
 *
 * When the manager is not constructed yet (activation in progress or
 * failed), the helper stays fail-open: the scaffold must never lock a
 * feature in the free-by-default configuration.
 */
export function requireEntitlement(featureId: string, friendlyName: string): boolean {
    const manager = getLicenseManager();
    if (!manager) {
        return true;
    }
    if (manager.isEntitled(featureId)) {
        return true;
    }
    const enterLabel = loc('enterLicense', 'Enter license');
    void vscode.window
        .showInformationMessage(
            loc('proFeatureLocked', '"{0}" is a Pro feature — enter your license key to unlock it.', friendlyName),
            enterLabel
        )
        .then((choice) => {
            if (choice === enterLabel) {
                void vscode.commands.executeCommand('annotations.enterLicenseKey');
            }
        });
    return false;
}
