# Architecture

A high-level view of how Out-of-Code Insights is structured, for contributors
who want to extend the extension or understand the data flow before opening a
pull request.

For end-user documentation, see the project [README](../README.md). For
LLM-specific configuration, see [llm-providers.md](./llm-providers.md).

---

## Top-level layout

```
src/
  extension.ts              Activation, dependency wiring, command registration
  common/                   Shared types and helpers
  managers/                 Domain managers (annotations, profiles, kanban, links)
  providers/                LLM provider adapters
  tree/                     VS Code TreeView data providers
  views/                    Webview-backed views (Kanban)
  test/                     Mocha + @vscode/test-electron suite
```

The entry point is `src/extension.ts`. It instantiates `AnnotationManager`,
the user-profile and AI-profile managers, the unified AI adapter, and registers
the tree views and commands. Activation tolerates the absence of a workspace
folder: the extension waits for `onDidChangeWorkspaceFolders` and loads
annotations once a folder is opened.

> **Known debt:** `AnnotationManager` is currently the single largest module
> (~3,450 lines) and concentrates several distinct responsibilities. A
> decomposition is on the roadmap. See [ROADMAP.md](./ROADMAP.md) and the
> issue tracker (label: `architecture`).

---

## Annotation storage

Annotations are persisted as a JSON array in
`<workspace>/.out-of-code-insights/annotations.json`. Schema (one entry):

```jsonc
{
    "id": "md7oizwo85y2fu8dnqj",
    "file": "src/managers/AnnotationManager.ts",
    "line": 1356,
    "message": "Variable 'id' is assigned but never read",
    "author": "Anonymous",
    "timestamp": "2026-05-03T22:12:00.000Z",
    "thread": [],
    "tags": ["lint", "cleanup"],
    "pinned": false,
    "priority": 0,
    "severity": "info",
    "resolved": false,
    "kanbanColumn": "todo",
}
```

The path is configurable via `annotation.path` (absolute, relative to the
workspace, or pointing directly at a `.json` file). The path resolver enforces
that relative custom paths cannot escape the workspace root (path-traversal
guard). See [ADR-001](./adr/001-annotation-storage-json.md) for the rationale
behind file-based storage.

`AnnotationManager.loadAnnotations()` and `saveAnnotations()` are the only
callers that touch the file: every UI component operates on the in-memory
`Map<string, Annotation>`.

---

## LLM integration

The provider layer is split into two parts.

### `UnifiedAIAdapter`

A single adapter that wraps the [`multi-llm-ts`](https://www.npmjs.com/package/multi-llm-ts)
library and exposes a uniform interface to every provider listed in
[llm-providers.md](./llm-providers.md). Used for the bulk of annotation
generation. Provider switching is configuration-only: the adapter resolves the
right backend at request time.

### Active provider catalogue

`AIProviderCatalog` is the single active provider registry. Its 13 IDs match
the installed multi-provider runtime; Anthropic models use `anthropic`, not a
separate `claude` ID. The catalogue also defines whether a credential is
required and supplies Azure endpoint/deployment/API-version or local Ollama/LM
Studio base URLs to the engine.

`ClaudeCodeProvider`, `ClaudeIntegration` and their wrapper remain legacy
source files but are not instantiated by the active extension. The
`annotation.claudeUseSDK` setting is therefore inactive and must not be treated
as a supported runtime path. [ADR-002](./adr/002-claude-dual-adapter-sdk-rest.md)
records the superseded proposal for historical context.

---

## Webviews

Three views render with VS Code WebviewPanel:

| View                  | Content                                         |
| --------------------- | ----------------------------------------------- |
| Annotations Panel     | List view, search, filter, severity, batch-edit |
| Kanban (`KanbanView`) | Drag-and-drop board across configurable columns |
| Links                 | Linked-annotation graph                         |

> **Known debt:** HTML, CSS, and JavaScript for these webviews are currently
> embedded as TypeScript template literals inside the producing class.
> Extraction into standalone files (with proper Content-Security-Policy and
> nonce handling) is on the roadmap (label: `architecture`).

CSP is currently set on every webview to restrict script and style sources to
the extension's own bundle.

---

## Tree views

Two TreeViews are registered against the activity-bar container `annotations`:

- `annotationsView`: primary annotation tree, supports drag-and-drop
- `stackView`: navigation history (back / forward across visited annotations)

A third tree (`annotationsExplorerView`) appears in the file explorer for
quick file-scoped navigation.

---

## Localization

Two `package.nls.*.json` bundles (`en`, `fr`) provide the localized strings
consumed by `LocalizationManager.localize()`. The active language is governed
by `annotation.language` and falls back to English if a key is missing.

> **Known debt:** Some inline webview strings call `loc(key, fallback)` with
> keys that do not exist in either bundle. The fallback is the displayed value
> in every locale. Migrating these to proper bundle entries is a small
> follow-up (label: `i18n`).

---

## Test infrastructure

- `src/test/runTest.ts`: entry point; downloads VS Code via
  `@vscode/test-electron` and launches the host.
- `src/test/suite/index.ts`: Mocha runner (TDD UI), discovers `*.test.js`
  under `out/test/suite`.
- `test-fixtures/`: workspace folder used by the test host; excluded from
  `tsconfig` and from the published `.vsix`.

CI runs typecheck + lint + production webpack build, then integration tests on
Ubuntu / Windows / macOS. See `.github/workflows/ci.yml`.
