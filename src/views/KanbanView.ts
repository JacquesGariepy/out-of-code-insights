import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Annotation } from '../common/types';
import { localize } from '../common/localize';

export class KanbanView {
    public static currentPanel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private annotations: Annotation[] = [];
    private columns: Map<string, string> = new Map([
        ['todo', localize('kanban.column.todo', 'To Do')],
        ['in-progress', localize('kanban.column.inProgress', 'In Progress')],
        ['review', localize('kanban.column.review', 'Review')],
        ['done', localize('kanban.column.done', 'Done')]
    ]);

    constructor(private context: vscode.ExtensionContext) {}

    public static async createOrShow(context: vscode.ExtensionContext, annotations: Annotation[]) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

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
                localResourceRoots: [context.extensionUri]
            }
        );

        const kanbanView = new KanbanView(context);
        kanbanView.annotations = annotations;
        
        // Get current columns from AnnotationManager
        const columns = await vscode.commands.executeCommand<[string, string][]>('annotations.kanban.getColumns');
        if (columns) {
            kanbanView.columns = new Map(columns);
        }
        
        KanbanView.currentPanel = panel;

        panel.webview.html = kanbanView.getWebviewContent(panel.webview);

        panel.webview.onDidReceiveMessage(
            message => kanbanView.handleMessage(message),
            null,
            kanbanView.disposables
        );

        panel.onDidDispose(
            () => {
                KanbanView.currentPanel = undefined;
                kanbanView.dispose();
            },
            null,
            kanbanView.disposables
        );
    }

    public updateAnnotations(annotations: Annotation[]) {
        this.annotations = annotations;
        if (KanbanView.currentPanel) {
            KanbanView.currentPanel.webview.postMessage({
                command: 'updateAnnotations',
                annotations: this.serializeAnnotations()
            });
        }
    }

    public updateColumns(columns: Map<string, string>) {
        this.columns = columns;
        if (KanbanView.currentPanel) {
            KanbanView.currentPanel.webview.postMessage({
                command: 'updateColumns',
                columns: Array.from(columns.entries())
            });
        }
    }

    public moveAnnotation(annotationId: string, fromColumn: string, toColumn: string) {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (annotation) {
            annotation.kanbanColumn = toColumn;
            
            // Update annotation in the main system
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
                vscode.window.showWarningMessage(
                    localize('kanban.deleteColumnConfirm', 'Are you sure you want to delete this column? Annotations will be moved to "{0}".').replace('{0}', localize('kanban.column.todo', 'To Do')),
                    localize('delete', 'Delete'),
                    localize('cancel', 'Cancel')
                ).then(result => {
                    if (result === localize('delete', 'Delete')) {
                        vscode.commands.executeCommand('annotations.kanban.deleteColumn', message.id);
                    }
                });
                break;
            case 'openFile':
                vscode.commands.executeCommand('annotations.navigate', message.annotationId);
                break;
            case 'deleteAnnotation':
                vscode.window.showQuickPick([
                    { label: localize('kanban.removeFromKanbanOnly', 'Remove from Kanban only'), value: 'removeFromKanban', description: localize('kanban.removeFromKanbanOnlyDesc', 'The annotation will remain in the system') },
                    { label: localize('kanban.deleteCompletely', 'Delete completely'), value: 'delete', description: localize('kanban.deleteCompletelyDesc', 'Permanently delete the annotation') }
                ], {
                    placeHolder: localize('kanban.deleteAnnotationPrompt', 'What would you like to do with this annotation?'),
                    canPickMany: false
                }).then(selected => {
                    if (selected) {
                        if (selected.value === 'removeFromKanban') {
                            vscode.commands.executeCommand('annotations.kanban.removeFromKanban', message.annotationId);
                        } else if (selected.value === 'delete') {
                            vscode.window.showWarningMessage(
                                localize('kanban.deleteAnnotationConfirm', 'Are you sure you want to permanently delete this annotation?'),
                                localize('delete', 'Delete'),
                                localize('cancel', 'Cancel')
                            ).then(result => {
                                if (result === localize('delete', 'Delete')) {
                                    vscode.commands.executeCommand('annotations.kanban.delete', message.annotationId);
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
        return this.annotations.map(annotation => ({
            id: annotation.id,
            message: annotation.message,
            severity: annotation.severity || 'info',
            file: annotation.file?.split('/').pop() || localize('unknown', 'Unknown'),
            filePath: annotation.file,
            line: annotation.line,
            tags: annotation.tags || [],
            kanbanColumn: annotation.kanbanColumn || 'todo',
            timestamp: annotation.timestamp
        }));
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
            save: localize('save', 'Save')
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

                .filter-select {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 4px 8px;
                    border-radius: 3px;
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

                .card.dragging {
                    opacity: 0.5;
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
                        <select class="filter-select" id="severityFilter">
                            <option value="">${localizedStrings.allSeverities}</option>
                            <option value="error">${localizedStrings.error}</option>
                            <option value="warning">${localizedStrings.warning}</option>
                            <option value="info">${localizedStrings.info}</option>
                            <option value="hint">${localizedStrings.hint}</option>
                        </select>
                        <button class="add-column-btn" data-action="show-add-column-modal">${localizedStrings.addColumn}</button>
                    </div>
                </div>

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
                let searchTerm = '';
                let severityFilter = '';
                
                // Localized strings
                const localized = ${JSON.stringify(localizedStrings)};

                function init() {
                    renderStats();
                    renderBoard();
                    setupEventListeners();
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
                        renderBoard();
                    });

                    document.getElementById('severityFilter').addEventListener('change', (e) => {
                        severityFilter = e.target.value;
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
                        if (fromColumn && fromColumn !== toColumn) {
                            vscode.postMessage({
                                command: 'moveCard',
                                annotationId: annotationId,
                                fromColumn: fromColumn,
                                toColumn: toColumn
                            });
                        }
                        draggedCard.classList.remove('dragging');
                        draggedCard = null;
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
                    });
                }

                function createColumn(id, name, columnAnnotations) {
                    const column = document.createElement('div');
                    column.className = 'column';
                    column.dataset.columnId = id;

                    column.innerHTML = \`
                        <div class="column-header">
                            <div class="column-title">
                                <span>\${escapeHtml(name)}</span>
                                <span class="column-count">\${columnAnnotations.length}</span>
                            </div>
                            <div class="column-actions">
                                <button class="column-action-btn" data-action="rename" data-col-id="\${escapeHtml(id)}" data-col-name="\${escapeHtml(name)}" title="\${escapeHtml(localized.rename)}">&#9999;&#65039;</button>
                                <button class="column-action-btn" data-action="delete-col" data-col-id="\${escapeHtml(id)}" title="\${escapeHtml(localized.delete)}">&#128465;&#65039;</button>
                            </div>
                        </div>
                        <div class="cards-container">
                            \${columnAnnotations.length === 0 ?
                                '<div class="empty-column">' + escapeHtml(localized.dropAnnotationsHere) + '</div>' :
                                columnAnnotations.map(annotation => createCard(annotation)).join('')
                            }
                        </div>
                    \`;
                    column.querySelector('[data-action="rename"]')?.addEventListener('click', function() {
                        showRenameColumnModal(this.dataset.colId, this.dataset.colName);
                    });
                    column.querySelector('[data-action="delete-col"]')?.addEventListener('click', function() {
                        deleteColumn(this.dataset.colId);
                    });

                    return column;
                }

                function createCard(annotation) {
                    const date = new Date(annotation.timestamp);
                    const formattedDate = date.toLocaleDateString();
                    const safeId = escapeHtml(annotation.id);
                    const safeSeverity = escapeHtml(annotation.severity);

                    return \`
                        <div class="card" draggable="true" data-annotation-id="\${safeId}">
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
                                <div class="card-file">&#128196; \${escapeHtml(annotation.file)}:\${annotation.line}</div>
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