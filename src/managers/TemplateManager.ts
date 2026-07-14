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

interface TemplateQuickPickItem extends vscode.QuickPickItem {
    templateId: string;
}

interface MutationResult<T> {
    result: T;
    changed: boolean;
}

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
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.templates = new Map();
        this.loadTemplates();
    }

    private loadTemplates(): void {
        // Load built-in templates
        DEFAULT_TEMPLATES.forEach((template) => {
            this.templates.set(template.id, this.cloneTemplate(template));
        });

        // Load custom templates from global state
        const storedTemplates = this.context.globalState.get<unknown>(TEMPLATES_STORAGE_KEY, []);
        if (!Array.isArray(storedTemplates)) {
            return;
        }

        storedTemplates.forEach((storedTemplate) => {
            if (!this.isImportableTemplate(storedTemplate)) {
                return;
            }

            try {
                const normalized = this.normalizeTemplate(storedTemplate);
                const storedId =
                    typeof storedTemplate.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(storedTemplate.id)
                        ? storedTemplate.id
                        : undefined;
                const id =
                    storedId && !this.templates.has(storedId) ? storedId : this.generateTemplateId(normalized.name);
                this.templates.set(id, {
                    ...normalized,
                    id,
                    isBuiltIn: false,
                    variables: this.extractVariables(normalized.content),
                });
            } catch {
                // Ignore malformed persisted entries without preventing the
                // remaining templates (including built-ins) from loading.
            }
        });
    }

    private async saveCustomTemplates(): Promise<void> {
        const customTemplates = Array.from(this.templates.values())
            .filter((template) => !template.isBuiltIn)
            .map((template) => this.cloneTemplate(template));
        await this.context.globalState.update(TEMPLATES_STORAGE_KEY, customTemplates);
    }

    public getAllTemplates(): AnnotationTemplate[] {
        return Array.from(this.templates.values(), (template) => this.cloneTemplate(template));
    }

    public getTemplate(id: string): AnnotationTemplate | undefined {
        const template = this.templates.get(id);
        return template ? this.cloneTemplate(template) : undefined;
    }

    public async createTemplate(template: Omit<AnnotationTemplate, 'id'>): Promise<AnnotationTemplate> {
        return this.enqueuePersistedMutation(() => {
            const normalized = this.normalizeTemplate(template);
            const id = this.generateTemplateId(normalized.name);
            const newTemplate: AnnotationTemplate = {
                ...normalized,
                id,
                isBuiltIn: false,
                variables: this.extractVariables(normalized.content),
            };

            this.templates.set(id, newTemplate);
            return { result: this.cloneTemplate(newTemplate), changed: true };
        });
    }

    public async updateTemplate(
        id: string,
        updates: Partial<AnnotationTemplate>
    ): Promise<AnnotationTemplate | undefined> {
        return this.enqueuePersistedMutation(() => {
            const template = this.templates.get(id);
            if (!template || template.isBuiltIn) {
                return { result: undefined, changed: false };
            }

            const normalized = this.normalizeTemplate({
                name: updates.name === undefined ? template.name : updates.name,
                description: Object.prototype.hasOwnProperty.call(updates, 'description')
                    ? updates.description
                    : template.description,
                content: updates.content === undefined ? template.content : updates.content,
                tags: Object.prototype.hasOwnProperty.call(updates, 'tags') ? updates.tags : template.tags,
                severity: Object.prototype.hasOwnProperty.call(updates, 'severity')
                    ? updates.severity
                    : template.severity,
            });
            const updatedTemplate: AnnotationTemplate = {
                ...normalized,
                id,
                isBuiltIn: false,
                variables: this.extractVariables(normalized.content),
            };

            this.templates.set(id, updatedTemplate);
            return { result: this.cloneTemplate(updatedTemplate), changed: true };
        });
    }

    public async deleteTemplate(id: string): Promise<boolean> {
        return this.enqueuePersistedMutation(() => {
            const template = this.templates.get(id);
            if (!template || template.isBuiltIn) {
                return { result: false, changed: false };
            }

            this.templates.delete(id);
            return { result: true, changed: true };
        });
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
            for (const variable of variables) {
                if (!Object.prototype.hasOwnProperty.call(variableValues, variable)) {
                    continue;
                }

                const value = variableValues[variable];
                if (typeof value !== 'string') {
                    throw new TypeError(`Template variable "${variable}" must be a string.`);
                }

                const regex = new RegExp(`{{\\s*${this.escapeRegExp(variable)}\\s*}}`, 'g');
                content = content.replace(regex, () => value);
            }
        }

        // Replace any remaining variables with empty strings
        content = content.replace(/{{\s*[^{}\r\n]+?\s*}}/g, '');

        return content;
    }

    public async showTemplateQuickPick(): Promise<AnnotationTemplate | undefined> {
        const templates = this.getAllTemplates();

        const items: TemplateQuickPickItem[] = templates.map((template) => ({
            label: template.name,
            description: template.description,
            detail: template.isBuiltIn
                ? localize('builtInTemplate', 'Built-in template')
                : localize('customTemplate', 'Custom template'),
            templateId: template.id,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: localize('selectTemplate', 'Select an annotation template'),
        });

        if (!selected) {
            return undefined;
        }

        return this.getTemplate(selected.templateId);
    }

    public async exportTemplates(): Promise<string> {
        const customTemplates = Array.from(this.templates.values()).filter((t) => !t.isBuiltIn);
        return JSON.stringify(customTemplates, null, 2);
    }

    public async importTemplates(jsonData: string): Promise<number> {
        try {
            const parsedTemplates: unknown = JSON.parse(jsonData);
            if (!Array.isArray(parsedTemplates)) {
                throw new Error('Invalid format: expected an array of templates.');
            }

            const candidates: Array<Omit<AnnotationTemplate, 'id' | 'isBuiltIn' | 'variables'>> = [];
            for (const parsedTemplate of parsedTemplates) {
                if (!this.isImportableTemplate(parsedTemplate)) {
                    continue;
                }

                try {
                    candidates.push(this.normalizeTemplate(parsedTemplate));
                } catch {
                    // Keep the import resilient: one malformed entry must not
                    // discard other valid templates in the same document.
                }
            }

            if (candidates.length === 0) {
                return 0;
            }

            return await this.enqueuePersistedMutation(() => {
                for (const candidate of candidates) {
                    const id = this.generateTemplateId(candidate.name);
                    this.templates.set(id, {
                        ...candidate,
                        id,
                        isBuiltIn: false,
                        variables: this.extractVariables(candidate.content),
                    });
                }

                return { result: candidates.length, changed: true };
            });
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
        const variableRegex = /{{\s*([^{}\r\n]+?)\s*}}/g;
        const variables = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = variableRegex.exec(content)) !== null) {
            const variable = match[1].trim();
            if (variable.length > 0) {
                variables.add(variable);
            }
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
        const baseId =
            name
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .trim()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '') || 'template';
        let id = baseId;
        let counter = 1;

        while (this.templates.has(id)) {
            id = `${baseId}-${counter}`;
            counter++;
        }

        return id;
    }

    private normalizeTemplate(template: unknown): Omit<AnnotationTemplate, 'id' | 'isBuiltIn' | 'variables'> {
        if (!template || typeof template !== 'object' || Array.isArray(template)) {
            throw new TypeError('Template must be an object.');
        }

        const candidate = template as Record<string, unknown>;
        if (typeof candidate.name !== 'string') {
            throw new TypeError('Template name must be a string.');
        }
        const name = candidate.name.trim().replace(/\s+/g, ' ');
        if (name.length === 0) {
            throw new TypeError('Template name is required.');
        }

        if (typeof candidate.content !== 'string') {
            throw new TypeError('Template content must be a string.');
        }
        if (candidate.content.trim().length === 0) {
            throw new TypeError('Template content is required.');
        }

        let description: string | undefined;
        if (candidate.description !== undefined) {
            if (typeof candidate.description !== 'string') {
                throw new TypeError('Template description must be a string.');
            }
            description = candidate.description.trim() || undefined;
        }

        let tags: string[] | undefined;
        if (candidate.tags !== undefined) {
            if (!Array.isArray(candidate.tags) || candidate.tags.some((tag) => typeof tag !== 'string')) {
                throw new TypeError('Template tags must be an array of strings.');
            }
            const normalizedTags = Array.from(
                new Set(candidate.tags.map((tag) => (tag as string).trim()).filter((tag) => tag.length > 0))
            );
            tags = normalizedTags.length > 0 ? normalizedTags : undefined;
        }

        let severity: string | undefined;
        if (candidate.severity !== undefined) {
            if (typeof candidate.severity !== 'string') {
                throw new TypeError('Template severity must be a string.');
            }
            severity = candidate.severity.trim() || undefined;
        }

        return {
            name,
            description,
            content: candidate.content,
            tags,
            severity,
        };
    }

    private isImportableTemplate(template: unknown): template is Record<string, unknown> {
        if (!template || typeof template !== 'object' || Array.isArray(template)) {
            return false;
        }

        const isBuiltIn = (template as Record<string, unknown>).isBuiltIn;
        return isBuiltIn === undefined || isBuiltIn === false;
    }

    private enqueuePersistedMutation<T>(mutation: () => MutationResult<T>): Promise<T> {
        const operation = this.mutationQueue.then(async () => {
            const previousTemplates = new Map(this.templates);
            const { result, changed } = mutation();

            if (!changed) {
                return result;
            }

            try {
                await this.saveCustomTemplates();
            } catch (error) {
                this.templates = previousTemplates;
                throw error;
            }

            return result;
        });

        this.mutationQueue = operation.then(
            () => undefined,
            () => undefined
        );
        return operation;
    }

    private cloneTemplate(template: AnnotationTemplate): AnnotationTemplate {
        return {
            ...template,
            tags: template.tags ? [...template.tags] : undefined,
            variables: template.variables ? [...template.variables] : undefined,
        };
    }

    private async editMultilineContent(initialContent: string, title: string): Promise<string | undefined> {
        const document = await vscode.workspace.openTextDocument({
            content: initialContent,
            language: 'markdown',
        });
        await vscode.window.showTextDocument(document, { preview: false });
        const useLabel = localize('useTemplateContent', 'Use This Content');
        const choice = await vscode.window.showInformationMessage(
            localize(
                'editTemplateContentInstructions',
                '{0}: edit the temporary document, then choose “{1}”.',
                title,
                useLabel
            ),
            useLabel
        );
        const closeTemporaryEditor = async (): Promise<void> => {
            if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        };
        if (choice !== useLabel) {
            await closeTemporaryEditor();
            return undefined;
        }
        const content = document.getText();
        if (!content.trim()) {
            vscode.window.showErrorMessage(localize('contentRequired', 'Content is required'));
            await closeTemporaryEditor();
            return undefined;
        }
        await closeTemporaryEditor();
        return content;
    }

    private async pickTemplateSeverity(current?: string): Promise<string | undefined> {
        const none = '__none__';
        const selected = await vscode.window.showQuickPick(
            [
                { label: localize('severityDefault', 'Default severity'), value: none },
                { label: '$(info) ' + localize('severityInfo', 'Info'), value: 'info' },
                { label: '$(warning) ' + localize('severityWarning', 'Warning'), value: 'warning' },
                { label: '$(error) ' + localize('severityError', 'Error'), value: 'error' },
                { label: '$(flame) ' + localize('severityCritical', 'Critical'), value: 'critical' },
            ],
            {
                title: localize('templateSeverity', 'Template severity'),
                placeHolder: current
                    ? localize('currentTemplateSeverity', 'Current severity: {0}', current)
                    : localize('chooseTemplateSeverity', 'Choose the severity applied by this template'),
            }
        );
        return selected ? (selected.value === none ? '' : selected.value) : undefined;
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

        const content = await this.editMultilineContent(
            localize('templateContentStarter', 'Issue: {{description}}\nImpact: {{impact}}'),
            localize('createTemplateContent', 'Create template content')
        );

        if (!content) {
            return;
        }

        const tags = await vscode.window.showInputBox({
            prompt: localize('templateTags', 'Enter tags (comma-separated, optional)'),
            placeHolder: localize('templateTagsPlaceholder', 'e.g., bug, ui, critical'),
        });
        const severity = await this.pickTemplateSeverity();
        if (severity === undefined) {
            return;
        }

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
            severity: severity || undefined,
        });

        vscode.window.showInformationMessage(localize('templateCreated', 'Template "{0}" created successfully', name));
    }

    public async manageTemplatesFromUI(): Promise<void> {
        const customCount = this.getAllTemplates().filter((template) => !template.isBuiltIn).length;
        const action = await vscode.window.showQuickPick(
            [
                { label: '$(add) ' + localize('createTemplate', 'Create template'), value: 'create' as const },
                {
                    label: '$(edit) ' + localize('editTemplate', 'Edit custom template'),
                    description: localize('customTemplateCount', '{0} custom', customCount),
                    value: 'edit' as const,
                },
                { label: '$(trash) ' + localize('deleteTemplate', 'Delete custom template'), value: 'delete' as const },
                {
                    label: '$(cloud-download) ' + localize('importTemplates', 'Import templates from JSON'),
                    value: 'import' as const,
                },
                {
                    label: '$(cloud-upload) ' + localize('exportTemplates', 'Export custom templates to JSON'),
                    value: 'export' as const,
                },
            ],
            {
                title: localize('manageTemplates', 'Manage annotation templates'),
                placeHolder: localize('selectTemplateAction', 'Choose a template action'),
            }
        );
        switch (action?.value) {
            case 'create':
                await this.createTemplateFromUI();
                break;
            case 'edit':
                await this.editTemplateFromUI();
                break;
            case 'delete':
                await this.deleteTemplateFromUI();
                break;
            case 'import':
                await this.importTemplatesFromUI();
                break;
            case 'export':
                await this.exportTemplatesFromUI();
                break;
        }
    }

    private async selectCustomTemplate(placeHolder: string): Promise<AnnotationTemplate | undefined> {
        const templates = this.getAllTemplates().filter((template) => !template.isBuiltIn);
        if (templates.length === 0) {
            vscode.window.showInformationMessage(localize('noCustomTemplates', 'No custom templates are available.'));
            return undefined;
        }
        const selected = await vscode.window.showQuickPick(
            templates.map((template) => ({
                label: template.name,
                description: template.description,
                detail: template.id,
                templateId: template.id,
            })),
            { placeHolder, matchOnDescription: true, matchOnDetail: true }
        );
        return selected ? this.getTemplate(selected.templateId) : undefined;
    }

    private async editTemplateFromUI(): Promise<void> {
        const template = await this.selectCustomTemplate(
            localize('selectTemplateToEdit', 'Select a custom template to edit')
        );
        if (!template) {
            return;
        }
        const name = await vscode.window.showInputBox({
            title: localize('editTemplateName', 'Edit template name'),
            value: template.name,
            validateInput: (value) => (value.trim() ? undefined : localize('nameRequired', 'Name is required')),
        });
        if (name === undefined) {
            return;
        }
        const description = await vscode.window.showInputBox({
            title: localize('editTemplateDescription', 'Edit template description'),
            value: template.description ?? '',
        });
        if (description === undefined) {
            return;
        }
        const content = await this.editMultilineContent(
            template.content,
            localize('editTemplateContent', 'Edit template content')
        );
        if (content === undefined) {
            return;
        }
        const tags = await vscode.window.showInputBox({
            title: localize('editTemplateTags', 'Edit template tags'),
            prompt: localize('enterTags', 'Enter tags separated by commas'),
            value: (template.tags ?? []).join(', '),
        });
        if (tags === undefined) {
            return;
        }
        const severity = await this.pickTemplateSeverity(template.severity);
        if (severity === undefined) {
            return;
        }
        await this.updateTemplate(template.id, {
            name,
            description: description || undefined,
            content,
            tags: tags
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            severity: severity || undefined,
        });
        vscode.window.showInformationMessage(localize('templateUpdated', 'Template "{0}" updated.', name.trim()));
    }

    private async importTemplatesFromUI(): Promise<void> {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { JSON: ['json'] },
            title: localize('importTemplates', 'Import annotation templates'),
        });
        const uri = selected?.[0];
        if (!uri) {
            return;
        }
        const imported = await this.importTemplates(
            Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
        );
        if (imported === 0) {
            vscode.window.showWarningMessage(
                localize('noTemplatesImported', 'The selected file did not contain any valid custom templates.')
            );
            return;
        }
        vscode.window.showInformationMessage(localize('templatesImported', '{0} template(s) imported.', imported));
    }

    private async exportTemplatesFromUI(): Promise<void> {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = workspace
            ? vscode.Uri.joinPath(workspace, '.out-of-code-insights', 'annotation-templates.json')
            : undefined;
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { JSON: ['json'] },
            title: localize('exportTemplates', 'Export annotation templates'),
        });
        if (!uri) {
            return;
        }
        const json = await this.exportTemplates();
        await vscode.workspace.fs.writeFile(uri, Buffer.from(`${json}\n`, 'utf8'));
        vscode.window.showInformationMessage(
            localize('templatesExported', 'Custom templates exported to {0}.', uri.fsPath)
        );
    }

    public async deleteTemplateFromUI(): Promise<void> {
        const templates = Array.from(this.templates.values()).filter((t) => !t.isBuiltIn);

        if (templates.length === 0) {
            vscode.window.showInformationMessage(localize('noCustomTemplates', 'No custom templates to delete'));
            return;
        }

        const items: TemplateQuickPickItem[] = templates.map((template) => ({
            label: template.name,
            description: template.description,
            templateId: template.id,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: localize('selectTemplateToDelete', 'Select a template to delete'),
        });

        if (!selected) {
            return;
        }

        const template = this.getTemplate(selected.templateId);
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
