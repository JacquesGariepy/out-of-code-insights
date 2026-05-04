import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { Annotation, LinkedAnnotation } from '../common/types';
import { AnnotationManager } from './AnnotationManager';
import { localize } from '../common/localize';
import { AnnotationTreeItem } from '../tree/AnnotationsTree';

interface LinkGraph {
    nodes: Array<{
        id: string;
        file: string;
        line: number;
        message: string;
        author?: string;
    }>;
    edges: Array<{
        source: string;
        target: string;
        relationship: string;
    }>;
}

export class LinkedAnnotationManager extends EventEmitter {
    private annotationManager: AnnotationManager;
    private linkIndicatorDecoration: vscode.TextEditorDecorationType;
    
    constructor(context: vscode.ExtensionContext, annotationManager: AnnotationManager) {
        super();
        this.annotationManager = annotationManager;
        
        // Create decoration type for link indicators
        this.linkIndicatorDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: '🔗',
                margin: '0 0 0 1em',
                color: new vscode.ThemeColor('editorCodeLens.foreground')
            }
        });
        
        // Listen for annotation changes to update decorations
        this.annotationManager.on('annotationChanged', () => {
            this.updateLinkDecorations();
        });
    }
    
    /**
     * Creates a link between two annotations
     */
    public async createLink(
        sourceId: string, 
        targetFile: string, 
        targetLine: number, 
        relationship = 'related'
    ): Promise<void> {
        const sourceAnnotation = this.annotationManager.annotations.get(sourceId);
        if (!sourceAnnotation) {
            throw new Error(localize('annotationNotFound', 'Source annotation not found'));
        }
        
        // Find target annotation
        const targetAnnotation = this.findAnnotationByLocation(targetFile, targetLine);
        if (!targetAnnotation) {
            throw new Error(localize('targetAnnotationNotFound', 'Target annotation not found at specified location'));
        }
        
        // Check for circular references
        if (this.wouldCreateCircularReference(sourceId, targetAnnotation.id)) {
            throw new Error(localize('circularReference', 'Cannot create link: would create circular reference'));
        }
        
        // Initialize linkedAnnotations array if not exists
        if (!sourceAnnotation.linkedAnnotations) {
            sourceAnnotation.linkedAnnotations = [];
        }
        
        // Check if link already exists
        const existingLink = sourceAnnotation.linkedAnnotations.find(
            link => link.targetFile === targetFile && link.targetLine === targetLine
        );
        
        if (existingLink) {
            throw new Error(localize('linkExists', 'Link already exists'));
        }
        
        // Add the link
        const newLink: LinkedAnnotation = {
            targetFile,
            targetLine,
            relationship
        };
        
        sourceAnnotation.linkedAnnotations.push(newLink);
        
        // Save annotations
        await this.annotationManager.saveAnnotations();
        
        // Emit event
        this.emit('linkCreated', { sourceId, targetFile, targetLine, relationship });
        
        // Update decorations
        this.updateLinkDecorations();
        
        // Trigger annotation changed event
        this.annotationManager.emit('annotationChanged');
    }
    
    /**
     * Removes a link between annotations
     */
    public async removeLink(sourceId: string, targetFile: string, targetLine: number): Promise<void> {
        const sourceAnnotation = this.annotationManager.annotations.get(sourceId);
        if (!sourceAnnotation || !sourceAnnotation.linkedAnnotations) {
            throw new Error(localize('annotationNotFound', 'Source annotation not found'));
        }
        
        const linkIndex = sourceAnnotation.linkedAnnotations.findIndex(
            link => link.targetFile === targetFile && link.targetLine === targetLine
        );
        
        if (linkIndex === -1) {
            throw new Error(localize('linkNotFound', 'Link not found'));
        }
        
        // Remove the link
        sourceAnnotation.linkedAnnotations.splice(linkIndex, 1);
        
        // Save annotations
        await this.annotationManager.saveAnnotations();
        
        // Emit event
        this.emit('linkRemoved', { sourceId, targetFile, targetLine });
        
        // Update decorations
        this.updateLinkDecorations();
        
        // Trigger annotation changed event
        this.annotationManager.emit('annotationChanged');
    }
    
    /**
     * Navigate to a linked annotation
     */
    public async goToLinkedAnnotation(sourceId: string, targetIndex = 0): Promise<void> {
        const sourceAnnotation = this.annotationManager.annotations.get(sourceId);
        if (!sourceAnnotation || !sourceAnnotation.linkedAnnotations || sourceAnnotation.linkedAnnotations.length === 0) {
            vscode.window.showWarningMessage(localize('noLinkedAnnotations', 'No linked annotations found'));
            return;
        }
        
        if (targetIndex < 0 || targetIndex >= sourceAnnotation.linkedAnnotations.length) {
            vscode.window.showErrorMessage(localize('invalidLinkIndex', 'Invalid link index'));
            return;
        }
        
        const link = sourceAnnotation.linkedAnnotations[targetIndex];
        
        try {
            // Open the target file
            const document = await vscode.workspace.openTextDocument(link.targetFile);
            const editor = await vscode.window.showTextDocument(document);
            
            // Navigate to the target line
            const position = new vscode.Position(link.targetLine, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            
            // Find and highlight the target annotation
            const targetAnnotation = this.findAnnotationByLocation(link.targetFile, link.targetLine);
            if (targetAnnotation) {
                // Add to navigation stack
                this.annotationManager.navigationStack.push(targetAnnotation.id);
                
                // Focus on the annotation if possible
                this.annotationManager.focusAnnotationInPanel(targetAnnotation.id);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('navigationFailed', 'Failed to navigate to linked annotation: {0}', String(error))
            );
        }
    }
    
    /**
     * Get all linked annotations for a given annotation
     */
    public getLinkedAnnotationsForAnnotation(annotationId: string): LinkedAnnotation[] {
        const annotation = this.annotationManager.annotations.get(annotationId);
        return annotation?.linkedAnnotations || [];
    }
    
    /**
     * Get all annotations that link to a given annotation
     */
    public getIncomingLinks(targetFile: string, targetLine: number): Array<{annotation: Annotation, relationship: string}> {
        const incomingLinks: Array<{annotation: Annotation, relationship: string}> = [];
        
        for (const annotation of this.annotationManager.annotations.values()) {
            if (annotation.linkedAnnotations) {
                for (const link of annotation.linkedAnnotations) {
                    if (link.targetFile === targetFile && link.targetLine === targetLine) {
                        incomingLinks.push({
                            annotation,
                            relationship: link.relationship
                        });
                    }
                }
            }
        }
        
        return incomingLinks;
    }
    
    /**
     * Export linked annotations in graph format
     */
    public exportAsGraph(): LinkGraph {
        const graph: LinkGraph = {
            nodes: [],
            edges: []
        };
        
        // Add all annotations as nodes
        for (const [id, annotation] of this.annotationManager.annotations) {
            graph.nodes.push({
                id,
                file: annotation.file,
                line: annotation.line,
                message: annotation.message,
                author: annotation.author
            });
        }
        
        // Add all links as edges
        for (const [sourceId, annotation] of this.annotationManager.annotations) {
            if (annotation.linkedAnnotations) {
                for (const link of annotation.linkedAnnotations) {
                    const targetAnnotation = this.findAnnotationByLocation(link.targetFile, link.targetLine);
                    if (targetAnnotation) {
                        graph.edges.push({
                            source: sourceId,
                            target: targetAnnotation.id,
                            relationship: link.relationship
                        });
                    }
                }
            }
        }
        
        return graph;
    }
    
    /**
     * Export linked annotations in DOT format for visualization
     */
    public exportAsDot(): string {
        const graph = this.exportAsGraph();
        let dot = 'digraph AnnotationLinks {\n';
        dot += '  rankdir=LR;\n';
        dot += '  node [shape=box, style=rounded];\n\n';
        
        // Add nodes
        for (const node of graph.nodes) {
            const label = `${node.file}:${node.line + 1}\\n${node.message.substring(0, 30)}...`;
            dot += `  "${node.id}" [label="${label}"];\n`;
        }
        
        dot += '\n';
        
        // Add edges
        for (const edge of graph.edges) {
            dot += `  "${edge.source}" -> "${edge.target}" [label="${edge.relationship}"];\n`;
        }
        
        dot += '}\n';
        return dot;
    }
    
    /**
     * Update tree view to show link indicators
     */
    public updateTreeViewLinkIndicators(): void {
        // Trigger tree refresh with link information
        if (this.annotationManager.annotationsTreeDataProvider) {
            this.annotationManager.annotationsTreeDataProvider.refresh();
        }
    }
    
    /**
     * Enhance tree item with link indicators
     */
    public enhanceTreeItem(treeItem: AnnotationTreeItem): void {
        const annotation = treeItem.annotation;
        if (!annotation) return;
        
        const linkCount = this.getLinkCount(annotation.id);
        const incomingLinks = this.getIncomingLinks(annotation.file, annotation.line);
        
        if (linkCount > 0 || incomingLinks.length > 0) {
            // Update label to show link indicator
            const linkIndicator = linkCount > 0 ? `🔗(${linkCount})` : '';
            const incomingIndicator = incomingLinks.length > 0 ? `⬅️(${incomingLinks.length})` : '';
            
            if (treeItem.description) {
                treeItem.description = `${treeItem.description} ${linkIndicator} ${incomingIndicator}`.trim();
            }
            
            // Update tooltip to include link information
            if (treeItem.tooltip instanceof vscode.MarkdownString) {
                let linkInfo = '';
                
                if (linkCount > 0) {
                    linkInfo += `\n**Outgoing Links:** ${linkCount}`;
                    const links = this.getLinkedAnnotationsForAnnotation(annotation.id);
                    links.forEach((link, index) => {
                        linkInfo += `\n  ${index + 1}. ${link.relationship} → ${link.targetFile}:${link.targetLine + 1}`;
                    });
                }
                
                if (incomingLinks.length > 0) {
                    linkInfo += `\n**Incoming Links:** ${incomingLinks.length}`;
                    incomingLinks.forEach((incoming, index) => {
                        linkInfo += `\n  ${index + 1}. ${incoming.relationship} ← ${incoming.annotation.file}:${incoming.annotation.line + 1}`;
                    });
                }
                
                treeItem.tooltip.appendMarkdown(linkInfo);
            }
            
            // Add context value for linked annotations
            treeItem.contextValue = linkCount > 0 ? 'annotation-linked' : 'annotation';
        }
    }
    
    /**
     * Check if annotation has any links
     */
    public hasLinks(annotationId: string): boolean {
        const annotation = this.annotationManager.annotations.get(annotationId);
        return !!(annotation?.linkedAnnotations && annotation.linkedAnnotations.length > 0);
    }
    
    /**
     * Get link count for an annotation
     */
    public getLinkCount(annotationId: string): number {
        const annotation = this.annotationManager.annotations.get(annotationId);
        return annotation?.linkedAnnotations?.length || 0;
    }
    
    /**
     * Update decorations to show link indicators in the editor
     */
    private updateLinkDecorations(): void {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;
        
        const decorations: vscode.DecorationOptions[] = [];
        const currentFile = activeEditor.document.uri.fsPath;
        
        // Find all annotations in current file that have links
        for (const [_id, annotation] of this.annotationManager.annotations) {
            if (annotation.file === currentFile && annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0) {
                const range = new vscode.Range(annotation.line, 0, annotation.line, 0);
                decorations.push({ range });
            }
        }
        
        activeEditor.setDecorations(this.linkIndicatorDecoration, decorations);
    }
    
    /**
     * Find annotation by file and line
     */
    private findAnnotationByLocation(file: string, line: number): Annotation | undefined {
        for (const annotation of this.annotationManager.annotations.values()) {
            if (annotation.file === file && annotation.line === line) {
                return annotation;
            }
        }
        return undefined;
    }
    
    /**
     * Check if creating a link would result in a circular reference
     */
    private wouldCreateCircularReference(sourceId: string, targetId: string): boolean {
        // If source and target are the same, it's circular
        if (sourceId === targetId) return true;
        
        // Use BFS to check if target can reach source
        const visited = new Set<string>();
        const queue = [targetId];
        
        while (queue.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const currentId = queue.shift()!;
            if (visited.has(currentId)) continue;
            visited.add(currentId);
            
            const currentAnnotation = this.annotationManager.annotations.get(currentId);
            if (currentAnnotation?.linkedAnnotations) {
                for (const link of currentAnnotation.linkedAnnotations) {
                    const linkedAnnotation = this.findAnnotationByLocation(link.targetFile, link.targetLine);
                    if (linkedAnnotation) {
                        if (linkedAnnotation.id === sourceId) {
                            return true; // Found circular reference
                        }
                        queue.push(linkedAnnotation.id);
                    }
                }
            }
        }
        
        return false;
    }
    
    /**
     * Get all annotations that are linked (either source or target)
     */
    public getLinkedAnnotations(): Map<string, Annotation> {
        const linkedAnnotations = new Map<string, Annotation>();
        
        // Add all annotations that have outgoing links
        for (const [id, annotation] of this.annotationManager.annotations) {
            if (annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0) {
                linkedAnnotations.set(id, annotation);
            }
        }
        
        // Add all annotations that are targets of links
        for (const annotation of this.annotationManager.annotations.values()) {
            if (annotation.linkedAnnotations) {
                for (const link of annotation.linkedAnnotations) {
                    const targetAnnotation = this.findAnnotationByLocation(link.targetFile, link.targetLine);
                    if (targetAnnotation && !linkedAnnotations.has(targetAnnotation.id)) {
                        linkedAnnotations.set(targetAnnotation.id, targetAnnotation);
                    }
                }
            }
        }
        
        return linkedAnnotations;
    }
    
    /**
     * Export linked annotations as JSON with full graph data
     */
    public exportLinkedAnnotationsAsJSON(): string {
        const graph = this.exportAsGraph();
        const linkedAnnotations = this.getLinkedAnnotations();
        
        const exportData = {
            timestamp: new Date().toISOString(),
            annotations: Array.from(linkedAnnotations.values()),
            graph: graph,
            statistics: {
                totalAnnotations: this.annotationManager.annotations.size,
                linkedAnnotations: linkedAnnotations.size,
                totalLinks: graph.edges.length,
                averageLinksPerAnnotation: graph.edges.length / Math.max(linkedAnnotations.size, 1)
            }
        };
        
        return JSON.stringify(exportData, null, 2);
    }
    
    /**
     * Find all paths between two annotations
     */
    public findPaths(sourceId: string, targetId: string, maxDepth = 5): string[][] {
        const paths: string[][] = [];
        const visited = new Set<string>();
        
        const dfs = (currentId: string, currentPath: string[], depth: number) => {
            if (depth > maxDepth) return;
            if (currentId === targetId) {
                paths.push([...currentPath]);
                return;
            }
            
            visited.add(currentId);
            const annotation = this.annotationManager.annotations.get(currentId);
            
            if (annotation?.linkedAnnotations) {
                for (const link of annotation.linkedAnnotations) {
                    const linkedAnnotation = this.findAnnotationByLocation(link.targetFile, link.targetLine);
                    if (linkedAnnotation && !visited.has(linkedAnnotation.id)) {
                        dfs(linkedAnnotation.id, [...currentPath, linkedAnnotation.id], depth + 1);
                    }
                }
            }
            
            visited.delete(currentId);
        };
        
        dfs(sourceId, [sourceId], 0);
        return paths;
    }
    
    /**
     * Get link statistics
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
        
        for (const [id, annotation] of this.annotationManager.annotations) {
            if (annotation.linkedAnnotations && annotation.linkedAnnotations.length > 0) {
                annotationsWithLinks.add(id);
                totalLinks += annotation.linkedAnnotations.length;
                maxLinks = Math.max(maxLinks, annotation.linkedAnnotations.length);
                
                for (const link of annotation.linkedAnnotations) {
                    const relationship = link.relationship || 'related';
                    relationshipCounts[relationship] = (relationshipCounts[relationship] || 0) + 1;
                }
            }
        }
        
        return {
            totalLinks,
            annotationsWithLinks: annotationsWithLinks.size,
            averageLinksPerAnnotation: annotationsWithLinks.size > 0 ? totalLinks / annotationsWithLinks.size : 0,
            maxLinks,
            relationshipCounts
        };
    }
    
    /**
     * Dispose of resources
     */
    public dispose(): void {
        this.linkIndicatorDecoration.dispose();
        this.removeAllListeners();
    }
}