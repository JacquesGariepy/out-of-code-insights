// SPDX-License-Identifier: MPL-2.0

import { createHash, randomUUID } from 'crypto';
import { minimalTextReplacement, type MinimalTextReplacement } from './sourceConversionTextEdit';
import { sameConversionBusinessSnapshot } from './sourceConversionSnapshot';

export type SourceConversionDirection = 'comments-to-annotations' | 'annotations-to-comments';
export type SourceConversionHistoryPhase =
    | 'applied'
    | 'undone'
    | 'transitioning-undo'
    | 'transitioning-redo'
    | 'diverged';
export type SourceHistoryReason = 'undo' | 'redo';

export interface AnnotationHistorySnapshot {
    readonly id: string;
}

export interface SourceHistoryContentChange {
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
}

export interface RecordSourceConversion<T extends AnnotationHistorySnapshot> {
    readonly uri: string;
    readonly direction: SourceConversionDirection;
    readonly beforeText: string;
    readonly afterText: string;
    /** Business state before conversion (anchors may later track). */
    readonly beforeSnapshots: readonly T[];
    /** Business state after conversion. */
    readonly afterSnapshots: readonly T[];
    /** Exact snapshots installed before tracking a native Undo event. */
    readonly undoInstallSnapshots: readonly T[];
    /** Exact snapshots installed after tracking a native Redo event. */
    readonly redoInstallSnapshots: readonly T[];
}

interface SourceConversionHistoryEntry<T extends AnnotationHistorySnapshot> extends RecordSourceConversion<T> {
    readonly id: string;
    readonly beforeHash: string;
    readonly afterHash: string;
    readonly undoPatch: MinimalTextReplacement;
    readonly redoPatch: MinimalTextReplacement;
    phase: SourceConversionHistoryPhase;
}

export interface SourceConversionTransitionPlan<T extends AnnotationHistorySnapshot> {
    readonly entryId: string;
    readonly uri: string;
    readonly direction: SourceConversionDirection;
    readonly reason: SourceHistoryReason;
    readonly order: 'before-tracking' | 'after-tracking';
    readonly removeIds: readonly string[];
    readonly upsertSnapshots: readonly T[];
    /** Exact pre-event store state used only when source durability fails. */
    readonly rollbackRemoveIds: readonly string[];
    readonly rollbackUpsertSnapshots: readonly T[];
    /** Source text before the native event, used for failure compensation. */
    readonly sourceTextBeforeEvent: string;
    /** Source text expected after the native event. */
    readonly sourceTextAfterEvent: string;
}

export type BeginSourceHistoryTransition<T extends AnnotationHistorySnapshot> =
    | { readonly kind: 'none' }
    | {
          readonly kind: 'diverged';
          readonly entryId: string;
          readonly direction: SourceConversionDirection;
          readonly restoreText: string;
          readonly message: string;
      }
    | { readonly kind: 'matched'; readonly plan: SourceConversionTransitionPlan<T> };

function textHash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cloneSnapshots<T extends AnnotationHistorySnapshot>(snapshots: readonly T[]): T[] {
    return structuredClone(snapshots) as T[];
}

function snapshotsMatch<T extends AnnotationHistorySnapshot>(expected: readonly T[], current: readonly T[]): boolean {
    if (expected.length !== current.length) {
        return false;
    }
    const currentById = new Map(current.map((snapshot) => [snapshot.id, snapshot]));
    return expected.every((snapshot) => {
        const candidate = currentById.get(snapshot.id);
        return candidate !== undefined && sameConversionBusinessSnapshot(snapshot, candidate);
    });
}

/** Apply VS Code content changes, whose offsets refer to the pre-event text. */
export function applySourceHistoryChanges(
    source: string,
    changes: readonly SourceHistoryContentChange[]
): string | undefined {
    const sorted = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset);
    let previousStart = source.length + 1;
    let result = source;
    for (const change of sorted) {
        const start = change.rangeOffset;
        const end = start + change.rangeLength;
        if (start < 0 || end < start || end > source.length || end > previousStart) {
            return undefined;
        }
        result = `${result.slice(0, start)}${change.text}${result.slice(end)}`;
        previousStart = start;
    }
    return result;
}

/** Bounded per-document state machine for conversion-aware native history. */
export class SourceConversionUndoJournal<T extends AnnotationHistorySnapshot> {
    private readonly entriesByUri = new Map<string, SourceConversionHistoryEntry<T>[]>();

    constructor(private readonly capacityPerDocument = 8) {
        if (!Number.isInteger(capacityPerDocument) || capacityPerDocument <= 0) {
            throw new RangeError('SourceConversionUndoJournal capacity must be a positive integer');
        }
    }

    record(input: RecordSourceConversion<T>): string {
        if (input.beforeText === input.afterText) {
            throw new Error('A source conversion history entry requires a source-text change');
        }
        const undoPatch = minimalTextReplacement(input.afterText, input.beforeText);
        const redoPatch = minimalTextReplacement(input.beforeText, input.afterText);
        if (!undoPatch || !redoPatch) {
            throw new Error('A source conversion history entry requires reversible patches');
        }
        const beforeIds = new Set(input.beforeSnapshots.map((snapshot) => snapshot.id));
        if (input.afterSnapshots.some((snapshot) => beforeIds.has(snapshot.id))) {
            throw new Error('Source conversion history only records destructive moves with disjoint states');
        }

        const entries = this.entriesByUri.get(input.uri) ?? [];
        // A fresh conversion follows VS Code semantics and invalidates the
        // redo branch for conversions previously undone in this document.
        const retained = entries.filter((entry) => entry.phase === 'applied');
        const entry: SourceConversionHistoryEntry<T> = {
            ...input,
            id: randomUUID(),
            beforeText: input.beforeText,
            afterText: input.afterText,
            beforeSnapshots: cloneSnapshots(input.beforeSnapshots),
            afterSnapshots: cloneSnapshots(input.afterSnapshots),
            undoInstallSnapshots: cloneSnapshots(input.undoInstallSnapshots),
            redoInstallSnapshots: cloneSnapshots(input.redoInstallSnapshots),
            beforeHash: textHash(input.beforeText),
            afterHash: textHash(input.afterText),
            undoPatch,
            redoPatch,
            phase: 'applied',
        };
        retained.push(entry);
        while (retained.length > this.capacityPerDocument) {
            retained.shift();
        }
        this.entriesByUri.set(input.uri, retained);
        return entry.id;
    }

    trackedIds(uri: string, reason: SourceHistoryReason): string[] {
        const entry = this.candidate(uri, reason);
        if (!entry) {
            return [];
        }
        return [
            ...new Set([
                ...entry.beforeSnapshots.map((snapshot) => snapshot.id),
                ...entry.afterSnapshots.map((snapshot) => snapshot.id),
            ]),
        ];
    }

    beginNative(
        uri: string,
        reason: SourceHistoryReason,
        currentText: string,
        changes: readonly SourceHistoryContentChange[],
        currentSnapshots: readonly T[]
    ): BeginSourceHistoryTransition<T> {
        const entry = this.candidate(uri, reason);
        if (!entry) {
            return { kind: 'none' };
        }
        const undo = reason === 'undo';
        const sourceBeforeEvent = undo ? entry.afterText : entry.beforeText;
        const sourceAfterEvent = undo ? entry.beforeText : entry.afterText;
        const expectedHash = undo ? entry.beforeHash : entry.afterHash;
        if (textHash(currentText) !== expectedHash || currentText !== sourceAfterEvent) {
            return { kind: 'none' };
        }
        if (applySourceHistoryChanges(sourceBeforeEvent, changes) !== sourceAfterEvent) {
            entry.phase = 'diverged';
            return {
                kind: 'diverged',
                entryId: entry.id,
                direction: entry.direction,
                restoreText: sourceBeforeEvent,
                message: 'The native editor patch did not exactly match the recorded conversion patch.',
            };
        }
        const expectedSnapshots = undo ? entry.afterSnapshots : entry.beforeSnapshots;
        if (!snapshotsMatch(expectedSnapshots, currentSnapshots)) {
            entry.phase = 'diverged';
            return {
                kind: 'diverged',
                entryId: entry.id,
                direction: entry.direction,
                restoreText: sourceBeforeEvent,
                message: 'The annotations changed after conversion, so native history was refused.',
            };
        }

        entry.phase = undo ? 'transitioning-undo' : 'transitioning-redo';
        const beforeIds = new Set(entry.beforeSnapshots.map((snapshot) => snapshot.id));
        const afterIds = new Set(entry.afterSnapshots.map((snapshot) => snapshot.id));
        return {
            kind: 'matched',
            plan: {
                entryId: entry.id,
                uri,
                direction: entry.direction,
                reason,
                order: undo ? 'before-tracking' : 'after-tracking',
                removeIds: undo
                    ? [...afterIds].filter((id) => !beforeIds.has(id))
                    : [...beforeIds].filter((id) => !afterIds.has(id)),
                upsertSnapshots: cloneSnapshots(undo ? entry.undoInstallSnapshots : entry.redoInstallSnapshots),
                rollbackRemoveIds: undo
                    ? [...beforeIds].filter((id) => !afterIds.has(id))
                    : [...afterIds].filter((id) => !beforeIds.has(id)),
                rollbackUpsertSnapshots: cloneSnapshots(undo ? entry.afterSnapshots : entry.beforeSnapshots),
                sourceTextBeforeEvent: sourceBeforeEvent,
                sourceTextAfterEvent: sourceAfterEvent,
            },
        };
    }

    complete(entryId: string, reason: SourceHistoryReason, success: boolean): void {
        const entry = this.findById(entryId);
        if (!entry) {
            return;
        }
        const expected = reason === 'undo' ? 'transitioning-undo' : 'transitioning-redo';
        if (entry.phase !== expected) {
            return;
        }
        entry.phase = success ? (reason === 'undo' ? 'undone' : 'applied') : 'diverged';
    }

    observeOrdinaryEdit(uri: string): void {
        const entries = this.entriesByUri.get(uri);
        if (!entries) {
            return;
        }
        for (const entry of entries) {
            if (
                entry.phase === 'undone' ||
                entry.phase === 'transitioning-undo' ||
                entry.phase === 'transitioning-redo'
            ) {
                entry.phase = 'diverged';
            }
        }
    }

    clearUri(uri: string): void {
        this.entriesByUri.delete(uri);
    }

    discard(entryId: string): void {
        for (const [uri, entries] of this.entriesByUri) {
            const retained = entries.filter((entry) => entry.id !== entryId);
            if (retained.length === 0) {
                this.entriesByUri.delete(uri);
            } else if (retained.length !== entries.length) {
                this.entriesByUri.set(uri, retained);
            }
        }
    }

    invalidate(entryId: string): void {
        const entry = this.findById(entryId);
        if (entry) {
            entry.phase = 'diverged';
        }
    }

    phase(entryId: string): SourceConversionHistoryPhase | undefined {
        return this.findById(entryId)?.phase;
    }

    size(uri: string): number {
        return this.entriesByUri.get(uri)?.length ?? 0;
    }

    clear(): void {
        this.entriesByUri.clear();
    }

    private candidate(uri: string, reason: SourceHistoryReason): SourceConversionHistoryEntry<T> | undefined {
        const entries = this.entriesByUri.get(uri) ?? [];
        if (reason === 'undo') {
            return [...entries].reverse().find((entry) => entry.phase === 'applied');
        }
        return entries.find((entry) => entry.phase === 'undone');
    }

    private findById(id: string): SourceConversionHistoryEntry<T> | undefined {
        for (const entries of this.entriesByUri.values()) {
            const found = entries.find((entry) => entry.id === id);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
}
