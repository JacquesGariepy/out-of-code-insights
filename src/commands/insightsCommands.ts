// SPDX-License-Identifier: MPL-2.0
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { captureAnchor } from '../anchoring/anchor';
import { TextBuffer } from '../anchoring/textBuffer';
import { toFileUriString } from '../common/fileUri';
import { loc } from '../managers/LocalizationManager';
import { renderReport, type ReportFormat } from '../insights/annotationReport';
import { annotationsToCsv } from '../insights/annotationStatistics';
import {
    DIAGNOSTIC_SEVERITY,
    draftsFromDiagnostics,
    type DiagnosticLike,
    type DiagnosticMinSeverity,
} from '../insights/diagnosticImport';
import { languageOfPath } from '../comments/languageOfPath';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import { getLogger } from '../utils/logger';
import { StatisticsView } from '../views/StatisticsView';

const MAX_DIAGNOSTIC_FILE_BYTES = 2 * 1024 * 1024;

function isMinSeverity(value: unknown): value is DiagnosticMinSeverity {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SEVERITY, value);
}

function readSourceTags(value: unknown): Record<string, string> {
    const tags: Record<string, string> = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [source, tag] of Object.entries(value)) {
            if (typeof tag === 'string') {
                tags[source] = tag;
            }
        }
    }
    return tags;
}

function workspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function saveText(
    defaultName: string,
    filters: Record<string, string[]>,
    content: string
): Promise<vscode.Uri | undefined> {
    const root = workspaceRoot();
    const target = await vscode.window.showSaveDialog({
        defaultUri: root ? vscode.Uri.joinPath(root, defaultName) : undefined,
        filters,
    });
    if (!target) {
        return undefined;
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    return target;
}

/**
 * Convert the diagnostics currently reported by VS Code (ESLint, TypeScript,
 * Pylint, SonarLint...) into annotations. Nothing is written for files outside
 * the workspace; existing identical annotations are never duplicated.
 */
export async function importDiagnosticsAsAnnotations(
    store: AnnotationStore
): Promise<{ created: number; files: number }> {
    const config = vscode.workspace.getConfiguration('annotation');
    const configured = config.get<string>('diagnostics.minSeverity', 'warning');
    const minSeverity: DiagnosticMinSeverity = isMinSeverity(configured) ? configured : 'warning';
    const limit = Math.max(1, Math.min(1000, config.get<number>('diagnostics.maxPerFile', 50)));
    const sourceTags = readSourceTags(config.get('diagnostics.sourceTags', {}));
    const decoder = new TextDecoder();
    let created = 0;
    let files = 0;

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri) || diagnostics.length === 0) {
            continue;
        }
        const likes: DiagnosticLike[] = diagnostics.map((d) => ({
            line: d.range.start.line,
            severity: d.severity,
            message: d.message,
            source: d.source,
            code: typeof d.code === 'object' ? d.code.value : d.code,
        }));
        const drafts = draftsFromDiagnostics(likes, { minSeverity, sourceTags, limit });
        if (drafts.length === 0) {
            continue;
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_DIAGNOSTIC_FILE_BYTES) {
                continue;
            }
            const buffer = new TextBuffer(decoder.decode(await vscode.workspace.fs.readFile(uri)));
            const fileUri = toFileUriString(uri.fsPath);
            const file = vscode.workspace.asRelativePath(uri);
            const languageId = languageOfPath(uri.fsPath);
            const existing = new Set(
                store.getByFile(fileUri).map((a) => `${buffer.lineAtOffset(a.startOffset)}\u0000${a.message}`)
            );
            let createdInFile = 0;
            for (const draft of drafts) {
                if (draft.line >= buffer.lineCount || existing.has(`${draft.line}\u0000${draft.message}`)) {
                    continue;
                }
                const startOffset = buffer.offsetAt(draft.line);
                const anchor = captureAnchor(buffer, draft.line, { walkForward: 0, walkBackward: 0 });
                store.add({
                    fileUri,
                    file,
                    startOffset,
                    endOffset: startOffset + buffer.lineAt(draft.line).text.length,
                    lineHash: anchor.lineHash,
                    contextBefore: anchor.contextBefore,
                    contextAfter: anchor.contextAfter,
                    origin: { kind: 'manual' },
                    message: draft.message,
                    timestamp: new Date().toISOString(),
                    languageId,
                    tags: draft.tags,
                    severity: draft.severity,
                });
                createdInFile++;
            }
            if (createdInFile > 0) {
                created += createdInFile;
                files++;
            }
        } catch (err) {
            getLogger().warn(`importDiagnostics: skipping ${uri.toString()}`, {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { created, files };
}

export function registerInsightsCommands(
    context: vscode.ExtensionContext,
    getStore: () => AnnotationStore | undefined
): void {
    const withStore = (run: (store: AnnotationStore) => Promise<void> | void) => async () => {
        const store = getStore();
        if (!store) {
            vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
            return;
        }
        await run(store);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'annotations.showStatistics',
            withStore((store) => StatisticsView.show(store))
        ),

        vscode.commands.registerCommand(
            'annotations.exportStatisticsCsv',
            withStore(async (store) => {
                const target = await saveText('annotations.csv', { CSV: ['csv'] }, annotationsToCsv(store.list()));
                if (target) {
                    vscode.window.showInformationMessage(
                        loc('statsCsvExported', 'Annotations exported to {0}.', vscode.workspace.asRelativePath(target))
                    );
                }
            })
        ),

        vscode.commands.registerCommand(
            'annotations.exportReport',
            withStore(async (store) => {
                const format = await vscode.window.showQuickPick(
                    [
                        { label: 'Markdown', description: '.md', value: 'markdown' as ReportFormat },
                        { label: 'HTML', description: '.html', value: 'html' as ReportFormat },
                    ],
                    { placeHolder: loc('reportPickFormat', 'Report format') }
                );
                if (!format) {
                    return;
                }
                const scope = await vscode.window.showQuickPick(
                    [
                        { label: loc('reportScopeAll', 'All annotations'), resolved: undefined },
                        { label: loc('reportScopeOpen', 'Open annotations only'), resolved: false },
                    ],
                    { placeHolder: loc('reportPickScope', 'Which annotations should the report include?') }
                );
                if (!scope) {
                    return;
                }
                const content = renderReport(store.list(), format.value, {
                    title: loc('reportTitle', 'Annotation Report'),
                    filter: { resolved: scope.resolved },
                    generatedAt: new Date().toISOString(),
                });
                const isHtml = format.value === 'html';
                const target = await saveText(
                    isHtml ? 'annotation-report.html' : 'annotation-report.md',
                    isHtml ? { HTML: ['html'] } : { Markdown: ['md'] },
                    content
                );
                if (target) {
                    const open = loc('reportOpen', 'Open');
                    const choice = await vscode.window.showInformationMessage(
                        loc('reportExported', 'Report written to {0}.', vscode.workspace.asRelativePath(target)),
                        open
                    );
                    if (choice === open) {
                        await vscode.commands.executeCommand('vscode.open', target);
                    }
                }
            })
        ),

        vscode.commands.registerCommand(
            'annotations.importDiagnostics',
            withStore(async (store) => {
                const { created, files } = await importDiagnosticsAsAnnotations(store);
                vscode.window.showInformationMessage(
                    created === 0
                        ? loc('diagnosticsImportNone', 'No new diagnostics to import.')
                        : loc(
                              'diagnosticsImported',
                              '{0} annotation(s) created from diagnostics in {1} file(s).',
                              created,
                              files
                          )
                );
            })
        )
    );
}
