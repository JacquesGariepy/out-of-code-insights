// SPDX-License-Identifier: MPL-2.0
//
// Pure mapping from language-server diagnostics to annotation drafts.
// Numeric severities mirror `vscode.DiagnosticSeverity` (Error = 0,
// Warning = 1, Information = 2, Hint = 3) so this module needs no VS Code
// import and stays unit-testable.

export const DIAGNOSTIC_SEVERITY = { error: 0, warning: 1, information: 2, hint: 3 } as const;

export type DiagnosticMinSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface DiagnosticLike {
    /** Zero-based line of the start of the diagnostic range. */
    line: number;
    severity: number;
    message: string;
    source?: string;
    code?: string | number;
}

export interface DiagnosticAnnotationDraft {
    line: number;
    message: string;
    severity: 'error' | 'warn' | 'info';
    tags: string[];
    /** Stable key used to avoid re-importing the same diagnostic. */
    dedupeKey: string;
}

/** Tag every imported annotation carries, so imports can be found and cleaned up. */
export const DIAGNOSTIC_IMPORT_TAG = 'imported-diagnostic';

/** Default source → extra tag mapping. Users can extend it in settings. */
export const DEFAULT_SOURCE_TAGS: Readonly<Record<string, string>> = {
    eslint: 'style',
    tslint: 'style',
    stylelint: 'style',
    pylint: 'style',
    flake8: 'style',
    ruff: 'style',
    prettier: 'style',
    ts: 'types',
    typescript: 'types',
    pyright: 'types',
    mypy: 'types',
    bandit: 'security',
    semgrep: 'security',
    snyk: 'security',
    codeql: 'security',
    sonarlint: 'quality',
    sonarqube: 'quality',
    clippy: 'quality',
    gopls: 'quality',
};

const MAX_MESSAGE_LENGTH = 2000;

function severityLabel(severity: number): DiagnosticAnnotationDraft['severity'] {
    if (severity <= DIAGNOSTIC_SEVERITY.error) {
        return 'error';
    }
    return severity === DIAGNOSTIC_SEVERITY.warning ? 'warn' : 'info';
}

/** Lower-cased, trimmed source name; `undefined` when absent. */
function normalizedSource(source: string | undefined): string | undefined {
    const value = source?.trim().toLowerCase();
    return value ? value : undefined;
}

/** Slug safe for a tag: lower-case, `[a-z0-9._-]`, no leading/trailing separators. */
export function tagSlug(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '');
}

/** Resolve a user-facing tag for a source, honouring user overrides first. */
export function tagForSource(
    source: string | undefined,
    overrides: Readonly<Record<string, string>> = {}
): string | undefined {
    const name = normalizedSource(source);
    if (!name) {
        return undefined;
    }
    const lowered = Object.fromEntries(Object.entries(overrides).map(([key, tag]) => [key.trim().toLowerCase(), tag]));
    const mapped = lowered[name] ?? DEFAULT_SOURCE_TAGS[name];
    const slug = mapped ? tagSlug(mapped) : '';
    return slug.length > 0 ? slug : undefined;
}

export function diagnosticDedupeKey(diagnostic: DiagnosticLike): string {
    return [
        normalizedSource(diagnostic.source) ?? '',
        diagnostic.code === undefined ? '' : String(diagnostic.code),
        diagnostic.line,
        diagnostic.message.trim(),
    ].join('\u0000');
}

/**
 * Convert diagnostics into drafts.
 *
 * - Diagnostics less severe than `minSeverity` are dropped (default: warning).
 * - Duplicates (same source, code, line, message) collapse to one draft.
 * - Only the first `limit` drafts are returned, most severe first.
 */
export function draftsFromDiagnostics(
    diagnostics: readonly DiagnosticLike[],
    options: {
        minSeverity?: DiagnosticMinSeverity;
        sourceTags?: Readonly<Record<string, string>>;
        limit?: number;
    } = {}
): DiagnosticAnnotationDraft[] {
    const threshold = DIAGNOSTIC_SEVERITY[options.minSeverity ?? 'warning'];
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    const drafts: DiagnosticAnnotationDraft[] = [];

    for (const diagnostic of diagnostics) {
        if (diagnostic.severity > threshold || diagnostic.line < 0) {
            continue;
        }
        const message = diagnostic.message.trim();
        if (message.length === 0) {
            continue;
        }
        const dedupeKey = diagnosticDedupeKey(diagnostic);
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);

        const source = normalizedSource(diagnostic.source);
        const prefix = [diagnostic.source?.trim(), diagnostic.code === undefined ? undefined : String(diagnostic.code)]
            .filter((part): part is string => Boolean(part))
            .join(' ');
        const body = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : message;
        const tags = [DIAGNOSTIC_IMPORT_TAG];
        const sourceTag = tagForSource(source, options.sourceTags);
        if (sourceTag) {
            tags.push(sourceTag);
        }
        const sourceSlug = source ? tagSlug(source) : '';
        if (sourceSlug && !tags.includes(sourceSlug)) {
            tags.push(sourceSlug);
        }
        drafts.push({
            line: diagnostic.line,
            message: prefix ? `[${prefix}] ${body}` : body,
            severity: severityLabel(diagnostic.severity),
            tags,
            dedupeKey,
        });
    }

    drafts.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity) || a.line - b.line);
    return drafts.slice(0, limit);
}

function severityOrder(severity: DiagnosticAnnotationDraft['severity']): number {
    return severity === 'error' ? 0 : severity === 'warn' ? 1 : 2;
}
