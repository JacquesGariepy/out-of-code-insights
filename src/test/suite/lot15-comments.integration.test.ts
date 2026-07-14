/**
 * Lot 15 — Comments API integration + AI agent instructions, inside the EDH.
 *
 * Part 1 drives the comment-thread command surface
 * (annotations.commentReply / commentResolve / commentUnresolve /
 * commentDelete) through their plain-`annotationId` testability fallback and
 * asserts the mutations against the persisted schema-v2 envelope — same
 * read-the-JSON discipline as the other lots. Crafting live
 * vscode.CommentThread arguments from a test is not practical; the commands
 * accept a plain annotation id string (or `{ annotationId, text }` for
 * replies) precisely for this.
 *
 * Part 2 runs `annotations.setupAiInstructions` and asserts the marked
 * block lands (once) in both CLAUDE.md and AGENTS.md at the workspace root,
 * idempotently across reruns.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID_CANDIDATES = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];

const START_MARKER = '<!-- out-of-code-insights:start -->';
const END_MARKER = '<!-- out-of-code-insights:end -->';
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];

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

interface PersistedAnnotation {
    id: string;
    message: string;
    resolved?: boolean;
    thread?: { id: string; message: string; timestamp: string }[];
    [key: string]: unknown;
}

interface SchemaV2Envelope {
    schemaVersion: 2;
    annotations: PersistedAnnotation[];
}

function readEnvelope(): SchemaV2Envelope {
    const file = annotationsFilePath();
    assert.ok(fs.existsSync(file), 'the v2 envelope must exist on disk');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SchemaV2Envelope;
    assert.strictEqual(parsed.schemaVersion, 2, 'envelope must be schema v2');
    assert.ok(Array.isArray(parsed.annotations), 'envelope must carry an annotations array');
    return parsed;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
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

function removeInstructionFiles(): void {
    for (const fileName of INSTRUCTION_FILES) {
        const filePath = path.join(workspaceRoot(), fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

suite('Lot 15 — Comments API threads + AI agent instructions', () => {
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
        removeInstructionFiles();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    teardown(async () => {
        removeInstructionFiles();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('comment commands mutate the persisted envelope via the annotation-id fallback', async function () {
        this.timeout(30000);

        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot15-comments-source.md'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from('# Lot 15\n\ncommented line\n\ntrailing line\n', 'utf8'));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(300);

        await vscode.commands.executeCommand('annotations.add', { line: 2, message: 'lot15 thread root' });
        await delay(600);

        let envelope = readEnvelope();
        const created = envelope.annotations.find((a) => a.message === 'lot15 thread root');
        assert.ok(created, 'annotation created via annotations.add must be persisted');
        const annotationId = created.id;
        assert.notStrictEqual(created.resolved, true, 'annotation starts unresolved');

        // Resolve via the plain-id fallback.
        await vscode.commands.executeCommand('annotations.commentResolve', annotationId);
        envelope = readEnvelope();
        let found = envelope.annotations.find((a) => a.id === annotationId);
        assert.ok(found, 'annotation must survive commentResolve');
        assert.strictEqual(found.resolved, true, 'commentResolve must persist resolved=true');

        // Reply via the `{ annotationId, text }` fallback shape.
        await vscode.commands.executeCommand('annotations.commentReply', {
            annotationId,
            text: 'lot15 first reply',
        });
        envelope = readEnvelope();
        found = envelope.annotations.find((a) => a.id === annotationId);
        assert.ok(found, 'annotation must survive commentReply');
        const threadEntries = found.thread ?? [];
        assert.strictEqual(threadEntries.length, 1, 'one reply persisted');
        assert.strictEqual(threadEntries[0].message, 'lot15 first reply');
        assert.ok(threadEntries[0].id, 'reply entries carry an id');
        assert.ok(threadEntries[0].timestamp, 'reply entries carry a timestamp');

        // Unresolve via the plain-id fallback.
        await vscode.commands.executeCommand('annotations.commentUnresolve', annotationId);
        envelope = readEnvelope();
        found = envelope.annotations.find((a) => a.id === annotationId);
        assert.ok(found, 'annotation must survive commentUnresolve');
        assert.strictEqual(found.resolved, false, 'commentUnresolve must persist resolved=false');

        // Delete via the plain-id fallback.
        await vscode.commands.executeCommand('annotations.commentDelete', annotationId);
        envelope = readEnvelope();
        assert.strictEqual(
            envelope.annotations.find((a) => a.id === annotationId),
            undefined,
            'commentDelete must remove the annotation from the envelope'
        );
    });

    test('setupAiInstructions upserts the block into CLAUDE.md and AGENTS.md idempotently', async function () {
        this.timeout(30000);

        const originalInfo = vscode.window.showInformationMessage;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = async () => undefined;
        try {
            await vscode.commands.executeCommand('annotations.setupAiInstructions');
            await delay(300);

            const firstRun = new Map<string, string>();
            for (const fileName of INSTRUCTION_FILES) {
                const filePath = path.join(workspaceRoot(), fileName);
                assert.ok(fs.existsSync(filePath), `${fileName} must be created at the workspace root`);
                const content = fs.readFileSync(filePath, 'utf8');
                firstRun.set(fileName, content);
                assert.strictEqual(countOccurrences(content, START_MARKER), 1, `${fileName}: one start marker`);
                assert.strictEqual(countOccurrences(content, END_MARKER), 1, `${fileName}: one end marker`);
                assert.ok(content.includes('doc:module'), `${fileName}: documentation tagging instructions`);
                assert.ok(content.includes('MCP tools'), `${fileName}: MCP tooling instructions`);
                assert.ok(
                    content.includes('annotation.docs.outputPath'),
                    `${fileName}: docs output path setting referenced`
                );
            }

            // Rerun: the block must be replaced in place, not duplicated.
            await vscode.commands.executeCommand('annotations.setupAiInstructions');
            await delay(300);

            for (const fileName of INSTRUCTION_FILES) {
                const filePath = path.join(workspaceRoot(), fileName);
                const content = fs.readFileSync(filePath, 'utf8');
                assert.strictEqual(
                    countOccurrences(content, START_MARKER),
                    1,
                    `${fileName}: still a single block after rerun`
                );
                assert.strictEqual(content, firstRun.get(fileName), `${fileName}: rerun is byte-identical`);
            }
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInformationMessage = originalInfo;
        }
    });
});
