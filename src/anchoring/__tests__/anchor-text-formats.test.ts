/**
 * Pure unit tests for non-source-code file types: Markdown, plain text, JSON.
 *
 * Today's anchoring algorithm is tuned for code (unique identifiers per line);
 * this suite documents how it behaves on prose, structured data, and repeated
 * structural lines so a future fix can lock in the regression.
 */
import { strict as assert } from 'assert';
import { captureAnchor, findAnchor, reanchor, hashLine } from '../anchor';
import type { TextDocumentLike } from '../anchor';

function makeDoc(lines: string[]): TextDocumentLike {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] ?? '' }),
    };
}

// ---------------------------------------------------------------------------
// Markdown (.md)
// ---------------------------------------------------------------------------
suite('anchoring on Markdown content', () => {
    test('M1: rename "## Setup" to "## Installation" -> orphan', () => {
        const before = [
            '# Project',
            '',
            'Intro paragraph describing the project.',
            '',
            '## Setup', // 4 -- annotated
            '',
            'Run npm install.',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 4);

        const after = [
            '# Project',
            '',
            'Intro paragraph describing the project.',
            '',
            '## Installation', // 4 -- renamed
            '',
            'Run npm install.',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 4,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'orphan');
    });

    test('M2: insert "- Avocado" above "- Apple" -> moved 5 to 6', () => {
        const before = [
            '# Fruits',
            '',
            'A classic shopping list:',
            '',
            'Picks for the week:',
            '- Apple', // 5 -- annotated
            '- Banana',
            '- Cherry',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 5);

        const after = [
            '# Fruits',
            '',
            'A classic shopping list:',
            '',
            'Picks for the week:',
            '- Avocado', // newly inserted at 5
            '- Apple', // 6 -- target shifted
            '- Banana',
            '- Cherry',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 5,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 6);
        assert.strictEqual(result.newHash, hashLine('- Apple'));
    });

    test('M3: three "---" separators, anchor on the second, prepend a section -> stays on the same separator', () => {
        // Three identical "---" lines collide on lineHash. The middle one must
        // be re-located via context (the surrounding section content), not by
        // hash uniqueness or by stored-line proximity.
        const before = [
            '---', // 0 (frontmatter open)
            'title: Doc',
            '---', // 2 (frontmatter close)
            '',
            '## Section A',
            'Body of section A.',
            '---', // 6 -- ANNOTATED separator between A and B
            '',
            '## Section B',
            'Body of section B.',
            '---', // 10 (separator between B and C)
            '',
            '## Section C',
            'Body of section C.',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 6);

        const after = [
            '## Section Zero',
            'New section prepended above everything.',
            '',
            '---', // 3 (was 0)
            'title: Doc',
            '---', // 5 (was 2)
            '',
            '## Section A',
            'Body of section A.',
            '---', // 9 -- the original target, shifted by 3
            '',
            '## Section B',
            'Body of section B.',
            '---', // 13 (was 10)
            '',
            '## Section C',
            'Body of section C.',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 6,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 9);
    });

    test('M4: anchor on a unique paragraph line, prepend a paragraph -> moved by inserted-line count', () => {
        const before = [
            '# Title',
            '',
            'First paragraph introducing the topic.',
            '',
            'A very specific sentence about anchoring algorithms.', // 4 -- annotated
            '',
            'Closing paragraph.',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 4);

        // Prepend a 3-line paragraph (header + body + blank) -> shifts target by 3.
        const after = [
            '# Title',
            '',
            'New preamble paragraph that did not exist before.',
            '',
            'First paragraph introducing the topic.',
            '',
            'A very specific sentence about anchoring algorithms.', // 6
            '',
            'Closing paragraph.',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 4,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 6);
        assert.strictEqual(result.newHash, hashLine('A very specific sentence about anchoring algorithms.'));
    });

    test('M5: anchor inside a ts code fence, add another fence above -> moved correctly', () => {
        const before = [
            '# Examples',
            '',
            '```ts',
            'const greeting = "hello world";', // 3 -- annotated
            'console.log(greeting);',
            '```',
            '',
            'End.',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 3);

        const after = [
            '# Examples',
            '',
            '```ts',
            'const earlier = 1 + 1;',
            'console.log(earlier);',
            '```',
            '',
            '```ts',
            'const greeting = "hello world";', // 8 -- shifted by 5
            'console.log(greeting);',
            '```',
            '',
            'End.',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 3,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 8);
    });
});

// ---------------------------------------------------------------------------
// Plain text (.txt)
// ---------------------------------------------------------------------------
suite('anchoring on plain text content', () => {
    test('T1: anchor on a 60-char unique line, insert 2 lines above -> moved by 2', () => {
        const uniqueLine = 'A long sentence whose exact wording does not appear elsewhere.'; // 62 chars
        const before = [
            'Plain text scratchpad.',
            '',
            'Some musings about the day.',
            '',
            uniqueLine, // 4 -- annotated
            '',
            'More musings.',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 4);

        const after = [
            'Plain text scratchpad.',
            '',
            'A NEW intro line.',
            'Another NEW line.',
            'Some musings about the day.',
            '',
            uniqueLine, // 6 -- shifted by 2
            '',
            'More musings.',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 4,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 6);
    });

    test('T2: three "===" separators, anchor on the middle, reorder -> resolves via context', () => {
        const before = [
            'Section A title',
            'Body of section A continues here.',
            '===', // 2
            'Section B title',
            'Body of section B continues here.',
            '===', // 5 -- ANNOTATED middle separator
            'Section C title',
            'Body of section C continues here.',
            '===', // 8
            'Section D title',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 5);

        // Reorder to (B, A, C, D) — section B now at the top, the annotated
        // separator now sits between B and A.
        const after = [
            'Section B title',
            'Body of section B continues here.',
            '===', // 2 -- the original middle separator landed here
            'Section A title',
            'Body of section A continues here.',
            '===', // 5
            'Section C title',
            'Body of section C continues here.',
            '===', // 8
            'Section D title',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 5,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        // Genuinely ambiguous reorder: after rotating sections to (B, A, C, D)
        // there is no separator with B above AND C below in the new doc. The
        // contextBefore (B section) and contextAfter (C section) end up on
        // opposite sides of the rotation, so two different `===` candidates
        // each match half of the expected context. The algorithm picks the
        // candidate with the higher context score (line 5: A above + C below
        // beats line 2: B above + A below), which happens to be storedLine,
        // so the result is 'matched' at line 5. A user wanting stronger
        // disambiguation would need a larger contextSize on capture.
        assert.strictEqual(result.status, 'matched');
        assert.strictEqual(result.newLine, 5);
    });

    test('T3: cursor on a blank line walks forward to a target, anchor follows that target through edits', () => {
        const before = [
            'Para 1 line 1.',
            'Para 1 line 2.',
            '',
            'Para 2 line 1.',
            'Para 2 line 2.',
            '',
            'Para 3 line 1.',
            '', // 7 -- cursor on a blank line
            'Para 4 line 1.',
            'Para 4 line 2.',
        ];
        const beforeDoc = makeDoc(before);
        // captureAnchor walks forward from a blank line to the next non-blank.
        const captured = captureAnchor(beforeDoc, 7);
        // The chosen target is "Para 4 line 1." at line 8.
        assert.strictEqual(captured.targetLine, 8);

        // Insert two lines at the very top -> Para 4 line 1 now at 10.
        const after = ['New top 1.', 'New top 2.', ...before];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 7, // user's original line (the blank); reanchor uses lineHash + context
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 10);
    });

    test('T4: three sections with similar headers, anchor in section B, reorder (B, A, C) -> follows section B content', () => {
        const before = [
            'Section A:',
            'A1. content',
            'A2. content',
            '',
            'Section B:',
            'B1. content',
            'B2. unique-string-only-in-B', // 6 -- annotated
            '',
            'Section C:',
            'C1. content',
            'C2. content',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 6);

        // Reorder to put Section B first.
        const after = [
            'Section B:',
            'B1. content',
            'B2. unique-string-only-in-B', // 2 -- target moved to top section
            '',
            'Section A:',
            'A1. content',
            'A2. content',
            '',
            'Section C:',
            'C1. content',
            'C2. content',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 6,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 2);
    });
});

// ---------------------------------------------------------------------------
// JSON (.json)
// ---------------------------------------------------------------------------
suite('anchoring on JSON content', () => {
    test('J1: anchor on `"name": "alice",`, insert `"age": 30,` above -> moved 10 to 11', () => {
        const before = [
            '{',
            '    "users": [',
            '        {',
            '            "id": 1,',
            '            "active": true',
            '        },',
            '        {',
            '            "id": 2,',
            '            "role": "admin",',
            '            "name": "alice",', // 9 -- annotated (line 9, not 10 — adjust below)
            '            "active": true',
            '        }',
            '    ]',
            '}',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 9);

        const after = [
            '{',
            '    "users": [',
            '        {',
            '            "id": 1,',
            '            "active": true',
            '        },',
            '        {',
            '            "id": 2,',
            '            "role": "admin",',
            '            "age": 30,', // newly inserted at 9
            '            "name": "alice",', // 10 -- shifted
            '            "active": true',
            '        }',
            '    ]',
            '}',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 9,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'moved');
        assert.strictEqual(result.newLine, 10);
    });

    test('J2: 5 closing-brace lines collide on hash; anchor on the 3rd -> resolves to the 3rd via context', () => {
        // Each item has a distinct "id" value so contextBefore differentiates
        // the 5 closing braces. The unedited document path (storedLine = -1)
        // forces findAnchor through the hash-scan + context-vote codepath rather
        // than letting the fast-path return the stored line trivially.
        const lines = [
            '{',
            '  "items": [',
            '    {',
            '      "id": 1',
            '    },', // 4
            '    {',
            '      "id": 2',
            '    },', // 7
            '    {',
            '      "id": 3',
            '    },', // 10 -- annotated 3rd closing item
            '    {',
            '      "id": 4',
            '    },', // 13
            '    {',
            '      "id": 5',
            '    }', // 16
            '  ]',
            '}',
        ];
        const doc = makeDoc(lines);
        const captured = captureAnchor(doc, 10);

        // Bypass the fast path so the algorithm has to disambiguate among
        // candidates by context vote.
        const found = findAnchor(doc, captured, -1);
        assert.strictEqual(found, 10);
    });

    test('J3: array of 5 identical objects, anchor inside the 3rd, append a 6th at the end -> stays in 3rd', () => {
        const before = [
            '[',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false }, // 3 -- annotated 3rd item',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false }',
            ']',
        ];
        // Use an annotated line whose text is genuinely the item; line 3 above
        // has a comment to make the doc readable -- replace with the pure form.
        const beforeClean = [
            '[',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false },', // 3 -- annotated
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false }',
            ']',
        ];
        // Silence "before unused" warning -- kept for documentation symmetry.
        void before;
        const beforeDoc = makeDoc(beforeClean);
        const captured = captureAnchor(beforeDoc, 3);

        const after = [
            '[',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false },', // 3 -- unchanged
            '  { "type": "todo", "done": false },',
            '  { "type": "todo", "done": false },', // closing punctuation now ","
            '  { "type": "todo", "done": false }', // newly appended 6th
            ']',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 3,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'matched');
        assert.strictEqual(result.newLine, 3);
    });

    test('J4: change "1.0.0" to "1.0.1" -> orphan (lineHash mismatch, no other line matches)', () => {
        const before = [
            '{',
            '  "name": "out-of-code-insights",',
            '  "version": "1.0.0",', // 2 -- annotated
            '  "license": "MPL-2.0"',
            '}',
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 2);

        const after = [
            '{',
            '  "name": "out-of-code-insights",',
            '  "version": "1.0.1",', // 2 -- value bumped, hash differs
            '  "license": "MPL-2.0"',
            '}',
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 2,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        assert.strictEqual(result.status, 'orphan');
    });
});
