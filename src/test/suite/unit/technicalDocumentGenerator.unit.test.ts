import * as assert from 'assert';
import type { DocAnnotation } from '../../../docs/AnnotationDocGenerator';
import { generateTechnicalDocuments, type TechnicalDocumentKind } from '../../../docs/TechnicalDocumentGenerator';

function annotation(overrides: Partial<DocAnnotation> = {}): DocAnnotation {
    return {
        id: 'ann-1',
        file: 'src/example.ts',
        line: 4,
        state: 'active',
        message: '# Example\n\nAuthored detail.',
        timestamp: '2026-07-13T12:00:00.000Z',
        tags: [],
        ...overrides,
    };
}

function paths(result: ReturnType<typeof generateTechnicalDocuments>): string[] {
    return [...result.files.keys()];
}

function diagnosticCodes(result: ReturnType<typeof generateTechnicalDocuments>): string[] {
    return result.diagnostics.map((diagnostic) => diagnostic.code);
}

suite('TechnicalDocumentGenerator — complete technical set', () => {
    test('generates repository documents solely from explicit roles and metadata', () => {
        const result = generateTechnicalDocuments([
            annotation({
                id: 'overview',
                file: 'notes/overview.md',
                line: 0,
                message: '# Example workspace\n\nUse the documented commands.',
                tags: ['doc:readme'],
            }),
            annotation({
                id: 'arch',
                file: 'src/architecture.ts',
                line: 2,
                message: '# Request boundary\n\n# Constraints\n\nOnly the annotated boundary is documented.',
                tags: ['doc:architecture'],
            }),
            annotation({
                id: 'join',
                file: 'docs/setup.md',
                message: '# Local setup\n\nRun the checked-in setup task.',
                tags: ['doc:onboarding'],
            }),
            annotation({
                id: 'recover',
                file: 'ops/recovery.md',
                message: '# Recover a worker\n\nFollow the annotated recovery sequence.',
                tags: ['doc:runbook'],
            }),
            annotation({
                id: 'service',
                file: 'src/service.ts',
                line: 9,
                message: '# Service\n\nCoordinates the annotated operation.',
                tags: ['doc:class'],
                snippet: { code: 'export class Service {}', language: 'typescript' },
            }),
            annotation({
                id: 'decision',
                file: 'src/storage.ts',
                message: '# Choose local storage\n\n## Context\n\nThe annotation records the trade-off.',
                tags: ['doc:adr', 'adr:status:accepted'],
            }),
            annotation({
                id: 'change',
                file: 'src/service.ts',
                message: '# Add retry policy\n\nRetries are now bounded.',
                tags: ['doc:changelog', 'release:1.2.0', 'release-date:2026-07-13', 'added'],
            }),
            annotation({
                id: 'security-change',
                file: 'src/auth.ts',
                message: '# Reject unsafe tokens',
                tags: ['doc:changelog', 'version:1.2.0', 'security'],
            }),
        ]);

        assert.deepStrictEqual(paths(result), [
            'CHANGELOG.md',
            'README.md',
            'technical/adr/README.md',
            'technical/adr/choose-local-storage.md',
            'technical/architecture.md',
            'technical/onboarding.md',
            'technical/reference.md',
            'technical/runbook.md',
        ]);

        const readme = result.files.get('README.md') ?? '';
        assert.ok(readme.startsWith('# Example workspace'));
        assert.ok(readme.includes('[Architecture](<technical/architecture.md>)'));
        assert.ok(readme.includes('[Architecture decision records](<technical/adr/README.md>)'));

        const architecture = result.files.get('technical/architecture.md') ?? '';
        assert.ok(architecture.includes('## Request boundary'));
        assert.ok(architecture.includes('### Constraints'), 'authored headings stay below their generated section');
        assert.ok(architecture.includes('[src/architecture.ts:3](<../src/architecture.ts#L3>)'));

        const reference = result.files.get('technical/reference.md') ?? '';
        assert.ok(reference.includes('Role: `class`'));
        assert.ok(reference.includes('```typescript\nexport class Service {}\n```'));

        const adrIndex = result.files.get('technical/adr/README.md') ?? '';
        assert.ok(adrIndex.includes('[Choose local storage](<choose-local-storage.md>)'));
        assert.ok(adrIndex.includes('| accepted |'));
        const adr = result.files.get('technical/adr/choose-local-storage.md') ?? '';
        assert.ok(adr.includes('[Architecture decision records](<README.md>)'));
        assert.ok(adr.includes('### Context'));
        assert.ok(adr.includes('[src/storage.ts:5](<../../src/storage.ts#L5>)'));

        const changelog = result.files.get('CHANGELOG.md') ?? '';
        assert.ok(changelog.includes('## [1.2.0] - 2026-07-13'));
        assert.ok(changelog.includes('### Added'));
        assert.ok(changelog.includes('### Security'));
        assert.ok(changelog.includes('Add retry policy — Retries are now bounded.'));
        assert.ok(!/docfx|docusaurus|mkdocs/i.test([...result.files.values()].join('\n')));
    });

    test('supports selecting document kinds without emitting implicit dependencies', () => {
        const kinds: TechnicalDocumentKind[] = ['architecture', 'adr'];
        const result = generateTechnicalDocuments(
            [
                annotation({ id: 'a', tags: ['doc:architecture'] }),
                annotation({ id: 'd', message: '# A decision', tags: ['doc:adr'] }),
            ],
            { kinds }
        );
        assert.deepStrictEqual(paths(result), [
            'technical/adr/README.md',
            'technical/adr/a-decision.md',
            'technical/architecture.md',
        ]);
        assert.ok(!result.files.has('README.md'));
        assert.ok(!result.files.has('CHANGELOG.md'));
    });

    test('an empty kind selection is a valid no-op', () => {
        const result = generateTechnicalDocuments([annotation({ tags: ['doc:readme'] })], { kinds: [] });
        assert.deepStrictEqual(paths(result), []);
        assert.deepStrictEqual(result.diagnostics, []);
    });
});

suite('TechnicalDocumentGenerator — changelog semantics', () => {
    test('does not infer releases, routes, categories, or dates from prose and timestamps', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({ id: 'prose', message: 'GET /users changed in release 9.9.9', tags: [] }),
                annotation({ id: 'missing-version', message: '# Not assigned', tags: ['doc:changelog', 'fixed'] }),
                annotation({
                    id: 'missing-category',
                    message: '# Not categorized',
                    tags: ['doc:changelog', 'release:2.0.0'],
                }),
                annotation({
                    id: 'valid',
                    message: '# Explicit fix',
                    tags: ['doc:changelog', 'version:1.0.0', 'fixed'],
                    timestamp: '2099-01-01T00:00:00.000Z',
                }),
            ],
            { kinds: ['changelog'] }
        );
        const changelog = result.files.get('CHANGELOG.md') ?? '';
        assert.ok(changelog.includes('## [1.0.0]'));
        assert.ok(!changelog.includes('2099-01-01'), 'annotation timestamps are not represented as release dates');
        assert.ok(!changelog.includes('/users'));
        assert.ok(!changelog.includes('Not assigned'));
        assert.ok(!changelog.includes('Not categorized'));
        assert.ok(diagnosticCodes(result).includes('missing-changelog-version'));
        assert.ok(diagnosticCodes(result).includes('missing-changelog-category'));
    });

    test('orders semantic versions and standard sections deterministically', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({
                    id: 'old',
                    message: '# Old fix',
                    tags: ['doc:changelog', 'release:1.9.0', 'fixed'],
                }),
                annotation({
                    id: 'new',
                    message: '# New feature',
                    tags: ['doc:changelog', 'release:1.10.0', 'added'],
                }),
                annotation({
                    id: 'preview',
                    message: '# Preview',
                    tags: ['doc:changelog', 'release:2.0.0-beta.1', 'changed'],
                }),
                annotation({
                    id: 'future',
                    message: '# Pending',
                    tags: ['doc:changelog', 'release:Unreleased', 'deprecated'],
                }),
            ],
            { kinds: ['changelog'] }
        );
        const changelog = result.files.get('CHANGELOG.md') ?? '';
        assert.ok(changelog.indexOf('## [Unreleased]') < changelog.indexOf('## [2.0.0-beta.1]'));
        assert.ok(changelog.indexOf('## [2.0.0-beta.1]') < changelog.indexOf('## [1.10.0]'));
        assert.ok(changelog.indexOf('## [1.10.0]') < changelog.indexOf('## [1.9.0]'));
    });

    test('rejects ambiguous/unsafe versions and never guesses conflicting release dates', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({
                    id: 'ambiguous',
                    message: '# Ambiguous',
                    tags: ['doc:changelog', 'release:1.0.0', 'version:2.0.0', 'fixed'],
                }),
                annotation({
                    id: 'unsafe',
                    message: '# Unsafe',
                    tags: ['doc:changelog', 'release:1.0.0]', 'fixed'],
                }),
                annotation({
                    id: 'date-a',
                    message: '# First date',
                    tags: ['doc:changelog', 'release:3.0.0', 'release-date:2026-01-01', 'added'],
                }),
                annotation({
                    id: 'date-b',
                    message: '# Second date',
                    tags: ['doc:changelog', 'release:3.0.0', 'release-date:2026-02-30', 'changed'],
                }),
                annotation({
                    id: 'date-c',
                    message: '# Conflicting date',
                    tags: ['doc:changelog', 'release:3.0.0', 'release-date:2026-01-02', 'security'],
                }),
            ],
            { kinds: ['changelog'] }
        );
        const changelog = result.files.get('CHANGELOG.md') ?? '';
        assert.ok(changelog.includes('## [3.0.0]'));
        assert.ok(!changelog.includes('## [3.0.0] -'), 'conflicting explicit dates are omitted');
        assert.ok(!changelog.includes('Ambiguous'));
        assert.ok(!changelog.includes('Unsafe'));
        assert.ok(diagnosticCodes(result).includes('ambiguous-changelog-version'));
        assert.ok(diagnosticCodes(result).includes('invalid-changelog-version'));
        assert.ok(diagnosticCodes(result).includes('invalid-release-date'));
        assert.ok(diagnosticCodes(result).includes('conflicting-release-dates'));
    });
});

suite('TechnicalDocumentGenerator — safe deterministic Markdown', () => {
    test('uses safe relative links at each output depth and percent-encodes source names', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({
                    id: 'root',
                    file: 'docs/project overview.md',
                    tags: ['doc:readme'],
                    message: '# Workspace',
                }),
                annotation({
                    id: 'arch',
                    file: 'src/request #1.ts',
                    tags: ['doc:architecture'],
                    message: '# Boundary',
                }),
                annotation({
                    id: 'adr',
                    file: 'src/decision (final).ts',
                    tags: ['doc:adr'],
                    message: '# Keep the boundary',
                }),
            ],
            { sourceRootDepth: 2 }
        );
        assert.ok(
            (result.files.get('README.md') ?? '').includes(
                '[docs/project overview.md:5](<../../docs/project%20overview.md#L5>)'
            )
        );
        assert.ok(
            (result.files.get('technical/architecture.md') ?? '').includes(
                '[src/request \\#1.ts:5](<../../../src/request%20%231.ts#L5>)'
            )
        );
        assert.ok(
            (result.files.get('technical/adr/keep-the-boundary.md') ?? '').includes(
                '[src/decision (final).ts:5](<../../../../src/decision%20%28final%29.ts#L5>)'
            )
        );
    });

    test('never turns an unsafe annotation path into a link or output path', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({
                    id: 'escape',
                    file: '../private/secrets.md',
                    tags: ['doc:architecture'],
                    message: '# [Boundary](bad) | <script>',
                }),
            ],
            { kinds: ['architecture'] }
        );
        const page = result.files.get('technical/architecture.md') ?? '';
        assert.ok(page.includes('## \\[Boundary\\](bad) \\| \\<script\\>'));
        assert.ok(page.includes('`../private/secrets.md:5`'));
        assert.ok(!page.includes('](<../../private'));
        assert.deepStrictEqual(paths(result), ['technical/architecture.md']);
        assert.ok(diagnosticCodes(result).includes('unsafe-source-path'));
    });

    test('protects fenced code and display math while nesting authored headings', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({
                    tags: ['doc:runbook'],
                    message: '# Recovery\n\n# Step\n\n```md\n# code heading\n```\n\n$$\n# math\n$$',
                }),
            ],
            { kinds: ['runbook'] }
        );
        const page = result.files.get('technical/runbook.md') ?? '';
        assert.ok(page.includes('### Step'));
        assert.ok(page.includes('```md\n# code heading\n```'));
        assert.ok(page.includes('$$\n# math\n$$'));
    });

    test('resolves ADR slug collisions without overwriting either decision', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({ id: 'first', file: 'a.ts', message: '# Same decision', tags: ['doc:adr'] }),
                annotation({ id: 'second', file: 'b.ts', message: '# Same decision', tags: ['doc:adr'] }),
            ],
            { kinds: ['adr'] }
        );
        const pages = paths(result).filter((path) => path !== 'technical/adr/README.md');
        assert.strictEqual(pages.length, 2);
        assert.ok(pages.includes('technical/adr/same-decision.md'));
        assert.ok(pages.some((path) => /^technical\/adr\/same-decision-[0-9a-f]{8}\.md$/.test(path)));
        assert.strictEqual(new Set(pages).size, 2);
        assert.ok(diagnosticCodes(result).includes('adr-slug-collision'));
        const index = result.files.get('technical/adr/README.md') ?? '';
        assert.strictEqual(index.split('Same decision').length - 1, 2);
    });

    test('is invariant to annotation order, including diagnostics', () => {
        const input = [
            annotation({ id: 'z', file: 'z.ts', message: '# Duplicate', tags: ['doc:adr'] }),
            annotation({ id: 'a', file: '../a.ts', message: '# Duplicate', tags: ['doc:adr'] }),
            annotation({
                id: 'change',
                file: 'c.ts',
                message: '# Fix',
                tags: ['doc:changelog', 'release:1.0.0', 'fixed'],
            }),
        ];
        const forward = generateTechnicalDocuments(input);
        const reverse = generateTechnicalDocuments([...input].reverse());
        assert.deepStrictEqual([...forward.files], [...reverse.files]);
        assert.deepStrictEqual(forward.diagnostics, reverse.diagnostics);
    });

    test('supports a custom role prefix without accepting the default prefix', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({ id: 'custom', message: '# Custom architecture', tags: ['kb/architecture'] }),
                annotation({ id: 'default', message: '# Default architecture', tags: ['doc:architecture'] }),
            ],
            { kinds: ['architecture'], tagPrefix: 'kb/' }
        );
        const page = result.files.get('technical/architecture.md') ?? '';
        assert.ok(page.includes('Custom architecture'));
        assert.ok(!page.includes('Default architecture'));
    });

    test('reports duplicate ids, invalid line metadata, and multiple reference roles without data loss', () => {
        const result = generateTechnicalDocuments(
            [
                annotation({
                    id: 'same',
                    file: 'a.ts',
                    line: Number.NaN,
                    message: '# First',
                    tags: ['doc:reference', 'doc:class'],
                }),
                annotation({ id: 'same', file: 'b.ts', message: '# Second', tags: ['doc:function'] }),
            ],
            { kinds: ['reference'] }
        );
        const page = result.files.get('technical/reference.md') ?? '';
        assert.ok(page.includes('### First'));
        assert.ok(page.includes('### Second'));
        assert.ok(diagnosticCodes(result).includes('duplicate-annotation-id'));
        assert.ok(diagnosticCodes(result).includes('invalid-source-line'));
        assert.ok(diagnosticCodes(result).includes('multiple-reference-roles'));
    });
});
