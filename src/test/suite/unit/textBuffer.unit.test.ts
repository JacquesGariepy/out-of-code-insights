/**
 * Pure-logic tests for TextBuffer — the offset-aware TextDocumentLike used
 * by tooling running outside the extension host (MCP server).
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import { captureAnchor, hashLine } from '../../../anchoring/anchor';
import { TextBuffer } from '../../../anchoring/textBuffer';

suite('TextBuffer — line splitting', () => {
    test('empty text is a single empty line', () => {
        const buffer = new TextBuffer('');
        assert.strictEqual(buffer.lineCount, 1);
        assert.strictEqual(buffer.lineAt(0).text, '');
        assert.strictEqual(buffer.offsetAt(0), 0);
    });

    test('splits LF-separated text', () => {
        const buffer = new TextBuffer('alpha\nbeta\ngamma');
        assert.strictEqual(buffer.lineCount, 3);
        assert.strictEqual(buffer.lineAt(0).text, 'alpha');
        assert.strictEqual(buffer.lineAt(1).text, 'beta');
        assert.strictEqual(buffer.lineAt(2).text, 'gamma');
    });

    test('splits CRLF-separated text', () => {
        const buffer = new TextBuffer('alpha\r\nbeta\r\ngamma');
        assert.strictEqual(buffer.lineCount, 3);
        assert.strictEqual(buffer.lineAt(1).text, 'beta');
    });

    test('splits lone-CR text', () => {
        const buffer = new TextBuffer('alpha\rbeta');
        assert.strictEqual(buffer.lineCount, 2);
        assert.strictEqual(buffer.lineAt(1).text, 'beta');
    });

    test('mixed separators', () => {
        const buffer = new TextBuffer('a\r\nb\nc\rd');
        assert.strictEqual(buffer.lineCount, 4);
        assert.deepStrictEqual(
            [0, 1, 2, 3].map((i) => buffer.lineAt(i).text),
            ['a', 'b', 'c', 'd']
        );
    });

    test('trailing newline yields a final empty line', () => {
        const buffer = new TextBuffer('alpha\n');
        assert.strictEqual(buffer.lineCount, 2);
        assert.strictEqual(buffer.lineAt(1).text, '');
    });
});

suite('TextBuffer — offsets', () => {
    test('offsetAt returns line start offsets (CRLF)', () => {
        const buffer = new TextBuffer('ab\r\ncd\r\nef');
        assert.strictEqual(buffer.offsetAt(0), 0);
        assert.strictEqual(buffer.offsetAt(1), 4);
        assert.strictEqual(buffer.offsetAt(2), 8);
    });

    test('lineEndOffset excludes the EOL sequence', () => {
        const buffer = new TextBuffer('ab\r\ncd');
        assert.strictEqual(buffer.lineEndOffset(0), 2);
        assert.strictEqual(buffer.lineEndOffset(1), 6);
    });

    test('lineAtOffset maps offsets back to lines', () => {
        const buffer = new TextBuffer('ab\ncd\nef');
        assert.strictEqual(buffer.lineAtOffset(0), 0);
        assert.strictEqual(buffer.lineAtOffset(2), 0); // the '\n' terminating line 0
        assert.strictEqual(buffer.lineAtOffset(3), 1);
        assert.strictEqual(buffer.lineAtOffset(7), 2);
    });

    test('offset inside a CRLF pair belongs to the line it terminates', () => {
        const buffer = new TextBuffer('ab\r\ncd');
        assert.strictEqual(buffer.lineAtOffset(3), 0); // the '\n' of the pair
        assert.strictEqual(buffer.lineAtOffset(4), 1);
    });

    test('clamps out-of-range inputs', () => {
        const buffer = new TextBuffer('ab\ncd');
        assert.strictEqual(buffer.lineAtOffset(-5), 0);
        assert.strictEqual(buffer.lineAtOffset(999), 1);
        assert.strictEqual(buffer.offsetAt(-1), 0);
        assert.strictEqual(buffer.offsetAt(999), 3);
        assert.strictEqual(buffer.lineAt(999).text, 'cd');
    });

    test('round-trips lineAtOffset(offsetAt(line)) for every line', () => {
        const buffer = new TextBuffer('one\r\ntwo\nthree\rfour\n');
        for (let line = 0; line < buffer.lineCount; line++) {
            assert.strictEqual(buffer.lineAtOffset(buffer.offsetAt(line)), line);
        }
    });
});

suite('TextBuffer — anchoring integration', () => {
    test('satisfies TextDocumentLike for captureAnchor', () => {
        const buffer = new TextBuffer('// header\nfunction f() {}\n// footer');
        const anchor = captureAnchor(buffer, 1);
        assert.strictEqual(anchor.lineHash, hashLine('function f() {}'));
        assert.deepStrictEqual(anchor.contextBefore, ['// header']);
        assert.deepStrictEqual(anchor.contextAfter, ['// footer']);
    });
});
