// SPDX-License-Identifier: MPL-2.0

import { scanSourceComments, sourceCommentRoundTripsAnnotation, type SourceCommentRecord } from './sourceCommentCodec';

export interface SourceCommentAnnotationIdentity {
    readonly id: string;
    readonly message: string;
}

/**
 * Preflight an encoded comment before any WorkspaceEdit is applied. Destructive
 * conversion is allowed only when the scanner recovers the exact annotation id
 * and message, including significant leading/trailing whitespace.
 */
export function encodedSourceCommentRoundTripsAnnotation(
    encodedComment: string,
    languageId: string,
    annotation: SourceCommentAnnotationIdentity
): boolean {
    return scanSourceComments(encodedComment, languageId).some((record) =>
        sourceCommentRoundTripsAnnotation(record, annotation.id, annotation.message)
    );
}

/** Verify the source after save before any annotation is removed. */
export function sourceCommentsRoundTripAnnotations(
    records: readonly SourceCommentRecord[],
    annotations: readonly SourceCommentAnnotationIdentity[]
): boolean {
    return annotations.every((annotation) =>
        records.some((record) => sourceCommentRoundTripsAnnotation(record, annotation.id, annotation.message))
    );
}
