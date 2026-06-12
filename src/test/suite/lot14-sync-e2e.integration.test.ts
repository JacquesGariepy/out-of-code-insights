/**
 * Lot 14 — cloud sync end-to-end: the EXTENSION's sync commands against a
 * REAL license-server instance spawned by the test (license key issued via
 * the real CLI, bearer token through the real syncConfigure command).
 *
 * Skipped cleanly when license-server/dist is absent (e.g. the extension CI
 * job, which does not build the standalone packages).
 */
import * as assert from 'assert';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID_CANDIDATES = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];
const SECRET = 'lot14-e2e-secret';
const PORT = 38917;

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

function repoRoot(): string {
    // The EDH workspace is <repo>/test-fixtures.
    return path.resolve(workspaceRoot(), '..');
}

function serverEntry(): string {
    return path.join(repoRoot(), 'license-server', 'dist', 'src', 'server.js');
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

suite('Lot 14 — extension sync commands against a live license server', () => {
    let server: ChildProcess | undefined;
    let dataDir = '';
    let licenseKey = '';
    const config = () => vscode.workspace.getConfiguration('annotation');

    suiteSetup(async function () {
        this.timeout(30000);
        const ext = findExtension();
        if (!ext || !fs.existsSync(serverEntry())) {
            this.skip();
            return;
        }
        await ext.activate();

        dataDir = fs.mkdtempSync(path.join(repoRoot(), '.lot14-data-'));
        const issued = spawnSync(
            process.execPath,
            [path.join(repoRoot(), 'license-server', 'dist', 'src', 'cli.js'), 'issue', '--entitlements', 'sync,pro'],
            { env: { ...process.env, LICENSE_SECRET: SECRET, DATA_DIR: dataDir }, encoding: 'utf8' }
        );
        licenseKey = issued.stdout.trim();
        assert.ok(licenseKey.startsWith('OOCI.'), `CLI must issue a key (stderr: ${issued.stderr})`);

        server = spawn(process.execPath, [serverEntry()], {
            env: { ...process.env, LICENSE_SECRET: SECRET, DATA_DIR: dataDir, PORT: String(PORT) },
            stdio: 'ignore',
        });
        await delay(1200);

        await config().update('sync.serverUrl', `http://127.0.0.1:${PORT}`, vscode.ConfigurationTarget.Workspace);
        await config().update('sync.workspaceId', 'lot14-team', vscode.ConfigurationTarget.Workspace);

        // Real token path: syncConfigure stores the key in SecretStorage.
        const original = vscode.window.showInputBox;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInputBox = async () => licenseKey;
        try {
            await vscode.commands.executeCommand('annotations.syncConfigure');
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInputBox = original;
        }
    });

    suiteTeardown(async function () {
        this.timeout(15000);
        await config().update('sync.serverUrl', undefined, vscode.ConfigurationTarget.Workspace);
        await config().update('sync.workspaceId', undefined, vscode.ConfigurationTarget.Workspace);
        server?.kill();
        await delay(300);
        if (dataDir) {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test('Sync Now pushes the local envelope; a second changed sync bumps the server version', async function () {
        this.timeout(30000);
        await clearAllAnnotationsViaCommand();

        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot14-sync.md'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from('first line\nsecond line\n', 'utf8'));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(300);
        await vscode.commands.executeCommand('annotations.add', { line: 0, message: 'lot14-shared' });
        await delay(600);

        await vscode.commands.executeCommand('annotations.syncNow');
        await delay(800);

        const remote = await fetch(`http://127.0.0.1:${PORT}/v1/workspaces/lot14-team/annotations`, {
            headers: { Authorization: `Bearer ${licenseKey}` },
        });
        assert.strictEqual(remote.status, 200, 'envelope must exist on the server after Sync Now');
        const first = (await remote.json()) as {
            version: number;
            envelope: { annotations: Array<{ message: string }> };
        };
        assert.ok(first.version >= 1, 'server version set');
        assert.ok(
            first.envelope.annotations.some((a) => a.message === 'lot14-shared'),
            'pushed envelope carries the local annotation'
        );

        // Local change → next sync pushes a new version.
        await vscode.commands.executeCommand('annotations.add', { line: 1, message: 'lot14-second' });
        await delay(600);
        await vscode.commands.executeCommand('annotations.syncNow');
        await delay(800);

        const second = await fetch(`http://127.0.0.1:${PORT}/v1/workspaces/lot14-team/annotations`, {
            headers: { Authorization: `Bearer ${licenseKey}` },
        });
        const next = (await second.json()) as {
            version: number;
            envelope: { annotations: Array<{ message: string }> };
        };
        assert.ok(next.version > first.version, 'server version must increase after a changed push');
        assert.strictEqual(
            next.envelope.annotations.filter((a) => a.message.startsWith('lot14-')).length,
            2,
            'both annotations are on the server'
        );
    });
});
