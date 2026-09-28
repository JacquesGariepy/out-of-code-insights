// SPDX-License-Identifier: MPL-2.0
//
// Structured Markdown and self-contained HTML reports over annotations,
// including the aggregate statistics. Pure functions: no VS Code, no I/O.

import { escapeHtml, markdownCodeSpan } from '../common/utils';
import {
    computeStatistics,
    filterAnnotations,
    type AnnotationFilter,
    type AnnotationStatistics,
    type CountEntry,
    type StatisticsInput,
} from './annotationStatistics';

export type ReportFormat = 'markdown' | 'html';

export interface ReportOptions {
    title?: string;
    filter?: AnnotationFilter;
    /** ISO timestamp shown in the header; injected for deterministic output. */
    generatedAt?: string;
    /** Cap on detailed annotation entries (statistics always cover everything). */
    maxEntries?: number;
}

const DEFAULT_TITLE = 'Annotation Report';
const DEFAULT_MAX_ENTRIES = 500;

const SEVERITY_RANK: Record<string, number> = { error: 0, warn: 1, warning: 1, info: 2 };

function severityRank(value: string | undefined): number {
    return SEVERITY_RANK[(value ?? '').toLowerCase()] ?? 3;
}

function sortForReport<T extends StatisticsInput>(items: readonly T[]): T[] {
    return [...items].sort(
        (a, b) =>
            Number(Boolean(a.resolved)) - Number(Boolean(b.resolved)) ||
            severityRank(a.severity) - severityRank(b.severity) ||
            a.file.localeCompare(b.file) ||
            a.timestamp.localeCompare(b.timestamp)
    );
}

function percent(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

function oneLine(text: string, max = 200): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Backslash-escape every Markdown metacharacter, backslash included, so text cannot break out of a cell or span. */
export function escapeMarkdownText(value: string): string {
    return value.replace(/[\\`*_{}[\]<>#|]/g, '\\$&');
}

function markdownTable(title: string, entries: readonly CountEntry[]): string[] {
    if (entries.length === 0) {
        return [];
    }
    return [
        `### ${title}`,
        '',
        '| Name | Count |',
        '| --- | ---: |',
        ...entries.map((e) => `| ${escapeMarkdownText(e.key)} | ${e.count} |`),
        '',
    ];
}

export function renderMarkdownReport(items: readonly StatisticsInput[], options: ReportOptions = {}): string {
    const { title = DEFAULT_TITLE, filter = {}, generatedAt, maxEntries = DEFAULT_MAX_ENTRIES } = options;
    const stats = computeStatistics(items, filter);
    const detailed = sortForReport(filterAnnotations(items, filter));
    const shown = detailed.slice(0, maxEntries);

    const out: string[] = [`# ${title.replace(/[\r\n]+/g, ' ')}`, ''];
    if (generatedAt) {
        out.push(`_Generated ${generatedAt}_`, '');
    }
    out.push(
        '## Summary',
        '',
        `- Total: **${stats.total}**`,
        `- Open: **${stats.open}**`,
        `- Resolved: **${stats.resolved}** (${percent(stats.resolutionRate)})`,
        ''
    );
    out.push(...markdownTable('By severity', stats.bySeverity));
    out.push(...markdownTable('By author', stats.byAuthor));
    out.push(...markdownTable('By tag', stats.byTag));
    out.push(...markdownTable('Most annotated files', stats.topFiles));

    out.push('## Annotations', '');
    if (shown.length === 0) {
        out.push('_No annotations match the current filters._', '');
    }
    for (const item of shown) {
        const box = item.resolved ? '[x]' : '[ ]';
        const meta = [item.severity, item.author, item.timestamp.slice(0, 10)].filter(Boolean).join(' · ');
        out.push(`- ${box} ${markdownCodeSpan(item.file)}${meta ? ` (${meta})` : ''}`);
        out.push(`  ${escapeMarkdownText(oneLine(item.message))}`);
    }
    if (detailed.length > shown.length) {
        out.push('', `_${detailed.length - shown.length} more annotation(s) omitted from this listing._`);
    }
    return out.join('\n') + '\n';
}

const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

function htmlTable(title: string, entries: readonly CountEntry[]): string {
    if (entries.length === 0) {
        return '';
    }
    const rows = entries.map((e) => `<tr><td>${escapeHtml(e.key)}</td><td class="n">${e.count}</td></tr>`).join('');
    return `<section><h3>${escapeHtml(title)}</h3><table><thead><tr><th>Name</th><th class="n">Count</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function renderHtmlReport(items: readonly StatisticsInput[], options: ReportOptions = {}): string {
    const { title = DEFAULT_TITLE, filter = {}, generatedAt, maxEntries = DEFAULT_MAX_ENTRIES } = options;
    const stats: AnnotationStatistics = computeStatistics(items, filter);
    const detailed = sortForReport(filterAnnotations(items, filter));
    const shown = detailed.slice(0, maxEntries);

    const entries = shown
        .map(
            (item) =>
                `<li class="${item.resolved ? 'done' : 'open'}"><code>${escapeHtml(item.file)}</code> ` +
                `<span class="meta">${escapeHtml([item.severity, item.author, item.timestamp.slice(0, 10)].filter(Boolean).join(' · '))}</span>` +
                `<p>${escapeHtml(oneLine(item.message, 400))}</p></li>`
        )
        .join('');
    const omitted =
        detailed.length > shown.length
            ? `<p class="meta">${detailed.length - shown.length} more annotation(s) omitted from this listing.</p>`
            : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(REPORT_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--accent:#4493f8}}
body{font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:60rem;margin:2rem auto;padding:0 1rem}
h1{border-bottom:1px solid var(--line);padding-bottom:.3rem}
.cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
.card{border:1px solid var(--line);border-radius:8px;padding:.75rem 1.25rem}
.card b{display:block;font-size:1.75rem;color:var(--accent)}
table{border-collapse:collapse;min-width:18rem}
th,td{border-bottom:1px solid var(--line);padding:.3rem .8rem;text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1.5rem}
ul{list-style:none;padding:0}
li{border-left:4px solid var(--accent);padding:.1rem 0 .1rem .8rem;margin:.8rem 0}
li.done{opacity:.6;border-left-color:var(--muted)}
li p{margin:.2rem 0}
.meta{color:var(--muted);font-size:.875rem}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${generatedAt ? `<p class="meta">Generated ${escapeHtml(generatedAt)}</p>` : ''}
<div class="cards">
<div class="card"><b>${stats.total}</b>Total</div>
<div class="card"><b>${stats.open}</b>Open</div>
<div class="card"><b>${stats.resolved}</b>Resolved</div>
<div class="card"><b>${escapeHtml(percent(stats.resolutionRate))}</b>Resolution rate</div>
</div>
<div class="grid">${htmlTable('By severity', stats.bySeverity)}${htmlTable('By author', stats.byAuthor)}${htmlTable('By tag', stats.byTag)}${htmlTable('Most annotated files', stats.topFiles)}</div>
<h2>Annotations</h2>
${entries ? `<ul>${entries}</ul>` : '<p class="meta">No annotations match the current filters.</p>'}
${omitted}
</body>
</html>
`;
}

export function renderReport(items: readonly StatisticsInput[], format: ReportFormat, options?: ReportOptions): string {
    return format === 'html' ? renderHtmlReport(items, options) : renderMarkdownReport(items, options);
}
