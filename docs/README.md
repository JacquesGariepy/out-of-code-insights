# Documentation

Supplementary documentation for **Out-of-Code Insights**. End-user quickstart
and the command reference live in the project [README](../README.md); this
folder is for deeper material.

> Documentation Studio material marked 1.4.4 describes the source candidate,
> not a published extension. Marketplace and Open VSX remain on 1.4.3 until
> explicit user confirmation authorizes a release.

## Contents

| File                                                       | Audience         | What it covers                                                                                                       |
| ---------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| [commands.md](./commands.md)                               | Users            | Full command and keyboard shortcut reference                                                                         |
| [onboarding.md](./onboarding.md)                           | New contributors | Step-by-step dev environment setup                                                                                   |
| [ROADMAP.md](./ROADMAP.md)                                 | Everyone         | Proposed features with effort estimates and rationale                                                                |
| [ai-features.md](./ai-features.md)                         | Users            | AI-powered annotation features end-to-end                                                                            |
| [documentation-studio.md](./documentation-studio.md)       | Users and teams  | Technical-document presets, static projects, Wiki, HTML, constrained API catalogues and diagnostics consumable by CI |
| [documentation-authoring.md](./documentation-authoring.md) | Authors          | `doc:*` roles, Markdown content and generated page structure                                                         |
| [llm-providers.md](./llm-providers.md)                     | Users            | Supported LLM providers, model selection, API key setup                                                              |
| [architecture.md](./architecture.md)                       | Contributors     | High-level architecture, adapter design, known debt                                                                  |
| [design/user-profiles.md](./design/user-profiles.md)       | Contributors     | Design document for the user profile system                                                                          |
| [adr/](./adr/)                                             | Contributors     | Architecture Decision Records                                                                                        |
| [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)       | Legal            | Third-party dependency licenses                                                                                      |

## Architecture Decision Records

| ADR                                                 | Title                                   | Status     |
| --------------------------------------------------- | --------------------------------------- | ---------- |
| [0001](./adr/0001-record-architecture-decisions.md) | Record Architecture Decisions           | Accepted   |
| [001](./adr/001-annotation-storage-json.md)         | Store Annotations as JSON in Workspace  | Accepted   |
| [002](./adr/002-claude-dual-adapter-sdk-rest.md)    | Superseded Claude Dual-Adapter Proposal | Superseded |

## Conventions

- Documentation is in **English only**. The extension UI is localized
  (English / French) via `package.nls.*.json`.
- Code samples assume `vscode >= 1.95.0` and Node 20+.
- File paths are relative to the repository root.
