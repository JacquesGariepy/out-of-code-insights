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
        this.history = this.history.filter((item) => item !== id);

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

    public canGoBack(): boolean {
        return this.position + 1 < this.history.length;
    }

    public canGoForward(): boolean {
        return this.position > 0;
    }

    /**
     * Remove every occurrence of `id` from the stack. Used by consumers that
     * subscribe to `AnnotationStore.onDidDispose` so a TTL-expired or
     * explicitly-disposed annotation cannot keep a tombstone in the
     * navigation history. Idempotent: no-op when the id is absent.
     */
    public removeId(id: string): void {
        const before = this.history.length;
        this.history = this.history.filter((entry) => entry !== id);
        if (this.history.length === before) {
            return;
        }
        if (this.position >= this.history.length) {
            this.position = this.history.length === 0 ? 0 : this.history.length - 1;
        }
        this.save();
        this._onDidChange.fire();
    }
}
