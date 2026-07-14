/**
 * Lot 9 — real developer-workflow gestures against the live EDH.
 *
 * Covers the lifecycle gaps beyond lot7/lot8: multi-cursor edits,
 * find-and-replace-all shaped WorkspaceEdits, formatter-style full-document
 * replaces, editor line moves (Alt+Down), files rewritten outside the editor
 * (git pull / branch switch simulation), file rename, and file delete with
 * the keep-or-delete prompt.
 *
 * Assertions read the persisted v2 envelope (the canonical cross-boundary
 * view) and replicate the decoration-visibility predicate: the stored
 * lineHash must match the hash of the line at positionAt(startOffset).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hashLine } from '../../anchoring/anchor';

const EXTENSION_ID_CANDIDATES = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];

function findExtension(): vscode.Extension<unknown> | undefined {
    for (const id of EXTENSION_ID_CANDIDATES) {
        const ext = vscode.extensions.getExtension(id);
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

interface PersistedV2Annotation {
    id: string;
    fileUri: string;
    file?: string;
    startOffset: number;
    endOffset: number;
    state?: string;
    lineHash?: string;
    message: string;
}

function readPersisted(): PersistedV2Annotation[] {
    const file = annotationsFilePath();
    if (!fs.existsSync(file)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            schemaVersion?: number;
            annotations?: PersistedV2Annotation[];
        };
        if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.annotations)) {
            return [];
        }
        return parsed.annotations;
    } catch {
        return [];
    }
}

function readPersistedFor(fileUri: string): PersistedV2Annotation[] {
    return readPersisted().filter((a) => a.fileUri === fileUri);
}

async function waitForPersistedCount(fileUri: string, expected: number, timeoutMs = 10000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let count = readPersistedFor(fileUri).length;
    while (count !== expected && Date.now() < deadline) {
        await delay(100);
        count = readPersistedFor(fileUri).length;
    }
    return count;
}

async function waitForPersistedTotalCount(expected: number, timeoutMs = 15000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let count = readPersisted().length;
    while (count !== expected && Date.now() < deadline) {
        await delay(100);
        count = readPersisted().length;
    }
    return count;
}

async function closeAllEditors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type WarningStubChoice = string | undefined;

function stubWarningMessage(returnValue: WarningStubChoice): () => void {
    const original = vscode.window.showWarningMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showWarningMessage = async () => returnValue;
    return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = original;
    };
}

async function clearAllAnnotationsViaCommand(): Promise<void> {
    const restore = stubWarningMessage('Yes');
    try {
        await vscode.commands.executeCommand('annotations.clearAll');
    } catch {
        /* best-effort cleanup */
    } finally {
        restore();
    }
}

const MD_FIXTURE =
    '# ADR 001\n' +
    '\n' +
    '**Status:** Accepted\n' +
    '**Deciders:** Jacques Gariepy\n' +
    '\n' +
    '---\n' +
    '\n' +
    '## Context\n' +
    'The extension must persist annotations across VS Code sessions.\n' +
    '\n' +
    '- A cloud API option.\n' +
    '- A JSON file stored inside the workspace folder.\n';

const CONTEXT_LINE = 7; // 0-based line of '## Context'

interface View {
    count: number;
    state: string;
    line: number;
    attached: boolean;
}

function viewFor(document: vscode.TextDocument, fileUri: string): View {
    const anns = readPersistedFor(fileUri);
    if (anns.length !== 1) {
        return { count: anns.length, state: 'n/a', line: -1, attached: false };
    }
    const a = anns[0];
    let line = -1;
    if (a.startOffset >= 0 && a.startOffset <= document.getText().length) {
        line = document.positionAt(a.startOffset).line;
    }
    const attached = line >= 0 && line < document.lineCount && a.lineHash === hashLine(document.lineAt(line).text);
    return { count: 1, state: a.state ?? 'active', line, attached };
}

async function waitForAttachedView(document: vscode.TextDocument, fileUri: string, timeoutMs = 10000): Promise<View> {
    const deadline = Date.now() + timeoutMs;
    let latest = viewFor(document, fileUri);
    while ((latest.count !== 1 || !latest.attached) && Date.now() < deadline) {
        await delay(100);
        latest = viewFor(document, fileUri);
    }
    return latest;
}

async function openFixture(
    name: string
): Promise<{ uri: vscode.Uri; document: vscode.TextDocument; editor: vscode.TextEditor }> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), name));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(MD_FIXTURE, 'utf8'));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    await delay(300);
    return { uri, document, editor };
}

async function annotateContextLine(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'annotation setup requires an active fixture editor');
    const fileUri = editor.document.uri.toString();
    const createdId = await vscode.commands.executeCommand<string>('annotations.add', {
        line: CONTEXT_LINE,
        message: 'lot9-context',
    });
    assert.ok(createdId, 'annotation setup command must return the created id');

    const deadline = Date.now() + 15000;
    let created = readPersistedFor(fileUri).find((annotation) => annotation.id === createdId);
    while (!created && Date.now() < deadline) {
        await delay(100);
        created = readPersistedFor(fileUri).find((annotation) => annotation.id === createdId);
    }
    assert.ok(created, `annotation ${createdId} must be durable before the workflow gesture starts`);
}

suite('Lot 9 — developer workflow gestures keep annotations attached', () => {
    suiteSetup(async function () {
        this.timeout(60000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();
    });

    setup(async function () {
        // A timed-out async hook keeps running in Mocha and contaminates the
        // following suites. Allow the serialized atomic-save queue to drain,
        // then prove the cleanup reached disk before opening the next fixture.
        this.timeout(60000);
        await clearAllAnnotationsViaCommand();
        const remaining = await waitForPersistedTotalCount(0);
        assert.strictEqual(remaining, 0, 'setup cleanup must be durable before the next workflow starts');
        await closeAllEditors();
    });

    teardown(async function () {
        this.timeout(45000);
        await closeAllEditors();
    });

    test('two successive keystrokes at the end of the annotated line', async function () {
        this.timeout(45000);
        const { uri, document, editor } = await openFixture('lot9-keys.md');
        await annotateContextLine();

        const eol = document.lineAt(CONTEXT_LINE).text.length;
        editor.selection = new vscode.Selection(CONTEXT_LINE, eol, CONTEXT_LINE, eol);
        await vscode.commands.executeCommand('type', { text: 'a' });
        await delay(250);
        await vscode.commands.executeCommand('type', { text: 'b' });

        const v = await waitForAttachedView(document, uri.toString());
        assert.strictEqual(v.count, 1);
        assert.strictEqual(v.state, 'active');
        assert.strictEqual(v.line, CONTEXT_LINE);
        assert.strictEqual(v.attached, true, 'hash must track BOTH keystrokes, not only the first');
    });

    test('multi-cursor edit: simultaneous inserts on the annotated line and above', async function () {
        this.timeout(45000);
        const { uri, document, editor } = await openFixture('lot9-multicursor.md');
        await annotateContextLine();

        await editor.edit((eb) => {
            eb.insert(new vscode.Position(CONTEXT_LINE, 0), 'X');
            eb.insert(new vscode.Position(0, 0), 'Q\n');
        });

        const v = await waitForAttachedView(document, uri.toString());
        assert.strictEqual(v.count, 1);
        assert.strictEqual(v.state, 'active');
        assert.strictEqual(v.line, CONTEXT_LINE + 1, 'one line was inserted above');
        assert.strictEqual(v.attached, true, 'hash must bind to the final "X## Context" line');
    });

    test('find-and-replace-all shaped WorkspaceEdit touching the annotated line', async function () {
        this.timeout(45000);
        const { uri, document } = await openFixture('lot9-replaceall.md');
        await annotateContextLine();

        // Replace every occurrence of 'Context'/'extension' the way Replace All
        // does: several precise single-line replaces in ONE WorkspaceEdit.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(CONTEXT_LINE, 3, CONTEXT_LINE, 10), 'Background');
        edit.replace(uri, new vscode.Range(8, 4, 8, 13), 'plugin');
        await vscode.workspace.applyEdit(edit);

        const v = await waitForAttachedView(document, uri.toString());
        assert.strictEqual(v.count, 1);
        assert.strictEqual(v.state, 'active');
        assert.strictEqual(v.line, CONTEXT_LINE);
        assert.strictEqual(v.attached, true, 'hash must rebind to "## Background"');
    });

    test('formatter-style full-document replace (re-indent) keeps the annotation on its line', async function () {
        this.timeout(45000);
        const { uri, document } = await openFixture('lot9-format.md');
        await annotateContextLine();

        const reindented = MD_FIXTURE.split('\n')
            .map((l) => (l.length > 0 ? '  ' + l : l))
            .join('\n');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), reindented);
        await vscode.workspace.applyEdit(edit);

        const v = await waitForAttachedView(document, uri.toString());
        assert.strictEqual(v.count, 1);
        assert.strictEqual(v.state, 'active', 'survival check must rescue, not suspend');
        assert.strictEqual(v.line, CONTEXT_LINE, 'normalized hash ignores the new indentation');
        assert.strictEqual(v.attached, true);
    });

    test('Alt+Down (editor.action.moveLinesDownAction) — annotation follows its line', async function () {
        this.timeout(45000);
        const { uri, document, editor } = await openFixture('lot9-movedown.md');
        await annotateContextLine();

        editor.selection = new vscode.Selection(CONTEXT_LINE, 0, CONTEXT_LINE, 0);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await delay(50);
        assert.strictEqual(
            vscode.window.activeTextEditor?.document.uri.toString(),
            uri.toString(),
            'Alt+Down: the fixture editor must be active before dispatch'
        );
        await vscode.commands.executeCommand('editor.action.moveLinesDownAction');

        const v = await waitForAttachedView(document, uri.toString());
        assert.strictEqual(v.count, 1);
        assert.strictEqual(v.state, 'active');
        assert.strictEqual(v.line, CONTEXT_LINE + 1, 'annotation must follow the moved line');
        assert.strictEqual(v.attached, true);
    });

    test('file rewritten on disk while closed (git pull simulation) — re-anchored on reopen', async function () {
        this.timeout(30000);
        const { uri } = await openFixture('lot9-gitpull.md');
        await annotateContextLine();
        await closeAllEditors();
        await delay(500);

        // Rewrite on disk: three lines prepended (what a pull typically does).
        const rewritten = '<!-- pulled 1 -->\n<!-- pulled 2 -->\n<!-- pulled 3 -->\n' + MD_FIXTURE;
        fs.writeFileSync(uri.fsPath, rewritten, 'utf8');
        await delay(500);

        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(1200);

        const v = await waitForAttachedView(document, uri.toString());
        assert.strictEqual(v.count, 1);
        assert.strictEqual(v.state, 'active');
        assert.strictEqual(v.line, CONTEXT_LINE + 3, 'annotation must re-anchor to the shifted line');
        assert.strictEqual(v.attached, true);
    });

    test('file rename — fileUri follows for active annotations', async function () {
        this.timeout(30000);
        const { uri } = await openFixture('lot9-rename.md');
        await annotateContextLine();
        await closeAllEditors();
        await delay(300);

        const newUri = vscode.Uri.file(path.join(workspaceRoot(), 'lot9-renamed.md'));
        try {
            // workspace.fs.rename does NOT fire onDidRenameFiles (documented);
            // a WorkspaceEdit file operation does — same path as an explorer
            // rename gesture.
            const we = new vscode.WorkspaceEdit();
            we.renameFile(uri, newUri, { overwrite: true });
            await vscode.workspace.applyEdit(we);
            await delay(800);

            const old = readPersistedFor(uri.toString());
            const renamed = readPersistedFor(newUri.toString());
            assert.strictEqual(old.length, 0, 'no annotation may keep the old uri');
            assert.strictEqual(renamed.length, 1, 'annotation must follow the rename');
            assert.strictEqual(renamed[0].state ?? 'active', 'active');
        } finally {
            try {
                await vscode.workspace.fs.delete(newUri);
            } catch {
                /* fixture cleanup is best-effort */
            }
        }
    });

    test('file delete — "Delete annotations" choice removes them', async function () {
        this.timeout(30000);
        const { uri } = await openFixture('lot9-delete.md');
        await annotateContextLine();
        await closeAllEditors();
        await delay(300);

        const restore = stubWarningMessage('Delete annotations');
        try {
            // WorkspaceEdit.deleteFile fires onDidDeleteFiles (workspace.fs.delete does not).
            const we = new vscode.WorkspaceEdit();
            we.deleteFile(uri);
            await vscode.workspace.applyEdit(we);
            const remaining = await waitForPersistedCount(uri.toString(), 0);
            assert.strictEqual(remaining, 0, 'annotations must be durably removed on request');
        } finally {
            restore();
        }
    });

    test('file delete — "Keep annotations" choice preserves them as orphans', async function () {
        this.timeout(30000);
        const { uri } = await openFixture('lot9-keep.md');
        await annotateContextLine();
        await closeAllEditors();
        await delay(300);

        const restore = stubWarningMessage('Keep annotations');
        try {
            const we = new vscode.WorkspaceEdit();
            we.deleteFile(uri);
            await vscode.workspace.applyEdit(we);
            await delay(1000);
        } finally {
            restore();
        }
        const kept = readPersistedFor(uri.toString());
        assert.strictEqual(kept.length, 1, 'annotation data must survive the file deletion');
        assert.strictEqual(kept[0].message, 'lot9-context');
    });
});
