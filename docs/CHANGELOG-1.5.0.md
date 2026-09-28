# 1.5.0 — Insights: statistics, reports and diagnostics

Release date: 2026-09-28.

## Outcome

Version 1.5.0 turns the annotation store into something a team can measure and audit. It adds a live statistics dashboard, shareable Markdown and HTML reports, a CSV export, and a one-command import of the diagnostics VS Code already computes. These deliver roadmap items #2, #4 and #5.

## Statistics dashboard

`annotations.showStatistics` (editor → **View & Search**) opens a panel beside the editor showing total, open and resolved counts, the resolution rate, breakdowns by severity, author and tag, the ten most annotated files and a cumulative trend line. A severity and a status filter narrow every figure at once, and the panel follows the store, so annotations added or resolved while it is open are reflected within a fraction of a second.

- Charts are inline SVG and CSS bars. No charting library is bundled and nothing is fetched.
- The page runs under `default-src 'none'` with nonce-only `script-src` and `style-src`, no inline event handlers and no inline `style` attributes.
- Every annotation-derived string is HTML-escaped.
- Messages from the webview are validated (command allow-list, string length bounds, enumerated status) before anything happens.

## Reports and CSV

`annotations.exportReport` asks for a format (Markdown or HTML) and a scope (all annotations, or open only), then writes the file where you choose. Both formats contain the summary statistics followed by the annotation list, unresolved and most severe first, capped at 500 detailed entries while the statistics always cover everything.

- Markdown escapes untrusted text and renders file names as code spans that cannot be broken out of.
- HTML is fully self-contained, adapts to light and dark mode and forbids scripts through its own Content-Security-Policy.

`annotations.exportStatisticsCsv` writes RFC 4180 CSV. Cells that would be interpreted as formulas by a spreadsheet (leading `=`, `+`, `-`, `@`, tab or carriage return) are neutralised with a leading apostrophe.

## Import diagnostics as annotations

`annotations.importDiagnostics` (editor → **Import/Export & Tools**) converts the diagnostics currently reported for workspace files into annotations.

- Severity is mapped `Error → error`, `Warning → warn`, everything else `info`. Only diagnostics at least as severe as `annotation.diagnostics.minSeverity` (default `warning`) are imported.
- Each annotation reads `[source code] message` and carries the tags `imported-diagnostic`, a category tag and the source name. Built-in categories: `style` (ESLint, TSLint, Stylelint, Pylint, Flake8, Ruff, Prettier), `types` (TypeScript, Pyright, mypy), `security` (Bandit, Semgrep, Snyk, CodeQL) and `quality` (SonarLint, SonarQube, Clippy, gopls). `annotation.diagnostics.sourceTags` overrides or extends the mapping.
- At most `annotation.diagnostics.maxPerFile` (default 50) annotations are created per file, most severe first.
- Running the command twice creates nothing new: an annotation with the same message on the same line is skipped.
- Files outside the workspace, non-`file` schemes and files over 2 MiB are ignored.

Every imported annotation carries the `imported-diagnostic` tag, so a batch can always be identified afterwards.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `annotation.diagnostics.minSeverity` | `warning` | Least severe diagnostic to import |
| `annotation.diagnostics.maxPerFile` | `50` | Cap per file per import |
| `annotation.diagnostics.sourceTags` | `{}` | Per-source tag overrides |

## Validation

- 27 new unit tests cover aggregation, date and field filtering, CSV escaping and formula defusing, report escaping and caps, diagnostic mapping, deduplication and the dashboard's CSP and message validation.
- The existing native-menu tests confirm all four new commands are reachable from the editor hub.
- `npm run check`, the full unit suite and the production webpack build pass.

## Not included

- PDF reports (roadmap item #4 asks for PDF; Markdown and HTML ship first and print to PDF from any browser).
- Live diagnostics listening. The import is an explicit command, so annotations are never created behind your back.
