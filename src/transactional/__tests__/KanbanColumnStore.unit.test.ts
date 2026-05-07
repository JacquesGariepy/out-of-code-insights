// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { KanbanColumnStore, type MementoLike } from '../KanbanColumnStore';

class InMemoryMemento implements MementoLike {
    private readonly map = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.map.get(key) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.map.delete(key);
        } else {
            this.map.set(key, value);
        }
        return Promise.resolve();
    }

    snapshot(): Map<string, unknown> {
        return new Map(this.map);
    }
}

suite('KanbanColumnStore — basic CRUD', () => {
    test('getColumn returns undefined for an unknown id', () => {
        const memento = new InMemoryMemento();
        const store = new KanbanColumnStore(memento);
        assert.strictEqual(store.getColumn('unknown'), undefined);
    });

    test('setColumn persists to the memento and emits onDidChange', async () => {
        const memento = new InMemoryMemento();
        const store = new KanbanColumnStore(memento);
        const events: number[] = [];
        const sub = store.onDidChange(() => events.push(1));
        await store.setColumn('a1', 'in-progress');
        sub.dispose();
        assert.strictEqual(store.getColumn('a1'), 'in-progress');
        assert.strictEqual(events.length, 1);
    });

    test('repeated setColumn with same value is a no-op (no event)', async () => {
        const memento = new InMemoryMemento();
        const store = new KanbanColumnStore(memento);
        await store.setColumn('a1', 'todo');
        const events: number[] = [];
        const sub = store.onDidChange(() => events.push(1));
        await store.setColumn('a1', 'todo');
        sub.dispose();
        assert.strictEqual(events.length, 0);
    });

    test('clearColumn removes the entry and emits onDidChange', async () => {
        const memento = new InMemoryMemento();
        const store = new KanbanColumnStore(memento);
        await store.setColumn('a1', 'todo');
        const events: number[] = [];
        const sub = store.onDidChange(() => events.push(1));
        await store.clearColumn('a1');
        sub.dispose();
        assert.strictEqual(store.getColumn('a1'), undefined);
        assert.strictEqual(events.length, 1);
    });

    test('clearColumn on unknown id is a no-op (no event)', async () => {
        const memento = new InMemoryMemento();
        const store = new KanbanColumnStore(memento);
        const events: number[] = [];
        const sub = store.onDidChange(() => events.push(1));
        await store.clearColumn('does-not-exist');
        sub.dispose();
        assert.strictEqual(events.length, 0);
    });
});

suite('KanbanColumnStore — getAllColumns', () => {
    test('returns a detached Map (mutations on the returned map do not leak)', async () => {
        const memento = new InMemoryMemento();
        const store = new KanbanColumnStore(memento);
        await store.setColumn('a1', 'todo');
        await store.setColumn('a2', 'done');
        const snapshot = store.getAllColumns();
        snapshot.delete('a1');
        assert.strictEqual(store.getColumn('a1'), 'todo', 'internal map untouched');
    });
});

suite('KanbanColumnStore — persistence round-trip', () => {
    test('a fresh store rebuilds the cache from the memento', async () => {
        const memento = new InMemoryMemento();
        const a = new KanbanColumnStore(memento);
        await a.setColumn('a1', 'review');
        await a.setColumn('a2', 'done');
        const b = new KanbanColumnStore(memento);
        assert.strictEqual(b.getColumn('a1'), 'review');
        assert.strictEqual(b.getColumn('a2'), 'done');
    });
});
