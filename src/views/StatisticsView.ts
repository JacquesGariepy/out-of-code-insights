// SPDX-License-Identifier: MPL-2.0
import * as vscode from 'vscode';
import { generateNonce } from '../common/utils';
import { localize } from '../common/localize';
import {
    DEFAULT_DASHBOARD_STRINGS,
    dashboardFilterToAnnotationFilter,
    parseDashboardMessage,
    renderDashboardHtml,
    type DashboardFilterState,
    type DashboardStrings,
} from '../insights/dashboardHtml';
import { computeStatistics } from '../insights/annotationStatistics';
import type { AnnotationStore } from '../transactional/AnnotationStore';

const REFRESH_DEBOUNCE_MS = 250;

function dashboardStrings(): DashboardStrings {
    const d = DEFAULT_DASHBOARD_STRINGS;
    return {
        title: localize('stats.title', d.title),
        total: localize('stats.total', d.total),
        open: localize('stats.open', d.open),
        resolved: localize('stats.resolved', d.resolved),
        resolutionRate: localize('stats.resolutionRate', d.resolutionRate),
        bySeverity: localize('stats.bySeverity', d.bySeverity),
        byAuthor: localize('stats.byAuthor', d.byAuthor),
        byTag: localize('stats.byTag', d.byTag),
        topFiles: localize('stats.topFiles', d.topFiles),
        trend: localize('stats.trend', d.trend),
        empty: localize('stats.empty', d.empty),
        exportCsv: localize('stats.exportCsv', d.exportCsv),
        exportReport: localize('stats.exportReport', d.exportReport),
        severityFilter: localize('stats.severityFilter', d.severityFilter),
        statusFilter: localize('stats.statusFilter', d.statusFilter),
        all: localize('stats.all', d.all),
        statusOpen: localize('stats.statusOpen', d.statusOpen),
        statusResolved: localize('stats.statusResolved', d.statusResolved),
    };
}

/** Live statistics dashboard. One panel at a time; it follows the annotation store. */
export class StatisticsView {
    private static current: StatisticsView | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private filter: DashboardFilterState = { severity: 'all', status: 'all' };
    private timer: NodeJS.Timeout | undefined;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly store: AnnotationStore
    ) {
        this.disposables.push(
            store.onDidChange(() => this.scheduleRender()),
            panel.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
            panel.onDidDispose(() => this.dispose())
        );
        this.render();
    }

    public static show(store: AnnotationStore): void {
        if (StatisticsView.current) {
            StatisticsView.current.panel.reveal();
            StatisticsView.current.render();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'annotationStatistics',
            localize('stats.title', DEFAULT_DASHBOARD_STRINGS.title),
            vscode.ViewColumn.Beside,
            { enableScripts: true, localResourceRoots: [] }
        );
        StatisticsView.current = new StatisticsView(panel, store);
    }

    private scheduleRender(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.render(), REFRESH_DEBOUNCE_MS);
    }

    private render(): void {
        const items = this.store.list();
        const severities = [...new Set(computeStatistics(items).bySeverity.map((e) => e.key))];
        const stats = computeStatistics(items, dashboardFilterToAnnotationFilter(this.filter));
        this.panel.webview.html = renderDashboardHtml(stats, {
            nonce: generateNonce(),
            cspSource: this.panel.webview.cspSource,
            filter: this.filter,
            severities,
            strings: dashboardStrings(),
        });
    }

    private handleMessage(value: unknown): void {
        const message = parseDashboardMessage(value);
        if (!message) {
            return;
        }
        if (message.command === 'setFilter') {
            this.filter = message.state;
            this.render();
        } else if (message.command === 'exportCsv') {
            void vscode.commands.executeCommand('annotations.exportStatisticsCsv');
        } else {
            void vscode.commands.executeCommand('annotations.exportReport');
        }
    }

    private dispose(): void {
        clearTimeout(this.timer);
        StatisticsView.current = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
