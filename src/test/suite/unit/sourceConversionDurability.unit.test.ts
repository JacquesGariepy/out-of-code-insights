import * as assert from 'assert';
import { allConversionSnapshotsAbsent, sourceStateStillMatches } from '../../../comments/sourceConversionDurability';
import { SourceConversionUndoJournal } from '../../../comments/sourceConversionUndoJournal';

suite('Source conversion durability guards', () => {
    test('allows source rollback only for the exact pre-save version and text', () => {
        assert.strictEqual(sourceStateStillMatches(7, 'converted', 7, 'converted'), true);
        assert.strictEqual(sourceStateStillMatches(7, 'converted', 8, 'converted'), false);
        assert.strictEqual(sourceStateStillMatches(7, 'converted', 7, 'typed concurrently'), false);
        assert.strictEqual(sourceStateStillMatches(7, 'converted', 8, 'typed concurrently'), false);
    });

    test('restores a removed representation only while every expected id is absent', () => {
        assert.strictEqual(allConversionSnapshotsAbsent(['a', 'b'], []), true);
        assert.strictEqual(allConversionSnapshotsAbsent(['a', 'b'], ['unrelated']), true);
        assert.strictEqual(allConversionSnapshotsAbsent(['a', 'b'], ['a']), false);
        assert.strictEqual(allConversionSnapshotsAbsent(['a', 'b'], ['a', 'b']), false);
        assert.strictEqual(allConversionSnapshotsAbsent([], []), false);
    });

    test('keeps conservative rollback eligible after a save edit invalidates the Undo phase', () => {
        const journal = new SourceConversionUndoJournal<{ id: string; message: string }>();
        const created = { id: 'created', message: 'note' };
        const entryId = journal.record({
            uri: 'file:///sample.ts',
            direction: 'comments-to-annotations',
            beforeText: '// note\ncode',
            afterText: '\ncode',
            beforeSnapshots: [],
            afterSnapshots: [created],
            undoInstallSnapshots: [],
            redoInstallSnapshots: [created],
        });
        const transition = journal.beginNative(
            'file:///sample.ts',
            'undo',
            '// note\ncode',
            [{ rangeOffset: 0, rangeLength: 0, text: '// note' }],
            [created]
        );
        assert.strictEqual(transition.kind, 'matched');
        if (transition.kind !== 'matched') {
            return;
        }
        journal.complete(entryId, 'undo', true);
        journal.observeOrdinaryEdit('file:///sample.ts');
        assert.strictEqual(journal.phase(entryId), 'diverged');
        assert.strictEqual(
            allConversionSnapshotsAbsent(
                transition.plan.rollbackUpsertSnapshots.map((snapshot) => snapshot.id),
                []
            ),
            true
        );
    });
});
