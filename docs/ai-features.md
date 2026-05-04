# AI features

Out-of-Code Insights ships an AI layer that turns the extension
into a code-review companion. This guide walks through every
AI-powered command from setup to advanced workflows.

For the supported provider list and model configuration, see
[llm-providers.md](./llm-providers.md). For the architecture of
the integration, see [architecture.md](./architecture.md).

---

## 1. Prerequisites

1. An API key for a supported LLM provider (free tiers exist for
   Groq, Google, Mistral; OpenAI and Anthropic require a paid
   account).
2. The `annotation.enableAiSuggest` setting set to `true` (off by
   default - the extension never calls a remote API silently).

Open VS Code Settings (`Ctrl+,`) and configure:

```jsonc
{
    "annotation.enableAiSuggest": true,
    "annotation.provider": "anthropic",
    "annotation.model": "claude-3-5-sonnet-20241022",
    "llm.apiKeys": {
        "anthropic": "sk-ant-..."
    }
}
```

Alternatively, run `Out-of-Code Insights: Update AI Provider API
Key` from the command palette to store the key in VS Code's
SecretStorage instead of `settings.json` (recommended for shared
machines).

---

## 2. Per-line suggestion

| Command | Default keybinding |
|---|---|
| `annotations.aiSuggest` | `Ctrl+Alt+I` |
| `annotations.aiSuggestWithProfile` | - |

Place the cursor on a line, run the command. The extension sends
the surrounding context to the configured provider and creates an
annotation with the suggestion. `aiSuggestWithProfile` first
prompts you to choose a user profile (developer / analyst /
architect / custom) so the prompt is tuned to your role.

---

## 3. Whole-file analysis

| Command | What it does |
|---|---|
| `annotations.aiAnalyzeFile` | Analyses the entire active file with the active profile and creates one annotation per detected issue |
| `annotations.aiAnalyzeFileWithProfile` | Same, but you pick the profile interactively |

Use `Analyze File with Profile` when reviewing a file from a
perspective different from your default - for instance, a
developer analysing an architecture-sensitive module with the
*architect* profile.

The command shows a progress notification and inserts annotations
in batch on completion. Each annotation is fully editable
afterwards.

---

## 4. Batch annotation generation

| Command | Behaviour |
|---|---|
| `annotations.aiBatchAnnotate` | Generates multiple annotations on a selection or the whole file, scoped to one or more *focus areas* |

When invoked, the command shows a multi-select prompt:

- **All issues** - broad review
- **Bugs only** - defects, off-by-one, null deref
- **Performance** - algorithmic complexity, unnecessary work
- **Security** - vulnerabilities, unsafe input handling
- **Documentation** - missing or stale comments
- **Architecture** - design patterns, coupling, layering

This is the right command when you want a focused, explicit pass
(e.g. *security review before merge*) rather than the open-ended
analysis of `Analyze File`.

The related `annotations.batchCreateMixed` lets you mix focus
areas in a single batch.

---

## 5. User profiles and AI prompts

A *profile* shapes the prompt sent to the LLM and the default tags
and severity assigned to generated annotations. Built-in profiles:

- **Developer** - bugs, fixes, performance, refactors. Severity
  warning. Tags: `bug`, `fix`, `improvement`, `performance`,
  `refactor`.
- **Business Analyst** - documentation, requirements, business
  rules. Severity info. Tags: `documentation`, `business-logic`,
  `requirements`, `clarification`.
- **Software Architect** - design patterns, security, scalability.
  Severity info, priority high. Tags: `architecture`,
  `design-pattern`, `security`, `scalability`.

Switch profile from the status bar, or via
`annotations.selectProfile`. Create a custom profile with
`annotations.manageProfiles`.

For full design rationale see
[design/user-profiles.md](./design/user-profiles.md).

---

## 6. Custom AI profiles

Beyond the role-based user profiles, the extension supports
**AI profiles** - saved combinations of provider, model,
temperature, system prompt, and focus areas. Useful when the same
machine is used for multiple workflows (e.g. one profile tuned
for security review with a long system prompt, another tuned for
quick bug-spotting with a smaller model).

Manage them with `annotations.manageAIProfiles`.

---

## 7. Recommended workflows

### Code review before merge

1. Open the diff or the changed file.
2. Switch to the *Developer* profile.
3. Run `Batch Generate Annotations` with focus *Bugs only* +
   *Security*.
4. Review each annotation, mark resolved when addressed.

### New-feature documentation

1. Switch to the *Business Analyst* profile.
2. Open the relevant module.
3. Run `Analyze File with Profile`.
4. Convert important annotations to GitHub Issues via the panel
   action.

### Architectural review

1. Switch to the *Software Architect* profile.
2. Open the entry point of the module.
3. Run `Batch Generate Annotations` with focus *Architecture* +
   *Performance*.
4. Use the Linked Annotations feature to connect related findings
   across files.

---

## 8. Cost and rate limits

The extension never batches a request larger than the active
file. For long files, the number of annotations is capped by the
provider's response token limit, not by the extension. Set
`annotation.maxAnnotationsPerFile` to bound generated annotations
explicitly.

Tracking spend is the user's responsibility - every provider has
a usage dashboard. The extension does not collect telemetry.
