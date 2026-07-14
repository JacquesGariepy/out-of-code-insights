// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { createStaticSiteBundle, createWikiBundle, type DocumentationBundle } from '../../../docs/DocumentationBundles';

function sourceFiles(): Map<string, string> {
    return new Map([
        [
            'toc.yml',
            [
                '- name: Overview',
                '  href: index.md',
                '- name: API',
                '  items:',
                '      - name: Parser',
                '        href: api/parser.md',
                '- name: Guide',
                '  href: guide.md',
                '',
            ].join('\n'),
        ],
        [
            'index.md',
            ['# Annotation hub', '', 'Read the [parser](api/parser.md#parse) or the [guide](guide.md).', ''].join('\n'),
        ],
        [
            'api/parser.md',
            [
                '# Parser',
                '',
                '<a id="parse"></a>',
                '',
                'Return to [home](../index.md).',
                '',
                '![Logo](../images/logo.svg)',
                '',
            ].join('\n'),
        ],
        ['guide.md', '---\ntitle: "Start here"\n---\n\n# Guide\n\nSee [Parser](api/parser.md).\n'],
        ['images/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\r\n'],
    ]);
}

function diagnosticCodes(bundle: DocumentationBundle): string[] {
    return bundle.diagnostics.map((item) => item.code);
}

suite('DocumentationBundles - portable static site', () => {
    test('creates a complete deterministic engine-neutral project', () => {
        const first = createStaticSiteBundle(sourceFiles(), {
            title: 'Architecture notes',
            language: 'fr-CA',
            pageIdPrefix: 'team.docs',
            themePaths: ['themes/brand'],
        });
        const second = createStaticSiteBundle(sourceFiles(), {
            title: 'Architecture notes',
            language: 'fr-CA',
            pageIdPrefix: 'team.docs',
            themePaths: ['themes/brand'],
        });

        assert.deepStrictEqual([...first.files], [...second.files]);
        assert.deepStrictEqual(first.diagnostics, second.diagnostics);
        assert.ok(first.files.has('toc.yml'), 'the authored TOC is retained');
        assert.ok(first.files.has('images/logo.svg'), 'resources are retained');

        const configText = first.files.get('site.config.json') ?? '{}';
        const config = JSON.parse(configText) as {
            formatVersion: number;
            site: { language: string; title: string };
            build: {
                outputDirectory: string;
                themePaths: string[];
                content: string[];
                navigation: string;
                manifest: string;
            };
        };
        assert.strictEqual(config.formatVersion, 1);
        assert.strictEqual(config.build.outputDirectory, '_site');
        assert.deepStrictEqual(config.build.themePaths, ['themes/brand']);
        assert.strictEqual(config.site.language, 'fr-CA');
        assert.strictEqual(config.site.title, 'Architecture notes');
        assert.deepStrictEqual(config.build.content, ['**/*.md']);
        assert.strictEqual(config.build.navigation, 'site.navigation.json');
        assert.strictEqual(config.build.manifest, 'site.manifest.json');
        assert.ok(!configText.includes('$schema'), 'the portable configuration has no external schema URL');

        assert.strictEqual(first.files.get('index.md'), sourceFiles().get('index.md'), 'Markdown stays authored');
        const manifest = JSON.parse(first.files.get('site.manifest.json') ?? '{}') as {
            pages: { id: string; path: string; title: string }[];
            resources: string[];
        };
        assert.deepStrictEqual(manifest.pages[0], {
            id: 'team.docs.index',
            path: 'index.md',
            title: 'Annotation hub',
        });
        assert.deepStrictEqual(manifest.resources, ['images/logo.svg']);
        const navigation = JSON.parse(first.files.get('site.navigation.json') ?? '{}') as {
            items: { title: string; path?: string; depth: number }[];
        };
        assert.deepStrictEqual(navigation.items[1], { title: 'API', depth: 0 });
        assert.deepStrictEqual(navigation.items[2], { title: 'Parser', path: 'api/parser.md', depth: 1 });
    });

    test('resolves generated page-id collisions without changing Markdown', () => {
        const source = new Map([
            ['a b.md', '# Flat\n'],
            ['a/b.md', '# Nested\n'],
        ]);
        const bundle = createStaticSiteBundle(source);
        const manifest = JSON.parse(bundle.files.get('site.manifest.json') ?? '{}') as {
            pages: { id: string }[];
        };
        assert.strictEqual(new Set(manifest.pages.map((page) => page.id)).size, 2);
        assert.ok(diagnosticCodes(bundle).includes('duplicate-page-id'));
        assert.strictEqual(bundle.files.get('a b.md'), '# Flat\n');
        assert.strictEqual(bundle.files.get('a/b.md'), '# Nested\n');
    });

    test('reports missing TOC pages and rejects unsafe paths and options', () => {
        const source = sourceFiles();
        source.set('toc.yml', '- name: Missing\n  href: missing.md\n');
        source.set('../escape.md', '# Escape');
        source.set('C:\\escape.md', '# Escape');
        source.set('INDEX.md', '# Case collision');

        const bundle = createStaticSiteBundle(source, {
            language: '<script>',
            outputDirectory: '../site',
            themePaths: ['../../theme'],
        });
        const codes = diagnosticCodes(bundle);
        assert.ok(codes.includes('unsafe-path'));
        assert.ok(codes.includes('duplicate-path'));
        assert.ok(codes.includes('missing-toc-target'));
        assert.ok(codes.includes('invalid-language'));
        assert.ok(codes.includes('invalid-output-path'));
        assert.ok(codes.includes('invalid-theme-path'));
        assert.ok(!bundle.files.has('../escape.md'));
        assert.ok(!bundle.files.has('C:/escape.md'));
    });

    test('replaces generated metadata and omits obsolete engine configuration without naming it', () => {
        const source = sourceFiles();
        const obsoleteConfig = `${'doc'}${'fx'}.json`;
        source.set('Site.Config.json', '{"unsafe":true}');
        source.set(obsoleteConfig, '{"legacy":true}');
        const bundle = createStaticSiteBundle(source);
        assert.ok(diagnosticCodes(bundle).includes('generated-file-replaced'));
        assert.ok(diagnosticCodes(bundle).includes('legacy-static-config-ignored'));
        assert.ok(!(bundle.files.get('site.config.json') ?? '').includes('"unsafe"'));
        assert.ok(!bundle.files.has(obsoleteConfig));
        assert.ok(!JSON.stringify(bundle.diagnostics).toLowerCase().includes(`${'doc'}${'fx'}`));
    });
});

suite('DocumentationBundles - Wiki', () => {
    test('generic profile emits portable navigation and rewrites renamed-home links', () => {
        const bundle = createWikiBundle(sourceFiles(), { flavor: 'generic' });
        assert.ok(bundle.files.has('Home.md'));
        assert.ok(!bundle.files.has('index.md'));
        assert.ok(bundle.files.has('Navigation.md'));
        assert.ok(bundle.files.has('images/logo.svg'));
        assert.ok((bundle.files.get('Home.md') ?? '').includes('[parser](<api/parser.md#parse>)'));
        assert.ok((bundle.files.get('api/parser.md') ?? '').includes('[home](<../Home.md>)'));
        assert.ok(!(bundle.files.get('guide.md') ?? '').startsWith('---'), 'page metadata is removed');
        assert.ok((bundle.files.get('Navigation.md') ?? '').includes('- [Overview](<Home.md>)'));
        assert.ok((bundle.files.get('Navigation.md') ?? '').includes('  - [Parser](<api/parser.md>)'));
    });

    test('GitHub profile flattens nested pages and creates sidebar and escaped footer', () => {
        const bundle = createWikiBundle(sourceFiles(), {
            flavor: 'github',
            title: 'Team [Docs] <script>',
            footer: 'Built *safely* by the team',
        });
        assert.ok(bundle.files.has('api-parser.md'));
        assert.ok(!bundle.files.has('api/parser.md'));
        assert.ok(bundle.files.has('_Sidebar.md'));
        assert.ok(bundle.files.has('_Footer.md'));
        assert.ok((bundle.files.get('Home.md') ?? '').includes('[parser](<api-parser.md#parse>)'));
        assert.ok((bundle.files.get('api-parser.md') ?? '').includes('[home](<Home.md>)'));
        assert.ok((bundle.files.get('api-parser.md') ?? '').includes('![Logo](<images/logo.svg>)'));
        assert.ok((bundle.files.get('_Sidebar.md') ?? '').includes('[Parser](<api-parser.md>)'));
        assert.ok((bundle.files.get('_Sidebar.md') ?? '').startsWith('## Team \\[Docs\\] &lt;script&gt;'));
        assert.strictEqual(bundle.files.get('_Footer.md'), '_Built \\*safely\\* by the team_\n');
    });

    test('Azure profile preserves folders and emits ordered root and child manifests', () => {
        const bundle = createWikiBundle(sourceFiles(), { flavor: 'azure' });
        assert.ok(bundle.files.has('.order'));
        assert.ok(bundle.files.has('api/.order'));
        assert.deepStrictEqual((bundle.files.get('.order') ?? '').split('\n').filter(Boolean), [
            'Home',
            'api',
            'guide',
        ]);
        assert.strictEqual(bundle.files.get('api/.order'), 'parser\n');
        assert.ok(!bundle.files.has('Navigation.md'));
    });

    test('falls back to page-derived navigation and deterministically resolves Home collisions', () => {
        const source = new Map([
            ['Home.md', '# Existing home\n'],
            ['Guide.md', '# Guide\n'],
        ]);
        const first = createWikiBundle(source, { flavor: 'github' });
        const second = createWikiBundle(source, { flavor: 'github' });
        assert.deepStrictEqual([...first.files], [...second.files]);
        assert.ok(diagnosticCodes(first).includes('missing-toc'));
        assert.ok(diagnosticCodes(first).includes('missing-index'));
        assert.ok([...first.files.keys()].some((path) => /^Home-[a-f0-9]{8}\.md$/.test(path)));
    });

    test('reports an empty source instead of throwing', () => {
        const bundle = createWikiBundle(new Map(), { flavor: 'generic' });
        assert.ok(diagnosticCodes(bundle).includes('no-markdown-pages'));
        assert.ok(diagnosticCodes(bundle).includes('missing-toc'));
        assert.ok(bundle.files.has('Navigation.md'));
    });

    test('renames reserved adapter pages and replaces authored Azure order files explicitly', () => {
        const genericSource = sourceFiles();
        genericSource.set('navigation.md', '# Authored navigation\n');
        const generic = createWikiBundle(genericSource, { flavor: 'generic' });
        assert.ok(diagnosticCodes(generic).includes('wiki-path-collision'));
        assert.ok([...generic.files.keys()].some((path) => /^navigation-[a-f0-9]{8}\.md$/.test(path)));

        const azureSource = sourceFiles();
        azureSource.set('.ORDER', 'untrusted-order\n');
        const azure = createWikiBundle(azureSource, { flavor: 'azure' });
        assert.ok(diagnosticCodes(azure).includes('generated-file-replaced'));
        assert.ok(!(azure.files.get('.order') ?? '').includes('untrusted-order'));
    });

    test('relocates only known source links and leaves internal/code examples intact', () => {
        const source = new Map([
            [
                'index.md',
                '# Home\n\n[Source](<../../src/My%20File.ts#L4>)\n\n`[sample](<../../src/My%20File.ts#L4>)`\n',
            ],
            ['CHANGELOG.md', '# Changelog\n'],
            [
                'technical/adr/decision.md',
                '# Decision\n\n[Internal](<../../CHANGELOG.md>)\n\n[Source](<../../../../CHANGELOG.md#L1>)\n\n```md\n[example](<../../../../CHANGELOG.md#L1>)\n```\n',
            ],
            [
                'toc.yml',
                '- name: Home\n  href: index.md\n- name: Changelog\n  href: CHANGELOG.md\n- name: Decision\n  href: technical/adr/decision.md\n',
            ],
        ]);
        const bundle = createWikiBundle(source, {
            flavor: 'github',
            sourceRootDepth: 2,
            outputPathPrefixDepth: 1,
            sourceFiles: ['src/My File.ts', 'CHANGELOG.md'],
        });
        const home = bundle.files.get('Home.md') ?? '';
        assert.ok(home.includes('[Source](<../../../src/My%20File.ts#L4>)'));
        assert.ok(home.includes('`[sample](<../../src/My%20File.ts#L4>)`'));

        const decision = bundle.files.get('technical-adr-decision.md') ?? '';
        assert.ok(decision.includes('[Internal](<CHANGELOG.md>)'));
        assert.ok(decision.includes('[Source](<../../../CHANGELOG.md#L1>)'));
        assert.ok(decision.includes('[example](<../../../../CHANGELOG.md#L1>)'), 'fenced example stays authored');
    });
});
