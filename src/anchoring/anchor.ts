import { diffArrays } from 'diff';

/**
 * Minimal document interface required by captureAnchor and findAnchor.
 * vscode.TextDocument satisfies this structurally, so production callers
 * pass it unchanged.  Tests pass plain objects without importing vscode.
 */
export interface TextDocumentLike {
    readonly lineCount: number;
    lineAt(line: number): { readonly text: string };
}

// FNV-1a 32-bit constants (offset basis and prime)
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Hash of an empty/whitespace-only line. Equals the FNV-1a offset basis
 * because the inner loop runs zero times. Used as a sentinel to detect
 * legacy/corrupted anchors (the original bug: every annotation persisted
 * with this hash because the cursor was on a blank line at creation).
 */
export const EMPTY_LINE_HASH = '811c9dc5';

/**
 * Strips leading/trailing whitespace and collapses internal runs of
 * whitespace to a single space.  Used before hashing and context
 * comparison so that re-indentation does not break anchors.
 */
export function normalizeLine(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

/**
 * FNV-1a 32-bit hash of the normalized line text, returned as an
 * 8-character lowercase hex string.
 *
 * Note: hashLine('') === EMPTY_LINE_HASH. Callers that anchor user
 * intent (annotation creation) must reject this value or walk to a
 * non-empty target instead. captureAnchor handles this automatically.
 */
export function hashLine(text: string): string {
    const normalized = normalizeLine(text);
    let hash = FNV_OFFSET >>> 0;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        // Math.imul performs 32-bit integer multiplication; >>> 0 keeps it unsigned.
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** True when the hash equals the FNV offset basis -- i.e. an empty/blank line. */
export function isEmptyLineHash(hash: string | undefined | null): boolean {
    return hash === EMPTY_LINE_HASH;
}

/** Snapshot stored alongside each annotation to re-locate it later. */
export interface AnchorData {
    lineHash: string;
    contextBefore: string[];
    contextAfter: string[];
    /**
     * The line actually used to compute lineHash. May differ from the
     * caller's requested line when captureAnchor walked away from a
     * blank line to a nearby non-empty line.
     */
    targetLine?: number;
    /**
     * The original requested line (the cursor position), preserved for
     * diagnostics even when targetLine differs.
     */
    originalLine?: number;
}

/** Options accepted by captureAnchor. */
export interface CaptureOptions {
    /** Lines of context recorded before and after the target. Default 3. */
    contextSize?: number;
    /**
     * If the requested line is blank, walk forward up to this many lines
     * looking for a non-empty target. Default 5. Pass 0 to disable.
     */
    walkForward?: number;
    /**
     * If forward walk found nothing, walk backward up to this many lines.
     * Default 3. Pass 0 to disable.
     */
    walkBackward?: number;
}

function isBlankAt(doc: TextDocumentLike, i: number): boolean {
    if (i < 0 || i >= doc.lineCount) { return true; }
    return normalizeLine(doc.lineAt(i).text) === '';
}

/**
 * Capture an anchor snapshot for the given line in a document.
 *
 * If the requested line is blank, the function walks forward (then backward)
 * to a nearby non-empty line and anchors there instead. This prevents the
 * common-case bug where a user adds an annotation on the empty line above
 * a function and the anchor degenerates to EMPTY_LINE_HASH (which is the
 * same value for every blank line in every file).
 *
 * The optional 2nd argument may be a number (legacy: contextSize only) or
 * a CaptureOptions object.
 */
export function captureAnchor(
    doc: TextDocumentLike,
    line: number,
    optionsOrSize?: number | CaptureOptions
): AnchorData {
    const opts: CaptureOptions =
        typeof optionsOrSize === 'number'
            ? { contextSize: optionsOrSize }
            : optionsOrSize ?? {};
    const contextSize = opts.contextSize ?? 3;
    const walkForward = opts.walkForward ?? 5;
    const walkBackward = opts.walkBackward ?? 3;

    const lineCount = doc.lineCount;
    const originalLine = line;

    // Walk to a non-empty target if the requested line is blank. This is
    // the fix for the "all annotations share lineHash 811c9dc5" data-corruption
    // bug: cursors land on blank lines between functions far more often than
    // users realize, and an empty-line hash is useless as a durable anchor.
    let targetLine = line;
    if (isBlankAt(doc, targetLine)) {
        let walked = false;
        for (let d = 1; d <= walkForward; d++) {
            const i = originalLine + d;
            if (i < lineCount && !isBlankAt(doc, i)) {
                targetLine = i;
                walked = true;
                break;
            }
        }
        if (!walked) {
            for (let d = 1; d <= walkBackward; d++) {
                const i = originalLine - d;
                if (i >= 0 && !isBlankAt(doc, i)) {
                    targetLine = i;
                    break;
                }
            }
        }
    }

    const lineText =
        targetLine >= 0 && targetLine < lineCount ? doc.lineAt(targetLine).text : '';

    const contextBefore: string[] = [];
    const beforeStart = Math.max(0, targetLine - contextSize);
    for (let i = beforeStart; i < targetLine; i++) {
        contextBefore.push(normalizeLine(doc.lineAt(i).text));
    }

    const contextAfter: string[] = [];
    const afterEnd = Math.min(lineCount - 1, targetLine + contextSize);
    for (let i = targetLine + 1; i <= afterEnd; i++) {
        contextAfter.push(normalizeLine(doc.lineAt(i).text));
    }

    return {
        lineHash: hashLine(lineText),
        contextBefore,
        contextAfter,
        targetLine,
        originalLine,
    };
}

/** Options for findAnchor. */
export interface FindAnchorOptions {
    /**
     * When the score-based search finds no candidate above threshold, fall
     * back to the (sole) line that has a matching hash if exactly one such
     * line exists. Useful for re-locating annotations after Alt+Up/Down line
     * swaps (where context no longer aligns but the line content itself is
     * still unique). Empty-line hashes are excluded from this fallback
     * regardless. Default: false (opt-in).
     */
    allowUniqueHashFallback?: boolean;
}

/**
 * Try to find where an annotated line moved to inside a document.
 *
 * Algorithm:
 *   1. Reject degenerate anchors (empty-line hash + no meaningful context):
 *      these match every blank line in every file and cannot be re-located
 *      with any confidence.
 *   2. Fast path: if storedLine still matches lineHash, return it immediately.
 *   3. Scan the full document for every line whose hash matches.
 *   4. Score each candidate: +2 for each surrounding context line that also
 *      matches (max score = 2 * (contextBefore.length + contextAfter.length)).
 *   5. Return the highest-scoring candidate if score >= threshold.
 *   6. (Opt-in) If exactly ONE line has the matching hash and the hash is
 *      meaningful, return that line even with low context score.
 *
 * Returns null when the anchor cannot be resolved with sufficient confidence.
 */
export function findAnchor(
    doc: TextDocumentLike,
    anchor: AnchorData,
    storedLine = -1,
    options: FindAnchorOptions = {}
): number | null {
    const lineCount = doc.lineCount;

    // Reject empty-hash anchors with no meaningful context. They match every
    // blank line and produce arbitrary results -- the symptom that caused
    // annotations to migrate to unrelated symbols after edits.
    const meaningfulBefore = anchor.contextBefore.filter(l => l !== '').length;
    const meaningfulAfter = anchor.contextAfter.filter(l => l !== '').length;
    if (
        anchor.lineHash === EMPTY_LINE_HASH &&
        meaningfulBefore + meaningfulAfter === 0
    ) {
        return null;
    }

    // Fast path: stored position still valid
    if (storedLine >= 0 && storedLine < lineCount) {
        if (hashLine(doc.lineAt(storedLine).text) === anchor.lineHash) {
            return storedLine;
        }
    }

    // Adaptive score threshold: empty lines ('') are ubiquitous and add noise, not
    // signal.  Count only meaningful (non-empty) context entries to set the bar.
    const meaningfulCtx = meaningfulBefore + meaningfulAfter;
    // threshold=4 needs 2+ meaningful lines; relax to 2 when context is sparse.
    // For empty-hash anchors we already required >=1 meaningful context above,
    // so demand the strict threshold to avoid false positives at every blank line.
    const scoreThreshold =
        anchor.lineHash === EMPTY_LINE_HASH
            ? 4
            : meaningfulCtx >= 2 ? 4 : 2;

    let bestLine = -1;
    let bestScore = -1;
    let candidateCount = 0;
    let lastCandidate = -1;

    for (let i = 0; i < lineCount; i++) {
        if (hashLine(doc.lineAt(i).text) !== anchor.lineHash) {
            continue;
        }
        candidateCount++;
        lastCandidate = i;

        let score = 0;

        // Score lines before the candidate -- skip empty context slots (too ambiguous)
        const beforeStart = i - anchor.contextBefore.length;
        for (let j = 0; j < anchor.contextBefore.length; j++) {
            if (anchor.contextBefore[j] === '') { continue; }
            const docIdx = beforeStart + j;
            if (
                docIdx >= 0 &&
                normalizeLine(doc.lineAt(docIdx).text) === anchor.contextBefore[j]
            ) {
                score += 2;
            }
        }

        // Score lines after the candidate -- same rule
        for (let j = 0; j < anchor.contextAfter.length; j++) {
            if (anchor.contextAfter[j] === '') { continue; }
            const docIdx = i + 1 + j;
            if (
                docIdx < lineCount &&
                normalizeLine(doc.lineAt(docIdx).text) === anchor.contextAfter[j]
            ) {
                score += 2;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestLine = i;
        }
    }

    if (bestScore >= scoreThreshold) {
        return bestLine;
    }

    // Opt-in fallback: when the line hash matches EXACTLY ONE position in the
    // document and that hash is meaningful, trust it even with low context
    // score. Used by the runtime resolver to handle Alt+Up/Down line swaps
    // (where the diff treats one swapped line as "unchanged" and contextBefore
    // no longer aligns). Default-off so cut-relocate / paste-recovery paths
    // can still reject ambiguous matches.
    if (
        options.allowUniqueHashFallback &&
        candidateCount === 1 &&
        anchor.lineHash !== EMPTY_LINE_HASH
    ) {
        return lastCandidate;
    }

    return null;
}

/** A block of lines that was moved from one location to another. */
export interface MovedBlock {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

/**
 * Detect blocks of lines that were moved between oldLines and newLines.
 *
 * Uses the Myers diff algorithm (via the 'diff' package) to identify
 * removed and added hunks, then pairs hunks whose normalized content is
 * identical -- those pairs are reported as moves.
 *
 * This covers cut+paste and drag-and-drop scenarios where a block
 * disappears from one location and reappears at another.
 */
export function detectMoves(oldLines: string[], newLines: string[]): MovedBlock[] {
    // Normalize before diffing so re-indented moves are still detected
    const normalOld = oldLines.map(normalizeLine);
    const normalNew = newLines.map(normalizeLine);

    const changes = diffArrays(normalOld, normalNew);

    interface RawBlock {
        lines: string[];
        start: number;
        end: number;
    }

    const removedBlocks: RawBlock[] = [];
    const addedBlocks: RawBlock[] = [];
    let oldPos = 0;
    let newPos = 0;

    for (const change of changes) {
        // count should always equal value.length for diffArrays, but guard anyway
        const count = change.count ?? change.value.length;
        if (change.removed) {
            removedBlocks.push({ lines: change.value, start: oldPos, end: oldPos + count - 1 });
            oldPos += count;
        } else if (change.added) {
            addedBlocks.push({ lines: change.value, start: newPos, end: newPos + count - 1 });
            newPos += count;
        } else {
            oldPos += count;
            newPos += count;
        }
    }

    const moves: MovedBlock[] = [];
    const usedAdded = new Set<number>();

    for (const rem of removedBlocks) {
        const key = rem.lines.join('\n');
        for (let ai = 0; ai < addedBlocks.length; ai++) {
            if (usedAdded.has(ai)) {
                continue;
            }
            if (addedBlocks[ai].lines.join('\n') === key) {
                moves.push({
                    oldStart: rem.start,
                    oldEnd: rem.end,
                    newStart: addedBlocks[ai].start,
                    newEnd: addedBlocks[ai].end,
                });
                usedAdded.add(ai);
                break;
            }
        }
    }

    return moves;
}
