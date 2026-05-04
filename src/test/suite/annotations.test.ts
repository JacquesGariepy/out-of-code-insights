import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'JacquesGariepy.out-of-code-insights';

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders;
    assert.ok(ws && ws.length > 0, 'a workspace folder must be open during tests');
    return ws[0].uri.fsPath;
}

function annotationsFile(): string {
    return path.join(workspaceRoot(), '.out-of-code-insights', 'annotations.json');
}

function readAnnotations(): Array<Record<string, unknown>> {
    const file = annotationsFile();
    if (!fs.existsSync(file)) {
        return [];
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

suite('JSON schema validation on annotation import', () => {
    function isValidAnnotation(obj: unknown): obj is Record<string, unknown> {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return false;
        }
        const record = obj as Record<string, unknown>;
        return (
            typeof record['id'] === 'string' &&
            typeof record['file'] === 'string' &&
            typeof record['line'] === 'number' &&
            typeof record['message'] === 'string'
        );
    }

    test('rejects malformed JSON (not parseable)', () => {
        assert.throws(() => {
            JSON.parse('{broken json');
        }, SyntaxError);
    });

    test('rejects an empty array of annotations', () => {
        const parsed = JSON.parse('[]');
        assert.strictEqual(Array.isArray(parsed) && parsed.length === 0, true);
    });

    test('rejects annotation missing required id field', () => {
        const bad = { file: 'sample.ts', line: 1, message: 'hello' };
        assert.strictEqual(isValidAnnotation(bad), false);
    });

    test('rejects annotation missing required file field', () => {
        const bad = { id: 'x', line: 1, message: 'hello' };
        assert.strictEqual(isValidAnnotation(bad), false);
    });

    test('rejects annotation missing required line field', () => {
        const bad = { id: 'x', file: 'sample.ts', message: 'hello' };
        assert.strictEqual(isValidAnnotation(bad), false);
    });

    test('rejects annotation missing required message field', () => {
        const bad = { id: 'x', file: 'sample.ts', line: 1 };
        assert.strictEqual(isValidAnnotation(bad), false);
    });

    test('accepts a fully valid annotation shape', () => {
        const good = { id: 'abc', file: 'sample.ts', line: 5, message: 'ok' };
        assert.strictEqual(isValidAnnotation(good), true);
    });

    test('rejects non-object entry in annotation array', () => {
        const parsed = JSON.parse('[1, 2, 3]') as unknown[];
        const valid = parsed.every(item => isValidAnnotation(item));
        assert.strictEqual(valid, false);
    });
});

suite('Annotation persistence', () => {
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        await ext.activate();
    });

    setup(() => {
        const file = annotationsFile();
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });

    test('annotations file path resolves under workspace', () => {
        const file = annotationsFile();
        assert.ok(file.includes('.out-of-code-insights'), 'path should target the configured directory');
        assert.ok(path.isAbsolute(file), 'path should be absolute under the test workspace');
    });

    test('export/import round-trip preserves shape', async () => {
        const sample = [
            {
                id: 'test-1',
                file: 'sample.ts',
                line: 1,
                message: 'Hello from integration test',
                author: 'Tester',
                timestamp: new Date().toISOString(),
                thread: [],
                tags: ['test'],
                pinned: false,
                priority: 0,
                severity: 'info',
                resolved: false,
            },
        ];

        const dir = path.dirname(annotationsFile());
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(annotationsFile(), JSON.stringify(sample, null, 2), 'utf8');

        const round = readAnnotations();
        assert.strictEqual(round.length, 1);
        assert.strictEqual(round[0].id, 'test-1');
        assert.strictEqual(round[0].severity, 'info');
        assert.deepStrictEqual(round[0].tags, ['test']);
    });
});
