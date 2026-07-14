import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

type ExtensionHooks = import('../../extension').ExtensionApi;
let hooks: ExtensionHooks;

function workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'conversion history tests require a workspace');
    return folders[0].uri.fsPath;
}

async function createDocument(name: string, text: string): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), name));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    return document;
}

async function applyEdit(
    document: vscode.TextDocument,
    configure: (edit: vscode.WorkspaceEdit) => void
): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    configure(edit);
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
}

async function editorHistory(command: 'undo' | 'redo', document: vscode.TextDocument): Promise<void> {
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand(command);
    await hooks.__waitForSourceConversionPersistenceForTest();
}

suite('Conversion-aware native Undo/Redo — Extension Host', () => {
    const files = new Set<vscode.Uri>();
    const annotationIds = new Set<string>();

    suiteSetup(async function () {
        this.timeout(30000);
        const extension =
            vscode.extensions.getExtension('jacquesgariepy.out-of-code-insights') ??
            vscode.extensions.getExtension('JacquesGariepy.out-of-code-insights');
        assert.ok(extension, 'development extension must be available');
        hooks = (await extension.activate()) as ExtensionHooks;
    });

    teardown(async () => {
        const store = hooks.getAnnotationStore();
        if (store) {
            for (const id of annotationIds) {
                if (store.get(id)) {
                    store.remove(id);
                }
            }
        }
        annotationIds.clear();
        hooks.__clearSourceConversionHistoryForTest();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const uri of files) {
            await vscode.workspace.fs.delete(uri, { useTrash: false }).then(
                () => undefined,
                () => undefined
            );
        }
        files.clear();
    });

    test('comments→annotations mirrors both native Undo and Redo', async function () {
        this.timeout(20000);
        const before = '// note\nconst value = 1;\n';
        const after = '\nconst value = 1;\n';
        const document = await createDocument('.ooci-conversion-comments-to-annotations.txt', before);
        files.add(document.uri);
        const store = hooks.getAnnotationStore();
        assert.ok(store);

        await applyEdit(document, (edit) => edit.delete(document.uri, new vscode.Range(0, 0, 0, 7)));
        assert.strictEqual(document.getText(), after);
        const created = store.add(
            {
                fileUri: document.uri.toString(),
                file: path.basename(document.uri.fsPath),
                origin: { kind: 'manual' },
                message: 'note',
                timestamp: new Date().toISOString(),
            },
            { line: 1 },
            document
        );
        annotationIds.add(created.id);
        const entryId = hooks.__recordSourceConversionForTest({
            uri: document.uri.toString(),
            direction: 'comments-to-annotations',
            beforeText: before,
            afterText: after,
            beforeSnapshots: [],
            afterSnapshots: [created],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [created],
        });

        await editorHistory('undo', document);
        assert.strictEqual(document.getText(), before);
        assert.strictEqual(store.get(created.id), undefined);
        assert.strictEqual(hooks.__sourceConversionPhaseForTest(entryId), 'undone');

        await editorHistory('redo', document);
        assert.strictEqual(document.getText(), after);
        assert.ok(store.get(created.id));
        assert.strictEqual(hooks.__sourceConversionPhaseForTest(entryId), 'applied');
    });

    test('annotations→comments mirrors both native Undo and Redo', async function () {
        this.timeout(20000);
        const before = 'const value = 1;\n';
        const inserted = '// annotation\n';
        const after = `${inserted}${before}`;
        const document = await createDocument('.ooci-conversion-annotations-to-comments.txt', before);
        files.add(document.uri);
        const store = hooks.getAnnotationStore();
        assert.ok(store);
        const original = store.add(
            {
                fileUri: document.uri.toString(),
                file: path.basename(document.uri.fsPath),
                origin: { kind: 'manual' },
                message: 'annotation',
                timestamp: new Date().toISOString(),
            },
            { line: 0 },
            document
        );
        annotationIds.add(original.id);

        await applyEdit(document, (edit) => edit.insert(document.uri, new vscode.Position(0, 0), inserted));
        const postInsert = store.get(original.id);
        assert.ok(postInsert);
        store.remove(original.id);
        const entryId = hooks.__recordSourceConversionForTest({
            uri: document.uri.toString(),
            direction: 'annotations-to-comments',
            beforeText: before,
            afterText: after,
            beforeSnapshots: [original],
            afterSnapshots: [],
            undoInstallSnapshots: [postInsert],
            redoInstallSnapshots: [],
        });

        await editorHistory('undo', document);
        assert.strictEqual(document.getText(), before);
        assert.ok(store.get(original.id));
        assert.strictEqual(hooks.__sourceConversionPhaseForTest(entryId), 'undone');

        await editorHistory('redo', document);
        assert.strictEqual(document.getText(), after);
        assert.strictEqual(store.get(original.id), undefined);
        assert.strictEqual(hooks.__sourceConversionPhaseForTest(entryId), 'applied');
    });

    test('business divergence refuses annotation removal while source Undo still proceeds', async function () {
        this.timeout(20000);
        const before = '// note\nconst value = 1;\n';
        const after = '\nconst value = 1;\n';
        const document = await createDocument('.ooci-conversion-divergence.txt', before);
        files.add(document.uri);
        const store = hooks.getAnnotationStore();
        assert.ok(store);
        await applyEdit(document, (edit) => edit.delete(document.uri, new vscode.Range(0, 0, 0, 7)));
        const created = store.add(
            {
                fileUri: document.uri.toString(),
                file: path.basename(document.uri.fsPath),
                origin: { kind: 'manual' },
                message: 'note',
                timestamp: new Date().toISOString(),
            },
            { line: 1 },
            document
        );
        annotationIds.add(created.id);
        const entryId = hooks.__recordSourceConversionForTest({
            uri: document.uri.toString(),
            direction: 'comments-to-annotations',
            beforeText: before,
            afterText: after,
            beforeSnapshots: [],
            afterSnapshots: [created],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [created],
        });
        store.update(created.id, { message: 'edited after conversion' });

        await editorHistory('undo', document);
        assert.strictEqual(document.getText(), before);
        assert.strictEqual(store.get(created.id)?.message, 'edited after conversion');
        assert.strictEqual(hooks.__sourceConversionPhaseForTest(entryId), 'diverged');
    });
});
