// SPDX-License-Identifier: MPL-2.0
//
// Pure documentation generator: projects the annotation set into a small
// DocFX-compatible Markdown site (toc.yml + index.md + by-type.md +
// by-file.md + links.md). No vscode runtime dependency — the command layer
// resolves display lines and writes the returned files to disk.
//
// Taxonomy: tags act as the annotation "type" axis (e.g. `api`, `decision`,
// `todo`). Untagged annotations land in the `untagged` bucket. Severity,
// kanban column and resolution state are secondary facets on the overview.

/** Input model — annotation projected for documentation purposes. */
export interface DocAnnotation {
    id: string;
    /** Workspace-relative display path. */
    file: string;
    /** Resolved 0-based line, or -1 when the document could not be read. */
    line: number;
    state: string;
    message: string;
    author?: string;
    timestamp: string;
    tags?: string[];
    severity?: string;
    resolved?: boolean;
    priority?: number;
    kanbanColumn?: string;
    thread?: { message: string; author?: string; timestamp: string }[];
    linkedAnnotations?: { targetFile: string; targetLine: number; relationship: string }[];
    snippet?: { code: string; language: string };
}

export interface DocGenOptions {
    /** Site title. Default: "Annotations". */
    title?: string;
    /**
     * Path prefix from the output folder back to the workspace root, used in
     * source links (e.g. "../../" when the docs land in docs/annotations/).
     */
    sourceLinkPrefix?: string;
    /** ISO timestamp stamped on every page. Caller-provided for determinism. */
    generatedAt?: string;
}

const UNTAGGED = 'untagged';

/** Escape characters that break Markdown table cells. */
function escapeCell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** One-line summary of an annotation message (first line, capped). */
function summarize(message: string, max = 80): string {
    const first = message.split('\n')[0].trim();
    return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

/** Markdown link from a docs page to a source location. */
function sourceLink(a: DocAnnotation, prefix: string): string {
    const lineSuffix = a.line >= 0 ? `#L${a.line + 1}` : '';
    const display = a.line >= 0 ? `${a.file}:${a.line + 1}` : a.file;
    return `[${escapeCell(display)}](<${prefix}${a.file}${lineSuffix}>)`;
}

/** Anchor id used to deep-link an annotation inside by-file.md. */
function anchorId(a: DocAnnotation): string {
    return `ann-${a.id}`;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
        const k = key(item);
        const bucket = map.get(k);
        if (bucket) {
            bucket.push(item);
        } else {
            map.set(k, [item]);
        }
    }
    return map;
}

function sortedAnnotations(annotations: DocAnnotation[]): DocAnnotation[] {
    return [...annotations].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line || x.id.localeCompare(y.id));
}

function pageHeader(title: string, generatedAt: string | undefined): string {
    const stamp = generatedAt ? `\n> Generated on ${generatedAt} by Out-of-Code Insights.\n` : '\n';
    return `# ${title}\n${stamp}\n`;
}

function tagsOf(a: DocAnnotation): string[] {
    return a.tags && a.tags.length > 0 ? a.tags : [UNTAGGED];
}

function renderAnnotationDetail(a: DocAnnotation, prefix: string): string {
    const lines: string[] = [];
    lines.push(`<a id="${anchorId(a)}"></a>`);
    lines.push('');
    lines.push(`### ${summarize(a.message)}`);
    lines.push('');
    const facts: string[] = [];
    facts.push(`**Source**: ${sourceLink(a, prefix)}`);
    if (a.severity) {
        facts.push(`**Severity**: ${escapeCell(a.severity)}`);
    }
    facts.push(`**Type**: ${tagsOf(a).map(escapeCell).join(', ')}`);
    if (a.kanbanColumn) {
        facts.push(`**Board**: ${escapeCell(a.kanbanColumn)}`);
    }
    if (typeof a.priority === 'number') {
        facts.push(`**Priority**: ${a.priority}`);
    }
    facts.push(`**State**: ${a.resolved ? 'resolved' : a.state}`);
    if (a.author) {
        facts.push(`**Author**: ${escapeCell(a.author)}`);
    }
    facts.push(`**Created**: ${a.timestamp}`);
    lines.push(facts.join(' · '));
    lines.push('');
    if (a.message.includes('\n') || a.message.trim() !== summarize(a.message)) {
        lines.push(a.message.trim());
        lines.push('');
    }
    if (a.snippet && a.snippet.code.trim().length > 0) {
        lines.push('```' + (a.snippet.language || ''));
        lines.push(a.snippet.code.replace(/\r\n/g, '\n').trimEnd());
        lines.push('```');
        lines.push('');
    }
    if (a.linkedAnnotations && a.linkedAnnotations.length > 0) {
        lines.push('**Links**:');
        lines.push('');
        for (const link of a.linkedAnnotations) {
            const target = `[${escapeCell(link.targetFile)}:${link.targetLine + 1}](<${prefix}${link.targetFile}#L${link.targetLine + 1}>)`;
            lines.push(`- *${escapeCell(link.relationship)}* → ${target}`);
        }
        lines.push('');
    }
    if (a.thread && a.thread.length > 0) {
        lines.push('**Discussion**:');
        lines.push('');
        for (const comment of a.thread) {
            const who = comment.author ? `${comment.author} — ` : '';
            lines.push(`> ${who}${comment.timestamp}`);
            for (const l of comment.message.split('\n')) {
                lines.push(`> ${l}`);
            }
            lines.push('>');
        }
        lines.push('');
    }
    return lines.join('\n');
}

function renderIndex(annotations: DocAnnotation[], options: DocGenOptions): string {
    const title = options.title ?? 'Annotations';
    const out: string[] = [pageHeader(title, options.generatedAt)];

    const total = annotations.length;
    const resolved = annotations.filter((a) => a.resolved).length;
    const suspended = annotations.filter((a) => a.state === 'suspended').length;
    out.push(`**${total}** annotation(s) — ${resolved} resolved, ${suspended} awaiting paste-back.`);
    out.push('');

    out.push('## By type');
    out.push('');
    out.push('| Type | Count |');
    out.push('| --- | ---: |');
    const byTag = new Map<string, number>();
    for (const a of annotations) {
        for (const t of tagsOf(a)) {
            byTag.set(t, (byTag.get(t) ?? 0) + 1);
        }
    }
    for (const [tag, count] of [...byTag.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
        out.push(`| [${escapeCell(tag)}](by-type.md) | ${count} |`);
    }
    out.push('');

    out.push('## By severity');
    out.push('');
    out.push('| Severity | Count |');
    out.push('| --- | ---: |');
    const bySeverity = groupBy(annotations, (a) => a.severity ?? 'none');
    for (const [severity, items] of [...bySeverity.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
        out.push(`| ${escapeCell(severity)} | ${items.length} |`);
    }
    out.push('');

    out.push('## By file');
    out.push('');
    out.push('| File | Count |');
    out.push('| --- | ---: |');
    const byFile = groupBy(annotations, (a) => a.file);
    for (const [file, items] of [...byFile.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
        out.push(`| [${escapeCell(file)}](by-file.md) | ${items.length} |`);
    }
    out.push('');
    return out.join('\n');
}

function renderByType(annotations: DocAnnotation[], options: DocGenOptions): string {
    const out: string[] = [pageHeader('Annotations by type', options.generatedAt)];
    const expanded: { tag: string; a: DocAnnotation }[] = [];
    for (const a of annotations) {
        for (const tag of tagsOf(a)) {
            expanded.push({ tag, a });
        }
    }
    const byTag = groupBy(expanded, (e) => e.tag);
    for (const [tag, entries] of [...byTag.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
        out.push(`## ${escapeCell(tag)}`);
        out.push('');
        out.push('| Annotation | Source | Severity | State |');
        out.push('| --- | --- | --- | --- |');
        for (const a of sortedAnnotations(entries.map((e) => e.a))) {
            const detail = `[${escapeCell(summarize(a.message))}](by-file.md#${anchorId(a)})`;
            const state = a.resolved ? 'resolved' : a.state;
            out.push(
                `| ${detail} | ${sourceLink(a, options.sourceLinkPrefix ?? '')} | ${escapeCell(a.severity ?? '')} | ${state} |`
            );
        }
        out.push('');
    }
    return out.join('\n');
}

function renderByFile(annotations: DocAnnotation[], options: DocGenOptions): string {
    const out: string[] = [pageHeader('Annotations by file', options.generatedAt)];
    const byFile = groupBy(sortedAnnotations(annotations), (a) => a.file);
    for (const [file, items] of byFile) {
        out.push(`## ${escapeCell(file)}`);
        out.push('');
        for (const a of items) {
            out.push(renderAnnotationDetail(a, options.sourceLinkPrefix ?? ''));
        }
    }
    return out.join('\n');
}

function renderLinks(annotations: DocAnnotation[], options: DocGenOptions): string {
    const out: string[] = [pageHeader('Annotation links', options.generatedAt)];
    const linked = sortedAnnotations(annotations).filter((a) => a.linkedAnnotations && a.linkedAnnotations.length > 0);
    if (linked.length === 0) {
        out.push('_No linked annotations._');
        out.push('');
        return out.join('\n');
    }
    out.push('| From | Relationship | To |');
    out.push('| --- | --- | --- |');
    for (const a of linked) {
        for (const link of a.linkedAnnotations ?? []) {
            const from = `[${escapeCell(summarize(a.message))}](by-file.md#${anchorId(a)})`;
            const prefix = options.sourceLinkPrefix ?? '';
            const to = `[${escapeCell(link.targetFile)}:${link.targetLine + 1}](<${prefix}${link.targetFile}#L${link.targetLine + 1}>)`;
            out.push(`| ${from} | ${escapeCell(link.relationship)} | ${to} |`);
        }
    }
    out.push('');
    return out.join('\n');
}

function renderToc(): string {
    return [
        '- name: Overview',
        '  href: index.md',
        '- name: By type',
        '  href: by-type.md',
        '- name: By file',
        '  href: by-file.md',
        '- name: Links',
        '  href: links.md',
        '',
    ].join('\n');
}

/**
 * Generate the documentation set. Returns a map of relative file name →
 * file content; the caller writes them under the configured output folder.
 * Deterministic for a given input (stable ordering, caller-supplied stamp).
 */
export function generateDocSet(annotations: DocAnnotation[], options: DocGenOptions = {}): Map<string, string> {
    const files = new Map<string, string>();
    files.set('toc.yml', renderToc());
    files.set('index.md', renderIndex(annotations, options));
    files.set('by-type.md', renderByType(annotations, options));
    files.set('by-file.md', renderByFile(annotations, options));
    files.set('links.md', renderLinks(annotations, options));
    return files;
}
