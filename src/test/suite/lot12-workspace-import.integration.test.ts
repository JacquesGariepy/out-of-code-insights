/**
 * Lot 12 — workspace-wide better-comments bridge:
 * `annotations.importCommentsWorkspace` scans every matching file in the
 * workspace (filesystem reads, no editors opened) and imports marker
 * comments as tagged, severity-mapped annotations. The workspace contains
 * other fixtures, so every assertion filters on the two lot12 fileUris.
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
    languageId?: string;
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

/** 0-based start offset of `line` inside `source` (LF line endings). */
function lineStartOffset(source: string, line: number): number {
    let offset = 0;
    for (let i = 0; i < line; i++) {
        offset = source.indexOf('\n', offset) + 1;
    }
    return offset;
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

async function runWorkspaceImport(): Promise<void> {
    const original = vscode.window.showInformationMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => undefined;
    try {
        await vscode.commands.executeCommand('annotations.importCommentsWorkspace');
        await delay(800);
    } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = original;
    }
}

suite('Lot 12 — workspace-wide comment import', () => {
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

    test('imports markers from every workspace file; rerun creates no duplicates', async function () {
        this.timeout(60000);

        const uriA = vscode.Uri.file(path.join(workspaceRoot(), 'lot12-a.ts'));
        const sourceA =
            'export function alpha(): number {\n' +
            '    // ! validate inputs\n' +
            '    // TODO: add caching\n' +
            '    return 1; // plain comment, no marker\n' +
            '}\n';
        const uriB = vscode.Uri.file(path.join(workspaceRoot(), 'lot12-b.py'));
        const sourceB = 'def beta():\n' + '    # FIXME broken rounding\n' + '    return 2  # plain comment\n';
        await vscode.workspace.fs.writeFile(uriA, Buffer.from(sourceA, 'utf8'));
        await vscode.workspace.fs.writeFile(uriB, Buffer.from(sourceB, 'utf8'));

        await runWorkspaceImport();

        const forA = readPersistedFor(uriA.toString());
        assert.strictEqual(forA.length, 2, 'two marker comments imported from lot12-a.ts, plain comment skipped');
        const alert = forA.find((a) => a.tags?.includes('alert'));
        const todo = forA.find((a) => a.tags?.includes('todo'));
        assert.ok(alert, 'alert (!) marker imported from lot12-a.ts');
        assert.ok(todo, 'todo marker imported from lot12-a.ts');
        assert.strictEqual(alert?.message, 'validate inputs');
        assert.strictEqual(alert?.severity, 'error');
        assert.ok(alert?.tags?.includes('imported-comment'));
        assert.strictEqual(alert?.languageId, 'typescript');
        assert.strictEqual(alert?.startOffset, lineStartOffset(sourceA, 1), 'alert anchored at line 1 start');
        assert.strictEqual(todo?.message, 'add caching');
        assert.strictEqual(todo?.startOffset, lineStartOffset(sourceA, 2), 'todo anchored at line 2 start');

        const forB = readPersistedFor(uriB.toString());
        assert.strictEqual(forB.length, 1, 'one marker comment imported from lot12-b.py');
        assert.ok(forB[0].tags?.includes('fixme'), 'fixme marker imported from lot12-b.py');
        assert.ok(forB[0].tags?.includes('imported-comment'));
        assert.strictEqual(forB[0].message, 'broken rounding');
        assert.strictEqual(forB[0].severity, 'warning');
        assert.strictEqual(forB[0].languageId, 'python');
        assert.strictEqual(forB[0].startOffset, lineStartOffset(sourceB, 1), 'fixme anchored at line 1 start');

        // Idempotence: a second workspace-wide run must not duplicate the
        // already-annotated lines of either file.
        await runWorkspaceImport();
        assert.strictEqual(readPersistedFor(uriA.toString()).length, 2, 'rerun adds nothing for lot12-a.ts');
        assert.strictEqual(readPersistedFor(uriB.toString()).length, 1, 'rerun adds nothing for lot12-b.py');
    });
});
