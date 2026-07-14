/**
 * Lot 8 — typing near an annotated line must not detach the annotation.
 *
 * Repro from a user screen recording: annotation on a markdown heading
 * (`## Context`); pressing Space and/or Enter at the end of the line makes
 * the gutter/highlight/inline decorations disappear while the CodeLens
 * ("Manage 1 annotation") stays — i.e. the v2 store still holds the
 * annotation but the legacy render pipeline can no longer resolve it.
 *
 * The decoration-visibility predicate replicated here is the fast path of
 * `AnnotationManager.computeResolvedAnchor`: the persisted `lineHash` must
 * equal `hashLine(document line at positionAt(startOffset))`. When that
 * predicate fails the annotation is rendered as orphaned (no decoration).
 *
 * Edits are driven through the real `type` command (not WorkspaceEdit) so
 * VS Code's own editing pipeline — auto-whitespace trim included — emits the
 * exact contentChange shapes the user produces from the keyboard.
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
    startOffset: number;
    endOffset: number;
    state?: string;
    lineHash?: string;
    message: string;
}

function readPersistedAnnotations(fileUri: string): PersistedV2Annotation[] {
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
        return parsed.annotations.filter((a) => a.fileUri === fileUri);
    } catch {
        return [];
    }
}

async function closeAllEditors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
        /* best-effort cleanup */
    } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = original;
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
    '- A cloud API.\n' +
    '- A JSON file stored inside the workspace folder.\n';

const CONTEXT_LINE = 7; // 0-based line of '## Context'

interface ResolvedView {
    count: number;
    state: string;
    line: number;
    hashMatchesLineAtOffset: boolean;
}

/** Decoration-visibility predicate derived from the persisted envelope. */
function resolveView(document: vscode.TextDocument, fileUri: string): ResolvedView {
    const anns = readPersistedAnnotations(fileUri);
    if (anns.length !== 1) {
        return { count: anns.length, state: 'n/a', line: -1, hashMatchesLineAtOffset: false };
    }
    const a = anns[0];
    let line = -1;
    if (a.startOffset >= 0 && a.startOffset <= document.getText().length) {
        line = document.positionAt(a.startOffset).line;
    }
    const hashMatches = line >= 0 && line < document.lineCount && a.lineHash === hashLine(document.lineAt(line).text);
    return { count: 1, state: a.state ?? 'active', line, hashMatchesLineAtOffset: hashMatches };
}

/**
 * Wait for the debounced, atomic persistence pipeline instead of assuming a
 * fixed disk latency. The persistence layer deliberately validates and syncs
 * every replacement; antivirus or a busy Windows filesystem can therefore
 * make a correct write take longer than the historical 600 ms sleep.
 */
async function waitForResolvedView(
    document: vscode.TextDocument,
    fileUri: string,
    predicate: (view: ResolvedView) => boolean,
    timeoutMs = 10000
): Promise<ResolvedView> {
    const deadline = Date.now() + timeoutMs;
    let view = resolveView(document, fileUri);
    while (!predicate(view) && Date.now() < deadline) {
        await delay(100);
        view = resolveView(document, fileUri);
    }
    return view;
}

async function typeText(text: string): Promise<void> {
    await vscode.commands.executeCommand('type', { text });
}

suite('Lot 8 — typing Space/Enter at the end of an annotated line keeps the annotation attached', () => {
    let uri: vscode.Uri;
    let document: vscode.TextDocument;
    let editor: vscode.TextEditor;

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
        await closeAllEditors();

        uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot8-typing.md'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(MD_FIXTURE, 'utf8'));
        document = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(document);
        await delay(300);

        await vscode.commands.executeCommand('annotations.add', {
            line: CONTEXT_LINE,
            message: 'lot8-context',
        });
        await delay(600);

        const before = resolveView(document, uri.toString());
        assert.strictEqual(before.count, 1, 'setup: expected exactly 1 persisted annotation');
        assert.strictEqual(before.line, CONTEXT_LINE, 'setup: annotation anchored on ## Context');
        assert.strictEqual(before.hashMatchesLineAtOffset, true, 'setup: lineHash matches the anchored line');
    });

    teardown(async () => {
        await closeAllEditors();
    });

    async function placeCursorAtEol(line: number): Promise<void> {
        const eol = document.lineAt(line).text.length;
        editor.selection = new vscode.Selection(line, eol, line, eol);
        await delay(50);
    }

    test('Space typed at end of the annotated line — annotation stays attached', async function () {
        this.timeout(30000);
        await placeCursorAtEol(CONTEXT_LINE);
        await typeText(' ');
        await delay(600);

        const after = resolveView(document, uri.toString());
        assert.strictEqual(after.count, 1, 'exactly one annotation must survive');
        assert.strictEqual(after.state, 'active', 'annotation must stay active (not suspended/disposed)');
        assert.strictEqual(after.line, CONTEXT_LINE, 'annotation must stay on the ## Context line');
        assert.strictEqual(
            after.hashMatchesLineAtOffset,
            true,
            'lineHash must still match the anchored line (decoration-visibility predicate)'
        );
    });

    test('Enter pressed at end of the annotated line — annotation stays attached', async function () {
        this.timeout(30000);
        await placeCursorAtEol(CONTEXT_LINE);
        await typeText('\n');
        await delay(600);

        const after = resolveView(document, uri.toString());
        assert.strictEqual(after.count, 1, 'exactly one annotation must survive');
        assert.strictEqual(after.state, 'active', 'annotation must stay active');
        assert.strictEqual(after.line, CONTEXT_LINE, 'annotation must stay on the ## Context line');
        assert.strictEqual(after.hashMatchesLineAtOffset, true, 'lineHash must still match the anchored line');
    });

    test('Space then Enter (auto-whitespace trim path) — annotation stays attached', async function () {
        this.timeout(30000);
        await placeCursorAtEol(CONTEXT_LINE);
        await typeText(' ');
        await delay(200);
        await typeText('\n');
        await delay(800);

        const after = resolveView(document, uri.toString());
        assert.strictEqual(after.count, 1, 'exactly one annotation must survive');
        assert.strictEqual(after.state, 'active', 'annotation must stay active');
        assert.strictEqual(after.line, CONTEXT_LINE, 'annotation must stay on the ## Context line');
        assert.strictEqual(after.hashMatchesLineAtOffset, true, 'lineHash must still match the anchored line');
    });

    test('Backspace on the last char of the annotated line, then retype — annotation stays attached', async function () {
        this.timeout(30000);
        // Video repro: '## Context' → backspace → '## Contex' → retype 't'.
        await placeCursorAtEol(CONTEXT_LINE);
        await vscode.commands.executeCommand('deleteLeft');

        const afterDelete = await waitForResolvedView(
            document,
            uri.toString(),
            (view) =>
                view.count === 1 &&
                view.state === 'active' &&
                view.line === CONTEXT_LINE &&
                view.hashMatchesLineAtOffset
        );
        assert.strictEqual(afterDelete.count, 1, 'annotation must survive the in-line deletion');
        assert.strictEqual(afterDelete.state, 'active', 'annotation must stay active after deleting a char');
        assert.strictEqual(afterDelete.line, CONTEXT_LINE, 'annotation must stay on the edited line');
        assert.strictEqual(
            afterDelete.hashMatchesLineAtOffset,
            true,
            'lineHash must be refreshed to "## Contex" so the decoration stays visible'
        );

        await typeText('t');

        const afterRetype = await waitForResolvedView(
            document,
            uri.toString(),
            (view) =>
                view.count === 1 &&
                view.state === 'active' &&
                view.line === CONTEXT_LINE &&
                view.hashMatchesLineAtOffset
        );
        assert.strictEqual(afterRetype.count, 1);
        assert.strictEqual(afterRetype.state, 'active');
        assert.strictEqual(afterRetype.line, CONTEXT_LINE);
        assert.strictEqual(afterRetype.hashMatchesLineAtOffset, true, 'lineHash must track the restored text');
    });

    test('Space typed in the middle of the annotated line — annotation stays attached with refreshed hash', async function () {
        this.timeout(30000);
        // Cursor between '##' and ' Context' tail: inside the annotated range (Cas C).
        editor.selection = new vscode.Selection(CONTEXT_LINE, 4, CONTEXT_LINE, 4);
        await delay(50);
        await typeText(' ');

        const after = await waitForResolvedView(
            document,
            uri.toString(),
            (view) =>
                view.count === 1 &&
                view.state === 'active' &&
                view.line === CONTEXT_LINE &&
                view.hashMatchesLineAtOffset
        );
        assert.strictEqual(after.count, 1, 'exactly one annotation must survive');
        assert.strictEqual(after.state, 'active', 'annotation must stay active');
        assert.strictEqual(after.line, CONTEXT_LINE, 'annotation must stay on the ## Context line');
        assert.strictEqual(
            after.hashMatchesLineAtOffset,
            true,
            'lineHash must be refreshed to the edited line content'
        );
    });
});
