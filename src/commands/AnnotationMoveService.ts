// SPDX-License-Identifier: MPL-2.0
import * as vscode from 'vscode';
import { loc } from '../managers/LocalizationManager';
import type { AnnotationPersistence } from '../transactional/AnnotationPersistence';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { AnnotationV2 } from '../transactional/types';

export const ANNOTATION_DRAG_MIME = 'application/vnd.code.tree.annotation';

export interface MoveAnnotationsRequest {
    ids: readonly string[];
    targetAnnotationId?: string;
    targetFile?: string;
    targetLine?: number;
}

export interface MoveAnnotationsResult {
    movedIds: string[];
    file: string;
    firstLine: number;
}

/**
 * Shared move engine used by native TreeView drops, the panel webview and the
 * keyboard-accessible command. A move preserves annotation ids and discussion
 * metadata while recapturing the anchor against the destination document.
 */
export class AnnotationMoveService {
    constructor(
        private readonly store: AnnotationStore,
        private readonly persistence: AnnotationPersistence
    ) {}

    async move(request: MoveAnnotationsRequest): Promise<MoveAnnotationsResult | undefined> {
        const ids = [...new Set(request.ids)].filter((id) => this.store.get(id) !== undefined);
        const movableIds = request.targetAnnotationId ? ids.filter((id) => id !== request.targetAnnotationId) : ids;
        if (movableIds.length === 0) {
            return undefined;
        }

        const target = await this.resolveTarget(request, new Set(movableIds));
        if (!target) {
            return undefined;
        }

        const sourceLocations = await this.resolveSourceLocations(movableIds);
        const sameSourceFile = sourceLocations.every(
            (entry) => entry.annotation.fileUri === sourceLocations[0]?.annotation.fileUri
        );
        const baseSourceLine = sameSourceFile ? Math.min(...sourceLocations.map((entry) => entry.line)) : 0;
        sourceLocations.sort((left, right) => {
            const fileOrder = left.annotation.file.localeCompare(right.annotation.file);
            return fileOrder || left.line - right.line || left.annotation.startOffset - right.annotation.startOffset;
        });

        this.store.beginTransaction();
        try {
            sourceLocations.forEach((entry, index) => {
                const relativeLine = sameSourceFile ? entry.line - baseSourceLine : index;
                const destinationLine = Math.max(
                    0,
                    Math.min(target.document.lineCount - 1, target.line + relativeLine)
                );
                this.store.reanchor(
                    entry.annotation.id,
                    destinationLine,
                    target.document,
                    vscode.workspace.asRelativePath(target.document.uri)
                );
            });
            this.store.commit();
        } catch (error) {
            this.store.rollback();
            throw error;
        }

        await this.persistence.save(this.store.serialize());
        return {
            movedIds: sourceLocations.map((entry) => entry.annotation.id),
            file: vscode.workspace.asRelativePath(target.document.uri),
            firstLine: target.line,
        };
    }

    private async resolveTarget(
        request: MoveAnnotationsRequest,
        movingIds: ReadonlySet<string>
    ): Promise<{ document: vscode.TextDocument; line: number } | undefined> {
        let targetAnnotation: Readonly<AnnotationV2> | undefined;
        if (request.targetAnnotationId) {
            targetAnnotation = this.store.get(request.targetAnnotationId);
        } else if (!request.targetFile && request.targetLine === undefined) {
            const picked = await vscode.window.showQuickPick(
                this.store
                    .list()
                    .filter((annotation) => !movingIds.has(annotation.id))
                    .map((annotation) => ({
                        label: annotation.message.split(/\r?\n/, 1)[0] || annotation.id,
                        description: annotation.file,
                        detail: loc('dropTargetDetail', 'Drop beside this annotation'),
                        annotation,
                    })),
                {
                    title: loc('moveAnnotationsTitle', 'Move annotations'),
                    placeHolder: loc('pickDropTarget', 'Choose the destination annotation'),
                    matchOnDescription: true,
                    matchOnDetail: true,
                }
            );
            targetAnnotation = picked?.annotation;
            if (!targetAnnotation) {
                return undefined;
            }
        }

        const fileCandidate = targetAnnotation
            ? targetAnnotation
            : this.store.list().find((annotation) => annotation.file === request.targetFile);
        if (!fileCandidate) {
            throw new Error(loc('dropTargetFileMissing', 'The destination file is no longer available.'));
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileCandidate.fileUri));
        let line = request.targetLine;
        if (line === undefined && targetAnnotation) {
            line = document.positionAt(targetAnnotation.startOffset).line;
        }
        if (line === undefined) {
            const activeEditor = vscode.window.activeTextEditor;
            const suggestedLine =
                activeEditor?.document.uri.toString() === document.uri.toString()
                    ? activeEditor.selection.active.line
                    : document.positionAt(fileCandidate.startOffset).line;
            line = await this.pickDestinationLine(document, suggestedLine);
        }
        if (line === undefined) {
            return undefined;
        }
        return { document, line: Math.max(0, Math.min(document.lineCount - 1, line)) };
    }

    private async pickDestinationLine(
        document: vscode.TextDocument,
        suggestedLine: number
    ): Promise<number | undefined> {
        const candidates = Array.from({ length: Math.min(document.lineCount, 2000) }, (_, line) => ({
            label: loc('lineNumberLabel', 'Line {0}', line + 1),
            description: document.lineAt(line).text.trim().slice(0, 120),
            line,
        }));
        const suggested = candidates[Math.max(0, Math.min(candidates.length - 1, suggestedLine))];
        const orderedCandidates = suggested
            ? [suggested, ...candidates.filter((candidate) => candidate.line !== suggested.line)]
            : candidates;
        const picked = await vscode.window.showQuickPick(orderedCandidates, {
            title: loc('moveAnnotationsTitle', 'Move annotations'),
            placeHolder: loc(
                'pickDestinationLine',
                'Choose a destination line in {0}',
                vscode.workspace.asRelativePath(document.uri)
            ),
            matchOnDescription: true,
        });
        return picked?.line;
    }

    private async resolveSourceLocations(
        ids: readonly string[]
    ): Promise<Array<{ annotation: Readonly<AnnotationV2>; line: number }>> {
        const documents = new Map<string, vscode.TextDocument>();
        const result: Array<{ annotation: Readonly<AnnotationV2>; line: number }> = [];
        for (const id of ids) {
            const annotation = this.store.get(id);
            if (!annotation) {
                continue;
            }
            let document = documents.get(annotation.fileUri);
            if (!document) {
                document = await vscode.workspace.openTextDocument(vscode.Uri.parse(annotation.fileUri));
                documents.set(annotation.fileUri, document);
            }
            result.push({ annotation, line: document.positionAt(annotation.startOffset).line });
        }
        return result;
    }
}
