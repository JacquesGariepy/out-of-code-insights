// SPDX-License-Identifier: MPL-2.0
//
// Annotation store v2 — schema v2, offset-based ancrage, transactional journal,
// best-effort undo/redo mirroring, suspended buffer for cut/paste cycles.
//
// Architectural limit L1 (cf. docs/architecture/annotation-store-v2.md §0): the
// editor's own undo stack does not accept extension-side mutations. Live Undo
// and Redo document events are therefore handled as ordinary inverse/forward
// text edits; mirrorUndo and mirrorRedo remain explicit best-effort APIs for
// callers that need to replay annotation-only journal transactions.
//
// Architectural limit L2: the OS clipboard is out-of-process and cannot carry
// an internal annotation identifier. The cut/paste matching is therefore done
// via line-hash collision through the SuspendedBuffer (extension-local Map).
// TTL-bounded retention (`suspendTtlMs`) so an unmatched cut eventually
// disposes — no persistence after source-code deletion (cf. §1).
//
// Lot 4 scope additions over Lot 2: Cas D in applyDocumentChange suspends
// instead of throwing; resume restores at a new offset; auto-paste detection
// (cut+paste resumes the same id, copy+paste clones into a new id with
// origin.kind === 'paste'); TTL sweep on every event; validate I4 covers
// suspended/active state coherence.

import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import { captureAnchor, EMPTY_LINE_HASH, findAnchor, hashLine, type TextDocumentLike } from '../anchoring/anchor';
import { TypedEventEmitter } from './internal/event-emitter';
import {
    ANNOTATION_SCHEMA_VERSION,
    type AnnotationV2,
    type AnnotationStoreFileV2,
    type InverseOp,
    type JournalSnapshot,
    type OpEntry,
    type OpKind,
    type SuspendedEntry,
    type ValidationResult,
    type ViolationReport,
} from './types';

// ---------------------------------------------------------------------------
// Public option/input types
// ---------------------------------------------------------------------------

/** Options dictating where the new annotation anchors when a document is provided. */
export interface AddOptions {
    /** Document line number (0-based). */
    line?: number;
    /** Pre-computed UTF-16 offset. */
    offset?: number;
    /** Length of the anchored range. Defaults to the length of the line. */
    length?: number;
}

/** Optional patch applied by update(). Immutable fields are excluded by type. */
export type AnnotationPatch = Partial<
    Omit<AnnotationV2, 'id' | 'schemaVersion' | 'startOffset' | 'endOffset' | 'state' | 'origin'>
>;

/** Subset of AnnotationV2 accepted by `add(draft, opts, document)`. */
export type AnnotationDraft = Omit<
    AnnotationV2,
    'id' | 'schemaVersion' | 'startOffset' | 'endOffset' | 'state' | 'lineHash' | 'contextBefore' | 'contextAfter'
>;

/** Subset accepted by `add(draft)` without document — caller pre-fills anchoring. */
export type AnnotationDraftRaw = Omit<AnnotationV2, 'id' | 'schemaVersion' | 'state'>;

/** Constructor options. */
export interface AnnotationStoreOptions {
    /** Maximum number of OpEntry retained in the cyclic journal. Default: 1024. */
    journalCapacity?: number;
    /** TTL for suspended-buffer entries (ms). Default: 30 000. */
    suspendTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (no vscode runtime dep)
// ---------------------------------------------------------------------------

/** Sentinel error class for store features deferred to a later lot. */
export class NotImplementedError extends Error {
    constructor(featureName: string) {
        super(`AnnotationStore: ${featureName} not implemented yet (deferred lot)`);
        this.name = 'NotImplementedError';
    }
}

// `vscode.TextDocumentChangeReason` enum: Undo = 1.
const REASON_UNDO = 1;

/** Internal record stored in the suspended buffer. */
interface SuspendedRecord {
    annotation: AnnotationV2;
    blockHash: string;
    suspendedAt: number;
    suspendOpId: string;
}

// ---------------------------------------------------------------------------
// AnnotationStore
// ---------------------------------------------------------------------------

export class AnnotationStore {
    private readonly map = new Map<string, AnnotationV2>();
    private readonly journal: OpEntry[] = [];
    private readonly capacity: number;
    /** Mutable: `updateSuspendTtl` follows the user setting live. */
    private suspendTtlMs: number;

    /** Pending ops collected between beginTransaction/commit. */
    private activeTransaction: { ops: OpEntry[]; transactionId: string } | null = null;

    /** Undone transactions awaiting mirrorRedo. Cleared on any new mutation. */
    private readonly redoStack: OpEntry[][] = [];

    /** Suppresses redoStack-clearing while replaying ops via mirrorUndo/mirrorRedo. */
    private isMirroring = false;

    /** Suspended annotations indexed by id. */
    private readonly suspendedById = new Map<string, SuspendedRecord>();
    /** Suspended ids grouped by blockHash for paste-resume lookup. */
    private readonly suspendedByLineHash = new Map<string, Set<string>>();

    private readonly _onDidChange = new TypedEventEmitter<readonly OpEntry[]>();
    private readonly _onDidSuspend = new TypedEventEmitter<SuspendedEntry>();
    private readonly _onDidResume = new TypedEventEmitter<{
        annotationId: string;
        opId: string;
    }>();
    private readonly _onDidDispose = new TypedEventEmitter<{
        annotationId: string;
        reason: 'ttl-expired' | 'explicit';
        /** Snapshot taken at disposal time so listeners can offer recovery. */
        annotation: Readonly<AnnotationV2>;
    }>();

    readonly onDidChange = this._onDidChange.event;
    readonly onDidSuspend = this._onDidSuspend.event;
    readonly onDidResume = this._onDidResume.event;
    readonly onDidDispose = this._onDidDispose.event;

    /** Resolved on first `deserialize()` (or `markInitialized()`); never reset. */
    private readonly initializationPromise: Promise<void>;
    private initializationResolver: (() => void) | null = null;

    constructor(opts: AnnotationStoreOptions = {}) {
        this.capacity = opts.journalCapacity ?? 1024;
        this.suspendTtlMs = opts.suspendTtlMs ?? 30_000;
        this.initializationPromise = new Promise<void>((resolve) => {
            this.initializationResolver = resolve;
        });
        if (this.capacity < 1 || !Number.isInteger(this.capacity)) {
            throw new RangeError(`AnnotationStore: journalCapacity must be a positive integer (got ${this.capacity})`);
        }
        if (this.suspendTtlMs < 0 || !Number.isFinite(this.suspendTtlMs)) {
            throw new RangeError(
                `AnnotationStore: suspendTtlMs must be a non-negative finite number (got ${this.suspendTtlMs})`
            );
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    offsetToLine(offset: number, document: vscode.TextDocument): number {
        return document.positionAt(offset).line;
    }

    /**
     * Convert a 0-based line index to its starting UTF-16 offset.
     * Uses `document.lineAt(line).range.start` rather than constructing a
     * fresh `Position` object — VS Code's `_validatePosition` rejects plain
     * `{line, character}` objects with `Invalid argument`.
     */
    lineToOffset(line: number, document: vscode.TextDocument): number {
        return document.offsetAt(document.lineAt(line).range.start);
    }

    // ── add (overloaded) ─────────────────────────────────────────────────

    add(draft: AnnotationDraft, opts: AddOptions, document: vscode.TextDocument): Readonly<AnnotationV2>;
    add(draft: AnnotationDraftRaw): Readonly<AnnotationV2>;
    add(
        draftOrRaw: AnnotationDraft | AnnotationDraftRaw,
        opts?: AddOptions,
        document?: vscode.TextDocument
    ): Readonly<AnnotationV2> {
        if (document) {
            if (!opts) {
                throw new RangeError('AnnotationStore.add: opts is required when document is provided');
            }
            return this.addWithDocument(draftOrRaw as AnnotationDraft, opts, document);
        }
        return this.addRaw(draftOrRaw as AnnotationDraftRaw);
    }

    private addWithDocument(
        draft: AnnotationDraft,
        opts: AddOptions,
        document: vscode.TextDocument
    ): Readonly<AnnotationV2> {
        const hasLine = typeof opts.line === 'number';
        const hasOffset = typeof opts.offset === 'number';
        if (hasLine === hasOffset) {
            throw new RangeError(
                `AnnotationStore.add requires exactly one of {line, offset} ` +
                    `(got line=${String(opts.line)}, offset=${String(opts.offset)})`
            );
        }

        let lineIdx: number;
        let startOffset: number;
        if (hasLine) {
            lineIdx = opts.line as number;
            startOffset = this.lineToOffset(lineIdx, document);
        } else {
            startOffset = opts.offset as number;
            lineIdx = this.offsetToLine(startOffset, document);
        }

        const lineText = document.lineAt(lineIdx).text;
        const length = opts.length ?? lineText.length;
        const endOffset = startOffset + length;

        const captured = captureAnchor(document as unknown as TextDocumentLike, lineIdx, {
            walkForward: 0,
            walkBackward: 0,
        });

        const annotation: AnnotationV2 = {
            ...draft,
            id: randomUUID(),
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            startOffset,
            endOffset,
            lineHash: captured.lineHash,
            contextBefore: captured.contextBefore,
            contextAfter: captured.contextAfter,
            state: 'active',
        };

        this.map.set(annotation.id, annotation);
        const snapshot = this.freezeAnnotation(annotation);
        this.commitOrQueue(this.makeAddOp(snapshot, document.version));
        return snapshot;
    }

    private addRaw(draft: AnnotationDraftRaw): Readonly<AnnotationV2> {
        if (
            typeof draft.startOffset !== 'number' ||
            typeof draft.endOffset !== 'number' ||
            draft.startOffset < 0 ||
            draft.startOffset > draft.endOffset
        ) {
            throw new RangeError(
                `AnnotationStore.add (raw): invalid offset range ` +
                    `[${String(draft.startOffset)}, ${String(draft.endOffset)}]`
            );
        }
        if (typeof draft.lineHash !== 'string') {
            throw new RangeError('AnnotationStore.add (raw): lineHash must be a string');
        }
        if (!Array.isArray(draft.contextBefore) || !Array.isArray(draft.contextAfter)) {
            throw new RangeError('AnnotationStore.add (raw): contextBefore and contextAfter must be arrays');
        }

        const annotation: AnnotationV2 = {
            ...draft,
            id: randomUUID(),
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            state: 'active',
        };

        this.map.set(annotation.id, annotation);
        const snapshot = this.freezeAnnotation(annotation);
        this.commitOrQueue(this.makeAddOp(snapshot, 0));
        return snapshot;
    }

    private makeAddOp(snapshot: Readonly<AnnotationV2>, documentVersion: number): OpEntry {
        const inverse: InverseOp = {
            kind: 'remove',
            annotationId: snapshot.id,
            previous: snapshot,
        };
        return {
            opId: randomUUID(),
            timestamp: new Date().toISOString(),
            kind: 'add',
            annotationId: snapshot.id,
            before: null,
            after: snapshot,
            inverse,
            documentVersionAtOp: documentVersion,
            fileUri: snapshot.fileUri,
            transactionId: '',
        };
    }

    // ── remove / update ──────────────────────────────────────────────────

    remove(id: string): void {
        const active = this.map.get(id);
        if (active) {
            const before = this.freezeAnnotation(active);
            this.map.delete(id);
            this.commitOrQueue({
                opId: randomUUID(),
                timestamp: new Date().toISOString(),
                kind: 'remove',
                annotationId: id,
                before,
                after: null,
                inverse: { kind: 'add', annotationId: id, next: before },
                documentVersionAtOp: 0,
                fileUri: before.fileUri,
                transactionId: '',
            });
            return;
        }
        const suspendedRec = this.suspendedById.get(id);
        if (suspendedRec) {
            const before = this.freezeAnnotation(suspendedRec.annotation);
            this.unindexSuspended(id);
            this.commitOrQueue({
                opId: randomUUID(),
                timestamp: new Date().toISOString(),
                kind: 'remove',
                annotationId: id,
                before,
                after: null,
                inverse: { kind: 'add', annotationId: id, next: before },
                documentVersionAtOp: 0,
                fileUri: before.fileUri,
                transactionId: '',
            });
        }
        // Unknown id: idempotent no-op.
    }

    update(id: string, patch: AnnotationPatch): Readonly<AnnotationV2> {
        const target = this.map.get(id) ?? this.suspendedById.get(id)?.annotation;
        if (!target) {
            throw new Error(`AnnotationStore.update: annotation ${id} not found`);
        }
        const before = this.freezeAnnotation(target);
        Object.assign(target, patch);
        const after = this.freezeAnnotation(target);
        this.commitOrQueue({
            opId: randomUUID(),
            timestamp: new Date().toISOString(),
            kind: 'update',
            annotationId: id,
            before,
            after,
            inverse: { kind: 'update', annotationId: id, previous: before, next: after },
            documentVersionAtOp: 0,
            fileUri: after.fileUri,
            transactionId: '',
        });
        return after;
    }

    // ── Read-only accessors ──────────────────────────────────────────────

    get(id: string): Readonly<AnnotationV2> | undefined {
        const active = this.map.get(id);
        if (active) {
            return this.freezeAnnotation(active);
        }
        const suspendedRec = this.suspendedById.get(id);
        if (suspendedRec) {
            return this.freezeAnnotation(suspendedRec.annotation);
        }
        return undefined;
    }

    getAll(): ReadonlyArray<Readonly<AnnotationV2>> {
        const result: Readonly<AnnotationV2>[] = [];
        for (const a of this.map.values()) {
            result.push(this.freezeAnnotation(a));
        }
        return result;
    }

    /** All annotations whose fileUri matches. Excludes disposed (= absent from any map). */
    getByFile(fileUri: string): ReadonlyArray<Readonly<AnnotationV2>> {
        const result: Readonly<AnnotationV2>[] = [];
        for (const a of this.map.values()) {
            if (a.fileUri === fileUri) {
                result.push(this.freezeAnnotation(a));
            }
        }
        for (const rec of this.suspendedById.values()) {
            if (rec.annotation.fileUri === fileUri) {
                result.push(this.freezeAnnotation(rec.annotation));
            }
        }
        return result;
    }

    // ── Transactions ─────────────────────────────────────────────────────

    beginTransaction(): void {
        if (this.activeTransaction !== null) {
            throw new Error('AnnotationStore.beginTransaction: already inside a transaction');
        }
        this.activeTransaction = { ops: [], transactionId: randomUUID() };
    }

    commit(): void {
        const tx = this.activeTransaction;
        if (tx === null) {
            throw new Error('AnnotationStore.commit: no active transaction');
        }
        this.activeTransaction = null;
        if (tx.ops.length === 0) {
            return;
        }
        if (!this.isMirroring) {
            this.redoStack.length = 0;
        }
        for (const op of tx.ops) {
            this.appendToJournal(op);
        }
        this._onDidChange.fire(tx.ops);
    }

    rollback(): void {
        const tx = this.activeTransaction;
        if (tx === null) {
            throw new Error('AnnotationStore.rollback: no active transaction');
        }
        this.activeTransaction = null;
        for (let i = tx.ops.length - 1; i >= 0; i--) {
            this.applyInverseInPlace(tx.ops[i]);
        }
    }

    // ── applyDocumentChange — Cas A/B/C/D + paste detection + TTL sweep ──

    applyDocumentChange(event: vscode.TextDocumentChangeEvent, relativeFilePath?: string): void {
        const reason = event.reason as number | undefined;
        const isUndo = reason === REASON_UNDO;

        // 0. Sweep expired suspended entries before any other processing.
        this.sweepExpiredSuspended(Date.now());

        const docUri = event.document.uri.toString();
        // Freeze copy sources before offsets are shifted and before paste
        // clones are added. This prevents multi-cursor pastes from cloning a
        // clone created earlier in the same event and preserves co-located
        // annotations as one semantic group.
        const pasteSources = Array.from(this.map.values())
            .filter((a) => a.state === 'active')
            .map((a) => structuredClone(a));

        // 1. Per-change Cas A/B/C/D classification on active annotations.
        //
        // OFFSETS ONLY in this loop. Anchor-context refreshes are deferred to
        // step 2: refreshAnchorContext reads the POST-change document at the
        // annotation's CURRENT offset, so calling it mid-loop — before the
        // remaining changes of a multi-change event (multi-cursor edits,
        // find-and-replace-all, rename-symbol) have shifted the offsets —
        // can bind the lineHash to a neighbouring line.
        const pendingRefresh = new Set<string>();
        for (const change of event.contentChanges) {
            const r0 = change.rangeOffset;
            const r1 = change.rangeOffset + change.rangeLength;
            const delta = change.text.length - change.rangeLength;

            // Snapshot before iterating: suspend() mutates the active map.
            const annotations = Array.from(this.map.values()).filter(
                (a) => a.fileUri === docUri && a.state === 'active'
            );
            for (const ann of annotations) {
                const a0 = ann.startOffset;
                const a1 = ann.endOffset;

                // Pre-classification guard: a pure deletion that fully covers
                // the annotation must SUSPEND, not shift. Without this guard,
                // Ctrl+X on the last line of a file with no trailing newline
                // produces a range whose r1 == a1 (no '\n' to extend past),
                // which slips into Cas C (`r0 >= a0 && r1 <= a1`) and only
                // shifts endOffset -- leaving the annotation active in the
                // map with collapsed offsets. detectPaste then matches on
                // lineHash and clones it via cloneAsPaste, surfacing as
                // duplicate annotations after a single cut+paste cycle.
                if (change.text.length === 0 && r0 <= a0 && r1 >= a1) {
                    // Undoing a copy-paste removes the generated copy. It must
                    // not enter the cut buffer, otherwise redo/another paste
                    // can resurrect a ghost annotation.
                    if (isUndo && ann.origin.kind === 'paste') {
                        this.map.delete(ann.id);
                        continue;
                    }
                    this.suspend(ann.id, ann.lineHash);
                    continue;
                }

                // Sticky end boundary: a pure single-line insert flush at the
                // end of the annotated range EXTENDS it instead of falling
                // into Cas B. This is every keystroke at the end of the
                // annotated line once endOffset tracks the line end — without
                // it, endOffset desyncs from the line on the first append and
                // later edits stop registering as touching the annotation.
                // Also covers typing on an annotated blank line (a0 == a1):
                // the annotation grows over the typed text and the deferred
                // refresh upgrades EMPTY_LINE_HASH to a real content hash.
                // Newline inserts are excluded so Enter at the end of the
                // line stays Cas B (the annotation must not absorb the next
                // line).
                if (r0 === a1 && change.rangeLength === 0 && change.text.length > 0 && !change.text.includes('\n')) {
                    ann.endOffset = a1 + delta;
                    pendingRefresh.add(ann.id);
                    continue;
                }

                if (r1 <= a0) {
                    // Cas A — strictly before. Mark for refresh when the line
                    // structure changed (the annotation's line index moved)
                    // or when the change ends flush at the annotation start
                    // (typing/deleting at the start of the annotated line
                    // rewrites the line content the hash is bound to).
                    ann.startOffset = a0 + delta;
                    ann.endOffset = a1 + delta;
                    if (this.changeAffectsLineStructure(change) || r1 === a0) {
                        pendingRefresh.add(ann.id);
                    }
                } else if (r0 >= a1) {
                    // Cas B — strictly after. A replace/delete starting flush
                    // at the end (r0 == a1, e.g. deleting the trailing
                    // newline merges the next line up into the annotated
                    // line) rewrites the line content: mark for refresh.
                    if (r0 === a1) {
                        pendingRefresh.add(ann.id);
                    }
                } else if (r0 >= a0 && r1 <= a1) {
                    // Cas C — strictly inside: the annotation's own content
                    // changed; the hash must rebind to the edited text.
                    ann.endOffset = a1 + delta;
                    pendingRefresh.add(ann.id);
                } else {
                    // Cas D — boundary crossing.
                    if (isUndo && ann.origin.kind === 'paste') {
                        this.map.delete(ann.id);
                        continue;
                    }
                    //
                    // Survival check before suspend: when the change is a
                    // REPLACE (text.length > 0 AND rangeLength > 0) and the
                    // replacement text still contains a line whose hash
                    // equals ann.lineHash, the annotated line survived the
                    // edit in-place — the boundary overshoot is just the
                    // formatter rewriting indentation or appending/altering
                    // the trailing newline. Re-anchor at the surviving line
                    // rather than suspending.
                    if (change.text.length > 0 && change.rangeLength > 0) {
                        const survivor = this.findLineHashInText(change.text, ann.lineHash);
                        if (survivor !== null) {
                            const length = ann.endOffset - ann.startOffset;
                            ann.startOffset = change.rangeOffset + survivor.lineStart;
                            ann.endOffset = ann.startOffset + length;
                            pendingRefresh.add(ann.id);
                            continue;
                        }
                    }
                    // blockHash = ann.lineHash (deterministic per the
                    // pragmatic solution: paste detection re-computes the
                    // same hash on the inserted text and matches).
                    this.suspend(ann.id, ann.lineHash);
                }
            }
        }

        // 2. Deferred anchor refresh — final offsets against the final text.
        for (const id of pendingRefresh) {
            const ann = this.map.get(id);
            if (ann && ann.state === 'active') {
                this.refreshAnchorContext(ann, event.document);
            }
        }

        // 3. Detect paste-resume / paste-clone. A paste that replaces a
        // selection has rangeLength > 0, so restricting this step to pure
        // inserts loses annotations for a very common editor workflow.
        const resumedThisCall = new Set<string>();
        for (const change of event.contentChanges) {
            if (change.text.length > 0) {
                this.detectPaste(
                    change,
                    event.document,
                    resumedThisCall,
                    pasteSources,
                    !isUndo,
                    relativeFilePath
                );
            }
        }

        // 4. Rescue net: any active annotation of this file whose lineHash no
        // longer matches the line under its (final) startOffset gets one
        // conservative context-based relocation attempt. Catches event
        // shapes the per-change arithmetic mis-models (unusual editor
        // operations, extensions issuing exotic WorkspaceEdits). findAnchor
        // relocates by OLD hash + context, so a line legitimately edited in
        // place (already refreshed in step 2) never matches this predicate.
        for (const ann of this.map.values()) {
            if (ann.fileUri !== docUri || ann.state !== 'active') {
                continue;
            }
            this.tryRelocateByAnchor(ann, event.document);
        }
    }

    /**
     * Re-anchor every active annotation of `document` whose stored lineHash
     * no longer matches the line at its startOffset. Used when a document
     * (re)opens after the file changed outside the editor's edit stream:
     * git pull / branch switch / external tools rewriting the file while it
     * was closed. Relocation is conservative (hash + context voting via
     * findAnchor); annotations that cannot be confidently relocated are left
     * untouched — the render side shows them as orphaned, the data survives.
     *
     * Returns the number of annotations that moved. Fires a single empty
     * onDidChange batch when at least one moved, so the mirror and the
     * debounced persistence pick up the new offsets.
     */
    reanchorDocument(document: vscode.TextDocument): number {
        const docUri = document.uri.toString();
        let moved = 0;
        for (const ann of this.map.values()) {
            if (ann.fileUri !== docUri || ann.state !== 'active') {
                continue;
            }
            if (this.tryRelocateByAnchor(ann, document)) {
                moved++;
            }
        }
        if (moved > 0) {
            this._onDidChange.fire([]);
        }
        return moved;
    }

    /**
     * Rewrite `fileUri` (and optionally the workspace-relative `file`) of
     * every annotation — active AND suspended — that referenced `oldUri`.
     * One transaction, one onDidChange batch. Returns the number patched.
     */
    applyFileRename(oldUri: string, newUri: string, newRelativePath?: string): number {
        const activeIds: string[] = [];
        for (const ann of this.map.values()) {
            if (ann.fileUri === oldUri) {
                activeIds.push(ann.id);
            }
        }
        const suspendedIds: string[] = [];
        for (const [id, rec] of this.suspendedById) {
            if (rec.annotation.fileUri === oldUri) {
                suspendedIds.push(id);
            }
        }
        if (activeIds.length === 0 && suspendedIds.length === 0) {
            return 0;
        }
        this.beginTransaction();
        try {
            for (const id of [...activeIds, ...suspendedIds]) {
                this.update(id, newRelativePath ? { fileUri: newUri, file: newRelativePath } : { fileUri: newUri });
            }
            this.commit();
        } catch (err) {
            this.rollback();
            throw err;
        }
        return activeIds.length + suspendedIds.length;
    }

    /** Adjust the suspended-buffer TTL live (follows the user setting). */
    updateSuspendTtl(ms: number): void {
        if (ms < 0 || !Number.isFinite(ms)) {
            throw new RangeError(`AnnotationStore.updateSuspendTtl: invalid TTL ${String(ms)}`);
        }
        this.suspendTtlMs = ms;
    }

    // ── Suspended buffer (Lot 4) ─────────────────────────────────────────

    suspend(id: string, blockHash: string): void {
        if (this.suspendedById.has(id)) {
            return; // idempotent
        }
        const ann = this.map.get(id);
        if (!ann) {
            throw new Error(`AnnotationStore.suspend: annotation ${id} not found in active map`);
        }
        const before = this.freezeAnnotation(ann);
        ann.state = 'suspended';
        const after = this.freezeAnnotation(ann);
        this.map.delete(id);

        const suspendedAt = Date.now();
        const opId = randomUUID();
        const record: SuspendedRecord = {
            annotation: ann,
            blockHash,
            suspendedAt,
            suspendOpId: opId,
        };
        this.suspendedById.set(id, record);
        this.indexSuspended(id, blockHash);

        this.commitOrQueue({
            opId,
            timestamp: new Date().toISOString(),
            kind: 'suspend',
            annotationId: id,
            before,
            after,
            inverse: { kind: 'resume', annotationId: id, previous: before, next: after },
            documentVersionAtOp: 0,
            fileUri: ann.fileUri,
            transactionId: '',
        });

        this._onDidSuspend.fire({
            annotation: after,
            blockHash,
            suspendedAt,
            suspendOpId: opId,
        });
    }

    resume(
        id: string,
        document: vscode.TextDocument,
        atOffset: number,
        relativeFilePath?: string
    ): Readonly<AnnotationV2> {
        const record = this.suspendedById.get(id);
        if (!record) {
            throw new Error(`AnnotationStore.resume: suspended annotation ${id} not found`);
        }
        const ann = record.annotation;
        const before = this.freezeAnnotation(ann);

        const length = ann.endOffset - ann.startOffset;
        const lineIdx = this.offsetToLine(atOffset, document);
        const captured = captureAnchor(document as unknown as TextDocumentLike, lineIdx, {
            walkForward: 0,
            walkBackward: 0,
        });

        ann.fileUri = document.uri.toString();
        if (relativeFilePath !== undefined) {
            ann.file = relativeFilePath;
        }
        ann.languageId = document.languageId;
        ann.startOffset = atOffset;
        ann.endOffset = atOffset + length;
        ann.lineHash = captured.lineHash;
        ann.contextBefore = captured.contextBefore;
        ann.contextAfter = captured.contextAfter;
        ann.state = 'active';

        this.unindexSuspended(id);
        this.map.set(id, ann);

        const after = this.freezeAnnotation(ann);
        const opId = randomUUID();
        this.commitOrQueue({
            opId,
            timestamp: new Date().toISOString(),
            kind: 'resume',
            annotationId: id,
            before,
            after,
            inverse: { kind: 'suspend', annotationId: id, previous: before, next: after },
            documentVersionAtOp: document.version,
            fileUri: ann.fileUri,
            transactionId: '',
        });

        this._onDidResume.fire({ annotationId: id, opId });
        return after;
    }

    getSuspendedByHash(blockHash: string): ReadonlyArray<SuspendedEntry> {
        const ids = this.suspendedByLineHash.get(blockHash);
        if (!ids || ids.size === 0) {
            return [];
        }
        const result: SuspendedEntry[] = [];
        for (const id of ids) {
            const rec = this.suspendedById.get(id);
            if (!rec) {
                continue;
            }
            result.push({
                annotation: this.freezeAnnotation(rec.annotation),
                blockHash: rec.blockHash,
                suspendedAt: rec.suspendedAt,
                suspendOpId: rec.suspendOpId,
            });
        }
        return result;
    }

    // ── Undo/Redo mirroring (limit L1) ───────────────────────────────────

    mirrorUndo(_documentVersion: number, _fileUri: string): void {
        if (this.journal.length === 0) {
            return;
        }
        const lastTxId = this.journal[this.journal.length - 1].transactionId;
        const txOps: OpEntry[] = [];
        while (this.journal.length > 0 && this.journal[this.journal.length - 1].transactionId === lastTxId) {
            const op = this.journal.pop();
            if (op) {
                txOps.unshift(op);
            }
        }
        this.isMirroring = true;
        try {
            for (let i = txOps.length - 1; i >= 0; i--) {
                this.applyInverseInPlace(txOps[i]);
            }
        } finally {
            this.isMirroring = false;
        }
        this.redoStack.push(txOps);
        this._onDidChange.fire(txOps);
    }

    mirrorRedo(_documentVersion: number, _fileUri: string): void {
        if (this.redoStack.length === 0) {
            return;
        }
        const txOps = this.redoStack.pop();
        if (!txOps) {
            return;
        }
        this.isMirroring = true;
        try {
            for (const op of txOps) {
                this.applyForwardInPlace(op);
                this.appendToJournal(op);
            }
        } finally {
            this.isMirroring = false;
        }
        this._onDidChange.fire(txOps);
    }

    // ── Validation ───────────────────────────────────────────────────────

    validate(): ValidationResult {
        const violations: ViolationReport[] = [];
        const seen = new Set<string>();

        // Active annotations
        for (const ann of this.map.values()) {
            this.validateOne(ann, 'active', seen, violations);
        }
        // Suspended annotations
        for (const rec of this.suspendedById.values()) {
            this.validateOne(rec.annotation, 'suspended', seen, violations);
        }

        // I4 — every suspendedById entry indexed by blockHash, and vice versa.
        for (const [id, rec] of this.suspendedById) {
            const bucket = this.suspendedByLineHash.get(rec.blockHash);
            if (!bucket || !bucket.has(id)) {
                violations.push({
                    code: 'orphan-suspended',
                    annotationId: id,
                    detail: `suspendedById entry ${id} missing from suspendedByLineHash[${rec.blockHash}]`,
                });
            }
        }
        for (const [hash, bucket] of this.suspendedByLineHash) {
            for (const id of bucket) {
                if (!this.suspendedById.has(id)) {
                    violations.push({
                        code: 'orphan-suspended',
                        annotationId: id,
                        detail: `suspendedByLineHash[${hash}] references unknown id ${id}`,
                    });
                }
            }
        }

        return { valid: violations.length === 0, violations };
    }

    private validateOne(
        ann: AnnotationV2,
        expectedState: 'active' | 'suspended',
        seen: Set<string>,
        violations: ViolationReport[]
    ): void {
        if (seen.has(ann.id)) {
            violations.push({
                code: 'duplicate-id',
                annotationId: ann.id,
                detail: `duplicate id: ${ann.id}`,
            });
        } else {
            seen.add(ann.id);
        }
        if (ann.startOffset < 0 || ann.startOffset > ann.endOffset) {
            violations.push({
                code: 'invalid-offset-range',
                annotationId: ann.id,
                detail: `startOffset=${ann.startOffset} endOffset=${ann.endOffset}`,
            });
        }
        if (ann.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            violations.push({
                code: 'invalid-schema-version',
                annotationId: ann.id,
                detail: `schemaVersion=${String(ann.schemaVersion)}`,
            });
        }
        if (ann.state !== expectedState) {
            violations.push({
                code: 'state-mismatch',
                annotationId: ann.id,
                detail: `state=${ann.state} but registered in ${expectedState} container`,
            });
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────

    serialize(): AnnotationStoreFileV2 {
        const annotations: AnnotationV2[] = [];
        for (const a of this.map.values()) {
            annotations.push({ ...a });
        }
        for (const rec of this.suspendedById.values()) {
            annotations.push({ ...rec.annotation });
        }
        return {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations,
        };
    }

    deserialize(file: AnnotationStoreFileV2): void {
        if (file.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new Error(
                `AnnotationStore.deserialize: unsupported schemaVersion ${String(file.schemaVersion)} ` +
                    `(expected ${ANNOTATION_SCHEMA_VERSION}, no migration path in v2)`
            );
        }
        this.map.clear();
        this.journal.length = 0;
        this.redoStack.length = 0;
        this.activeTransaction = null;
        this.suspendedById.clear();
        this.suspendedByLineHash.clear();

        const now = Date.now();
        for (const ann of file.annotations) {
            if (ann.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
                throw new Error(
                    `AnnotationStore.deserialize: per-annotation schemaVersion mismatch on ${ann.id} ` +
                        `(got ${String(ann.schemaVersion)})`
                );
            }
            const cloned: AnnotationV2 = { ...ann };
            if (cloned.state === 'suspended') {
                const record: SuspendedRecord = {
                    annotation: cloned,
                    blockHash: cloned.lineHash,
                    suspendedAt: now,
                    suspendOpId: '',
                };
                this.suspendedById.set(cloned.id, record);
                this.indexSuspended(cloned.id, cloned.lineHash);
            } else if (cloned.state === 'active') {
                this.map.set(cloned.id, cloned);
            }
            // 'disposed' entries are not persisted in well-formed envelopes;
            // skip them silently if they appear (forward compat).
        }

        // Resolve `waitUntilInitialized()` exactly once.
        if (this.initializationResolver) {
            this.initializationResolver();
            this.initializationResolver = null;
        }
    }

    // ── Journal access ───────────────────────────────────────────────────

    getJournal(): JournalSnapshot {
        return {
            capacity: this.capacity,
            entries: this.journal.slice(),
            cursor: this.journal.length,
        };
    }

    // ── Lot 5 ergonomics for migrating consumers ─────────────────────────

    /** Alias of {@link getAll}. Idiomatic for legacy consumers using `manager.annotations.values()`. */
    list(): ReadonlyArray<Readonly<AnnotationV2>> {
        return this.getAll();
    }

    /** Alias of {@link getByFile}. */
    listForFile(fileUri: string): ReadonlyArray<Readonly<AnnotationV2>> {
        return this.getByFile(fileUri);
    }

    /** Number of annotations currently in the active map (excludes suspended/disposed). */
    size(): number {
        return this.map.size;
    }

    /**
     * Resolve the 0-based display line for an annotation. Returns `null` when:
     *   - the id is unknown,
     *   - no document is provided / no matching document is found in the
     *     supplied openDocuments list.
     *
     * Pass either a specific `vscode.TextDocument` (when the caller already
     * holds the document — e.g. a CodeLens provider) or the editor's open
     * document set (`vscode.workspace.textDocuments`) which the store will
     * scan by `fileUri`. Closed-file lookup intentionally returns `null` —
     * opening the document on demand is the caller's responsibility.
     *
     * The store stays pure-Node here: no runtime `require('vscode')`, so
     * unit tests work without an EDH host.
     */
    getLineForAnnotation(
        id: string,
        documentOrOpenDocuments?: vscode.TextDocument | readonly vscode.TextDocument[]
    ): number | null {
        const ann = this.map.get(id) ?? this.suspendedById.get(id)?.annotation;
        if (!ann) {
            return null;
        }
        const doc = this.resolveDocument(ann.fileUri, documentOrOpenDocuments);
        if (!doc) {
            return null;
        }
        return doc.positionAt(ann.startOffset).line;
    }

    private resolveDocument(
        fileUri: string,
        hint: vscode.TextDocument | readonly vscode.TextDocument[] | undefined
    ): vscode.TextDocument | undefined {
        if (!hint) {
            return undefined;
        }
        if (Array.isArray(hint)) {
            return (hint as readonly vscode.TextDocument[]).find((d) => d.uri.toString() === fileUri);
        }
        const doc = hint as vscode.TextDocument;
        return doc.uri.toString() === fileUri ? doc : undefined;
    }

    /**
     * Insert-or-update by id. Replaces `manager.annotations.set(id, ann)` —
     * the journal records a single `OpEntry` of kind `upsert`, with inverse
     * `remove` (when the id was new) or `update` (when the id was present).
     *
     * Constant fields (`schemaVersion`, `state`) auto-default when omitted by
     * the caller, so AI / programmatic flows don't have to repeat them. An
     * EXPLICIT non-2 `schemaVersion` is rejected to prevent accidental
     * legacy-format inserts.
     */
    upsert(
        annotation: Omit<AnnotationV2, 'schemaVersion' | 'state'> & {
            schemaVersion?: typeof ANNOTATION_SCHEMA_VERSION;
            state?: AnnotationV2['state'];
        }
    ): Readonly<AnnotationV2> {
        if (annotation.schemaVersion !== undefined && annotation.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new RangeError(
                `AnnotationStore.upsert: schemaVersion must be ${ANNOTATION_SCHEMA_VERSION} (got ${String(annotation.schemaVersion)})`
            );
        }
        if (annotation.startOffset < 0 || annotation.startOffset > annotation.endOffset) {
            throw new RangeError(
                `AnnotationStore.upsert: invalid offset range [${annotation.startOffset}, ${annotation.endOffset}]`
            );
        }

        const normalized: AnnotationV2 = {
            ...annotation,
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            state: annotation.state ?? 'active',
        };

        const existing = this.map.get(normalized.id);
        const after = this.freezeAnnotation({ ...normalized });

        if (existing) {
            const before = this.freezeAnnotation(existing);
            this.replaceAnnotation(normalized.id, normalized);
            this.commitOrQueue({
                opId: randomUUID(),
                timestamp: new Date().toISOString(),
                kind: 'upsert',
                annotationId: normalized.id,
                before,
                after,
                inverse: {
                    kind: 'update',
                    annotationId: normalized.id,
                    previous: before,
                    next: after,
                },
                documentVersionAtOp: 0,
                fileUri: normalized.fileUri,
                transactionId: '',
            });
            return after;
        }

        this.map.set(normalized.id, { ...normalized });
        this.commitOrQueue({
            opId: randomUUID(),
            timestamp: new Date().toISOString(),
            kind: 'upsert',
            annotationId: normalized.id,
            before: null,
            after,
            inverse: {
                kind: 'remove',
                annotationId: normalized.id,
                previous: after,
            },
            documentVersionAtOp: 0,
            fileUri: normalized.fileUri,
            transactionId: '',
        });
        return after;
    }

    /**
     * Recompute `lineHash` + `contextBefore` + `contextAfter` against the
     * current document state at the annotation's stored startOffset. Useful
     * after an external edit (file modified outside VS Code) where the
     * cached anchor data may have drifted.
     */
    populateAnchor(annotation: AnnotationV2, document: vscode.TextDocument): Readonly<AnnotationV2> {
        const existing = this.map.get(annotation.id);
        if (!existing) {
            throw new Error(`AnnotationStore.populateAnchor: annotation ${annotation.id} not found in the active map`);
        }
        const lineIdx = this.offsetToLine(existing.startOffset, document);
        const captured = captureAnchor(document as unknown as TextDocumentLike, lineIdx, {
            walkForward: 0,
            walkBackward: 0,
        });
        return this.update(annotation.id, {
            lineHash: captured.lineHash,
            contextBefore: captured.contextBefore,
            contextAfter: captured.contextAfter,
        });
    }

    /**
     * Move an annotation to a different line. Recomputes startOffset via
     * `lineToOffset(line, document)` and preserves the original anchored
     * length. Re-captures `lineHash`/`contextBefore`/`contextAfter` against
     * the new line. Journals an `update` OpEntry.
     */
    setAnnotationLine(id: string, line: number, document: vscode.TextDocument): Readonly<AnnotationV2> {
        const existing = this.map.get(id);
        if (!existing) {
            throw new Error(`AnnotationStore.setAnnotationLine: annotation ${id} not found`);
        }
        const length = existing.endOffset - existing.startOffset;
        const newStartOffset = this.lineToOffset(line, document);
        const newEndOffset = newStartOffset + length;
        const captured = captureAnchor(document as unknown as TextDocumentLike, line, {
            walkForward: 0,
            walkBackward: 0,
        });

        const before = this.freezeAnnotation(existing);
        existing.startOffset = newStartOffset;
        existing.endOffset = newEndOffset;
        existing.lineHash = captured.lineHash;
        existing.contextBefore = captured.contextBefore;
        existing.contextAfter = captured.contextAfter;
        existing.fileUri = document.uri.toString();
        const after = this.freezeAnnotation(existing);

        this.commitOrQueue({
            opId: randomUUID(),
            timestamp: new Date().toISOString(),
            kind: 'update',
            annotationId: id,
            before,
            after,
            inverse: {
                kind: 'update',
                annotationId: id,
                previous: before,
                next: after,
            },
            documentVersionAtOp: document.version,
            fileUri: after.fileUri,
            transactionId: '',
        });
        return after;
    }

    /**
     * Resolve {@link waitUntilInitialized}. Use on programmatic flows that
     * never go through `deserialize()` (e.g. tests with hand-built data).
     */
    markInitialized(): void {
        if (this.initializationResolver) {
            this.initializationResolver();
            this.initializationResolver = null;
        }
    }

    /**
     * Promise that resolves on the first `deserialize()` (or
     * `markInitialized()`). Replaces `AnnotationManager.waitUntilInitialized`.
     */
    waitUntilInitialized(): Promise<void> {
        return this.initializationPromise;
    }

    /**
     * Fire `onDidChange` with an empty batch. Replaces external sites that
     * called `manager.emit('annotationChanged')` without a payload.
     */
    notifyChanged(): void {
        this._onDidChange.fire([]);
    }

    /**
     * Release listeners and clear in-memory state. Idempotent; safe to call
     * multiple times. After dispose the store rejects further mutations.
     */
    dispose(): void {
        this.map.clear();
        this.suspendedById.clear();
        this.suspendedByLineHash.clear();
        this.journal.length = 0;
        this.redoStack.length = 0;
        this.activeTransaction = null;
        this._onDidChange.dispose();
        this._onDidSuspend.dispose();
        this._onDidResume.dispose();
        this._onDidDispose.dispose();
    }

    // ── Internals ────────────────────────────────────────────────────────

    private commitOrQueue(op: OpEntry): void {
        if (this.activeTransaction) {
            const tagged = this.tagWithTransactionId(op, this.activeTransaction.transactionId);
            this.activeTransaction.ops.push(tagged);
            return;
        }
        if (!this.isMirroring) {
            this.redoStack.length = 0;
        }
        const tagged = this.tagWithTransactionId(op, randomUUID());
        this.appendToJournal(tagged);
        this._onDidChange.fire([tagged]);
    }

    private tagWithTransactionId(op: OpEntry, transactionId: string): OpEntry {
        return Object.freeze({
            ...op,
            transactionId,
            inverse: Object.freeze({ ...op.inverse }),
        });
    }

    private appendToJournal(entry: OpEntry): void {
        this.journal.push(entry);
        while (this.journal.length > this.capacity) {
            this.journal.shift();
        }
    }

    private freezeAnnotation(ann: AnnotationV2): Readonly<AnnotationV2> {
        return Object.freeze({ ...ann });
    }

    private applyInverseInPlace(op: OpEntry): void {
        const inv = op.inverse;
        switch (inv.kind) {
            case 'remove':
                // Inverse of add: drop the annotation from wherever it is.
                this.map.delete(inv.annotationId);
                if (this.suspendedById.has(inv.annotationId)) {
                    this.unindexSuspended(inv.annotationId);
                }
                break;
            case 'add':
                // Inverse of remove: restore from the snapshot (active).
                if (inv.next) {
                    this.map.set(inv.next.id, { ...inv.next });
                }
                break;
            case 'update':
                if (inv.previous) {
                    // Replace target wholesale: Object.assign would not clear
                    // fields that were ADDED by the forward update (e.g. a
                    // patch setting `pinned: true` on an annotation that
                    // didn't previously carry the field).
                    this.replaceAnnotation(inv.previous.id, inv.previous);
                }
                break;
            case 'suspend': {
                // Inverse of resume: move active → suspended (revert to pre-resume).
                if (!inv.previous) {
                    break;
                }
                const ann = { ...inv.previous };
                this.map.delete(ann.id);
                this.suspendedById.set(ann.id, {
                    annotation: ann,
                    blockHash: ann.lineHash,
                    suspendedAt: Date.now(),
                    suspendOpId: op.opId,
                });
                this.indexSuspended(ann.id, ann.lineHash);
                break;
            }
            case 'resume': {
                // Inverse of suspend: move suspended → active (revert to pre-suspend).
                if (!inv.previous) {
                    break;
                }
                const ann = { ...inv.previous };
                this.unindexSuspended(ann.id);
                this.map.set(ann.id, ann);
                break;
            }
            default: {
                const exhaustive: never = inv.kind;
                throw new Error(`unknown InverseOp kind: ${String(exhaustive)}`);
            }
        }
    }

    private applyForwardInPlace(op: OpEntry): void {
        const kind: OpKind = op.kind;
        switch (kind) {
            case 'add':
            case 'upsert':
                if (op.after) {
                    // Forward replay: insert (or overwrite) into the active
                    // map. If the id was tracked in the suspended buffer we
                    // also evict it so `state` invariants stay coherent.
                    if (this.suspendedById.has(op.after.id)) {
                        this.unindexSuspended(op.after.id);
                    }
                    this.map.set(op.after.id, { ...op.after });
                }
                break;
            case 'remove':
                this.map.delete(op.annotationId);
                if (this.suspendedById.has(op.annotationId)) {
                    this.unindexSuspended(op.annotationId);
                }
                break;
            case 'update':
                if (op.after) {
                    this.replaceAnnotation(op.after.id, op.after);
                }
                break;
            case 'suspend': {
                if (!op.after) {
                    break;
                }
                const ann = { ...op.after };
                this.map.delete(ann.id);
                this.suspendedById.set(ann.id, {
                    annotation: ann,
                    blockHash: ann.lineHash,
                    suspendedAt: Date.now(),
                    suspendOpId: op.opId,
                });
                this.indexSuspended(ann.id, ann.lineHash);
                break;
            }
            case 'resume': {
                if (!op.after) {
                    break;
                }
                const ann = { ...op.after };
                this.unindexSuspended(ann.id);
                this.map.set(ann.id, ann);
                break;
            }
            default: {
                const exhaustive: never = kind;
                throw new Error(`unknown OpKind: ${String(exhaustive)}`);
            }
        }
    }

    private changeAffectsLineStructure(change: vscode.TextDocumentContentChangeEvent): boolean {
        return change.text.includes('\n') || change.range.start.line !== change.range.end.line;
    }

    /**
     * Conservative relocation: when the line under `ann.startOffset` no
     * longer hashes to `ann.lineHash`, look the old content up elsewhere in
     * the document via findAnchor (hash candidates scored by context; NO
     * unique-hash fallback — a lone identical line elsewhere is not enough
     * evidence to move a possibly-corrupted anchor). On a confident match
     * the annotation moves there (length preserved) and its anchor context
     * is recaptured. Returns true when the annotation moved.
     *
     * Mutations are silent (no journal entry): like the Cas A/B/C offset
     * shifts, relocation is a document-driven projection, not a user
     * mutation — journaling it would desync the best-effort undo mirroring
     * (limit L1) which pairs journal transactions with editor undo events.
     */
    private tryRelocateByAnchor(ann: AnnotationV2, document: vscode.TextDocument): boolean {
        let lineIdx = this.offsetToLine(ann.startOffset, document);
        if (lineIdx < 0) {
            lineIdx = 0;
        }
        if (lineIdx >= document.lineCount) {
            lineIdx = document.lineCount - 1;
        }
        if (hashLine(document.lineAt(lineIdx).text) === ann.lineHash) {
            return false;
        }
        const found = findAnchor(
            document as unknown as TextDocumentLike,
            {
                lineHash: ann.lineHash,
                contextBefore: ann.contextBefore ?? [],
                contextAfter: ann.contextAfter ?? [],
            },
            lineIdx
        );
        if (found === null || found === lineIdx) {
            return false;
        }
        const length = ann.endOffset - ann.startOffset;
        ann.startOffset = this.lineToOffset(found, document);
        ann.endOffset = ann.startOffset + length;
        this.refreshAnchorContext(ann, document);
        return true;
    }

    /**
     * Scan `text` line-by-line and return the byte offset (within `text`) +
     * content of the FIRST line whose normalized hash equals `hash`.
     *
     * Used by the Cas D survival check (applyDocumentChange) to detect when a
     * wide REPLACE rewrote the annotated line in place — formatter-style
     * re-indents typically emit a single replace whose range overshoots the
     * annotation's offsets by the trailing newline, even though the line
     * content (after normalizeLine) is unchanged. In that case the annotation
     * must NOT slip into the suspend buffer; it should re-anchor at the
     * surviving line inside the inserted text.
     *
     * Returns null for empty `text` or for the universal blank-line hash
     * (EMPTY_LINE_HASH) — those are degenerate matches that would re-anchor
     * arbitrarily and are explicitly excluded.
     */
    private findLineHashInText(text: string, hash: string): { lineStart: number; lineText: string } | null {
        if (text.length === 0 || hash === EMPTY_LINE_HASH) {
            return null;
        }
        const lines = text.split('\n');
        let cursor = 0;
        for (const lineText of lines) {
            if (hashLine(lineText) === hash) {
                return { lineStart: cursor, lineText };
            }
            cursor += lineText.length + 1; // +1 for the '\n' splitter consumed by split()
        }
        return null;
    }

    private refreshAnchorContext(ann: AnnotationV2, document: vscode.TextDocument): void {
        const lineIdx = this.offsetToLine(ann.startOffset, document);
        if (lineIdx < 0 || lineIdx >= document.lineCount) {
            return;
        }
        const captured = captureAnchor(document as unknown as TextDocumentLike, lineIdx, {
            walkForward: 0,
            walkBackward: 0,
        });
        ann.lineHash = captured.lineHash;
        ann.contextBefore = captured.contextBefore;
        ann.contextAfter = captured.contextAfter;
    }

    /**
     * Replace the annotation stored under `id` with a fresh shallow clone of
     * `replacement`. Used by mirrorUndo/mirrorRedo of `update` ops so that
     * fields removed across the undo/redo are actually cleared (a plain
     * Object.assign would only overwrite fields present in the replacement).
     */
    private replaceAnnotation(id: string, replacement: Readonly<AnnotationV2>): void {
        if (this.map.has(id)) {
            this.map.set(id, { ...replacement });
            return;
        }
        const rec = this.suspendedById.get(id);
        if (rec) {
            rec.annotation = { ...replacement };
        }
    }

    private indexSuspended(id: string, blockHash: string): void {
        let bucket = this.suspendedByLineHash.get(blockHash);
        if (!bucket) {
            bucket = new Set();
            this.suspendedByLineHash.set(blockHash, bucket);
        }
        bucket.add(id);
    }

    private unindexSuspended(id: string): void {
        const rec = this.suspendedById.get(id);
        if (rec) {
            const bucket = this.suspendedByLineHash.get(rec.blockHash);
            if (bucket) {
                bucket.delete(id);
                if (bucket.size === 0) {
                    this.suspendedByLineHash.delete(rec.blockHash);
                }
            }
        }
        this.suspendedById.delete(id);
    }

    /**
     * Drop suspended entries whose age exceeds suspendTtlMs. Marks the
     * underlying annotation as `disposed` so any in-flight reference (e.g.
     * a held SuspendedEntry snapshot) can read the terminal state.
     * The disposal is NOT journaled — the prior `suspend` OpEntry already
     * carries enough state (snapshot in `before`/`inverse.previous`) for
     * mirrorUndo replay if the editor undoes back through it.
     */
    private sweepExpiredSuspended(now: number): void {
        if (this.suspendTtlMs === Number.POSITIVE_INFINITY) {
            return;
        }
        const expired: string[] = [];
        for (const [id, rec] of this.suspendedById) {
            if (now - rec.suspendedAt > this.suspendTtlMs) {
                expired.push(id);
            }
        }
        for (const id of expired) {
            const rec = this.suspendedById.get(id);
            if (!rec) {
                continue;
            }
            rec.annotation.state = 'disposed';
            const snapshot = this.freezeAnnotation(rec.annotation);
            this.unindexSuspended(id);
            this._onDidDispose.fire({ annotationId: id, reason: 'ttl-expired', annotation: snapshot });
        }
    }

    /**
     * Detect a paste insertion and either resume a suspended annotation
     * (cut-then-paste, same id) or clone an active one (copy-then-paste,
     * new id with `origin.kind === 'paste'`).
     *
     * `change.rangeLength === 0` and `change.text.length > 0` is the
     * pure-insert signature — exits early otherwise.
     */
    private detectPaste(
        change: vscode.TextDocumentContentChangeEvent,
        document: vscode.TextDocument,
        resumedThisCall: Set<string>,
        pasteSources: readonly AnnotationV2[],
        allowClone: boolean,
        relativeFilePath?: string
    ): void {
        if (change.text.length === 0) {
            return;
        }
        const baseOffset = change.rangeOffset;
        const lines = change.text.split('\n');

        // Pre-scan: does ANY line of this paste have an exact lineHash that
        // matches a suspended bucket? If yes, the per-line loop will resume
        // cleanly; the "1b. Fallback resume" path below MUST stay disabled
        // for ALL lines of this paste, otherwise an early non-matching line
        // (e.g. the first line of a multi-line block paste) will spuriously
        // trigger fallback before the real-matching line is reached.
        let anyExactSuspendedHit = false;
        for (const lineText of lines) {
            const h = hashLine(lineText);
            if (h !== EMPTY_LINE_HASH && this.suspendedByLineHash.has(h)) {
                anyExactSuspendedHit = true;
                break;
            }
        }

        let cursor = 0;
        for (const lineText of lines) {
            const lineOffset = baseOffset + cursor;
            const lineHashValue = hashLine(lineText);
            cursor += lineText.length + 1; // +1 for '\n' splitter

            if (lineHashValue === EMPTY_LINE_HASH) {
                continue;
            }

            // 1. Suspended bucket — cut/paste resume (FIFO by suspendedAt).
            const suspendedIds = this.suspendedByLineHash.get(lineHashValue);
            let resumed = false;
            if (suspendedIds && suspendedIds.size > 0) {
                const sortedIds = Array.from(suspendedIds).sort((a, b) => {
                    const aT = this.suspendedById.get(a)?.suspendedAt ?? Number.MAX_SAFE_INTEGER;
                    const bT = this.suspendedById.get(b)?.suspendedAt ?? Number.MAX_SAFE_INTEGER;
                    return aT - bT;
                });
                for (const id of sortedIds) {
                    const rec = this.suspendedById.get(id);
                    if (!rec) {
                        continue;
                    }
                    if (Date.now() - rec.suspendedAt > this.suspendTtlMs) {
                        continue;
                    }
                    const companions = sortedIds.filter((candidateId) => {
                        const candidate = this.suspendedById.get(candidateId);
                        return (
                            candidate !== undefined &&
                            candidate.annotation.fileUri === rec.annotation.fileUri &&
                            candidate.annotation.startOffset === rec.annotation.startOffset &&
                            candidate.annotation.endOffset === rec.annotation.endOffset
                        );
                    });
                    for (const companionId of companions) {
                        this.resume(companionId, document, lineOffset, relativeFilePath);
                        resumedThisCall.add(companionId);
                    }
                    resumed = true;
                    break;
                }
            }
            if (resumed) {
                continue;
            }

            // 1b. Fallback resume — exact-hash lookup missed for THIS line
            // AND no other line of the paste exact-matched either. A recent
            // suspend in this file with no active match elsewhere is almost
            // certainly the user's cut/paste round-trip whose content drifted
            // (e.g. JSON formatOnPaste re-indented the inserted line, or a
            // single-character edit between annotation creation and cut left
            // ann.lineHash slightly stale). Constraints: no exact hit
            // anywhere in this paste (`anyExactSuspendedHit === false`),
            // exactly one recently-suspended annotation in this file, and
            // zero active candidates with matching lineHash -- avoids
            // misfiring on the first line of a block paste before a later
            // line could resume cleanly, and avoids hijacking copy+paste
            // sequences.
            if (!anyExactSuspendedHit && change.rangeLength === 0) {
                const suspendWindowMs = 5_000;
                let activeSourceMatchExists = false;
                for (const sourceAnn of this.map.values()) {
                    if (sourceAnn.state === 'active' && sourceAnn.lineHash === lineHashValue) {
                        activeSourceMatchExists = true;
                        break;
                    }
                }
                if (!activeSourceMatchExists) {
                    const now = Date.now();
                    const recentSuspendGroups = new Map<string, string[]>();
                    for (const [sid, rec] of this.suspendedById) {
                        if (now - rec.suspendedAt > suspendWindowMs) {
                            continue;
                        }
                        if (resumedThisCall.has(sid)) {
                            continue;
                        }
                        const key = `${rec.annotation.fileUri}:${rec.annotation.startOffset}:${rec.annotation.endOffset}`;
                        const group = recentSuspendGroups.get(key) ?? [];
                        group.push(sid);
                        recentSuspendGroups.set(key, group);
                    }
                    if (recentSuspendGroups.size === 1) {
                        const group = recentSuspendGroups.values().next().value as string[] | undefined;
                        for (const sid of group ?? []) {
                            this.resume(sid, document, lineOffset, relativeFilePath);
                            resumedThisCall.add(sid);
                        }
                        resumed = true;
                    }
                }
            }
            if (resumed) {
                continue;
            }

            // 2. Active annotation match — copy/paste clone (new id). Clone
            // every annotation co-located on the selected source line, while
            // keeping identical lines elsewhere as separate ambiguous groups.
            if (allowClone) {
                const matchingSources = pasteSources.filter(
                    (sourceAnn) =>
                        sourceAnn.state === 'active' &&
                        sourceAnn.lineHash === lineHashValue &&
                        !resumedThisCall.has(sourceAnn.id) &&
                        !(
                            change.rangeLength > 0 &&
                            sourceAnn.fileUri === document.uri.toString() &&
                            sourceAnn.startOffset < change.rangeOffset + change.rangeLength &&
                            sourceAnn.endOffset > change.rangeOffset
                        )
                );
                const primary = matchingSources[0];
                if (primary) {
                    const companions = matchingSources.filter(
                        (sourceAnn) =>
                            sourceAnn.fileUri === primary.fileUri &&
                            sourceAnn.startOffset === primary.startOffset &&
                            sourceAnn.endOffset === primary.endOffset
                    );
                    for (const sourceAnn of companions) {
                        this.cloneAsPaste(sourceAnn, document, lineOffset, relativeFilePath);
                    }
                }
            }
        }
    }

    private cloneAsPaste(
        source: AnnotationV2,
        document: vscode.TextDocument,
        atOffset: number,
        relativeFilePath?: string
    ): void {
        const length = source.endOffset - source.startOffset;
        const lineIdx = this.offsetToLine(atOffset, document);
        const captured = captureAnchor(document as unknown as TextDocumentLike, lineIdx, {
            walkForward: 0,
            walkBackward: 0,
        });

        // Fallback when the original add op has been evicted from the
        // cyclic journal: point sourceOpId at the source annotation's id
        // (still meaningful for traceability even if the op record is gone).
        const sourceOpId = this.findOpIdForAdd(source.id) ?? source.id;
        const id = randomUUID();

        // Deep clone via structuredClone so the clone shares no mutable
        // reference with the source (`thread`, `linkedAnnotations`,
        // `reviewState`, `snippet`, `tags`). Then overlay the new id +
        // anchoring fields + paste origin.
        const deepCloned: AnnotationV2 = structuredClone(source);
        const cloned: AnnotationV2 = {
            ...deepCloned,
            id,
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            fileUri: document.uri.toString(),
            file: relativeFilePath ?? source.file,
            languageId: document.languageId,
            startOffset: atOffset,
            endOffset: atOffset + length,
            lineHash: captured.lineHash,
            contextBefore: captured.contextBefore,
            contextAfter: captured.contextAfter,
            state: 'active',
            origin: { kind: 'paste', sourceOpId },
            timestamp: new Date().toISOString(),
        };
        this.map.set(id, cloned);
        const snapshot = this.freezeAnnotation(cloned);
        this.commitOrQueue(this.makeAddOp(snapshot, document.version));
    }

    /** Walk the journal back-to-front for the most recent `add` op of `annotationId`. */
    private findOpIdForAdd(annotationId: string): string | undefined {
        for (let i = this.journal.length - 1; i >= 0; i--) {
            const op = this.journal[i];
            if (op.kind === 'add' && op.annotationId === annotationId) {
                return op.opId;
            }
        }
        return undefined;
    }
}
