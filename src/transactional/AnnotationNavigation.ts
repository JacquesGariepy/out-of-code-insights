// SPDX-License-Identifier: MPL-2.0
//
// AnnotationNavigation — opens the document for an annotation, places the
// cursor at its anchor, and records the visit on a NavigationStack.
//
// Lot 5 R1 scope: minimal viable surface. The vscode-side editor calls
// (`showTextDocument`, `revealRange`) are routed via a small DI interface
// (`NavigationVsCodeApi`) so the class stays unit-testable in pure Node.
// Production wires the real vscode API at extension activation time.

import type { AnnotationStore } from './AnnotationStore';

/** Subset of NavigationStack used by AnnotationNavigation (push only). */
export interface NavigationStackLike {
    push(id: string): void;
}

/**
 * Subset of `vscode.window` / `vscode` API that AnnotationNavigation needs.
 * Production passes a thin wrapper around the real API; tests pass mocks.
 */
export interface NavigationVsCodeApi {
    /** Open the document at `fileUri` and place the cursor at `offset`. */
    openTextDocumentAt(fileUri: string, offset: number): Promise<void>;
    /** Reveal the annotation in the side panel / tree view, if available. */
    revealAnnotationInPanel?(annotationId: string): Promise<void>;
}

export class AnnotationNavigation {
    constructor(
        private readonly store: AnnotationStore,
        readonly stack: NavigationStackLike,
        private readonly api: NavigationVsCodeApi
    ) {}

    /**
     * Open the annotated document and place the cursor at the annotation's
     * `startOffset`. No-op if the id is unknown. Records the visit on the
     * navigation stack only when navigation succeeds.
     */
    async navigateToAnnotation(id: string): Promise<void> {
        const annotation = this.store.get(id);
        if (!annotation) {
            return;
        }
        await this.api.openTextDocumentAt(annotation.fileUri, annotation.startOffset);
        this.stack.push(id);
    }

    /**
     * Reveal the annotation in the dedicated side panel / tree view. Falls
     * back silently when no `revealAnnotationInPanel` adapter is wired.
     */
    async focusAnnotationInPanel(id: string): Promise<void> {
        if (!this.store.get(id)) {
            return;
        }
        if (this.api.revealAnnotationInPanel) {
            await this.api.revealAnnotationInPanel(id);
        }
    }

    dispose(): void {
        // Nothing to dispose in R1.
    }
}
