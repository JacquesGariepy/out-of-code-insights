// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { encodeSourceComment, scanSourceComments } from '../../../comments/sourceCommentCodec';
import {
    encodedSourceCommentRoundTripsAnnotation,
    sourceCommentsRoundTripAnnotations,
} from '../../../comments/sourceCommentRoundTrip';

suite('Source comment destructive round-trip guard', () => {
    test('accepts an exact strongly identified line-comment representation', () => {
        const annotation = { id: 'annotation-one', message: 'First line\n    indented detail' };
        const encoded = encodeSourceComment(annotation.message, 'typescript', {
            annotationId: annotation.id,
            style: 'line',
        });

        assert.strictEqual(encodedSourceCommentRoundTripsAnnotation(encoded, 'typescript', annotation), true);
        assert.strictEqual(
            sourceCommentsRoundTripAnnotations(scanSourceComments(encoded, 'typescript'), [annotation]),
            true
        );
    });

    test('rejects significant edge whitespace before any destructive move', () => {
        const annotation = { id: 'annotation-spaces', message: '  significant text  ' };
        const encoded = encodeSourceComment(annotation.message, 'typescript', {
            annotationId: annotation.id,
            style: 'line',
        });

        assert.strictEqual(encodedSourceCommentRoundTripsAnnotation(encoded, 'typescript', annotation), false);
    });

    test('rejects block terminator neutralization before deleting the annotation', () => {
        const annotation = { id: 'annotation-css', message: 'Keep */ exactly' };
        const encoded = encodeSourceComment(annotation.message, 'css', {
            annotationId: annotation.id,
            style: 'block',
        });

        assert.match(encoded, /Keep \* \/ exactly/);
        assert.strictEqual(encodedSourceCommentRoundTripsAnnotation(encoded, 'css', annotation), false);
    });

    test('rejects legacy or wrong-id markers for destructive verification', () => {
        const annotation = { id: 'annotation-one', message: 'Same message' };
        const collidingId = 'annotation-two';
        const wrongIdComment = encodeSourceComment(annotation.message, 'typescript', {
            annotationId: collidingId,
        });
        const records = scanSourceComments(`${wrongIdComment}\n// OOCI(annotati) Same message`, 'typescript');

        assert.strictEqual(sourceCommentsRoundTripAnnotations(records, [annotation]), false);
    });

    test('detects a save participant that changes the generated message', () => {
        const annotation = { id: 'annotation-save', message: 'Exact message' };
        const encoded = encodeSourceComment('Changed message', 'typescript', {
            annotationId: annotation.id,
        });

        assert.strictEqual(
            sourceCommentsRoundTripAnnotations(scanSourceComments(encoded, 'typescript'), [annotation]),
            false
        );
    });
});
