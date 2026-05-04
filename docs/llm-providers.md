# LLM providers

Out-of-Code Insights supports thirteen LLM providers. This page
lists them, recommends models, and shows the configuration
needed for each.

For end-to-end AI usage instructions, see
[ai-features.md](./ai-features.md).

---

## Supported providers

| Provider | Setting key | Notes |
|---|---|---|
| OpenAI | `openai` | GPT-4o, GPT-4o-mini, o1 |
| Anthropic | `anthropic` | Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude 3 Opus |
| Anthropic Claude Code SDK | `claude` | Same models, uses the official SDK with REST fallback |
| Azure OpenAI | `azure` | Bring your own deployment |
| Google | `google` | Gemini 1.5 Pro, Gemini 1.5 Flash |
| Mistral AI | `mistralai` | Mistral Large, Mistral Small, Codestral |
| Groq | `groq` | Llama 3.x, Mixtral - very fast inference |
| Cerebras | `cerebras` | Llama 3.x - extremely fast inference |
| DeepSeek | `deepseek` | DeepSeek-V3, DeepSeek-Coder |
| Meta | `meta` | Llama API |
| Ollama | `ollama` | Local models - no API key required |
| OpenRouter | `openrouter` | Aggregator across many providers |
| TogetherAI | `togetherai` | Open-weight model hosting |
| xAI | `xai` | Grok models |

---

## Selecting a provider

Set two settings - provider and model:

```jsonc
{
    "annotation.provider": "anthropic",
    "annotation.model": "claude-3-5-sonnet-20241022"
}
```

Switching providers does **not** invalidate your user profiles or
custom AI profiles; the new provider is used for the next
AI-generated annotation.

---

## Configuring API keys

Two storage options - pick one:

### Option A: VS Code SecretStorage (recommended)

Run the command `Out-of-Code Insights: Update AI Provider API
Key` and follow the prompt. Keys live in the OS keychain, never
in `settings.json`.

### Option B: settings.json

```jsonc
{
    "llm.apiKeys": {
        "openai": "sk-...",
        "anthropic": "sk-ant-...",
        "google": "AIza...",
        "groq": "gsk_..."
    }
}
```

Settings.json keys are convenient but readable by anything that
can read your settings - avoid on shared machines and never
commit a settings file with keys to version control.

---

## Provider-specific notes

### Anthropic / Claude

The Claude provider has two flavours:

- `"annotation.provider": "anthropic"` - uses the OpenAI-compatible
  REST endpoint via the unified adapter
- `"annotation.provider": "claude"` - uses the official
  `@anthropic-ai/claude-code` SDK with automatic fallback to REST
  if the SDK fails to load (handled by `ClaudeIntegration`)

Toggle the SDK path with:

```jsonc
{
    "annotation.claudeUseSDK": true   // true by default
}
```

Set it to `false` to force REST and bypass the SDK entirely
(useful for environments where the SDK has loading issues).

### Azure OpenAI

Azure deployments require a deployment name as the model and a
custom endpoint, configured via standard Azure env vars or the
provider's setting bag. The unified adapter abstracts the
difference.

### Ollama

Ollama runs locally - no API key. Set the provider and model:

```jsonc
{
    "annotation.provider": "ollama",
    "annotation.model": "llama3.1:8b"
}
```

Ensure the Ollama daemon is running (`ollama serve`) and the
chosen model is pulled (`ollama pull llama3.1:8b`).

---

## Recommended starting points

| Use case | Provider | Model |
|---|---|---|
| Best balance of quality & cost | Anthropic | `claude-3-5-sonnet-20241022` |
| Cheapest paid | OpenAI | `gpt-4o-mini` |
| Free / fastest | Groq | `llama-3.3-70b-versatile` |
| Privacy / offline | Ollama | `llama3.1:8b` |
| Highest reasoning ceiling | OpenAI | `o1` (slow, expensive) |

The extension does not endorse any specific provider; choose
based on your privacy requirements, cost ceiling, and the
languages you work with.
