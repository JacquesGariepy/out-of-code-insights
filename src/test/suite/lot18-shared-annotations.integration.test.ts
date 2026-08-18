/**
 * Lot 18 — annotations.json shared across workstations (discussion #80).
 *
 * A teammate commits .out-of-code-insights/annotations.json from their
 * machine: every fileUri records THEIR absolute path. After a git pull on
 * another workstation, those URIs point at nonexistent files, decorations
 * never attach, and `annotations.navigate` used to fail with
 * "cannot open file ... Unable to resolve nonexistent file".
 *
 * This suite replays that exact flow against the live extension: a foreign
 * envelope lands on disk (same watcher path as a pull while VS Code is
 * open), the store rehomes it onto the current workspace, and navigation
 * opens the LOCAL file at the annotated line.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hashLine } from '../../anchoring/anchor';

const EXTENSION_ID_CANDIDATES = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];

interface StoreAnnotationView {
    id: string;
    fileUri: string;
    file: string;
    message: string;
}

interface TestExtensionApi {
    getAnnotationStore(): { getAll(): StoreAnnotationView[] } | undefined;
    __flushAnnotationPersistenceForTest(): Promise<void>;
}

function findExtension(): vscode.Extension<TestExtensionApi> | undefined {
    for (const id of EXTENSION_ID_CANDIDATES) {
        const ext = vscode.extensions.getExtension<TestExtensionApi>(id);
        if (ext) {
            return ext;
        }
    }
    return undefined;
}

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders;
    assert.ok(ws && ws.length > 0, 'a workspace folder must be open during tests');
    return ws[0].uri.fsPath;
}

function annotationsFilePath(): string {
    return path.join(workspaceRoot(), '.out-of-code-insights', 'annotations.json');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearAllAnnotationsViaCommand(): Promise<void> {
    const original = vscode.window.showWarningMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showWarningMessage = async () => 'Yes';
    try {
        await vscode.commands.executeCommand('annotations.clearAll');
    } catch {
        /* best-effort */
    } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = original;
    }
}

suite('Lot 18 — teammate annotations.json rehomes onto this workspace (discussion #80)', () => {
    let api: TestExtensionApi;

    suiteSetup(async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        api = await ext.activate();
    });

    setup(async function () {
        this.timeout(30000);
        await clearAllAnnotationsViaCommand();
        // Wait out the debounced post-clear save so it cannot overwrite the
        // teammate envelope this test writes next.
        await api.__flushAnnotationPersistenceForTest();
        await delay(400);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test("navigate opens the local file for an annotation committed from a teammate's machine", async function () {
        this.timeout(45000);

        // The shared source file exists locally (it came with the git pull).
        const localUri = vscode.Uri.file(path.join(workspaceRoot(), 'lot18-shared.md'));
        const content = 'alpha line\nbeta line\ngamma line\n';
        await vscode.workspace.fs.writeFile(localUri, Buffer.from(content, 'utf8'));

        // The teammate's envelope: fileUri is THEIR absolute path (a POSIX
        // home directory that cannot exist on this Windows test runner),
        // while `file` carries the portable workspace-relative path. Written
        // externally, exactly like a git pull updating annotations.json
        // while VS Code is open.
        const annotationId = '3f2f1d8a-9b41-4c5e-8a67-2f90d1c44e21';
        const betaLineStart = 'alpha line\n'.length;
        const envelope = {
            schemaVersion: 2,
            annotations: [
                {
                    id: annotationId,
                    schemaVersion: 2,
                    fileUri: 'file:///home/teammate/repos/project/lot18-shared.md',
                    file: 'lot18-shared.md',
                    startOffset: betaLineStart,
                    endOffset: betaLineStart + 'beta line'.length,
                    lineHash: hashLine('beta line'),
                    contextBefore: ['alpha line'],
                    contextAfter: ['gamma line', ''],
                    state: 'active',
                    origin: { kind: 'manual' },
                    message: 'lot18-from-teammate',
                    timestamp: new Date().toISOString(),
                },
            ],
        };
        fs.mkdirSync(path.dirname(annotationsFilePath()), { recursive: true });
        fs.writeFileSync(annotationsFilePath(), JSON.stringify(envelope, null, 2), 'utf8');

        // Give the watcher time to fire and the store time to reload+rehome.
        await delay(2000);

        // The store must have reloaded the external envelope AND rebased the
        // teammate's absolute URI onto this workspace.
        const store = api.getAnnotationStore();
        assert.ok(store, 'annotation store must be available');
        const shared = store.getAll().find((a) => a.message === 'lot18-from-teammate');
        assert.ok(shared, 'the external teammate envelope must be reloaded into the live store');
        assert.strictEqual(
            shared.fileUri,
            localUri.toString(),
            "the teammate's absolute fileUri must be rebased onto this workspace at load time"
        );
        assert.strictEqual(shared.file, 'lot18-shared.md');

        // Viviane's failing action: navigate to the shared annotation. Before
        // rehoming this surfaced "Error executing command navigate: cannot
        // open file '/home/teammate/...'" and no editor opened.
        await vscode.commands.executeCommand('annotations.navigate', annotationId);
        await delay(500);

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'navigate must open an editor for the rehomed annotation');
        assert.strictEqual(
            editor.document.uri.fsPath,
            localUri.fsPath,
            "navigate must resolve the teammate's annotation to the LOCAL copy of the file"
        );
        assert.strictEqual(editor.selection.start.line, 1, 'the annotated line (beta line) must be selected');
        assert.strictEqual(editor.document.lineAt(editor.selection.start.line).text, 'beta line');
    });

    test('navigate preserves fileUri without corrupting it when reloading annotations (issue #100)', async function () {
        this.timeout(45000);

        const subfolderUri = vscode.Uri.file(path.join(workspaceRoot(), 'subpkg', 'index.js'));
        fs.mkdirSync(path.dirname(subfolderUri.fsPath), { recursive: true });
        const content = 'console.log("hello");\nconsole.log("target");\n';
        await vscode.workspace.fs.writeFile(subfolderUri, Buffer.from(content, 'utf8'));

        const annotationId = 'a100-test-id-preserve-fileuri';
        const targetLineStart = 'console.log("hello");\n'.length;
        const envelope = {
            schemaVersion: 2,
            annotations: [
                {
                    id: annotationId,
                    schemaVersion: 2,
                    fileUri: subfolderUri.toString(),
                    file: 'subpkg/index.js',
                    startOffset: targetLineStart,
                    endOffset: targetLineStart + 'console.log("target");'.length,
                    lineHash: hashLine('console.log("target");'),
                    contextBefore: ['console.log("hello");'],
                    contextAfter: [''],
                    state: 'active',
                    origin: { kind: 'manual' },
                    message: 'issue-100-preserve-target',
                    timestamp: new Date().toISOString(),
                },
            ],
        };
        fs.writeFileSync(annotationsFilePath(), JSON.stringify(envelope, null, 2), 'utf8');

        await delay(2000);

        const store = api.getAnnotationStore();
        assert.ok(store, 'annotation store must be available');
        const item = store.getAll().find((a) => a.message === 'issue-100-preserve-target');
        assert.ok(item, 'the annotation must be loaded into the live store');
        assert.strictEqual(item.fileUri, subfolderUri.toString(), 'fileUri must be preserved exactly');

        await vscode.commands.executeCommand('annotations.navigate', annotationId);
        await delay(500);

        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'navigate must open an editor for the preserved annotation');
        assert.strictEqual(editor.document.uri.fsPath, subfolderUri.fsPath);
        assert.strictEqual(editor.selection.start.line, 1);
    });
});
