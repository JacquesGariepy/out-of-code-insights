import * as vscode from 'vscode';

export class NavigationStack {
    private history: string[];
    private position: number;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(private context: vscode.ExtensionContext) {
        this.history = context.workspaceState.get<string[]>('navigationStack.history', []);
        this.position = context.workspaceState.get<number>('navigationStack.position', 0);
        if (this.position >= this.history.length) {
            this.position = 0;
        }
    }

    private save() {
        this.context.workspaceState.update('navigationStack.history', this.history);
        this.context.workspaceState.update('navigationStack.position', this.position);
    }

    public push(id: string) {
        // remove duplicates
        this.history = this.history.filter(item => item !== id);

        if (this.position > 0) {
            // drop forward history when navigating to a new item
            this.history = this.history.slice(this.position);
            this.position = 0;
        }

        this.history.unshift(id);
        if (this.history.length > 10) {
            this.history = this.history.slice(0, 10);
        }
        this.save();
        this._onDidChange.fire();
    }

    public back(): string | undefined {
        if (this.position + 1 < this.history.length) {
            this.position++;
            this.save();
            this._onDidChange.fire();
            return this.history[this.position];
        }
        return undefined;
    }

    public forward(): string | undefined {
        if (this.position > 0) {
            this.position--;
            this.save();
            this._onDidChange.fire();
            return this.history[this.position];
        }
        return undefined;
    }

    public getStack(): string[] {
        return [...this.history];
    }
}
