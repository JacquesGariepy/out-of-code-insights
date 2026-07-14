// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
    annotationIdFromCommentCommandArg,
    commentThreadFromCommandArg,
    type ThreadArg,
} from '../../../comments/commentCommandArguments';

function fakeThread(label: string): vscode.CommentThread {
    return { label } as unknown as vscode.CommentThread;
}

suite('Comment command argument resolution', () => {
    test('resolves CommentReply from comments/commentThread/context through its thread', () => {
        const thread = fakeThread('tracked');
        const reply = { thread, text: 'reply editor text' } as vscode.CommentReply;

        assert.strictEqual(commentThreadFromCommandArg(reply), thread);
        assert.strictEqual(
            annotationIdFromCommentCommandArg(reply, (candidate) =>
                candidate === thread ? 'annotation-from-reply' : undefined
            ),
            'annotation-from-reply'
        );
    });

    test('preserves direct CommentThread, string id and object id paths', () => {
        const thread = fakeThread('direct');
        const resolveThread = (candidate: vscode.CommentThread): string | undefined =>
            candidate === thread ? 'annotation-from-thread' : undefined;

        assert.strictEqual(commentThreadFromCommandArg(thread), thread);
        assert.strictEqual(annotationIdFromCommentCommandArg(thread, resolveThread), 'annotation-from-thread');
        assert.strictEqual(annotationIdFromCommentCommandArg('plain-id', resolveThread), 'plain-id');
        assert.strictEqual(
            annotationIdFromCommentCommandArg({ annotationId: 'object-id' }, resolveThread),
            'object-id'
        );
    });

    test('keeps an explicit annotation id authoritative for an overlapping object shape', () => {
        const thread = fakeThread('must-not-win');
        let threadResolverCalled = false;
        const ambiguous = {
            annotationId: 'explicit-id',
            thread,
            text: 'also resembles CommentReply',
        } as unknown as ThreadArg;

        assert.strictEqual(commentThreadFromCommandArg(ambiguous), undefined);
        assert.strictEqual(
            annotationIdFromCommentCommandArg(ambiguous, () => {
                threadResolverCalled = true;
                return 'thread-id';
            }),
            'explicit-id'
        );
        assert.strictEqual(threadResolverCalled, false);
    });
});
