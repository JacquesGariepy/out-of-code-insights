// SPDX-License-Identifier: MPL-2.0
//
// KanbanColumnStore — keeps the annotation→column mapping for the Kanban
// view OUTSIDE the transactional store. Persistence flows through a
// `MementoLike` adapter (production: `vscode.ExtensionContext.workspaceState`;
// tests: in-memory mock).

import { TypedEventEmitter } from './internal/event-emitter';

/** Subset of `vscode.Memento` consumed by the Kanban store. */
export interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

const STATE_KEY = 'outOfCodeInsights.kanban.annotationColumns';

export class KanbanColumnStore {
    private readonly _onDidChange = new TypedEventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly cache = new Map<string, string>();

    constructor(private readonly memento: MementoLike) {
        const stored = memento.get<Record<string, string>>(STATE_KEY);
        if (stored && typeof stored === 'object') {
            for (const [annotationId, column] of Object.entries(stored)) {
                if (typeof column === 'string' && typeof annotationId === 'string') {
                    this.cache.set(annotationId, column);
                }
            }
        }
    }

    /** Read the column id for an annotation, or `undefined` when unset. */
    getColumn(annotationId: string): string | undefined {
        return this.cache.get(annotationId);
    }

    /** Persist a new column for an annotation. Emits `onDidChange`. */
    async setColumn(annotationId: string, column: string): Promise<void> {
        if (this.cache.get(annotationId) === column) {
            return; // no-op write avoids an event storm
        }
        this.cache.set(annotationId, column);
        await this.persist();
        this._onDidChange.fire();
    }

    /** Remove the column mapping (annotation deleted, etc.). */
    async clearColumn(annotationId: string): Promise<void> {
        if (!this.cache.has(annotationId)) {
            return;
        }
        this.cache.delete(annotationId);
        await this.persist();
        this._onDidChange.fire();
    }

    /** Snapshot of all column assignments. Mutations on the returned Map are detached. */
    getAllColumns(): Map<string, string> {
        return new Map(this.cache);
    }

    private async persist(): Promise<void> {
        const obj: Record<string, string> = {};
        for (const [id, column] of this.cache) {
            obj[id] = column;
        }
        await this.memento.update(STATE_KEY, obj);
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
