// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    createDocumentationManifest,
    DOCUMENTATION_MANIFEST_FILE,
    serializeDocumentationManifest,
    type DocumentationManifestOptions,
} from '../../docs/DocumentationManifest';
import {
    DOCUMENTATION_TRANSACTION_DIRECTORY,
    DocumentationTransactionError,
    writeDocumentationBundle,
} from '../../docs/WorkspaceDocumentationWriter';
import { createStaticSiteBundle } from '../../docs/DocumentationBundles';

interface Fingerprint {
    sha256: string;
    bytes: number;
}

const OPTIONS: DocumentationManifestOptions = {
    generatorVersion: 'writer-security-test',
    template: 'test',
    formats: ['markdown'],
    generatedAt: '2026-07-13T00:00:00.000Z',
};

// These scenarios execute two complete atomic writer transactions and, for
// recovery cases, an additional journal rollback. On a contended Windows
// filesystem that legitimately exceeds Mocha's 20 s default. A timeout does
// not cancel workspace.fs promises, so use a bounded budget that lets their
// cleanup finish instead of leaking an orphaned writer into following tests.
const MULTI_TRANSACTION_TIMEOUT_MS = 60_000;

function workspaceRoot(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'a workspace folder must be open during tests');
    return folders[0].uri;
}

function fingerprint(content: string | Buffer): Fingerprint {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
    };
}

function outputUri(name: string): vscode.Uri {
    return vscode.Uri.joinPath(workspaceRoot(), '.writer-security-tests', name);
}

function remove(uri: vscode.Uri): void {
    fs.rmSync(uri.fsPath, { recursive: true, force: true });
}

function simulateInterruptedInstall(output: vscode.Uri, nextContent: string): void {
    const guidePath = path.join(output.fsPath, 'guide.md');
    const manifestPath = path.join(output.fsPath, DOCUMENTATION_MANIFEST_FILE);
    const previousGuide = fs.readFileSync(guidePath);
    const previousManifest = fs.readFileSync(manifestPath);
    const nextFiles = new Map([['guide.md', nextContent]]);
    const nextManifest = serializeDocumentationManifest(createDocumentationManifest(nextFiles, OPTIONS));
    const transaction = path.join(output.fsPath, DOCUMENTATION_TRANSACTION_DIRECTORY);
    const backup = path.join(transaction, 'backup');
    fs.mkdirSync(backup, { recursive: true });
    const journal = {
        schemaVersion: 1,
        writer: 'out-of-code-insights',
        outputUri: output.toString(),
        files: [
            {
                path: 'guide.md',
                previous: fingerprint(previousGuide),
                next: fingerprint(nextContent),
            },
            {
                path: DOCUMENTATION_MANIFEST_FILE,
                previous: fingerprint(previousManifest),
                next: fingerprint(nextManifest),
            },
        ],
    };
    fs.writeFileSync(path.join(transaction, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    fs.renameSync(guidePath, path.join(backup, 'guide.md'));
    fs.renameSync(manifestPath, path.join(backup, DOCUMENTATION_MANIFEST_FILE));
    fs.writeFileSync(guidePath, nextContent, 'utf8');
}

suite('WorkspaceDocumentationWriter security and recovery', () => {
    const created: vscode.Uri[] = [];

    teardown(() => {
        for (const uri of created.splice(0)) {
            remove(uri);
        }
    });

    test('rejects an output outside the selected workspace before creating it', async () => {
        const root = workspaceRoot();
        const escaped = vscode.Uri.file(path.join(path.dirname(root.fsPath), `ooci-writer-escape-${randomUUID()}`));
        await assert.rejects(
            writeDocumentationBundle(root, escaped, new Map([['guide.md', '# no\n']]), OPTIONS),
            /escapes the selected workspace/i
        );
        assert.strictEqual(fs.existsSync(escaped.fsPath), false);
    });

    test('rejects an output that crosses a symbolic link or junction', async function () {
        const root = workspaceRoot();
        const container = outputUri(`symlink-${randomUUID()}`);
        const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ooci-writer-target-'));
        created.push(container);
        fs.mkdirSync(container.fsPath, { recursive: true });
        const link = path.join(container.fsPath, 'linked-output');
        try {
            fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            fs.rmSync(external, { recursive: true, force: true });
            this.skip();
            return;
        }
        try {
            await assert.rejects(
                writeDocumentationBundle(root, vscode.Uri.file(link), new Map([['guide.md', '# no\n']]), OPTIONS),
                /symbolic link|junction/i
            );
            assert.deepStrictEqual(fs.readdirSync(external), []);
        } finally {
            // Remove the reparse point while its target still exists. On
            // Windows, deleting the target first can leave a broken junction
            // that recursive cleanup and TypeScript file discovery cannot
            // traverse reliably.
            try {
                fs.unlinkSync(link);
            } catch {
                // Best effort: suite teardown still removes the container.
            }
            fs.rmSync(external, { recursive: true, force: true });
        }
    });

    test('deterministically rolls back an interrupted install before starting the next generation', async function () {
        this.timeout(MULTI_TRANSACTION_TIMEOUT_MS);
        const root = workspaceRoot();
        const output = outputUri(`rollback-${randomUUID()}`);
        created.push(output);
        await writeDocumentationBundle(root, output, new Map([['guide.md', '# previous\n']]), OPTIONS);
        simulateInterruptedInstall(output, '# interrupted\n');

        const result = await writeDocumentationBundle(root, output, new Map([['guide.md', '# final\n']]), OPTIONS);

        assert.ok(result.warnings.some((warning) => /rolled back an interrupted/i.test(warning)));
        assert.strictEqual(fs.readFileSync(path.join(output.fsPath, 'guide.md'), 'utf8'), '# final\n');
        assert.strictEqual(fs.existsSync(path.join(output.fsPath, DOCUMENTATION_TRANSACTION_DIRECTORY)), false);
    });

    test('removes an obsolete managed engine config when regenerating a portable static bundle', async function () {
        this.timeout(MULTI_TRANSACTION_TIMEOUT_MS);
        const root = workspaceRoot();
        const output = outputUri(`portable-migration-${randomUUID()}`);
        const obsoleteConfig = `${'doc'}${'fx'}.json`;
        created.push(output);
        await writeDocumentationBundle(
            root,
            output,
            new Map([
                ['index.md', '# Previous\n'],
                [obsoleteConfig, '{"legacy":true}\n'],
            ]),
            OPTIONS
        );

        const portable = createStaticSiteBundle(
            new Map([
                ['index.md', '# Current\n'],
                ['toc.yml', '- name: Current\n  href: index.md\n'],
            ])
        );
        const result = await writeDocumentationBundle(root, output, portable.files, {
            ...OPTIONS,
            formats: ['static-site'],
        });

        assert.strictEqual(fs.existsSync(path.join(output.fsPath, obsoleteConfig)), false);
        assert.strictEqual(result.removed, 1);
        assert.ok(fs.existsSync(path.join(output.fsPath, 'site.config.json')));
        assert.ok(!result.warnings.join('\n').toLowerCase().includes(`${'doc'}${'fx'}`));
    });

    test('preserves a modified destination and aggregates rollback failures', async function () {
        this.timeout(MULTI_TRANSACTION_TIMEOUT_MS);
        const root = workspaceRoot();
        const output = outputUri(`modified-${randomUUID()}`);
        created.push(output);
        await writeDocumentationBundle(root, output, new Map([['guide.md', '# previous\n']]), OPTIONS);
        simulateInterruptedInstall(output, '# interrupted\n');
        fs.writeFileSync(path.join(output.fsPath, 'guide.md'), '# developer edit\n', 'utf8');

        let failure: unknown;
        try {
            await writeDocumentationBundle(root, output, new Map([['guide.md', '# later\n']]), OPTIONS);
        } catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof DocumentationTransactionError);
        assert.ok(failure.errors.length >= 2, 'independent rollback failures are retained');
        assert.strictEqual(fs.readFileSync(path.join(output.fsPath, 'guide.md'), 'utf8'), '# developer edit\n');
        assert.strictEqual(
            fs.readFileSync(
                path.join(output.fsPath, DOCUMENTATION_TRANSACTION_DIRECTORY, 'backup', 'guide.md'),
                'utf8'
            ),
            '# previous\n'
        );
    });
});
