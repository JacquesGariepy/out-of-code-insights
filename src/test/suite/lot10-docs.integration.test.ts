/**
 * Lot 10 — end-to-end documentation generation inside the EDH.
 * Creates annotations through the real command surface, runs
 * `annotations.generateDocs`, and asserts the portable site bundle on disk.
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

async function withDismissedDocumentationNotifications<T>(run: () => Promise<T>): Promise<T> {
    const originalInformation = vscode.window.showInformationMessage;
    const originalWarning = vscode.window.showWarningMessage;
    // A complete documentation profile can legitimately emit warnings when
    // optional technical-document roles have no annotations. In production,
    // the command waits for the user to choose an action from that warning.
    // EDH tests must dismiss both possible completion notifications.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showInformationMessage = async () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.window as any).showWarningMessage = async () => undefined;
    try {
        return await run();
    } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = originalInformation;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = originalWarning;
    }
}

suite('Lot 10 — annotations.generateDocs produces a portable site', () => {
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

        await withDismissedDocumentationNotifications(async () => {
            await vscode.commands.executeCommand('annotations.generateDocs');
        });
        await delay(300);

        for (const f of [
            'toc.yml',
            'index.md',
            'by-type.md',
            'by-file.md',
            'links.md',
            'site.config.json',
            'site.manifest.json',
            'site.navigation.json',
            'documentation-report.json',
            '.ooci-docs-manifest.json',
            path.join('html', 'index.html'),
            path.join('openapi', 'openapi.json'),
            path.join('wiki', 'hosted', 'Home.md'),
        ]) {
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

    test('doc:* tagged annotations assemble an authored API page with signatures and wiki-links', async function () {
        this.timeout(30000);

        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot10-svc.ts'));
        const source =
            '// module header line\n' +
            'export class UserService {\n' +
            '    async createUser(name: string): Promise<string> {\n' +
            "        return name + '-id';\n" +
            '    }\n' +
            '}\n';
        await vscode.workspace.fs.writeFile(uri, Buffer.from(source, 'utf8'));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(300);

        await vscode.commands.executeCommand('annotations.add', {
            line: 0,
            message: '# User module\n\nEverything about users. See [[UserService]].',
            tags: ['doc:module'],
        });
        await delay(200);
        await vscode.commands.executeCommand('annotations.add', {
            line: 1,
            message: '# UserService\n\nManages user accounts.',
            tags: ['doc:class'],
        });
        await delay(200);
        await vscode.commands.executeCommand('annotations.add', {
            line: 2,
            message: '# createUser\n\nCreates a user.',
            tags: ['doc:function'],
        });
        await delay(600);

        await withDismissedDocumentationNotifications(async () => {
            await vscode.commands.executeCommand('annotations.generateDocs');
        });
        await delay(300);

        const apiPage = path.join(docsDir(), 'api', 'lot10-svc-ts.md');
        assert.ok(fs.existsSync(apiPage), 'api page must be generated for the documented file');
        const api = fs.readFileSync(apiPage, 'utf8');
        assert.ok(api.startsWith('# User module'), 'module annotation heads the portable conceptual page');
        assert.ok(api.includes('## UserService'), 'class section');
        assert.ok(api.includes('### createUser'), 'function nested under the class');
        assert.ok(api.includes('export class UserService {'), 'class signature extracted from the anchored line');
        assert.ok(api.includes('[UserService](lot10-svc-ts.md#ann-'), 'wiki-link resolved to the class anchor');

        const manifest = JSON.parse(fs.readFileSync(path.join(docsDir(), 'site.manifest.json'), 'utf8')) as {
            pages: { id: string; path: string }[];
        };
        assert.ok(
            manifest.pages.some((page) => page.id === 'ooci.api.lot10-svc-ts' && page.path === 'api/lot10-svc-ts.md'),
            'the portable manifest gives the conceptual page a stable identifier'
        );

        const toc = fs.readFileSync(path.join(docsDir(), 'toc.yml'), 'utf8');
        assert.ok(toc.includes('href: api/lot10-svc-ts.md'), 'toc must reference the api page');
    });

    test('empty-store regeneration removes stale managed pages but preserves unrelated files', async function () {
        // This regression intentionally performs two complete multi-format
        // generations (populated, then empty) plus an atomic manifest cleanup.
        // A measured isolated double pass takes about 50 s on Windows while
        // filesystem scanning is active. Give that real workload 40 s of
        // contention headroom: if Mocha times out first it cannot cancel the
        // command, and the orphaned writer would corrupt later test timings.
        // Ordinary single-generation tests retain their strict 30 s budget.
        this.timeout(90000);
        const uri = vscode.Uri.file(path.join(workspaceRoot(), 'lot10-stale.ts'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from('export class Stale {}\n', 'utf8'));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(200);
        await vscode.commands.executeCommand('annotations.add', {
            line: 0,
            message: '# Stale reference',
            tags: ['doc:class'],
        });
        await delay(500);

        await withDismissedDocumentationNotifications(async () => {
            await vscode.commands.executeCommand('annotations.generateDocs');
            const stalePage = path.join(docsDir(), 'api', 'lot10-stale-ts.md');
            assert.ok(fs.existsSync(stalePage));
            const unrelated = path.join(docsDir(), 'team-owned-notes.md');
            fs.writeFileSync(unrelated, '# Keep me\n', 'utf8');

            await clearAllAnnotationsViaCommand();
            await delay(300);
            await vscode.commands.executeCommand('annotations.generateDocs');

            assert.ok(!fs.existsSync(stalePage), 'previously managed authored page is removed');
            assert.ok(fs.existsSync(unrelated), 'unmanaged team file is preserved');
            assert.ok(
                fs.readFileSync(path.join(docsDir(), 'index.md'), 'utf8').includes('**0** annotation(s)'),
                'empty portal replaces stale counts'
            );
        });
    });
});
