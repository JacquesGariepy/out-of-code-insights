import * as assert from 'assert';
import { sameConversionBusinessSnapshot, sameConversionSnapshot } from '../../../comments/sourceConversionSnapshot';

suite('Source conversion snapshot guard', () => {
    const snapshot = {
        id: 'annotation-1',
        fileUri: 'file:///workspace/file.ts',
        startOffset: 10,
        endOffset: 20,
        message: 'Explain this code',
        tags: ['review', 'api'],
        thread: [{ id: 'reply-1', message: 'Looks good' }],
    };

    test('accepts an unchanged snapshot regardless of object key order', () => {
        assert.strictEqual(sameConversionSnapshot(snapshot, { ...snapshot }), true);
        assert.strictEqual(
            sameConversionSnapshot(snapshot, {
                tags: ['review', 'api'],
                message: 'Explain this code',
                endOffset: 20,
                startOffset: 10,
                fileUri: 'file:///workspace/file.ts',
                id: 'annotation-1',
                thread: [{ message: 'Looks good', id: 'reply-1' }],
            }),
            true
        );
    });

    test('rejects changes to identity, anchor, message, tags, or nested business data', () => {
        for (const current of [
            { ...snapshot, id: 'annotation-2' },
            { ...snapshot, startOffset: 11 },
            { ...snapshot, endOffset: 21 },
            { ...snapshot, message: 'Changed' },
            { ...snapshot, tags: ['review'] },
            { ...snapshot, thread: [{ id: 'reply-2', message: 'New reply' }] },
        ]) {
            assert.strictEqual(sameConversionSnapshot(snapshot, current), false);
        }
    });

    test('treats missing and present optional fields as different snapshots', () => {
        const { tags: _tags, ...withoutTags } = snapshot;
        assert.strictEqual(sameConversionSnapshot(snapshot, withoutTags), false);
    });

    test('business guard permits anchor tracking but rejects content changes', () => {
        const tracked = {
            ...snapshot,
            startOffset: 42,
            endOffset: 52,
            lineHash: 'new-hash',
            contextBefore: ['before'],
            contextAfter: ['after'],
        };
        assert.strictEqual(sameConversionBusinessSnapshot(snapshot, tracked), true);
        assert.strictEqual(sameConversionBusinessSnapshot(snapshot, { ...tracked, message: 'Changed' }), false);
        assert.strictEqual(sameConversionBusinessSnapshot(snapshot, { ...tracked, tags: ['other'] }), false);
    });
});
