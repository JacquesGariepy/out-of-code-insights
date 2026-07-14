import * as assert from 'assert';
import { minimalTextReplacement } from '../../../comments/sourceConversionTextEdit';

function applyReplacement(current: string, replacement: ReturnType<typeof minimalTextReplacement>): string {
    if (!replacement) {
        return current;
    }
    return `${current.slice(0, replacement.startOffset)}${replacement.text}${current.slice(replacement.endOffset)}`;
}

suite('Source conversion minimal text restoration', () => {
    test('returns no edit for identical text', () => {
        assert.strictEqual(minimalTextReplacement('same', 'same'), undefined);
    });

    test('restores only the changed comment span', () => {
        const current = ['const a = 1;', '', 'run();'].join('\r\n');
        const target = ['const a = 1;', '// explanation', 'run();'].join('\r\n');
        const replacement = minimalTextReplacement(current, target);
        assert.ok(replacement);
        assert.strictEqual(applyReplacement(current, replacement), target);
        assert.ok(replacement.startOffset > 0, 'unchanged prefix must not be replaced');
        assert.ok(replacement.endOffset < current.length, 'unchanged suffix must not be replaced');
    });

    test('never splits CRLF when the difference touches a line boundary', () => {
        const current = 'alpha\r\nbeta';
        const target = 'alpha\r\n// note\r\nbeta';
        const replacement = minimalTextReplacement(current, target);
        assert.ok(replacement);
        assert.strictEqual(applyReplacement(current, replacement), target);
        assert.notStrictEqual(current.slice(replacement.startOffset - 1, replacement.startOffset + 1), '\r\n');
    });

    test('preserves a BOM and does not split surrogate pairs', () => {
        const current = '\uFEFFconst icon = "😀";\nrun();';
        const target = '\uFEFFconst icon = "😀"; // smile\nrun();';
        const replacement = minimalTextReplacement(current, target);
        assert.ok(replacement);
        assert.strictEqual(applyReplacement(current, replacement), target);
        assert.ok(replacement.startOffset > 1, 'BOM and common prefix must stay outside the edit');
        const before = current.charCodeAt(Math.max(0, replacement.startOffset - 1));
        const at = current.charCodeAt(replacement.startOffset);
        assert.ok(!(before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff));
    });

    test('expands a boundary when only half of a surrogate would otherwise be shared', () => {
        const current = 'A😀B';
        const target = 'A😁B';
        const replacement = minimalTextReplacement(current, target);
        assert.ok(replacement);
        assert.strictEqual(applyReplacement(current, replacement), target);
        assert.strictEqual(replacement.startOffset, 1);
        assert.strictEqual(replacement.endOffset, 3);
    });
});
