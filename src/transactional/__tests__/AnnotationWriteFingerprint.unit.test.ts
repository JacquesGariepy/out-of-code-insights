// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import { AnnotationWriteFingerprintTracker, annotationEnvelopeFingerprint } from '../AnnotationWriteFingerprint';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2, type AnnotationV2 } from '../types';

function annotation(id: string, message: string): AnnotationV2 {
    return {
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        id,
        fileUri: 'file:///workspace/example.ts',
        file: 'example.ts',
        startOffset: 0,
        endOffset: 5,
        lineHash: 'line-hash',
        contextBefore: [],
        contextAfter: [],
        state: 'active',
        origin: { kind: 'manual' },
        message,
        timestamp: '2026-07-13T12:00:00.000Z',
    };
}

function envelope(...annotations: AnnotationV2[]): AnnotationStoreFileV2 {
    return { schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations };
}

suite('AnnotationWriteFingerprintTracker', () => {
    test('canonicalizes object property order without erasing meaningful changes', () => {
        const first = envelope(annotation('a', 'first'));
        const reordered = {
            annotations: first.annotations.map(
                (entry) => Object.fromEntries(Object.entries(entry).reverse()) as unknown as AnnotationV2
            ),
            schemaVersion: first.schemaVersion,
        } as AnnotationStoreFileV2;
        const changed = envelope(annotation('a', 'changed externally'));

        assert.strictEqual(annotationEnvelopeFingerprint(first), annotationEnvelopeFingerprint(reordered));
        assert.notStrictEqual(annotationEnvelopeFingerprint(first), annotationEnvelopeFingerprint(changed));
    });

    test('recognizes an event racing an in-flight save and forgets a failed write', () => {
        const tracker = new AnnotationWriteFingerprintTracker();
        const payload = envelope(annotation('a', 'pending'));
        const ticket = tracker.begin(payload);

        assert.strictEqual(tracker.isInternalEcho(payload), true);
        tracker.fail(ticket);
        assert.strictEqual(tracker.isInternalEcho(payload), false);
    });

    test('keeps only the latest committed save eligible as a delayed echo', () => {
        const tracker = new AnnotationWriteFingerprintTracker();
        const first = envelope(annotation('a', 'first'));
        const second = envelope(annotation('a', 'second'));

        tracker.commit(tracker.begin(first));
        tracker.commit(tracker.begin(second));

        assert.strictEqual(tracker.isInternalEcho(second), true);
        assert.strictEqual(tracker.isInternalEcho(first), false);
    });

    test('a real external change invalidates the self-write marker', () => {
        const tracker = new AnnotationWriteFingerprintTracker();
        const local = envelope(annotation('a', 'local'));
        const external = envelope(annotation('a', 'external'));

        tracker.commit(tracker.begin(local));
        assert.strictEqual(tracker.isInternalEcho(external), false);
        tracker.observeExternal(external);

        assert.strictEqual(
            tracker.isInternalEcho(local),
            false,
            'a later external rollback to the old local payload must not be suppressed'
        );
    });
});
