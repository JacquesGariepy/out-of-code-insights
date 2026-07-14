/**
 * Lot 1 + Lot 2 EDH integration tests for AnnotationStore.
 *
 * LOT 1 (canonical names — Lot 2 alignment complete):
 *   §7.1 — Insertion BEFORE the annotated line: the annotation follows.
 *   §7.2 — Insertion ON the annotated line: the annotation stays on the line.
 *   wiring — onDidChangeTextDocument delivery into applyDocumentChange.
 *   JSON v2 — serialize / deserialize round-trip.
 *
 * LOT 2 (failing-test-first; mirrorUndo / mirrorRedo / Cas D / transactional
 * are deferred to Lots 4 and 6 in worker-1's roadmap):
 *   §7.7 — Undo after paste removes the pasted annotation; original survives.
 *   §7.8 — Redo after undo of paste restores the pasted annotation with the
 *          same id.
 *   §7.9 — Cut+paste cycle followed by undo rolls back to the initial state
 *          (same id). Skipped at runtime if Cas D OR mirrorUndo is not yet
 *          implemented (probed via NotImplementedError).
 *   transactional batch — beginTransaction/commit of N adds undone as a unit,
 *          redo restores all N (also failing-first until Lot 6).
 *
 * CANONICAL NAMES (aligned per worker-1's spec doc + Lot 2 brief):
 *   addAnnotation       → add(draft, opts, document)
 *   handleDocumentChange→ applyDocumentChange(event)
 *   serializeV2         → serialize()
 *   fromV2              → deserialize(payload)  (instance method)
 *   list                → getAll()
 *   TransactionalAnnotation → AnnotationV2
 *
 * The Lot 1 reconciliation bridges in AnnotationStore.ts are NOT exercised by
 * this file anymore -- worker-1 can drop them in Lot 2 without breaking tests.
 *
 * The store is NOT yet wired from extension.ts; tests instantiate a standalone
 * store and subscribe its handler manually. Lot 5 will perform the wiring.
 *
 * Run via: `npm test`. Placed under src/test/suite/ (NOT src/test/integration/)
 * because the latter is consumed by `npm run test:unit` which runs in plain
 * Node and crashes on `import * as vscode`.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore, NotImplementedError, type AnnotationDraft } from '../../transactional/AnnotationStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspaceRoot(): string {
    const ws = vscode.workspace.workspaceFolders;
    assert.ok(ws && ws.length > 0, 'a workspace folder must be open during tests');
    return ws[0].uri.fsPath;
}

async function ensureFixture(relPathArg: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), relPathArg));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
}

async function closeAllEditors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply an edit and wait for the matching VS Code document event. `applyEdit`
 * normally resolves after delivery, but asserting the event explicitly keeps
 * store integration tests independent from scheduler speed and removes fixed
 * sleeps that become unreliable when the full Extension Host suite is busy.
 */
async function applyEditAndWaitForDocumentEvent(
    uri: vscode.Uri,
    edit: vscode.WorkspaceEdit
): Promise<vscode.TextDocumentChangeEvent> {
    let subscription: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const observed = new Promise<vscode.TextDocumentChangeEvent>((resolve, reject) => {
        subscription = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.uri.toString() !== uri.toString() || event.contentChanges.length === 0) {
                return;
            }
            resolve(event);
        });
        timer = setTimeout(() => reject(new Error(`Timed out waiting for document change: ${uri.toString()}`)), 5000);
    });

    try {
        const [, event] = await Promise.all([
            vscode.workspace.applyEdit(edit).then((applied) => {
                assert.strictEqual(applied, true, `workspace edit must apply to ${uri.toString()}`);
            }),
            observed,
        ]);
        return event;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
        subscription?.dispose();
    }
}

/**
 * Route a workbench-level Undo/Redo command to the document exercised by the
 * test. Other integration suites can briefly move focus to a quick pick,
 * notification, tree, or temporary editor; `undo`/`redo` otherwise operate on
 * whichever workbench control still owns focus and emit no document event.
 */
async function executeFocusedEditorCommand(command: 'undo' | 'redo', document: vscode.TextDocument): Promise<void> {
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await delay(50);
    assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        document.uri.toString(),
        `${command}: the fixture editor must be active before dispatch`
    );
    await vscode.commands.executeCommand(command);
}

function relPath(uri: vscode.Uri): string {
    return path.relative(workspaceRoot(), uri.fsPath).replace(/\\/g, '/');
}

/**
 * Subscribe `store.applyDocumentChange` to vscode.workspace.onDidChangeTextDocument.
 * Mirrors the wiring planned for extension.ts in a later lot.
 *
 * Throws inside the listener (e.g. NotImplementedError on Cas D) propagate up
 * to VS Code's event dispatcher and are NOT visible to the test body. Tests
 * that depend on deferred features should probe with `probeNotImplemented`
 * BEFORE attaching the listener so they can `this.skip()` cleanly.
 */
function subscribeStore(store: AnnotationStore): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument((event) => {
        store.applyDocumentChange(event);
    });
}

function makeDraft(
    uri: vscode.Uri,
    message: string,
    originKind: 'manual' | 'paste' | 'restore' = 'manual'
): AnnotationDraft {
    return {
        fileUri: uri.toString(),
        file: relPath(uri),
        origin: { kind: originKind },
        message,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Run `probe` and report whether it throws NotImplementedError. Used by tests
 * whose subject depends on a feature deferred to a future lot, so they can
 * skip cleanly instead of failing with a confusing assertion error.
 */
function isNotImplemented(probe: () => void): boolean {
    try {
        probe();
        return false;
    } catch (err) {
        return err instanceof NotImplementedError;
    }
}

// ---------------------------------------------------------------------------
// Suite — Lot 1 (canonical names)
// ---------------------------------------------------------------------------

suite('AnnotationStore (Lot 1) — EDH integration: §7.1, §7.2, wiring, JSON v2', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            const sub = subscriptions.pop();
            sub?.dispose();
        }
        await closeAllEditors();
    });

    test('§7.1 — insertion BEFORE the annotated line shifts startOffset and the annotation follows the moved line', async function () {
        this.timeout(15000);

        const original =
            'line0\n' + 'line1\n' + 'line2\n' + 'line3\n' + 'line4\n' + 'targetLine\n' + 'line6\n' + 'line7\n';
        const uri = await ensureFixture('lot1-7-1-insertion-before.ts', original);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        const targetLineNumber = 5;
        const lineStartOffset = document.offsetAt(new vscode.Position(targetLineNumber, 0));
        const lineEndOffset = document.offsetAt(
            new vscode.Position(targetLineNumber, document.lineAt(targetLineNumber).text.length)
        );

        const annotation = store.add(makeDraft(uri, 'test-7.1'), { line: targetLineNumber }, document);
        assert.strictEqual(annotation.startOffset, lineStartOffset);
        assert.strictEqual(annotation.endOffset, lineEndOffset);
        assert.strictEqual(
            document.positionAt(annotation.startOffset).line,
            targetLineNumber,
            'pre-edit: annotation startOffset maps back to line 5'
        );

        const insertedText = 'INSERTED_A\nINSERTED_B\nINSERTED_C\n';
        const insertedDelta = insertedText.length;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), insertedText);
        const ok = await vscode.workspace.applyEdit(edit);
        assert.strictEqual(ok, true, 'WorkspaceEdit must apply');

        await delay(500);

        const updated = store.get(annotation.id);
        if (!updated) {
            assert.fail(
                '§7.1: annotation must remain in the store after insertion before it -- it was deleted instead of shifted'
            );
            return;
        }
        assert.strictEqual(
            updated.startOffset,
            lineStartOffset + insertedDelta,
            `§7.1: startOffset must shift by ${insertedDelta} (got ${updated.startOffset})`
        );
        assert.strictEqual(
            updated.endOffset,
            lineEndOffset + insertedDelta,
            `§7.1: endOffset must shift by ${insertedDelta} (got ${updated.endOffset})`
        );
        const newLine = document.positionAt(updated.startOffset).line;
        assert.strictEqual(
            newLine,
            targetLineNumber + 3,
            `§7.1: annotation must now resolve to line ${targetLineNumber + 3} (got ${newLine})`
        );
    });

    test('§7.2 — insertion ON the annotated line keeps the annotation on the same line and shifts both offsets', async function () {
        this.timeout(15000);

        const original = 'pre\n' + '    const TARGET = 1;\n' + 'post\n';
        const uri = await ensureFixture('lot1-7-2-insertion-on-line.ts', original);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        // Anchor "const TARGET = 1;" — line 1, columns 4..end. startOffset is
        // strictly inside the line so the column-0 insertion is unambiguously
        // BEFORE the annotation.
        const targetLine = 1;
        const targetCol = 4;
        const initialStart = document.offsetAt(new vscode.Position(targetLine, targetCol));
        const lineLen = document.lineAt(targetLine).text.length;
        const initialEnd = document.offsetAt(new vscode.Position(targetLine, lineLen));
        const initialLength = initialEnd - initialStart;

        const annotation = store.add(
            makeDraft(uri, 'test-7.2'),
            { offset: initialStart, length: initialLength },
            document
        );
        assert.strictEqual(annotation.startOffset, initialStart);
        assert.strictEqual(annotation.endOffset, initialEnd);

        const insertedText = '// ';
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(targetLine, 0), insertedText);
        const ok = await vscode.workspace.applyEdit(edit);
        assert.strictEqual(ok, true);

        await delay(500);

        const updated = store.get(annotation.id);
        if (!updated) {
            assert.fail(
                '§7.2: annotation must NOT be removed when its line is edited -- it was deleted instead of shifted'
            );
            return;
        }
        assert.strictEqual(
            updated.startOffset,
            initialStart + insertedText.length,
            `§7.2: startOffset must shift by ${insertedText.length} (got ${updated.startOffset})`
        );
        assert.strictEqual(
            updated.endOffset,
            initialEnd + insertedText.length,
            `§7.2: endOffset must shift by ${insertedText.length} (got ${updated.endOffset})`
        );
        const lineNow = document.positionAt(updated.startOffset).line;
        assert.strictEqual(lineNow, targetLine, `§7.2: annotation must remain on line ${targetLine} (got ${lineNow})`);
    });

    test('AnnotationStore subscribed to onDidChangeTextDocument receives events end-to-end (wiring)', async function () {
        this.timeout(15000);

        const original = 'A\nB\nC\nD\nE\n';
        const uri = await ensureFixture('lot1-wiring-handler.ts', original);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(100);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        const initialStart = document.offsetAt(new vscode.Position(2, 0));
        const annotation = store.add(makeDraft(uri, 'test-wiring'), { offset: initialStart, length: 1 }, document);
        const initialEnd = annotation.endOffset;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), 'X\n');
        const ok = await vscode.workspace.applyEdit(edit);
        assert.strictEqual(ok, true);

        await delay(500);

        const updated = store.get(annotation.id);
        if (!updated) {
            assert.fail('wiring: annotation must persist after the listener fires');
            return;
        }
        assert.strictEqual(
            updated.startOffset,
            initialStart + 2,
            'wiring: store updated startOffset proves it received and processed the change event'
        );
        assert.strictEqual(updated.endOffset, initialEnd + 2, 'wiring: endOffset shifted by the same delta');
    });

    test('JSON v2 — serialize / deserialize round-trip preserves annotations', async function () {
        this.timeout(10000);

        const fixture = 'first line\nsecond line longer\nthird\n';
        const uri = await ensureFixture('lot1-roundtrip-fixture.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await delay(100);

        const store = new AnnotationStore();
        const a1 = store.add(makeDraft(uri, 'first'), { line: 0 }, document);
        const a2 = store.add(makeDraft(uri, 'second'), { line: 1 }, document);

        const exported = store.serialize();
        assert.strictEqual(exported.schemaVersion, 2, 'envelope must declare schemaVersion 2');
        assert.strictEqual(exported.annotations.length, 2);

        const json = JSON.stringify(exported);
        const parsed = JSON.parse(json) as typeof exported;
        assert.strictEqual(parsed.schemaVersion, 2);
        assert.strictEqual(parsed.annotations.length, 2);

        const restored = new AnnotationStore();
        restored.deserialize(parsed);
        assert.strictEqual(restored.getAll().length, 2);

        const r1 = restored.get(a1.id);
        const r2 = restored.get(a2.id);
        if (!r1 || !r2) {
            assert.fail('JSON v2: both annotations must round-trip into the restored store');
            return;
        }
        assert.strictEqual(r1.startOffset, a1.startOffset);
        assert.strictEqual(r1.endOffset, a1.endOffset);
        assert.strictEqual(r1.message, a1.message);
        assert.strictEqual(r1.file, a1.file);
        assert.strictEqual(r1.fileUri, a1.fileUri);

        assert.strictEqual(r2.startOffset, a2.startOffset);
        assert.strictEqual(r2.endOffset, a2.endOffset);
        assert.strictEqual(r2.message, a2.message);
    });
});

// ---------------------------------------------------------------------------
// Suite — Lot 2 (failing-first; deferred to Lot 4 + Lot 6)
// ---------------------------------------------------------------------------

suite('AnnotationStore (Lot 2) — undo/redo mirroring §7.7, §7.8, §7.9 + transactional', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            const sub = subscriptions.pop();
            sub?.dispose();
        }
        await closeAllEditors();
    });

    test('§7.7 — undo after paste removes the pasted annotation; the original survives', async function () {
        this.timeout(20000);

        // Skip cleanly until mirrorUndo (Lot 6) is implemented. Without it the
        // listener cannot remove pastedId on Undo, so the assertion would fail
        // with a misleading message.
        const probe = new AnnotationStore();
        if (
            isNotImplemented(() =>
                probe.mirrorUndo(0, vscode.Uri.file(path.join(workspaceRoot(), 'probe.ts')).toString())
            )
        ) {
            this.skip();
            return;
        }

        const fixture = Array.from({ length: 17 }, (_, i) => `line${i}`).join('\n') + '\n';
        const uri = await ensureFixture('lot2-7-7-undo-paste.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        const original = store.add(makeDraft(uri, 'original'), { line: 5 }, document);

        // Real paste at line 10. Use vscode.workspace.applyEdit so the listener
        // fires through the same path the user would hit.
        const pasteText = 'pastedContent\n';
        const pasteEdit = new vscode.WorkspaceEdit();
        pasteEdit.insert(uri, new vscode.Position(10, 0), pasteText);
        const pasteOk = await vscode.workspace.applyEdit(pasteEdit);
        assert.strictEqual(pasteOk, true, 'paste edit must apply');
        await delay(300);

        const pasted = store.add(makeDraft(uri, 'pasted-copy', 'paste'), { line: 10 }, document);

        assert.strictEqual(store.getAll().length, 2, 'precondition §7.7: 2 annotations after manual paste creation');

        await executeFocusedEditorCommand('undo', document);
        await delay(800);

        assert.strictEqual(
            store.getAll().length,
            1,
            '§7.7: only the original annotation must remain after undo of the paste'
        );
        assert.ok(store.get(original.id), `§7.7: original annotation (id=${original.id}) must survive the undo`);
        assert.strictEqual(
            store.get(pasted.id),
            undefined,
            `§7.7: pasted annotation (id=${pasted.id}) must be removed by mirrorUndo`
        );
    });

    test('§7.8 — redo after undo of paste restores the pasted annotation with the same id', async function () {
        this.timeout(20000);

        const probe = new AnnotationStore();
        if (
            isNotImplemented(() =>
                probe.mirrorUndo(0, vscode.Uri.file(path.join(workspaceRoot(), 'probe.ts')).toString())
            ) ||
            isNotImplemented(() =>
                probe.mirrorRedo(0, vscode.Uri.file(path.join(workspaceRoot(), 'probe.ts')).toString())
            )
        ) {
            this.skip();
            return;
        }

        const fixture = Array.from({ length: 17 }, (_, i) => `line${i}`).join('\n') + '\n';
        const uri = await ensureFixture('lot2-7-8-redo-paste.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        store.add(makeDraft(uri, 'original'), { line: 5 }, document);

        const pasteText = 'pastedContent\n';
        const pasteEdit = new vscode.WorkspaceEdit();
        pasteEdit.insert(uri, new vscode.Position(10, 0), pasteText);
        await vscode.workspace.applyEdit(pasteEdit);
        await delay(300);

        const pastedBefore = store.add(makeDraft(uri, 'pasted-copy', 'paste'), { line: 10 }, document);
        const pastedId = pastedBefore.id;
        const pastedStartBefore = pastedBefore.startOffset;
        const pastedEndBefore = pastedBefore.endOffset;

        await executeFocusedEditorCommand('undo', document);
        await delay(800);
        assert.strictEqual(store.getAll().length, 1, 'precondition §7.8: undo removed pasted');

        await executeFocusedEditorCommand('redo', document);
        await delay(800);

        assert.strictEqual(
            store.getAll().length,
            2,
            '§7.8: redo must restore the pasted annotation, total count back to 2'
        );
        const restored = store.get(pastedId);
        if (!restored) {
            assert.fail(`§7.8: redo must restore the pasted annotation with the SAME id (${pastedId}), got undefined`);
            return;
        }
        assert.strictEqual(
            restored.startOffset,
            pastedStartBefore,
            '§7.8: restored startOffset must match pre-undo value'
        );
        assert.strictEqual(restored.endOffset, pastedEndBefore, '§7.8: restored endOffset must match pre-undo value');
    });

    test('§7.9 — undo of cut+paste rolls back the annotation to its initial offset (same id)', async function () {
        this.timeout(20000);

        // Cut+paste exercises Cas D (overlap on the cut, suspend → resume) AND
        // mirrorUndo. Skip if EITHER is deferred so the test cannot run yet.
        const probe = new AnnotationStore();
        const probeUri = vscode.Uri.file(path.join(workspaceRoot(), 'probe-7-9.ts')).toString();
        if (isNotImplemented(() => probe.mirrorUndo(0, probeUri))) {
            this.skip();
            return;
        }
        // Cas D throw is internal to applyDocumentChange; we cannot probe it
        // synchronously with a synthetic event here without depending on
        // private invariants. Use suspend() as a proxy probe -- it shares the
        // Lot 4 deferral sentinel.
        if (isNotImplemented(() => probe.suspend('probe-id', 'probe-hash'))) {
            this.skip();
            return;
        }

        const fixture = Array.from({ length: 17 }, (_, i) => `line${i}`).join('\n') + '\n';
        const uri = await ensureFixture('lot2-7-9-undo-cut-paste.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        const annotation = store.add(makeDraft(uri, 'survivor'), { line: 5 }, document);
        const idBefore = annotation.id;
        const startOffsetBefore = annotation.startOffset;
        const endOffsetBefore = annotation.endOffset;

        // Cut line 5: remove [lineStart(5), lineStart(6)) — this overlaps the
        // annotation (Cas D → suspend).
        const cutEdit = new vscode.WorkspaceEdit();
        cutEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)));
        await vscode.workspace.applyEdit(cutEdit);
        await delay(300);

        // Paste at line 10: re-insert "line5\n" — Lot 4 must re-attach the
        // suspended annotation with the SAME id at the new offset.
        const pasteEdit = new vscode.WorkspaceEdit();
        pasteEdit.insert(uri, new vscode.Position(10, 0), 'line5\n');
        await vscode.workspace.applyEdit(pasteEdit);
        await delay(300);

        // Undo, undo: reverse paste, then reverse cut. After the second undo
        // the document is back to its initial state and the annotation must
        // sit at its original offsets with its original id.
        await executeFocusedEditorCommand('undo', document);
        await delay(500);
        await executeFocusedEditorCommand('undo', document);
        await delay(500);

        const restored = store.get(idBefore);
        if (!restored) {
            assert.fail(
                `§7.9: annotation (id=${idBefore}) must be restored to its initial state after undo of cut+paste`
            );
            return;
        }
        assert.strictEqual(restored.startOffset, startOffsetBefore, '§7.9: startOffset must match the pre-cut value');
        assert.strictEqual(restored.endOffset, endOffsetBefore, '§7.9: endOffset must match the pre-cut value');
    });

    test('Transactional batch — undo/redo on a single beginTransaction/commit unit moves all annotations together', async function () {
        this.timeout(20000);

        const probe = new AnnotationStore();
        if (isNotImplemented(() => probe.beginTransaction())) {
            this.skip();
            return;
        }

        const fixture = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
        const uri = await ensureFixture('lot2-tx-batch.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        store.beginTransaction();
        const a1 = store.add(makeDraft(uri, 'a1'), { line: 0 }, document);
        const a2 = store.add(makeDraft(uri, 'a2'), { line: 3 }, document);
        const a3 = store.add(makeDraft(uri, 'a3'), { line: 6 }, document);
        store.commit();

        assert.strictEqual(store.getAll().length, 3, 'precondition: batch committed 3 annotations');

        // Use the canonical mirrorUndo/mirrorRedo entry points. The brief
        // notes that EDH command-driven undo can be flaky and recommends
        // direct calls when only the store logic is under test.
        store.mirrorUndo(document.version, uri.toString());

        assert.strictEqual(
            store.getAll().length,
            0,
            'transactional: a single mirrorUndo must remove all 3 batch-added annotations at once'
        );

        store.mirrorRedo(document.version, uri.toString());

        assert.strictEqual(
            store.getAll().length,
            3,
            'transactional: a single mirrorRedo must restore all 3 annotations'
        );
        assert.ok(store.get(a1.id), 'a1 restored with same id');
        assert.ok(store.get(a2.id), 'a2 restored with same id');
        assert.ok(store.get(a3.id), 'a3 restored with same id');
    });
});

// ---------------------------------------------------------------------------
// Suite — Lot 4 (failing-first): Cas D, suspended buffer, paste detection
//
// Coverage: §7.4, §7.5, §7.6, §7.10, §7.12, §7.13.
//
// Each test probes `store.suspend(...)` for NotImplementedError. While Lot 4
// is in flight all tests skip cleanly. After worker-1 lands Cas D + suspended
// buffer + auto-paste detection inside applyDocumentChange, these tests turn
// red until the implementation matches the spec, then green.
//
// Skip-probe is checked BEFORE the listener is subscribed: a Cas D throw
// inside `applyDocumentChange` is otherwise swallowed by VS Code's event
// dispatcher and would surface as a confused assertion failure rather than
// a clear "feature deferred" signal.
// ---------------------------------------------------------------------------

suite(
    'AnnotationStore (Lot 4) — Cas D, suspended buffer, paste detection: §7.4, §7.5, §7.6, §7.10, §7.12, §7.13',
    () => {
        const subscriptions: vscode.Disposable[] = [];

        teardown(async () => {
            while (subscriptions.length > 0) {
                const sub = subscriptions.pop();
                sub?.dispose();
            }
            await closeAllEditors();
        });

        function lot4Deferred(): boolean {
            const probe = new AnnotationStore();
            return isNotImplemented(() => probe.suspend('probe-id', 'probe-hash'));
        }

        test('§7.4 — cut without paste: annotation is suspended, no longer in getAll(), state=suspended', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture =
                'preserve_a\n' +
                'preserve_b\n' +
                'preserve_c\n' +
                'preserve_d\n' +
                'preserve_e\n' +
                'TARGET_LINE_FOR_CUT\n' +
                'preserve_g\n';
            const uri = await ensureFixture('lot4-7-4-cut-no-paste.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            await delay(150);

            const store = new AnnotationStore();
            subscriptions.push(subscribeStore(store));

            const annotation = store.add(makeDraft(uri, 'survivor'), { line: 5 }, document);
            const id = annotation.id;

            // Cut the entire line 5 (range [Position(5,0), Position(6,0))).
            // This range strictly overlaps the annotation's [startOffset, endOffset]
            // (the annotation excludes the trailing \n) -- triggers Cas D.
            const cutEdit = new vscode.WorkspaceEdit();
            cutEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)));
            const ok = await vscode.workspace.applyEdit(cutEdit);
            assert.strictEqual(ok, true);
            await delay(500);

            assert.strictEqual(store.getAll().length, 0, '§7.4: getAll() must list 0 actives after the cut');

            const fetched = store.get(id);
            if (!fetched) {
                assert.fail(
                    `§7.4: store.get(${id}) must still return the annotation in suspended state, not undefined`
                );
                return;
            }
            assert.strictEqual(
                fetched.state,
                'suspended',
                `§7.4: annotation state must be 'suspended' after Cas D cut (got '${fetched.state}')`
            );
        });

        test('§7.4 (TTL) — suspended annotation expires to disposed after suspendTtlMs and a follow-up event', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture = 'a\nb\nc\nd\ne\nTTL_TARGET\nf\n';
            const uri = await ensureFixture('lot4-7-4-ttl-expiry.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);

            const store = new AnnotationStore({ suspendTtlMs: 60_000 });
            subscriptions.push(subscribeStore(store));

            const annotation = store.add(makeDraft(uri, 'ttl-victim'), { line: 5 }, document);

            // Cut the line.
            const cutEdit = new vscode.WorkspaceEdit();
            cutEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)));
            await applyEditAndWaitForDocumentEvent(uri, cutEdit);

            assert.strictEqual(
                store.get(annotation.id)?.state,
                'suspended',
                'precondition: cut enters suspended state'
            );

            // Shorten the live TTL only after observing suspension, then move
            // beyond that precise transition. This tests expiry without a
            // scheduler-sensitive 300 ms sleep under a loaded Extension Host.
            store.updateSuspendTtl(0);
            const ttlTransition = Date.now();
            while (Date.now() <= ttlTransition) {
                await delay(0);
            }

            // Trigger ANY follow-up event so the store has a chance to sweep
            // expired suspensions. Insert a single space at the end of the
            // document — does not overlap any annotation, plain Cas A/B/no-op.
            const triggerEdit = new vscode.WorkspaceEdit();
            const lastLine = document.lineCount - 1;
            const lastCol = document.lineAt(lastLine).text.length;
            triggerEdit.insert(uri, new vscode.Position(lastLine, lastCol), ' ');
            await applyEditAndWaitForDocumentEvent(uri, triggerEdit);

            const fetched = store.get(annotation.id);
            if (fetched && fetched.state !== 'disposed') {
                assert.fail(
                    `§7.4 (TTL): annotation must be disposed (or undefined) after TTL expiry + follow-up event ` +
                        `(state=${fetched.state})`
                );
                return;
            }
            // Either undefined (purged) OR state='disposed' is acceptable per spec.
            assert.strictEqual(store.getAll().length, 0, '§7.4 (TTL): getAll() must remain empty after TTL expiry');
        });

        test('§7.5 — paste after cut auto-resumes the annotation with the same id at the new offset', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture =
                'a\n' +
                'b\n' +
                'c\n' +
                'd\n' +
                'e\n' +
                'RESUME_TARGET\n' +
                'g\n' +
                'h\n' +
                'i\n' +
                'j\n' +
                'k\n' +
                'l\n';
            const uri = await ensureFixture('lot4-7-5-paste-after-cut.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            await delay(150);

            const store = new AnnotationStore();
            subscriptions.push(subscribeStore(store));

            const annotation = store.add(makeDraft(uri, 'cut-paste-victim'), { line: 5 }, document);
            const idBefore = annotation.id;

            // Cut line 5 (Cas D → suspend).
            const cutEdit = new vscode.WorkspaceEdit();
            cutEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)));
            await vscode.workspace.applyEdit(cutEdit);
            await delay(400);
            assert.strictEqual(store.getAll().length, 0, 'precondition §7.5: cut suspended the annotation');

            // Paste the SAME content at line 10 (which is line 9 after the cut shift).
            // The store's auto-paste detection must match the inserted text against
            // the suspended-buffer contents and resume the annotation in place.
            const pasteEdit = new vscode.WorkspaceEdit();
            pasteEdit.insert(uri, new vscode.Position(9, 0), 'RESUME_TARGET\n');
            await vscode.workspace.applyEdit(pasteEdit);
            await delay(500);

            assert.strictEqual(
                store.getAll().length,
                1,
                '§7.5: paste must resume the annotation, total active count = 1'
            );
            const restored = store.get(idBefore);
            if (!restored) {
                assert.fail(`§7.5: annotation (id=${idBefore}) must be resumed with the SAME id, got undefined`);
                return;
            }
            assert.strictEqual(restored.state, 'active', '§7.5: resumed annotation must be active');

            // Verify the new offsets resolve to line 9 (the paste destination).
            const newLine = document.positionAt(restored.startOffset).line;
            assert.strictEqual(
                newLine,
                9,
                `§7.5: resumed annotation must resolve to line 9 (paste destination), got ${newLine}`
            );
        });

        test('§7.6 — copy+paste creates a NEW annotation with origin.kind=paste; original survives unchanged', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture =
                'a\n' +
                'b\n' +
                'c\n' +
                'd\n' +
                'e\n' +
                'CLONE_TARGET\n' +
                'g\n' +
                'h\n' +
                'i\n' +
                'j\n' +
                'k\n' +
                'l\n';
            const uri = await ensureFixture('lot4-7-6-copy-paste.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            await delay(150);

            const store = new AnnotationStore();
            subscriptions.push(subscribeStore(store));

            const original = store.add(makeDraft(uri, 'business-message'), { line: 5 }, document);
            const originalStart = original.startOffset;
            const originalEnd = original.endOffset;

            // Copy = no delete. Paste = pure insertion of the same content at line 10.
            const pasteEdit = new vscode.WorkspaceEdit();
            pasteEdit.insert(uri, new vscode.Position(10, 0), 'CLONE_TARGET\n');
            const ok = await vscode.workspace.applyEdit(pasteEdit);
            assert.strictEqual(ok, true);
            await delay(500);

            const all = store.getAll();
            assert.strictEqual(all.length, 2, '§7.6: copy+paste must create a NEW annotation, total active count = 2');

            const survivor = store.get(original.id);
            if (!survivor) {
                assert.fail(`§7.6: original annotation (id=${original.id}) must survive`);
                return;
            }
            assert.strictEqual(
                survivor.startOffset,
                originalStart,
                '§7.6: original startOffset unchanged (paste was strictly after, Cas B)'
            );
            assert.strictEqual(survivor.endOffset, originalEnd, '§7.6: original endOffset unchanged');

            const clones = all.filter((a) => a.id !== original.id);
            assert.strictEqual(clones.length, 1, '§7.6: exactly one clone produced');
            const clone = clones[0];
            assert.notStrictEqual(clone.id, original.id, '§7.6: clone must have a NEW UUID');
            assert.strictEqual(
                clone.origin.kind,
                'paste',
                `§7.6: clone origin.kind must be 'paste' (got '${clone.origin.kind}')`
            );
            assert.strictEqual(clone.message, original.message, '§7.6: business message is preserved on clone');
            assert.strictEqual(
                clone.origin.sourceOpId !== undefined && clone.origin.sourceOpId.length > 0,
                true,
                '§7.6: clone origin.sourceOpId must reference the source op'
            );

            // Sanity: clone resolves to line 10.
            const cloneLine = document.positionAt(clone.startOffset).line;
            assert.strictEqual(cloneLine, 10, `§7.6: clone must resolve to line 10 (got ${cloneLine})`);
        });

        test('§7.10 — multi-paste produces N independent clones, each with own UUID and origin.kind=paste', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture =
                'a\n' +
                'b\n' +
                'c\n' +
                'd\n' +
                'e\n' +
                'MULTI_PASTE_TARGET\n' +
                'g\n' +
                'h\n' +
                'i\n' +
                'j\n' +
                'k\n' +
                'l\n' +
                'm\n' +
                'n\n' +
                'o\n' +
                'p\n' +
                'q\n' +
                'r\n';
            const uri = await ensureFixture('lot4-7-10-multi-paste.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            await delay(150);

            const store = new AnnotationStore();
            subscriptions.push(subscribeStore(store));

            const original = store.add(makeDraft(uri, 'multi-source'), { line: 5 }, document);

            // Three separate paste insertions of the same content at different
            // positions, each as its own WorkspaceEdit so the listener fires
            // 3 distinct events.
            const pastePositions = [10, 13, 17];
            for (const lineIdx of pastePositions) {
                const edit = new vscode.WorkspaceEdit();
                edit.insert(uri, new vscode.Position(lineIdx, 0), 'MULTI_PASTE_TARGET\n');
                const ok = await vscode.workspace.applyEdit(edit);
                assert.strictEqual(ok, true, `paste #${lineIdx} must apply`);
                await delay(300);
            }

            const all = store.getAll();
            assert.strictEqual(
                all.length,
                4,
                `§7.10: 1 original + 3 paste-clones = 4 active annotations (got ${all.length})`
            );

            const clones = all.filter((a) => a.id !== original.id);
            assert.strictEqual(clones.length, 3, '§7.10: 3 distinct clones produced');

            const cloneIds = new Set(clones.map((a) => a.id));
            assert.strictEqual(cloneIds.size, 3, '§7.10: each clone has its own UUID');
            for (const c of clones) {
                assert.strictEqual(
                    c.origin.kind,
                    'paste',
                    `§7.10: every clone must have origin.kind='paste' (got '${c.origin.kind}' for ${c.id})`
                );
                assert.notStrictEqual(c.id, original.id, '§7.10: clone id != original id');
            }

            // Sanity: the three clones occupy three distinct startOffsets.
            const startOffsets = new Set(clones.map((a) => a.startOffset));
            assert.strictEqual(startOffsets.size, 3, '§7.10: each clone has a distinct startOffset');
        });

        test('§7.12 — multi-line block deletion suspends both annotations; getAll() empties immediately', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture =
                'a\n' +
                'b\n' +
                'c\n' +
                'd\n' +
                'e\n' +
                'BLOCK_DELETE_LINE_1\n' +
                'BLOCK_DELETE_LINE_2\n' +
                'h\n' +
                'i\n';
            const uri = await ensureFixture('lot4-7-12-block-delete.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            await delay(150);

            const store = new AnnotationStore();
            subscriptions.push(subscribeStore(store));

            const a1 = store.add(makeDraft(uri, 'on-line-5'), { line: 5 }, document);
            const a2 = store.add(makeDraft(uri, 'on-line-6'), { line: 6 }, document);

            // Delete lines 5-6 inclusive (range [Position(5,0), Position(7,0))).
            const deleteEdit = new vscode.WorkspaceEdit();
            deleteEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(7, 0)));
            const ok = await vscode.workspace.applyEdit(deleteEdit);
            assert.strictEqual(ok, true);
            await delay(500);

            assert.strictEqual(
                store.getAll().length,
                0,
                '§7.12: block deletion of 2 annotated lines must leave 0 actives immediately'
            );

            // Both annotations must be suspended (or undefined if the implementation
            // chose to discard immediately without suspending). Spec is suspended.
            const f1 = store.get(a1.id);
            const f2 = store.get(a2.id);
            assert.ok(f1, `§7.12: a1 (id=${a1.id}) must remain reachable via store.get (suspended)`);
            assert.ok(f2, `§7.12: a2 (id=${a2.id}) must remain reachable via store.get (suspended)`);
            if (f1) {
                assert.strictEqual(f1.state, 'suspended', `§7.12: a1 state must be 'suspended' (got '${f1.state}')`);
            }
            if (f2) {
                assert.strictEqual(f2.state, 'suspended', `§7.12: a2 state must be 'suspended' (got '${f2.state}')`);
            }
        });

        test('§7.13 — block cut+paste preserves both annotation ids; new offsets reflect paste destination', async function () {
            this.timeout(20000);
            if (lot4Deferred()) {
                this.skip();
                return;
            }

            const fixture =
                'a\n' +
                'b\n' +
                'c\n' +
                'd\n' +
                'e\n' +
                'BLOCK_LINE_1\n' +
                'BLOCK_LINE_2\n' +
                'h\n' +
                'i\n' +
                'j\n' +
                'k\n' +
                'l\n' +
                'm\n' +
                'n\n';
            const uri = await ensureFixture('lot4-7-13-block-cut-paste.ts', fixture);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            await delay(150);

            const store = new AnnotationStore();
            subscriptions.push(subscribeStore(store));

            const a1 = store.add(makeDraft(uri, 'first-of-block'), { line: 5 }, document);
            const a2 = store.add(makeDraft(uri, 'second-of-block'), { line: 6 }, document);
            const id1 = a1.id;
            const id2 = a2.id;

            // Cut lines 5-6.
            const cutEdit = new vscode.WorkspaceEdit();
            cutEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(7, 0)));
            await vscode.workspace.applyEdit(cutEdit);
            await delay(400);
            assert.strictEqual(store.getAll().length, 0, 'precondition §7.13: both annotations suspended');

            // Paste the same block content at line 10 (which is line 8 after cut).
            // The paste content must be the EXACT text removed, byte-for-byte, so
            // the auto-resume can match both annotations and place them at lines
            // 8 and 9 in the post-paste document.
            const pasteEdit = new vscode.WorkspaceEdit();
            pasteEdit.insert(uri, new vscode.Position(8, 0), 'BLOCK_LINE_1\nBLOCK_LINE_2\n');
            await vscode.workspace.applyEdit(pasteEdit);
            await delay(500);

            assert.strictEqual(store.getAll().length, 2, '§7.13: both annotations resumed after block paste');
            const r1 = store.get(id1);
            const r2 = store.get(id2);
            if (!r1 || !r2) {
                assert.fail(
                    `§7.13: both annotations must be reachable with their ORIGINAL ids ` +
                        `(id1=${id1}: ${r1 ? 'ok' : 'missing'}, id2=${id2}: ${r2 ? 'ok' : 'missing'})`
                );
                return;
            }
            assert.strictEqual(r1.state, 'active', '§7.13: r1 must be active');
            assert.strictEqual(r2.state, 'active', '§7.13: r2 must be active');

            const r1Line = document.positionAt(r1.startOffset).line;
            const r2Line = document.positionAt(r2.startOffset).line;
            assert.strictEqual(r1Line, 8, `§7.13: r1 must land on line 8 (got ${r1Line})`);
            assert.strictEqual(r2Line, 9, `§7.13: r2 must land on line 9 (got ${r2Line})`);
        });
    }
);

// ---------------------------------------------------------------------------
// Suite — Lot 4 final: §7.3, §7.11, §7.14 (closes the 14-cases roster at the
// store-only layer, before Lot 5 wires consumers).
//
// All three exercise paths shipped by worker-1 in Lot 4 (sweepExpiredSuspended,
// detectPaste line-hash discrimination, serialize/deserialize round-trip with
// state preservation). Skip-probe still gates against Lot 4 deferral so the
// suite stays robust if a future refactor regresses suspend/resume.
// ---------------------------------------------------------------------------

suite('AnnotationStore (Lot 4 final) — §7.3, §7.11, §7.14', () => {
    const subscriptions: vscode.Disposable[] = [];

    teardown(async () => {
        while (subscriptions.length > 0) {
            const sub = subscriptions.pop();
            sub?.dispose();
        }
        await closeAllEditors();
    });

    function lot4Deferred(): boolean {
        const probe = new AnnotationStore();
        return isNotImplemented(() => probe.suspend('probe-id', 'probe-hash'));
    }

    test('§7.3 — deletion of the anchored line: annotation suspended, then disposed by TTL sweep, never re-appears elsewhere', async function () {
        this.timeout(20000);
        if (lot4Deferred()) {
            this.skip();
            return;
        }

        const fixture = 'a\n' + 'b\n' + 'c\n' + 'd\n' + 'e\n' + 'DELETE_ME\n' + 'g\n' + 'h\n' + 'i\n' + 'j\n';
        const uri = await ensureFixture('lot4-7-3-delete-anchored-line.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);

        // Keep natural expiry out of the immediate-state assertion. Once the
        // event has suspended the annotation, shorten the live TTL to zero and
        // deterministically advance the clock before the sweep event.
        const store = new AnnotationStore({ suspendTtlMs: 60_000 });
        subscriptions.push(subscribeStore(store));

        const annotation = store.add(makeDraft(uri, 'will-be-deleted'), { line: 5 }, document);
        const id = annotation.id;

        // Delete the anchored line entirely. Range [(5,0), (6,0)) wipes the
        // annotation's content. Cas D triggers suspend.
        const deleteEdit = new vscode.WorkspaceEdit();
        deleteEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)));
        await applyEditAndWaitForDocumentEvent(uri, deleteEdit);

        // Immediate state — suspended, not active, not disposed yet.
        const fetchedAfterDelete = store.get(id);
        if (!fetchedAfterDelete) {
            assert.fail(`§7.3: annotation must be reachable as suspended right after deletion (id=${id})`);
            return;
        }
        assert.strictEqual(
            fetchedAfterDelete.state,
            'suspended',
            `§7.3: state must be 'suspended' immediately after delete (got '${fetchedAfterDelete.state}')`
        );
        assert.strictEqual(store.getAll().length, 0, '§7.3: getAll() must list 0 actives after the deletion');

        // Trigger a follow-up event after a deterministic TTL transition so
        // the store sweeps expired suspensions inside applyDocumentChange.
        store.updateSuspendTtl(0);
        const ttlTransition = Date.now();
        while (Date.now() <= ttlTransition) {
            await delay(0);
        }
        const triggerEdit = new vscode.WorkspaceEdit();
        const lastLine = document.lineCount - 1;
        const lastCol = document.lineAt(lastLine).text.length;
        triggerEdit.insert(uri, new vscode.Position(lastLine, lastCol), ' ');
        await applyEditAndWaitForDocumentEvent(uri, triggerEdit);

        // Final state — disposed. Worker-1's sweep removes the record from
        // suspendedById, so `get(id)` returns undefined; OR (alternative
        // implementation) returns the record with state='disposed'. Both are
        // spec-compliant per the brief.
        const fetchedAfterTtl = store.get(id);
        if (fetchedAfterTtl !== undefined) {
            assert.strictEqual(
                fetchedAfterTtl.state,
                'disposed',
                `§7.3: after TTL sweep, get(id) must be undefined OR state='disposed' (got '${fetchedAfterTtl.state}')`
            );
        }

        // Crucial spec invariant: NO automatic relocation. The annotation must
        // never re-appear at any other position.
        assert.strictEqual(
            store.getAll().length,
            0,
            '§7.3: spec invariant — no automatic relocation; getAll() must remain empty after TTL sweep'
        );

        // Hash bucket must be empty too — the sweep unindexes from
        // suspendedByLineHash so a later paste of the same content cannot
        // resurrect the annotation.
        const blockHash = annotation.lineHash;
        const stillIndexed = store.getSuspendedByHash(blockHash);
        assert.strictEqual(stillIndexed.length, 0, '§7.3: TTL-disposed entries must be removed from the hash index');
    });

    test('§7.11 — partial-line paste does NOT trigger duplication (sub-string fragment, hash mismatch)', async function () {
        this.timeout(20000);
        if (lot4Deferred()) {
            this.skip();
            return;
        }

        // Anchored line = "    const TARGET = 1;" — full-line annotation.
        // We will paste a sub-string fragment (" = 1;") at line 10. The
        // detectPaste path hashes line-by-line on the inserted text; the
        // fragment's hash cannot match the full line's hash, so no clone.
        const fixture =
            'a\n' +
            'b\n' +
            'c\n' +
            'd\n' +
            'e\n' +
            '    const TARGET = 1;\n' +
            'g\n' +
            'h\n' +
            'i\n' +
            'j\n' +
            'k\n' +
            'l\n';
        const uri = await ensureFixture('lot4-7-11-partial-line-paste.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        subscriptions.push(subscribeStore(store));

        const annotation = store.add(makeDraft(uri, 'full-line-anchor'), { line: 5 }, document);
        const originalStart = annotation.startOffset;
        const originalEnd = annotation.endOffset;

        // Paste a sub-string of the anchored line at line 10 (column 0).
        // No trailing \n: the inserted text becomes part of the existing line
        // content; detectPaste hashes each line piece — the only piece is
        // " = 1;" which does NOT match hashLine("    const TARGET = 1;").
        const fragment = ' = 1;';
        const fragmentEdit = new vscode.WorkspaceEdit();
        fragmentEdit.insert(uri, new vscode.Position(10, 0), fragment);
        const ok = await vscode.workspace.applyEdit(fragmentEdit);
        assert.strictEqual(ok, true);
        await delay(500);

        const all = store.getAll();
        assert.strictEqual(
            all.length,
            1,
            `§7.11: partial-line fragment must NOT spawn a clone — expected 1 annotation, got ${all.length}`
        );

        const survivor = store.get(annotation.id);
        if (!survivor) {
            assert.fail(`§7.11: original annotation (id=${annotation.id}) must survive a non-matching fragment paste`);
            return;
        }
        assert.strictEqual(
            survivor.startOffset,
            originalStart,
            '§7.11: original startOffset unchanged (paste was strictly after, Cas B)'
        );
        assert.strictEqual(survivor.endOffset, originalEnd, '§7.11: original endOffset unchanged');
        assert.strictEqual(survivor.state, 'active', '§7.11: original annotation remains active');
    });

    test('§7.14 — serialize / reload preserves active + suspended state coherently; rejects unsupported schema', async function () {
        this.timeout(15000);
        if (lot4Deferred()) {
            this.skip();
            return;
        }

        const fixture =
            'one line\n' +
            'TWO LINE\n' +
            'three line longer\n' +
            'four\n' +
            'five\n' +
            'WILL_BE_CUT\n' +
            'seven\n' +
            'eight\n' +
            'nine\n';
        const uri = await ensureFixture('lot4-7-14-save-reload.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        // Fresh store, generous TTL so the cut annotation stays suspended for
        // the duration of the test (no premature sweep before serialize).
        const original = new AnnotationStore({ suspendTtlMs: 60_000 });
        subscriptions.push(subscribeStore(original));

        // a1 — active
        const a1 = original.add(makeDraft(uri, 'a1-active'), { line: 0 }, document);

        // a2 — will be cut → suspended
        const a2 = original.add(makeDraft(uri, 'a2-suspended'), { line: 5 }, document);
        const a2BlockHash = a2.lineHash;

        // a3 — active + updated (so the journal has a non-trivial trail)
        const a3 = original.add(makeDraft(uri, 'a3-original-message'), { line: 1 }, document);
        original.update(a3.id, { message: 'a3-updated-message' });

        // Cut a2's line.
        const cutEdit = new vscode.WorkspaceEdit();
        cutEdit.delete(uri, new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)));
        const ok = await vscode.workspace.applyEdit(cutEdit);
        assert.strictEqual(ok, true);
        await delay(400);
        assert.strictEqual(original.getAll().length, 2, 'precondition §7.14: 2 actives after cut');
        const fetchedA2BeforeSerialize = original.get(a2.id);
        if (!fetchedA2BeforeSerialize) {
            assert.fail('§7.14: a2 must be reachable as suspended before serialize');
            return;
        }
        assert.strictEqual(fetchedA2BeforeSerialize.state, 'suspended');

        // Serialize → in-memory JSON round-trip (do NOT touch disk to avoid
        // polluting the user's `.out-of-code-insights/annotations.json`).
        const exported = original.serialize();
        assert.strictEqual(exported.schemaVersion, 2);
        assert.strictEqual(
            exported.annotations.length,
            3,
            '§7.14: serialize must include 2 active + 1 suspended = 3 entries'
        );
        const json = JSON.stringify(exported);
        const parsed = JSON.parse(json) as typeof exported;

        // Reload into a fresh store.
        const restored = new AnnotationStore({ suspendTtlMs: 60_000 });
        restored.deserialize(parsed);

        // Active count: a1 + a3 (a2 is suspended, getAll() excludes).
        const actives = restored.getAll();
        assert.strictEqual(actives.length, 2, '§7.14: 2 actives after reload (a1 + a3)');

        // a1: id + offsets preserved.
        const r1 = restored.get(a1.id);
        if (!r1) {
            assert.fail('§7.14: a1 must round-trip with original id');
            return;
        }
        assert.strictEqual(r1.state, 'active');
        assert.strictEqual(r1.startOffset, a1.startOffset);
        assert.strictEqual(r1.endOffset, a1.endOffset);

        // a3: id preserved, latest message wins (the update merged before serialize).
        const r3 = restored.get(a3.id);
        if (!r3) {
            assert.fail('§7.14: a3 must round-trip with original id');
            return;
        }
        assert.strictEqual(r3.state, 'active');
        assert.strictEqual(
            r3.message,
            'a3-updated-message',
            '§7.14: latest message after update must be the one persisted'
        );

        // a2: suspended state preserved across reload, reachable via get(id)
        // and via the hash bucket so a future paste can resume it.
        const r2 = restored.get(a2.id);
        if (!r2) {
            assert.fail('§7.14: a2 must round-trip with original id even when suspended');
            return;
        }
        assert.strictEqual(
            r2.state,
            'suspended',
            `§7.14: a2 state must remain 'suspended' across reload (got '${r2.state}')`
        );

        const suspendedBucket = restored.getSuspendedByHash(a2BlockHash);
        assert.strictEqual(
            suspendedBucket.length,
            1,
            '§7.14: getSuspendedByHash must locate the reloaded suspended entry by lineHash'
        );
        assert.strictEqual(
            suspendedBucket[0].annotation.id,
            a2.id,
            '§7.14: hash bucket entry refers to the same annotation id'
        );

        // No phantom annotations: only a1 + a3 active, a2 suspended, total 3.
        const totalKnown = restored.getAll().length + restored.getSuspendedByHash(a2BlockHash).length;
        assert.strictEqual(
            totalKnown,
            3,
            '§7.14: spec invariant — no phantom annotations after reload (count = 2 active + 1 suspended)'
        );

        // Strict schema rejection: a v1 envelope must throw, no migration.
        const wrongSchemaPayload = {
            schemaVersion: 1 as unknown as 2,
            annotations: [],
        };
        let threw = false;
        try {
            const reject = new AnnotationStore();
            reject.deserialize(wrongSchemaPayload);
        } catch (err) {
            threw = true;
            assert.ok(err instanceof Error, '§7.14: schema mismatch must throw a real Error');
        }
        assert.strictEqual(
            threw,
            true,
            '§7.14: deserialize must REJECT schemaVersion !== 2 (no silent migration in v2)'
        );
    });
});
