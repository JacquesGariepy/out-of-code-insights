// SPDX-License-Identifier: MPL-2.0
//
// Pure decision logic for the cloud annotation sync client. No vscode
// dependency — the fast `test:unit` pass exercises it directly
// (src/test/suite/unit/syncPlan.unit.test.ts). All protocol-shape parsing
// and the push/pull/conflict decision live here so AnnotationSyncService
// stays a thin I/O shell.
//
// Protocol (license server `/v1/workspaces` API):
//   GET <serverUrl>/v1/workspaces/<id>/annotations
//       Authorization: Bearer <token>
//       → 200 {version, envelope} | 404 (never pushed) | 401/403
//   PUT same URL, If-Match: <version> (0 on first push), v2 envelope body
//       → 200 {version} | 409 {version} (lost race) | 401/403

import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2 } from '../transactional/types';

/** Action chosen by {@link planSync} for one sync round-trip. */
export type SyncAction = 'push' | 'pull' | 'conflict' | 'noop';

/** Inputs to {@link planSync} — gathered by the service before deciding. */
export interface SyncPlanInput {
    /** True when the local store mutated since the last successful sync. */
    localChangedSinceLastSync: boolean;
    /** Remote version recorded after the last successful sync (0 = never synced). */
    lastSyncedVersion: number;
    /** Current remote version. Ignored when {@link remoteExists} is false. */
    remoteVersion: number;
    /** False when the server answered 404 (workspace never pushed). */
    remoteExists: boolean;
}

/**
 * Decide what one sync round-trip should do.
 *
 * Decision table:
 *  - remote missing (404): `push` when local changed, `noop` otherwise.
 *  - remote at the version we last synced: `push` when local changed,
 *    `noop` otherwise.
 *  - remote moved past our last sync: `pull` when local is clean,
 *    `conflict` when both sides changed.
 */
export function planSync(input: SyncPlanInput): SyncAction {
    if (!input.remoteExists) {
        return input.localChangedSinceLastSync ? 'push' : 'noop';
    }
    const remoteAdvanced = input.remoteVersion !== input.lastSyncedVersion;
    if (remoteAdvanced && input.localChangedSinceLastSync) {
        return 'conflict';
    }
    if (remoteAdvanced) {
        return 'pull';
    }
    return input.localChangedSinceLastSync ? 'push' : 'noop';
}

/** Parsed body of a successful GET — current remote version + v2 envelope. */
export interface RemoteAnnotationsState {
    version: number;
    envelope: AnnotationStoreFileV2;
}

/** Versions are non-negative integers assigned by the server (0 = unborn). */
function isValidVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Parse a `{version}` body (PUT 200 and PUT 409 both use this shape).
 * Returns null on any unexpected payload — the caller surfaces the error.
 */
export function parseVersionPayload(payload: unknown): number | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const version = (payload as { version?: unknown }).version;
    return isValidVersion(version) ? version : null;
}

/**
 * Parse a `{version, envelope}` GET body. The envelope must be a v2
 * annotations envelope (`schemaVersion === 2`, `annotations` array) —
 * anything else returns null so the service never feeds a malformed
 * payload into `AnnotationStore.deserialize()`.
 */
export function parseRemoteAnnotationsResponse(payload: unknown): RemoteAnnotationsState | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const { version, envelope } = payload as { version?: unknown; envelope?: unknown };
    if (!isValidVersion(version)) {
        return null;
    }
    if (typeof envelope !== 'object' || envelope === null) {
        return null;
    }
    const env = envelope as { schemaVersion?: unknown; annotations?: unknown };
    if (env.schemaVersion !== ANNOTATION_SCHEMA_VERSION || !Array.isArray(env.annotations)) {
        return null;
    }
    return { version, envelope: envelope as AnnotationStoreFileV2 };
}
