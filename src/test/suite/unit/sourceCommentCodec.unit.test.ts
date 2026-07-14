// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import {
    encodeSourceComment,
    scanSourceComments,
    sourceCommentAnnotationIdFragment,
    sourceCommentAnnotationMarker,
    supportsSourceCommentEncoding,
    supportsSourceCommentLanguage,
} from '../../../comments/sourceCommentCodec';

suite('sourceCommentCodec — standalone scanner', () => {
    test('groups consecutive standalone line comments and ignores code, inline comments, and ordinary strings', () => {
        const source = [
            'const literal = "// not a comment";',
            '    // first logical line',
            '\t// second logical line',
            'const value = 1; // inline is deliberately ignored',
            '    // separate comment',
            '"// still only a string";',
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'typescript'), [
            {
                startLine: 1,
                endLine: 2,
                text: 'first logical line\nsecond logical line',
                kind: 'line',
            },
            { startLine: 4, endLine: 4, text: 'separate comment', kind: 'line' },
        ]);
    });

    test('recognizes a file header after a shebang without importing the shebang', () => {
        const source = [
            '#!/usr/bin/env python3',
            '# Package-level explanation',
            '# Continued header',
            '',
            'answer = 42',
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'python'), [
            {
                startLine: 1,
                endLine: 2,
                text: 'Package-level explanation\nContinued header',
                kind: 'header',
            },
        ]);
    });

    test('extracts decorated docblocks after code', () => {
        const source = [
            'export const answer = 42;',
            '',
            '/**',
            ' * Calculates the answer.',
            ' * @returns the value',
            ' */',
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'javascript'), [
            {
                startLine: 2,
                endLine: 5,
                text: 'Calculates the answer.\n@returns the value',
                kind: 'docblock',
            },
        ]);
    });

    test('extracts regular multiline blocks', () => {
        const source = ['const ready = true;', '/*', ' * operational note', ' * second line', ' */'];
        assert.deepStrictEqual(scanSourceComments(source, 'go'), [
            {
                startLine: 1,
                endLine: 4,
                text: 'operational note\nsecond line',
                kind: 'block',
            },
        ]);
    });

    test('extracts standalone HTML comments and ignores inline markup comments', () => {
        const source = [
            '<main>',
            '  <!--',
            '    Accessibility rationale',
            '    Keep this node announced',
            '  -->',
            '  <p><!-- inline comment is ignored --></p>',
            '</main>',
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'html'), [
            {
                startLine: 1,
                endLine: 4,
                text: 'Accessibility rationale\nKeep this node announced',
                kind: 'block',
            },
        ]);
    });

    test('does not scan HTML-looking comments inside fenced Markdown code', () => {
        const source = ['# Example', '', '```html', '<!-- not documentation -->', '```', '<!-- real note -->'];
        assert.deepStrictEqual(scanSourceComments(source, 'markdown'), [
            { startLine: 5, endLine: 5, text: 'real note', kind: 'block' },
        ]);
    });

    test('returns no records for an unsupported language', () => {
        assert.deepStrictEqual(scanSourceComments(['// not guessed', '# not guessed'], 'plaintext'), []);
        assert.strictEqual(supportsSourceCommentLanguage('plaintext'), false);
    });

    test('strips generated markers and exposes their stable annotation-id fragment for round trips', () => {
        const annotationId = '{123e4567-e89b-12d3-a456-426614174000}';
        const encoded = encodeSourceComment('First line\nSecond line', 'typescript', {
            annotationId,
            style: 'line',
        });

        assert.deepStrictEqual(scanSourceComments(encoded, 'typescript'), [
            {
                startLine: 0,
                endLine: 1,
                text: 'First line\nSecond line',
                kind: 'header',
                annotationIdFragment: '123e4567',
            },
        ]);
        assert.strictEqual(sourceCommentAnnotationIdFragment(annotationId), '123e4567');
        assert.strictEqual(sourceCommentAnnotationMarker(annotationId), 'OOCI(123e4567)');
    });

    test('does not treat marker-like text outside the generated marker position as metadata', () => {
        assert.deepStrictEqual(scanSourceComments(['// Explain OOCI(12345678) here'], 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                text: 'Explain OOCI(12345678) here',
                kind: 'header',
            },
        ]);
    });
});

suite('sourceCommentCodec — language syntax catalogue', () => {
    test('supports every required VS Code language id', () => {
        const languages = [
            'typescript',
            'typescriptreact',
            'javascript',
            'javascriptreact',
            'java',
            'c',
            'cpp',
            'csharp',
            'go',
            'rust',
            'swift',
            'kotlin',
            'dart',
            'php',
            'python',
            'ruby',
            'shellscript',
            'powershell',
            'perl',
            'r',
            'yaml',
            'toml',
            'dockerfile',
            'makefile',
            'sql',
            'lua',
            'haskell',
            'html',
            'xml',
            'svg',
            'markdown',
            'vue',
            'css',
            'scss',
            'clojure',
            'lisp',
            'ini',
        ];
        assert.deepStrictEqual(
            languages.filter((languageId) => !supportsSourceCommentLanguage(languageId)),
            []
        );
    });

    test('scans representative hash, SQL, Lua, Haskell, CSS, PowerShell, and semicolon forms', () => {
        const cases: ReadonlyArray<readonly [string, string]> = [
            ['python', '# hash'],
            ['sql', '-- query'],
            ['lua', '--[[ lua block ]]'],
            ['haskell', '{- haskell block -}'],
            ['css', '/* css block */'],
            ['powershell', '<# powershell block #>'],
            ['clojure', ';; clojure'],
            ['ini', '; ini'],
        ];
        for (const [languageId, comment] of cases) {
            const records = scanSourceComments(['code token', comment], languageId);
            assert.strictEqual(records.length, 1, `${languageId} should scan its native syntax`);
            assert.ok(records[0].text.length > 0, `${languageId} should retain comment text`);
        }
    });

    test('keeps scanning available but disables context-free writes for mixed template/code modes', () => {
        for (const languageId of ['typescriptreact', 'javascriptreact', 'vue', 'php']) {
            assert.strictEqual(supportsSourceCommentLanguage(languageId), true);
            assert.strictEqual(supportsSourceCommentEncoding(languageId), false);
            assert.throws(
                () => encodeSourceComment('unsafe without syntax context', languageId, { annotationId: 'id' }),
                /requires mixed-language context/
            );
        }
        assert.strictEqual(supportsSourceCommentEncoding('typescript'), true);
        assert.strictEqual(supportsSourceCommentEncoding('plaintext'), false);
    });

    test('does not advertise a block-comment syntax that Clojure does not implement', () => {
        assert.throws(
            () => encodeSourceComment('message', 'clojure', { annotationId: 'id', style: 'block' }),
            /does not support block comments/
        );
    });
});

suite('sourceCommentCodec — safe encoder', () => {
    test('encodes multiline annotations as indented line comments with a short readable marker', () => {
        const encoded = encodeSourceComment('First line\nSecond line', 'typescript', {
            annotationId: '{123e4567-e89b-12d3-a456-426614174000}',
            indentation: '    ',
            style: 'line',
        });
        assert.strictEqual(encoded, '    // OOCI(123e4567) First line\n    // Second line');
    });

    test('encodes a conventional docblock and neutralizes its terminator', () => {
        const encoded = encodeSourceComment('Never emit */ from message content', 'java', {
            annotationId: 'abcdef12-3456',
            style: 'docblock',
        });
        assert.strictEqual(encoded, '/**\n * OOCI(abcdef12) Never emit * / from message content\n */');
        assert.strictEqual(encoded.split('*/').length - 1, 1, 'only the generated closing delimiter may remain');
    });

    test('encodes valid HTML comments and neutralizes both terminators and forbidden double hyphens', () => {
        const encoded = encodeSourceComment('alpha --> beta -- gamma', 'html', {
            annotationId: 'html-123456',
            indentation: '  ',
            style: 'block',
        });
        assert.ok(encoded.startsWith('  <!--\n    OOCI(html-123)'));
        assert.ok(encoded.endsWith('\n  -->'));
        const body = encoded.split('\n').slice(1, -1).join('\n');
        assert.ok(!body.includes('-->'));
        assert.ok(!body.includes('--'), 'XML/HTML comment bodies cannot contain a double hyphen');
    });

    test('neutralizes PowerShell block terminators and unsafe indentation/control content', () => {
        const encoded = encodeSourceComment(`stop #>${String.fromCharCode(0)} now`, 'powershell', {
            annotationId: '<unsafe:id>',
            indentation: '  injected-code',
            style: 'block',
        });
        assert.ok(encoded.startsWith('  <#\n'));
        assert.ok(encoded.includes('OOCI(unsafeid) stop # >  now'));
        assert.strictEqual(encoded.split('#>').length - 1, 1);
        assert.ok(!encoded.includes('injected-code'));
    });

    test('neutralizes block openers as well as closers so nested syntaxes remain balanced', () => {
        const encoded = encodeSourceComment('outer {- nested -} done', 'haskell', {
            annotationId: 'nested-1',
            style: 'block',
        });
        const body = encoded.split('\n').slice(1, -1).join('\n');
        assert.ok(!body.includes('{-'), 'a generated body must not start an unclosed nested comment');
        assert.ok(!body.includes('-}'), 'a generated body must not close its containing comment');
        assert.strictEqual(encoded.split('{-').length - 1, 1);
        assert.strictEqual(encoded.split('-}').length - 1, 1);
    });

    test('rejects unsupported languages and unavailable styles explicitly', () => {
        assert.throws(
            () => encodeSourceComment('message', 'plaintext', { annotationId: 'id' }),
            /Unsupported source-comment languageId/
        );
        assert.throws(
            () => encodeSourceComment('message', 'python', { annotationId: 'id', style: 'block' }),
            /does not support block comments/
        );
        assert.throws(
            () => encodeSourceComment('message', 'html', { annotationId: 'id', style: 'line' }),
            /does not support line comments/
        );
    });
});
