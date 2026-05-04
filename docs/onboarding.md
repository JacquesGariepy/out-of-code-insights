# New Contributor Onboarding

This guide walks you through setting up a development environment, running the
extension, debugging, and submitting your first contribution.

---

## Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| VS Code | 1.95.0 | Required as the extension host |
| Node.js | 18 LTS (20 recommended) | Use `.nvmrc`: `nvm use` |
| npm | 9+ | Comes with Node.js |
| git | Any recent version | |

Install Node with [nvm](https://github.com/nvm-sh/nvm):
```bash
nvm install 20
nvm use
```

---

## Clone and install

```bash
git clone https://github.com/JacquesGariepy/out-of-code-insights.git
cd out-of-code-insights
npm install
```

---

## Launch the extension in development mode (F5)

1. Open the cloned folder in VS Code: `code .`
2. Press **F5** (or select **Run > Start Debugging** from the menu).
3. A new VS Code window opens: the **Extension Development Host**.
4. Open any folder in the host window to activate the extension.
5. Breakpoints set in `src/` will be hit inside the host window.

The F5 launch configuration is defined in `.vscode/launch.json` (auto-created
by VS Code when a TypeScript extension project is opened).

---

## Build

Compile TypeScript sources to `out/` (development, with source maps):
```bash
npm run compile
```

Watch mode (recompiles on save):
```bash
npm run watch:tsc         # TypeScript type-check pass
npm run watch:webpack     # Webpack bundle
npm run dev               # Both in parallel (concurrently)
```

Production bundle (minified, no source maps):
```bash
npm run package
```

---

## Type-check

```bash
npm run typecheck
```

---

## Lint and format

```bash
npm run lint              # Report ESLint violations
npm run lint:fix          # Auto-fix where possible
npm run format            # Reformat with Prettier
npm run format:check      # Check formatting without writing
```

Run all checks in one command:
```bash
npm run check
```

---

## Run tests

```bash
npm test
```

This command:
1. Runs `npm run typecheck` and `npm run compile-tests` (via `pretest`).
2. Downloads a VS Code binary via `@vscode/test-electron`.
3. Launches the Mocha test suite inside the VS Code host.
4. Loads `test-fixtures/` as the test workspace.

To run only unit tests (no VS Code host required):
```bash
npm run test:unit
```

---

## Debug tests

1. In VS Code, open the **Run and Debug** panel (Ctrl+Shift+D).
2. Select the **"Extension Tests"** launch configuration.
3. Press F5. The test host window opens with the debugger attached.
4. Breakpoints in `src/test/suite/*.ts` and in source files will be hit.

---

## Project layout

```
src/
  extension.ts            Entry point: activate(), command registration
  common/                 Shared types, localize helper
  managers/               Domain logic (annotations, profiles, kanban, links)
  providers/              LLM adapters (UnifiedAIAdapter, ClaudeCodeProvider)
  tree/                   VS Code TreeView data providers
  views/                  Webview-backed panels (Kanban)
  test/                   Mocha + @vscode/test-electron test suite

docs/                     Architecture and contributor documentation
test-fixtures/            Workspace used by the test host
.github/                  CI workflows, issue templates, Dependabot
```

---

## Make a change

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. Make your changes. Follow the code style rules in [CONTRIBUTING.md](../CONTRIBUTING.md).

3. Run `npm run check` to verify type-check, lint, and format pass.

4. Run `npm test` to verify the test suite passes.

5. If your change is user-visible, update `CHANGELOG.md` under `[Unreleased]`.

6. Open a pull request against `main`.

---

## Good first issues

Browse issues tagged [`good-first-issue`](https://github.com/JacquesGariepy/out-of-code-insights/labels/good-first-issue)
for well-scoped entry points. Issues tagged `help wanted` are also suitable for
first-time contributors.

---

## Getting help

- **Bug or question about the code**: open a [GitHub Issue](https://github.com/JacquesGariepy/out-of-code-insights/issues).
- **Security vulnerability**: email `jacques.gariepy@outlook.com` as described in [SECURITY.md](../SECURITY.md).
- **Community questions**: use [GitHub Discussions](https://github.com/JacquesGariepy/out-of-code-insights/discussions).
