// SPDX-License-Identifier: MPL-2.0
//
// File-backed store for the v2 annotations envelope, used by the MCP server
// to read and mutate <workspace>/.out-of-code-insights/annotations.json
// outside the VS Code extension host.
//
// - Every mutation is read-modify-write with an atomic replace (temp file +
//   rename) so a concurrent reader never observes a partial document.
// - Anchoring (lineHash/context capture) reuses the extension's pure module
//   src/anchoring/anchor.ts via a relative source import; TextBuffer
//   provides the TextDocumentLike implementation over a file's text.
// - Display lines are always derived from `startOffset` against the current
//   file content (-1 when the file cannot be read), never persisted.

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { captureAnchor } from '../../src/anchoring/anchor';
import { TextBuffer } from '../../src/anchoring/textBuffer';
import { toFileUriString } from '../../src/common/fileUri';
import { generateDocSet, type DocAnnotation } from '../../src/docs/AnnotationDocGenerator';
import {
    ANNOTATION_SCHEMA_VERSION,
    type AnnotationEnvelope,
    type AnnotationLifecycle,
    type AnnotationV2,
} from './types';

/** Envelope location relative to the workspace root. */
export const ANNOTATIONS_RELATIVE_PATH = '.out-of-code-insights/annotations.json';

/** Annotation augmented with its resolved 0-based display line (-1 = unresolvable). */
export type ResolvedAnnotation = AnnotationV2 & { line: number };

export interface ListFilter {
    file?: string;
    tag?: string;
    state?: AnnotationLifecycle;
}

export interface AddInput {
    file: string;
    /** 0-based line to annotate. Clamped into the file's line range. */
    line: number;
    message: string;
    tags?: string[];
    severity?: string;
    author?: string;
}

export interface UpdatePatch {
    message?: string;
    tags?: string[];
    severity?: string;
    resolved?: boolean;
    kanbanColumn?: string;
}

export interface LinkInput {
    targetFile: string;
    /** 0-based line in the target file. */
    targetLine: number;
    relationship: string;
}

export interface CodeGraph {
    nodes: { id: string; file: string; line: number; message: string; tags: string[] }[];
    edges: { from: string; toFile: string; toLine: number; relationship: string }[];
}

export interface GenerateDocsResult {
    /** Workspace-relative output folder (forward slashes). */
    outputDir: string;
    /** Workspace-relative paths of every file written (forward slashes). */
    files: string[];
}

/**
 * Resolve the workspace root from `--workspace <path>` / `--workspace=<path>`
 * argv, then the ANNOTATIONS_WORKSPACE environment variable, then cwd.
 */
export function resolveWorkspaceRoot(argv: readonly string[], env: NodeJS.ProcessEnv): string {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--workspace') {
            const value = argv[i + 1];
            if (!value) {
                throw new Error('--workspace requires a path argument');
            }
            return path.resolve(value);
        }
        if (arg.startsWith('--workspace=')) {
            return path.resolve(arg.slice('--workspace='.length));
        }
    }
    const fromEnv = env.ANNOTATIONS_WORKSPACE;
    if (fromEnv && fromEnv.trim().length > 0) {
        return path.resolve(fromEnv.trim());
    }
    return process.cwd();
}

export class AnnotationFileStore {
    readonly workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = path.resolve(workspaceRoot);
    }

    get annotationsPath(): string {
        return path.join(this.workspaceRoot, ...ANNOTATIONS_RELATIVE_PATH.split('/'));
    }

    // ── Envelope IO ──────────────────────────────────────────────────────

    /**
     * Read the envelope from disk. Missing file → empty v2 envelope.
     * Present but unparsable / wrong schemaVersion → throws.
     */
    async load(): Promise<AnnotationEnvelope> {
        let raw: string;
        try {
            raw = await fs.readFile(this.annotationsPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return { schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: [] };
            }
            throw err;
        }
        const parsed = JSON.parse(raw) as AnnotationEnvelope;
        if (parsed.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new Error(
                `Unsupported schemaVersion ${String(parsed.schemaVersion)} (expected ${ANNOTATION_SCHEMA_VERSION})`
            );
        }
        if (!Array.isArray(parsed.annotations)) {
            throw new Error('Malformed envelope: `annotations` must be an array');
        }
        return parsed;
    }

    /** Atomic write: temp file in the same directory, then rename over the target. */
    async save(envelope: AnnotationEnvelope): Promise<void> {
        const target = this.annotationsPath;
        await fs.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), 'utf8');
        try {
            await fs.rename(tmp, target);
        } catch (err) {
            await fs.unlink(tmp).catch(() => undefined);
            throw err;
        }
    }

    /** Read-modify-write. If `fn` throws, nothing is persisted. */
    private async mutate<T>(fn: (envelope: AnnotationEnvelope) => T): Promise<T> {
        const envelope = await this.load();
        const result = fn(envelope);
        await this.save(envelope);
        return result;
    }

    // ── Path / line helpers ──────────────────────────────────────────────

    private normalizeRelativePath(file: string): string {
        const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (normalized.trim().length === 0) {
            throw new Error('file must be a non-empty workspace-relative path');
        }
        if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
            throw new Error(`file must be relative to the workspace root (got ${file})`);
        }
        if (normalized.split('/').includes('..')) {
            throw new Error(`file must not contain '..' segments (got ${file})`);
        }
        return normalized;
    }

    private absolutePathOf(relativeFile: string): string {
        return path.join(this.workspaceRoot, ...relativeFile.split('/'));
    }

    /** Read a workspace file into a TextBuffer; null when unreadable. Cached per call. */
    private async bufferFor(relativeFile: string, cache: Map<string, TextBuffer | null>): Promise<TextBuffer | null> {
        const key = relativeFile.replace(/\\/g, '/');
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        let buffer: TextBuffer | null = null;
        try {
            const text = await fs.readFile(this.absolutePathOf(key), 'utf8');
            buffer = new TextBuffer(text);
        } catch {
            buffer = null;
        }
        cache.set(key, buffer);
        return buffer;
    }

    /** Resolve the current 0-based display line of an annotation (-1 if unreadable). */
    private async resolveLineOf(annotation: AnnotationV2, cache: Map<string, TextBuffer | null>): Promise<number> {
        const buffer = await this.bufferFor(annotation.file, cache);
        return buffer ? buffer.lineAtOffset(annotation.startOffset) : -1;
    }

    private async withResolvedLine(annotation: AnnotationV2): Promise<ResolvedAnnotation> {
        const cache = new Map<string, TextBuffer | null>();
        return { ...annotation, line: await this.resolveLineOf(annotation, cache) };
    }

    private findOrThrow(envelope: AnnotationEnvelope, id: string): AnnotationV2 {
        const annotation = envelope.annotations.find((a) => a.id === id);
        if (!annotation) {
            throw new Error(`No annotation with id ${id}`);
        }
        return annotation;
    }

    // ── Operations ───────────────────────────────────────────────────────

    async list(filter: ListFilter = {}): Promise<ResolvedAnnotation[]> {
        const envelope = await this.load();
        const fileFilter = filter.file ? filter.file.replace(/\\/g, '/') : undefined;
        const matches = envelope.annotations.filter((a) => {
            if (fileFilter && a.file.replace(/\\/g, '/') !== fileFilter) {
                return false;
            }
            if (filter.tag && !(a.tags ?? []).includes(filter.tag)) {
                return false;
            }
            if (filter.state && a.state !== filter.state) {
                return false;
            }
            return true;
        });
        const cache = new Map<string, TextBuffer | null>();
        const out: ResolvedAnnotation[] = [];
        for (const a of matches) {
            out.push({ ...a, line: await this.resolveLineOf(a, cache) });
        }
        return out;
    }

    async get(id: string): Promise<ResolvedAnnotation> {
        const envelope = await this.load();
        return this.withResolvedLine(this.findOrThrow(envelope, id));
    }

    async add(input: AddInput): Promise<ResolvedAnnotation> {
        const relative = this.normalizeRelativePath(input.file);
        const absolute = this.absolutePathOf(relative);
        let text: string;
        try {
            text = await fs.readFile(absolute, 'utf8');
        } catch (err) {
            throw new Error(`Cannot read ${relative}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const buffer = new TextBuffer(text);
        const line = Math.max(0, Math.min(input.line, buffer.lineCount - 1));
        const anchor = captureAnchor(buffer, line);
        const startOffset = buffer.offsetAt(line);
        const endOffset = buffer.lineEndOffset(line);

        const annotation: AnnotationV2 = {
            id: randomUUID(),
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            fileUri: toFileUriString(absolute),
            file: relative,
            startOffset,
            endOffset,
            lineHash: anchor.lineHash,
            contextBefore: anchor.contextBefore,
            contextAfter: anchor.contextAfter,
            state: 'active',
            origin: { kind: 'manual' },
            message: input.message,
            timestamp: new Date().toISOString(),
        };
        if (input.author) {
            annotation.author = input.author;
        }
        if (input.tags && input.tags.length > 0) {
            annotation.tags = input.tags;
        }
        if (input.severity) {
            annotation.severity = input.severity;
        }

        await this.mutate((envelope) => envelope.annotations.push(annotation));
        return { ...annotation, line };
    }

    async update(id: string, patch: UpdatePatch): Promise<ResolvedAnnotation> {
        const updated = await this.mutate((envelope) => {
            const target = this.findOrThrow(envelope, id);
            if (patch.message !== undefined) {
                target.message = patch.message;
            }
            if (patch.tags !== undefined) {
                target.tags = patch.tags;
            }
            if (patch.severity !== undefined) {
                target.severity = patch.severity;
            }
            if (patch.resolved !== undefined) {
                target.resolved = patch.resolved;
            }
            if (patch.kanbanColumn !== undefined) {
                target.kanbanColumn = patch.kanbanColumn;
            }
            return target;
        });
        return this.withResolvedLine(updated);
    }

    async remove(id: string): Promise<{ id: string; removed: true }> {
        await this.mutate((envelope) => {
            const index = envelope.annotations.findIndex((a) => a.id === id);
            if (index === -1) {
                throw new Error(`No annotation with id ${id}`);
            }
            envelope.annotations.splice(index, 1);
        });
        return { id, removed: true };
    }

    async link(id: string, input: LinkInput): Promise<ResolvedAnnotation> {
        const targetFile = this.normalizeRelativePath(input.targetFile);
        const linked = await this.mutate((envelope) => {
            const target = this.findOrThrow(envelope, id);
            const links = target.linkedAnnotations ?? (target.linkedAnnotations = []);
            links.push({
                targetFile,
                targetLine: input.targetLine,
                relationship: input.relationship,
            });
            return target;
        });
        return this.withResolvedLine(linked);
    }

    async codeGraph(): Promise<CodeGraph> {
        const envelope = await this.load();
        const cache = new Map<string, TextBuffer | null>();
        const nodes: CodeGraph['nodes'] = [];
        const edges: CodeGraph['edges'] = [];
        for (const a of envelope.annotations) {
            nodes.push({
                id: a.id,
                file: a.file,
                line: await this.resolveLineOf(a, cache),
                message: a.message,
                tags: a.tags ?? [],
            });
            for (const link of a.linkedAnnotations ?? []) {
                edges.push({
                    from: a.id,
                    toFile: link.targetFile,
                    toLine: link.targetLine,
                    relationship: link.relationship,
                });
            }
        }
        return { nodes, edges };
    }

    async generateDocs(outputPath?: string): Promise<GenerateDocsResult> {
        const setting = (outputPath ?? '').replace(/\\/g, '/').trim() || 'docs/annotations';
        const segments = setting.split('/').filter((s) => s.length > 0);
        if (path.isAbsolute(setting) || /^[A-Za-z]:/.test(setting) || segments.includes('..') || segments.length === 0) {
            throw new Error(`outputPath must be a relative path inside the workspace, without '..' (got ${setting})`);
        }

        const envelope = await this.load();
        const cache = new Map<string, TextBuffer | null>();
        const docAnnotations: DocAnnotation[] = [];
        for (const a of envelope.annotations) {
            const buffer = await this.bufferFor(a.file, cache);
            let line = -1;
            let anchorText: string | undefined;
            if (buffer) {
                line = buffer.lineAtOffset(a.startOffset);
                anchorText = buffer.lineAt(line).text;
            }
            docAnnotations.push({
                id: a.id,
                file: a.file,
                line,
                state: a.state,
                message: a.message,
                author: a.author,
                timestamp: a.timestamp,
                tags: a.tags,
                severity: a.severity,
                resolved: a.resolved,
                priority: a.priority,
                kanbanColumn: a.kanbanColumn,
                thread: a.thread,
                linkedAnnotations: a.linkedAnnotations,
                snippet: a.snippet,
                anchorText,
                language: a.languageId,
            });
        }

        const files = generateDocSet(docAnnotations, {
            sourceLinkPrefix: '../'.repeat(segments.length),
            generatedAt: new Date().toISOString(),
        });

        const outDir = path.join(this.workspaceRoot, ...segments);
        const written: string[] = [];
        for (const [name, content] of files) {
            const target = path.join(outDir, ...name.split('/'));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, content, 'utf8');
            written.push([...segments, ...name.split('/')].join('/'));
        }
        return { outputDir: segments.join('/'), files: written.sort() };
    }
}
