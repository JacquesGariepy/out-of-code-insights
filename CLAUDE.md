# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**_ Never mention Claude or Claude Code or "co-Authored-By: Claude" or Generated with Claude Code, etc. in commit, code, doc, text, comments, etc. _**

## Project

`out-of-code-insights` is a **VS Code extension** (engine `^1.95.0`, MPL-2.0) that stores annotations in a workspace JSON file (`.out-of-code-insights/annotations.json`) instead of modifying source files. It also exposes a chat participant and AI-powered annotation generation backed by multiple LLM providers.

The published bundle is `dist/extension.js` produced by webpack from `src/extension.ts` (target `node`, externals: `vscode`, `@octokit/rest`).

## Commands

Build / run:

- `npm run compile` — webpack development build (outputs `dist/extension.js`)
- `npm run package` — production webpack build (used by `vscode:prepublish`)
- `npm run package:vsix` — produces the `.vsix` artifact via `vsce`
- `npm run dev` — `concurrently` runs `watch:tsc` + `watch:webpack`

The extension is launched in dev with **F5** (Extension Development Host); there is no `npm start`.

Quality gates:

- `npm run check` — runs typecheck + `lint:ci` (0 warnings) + `format:check` together. Run this before committing.
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` / `npm run lint:fix` / `npm run format`

Tests:

- `npm test` — full integration suite. Runs `pretest` (typecheck + `tsc -p ./` to `out/`) then `node ./out/test/runTest.js`, which downloads VS Code via `@vscode/test-electron` and runs Mocha (TDD UI) against compiled `out/test/suite/**/*.test.js`. Uses `test-fixtures/` as workspace.
- `npm run test:unit` — fast Mocha pass that does **not** spawn a VS Code host. Globs `out/test/suite/unit/**/*.js`, `out/anchoring/__tests__/**/*.js`, and `out/test/integration/**/*.js`. Use this for pure-logic changes.
- Single file: `npx mocha --ui tdd out/test/suite/unit/<name>.unit.test.js` after `npm run compile-tests`.
- `npm run coverage` / `npm run coverage:check` — c8 with thresholds (lines/functions 15, branches 10).

CI on Ubuntu/Windows/macOS runs typecheck, lint, the production webpack build, then `npm test`. The webpack compile step is required before tests because the suite loads `dist/extension.js`.

## Architecture

Entry point `src/extension.ts` polyfills `AbortController` (via `node-abort-controller`) **before** any other import, then constructs the manager graph:

```
AnnotationManager (4k+ lines, the core domain) ── persists/loads annotations.json
UserProfileManager / AIProfileManager        ── user-facing + AI prompt profiles
UnifiedAIAdapter ─→ UnifiedAIProvider        ── multi-llm-ts wrapper for OpenAI, Anthropic, Azure, Mistral, Groq, Ollama, Google, OpenRouter, TogetherAI, xAI, etc.
                  └→ ClaudeCodeProvider      ── special-cased path for Claude (see below)
AnnotationsTreeDataProvider + DragAndDropController  → activity-bar `annotationsView`
NavigationStackDataProvider                  → `stackView` (back/forward history)
KanbanView                                   → webview panel
```

Activation tolerates an empty workspace: `loadAnnotations()` is a no-op until `onDidChangeWorkspaceFolders` fires.

### Annotation storage

Single JSON array at `<workspace>/<annotation.path>` (default `.out-of-code-insights/annotations.json`). The path resolver enforces a workspace-root traversal guard for relative paths. Only `AnnotationManager.loadAnnotations()` / `saveAnnotations()` touch disk; UI components mutate the in-memory `Map<string, Annotation>` and request a refresh. Schema is `Annotation` in `src/common/types.ts`.

### Anchoring (`src/anchoring/anchor.ts`)

Annotations carry `lineHash`, `contextBefore`, `contextAfter` so they can re-locate themselves after edits. `normalizeLine` collapses whitespace, `hashLine` is FNV-1a 32-bit hex, and `findAnchor` uses the `diff` package. Tests live in `src/anchoring/__tests__/anchor.test.ts` and run as part of `test:unit`.

### Claude integration is dual-adapter

`ClaudeCodeProvider` + `ClaudeSDKWrapper` prefer the `@anthropic-ai/claude-code` SDK (`annotation.claudeUseSDK = true` by default) and transparently fall back to a direct REST call when the SDK fails to load (Node version, native module, polyfill). `ClaudeSDKWrapper` is responsible for setting up the `AbortController` polyfill before importing the SDK. The webpack config intentionally **does not** externalize `@anthropic-ai/claude-code` — it must be bundled.

### LLM configuration surface

- `annotation.provider` (string id) and `annotation.model` (string)
- `llm.apiKeys.<provider>` is the source of truth for keys. Keys are also persisted to VS Code Secret Storage on first prompt; the extension migrates between the two.
- The `annotations.updateApiKey` command is the supported way to set/rotate a key. Legacy `updateOpenAIKey` / `resetOpenAIKey` were removed — do **not** re-introduce them in tests or docs.
- `aiAdapter.refreshProvider()` is invoked from `onDidChangeConfiguration` when `provider`, `model`, or `llm.apiKeys` change.

### Webviews and localization

Three webviews (Annotations Panel, Kanban, Links) currently embed HTML/CSS/JS as TS template literals inside their producing class — this is known debt, do not refactor opportunistically. CSP is set on every webview to lock script/style sources to the extension bundle.

Strings live in `package.nls.json` (en) and `package.nls.fr.json` (fr); resolve through `LocalizationManager.localize()` / `loc()`. The active language is `annotation.language` (defaults to `en`). Some inline webview strings call `loc(key, fallback)` with keys missing from both bundles — the fallback is the displayed string.

## Conventions

- **Conventional Commits** (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`), summary ≤ 72 chars, imperative mood, no trailing period.
- Branch names: `feat/...`, `fix/...`, `docs/...`, `refactor/...`, `ci/...`, `chore/...`.
- Update `CHANGELOG.md` under `[Unreleased]` for any user-visible change (Keep a Changelog 1.1).
- TypeScript is `strict` with `noImplicitReturns` and `noFallthroughCasesInSwitch`; avoid `any` where a real type exists. ESLint must pass with **zero** warnings (`lint:ci` enforces `--max-warnings 0`).
- No `console.log` in production code — log via the output channel through `src/utils/logger.ts` (`initializeLogger` / `getLogger`). Log level is configurable via `outOfCodeInsights.logLevel`.
- `.out-of-code-insights/annotations.json` is gitignored and personal — never commit it.

## Known debt to be aware of

- `src/managers/AnnotationManager.ts` is ~4,300 lines and concentrates many responsibilities. Decomposition is roadmapped; do not undertake it ad hoc inside an unrelated PR.
- Releases are tag-driven: bump `package.json` + `CHANGELOG.md`, commit `chore: release vX.Y.Z`, push, then push an annotated `vX.Y.Z` tag. `release.yml` packages and publishes to the Marketplace.
