// SPDX-License-Identifier: MPL-2.0
//
// LinkedAnnotationManager — manages outgoing/incoming links between
// annotations. Lot 5 R2 worktree B: migrated from AnnotationManager to
// AnnotationStore + an optional AnnotationNavigation (for the post-jump
// navigation stack push and side-panel focus).
//
// Current links carry a stable target id/URI. Historical targetFile and
// targetLine fields remain readable as migration fallbacks.

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import type { LinkedAnnotation } from '../common/types';
import { localize } from '../common/localize';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { AnnotationNavigation } from '../transactional/AnnotationNavigation';
import type { AnnotationV2 } from '../transactional/types';

interface LinkGraphNode {
    id: string;
    file: string;
    line: number | null;
    message: string;
    author?: string;
}

interface LinkGraphEdge {
    source: string;
    target: string;
    relationship: string;
}

interface LinkGraph {
    nodes: LinkGraphNode[];
    edges: LinkGraphEdge[];
}

export class LinkedAnnotationManager extends EventEmitter {
    private readonly linkIndicatorDecoration: vscode.TextEditorDecorationType;
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        _context: vscode.ExtensionContext,
        private readonly store: AnnotationStore,
        private readonly navigation?: AnnotationNavigation
    ) {
        super();

        this.linkIndicatorDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: '🔗',
                margin: '0 0 0 1em',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
            },
        });

        this.subscriptions.push(
            this.store.onDidChange(() => {
                this.updateLinkDecorations();
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateLinkDecorations())
        );
    }

    /**
     * Creates a link between two annotations.
     */
    public async createLink(
        sourceId: string,
        targetFile: string,
        targetLine: number,
        relationship = 'related',
        targetId?: string
    ): Promise<void> {
        const sourceAnnotation = this.store.get(sourceId);
        if (!sourceAnnotation) {
            throw new Error(localize('sourceAnnotationNotFound', 'Source annotation not found'));
        }

        // A supplied stable id is authoritative. Falling back to the legacy
        // location when that id is stale can silently link to a different
        // annotation that later occupied the same line.
        const targetAnnotation =
            targetId !== undefined ? this.store.get(targetId) : this.findAnnotationByLocation(targetFile, targetLine);
        if (!targetAnnotation) {
            throw new Error(localize('targetAnnotationNotFound', 'Target annotation not found at specified location'));
        }

        if (this.wouldCreateCircularReference(sourceId, targetAnnotation.id)) {
            throw new Error(localize('circularReference', 'Cannot create link: would create circular reference'));
        }

        const existing = sourceAnnotation.linkedAnnotations ?? [];
        if (
            existing.some((link) =>
                link.targetId
                    ? link.targetId === targetAnnotation.id
                    : link.targetFile === targetFile && link.targetLine === targetLine
            )
        ) {
            throw new Error(localize('linkExists', 'Link already exists'));
        }

        const newLink: LinkedAnnotation = {
            targetId: targetAnnotation.id,
            targetUri: targetAnnotation.fileUri,
            targetFile: targetAnnotation.file,
            targetLine,
            relationship,
        };
        const linkedAnnotations = [...existing, newLink];
        this.store.update(sourceId, { linkedAnnotations });

        this.emit('linkCreated', { sourceId, targetFile, targetLine, relationship });
        this.updateLinkDecorations();
    }

    /**
     * Removes a link between annotations.
     */
    public async removeLink(
        sourceId: string,
        targetFile: string,
        targetLine: number,
        targetId?: string
    ): Promise<void> {
        const sourceAnnotation = this.store.get(sourceId);
        if (!sourceAnnotation || !sourceAnnotation.linkedAnnotations) {
            throw new Error(localize('sourceAnnotationNotFound', 'Source annotation not found'));
        }

        const linkIndex = sourceAnnotation.linkedAnnotations.findIndex((link) =>
            targetId !== undefined
                ? link.targetId === targetId
                : link.targetFile === targetFile && link.targetLine === targetLine
        );
        if (linkIndex === -1) {
            throw new Error(localize('linkNotFound', 'Link not found'));
        }

        const linkedAnnotations = sourceAnnotation.linkedAnnotations.filter((_, i) => i !== linkIndex);
        this.store.update(sourceId, { linkedAnnotations });

        this.emit('linkRemoved', { sourceId, targetFile, targetLine });
        this.updateLinkDecorations();
    }

    /**
     * Navigate to a linked annotation.
     */
    public async goToLinkedAnnotation(sourceId: string, targetIndex = 0): Promise<void> {
        const sourceAnnotation = this.store.get(sourceId);
        if (
            !sourceAnnotation ||
            !sourceAnnotation.linkedAnnotations ||
            sourceAnnotation.linkedAnnotations.length === 0
        ) {
            vscode.window.showWarningMessage(localize('noLinkedAnnotations', 'No linked annotations found'));
            return;
        }

        if (targetIndex < 0 || targetIndex >= sourceAnnotation.linkedAnnotations.length) {
            vscode.window.showErrorMessage(localize('invalidLinkIndex', 'Invalid link index'));
            return;
        }

        const link = sourceAnnotation.linkedAnnotations[targetIndex];

        try {
            const targetAnnotation = this.resolveLinkTarget(link);
            if (link.targetId && !targetAnnotation) {
                throw new Error(localize('targetAnnotationNotFound', 'The linked annotation no longer exists.'));
            }
            if (targetAnnotation && this.navigation) {
                await this.navigation.navigateToAnnotation(targetAnnotation.id);
                return;
            }

            const sourceWorkspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(sourceAnnotation.fileUri));
            const targetUri = link.targetUri
                ? vscode.Uri.parse(link.targetUri)
                : /^[a-z][a-z0-9+.-]*:/i.test(link.targetFile)
                  ? vscode.Uri.parse(link.targetFile)
                  : sourceWorkspace
                    ? vscode.Uri.joinPath(sourceWorkspace.uri, ...link.targetFile.split(/[\\/]/))
                    : vscode.Uri.file(link.targetFile);
            // Workspace membership is the security boundary. Requiring the
            // `file` scheme would incorrectly reject remote and virtual
            // workspace documents that VS Code can open safely.
            if (vscode.workspace.getWorkspaceFolder(targetUri) === undefined) {
                throw new Error(
                    localize('linkedTargetOutsideWorkspace', 'The linked target is outside the workspace.')
                );
            }
            const document = await vscode.workspace.openTextDocument(targetUri);
            const editor = await vscode.window.showTextDocument(document);

            if (link.targetLine < 0 || link.targetLine >= document.lineCount) {
                throw new Error(localize('linkedTargetLineInvalid', 'The linked target line is no longer valid.'));
            }
            const position = new vscode.Position(link.targetLine, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

            if (targetAnnotation && this.navigation) {
                this.navigation.stack.push(targetAnnotation.id);
                await this.navigation.focusAnnotationInPanel(targetAnnotation.id);
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('navigationFailed', 'Failed to navigate to linked annotation: {0}', String(error))
            );
            throw error;
        }
    }

    /**
     * Get all linked annotations for a given annotation.
     */
    public getLinkedAnnotationsForAnnotation(annotationId: string): LinkedAnnotation[] {
        const annotation = this.store.get(annotationId);
        return annotation?.linkedAnnotations ? [...annotation.linkedAnnotations] : [];
    }

    /**
     * Get all annotations that link to a given (file, line) target.
     */
    public getIncomingLinks(
        targetFile: string,
        targetLine: number,
        targetId?: string
    ): Array<{ annotation: Readonly<AnnotationV2>; relationship: string }> {
        const incoming: Array<{ annotation: Readonly<AnnotationV2>; relationship: string }> = [];
        const targetIdsAtLocation =
            targetId === undefined
                ? new Set(
                      this.store
                          .list()
                          .filter(
                              (annotation) =>
                                  annotation.file === targetFile &&
                                  this.store.getLineForAnnotation(annotation.id, vscode.workspace.textDocuments) ===
                                      targetLine
                          )
                          .map((annotation) => annotation.id)
                  )
                : undefined;

        for (const annotation of this.store.list()) {
            if (!annotation.linkedAnnotations) {
                continue;
            }
            for (const link of annotation.linkedAnnotations) {
                const matches = link.targetId
                    ? targetId !== undefined
                        ? link.targetId === targetId
                        : targetIdsAtLocation?.has(link.targetId) === true
                    : link.targetFile === targetFile && link.targetLine === targetLine;
                if (matches) {
                    incoming.push({ annotation, relationship: link.relationship });
                }
            }
        }
        return incoming;
    }

    /**
     * Export linked annotations in graph format. Lines are resolved against
     * currently-open documents; closed-file nodes carry `line: null`.
     */
    public exportAsGraph(): LinkGraph {
        const openDocs = vscode.workspace.textDocuments;
        const graph: LinkGraph = { nodes: [], edges: [] };

        for (const annotation of this.store.list()) {
            graph.nodes.push({
                id: annotation.id,
                file: annotation.file,
                line: this.store.getLineForAnnotation(annotation.id, openDocs),
                message: annotation.message,
                author: annotation.author,
            });
        }

        for (const annotation of this.store.list()) {
            if (!annotation.linkedAnnotations) {
                continue;
            }
            for (const link of annotation.linkedAnnotations) {
                const target = this.resolveLinkTarget(link);
                if (target) {
                    graph.edges.push({
                        source: annotation.id,
                        target: target.id,
                        relationship: link.relationship,
                    });
                }
            }
        }
        return graph;
    }

    /**
     * Export linked annotations in DOT format for visualization.
     */
    public exportAsDot(): string {
        const graph = this.exportAsGraph();
        let dot = 'digraph AnnotationLinks {\n';
        dot += '  rankdir=LR;\n';
        dot += '  node [shape=box, style=rounded];\n\n';

        for (const node of graph.nodes) {
            const lineLabel = node.line === null ? '?' : node.line + 1;
            const label = `${node.file}:${lineLabel}\\n${node.message.substring(0, 30)}...`;
            dot += `  "${node.id}" [label="${label}"];\n`;
        }

        dot += '\n';

        for (const edge of graph.edges) {
            dot += `  "${edge.source}" -> "${edge.target}" [label="${edge.relationship}"];\n`;
        }

        dot += '}\n';
        return dot;
    }

    /**
     * True iff the annotation has at least one outgoing link.
     */
    public hasLinks(annotationId: string): boolean {
        const annotation = this.store.get(annotationId);
        return !!(annotation?.linkedAnnotations && annotation.linkedAnnotations.length > 0);
    }

    /**
     * Number of outgoing links for an annotation.
     */
    public getLinkCount(annotationId: string): number {
        const annotation = this.store.get(annotationId);
        return annotation?.linkedAnnotations?.length ?? 0;
    }

    /**
     * Get all annotations that are involved in any link (source or target).
     */
    public getLinkedAnnotations(): Map<string, Readonly<AnnotationV2>> {
        const linked = new Map<string, Readonly<AnnotationV2>>();

        for (const annotation of this.store.list()) {
            if (annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0) {
                linked.set(annotation.id, annotation);
            }
        }

        for (const annotation of this.store.list()) {
            if (!annotation.linkedAnnotations) {
                continue;
            }
            for (const link of annotation.linkedAnnotations) {
                const target = this.resolveLinkTarget(link);
                if (target && !linked.has(target.id)) {
                    linked.set(target.id, target);
                }
            }
        }
        return linked;
    }

    /**
     * Export linked annotations as JSON with full graph data.
     */
    public exportLinkedAnnotationsAsJSON(): string {
        const graph = this.exportAsGraph();
        const linked = this.getLinkedAnnotations();

        const exportData = {
            timestamp: new Date().toISOString(),
            annotations: Array.from(linked.values()),
            graph,
            statistics: {
                totalAnnotations: this.store.size(),
                linkedAnnotations: linked.size,
                totalLinks: graph.edges.length,
                averageLinksPerAnnotation: graph.edges.length / Math.max(linked.size, 1),
            },
        };

        return JSON.stringify(exportData, null, 2);
    }

    /**
     * Find all paths between two annotations, bounded by `maxDepth`.
     */
    public findPaths(sourceId: string, targetId: string, maxDepth = 5): string[][] {
        const paths: string[][] = [];
        const visited = new Set<string>();

        const dfs = (currentId: string, currentPath: string[], depth: number): void => {
            if (depth > maxDepth) {
                return;
            }
            if (currentId === targetId) {
                paths.push([...currentPath]);
                return;
            }

            visited.add(currentId);
            const annotation = this.store.get(currentId);

            if (annotation?.linkedAnnotations) {
                for (const link of annotation.linkedAnnotations) {
                    const next = this.resolveLinkTarget(link);
                    if (next && !visited.has(next.id)) {
                        dfs(next.id, [...currentPath, next.id], depth + 1);
                    }
                }
            }

            visited.delete(currentId);
        };

        dfs(sourceId, [sourceId], 0);
        return paths;
    }

    /**
     * Aggregate link statistics across the store.
     */
    public getLinkStatistics(): {
        totalLinks: number;
        annotationsWithLinks: number;
        averageLinksPerAnnotation: number;
        maxLinks: number;
        relationshipCounts: Record<string, number>;
    } {
        let totalLinks = 0;
        let maxLinks = 0;
        const relationshipCounts: Record<string, number> = {};
        const annotationsWithLinks = new Set<string>();

        for (const annotation of this.store.list()) {
            if (annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0) {
                annotationsWithLinks.add(annotation.id);
                totalLinks += annotation.linkedAnnotations.length;
                maxLinks = Math.max(maxLinks, annotation.linkedAnnotations.length);

                for (const link of annotation.linkedAnnotations) {
                    const relationship = link.relationship || 'related';
                    relationshipCounts[relationship] = (relationshipCounts[relationship] ?? 0) + 1;
                }
            }
        }

        return {
            totalLinks,
            annotationsWithLinks: annotationsWithLinks.size,
            averageLinksPerAnnotation: annotationsWithLinks.size > 0 ? totalLinks / annotationsWithLinks.size : 0,
            maxLinks,
            relationshipCounts,
        };
    }

    public dispose(): void {
        this.linkIndicatorDecoration.dispose();
        for (const sub of this.subscriptions) {
            sub.dispose();
        }
        this.subscriptions.length = 0;
        this.removeAllListeners();
    }

    /**
     * Update editor decorations to show link indicators in the active editor.
     * Resolves annotation lines via the store + the editor's document so we
     * never read a non-existent `annotation.line` field.
     */
    private updateLinkDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const document = editor.document;
        const decorations: vscode.DecorationOptions[] = [];

        for (const annotation of this.store.listForFile(document.uri.toString())) {
            if (!annotation.linkedAnnotations || annotation.linkedAnnotations.length === 0) {
                continue;
            }
            const line = this.store.getLineForAnnotation(annotation.id, document);
            if (line === null) {
                continue;
            }
            decorations.push({ range: new vscode.Range(line, 0, line, 0) });
        }

        editor.setDecorations(this.linkIndicatorDecoration, decorations);
    }

    /**
     * Find an annotation by its (relative file path, 0-based line) pair.
     * Resolves the line against currently-open documents.
     */
    private findAnnotationByLocation(file: string, line: number): Readonly<AnnotationV2> | undefined {
        const openDocs = vscode.workspace.textDocuments;
        for (const annotation of this.store.list()) {
            if (annotation.file !== file) {
                continue;
            }
            if (this.store.getLineForAnnotation(annotation.id, openDocs) === line) {
                return annotation;
            }
        }
        return undefined;
    }

    private resolveLinkTarget(link: LinkedAnnotation): Readonly<AnnotationV2> | undefined {
        return link.targetId
            ? this.store.get(link.targetId)
            : this.findAnnotationByLocation(link.targetFile, link.targetLine);
    }

    /**
     * Check whether linking source → target would form a cycle.
     */
    private wouldCreateCircularReference(sourceId: string, targetId: string): boolean {
        if (sourceId === targetId) {
            return true;
        }

        const visited = new Set<string>();
        const queue = [targetId];

        while (queue.length > 0) {
            const currentId = queue.shift();
            if (currentId === undefined || visited.has(currentId)) {
                continue;
            }
            visited.add(currentId);

            const current = this.store.get(currentId);
            if (!current?.linkedAnnotations) {
                continue;
            }
            for (const link of current.linkedAnnotations) {
                const next = this.resolveLinkTarget(link);
                if (next) {
                    if (next.id === sourceId) {
                        return true;
                    }
                    queue.push(next.id);
                }
            }
        }
        return false;
    }
}
