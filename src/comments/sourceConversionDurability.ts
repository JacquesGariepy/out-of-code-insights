// SPDX-License-Identifier: MPL-2.0

/** Exact guard used before a rollback is allowed to mutate source text. */
export function sourceStateStillMatches(
    expectedVersion: number,
    expectedText: string,
    currentVersion: number,
    currentText: string
): boolean {
    return currentVersion === expectedVersion && currentText === expectedText;
}

/**
 * A removed representation may be restored conservatively only when every
 * recorded id is still absent. A duplicate is safer than losing both sides.
 */
export function allConversionSnapshotsAbsent(expectedIds: readonly string[], presentIds: readonly string[]): boolean {
    if (expectedIds.length === 0) {
        return false;
    }
    const present = new Set(presentIds);
    return expectedIds.every((id) => !present.has(id));
}
