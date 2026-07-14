import * as assert from 'assert';
import type { DocAnnotation } from '../../../docs/AnnotationDocGenerator';
import { generateDocumentationStudio } from '../../../docs/DocumentationStudio';

function annotation(overrides: Partial<DocAnnotation> = {}): DocAnnotation {
    return {
        id: 'ann-1',
        file: 'src/service.ts',
        line: 4,
        state: 'active',
        message: '# Service\n\nDocuments the service.',
        timestamp: '2026-07-13T00:00:00.000Z',
        tags: ['doc:module'],
        ...overrides,
    };
}

suite('DocumentationStudio', () => {
    test('builds one deterministic multi-format managed bundle', () => {
        const options = {
            title: 'Engineering portal',
            language: 'fr-CA',
            formats: ['markdown', 'static-site', 'hosted-wiki', 'html', 'openapi'] as const,
            sourceRootDepth: 2,
            base: { generatedAt: '2026-07-13T00:00:00.000Z' },
        };
        const first = generateDocumentationStudio([annotation()], options);
        const second = generateDocumentationStudio([annotation()], options);
        assert.deepStrictEqual([...first.files], [...second.files]);
        for (const path of [
            'index.md',
            'site.config.json',
            'site.manifest.json',
            'site.navigation.json',
            'wiki/hosted/Home.md',
            'wiki/hosted/_Sidebar.md',
            'html/index.html',
            'html/styles.css',
            'openapi/openapi.json',
            'documentation-report.json',
        ]) {
            assert.ok(first.files.has(path), `${path} must be generated`);
        }
        const generatedText = [...first.files.values()].join('\n').toLowerCase();
        assert.ok(!generatedText.includes(`${'doc'}${'fx'}`), 'generated output stays engine-neutral');
        assert.strictEqual(first.entryPoint, 'index.md');
    });

    test('repairs source links after GitHub Wiki flattens API pages', () => {
        const result = generateDocumentationStudio([annotation({ tags: ['doc:class'] })], {
            title: 'Portal',
            language: 'en',
            formats: ['hosted-wiki'],
            sourceRootDepth: 2,
            base: {},
        });
        const apiPage = [...result.files.entries()].find(([name]) => name.startsWith('wiki/hosted/api-'));
        assert.ok(apiPage, 'flattened API page');
        assert.ok(apiPage[1].includes('<../../../../src/service.ts#L5>'));
        assert.ok(!apiPage[1].includes('<../../../../../src/service.ts#L5>'));
    });

    test('never infers OpenAPI routes from free-form annotation content', () => {
        const result = generateDocumentationStudio(
            [annotation({ message: 'GET /admin', tags: ['openapi:get:/admin'] })],
            {
                title: 'Portal',
                language: 'en',
                formats: ['openapi'],
                sourceRootDepth: 2,
                base: {},
            }
        );
        const document = JSON.parse(result.files.get('openapi/openapi.json') ?? '{}') as { paths: unknown };
        assert.deepStrictEqual(document.paths, {});
    });

    test('packages explicitly selected technical documents into shared outputs', () => {
        const result = generateDocumentationStudio(
            [
                annotation({ tags: ['doc:readme'], message: '# Team portal\n\nRepository overview.' }),
                annotation({
                    id: 'architecture',
                    tags: ['doc:architecture'],
                    message: '# Service boundary\n\nThe annotation describes the boundary.',
                }),
            ],
            {
                title: 'Portal',
                language: 'en',
                formats: ['markdown', 'hosted-wiki', 'html'],
                technicalDocuments: ['readme', 'architecture'],
                sourceRootDepth: 2,
                base: {},
            }
        );

        assert.ok((result.files.get('README.md') ?? '').includes('# Team portal'));
        assert.ok(result.files.has('technical/architecture.md'));
        assert.ok(
            [...result.files.entries()].some(
                ([path, content]) => path.startsWith('html/documents/') && content.includes('Service boundary')
            )
        );
        assert.ok(
            [...result.files.keys()].some(
                (path) => path.startsWith('wiki/hosted/') && path.toLowerCase().includes('architecture')
            )
        );
        assert.ok(
            (result.files.get('wiki/hosted/_Sidebar.md') ?? '').includes('Architecture'),
            'technical pages belong to wiki navigation'
        );
        assert.ok((result.files.get('toc.yml') ?? '').includes('technical/architecture.md'));
        const report = JSON.parse(result.files.get('documentation-report.json') ?? '{}') as {
            technicalDocuments?: string[];
        };
        assert.deepStrictEqual(report.technicalDocuments, ['architecture', 'readme']);
    });

    test('rejects technical-document path collisions instead of overwriting content', () => {
        assert.throws(
            () =>
                generateDocumentationStudio([annotation({ tags: ['doc:guide', 'doc:readme'] })], {
                    title: 'Portal',
                    language: 'en',
                    formats: ['markdown'],
                    technicalDocuments: ['readme'],
                    sourceRootDepth: 2,
                    base: { guideFile: 'README.md' },
                }),
            /Technical documents collide.*README\.md/
        );
    });
});
