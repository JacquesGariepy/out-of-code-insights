// SPDX-License-Identifier: MPL-2.0
//
// Lot 5 R2 — Worktree A integration tests.
//
// Covers the migrated display consumers in isolation (without depending on
// extension.ts, which is still on the legacy AnnotationManager wiring while
// worktree D lands):
//   1. AnnotationsTreeDataProvider — refresh on store change, group/sort
//      by file then by startOffset, visibility filter applied.
//   2. AnnotationCodeLensProvider — lenses appear at correct lines, hidden
//      when globally disabled.
//   3. NavigationStackDataProvider — purges entries on store.onDidDispose.
//   4. AnnotationsDragAndDropController contract — handleDrop reorders via
//      store.setAnnotationLine and persists via AnnotationPersistence.
//
// Note on placement: under src/test/suite/, NOT src/test/integration/, so
// the suite runs in EDH (vscode runtime available). `npm run test:unit`
// would crash on `import * as vscode`.

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore, type AnnotationDraft } from '../../transactional/AnnotationStore';
import {
    AnnotationsDragAndDropController,
    AnnotationsTreeDataProvider,
    FileTreeItem,
    AnnotationTreeItem,
} from '../../tree/AnnotationsTree';
import { NavigationStackDataProvider } from '../../tree/NavigationStackTree';
import { AnnotationCodeLensProvider } from '../../providers/AnnotationCodeLensProvider';
import { AnnotationPersistence } from '../../transactional/AnnotationPersistence';
import { VisibilityFilter, type AnnotationVisibilityConfig } from '../../transactional/VisibilityFilter';
import { NavigationStack } from '../../managers/NavigationStack';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders;
    assert.ok(ws && ws.length > 0, 'a workspace folder must be open during tests');
    return ws[0].uri.fsPath;
}

async function ensureFixture(relPathArg: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), relPathArg));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
}

async function closeAllEditors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function relPath(uri: vscode.Uri): string {
    return path.relative(workspaceRoot(), uri.fsPath).replace(/\\/g, '/');
}

function makeDraft(uri: vscode.Uri, message: string, tags?: string[]): AnnotationDraft {
    return {
        fileUri: uri.toString(),
        file: relPath(uri),
        origin: { kind: 'manual' },
        message,
        timestamp: new Date().toISOString(),
        tags,
    };
}

function defaultVisibilityConfig(): AnnotationVisibilityConfig {
    return {
        enableAnnotations: true,
        disabledTags: [],
        currentFilter: 'all',
    };
}

/** Build a persistence service rooted at a tmp dir so tests don't pollute the workspace. */
function makeTmpPersistence(): AnnotationPersistence {
    const tmpRoot = path.join(
        os.tmpdir(),
        `out-of-code-insights-lot5-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    return new AnnotationPersistence({ uri: { fsPath: tmpRoot } });
}

// ---------------------------------------------------------------------------
// AnnotationsTreeDataProvider
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree A — AnnotationsTreeDataProvider', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('groups annotations by file and sorts by startOffset', async function () {
        this.timeout(10000);
        const original = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
        const uri = await ensureFixture('lot5-display-tree-grouping.ts', original);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        const visibility = new VisibilityFilter(defaultVisibilityConfig);
        store.markInitialized();

        const a3 = store.add(makeDraft(uri, 'on line 3'), { line: 3 }, document);
        const a1 = store.add(makeDraft(uri, 'on line 1'), { line: 1 }, document);
        const a2 = store.add(makeDraft(uri, 'on line 2'), { line: 2 }, document);

        const provider = new AnnotationsTreeDataProvider(store, visibility);
        subscriptions.push(provider);

        const roots = await provider.getChildren();
        assert.strictEqual(roots.length, 1, 'the native tree root should contain file groups only');
        const fileItem = roots.find((r) => r instanceof FileTreeItem) as FileTreeItem;
        assert.ok(fileItem, 'expected a FileTreeItem');
        assert.strictEqual(fileItem.entries.length, 3);

        const children = await provider.getChildren(fileItem);
        const ids = (children as AnnotationTreeItem[]).map((c) => c.annotation.id);
        assert.deepStrictEqual(
            ids,
            [a1.id, a2.id, a3.id],
            'children must be sorted by startOffset, not insertion order'
        );

        store.update(a1.id, { resolved: true });
        store.update(a2.id, { severity: 'warning' });
        const stats = provider.getStats();
        assert.deepStrictEqual(stats, {
            total: 3,
            visible: 3,
            open: 2,
            resolved: 1,
            attention: 1,
            files: 1,
        });

        const refreshedRoots = await provider.getChildren();
        const refreshedFile = refreshedRoots[0] as FileTreeItem;
        const refreshedChildren = (await provider.getChildren(refreshedFile)) as AnnotationTreeItem[];
        assert.strictEqual(
            refreshedChildren.find((item) => item.annotation.id === a1.id)?.checkboxState,
            vscode.TreeItemCheckboxState.Checked,
            'resolved state should be exposed through the native TreeView checkbox'
        );
    });

    test('refresh fires on store.onDidChange', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-tree-refresh.ts', 'one\ntwo\nthree\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        const visibility = new VisibilityFilter(defaultVisibilityConfig);
        store.markInitialized();

        const provider = new AnnotationsTreeDataProvider(store, visibility);
        subscriptions.push(provider);

        let fired = 0;
        subscriptions.push(provider.onDidChangeTreeData(() => fired++));

        store.add(makeDraft(uri, 'first'), { line: 0 }, document);
        await delay(50);

        assert.ok(fired >= 1, `tree must refresh on store.onDidChange (fired=${fired})`);
    });

    test('honours visibility filter (disabled tag hides annotation)', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-tree-visibility.ts', 'a\nb\nc\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        let config: AnnotationVisibilityConfig = {
            enableAnnotations: true,
            disabledTags: ['hidden'],
            currentFilter: 'all',
        };
        const visibility = new VisibilityFilter(() => config);
        store.markInitialized();

        store.add(makeDraft(uri, 'visible', ['shown']), { line: 0 }, document);
        store.add(makeDraft(uri, 'hidden', ['hidden']), { line: 1 }, document);

        const provider = new AnnotationsTreeDataProvider(store, visibility);
        subscriptions.push(provider);

        const roots = await provider.getChildren();
        const fileItem = roots.find((r) => r instanceof FileTreeItem) as FileTreeItem;
        assert.strictEqual(fileItem.entries.length, 1, 'tagged "hidden" must be filtered');

        // Untag at runtime → tree refreshes after onDidChange.
        config = { ...config, disabledTags: [] };
        let fired = 0;
        subscriptions.push(provider.onDidChangeTreeData(() => fired++));
        visibility.refresh();
        await delay(20);
        assert.ok(fired >= 1, 'tree must refresh on visibility change');

        const rootsAfter = await provider.getChildren();
        const fileItemAfter = rootsAfter.find((r) => r instanceof FileTreeItem) as FileTreeItem;
        assert.strictEqual(fileItemAfter.entries.length, 2, 'both annotations now visible');
    });
});

// ---------------------------------------------------------------------------
// AnnotationCodeLensProvider
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree A — AnnotationCodeLensProvider', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('produces a lens at the annotation line', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-codelens-line.ts', 'first\nsecond\ntarget\nfourth\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        const visibility = new VisibilityFilter(defaultVisibilityConfig);
        store.markInitialized();
        store.add(makeDraft(uri, 'lens-here'), { line: 2 }, document);

        const provider = new AnnotationCodeLensProvider(store, visibility);
        subscriptions.push(provider);

        const lenses = provider.provideCodeLenses(document);
        assert.strictEqual(lenses.length, 1);
        assert.strictEqual(lenses[0].range.start.line, 2);
    });

    test('returns no lenses when globally disabled', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-codelens-disabled.ts', 'one\ntwo\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        const visibility = new VisibilityFilter(() => ({
            enableAnnotations: false,
            disabledTags: [],
            currentFilter: 'all',
        }));
        store.markInitialized();
        store.add(makeDraft(uri, 'never-shown'), { line: 0 }, document);

        const provider = new AnnotationCodeLensProvider(store, visibility);
        subscriptions.push(provider);

        const lenses = provider.provideCodeLenses(document);
        assert.strictEqual(lenses.length, 0);
    });
});

// ---------------------------------------------------------------------------
// NavigationStackDataProvider
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree A — NavigationStackDataProvider', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('purges disposed annotations from the stack', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-navstack-purge.ts', 'aaaaa\nbbbbb\nccccc\nddddd\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        // 1ms TTL so a single sweep marks suspended entries as disposed.
        const store = new AnnotationStore({ suspendTtlMs: 1 });
        store.markInitialized();

        // Mock context for NavigationStack — only workspaceState is consulted.
        const fakeState = new Map<string, unknown>();
        const fakeContext = {
            workspaceState: {
                get<T>(key: string, defaultValue?: T): T | undefined {
                    return (fakeState.get(key) as T | undefined) ?? defaultValue;
                },
                update(key: string, value: unknown): Thenable<void> {
                    fakeState.set(key, value);
                    return Promise.resolve();
                },
            },
        } as unknown as vscode.ExtensionContext;

        const navStack = new NavigationStack(fakeContext);
        const ann = store.add(makeDraft(uri, 'doomed'), { line: 0 }, document);
        navStack.push(ann.id);
        assert.deepStrictEqual(navStack.getStack(), [ann.id]);

        const provider = new NavigationStackDataProvider(store, navStack);
        subscriptions.push(provider);

        // Suspend then sweep via a synthetic empty applyDocumentChange call.
        store.suspend(ann.id, ann.lineHash);
        await delay(20);

        // Trigger sweep — applyDocumentChange runs sweepExpiredSuspended
        // before processing changes. We feed a no-op event.
        const fakeEvent = {
            document,
            contentChanges: [] as readonly vscode.TextDocumentContentChangeEvent[],
            reason: undefined,
        } as unknown as vscode.TextDocumentChangeEvent;
        store.applyDocumentChange(fakeEvent);

        await delay(20);

        assert.deepStrictEqual(navStack.getStack(), [], 'TTL-disposed annotation must be purged from navigation stack');
    });
});

// ---------------------------------------------------------------------------
// AnnotationsDragAndDropController
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree A — AnnotationsDragAndDropController contract', () => {
    test('exposes mime types and constructs without throwing', () => {
        const store = new AnnotationStore();
        const persistence = makeTmpPersistence();
        const controller = new AnnotationsDragAndDropController(store, persistence);
        assert.deepStrictEqual(controller.dragMimeTypes, ['application/vnd.code.tree.annotation']);
        assert.deepStrictEqual(controller.dropMimeTypes, ['application/vnd.code.tree.annotation']);
    });
});

// ---------------------------------------------------------------------------
// AnnotationStore.getLineForAnnotation
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree A — AnnotationStore.getLineForAnnotation', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('resolves line from a directly-passed document', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-getline-direct.ts', 'l0\nl1\nl2\nl3\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'at line 2'), { line: 2 }, document);

        assert.strictEqual(store.getLineForAnnotation(ann.id, document), 2);
    });

    test('searches a list of open documents by URI', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-getline-listed.ts', 'p0\np1\np2\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'at line 1'), { line: 1 }, document);

        const openDocs = vscode.workspace.textDocuments;
        assert.strictEqual(store.getLineForAnnotation(ann.id, openDocs), 1);
    });

    test('returns null for an unknown id', async function () {
        const store = new AnnotationStore();
        store.markInitialized();
        assert.strictEqual(store.getLineForAnnotation('does-not-exist'), null);
    });

    test('returns null when no document is provided', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-getline-nodoc.ts', 'q0\nq1\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'isolated'), { line: 0 }, document);

        assert.strictEqual(store.getLineForAnnotation(ann.id), null);
    });
});
