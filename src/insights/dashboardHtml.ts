// SPDX-License-Identifier: MPL-2.0
//
// Server-rendered HTML for the statistics dashboard webview. Charts are
// inline SVG (no third-party library, nothing to fetch). The only script is a
// nonce-guarded handler that posts filter changes and export requests back to
// the extension host. All annotation-derived text is escaped.

import { escapeHtml } from '../common/utils';
import type { AnnotationFilter, AnnotationStatistics, CountEntry } from './annotationStatistics';

export interface DashboardFilterState {
    severity: string;
    status: 'all' | 'open' | 'resolved';
}

export interface DashboardStrings {
    title: string;
    total: string;
    open: string;
    resolved: string;
    resolutionRate: string;
    bySeverity: string;
    byAuthor: string;
    byTag: string;
    topFiles: string;
    trend: string;
    empty: string;
    exportCsv: string;
    exportReport: string;
    severityFilter: string;
    statusFilter: string;
    all: string;
    statusOpen: string;
    statusResolved: string;
}

export const DEFAULT_DASHBOARD_STRINGS: DashboardStrings = {
    title: 'Annotation Statistics',
    total: 'Total',
    open: 'Open',
    resolved: 'Resolved',
    resolutionRate: 'Resolution rate',
    bySeverity: 'By severity',
    byAuthor: 'By author',
    byTag: 'By tag',
    topFiles: 'Most annotated files',
    trend: 'Cumulative annotations',
    empty: 'No annotations yet.',
    exportCsv: 'Export CSV',
    exportReport: 'Export report',
    severityFilter: 'Severity',
    statusFilter: 'Status',
    all: 'All',
    statusOpen: 'Open',
    statusResolved: 'Resolved',
};

const DASHBOARD_MESSAGE_LIMIT = 40;

/** Translate the dashboard filter state into a store-level filter. */
export function dashboardFilterToAnnotationFilter(state: DashboardFilterState): AnnotationFilter {
    return {
        severities: state.severity === 'all' ? undefined : [state.severity],
        resolved: state.status === 'all' ? undefined : state.status === 'resolved',
    };
}

/** Validate an untrusted webview message. Returns undefined when it is not a legitimate request. */
export function parseDashboardMessage(
    value: unknown
): { command: 'exportCsv' | 'exportReport' } | { command: 'setFilter'; state: DashboardFilterState } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const message = value as Record<string, unknown>;
    const command = message.command;
    if (typeof command !== 'string' || command.length > DASHBOARD_MESSAGE_LIMIT) {
        return undefined;
    }
    if (command === 'exportCsv' || command === 'exportReport') {
        return { command };
    }
    if (command === 'setFilter') {
        const { severity, status } = message;
        if (
            typeof severity === 'string' &&
            severity.length > 0 &&
            severity.length <= 64 &&
            (status === 'all' || status === 'open' || status === 'resolved')
        ) {
            return { command, state: { severity: severity.toLowerCase(), status } };
        }
    }
    return undefined;
}

/** Bar widths are emitted as classes (`w42`) because CSP forbids inline style attributes. */
function barChart(entries: readonly CountEntry[], empty: string, widths: Set<number>): string {
    if (entries.length === 0) {
        return `<p class="muted">${escapeHtml(empty)}</p>`;
    }
    const max = Math.max(...entries.map((e) => e.count));
    return `<ul class="bars">${entries
        .map((e) => {
            const width = max === 0 ? 0 : Math.max(2, Math.round((e.count / max) * 100));
            widths.add(width);
            return `<li><span class="label" title="${escapeHtml(e.key)}">${escapeHtml(e.key)}</span><span class="track"><span class="fill w${width}"></span></span><span class="value">${e.count}</span></li>`;
        })
        .join('')}</ul>`;
}

/** Cumulative line chart. Returns an accessible SVG, or a note when there is no data. */
export function trendSvg(trend: AnnotationStatistics['trend'], label: string): string {
    if (trend.length === 0) {
        return '';
    }
    const width = 480;
    const height = 140;
    const pad = 8;
    const maxTotal = Math.max(...trend.map((p) => p.total), 1);
    const step = trend.length > 1 ? (width - 2 * pad) / (trend.length - 1) : 0;
    const points = trend.map((p, i) => {
        const x = trend.length > 1 ? pad + i * step : width / 2;
        const y = height - pad - (p.total / maxTotal) * (height - 2 * pad);
        return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, p };
    });
    const line = points.map((pt) => `${pt.x},${pt.y}`).join(' ');
    const first = trend[0].date;
    const last = trend[trend.length - 1].date;
    return `<svg role="img" aria-label="${escapeHtml(`${label}: ${first} to ${last}, ${trend[trend.length - 1].total}`)}" viewBox="0 0 ${width} ${height}" class="trend">
<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
${points.map((pt) => `<circle cx="${pt.x}" cy="${pt.y}" r="3" fill="var(--accent)"><title>${escapeHtml(`${pt.p.date}: ${pt.p.total}`)}</title></circle>`).join('')}
</svg><p class="muted">${escapeHtml(first)} → ${escapeHtml(last)}</p>`;
}

export function renderDashboardHtml(
    stats: AnnotationStatistics,
    options: {
        nonce: string;
        cspSource: string;
        filter: DashboardFilterState;
        severities: readonly string[];
        strings?: DashboardStrings;
    }
): string {
    const s = options.strings ?? DEFAULT_DASHBOARD_STRINGS;
    const widths = new Set<number>();
    const sections = [
        [s.bySeverity, barChart(stats.bySeverity, s.empty, widths)],
        [s.byAuthor, barChart(stats.byAuthor, s.empty, widths)],
        [s.byTag, barChart(stats.byTag.slice(0, 10), s.empty, widths)],
        [s.topFiles, barChart(stats.topFiles, s.empty, widths)],
        [s.trend, trendSvg(stats.trend, s.trend)],
    ]
        .map(([heading, body]) => `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`)
        .join('\n');
    const widthRules = [...widths]
        .sort((a, b) => a - b)
        .map((w) => `.w${w}{width:${w}%}`)
        .join('');
    const csp = `default-src 'none'; style-src 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';`;
    const severityOptions = ['all', ...options.severities]
        .map((value) => {
            const label = value === 'all' ? s.all : value;
            return `<option value="${escapeHtml(value)}"${value === options.filter.severity ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        })
        .join('');
    const statusOptions = (
        [
            ['all', s.all],
            ['open', s.statusOpen],
            ['resolved', s.statusResolved],
        ] as const
    )
        .map(
            ([value, label]) =>
                `<option value="${value}"${value === options.filter.status ? ' selected' : ''}>${escapeHtml(label)}</option>`
        )
        .join('');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.title)}</title>
<style nonce="${options.nonce}">
:root{--accent:var(--vscode-charts-blue,#3794ff);--line:var(--vscode-panel-border,#8884);--muted:var(--vscode-descriptionForeground,#888)}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:1rem 1.5rem;max-width:64rem}
h1{font-size:1.4rem;margin:0 0 1rem}
h2{font-size:1rem;margin:0 0 .5rem}
.toolbar{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-bottom:1rem}
.toolbar label{display:flex;gap:.4rem;align-items:center}
select,button{font:inherit;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border,var(--line));padding:.2rem .5rem}
button{cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-color:transparent}
button:hover{background:var(--vscode-button-hoverBackground)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.75rem;margin-bottom:1.25rem}
.card{border:1px solid var(--line);border-radius:6px;padding:.6rem .9rem}
.card b{display:block;font-size:1.6rem;color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(20rem,1fr));gap:1.25rem}
section{border:1px solid var(--line);border-radius:6px;padding:.75rem 1rem}
.bars{list-style:none;margin:0;padding:0}
.bars li{display:grid;grid-template-columns:minmax(4rem,9rem) 1fr 2.5rem;gap:.5rem;align-items:center;margin:.25rem 0}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{background:var(--line);border-radius:3px;height:.6rem;display:block}
.fill{background:var(--accent);border-radius:3px;height:100%;display:block}
.value{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--muted);font-size:.85rem;margin:.25rem 0}
.trend{width:100%;height:auto}
${widthRules}
</style>
</head>
<body>
<h1>${escapeHtml(s.title)}</h1>
<div class="toolbar">
<label>${escapeHtml(s.severityFilter)} <select id="severity">${severityOptions}</select></label>
<label>${escapeHtml(s.statusFilter)} <select id="status">${statusOptions}</select></label>
<button id="exportCsv" type="button">${escapeHtml(s.exportCsv)}</button>
<button id="exportReport" type="button">${escapeHtml(s.exportReport)}</button>
</div>
${
    stats.total === 0
        ? `<p class="muted">${escapeHtml(s.empty)}</p>`
        : `<div class="cards">
<div class="card"><b>${stats.total}</b>${escapeHtml(s.total)}</div>
<div class="card"><b>${stats.open}</b>${escapeHtml(s.open)}</div>
<div class="card"><b>${stats.resolved}</b>${escapeHtml(s.resolved)}</div>
<div class="card"><b>${escapeHtml((stats.resolutionRate * 100).toFixed(0))}%</b>${escapeHtml(s.resolutionRate)}</div>
</div>
<div class="grid">
${sections}
</div>`
}
<script nonce="${options.nonce}">
const vscode = acquireVsCodeApi();
const send = (command, extra) => vscode.postMessage(Object.assign({ command }, extra));
const sev = document.getElementById('severity');
const status = document.getElementById('status');
const filter = () => send('setFilter', { severity: sev.value, status: status.value });
sev.addEventListener('change', filter);
status.addEventListener('change', filter);
document.getElementById('exportCsv').addEventListener('click', () => send('exportCsv'));
document.getElementById('exportReport').addEventListener('click', () => send('exportReport'));
</script>
</body>
</html>
`;
}
