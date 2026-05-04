import * as vscode from 'vscode';
import { Annotation } from '../common/types';
import { AnnotationManager } from '../managers/AnnotationManager';
import { loc } from '../managers/LocalizationManager';

export class NavigationStackDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private annotationManager: AnnotationManager) {
        this.annotationManager.navigationStack.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<vscode.TreeItem[]> {
        await this.annotationManager.waitUntilInitialized();
        const ids = this.annotationManager.navigationStack.getStack();
        const items: vscode.TreeItem[] = [];
        ids.forEach(id => {
            const ann = this.annotationManager.annotations.get(id);
            if (ann) items.push(new StackTreeItem(ann));
        });
        return items;
    }
}

class StackTreeItem extends vscode.TreeItem {
    constructor(public readonly annotation: Annotation) {
        super(annotation.message, vscode.TreeItemCollapsibleState.None);
        this.description = loc('fileLineDescription', `{0}:{1}`, annotation.file, annotation.line + 1);
        this.iconPath = new vscode.ThemeIcon('file');
        this.command = {
            command: 'annotations.navigate',
            title: loc('navigateToAnnotation', 'Navigate to Annotation'),
            arguments: [annotation.id]
        };
    }
}
