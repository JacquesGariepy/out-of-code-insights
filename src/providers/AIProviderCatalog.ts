export interface AIProviderDefinition {
    readonly id: string;
    readonly localizationKey: string;
    readonly defaultLabel: string;
    readonly apiKeyRequired: boolean;
    readonly settingDescription: string;
    readonly credentialSettingDescription: string;
}

export interface AIProviderConnectionSettings {
    readonly azureEndpoint?: string;
    readonly azureDeployment?: string;
    readonly azureApiVersion?: string;
    readonly lmStudioBaseUrl?: string;
    readonly ollamaBaseUrl?: string;
}

export interface AIProviderEngineOptions {
    readonly apiKey?: string;
    readonly baseURL?: string;
    readonly deployment?: string;
    readonly apiVersion?: string;
}

export interface AIProviderConfigurationReader {
    get<T>(section: string, defaultValue: T): T;
}

/**
 * Canonical catalogue shared by provider configuration and credential UI.
 *
 * Provider IDs are the identifiers accepted by the multi-LLM runtime. Keep
 * aliases out of this list: product/model names such as `claude` are exposed
 * through their actual provider (`anthropic`).
 */
export const AI_PROVIDER_CATALOG = [
    {
        id: 'openai',
        localizationKey: 'providerOpenAI',
        defaultLabel: 'OpenAI',
        apiKeyRequired: true,
        settingDescription: 'OpenAI models using an OpenAI API key.',
        credentialSettingDescription: 'OpenAI API key',
    },
    {
        id: 'anthropic',
        localizationKey: 'providerAnthropic',
        defaultLabel: 'Anthropic (Claude)',
        apiKeyRequired: true,
        settingDescription: 'Anthropic Claude models using an Anthropic API key.',
        credentialSettingDescription: 'Anthropic API key',
    },
    {
        id: 'azure',
        localizationKey: 'providerAzure',
        defaultLabel: 'Azure OpenAI',
        apiKeyRequired: true,
        settingDescription: 'Azure OpenAI models using Azure credentials.',
        credentialSettingDescription: 'Azure OpenAI API key',
    },
    {
        id: 'cerebras',
        localizationKey: 'providerCerebras',
        defaultLabel: 'Cerebras',
        apiKeyRequired: true,
        settingDescription: 'Cerebras-hosted models using a Cerebras API key.',
        credentialSettingDescription: 'Cerebras API key',
    },
    {
        id: 'deepseek',
        localizationKey: 'providerDeepSeek',
        defaultLabel: 'DeepSeek',
        apiKeyRequired: true,
        settingDescription: 'DeepSeek models using a DeepSeek API key.',
        credentialSettingDescription: 'DeepSeek API key',
    },
    {
        id: 'google',
        localizationKey: 'providerGoogle',
        defaultLabel: 'Google Gemini',
        apiKeyRequired: true,
        settingDescription: 'Google Gemini models using a Google API key.',
        credentialSettingDescription: 'Google Gemini API key',
    },
    {
        id: 'groq',
        localizationKey: 'providerGroq',
        defaultLabel: 'Groq',
        apiKeyRequired: true,
        settingDescription: 'Groq-hosted models using a Groq API key.',
        credentialSettingDescription: 'Groq API key',
    },
    {
        id: 'meta',
        localizationKey: 'providerMeta',
        defaultLabel: 'Meta',
        apiKeyRequired: true,
        settingDescription: 'Meta-hosted models using a Meta API key.',
        credentialSettingDescription: 'Meta API key',
    },
    {
        id: 'mistralai',
        localizationKey: 'providerMistral',
        defaultLabel: 'Mistral AI',
        apiKeyRequired: true,
        settingDescription: 'Mistral AI models using a Mistral AI API key.',
        credentialSettingDescription: 'Mistral AI API key',
    },
    {
        id: 'ollama',
        localizationKey: 'providerOllama',
        defaultLabel: 'Ollama (Local)',
        apiKeyRequired: false,
        settingDescription: 'Locally hosted Ollama models.',
        credentialSettingDescription: 'Optional Ollama API key',
    },
    {
        id: 'openrouter',
        localizationKey: 'providerOpenRouter',
        defaultLabel: 'OpenRouter',
        apiKeyRequired: true,
        settingDescription: 'Models routed through OpenRouter using an OpenRouter API key.',
        credentialSettingDescription: 'OpenRouter API key',
    },
    {
        id: 'lmstudio',
        localizationKey: 'providerLMStudio',
        defaultLabel: 'LM Studio (Local)',
        apiKeyRequired: false,
        settingDescription: 'Locally hosted LM Studio models; no API key is required.',
        credentialSettingDescription: 'Optional LM Studio API key',
    },
    {
        id: 'xai',
        localizationKey: 'providerXai',
        defaultLabel: 'xAI',
        apiKeyRequired: true,
        settingDescription: 'xAI models using an xAI API key.',
        credentialSettingDescription: 'xAI API key',
    },
] as const satisfies readonly AIProviderDefinition[];

export type AIProviderId = (typeof AI_PROVIDER_CATALOG)[number]['id'];

export const AI_PROVIDER_IDS: readonly AIProviderId[] = AI_PROVIDER_CATALOG.map(({ id }) => id);

export interface AIProviderQuickPickItem {
    readonly label: string;
    readonly value: AIProviderId;
}

export type AIProviderLabelLocalizer = (key: string, defaultLabel: string) => string;

export function createAIProviderQuickPickItems(localizeLabel: AIProviderLabelLocalizer): AIProviderQuickPickItem[] {
    return AI_PROVIDER_CATALOG.map(({ id, localizationKey, defaultLabel }) => ({
        label: localizeLabel(localizationKey, defaultLabel),
        value: id,
    }));
}

export function isAIProviderId(value: string): value is AIProviderId {
    return AI_PROVIDER_IDS.includes(value as AIProviderId);
}

export function readAIProviderConnectionSettings(
    configuration: AIProviderConfigurationReader
): AIProviderConnectionSettings {
    return {
        azureEndpoint: configuration.get<string>('azure.endpoint', ''),
        azureDeployment: configuration.get<string>('azure.deployment', ''),
        azureApiVersion: configuration.get<string>('azure.apiVersion', ''),
        lmStudioBaseUrl: configuration.get<string>('lmStudio.baseUrl', 'http://localhost:1234/v1'),
        ollamaBaseUrl: configuration.get<string>('ollama.baseUrl', 'http://localhost:11434'),
    };
}

/** Build the exact connection options accepted by the installed multi-LLM runtime. */
export function createAIProviderEngineOptions(
    provider: string,
    apiKey: string | undefined,
    settings: AIProviderConnectionSettings
): AIProviderEngineOptions {
    const options: {
        apiKey?: string;
        baseURL?: string;
        deployment?: string;
        apiVersion?: string;
    } = {};
    const normalizedKey = apiKey?.trim();
    if (normalizedKey) {
        options.apiKey = normalizedKey;
    }

    if (provider === 'azure') {
        const baseURL = settings.azureEndpoint?.trim();
        const deployment = settings.azureDeployment?.trim();
        const apiVersion = settings.azureApiVersion?.trim();
        if (baseURL) options.baseURL = baseURL.replace(/\/$/, '');
        if (deployment) options.deployment = deployment;
        if (apiVersion) options.apiVersion = apiVersion;
    } else if (provider === 'lmstudio') {
        const baseURL = settings.lmStudioBaseUrl?.trim();
        if (baseURL) options.baseURL = baseURL.replace(/\/$/, '');
    } else if (provider === 'ollama') {
        const baseURL = settings.ollamaBaseUrl?.trim();
        if (baseURL) options.baseURL = baseURL.replace(/\/$/, '');
    }

    return options;
}

/** Azure is the only bundled engine that requires extra connection fields. */
export function missingAIProviderConnectionFields(provider: string, settings: AIProviderConnectionSettings): string[] {
    if (provider !== 'azure') {
        return [];
    }
    return [
        !settings.azureEndpoint?.trim() ? 'endpoint' : undefined,
        !settings.azureDeployment?.trim() ? 'deployment' : undefined,
        !settings.azureApiVersion?.trim() ? 'API version' : undefined,
    ].filter((value): value is string => value !== undefined);
}

export interface AIProviderSessionState {
    readonly configuredProvider: string;
    readonly activeProvider: string;
    readonly activeApiKey: string | undefined;
    readonly storedApiKey: string | undefined;
    readonly hasEngine: boolean;
    readonly activeConnectionSignature?: string;
    readonly configuredConnectionSignature?: string;
}

export function canReuseAIProviderSession(state: AIProviderSessionState): boolean {
    const providerDefinition = AI_PROVIDER_CATALOG.find(({ id }) => id === state.configuredProvider);
    if (!providerDefinition || !state.hasEngine || state.activeProvider !== state.configuredProvider) {
        return false;
    }
    const credentialsMatch = state.activeApiKey === state.storedApiKey;
    const connectionMatches = state.activeConnectionSignature === state.configuredConnectionSignature;
    return connectionMatches && credentialsMatch && (!providerDefinition.apiKeyRequired || !!state.storedApiKey);
}
