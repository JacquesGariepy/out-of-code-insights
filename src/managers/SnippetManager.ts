import * as vscode from 'vscode';
import * as path from 'path';
import { Annotation } from '../common/types';
import { localize } from '../common/localize';

export interface SnippetVariable {
    index: number;
    name: string;
    placeholder: string;
    defaultValue: string;
}

export interface SnippetHistoryEntry {
    annotationId: string;
    timestamp: string;
    originalCode: string;
    appliedCode: string;
    file: string;
    line: number;
    range: vscode.Range;
}

export interface SnippetPreview {
    original: string;
    modified: string;
    diff: string[];
    language: string;
}

export class SnippetManager {
    private static instance: SnippetManager;
    private snippetHistory: Map<string, SnippetHistoryEntry[]> = new Map();
    private languageMap: Map<string, string> = new Map([
        ['.ts', 'typescript'],
        ['.js', 'javascript'],
        ['.tsx', 'typescriptreact'],
        ['.jsx', 'javascriptreact'],
        ['.py', 'python'],
        ['.java', 'java'],
        ['.cpp', 'cpp'],
        ['.c', 'c'],
        ['.cs', 'csharp'],
        ['.go', 'go'],
        ['.rs', 'rust'],
        ['.rb', 'ruby'],
        ['.php', 'php'],
        ['.swift', 'swift'],
        ['.kt', 'kotlin'],
        ['.scala', 'scala'],
        ['.r', 'r'],
        ['.dart', 'dart'],
        ['.html', 'html'],
        ['.css', 'css'],
        ['.scss', 'scss'],
        ['.sass', 'sass'],
        ['.less', 'less'],
        ['.json', 'json'],
        ['.xml', 'xml'],
        ['.yaml', 'yaml'],
        ['.yml', 'yaml'],
        ['.md', 'markdown'],
        ['.sql', 'sql'],
        ['.sh', 'shellscript'],
        ['.ps1', 'powershell'],
        ['.lua', 'lua'],
        ['.vim', 'vim'],
        ['.dockerfile', 'dockerfile'],
    ]);

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    private constructor() {}

    public static getInstance(): SnippetManager {
        if (!SnippetManager.instance) {
            SnippetManager.instance = new SnippetManager();
        }
        return SnippetManager.instance;
    }

    /**
     * Adds a code snippet to an annotation
     */
    public async addSnippet(
        annotation: Annotation,
        code: string,
        language?: string
    ): Promise<Annotation> {
        const detectedLanguage = language || this.detectLanguage(annotation.file);
        
        // Process snippet variables
        const processedCode = this.processSnippetVariables(code);
        
        return {
            ...annotation,
            snippet: {
                code: processedCode,
                language: detectedLanguage
            }
        };
    }

    /**
     * Previews how a snippet will look when applied
     */
    public async previewSnippet(
        annotation: Annotation,
        editor: vscode.TextEditor
    ): Promise<SnippetPreview | undefined> {
        if (!annotation.snippet) {
            return undefined;
        }

        const document = editor.document;
        const line = annotation.line - 1;
        
        if (line < 0 || line >= document.lineCount) {
            return undefined;
        }

        // Get the current line content
        const currentLine = document.lineAt(line);
        const originalCode = currentLine.text;
        
        // Get the snippet code without variables
        const modifiedCode = this.expandSnippetVariables(annotation.snippet.code);
        
        // Generate diff
        const diff = this.generateDiff(originalCode, modifiedCode);
        
        return {
            original: originalCode,
            modified: modifiedCode,
            diff,
            language: annotation.snippet.language
        };
    }

    /**
     * Applies a snippet to replace code in the editor
     */
    public async applySnippet(
        annotation: Annotation,
        editor: vscode.TextEditor
    ): Promise<boolean> {
        if (!annotation.snippet) {
            vscode.window.showErrorMessage(localize('noSnippet', 'No snippet found in annotation'));
            return false;
        }

        const document = editor.document;
        const line = annotation.line - 1;
        
        if (line < 0 || line >= document.lineCount) {
            vscode.window.showErrorMessage(localize('invalidLine', 'Invalid line number'));
            return false;
        }

        try {
            // Get the current line
            const currentLine = document.lineAt(line);
            const range = currentLine.range;
            const originalCode = currentLine.text;
            
            // Prepare the snippet for insertion
            const snippetString = new vscode.SnippetString(annotation.snippet.code);
            
            // Store in history before applying
            this.addToHistory(annotation, originalCode, annotation.snippet.code, document.uri.fsPath, line, range);
            
            // Apply the snippet
            await editor.insertSnippet(snippetString, range);
            
            vscode.window.showInformationMessage(localize('snippetApplied', 'Snippet applied successfully'));
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(localize('snippetError', 'Failed to apply snippet: {0}', (error as Error).message));
            return false;
        }
    }

    /**
     * Gets the diff between current code and snippet
     */
    public getSnippetDiff(original: string, modified: string): string[] {
        return this.generateDiff(original, modified);
    }

    /**
     * Validates a snippet for syntax and variables
     */
    public validateSnippet(code: string, language: string): {
        valid: boolean;
        errors: string[];
        warnings: string[];
        variables: SnippetVariable[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];
        const variables: SnippetVariable[] = [];
        
        // Check for balanced brackets/braces based on language
        if (!this.checkBalancedDelimiters(code, language)) {
            errors.push(localize('unbalancedDelimiters', 'Unbalanced brackets or braces detected'));
        }
        
        // Extract and validate snippet variables
        const variablePattern = /\$\{(\d+):([^}]+)\}|\$(\d+)/g;
        let match;
        const seenIndices = new Set<number>();
        
        while ((match = variablePattern.exec(code)) !== null) {
            const index = parseInt(match[1] || match[3]);
            const placeholder = match[2] || '';
            
            if (seenIndices.has(index)) {
                warnings.push(localize('duplicateVariable', 'Duplicate variable index: {0}', index));
            }
            seenIndices.add(index);
            
            variables.push({
                index,
                name: `var${index}`,
                placeholder,
                defaultValue: placeholder
            });
        }
        
        // Check for sequential variable indices
        if (variables.length > 0) {
            const sortedIndices = Array.from(seenIndices).sort((a, b) => a - b);
            for (let i = 1; i <= sortedIndices[sortedIndices.length - 1]; i++) {
                if (!seenIndices.has(i)) {
                    warnings.push(localize('missingVariableIndex', 'Missing variable index: {0}', i));
                }
            }
        }
        
        // Language-specific validations
        this.performLanguageSpecificValidation(code, language, errors, warnings);
        
        return {
            valid: errors.length === 0,
            errors,
            warnings,
            variables
        };
    }

    /**
     * Gets snippet history for a file
     */
    public getSnippetHistory(file?: string): SnippetHistoryEntry[] {
        if (file) {
            return this.snippetHistory.get(file) || [];
        }
        
        // Return all history entries
        const allHistory: SnippetHistoryEntry[] = [];
        for (const entries of this.snippetHistory.values()) {
            allHistory.push(...entries);
        }
        return allHistory.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    /**
     * Clears snippet history
     */
    public clearHistory(file?: string): void {
        if (file) {
            this.snippetHistory.delete(file);
        } else {
            this.snippetHistory.clear();
        }
    }

    /**
     * Undoes the last snippet application
     */
    public async undoLastSnippet(file: string): Promise<boolean> {
        const history = this.snippetHistory.get(file);
        if (!history || history.length === 0) {
            vscode.window.showInformationMessage(localize('noHistory', 'No snippet history found'));
            return false;
        }

        const lastEntry = history[history.length - 1];
        const editor = vscode.window.activeTextEditor;
        
        if (!editor || editor.document.uri.fsPath !== file) {
            vscode.window.showErrorMessage(localize('wrongFile', 'Please open the target file in the editor'));
            return false;
        }

        try {
            await editor.edit(editBuilder => {
                editBuilder.replace(lastEntry.range, lastEntry.originalCode);
            });
            
            // Remove from history
            history.pop();
            if (history.length === 0) {
                this.snippetHistory.delete(file);
            }
            
            vscode.window.showInformationMessage(localize('snippetUndone', 'Snippet application undone'));
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(localize('undoError', 'Failed to undo snippet: {0}', (error as Error).message));
            return false;
        }
    }

    /**
     * Detects language from file extension
     */
    private detectLanguage(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        return this.languageMap.get(ext) || 'plaintext';
    }

    /**
     * Processes snippet variables for storage
     */
    private processSnippetVariables(code: string): string {
        // Ensure variables are properly formatted
        return code.replace(/\$\{(\d+)\}/g, '${$1:}');
    }

    /**
     * Expands snippet variables with default values
     */
    private expandSnippetVariables(code: string): string {
        return code.replace(/\$\{(\d+):([^}]*)\}/g, '$2').replace(/\$(\d+)/g, '');
    }

    /**
     * Generates a simple diff between two strings
     */
    private generateDiff(original: string, modified: string): string[] {
        const diff: string[] = [];
        
        if (original === modified) {
            diff.push('  ' + original);
            return diff;
        }
        
        // Simple line-based diff
        diff.push('- ' + original);
        diff.push('+ ' + modified);
        
        return diff;
    }

    /**
     * Checks for balanced delimiters based on language
     */
    private checkBalancedDelimiters(code: string, language: string): boolean {
        const pairs: { [key: string]: string } = {
            '{': '}',
            '[': ']',
            '(': ')',
        };
        
        // Skip string literals and comments based on language
        const cleanCode = this.removeStringLiteralsAndComments(code, language);
        
        const stack: string[] = [];
        for (const char of cleanCode) {
            if (Object.keys(pairs).includes(char)) {
                stack.push(char);
            } else if (Object.values(pairs).includes(char)) {
                const last = stack.pop();
                if (!last || pairs[last] !== char) {
                    return false;
                }
            }
        }
        
        return stack.length === 0;
    }

    /**
     * Removes string literals and comments for delimiter checking
     */
    private removeStringLiteralsAndComments(code: string, language: string): string {
        // Simplified implementation - in production, use proper lexer
        let cleanCode = code;
        
        // Remove string literals
        cleanCode = cleanCode.replace(/"([^"\\]|\\.)*"/g, '');
        cleanCode = cleanCode.replace(/'([^'\\]|\\.)*'/g, '');
        cleanCode = cleanCode.replace(/`([^`\\]|\\.)*`/g, '');
        
        // Remove comments based on language
        if (['javascript', 'typescript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin', 'scala', 'dart'].includes(language)) {
            cleanCode = cleanCode.replace(/\/\/.*$/gm, '');
            cleanCode = cleanCode.replace(/\/\*[\s\S]*?\*\//g, '');
        } else if (['python', 'ruby', 'shell', 'yaml', 'r'].includes(language)) {
            cleanCode = cleanCode.replace(/#.*$/gm, '');
        } else if (language === 'sql') {
            cleanCode = cleanCode.replace(/--.*$/gm, '');
        }
        
        return cleanCode;
    }

    /**
     * Performs language-specific validation
     */
    private performLanguageSpecificValidation(code: string, language: string, errors: string[], warnings: string[]): void {
        // Add language-specific checks here
        switch (language) {
            case 'python': {
                const lines = code.split('\n');
                const indentations = lines.map(line => line.match(/^(\s*)/)?.[1].length || 0);
                const nonZeroIndents = indentations.filter(i => i > 0);
                if (nonZeroIndents.length > 0) {
                    const firstIndent = nonZeroIndents[0];
                    const inconsistent = nonZeroIndents.some(i => i % firstIndent !== 0);
                    if (inconsistent) {
                        warnings.push(localize('inconsistentIndentation', 'Inconsistent indentation detected'));
                    }
                }
                break;
            }
                
            case 'javascript':
            case 'typescript':
                // Check for missing semicolons (optional warning)
                if (!/[;}]\s*$/.test(code.trim()) && !/^\s*(if|for|while|function|class|const|let|var)/.test(code)) {
                    warnings.push(localize('missingSemicolon', 'Statement may be missing a semicolon'));
                }
                break;
        }
    }

    /**
     * Adds an entry to snippet history
     */
    private addToHistory(
        annotation: Annotation,
        originalCode: string,
        appliedCode: string,
        file: string,
        line: number,
        range: vscode.Range
    ): void {
        const entry: SnippetHistoryEntry = {
            annotationId: annotation.id,
            timestamp: new Date().toISOString(),
            originalCode,
            appliedCode,
            file,
            line,
            range
        };
        
        if (!this.snippetHistory.has(file)) {
            this.snippetHistory.set(file, []);
        }
        
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.snippetHistory.get(file)!.push(entry);

        // Limit history size per file
        const maxHistorySize = 50;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const history = this.snippetHistory.get(file)!;
        if (history.length > maxHistorySize) {
            history.splice(0, history.length - maxHistorySize);
        }
    }

    /**
     * Exports snippet history to JSON
     */
    public exportHistory(): string {
        const historyObject: { [file: string]: SnippetHistoryEntry[] } = {};
        for (const [file, entries] of this.snippetHistory.entries()) {
            historyObject[file] = entries;
        }
        return JSON.stringify(historyObject, null, 2);
    }

    /**
     * Imports snippet history from JSON
     */
    public importHistory(json: string): boolean {
        try {
            const historyObject = JSON.parse(json);
            this.snippetHistory.clear();
            
            for (const [file, entries] of Object.entries(historyObject)) {
                if (Array.isArray(entries)) {
                    this.snippetHistory.set(file, entries as SnippetHistoryEntry[]);
                }
            }
            
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(localize('importError', 'Failed to import history: {0}', (error as Error).message));
            return false;
        }
    }
}