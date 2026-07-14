import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    AI_PROVIDER_CATALOG,
    AI_PROVIDER_IDS,
    canReuseAIProviderSession,
    createAIProviderEngineOptions,
    createAIProviderQuickPickItems,
    isAIProviderId,
} from '../../../providers/AIProviderCatalog';

interface ProviderSetting {
    default: string;
    enum: string[];
    enumDescriptions: string[];
}

interface ApiKeySetting {
    properties: Record<string, { description: string }>;
}

interface ExtensionManifest {
    contributes: {
        configuration: {
            properties: {
                'annotation.provider': ProviderSetting;
                'llm.apiKeys': ApiKeySetting;
            };
        };
    };
}

function repositoryFile(...segments: string[]): string {
    return path.resolve(__dirname, '../../../..', ...segments);
}

function readJson<T>(...segments: string[]): T {
    return JSON.parse(fs.readFileSync(repositoryFile(...segments), 'utf8')) as T;
}

suite('AI provider catalogue', () => {
    test('contains the exact supported provider IDs with no product-name aliases', () => {
        const expected = [
            'openai',
            'anthropic',
            'azure',
            'cerebras',
            'deepseek',
            'google',
            'groq',
            'meta',
            'mistralai',
            'ollama',
            'openrouter',
            'lmstudio',
            'xai',
        ];

        assert.deepStrictEqual(AI_PROVIDER_IDS, expected);
        assert.strictEqual(new Set(AI_PROVIDER_IDS).size, AI_PROVIDER_IDS.length);
        assert.ok(AI_PROVIDER_IDS.every(isAIProviderId));
        assert.strictEqual(isAIProviderId('claude'), false);
        assert.strictEqual(isAIProviderId('mistral'), false);
        assert.strictEqual(isAIProviderId('together'), false);
    });

    test('builds the credential picker from every localized catalogue label', () => {
        const localizationCalls: Array<{ key: string; fallback: string }> = [];
        const items = createAIProviderQuickPickItems((key, fallback) => {
            localizationCalls.push({ key, fallback });
            return `localized:${key}`;
        });

        assert.deepStrictEqual(
            items.map(({ value }) => value),
            AI_PROVIDER_IDS
        );
        assert.deepStrictEqual(
            items.map(({ label }) => label),
            AI_PROVIDER_CATALOG.map(({ localizationKey }) => `localized:${localizationKey}`)
        );
        assert.deepStrictEqual(
            localizationCalls,
            AI_PROVIDER_CATALOG.map(({ localizationKey: key, defaultLabel: fallback }) => ({ key, fallback }))
        );

        for (const languageFile of ['package.nls.json', 'package.nls.fr.json']) {
            const messages = readJson<Record<string, string>>(languageFile);
            for (const provider of AI_PROVIDER_CATALOG) {
                assert.ok(
                    messages[provider.localizationKey]?.trim(),
                    `${languageFile} is missing ${provider.localizationKey}`
                );
            }
        }

        const adapterSource = fs.readFileSync(repositoryFile('src/providers/UnifiedAIAdapter.ts'), 'utf8');
        assert.match(adapterSource, /createAIProviderQuickPickItems\(loc\)/);
        assert.match(adapterSource, /if \(!providerDefinition\)/);
        assert.match(adapterSource, /openSettings', 'annotation\.provider'/);
        assert.match(adapterSource, /action === updateApiKeyLabel/);
        assert.match(adapterSource, /action === openSettingsLabel/);
        assert.doesNotMatch(adapterSource, /action === ['"](?:Update API Key|Open Settings)['"]/);
        assert.doesNotMatch(adapterSource, /value:\s*['"]claude['"]/);
    });

    test('keeps manifest provider choices, descriptions and credential properties in canonical order', () => {
        const manifest = readJson<ExtensionManifest>('package.json');
        const providerSetting = manifest.contributes.configuration.properties['annotation.provider'];
        const apiKeySetting = manifest.contributes.configuration.properties['llm.apiKeys'];

        assert.deepStrictEqual(providerSetting.enum, AI_PROVIDER_IDS);
        assert.deepStrictEqual(
            providerSetting.enumDescriptions,
            AI_PROVIDER_CATALOG.map(({ settingDescription }) => settingDescription)
        );
        assert.ok(isAIProviderId(providerSetting.default));
        assert.deepStrictEqual(Object.keys(apiKeySetting.properties), AI_PROVIDER_IDS);
        for (const provider of AI_PROVIDER_CATALOG) {
            assert.strictEqual(
                apiKeySetting.properties[provider.id]?.description,
                provider.credentialSettingDescription
            );
        }

        // Claude is a model/product name, not a provider ID accepted by the
        // multi-LLM runtime. Claude models use the `anthropic` credential;
        // the separate Claude Code SDK profile/auth flow never reads
        // `llm.apiKeys.claude`. Keeping that property would advertise a key
        // that neither runtime credential path consumes.
        assert.ok(!Object.prototype.hasOwnProperty.call(apiKeySetting.properties, 'claude'));
    });

    test('requires credentials for remote providers but permits local runtimes without a key', () => {
        const optional = AI_PROVIDER_CATALOG.filter(({ apiKeyRequired }) => !apiKeyRequired);
        assert.deepStrictEqual(
            optional.map(({ id }) => id),
            ['ollama', 'lmstudio']
        );
        assert.strictEqual(AI_PROVIDER_CATALOG.filter(({ apiKeyRequired }) => apiKeyRequired).length, 11);

        const annotationManagerSource = fs.readFileSync(repositoryFile('src/managers/AnnotationManager.ts'), 'utf8');
        const unifiedProviderSource = fs.readFileSync(repositoryFile('src/providers/UnifiedAIProvider.ts'), 'utf8');
        assert.match(annotationManagerSource, /for \(const providerDefinition of AI_PROVIDER_CATALOG\)/);
        assert.match(annotationManagerSource, /providerDefinition\.apiKeyRequired/);
        assert.match(annotationManagerSource, /chosenProviderDefinition\.apiKeyRequired/);
        assert.match(annotationManagerSource, /canReuseAIProviderSession\(\{/);
        assert.match(annotationManagerSource, /this\.providerKeys = \{\}/);
        assert.match(unifiedProviderSource, /providerDefinition\?\.apiKeyRequired \?\? true/);
        assert.match(unifiedProviderSource, /else if \(apiKeyRequired\)/);
    });

    test('builds Azure and local engine connection options explicitly', () => {
        assert.deepStrictEqual(
            createAIProviderEngineOptions('azure', ' key ', {
                azureEndpoint: 'https://example.openai.azure.com/',
                azureDeployment: 'production',
                azureApiVersion: '2024-10-21',
            }),
            {
                apiKey: 'key',
                baseURL: 'https://example.openai.azure.com',
                deployment: 'production',
                apiVersion: '2024-10-21',
            }
        );
        assert.deepStrictEqual(
            createAIProviderEngineOptions('lmstudio', undefined, {
                lmStudioBaseUrl: 'http://localhost:1234/v1/',
            }),
            { baseURL: 'http://localhost:1234/v1' }
        );
    });

    test('reuses an engine only while provider and required credentials remain current', () => {
        const currentOpenAI = {
            configuredProvider: 'openai',
            activeProvider: 'openai',
            activeApiKey: 'key-v1',
            storedApiKey: 'key-v1',
            hasEngine: true,
        };
        assert.strictEqual(canReuseAIProviderSession(currentOpenAI), true);
        assert.strictEqual(
            canReuseAIProviderSession({ ...currentOpenAI, configuredProvider: 'anthropic' }),
            false,
            'changing the provider must rebuild the engine'
        );
        assert.strictEqual(
            canReuseAIProviderSession({ ...currentOpenAI, storedApiKey: 'key-v2' }),
            false,
            'rotating a key must rebuild the engine'
        );
        assert.strictEqual(
            canReuseAIProviderSession({
                ...currentOpenAI,
                activeConnectionSignature: '{"endpoint":"old"}',
                configuredConnectionSignature: '{"endpoint":"new"}',
            }),
            false,
            'changing provider connection settings must rebuild the engine'
        );
        assert.strictEqual(
            canReuseAIProviderSession({ ...currentOpenAI, storedApiKey: undefined }),
            false,
            'removing a required key must invalidate the engine'
        );
        assert.strictEqual(
            canReuseAIProviderSession({
                configuredProvider: 'ollama',
                activeProvider: 'ollama',
                activeApiKey: undefined,
                storedApiKey: undefined,
                hasEngine: true,
            }),
            true,
            'Ollama may reuse its local engine without a key'
        );
        assert.strictEqual(
            canReuseAIProviderSession({
                configuredProvider: 'ollama',
                activeProvider: 'ollama',
                activeApiKey: undefined,
                storedApiKey: 'new-optional-key',
                hasEngine: true,
            }),
            false,
            'adding or rotating an optional Ollama key must also rebuild the engine'
        );
        assert.strictEqual(
            canReuseAIProviderSession({ ...currentOpenAI, configuredProvider: 'claude' }),
            false,
            'unsupported aliases may never reuse an engine'
        );
    });
});
