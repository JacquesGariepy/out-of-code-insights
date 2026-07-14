import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { hashLine } from '../../anchoring/anchor';
import type { AnnotationStoreFileV2, AnnotationV2 } from '../../transactional/types';

type ExtensionHooks = import('../../extension').ExtensionApi;

const EXTENSION_IDS = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];
const PERSISTENCE_POLL_TIMEOUT_MS = 15_000;
const PERSISTENCE_POLL_INTERVAL_MS = 100;

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

async function addAnnotation(line: number, message: string): Promise<string> {
    const result = await vscode.commands.executeCommand<unknown>('annotations.add', { line, message });
    assert.strictEqual(typeof result, 'string', 'annotations.add must return the created annotation id');
    const id = result as string;
    assert.ok(id.trim().length > 0, 'annotations.add must return a non-empty annotation id');
    return id;
}

async function waitForAnnotation(
    predicate: (annotation: AnnotationV2) => boolean,
    description: string
): Promise<AnnotationV2> {
    const startedAt = Date.now();
    const deadline = startedAt + PERSISTENCE_POLL_TIMEOUT_MS;
    let lastObserved = 'the annotation envelope was not readable';
    let lastReadError: string | undefined;

    let remaining = PERSISTENCE_POLL_TIMEOUT_MS;
    do {
        try {
            const annotations = (await readEnvelope()).annotations;
            const found = annotations.find(predicate);
            if (found) {
                return found;
            }
            lastObserved = JSON.stringify({
                count: annotations.length,
                recent: annotations.slice(-20).map((annotation) => ({
                    id: annotation.id,
                    file: annotation.file,
                    startOffset: annotation.startOffset,
                    endOffset: annotation.endOffset,
                    resolved: annotation.resolved === true,
                    severity: annotation.severity,
                })),
            });
            lastReadError = undefined;
        } catch (error) {
            // Persistence may still be atomically replacing the envelope.
            lastReadError = error instanceof Error ? error.message : String(error);
        }

        remaining = deadline - Date.now();
        if (remaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(PERSISTENCE_POLL_INTERVAL_MS, remaining)));
        }
    } while (remaining > 0);

    const readError = lastReadError ? `; last read error: ${lastReadError}` : '';
    assert.fail(
        `timed out after ${Date.now() - startedAt}ms waiting for ${description}; ` +
            `last observed annotations: ${lastObserved}${readError}`
    );
}

async function waitForAnnotationsAbsent(ids: readonly string[]): Promise<void> {
    const deadline = Date.now() + PERSISTENCE_POLL_TIMEOUT_MS;
    let present: string[] = [];
    do {
        try {
            const idSet = new Set(ids);
            present = (await readEnvelope()).annotations
                .filter((annotation) => idSet.has(annotation.id))
                .map((annotation) => annotation.id);
            if (present.length === 0) {
                return;
            }
        } catch {
            // The coordinator may be between atomic replacement steps.
        }
        await new Promise((resolve) => setTimeout(resolve, PERSISTENCE_POLL_INTERVAL_MS));
    } while (Date.now() < deadline);
    assert.fail(`timed out waiting for Lot 12 cleanup; ids still persisted: ${present.join(', ')}`);
}

suite('Lot 12 — manual re-anchor and local diagnostics commands', () => {
    const createdIds: string[] = [];
    let hooks: ExtensionHooks;

    suiteSetup(async function () {
        this.timeout(30_000);
        hooks = (await extension().activate()) as ExtensionHooks;
    });

    teardown(async () => {
        if (createdIds.length > 0) {
            const ids = [...createdIds];
            const store = hooks.getAnnotationStore();
            assert.ok(store, 'active annotation store must remain available during Lot 12 cleanup');
            for (const id of ids) {
                if (store.get(id)) {
                    store.remove(id);
                }
            }
            createdIds.length = 0;
            await hooks.__flushAnnotationPersistenceForTest();
            await waitForAnnotationsAbsent(ids);
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('re-anchor command moves the same id to the current cursor and recaptures the destination range', async function () {
        this.timeout(45_000);
        const sourceUri = await fixture('lot12-reanchor-source.ts', 'a very long annotated source line\nsecond\n');
        const targetUri = await fixture('lot12-reanchor-target.ts', 'zero\ntiny\nafter\n');
        const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
        const targetDocument = await vscode.workspace.openTextDocument(targetUri);
        const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
        sourceEditor.selection = new vscode.Selection(0, 0, 0, 0);
        const annotationId = await addAnnotation(0, 'lot12 manual recovery');
        createdIds.push(annotationId);
        await waitForAnnotation(
            (candidate) => candidate.id === annotationId,
            `initial annotation ${annotationId} to be persisted`
        );

        const editor = await vscode.window.showTextDocument(targetDocument);
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        await vscode.commands.executeCommand('annotations.reanchorToCursor', annotationId);

        const moved = await waitForAnnotation(
            (candidate) => candidate.id === annotationId && candidate.fileUri === targetUri.toString(),
            `annotation ${annotationId} to be re-anchored in ${targetUri.toString()}`
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

    test('bulk command updates multiple annotations in one native command path', async function () {
        this.timeout(45_000);
        const uri = await fixture('lot12-bulk-actions.ts', 'first\nsecond\nthird\n');
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        const firstId = await addAnnotation(0, 'lot12 bulk first');
        createdIds.push(firstId);
        const secondId = await addAnnotation(1, 'lot12 bulk second');
        createdIds.push(secondId);
        await waitForAnnotation(
            (candidate) => candidate.id === firstId,
            `initial annotation ${firstId} to be persisted`
        );
        await waitForAnnotation(
            (candidate) => candidate.id === secondId,
            `initial annotation ${secondId} to be persisted`
        );

        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('annotations.bulkActions'));
        const updated = await vscode.commands.executeCommand<number>('annotations.bulkActions', {
            ids: [firstId, secondId],
            action: 'resolve',
        });
        assert.strictEqual(updated, 2);
        await waitForAnnotation(
            (candidate) => candidate.id === firstId && candidate.resolved === true,
            `annotation ${firstId} to be resolved`
        );
        await waitForAnnotation(
            (candidate) => candidate.id === secondId && candidate.resolved === true,
            `annotation ${secondId} to be resolved`
        );

        await vscode.commands.executeCommand('annotations.bulkActions', {
            ids: [firstId, secondId],
            action: 'severity',
            severity: 'critical',
        });
        await waitForAnnotation(
            (candidate) => candidate.id === firstId && candidate.severity === 'critical',
            `annotation ${firstId} to have critical severity`
        );
        await waitForAnnotation(
            (candidate) => candidate.id === secondId && candidate.severity === 'critical',
            `annotation ${secondId} to have critical severity`
        );
    });

    test('move command preserves identity while re-anchoring across files', async function () {
        this.timeout(45_000);
        const sourceUri = await fixture('lot12-drag-source.ts', 'source zero\nsource move\n');
        const targetUri = await fixture('lot12-drag-target.ts', 'target zero\ntarget one\ntarget destination\n');
        const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
        const targetDocument = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(sourceDocument);
        const movedId = await addAnnotation(1, 'lot12 dragged identity');
        createdIds.push(movedId);
        await vscode.window.showTextDocument(targetDocument);
        const targetId = await addAnnotation(2, 'lot12 drag destination');
        createdIds.push(targetId);
        await waitForAnnotation(
            (candidate) => candidate.id === movedId,
            `initial annotation ${movedId} to be persisted`
        );
        await waitForAnnotation(
            (candidate) => candidate.id === targetId,
            `drop target annotation ${targetId} to be persisted`
        );

        const count = await vscode.commands.executeCommand<number>('annotations.moveByDragAndDrop', {
            ids: [movedId],
            targetAnnotationId: targetId,
        });
        assert.strictEqual(count, 1);
        const persisted = await waitForAnnotation(
            (candidate) => candidate.id === movedId && candidate.fileUri === targetUri.toString(),
            `annotation ${movedId} to move to ${targetUri.toString()}`
        );
        assert.strictEqual(persisted.id, movedId);
        assert.strictEqual(targetDocument.positionAt(persisted.startOffset).line, 2);
    });
});
