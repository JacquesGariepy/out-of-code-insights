/**
 * Pure unit tests for src/common/utils.ts.
 * These tests run with plain mocha (no VS Code host required).
 */
import * as assert from 'assert';
import { escapeHtml } from '../../../common/utils';

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
