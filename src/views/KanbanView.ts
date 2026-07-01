import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { localize } from '../common/localize';
import type { AnnotationV2 } from '../transactional/types';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { KanbanColumnStore } from '../transactional/KanbanColumnStore';

export class KanbanView {
    public static currentPanel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private annotations: readonly AnnotationV2[] = [];
    private columns: Map<string, string> = new Map([
        ['todo', localize('kanban.column.todo', 'To Do')],
        ['in-progress', localize('kanban.column.inProgress', 'In Progress')],
        ['review', localize('kanban.column.review', 'Review')],
        ['done', localize('kanban.column.done', 'Done')],
    ]);

    constructor(
        private context: vscode.ExtensionContext,
        private store: AnnotationStore,
        private kanbanColumnStore: KanbanColumnStore
    ) {}

    public static async createOrShow(
        context: vscode.ExtensionContext,
        annotations: readonly AnnotationV2[],
        store: AnnotationStore,
        kanbanColumnStore: KanbanColumnStore
    ) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (KanbanView.currentPanel) {
            KanbanView.currentPanel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'annotationKanban',
            localize('kanban.title', 'Annotation Kanban Board'),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            }
        );

        const kanbanView = new KanbanView(context, store, kanbanColumnStore);
        kanbanView.annotations = annotations;

        // Get current columns from AnnotationManager
        const columns = await vscode.commands.executeCommand<[string, string][]>('annotations.kanban.getColumns');
        if (columns) {
            kanbanView.columns = new Map(columns);
        }

        KanbanView.currentPanel = panel;

        panel.webview.html = kanbanView.getWebviewContent(panel.webview);

        panel.webview.onDidReceiveMessage((message) => kanbanView.handleMessage(message), null, kanbanView.disposables);

        panel.onDidDispose(
            () => {
                KanbanView.currentPanel = undefined;
                kanbanView.dispose();
            },
            null,
            kanbanView.disposables
        );
    }

    public updateAnnotations(annotations: readonly AnnotationV2[]) {
        this.annotations = annotations;
        if (KanbanView.currentPanel) {
            KanbanView.currentPanel.webview.postMessage({
                command: 'updateAnnotations',
                annotations: this.serializeAnnotations(),
            });
        }
    }

    public updateColumns(columns: Map<string, string>) {
        this.columns = columns;
        if (KanbanView.currentPanel) {
            KanbanView.currentPanel.webview.postMessage({
                command: 'updateColumns',
                columns: Array.from(columns.entries()),
            });
        }
    }

    public moveAnnotation(annotationId: string, _fromColumn: string, toColumn: string) {
        const annotation = this.annotations.find((a) => a.id === annotationId);
        if (annotation) {
            // Annotation snapshots from the store are frozen; the column
            // mutation is applied via a command handled by extension.ts,
            // which routes to KanbanColumnStore in worker-1's wiring.
            vscode.commands.executeCommand('annotations.kanban.moveToColumn', annotationId, toColumn);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handleMessage(message: any) {
        switch (message.command) {
            case 'moveCard':
                this.moveAnnotation(message.annotationId, message.fromColumn, message.toColumn);
                break;
            case 'addColumn':
                vscode.commands.executeCommand('annotations.kanban.addColumn', message.id, message.name);
                // Don't update columns here - let the event system handle it
                break;
            case 'renameColumn':
                if (this.columns.has(message.id)) {
                    const columnsArray = Array.from(this.columns.entries()).map(([id, name]) =>
                        id === message.id ? [id, message.newName] : [id, name]
                    );
                    vscode.commands.executeCommand('annotations.kanban.updateColumns', columnsArray);
                    // Don't update columns here - let the event system handle it
                }
                break;
            case 'deleteColumn':
                vscode.window
                    .showWarningMessage(
                        localize(
                            'kanban.deleteColumnConfirm',
                            'Are you sure you want to delete this column? Annotations will be moved to "{0}".'
                        ).replace('{0}', localize('kanban.column.todo', 'To Do')),
                        localize('delete', 'Delete'),
                        localize('cancel', 'Cancel')
                    )
                    .then((result) => {
                        if (result === localize('delete', 'Delete')) {
                            vscode.commands.executeCommand('annotations.kanban.deleteColumn', message.id);
                        }
                    });
                break;
            case 'openFile':
                vscode.commands.executeCommand('annotations.navigate', message.annotationId);
                break;
            case 'deleteAnnotation':
                vscode.window
                    .showQuickPick(
                        [
                            {
                                label: localize('kanban.removeFromKanbanOnly', 'Remove from Kanban only'),
                                value: 'removeFromKanban',
                                description: localize(
                                    'kanban.removeFromKanbanOnlyDesc',
                                    'The annotation will remain in the system'
                                ),
                            },
                            {
                                label: localize('kanban.deleteCompletely', 'Delete completely'),
                                value: 'delete',
                                description: localize(
                                    'kanban.deleteCompletelyDesc',
                                    'Permanently delete the annotation'
                                ),
                            },
                        ],
                        {
                            placeHolder: localize(
                                'kanban.deleteAnnotationPrompt',
                                'What would you like to do with this annotation?'
                            ),
                            canPickMany: false,
                        }
                    )
                    .then((selected) => {
                        if (selected) {
                            if (selected.value === 'removeFromKanban') {
                                vscode.commands.executeCommand(
                                    'annotations.kanban.removeFromKanban',
                                    message.annotationId
                                );
                            } else if (selected.value === 'delete') {
                                vscode.window
                                    .showWarningMessage(
                                        localize(
                                            'kanban.deleteAnnotationConfirm',
                                            'Are you sure you want to permanently delete this annotation?'
                                        ),
                                        localize('delete', 'Delete'),
                                        localize('cancel', 'Cancel')
                                    )
                                    .then((result) => {
                                        if (result === localize('delete', 'Delete')) {
                                            vscode.commands.executeCommand(
                                                'annotations.kanban.delete',
                                                message.annotationId
                                            );
                                        }
                                    });
                            }
                        }
                    });
                break;
            case 'refresh':
                vscode.commands.executeCommand('annotations.kanban.refresh');
                break;
        }
    }

    private serializeAnnotations() {
        const openDocs = vscode.workspace.textDocuments;
        return this.annotations.map((annotation) => {
            const resolvedLine = this.store.getLineForAnnotation(annotation.id, openDocs);
            return {
                id: annotation.id,
                message: annotation.message,
                severity: annotation.severity || 'info',
                file: annotation.file?.split('/').pop() || localize('unknown', 'Unknown'),
                filePath: annotation.file,
                line: resolvedLine === null ? null : resolvedLine + 1,
                tags: annotation.tags || [],
                kanbanColumn: this.kanbanColumnStore.getColumn(annotation.id) ?? 'todo',
                timestamp: annotation.timestamp,
            };
        });
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const cspSource = webview.cspSource;
        const columns = Array.from(this.columns.entries());
        const annotations = this.serializeAnnotations();

        // Localized strings for webview
        const localizedStrings = {
            title: localize('kanban.title', 'Annotation Kanban Board'),
            searchPlaceholder: localize('kanban.searchPlaceholder', 'Search annotations...'),
            allSeverities: localize('kanban.allSeverities', 'All Severities'),
            error: localize('severity.error', 'Error'),
            warning: localize('severity.warning', 'Warning'),
            info: localize('severity.info', 'Info'),
            hint: localize('severity.hint', 'Hint'),
            addColumn: localize('kanban.addColumn', '+ Add Column'),
            total: localize('kanban.total', 'Total'),
            dropAnnotationsHere: localize('kanban.dropAnnotationsHere', 'Drop annotations here'),
            rename: localize('kanban.rename', 'Rename'),
            delete: localize('delete', 'Delete'),
            openFile: localize('kanban.openFile', 'Open file'),
            deleteOptions: localize('kanban.deleteOptions', 'Delete options'),
            addNewColumn: localize('kanban.addNewColumn', 'Add New Column'),
            renameColumn: localize('kanban.renameColumn', 'Rename Column'),
            columnName: localize('kanban.columnName', 'Column name'),
            cancel: localize('cancel', 'Cancel'),
            save: localize('save', 'Save'),
            severityFilterLabel: localize('kanban.severityFilterLabel', 'Filter by severity'),
            setWipLimit: localize('kanban.setWipLimit', 'Click to set a WIP limit for this column'),
            kbdGrabbed: localize(
                'kanban.kbdGrabbed',
                'Card grabbed from {0}. Use the arrow keys to choose a column, Enter to move, Escape to cancel.'
            ),
            kbdTarget: localize('kanban.kbdTarget', 'Target column: {0}.'),
            kbdMoved: localize('kanban.kbdMoved', 'Card moved to {0}.'),
            kbdCanceled: localize('kanban.kbdCanceled', 'Move canceled.'),
            kbdNoChange: localize('kanban.kbdNoChange', 'No change.'),
        };

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${localizedStrings.title}</title>
            <style>
                :root {
                    --vscode-editor-background: var(--vscode-editor-background);
                    --vscode-editor-foreground: var(--vscode-editor-foreground);
                    --vscode-editorWidget-background: var(--vscode-editorWidget-background);
                    --vscode-editorWidget-border: var(--vscode-editorWidget-border);
                    --vscode-input-background: var(--vscode-input-background);
                    --vscode-input-foreground: var(--vscode-input-foreground);
                    --vscode-input-border: var(--vscode-input-border);
                    --vscode-button-background: var(--vscode-button-background);
                    --vscode-button-foreground: var(--vscode-button-foreground);
                    --vscode-button-hoverBackground: var(--vscode-button-hoverBackground);
                }

                body {
                    margin: 0;
                    padding: 0;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                }

                .container {
                    padding: 20px;
                    height: 100vh;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                }

                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid var(--vscode-editorWidget-border);
                }

                .title {
                    font-size: 18px;
                    font-weight: 600;
                }

                .controls {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }

                .search-box {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 4px 8px;
                    border-radius: 3px;
                    width: 200px;
                }

                .sr-only {
                    position: absolute;
                    width: 1px;
                    height: 1px;
                    padding: 0;
                    margin: -1px;
                    overflow: hidden;
                    clip: rect(0, 0, 0, 0);
                    white-space: nowrap;
                    border: 0;
                }

                .chip-group {
                    display: flex;
                    gap: 6px;
                    flex-wrap: wrap;
                }

                .chip {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 3px 10px;
                    border-radius: 12px;
                    font-size: 12px;
                    cursor: pointer;
                }

                .chip:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .chip.chip-active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border-color: var(--vscode-button-background);
                }

                .add-column-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 12px;
                    border-radius: 3px;
                    cursor: pointer;
                }

                .add-column-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .stats {
                    display: flex;
                    gap: 20px;
                    margin-bottom: 20px;
                    padding: 10px;
                    background-color: var(--vscode-editorWidget-background);
                    border-radius: 4px;
                }

                .stat-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }

                .stat-value {
                    font-size: 24px;
                    font-weight: bold;
                }

                .stat-label {
                    font-size: 12px;
                    opacity: 0.8;
                }

                .kanban-board {
                    display: flex;
                    gap: 16px;
                    flex: 1;
                    overflow-x: auto;
                }

                .column {
                    flex: 1;
                    min-width: 280px;
                    background-color: var(--vscode-editorWidget-background);
                    border-radius: 4px;
                    padding: 12px;
                    display: flex;
                    flex-direction: column;
                }

                .column-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                    padding-bottom: 8px;
                    border-bottom: 2px solid var(--vscode-editorWidget-border);
                }

                .column-title {
                    font-weight: 600;
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .column-count {
                    background-color: var(--vscode-input-background);
                    padding: 2px 6px;
                    border-radius: 10px;
                    font-size: 11px;
                    cursor: pointer;
                }

                .column-count.column-count-over {
                    background-color: var(--vscode-errorForeground);
                    color: var(--vscode-editor-background);
                }

                .column.column-over-wip {
                    box-shadow: inset 0 0 0 1px var(--vscode-errorForeground);
                }

                .wip-input {
                    width: 48px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 10px;
                    font-size: 11px;
                    padding: 2px 6px;
                }

                .column-actions {
                    display: flex;
                    gap: 4px;
                }

                .column-action-btn {
                    background: none;
                    border: none;
                    color: var(--vscode-editor-foreground);
                    cursor: pointer;
                    padding: 2px;
                    opacity: 0.6;
                }

                .column-action-btn:hover {
                    opacity: 1;
                }

                .cards-container {
                    flex: 1;
                    overflow-y: auto;
                    min-height: 100px;
                }

                .virtual-spacer {
                    pointer-events: none;
                }

                .card {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-editorWidget-border);
                    border-radius: 4px;
                    padding: 12px;
                    margin-bottom: 8px;
                    cursor: move;
                    transition: transform 0.2s, box-shadow 0.2s;
                }

                .card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                }

                .card:focus {
                    outline: 2px solid var(--vscode-focusBorder);
                    outline-offset: 2px;
                }

                .card.dragging {
                    opacity: 0.5;
                }

                .card.kbd-grabbed {
                    outline: 2px dashed var(--vscode-focusBorder);
                    outline-offset: 2px;
                }

                .column.kbd-target {
                    box-shadow: inset 0 0 0 2px var(--vscode-focusBorder);
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 8px;
                }

                .card-severity {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    margin-right: 8px;
                    flex-shrink: 0;
                }

                .severity-error { background-color: #f48771; }
                .severity-warning { background-color: #cca700; }
                .severity-info { background-color: #3794ff; }
                .severity-hint { background-color: #4ec9b0; }

                .card-actions {
                    display: flex;
                    gap: 4px;
                    opacity: 0;
                    transition: opacity 0.2s;
                }

                .card:hover .card-actions {
                    opacity: 1;
                }

                .card-action {
                    background: none;
                    border: none;
                    color: var(--vscode-editor-foreground);
                    cursor: pointer;
                    padding: 2px;
                    opacity: 0.6;
                }

                .card-action:hover {
                    opacity: 1;
                }

                .card-text {
                    font-size: 13px;
                    margin-bottom: 8px;
                    word-wrap: break-word;
                }

                .card-meta {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    font-size: 11px;
                    opacity: 0.8;
                }

                .card-file {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }

                .card-tags {
                    display: flex;
                    gap: 4px;
                    flex-wrap: wrap;
                    margin-top: 4px;
                }

                .tag {
                    background-color: var(--vscode-input-background);
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-size: 10px;
                }

                .drag-over {
                    background-color: var(--vscode-editorWidget-background);
                    border: 2px dashed var(--vscode-input-border);
                }

                .empty-column {
                    text-align: center;
                    opacity: 0.5;
                    padding: 20px;
                    font-style: italic;
                }

                .modal {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                }

                .modal-content {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background-color: var(--vscode-editorWidget-background);
                    padding: 20px;
                    border-radius: 4px;
                    min-width: 300px;
                }

                .modal-header {
                    margin-bottom: 16px;
                    font-weight: 600;
                }

                .modal-input {
                    width: 100%;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 6px 8px;
                    border-radius: 3px;
                    margin-bottom: 16px;
                }

                .modal-buttons {
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                }

                .modal-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 3px;
                    cursor: pointer;
                }

                .modal-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .modal-btn.cancel {
                    background-color: transparent;
                    border: 1px solid var(--vscode-input-border);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="title">${localizedStrings.title}</div>
                    <div class="controls">
                        <input type="text" class="search-box" placeholder="${localizedStrings.searchPlaceholder}" id="searchBox">
                        <div class="chip-group" id="severityChips" role="group" aria-label="${localizedStrings.severityFilterLabel}">
                            <button type="button" class="chip" data-severity="">${localizedStrings.allSeverities}</button>
                            <button type="button" class="chip" data-severity="error">${localizedStrings.error}</button>
                            <button type="button" class="chip" data-severity="warning">${localizedStrings.warning}</button>
                            <button type="button" class="chip" data-severity="info">${localizedStrings.info}</button>
                            <button type="button" class="chip" data-severity="hint">${localizedStrings.hint}</button>
                        </div>
                        <button class="add-column-btn" data-action="show-add-column-modal">${localizedStrings.addColumn}</button>
                    </div>
                </div>

                <div id="kanbanAnnouncer" class="sr-only" aria-live="polite" aria-atomic="true"></div>

                <div class="stats" id="stats">
                    <!-- Stats will be generated dynamically -->
                </div>

                <div class="kanban-board" id="kanbanBoard">
                    <!-- Columns will be generated dynamically -->
                </div>
            </div>

            <div class="modal" id="columnModal">
                <div class="modal-content">
                    <div class="modal-header" id="modalTitle">${localizedStrings.addNewColumn}</div>
                    <input type="text" class="modal-input" id="columnNameInput" placeholder="${localizedStrings.columnName}">
                    <input type="hidden" id="columnIdInput">
                    <div class="modal-buttons">
                        <button class="modal-btn cancel" data-action="hide-modal">${localizedStrings.cancel}</button>
                        <button class="modal-btn" data-action="save-column">${localizedStrings.save}</button>
                    </div>
                </div>
            </div>

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                function escapeHtml(str) {
                    return String(str)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#39;');
                }
                let annotations = ${JSON.stringify(annotations)};
                let columns = ${JSON.stringify(columns)};
                let draggedCard = null;

                // Filter/WIP state persists across webview reloads via vscode.setState,
                // separately from retainContextWhenHidden (which only survives a hide/show,
                // not a full panel reload).
                const previousState = vscode.getState() || {};
                let searchTerm = previousState.searchTerm || '';
                let severityFilter = previousState.severityFilter || '';
                let wipLimits = previousState.wipLimits || {};

                // Keyboard drag-and-drop: null when idle, otherwise
                // { annotationId, fromColumn, targetColumn } while a card is "grabbed".
                let keyboardGrab = null;
                // Annotation id to refocus once the next renderBoard() completes, set right
                // before a move is requested so keyboard focus survives the round trip
                // through the extension host and back.
                let pendingFocusAnnotationId = null;

                function persistState() {
                    vscode.setState({ searchTerm, severityFilter, wipLimits });
                }

                function announce(message) {
                    const el = document.getElementById('kanbanAnnouncer');
                    if (!el) return;
                    el.textContent = '';
                    void el.offsetWidth; // force reflow so repeated messages are re-announced
                    el.textContent = message;
                }

                // Column virtualization: below the threshold every card is rendered as
                // before. Above it, only cards near the scroll viewport (+ overscan) are
                // mounted, using a measured/estimated fixed card height since Kanban cards
                // have variable content (tags) that make exact per-card sizing impractical
                // for a dependency-free implementation.
                const VIRTUALIZE_THRESHOLD = 30;
                const ESTIMATED_CARD_HEIGHT = 96;
                const VIRTUALIZE_OVERSCAN = 4;
                
                // Localized strings
                const localized = ${JSON.stringify(localizedStrings)};

                function init() {
                    document.getElementById('searchBox').value = searchTerm;
                    updateSeverityChipsUI();
                    renderStats();
                    renderBoard();
                    setupEventListeners();
                }

                function updateSeverityChipsUI() {
                    document.querySelectorAll('.chip').forEach(function(chip) {
                        const active = (chip.dataset.severity || '') === severityFilter;
                        chip.classList.toggle('chip-active', active);
                        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
                    });
                }

                function setupEventListeners() {
                    document.addEventListener('click', function(e) {
                        const btn = e.target.closest('[data-action]');
                        if (!btn) return;
                        const action = btn.dataset.action;
                        if (action === 'open') { openFile(btn.dataset.annId); }
                        else if (action === 'delete-ann') { deleteAnnotation(btn.dataset.annId); }
                        else if (action === 'show-add-column-modal') { showAddColumnModal(); }
                        else if (action === 'hide-modal') { hideModal(); }
                        else if (action === 'save-column') { saveColumn(); }
                    });

                    document.getElementById('searchBox').addEventListener('input', (e) => {
                        searchTerm = e.target.value.toLowerCase();
                        persistState();
                        renderBoard();
                    });

                    document.addEventListener('click', function(e) {
                        const chip = e.target.closest('.chip');
                        if (!chip) return;
                        severityFilter = chip.dataset.severity || '';
                        persistState();
                        updateSeverityChipsUI();
                        renderBoard();
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'updateAnnotations':
                                annotations = message.annotations;
                                renderStats();
                                renderBoard();
                                break;
                            case 'updateColumns':
                                columns = message.columns;
                                renderBoard();
                                break;
                        }
                    });

                    document.addEventListener('dragstart', function(e) {
                        const card = e.target.closest('.card');
                        if (!card) return;
                        draggedCard = card;
                        card.classList.add('dragging');
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', card.dataset.annotationId);
                    });

                    document.addEventListener('dragend', function() {
                        if (draggedCard) {
                            draggedCard.classList.remove('dragging');
                            draggedCard = null;
                        }
                        // Scroll-triggered virtualization re-renders are skipped while a
                        // drag is in progress (see createColumn); resync now in case the
                        // browser auto-scrolled a column during the drag.
                        refreshVirtualizedColumns();
                    });

                    document.addEventListener('dragover', function(e) {
                        const container = e.target.closest('.cards-container');
                        if (!container) return;
                        e.preventDefault();
                        container.classList.add('drag-over');
                    });

                    document.addEventListener('dragleave', function(e) {
                        const container = e.target.closest('.cards-container');
                        if (!container) return;
                        if (!container.contains(e.relatedTarget)) {
                            container.classList.remove('drag-over');
                        }
                    });

                    document.addEventListener('drop', function(e) {
                        const container = e.target.closest('.cards-container');
                        if (!container) return;
                        e.preventDefault();
                        container.classList.remove('drag-over');
                        if (!draggedCard) return;
                        const column = container.closest('.column');
                        const toColumn = column.dataset.columnId;
                        const annotationId = draggedCard.dataset.annotationId;
                        const fromColumnEl = draggedCard.closest('.column');
                        const fromColumn = fromColumnEl ? fromColumnEl.dataset.columnId : null;
                        if (fromColumn) {
                            moveCardToColumn(annotationId, fromColumn, toColumn);
                        }
                        draggedCard.classList.remove('dragging');
                        draggedCard = null;
                    });

                    document.addEventListener('keydown', function(e) {
                        const countBadge = e.target.closest('.column-count[data-action="edit-wip"]');
                        if (countBadge && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
                            e.preventDefault();
                            startWipEdit(countBadge);
                            return;
                        }

                        if (keyboardGrab) {
                            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                                e.preventDefault();
                                const ids = columns.map(c => c[0]);
                                const currentIdx = ids.indexOf(keyboardGrab.targetColumn);
                                const delta = e.key === 'ArrowRight' ? 1 : -1;
                                const nextIdx = Math.min(ids.length - 1, Math.max(0, currentIdx + delta));
                                setKeyboardTarget(ids[nextIdx]);
                            } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                                e.preventDefault();
                                commitKeyboardMove();
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelKeyboardGrab();
                            }
                            return;
                        }

                        // Guards against e.target being a nested .card-action button (open/
                        // delete): only grab when the card itself is the focused element, so
                        // those buttons keep their own native Enter/Space activation.
                        if (e.target.classList.contains('card') && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
                            e.preventDefault();
                            startKeyboardGrab(e.target);
                        }
                    });
                }

                function moveCardToColumn(annotationId, fromColumn, toColumn) {
                    if (!annotationId || !fromColumn || fromColumn === toColumn) return;
                    pendingFocusAnnotationId = annotationId;
                    vscode.postMessage({
                        command: 'moveCard',
                        annotationId: annotationId,
                        fromColumn: fromColumn,
                        toColumn: toColumn
                    });
                    const columnName = (columns.find(c => c[0] === toColumn) || [])[1] || toColumn;
                    announce(localized.kbdMoved.replace('{0}', columnName));
                }

                function startKeyboardGrab(card) {
                    const columnEl = card.closest('.column');
                    const fromColumn = columnEl ? columnEl.dataset.columnId : null;
                    if (!fromColumn) return;
                    keyboardGrab = {
                        annotationId: card.dataset.annotationId,
                        fromColumn: fromColumn,
                        targetColumn: fromColumn
                    };
                    card.classList.add('kbd-grabbed');
                    card.setAttribute('aria-grabbed', 'true');
                    highlightTargetColumn(fromColumn);
                    const columnName = (columns.find(c => c[0] === fromColumn) || [])[1] || fromColumn;
                    announce(localized.kbdGrabbed.replace('{0}', columnName));
                }

                function setKeyboardTarget(columnId) {
                    keyboardGrab.targetColumn = columnId;
                    highlightTargetColumn(columnId);
                    const columnName = (columns.find(c => c[0] === columnId) || [])[1] || columnId;
                    announce(localized.kbdTarget.replace('{0}', columnName));
                }

                function highlightTargetColumn(columnId) {
                    document.querySelectorAll('.column').forEach(function(col) {
                        col.classList.toggle('kbd-target', col.dataset.columnId === columnId);
                    });
                }

                function commitKeyboardMove() {
                    const grab = keyboardGrab;
                    releaseKeyboardGrab();
                    if (!grab) return;
                    if (grab.targetColumn === grab.fromColumn) {
                        announce(localized.kbdNoChange);
                        return;
                    }
                    moveCardToColumn(grab.annotationId, grab.fromColumn, grab.targetColumn);
                }

                function cancelKeyboardGrab() {
                    releaseKeyboardGrab();
                    announce(localized.kbdCanceled);
                }

                function releaseKeyboardGrab() {
                    if (!keyboardGrab) return;
                    const card = document.querySelector('.card[data-annotation-id="' + CSS.escape(keyboardGrab.annotationId) + '"]');
                    if (card) {
                        card.classList.remove('kbd-grabbed');
                        card.removeAttribute('aria-grabbed');
                    }
                    document.querySelectorAll('.column.kbd-target').forEach(function(col) {
                        col.classList.remove('kbd-target');
                    });
                    keyboardGrab = null;
                }

                function startWipEdit(countEl) {
                    const colId = countEl.dataset.colId;
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.min = '0';
                    input.className = 'wip-input';
                    input.value = wipLimits[colId] ? String(wipLimits[colId]) : '';
                    countEl.replaceWith(input);
                    input.focus();
                    input.select();

                    let canceled = false;

                    function commit() {
                        if (canceled) return;
                        const raw = input.value.trim();
                        const parsed = raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0);
                        if (parsed > 0) {
                            wipLimits[colId] = parsed;
                        } else {
                            delete wipLimits[colId];
                        }
                        persistState();
                        renderBoard();
                    }

                    input.addEventListener('blur', commit);
                    input.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            input.blur();
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            canceled = true;
                            renderBoard();
                        }
                    });
                }

                function renderStats() {
                    const stats = document.getElementById('stats');
                    const total = annotations.length;
                    const byStatus = {};
                    const bySeverity = {};

                    columns.forEach(([id, name]) => {
                        byStatus[id] = 0;
                    });

                    annotations.forEach(annotation => {
                        const status = annotation.kanbanColumn || 'todo';
                        byStatus[status] = (byStatus[status] || 0) + 1;
                        bySeverity[annotation.severity] = (bySeverity[annotation.severity] || 0) + 1;
                    });

                    stats.innerHTML = \`
                        <div class="stat-item">
                            <div class="stat-value">\${total}</div>
                            <div class="stat-label">\${escapeHtml(localized.total)}</div>
                        </div>
                        \${Object.entries(byStatus).map(([status, count]) => \`
                            <div class="stat-item">
                                <div class="stat-value">\${count}</div>
                                <div class="stat-label">\${escapeHtml(columns.find(c => c[0] === status)?.[1] || status)}</div>
                            </div>
                        \`).join('')}
                    \`;
                }

                function renderBoard() {
                    const board = document.getElementById('kanbanBoard');
                    board.innerHTML = '';

                    const filteredAnnotations = annotations.filter(annotation => {
                        const matchesSearch = !searchTerm || 
                            annotation.message.toLowerCase().includes(searchTerm) ||
                            annotation.file.toLowerCase().includes(searchTerm) ||
                            (annotation.tags || []).some(tag => tag.toLowerCase().includes(searchTerm));
                        
                        const matchesSeverity = !severityFilter || annotation.severity === severityFilter;
                        
                        return matchesSearch && matchesSeverity;
                    });

                    columns.forEach(([columnId, columnName]) => {
                        const columnAnnotations = filteredAnnotations.filter(a => (a.kanbanColumn || 'todo') === columnId);
                        const column = createColumn(columnId, columnName, columnAnnotations);
                        board.appendChild(column);
                        // Rendered only after appending: clientHeight (used to size the
                        // virtualization window) reads 0 on a detached element.
                        renderColumnCards(column.querySelector('.cards-container'));
                    });

                    if (pendingFocusAnnotationId) {
                        const id = pendingFocusAnnotationId;
                        pendingFocusAnnotationId = null;
                        // Not found when the moved card lands outside a virtualized column's
                        // current window; the card simply keeps whatever focus it had.
                        const cardToFocus = document.querySelector('.card[data-annotation-id="' + CSS.escape(id) + '"]');
                        if (cardToFocus) {
                            cardToFocus.focus();
                        }
                    }
                }

                function createColumn(id, name, columnAnnotations) {
                    const wipLimit = wipLimits[id];
                    const overWip = !!wipLimit && columnAnnotations.length > wipLimit;

                    const column = document.createElement('div');
                    column.className = 'column' + (overWip ? ' column-over-wip' : '');
                    column.dataset.columnId = id;

                    column.innerHTML = \`
                        <div class="column-header">
                            <div class="column-title">
                                <span>\${escapeHtml(name)}</span>
                                <span class="column-count\${overWip ? ' column-count-over' : ''}" data-action="edit-wip" data-col-id="\${escapeHtml(id)}" tabindex="0" role="button" title="\${escapeHtml(localized.setWipLimit)}">\${columnAnnotations.length}\${wipLimit ? ' / ' + wipLimit : ''}</span>
                            </div>
                            <div class="column-actions">
                                <button class="column-action-btn" data-action="rename" data-col-id="\${escapeHtml(id)}" data-col-name="\${escapeHtml(name)}" title="\${escapeHtml(localized.rename)}">&#9999;&#65039;</button>
                                <button class="column-action-btn" data-action="delete-col" data-col-id="\${escapeHtml(id)}" title="\${escapeHtml(localized.delete)}">&#128465;&#65039;</button>
                            </div>
                        </div>
                        <div class="cards-container"></div>
                    \`;
                    column.querySelector('[data-action="rename"]')?.addEventListener('click', function() {
                        showRenameColumnModal(this.dataset.colId, this.dataset.colName);
                    });
                    column.querySelector('[data-action="delete-col"]')?.addEventListener('click', function() {
                        deleteColumn(this.dataset.colId);
                    });

                    const cardsContainer = column.querySelector('.cards-container');
                    cardsContainer._virtualAnnotations = columnAnnotations;
                    if (columnAnnotations.length > VIRTUALIZE_THRESHOLD) {
                        let scrollRaf = null;
                        cardsContainer.addEventListener('scroll', function() {
                            if (draggedCard) return;
                            if (scrollRaf) return;
                            scrollRaf = requestAnimationFrame(function() {
                                scrollRaf = null;
                                renderColumnCards(cardsContainer);
                            });
                        });
                    }

                    return column;
                }

                function renderColumnCards(cardsContainer) {
                    const columnAnnotations = cardsContainer._virtualAnnotations || [];

                    if (columnAnnotations.length === 0) {
                        cardsContainer.innerHTML = '<div class="empty-column">' + escapeHtml(localized.dropAnnotationsHere) + '</div>';
                        return;
                    }

                    if (columnAnnotations.length <= VIRTUALIZE_THRESHOLD) {
                        cardsContainer.innerHTML = columnAnnotations.map(annotation => createCard(annotation)).join('');
                        return;
                    }

                    const total = columnAnnotations.length;
                    const cardHeight = Number(cardsContainer.dataset.measuredCardHeight) || ESTIMATED_CARD_HEIGHT;
                    const viewportHeight = cardsContainer.clientHeight || 400;
                    const visibleCount = Math.ceil(viewportHeight / cardHeight) + VIRTUALIZE_OVERSCAN * 2;
                    const rawStart = Math.max(0, Math.floor(cardsContainer.scrollTop / cardHeight) - VIRTUALIZE_OVERSCAN);
                    const start = Math.min(rawStart, Math.max(0, total - 1));
                    const end = Math.min(total, start + visibleCount);

                    const topSpacerHeight = start * cardHeight;
                    const bottomSpacerHeight = (total - end) * cardHeight;

                    let html = '<div class="virtual-spacer" style="height:' + topSpacerHeight + 'px"></div>';
                    for (let i = start; i < end; i++) {
                        html += createCard(columnAnnotations[i]);
                    }
                    html += '<div class="virtual-spacer" style="height:' + bottomSpacerHeight + 'px"></div>';

                    cardsContainer.innerHTML = html;

                    const sampleCard = cardsContainer.querySelector('.card');
                    if (sampleCard) {
                        const measuredHeight = sampleCard.getBoundingClientRect().height;
                        if (measuredHeight > 0) {
                            // + 8 accounts for .card's margin-bottom, excluded from getBoundingClientRect.
                            cardsContainer.dataset.measuredCardHeight = String(Math.round(measuredHeight + 8));
                        }
                    }
                }

                function refreshVirtualizedColumns() {
                    document.querySelectorAll('.cards-container').forEach(function(el) {
                        if (el._virtualAnnotations && el._virtualAnnotations.length > VIRTUALIZE_THRESHOLD) {
                            renderColumnCards(el);
                        }
                    });
                }

                function createCard(annotation) {
                    const date = new Date(annotation.timestamp);
                    const formattedDate = date.toLocaleDateString();
                    const safeId = escapeHtml(annotation.id);
                    const safeSeverity = escapeHtml(annotation.severity);

                    return \`
                        <div class="card" draggable="true" tabindex="0" role="button" aria-grabbed="false" aria-label="\${escapeHtml(annotation.severity)}: \${escapeHtml(annotation.message)}" data-annotation-id="\${safeId}">
                            <div class="card-header">
                                <div style="display: flex; align-items: center;">
                                    <div class="card-severity severity-\${safeSeverity}"></div>
                                </div>
                                <div class="card-actions">
                                    <button class="card-action" data-action="open" data-ann-id="\${safeId}" title="\${escapeHtml(localized.openFile)}">&#128194;</button>
                                    <button class="card-action" data-action="delete-ann" data-ann-id="\${safeId}" title="\${escapeHtml(localized.deleteOptions)}">&#128465;&#65039;</button>
                                </div>
                            </div>
                            <div class="card-text">\${escapeHtml(annotation.message)}</div>
                            <div class="card-meta">
                                <div class="card-file">&#128196; \${escapeHtml(annotation.file)}:\${annotation.line === null ? '?' : annotation.line}</div>
                                <div>&#128197; \${formattedDate}</div>
                            </div>
                            \${annotation.tags && annotation.tags.length > 0 ? \`
                                <div class="card-tags">
                                    \${annotation.tags.map(tag => \`<span class="tag">\${escapeHtml(tag)}</span>\`).join('')}
                                </div>
                            \` : ''}
                        </div>
                    \`;
                }

                function drag(event) {
                    draggedCard = event.target;
                    draggedCard.classList.add('dragging');
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/html', event.target.innerHTML);
                }

                function dragEnd(event) {
                    event.target.classList.remove('dragging');
                }

                function allowDrop(event) {
                    event.preventDefault();
                    const container = event.target.closest('.cards-container');
                    if (container) {
                        container.classList.add('drag-over');
                    }
                }

                function removeDragOver(event) {
                    const container = event.target.closest('.cards-container');
                    if (container) {
                        container.classList.remove('drag-over');
                    }
                }

                function drop(event) {
                    event.preventDefault();
                    const container = event.target.closest('.cards-container');
                    
                    if (container) {
                        container.classList.remove('drag-over');
                        const column = container.closest('.column');
                        const toColumn = column.dataset.columnId;
                        const annotationId = draggedCard.dataset.annotationId;
                        const fromColumn = draggedCard.closest('.column').dataset.columnId;

                        if (fromColumn !== toColumn) {
                            vscode.postMessage({
                                command: 'moveCard',
                                annotationId: annotationId,
                                fromColumn: fromColumn,
                                toColumn: toColumn
                            });
                        }
                    }
                }

                function showAddColumnModal() {
                    document.getElementById('modalTitle').textContent = localized.addNewColumn;
                    document.getElementById('columnNameInput').value = '';
                    document.getElementById('columnIdInput').value = '';
                    document.getElementById('columnModal').style.display = 'block';
                }

                function showRenameColumnModal(id, currentName) {
                    document.getElementById('modalTitle').textContent = localized.renameColumn;
                    document.getElementById('columnNameInput').value = currentName;
                    document.getElementById('columnIdInput').value = id;
                    document.getElementById('columnModal').style.display = 'block';
                }

                function hideModal() {
                    document.getElementById('columnModal').style.display = 'none';
                }

                function saveColumn() {
                    const name = document.getElementById('columnNameInput').value.trim();
                    const id = document.getElementById('columnIdInput').value;

                    if (!name) return;

                    if (id) {
                        vscode.postMessage({
                            command: 'renameColumn',
                            id: id,
                            newName: name
                        });
                    } else {
                        const newId = name.toLowerCase().replace(/\\s+/g, '-');
                        vscode.postMessage({
                            command: 'addColumn',
                            id: newId,
                            name: name
                        });
                    }

                    hideModal();
                }

                function deleteColumn(id) {
                    vscode.postMessage({
                        command: 'deleteColumn',
                        id: id
                    });
                }

                function openFile(annotationId) {
                    vscode.postMessage({
                        command: 'openFile',
                        annotationId: annotationId
                    });
                }

                function deleteAnnotation(annotationId) {
                    vscode.postMessage({
                        command: 'deleteAnnotation',
                        annotationId: annotationId
                    });
                }

                // Initialize the board
                init();
            </script>
        </body>
        </html>`;
    }

    private dispose() {
        KanbanView.currentPanel = undefined;

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
