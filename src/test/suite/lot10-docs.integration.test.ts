/**
 * Lot 10 — end-to-end documentation generation inside the EDH.
 * Creates annotations through the real command surface, runs
 * `annotations.generateDocs`, and asserts the DocFX-compatible site on disk.
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

suite('Lot 10 — annotations.generateDocs produces a DocFX site', () => {
    const docsDir = () => path.join(workspaceRoot(), 'docs', 'annotations');

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
        fs.rmSync(docsDir(), { recursive: true, force: true });
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    teardown(async () => {
        fs.rmSync(docsDir(), { recursive: true, force: true });
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('generates toc.yml + 4 markdown pages reflecting the annotations', async function () {
        this.timeout(30000);

        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot10-doc-source.md'));
        await vscode.workspace.fs.writeFile(
            uri,
            Buffer.from('# Title\n\nfirst paragraph line\n\nsecond paragraph line\n', 'utf8')
        );
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(300);

        await vscode.commands.executeCommand('annotations.add', { line: 2, message: 'lot10 first annotation' });
        await delay(300);
        await vscode.commands.executeCommand('annotations.add', { line: 4, message: 'lot10 second annotation' });
        await delay(600);

        // Auto-dismiss the completion toast.
        const original = vscode.window.showInformationMessage;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = async () => undefined;
        try {
            await vscode.commands.executeCommand('annotations.generateDocs');
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInformationMessage = original;
        }
        await delay(300);

        for (const f of ['toc.yml', 'index.md', 'by-type.md', 'by-file.md', 'links.md']) {
            assert.ok(fs.existsSync(path.join(docsDir(), f)), `${f} must be generated`);
        }

        const index = fs.readFileSync(path.join(docsDir(), 'index.md'), 'utf8');
        assert.ok(index.includes('**2** annotation(s)'), 'index must count both annotations');
        assert.ok(index.includes('lot10-doc-source.md'), 'index must list the annotated file');

        const byFile = fs.readFileSync(path.join(docsDir(), 'by-file.md'), 'utf8');
        assert.ok(byFile.includes('lot10 first annotation'));
        assert.ok(byFile.includes('lot10 second annotation'));
        assert.ok(byFile.includes('#L3>'), 'source link must carry the resolved 1-based line');
    });
});
