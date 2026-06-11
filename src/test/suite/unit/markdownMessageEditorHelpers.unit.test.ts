/**
 * Pure-logic tests for the Markdown message editor helpers.
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import {
    QUICK_PICK_LABEL_MAX_LENGTH,
    escapeHtml,
    firstMessageLine,
    formatAnnotationLocation,
} from '../../../views/markdownMessageEditorHelpers';

suite('markdownMessageEditorHelpers — firstMessageLine', () => {
    test('returns the first line of a multiline message', () => {
        assert.strictEqual(firstMessageLine('First line\nSecond line\nThird'), 'First line');
    });

    test('trims surrounding whitespace', () => {
        assert.strictEqual(firstMessageLine('   padded   \nrest'), 'padded');
    });

    test('skips leading blank lines', () => {
        assert.strictEqual(firstMessageLine('\n   \n# Heading\nbody'), '# Heading');
    });

    test('returns an empty string for blank messages', () => {
        assert.strictEqual(firstMessageLine(''), '');
        assert.strictEqual(firstMessageLine('  \n  \n'), '');
    });

    test('truncates long lines with an ellipsis at the max length', () => {
        const long = 'x'.repeat(200);
        const label = firstMessageLine(long);
        assert.strictEqual(label.length, QUICK_PICK_LABEL_MAX_LENGTH);
        assert.ok(label.endsWith('…'), 'truncated label must end with an ellipsis');
        assert.strictEqual(label, `${'x'.repeat(QUICK_PICK_LABEL_MAX_LENGTH - 1)}…`);
    });

    test('keeps lines exactly at the max length intact', () => {
        const exact = 'y'.repeat(QUICK_PICK_LABEL_MAX_LENGTH);
        assert.strictEqual(firstMessageLine(exact), exact);
    });

    test('honours a custom max length', () => {
        assert.strictEqual(firstMessageLine('abcdefgh', 5), 'abcd…');
    });
});

suite('markdownMessageEditorHelpers — formatAnnotationLocation', () => {
    test('renders file:line with a 1-based line number', () => {
        assert.strictEqual(formatAnnotationLocation('src/foo.ts', 41), 'src/foo.ts:42');
    });

    test('renders line 0 as 1', () => {
        assert.strictEqual(formatAnnotationLocation('src/foo.ts', 0), 'src/foo.ts:1');
    });

    test('omits the line fragment when the line is unresolved', () => {
        assert.strictEqual(formatAnnotationLocation('src/foo.ts', null), 'src/foo.ts');
    });
});

suite('markdownMessageEditorHelpers — escapeHtml', () => {
    test('escapes the five HTML metacharacters', () => {
        assert.strictEqual(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    });

    test('neutralises a closing textarea tag inside the message', () => {
        const escaped = escapeHtml('before</textarea><script>alert(1)</script>');
        assert.ok(!escaped.includes('</textarea>'), 'must not contain a raw closing textarea tag');
        assert.ok(!escaped.includes('<script>'), 'must not contain a raw script tag');
        assert.ok(escaped.includes('&lt;/textarea&gt;'));
    });

    test('leaves plain text untouched', () => {
        assert.strictEqual(escapeHtml('plain text 123'), 'plain text 123');
    });
});
