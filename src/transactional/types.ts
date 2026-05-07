// SPDX-License-Identifier: MPL-2.0
import type { Comment, LinkedAnnotation, ReviewState } from '../common/types';

/** Format version literal — bump iff the on-disk schema changes. */
export const ANNOTATION_SCHEMA_VERSION = 2 as const;

/**
 * Lifecycle state of an annotation inside the store.
 *
 * - `active`    : tracked against a live offset range in its document.
 * - `suspended` : the underlying text has been removed (cut) and the
 *                 annotation is parked in the cut/copy buffer awaiting
 *                 a matching paste or TTL expiry.
 * - `disposed`  : terminal state. Removed by user or TTL-expired suspension.
 *                 Kept transiently in the journal for undo replay only.
 */
export type AnnotationLifecycle = 'active' | 'suspended' | 'disposed';

/**
 * Provenance of an annotation. Mandatory at creation time, never inferred.
 *
 * - `manual`  : created by user action (UI command, gesture).
 * - `paste`   : created by paste-after-copy or paste-after-cut. `sourceOpId`
 *               points back to the OpEntry that produced it (origin chain).
 * - `restore` : created by mirrorUndo replay of a prior `disposed` state.
 */
export interface AnnotationOrigin {
    kind: 'manual' | 'paste' | 'restore';
    /** OpEntry.opId of the operation that spawned this annotation. */
    sourceOpId?: string;
}

/**
 * Persistent annotation record (schema v2). Replaces `Annotation` from
 * src/common/types.ts. Offsets are the authoritative anchor; line/context
 * are redundant fallbacks for external edits and human readability.
 *
 * INVARIANTS (validated by AnnotationStore.validate()):
 *   - id is RFC4122 v4 UUID, globally unique across the store.
 *   - 0 <= startOffset <= endOffset (zero-width allowed for caret anchors).
 *   - schemaVersion === ANNOTATION_SCHEMA_VERSION.
 *   - state === 'suspended' iff annotation is present in the cut buffer.
 *   - origin is always set.
 */
export interface AnnotationV2 {
    /** RFC4122 v4 UUID — generated at creation, never mutated. */
    id: string;

    /** Format discriminator. Always === 2 for this version. */
    schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;

    // ── Anchoring (authoritative) ────────────────────────────────────────
    /** Document URI string (vscode.Uri.toString()). Authoritative scope. */
    fileUri: string;
    /** Display path relative to workspace root. Display-only metadata. */
    file: string;
    /** Inclusive UTF-16 code-unit offset to the start of the anchored range. */
    startOffset: number;
    /** Exclusive UTF-16 code-unit offset to the end of the anchored range. */
    endOffset: number;

    // ── Anchoring (redundant fallback for external edits) ────────────────
    /** FNV-1a hash of the normalized line at startOffset. */
    lineHash: string;
    /** Up to 3 normalized lines preceding the anchor line. */
    contextBefore: string[];
    /** Up to 3 normalized lines following the anchor line. */
    contextAfter: string[];

    // ── Lifecycle ────────────────────────────────────────────────────────
    state: AnnotationLifecycle;
    origin: AnnotationOrigin;

    // ── Business fields (preserved from src/common/types.ts) ─────────────
    /** Annotation body. */
    message: string;
    /** Author handle. */
    author?: string;
    /** ISO-8601 creation timestamp. */
    timestamp: string;
    /** Threaded discussion. */
    thread?: Comment[];
    /** Free-form tags. */
    tags?: string[];
    /** Sticky to top of list. */
    pinned?: boolean;
    /** Numeric priority. */
    priority?: number;
    /** Severity label (info|warn|error|...). */
    severity?: string;
    /** Resolution flag. */
    resolved?: boolean;
    /** Cross-file links. */
    linkedAnnotations?: LinkedAnnotation[];
    /** Template id used at creation. */
    template?: string;
    /** Review state record. */
    reviewState?: ReviewState;
    /** Kanban column id. */
    kanbanColumn?: string;
    /** Code snippet captured at creation. */
    snippet?: { code: string; language: string };
    /** Document language id at creation. */
    languageId?: string;
}

/** Discriminator for journal entries. */
export type OpKind = 'add' | 'remove' | 'update' | 'upsert' | 'suspend' | 'resume';

/**
 * Subset of OpKind that can appear as an inverse. `upsert` is excluded:
 * the inverse of an upsert is always either `remove` (when the upsert
 * inserted a new annotation) or `update` (when it overwrote an existing
 * one), never `upsert` itself.
 */
export type InverseOpKind = Exclude<OpKind, 'upsert'>;

/**
 * Inverse operation that exactly undoes an OpEntry. Stored at journaling
 * time so mirrorUndo() can replay without re-deriving the inverse.
 */
export interface InverseOp {
    kind: InverseOpKind;
    /** Snapshot of the previous AnnotationV2 state, or null for `add`. */
    previous?: Readonly<AnnotationV2>;
    /** New state to restore — used by `update`/`suspend`/`resume`. */
    next?: Readonly<AnnotationV2>;
    /** Annotation id targeted by the inverse. */
    annotationId: string;
}

/**
 * Journal entry. The journal is an append-only list of OpEntry instances.
 * Entries are NEVER mutated post-commit. Immutable shape allows safe
 * sharing between the journal, mirrorUndo replay, and serialization.
 */
export interface OpEntry {
    /** RFC4122 v4 UUID for the operation. */
    opId: string;
    /** ISO-8601 timestamp at which the op was committed. */
    timestamp: string;
    /** Op discriminator. */
    kind: OpKind;
    /** Annotation id touched by the op. */
    annotationId: string;
    /** Snapshot of the annotation BEFORE the op (null for `add`). */
    before: Readonly<AnnotationV2> | null;
    /** Snapshot of the annotation AFTER the op (null for `remove`). */
    after: Readonly<AnnotationV2> | null;
    /** Inverse op pre-computed at commit time. */
    inverse: InverseOp;
    /**
     * vscode.TextDocument.version observed at op time. Used to align
     * mirrorUndo replay with the editor's own undo cursor.
     */
    documentVersionAtOp: number;
    /**
     * fileUri scope of the op. Mirrored from the annotation's fileUri at
     * journaling time so suspended/disposed annotations remain routable.
     */
    fileUri: string;
    /**
     * Identifier shared by all OpEntry committed in the same transaction
     * (`beginTransaction()` ... `commit()`). Implicit single-op mutations
     * receive a fresh `transactionId` per op. mirrorUndo/Redo group by
     * this id to atomically undo/redo a whole batch.
     */
    transactionId: string;
}

/**
 * Cyclic buffer of recent OpEntry. Bounded length avoids unbounded growth
 * across long sessions; the buffer is reset on workspace reload.
 */
export interface JournalSnapshot {
    capacity: number;
    /** Newest at tail, oldest at head. */
    entries: ReadonlyArray<OpEntry>;
    /** Index (within entries) of the next entry that mirrorUndo would target. */
    cursor: number;
}

/** Suspended-annotation buffer entry indexed by content hash of the cut block. */
export interface SuspendedEntry {
    annotation: Readonly<AnnotationV2>;
    /** Hash of the cut text. Acts as the resume key. */
    blockHash: string;
    /** Wall-clock ms epoch at which suspension started. */
    suspendedAt: number;
    /** opId of the suspend op (links back into the journal). */
    suspendOpId: string;
}

/** Reanchor outcome categories used by the legacy fallback path. */
export type ReanchorStatus = 'matched' | 'moved' | 'orphan';

/** Result of validate(). */
export interface ViolationReport {
    code:
        | 'duplicate-id'
        | 'invalid-offset-range'
        | 'invalid-schema-version'
        | 'orphan-suspended'
        | 'state-mismatch'
        | 'missing-anchor';
    annotationId?: string;
    detail: string;
}

export interface ValidationResult {
    valid: boolean;
    violations: ViolationReport[];
}

/** Stored JSON envelope (schema v2). */
export interface AnnotationStoreFileV2 {
    schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;
    annotations: AnnotationV2[];
}
