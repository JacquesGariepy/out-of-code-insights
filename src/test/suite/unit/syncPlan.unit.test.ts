/**
 * Pure-logic tests for the cloud sync decision module (push/pull/conflict
 * planning and protocol payload parsing). No vscode dependency — runs in
 * the fast `test:unit` pass.
 */
import * as assert from 'assert';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2 } from '../../../transactional/types';
import {
    parseRemoteAnnotationsResponse,
    parseVersionPayload,
    planSync,
    type SyncPlanInput,
} from '../../../sync/syncPlan';

function input(overrides: Partial<SyncPlanInput> = {}): SyncPlanInput {
    return {
        localChangedSinceLastSync: false,
        lastSyncedVersion: 0,
        remoteVersion: 0,
        remoteExists: true,
        ...overrides,
    };
}

const EMPTY_ENVELOPE: AnnotationStoreFileV2 = { schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: [] };

suite('syncPlan — planSync', () => {
    test('remote missing + local changed → push (first publication)', () => {
        assert.strictEqual(
            planSync(input({ remoteExists: false, localChangedSinceLastSync: true, lastSyncedVersion: 0 })),
            'push'
        );
    });

    test('remote missing + local clean → noop', () => {
        assert.strictEqual(planSync(input({ remoteExists: false, localChangedSinceLastSync: false })), 'noop');
    });

    test('remote missing ignores remoteVersion entirely', () => {
        assert.strictEqual(
            planSync(input({ remoteExists: false, remoteVersion: 42, localChangedSinceLastSync: false })),
            'noop'
        );
    });

    test('remote at the last-synced version + local clean → noop', () => {
        assert.strictEqual(
            planSync(input({ lastSyncedVersion: 7, remoteVersion: 7, localChangedSinceLastSync: false })),
            'noop'
        );
    });

    test('remote at the last-synced version + local changed → push', () => {
        assert.strictEqual(
            planSync(input({ lastSyncedVersion: 7, remoteVersion: 7, localChangedSinceLastSync: true })),
            'push'
        );
    });

    test('remote advanced + local clean → pull', () => {
        assert.strictEqual(
            planSync(input({ lastSyncedVersion: 7, remoteVersion: 9, localChangedSinceLastSync: false })),
            'pull'
        );
    });

    test('remote advanced + local changed → conflict', () => {
        assert.strictEqual(
            planSync(input({ lastSyncedVersion: 7, remoteVersion: 9, localChangedSinceLastSync: true })),
            'conflict'
        );
    });

    test('never synced (version 0) against an existing remote + local clean → pull', () => {
        assert.strictEqual(
            planSync(input({ lastSyncedVersion: 0, remoteVersion: 3, localChangedSinceLastSync: false })),
            'pull'
        );
    });

    test('never synced against an existing remote + local changed → conflict', () => {
        assert.strictEqual(
            planSync(input({ lastSyncedVersion: 0, remoteVersion: 3, localChangedSinceLastSync: true })),
            'conflict'
        );
    });
});

suite('syncPlan — parseVersionPayload', () => {
    test('accepts the documented {version} shape, including 0', () => {
        assert.strictEqual(parseVersionPayload({ version: 12 }), 12);
        assert.strictEqual(parseVersionPayload({ version: 0 }), 0);
    });

    test('rejects non-objects', () => {
        assert.strictEqual(parseVersionPayload(null), null);
        assert.strictEqual(parseVersionPayload(undefined), null);
        assert.strictEqual(parseVersionPayload(3), null);
        assert.strictEqual(parseVersionPayload('{"version":3}'), null);
    });

    test('rejects missing, negative, fractional or non-numeric versions', () => {
        assert.strictEqual(parseVersionPayload({}), null);
        assert.strictEqual(parseVersionPayload({ version: -1 }), null);
        assert.strictEqual(parseVersionPayload({ version: 1.5 }), null);
        assert.strictEqual(parseVersionPayload({ version: '3' }), null);
        assert.strictEqual(parseVersionPayload({ version: Number.NaN }), null);
    });
});

suite('syncPlan — parseRemoteAnnotationsResponse', () => {
    test('accepts the documented {version, envelope} shape', () => {
        const parsed = parseRemoteAnnotationsResponse({ version: 4, envelope: EMPTY_ENVELOPE });
        assert.ok(parsed);
        assert.strictEqual(parsed.version, 4);
        assert.deepStrictEqual(parsed.envelope, EMPTY_ENVELOPE);
    });

    test('rejects non-objects and missing parts', () => {
        assert.strictEqual(parseRemoteAnnotationsResponse(null), null);
        assert.strictEqual(parseRemoteAnnotationsResponse('payload'), null);
        assert.strictEqual(parseRemoteAnnotationsResponse({ version: 4 }), null);
        assert.strictEqual(parseRemoteAnnotationsResponse({ envelope: EMPTY_ENVELOPE }), null);
    });

    test('rejects an invalid version even with a valid envelope', () => {
        assert.strictEqual(parseRemoteAnnotationsResponse({ version: -2, envelope: EMPTY_ENVELOPE }), null);
        assert.strictEqual(parseRemoteAnnotationsResponse({ version: '4', envelope: EMPTY_ENVELOPE }), null);
    });

    test('rejects envelopes that are not schema v2', () => {
        assert.strictEqual(
            parseRemoteAnnotationsResponse({ version: 4, envelope: { schemaVersion: 1, annotations: [] } }),
            null
        );
        assert.strictEqual(
            parseRemoteAnnotationsResponse({ version: 4, envelope: { schemaVersion: 2, annotations: 'nope' } }),
            null
        );
        assert.strictEqual(parseRemoteAnnotationsResponse({ version: 4, envelope: [] }), null);
        assert.strictEqual(parseRemoteAnnotationsResponse({ version: 4, envelope: null }), null);
    });
});
