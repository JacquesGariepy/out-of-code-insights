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
    if (i < 0 || i >= doc.lineCount) {
        return true;
    }
    return normalizeLine(doc.lineAt(i).text) === '';
}

/**
 * Count how many lines in `doc` hash to `hash`, with an early exit once the
 * count reaches `earlyExitAt`. Used to gate fast-path returns: when the same
 * hash appears at multiple lines (CSV duplicates, identical HTML siblings,
 * repeated separators), trusting the stored index can silently anchor to the
 * wrong row -- callers must fall through to the context-scored scan instead.
 */
function countHashHits(doc: TextDocumentLike, hash: string, earlyExitAt = 2): number {
    let count = 0;
    const n = doc.lineCount;
    for (let i = 0; i < n; i++) {
        if (hashLine(doc.lineAt(i).text) === hash) {
            count++;
            if (count >= earlyExitAt) {
                return count;
            }
        }
    }
    return count;
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
        typeof optionsOrSize === 'number' ? { contextSize: optionsOrSize } : (optionsOrSize ?? {});
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

    const lineText = targetLine >= 0 && targetLine < lineCount ? doc.lineAt(targetLine).text : '';

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

function scoreAnchorContextAtLine(doc: TextDocumentLike, anchor: AnchorData, line: number): number {
    let score = 0;

    const beforeStart = line - anchor.contextBefore.length;
    for (let j = 0; j < anchor.contextBefore.length; j++) {
        if (anchor.contextBefore[j] === '') {
            continue;
        }
        const docIdx = beforeStart + j;
        if (docIdx >= 0 && normalizeLine(doc.lineAt(docIdx).text) === anchor.contextBefore[j]) {
            score += 2;
        }
    }

    for (let j = 0; j < anchor.contextAfter.length; j++) {
        if (anchor.contextAfter[j] === '') {
            continue;
        }
        const docIdx = line + 1 + j;
        if (docIdx < doc.lineCount && normalizeLine(doc.lineAt(docIdx).text) === anchor.contextAfter[j]) {
            score += 2;
        }
    }

    return score;
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
    const meaningfulBefore = anchor.contextBefore.filter((l) => l !== '').length;
    const meaningfulAfter = anchor.contextAfter.filter((l) => l !== '').length;
    if (anchor.lineHash === EMPTY_LINE_HASH && meaningfulBefore + meaningfulAfter === 0) {
        return null;
    }

    const meaningfulCtx = meaningfulBefore + meaningfulAfter;
    // threshold=4 needs 2+ meaningful lines; relax to 2 when context is sparse.
    // For empty-hash anchors we already required >=1 meaningful context above,
    // so demand the strict threshold to avoid false positives at every blank line.
    const scoreThreshold = anchor.lineHash === EMPTY_LINE_HASH ? 4 : meaningfulCtx >= 2 ? 4 : 2;

    // Fast path: stored position still valid. Gated on hash uniqueness so an
    // identical-but-unrelated line at storedLine (CSV duplicates, identical
    // HTML siblings, repeated separators) does not silently anchor to the
    // wrong row -- when collisions exist we fall through to the context-scored
    // scan below.
    if (storedLine >= 0 && storedLine < lineCount) {
        if (hashLine(doc.lineAt(storedLine).text) === anchor.lineHash) {
            if (anchor.lineHash !== EMPTY_LINE_HASH) {
                if (countHashHits(doc, anchor.lineHash) === 1) {
                    return storedLine;
                }
                // hash ambiguous -> fall through to context-scored scan
            } else if (scoreAnchorContextAtLine(doc, anchor, storedLine) >= scoreThreshold) {
                return storedLine;
            }
        }
    }

    // Adaptive score threshold: empty lines ('') are ubiquitous and add noise, not
    // signal.  Count only meaningful (non-empty) context entries to set the bar.
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

        const score = scoreAnchorContextAtLine(doc, anchor, i);

        if (score > bestScore) {
            bestScore = score;
            bestLine = i;
        }
    }

    if (bestScore >= scoreThreshold) {
        // Stickiness: when storedLine still holds the hash, its context score
        // is non-trivial, and bestLine is BELOW storedLine within 2 points,
        // prefer storedLine. Direction matters: a lower bestLine means rows
        // above were deleted and the anchor truly slid up (CSV duplicate
        // removal), so trust bestLine. A higher bestLine means rows or
        // boundary markers shifted down below the anchor (appending a 6th
        // identical item) -- the user's row index didn't actually move.
        if (
            bestLine !== storedLine &&
            bestLine > storedLine &&
            storedLine >= 0 &&
            storedLine < lineCount &&
            hashLine(doc.lineAt(storedLine).text) === anchor.lineHash
        ) {
            const storedScore = scoreAnchorContextAtLine(doc, anchor, storedLine);
            if (storedScore >= 2 && storedScore + 2 >= bestScore) {
                return storedLine;
            }
        }
        return bestLine;
    }

    // Opt-in fallback: when the line hash matches EXACTLY ONE position in the
    // document and that hash is meaningful, trust it even with low context
    // score. Used by the runtime resolver to handle Alt+Up/Down line swaps
    // (where the diff treats one swapped line as "unchanged" and contextBefore
    // no longer aligns). Default-off so cut-relocate / paste-recovery paths
    // can still reject ambiguous matches.
    if (options.allowUniqueHashFallback && candidateCount === 1 && anchor.lineHash !== EMPTY_LINE_HASH) {
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

/** Outcome reported by `reanchor`. */
export type ReanchorStatus = 'matched' | 'moved' | 'orphan';

/**
 * Result of a re-anchor attempt.
 *
 * - `matched`: the stored line still holds the original content; no relocation needed.
 * - `moved`:   the original content was found at a different line; caller should adopt
 *              `newLine` and persist the refreshed `newHash` / `newContextBefore` /
 *              `newContextAfter`.
 * - `orphan`:  neither the stored line nor any other line in the document carries the
 *              expected hash with sufficient context confidence. Caller MUST NOT delete
 *              the annotation -- mark it orphaned and let the user re-attach manually.
 */
export interface ReanchorResult {
    status: ReanchorStatus;
    newLine?: number;
    newHash?: string;
    newContextBefore?: string[];
    newContextAfter?: string[];
}

/**
 * Minimal subset of `Annotation` consumed by `reanchor`. Kept structural so this
 * module stays free of cross-package imports (mirrors `TextDocumentLike`).
 */
export interface ReanchorInput {
    line: number;
    lineHash?: string;
    contextBefore?: string[];
    contextAfter?: string[];
}

/**
 * Re-anchor an annotation against the current state of `document`.
 *
 * Pipeline:
 *   1. Exact-hash fast path: if `document.lineAt(annotation.line)` still hashes
 *      to `annotation.lineHash`, report `matched` and return a refreshed snapshot
 *      so the caller can persist updated context.
 *   2. Fallback: full-document `findAnchor` (hash + context vote, unique-hash
 *      fallback enabled) covers code that was moved up or down -- including the
 *      drag-and-drop downward case where `detectMoves` mis-orients the diff.
 *      On success, report `moved` with a refreshed snapshot at the new line.
 *   3. Orphan: when neither path resolves, return `orphan`. The annotation is
 *      NOT mutated and MUST NOT be deleted by the caller -- it should be marked
 *      orphaned in the UI so the user can drag it back onto the right line.
 *
 * Pure: never mutates `annotation` or `document`.
 */
export function reanchor(annotation: ReanchorInput, document: TextDocumentLike): ReanchorResult {
    const storedLine = annotation.line;
    const storedHash = annotation.lineHash;

    // Degenerate input: no hash, or the universal blank-line hash. Nothing to
    // anchor against -- relocation would amount to picking a random blank line.
    if (!storedHash || storedHash === EMPTY_LINE_HASH) {
        return { status: 'orphan' };
    }

    const lineCount = document.lineCount;

    // Phase 1 -- exact match at the stored line. Gated on hash uniqueness for
    // the same reason as findAnchor's fast path: when an identical line at
    // storedLine could be a different logical row (CSV duplicates, identical
    // HTML siblings), let Phase 2's context-scored scan decide instead.
    if (
        storedLine >= 0 &&
        storedLine < lineCount &&
        hashLine(document.lineAt(storedLine).text) === storedHash &&
        countHashHits(document, storedHash) === 1
    ) {
        const refreshed = captureAnchor(document, storedLine, {
            walkForward: 0,
            walkBackward: 0,
        });
        return {
            status: 'matched',
            newLine: storedLine,
            newHash: refreshed.lineHash,
            newContextBefore: refreshed.contextBefore,
            newContextAfter: refreshed.contextAfter,
        };
    }

    // Phase 2 -- scan the document for the same hash, vote by context, accept
    // a unique-hash candidate even with a low context score (covers cut+paste
    // and drag-and-drop where neighbours no longer line up around the new
    // position).
    const anchor: AnchorData = {
        lineHash: storedHash,
        contextBefore: annotation.contextBefore ?? [],
        contextAfter: annotation.contextAfter ?? [],
    };
    const found = findAnchor(document, anchor, storedLine, {
        allowUniqueHashFallback: true,
    });
    if (found !== null && found >= 0 && found < lineCount) {
        const refreshed = captureAnchor(document, found, {
            walkForward: 0,
            walkBackward: 0,
        });
        // When the resolver lands on the same index the caller stored, the
        // line did not actually move (Phase 1 was gated by hash collisions
        // and findAnchor's stickiness brought us back). Report 'matched' so
        // callers can distinguish a true relocation from a stay-in-place.
        return {
            status: found === storedLine ? 'matched' : 'moved',
            newLine: found,
            newHash: refreshed.lineHash,
            newContextBefore: refreshed.contextBefore,
            newContextAfter: refreshed.contextAfter,
        };
    }

    // Phase 3 -- orphan: caller keeps the annotation in the model and renders
    // it with an orphaned badge; no deletion.
    return { status: 'orphan' };
}
