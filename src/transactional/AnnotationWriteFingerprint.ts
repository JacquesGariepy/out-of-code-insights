// SPDX-License-Identifier: MPL-2.0

import { createHash } from 'crypto';
import type { AnnotationStoreFileV2 } from './types';

/**
 * Produce the same representation for semantically identical JSON objects,
 * regardless of their property insertion order or whitespace on disk.
 * Array order is deliberately preserved because annotation order is part of
 * the persisted envelope.
 */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, nested: unknown) => {
        if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
            return nested;
        }

        const source = nested as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            sorted[key] = source[key];
        }
        return sorted;
    });
}

/** Stable, content-addressed identity for a persisted annotation envelope. */
export function annotationEnvelopeFingerprint(payload: AnnotationStoreFileV2): string {
    return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Correlates file-watcher events with extension-owned atomic saves.
 *
 * A write is registered before the atomic save starts so a watcher event that
 * races the post-rename validation is still recognized. Only the latest
 * successful write remains eligible as a delayed echo. Observing a different
 * external envelope clears that marker, which means an external rollback to a
 * formerly internal payload is treated as external rather than ignored.
 */
export class AnnotationWriteFingerprintTracker {
    private readonly pending = new Map<string, number>();
    private latestCommitted: string | undefined;

    begin(payload: AnnotationStoreFileV2): string {
        const fingerprint = annotationEnvelopeFingerprint(payload);
        this.pending.set(fingerprint, (this.pending.get(fingerprint) ?? 0) + 1);
        return fingerprint;
    }

    commit(fingerprint: string): void {
        this.removePending(fingerprint);
        this.latestCommitted = fingerprint;
    }

    fail(fingerprint: string): void {
        this.removePending(fingerprint);
    }

    isInternalEcho(payload: AnnotationStoreFileV2): boolean {
        const fingerprint = annotationEnvelopeFingerprint(payload);
        return fingerprint === this.latestCommitted || this.pending.has(fingerprint);
    }

    observeExternal(payload: AnnotationStoreFileV2): void {
        const fingerprint = annotationEnvelopeFingerprint(payload);
        if (fingerprint !== this.latestCommitted && !this.pending.has(fingerprint)) {
            this.latestCommitted = undefined;
        }
    }

    private removePending(fingerprint: string): void {
        const count = this.pending.get(fingerprint);
        if (count === undefined) {
            return;
        }
        if (count <= 1) {
            this.pending.delete(fingerprint);
        } else {
            this.pending.set(fingerprint, count - 1);
        }
    }
}
