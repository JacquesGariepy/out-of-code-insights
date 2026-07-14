# AI providers

Out-of-Code Insights exposes one catalogue of 13 provider IDs through Settings
and **Configure AI Provider & Credentials**. The command guides provider
selection, connection details and credential storage; users do not need to
edit JSON manually.

For the AI analysis workflows that consume this configuration, see
[AI features](./ai-features.md).

## Supported provider catalogue

| Provider           | `annotation.provider` | Credential                                    |
| ------------------ | --------------------- | --------------------------------------------- |
| OpenAI             | `openai`              | Required                                      |
| Anthropic (Claude) | `anthropic`           | Required                                      |
| Azure OpenAI       | `azure`               | Required, plus the three Azure fields below   |
| Cerebras           | `cerebras`            | Required                                      |
| DeepSeek           | `deepseek`            | Required                                      |
| Google Gemini      | `google`              | Required                                      |
| Groq               | `groq`                | Required                                      |
| Meta               | `meta`                | Required                                      |
| Mistral AI         | `mistralai`           | Required                                      |
| Ollama (local)     | `ollama`              | No key required; an optional value is allowed |
| OpenRouter         | `openrouter`          | Required                                      |
| LM Studio (local)  | `lmstudio`            | No key required; an optional value is allowed |
| xAI                | `xai`                 | Required                                      |

The extension rejects unknown provider IDs instead of silently starting a
different engine. Anthropic models use the `anthropic` provider ID; `claude`
is not a selectable provider ID in the active catalogue.

## Guided setup

1. Right-click in a code editor and choose **Out-of-Code Insights → Settings
   & Accounts → Configure AI Provider & Credentials**. The same command is
   available from the tree `...` menu and the Command Palette.
2. Choose one of the 13 providers.
3. For Azure OpenAI, enter the endpoint, deployment and API version. For
   Ollama or LM Studio, confirm the local server URL.
4. For providers that require a key, choose **Add/Update**, then select VS Code
   Secret Storage (recommended) or visible user settings.
5. Select a model with `annotation.model`, then run an AI action.

The command can also remove a provider credential. Removal requires
confirmation and clears the provider from visible settings plus every
recognized secret-storage name. Add/Update keeps only the selected storage
source so an obsolete key cannot unexpectedly win.

## Connection settings

### Azure OpenAI

Azure requires all three connection values in addition to its credential:

```jsonc
{
    "annotation.provider": "azure",
    "annotation.azure.endpoint": "https://your-resource.openai.azure.com",
    "annotation.azure.deployment": "your-deployment",
    "annotation.azure.apiVersion": "your-supported-api-version",
}
```

The guided command validates that endpoint, deployment and API version are
present before the provider session is created.

### Ollama

Ollama defaults to its local server and does not require a key:

```jsonc
{
    "annotation.provider": "ollama",
    "annotation.ollama.baseUrl": "http://localhost:11434",
    "annotation.model": "your-local-model",
}
```

### LM Studio

LM Studio uses its OpenAI-compatible local endpoint and does not require a
key:

```jsonc
{
    "annotation.provider": "lmstudio",
    "annotation.lmStudio.baseUrl": "http://localhost:1234/v1",
    "annotation.model": "your-loaded-model",
}
```

## Visible settings storage

Secret Storage is recommended because it is backed by VS Code's credential
store. If a user deliberately chooses visible user settings, the equivalent
shape is:

```jsonc
{
    "llm.apiKeys": {
        "openai": "...",
        "anthropic": "...",
        "azure": "...",
    },
}
```

Do not commit credentials to a repository or share a settings file containing
them. Local-provider entries are optional and may be omitted.
