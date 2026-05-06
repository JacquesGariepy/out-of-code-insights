/**
 * Pure unit tests for src/anchoring/anchor.ts.
 * No VS Code host required: anchor.ts depends only on TextDocumentLike
 * (a plain duck-typed interface) and the 'diff' npm package.
 */
import * as assert from 'assert';
import {
    normalizeLine,
    hashLine,
    captureAnchor,
    findAnchor,
    detectMoves,
    EMPTY_LINE_HASH,
    isEmptyLineHash,
    TextDocumentLike,
} from '../anchor';

function makeDoc(lines: string[]): TextDocumentLike {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] ?? '' }),
    };
}

// ---------------------------------------------------------------------------
// normalizeLine
// ---------------------------------------------------------------------------
suite('normalizeLine', () => {
    test('trims leading and trailing whitespace', () => {
        assert.strictEqual(normalizeLine('  hello  '), 'hello');
    });

    test('collapses internal whitespace runs to a single space', () => {
        assert.strictEqual(normalizeLine('a\t  b\t c'), 'a b c');
    });

    test('returns empty string for blank lines', () => {
        assert.strictEqual(normalizeLine('   '), '');
    });
});

// ---------------------------------------------------------------------------
// hashLine
// ---------------------------------------------------------------------------
suite('hashLine', () => {
    test('is deterministic: same input always produces the same hash', () => {
        const text = 'const answer = 42;';
        assert.strictEqual(hashLine(text), hashLine(text));
    });

    test('produces exactly 8 lowercase hex characters', () => {
        assert.match(hashLine('any line of source code'), /^[0-9a-f]{8}$/);
    });

    test('produces different hashes for different inputs', () => {
        assert.notStrictEqual(hashLine('foo();'), hashLine('bar();'));
    });

    test('two lines that differ only in indentation produce the same hash (normalized)', () => {
        assert.strictEqual(hashLine('  return x;'), hashLine('\treturn x;'));
    });
});

// ---------------------------------------------------------------------------
// captureAnchor
// ---------------------------------------------------------------------------
suite('captureAnchor', () => {
    test('lineHash matches hashLine of the target line content', () => {
        const doc = makeDoc(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
        const anchor = captureAnchor(doc, 2, 2);
        assert.strictEqual(anchor.lineHash, hashLine('gamma'));
    });

    test('contextBefore and contextAfter contain normalized neighbour lines', () => {
        const doc = makeDoc(['A', 'B', 'C', 'D', 'E']);
        const anchor = captureAnchor(doc, 2, 1);
        assert.deepStrictEqual(anchor.contextBefore, ['B']);
        assert.deepStrictEqual(anchor.contextAfter, ['D']);
    });

    test('clamps context at document boundaries (no out-of-range access)', () => {
        const doc = makeDoc(['only_line']);
        const anchor = captureAnchor(doc, 0, 3);
        assert.strictEqual(anchor.lineHash, hashLine('only_line'));
        assert.deepStrictEqual(anchor.contextBefore, []);
        assert.deepStrictEqual(anchor.contextAfter, []);
    });
});

// ---------------------------------------------------------------------------
// findAnchor
// ---------------------------------------------------------------------------
suite('findAnchor', () => {
    test('fast path: returns storedLine immediately when hash still matches', () => {
        const lines = ['one', 'two', 'const target = true;', 'four'];
        const doc = makeDoc(lines);
        const anchor = captureAnchor(doc, 2, 2);
        assert.strictEqual(findAnchor(doc, anchor, 2), 2);
    });

    test('finds a moved line via context scoring when storedLine is stale', () => {
        // Build a document where TARGET moved from position 2 to position 8.
        // Identical before/after context appears at the new location.
        const doc = makeDoc([
            'unrelated_a',    // 0
            'unrelated_b',    // 1
            'ctx_before_1',   // 2
            'ctx_before_2',   // 3
            'TARGET_LINE',    // 4 -- duplicated at wrong place with no good context
            'ctx_before_1',   // 5
            'ctx_before_2',   // 6
            'ctx_before_3',   // 7 (extra, gives score bonus)
            'TARGET_LINE',    // 8 -- the real location (has 3 matching context lines before)
            'ctx_after_1',    // 9
            'ctx_after_2',    // 10
        ]);

        const anchor = {
            lineHash: hashLine('TARGET_LINE'),
            contextBefore: ['ctx_before_1', 'ctx_before_2', 'ctx_before_3'],
            contextAfter: ['ctx_after_1', 'ctx_after_2'],
        };

        // Stored line (2) no longer holds TARGET_LINE, so fast path fails.
        // The scanner must find line 8 (score = 10) vs line 4 (score = 4).
        const result = findAnchor(doc, anchor, 2);
        assert.strictEqual(result, 8);
    });

    test('unique-hash fallback (opt-in): returns the sole candidate when context fails to score', () => {
        // Simulates Alt+Up: a single line swap leaves contextBefore misaligned
        // around the new position, but the line content itself is unique.
        const lines = [
            'pre0',
            'pre1',
            'AFTER_SWAP_TARGET',  // 2 -- candidate (was at line 4 originally)
            'pre2',               // 3 -- shifted down by swap, breaks anno.contextBefore
            'pre3',               // 4
            'pre4',               // 5
        ];
        const doc = makeDoc(lines);
        const anchor = {
            lineHash: hashLine('AFTER_SWAP_TARGET'),
            contextBefore: ['pre2', 'pre3', 'pre4'], // pre-swap context, no longer aligned
            contextAfter: ['post1', 'post2', 'post3'],
        };
        // Default behaviour: cannot find with sufficient score.
        assert.strictEqual(findAnchor(doc, anchor, 4), null);
        // Opt-in fallback: returns the unique candidate at line 2.
        assert.strictEqual(
            findAnchor(doc, anchor, 4, { allowUniqueHashFallback: true }),
            2
        );
    });

    test('unique-hash fallback does NOT fire for empty-line hash', () => {
        // Many blank lines in a doc -> hash matches multiple positions ->
        // fallback (which requires exactly ONE match) does not engage.
        const doc = makeDoc(['code1', '', '', 'code2', '', 'code3']);
        const anchor = {
            lineHash: EMPTY_LINE_HASH,
            contextBefore: ['x', 'y', 'z'],
            contextAfter: ['a', 'b', 'c'],
        };
        // storedLine=-1 bypasses the fast path so we exercise the scan.
        assert.strictEqual(
            findAnchor(doc, anchor, -1, { allowUniqueHashFallback: true }),
            null,
        );
    });

    test('unique-hash fallback does NOT fire when 2+ candidates share the hash', () => {
        const doc = makeDoc(['a', 'TARGET', 'b', 'TARGET', 'c']);
        const anchor = {
            lineHash: hashLine('TARGET'),
            contextBefore: ['no', 'match', 'here'],
            contextAfter: ['no', 'match', 'either'],
        };
        // 2 candidates -> fallback not eligible. storedLine=-1 to skip fast path.
        assert.strictEqual(
            findAnchor(doc, anchor, -1, { allowUniqueHashFallback: true }),
            null,
        );
    });

    test('returns null when no candidate achieves a context score of at least 4', () => {
        // TARGET appears twice but neither has any matching context.
        const doc = makeDoc([
            'TARGET_LINE',   // 0 -- context is unrelated
            'junk_a',
            'TARGET_LINE',   // 2 -- context is also unrelated
            'junk_b',
        ]);

        const anchor = {
            lineHash: hashLine('TARGET_LINE'),
            contextBefore: ['very_specific_before_A', 'very_specific_before_B'],
            contextAfter: ['very_specific_after_A', 'very_specific_after_B'],
        };

        assert.strictEqual(findAnchor(doc, anchor, 999), null);
    });
});

// ---------------------------------------------------------------------------
// Empty-line / EMPTY_LINE_HASH regression -- the data-corruption bug
// ---------------------------------------------------------------------------
suite('EMPTY_LINE_HASH (data-integrity regression)', () => {
    // The original bug: every persisted annotation shared lineHash "811c9dc5".
    // That value is the FNV-1a offset basis -- the value the loop returns when
    // the input is empty/whitespace. This suite locks in the fix.

    test('hashLine("") === EMPTY_LINE_HASH', () => {
        assert.strictEqual(hashLine(''), EMPTY_LINE_HASH);
    });

    test('hashLine of whitespace-only line equals EMPTY_LINE_HASH', () => {
        assert.strictEqual(hashLine('   \t  '), EMPTY_LINE_HASH);
    });

    test('isEmptyLineHash recognises the sentinel', () => {
        assert.strictEqual(isEmptyLineHash(EMPTY_LINE_HASH), true);
        assert.strictEqual(isEmptyLineHash(hashLine('not empty')), false);
        assert.strictEqual(isEmptyLineHash(undefined), false);
    });

    test('captureAnchor on a blank line walks FORWARD to the next non-empty target', () => {
        // Cursor on line 1 (blank); next non-empty line is line 2 ("function foo()").
        const doc = makeDoc([
            'pre_line',
            '',
            'function foo() {',
            '  return 1;',
            '}',
        ]);
        const anchor = captureAnchor(doc, 1);
        assert.strictEqual(anchor.lineHash, hashLine('function foo() {'));
        assert.strictEqual(anchor.targetLine, 2);
        assert.strictEqual(anchor.originalLine, 1);
        assert.notStrictEqual(anchor.lineHash, EMPTY_LINE_HASH, 'must not anchor to a blank line');
    });

    test('captureAnchor on a blank line walks BACKWARD when no forward target exists', () => {
        const doc = makeDoc([
            'function foo() {}',
            '',
            '',
            '',
        ]);
        const anchor = captureAnchor(doc, 2);
        assert.strictEqual(anchor.lineHash, hashLine('function foo() {}'));
        assert.strictEqual(anchor.targetLine, 0);
    });

    test('captureAnchor with walkForward=0 / walkBackward=0 stays on the cursor line', () => {
        const doc = makeDoc(['code()', '', 'more()']);
        const anchor = captureAnchor(doc, 1, { walkForward: 0, walkBackward: 0 });
        assert.strictEqual(anchor.targetLine, 1);
        assert.strictEqual(anchor.lineHash, EMPTY_LINE_HASH);
    });

    test('captureAnchor with legacy contextSize argument still works', () => {
        const doc = makeDoc(['a', 'b', 'TARGET', 'd', 'e']);
        const anchor = captureAnchor(doc, 2, 1);
        assert.deepStrictEqual(anchor.contextBefore, ['b']);
        assert.deepStrictEqual(anchor.contextAfter, ['d']);
    });

    test('findAnchor REJECTS degenerate empty-hash anchor with no meaningful context', () => {
        // The exact failure mode from the bug report: every annotation had
        // lineHash 811c9dc5 plus surrounding blank lines. findAnchor must NOT
        // return a position by accident -- it should refuse to resolve.
        const doc = makeDoc([
            '',
            '',
            'function fetchUser() {',
            '  return null;',
            '}',
            '',
            '',
        ]);
        const result = findAnchor(
            doc,
            { lineHash: EMPTY_LINE_HASH, contextBefore: ['', ''], contextAfter: ['', ''] },
            -1
        );
        assert.strictEqual(result, null);
    });

    test('findAnchor still resolves an empty-hash anchor when CONTEXT is meaningful', () => {
        // If the user genuinely anchored on a blank line between two known symbols,
        // we can still re-locate via context. The anchor is fragile but not useless.
        const doc = makeDoc([
            'before_line',   // 0
            '',              // 1 -- the blank target
            'after_line',    // 2
        ]);
        const result = findAnchor(
            doc,
            {
                lineHash: EMPTY_LINE_HASH,
                contextBefore: ['before_line'],
                contextAfter: ['after_line'],
            },
            -1
        );
        // With strict threshold (4) and only 2 meaningful context entries (=4 score),
        // resolution succeeds at the blank line.
        assert.strictEqual(result, 1);
    });

    test('empty-line fast path requires matching context, not only a blank stored line', () => {
        const doc = makeDoc([
            'wrong_before',
            '',              // stale stored line: hash matches, context does not
            'wrong_after',
            'before_line',
            '',              // correct location
            'after_line',
        ]);
        const result = findAnchor(
            doc,
            {
                lineHash: EMPTY_LINE_HASH,
                contextBefore: ['before_line'],
                contextAfter: ['after_line'],
            },
            1
        );
        assert.strictEqual(result, 4);
    });
});

// ---------------------------------------------------------------------------
// 10-scenario regression coverage (pure-logic subset)
// ---------------------------------------------------------------------------
//
// The full bug spec calls for 10 end-to-end scenarios (delete/undo/move/cross-file
// isolation/etc). Most require the VS Code host to drive vscode.commands and live
// editors, but the core data-integrity claims can be verified with TextDocumentLike.
//
suite('regression: 10-scenario coverage (pure-logic subset)', () => {
    const sampleTs = [
        'interface User {',                                          // 0
        '  id: number;',                                             // 1
        '  name: string;',                                           // 2
        '  email: string;',                                          // 3
        '}',                                                         // 4
        '',                                                          // 5
        'function fetchUser(id: number): Promise<User> {',           // 6
        '  return fetch(`/api/users/${id}`)',                        // 7
        '    .then((response) => response.json());',                 // 8
        '}',                                                         // 9
        '',                                                          // 10
        'async function displayUser(userId: number): Promise<void> {', // 11
        '  try {',                                                   // 12
        '    const user = await fetchUser(userId);',                 // 13
        '    console.log(user.name);',                               // 14
        '  } catch (error) {',                                       // 15
        '    console.error(error);',                                 // 16
        '  }',                                                       // 17
        '}',                                                         // 18
        '',                                                          // 19
        "export { User, fetchUser, displayUser };",                  // 20
    ];

    test('Test 2: anchor on blank line resolves to next non-empty symbol header', () => {
        const doc = makeDoc(sampleTs);
        // Blank line 10 sits between fetchUser (9) and displayUser (11).
        const anchor = captureAnchor(doc, 10);
        // Walk forward: line 11 is "async function displayUser..."
        assert.strictEqual(anchor.targetLine, 11);
        assert.strictEqual(anchor.lineHash, hashLine(sampleTs[11]));
    });

    test('Test 1: two anchors on different functions stay distinct', () => {
        const doc = makeDoc(sampleTs);
        const aFetch = captureAnchor(doc, 6);    // on fetchUser header
        const aDisplay = captureAnchor(doc, 11); // on displayUser header
        assert.notStrictEqual(aFetch.lineHash, aDisplay.lineHash);
        assert.strictEqual(aFetch.targetLine, 6);
        assert.strictEqual(aDisplay.targetLine, 11);
    });

    test('Test 6: anchor follows fetchUser when the function moves to a lower line', () => {
        const before = makeDoc(sampleTs);
        const fetchAnchor = captureAnchor(before, 6);

        // Simulate moving fetchUser block (lines 6..9) below displayUser.
        const after = makeDoc([
            ...sampleTs.slice(0, 6),
            ...sampleTs.slice(10, 19),                 // displayUser block
            '',
            ...sampleTs.slice(6, 10),                  // fetchUser block now lower
            '',
            sampleTs[20],
        ]);
        const found = findAnchor(after, fetchAnchor, 6);
        if (found === null) { throw new Error('expected non-null found'); }
        assert.strictEqual(
            after.lineAt(found).text,
            'function fetchUser(id: number): Promise<User> {',
            'anchor must land on the moved fetchUser header'
        );
    });

    test('Test 3: deleting displayUser leaves its anchor un-resolvable (orphan signal)', () => {
        const before = makeDoc(sampleTs);
        const displayAnchor = captureAnchor(before, 11);

        // Simulate deletion of the displayUser block (lines 11..18).
        const after = makeDoc([
            ...sampleTs.slice(0, 11),
            ...sampleTs.slice(19),
        ]);
        const found = findAnchor(after, displayAnchor, 11);
        assert.strictEqual(found, null, 'displayUser is gone -- must NOT migrate to fetchUser');
    });

    test('Test 5: deleting fetchUser leaves displayUser anchor intact', () => {
        const before = makeDoc(sampleTs);
        const displayAnchor = captureAnchor(before, 11);

        // Delete fetchUser block (lines 6..9).
        const after = makeDoc([
            ...sampleTs.slice(0, 6),
            ...sampleTs.slice(10),
        ]);
        const found = findAnchor(after, displayAnchor, 11);
        if (found === null) { throw new Error('displayUser anchor must still resolve after fetchUser deletion'); }
        assert.strictEqual(
            after.lineAt(found).text,
            'async function displayUser(userId: number): Promise<void> {',
        );
    });

    test('Test 4 (subset): undo restores fetchUser -- anchor reattaches', () => {
        const before = makeDoc(sampleTs);
        const fetchAnchor = captureAnchor(before, 6);

        // Delete fetchUser, then "undo" by reapplying the original.
        // The anchor was captured pre-delete, so against the restored doc it
        // simply returns the original line.
        const after = makeDoc(sampleTs);
        const found = findAnchor(after, fetchAnchor, 6);
        assert.strictEqual(found, 6);
    });

    test('Test 8: findAnchor is idempotent -- repeated calls return the same line', () => {
        const doc = makeDoc(sampleTs);
        const anchor = captureAnchor(doc, 6);
        const a = findAnchor(doc, anchor, 6);
        const b = findAnchor(doc, anchor, 6);
        const c = findAnchor(doc, anchor, 6);
        assert.strictEqual(a, 6);
        assert.strictEqual(b, 6);
        assert.strictEqual(c, 6);
    });

    test('Test 10: legacy empty-line anchor across the whole file resolves to null (must be marked stale by migration)', () => {
        // This is the exact corrupted shape from the bug-report JSON: every
        // annotation persisted with EMPTY_LINE_HASH and surrounding blank context.
        const doc = makeDoc(sampleTs);
        const corruptedAnchor = {
            lineHash: EMPTY_LINE_HASH,
            contextBefore: ['', '', ''],
            contextAfter: ['', '', ''],
        };
        assert.strictEqual(findAnchor(doc, corruptedAnchor, 5), null,
            'corrupted legacy anchor must NOT resolve to any line');
    });
});

// ---------------------------------------------------------------------------
// detectMoves
// ---------------------------------------------------------------------------
suite('detectMoves', () => {
    test('identifies a 5-line block moved from position 5..9 to position 15..19', () => {
        const block = ['mv_0', 'mv_1', 'mv_2', 'mv_3', 'mv_4'];
        const pre  = Array.from({ length: 5 },  (_, i) => `pre_${i}`);
        const mid  = Array.from({ length: 10 }, (_, i) => `mid_${i}`);

        // oldLines: pre[0..4], block[5..9], mid[10..19]
        const oldLines = [...pre, ...block, ...mid];
        // newLines: pre[0..4], mid[5..14], block[15..19]
        const newLines = [...pre, ...mid, ...block];

        const moves = detectMoves(oldLines, newLines);

        assert.strictEqual(moves.length, 1, 'exactly one moved block expected');
        assert.strictEqual(moves[0].oldStart, 5);
        assert.strictEqual(moves[0].oldEnd,   9);
        assert.strictEqual(moves[0].newStart, 15);
        assert.strictEqual(moves[0].newEnd,   19);
    });

    test('returns empty array when no blocks moved (only insertions)', () => {
        const oldLines = ['a', 'b', 'c'];
        const newLines = ['a', 'b', 'INSERTED', 'c'];
        assert.deepStrictEqual(detectMoves(oldLines, newLines), []);
    });

    test('detects a re-indented block as a move (normalization)', () => {
        // Block at old[0..2] uses 2-space indent; block at new[3..5] uses tab indent.
        // After normalization both produce the same key, so the move is detected.
        const block_old = ['  function foo() {', '    return 42;', '  }'];
        const block_new = ['\tfunction foo() {', '\t\treturn 42;', '\t}'];
        const filler = ['const a = 1;', 'const b = 2;', 'const c = 3;'];

        const oldLines = [...block_old, ...filler]; // block at 0..2, filler at 3..5
        const newLines = [...filler, ...block_new]; // filler at 0..2, block at 3..5

        const moves = detectMoves(oldLines, newLines);
        assert.strictEqual(moves.length, 1, 'one re-indented move expected');
        assert.strictEqual(moves[0].oldStart, 0);
        assert.strictEqual(moves[0].oldEnd, 2);
        assert.strictEqual(moves[0].newStart, 3);
        assert.strictEqual(moves[0].newEnd, 5);
    });
});
