// SPDX-License-Identifier: MPL-2.0
import * as vscode from 'vscode';
import { AnnotationMoveService } from './AnnotationMoveService';
import { loc } from '../managers/LocalizationManager';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { VisibilityFilter } from '../transactional/VisibilityFilter';
import { getLogger } from '../utils/logger';

export interface AnnotationEditorMoveControllerOptions {
    registerCommands?: boolean;
    visibilityFilter?: VisibilityFilter;
    selectedIds?: () => readonly string[];
}

/** Native pick-up/drop interaction for annotations rendered inside the editor. */
export class AnnotationEditorMoveController implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly targetDecoration: vscode.TextEditorDecorationType;
    private readonly visibilityFilter?: VisibilityFilter;
    private readonly selectedIds: () => readonly string[];
    private pickedUpIds: string[] = [];

    constructor(
        private readonly store: AnnotationStore,
        private readonly moveService: AnnotationMoveService,
        options: AnnotationEditorMoveControllerOptions | boolean = {}
    ) {
        const resolvedOptions = typeof options === 'boolean' ? { registerCommands: options } : options;
        this.visibilityFilter = resolvedOptions.visibilityFilter;
        this.selectedIds = resolvedOptions.selectedIds ?? (() => []);
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
        this.statusBarItem.name = loc('annotationMoveStatusName', 'Annotation move destination');
        this.statusBarItem.command = 'annotations.dropPickedAtCursor';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.targetDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
            borderColor: new vscode.ThemeColor('editorInfo.foreground'),
            borderStyle: 'dashed',
            borderWidth: '1px 0',
            overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
            overviewRulerLane: vscode.OverviewRulerLane.Full,
        });

        this.subscriptions.push(this.statusBarItem, this.targetDecoration);
        if (resolvedOptions.registerCommands !== false) {
            this.subscriptions.push(
                vscode.commands.registerCommand('annotations.pickUpForMove', (arg?: unknown) => this.pickUp(arg)),
                vscode.commands.registerCommand('annotations.dropPickedAtCursor', () => this.dropAtCursor()),
                vscode.commands.registerCommand('annotations.cancelPickedMove', () => this.cancel())
            );
        }
        this.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection((event) => {
                if (this.pickedUpIds.length > 0) {
                    this.renderTarget(event.textEditor, event.selections[0]?.active);
                }
            }),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (this.pickedUpIds.length > 0 && editor) {
                    this.renderTarget(editor, editor.selection.active);
                }
            })
        );
    }

    async pickUp(arg?: unknown): Promise<number> {
        const ids = this.resolveIds(arg);
        if (ids.length === 0) {
            vscode.window.showInformationMessage(
                loc('noAnnotationToPickUp', 'Place the cursor on an annotation before starting a move.')
            );
            return 0;
        }
        this.pickedUpIds = ids;
        await vscode.commands.executeCommand('setContext', 'outOfCodeInsights.annotationMoveActive', true);
        this.statusBarItem.text = loc(
            'annotationMoveStatus',
            '$(move) Moving {0} annotation(s) - Enter to drop, Esc to cancel',
            ids.length
        );
        this.statusBarItem.tooltip = loc(
            'annotationMoveStatusTooltip',
            'Move the cursor to the destination line, then press Enter or click this status item.'
        );
        this.statusBarItem.show();
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.renderTarget(editor, editor.selection.active);
        }
        vscode.window.setStatusBarMessage(
            loc('annotationPickedUp', 'Annotation picked up. Move the cursor and press Enter to drop.'),
            5000
        );
        return ids.length;
    }

    async dropAtCursor(): Promise<number> {
        const editor = vscode.window.activeTextEditor;
        if (this.pickedUpIds.length === 0 || !editor) {
            return 0;
        }
        if (!this.isSupportedTarget(editor.document)) {
            void vscode.window.showWarningMessage(
                loc(
                    'annotationMoveFileTargetRequired',
                    'Choose a saved file inside the current workspace before dropping the annotation.'
                )
            );
            return 0;
        }
        const ids = [...this.pickedUpIds];
        const line = editor.selection.active.line;
        try {
            const result = await this.moveService.move({
                ids,
                targetFile: vscode.workspace.asRelativePath(editor.document.uri),
                targetUri: editor.document.uri.toString(),
                targetLine: line,
            });
            this.clear();
            if (!result) {
                return 0;
            }
            vscode.window.setStatusBarMessage(
                loc(
                    'annotationsDroppedAtCursor',
                    'Moved {0} annotation(s) to {1}, line {2}.',
                    result.movedIds.length,
                    result.file,
                    result.firstLine + 1
                ),
                5000
            );
            return result.movedIds.length;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            getLogger().error('Unable to drop picked-up annotations at the cursor', error);
            vscode.window.showErrorMessage(loc('annotationMoveFailed', 'Unable to move annotations: {0}', message));
            return 0;
        }
    }

    async cancel(): Promise<void> {
        if (this.pickedUpIds.length === 0) {
            return;
        }
        this.clear();
        vscode.window.setStatusBarMessage(loc('annotationMoveCancelled', 'Annotation move cancelled.'), 3000);
    }

    isActive(): boolean {
        return this.pickedUpIds.length > 0;
    }

    getPickedUpIds(): readonly string[] {
        return this.pickedUpIds;
    }

    private resolveIds(arg?: unknown): string[] {
        const candidates: unknown[] = Array.isArray(arg) ? arg : arg === undefined ? [] : [arg];
        const ids: string[] = [];
        for (const candidate of candidates) {
            if (typeof candidate === 'string') {
                ids.push(candidate);
            } else if (candidate && typeof candidate === 'object') {
                const object = candidate as {
                    id?: unknown;
                    annotationId?: unknown;
                    annotation?: { id?: unknown };
                    ids?: unknown;
                };
                if (Array.isArray(object.ids)) {
                    ids.push(...object.ids.filter((id): id is string => typeof id === 'string'));
                }
                const id = object.annotationId ?? object.id ?? object.annotation?.id;
                if (typeof id === 'string') {
                    const selected = this.selectedIds();
                    if (object.annotation?.id === id && selected.includes(id)) {
                        ids.push(...selected);
                    } else {
                        ids.push(id);
                    }
                }
            }
        }

        if (ids.length === 0) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const line = editor.selection.active.line;
                ids.push(
                    ...this.store
                        .listForFile(editor.document.uri.toString())
                        .filter(
                            (annotation) =>
                                editor.document.positionAt(annotation.startOffset).line === line &&
                                (!this.visibilityFilter || this.visibilityFilter.isVisible(annotation))
                        )
                        .map((annotation) => annotation.id)
                );
            }
        }
        return [...new Set(ids)].filter((id) => this.store.get(id)?.state === 'active');
    }

    private renderTarget(editor: vscode.TextEditor, position = editor.selection.active): void {
        for (const visibleEditor of vscode.window.visibleTextEditors) {
            visibleEditor.setDecorations(this.targetDecoration, []);
        }
        if (!this.isSupportedTarget(editor.document)) {
            return;
        }
        const line = Math.max(0, Math.min(editor.document.lineCount - 1, position.line));
        const range = editor.document.lineAt(line).range;
        const hover = new vscode.MarkdownString(
            loc('annotationDropPreview', '**Annotation destination** - Enter to drop | Escape to cancel')
        );
        editor.setDecorations(this.targetDecoration, [{ range, hoverMessage: hover }]);
    }

    private isSupportedTarget(document: vscode.TextDocument): boolean {
        return document.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(document.uri) !== undefined;
    }

    private clear(): void {
        this.pickedUpIds = [];
        this.statusBarItem.hide();
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.targetDecoration, []);
        }
        void vscode.commands.executeCommand('setContext', 'outOfCodeInsights.annotationMoveActive', false);
    }

    dispose(): void {
        this.clear();
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.subscriptions.length = 0;
    }
}
