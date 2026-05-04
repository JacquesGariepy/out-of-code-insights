# Third-Party License Summary

This document lists all direct dependencies of Out-of-Code Insights and their
declared licenses. The extension is licensed under MPL-2.0; all listed licenses
are compatible. See `NOTICE` for extended attribution notices.

No GPL, AGPL, or SSPL dependency was found in the direct dependency tree.

---

## Runtime dependencies (shipped in the VSIX)

| Package | Version | License | Notes |
|---|---|---|---|
| `@anthropic-ai/claude-code` | 1.0.128 | MIT (see NOTICE) | Declared as "SEE LICENSE IN README.md" in package.json; actual license is MIT |
| `@octokit/rest` | 21.0.2 | MIT | GitHub REST API client |
| `@vscode/codicons` | 0.0.36 | CC-BY-4.0 (icons), MIT (JS) | Icon assets require attribution; see NOTICE |
| `abort-controller` | 3.0.0 | MIT | AbortController polyfill |
| `diff` | 7.0.0 | BSD-3-Clause | Text diff utility |
| `fs-extra` | 11.2.0 | MIT | Extended filesystem operations |
| `lodash` | 4.17.21 | MIT | Utility library |
| `multi-llm-ts` | 4.0.0 | MIT | Multi-provider LLM abstraction |
| `node-abort-controller` | 3.1.1 | MIT | Node AbortController polyfill |
| `openai` | 4.104.0 | Apache-2.0 | OpenAI API client |
| `path-browserify` | 1.0.1 | MIT | Node path module for browser environments |
| `vscode-nls` | 5.2.0 | MIT | VS Code NLS / localization support |

---

## Development dependencies (not shipped in the VSIX)

| Package | License |
|---|---|
| `@types/diff` | MIT |
| `@types/fs-extra` | MIT |
| `@types/glob` | MIT |
| `@types/lodash` | MIT |
| `@types/mocha` | MIT |
| `@types/node` | MIT |
| `@types/vscode` | MIT |
| `@typescript-eslint/eslint-plugin` | MIT |
| `@typescript-eslint/parser` | MIT |
| `@vscode/test-electron` | MIT |
| `@vscode/vsce` | MIT |
| `concurrently` | MIT |
| `esbuild` | MIT |
| `eslint` | MIT |
| `eslint-config-prettier` | MIT |
| `eslint-plugin-prettier` | MIT |
| `glob` | BlueOak-1.0.0 |
| `mocha` | MIT |
| `prettier` | MIT |
| `terser-webpack-plugin` | MIT |
| `ts-loader` | MIT |
| `typescript` | Apache-2.0 |
| `webpack` | MIT |
| `webpack-cli` | MIT |
| `webpack-dev-server` | MIT |

---

## License compatibility with MPL-2.0

| License | Compatible with MPL-2.0 | Notes |
|---|---|---|
| MIT | Yes | Permissive; no copyleft requirements |
| Apache-2.0 | Yes | Permissive; patent clause is additive |
| BSD-3-Clause | Yes | Permissive |
| CC-BY-4.0 | Yes (non-code assets) | Attribution required; see NOTICE |
| BlueOak-1.0.0 | Yes | Permissive, similar to MIT |

---

## Flagged items

| Issue | Severity | Resolution |
|---|---|---|
| `@anthropic-ai/claude-code` non-SPDX license field | MEDIUM | Documented in NOTICE with actual MIT license |
| `@vscode/codicons` CC-BY-4.0 assets | MEDIUM | Attribution provided in NOTICE and README |
