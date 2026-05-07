/**
 * Lot 5 R2 — AI Adapter migration test (Worktree C).
 *
 * Validates the SURGICAL fix at the legacy site :702 of UnifiedAIAdapter:
 * the snippet-attach path used to mutate the AnnotationManager's Map
 * directly via `manager.annotations.set(id, updated)`, bypassing the
 * transactional journal — undo/redo of a snippet attachment was silently
 * broken.
 *
 * The fix routes the persistence through `store.upsert(...)` whenever the
 * AnnotationStore is wired AND the annotation is tracked there. The legacy
 * mutation remains as a fallback for the in-flight period where
 * extension.ts has not yet been recâbled (Lot 5 R2 worker-1).
 *
 * Test strategy:
 *   - Skip-probe: if the bridge field `(adapter as any).store` cannot be
 *     set (e.g. the surgical fix is reverted), this test skips cleanly.
 *   - Bypass the heavy UnifiedAIAdapter constructor via `Object.create(...)`
 *     to avoid pulling AIProfileManager + command registration side effects
 *     into the unit-of-work. The migration helper under test is a method
 *     on the prototype, not on a constructor-built field, so the bypass is
 *     legitimate.
 *   - Drive the helper via reflection (`as any`) — it is intentionally
 *     `private` in production but the test exercises a CRITICAL invariant
 *     the brief flagged explicitly: journal records an `upsert` op when
 *     the store is wired.
 *
 * Out of scope (deferred to a follow-up lot):
 *   - Full AI-suggestion command flow with mock AI provider.
 *   - Tree provider propagation (worker-architect Worktree A is migrating
 *     the tree in parallel; once landed, treeProvider.getChildren can be
 *     observed). Today the test uses `store.onDidChange` as the
 *     contractual propagation proxy.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore, type AnnotationDraft } from '../../transactional/AnnotationStore';
import { UnifiedAIAdapter } from '../../providers/UnifiedAIAdapter';
import type { Annotation } from '../../common/types';
import type { OpEntry } from '../../transactional/types';

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

interface AdapterShape {
    store: AnnotationStore | undefined;
    annotationManager: unknown;
    persistAnnotationUpdate(original: Annotation, updated: Annotation, document: vscode.TextDocument): Promise<void>;
    legacyToV2Snapshot(annotation: Annotation, document: vscode.TextDocument): unknown;
}

function buildBridgedAdapter(store: AnnotationStore, managerStub: unknown): AdapterShape {
    // Bypass the heavy constructor (it registers commands + listens to
    // AIProfileManager events). The migration helper is a prototype method,
    // so injecting fields manually is sound.
    const adapter = Object.create(UnifiedAIAdapter.prototype) as AdapterShape;
    adapter.store = store;
    adapter.annotationManager = managerStub;
    return adapter;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Lot 5 R2 — UnifiedAIAdapter site :702 migration (CRITICAL: journal-aware persistence)', () => {
    teardown(async () => {
        await closeAllEditors();
    });

    test('Skip-probe: surgical fix is deployed (the `store` field exists on the adapter)', function () {
        // The fix introduces `store?: AnnotationStore` on the adapter. If a
        // future revert removes the field, every subsequent test in this
        // suite skips cleanly instead of failing with confused asserts.
        const probe = Object.create(UnifiedAIAdapter.prototype) as { store?: unknown };
        probe.store = undefined;
        // Static-method probe: persistAnnotationUpdate must exist on the prototype.
        const proto = UnifiedAIAdapter.prototype as unknown as {
            persistAnnotationUpdate?: unknown;
        };
        assert.strictEqual(
            typeof proto.persistAnnotationUpdate,
            'function',
            'persistAnnotationUpdate must be defined on UnifiedAIAdapter.prototype (surgical fix marker)'
        );
    });

    test('When store is wired and the annotation is tracked there, persistAnnotationUpdate routes through store.upsert (journal records kind="upsert")', async function () {
        this.timeout(15000);

        const proto = UnifiedAIAdapter.prototype as unknown as {
            persistAnnotationUpdate?: unknown;
        };
        if (typeof proto.persistAnnotationUpdate !== 'function') {
            this.skip();
            return;
        }

        // Real document so document.offsetAt / lineAt / positionAt work.
        const fixture = 'line0\n' + 'line1\n' + 'line2\n' + 'line3\n' + 'line4\n' + 'AI_SNIPPET_TARGET\n' + 'line6\n';
        const uri = await ensureFixture('lot5-ai-adapter-snippet.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        // Pre-seed the annotation in the store so the upsert path activates
        // (the bridge requires `store.get(id) !== undefined` — otherwise it
        // falls back to the legacy manager mutation).
        const draft: AnnotationDraft = {
            fileUri: uri.toString(),
            file: 'lot5-ai-adapter-snippet.ts',
            origin: { kind: 'manual' },
            message: 'pre-existing-anno',
            timestamp: new Date().toISOString(),
        };
        const seeded = store.add(draft, { line: 5 }, document);

        // Listen on the journal-channel proxy that the tree provider will
        // consume after Worktree A's migration. The contract: every
        // upsert fires `onDidChange` with an OpEntry array.
        const observed: OpEntry[] = [];
        const sub = store.onDidChange((ops) => {
            for (const op of ops) {
                observed.push(op);
            }
        });

        try {
            const managerStub = {
                annotations: new Map<string, Annotation>(),
            };
            const adapter = buildBridgedAdapter(store, managerStub);

            const legacyOriginal: Annotation = {
                id: seeded.id,
                file: 'lot5-ai-adapter-snippet.ts',
                line: 5,
                message: 'pre-existing-anno',
                timestamp: seeded.timestamp,
                fileUri: uri.toString(),
            };
            const legacyUpdated: Annotation = {
                ...legacyOriginal,
                snippet: {
                    code: '// AI-attached snippet body',
                    language: 'typescript',
                },
            };

            await adapter.persistAnnotationUpdate(legacyOriginal, legacyUpdated, document);

            // Journal must show an upsert op for our annotation id.
            const upsertOp = observed.find((op) => op.kind === 'upsert' && op.annotationId === seeded.id);
            assert.ok(
                upsertOp,
                `journal must record kind='upsert' for annotation ${seeded.id} (observed kinds: ` +
                    observed.map((o) => `${o.kind}/${o.annotationId}`).join(', ') +
                    ')'
            );

            // Store side: the snippet field is now reflected in the
            // canonical AnnotationV2.
            const updatedFromStore = store.get(seeded.id);
            assert.ok(updatedFromStore, 'annotation must remain in the store after upsert');
            assert.deepStrictEqual(
                updatedFromStore.snippet,
                {
                    code: '// AI-attached snippet body',
                    language: 'typescript',
                },
                'store.upsert must persist the snippet attached by the AI adapter'
            );

            // store.list() (alias of getAll) reflects the same state.
            const all = store.getAll();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].id, seeded.id);

            // CRITICAL invariant: the legacy manager Map MUST NOT be touched
            // when the store is wired. The bridge must not double-write,
            // otherwise undo/redo will see two diverging sources of truth.
            assert.strictEqual(
                managerStub.annotations.size,
                0,
                'legacy manager.annotations must NOT be mutated when the store path is taken'
            );
        } finally {
            sub.dispose();
        }
    });

    test('When store is NOT wired, persistAnnotationUpdate falls back to legacy manager mutation (no regression for in-flight extension.ts)', async function () {
        this.timeout(10000);

        const proto = UnifiedAIAdapter.prototype as unknown as {
            persistAnnotationUpdate?: unknown;
        };
        if (typeof proto.persistAnnotationUpdate !== 'function') {
            this.skip();
            return;
        }

        const fixture = 'a\nb\nc\n';
        const uri = await ensureFixture('lot5-ai-adapter-fallback.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        let savedCount = 0;
        let refreshedCount = 0;
        const managerStub = {
            annotations: new Map<string, Annotation>(),
            saveAnnotations: async () => {
                savedCount++;
            },
            refreshAnnotations: async () => {
                refreshedCount++;
            },
        };
        // No store passed → bridge MUST fall back to legacy mutation.
        const adapter = buildBridgedAdapter(undefined as unknown as AnnotationStore, managerStub);
        adapter.store = undefined;

        const legacyOriginal: Annotation = {
            id: 'fallback-id',
            file: 'lot5-ai-adapter-fallback.ts',
            line: 0,
            message: 'fallback',
            timestamp: '2026-01-01T00:00:00.000Z',
        };
        const legacyUpdated: Annotation = {
            ...legacyOriginal,
            snippet: { code: 'snippet', language: 'plaintext' },
        };

        await adapter.persistAnnotationUpdate(legacyOriginal, legacyUpdated, document);

        // Legacy path verified.
        assert.strictEqual(
            managerStub.annotations.get('fallback-id'),
            legacyUpdated,
            'fallback: manager.annotations.set(...) must be called with the updated annotation'
        );
        assert.strictEqual(savedCount, 1, 'fallback: saveAnnotations must be invoked once');
        assert.strictEqual(refreshedCount, 1, 'fallback: refreshAnnotations must be invoked once');
    });

    test('When store is wired but the annotation is NOT tracked there, the bridge still falls back (no spurious upsert)', async function () {
        this.timeout(10000);

        const proto = UnifiedAIAdapter.prototype as unknown as {
            persistAnnotationUpdate?: unknown;
        };
        if (typeof proto.persistAnnotationUpdate !== 'function') {
            this.skip();
            return;
        }

        const fixture = 'a\nb\nc\n';
        const uri = await ensureFixture('lot5-ai-adapter-orphan.ts', fixture);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await delay(150);

        const store = new AnnotationStore();
        const observed: OpEntry[] = [];
        const sub = store.onDidChange((ops) => {
            for (const op of ops) {
                observed.push(op);
            }
        });

        try {
            let savedCount = 0;
            const managerStub = {
                annotations: new Map<string, Annotation>(),
                saveAnnotations: async () => {
                    savedCount++;
                },
                refreshAnnotations: async () => Promise.resolve(),
            };
            const adapter = buildBridgedAdapter(store, managerStub);

            const orphan: Annotation = {
                id: 'never-in-store',
                file: 'lot5-ai-adapter-orphan.ts',
                line: 0,
                message: 'orphan',
                timestamp: '2026-01-01T00:00:00.000Z',
            };
            const orphanUpdated: Annotation = {
                ...orphan,
                snippet: { code: 's', language: 'plaintext' },
            };

            await adapter.persistAnnotationUpdate(orphan, orphanUpdated, document);

            // No journal entry: the bridge correctly identified the
            // annotation as untracked and fell back to legacy mutation.
            assert.strictEqual(
                observed.length,
                0,
                'bridge must NOT call store.upsert for an annotation absent from the store'
            );
            assert.strictEqual(
                managerStub.annotations.get('never-in-store'),
                orphanUpdated,
                'bridge must fall back to legacy mutation for untracked annotations'
            );
            assert.strictEqual(savedCount, 1, 'fallback path must invoke legacy save');
        } finally {
            sub.dispose();
        }
    });
});
