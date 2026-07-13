// SPDX-License-Identifier: MPL-2.0
//
// CodeLens provider for annotations. Lot 5 R2 worktree A: migrated from
// AnnotationManager to AnnotationStore + VisibilityFilter. The codelens
// configuration toggle is read directly from VS Code configuration so we
// don't need to plumb a config snapshot through the store.

import * as vscode from 'vscode';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { VisibilityFilter } from '../transactional/VisibilityFilter';

export class AnnotationCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly store: AnnotationStore,
        private readonly visibilityFilter: VisibilityFilter
    ) {
        this.subscriptions.push(this.store.onDidChange(() => this._onDidChangeCodeLenses.fire()));
        this.subscriptions.push(this.store.onDidSuspend(() => this._onDidChangeCodeLenses.fire()));
        this.subscriptions.push(this.store.onDidResume(() => this._onDidChangeCodeLenses.fire()));
        this.subscriptions.push(this.store.onDidDispose(() => this._onDidChangeCodeLenses.fire()));
        this.subscriptions.push(this.visibilityFilter.onDidChange(() => this._onDidChangeCodeLenses.fire()));
        this.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('annotation.codelens') ||
                    e.affectsConfiguration('annotation.enableAnnotations')
                ) {
                    this._onDidChangeCodeLenses.fire();
                }
            })
        );
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!this.visibilityFilter.isGloballyEnabled() || !this.codelensEnabled()) {
            return [];
        }

        const annotations = this.store.listForFile(document.uri.toString());
        const processedLines = new Set<number>();
        const lenses: vscode.CodeLens[] = [];
        const annotationsAtLine = new Map<number, typeof annotations>();

        for (const annotation of annotations) {
            if (!this.visibilityFilter.isVisible(annotation)) {
                continue;
            }
            if (annotation.state !== 'active') {
                continue;
            }
            const line = document.positionAt(annotation.startOffset).line;
            if (line < 0 || line >= document.lineCount) {
                continue;
            }
            const bucket = annotationsAtLine.get(line);
            if (bucket) {
                annotationsAtLine.set(line, [...bucket, annotation]);
            } else {
                annotationsAtLine.set(line, [annotation]);
            }
        }

        for (const [line, lineAnnotations] of annotationsAtLine) {
            if (processedLines.has(line)) {
                continue;
            }
            processedLines.add(line);
            const range = new vscode.Range(line, 0, line, 0);
            const title = `Manage ${lineAnnotations.length} annotation${lineAnnotations.length > 1 ? 's' : ''}`;
            lenses.push(
                new vscode.CodeLens(range, {
                    title,
                    command: 'annotations.manage',
                    arguments: [lineAnnotations],
                })
            );
            if (this.codelensCommandsEnabled()) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(move) Pick up ${lineAnnotations.length > 1 ? `${lineAnnotations.length} annotations` : 'to move'}`,
                        tooltip: 'Move the cursor to a destination line, then press Enter to drop',
                        command: 'annotations.pickUpForMove',
                        arguments: [lineAnnotations.map((annotation) => annotation.id)],
                    })
                );
            }
        }

        return lenses;
    }

    dispose(): void {
        for (const sub of this.subscriptions) {
            sub.dispose();
        }
        this.subscriptions.length = 0;
        this._onDidChangeCodeLenses.dispose();
    }

    private codelensEnabled(): boolean {
        return vscode.workspace.getConfiguration('annotation').get<boolean>('codelens.enable', true) === true;
    }

    private codelensCommandsEnabled(): boolean {
        return vscode.workspace.getConfiguration('annotation').get<boolean>('codelens.showCommands', true) === true;
    }
}
