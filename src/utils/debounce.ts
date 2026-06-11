// SPDX-License-Identifier: MPL-2.0
//
// Minimal trailing-edge debouncer. Pure Node (setTimeout only) so the unit
// suite exercises it without a VS Code host.

/** Handle returned by {@link createDebounced}. */
export interface Debounced {
    /**
     * (Re)arm the timer. Each call resets the countdown; the wrapped
     * function runs once, `delayMs` after the LAST schedule() call.
     */
    schedule(): void;
    /** Drop any pending invocation without running it. Idempotent. */
    cancel(): void;
    /** True while an invocation is armed and has not fired yet. */
    isPending(): boolean;
}

/**
 * Wrap `fn` in a trailing-edge debounce of `delayMs` milliseconds.
 *
 * Used by the docs watch mode (`annotation.docs.watch`) to coalesce the
 * burst of `AnnotationStore.onDidChange` events produced by editing into a
 * single documentation regeneration.
 */
export function createDebounced(fn: () => void, delayMs: number): Debounced {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new RangeError(`createDebounced: delayMs must be a non-negative finite number (got ${String(delayMs)})`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        schedule(): void {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = undefined;
                fn();
            }, delayMs);
        },
        cancel(): void {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
        isPending(): boolean {
            return timer !== undefined;
        },
    };
}
