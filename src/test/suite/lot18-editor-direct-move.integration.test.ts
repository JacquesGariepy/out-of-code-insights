// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationEditorMoveController } from '../../commands/AnnotationEditorMoveController';
import { AnnotationMoveService } from '../../commands/AnnotationMoveService';
import { AnnotationPersistence } from '../../transactional/AnnotationPersistence';
import { AnnotationStore, type AnnotationDraft } from '../../transactional/AnnotationStore';

const createdFixtures: vscode.Uri[] = [];

function workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'a workspace folder must be open during tests');
    return folders[0].uri.fsPath;
}

async function fixture(name: string, content: string): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), name));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    createdFixtures.push(uri);
    return vscode.workspace.openTextDocument(uri);
}

function draft(uri: vscode.Uri, message: string): AnnotationDraft {
    return {
        fileUri: uri.toString(),
        file: vscode.workspace.asRelativePath(uri),
        origin: { kind: 'manual' },
        message,
        author: 'reviewer',
        timestamp: new Date().toISOString(),
        thread: [
            { id: 'reply-1', message: 'Keep this discussion', author: 'teammate', timestamp: new Date().toISOString() },
        ],
        tags: ['review'],
        severity: 'warning',
        pinned: true,
    };
}

function persistence(): AnnotationPersistence {
    const root = path.join(os.tmpdir(), `ooci-editor-move-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return new AnnotationPersistence({ uri: { fsPath: root } });
}

suite('Direct editor annotation move', () => {
    const disposables: vscode.Disposable[] = [];

    teardown(async () => {
        while (disposables.length > 0) {
            disposables.pop()?.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        while (createdFixtures.length > 0) {
            const uri = createdFixtures.pop();
            if (uri) {
                await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
            }
        }
    });

    test('picks up the inline annotation and drops it at the cursor without losing team metadata', async function () {
        this.timeout(10000);
        const source = await fixture('lot18-source.ts', 'zero\nannotated\nlast\n');
        const target = await fixture('lot18-target.ts', 'target zero\ntarget one\ntarget two\ntarget three\n');
        const store = new AnnotationStore();
        store.markInitialized();
        const annotation = store.add(draft(source.uri, 'Move from the inline hint'), { line: 1 }, source);
        const controller = new AnnotationEditorMoveController(
            store,
            new AnnotationMoveService(store, persistence()),
            false
        );
        disposables.push(controller);

        const editor = await vscode.window.showTextDocument(target);
        editor.selection = new vscode.Selection(new vscode.Position(2, 3), new vscode.Position(2, 3));

        assert.strictEqual(await controller.pickUp({ ids: [annotation.id] }), 1);
        assert.strictEqual(controller.isActive(), true);
        assert.strictEqual(await controller.dropAtCursor(), 1);
        assert.strictEqual(controller.isActive(), false);

        const moved = store.get(annotation.id);
        assert.strictEqual(moved?.id, annotation.id);
        assert.strictEqual(moved?.fileUri, target.uri.toString());
        assert.strictEqual(target.positionAt(moved?.startOffset ?? -1).line, 2);
        assert.strictEqual(moved?.author, 'reviewer');
        assert.deepStrictEqual(moved?.tags, ['review']);
        assert.deepStrictEqual(moved?.thread, annotation.thread);
        assert.strictEqual(moved?.severity, 'warning');
        assert.strictEqual(moved?.pinned, true);
    });

    test('cancel clears move mode without changing the annotation', async () => {
        const source = await fixture('lot18-cancel.ts', 'zero\nannotated\n');
        const store = new AnnotationStore();
        store.markInitialized();
        const annotation = store.add(draft(source.uri, 'Do not move'), { line: 1 }, source);
        const controller = new AnnotationEditorMoveController(
            store,
            new AnnotationMoveService(store, persistence()),
            false
        );
        disposables.push(controller);

        assert.strictEqual(await controller.pickUp(annotation.id), 1);
        await controller.cancel();

        assert.strictEqual(controller.isActive(), false);
        assert.strictEqual(store.get(annotation.id)?.fileUri, source.uri.toString());
        assert.strictEqual(source.positionAt(store.get(annotation.id)?.startOffset ?? -1).line, 1);
    });

    test('keeps move mode active and refuses ephemeral editor targets', async () => {
        const source = await fixture('lot18-virtual-target.ts', 'zero\nannotated\n');
        const store = new AnnotationStore();
        store.markInitialized();
        const annotation = store.add(draft(source.uri, 'Keep in workspace'), { line: 1 }, source);
        const controller = new AnnotationEditorMoveController(
            store,
            new AnnotationMoveService(store, persistence()),
            false
        );
        disposables.push(controller);

        const untitled = await vscode.workspace.openTextDocument({ content: 'temporary\ntarget\n', language: 'text' });
        await vscode.window.showTextDocument(untitled);

        assert.strictEqual(await controller.pickUp(annotation.id), 1);
        assert.strictEqual(await controller.dropAtCursor(), 0);
        assert.strictEqual(controller.isActive(), true, 'the user must be able to choose a valid target and retry');
        assert.strictEqual(store.get(annotation.id)?.fileUri, source.uri.toString());
        await controller.cancel();
    });
});
