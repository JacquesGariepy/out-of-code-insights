# out-of-code-insights-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI agents read and
write **Out-of-Code Insights** annotations *outside* VS Code.

It operates on the exact same file the extension persists — the schema-v2 envelope at
`<workspace>/.out-of-code-insights/annotations.json`:

```json
{ "schemaVersion": 2, "annotations": [ ... ] }
```

Anchoring is shared with the extension: the server imports the pure modules `src/anchoring/anchor.ts` and
`src/docs/AnnotationDocGenerator.ts` from the repository sources, so line hashes, context capture and the generated
documentation are byte-compatible with what the extension produces.

## Requirements

- Node.js >= 18

## Install and build

```bash
cd mcp-server
npm install
npm run build
```

The build compiles `src/` **plus** the shared repository sources it imports (`../src/anchoring`, `../src/common`,
`../src/docs`) into `dist/`. If the build cannot resolve the `diff` dependency used by the anchoring module, run
`npm install` once at the repository root as well.

## Run

The server speaks MCP over **stdio**. The workspace root (the folder containing `.out-of-code-insights/`) is
resolved in this order:

1. `--workspace <path>` (or `--workspace=<path>`) command-line argument
2. `ANNOTATIONS_WORKSPACE` environment variable
3. current working directory

```bash
node bin/out-of-code-insights-mcp.js --workspace /path/to/your/project
```

## MCP client configuration

### Claude Code

```bash
claude mcp add out-of-code-insights -- node /absolute/path/to/out-of-code-insights/mcp-server/bin/out-of-code-insights-mcp.js --workspace /absolute/path/to/your/project
```

On Windows:

```bash
claude mcp add out-of-code-insights -- node E:/sources/out-of-code-insights/mcp-server/bin/out-of-code-insights-mcp.js --workspace E:/sources/your-project
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
    "mcpServers": {
        "out-of-code-insights": {
            "command": "node",
            "args": [
                "E:/sources/out-of-code-insights/mcp-server/bin/out-of-code-insights-mcp.js",
                "--workspace",
                "E:/sources/your-project"
            ]
        }
    }
}
```

Alternatively, omit `--workspace` and set the environment variable instead:

```json
{
    "mcpServers": {
        "out-of-code-insights": {
            "command": "node",
            "args": ["E:/sources/out-of-code-insights/mcp-server/bin/out-of-code-insights-mcp.js"],
            "env": { "ANNOTATIONS_WORKSPACE": "E:/sources/your-project" }
        }
    }
}
```

## Tools

| Tool                 | Arguments                                                            | Result                                                                             |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `list_annotations`   | `file?`, `tag?`, `state?` (`active`/`suspended`/`disposed`)           | Annotations with a resolved 0-based `line` (-1 when the file is unreadable)         |
| `get_annotation`     | `id`                                                                  | One annotation with its resolved `line`                                             |
| `add_annotation`     | `file`, `line` (0-based), `message`, `tags?`, `severity?`, `author?`  | The created annotation (UUID id, offsets + content anchor captured from the file)   |
| `update_annotation`  | `id`, `message?`, `tags?`, `severity?`, `resolved?`, `kanbanColumn?`  | The updated annotation                                                              |
| `remove_annotation`  | `id`                                                                  | `{ id, removed: true }`                                                             |
| `link_annotations`   | `id`, `targetFile`, `targetLine` (0-based), `relationship`            | The source annotation with the appended link                                        |
| `code_graph`         | —                                                                     | `{ nodes: [{id,file,line,message,tags}], edges: [{from,toFile,toLine,relationship}] }` |
| `generate_docs`      | `outputPath?` (default `docs/annotations`)                            | Written file paths under `<workspace>/<outputPath>`                                 |

Notes:

- Source files are **never** modified — only `.out-of-code-insights/annotations.json` (and, for `generate_docs`,
  files under the output folder) are written.
- Writes are atomic (temp file + rename), so a concurrent reader never sees a partial envelope.
- `file` paths are workspace-relative; `..` segments and absolute paths are rejected.

## Interop with the VS Code extension

The extension loads the annotations file once at activation and keeps its own in-memory store. There is **no file
watcher yet**: changes made by this MCP server while VS Code is open are picked up on the next **window reload**
(`Developer: Reload Window`). The reverse direction is safe at any time — the server re-reads the envelope before
every operation.
