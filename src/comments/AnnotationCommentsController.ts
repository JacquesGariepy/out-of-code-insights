// SPDX-License-Identifier: MPL-2.0
//
// Native Comments API integration: renders every active annotation as a
// vscode.CommentThread in the editor (comment-sample pattern). The thread is
// a PROJECTION of the AnnotationStore — every mutation (reply, resolve,
// unresolve, delete, create-from-gutter) routes through the store, which
// fires onDidChange and the controller re-projects.
//
// Command arguments are deliberately permissive: each command accepts the
// native shape VS Code passes from the comment widget (CommentReply /
// CommentThread / Comment) AND a plain `annotationId` string (or
// `{ annotationId }` object) so the EDH integration suite can drive the
// exact same code paths without crafting live widget objects.

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import { loc } from '../managers/LocalizationManager';
import { getLogger } from '../utils/logger';
import { projectAnnotationToThread } from './commentThreadModel';

/** Stable id of the comment controller (used by `commentController ==` when-clauses). */
export const COMMENTS_CONTROLLER_ID = 'outOfCodeInsights.comments';

/** vscode.Comment enriched with the owning annotation id (comment-sample pattern). */
interface AnnotationComment extends vscode.Comment {
    annotationId: string;
}

/** Plain testability shape accepted by every comment command. */
interface AnnotationIdArg {
    annotationId: string;
}

type ReplyArg = vscode.CommentReply | (AnnotationIdArg & { text: string });
type ThreadArg = vscode.CommentThread | AnnotationIdArg | string;

function isAnnotationIdArg(arg: unknown): arg is AnnotationIdArg {
    return typeof arg === 'object' && arg !== null && typeof (arg as AnnotationIdArg).annotationId === 'string';
}

function isCommentReply(arg: unknown): arg is vscode.CommentReply {
    if (typeof arg !== 'object' || arg === null) {
        return false;
    }
    const candidate = arg as { thread?: unknown; text?: unknown };
    return typeof candidate.text === 'string' && typeof candidate.thread === 'object' && candidate.thread !== null;
}

export class AnnotationCommentsController implements vscode.Disposable {
    private readonly controller: vscode.CommentController;
    /** Persistent threads keyed by annotation id. Ephemeral gutter threads are NOT tracked here. */
    private readonly threads = new Map<string, vscode.CommentThread>();
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(private readonly store: AnnotationStore) {
        this.controller = vscode.comments.createCommentController(COMMENTS_CONTROLLER_ID, 'Out-of-Code Insights');
        // The "+" gutter is available on the whole document: replying on the
        // resulting empty thread creates a brand-new annotation at that line.
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument): vscode.Range[] => [
                new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0),
            ],
        };

        this.subscriptions.push(this.store.onDidChange(() => this.refresh()));
        this.subscriptions.push(this.store.onDidSuspend(() => this.refresh()));
        this.subscriptions.push(this.store.onDidResume(() => this.refresh()));
        this.subscriptions.push(this.store.onDidDispose(() => this.refresh()));
        this.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()));

        this.registerCommands();
        this.refresh();
    }

    // ── Projection ───────────────────────────────────────────────────────

    /**
     * Re-project the store onto comment threads: create/update one thread per
     * active annotation of each visible editor, and drop threads whose
     * annotation left the store (removed, suspended, disposed).
     */
    refresh(): void {
        const documentsByUri = new Map<string, vscode.TextDocument>();
        for (const editor of vscode.window.visibleTextEditors) {
            documentsByUri.set(editor.document.uri.toString(), editor.document);
        }

        for (const [uriString, document] of documentsByUri) {
            for (const annotation of this.store.getByFile(uriString)) {
                if (annotation.state !== 'active') {
                    continue;
                }
                const line = document.positionAt(annotation.startOffset).line;
                const model = projectAnnotationToThread(annotation, line, { defaultAuthor: this.username() });
                const range = new vscode.Range(model.line, 0, model.line, 0);

                let thread = this.threads.get(annotation.id);
                // Thread uri is immutable: when the annotation moved to a
                // different file (rename), recreate the thread over there.
                if (thread && thread.uri.toString() !== uriString) {
                    thread.dispose();
                    this.threads.delete(annotation.id);
                    thread = undefined;
                }
                if (!thread) {
                    thread = this.controller.createCommentThread(document.uri, range, []);
                    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
                    this.threads.set(annotation.id, thread);
                }
                thread.range = range;
                thread.canReply = true;
                thread.label = model.label.length > 0 ? model.label : undefined;
                thread.contextValue = model.resolved ? 'annotation;resolved' : 'annotation;unresolved';
                thread.state = model.resolved
                    ? vscode.CommentThreadState.Resolved
                    : vscode.CommentThreadState.Unresolved;
                thread.comments = model.comments.map((comment): AnnotationComment => {
                    return {
                        body: new vscode.MarkdownString(comment.body),
                        mode: vscode.CommentMode.Preview,
                        author: { name: comment.author },
                        timestamp: new Date(comment.timestamp),
                        annotationId: model.annotationId,
                    };
                });
            }
        }

        // Threads whose annotation no longer exists in the store are gone.
        for (const [annotationId, thread] of this.threads) {
            const annotation = this.store.get(annotationId);
            if (!annotation || annotation.state !== 'active') {
                thread.dispose();
                this.threads.delete(annotationId);
            }
        }
    }

    // ── Commands ─────────────────────────────────────────────────────────

    private registerCommands(): void {
        this.subscriptions.push(
            vscode.commands.registerCommand('annotations.commentReply', (arg: ReplyArg) => this.handleReply(arg)),
            vscode.commands.registerCommand('annotations.commentResolve', (arg: ThreadArg) =>
                this.handleSetResolved(arg, true)
            ),
            vscode.commands.registerCommand('annotations.commentUnresolve', (arg: ThreadArg) =>
                this.handleSetResolved(arg, false)
            ),
            vscode.commands.registerCommand('annotations.commentDelete', (arg: ThreadArg) => this.handleDelete(arg))
        );
    }

    /**
     * Reply handler. Two shapes:
     *  - reply on a tracked thread (or `{annotationId, text}`): append a
     *    Comment entry to `annotation.thread`;
     *  - reply on an EPHEMERAL thread created from the "+" gutter: create a
     *    new annotation at the thread's line and dispose the ephemeral
     *    thread (refresh re-creates the persistent one).
     */
    private async handleReply(arg: ReplyArg): Promise<void> {
        if (isAnnotationIdArg(arg)) {
            this.appendReply(arg.annotationId, arg.text);
            return;
        }
        if (!isCommentReply(arg)) {
            return;
        }
        const text = arg.text.trim();
        if (text.length === 0) {
            return;
        }
        const annotationId = this.annotationIdFromThread(arg.thread);
        if (annotationId) {
            this.appendReply(annotationId, text);
            return;
        }
        await this.createAnnotationFromThread(arg.thread, text);
        arg.thread.dispose();
    }

    private appendReply(annotationId: string, text: string): void {
        const annotation = this.store.get(annotationId);
        if (!annotation) {
            this.warnUnknownAnnotation(annotationId);
            return;
        }
        const message = text.trim();
        if (message.length === 0) {
            return;
        }
        this.store.update(annotationId, {
            thread: [
                ...(annotation.thread ?? []),
                {
                    id: randomUUID(),
                    message,
                    author: this.username(),
                    timestamp: new Date().toISOString(),
                },
            ],
        });
    }

    private async createAnnotationFromThread(thread: vscode.CommentThread, message: string): Promise<void> {
        const uriString = thread.uri.toString();
        const document =
            vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriString) ??
            (await vscode.workspace.openTextDocument(thread.uri));
        const line = Math.min(thread.range?.start.line ?? 0, Math.max(0, document.lineCount - 1));
        this.store.add(
            {
                fileUri: uriString,
                file: vscode.workspace.asRelativePath(thread.uri),
                origin: { kind: 'manual' },
                message,
                author: this.username(),
                timestamp: new Date().toISOString(),
                languageId: document.languageId,
            },
            { line },
            document
        );
    }

    private handleSetResolved(arg: ThreadArg, resolved: boolean): void {
        const annotationId = this.annotationIdFromArg(arg);
        if (!annotationId) {
            return;
        }
        if (!this.store.get(annotationId)) {
            this.warnUnknownAnnotation(annotationId);
            return;
        }
        this.store.update(annotationId, { resolved });
    }

    private handleDelete(arg: ThreadArg): void {
        const annotationId = this.annotationIdFromArg(arg);
        if (annotationId) {
            this.store.remove(annotationId);
            return;
        }
        // Ephemeral gutter thread without a backing annotation: just drop it.
        if (typeof arg === 'object' && arg !== null && typeof (arg as vscode.CommentThread).dispose === 'function') {
            (arg as vscode.CommentThread).dispose();
        }
    }

    // ── Argument resolution ──────────────────────────────────────────────

    /** Resolve the annotation id from any accepted command argument shape. */
    private annotationIdFromArg(arg: ThreadArg): string | undefined {
        if (typeof arg === 'string') {
            return arg;
        }
        if (isAnnotationIdArg(arg)) {
            return arg.annotationId;
        }
        return this.annotationIdFromThread(arg);
    }

    /** Reverse lookup of a live thread object in the id → thread map. */
    private annotationIdFromThread(thread: vscode.CommentThread): string | undefined {
        for (const [annotationId, tracked] of this.threads) {
            if (tracked === thread) {
                return annotationId;
            }
        }
        return undefined;
    }

    private username(): string {
        const fallback = loc('anonymous', 'Anonymous');
        return vscode.workspace.getConfiguration('annotation').get<string>('username', fallback);
    }

    private warnUnknownAnnotation(annotationId: string): void {
        getLogger().warn(`AnnotationCommentsController: annotation ${annotationId} not found`);
        void vscode.window.showWarningMessage(
            loc('commentsAnnotationNotFound', 'Annotation not found for this comment thread.')
        );
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.subscriptions.length = 0;
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
        this.controller.dispose();
    }
}
