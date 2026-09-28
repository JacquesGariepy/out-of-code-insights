// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { escapeMarkdownText, renderHtmlReport, renderMarkdownReport } from '../annotationReport';
import {
    annotationsToCsv,
    computeStatistics,
    csvCell,
    filterAnnotations,
    type StatisticsInput,
} from '../annotationStatistics';
import {
    dashboardFilterToAnnotationFilter,
    parseDashboardMessage,
    renderDashboardHtml,
    shortPath,
    trendSvg,
} from '../dashboardHtml';
import { DIAGNOSTIC_IMPORT_TAG, draftsFromDiagnostics, tagForSource, tagSlug } from '../diagnosticImport';

function ann(partial: Partial<StatisticsInput> & { id: string }): StatisticsInput {
    return {
        file: 'src/a.ts',
        message: 'note',
        timestamp: '2026-01-01T10:00:00.000Z',
        state: 'active',
        ...partial,
    };
}

const SAMPLE: StatisticsInput[] = [
    ann({ id: '1', severity: 'error', author: 'ana', tags: ['security', 'bug'], resolved: true }),
    ann({
        id: '2',
        severity: 'warn',
        author: 'ana',
        tags: ['bug'],
        file: 'src/b.ts',
        timestamp: '2026-01-02T09:00:00Z',
    }),
    ann({ id: '3', severity: 'info', author: 'bob', file: 'src/b.ts', timestamp: '2026-01-02T20:00:00Z' }),
    ann({ id: '4', file: 'src/b.ts', timestamp: '2026-01-05T00:00:00Z' }),
    ann({ id: '5', state: 'disposed' }),
];

suite('annotationStatistics', () => {
    test('aggregates live annotations and ignores disposed ones', () => {
        const stats = computeStatistics(SAMPLE);
        assert.strictEqual(stats.total, 4);
        assert.strictEqual(stats.resolved, 1);
        assert.strictEqual(stats.open, 3);
        assert.strictEqual(stats.resolutionRate, 0.25);
        assert.deepStrictEqual(stats.topFiles[0], { key: 'src/b.ts', count: 3 });
        assert.deepStrictEqual(stats.byTag, [
            { key: 'bug', count: 2 },
            { key: 'security', count: 1 },
        ]);
        assert.ok(stats.bySeverity.some((e) => e.key === '(none)' && e.count === 1));
    });

    test('builds a cumulative daily trend', () => {
        const trend = computeStatistics(SAMPLE).trend;
        assert.deepStrictEqual(trend, [
            { date: '2026-01-01', created: 1, total: 1 },
            { date: '2026-01-02', created: 2, total: 3 },
            { date: '2026-01-05', created: 1, total: 4 },
        ]);
    });

    test('handles the empty set without dividing by zero', () => {
        const stats = computeStatistics([]);
        assert.strictEqual(stats.total, 0);
        assert.strictEqual(stats.resolutionRate, 0);
        assert.deepStrictEqual(stats.trend, []);
    });

    test('filters by inclusive whole-day date bounds', () => {
        const ids = filterAnnotations(SAMPLE, { from: '2026-01-02', to: '2026-01-02' }).map((a) => a.id);
        assert.deepStrictEqual(ids, ['2', '3']);
    });

    test('filters by severity, author, tag, file and resolved (case-insensitive)', () => {
        assert.deepStrictEqual(
            filterAnnotations(SAMPLE, { severities: ['ERROR'] }).map((a) => a.id),
            ['1']
        );
        assert.deepStrictEqual(
            filterAnnotations(SAMPLE, { authors: ['BOB'] }).map((a) => a.id),
            ['3']
        );
        assert.deepStrictEqual(
            filterAnnotations(SAMPLE, { tags: ['Bug'] }).map((a) => a.id),
            ['1', '2']
        );
        assert.deepStrictEqual(
            filterAnnotations(SAMPLE, { file: 'B.TS' }).map((a) => a.id),
            ['2', '3', '4']
        );
        assert.deepStrictEqual(
            filterAnnotations(SAMPLE, { resolved: true }).map((a) => a.id),
            ['1']
        );
    });

    test('respects topFilesLimit', () => {
        assert.strictEqual(computeStatistics(SAMPLE, {}, 1).topFiles.length, 1);
    });
});

suite('CSV export', () => {
    test('quotes commas, quotes and newlines', () => {
        assert.strictEqual(csvCell('a,b'), '"a,b"');
        assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
        assert.strictEqual(csvCell('l1\nl2'), '"l1\nl2"');
    });

    test('neutralises spreadsheet formula injection', () => {
        for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx']) {
            assert.ok(csvCell(bad).startsWith("'"), bad);
        }
        assert.strictEqual(csvCell('safe'), 'safe');
    });

    test('emits a header and one CRLF-terminated row per live annotation', () => {
        const csv = annotationsToCsv([ann({ id: 'x', message: '=cmd()', tags: ['a', 'b'] })]);
        const lines = csv.split('\r\n');
        assert.strictEqual(lines[0], 'id,file,severity,resolved,author,tags,created,message');
        assert.ok(lines[1].endsWith(",'=cmd()"), 'formula is defused with a leading apostrophe');
        assert.ok(lines[1].includes('a;b'));
        assert.strictEqual(lines[2], '');
    });
});

suite('annotationReport', () => {
    const hostile = ann({ id: 'h', file: 'a<b>.ts', message: '<script>alert(1)</script> | `x`', author: '"><img>' });

    test('markdown report summarises and escapes untrusted text', () => {
        const md = renderMarkdownReport([...SAMPLE, hostile], { generatedAt: '2026-02-01T00:00:00Z' });
        assert.ok(md.startsWith('# Annotation Report'));
        assert.ok(md.includes('Total: **5**'));
        assert.ok(md.includes('_Generated 2026-02-01T00:00:00Z_'));
        assert.ok(!md.includes('<script>'));
    });

    test('html report escapes untrusted text and forbids scripts via CSP', () => {
        const html = renderHtmlReport([hostile]);
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(html.includes('default-src &#039;none&#039;'));
        assert.ok(!/<script/i.test(html));
    });

    test('escapes backslashes and pipes so a cell cannot be broken out of', () => {
        assert.strictEqual(escapeMarkdownText('a\\|b'), 'a\\\\\\|b');
        const md = renderMarkdownReport([ann({ id: 'p', file: 'dir\\|x.ts' })]);
        assert.ok(md.includes('| dir\\\\\\|x.ts | 1 |'));
        assert.ok(!md.includes('| dir\\|x.ts'));
    });

    test('caps detailed entries but keeps totals', () => {
        const many = Array.from({ length: 5 }, (_, i) => ann({ id: String(i), message: `m${i}` }));
        const md = renderMarkdownReport(many, { maxEntries: 2 });
        assert.ok(md.includes('Total: **5**'));
        assert.ok(md.includes('3 more annotation(s) omitted'));
    });

    test('reports respect filters', () => {
        const md = renderMarkdownReport(SAMPLE, { filter: { severities: ['error'] } });
        assert.ok(md.includes('Total: **1**'));
    });

    test('empty report says so', () => {
        assert.ok(renderMarkdownReport([]).includes('No annotations match'));
        assert.ok(renderHtmlReport([]).includes('No annotations match'));
    });
});

suite('diagnosticImport', () => {
    const diag = (over: Partial<Parameters<typeof draftsFromDiagnostics>[0][number]> = {}) => ({
        line: 3,
        severity: 1,
        message: 'Unexpected any',
        source: 'eslint',
        code: 'no-explicit-any',
        ...over,
    });

    test('maps severity, tags and prefixes source and code', () => {
        const [draft] = draftsFromDiagnostics([diag()]);
        assert.strictEqual(draft.severity, 'warn');
        assert.strictEqual(draft.message, '[eslint no-explicit-any] Unexpected any');
        assert.deepStrictEqual(draft.tags, [DIAGNOSTIC_IMPORT_TAG, 'style', 'eslint']);
    });

    test('drops diagnostics below the minimum severity', () => {
        const input = [diag({ severity: 0 }), diag({ severity: 1, line: 4 }), diag({ severity: 2, line: 5 })];
        assert.strictEqual(draftsFromDiagnostics(input).length, 2);
        assert.strictEqual(draftsFromDiagnostics(input, { minSeverity: 'error' }).length, 1);
        assert.strictEqual(draftsFromDiagnostics(input, { minSeverity: 'information' }).length, 3);
    });

    test('collapses duplicates and orders most severe first', () => {
        const drafts = draftsFromDiagnostics([
            diag({ line: 9, severity: 1 }),
            diag({ line: 9, severity: 1 }),
            diag({ line: 20, severity: 0, message: 'boom' }),
        ]);
        assert.strictEqual(drafts.length, 2);
        assert.strictEqual(drafts[0].severity, 'error');
    });

    test('honours limit, skips blank messages and negative lines', () => {
        const input = [
            diag({ message: '  ' }),
            diag({ line: -1 }),
            diag({ line: 1 }),
            diag({ line: 2, message: 'other' }),
        ];
        assert.strictEqual(draftsFromDiagnostics(input, { limit: 1 }).length, 1);
        assert.strictEqual(draftsFromDiagnostics(input).length, 2);
    });

    test('user source tags override defaults and are sanitised', () => {
        assert.strictEqual(tagForSource('ESLint', { eslint: 'Lint Rules!' }), 'lint-rules');
        assert.strictEqual(tagForSource('bandit'), 'security');
        assert.strictEqual(tagForSource('unknown-tool'), undefined);
        assert.strictEqual(tagForSource(undefined), undefined);
        assert.strictEqual(tagSlug('  Weird Tag/Name  '), 'weird-tag-name');
    });

    test('truncates oversized messages', () => {
        const [draft] = draftsFromDiagnostics([
            diag({ message: 'x'.repeat(5000), source: undefined, code: undefined }),
        ]);
        assert.ok(draft.message.length <= 2000);
    });
});

suite('dashboardHtml', () => {
    const stats = computeStatistics([
        ann({ id: '1', severity: 'error', author: '<b>eve</b>', tags: ['x'], file: 'src/"quoted".ts' }),
        ann({ id: '2', severity: 'info', resolved: true, timestamp: '2026-01-03T00:00:00Z' }),
    ]);
    const render = () =>
        renderDashboardHtml(stats, {
            nonce: 'NONCE123',
            cspSource: 'vscode-webview://x',
            filter: { severity: 'all', status: 'all' },
            severities: ['error', 'info'],
        });

    test('locks the page down with a nonce-only CSP and no inline styles or handlers', () => {
        const html = render();
        assert.ok(html.includes("default-src 'none'; style-src 'nonce-NONCE123'; script-src 'nonce-NONCE123';"));
        assert.ok(!/\sstyle="/.test(html), 'inline style attributes are blocked by the CSP');
        const scriptStart = html.indexOf('<script');
        const scriptEnd = html.indexOf('</script>');
        assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'exactly one nonce-guarded script block');
        assert.strictEqual(html.indexOf('<script', scriptStart + 1), -1, 'a single script element');
        const markup = html.slice(0, scriptStart) + html.slice(scriptEnd + '</script>'.length);
        assert.ok(!/\son[a-z]+=/i.test(markup), 'no inline event handlers');
    });

    test('escapes annotation-derived text', () => {
        const html = render();
        assert.ok(!html.includes('<b>eve</b>'));
        assert.ok(html.includes('&lt;b&gt;eve&lt;/b&gt;'));
    });

    test('emits a width class for every bar and the totals', () => {
        const html = render();
        assert.ok(/class="fill w\d+"/.test(html));
        assert.ok(/\.w100\{width:100%\}/.test(html));
        assert.ok(html.includes('<b>2</b>Total'));
        assert.ok(html.includes('<b>50</b>%') || html.includes('50%'));
    });

    test('renders a friendly empty state', () => {
        const html = renderDashboardHtml(computeStatistics([]), {
            nonce: 'n',
            cspSource: 'x',
            filter: { severity: 'all', status: 'all' },
            severities: [],
        });
        assert.ok(html.includes('No annotations yet.'));
        assert.ok(!html.includes('class="cards"'));
    });

    test('shortens file paths to their file name', () => {
        assert.strictEqual(shortPath('a.ts'), 'a.ts');
        assert.strictEqual(shortPath('src/managers/AnnotationManager.ts'), 'AnnotationManager.ts');
        assert.strictEqual(shortPath('(none)'), '(none)');
    });

    test('trendSvg handles a single day and empty input', () => {
        assert.strictEqual(trendSvg([], 'x'), '');
        assert.ok(trendSvg([{ date: '2026-01-01', created: 1, total: 1 }], 'x').includes('<circle'));
    });

    test('accepts only well-formed webview messages', () => {
        assert.deepStrictEqual(parseDashboardMessage({ command: 'exportCsv' }), { command: 'exportCsv' });
        assert.deepStrictEqual(parseDashboardMessage({ command: 'exportReport' }), { command: 'exportReport' });
        assert.deepStrictEqual(parseDashboardMessage({ command: 'setFilter', severity: 'ERROR', status: 'open' }), {
            command: 'setFilter',
            state: { severity: 'error', status: 'open' },
        });
        for (const bad of [
            null,
            [],
            'exportCsv',
            {},
            { command: 'rm -rf' },
            { command: 'setFilter', severity: '', status: 'open' },
            { command: 'setFilter', severity: 'x', status: 'nope' },
            { command: 'setFilter', severity: 'x'.repeat(65), status: 'all' },
            { command: 'x'.repeat(41) },
        ]) {
            assert.strictEqual(parseDashboardMessage(bad), undefined, JSON.stringify(bad));
        }
    });

    test('maps dashboard filter state to a store filter', () => {
        assert.deepStrictEqual(dashboardFilterToAnnotationFilter({ severity: 'all', status: 'all' }), {
            severities: undefined,
            resolved: undefined,
        });
        assert.deepStrictEqual(dashboardFilterToAnnotationFilter({ severity: 'warn', status: 'resolved' }), {
            severities: ['warn'],
            resolved: true,
        });
    });
});
