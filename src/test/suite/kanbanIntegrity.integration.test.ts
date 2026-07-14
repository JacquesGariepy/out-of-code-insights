import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getKanbanColumnAssignmentIds,
    isValidKanbanColumnId,
    isValidKanbanColumnName,
    validateKanbanColumnDefinitions,
} from '../../extension';
import { AnnotationStore } from '../../transactional/AnnotationStore';
import { KanbanColumnStore, type MementoLike } from '../../transactional/KanbanColumnStore';
import { KANBAN_HIDDEN_COLUMN_ID, KanbanView, serializeForInlineScript } from '../../views/KanbanView';

const EXTENSION_IDS = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];

function findExtension(): vscode.Extension<unknown> | undefined {
    return EXTENSION_IDS.map((id) => vscode.extensions.getExtension(id)).find(
        (extension): extension is vscode.Extension<unknown> => extension !== undefined
    );
}

function memoryMemento(): MementoLike {
    const state = new Map<string, unknown>();
    return {
        get<T>(key: string): T | undefined {
            return state.get(key) as T | undefined;
        },
        update(key: string, value: unknown): Thenable<void> {
            state.set(key, value);
            return Promise.resolve();
        },
    };
}

suite('Kanban integrity', () => {
    test('inline-script JSON neutralizes closing tags and JavaScript line separators', () => {
        const hostile = {
            message: '</script><script>alert(1)</script> & payload',
            separators: `before\u2028middle\u2029after`,
        };
        const encoded = serializeForInlineScript(hostile);

        assert.ok(!encoded.includes('</script>'));
        assert.ok(!encoded.includes('<script>'));
        assert.ok(!encoded.includes('\u2028'));
        assert.ok(!encoded.includes('\u2029'));
        assert.ok(encoded.includes('\\u003c/script\\u003e'));
        assert.ok(encoded.includes('\\u2028'));
        assert.ok(encoded.includes('\\u2029'));
        assert.deepStrictEqual(JSON.parse(encoded), hostile);
    });

    test('rendered webview keeps nonce CSP while hostile store data stays inside JSON', () => {
        const store = new AnnotationStore();
        const columnStore = new KanbanColumnStore(memoryMemento());
        const hostile = '</script><script>alert(1)</script>\u2028';
        store.upsert({
            id: '0d59e281-fca2-436b-a9da-22b037db1952',
            fileUri: 'file:///closed-kanban-integrity.txt',
            file: 'closed-kanban-integrity.txt',
            startOffset: 0,
            endOffset: 0,
            lineHash: '',
            contextBefore: [],
            contextAfter: [],
            origin: { kind: 'manual' },
            message: hostile,
            timestamp: '2026-07-13T00:00:00.000Z',
        });
        const view = new KanbanView({} as vscode.ExtensionContext, store, columnStore);
        view.updateAnnotations(store.list());
        view.updateColumns(new Map([['todo', hostile]]));
        const internal = view as unknown as { getWebviewContent(webview: vscode.Webview): string };
        const html = internal.getWebviewContent({ cspSource: 'vscode-webview-resource:' } as vscode.Webview);
        const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];

        assert.ok(nonce, 'the script must carry a nonce');
        assert.ok(html.includes(`script-src 'nonce-${nonce}'`), 'the CSP must authorize only that nonce');
        assert.ok(!html.includes('</script><script>alert(1)'));
        assert.ok(html.includes('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)'));

        view.dispose();
        columnStore.dispose();
        store.dispose();
    });

    test('serialized cards resolve a one-based line and a removed card stays hidden', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: 'zero\none\ntarget line\n',
        });
        const store = new AnnotationStore();
        const columnStore = new KanbanColumnStore(memoryMemento());
        const startOffset = document.offsetAt(new vscode.Position(2, 3));
        const annotation = store.upsert({
            id: 'fa242a6e-a8ed-4cd1-9e57-b7b3de445766',
            fileUri: document.uri.toString(),
            file: 'kanban-integrity.txt',
            startOffset,
            endOffset: startOffset + 2,
            lineHash: '',
            contextBefore: [],
            contextAfter: [],
            origin: { kind: 'manual' },
            message: 'Target',
            timestamp: '2026-07-13T00:00:00.000Z',
        });
        await columnStore.setColumn(annotation.id, 'todo');

        const view = new KanbanView({} as vscode.ExtensionContext, store, columnStore);
        view.updateAnnotations(store.list());
        const internal = view as unknown as {
            serializeAnnotations(): Array<{ id: string; line: number | null; kanbanColumn: string }>;
        };
        const visible = internal.serializeAnnotations();
        assert.strictEqual(visible.length, 1);
        assert.strictEqual(visible[0].line, 3, 'line must be one-based, not the UTF-16 startOffset');
        assert.notStrictEqual(visible[0].line, startOffset);

        await columnStore.setColumn(annotation.id, 'deleted-column');
        assert.strictEqual(
            internal.serializeAnnotations()[0].kanbanColumn,
            'todo',
            'unknown persisted assignments must recover to a visible real column'
        );

        await columnStore.setColumn(annotation.id, KANBAN_HIDDEN_COLUMN_ID);
        assert.deepStrictEqual(internal.serializeAnnotations(), [], 'removed cards must not fall back to To Do');

        view.dispose();
        columnStore.dispose();
        store.dispose();
    });

    test('live listeners bind once and are disposed once when the view closes', () => {
        let storeSubscriptions = 0;
        let columnSubscriptions = 0;
        let storeDisposals = 0;
        let columnDisposals = 0;
        let storeListener: (() => void) | undefined;
        let columnListener: (() => void) | undefined;
        let listCalls = 0;

        const fakeStore = {
            list() {
                listCalls += 1;
                return [];
            },
            onDidChange(listener: () => void): vscode.Disposable {
                storeSubscriptions += 1;
                storeListener = listener;
                return new vscode.Disposable(() => {
                    storeDisposals += 1;
                });
            },
        };
        const fakeColumns = {
            getColumn() {
                return undefined;
            },
            onDidChange(listener: () => void): vscode.Disposable {
                columnSubscriptions += 1;
                columnListener = listener;
                return new vscode.Disposable(() => {
                    columnDisposals += 1;
                });
            },
        };
        const view = new KanbanView(
            {} as vscode.ExtensionContext,
            fakeStore as unknown as AnnotationStore,
            fakeColumns as unknown as KanbanColumnStore
        );
        const internal = view as unknown as { bindLiveUpdates(): void };

        internal.bindLiveUpdates();
        internal.bindLiveUpdates();
        assert.strictEqual(storeSubscriptions, 1);
        assert.strictEqual(columnSubscriptions, 1);

        storeListener?.();
        columnListener?.();
        assert.strictEqual(listCalls, 2);

        view.dispose();
        view.dispose();
        assert.strictEqual(storeDisposals, 1);
        assert.strictEqual(columnDisposals, 1);
    });

    test('column definitions and deletion impact reject malformed API state', () => {
        const valid: [string, string][] = [
            ['todo', 'To Do'],
            ['in-progress', 'In Progress'],
        ];
        assert.deepStrictEqual(validateKanbanColumnDefinitions(valid), valid);
        assert.strictEqual(isValidKanbanColumnId('in-progress'), true);
        assert.strictEqual(isValidKanbanColumnId('</script>'), false);
        assert.strictEqual(isValidKanbanColumnName('Review'), true);
        assert.strictEqual(isValidKanbanColumnName('Review\nInjected'), false);
        assert.strictEqual(validateKanbanColumnDefinitions([['review', 'Review']]), undefined, 'todo is required');
        assert.strictEqual(
            validateKanbanColumnDefinitions([
                ['todo', 'To Do'],
                ['todo', 'Duplicate'],
            ]),
            undefined
        );
        assert.strictEqual(
            validateKanbanColumnDefinitions([
                ['todo', 'To Do'],
                ['review', 'to do'],
            ]),
            undefined
        );

        const assignments = new Map([
            ['a', 'review'],
            ['b', 'todo'],
            ['c', 'review'],
        ]);
        assert.deepStrictEqual(getKanbanColumnAssignmentIds(assignments, 'review'), ['a', 'c']);
        assert.deepStrictEqual(getKanbanColumnAssignmentIds(assignments, 'done'), []);
    });

    test('internal commands reject hostile column layouts without changing state', async () => {
        const extension = findExtension();
        assert.ok(extension);
        await extension.activate();

        const before = await vscode.commands.executeCommand<[string, string][]>('annotations.kanban.getColumns');
        const addResult = await vscode.commands.executeCommand<boolean>(
            'annotations.kanban.addColumn',
            '</script>',
            'Injected'
        );
        const updateResult = await vscode.commands.executeCommand<boolean>('annotations.kanban.updateColumns', [
            ['review', 'Review'],
        ]);
        const after = await vscode.commands.executeCommand<[string, string][]>('annotations.kanban.getColumns');

        // VS Code may erase a falsy command result at the extension-host RPC
        // boundary; the invariant is that rejection never reports success and
        // cannot mutate the persisted layout.
        assert.notStrictEqual(addResult, true);
        assert.notStrictEqual(updateResult, true);
        assert.deepStrictEqual(after, before);
    });

    test('activation source keeps store and menus available without workspace persistence', () => {
        const extension = findExtension();
        assert.ok(extension);
        const source = fs.readFileSync(path.join(extension.extensionPath, 'src', 'extension.ts'), 'utf8');

        assert.ok(source.includes('if (!annotationStore || !visibilityFilter)'));
        assert.ok(!source.includes('if (!annotationStore || !visibilityFilter || !annotationPersistence)'));
        assert.match(source, /if \(annotationPersistence\) \{[\s\S]*?new AnnotationMoveService/);
        assert.match(
            source,
            /dragAndDropController: annotationPersistence \? new AnnotationsDragAndDropController\(\) : undefined/
        );
    });
});
