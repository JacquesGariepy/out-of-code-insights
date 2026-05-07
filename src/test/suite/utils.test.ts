import * as assert from 'assert';
import * as path from 'path';
import { escapeHtml } from '../../common/utils';

suite('escapeHtml', () => {
    test('empty string returns empty string', () => {
        assert.strictEqual(escapeHtml(''), '');
    });

    test('plain text with no special chars is unchanged', () => {
        assert.strictEqual(escapeHtml('Hello world'), 'Hello world');
    });

    test('ampersand is escaped', () => {
        assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    });

    test('less-than is escaped', () => {
        assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    });

    test('greater-than is escaped', () => {
        assert.strictEqual(escapeHtml('1 > 0'), '1 &gt; 0');
    });

    test('double quotes are escaped', () => {
        assert.strictEqual(escapeHtml('"quoted"'), '&quot;quoted&quot;');
    });

    test('single quotes are escaped', () => {
        assert.strictEqual(escapeHtml("it's"), 'it&#039;s');
    });

    test('combined XSS payload is fully escaped', () => {
        const input = '<img src="x" onerror=\'alert(1)\'>';
        const output = escapeHtml(input);
        assert.ok(!output.includes('<'), 'should not contain <');
        assert.ok(!output.includes('>'), 'should not contain >');
        assert.ok(!output.includes('"'), 'should not contain "');
        assert.ok(!output.includes("'"), "should not contain '");
    });

    test('multiple ampersands in sequence', () => {
        assert.strictEqual(escapeHtml('&&'), '&amp;&amp;');
    });
});

suite('Path traversal rejection', () => {
    // Mirrors the logic used in AnnotationManager.getProjectAnnotationsPath
    function isPathSafe(workspaceRoot: string, customPath: string): boolean {
        const resolved = path.resolve(workspaceRoot, customPath);
        return resolved.startsWith(path.resolve(workspaceRoot) + path.sep) || resolved === path.resolve(workspaceRoot);
    }

    test('path within workspace is accepted', () => {
        const ws = '/workspace';
        assert.strictEqual(isPathSafe(ws, 'subdir'), true);
    });

    test('path with .. that escapes workspace is rejected', () => {
        const ws = '/workspace';
        assert.strictEqual(isPathSafe(ws, '../../etc/passwd'), false);
    });

    test('absolute path outside workspace is rejected', () => {
        const ws = 'C:\\workspace';
        const outsidePath = 'C:\\Windows\\System32';
        const resolved = path.resolve(outsidePath);
        const wsResolved = path.resolve(ws);
        const safe = resolved.startsWith(wsResolved + path.sep) || resolved === wsResolved;
        assert.strictEqual(safe, false);
    });
});

// TODO: AIProfileManager tests (requires VSCode extension context - add once test harness is extended)
// TODO: localize() tests (requires NLS bundle loading in test host)
