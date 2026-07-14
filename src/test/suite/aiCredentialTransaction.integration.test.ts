import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    AIProviderCredentialMutationError,
    applyAIProviderCredentialMutation,
    type AIProviderCredentialStorage,
} from '../../providers/UnifiedAIAdapter';

type MutationFailure = 'canonical secret' | 'legacy secret' | 'settings';

interface CredentialState {
    settings: Record<string, string> | undefined;
    secrets: Map<string, string>;
}

function cloneSettings(value: Record<string, string> | undefined): Record<string, string> | undefined {
    return value === undefined ? undefined : { ...value };
}

function snapshotState(state: CredentialState): { settings: Record<string, string> | undefined; secrets: string[][] } {
    return {
        settings: cloneSettings(state.settings),
        secrets: [...state.secrets.entries()].sort(([left], [right]) => left.localeCompare(right)),
    };
}

function createStorage(
    state: CredentialState,
    operations: string[],
    failure?: MutationFailure
): AIProviderCredentialStorage {
    let canonicalWrites = 0;
    let legacyWrites = 0;
    let settingsWrites = 0;
    const maybeFail = (location: MutationFailure, writeNumber: number): void => {
        // Fail after the first mutation at the requested location. This
        // simulates the worst storage contract: a rejected write may still
        // have changed durable state. Rollback calls are allowed to succeed.
        if (failure === location && writeNumber === 1) {
            throw new Error(`injected ${location} failure`);
        }
    };

    return {
        readSettings: () => {
            operations.push('read:settings');
            return cloneSettings(state.settings);
        },
        writeSettings: (value) => {
            settingsWrites++;
            operations.push('write:settings');
            state.settings = cloneSettings(value);
            maybeFail('settings', settingsWrites);
        },
        readSecret: (key) => {
            operations.push(`read:${key}`);
            return state.secrets.get(key);
        },
        storeSecret: (key, value) => {
            const isCanonical = key === 'openai-api-key';
            if (isCanonical) canonicalWrites++;
            else legacyWrites++;
            operations.push(`store:${key}`);
            state.secrets.set(key, value);
            maybeFail(isCanonical ? 'canonical secret' : 'legacy secret', isCanonical ? canonicalWrites : legacyWrites);
        },
        deleteSecret: (key) => {
            const isCanonical = key === 'openai-api-key';
            if (isCanonical) canonicalWrites++;
            else legacyWrites++;
            operations.push(`delete:${key}`);
            state.secrets.delete(key);
            maybeFail(isCanonical ? 'canonical secret' : 'legacy secret', isCanonical ? canonicalWrites : legacyWrites);
        },
    };
}

suite('AI credential transaction', () => {
    test('secure update uses the latest snapshot and publishes settings after both secret writes', async () => {
        const state: CredentialState = {
            // This represents a value changed while the command picker was
            // open. It must be preserved by the snapshot taken in the helper.
            settings: { openai: 'latest-settings-key', anthropic: 'preserve-me' },
            secrets: new Map([
                ['openai-api-key', 'old-canonical'],
                ['annotation.openaiKey', 'old-legacy'],
            ]),
        };
        const operations: string[] = [];

        await applyAIProviderCredentialMutation(
            'openai',
            { kind: 'secrets', apiKey: 'new-secure-key' },
            createStorage(state, operations)
        );

        assert.deepStrictEqual(state.settings, { anthropic: 'preserve-me' });
        assert.deepStrictEqual([...state.secrets.entries()], [['openai-api-key', 'new-secure-key']]);
        assert.deepStrictEqual(operations, [
            'read:settings',
            'read:openai-api-key',
            'read:annotation.openaiKey',
            'store:openai-api-key',
            'delete:annotation.openaiKey',
            'write:settings',
        ]);
    });

    test('settings update removes canonical and legacy secrets without dropping unrelated current settings', async () => {
        const state: CredentialState = {
            settings: { openai: 'old', anthropic: 'preserve-me' },
            secrets: new Map([
                ['openai-api-key', 'old-canonical'],
                ['annotation.openaiKey', 'old-legacy'],
                ['unrelated-secret', 'preserve-me'],
            ]),
        };

        await applyAIProviderCredentialMutation(
            'openai',
            { kind: 'settings', apiKey: 'new-settings-key' },
            createStorage(state, [])
        );

        assert.deepStrictEqual(state.settings, { openai: 'new-settings-key', anthropic: 'preserve-me' });
        assert.deepStrictEqual([...state.secrets.entries()], [['unrelated-secret', 'preserve-me']]);
    });

    test('remove clears every provider location and preserves an absent global settings object', async () => {
        const state: CredentialState = {
            settings: undefined,
            secrets: new Map([
                ['openai-api-key', 'canonical'],
                ['annotation.openaiKey', 'legacy'],
            ]),
        };

        await applyAIProviderCredentialMutation('openai', { kind: 'remove' }, createStorage(state, []));

        assert.strictEqual(state.settings, undefined);
        assert.deepStrictEqual([...state.secrets.entries()], []);
    });

    for (const failure of ['canonical secret', 'legacy secret', 'settings'] as const) {
        test(`restores all three original locations when the ${failure} mutation rejects`, async () => {
            const state: CredentialState = {
                settings: { openai: 'old-settings', anthropic: 'preserve-me' },
                secrets: new Map([
                    ['openai-api-key', 'old-canonical'],
                    ['annotation.openaiKey', 'old-legacy'],
                    ['unrelated-secret', 'preserve-me'],
                ]),
            };
            const before = snapshotState(state);
            let caught: unknown;

            try {
                await applyAIProviderCredentialMutation(
                    'openai',
                    { kind: 'secrets', apiKey: 'new-key' },
                    createStorage(state, [], failure)
                );
            } catch (error) {
                caught = error;
            }

            assert.ok(caught instanceof AIProviderCredentialMutationError);
            assert.deepStrictEqual(caught.rollbackFailures, []);
            assert.deepStrictEqual(snapshotState(state), before);
        });
    }

    test('credential command relies on the configuration listener instead of refreshing twice', () => {
        const sourcePath = path.resolve(__dirname, '../../../src/providers/UnifiedAIAdapter.ts');
        const source = fs.readFileSync(sourcePath, 'utf8');
        const start = source.indexOf('private async updateApiKey(): Promise<void>');
        const end = source.indexOf('private async configureProviderConnection(', start);
        assert.ok(start >= 0 && end > start, 'updateApiKey source must be discoverable');
        const workflow = source.slice(start, end);

        assert.match(workflow, /this\.invalidateProviderIfActive\(selectedProvider\.value\)/);
        assert.doesNotMatch(workflow, /await this\.refreshProvider\(\)/);
    });
});
