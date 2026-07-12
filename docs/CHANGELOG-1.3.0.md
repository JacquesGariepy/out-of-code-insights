# Out-of-Code Insights 1.3.0

## Added

- **Re-anchor Annotation to Current Cursor** repairs an orphaned, stale, or
  deliberately moved annotation from the command palette, tree item context
  menu, or annotation panel.
- Re-anchoring supports cross-file recovery and atomically refreshes the file
  URI, workspace-relative path, language, UTF-16 range, line hash, and anchor
  context while preserving the annotation identity and discussion.
- **Show Annotation Tracking Diagnostics** opens a local JSON report with
  lifecycle counts, invariant violations, open-document resolution, offset
  health, and hash-match decisions.
- Diagnostics deliberately omit source text; only identifiers, paths,
  offsets, hashes, states, origins, and issue codes are reported.
- The annotation panel now provides persisted **Comfortable** and **Compact**
  density modes with accessible pressed-state controls.

## Fixed

- Manual re-anchoring onto a shorter destination line no longer preserves an
  oversized source range that could spill into the following line.
- Programmatic line moves now reject negative, fractional, and out-of-range
  targets instead of relying on editor-specific range failures.
- Re-anchoring from a focused webview now falls back to the sole visible text
  editor, or asks which visible editor contains the destination cursor.
- Multi-line cut/paste no longer leaves a stale original plus a fresh-id copy
  when an editor host fragments or omits the block-deletion event. A stale
  active source is recognized by its live hash mismatch and moved with the
  same identity.
- Marketplace packages no longer include internal agent state, test
  workspaces, logs, reports, task ledgers, or other repository-only tooling.

## Validation

- ESLint passes with zero warnings and TypeScript type-check passes.
- 492 Node unit and transactional tests pass.
- 407 Electron integration tests pass in an activated VS Code extension host;
  6 environment-dependent cases remain explicitly pending.
- Focused regression coverage includes range validation, diagnostic privacy,
  closed documents, suspended annotations, and hash drift.
