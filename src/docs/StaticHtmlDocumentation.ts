// SPDX-License-Identifier: MPL-2.0
//
// Deterministic, dependency-free HTML projection of the annotation catalogue.
// Annotation messages are deliberately rendered as text, never as trusted HTML.

import type { DocAnnotation } from './AnnotationDocGenerator';

export type HtmlDiagnosticSeverity = 'warning' | 'info';

export interface HtmlDocumentationDiagnostic {
    severity: HtmlDiagnosticSeverity;
    code: string;
    message: string;
    annotationId?: string;
    documentPath?: string;
}

export interface StaticHtmlDocumentationOptions {
    /** Site title. Default: "Annotation documentation". */
    title?: string;
    /** Valid BCP-47-like language tag. Invalid values fall back to `en`. */
    lang?: string;
    /** Optional short description shown below the title. */
    description?: string;
    /** Optional workspace-relative Markdown documents projected as safe, autonomous HTML pages. */
    technicalDocuments?: ReadonlyMap<string, string>;
}

export interface StaticHtmlDocumentationResult {
    /** Workspace-relative, traversal-free output paths and their UTF-8 contents. */
    files: ReadonlyMap<string, string>;
    diagnostics: readonly HtmlDocumentationDiagnostic[];
}

interface AnnotationPage {
    annotation: DocAnnotation;
    path: string;
}

interface TechnicalDocumentPage {
    sourcePath: string;
    content: string;
    title: string;
    path: string;
}

const CONTENT_SECURITY_POLICY =
    "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/** A single local stylesheet, shared by every generated page. */
export const STATIC_HTML_STYLES = `:root {
    color-scheme: light dark;
    --bg: #f7f8fb;
    --surface: #ffffff;
    --text: #172033;
    --muted: #566177;
    --border: #ccd3df;
    --accent: #3157d5;
    --accent-strong: #173aa8;
    --focus: #ff9f1c;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

html { background: var(--bg); color: var(--text); line-height: 1.6; }
body { margin: 0; }
a { color: var(--accent-strong); text-underline-offset: 0.18em; }
a:hover { text-decoration-thickness: 0.16em; }
a:focus-visible, [tabindex="-1"]:focus-visible {
    outline: 0.2rem solid var(--focus);
    outline-offset: 0.2rem;
}
.skip-link {
    background: var(--text);
    color: var(--surface);
    left: 1rem;
    padding: 0.65rem 0.9rem;
    position: fixed;
    top: 0;
    transform: translateY(-140%);
    z-index: 10;
}
.skip-link:focus { transform: translateY(0.5rem); }
.site-header, main, .site-footer { margin-inline: auto; max-width: 76rem; padding: 1.25rem; }
.site-header { padding-block-start: 2rem; }
.site-header nav ul, .tag-list, .annotation-list, .document-list { list-style: none; margin: 0; padding: 0; }
.site-header nav ul, .tag-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.site-header nav a[aria-current="page"] { font-weight: 700; }
.eyebrow { color: var(--accent-strong); font-size: 0.8rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.lede, .location, .site-footer { color: var(--muted); }
.summary-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); margin-block: 1.5rem; }
.summary-card, .annotation-card, .document-card, .detail-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    padding: 1rem;
}
.summary-card strong { display: block; font-size: 1.7rem; }
.annotation-list { display: grid; gap: 0.8rem; }
.document-list { display: grid; gap: 0.8rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.annotation-card h3, .document-card h3 { margin-block: 0 0.25rem; }
.tag-list li { background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.55rem; }
dl { display: grid; gap: 0.35rem 1rem; grid-template-columns: max-content 1fr; }
dt { font-weight: 700; }
dd { margin: 0; overflow-wrap: anywhere; }
pre { background: #111827; color: #f9fafb; overflow: auto; padding: 1rem; }
.technical-document { overflow-wrap: anywhere; }
.technical-document table { border-collapse: collapse; width: 100%; }
.technical-document th, .technical-document td { border: 1px solid var(--border); padding: 0.45rem 0.65rem; text-align: start; }
.table-wrap { overflow-x: auto; }
.unresolved-link { text-decoration: underline dotted; text-underline-offset: 0.18em; }
.source-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.message { overflow-wrap: anywhere; }
.back-link { display: inline-block; margin-block-end: 1rem; }

@media (prefers-color-scheme: dark) {
    :root {
        --bg: #111522;
        --surface: #1a2030;
        --text: #edf1fa;
        --muted: #b4bfd3;
        --border: #3a465c;
        --accent: #9aafff;
        --accent-strong: #bdcaff;
        --focus: #ffd166;
    }
}

@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        switch (character) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

function hashText(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function safeSlug(value: string): string {
    const slug = value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || 'annotation';
}

function firstLine(message: string): string {
    const line = message
        .replace(/\r\n/g, '\n')
        .split('\n')
        .find((candidate) => candidate.trim().length > 0);
    if (!line) {
        return 'Untitled annotation';
    }
    const trimmed = line.replace(/^#{1,6}\s+/, '').trim();
    return trimmed.length > 100 ? `${trimmed.slice(0, 99)}\u2026` : trimmed;
}

function sortedAnnotations(annotations: readonly DocAnnotation[]): DocAnnotation[] {
    return [...annotations].sort(
        (left, right) =>
            compareText(left.file, right.file) ||
            left.line - right.line ||
            compareText(left.id, right.id) ||
            compareText(left.timestamp, right.timestamp) ||
            compareText(left.message, right.message)
    );
}

function normalizeLanguage(
    requested: string | undefined,
    diagnostics: HtmlDocumentationDiagnostic[]
): { lang: string; french: boolean } {
    const candidate = requested?.trim() || 'en';
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(candidate)) {
        diagnostics.push({
            severity: 'warning',
            code: 'invalid-language',
            message: `Invalid language tag "${candidate}"; generated pages use "en".`,
        });
        return { lang: 'en', french: false };
    }
    return { lang: candidate, french: candidate.toLowerCase().startsWith('fr') };
}

function documentStart(lang: string, title: string, stylesheet: string): string {
    // The CSP intentionally precedes every fetchable resource in <head>.
    return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(CONTENT_SECURITY_POLICY)}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${stylesheet}">
</head>
<body>`;
}

function header(title: string, homeHref: string, current: boolean, french: boolean): string {
    const skip = french ? 'Aller au contenu principal' : 'Skip to main content';
    const overview = french ? 'Vue d\u2019ensemble' : 'Overview';
    const nav = french ? 'Documentation principale' : 'Primary documentation';
    return `<a class="skip-link" href="#main-content">${skip}</a>
<header class="site-header">
    <p class="eyebrow">Out-of-Code Insights</p>
    <nav aria-label="${nav}"><ul><li><a${current ? ' aria-current="page"' : ''} href="${homeHref}">${overview}</a></li></ul></nav>
    <h1>${escapeHtml(title)}</h1>
</header>`;
}

function documentEnd(french: boolean): string {
    const generated = french
        ? 'Documentation statique g\u00e9n\u00e9r\u00e9e sans script.'
        : 'Static documentation generated without scripts.';
    return `<footer class="site-footer"><p>${generated}</p></footer>
</body>
</html>
`;
}

function renderMessage(message: string): string {
    const normalized = message.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return '<p><em>No message.</em></p>';
    }
    return normalized
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

function renderTags(tags: readonly string[] | undefined): string {
    if (!tags || tags.length === 0) {
        return '';
    }
    const unique = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort(compareText);
    return `<ul class="tag-list" aria-label="Tags">${unique.map((tag) => `<li>${escapeHtml(tag)}</li>`).join('')}</ul>`;
}

function locationOf(annotation: Pick<DocAnnotation, 'file' | 'line'>): string {
    return annotation.line >= 0 ? `${annotation.file}:${annotation.line + 1}` : annotation.file;
}

function makePages(
    annotations: readonly DocAnnotation[],
    diagnostics: HtmlDocumentationDiagnostic[]
): AnnotationPage[] {
    const usedPaths = new Set<string>();
    const seenIds = new Set<string>();
    return sortedAnnotations(annotations).map((annotation) => {
        if (seenIds.has(annotation.id)) {
            diagnostics.push({
                severity: 'warning',
                code: 'duplicate-annotation-id',
                message: `Annotation id "${annotation.id}" occurs more than once; each record received a distinct page.`,
                annotationId: annotation.id,
            });
        }
        seenIds.add(annotation.id);
        const identity = `${annotation.id}\u0000${annotation.file}\u0000${annotation.line}\u0000${annotation.timestamp}`;
        const base = `annotations/${safeSlug(annotation.id)}-${hashText(identity)}`;
        let path = `${base}.html`;
        let collision = 2;
        while (usedPaths.has(path)) {
            path = `${base}-${collision}.html`;
            collision++;
        }
        usedPaths.add(path);
        return { annotation, path };
    });
}

function hasUnsafePathCharacters(value: string): boolean {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
            return true;
        }
    }
    return false;
}

function normalizeTechnicalDocumentPath(value: string): string | null {
    if (value.length === 0 || value !== value.trim() || /^[A-Za-z]:/.test(value)) {
        return null;
    }
    const slashPath = value.replace(/\\/g, '/');
    if (slashPath.startsWith('/') || slashPath.startsWith('//') || hasUnsafePathCharacters(slashPath)) {
        return null;
    }
    const segments = slashPath.split('/');
    if (
        segments.some(
            (segment) =>
                segment.length === 0 ||
                segment === '.' ||
                segment === '..' ||
                /[<>:"|?*]/.test(segment) ||
                hasUnsafePathCharacters(segment)
        )
    ) {
        return null;
    }
    const normalized = segments.join('/');
    return /\.(?:md|markdown)$/i.test(normalized) ? normalized : null;
}

function plainMarkdownText(value: string): string {
    return value
        .replace(/\[([^\]\n]+)\]\((?:<[^>\n]+>|[^)\n]+)\)/g, '$1')
        .replace(/(`+)(.*?)\1/g, '$2')
        .replace(/\\([\\`*_[\]<>#|])/g, '$1')
        .replace(/[*_~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function technicalDocumentTitle(sourcePath: string, content: string): string {
    const heading = content
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .find(({ line }) => /^ {0,3}#\s+\S/.test(line));
    if (heading) {
        const title = plainMarkdownText(heading.line.replace(/^ {0,3}#\s+/, '').replace(/\s+#+\s*$/, ''));
        if (title) {
            return title;
        }
    }
    const fileName = sourcePath.split('/').pop() ?? sourcePath;
    const stem = fileName
        .replace(/\.(?:md|markdown)$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
    return stem || 'Technical document';
}

function makeTechnicalDocumentPages(
    documents: ReadonlyMap<string, string> | undefined,
    diagnostics: HtmlDocumentationDiagnostic[]
): TechnicalDocumentPage[] {
    if (!documents) {
        return [];
    }
    const candidates = [...documents.entries()].sort(
        ([leftPath, leftContent], [rightPath, rightContent]) =>
            compareText(leftPath, rightPath) || compareText(leftContent, rightContent)
    );
    const pages: TechnicalDocumentPage[] = [];
    const usedOutputPaths = new Set<string>();
    const foldedSourcePaths = new Map<string, string>();
    for (const [requestedPath, content] of candidates) {
        const sourcePath = normalizeTechnicalDocumentPath(requestedPath);
        if (!sourcePath) {
            diagnostics.push({
                severity: 'warning',
                code: 'invalid-technical-document-path',
                message: `Technical document path "${requestedPath}" is not a safe workspace-relative Markdown path and was ignored.`,
                documentPath: requestedPath,
            });
            continue;
        }
        const foldedPath = sourcePath.toLocaleLowerCase('en-US');
        const previousPath = foldedSourcePaths.get(foldedPath);
        if (previousPath && previousPath !== sourcePath) {
            diagnostics.push({
                severity: 'warning',
                code: 'ambiguous-technical-document-path',
                message: `Technical document paths "${previousPath}" and "${sourcePath}" differ only by case; exact links remain distinct.`,
                documentPath: sourcePath,
            });
        } else {
            foldedSourcePaths.set(foldedPath, sourcePath);
        }
        const stem = sourcePath.replace(/\.(?:md|markdown)$/i, '').replace(/\//g, '-');
        const base = `documents/${safeSlug(stem)}-${hashText(sourcePath)}`;
        let path = `${base}.html`;
        let collision = 2;
        while (usedOutputPaths.has(path)) {
            path = `${base}-${collision++}.html`;
        }
        usedOutputPaths.add(path);
        pages.push({ sourcePath, content, title: technicalDocumentTitle(sourcePath, content), path });
    }
    return pages;
}

function headingSlug(value: string): string {
    const slug = plainMarkdownText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return slug || 'section';
}

function resolveDocumentSourcePath(currentPath: string, targetPath: string): string | null {
    if (
        !targetPath ||
        targetPath.startsWith('/') ||
        targetPath.startsWith('\\') ||
        targetPath.includes('\\') ||
        targetPath.includes('?') ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(targetPath) ||
        hasUnsafePathCharacters(targetPath)
    ) {
        return null;
    }
    const resolved = currentPath.split('/').slice(0, -1);
    for (const segment of targetPath.split('/')) {
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (resolved.length === 0) {
                return null;
            }
            resolved.pop();
            continue;
        }
        if (/[<>:"|?*]/.test(segment) || hasUnsafePathCharacters(segment)) {
            return null;
        }
        resolved.push(segment);
    }
    return resolved.join('/');
}

interface MarkdownRenderContext {
    page: TechnicalDocumentPage;
    exactPages: ReadonlyMap<string, TechnicalDocumentPage>;
    foldedPages: ReadonlyMap<string, readonly TechnicalDocumentPage[]>;
}

function resolveMarkdownLink(targetValue: string, context: MarkdownRenderContext): string | null {
    let target = targetValue.trim();
    if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1).trim();
    }
    if (!target || hasUnsafePathCharacters(target)) {
        return null;
    }
    const hash = target.indexOf('#');
    const pathPart = hash >= 0 ? target.slice(0, hash) : target;
    const fragmentPart = hash >= 0 ? target.slice(hash + 1) : '';
    if (target.indexOf('#', hash + 1) >= 0) {
        return null;
    }
    const fragment = fragmentPart
        ? /^[A-Za-z0-9 _-]+$/.test(fragmentPart)
            ? `#${headingSlug(fragmentPart)}`
            : null
        : '';
    if (fragment === null) {
        return null;
    }
    if (!pathPart) {
        return fragment || null;
    }
    const resolvedPath = resolveDocumentSourcePath(context.page.sourcePath, pathPart);
    if (!resolvedPath) {
        return null;
    }
    let targetPage = context.exactPages.get(resolvedPath);
    if (!targetPage) {
        const foldedMatches = context.foldedPages.get(resolvedPath.toLocaleLowerCase('en-US')) ?? [];
        if (foldedMatches.length === 1) {
            targetPage = foldedMatches[0];
        }
    }
    if (!targetPage) {
        return null;
    }
    return `${targetPage.path.slice('documents/'.length)}${fragment}`;
}

function escapeMarkdownText(value: string): string {
    return escapeHtml(value.replace(/\\([\\`*_[\]<>#|])/g, '$1'));
}

function renderMarkdownInline(value: string, context: MarkdownRenderContext): string {
    const pattern = /(`+)([^`\n]*?)\1|\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g;
    let output = '';
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
        const index = match.index ?? 0;
        output += escapeMarkdownText(value.slice(offset, index));
        if (match[1] !== undefined) {
            output += `<code>${escapeHtml(match[2])}</code>`;
        } else {
            const label = escapeMarkdownText(match[3]);
            const href = resolveMarkdownLink(match[4], context);
            output += href
                ? `<a href="${escapeHtml(href)}">${label}</a>`
                : `<span class="unresolved-link">${label}</span>`;
        }
        offset = index + match[0].length;
    }
    return output + escapeMarkdownText(value.slice(offset));
}

function splitTableRow(value: string): string[] {
    const trimmed = value.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells: string[] = [];
    let cell = '';
    let escaped = false;
    for (const character of trimmed) {
        if (character === '|' && !escaped) {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += character;
        }
        escaped = character === '\\' && !escaped;
        if (character !== '\\') {
            escaped = false;
        }
    }
    cells.push(cell.trim());
    return cells;
}

function isTableSeparator(value: string): boolean {
    const cells = splitTableRow(value);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownDocument(
    page: TechnicalDocumentPage,
    exactPages: ReadonlyMap<string, TechnicalDocumentPage>,
    foldedPages: ReadonlyMap<string, readonly TechnicalDocumentPage[]>,
    diagnostics: HtmlDocumentationDiagnostic[]
): string {
    const context: MarkdownRenderContext = { page, exactPages, foldedPages };
    const lines = page.content.replace(/\r\n?/g, '\n').split('\n');
    const output: string[] = [];
    const usedHeadingIds = new Map<string, number>([[headingSlug(page.title), 1]]);
    let skippedTitle = false;
    let paragraph: string[] = [];
    let listType: 'ol' | 'ul' | null = null;
    let listItems: string[] = [];
    let quoteLines: string[] = [];

    const flushParagraph = (): void => {
        if (paragraph.length > 0) {
            output.push(`<p>${renderMarkdownInline(paragraph.join(' '), context)}</p>`);
            paragraph = [];
        }
    };
    const flushList = (): void => {
        if (listType && listItems.length > 0) {
            output.push(
                `<${listType}>${listItems.map((item) => `<li>${renderMarkdownInline(item, context)}</li>`).join('')}</${listType}>`
            );
        }
        listType = null;
        listItems = [];
    };
    const flushQuote = (): void => {
        if (quoteLines.length > 0) {
            output.push(
                `<blockquote><p>${quoteLines.map((line) => renderMarkdownInline(line, context)).join('<br>')}</p></blockquote>`
            );
            quoteLines = [];
        }
    };
    const flushBlocks = (): void => {
        flushParagraph();
        flushList();
        flushQuote();
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fence = /^ {0,3}(`{3,}|~{3,})([^\s`]*)\s*$/.exec(line);
        if (fence) {
            flushBlocks();
            const marker = fence[1][0];
            const minimumLength = fence[1].length;
            const code: string[] = [];
            let closed = false;
            for (index++; index < lines.length; index++) {
                const closingFence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
                if (closingFence && closingFence[1][0] === marker && closingFence[1].length >= minimumLength) {
                    closed = true;
                    break;
                }
                code.push(lines[index]);
            }
            if (!closed) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'unterminated-technical-document-code-fence',
                    message: `Technical document "${page.sourcePath}" contains an unterminated code fence; its remaining text was escaped as code.`,
                    documentPath: page.sourcePath,
                });
            }
            const language = /^[A-Za-z0-9_-]+$/.test(fence[2]) ? ` class="language-${fence[2]}"` : '';
            output.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }

        const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) {
            flushBlocks();
            if (!skippedTitle && heading[1].length === 1) {
                skippedTitle = true;
                continue;
            }
            const baseId = headingSlug(heading[2]);
            const occurrence = (usedHeadingIds.get(baseId) ?? 0) + 1;
            usedHeadingIds.set(baseId, occurrence);
            const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
            const level = Math.min(6, heading[1].length + 1);
            output.push(`<h${level} id="${id}">${renderMarkdownInline(heading[2], context)}</h${level}>`);
            continue;
        }

        if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
            flushBlocks();
            const headers = splitTableRow(line);
            const rows: string[][] = [];
            index += 2;
            while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
                rows.push(splitTableRow(lines[index]));
                index++;
            }
            index--;
            const headerHtml = headers
                .map((cell) => `<th scope="col">${renderMarkdownInline(cell, context)}</th>`)
                .join('');
            const bodyHtml = rows
                .map(
                    (row) =>
                        `<tr>${headers.map((_, cellIndex) => `<td>${renderMarkdownInline(row[cellIndex] ?? '', context)}</td>`).join('')}</tr>`
                )
                .join('');
            output.push(
                `<div class="table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`
            );
            continue;
        }

        const unorderedItem = /^\s*[-+*]\s+(.+)$/.exec(line);
        const orderedItem = /^\s*\d+[.)]\s+(.+)$/.exec(line);
        if (unorderedItem || orderedItem) {
            flushParagraph();
            flushQuote();
            const nextType = unorderedItem ? 'ul' : 'ol';
            if (listType && listType !== nextType) {
                flushList();
            }
            listType = nextType;
            listItems.push((unorderedItem ?? orderedItem)?.[1] ?? '');
            continue;
        }

        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            flushParagraph();
            flushList();
            quoteLines.push(quote[1]);
            continue;
        }

        if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
            flushBlocks();
            output.push('<hr>');
            continue;
        }
        if (!line.trim()) {
            flushBlocks();
            continue;
        }
        flushList();
        flushQuote();
        paragraph.push(line.trim());
    }
    flushBlocks();
    return output.join('\n');
}

function renderIndex(
    pages: readonly AnnotationPage[],
    technicalPages: readonly TechnicalDocumentPage[],
    options: { title: string; description?: string; lang: string; french: boolean }
): string {
    const fileCount = new Set(pages.map((page) => page.annotation.file)).size;
    const resolvedCount = pages.filter((page) => page.annotation.resolved).length;
    const cards = pages
        .map(({ annotation, path }) => {
            const status = annotation.resolved ? (options.french ? 'R\u00e9solue' : 'Resolved') : annotation.state;
            return `<li class="annotation-card">
    <h3><a href="${path}">${escapeHtml(firstLine(annotation.message))}</a></h3>
    <p class="location">${escapeHtml(locationOf(annotation))}</p>
    <p>${escapeHtml(status)}</p>
    ${renderTags(annotation.tags)}
</li>`;
        })
        .join('\n');
    const documentCards = technicalPages
        .map(
            (page) => `<li class="document-card">
    <h3><a href="${page.path}">${escapeHtml(page.title)}</a></h3>
    <p class="location source-path">${escapeHtml(page.sourcePath)}</p>
</li>`
        )
        .join('\n');
    const description = options.description?.trim()
        ? `<p class="lede">${escapeHtml(options.description.trim())}</p>`
        : '';
    const labels = options.french
        ? {
              annotations: 'Annotations',
              documents: 'Documents techniques',
              files: 'Fichiers',
              resolved: 'R\u00e9solues',
              catalogue: 'Catalogue',
          }
        : {
              annotations: 'Annotations',
              documents: 'Technical documents',
              files: 'Files',
              resolved: 'Resolved',
              catalogue: 'Catalogue',
          };
    return `${documentStart(options.lang, options.title, 'styles.css')}
${header(options.title, 'index.html', true, options.french)}
<main id="main-content" tabindex="-1">
    ${description}
    <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">${labels.catalogue}</h2>
        <div class="summary-grid">
            <div class="summary-card"><strong>${pages.length}</strong><span>${labels.annotations}</span></div>
            <div class="summary-card"><strong>${fileCount}</strong><span>${labels.files}</span></div>
            <div class="summary-card"><strong>${resolvedCount}</strong><span>${labels.resolved}</span></div>
            <div class="summary-card"><strong>${technicalPages.length}</strong><span>${labels.documents}</span></div>
        </div>
    </section>
    ${
        documentCards
            ? `<section aria-labelledby="documents-heading">
        <h2 id="documents-heading">${labels.documents}</h2>
        <ol class="document-list">${documentCards}</ol>
    </section>`
            : ''
    }
    <section aria-labelledby="annotations-heading">
        <h2 id="annotations-heading">${labels.annotations}</h2>
        ${cards ? `<ol class="annotation-list">${cards}</ol>` : '<p><em>No annotations.</em></p>'}
    </section>
</main>
${documentEnd(options.french)}`;
}

function renderTechnicalDocumentPage(
    page: TechnicalDocumentPage,
    exactPages: ReadonlyMap<string, TechnicalDocumentPage>,
    foldedPages: ReadonlyMap<string, readonly TechnicalDocumentPage[]>,
    options: { siteTitle: string; lang: string; french: boolean },
    diagnostics: HtmlDocumentationDiagnostic[]
): string {
    const title = `${page.title} \u2014 ${options.siteTitle}`;
    const content = renderMarkdownDocument(page, exactPages, foldedPages, diagnostics);
    return `${documentStart(options.lang, title, '../styles.css')}
${header(options.siteTitle, '../index.html', false, options.french)}
<main id="main-content" tabindex="-1">
    <a class="back-link" href="../index.html">\u2190 ${options.french ? 'Retour au catalogue' : 'Back to catalogue'}</a>
    <article class="technical-document">
        <p class="eyebrow">${options.french ? 'Document technique' : 'Technical document'}</p>
        <h2 id="${headingSlug(page.title)}">${escapeHtml(page.title)}</h2>
        <p class="location source-path">${escapeHtml(page.sourcePath)}</p>
        ${content || `<p><em>${options.french ? 'Aucun contenu.' : 'No content.'}</em></p>`}
    </article>
</main>
${documentEnd(options.french)}`;
}

function renderAnnotationPage(
    page: AnnotationPage,
    pagesByLocation: ReadonlyMap<string, readonly AnnotationPage[]>,
    options: { siteTitle: string; lang: string; french: boolean },
    diagnostics: HtmlDocumentationDiagnostic[]
): string {
    const annotation = page.annotation;
    const pageTitle = `${firstLine(annotation.message)} \u2014 ${options.siteTitle}`;
    const facts: Array<[string, string]> = [
        ['ID', annotation.id],
        [options.french ? 'Emplacement' : 'Location', locationOf(annotation)],
        [options.french ? '\u00c9tat' : 'State', annotation.resolved ? 'resolved' : annotation.state],
        [options.french ? 'Horodatage' : 'Timestamp', annotation.timestamp],
    ];
    if (annotation.author) {
        facts.push([options.french ? 'Auteur' : 'Author', annotation.author]);
    }
    if (annotation.severity) {
        facts.push([options.french ? 'S\u00e9v\u00e9rit\u00e9' : 'Severity', annotation.severity]);
    }
    const detailList = facts
        .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
        .join('\n');
    const snippet = annotation.snippet
        ? `<section aria-labelledby="snippet-heading"><h2 id="snippet-heading">Snippet</h2><pre><code>${escapeHtml(annotation.snippet.code)}</code></pre></section>`
        : '';
    const discussion = annotation.thread?.length
        ? `<section aria-labelledby="discussion-heading"><h2 id="discussion-heading">${options.french ? 'Discussion' : 'Discussion'}</h2><ol>${annotation.thread
              .map(
                  (comment) =>
                      `<li><p><strong>${escapeHtml(comment.author || 'Anonymous')}</strong> \u2014 <time>${escapeHtml(comment.timestamp)}</time></p>${renderMessage(comment.message)}</li>`
              )
              .join('')}</ol></section>`
        : '';
    const links = (annotation.linkedAnnotations ?? [])
        .map((link) => {
            const key = `${link.targetFile}\u0000${link.targetLine}`;
            const targets = pagesByLocation.get(key) ?? [];
            const label = `${link.relationship}: ${locationOf({ file: link.targetFile, line: link.targetLine })}`;
            if (targets.length === 1) {
                return `<li><a href="../${targets[0].path}">${escapeHtml(label)}</a></li>`;
            }
            diagnostics.push({
                severity: 'warning',
                code: targets.length === 0 ? 'unresolved-related-annotation' : 'ambiguous-related-annotation',
                message: `${targets.length === 0 ? 'No' : 'Multiple'} annotation page(s) match ${locationOf({ file: link.targetFile, line: link.targetLine })}.`,
                annotationId: annotation.id,
            });
            return `<li>${escapeHtml(label)}</li>`;
        })
        .join('');
    const related = links
        ? `<section aria-labelledby="links-heading"><h2 id="links-heading">${options.french ? 'Liens' : 'Links'}</h2><ul>${links}</ul></section>`
        : '';
    return `${documentStart(options.lang, pageTitle, '../styles.css')}
${header(options.siteTitle, '../index.html', false, options.french)}
<main id="main-content" tabindex="-1">
    <a class="back-link" href="../index.html">\u2190 ${options.french ? 'Retour au catalogue' : 'Back to catalogue'}</a>
    <article>
        <h2>${escapeHtml(firstLine(annotation.message))}</h2>
        <div class="detail-card">
            <dl>${detailList}</dl>
            ${renderTags(annotation.tags)}
        </div>
        <section aria-labelledby="message-heading"><h2 id="message-heading">Message</h2><div class="message">${renderMessage(annotation.message)}</div></section>
        ${snippet}
        ${discussion}
        ${related}
    </article>
</main>
${documentEnd(options.french)}`;
}

/**
 * Generate an autonomous static site. It emits no JavaScript, remote URL,
 * inline style, raw Markdown HTML, or unescaped authored markup.
 */
export function generateStaticHtmlDocumentation(
    annotations: readonly DocAnnotation[],
    options: StaticHtmlDocumentationOptions = {}
): StaticHtmlDocumentationResult {
    const diagnostics: HtmlDocumentationDiagnostic[] = [];
    const language = normalizeLanguage(options.lang, diagnostics);
    const title = options.title?.trim() || 'Annotation documentation';
    const pages = makePages(annotations, diagnostics);
    const technicalPages = makeTechnicalDocumentPages(options.technicalDocuments, diagnostics);
    const pagesByLocation = new Map<string, AnnotationPage[]>();
    for (const page of pages) {
        const key = `${page.annotation.file}\u0000${page.annotation.line}`;
        const bucket = pagesByLocation.get(key);
        if (bucket) {
            bucket.push(page);
        } else {
            pagesByLocation.set(key, [page]);
        }
    }
    const exactTechnicalPages = new Map<string, TechnicalDocumentPage>();
    const foldedTechnicalPages = new Map<string, TechnicalDocumentPage[]>();
    for (const page of technicalPages) {
        exactTechnicalPages.set(page.sourcePath, page);
        const foldedPath = page.sourcePath.toLocaleLowerCase('en-US');
        const bucket = foldedTechnicalPages.get(foldedPath);
        if (bucket) {
            bucket.push(page);
        } else {
            foldedTechnicalPages.set(foldedPath, [page]);
        }
    }
    const files = new Map<string, string>();
    files.set(
        'index.html',
        renderIndex(pages, technicalPages, { ...language, title, description: options.description })
    );
    files.set('styles.css', STATIC_HTML_STYLES);
    for (const page of pages) {
        files.set(
            page.path,
            renderAnnotationPage(page, pagesByLocation, { ...language, siteTitle: title }, diagnostics)
        );
    }
    for (const page of technicalPages) {
        files.set(
            page.path,
            renderTechnicalDocumentPage(
                page,
                exactTechnicalPages,
                foldedTechnicalPages,
                { ...language, siteTitle: title },
                diagnostics
            )
        );
    }
    diagnostics.sort(
        (left, right) =>
            compareText(left.code, right.code) ||
            compareText(left.annotationId ?? '', right.annotationId ?? '') ||
            compareText(left.documentPath ?? '', right.documentPath ?? '') ||
            compareText(left.message, right.message)
    );
    return { files, diagnostics };
}
