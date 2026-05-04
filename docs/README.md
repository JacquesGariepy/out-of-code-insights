# Documentation

Supplementary documentation for **Out-of-Code Insights**. End-user quickstart
and the command reference live in the project [README](../README.md); this
folder is for deeper material.

## Contents

| File | Audience | What it covers |
|---|---|---|
| [commands.md](./commands.md) | Users | Full command and keyboard shortcut reference |
| [onboarding.md](./onboarding.md) | New contributors | Step-by-step dev environment setup |
| [ROADMAP.md](./ROADMAP.md) | Everyone | Proposed features with effort estimates and rationale |
| [ai-features.md](./ai-features.md) | Users | AI-powered annotation features end-to-end |
| [llm-providers.md](./llm-providers.md) | Users | Supported LLM providers, model selection, API key setup |
| [architecture.md](./architecture.md) | Contributors | High-level architecture, adapter design, known debt |
| [design/user-profiles.md](./design/user-profiles.md) | Contributors | Design document for the user profile system |
| [adr/](./adr/) | Contributors | Architecture Decision Records |
| [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) | Legal | Third-party dependency licenses |

## Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](./adr/0001-record-architecture-decisions.md) | Record Architecture Decisions | Accepted |
| [001](./adr/001-annotation-storage-json.md) | Store Annotations as JSON in Workspace | Accepted |
| [002](./adr/002-claude-dual-adapter-sdk-rest.md) | Dual-Adapter Strategy for Claude Provider | Accepted |

## Conventions

- Documentation is in **English only**. The extension UI is localized
  (English / French) via `package.nls.*.json`.
- Code samples assume `vscode >= 1.95.0` and Node 18+.
- File paths are relative to the repository root.
