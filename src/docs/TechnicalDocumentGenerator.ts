// SPDX-License-Identifier: MPL-2.0

import type { DocAnnotation } from './AnnotationDocGenerator';
import { SUPPORTED_TECHNICAL_DOCUMENT_KINDS, type TechnicalDocumentKind } from './DocumentTemplateCatalog';

export type { TechnicalDocumentKind } from './DocumentTemplateCatalog';

/** Documents that can be selected independently by callers and templates. */
export const TECHNICAL_DOCUMENT_KINDS: readonly TechnicalDocumentKind[] = SUPPORTED_TECHNICAL_DOCUMENT_KINDS;
export type TechnicalDocumentDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface TechnicalDocumentDiagnostic {
    code: string;
    severity: TechnicalDocumentDiagnosticSeverity;
    message: string;
    annotationId?: string;
    path?: string;
}

export interface TechnicalDocumentOptions {
    /** Default: every supported document kind. An empty array emits no files. */
    kinds?: readonly TechnicalDocumentKind[];
    /** Optional heading for README.md. No project name is inferred from source paths. */
    projectTitle?: string;
    /** Prefix used by documentation-role tags. Default: "doc:". */
    tagPrefix?: string;
    /** Number of path segments from the generated bundle root to the workspace root. Default: 0. */
    sourceRootDepth?: number;
}

export interface TechnicalDocumentResult {
    /** Deterministically ordered, workspace-relative files. */
    files: ReadonlyMap<string, string>;
    diagnostics: readonly TechnicalDocumentDiagnostic[];
}

type ChangeCategory = 'added' | 'changed' | 'deprecated' | 'removed' | 'fixed' | 'security';
type ReferenceRole = 'reference' | 'module' | 'class' | 'function' | 'example';

interface PreparedAnnotation {
    annotation: DocAnnotation;
    id: string;
    file: string;
    safeSourcePath: string | null;
    line: number | null;
    message: string;
    title: string;
    body: string;
    author?: string;
    timestamp: string;
    tags: string[];
    lowerTags: string[];
    snippet?: { code: string; language: string };
    sortKey: string;
}

interface ChangeEntry {
    annotation: PreparedAnnotation;
    categories: ChangeCategory[];
    version: string;
    releaseDate?: string;
}

interface ChangeVersion {
    labels: Set<string>;
    releaseDates: Set<string>;
    entries: ChangeEntry[];
}

interface AdrPage {
    annotation: PreparedAnnotation;
    path: string;
    fileName: string;
    statuses: string[];
}

const KIND_SET: ReadonlySet<string> = new Set(TECHNICAL_DOCUMENT_KINDS);
const CHANGE_CATEGORIES: readonly ChangeCategory[] = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];
const CHANGE_CATEGORY_TITLES: Readonly<Record<ChangeCategory, string>> = {
    added: 'Added',
    changed: 'Changed',
    deprecated: 'Deprecated',
    removed: 'Removed',
    fixed: 'Fixed',
    security: 'Security',
};
const UNSAFE_PATH_CHARACTERS = /[<>:"|?*]/;

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function pushDiagnostic(
    diagnostics: TechnicalDocumentDiagnostic[],
    code: string,
    severity: TechnicalDocumentDiagnosticSeverity,
    message: string,
    annotationId?: string,
    path?: string
): void {
    diagnostics.push({
        code,
        severity,
        message,
        ...(annotationId ? { annotationId } : {}),
        ...(path ? { path } : {}),
    });
}

function stripUnsafeControls(value: string): { value: string; changed: boolean } {
    let changed = false;
    const normalized = [...value.replace(/\r\n?/g, '\n')]
        .filter((character) => {
            const code = character.charCodeAt(0);
            const unsafeControl = (code < 0x20 && character !== '\n' && character !== '\t') || code === 0x7f;
            const unsafeDirection = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
            if (unsafeControl || unsafeDirection) {
                changed = true;
                return false;
            }
            return true;
        })
        .join('');
    return { value: normalized, changed };
}

function cleanScalar(value: unknown): string {
    return stripUnsafeControls(typeof value === 'string' ? value : String(value ?? ''))
        .value.replace(/\s+/g, ' ')
        .trim();
}

function extractTitleAndBody(message: string): { title: string; body: string } {
    const lines = message.split('\n');
    let first = 0;
    while (first < lines.length && lines[first].trim().length === 0) {
        first++;
    }
    if (first >= lines.length) {
        return { title: '', body: '' };
    }
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[first].trim());
    const title = cleanScalar(heading?.[1] ?? lines[first]);
    return {
        title,
        body: lines
            .slice(first + 1)
            .join('\n')
            .trim(),
    };
}

function hasPathControlCharacters(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
    });
}

function normalizeSourcePath(rawPath: string): string | null {
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
        if (
            part === '..' ||
            UNSAFE_PATH_CHARACTERS.test(part) ||
            hasPathControlCharacters(part) ||
            stripUnsafeControls(part).changed
        ) {
            return null;
        }
        parts.push(part);
    }
    return parts.length > 0 ? parts.join('/') : null;
}

function normalizeTagPrefix(value: string | undefined, diagnostics: TechnicalDocumentDiagnostic[]): string {
    const cleaned = cleanScalar(value ?? 'doc:');
    if (cleaned.length === 0) {
        pushDiagnostic(diagnostics, 'invalid-tag-prefix', 'warning', 'An empty tag prefix was replaced with "doc:".');
        return 'doc:';
    }
    return cleaned;
}

function annotationSortKey(annotation: DocAnnotation): string {
    const fields = [
        cleanScalar(annotation.file),
        Number.isInteger(annotation.line) ? String(annotation.line).padStart(12, '0') : '',
        cleanScalar(annotation.timestamp),
        cleanScalar(annotation.id),
        stripUnsafeControls(annotation.message ?? '').value,
    ];
    return fields.join('\u0000');
}

function prepareAnnotations(
    annotations: readonly DocAnnotation[],
    diagnostics: TechnicalDocumentDiagnostic[]
): PreparedAnnotation[] {
    const sorted = [...annotations].sort((left, right) =>
        compareText(annotationSortKey(left), annotationSortKey(right))
    );
    const seenIds = new Set<string>();
    return sorted.map((annotation) => {
        const id = cleanScalar(annotation.id) || 'missing-id';
        const cleanedMessage = stripUnsafeControls(annotation.message ?? '');
        const cleanedFile = stripUnsafeControls(annotation.file ?? '');
        if (cleanedMessage.changed || cleanedFile.changed) {
            pushDiagnostic(
                diagnostics,
                'unsafe-control-character',
                'warning',
                'Unsafe control or bidirectional-formatting characters were removed.',
                id
            );
        }
        if (seenIds.has(id)) {
            pushDiagnostic(
                diagnostics,
                'duplicate-annotation-id',
                'warning',
                `Annotation id ${JSON.stringify(id)} occurs more than once; all authored content was retained.`,
                id
            );
        }
        seenIds.add(id);

        const file = cleanedFile.value.trim();
        const safeSourcePath = cleanedFile.changed ? null : normalizeSourcePath(cleanedFile.value);
        if (!safeSourcePath) {
            pushDiagnostic(
                diagnostics,
                'unsafe-source-path',
                'warning',
                'The annotation source path is not a safe workspace-relative path, so no source link was emitted.',
                id
            );
        }

        const line = Number.isInteger(annotation.line) && annotation.line >= 0 ? annotation.line : null;
        if (annotation.line !== -1 && line === null) {
            pushDiagnostic(
                diagnostics,
                'invalid-source-line',
                'warning',
                'The annotation line is invalid; the source is rendered without a line number.',
                id
            );
        }

        const tags = [...new Set((annotation.tags ?? []).map(cleanScalar).filter(Boolean))].sort(compareText);
        const normalizedMessage = cleanedMessage.value.trim();
        const split = extractTitleAndBody(normalizedMessage);
        if (normalizedMessage.length === 0) {
            pushDiagnostic(
                diagnostics,
                'empty-annotation-message',
                'warning',
                'The annotation has no authored message; only its explicit metadata can be documented.',
                id
            );
        }

        let snippet: PreparedAnnotation['snippet'];
        if (annotation.snippet) {
            const cleanedCode = stripUnsafeControls(annotation.snippet.code ?? '');
            const language = cleanScalar(annotation.snippet.language);
            if (cleanedCode.changed) {
                pushDiagnostic(
                    diagnostics,
                    'unsafe-control-character',
                    'warning',
                    'Unsafe control characters were removed from an annotation code excerpt.',
                    id
                );
            }
            if (language && !/^[A-Za-z0-9_+.#-]{1,40}$/.test(language)) {
                pushDiagnostic(
                    diagnostics,
                    'invalid-code-language',
                    'warning',
                    'The code-excerpt language label was omitted because it is unsafe.',
                    id
                );
                snippet = { code: cleanedCode.value, language: '' };
            } else {
                snippet = { code: cleanedCode.value, language };
            }
        }

        return {
            annotation,
            id,
            file,
            safeSourcePath,
            line,
            message: normalizedMessage,
            title: split.title || `Annotation ${id}`,
            body: split.body,
            ...(cleanScalar(annotation.author) ? { author: cleanScalar(annotation.author) } : {}),
            timestamp: cleanScalar(annotation.timestamp),
            tags,
            lowerTags: tags.map((tag) => tag.toLowerCase()),
            ...(snippet ? { snippet } : {}),
            sortKey: annotationSortKey(annotation),
        };
    });
}

function escapeMarkdownInline(value: string): string {
    return cleanScalar(value).replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

function escapeTableCell(value: string): string {
    return escapeMarkdownInline(value);
}

function inlineCode(value: string): string {
    const scalar = cleanScalar(value);
    const longest = Math.max(0, ...([...scalar.matchAll(/`+/g)].map((match) => match[0].length) || [0]));
    const fence = '`'.repeat(longest + 1);
    const padded = /^\s|\s$|^`|`$/.test(scalar) ? ` ${scalar} ` : scalar;
    return `${fence}${padded}${fence}`;
}

function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function slug(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72)
        .replace(/-+$/g, '');
}

function relativePath(fromFile: string, toFile: string): string {
    const from = fromFile.split('/');
    from.pop();
    const to = toFile.split('/');
    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) {
        shared++;
    }
    return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/') || toFile;
}

function encodeRelativeTarget(path: string): string {
    return path
        .split('/')
        .map((part) =>
            part === '..'
                ? part
                : encodeURIComponent(part).replace(
                      /[!'()*]/g,
                      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
                  )
        )
        .join('/');
}

function markdownLink(label: string, target: string): string {
    return `[${escapeMarkdownInline(label)}](<${encodeRelativeTarget(target)}>)`;
}

function sourceReference(annotation: PreparedAnnotation, outputPath: string, sourceRootDepth: number): string {
    const label = `${annotation.file || annotation.id}${annotation.line === null ? '' : `:${annotation.line + 1}`}`;
    if (!annotation.safeSourcePath) {
        return inlineCode(label);
    }
    const workspaceTarget = `${'../'.repeat(sourceRootDepth)}${annotation.safeSourcePath}`;
    const target = encodeRelativeTarget(relativePath(outputPath, workspaceTarget));
    const lineFragment = annotation.line === null ? '' : `#L${annotation.line + 1}`;
    return `[${escapeMarkdownInline(label)}](<${target}${lineFragment}>)`;
}

function tagEquals(annotation: PreparedAnnotation, expected: string): boolean {
    return annotation.lowerTags.includes(expected.toLowerCase());
}

function hasDocRole(annotation: PreparedAnnotation, tagPrefix: string, role: string): boolean {
    return tagEquals(annotation, `${tagPrefix}${role}`);
}

function valuesForTagPrefixes(annotation: PreparedAnnotation, prefixes: readonly string[]): string[] {
    const values = new Set<string>();
    for (const tag of annotation.tags) {
        for (const prefix of prefixes) {
            if (tag.toLowerCase().startsWith(prefix.toLowerCase())) {
                const value = cleanScalar(tag.slice(prefix.length));
                if (value) {
                    values.add(value);
                }
            }
        }
    }
    return [...values].sort(compareText);
}

function demoteBodyHeadings(markdown: string, parentLevel: number): string {
    if (!markdown) {
        return '';
    }
    const output: string[] = [];
    let fenceCharacter = '';
    let fenceLength = 0;
    let displayMath = false;

    for (const line of markdown.split('\n')) {
        const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            const character = fence[1][0];
            if (!fenceCharacter) {
                fenceCharacter = character;
                fenceLength = fence[1].length;
            } else if (character === fenceCharacter && fence[1].length >= fenceLength) {
                fenceCharacter = '';
                fenceLength = 0;
            }
            output.push(line);
            continue;
        }
        if (fenceCharacter) {
            output.push(line);
            continue;
        }
        if (/^\s*\$\$\s*$/.test(line)) {
            displayMath = !displayMath;
            output.push(line);
            continue;
        }
        if (displayMath) {
            output.push(line);
            continue;
        }

        if (/^\s{0,3}(?:=+|-+)\s*$/.test(line) && output.length > 0 && output[output.length - 1].trim()) {
            const previous = output.pop() as string;
            output.push(`${'#'.repeat(Math.min(6, parentLevel + 1))} ${previous.trim()}`);
            continue;
        }
        const heading = /^(\s{0,3})(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
            output.push(`${heading[1]}${'#'.repeat(Math.min(6, heading[2].length + parentLevel))} ${heading[3]}`);
        } else {
            output.push(line);
        }
    }
    return output.join('\n').trim();
}

function fencedCode(code: string, language: string): string {
    const longest = Math.max(0, ...([...code.matchAll(/`+/g)].map((match) => match[0].length) || [0]));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${language}\n${code.replace(/\s+$/g, '')}\n${fence}`;
}

function renderMetadata(
    annotation: PreparedAnnotation,
    outputPath: string,
    sourceRootDepth: number,
    role?: string
): string {
    const lines = [
        `> Source: ${sourceReference(annotation, outputPath, sourceRootDepth)}`,
        `> Annotation: ${inlineCode(annotation.id)}`,
    ];
    if (role) {
        lines.push(`> Role: ${inlineCode(role)}`);
    }
    if (annotation.author) {
        lines.push(`> Author: ${inlineCode(annotation.author)}`);
    }
    if (annotation.timestamp) {
        lines.push(`> Recorded: ${inlineCode(annotation.timestamp)}`);
    }
    if (annotation.tags.length > 0) {
        lines.push(`> Tags: ${annotation.tags.map(inlineCode).join(', ')}`);
    }
    return lines.join('\n');
}

function renderAnnotationSection(
    annotation: PreparedAnnotation,
    outputPath: string,
    headingLevel: number,
    sourceRootDepth: number,
    role?: string
): string {
    const sections = [
        `${'#'.repeat(headingLevel)} ${escapeMarkdownInline(annotation.title)}`,
        renderMetadata(annotation, outputPath, sourceRootDepth, role),
    ];
    const body = demoteBodyHeadings(annotation.body, headingLevel);
    if (body) {
        sections.push(body);
    }
    if (annotation.snippet?.code) {
        sections.push(`**Code excerpt**\n\n${fencedCode(annotation.snippet.code, annotation.snippet.language)}`);
    }
    return sections.join('\n\n');
}

function renderTaggedPage(
    annotations: readonly PreparedAnnotation[],
    outputPath: string,
    title: string,
    role: string,
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[],
    sourceRootDepth: number
): string {
    const selected = annotations.filter((annotation) => hasDocRole(annotation, tagPrefix, role));
    if (selected.length === 0) {
        pushDiagnostic(
            diagnostics,
            'no-authored-content',
            'info',
            `No annotations use the explicit ${tagPrefix}${role} role.`,
            undefined,
            outputPath
        );
        return `# ${title}\n\n_No annotations tagged ${inlineCode(`${tagPrefix}${role}`)} were provided._\n`;
    }
    return `# ${title}\n\n${selected
        .map((annotation) => renderAnnotationSection(annotation, outputPath, 2, sourceRootDepth, role))
        .join('\n\n')}\n`;
}

function referenceRole(
    annotation: PreparedAnnotation,
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[]
): ReferenceRole | null {
    const roles: ReferenceRole[] = [];
    if (hasDocRole(annotation, tagPrefix, 'reference')) {
        roles.push('reference');
    }
    for (const role of ['module', 'class', 'function', 'example'] as const) {
        if (
            hasDocRole(annotation, tagPrefix, role) ||
            (role === 'function' && hasDocRole(annotation, tagPrefix, 'method'))
        ) {
            roles.push(role);
        }
    }
    if (roles.length > 1) {
        pushDiagnostic(
            diagnostics,
            'multiple-reference-roles',
            'warning',
            `Multiple reference roles were found; ${JSON.stringify(roles[0])} was used for grouping.`,
            annotation.id
        );
    }
    return roles[0] ?? null;
}

function renderReference(
    annotations: readonly PreparedAnnotation[],
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[],
    sourceRootDepth: number
): string {
    const outputPath = 'technical/reference.md';
    const entries = annotations
        .map((annotation) => ({ annotation, role: referenceRole(annotation, tagPrefix, diagnostics) }))
        .filter((entry): entry is { annotation: PreparedAnnotation; role: ReferenceRole } => entry.role !== null);
    if (entries.length === 0) {
        pushDiagnostic(
            diagnostics,
            'no-authored-content',
            'info',
            'No annotations use an explicit technical-reference role.',
            undefined,
            outputPath
        );
        return '# Technical reference\n\n_No explicit reference annotations were provided._\n';
    }

    const byFile = new Map<string, typeof entries>();
    for (const entry of entries) {
        const key = entry.annotation.file || entry.annotation.id;
        const group = byFile.get(key) ?? [];
        group.push(entry);
        byFile.set(key, group);
    }
    const sections = ['# Technical reference'];
    for (const file of [...byFile.keys()].sort(compareText)) {
        sections.push(`## ${inlineCode(file)}`);
        sections.push(
            (byFile.get(file) ?? [])
                .map((entry) => renderAnnotationSection(entry.annotation, outputPath, 3, sourceRootDepth, entry.role))
                .join('\n\n')
        );
    }
    return `${sections.join('\n\n')}\n`;
}

function validVersion(value: string): boolean {
    return /^(?:unreleased|[0-9A-Za-z][0-9A-Za-z._+-]{0,63})$/i.test(value);
}

function validIsoDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function changeCategories(annotation: PreparedAnnotation, tagPrefix: string): ChangeCategory[] {
    const categories: ChangeCategory[] = [];
    for (const category of CHANGE_CATEGORIES) {
        if (
            tagEquals(annotation, category) ||
            tagEquals(annotation, `changelog:${category}`) ||
            tagEquals(annotation, `${tagPrefix}${category}`) ||
            tagEquals(annotation, `${tagPrefix}changelog:${category}`)
        ) {
            categories.push(category);
        }
    }
    return categories;
}

function parseChangeEntry(
    annotation: PreparedAnnotation,
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[]
): ChangeEntry | null {
    const versions = valuesForTagPrefixes(annotation, [
        'release:',
        'version:',
        `${tagPrefix}release:`,
        `${tagPrefix}version:`,
    ]);
    const categories = changeCategories(annotation, tagPrefix);
    const explicitlyChangelog = hasDocRole(annotation, tagPrefix, 'changelog');
    if (!explicitlyChangelog) {
        return null;
    }
    if (versions.length === 0) {
        pushDiagnostic(
            diagnostics,
            'missing-changelog-version',
            'warning',
            'A changelog annotation needs exactly one explicit release: or version: tag.',
            annotation.id
        );
        return null;
    }
    if (versions.length > 1) {
        pushDiagnostic(
            diagnostics,
            'ambiguous-changelog-version',
            'error',
            'A changelog annotation has multiple version tags and was not assigned to a release.',
            annotation.id
        );
        return null;
    }
    if (!validVersion(versions[0])) {
        pushDiagnostic(
            diagnostics,
            'invalid-changelog-version',
            'error',
            `The explicit changelog version ${JSON.stringify(versions[0])} is unsafe.`,
            annotation.id
        );
        return null;
    }
    if (categories.length === 0) {
        pushDiagnostic(
            diagnostics,
            'missing-changelog-category',
            'warning',
            'A versioned changelog annotation needs an added, changed, deprecated, removed, fixed, or security tag.',
            annotation.id
        );
        return null;
    }

    const dates = valuesForTagPrefixes(annotation, ['release-date:', `${tagPrefix}release-date:`]);
    const validDates = dates.filter((date) => {
        if (!validIsoDate(date)) {
            pushDiagnostic(
                diagnostics,
                'invalid-release-date',
                'warning',
                `The explicit release date ${JSON.stringify(date)} is not a real YYYY-MM-DD date.`,
                annotation.id
            );
            return false;
        }
        return true;
    });
    if (validDates.length > 1) {
        pushDiagnostic(
            diagnostics,
            'ambiguous-release-date',
            'warning',
            'Multiple release dates were supplied on one annotation; none was selected.',
            annotation.id
        );
    }
    return {
        annotation,
        categories,
        version: versions[0],
        ...(validDates.length === 1 ? { releaseDate: validDates[0] } : {}),
    };
}

interface SemanticVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

function semanticVersion(value: string): SemanticVersion | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(value);
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split('.') : [],
    };
}

function comparePrerelease(left: string[], right: string[]): number {
    if (left.length === 0 || right.length === 0) {
        return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
    }
    const count = Math.max(left.length, right.length);
    for (let index = 0; index < count; index++) {
        if (left[index] === undefined || right[index] === undefined) {
            return left[index] === right[index] ? 0 : left[index] === undefined ? -1 : 1;
        }
        const leftNumeric = /^\d+$/.test(left[index]);
        const rightNumeric = /^\d+$/.test(right[index]);
        let difference: number;
        if (leftNumeric && rightNumeric) {
            difference = Number(left[index]) - Number(right[index]);
        } else if (leftNumeric !== rightNumeric) {
            difference = leftNumeric ? -1 : 1;
        } else {
            difference = compareText(left[index], right[index]);
        }
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

function compareVersionsDescending(left: string, right: string): number {
    if (left.toLowerCase() === 'unreleased' || right.toLowerCase() === 'unreleased') {
        return left.toLowerCase() === right.toLowerCase() ? 0 : left.toLowerCase() === 'unreleased' ? -1 : 1;
    }
    const leftVersion = semanticVersion(left);
    const rightVersion = semanticVersion(right);
    if (leftVersion && rightVersion) {
        for (const field of ['major', 'minor', 'patch'] as const) {
            const difference = rightVersion[field] - leftVersion[field];
            if (difference !== 0) {
                return difference;
            }
        }
        return -comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
    }
    if (leftVersion || rightVersion) {
        return leftVersion ? -1 : 1;
    }
    return -compareText(left.toLowerCase(), right.toLowerCase());
}

function changelogBullet(entry: ChangeEntry, sourceRootDepth: number): string {
    const summary = [entry.annotation.title, entry.annotation.body]
        .filter(Boolean)
        .join(' — ')
        .replace(/\s+/g, ' ')
        .trim();
    const authored = escapeMarkdownInline(summary || `Annotation ${entry.annotation.id}`);
    return `- ${authored} (${sourceReference(entry.annotation, 'CHANGELOG.md', sourceRootDepth)})`;
}

function renderChangelog(
    annotations: readonly PreparedAnnotation[],
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[],
    sourceRootDepth: number
): string {
    const parsed = annotations
        .map((annotation) => parseChangeEntry(annotation, tagPrefix, diagnostics))
        .filter((entry): entry is ChangeEntry => entry !== null);
    const versions = new Map<string, ChangeVersion>();
    for (const entry of parsed) {
        const key = entry.version.toLowerCase();
        const version = versions.get(key) ?? { labels: new Set(), releaseDates: new Set(), entries: [] };
        version.labels.add(entry.version);
        if (entry.releaseDate) {
            version.releaseDates.add(entry.releaseDate);
        }
        version.entries.push(entry);
        versions.set(key, version);
    }

    const sections = [
        '# Changelog',
        'This file contains only changes documented by annotations with an explicit version and change category.',
    ];
    if (versions.size === 0) {
        pushDiagnostic(
            diagnostics,
            'no-changelog-entries',
            'info',
            'No complete versioned change annotations were available.',
            undefined,
            'CHANGELOG.md'
        );
        sections.push('_No versioned change annotations were provided._');
        return `${sections.join('\n\n')}\n`;
    }

    const sortedVersions = [...versions.entries()].sort(([leftKey, left], [rightKey, right]) => {
        const leftLabel = [...left.labels].sort(compareText)[0] ?? leftKey;
        const rightLabel = [...right.labels].sort(compareText)[0] ?? rightKey;
        return compareVersionsDescending(leftLabel, rightLabel);
    });
    for (const [key, version] of sortedVersions) {
        const label = [...version.labels].sort(compareText)[0] ?? key;
        let date = '';
        if (version.releaseDates.size === 1 && key !== 'unreleased') {
            date = ` - ${[...version.releaseDates][0]}`;
        } else if (version.releaseDates.size > 1) {
            pushDiagnostic(
                diagnostics,
                'conflicting-release-dates',
                'warning',
                `Release ${JSON.stringify(label)} has conflicting explicit dates, so its heading has no date.`,
                undefined,
                'CHANGELOG.md'
            );
        }
        sections.push(`## [${escapeMarkdownInline(label)}]${date}`);
        for (const category of CHANGE_CATEGORIES) {
            const entries = version.entries.filter((entry) => entry.categories.includes(category));
            if (entries.length === 0) {
                continue;
            }
            entries.sort((left, right) => compareText(left.annotation.sortKey, right.annotation.sortKey));
            sections.push(
                `### ${CHANGE_CATEGORY_TITLES[category]}\n\n${entries
                    .map((entry) => changelogBullet(entry, sourceRootDepth))
                    .join('\n')}`
            );
        }
    }
    return `${sections.join('\n\n')}\n`;
}

function adrStatuses(annotation: PreparedAnnotation, tagPrefix: string): string[] {
    return valuesForTagPrefixes(annotation, ['adr:status:', `${tagPrefix}adr:status:`]);
}

function createAdrPages(
    annotations: readonly PreparedAnnotation[],
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[]
): AdrPage[] {
    const selected = annotations.filter((annotation) => hasDocRole(annotation, tagPrefix, 'adr'));
    const used = new Map<string, string>();
    return selected.map((annotation) => {
        const fallback = slug(annotation.id) || `decision-${stableHash(annotation.sortKey)}`;
        const base = slug(annotation.title) || fallback;
        let fileName = `${base}.md`;
        const lower = fileName.toLowerCase();
        if (used.has(lower)) {
            const collidingPath = fileName;
            const suffix = stableHash(`${annotation.id}\u0000${annotation.sortKey}`);
            fileName = `${base}-${suffix}.md`;
            let counter = 2;
            while (used.has(fileName.toLowerCase())) {
                fileName = `${base}-${suffix}-${counter++}.md`;
            }
            pushDiagnostic(
                diagnostics,
                'adr-slug-collision',
                'warning',
                `ADR path ${JSON.stringify(collidingPath)} collided; a deterministic suffix was added.`,
                annotation.id,
                `technical/adr/${fileName}`
            );
        }
        used.set(fileName.toLowerCase(), annotation.id);
        return {
            annotation,
            fileName,
            path: `technical/adr/${fileName}`,
            statuses: adrStatuses(annotation, tagPrefix),
        };
    });
}

function renderAdrIndex(pages: readonly AdrPage[], tagPrefix: string, sourceRootDepth: number): string {
    const sections = ['# Architecture decision records'];
    if (pages.length === 0) {
        sections.push(`_No annotations tagged ${inlineCode(`${tagPrefix}adr`)} were provided._`);
        return `${sections.join('\n\n')}\n`;
    }
    const rows = pages.map((page) => {
        const titleLink = markdownLink(page.annotation.title, page.fileName);
        const statuses = page.statuses.length > 0 ? page.statuses.map(escapeTableCell).join(', ') : '—';
        const source = sourceReference(page.annotation, 'technical/adr/README.md', sourceRootDepth);
        return `| ${titleLink} | ${statuses} | ${source} |`;
    });
    sections.push(`| Decision | Status | Source |\n| --- | --- | --- |\n${rows.join('\n')}`);
    return `${sections.join('\n\n')}\n`;
}

function renderAdrPage(page: AdrPage, sourceRootDepth: number): string {
    const sections = [
        `# ${escapeMarkdownInline(page.annotation.title)}`,
        markdownLink('Architecture decision records', 'README.md'),
        renderMetadata(page.annotation, page.path, sourceRootDepth, 'adr'),
    ];
    if (page.statuses.length > 0) {
        sections.push(`Status: ${page.statuses.map(inlineCode).join(', ')}`);
    }
    const body = demoteBodyHeadings(page.annotation.body, 1);
    if (body) {
        sections.push(body);
    }
    if (page.annotation.snippet?.code) {
        sections.push(
            `**Code excerpt**\n\n${fencedCode(page.annotation.snippet.code, page.annotation.snippet.language)}`
        );
    }
    return `${sections.join('\n\n')}\n`;
}

function renderReadme(
    annotations: readonly PreparedAnnotation[],
    selectedKinds: ReadonlySet<TechnicalDocumentKind>,
    projectTitle: string | undefined,
    tagPrefix: string,
    diagnostics: TechnicalDocumentDiagnostic[],
    sourceRootDepth: number
): string {
    const authored = annotations.filter((annotation) => hasDocRole(annotation, tagPrefix, 'readme'));
    const cleanedProjectTitle = projectTitle === undefined ? '' : cleanScalar(projectTitle);
    if (projectTitle !== undefined && !cleanedProjectTitle) {
        pushDiagnostic(
            diagnostics,
            'invalid-project-title',
            'warning',
            'The empty project title was ignored.',
            undefined,
            'README.md'
        );
    }
    const title = cleanedProjectTitle || authored[0]?.title || 'Technical documentation';
    const sections = [`# ${escapeMarkdownInline(title)}`];

    authored.forEach((annotation, index) => {
        const usesRootHeading = !cleanedProjectTitle && index === 0 && annotation.title === title;
        if (usesRootHeading) {
            sections.push(renderMetadata(annotation, 'README.md', sourceRootDepth, 'readme'));
            const body = demoteBodyHeadings(annotation.body, 1);
            if (body) {
                sections.push(body);
            }
            if (annotation.snippet?.code) {
                sections.push(
                    `**Code excerpt**\n\n${fencedCode(annotation.snippet.code, annotation.snippet.language)}`
                );
            }
        } else {
            sections.push(renderAnnotationSection(annotation, 'README.md', 2, sourceRootDepth, 'readme'));
        }
    });
    if (authored.length === 0) {
        pushDiagnostic(
            diagnostics,
            'no-authored-content',
            'info',
            `No annotations use the explicit ${tagPrefix}readme role.`,
            undefined,
            'README.md'
        );
    }

    const links: Array<[string, string]> = [];
    if (selectedKinds.has('changelog')) {
        links.push(['Changelog', 'CHANGELOG.md']);
    }
    if (selectedKinds.has('architecture')) {
        links.push(['Architecture', 'technical/architecture.md']);
    }
    if (selectedKinds.has('onboarding')) {
        links.push(['Onboarding', 'technical/onboarding.md']);
    }
    if (selectedKinds.has('runbook')) {
        links.push(['Runbook', 'technical/runbook.md']);
    }
    if (selectedKinds.has('reference')) {
        links.push(['Technical reference', 'technical/reference.md']);
    }
    if (selectedKinds.has('adr')) {
        links.push(['Architecture decision records', 'technical/adr/README.md']);
    }
    if (links.length > 0) {
        sections.push(
            `## Generated documents\n\n${links.map(([label, path]) => `- ${markdownLink(label, path)}`).join('\n')}`
        );
    }
    return `${sections.join('\n\n')}\n`;
}

function selectedKinds(
    options: TechnicalDocumentOptions,
    diagnostics: TechnicalDocumentDiagnostic[]
): Set<TechnicalDocumentKind> {
    const selected = new Set<TechnicalDocumentKind>();
    const requested: readonly unknown[] = options.kinds ?? TECHNICAL_DOCUMENT_KINDS;
    for (const value of requested) {
        if (typeof value === 'string' && KIND_SET.has(value)) {
            selected.add(value as TechnicalDocumentKind);
        } else {
            pushDiagnostic(
                diagnostics,
                'unsupported-document-kind',
                'error',
                `Unsupported technical document kind ${JSON.stringify(value)} was ignored.`
            );
        }
    }
    return selected;
}

function sortedDiagnostics(diagnostics: TechnicalDocumentDiagnostic[]): TechnicalDocumentDiagnostic[] {
    const rank: Readonly<Record<TechnicalDocumentDiagnosticSeverity, number>> = { error: 0, warning: 1, info: 2 };
    return [...diagnostics].sort((left, right) => {
        const keys: Array<[string | number, string | number]> = [
            [rank[left.severity], rank[right.severity]],
            [left.code, right.code],
            [left.annotationId ?? '', right.annotationId ?? ''],
            [left.path ?? '', right.path ?? ''],
            [left.message, right.message],
        ];
        for (const [leftKey, rightKey] of keys) {
            const difference =
                typeof leftKey === 'number' && typeof rightKey === 'number'
                    ? leftKey - rightKey
                    : compareText(String(leftKey), String(rightKey));
            if (difference !== 0) {
                return difference;
            }
        }
        return 0;
    });
}

function normalizedSourceRootDepth(value: number | undefined, diagnostics: TechnicalDocumentDiagnostic[]): number {
    if (value === undefined) {
        return 0;
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 32) {
        pushDiagnostic(
            diagnostics,
            'invalid-source-root-depth',
            'error',
            'sourceRootDepth must be a safe integer between 0 and 32; 0 was used.'
        );
        return 0;
    }
    return value;
}

/**
 * Project annotation content into repository-native technical documents.
 *
 * The function is pure: it reads no files, clocks or environment variables.
 * Output paths are fixed or safe slugs, and annotation source paths are only
 * linked when they are workspace-relative and traversal-free.
 */
export function generateTechnicalDocuments(
    annotations: readonly DocAnnotation[],
    options: TechnicalDocumentOptions = {}
): TechnicalDocumentResult {
    const diagnostics: TechnicalDocumentDiagnostic[] = [];
    const kinds = selectedKinds(options, diagnostics);
    const tagPrefix = normalizeTagPrefix(options.tagPrefix, diagnostics);
    const sourceRootDepth = normalizedSourceRootDepth(options.sourceRootDepth, diagnostics);
    const prepared = prepareAnnotations(annotations, diagnostics);
    const files = new Map<string, string>();

    if (kinds.has('readme')) {
        files.set(
            'README.md',
            renderReadme(prepared, kinds, options.projectTitle, tagPrefix, diagnostics, sourceRootDepth)
        );
    }
    if (kinds.has('changelog')) {
        files.set('CHANGELOG.md', renderChangelog(prepared, tagPrefix, diagnostics, sourceRootDepth));
    }
    if (kinds.has('architecture')) {
        files.set(
            'technical/architecture.md',
            renderTaggedPage(
                prepared,
                'technical/architecture.md',
                'Architecture',
                'architecture',
                tagPrefix,
                diagnostics,
                sourceRootDepth
            )
        );
    }
    if (kinds.has('onboarding')) {
        files.set(
            'technical/onboarding.md',
            renderTaggedPage(
                prepared,
                'technical/onboarding.md',
                'Onboarding',
                'onboarding',
                tagPrefix,
                diagnostics,
                sourceRootDepth
            )
        );
    }
    if (kinds.has('runbook')) {
        files.set(
            'technical/runbook.md',
            renderTaggedPage(
                prepared,
                'technical/runbook.md',
                'Runbook',
                'runbook',
                tagPrefix,
                diagnostics,
                sourceRootDepth
            )
        );
    }
    if (kinds.has('reference')) {
        files.set('technical/reference.md', renderReference(prepared, tagPrefix, diagnostics, sourceRootDepth));
    }
    if (kinds.has('adr')) {
        const pages = createAdrPages(prepared, tagPrefix, diagnostics);
        files.set('technical/adr/README.md', renderAdrIndex(pages, tagPrefix, sourceRootDepth));
        for (const page of pages) {
            files.set(page.path, renderAdrPage(page, sourceRootDepth));
        }
    }

    return {
        files: new Map([...files.entries()].sort(([left], [right]) => compareText(left, right))),
        diagnostics: sortedDiagnostics(diagnostics),
    };
}
