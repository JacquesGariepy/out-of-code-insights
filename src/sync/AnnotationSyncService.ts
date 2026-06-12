// SPDX-License-Identifier: MPL-2.0
//
// Cloud annotation sync client — team sharing through the license server's
// `/v1/workspaces/<id>/annotations` API (see src/sync/syncPlan.ts for the
// protocol contract and the pure push/pull/conflict decision logic).
//
// The service is a thin I/O shell around planSync():
//  - GET the remote state, decide, then PUT (push) or deserialize (pull);
//  - optimistic concurrency via If-Match — a 409 means a teammate won the
//    race and we fall into the conflict path;
//  - conflict resolution is a non-modal warning with two explicit choices,
//    "Keep local (overwrite remote)" force-pushes with If-Match set to the
//    REMOTE version, "Take remote" overwrites the local store;
//  - `lastSyncedVersion` persists in workspaceState (per-workspace, like the
//    Kanban column store), the bearer token in SecretStorage. The token is
//    never logged.
//
// Auto mode (`annotation.sync.auto`): one pull-oriented sync on activation,
// then a 5 s trailing-edge debounced push after `store.onDidChange`. Auto
// runs are non-interactive (no toasts except the conflict prompt) and skip
// silently when the 'sync' feature is gated and not entitled.

import * as vscode from 'vscode';
import { loc } from '../managers/LocalizationManager';
import { getLogger } from '../utils/logger';
import { getLicenseManager } from '../pro/LicenseManager';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { AnnotationPersistence } from '../transactional/AnnotationPersistence';
import type { AnnotationStoreFileV2 } from '../transactional/types';
import { createDebounced, type Debounced } from '../utils/debounce';
import { parseRemoteAnnotationsResponse, parseVersionPayload, planSync, type RemoteAnnotationsState } from './syncPlan';

/** SecretStorage key holding the bearer token for the sync server. */
export const SYNC_TOKEN_SECRET_KEY = 'outOfCodeInsights.syncToken';

/** workspaceState key — remote version recorded after the last successful sync. */
export const SYNC_LAST_VERSION_KEY = 'outOfCodeInsights.sync.lastSyncedVersion';

/** workspaceState key — ISO timestamp of the last successful push/pull. */
export const SYNC_LAST_AT_KEY = 'outOfCodeInsights.sync.lastSyncAt';

/** Feature id gated through `annotation.pro.gatedFeatures`. */
export const SYNC_FEATURE_ID = 'sync';

/** Network timeout for one GET/PUT round-trip. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Quiet period between the last store change and an auto push. */
const AUTO_PUSH_DEBOUNCE_MS = 5_000;

/** Status-bar facing state of the service. */
export type SyncState = 'idle' | 'syncing' | 'error' | 'conflict';

/** Outcome of one syncNow() run (returned for tests/telemetry, not shown raw). */
export type SyncOutcome = 'noop' | 'pushed' | 'pulled' | 'conflict-pending' | 'not-configured' | 'failed' | 'skipped';

/** Options for one syncNow() run. */
export interface SyncRunOptions {
    /** True for the command path (toasts on every outcome); false for auto runs. */
    interactive: boolean;
}

/** 401/403 from the sync server — surfaced with a dedicated message. */
class SyncAuthError extends Error {
    constructor(readonly status: number) {
        super(`sync server rejected the token (HTTP ${status})`);
        this.name = 'SyncAuthError';
    }
}

export class AnnotationSyncService {
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly disposables: { dispose(): void }[] = [];
    private readonly autoPush: Debounced;

    private state: SyncState = 'idle';
    /** True when the store mutated since the last successful sync (this session). */
    private localDirty = false;
    /** Suppresses the dirty flag while a pulled envelope is being applied. */
    private applyingRemote = false;
    /** Reentrancy guard — overlapping runs are skipped, not queued. */
    private syncInProgress = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: AnnotationStore,
        private readonly persistence: AnnotationPersistence
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this.statusBarItem.command = 'annotations.syncNow';

        this.autoPush = createDebounced(() => {
            void this.runAutoSync();
        }, AUTO_PUSH_DEBOUNCE_MS);

        this.disposables.push(
            this.store.onDidChange(() => {
                if (this.applyingRemote) {
                    return;
                }
                this.localDirty = true;
                if (this.isConfigured() && this.isAutoEnabled()) {
                    this.autoPush.schedule();
                }
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('annotation.sync')) {
                    this.updateStatusBar();
                }
            })
        );
        this.updateStatusBar();
    }

    /** Activation hook: render the status bar and pull once when auto-sync is on. */
    async start(): Promise<void> {
        this.updateStatusBar();
        if (this.isConfigured() && this.isAutoEnabled()) {
            await this.runAutoSync();
        }
    }

    // ── Configuration ────────────────────────────────────────────────────

    private getConfig(): { serverUrl: string; workspaceId: string; auto: boolean } {
        const cfg = vscode.workspace.getConfiguration('annotation');
        return {
            serverUrl: cfg.get<string>('sync.serverUrl', '').trim().replace(/\/+$/, ''),
            workspaceId: cfg.get<string>('sync.workspaceId', '').trim(),
            auto: cfg.get<boolean>('sync.auto', false),
        };
    }

    private isConfigured(): boolean {
        const { serverUrl, workspaceId } = this.getConfig();
        return serverUrl.length > 0 && workspaceId.length > 0;
    }

    private isAutoEnabled(): boolean {
        return this.getConfig().auto;
    }

    /** Remote version recorded after the last successful sync (0 = never). */
    getLastSyncedVersion(): number {
        return this.context.workspaceState.get<number>(SYNC_LAST_VERSION_KEY, 0);
    }

    private async recordSyncedVersion(version: number): Promise<void> {
        await this.context.workspaceState.update(SYNC_LAST_VERSION_KEY, version);
        await this.context.workspaceState.update(SYNC_LAST_AT_KEY, new Date().toISOString());
    }

    // ── Token configuration (annotations.syncConfigure) ──────────────────

    /**
     * Prompt for the bearer token (masked input), store it in SecretStorage
     * and remind the user to fill `annotation.sync.serverUrl` /
     * `annotation.sync.workspaceId` when either is still empty.
     */
    async configureToken(): Promise<void> {
        const entered = await vscode.window.showInputBox({
            prompt: loc('syncTokenPrompt', 'Enter the access token for the annotation sync server'),
            placeHolder: loc('syncTokenPlaceholder', 'Bearer token'),
            password: true,
            ignoreFocusOut: true,
            validateInput: (text) => {
                return text.trim().length === 0 ? loc('syncTokenEmpty', 'Token cannot be empty') : null;
            },
        });
        if (!entered) {
            return;
        }
        await this.context.secrets.store(SYNC_TOKEN_SECRET_KEY, entered.trim());
        getLogger().info('AnnotationSyncService: sync token stored in SecretStorage');

        if (!this.isConfigured()) {
            const openSettings = loc('openSettings', 'Open Settings');
            void vscode.window
                .showInformationMessage(
                    loc(
                        'syncSettingsReminder',
                        'Sync token stored. Set annotation.sync.serverUrl and annotation.sync.workspaceId to enable sync.'
                    ),
                    openSettings
                )
                .then((choice) => {
                    if (choice === openSettings) {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'annotation.sync');
                    }
                });
        } else {
            vscode.window.showInformationMessage(loc('syncTokenStored', 'Sync token stored.'));
        }
        this.updateStatusBar();
    }

    // ── Sync execution ───────────────────────────────────────────────────

    /** Auto-mode entry: silently honor the 'sync' feature gate, then sync. */
    private async runAutoSync(): Promise<void> {
        const manager = getLicenseManager();
        if (manager && !manager.isEntitled(SYNC_FEATURE_ID)) {
            getLogger().info('AnnotationSyncService: auto sync skipped — "sync" entitlement missing');
            return;
        }
        await this.syncNow({ interactive: false });
    }

    /**
     * One full sync round-trip: GET the remote state, plan with
     * {@link planSync}, then execute push / pull / conflict resolution.
     */
    async syncNow(options: SyncRunOptions = { interactive: true }): Promise<SyncOutcome> {
        if (!this.isConfigured()) {
            if (options.interactive) {
                const openSettings = loc('openSettings', 'Open Settings');
                void vscode.window
                    .showInformationMessage(
                        loc(
                            'syncNotConfigured',
                            'Annotation sync is not configured. Set annotation.sync.serverUrl and annotation.sync.workspaceId.'
                        ),
                        openSettings
                    )
                    .then((choice) => {
                        if (choice === openSettings) {
                            void vscode.commands.executeCommand('workbench.action.openSettings', 'annotation.sync');
                        }
                    });
            }
            return 'not-configured';
        }

        const token = (await this.context.secrets.get(SYNC_TOKEN_SECRET_KEY))?.trim();
        if (!token) {
            if (options.interactive) {
                const configureLabel = loc('syncConfigureAction', 'Configure sync');
                void vscode.window
                    .showWarningMessage(loc('syncTokenMissing', 'No sync access token configured.'), configureLabel)
                    .then((choice) => {
                        if (choice === configureLabel) {
                            void vscode.commands.executeCommand('annotations.syncConfigure');
                        }
                    });
            } else {
                getLogger().warn('AnnotationSyncService: auto sync skipped — no token in SecretStorage');
            }
            return 'not-configured';
        }

        if (this.syncInProgress) {
            return 'skipped';
        }
        this.syncInProgress = true;
        this.setState('syncing');
        try {
            const remote = await this.fetchRemote(token);
            const lastSyncedVersion = this.getLastSyncedVersion();
            // The in-memory dirty flag does not survive a window reload; a
            // never-synced workspace with content must still offer a first
            // push, hence the version-0 fallback.
            const localChanged = this.localDirty || (lastSyncedVersion === 0 && this.store.list().length > 0);
            const plan = planSync({
                localChangedSinceLastSync: localChanged,
                lastSyncedVersion,
                remoteVersion: remote.exists ? remote.version : 0,
                remoteExists: remote.exists,
            });
            getLogger().info(
                `AnnotationSyncService: plan=${plan} (lastSynced=${String(lastSyncedVersion)}, ` +
                    `remote=${remote.exists ? String(remote.version) : 'absent'}, localChanged=${String(localChanged)})`
            );

            switch (plan) {
                case 'noop': {
                    this.setState('idle');
                    if (options.interactive) {
                        vscode.window.showInformationMessage(loc('syncUpToDate', 'Annotations are already in sync.'));
                    }
                    return 'noop';
                }
                case 'pull': {
                    if (!remote.exists) {
                        // planSync never returns 'pull' for a missing remote; defensive.
                        this.setState('idle');
                        return 'noop';
                    }
                    await this.applyRemote(remote);
                    this.setState('idle');
                    if (options.interactive) {
                        vscode.window.showInformationMessage(
                            loc(
                                'syncPulled',
                                '{0} annotation(s) pulled from the sync server.',
                                remote.envelope.annotations.length
                            )
                        );
                    }
                    return 'pulled';
                }
                case 'push': {
                    const result = await this.pushLocal(token, remote.exists ? remote.version : 0);
                    if (!result.ok) {
                        // Lost the optimistic-concurrency race: a teammate
                        // pushed between our GET and PUT.
                        return await this.resolveConflict(token, { version: result.conflictVersion });
                    }
                    this.localDirty = false;
                    await this.recordSyncedVersion(result.version);
                    this.setState('idle');
                    if (options.interactive) {
                        vscode.window.showInformationMessage(
                            loc('syncPushed', 'Annotations pushed to the sync server (version {0}).', result.version)
                        );
                    }
                    return 'pushed';
                }
                case 'conflict': {
                    if (!remote.exists) {
                        // planSync never returns 'conflict' for a missing remote; defensive.
                        this.setState('idle');
                        return 'noop';
                    }
                    return await this.resolveConflict(token, remote);
                }
            }
        } catch (err) {
            this.setState('error');
            let message: string;
            if (err instanceof SyncAuthError) {
                message = loc(
                    'syncAuthFailed',
                    'Sync authentication failed (HTTP {0}). Check your sync token.',
                    err.status
                );
            } else if (err instanceof Error) {
                message = err.message;
            } else {
                message = String(err);
            }
            getLogger().error('AnnotationSyncService: sync failed', { error: message });
            if (options.interactive) {
                vscode.window.showErrorMessage(loc('syncFailed', 'Annotation sync failed') + `: ${message}`);
            }
            return 'failed';
        } finally {
            this.syncInProgress = false;
            this.updateStatusBar();
        }
    }

    /**
     * Non-modal conflict prompt. "Keep local" force-pushes with If-Match set
     * to the REMOTE version (so the server accepts the overwrite); "Take
     * remote" replaces the local store with the server envelope. Dismissing
     * leaves the status bar in the conflict state.
     */
    private async resolveConflict(
        token: string,
        remote: { version: number; envelope?: AnnotationStoreFileV2 }
    ): Promise<SyncOutcome> {
        this.setState('conflict');
        const keepLocal = loc('syncKeepLocal', 'Keep local (overwrite remote)');
        const takeRemote = loc('syncTakeRemote', 'Take remote');
        const choice = await vscode.window.showWarningMessage(
            loc('syncConflict', 'Annotations changed both locally and on the sync server since the last sync.'),
            keepLocal,
            takeRemote
        );
        if (choice === keepLocal) {
            const result = await this.pushLocal(token, remote.version);
            if (!result.ok) {
                // Remote moved again while the prompt was open — stay in
                // conflict; the next syncNow() re-evaluates from scratch.
                this.setState('conflict');
                return 'conflict-pending';
            }
            this.localDirty = false;
            await this.recordSyncedVersion(result.version);
            this.setState('idle');
            return 'pushed';
        }
        if (choice === takeRemote) {
            let state: RemoteAnnotationsState | null = remote.envelope
                ? { version: remote.version, envelope: remote.envelope }
                : null;
            if (!state) {
                // 409 path carries only {version}; re-GET for the envelope.
                const fresh = await this.fetchRemote(token);
                if (!fresh.exists) {
                    this.setState('idle');
                    return 'noop';
                }
                state = { version: fresh.version, envelope: fresh.envelope };
            }
            await this.applyRemote(state);
            this.setState('idle');
            return 'pulled';
        }
        return 'conflict-pending';
    }

    /** Replace the local store with the remote envelope and persist it. */
    private async applyRemote(state: RemoteAnnotationsState): Promise<void> {
        this.applyingRemote = true;
        try {
            this.store.deserialize(state.envelope);
            await this.persistence.save(this.store.serialize());
            // Refresh every store consumer (tree, decorations mirror,
            // CodeLens) off the regular change event.
            this.store.notifyChanged();
        } finally {
            this.applyingRemote = false;
        }
        this.localDirty = false;
        await this.recordSyncedVersion(state.version);
    }

    // ── HTTP ─────────────────────────────────────────────────────────────

    private endpointUrl(): string {
        const { serverUrl, workspaceId } = this.getConfig();
        return `${serverUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/annotations`;
    }

    private async fetchWithTimeout(init: {
        method: 'GET' | 'PUT';
        token: string;
        ifMatch?: string;
        body?: string;
    }): Promise<Response> {
        // AbortController is polyfilled before any other import (src/extension.ts).
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const headers: Record<string, string> = { Authorization: `Bearer ${init.token}` };
            if (init.ifMatch !== undefined) {
                headers['If-Match'] = init.ifMatch;
            }
            if (init.body !== undefined) {
                headers['Content-Type'] = 'application/json';
            }
            return await globalThis.fetch(this.endpointUrl(), {
                method: init.method,
                headers,
                body: init.body,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    private async fetchRemote(token: string): Promise<{ exists: false } | ({ exists: true } & RemoteAnnotationsState)> {
        const response = await this.fetchWithTimeout({ method: 'GET', token });
        if (response.status === 404) {
            return { exists: false };
        }
        if (response.status === 401 || response.status === 403) {
            throw new SyncAuthError(response.status);
        }
        if (!response.ok) {
            throw new Error(`sync server responded with HTTP ${response.status}`);
        }
        const parsed = parseRemoteAnnotationsResponse((await response.json()) as unknown);
        if (!parsed) {
            throw new Error('sync server returned an unexpected payload');
        }
        return { exists: true, ...parsed };
    }

    private async pushLocal(
        token: string,
        ifMatchVersion: number
    ): Promise<{ ok: true; version: number } | { ok: false; conflictVersion: number }> {
        const body = JSON.stringify(this.store.serialize());
        const response = await this.fetchWithTimeout({
            method: 'PUT',
            token,
            ifMatch: String(ifMatchVersion),
            body,
        });
        if (response.status === 409) {
            const conflictVersion = parseVersionPayload((await response.json()) as unknown);
            if (conflictVersion === null) {
                throw new Error('sync server returned an unexpected conflict payload');
            }
            return { ok: false, conflictVersion };
        }
        if (response.status === 401 || response.status === 403) {
            throw new SyncAuthError(response.status);
        }
        if (!response.ok) {
            throw new Error(`sync server responded with HTTP ${response.status}`);
        }
        const version = parseVersionPayload((await response.json()) as unknown);
        if (version === null) {
            throw new Error('sync server returned an unexpected payload');
        }
        return { ok: true, version };
    }

    // ── Status bar ───────────────────────────────────────────────────────

    private setState(state: SyncState): void {
        this.state = state;
        this.updateStatusBar();
    }

    /** Hidden while `annotation.sync.serverUrl` is empty; click runs syncNow. */
    private updateStatusBar(): void {
        if (this.getConfig().serverUrl.length === 0) {
            this.statusBarItem.hide();
            return;
        }
        const stateLabels: Record<SyncState, string> = {
            idle: loc('syncStateIdle', 'Idle'),
            syncing: loc('syncStateSyncing', 'Syncing…'),
            error: loc('syncStateError', 'Error'),
            conflict: loc('syncStateConflict', 'Conflict'),
        };
        const stateText: Record<SyncState, string> = {
            idle: '$(cloud)',
            syncing: '$(cloud) $(sync~spin)',
            error: '$(cloud) $(error)',
            conflict: '$(cloud) $(warning)',
        };
        this.statusBarItem.text = stateText[this.state];

        const lastSyncAt = this.context.workspaceState.get<string>(SYNC_LAST_AT_KEY);
        const lastSyncLabel = lastSyncAt ? new Date(lastSyncAt).toLocaleString() : loc('syncNever', 'never');
        this.statusBarItem.tooltip =
            loc('syncTooltip', 'Annotation sync: {0}', stateLabels[this.state]) +
            '\n' +
            loc('syncLastSync', 'Last sync: {0}', lastSyncLabel);

        if (this.state === 'error') {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (this.state === 'conflict') {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }
        this.statusBarItem.show();
    }

    dispose(): void {
        this.autoPush.cancel();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
        this.statusBarItem.dispose();
    }
}
