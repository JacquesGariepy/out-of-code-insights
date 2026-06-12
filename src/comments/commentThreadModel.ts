// SPDX-License-Identifier: MPL-2.0
//
// Pure projection of an AnnotationV2 into an editor comment-thread model.
// No vscode runtime dependency — the controller layer
// (src/comments/AnnotationCommentsController.ts) resolves the display line
// from the open document and maps this model onto vscode.CommentThread /
// vscode.Comment instances. Keeping the projection pure lets the fast
// `test:unit` pass cover it without an EDH host.

import type { AnnotationV2 } from '../transactional/types';

/** One rendered comment inside a thread. */
export interface ThreadCommentModel {
    /** Markdown body displayed in the comment widget. */
    body: string;
    /** Display name of the comment author. */
    author: string;
    /** ISO-8601 timestamp of the comment. */
    timestamp: string;
}

/** Editor-agnostic model of the comment thread for one annotation. */
export interface CommentThreadModel {
    /** Id of the projected annotation. */
    annotationId: string;
    /** Resolved 0-based display line the thread anchors to (clamped to >= 0). */
    line: number;
    /** Resolution state of the annotation (`resolved` flag, defaults to false). */
    resolved: boolean;
    /** Severity/tags summary shown next to the thread title. Empty when neither is set. */
    label: string;
    /**
     * Ordered comments: the FIRST entry is the annotation message itself,
     * the remaining entries are the `annotation.thread` replies in order.
     */
    comments: ThreadCommentModel[];
}

/** Options for {@link projectAnnotationToThread}. */
export interface ProjectThreadOptions {
    /** Author shown when a comment carries no author. Default: {@link DEFAULT_COMMENT_AUTHOR}. */
    defaultAuthor?: string;
}

/** Fallback author name used when an annotation/reply has no author. */
export const DEFAULT_COMMENT_AUTHOR = 'Anonymous';

/**
 * Build the thread label from severity + tags, e.g. `warning · doc:module, api`.
 * Severity comes first; tags are comma-joined. Returns '' when both are absent.
 */
export function buildThreadLabel(annotation: Pick<AnnotationV2, 'severity' | 'tags'>): string {
    const parts: string[] = [];
    if (annotation.severity && annotation.severity.trim().length > 0) {
        parts.push(annotation.severity.trim());
    }
    if (annotation.tags && annotation.tags.length > 0) {
        parts.push(annotation.tags.join(', '));
    }
    return parts.join(' · ');
}

/**
 * Project an annotation (+ its resolved display line) into a comment-thread
 * model: the first comment is the annotation message, the rest are the
 * `annotation.thread` replies in stored order.
 */
export function projectAnnotationToThread(
    annotation: AnnotationV2,
    line: number,
    options: ProjectThreadOptions = {}
): CommentThreadModel {
    const fallbackAuthor = options.defaultAuthor ?? DEFAULT_COMMENT_AUTHOR;
    const comments: ThreadCommentModel[] = [
        {
            body: annotation.message,
            author: annotation.author ?? fallbackAuthor,
            timestamp: annotation.timestamp,
        },
    ];
    for (const reply of annotation.thread ?? []) {
        comments.push({
            body: reply.message,
            author: reply.author ?? fallbackAuthor,
            timestamp: reply.timestamp,
        });
    }
    return {
        annotationId: annotation.id,
        line: Math.max(0, line),
        resolved: annotation.resolved === true,
        label: buildThreadLabel(annotation),
        comments,
    };
}
