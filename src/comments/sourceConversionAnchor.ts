// SPDX-License-Identifier: MPL-2.0

/** Minimum source coordinates needed to identify code outside a comment. */
export interface SourceCommentRangeLike {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
}

export type ConversionSourceDisposition = 'keep' | 'remove';

function sourceLines(source: string): string[] {
    return source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Return the non-comment text remaining on one line. Removing ranges from
 * right to left keeps all UTF-16 character coordinates stable.
 */
function codeOutsideComments(line: number, text: string, comments: readonly SourceCommentRangeLike[]): string {
    const ranges = comments
        .filter((comment) => line >= comment.startLine && line <= comment.endLine)
        .map((comment) => {
            const start = line === comment.startLine ? comment.startCharacter : 0;
            const end = line === comment.endLine ? comment.endCharacter : text.length;
            return { start: Math.max(0, start), end: Math.min(text.length, end) };
        })
        .sort((left, right) => right.start - left.start);

    return ranges.reduce((remaining, range) => {
        if (range.end <= range.start) {
            return remaining;
        }
        return `${remaining.slice(0, range.start)}${remaining.slice(range.end)}`;
    }, text);
}

/**
 * Pick a useful annotation anchor after a source comment is converted.
 * Inline comments stay on their code line. Standalone comments prefer the
 * next real code line, then the previous one, and only fall back to their
 * original line when the file contains no code at all.
 */
export function chooseConvertedAnnotationLine(
    source: string,
    converted: SourceCommentRangeLike,
    allComments: readonly SourceCommentRangeLike[]
): number {
    const lines = sourceLines(source);
    if (lines.length === 0) {
        return 0;
    }

    const startLine = Math.max(0, Math.min(converted.startLine, lines.length - 1));
    const endLine = Math.max(startLine, Math.min(converted.endLine, lines.length - 1));

    if (codeOutsideComments(startLine, lines[startLine] ?? '', allComments).trim().length > 0) {
        return startLine;
    }
    if (endLine !== startLine && codeOutsideComments(endLine, lines[endLine] ?? '', allComments).trim().length > 0) {
        return endLine;
    }

    for (let line = endLine + 1; line < lines.length; line++) {
        if (codeOutsideComments(line, lines[line] ?? '', allComments).trim().length > 0) {
            return line;
        }
    }
    for (let line = startLine - 1; line >= 0; line--) {
        if (codeOutsideComments(line, lines[line] ?? '', allComments).trim().length > 0) {
            return line;
        }
    }
    return startLine;
}

/**
 * Keeping a standalone source comment must keep the legacy comment-line
 * anchor so the scanner's line/range duplicate check finds it on reruns.
 * Once the source is removed, choose a nearby surviving code line instead.
 */
export function chooseConversionAnnotationLine(
    source: string,
    converted: SourceCommentRangeLike,
    allComments: readonly SourceCommentRangeLike[],
    disposition: ConversionSourceDisposition
): number {
    return disposition === 'keep' ? converted.startLine : chooseConvertedAnnotationLine(source, converted, allComments);
}
