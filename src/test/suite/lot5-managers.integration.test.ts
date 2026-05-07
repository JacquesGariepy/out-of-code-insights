// SPDX-License-Identifier: MPL-2.0
//
// Lot 5 R2 — Worktree B integration tests.
//
// Validates the migration of the three business managers (Linked /
// ReviewMode / Snippet) to consume AnnotationStore directly, without going
// through AnnotationManager.
//
// Note on placement: under src/test/suite/, NOT src/test/integration/, so
// the suite runs in EDH (vscode runtime available). `npm run test:unit`
// would crash on `import * as vscode`.

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore, type AnnotationDraft } from '../../transactional/AnnotationStore';
import { LinkedAnnotationManager } from '../../managers/LinkedAnnotationManager';
import { ReviewModeManager } from '../../managers/ReviewModeManager';
import { SnippetManager } from '../../managers/SnippetManager';

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

function makeDraft(uri: vscode.Uri, message: string): AnnotationDraft {
    return {
        fileUri: uri.toString(),
        file: relPath(uri),
        origin: { kind: 'manual' },
        message,
        timestamp: new Date().toISOString(),
    };
}

/** Minimal ExtensionContext shim — only what these managers actually consult. */
function makeFakeContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        subscriptions: [] as vscode.Disposable[],
        workspaceState: {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return (state.get(key) as T | undefined) ?? defaultValue;
            },
            update(key: string, value: unknown): Thenable<void> {
                state.set(key, value);
                return Promise.resolve();
            },
            keys(): readonly string[] {
                return Array.from(state.keys());
            },
        },
    } as unknown as vscode.ExtensionContext;
}

// ---------------------------------------------------------------------------
// LinkedAnnotationManager
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree B — LinkedAnnotationManager', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('createLink writes the link via store.update and removeLink removes it', async function () {
        this.timeout(15000);

        const original = 'one\ntwo\nthree\n';
        const uri = await ensureFixture('lot5-mgr-linked-create.ts', original);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const source = store.add(makeDraft(uri, 'source'), { line: 0 }, document);
        store.add(makeDraft(uri, 'target'), { line: 2 }, document);

        const linked = new LinkedAnnotationManager(makeFakeContext(), store);
        subscriptions.push(linked);

        await linked.createLink(source.id, relPath(uri), 2, 'related');

        const refreshed = store.get(source.id);
        assert.ok(refreshed, 'source annotation must still exist');
        assert.deepStrictEqual(refreshed.linkedAnnotations, [
            { targetFile: relPath(uri), targetLine: 2, relationship: 'related' },
        ]);

        await linked.removeLink(source.id, relPath(uri), 2);

        const afterRemove = store.get(source.id);
        assert.ok(afterRemove);
        assert.deepStrictEqual(afterRemove.linkedAnnotations, []);
    });

    test('createLink rejects a circular reference', async function () {
        this.timeout(15000);
        const uri = await ensureFixture('lot5-mgr-linked-cycle.ts', 'a\nb\nc\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const a = store.add(makeDraft(uri, 'A'), { line: 0 }, document);
        const b = store.add(makeDraft(uri, 'B'), { line: 1 }, document);

        const linked = new LinkedAnnotationManager(makeFakeContext(), store);
        subscriptions.push(linked);

        // A → B is fine.
        await linked.createLink(a.id, relPath(uri), 1, 'related');
        // B → A would close the cycle.
        await assert.rejects(linked.createLink(b.id, relPath(uri), 0, 'related'));
    });

    test('getIncomingLinks returns sources targeting a given (file, line)', async function () {
        this.timeout(15000);
        const uri = await ensureFixture('lot5-mgr-linked-incoming.ts', 'l0\nl1\nl2\nl3\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const a = store.add(makeDraft(uri, 'A → C'), { line: 0 }, document);
        const b = store.add(makeDraft(uri, 'B → C'), { line: 1 }, document);
        store.add(makeDraft(uri, 'C'), { line: 2 }, document);

        const linked = new LinkedAnnotationManager(makeFakeContext(), store);
        subscriptions.push(linked);

        await linked.createLink(a.id, relPath(uri), 2, 'related');
        await linked.createLink(b.id, relPath(uri), 2, 'derived-from');

        const incoming = linked.getIncomingLinks(relPath(uri), 2);
        assert.strictEqual(incoming.length, 2);
        const relationships = incoming.map((i) => i.relationship).sort();
        assert.deepStrictEqual(relationships, ['derived-from', 'related']);
    });
});

// ---------------------------------------------------------------------------
// ReviewModeManager
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree B — ReviewModeManager', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('markAsViewed routes through store.update with viewedBy from getUsername', async function () {
        this.timeout(15000);
        const uri = await ensureFixture('lot5-mgr-review-mark.ts', 'r0\nr1\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'review me'), { line: 0 }, document);

        const review = new ReviewModeManager(makeFakeContext(), store, () => 'reviewer-bot');
        subscriptions.push(review);

        await review.markAsViewed(ann.id);

        const refreshed = store.get(ann.id);
        assert.ok(refreshed);
        assert.ok(refreshed.reviewState, 'reviewState must be set');
        assert.strictEqual(refreshed.reviewState.viewed, true);
        assert.strictEqual(refreshed.reviewState.viewedBy, 'reviewer-bot');
        assert.ok(refreshed.reviewState.viewedAt, 'viewedAt must be populated');
    });

    test('getReviewStatistics reflects current store contents', async function () {
        this.timeout(15000);
        const uri = await ensureFixture('lot5-mgr-review-stats.ts', 's0\ns1\ns2\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        store.add({ ...makeDraft(uri, 'first'), severity: 'info', author: 'alice' }, { line: 0 }, document);
        store.add({ ...makeDraft(uri, 'second'), severity: 'warning', author: 'alice' }, { line: 1 }, document);
        store.add({ ...makeDraft(uri, 'third'), severity: 'error', author: 'bob' }, { line: 2 }, document);

        const review = new ReviewModeManager(makeFakeContext(), store, () => 'tester');
        subscriptions.push(review);

        const stats = review.getReviewStatistics();
        assert.strictEqual(stats.total, 3);
        assert.strictEqual(stats.unviewed, 3);
        assert.strictEqual(stats.byAuthor.get('alice'), 2);
        assert.strictEqual(stats.byAuthor.get('bob'), 1);
        assert.strictEqual(stats.bySeverity.get('warning'), 1);
        assert.strictEqual(stats.bySeverity.get('error'), 1);
    });
});

// ---------------------------------------------------------------------------
// SnippetManager (singleton, AnnotationV2 type swap)
// ---------------------------------------------------------------------------

suite('Lot 5 R2 worktree B — SnippetManager', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            subscriptions.pop()?.dispose();
        }
        await closeAllEditors();
    });

    test('addSnippet returns a new AnnotationV2 with the snippet field populated', async function () {
        this.timeout(15000);
        const uri = await ensureFixture('lot5-mgr-snippet-add.ts', 'foo\nbar\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'with snippet'), { line: 0 }, document);

        const snippetMgr = SnippetManager.getInstance();
        const updated = await snippetMgr.addSnippet(ann, 'console.log(${1:value});', 'typescript');

        assert.ok(updated.snippet);
        assert.strictEqual(updated.snippet.language, 'typescript');
        assert.match(updated.snippet.code, /console\.log/);
        // Original annotation unmodified.
        assert.strictEqual(ann.snippet, undefined);
    });

    test('previewSnippet computes line via document.positionAt(startOffset)', async function () {
        this.timeout(15000);
        const original = 'aaaaa\nbbbbb\ntarget-line\nccccc\n';
        const uri = await ensureFixture('lot5-mgr-snippet-preview.ts', original);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'snippet on line 2'), { line: 2 }, document);

        const snippetMgr = SnippetManager.getInstance();
        const withSnippet = await snippetMgr.addSnippet(ann, 'replacement', 'typescript');

        const upserted = store.upsert(withSnippet);
        const preview = await snippetMgr.previewSnippet(upserted, editor);

        assert.ok(preview, 'preview must be defined');
        assert.strictEqual(preview.original, 'target-line');
        assert.strictEqual(preview.modified, 'replacement');
        assert.strictEqual(preview.language, 'typescript');
    });

    test('previewSnippet returns undefined when annotation lacks snippet', async function () {
        this.timeout(15000);
        const uri = await ensureFixture('lot5-mgr-snippet-missing.ts', 'a\nb\n');
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        store.markInitialized();
        const ann = store.add(makeDraft(uri, 'no snippet'), { line: 0 }, document);

        const snippetMgr = SnippetManager.getInstance();
        const preview = await snippetMgr.previewSnippet(ann, editor);
        assert.strictEqual(preview, undefined);
    });
});
