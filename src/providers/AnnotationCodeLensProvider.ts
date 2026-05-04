import * as vscode from 'vscode';
import { AnnotationManager } from '../managers/AnnotationManager';

export class AnnotationCodeLensProvider implements vscode.CodeLensProvider {
    constructor(private annotationManager: AnnotationManager) {}

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!this.annotationManager.annotationsEnabled || !this.annotationManager.config.codelens.enable) {
            return [];
        }

        const annotations = this.annotationManager.getAnnotationsForFile(document.fileName);
        const processedLines = new Set<number>();
        const lenses: vscode.CodeLens[] = [];

        annotations.forEach(annotation => {
            if (this.annotationManager.shouldAnnotationBeVisible(annotation)) {
                const line = annotation.line;
                if (line >= 0 && line < document.lineCount && !processedLines.has(line)) {
                    const range = new vscode.Range(line, 0, line, 0);
                    const lineAnnotations = annotations.filter(a => a.line === line);
                    const title = `Manage ${lineAnnotations.length} annotation${lineAnnotations.length > 1 ? 's' : ''}`;
                    lenses.push(
                        new vscode.CodeLens(range, {
                            title,
                            command: 'annotations.manage',
                            arguments: [lineAnnotations],
                        })
                    );
                    processedLines.add(line);
                }
            }
        });

        return lenses;
    }
}
