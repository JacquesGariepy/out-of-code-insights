# Team workflow — annotations across all your workspaces

Out-of-Code Insights stores every note, review comment and documentation block **outside the source files**,
in `<workspace>/.out-of-code-insights/annotations.json` (schema v2). That single file is the contract shared
by three surfaces, so a whole team — or a solo developer with many repos — can work the same annotations from
wherever they are:

| Surface                                       | What it is                                            | Best for                                                         |
| --------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| **VS Code extension**                         | In-editor gutter, panel, Comments API threads, Kanban | Day-to-day review and authoring while coding                     |
| **MCP server** (`mcp-server/`)                | Lets AI agents read/write annotations outside VS Code | Agents annotating code, building the code graph, generating docs |
| **License + sync server** (`license-server/`) | Self-hosted validation + annotation sync API          | Sharing one annotation set across a team, gating Pro features    |

Because all three read and write the same `annotations.json`, edits made anywhere show up everywhere — the
extension reloads external changes live (`annotation.watchExternalChanges`).

## 1. One workspace

1. Annotate while coding (extension): cursor on a line → **Add Annotation**, or the Comments gutter `+`.
2. Tag for purpose: `bug`, `decision`, `todo`, or a `doc:*` role for documentation.
3. Generate documentation: **Generate Annotation Documentation** → a DocFX-compatible Markdown site under
   `docs/annotations/` (configurable).
4. Onboard agents: **Set Up AI Agent Instructions** writes a marked block into `CLAUDE.md` and `AGENTS.md`
   telling agents to annotate through the MCP tools (not source comments) and to tag docs with `doc:*`.

## 2. Sharing across a team (sync)

Run the license server (`license-server/`, Docker-ready), issue keys with its CLI (or via the Stripe webhook),
then in VS Code:

1. Set `annotation.sync.serverUrl` and `annotation.sync.workspaceId`.
2. **Configure Annotation Sync** (store the bearer token = license key).
3. **Sync Annotations Now**, or enable `annotation.sync.auto`. The ☁ status bar item shows state; divergence
   prompts **Keep local** / **Take remote** (optimistic concurrency).

Gate sync (or any feature id) behind a license by adding it to `annotation.pro.gatedFeatures` — everything is
free until you do.

## 3. AI agents (MCP)

Register the MCP server with any MCP client (**MCP Server Setup** copies the config). Agents then call
`add_annotation`, `list_annotations`, `link_annotations`, `code_graph`, `generate_docs` — annotating code
**without modifying it**. The extension reloads those writes live.

## Anatomy of an annotation

Stored fields (schema v2): `id`, `file` / `fileUri`, `startOffset`/`endOffset` + `lineHash` +
`contextBefore`/`contextAfter` (so it re-anchors when code moves), `message` (Markdown), `tags`, `severity`,
`resolved`, `thread` (replies), `linkedAnnotations`, `kanbanColumn`, `priority`, and a `doc:*` tag when it is
documentation. Nothing is ever written into your source files.

See also: [documentation-authoring.md](documentation-authoring.md),
[manual-test-guide.md](manual-test-guide.md), [commands.md](commands.md).
