// SPDX-License-Identifier: MPL-2.0

/** Canonical JSON used only for immutable conversion-snapshot guards. */
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

/**
 * Prevent a delayed conversion/Undo prompt from deleting an annotation that
 * changed while the user was choosing an action.
 */
export function sameConversionSnapshot(expected: unknown, current: unknown): boolean {
    return canonicalJson(expected) === canonicalJson(current);
}

function withoutMutableAnchor(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return value;
    }
    const {
        startOffset: _startOffset,
        endOffset: _endOffset,
        lineHash: _lineHash,
        contextBefore: _contextBefore,
        contextAfter: _contextAfter,
        ...business
    } = value as Record<string, unknown>;
    return business;
}

/** Compare everything except anchor fields legitimately changed by a source edit. */
export function sameConversionBusinessSnapshot(expected: unknown, current: unknown): boolean {
    return canonicalJson(withoutMutableAnchor(expected)) === canonicalJson(withoutMutableAnchor(current));
}
