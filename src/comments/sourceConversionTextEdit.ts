// SPDX-License-Identifier: MPL-2.0

export interface MinimalTextReplacement {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly text: string;
}

function splitsSurrogatePair(value: string, offset: number): boolean {
    if (offset <= 0 || offset >= value.length) {
        return false;
    }
    const before = value.charCodeAt(offset - 1);
    const after = value.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function splitsCrLf(value: string, offset: number): boolean {
    return offset > 0 && offset < value.length && value[offset - 1] === '\r' && value[offset] === '\n';
}

/**
 * Compute one minimal UTF-16 replacement without splitting a surrogate pair
 * or CRLF sequence. A narrow rollback edit avoids whole-document replace
 * events being misclassified as cross-file paste operations.
 */
export function minimalTextReplacement(current: string, target: string): MinimalTextReplacement | undefined {
    if (current === target) {
        return undefined;
    }

    let startOffset = 0;
    const sharedLength = Math.min(current.length, target.length);
    while (startOffset < sharedLength && current[startOffset] === target[startOffset]) {
        startOffset++;
    }
    while (
        startOffset > 0 &&
        (splitsSurrogatePair(current, startOffset) ||
            splitsSurrogatePair(target, startOffset) ||
            splitsCrLf(current, startOffset) ||
            splitsCrLf(target, startOffset))
    ) {
        startOffset--;
    }

    let sharedSuffix = 0;
    while (
        sharedSuffix < current.length - startOffset &&
        sharedSuffix < target.length - startOffset &&
        current[current.length - 1 - sharedSuffix] === target[target.length - 1 - sharedSuffix]
    ) {
        sharedSuffix++;
    }

    let endOffset = current.length - sharedSuffix;
    let targetEndOffset = target.length - sharedSuffix;
    while (
        sharedSuffix > 0 &&
        (splitsSurrogatePair(current, endOffset) ||
            splitsSurrogatePair(target, targetEndOffset) ||
            splitsCrLf(current, endOffset) ||
            splitsCrLf(target, targetEndOffset))
    ) {
        sharedSuffix--;
        endOffset++;
        targetEndOffset++;
    }

    return {
        startOffset,
        endOffset,
        text: target.slice(startOffset, targetEndOffset),
    };
}
