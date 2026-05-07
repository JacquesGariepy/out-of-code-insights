// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { AnnotationNavigation, type NavigationStackLike, type NavigationVsCodeApi } from '../AnnotationNavigation';
import { AnnotationStore } from '../AnnotationStore';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationV2 } from '../types';

function fakeAnnotation(id: string): AnnotationV2 {
    return {
        id,
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        fileUri: 'file:///x.ts',
        file: 'x.ts',
        startOffset: 42,
        endOffset: 50,
        lineHash: '5b8a91e0',
        contextBefore: [],
        contextAfter: [],
        state: 'active',
        origin: { kind: 'manual' },
        message: 'demo',
        timestamp: '2026-05-06T12:00:00.000Z',
    };
}

function makeStack(): NavigationStackLike & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        push: (id: string) => {
            calls.push(id);
        },
    };
}

function makeApi(): NavigationVsCodeApi & {
    openCalls: Array<{ uri: string; offset: number }>;
    revealCalls: string[];
} {
    const openCalls: Array<{ uri: string; offset: number }> = [];
    const revealCalls: string[] = [];
    return {
        openCalls,
        revealCalls,
        openTextDocumentAt: async (fileUri, offset) => {
            openCalls.push({ uri: fileUri, offset });
        },
        revealAnnotationInPanel: async (id) => {
            revealCalls.push(id);
        },
    };
}

suite('AnnotationNavigation — navigateToAnnotation', () => {
    test('opens the document at startOffset and pushes the id on the stack', async () => {
        const store = new AnnotationStore();
        const ann = store.upsert(fakeAnnotation('a1'));
        const stack = makeStack();
        const api = makeApi();
        const nav = new AnnotationNavigation(store, stack, api);

        await nav.navigateToAnnotation(ann.id);
        assert.deepStrictEqual(api.openCalls, [{ uri: 'file:///x.ts', offset: 42 }]);
        assert.deepStrictEqual(stack.calls, [ann.id]);
    });

    test('no-op on unknown id (no open, no stack push)', async () => {
        const store = new AnnotationStore();
        const stack = makeStack();
        const api = makeApi();
        const nav = new AnnotationNavigation(store, stack, api);
        await nav.navigateToAnnotation('does-not-exist');
        assert.strictEqual(api.openCalls.length, 0);
        assert.strictEqual(stack.calls.length, 0);
    });
});

suite('AnnotationNavigation — focusAnnotationInPanel', () => {
    test('forwards the call to the panel adapter', async () => {
        const store = new AnnotationStore();
        const ann = store.upsert(fakeAnnotation('a2'));
        const stack = makeStack();
        const api = makeApi();
        const nav = new AnnotationNavigation(store, stack, api);
        await nav.focusAnnotationInPanel(ann.id);
        assert.deepStrictEqual(api.revealCalls, [ann.id]);
    });

    test('silently no-op when the panel adapter is absent', async () => {
        const store = new AnnotationStore();
        const ann = store.upsert(fakeAnnotation('a3'));
        const stack = makeStack();
        const api: NavigationVsCodeApi = {
            openTextDocumentAt: async () => undefined,
        };
        const nav = new AnnotationNavigation(store, stack, api);
        await assert.doesNotReject(nav.focusAnnotationInPanel(ann.id));
    });

    test('no-op on unknown id', async () => {
        const store = new AnnotationStore();
        const stack = makeStack();
        const api = makeApi();
        const nav = new AnnotationNavigation(store, stack, api);
        await nav.focusAnnotationInPanel('unknown');
        assert.strictEqual(api.revealCalls.length, 0);
    });
});
