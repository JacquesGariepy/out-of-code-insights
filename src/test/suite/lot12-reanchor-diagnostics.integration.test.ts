import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { hashLine } from '../../anchoring/anchor';
import type { AnnotationStoreFileV2, AnnotationV2 } from '../../transactional/types';

const EXTENSION_IDS = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];

function extension(): vscode.Extension<unknown> {
    const found = EXTENSION_IDS.map((id) => vscode.extensions.getExtension(id)).find(
        (candidate): candidate is vscode.Extension<unknown> => candidate !== undefined
    );
    assert.ok(found, 'development extension must be installed in the test host');
    return found;
}

function workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'integration workspace must be open');
    return folder.uri.fsPath;
}

async function fixture(name: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), name));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
}

function envelopeUri(): vscode.Uri {
    return vscode.Uri.file(path.join(workspaceRoot(), '.out-of-code-insights', 'annotations.json'));
}

async function readEnvelope(): Promise<AnnotationStoreFileV2> {
    const bytes = await vscode.workspace.fs.readFile(envelopeUri());
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as AnnotationStoreFileV2;
}

async function waitForAnnotation(predicate: (annotation: AnnotationV2) => boolean): Promise<AnnotationV2> {
    const deadline = Date.now() + 5_000;
    do {
        try {
            const found = (await readEnvelope()).annotations.find(predicate);
            if (found) {
                return found;
            }
        } catch {
            // Persistence may still be creating the envelope.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail('timed out waiting for the annotation persistence update');
}

suite('Lot 12 — manual re-anchor and local diagnostics commands', () => {
    const createdIds: string[] = [];

    suiteSetup(async function () {
        this.timeout(30_000);
        await extension().activate();
    });

    teardown(async () => {
        if (createdIds.length > 0) {
            try {
                const envelope = await readEnvelope();
                envelope.annotations = envelope.annotations.filter((annotation) => !createdIds.includes(annotation.id));
                await vscode.workspace.fs.writeFile(
                    envelopeUri(),
                    Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
                );
            } catch {
                // The test assertion remains authoritative if cleanup cannot run.
            }
            createdIds.length = 0;
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('re-anchor command moves the same id to the current cursor and recaptures the destination range', async function () {
        this.timeout(20_000);
        const sourceUri = await fixture('lot12-reanchor-source.ts', 'a very long annotated source line\nsecond\n');
        const targetUri = await fixture('lot12-reanchor-target.ts', 'zero\ntiny\nafter\n');
        const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
        const targetDocument = await vscode.workspace.openTextDocument(targetUri);
        const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
        sourceEditor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: 0,
            message: 'lot12 manual recovery',
        });
        const annotation = await waitForAnnotation((candidate) => candidate.message === 'lot12 manual recovery');
        createdIds.push(annotation.id);

        const editor = await vscode.window.showTextDocument(targetDocument);
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        await vscode.commands.executeCommand('annotations.reanchorToCursor', annotation.id);

        const moved = await waitForAnnotation(
            (candidate) => candidate.id === annotation.id && candidate.fileUri === targetUri.toString()
        );
        assert.strictEqual(moved.fileUri, targetUri.toString());
        assert.strictEqual(targetDocument.positionAt(moved.startOffset).line, 1);
        assert.strictEqual(moved.endOffset - moved.startOffset, 'tiny'.length);
        assert.strictEqual(moved.lineHash, hashLine('tiny'));
    });

    test('diagnostics command opens a valid privacy-preserving JSON report', async function () {
        this.timeout(20_000);
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('annotations.showTrackingDiagnostics'));

        await vscode.commands.executeCommand('annotations.showTrackingDiagnostics');
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document, 'diagnostic report editor must open');
        assert.strictEqual(document.languageId, 'json');
        const report = JSON.parse(document.getText()) as {
            counts: { total: number };
            annotations: Array<{ issues: string[]; storedLineHash: string }>;
        };
        assert.ok(report.counts.total >= 0);
        assert.ok(Array.isArray(report.annotations));
        assert.strictEqual(document.getText().includes('a very long annotated source line'), false);
    });
});
