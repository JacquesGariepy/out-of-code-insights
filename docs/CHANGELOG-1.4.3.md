# Out-of-Code Insights 1.4.3

This focused release makes the annotation shown beside code directly actionable
and gives annotation commands a predictable place in VS Code.

## Direct move from the code annotation

- The inline annotation is now a native, interactive Inlay Hint. Click its
  message to open the annotation or click the adjacent **Move** handle to pick
  it up.
- Move the cursor to any destination line, including another file. The target
  line is highlighted while move mode is active.
- Press **Enter** or `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) to drop, or **Escape**
  to cancel. A clickable status-bar action exposes the same operation.
- Several annotations anchored to the same line can be picked up together.
  Identity, discussions, author, tags, severity, links, review state and other
  business metadata are preserved.
- CodeLens, annotation hover links and native Comments thread actions provide
  additional mouse and keyboard entry points.

## Native menu organization

- The editor's **Out-of-Code Insights** context submenu is split into stable,
  named groups for capture, edit/move, organization, links, AI, view/tools and
  destructive operations.
- Tree and comment actions follow the same ordering instead of mixing primary,
  secondary and destructive actions.
- Commands that only make sense while an annotation is being moved are enabled
  through a dedicated VS Code context key.

## Fixed

- The CodeLens provider now reads the documented `annotation.codelens.*`
  settings. It previously read a different namespace, so disabling or changing
  CodeLens commands could be ignored.
- Move operations keep their store transaction reversible until persistence
  succeeds. A failed save now restores the original anchors instead of leaving
  editor memory and `annotations.json` out of sync.
- Direct editor move preserves team metadata and never inserts or edits source
  text.
- Resolve now preserves the annotation and sets its resolved state; the legacy
  command previously deleted the record.
- Pending debounced saves are serialized and flushed before extension shutdown.
  Failed writes remain dirty and expose a Retry action instead of silently
  losing the last mutation.
- Store-backed creation now applies the configured path, author, default
  severity and per-file limit. Enable/disabled-tag settings are
  contributed to VS Code Settings and shared by native projections.
- Removed a duplicate Chat Participant registration during activation.

## Microsoft API boundary

The stable VS Code API does not expose pointer or `dragstart` events from editor
decorations, CodeLens, Comments threads or Inlay Hints. TreeView remains the
native mouse-drag source. The inline **Move** handle therefore uses VS Code's
command-capable Inlay Hint API to enter pick-up mode, which provides the same
exact-line and cross-file result with a visible target and accessible keyboard
controls.

## Next focused releases

- **1.4.4:** deterministic annotation-aware copy/paste through
  `DocumentPasteEditProvider`, plus conflict-safe persistence.
- **1.4.5:** developer review inbox, changed-file/current-diff filters and
  annotation health diagnostics.
- Desktop **0.1.2:** direct manipulation from the tree, drawer, detail view and
  Kanban into the code preview.
