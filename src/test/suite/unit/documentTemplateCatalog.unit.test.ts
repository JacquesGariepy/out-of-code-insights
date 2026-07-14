import * as assert from 'assert';
import {
    getBuiltInDocumentTemplate,
    listBuiltInDocumentTemplates,
    normalizeDocumentationFormat,
    parseCustomDocumentTemplate,
} from '../../../docs/DocumentTemplateCatalog';

suite('DocumentTemplateCatalog', () => {
    test('returns defensive copies of the built-in templates', () => {
        const first = getBuiltInDocumentTemplate('complete');
        assert.ok(first);
        first.formats.length = 0;
        assert.ok((getBuiltInDocumentTemplate('complete')?.formats.length ?? 0) > 0);
        assert.strictEqual(listBuiltInDocumentTemplates().length, 4);
    });

    test('parses a valid workspace template', () => {
        const parsed = parseCustomDocumentTemplate({
            $schema: 'https://example.test/document-template.schema.json',
            schemaVersion: 1,
            id: 'engineering.handbook',
            label: 'Engineering handbook',
            description: 'A portable handbook.',
            formats: ['markdown', 'hosted-wiki'],
            documents: ['readme', 'architecture'],
            includeInventory: true,
            includeAuthored: true,
            apiFolder: 'reference',
            guideFile: 'handbook.md',
            language: 'fr-CA',
        });
        assert.deepStrictEqual(parsed.formats, ['markdown', 'hosted-wiki']);
        assert.deepStrictEqual(parsed.documents, ['readme', 'architecture']);
        assert.strictEqual(parsed.language, 'fr-CA');
    });

    test('keeps legacy aliases only for settings migration and rejects them in new templates', () => {
        assert.strictEqual(normalizeDocumentationFormat('docfx'), 'static-site');
        assert.strictEqual(normalizeDocumentationFormat('github-wiki'), 'hosted-wiki');
        assert.strictEqual(normalizeDocumentationFormat('azure-wiki'), 'ordered-wiki');
        assert.strictEqual(normalizeDocumentationFormat('markdown'), 'markdown');
        assert.strictEqual(normalizeDocumentationFormat('pdf'), undefined);

        const template = {
            schemaVersion: 1,
            id: 'legacy',
            label: 'Legacy',
            description: 'Previous identifiers.',
            formats: ['docfx', 'github-wiki', 'azure-wiki'],
            documents: ['readme'],
            includeInventory: true,
            includeAuthored: true,
            apiFolder: 'api',
            guideFile: 'guide.md',
            language: 'en',
        };
        assert.throws(() => parseCustomDocumentTemplate(template), /Unsupported documentation format "docfx"/);
    });

    test('requires documents and rejects duplicates to match the JSON schema', () => {
        const valid = {
            schemaVersion: 1,
            id: 'custom',
            label: 'Custom',
            description: 'Custom template.',
            formats: ['markdown'],
            documents: ['readme'],
            includeInventory: true,
            includeAuthored: true,
            apiFolder: 'api',
            guideFile: 'guide.md',
            language: 'en',
        };
        const { documents: _documents, ...withoutDocuments } = valid;
        assert.throws(() => parseCustomDocumentTemplate(withoutDocuments), /documents must contain at least one/);
        assert.throws(
            () => parseCustomDocumentTemplate({ ...valid, formats: ['markdown', 'markdown'] }),
            /must not be repeated/
        );
        assert.throws(
            () => parseCustomDocumentTemplate({ ...valid, documents: ['readme', 'readme'] }),
            /must not be repeated/
        );
    });

    test('rejects traversal, unknown properties and unsupported formats', () => {
        const valid = {
            schemaVersion: 1,
            id: 'custom',
            label: 'Custom',
            description: 'Custom template.',
            formats: ['markdown'],
            documents: ['readme'],
            includeInventory: true,
            includeAuthored: true,
            apiFolder: 'api',
            guideFile: 'guide.md',
            language: 'en',
        };
        assert.throws(() => parseCustomDocumentTemplate({ ...valid, apiFolder: '../outside' }), /path segment/);
        assert.throws(() => parseCustomDocumentTemplate({ ...valid, typo: true }), /Unknown/);
        assert.throws(() => parseCustomDocumentTemplate({ ...valid, formats: ['pdf'] }), /Unsupported/);
        assert.throws(
            () => parseCustomDocumentTemplate({ ...valid, includeInventory: false, includeAuthored: false }),
            /must include/
        );
    });

    test('enforces portable non-hidden path segments and lowercase Markdown guide names', () => {
        const valid = {
            schemaVersion: 1,
            id: 'portable',
            label: 'Portable',
            description: 'Portable paths.',
            formats: ['markdown'],
            documents: ['readme'],
            includeInventory: true,
            includeAuthored: false,
            apiFolder: 'api.v2',
            guideFile: 'team guide.md',
            language: 'en',
        };
        assert.strictEqual(parseCustomDocumentTemplate(valid).apiFolder, 'api.v2');

        for (const apiFolder of [
            '.hidden',
            'CON',
            'com1.logs',
            'LPT¹',
            'folder.',
            ' folder',
            'bad/name',
            'bad\u0001name',
        ]) {
            assert.throws(
                () => parseCustomDocumentTemplate({ ...valid, apiFolder }),
                /portable, non-hidden path segment/,
                apiFolder
            );
        }
        for (const guideFile of ['nul.md', 'CONIN$.md', '.guide.md', 'guide.md ', 'GUIDE.MD', 'guide.txt']) {
            assert.throws(() => parseCustomDocumentTemplate({ ...valid, guideFile }));
        }
    });

    test('accepts the documented canonical language subset and rejects ambiguous tags', () => {
        const valid = {
            schemaVersion: 1,
            id: 'languages',
            label: 'Languages',
            description: 'Language profile.',
            formats: ['markdown'],
            documents: ['readme'],
            includeInventory: true,
            includeAuthored: false,
            apiFolder: 'api',
            guideFile: 'guide.md',
            language: 'en',
        };
        for (const language of ['en', 'fr-CA', 'zh-Hant', 'zh-Hant-TW', 'es-419']) {
            assert.strictEqual(parseCustomDocumentTemplate({ ...valid, language }).language, language);
        }
        for (const language of ['EN', 'fr-ca', 'english', 'en-US-extra', 'en-u-ca-gregory', ' fr-CA ']) {
            assert.throws(() => parseCustomDocumentTemplate({ ...valid, language }), /canonical language/);
        }
    });
});
