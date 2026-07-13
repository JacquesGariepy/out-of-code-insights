// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    AnnotationInlayHintsProvider,
    type AnnotationInlayHintsConfig,
} from '../../providers/AnnotationInlayHintsProvider';
import { AnnotationStore, type AnnotationDraft } from '../../transactional/AnnotationStore';
import { VisibilityFilter, type AnnotationVisibilityConfig } from '../../transactional/VisibilityFilter';

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

function draft(
    uri: vscode.Uri,
    message: string,
    options: { tags?: string[]; severity?: string } = {}
): AnnotationDraft {
    return {
        fileUri: uri.toString(),
        file: path.relative(workspaceRoot(), uri.fsPath).replace(/\\/g, '/'),
        origin: { kind: 'manual' },
        message,
        timestamp: new Date().toISOString(),
        tags: options.tags,
        severity: options.severity,
    };
}

function fullRange(document: vscode.TextDocument): vscode.Range {
    return new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
}

function commandParts(hint: vscode.InlayHint): vscode.InlayHintLabelPart[] {
    assert.ok(Array.isArray(hint.label), 'the hint must expose individually clickable label parts');
    return hint.label as vscode.InlayHintLabelPart[];
}

suite('AnnotationInlayHintsProvider', () => {
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

    test('positions a clickable message and move action at the anchor line end', async () => {
        const document = await fixture('lot17-inlay-position.ts', 'first line\nconst target = true;\nlast line\n');
        const store = new AnnotationStore();
        const visibility = new VisibilityFilter(() => ({
            enableAnnotations: true,
            disabledTags: [],
            currentFilter: 'all',
        }));
        store.markInitialized();
        const annotation = store.add(
            draft(document.uri, 'Review target', { severity: 'warning' }),
            { line: 1 },
            document
        );
        const provider = new AnnotationInlayHintsProvider(store, visibility, () => ({
            enabled: true,
            maxMessageLength: 72,
        }));
        disposables.push(provider, visibility);
        const cancellation = new vscode.CancellationTokenSource();
        disposables.push(cancellation);

        const hints = provider.provideInlayHints(document, fullRange(document), cancellation.token);

        assert.strictEqual(hints.length, 1);
        assert.strictEqual(hints[0].position.line, 1);
        assert.strictEqual(hints[0].position.character, document.lineAt(1).range.end.character);
        assert.strictEqual(hints[0].paddingLeft, true);
        const parts = commandParts(hints[0]);
        const openPart = parts.find((part) => part.command?.command === 'annotations.navigateToPanel');
        const movePart = parts.find((part) => part.command?.command === 'annotations.pickUpForMove');
        assert.ok(openPart, 'the annotation message must open the panel');
        assert.deepStrictEqual(openPart.command?.arguments, [annotation.id]);
        assert.ok(openPart.value.includes('Review target'));
        assert.ok(movePart, 'the hint must expose a native move command');
        assert.deepStrictEqual(movePart.command?.arguments, [{ ids: [annotation.id] }]);
    });

    test('groups visible annotations on one line and moves the group together', async () => {
        const document = await fixture('lot17-inlay-group.ts', 'alpha\nbeta\ngamma\n');
        const store = new AnnotationStore();
        const visibility = new VisibilityFilter(() => ({
            enableAnnotations: true,
            disabledTags: ['hidden'],
            currentFilter: 'all',
        }));
        store.markInitialized();
        const first = store.add(draft(document.uri, 'First review', { severity: 'error' }), { line: 1 }, document);
        const second = store.add(draft(document.uri, 'Second review'), { line: 1 }, document);
        store.add(draft(document.uri, 'Hidden review', { tags: ['hidden'] }), { line: 2 }, document);
        const provider = new AnnotationInlayHintsProvider(store, visibility, () => ({
            enabled: true,
            maxMessageLength: 72,
        }));
        disposables.push(provider, visibility);
        const cancellation = new vscode.CancellationTokenSource();
        disposables.push(cancellation);

        const hints = provider.provideInlayHints(document, fullRange(document), cancellation.token);

        assert.strictEqual(hints.length, 1, 'the hidden annotation must not create a second hint');
        const parts = commandParts(hints[0]);
        const openParts = parts.filter((part) => part.command?.command === 'annotations.navigateToPanel');
        assert.strictEqual(openParts.length, 2, 'each grouped annotation remains independently clickable');
        const expectedIds = [first.id, second.id].sort((left, right) => left.localeCompare(right));
        assert.deepStrictEqual(
            openParts.map((part) => part.command?.arguments?.[0]),
            expectedIds
        );
        const movePart = parts.find((part) => part.command?.command === 'annotations.pickUpForMove');
        assert.deepStrictEqual(movePart?.command?.arguments, [{ ids: expectedIds }]);
    });

    test('honours provider configuration, visibility filtering, and requested range', async () => {
        const document = await fixture('lot17-inlay-config.ts', 'info line\nerror line\n');
        const store = new AnnotationStore();
        let visibilityConfig: AnnotationVisibilityConfig = {
            enableAnnotations: true,
            disabledTags: [],
            currentFilter: 'severity:error',
        };
        const visibility = new VisibilityFilter(() => visibilityConfig);
        let inlayConfig: AnnotationInlayHintsConfig = { enabled: false, maxMessageLength: 30 };
        store.markInitialized();
        store.add(draft(document.uri, 'Informational annotation', { severity: 'info' }), { line: 0 }, document);
        const error = store.add(
            draft(document.uri, 'Error annotation with a deliberately long summary', { severity: 'error' }),
            { line: 1 },
            document
        );
        const provider = new AnnotationInlayHintsProvider(store, visibility, () => inlayConfig);
        disposables.push(provider, visibility);
        const cancellation = new vscode.CancellationTokenSource();
        disposables.push(cancellation);

        assert.deepStrictEqual(provider.provideInlayHints(document, fullRange(document), cancellation.token), []);

        inlayConfig = { ...inlayConfig, enabled: true };
        const hints = provider.provideInlayHints(document, fullRange(document), cancellation.token);
        assert.strictEqual(hints.length, 1, 'the severity filter should retain only the error annotation');
        assert.strictEqual(hints[0].position.line, 1);
        const openPart = commandParts(hints[0]).find((part) => part.command?.command === 'annotations.navigateToPanel');
        assert.deepStrictEqual(openPart?.command?.arguments, [error.id]);
        assert.ok(
            openPart && openPart.value.length < error.message.length + 15,
            'the configured summary must truncate'
        );

        const firstLineOnly = new vscode.Range(new vscode.Position(0, 0), document.lineAt(0).range.end);
        assert.deepStrictEqual(provider.provideInlayHints(document, firstLineOnly, cancellation.token), []);

        visibilityConfig = { ...visibilityConfig, enableAnnotations: false };
        assert.deepStrictEqual(provider.provideInlayHints(document, fullRange(document), cancellation.token), []);
    });
});
