// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import {
    SOURCE_COMMENT_SAFE_INSERTION_LANGUAGE_IDS,
    canSafelyRemoveSourceComment,
    encodeSourceComment,
    safeSourceCommentInsertionLine,
    scanSourceComments,
    sourceCommentImportTag,
    sourceCommentImportTags,
    sourceCommentAnnotationIdFragment,
    sourceCommentAnnotationIdFingerprint,
    sourceCommentAnnotationMarker,
    sourceCommentMarkerMatchesAnnotation,
    sourceCommentRoundTripsAnnotation,
    supportsSourceCommentEncoding,
    supportsSourceCommentLanguage,
} from '../../../comments/sourceCommentCodec';

suite('sourceCommentCodec — source scanner', () => {
    test('groups standalone comments, imports trailing comments, and ignores ordinary strings', () => {
        const source = [
            'const literal = "// not a comment";',
            '    // first logical line',
            '\t// second logical line',
            'const value = 1; // inline rationale',
            '    // separate comment',
            '"// still only a string";',
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'typescript'), [
            {
                startLine: 1,
                endLine: 2,
                startCharacter: 4,
                endCharacter: 23,
                text: 'first logical line\nsecond logical line',
                kind: 'line',
            },
            {
                startLine: 3,
                endLine: 3,
                startCharacter: 17,
                endCharacter: 36,
                text: 'inline rationale',
                kind: 'line',
            },
            {
                startLine: 4,
                endLine: 4,
                startCharacter: 4,
                endCharacter: 23,
                text: 'separate comment',
                kind: 'line',
            },
        ]);
    });

    test('extracts inline blocks without consuming surrounding code and ignores quoted or regular-expression syntax', () => {
        const source = [
            'const url = "https://example.test/*not-comment*/";',
            'const matcher = /[/*]{2}/;',
            'const value = /* conversion note */ compute();',
            "const quoted = '// still not a comment'; // real note",
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'typescript'), [
            {
                startLine: 2,
                endLine: 2,
                startCharacter: 14,
                endCharacter: 35,
                text: 'conversion note',
                kind: 'block',
            },
            {
                startLine: 3,
                endLine: 3,
                startCharacter: 41,
                endCharacter: 53,
                text: 'real note',
                kind: 'line',
            },
        ]);
    });

    test('reports exact exclusive coordinates for a multiline block embedded in code', () => {
        const source = ['const value = /* first line', ' * second line', ' */ compute();'];

        assert.deepStrictEqual(scanSourceComments(source, 'typescript'), [
            {
                startLine: 0,
                endLine: 2,
                startCharacter: 14,
                endCharacter: 3,
                text: 'first line\nsecond line',
                kind: 'block',
            },
        ]);
    });

    test('finds every comment when a block and line comment share one line', () => {
        assert.deepStrictEqual(scanSourceComments(['const x = /* first */ 1; // second'], 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 10,
                endCharacter: 21,
                text: 'first',
                kind: 'block',
            },
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 25,
                endCharacter: 34,
                text: 'second',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(['/* first */ const x=1; // second'], 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 0,
                endCharacter: 11,
                text: 'first',
                kind: 'header',
            },
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 23,
                endCharacter: 32,
                text: 'second',
                kind: 'line',
            },
        ]);
    });

    test('keeps trailing detection conservative around URLs, division, and regular expressions', () => {
        const vueSource = ['<a href=https://example.test/path>Link</a>', 'const ready = true; // Vue note'];
        assert.deepStrictEqual(scanSourceComments(vueSource, 'vue'), [
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 20,
                endCharacter: 31,
                text: 'Vue note',
                kind: 'line',
            },
        ]);

        const typescriptSource = [
            'const ratio = total / count; // ratio note',
            'const matcher = /https?:\\/\\/example/; // pattern note',
        ];
        assert.deepStrictEqual(scanSourceComments(typescriptSource, 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 29,
                endCharacter: 42,
                text: 'ratio note',
                kind: 'line',
            },
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 38,
                endCharacter: 53,
                text: 'pattern note',
                kind: 'line',
            },
        ]);
    });

    test('accepts adjacent delimiters in homogeneous code modes but keeps mixed-mode URLs safe', () => {
        const source = ['const x=1;// note', 'const x=/* note */1'];
        assert.deepStrictEqual(scanSourceComments(source, 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 10,
                endCharacter: 17,
                text: 'note',
                kind: 'line',
            },
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 8,
                endCharacter: 18,
                text: 'note',
                kind: 'block',
            },
        ]);

        assert.deepStrictEqual(
            scanSourceComments(['<a href=https://example.test/path>Link</a>', 'const x=1;// not-safe'], 'vue'),
            []
        );
    });

    test('does not propagate language apostrophes as multiline string state', () => {
        assert.deepStrictEqual(scanSourceComments(["fn get<'a>() { // note", "fn f(x: &'a str) { // note"], 'rust'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 15,
                endCharacter: 22,
                text: 'note',
                kind: 'line',
            },
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 19,
                endCharacter: 26,
                text: 'note',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(["map' xs -- note"], 'haskell'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 8,
                endCharacter: 15,
                text: 'note',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(["(def x 'foo) ; note"], 'clojure'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 13,
                endCharacter: 19,
                text: 'note',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(["auto n = 1'000; // important"], 'cpp'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 16,
                endCharacter: 28,
                text: 'important',
                kind: 'line',
            },
        ]);
    });

    test('accepts adjacent line delimiters only where the language grammar makes them comments', () => {
        const cases: ReadonlyArray<readonly [string, string]> = [
            ['python', 'value = 1# important'],
            ['r', 'x<-1# note'],
            ['powershell', '$x=1# note'],
            ['lua', 'x=1--note'],
            ['clojure', '(inc x);note'],
            ['ruby', 'x=1#note'],
            ['perl', '$x=1#note'],
            ['toml', 'x=1#note'],
            ['sql', 'x=1-- note'],
            ['haskell', 'x=1-- note'],
        ];
        for (const [languageId, source] of cases) {
            assert.strictEqual(scanSourceComments([source], languageId).length, 1, languageId);
        }
        assert.deepStrictEqual(scanSourceComments(['RUN echo value#shell-data'], 'dockerfile'), []);
        assert.deepStrictEqual(scanSourceComments(['key: value#yaml-data'], 'yaml'), []);
        assert.strictEqual(scanSourceComments(['color:red/*note*/'], 'css').length, 1);
        assert.strictEqual(scanSourceComments(['text<!--note-->'], 'html').length, 1);
        assert.deepStrictEqual(scanSourceComments(['<?php $x=1;// mixed-context'], 'php'), []);
    });

    test('masks YAML block scalars and JavaScript regex contents before finding real trailing comments', () => {
        const yaml = ['script: |', '  # literal', 'folded: >-2', '  # folded literal', 'next: true # real'];
        assert.deepStrictEqual(scanSourceComments(yaml, 'yaml'), [
            {
                startLine: 4,
                endLine: 4,
                startCharacter: 11,
                endCharacter: 17,
                text: 'real',
                kind: 'line',
            },
        ]);

        const javascript = ['if (ok) /foo \\/\\/ bar/.test(x); // real'];
        assert.deepStrictEqual(scanSourceComments(javascript, 'javascript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 32,
                endCharacter: 39,
                text: 'real',
                kind: 'line',
            },
        ]);

        const regexAfterBlocks = [
            'if (true) {} else /[/*][*/]/.test("/*"); // real',
            '{ } /[/*][*/]/.test("/*"); // real',
        ];
        assert.deepStrictEqual(scanSourceComments(regexAfterBlocks, 'javascript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 41,
                endCharacter: 48,
                text: 'real',
                kind: 'line',
            },
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 27,
                endCharacter: 34,
                text: 'real',
                kind: 'line',
            },
        ]);
    });

    test('never returns an unterminated block comment as a removable record', () => {
        assert.deepStrictEqual(scanSourceComments(['const x=1; /* note', 'const y=2;'], 'typescript'), []);
        assert.deepStrictEqual(scanSourceComments(['/* unfinished', '// still part of the block'], 'typescript'), []);
    });

    test('keeps complete ranges for languages with nested block comments', () => {
        const cStyle = 'let x=1; /* outer /* inner */ outer tail */ let y=2;';
        for (const languageId of ['rust', 'swift', 'kotlin', 'dart']) {
            const records = scanSourceComments([cStyle], languageId);
            assert.deepStrictEqual(records, [
                {
                    startLine: 0,
                    endLine: 0,
                    startCharacter: 9,
                    endCharacter: 43,
                    text: 'outer /* inner */ outer tail',
                    kind: 'block',
                },
            ]);
            assert.strictEqual(canSafelyRemoveSourceComment(languageId, records[0]), false);
        }

        const haskell = scanSourceComments(['value = {- outer {- inner -} outer tail -} next'], 'haskell');
        assert.deepStrictEqual(haskell, [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 8,
                endCharacter: 42,
                text: 'outer {- inner -} outer tail',
                kind: 'block',
            },
        ]);
        assert.strictEqual(canSafelyRemoveSourceComment('haskell', haskell[0]), false);
    });

    test('masks SQL dollar strings, PowerShell backtick escapes, and Dockerfile inline values', () => {
        assert.deepStrictEqual(scanSourceComments(['SELECT $$ -- literal data $$; -- real'], 'sql'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 30,
                endCharacter: 37,
                text: 'real',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(['SELECT $tag$ /* literal */ $tag$;'], 'sql'), []);
        assert.deepStrictEqual(scanSourceComments(['SELECT $tag$', '-- literal data', '$tag$; -- real'], 'sql'), [
            {
                startLine: 2,
                endLine: 2,
                startCharacter: 7,
                endCharacter: 14,
                text: 'real',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(['$x = "escaped `" # still string" # real'], 'powershell'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 33,
                endCharacter: 39,
                text: 'real',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(['ENV NAME=value # literal-value-suffix', '# real'], 'dockerfile'), [
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 0,
                endCharacter: 6,
                text: 'real',
                kind: 'line',
            },
        ]);
    });

    test('exposes a narrow safe-removal policy independent from preview support', () => {
        const typescript = scanSourceComments(['const x=1;// line', 'const y=/* block */1'], 'typescript');
        assert.strictEqual(canSafelyRemoveSourceComment('typescript', typescript[0]), true);
        assert.strictEqual(canSafelyRemoveSourceComment('typescript', typescript[1]), false);

        const cBlock = scanSourceComments(['int x = /* block */ 1;'], 'c')[0];
        assert.strictEqual(canSafelyRemoveSourceComment('c', cBlock), false);
        const rust = scanSourceComments(['let x=1; // line', 'let y=/* block */1;'], 'rust');
        assert.strictEqual(canSafelyRemoveSourceComment('rust', rust[0]), true);
        assert.strictEqual(canSafelyRemoveSourceComment('rust', rust[1]), false);

        const vue = scanSourceComments(['const x=1; // preview only'], 'vue')[0];
        assert.strictEqual(canSafelyRemoveSourceComment('vue', vue), false);
        const swift = scanSourceComments(['let x=1; // regex-aware lexer required'], 'swift')[0];
        assert.strictEqual(canSafelyRemoveSourceComment('swift', swift), false);
        const header = scanSourceComments(['// header'], 'typescript')[0];
        assert.strictEqual(header.syntaxKind, 'line');
        assert.strictEqual(canSafelyRemoveSourceComment('typescript', header), true);
        const blockHeader = scanSourceComments(['/* header */'], 'c')[0];
        assert.strictEqual(blockHeader.syntaxKind, 'block');
        assert.strictEqual(canSafelyRemoveSourceComment('c', blockHeader), false);
        const mixedHeader = scanSourceComments(['// header'], 'vue')[0];
        assert.strictEqual(canSafelyRemoveSourceComment('vue', mixedHeader), false);
    });

    test('fails closed when removing an inline block could merge language tokens', () => {
        for (const languageId of ['c', 'cpp', 'java', 'csharp', 'go']) {
            const source = 'return/* gap */value;';
            const records = scanSourceComments([source], languageId);

            assert.strictEqual(records.length, 1, languageId);
            assert.deepStrictEqual(
                {
                    startLine: records[0].startLine,
                    endLine: records[0].endLine,
                    startCharacter: records[0].startCharacter,
                    endCharacter: records[0].endCharacter,
                    text: records[0].text,
                    syntaxKind: records[0].syntaxKind,
                },
                {
                    startLine: 0,
                    endLine: 0,
                    startCharacter: 6,
                    endCharacter: 15,
                    text: 'gap',
                    syntaxKind: 'block',
                },
                languageId
            );
            assert.strictEqual(canSafelyRemoveSourceComment(languageId, records[0]), false, languageId);
            assert.strictEqual(
                `${source.slice(0, records[0].startCharacter)}${source.slice(records[0].endCharacter)}`,
                'returnvalue;',
                languageId
            );
        }
    });

    test('keeps standalone and whitespace-delimited blocks non-destructive without neighbour proof', () => {
        for (const source of ['/* standalone */', 'return /* separated */ value;', '/* first\nsecond */']) {
            const record = scanSourceComments(source, 'java')[0];
            assert.ok(record, source);
            assert.strictEqual(canSafelyRemoveSourceComment('java', record), false, source);
        }
    });

    test('builds non-sensitive stable import tags that distinguish equal comments', () => {
        const source = ['const first = 1; // same note', '', 'const second = 2; // same note'];
        const records = scanSourceComments(source, 'typescript');
        const [firstTag, secondTag] = sourceCommentImportTags(
            'FILE:///C:\\Repo\\sample.ts',
            'typescript',
            source,
            records
        );
        assert.match(firstTag, /^source-comment-import:[a-f0-9]{16}$/);
        assert.match(secondTag, /^source-comment-import:[a-f0-9]{16}$/);
        assert.notStrictEqual(firstTag, secondTag);
        assert.ok(!firstTag.includes('same'));

        const shifted = ['', '', ...source];
        const shiftedRecords = scanSourceComments(shifted, 'typescript');
        const shiftedTags = sourceCommentImportTags('file:///c:/Repo/sample.ts', 'TYPESCRIPT', shifted, shiftedRecords);
        assert.strictEqual(shiftedTags[0], firstTag);
        assert.strictEqual(shiftedTags[1], secondTag);
        assert.strictEqual(
            sourceCommentImportTag(
                'file:///c:/Repo/sample.ts',
                'TYPESCRIPT',
                shifted,
                shiftedRecords[0],
                shiftedRecords
            ),
            firstTag
        );

        const largeSource = Array.from(
            { length: 2_000 },
            (_value, index) => `const value${index} = ${index}; // repeated note`
        );
        const largeRecords = scanSourceComments(largeSource, 'typescript');
        const largeTags = sourceCommentImportTags('file:///c:/Repo/large.ts', 'typescript', largeSource, largeRecords);
        assert.strictEqual(largeRecords.length, 2_000);
        assert.strictEqual(largeTags.length, 2_000);
        assert.strictEqual(new Set(largeTags).size, 2_000);
    });

    test('does not import comment-like text from multiline strings, raw strings, or shell heredocs', () => {
        const typescriptSource = [
            'const template = `',
            '  // template content',
            '`;',
            'const ready = true; // real note',
        ];
        assert.deepStrictEqual(scanSourceComments(typescriptSource, 'typescript'), [
            {
                startLine: 3,
                endLine: 3,
                startCharacter: 20,
                endCharacter: 32,
                text: 'real note',
                kind: 'line',
            },
        ]);

        assert.deepStrictEqual(scanSourceComments(['const s = `${value /* important */}`;'], 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 19,
                endCharacter: 34,
                text: 'important',
                kind: 'block',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(['const s = `${`// literal`}`; // real'], 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 29,
                endCharacter: 36,
                text: 'real',
                kind: 'line',
            },
        ]);
        assert.deepStrictEqual(scanSourceComments(['const s = `${"foo\\', '// literal"}`; // real'], 'typescript'), [
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 15,
                endCharacter: 22,
                text: 'real',
                kind: 'line',
            },
        ]);

        const pythonSource = ['payload = """', '# string content', '"""', '# real note'];
        assert.deepStrictEqual(scanSourceComments(pythonSource, 'python'), [
            {
                startLine: 3,
                endLine: 3,
                startCharacter: 0,
                endCharacter: 11,
                text: 'real note',
                kind: 'line',
            },
        ]);

        const rustSource = ['let payload = r#"', '// raw string content', '"#;', 'let ready = true; // real note'];
        assert.deepStrictEqual(scanSourceComments(rustSource, 'rust'), [
            {
                startLine: 3,
                endLine: 3,
                startCharacter: 18,
                endCharacter: 30,
                text: 'real note',
                kind: 'line',
            },
        ]);

        const shellSource = ["cat <<'CONTENT'", '# heredoc content', 'CONTENT', '# real note'];
        assert.deepStrictEqual(scanSourceComments(shellSource, 'shellscript'), [
            {
                startLine: 3,
                endLine: 3,
                startCharacter: 0,
                endCharacter: 11,
                text: 'real note',
                kind: 'line',
            },
        ]);
    });

    test('preserves BOM and CRLF-aware UTF-16 coordinates for safe source deletion', () => {
        const source = '\uFEFF// note\r\nconst value = 1; // trailing\r\n';
        assert.deepStrictEqual(scanSourceComments(source, 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 1,
                endCharacter: 8,
                text: 'note',
                kind: 'header',
            },
            {
                startLine: 1,
                endLine: 1,
                startCharacter: 17,
                endCharacter: 28,
                text: 'trailing',
                kind: 'line',
            },
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
                startCharacter: 0,
                endCharacter: 18,
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
                startCharacter: 0,
                endCharacter: 3,
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
                startCharacter: 0,
                endCharacter: 3,
                text: 'operational note\nsecond line',
                kind: 'block',
            },
        ]);
    });

    test('extracts standalone and inline HTML comments with exact ranges', () => {
        const source = [
            '<main>',
            '  <!--',
            '    Accessibility rationale',
            '    Keep this node announced',
            '  -->',
            '  <p> <!-- inline comment is imported --></p>',
            '</main>',
        ];

        assert.deepStrictEqual(scanSourceComments(source, 'html'), [
            {
                startLine: 1,
                endLine: 4,
                startCharacter: 2,
                endCharacter: 5,
                text: 'Accessibility rationale\nKeep this node announced',
                kind: 'block',
            },
            {
                startLine: 5,
                endLine: 5,
                startCharacter: 6,
                endCharacter: 41,
                text: 'inline comment is imported',
                kind: 'block',
            },
        ]);
    });

    test('does not scan HTML-looking comments inside fenced Markdown code', () => {
        const source = ['# Example', '', '```html', '<!-- not documentation -->', '```', '<!-- real note -->'];
        assert.deepStrictEqual(scanSourceComments(source, 'markdown'), [
            {
                startLine: 5,
                endLine: 5,
                startCharacter: 0,
                endCharacter: 18,
                text: 'real note',
                kind: 'block',
            },
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
                startCharacter: 0,
                endCharacter: 14,
                text: 'First line\nSecond line',
                kind: 'header',
                annotationIdFragment: '123e4567',
                annotationIdFingerprint: 'e328b6512f1a357e2ff6c80309068b2e',
            },
        ]);
        assert.strictEqual(sourceCommentAnnotationIdFragment(annotationId), '123e4567');
        assert.strictEqual(sourceCommentAnnotationIdFingerprint(annotationId), 'e328b6512f1a357e2ff6c80309068b2e');
        assert.strictEqual(
            sourceCommentAnnotationMarker(annotationId),
            'OOCI(123e4567~e328b6512f1a357e2ff6c80309068b2e)'
        );
        assert.strictEqual(
            sourceCommentMarkerMatchesAnnotation(scanSourceComments(encoded, 'typescript')[0], annotationId),
            true
        );
        assert.strictEqual(
            sourceCommentRoundTripsAnnotation(
                scanSourceComments(encoded, 'typescript')[0],
                annotationId,
                'First line\nSecond line'
            ),
            true
        );
    });

    test('reads legacy markers but uses a strong fingerprint to disambiguate common id prefixes', () => {
        const firstId = 'annotation-one';
        const secondId = 'annotation-two';
        const first = scanSourceComments(
            encodeSourceComment('First', 'typescript', { annotationId: firstId }),
            'typescript'
        )[0];
        const legacy = scanSourceComments('// OOCI(annotati) Legacy', 'typescript')[0];

        assert.strictEqual(sourceCommentAnnotationIdFragment(firstId), sourceCommentAnnotationIdFragment(secondId));
        assert.notStrictEqual(
            sourceCommentAnnotationIdFingerprint(firstId),
            sourceCommentAnnotationIdFingerprint(secondId)
        );
        assert.strictEqual(sourceCommentMarkerMatchesAnnotation(first, firstId), true);
        assert.strictEqual(sourceCommentMarkerMatchesAnnotation(first, secondId), false);
        assert.strictEqual(sourceCommentMarkerMatchesAnnotation(legacy, firstId), true);
        assert.strictEqual(sourceCommentRoundTripsAnnotation(legacy, firstId, 'Legacy'), false);
    });

    test('splits consecutive generated annotations when they are separated explicitly', () => {
        const first = encodeSourceComment('First line\nFirst continuation', 'typescript', {
            annotationId: 'first-id',
            style: 'line',
        });
        const second = encodeSourceComment('Second line\nSecond continuation', 'typescript', {
            annotationId: 'second-id',
            style: 'line',
        });
        const records = scanSourceComments(`${first}\n\n${second}`, 'typescript');
        assert.deepStrictEqual(
            records.map(({ text, annotationIdFragment }) => ({ text, annotationIdFragment })),
            [
                { text: 'First line\nFirst continuation', annotationIdFragment: 'first-id' },
                { text: 'Second line\nSecond continuation', annotationIdFragment: 'second-i' },
            ]
        );
    });

    test('keeps marker-like continuation text inside its generated annotation', () => {
        const encoded = encodeSourceComment('First line\nOOCI(deadbeef) injected', 'typescript', {
            annotationId: '12345678-real',
            style: 'line',
        });

        const records = scanSourceComments(encoded, 'typescript');

        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].text, 'First line\nOOCI(deadbeef) injected');
        assert.strictEqual(records[0].annotationIdFragment, '12345678');
    });

    test('does not treat marker-like text outside the generated marker position as metadata', () => {
        assert.deepStrictEqual(scanSourceComments(['// Explain OOCI(12345678) here'], 'typescript'), [
            {
                startLine: 0,
                endLine: 0,
                startCharacter: 0,
                endCharacter: 30,
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

    test('uses an exact audited allowlist for annotation-to-comment writes', () => {
        assert.deepStrictEqual(SOURCE_COMMENT_SAFE_INSERTION_LANGUAGE_IDS, [
            'typescript',
            'javascript',
            'c',
            'cpp',
            'java',
            'csharp',
            'go',
            'rust',
            'kotlin',
            'dart',
            'python',
            'toml',
            'lua',
            'css',
            'scss',
            'clojure',
        ]);
        for (const languageId of SOURCE_COMMENT_SAFE_INSERTION_LANGUAGE_IDS) {
            assert.strictEqual(supportsSourceCommentEncoding(languageId), true, languageId);
        }
        for (const languageId of ['typescriptreact', 'javascriptreact', 'vue', 'php', 'html', 'powershell']) {
            assert.strictEqual(supportsSourceCommentLanguage(languageId), true);
            assert.strictEqual(supportsSourceCommentEncoding(languageId), false);
            assert.throws(
                () => encodeSourceComment('unsafe without syntax context', languageId, { annotationId: 'id' }),
                /not allowlisted/
            );
        }
        assert.strictEqual(supportsSourceCommentEncoding('plaintext'), false);
    });

    test('moves insertion past protected preambles and preserves a leading BOM', () => {
        assert.strictEqual(
            safeSourceCommentInsertionLine(
                ['#!/usr/bin/env python3', '# -*- coding: utf-8 -*-', 'print("ok")'],
                'python',
                0
            ),
            2
        );
        assert.strictEqual(safeSourceCommentInsertionLine(['@charset "UTF-8";', 'body {}'], 'css', 0), 1);
        assert.strictEqual(
            safeSourceCommentInsertionLine(['\uFEFFconst first = 1;', 'const second = 2;'], 'typescript', 0),
            1
        );
        assert.strictEqual(safeSourceCommentInsertionLine(['\uFEFFconst only = 1;'], 'typescript', 0), undefined);
    });

    test('keeps Go build and compiler directive groups intact', () => {
        const buildSource = ['//go:build linux', '// +build linux', '', 'package main'];
        assert.strictEqual(safeSourceCommentInsertionLine(buildSource, 'go', 0), 3);
        assert.strictEqual(safeSourceCommentInsertionLine(['//go:noinline', 'func critical() {}'], 'go', 1), 0);
    });

    test('rewinds explicit Python and C-family continuation groups', () => {
        assert.strictEqual(safeSourceCommentInsertionLine(['value = first + \\', '    second'], 'python', 1), 0);
        assert.strictEqual(
            safeSourceCommentInsertionLine(['#define SUM(a, b) \\', '    ((a) + (b))', 'int value;'], 'cpp', 1),
            0
        );
        assert.strictEqual(
            safeSourceCommentInsertionLine(['const value = left / \\', '    right;'], 'typescript', 1),
            0
        );
    });

    test('rejects insertion inside proven multiline lexical or block-comment state', () => {
        const unsafeCases: ReadonlyArray<readonly [string, readonly string[]]> = [
            ['typescript', ['const value = `first', 'second`;']],
            ['javascript', ['const value = `first', 'second`;']],
            ['cpp', ['const char* value = R"tag(first', 'second)tag";']],
            ['java', ['String value = """', 'text', '""";']],
            ['csharp', ['var value = """', 'text', '""";']],
            ['rust', ['let value = r#"first', 'second"#;']],
            ['kotlin', ['val value = """', 'text', '"""']],
            ['dart', ['final value = """', 'text', '""";']],
            ['python', ['value = """', 'text', '"""']],
            ['toml', ['value = """', 'text', '"""']],
            ['lua', ['value = [[first', 'second]]']],
            ['css', ['/* first', 'second */']],
            ['scss', ['/* first', 'second */']],
        ];
        for (const [languageId, source] of unsafeCases) {
            assert.strictEqual(safeSourceCommentInsertionLine(source, languageId, 1), undefined, languageId);
        }
        assert.strictEqual(safeSourceCommentInsertionLine(['const value = 1;'], 'typescriptreact', 0), undefined);
        assert.strictEqual(safeSourceCommentInsertionLine(['SELECT $tag$', 'data', '$tag$;'], 'sql', 1), undefined);
        assert.strictEqual(safeSourceCommentInsertionLine(['key: |', '  data'], 'yaml', 1), undefined);
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
        const annotationId = '{123e4567-e89b-12d3-a456-426614174000}';
        const encoded = encodeSourceComment('First line\nSecond line', 'typescript', {
            annotationId,
            indentation: '    ',
            style: 'line',
        });
        assert.strictEqual(
            encoded,
            `    // ${sourceCommentAnnotationMarker(annotationId)} First line\n    // Second line`
        );
    });

    test('encodes a conventional docblock and neutralizes its terminator', () => {
        const annotationId = 'abcdef12-3456';
        const encoded = encodeSourceComment('Never emit */ from message content', 'java', {
            annotationId,
            style: 'docblock',
        });
        assert.strictEqual(
            encoded,
            `/**\n * ${sourceCommentAnnotationMarker(annotationId)} Never emit * / from message content\n */`
        );
        assert.strictEqual(encoded.split('*/').length - 1, 1, 'only the generated closing delimiter may remain');
    });

    test('neutralizes block terminators and unsafe indentation/control content', () => {
        const encoded = encodeSourceComment(`stop */${String.fromCharCode(0)} now`, 'csharp', {
            annotationId: '<unsafe:id>',
            indentation: '  injected-code',
            style: 'block',
        });
        assert.ok(encoded.startsWith('  /*\n'));
        assert.ok(encoded.includes(`${sourceCommentAnnotationMarker('<unsafe:id>')} stop * /  now`));
        assert.strictEqual(encoded.split('*/').length - 1, 1);
        assert.ok(!encoded.includes('injected-code'));
    });

    test('neutralizes block openers as well as closers so nested syntaxes remain balanced', () => {
        const encoded = encodeSourceComment('outer /* nested */ done', 'rust', {
            annotationId: 'nested-1',
            style: 'block',
        });
        const body = encoded.split('\n').slice(1, -1).join('\n');
        assert.ok(!body.includes('/*'), 'a generated body must not start an unclosed nested comment');
        assert.ok(!body.includes('*/'), 'a generated body must not close its containing comment');
        assert.strictEqual(encoded.split('/*').length - 1, 1);
        assert.strictEqual(encoded.split('*/').length - 1, 1);
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
            () => encodeSourceComment('message', 'css', { annotationId: 'id', style: 'line' }),
            /does not support line comments/
        );
    });
});
