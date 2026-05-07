import * as vscode from 'vscode';
import { localize } from '../common/localize';

export interface AnnotationTemplate {
    id: string;
    name: string;
    description?: string;
    content: string;
    tags?: string[];
    severity?: string;
    variables?: string[];
    isBuiltIn?: boolean;
}

export interface TemplateVariable {
    name: string;
    description?: string;
    defaultValue?: string;
}

const TEMPLATES_STORAGE_KEY = 'annotation.templates';

// Default built-in templates
const DEFAULT_TEMPLATES: AnnotationTemplate[] = [
    {
        id: 'bug',
        name: 'Bug',
        description: 'Report a bug or issue',
        content:
            'BUG: {{description}}\nSteps to reproduce:\n1. {{step1}}\n2. {{step2}}\nExpected: {{expected}}\nActual: {{actual}}',
        tags: ['bug'],
        severity: 'error',
        variables: ['description', 'step1', 'step2', 'expected', 'actual'],
        isBuiltIn: true,
    },
    {
        id: 'todo',
        name: 'TODO',
        description: 'Track a task that needs to be done',
        content: 'TODO: {{task}}\nPriority: {{priority}}\nDue: {{dueDate}}\nAssigned to: {{assignee}}',
        tags: ['todo'],
        severity: 'info',
        variables: ['task', 'priority', 'dueDate', 'assignee'],
        isBuiltIn: true,
    },
    {
        id: 'refactor',
        name: 'Refactor',
        description: 'Mark code that needs refactoring',
        content:
            'REFACTOR: {{reason}}\nCurrent issue: {{currentIssue}}\nProposed solution: {{proposedSolution}}\nEstimated effort: {{effort}}',
        tags: ['refactor', 'technical-debt'],
        severity: 'warning',
        variables: ['reason', 'currentIssue', 'proposedSolution', 'effort'],
        isBuiltIn: true,
    },
    {
        id: 'question',
        name: 'Question',
        description: 'Ask a question or request clarification',
        content: 'QUESTION: {{question}}\nContext: {{context}}\nPossible answers:\n- {{option1}}\n- {{option2}}',
        tags: ['question', 'help-wanted'],
        severity: 'info',
        variables: ['question', 'context', 'option1', 'option2'],
        isBuiltIn: true,
    },
    {
        id: 'architecture-decision',
        name: 'Architecture Decision',
        description: 'Document an architecture decision',
        content:
            'ADR: {{title}}\n\nStatus: {{status}}\n\nContext:\n{{context}}\n\nDecision:\n{{decision}}\n\nConsequences:\n{{consequences}}',
        tags: ['architecture', 'decision', 'adr'],
        severity: 'info',
        variables: ['title', 'status', 'context', 'decision', 'consequences'],
        isBuiltIn: true,
    },
];

export class TemplateManager {
    private context: vscode.ExtensionContext;
    private templates: Map<string, AnnotationTemplate>;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.templates = new Map();
        this.loadTemplates();
    }

    private loadTemplates(): void {
        // Load built-in templates
        DEFAULT_TEMPLATES.forEach((template) => {
            this.templates.set(template.id, template);
        });

        // Load custom templates from global state
        const customTemplates = this.context.globalState.get<AnnotationTemplate[]>(TEMPLATES_STORAGE_KEY, []);
        customTemplates.forEach((template) => {
            if (!template.isBuiltIn) {
                this.templates.set(template.id, template);
            }
        });
    }

    private saveCustomTemplates(): void {
        const customTemplates = Array.from(this.templates.values()).filter((t) => !t.isBuiltIn);
        this.context.globalState.update(TEMPLATES_STORAGE_KEY, customTemplates);
    }

    public getAllTemplates(): AnnotationTemplate[] {
        return Array.from(this.templates.values());
    }

    public getTemplate(id: string): AnnotationTemplate | undefined {
        return this.templates.get(id);
    }

    public async createTemplate(template: Omit<AnnotationTemplate, 'id'>): Promise<AnnotationTemplate> {
        const id = this.generateTemplateId(template.name);
        const newTemplate: AnnotationTemplate = {
            ...template,
            id,
            isBuiltIn: false,
            variables: this.extractVariables(template.content),
        };

        this.templates.set(id, newTemplate);
        this.saveCustomTemplates();

        return newTemplate;
    }

    public async updateTemplate(
        id: string,
        updates: Partial<AnnotationTemplate>
    ): Promise<AnnotationTemplate | undefined> {
        const template = this.templates.get(id);
        if (!template || template.isBuiltIn) {
            return undefined;
        }

        const updatedTemplate: AnnotationTemplate = {
            ...template,
            ...updates,
            id, // Ensure ID doesn't change
            isBuiltIn: false,
            variables: updates.content ? this.extractVariables(updates.content) : template.variables,
        };

        this.templates.set(id, updatedTemplate);
        this.saveCustomTemplates();

        return updatedTemplate;
    }

    public async deleteTemplate(id: string): Promise<boolean> {
        const template = this.templates.get(id);
        if (!template || template.isBuiltIn) {
            return false;
        }

        this.templates.delete(id);
        this.saveCustomTemplates();
        return true;
    }

    public async applyTemplate(template: AnnotationTemplate, variableValues?: Record<string, string>): Promise<string> {
        let content = template.content;
        const variables = this.extractVariables(content);

        // If no values provided, prompt for them
        if (!variableValues && variables.length > 0) {
            variableValues = await this.promptForVariables(variables);
            if (!variableValues) {
                throw new Error('Template application cancelled');
            }
        }

        // Replace variables with values
        if (variableValues) {
            for (const [variable, value] of Object.entries(variableValues)) {
                const regex = new RegExp(`{{\\s*${variable}\\s*}}`, 'g');
                content = content.replace(regex, value);
            }
        }

        // Replace any remaining variables with empty strings
        content = content.replace(/{{[^}]+}}/g, '');

        return content;
    }

    public async showTemplateQuickPick(): Promise<AnnotationTemplate | undefined> {
        const templates = this.getAllTemplates();

        const items: vscode.QuickPickItem[] = templates.map((template) => ({
            label: template.name,
            description: template.description,
            detail: template.isBuiltIn
                ? localize('builtInTemplate', 'Built-in template')
                : localize('customTemplate', 'Custom template'),
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: localize('selectTemplate', 'Select an annotation template'),
        });

        if (!selected) {
            return undefined;
        }

        return templates.find((t) => t.name === selected.label);
    }

    public async exportTemplates(): Promise<string> {
        const customTemplates = Array.from(this.templates.values()).filter((t) => !t.isBuiltIn);
        return JSON.stringify(customTemplates, null, 2);
    }

    public async importTemplates(jsonData: string): Promise<number> {
        try {
            const parsedTemplates = JSON.parse(jsonData);
            if (!Array.isArray(parsedTemplates)) {
                throw new Error('Invalid format: expected an array of templates.');
            }
            const importedTemplates = parsedTemplates as AnnotationTemplate[];
            let importCount = 0;

            for (const template of importedTemplates) {
                if (!template.isBuiltIn && template.id && template.name && template.content) {
                    // Generate new ID to avoid conflicts
                    const newId = this.generateTemplateId(template.name);
                    const newTemplate: AnnotationTemplate = {
                        ...template,
                        id: newId,
                        isBuiltIn: false,
                        variables: this.extractVariables(template.content),
                    };

                    this.templates.set(newId, newTemplate);
                    importCount++;
                }
            }

            if (importCount > 0) {
                this.saveCustomTemplates();
            }

            return importCount;
        } catch (error) {
            throw new Error(
                localize(
                    'importError',
                    'Failed to import templates: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                )
            );
        }
    }

    private extractVariables(content: string): string[] {
        const variableRegex = /{{\\s*([^}]+)\\s*}}/g;
        const variables = new Set<string>();
        let match;

        while ((match = variableRegex.exec(content)) !== null) {
            variables.add(match[1].trim());
        }

        return Array.from(variables);
    }

    private async promptForVariables(variables: string[]): Promise<Record<string, string> | undefined> {
        const values: Record<string, string> = {};

        for (const variable of variables) {
            const value = await vscode.window.showInputBox({
                prompt: localize('enterVariableValue', 'Enter value for {0}', variable),
                placeHolder: variable,
                validateInput: (value) => {
                    return value.trim() === '' ? localize('valueRequired', 'Value is required') : undefined;
                },
            });

            if (value === undefined) {
                return undefined; // User cancelled
            }

            values[variable] = value;
        }

        return values;
    }

    private generateTemplateId(name: string): string {
        const baseId = name
            .toLowerCase()
            .replace(/\\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
        let id = baseId;
        let counter = 1;

        while (this.templates.has(id)) {
            id = `${baseId}-${counter}`;
            counter++;
        }

        return id;
    }

    // UI Commands
    public async createTemplateFromUI(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: localize('templateName', 'Enter template name'),
            placeHolder: localize('templateNamePlaceholder', 'e.g., Performance Issue'),
            validateInput: (value) => {
                return value.trim() === '' ? localize('nameRequired', 'Name is required') : undefined;
            },
        });

        if (!name) {
            return;
        }

        const description = await vscode.window.showInputBox({
            prompt: localize('templateDescription', 'Enter template description (optional)'),
            placeHolder: localize('templateDescriptionPlaceholder', 'Brief description of the template'),
        });

        const content = await vscode.window.showInputBox({
            prompt: localize('templateContent', 'Enter template content (use {{variable}} for variables)'),
            placeHolder: localize('templateContentPlaceholder', 'e.g., Issue: {{description}}\\nImpact: {{impact}}'),
            validateInput: (value) => {
                return value.trim() === '' ? localize('contentRequired', 'Content is required') : undefined;
            },
        });

        if (!content) {
            return;
        }

        const tags = await vscode.window.showInputBox({
            prompt: localize('templateTags', 'Enter tags (comma-separated, optional)'),
            placeHolder: localize('templateTagsPlaceholder', 'e.g., bug, ui, critical'),
        });

        const tagArray = tags
            ? tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter((t) => t)
            : [];

        await this.createTemplate({
            name,
            description: description || undefined,
            content,
            tags: tagArray.length > 0 ? tagArray : undefined,
        });

        vscode.window.showInformationMessage(localize('templateCreated', 'Template "{0}" created successfully', name));
    }

    public async deleteTemplateFromUI(): Promise<void> {
        const templates = Array.from(this.templates.values()).filter((t) => !t.isBuiltIn);

        if (templates.length === 0) {
            vscode.window.showInformationMessage(localize('noCustomTemplates', 'No custom templates to delete'));
            return;
        }

        const items: vscode.QuickPickItem[] = templates.map((template) => ({
            label: template.name,
            description: template.description,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: localize('selectTemplateToDelete', 'Select a template to delete'),
        });

        if (!selected) {
            return;
        }

        const template = templates.find((t) => t.name === selected.label);
        if (!template) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            localize('confirmDeleteTemplate', 'Are you sure you want to delete the template "{0}"?', template.name),
            localize('delete', 'Delete'),
            localize('cancel', 'Cancel')
        );

        if (confirm === localize('delete', 'Delete')) {
            await this.deleteTemplate(template.id);
            vscode.window.showInformationMessage(
                localize('templateDeleted', 'Template "{0}" deleted successfully', template.name)
            );
        }
    }
}
