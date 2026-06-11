/**
 * Pure-logic tests for the DocFX-compatible documentation generator.
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import {
    demoteHeadings,
    docRoleOf,
    extractTitle,
    fileSlug,
    generateDocSet,
    type DocAnnotation,
} from '../../../docs/AnnotationDocGenerator';

function makeAnn(overrides: Partial<DocAnnotation> = {}): DocAnnotation {
    return {
        id: 'id-1',
        file: 'src/foo.ts',
        line: 41,
        state: 'active',
        message: 'Validate the input before parsing',
        author: 'jacques',
        timestamp: '2026-06-11T10:00:00.000Z',
        tags: ['api'],
        severity: 'warning',
        ...overrides,
    };
}

suite('AnnotationDocGenerator — file set', () => {
    test('produces the five DocFX site files', () => {
        const files = generateDocSet([makeAnn()]);
        assert.deepStrictEqual([...files.keys()].sort(), [
            'by-file.md',
            'by-type.md',
            'index.md',
            'links.md',
            'toc.yml',
        ]);
    });

    test('toc.yml references every page', () => {
        const toc = generateDocSet([]).get('toc.yml') ?? '';
        for (const page of ['index.md', 'by-type.md', 'by-file.md', 'links.md']) {
            assert.ok(toc.includes(`href: ${page}`), `toc must reference ${page}`);
        }
    });

    test('is deterministic for the same input', () => {
        const anns = [makeAnn(), makeAnn({ id: 'id-2', file: 'src/bar.ts', line: 3, tags: ['todo'] })];
        const a = generateDocSet(anns, { generatedAt: '2026-06-11T00:00:00.000Z' });
        const b = generateDocSet(anns, { generatedAt: '2026-06-11T00:00:00.000Z' });
        assert.deepStrictEqual([...a.entries()], [...b.entries()]);
    });
});

suite('AnnotationDocGenerator — index.md', () => {
    test('counts by type, severity and file', () => {
        const index =
            generateDocSet([
                makeAnn(),
                makeAnn({ id: 'id-2', tags: ['api', 'decision'], severity: 'error' }),
                makeAnn({ id: 'id-3', file: 'src/bar.ts', tags: undefined }),
            ]).get('index.md') ?? '';
        assert.ok(index.includes('**3** annotation(s)'), 'total count');
        assert.ok(index.includes('| [api](by-type.md) | 2 |'), 'api tag counted twice');
        assert.ok(index.includes('| [decision](by-type.md) | 1 |'));
        assert.ok(index.includes('| [untagged](by-type.md) | 1 |'), 'untagged bucket');
        assert.ok(index.includes('| error | 1 |'));
        assert.ok(index.includes('| [src/bar.ts](by-file.md) | 1 |'));
    });

    test('reports suspended annotations as awaiting paste-back', () => {
        const index = generateDocSet([makeAnn({ state: 'suspended' })]).get('index.md') ?? '';
        assert.ok(index.includes('1 awaiting paste-back'));
    });
});

suite('AnnotationDocGenerator — by-file.md details', () => {
    test('renders anchor, source link with line fragment, facts and snippet', () => {
        const byFile =
            generateDocSet(
                [
                    makeAnn({
                        kanbanColumn: 'in-progress',
                        priority: 2,
                        snippet: { code: 'const x = 1;', language: 'typescript' },
                    }),
                ],
                { sourceLinkPrefix: '../../' }
            ).get('by-file.md') ?? '';
        assert.ok(byFile.includes('<a id="ann-id-1"></a>'), 'stable anchor for cross-links');
        assert.ok(byFile.includes('[src/foo.ts:42](<../../src/foo.ts#L42>)'), '1-based line link with prefix');
        assert.ok(byFile.includes('**Severity**: warning'));
        assert.ok(byFile.includes('**Type**: api'));
        assert.ok(byFile.includes('**Board**: in-progress'));
        assert.ok(byFile.includes('**Priority**: 2'));
        assert.ok(byFile.includes('```typescript\nconst x = 1;\n```'));
    });

    test('renders the discussion thread as a blockquote', () => {
        const byFile =
            generateDocSet([
                makeAnn({
                    thread: [{ message: 'agreed, fixing', author: 'alice', timestamp: '2026-06-11T11:00:00.000Z' }],
                }),
            ]).get('by-file.md') ?? '';
        assert.ok(byFile.includes('**Discussion**:'));
        assert.ok(byFile.includes('> alice — 2026-06-11T11:00:00.000Z'));
        assert.ok(byFile.includes('> agreed, fixing'));
    });

    test('unresolved line (-1) renders a link without a line fragment', () => {
        const byFile = generateDocSet([makeAnn({ line: -1 })], { sourceLinkPrefix: '' }).get('by-file.md') ?? '';
        assert.ok(byFile.includes('[src/foo.ts](<src/foo.ts>)'), 'no #L fragment when the line is unknown');
    });

    test('escapes pipes so messages cannot break tables', () => {
        const files = generateDocSet([makeAnn({ message: 'a | b' })]);
        const byType = files.get('by-type.md') ?? '';
        assert.ok(byType.includes('a \\| b'));
    });
});

suite('AnnotationDocGenerator — by-type.md and links.md', () => {
    test('an annotation with two tags appears under both type sections', () => {
        const byType = generateDocSet([makeAnn({ tags: ['api', 'decision'] })]).get('by-type.md') ?? '';
        assert.ok(byType.includes('## api'));
        assert.ok(byType.includes('## decision'));
        const occurrences = byType.split('by-file.md#ann-id-1').length - 1;
        assert.strictEqual(occurrences, 2, 'cross-link rendered once per type section');
    });

    test('resolved annotations display the resolved state', () => {
        const byType = generateDocSet([makeAnn({ resolved: true })]).get('by-type.md') ?? '';
        assert.ok(byType.includes('| resolved |'));
    });

    test('links.md lists relationships with deep links back to the annotation', () => {
        const links =
            generateDocSet(
                [
                    makeAnn({
                        linkedAnnotations: [{ targetFile: 'src/bar.ts', targetLine: 9, relationship: 'implements' }],
                    }),
                ],
                { sourceLinkPrefix: '../' }
            ).get('links.md') ?? '';
        assert.ok(links.includes('| [Validate the input before parsing](by-file.md#ann-id-1) | implements |'));
        assert.ok(links.includes('[src/bar.ts:10](<../src/bar.ts#L10>)'), 'target rendered 1-based with prefix');
    });

    test('links.md degrades gracefully when nothing is linked', () => {
        const links = generateDocSet([makeAnn()]).get('links.md') ?? '';
        assert.ok(links.includes('_No linked annotations._'));
    });
});

suite('AnnotationDocGenerator — doc:* role parsing and helpers', () => {
    test('docRoleOf recognizes roles case-insensitively, doc:method aliases doc:function', () => {
        assert.strictEqual(docRoleOf({ tags: ['doc:module'] }), 'module');
        assert.strictEqual(docRoleOf({ tags: ['Doc:Class'] }), 'class');
        assert.strictEqual(docRoleOf({ tags: ['doc:method'] }), 'function');
        assert.strictEqual(docRoleOf({ tags: ['api', 'doc:example'] }), 'example');
        assert.strictEqual(docRoleOf({ tags: ['api'] }), null);
        assert.strictEqual(docRoleOf({ tags: undefined }), null);
    });

    test('extractTitle prefers a leading heading and strips it from the body', () => {
        const r = extractTitle('# UserService\n\nManages accounts.');
        assert.strictEqual(r.title, 'UserService');
        assert.strictEqual(r.body, 'Manages accounts.');
    });

    test('extractTitle falls back to the first line', () => {
        const r = extractTitle('UserService\nManages accounts.');
        assert.strictEqual(r.title, 'UserService');
        assert.strictEqual(r.body, 'Manages accounts.');
    });

    test('demoteHeadings shifts headings but never past h6 and skips fenced code', () => {
        const input = '# T\n```md\n# code heading\n```\n###### deep';
        const out = demoteHeadings(input, 2);
        assert.ok(out.includes('### T'));
        assert.ok(out.includes('# code heading'), 'fenced content untouched');
        assert.ok(out.includes('###### deep'), 'h6 stays h6');
    });

    test('fileSlug produces url-safe page names', () => {
        assert.strictEqual(fileSlug('src/managers/Foo.Bar.ts'), 'src-managers-Foo-Bar-ts');
    });
});

suite('AnnotationDocGenerator — authored documentation (doc:* tags)', () => {
    function docSet(): DocAnnotation[] {
        return [
            makeAnn({
                id: 'mod',
                file: 'src/user.ts',
                line: 0,
                tags: ['doc:module'],
                message: '# User module\n\nEverything about users. See [[UserService]].',
            }),
            makeAnn({
                id: 'cls',
                file: 'src/user.ts',
                line: 4,
                tags: ['doc:class'],
                message: '# UserService\n\nManages user accounts.\n\n# Notes\n\nThread-safe.',
                anchorText: 'export class UserService {',
                language: 'typescript',
            }),
            makeAnn({
                id: 'fn',
                file: 'src/user.ts',
                line: 9,
                tags: ['doc:function'],
                message: '# createUser\n\nCreates a user. See [[Creating users]].',
                anchorText: '    async createUser(name: string): Promise<User> {',
                language: 'typescript',
            }),
            makeAnn({
                id: 'ex',
                file: 'src/user.ts',
                line: 10,
                tags: ['doc:example'],
                message: '# Basic usage\n\nCall it like this:',
                snippet: { code: "await svc.createUser('ada');", language: 'typescript' },
            }),
            makeAnn({
                id: 'guide',
                file: 'docs-notes.md',
                line: 0,
                tags: ['doc:guide'],
                message: '# Creating users\n\nStep by step. Back to [[UserService]].',
            }),
        ];
    }

    test('produces an api page per documented file plus guide.md, all referenced by toc.yml', () => {
        const files = generateDocSet(docSet());
        assert.ok(files.has('api/src-user-ts.md'), 'api page for src/user.ts');
        assert.ok(files.has('guide.md'));
        const toc = files.get('toc.yml') ?? '';
        assert.ok(toc.includes('- name: API'));
        assert.ok(toc.includes('href: api/src-user-ts.md'));
        assert.ok(toc.includes('- name: Guide'));
        assert.ok(toc.includes('href: guide.md'));
    });

    test('api page nests function under class and example under function, with signatures', () => {
        const api = generateDocSet(docSet()).get('api/src-user-ts.md') ?? '';
        assert.ok(api.startsWith('# User module'), 'module title heads the page');
        assert.ok(api.includes('## UserService'), 'class is h2');
        assert.ok(api.includes('### createUser'), 'member function is h3 under the class');
        assert.ok(api.includes('#### Example — Basic usage'), 'example is h4 under the function');
        assert.ok(api.includes('```typescript\nexport class UserService {\n```'), 'class signature');
        assert.ok(api.includes("await svc.createUser('ada');"), 'example snippet rendered');
        assert.ok(api.includes('### Notes'), 'authored h1 inside class body demoted below the class heading');
    });

    test('wiki-links resolve across pages and into guide.md', () => {
        const files = generateDocSet(docSet());
        const api = files.get('api/src-user-ts.md') ?? '';
        assert.ok(api.includes('[UserService](src-user-ts.md#ann-cls)'), 'module → class same-folder link');
        assert.ok(api.includes('[Creating users](../guide.md#ann-guide)'), 'api → guide crosses up one folder');
        const guide = files.get('guide.md') ?? '';
        assert.ok(guide.includes('[UserService](api/src-user-ts.md#ann-cls)'), 'guide → api link');
    });

    test('unresolved wiki-links are reported in the index warnings', () => {
        const anns = [makeAnn({ id: 'g', tags: ['doc:guide'], message: '# Lonely\n\nSee [[Does Not Exist]].' })];
        const files = generateDocSet(anns);
        const index = files.get('index.md') ?? '';
        assert.ok(index.includes('## Generation warnings'));
        assert.ok(index.includes('Unresolved wiki-link [[Does Not Exist]]'));
        const guide = files.get('guide.md') ?? '';
        assert.ok(guide.includes('[[Does Not Exist]]'), 'unresolved link kept verbatim');
    });

    test('orphan example and duplicate module produce warnings without losing content', () => {
        const anns = [
            makeAnn({ id: 'e1', file: 'a.ts', line: 1, tags: ['doc:example'], message: '# Floating example' }),
            makeAnn({ id: 'm1', file: 'a.ts', line: 3, tags: ['doc:module'], message: '# A' }),
            makeAnn({ id: 'm2', file: 'a.ts', line: 5, tags: ['doc:module'], message: '# B' }),
        ];
        const files = generateDocSet(anns);
        const api = files.get('api/a-ts.md') ?? '';
        assert.ok(api.includes('Example — Floating example'), 'orphan example still rendered');
        const index = files.get('index.md') ?? '';
        assert.ok(index.includes('doc:example without a preceding documented entity'));
        assert.ok(index.includes('Extra doc:module annotation ignored'));
    });

    test('without doc tags the site stays inventory-only with a tagging tip', () => {
        const files = generateDocSet([makeAnn()]);
        assert.deepStrictEqual([...files.keys()].sort(), [
            'by-file.md',
            'by-type.md',
            'index.md',
            'links.md',
            'toc.yml',
        ]);
        const index = files.get('index.md') ?? '';
        assert.ok(index.includes('Tip: tag annotations with `doc:module`'));
    });
});

suite('AnnotationDocGenerator — configurable output (no hardcoded layout)', () => {
    test('custom tagPrefix drives role detection and the index tip', () => {
        const files = generateDocSet(
            [makeAnn({ id: 'g', tags: ['note/guide'], message: '# Custom prefix guide\n\nBody.' })],
            { tagPrefix: 'note/' }
        );
        assert.ok(files.has('guide.md'), 'note/guide must be recognized as a guide role');
        const inventoryOnly = generateDocSet([makeAnn()], { tagPrefix: 'note/' }).get('index.md') ?? '';
        assert.ok(inventoryOnly.includes('`note/module`'), 'tip must reflect the configured prefix');
    });

    test('custom apiFolder and guideFile flow through pages, toc and wiki-links', () => {
        const files = generateDocSet(
            [
                makeAnn({
                    id: 'cls',
                    file: 'src/user.ts',
                    line: 1,
                    tags: ['doc:class'],
                    message: '# UserService\n\nSee [[HowTo]].',
                }),
                makeAnn({
                    id: 'g',
                    file: 'notes.md',
                    line: 0,
                    tags: ['doc:guide'],
                    message: '# HowTo\n\n[[UserService]]',
                }),
            ],
            { apiFolder: 'reference', guideFile: 'howto.md' }
        );
        assert.ok(files.has('reference/src-user-ts.md'), 'api page lands in the configured folder');
        assert.ok(files.has('howto.md'), 'guide page uses the configured file name');
        const toc = files.get('toc.yml') ?? '';
        assert.ok(toc.includes('href: reference/src-user-ts.md'));
        assert.ok(toc.includes('href: howto.md'));
        const api = files.get('reference/src-user-ts.md') ?? '';
        assert.ok(api.includes('[HowTo](../howto.md#ann-g)'), 'api → guide link crosses the configured folder');
        const guide = files.get('howto.md') ?? '';
        assert.ok(guide.includes('[UserService](reference/src-user-ts.md#ann-cls)'), 'guide → api link');
    });

    test('includeInventory=false drops inventory pages and their toc/index sections', () => {
        const files = generateDocSet([makeAnn({ tags: ['doc:guide'], message: '# G\n\nBody.' })], {
            includeInventory: false,
        });
        assert.deepStrictEqual([...files.keys()].sort(), ['guide.md', 'index.md', 'toc.yml']);
        const index = files.get('index.md') ?? '';
        assert.ok(!index.includes('## By type'), 'no inventory sections on the index');
        const toc = files.get('toc.yml') ?? '';
        assert.ok(!toc.includes('by-type.md'));
    });

    test('includeAuthored=false treats doc tags as plain inventory tags', () => {
        const files = generateDocSet([makeAnn({ tags: ['doc:class'], message: '# C\n\nBody.' })], {
            includeAuthored: false,
        });
        assert.deepStrictEqual([...files.keys()].sort(), [
            'by-file.md',
            'by-type.md',
            'index.md',
            'links.md',
            'toc.yml',
        ]);
        const index = files.get('index.md') ?? '';
        assert.ok(!index.includes('Tip: tag annotations'), 'no authored tip when authored output is disabled');
    });

    test('omitting generatedAt produces stamp-free, fully diffable pages', () => {
        const files = generateDocSet([makeAnn()]);
        for (const [name, content] of files) {
            if (name.endsWith('.md')) {
                assert.ok(!content.includes('Generated on'), `${name} must not carry a timestamp`);
            }
        }
    });

    test('custom untaggedLabel replaces the default bucket name', () => {
        const index =
            generateDocSet([makeAnn({ tags: undefined })], { untaggedLabel: 'sans-tag' }).get('index.md') ?? '';
        assert.ok(index.includes('| [sans-tag](by-type.md) | 1 |'));
        assert.ok(!index.includes('untagged'));
    });
});
