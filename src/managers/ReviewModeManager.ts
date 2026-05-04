import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { Annotation, ReviewState } from '../common/types';
import { AnnotationManager } from './AnnotationManager';
import { localize } from '../common/localize';
import { escapeHtml, generateNonce } from '../common/utils';

export interface ReviewFilter {
    authors?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    severities?: string[];
    resolved?: boolean;
    tags?: string[];
}

export interface ReviewStatistics {
    total: number;
    viewed: number;
    unviewed: number;
    byAuthor: Map<string, number>;
    bySeverity: Map<string, number>;
    resolved: number;
    unresolved: number;
}

export class ReviewModeManager extends EventEmitter {
    private isActive = false;
    private currentIndex = -1;
    private filteredAnnotations: Annotation[] = [];
    private activeFilter: ReviewFilter = {};
    private statusBarItem: vscode.StatusBarItem;
    private reviewPanel?: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly annotationManager: AnnotationManager
    ) {
        super();
        
        // Create status bar item for review progress
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'annotations.stopReview';
        this.disposables.push(this.statusBarItem);
        
        // Register commands
        this.registerCommands();
        
        // Listen to annotation changes
        this.annotationManager.on('annotationChanged', () => {
            if (this.isActive) {
                this.updateFilteredAnnotations();
            }
        });
    }
    
    private registerCommands(): void {
        // Start review mode
        this.disposables.push(
            vscode.commands.registerCommand('annotations.startReview', () => {
                this.startReview();
            })
        );
        
        // Stop review mode
        this.disposables.push(
            vscode.commands.registerCommand('annotations.stopReview', () => {
                this.stopReview();
            })
        );
        
        // Navigate next (F8)
        this.disposables.push(
            vscode.commands.registerCommand('annotations.nextAnnotation', () => {
                if (this.isActive) {
                    this.navigateNext();
                }
            })
        );
        
        // Navigate previous (Shift+F8)
        this.disposables.push(
            vscode.commands.registerCommand('annotations.previousAnnotation', () => {
                if (this.isActive) {
                    this.navigatePrevious();
                }
            })
        );
        
        // Mark as viewed
        this.disposables.push(
            vscode.commands.registerCommand('annotations.markAsViewed', () => {
                if (this.isActive && this.currentIndex >= 0) {
                    const annotation = this.filteredAnnotations[this.currentIndex];
                    if (annotation) {
                        this.markAsViewed(annotation.id);
                    }
                }
            })
        );
        
        // Show filter panel
        this.disposables.push(
            vscode.commands.registerCommand('annotations.reviewMode.filter', () => {
                this.showFilterPanel();
            })
        );
    }
    
    public async startReview(filter?: ReviewFilter): Promise<void> {
        this.isActive = true;
        this.activeFilter = filter || {};
        
        // Update filtered annotations
        await this.updateFilteredAnnotations();
        
        if (this.filteredAnnotations.length === 0) {
            vscode.window.showInformationMessage(
                localize('reviewMode.noAnnotations', 'No annotations found matching the filter criteria.')
            );
            this.stopReview();
            return;
        }
        
        // Start from the first annotation
        this.currentIndex = 0;
        
        // Navigate to the first annotation
        await this.navigateToCurrentAnnotation();
        
        // Update status bar
        this.updateStatusBar();
        
        // Show review panel
        this.showReviewPanel();
        
        // Emit event
        this.emit('reviewStarted', {
            totalAnnotations: this.filteredAnnotations.length,
            filter: this.activeFilter
        });
        
        vscode.window.showInformationMessage(
            localize('reviewMode.started', 'Review mode started. Use F8/Shift+F8 to navigate.')
        );
    }
    
    public stopReview(): void {
        this.isActive = false;
        this.currentIndex = -1;
        this.filteredAnnotations = [];
        
        // Hide status bar
        this.statusBarItem.hide();
        
        // Close review panel
        if (this.reviewPanel) {
            this.reviewPanel.dispose();
            this.reviewPanel = undefined;
        }
        
        // Emit event
        this.emit('reviewStopped');
        
        vscode.window.showInformationMessage(
            localize('reviewMode.stopped', 'Review mode stopped.')
        );
    }
    
    public async navigateNext(): Promise<void> {
        if (!this.isActive || this.filteredAnnotations.length === 0) {
            return;
        }
        
        const previousIndex = this.currentIndex;
        this.currentIndex = (this.currentIndex + 1) % this.filteredAnnotations.length;
        
        await this.navigateToCurrentAnnotation();
        
        // Emit navigation event
        this.emit('navigationChanged', {
            from: previousIndex,
            to: this.currentIndex,
            annotation: this.filteredAnnotations[this.currentIndex]
        });
    }
    
    public async navigatePrevious(): Promise<void> {
        if (!this.isActive || this.filteredAnnotations.length === 0) {
            return;
        }
        
        const previousIndex = this.currentIndex;
        this.currentIndex = this.currentIndex - 1;
        if (this.currentIndex < 0) {
            this.currentIndex = this.filteredAnnotations.length - 1;
        }
        
        await this.navigateToCurrentAnnotation();
        
        // Emit navigation event
        this.emit('navigationChanged', {
            from: previousIndex,
            to: this.currentIndex,
            annotation: this.filteredAnnotations[this.currentIndex]
        });
    }
    
    public async markAsViewed(annotationId: string): Promise<void> {
        const annotation = this.annotationManager.annotations.get(annotationId);
        if (!annotation) {
            return;
        }
        
        // Update review state
        const reviewState: ReviewState = {
            viewed: true,
            viewedBy: this.annotationManager.config.username || 'Unknown',
            viewedAt: new Date().toISOString()
        };
        
        annotation.reviewState = reviewState;
        
        // Save annotations
        await this.annotationManager.saveAnnotations();
        
        // Update UI
        this.updateStatusBar();
        this.updateReviewPanel();
        
        // Emit event
        this.emit('annotationViewed', {
            annotationId,
            reviewState
        });
    }
    
    public async applyFilter(filter: ReviewFilter): Promise<void> {
        this.activeFilter = filter;
        
        if (this.isActive) {
            await this.updateFilteredAnnotations();
            
            // Reset to first annotation if any exist
            if (this.filteredAnnotations.length > 0) {
                this.currentIndex = 0;
                await this.navigateToCurrentAnnotation();
            } else {
                vscode.window.showInformationMessage(
                    localize('reviewMode.noMatchingAnnotations', 'No annotations match the current filter.')
                );
                this.stopReview();
            }
        }
        
        // Emit event
        this.emit('filterApplied', filter);
    }
    
    public getReviewStatistics(): ReviewStatistics {
        const allAnnotations = Array.from(this.annotationManager.annotations.values());
        
        const stats: ReviewStatistics = {
            total: allAnnotations.length,
            viewed: 0,
            unviewed: 0,
            byAuthor: new Map(),
            bySeverity: new Map(),
            resolved: 0,
            unresolved: 0
        };
        
        for (const annotation of allAnnotations) {
            // Count viewed/unviewed
            if (annotation.reviewState?.viewed) {
                stats.viewed++;
            } else {
                stats.unviewed++;
            }
            
            // Count by author
            const author = annotation.author || 'Unknown';
            stats.byAuthor.set(author, (stats.byAuthor.get(author) || 0) + 1);
            
            // Count by severity
            const severity = annotation.severity || 'info';
            stats.bySeverity.set(severity, (stats.bySeverity.get(severity) || 0) + 1);
            
            // Count resolved/unresolved
            if (annotation.resolved) {
                stats.resolved++;
            } else {
                stats.unresolved++;
            }
        }
        
        return stats;
    }
    
    private async updateFilteredAnnotations(): Promise<void> {
        const allAnnotations = Array.from(this.annotationManager.annotations.values());
        
        this.filteredAnnotations = allAnnotations.filter(annotation => {
            // Filter by author
            if (this.activeFilter.authors && this.activeFilter.authors.length > 0) {
                const author = annotation.author || 'Unknown';
                if (!this.activeFilter.authors.includes(author)) {
                    return false;
                }
            }
            
            // Filter by date range
            if (this.activeFilter.dateFrom) {
                const annotationDate = new Date(annotation.timestamp);
                if (annotationDate < this.activeFilter.dateFrom) {
                    return false;
                }
            }
            
            if (this.activeFilter.dateTo) {
                const annotationDate = new Date(annotation.timestamp);
                if (annotationDate > this.activeFilter.dateTo) {
                    return false;
                }
            }
            
            // Filter by severity
            if (this.activeFilter.severities && this.activeFilter.severities.length > 0) {
                const severity = annotation.severity || 'info';
                if (!this.activeFilter.severities.includes(severity)) {
                    return false;
                }
            }
            
            // Filter by resolved state
            if (this.activeFilter.resolved !== undefined) {
                if (annotation.resolved !== this.activeFilter.resolved) {
                    return false;
                }
            }
            
            // Filter by tags
            if (this.activeFilter.tags && this.activeFilter.tags.length > 0) {
                const annotationTags = annotation.tags || [];
                const hasMatchingTag = this.activeFilter.tags.some(tag => 
                    annotationTags.includes(tag)
                );
                if (!hasMatchingTag) {
                    return false;
                }
            }
            
            return true;
        });
        
        // Sort by file and line number
        this.filteredAnnotations.sort((a, b) => {
            if (a.file !== b.file) {
                return a.file.localeCompare(b.file);
            }
            return a.line - b.line;
        });
        
        this.updateStatusBar();
    }
    
    private async navigateToCurrentAnnotation(): Promise<void> {
        if (this.currentIndex < 0 || this.currentIndex >= this.filteredAnnotations.length) {
            return;
        }
        
        const annotation = this.filteredAnnotations[this.currentIndex];
        
        // Navigate to the annotation
        await this.annotationManager.navigateToAnnotation(annotation.id, false);
        
        // Auto-mark as viewed after a delay
        setTimeout(() => {
            if (!annotation.reviewState?.viewed) {
                this.markAsViewed(annotation.id);
            }
        }, 1000);
        
        this.updateStatusBar();
        this.updateReviewPanel();
    }
    
    private updateStatusBar(): void {
        if (!this.isActive) {
            this.statusBarItem.hide();
            return;
        }
        
        const current = this.currentIndex + 1;
        const total = this.filteredAnnotations.length;
        const viewed = this.filteredAnnotations.filter(a => a.reviewState?.viewed).length;
        
        this.statusBarItem.text = `$(checklist) Review: ${current}/${total} (${viewed} viewed)`;
        this.statusBarItem.tooltip = localize(
            'reviewMode.statusTooltip',
            'Click to toggle review mode. F8: Next, Shift+F8: Previous'
        );
        this.statusBarItem.show();
    }
    
    private showReviewPanel(): void {
        if (!this.reviewPanel) {
            this.reviewPanel = vscode.window.createWebviewPanel(
                'annotationReview',
                localize('reviewMode.panelTitle', 'Annotation Review'),
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );
            
            this.reviewPanel.onDidDispose(() => {
                this.reviewPanel = undefined;
            });
            
            // Handle messages from the webview
            this.reviewPanel.webview.onDidReceiveMessage(
                message => {
                    switch (message.command) {
                        case 'previous':
                            this.navigatePrevious();
                            break;
                        case 'next':
                            this.navigateNext();
                            break;
                        case 'markViewed':
                            if (this.currentIndex >= 0) {
                                const annotation = this.filteredAnnotations[this.currentIndex];
                                if (annotation) {
                                    this.markAsViewed(annotation.id);
                                }
                            }
                            break;
                    }
                },
                undefined,
                this.disposables
            );
        }
        
        this.updateReviewPanel();
    }
    
    private updateReviewPanel(): void {
        if (!this.reviewPanel || this.currentIndex < 0) {
            return;
        }
        
        const annotation = this.filteredAnnotations[this.currentIndex];
        const stats = this.getReviewStatistics();
        
        this.reviewPanel.webview.html = this.getReviewPanelContent(annotation, stats);
    }
    
    private getReviewPanelContent(annotation: Annotation, stats: ReviewStatistics): string {
        const viewedStatus = annotation.reviewState?.viewed
            ? `<span style="color: green;">\u{2713} Viewed</span>`
            : `<span style="color: orange;">\u{26A0} Not viewed</span>`;
        const reviewNonce = generateNonce();

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${reviewNonce}'; img-src data:;">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Annotation Review</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                }
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }
                .annotation-details {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 15px;
                    border-radius: 5px;
                    margin-bottom: 20px;
                }
                .stats {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 10px;
                }
                .stat-item {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 10px;
                    border-radius: 5px;
                }
                .navigation {
                    display: flex;
                    justify-content: center;
                    gap: 10px;
                    margin-top: 20px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 3px;
                    cursor: pointer;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>Annotation ${this.currentIndex + 1} of ${this.filteredAnnotations.length}</h2>
                ${viewedStatus}
            </div>
            
            <div class="annotation-details">
                <p><strong>File:</strong> ${escapeHtml(annotation.file)}:${annotation.line}</p>
                <p><strong>Author:</strong> ${escapeHtml(annotation.author || 'Unknown')}</p>
                <p><strong>Date:</strong> ${new Date(annotation.timestamp).toLocaleString()}</p>
                <p><strong>Severity:</strong> ${escapeHtml(annotation.severity || 'info')}</p>
                <p><strong>Message:</strong> ${escapeHtml(annotation.message)}</p>
                ${annotation.tags ? `<p><strong>Tags:</strong> ${annotation.tags.map(t => escapeHtml(t)).join(', ')}</p>` : ''}
            </div>
            
            <h3>Review Statistics</h3>
            <div class="stats">
                <div class="stat-item">
                    <strong>Total Annotations:</strong> ${stats.total}
                </div>
                <div class="stat-item">
                    <strong>Viewed:</strong> ${stats.viewed} (${Math.round((stats.viewed / stats.total) * 100)}%)
                </div>
                <div class="stat-item">
                    <strong>Resolved:</strong> ${stats.resolved}
                </div>
                <div class="stat-item">
                    <strong>Unresolved:</strong> ${stats.unresolved}
                </div>
            </div>
            
            <div class="navigation">
                <button data-action="previous">\u{2190} Previous (Shift+F8)</button>
                <button data-action="markViewed">Mark as Viewed</button>
                <button data-action="next">Next (F8) \u{2192}</button>
            </div>

            <script nonce="${reviewNonce}">
                const vscode = acquireVsCodeApi();

                document.addEventListener('click', function(e) {
                    const btn = e.target.closest('[data-action]');
                    if (btn) {
                        vscode.postMessage({ command: btn.dataset.action });
                    }
                });
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'updateContent':
                            // Update panel content
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
    
    private async showFilterPanel(): Promise<void> {
        const stats = this.getReviewStatistics();
        
        // Get unique authors
        const authors = Array.from(stats.byAuthor.keys());
        
        // Get unique severities
        const severities = Array.from(stats.bySeverity.keys());
        
        // Get unique tags
        const allTags = new Set<string>();
        for (const annotation of this.annotationManager.annotations.values()) {
            if (annotation.tags) {
                annotation.tags.forEach(tag => allTags.add(tag));
            }
        }
        
        // Show quick pick for filter options
        const filterOptions = [
            { label: '$(account) Filter by Author', value: 'author' },
            { label: '$(calendar) Filter by Date Range', value: 'date' },
            { label: '$(warning) Filter by Severity', value: 'severity' },
            { label: '$(check) Filter by Resolved State', value: 'resolved' },
            { label: '$(tag) Filter by Tags', value: 'tags' },
            { label: '$(clear-all) Clear All Filters', value: 'clear' }
        ];
        
        const selected = await vscode.window.showQuickPick(filterOptions, {
            placeHolder: localize('reviewMode.selectFilterType', 'Select filter type')
        });
        
        if (!selected) {
            return;
        }
        
        const newFilter: ReviewFilter = { ...this.activeFilter };
        
        switch (selected.value) {
            case 'author': {
                const selectedAuthors = await vscode.window.showQuickPick(
                    authors.map(a => ({ label: a, picked: this.activeFilter.authors?.includes(a) })),
                    {
                        placeHolder: localize('reviewMode.selectAuthors', 'Select authors to filter'),
                        canPickMany: true
                    }
                );
                if (selectedAuthors) {
                    newFilter.authors = selectedAuthors.map(a => a.label);
                }
                break;
            }

            case 'date': {
                const days = await vscode.window.showInputBox({
                    prompt: localize('reviewMode.daysPrompt', 'Show annotations from the last N days (leave empty for all)'),
                    validateInput: (value) => {
                        if (value && isNaN(parseInt(value))) {
                            return localize('reviewMode.invalidNumber', 'Please enter a valid number');
                        }
                        return null;
                    }
                });
                if (days) {
                    const daysNum = parseInt(days);
                    newFilter.dateFrom = new Date();
                    newFilter.dateFrom.setDate(newFilter.dateFrom.getDate() - daysNum);
                }
                break;
            }

            case 'severity': {
                const selectedSeverities = await vscode.window.showQuickPick(
                    severities.map(s => ({ label: s, picked: this.activeFilter.severities?.includes(s) })),
                    {
                        placeHolder: localize('reviewMode.selectSeverities', 'Select severities to filter'),
                        canPickMany: true
                    }
                );
                if (selectedSeverities) {
                    newFilter.severities = selectedSeverities.map(s => s.label);
                }
                break;
            }

            case 'resolved': {
                const resolvedOption = await vscode.window.showQuickPick([
                    { label: 'Show All', value: undefined },
                    { label: 'Only Resolved', value: true },
                    { label: 'Only Unresolved', value: false }
                ], {
                    placeHolder: localize('reviewMode.selectResolved', 'Select resolved state')
                });
                if (resolvedOption) {
                    newFilter.resolved = resolvedOption.value;
                }
                break;
            }

            case 'tags': {
                const selectedTags = await vscode.window.showQuickPick(
                    Array.from(allTags).map(t => ({ label: t, picked: this.activeFilter.tags?.includes(t) })),
                    {
                        placeHolder: localize('reviewMode.selectTags', 'Select tags to filter'),
                        canPickMany: true
                    }
                );
                if (selectedTags) {
                    newFilter.tags = selectedTags.map(t => t.label);
                }
                break;
            }
                
            case 'clear':
                await this.applyFilter({});
                return;
        }
        
        await this.applyFilter(newFilter);
    }
    
    public dispose(): void {
        this.stopReview();
        
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        
        this.removeAllListeners();
    }
}