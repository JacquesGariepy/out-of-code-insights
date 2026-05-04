# Roadmap

This document tracks features proposed for upcoming releases of
**Out-of-Code Insights**. Each item lists the effort estimate, what
it depends on, and the user value. Items are ordered by suggested
release; within a release they are roughly ordered by value/effort.

The roadmap is a *proposal*  -  issues, discussion, and contributions
are welcome. Items are tracked as GitHub Issues with the label
`roadmap`.

---

## v1.1  -  Quick wins (target: ~15h)

### 1. Auto-detect TODO / FIXME / HACK / XXX

**What**  -  Scan open source files for `TODO`, `FIXME`, `HACK`, and
`XXX` markers in comments and convert them into annotations.
Optional bidirectional mode: editing the annotation rewrites the
code comment, and vice versa.

**Why now**  -  Closes the obvious gap versus *Better Comments* and
*TODO Tree*. Removes the friction of manually capturing pre-existing
technical debt; existing codebases gain hundreds of annotations on
day one.

**Effort**  -  small (~4h). Regex-based parsing per language, reuse
of the existing severity/tags pipeline.

**Depends on**  -  Nothing structural. Benefits from severity and
tags, both already present.

---

### 2. Annotations from VS Code diagnostics

**What**  -  Listen to the VS Code Diagnostics API (ESLint, TSLint,
Pylint, SonarQube, the TypeScript compiler itself) and convert
high-severity diagnostics into annotations. Auto-tag them with
`security`, `perf`, `style` based on the diagnostic source.
Per-source mapping is configurable.

**Why now**  -  Data is already available in VS Code; the user does
nothing. This captures real, existing technical debt with zero
input effort. Combined with the AI pipeline, diagnostics can be
enriched into actionable suggestions.

**Effort**  -  small (~6h). `vscode.languages.onDidChangeDiagnostics`
listener, severity mapping, tag dispatch.

**Depends on**  -  Nothing.

---

### 3. Context-aware annotation templates

**What**  -  When the user creates an annotation, infer the file's
nature (test file, config, controller, view, migration) from path
and extension, and propose a templated structure (bug-report,
security-review, doc-question…) plus a matching AI prompt for the
active profile.

**Why now**  -  `TemplateManager` and `UserProfileManager` already
exist; this stitches them together. Major UX win for non-power
users who do not memorise template IDs.

**Effort**  -  small (~5h). File-pattern → template mapping table,
profile lookup, command dispatch.

**Depends on**  -  Existing `TemplateManager` and
`UserProfileManager`  -  no schema change.

---

## v1.2  -  Production / collaboration (target: ~18h)

### 4. Multi-format reports (PDF / Markdown / HTML)

**What**  -  Export annotations as a structured report (PDF for
audits, Markdown for issue trackers, HTML for sharing) with
filtering by date range, severity, author, file, and tag. Includes
aggregate statistics (counts by severity, top-annotated files,
resolution rate).

**Why now**  -  JSON export is sufficient for tooling, not for
audits, retrospectives, or stakeholder reports. Closes the gap
versus Notion / Confluence for code-review documentation.

**Effort**  -  medium (~8h). `pdfkit` or `html2pdf` for PDF, simple
Markdown templating, aggregation over the in-memory annotation
store.

**Depends on**  -  None. Feeds into #5.

---

### 5. Real-time statistics dashboard

**What**  -  A dedicated webview displaying live metrics: total
annotations, breakdown by severity / author / file, time-series
trend, most-annotated files, resolution rate. Interactive filters
and CSV export.

**Why now**  -  Code-quality visibility is a manager-level concern
that no comparable extension addresses. Builds on data already in
the store; scales to large teams.

**Effort**  -  medium (~10h). New webview (template
re-usable from `KanbanView`), Chart.js or D3 for visualisation,
aggregation queries against the JSON store.

**Depends on**  -  None structurally. Shares aggregation code with
#4.

---

## v1.3  -  Team collaboration (target: ~30h)

### 6. Git-based collaborative annotations

**What**  -  Annotations live alongside code in
`.out-of-code-insights/annotations.json` (already the case),
which Git versions and merges. Add: an in-extension merge tool
for annotation-conflict resolution, a `blame` view showing who
authored each annotation, and a branch-aware "annotations on
this branch only" filter.

**Why now**  -  The natural path for distributed teams. The storage
format is already file-based; the missing piece is a UX for
conflicts. No competing extension does this well.

**Effort**  -  medium (~12h). Git diff parsing (via `simple-git` or
`nodegit`), three-way merge UI, blame integration.

**Depends on**  -  Git CLI present, `simple-git` package.

---

### 7. Bidirectional sync with GitHub / GitLab Issues

**What**  -  Two-way sync between annotations and tracker issues.
Convert an annotation into a GitHub or GitLab Issue (already
partially supported via Octokit, GitHub-only). Import open issues
of a repo as annotations on referenced files. Display issue status
inside the annotation panel; close-on-resolve.

**Why now**  -  Octokit is already a dependency  -  the one-way
"create issue from annotation" flow exists but the reverse and
GitLab parity are missing. Team adoption depends on this.

**Effort**  -  large (~18h). GitLab API client, two-way mapping,
optional webhook listener, conflict resolution.

**Depends on**  -  Existing Octokit integration; new `@gitbeaker/node`
or similar for GitLab.

---

## v2.0  -  Intelligence (target: ~46h)

### 8. AI clustering / duplicate detection

**What**  -  Use embedding APIs (OpenAI, Voyage, etc.) to compute
vector representations of annotation text. Cluster similar
annotations, flag near-duplicates, suggest consolidating with the
existing linked-annotation system.

**Why now**  -  Real signal-to-noise problem in codebases with 1000+
annotations. Multi-LLM framework already in place; embeddings are a
small extension. No competitor addresses this.

**Effort**  -  large (~20h). Embedding integration, lightweight
vector store (sqlite-vec or in-memory), review UI, refactor of
`LinkedAnnotationManager` to surface clustering hints.

**Depends on**  -  Existing multi-LLM pipeline. Possibly a
vector-store dependency.

---

### 9. Optional cloud sync (multi-workspace)

**What**  -  Optional cloud backend (Firebase / Supabase or
self-hostable) to synchronise annotations across machines and
workspaces for a single account. Local-only remains the default.

**Why now**  -  Friction for distributed teams who don't want to
commit annotations to the repository.

**Effort**  -  large (~16h). Pluggable backend interface, auth,
conflict resolution, opt-in flow, fallback to local.

**Depends on**  -  None directly. Should respect security/privacy
policies and document data location prominently.

---

### 10. Code-hotspot annotations

**What**  -  Combine `git log` change-frequency analysis with the
current AI pipeline to detect "hotspot" zones (files or functions
edited unusually often). Surface these in the Kanban as a
dedicated column and proactively suggest annotations ("this method
is changed every 2 weeks  -  possible refactor candidate").

**Why now**  -  Unique combination of git history + LLM analysis
that no extension does. Direct value to engineering managers and
architects.

**Effort**  -  medium (~10h). Git log parsing, heatmap
calculation, prompt engineering for the hotspot context.

**Depends on**  -  Git integration (#6 helps), `KanbanView`,
existing AI adapter.

---

## Summary

| Release | Items | Effort | Theme |
|---|---|---|---|
| v1.1 | #1, #2, #3 | ~15h | Quick wins, immediate user value |
| v1.2 | #4, #5 | ~18h | Production / reporting |
| v1.3 | #6, #7 | ~30h | Team collaboration |
| v2.0 | #8, #9, #10 | ~46h | Intelligence |

**Top-priority value/effort cluster**: #1, #2, #3, #4, #6 deliver
five high-value features in roughly 50 hours. Strict prioritisation
order: **collaboration & production > intelligence > polish**.

Roadmap items become tracked work only when an issue is opened on
GitHub against this document. Contributions welcome  -  see
[CONTRIBUTING.md](../CONTRIBUTING.md).
