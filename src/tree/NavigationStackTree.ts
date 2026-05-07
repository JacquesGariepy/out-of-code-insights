// SPDX-License-Identifier: MPL-2.0
//
// Tree provider for the Navigation Stack side panel. Lot 5 R2 worktree A:
// migrated from AnnotationManager to AnnotationStore + an injected
// NavigationStack instance. Subscribes to `store.onDidDispose` so a
// TTL-expired or explicitly-disposed annotation is purged from the stack
// rather than left as a tombstone (resolves Q5 from R1).

import * as vscode from 'vscode';
import { loc } from '../managers/LocalizationManager';
import { NavigationStack } from '../managers/NavigationStack';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { AnnotationV2 } from '../transactional/types';

export class NavigationStackDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly store: AnnotationStore,
        private readonly navigationStack: NavigationStack
    ) {
        this.subscriptions.push(this.navigationStack.onDidChange(() => this.refresh()));
        this.subscriptions.push(this.store.onDidChange(() => this.refresh()));
        this.subscriptions.push(
            this.store.onDidDispose(({ annotationId }) => {
                this.navigationStack.removeId(annotationId);
                this.refresh();
            })
        );
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

    async getChildren(): Promise<vscode.TreeItem[]> {
        await this.store.waitUntilInitialized();
        const ids = this.navigationStack.getStack();
        const openDocs = vscode.workspace.textDocuments;
        const items: vscode.TreeItem[] = [];
        for (const id of ids) {
            const ann = this.store.get(id);
            if (!ann) {
                continue;
            }
            const line = this.store.getLineForAnnotation(id, openDocs);
            items.push(new StackTreeItem(ann, line));
        }
        return items;
    }
}

class StackTreeItem extends vscode.TreeItem {
    constructor(
        public readonly annotation: AnnotationV2,
        line: number | null
    ) {
        super(annotation.message, vscode.TreeItemCollapsibleState.None);
        const lineLabel = line === null ? '?' : String(line + 1);
        this.description = loc('fileLineDescription', `{0}:{1}`, annotation.file, lineLabel);
        this.iconPath = new vscode.ThemeIcon('file');
        this.command = {
            command: 'annotations.navigate',
            title: loc('navigateToAnnotation', 'Navigate to Annotation'),
            arguments: [annotation.id],
        };
    }
}
