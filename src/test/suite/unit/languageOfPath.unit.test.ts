/**
 * Pure-logic tests for the extension → languageId map used by the
 * workspace-wide comment import (`annotations.importCommentsWorkspace`).
 */
import * as assert from 'assert';
import { DEFAULT_LANGUAGE_ID, languageOfPath } from '../../../comments/languageOfPath';

suite('languageOfPath — extension to languageId', () => {
    test('maps every extension targeted by the workspace-import glob', () => {
        const expectations: Array<[string, string]> = [
            ['src/a.ts', 'typescript'],
            ['src/a.tsx', 'typescriptreact'],
            ['a.js', 'javascript'],
            ['a.jsx', 'javascriptreact'],
            ['tools/run.py', 'python'],
            ['a.rb', 'ruby'],
            ['a.go', 'go'],
            ['a.rs', 'rust'],
            ['A.java', 'java'],
            ['a.c', 'c'],
            ['a.cpp', 'cpp'],
            ['a.h', 'c'],
            ['a.cs', 'csharp'],
            ['a.sh', 'shellscript'],
            ['a.ps1', 'powershell'],
            ['a.sql', 'sql'],
            ['a.lua', 'lua'],
            ['a.yaml', 'yaml'],
            ['a.yml', 'yaml'],
            ['a.toml', 'toml'],
            ['a.html', 'html'],
            ['a.vue', 'vue'],
            ['README.md', 'markdown'],
        ];
        for (const [path, languageId] of expectations) {
            assert.strictEqual(languageOfPath(path), languageId, path);
        }
    });

    test('accepts Windows separators and uppercase extensions', () => {
        assert.strictEqual(languageOfPath('C:\\repo\\src\\Main.TS'), 'typescript');
        assert.strictEqual(languageOfPath('C:\\repo\\script.PY'), 'python');
        assert.strictEqual(languageOfPath('C:\\repo\\mixed/sep\\file.Yml'), 'yaml');
    });

    test('multi-dot names use the last extension only', () => {
        assert.strictEqual(languageOfPath('a.unit.test.ts'), 'typescript');
        assert.strictEqual(languageOfPath('archive.tar.gz'), DEFAULT_LANGUAGE_ID);
    });

    test('unknown, missing or degenerate extensions fall back to plaintext', () => {
        assert.strictEqual(languageOfPath('Makefile'), DEFAULT_LANGUAGE_ID);
        assert.strictEqual(languageOfPath('.gitignore'), DEFAULT_LANGUAGE_ID);
        assert.strictEqual(languageOfPath('trailing.'), DEFAULT_LANGUAGE_ID);
        assert.strictEqual(languageOfPath(''), DEFAULT_LANGUAGE_ID);
        assert.strictEqual(languageOfPath('a.unknownext'), DEFAULT_LANGUAGE_ID);
    });
});
