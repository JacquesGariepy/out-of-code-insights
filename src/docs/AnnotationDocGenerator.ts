// SPDX-License-Identifier: MPL-2.0
//
// Pure documentation generator: projects the annotation set into a
// DocFX-compatible Markdown site. No vscode runtime dependency — the command
// layer resolves display lines / anchored source text and writes the
// returned files to disk.
//
// Two layers of output:
//
//  1. INVENTORY (always): index.md, by-type.md, by-file.md, links.md —
//     every annotation, grouped and cross-linked.
//
//  2. AUTHORED DOCUMENTATION (when `doc:*` tags are present): one API page
//     per source file under api/, plus guide.md. The tag taxonomy drives the
//     structure:
//       - doc:module    file-level header; its message opens the API page
//       - doc:class     class section (##); owns the members that follow it
//       - doc:function  function/method entry (doc:method is an alias);
//                       nested under the nearest preceding doc:class in the
//                       same file, top-level otherwise
//       - doc:example   example block; attaches to the nearest preceding
//                       class/function entry, or to the module
//       - doc:guide     free-standing guide content assembled into guide.md
//
//     Annotation messages are full Markdown. Headings inside a message are
//     demoted so they nest under their section (fenced code blocks are left
//     untouched). `[[Title]]` wiki-links resolve to the documentation entry
//     whose title matches (case-insensitive); unresolved links are reported
//     in the generation warnings on index.md.

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
    /** Text of the anchored source line (signature extraction). */
    anchorText?: string;
    /** Language id of the source document (signature fencing). */
    language?: string;
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

export type DocRole = 'module' | 'class' | 'function' | 'example' | 'guide';

const UNTAGGED = 'untagged';
const ROLE_PATTERN = /^doc:(module|class|function|method|example|guide)$/i;

/** Extract the documentation role from the `doc:*` tag, if any. */
export function docRoleOf(a: Pick<DocAnnotation, 'tags'>): DocRole | null {
    for (const tag of a.tags ?? []) {
        const m = ROLE_PATTERN.exec(tag.trim());
        if (m) {
            const role = m[1].toLowerCase();
            return role === 'method' ? 'function' : (role as DocRole);
        }
    }
    return null;
}

/** Escape characters that break Markdown table cells. */
function escapeCell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** One-line summary of an annotation message (first line, capped). */
function summarize(message: string, max = 80): string {
    const first = message.split('\n')[0].trim();
    return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

/**
 * Title + body split. A leading Markdown heading becomes the title (and is
 * stripped from the body); otherwise the first non-empty line is the title
 * and the remaining lines form the body.
 */
export function extractTitle(message: string): { title: string; body: string } {
    const lines = message.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim().length === 0) {
        i++;
    }
    if (i >= lines.length) {
        return { title: '', body: '' };
    }
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(lines[i].trim());
    const title = headingMatch ? headingMatch[1].trim() : summarize(lines[i]);
    const body = lines
        .slice(i + 1)
        .join('\n')
        .trim();
    return { title, body };
}

/**
 * Demote Markdown headings by `delta` levels (capped at h6) so authored
 * content nests under its generated section. Lines inside fenced code
 * blocks are left untouched.
 */
export function demoteHeadings(content: string, delta: number): string {
    if (delta <= 0) {
        return content;
    }
    let inFence = false;
    return content
        .split('\n')
        .map((line) => {
            if (/^\s*(```|~~~)/.test(line)) {
                inFence = !inFence;
                return line;
            }
            if (inFence) {
                return line;
            }
            const m = /^(#{1,6})(\s+.*)$/.exec(line);
            if (!m) {
                return line;
            }
            const level = Math.min(6, m[1].length + delta);
            return '#'.repeat(level) + m[2];
        })
        .join('\n');
}

/** Markdown link from a docs page to a source location. */
function sourceLink(a: DocAnnotation, prefix: string): string {
    const lineSuffix = a.line >= 0 ? `#L${a.line + 1}` : '';
    const display = a.line >= 0 ? `${a.file}:${a.line + 1}` : a.file;
    return `[${escapeCell(display)}](<${prefix}${a.file}${lineSuffix}>)`;
}

/** Anchor id used to deep-link an annotation inside the generated pages. */
function anchorId(a: Pick<DocAnnotation, 'id'>): string {
    return `ann-${a.id}`;
}

/** URL-safe page slug for a workspace-relative file path. */
export function fileSlug(file: string): string {
    return file.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
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

// ───────────────────────────────────────────────────────────────────────────
// Wiki-links
// ───────────────────────────────────────────────────────────────────────────

interface WikiTarget {
    page: string;
    anchor: string;
}

/**
 * Path from `fromPage` to `toPage` for the flat root + api/ subfolder layout.
 */
function relativePage(fromPage: string, toPage: string): string {
    const fromInApi = fromPage.startsWith('api/');
    const toInApi = toPage.startsWith('api/');
    if (fromInApi && toInApi) {
        return toPage.slice('api/'.length);
    }
    if (fromInApi && !toInApi) {
        return '../' + toPage;
    }
    return toPage;
}

/**
 * Resolve `[[Title]]` wiki-links against the documentation entries. Targets
 * are matched case-insensitively on the entry title. Unresolved links stay
 * verbatim and are appended to `warnings`. Fenced code blocks are skipped.
 */
export function resolveWikiLinks(
    content: string,
    currentPage: string,
    targets: Map<string, WikiTarget>,
    warnings: string[]
): string {
    let inFence = false;
    return content
        .split('\n')
        .map((line) => {
            if (/^\s*(```|~~~)/.test(line)) {
                inFence = !inFence;
                return line;
            }
            if (inFence) {
                return line;
            }
            return line.replace(/\[\[([^[\]\n]+)\]\]/g, (whole, rawTitle: string) => {
                const target = targets.get(rawTitle.trim().toLowerCase());
                if (!target) {
                    warnings.push(`Unresolved wiki-link [[${rawTitle.trim()}]] on page ${currentPage}`);
                    return whole;
                }
                return `[${rawTitle.trim()}](${relativePage(currentPage, target.page)}#${target.anchor})`;
            });
        })
        .join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Authored documentation model (doc:* annotations)
// ───────────────────────────────────────────────────────────────────────────

interface DocEntry {
    annotation: DocAnnotation;
    role: DocRole;
    title: string;
    body: string;
    examples: DocEntry[];
    members: DocEntry[];
}

interface ApiPageModel {
    file: string;
    page: string;
    module: DocEntry | null;
    classes: DocEntry[];
    functions: DocEntry[];
    orphanExamples: DocEntry[];
}

function toEntry(a: DocAnnotation, role: DocRole): DocEntry {
    const { title, body } = extractTitle(a.message);
    return {
        annotation: a,
        role,
        title: title || summarize(a.message) || a.id,
        body,
        examples: [],
        members: [],
    };
}

/** Build the per-file API model from doc-tagged annotations. */
export function buildApiModel(
    annotations: DocAnnotation[],
    warnings: string[]
): { pages: ApiPageModel[]; guides: DocEntry[] } {
    const docAnnotations = sortedAnnotations(annotations).filter((a) => docRoleOf(a) !== null);
    const guides: DocEntry[] = [];
    const pages: ApiPageModel[] = [];
    const byFile = groupBy(
        docAnnotations.filter((a) => docRoleOf(a) !== 'guide'),
        (a) => a.file
    );

    for (const a of docAnnotations) {
        if (docRoleOf(a) === 'guide') {
            guides.push(toEntry(a, 'guide'));
        }
    }

    for (const [file, anns] of byFile) {
        const model: ApiPageModel = {
            file,
            page: `api/${fileSlug(file)}.md`,
            module: null,
            classes: [],
            functions: [],
            orphanExamples: [],
        };
        let lastEntity: DocEntry | null = null;
        let currentClass: DocEntry | null = null;
        for (const a of anns) {
            const role = docRoleOf(a) as DocRole;
            if (role === 'module') {
                if (model.module === null) {
                    model.module = toEntry(a, 'module');
                } else {
                    warnings.push(`Extra doc:module annotation ignored in ${file} (line ${a.line + 1})`);
                }
                continue;
            }
            if (role === 'class') {
                const entry = toEntry(a, 'class');
                model.classes.push(entry);
                currentClass = entry;
                lastEntity = entry;
                continue;
            }
            if (role === 'function') {
                const entry = toEntry(a, 'function');
                if (currentClass && a.line >= currentClass.annotation.line) {
                    currentClass.members.push(entry);
                } else {
                    model.functions.push(entry);
                }
                lastEntity = entry;
                continue;
            }
            // role === 'example'
            const entry = toEntry(a, 'example');
            if (lastEntity) {
                lastEntity.examples.push(entry);
            } else if (model.module) {
                model.module.examples.push(entry);
            } else {
                model.orphanExamples.push(entry);
                warnings.push(`doc:example without a preceding documented entity in ${file} (line ${a.line + 1})`);
            }
        }
        pages.push(model);
    }
    return { pages, guides };
}

/** Wiki-link target registry: entry title (lower-cased) → page + anchor. */
function collectWikiTargets(pages: ApiPageModel[], guides: DocEntry[], warnings: string[]): Map<string, WikiTarget> {
    const targets = new Map<string, WikiTarget>();
    const register = (entry: DocEntry, page: string): void => {
        const key = entry.title.toLowerCase();
        if (!key) {
            return;
        }
        if (targets.has(key)) {
            warnings.push(`Duplicate documentation title "${entry.title}" — wiki-links resolve to the first one`);
            return;
        }
        targets.set(key, { page, anchor: anchorId(entry.annotation) });
    };
    for (const model of pages) {
        if (model.module) {
            register(model.module, model.page);
            model.module.examples.forEach((e) => register(e, model.page));
        }
        for (const cls of model.classes) {
            register(cls, model.page);
            cls.examples.forEach((e) => register(e, model.page));
            for (const member of cls.members) {
                register(member, model.page);
                member.examples.forEach((e) => register(e, model.page));
            }
        }
        for (const fn of model.functions) {
            register(fn, model.page);
            fn.examples.forEach((e) => register(e, model.page));
        }
        model.orphanExamples.forEach((e) => register(e, model.page));
    }
    for (const guide of guides) {
        register(guide, 'guide.md');
    }
    return targets;
}

// ───────────────────────────────────────────────────────────────────────────
// Authored documentation rendering
// ───────────────────────────────────────────────────────────────────────────

interface RenderContext {
    options: DocGenOptions;
    targets: Map<string, WikiTarget>;
    warnings: string[];
}

/** Fenced signature block from the anchored source line. */
function signatureBlock(a: DocAnnotation): string[] {
    const text = (a.anchorText ?? '').trim();
    if (text.length === 0) {
        return [];
    }
    return ['```' + (a.language ?? ''), text, '```', ''];
}

function renderBody(entry: DocEntry, page: string, delta: number, ctx: RenderContext): string[] {
    if (entry.body.length === 0) {
        return [];
    }
    const demoted = demoteHeadings(entry.body, delta);
    return [resolveWikiLinks(demoted, page, ctx.targets, ctx.warnings), ''];
}

function renderExample(example: DocEntry, page: string, level: number, ctx: RenderContext): string[] {
    const out: string[] = [];
    const prefix = ctx.options.sourceLinkPrefix ?? '';
    out.push(`<a id="${anchorId(example.annotation)}"></a>`);
    out.push('');
    out.push(`${'#'.repeat(level)} Example — ${example.title}`);
    out.push('');
    out.push(`*Source*: ${sourceLink(example.annotation, '../' + prefix)}`);
    out.push('');
    out.push(...renderBody(example, page, level, ctx));
    const snippet = example.annotation.snippet;
    if (snippet && snippet.code.trim().length > 0) {
        out.push('```' + (snippet.language || ''));
        out.push(snippet.code.replace(/\r\n/g, '\n').trimEnd());
        out.push('```');
        out.push('');
    }
    return out;
}

function renderEntity(entry: DocEntry, page: string, level: number, ctx: RenderContext): string[] {
    const out: string[] = [];
    const prefix = ctx.options.sourceLinkPrefix ?? '';
    out.push(`<a id="${anchorId(entry.annotation)}"></a>`);
    out.push('');
    out.push(`${'#'.repeat(level)} ${entry.title}`);
    out.push('');
    out.push(`*Source*: ${sourceLink(entry.annotation, '../' + prefix)}`);
    out.push('');
    out.push(...signatureBlock(entry.annotation));
    out.push(...renderBody(entry, page, level, ctx));
    for (const example of entry.examples) {
        out.push(...renderExample(example, page, Math.min(6, level + 1), ctx));
    }
    for (const member of entry.members) {
        out.push(...renderEntity(member, page, Math.min(6, level + 1), ctx));
    }
    return out;
}

function renderApiPage(model: ApiPageModel, ctx: RenderContext): string {
    const title = model.module ? model.module.title : model.file;
    const out: string[] = [pageHeader(title, ctx.options.generatedAt)];
    out.push(`*File*: \`${model.file}\``);
    out.push('');
    if (model.module) {
        out.push(...renderBody(model.module, model.page, 1, ctx));
        for (const example of model.module.examples) {
            out.push(...renderExample(example, model.page, 2, ctx));
        }
    }
    for (const cls of model.classes) {
        out.push(...renderEntity(cls, model.page, 2, ctx));
    }
    if (model.functions.length > 0) {
        out.push('## Functions');
        out.push('');
        for (const fn of model.functions) {
            out.push(...renderEntity(fn, model.page, 3, ctx));
        }
    }
    if (model.orphanExamples.length > 0) {
        out.push('## Examples');
        out.push('');
        for (const example of model.orphanExamples) {
            out.push(...renderExample(example, model.page, 3, ctx));
        }
    }
    return out.join('\n');
}

function renderGuidePage(guides: DocEntry[], ctx: RenderContext): string {
    const out: string[] = [pageHeader('Guide', ctx.options.generatedAt)];
    for (const guide of guides) {
        out.push(`<a id="${anchorId(guide.annotation)}"></a>`);
        out.push('');
        out.push(`## ${guide.title}`);
        out.push('');
        out.push(...renderBody(guide, 'guide.md', 2, ctx));
    }
    return out.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Inventory rendering (always generated)
// ───────────────────────────────────────────────────────────────────────────

function renderIndex(
    annotations: DocAnnotation[],
    options: DocGenOptions,
    pages: ApiPageModel[],
    guides: DocEntry[],
    warnings: string[]
): string {
    const title = options.title ?? 'Annotations';
    const out: string[] = [pageHeader(title, options.generatedAt)];

    const total = annotations.length;
    const resolved = annotations.filter((a) => a.resolved).length;
    const suspended = annotations.filter((a) => a.state === 'suspended').length;
    out.push(`**${total}** annotation(s) — ${resolved} resolved, ${suspended} awaiting paste-back.`);
    out.push('');

    if (pages.length > 0 || guides.length > 0) {
        out.push('## Documentation');
        out.push('');
        for (const model of pages) {
            const label = model.module ? model.module.title : model.file;
            out.push(`- [${escapeCell(label)}](${model.page})`);
        }
        if (guides.length > 0) {
            out.push('- [Guide](guide.md)');
        }
        out.push('');
    } else {
        out.push(
            '> Tip: tag annotations with `doc:module`, `doc:class`, `doc:function`, ' +
                '`doc:example` or `doc:guide` to assemble authored documentation pages here.'
        );
        out.push('');
    }

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

    if (warnings.length > 0) {
        out.push('## Generation warnings');
        out.push('');
        for (const w of [...warnings].sort()) {
            out.push(`- ${escapeCell(w)}`);
        }
        out.push('');
    }
    return out.join('\n');
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

function renderToc(pages: ApiPageModel[], guides: DocEntry[]): string {
    const out: string[] = ['- name: Overview', '  href: index.md'];
    if (pages.length > 0) {
        out.push('- name: API');
        out.push('  items:');
        for (const model of pages) {
            const label = model.module ? model.module.title : model.file;
            out.push(`      - name: ${label}`);
            out.push(`        href: ${model.page}`);
        }
    }
    if (guides.length > 0) {
        out.push('- name: Guide');
        out.push('  href: guide.md');
    }
    out.push('- name: By type');
    out.push('  href: by-type.md');
    out.push('- name: By file');
    out.push('  href: by-file.md');
    out.push('- name: Links');
    out.push('  href: links.md');
    out.push('');
    return out.join('\n');
}

/**
 * Generate the documentation set. Returns a map of relative file name →
 * file content; the caller writes them under the configured output folder.
 * Deterministic for a given input (stable ordering, caller-supplied stamp).
 */
export function generateDocSet(annotations: DocAnnotation[], options: DocGenOptions = {}): Map<string, string> {
    const warnings: string[] = [];
    const { pages, guides } = buildApiModel(annotations, warnings);
    const targets = collectWikiTargets(pages, guides, warnings);
    const ctx: RenderContext = { options, targets, warnings };

    const files = new Map<string, string>();
    for (const model of pages) {
        files.set(model.page, renderApiPage(model, ctx));
    }
    if (guides.length > 0) {
        files.set('guide.md', renderGuidePage(guides, ctx));
    }
    files.set('toc.yml', renderToc(pages, guides));
    // index LAST: it reports the warnings accumulated by every other page.
    files.set('by-type.md', renderByType(annotations, options));
    files.set('by-file.md', renderByFile(annotations, options));
    files.set('links.md', renderLinks(annotations, options));
    files.set('index.md', renderIndex(annotations, options, pages, guides, warnings));
    return files;
}
