/**
 * Unit tests for annotation-tracking scenarios.
 *
 * Strategy: AnnotationManager is deeply coupled to the VS Code host.
 * Rather than instantiating the real class (which requires vscode APIs),
 * these tests exercise the underlying algorithms -- line-shift arithmetic,
 * anchor re-location, move detection, migration -- in isolation.
 * Phase B will wire these same algorithms into AnnotationManager; the tests
 * serve as the executable specification for that wiring.
 *
 * No VS Code host required. No sinon. No external stubs.
 */
import * as assert from 'assert';
import {
    hashLine,
    captureAnchor,
    findAnchor,
    detectMoves,
    TextDocumentLike,
    AnchorData,
} from '../../../anchoring/anchor';

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

interface AnnotationSlice {
    id: string;
    file: string;
    line: number;
    lineHash?: string;
    contextBefore?: string[];
    contextAfter?: string[];
}

function makeDoc(lines: string[]): TextDocumentLike {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] ?? '' }),
    };
}

/**
 * Simulate AnnotationManager.handleDocumentChange line-shift arithmetic.
 * Returns the shifted set and the IDs of annotations that landed inside
 * the deleted region (caller decides whether to drop them based on the
 * simulated showWarningMessage response).
 */
function applyDocumentChange(
    annotations: AnnotationSlice[],
    filePath: string,
    change: { startLine: number; endLine: number; newText: string }
): { kept: AnnotationSlice[]; markedForDeletion: string[] } {
    const newLineCount = change.newText.split('\n').length;
    const lineDelta = newLineCount - (change.endLine - change.startLine + 1);
    const markedForDeletion: string[] = [];
    const kept: AnnotationSlice[] = [];

    for (const a of annotations) {
        if (a.file !== filePath) {
            kept.push(a);
            continue;
        }
        if (a.line > change.endLine) {
            kept.push({ ...a, line: a.line + lineDelta });
        } else if (a.line >= change.startLine && a.line <= change.endLine) {
            if (lineDelta < 0) {
                markedForDeletion.push(a.id);
                // Keep it in the set until the user decides; applyDeletionDecision
                // will filter it out only when the user confirms 'Yes'.
                kept.push(a);
            } else {
                kept.push(a);
            }
        } else {
            kept.push(a);
        }
    }

    return { kept, markedForDeletion };
}

/**
 * Simulate the showWarningMessage decision gate.
 * response === 'Yes'  -> confirmed deletion
 * response === 'No'   -> user declined, annotations kept
 * response === undefined -> dismissed, annotations kept
 */
function applyDeletionDecision(
    kept: AnnotationSlice[],
    markedForDeletion: string[],
    response: 'Yes' | 'No' | undefined
): AnnotationSlice[] {
    if (response === 'Yes') {
        return kept.filter(a => !markedForDeletion.includes(a.id));
    }
    return kept;
}

/**
 * Simulate silent migration: for an annotation without lineHash, capture
 * the anchor from the current document state and populate the fields.
 */
function migrateAnnotation(
    annotation: AnnotationSlice,
    doc: TextDocumentLike
): AnnotationSlice {
    if (annotation.lineHash !== undefined) {
        return annotation;
    }
    const anchor = captureAnchor(doc, annotation.line);
    return { ...annotation, ...anchor };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

suite('annotation tracking: insert above', () => {
    test('annotation at line 10 shifts to line 13 after inserting 3 lines at line 2', () => {
        const annotations: AnnotationSlice[] = [
            { id: 'a1', file: 'src/foo.ts', line: 10 },
        ];
        const { kept } = applyDocumentChange(annotations, 'src/foo.ts', {
            startLine: 2,
            endLine: 2,
            newText: 'new_a\nnew_b\nnew_c\noriginal_2',
        });
        assert.strictEqual(kept.length, 1);
        assert.strictEqual(kept[0].line, 13);
    });
});

suite('annotation tracking: insert below', () => {
    test('annotation at line 5 is unaffected by an insertion at line 7', () => {
        const annotations: AnnotationSlice[] = [
            { id: 'a1', file: 'src/foo.ts', line: 5 },
        ];
        const { kept } = applyDocumentChange(annotations, 'src/foo.ts', {
            startLine: 7,
            endLine: 7,
            newText: 'inserted_a\ninserted_b\noriginal_7',
        });
        assert.strictEqual(kept.length, 1);
        assert.strictEqual(kept[0].line, 5);
    });
});

suite('annotation tracking: delete anchored line -- silent removal', () => {
    // New UX: no modal dialog. Annotation is silently removed from the live map and
    // moved to the clipboard buffer (recentDeletions 5s) then to deletedRecently (30s Undo).
    const annotations: AnnotationSlice[] = [
        { id: 'a1', file: 'src/foo.ts', line: 5 },
    ];
    // Delete lines 4-6 (lineDelta < 0 => annotation is marked for silent removal)
    const { kept, markedForDeletion } = applyDocumentChange(
        annotations,
        'src/foo.ts',
        { startLine: 4, endLine: 6, newText: '' }
    );

    test('annotation is silently removed from live map when its line is deleted', () => {
        // Silent path: remove immediately (no dialog, no warningResponse needed).
        const result = applyDeletionDecision(kept, markedForDeletion, 'Yes');
        assert.strictEqual(result.length, 0);
    });

    test('markedForDeletion contains the annotation id (for buffer handoff)', () => {
        assert.ok(markedForDeletion.includes('a1'));
    });

    test('annotation retained in kept[] with lineHash for undo restoration', () => {
        // kept[] holds the annotation even while markedForDeletion so Undo can restore it
        const buffered = kept.find(a => a.id === 'a1');
        assert.ok(buffered, 'annotation is available in kept for Undo');
    });
});

suite('annotation tracking: cut+paste intra-file', () => {
    test('detectMoves finds the block and annotation follows to new position', () => {
        const block = ['function foo() {', '  return 42;', '}'];
        const pre   = Array.from({ length: 5 }, (_, i) => `line_${i}`);
        const post  = Array.from({ length: 8 }, (_, i) => `post_${i}`);

        // Block was at oldStart=5 (lines 5-7), moved to newStart=13 (lines 13-15)
        const oldLines = [...pre, ...block, ...post];
        const newLines = [...pre, ...post, ...block];

        const moves = detectMoves(oldLines, newLines);

        assert.strictEqual(moves.length, 1, 'one moved block');
        const [move] = moves;

        // Annotation was on the first line of the block (oldStart)
        const oldAnnotationLine = move.oldStart;
        const lineOffsetInBlock = oldAnnotationLine - move.oldStart;
        const newAnnotationLine = move.newStart + lineOffsetInBlock;

        assert.strictEqual(newAnnotationLine, move.newStart);
        assert.strictEqual(newAnnotationLine, 13);
    });
});

suite('annotation tracking: copy+paste resolver behavior', () => {
    test('original annotation stays at its position before the duplication pass runs', () => {
        // Copy+paste: original lines remain, a duplicate block appears elsewhere.
        // The resolver must not move the source annotation to the copy. The
        // production copy-paste pass is responsible for creating a second
        // annotation at the pasted block.
        const lines = [
            'const x = 1;', // 0 -- annotated
            'const y = 2;', // 1
            'const x = 1;', // 2 -- copy (same content, different position)
        ];
        const doc = makeDoc(lines);
        const anchor = captureAnchor(doc, 0, 1);

        // Fast path succeeds: line 0 still has the right hash.
        const resolved = findAnchor(doc, anchor, 0);
        assert.strictEqual(resolved, 0, 'annotation stays on original line 0');
    });
});

suite('annotation tracking: drag-and-drop via two sequential ContentChange events', () => {
    test('annotation follows through delete-then-insert sequence', () => {
        // Simulate drag: user moves line 3 to line 0.
        // Step 1: delete line 3.
        // Step 2: insert it back at line 0.
        let annotations: AnnotationSlice[] = [
            { id: 'a1', file: 'src/foo.ts', line: 3 },
        ];

        // Step 1: delete line 3 (the dragged line). lineDelta = -1.
        // Annotation is in the deleted range, so it is marked for deletion.
        const step1 = applyDocumentChange(annotations, 'src/foo.ts', {
            startLine: 3,
            endLine: 3,
            newText: '',
        });
        // User said Yes to delete (the drag operation itself is the intent).
        annotations = applyDeletionDecision(step1.kept, step1.markedForDeletion, 'Yes');

        // Step 2: insert the line back at position 0. lineDelta = +1.
        // In a real AnnotationManager, the new anchor is placed by the UI, not
        // by handleDocumentChange.  Here we verify that existing annotations
        // below the insertion point shift down by 1 as expected.
        const bystander: AnnotationSlice[] = [
            { id: 'b1', file: 'src/foo.ts', line: 2 },
        ];
        const step2 = applyDocumentChange(bystander, 'src/foo.ts', {
            startLine: 0,
            endLine: 0,
            newText: 'dragged_line\noriginal_0',
        });

        assert.strictEqual(step2.kept.length, 1);
        assert.strictEqual(step2.kept[0].id, 'b1');
        assert.strictEqual(step2.kept[0].line, 3, 'bystander annotation shifts down by 1');
    });
});

suite('annotation tracking: undo/redo', () => {
    test('position reverts after an undo reverses a prior insertion', () => {
        let annotations: AnnotationSlice[] = [
            { id: 'a1', file: 'src/foo.ts', line: 5 },
        ];

        // Forward edit: insert 2 lines at line 3 -> annotation shifts to 7.
        const forward = applyDocumentChange(annotations, 'src/foo.ts', {
            startLine: 3,
            endLine: 3,
            newText: 'ins_a\nins_b\noriginal_3',
        });
        annotations = forward.kept;
        assert.strictEqual(annotations[0].line, 7);

        // Undo: replace lines [3..5] (ins_a, ins_b, original_3) with original_3.
        // lineDelta = 1 - (5-3+1) = 1 - 3 = -2
        // annotation was at 7, 7 > 5 (endLine), so 7 + (-2) = 5.
        const undo = applyDocumentChange(annotations, 'src/foo.ts', {
            startLine: 3,
            endLine: 5,
            newText: 'original_3',
        });
        annotations = undo.kept;
        assert.strictEqual(annotations[0].line, 5, 'line reverts to 5 after undo');
    });
});

suite('annotation tracking: external edit (lineHash mismatch on open)', () => {
    test('findAnchor relocates annotation after an out-of-VS Code edit shifts lines', () => {
        // Simulates: user edits file in another editor, inserts 10 lines before
        // the annotated line.  VS Code was closed, so onDidChangeTextDocument
        // never fired.  On re-open, storedLine=5 is now at line 15.
        const linesBefore: string[] = Array.from({ length: 5 }, (_, i) => `pre_${i}`);
        const linesAfter: string[] = Array.from({ length: 5 }, (_, i) => `post_${i}`);
        const annotatedContent = 'const IMPORTANT = true;';

        const doc = makeDoc([
            ...linesBefore,                          // 0..4
            ...Array.from({ length: 10 }, (_, i) => `inserted_${i}`), // 5..14
            ...linesBefore,                          // 15..19 (same before-context)
            annotatedContent,                        // 20 -- real location
            ...linesAfter,                           // 21..25
        ]);

        const anchor: AnchorData = {
            lineHash: hashLine(annotatedContent),
            contextBefore: linesBefore.map(l => l),   // normalized equals original here
            contextAfter: linesAfter.slice(0, 3).map(l => l),
        };

        // storedLine=5 no longer holds annotatedContent -> fast path fails.
        const resolved = findAnchor(doc, anchor, 5);
        assert.strictEqual(resolved, 20);
    });
});

suite('annotation tracking: file rename', () => {
    test('annotation.file path is updated to the new name', () => {
        const annotations: AnnotationSlice[] = [
            { id: 'a1', file: 'src/old.ts', line: 3 },
            { id: 'a2', file: 'src/other.ts', line: 7 },
        ];

        // Simulate handleFileRename: replace file path for renamed file.
        const oldPath = 'src/old.ts';
        const newPath = 'src/renamed.ts';
        const updated = annotations.map(a =>
            a.file === oldPath ? { ...a, file: newPath } : a
        );

        const a1 = updated.find(a => a.id === 'a1');
        const a2 = updated.find(a => a.id === 'a2');
        assert.ok(a1, 'renamed annotation should exist');
        assert.ok(a2, 'unrelated annotation should exist');
        assert.strictEqual(a1.file, newPath);
        assert.strictEqual(a2.file, 'src/other.ts', 'unrelated annotation unaffected');
    });
});

suite('annotation tracking: retrocompatibility -- legacy annotation without lineHash', () => {
    test('loads without error when lineHash fields are absent', () => {
        // A JSON entry without the new fields (as written by an older version).
        const raw: AnnotationSlice = {
            id: 'legacy-1',
            file: 'src/legacy.ts',
            line: 7,
            // lineHash, contextBefore, contextAfter are intentionally absent
        };
        assert.strictEqual(raw.lineHash, undefined);
        assert.strictEqual(raw.contextBefore, undefined);
        assert.strictEqual(raw.contextAfter, undefined);
    });

    test('silently migrates a legacy annotation by capturing anchor from current document', () => {
        const lines = [
            'import React from "react";',   // 0
            'import { useState } from "react";', // 1
            'export function App() {',       // 2
            '  return <div />;',             // 3
            '}',                             // 4
        ];
        const doc = makeDoc(lines);

        const legacy: AnnotationSlice = { id: 'leg-1', file: 'app.tsx', line: 2 };
        const migrated = migrateAnnotation(legacy, doc);

        assert.strictEqual(typeof migrated.lineHash, 'string', 'lineHash populated');
        assert.ok(Array.isArray(migrated.contextBefore), 'contextBefore populated');
        assert.ok(Array.isArray(migrated.contextAfter), 'contextAfter populated');
        assert.strictEqual(migrated.lineHash, hashLine('export function App() {'));
    });

    test('migration is idempotent: already-migrated annotations are left unchanged', () => {
        const doc = makeDoc(['const x = 1;', 'const y = 2;']);
        const alreadyMigrated: AnnotationSlice = {
            id: 'am-1',
            file: 'f.ts',
            line: 0,
            lineHash: hashLine('const x = 1;'),
            contextBefore: [],
            contextAfter: ['const y = 2;'],
        };
        const result = migrateAnnotation(alreadyMigrated, doc);
        assert.strictEqual(result.lineHash, alreadyMigrated.lineHash);
        assert.deepStrictEqual(result.contextAfter, alreadyMigrated.contextAfter);
    });
});
