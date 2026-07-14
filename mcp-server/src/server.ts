// SPDX-License-Identifier: MPL-2.0
//
// Stdio MCP server exposing the Out-of-Code Insights annotation store to AI
// agents outside VS Code. Tools operate on the same v2 envelope the
// extension persists at <workspace>/.out-of-code-insights/annotations.json.
//
// stdout is reserved for the MCP protocol — diagnostics go to stderr only.

import * as fsSync from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AnnotationFileStore, resolveWorkspaceRoot } from './store';

const SERVER_NAME = 'out-of-code-insights-mcp';
const SERVER_VERSION = '0.1.0';

function ok(data: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
    try {
        return ok(await fn());
    } catch (err) {
        return fail(err);
    }
}

const fileArg = z
    .string()
    .min(1)
    .describe('Workspace-relative file path (forward or back slashes), e.g. "src/extension.ts"');

export function buildServer(store: AnnotationFileStore): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

    server.registerTool(
        'list_annotations',
        {
            description:
                'List code annotations stored in <workspace>/.out-of-code-insights/annotations.json. ' +
                'Each result carries a resolved 0-based `line` derived from its startOffset against the ' +
                'current file content (-1 when the file cannot be read). All filters are optional and combine (AND).',
            inputSchema: {
                file: fileArg.optional().describe('Only annotations anchored in this workspace-relative file'),
                tag: z.string().optional().describe('Only annotations carrying this exact tag'),
                state: z
                    .enum(['active', 'suspended', 'disposed'])
                    .optional()
                    .describe('Only annotations in this lifecycle state'),
            },
        },
        (args) => run(() => store.list(args))
    );

    server.registerTool(
        'get_annotation',
        {
            description:
                'Fetch a single annotation by id, with its resolved 0-based `line` ' +
                '(-1 when the anchored file cannot be read).',
            inputSchema: {
                id: z.string().min(1).describe('Annotation id (RFC4122 v4 UUID)'),
            },
        },
        (args) => run(() => store.get(args.id))
    );

    server.registerTool(
        'add_annotation',
        {
            description:
                'Create an annotation on a line of a workspace file. The file is NOT modified: the annotation ' +
                'is stored in .out-of-code-insights/annotations.json with offsets and a content anchor ' +
                '(line hash + surrounding context) captured from the current file content so it can re-locate ' +
                'itself after edits. Returns the created annotation with its resolved 0-based `line`.',
            inputSchema: {
                file: fileArg,
                line: z.number().int().min(0).describe('0-based line number to annotate (clamped to the file length)'),
                message: z.string().min(1).describe('Annotation body (Markdown supported)'),
                tags: z.array(z.string()).optional().describe('Free-form tags, e.g. ["todo", "doc:function"]'),
                severity: z.string().optional().describe('Severity label, e.g. "info", "warning", "error"'),
                author: z.string().optional().describe('Author handle recorded on the annotation'),
            },
        },
        (args) => run(() => store.add(args))
    );

    server.registerTool(
        'update_annotation',
        {
            description:
                'Update fields of an existing annotation. Only the provided fields change; ' +
                'anchoring (file, offsets, hash, context) is never touched by this tool.',
            inputSchema: {
                id: z.string().min(1).describe('Annotation id'),
                message: z.string().optional().describe('New annotation body'),
                tags: z.array(z.string()).optional().describe('Replacement tag list (overwrites existing tags)'),
                severity: z.string().optional().describe('New severity label'),
                resolved: z.boolean().optional().describe('Mark the annotation resolved/unresolved'),
                kanbanColumn: z.string().optional().describe('Kanban column id to place the annotation in'),
            },
        },
        (args) => run(() => store.update(args.id, args))
    );

    server.registerTool(
        'remove_annotation',
        {
            description: 'Delete an annotation by id. The annotated source file is not touched.',
            inputSchema: {
                id: z.string().min(1).describe('Annotation id'),
            },
        },
        (args) => run(() => store.remove(args.id))
    );

    server.registerTool(
        'link_annotations',
        {
            description:
                'Append a directed link from an annotation to a location in another (or the same) file. ' +
                'Links express relationships such as "implements", "references" or "related" and feed the ' +
                'code_graph tool.',
            inputSchema: {
                id: z.string().min(1).describe('Source annotation id'),
                targetFile: fileArg.describe('Workspace-relative path of the link target file'),
                targetLine: z.number().int().min(0).describe('0-based line in the target file'),
                relationship: z
                    .string()
                    .min(1)
                    .describe('Relationship label, e.g. "implements", "references", "related"'),
            },
        },
        (args) => run(() => store.link(args.id, args))
    );

    server.registerTool(
        'code_graph',
        {
            description:
                'Project the annotation set into a graph: one node per annotation (id, file, resolved 0-based ' +
                'line, message, tags) and one edge per linkedAnnotations entry (from annotation id to a ' +
                'file/line target with its relationship label).',
            inputSchema: {},
        },
        () => run(() => store.codeGraph())
    );

    server.registerTool(
        'generate_docs',
        {
            description:
                'Generate a portable Markdown documentation set (index, by-type, by-file, links, ' +
                'toc.yml, plus authored API pages from doc:* tags) from all annotations. Files are written ' +
                'under <workspace>/<outputPath> (default docs/annotations). Returns the written paths.',
            inputSchema: {
                outputPath: z
                    .string()
                    .optional()
                    .describe('Workspace-relative output folder (default "docs/annotations"); no ".." segments'),
            },
        },
        (args) => run(() => store.generateDocs(args.outputPath))
    );

    return server;
}

async function main(): Promise<void> {
    const workspaceRoot = resolveWorkspaceRoot(process.argv.slice(2), process.env);
    let isDirectory = false;
    try {
        isDirectory = fsSync.statSync(workspaceRoot).isDirectory();
    } catch {
        isDirectory = false;
    }
    if (!isDirectory) {
        console.error(`${SERVER_NAME}: workspace root is not a directory: ${workspaceRoot}`);
        console.error('Pass --workspace <path> or set the ANNOTATIONS_WORKSPACE environment variable.');
        process.exit(1);
    }

    const store = new AnnotationFileStore(workspaceRoot);
    const server = buildServer(store);
    await server.connect(new StdioServerTransport());
    console.error(`${SERVER_NAME} ${SERVER_VERSION} ready (workspace: ${workspaceRoot})`);
}

main().catch((err: unknown) => {
    console.error(`${SERVER_NAME}: fatal`, err);
    process.exit(1);
});
