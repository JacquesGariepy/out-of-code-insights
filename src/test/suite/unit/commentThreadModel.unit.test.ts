/**
 * Pure-logic tests for the annotation → comment-thread projection.
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import {
    buildThreadLabel,
    DEFAULT_COMMENT_AUTHOR,
    projectAnnotationToThread,
} from '../../../comments/commentThreadModel';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationV2 } from '../../../transactional/types';

function makeAnnotation(overrides: Partial<AnnotationV2> = {}): AnnotationV2 {
    return {
        id: 'ann-1',
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        fileUri: 'file:///ws/src/foo.ts',
        file: 'src/foo.ts',
        startOffset: 10,
        endOffset: 30,
        lineHash: 'abcd1234',
        contextBefore: [],
        contextAfter: [],
        state: 'active',
        origin: { kind: 'manual' },
        message: 'Validate the input before parsing',
        author: 'jacques',
        timestamp: '2026-06-11T10:00:00.000Z',
        ...overrides,
    };
}

suite('commentThreadModel — projectAnnotationToThread', () => {
    test('first comment is the annotation message with its author and timestamp', () => {
        const model = projectAnnotationToThread(makeAnnotation(), 4);
        assert.strictEqual(model.annotationId, 'ann-1');
        assert.strictEqual(model.line, 4);
        assert.strictEqual(model.comments.length, 1);
        assert.deepStrictEqual(model.comments[0], {
            body: 'Validate the input before parsing',
            author: 'jacques',
            timestamp: '2026-06-11T10:00:00.000Z',
        });
    });

    test('thread replies follow the root comment in stored order', () => {
        const model = projectAnnotationToThread(
            makeAnnotation({
                thread: [
                    { id: 'c-1', message: 'first reply', author: 'alice', timestamp: '2026-06-11T11:00:00.000Z' },
                    { id: 'c-2', message: 'second reply', author: 'bob', timestamp: '2026-06-11T12:00:00.000Z' },
                ],
            }),
            0
        );
        assert.strictEqual(model.comments.length, 3);
        assert.strictEqual(model.comments[0].body, 'Validate the input before parsing');
        assert.deepStrictEqual(
            model.comments.slice(1).map((c) => [c.body, c.author]),
            [
                ['first reply', 'alice'],
                ['second reply', 'bob'],
            ]
        );
    });

    test('missing authors fall back to the default author', () => {
        const model = projectAnnotationToThread(
            makeAnnotation({
                author: undefined,
                thread: [{ id: 'c-1', message: 'anonymous reply', timestamp: '2026-06-11T11:00:00.000Z' }],
            }),
            0
        );
        assert.strictEqual(model.comments[0].author, DEFAULT_COMMENT_AUTHOR);
        assert.strictEqual(model.comments[1].author, DEFAULT_COMMENT_AUTHOR);
    });

    test('an explicit defaultAuthor overrides the built-in fallback', () => {
        const model = projectAnnotationToThread(makeAnnotation({ author: undefined }), 0, {
            defaultAuthor: 'workspace-user',
        });
        assert.strictEqual(model.comments[0].author, 'workspace-user');
    });

    test('resolved flag projects to the model (defaults to false)', () => {
        assert.strictEqual(projectAnnotationToThread(makeAnnotation(), 0).resolved, false);
        assert.strictEqual(projectAnnotationToThread(makeAnnotation({ resolved: true }), 0).resolved, true);
        assert.strictEqual(projectAnnotationToThread(makeAnnotation({ resolved: false }), 0).resolved, false);
    });

    test('negative lines clamp to 0', () => {
        assert.strictEqual(projectAnnotationToThread(makeAnnotation(), -3).line, 0);
    });
});

suite('commentThreadModel — buildThreadLabel', () => {
    test('combines severity and tags', () => {
        assert.strictEqual(
            buildThreadLabel({ severity: 'warning', tags: ['doc:module', 'api'] }),
            'warning · doc:module, api'
        );
    });

    test('severity only', () => {
        assert.strictEqual(buildThreadLabel({ severity: 'error', tags: [] }), 'error');
    });

    test('tags only', () => {
        assert.strictEqual(buildThreadLabel({ tags: ['todo'] }), 'todo');
    });

    test('empty when neither severity nor tags are set', () => {
        assert.strictEqual(buildThreadLabel({}), '');
        assert.strictEqual(buildThreadLabel({ severity: '  ', tags: [] }), '');
    });

    test('label flows into the projected model', () => {
        const model = projectAnnotationToThread(makeAnnotation({ severity: 'info', tags: ['perf'] }), 1);
        assert.strictEqual(model.label, 'info · perf');
    });
});
