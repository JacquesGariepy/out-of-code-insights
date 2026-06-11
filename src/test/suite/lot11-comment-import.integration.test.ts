/**
 * Lot 11 — better-comments bridge: `annotations.importComments` turns marker
 * comments of the active document into tagged, severity-mapped annotations.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PersistedAnnotation {
    fileUri: string;
    message: string;
    tags?: string[];
    severity?: string;
    startOffset: number;
}

function readPersistedFor(fileUri: string): PersistedAnnotation[] {
    const file = path.join(workspaceRoot(), '.out-of-code-insights', 'annotations.json');
    if (!fs.existsSync(file)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { annotations?: PersistedAnnotation[] };
        return (parsed.annotations ?? []).filter((a) => a.fileUri === fileUri);
    } catch {
        return [];
    }
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

suite('Lot 11 — import code comments as annotations', () => {
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

    test('marker comments become tagged annotations; rerun creates no duplicates', async function () {
        this.timeout(30000);

        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot11-comments.ts'));
        const source =
            'export function pay(amount: number) {\n' +
            '    // ! validate the amount first\n' +
            '    // TODO: support refunds\n' +
            '    return amount; // plain comment, no marker\n' +
            '}\n';
        await vscode.workspace.fs.writeFile(uri, Buffer.from(source, 'utf8'));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(300);

        const original = vscode.window.showInformationMessage;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = async () => undefined;
        try {
            await vscode.commands.executeCommand('annotations.importComments');
            await delay(600);

            const first = readPersistedFor(uri.toString());
            assert.strictEqual(first.length, 2, 'two marker comments imported, plain comment skipped');
            const alert = first.find((a) => a.tags?.includes('alert'));
            const todo = first.find((a) => a.tags?.includes('todo'));
            assert.ok(alert, 'alert (!) marker imported');
            assert.ok(todo, 'todo marker imported');
            assert.strictEqual(alert?.message, 'validate the amount first');
            assert.strictEqual(alert?.severity, 'error');
            assert.strictEqual(todo?.message, 'support refunds');
            assert.ok(alert?.tags?.includes('imported-comment'));
            assert.strictEqual(document.positionAt(alert?.startOffset ?? 0).line, 1);
            assert.strictEqual(document.positionAt(todo?.startOffset ?? 0).line, 2);

            // Idempotence: a second run must not duplicate annotated lines.
            await vscode.commands.executeCommand('annotations.importComments');
            await delay(600);
            assert.strictEqual(readPersistedFor(uri.toString()).length, 2, 'rerun creates no duplicates');
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInformationMessage = original;
        }
    });
});
