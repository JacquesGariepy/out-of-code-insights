// SPDX-License-Identifier: MPL-2.0
//
// Pure aggregation over annotation records. No VS Code dependency, so the
// statistics dashboard, the report exporter and the unit tests all share the
// same numbers.

import type { AnnotationV2 } from '../transactional/types';

/** Minimal projection of an annotation that statistics need. */
export type StatisticsInput = Pick<
    AnnotationV2,
    'id' | 'file' | 'message' | 'timestamp' | 'author' | 'tags' | 'severity' | 'resolved' | 'state'
>;

export interface AnnotationFilter {
    /** Inclusive lower bound (ISO date or timestamp). */
    from?: string;
    /** Inclusive upper bound (ISO date or timestamp). A bare date covers the whole day. */
    to?: string;
    severities?: readonly string[];
    authors?: readonly string[];
    tags?: readonly string[];
    /** Case-insensitive substring of the workspace-relative path. */
    file?: string;
    resolved?: boolean;
}

export interface CountEntry {
    key: string;
    count: number;
}

export interface TrendPoint {
    /** UTC day, YYYY-MM-DD. */
    date: string;
    created: number;
    /** Cumulative number of annotations created up to and including this day. */
    total: number;
}

export interface AnnotationStatistics {
    total: number;
    resolved: number;
    open: number;
    /** resolved / total in [0, 1]; 0 when there are no annotations. */
    resolutionRate: number;
    bySeverity: CountEntry[];
    byAuthor: CountEntry[];
    byTag: CountEntry[];
    topFiles: CountEntry[];
    trend: TrendPoint[];
}

export const UNKNOWN_KEY = '(none)';
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function normalized(value: string | undefined): string {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : UNKNOWN_KEY;
}

function sortedEntries(counts: Map<string, number>, limit?: number): CountEntry[] {
    const entries = [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return limit === undefined ? entries : entries.slice(0, limit);
}

function bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function parseBound(value: string | undefined, endOfDay: boolean): number | undefined {
    if (!value) {
        return undefined;
    }
    const iso = DAY_ONLY.test(value) ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? undefined : time;
}

/** Keep only live annotations matching every populated filter field. */
export function filterAnnotations<T extends StatisticsInput>(items: readonly T[], filter: AnnotationFilter = {}): T[] {
    const from = parseBound(filter.from, false);
    const to = parseBound(filter.to, true);
    const severities = filter.severities?.map((s) => s.toLowerCase());
    const authors = filter.authors?.map((a) => a.toLowerCase());
    const tags = filter.tags?.map((t) => t.toLowerCase());
    const file = filter.file?.trim().toLowerCase();

    return items.filter((item) => {
        if (item.state === 'disposed') {
            return false;
        }
        const time = Date.parse(item.timestamp);
        if (from !== undefined && !(time >= from)) {
            return false;
        }
        if (to !== undefined && !(time <= to)) {
            return false;
        }
        if (severities?.length && !severities.includes(normalized(item.severity).toLowerCase())) {
            return false;
        }
        if (authors?.length && !authors.includes(normalized(item.author).toLowerCase())) {
            return false;
        }
        if (tags?.length && !(item.tags ?? []).some((tag) => tags.includes(tag.toLowerCase()))) {
            return false;
        }
        if (file && !item.file.toLowerCase().includes(file)) {
            return false;
        }
        if (filter.resolved !== undefined && Boolean(item.resolved) !== filter.resolved) {
            return false;
        }
        return true;
    });
}

/** Aggregate live annotations. `topFilesLimit` bounds the file ranking (default 10). */
export function computeStatistics(
    items: readonly StatisticsInput[],
    filter: AnnotationFilter = {},
    topFilesLimit = 10
): AnnotationStatistics {
    const live = filterAnnotations(items, filter);
    const bySeverity = new Map<string, number>();
    const byAuthor = new Map<string, number>();
    const byTag = new Map<string, number>();
    const byFile = new Map<string, number>();
    const byDay = new Map<string, number>();
    let resolved = 0;

    for (const item of live) {
        if (item.resolved) {
            resolved++;
        }
        bump(bySeverity, normalized(item.severity).toLowerCase());
        bump(byAuthor, normalized(item.author));
        bump(byFile, normalized(item.file));
        for (const tag of new Set((item.tags ?? []).map((t) => t.trim()).filter(Boolean))) {
            bump(byTag, tag);
        }
        const time = Date.parse(item.timestamp);
        if (!Number.isNaN(time)) {
            bump(byDay, new Date(time).toISOString().slice(0, 10));
        }
    }

    let running = 0;
    const trend = [...byDay.keys()].sort().map((date) => {
        const created = byDay.get(date) ?? 0;
        running += created;
        return { date, created, total: running };
    });

    const total = live.length;
    return {
        total,
        resolved,
        open: total - resolved,
        resolutionRate: total === 0 ? 0 : resolved / total,
        bySeverity: sortedEntries(bySeverity),
        byAuthor: sortedEntries(byAuthor),
        byTag: sortedEntries(byTag),
        topFiles: sortedEntries(byFile, topFilesLimit),
        trend,
    };
}

/**
 * Neutralise spreadsheet formula injection: a cell starting with `=`, `+`,
 * `-`, `@`, tab or CR is prefixed with an apostrophe before quoting.
 */
export function csvCell(value: unknown): string {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) {
        text = `'${text}`;
    }
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV of the filtered annotations (CRLF line endings). */
export function annotationsToCsv(items: readonly StatisticsInput[], filter: AnnotationFilter = {}): string {
    const header = ['id', 'file', 'severity', 'resolved', 'author', 'tags', 'created', 'message'];
    const rows = filterAnnotations(items, filter).map((item) =>
        [
            item.id,
            item.file,
            item.severity ?? '',
            item.resolved ? 'true' : 'false',
            item.author ?? '',
            (item.tags ?? []).join(';'),
            item.timestamp,
            item.message,
        ]
            .map(csvCell)
            .join(',')
    );
    return [header.join(','), ...rows].join('\r\n') + '\r\n';
}
