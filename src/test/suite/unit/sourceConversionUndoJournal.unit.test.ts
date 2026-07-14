import * as assert from 'assert';
import { minimalTextReplacement } from '../../../comments/sourceConversionTextEdit';
import {
    applySourceHistoryChanges,
    SourceConversionUndoJournal,
    type AnnotationHistorySnapshot,
    type SourceHistoryContentChange,
} from '../../../comments/sourceConversionUndoJournal';

interface Snapshot extends AnnotationHistorySnapshot {
    readonly id: string;
    readonly message: string;
    readonly startOffset: number;
    readonly endOffset: number;
}

function snapshot(id: string, startOffset = 0): Snapshot {
    return { id, message: id, startOffset, endOffset: startOffset + 1 };
}

function change(from: string, to: string): SourceHistoryContentChange[] {
    const patch = minimalTextReplacement(from, to);
    assert.ok(patch);
    return [{ rangeOffset: patch.startOffset, rangeLength: patch.endOffset - patch.startOffset, text: patch.text }];
}

suite('SourceConversionUndoJournal', () => {
    test('comments→annotations mirrors native Undo before tracking and Redo after tracking', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        const created = snapshot('created', 20);
        const beforeText = '// note\nrun();';
        const afterText = '\nrun();';
        const id = journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText,
            afterText,
            beforeSnapshots: [],
            afterSnapshots: [created],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [created],
        });

        const undo = journal.beginNative('file:///sample.ts', 'undo', beforeText, change(afterText, beforeText), [
            created,
        ]);
        assert.strictEqual(undo.kind, 'matched');
        if (undo.kind === 'matched') {
            assert.strictEqual(undo.plan.order, 'before-tracking');
            assert.deepStrictEqual(undo.plan.removeIds, ['created']);
            assert.deepStrictEqual(undo.plan.upsertSnapshots, []);
        }
        journal.complete(id, 'undo', true);
        assert.strictEqual(journal.phase(id), 'undone');

        const redo = journal.beginNative('file:///sample.ts', 'redo', afterText, change(beforeText, afterText), []);
        assert.strictEqual(redo.kind, 'matched');
        if (redo.kind === 'matched') {
            assert.strictEqual(redo.plan.order, 'after-tracking');
            assert.deepStrictEqual(redo.plan.removeIds, []);
            assert.deepStrictEqual(redo.plan.upsertSnapshots, [created]);
        }
        journal.complete(id, 'redo', true);
        assert.strictEqual(journal.phase(id), 'applied');
    });

    test('annotations→comments installs post-insert snapshots on Undo and removes them on Redo', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        const original = snapshot('original', 10);
        const postInsert = snapshot('original', 30);
        const beforeText = 'run();';
        const afterText = '// OOCI(original) note\nrun();';
        const id = journal.record({
            uri: 'file:///sample.ts',
            direction: 'annotations-to-comments',
            beforeText,
            afterText,
            beforeSnapshots: [original],
            afterSnapshots: [],
            undoInstallSnapshots: [postInsert],
            redoInstallSnapshots: [],
        });

        const undo = journal.beginNative('file:///sample.ts', 'undo', beforeText, change(afterText, beforeText), []);
        assert.strictEqual(undo.kind, 'matched');
        if (undo.kind === 'matched') {
            assert.deepStrictEqual(undo.plan.removeIds, []);
            assert.deepStrictEqual(undo.plan.upsertSnapshots, [postInsert]);
        }
        journal.complete(id, 'undo', true);

        const trackedOriginal = snapshot('original', 10);
        const redo = journal.beginNative('file:///sample.ts', 'redo', afterText, change(beforeText, afterText), [
            trackedOriginal,
        ]);
        assert.strictEqual(redo.kind, 'matched');
        if (redo.kind === 'matched') {
            assert.deepStrictEqual(redo.plan.removeIds, ['original']);
            assert.deepStrictEqual(redo.plan.upsertSnapshots, []);
        }
        journal.complete(id, 'redo', true);
        assert.strictEqual(journal.phase(id), 'applied');
    });

    test('refuses an exact source Undo when business snapshots diverged', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        const created = snapshot('created');
        const beforeText = '// note\nrun();';
        const afterText = '\nrun();';
        const id = journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText,
            afterText,
            beforeSnapshots: [],
            afterSnapshots: [created],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [created],
        });
        const result = journal.beginNative('file:///sample.ts', 'undo', beforeText, change(afterText, beforeText), [
            { ...created, message: 'edited' },
        ]);
        assert.strictEqual(result.kind, 'diverged');
        assert.strictEqual(journal.phase(id), 'diverged');
    });

    test('requires an exact native patch in addition to the target hash', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        const beforeText = '// note\nrun();';
        const afterText = '\nrun();';
        journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText,
            afterText,
            beforeSnapshots: [],
            afterSnapshots: [],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [],
        });
        const result = journal.beginNative(
            'file:///sample.ts',
            'undo',
            beforeText,
            [{ rangeOffset: 0, rangeLength: 0, text: 'not-the-recorded-patch' }],
            []
        );
        assert.strictEqual(result.kind, 'diverged');
    });

    test('ignores unrelated native history whose target text does not match', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText: '// note\nrun();',
            afterText: '\nrun();',
            beforeSnapshots: [],
            afterSnapshots: [],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [],
        });
        assert.deepStrictEqual(journal.beginNative('file:///sample.ts', 'undo', 'other text', [], []), {
            kind: 'none',
        });
    });

    test('ordinary edits after Undo invalidate the native Redo branch', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        const beforeText = 'before';
        const afterText = 'after';
        const id = journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText,
            afterText,
            beforeSnapshots: [],
            afterSnapshots: [],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [],
        });
        const undo = journal.beginNative('file:///sample.ts', 'undo', beforeText, change(afterText, beforeText), []);
        assert.strictEqual(undo.kind, 'matched');
        journal.complete(id, 'undo', true);
        journal.observeOrdinaryEdit('file:///sample.ts');
        assert.strictEqual(journal.phase(id), 'diverged');
        assert.deepStrictEqual(
            journal.beginNative('file:///sample.ts', 'redo', afterText, change(beforeText, afterText), []),
            { kind: 'none' }
        );
    });

    test('rejects overlapping business states because Keep needs no custom mirror', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        assert.throws(
            () =>
                journal.record({
                    uri: 'file:///sample.ts',
                    direction: 'annotations-to-comments',
                    beforeText: 'before',
                    afterText: 'after',
                    beforeSnapshots: [snapshot('same', 1)],
                    afterSnapshots: [snapshot('same', 3)],
                    undoInstallSnapshots: [snapshot('same', 3)],
                    redoInstallSnapshots: [],
                }),
            /destructive moves with disjoint states/
        );
    });

    test('purges one document without affecting another', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        for (const uri of ['file:///a.ts', 'file:///b.ts']) {
            journal.record({
                uri,
                direction: 'comments-to-annotations',
                beforeText: 'before',
                afterText: 'after',
                beforeSnapshots: [],
                afterSnapshots: [],
                undoInstallSnapshots: [],
                redoInstallSnapshots: [],
            });
        }
        journal.clearUri('file:///a.ts');
        assert.strictEqual(journal.size('file:///a.ts'), 0);
        assert.strictEqual(journal.size('file:///b.ts'), 1);
    });

    test('discards a pending conversion entry after rollback', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>();
        const id = journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText: 'before',
            afterText: 'after',
            beforeSnapshots: [],
            afterSnapshots: [],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [],
        });
        journal.discard(id);
        assert.strictEqual(journal.phase(id), undefined);
        assert.strictEqual(journal.size('file:///sample.ts'), 0);
    });

    test('bounds history independently per document', () => {
        const journal = new SourceConversionUndoJournal<Snapshot>(2);
        for (let index = 0; index < 3; index++) {
            journal.record({
                uri: 'file:///a.ts',
                direction: 'comments-to-annotations',
                beforeText: `before-${index}`,
                afterText: `after-${index}`,
                beforeSnapshots: [],
                afterSnapshots: [],
                undoInstallSnapshots: [],
                redoInstallSnapshots: [],
            });
        }
        journal.record({
            uri: 'file:///b.ts',
            direction: 'comments-to-annotations',
            beforeText: 'before',
            afterText: 'after',
            beforeSnapshots: [],
            afterSnapshots: [],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [],
        });
        assert.strictEqual(journal.size('file:///a.ts'), 2);
        assert.strictEqual(journal.size('file:///b.ts'), 1);
    });

    test('applies non-overlapping multi-change patches using pre-event offsets', () => {
        assert.strictEqual(
            applySourceHistoryChanges('alpha beta gamma', [
                { rangeOffset: 0, rangeLength: 5, text: 'A' },
                { rangeOffset: 11, rangeLength: 5, text: 'G' },
            ]),
            'A beta G'
        );
        assert.strictEqual(
            applySourceHistoryChanges('abc', [
                { rangeOffset: 0, rangeLength: 2, text: 'x' },
                { rangeOffset: 1, rangeLength: 1, text: 'y' },
            ]),
            undefined
        );
    });
});
