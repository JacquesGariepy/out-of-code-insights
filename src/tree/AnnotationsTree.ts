// SPDX-License-Identifier: MPL-2.0
//
// Tree provider for the Annotations side panel. Lot 5 R2 worktree A:
// migrated from AnnotationManager to AnnotationStore + VisibilityFilter
// (+ AnnotationPersistence for the drag-and-drop reorder save path).
//
// Display-line resolution for AnnotationV2 (which stores offsets, not
// lines) goes through `store.getLineForAnnotation(id, openDocs)` against
// `vscode.workspace.textDocuments`. Closed-file annotations fall back to
// `null`, which the UI renders as `?`.

import * as vscode from 'vscode';
import { ANNOTATION_DRAG_MIME } from '../commands/AnnotationMoveService';
import { loc } from '../managers/LocalizationManager';
import type { AnnotationV2 } from '../transactional/types';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { VisibilityFilter } from '../transactional/VisibilityFilter';

/** Line+annotation pair used by the tree to render with already-resolved lines. */
interface ResolvedAnnotation {
    annotation: AnnotationV2;
    /** 0-based; `null` when no open document carries the file. */
    line: number | null;
}

export class AnnotationsTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly store: AnnotationStore,
        private readonly visibilityFilter: VisibilityFilter
    ) {
        this.subscriptions.push(this.store.onDidChange(() => this.refresh()));
        this.subscriptions.push(this.store.onDidSuspend(() => this.refresh()));
        this.subscriptions.push(this.store.onDidResume(() => this.refresh()));
        this.subscriptions.push(this.store.onDidDispose(() => this.refresh()));
        this.subscriptions.push(this.visibilityFilter.onDidChange(() => this.refresh()));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        for (const sub of this.subscriptions) {
            sub.dispose();
        }
        this.subscriptions.length = 0;
        this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getStats(): AnnotationTreeStats {
        const all = this.store.list();
        const visible = all.filter((annotation) => this.visibilityFilter.isVisible(annotation));
        return {
            total: all.length,
            visible: visible.length,
            open: visible.filter((annotation) => !annotation.resolved).length,
            resolved: visible.filter((annotation) => annotation.resolved).length,
            attention: visible.filter((annotation) =>
                ['warning', 'error', 'critical'].includes(annotation.severity ?? 'info')
            ).length,
            files: new Set(visible.map((annotation) => annotation.file)).size,
        };
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        await this.store.waitUntilInitialized();

        const openDocs = vscode.workspace.textDocuments;
        const resolved: ResolvedAnnotation[] = this.store
            .list()
            .filter((a) => this.visibilityFilter.isVisible(a))
            .map((annotation) => ({
                annotation,
                line: this.store.getLineForAnnotation(annotation.id, openDocs),
            }));

        const grouped = new Map<string, ResolvedAnnotation[]>();
        for (const r of resolved) {
            const bucket = grouped.get(r.annotation.file);
            if (bucket) {
                bucket.push(r);
            } else {
                grouped.set(r.annotation.file, [r]);
            }
        }

        for (const [, arr] of grouped) {
            arr.sort((a, b) => a.annotation.startOffset - b.annotation.startOffset);
        }

        if (!element) {
            const groupedEntries = Array.from(grouped.entries()).map(([file, arr]) => new FileTreeItem(file, arr));
            return groupedEntries.sort((left, right) => left.file.localeCompare(right.file));
        }
        if (element instanceof FileTreeItem) {
            return element.entries.map((e) => new AnnotationTreeItem(e.annotation, e.line, resolved));
        }
        return [];
    }
}

export interface AnnotationTreeStats {
    total: number;
    visible: number;
    open: number;
    resolved: number;
    attention: number;
    files: number;
}

export class FileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly file: string,
        public readonly entries: ResolvedAnnotation[]
    ) {
        super(file, vscode.TreeItemCollapsibleState.Expanded);
        const resolved = entries.filter(({ annotation }) => annotation.resolved).length;
        const attention = entries.filter(({ annotation }) =>
            ['warning', 'error', 'critical'].includes(annotation.severity ?? 'info')
        ).length;
        const open = entries.length - resolved;
        this.tooltip = new vscode.MarkdownString(
            loc(
                'fileTreeTooltip',
                `**{0}**\n\n{1} open · {2} resolved · {3} need attention\n\nDrop annotations here to choose a destination line.`,
                file,
                open,
                resolved,
                attention
            )
        );
        this.description = loc('fileTreeDescription', `{0} open · {1} resolved`, open, resolved);
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.contextValue = 'file';
        this.accessibilityInformation = {
            label: loc('fileTreeAccessibility', '{0}, {1} annotations, {2} open', file, entries.length, open),
            role: 'treeitem',
        };
    }
}

export class AnnotationTreeItem extends vscode.TreeItem {
    constructor(
        public readonly annotation: AnnotationV2,
        public readonly resolvedLine: number | null,
        siblings: readonly ResolvedAnnotation[] = []
    ) {
        const firstLine = annotation.message
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        const summary = firstLine && firstLine.length > 96 ? `${firstLine.slice(0, 93)}…` : firstLine || annotation.id;
        super(summary, vscode.TreeItemCollapsibleState.None);

        const date = new Date(annotation.timestamp);
        const formattedDate = date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
        const formattedTime = date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        });

        const hasOutgoingLinks = !!annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0;

        // Incoming links: any sibling annotation linking to *this* file/line.
        // We compute against resolved lines so closed-file annotations stop
        // matching once their line drops out of the open-document set.
        let hasIncomingLinks = false;
        const incomingLinkers: ResolvedAnnotation[] = [];
        if (resolvedLine !== null) {
            for (const sib of siblings) {
                const links = sib.annotation.linkedAnnotations ?? [];
                if (links.some((link) => link.targetFile === annotation.file && link.targetLine === resolvedLine)) {
                    incomingLinkers.push(sib);
                }
            }
            hasIncomingLinks = incomingLinkers.length > 0;
        }

        const hasLinks = hasOutgoingLinks || hasIncomingLinks;

        const lineLabel = resolvedLine === null ? '?' : String(resolvedLine + 1);
        const stateLabel = annotation.resolved ? loc('resolved', 'resolved') : loc('open', 'open');
        const replyCount = annotation.thread?.length ?? 0;

        this.description = loc(
            'annotationTreeDescription',
            `L{0} · {1} · {2}{3}`,
            lineLabel,
            annotation.severity || 'info',
            stateLabel,
            replyCount > 0 ? loc('treeReplySuffix', ' · {0} replies', replyCount) : ''
        );

        let tooltipContent =
            loc('tooltipAuthor', `**Author:** {0}\n`, annotation.author || loc('anonymous', 'Anonymous')) +
            loc('tooltipDate', `**Date:** {0} {1}\n`, formattedDate, formattedTime) +
            loc('tooltipLine', `**Line:** {0}\n`, lineLabel) +
            loc('tooltipSeverity', `**Severity:** {0}\n`, annotation.severity || 'info') +
            loc('tooltipComments', `**Comments:** {0}\n`, annotation.thread?.length || 0);

        if (hasOutgoingLinks && annotation.linkedAnnotations) {
            tooltipContent += loc(
                'tooltipOutgoingLinks',
                `**Outgoing Links:** {0}\n`,
                annotation.linkedAnnotations.length
            );
            for (const link of annotation.linkedAnnotations) {
                tooltipContent += loc(
                    'tooltipLinkItem',
                    `  • {0} → {1}:{2}\n`,
                    link.relationship || loc('related', 'related'),
                    link.targetFile,
                    link.targetLine
                );
            }
        }

        if (hasIncomingLinks) {
            tooltipContent += loc('tooltipIncomingLinks', `**Incoming Links:** {0}\n`, incomingLinkers.length);
            for (const source of incomingLinkers) {
                const link = source.annotation.linkedAnnotations?.find(
                    (l) => l.targetFile === annotation.file && l.targetLine === resolvedLine
                );
                const sourceLineLabel = source.line === null ? '?' : String(source.line + 1);
                tooltipContent += loc(
                    'tooltipIncomingLinkItem',
                    `  • {0} ← {1}:{2}\n`,
                    link?.relationship || loc('related', 'related'),
                    source.annotation.file,
                    sourceLineLabel
                );
            }
        }

        tooltipContent += `\n${annotation.message}`;
        tooltipContent += loc(
            'annotationDragTooltip',
            '\n\n---\nDrag onto another annotation to move it while preserving its identity.'
        );
        this.tooltip = new vscode.MarkdownString(tooltipContent);

        let iconName = 'comment';
        if (annotation.thread?.length) {
            iconName = 'comment-discussion';
        }
        switch (annotation.severity) {
            case 'error':
                iconName = 'error';
                break;
            case 'warning':
                iconName = 'warning';
                break;
            case 'info':
            default:
                break;
        }

        const iconColor = annotation.resolved
            ? new vscode.ThemeColor('testing.iconPassed')
            : annotation.severity === 'error' || annotation.severity === 'critical'
              ? new vscode.ThemeColor('problemsErrorIcon.foreground')
              : annotation.severity === 'warning'
                ? new vscode.ThemeColor('problemsWarningIcon.foreground')
                : annotation.pinned
                  ? new vscode.ThemeColor('charts.yellow')
                  : undefined;
        this.iconPath = new vscode.ThemeIcon(iconName, iconColor);
        this.checkboxState = annotation.resolved
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        this.contextValue = hasLinks ? 'annotation-linked' : 'annotation';
        this.resourceUri = vscode.Uri.parse(`annotation:${annotation.id}`);
        this.accessibilityInformation = {
            label: loc(
                'annotationTreeAccessibility',
                '{0}, line {1}, severity {2}, {3}',
                summary,
                lineLabel,
                annotation.severity || 'info',
                stateLabel
            ),
            role: 'treeitem',
        };
        this.command = {
            command: 'annotations.navigate',
            title: loc('navigateToAnnotation', 'Navigate to Annotation'),
            arguments: [this.annotation.id],
        };
    }
}

export class AnnotationsDragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
    public readonly dropMimeTypes = [ANNOTATION_DRAG_MIME];
    public readonly dragMimeTypes = [ANNOTATION_DRAG_MIME];

    async handleDrag(
        source: vscode.TreeItem[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const items = source.filter((s) => s instanceof AnnotationTreeItem) as AnnotationTreeItem[];
        if (items.length > 0) {
            dataTransfer.set(
                ANNOTATION_DRAG_MIME,
                new vscode.DataTransferItem(
                    JSON.stringify({ version: 1, ids: items.map((item) => item.annotation.id) })
                )
            );
        }
    }

    async handleDrop(
        target: vscode.TreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const transferItem = dataTransfer.get(ANNOTATION_DRAG_MIME);
        if (!transferItem) {
            return;
        }

        const draggedAnnotationIds = parseAnnotationDragIds(transferItem.value);
        if (draggedAnnotationIds.length === 0) {
            return;
        }

        if (target instanceof AnnotationTreeItem) {
            await vscode.commands.executeCommand('annotations.moveByDragAndDrop', {
                ids: draggedAnnotationIds,
                targetAnnotationId: target.annotation.id,
            });
        } else if (target instanceof FileTreeItem) {
            await vscode.commands.executeCommand('annotations.moveByDragAndDrop', {
                ids: draggedAnnotationIds,
                targetFile: target.file,
            });
        }
    }
}

export function parseAnnotationDragIds(value: unknown): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    try {
        const payload = JSON.parse(value) as { ids?: unknown };
        if (Array.isArray(payload.ids)) {
            return payload.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
        }
    } catch {
        // v1.4.0 and earlier encoded ids as a comma-separated string.
    }
    return value.split(',').filter((id) => id.trim().length > 0);
}
