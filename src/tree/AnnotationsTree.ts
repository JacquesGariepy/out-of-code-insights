import * as vscode from 'vscode';
import { AnnotationManager } from '../managers/AnnotationManager';
import { Annotation } from '../common/types';
import { localize } from '../common/localize';
import { loc } from '../managers/LocalizationManager';

export class AnnotationsTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private annotationManager: AnnotationManager) {
        this.annotationManager.on('annotationChanged', this.refresh.bind(this));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        await this.annotationManager.waitUntilInitialized();
        const annotations = Array.from(this.annotationManager.annotations.values())
            .filter(a => this.annotationManager.shouldAnnotationBeVisible(a));

        const grouped = new Map<string, Annotation[]>();
        annotations.forEach(a => {
            if (!grouped.has(a.file)) grouped.set(a.file, []);
            grouped.get(a.file)?.push(a);
        });

        for (const [_file, arr] of grouped) {
            arr.sort((a, b) => a.line - b.line);
        }

        if (!element) {
            const navigateToPanelItem = new vscode.TreeItem(localize('openPanel', 'Show Annotations Panel'), vscode.TreeItemCollapsibleState.None);
            navigateToPanelItem.command = { command: 'annotations.show', title: localize('openPanel', 'Show Annotations Panel') };
            navigateToPanelItem.iconPath = new vscode.ThemeIcon('notebook-render-output');

            const groupedEntries = Array.from(grouped.entries()).map(([file, arr]) => new FileTreeItem(file, arr));
            return [navigateToPanelItem, ...groupedEntries];
        } else if (element instanceof FileTreeItem) {
            return element.annotations.map(a => new AnnotationTreeItem(a, this.annotationManager));
        }

        return [];
    }
}

export class FileTreeItem extends vscode.TreeItem {
    constructor(public readonly file: string, public readonly annotations: Annotation[]) {
        super(file, vscode.TreeItemCollapsibleState.Expanded);
        this.tooltip = loc('fileTooltip', `{0} ({1} annotations)`, file, annotations.length);
        this.description = loc('annotationCount', `{0} annotations`, annotations.length);
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.contextValue = 'file';
    }
}

export class AnnotationTreeItem extends vscode.TreeItem {
    constructor(public readonly annotation: Annotation, private annotationManager?: AnnotationManager) {
        super(annotation.message, vscode.TreeItemCollapsibleState.None);

        const date = new Date(annotation.timestamp);
        const formattedDate = date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
        const formattedTime = date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Add link indicator if annotation has links (outgoing or incoming)
        const hasOutgoingLinks = annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0;
        
        // Check for incoming links by finding annotations that link to this one
        let hasIncomingLinks = false;
        if (this.annotationManager) {
            const incomingLinks = Array.from(this.annotationManager.annotations.values()).filter(a => 
                a.linkedAnnotations && a.linkedAnnotations.some(link => 
                    link.targetFile === annotation.file && link.targetLine === annotation.line
                )
            );
            hasIncomingLinks = incomingLinks.length > 0;
        }
        
        const hasLinks = hasOutgoingLinks || hasIncomingLinks;
        const linkIndicator = hasLinks ? '🔗 ' : '';
        
        this.description = loc('annotationDescription', `{0}Line {1} • {2} • {3} • {4} {5}`, linkIndicator, annotation.line + 1, annotation.author || loc('anonymous', 'Anonymous'), annotation.severity || 'info', formattedDate, formattedTime);
        
        // Create enhanced tooltip with link information
        let tooltipContent = 
            loc('tooltipAuthor', `**Author:** {0}\n`, annotation.author || loc('anonymous', 'Anonymous')) +
            loc('tooltipDate', `**Date:** {0} {1}\n`, formattedDate, formattedTime) +
            loc('tooltipLine', `**Line:** {0}\n`, annotation.line + 1) +
            loc('tooltipSeverity', `**Severity:** {0}\n`, annotation.severity || 'info') +
            loc('tooltipComments', `**Comments:** {0}\n`, annotation.thread?.length || 0);
        
        if (hasOutgoingLinks || hasIncomingLinks) {
            if (hasOutgoingLinks) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                tooltipContent += loc('tooltipOutgoingLinks', `**Outgoing Links:** {0}\n`, annotation.linkedAnnotations!.length);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                annotation.linkedAnnotations!.forEach(link => {
                    tooltipContent += loc('tooltipLinkItem', `  • {0} → {1}:{2}\n`, link.relationship || loc('related', 'related'), link.targetFile, link.targetLine);
                });
            }
            
            if (hasIncomingLinks && this.annotationManager) {
                const incomingLinks = Array.from(this.annotationManager.annotations.values()).filter(a => 
                    a.linkedAnnotations && a.linkedAnnotations.some(link => 
                        link.targetFile === annotation.file && link.targetLine === annotation.line
                    )
                );
                
                if (incomingLinks.length > 0) {
                    tooltipContent += loc('tooltipIncomingLinks', `**Incoming Links:** {0}\n`, incomingLinks.length);
                    incomingLinks.forEach(source => {
                        const link = source.linkedAnnotations?.find(l => 
                            l.targetFile === annotation.file && l.targetLine === annotation.line
                        );
                        tooltipContent += loc('tooltipIncomingLinkItem', `  • {0} ← {1}:{2}\n`, link?.relationship || loc('related', 'related'), source.file, source.line);
                    });
                }
            }
        }
        
        tooltipContent += `\n${annotation.message}`;
        
        this.tooltip = new vscode.MarkdownString(tooltipContent);

        let iconName = 'comment';
        if (annotation.thread?.length) {
            iconName = 'comment-discussion';
        }

        switch (annotation.severity) {
            case 'error':
                iconName = annotation.thread?.length ? 'error' : 'error';
                break;
            case 'warning':
                iconName = annotation.thread?.length ? 'warning' : 'warning';
                break;
            case 'info':
            default:
                break;
        }

        this.iconPath = new vscode.ThemeIcon(iconName);
        this.contextValue = hasLinks ? 'annotation-linked' : 'annotation';
        this.resourceUri = vscode.Uri.parse(`annotation:${annotation.id}`);
        this.command = {
            command: 'annotations.navigate',
            title: loc('navigateToAnnotation', 'Navigate to Annotation'),
            arguments: [this.annotation.id]
        };
    }
}

export class AnnotationsDragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
    public readonly dropMimeTypes = ['application/vnd.code.tree.annotation'];
    public readonly dragMimeTypes = ['application/vnd.code.tree.annotation'];

    constructor(private annotationManager: AnnotationManager) {}

    async handleDrag(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
        const items = source.filter(s => s instanceof AnnotationTreeItem) as AnnotationTreeItem[];
        if (items.length > 0) {
            dataTransfer.set('application/vnd.code.tree.annotation', new vscode.DataTransferItem(items.map(i => i.annotation.id).join(',')));
        }
    }

    async handleDrop(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
        const transferItem = dataTransfer.get('application/vnd.code.tree.annotation');
        if (!transferItem) return;

        const draggedAnnotationIds = transferItem.value.split(',').filter((id: string) => id.trim().length > 0);
        if (draggedAnnotationIds.length === 0) return;

        const draggedAnnotations = draggedAnnotationIds
        .map((id: string) => this.annotationManager.annotations.get(id))
        .filter(Boolean) as Annotation[];
        if (draggedAnnotations.length === 0) return;

        let targetAnnotation: Annotation | undefined;
        let targetFile: string | undefined;

        if (target instanceof AnnotationTreeItem) {
            targetAnnotation = target.annotation;
            targetFile = target.annotation.file;
        } else if (target instanceof FileTreeItem) {
            targetFile = target.file;
        } else {
            return;
        }

        const allSameFile = draggedAnnotations.every(a => a.file === draggedAnnotations[0].file);
        if (!allSameFile) {
            vscode.window.showErrorMessage(localize('cannotReorderDifferentFiles', 'Cannot reorder annotations from different files together.'));
            return;
        }

        const draggedFile = draggedAnnotations[0].file;
        if (targetFile && targetFile !== draggedFile) {
            vscode.window.showErrorMessage(localize('cannotMoveToDifferentFile', 'Cannot move annotations to a different file via drag and drop.'));
            return;
        }

        const fileAnnotations = Array.from(this.annotationManager.annotations.values())
            .filter(a => a.file === draggedFile)
            .sort((a, b) => a.line - b.line);

        draggedAnnotations.forEach(da => {
            const index = fileAnnotations.findIndex(fa => fa.id === da.id);
            if (index >= 0) fileAnnotations.splice(index, 1);
        });

        let targetIndex: number;
        if (targetAnnotation) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const idx = fileAnnotations.findIndex(a => a.id === targetAnnotation!.id);
            targetIndex = idx >= 0 ? idx : fileAnnotations.length;
        } else {
            targetIndex = fileAnnotations.length;
        }

        fileAnnotations.splice(targetIndex + 1, 0, ...draggedAnnotations);
        fileAnnotations.forEach((a, i) => {
            a.line = i;
        });

        await this.annotationManager.saveAnnotations();
        await this.annotationManager.refreshAnnotations();
        this.annotationManager.emit('annotationChanged');
        vscode.window.showInformationMessage(localize('annotationsReordered', 'Annotations reordered successfully.'));
    }
}
