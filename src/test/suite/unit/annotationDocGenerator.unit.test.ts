/**
 * Pure-logic tests for the DocFX-compatible documentation generator.
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import { generateDocSet, type DocAnnotation } from '../../../docs/AnnotationDocGenerator';

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
