/**
 * Pure unit tests for src/common/utils.ts.
 * These tests run with plain mocha (no VS Code host required).
 */
import * as assert from 'assert';
import { escapeHtml, markdownCodeSpan } from '../../../common/utils';

suite('escapeHtml (unit)', () => {
    const cases: [string, string][] = [
        ['', ''],
        ['plain', 'plain'],
        ['<b>', '&lt;b&gt;'],
        ['"quote"', '&quot;quote&quot;'],
        ["'apostrophe'", '&#039;apostrophe&#039;'],
        ['a & b', 'a &amp; b'],
        ['<script>alert("xss")</script>', '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'],
    ];

    for (const [input, expected] of cases) {
        test(`escapeHtml(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
            assert.strictEqual(escapeHtml(input), expected);
        });
    }

    test('is idempotent when applied to already-escaped output', () => {
        const once = escapeHtml('<');
        const twice = escapeHtml(once);
        assert.strictEqual(once, '&lt;');
        assert.notStrictEqual(twice, once, 'double-escaping should produce different output');
    });
});

suite('markdownCodeSpan', () => {
    test('uses a plain padded span for ordinary and Windows-style paths', () => {
        assert.strictEqual(markdownCodeSpan('src/file.ts'), '` src/file.ts `');
        assert.strictEqual(markdownCodeSpan('src\\nested\\file.ts'), '` src\\nested\\file.ts `');
    });

    test('chooses a delimiter longer than every untrusted backtick run', () => {
        assert.strictEqual(markdownCodeSpan('src/`quoted`.ts'), '`` src/`quoted`.ts ``');
        assert.strictEqual(markdownCodeSpan('before `` after'), '``` before `` after ```');
    });

    test('flattens line breaks so issue metadata cannot inject Markdown blocks', () => {
        assert.strictEqual(markdownCodeSpan('src/file.ts\r\n- injected'), '` src/file.ts - injected `');
    });
});
