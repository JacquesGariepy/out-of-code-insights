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
//   4. Drag-and-drop contract and identity-preserving cross-file moves.
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
import { AnnotationMoveService, parseAnnotationDragIds } from '../../commands/AnnotationMoveService';
import {
    AnnotationDocumentDropEditProvider,
    annotationDocumentDropMetadata,
} from '../../providers/AnnotationDocumentDropEditProvider';
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

class FailingAnnotationPersistence extends AnnotationPersistence {
    override async save(): Promise<void> {
        throw new Error('simulated persistence failure');
    }
}

function makeFailingPersistence(): AnnotationPersistence {
    const tmpRoot = path.join(
        os.tmpdir(),
        `out-of-code-insights-lot5-failing-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    return new FailingAnnotationPersistence({ uri: { fsPath: tmpRoot } });
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
        assert.strictEqual(fileItem.id, `file:${relPath(uri)}`, 'file groups must expose a stable TreeItem id');
        assert.strictEqual(fileItem.entries.length, 3);

        const children = await provider.getChildren(fileItem);
        const annotationItems = children as AnnotationTreeItem[];
        const ids = annotationItems.map((c) => c.annotation.id);
        assert.deepStrictEqual(
            ids,
            [a1.id, a2.id, a3.id],
            'children must be sorted by startOffset, not insertion order'
        );
        assert.deepStrictEqual(
            annotationItems.map((item) => item.id),
            [a1, a2, a3].map((annotation) => `annotation:${annotation.id}`),
            'annotation TreeItem ids must be stable and derived from the store id'
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
        assert.strictEqual(refreshedFile.id, fileItem.id, 'file id must survive provider refreshes');
        assert.deepStrictEqual(
            refreshedChildren.map((item) => item.id),
            annotationItems.map((item) => item.id),
            'annotation ids must survive provider refreshes'
        );
        assert.strictEqual(
            refreshedChildren.find((item) => item.annotation.id === a1.id)?.checkboxState,
            vscode.TreeItemCheckboxState.Checked,
            'resolved state should be exposed through the native TreeView checkbox'
        );
    });

    test('outgoing link tooltips display user-facing one-based line numbers', async function () {
        this.timeout(10000);
        const uri = await ensureFixture('lot5-display-tree-link-tooltip.ts', 'one\ntwo\nthree\n');
        const document = await vscode.workspace.openTextDocument(uri);
        const store = new AnnotationStore();
        store.markInitialized();
        const annotation = store.add(
            {
                ...makeDraft(uri, 'linked annotation'),
                linkedAnnotations: [
                    {
                        targetFile: 'src/target.ts',
                        targetLine: 2,
                        relationship: 'related',
                    },
                ],
            },
            { line: 0 },
            document
        );

        const item = new AnnotationTreeItem(annotation, 0);
        assert.ok(item.tooltip instanceof vscode.MarkdownString, 'annotation tooltip should be Markdown');
        assert.match(
            item.tooltip.value,
            /src\/target\.ts:3/,
            `zero-based target line 2 must be displayed as line 3; tooltip=${JSON.stringify(item.tooltip.value)}`
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
        assert.strictEqual(lenses.length, 2);
        assert.strictEqual(lenses[0].range.start.line, 2);
        assert.strictEqual(lenses[0].command?.command, 'annotations.manage');
        assert.strictEqual(lenses[1].command?.command, 'annotations.pickUpForMove');
        assert.strictEqual(lenses[1].range.start.line, 2);
    });

    test('returns no lenses when globally disabled', async function () {
        this.timeout(30000);
        const uri = await ensureFixture('lot5-display-codelens-disabled.ts', 'one\ntwo\n');
        const document = await vscode.workspace.openTextDocument(uri);

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
        const controller = new AnnotationsDragAndDropController();
        assert.deepStrictEqual(controller.dragMimeTypes, ['application/vnd.code.tree.annotation']);
        assert.deepStrictEqual(controller.dropMimeTypes, ['application/vnd.code.tree.annotation']);
    });

    test('parses versioned and legacy drag payloads', () => {
        assert.deepStrictEqual(parseAnnotationDragIds(JSON.stringify({ version: 1, ids: ['a', 'b'] })), ['a', 'b']);
        assert.deepStrictEqual(parseAnnotationDragIds('legacy-a,legacy-b'), ['legacy-a', 'legacy-b']);
        assert.deepStrictEqual(parseAnnotationDragIds({ ids: ['not-a-string-payload'] }), []);
    });

    test('moves multiple annotations across files while preserving identity and relative spacing', async function () {
        this.timeout(10000);
        const sourceUri = await ensureFixture('lot5-drag-source.ts', 's0\ns1\ns2\ns3\ns4\n');
        const targetUri = await ensureFixture('lot5-drag-target.ts', 't0\nt1\nt2\nt3\nt4\nt5\n');
        const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
        const targetDocument = await vscode.workspace.openTextDocument(targetUri);
        const store = new AnnotationStore();
        store.markInitialized();
        const first = store.add(makeDraft(sourceUri, 'first dragged'), { line: 1 }, sourceDocument);
        const second = store.add(makeDraft(sourceUri, 'second dragged'), { line: 3 }, sourceDocument);
        const target = store.add(makeDraft(targetUri, 'drop target'), { line: 2 }, targetDocument);
        const service = new AnnotationMoveService(store, makeTmpPersistence());

        const result = await service.move({
            ids: [first.id, second.id],
            targetAnnotationId: target.id,
        });

        assert.deepStrictEqual(result?.movedIds, [first.id, second.id]);
        const movedFirst = store.get(first.id);
        const movedSecond = store.get(second.id);
        assert.strictEqual(movedFirst?.fileUri, targetUri.toString());
        assert.strictEqual(movedSecond?.fileUri, targetUri.toString());
        assert.strictEqual(targetDocument.positionAt(movedFirst?.startOffset ?? -1).line, 2);
        assert.strictEqual(targetDocument.positionAt(movedSecond?.startOffset ?? -1).line, 4);
        assert.strictEqual(store.get(target.id)?.startOffset, target.startOffset, 'drop target must not move');
    });

    test('rolls the in-memory anchors back when move persistence fails', async function () {
        this.timeout(10000);
        const sourceUri = await ensureFixture('lot5-move-rollback-source.ts', 'zero\nsource\nlast\n');
        const targetUri = await ensureFixture('lot5-move-rollback-target.ts', 'zero\none\ntwo\n');
        const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
        const targetDocument = await vscode.workspace.openTextDocument(targetUri);
        const store = new AnnotationStore();
        store.markInitialized();
        const annotation = store.add(makeDraft(sourceUri, 'rollback me'), { line: 1 }, sourceDocument);
        const service = new AnnotationMoveService(store, makeFailingPersistence());

        await assert.rejects(
            service.move({
                ids: [annotation.id],
                targetUri: targetUri.toString(),
                targetFile: relPath(targetUri),
                targetLine: 2,
            }),
            /simulated persistence failure/
        );

        const restored = store.get(annotation.id);
        assert.strictEqual(restored?.fileUri, sourceUri.toString());
        assert.strictEqual(sourceDocument.positionAt(restored?.startOffset ?? -1).line, 1);
        assert.notStrictEqual(restored?.fileUri, targetDocument.uri.toString());
    });

    test('moves a tree annotation onto the exact editor drop line without inserting text', async function () {
        this.timeout(10000);
        const sourceUri = await ensureFixture('lot5-drag-editor-source.ts', 'source zero\nsource annotation\n');
        const targetUri = await ensureFixture(
            'lot5-drag-editor-target.ts',
            'target zero\ntarget one\ntarget two\ntarget three\n'
        );
        const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
        const targetDocument = await vscode.workspace.openTextDocument(targetUri);
        const store = new AnnotationStore();
        store.markInitialized();
        const annotation = store.add(makeDraft(sourceUri, 'drop into editor'), { line: 1 }, sourceDocument);
        const provider = new AnnotationDocumentDropEditProvider(new AnnotationMoveService(store, makeTmpPersistence()));
        const transfer = new vscode.DataTransfer();
        transfer.set(
            'application/vnd.code.tree.annotation',
            new vscode.DataTransferItem(JSON.stringify({ version: 1, ids: [annotation.id] }))
        );
        const cancellation = new vscode.CancellationTokenSource();

        const edit = await provider.provideDocumentDropEdits(
            targetDocument,
            new vscode.Position(3, 4),
            transfer,
            cancellation.token
        );

        assert.ok(edit, 'the custom tree payload should produce a native DocumentDropEdit');
        assert.strictEqual(edit.insertText, '', 'moving metadata must not insert text into source code');
        assert.deepStrictEqual(annotationDocumentDropMetadata.dropMimeTypes, ['application/vnd.code.tree.annotation']);
        cancellation.dispose();
        const moved = store.get(annotation.id);
        assert.strictEqual(moved?.fileUri, targetUri.toString());
        assert.strictEqual(targetDocument.positionAt(moved?.startOffset ?? -1).line, 3);
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
