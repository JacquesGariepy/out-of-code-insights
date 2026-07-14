# Command and Menu Reference

Out-of-Code Insights contributes 86 categorized commands. Every one has a
visible native menu home, so knowing a command ID or shortcut is optional.

## Start from the surface you are using

| Where you are                                                 | What to open                                                                                               | What it contains                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Code editor                                                   | Right-click → **Out-of-Code Insights**                                                                     | The complete task-oriented hub, split into 11 groups                                                    |
| **Out-of-Code Insights** or **Annotations Explorer** tree row | Right-click the annotation                                                                                 | Inline Edit/Move plus Move, State, Links, Documentation and Delete actions                              |
| Either Annotations tree                                       | Use Search, Panel or Bulk in the view title; open its `...` menu for **More Out-of-Code Insights Actions** | Workspace filters, review, Kanban, import/export, templates, snippets, documentation, sync and settings |
| Explorer file                                                 | Right-click → **Out-of-Code Insights**                                                                     | Panel, search, Kanban, workspace comment import, documentation and settings                             |
| Native annotation comment                                     | Right-click the comment or use the thread title actions                                                    | Reply, resolve/reopen, move and delete                                                                  |
| Anywhere                                                      | Press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS), then type **Out-of-Code Insights** or the action name       | 77 searchable commands; guided pickers or prerequisite messages resolve missing context                 |

Nine Tree/Comments helper commands intentionally stay out of the Command
Palette because they require a specific row or comment thread. They remain
visible on that target's context menu.

Public annotation mutations do not silently depend on an open editor. Edit,
Delete, Pin, Severity, Move Up and Move Down use the supplied menu target, the
annotation at the cursor, or a guided annotation picker in that order. Batch
Edit similarly offers a file picker. Delete and Batch Edit require an explicit
modal confirmation.

When either annotation tree is empty, its welcome screen provides direct links
to add the first annotation, import workspace comments, open the panel,
configure documentation or open settings. This is the guided starting point
for a first-time user.

The extension activates without an open workspace so setup, menus and
diagnostics remain available. Workspace persistence and move/drop transactions
remain unavailable until a folder is opened.

## Editor right-click hub

The editor hub exposes 11 named task groups:

| Menu group                | Typical workflows                                                              |
| ------------------------- | ------------------------------------------------------------------------------ |
| **View & Search**         | Open, filter, navigate and diagnose annotations                                |
| **Edit & Organize**       | Add, edit, reply, pin, classify and batch-edit                                 |
| **Move & Re-anchor**      | Pick up, drop, cancel, recover and exact-line movement                         |
| **Links & Collaboration** | Create, remove, inspect and navigate relationships; create a development issue |
| **Review Workflow**       | Start, filter, step through and complete a review                              |
| **Templates & Snippets**  | Create, apply, preview and manage reusable content                             |
| **Documentation**         | Add documentation roles, configure presets and generate output                 |
| **Kanban**                | Open the board, add columns and move work                                      |
| **AI Analysis**           | Suggest, analyze, batch-create and configure AI profiles                       |
| **Import/Export & Tools** | Import, export, MCP setup, agent setup and support tools                       |
| **Settings & Accounts**   | Extension settings, profiles, diagnostics, license and API keys                |

Documentation configuration and generation are deliberately repeated in the
editor, both annotation trees and Explorer. This makes the workflow reachable
without first learning the Command Palette.

---

## Annotation lifecycle

Menu home: editor → **Out-of-Code Insights → Edit & Organize**. Resolve and
metadata actions also appear on tree rows under **State & Metadata**.

| Command ID                 | Title                          | Default keybinding |
| -------------------------- | ------------------------------ | ------------------ |
| `annotations.add`          | Add Annotation                 | `Ctrl+Alt+A`       |
| `annotations.edit`         | Edit Annotation                | `Ctrl+Alt+E`       |
| `annotations.delete`       | Delete Annotation              | `Ctrl+Alt+D`       |
| `annotations.reply`        | Reply to Annotation            | --                 |
| `annotations.clearAll`     | Clear All Annotations          | --                 |
| `annotations.pinToggle`    | Toggle Annotation Pin          | --                 |
| `annotations.setSeverity`  | Set Annotation Severity        | --                 |
| `annotations.editTags`     | Edit Annotation Tags           | --                 |
| `annotations.resolve`      | Resolve Annotation             | --                 |
| `annotations.markAsViewed` | Mark Annotation as Viewed      | --                 |
| `annotations.batchEdit`    | Batch Edit Annotations in File | --                 |

---

## Tree and bulk actions

Menu home: right-click an annotation in either tree. Select several rows and
use **Bulk Actions** in the tree title, or run the command and choose rows from
the multi-select picker.

| Command ID                    | Title                                 | Default keybinding |
| ----------------------------- | ------------------------------------- | ------------------ |
| `annotations.bulkActions`     | Bulk Actions for Selected Annotations | --                 |
| `annotations.treeEdit`        | Edit Annotation                       | --                 |
| `annotations.treeDelete`      | Delete Selected Annotations           | --                 |
| `annotations.treeTogglePin`   | Toggle Pin for Selected Annotations   | --                 |
| `annotations.treeSetSeverity` | Set Severity for Selected Annotations | --                 |

---

## Display and navigation

Menu home: editor → **Out-of-Code Insights → View & Search**; common workspace
views are repeated in the tree `...` and Explorer hubs.

| Command ID                       | Title                                       | Default keybinding |
| -------------------------------- | ------------------------------------------- | ------------------ |
| `annotations.show`               | Open Annotations Panel                      | `Ctrl+Alt+S`       |
| `annotations.toggleDisplay`      | Show or Hide Annotation Decorations         | `Ctrl+Alt+T`       |
| `annotations.navigate`           | Choose and Open an Annotation               | --                 |
| `annotations.moveUp`             | Move Annotation Up                          | --                 |
| `annotations.moveDown`           | Move Annotation Down                        | --                 |
| `annotations.nextAnnotation`     | Next Annotation                             | `F8`               |
| `annotations.previousAnnotation` | Previous Annotation                         | `Shift+F8`         |
| `stack.back`                     | Go Back in Annotation Navigation History    | `Alt+Left`         |
| `stack.forward`                  | Go Forward in Annotation Navigation History | `Alt+Right`        |

Navigation resolves the current line from the canonical annotation offset,
including when the destination file was closed. GitHub issue descriptions use
the same canonical source line instead of a stale compatibility line number.

---

## Search

| Command ID                     | Title                                   | Default keybinding |
| ------------------------------ | --------------------------------------- | ------------------ |
| `annotations.keywordSearch`    | Search Annotation Messages and Metadata | --                 |
| `annotations.filterBySeverity` | Filter Annotations by Severity          | --                 |

---

## Move and recovery

Menu home: editor or tree row → **Move & Re-anchor**. A tree/panel drag can be
dropped onto an exact editor line; inline projections provide the accessible
Pick Up → move cursor → Enter/Drop workflow.

| Command ID                       | Title                                         | Default keybinding |
| -------------------------------- | --------------------------------------------- | ------------------ |
| `annotations.moveByDragAndDrop`  | Move Selected Annotations with Drag and Drop… | --                 |
| `annotations.pickUpForMove`      | Pick Up Annotation to Move                    | --                 |
| `annotations.dropPickedAtCursor` | Drop Annotation at Cursor                     | `Ctrl+Alt+M`       |
| `annotations.cancelPickedMove`   | Cancel Annotation Move                        | `Escape`           |
| `annotations.reanchorToCursor`   | Re-anchor Annotation to Current Cursor        | --                 |

---

## Linked annotations

Menu home: editor → **Links & Collaboration**. Every annotation tree row also
exposes **Links & Collaboration**: create is always available, while navigate,
inspect and remove appear when the row has links.

**Create GitHub Development Issue from Annotation** is available on every tree
row and in the tree `...` menu. It validates and saves a workspace
`owner/repository`, lets the user edit the title, requires modal confirmation,
then authenticates through VS Code's GitHub provider. It stores no manual PAT;
after creation it records the issue URL in the annotation thread and offers to
open it. A post-creation trace-save failure is reported separately and keeps
the remote URL available through **Open Issue**.

New links persist the target annotation ID and URI in addition to legacy
display coordinates. Moving or re-anchoring a target therefore preserves the
relationship and cycle detection. Legacy file/line links still load; their
relative paths resolve from the source annotation's owning workspace, not an
arbitrary first folder in a multi-root window.

| Command ID                           | Title                                           | Default keybinding |
| ------------------------------------ | ----------------------------------------------- | ------------------ |
| `annotations.createLink`             | Create Annotation Link                          | --                 |
| `annotations.removeLink`             | Remove Annotation Link                          | --                 |
| `annotations.navigateToLinked`       | Navigate to Linked Annotation                   | `Ctrl+Alt+L`       |
| `annotations.showLinks`              | Show Incoming and Outgoing Annotation Links     | --                 |
| `annotations.createDevelopmentIssue` | Create GitHub Development Issue from Annotation | --                 |

---

## Templates

Menu home: editor → **Templates & Snippets**; **Manage Templates** is also in
the tree `...` menu and offers create, edit, delete, JSON import and JSON export.
Create/Edit captures severity and opens multiline template content in a
temporary VS Code document, so normal editor navigation and editing remain
available before the template is saved.

| Command ID                    | Title                      | Default keybinding |
| ----------------------------- | -------------------------- | ------------------ |
| `annotations.createTemplate`  | Create Annotation Template | --                 |
| `annotations.applyTemplate`   | Apply Template             | `Ctrl+Shift+Alt+T` |
| `annotations.manageTemplates` | Manage Templates           | --                 |

---

## Code snippets

| Command ID                   | Title                          | Default keybinding |
| ---------------------------- | ------------------------------ | ------------------ |
| `annotations.addSnippet`     | Add Code Snippet to Annotation | --                 |
| `annotations.applySnippet`   | Apply Code Snippet             | --                 |
| `annotations.previewSnippet` | Preview Snippet Changes        | --                 |
| `annotations.manageSnippets` | Manage Snippet History         | --                 |

---

## Review mode

Menu home: editor → **Review Workflow** or tree `...`. Start Review first;
filter, next/previous, mark-viewed and stop actions enable only during a review.
`F8` and `Shift+F8` remain review-aware when a panel or tree has focus; outside
Review Mode they preserve VS Code's normal next/previous navigation behavior.

| Command ID                      | Title                              | Default keybinding |
| ------------------------------- | ---------------------------------- | ------------------ |
| `annotations.startReview`       | Start Review Mode                  | --                 |
| `annotations.stopReview`        | Stop Review Mode                   | --                 |
| `annotations.reviewMode.filter` | Filter the Annotation Review Queue | --                 |
| `annotations.autoResolveStale`  | Resolve Old Annotations            | --                 |

---

## Kanban board

Menu home: editor → **Kanban**, tree `...`, or Explorer → **Out-of-Code
Insights**. Add Column and Move to Column update the same persisted Kanban
column definitions and assignments used by the board.

The board derives display lines from canonical offsets, owns and disposes one
live-update subscription, validates webview messages, and escapes initial
script data. **Remove from Kanban** assigns a dedicated hidden state rather
than moving the annotation back to To Do; deleting the annotation remains a
separate confirmed action.

| Command ID                    | Title                            | Default keybinding |
| ----------------------------- | -------------------------------- | ------------------ |
| `annotations.showKanban`      | Open Annotation Kanban Board     | `Ctrl+Alt+K`       |
| `annotations.addKanbanColumn` | Add Kanban Column                | --                 |
| `annotations.moveToColumn`    | Move Annotation to Kanban Column | --                 |

---

## Import and export

Menu home: editor → **Import/Export & Tools**. Workspace import and JSON
import/export are repeated in the tree `...`; workspace comment import is also
in Explorer.

| Command ID               | Title                        | Default keybinding |
| ------------------------ | ---------------------------- | ------------------ |
| `annotations.exportJSON` | Export Annotations to JSON   | --                 |
| `annotations.importJSON` | Import Annotations from JSON | --                 |

---

## User profiles

Menu home: editor → **Settings & Accounts**.

| Command ID                   | Title                            | Default keybinding |
| ---------------------------- | -------------------------------- | ------------------ |
| `annotations.selectProfile`  | Select Active User or AI Profile | --                 |
| `annotations.manageProfiles` | Manage User Profiles             | --                 |

---

## AI features

Menu home: editor → **AI Analysis**. Profile management and credentials are in
**Settings & Accounts**. If no code editor is open, analysis commands explain
which file must be opened instead of failing silently.

**Configure AI Provider & Credentials** covers all 13 configured providers,
including Azure endpoint/deployment/API version and local server URLs, then
offers Add/Update or Remove. Add/Update lets the user choose visible user
settings or VS Code secret storage and cleans stale copies from the alternative
locations so there is one selected source. Remove requires confirmation and
clears the provider entry from settings plus both recognized secret-key names.
Storage failures are reported visibly.

The exact active IDs are `openai`, `anthropic`, `azure`, `cerebras`,
`deepseek`, `google`, `groq`, `meta`, `mistralai`, `ollama`, `openrouter`,
`lmstudio` and `xai`. Ollama and LM Studio do not require keys.

| Command ID                             | Title                                          | Default keybinding |
| -------------------------------------- | ---------------------------------------------- | ------------------ |
| `annotations.aiSuggest`                | AI Suggest Annotation                          | `Ctrl+Alt+I`       |
| `annotations.aiSuggestWithProfile`     | AI Suggest with Profile                        | --                 |
| `annotations.aiAnalyzeFile`            | AI: Analyze Entire File                        | --                 |
| `annotations.aiAnalyzeFileWithProfile` | AI: Analyze File with Profile                  | --                 |
| `annotations.aiBatchAnnotate`          | AI: Batch Generate Annotations                 | --                 |
| `annotations.batchCreateMixed`         | AI: Create Annotations and Code Items in Batch | --                 |
| `annotations.manageAIProfiles`         | AI: Manage Custom Profiles                     | --                 |
| `annotations.updateApiKey`             | Configure AI Provider & Credentials            | --                 |

---

## Keyboard shortcut quick reference

| Action                            | Windows / Linux    | macOS             |
| --------------------------------- | ------------------ | ----------------- |
| Add annotation                    | `Ctrl+Alt+A`       | `Cmd+Alt+A`       |
| Edit annotation                   | `Ctrl+Alt+E`       | `Cmd+Alt+E`       |
| Delete annotation                 | `Ctrl+Alt+D`       | `Cmd+Alt+D`       |
| Show annotations panel            | `Ctrl+Alt+S`       | `Cmd+Alt+S`       |
| Toggle annotation visibility      | `Ctrl+Alt+T`       | `Cmd+Alt+T`       |
| Navigate to linked annotation     | `Ctrl+Alt+L`       | `Cmd+Alt+L`       |
| Apply annotation template         | `Ctrl+Shift+Alt+T` | `Cmd+Shift+Alt+T` |
| Show Kanban board                 | `Ctrl+Alt+K`       | `Cmd+Alt+K`       |
| Next annotation (review mode)     | `F8`               | `F8`              |
| Previous annotation (review mode) | `Shift+F8`         | `Shift+F8`        |
| AI suggest annotation             | `Ctrl+Alt+I`       | `Cmd+Alt+I`       |
| Navigation stack -- back          | `Alt+Left`         | `Option+Left`     |
| Navigation stack -- forward       | `Alt+Right`        | `Option+Right`    |

---

## Documentation

Menu home: editor → **Documentation**, either tree row → **Documentation**, or
Explorer file → **Out-of-Code Insights**. Configuration always precedes the
optional generation step; both remain available from the Command Palette.

| Command ID                        | Title                              | Default keybinding |
| --------------------------------- | ---------------------------------- | ------------------ |
| `annotations.generateDocs`        | Generate Annotation Documentation  | --                 |
| `annotations.configureDocs`       | Configure Documentation Studio     | --                 |
| `annotations.addDocBlock`         | Add Documentation Annotation       | --                 |
| `annotations.editMessageMarkdown` | Edit Annotation Message (Markdown) | --                 |

See [documentation-authoring.md](./documentation-authoring.md) for the authoring workflow.

---

## Source comments and annotations

Menu home: editor → **Import/Export & Tools**, or right-click a code file in
Explorer → **Out-of-Code Insights**. The legacy import commands remain the
fast marker-based TODO/FIXME workflow. The two guided conversion commands
use a language-aware catalogue of 42 syntax IDs (37 primary tested modes plus
five aliases/extras) for standalone, adjacent and trailing comments (with or
without delimiter whitespace), file headers and documentation blocks.

**Convert Code Comments & Headers to Annotations...** previews every detected
record with its exact range and kind, supports multi-selection, then asks
whether to **Keep Source Comments** (copy) or **Remove Source Comments**
(move). Keep supports every scanned record. Remove is offered only when all
selected records use line syntax in the 10 audited removal modes: TypeScript,
JavaScript, Java, C, C++, C#, Go, Rust, Kotlin and Dart. Blocks and docblocks
remain Keep-only to prevent lexical token fusion.

**Write Annotations into Code Comments...** previews an `OOCI(...)` identity
marker, lets the user choose the standard or documentation-comment style, then
asks whether to keep or remove the source annotations. New markers combine the
readable eight-character ID prefix with a 128-bit SHA-256 fingerprint; legacy
short markers remain readable. A destructive Remove requires the exact ID and
message to round-trip before the source edit and again after save. Reverse
writing is limited to the 16 audited modes listed in the feature catalogue and
to lexer-proven positions. Other modes fail closed.

Escape cancels before mutation. For completed **Remove** moves, native
**Undo/Redo** plus **Undo Conversion** restore both resources; **Keep** is an
ordinary copy operation. Exact import provenance, strong markers and legacy
fallbacks are consumed one-to-one, so equal comments on the same line remain
independently selectable. If source rollback is rejected or throws, the
destination representation is conservatively kept and persisted; a cascading
failure is surfaced. Destructive Move is also unavailable while configured
save participants could rewrite or coalesce the source edit.

| Command ID                                   | Title                                          | Default keybinding |
| -------------------------------------------- | ---------------------------------------------- | ------------------ |
| `annotations.importComments`                 | Import Code Comments as Annotations            | --                 |
| `annotations.importCommentsWorkspace`        | Import Code Comments from Workspace            | --                 |
| `annotations.convertCodeComments`            | Convert Code Comments & Headers to Annotations | --                 |
| `annotations.writeAnnotationsToCodeComments` | Write Annotations into Code Comments           | --                 |

---

## Pro, sync and integrations

| Command ID                        | Title                                           | Default keybinding |
| --------------------------------- | ----------------------------------------------- | ------------------ |
| `annotations.enterLicenseKey`     | Enter License Key (Pro)                         | --                 |
| `annotations.syncConfigure`       | Configure Annotation Sync                       | --                 |
| `annotations.syncNow`             | Sync Annotations Now                            | --                 |
| `annotations.mcpSetup`            | Configure MCP Server Integration                | --                 |
| `annotations.setupAiInstructions` | Set Up AI Agent Instructions for This Workspace | --                 |

---

## Native editor comments (Comments API)

Menu home: the native comment thread and its title bar. These commands require
that thread as their target and therefore do not appear in the Command Palette.

| Command ID                     | Title                | Default keybinding |
| ------------------------------ | -------------------- | ------------------ |
| `annotations.commentReply`     | Reply                | --                 |
| `annotations.commentResolve`   | Resolve Annotation   | --                 |
| `annotations.commentUnresolve` | Unresolve Annotation | --                 |
| `annotations.commentDelete`    | Delete Annotation    | --                 |
| `annotations.commentPickUp`    | Move Annotation      | --                 |

These appear on the annotation's native comment thread (`annotation.commentsView`, default on) rather than in the Command Palette.

---

## Diagnostics

Menu home: editor → **Settings & Accounts** for initialization/settings, editor
→ **View & Search** for tracking diagnostics, and editor → **Import/Export &
Tools** for logs. Common settings are repeated in the tree and Explorer hubs.

| Command ID                             | Title                                | Default keybinding |
| -------------------------------------- | ------------------------------------ | ------------------ |
| `outOfCodeInsights.showLogs`           | Show Extension Logs                  | --                 |
| `annotations.openSettings`             | Open Out-of-Code Insights Settings   | --                 |
| `annotations.showInitializationReport` | Show Initialization Report           | --                 |
| `annotations.retryInitialization`      | Retry Extension Initialization       | --                 |
| `annotations.showTrackingDiagnostics`  | Show Annotation Tracking Diagnostics | --                 |
