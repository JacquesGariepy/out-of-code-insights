// SPDX-License-Identifier: MPL-2.0
//
// Pure adapters that package the Markdown map emitted by
// AnnotationDocGenerator for portable static sites and common wiki hosts. This
// module has no VS Code or file-system dependency: callers decide how and
// where to write the returned files.

export type DocumentationBundleSeverity = 'info' | 'warning' | 'error';

export interface DocumentationBundleDiagnostic {
    code: string;
    severity: DocumentationBundleSeverity;
    message: string;
    file?: string;
}

export interface DocumentationBundle {
    /** Deterministically ordered, workspace-relative output files. */
    files: ReadonlyMap<string, string>;
    diagnostics: readonly DocumentationBundleDiagnostic[];
}

export interface StaticSiteBundleOptions {
    /** Product/site title exposed in the portable configuration. */
    title?: string;
    /** BCP 47-ish UI language. Default: "en". */
    language?: string;
    /** Prefix for generated stable page identifiers. Default: "ooci". */
    pageIdPrefix?: string;
    /** Static build output directory. Default: "_site". */
    outputDirectory?: string;
    /** Optional workspace-relative theme directories. */
    themePaths?: readonly string[];
}

export type WikiFlavor = 'generic' | 'github' | 'azure';

export interface WikiBundleOptions {
    flavor?: WikiFlavor;
    title?: string;
    /** Plain-text footer used by the GitHub adapter. */
    footer?: string;
    /** Workspace-relative files that source links are allowed to target. */
    sourceFiles?: readonly string[];
    /** Segments from the documentation bundle root to the workspace root. */
    sourceRootDepth?: number;
    /** Segments added in front of this wiki bundle by its caller. */
    outputPathPrefixDepth?: number;
}

interface NormalizedInput {
    files: Map<string, string>;
    diagnostics: DocumentationBundleDiagnostic[];
}

interface TocEntry {
    name: string;
    href?: string;
    level: number;
}

const DEFAULT_TITLE = 'Out-of-Code Insights annotations';
const SAFE_CROSS_PLATFORM_SEGMENT = /^[^<>:"|?*]+$/;
const STATIC_SITE_CONFIG = 'site.config.json';
const STATIC_SITE_MANIFEST = 'site.manifest.json';
const STATIC_SITE_NAVIGATION = 'site.navigation.json';
const LEGACY_STATIC_CONFIG = 'docfx.json';

function hasControlCharacters(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
    });
}

function diagnostic(
    diagnostics: DocumentationBundleDiagnostic[],
    code: string,
    severity: DocumentationBundleSeverity,
    message: string,
    file?: string
): void {
    diagnostics.push({ code, severity, message, ...(file ? { file } : {}) });
}

/**
 * Normalize an output path without allowing absolute paths, traversal or
 * Windows-reserved characters. Returning null means the entry must not be
 * written by a caller.
 */
function safeRelativePath(rawPath: string): string | null {
    if (rawPath.length === 0 || rawPath !== rawPath.trim() || /^[A-Za-z]:/.test(rawPath)) {
        return null;
    }
    const slashPath = rawPath.replace(/\\/g, '/');
    if (slashPath.startsWith('/') || slashPath.startsWith('//')) {
        return null;
    }
    const parts: string[] = [];
    for (const part of slashPath.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..' || hasControlCharacters(part) || !SAFE_CROSS_PLATFORM_SEGMENT.test(part)) {
            return null;
        }
        parts.push(part);
    }
    return parts.length > 0 ? parts.join('/') : null;
}

function normalizeInput(source: ReadonlyMap<string, string>): NormalizedInput {
    const diagnostics: DocumentationBundleDiagnostic[] = [];
    const files = new Map<string, string>();
    const caseInsensitivePaths = new Map<string, string>();
    for (const [rawPath, rawContent] of [...source.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const path = safeRelativePath(rawPath);
        if (!path) {
            diagnostic(
                diagnostics,
                'unsafe-path',
                'error',
                `Ignored unsafe documentation path: ${JSON.stringify(rawPath)}`,
                rawPath
            );
            continue;
        }
        const existingPath = caseInsensitivePaths.get(path.toLowerCase());
        if (existingPath) {
            diagnostic(
                diagnostics,
                'duplicate-path',
                'error',
                `Multiple input files collide as ${existingPath}; the first file was kept.`,
                path
            );
            continue;
        }
        files.set(path, rawContent.replace(/\r\n?/g, '\n'));
        caseInsensitivePaths.set(path.toLowerCase(), path);
    }
    return { files, diagnostics };
}

function sortedMap(entries: Iterable<readonly [string, string]>): Map<string, string> {
    return new Map([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

function cleanPlainText(value: string | undefined, fallback: string, maxLength = 200): string {
    const cleaned = [...(value ?? '')]
        .map((character) => (hasControlCharacters(character) ? ' ' : character))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || fallback).slice(0, maxLength);
}

function metadataBlockEnd(content: string): number {
    if (!content.startsWith('---\n')) {
        return -1;
    }
    const end = content.indexOf('\n---\n', 4);
    return end < 0 ? -2 : end + '\n---\n'.length;
}

function headingTitle(content: string, fallback: string): string {
    const end = metadataBlockEnd(content);
    const body = end > 0 ? content.slice(end) : content;
    const match = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
    return cleanPlainText(match?.[1], fallback);
}

function slug(value: string, separator: '-' | '.' = '-'): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9_-]+/g, separator)
        .replace(new RegExp(`\\${separator}+`, 'g'), separator)
        .replace(new RegExp(`^\\${separator}|\\${separator}$`, 'g'), '')
        .toLowerCase();
}

function stableHash(value: string): string {
    // FNV-1a is sufficient here: the hash is only a deterministic collision
    // suffix, never a security boundary.
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function generatedPageId(path: string, prefix: string): string {
    const withoutExtension = path.replace(/\.[^./]+$/, '');
    return `${prefix}.${slug(withoutExtension, '.') || 'page'}`;
}

function unquoteYamlScalar(value: string): string {
    const scalar = value.trim();
    if (scalar.startsWith('"') && scalar.endsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(scalar);
            return typeof parsed === 'string' ? parsed : scalar;
        } catch {
            return scalar.slice(1, -1);
        }
    }
    if (scalar.startsWith("'") && scalar.endsWith("'")) {
        return scalar.slice(1, -1).replace(/''/g, "'");
    }
    return scalar;
}

function parseToc(content: string, diagnostics: DocumentationBundleDiagnostic[]): TocEntry[] {
    const entries: { name: string; href?: string; indent: number }[] = [];
    let current: { name: string; href?: string; indent: number } | undefined;
    for (const line of content.split('\n')) {
        const name = /^(\s*)-\s+name:\s*(.*?)\s*$/.exec(line);
        if (name) {
            current = { name: unquoteYamlScalar(name[2]), indent: name[1].length };
            entries.push(current);
            continue;
        }
        const href = /^\s*href:\s*(.*?)\s*$/.exec(line);
        if (href && current) {
            current.href = unquoteYamlScalar(href[1]);
        }
    }
    if (entries.length === 0) {
        diagnostic(
            diagnostics,
            'empty-toc',
            'warning',
            'toc.yml contains no supported name/href entries; a page-list navigation was generated.',
            'toc.yml'
        );
        return [];
    }
    const indents = [...new Set(entries.map((entry) => entry.indent))].sort((a, b) => a - b);
    return entries.map((entry) => ({
        name: entry.name,
        ...(entry.href ? { href: entry.href } : {}),
        level: indents.indexOf(entry.indent),
    }));
}

function splitTarget(target: string): { path: string; suffix: string } {
    const marker = target.search(/[?#]/);
    return marker < 0 ? { path: target, suffix: '' } : { path: target.slice(0, marker), suffix: target.slice(marker) };
}

function isExternalTarget(target: string): boolean {
    return /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|#)/.test(target);
}

function resolveRelative(fromFile: string, target: string): string | null {
    const base = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    const parts: string[] = [];
    for (const part of `${base}/${target}`.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (parts.length === 0) {
                return null;
            }
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join('/');
}

function relativePath(fromFile: string, toFile: string): string {
    const from = fromFile.split('/');
    from.pop();
    const to = toFile.split('/');
    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) {
        shared++;
    }
    const result = [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
    return result || toFile.split('/').pop() || toFile;
}

function tocTargetPath(href: string): string | null {
    const target = splitTarget(href).path;
    if (!target || isExternalTarget(target)) {
        return null;
    }
    return safeRelativePath(target);
}

function validateTocTargets(
    toc: string,
    files: ReadonlyMap<string, string>,
    diagnostics: DocumentationBundleDiagnostic[]
): TocEntry[] {
    const entries = parseToc(toc, diagnostics);
    for (const entry of entries) {
        if (!entry.href) {
            continue;
        }
        const target = tocTargetPath(entry.href);
        if (target && !files.has(target)) {
            diagnostic(
                diagnostics,
                'missing-toc-target',
                'error',
                `The TOC entry ${JSON.stringify(entry.name)} targets missing file ${JSON.stringify(target)}.`,
                'toc.yml'
            );
        }
    }
    return entries;
}

function sanitizeLanguage(value: string | undefined, diagnostics: DocumentationBundleDiagnostic[]): string {
    const candidate = cleanPlainText(value, 'en', 35);
    if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(candidate)) {
        return candidate;
    }
    diagnostic(
        diagnostics,
        'invalid-language',
        'warning',
        `Invalid documentation language ${JSON.stringify(candidate)}; "en" was used.`
    );
    return 'en';
}

function sanitizePageIdPrefix(value: string | undefined, diagnostics: DocumentationBundleDiagnostic[]): string {
    const candidate = cleanPlainText(value, 'ooci', 80);
    const safe = slug(candidate, '.');
    if (safe && safe === candidate.toLowerCase()) {
        return safe;
    }
    const fallback = safe || 'ooci';
    diagnostic(
        diagnostics,
        'normalized-page-id-prefix',
        'info',
        `Normalized the page identifier prefix to ${JSON.stringify(fallback)}.`
    );
    return fallback;
}

function sanitizeOutputDirectory(value: string | undefined, diagnostics: DocumentationBundleDiagnostic[]): string {
    const candidate = value ?? '_site';
    const safe = safeRelativePath(candidate);
    if (safe) {
        return safe;
    }
    diagnostic(
        diagnostics,
        'invalid-output-path',
        'warning',
        `Unsafe static-site output path ${JSON.stringify(candidate)}; "_site" was used.`
    );
    return '_site';
}

function sanitizeThemePaths(
    values: readonly string[] | undefined,
    diagnostics: DocumentationBundleDiagnostic[]
): string[] {
    const result: string[] = [];
    for (const raw of values ?? []) {
        const path = safeRelativePath(raw);
        if (!path) {
            diagnostic(
                diagnostics,
                'invalid-theme-path',
                'warning',
                `Ignored unsafe static-site theme path ${JSON.stringify(raw)}.`
            );
        } else if (!result.includes(path)) {
            result.push(path);
        }
    }
    return result;
}

function removeGeneratedStaticFiles(files: Map<string, string>, diagnostics: DocumentationBundleDiagnostic[]): void {
    const generated = new Set([STATIC_SITE_CONFIG, STATIC_SITE_MANIFEST, STATIC_SITE_NAVIGATION]);
    for (const path of [...files.keys()]) {
        const lower = path.toLowerCase();
        if (generated.has(lower)) {
            files.delete(path);
            diagnostic(
                diagnostics,
                'generated-file-replaced',
                'warning',
                `The input ${path} was replaced by deterministic static-site metadata.`,
                path
            );
        } else if (lower === LEGACY_STATIC_CONFIG) {
            // Migration safety: never carry a legacy engine-specific control
            // file into a newly generated portable bundle.
            files.delete(path);
            diagnostic(
                diagnostics,
                'legacy-static-config-ignored',
                'info',
                'An obsolete engine-specific configuration file was omitted from the portable bundle.'
            );
        }
    }
}

/** Package generated Markdown as a deterministic, engine-neutral static-site project. */
export function createStaticSiteBundle(
    source: ReadonlyMap<string, string>,
    options: StaticSiteBundleOptions = {}
): DocumentationBundle {
    const normalized = normalizeInput(source);
    const { diagnostics } = normalized;
    const title = cleanPlainText(options.title, DEFAULT_TITLE);
    const language = sanitizeLanguage(options.language, diagnostics);
    const pageIdPrefix = sanitizePageIdPrefix(options.pageIdPrefix, diagnostics);
    const outputDirectory = sanitizeOutputDirectory(options.outputDirectory, diagnostics);
    const themePaths = sanitizeThemePaths(options.themePaths, diagnostics);

    const files = new Map(normalized.files);
    removeGeneratedStaticFiles(files, diagnostics);

    const toc = files.get('toc.yml');
    let tocEntries: TocEntry[] = [];
    if (!toc) {
        diagnostic(
            diagnostics,
            'missing-toc',
            'error',
            'A root toc.yml is required for authored static-site navigation; a page-list fallback was generated.',
            'toc.yml'
        );
    } else {
        tocEntries = validateTocTargets(toc, files, diagnostics);
    }

    const markdownEntries = [...files.entries()]
        .filter(([path]) => path.toLowerCase().endsWith('.md'))
        .sort(([a], [b]) => (a === 'index.md' ? -1 : b === 'index.md' ? 1 : a.localeCompare(b)));
    const usedPageIds = new Set<string>();
    const pages = markdownEntries.map(([path, content]) => {
        let id = generatedPageId(path, pageIdPrefix);
        if (usedPageIds.has(id)) {
            const base = `${id}-${stableHash(path)}`;
            id = base;
            let suffix = 2;
            while (usedPageIds.has(id)) {
                id = `${base}-${suffix++}`;
            }
            diagnostic(
                diagnostics,
                'duplicate-page-id',
                'warning',
                `Resolved a generated page identifier collision for ${JSON.stringify(path)}.`,
                path
            );
        }
        usedPageIds.add(id);
        return { id, path, title: headingTitle(content, path.replace(/\.md$/i, '')) };
    });
    const navigationItems =
        tocEntries.length > 0
            ? tocEntries.map((entry) => {
                  const target = entry.href ? tocTargetPath(entry.href) : null;
                  const path = target && files.has(target) ? target : undefined;
                  return {
                      title: cleanPlainText(entry.name, 'Untitled'),
                      ...(path ? { path } : {}),
                      depth: entry.level,
                  };
              })
            : pages.map((page) => ({ title: page.title, path: page.path, depth: 0 }));
    const resources = [...files.keys()]
        .filter((path) => path !== 'toc.yml' && !path.toLowerCase().endsWith('.md'))
        .sort((left, right) => left.localeCompare(right));

    const config = {
        formatVersion: 1,
        site: { title, language },
        build: {
            content: ['**/*.md'],
            resources: ['**/*.{png,jpg,jpeg,gif,svg,webp,ico}'],
            navigation: STATIC_SITE_NAVIGATION,
            manifest: STATIC_SITE_MANIFEST,
            outputDirectory,
            themePaths,
        },
    };
    const manifest = {
        formatVersion: 1,
        pages,
        resources,
    };
    const navigation = {
        formatVersion: 1,
        items: navigationItems,
    };
    files.set(STATIC_SITE_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
    files.set(STATIC_SITE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    files.set(STATIC_SITE_NAVIGATION, `${JSON.stringify(navigation, null, 2)}\n`);
    return { files: sortedMap(files), diagnostics };
}

function stripPageMetadata(content: string): string {
    const end = metadataBlockEnd(content);
    return end > 0 ? content.slice(end).replace(/^\n+/, '') : content;
}

function markdownLabel(value: string): string {
    const htmlSafe = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escaped = [...htmlSafe]
        .map((character) => ('\\[]*_'.includes(character) ? `\\${character}` : character))
        .join('');
    return escaped.replace(/[\r\n]+/g, ' ').trim() || 'Untitled';
}

function rewriteTarget(
    rawTarget: string,
    sourcePage: string,
    outputPage: string,
    mapping: ReadonlyMap<string, string>,
    sourceFiles: readonly string[],
    sourceRootDepth: number,
    outputPathPrefixDepth: number
): string {
    const angleWrapped = rawTarget.startsWith('<') && rawTarget.endsWith('>');
    const target = angleWrapped ? rawTarget.slice(1, -1) : rawTarget;
    if (isExternalTarget(target)) {
        return rawTarget;
    }
    const split = splitTarget(target);
    if (!split.path) {
        return rawTarget;
    }
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(split.path).replace(/\\/g, '/');
    } catch {
        decodedPath = split.path.replace(/\\/g, '/');
    }
    for (const sourceFile of sourceFiles) {
        const expected = relativePath(sourcePage, `${'../'.repeat(sourceRootDepth)}${sourceFile}`);
        if (decodedPath !== expected) {
            continue;
        }
        const pageDepth = Math.max(0, outputPage.split('/').length - 1);
        const prefix = '../'.repeat(sourceRootDepth + outputPathPrefixDepth + pageDepth);
        const encodedSource = sourceFile
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/');
        return `<${prefix}${encodedSource}${split.suffix}>`;
    }
    const resolved = resolveRelative(sourcePage, split.path);
    const mapped = resolved ? mapping.get(resolved) : undefined;
    if (!mapped) {
        return rawTarget;
    }
    const rewritten = `${relativePath(outputPage, mapped)}${split.suffix}`;
    return `<${rewritten}>`;
}

function rewriteMarkdownLinks(
    content: string,
    sourcePage: string,
    outputPage: string,
    mapping: ReadonlyMap<string, string>,
    sourceFiles: readonly string[],
    sourceRootDepth: number,
    outputPathPrefixDepth: number
): string {
    const inline = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)(\))/g;
    const references = /^(\s*\[[^\]\n]+\]:\s*)(<[^>\n]+>|\S+)(.*)$/;
    let fenceCharacter = '';
    let fenceLength = 0;
    const rewriteSegment = (segment: string): string =>
        segment
            .replace(inline, (_whole, opening: string, target: string, closing: string) => {
                return `${opening}${rewriteTarget(
                    target,
                    sourcePage,
                    outputPage,
                    mapping,
                    sourceFiles,
                    sourceRootDepth,
                    outputPathPrefixDepth
                )}${closing}`;
            })
            .replace(references, (_whole, opening: string, target: string, suffix: string) => {
                return `${opening}${rewriteTarget(
                    target,
                    sourcePage,
                    outputPage,
                    mapping,
                    sourceFiles,
                    sourceRootDepth,
                    outputPathPrefixDepth
                )}${suffix}`;
            });
    const rewriteOutsideCodeSpans = (line: string): string => {
        let cursor = 0;
        let result = '';
        const opening = /`+/.exec(line);
        let next = opening;
        while (next) {
            const start = cursor + (next.index ?? 0);
            result += rewriteSegment(line.slice(cursor, start));
            const delimiter = next[0];
            const closingAt = line.indexOf(delimiter, start + delimiter.length);
            if (closingAt < 0) {
                return result + line.slice(start);
            }
            const end = closingAt + delimiter.length;
            result += line.slice(start, end);
            cursor = end;
            next = /`+/.exec(line.slice(cursor));
        }
        return result + rewriteSegment(line.slice(cursor));
    };
    return content
        .split('\n')
        .map((line) => {
            if (fenceCharacter) {
                const closing = new RegExp(`^\\s{0,3}${fenceCharacter}{${fenceLength},}\\s*$`);
                if (closing.test(line)) {
                    fenceCharacter = '';
                    fenceLength = 0;
                }
                return line;
            }
            const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
            if (opening) {
                fenceCharacter = opening[1][0];
                fenceLength = opening[1].length;
                return line;
            }
            return rewriteOutsideCodeSpans(line);
        })
        .join('\n');
}

function reserveWikiPath(
    requested: string,
    sourcePath: string,
    used: Set<string>,
    diagnostics: DocumentationBundleDiagnostic[]
): string {
    if (!used.has(requested.toLowerCase())) {
        used.add(requested.toLowerCase());
        return requested;
    }
    const extensionAt = requested.lastIndexOf('.');
    const stem = extensionAt > 0 ? requested.slice(0, extensionAt) : requested;
    const extension = extensionAt > 0 ? requested.slice(extensionAt) : '';
    const base = `${stem}-${stableHash(sourcePath)}`;
    let replacement = `${base}${extension}`;
    let suffix = 2;
    while (used.has(replacement.toLowerCase())) {
        replacement = `${base}-${suffix++}${extension}`;
    }
    used.add(replacement.toLowerCase());
    diagnostic(
        diagnostics,
        'wiki-path-collision',
        'warning',
        `Renamed colliding wiki page ${JSON.stringify(sourcePath)} to ${JSON.stringify(replacement)}.`,
        sourcePath
    );
    return replacement;
}

function createWikiPageMapping(
    markdownPaths: readonly string[],
    flavor: WikiFlavor,
    diagnostics: DocumentationBundleDiagnostic[]
): Map<string, string> {
    const mapping = new Map<string, string>();
    const reserved =
        flavor === 'github' ? ['_Sidebar.md', '_Footer.md'] : flavor === 'generic' ? ['Navigation.md'] : [];
    const used = new Set<string>(reserved.map((path) => path.toLowerCase()));
    const homeSource = markdownPaths.includes('index.md') ? 'index.md' : markdownPaths[0];
    if (homeSource && homeSource !== 'index.md') {
        diagnostic(
            diagnostics,
            'missing-index',
            'warning',
            `${JSON.stringify(homeSource)} was promoted to Home.md because index.md is missing.`,
            homeSource
        );
    }
    if (homeSource) {
        mapping.set(homeSource, reserveWikiPath('Home.md', homeSource, used, diagnostics));
    }
    for (const sourcePath of markdownPaths) {
        if (sourcePath === homeSource) {
            continue;
        }
        const requested = flavor === 'github' ? sourcePath.replace(/\//g, '-') : sourcePath;
        mapping.set(sourcePath, reserveWikiPath(requested, sourcePath, used, diagnostics));
    }
    return mapping;
}

function fallbackToc(mapping: ReadonlyMap<string, string>, files: ReadonlyMap<string, string>): TocEntry[] {
    return [...mapping.entries()].map(([sourcePath, outputPath]) => ({
        name: headingTitle(files.get(sourcePath) ?? '', outputPath.replace(/\.md$/i, '')),
        href: sourcePath,
        level: 0,
    }));
}

function renderWikiNavigation(entries: readonly TocEntry[], mapping: ReadonlyMap<string, string>): string {
    const lines: string[] = [];
    for (const entry of entries) {
        const indentation = '  '.repeat(entry.level);
        const sourceTarget = entry.href ? tocTargetPath(entry.href) : null;
        const outputTarget = sourceTarget ? mapping.get(sourceTarget) : undefined;
        if (outputTarget) {
            const suffix = entry.href ? splitTarget(entry.href).suffix : '';
            lines.push(`${indentation}- [${markdownLabel(entry.name)}](<${outputTarget}${suffix}>)`);
        } else {
            lines.push(`${indentation}- **${markdownLabel(entry.name)}**`);
        }
    }
    return `${lines.join('\n')}\n`;
}

function azureOrderFiles(mapping: ReadonlyMap<string, string>, entries: readonly TocEntry[]): Map<string, string> {
    const orderedPaths: string[] = [];
    for (const entry of entries) {
        const target = entry.href ? tocTargetPath(entry.href) : null;
        const mapped = target ? mapping.get(target) : undefined;
        if (mapped && !orderedPaths.includes(mapped)) {
            orderedPaths.push(mapped);
        }
    }
    for (const mapped of mapping.values()) {
        if (!orderedPaths.includes(mapped)) {
            orderedPaths.push(mapped);
        }
    }

    const orders = new Map<string, string[]>();
    for (const page of orderedPaths) {
        const segments = page.split('/');
        for (let depth = 0; depth < segments.length; depth++) {
            const directory = segments.slice(0, depth).join('/');
            const name = segments[depth].replace(/\.md$/i, '');
            const list = orders.get(directory) ?? [];
            if (!list.includes(name)) {
                list.push(name);
            }
            orders.set(directory, list);
        }
    }
    const result = new Map<string, string>();
    for (const [directory, names] of orders) {
        result.set(directory ? `${directory}/.order` : '.order', `${names.join('\n')}\n`);
    }
    return result;
}

function isWikiControlFile(path: string): boolean {
    const lower = path.toLowerCase();
    return (
        lower === 'toc.yml' ||
        lower === STATIC_SITE_CONFIG ||
        lower === STATIC_SITE_MANIFEST ||
        lower === STATIC_SITE_NAVIGATION ||
        lower === LEGACY_STATIC_CONFIG
    );
}

/**
 * Convert generated documentation to a portable CommonMark wiki bundle.
 * Generic emits Navigation.md, GitHub emits _Sidebar.md/_Footer.md, and Azure
 * emits a .order file for every directory that contains ordered pages.
 */
export function createWikiBundle(
    source: ReadonlyMap<string, string>,
    options: WikiBundleOptions = {}
): DocumentationBundle {
    const normalized = normalizeInput(source);
    const { diagnostics } = normalized;
    const flavor = options.flavor ?? 'generic';
    const title = cleanPlainText(options.title, DEFAULT_TITLE);
    const sourceRootDepth =
        Number.isSafeInteger(options.sourceRootDepth) && (options.sourceRootDepth ?? -1) >= 0
            ? (options.sourceRootDepth as number)
            : 0;
    const outputPathPrefixDepth =
        Number.isSafeInteger(options.outputPathPrefixDepth) && (options.outputPathPrefixDepth ?? -1) >= 0
            ? (options.outputPathPrefixDepth as number)
            : 0;
    const sourceFiles = [...new Set(options.sourceFiles ?? [])]
        .map((path) => safeRelativePath(path))
        .filter((path): path is string => path !== null)
        .sort((left, right) => left.localeCompare(right));
    const markdownPaths = [...normalized.files.keys()].filter((path) => path.toLowerCase().endsWith('.md')).sort();
    if (markdownPaths.length === 0) {
        diagnostic(diagnostics, 'no-markdown-pages', 'error', 'The wiki bundle contains no Markdown pages.');
    }

    const mapping = createWikiPageMapping(markdownPaths, flavor, diagnostics);
    const tocPath = [...normalized.files.keys()].find((path) => path.toLowerCase() === 'toc.yml');
    const tocContent = tocPath ? normalized.files.get(tocPath) : undefined;
    let entries: TocEntry[];
    if (tocContent) {
        entries = validateTocTargets(tocContent, normalized.files, diagnostics);
        if (entries.length === 0) {
            entries = fallbackToc(mapping, normalized.files);
        }
    } else {
        diagnostic(
            diagnostics,
            'missing-toc',
            'warning',
            'toc.yml is missing; navigation was inferred from Markdown pages.',
            'toc.yml'
        );
        entries = fallbackToc(mapping, normalized.files);
    }

    const files = new Map<string, string>();
    const targetMapping = new Map(mapping);
    for (const path of normalized.files.keys()) {
        if (!path.toLowerCase().endsWith('.md') && !isWikiControlFile(path)) {
            targetMapping.set(path, path);
        }
    }
    for (const [sourcePath, outputPath] of mapping) {
        const content = stripPageMetadata(normalized.files.get(sourcePath) ?? '');
        files.set(
            outputPath,
            rewriteMarkdownLinks(
                content,
                sourcePath,
                outputPath,
                targetMapping,
                sourceFiles,
                sourceRootDepth,
                outputPathPrefixDepth
            )
        );
    }
    // Preserve non-page resources. Site-control and TOC files are consumed by
    // the adapter rather than copied into the wiki repository.
    for (const [path, content] of normalized.files) {
        if (!path.toLowerCase().endsWith('.md') && !isWikiControlFile(path)) {
            const lowerPath = path.toLowerCase();
            if (flavor === 'azure' && (lowerPath === '.order' || lowerPath.endsWith('/.order'))) {
                diagnostic(
                    diagnostics,
                    'generated-file-replaced',
                    'warning',
                    `The input ${path} was replaced by Azure Wiki ordering metadata.`,
                    path
                );
                continue;
            }
            files.set(path, content);
        }
    }

    const navigation = renderWikiNavigation(entries, mapping);
    if (flavor === 'github') {
        files.set('_Sidebar.md', `## ${markdownLabel(title)}\n\n${navigation}`);
        const footer = markdownLabel(cleanPlainText(options.footer, 'Generated by Out-of-Code Insights.'));
        files.set('_Footer.md', `_${footer}_\n`);
    } else if (flavor === 'azure') {
        for (const [path, content] of azureOrderFiles(mapping, entries)) {
            files.set(path, content);
        }
    } else {
        files.set('Navigation.md', `# Navigation\n\n${navigation}`);
    }

    return { files: sortedMap(files), diagnostics };
}
