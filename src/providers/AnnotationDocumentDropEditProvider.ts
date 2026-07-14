// SPDX-License-Identifier: MPL-2.0
import * as vscode from 'vscode';
import { ANNOTATION_DRAG_MIME, AnnotationMoveService, parseAnnotationDragIds } from '../commands/AnnotationMoveService';
import { loc } from '../managers/LocalizationManager';
import { getLogger } from '../utils/logger';

export const ANNOTATION_EDITOR_DROP_KIND = vscode.DocumentDropOrPasteEditKind.Empty.append(
    'outOfCodeInsights',
    'moveAnnotation'
);

/** Moves TreeView annotations onto the exact line where they are dropped in a code editor. */
export class AnnotationDocumentDropEditProvider implements vscode.DocumentDropEditProvider {
    constructor(private readonly moveService: AnnotationMoveService) {}

    async provideDocumentDropEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        const item = dataTransfer.get(ANNOTATION_DRAG_MIME);
        if (!item || token.isCancellationRequested) {
            return undefined;
        }
        if (document.uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(document.uri) === undefined) {
            vscode.window.showWarningMessage(
                loc('editorDropWorkspaceRequired', 'Drop annotations onto a saved file inside the current workspace.')
            );
            return undefined;
        }

        const ids = parseAnnotationDragIds(await item.asString());
        if (ids.length === 0 || token.isCancellationRequested) {
            return undefined;
        }

        try {
            const result = await this.moveService.move({
                ids,
                targetFile: vscode.workspace.asRelativePath(document.uri),
                targetUri: document.uri.toString(),
                targetLine: position.line,
            });
            if (!result) {
                return undefined;
            }
            if (token.isCancellationRequested) {
                await this.moveService.rollbackMove(result);
                return undefined;
            }

            vscode.window.setStatusBarMessage(
                loc(
                    'editorDropComplete',
                    'Moved {0} annotation(s) to {1}, line {2}.',
                    result.movedIds.length,
                    result.file,
                    result.firstLine + 1
                ),
                5000
            );
            return new vscode.DocumentDropEdit(
                '',
                loc('editorDropTitle', 'Move annotations here'),
                ANNOTATION_EDITOR_DROP_KIND
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            getLogger().error('Drop Into Editor annotation move failed', error);
            vscode.window.showErrorMessage(loc('editorDropFailed', 'Unable to move annotations here: {0}', message));
            return undefined;
        }
    }
}

export const annotationDocumentDropMetadata: vscode.DocumentDropEditProviderMetadata = {
    dropMimeTypes: [ANNOTATION_DRAG_MIME],
    providedDropEditKinds: [ANNOTATION_EDITOR_DROP_KIND],
};
