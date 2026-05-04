# ADR-001: Store Annotations as a JSON File in the Workspace

**Date:** 2024-12-04 (reconstructed)
**Status:** Accepted
**Deciders:** Jacques Gariepy

---

## Context

The extension must persist annotations across VS Code sessions. Several storage
options exist:

- A SQLite database bundled with the extension.
- A cloud API (Firebase, Supabase, custom backend).
- A JSON file stored inside the workspace folder.
- VS Code `globalState` / `workspaceState` (memento API).

Key constraints:
- Annotations should be shareable across team members via version control.
- No external service dependency for the default (offline-first) use case.
- The storage format must be human-readable for debugging and manual recovery.
- The extension must work without a workspace folder (graceful no-op).

---

## Decision

Annotations are stored in a JSON array at
`<workspace>/.out-of-code-insights/annotations.json`.

The path is configurable via the `annotation.path` VS Code setting. Custom
paths are validated to prevent traversal outside the workspace root.

When no workspace folder is open, persistence is a no-op; annotations
accumulate in memory and are discarded when the window closes.

---

## Consequences

**Easier:**
- Teams can version-control annotations alongside source code using git.
- Annotations are portable: copy the JSON file to share or migrate.
- No backend service is required; the extension works fully offline.
- Debugging storage issues is straightforward (open the JSON file).

**Harder:**
- Concurrent writes from multiple VS Code windows on the same workspace can
  cause data races. The current implementation does not use file locking.
- The `AnnotationManager` class concentrates all I/O; it has grown to ~3,450
  lines (tracked as a known-debt issue).
- Merge conflicts in `annotations.json` require manual resolution.

**Trade-offs accepted:**
- Simpler architecture over concurrent-write safety (single-user assumption).
- God-object I/O class over premature decomposition at v1.
