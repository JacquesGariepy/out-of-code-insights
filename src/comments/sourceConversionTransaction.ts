// SPDX-License-Identifier: MPL-2.0

/**
 * Result of applying the source half of a conversion. A rejected workspace
 * edit is not an exception in the VS Code API, so callers need a distinct
 * status before touching annotation state.
 */
export type SourceConversionTransactionResult = 'completed' | 'source-edit-rejected';

/**
 * Raised when the destination mutation fails after the source was edited.
 * `sourceRestored` lets the command present an actionable high-severity
 * warning when the best-effort rollback could not be applied safely.
 */
export class SourceConversionTransactionError extends Error {
    constructor(
        message: string,
        readonly cause: unknown,
        readonly sourceRestored: boolean
    ) {
        super(message);
        this.name = 'SourceConversionTransactionError';
    }
}

/** Failure to persist a committed destination mutation and its compensation. */
export class DurableDestinationError extends Error {
    constructor(
        message: string,
        readonly cause: unknown,
        readonly destinationRestored: boolean
    ) {
        super(message);
        this.name = 'DurableDestinationError';
    }
}

export interface SourceFirstConversion {
    /** Apply the source-file edit. `false` means VS Code rejected the edit. */
    readonly applySource: () => Promise<boolean>;
    /** Commit the annotation-side transaction. It must roll itself back on failure. */
    readonly applyDestination: () => void | Promise<void>;
    /** Make the source edit durable before destructive destination work. */
    readonly makeSourceDurable?: () => Promise<void>;
    /** Restore the exact source text if `applyDestination` fails. */
    readonly restoreSource: () => Promise<boolean>;
}

/**
 * Apply a two-resource conversion without ever mutating annotations after a
 * rejected source edit. If the annotation transaction fails, attempt to put
 * the source document back exactly as it was and surface whether that worked.
 */
export async function runSourceFirstConversion(
    conversion: SourceFirstConversion
): Promise<SourceConversionTransactionResult> {
    if (!(await conversion.applySource())) {
        return 'source-edit-rejected';
    }

    try {
        await conversion.makeSourceDurable?.();
        await conversion.applyDestination();
        return 'completed';
    } catch (cause) {
        let sourceRestored = false;
        try {
            sourceRestored = await conversion.restoreSource();
        } catch {
            sourceRestored = false;
        }
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new SourceConversionTransactionError(
            `The annotation transaction failed after the source edit: ${detail}`,
            cause,
            sourceRestored
        );
    }
}

export interface DurableDestinationMutation {
    /** Apply and synchronously commit the in-memory mutation. */
    readonly mutate: () => void;
    /** Strict persistence barrier; rejection must not be swallowed. */
    readonly persist: () => Promise<void>;
    /** Synchronously reverse `mutate` after a persistence failure. */
    readonly compensate: () => void;
    /** Strictly persist the compensated state. */
    readonly persistCompensation: () => Promise<void>;
}

/**
 * Persist a committed store mutation or compensate it both in memory and on
 * disk. AnnotationStore transactions cannot safely remain open across an
 * `await`, so durability is enforced immediately after the synchronous
 * commit with a second compensating transaction on failure.
 */
export async function runDurableDestinationMutation(mutation: DurableDestinationMutation): Promise<void> {
    try {
        mutation.mutate();
        await mutation.persist();
    } catch (cause) {
        let destinationRestored = false;
        try {
            mutation.compensate();
            await mutation.persistCompensation();
            destinationRestored = true;
        } catch {
            destinationRestored = false;
        }
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new DurableDestinationError(
            `The annotation change could not be completed durably: ${detail}`,
            cause,
            destinationRestored
        );
    }
}

export interface RestoreSourceOrKeepDestination {
    /** Attempt to restore and save the source representation. */
    readonly restoreSource: () => Promise<boolean>;
    /** Reinstall the destination representation when source restore fails. */
    readonly ensureDestination: () => void;
    /** Always unblock destination persistence, including on exceptions. */
    readonly releasePersistence: () => void;
    /** Durably save whichever destination representation remains. */
    readonly persistDestination: () => Promise<void>;
}

/**
 * A destructive conversion rollback must never leave both representations
 * absent. Source rejection therefore reinstalls the destination before the
 * persistence gate is released, and strict persistence is attempted even if
 * that conservative reinstall itself reports an error.
 */
export async function restoreSourceOrKeepDestination(rollback: RestoreSourceOrKeepDestination): Promise<boolean> {
    let sourceRestored = false;
    try {
        sourceRestored = await rollback.restoreSource();
    } catch {
        sourceRestored = false;
    }

    let destinationError: unknown;
    if (!sourceRestored) {
        try {
            rollback.ensureDestination();
        } catch (error) {
            destinationError = error;
        }
    }

    rollback.releasePersistence();
    let persistenceError: unknown;
    try {
        await rollback.persistDestination();
    } catch (error) {
        persistenceError = error;
    }

    if (destinationError !== undefined) {
        throw destinationError;
    }
    if (persistenceError !== undefined) {
        throw persistenceError;
    }
    return sourceRestored;
}

/** Preserve line count/EOL style while removing the selected comment text. */
export function lineBreaksOnly(value: string): string {
    return value.match(/\r\n|\r|\n/g)?.join('') ?? '';
}
