/**
 * Pure-logic tests for the better-comments-style marker scanner.
 */
import * as assert from 'assert';
import { scanLineComments } from '../../../comments/commentScanner';

suite('commentScanner — markers and languages', () => {
    test('detects better-comments markers in // comments', () => {
        const lines = [
            'const a = 1; // ! dangerous mutation',
            '// ? is this still needed',
            '// * remember this detail',
            '// plain comment without marker',
            'const b = 2;',
        ];
        const m = scanLineComments(lines, 'typescript');
        assert.deepStrictEqual(
            m.map((x) => ({ line: x.line, tag: x.tag, severity: x.severity, text: x.text })),
            [
                { line: 0, tag: 'alert', severity: 'error', text: 'dangerous mutation' },
                { line: 1, tag: 'question', severity: 'info', text: 'is this still needed' },
                { line: 2, tag: 'highlight', severity: 'info', text: 'remember this detail' },
            ]
        );
    });

    test('detects TODO/FIXME/HACK with optional colon, case-insensitive', () => {
        const lines = ['// TODO: refactor this', '// fixme broken on windows', '# HACK temporary workaround'];
        const ts = scanLineComments(lines.slice(0, 2), 'typescript');
        assert.strictEqual(ts[0].tag, 'todo');
        assert.strictEqual(ts[0].text, 'refactor this');
        assert.strictEqual(ts[1].tag, 'fixme');
        assert.strictEqual(ts[1].severity, 'warning');
        const py = scanLineComments([lines[2]], 'python');
        assert.strictEqual(py[0].tag, 'hack');
        assert.strictEqual(py[0].text, 'temporary workaround');
    });

    test('uses per-language comment prefixes (# for python, <!-- for html)', () => {
        const py = scanLineComments(['x = 1  # ! check bounds'], 'python');
        assert.strictEqual(py.length, 1);
        assert.strictEqual(py[0].text, 'check bounds');

        const html = scanLineComments(['<div><!-- TODO: aria labels --></div>'], 'html');
        assert.strictEqual(html.length, 1);
        assert.strictEqual(html[0].tag, 'todo');
        assert.strictEqual(html[0].text, 'aria labels', 'trailing --> must be stripped');
    });

    test('one match per line, empty marker text skipped', () => {
        const m = scanLineComments(['// TODO: a // FIXME: b', '// !', '// !   '], 'javascript');
        assert.strictEqual(m.length, 1, 'second marker on the same line ignored; empty texts skipped');
        assert.strictEqual(m[0].tag, 'todo');
    });

    test('unknown language falls back to // and # prefixes', () => {
        const m = scanLineComments(['// TODO: x', '# FIXME: y'], 'someweirdlang');
        assert.strictEqual(m.length, 2);
    });
});
