import * as assert from 'assert';
import type { DocAnnotation } from '../../../docs/AnnotationDocGenerator';
import { generateStaticHtmlDocumentation, STATIC_HTML_STYLES } from '../../../docs/StaticHtmlDocumentation';

function makeAnnotation(overrides: Partial<DocAnnotation> = {}): DocAnnotation {
    return {
        id: 'ann-1',
        file: 'src/account.ts',
        line: 4,
        state: 'active',
        message: '# Validate account\n\nReject an invalid account.',
        timestamp: '2026-07-13T12:00:00.000Z',
        tags: ['security'],
        severity: 'warning',
        ...overrides,
    };
}

function annotationPage(result: ReturnType<typeof generateStaticHtmlDocumentation>, id: string): string {
    const entry = [...result.files.entries()].find(
        ([path, content]) => path.startsWith('annotations/') && content.includes(`<dd>${id}</dd>`)
    );
    assert.ok(entry, `page for ${id}`);
    return entry[1];
}

function technicalPage(
    result: ReturnType<typeof generateStaticHtmlDocumentation>,
    sourcePath: string
): [string, string] {
    const entry = [...result.files.entries()].find(
        ([path, content]) => path.startsWith('documents/') && content.includes(`>${sourcePath}</p>`)
    );
    assert.ok(entry, `technical page for ${sourcePath}`);
    return entry;
}

suite('StaticHtmlDocumentation', () => {
    test('emits an accessible, autonomous index, local stylesheet, and one page per annotation', () => {
        const result = generateStaticHtmlDocumentation([makeAnnotation()], {
            title: 'Engineering annotations',
            lang: 'en-CA',
        });
        const paths = [...result.files.keys()].sort();
        assert.strictEqual(paths.length, 3);
        assert.ok(paths.includes('index.html'));
        assert.ok(paths.includes('styles.css'));
        assert.ok(paths.some((path) => /^annotations\/[A-Za-z0-9_-]+\.html$/.test(path)));

        const index = result.files.get('index.html') ?? '';
        assert.ok(index.startsWith('<!doctype html>'));
        assert.ok(index.includes('<html lang="en-CA">'));
        assert.ok(index.includes('<title>Engineering annotations</title>'));
        assert.ok(index.includes('class="skip-link" href="#main-content"'));
        assert.ok(index.includes('<header class="site-header">'));
        assert.ok(index.includes('<nav aria-label="Primary documentation">'));
        assert.ok(index.includes('<main id="main-content" tabindex="-1">'));
        assert.ok(index.includes('<footer class="site-footer">'));

        const csp = index.indexOf('http-equiv="Content-Security-Policy"');
        const stylesheet = index.indexOf('<link rel="stylesheet"');
        assert.ok(csp >= 0 && csp < stylesheet, 'CSP must precede the local resource');
        assert.ok(!index.includes('<script'));
        assert.ok(!index.includes('style='));
        assert.ok(!/\son[a-z]+=/i.test(index), 'no inline event handlers');
        assert.strictEqual(result.files.get('styles.css'), STATIC_HTML_STYLES);
        assert.ok(STATIC_HTML_STYLES.includes(':focus-visible'));
        assert.ok(STATIC_HTML_STYLES.includes('prefers-reduced-motion'));
    });

    test('escapes hostile annotation content instead of interpreting Markdown or HTML', () => {
        const hostile = `<script>alert('x')</script> & <img src=x onerror=alert(1)>`;
        const result = generateStaticHtmlDocumentation([
            makeAnnotation({
                id: 'hostile',
                message: hostile,
                snippet: { code: '</code><script>x</script>', language: 'html' },
            }),
        ]);
        const combined = [...result.files.values()].join('\n');
        assert.ok(!combined.includes('<script>alert'));
        assert.ok(!combined.includes('<img src='));
        assert.ok(!/<[^>]+\sonerror=/i.test(combined), 'hostile text must not become an event handler');
        assert.ok(combined.includes('&lt;script&gt;'));
        assert.ok(combined.includes('&lt;/code&gt;&lt;script&gt;'));
    });

    test('links related annotations to their generated pages and diagnoses missing targets', () => {
        const target = makeAnnotation({ id: 'target', file: 'src/target.ts', line: 8, message: 'Target' });
        const source = makeAnnotation({
            id: 'source',
            linkedAnnotations: [
                { targetFile: 'src/target.ts', targetLine: 8, relationship: 'implements' },
                { targetFile: 'src/missing.ts', targetLine: 2, relationship: 'references' },
            ],
        });
        const result = generateStaticHtmlDocumentation([source, target]);
        const sourceHtml = annotationPage(result, 'source');
        assert.match(sourceHtml, /<a href="\.\.\/annotations\/target-[a-f0-9]{8}\.html">implements:/);
        assert.ok(sourceHtml.includes('references: src/missing.ts:3'));
        assert.ok(
            result.diagnostics.some(
                (diagnostic) =>
                    diagnostic.code === 'unresolved-related-annotation' && diagnostic.annotationId === 'source'
            )
        );
    });

    test('projects technical Markdown as accessible pages linked from the index with safe local links', () => {
        const technicalDocuments = new Map([
            [
                'README.md',
                `# Team handbook

Read the [architecture](technical/architecture.md#components) and never run [unsafe](javascript:alert(1)).

- Install dependencies
- Run the tests

<script>alert('authored HTML')</script>

\`inline <value>\`
`,
            ],
            [
                'technical/architecture.md',
                `# Architecture

## Components

| Area | Owner |
| --- | --- |
| API | Platform |

\`\`\`ts
const value = '<safe>';
\`\`\`
`,
            ],
        ]);
        const result = generateStaticHtmlDocumentation([makeAnnotation()], { technicalDocuments });
        const [readmePath, readme] = technicalPage(result, 'README.md');
        const [architecturePath, architecture] = technicalPage(result, 'technical/architecture.md');
        const architectureFile = architecturePath.slice('documents/'.length);
        const index = result.files.get('index.html') ?? '';

        assert.match(readmePath, /^documents\/[A-Za-z0-9_-]+-[a-f0-9]{8}\.html$/);
        assert.ok(index.includes('Technical documents'));
        assert.ok(index.includes(`href="${readmePath}"`));
        assert.ok(index.includes(`href="${architecturePath}"`));
        assert.ok(readme.includes('<article class="technical-document">'));
        assert.ok(readme.includes('class="skip-link" href="#main-content"'));
        assert.ok(readme.includes(`href="${architectureFile}#components"`));
        assert.ok(!readme.includes('href="javascript:'));
        assert.ok(readme.includes('<span class="unresolved-link">unsafe</span>'));
        assert.ok(readme.includes('&lt;script&gt;alert'));
        assert.ok(!readme.includes("<script>alert('authored HTML')</script>"));
        assert.ok(readme.includes('<ul><li>Install dependencies</li><li>Run the tests</li></ul>'));
        assert.ok(readme.includes('<code>inline &lt;value&gt;</code>'));
        assert.ok(architecture.includes('<h3 id="components">Components</h3>'));
        assert.ok(architecture.includes('<table><thead>'));
        assert.ok(
            architecture.includes('<pre><code class="language-ts">const value = &#39;&lt;safe&gt;&#39;;</code></pre>')
        );
        assert.ok(![...result.files.keys()].some((path) => path.includes('..') || path.includes('\\')));
    });

    test('rejects unsafe document paths and handles case-colliding paths deterministically', () => {
        const documents = [
            ['../escape.md', '# Escape'],
            ['/absolute.md', '# Absolute'],
            ['C:\\outside.md', '# Drive'],
            ['README.md', '# Upper'],
            ['readme.md', '# Lower'],
        ] as const;
        const forward = generateStaticHtmlDocumentation([], {
            technicalDocuments: new Map(documents),
        });
        const reverse = generateStaticHtmlDocumentation([], {
            technicalDocuments: new Map([...documents].reverse()),
        });

        assert.deepStrictEqual([...forward.files.entries()], [...reverse.files.entries()]);
        assert.deepStrictEqual(forward.diagnostics, reverse.diagnostics);
        const documentPaths = [...forward.files.keys()].filter((path) => path.startsWith('documents/'));
        assert.strictEqual(documentPaths.length, 2);
        assert.strictEqual(new Set(documentPaths).size, 2);
        assert.ok(documentPaths.every((path) => /^documents\/[A-Za-z0-9_-]+-[a-f0-9]{8}\.html$/.test(path)));
        assert.strictEqual(
            forward.diagnostics.filter((diagnostic) => diagnostic.code === 'invalid-technical-document-path').length,
            3
        );
        assert.ok(forward.diagnostics.some((diagnostic) => diagnostic.code === 'ambiguous-technical-document-path'));
    });

    test('escapes the remainder of an unterminated technical code fence and reports it', () => {
        const result = generateStaticHtmlDocumentation([], {
            technicalDocuments: new Map([['runbook.md', '# Runbook\n\n```html\n<img src=x onerror=alert(1)>']]),
        });
        const [, page] = technicalPage(result, 'runbook.md');
        assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(!page.includes('<img src='));
        assert.ok(
            result.diagnostics.some((diagnostic) => diagnostic.code === 'unterminated-technical-document-code-fence')
        );
    });

    test('is deterministic across input order and uses a safe language fallback', () => {
        const first = makeAnnotation({ id: 'b', file: 'b.ts', line: 1 });
        const second = makeAnnotation({ id: 'a', file: 'a.ts', line: 2 });
        const forward = generateStaticHtmlDocumentation([first, second], { lang: 'bad language' });
        const reverse = generateStaticHtmlDocumentation([second, first], { lang: 'bad language' });
        assert.deepStrictEqual([...forward.files.entries()], [...reverse.files.entries()]);
        assert.deepStrictEqual(forward.diagnostics, reverse.diagnostics);
        assert.ok((forward.files.get('index.html') ?? '').includes('<html lang="en">'));
        assert.ok(forward.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-language'));
    });

    test('gives duplicate ids distinct traversal-free page names', () => {
        const result = generateStaticHtmlDocumentation([
            makeAnnotation({ id: '../../same', file: 'a.ts' }),
            makeAnnotation({ id: '../../same', file: 'b.ts' }),
        ]);
        const pages = [...result.files.keys()].filter((path) => path.startsWith('annotations/'));
        assert.strictEqual(new Set(pages).size, 2);
        assert.ok(pages.every((path) => !path.includes('..') && !path.includes('\\')));
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-annotation-id'));
    });
});
