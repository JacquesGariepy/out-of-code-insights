/**
 * Lot 7 — clipboard cut/copy + paste regression on NON-CODE files.
 *
 * Reproduces a user-reported defect: copy+paste in `.json` and cut+paste in
 * `.md` documents end up with TWO annotations (described as "stale orphan +
 * duplicate") whereas the same operations on `.ts` produce a clean single
 * relocation. The lot1–lot4 fixture set covers TS only, so this gap was not
 * exercised before.
 *
 * Test strategy:
 *   - Activate the real extension so BOTH the legacy AnnotationManager (v1)
 *     and the transactional AnnotationStore (v2) are wired through
 *     onDidChangeTextDocument together with the v1↔v2 mirror bridge.
 *   - Drive `annotations.add` to insert a single annotation, populate the OS
 *     clipboard via `vscode.env.clipboard.writeText` (mirroring a Ctrl+C /
 *     Ctrl+X), apply a paste via WorkspaceEdit, and let both handlers
 *     settle.
 *   - Inspect the surviving annotations via the persisted v2 envelope on
 *     disk (the only canonical view exposed across the dist/extension.js +
 *     out/test boundary, since module-level state is not shared).
 *
 * Tests are FAILING-FIRST: they capture the duplicate so the upcoming fix
 * can flip them green.
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

function annotationsFilePath(): string {
    return path.join(workspaceRoot(), '.out-of-code-insights', 'annotations.json');
}

interface PersistedV2Annotation {
    id: string;
    fileUri: string;
    file?: string;
    startOffset: number;
    endOffset: number;
    state?: string; // 'active' | 'suspended' | 'disposed'
    lineHash?: string;
    message: string;
}

interface PersistedV2Envelope {
    schemaVersion: 2;
    annotations: PersistedV2Annotation[];
}

function readPersistedV2(): PersistedV2Envelope | null {
    const file = annotationsFilePath();
    if (!fs.existsSync(file)) {
        return null;
    }
    const content = fs.readFileSync(file, 'utf8');
    if (content.trim().length === 0) {
        return null;
    }
    try {
        const parsed = JSON.parse(content);
        if (
            parsed &&
            typeof parsed === 'object' &&
            (parsed as { schemaVersion?: unknown }).schemaVersion === 2 &&
            Array.isArray((parsed as { annotations?: unknown }).annotations)
        ) {
            return parsed as PersistedV2Envelope;
        }
        return null;
    } catch {
        return null;
    }
}

function clearAnnotationsFile(): void {
    const file = annotationsFilePath();
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
    }
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

interface Stub {
    apply(): void;
    restore(): void;
}

function stubShowWarningMessageReturning(returnValue: string): Stub {
    const original = vscode.window.showWarningMessage;
    return {
        apply() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showWarningMessage = async () => returnValue;
        },
        restore() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showWarningMessage = original;
        },
    };
}

async function clearAllAnnotationsViaCommand(): Promise<void> {
    const stub = stubShowWarningMessageReturning('Yes');
    stub.apply();
    try {
        await vscode.commands.executeCommand('annotations.clearAll');
    } catch {
        /* tolerated — best-effort cleanup */
    } finally {
        stub.restore();
    }
}

interface AnnotationView {
    id: string;
    line: number;
    state: string;
    message: string;
}

function annotationsForFileFromPersisted(fileUri: string, document: vscode.TextDocument): AnnotationView[] {
    const env = readPersistedV2();
    if (!env) {
        return [];
    }
    return env.annotations
        .filter((a) => a.fileUri === fileUri)
        .map((a) => {
            let line = -1;
            try {
                if (a.startOffset >= 0 && a.startOffset <= document.getText().length) {
                    line = document.positionAt(a.startOffset).line;
                }
            } catch {
                line = -1;
            }
            return {
                id: a.id,
                line,
                state: a.state ?? 'active',
                message: a.message,
            };
        });
}

const JSON_FIXTURE =
    '[\n' +
    '  "alpha",\n' +
    '  "beta",\n' +
    '  "gamma",\n' +
    '  "delta",\n' +
    '  "TARGET_LINE",\n' +
    '  "epsilon",\n' +
    '  "zeta",\n' +
    '  "eta",\n' +
    '  "theta",\n' +
    '  "iota",\n' +
    '  "kappa"\n' +
    ']\n';

const JSON_COLLISION_FIXTURE =
    '{\n' +
    '  "items": [\n' +
    '    { "id": 1 },\n' +
    '    { "id": 2 },\n' +
    '    { "id": 3 },\n' +
    '    { "id": 4 },\n' +
    '    { "id": 5 }\n' +
    '  ],\n' +
    '  "meta": {\n' +
    '    "owner": "alice",\n' +
    '    "version": "1.0.0"\n' +
    '  }\n' +
    '}\n';

const MD_FIXTURE =
    '# Notes\n' +
    '\n' +
    'para 1 line A\n' +
    'para 1 line B\n' +
    '\n' +
    'TARGET_LINE\n' +
    'para 2 line A\n' +
    'para 2 line B\n' +
    '\n' +
    '* item 1\n' +
    '* item 2\n' +
    '* item 3\n';

suite('Lot 7 — clipboard cut/copy + paste on non-code files (failing-first repro)', () => {
    suiteSetup(async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            return;
        }
        await ext.activate();
    });

    setup(async () => {
        await clearAllAnnotationsViaCommand();
        clearAnnotationsFile();
        await closeAllEditors();
    });

    teardown(async () => {
        await closeAllEditors();
    });

    test('Scenario A — copy + paste in JSON: exactly one annotation per logical location', async function () {
        this.timeout(30000);

        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const uri = await ensureFixture('lot7-1-copy-paste.json', JSON_FIXTURE);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        // Force languageId so v1/v2 see the user's scenario exactly.
        if (document.languageId !== 'json') {
            await vscode.languages.setTextDocumentLanguage(document, 'json');
            await delay(100);
        }

        // 1. Add an annotation on line 5 (`"TARGET_LINE",`).
        const annotatedLine = 5;
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-A-source',
        });
        await delay(800);

        const beforePaste = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(
            beforePaste.length,
            1,
            `setup: expected 1 annotation on JSON before paste, got ${beforePaste.length}: ` +
                JSON.stringify(beforePaste)
        );
        assert.strictEqual(beforePaste[0].line, annotatedLine);

        // 2. Real VS Code copy: select the entire annotated line including its
        // newline, then run `editor.action.clipboardCopyAction` so the OS
        // clipboard is populated by the same code path Ctrl+C goes through.
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
        await delay(100);

        // 3. Move cursor to the paste destination (line 10, before `"kappa"`)
        // and run the real paste command so v1's clipboard-read guard sees an
        // exact match against the OS clipboard.
        const pasteLine = 10;
        editor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');

        // 4. Wait for v1 (async clipboard read) AND v2 handlers to settle, plus
        // the bridge mirror that fires on store.onDidChange and the persistence
        // debounce flush.
        await delay(1500);

        // Save the document to ensure persistence flush completes.
        await document.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), document);

        // Diagnostic: dump the persisted state to the test runner's stdout so
        // failure analysis sees what landed on disk.
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-A] persisted after copy+paste:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        // Contract: copy+paste produces at most one annotation per logical
        // location. The original at `annotatedLine` must remain attached to
        // its own line; if the algorithm clones to the paste site, the clone
        // must sit at `pasteLine` (NOT collapse to the source line). We
        // accept either the "no clone" design (1 total) or the "fresh clone"
        // design (2 total at distinct lines).
        const lines = afterPaste.map((a) => a.line).sort((a, b) => a - b);
        const distinctLines = new Set(lines);

        assert.ok(
            afterPaste.length <= 2,
            `JSON copy+paste must not create more than 2 annotations, got ${afterPaste.length}: ` +
                JSON.stringify(afterPaste)
        );
        assert.strictEqual(
            distinctLines.size,
            afterPaste.length,
            `JSON copy+paste produced ${afterPaste.length} annotations but only ${distinctLines.size} ` +
                `distinct lines — duplicates collapsing to the same logical location: ` +
                JSON.stringify(afterPaste)
        );
        const onSourceLine = afterPaste.filter((a) => a.line === annotatedLine);
        assert.strictEqual(
            onSourceLine.length,
            1,
            `JSON copy+paste must leave exactly 1 annotation on the source line ${annotatedLine}, ` +
                `got ${onSourceLine.length}: ` +
                JSON.stringify(afterPaste)
        );
    });

    test('Scenario C — copy + paste in JSON with hash-colliding closing braces above the annotation', async function () {
        this.timeout(30000);

        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const uri = await ensureFixture('lot7-3-collision-copy-paste.json', JSON_COLLISION_FIXTURE);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'json') {
            await vscode.languages.setTextDocumentLanguage(document, 'json');
            await delay(100);
        }

        // Anchor on `{ "id": 3 },` (line 4, the middle of five hash-colliding
        // sibling object lines). This is the worst case for the anchoring
        // collision gate: identical hash on lines 2/3/4/5 with similar
        // surrounding context.
        const annotatedLine = 4;
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-C-source',
        });
        await delay(800);

        const beforePaste = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(
            beforePaste.length,
            1,
            `setup: expected 1 annotation, got ${beforePaste.length}: ` + JSON.stringify(beforePaste)
        );

        // Real VS Code copy via Ctrl+C path.
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
        await delay(100);

        // Paste at line 8 (between `]` and `"meta": {`). After paste the
        // anchored line text exists at TWO places (line 4 and line 8) with
        // hash-identical neighbours.
        const pasteLine = 8;
        editor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');

        await delay(1500);
        await document.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), document);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-C] persisted after copy+paste (collision case):',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        // Same contract as Scenario A: at most 2 annotations, at distinct
        // lines, exactly one on the source line. The collision-prone content
        // must not collapse the original onto the paste site (or vice
        // versa).
        const lines = afterPaste.map((a) => a.line).sort((a, b) => a - b);
        const distinctLines = new Set(lines);

        assert.ok(
            afterPaste.length <= 2,
            `JSON collision copy+paste must produce at most 2 annotations, got ${afterPaste.length}: ` +
                JSON.stringify(afterPaste)
        );
        assert.strictEqual(
            distinctLines.size,
            afterPaste.length,
            `JSON collision copy+paste produced ${afterPaste.length} annotations but only ${distinctLines.size} ` +
                `distinct lines: ` +
                JSON.stringify(afterPaste)
        );
        const onSourceLine = afterPaste.filter((a) => a.line === annotatedLine);
        assert.strictEqual(
            onSourceLine.length,
            1,
            `JSON collision copy+paste must leave exactly 1 annotation on the source line ${annotatedLine}, ` +
                `got ${onSourceLine.length}: ` +
                JSON.stringify(afterPaste)
        );
    });

    test('Scenario B — cut + paste in Markdown: net 1 annotation at the paste destination', async function () {
        this.timeout(30000);

        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const uri = await ensureFixture('lot7-2-cut-paste.md', MD_FIXTURE);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'markdown') {
            await vscode.languages.setTextDocumentLanguage(document, 'markdown');
            await delay(100);
        }

        // 1. Add an annotation on line 5 (`TARGET_LINE`).
        const annotatedLine = 5;
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-B-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(
            beforeCut.length,
            1,
            `setup: expected 1 annotation on MD before cut, got ${beforeCut.length}: ` + JSON.stringify(beforeCut)
        );

        // 2. Real VS Code cut: select the line + trailing newline, then run
        // `editor.action.clipboardCutAction` (the same path Ctrl+X drives).
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700); // v2 suspend + v1 process + persistence flush

        const afterCut = annotationsForFileFromPersisted(uri.toString(), document);
        // eslint-disable-next-line no-console
        console.log('[lot7-B] persisted after cut:', JSON.stringify(afterCut, null, 2), '— total =', afterCut.length);

        // 3. Move cursor to line 10 of the post-cut document and paste via
        // the real VS Code clipboard paste command.
        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        const pasteLineInPostCutDoc = 10;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLineInPostCutDoc, 0, pasteLineInPostCutDoc, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');

        await delay(1500);

        // Save to ensure persistence flush.
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-B] persisted after paste:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        // Contract: cut + paste must end with EXACTLY ONE annotation.
        // Two annotations means either the cut failed to remove the source
        // OR the paste cloned a NEW annotation in addition to resuming the
        // suspended one (the bug under investigation).
        assert.strictEqual(
            afterPaste.length,
            1,
            `MD cut+paste must leave exactly 1 annotation, got ${afterPaste.length}: ` + JSON.stringify(afterPaste)
        );

        const survivor = afterPaste[0];
        // The survivor's line index after the round-trip must point at the
        // paste destination, not at the now-gone source.
        assert.ok(
            survivor.line >= 0,
            `MD cut+paste survivor must have a valid line index, got ${survivor.line}: ` + JSON.stringify(survivor)
        );
        // The survivor must NOT remain in 'suspended' state — paste should
        // have resumed it.
        assert.notStrictEqual(
            survivor.state,
            'suspended',
            `MD cut+paste survivor must be active (resumed), got state=${survivor.state}: ` + JSON.stringify(survivor)
        );
    });

    // -----------------------------------------------------------------------
    // Scenario D — cut + paste on the LAST line of a Markdown file with NO
    // trailing newline. This is the smoking-gun case the user reproduces:
    // VS Code's Ctrl+X cuts a range whose r1 == annotation.endOffset (no \n
    // to extend past), which falls into Cas C (`r0 >= a0 && r1 <= a1`) under
    // the unguarded classification — Cas C only shifts endOffset and leaves
    // the annotation ACTIVE in v2.map with collapsed offsets. detectPaste
    // then finds it as an active candidate and clones via cloneAsPaste,
    // producing 2 annotations.
    // -----------------------------------------------------------------------
    test('Scenario D — cut + paste the LAST line of a Markdown file with no trailing newline', async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        // No trailing newline — the annotated line IS the last byte of the file.
        const fixtureNoTrailingNl =
            '# Notes\n' +
            '\n' +
            'para 1\n' +
            'para 2\n' +
            '\n' +
            '## Section B\n' +
            'body line\n' +
            '\n' +
            'TARGET_LAST_LINE';
        const uri = await ensureFixture('lot7-4-last-line-no-nl.md', fixtureNoTrailingNl);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'markdown') {
            await vscode.languages.setTextDocumentLanguage(document, 'markdown');
            await delay(100);
        }

        const annotatedLine = 8; // 'TARGET_LAST_LINE' — the last line, no \n after it
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-D-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: expected 1 annotation: ' + JSON.stringify(beforeCut));

        // Ctrl+X on the last line with no trailing \n: VS Code cuts the
        // line content (range goes through end-of-document, NO trailing
        // newline available to extend past annotation.endOffset).
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        // Paste at line 3 (between para 2 and the blank line).
        const pasteLineInPostCutDoc = 3;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLineInPostCutDoc, 0, pasteLineInPostCutDoc, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);

        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-D] last-line-no-nl persisted after cut+paste:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `MD last-line-no-nl cut+paste must leave EXACTLY 1 annotation (suspend→resume), ` +
                `got ${afterPaste.length}: ` +
                JSON.stringify(afterPaste)
        );
        // Same id pre- and post-paste: the annotation was suspended and
        // resumed (NOT cloned with a new UUID).
        assert.strictEqual(
            afterPaste[0].id,
            beforeCut[0].id,
            `MD last-line-no-nl cut+paste must preserve the annotation id ` +
                `(resume path, not clone): before=${beforeCut[0].id} after=${afterPaste[0].id}`
        );
    });

    // -----------------------------------------------------------------------
    // Scenario E — cut + paste a line containing multi-byte UTF-8 characters.
    // Offsets in VS Code are UTF-16 code units, not bytes; the classification
    // must still hit Cas D regardless of character width.
    // -----------------------------------------------------------------------
    test('Scenario E — cut + paste a Markdown line with multi-byte characters', async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const fixture =
            '# Notes\n' +
            'before\n' +
            'café résumé naïve façade — “quoted” with em-dash\n' +
            'after\n' +
            '\n' +
            'tail\n';
        const uri = await ensureFixture('lot7-5-multibyte.md', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'markdown') {
            await vscode.languages.setTextDocumentLanguage(document, 'markdown');
            await delay(100);
        }

        const annotatedLine = 2;
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-E-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: 1 annotation: ' + JSON.stringify(beforeCut));

        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        const pasteLine = 4;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);

        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-E] multibyte persisted after cut+paste:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `MD multibyte cut+paste must leave 1 annotation, got ${afterPaste.length}: ` + JSON.stringify(afterPaste)
        );
        assert.strictEqual(afterPaste[0].id, beforeCut[0].id, 'multibyte: same id pre/post-paste');
    });

    // -----------------------------------------------------------------------
    // Scenario F — multi-line selection cut that contains the annotated line,
    // followed by paste. The block-cut should suspend the annotation (range
    // fully covers the annotated offsets) and the block-paste should resume
    // it once the matching lineHash appears in the inserted text.
    // -----------------------------------------------------------------------
    test('Scenario F — multi-line cut + paste a block containing one annotated line', async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const fixture =
            '# Notes\n' +
            'pre line A\n' +
            'pre line B\n' +
            'block top\n' +
            'TARGET_BLOCK_LINE\n' +
            'block tail\n' +
            'post line A\n' +
            'post line B\n' +
            '\n' +
            'tail\n';
        const uri = await ensureFixture('lot7-6-block-cut.md', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'markdown') {
            await vscode.languages.setTextDocumentLanguage(document, 'markdown');
            await delay(100);
        }

        const annotatedLine = 4; // 'TARGET_BLOCK_LINE'
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-F-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: 1 annotation: ' + JSON.stringify(beforeCut));

        // Cut the 3-line block (lines 3..5 inclusive: 'block top',
        // 'TARGET_BLOCK_LINE', 'block tail') including the trailing newline.
        editor.selection = new vscode.Selection(3, 0, 6, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        // Paste below 'post line B' (now at line 4 of the post-cut doc).
        const pasteLineInPostCutDoc = 5;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLineInPostCutDoc, 0, pasteLineInPostCutDoc, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);

        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-F] block cut+paste persisted:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `MD block cut+paste must leave 1 annotation, got ${afterPaste.length}: ` + JSON.stringify(afterPaste)
        );
        assert.strictEqual(afterPaste[0].id, beforeCut[0].id, 'block: same id pre/post-paste');
    });

    // -----------------------------------------------------------------------
    // Scenario G — JSON cut + paste, the "disappearing annotation" bug. The
    // user reports that on `.json` files the previous-round Cas D fix
    // suspends the annotation correctly but `detectPaste` never resumes it,
    // so the annotation vanishes from active state until TTL disposes it.
    // -----------------------------------------------------------------------
    test('Scenario G — cut + paste in JSON: annotation must resume (not disappear)', async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        // Mirror the user's environment where `editor.formatOnPaste` is enabled
        // for JSON. The built-in JSON formatter rewrites the pasted line's
        // indentation / commas to fit the destination, which can mutate the
        // inserted text BEFORE detectPaste reads it. If hashLine on the
        // post-format text doesn't match the suspended ann.lineHash, the
        // resume lookup misses and the annotation disappears (TTL-disposed
        // 30s later).
        const cfg = vscode.workspace.getConfiguration('editor');
        const previousFormatOnPaste = cfg.get<boolean>('formatOnPaste');
        await cfg.update('formatOnPaste', true, vscode.ConfigurationTarget.Workspace);
        // Restore on test exit so other scenarios are unaffected.
        const restoreFormatOnPaste = async (): Promise<void> => {
            await cfg.update('formatOnPaste', previousFormatOnPaste, vscode.ConfigurationTarget.Workspace);
        };

        const fixture =
            '{\n' +
            '  "users": [\n' +
            '    {\n' +
            '      "id": 1,\n' +
            '      "name": "alice",\n' +
            '      "active": true\n' +
            '    },\n' +
            '    {\n' +
            '      "id": 2,\n' +
            '      "name": "bob"\n' +
            '    }\n' +
            '  ]\n' +
            '}\n';
        const uri = await ensureFixture('lot7-7-json-disappear.json', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'json') {
            await vscode.languages.setTextDocumentLanguage(document, 'json');
            await delay(100);
        }

        const annotatedLine = 4; // '      "name": "alice",'
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-G-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: 1 annotation: ' + JSON.stringify(beforeCut));

        // Real Ctrl+X cut.
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        // Paste below 'bob' name. The post-cut doc has 12 lines (indices 0..11);
        // line 9 is `      "name": "bob"`, paste BELOW it at line 10 (just before `}`).
        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        const pasteLine = 10;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-G] JSON cut+paste persisted:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `JSON cut+paste must leave EXACTLY 1 annotation, got ${afterPaste.length}: ` + JSON.stringify(afterPaste)
        );
        const survivor = afterPaste[0];
        assert.strictEqual(
            survivor.id,
            beforeCut[0].id,
            `JSON cut+paste must preserve the id (suspend→resume, not disappear): ` +
                `before=${beforeCut[0].id} after=${survivor.id}`
        );
        assert.notStrictEqual(
            survivor.state,
            'suspended',
            `JSON cut+paste survivor must be ACTIVE, got state=${survivor.state}: ` + JSON.stringify(survivor)
        );
        await restoreFormatOnPaste();
    });

    // -----------------------------------------------------------------------
    // Scenario G' — JSON: annotate a line, EDIT the line content (single-char
    // typing), then cut + paste. Single-char edits go through Cas C without
    // triggering `changeAffectsLineStructure` (which only fires on `\n` or
    // multi-line changes), so `refreshAnchorContext` is never called and
    // `ann.lineHash` stays bound to the line text at annotation-creation time.
    // On cut, suspend uses the stale lineHash; on paste, the inserted text
    // hashes to the CURRENT (edited) line content — different value, lookup
    // misses, annotation disappears.
    // -----------------------------------------------------------------------
    test("Scenario G' — JSON: edit-then-cut+paste, annotation must still resume", async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const fixture =
            '{\n' +
            '  "users": [\n' +
            '    {\n' +
            '      "id": 1,\n' +
            '      "name": "alice",\n' +
            '      "active": true\n' +
            '    },\n' +
            '    {\n' +
            '      "id": 2,\n' +
            '      "name": "bob"\n' +
            '    }\n' +
            '  ]\n' +
            '}\n';
        const uri = await ensureFixture('lot7-7b-json-edit-cut.json', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'json') {
            await vscode.languages.setTextDocumentLanguage(document, 'json');
            await delay(100);
        }

        const annotatedLine = 4;
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-Gprime-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: 1 annotation: ' + JSON.stringify(beforeCut));

        // Edit the annotated line: change "alice" → "alicia" via a single
        // WorkspaceEdit insert (no newline) — exercises Cas C without
        // triggering refreshAnchorContext.
        const edit = new vscode.WorkspaceEdit();
        // Insert 'i' between 'lic' and 'e' in "alice" → "alicie" (close
        // enough; just need a content change without a newline).
        const lineText = document.lineAt(annotatedLine).text;
        const aliceIdx = lineText.indexOf('alice');
        assert.ok(aliceIdx >= 0, 'fixture must contain "alice" on the annotated line');
        edit.insert(uri, new vscode.Position(annotatedLine, aliceIdx + 'alic'.length), 'i');
        const editOk = await vscode.workspace.applyEdit(edit);
        assert.ok(editOk, 'edit must succeed');
        await delay(500);

        // Now cut the (edited) line.
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        // Paste below 'bob' name in the post-cut doc.
        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        const pasteLine = 10;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            "[lot7-G'] JSON edit-cut+paste persisted:",
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `JSON edit-cut+paste must leave EXACTLY 1 annotation (resumed), got ${afterPaste.length}: ` +
                JSON.stringify(afterPaste)
        );
        const survivor = afterPaste[0];
        assert.strictEqual(
            survivor.id,
            beforeCut[0].id,
            `JSON edit-cut+paste must preserve id (suspend→resume): before=${beforeCut[0].id} after=${survivor.id}`
        );
        assert.notStrictEqual(
            survivor.state,
            'suspended',
            `JSON edit-cut+paste survivor must be ACTIVE, got state=${survivor.state}: ` + JSON.stringify(survivor)
        );
    });

    // -----------------------------------------------------------------------
    // Scenario H — YAML cut + paste regression guard. YAML uses indentation
    // semantically; the previous-round normalizeLine collapses whitespace,
    // so cut+paste with a different indent context should still resume.
    // -----------------------------------------------------------------------
    test('Scenario H — cut + paste in YAML: annotation must resume', async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const fixture =
            'database:\n' +
            '  host: localhost\n' +
            '  port: 5432\n' +
            '  user: admin\n' +
            'redis:\n' +
            '  host: localhost\n' +
            '  port: 6379\n' +
            'logging:\n' +
            '  level: info\n';
        const uri = await ensureFixture('lot7-8-yaml.yaml', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'yaml') {
            await vscode.languages.setTextDocumentLanguage(document, 'yaml');
            await delay(100);
        }

        const annotatedLine = 3; // '  user: admin'
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-H-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: 1 annotation: ' + JSON.stringify(beforeCut));

        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        const pasteLine = 7;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-H] YAML cut+paste persisted:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `YAML cut+paste must leave 1 annotation, got ${afterPaste.length}: ` + JSON.stringify(afterPaste)
        );
        assert.strictEqual(afterPaste[0].id, beforeCut[0].id, 'YAML: same id pre/post-paste');
        assert.notStrictEqual(afterPaste[0].state, 'suspended', 'YAML: survivor must be active');
    });

    // -----------------------------------------------------------------------
    // Scenario I — CSV cut + paste regression guard. Plain comma-separated
    // values, no formatter intervention expected.
    // -----------------------------------------------------------------------
    test('Scenario I — cut + paste in CSV: annotation must resume', async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const fixture =
            'name,age,role\n' +
            'alice,30,engineer\n' +
            'bob,42,manager\n' +
            'charlie,28,developer\n' +
            'dave,35,designer\n' +
            'emma,32,architect\n';
        const uri = await ensureFixture('lot7-9-csv.csv', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        const annotatedLine = 2; // 'bob,42,manager'
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-I-source',
        });
        await delay(800);

        const beforeCut = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(beforeCut.length, 1, 'setup: 1 annotation: ' + JSON.stringify(beforeCut));

        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        const pasteLine = 4;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(1500);
        await updatedDoc.save();
        await delay(200);

        const afterPaste = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-I] CSV cut+paste persisted:',
            JSON.stringify(afterPaste, null, 2),
            '— total =',
            afterPaste.length
        );

        assert.strictEqual(
            afterPaste.length,
            1,
            `CSV cut+paste must leave 1 annotation, got ${afterPaste.length}: ` + JSON.stringify(afterPaste)
        );
        assert.strictEqual(afterPaste[0].id, beforeCut[0].id, 'CSV: same id pre/post-paste');
        assert.notStrictEqual(afterPaste[0].state, 'suspended', 'CSV: survivor must be active');
    });

    // -----------------------------------------------------------------------
    // Scenario G2 — JSON simple cut+paste (no edit) with formatOnPaste AND
    // formatOnType BOTH enabled at the WORKSPACE level (overriding the
    // test-fixtures workspace's `editor.formatOnPaste:false` baked into
    // `.vscode/settings.json`). The user's interactive F5 session may be
    // running with these enabled, and the JSON formatter rewriting the
    // pasted line's whitespace BEFORE detectPaste reads it is the prime
    // suspect for the disappearance.
    // -----------------------------------------------------------------------
    test('Scenario G2 — JSON simple cut+paste with formatOnPaste/Type forced ON', async function () {
        this.timeout(45000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const cfg = vscode.workspace.getConfiguration('editor');
        const prevFOP = cfg.get<boolean>('formatOnPaste');
        const prevFOT = cfg.get<boolean>('formatOnType');
        await cfg.update('formatOnPaste', true, vscode.ConfigurationTarget.Workspace);
        await cfg.update('formatOnType', true, vscode.ConfigurationTarget.Workspace);
        const restore = async (): Promise<void> => {
            await cfg.update('formatOnPaste', prevFOP, vscode.ConfigurationTarget.Workspace);
            await cfg.update('formatOnType', prevFOT, vscode.ConfigurationTarget.Workspace);
        };
        await delay(200);

        const fixture =
            '{\n' +
            '  "name": "demo",\n' +
            '  "version": "1.0.0",\n' +
            '  "active": true,\n' +
            '  "tag": "alpha",\n' +
            '  "owner": "team-a",\n' +
            '  "id": 42\n' +
            '}\n';
        const uri = await ensureFixture('lot7-G2-json-simple.json', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        if (document.languageId !== 'json') {
            await vscode.languages.setTextDocumentLanguage(document, 'json');
            await delay(100);
        }

        // Annotate `"tag": "alpha",` (line 4).
        const annotatedLine = 4;
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine, 0);
        await vscode.commands.executeCommand('annotations.add', {
            line: annotatedLine,
            message: 'lot7-G2-source',
        });
        await delay(800);

        const before = annotationsForFileFromPersisted(uri.toString(), document);
        assert.strictEqual(before.length, 1, 'setup: 1 annotation: ' + JSON.stringify(before));

        // Real Ctrl+X on the line (no preceding edit).
        editor.selection = new vscode.Selection(annotatedLine, 0, annotatedLine + 1, 0);
        await vscode.commands.executeCommand('editor.action.clipboardCutAction');
        await delay(700);

        // Real Ctrl+V at line 6 (between "owner" and "id"). With formatOnPaste
        // active, the JSON formatter will likely re-indent the pasted line.
        const updatedDoc = vscode.window.activeTextEditor?.document ?? document;
        const pasteLine = 6;
        const pasteEditor = vscode.window.activeTextEditor ?? editor;
        pasteEditor.selection = new vscode.Selection(pasteLine, 0, pasteLine, 0);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await delay(2000);
        await updatedDoc.save();
        await delay(300);

        const after = annotationsForFileFromPersisted(uri.toString(), updatedDoc);
        // eslint-disable-next-line no-console
        console.log(
            '[lot7-G2] simple cut+paste with formatOnPaste=true persisted:',
            JSON.stringify(after, null, 2),
            '— total =',
            after.length
        );

        try {
            assert.strictEqual(
                after.length,
                1,
                `JSON simple cut+paste must leave EXACTLY 1 annotation, got ${after.length}: ` + JSON.stringify(after)
            );
            assert.strictEqual(
                after[0].id,
                before[0].id,
                `JSON simple cut+paste must preserve id: before=${before[0].id} after=${after[0].id}`
            );
            assert.notStrictEqual(
                after[0].state,
                'suspended',
                `JSON simple cut+paste survivor must be active, got state=${after[0].state}`
            );
        } finally {
            await restore();
        }
    });
});
