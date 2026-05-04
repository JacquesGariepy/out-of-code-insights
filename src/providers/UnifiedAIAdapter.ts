import * as vscode from 'vscode';
import * as path from 'path';
import { AnnotationManager } from '../managers/AnnotationManager';
import { UserProfileManager } from '../managers/UserProfileManager';
import { UnifiedAIProvider } from './UnifiedAIProvider';
import { Annotation } from '../common/types';
import { localize } from '../common/localize';
import { loc } from '../managers/LocalizationManager';
import { AIProfileManager } from '../managers/AIProfileManager';

export class UnifiedAIAdapter {
    private aiProvider: UnifiedAIProvider | null = null;
    private profileManager: UserProfileManager;
    private annotationManager: AnnotationManager;
    private context: vscode.ExtensionContext;
    private aiProfileManager: AIProfileManager;

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }

    private getRelativePath(filePath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return filePath;
        }
        const normalizedFilePath = this.normalizePath(filePath);
        const workspaceFolder = workspaceFolders.find(folder =>
            normalizedFilePath.startsWith(this.normalizePath(folder.uri.fsPath))
        );
        if (workspaceFolder) {
            return normalizedFilePath.slice(this.normalizePath(workspaceFolder.uri.fsPath).length + 1);
        }
        return normalizedFilePath;
    }

    private normalizePath(filePath: string): string {
        if (typeof filePath !== 'string') {
            return filePath;
        }
        return path.normalize(filePath).replace(/\\/g, '/');
    }

    constructor(
        context: vscode.ExtensionContext,
        annotationManager: AnnotationManager,
        profileManager: UserProfileManager,
        aiProfileManager?: AIProfileManager
    ) {
        this.context = context;
        this.annotationManager = annotationManager;
        this.profileManager = profileManager;
        this.aiProfileManager = aiProfileManager || new AIProfileManager(context);
        
        // Listen for profile changes
        this.aiProfileManager.on('profilesChanged', async () => {
            try {
                await this.refreshAIProfiles();
            } catch (error) {
                console.error('UnifiedAIAdapter: Error refreshing profiles:', error);
            }
        });
        
        this.registerCommands();
    }

    private async initializeAIProvider(): Promise<void> {
        // Ensure profiles are loaded from disk first
        await this.aiProfileManager.ensureLoaded();
        
        const config = vscode.workspace.getConfiguration('annotation');
        const provider = config.get<string>('provider', 'openai');
        const model = config.get<string>('model', 'gpt-4o-mini');
        const llmConfig = vscode.workspace.getConfiguration('llm');
        const apiKeys = llmConfig.get<Record<string, string>>('apiKeys', {});

        // Check if provider changed
        if (this.aiProvider && this.aiProvider.getCurrentProvider() === provider) {
            // Just ensure it's initialized
            await this.aiProvider.ensureInitialized();
            return;
        }

        // Create new provider if needed
        this.aiProvider = new UnifiedAIProvider({
            provider,
            model,
            apiKeys,
            context: this.context
        });

        const initialized = await this.aiProvider.initialize();
        if (!initialized) {
            // Show specific error for missing API key
            const missingKey = !apiKeys[provider];
            if (missingKey) {
                const action = await vscode.window.showErrorMessage(
                    loc('noApiKeyConfigured', `No API key configured for ${provider}. You need to add your API key to use AI features.`),
                    loc('updateApiKey', 'Update API Key'),
                    loc('openSettings', 'Open Settings')
                );
                if (action === 'Update API Key') {
                    await this.updateApiKey();
                    return; // Exit after updating key - user can retry the action
                } else if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', `llm.apiKeys.${provider}`);
                }
            }
            this.aiProvider = null;
            throw new Error(`Failed to initialize AI provider: ${provider}. Please ensure your API key is configured.`);
        }

        // Add custom profiles
        const customProfiles = this.aiProfileManager.getCustomProfiles();
        for (const profile of customProfiles) {
            this.aiProvider.addCustomProfile(profile);
        }

        // Set active profile based on user configuration
        const userProfile = this.profileManager.getActiveProfile();
        if (userProfile?.preferences.claudeProfileId) {
            this.aiProvider.setActiveProfile(userProfile.preferences.claudeProfileId);
        }
    }

    private registerCommands(): void {
        // Update API key command
        const updateApiKeyCmd = vscode.commands.registerCommand(
            'annotations.updateApiKey',
            async () => {
                await this.updateApiKey();
            }
        );
        // Profile selection command
        const selectProfileCmd = vscode.commands.registerCommand(
            'annotations.selectProfile',
            async () => {
                await this.showEnhancedProfileSelector();
            }
        );

        // Manage profiles command
        const manageProfilesCmd = vscode.commands.registerCommand(
            'annotations.manageProfiles',
            async () => {
                await this.profileManager.showProfileManager();
            }
        );

        // AI suggest with profile
        const aiSuggestWithProfileCmd = vscode.commands.registerCommand(
            'annotations.aiSuggestWithProfile',
            async () => {
                await this.aiSuggestWithProfile();
            }
        );

        // AI analyze file command
        const aiAnalyzeFileCmd = vscode.commands.registerCommand(
            'annotations.aiAnalyzeFile',
            async () => {
                await this.analyzeCurrentFile();
            }
        );

        // AI batch annotate command
        const aiBatchAnnotateCmd = vscode.commands.registerCommand(
            'annotations.aiBatchAnnotate',
            async () => {
                await this.batchAnnotateFile();
            }
        );

        // AI analyze file with profile selection command
        const aiAnalyzeFileWithProfileCmd = vscode.commands.registerCommand(
            'annotations.aiAnalyzeFileWithProfile',
            async () => {
                await this.analyzeFileWithProfile();
            }
        );

        // Batch create mixed command
        const batchCreateMixedCmd = vscode.commands.registerCommand(
            'annotations.batchCreateMixed',
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const selection = editor.selection;
                    const selectedText = editor.document.getText(selection.isEmpty ? undefined : selection);
                    await this.batchCreateMixed(editor, selection, selectedText);
                }
            }
        );

        this.context.subscriptions.push(
            selectProfileCmd,
            manageProfilesCmd,
            aiSuggestWithProfileCmd,
            aiAnalyzeFileCmd,
            aiBatchAnnotateCmd,
            aiAnalyzeFileWithProfileCmd,
            batchCreateMixedCmd,
            updateApiKeyCmd
        );
    }

    private async aiSuggestWithProfile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        try {
            await this.initializeAIProvider();
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('aiInitError', 'Failed to initialize AI provider: ') + error
            );
            return;
        }

        // Show profile selector with custom profiles included
        const profiles = this.aiProvider?.getProfiles() || [];
        const customProfiles = this.aiProfileManager.getCustomProfiles();
        
        // Create items for both built-in and custom profiles
        const builtInItems = profiles.map(p => ({
            label: `$(account) ${p.name}`,
            description: p.description,
            detail: 'Built-in profile',
            profile: p,
            type: 'builtin'
        }));
        
        const customItems = customProfiles.map(p => ({
            label: `$(star) ${p.name}`,
            description: p.description,
            detail: 'Custom profile',
            profile: p,
            type: 'custom'
        }));
        
        // Combine all items with separator
        const allItems = [...builtInItems];
        if (customItems.length > 0) {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            allItems.push({
                label: '',
                kind: vscode.QuickPickItemKind.Separator
            } as any);
            /* eslint-enable @typescript-eslint/no-explicit-any */
            allItems.push(...customItems);
        }

        const selected = await vscode.window.showQuickPick(allItems, {
            placeHolder: localize('selectProfilePrompt', 'Select a profile for AI suggestion')
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!selected || (selected as any).kind === vscode.QuickPickItemKind.Separator) {
            return;
        }

        // Add option for custom prompt
        const useCustomPrompt = await vscode.window.showQuickPick(
            [loc('useProfileAsIs', 'Use profile as-is'), loc('addCustomPrompt', 'Add custom prompt')],
            { placeHolder: loc('customPromptQuestion', 'Would you like to add a custom prompt?') }
        );

        let additionalPrompt = '';
        if (useCustomPrompt === loc('addCustomPrompt', 'Add custom prompt')) {
            additionalPrompt = await vscode.window.showInputBox({
                prompt: loc('enterAdditionalContext', 'Enter additional context or instructions'),
                placeHolder: loc('additionalContextPlaceholder', 'e.g., Focus on performance issues and memory leaks'),
                ignoreFocusOut: true
            }) || '';
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.aiProvider!.setActiveProfile(selected.profile.id);

        const document = editor.document;
        const position = editor.selection.active;
        const lineNumber = position.line;

        try {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const suggestion = await this.aiProvider!.suggestAnnotationForLine(
                document,
                lineNumber,
                selected.profile.id,
                additionalPrompt || undefined
            );

            if (suggestion) {
                await this.createAnnotationFromSuggestion(suggestion, document, lineNumber);
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('suggestionError', 'Failed to generate suggestion: ') + error
            );
        }
    }

    private async analyzeFileWithProfile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        try {
            await this.initializeAIProvider();
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('aiInitError', 'Failed to initialize AI provider: ') + error
            );
            return;
        }

        // Show profile selector
        const profiles = this.aiProvider?.getProfiles() || [];
        const items = profiles.map(p => ({
            label: `$(account) ${p.name}`,
            description: p.description,
            detail: `Tags: ${p.annotationDefaults.tags.join(', ')} | Severity: ${p.annotationDefaults.severity}`,
            profile: p
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: localize('selectProfileForAnalysis', 'Select a profile to analyze the entire file'),
            title: localize('analyzeFileTitle', 'Analyze File with AI Profile')
        });

        if (!selected) {
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.aiProvider!.setActiveProfile(selected.profile.id);

        // Ask for user confirmation before sending to AI
        const fileInfo = `File: ${path.basename(editor.document.fileName)}\nLines: ${editor.document.lineCount}\nLanguage: ${editor.document.languageId}`;
        const confirmation = await vscode.window.showInformationMessage(
            localize('confirmAIAnalysis', `Send this file to AI for analysis?\n\n${fileInfo}\n\nProfile: ${selected.profile.name}`),
            { modal: true },
            localize('yes', 'Yes, Analyze'),
            localize('no', 'Cancel')
        );

        if (confirmation !== localize('yes', 'Yes, Analyze')) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('analyzingFileWithProfile', `Analyzing file with ${selected.profile.name} profile...`),
            cancellable: false
        }, async () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const annotations = await this.aiProvider!.analyzeFile(
                    editor.document,
                    selected.profile.id
                );

                if (annotations.length === 0) {
                    vscode.window.showInformationMessage(
                        localize('noAnnotationsFound', 'No annotations suggested for this file')
                    );
                    return;
                }

                const action = await vscode.window.showInformationMessage(
                    localize('annotationsFoundWithProfile', `${selected.profile.name} found ${annotations.length} annotations`),
                    localize('addAll', 'Add All'),
                    localize('review', 'Review'),
                    localize('cancel', 'Cancel')
                );

                if (action === localize('addAll', 'Add All')) {
                    await this.addMultipleAnnotations(annotations);
                } else if (action === localize('review', 'Review')) {
                    await this.reviewAnnotations(annotations);
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    localize('analysisError', 'Failed to analyze file: ') + error
                );
            }
        });
    }

    private async analyzeCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        try {
            await this.initializeAIProvider();
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('aiInitError', 'Failed to initialize AI provider: ') + error
            );
            return;
        }

        const activeProfile = this.profileManager.getActiveProfile();
        const profileId = activeProfile?.preferences.claudeProfileId || activeProfile?.role || 'developer';

        // Ask for user confirmation
        const fileInfo = `File: ${path.basename(editor.document.fileName)}\nLines: ${editor.document.lineCount}\nLanguage: ${editor.document.languageId}`;
        const confirmation = await vscode.window.showInformationMessage(
            localize('confirmAIAnalysis', `Send this file to AI for analysis?\n\n${fileInfo}`),
            { modal: true },
            localize('yes', 'Yes, Analyze'),
            localize('no', 'Cancel')
        );

        if (confirmation !== localize('yes', 'Yes, Analyze')) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('analyzingFile', 'Analyzing file with AI...'),
            cancellable: false
        }, async () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const annotations = await this.aiProvider!.analyzeFile(
                    editor.document,
                    profileId
                );

                if (annotations.length === 0) {
                    vscode.window.showInformationMessage(
                        localize('noAnnotationsFound', 'No annotations suggested for this file')
                    );
                    return;
                }

                const action = await vscode.window.showInformationMessage(
                    localize('annotationsFound', `Found ${annotations.length} potential annotations`),
                    localize('addAll', 'Add All'),
                    localize('review', 'Review'),
                    localize('cancel', 'Cancel')
                );

                if (action === localize('addAll', 'Add All')) {
                    await this.addMultipleAnnotations(annotations);
                } else if (action === localize('review', 'Review')) {
                    await this.reviewAnnotations(annotations);
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    localize('analysisError', 'Failed to analyze file: ') + error
                );
            }
        });
    }

    private async batchAnnotateFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        // Get selection or entire file
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection.isEmpty ? undefined : selection);
        
        if (!selectedText && editor.document.getText().length === 0) {
            vscode.window.showWarningMessage(
                localize('emptyFile', 'The file is empty')
            );
            return;
        }

        try {
            await this.initializeAIProvider();
        } catch (error) {
            vscode.window.showErrorMessage(
                localize('aiInitError', 'Failed to initialize AI provider: ') + error
            );
            return;
        }

        // Ask for specific focus areas
        const focusAreas = await vscode.window.showQuickPick([
            { label: loc('allIssues', 'All Issues'), value: 'all' },
            { label: loc('bugsOnly', 'Bugs Only'), value: 'bugs' },
            { label: loc('performance', 'Performance'), value: 'performance' },
            { label: loc('security', 'Security'), value: 'security' },
            { label: loc('documentation', 'Documentation'), value: 'documentation' },
            { label: loc('architecture', 'Architecture'), value: 'architecture' }
        ], {
            placeHolder: localize('selectFocus', 'Select focus area for annotations'),
            canPickMany: true
        });

        if (!focusAreas || focusAreas.length === 0) {
            return;
        }

        const focusContext = focusAreas.map(f => f.value).join(', ');
        const startLine = selection.isEmpty ? 0 : selection.start.line;

        // Show what will be analyzed
        const scope = selection.isEmpty ? loc('entireFile', 'Entire file') : loc('selectedLines', `Selected lines {0}-{1}`, selection.start.line + 1, selection.end.line + 1);
        const fileInfo = loc('batchAnalysisInfo', `File: {0}\nScope: {1}\nFocus: {2}`, path.basename(editor.document.fileName), scope, focusContext);
        
        const confirmation = await vscode.window.showInformationMessage(
            localize('confirmBatchAnalysis', `Send to AI for batch analysis?\n\n${fileInfo}`),
            { modal: true },
            localize('yes', 'Yes, Analyze'),
            localize('no', 'Cancel')
        );

        if (confirmation !== localize('yes', 'Yes, Analyze')) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: localize('batchAnnotating', 'Generating batch annotations...'),
            cancellable: false
        }, async () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const annotations = await this.aiProvider!.generateAnnotations(
                    selectedText || editor.document.getText(),
                    this.getRelativePath(editor.document.fileName),
                    startLine,
                    {
                        language: editor.document.languageId,
                        additionalContext: `Focus on: ${focusContext}`
                    }
                );

                if (annotations.length > 0) {
                    await this.reviewAnnotations(annotations);
                } else {
                    vscode.window.showInformationMessage(
                        localize('noIssuesFound', 'No issues found in the selected area')
                    );
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    localize('batchError', 'Failed to generate batch annotations: ') + error
                );
            }
        });
    }

    private async batchCreateTemplates(_editor: vscode.TextEditor, _selection: vscode.Selection, _selectedText: string | undefined): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const templateManager = (this.annotationManager as any).templateManager;
        if (!templateManager) {
            vscode.window.showErrorMessage(loc('templateManagerNotAvailable', 'Template manager not available'));
            return;
        }

        const templateCount = await vscode.window.showInputBox({
            prompt: loc('howManyTemplates', 'How many templates would you like to create?'),
            value: '3',
            validateInput: (value) => {
                const num = parseInt(value);
                return (isNaN(num) || num < 1 || num > 10) ? loc('enterNumberBetween', 'Enter a number between 1 and 10') : null;
            }
        });

        if (!templateCount) return;

        const count = parseInt(templateCount);
        const templates = [];

        for (let i = 0; i < count; i++) {
            const name = await vscode.window.showInputBox({
                prompt: loc('templateName', `Template {0} name`, i + 1),
                placeHolder: loc('templateNamePlaceholder', 'e.g., Security Review')
            });

            if (!name) continue;

            const message = await vscode.window.showInputBox({
                prompt: loc('templateMessage', `Template {0} message template`, i + 1),
                placeHolder: loc('templateMessagePlaceholder', 'e.g., [Security] Check {input} for vulnerabilities')
            });

            if (!message) continue;

            await templateManager.createTemplate({
                name,
                message,
                tags: ['template', 'batch-created'],
                severity: 'info',
                priority: 1
            });

            templates.push(name);
        }

        vscode.window.showInformationMessage(loc('createdTemplates', `Created {0} templates: {1}`, templates.length, templates.join(', ')));
    }

    private async batchCreateLinks(_editor: vscode.TextEditor, _selection: vscode.Selection, _selectedText: string | undefined): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const linkedManager = (this.annotationManager as any).linkedAnnotationManager;
        if (!linkedManager) {
            vscode.window.showErrorMessage(loc('linkedManagerNotAvailable', 'Linked annotation manager not available'));
            return;
        }

        // Get existing annotations to link
        const annotations = Array.from(this.annotationManager.annotations.values());
        if (annotations.length < 2) {
            vscode.window.showErrorMessage(loc('needTwoAnnotations', 'Need at least 2 annotations to create links'));
            return;
        }

        const items = annotations.map(ann => ({
            label: ann.message,
            description: `${ann.file}:${ann.line}`,
            annotation: ann
        }));

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: loc('selectAnnotationsToLink', 'Select annotations to link together')
        });

        if (!selected || selected.length < 2) {
            return;
        }

        const linkName = await vscode.window.showInputBox({
            prompt: loc('linkGroupName', 'Name for this link group'),
            placeHolder: loc('linkGroupNamePlaceholder', 'e.g., Authentication Flow')
        });

        if (!linkName) return;

        // Create links between selected annotations
        for (let i = 0; i < selected.length - 1; i++) {
            for (let j = i + 1; j < selected.length; j++) {
                await linkedManager.createLink(
                    selected[i].annotation.id,
                    selected[j].annotation.file,
                    selected[j].annotation.line,
                    linkName
                );
            }
        }

        vscode.window.showInformationMessage(loc('createdLinkGroup', `Created link group '{0}' with {1} annotations`, linkName, selected.length));
    }

    private async batchCreateSnippets(editor: vscode.TextEditor, selection: vscode.Selection, selectedText: string | undefined): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const snippetManager = (this.annotationManager as any).snippetManager;
        if (!snippetManager) {
            vscode.window.showErrorMessage(loc('snippetManagerNotAvailable', 'Snippet manager not available'));
            return;
        }

        const snippetType = await vscode.window.showQuickPick([
            { label: loc('fromCurrentSelection', 'From Current Selection'), value: 'selection' },
            { label: loc('fromAISuggestions', 'From AI Suggestions'), value: 'ai' },
            { label: loc('manualEntry', 'Manual Entry'), value: 'manual' }
        ], {
            placeHolder: loc('howToCreateSnippets', 'How would you like to create snippets?')
        });

        if (!snippetType) return;

        switch (snippetType.value) {
            case 'selection': {
                if (!selectedText) {
                    vscode.window.showWarningMessage(loc('noTextSelected', 'No text selected'));
                    return;
                }

                const snippetName = await vscode.window.showInputBox({
                    prompt: loc('snippetName', 'Snippet name'),
                    placeHolder: loc('snippetNamePlaceholder', 'e.g., Error Handler')
                });

                if (snippetName) {
                    const currentLine = selection.start.line;
                    const annotation = Array.from(this.annotationManager.annotations.values())
                        .find(ann => ann.file === this.getRelativePath(editor.document.fileName) && ann.line === currentLine);

                    if (annotation) {
                        const updatedAnnotation = await snippetManager.addSnippet(
                            annotation,
                            selectedText,
                            editor.document.languageId
                        );

                        this.annotationManager.annotations.set(annotation.id, updatedAnnotation);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        await (this.annotationManager as any).saveAnnotations();
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        await (this.annotationManager as any).refreshAnnotations();

                        vscode.window.showInformationMessage(loc('addedSnippet', `Added snippet '{0}' to annotation`, snippetName));
                    } else {
                        vscode.window.showWarningMessage(loc('noAnnotationAtLine', 'No annotation found at current line to attach snippet'));
                    }
                }
                break;
            }

            case 'ai': {
                const context = await vscode.window.showInputBox({
                    prompt: loc('whatKindOfSnippets', 'What kind of snippets do you need?'),
                    placeHolder: loc('snippetContextPlaceholder', 'e.g., Error handling patterns for async functions')
                });

                if (context) {
                    try {
                        await this.initializeAIProvider();

                        const prompt = `Generate code snippets for: ${context}
Language: ${editor.document.languageId}
Context: ${selectedText ? 'Based on this code:\n' + selectedText : 'General purpose'}

Provide 3 reusable code snippets with clear names and descriptions.`;

                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const response = await (this.aiProvider as any).callAI(prompt);

                        const snippetAnnotations = this.parseSnippetsFromResponse(response);

                        if (snippetAnnotations.length > 0) {
                            await this.reviewAnnotations(snippetAnnotations);
                        } else {
                            vscode.window.showWarningMessage(loc('noSnippetsGenerated', 'No snippets generated'));
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(loc('aiSnippetGenerationFailed', `AI snippet generation failed: {0}`, error));
                    }
                }
                break;
            }

            case 'manual': {
                const count = await vscode.window.showInputBox({
                    prompt: loc('howManySnippets', 'How many snippets?'),
                    value: '1',
                    validateInput: (v) => (parseInt(v) > 0 && parseInt(v) <= 5) ? null : loc('enterOneToFive', 'Enter 1-5')
                });

                if (count) {
                    const snippetCount = parseInt(count);
                    for (let i = 0; i < snippetCount; i++) {
                        const snippetCode = await vscode.window.showInputBox({
                            prompt: loc('snippetCode', `Snippet {0} code`, i + 1),
                            placeHolder: loc('enterCodeForSnippet', 'Enter the code for this snippet'),
                            ignoreFocusOut: true
                        });

                        if (!snippetCode) continue;

                        const snippetDesc = await vscode.window.showInputBox({
                            prompt: loc('snippetDescription', `Snippet {0} description`, i + 1),
                            placeHolder: loc('whatDoesSnippetDo', 'What does this snippet do?')
                        });

                        const annotation: Partial<Annotation> = {
                            message: snippetDesc || loc('codeSnippet', `Code snippet {0}`, i + 1),
                            file: this.getRelativePath(editor.document.fileName),
                            line: selection.start.line,
                            severity: 'info',
                            tags: ['snippet', 'manual'],
                            snippet: {
                                code: snippetCode,
                                language: editor.document.languageId
                            }
                        };

                        await this.createAnnotationFromSuggestion(
                            annotation,
                            editor.document,
                            selection.start.line
                        );
                    }
                }
                break;
            }
        }
    }

    private async batchCreateMixed(editor: vscode.TextEditor, selection: vscode.Selection, selectedText: string | undefined): Promise<void> {
        const actions = await vscode.window.showQuickPick([
            { label: loc('annotationsLabel', '$(comment) Annotations'), value: 'annotations', picked: true },
            { label: loc('templatesLabel', '$(file-code) Templates'), value: 'templates' },
            { label: loc('linksLabel', '$(link) Links'), value: 'links' },
            { label: loc('snippetsLabel', '$(code) Snippets'), value: 'snippets' }
        ], {
            canPickMany: true,
            placeHolder: loc('selectWhatToCreate', 'Select what to create (multiple allowed)')
        });

        if (!actions || actions.length === 0) return;

        for (const action of actions) {
            switch (action.value) {
                case 'annotations':
                    // Batch create annotations is already implemented as batchAnnotateFile
                    await this.batchAnnotateFile();
                    break;
                case 'templates':
                    await this.batchCreateTemplates(editor, selection, selectedText);
                    break;
                case 'links':
                    await this.batchCreateLinks(editor, selection, selectedText);
                    break;
                case 'snippets':
                    await this.batchCreateSnippets(editor, selection, selectedText);
                    break;
            }
        }
    }

    private async createAnnotationFromSuggestion(
        suggestion: Partial<Annotation>,
        document: vscode.TextDocument,
        lineNumber: number
    ): Promise<void> {
        const annotation: Annotation = {
            id: this.generateId(),
            message: suggestion.message || 'Generated annotation',
            file: this.getRelativePath(suggestion.file || document.fileName),
            line: suggestion.line || lineNumber,
            author: this.profileManager.getActiveProfile()?.name || 
                    vscode.workspace.getConfiguration('annotation').get<string>('username', 'Anonymous'),
            timestamp: new Date().toISOString(),
            severity: suggestion.severity || 'info',
            tags: suggestion.tags || [],
            thread: [],
            kanbanColumn: suggestion.kanbanColumn || 'todo',
            resolved: false,
            ...(suggestion.priority && { priority: suggestion.priority })
        };

        await this.addAnnotationDirectly(annotation);
        
        vscode.window.showInformationMessage(
            localize('annotationAdded', 'Annotation added successfully')
        );
    }

    private async addAnnotationDirectly(annotation: Annotation): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const manager = this.annotationManager as any;
        manager.annotations.set(annotation.id, annotation);
        await manager.saveAnnotations();
        await manager.refreshAnnotations();
        manager.emit('annotationChanged');
    }

    private async addMultipleAnnotations(annotations: Partial<Annotation>[]): Promise<void> {
        let addedCount = 0;
        
        for (const suggestion of annotations) {
            try {
                const annotation: Annotation = {
                    id: this.generateId(),
                    message: suggestion.message || 'Generated annotation',
                    file: this.getRelativePath(suggestion.file || ''),
                    line: suggestion.line || 0,
                    author: this.profileManager.getActiveProfile()?.name || 
                           vscode.workspace.getConfiguration('annotation').get<string>('username', 'Anonymous'),
                    timestamp: new Date().toISOString(),
                    severity: suggestion.severity || 'info',
                    tags: suggestion.tags || [],
                    thread: [],
                    kanbanColumn: suggestion.kanbanColumn || 'todo',
                    resolved: false,
                    ...(suggestion.priority && { priority: suggestion.priority })
                };

                await this.addAnnotationDirectly(annotation);
                addedCount++;
            } catch (error) {
                console.error('Failed to add annotation:', error);
            }
        }

        vscode.window.showInformationMessage(
            localize('annotationsAdded', `${addedCount} annotations added successfully`)
        );
    }

    private async reviewAnnotations(annotations: Partial<Annotation>[]): Promise<void> {
        const items = annotations.map((ann, _index) => ({
            label: `Line ${ann.line}: ${ann.severity || 'info'}`,
            description: ann.message?.substring(0, 80) + (ann.message && ann.message.length > 80 ? '...' : ''),
            detail: ann.tags?.join(', '),
            annotation: ann,
            picked: true
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: localize('selectAnnotations', 'Select annotations to add'),
            canPickMany: true
        });

        if (selected && selected.length > 0) {
            const toAdd = selected.map(s => s.annotation);
            await this.addMultipleAnnotations(toAdd);
        }
    }

    private async showEnhancedProfileSelector(): Promise<void> {
        // Get user profiles and custom AI profiles
        const userProfiles = this.profileManager.getAllProfiles();
        const customAIProfiles = this.aiProfileManager.getCustomProfiles();
        
        // Create items for user profiles
        const userProfileItems = userProfiles.map(profile => ({
            label: `$(account) ${profile.name}`,
            description: loc('userProfileDesc', `User Profile - {0}`, profile.role),
            detail: profile.preferences.claudeProfileId ? loc('linkedTo', `Linked to: {0}`, profile.preferences.claudeProfileId) : loc('noAIProfileLinked', 'No AI profile linked'),
            type: 'user',
            profile
        }));
        
        // Create items for custom AI profiles  
        const aiProfileItems = customAIProfiles.map(aiProfile => ({
            label: `$(star) ${aiProfile.name}`,
            description: loc('customAIProfile', 'Custom AI Profile'),
            detail: aiProfile.description,
            type: 'ai',
            aiProfile
        }));
        
        // Combine all items
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allItems: any[] = [
            ...userProfileItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...aiProfileItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: loc('createNewProfile', '$(add) Create New Profile'), description: loc('createNewProfileDesc', 'Create a new user or AI profile'), action: 'create' }
        ];
        
        const selected = await vscode.window.showQuickPick(allItems, {
            placeHolder: loc('selectUserOrAIProfile', 'Select a user profile or AI profile'),
            title: loc('profileSelection', 'Profile Selection')
        });
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!selected || (selected as any).kind === vscode.QuickPickItemKind.Separator) {
            return;
        }

        if (selected.action === 'create') {
            const profileType = await vscode.window.showQuickPick(
                [loc('userProfile', 'User Profile'), loc('aiProfile', 'AI Profile')],
                { placeHolder: loc('whatTypeOfProfile', 'What type of profile would you like to create?') }
            );
            
            if (profileType === loc('userProfile', 'User Profile')) {
                await this.profileManager.showProfileManager();
            } else if (profileType === loc('aiProfile', 'AI Profile')) {
                await this.aiProfileManager.showProfileManager();
            }
            return;
        }
        
        if (selected.type === 'user') {
            // Set active user profile
            await this.profileManager.setActiveProfile(selected.profile.id);
            if (this.aiProvider && selected.profile.preferences.claudeProfileId) {
                this.aiProvider.setActiveProfile(selected.profile.preferences.claudeProfileId);
            }
        } else if (selected.type === 'ai') {
            // Just set the AI profile as active
            if (this.aiProvider) {
                this.aiProvider.setActiveProfile(selected.aiProfile.id);
            }
            vscode.window.showInformationMessage(loc('aiProfileActivated', `AI Profile '{0}' activated`, selected.aiProfile.name));
        }
    }

    public async refreshProvider(): Promise<void> {
        try {
            // Force refresh the AI provider with current settings
            const config = vscode.workspace.getConfiguration('annotation');
            const newProvider = config.get<string>('provider', 'openai');
            const oldProvider = this.aiProvider?.getCurrentProvider();
            
            if (oldProvider !== newProvider) {
                this.aiProvider = null;
            }
            
            await this.initializeAIProvider();
            
            vscode.window.showInformationMessage(loc('aiProviderUpdated', `AI Provider updated to: {0}`, newProvider));
        } catch (error) {
            console.error('Failed to refresh AI provider:', error);
            vscode.window.showErrorMessage(loc('failedToUpdateAIProvider', 'Failed to update AI provider. Check your settings and API keys.'));
        }
    }

    private async updateApiKey(): Promise<void> {
        const config = vscode.workspace.getConfiguration('annotation');
        const provider = config.get<string>('provider', 'openai');
        const llmConfig = vscode.workspace.getConfiguration('llm');
        const apiKeys = llmConfig.get<Record<string, string>>('apiKeys', {});

        // Show provider selection
        const providers = [
            { label: loc('providerOpenAI', 'OpenAI'), value: 'openai' },
            { label: loc('providerAnthropic', 'Anthropic (Claude)'), value: 'anthropic' },
            { label: loc('providerAzure', 'Azure OpenAI'), value: 'azure' },
            { label: loc('providerMistral', 'MistralAI'), value: 'mistralai' },
            { label: loc('providerGroq', 'Groq'), value: 'groq' },
            { label: loc('providerOllama', 'Ollama'), value: 'ollama' }
        ];

        const selectedProvider = await vscode.window.showQuickPick(providers, {
            placeHolder: loc('selectProviderToUpdate', `Select provider to update API key (current: {0})`, provider),
            title: loc('updateAIProviderAPIKey', 'Update AI Provider API Key')
        });

        if (!selectedProvider) {
            return;
        }

        // Ask how to store the key
        const storageMethod = await vscode.window.showQuickPick([
            { label: loc('storeInSettings', 'Store in Settings (visible in settings.json)'), value: 'settings' },
            { label: loc('storeSecurely', 'Store Securely (VS Code secret storage)'), value: 'secrets' }
        ], {
            placeHolder: loc('howToStoreApiKey', 'How would you like to store the API key?')
        });

        if (!storageMethod) {
            return;
        }

        // Get the API key
        const currentKey = apiKeys[selectedProvider.value] || '';
        const apiKey = await vscode.window.showInputBox({
            prompt: loc('enterApiKeyFor', `Enter API key for {0}`, selectedProvider.label),
            placeHolder: selectedProvider.value === 'ollama' ? loc('leaveEmptyForOllama', 'Leave empty for local Ollama') : 'sk-...',
            password: true,
            value: currentKey,
            ignoreFocusOut: true
        });

        if (apiKey === undefined) {
            return;
        }

        try {
            if (storageMethod.value === 'secrets') {
                // Store in VS Code secrets
                await this.context.secrets.store(`${selectedProvider.value}-api-key`, apiKey);
                
                // Remove from settings if it exists
                const updatedKeys = { ...apiKeys };
                delete updatedKeys[selectedProvider.value];
                await llmConfig.update('apiKeys', updatedKeys, vscode.ConfigurationTarget.Global);
                
                vscode.window.showInformationMessage(
                    loc('apiKeyStoredSecurely', `API key for {0} stored securely. Refreshing provider...`, selectedProvider.label)
                );
            } else {
                // Store in settings
                const updatedKeys = { ...apiKeys, [selectedProvider.value]: apiKey };
                await llmConfig.update('apiKeys', updatedKeys, vscode.ConfigurationTarget.Global);
                
                vscode.window.showInformationMessage(
                    loc('apiKeyUpdatedInSettings', `API key for {0} updated in settings. Refreshing provider...`, selectedProvider.label)
                );
            }

            // If this is the current provider, refresh it
            if (selectedProvider.value === provider) {
                await this.refreshProvider();
            }
        } catch (error) {
            vscode.window.showErrorMessage(loc('failedToUpdateApiKey', `Failed to update API key: {0}`, error));
        }
    }

    private async refreshAIProfiles(): Promise<void> {
        // Reload profiles from disk first
        await this.aiProfileManager.reloadProfiles();
        
        if (!this.aiProvider) {
            await this.initializeAIProvider();
            // Don't return - continue to add custom profiles to the newly initialized provider
        }

        // Ensure aiProvider is initialized
        if (!this.aiProvider) {
            console.error('Failed to initialize AI provider');
            return;
        }

        // Clear existing custom profiles
        const builtInProfiles = ['developer', 'analyst', 'architect'];
        const allProfiles = this.aiProvider.getProfiles();
        
        // Remove all custom profiles (non-built-in)
        for (const profile of allProfiles) {
            if (!builtInProfiles.includes(profile.id)) {
                this.aiProvider.removeCustomProfile(profile.id);
            }
        }

        // Re-add all custom profiles from AIProfileManager
        const customProfiles = this.aiProfileManager.getCustomProfiles();
        
        for (const profile of customProfiles) {
            this.aiProvider.addCustomProfile(profile);
        }
    }

    private parseSnippetsFromResponse(response: string): Partial<Annotation>[] {
        // Parse AI response to extract code snippets
        const annotations: Partial<Annotation>[] = [];
        
        // Simple pattern matching for code blocks
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
        const titleRegex = /(?:^|\n)(?:#+\s*)?(\w[\w\s]+)(?:\n|:)/g;
        
        let match;
        let lastTitle = 'Code Snippet';

        while ((match = codeBlockRegex.exec(response)) !== null) {
            const language = match[1] || 'javascript';
            const code = match[2].trim();

            const beforeCode = response.substring(0, match.index);
            const titleMatches = [...beforeCode.matchAll(titleRegex)];
            if (titleMatches.length > 0) {
                lastTitle = titleMatches[titleMatches.length - 1][1].trim();
            }

            annotations.push({
                message: lastTitle,
                severity: 'info',
                tags: ['snippet', 'ai-generated'],
                snippet: {
                    code,
                    language
                }
            });
        }
        
        return annotations;
    }

    public dispose(): void {
        // Remove event listeners
        this.aiProfileManager.removeAllListeners('profilesChanged');
    }
}
