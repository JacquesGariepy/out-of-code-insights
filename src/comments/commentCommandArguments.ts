// SPDX-License-Identifier: MPL-2.0
import type * as vscode from 'vscode';

/** Plain command shape used by automation and integration tests. */
export interface AnnotationIdArg {
    annotationId: string;
}

export type ReplyArg = vscode.CommentReply | (AnnotationIdArg & { text: string });

/**
 * Every argument shape accepted by thread actions.
 *
 * VS Code passes CommentReply to `comments/commentThread/context` actions and
 * CommentThread to `comments/commentThread/title` actions. The plain id forms
 * keep the same commands usable by automation without constructing API
 * objects.
 */
export type ThreadArg = vscode.CommentThread | vscode.CommentReply | AnnotationIdArg | string;

export function isAnnotationIdArg(arg: unknown): arg is AnnotationIdArg {
    return typeof arg === 'object' && arg !== null && typeof (arg as AnnotationIdArg).annotationId === 'string';
}

export function isCommentReplyArg(arg: unknown): arg is vscode.CommentReply {
    if (typeof arg !== 'object' || arg === null) {
        return false;
    }
    const candidate = arg as { thread?: unknown; text?: unknown };
    return typeof candidate.text === 'string' && typeof candidate.thread === 'object' && candidate.thread !== null;
}

/** Resolve the API thread carried by a title or context-menu command. */
export function commentThreadFromCommandArg(arg: ThreadArg): vscode.CommentThread | undefined {
    if (typeof arg !== 'object' || arg === null || isAnnotationIdArg(arg)) {
        return undefined;
    }
    return isCommentReplyArg(arg) ? arg.thread : arg;
}

/**
 * Resolve an annotation id without guessing between overlapping object
 * shapes. Explicit ids are authoritative; API arguments are resolved through
 * their direct or CommentReply-wrapped thread identity.
 */
export function annotationIdFromCommentCommandArg(
    arg: ThreadArg,
    annotationIdFromThread: (thread: vscode.CommentThread) => string | undefined
): string | undefined {
    if (typeof arg === 'string') {
        return arg;
    }
    if (isAnnotationIdArg(arg)) {
        return arg.annotationId;
    }
    const thread = commentThreadFromCommandArg(arg);
    return thread ? annotationIdFromThread(thread) : undefined;
}
