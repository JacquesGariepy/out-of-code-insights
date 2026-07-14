import * as assert from 'assert';
import {
    createDocumentationManifest,
    normalizeDocumentationFiles,
    normalizeDocumentationPath,
    parseDocumentationManifest,
    serializeDocumentationManifest,
} from '../../../docs/DocumentationManifest';

suite('DocumentationManifest', () => {
    test('normalizes, sorts and fingerprints generated files deterministically', () => {
        const files = new Map([
            ['z\\page.md', 'last\r\n'],
            ['a.md', 'first\n'],
        ]);
        const normalized = normalizeDocumentationFiles(files);
        assert.deepStrictEqual([...normalized.keys()], ['a.md', 'z/page.md']);
        assert.strictEqual(normalized.get('z/page.md'), 'last\n');
        const manifest = createDocumentationManifest(normalized, {
            generatorVersion: '1.4.4',
            template: 'complete',
            formats: ['html', 'markdown', 'html'],
            generatedAt: '2026-07-13T00:00:00.000Z',
        });
        assert.deepStrictEqual(manifest.formats, ['html', 'markdown']);
        assert.deepStrictEqual(
            manifest.files.map((entry) => entry.path),
            ['a.md', 'z/page.md']
        );
        assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
        assert.deepStrictEqual(parseDocumentationManifest(serializeDocumentationManifest(manifest)), manifest);
    });

    test('rejects traversal, absolute paths and case-insensitive collisions', () => {
        for (const unsafe of ['', '../outside.md', 'a/../../b.md', '/root.md', 'C:/root.md', 'a//b.md']) {
            assert.throws(() => normalizeDocumentationPath(unsafe), /Unsafe/);
        }
        assert.throws(
            () =>
                normalizeDocumentationFiles(
                    new Map([
                        ['Guide.md', 'a'],
                        ['guide.md', 'b'],
                    ])
                ),
            /collision/
        );
        assert.throws(
            () =>
                normalizeDocumentationFiles(
                    new Map([
                        ['guide', 'file'],
                        ['guide/page.md', 'nested'],
                    ])
                ),
            /file ancestor/
        );
        for (const unsafe of ['CON.md', 'nested/NUL', 'page.md.', 'page.md ', 'bad\u0001name.md']) {
            assert.throws(() => normalizeDocumentationFiles(new Map([[unsafe, 'x']])), /Unsafe/);
        }
    });

    test('never trusts malformed manifests for stale-file deletion', () => {
        assert.strictEqual(parseDocumentationManifest('{broken'), undefined);
        assert.strictEqual(
            parseDocumentationManifest(
                JSON.stringify({
                    schemaVersion: 1,
                    generator: 'out-of-code-insights',
                    generatorVersion: '1',
                    template: 'x',
                    formats: ['markdown'],
                    files: [{ path: '../outside', sha256: 'a'.repeat(64), bytes: 1 }],
                })
            ),
            undefined
        );
    });
});
