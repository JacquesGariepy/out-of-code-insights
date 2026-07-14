/**
 * Lot 13 — annotations.json file watcher: external writes (MCP server or any
 * other tool) are reloaded into the live store without a window reload, and
 * the extension's own saves do not loop through the watcher.
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

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Envelope {
    schemaVersion: number;
    annotations: Array<{ id: string; message: string; fileUri: string }>;
}

function readEnvelope(): Envelope {
    return JSON.parse(fs.readFileSync(annotationsFilePath(), 'utf8')) as Envelope;
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

suite('Lot 13 — external annotations.json changes reload into the live store', () => {
    suiteSetup(async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();
    });

    setup(async function () {
        this.timeout(30000);
        await clearAllAnnotationsViaCommand();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('an annotation appended externally survives subsequent extension saves', async function () {
        this.timeout(45000);

        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot13-watch.md'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from('alpha line\nbeta line\ngamma line\n', 'utf8'));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(300);

        // A — created through the extension.
        await vscode.commands.executeCommand('annotations.add', { line: 0, message: 'lot13-A' });
        await delay(600);
        assert.strictEqual(
            readEnvelope().annotations.filter((a) => a.message.startsWith('lot13-')).length,
            1,
            'setup: A persisted'
        );

        // B — appended EXTERNALLY immediately after the extension save
        // (exactly what the MCP server does). This intentionally lands inside
        // the former two-second suppression window: content causality, not
        // timing, must decide whether the watcher reloads it.
        const externalUri = vscode.Uri.file(path.join(workspaceRoot(), 'lot13-external.md')).toString();
        const envelope = readEnvelope();
        envelope.annotations.push({
            id: 'lot13-external-id',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            schemaVersion: 2 as any,
            fileUri: externalUri,
            file: 'lot13-external.md',
            startOffset: 0,
            endOffset: 5,
            lineHash: hashLine('hello'),
            contextBefore: [],
            contextAfter: [],
            state: 'active',
            origin: { kind: 'manual' },
            message: 'lot13-B-external',
            timestamp: new Date().toISOString(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        fs.writeFileSync(annotationsFilePath(), JSON.stringify(envelope, null, 2), 'utf8');

        // Give the watcher time to fire and the store time to reload.
        await delay(1500);

        // C — created through the extension AFTER the external write. If the
        // watcher did not reload B into the store, this save would overwrite
        // the file without B.
        await vscode.commands.executeCommand('annotations.add', { line: 1, message: 'lot13-C' });
        await delay(800);

        const messages = readEnvelope()
            .annotations.map((a) => a.message)
            .filter((m) => m.startsWith('lot13-'))
            .sort();
        assert.deepStrictEqual(
            messages,
            ['lot13-A', 'lot13-B-external', 'lot13-C'],
            'external annotation must survive the next extension-side save'
        );
    });
});
