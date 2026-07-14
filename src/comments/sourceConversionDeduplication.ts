// SPDX-License-Identifier: MPL-2.0

export interface SourceCommentCandidateRecord<T> {
    readonly value: T;
    readonly importTag: string | undefined;
    readonly annotationIdFragment: string | undefined;
    readonly annotationIdFingerprint: string | undefined;
    readonly startLine: number;
    readonly endLine: number;
    readonly message: string;
}

export interface ExistingSourceCommentAnnotation {
    readonly idFragment: string;
    readonly idFingerprint: string;
    readonly line: number;
    readonly message: string;
    readonly tags: ReadonlySet<string>;
}

/**
 * Return records that do not yet have an annotation representation.
 *
 * Matching is deliberately bijective: one existing annotation can suppress
 * only one source record. Exact import provenance is reserved first, then
 * generated identity markers, and finally the legacy line/message fallback.
 * This keeps two equal comments on the same line independently selectable.
 */
export function unrepresentedSourceCommentRecords<T>(
    records: readonly SourceCommentCandidateRecord<T>[],
    existing: readonly ExistingSourceCommentAnnotation[]
): T[] {
    const availableAnnotations = new Set(existing.map((_, index) => index));
    const representedRecords = new Set<number>();

    const consume = (recordIndex: number, predicate: (annotation: ExistingSourceCommentAnnotation) => boolean) => {
        for (const annotationIndex of availableAnnotations) {
            if (!predicate(existing[annotationIndex])) {
                continue;
            }
            availableAnnotations.delete(annotationIndex);
            representedRecords.add(recordIndex);
            return true;
        }
        return false;
    };

    // Reserve exact modern provenance before a legacy fallback can consume it.
    records.forEach((record, index) => {
        if (record.importTag) {
            consume(index, (annotation) => annotation.tags.has(record.importTag as string));
        }
    });

    records.forEach((record, index) => {
        if (representedRecords.has(index) || !record.annotationIdFingerprint) {
            return;
        }
        consume(
            index,
            (annotation) =>
                annotation.idFingerprint === record.annotationIdFingerprint &&
                annotation.idFragment === record.annotationIdFragment
        );
    });

    records.forEach((record, index) => {
        if (representedRecords.has(index) || !record.annotationIdFragment) {
            return;
        }
        // A current marker's fingerprint is authoritative. Never degrade a
        // failed strong match to the collision-prone legacy prefix.
        if (record.annotationIdFingerprint) {
            return;
        }
        const matching = [...availableAnnotations].filter(
            (annotationIndex) => existing[annotationIndex].idFragment === record.annotationIdFragment
        );
        const exactMessage = matching.find((annotationIndex) => existing[annotationIndex].message === record.message);
        if (exactMessage !== undefined) {
            availableAnnotations.delete(exactMessage);
            representedRecords.add(index);
        } else if (matching.length === 1) {
            // A unique identity marker remains authoritative if its source
            // message was edited after materialization.
            availableAnnotations.delete(matching[0]);
            representedRecords.add(index);
        }
    });

    records.forEach((record, index) => {
        if (representedRecords.has(index) || record.annotationIdFingerprint) {
            return;
        }
        consume(
            index,
            (annotation) =>
                annotation.line >= record.startLine &&
                annotation.line <= record.endLine &&
                annotation.message === record.message
        );
    });

    return records.filter((_, index) => !representedRecords.has(index)).map((record) => record.value);
}
