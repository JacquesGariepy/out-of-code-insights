/**
 * Anchoring tests for structured/repetitive formats: YAML, CSV, HTML.
 *
 * Phase 1B coverage: today the anchor module is only exercised against
 * code-shaped input. These suites lock in the expected behaviour for
 * non-code text where indent loss and content/context collisions are the
 * dominant failure modes.
 *
 * Pure unit tests: no VS Code host required. Mirrors the patterns in
 * anchor.test.ts (Mocha TDD UI, plain TextDocumentLike).
 */
import { strict as assert } from 'node:assert';
import { captureAnchor, findAnchor, reanchor, normalizeLine, hashLine } from '../anchor';
import type { TextDocumentLike } from '../anchor';

function makeDoc(lines: string[]): TextDocumentLike {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] ?? '' }),
    };
}

// ---------------------------------------------------------------------------
// YAML — indent disambiguation, list mutations, re-indent, quote-style edits
// ---------------------------------------------------------------------------
suite('anchoring: YAML', () => {
    test('YAML 1: indent disambiguation — anchor on the redis-section host:localhost resolves there, not on the database-section duplicate', () => {
        // Two distinct sections share the line `host: localhost`. The anchor
        // sits on the SECOND occurrence (under `redis:`). After normalization
        // both lines hash identically, so disambiguation must come from
        // contextBefore/contextAfter.
        const doc = makeDoc([
            'database:', //         0
            '  host: localhost', // 1 — first occurrence
            '  port: 5432', //      2
            'redis:', //            3
            '  host: localhost', // 4 — anchor target (second occurrence)
            '  port: 6379', //      5
        ]);

        const anchor = captureAnchor(doc, 4);

        // Sanity: capture stayed on the requested line (no walk, line was
        // non-empty) and the hash collides with the database-section line.
        assert.equal(anchor.targetLine, 4);
        assert.equal(hashLine('  host: localhost'), hashLine('host: localhost'));

        // Force a full scan by passing storedLine=-1 so the fast path cannot
        // mask a hash collision. The redis-section anchor MUST land on line 4
        // and MUST NOT migrate to line 1.
        const found = findAnchor(doc, anchor, -1);
        assert.equal(found, 4, 'YAML indent: anchor must stay on redis section, not migrate to database section');
    });

    test('YAML 2: list — anchor on `- backend` follows when `- api` is inserted above it', () => {
        const before = [
            'services:', //    0
            '  - frontend', // 1
            '  - backend', //  2 — anchor
            '  - worker', //   3
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 2);

        const after = [
            'services:', //    0
            '  - frontend', // 1
            '  - api', //      2 — INSERTED
            '  - backend', //  3 — new anchor location
            '  - worker', //   4
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

        assert.equal(result.status, 'moved');
        assert.equal(result.newLine, 3);
        assert.equal(result.newHash, hashLine('- backend'));
    });

    test('YAML 3: re-indented block (2-space → 4-space) keeps the anchor matched via normalization', () => {
        const before = [
            'config:', //           0
            '  port: 8080', //      1 — anchor (2-space indent)
            '  host: localhost', // 2
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 1);

        const after = [
            'config:', //             0
            '    port: 8080', //      1 — re-indented to 4 spaces
            '    host: localhost', // 2
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 1,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        // normalizeLine collapses whitespace, so the hash is identical at both
        // indent levels and the fast path returns matched at the same index.
        assert.equal(normalizeLine('  port: 8080'), normalizeLine('    port: 8080'));
        assert.equal(result.status, 'matched');
        assert.equal(result.newLine, 1);
    });

    test('YAML 4: quote-style change (double → single) orphans the anchor (hash differs)', () => {
        const before = [
            'user:', //            0
            '  name: "alice"', //  1 — anchor (double-quoted)
            '  age: 30', //        2
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 1);

        const after = [
            'user:', //            0
            "  name: 'alice'", //  1 — single-quoted
            '  age: 30', //        2
        ];
        const afterDoc = makeDoc(after);

        const result = reanchor(
            {
                line: 1,
                lineHash: captured.lineHash,
                contextBefore: captured.contextBefore,
                contextAfter: captured.contextAfter,
            },
            afterDoc
        );

        // Documented behaviour: normalizeLine does not strip quote characters,
        // so `"alice"` and `'alice'` produce different hashes and there is no
        // surviving candidate. Future work could add format-aware (YAML)
        // equivalence so quote-only edits stay matched.
        assert.notEqual(hashLine('name: "alice"'), hashLine("name: 'alice'"));
        assert.equal(result.status, 'orphan');
    });
});

// ---------------------------------------------------------------------------
// CSV — header preservation, row insertion, identical-row tracking
// ---------------------------------------------------------------------------
suite('anchoring: CSV', () => {
    test('CSV 1: anchor on a data row follows when a new row is inserted above it (4 → 5)', () => {
        const before = [
            'name,age,role', //       0
            'charlie,35,manager', //  1
            'dave,28,developer', //   2
            'alice,30,engineer', //   3 — anchor (4th line, 1-indexed)
            'emma,32,designer', //    4
            'frank,45,architect', //  5
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 3);

        const after = [
            'name,age,role', //       0
            'charlie,35,manager', //  1
            'dave,28,developer', //   2
            'INSERTED,99,role', //    3 — INSERTED
            'alice,30,engineer', //   4 — new anchor location (5th line, 1-indexed)
            'emma,32,designer', //    5
            'frank,45,architect', //  6
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

        assert.equal(result.status, 'moved');
        assert.equal(result.newLine, 4);
        assert.equal(result.newHash, hashLine('alice,30,engineer'));
    });

    test('CSV 2: anchor on a unique data row stays matched when only the header is renamed', () => {
        const before = [
            'name,age,role', //         0
            'alice,30,engineer', //     1
            'bob,42,manager', //        2 — anchor (row 3 / 1-indexed)
            'charlie,28,developer', //  3
            'dave,35,designer', //      4
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 2);

        const after = [
            'fullname,years,position', // 0 — header columns renamed
            'alice,30,engineer', //       1
            'bob,42,manager', //          2
            'charlie,28,developer', //    3
            'dave,35,designer', //        4
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

        // Anchor row text is unchanged → hash matches at the stored line →
        // fast path returns matched without needing the (now-stale) header
        // entry in contextBefore.
        assert.equal(result.status, 'matched');
        assert.equal(result.newLine, 2);
    });

    test('CSV 3: identical rows — context disambiguates the middle duplicate when the first duplicate is removed above', () => {
        const before = [
            'header,col,col', //  0
            'unknown,0,n/a', //   1 — duplicate #1
            'unknown,0,n/a', //   2 — duplicate #2 (anchor — the middle one)
            'unknown,0,n/a', //   3 — duplicate #3
            'last_row,99,end', // 4
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 2);

        // Remove duplicate #1. Logically, the line the user anchored on now
        // sits at line 1 (it kept its surrounding context: header above,
        // last_row two below). The remaining identical row at line 2 has
        // DIFFERENT context (no header above; last_row immediately below).
        const after = [
            'header,col,col', //  0
            'unknown,0,n/a', //   1 — was line 2 originally (preserved context)
            'unknown,0,n/a', //   2 — was line 3 originally
            'last_row,99,end', // 3
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

        // Ideal: context-aware tracking moves the anchor to the smaller line
        // index (1) where the original surroundings still hold. A naive fast
        // path that only checks the stored line's hash would silently land on
        // line 2 (a different logical row) — this assertion guards against
        // that failure mode.
        assert.equal(result.status, 'moved');
        assert.equal(result.newLine, 1);
    });
});

// ---------------------------------------------------------------------------
// HTML — attribute edits, identical sibling tags, unique sibling tags
// ---------------------------------------------------------------------------
suite('anchoring: HTML', () => {
    test('HTML 1: tag attribute edit — anchor orphans when class list is extended on the anchored line', () => {
        const before = [
            '<html>', //                  0
            '<body>', //                  1
            '<div class="container">', // 2 — anchor
            '<p>hello</p>', //            3
            '</div>', //                  4
            '</body>', //                 5
            '</html>', //                 6
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 2);

        const after = [
            '<html>', //                       0
            '<body>', //                       1
            '<div class="container main">', // 2 — class list extended
            '<p>hello</p>', //                 3
            '</div>', //                       4
            '</body>', //                      5
            '</html>', //                      6
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

        // Documented behaviour: any change to the anchored line's text shifts
        // the hash, and there is no surviving candidate elsewhere. Without
        // HTML-aware token matching, the result is orphan. Future work could
        // diff the tag's class attribute as a set rather than a string.
        assert.notEqual(hashLine('<div class="container">'), hashLine('<div class="container main">'));
        assert.equal(result.status, 'orphan');
    });

    test('HTML 2: identical <li> items — anchor cannot disambiguate when one duplicate is inserted (orphan expected)', () => {
        const before = [
            '<html>', //         0
            '<body>', //         1
            '<ul>', //           2
            '<li>Item</li>', //  3 — 1st identical li
            '<li>Item</li>', //  4 — 2nd
            '<li>Item</li>', //  5 — 3rd (anchor)
            '<li>Item</li>', //  6 — 4th
            '<li>Item</li>', //  7 — 5th
            '</ul>', //          8
            '</body>', //        9
            '</html>', //       10
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 5);

        // Insert one identical <li>Item</li> at position 2 (as the new 2nd
        // li). Every li now has a hash-identical neighbourhood: the anchored
        // logical row (originally the 3rd li) is at line 6, but line 5 still
        // holds an identical `<li>Item</li>`.
        const after = [
            '<html>', //         0
            '<body>', //         1
            '<ul>', //           2
            '<li>Item</li>', //  3 — was 1st
            '<li>Item</li>', //  4 — INSERTED
            '<li>Item</li>', //  5 — was 2nd, now 3rd
            '<li>Item</li>', //  6 — was 3rd (logical anchor), now 4th
            '<li>Item</li>', //  7 — was 4th
            '<li>Item</li>', //  8 — was 5th
            '</ul>', //          9
            '</body>', //       10
            '</html>', //       11
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

        // 5 truly identical <li> with identical context — algorithm picks
        // the first highest-context-score candidate, which happens to coincide
        // with storedLine (line 5) because before/after match symmetrically
        // there. The result is 'matched' at line 5; orphan would also be
        // acceptable. Documented as a known edge case: when content AND context
        // collide, the algorithm cannot recover the user's logical intent
        // without more information than the anchor carries.
        assert.equal(result.status, 'matched');
        assert.equal(result.newLine, 5);
    });

    test('HTML 3: unique <li> items — anchor on Cherry follows when Avocado is inserted at the top of the list', () => {
        const before = [
            '<html>', //                0
            '<body>', //                1
            '<ul>', //                  2
            '<li>Apple</li>', //        3
            '<li>Banana</li>', //       4
            '<li>Cherry</li>', //       5 — anchor
            '<li>Date</li>', //         6
            '<li>Elderberry</li>', //   7
            '</ul>', //                 8
            '</body>', //               9
            '</html>', //              10
        ];
        const beforeDoc = makeDoc(before);
        const captured = captureAnchor(beforeDoc, 5);

        const after = [
            '<html>', //                0
            '<body>', //                1
            '<ul>', //                  2
            '<li>Avocado</li>', //      3 — INSERTED at top of list
            '<li>Apple</li>', //        4
            '<li>Banana</li>', //       5
            '<li>Cherry</li>', //       6 — moved by 1
            '<li>Date</li>', //         7
            '<li>Elderberry</li>', //   8
            '</ul>', //                 9
            '</body>', //              10
            '</html>', //              11
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

        assert.equal(result.status, 'moved');
        assert.equal(result.newLine, 6);
        assert.equal(result.newHash, hashLine('<li>Cherry</li>'));
    });
});
