# Out-of-Code Insights

> Contextual code annotations that follow your work without changing your source files.

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/jacquesgariepy.out-of-code-insights?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=jacquesgariepy.out-of-code-insights)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/jacquesgariepy.out-of-code-insights)](https://marketplace.visualstudio.com/items?itemName=jacquesgariepy.out-of-code-insights)
[![Open VSX](https://img.shields.io/open-vsx/v/jacquesgariepy/out-of-code-insights?label=Open%20VSX)](https://open-vsx.org/extension/jacquesgariepy/out-of-code-insights)
[![CI](https://github.com/JacquesGariepy/out-of-code-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/JacquesGariepy/out-of-code-insights/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](./LICENSE)

Out-of-Code Insights adds review notes, threaded discussions, documentation,
and workflow metadata beside your code. Source stays untouched by default;
annotation data lives in `.out-of-code-insights/annotations.json`, where it can
remain local or be versioned and shared with the team. An explicit, confirmed
conversion command can materialize selected annotations as source comments
when that is the workflow you want.

**[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jacquesgariepy.out-of-code-insights)** ·
**[Install from Open VSX](https://open-vsx.org/extension/jacquesgariepy/out-of-code-insights)** ·
**[Download the latest VSIX](https://github.com/JacquesGariepy/out-of-code-insights/releases/latest)** ·
**[Read the documentation](./docs/README.md)** ·
**[Audit the complete feature catalogue](./docs/FEATURE-CATALOG.md)**

![Annotations panel and editor decorations](https://github.com/user-attachments/assets/beedc87b-c914-48d0-b7fa-cfe8194074f5)

## Why teams use it

| Capability                    | What it gives you                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Non-intrusive annotations     | Review notes and TODOs on any file type without adding source comments by default                            |
| Resilient tracking            | Annotations follow typing, line moves, copy/cut/paste, drag-and-drop, Undo/Redo, renames, and external edits |
| Recovery instead of data loss | Orphaned annotations stay recoverable and can be attached to the current cursor                              |
| One workspace for discussion  | Threads, tags, severities, filters, pagination, review mode, and Kanban                                      |
| Native VS Code experience     | Interactive Inlay Hints, gutter, CodeLens, Comments, Tree View, grouped menus, commands, and keyboard access |
| Automation and AI             | MCP tools, generated documentation, comment import, sync, and optional multi-provider AI features            |

## What is new in 1.4.3

- Click the **Move** handle directly beside an inline annotation, move the
  cursor to any line or file, then press **Enter** to drop or **Escape** to
  cancel. The target line and status bar show the active move state.
- Click the annotation message itself to open it in the panel. CodeLens, hover
  links and native Comments threads expose the same move workflow.
- You do not need to memorize command IDs: every contributed command has a
  visible native menu home. Right-click in the editor, an annotation tree item,
  a workspace file in Explorer or a native annotation comment; the Annotations
  view `...` menu exposes workspace actions. The Command Palette remains a
  searchable alternative.
- Move transactions now roll back in memory if persistence fails, preventing
  the editor state and `annotations.json` from disagreeing.
- The documented `annotation.codelens.*` settings now work as configured.
- Resolve keeps the record and marks it resolved; shutdown flushes pending
  saves, and failed writes remain retryable instead of being silently lost.

See the [1.4.3 release notes](./docs/CHANGELOG-1.4.3.md) or open the
[v1.4.3 GitHub release](https://github.com/JacquesGariepy/out-of-code-insights/releases/tag/v1.4.3).

> **1.4.4 source candidate:** Documentation Studio and the expanded menus
> described below are present in this repository but are not published yet.
> The Marketplace and Open VSX release remains **1.4.3**. Version 1.4.4 will
> not be tagged or published without explicit user confirmation. Review the
> [candidate 1.4.4 changelog](./docs/CHANGELOG-1.4.4.md) before confirming.

The candidate now exposes 86 public commands through novice-friendly native
menus. It adds guided conversion between standalone source comments/file
headers/docblocks and annotations in both directions, stable identity-based
links, canonical closed-file navigation, safer persistence and Kanban updates,
and a single exact 13-provider AI catalogue.

## Start in 60 seconds

1. Install the extension and open a folder in VS Code.
2. Open either Annotations tree. When it is empty, its welcome screen offers
   **Add an annotation**, workspace import, the panel, documentation setup and
   settings as guided links.
3. To annotate the current line, place the cursor there, right-click, then
   choose **Out-of-Code Insights → Add Annotation**. `Ctrl+Alt+A`
   (`Cmd+Alt+A` on macOS) is an optional shortcut.
4. Enter a note. It appears in the editor and in the Out-of-Code Insights view.
5. Open the annotations panel to filter, discuss, prioritize, or move the item.
6. Commit `.out-of-code-insights/annotations.json` only when you want to share
   annotations with the repository.

If an annotation loses its target, place the cursor on the intended line and
run **Re-anchor Annotation to Current Cursor**. For troubleshooting, run
**Show Annotation Tracking Diagnostics** and inspect the generated local report.

## Feature map

- **Capture:** context menu, shortcut, CodeLens, native comment gutter, templates,
  imported TODO/FIXME comments, or AI suggestions.
- **Organize:** tags, severity, pinning, search, filters, pagination, compact
  density, batch editing, Review Mode, and Kanban.
- **Connect:** threaded replies, cross-file links, navigation history, team sync,
  and a companion [desktop application](https://github.com/JacquesGariepy/out-of-code-insights-desktop).
- **Automate:** MCP server, AI-agent instructions, documentation generation,
  workspace comment import, and multi-provider AI profiles.
- **Recover:** automatic movement tracking, orphan preservation, manual
  re-anchoring, and privacy-preserving diagnostics.

[![Watch the original overview video](https://github.com/user-attachments/assets/16cf301b-7eb1-480d-a616-ba4fae09a16f)](https://youtu.be/H6xjResrJzw)

> The overview video demonstrates version 1.0.3. The current interface and
> tracking engine include the newer capabilities documented below.

## ✨ Features

### 🔗 Linked Multi-File Annotations

![linked](https://github.com/user-attachments/assets/573270ea-2057-41df-994d-970b5347f65b)

Create relationships between annotations across different files to improve code traceability and documentation:

- **Create links**: Connect related annotations with contextual relationships (implements, references, depends-on, etc.)
- **Visual indicators**: 🔗 icon in TreeView shows linked annotations
- **Smart navigation**: `Ctrl+Alt+L` to quickly jump between linked annotations
- **Relationship inspection**: **Show Incoming and Outgoing Annotation Links** lists both directions and lets you navigate to the other endpoint
- **Stable targets**: New relationships persist the target annotation ID and
  URI, so re-anchoring or moving the target does not break the link. Legacy
  file/line links remain readable, and relative fallback paths resolve from the
  source annotation's workspace in multi-root projects.

### 📋 Customizable Annotation Templates

Standardize your annotation format with reusable templates:

- **Pre-built templates**: Bug, TODO, Refactor, Performance, Security, Documentation
- **Custom templates**: Create your own with variable substitution (`{{description}}`, `{{priority}}`, etc.)
- **Quick access**: `Ctrl+Shift+Alt+T` to apply templates instantly
- **Team consistency**: Share templates across your development team

### 🔍 Review Mode

![review](https://github.com/user-attachments/assets/7726ea14-bd24-4e3c-be42-ac03f516d864)

Systematically review annotations with advanced filtering and tracking:

- **Structured review**: Navigate through annotations sequentially with `F8`/`Shift+F8`
- **Advanced filtering**: Filter by author, date, severity, tags, and status
- **Progress tracking**: Visual progress bar shows reviewed vs. total annotations
- **Review statistics**: Get insights on annotation distribution and completion

### 🎯 Resilient Tracking and Recovery

Annotations are anchored by UTF-16 ranges, normalized line hashes, and nearby
context instead of relying on a line number alone.

- Follow common editor gestures: typing, formatting, line moves,
  copy/cut/paste, drag-and-drop, Undo/Redo, file rename, and external rewrites.
- Preserve the same annotation identity during moves, including threaded
  replies, tags, severity, and links.
- Keep unresolved annotations as recoverable orphans instead of silently
  deleting them.
- Re-anchor an annotation to the current cursor from the Tree View, annotations
  panel, or Command Palette.
- Generate a local tracking report when an anchor decision needs investigation;
  source text is intentionally excluded.

### 💬 Native Editor Comments

Annotations render as native VS Code comment threads (Comments API):

- **Inline gutter "+"**: create a new annotation directly from the comment gutter at any line
- **Threaded replies**: replies typed in the comment widget are appended to the annotation's discussion thread
- **Thread actions**: resolve, unresolve, or delete an annotation from its comment thread title bar
- **Severity & tags at a glance**: the thread label shows the annotation's severity and tags
- Controlled by `annotation.commentsView` (enabled by default; changes take
  effect after the next window reload)

### 📋 Kanban-style Workspace

Manage annotations visually with a dedicated Kanban board:
![Kanban](https://github.com/user-attachments/assets/499bbbec-f773-47c8-9c5a-84f3ad5bb079)

- **Visual organization**: Drag & drop annotations between customizable columns (To Do, In Progress, Review, Done)
- **Keyboard accessible drag-and-drop**: grab a card with Enter/Space, move it with the arrow keys, confirm with Enter/Space or cancel with Escape; each step is announced via `aria-live`
- **Severity filter chips**: filter cards by severity with quick-toggle chips
- **WIP limits**: set a per-column work-in-progress limit with a visual indicator when a column exceeds it
- **Virtualized rendering**: large boards only mount the cards near the visible scroll area, above a per-column threshold
- **Persisted view state**: search term, severity filter, and WIP limits survive hiding and reshowing the board
- **Intelligent deletion**: Choose to remove from kanban or delete completely
- **Custom columns**: Create workflow-specific columns for your team
- **Quick navigation**: Double-click cards to jump to code location

### ⚡ Executable Code Snippets

Attach and execute code directly from annotations:

- **Code attachment**: Add reusable code snippets to annotations
- **Preview changes**: See modifications before applying them
- **Variable support**: Use placeholders (`$1`, `$2`) for dynamic snippets
- **Execution history**: Track applied snippets for better code management
- **Multiple languages**: Support for all programming languages

### Annotation History

![STACK](https://github.com/user-attachments/assets/7d821ca0-d38f-48df-81ae-58fc94fcb3ce)

## Requirements

- **Visual Studio Code:** version `1.95.0` or later
- **Node.js:** `18+` (only required if you build from source)
- **Operating system:** Windows, macOS, or Linux
- **AI features (optional):** credentials for a hosted provider, or a running
  Ollama/LM Studio endpoint for local use without an API key. The exact
  13-provider catalogue is listed in [AI providers](./docs/llm-providers.md).

## Installation

- **VS Code Marketplace:** open the
  [extension page](https://marketplace.visualstudio.com/items?itemName=jacquesgariepy.out-of-code-insights)
  and select **Install**, or search for `Out-of-Code Insights` from
  `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS).
- **Open VSX:** install from the
  [Open VSX page](https://open-vsx.org/extension/jacquesgariepy/out-of-code-insights)
  in compatible editors.
- **Manual VSIX:** download the asset from the
  [latest GitHub release](https://github.com/JacquesGariepy/out-of-code-insights/releases/latest),
  then run **Extensions: Install from VSIX...**.

## Quick Start Guide

### Your First Annotation

1. **Open any file** in your project
2. **Position your cursor** on the line you want to annotate
3. **Right-click** → **Out-of-Code Insights → Add Annotation**
4. **Enter your annotation** message and press Enter
5. **See your annotation** appear in the Activity Bar sidebar

### Essential Workflow

1. **Add annotations** during code review or development (`Ctrl+Alt+A`)
2. **Organize with templates** for consistent formatting (`Ctrl+Shift+Alt+T`)
3. **Link related annotations** across files (`Ctrl+Alt+L`)
4. **Review systematically** with Review Mode (`F8`/`Shift+F8`)
5. **Visualize progress** with the Kanban board (`Ctrl+Alt+K`)

### Common Use Cases

- **Code Review**: Add review comments without modifying source files
- **Technical Documentation**: Document complex logic and architectural decisions
- **Bug Tracking**: Track issues with linked corrections and code snippets
- **Team Collaboration**: Share insights and TODOs with your team
- **Project Management**: Organize tasks visually with the Kanban board

## Usage

### Adding an Annotation

- **Using the context menu**:
    - Right-click on the line where you want to add an annotation.
    - Select **`Add Annotation`**.
- **Using keyboard shortcuts**:
    - Place your cursor on the desired line.
    - Press `Ctrl+Alt+A` (Windows/Linux) or `Cmd+Alt+A` (Mac).

### Editing or Deleting an Annotation

- **Using the context menu**:
    - Right-click on the line containing the annotation.
    - Select **`Edit Annotation`** or **`Delete Annotation`**.
- **Using keyboard shortcuts**:
    - **Edit an annotation**:
        - Press `Ctrl+Alt+E` (Windows/Linux) or `Cmd+Alt+E` (Mac).
    - **Delete an annotation**:
        - Press `Ctrl+Alt+D` (Windows/Linux) or `Cmd+Alt+D` (Mac).

### Viewing and Managing Annotations

- **Open the annotations panel**:
    - Use the **`View Annotations`** command from the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
    - Or click the annotations icon in the status bar.
- **Toggle annotation visibility**:
    - Use the **`Toggle Annotation Visibility`** command to make annotations visible or hidden in the editor.
    - Shortcut: `Ctrl+Alt+T` on every platform.
- **Choose panel density**:
    - Select **Comfortable** for more breathing room or **Compact** for large
      annotation sets. The choice is retained when the panel is reopened.
- **Triage several annotations at once**:
    - Multi-select rows in the native tree and use **Bulk Actions for Selected
      Annotations**, or select cards in the full panel and use its bulk toolbar.
    - Toggle a tree row's native checkbox to resolve or reopen it directly.

### Moving Annotations

- Drag or move code normally in the editor; attached annotations follow the
  affected lines and blocks.
- To start directly from the annotation shown beside the code, click its
  **Move** handle. Move the cursor to the target line and press **Enter** (or
  `Ctrl+Alt+M`; `Cmd+Alt+M` on macOS). Press **Escape** to cancel.
- Click the inline annotation message to open its full thread and metadata in
  the panel. A CodeLens action, hover link and native Comments action expose the
  same pick-up operation when Inlay Hints are hidden by editor preferences.
- Drag an annotation row onto another row in the native tree, or use the drag
  handle on a panel card, to move the annotation to that code location.
- Drag a native tree row directly onto a line in an open code editor to attach
  it to that exact line without modifying the source text.
- Multi-select annotations before dragging to move the set together. Drop on a
  file group to choose an exact line with the native destination picker.
- Run **Move Selected Annotations…** for the keyboard-accessible equivalent.
- Use **Move Annotation Up** or **Move Annotation Down** for a deliberate
  one-line adjustment.
- To recover an orphan or deliberately move it elsewhere, place the cursor on
  the destination and run **Re-anchor Annotation to Current Cursor**.

> VS Code API note: extensions cannot receive mouse-drag events from text
> decorations, CodeLens, Comments threads or Inlay Hints. Literal drag starts
> from the native Tree View. The inline **Move** handle uses the supported
> command API and reaches the same exact line without changing source text.

### Replying to an Annotation

- **Add a comment to an existing annotation**:
    - In the annotations panel, select the annotation you want to reply to.
    - Click **`Reply`** to add a comment and start a thread.

### Filtering and Sorting Annotations

- **Filter annotations**:
    - Use the filtering options in the annotations panel to display annotations by file or author.
- **Sort annotations**:
    - Sort annotations by date, number of comments, etc., for efficient management.
- **Paginate large lists**:
    - The panel renders one page of annotations at a time, with first/previous/next/last controls, a page indicator, and a per-page selector (10/20/50/100/All, default 20).
    - Changing the sort or filter resets to the first page; the file filter still spans every page.

### Batch Editing Annotations

- **Modify multiple annotations**:
    - Open the annotations panel.
    - Select the annotations you wish to edit.
    - Use the **`Batch Edit Annotations`** command to apply changes to all selected annotations simultaneously.

### Keyword Search

- **Search for annotations by keyword**:
    - Use the **`Keyword Search`** feature in the annotations panel.
    - Enter the desired keyword to filter annotations containing that term.

### Filter by Severity

- **Categorize annotations**:
    - Use the **`Filter by Severity`** option to display annotations based on their assigned severity levels (e.g., info, warning, error).

### Set Annotation Severity

- **Adjust severity**:
    - Right-click on an annotated line and choose **`Set Annotation Severity`**.
    - Select the appropriate level (`info`, `warning`, or `error`) to better classify the annotation.

## 🤖 AI-Powered Features

### Multi-LLM Provider Support

![LLM](https://github.com/user-attachments/assets/202f50fe-438d-4ecc-86e8-65c75c3bebe6)
Out-of-Code Insights exposes one validated catalogue of 13 provider IDs:

**Supported Providers:**

- OpenAI, Anthropic (Claude), Azure OpenAI, Cerebras, DeepSeek, Google Gemini
- Groq, Meta, Mistral AI, OpenRouter and xAI
- Ollama and LM Studio for local use without a required key

**Quick Setup:**

1. Right-click in a code editor and open **Out-of-Code Insights → Settings &
   Accounts → Configure AI Provider & Credentials**.
2. Choose a provider. The guided flow also asks for Azure endpoint/deployment/
   API version or the local Ollama/LM Studio URL when applicable.
3. For hosted providers, choose Add/Update and then VS Code Secret Storage
   (recommended) or visible user settings; stale alternative copies are removed.

### Custom AI Profiles

Create specialized AI profiles for different analysis needs:

**Creating a Custom Profile:**

1. Right-click → **Out-of-Code Insights → AI Analysis → AI: Manage Custom Profiles**
2. Select "Create New Profile"
3. Configure:
    - **Profile ID**: Unique identifier (e.g., `security-auditor`)
    - **Name**: Display name
    - **Analysis Prompt**: What the AI should look for
    - **Default Tags**: Automatically applied tags
    - **Severity & Priority**: Default annotation settings

**Example Custom Profiles:**

- **Security Auditor**: Focuses on vulnerabilities and security best practices
- **Performance Optimizer**: Identifies bottlenecks and optimization opportunities
- **Code Reviewer**: Comprehensive code quality analysis
- **Documentation Helper**: Suggests missing documentation

### Enhanced AI Analysis

**AI Suggest with Profile** (`Ctrl+Alt+I`):

- Select from both user profiles and AI profiles
- Option to add custom instructions
- Context-aware suggestions based on surrounding code

**AI Analyze File**:

- Analyze entire files with selected AI profile
- Pre-analysis confirmation with file details
- Batch review of suggested annotations

**Custom Prompts**:

- Add specific instructions to any AI analysis
- Prompts stack with profile behavior
- Perfect for one-off requirements

![image](https://github.com/user-attachments/assets/47a41c70-b7dd-4057-9330-f1944d456035)

### Resolve Old Annotations

Open **Out-of-Code Insights → Review Workflow → Resolve Old Annotations**.
Enter an age from 1 to 3650 days, review the number of matching open
annotations, then confirm the transactional update. Nothing is resolved in the
background or without confirmation.

### Batch Creation System

**AI: Create Annotations and Code Items in Batch**:
This feature allows you to create multiple types of items in a single operation to improve your productivity:

- **Access**: Right-click → **Out-of-Code Insights → AI Analysis → AI: Create Annotations and Code Items in Batch**
- **Multiple selection**: Choose any combination of items to create
- **Available types**:
    - 📝 **Annotations**: Generate multiple annotations with AI to analyze your code
    - 📋 **Templates**: Create reusable templates to standardize your annotations
    - 🔗 **Links**: Connect existing annotations to create logical connections
    - 💻 **Snippets**: Generate reusable code snippets

**Usage examples**:

1. **Complete code review**: Create annotations + templates for a standardized review
2. **Feature documentation**: Create links between annotations + example code snippets
3. **Refactoring**: Create refactoring templates + annotations for areas to modify

**Details by type**:

📋 **Template Batch Creation**:

- Create up to 10 annotation templates at once
- Define for each template: name, message with variables, tags, and severity
- Templates are immediately available via `Ctrl+Shift+Alt+T`

🔗 **Link Batch Creation**:

- Select multiple existing annotations to link
- Create named link groups (e.g., "Authentication flow")
- Ideal for tracing implementations across multiple files

💻 **Snippet Batch Creation**:

- **From selection**: Transform selected code into reusable snippet
- **With AI**: Generate snippets based on your needs (e.g., "error handling patterns")
- **Manual input**: Create multiple snippets with custom code and descriptions

## 🧩 Pro & Integrations

### MCP Server

The repository ships a standalone MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server in [`mcp-server/`](./mcp-server) that lets AI agents work with your annotations **outside VS Code**: list/get/add/update/remove/link annotations, a `code_graph` projection of annotation links, and `generate_docs`, all against the same `annotations.json` the extension uses, without ever modifying source files. While VS Code is open, external changes are reloaded live by the extension's file watcher.

Quickstart:

```bash
# Build the server (root install first: its tsconfig reaches into ../src)
npm ci && cd mcp-server && npm ci && npm run build

# Register it with an MCP client, e.g. the claude CLI:
claude mcp add out-of-code-insights -- node /path/to/out-of-code-insights/mcp-server/bin/out-of-code-insights-mcp.js --workspace /path/to/your/project
```

Or run **Configure MCP Server Integration** in VS Code: it copies a ready-to-paste configuration (Claude Code command or `claude_desktop_config.json` snippet) with the paths pre-filled. Full tool reference: [mcp-server/README.md](./mcp-server/README.md). Tagged releases (`mcp-v*`) are published to npm; the version always comes from `mcp-server/package.json`.

**Set Up AI Agent Instructions for This Workspace** upserts a marked instruction block into both `CLAUDE.md` and `AGENTS.md` at the workspace root (creating them if absent), telling AI agents to annotate code through these MCP tools instead of writing comments into source files, to use authored-page and technical-document `doc:*` roles, and where the generated documentation lives. Re-running the command replaces the block in place; it never duplicates it.

### Pro licensing

Everything is **free by default**: gating only activates for the feature ids you list. The flow:

- **Enter License Key (Pro)** command stores the key in VS Code Secret Storage and validates it against `annotation.pro.licenseServerUrl` (`POST /v1/validate` → `{ valid, entitlements, expiresAt? }`).
- `annotation.pro.gatedFeatures`: the feature ids that actually require an entitlement (e.g. `sync`, `docs.watch`); anything not listed stays free. Entitlements are cached with an offline grace period (`annotation.pro.offlineGraceDays`, default 7 days).
- Self-hosting: the [`license-server/`](./license-server) package implements the contract with offline-verifiable HMAC keys, a CLI to issue/revoke keys, the cloud-sync API, an optional Stripe webhook that issues keys on completed checkouts, and a Dockerfile.

### Cloud sync

Share annotations across a team through the license server: set `annotation.sync.serverUrl` and `annotation.sync.workspaceId`, store the bearer token with **Configure Annotation Sync**, then **Sync Annotations Now** (or click the ☁ status bar item). Optimistic concurrency with a keep-local/take-remote prompt on divergence; `annotation.sync.auto` pulls on activation and pushes (debounced) after changes. Gate it as a Pro feature by adding `sync` to `annotation.pro.gatedFeatures`.

### Comment import & styling

- **Import Code Comments as Annotations** (active file) and **Import Code Comments from Workspace** turn better-comments-style markers (`// !`, `// ?`, `// *`, `TODO`, `FIXME`, `HACK`, also `#`, `--`, `<!-- -->` syntaxes) into tagged, severity-mapped annotations; reruns never duplicate.
- **Convert Code Comments & Headers to Annotations...** scans standalone line
  comments, block comments, documentation blocks and file headers in the
  selected code file. It shows locations and kinds, lets you select the exact
  records, asks for confirmation, and leaves source text unchanged.
- **Write Annotations into Code Comments...** performs the reverse conversion.
  Select annotations, choose the language's standard comment or documentation
  block style, review the marker preview, then confirm the edit. VS Code applies
  one `WorkspaceEdit`, so **Undo** removes the inserted comments in one step.
- The language-aware syntax catalogue contains 42 IDs: 37 primary modes
  validated by the catalogue test plus five compatibility aliases/extras.
  Generated comments include a sanitized `OOCI(...)` identity marker; the
  marker and normalized content checks prevent duplicate materialization on
  reruns. Unsupported language modes are reported without changing the file.
- Import remains available for `typescriptreact`, `javascriptreact`, `vue` and
  `php`, but reverse writing is deliberately disabled in those four
  mixed-context modes. Safe insertion depends on whether the target is code,
  JSX, template, style, HTML or PHP; syntax-aware placement remains tracked in
  `tasks.jsonp`.
- `annotation.severityStyles` / `annotation.tagStyles` map severities and tags to decoration colors (inline text, background, border, gutter visibility).
- **Edit Annotation Message (Markdown)** opens a multiline editor panel; the inline editor decoration shows only the first line of the message.
- `annotation.watchExternalChanges` (default on) reloads annotations changed on disk by external tools; `annotation.docs.watch` regenerates the documentation on every annotation change.

### Documentation generator

**Documentation Studio** uses built-in layouts to project one annotation set
into multiple representations. Right-click in the editor and choose
**Out-of-Code Insights → Documentation → Configure Documentation Studio**.
The same **Documentation** submenu is available by right-clicking in either
Annotations tree, and workspace-level configuration and generation are
available by right-clicking a file in Explorer. Choose a built-in or
workspace-owned JSON preset, then run **Generate Annotation Documentation**
from the same menu. `Ctrl+Shift+P` remains an alternative for both commands.

All 86 contributed commands are categorized under **Out-of-Code Insights** and
have a native menu home. The editor hub uses 11 task groups; tree rows use
focused **Move & Re-anchor**, **State & Metadata**, **Links & Collaboration**
and **Documentation** submenus; the tree `...` menu holds workspace tools; and
Explorer exposes a compact workspace hub. Context-only Tree and Comments
helpers stay out of the Command Palette to avoid commands that would lack a
target. See the complete [command and menu reference](docs/commands.md).

The extension also activates in an empty VS Code window so menus, setup and
diagnostics remain discoverable. If the first folder is added to that existing
window without VS Code reloading it, run **Developer: Reload Window** once to
attach workspace-backed persistence and move/drop services. Opening a folder
in the usual way already reloads the window.

The public Edit, Delete, Pin, Severity, Batch Edit and one-line Move commands
also work when no editor is open: they ask you to choose an annotation or file.
Delete and file-wide Batch Edit show a modal confirmation before changing data.
The complete preset emits:

| Output         | What is generated                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Markdown       | Overview, inventories, links, authored API pages and guides                                                                    |
| Static project | Build configuration, TOC, unique page identities, language and theme metadata                                                  |
| Wiki           | Markdown with GFM extensions, hosted/flattened, or hierarchical/ordered packaging; portability depends on the destination host |
| HTML           | Autonomous responsive site with local CSS, CSP and accessible navigation                                                       |
| OpenAPI        | Constrained annotation-catalogue projection plus explicitly bound operations from the supported profile subset                 |

Writes are staged and rollback-safe. A managed manifest removes only stale
generated pages, while `documentation-report.json` records structured
diagnostics consumable by CI. The API projection never guesses routes from
prose or tags. Presets select document kinds and output profiles; page layouts
remain built in. Output, presets and formats are configurable through
`annotation.docs.*` (default
output: `docs/annotations`). See the full
[Documentation Studio guide](docs/documentation-studio.md).

The **Add Documentation Annotation** command pre-tags a new annotation with the role you pick: API/guide roles plus README, changelog, architecture, ADR, onboarding, runbook and technical-reference roles. Its guided changelog flow asks for the version, category and optional explicit date; the ADR flow asks for its status, so users do not need to memorize metadata tags.

**How to write documentation annotations**: roles, message format (titles,
GFM, math, Mermaid, wiki-links), display, and an end-to-end example. See
[docs/documentation-authoring.md](docs/documentation-authoring.md).

## 📋 Key Commands

### AI Commands

- **AI: Analyze Entire File** - Analyze complete file with current AI profile
- **AI: Analyze File with Profile** - Choose specific profile for analysis
- **AI: Batch Generate Annotations** - Create multiple annotations with focus areas
- **AI: Manage Custom Profiles** - Create, edit, delete, import/export AI profiles
- **AI Suggest with Profile** - Get AI suggestions with profile selection
- **AI: Create Annotations and Code Items in Batch** - Create templates, links, snippets and annotations in one guided batch

### Profile Commands

- **Select Active User or AI Profile** - Switch between user and AI profiles
- **Manage User Profiles** - Manage your personal profiles

### Keyboard Shortcuts

- `Ctrl+Alt+I` - AI Suggest Annotation
- `Ctrl+Alt+A` - Add Annotation
- `Ctrl+Alt+E` - Edit Annotation
- `Ctrl+Alt+L` - Navigate to Linked Annotation
- `F8` - Next Annotation (Review Mode)
- `Shift+F8` - Previous Annotation (Review Mode)

## 📚 Command Reference

For the full command reference grouped by feature, see
[docs/commands.md](./docs/commands.md).

### Quick reference -- most-used commands

| Command                      | Keybinding (Win/Linux) | Description                               |
| ---------------------------- | ---------------------- | ----------------------------------------- |
| Add Annotation               | `Ctrl+Alt+A`           | Insert annotation on current line         |
| Edit Annotation              | `Ctrl+Alt+E`           | Edit annotation on current line           |
| Toggle Display               | `Ctrl+Alt+T`           | Show or hide all annotations              |
| Open Annotation Kanban Board | `Ctrl+Alt+K`           | Open Kanban view                          |
| AI Suggest                   | `Ctrl+Alt+I`           | Generate AI annotation for current line   |
| Next Annotation              | `F8`                   | Navigate to next annotation (review mode) |
| Navigate to Linked           | `Ctrl+Alt+L`           | Jump to linked annotation                 |
| Apply Template               | `Ctrl+Shift+Alt+T`     | Apply annotation template                 |

### Annotation lifecycle

| Command ID                     | Title                                  | Default keybinding |
| ------------------------------ | -------------------------------------- | ------------------ |
| `annotations.add`              | Add Annotation                         | `Ctrl+Alt+A`       |
| `annotations.edit`             | Edit Annotation                        | `Ctrl+Alt+E`       |
| `annotations.delete`           | Delete Annotation                      | `Ctrl+Alt+D`       |
| `annotations.reply`            | Reply to Annotation                    | -                  |
| `annotations.clearAll`         | Clear All Annotations                  | -                  |
| `annotations.pinToggle`        | Toggle Annotation Pin                  | -                  |
| `annotations.setSeverity`      | Set Annotation Severity                | -                  |
| `annotations.markAsViewed`     | Mark Annotation as Viewed              | -                  |
| `annotations.batchEdit`        | Batch Edit Annotations in File         | -                  |
| `annotations.reanchorToCursor` | Re-anchor Annotation to Current Cursor | -                  |

### Display & navigation

| Command ID                            | Title                                       | Default keybinding |
| ------------------------------------- | ------------------------------------------- | ------------------ |
| `annotations.show`                    | Open Annotations Panel                      | `Ctrl+Alt+S`       |
| `annotations.toggleDisplay`           | Show or Hide Annotation Decorations         | `Ctrl+Alt+T`       |
| `annotations.navigate`                | Choose and Open an Annotation               | -                  |
| `annotations.moveUp`                  | Move Annotation Up                          | -                  |
| `annotations.moveDown`                | Move Annotation Down                        | -                  |
| `annotations.showTrackingDiagnostics` | Show Annotation Tracking Diagnostics        | -                  |
| `annotations.nextAnnotation`          | Next Annotation                             | `F8`               |
| `annotations.previousAnnotation`      | Previous Annotation                         | `Shift+F8`         |
| `stack.back`                          | Go Back in Annotation Navigation History    | `Alt+Left`         |
| `stack.forward`                       | Go Forward in Annotation Navigation History | `Alt+Right`        |

### Search

| Command ID                  | Title                                   | Default keybinding |
| --------------------------- | --------------------------------------- | ------------------ |
| `annotations.keywordSearch` | Search Annotation Messages and Metadata | -                  |

### Linked annotations

| Command ID                           | Title                                           | Default keybinding |
| ------------------------------------ | ----------------------------------------------- | ------------------ |
| `annotations.createLink`             | Create Annotation Link                          | -                  |
| `annotations.removeLink`             | Remove Annotation Link                          | -                  |
| `annotations.navigateToLinked`       | Navigate to Linked Annotation                   | `Ctrl+Alt+L`       |
| `annotations.showLinks`              | Show Incoming and Outgoing Annotation Links     | -                  |
| `annotations.createDevelopmentIssue` | Create GitHub Development Issue from Annotation | -                  |

### Templates

| Command ID                    | Title                      | Default keybinding |
| ----------------------------- | -------------------------- | ------------------ |
| `annotations.createTemplate`  | Create Annotation Template | -                  |
| `annotations.applyTemplate`   | Apply Template             | `Ctrl+Shift+Alt+T` |
| `annotations.manageTemplates` | Manage Templates           | -                  |

### Code snippets

| Command ID                   | Title                          | Default keybinding |
| ---------------------------- | ------------------------------ | ------------------ |
| `annotations.addSnippet`     | Add Code Snippet to Annotation | -                  |
| `annotations.applySnippet`   | Apply Code Snippet             | -                  |
| `annotations.previewSnippet` | Preview Snippet Changes        | -                  |

### Review mode

| Command ID                      | Title                              | Default keybinding |
| ------------------------------- | ---------------------------------- | ------------------ |
| `annotations.startReview`       | Start Review Mode                  | -                  |
| `annotations.stopReview`        | Stop Review Mode                   | -                  |
| `annotations.reviewMode.filter` | Filter the Annotation Review Queue | -                  |

### Kanban board

| Command ID                    | Title                            | Default keybinding |
| ----------------------------- | -------------------------------- | ------------------ |
| `annotations.showKanban`      | Open Annotation Kanban Board     | `Ctrl+Alt+K`       |
| `annotations.addKanbanColumn` | Add Kanban Column                | -                  |
| `annotations.moveToColumn`    | Move Annotation to Kanban Column | -                  |

### Import / export

| Command ID                                   | Title                                          | Default keybinding |
| -------------------------------------------- | ---------------------------------------------- | ------------------ |
| `annotations.exportJSON`                     | Export Annotations to JSON                     | -                  |
| `annotations.importJSON`                     | Import Annotations from JSON                   | -                  |
| `annotations.importComments`                 | Import Code Comments as Annotations            | -                  |
| `annotations.importCommentsWorkspace`        | Import Code Comments from Workspace            | -                  |
| `annotations.convertCodeComments`            | Convert Code Comments & Headers to Annotations | -                  |
| `annotations.writeAnnotationsToCodeComments` | Write Annotations into Code Comments           | -                  |

### User profiles

| Command ID                   | Title                            | Default keybinding |
| ---------------------------- | -------------------------------- | ------------------ |
| `annotations.selectProfile`  | Select Active User or AI Profile | -                  |
| `annotations.manageProfiles` | Manage User Profiles             | -                  |

### AI features

| Command ID                             | Title                                          | Default keybinding |
| -------------------------------------- | ---------------------------------------------- | ------------------ |
| `annotations.aiSuggest`                | AI Suggest Annotation                          | `Ctrl+Alt+I`       |
| `annotations.aiSuggestWithProfile`     | AI Suggest with Profile                        | -                  |
| `annotations.aiAnalyzeFile`            | AI: Analyze Entire File                        | -                  |
| `annotations.aiAnalyzeFileWithProfile` | AI: Analyze File with Profile                  | -                  |
| `annotations.aiBatchAnnotate`          | AI: Batch Generate Annotations                 | -                  |
| `annotations.batchCreateMixed`         | AI: Create Annotations and Code Items in Batch | -                  |
| `annotations.manageAIProfiles`         | AI: Manage Custom Profiles                     | -                  |
| `annotations.updateApiKey`             | Configure AI Provider & Credentials            | -                  |

For an end-to-end walkthrough of every AI command, see [docs/ai-features.md](./docs/ai-features.md).

## 🚀 Using Advanced Features

### Creating and Managing Linked Annotations

**Create a Link:**

1. Position cursor on an existing annotation
2. Right-click → **Out-of-Code Insights → Links & Collaboration → Create Annotation Link**
3. Choose between linking to existing annotation or creating a new one
4. Select relationship type (implements, references, depends-on, etc.)
5. Navigate with `Ctrl+Alt+L` or click 🔗 indicators in TreeView

**Visualize All Links:**

- Use **Show Incoming and Outgoing Annotation Links** to list both directions
- Select an outgoing or incoming relationship to navigate directly

**Create a development issue:**

1. Right-click an annotation → **Links & Collaboration → Create GitHub
   Development Issue from Annotation**. The same action is in the tree `...`
   menu; when invoked elsewhere it offers an annotation picker.
2. Enter or confirm the `owner/repository`; it is validated and saved only in
   workspace settings.
3. Review the issue title and approve the modal network-action confirmation.
4. VS Code requests GitHub authentication. No personal access token is entered
   or stored by the extension.
5. After creation, the annotation receives a `GitHubIssue` tag and a thread
   entry containing the issue number, repository and URL; choose **Open Issue**
   to open it in the browser.

If GitHub succeeds but saving the local trace fails, the extension reports that
separate state and still offers **Open Issue**, avoiding an accidental duplicate
retry.

### Working with Annotation Templates

**Apply a Template:**

1. Position cursor where you want to add an annotation
2. Use `Ctrl+Shift+Alt+T` or "Apply Template" command
3. Select from pre-built templates (Bug, TODO, Refactor, etc.)
4. Fill in template variables with your specific information

**Create Custom Templates:**

1. Use "Create Annotation Template" command
2. Define template name, content with variables (`{{variableName}}`)
3. Set default severity and tags
4. Save locally; use **Manage Templates → Export JSON** and **Import JSON** to
   transfer a catalogue deliberately

### Using Review Mode

**Start a Review Session:**

1. Right-click in the editor → **Out-of-Code Insights → Review Workflow → Start Review Mode**
2. Configure filters (optional): author, date range, severity, tags
3. Navigate with `F8` (next) / `Shift+F8` (previous)
4. Mark annotations as viewed or resolved during review
5. View progress and statistics in status bar

### Managing the Kanban Board

**Open Kanban:**

- Use **Out-of-Code Insights → Kanban → Open Annotation Kanban Board** or `Ctrl+Alt+K`
- Drag & drop annotations between columns
- Add custom columns for your workflow
- Filter view by author, severity, or tags

**Kanban Actions:**

- **Move annotations**: Drag between columns or use **Move Annotation to Kanban Column**
- **Smart deletion**: Choose to remove from kanban only or delete completely
- **Quick navigation**: Double-click cards to open file location
- **Custom columns**: Add workflow-specific columns (e.g., "Testing", "Deployed")

### Working with Code Snippets

**Add Snippets to Annotations:**

1. Right-click on annotation → "Add Code Snippet to Annotation"
2. Enter code with optional variables (`$1`, `$2`, `${1:placeholder}`)
3. Set language and description
4. Use "Preview Snippet Changes" before applying
5. Apply with "Apply Code Snippet" command

## 💡 Practical Examples & Best Practices

### Example 1: Code Review Workflow

```
1. Reviewer adds annotation: "Consider using async/await here for better readability"
2. Create template: "REVIEW: {{suggestion}} - Priority: {{priority}}"
3. Link to implementation: annotation → corrected code in another file
4. Add code snippet: "async function fetchData() { ... }"
5. Move to Kanban: "To Do" → "In Progress" → "Review" → "Done"
```

### Example 2: Bug Tracking System

```
1. Bug report: "BUG: Authentication fails on token refresh"
2. Link related annotations:
   - Bug annotation → Implementation file
   - Implementation → Test file
   - Test file → Documentation
3. Attach fix snippet: "if (token.isExpired()) { await refreshToken(); }"
4. Use Review Mode to systematically check all auth-related annotations
```

### Example 3: Team Documentation

```
1. Architect creates templates:
   - "ARCHITECTURE: {{component}} - Purpose: {{purpose}}"
   - "TODO: {{task}} - Assigned: {{developer}} - Due: {{date}}"
2. Team uses templates for consistency
3. Link annotations create knowledge graph
4. Kanban board shows project progress
5. Review Mode ensures nothing is missed
```

### Pre-built Templates Available

- **Bug**: Report bugs with steps to reproduce and expected vs actual results
- **TODO**: Task tracking with priority and assignment
- **Refactor**: Code improvement suggestions with rationale
- **Performance**: Performance issues with metrics and improvement plans
- **Security**: Security concerns with risk assessment
- **Documentation**: Documentation gaps with content guidelines
- **Question**: Questions for team discussion with context

### Best Practices

- **Use consistent templates** across your team for better communication
- **Link related annotations** to create a knowledge graph of your codebase
- **Review annotations regularly** using Review Mode to keep them current
- **Organize with Kanban** to visualize project progress and bottlenecks
- **Attach code snippets** for quick fixes and examples
- **Tag annotations** with project phases, components, or priorities
- **Export/import** annotations when sharing across projects or teams

### Configure the annotations.json File Path

- **Set the path to the annotations file**:
    - Access the extension settings.
    - Enter the desired path in the **`Path to annotations file`** field. Include the file name (e.g., `annotations.json`), if you not specify the file name, the extension will use the default name (`annotations.json`).
    - Per default, the annotations file is located in the **`.out-of-code-insights/annotations.json`** directory of your project.
    - If you change the path, ensure that the directory exists and is accessible. All project using the extension will use this path after the change, else the extension will use the default path in each project.

### Default Severity Setting

- **Specify a default severity**:
    - In the extension settings, modify **`Default Severity`** to define the severity level applied when creating new annotations.

### Exporting and Importing Annotations

- **Export Annotations to JSON**
    - Use the `Export Annotations to JSON` command to export all annotations to a JSON file.
    - Command: `annotations.exportJSON`
- **Import Annotations from JSON**
    - Use the `Import Annotations from JSON` command to import annotations from a JSON file.
    - Command: `annotations.importJSON`

### Managing Annotations

- **Toggle Annotation Pin**
    - Pin or unpin annotations to keep important notes visible.
    - Command: `annotations.pinToggle`

### Enhanced Features

- **Batch Edit Annotations in File**
    - Modify multiple annotations simultaneously within a file to streamline your workflow.
    - Command: `annotations.batchEdit`

- **Search Annotation Messages and Metadata**
    - Quickly locate annotations by searching for specific keywords.
    - Command: `annotations.keywordSearch`

### Important Notes

- **File modification**:
    - Edits made in VS Code are tracked live. If a file changes externally
      (for example after `git pull` or a branch switch), reopening it triggers
      hash-and-context re-anchoring. Unresolved items remain recoverable.
- **Compatibility with all file types**:
    - You can add annotations to **any file in your project**, including source code, Markdown, JSON, XML, text, etc.
- **Annotation storage**:
    - Annotations are stored in a JSON file named **`annotations.json`**, located by default in the **`.out-of-code-insights`** directory of your project.
    - **Include this file in your version control repository** if you want to preserve annotation history and share comments with your team.
- **AI provider key management**:
    - AI features are optional. Open **Out-of-Code Insights → Settings &
      Accounts → Configure AI Provider & Credentials**.
    - Choose one of the 13 configured providers, then Add/Update or Remove.
      Add/Update lets you choose VS Code Secret Storage (recommended) or visible
      user settings and removes stale copies from the alternative locations.
    - Remove requires confirmation and clears that provider from user settings
      plus both recognized secret-key names without deleting unrelated secrets.

## Configuration

Customize the extension according to your needs by modifying the available settings:

- **Username** (`annotation.username`): Specifies the name that will appear as the annotation author.
    - **Important**: Update the username to properly identify authors.
- **Enable annotations** (`annotation.enableAnnotations`): Toggles annotation visibility in the editor.
- **Custom colors** (`annotation.colors`):
    - Customize annotation colors, highlight background, and comment borders for both light and dark themes.
- **Enable CodeLens** (`annotation.codelens.enable`): Toggles CodeLens integration.
- **Show commands in CodeLens** (`annotation.codelens.showCommands`): Toggles command display in CodeLens.
- **Default Severity** (`annotation.defaultSeverity`): Choose the severity level automatically applied to new annotations.
- **Native comment threads** (`annotation.commentsView`): Enables the VS Code Comments API integration.
- **Cut recovery window** (`annotation.cutRecoveryWindowSeconds`): Controls how long a cut annotation waits for a matching paste.
- **External store watcher** (`annotation.watchExternalChanges`): Reloads annotations written by MCP or another process.
- **Documentation watch** (`annotation.docs.watch`): Regenerates annotation documentation after changes.
- **Advanced settings**:
    - **Change detection delay** (`annotation.debounceDelay`)
    - **Maximum annotations per file** (`annotation.maxAnnotationsPerFile`)

**Access settings**:

1. Go to **`File`** > **`Preferences`** > **`Settings`** (or **`Code`** > **`Preferences`** > **`Settings`** on Mac).
2. Search for **`annotation`** to view all available settings.

## Extension Settings Overview

You can customize Out-of-Code Insights using the following settings (available in VS Code settings under `annotation` or `llm`):

### AI Provider Settings

- **annotation.provider**: Select the AI provider. Supported values are
  `openai`, `anthropic`, `azure`, `cerebras`, `deepseek`, `google`, `groq`,
  `meta`, `mistralai`, `ollama`, `openrouter`, `lmstudio` and `xai`.
- **annotation.model**: Specify the model to use for the selected provider (e.g., `gpt-4o-mini`, `claude-3-opus`, etc.).
- **llm.apiKeys**: Optional visible user-settings storage selected through
  **Configure AI Provider & Credentials**. Prefer VS Code Secret Storage unless you
  explicitly need settings-based configuration. Example:
    ```json
    "llm.apiKeys": {
      "openai": "sk-...",
      "anthropic": "sk-ant-...",
      "azure": "...",
      "mistralai": "...",
      "groq": "...",
      "ollama": "...",
      "google": "...",
      "openrouter": "...",
      "lmstudio": "...",
      "xai": "..."
    }
    ```
- **annotation.azure.endpoint**, **annotation.azure.deployment** and
  **annotation.azure.apiVersion**: Required Azure OpenAI connection fields.
- **annotation.ollama.baseUrl** and **annotation.lmStudio.baseUrl**: Local
  endpoints; Ollama and LM Studio do not require an API key.
- **annotation.colors.light.annotation**: Annotation color for light theme.
- **annotation.colors.light.highlightBackground**: Highlight background for annotations in light theme.
- **annotation.colors.light.commentBorder**: Comment border color in light theme.
- **annotation.colors.dark.annotation**: Annotation color for dark theme.
- **annotation.colors.dark.highlightBackground**: Highlight background for annotations in dark theme.
- **annotation.colors.dark.commentBorder**: Comment border color in dark theme.
- **annotation.debounceDelay**: Debounce delay (ms) for refreshing annotations.
- **annotation.maxAnnotationsPerFile**: Maximum number of annotations per file.
- **annotation.username**: Username to display as the annotation author.
- **annotation.codelens.enable**: Enable or disable CodeLens for annotations.
- **annotation.codelens.showCommands**: Show or hide commands in CodeLens.
- **annotation.github.repository**: GitHub repository (format: `owner/repo`) for creating issues from annotations.
- **annotation.enableAiSuggest**: Enable or disable the AI Suggest Annotation feature.
- **annotation.path**: Custom path to the annotations file or directory.
- **annotation.defaultSeverity**: Default severity for new annotations (`info`, `warning`, `error`).

---

## LLM Provider and API Key Configuration

To use AI-powered annotation generation, choose one of the exact 13 providers
listed in [AI providers](./docs/llm-providers.md).

### 1. Select the LLM Provider and Model

- Open the extension settings (File > Preferences > Settings or `Ctrl+,`).
- Set `annotation.provider` to your desired LLM provider (e.g., `openai`, `anthropic`, `mistralai`, etc.).
- Set `annotation.model` to the model you want to use for the selected provider (e.g., `gpt-4o-mini`, `claude-3-haiku`, etc.).

### 2. Enter Your API Key

- On the first AI request for a hosted provider without credentials, the
  extension offers **Configure AI Provider & Credentials**.
- Choose secure VS Code Secret Storage or the visible `llm.apiKeys` user
  setting. The manager removes the alternative settings entry when secure
  storage is selected.
- If you switch hosted providers, the extension prompts for that provider's
  key if it is not already set. Ollama and LM Studio require only a reachable
  local endpoint.
- You can add, update or remove a provider key at any time through the same
  command; removal clears every recognized storage location for that provider.

### 3. Usage

- Once the provider, model and required connection values are configured, use
  **AI Suggest Annotation** (`annotations.aiSuggest`) to generate an annotation
  for the current line.
- You can change providers or models at any time in the settings; the relevant key will be requested if needed.

### Notes

- If a required key or Azure connection field is missing, the extension opens
  the guided configuration path instead of silently choosing another provider.
- All hosted-provider keys can be managed through the same command.
- The multi-provider system lets you easily switch between LLMs and models according to your needs or quotas.

## Keyboard Shortcuts

| Action                          | Windows/Linux        | macOS                |
| ------------------------------- | -------------------- | -------------------- |
| Add annotation                  | `Ctrl+Alt+A`         | `Cmd+Alt+A`          |
| Edit annotation                 | `Ctrl+Alt+E`         | `Cmd+Alt+E`          |
| Delete annotation               | `Ctrl+Alt+D`         | `Cmd+Alt+D`          |
| Show annotations panel          | `Ctrl+Alt+S`         | `Cmd+Alt+S`          |
| Toggle annotation visibility    | `Ctrl+Alt+T`         | `Ctrl+Alt+T`         |
| AI Suggest                      | `Ctrl+Alt+I`         | `Cmd+Alt+I`          |
| Navigate to linked annotation   | `Ctrl+Alt+L`         | `Cmd+Alt+L`          |
| Apply annotation template       | `Ctrl+Shift+Alt+T`   | `Cmd+Shift+Alt+T`    |
| Show Kanban board               | `Ctrl+Alt+K`         | `Cmd+Alt+K`          |
| Navigation stack back / forward | `Alt+Left` / `Right` | `Alt+Left` / `Right` |
| Next / previous in Review Mode  | `F8` / `Shift+F8`    | `F8` / `Shift+F8`    |

For every command ID and current keybinding, use the
[command reference above](#-command-reference) or
[`docs/commands.md`](./docs/commands.md). Keeping one canonical table prevents
the README from drifting away from the extension manifest.

## Additional Features

- **Renamed or deleted files**: Automatically updates or removes annotations when files are renamed or deleted.
- **Export and import annotations**: Share or back up annotations, and import them into other projects.
- **Status bar integration**: Displays the number of annotations in the status bar for quick access.
- **Navigate to annotations**: Quickly jump to a specific annotation from the annotations panel.
- **Advanced customization**: Adjust the extension’s behavior to suit your preferences.
- **Batch Edit Annotations**: Efficiently manage multiple annotations with batch editing capabilities.
- **Search Annotation Messages and Metadata**: Search annotation content and metadata from the guided menu.
- **Filter by Severity**: Organize annotations based on their severity levels for better prioritization.
- **Set Annotation Severity**: Assign severity levels to existing annotations.
- **Show AI Suggestion**: Benefit from simulated suggestions to improve your annotation process.
- **Resolve Old Annotations**: Choose an age threshold, review the count and confirm before resolving old open annotations.

## Tree View and Activity Bar

The **Out-of-Code Insights** extension includes a **Tree View** and an **Activity Bar** for efficient annotation management. Here is a detailed description of these features:

### Tree View

The **Tree View** allows you to visualize and manage annotations in a structured manner. It is accessible via the Activity Bar in Visual Studio Code.

- **Grouping by file**: Annotations are grouped by file, making navigation and management easier.

### Example Usage

- **Annotation display**: Each file contains a list of annotations with details such as the author, date, and annotation message.
- **Annotation actions**: You can navigate to an annotation, edit it, delete it, or add comments directly from the Tree View.

### Activity Bar

The **Activity Bar** adds a dedicated icon for **Out-of-Code Insights** in the Visual Studio Code sidebar. Clicking this icon opens the Tree View of annotations.

- **Quick access**: The Activity Bar provides quick access to all annotations in your project.
- **Centralized management**: All annotations are centralized in a single view, making them easier to manage and navigate.

### Example Usage

1. **Open the Tree View**:
    - Click the **Out-of-Code Insights** icon in the Activity Bar.
    - The Tree View opens, displaying annotations grouped by file.

2. **Navigate to an annotation**:
    - Click on an annotation in the Tree View.
    - The code editor automatically positions itself on the line of the selected annotation.

3. **Edit or delete an annotation**:
    - Right-click on an annotation in the Tree View.
    - Select **Edit** or **Delete** from the context menu.

4. **Add a comment**:
    - Select an annotation in the Tree View.
    - Click **Reply** to add a comment to the annotation.

These features enhance annotation management by providing an overview and management tools directly integrated into the Visual Studio Code interface.

## 🔧 Troubleshooting

### Common Issues and Solutions

#### "Annotations not showing in editor"

- **Check visibility**: Use `Ctrl+Alt+T` to toggle annotation display
- **Verify file path**: Ensure annotations.json is in the correct location (`.out-of-code-insights/` by default)
- **Restart VS Code**: Sometimes a restart is needed after installation

#### "An annotation is orphaned or points to the wrong line"

1. Place the cursor on the intended destination line.
2. Run **Re-anchor Annotation to Current Cursor** and select the annotation.
3. If the cause is unclear, run **Show Annotation Tracking Diagnostics**.
4. Check the report for `line-hash-mismatch`, `offset-out-of-document`, or
   `awaiting-paste`. The report contains no source text and is safe to inspect
   locally before sharing.

#### "Dropping an annotation into the code editor does nothing"

- Confirm the VS Code setting `editor.dropIntoEditor.enabled` is enabled.
- Start the drag from an annotation row in the native Out-of-Code Insights
  Tree View, then release it on the destination code line.
- Use **Move Selected Annotations…** or the panel's **Move** button when drag
  transfer is unavailable in the current host.

#### "Template variables not working"

- **Use correct syntax**: Variables should be `{{variableName}}` with double curly braces
- **Check template format**: Ensure template is properly saved and contains variables
- **Verify input**: Make sure you're entering values for all template variables

#### "Linked annotations not navigating correctly"

- **Check the target annotation**: identity-based links report when their target
  was deleted instead of silently opening an obsolete line.
- **Check workspace ownership**: fallback file links are confined to the
  workspace that owns the source annotation; targets outside open workspaces
  are rejected.
- **Inspect both directions**: run **Show Incoming and Outgoing Annotation
  Links** to identify an obsolete legacy file/line relationship.

#### "Kanban board not updating"

- **Refresh manually**: Use the refresh button in the Kanban board
- **Check column assignments**: Ensure annotations are assigned to valid columns
- **Restart extension**: Disable and re-enable the extension if needed

#### "Code snippets not applying"

- **Position correctly**: Ensure cursor is on the annotation line before applying
- **Check snippet syntax**: Variables should use `$1`, `$2`, `${1:placeholder}` format
- **Verify language**: Make sure the snippet language matches the target file

#### "Review Mode not starting"

- **Check filters**: Ensure filter settings aren't excluding all annotations
- **Verify annotations exist**: Make sure there are annotations to review
- **Reset filters**: Clear all filters and try again

#### "Performance issues with large projects"

- **Increase limits**: Adjust `annotation.maxAnnotationsPerFile` in settings
- **Use filters**: Filter annotations by file, author, or date to reduce load
- **Close unused features**: Close Kanban board and Review Mode when not needed

### Getting Help

- **Check settings**: Review all extension settings in VS Code preferences
- **Console logs**: Open Developer Tools (F12) to check for error messages
- **Extension page**: Visit the VS Code marketplace page for updates and known issues
- **Community support**: Use GitHub Discussions for questions and community help

## Known Issues

- **Transitional lifecycle architecture:** the transactional `AnnotationStore`
  owns persistence while a legacy manager still serves a few UI and AI paths.
  Retiring that bridge remains an architectural priority.
- **Inline webview assets:** some panels still embed HTML, CSS, and JavaScript
  in TypeScript template strings. Moving them to independently testable assets
  is planned.
- **Visual regression coverage:** the suite exercises hundreds of Node and
  Electron integration cases, but exhaustive screenshot-based UI comparison is
  not yet automated.

If you hit any other issue, please [open a GitHub Issue](https://github.com/JacquesGariepy/out-of-code-insights/issues) using the bug report template.

## Changelog

Release notes for every published version live in [CHANGELOG.md](./CHANGELOG.md), formatted per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Further reading

In-depth documentation lives in [`docs/`](./docs/README.md):

- [**ROADMAP.md**](./ROADMAP.md): proposed features for upcoming releases (with effort estimates and value rationale).
- [**commands.md**](./docs/commands.md): full command and keyboard shortcut reference.
- [**onboarding.md**](./docs/onboarding.md): step-by-step guide for new contributors.
- [**ai-features.md**](./docs/ai-features.md): end-to-end guide for every AI-powered command.
- [**llm-providers.md**](./docs/llm-providers.md): supported providers, model selection, API-key setup.
- [**architecture.md**](./docs/architecture.md): high-level architecture for contributors.
- [**team-workflow.md**](./docs/team-workflow.md): using annotations across all your workspaces (extension + MCP + sync).
- [**documentation-authoring.md**](./docs/documentation-authoring.md): writing documentation from annotations.
- [**manual-test-guide.md**](./docs/manual-test-guide.md): per-version manual test matrix.

## Community and support

[GitHub Discussions](https://github.com/JacquesGariepy/out-of-code-insights/discussions)
is the best place for questions, workflows, and feature ideas. Use
[GitHub Issues](https://github.com/JacquesGariepy/out-of-code-insights/issues)
for reproducible bugs and enhancement requests.

[![GitHub](https://img.shields.io/badge/GitHub-JacquesGariepy-181717?logo=github)](https://github.com/JacquesGariepy)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Jacques%20Gari%C3%A9py-0A66C2?logo=linkedin)](https://linkedin.com/in/jacquesgariepy)
[![X](https://img.shields.io/badge/X-@jacquesgariepy-000000?logo=x)](https://x.com/jacquesgariepy)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-Support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/jacquesgarx)

## Contribution

Contributions are welcome! Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, build/test workflow, code style rules, and pull request process. Security disclosures: see [SECURITY.md](./SECURITY.md). Community standards: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

Good entry points for new contributors are issues labelled `good first issue` and `help wanted`.

## License

This project is licensed under the **Mozilla Public License 2.0 (MPL-2.0)**: a permissive copyleft license that lets you use the extension in proprietary projects while requiring that modifications to MPL-2.0 source files remain available under MPL-2.0. See the [LICENSE](./LICENSE) file for the full text.

By contributing to this project you agree that your contributions will be licensed under MPL-2.0; no Contributor License Agreement (CLA) is required.

The icon assets from `@vscode/codicons` are licensed under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) (Microsoft Corporation).
See [NOTICE](./NOTICE) for the full third-party attribution list.
