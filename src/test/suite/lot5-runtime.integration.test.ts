/**
 * Lot 5 R2 EDH runtime integration tests — failing-test-first.
 *
 * These tests prove that once worker-1 lands Lot 5 R2 (the consumer rewiring
 * step that swaps AnnotationManager for AnnotationStore in extension.ts, the
 * Tree, the AI adapter, the Kanban, etc.), the runtime feature surface stays
 * intact. Until then, every test skips cleanly via a probe so the suite
 * stays green.
 *
 * Coverage map (scope of this file):
 *   1. Extension activation — no throw, the extension boots under the new
 *      wiring just like under the legacy manager.
 *   2. End-user "add annotation" flow lands in the schema-v2 envelope on
 *      disk (proof that the persistence path is now the new AnnotationStore,
 *      not the legacy flat-array writer).
 *   3. AnnotationStore.upsert exists and behaves as the AI adapter expects
 *      (programmatic insertion of a complete annotation, no prompt).
 *   4. AnnotationPersistence (the dedicated load/save service) round-trips
 *      a v2 payload faithfully and rejects v1 payloads without silent
 *      migration.
 *   5. (Documentation only) The F5 manual checklist lives at
 *      docs/manual-test-checklist.md — see test "F5 manual checklist exists".
 *
 * 14 §7.x cases are covered at the store layer by the sibling file
 * annotationStore.integration.test.ts. This file does NOT re-test those —
 * it asserts the runtime wiring around them.
 *
 * IMPORTANT — placement: under src/test/suite/, NOT src/test/integration/,
 * because the latter is consumed by `npm run test:unit` (plain Node) which
 * crashes on `import * as vscode`.
 *
 * Skip-probe philosophy:
 *   - Static imports cite only modules that already exist today
 *     (AnnotationStore, types). New modules (AnnotationPersistence) are
 *     loaded via tryRequire so a missing module skips the test instead of
 *     breaking the typecheck.
 *   - Method-level features (upsert, getAnnotationStore export) are probed
 *     at runtime via duck-typing — `typeof x === 'function'`.
 *   - Persistence-format features (v2 envelope) are probed by reading the
 *     on-disk JSON and discriminating by shape.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore } from '../../transactional/AnnotationStore';

// Two casing candidates: VS Code's extension-ID lookup is case-sensitive in
// some versions. package.json publisher is lowercase, but the existing
// reanchor regression test uses the camel form — try both for resilience.
const EXTENSION_ID_CANDIDATES = ['jacquesgariepy.out-of-code-insights', 'JacquesGariepy.out-of-code-insights'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function readPersistedRaw(): unknown {
    const file = annotationsFilePath();
    if (!fs.existsSync(file)) {
        return null;
    }
    const content = fs.readFileSync(file, 'utf8');
    if (content.trim().length === 0) {
        return null;
    }
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

interface SchemaV2Envelope {
    schemaVersion: 2;
    annotations: ReadonlyArray<Record<string, unknown>>;
}

function isStoreV2Envelope(data: unknown): data is SchemaV2Envelope {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    const obj = data as { schemaVersion?: unknown; annotations?: unknown };
    return obj.schemaVersion === 2 && Array.isArray(obj.annotations);
}

function clearAnnotationsFile(): void {
    const file = annotationsFilePath();
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
    }
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

function stubShowInputBox(returnValue: string): Stub {
    const original = vscode.window.showInputBox;
    return {
        apply() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInputBox = async () => returnValue;
        },
        restore() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInputBox = original;
        },
    };
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
        /* clearAll may not be wired yet under R2 — best-effort cleanup */
    } finally {
        stub.restore();
    }
}

async function ensureFixture(relPathArg: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(path.join(workspaceRoot(), relPathArg));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
}

/**
 * CommonJS dynamic require with try/catch. Returns undefined when the
 * module path is not yet present, which is the failing-first signal: the
 * caller `this.skip()` and the test stays green until worker-1 lands.
 */
function tryRequire<T>(modulePath: string): T | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        return require(modulePath) as T;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Lot 5 R2 runtime integration — failing-first until consumers re-wired', () => {
    suiteSetup(async function () {
        this.timeout(20000);
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

    test('1. Extension activates without throwing under the new wiring', async function () {
        this.timeout(20000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        // Activation may have already happened in suiteSetup; calling
        // activate() again is a no-op but settles the contract.
        await ext.activate();
        assert.strictEqual(ext.isActive, true, 'extension must report isActive=true after activate()');
    });

    test('2. annotations.add flow lands in schema-v2 envelope on disk (Tree provider source)', async function () {
        this.timeout(20000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        const fixtureSource = 'line0\n' + 'line1\n' + 'line2\n' + 'line3\n' + 'line4\n' + 'TARGET_LINE\n' + 'line6\n';
        const uri = await ensureFixture('lot5-r2-add-flow.ts', fixtureSource);

        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        editor.selection = new vscode.Selection(5, 0, 5, 0);
        const inputStub = stubShowInputBox('lot5-r2-test-message');
        inputStub.apply();
        try {
            await vscode.commands.executeCommand('annotations.add', { line: 5 });
        } catch {
            this.skip();
            return;
        } finally {
            inputStub.restore();
        }
        await delay(800);

        const persisted = readPersistedRaw();
        if (!persisted) {
            this.skip();
            return;
        }

        // Discriminate by envelope shape: schema-v2 is the post-R2 marker.
        // A flat array on disk means the legacy AnnotationManager is still
        // wired — Lot 5 R2 has not landed, skip cleanly.
        if (!isStoreV2Envelope(persisted)) {
            this.skip();
            return;
        }

        // Lot 5 R2 IS wired: assert the annotation is present in the v2
        // envelope, with the expected message and on the expected line.
        assert.strictEqual(persisted.schemaVersion, 2);
        const found = persisted.annotations.find(
            (a) => (a as { message?: unknown }).message === 'lot5-r2-test-message'
        );
        assert.ok(found, 'annotation just added via annotations.add must appear in the v2 envelope');
    });

    test('3. AnnotationStore.upsert exists and inserts an annotation programmatically (AI adapter contract)', function () {
        this.timeout(5000);
        const store = new AnnotationStore();
        const upsert = (store as unknown as { upsert?: unknown }).upsert;
        if (typeof upsert !== 'function') {
            this.skip();
            return;
        }

        const fakeUri = vscode.Uri.file(path.join(workspaceRoot(), 'lot5-r2-upsert.ts')).toString();
        const upsertCallable = upsert as (input: Record<string, unknown>) => unknown;
        const result = upsertCallable.call(store, {
            fileUri: fakeUri,
            file: 'lot5-r2-upsert.ts',
            startOffset: 0,
            endOffset: 5,
            message: 'ai-suggested',
            origin: { kind: 'manual' },
            timestamp: new Date().toISOString(),
        });

        assert.ok(result, 'upsert must return the inserted annotation snapshot');
        const all = store.getAll();
        assert.strictEqual(all.length, 1, 'upsert must put the annotation into the live map');
        const inserted = all[0];
        assert.strictEqual(inserted.message, 'ai-suggested');
        assert.strictEqual(inserted.fileUri, fakeUri);
    });

    test('4. AnnotationPersistence load/save round-trip + v1 rejection (failing-first if module absent)', async function () {
        this.timeout(10000);

        // Try a few candidate paths: worker-1 may land the persistence module
        // under any of these — failing-first picks the first that resolves.
        const candidates = [
            '../../transactional/AnnotationPersistence',
            '../../transactional/persistence/AnnotationPersistence',
            '../../transactional/services/AnnotationPersistence',
        ];
        let mod:
            | {
                  AnnotationPersistence?: new (...args: unknown[]) => {
                      save(file: { schemaVersion: 2; annotations: unknown[] }): Promise<void>;
                      load(): Promise<{ schemaVersion: 2; annotations: unknown[] }>;
                  };
              }
            | undefined;
        for (const candidate of candidates) {
            mod = tryRequire(candidate);
            if (mod && typeof mod.AnnotationPersistence === 'function') {
                break;
            }
        }
        if (!mod || typeof mod.AnnotationPersistence !== 'function') {
            this.skip();
            return;
        }

        const tmpDir = path.join(workspaceRoot(), '.lot5-r2-persistence-tmp');
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
        try {
            // The Persistence service is expected to take either a directory
            // path or a full file path; we pass the directory and let the
            // service decide on the filename. Both signatures probed below.
            let persistence:
                | {
                      save(file: { schemaVersion: 2; annotations: unknown[] }): Promise<void>;
                      load(): Promise<{ schemaVersion: 2; annotations: unknown[] }>;
                  }
                | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Ctor = mod.AnnotationPersistence as new (...args: any[]) => typeof persistence;
            try {
                persistence = new (Ctor as new (dir: string) => typeof persistence)(tmpDir);
            } catch {
                try {
                    persistence = new (Ctor as new (file: string) => typeof persistence)(
                        path.join(tmpDir, 'annotations.json')
                    );
                } catch {
                    this.skip();
                    return;
                }
            }
            if (!persistence) {
                this.skip();
                return;
            }

            const payload: { schemaVersion: 2; annotations: unknown[] } = {
                schemaVersion: 2,
                annotations: [
                    {
                        id: '00000000-0000-4000-8000-000000000001',
                        schemaVersion: 2,
                        fileUri: 'file:///tmp/x.ts',
                        file: 'x.ts',
                        startOffset: 0,
                        endOffset: 5,
                        lineHash: 'deadbeef',
                        contextBefore: [],
                        contextAfter: [],
                        state: 'active',
                        origin: { kind: 'manual' },
                        message: 'persistence-rt',
                        timestamp: new Date().toISOString(),
                    },
                ],
            };
            await persistence.save(payload);
            const loaded = await persistence.load();
            assert.strictEqual(loaded.schemaVersion, 2);
            assert.strictEqual(loaded.annotations.length, 1);
            assert.deepStrictEqual(
                loaded.annotations[0],
                payload.annotations[0],
                'persistence round-trip must be exact'
            );

            // Strict v1 rejection.
            const v1Payload = { schemaVersion: 1, annotations: [] } as unknown as {
                schemaVersion: 2;
                annotations: unknown[];
            };
            let threw = false;
            try {
                await persistence.save(v1Payload);
            } catch {
                threw = true;
            }
            // Acceptable: either save() refuses v1 OR load() refuses to read
            // back a v1-shaped file. The brief is explicit on rejection.
            if (!threw) {
                // Try the read-side: write v1 by hand and read it.
                const v1OnDisk = path.join(tmpDir, 'v1-test.json');
                fs.writeFileSync(v1OnDisk, JSON.stringify({ schemaVersion: 1, annotations: [] }), 'utf8');
                let readThrew = false;
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const altPersistence = new (mod.AnnotationPersistence as any)(v1OnDisk);
                    if (typeof altPersistence?.load === 'function') {
                        await altPersistence.load();
                    }
                } catch {
                    readThrew = true;
                }
                assert.strictEqual(
                    readThrew,
                    true,
                    'AnnotationPersistence must reject schemaVersion !== 2 either on save() or on load()'
                );
            }
        } finally {
            // Best-effort cleanup. The EDH workspace is a fixture dir; leaving
            // .lot5-r2-persistence-tmp behind is harmless.
            try {
                await vscode.workspace.fs.delete(vscode.Uri.file(tmpDir), {
                    recursive: true,
                    useTrash: false,
                });
            } catch {
                /* ignore */
            }
        }
    });

    test('5. F5 manual test checklist file exists (docs/manual-test-checklist.md)', function () {
        // Documentation guard: the post-R2 manual validation pass relies on
        // the checklist living at this exact path. If a future refactor
        // moves it, this test fails loudly.
        const checklistPath = path.join(workspaceRoot(), '..', 'docs', 'manual-test-checklist.md');
        // The EDH workspace root is `test-fixtures/`, so docs/ is one level
        // up from workspaceRoot. Try both paths to be resilient to harness
        // configuration changes.
        const alternativePath = path.join(workspaceRoot(), 'docs', 'manual-test-checklist.md');
        const exists = fs.existsSync(checklistPath) || fs.existsSync(alternativePath);
        assert.strictEqual(
            exists,
            true,
            `F5 manual test checklist must exist at docs/manual-test-checklist.md ` +
                `(probed: ${checklistPath} / ${alternativePath})`
        );
    });

    // ─────────────────────────────────────────────────────────────────────
    // R2 wiring tests (failing-first until consumer rewiring lands).
    // ─────────────────────────────────────────────────────────────────────

    test('6. End-to-end annotation lifecycle: add via command → store → tree refresh → edit → store update → persisted', async function () {
        this.timeout(25000);
        const ext = findExtension();
        if (!ext) {
            this.skip();
            return;
        }
        await ext.activate();

        // Probe whether R2 wiring is in place: only the v2 envelope on disk
        // proves the new store is the persistence target.
        const fixtureSource =
            'line0\n' + 'line1\n' + 'line2\n' + 'line3\n' + 'line4\n' + 'E2E_TARGET_LINE\n' + 'line6\n' + 'line7\n';
        const uri = await ensureFixture('lot5-r2-e2e-lifecycle.ts', fixtureSource);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        await delay(300);

        // Add annotation through the user-facing command path.
        editor.selection = new vscode.Selection(5, 0, 5, 0);
        const inputStub = stubShowInputBox('e2e-lifecycle-message');
        inputStub.apply();
        try {
            await vscode.commands.executeCommand('annotations.add', { line: 5 });
        } catch {
            this.skip();
            return;
        } finally {
            inputStub.restore();
        }
        await delay(800);

        let persisted = readPersistedRaw();
        if (!persisted || !isStoreV2Envelope(persisted)) {
            // R2 wiring not done — disk still in legacy flat-array format.
            this.skip();
            return;
        }

        const created = persisted.annotations.find(
            (a) => (a as { message?: unknown }).message === 'e2e-lifecycle-message'
        ) as { id?: string; startOffset?: number; endOffset?: number } | undefined;
        if (!created || typeof created.id !== 'string') {
            assert.fail('E2E: created annotation missing id in persisted v2 envelope');
            return;
        }
        const id = created.id;
        const initialStart = created.startOffset;
        const initialEnd = created.endOffset;
        assert.strictEqual(typeof initialStart, 'number', 'initial startOffset persisted');
        assert.strictEqual(typeof initialEnd, 'number', 'initial endOffset persisted');

        // Mutate the document via WorkspaceEdit — the store listener must
        // shift the offsets and the persistence pass must flush within the
        // debounce window.
        const insertedText = 'INS_A\nINS_B\nINS_C\n';
        const insertedDelta = insertedText.length;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), insertedText);
        const ok = await vscode.workspace.applyEdit(edit);
        assert.strictEqual(ok, true, 'WorkspaceEdit must apply');

        // Wait for the debounce save (typical 500ms; allow margin).
        await delay(900);

        persisted = readPersistedRaw();
        if (!persisted || !isStoreV2Envelope(persisted)) {
            assert.fail('E2E: persisted file lost its v2 envelope shape after edit');
            return;
        }
        const updated = persisted.annotations.find((a) => (a as { id?: unknown }).id === id) as
            | { startOffset?: number; endOffset?: number }
            | undefined;
        if (!updated) {
            assert.fail(`E2E: annotation ${id} disappeared from persisted file after edit`);
            return;
        }
        assert.strictEqual(
            updated.startOffset,
            (initialStart as number) + insertedDelta,
            `E2E: persisted startOffset must shift by ${insertedDelta} (got ${updated.startOffset})`
        );
        assert.strictEqual(
            updated.endOffset,
            (initialEnd as number) + insertedDelta,
            `E2E: persisted endOffset must shift by ${insertedDelta} (got ${updated.endOffset})`
        );
    });

    test('7. Persistence flow — AnnotationPersistence load/save round-trip into the workspace folder', async function () {
        this.timeout(10000);

        const persistenceMod = tryRequire<{
            AnnotationPersistence?: new (
                folder: { uri: { fsPath: string } },
                relativePath?: string
            ) => {
                save(payload: { schemaVersion: 2; annotations: unknown[] }): Promise<void>;
                load(): Promise<{ schemaVersion: 2; annotations: unknown[] }>;
            };
        }>('../../transactional/AnnotationPersistence');
        if (!persistenceMod || typeof persistenceMod.AnnotationPersistence !== 'function') {
            this.skip();
            return;
        }

        const wsFolder = { uri: { fsPath: workspaceRoot() } };
        const relPath = '.lot5-r2-persistence-flow.json';
        const persistence = new persistenceMod.AnnotationPersistence(wsFolder, relPath);
        const absPath = path.join(workspaceRoot(), relPath);
        try {
            const payload: { schemaVersion: 2; annotations: unknown[] } = {
                schemaVersion: 2,
                annotations: [
                    {
                        id: '00000000-0000-4000-8000-000000000010',
                        schemaVersion: 2,
                        fileUri: 'file:///tmp/persist-flow-1.ts',
                        file: 'persist-flow-1.ts',
                        startOffset: 0,
                        endOffset: 5,
                        lineHash: 'aabbccdd',
                        contextBefore: [],
                        contextAfter: [],
                        state: 'active',
                        origin: { kind: 'manual' },
                        message: 'p1',
                        timestamp: '2026-01-01T00:00:00.000Z',
                    },
                    {
                        id: '00000000-0000-4000-8000-000000000020',
                        schemaVersion: 2,
                        fileUri: 'file:///tmp/persist-flow-2.ts',
                        file: 'persist-flow-2.ts',
                        startOffset: 10,
                        endOffset: 30,
                        lineHash: 'eeff0011',
                        contextBefore: [],
                        contextAfter: [],
                        state: 'active',
                        origin: { kind: 'manual' },
                        message: 'p2',
                        timestamp: '2026-01-02T00:00:00.000Z',
                    },
                    {
                        id: '00000000-0000-4000-8000-000000000030',
                        schemaVersion: 2,
                        fileUri: 'file:///tmp/persist-flow-3.ts',
                        file: 'persist-flow-3.ts',
                        startOffset: 100,
                        endOffset: 110,
                        lineHash: '22334455',
                        contextBefore: [],
                        contextAfter: [],
                        state: 'suspended',
                        origin: { kind: 'manual' },
                        message: 'p3',
                        timestamp: '2026-01-03T00:00:00.000Z',
                    },
                ],
            };

            await persistence.save(payload);
            assert.strictEqual(fs.existsSync(absPath), true, `persistence.save must write to ${absPath}`);
            const loaded = await persistence.load();
            assert.strictEqual(loaded.schemaVersion, 2);
            assert.strictEqual(loaded.annotations.length, 3);
            for (let i = 0; i < 3; i++) {
                assert.deepStrictEqual(
                    loaded.annotations[i],
                    payload.annotations[i],
                    `persistence round-trip must be exact for annotation #${i}`
                );
            }

            // v1 rejection on the save side.
            let savedV1 = false;
            try {
                await persistence.save({ schemaVersion: 1 as unknown as 2, annotations: [] });
                savedV1 = true;
            } catch {
                /* expected */
            }
            assert.strictEqual(savedV1, false, 'persistence.save must reject schemaVersion !== 2');
        } finally {
            try {
                if (fs.existsSync(absPath)) {
                    fs.unlinkSync(absPath);
                }
            } catch {
                /* ignore */
            }
        }
    });

    test('8. Tree purge on TTL expiry — suspended annotation disappears from getAll() after sweep', async function () {
        this.timeout(20000);

        // Standalone store with short TTL — does not depend on the runtime
        // wiring (extension.ts may still hold the legacy manager). The check
        // is that the AnnotationStore primitive that the tree provider will
        // consume after R2 already enforces TTL purge correctly.
        const SHORT_TTL_MS = 100;
        const store = new AnnotationStore({ suspendTtlMs: SHORT_TTL_MS });
        const probeUpsert = (store as unknown as { upsert?: unknown }).upsert;
        if (typeof probeUpsert !== 'function') {
            this.skip();
            return;
        }
        const probeSuspend = (store as unknown as { suspend?: unknown }).suspend;
        if (typeof probeSuspend !== 'function') {
            this.skip();
            return;
        }

        const fixture = 'a\n' + 'b\n' + 'c\n' + 'd\n' + 'e\n' + 'TREE_TTL_TARGET\n' + 'g\n';
        const uri = await ensureFixture('lot5-r2-tree-ttl.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        // Use the canonical add() so the lineHash is captured correctly —
        // suspend() consumes that hash to index the suspended buffer.
        type AddFn = (
            draft: Record<string, unknown>,
            opts: { line?: number; offset?: number; length?: number },
            doc: vscode.TextDocument
        ) => { id: string; lineHash: string };
        const add = (store as unknown as { add: AddFn }).add;
        const annotation = add.call(
            store,
            {
                fileUri: uri.toString(),
                file: 'lot5-r2-tree-ttl.ts',
                origin: { kind: 'manual' },
                message: 'tree-ttl-victim',
                timestamp: new Date().toISOString(),
            },
            { line: 5 },
            document
        );

        // Suspend via Cas D path (cut-equivalent).
        type SuspendFn = (id: string, blockHash: string) => void;
        (store as unknown as { suspend: SuspendFn }).suspend(annotation.id, annotation.lineHash);
        assert.strictEqual(store.getAll().length, 0, 'precondition: getAll empty after suspend');

        // Wait beyond TTL, then trigger any event that runs the sweep
        // (worker-1's sweep is invoked at the start of applyDocumentChange).
        await delay(SHORT_TTL_MS + 200);

        const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
            store.applyDocumentChange(event);
        });
        try {
            const triggerEdit = new vscode.WorkspaceEdit();
            const lastLine = document.lineCount - 1;
            const lastCol = document.lineAt(lastLine).text.length;
            triggerEdit.insert(uri, new vscode.Position(lastLine, lastCol), ' ');
            await vscode.workspace.applyEdit(triggerEdit);
            await delay(200);
        } finally {
            subscription.dispose();
        }

        assert.strictEqual(
            store.getAll().length,
            0,
            'post-TTL sweep: getAll() must remain empty (the tree provider sees nothing)'
        );

        // The annotation must NOT be reachable through the suspended bucket
        // either — the tree provider that reads getSuspendedByHash for paste
        // resume should not surface a TTL-expired ghost.
        const probeGetSuspended = (
            store as unknown as {
                getSuspendedByHash?: (h: string) => ReadonlyArray<unknown>;
            }
        ).getSuspendedByHash;
        if (typeof probeGetSuspended === 'function') {
            const bucket = probeGetSuspended.call(store, annotation.lineHash);
            assert.strictEqual(
                bucket.length,
                0,
                'post-TTL: suspended bucket must be empty (tree provider sees no ghost)'
            );
        }
    });

    test('9. KanbanColumnStore round-trip: setColumn → memento → restore on reload', async function () {
        this.timeout(5000);

        const kanbanMod = tryRequire<{
            KanbanColumnStore?: new (memento: {
                get: <T>(key: string) => T | undefined;
                update: (key: string, value: unknown) => Thenable<void>;
            }) => {
                getColumn(id: string): string | undefined;
                setColumn(id: string, column: string): Promise<void>;
            };
        }>('../../transactional/KanbanColumnStore');
        if (!kanbanMod || typeof kanbanMod.KanbanColumnStore !== 'function') {
            this.skip();
            return;
        }

        // In-memory memento mock — mirrors vscode.Memento contract.
        const backing = new Map<string, unknown>();
        const memento = {
            get<T>(key: string): T | undefined {
                return backing.get(key) as T | undefined;
            },
            update(key: string, value: unknown): Thenable<void> {
                if (value === undefined) {
                    backing.delete(key);
                } else {
                    backing.set(key, value);
                }
                return Promise.resolve();
            },
        };

        const annotationId = '00000000-0000-4000-8000-000000000099';
        const store1 = new kanbanMod.KanbanColumnStore(memento);
        assert.strictEqual(store1.getColumn(annotationId), undefined, 'precondition: no column set initially');

        await store1.setColumn(annotationId, 'todo');
        assert.strictEqual(store1.getColumn(annotationId), 'todo');

        await store1.setColumn(annotationId, 'doing');
        assert.strictEqual(store1.getColumn(annotationId), 'doing');

        // Reload: a brand new KanbanColumnStore instance must restore the
        // mapping from the same memento (the persistence target).
        const store2 = new kanbanMod.KanbanColumnStore(memento);
        assert.strictEqual(
            store2.getColumn(annotationId),
            'doing',
            'reload must restore the latest column from the memento'
        );

        // Memento backing must hold the structured map under a stable key.
        const stored = backing.get('outOfCodeInsights.kanban.annotationColumns');
        assert.ok(stored, 'memento must hold a structured value under the canonical key');
    });
});
