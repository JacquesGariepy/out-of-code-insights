// SPDX-License-Identifier: MPL-2.0
//
// Minimal typed event emitter producing a `vscode.Event<T>`-compatible
// subscriber function without requiring a runtime import of `vscode`.
// Shared between AnnotationStore and the four extracted services
// (Persistence, Navigation, VisibilityFilter, KanbanColumnStore).

export class TypedEventEmitter<T> {
    private readonly listeners = new Set<(data: T) => void>();

    readonly event = (listener: (data: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    };

    fire(data: T): void {
        for (const listener of this.listeners) {
            listener(data);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}
