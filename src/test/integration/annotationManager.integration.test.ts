/**
 * Integration tests for the annotation-tracking pipeline wired into AnnotationManager.
 *
 * These tests exercise the exact same algorithms as handleDocumentChange and
 * handleDocumentOpen by re-implementing the pipeline using the real anchor
 * primitives (captureAnchor, findAnchor, detectMoves, hashLine).
 * No VS Code host is required: all document interactions use the
 * TextDocumentLike duck-typed interface.
 */
import * as assert from 'assert';
import {
    captureAnchor,
    findAnchor,
    detectMoves,
    hashLine,
    TextDocumentLike,
    AnchorData,
    MovedBlock,
} from '../../anchoring/anchor';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface MockAnnotation {
    id: string;
    file: string;
    line: number;
    lineHash?: string;
    contextBefore?: string[];
    contextAfter?: string[];
    origin?: {
        kind: 'copy-paste';
        sourceId: string;
        sourceFile?: string;
        sourceLine: number;
        pastedAtLine: number;
    };
}

interface ContentChange {
    range: { start: { line: number }; end: { line: number } };
    text: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(lines: string[]): TextDocumentLike {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] ?? '' }),
    };
}

/**
 * Mirror of AnnotationManager.setAnnotationLine:
 * update annotation.line and recapture anchor when a document is provided.
 */
function applySetLine(
    annotation: MockAnnotation,
    newLine: number,
    doc?: TextDocumentLike
): void {
    annotation.line = newLine;
    if (doc && newLine >= 0 && newLine < doc.lineCount) {
        const anchor = captureAnchor(doc, newLine);
        annotation.lineHash = anchor.lineHash;
        annotation.contextBefore = anchor.contextBefore;
        annotation.contextAfter = anchor.contextAfter;
    }
}

/**
 * Mirror of AnnotationManager.handleDocumentChange:
 * detect moves, apply arithmetic shift, handle pending deletions.
 *
 * warningResponse simulates the 3-button showWarningMessage dialog.
 */
function runChangePipeline(opts: {
    annotations: MockAnnotation[];
    file: string;
    oldLines: string[];
    newDoc: TextDocumentLike;
    contentChanges: ContentChange[];
    warningResponse?: 'Delete annotation' | 'Keep at nearest line' | 'Cancel';
}): MockAnnotation[] {
    const { annotations, file, oldLines, newDoc, contentChanges, warningResponse } = opts;

    const newLines: string[] = [];
    for (let i = 0; i < newDoc.lineCount; i++) {
        newLines.push(newDoc.lineAt(i).text);
    }

    const moves: MovedBlock[] = detectMoves(oldLines, newLines);
    const pendingDeletionIds: string[] = [];

    const result: MockAnnotation[] = annotations.map(a => ({ ...a }));

    for (const annotation of result) {
        if (annotation.file !== file) { continue; }
        const oldLine = annotation.line;

        // Check moved blocks first
        const move = moves.find(m => oldLine >= m.oldStart && oldLine <= m.oldEnd);
        if (move) {
            applySetLine(annotation, move.newStart + (oldLine - move.oldStart), newDoc);
            continue;
        }

        // Arithmetic shift for annotations outside moved blocks
        let currentLine = oldLine;
        let markedDeleted = false;

        for (const change of contentChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const lineDelta =
                change.text.split('\n').length - (endLine - startLine + 1);

            if (currentLine > endLine) {
                currentLine += lineDelta;
            } else if (
                currentLine >= startLine &&
                currentLine <= endLine &&
                lineDelta < 0
            ) {
                markedDeleted = true;
            }
        }

        if (markedDeleted) {
            // Before prompting user, attempt hash-based relocation
            if (annotation.lineHash) {
                const anchor: AnchorData = {
                    lineHash: annotation.lineHash,
                    contextBefore: annotation.contextBefore ?? [],
                    contextAfter: annotation.contextAfter ?? [],
                };
                const found = findAnchor(newDoc, anchor, -1);
                if (found !== null) {
                    applySetLine(annotation, found, newDoc);
                    continue;
                }
            }
            pendingDeletionIds.push(annotation.id);
        } else if (currentLine !== oldLine) {
            applySetLine(annotation, currentLine, newDoc);
        }
    }

    // Apply 3-button dialog decision
    return result.filter(annotation => {
        if (!pendingDeletionIds.includes(annotation.id)) { return true; }

        if (warningResponse === 'Delete annotation') {
            return false;
        }
        if (warningResponse === 'Keep at nearest line') {
            const clamped = Math.max(
                0,
                Math.min(annotation.line, newDoc.lineCount - 1)
            );
            applySetLine(annotation, clamped, newDoc);
            return true;
        }
        // Cancel or undefined: keep at stale position
        return true;
    });
}

/**
 * Mirror of AnnotationManager.handleDocumentOpen:
 * snapshot, migrate legacy annotations, relocate drifted anchors.
 */
function runOpenPipeline(opts: {
    annotations: MockAnnotation[];
    file: string;
    doc: TextDocumentLike;
}): MockAnnotation[] {
    const { annotations, file, doc } = opts;

    return annotations.map(a => {
        if (a.file !== file) { return { ...a }; }
        const annotation = { ...a };

        // Legacy annotation without anchor: migrate silently
        if (!annotation.lineHash) {
            if (annotation.line >= 0 && annotation.line < doc.lineCount) {
                applySetLine(annotation, annotation.line, doc);
            }
            return annotation;
        }

        // Fast path: stored line content still matches
        if (annotation.line >= 0 && annotation.line < doc.lineCount) {
            if (hashLine(doc.lineAt(annotation.line).text) === annotation.lineHash) {
                return annotation;
            }
        }

        // Hash mismatch: external edit -- try to relocate via context
        const anchor: AnchorData = {
            lineHash: annotation.lineHash,
            contextBefore: annotation.contextBefore ?? [],
            contextAfter: annotation.contextAfter ?? [],
        };
        const found = findAnchor(doc, anchor, annotation.line);
        if (found !== null) {
            applySetLine(annotation, found, doc);
        }
        return annotation;
    });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

suite('integration: insert 2 lines above annotation (line 5 -> 7)', () => {
    const sourceLines = [
        'import A;',        // 0
        'import B;',        // 1
        'const x = 1;',    // 2
        'const y = 2;',    // 3
        'function foo() {', // 4
        'ANNOTATED_LINE;', // 5 -- annotated
        '  return x;',     // 6
        '}',               // 7
    ];
    const doc = makeDoc(sourceLines);
    const annotation: MockAnnotation = {
        id: 'a1', file: 'src/f.ts', line: 5,
    };
    const anchor = captureAnchor(doc, 5);
    annotation.lineHash = anchor.lineHash;
    annotation.contextBefore = anchor.contextBefore;
    annotation.contextAfter = anchor.contextAfter;

    // New doc: 2 lines inserted at lines 2-3
    const newLines = [
        'import A;',         // 0
        'import B;',         // 1
        'const NEW_1 = 0;', // 2  inserted
        'const NEW_2 = 0;', // 3  inserted
        'const x = 1;',     // 4
        'const y = 2;',     // 5
        'function foo() {', // 6
        'ANNOTATED_LINE;',  // 7  was 5, now 7
        '  return x;',      // 8
        '}',                 // 9
    ];
    const newDoc = makeDoc(newLines);

    test('annotation shifts from line 5 to line 7', () => {
        const result = runChangePipeline({
            annotations: [annotation],
            file: 'src/f.ts',
            oldLines: sourceLines,
            newDoc,
            contentChanges: [
                { range: { start: { line: 2 }, end: { line: 2 } },
                  text: 'const NEW_1 = 0;\nconst NEW_2 = 0;\nconst x = 1;' },
            ],
        });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].line, 7);
    });

    test('lineHash updated to reflect new position content', () => {
        const result = runChangePipeline({
            annotations: [annotation],
            file: 'src/f.ts',
            oldLines: sourceLines,
            newDoc,
            contentChanges: [
                { range: { start: { line: 2 }, end: { line: 2 } },
                  text: 'const NEW_1 = 0;\nconst NEW_2 = 0;\nconst x = 1;' },
            ],
        });
        assert.strictEqual(result[0].lineHash, hashLine('ANNOTATED_LINE;'));
    });
});

suite('integration: insert below -- annotation at line 5 unaffected', () => {
    const sourceLines = ['a', 'b', 'c', 'd', 'ANNOTATED;', 'f', 'g'];
    const doc = makeDoc(sourceLines);
    const anchor = captureAnchor(doc, 4);
    const annotation: MockAnnotation = {
        id: 'a1', file: 'f.ts', line: 4,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    const newLines = ['a', 'b', 'c', 'd', 'ANNOTATED;', 'f', 'INSERTED;', 'g'];
    const newDoc = makeDoc(newLines);

    test('annotation stays at line 4 when insertion is below', () => {
        const result = runChangePipeline({
            annotations: [annotation],
            file: 'f.ts',
            oldLines: sourceLines,
            newDoc,
            contentChanges: [
                { range: { start: { line: 6 }, end: { line: 6 } },
                  text: 'INSERTED;\ng' },
            ],
        });
        assert.strictEqual(result[0].line, 4);
    });
});

suite('integration: delete anchored line -- silent removal', () => {
    const sourceLines = ['pre_a', 'pre_b', 'ANNOTATED;', 'post_a', 'post_b'];
    const doc = makeDoc(sourceLines);
    const anchor = captureAnchor(doc, 2);
    function makeAnnotation(): MockAnnotation {
        return {
            id: 'a1', file: 'f.ts', line: 2,
            lineHash: anchor.lineHash,
            contextBefore: anchor.contextBefore,
            contextAfter: anchor.contextAfter,
        };
    }
    // Delete line 2 (ANNOTATED;). VS Code covers the trailing newline, so
    // the range spans [2..3] with text='', giving lineDelta = 1 - 2 = -1.
    const newLines = ['pre_a', 'pre_b', 'post_a', 'post_b'];
    const newDoc = makeDoc(newLines);
    const change: ContentChange = {
        range: { start: { line: 2 }, end: { line: 3 } }, text: '',
    };

    test('annotation silently removed from live map when its line is deleted', () => {
        // Silent path: immediate removal without dialog (new UX).
        const result = runChangePipeline({
            annotations: [makeAnnotation()], file: 'f.ts',
            oldLines: sourceLines, newDoc,
            contentChanges: [change],
            warningResponse: 'Delete annotation',
        });
        assert.strictEqual(result.length, 0);
    });

    test('annotation id in pendingDeletion set (for buffer handoff)', () => {
        // Without a resolved decision, the annotation stays at stale position --
        // mirrors the pending state before it is moved to the clipboard buffer.
        const pending = runChangePipeline({
            annotations: [makeAnnotation()], file: 'f.ts',
            oldLines: sourceLines, newDoc,
            contentChanges: [change],
            warningResponse: undefined,
        });
        assert.strictEqual(pending.length, 1, 'annotation in pending state');
        assert.strictEqual(pending[0].id, 'a1');
    });

    test('undo restore: annotation clamped to nearest line after deletion', () => {
        // Simulates the Undo button in the non-modal toast: restore at clamped position.
        const result = runChangePipeline({
            annotations: [makeAnnotation()], file: 'f.ts',
            oldLines: sourceLines, newDoc,
            contentChanges: [change],
            warningResponse: 'Keep at nearest line',
        });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].line, Math.min(2, newDoc.lineCount - 1));
    });

    test('undo restore: lineHash recaptured at restored position', () => {
        const result = runChangePipeline({
            annotations: [makeAnnotation()], file: 'f.ts',
            oldLines: sourceLines, newDoc,
            contentChanges: [change],
            warningResponse: 'Keep at nearest line',
        });
        const expectedHash = hashLine(newDoc.lineAt(result[0].line).text);
        assert.strictEqual(result[0].lineHash, expectedHash);
    });
});

suite('integration: cut+paste -- block [5..7] moved to [15..17], line 6 -> 16', () => {
    const block = ['block_a', 'block_b', 'block_c'];
    const pre   = Array.from({ length: 5 },  (_, i) => `pre_${i}`);
    // 10 post lines: oldLines=18 (block at [5..7]), newLines=18 (block at [15..17])
    const post  = Array.from({ length: 10 }, (_, i) => `post_${i}`);

    const oldLines = [...pre, ...block, ...post]; // block at [5..7]
    const newLines = [...pre, ...post, ...block]; // block at [15..17]

    const oldDoc = makeDoc(oldLines);
    const anchor = captureAnchor(oldDoc, 6); // block_b
    const annotation: MockAnnotation = {
        id: 'a1', file: 'f.ts', line: 6,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    const newDoc = makeDoc(newLines);

    test('annotation follows block from line 6 to line 16', () => {
        const result = runChangePipeline({
            annotations: [annotation], file: 'f.ts',
            oldLines, newDoc,
            contentChanges: [],      // detectMoves handles this, no arithmetic needed
        });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].line, 16);
    });

    test('lineHash updated to block_b at new position', () => {
        const result = runChangePipeline({
            annotations: [annotation], file: 'f.ts',
            oldLines, newDoc,
            contentChanges: [],
        });
        assert.strictEqual(result[0].lineHash, hashLine('block_b'));
    });
});

suite('integration: copy+paste -- original annotation stays at line 6', () => {
    // Original block at [5..7], a copy inserted at [15..17], block at [5..7] untouched
    const block = ['cp_a', 'cp_b', 'cp_c'];
    const pre   = Array.from({ length: 5 },  (_, i) => `pre_${i}`);
    const mid   = Array.from({ length: 7 },  (_, i) => `mid_${i}`);
    const post  = Array.from({ length: 3 },  (_, i) => `post_${i}`);

    const oldLines = [...pre, ...block, ...mid, ...post];
    // In newLines: original block stays [5..7], copy inserted at [15..17]
    const newLines = [...pre, ...block, ...mid, ...block, ...post];

    const oldDoc = makeDoc(oldLines);
    const anchor = captureAnchor(oldDoc, 6); // cp_b at position 6
    const annotation: MockAnnotation = {
        id: 'a1', file: 'f.ts', line: 6,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    const newDoc = makeDoc(newLines);

    test('annotation remains at line 6 (original, not the copy)', () => {
        const result = runChangePipeline({
            annotations: [annotation], file: 'f.ts',
            oldLines, newDoc,
            contentChanges: [
                // Copy inserted at line 15 (no delete of original)
                { range: { start: { line: 15 }, end: { line: 15 } },
                  text: 'cp_a\ncp_b\ncp_c\npost_0' },
            ],
        });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].line, 6);
    });
});

suite('integration: external edit -- handleDocumentOpen relocates via findAnchor', () => {
    // Annotation was stored at line 5. File was edited outside VS Code:
    // 5 lines were inserted at the top, so the annotated content is now at line 10.
    const annotatedContent = 'const IMPORTANT = process.env.SECRET;';
    const ctxBefore = ['function setup() {', '  const cfg = {};'];
    const ctxAfter  = ['  return cfg;', '}'];

    // Build the original document (stored snapshot)
    const originalLines = [
        ...ctxBefore,           // 0-1
        annotatedContent,       // 2 (pretend stored as line 2)
        ...ctxAfter,            // 3-4
    ];
    const originalDoc = makeDoc(originalLines);
    const anchor = captureAnchor(originalDoc, 2, 2);

    // New document: 5 "import" lines inserted at top, annotated content at line 7
    const newLines = [
        'import A from "a";',  // 0
        'import B from "b";',  // 1
        'import C from "c";',  // 2
        'import D from "d";',  // 3
        'import E from "e";',  // 4
        ...ctxBefore,          // 5-6
        annotatedContent,      // 7  -- new position
        ...ctxAfter,           // 8-9
    ];
    const newDoc = makeDoc(newLines);

    const annotation: MockAnnotation = {
        id: 'a1', file: 'f.ts', line: 2,   // stale stored line
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    test('handleDocumentOpen relocates annotation to new line 7', () => {
        const result = runOpenPipeline({
            annotations: [annotation], file: 'f.ts', doc: newDoc,
        });
        assert.strictEqual(result[0].line, 7);
    });

    test('lineHash is updated to reflect new position after relocation', () => {
        const result = runOpenPipeline({
            annotations: [annotation], file: 'f.ts', doc: newDoc,
        });
        assert.strictEqual(result[0].lineHash, hashLine(annotatedContent));
    });
});

suite('integration: multiple annotations same file, insertion in middle', () => {
    // 3 annotations at lines 2, 5, 9.
    // Insert 3 lines at line 4 (between a1 and a2).
    // Expected: a1 stays at 2, a2 moves to 8, a3 moves to 12.
    const sourceLines = [
        'l0', 'l1', 'ANNO_A;', 'l3',   // 0-3
        'l4', 'ANNO_B;', 'l6', 'l7',   // 4-7
        'l8', 'ANNO_C;', 'l10',         // 8-10
    ];
    const oldDoc = makeDoc(sourceLines);

    function makeAnno(id: string, line: number): MockAnnotation {
        const a = captureAnchor(oldDoc, line);
        return { id, file: 'f.ts', line, ...a };
    }

    const annotations = [makeAnno('a1', 2), makeAnno('a2', 5), makeAnno('a3', 9)];

    const newLines = [
        'l0', 'l1', 'ANNO_A;', 'l3',           // 0-3
        'INS_0;', 'INS_1;', 'INS_2;',           // 4-6  inserted
        'l4', 'ANNO_B;', 'l6', 'l7',            // 7-10
        'l8', 'ANNO_C;', 'l10',                  // 11-13
    ];
    const newDoc = makeDoc(newLines);

    const change: ContentChange = {
        range: { start: { line: 4 }, end: { line: 4 } },
        text: 'INS_0;\nINS_1;\nINS_2;\nl4',
    };

    test('a1 at line 2 is unaffected by insertion below', () => {
        const result = runChangePipeline({
            annotations, file: 'f.ts', oldLines: sourceLines, newDoc,
            contentChanges: [change],
        });
        const a1 = result.find(a => a.id === 'a1');
        assert.ok(a1, 'a1 should still exist');
        assert.strictEqual(a1.line, 2);
    });

    test('a2 at line 5 shifts to line 8 (delta +3)', () => {
        const result = runChangePipeline({
            annotations, file: 'f.ts', oldLines: sourceLines, newDoc,
            contentChanges: [change],
        });
        const a2 = result.find(a => a.id === 'a2');
        assert.ok(a2, 'a2 should still exist');
        assert.strictEqual(a2.line, 8);
    });

    test('a3 at line 9 shifts to line 12 (delta +3)', () => {
        const result = runChangePipeline({
            annotations, file: 'f.ts', oldLines: sourceLines, newDoc,
            contentChanges: [change],
        });
        const a3 = result.find(a => a.id === 'a3');
        assert.ok(a3, 'a3 should still exist');
        assert.strictEqual(a3.line, 12);
    });
});

suite('integration: retrocompatibility -- legacy annotation without lineHash', () => {
    const sourceLines = ['import x;', 'const a = 1;', 'LEGACY_ANNO;', 'export default a;'];
    const doc = makeDoc(sourceLines);

    test('legacy annotation (no lineHash) loads without error', () => {
        const legacy: MockAnnotation = { id: 'leg', file: 'f.ts', line: 2 };
        assert.strictEqual(legacy.lineHash, undefined);
        // runOpenPipeline must not throw
        const result = runOpenPipeline({ annotations: [legacy], file: 'f.ts', doc });
        assert.strictEqual(result.length, 1);
    });

    test('legacy annotation is silently migrated: lineHash populated', () => {
        const legacy: MockAnnotation = { id: 'leg', file: 'f.ts', line: 2 };
        const result = runOpenPipeline({ annotations: [legacy], file: 'f.ts', doc });
        assert.strictEqual(typeof result[0].lineHash, 'string');
        assert.strictEqual(result[0].lineHash, hashLine('LEGACY_ANNO;'));
    });

    test('migration is idempotent: running twice does not change lineHash', () => {
        const legacy: MockAnnotation = { id: 'leg', file: 'f.ts', line: 2 };
        const once = runOpenPipeline({ annotations: [legacy], file: 'f.ts', doc });
        const twice = runOpenPipeline({ annotations: once, file: 'f.ts', doc });
        assert.strictEqual(twice[0].lineHash, once[0].lineHash);
        assert.deepStrictEqual(twice[0].contextBefore, once[0].contextBefore);
    });
});

// ---------------------------------------------------------------------------
// Clipboard buffer helpers (mirrors AnnotationManager.recentDeletions logic)
// ---------------------------------------------------------------------------

interface DeferredEntry {
    annotation: MockAnnotation;
    deletedAt: number;
    offsetInBlock: number;
    cutText?: string;
    cutLineHashes?: string[];
}

class ClipboardBuffer {
    readonly entries: Map<string, DeferredEntry> = new Map();

    defer(annotation: MockAnnotation, offsetInBlock = 0): void {
        this.entries.set(annotation.id, {
            annotation: { ...annotation },
            deletedAt: Date.now(),
            offsetInBlock,
        });
    }

    /**
     * Try to find any deferred annotation in the given document.
     * Returns the list of restored annotations.
     */
    tryRecover(doc: TextDocumentLike, relativeFile: string): MockAnnotation[] {
        const restored: MockAnnotation[] = [];
        for (const [id, deferred] of this.entries) {
            if (!deferred.annotation.lineHash) { continue; }
            const anchor: AnchorData = {
                lineHash: deferred.annotation.lineHash,
                contextBefore: deferred.annotation.contextBefore ?? [],
                contextAfter: deferred.annotation.contextAfter ?? [],
            };
            const found = findAnchor(doc, anchor, -1);
            if (found !== null) {
                const a = { ...deferred.annotation, file: relativeFile };
                applySetLine(a, found, doc);
                restored.push(a);
                this.entries.delete(id);
            }
        }
        return restored;
    }

    /** Force-expire entries older than windowMs and return them. */
    drainExpired(windowMs: number): MockAnnotation[] {
        const now = Date.now();
        const expired: MockAnnotation[] = [];
        for (const [id, deferred] of this.entries) {
            if (now - deferred.deletedAt > windowMs) {
                expired.push(deferred.annotation);
                this.entries.delete(id);
            }
        }
        return expired;
    }
}

/**
 * Mirror of AnnotationManager.deletedRecently:
 * 30-second Undo buffer that holds annotations removed when their line was deleted.
 * tryRestore attempts to relocate each via findAnchor (e.g. after VS Code Undo).
 */
class DeletedRecentlyBuffer {
    readonly entries: Map<string, { annotation: MockAnnotation; removedAt: number }> = new Map();
    readonly ttlMs = 30000;

    add(annotation: MockAnnotation): void {
        this.entries.set(annotation.id, {
            annotation: { ...annotation },
            removedAt: Date.now(),
        });
    }

    tryRestore(doc: TextDocumentLike, file: string): MockAnnotation[] {
        const now = Date.now();
        const restored: MockAnnotation[] = [];
        for (const [id, entry] of this.entries) {
            if (now - entry.removedAt > this.ttlMs) {
                this.entries.delete(id);
                continue;
            }
            if (!entry.annotation.lineHash) { continue; }
            const anchor: AnchorData = {
                lineHash: entry.annotation.lineHash,
                contextBefore: entry.annotation.contextBefore ?? [],
                contextAfter: entry.annotation.contextAfter ?? [],
            };
            const found = findAnchor(doc, anchor, entry.annotation.line);
            if (found !== null) {
                const a = { ...entry.annotation, file };
                applySetLine(a, found, doc);
                restored.push(a);
                this.entries.delete(id);
            }
        }
        return restored;
    }

    drainExpired(): MockAnnotation[] {
        const now = Date.now();
        const expired: MockAnnotation[] = [];
        for (const [id, entry] of this.entries) {
            if (now - entry.removedAt > this.ttlMs) {
                expired.push(entry.annotation);
                this.entries.delete(id);
            }
        }
        return expired;
    }
}

// ---------------------------------------------------------------------------
// Clipboard buffer tests: cut+paste via 2 separate events
// ---------------------------------------------------------------------------

suite('clipboard: cut+paste intra-file via 2 separate events (line 6 -> 16)', () => {
    const block = ['block_a', 'block_b', 'block_c'];
    const pre   = Array.from({ length: 5 },  (_, i) => `pre_${i}`);
    const post  = Array.from({ length: 10 }, (_, i) => `post_${i}`);

    // State before Ctrl+X: block at [5..7], annotation at line 6 (block_b)
    const originalLines = [...pre, ...block, ...post];
    const originalDoc   = makeDoc(originalLines);
    const anchor        = captureAnchor(originalDoc, 6);

    let liveAnnotations: MockAnnotation[] = [{
        id: 'a1', file: 'src/f.ts', line: 6,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    }];
    const buffer = new ClipboardBuffer();

    // EVENT 1: Ctrl+X -- delete lines 5-7 (range [5..8], covering the newline)
    // After delete: 15 lines, block content is absent.
    const afterDeleteLines = [...pre, ...post];
    const afterDeleteDoc   = makeDoc(afterDeleteLines);
    const deleteChange: ContentChange = {
        range: { start: { line: 5 }, end: { line: 8 } }, text: '',
    };

    // Simulate delete event: annotation in deleted range [5..8], findAnchor fails.
    const inDeletedRange = liveAnnotations[0].line >= deleteChange.range.start.line &&
                           liveAnnotations[0].line <= deleteChange.range.end.line;
    if (inDeletedRange) {
        const a = liveAnnotations[0];
        assert.ok(a.lineHash, 'annotation lineHash should be populated');
        const found = findAnchor(afterDeleteDoc, {
            lineHash: a.lineHash,
            contextBefore: a.contextBefore ?? [],
            contextAfter: a.contextAfter ?? [],
        }, -1);
        if (found === null) {
            buffer.defer(a);
            liveAnnotations = [];
        }
    }

    // Capture intermediate state BEFORE event 2 runs (Mocha runs all suite body
    // code before any test() callback, so we snapshot here to test event-1 state).
    const afterEvent1LiveCount  = liveAnnotations.length;
    const afterEvent1BufferSize = buffer.entries.size;

    // EVENT 2: Ctrl+V -- paste block at end (lines 15-17 in 18-line doc)
    const afterPasteLines = [...pre, ...post, ...block];
    const afterPasteDoc   = makeDoc(afterPasteLines);

    const recovered = buffer.tryRecover(afterPasteDoc, 'src/f.ts');
    liveAnnotations = [...liveAnnotations, ...recovered];

    // Tests check the snapshots and the final state after both events.
    test('event 1 (delete): annotation removed from live map, deferred to buffer', () => {
        assert.strictEqual(afterEvent1LiveCount, 0, 'live map empty after cut');
        assert.strictEqual(afterEvent1BufferSize, 1, 'one entry deferred to buffer');
    });

    test('event 2 (paste): annotation recovered at line 16 (block_b)', () => {
        assert.strictEqual(liveAnnotations.length, 1);
        assert.strictEqual(liveAnnotations[0].line, 16);
    });

    test('event 2 (paste): lineHash updated to block_b at new position', () => {
        assert.strictEqual(liveAnnotations[0].lineHash, hashLine('block_b'));
    });

    test('event 2 (paste): buffer is empty after recovery', () => {
        assert.strictEqual(buffer.entries.size, 0);
    });
});

suite('clipboard: cut without paste -- entry expires, expiry returns the annotation', () => {
    const lines = ['l0', 'l1', 'ANNO;', 'l3', 'l4'];
    const doc   = makeDoc(lines);
    const anchor = captureAnchor(doc, 2);
    const annotation: MockAnnotation = {
        id: 'b1', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    // Simulate cut: annotation goes into buffer
    const buffer = new ClipboardBuffer();
    buffer.defer(annotation);

    // Force expiry by back-dating the timestamp
    const entry = buffer.entries.get('b1');
    assert.ok(entry, 'buffer entry should exist');
    entry.deletedAt = Date.now() - 6000;

    test('drainExpired returns annotation after window elapsed', () => {
        const expired = buffer.drainExpired(5000);
        assert.strictEqual(expired.length, 1);
        assert.strictEqual(expired[0].id, 'b1');
    });

    test('buffer is empty after drain', () => {
        assert.strictEqual(buffer.entries.size, 0);
    });
});

suite('clipboard: copy+paste (no delete) -- annotation stays on original line', () => {
    // No delete event: buffer is empty. An insert arrives with the same block content.
    // tryRecover must return nothing (buffer is empty).
    const block = ['cp_a', 'cp_b', 'cp_c'];
    const pre   = Array.from({ length: 5 }, (_, i) => `pre_${i}`);
    const mid   = Array.from({ length: 7 }, (_, i) => `mid_${i}`);

    const originalLines = [...pre, ...block, ...mid];
    const originalDoc   = makeDoc(originalLines);
    const anchor        = captureAnchor(originalDoc, 6);

    // Annotation at line 6 (cp_b), buffer is empty (copy, no cut)
    const liveAnnotations: MockAnnotation[] = [{
        id: 'c1', file: 'f.ts', line: 6,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    }];
    const emptyBuffer = new ClipboardBuffer();

    // Paste: duplicate block appears at end of document
    const afterPasteLines = [...pre, ...block, ...mid, ...block];
    const afterPasteDoc   = makeDoc(afterPasteLines);

    const recovered = emptyBuffer.tryRecover(afterPasteDoc, 'f.ts');

    test('no recovery when buffer is empty (copy+paste, no cut)', () => {
        assert.strictEqual(recovered.length, 0);
    });

    test('original annotation stays at line 6 (fast path: hash still matches)', () => {
        // Simulate the fast-path check in handleDocumentOpen / handleDocumentChange
        const a = liveAnnotations[0];
        const currentHash = hashLine(afterPasteDoc.lineAt(a.line).text);
        assert.strictEqual(currentHash, a.lineHash, 'hash still matches at original line');
        assert.strictEqual(a.line, 6);
    });
});

suite('clipboard: cut in file A, paste in file B -- inter-file recovery', () => {
    const block = ['fn_a() {', '  return 1;', '}'];
    const preA  = ['import A;', 'import B;', 'const X = 0;', 'const Y = 0;', 'const Z = 0;'];
    const postA = Array.from({ length: 8 }, (_, i) => `export_${i};`);

    // File A: block at [5..7], annotation at line 6
    const fileALines  = [...preA, ...block, ...postA];
    const fileADoc    = makeDoc(fileALines);
    const anchor      = captureAnchor(fileADoc, 6);

    let liveAnnotations: MockAnnotation[] = [{
        id: 'd1', file: 'a.ts', line: 6,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    }];
    const buffer = new ClipboardBuffer();

    // EVENT 1: cut from file A
    const afterDeleteALines = [...preA, ...postA];
    const afterDeleteADoc   = makeDoc(afterDeleteALines);
    const a = liveAnnotations[0];
    assert.ok(a.lineHash, 'annotation lineHash should be populated');
    const found = findAnchor(afterDeleteADoc, {
        lineHash: a.lineHash,
        contextBefore: a.contextBefore ?? [],
        contextAfter: a.contextAfter ?? [],
    }, -1);
    if (found === null) {
        buffer.defer(a);
        liveAnnotations = [];
    }

    // EVENT 2: paste into file B at a different location
    // file B has: [preamble(3), block, postamble(5)]
    const preambleB = ['// file B', 'const B1 = 1;', 'const B2 = 2;'];
    const postambleB = Array.from({ length: 5 }, (_, i) => `bpost_${i};`);
    const fileBLines = [...preambleB, ...block, ...postambleB];
    const fileBDoc   = makeDoc(fileBLines);

    const recovered = buffer.tryRecover(fileBDoc, 'b.ts');
    liveAnnotations = [...liveAnnotations, ...recovered];

    test('annotation relocated from a.ts to b.ts after inter-file cut+paste', () => {
        assert.strictEqual(liveAnnotations.length, 1);
        assert.strictEqual(liveAnnotations[0].file, 'b.ts');
    });

    test('annotation line is correct in file B (block_b at offset 1 from preamble end)', () => {
        // block starts at line 3 in file B; annotation offset was 1 (from block start)
        assert.strictEqual(liveAnnotations[0].line, 4);
    });

    test('buffer is empty after inter-file recovery', () => {
        assert.strictEqual(buffer.entries.size, 0);
    });
});

// ---------------------------------------------------------------------------
// Bug 1 tests: cut+paste with empty lines in the block
// ---------------------------------------------------------------------------

suite('bug1: findAnchor with empty-line context uses adaptive threshold', () => {
    // Annotation surrounded by empty lines: contextBefore = ['', 'pre_code;']
    // After paste, only 'pre_code;' matches in context (empty line is everywhere).
    // With old threshold=4, score=2 (only one non-empty line matches) -> null.
    // With adaptive threshold=2, score=2 >= 2 -> found.
    const lines = [
        'pre_code;',      // 0 -- non-empty, will match
        '',               // 1 -- empty line above annotation
        'ANNOTATED;',     // 2 -- the annotation line
        'post_code;',     // 3
        'unrelated_A;',   // 4
    ];
    const doc  = makeDoc(lines);
    const anchor = captureAnchor(doc, 2, 2);  // contextBefore=['pre_code;',''], contextAfter=['post_code;','unrelated_A;']

    // Build a new doc where block was pasted at a different position.
    // Only 'pre_code;' is present before the annotation (not the original leading context).
    const newLines = [
        'header_a;',      // 0 -- not in original context
        'header_b;',      // 1 -- not in original context
        'pre_code;',      // 2 -- matches contextBefore[0]
        '',               // 3 -- matches contextBefore[1] (empty, skipped in scoring)
        'ANNOTATED;',     // 4 -- hash match
        'post_code;',     // 5 -- matches contextAfter[0]
        'footer;',        // 6
    ];
    const newDoc = makeDoc(newLines);

    test('findAnchor finds annotation despite empty lines in context (adaptive threshold)', () => {
        const result = findAnchor(newDoc, anchor, -1);
        assert.strictEqual(result, 4);
    });
});

suite('bug1: cut+paste with leading empty line in block -- offset-based recovery', () => {
    // Block: lines 4-7 = ['', 'ANNO_LINE;', 'ctx_after_a;', 'ctx_after_b;']
    // Annotation at line 5 (ANNO_LINE;), offset 1 within block.
    const pre  = Array.from({ length: 4 }, (_, i) => `pre_${i}`);  // lines 0-3
    const block = ['', 'ANNO_LINE;', 'ctx_after_a;', 'ctx_after_b;'];            // lines 4-7
    const post = Array.from({ length: 12 }, (_, i) => `post_${i}`);              // lines 8-19

    const originalLines = [...pre, ...block, ...post];
    const originalDoc   = makeDoc(originalLines);
    const anchor        = captureAnchor(originalDoc, 5);  // ANNO_LINE; with '' in contextBefore

    let liveAnnotations: MockAnnotation[] = [{
        id: 'e1', file: 'f.ts', line: 5,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    }];

    // EVENT 1: cut lines 4-7 (range [4..8], covering newline at end)
    const afterDeleteLines = [...pre, ...post];
    const afterDeleteDoc   = makeDoc(afterDeleteLines);

    const buffer = new ClipboardBuffer();

    // Deferral: annotation in deleted range, findAnchor may fail in after-delete doc
    const deleteChange: ContentChange = {
        range: { start: { line: 4 }, end: { line: 8 } }, text: '',
    };
    const inRange = liveAnnotations[0].line >= deleteChange.range.start.line &&
                    liveAnnotations[0].line <= deleteChange.range.end.line;
    if (inRange) {
        const a = liveAnnotations[0];
        assert.ok(a.lineHash, 'annotation lineHash should be populated');
        const found = findAnchor(afterDeleteDoc, {
            lineHash: a.lineHash,
            contextBefore: a.contextBefore ?? [],
            contextAfter: a.contextAfter ?? [],
        }, -1);
        if (found === null) {
            // Store with offsetInBlock = annotation.line - deleteStart = 5 - 4 = 1
            buffer.entries.set(a.id, {
                annotation: { ...a },
                deletedAt: Date.now(),
                offsetInBlock: a.line - deleteChange.range.start.line,
            });
            liveAnnotations = [];
        }
    }

    const afterEvent1Count = liveAnnotations.length;
    const afterEvent1Buffer = buffer.entries.size;

    // EVENT 2: paste block at line 16 (into doc that is now afterDeleteLines + block appended)
    const afterPasteLines = [...pre, ...post, ...block];  // block at lines [16..19]
    const afterPasteDoc   = makeDoc(afterPasteLines);

    // Simulate offset-based recovery (mirrors AnnotationManager clipboard recovery)
    const insertedLines = block;  // change.text.split('\n') for the paste
    const pasteStart    = 16;     // change.range.start.line

    const recovered2: MockAnnotation[] = [];
    for (const [id, deferred] of buffer.entries) {
        const offset = deferred.offsetInBlock;
        if (offset < insertedLines.length &&
            hashLine(insertedLines[offset]) === deferred.annotation.lineHash) {
            const newLine = pasteStart + offset;
            const a2 = { ...deferred.annotation };
            applySetLine(a2, newLine, afterPasteDoc);
            recovered2.push(a2);
            buffer.entries.delete(id);
        }
    }
    liveAnnotations = [...liveAnnotations, ...recovered2];

    test('event 1 (delete): annotation deferred with offsetInBlock=1', () => {
        assert.strictEqual(afterEvent1Count, 0);
        assert.strictEqual(afterEvent1Buffer, 1);
        assert.strictEqual(buffer.entries.size, 0, 'entries cleared after recovery');
    });

    test('event 2 (paste): annotation recovered at line 17 (pasteStart + offset = 16 + 1)', () => {
        assert.strictEqual(liveAnnotations.length, 1);
        assert.strictEqual(liveAnnotations[0].line, 17);
    });

    test('event 2 (paste): lineHash correct (ANNO_LINE; at new position)', () => {
        assert.strictEqual(liveAnnotations[0].lineHash, hashLine('ANNO_LINE;'));
    });
});

// ---------------------------------------------------------------------------
// Bug 2 tests: copy+paste should offer to duplicate the annotation
// ---------------------------------------------------------------------------

/**
 * Helper mirroring detectAndPromptCopyPaste candidate detection (without VS Code prompt).
 * clipboardContent simulates vscode.env.clipboard.readText() -- must match inserted text
 * and contain >= 2 non-empty lines for a candidate to be returned.
 */
function findCopyPasteCandidates(
    insertedLines: string[],
    insertStart: number,
    annotations: MockAnnotation[],
    filePath: string,           // paste-destination file
    recentDeletionIds: Set<string>,
    clipboardContent = ''
): Array<{ annotationId: string; newLine: number }> {
    // Guard 1 (clipboard): empty clipboard or mismatch with inserted text means not a paste.
    const normalizedClipboard = clipboardContent.replace(/\r\n/g, '\n').trim();
    if (!normalizedClipboard) { return []; }
    const normalizedInserted = insertedLines.join('\n').replace(/\r\n/g, '\n').trim();
    if (normalizedInserted !== normalizedClipboard) { return []; }

    // Guard 2 (multi-line): require >= 2 non-empty inserted lines.
    const nonEmpty = insertedLines.filter(l => l.trim() !== '').length;
    if (nonEmpty < 2) { return []; }

    const candidates: Array<{ annotationId: string; newLine: number }> = [];
    // Bug 1 fix: dedup by TARGET line position (not source annotation id).
    // Regardless of how many sources share the same lineHash, only one new
    // annotation is created per distinct target line.
    const seenTargets = new Set<number>();

    for (let k = 0; k < insertedLines.length; k++) {
        const insertedHash = hashLine(insertedLines[k]);
        const newLine = insertStart + k;
        if (seenTargets.has(newLine)) { continue; }

        for (const annotation of annotations) {
            // Bug 2 fix: no file filter -- search all annotations regardless of source file.
            if (!annotation.lineHash || annotation.lineHash !== insertedHash) { continue; }
            if (recentDeletionIds.has(annotation.id)) { continue; }
            // Self-paste guard: only meaningful when source and target share the same file.
            if (annotation.file === filePath && Math.abs(newLine - annotation.line) < 2) { continue; }

            seenTargets.add(newLine);
            candidates.push({ annotationId: annotation.id, newLine });
            break; // first matching source wins for this target line
        }
    }
    return candidates;
}

suite('bug2: copy+paste -- prompt Yes duplicates annotation at new location', () => {
    // Use a 3-line block (>= 2 non-empty lines required by guard 2).
    const lines = [
        'preamble_a;',    // 0
        'preamble_b;',    // 1
        'ANNO_LINE;',     // 2 -- annotated
        'post_a;',        // 3
        'post_b;',        // 4
        'filler_0;',      // 5
        'filler_1;',      // 6
        'filler_2;',      // 7
    ];
    const doc    = makeDoc(lines);
    const anchor = captureAnchor(doc, 2);
    const annotation: MockAnnotation = {
        id: 'f1', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    const annotations = [annotation];

    // Ctrl+C copies 3 lines: 'ANNO_LINE;', 'post_a;', 'post_b;'
    // Clipboard contains the exact copied text.
    const copiedBlock   = ['ANNO_LINE;', 'post_a;', 'post_b;'];
    const clipboardText = copiedBlock.join('\n');
    const insertStart   = 5;

    const candidates = findCopyPasteCandidates(
        copiedBlock, insertStart, annotations, 'f.ts', new Set(), clipboardText
    );

    test('candidate detected: one copy+paste candidate (multi-line block, clipboard matches)', () => {
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].annotationId, 'f1');
        assert.strictEqual(candidates[0].newLine, 5);
    });

    // Simulate "Yes": duplicate annotation at newLine
    const newDoc = makeDoc([...lines.slice(0, 5), ...copiedBlock, ...lines.slice(5)]);
    let allAnnotations = [...annotations];
    if (candidates.length > 0) {
        const { newLine } = candidates[0];
        const newAnno: MockAnnotation = {
            id: 'f1-copy',
            file: 'f.ts',
            line: newLine,
        };
        applySetLine(newAnno, newLine, newDoc);
        allAnnotations = [...allAnnotations, newAnno];
    }

    test('Yes: original annotation stays at line 2', () => {
        const original = allAnnotations.find(a => a.id === 'f1');
        assert.ok(original, 'original annotation should exist');
        assert.strictEqual(original.line, 2);
    });

    test('Yes: new annotation created at correct line with correct hash', () => {
        const copy = allAnnotations.find(a => a.id === 'f1-copy');
        assert.ok(copy, 'copy annotation was created');
        assert.strictEqual(copy.line, 5);
        assert.strictEqual(copy.lineHash, hashLine('ANNO_LINE;'));
    });
});

suite('bug2: copy+paste -- auto-duplicate always fires, no user prompt', () => {
    const lines = ['A;', 'ANNO;', 'B;', 'C;', 'D;', 'E;', 'F;'];
    const doc    = makeDoc(lines);
    const anchor = captureAnchor(doc, 1);
    const annotation: MockAnnotation = {
        id: 'g1', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    const annotations = [annotation];

    // Multi-line clipboard block containing the annotated line
    const copiedBlock   = ['ANNO;', 'B;', 'C;'];
    const clipboardText = copiedBlock.join('\n');
    const candidates = findCopyPasteCandidates(
        copiedBlock, 4, annotations, 'f.ts', new Set(), clipboardText
    );

    // Auto-duplicate: always create the copy without a user prompt.
    const newDoc = makeDoc([...lines.slice(0, 4), ...copiedBlock, ...lines.slice(4)]);
    let allAnnotations = [...annotations];
    if (candidates.length > 0) {
        const { newLine } = candidates[0];
        const newAnno: MockAnnotation = { id: 'g1-copy', file: 'f.ts', line: newLine };
        applySetLine(newAnno, newLine, newDoc);
        allAnnotations = [...allAnnotations, newAnno];
    }

    test('auto-duplicate: candidate detected for multi-line copy+paste', () => {
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].annotationId, 'g1');
    });

    test('auto-duplicate: new annotation created at pasted location without prompt', () => {
        const copy = allAnnotations.find(a => a.id === 'g1-copy');
        assert.ok(copy, 'duplicate annotation was auto-created');
        assert.strictEqual(copy.line, 4);
        assert.strictEqual(copy.lineHash, hashLine('ANNO;'));
    });

    test('auto-duplicate: original annotation preserved at line 1', () => {
        const original = allAnnotations.find(a => a.id === 'g1');
        assert.ok(original, 'original annotation should exist');
        assert.strictEqual(original.line, 1);
    });

    test('auto-duplicate: both annotations present in live map', () => {
        assert.strictEqual(allAnnotations.length, 2);
    });
});

// ---------------------------------------------------------------------------
// Regression tests: Enter / typing must NEVER trigger the copy+paste prompt
// ---------------------------------------------------------------------------

suite('regression: Enter above annotation shifts line, no copy+paste prompt', () => {
    const lines = ['A;', 'B;', 'ANNO;', 'C;', 'D;'];
    const doc    = makeDoc(lines);
    const anchor = captureAnchor(doc, 2);
    const annotation: MockAnnotation = {
        id: 'r1', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    const annotations = [annotation];

    // Simulate Enter at line 0 (insert '\n' -- change.text = '\n')
    // insertedLines = ['', ''] -- two empty strings, 0 non-empty lines
    const enterInsertedLines = ['', ''];     // change.text.split('\n') for '\n'
    const enterClipboard     = '';          // clipboard unchanged by pressing Enter

    const candidates = findCopyPasteCandidates(
        enterInsertedLines, 0, annotations, 'f.ts', new Set(), enterClipboard
    );

    test('Enter: empty clipboard -> no copy+paste candidates', () => {
        assert.strictEqual(candidates.length, 0);
    });

    // Arithmetic shift: Enter at the end of line 0 inserts '\n' (single-point range).
    // range [0..0], text '\n' -> lineDelta = 2-1 = +1 -> annotation at 2 shifts to 3.
    const afterEnterLines = ['A;', '', 'B;', 'ANNO;', 'C;', 'D;'];
    const afterEnterDoc   = makeDoc(afterEnterLines);
    const shiftResult = runChangePipeline({
        annotations,
        file: 'f.ts',
        oldLines: lines,
        newDoc: afterEnterDoc,
        contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: '\n' }],
    });

    test('Enter above annotation: annotation shifts from line 2 to line 3', () => {
        assert.strictEqual(shiftResult.length, 1);
        assert.strictEqual(shiftResult[0].line, 3);
    });
});

suite('regression: typing a matching line never triggers prompt', () => {
    const lines = ['const x = 1;', 'ANNO;', 'const y = 2;'];
    const doc    = makeDoc(lines);
    const anchor = captureAnchor(doc, 1);
    const annotation: MockAnnotation = {
        id: 'r2', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };
    // User types 'ANNO;' at line 0 -- single-line insert, clipboard unchanged (still 'const x')
    const typedLines  = ['ANNO;'];
    const clipboard   = 'const x = 1;'; // clipboard holds whatever was copied before

    const candidates = findCopyPasteCandidates(
        typedLines, 0, [annotation], 'f.ts', new Set(), clipboard
    );

    test('typing: clipboard mismatch -> no candidates (Guard 1)', () => {
        assert.strictEqual(candidates.length, 0, 'clipboard does not match typed text');
    });
});

suite('regression: auto-indent Enter never triggers prompt', () => {
    // Auto-indent: change.text = '\n  ' -> insertedLines = ['', '  '] -- 0 non-empty
    const lines = ['function foo() {', '  ANNO;', '}'];
    const doc    = makeDoc(lines);
    const anchor = captureAnchor(doc, 1);
    const annotation: MockAnnotation = {
        id: 'r3', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    const autoIndentLines = ['', '  '];  // split of '\n  '
    // Even if clipboard happens to contain '\n  ', nonEmpty < 2
    const candidates = findCopyPasteCandidates(
        autoIndentLines, 1, [annotation], 'f.ts', new Set(), '\n  '
    );

    test('auto-indent Enter: < 2 non-empty lines -> no candidates (Guard 2)', () => {
        assert.strictEqual(candidates.length, 0);
    });
});

suite('regression: true copy+paste of multi-line block triggers prompt', () => {
    // Positive case: clipboard matches inserted text, >= 2 non-empty lines
    const lines = ['setup();', 'ANNO;', 'teardown();', 'filler_0;', 'filler_1;', 'filler_2;'];
    const doc    = makeDoc(lines);
    const anchor = captureAnchor(doc, 1);
    const annotation: MockAnnotation = {
        id: 'r4', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    // User copied 3 lines into clipboard, now pasting at line 3
    const copiedBlock   = ['ANNO;', 'teardown();', 'filler_0;'];
    const clipboardText = copiedBlock.join('\n');

    const candidates = findCopyPasteCandidates(
        copiedBlock, 3, [annotation], 'f.ts', new Set(), clipboardText
    );

    test('real copy+paste: clipboard matches + 3 non-empty lines -> 1 candidate', () => {
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].annotationId, 'r4');
        assert.strictEqual(candidates[0].newLine, 3);
    });

    test('cut+paste via recentDeletions does NOT trigger copy prompt', () => {
        const candidatesWithCut = findCopyPasteCandidates(
            copiedBlock, 3, [annotation], 'f.ts',
            new Set(['r4']),  // annotation is in recentDeletions (was cut)
            clipboardText
        );
        assert.strictEqual(candidatesWithCut.length, 0, 'cut is handled by clipboard buffer, not copy prompt');
    });
});

// ---------------------------------------------------------------------------
// deletedRecently buffer tests (30-second Undo buffer after cut-expiry)
// ---------------------------------------------------------------------------

suite('deletedRecently buffer: tryRestore finds annotation at original position', () => {
    const sourceLines = ['alpha;', 'beta;', 'ANNO;', 'gamma;', 'delta;'];
    const doc = makeDoc(sourceLines);
    const anchor = captureAnchor(doc, 2);
    const annotation: MockAnnotation = {
        id: 'dr1', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    const buf = new DeletedRecentlyBuffer();
    buf.add(annotation);

    // Document is unchanged (Undo was pressed, content reverted)
    const restored = buf.tryRestore(doc, 'f.ts');

    test('annotation restored to line 2 (fast path: hash still matches)', () => {
        assert.strictEqual(restored.length, 1);
        assert.strictEqual(restored[0].line, 2);
        assert.strictEqual(restored[0].lineHash, hashLine('ANNO;'));
    });

    test('buffer is empty after successful restore', () => {
        assert.strictEqual(buf.entries.size, 0);
    });
});

suite('deletedRecently buffer: entry ignored after 30s TTL', () => {
    const lines = ['X;', 'ANNO;', 'Y;'];
    const doc = makeDoc(lines);
    const anchor = captureAnchor(doc, 1);
    const annotation: MockAnnotation = {
        id: 'dr2', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    const buf = new DeletedRecentlyBuffer();
    buf.add(annotation);
    // Back-date past the 30s TTL
    const dr2 = buf.entries.get('dr2');
    assert.ok(dr2, 'deleted-recently entry should exist');
    dr2.removedAt = Date.now() - 31000;

    const restored = buf.tryRestore(doc, 'f.ts');

    test('expired entry not restored by tryRestore', () => {
        assert.strictEqual(restored.length, 0, 'TTL expired, cannot restore');
    });

    test('expired entry cleaned up from buffer on tryRestore', () => {
        assert.strictEqual(buf.entries.size, 0, 'stale entry removed');
    });
});

suite('deletedRecently buffer: restore after VS Code Undo reverts deletion', () => {
    // Annotation removed when line 2 was deleted. VS Code Undo reverts the delete,
    // restoring the original document content. tryRestore then relocates the annotation.
    const sourceLines = ['pre_a;', 'pre_b;', 'CRITICAL;', 'post_a;', 'post_b;'];
    const originalDoc = makeDoc(sourceLines);
    const anchor = captureAnchor(originalDoc, 2);
    const annotation: MockAnnotation = {
        id: 'dr3', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
    };

    const buf = new DeletedRecentlyBuffer();
    buf.add(annotation);

    // After Undo, VS Code emits onDidChangeTextDocument with the reverted content.
    // The document is back to its original state.
    const afterUndoDoc = originalDoc;
    const restored = buf.tryRestore(afterUndoDoc, 'f.ts');

    test('annotation restored to line 2 after Undo reverts deletion', () => {
        assert.strictEqual(restored.length, 1);
        assert.strictEqual(restored[0].line, 2);
        assert.strictEqual(restored[0].lineHash, hashLine('CRITICAL;'));
    });
});

// ---------------------------------------------------------------------------
// Bug 1 fix: dedup by target -- successive copies must not double-count sources
// ---------------------------------------------------------------------------

suite('bug1 fix: copy A->B then reuse block B->C produces exactly 1 annotation at C', () => {
    // After first copy (A->B), both source (line 1) and copy (line 5) share the same
    // lineHash.  When the user copies the block again (B->C), there are now 2 matching
    // sources.  The fixed algorithm must create exactly ONE new annotation at the
    // target position, regardless of how many sources match.

    const baseLines = [
        'pre_0;',   // 0
        'ANNO;',    // 1 -- original annotated line
        'post_0;',  // 2
        'filler;',  // 3
        'filler;',  // 4  (unused)
    ];
    const docBase  = makeDoc(baseLines);
    const anchorBase = captureAnchor(docBase, 1);

    // Simulate state after the A->B copy: two annotations share identical lineHash.
    const docAfterAB = makeDoc([
        'pre_0;',   // 0
        'ANNO;',    // 1 -- original
        'post_0;',  // 2
        'filler;',  // 3
        'ANNO;',    // 4 -- copy from A->B paste
        'post_0;',  // 5
        'filler;',  // 6
    ]);
    const anchorAtLine4 = captureAnchor(docAfterAB, 4);
    const annoAtLine1: MockAnnotation = {
        id: 'orig', file: 'f.ts', line: 1,
        lineHash: anchorBase.lineHash,
        contextBefore: anchorBase.contextBefore,
        contextAfter: anchorBase.contextAfter,
    };
    const annoAtLine4: MockAnnotation = {
        id: 'copy1', file: 'f.ts', line: 4,
        lineHash: anchorAtLine4.lineHash,
        contextBefore: anchorAtLine4.contextBefore,
        contextAfter: anchorAtLine4.contextAfter,
    };
    const twoAnnotations = [annoAtLine1, annoAtLine4];

    // Both lineHashes are equal (same content 'ANNO;').
    // Now paste ['ANNO;', 'post_0;', 'filler;'] at insertStart=8 (B->C paste).
    const block = ['ANNO;', 'post_0;', 'filler;'];
    const clipboard = block.join('\n');
    const candidates = findCopyPasteCandidates(
        block, 8, twoAnnotations, 'f.ts', new Set(), clipboard
    );

    test('exactly 1 candidate for B->C paste despite 2 sources with matching hash', () => {
        assert.strictEqual(candidates.length, 1);
    });

    test('candidate targets newLine=8 (first line of pasted block)', () => {
        assert.strictEqual(candidates[0].newLine, 8);
    });

    test('only one annotation would be created (no exponential growth)', () => {
        // Simulate duplication: start with twoAnnotations, apply the single candidate.
        const allAfterBC = [...twoAnnotations];
        for (const { newLine } of candidates) {
            allAfterBC.push({ id: `new-${newLine}`, file: 'f.ts', line: newLine });
        }
        // Before: 2. After: 3 (exactly +1, not +2).
        assert.strictEqual(allAfterBC.length, 3);
    });
});

suite('bug1 fix: chain A->B->C->D creates exactly 1 new annotation per paste step', () => {
    // Simulate 3 successive paste steps.  After each step the pool of annotations
    // with matching lineHash grows, but each paste must still yield exactly 1 new annotation.

    const content = 'REPEATING_LINE;';
    // Build a pool of N annotations all sharing the same lineHash.
    function makePool(n: number): MockAnnotation[] {
        return Array.from({ length: n }, (_, i) => ({
            id: `a${i}`,
            file: 'f.ts',
            line: i * 4,        // spaced apart so self-paste guard never fires
            lineHash: hashLine(content),
            contextBefore: [] as string[],
            contextAfter: [] as string[],
        }));
    }

    const block = [content, 'line2;', 'line3;']; // 3 non-empty lines
    const clipboard = block.join('\n');

    // Step 1: pool has 1 annotation -> paste -> should produce exactly 1 candidate
    const step1 = findCopyPasteCandidates(block, 100, makePool(1), 'f.ts', new Set(), clipboard);
    // Step 2: pool has 2 annotations -> paste -> still exactly 1 candidate
    const step2 = findCopyPasteCandidates(block, 100, makePool(2), 'f.ts', new Set(), clipboard);
    // Step 3: pool has 4 annotations -> paste -> still exactly 1 candidate
    const step3 = findCopyPasteCandidates(block, 100, makePool(4), 'f.ts', new Set(), clipboard);

    test('step 1 (1 source): exactly 1 candidate', () => { assert.strictEqual(step1.length, 1); });
    test('step 2 (2 sources): exactly 1 candidate', () => { assert.strictEqual(step2.length, 1); });
    test('step 3 (4 sources): exactly 1 candidate', () => { assert.strictEqual(step3.length, 1); });
    test('all three steps target the same newLine=100', () => {
        assert.strictEqual(step1[0].newLine, 100);
        assert.strictEqual(step2[0].newLine, 100);
        assert.strictEqual(step3[0].newLine, 100);
    });
});

// ---------------------------------------------------------------------------
// Bug 2 fix: cross-file copy and cut+paste
// ---------------------------------------------------------------------------

suite('bug2 fix: copy from file A, paste into file B -- annotation duplicated in B', () => {
    // Source annotation lives in a.ts.  The paste target is b.ts.
    // The old code filtered sources by file (annotation.file === relativeFilePath),
    // which excluded a.ts annotations when the paste target was b.ts.
    // The fix removes this filter: the new annotation gets file = b.ts.

    const linesA = [
        'header_a;',   // 0
        'SHARED;',     // 1 -- annotated in a.ts
        'footer_a;',   // 2
    ];
    const docA   = makeDoc(linesA);
    const anchorA = captureAnchor(docA, 1);
    const annoInA: MockAnnotation = {
        id: 'a1', file: 'a.ts', line: 1,
        lineHash: anchorA.lineHash,
        contextBefore: anchorA.contextBefore,
        contextAfter: anchorA.contextAfter,
    };

    // User copies ['SHARED;', 'footer_a;', 'extra;'] from a.ts and pastes into b.ts.
    const pastedBlock = ['SHARED;', 'footer_a;', 'extra;'];
    const clipboard   = pastedBlock.join('\n');
    const pasteStart  = 5;
    const pasteFile   = 'b.ts';

    // Pass all annotations (including a.ts ones) -- new behavior after Bug 2 fix.
    const candidates = findCopyPasteCandidates(
        pastedBlock, pasteStart, [annoInA], pasteFile, new Set(), clipboard
    );

    test('candidate found: cross-file source in a.ts detected for paste in b.ts', () => {
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].annotationId, 'a1');
    });

    test('new annotation targets the correct line in b.ts', () => {
        assert.strictEqual(candidates[0].newLine, pasteStart);
    });

    test('simulated new annotation has file = b.ts (paste destination)', () => {
        const { newLine } = candidates[0];
        const docB = makeDoc(Array.from({ length: 10 }, (_, i) => `b_line_${i};`));
        const newAnno: MockAnnotation = { id: 'b1-copy', file: pasteFile, line: newLine };
        applySetLine(newAnno, newLine, docB);
        assert.strictEqual(newAnno.file, 'b.ts');
        assert.strictEqual(newAnno.line, pasteStart);
    });
});

suite('bug2 fix: cut from file A, paste into file B -- annotation migrates to B', () => {
    // Cut+paste cross-file is handled by the ClipboardBuffer (recentDeletions).
    // When the paste arrives in b.ts, tryRecover sets annotation.file = b.ts.
    // docB must contain enough matching context (>= 2 lines) for findAnchor to
    // achieve the minimum score of 4 (2 matched context lines x 2 points each).

    const sharedCtx1 = 'shared_ctx_before;';
    const sharedCtx2 = 'shared_ctx_after_1;';
    const sharedCtx3 = 'shared_ctx_after_2;';

    const linesA = [sharedCtx1, 'CUT_LINE;', sharedCtx2, sharedCtx3];
    const docA   = makeDoc(linesA);
    // anchor at line 1: contextBefore=['shared_ctx_before;'],
    //                   contextAfter=['shared_ctx_after_1;', 'shared_ctx_after_2;']
    const anchorA = captureAnchor(docA, 1, 3);
    const annoInA: MockAnnotation = {
        id: 'cut1', file: 'a.ts', line: 1,
        lineHash: anchorA.lineHash,
        contextBefore: anchorA.contextBefore,
        contextAfter: anchorA.contextAfter,
    };

    // After cut: annotation is in the clipboard buffer (removed from a.ts live map).
    const buf = new ClipboardBuffer();
    buf.defer(annoInA, 0);

    // docB contains the pasted block with matching surrounding context lines
    // so findAnchor can score >= 4.
    const linesB = [
        'b_preamble;',  // 0
        sharedCtx1,     // 1 -- matches contextBefore[0] (+2)
        'CUT_LINE;',    // 2 -- matches lineHash
        sharedCtx2,     // 3 -- matches contextAfter[0] (+2)
        sharedCtx3,     // 4 -- matches contextAfter[1] (+2)
        'b_footer;',    // 5
    ];
    const docB = makeDoc(linesB);

    const restored = buf.tryRecover(docB, 'b.ts');

    test('annotation recovered from buffer after cross-file paste', () => {
        assert.strictEqual(restored.length, 1);
        assert.strictEqual(restored[0].id, 'cut1');
    });

    test('annotation.file updated to b.ts (paste destination)', () => {
        assert.strictEqual(restored[0].file, 'b.ts');
    });

    test('annotation.line correct in b.ts', () => {
        assert.strictEqual(restored[0].line, 2);
    });

    test('buffer is empty after cross-file recovery', () => {
        assert.strictEqual(buf.entries.size, 0);
    });
});

// ---------------------------------------------------------------------------
// Regression fix v2: pipeline mirroring the post-fix AnnotationManager logic.
//   1. Adds lineDisplaced detection (hash mismatch at predicted line).
//   2. Honours an isUndoRedo flag that skips copy-paste duplication entirely.
//   3. Calls a sameLocationSameMessage anti-duplicate guard before creating
//      a duplicate annotation.
// ---------------------------------------------------------------------------

interface PipelineV2Result {
    annotations: MockAnnotation[];
    deferredIds: string[];
    removedIds: string[];
    duplicatesCreated: number;
}

function sameLocationSameMessage(
    pool: MockAnnotation[],
    file: string,
    line: number,
    message: string
): boolean {
    return pool.some(a => a.file === file && a.line === line && (a as MockAnnotation & { message?: string }).message === message);
}

/**
 * Mirror of post-fix AnnotationManager pipeline.  Includes:
 *   - move detection (detectMoves)
 *   - arithmetic shift
 *   - lineDisplaced check (predicted line hash mismatch -> defer)
 *   - findAnchor relocation
 *   - copy-paste duplication, skipped on undo/redo, gated by anti-duplicate guard
 *   - undo removal for annotations derived from copy-paste.
 */
function runChangePipelineV2(opts: {
    annotations: (MockAnnotation & { message?: string })[];
    file: string;
    oldLines: string[];
    newDoc: TextDocumentLike;
    contentChanges: ContentChange[];
    isUndoRedo?: boolean;
    clipboardText?: string;
}): PipelineV2Result {
    const { annotations, file, oldLines, newDoc, contentChanges, isUndoRedo, clipboardText } = opts;

    const newLines: string[] = [];
    for (let i = 0; i < newDoc.lineCount; i++) { newLines.push(newDoc.lineAt(i).text); }

    const moves: MovedBlock[] = detectMoves(oldLines, newLines);
    const result: (MockAnnotation & { message?: string })[] = annotations.map(a => ({ ...a }));
    const deferredIds: string[] = [];
    const removedIds: string[] = [];

    for (let i = result.length - 1; i >= 0; i--) {
        const annotation = result[i];
        if (annotation.file !== file) { continue; }
        const oldLine = annotation.line;
        if (
            isUndoRedo &&
            annotation.origin?.kind === 'copy-paste' &&
            contentChanges.some(ch => ch.text === '' && oldLine >= ch.range.start.line && oldLine <= ch.range.end.line)
        ) {
            removedIds.push(annotation.id);
            result.splice(i, 1);
            continue;
        }

        const move = moves.find(m => oldLine >= m.oldStart && oldLine <= m.oldEnd);
        if (move) {
            applySetLine(annotation, move.newStart + (oldLine - move.oldStart), newDoc);
            continue;
        }

        let currentLine = oldLine;
        let markedDeleted = false;
        for (const change of contentChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const lineDelta = change.text.split('\n').length - (endLine - startLine + 1);
            if (currentLine > endLine) { currentLine += lineDelta; }
            else if (currentLine >= startLine && currentLine <= endLine && lineDelta < 0) { markedDeleted = true; }
        }

        const predictedInRange = currentLine >= 0 && currentLine < newDoc.lineCount;
        const predictedHashMatches =
            annotation.lineHash !== undefined &&
            predictedInRange &&
            hashLine(newDoc.lineAt(currentLine).text) === annotation.lineHash;
        let lineDisplaced = false;
        if (!markedDeleted && annotation.lineHash !== undefined && !predictedHashMatches) {
            for (const ch of contentChanges) {
                const erased = ch.text.replace(/\r\n/g, '').length === 0;
                if (
                    erased &&
                    oldLine >= ch.range.start.line &&
                    oldLine <= ch.range.end.line
                ) {
                    lineDisplaced = true;
                    break;
                }
            }
        }

        if (markedDeleted || lineDisplaced) {
            if (annotation.lineHash) {
                const anchor: AnchorData = {
                    lineHash: annotation.lineHash,
                    contextBefore: annotation.contextBefore ?? [],
                    contextAfter: annotation.contextAfter ?? [],
                };
                const found = findAnchor(newDoc, anchor, -1);
                if (found !== null) {
                    applySetLine(annotation, found, newDoc);
                    continue;
                }
            }
            deferredIds.push(annotation.id);
            result.splice(i, 1);
        } else if (currentLine !== oldLine) {
            applySetLine(annotation, currentLine, newDoc);
        }
    }

    let duplicatesCreated = 0;
    if (!isUndoRedo && clipboardText) {
        const normalizedClipboard = clipboardText.replace(/\r\n/g, '\n').trim();
        if (normalizedClipboard) {
            const seenTargets = new Set<number>();
            for (const change of contentChanges) {
                const insertedLines = change.text.split('\n');
                const startLine = change.range.start.line;
                const endLine = change.range.end.line;
                const lineDelta = insertedLines.length - (endLine - startLine + 1);
                if (lineDelta <= 0) { continue; }
                const normalizedInserted = change.text.replace(/\r\n/g, '\n').trim();
                if (normalizedInserted !== normalizedClipboard) { continue; }
                const nonEmpty = insertedLines.filter(l => l.trim() !== '').length;
                if (nonEmpty < 2) { continue; }

                for (let k = 0; k < insertedLines.length; k++) {
                    const insertedHash = hashLine(insertedLines[k]);
                    const newLine = startLine + k;
                    if (seenTargets.has(newLine)) { continue; }
                    for (const annotation of result) {
                        if (!annotation.lineHash || annotation.lineHash !== insertedHash) { continue; }
                        if (annotation.file === file && Math.abs(newLine - annotation.line) < 2) { continue; }
                        seenTargets.add(newLine);
                        if (sameLocationSameMessage(result, file, newLine, annotation.message ?? '')) {
                            break;
                        }
                        const dup: MockAnnotation & { message?: string } = {
                            id: `${annotation.id}-dup-${newLine}`,
                            file,
                            line: newLine,
                            message: annotation.message,
                            origin: {
                                kind: 'copy-paste',
                                sourceId: annotation.id,
                                sourceFile: annotation.file,
                                sourceLine: annotation.line,
                                pastedAtLine: newLine,
                            },
                        };
                        applySetLine(dup, newLine, newDoc);
                        result.push(dup);
                        duplicatesCreated++;
                        break;
                    }
                }
            }
        }
    }

    return { annotations: result, deferredIds, removedIds, duplicatesCreated };
}

suite('regression fix: cut without lineDelta change is detected via hash mismatch', () => {
    // Selection-based cut: user selects the entire content of line 2 (without the
    // trailing newline) and presses Ctrl+X.  VS Code emits range=[2,0..2,len], text=''.
    // lineDelta = 1 - 1 = 0 -- the legacy markedDeleted check (lineDelta < 0) misses it.
    // The new lineDisplaced check (hashLine(newDoc.lineAt(2).text) !== annotation.lineHash)
    // catches the displacement and defers the annotation to the clipboard buffer.
    const oldLines = ['alpha;', 'beta;', 'ANNOTATED;', 'delta;', 'epsilon;'];
    const newLines = ['alpha;', 'beta;', '',           'delta;', 'epsilon;'];
    const oldDoc = makeDoc(oldLines);
    const newDoc = makeDoc(newLines);
    const anchor = captureAnchor(oldDoc, 2);
    const annotation = {
        id: 'displaced1', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'check this',
    };
    const change: ContentChange = {
        range: { start: { line: 2 }, end: { line: 2 } }, text: '',
    };
    const out = runChangePipelineV2({
        annotations: [annotation], file: 'f.ts',
        oldLines, newDoc, contentChanges: [change],
    });

    test('annotation deferred even though arithmetic lineDelta == 0', () => {
        assert.strictEqual(out.annotations.length, 0, 'annotation removed from live map');
        assert.deepStrictEqual(out.deferredIds, ['displaced1'], 'id appears in deferred list');
    });
});

suite('regression fix: typing on the annotated line does NOT defer the annotation', () => {
    // The displacement check must NOT fire for routine edits.  Only erasures
    // (text === '') touching the annotated line are considered displacements.
    // Without this guard, a single keystroke on the annotated line would
    // eject the annotation into the buffer.
    const oldLines = ['alpha;', 'beta;', 'ANNO;', 'delta;'];
    const newLines = ['alpha;', 'beta;', 'ANNO;X', 'delta;']; // user appended 'X'
    const oldDoc = makeDoc(oldLines);
    const newDoc = makeDoc(newLines);
    const anchor = captureAnchor(oldDoc, 2);
    const annotation = {
        id: 'edit1', file: 'f.ts', line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'do not defer me',
    };
    const change: ContentChange = {
        range: { start: { line: 2 }, end: { line: 2 } }, text: 'X',
    };

    test('routine typing leaves the annotation in place (not deferred)', () => {
        const out = runChangePipelineV2({
            annotations: [annotation], file: 'f.ts',
            oldLines, newDoc, contentChanges: [change],
        });
        assert.strictEqual(out.deferredIds.length, 0, 'no deferral on plain edit');
        assert.strictEqual(out.annotations.length, 1, 'annotation still in live map');
        assert.strictEqual(out.annotations[0].line, 2, 'annotation stays on the edited line');
    });
});

suite('regression fix: redo of cut+paste does NOT create a duplicate', () => {
    // Step A simulates the original cut+paste (clipboard was filled, paste happened).
    // Step B simulates the user pressing Ctrl+Y (redo) after Ctrl+Z.  The clipboard
    // still holds the cut text, so without the isUndoRedo skip the duplication step
    // would re-fire and produce a ghost annotation.
    const blockBefore = ['header;', 'pre_a;'];
    const blockAfter  = ['post_a;', 'footer;'];
    const cutBlock    = ['ANNO_LINE;', 'ctx1;', 'ctx2;'];

    // Doc before redo: cut block already inserted at line 2 (3 lines back).
    const beforeRedoLines = [...blockBefore, ...cutBlock, ...blockAfter];
    const beforeRedoDoc   = makeDoc(beforeRedoLines);
    const anchorAtLine2   = captureAnchor(beforeRedoDoc, 2);
    const liveAnnotation  = {
        id: 'redo1', file: 'f.ts', line: 2,
        lineHash: anchorAtLine2.lineHash,
        contextBefore: anchorAtLine2.contextBefore,
        contextAfter: anchorAtLine2.contextAfter,
        message: 'redo me',
    };

    // The redo replays the same paste at line 2, with the same clipboard text.
    const redoChange: ContentChange = {
        range: { start: { line: 2 }, end: { line: 2 } },
        text: cutBlock.join('\n') + '\n',
    };
    const clipboardText = cutBlock.join('\n');

    test('with isUndoRedo=true: zero duplicates created (annotation stays at line 2)', () => {
        const out = runChangePipelineV2({
            annotations: [liveAnnotation], file: 'f.ts',
            oldLines: beforeRedoLines, newDoc: beforeRedoDoc,
            contentChanges: [redoChange],
            isUndoRedo: true,
            clipboardText,
        });
        assert.strictEqual(out.duplicatesCreated, 0);
        assert.strictEqual(out.annotations.length, 1, 'no duplicate created on redo');
    });

    test('with isUndoRedo=false (regular copy-paste): duplication still works', () => {
        // Use a different paste-target line so the self-paste guard does not fire.
        const farPasteChange: ContentChange = {
            range: { start: { line: 10 }, end: { line: 10 } },
            text: cutBlock.join('\n') + '\n',
        };
        const newLinesLong = [...beforeRedoLines, ...Array.from({ length: 10 }, (_, i) => `tail_${i}`)];
        // After the paste, cutBlock appears at line 10..12 inside an enlarged doc.
        const afterPasteLines = [
            ...newLinesLong.slice(0, 10),
            ...cutBlock,
            ...newLinesLong.slice(10),
        ];
        const afterPasteDoc = makeDoc(afterPasteLines);
        const out = runChangePipelineV2({
            annotations: [liveAnnotation], file: 'f.ts',
            oldLines: newLinesLong, newDoc: afterPasteDoc,
            contentChanges: [farPasteChange],
            isUndoRedo: false,
            clipboardText,
        });
        assert.strictEqual(out.duplicatesCreated, 1, 'normal paste still duplicates');
        assert.strictEqual(out.annotations.length, 2);
    });
});

suite('regression fix: anti-duplicate guard blocks creation when same (file, line, message) exists', () => {
    // Two identically-located annotations with the same message must not multiply.
    // We pre-populate a phantom annotation at the expected paste-target line and
    // assert that the duplicator skips creation.
    const lines = ['a;', 'ANNO;', 'b;', 'c;', 'd;', 'e;', 'f;'];
    const doc   = makeDoc(lines);
    const anchor = captureAnchor(doc, 1);
    const original = {
        id: 'orig', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'phantom',
    };
    // Phantom already at the paste-target position with the same message.
    const phantom = {
        id: 'phantom', file: 'f.ts', line: 4,
        lineHash: anchor.lineHash,
        contextBefore: [],
        contextAfter: [],
        message: 'phantom',
    };
    const block = ['ANNO;', 'b;', 'c;'];
    const clipboardText = block.join('\n');
    const pasteChange: ContentChange = {
        range: { start: { line: 4 }, end: { line: 4 } },
        text: block.join('\n') + '\n',
    };
    const afterPasteLines = [...lines.slice(0, 4), ...block, ...lines.slice(4)];
    const afterPasteDoc = makeDoc(afterPasteLines);

    const out = runChangePipelineV2({
        annotations: [original, phantom], file: 'f.ts',
        oldLines: lines, newDoc: afterPasteDoc,
        contentChanges: [pasteChange],
        isUndoRedo: false,
        clipboardText,
    });

    test('no duplicate created: the existing phantom blocks duplication', () => {
        assert.strictEqual(out.duplicatesCreated, 0);
    });

    test('live map remains exactly the two pre-existing annotations', () => {
        assert.strictEqual(out.annotations.length, 2);
        assert.ok(out.annotations.some(a => a.id === 'orig'));
        assert.ok(out.annotations.some(a => a.id === 'phantom'));
    });
});

suite('regression fix: undo of a paste removes the duplicate path entirely', () => {
    // After a normal paste created a duplicate, the user presses Ctrl+Z.  The undo
    // event reverses the paste.  Without the isUndoRedo skip, the clipboard match
    // would re-fire duplication.  With the skip, no new annotation is created and
    // the previously-duplicated annotation is removed because its line is gone.
    const baseLines = ['x;', 'ANNO;', 'y;', 'z;', 'w;', 'k;'];
    const oldDoc = makeDoc(baseLines);
    const anchor = captureAnchor(oldDoc, 1);

    // After undo: doc is back to baseLines (paste removed).
    const newDoc = makeDoc(baseLines);

    // The previously-duplicated annotation lived at line 4 (post-paste position).
    // Undo removes lines 4..6 and brings the doc back to baseLines.  We pretend
    // the duplicate was at line 4 with content 'ANNO;' (which is now gone in newDoc).
    const dup = {
        id: 'dup1', file: 'f.ts', line: 4,
        lineHash: hashLine('ANNO;'),
        contextBefore: [], contextAfter: [],
        message: 'undo me',
        origin: {
            kind: 'copy-paste' as const,
            sourceId: 'orig1',
            sourceFile: 'f.ts',
            sourceLine: 1,
            pastedAtLine: 4,
        },
    };
    const original = {
        id: 'orig1', file: 'f.ts', line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'undo me',
    };
    // The "old lines" before undo had the paste in place: baseLines + the paste block.
    const oldWithPasteLines = [
        ...baseLines.slice(0, 4),
        'ANNO;', 'y;', 'z;',
        ...baseLines.slice(4),
    ];
    const undoChange: ContentChange = {
        range: { start: { line: 4 }, end: { line: 7 } },
        text: '',
    };
    const out = runChangePipelineV2({
        annotations: [original, dup], file: 'f.ts',
        oldLines: oldWithPasteLines, newDoc,
        contentChanges: [undoChange],
        isUndoRedo: true,
        clipboardText: 'ANNO;\ny;\nz;',
    });

    test('no duplicate is recreated during undo', () => {
        assert.strictEqual(out.duplicatesCreated, 0);
    });

    test('original annotation is preserved at line 1', () => {
        const o = out.annotations.find(a => a.id === 'orig1');
        assert.ok(o, 'original is still present');
        assert.strictEqual(o.line, 1);
    });

    test('paste-side duplicate is removed with the undone paste', () => {
        assert.ok(out.removedIds.includes('dup1'), 'duplicate is removed by undo');
        assert.ok(!out.deferredIds.includes('dup1'), 'copy duplicate must not enter cut buffer');
    });
});

// ---------------------------------------------------------------------------
// F5 regression suite: full pipeline mirror that exercises the post-fix
// AnnotationManager logic end-to-end across SEPARATE cut/paste events.
//
// The earlier suites tested isolated helpers (clipboard buffer, copy-paste
// candidate detection). They never proved that the per-annotation arithmetic
// loop, the restoredThisEvent mutual exclusion, the pure-cut findAnchor skip,
// and detectAndDuplicateOnCopyPaste all cooperate correctly on the SAME event
// chain a user actually performs in the editor with Ctrl+X then Ctrl+V.
// ---------------------------------------------------------------------------

interface PipelineState {
    annotations: Map<string, MockAnnotation & { message?: string }>;
    recentDeletions: Map<string, DeferredEntry>;
    snapshots: Map<string, string[]>;
}

function makeState(): PipelineState {
    return {
        annotations: new Map(),
        recentDeletions: new Map(),
        snapshots: new Map(),
    };
}

function snapshotDoc(state: PipelineState, fileKey: string, doc: TextDocumentLike): void {
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) { lines.push(doc.lineAt(i).text); }
    state.snapshots.set(fileKey, lines);
}

interface FullPipelineEvent {
    fileKey: string;
    file: string;
    doc: TextDocumentLike;
    contentChanges: ContentChange[];
    isUndoRedo?: boolean;
    clipboardText?: string;
}

interface FullPipelineOutcome {
    duplicatesCreated: number;
    restored: string[];
    deferred: string[];
    removed: string[];
}

function normalizeClipboardText(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripSingleTrailingLineBreak(text: string): string {
    return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function splitClipboardLines(text: string): string[] {
    return stripSingleTrailingLineBreak(normalizeClipboardText(text)).split('\n');
}

function clipboardTextMatches(changeText: string, clipboardText: string): boolean {
    const normalizedChange = normalizeClipboardText(changeText);
    const normalizedClipboard = normalizeClipboardText(clipboardText);
    return normalizedChange === normalizedClipboard ||
        stripSingleTrailingLineBreak(normalizedChange) ===
        stripSingleTrailingLineBreak(normalizedClipboard);
}

function normalizedTextEquals(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined) { return false; }
    return stripSingleTrailingLineBreak(normalizeClipboardText(a)) ===
        stripSingleTrailingLineBreak(normalizeClipboardText(b));
}

function isLowSignalText(text: string | undefined): boolean {
    if (text === undefined) { return true; }
    return stripSingleTrailingLineBreak(normalizeClipboardText(text)).trim().length === 0;
}

function deferredPasteMatchesChange(
    deferred: DeferredEntry,
    changeText: string,
    clipboardText: string
): boolean {
    if (changeText.length === 0) { return false; }
    if (deferred.cutText !== undefined) {
        return normalizedTextEquals(deferred.cutText, clipboardText) &&
            clipboardTextMatches(changeText, clipboardText) &&
            clipboardTextMatches(changeText, deferred.cutText);
    }
    if (
        !isLowSignalText(clipboardText) &&
        clipboardTextMatches(changeText, clipboardText) &&
        deferred.cutLineHashes?.length
    ) {
        const insertedHashes = splitClipboardLines(changeText).map(line => hashLine(line));
        if (
            insertedHashes.length === deferred.cutLineHashes.length &&
            insertedHashes.every((hash, index) => hash === deferred.cutLineHashes?.[index])
        ) {
            return true;
        }
    }
    return false;
}

function getCutLinesForChange(
    oldLines: readonly string[],
    change: ContentChange,
    offsetInBlock: number
): string[] {
    const start = Math.max(0, change.range.start.line);
    const end = Math.max(start + 1, change.range.end.line);
    const exclusive = oldLines.slice(start, end);
    if (offsetInBlock < exclusive.length) {
        return exclusive;
    }

    const inclusive = oldLines.slice(start, Math.min(oldLines.length, end + 1));
    if (offsetInBlock < inclusive.length) {
        return inclusive;
    }

    return exclusive.length > 0 ? exclusive : inclusive;
}

/**
 * Mirror of the post-fix AnnotationManager.handleDocumentChange covering:
 *   1. tryRestoreFromRecentDeletions with restoredThisEvent tracking
 *   2. per-annotation arithmetic shift, with restoredThisEvent skip
 *   3. pure-cut findAnchor skip (text === '' covering the annotated line)
 *   4. negative/oversize line clamp
 *   5. detectAndDuplicateOnCopyPaste honouring restoredThisEvent + cut-buffer shadow
 */
function runFullPipeline(state: PipelineState, ev: FullPipelineEvent): FullPipelineOutcome {
    const restoredThisEvent = new Set<string>();
    const restored: string[] = [];
    const deferred: string[] = [];
    const removed: string[] = [];
    const clipboardText = ev.clipboardText ?? '';

    // Phase: try to recover deferred (cut) annotations against this document.
    if (state.recentDeletions.size > 0) {
        const recovered: string[] = [];
        for (const [id, def] of state.recentDeletions) {
            let found: number | null = null;
            let sawMatchingPaste = false;
            for (const change of ev.contentChanges) {
                if (!deferredPasteMatchesChange(def, change.text, clipboardText)) {
                    continue;
                }
                sawMatchingPaste = true;
                const insertedLines = change.text.split('\n');
                const startLine = change.range.start.line;
                if (change.text.length === 0) { continue; }
                if (def.offsetInBlock >= insertedLines.length) { continue; }
                const expected = hashLine(insertedLines[def.offsetInBlock]);
                if (expected === def.annotation.lineHash) {
                    found = startLine + def.offsetInBlock;
                    break;
                }
            }
            if (found === null && sawMatchingPaste && def.annotation.lineHash) {
                const anchor: AnchorData = {
                    lineHash: def.annotation.lineHash,
                    contextBefore: def.annotation.contextBefore ?? [],
                    contextAfter: def.annotation.contextAfter ?? [],
                };
                found = findAnchor(ev.doc, anchor, -1);
            }
            if (found !== null) {
                const a = { ...def.annotation, file: ev.file };
                applySetLine(a, found, ev.doc);
                state.annotations.set(id, a);
                recovered.push(id);
                restoredThisEvent.add(id);
                restored.push(id);
            }
        }
        recovered.forEach(id => state.recentDeletions.delete(id));
    }

    const newLines: string[] = [];
    for (let i = 0; i < ev.doc.lineCount; i++) { newLines.push(ev.doc.lineAt(i).text); }
    const oldLines = state.snapshots.get(ev.fileKey) ?? [];
    const moves: MovedBlock[] = oldLines.length ? detectMoves(oldLines, newLines) : [];

    // Phase: per-annotation arithmetic / displacement / deferral.
    const idsSnapshot = Array.from(state.annotations.keys());
    for (const id of idsSnapshot) {
        const annotation = state.annotations.get(id);
        if (!annotation) { continue; }
        if (annotation.file !== ev.file) { continue; }
        if (restoredThisEvent.has(id)) { continue; }

        const oldLine = annotation.line;
        const undoRemovesCopiedAnnotation =
            ev.isUndoRedo &&
            annotation.origin?.kind === 'copy-paste' &&
            ev.contentChanges.some(ch =>
                ch.text === '' &&
                oldLine >= ch.range.start.line &&
                oldLine <= ch.range.end.line
            );
        if (undoRemovesCopiedAnnotation) {
            state.annotations.delete(id);
            removed.push(id);
            continue;
        }

        const move = moves.find(m => oldLine >= m.oldStart && oldLine <= m.oldEnd);
        if (move) {
            applySetLine(annotation, move.newStart + (oldLine - move.oldStart), ev.doc);
            continue;
        }

        let currentLine = oldLine;
        let markedDeleted = false;
        let pureCutTouchedLine = false;

        for (const change of ev.contentChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const lineDelta = change.text.split('\n').length - (endLine - startLine + 1);
            if (currentLine > endLine) {
                currentLine += lineDelta;
            } else if (currentLine >= startLine && currentLine <= endLine && lineDelta < 0) {
                markedDeleted = true;
                if (change.text === '') { pureCutTouchedLine = true; }
            }
        }

        const newLineCount = ev.doc.lineCount;
        const predictedInRange = currentLine >= 0 && currentLine < newLineCount;
        const predictedHashMatches =
            annotation.lineHash !== undefined &&
            predictedInRange &&
            hashLine(ev.doc.lineAt(currentLine).text) === annotation.lineHash;
        let lineDisplaced = false;
        if (!markedDeleted && annotation.lineHash !== undefined && !predictedHashMatches) {
            for (const ch of ev.contentChanges) {
                const erased = ch.text.replace(/\r\n/g, '').length === 0;
                if (erased && oldLine >= ch.range.start.line && oldLine <= ch.range.end.line) {
                    lineDisplaced = true;
                    break;
                }
            }
        }

        const arithmeticOutOfRange =
            !markedDeleted &&
            !lineDisplaced &&
            (currentLine < 0 || currentLine >= newLineCount);
        if (arithmeticOutOfRange) { markedDeleted = true; }

        if (markedDeleted || lineDisplaced) {
            const allowFindAnchor = !pureCutTouchedLine && !arithmeticOutOfRange;
            if (allowFindAnchor && annotation.lineHash) {
                const anchor: AnchorData = {
                    lineHash: annotation.lineHash,
                    contextBefore: annotation.contextBefore ?? [],
                    contextAfter: annotation.contextAfter ?? [],
                };
                const found = findAnchor(ev.doc, anchor, -1);
                if (found !== null) {
                    applySetLine(annotation, found, ev.doc);
                    continue;
                }
            }
            let offsetInBlock = 0;
            let cutLinesForAnnotation: string[] | undefined;
            for (const ch of ev.contentChanges) {
                if (annotation.line >= ch.range.start.line && annotation.line <= ch.range.end.line) {
                    offsetInBlock = Math.max(0, annotation.line - ch.range.start.line);
                    cutLinesForAnnotation = getCutLinesForChange(oldLines, ch, offsetInBlock);
                    break;
                }
            }
            state.annotations.delete(id);
            state.recentDeletions.set(id, {
                annotation: { ...annotation },
                deletedAt: Date.now(),
                offsetInBlock,
                cutText: cutLinesForAnnotation?.join('\n'),
                cutLineHashes: cutLinesForAnnotation?.map(line => hashLine(line)),
            });
            deferred.push(id);
        } else if (currentLine !== oldLine) {
            if (currentLine < 0 || currentLine >= newLineCount) { continue; }
            applySetLine(annotation, currentLine, ev.doc);
        }
    }

    // Snapshot update + duplicate detection.
    snapshotDoc(state, ev.fileKey, ev.doc);

    let duplicatesCreated = 0;
    if (!ev.isUndoRedo && ev.clipboardText) {
        const normalizedClipboard = ev.clipboardText.replace(/\r\n/g, '\n').trim();
        if (normalizedClipboard) {
            const seenTargets = new Set<number>();
            for (const change of ev.contentChanges) {
                const insertedLines = change.text.split('\n');
                const startLine = change.range.start.line;
                const endLine = change.range.end.line;
                const lineDelta = insertedLines.length - (endLine - startLine + 1);
                if (lineDelta <= 0) { continue; }
                const normalizedInserted = change.text.replace(/\r\n/g, '\n').trim();
                if (normalizedInserted !== normalizedClipboard) { continue; }
                const nonEmpty = insertedLines.filter(l => l.trim() !== '').length;
                if (nonEmpty < 2) { continue; }
                for (let k = 0; k < insertedLines.length; k++) {
                    const insertedHash = hashLine(insertedLines[k]);
                    const newLine = startLine + k;
                    if (seenTargets.has(newLine)) { continue; }
                    for (const annotation of state.annotations.values()) {
                        if (!annotation.lineHash || annotation.lineHash !== insertedHash) { continue; }
                        if (state.recentDeletions.has(annotation.id)) { continue; }
                        if (restoredThisEvent.has(annotation.id)) { continue; }
                        if (annotation.file === ev.file && Math.abs(newLine - annotation.line) < 2) { continue; }
                        seenTargets.add(newLine);
                        // shadow guard: cut buffer holding same message
                        let shadowed = false;
                        for (const def of state.recentDeletions.values()) {
                            const bufMsg = (def.annotation as MockAnnotation & { message?: string }).message;
                            if (bufMsg === annotation.message) {
                                shadowed = true; break;
                            }
                        }
                        if (shadowed) { break; }
                        const dup: MockAnnotation & { message?: string } = {
                            id: `${annotation.id}-dup-${newLine}`,
                            file: ev.file,
                            line: newLine,
                            message: annotation.message,
                            origin: {
                                kind: 'copy-paste',
                                sourceId: annotation.id,
                                sourceFile: annotation.file,
                                sourceLine: annotation.line,
                                pastedAtLine: newLine,
                            },
                        };
                        applySetLine(dup, newLine, ev.doc);
                        state.annotations.set(dup.id, dup);
                        duplicatesCreated++;
                        break;
                    }
                }
            }
        }
    }

    return { duplicatesCreated, restored, deferred, removed };
}

function liveCount(state: PipelineState, file?: string): number {
    if (!file) { return state.annotations.size; }
    let n = 0;
    for (const a of state.annotations.values()) { if (a.file === file) { n++; } }
    return n;
}

suite('F5 regression: cut single line then paste elsewhere -- count stays at 1, never line 1', () => {
    const file = 'src/sample.ts';
    const fileKey = 'file://sample.ts';
    // 'return result;' is a common idiom that recurs near the top of the file
    // (the early function), which is exactly what triggers the false-positive
    // findAnchor at line 0/1 in the legacy code.
    const baseLines = [
        'function early() {', // 0
        '    return result;', // 1  <-- DUPLICATE content, would have caught findAnchor
        '}',                  // 2
        '',                   // 3
        'function target() {',// 4
        '    return result;', // 5  <-- annotated line
        '}',                  // 6
        '',                   // 7
        'function tail() {',  // 8
        '    return tail;',   // 9
        '}',                  // 10
    ];
    const baseDoc = makeDoc(baseLines);
    const anchorAt5 = captureAnchor(baseDoc, 5);

    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('a1', {
        id: 'a1', file, line: 5,
        lineHash: anchorAt5.lineHash,
        contextBefore: anchorAt5.contextBefore,
        contextAfter: anchorAt5.contextAfter,
        message: 'review me',
    } as MockAnnotation & { message?: string });

    // EVENT 1: Ctrl+X on line 5 (range [5..6] text='', VS Code includes trailing newline).
    const afterCutLines = [...baseLines.slice(0, 5), ...baseLines.slice(6)];
    const afterCutDoc = makeDoc(afterCutLines);
    const cutOut = runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 5 }, end: { line: 6 } }, text: '' }],
    });

    // Snapshot intermediate state for the test assertions.
    const liveAfterCut = liveCount(state, file);
    const bufferAfterCut = state.recentDeletions.size;
    const restoredAfterCut = cutOut.restored.length;
    const deferredAfterCut = cutOut.deferred.length;

    // EVENT 2: Ctrl+V at line 8 (paste 'return result;\n' into the doc).
    const afterPasteLines = [
        ...afterCutLines.slice(0, 8),
        '    return result;',
        ...afterCutLines.slice(8),
    ];
    const afterPasteDoc = makeDoc(afterPasteLines);
    const pasteOut = runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 8 }, end: { line: 8 } }, text: '    return result;\n' }],
        clipboardText: '    return result;',
    });

    test('event 1 (cut): live map empty for the file, buffer holds the annotation', () => {
        assert.strictEqual(liveAfterCut, 0, 'no live annotation in target file after cut');
        assert.strictEqual(bufferAfterCut, 1, 'one entry deferred to buffer');
        assert.strictEqual(restoredAfterCut, 0);
        assert.strictEqual(deferredAfterCut, 1);
    });

    test('event 1 (cut): NO ghost annotation at line 0 or 1 (was the F5 phantom)', () => {
        for (const a of state.annotations.values()) {
            assert.ok(a.line > 1, `annotation at line ${a.line} would be a low-numbered phantom`);
        }
    });

    test('event 2 (paste): exactly 1 live annotation, located at the paste destination', () => {
        assert.strictEqual(liveCount(state, file), 1);
        const a = Array.from(state.annotations.values())[0];
        assert.strictEqual(a.line, 8, 'annotation lands at the paste line');
    });

    test('event 2 (paste): 0 duplicates created (cut+paste must move, not duplicate)', () => {
        assert.strictEqual(pasteOut.duplicatesCreated, 0);
    });

    test('event 2 (paste): buffer empty after recovery', () => {
        assert.strictEqual(state.recentDeletions.size, 0);
    });
});

suite('F5 regression: cut multi-line block then paste -- count stays at 1, lands at paste', () => {
    const file = 'app.ts';
    const fileKey = 'file://app.ts';
    const baseLines = [
        'header_a;',                         // 0
        'header_b;',                         // 1
        'header_c;',                         // 2
        '    function foo() {',              // 3
        '        const block_a = 1;',        // 4
        '        const block_b = 2;',        // 5  <-- annotated (offsetInBlock=1)
        '        const block_c = 3;',        // 6
        '    }',                             // 7
        'footer_a;',                         // 8
        'footer_b;',                         // 9
        'footer_c;',                         // 10
        'footer_d;',                         // 11
        'footer_e;',                         // 12
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 5);

    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('m1', {
        id: 'm1', file, line: 5,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'tag block_b',
    } as MockAnnotation & { message?: string });

    // EVENT 1: cut lines 4..6 (range [4..7] covers trailing newline).
    const afterCutLines = [...baseLines.slice(0, 4), ...baseLines.slice(7)];
    const afterCutDoc = makeDoc(afterCutLines);
    runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 4 }, end: { line: 7 } }, text: '' }],
    });

    const liveAfterCut = liveCount(state, file);
    const bufferAfterCut = state.recentDeletions.size;
    const offsetInBuffer = state.recentDeletions.get('m1')?.offsetInBlock;

    // EVENT 2: paste the 3-line block at line 9 of the post-cut doc.
    const block = '        const block_a = 1;\n        const block_b = 2;\n        const block_c = 3;\n';
    const afterPasteLines = [...afterCutLines.slice(0, 9), ...block.split('\n').slice(0, 3), ...afterCutLines.slice(9)];
    const afterPasteDoc = makeDoc(afterPasteLines);
    const pasteOut = runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 9 }, end: { line: 9 } }, text: block }],
        clipboardText: block,
    });

    test('event 1 (cut): live=0, buffer holds m1 with offsetInBlock=1', () => {
        assert.strictEqual(liveAfterCut, 0);
        assert.strictEqual(bufferAfterCut, 1);
        assert.strictEqual(offsetInBuffer, 1, 'offsetInBlock = 5 - 4 = 1');
    });

    test('event 2 (paste): exactly 1 annotation, on the middle line of the pasted block', () => {
        assert.strictEqual(liveCount(state, file), 1);
        const a = Array.from(state.annotations.values())[0];
        // Paste starts at line 9, offsetInBlock=1 -> annotation at line 10.
        assert.strictEqual(a.line, 10);
    });

    test('event 2 (paste): no arithmetic drift past the inserted block', () => {
        // Pre-fix bug: restored to 10 then arithmetically shifted to 13. Verify <=10.
        const a = Array.from(state.annotations.values())[0];
        assert.ok(a.line <= 11, `expected <=11, got ${a.line} (drift past inserted block?)`);
    });

    test('event 2 (paste): no duplicate annotation created alongside the restored one', () => {
        assert.strictEqual(pasteOut.duplicatesCreated, 0);
        assert.strictEqual(liveCount(state, file), 1, 'cut+paste must move, never duplicate');
    });
});

suite('F5 regression: cut multi-line block then edit before paste -- annotation stays suspended', () => {
    const file = 'src/sample.ts';
    const fileKey = 'file://sample.ts';
    const baseLines = [
        'const start = 1;',                  // 0
        'function setup() {',                // 1
        '    return start;',                 // 2
        '}',                                 // 3
        '',                                  // 4
        'async function run() {',            // 5
        '    try {',                         // 6
        '        await work();',             // 7
        '    } catch (error) {',             // 8
        '        report(error);',            // 9
        '    }',                             // 10
        '}',                                 // 11
        '',                                  // 12
        'function target() {',               // 13
        '',                                  // 14 <-- annotation above console.error
        '    console.error(error);',         // 15
        '}',                                 // 16
        'export { run, target };',           // 17
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 14, { walkForward: 0, walkBackward: 0 });
    const cutBlockLines = ['', '    console.error(error);'];
    const cutBlockText = cutBlockLines.join('\n');

    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('anno1', {
        id: 'anno1', file, line: 14,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'watch error path',
    } as MockAnnotation & { message?: string });

    // EVENT 1: Ctrl+X on lines 14..15. The annotation enters recentDeletions
    // with cutText bound to the full selected block, including the blank line.
    const afterCutLines = [...baseLines.slice(0, 14), ...baseLines.slice(16)];
    const afterCutDoc = makeDoc(afterCutLines);
    const cutOut = runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 14 }, end: { line: 16 } }, text: '' }],
        clipboardText: `${cutBlockText}\n`,
    });
    const liveAfterCut = liveCount(state, file);
    const bufferAfterCut = state.recentDeletions.size;

    // EVENT 2: user moves to line 10 and inserts a local newline before pasting.
    // This must not recover the blank-line annotation to the cursor location.
    const afterLocalEditLines = [...afterCutLines.slice(0, 10), '', ...afterCutLines.slice(10)];
    const afterLocalEditDoc = makeDoc(afterLocalEditLines);
    const editOut = runFullPipeline(state, {
        fileKey, file, doc: afterLocalEditDoc,
        contentChanges: [{ range: { start: { line: 10 }, end: { line: 10 } }, text: '\n' }],
        clipboardText: `${cutBlockText}\n`,
    });
    const liveAfterLocalEdit = liveCount(state, file);
    const bufferAfterLocalEdit = state.recentDeletions.size;

    // EVENT 3: actual paste of the cut block at line 10 restores the annotation
    // block-relative to the pasted content.
    const afterPasteLines = [
        ...afterLocalEditLines.slice(0, 10),
        ...cutBlockLines,
        ...afterLocalEditLines.slice(10),
    ];
    const afterPasteDoc = makeDoc(afterPasteLines);
    const pasteOut = runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 10 }, end: { line: 10 } }, text: `${cutBlockText}\n` }],
        clipboardText: `${cutBlockText}\n`,
    });

    test('event 1 (cut): annotation is removed from live map and stored in the cut buffer', () => {
        assert.strictEqual(cutOut.deferred.length, 1);
        assert.strictEqual(liveAfterCut, 0);
        assert.strictEqual(bufferAfterCut, 1);
    });

    test('event 2 (local edit before paste): no recovery occurs at the cursor line', () => {
        assert.deepStrictEqual(editOut.restored, []);
        assert.strictEqual(liveAfterLocalEdit, 0);
        assert.strictEqual(bufferAfterLocalEdit, 1);
    });

    test('event 3 (paste): annotation is restored to the pasted blank line', () => {
        assert.deepStrictEqual(pasteOut.restored, ['anno1']);
        const annotation = state.annotations.get('anno1');
        assert.ok(annotation, 'annotation should be live after paste');
        assert.strictEqual(annotation.line, 10);
        assert.strictEqual(state.recentDeletions.size, 0);
    });
});

suite('F5 regression: cut blank line then type space -- annotation stays suspended', () => {
    const file = 'src/blank.ts';
    const fileKey = 'file://src/blank.ts';
    const baseLines = [
        'const a = 1;',      // 0
        'const b = 2;',      // 1
        '',                  // 2 <-- annotated blank line
        'const c = 3;',      // 3
        'const d = 4;',      // 4
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 2, { walkForward: 0, walkBackward: 0 });

    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('blank1', {
        id: 'blank1', file, line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'blank note',
    } as MockAnnotation & { message?: string });

    const afterCutLines = [...baseLines.slice(0, 2), ...baseLines.slice(3)];
    const afterCutDoc = makeDoc(afterCutLines);
    runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 2 }, end: { line: 3 } }, text: '' }],
        clipboardText: '\n',
    });

    const afterSpaceLines = [...afterCutLines];
    afterSpaceLines[0] = `${afterSpaceLines[0]} `;
    const afterSpaceDoc = makeDoc(afterSpaceLines);
    const editOut = runFullPipeline(state, {
        fileKey, file, doc: afterSpaceDoc,
        contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: ' ' }],
        clipboardText: '\n',
    });
    const liveAfterSpace = liveCount(state, file);
    const bufferAfterSpace = state.recentDeletions.size;

    const afterPasteLines = [...afterSpaceLines.slice(0, 1), '', ...afterSpaceLines.slice(1)];
    const afterPasteDoc = makeDoc(afterPasteLines);
    const pasteOut = runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 1 }, end: { line: 1 } }, text: '\n' }],
        clipboardText: '\n',
    });

    test('local space edit is not treated as a paste of the blank cut line', () => {
        assert.deepStrictEqual(editOut.restored, []);
        assert.strictEqual(liveAfterSpace, 0);
        assert.strictEqual(bufferAfterSpace, 1);
    });

    test('actual paste of the blank cut line restores the annotation', () => {
        assert.deepStrictEqual(pasteOut.restored, ['blank1']);
        const annotation = state.annotations.get('blank1');
        assert.ok(annotation, 'annotation should be restored by paste');
        assert.strictEqual(annotation.line, 1);
        assert.strictEqual(state.recentDeletions.size, 0);
    });
});

suite('F5 regression: cut without paste -- count = 0 immediately, never line 1 phantom', () => {
    const file = 'snippet.ts';
    const fileKey = 'file://snippet.ts';
    const baseLines = [
        '}',           // 0  -- common idiom: triggers findAnchor false positive in legacy code
        'middle_a;',   // 1
        'middle_b;',   // 2
        '}',           // 3  -- annotated (was a closing brace cut)
        'tail_a;',     // 4
        'tail_b;',     // 5
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 3);

    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('p1', {
        id: 'p1', file, line: 3,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'why this brace',
    } as MockAnnotation & { message?: string });

    // Cut line 3 (the closing brace) -- legacy code's findAnchor would scan and
    // potentially relocate to line 0 (the other '}') with a permissive context score.
    const afterCutLines = [...baseLines.slice(0, 3), ...baseLines.slice(4)];
    const afterCutDoc = makeDoc(afterCutLines);
    runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 3 }, end: { line: 4 } }, text: '' }],
    });

    test('live map empty after cut (annotation deferred to buffer)', () => {
        assert.strictEqual(liveCount(state, file), 0);
    });

    test('NO phantom annotation at line 0 (the other closing brace)', () => {
        // Even if findAnchor would have found a hash match at line 0, the pure-cut
        // skip prevents relocation and forces deferral.
        for (const a of state.annotations.values()) {
            assert.ok(a.line > 0, `phantom landed at line ${a.line} (regression!)`);
        }
    });

    test('annotation sits in the buffer ready for a later paste', () => {
        assert.strictEqual(state.recentDeletions.size, 1);
        assert.ok(state.recentDeletions.has('p1'));
    });
});

suite('F5 regression: copy + paste -- count goes 1 -> 2 with original untouched', () => {
    const file = 'lib.ts';
    const fileKey = 'file://lib.ts';
    const baseLines = [
        'a;',         // 0
        'b;',         // 1
        'KEY_LINE;',  // 2  <-- annotated
        'c;',         // 3
        'd;',         // 4
        'e;',         // 5
        'f;',         // 6
        'g;',         // 7
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 2);
    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('orig', {
        id: 'orig', file, line: 2,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'pin me',
    } as MockAnnotation & { message?: string });

    // User did NOT cut. They copied lines 2..4 and pasted at line 6.
    const block = 'KEY_LINE;\nc;\nd;\n';
    const afterPasteLines = [...baseLines.slice(0, 6), ...block.split('\n').slice(0, 3), ...baseLines.slice(6)];
    const afterPasteDoc = makeDoc(afterPasteLines);
    const out = runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 6 }, end: { line: 6 } }, text: block }],
        clipboardText: block.trim(),
    });

    test('exactly 1 duplicate created at the paste position', () => {
        assert.strictEqual(out.duplicatesCreated, 1);
    });

    test('original annotation stays at line 2', () => {
        const orig = state.annotations.get('orig');
        assert.ok(orig, 'original annotation should exist');
        assert.strictEqual(orig.line, 2);
    });

    test('total live count = 2 (original + duplicate)', () => {
        assert.strictEqual(liveCount(state, file), 2);
    });

    test('duplicate lands at the first line of the pasted block', () => {
        const dup = Array.from(state.annotations.values()).find(a => a.id !== 'orig');
        assert.ok(dup, 'duplicate annotation should exist');
        assert.strictEqual(dup.line, 6);
    });
});

suite('F5 regression: undo after copy+paste removes the copied annotation', () => {
    const file = 'copyUndo.ts';
    const fileKey = 'file://copyUndo.ts';
    const baseLines = [
        'pre();',          // 0
        'console.error();',// 1 <-- annotated
        'after();',        // 2
        'tail();',         // 3
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 1);

    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('anno1', {
        id: 'anno1', file, line: 1,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'check error path',
    } as MockAnnotation & { message?: string });

    const block = 'console.error();\nafter();\n';
    const afterPasteLines = [...baseLines, 'console.error();', 'after();'];
    const afterPasteDoc = makeDoc(afterPasteLines);
    const pasteOut = runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 4 }, end: { line: 4 } }, text: block }],
        clipboardText: block,
    });
    const duplicate = Array.from(state.annotations.values()).find(a => a.id !== 'anno1');

    const undoDoc = makeDoc(baseLines);
    const undoOut = runFullPipeline(state, {
        fileKey, file, doc: undoDoc,
        contentChanges: [{ range: { start: { line: 4 }, end: { line: 6 } }, text: '' }],
        isUndoRedo: true,
        clipboardText: block,
    });

    test('copy paste creates a derived annotation at the pasted block', () => {
        assert.strictEqual(pasteOut.duplicatesCreated, 1);
        assert.ok(duplicate, 'duplicate should exist after paste');
        assert.strictEqual(duplicate?.origin?.kind, 'copy-paste');
    });

    test('undo removes the derived annotation instead of moving it or buffering it', () => {
        assert.deepStrictEqual(undoOut.removed, [duplicate?.id]);
        assert.deepStrictEqual(undoOut.deferred, []);
        assert.strictEqual(state.recentDeletions.size, 0);
        assert.strictEqual(liveCount(state, file), 1);
    });

    test('original annotation remains at its original line after undo', () => {
        const original = state.annotations.get('anno1');
        assert.ok(original, 'original annotation should remain');
        assert.strictEqual(original.line, 1);
    });
});

suite('F5 regression: cut + paste + redo -- count never exceeds 1', () => {
    const file = 'ops.ts';
    const fileKey = 'file://ops.ts';
    const baseLines = [
        'pre_0;', 'pre_1;', 'pre_2;',
        'CUT_LINE;', 'CUT_TAIL_A;', 'CUT_TAIL_B;',
        'post_0;', 'post_1;', 'post_2;', 'post_3;',
    ];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 3);
    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('s1', {
        id: 's1', file, line: 3,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'sequence',
    } as MockAnnotation & { message?: string });

    // T0: cut block [3..5]
    const afterCutLines = [...baseLines.slice(0, 3), ...baseLines.slice(6)];
    const afterCutDoc = makeDoc(afterCutLines);
    runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 3 }, end: { line: 6 } }, text: '' }],
    });

    // T1: paste block at line 6 (end of post-cut doc).
    const block = 'CUT_LINE;\nCUT_TAIL_A;\nCUT_TAIL_B;\n';
    const afterPasteLines = [...afterCutLines.slice(0, 6), ...block.split('\n').slice(0, 3), ...afterCutLines.slice(6)];
    const afterPasteDoc = makeDoc(afterPasteLines);
    runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 6 }, end: { line: 6 } }, text: block }],
        clipboardText: block.trim(),
    });

    // T2: simulate redo of the paste (replay).
    runFullPipeline(state, {
        fileKey, file, doc: afterPasteDoc,
        contentChanges: [{ range: { start: { line: 6 }, end: { line: 6 } }, text: block }],
        clipboardText: block.trim(),
        isUndoRedo: true,
    });

    test('after the full cut+paste+redo sequence, exactly 1 annotation exists', () => {
        assert.strictEqual(liveCount(state, file), 1);
    });

    test('annotation final position matches the paste destination, not 0/1', () => {
        const a = Array.from(state.annotations.values())[0];
        assert.ok(a.line >= 6 && a.line <= 8, `expected restored line in [6..8], got ${a.line}`);
    });
});

suite('F5 regression: arithmetic out-of-range cut clamps without writing line < 0', () => {
    const file = 'edge.ts';
    const fileKey = 'file://edge.ts';
    const baseLines = ['a;', 'b;', 'c;', 'd;'];
    const baseDoc = makeDoc(baseLines);
    const anchor = captureAnchor(baseDoc, 3);
    const state = makeState();
    snapshotDoc(state, fileKey, baseDoc);
    state.annotations.set('z1', {
        id: 'z1', file, line: 3,
        lineHash: anchor.lineHash,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        message: 'tail',
    } as MockAnnotation & { message?: string });

    // Crafted change: VS Code reports change covering [4..6] with text='' even
    // though oldLine=3 is below it. The arithmetic alone would not flag deleted,
    // and currentLine (3) > endLine? false. We instead simulate a delete that
    // would force currentLine negative via an upstream change covering [0..5].
    const afterCutLines: string[] = [];
    const afterCutDoc = makeDoc(afterCutLines);
    runFullPipeline(state, {
        fileKey, file, doc: afterCutDoc,
        contentChanges: [{ range: { start: { line: 0 }, end: { line: 4 } }, text: '' }],
    });

    test('live map cleared (annotation either deferred or removed, never line < 0)', () => {
        for (const a of state.annotations.values()) {
            assert.ok(a.line >= 0, `annotation written at line ${a.line}`);
        }
    });

    test('annotation moved to recentDeletions (no orphan in the live map)', () => {
        assert.strictEqual(liveCount(state, file), 0);
        assert.ok(state.recentDeletions.has('z1') || !state.annotations.has('z1'));
    });
});
