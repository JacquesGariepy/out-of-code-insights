// SPDX-License-Identifier: MPL-2.0
//
// Structural mirror of the schema-v2 annotation types from
// ../../src/transactional/types.ts. Mirrored (not imported) because the
// source module transitively pulls in vscode-nls through src/common/types,
// which must not be loaded outside the extension host. Keep both files in
// sync whenever the on-disk schema changes.

/** Format version literal — must match the extension's envelope version. */
export const ANNOTATION_SCHEMA_VERSION = 2 as const;

/** Lifecycle state of an annotation inside the store. */
export type AnnotationLifecycle = 'active' | 'suspended' | 'disposed';

/** Provenance of an annotation. Mandatory at creation time. */
export interface AnnotationOrigin {
    kind: 'manual' | 'paste' | 'restore';
    sourceOpId?: string;
}

export interface LinkedAnnotation {
    targetFile: string;
    /** 0-based line in the target file. */
    targetLine: number;
    relationship: string;
}

export interface CommentEntry {
    id: string;
    message: string;
    author?: string;
    timestamp: string;
}

export interface ReviewState {
    viewed: boolean;
    viewedBy: string;
    viewedAt: string;
}

/** Persistent annotation record (schema v2). */
export interface AnnotationV2 {
    /** RFC4122 v4 UUID — generated at creation, never mutated. */
    id: string;
    /** Format discriminator. Always === 2 for this version. */
    schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;

    /** Document URI string (vscode.Uri.toString() format). */
    fileUri: string;
    /** Display path relative to the workspace root. */
    file: string;
    /** Inclusive UTF-16 code-unit offset to the start of the anchored range. */
    startOffset: number;
    /** Exclusive UTF-16 code-unit offset to the end of the anchored range. */
    endOffset: number;

    /** FNV-1a hash of the normalized line at startOffset. */
    lineHash: string;
    /** Up to 3 normalized lines preceding the anchor line. */
    contextBefore: string[];
    /** Up to 3 normalized lines following the anchor line. */
    contextAfter: string[];

    state: AnnotationLifecycle;
    origin: AnnotationOrigin;

    message: string;
    author?: string;
    /** ISO-8601 creation timestamp. */
    timestamp: string;
    thread?: CommentEntry[];
    tags?: string[];
    pinned?: boolean;
    priority?: number;
    severity?: string;
    resolved?: boolean;
    linkedAnnotations?: LinkedAnnotation[];
    template?: string;
    reviewState?: ReviewState;
    kanbanColumn?: string;
    snippet?: { code: string; language: string };
    languageId?: string;
}

/** Stored JSON envelope (schema v2). */
export interface AnnotationEnvelope {
    schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;
    annotations: AnnotationV2[];
}
