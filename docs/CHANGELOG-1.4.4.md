# 1.4.4 source candidate — Documentation Studio and guided workflows

> Prepared on 2026-07-13; candidate verification remains in progress. This
> version must not be published or tagged until the user gives explicit release
> confirmation.
> The Marketplace and Open VSX release remains 1.4.3.

## Outcome

Version 1.4.4 turns the previous Markdown generator into a managed,
reproducible technical-document pipeline. A single annotation corpus can
produce repository documents, a navigable static project, wiki packages, an
autonomous web site, and a constrained API-catalogue projection. Public preset
IDs do not require users to name a build engine, while current outputs are
implemented by bundled adapters.

The same candidate also completes a menu-first interaction pass: 86 public
commands have visible homes, both trees guide first-time users, historical
cursor-only mutations offer pickers, canonical links are tested end to end,
credentials have one guided manager and annotations can create authenticated
GitHub development issues.

## Document catalogue

- README sections (`doc:readme`)
- curated changelog entries (`doc:changelog`, explicit release/version and
  category tags, plus an optional explicit date)
- architecture pages (`doc:architecture`)
- one append-only record per architecture decision (`doc:adr`)
- developer onboarding (`doc:onboarding`)
- operational runbooks (`doc:runbook`)
- technical reference (`doc:reference`)
- existing module/class/function/example/guide pages

Built-in presets select a useful combination; a repository-owned JSON preset
can select document kinds, output profiles and bounded structure settings. Page
layouts remain built in. The configuration command uses native multi-selection
pickers and persists only explicit overrides.

## Output and safety

- Deterministic Markdown/navigation graph with collision-safe page names.
- Static-project adapter with stable page identity and build diagnostics.
- Portable, flattened/hosted and hierarchical/ordered wiki packages.
- Autonomous accessible HTML: local CSS, CSP, landmarks, skip link, visible
  focus, dark mode, reduced motion, escaped annotation content and linked safe
  HTML projections of the selected technical documents.
- Complete task-oriented native menus: all 86 contributed user commands have a
  menu home, with dedicated **Documentation**, **Review Workflow**, **Kanban**
  and **Settings & Accounts** groups, focused tree-row actions and a compact
  Explorer hub.
- Empty-state welcome links in both trees expose Add, workspace import, panel,
  documentation setup and settings without requiring Command Palette knowledge.
- Guided changelog and architecture-decision capture so required metadata does
  not depend on memorized tags.
- Constrained OpenAPI catalogue projection; explicit annotation-ID bindings
  from the supported profile subset are the only route source. A compatibility
  serializer remains opt-in.
- Staging + backup + rollback write transaction.
- SHA-256 managed-file manifest; stale cleanup trusts only a valid prior
  manifest and preserves unrelated output files.
- Structured report for renderer warnings/errors, consumable by CI.
- Guided comment/header/docblock ↔ annotation conversion backed by a
  language-aware catalogue of 42 syntax IDs: 37 primary modes covered by the
  catalogue test and five compatibility aliases/extras. Both directions
  preview selectable records and require confirmation; source writes use one
  undoable `WorkspaceEdit` and sanitized `OOCI(...)` identity markers prevent
  rerun duplicates.
- Comment import remains available for `typescriptreact`, `javascriptreact`,
  `vue` and `php`; reverse writing is deliberately disabled in those four
  mixed-context modes until syntax-aware region placement is implemented.

## Guided developer and team workflows

- Edit, Delete, Pin, Severity, file Batch Edit and Move Up/Down accept an
  explicit menu target, then the cursor, then a guided picker. They no longer
  silently require an editor; Delete and Batch Edit show modal confirmation.
- Public link creation, navigation, incoming/outgoing inspection and removal
  use the canonical store. New links retain target identity and URI, survive
  target movement and resolve legacy relative paths from the source workspace
  in multi-root windows.
- **Configure AI Provider & Credentials** covers the exact 13-provider
  catalogue with
  add/update/remove and an explicit visible-settings or secret-storage choice.
  It keeps one selected source, removes legacy/canonical alternatives and
  reports failures visibly.
- LM Studio replaces the unsupported TogetherAI provider ID. Azure setup
  captures endpoint, deployment and API version; Ollama and LM Studio use
  configurable local URLs and do not require a key.
- **Create GitHub Development Issue from Annotation** is available in editor
  and tree menus plus the Command Palette. It validates a workspace repository
  and title, confirms the network mutation, authenticates through VS Code,
  creates through Octokit, records the issue URL locally and optionally opens
  it. It never requests or stores a manual PAT.
- If remote issue creation succeeds but the annotation trace cannot be saved,
  the extension reports that split result and preserves **Open Issue** to avoid
  an accidental duplicate retry.

## Correctness fixes

Template variables and literal replacements now work, template imports are
validated, persistent mutations are awaited/serialized, failed persistence
rolls memory back, duplicate names select by stable ID, and returned templates
are defensive copies. Template create/edit also captures severity and opens
multiline content in a temporary VS Code document. Documentation generation no longer accepts an empty
output path, drops concurrent watch requests, skips empty-store cleanup, loses
pages through slug collisions, or emits unsafe YAML labels.

Closed-file tree/history/link navigation and GitHub issue bodies now derive
their line from the canonical UTF-16 offset. Issue trace persistence re-fetches
the current annotation after the network request. The Kanban board resolves
real lines, owns one disposable live listener, validates messages, escapes
boot data, and removes cards to a dedicated hidden assignment. Review F8 works
with panel focus and duplicate stack-view registration is gone.

Persistence now uses synchronized exclusive temporary files and atomic rename,
preserves the last good envelope on failure, removes failed temporaries and
rejects physical link/junction escapes. Deserialization validates the complete
v2 payload before replacing live state. Editor drop rejects files outside the
workspace and rolls back a move if cancellation arrives after mutation. The
extension still activates without a folder so menus/setup remain available.
Opening a folder normally reloads the window and attaches persistence plus
move/drop services; adding the first folder to an already-running empty window
requires **Developer: Reload Window**.

Self-authored annotation-store watcher events are now identified by the
canonical SHA-256 of the bytes just committed rather than a time window. A
nearby external edit therefore remains observable. Atomic replacement also
retries only transient Windows rename failures with bounded backoff and
revalidates the temporary and destination endpoints before every attempt; no
non-atomic fallback is used. Comments edits and public lifecycle commands wait
for durable persistence before they resolve. Thread-context deletion also
unwraps the `CommentReply` argument supplied by the VS Code Comments API while
preserving direct-thread and annotation-ID automation paths; its focused pure
argument-resolution regression passes 3/3.

The documentation writer now serializes generations FIFO for each canonical
output, processes independent files with bounded concurrency and publishes its
verified recovery journal through a no-overwrite atomic rename. Staging,
backup and installation revalidate real parent directories, keep the old
manifest until all content is backed up, install the new manifest last and
clean or recover the complete transaction on ordinary failure. Extension Host
tests use isolated profiles (or an explicit warm-profile override), and
mutation regressions use deterministic clipboard helpers where native focus is
not the behavior under test.

Obsolete credential/search/focus/activity/edit/severity/link command aliases
were removed. The remaining ten runtime-only commands are an exact tested
allow-list: eight Kanban webview protocols and two target-bearing panel/CodeLens
bridges.

## Validation expected before release confirmation

- TypeScript typecheck and production bundle
- ESLint and formatting checks
- complete Node unit/integration suite
- focused Extension Host documentation/template flows
- mocked GitHub authentication/API transaction and AI credential lifecycle
  coverage remain follow-up QA; existing GitHub tests make no network request
- package/audit and VSIX smoke installation
- JSONP task-ledger parse and JSON Schema parse
- generated-bundle inspection, including stale cleanup and hostile inputs

The release/tag/marketplace steps are intentionally excluded until explicit
confirmation is received.
