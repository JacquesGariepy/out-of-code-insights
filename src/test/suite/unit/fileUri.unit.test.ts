/**
 * Pure-logic tests for toFileUriString — vscode.Uri.file().toString() parity
 * for records written outside the extension host (MCP server).
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import { toFileUriString } from '../../../common/fileUri';

suite('toFileUriString', () => {
    test('Windows path with backslashes', () => {
        assert.strictEqual(toFileUriString('C:\\sources\\proj\\src\\a.ts'), 'file:///c%3A/sources/proj/src/a.ts');
    });

    test('Windows path with forward slashes', () => {
        assert.strictEqual(toFileUriString('E:/work/x.ts'), 'file:///e%3A/work/x.ts');
    });

    test('drive letter already lowercase is preserved', () => {
        assert.strictEqual(toFileUriString('c:\\x\\y.ts'), 'file:///c%3A/x/y.ts');
    });

    test('POSIX path', () => {
        assert.strictEqual(toFileUriString('/home/me/proj/a.ts'), 'file:///home/me/proj/a.ts');
    });

    test('spaces are percent-encoded', () => {
        assert.strictEqual(toFileUriString('C:\\My Folder\\a b.ts'), 'file:///c%3A/My%20Folder/a%20b.ts');
    });

    test('non-ASCII characters are percent-encoded as UTF-8', () => {
        assert.strictEqual(toFileUriString('/tmp/é.ts'), 'file:///tmp/%C3%A9.ts');
    });

    test('UNC path maps the host to the authority', () => {
        assert.strictEqual(toFileUriString('\\\\Server\\share\\dir\\a.ts'), 'file://server/share/dir/a.ts');
    });
});
