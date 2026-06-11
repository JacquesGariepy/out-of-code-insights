import * as vscode from 'vscode';
import * as path from 'path';
import { EventEmitter } from 'events';
import { igniteEngine, loadModels, Message } from 'multi-llm-ts';
import { Annotation, AnnotationAnchor, Comment, ExtensionConfig, ResolvedAnnotationAnchor } from '../common/types';
import { localize } from '../common/localize';
import { loc } from './LocalizationManager';
import { ConfigurationManager } from './ConfigurationManager';
import { AnnotationsTreeDataProvider, FileTreeItem, AnnotationTreeItem } from '../tree/AnnotationsTree';
import { NavigationStack } from './NavigationStack';
import { NavigationStackDataProvider } from '../tree/NavigationStackTree';
import { LinkedAnnotationManager } from './LinkedAnnotationManager';
import { TemplateManager, AnnotationTemplate } from './TemplateManager';
import { ReviewModeManager } from './ReviewModeManager';
import { SnippetManager, SnippetHistoryEntry } from './SnippetManager';
import { AnnotationStore } from '../transactional/AnnotationStore';
import { KanbanView } from '../views/KanbanView';
import { AnnotationManagerErrorHandling } from './AnnotationManagerErrorHandling';
import { escapeHtml, generateNonce } from '../common/utils';
import {
    captureAnchor,
    findAnchor,
    detectMoves,
    hashLine,
    EMPTY_LINE_HASH,
    AnchorData,
    MovedBlock,
    reanchor,
} from '../anchoring/anchor';
import { resolveAnnotationStyle, StyleSpec } from '../decorations/annotationStyle';

interface CopySourceSnapshot {
    uri: string;
    relativeFilePath: string;
    lines: string[];
    usePreChangeLines: boolean;
}

interface CopySourceCandidate {
    annotation: Annotation;
    sourceUri: string;
    sourceLine: number;
    offset: number;
    renderOffsetFromSource: number;
}

export class AnnotationManager extends EventEmitter {
    public annotationsTreeView?: vscode.TreeView<vscode.TreeItem>;
    public annotationsTreeDataProvider?: AnnotationsTreeDataProvider;
    public stackTreeView?: vscode.TreeView<vscode.TreeItem>;
    public stackDataProvider?: NavigationStackDataProvider;
    public navigationStack: NavigationStack;
    private configManager: ConfigurationManager;
    // Lot 5 R2 worktree B: LinkedAnnotationManager + ReviewModeManager have
    // been migrated to take an AnnotationStore. We keep instantiating them
    // here during R2 (backed by a dedicated empty store) so their VS Code
    // command registrations stay alive until worker-1 wires the real
    // store-backed instances in extension.ts. R3 deletes this whole class
    // and the field declarations together. The fields are optional so
    // future de-instantiation tweaks don't require touching every call site.
    private linkedAnnotationManager: LinkedAnnotationManager | undefined;
    private templateManager: TemplateManager;
    private reviewModeManager: ReviewModeManager | undefined;
    private snippetManager: SnippetManager;
    /**
     * Backing store for the legacy linked/review manager pair during R2.
     * Always empty (no I/O) so legacy command handlers operate on a no-op
     * surface. Disposed when AnnotationManager itself disposes.
     */
    private legacyEmptyStoreForRetiredManagers: AnnotationStore | undefined;
    public annotations: Map<string, Annotation> = new Map();
    private kanbanColumns: Map<string, string> = new Map([
        ['todo', 'To Do'],
        ['in_progress', 'In Progress'],
        ['review', 'Review'],
        ['done', 'Done'],
    ]);
    private readonly disposables: vscode.Disposable[] = [];
    private readonly decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private outputChannel: vscode.OutputChannel;
    private currentUser = '';
    private contentChangeTimeout: NodeJS.Timeout | undefined;
    private annotationsPanel?: vscode.WebviewPanel;
    private currentFilter = 'all';
    private currentSort = 'line_asc';
    private codeLensProviderDisposable: vscode.Disposable | null = null;
    public annotationsEnabled = true;
    private temporaryHighlightDecoration: vscode.TextEditorDecorationType =
        vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 255, 0, 0.3)',
        });
    private initializationPromise: Promise<void>;
    /**
     * When true, the v2 AnnotationStore owns the annotation lifecycle and the
     * legacy event handlers become no-ops:
     *  - handleDocumentChange: store does offset shift + suspend/resume on
     *    cut/paste; running both trackers double-shifts lines and the legacy
     *    saveAnnotations bridge then persists the corrupted positions.
     *  - handleDocumentOpen: store.reanchorDocument relocates after external
     *    edits; the legacy findAnchor pass would fight it through the bridge.
     *  - handleFileRename: store.applyFileRename patches active AND suspended
     *    annotations (the legacy path missed suspended ones).
     *  - handleFileDelete: the legacy path silently deleted the annotations
     *    of a removed file; the store-side listener prompts the user instead.
     */
    public lifecycleDelegatedToStore = false;
    private documentSnapshots: Map<string, string[]> = new Map();
    /** Milliseconds to hold a deferred (cut) annotation before showing the expiry dialog. */
    public clipboardWindowMs = 5000;
    private recentDeletions: Map<
        string,
        {
            annotation: Annotation;
            deletedAt: number;
            /** Offset of annotation.line within the deleted block (for block-relative paste recovery). */
            offsetInBlock: number;
            /** Offset of the tracked code line within the deleted block. */
            trackingOffsetInBlock?: number;
            /** Render-line delta relative to the tracked code line. */
            renderOffsetFromTracking?: number;
            /** Hash of the tracked code line; differs from annotation.lineHash for blank-line annotations. */
            trackingLineHash?: string;
            /** Exact text removed by the cut/delete event, when known from the previous document snapshot. */
            cutText?: string;
            /** Hashes for each removed line; used to verify that a later edit is the matching paste. */
            cutLineHashes?: string[];
        }
    > = new Map();
    /** Annotations silently removed via cut-expiry, kept briefly for Undo toast. */
    private deletedRecently: Map<string, { annotation: Annotation; removedAt: number }> = new Map();
    /** TTL (ms) to keep a silently-deleted annotation available for Undo. Default: 30 s. */
    public deletedRecentlyTtlMs = 30000;

    private refreshTimeout: NodeJS.Timeout | undefined;
    private isRefreshing = false;

    // Multi-LLM properties
    private provider = 'openai';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private llm: any = undefined;
    private llmKey: string | undefined;
    private providerKeys: Record<string, string | undefined> = {};
    private catParticipant: vscode.ChatParticipant | undefined;

    // Reset search to initial state
    public async resetSearch(): Promise<void> {
        // Remove all highlights from the webview
        if (this.annotationsPanel) {
            this.annotationsPanel.webview.postMessage({ command: 'clearFocus' });
        }
        vscode.window.showInformationMessage(localize('searchReset', 'Search reset.'));
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        super();
        this.configManager = new ConfigurationManager();
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.navigationStack = new NavigationStack(context);

        // Create output channel for logging
        this.outputChannel = vscode.window.createOutputChannel('Out-of-Code Insights');
        this.disposables.push(this.outputChannel);
        this.log('Extension starting...');

        // Initialize new managers.
        // Lot 5 R2 worktree B: LinkedAnnotationManager + ReviewModeManager
        // were migrated to consume an AnnotationStore. To preserve VS Code
        // command registration during the R2 coexistence window (those
        // managers register commands like `annotations.startReview` in their
        // ctor), we keep instantiating them HERE — backed by a dedicated
        // empty store. The empty store carries no annotations, so every
        // command operates on a no-op surface; users invoke the real flow
        // via the store-backed instances that worker-1 wires in
        // extension.ts. R3 retires this whole class together with the
        // duplicate instantiation.
        this.legacyEmptyStoreForRetiredManagers = new AnnotationStore();
        this.legacyEmptyStoreForRetiredManagers.markInitialized();
        this.linkedAnnotationManager = new LinkedAnnotationManager(context, this.legacyEmptyStoreForRetiredManagers);
        this.templateManager = new TemplateManager(context);
        this.reviewModeManager = new ReviewModeManager(
            context,
            this.legacyEmptyStoreForRetiredManagers,
            () => this.config.username || 'Unknown'
        );
        this.snippetManager = SnippetManager.getInstance();
        // Initialize annotation display state from globalState
        const stored = this.context.globalState.get<boolean>('annotationsEnabled');
        this.annotationsEnabled = typeof stored === 'boolean' ? stored : true;
        this.initializationPromise = this.initialize();
    }

    public async waitUntilInitialized(): Promise<void> {
        await this.initializationPromise;
    }

    public get config(): ExtensionConfig {
        return this.configManager.config;
    }

    // Getter methods for managers to support batch creation
    public getTemplateManager(): TemplateManager {
        return this.templateManager;
    }

    // Lot 5 R2 worktree B: getLinkedAnnotationManager() removed. Consumers
    // that need a LinkedAnnotationManager receive the store-backed instance
    // via DI from extension.ts. The legacy field on `AnnotationManager`
    // stays accessible (as `undefined`) only for the `as any` cheat in
    // UnifiedAIAdapter, which worker-2 retires in worktree C.

    public getSnippetManager(): SnippetManager {
        return this.snippetManager;
    }

    private async initialize(): Promise<void> {
        this.log('Initializing AnnotationManager...');
        this.loadConfiguration();

        this.currentUser = this.config.username?.trim() || 'Anonymous';
        this.annotationsEnabled = this.config.enableAnnotations === true;
        this.createChatParticipant(this.context);

        try {
            if (this.annotationsEnabled) {
                await this.loadKanbanColumns(); // Load kanban columns first
                await this.loadAnnotations();
                // Snapshot and repair documents that are already open before activation.
                let repairedOpenDocumentAnchors = false;
                for (const doc of vscode.workspace.textDocuments) {
                    this.snapshotDocument(doc);
                    repairedOpenDocumentAnchors =
                        this.repairBlankLineTrackingAnchors(doc) || repairedOpenDocumentAnchors;
                }
                if (repairedOpenDocumentAnchors) {
                    await this.saveAnnotations();
                }
                this.log('Registering additional commands...');
                this.registerAdditionalCommands(); // Register only non-core commands
                this.log('Registering CodeLens provider...');
                this.registerCodeLensProvider();
                this.log('Registering event handlers...');
                this.registerEventHandlers(); // Register event handlers to refresh annotations automatically
                await this.refreshAnnotations();
                this.updateStatusBar();
                this.emit('annotationChanged');
                this.log('Extension initialization complete');

                // Mark as successfully initialized
                AnnotationManagerErrorHandling.setInitialized(true);
            } else {
                // Even if annotations are disabled, mark as initialized
                AnnotationManagerErrorHandling.setInitialized(true);
            }
            this.statusBarItem.show();
        } catch (error) {
            // Mark initialization as failed with error details
            AnnotationManagerErrorHandling.setInitialized(false, error as Error);
            this.handleError(localize('initializeError', 'Failed to initialize extension'), error);
            throw error; // Re-throw to be caught by activate function
        }
    }

    private async promptForAiSuggestOption(): Promise<void> {
        const YES_LABEL = 'Yes';
        const NO_LABEL = 'No';

        const enableFeature = await vscode.window.showInformationMessage(
            localize('doYouWantToEnableAI', 'Do you want to enable the AI Suggest Annotation feature?'),
            YES_LABEL,
            NO_LABEL
        );

        // Mark the question as already asked regardless of the answer
        await this.context.globalState.update('hasPromptedAiSuggest', true);

        if (enableFeature === YES_LABEL) {
            const config = vscode.workspace.getConfiguration('annotation');
            await config.update('enableAiSuggest', true, vscode.ConfigurationTarget.Global);
        } else if (enableFeature === NO_LABEL) {
            vscode.window.showInformationMessage(
                localize('enableAILaterInSettings', 'You can enable this feature later in the extension settings.')
            );
        }
    }

    public async configureProviderAndKeys(): Promise<void> {
        const config = vscode.workspace.getConfiguration('annotation');
        const chosenProvider = config.get<string>('provider', 'openai');
        this.provider = chosenProvider;
        const secretStorage = this.context.secrets;

        // List of supported providers
        const providers = [
            'openai',
            'anthropic',
            'azure',
            'cerebras',
            'deepseek',
            'google',
            'groq',
            'meta',
            'mistralai',
            'ollama',
            'openrouter',
            'togetherai',
            'xai',
        ];

        for (const prov of providers) {
            const keyName = `annotation.${prov}Key`;
            let key = await secretStorage.get(keyName);
            if (!key && this.provider === prov) {
                key = await vscode.window.showInputBox({
                    prompt: localize('enterProviderAPIKey', 'Enter your {0} API key', prov),
                    password: true,
                });
                if (!key) {
                    vscode.window.showErrorMessage(
                        localize('providerKeyRequired', '{0} key is required for AI suggestions.', prov)
                    );
                    continue;
                }
                await secretStorage.store(keyName, key);
            }
            this.providerKeys[prov] = key;
        }

        this.llmKey = this.providerKeys[this.provider];
        if (!this.llmKey) {
            vscode.window.showErrorMessage(
                localize('noAPIKeyFound', 'No API key found for provider {0}.', this.provider)
            );
            return;
        }
        this.llm = igniteEngine(this.provider, { apiKey: this.llmKey });
    }

    public async ensureAiConfigured(): Promise<boolean> {
        const provider = vscode.workspace.getConfiguration('annotation').get<string>('provider', 'openai');
        const stored = await this.context.secrets.get(`annotation.${provider}Key`);
        if (stored && this.llm) {
            return true;
        }
        try {
            await this.configureProviderAndKeys();
            return !!this.llmKey;
        } catch {
            return false;
        }
    }

    // Generic methods to update or reset a provider API key
    private async updateProviderKey(provider: string): Promise<void> {
        const secretStorage = this.context.secrets;
        const newKey = await vscode.window.showInputBox({
            prompt: localize('enterNewProviderAPIKey', 'Enter your new {0} API key', provider),
            password: true,
        });
        if (!newKey) {
            vscode.window.showInformationMessage(localize('noKeyEnteredCanceled', 'No key entered. Update canceled.'));
            return;
        }
        await secretStorage.store(`annotation.${provider}Key`, newKey);
        this.providerKeys[provider] = newKey;
        if (this.provider === provider) {
            this.llmKey = newKey;
            this.llm = igniteEngine(this.provider, { apiKey: this.llmKey });
        }
        vscode.window.showInformationMessage(
            localize('providerKeyUpdatedSuccessfully', '{0} key updated successfully!', provider)
        );
    }

    private async resetProviderKey(provider: string): Promise<void> {
        const secretStorage = this.context.secrets;
        await secretStorage.delete(`annotation.${provider}Key`);
        this.providerKeys[provider] = undefined;
        if (this.provider === provider) {
            this.llmKey = undefined;
            this.llm = undefined;
        }
        vscode.window.showInformationMessage(
            localize(
                'providerKeyReset',
                '{0} key has been reset. Next AI Suggest request will prompt for a new key.',
                provider
            )
        );
    }

    public createChatParticipant(context: vscode.ExtensionContext) {
        const handler: vscode.ChatRequestHandler = async (
            request: vscode.ChatRequest,
            context: vscode.ChatContext,
            stream: vscode.ChatResponseStream,
            token: vscode.CancellationToken
        ) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage(localize('noActiveEditor', 'No active editor'));
                return;
            }
            const line = editor.selection.active.line;
            const codeLine = editor.document.lineAt(line).text.trim();

            const prompt = `Act as a senior developer. Provide a professional annotation 
            for the following line of code: ${codeLine}. Your comment must clearly and concisely 
            explain the purpose or functionality of the code while avoiding the inclusion of any 
            special or reserved characters, like // or backtick. These characters could be interpreted by the 
            language or system and cause errors. Example: If the line of code is: if (x > 0), 
            the comment could be: "Checks if the value of x is positive before executing the 
            next statement." (No special characters like >, {}, or others are included in the 
            comment).`;
            try {
                // initialize the messages array with the prompt
                const messages = [vscode.LanguageModelChatMessage.User(prompt)];

                // get all the previous participant messages
                const previousMessages = context.history.filter((h) => h instanceof vscode.ChatResponseTurn);

                // add the previous messages to the messages array
                previousMessages.forEach((m) => {
                    let fullMessage = '';
                    if (m instanceof vscode.ChatResponseTurn) {
                        m.response.forEach((r: vscode.ChatResponsePart) => {
                            const mdPart = r as vscode.ChatResponseMarkdownPart;
                            fullMessage += mdPart.value.value;
                        });
                        messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
                    }
                });

                // add in the user's message
                messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

                // send the request
                const chatResponse = await request.model.sendRequest(messages, {}, token);

                // stream the response
                for await (const fragment of chatResponse.text) {
                    stream.markdown(fragment);
                }

                return;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (error: any) {
                stream.markdown('Failed to get response: ' + error.message);
                return { metadata: {} };
            }
        };

        const tutor = vscode.chat.createChatParticipant('chat.code', handler);
        tutor.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png');
        this.catParticipant = tutor;
    }

    private async aiSuggestAnnotation() {
        this.loadConfiguration();
        if (!this.config.enableAiSuggest) {
            vscode.window.showInformationMessage(
                localize(
                    'aiSuggestDisabled',
                    'AI Suggest Annotation feature is disabled. Enable it in the extension settings.'
                )
            );
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        const line = editor.selection.active.line;
        const codeLine = editor.document.lineAt(line).text.trim();
        const prompt = `Act as a senior developer. Provide a professional annotation for the following line of code: ${codeLine}. Your comment must clearly and concisely explain the purpose or functionality of the code while avoiding the inclusion of any special or reserved characters, like // or backtick. These characters could be interpreted by the language or system and cause errors. Example: If the line of code is: if (x > 0), the comment could be: "Checks if the value of x is positive before executing the next statement." (No special characters like >, {}, or others are included in the comment).`;

        // Prompt user confirmation before sending the LLM request
        const confirm = await vscode.window.showWarningMessage(
            `Do you want to send this code line to the LLM provider (${this.provider}) for annotation?`,
            { modal: true },
            'Yes',
            'No'
        );
        if (confirm !== 'Yes') {
            vscode.window.showInformationMessage(localize('aiSuggestionCancelled', 'AI Suggestion cancelled.'));
            return;
        }

        try {
            await this.configureProviderAndKeys();
            if (!this.llm) {
                vscode.window.showErrorMessage(localize('llmProviderNotConfigured', 'LLM provider not configured.'));
                return;
            }
            const config = vscode.workspace.getConfiguration('annotation');
            const chosenModel = config.get<string>('model', 'gpt-4o-mini');
            const models = await loadModels(this.provider, { apiKey: this.llmKey });
            if (!models || !models.chat || !Array.isArray(models.chat) || models.chat.length === 0) {
                vscode.window.showErrorMessage(
                    localize('noChatModelsAvailable', 'No chat models available for this provider.')
                );
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const modelObj = models.chat.find((m: any) => m.id === chosenModel) || models.chat[0];
            const messages = [
                new Message('system', 'You are a code annotation assistant.'),
                new Message('user', prompt),
            ];
            const response = await this.llm.complete(modelObj, messages);
            const suggestion = response?.choices?.[0]?.message?.content?.trim() || response?.content?.trim();
            if (!suggestion) {
                vscode.window.showErrorMessage(localize('noAISuggestion', 'No AI suggestion.'));
                return;
            }
            const annotation: Annotation = {
                id: this.generateId(),
                file: this.getRelativePath(editor.document.fileName),
                line,
                message: suggestion,
                author: this.currentUser,
                timestamp: new Date().toISOString(),
                thread: [],
                tags: [this.provider],
                pinned: false,
                priority: 0,
                severity: 'info',
                resolved: false,
            };
            await this.populateAnchor(annotation, editor.document, line);
            this.annotations.set(annotation.id, annotation);
            await this.saveAnnotations();
            await this.refreshAnnotations();
            vscode.window.showInformationMessage(
                localize('annotationAddedFromProvider', 'Annotation added from {0}.', this.provider)
            );
            this.emit('annotationChanged');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            vscode.window.showErrorMessage(
                localize('failedToGetAISuggestion', 'Failed to get AI suggestion: {0}', err.message)
            );
        }
    }

    private async promptForUsername(): Promise<void> {
        const newUsername = await vscode.window.showInputBox({
            prompt: localize('enterUsername', 'Enter your name (for annotations)'),
            placeHolder: localize('usernamePlaceholder', 'John Doe'),
            validateInput: (text) =>
                text.trim().length === 0 ? localize('emptyUsernameError', 'Username cannot be empty') : null,
        });

        if (newUsername) {
            this.currentUser = newUsername.trim();
            await vscode.workspace
                .getConfiguration('annotation')
                .update('username', this.currentUser, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(localize('usernameUpdated', 'Username has been updated.'));
        } else {
            this.currentUser = localize('anonymous', 'Anonymous');
        }
    }

    private async navigateFromAnnotationToPanel(annotationId: string): Promise<void> {
        if (!this.annotationsPanel) {
            await this.showAnnotationsPanel(); // Open the panel if not already open
        }

        if (this.annotationsPanel) {
            this.annotationsPanel.webview.postMessage({
                command: 'focusAnnotation',
                annotationId: annotationId,
            });
        }
    }

    // ====== NOUVELLES FONCTIONS DE RECHERCHE ET FOCUS ======

    // Improved keyword search function
    private async keywordSearch(): Promise<void> {
        const keyword = await vscode.window.showInputBox({
            prompt: localize('enterKeyword', 'Enter a keyword to search in annotations'),
        });
        if (!keyword) return;

        // Find first annotation containing the keyword
        const found = Array.from(this.annotations.values()).find(
            (a) =>
                (a.message?.toLowerCase().includes(keyword.toLowerCase()) ?? false) ||
                (a.thread?.some((c) => c.message.toLowerCase().includes(keyword.toLowerCase())) ?? false)
        );

        if (!found) {
            vscode.window.showInformationMessage(
                localize('noAnnotationFoundForKeyword', 'No annotation found for this keyword.')
            );
            return;
        }

        // Call dedicated function to focus the annotation
        await this.focusOnAnnotation(found.id, keyword);
    }

    // Dedicated function to focus a specific annotation
    private async focusOnAnnotation(annotationId: string, searchKeyword?: string): Promise<void> {
        const annotation = this.annotations.get(annotationId);
        if (!annotation) return;

        try {
            // 1. Navigate in the editor (open file and position cursor)
            await this.navigateToAnnotation(annotationId);

            // 2. Focus in tree view, expanding the parent if needed
            await this.focusInTreeView(annotation);

            // 3. Focus in the webview panel (without filtering)
            await this.focusInPanel(annotationId);

            // 4. Message de confirmation
            const message = searchKeyword
                ? localize('keywordNavigate', 'Navigating to annotation found for "{0}".', searchKeyword)
                : localize('annotationFocused', 'Focused on annotation.');
            vscode.window.showInformationMessage(message);
        } catch (error) {
            vscode.window.showErrorMessage(
                localize(
                    'errorFocusingAnnotation',
                    'Error focusing on annotation: {0}',
                    error instanceof Error ? error.message : String(error)
                )
            );
        }
    }

    // Improved focus function in the tree view
    private async focusInTreeView(annotation: Annotation): Promise<void> {
        if (!this.annotationsTreeView || !this.annotationsTreeDataProvider) return;

        try {
            // Ensure the annotations view is visible BEFORE the reveal call
            await vscode.commands.executeCommand('workbench.view.extension.annotations');

            // Refresh tree view to ensure it is up to date
            this.annotationsTreeDataProvider.refresh();

            // Wait briefly for the refresh to complete
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Build items for the hierarchy.
            // Lot 5 R2 transition: FileTreeItem/AnnotationTreeItem now accept
            // store-aware shapes (ResolvedAnnotation[], 2-3 args). The legacy
            // AnnotationManager focus path is dead during R2 — its caller
            // bails on the empty in-memory map before reaching here. Cast
            // through `unknown` to keep the typecheck green; R3 deletes the
            // entire focus-in-tree path with the manager.
            const fileItem = new FileTreeItem(annotation.file, [annotation] as unknown as never);
            const annotationItem = new AnnotationTreeItem(annotation as unknown as never, null as unknown as never);

            // First reveal and expand the parent file node
            await this.annotationsTreeView.reveal(fileItem, {
                select: false,
                focus: false,
                expand: true,
            });

            // Then reveal and select the annotation node
            await this.annotationsTreeView.reveal(annotationItem, {
                select: true,
                focus: true,
                expand: false,
            });
        } catch (error) {
            console.warn('Error focusing in treeview:', error);
        }
    }

    // Improved focus function in the panel
    private async focusInPanel(annotationId: string): Promise<void> {
        // Ensure the panel is open
        if (!this.annotationsPanel) {
            await this.showAnnotationsPanel();
        }

        if (this.annotationsPanel) {
            // Reveal the panel
            this.annotationsPanel.reveal(vscode.ViewColumn.Beside, false);

            // Wait briefly for the panel to be ready
            await new Promise((resolve) => setTimeout(resolve, 200));

            // Send the focus message (without filtering)
            this.annotationsPanel.webview.postMessage({
                command: 'focusAnnotation',
                annotationId: annotationId,
                clearFilter: false, // Important: do not filter
            });
        }
    }

    // Helper to find an annotation by ID
    public async searchAnnotationById(annotationId: string): Promise<void> {
        await this.focusOnAnnotation(annotationId);
    }

    // Helper to find annotations by tag or other criterion
    public async searchAnnotationsByFilter(
        filterType: 'tag' | 'severity' | 'author',
        filterValue: string
    ): Promise<void> {
        let found: Annotation | undefined;

        switch (filterType) {
            case 'tag':
                found = Array.from(this.annotations.values()).find((a) =>
                    a.tags?.some((tag) => tag.toLowerCase().includes(filterValue.toLowerCase()))
                );
                break;
            case 'severity':
                found = Array.from(this.annotations.values()).find(
                    (a) => a.severity?.toLowerCase() === filterValue.toLowerCase()
                );
                break;
            case 'author':
                found = Array.from(this.annotations.values()).find((a) =>
                    a.author?.toLowerCase().includes(filterValue.toLowerCase())
                );
                break;
        }

        if (!found) {
            vscode.window.showInformationMessage(
                localize('noAnnotationFoundForFilter', 'No annotation found for {0}: {1}', filterType, filterValue)
            );
            return;
        }

        await this.focusOnAnnotation(found.id, `${filterType}:${filterValue}`);
    }

    // ====== END OF SEARCH FUNCTIONS ======

    // ====== DELEGATION METHODS FOR NEW MANAGERS ======

    // LinkedAnnotationManager delegation
    public async createLinkedAnnotation(sourceId: string, targetFile: string, targetLine: number): Promise<void> {
        return this.linkedAnnotationManager?.createLink(sourceId, targetFile, targetLine);
    }

    public async navigateToLinked(annotationId: string): Promise<void> {
        return this.linkedAnnotationManager?.goToLinkedAnnotation(annotationId);
    }

    // TemplateManager delegation
    public async applyTemplate(template: AnnotationTemplate, variableValues?: Record<string, string>): Promise<string> {
        return this.templateManager.applyTemplate(template, variableValues);
    }

    public async createTemplate(template: Omit<AnnotationTemplate, 'id'>): Promise<AnnotationTemplate> {
        return this.templateManager.createTemplate(template);
    }

    public getTemplates(): AnnotationTemplate[] {
        return this.templateManager.getAllTemplates();
    }

    // SnippetManager delegation.
    // Lot 5 R2 transition: SnippetManager now operates on AnnotationV2.
    // The legacy AnnotationManager.Annotation type and AnnotationV2 differ
    // structurally; these delegation methods are unreachable at R2 runtime
    // (the in-memory map is empty under the I/O stub) but kept compiling
    // through `unknown` casts. R3 retires the entire AnnotationManager.
    public async addSnippet(annotation: Annotation, code: string, language?: string): Promise<Annotation> {
        return this.snippetManager.addSnippet(
            annotation as unknown as never,
            code,
            language
        ) as unknown as Promise<Annotation>;
    }

    public async applySnippet(annotation: Annotation, editor: vscode.TextEditor): Promise<boolean> {
        return this.snippetManager.applySnippet(annotation as unknown as never, editor);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public async previewSnippet(annotation: Annotation, editor: vscode.TextEditor): Promise<any> {
        return this.snippetManager.previewSnippet(annotation as unknown as never, editor);
    }

    public getSnippets(): SnippetHistoryEntry[] {
        // SnippetManager doesn't have a getSnippets method, return snippet history instead
        return this.snippetManager.getSnippetHistory();
    }

    // ====== END DELEGATION METHODS ======

    private registerAdditionalCommands(): void {
        // Only register commands that are not already registered in extension.ts
        // These are more complex commands that need full initialization
        this.disposables.push(
            vscode.commands.registerCommand('annotations.updateProviderKey', async () => {
                const provider = await vscode.window.showQuickPick(
                    [
                        'openai',
                        'anthropic',
                        'azure',
                        'cerebras',
                        'deepseek',
                        'google',
                        'groq',
                        'meta',
                        'mistralai',
                        'ollama',
                        'openrouter',
                        'togetherai',
                        'xai',
                    ],
                    { placeHolder: 'Select the provider to update the API key for' }
                );
                if (provider) await this.updateProviderKey(provider);
            }),
            vscode.commands.registerCommand('annotations.resetProviderKey', async () => {
                const provider = await vscode.window.showQuickPick(
                    [
                        'openai',
                        'anthropic',
                        'azure',
                        'cerebras',
                        'deepseek',
                        'google',
                        'groq',
                        'meta',
                        'mistralai',
                        'ollama',
                        'openrouter',
                        'togetherai',
                        'xai',
                    ],
                    { placeHolder: 'Select the provider to reset the API key for' }
                );
                if (provider) await this.resetProviderKey(provider);
            }),

            // Command to reset search
            vscode.commands.registerCommand('annotations.resetSearch', this.resetSearch.bind(this)),

            // Commands for search with improved focus
            vscode.commands.registerCommand('annotations.searchAndFocus', async () => {
                await this.keywordSearch();
            }),

            // Command for direct annotation focus
            vscode.commands.registerCommand('annotations.focusAnnotation', async (annotationId: string) => {
                await this.focusOnAnnotation(annotationId);
            }),

            // Commands not included in core commands list
            vscode.commands.registerCommand('annotations.editInline', async (annotation?: Annotation) => {
                if (!annotation) {
                    const editor = this.getActiveEditor();
                    if (!editor) return;
                    annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                }
                if (annotation) await this.editAnnotationInline(annotation);
            }),
            vscode.commands.registerCommand('annotations.manage', this.manageAnnotationCommand.bind(this)),
            vscode.commands.registerCommand('annotations.showActivityBar', this.showAnnotationsPanel.bind(this)),
            vscode.commands.registerCommand('annotations.resolve', this.resolveAnnotation.bind(this)),
            vscode.commands.registerCommand(
                'annotations.autoResolveStale',
                this.autoResolveStaleAnnotations.bind(this)
            ),
            vscode.commands.registerCommand('annotations.filterBySeverity', this.filterBySeverity.bind(this)),
            vscode.commands.registerCommand('annotations.navigateToPanel', async (annotationId: string) => {
                await this.navigateFromAnnotationToPanel(annotationId);
            }),
            vscode.commands.registerCommand('annotations.changeSeverity', this.changeSeverity.bind(this)),
            vscode.commands.registerCommand('annotations.editTags', this.editAnnotationTags.bind(this)),
            vscode.commands.registerCommand('stack.back', async () => {
                const id = this.navigationStack.back();
                if (id) {
                    await this.navigateToAnnotation(id, false);
                }
            }),
            vscode.commands.registerCommand('stack.forward', async () => {
                const id = this.navigationStack.forward();
                if (id) {
                    await this.navigateToAnnotation(id, false);
                }
            }),

            // LinkedAnnotationManager commands
            vscode.commands.registerCommand('annotations.createLink', async () => {
                const editor = this.getActiveEditor();
                if (!editor) return;
                const sourceAnnotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                if (!sourceAnnotation) {
                    vscode.window.showErrorMessage(
                        localize('noAnnotationOnLineToLink', 'No annotation on this line to link from.')
                    );
                    return;
                }

                // Ask user what they want to do
                const action = await vscode.window.showQuickPick(
                    [
                        { label: '$(link) Link to existing annotation', value: 'existing' },
                        { label: '$(add) Create new linked annotation', value: 'new' },
                    ],
                    {
                        placeHolder: 'How would you like to link this annotation?',
                    }
                );

                if (!action) return;

                if (action.value === 'existing') {
                    // Show list of all annotations to link to
                    const allAnnotations = Array.from(this.annotations.values())
                        .filter((a) => a.id !== sourceAnnotation.id)
                        .sort((a, b) => a.file.localeCompare(b.file));

                    if (allAnnotations.length === 0) {
                        vscode.window.showInformationMessage(
                            localize('noOtherAnnotationsToLink', 'No other annotations found to link to.')
                        );
                        return;
                    }

                    const items = allAnnotations.map((annotation) => ({
                        label: `$(file) ${annotation.file}:${annotation.line}`,
                        description:
                            annotation.message.substring(0, 60) + (annotation.message.length > 60 ? '...' : ''),
                        detail: `Author: ${annotation.author || 'Unknown'} | ${new Date(annotation.timestamp).toLocaleDateString()}`,
                        annotation: annotation,
                    }));

                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select annotation to link to',
                        matchOnDescription: true,
                        matchOnDetail: true,
                    });

                    if (selected && selected.annotation) {
                        // Ask for relationship type
                        const relationship = await vscode.window.showQuickPick(
                            [
                                { label: 'Related to', value: 'related' },
                                { label: 'Implements', value: 'implements' },
                                { label: 'References', value: 'references' },
                                { label: 'Depends on', value: 'depends-on' },
                                { label: 'Blocks', value: 'blocks' },
                                { label: 'Duplicates', value: 'duplicates' },
                            ],
                            {
                                placeHolder: 'Select relationship type',
                            }
                        );

                        if (relationship) {
                            await this.linkedAnnotationManager?.createLink(
                                sourceAnnotation.id,
                                selected.annotation.file,
                                selected.annotation.line,
                                relationship.value
                            );
                            vscode.window.showInformationMessage(
                                localize(
                                    'linkedToAnnotation',
                                    'Linked to annotation in {0}:{1}',
                                    selected.annotation.file,
                                    selected.annotation.line
                                )
                            );
                        }
                    }
                } else {
                    // Create new annotation at specified location
                    const targetFile = await vscode.window.showInputBox({
                        prompt: localize('enterTargetFile', 'Enter target file path (relative to workspace)'),
                        placeHolder: 'src/file.ts',
                        value: editor.document.fileName,
                    });
                    if (!targetFile) return;

                    const targetLine = await vscode.window.showInputBox({
                        prompt: localize('enterTargetLine', 'Enter target line number'),
                        placeHolder: '1',
                        validateInput: (value) => {
                            const num = parseInt(value);
                            return isNaN(num) || num < 1 ? 'Please enter a valid line number' : null;
                        },
                    });
                    if (!targetLine) return;

                    const message = await vscode.window.showInputBox({
                        prompt: localize('enterAnnotationMessage', 'Enter annotation message'),
                        placeHolder: 'Related implementation...',
                    });
                    if (!message) return;
                    const targetLineIndex = parseInt(targetLine, 10) - 1;

                    // Create the new annotation FIRST
                    const newAnnotation: Annotation = {
                        id: this.generateId(),
                        file: this.getRelativePath(targetFile),
                        line: targetLineIndex,
                        message: message,
                        author: this.currentUser,
                        timestamp: new Date().toISOString(),
                        severity: this.config.defaultSeverity,
                    };
                    // Capture anchor if the target document is currently open
                    const linkedDoc = vscode.workspace.textDocuments.find(
                        (d) =>
                            this.normalizePath(this.getRelativePath(d.fileName)) ===
                            this.normalizePath(this.getRelativePath(targetFile))
                    );
                    if (linkedDoc) {
                        await this.populateAnchor(newAnnotation, linkedDoc, newAnnotation.line);
                    }
                    this.annotations.set(newAnnotation.id, newAnnotation);
                    await this.saveAnnotations();
                    await this.refreshAnnotations();

                    // THEN link the annotations (now that target exists)
                    await this.linkedAnnotationManager?.createLink(
                        sourceAnnotation.id,
                        this.getRelativePath(targetFile),
                        targetLineIndex,
                        'related'
                    );

                    vscode.window.showInformationMessage(
                        localize('createdAndLinkedAnnotation', 'Created and linked new annotation')
                    );
                }
            }),
            vscode.commands.registerCommand('annotations.navigateToLinked', async (annotationId?: string) => {
                if (!annotationId) {
                    const editor = this.getActiveEditor();
                    if (!editor) return;
                    const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                    if (!annotation) {
                        vscode.window.showErrorMessage(localize('noAnnotationOnLine', 'No annotation on this line.'));
                        return;
                    }
                    annotationId = annotation.id;
                }

                const annotation = this.annotations.get(annotationId);
                if (!annotation || !annotation.linkedAnnotations || annotation.linkedAnnotations.length === 0) {
                    vscode.window.showInformationMessage(
                        localize('thisAnnotationHasNoLinks', 'This annotation has no links.')
                    );
                    return;
                }

                if (annotation.linkedAnnotations.length === 1) {
                    // Direct navigation if only one link
                    await this.navigateToLinked(annotationId);
                } else {
                    // Show picker if multiple links
                    const items = annotation.linkedAnnotations.map((link, index) => {
                        // Find the target annotation to show its message
                        const targetAnnotation = Array.from(this.annotations.values()).find(
                            (a) => a.file === link.targetFile && a.line === link.targetLine + 1
                        );

                        return {
                            label: `$(link) ${link.relationship || 'related'} → ${link.targetFile}:${link.targetLine + 1}`,
                            description: targetAnnotation
                                ? targetAnnotation.message.substring(0, 60) +
                                  (targetAnnotation.message.length > 60 ? '...' : '')
                                : '',
                            detail: targetAnnotation
                                ? `Author: ${targetAnnotation.author || 'Unknown'} | ${new Date(targetAnnotation.timestamp).toLocaleDateString()}`
                                : '',
                            index: index,
                        };
                    });

                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select linked annotation to navigate to',
                    });

                    if (selected !== undefined) {
                        await this.linkedAnnotationManager?.goToLinkedAnnotation(annotationId, selected.index);
                    }
                }
            }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            vscode.commands.registerCommand('annotations.showLinks', async (treeItemOrId?: any) => {
                let annotationId: string;

                // If called from TreeView inline action, treeItemOrId is the TreeItem
                if (treeItemOrId && typeof treeItemOrId === 'object' && treeItemOrId.annotation) {
                    annotationId = treeItemOrId.annotation.id;
                } else if (typeof treeItemOrId === 'string') {
                    // Called with annotation ID directly
                    annotationId = treeItemOrId;
                } else {
                    // Called from command palette, find annotation at cursor position
                    const editor = this.getActiveEditor();
                    if (!editor) return;
                    const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                    if (!annotation) {
                        vscode.window.showErrorMessage(localize('noAnnotationOnLine', 'No annotation on this line.'));
                        return;
                    }
                    annotationId = annotation.id;
                }

                const annotation = this.annotations.get(annotationId);
                if (!annotation) return;

                // Create webview panel to show links
                const panel = vscode.window.createWebviewPanel(
                    'annotationLinks',
                    `Links for: ${annotation.message.substring(0, 50)}...`,
                    vscode.ViewColumn.Two,
                    { enableScripts: true }
                );

                // Find all incoming links
                const incomingLinks = Array.from(this.annotations.values()).filter(
                    (a) =>
                        a.linkedAnnotations &&
                        a.linkedAnnotations.some(
                            (link) => link.targetFile === annotation.file && link.targetLine === annotation.line
                        )
                );

                panel.webview.html = this.getLinksWebviewContent(annotation, incomingLinks);

                // Handle messages from webview
                panel.webview.onDidReceiveMessage(
                    async (message) => {
                        if (message.command === 'navigate') {
                            try {
                                // Try to open the file with workspace URI
                                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                                let uri: vscode.Uri;

                                if (workspaceFolder) {
                                    // Try as relative path from workspace
                                    uri = vscode.Uri.joinPath(workspaceFolder.uri, message.file);
                                    try {
                                        await vscode.workspace.fs.stat(uri);
                                    } catch {
                                        // Try as absolute path
                                        uri = vscode.Uri.file(message.file);
                                    }
                                } else {
                                    uri = vscode.Uri.file(message.file);
                                }

                                const document = await vscode.workspace.openTextDocument(uri);
                                const editor = await vscode.window.showTextDocument(document);
                                const position = new vscode.Position(message.line, 0);
                                editor.selection = new vscode.Selection(position, position);
                                editor.revealRange(
                                    new vscode.Range(position, position),
                                    vscode.TextEditorRevealType.InCenter
                                );

                                // Find and focus the annotation at that line
                                const annotation = this.findAnnotation(message.file, message.line);
                                if (annotation) {
                                    // Add to navigation stack
                                    this.navigationStack.push(annotation.id);
                                    // Highlight temporarily
                                    this.highlightLineTemporarily(editor, annotation.line);
                                    // Focus in panel if open
                                    this.focusAnnotationInPanel(annotation.id);
                                }
                            } catch (error) {
                                vscode.window.showErrorMessage(
                                    localize(
                                        'failedToNavigate',
                                        'Failed to navigate to {0}:{1}: {2}',
                                        message.file,
                                        message.line + 1,
                                        String(error)
                                    )
                                );
                            }
                        }
                    },
                    undefined,
                    this.disposables
                );
            }),
            vscode.commands.registerCommand('annotations.removeLink', async (annotationId?: string) => {
                if (!annotationId) {
                    const editor = this.getActiveEditor();
                    if (!editor) return;
                    const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                    if (!annotation) {
                        vscode.window.showErrorMessage(localize('noAnnotationOnLine', 'No annotation on this line.'));
                        return;
                    }
                    annotationId = annotation.id;
                }

                const annotation = this.annotations.get(annotationId);
                if (!annotation || !annotation.linkedAnnotations || annotation.linkedAnnotations.length === 0) {
                    vscode.window.showInformationMessage(
                        localize('noLinkedAnnotationsToRemove', 'No linked annotations to remove.')
                    );
                    return;
                }

                // Show quick pick of linked annotations to remove
                const items = annotation.linkedAnnotations.map((link, index) => ({
                    label: `${link.targetFile}:${link.targetLine + 1}`,
                    description: link.relationship,
                    index: index,
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select link to remove',
                });

                if (selected) {
                    const linkToRemove = annotation.linkedAnnotations[selected.index];
                    await this.linkedAnnotationManager?.removeLink(
                        annotationId,
                        linkToRemove.targetFile,
                        linkToRemove.targetLine
                    );
                }
            }),

            // Kanban commands
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            vscode.commands.registerCommand('annotations.moveToColumn', async (treeItemOrId?: any) => {
                let annotationId: string;

                // If called from TreeView inline action, treeItemOrId is the TreeItem
                if (treeItemOrId && typeof treeItemOrId === 'object' && treeItemOrId.annotation) {
                    annotationId = treeItemOrId.annotation.id;
                } else if (typeof treeItemOrId === 'string') {
                    // Called with annotation ID directly
                    annotationId = treeItemOrId;
                } else {
                    // Called from command palette, find annotation at cursor position
                    const editor = this.getActiveEditor();
                    if (!editor) return;
                    const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                    if (!annotation) {
                        vscode.window.showErrorMessage(localize('noAnnotationOnLine', 'No annotation on this line.'));
                        return;
                    }
                    annotationId = annotation.id;
                }

                // Get current kanban columns dynamically
                const items = Array.from(this.kanbanColumns.entries()).map(([id, name]) => ({
                    label: name,
                    value: id,
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select column to move annotation to',
                });

                if (selected) {
                    const annotation = this.annotations.get(annotationId);
                    if (annotation) {
                        annotation.kanbanColumn = selected.value;
                        await this.saveAnnotations();
                        this.emit('annotationChanged', annotation);
                        vscode.window.showInformationMessage(
                            localize('annotationMovedTo', 'Annotation moved to {0}', selected.label)
                        );

                        // Update Kanban view if it's open
                        if (KanbanView.currentPanel) {
                            const updatedAnnotations = Array.from(this.annotations.values());
                            KanbanView.currentPanel.webview.postMessage({
                                command: 'updateAnnotations',
                                annotations: updatedAnnotations.map((a) => ({
                                    id: a.id,
                                    message: a.message,
                                    severity: a.severity,
                                    file: a.file?.split('/').pop() || 'Unknown',
                                    filePath: a.file,
                                    line: a.line,
                                    tags: a.tags || [],
                                    kanbanColumn: a.kanbanColumn || 'todo',
                                    timestamp: a.timestamp,
                                })),
                            });
                        }
                    }
                }
            }),

            // Lot 5 R2 transition: the Kanban commands below were previously
            // registered here against the legacy `manager.kanbanColumns` /
            // `manager.annotations` state. They are now owned by
            // `extension.ts:registerKanbanCommands()` which routes through
            // `KanbanColumnStore` + `AnnotationStore`. Re-registering them
            // here would throw "command already exists" at activation. R3
            // retires AnnotationManager entirely.

            // (annotations.kanban.deleteColumn moved to extension.ts —
            // see Lot 5 R2 transition note above.)

            // TemplateManager commands
            vscode.commands.registerCommand('annotations.applyTemplate', async () => {
                const editor = this.getActiveEditor();
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor found.');
                    return;
                }

                const templates = this.templateManager.getAllTemplates();
                if (templates.length === 0) {
                    vscode.window.showInformationMessage('No templates available. Create one first.');
                    return;
                }

                const selectedTemplate = await this.templateManager.showTemplateQuickPick();
                if (selectedTemplate) {
                    // Get variable values from user
                    const variableValues: Record<string, string> = {};
                    if (selectedTemplate.variables && selectedTemplate.variables.length > 0) {
                        for (const variable of selectedTemplate.variables) {
                            const value = await vscode.window.showInputBox({
                                prompt: `Enter value for ${variable}`,
                                placeHolder: variable,
                            });
                            if (value === undefined) {
                                return; // User cancelled
                            }
                            variableValues[variable] = value;
                        }
                    }

                    // Apply template to get final content
                    const content = await this.applyTemplate(selectedTemplate, variableValues);

                    // Create annotation with template content
                    const annotation: Annotation = {
                        id: this.generateId(),
                        message: content,
                        file: this.getRelativePath(editor.document.fileName),
                        line: editor.selection.active.line,
                        author: this.currentUser || 'Unknown',
                        timestamp: new Date().toISOString(),
                        severity: selectedTemplate.severity || this.config.defaultSeverity,
                        tags: selectedTemplate.tags || [],
                        thread: [],
                        resolved: false,
                    };
                    await this.populateAnchor(annotation, editor.document, annotation.line);
                    // Add the annotation
                    this.annotations.set(annotation.id, annotation);
                    await this.saveAnnotations();
                    await this.refreshAnnotations();

                    vscode.window.showInformationMessage(
                        `Template "${selectedTemplate.name}" applied and annotation created.`
                    );
                }
            }),
            vscode.commands.registerCommand('annotations.createTemplate', async () => {
                await this.templateManager.createTemplateFromUI();
            }),
            vscode.commands.registerCommand('annotations.manageTemplates', async () => {
                // Show template management UI using createTemplateFromUI method
                await this.templateManager.createTemplateFromUI();
            }),

            // SnippetManager commands
            vscode.commands.registerCommand('annotations.addSnippet', async () => {
                const editor = this.getActiveEditor();
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor found.');
                    return;
                }

                // Find annotation at current line
                const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                if (!annotation) {
                    vscode.window.showErrorMessage('No annotation found at current line. Create an annotation first.');
                    return;
                }

                // Get code snippet from user
                const snippet = await vscode.window.showInputBox({
                    prompt: 'Enter code snippet to attach to this annotation',
                    placeHolder: 'console.log("fix"); // Example fix',
                    value: editor.document.getText(editor.selection) || undefined,
                });

                if (!snippet) return;

                // Get description
                const description = await vscode.window.showInputBox({
                    prompt: 'Enter description for this snippet',
                    placeHolder: 'Quick fix for token validation',
                });

                if (!description) return;

                const language = editor.document.languageId;
                const result = await this.addSnippet(annotation, snippet, language);

                // Update the annotation in our collection
                this.annotations.set(result.id, result);
                await this.saveAnnotations();
                await this.refreshAnnotations();

                vscode.window.showInformationMessage(`Code snippet attached to annotation: ${result.id}`);
            }),
            vscode.commands.registerCommand('annotations.applySnippet', async () => {
                const editor = this.getActiveEditor();
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor found.');
                    return;
                }

                // Find annotation at current line
                const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
                if (!annotation) {
                    vscode.window.showErrorMessage('No annotation found at current line.');
                    return;
                }

                // Check if annotation has a snippet
                if (!annotation.snippet || !annotation.snippet.code) {
                    vscode.window.showErrorMessage('This annotation does not have a code snippet attached.');
                    return;
                }

                // Apply the snippet
                try {
                    await this.applySnippet(annotation, editor);
                    vscode.window.showInformationMessage('Code snippet applied successfully.');
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to apply snippet: ${error}`);
                }
            }),
            vscode.commands.registerCommand('annotations.previewSnippet', async () => {
                const snippets = this.snippetManager.getSnippetHistory();
                if (snippets.length === 0) {
                    vscode.window.showInformationMessage('No snippets available');
                    return;
                }

                const selectedSnippet: vscode.QuickPickItem | undefined = await vscode.window.showQuickPick(
                    snippets.map((s) => ({
                        label: s.annotationId,
                        description: `${s.file}:${s.line} - ${s.timestamp}`,
                    })),
                    { placeHolder: 'Select a snippet to preview' }
                );

                if (selectedSnippet) {
                    const annotation = this.annotations.get(selectedSnippet.label);
                    if (annotation) {
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            await this.previewSnippet(annotation, editor);
                        }
                    }
                }
            }),
            vscode.commands.registerCommand('annotations.manageSnippets', () => {
                // Show snippet history or create a quick pick for snippet management
                const history = this.snippetManager.getSnippetHistory();
                if (history.length === 0) {
                    vscode.window.showInformationMessage('No snippets in history');
                } else {
                    vscode.window.showQuickPick(
                        history.map((h) => ({
                            label: `${h.file}:${h.line}`,
                            description: `Applied at ${h.timestamp}`,
                            detail: h.originalCode,
                        }))
                    );
                }
            })
        );
    }

    public async moveAnnotationUp(annotationId: string): Promise<void> {
        const annotation = this.annotations.get(annotationId);
        if (!annotation) return;

        if (annotation.line === 0) {
            vscode.window.showWarningMessage(
                localize('cannotMoveAboveFirstLine', 'Cannot move annotation above the first line.')
            );
            return;
        }

        const absoluteFilePath = this.getAbsolutePath(annotation.file);
        const document = await vscode.workspace.openTextDocument(absoluteFilePath);
        this.setAnnotationLine(annotation, annotation.line - 1, document);
        await this.saveAnnotations();
        await this.refreshAnnotations();
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(localize('annotationMovedUp', 'Annotation moved up successfully!'));
    }

    public async moveAnnotationDown(annotationId: string): Promise<void> {
        const annotation = this.annotations.get(annotationId);
        if (!annotation) return;

        const absoluteFilePath = this.getAbsolutePath(annotation.file);
        const document = await vscode.workspace.openTextDocument(absoluteFilePath);

        if (annotation.line >= document.lineCount - 1) {
            vscode.window.showWarningMessage(
                localize('cannotMoveBelowLastLine', 'Cannot move annotation below the last line.')
            );
            return;
        }

        this.setAnnotationLine(annotation, annotation.line + 1, document);
        await this.saveAnnotations();
        await this.refreshAnnotations();
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(localize('annotationMovedDown', 'Annotation moved down successfully!'));
    }

    private async autoResolveStaleAnnotations(): Promise<void> {
        const now = Date.now();
        const staleThreshold = 1000 * 60 * 60 * 24 * 7; // 7 jours
        let resolvedCount = 0;
        for (const [_id, annotation] of this.annotations) {
            const age = now - new Date(annotation.timestamp).getTime();
            if (!annotation.resolved && age > staleThreshold) {
                annotation.resolved = true;
                resolvedCount++;
            }
        }
        if (resolvedCount > 0) {
            await this.saveAnnotations();
            await this.refreshAnnotations();
            vscode.window.showInformationMessage(
                localize('staleResolved', '{0} stale annotations resolved automatically!', resolvedCount)
            );
        } else {
            vscode.window.showInformationMessage(localize('noStale', 'No stale annotations found.'));
        }
    }

    private async batchEditAnnotations(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const fileAnnotations = this.getAnnotationsForFile(editor.document.fileName);
        if (fileAnnotations.length === 0) {
            vscode.window.showInformationMessage(
                localize('noAnnotationsForFile', 'No annotations found for this file.')
            );
            return;
        }

        const newMessage = await vscode.window.showInputBox({
            prompt: localize('enterBatchMessage', 'Enter a new message for all annotations in this file'),
            validateInput: (text) =>
                text.trim().length === 0 ? localize('emptyMessageError', 'Message cannot be empty') : null,
        });
        if (!newMessage) return;

        for (const annotation of fileAnnotations) {
            annotation.message = newMessage;
            annotation.timestamp = new Date().toISOString();
        }
        await this.saveAnnotations();
        await this.refreshAnnotations();
        vscode.window.showInformationMessage(
            localize('batchEdited', 'All annotations in this file have been updated!')
        );
    }

    private async filterBySeverity(): Promise<void> {
        const severity = await vscode.window.showQuickPick(['info', 'warning', 'error'], {
            placeHolder: localize('chooseSeverity', 'Choose a severity to filter by'),
        });
        if (!severity) return;
        this.currentFilter = `severity:${severity}`;
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(localize('severityFilter', 'Filter by severity applied.'));
    }

    private highlightLineTemporarily(editor: vscode.TextEditor, line: number, duration = 2000): void {
        const range = editor.document.lineAt(line).range;
        editor.setDecorations(this.temporaryHighlightDecoration, [range]);
        setTimeout(() => {
            editor.setDecorations(this.temporaryHighlightDecoration, []);
        }, duration);
    }

    private handleSort(sortValue: string): void {
        this.currentSort = sortValue;
    }

    private handleFilter(filterValue: string): void {
        this.currentFilter = filterValue;
        this.updateAnnotationsPanel();
    }

    private applyCurrentSorting(annotations: Annotation[]): void {
        switch (this.currentSort) {
            case 'line_asc':
                annotations.sort((a, b) => a.line - b.line);
                break;
            case 'line_desc':
                annotations.sort((a, b) => b.line - a.line);
                break;
            case 'date_desc':
                annotations.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                break;
            case 'date_asc':
                annotations.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                break;
            case 'comments_desc':
                annotations.sort((a, b) => (b.thread?.length || 0) - (a.thread?.length || 0));
                break;
            case 'comments_asc':
                annotations.sort((a, b) => (a.thread?.length || 0) - (b.thread?.length || 0));
                break;
        }
    }

    private async updateComment(commentId: string, newMessage: string): Promise<void> {
        for (const annotation of this.annotations.values()) {
            const comment = annotation.thread?.find((c) => c.id === commentId);
            if (comment) {
                comment.message = newMessage;
                comment.timestamp = new Date().toISOString();
                await this.saveAnnotations();
                await this.refreshAnnotations();
                break;
            }
        }
    }

    private async deleteComment(annotationId: string, commentId: string): Promise<void> {
        const annotation = this.annotations.get(annotationId);
        if (annotation && annotation.thread) {
            annotation.thread = annotation.thread.filter((c) => c.id !== commentId);
            await this.saveAnnotations();
            await this.refreshAnnotations();
        }
    }

    private async editAnnotationInline(annotation: Annotation): Promise<void> {
        const newMessage = await vscode.window.showInputBox({
            prompt: localize('editAnnotationPrompt', 'Edit annotation message'),
            value: annotation.message,
            validateInput: (text) =>
                text.trim().length === 0 ? localize('emptyMessageError', 'Message cannot be empty') : null,
        });
        if (!newMessage) return;
        annotation.message = newMessage;
        annotation.timestamp = new Date().toISOString();
        await this.saveAnnotations();
        await this.refreshAnnotations();
        vscode.window.showInformationMessage(localize('annotationModified', 'Annotation modified successfully!'));
    }

    private async manageAnnotationCommand(annotations: Annotation[]): Promise<void> {
        const options = annotations.flatMap((annotation) => [
            { label: `Edit: ${annotation.message}`, action: () => this.modifyAnnotation(annotation.id) },
            { label: `Delete: ${annotation.message}`, action: () => this.deleteAnnotation(annotation.id) },
        ]);

        const selected = await vscode.window.showQuickPick(
            options.map((opt) => opt.label),
            { placeHolder: localize('chooseAction', 'Choose an action for annotations on this line') }
        );

        const selectedOption = options.find((opt) => opt.label === selected);
        if (selectedOption) {
            await selectedOption.action();
        }
    }

    private registerEventHandlers(): void {
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(this.handleDocumentOpen.bind(this)),
            vscode.window.onDidChangeActiveTextEditor(this.handleEditorChange.bind(this)),
            vscode.workspace.onDidChangeTextDocument(this.handleDocumentChange.bind(this)),
            vscode.window.onDidChangeVisibleTextEditors(async (_editors) => {
                await this.refreshAnnotations();
            }),
            vscode.workspace.onDidRenameFiles(this.handleFileRename.bind(this)),
            vscode.workspace.onDidDeleteFiles(this.handleFileDelete.bind(this)),
            vscode.workspace.onDidChangeConfiguration(this.handleConfigurationChange.bind(this))
        );
    }

    private async convertAnnotationToIssue(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationIssue', 'No annotation found on this line.'));
            return;
        }

        const repo = vscode.workspace.getConfiguration('annotation').get<string>('github.repository', '');
        if (!repo || !repo.includes('/')) {
            vscode.window.showErrorMessage(
                'GitHub repository not configured properly. Set "annotation.github.repository": "owner/repo" in settings.'
            );
            return;
        }

        const [owner, repoName] = repo.split('/');
        const secretStorage = this.context.secrets;
        let githubToken = await secretStorage.get('annotation.github.token');
        if (!githubToken) {
            githubToken = await vscode.window.showInputBox({
                prompt: 'Enter your GitHub personal access token (with repo scope)',
                password: true,
            });
            if (!githubToken) {
                vscode.window.showErrorMessage('GitHub token is required to create issues.');
                return;
            }
            await secretStorage.store('annotation.github.token', githubToken);
        }

        try {
            const { Octokit } = await import('@octokit/rest');
            const octokit = new Octokit({ auth: githubToken });
            const title = `Annotation: ${annotation.message.substring(0, 50)}`;
            const body = `**File:** ${annotation.file}\n**Line:** ${annotation.line + 1}\n**Message:** ${annotation.message}\n\n_Converted from Out-of-Code Insights annotation._`;

            const response = await octokit.issues.create({
                owner,
                repo: repoName,
                title,
                body,
            });

            if (response && response.data && response.data.html_url) {
                vscode.window.showInformationMessage(`GitHub issue created: ${response.data.html_url}`);
                annotation.tags = annotation.tags || [];
                if (!annotation.tags.includes('GitHubIssue')) {
                    annotation.tags.push('GitHubIssue');
                }
                await this.saveAnnotations();
                await this.refreshAnnotations();
                this.emit('annotationChanged');
            } else {
                vscode.window.showErrorMessage('Failed to create GitHub issue.');
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
            vscode.window.showErrorMessage('Error creating GitHub issue: ' + error.message);
        }
    }

    public async addAnnotation(args?: { line: number }): Promise<void> {
        try {
            const editor = this.getActiveEditor();
            if (!editor) {
                vscode.window.showErrorMessage(localize('noActiveEditor', 'No active editor found.'));
                return;
            }

            const line = args?.line ?? editor.selection.active.line;

            if (!Number.isInteger(line) || line < 0 || line >= editor.document.lineCount) {
                vscode.window.showErrorMessage(localize('invalidLineError', 'Illegal value for `line`.'));
                return;
            }

            const message = await this.promptAnnotationMessage();
            if (!message) return;

            const relativeFilePath = this.getRelativePath(editor.document.fileName);

            const annotation: Annotation = {
                id: this.generateId(),
                file: relativeFilePath,
                line,
                message,
                author: this.currentUser,
                timestamp: new Date().toISOString(),
                thread: [],
                tags: [],
                pinned: false,
                priority: 0,
                severity: this.config.defaultSeverity,
                resolved: false,
            };
            await this.populateAnchor(annotation, editor.document, line);

            // Note: a previous version re-checked findAnnotation against the
            // RESOLVED line and rejected duplicates. That blocked legitimate
            // multi-annotation use cases (two notes both anchored to the same
            // function header from different blank-line clicks above it).
            // Stacking multiple annotations on a single line is supported -- the
            // panel groups them and the gutter shows a single icon per line.

            this.annotations.set(annotation.id, annotation);
            await this.applyAnnotation(editor, annotation);
            await this.saveAnnotations();
            this.updateStatusBar();
            this.updateAnnotationsPanel();
            this.highlightLineTemporarily(editor, line);

            vscode.window.showInformationMessage(localize('annotationAdded', 'Annotation added successfully!'));
            this.emit('annotationChanged');
        } catch (error) {
            this.handleError(localize('addAnnotationError', 'Failed to add annotation'), error);
        }
    }

    /**
     * Update annotation.line and recapture its anchor snapshot.
     * Pass doc to refresh lineHash/contextBefore/contextAfter; omit doc
     * when the document is not available (e.g. TreeView ordering).
     */
    public setAnnotationLine(annotation: Annotation, newLine: number, doc?: vscode.TextDocument): void {
        annotation.line = newLine;
        if (doc && newLine >= 0 && newLine < doc.lineCount) {
            // Caller has chosen newLine deliberately (e.g. after a paste-recover or
            // arithmetic shift); do not walk to a different line.
            const exactAnchor = captureAnchor(doc, newLine, { walkForward: 0, walkBackward: 0 });
            const trackingAnchor = captureAnchor(doc, newLine);
            this.applyAnnotationLineAnchors(annotation, newLine, exactAnchor, trackingAnchor);
        }
    }

    private setAnnotationLineWithTrackingLine(
        annotation: Annotation,
        renderLine: number,
        trackingLine: number,
        doc: vscode.TextDocument
    ): void {
        const clampedRenderLine = this.clampDocumentLine(renderLine, doc);
        const clampedTrackingLine = this.clampDocumentLine(trackingLine, doc);
        const exactAnchor = captureAnchor(doc, clampedRenderLine, {
            walkForward: 0,
            walkBackward: 0,
        });
        const trackingAnchor = captureAnchor(doc, clampedTrackingLine, {
            walkForward: 0,
            walkBackward: 0,
        });
        this.applyAnnotationLineAnchors(annotation, clampedRenderLine, exactAnchor, trackingAnchor);
    }

    private applyAnnotationLineAnchors(
        annotation: Annotation,
        renderLine: number,
        exactAnchor: AnchorData,
        trackingAnchor: AnchorData
    ): void {
        annotation.line = renderLine;
        annotation.lineHash = exactAnchor.lineHash;
        annotation.contextBefore = exactAnchor.contextBefore;
        annotation.contextAfter = exactAnchor.contextAfter;

        annotation.anchor = {
            ...(annotation.anchor ?? {
                kind: 'line' as const,
                originalLine: renderLine,
                symbolName: null,
                symbolKind: null,
                symbolSignature: null,
            }),
            targetLine: trackingAnchor.targetLine ?? renderLine,
            anchorTextHash: trackingAnchor.lineHash,
            contextBefore: trackingAnchor.contextBefore,
            contextAfter: trackingAnchor.contextAfter,
        };
    }

    private clampDocumentLine(line: number, doc: vscode.TextDocument): number {
        return Math.max(0, Math.min(line, doc.lineCount - 1));
    }

    /** Store a line-by-line snapshot of doc for move detection. */
    private snapshotDocument(doc: vscode.TextDocument): void {
        const lines: string[] = [];
        for (let i = 0; i < doc.lineCount; i++) {
            lines.push(doc.lineAt(i).text);
        }
        this.documentSnapshots.set(doc.uri.toString(), lines);
        this.log(`snapshot: ${doc.uri.toString()} (${lines.length} lines)`);
    }

    public async importAnnotationsJSON(): Promise<void> {
        const uri = await vscode.window.showOpenDialog({ filters: { JSON: ['json'] }, canSelectMany: false });
        if (!uri || uri.length === 0) {
            vscode.window.showInformationMessage(localize('importCancelled', 'Import cancelled.'));
            return;
        }
        try {
            const fileData = await vscode.workspace.fs.readFile(uri[0]);
            const content = Buffer.from(fileData).toString('utf8');
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) {
                throw new Error('Invalid format: expected an array of annotations.');
            }
            for (const a of parsed) {
                if (typeof a !== 'object' || a === null || typeof a.id !== 'string' || typeof a.message !== 'string') {
                    throw new Error('Invalid annotation object: missing required fields id or message.');
                }
            }
            const importedAnnotations = parsed as Annotation[];
            for (const annotation of importedAnnotations) {
                this.annotations.set(annotation.id, annotation);
            }
            await this.saveAnnotations();
            await this.refreshAnnotations();
            vscode.window.showInformationMessage(localize('importSuccessful', 'Annotations imported successfully!'));
        } catch (error) {
            vscode.window.showErrorMessage(
                localize(
                    'importFailed',
                    'Failed to import annotations: {0}',
                    error instanceof Error ? error.message : String(error)
                )
            );
        }
        this.emit('annotationChanged');
    }

    public async exportAnnotationsJSON(): Promise<void> {
        const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] } });
        if (!uri) {
            vscode.window.showInformationMessage(localize('exportCancelled', 'Export cancelled.'));
            return;
        }
        try {
            const annotationsArray = this.getPersistableAnnotations();
            const content = JSON.stringify(annotationsArray, null, 2);
            const fileData = Buffer.from(content, 'utf8');
            await vscode.workspace.fs.writeFile(uri, fileData);
            vscode.window.showInformationMessage(localize('exportSuccessful', 'Annotations exported successfully!'));
        } catch (error) {
            vscode.window.showErrorMessage(
                localize(
                    'exportFailed',
                    'Failed to export annotations: {0}',
                    error instanceof Error ? error.message : String(error)
                )
            );
        }
    }

    public async saveAnnotations(): Promise<void> {
        const annotationFilePath = this.getProjectAnnotationsPath();
        if (!annotationFilePath) {
            this.log('No workspace folder open; skipping annotation save.');
            return;
        }
        const annotationsArray = this.getPersistableAnnotations();
        const content = JSON.stringify(annotationsArray, null, 2);
        const fileData = Buffer.from(content, 'utf8');
        const fileUri = vscode.Uri.file(annotationFilePath);
        await vscode.workspace.fs.writeFile(fileUri, fileData);
    }

    private getPersistableAnnotations(): Omit<Annotation, 'resolvedAnchor'>[] {
        return Array.from(this.annotations.values()).map((annotation) => {
            const { resolvedAnchor: _resolvedAnchor, ...persisted } = annotation;
            return persisted;
        });
    }

    private async saveKanbanColumns(): Promise<void> {
        const columnsArray = Array.from(this.kanbanColumns.entries());
        await this.context.globalState.update('kanbanColumns', columnsArray);
    }

    private async loadKanbanColumns(): Promise<void> {
        this.log('Loading Kanban columns...');
        const savedColumns = this.context.globalState.get<[string, string][]>('kanbanColumns');
        if (savedColumns && Array.isArray(savedColumns)) {
            this.kanbanColumns.clear();
            savedColumns.forEach(([id, name]) => {
                this.kanbanColumns.set(id, name);
            });
            this.log(`Loaded ${savedColumns.length} custom columns`);
        } else {
            this.log('Using default Kanban columns');
        }
    }

    public async loadAnnotations(): Promise<void> {
        this.log('Loading annotations...');
        await this.ensureAnnotationsFileExists();
        const annotationFilePath = this.getProjectAnnotationsPath();
        if (!annotationFilePath) {
            this.log('No workspace folder open; annotations cannot be loaded yet.');
            this.annotations.clear();
            return;
        }
        const fileUri = vscode.Uri.file(annotationFilePath);

        try {
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(fileData).toString('utf8');
            const rawArray = JSON.parse(content) as Annotation[];
            // Defensive sanity: drop entries with no id/message (data corruption).
            const valid = rawArray
                .filter((a) => a && typeof a.id === 'string' && typeof a.message === 'string')
                .map((a) => {
                    delete a.resolvedAnchor;
                    return a;
                });
            // Migrate legacy schema (assigns fileUri, marks suspicious entries as stale)
            // then collapse exact (file, timestamp, message) triplets.
            const migrated = valid.map((a) => this.migrateLegacyAnnotation(a));
            const deduped = this.deduplicateLegacyAnnotations(migrated);
            this.annotations.clear();
            let staleCount = 0;
            for (const annotation of deduped) {
                // Ensure kanbanColumn has a default value
                if (!annotation.kanbanColumn) {
                    annotation.kanbanColumn = 'todo';
                }
                if (annotation.resolvedAnchor?.status === 'stale') {
                    staleCount++;
                }
                this.annotations.set(annotation.id, annotation);
            }
            this.log(
                `Loaded ${this.annotations.size} annotations` +
                    (rawArray.length !== this.annotations.size
                        ? ` (${rawArray.length - this.annotations.size} dropped/deduped)`
                        : '') +
                    (staleCount > 0 ? ` -- ${staleCount} marked stale by migration` : '')
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to load annotations: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async searchAnnotationsByTag(): Promise<void> {
        const tag = await vscode.window.showInputBox({ prompt: localize('enterTag', 'Enter a tag to search') });
        if (!tag) return;
        this.currentFilter = tag;
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(localize('tagFilterApplied', 'Filter by tag applied.'));
    }

    private async togglePinAnnotation(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationPin', 'No annotation found on this line.'));
            return;
        }
        annotation.pinned = !annotation.pinned;
        await this.saveAnnotations();
        await this.refreshAnnotations();
        this.clearDecorations(editor);
        const allAnnotations = this.getAnnotationsForFile(editor.document.fileName);
        await this.applyAnnotations(editor, allAnnotations);
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(
            annotation.pinned
                ? localize('annotationPinned', 'Annotation pinned!')
                : localize('annotationUnpinned', 'Annotation unpinned!')
        );
    }

    private async setAnnotationSeverity(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationPin', 'No annotation found on this line.'));
            return;
        }
        const severity = await vscode.window.showQuickPick(['info', 'warning', 'error'], {
            placeHolder: localize('selectSeverity', 'Select a severity for the annotation'),
        });
        if (!severity) return;
        annotation.severity = severity;
        annotation.timestamp = new Date().toISOString();
        await this.saveAnnotations();
        await this.refreshAnnotations();
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(
            localize('severityUpdated', 'Annotation severity updated to {0}', severity)
        );
        this.emit('annotationChanged');
    }

    private async changeSeverity(annotationId: string): Promise<void> {
        const annotation = this.annotations.get(annotationId);
        if (!annotation) return;

        const severityOptions = [
            { label: '❌ Error', value: 'error' },
            { label: '⚠️ Warning', value: 'warning' },
            { label: 'ℹ️ Info', value: 'info' },
        ];

        const selectedSeverityItem = await vscode.window.showQuickPick(severityOptions, {
            placeHolder: localize('selectSeverity', 'Select annotation severity'),
        });

        if (selectedSeverityItem && selectedSeverityItem.value !== annotation.severity) {
            annotation.severity = selectedSeverityItem.value;
            annotation.timestamp = new Date().toISOString();
            await this.saveAnnotations();
            await this.refreshAnnotations();
            this.updateAnnotationsPanel();
            vscode.window.showInformationMessage(
                localize('severityUpdated', 'Annotation severity updated to {0}', selectedSeverityItem.value)
            );
            this.emit('annotationChanged');
        }
    }

    private async editAnnotationTags(annotationId?: string): Promise<void> {
        if (!annotationId) {
            const editor = this.getActiveEditor();
            if (!editor) return;
            const annotation = this.findAnnotation(editor.document.fileName, editor.selection.active.line);
            if (!annotation) {
                vscode.window.showErrorMessage(localize('noAnnotationEdit', 'No annotation found on this line.'));
                return;
            }
            annotationId = annotation.id;
        }

        const annotation = this.annotations.get(annotationId);
        if (!annotation) return;

        const currentTags = (annotation.tags || []).join(', ');
        const input = await vscode.window.showInputBox({
            prompt: localize('enterTags', 'Enter tags (comma separated)'),
            value: currentTags,
        });
        if (input === undefined) return;

        annotation.tags = input
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        annotation.timestamp = new Date().toISOString();
        await this.saveAnnotations();
        await this.refreshAnnotations();
        this.updateAnnotationsPanel();
        vscode.window.showInformationMessage(localize('tagsUpdated', 'Annotation tags updated!'));
        this.emit('annotationChanged');
    }

    private async showAnnotationsPanel(): Promise<void> {
        if (this.annotationsPanel) {
            this.annotationsPanel.reveal(vscode.ViewColumn.Beside);
            this.updateAnnotationsPanel();
            return;
        }

        this.annotationsPanel = vscode.window.createWebviewPanel(
            'annotations',
            localize('annotationsTitle', 'Out-of-Code Insights'),
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        this.annotationsPanel.onDidDispose(() => {
            this.annotationsPanel = undefined;
        });

        this.annotationsPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'reply':
                    await this.replyToAnnotation(message.annotationId);
                    break;
                case 'modify':
                    await this.modifyAnnotation(message.annotationId);
                    break;
                case 'delete':
                    await this.deleteAnnotation(message.annotationId);
                    break;
                case 'navigate':
                    await this.navigateToAnnotation(message.annotationId);
                    break;
                case 'sort':
                    this.handleSort(message.value);
                    break;
                case 'filter':
                    this.handleFilter(message.value);
                    break;
                case 'updateComment':
                    await this.updateComment(message.commentId, message.newMessage);
                    break;
                case 'deleteComment':
                    await this.deleteComment(message.annotationId, message.commentId);
                    break;
                case 'moveUp':
                    await this.moveAnnotationUp(message.annotationId);
                    break;
                case 'moveDown':
                    await this.moveAnnotationDown(message.annotationId);
                    break;
                case 'changeSeverity':
                    await this.changeSeverity(message.annotationId);
                    break;
                case 'editTags':
                    await this.editAnnotationTags(message.annotationId);
                    break;
                case 'navigateToTreeView':
                    await vscode.commands.executeCommand('workbench.view.extension.annotations');
                    break;
            }
            this.updateAnnotationsPanel();
        });

        this.updateAnnotationsPanel();
    }

    public async navigateToAnnotation(annotationId: string, record = true): Promise<void> {
        const annotation = this.annotations.get(annotationId);
        if (!annotation) {
            vscode.window.showErrorMessage(`Annotation not found for id: ${annotationId}`);
            return;
        }
        const absoluteFilePath = this.getAbsolutePath(annotation.file);
        const uri = vscode.Uri.file(absoluteFilePath);
        let document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath);
        if (!document) {
            document = await vscode.workspace.openTextDocument(uri);
        }
        let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === uri.fsPath);
        if (!editor) {
            editor = await vscode.window.showTextDocument(document);
        } else {
            await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn });
        }
        const line = annotation.line;
        if (line < editor.document.lineCount) {
            const range = editor.document.lineAt(line).range;
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        if (record) {
            this.navigationStack.push(annotationId);
        }
    }

    /**
     * Focus on a specific annotation in the annotations panel
     */
    public focusAnnotationInPanel(annotationId: string): void {
        if (this.annotationsPanel) {
            this.annotationsPanel.webview.postMessage({
                command: 'focusAnnotation',
                annotationId: annotationId,
            });
        }
    }

    private async updateAnnotationsPanel(): Promise<void> {
        if (!this.annotationsPanel) {
            return;
        }
        const retryLimit = 3;
        let retryCount = 0;
        const updateContent = async () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                this.annotationsPanel!.webview.html = this.getAnnotationsPanelHtml();
            } catch (error) {
                if (retryCount < retryLimit) {
                    retryCount++;
                    setTimeout(updateContent, 500);
                }
            }
        };
        await updateContent();
    }

    private getAnnotationsPanelHtml(): string {
        const annotations = Array.from(this.annotations.values()).filter((a) => this.shouldAnnotationBeVisible(a));
        this.applyCurrentSorting(annotations);

        const groupedAnnotations = annotations.reduce(
            (groups, annotation) => {
                if (!groups[annotation.file]) {
                    groups[annotation.file] = [];
                }
                groups[annotation.file].push(annotation);
                return groups;
            },
            {} as Record<string, Annotation[]>
        );

        const allFiles = Object.keys(groupedAnnotations);
        const totalAnnotations = annotations.length;

        const codiconUri = this.annotationsPanel?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        // Enhanced CSS including all search features
        const styles = `
            body {
                font-family: var(--vscode-editor-font-family, sans-serif);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                margin: 0;
                padding: 0;
            }
            .container {
                padding: 1em;
            }
            .toolbar {
                display: flex;
                flex-direction: column;
                gap: 1em;
                margin-bottom: 1em;
                border-bottom: 1px solid var(--vscode-editorWidget-border);
                padding-bottom: 1em;
            }
            .title {
                font-size: 1.3em;
                font-weight: bold;
            }
            
            /* Inline search bar */
            .search-container {
                display: flex;
                align-items: center;
                gap: 0.5em;
                padding: 0.5em;
                background-color: var(--vscode-editorWidget-background);
                border: 1px solid var(--vscode-editorWidget-border);
                border-radius: 4px;
            }
            .search-input {
                flex: 1;
                padding: 0.5em;
                border: 1px solid var(--vscode-editorWidget-border);
                border-radius: 3px;
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                font-family: var(--vscode-editor-font-family);
            }
            .search-input:focus {
                outline: 1px solid var(--vscode-focusBorder);
                border-color: var(--vscode-focusBorder);
            }
            .search-button {
                padding: 0.5em 1em;
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 3px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 0.3em;
            }
            .search-button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .search-results-info {
                font-size: 0.9em;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 0.5em;
                padding: 0.3em 0.5em;
                background-color: var(--vscode-editorHint-background);
                border-radius: 3px;
            }
            
            .filters {
                display: flex;
                gap: 1em;
                align-items: center;
                flex-wrap: wrap;
            }
            .filter-group {
                display: flex;
                align-items: center;
                gap: 0.3em;
            }
            .filters select, .filters input {
                padding: 0.4em 0.6em;
                border: 1px solid var(--vscode-editorWidget-border);
                border-radius: 4px;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-foreground);
                font-size: 0.9em;
            }
            .filters select:focus, .filters input:focus {
                outline: 1px solid var(--vscode-focusBorder);
                border-color: var(--vscode-focusBorder);
            }
            
            .file-group {
                margin-bottom: 2em;
            }
            .file-header {
                font-size: 1.1em;
                font-weight: bold;
                margin-bottom: 0.5em;
                padding: 0.5em;
                border-bottom: 1px solid var(--vscode-editorWidget-border);
                background-color: var(--vscode-editorGroupHeader-tabsBackground);
                border-radius: 4px 4px 0 0;
                display: flex;
                align-items: center;
                gap: 0.5em;
                position: sticky;
                top: 0;
                z-index: 10;
            }
            .file-header .file-icon {
                color: var(--vscode-textPreformat-foreground);
            }
            .file-header .file-stats {
                margin-left: auto;
                font-size: 0.8em;
                color: var(--vscode-descriptionForeground);
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 2px 6px;
                border-radius: 10px;
            }
            
            .annotation-card {
                background-color: var(--vscode-sideBar-background);
                border: 1px solid var(--vscode-editorWidget-border);
                border-radius: 5px;
                margin-bottom: 1em;
                padding: 1em;
                transition: all 0.3s ease;
                cursor: pointer;
                position: relative;
                scroll-margin-top: 20px;
            }
            .annotation-card:hover {
                background-color: var(--vscode-list-hoverBackground);
                transform: scale(1.01);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            }
            
            /* Highlight enhancements during search */
            .annotation-card.highlight {
                background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 255, 0, 0.3));
                border: 2px solid var(--vscode-editor-findMatchBorder, #ffd700);
                box-shadow: 0 0 10px var(--vscode-editor-findMatchHighlightBackground, rgba(255, 255, 0, 0.3));
                transform: scale(1.02);
                animation: highlightPulse 0.6s ease-in-out;
            }
            @keyframes highlightPulse {
                0% {
                    transform: scale(1);
                    box-shadow: 0 0 0 rgba(255, 215, 0, 0.4);
                }
                50% {
                    transform: scale(1.03);
                    box-shadow: 0 0 20px rgba(255, 215, 0, 0.6);
                }
                100% {
                    transform: scale(1.02);
                    box-shadow: 0 0 10px rgba(255, 215, 0, 0.3);
                }
            }
            
            /* Style for focused but not highlighted annotation cards */
            .annotation-card.focused {
                border: 2px solid var(--vscode-focusBorder);
                outline: none;
            }
            
            /* Severity-specific annotation styles */
            .annotation-card[data-severity="error"] {
                border-left: 4px solid var(--vscode-errorForeground, #ff6b6b);
            }
            .annotation-card[data-severity="warning"] {
                border-left: 4px solid var(--vscode-warningForeground, #ffa500);
            }
            .annotation-card[data-severity="info"] {
                border-left: 4px solid var(--vscode-infoForeground, #4dabf7);
            }
            
            /* Left scroll indicator */
            .annotation-card::before {
                content: '';
                position: absolute;
                left: 0;
                top: 0;
                bottom: 0;
                width: 3px;
                background-color: transparent;
                transition: background-color 0.3s ease;
            }
            .annotation-card.highlight::before {
                background-color: var(--vscode-editor-findMatchBorder, #ffd700);
            }
            .annotation-card.focused::before {
                background-color: var(--vscode-focusBorder);
            }
            
            .annotation-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0.5em;
            }
            .annotation-author {
                font-weight: bold;
                color: var(--vscode-textLink-foreground);
            }
            .severity-icon {
                font-size: 1.1em;
                margin: 0 0.5em;
                padding: 2px 4px;
                border-radius: 3px;
                background-color: var(--vscode-badge-background);
            }
            .badge {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border-radius: 12px;
                padding: 2px 8px;
                font-size: 0.8em;
                margin-left: 0.5em;
                opacity: 0.7;
            }
            .annotation-timestamp {
                color: var(--vscode-editorHint-foreground);
                font-size: 0.9em;
            }
            .annotation-message {
                margin: 0.5em 0;
                white-space: pre-wrap;
            }
            .annotation-file-info {
                color: var(--vscode-descriptionForeground);
                font-size: 0.9em;
                margin-bottom: 0.5em;
            }
            .annotation-tags {
                color: var(--vscode-descriptionForeground);
                font-size: 0.8em;
                margin-bottom: 0.5em;
            }
            .comment-thread {
                margin-top: 1em;
                border-left: 2px solid var(--vscode-editorIndentGuide-activeBackground);
                padding-left: 1em;
                position: relative;
            }
            .comment {
                margin-bottom: 1em;
            }
            .action-buttons {
                display: flex;
                gap: 0.5em;
                margin-top: 0.5em;
                flex-wrap: wrap;
                opacity: 0.7;
                transition: opacity 0.3s ease;
            }
            .annotation-card:hover .action-buttons {
                opacity: 1;
            }
            .action-button {
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: 1px solid var(--vscode-button-border);
                padding: 0.4em 0.6em;
                border-radius: 3px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 0.3em;
                font-size: 0.85em;
                transition: all 0.2s ease;
            }
            .action-button:hover {
                background-color: var(--vscode-button-hoverBackground);
                transform: translateY(-1px);
            }
            .action-button:active {
                transform: translateY(0);
            }
            .no-annotations {
                text-align: center;
                padding: 2em;
                color: var(--vscode-editorHint-foreground);
                font-style: italic;
                border: 2px dashed var(--vscode-editorWidget-border);
                border-radius: 8px;
                margin: 2em 0;
            }
            .no-annotations::before {
                content: "📝";
                display: block;
                font-size: 2em;
                margin-bottom: 0.5em;
            }
            .icon-button {
                background: none;
                border: none;
                cursor: pointer;
                padding: 0.5em;
                display: inline-flex;
                align-items: center;
            }
            .icon-button:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            html {
                scroll-behavior: smooth;
            }
            @media (max-width: 400px) {
                .filters {
                    flex-direction: column;
                    align-items: stretch;
                    gap: 0.5em;
                }
                .action-buttons {
                    flex-direction: column;
                }
                .action-button {
                    justify-content: center;
                }
            }
        `;

        // Improved search bar and filters
        const searchAndFilters = `
            <div class="toolbar">
                <div class="title">${loc('annotationsTitle', 'Out-of-Code Insights')} (${totalAnnotations})</div>
                
                <!-- Inline search bar -->
                <div class="search-container">
                    <input type="text" 
                           id="searchInput" 
                           class="search-input" 
                           placeholder="${loc('searchPlaceholder', 'Search in annotations...')}"
                           autocomplete="off">
                    <button id="searchButton" class="search-button">
                        🔍 ${loc('search', 'Search')}
                    </button>
                    <button id="clearSearchButton" class="search-button">
                        ✖️ ${loc('clear', 'Clear')}
                    </button>
                </div>

                <div class="filters">
                    <div class="filter-group">
                        <label for="sortOptions">${loc('sortBy', 'Sort by')}:</label>
                        <select id="sortOptions">
                            <option value="line_asc">${loc('lineAsc', 'Line: Ascending')}</option>
                            <option value="line_desc">${loc('lineDesc', 'Line: Descending')}</option>
                            <option value="date_desc">${loc('dateNewestFirst', 'Date: Newest first')}</option>
                            <option value="date_asc">${loc('dateOldestFirst', 'Date: Oldest first')}</option>
                            <option value="comments_desc">${loc('commentsMostFirst', 'Comments: Most first')}</option>
                            <option value="comments_asc">${loc('commentsLeastFirst', 'Comments: Least first')}</option>
                        </select>
                    </div>
                    
                    <div class="filter-group">
                        <label for="filterOptions">${loc('filterBy', 'Filter by')}:</label>
                        <select id="filterOptions">
                            <option value="all">${loc('allAnnotations', 'All annotations')}</option>
                            ${allFiles.map((file) => `<option value="${file}">${file}</option>`).join('')}
                        </select>
                    </div>
                </div>

                <!-- Search results -->
                <div id="searchResults" class="search-results-info" style="display: none;">
                </div>
            </div>
        `;

        // Annotation content
        let annotationsContent = '';
        if (annotations.length === 0) {
            annotationsContent = `<p class="no-annotations">${loc('noAnnotations', 'No annotations available.')}</p>`;
        } else {
            for (const [file, fileAnnotations] of Object.entries(groupedAnnotations)) {
                annotationsContent += `
                    <div class="file-group" data-file="${file}">
                        <div class="file-header">
                            <span class="file-icon">📄</span>
                            <span>${file}</span>
                            <span class="file-stats">${fileAnnotations.length} ${fileAnnotations.length > 1 ? loc('annotations', 'annotations') : loc('annotation', 'annotation')}</span>
                        </div>
                        ${fileAnnotations
                            .map(
                                (annotation) => `
                            <div class="annotation-card"
                                 id="${escapeHtml(annotation.id)}"
                                 data-annotation-id="${escapeHtml(annotation.id)}"
                                 data-severity="${escapeHtml(annotation.severity || 'info')}"
                                 data-file="${escapeHtml(annotation.file)}"
                                 data-author="${escapeHtml(annotation.author || '')}"
                                 data-message="${escapeHtml(annotation.message.toLowerCase())}"
                                 data-action="navigate">

                                <div class="annotation-header">
                                    <span class="annotation-author">${escapeHtml(annotation.author || loc('anonymous', 'Anonymous'))}${annotation.pinned ? ' \u{1F4CC}' : ''}</span>
                                    <span class="severity-icon">${this.getSeverityIcon(annotation.severity || 'info')}</span>
                                    <span class="badge">${annotation.thread ? annotation.thread.length : 0} ${loc('comments', 'Comments')}</span>
                                    <span class="annotation-timestamp">${new Date(annotation.timestamp).toLocaleString()}</span>
                                </div>

                                <div class="annotation-message">${escapeHtml(annotation.message)}</div>
                                <div class="annotation-file-info">${loc('line', 'Line')}: ${annotation.line + 1} &bull; ${loc('severity', 'Severity')}: ${escapeHtml(annotation.severity || 'info')}</div>

                                ${annotation.tags && annotation.tags.length ? `<div class="annotation-tags">${annotation.tags.map((t) => escapeHtml(t)).join(', ')}</div>` : ''}

                                ${
                                    annotation.thread?.length
                                        ? `
                                    <div class="comment-thread">
                                        ${annotation.thread
                                            .map(
                                                (comment) => `
                                            <div class="comment"
                                                 data-comment-id="${escapeHtml(comment.id)}"
                                                 data-annotation-id="${escapeHtml(annotation.id)}">
                                                <div class="comment-header">
                                                    <strong>${escapeHtml(comment.author || loc('anonymous', 'Anonymous'))}</strong>
                                                    <span class="annotation-timestamp">${new Date(comment.timestamp).toLocaleString()}</span>
                                                </div>
                                                <div class="comment-message"
                                                     contenteditable="true"
                                                     data-action="updateComment"
                                                     data-comment-id="${escapeHtml(comment.id)}">
                                                    ${escapeHtml(comment.message)}
                                                </div>
                                                <button class="action-button"
                                                        data-action="deleteComment"
                                                        data-annotation-id="${escapeHtml(annotation.id)}"
                                                        data-comment-id="${escapeHtml(comment.id)}">
                                                    \u{1F5D1} ${loc('delete', 'Delete')}
                                                </button>
                                            </div>
                                        `
                                            )
                                            .join('')}
                                    </div>
                                `
                                        : ''
                                }

                                <div class="action-buttons">
                                    <button class="action-button" data-action="reply"          data-annotation-id="${escapeHtml(annotation.id)}">\u{1F4AC} ${loc('reply', 'Reply')}</button>
                                    <button class="action-button" data-action="modify"         data-annotation-id="${escapeHtml(annotation.id)}">\u{270F}\u{FE0F} ${loc('modify', 'Modify')}</button>
                                    <button class="action-button" data-action="editTags"       data-annotation-id="${escapeHtml(annotation.id)}">\u{1F3F7}\u{FE0F} ${loc('editTags', 'Tags')}</button>
                                    <button class="action-button" data-action="changeSeverity" data-annotation-id="${escapeHtml(annotation.id)}">${this.getSeverityIcon(annotation.severity || 'info')} ${loc('changeSeverity', 'Severity')}</button>
                                    <button class="action-button" data-action="delete"         data-annotation-id="${escapeHtml(annotation.id)}">\u{1F5D1} ${loc('delete', 'Delete')}</button>
                                    <button class="action-button" data-action="moveUp"         data-annotation-id="${escapeHtml(annotation.id)}">\u{2191} ${loc('moveUp', 'Up')}</button>
                                    <button class="action-button" data-action="moveDown"       data-annotation-id="${escapeHtml(annotation.id)}">\u{2193} ${loc('moveDown', 'Down')}</button>
                                </div>
                            </div>
                        `
                            )
                            .join('')}
                    </div>
                `;
            }
        }

        // Enhanced JavaScript with search support
        const script = `
            const vscode = acquireVsCodeApi();
            const state = vscode.getState() || {};
            
            // Localized strings
            const localizedStrings = {
                foundResults: "${loc('foundResults', "Found {0} result{1} for '{2}'").replace(/'/g, "\\'")}",
                resultPosition: "${loc('resultPosition', 'Result {0}/{1}').replace(/'/g, "\\'")}",
                noResultsFound: "${loc('noResultsFound', "No results found for '{0}'").replace(/'/g, "\\'")}"
            };
            
            // Retrieve DOM elements
            const searchInput = document.getElementById('searchInput');
            const searchButton = document.getElementById('searchButton');
            const clearSearchButton = document.getElementById('clearSearchButton');
            const searchResults = document.getElementById('searchResults');
            const sortSelect = document.getElementById('sortOptions');
            const filterSelect = document.getElementById('filterOptions');

            // Restore state
            if (sortSelect) sortSelect.value = state.sortOption || 'line_asc';
            if (filterSelect) filterSelect.value = state.filterOption || 'all';
            if (searchInput) searchInput.value = state.searchTerm || '';

            // Variables de recherche
            let currentSearchTerm = state.searchTerm || '';
            let searchResults_annotations = [];
            let currentSearchIndex = 0;

            // Search function in the panel
            function searchInPanel(searchTerm) {
                clearHighlights();
                
                if (!searchTerm.trim()) {
                    hideSearchResults();
                    return;
                }

                const annotations = document.querySelectorAll('.annotation-card');
                const foundAnnotations = [];

                annotations.forEach(annotation => {
                    const message = annotation.dataset.message || '';
                    const author = annotation.dataset.author || '';
                    const fileData = annotation.dataset.file || '';
                    
                    if (message.includes(searchTerm.toLowerCase()) || 
                        author.toLowerCase().includes(searchTerm.toLowerCase()) ||
                        fileData.toLowerCase().includes(searchTerm.toLowerCase())) {
                        foundAnnotations.push(annotation);
                    }
                });

                searchResults_annotations = foundAnnotations;
                currentSearchIndex = 0;

                if (foundAnnotations.length > 0) {
                    showSearchResults(foundAnnotations.length, searchTerm);
                    highlightSearchResult(0);
                } else {
                    showSearchResults(0, searchTerm);
                }

                // Save state
                state.searchTerm = searchTerm;
                vscode.setState(state);
            }

            function showSearchResults(count, term) {
                if (searchResults) {
                    searchResults.style.display = 'block';
                    if (count > 0) {
                        // Format the localized string with parameters
                        let message = localizedStrings.foundResults
                            .replace('{0}', count)
                            .replace('{1}', count > 1 ? 's' : '')
                            .replace('{2}', term);
                        if (count > 1) {
                            message += ' - ' + localizedStrings.resultPosition
                                .replace('{0}', currentSearchIndex + 1)
                                .replace('{1}', count);
                        }
                        searchResults.textContent = message;
                    } else {
                        searchResults.textContent = localizedStrings.noResultsFound.replace('{0}', term);
                    }
                }
            }

            function hideSearchResults() {
                if (searchResults) {
                    searchResults.style.display = 'none';
                }
            }

            function clearHighlights() {
                document.querySelectorAll('.annotation-card.highlight').forEach(el => {
                    el.classList.remove('highlight');
                });
            }

            function highlightSearchResult(index) {
                clearHighlights();
                
                if (index >= 0 && index < searchResults_annotations.length) {
                    const annotation = searchResults_annotations[index];
                    annotation.classList.add('highlight');
                    annotation.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center',
                        inline: 'nearest'
                    });
                    currentSearchIndex = index;
                    
                    if (searchResults_annotations.length > 1) {
                        showSearchResults(searchResults_annotations.length, currentSearchTerm);
                    }
                }
            }

            function nextSearchResult() {
                if (searchResults_annotations.length > 1) {
                    const nextIndex = (currentSearchIndex + 1) % searchResults_annotations.length;
                    highlightSearchResult(nextIndex);
                }
            }

            function previousSearchResult() {
                if (searchResults_annotations.length > 1) {
                    const prevIndex = currentSearchIndex > 0 ? currentSearchIndex - 1 : searchResults_annotations.length - 1;
                    highlightSearchResult(prevIndex);
                }
            }

            // Search event listeners
            if (searchButton) {
                searchButton.addEventListener('click', () => {
                    const term = searchInput?.value || '';
                    currentSearchTerm = term;
                    searchInPanel(term);
                });
            }

            if (clearSearchButton) {
                clearSearchButton.addEventListener('click', () => {
                    if (searchInput) searchInput.value = '';
                    currentSearchTerm = '';
                    clearHighlights();
                    hideSearchResults();
                    state.searchTerm = '';
                    vscode.setState(state);
                });
            }

            if (searchInput) {
                // Real-time search
                let searchTimeout;
                searchInput.addEventListener('input', () => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => {
                        const term = searchInput.value;
                        currentSearchTerm = term;
                        searchInPanel(term);
                    }, 300);
                });

                // Keyboard navigation
                searchInput.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        if (event.shiftKey) {
                            previousSearchResult();
                        } else {
                            nextSearchResult();
                        }
                    } else if (event.key === 'Escape') {
                        clearSearchButton?.click();
                        searchInput.blur();
                    }
                });
            }

            // Existing events for sorting and filtering
            if (sortSelect) {
                sortSelect.addEventListener('change', (event) => {
                    const sortOption = event.target.value;
                    state.sortOption = sortOption;
                    vscode.setState(state);
                    vscode.postMessage({ command: 'sort', value: sortOption });
                });
            }

            if (filterSelect) {
                filterSelect.addEventListener('change', (event) => {
                    const filterOption = event.target.value;
                    state.filterOption = filterOption;
                    vscode.setState(state);
                    vscode.postMessage({ command: 'filter', value: filterOption });
                });
            }

            // Messages du backend
            window.addEventListener('message', event => {
                const message = event.data;
                
                if (message.command === 'focusAnnotation') {
                    const annotationElement = document.getElementById(message.annotationId);
                    if (annotationElement) {
                        clearHighlights();
                        
                        annotationElement.scrollIntoView({ 
                            behavior: 'smooth', 
                            block: 'center',
                            inline: 'nearest'
                        });
                        
                        annotationElement.classList.add('highlight');
                        
                        // Highlight duration based on context
                        const duration = message.clearFilter === false ? 5000 : 2000;
                        setTimeout(() => {
                            annotationElement.classList.remove('highlight');
                        }, duration);
                    }
                }
                
                if (message.command === 'clearFocus') {
                    clearHighlights();
                    hideSearchResults();
                    if (searchInput) searchInput.value = '';
                    currentSearchTerm = '';
                    state.searchTerm = '';
                    vscode.setState(state);
                }
            });

            // Run initial search if a term is present
            if (currentSearchTerm) {
                setTimeout(() => {
                    searchInPanel(currentSearchTerm);
                }, 100);
            }

            // Event delegation replaces all inline onclick/onblur handlers.
            document.addEventListener('click', function(e) {
                const btn = e.target.closest('[data-action]');
                if (!btn) { return; }
                const action = btn.dataset.action;
                const annotationId = btn.dataset.annotationId;
                const commentId = btn.dataset.commentId;
                if (action === 'navigate') {
                    if (annotationId) { window.navigate(annotationId); }
                } else if (action === 'reply') {
                    e.stopPropagation(); window.reply(annotationId, e);
                } else if (action === 'modify') {
                    e.stopPropagation(); window.modify(annotationId, e);
                } else if (action === 'editTags') {
                    e.stopPropagation(); window.editTags(annotationId, e);
                } else if (action === 'changeSeverity') {
                    e.stopPropagation(); window.changeSeverity(annotationId, e);
                } else if (action === 'delete') {
                    e.stopPropagation(); window.deleteAnnotation(annotationId, e);
                } else if (action === 'moveUp') {
                    e.stopPropagation(); window.moveUp(annotationId, e);
                } else if (action === 'moveDown') {
                    e.stopPropagation(); window.moveDown(annotationId, e);
                } else if (action === 'deleteComment') {
                    e.stopPropagation(); window.deleteComment(annotationId, commentId, e);
                }
            });
            document.addEventListener('blur', function(e) {
                const el = e.target.closest('[data-action="updateComment"]');
                if (el) { window.updateComment(el.dataset.commentId, e); }
            }, true);

            // Named functions called by the event delegation above.
            window.navigate = function(annotationId) {
                vscode.postMessage({ command: 'navigate', annotationId });
            }
            
            window.reply = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'reply', annotationId });
            }
            
            window.modify = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'modify', annotationId });
            }
            
            window.deleteAnnotation = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'delete', annotationId });
            }
            
            window.updateComment = function(commentId, event) {
                const newMessage = event.target.innerText;
                vscode.postMessage({ command: 'updateComment', commentId, newMessage });
            }
            
            window.deleteComment = function(annotationId, commentId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'deleteComment', annotationId, commentId });
            }
            
            window.moveUp = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'moveUp', annotationId });
            }
            
            window.moveDown = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'moveDown', annotationId });
            }
            
            window.editTags = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'editTags', annotationId });
            }
            
            window.changeSeverity = function(annotationId, event) {
                event.stopPropagation();
                vscode.postMessage({ command: 'changeSeverity', annotationId });
            }
        `;

        const nonce = generateNonce();
        const cspSource = this.annotationsPanel?.webview.cspSource ?? '';
        return `
            <!DOCTYPE html>
            <html lang="${vscode.env.language}">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>${styles}</style>
                <link href="${codiconUri}" rel="stylesheet" />
            </head>
            <body>
                <div class="container">
                    ${searchAndFilters}
                    <div class="annotations-content">
                        ${annotationsContent}
                    </div>
                </div>
                <script nonce="${nonce}">${script}</script>
            </body>
            </html>
        `;
    }

    private getWebviewUri(fileName: string): string {
        const resourcePath = vscode.Uri.joinPath(this.context.extensionUri, 'media', fileName);
        return this.annotationsPanel?.webview.asWebviewUri(resourcePath).toString() || '';
    }

    private getLinksWebviewContent(annotation: Annotation, incomingLinks: Annotation[]): string {
        const outgoingLinks = annotation.linkedAnnotations || [];
        const linksNonce = generateNonce();
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${linksNonce}'; img-src data:;">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Annotation Links</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.6;
                }
                
                h2 {
                    color: var(--vscode-textLink-foreground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                    margin-bottom: 20px;
                }
                
                .annotation-box {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 15px;
                    margin-bottom: 20px;
                }
                
                .link-section {
                    margin: 20px 0;
                }
                
                .link-item {
                    background-color: var(--vscode-list-hoverBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 10px;
                    margin: 10px 0;
                    cursor: pointer;
                    transition: background-color 0.2s;
                }
                
                .link-item:hover {
                    background-color: var(--vscode-list-activeSelectionBackground);
                }
                
                .relationship {
                    display: inline-block;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    padding: 2px 8px;
                    border-radius: 3px;
                    font-size: 12px;
                    margin-right: 10px;
                    text-transform: uppercase;
                }
                
                .file-path {
                    color: var(--vscode-textLink-foreground);
                    font-family: var(--vscode-editor-font-family);
                    font-size: 13px;
                }
                
                .message {
                    margin-top: 5px;
                    font-style: italic;
                    opacity: 0.8;
                }
                
                .meta {
                    font-size: 12px;
                    opacity: 0.7;
                    margin-top: 5px;
                }
                
                .empty {
                    opacity: 0.6;
                    font-style: italic;
                }
                
                .stats {
                    background-color: var(--vscode-sideBar-background);
                    padding: 15px;
                    border-radius: 4px;
                    margin-bottom: 20px;
                    display: flex;
                    justify-content: space-around;
                    text-align: center;
                }
                
                .stat-item {
                    flex: 1;
                }
                
                .stat-value {
                    font-size: 24px;
                    font-weight: bold;
                    color: var(--vscode-textLink-foreground);
                }
                
                .stat-label {
                    font-size: 12px;
                    opacity: 0.7;
                }
            </style>
        </head>
        <body>
            <h1>🔗 Annotation Links</h1>
            
            <div class="annotation-box">
                <strong>Current Annotation:</strong><br>
                <span class="file-path" style="cursor: pointer; color: var(--vscode-textLink-foreground);"
                      data-navigate-file="${escapeHtml(annotation.file)}"
                      data-navigate-line="${annotation.line - 1}">
                    \u{1F4C4} ${escapeHtml(annotation.file)}:${annotation.line}
                </span><br>
                \u{1F4AC} ${escapeHtml(annotation.message)}<br>
                <span class="meta">\u{1F464} ${escapeHtml(annotation.author || 'Unknown')} | \u{1F4C5} ${new Date(annotation.timestamp).toLocaleString()}</span>
            </div>
            
            <div class="stats">
                <div class="stat-item">
                    <div class="stat-value">${outgoingLinks.length}</div>
                    <div class="stat-label">Outgoing Links</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${incomingLinks.length}</div>
                    <div class="stat-label">Incoming Links</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${outgoingLinks.length + incomingLinks.length}</div>
                    <div class="stat-label">Total Connections</div>
                </div>
            </div>
            
            <div class="link-section">
                <h2>➡️ Outgoing Links (${outgoingLinks.length})</h2>
                ${
                    outgoingLinks.length > 0
                        ? outgoingLinks
                              .map((link) => {
                                  const targetAnnotations = Array.from(this.annotations.values());
                                  const target = targetAnnotations.find(
                                      (a) => a.file === link.targetFile && a.line === link.targetLine
                                  );
                                  return `
                        <div class="link-item"
                             data-navigate-file="${escapeHtml(link.targetFile)}"
                             data-navigate-line="${link.targetLine - 1}">
                            <span class="relationship">${escapeHtml(link.relationship || 'related')}</span>
                            <span class="file-path">${escapeHtml(link.targetFile)}:${link.targetLine}</span>
                            ${target ? `<div class="message">${escapeHtml(target.message)}</div>` : ''}
                            ${target ? `<div class="meta">\u{1F464} ${escapeHtml(target.author || 'Unknown')} | \u{1F4C5} ${new Date(target.timestamp).toLocaleDateString()}</div>` : ''}
                        </div>
                    `;
                              })
                              .join('')
                        : '<p class="empty">No outgoing links</p>'
                }
            </div>

            <div class="link-section">
                <h2>\u{2B05}\u{FE0F} Incoming Links (${incomingLinks.length})</h2>
                ${
                    incomingLinks.length > 0
                        ? incomingLinks
                              .map((source) => {
                                  const link = source.linkedAnnotations?.find(
                                      (l) => l.targetFile === annotation.file && l.targetLine === annotation.line
                                  );
                                  return `
                        <div class="link-item"
                             data-navigate-file="${escapeHtml(source.file)}"
                             data-navigate-line="${source.line - 1}">
                            <span class="relationship">${escapeHtml(link?.relationship || 'related')}</span>
                            <span class="file-path">${escapeHtml(source.file)}:${source.line}</span>
                            <div class="message">${escapeHtml(source.message)}</div>
                            <div class="meta">\u{1F464} ${escapeHtml(source.author || 'Unknown')} | \u{1F4C5} ${new Date(source.timestamp).toLocaleDateString()}</div>
                        </div>
                    `;
                              })
                              .join('')
                        : '<p class="empty">No incoming links</p>'
                }
            </div>

            <script nonce="${linksNonce}">
                const vscode = acquireVsCodeApi();

                document.addEventListener('click', function(e) {
                    const el = e.target.closest('[data-navigate-file]');
                    if (el) {
                        vscode.postMessage({
                            command: 'navigate',
                            file: el.dataset.navigateFile,
                            line: parseInt(el.dataset.navigateLine, 10)
                        });
                    }
                });
            </script>
        </body>
        </html>`;
    }

    public dispose(): void {
        this.log('Disposing AnnotationManager...');

        // Clear timeouts
        if (this.contentChangeTimeout) {
            clearTimeout(this.contentChangeTimeout);
        }
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }

        // Dispose all decorations
        this.clearAllAnnotationsFromEditors();

        // Dispose all managers
        this.linkedAnnotationManager?.dispose();
        // TemplateManager doesn't have disposable resources
        // this.templateManager.dispose();
        this.reviewModeManager?.dispose();
        this.legacyEmptyStoreForRetiredManagers?.dispose();
        // SnippetManager is a singleton and doesn't have disposable resources
        // this.snippetManager.dispose();

        // Output channel is in disposables array
        this.log('Extension disposed');

        this.disposables.forEach((d) => d.dispose());
        this.statusBarItem.dispose();
    }

    private async handleFileRename(event: vscode.FileRenameEvent): Promise<void> {
        if (this.lifecycleDelegatedToStore) {
            return;
        }
        for (const file of event.files) {
            const oldRelativePath = this.getRelativePath(file.oldUri.fsPath);
            const newRelativePath = this.getRelativePath(file.newUri.fsPath);
            const oldUriString = file.oldUri.toString();
            const newUriString = file.newUri.toString();

            // Migrate the snapshot to the new URI key
            const oldSnapshot = this.documentSnapshots.get(oldUriString);
            if (oldSnapshot) {
                this.documentSnapshots.delete(oldUriString);
                this.documentSnapshots.set(newUriString, oldSnapshot);
            }

            this.annotations.forEach((annotation) => {
                // URI-strict match preferred; fall back to relative path for legacy entries.
                const matches = annotation.fileUri
                    ? annotation.fileUri === oldUriString
                    : this.normalizePath(annotation.file) === this.normalizePath(oldRelativePath);
                if (matches) {
                    annotation.file = newRelativePath;
                    annotation.fileUri = newUriString;
                }
            });
        }
        await this.saveAnnotations();
        await this.refreshAnnotations();
        this.updateAnnotationsPanel();
    }

    private async handleFileDelete(event: vscode.FileDeleteEvent): Promise<void> {
        if (this.lifecycleDelegatedToStore) {
            return;
        }
        for (const file of event.files) {
            const annotationsToDelete: string[] = [];
            this.annotations.forEach((annotation, id) => {
                if (this.annotationMatchesFsPath(annotation, file.fsPath)) {
                    annotationsToDelete.push(id);
                }
            });
            for (const id of annotationsToDelete) {
                this.annotations.delete(id);
                this.disposeDecoration(id);
            }
        }
        await this.saveAnnotations();
        this.updateStatusBar();
        this.updateAnnotationsPanel();
    }

    private getRelativePath(filePath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return filePath;
        }
        const normalizedFilePath = this.normalizePath(filePath);
        const workspaceFolder = workspaceFolders.find((folder) =>
            normalizedFilePath.startsWith(this.normalizePath(folder.uri.fsPath))
        );
        if (workspaceFolder) {
            return normalizedFilePath.slice(this.normalizePath(workspaceFolder.uri.fsPath).length + 1);
        }
        return normalizedFilePath;
    }

    /**
     * URI-strict membership test. When annotation.fileUri is set, ONLY the
     * exact URI string matches -- this prevents the legacy "sample.ts in
     * folder A leaks into sample.ts in folder B" failure mode.
     * Falls back to relative-path matching for legacy annotations created
     * before fileUri existed.
     */
    private annotationMatchesDocument(annotation: Annotation, document: vscode.TextDocument): boolean {
        if (annotation.fileUri) {
            return annotation.fileUri === document.uri.toString();
        }
        const relativeFilePath = this.getRelativePath(document.fileName);
        return this.normalizePath(annotation.file) === this.normalizePath(relativeFilePath);
    }

    /** Same as annotationMatchesDocument but accepts a raw fs path. */
    private annotationMatchesFsPath(annotation: Annotation, fsPath: string): boolean {
        if (annotation.fileUri) {
            try {
                return annotation.fileUri === vscode.Uri.file(fsPath).toString();
            } catch {
                /* fall through to legacy match */
            }
        }
        const relativeFilePath = this.getRelativePath(fsPath);
        return this.normalizePath(annotation.file) === this.normalizePath(relativeFilePath);
    }

    /**
     * Preserve the exact cursor line as the anchor target. Symbol metadata is
     * recorded only when the cursor is already on a symbol's start line; it is
     * enrichment, not permission to snap the user's annotation elsewhere.
     */
    private async resolveSymbolForLine(
        doc: vscode.TextDocument,
        cursorLine: number
    ): Promise<{ targetLine: number; symbolName: string | null; symbolKind: string | null }> {
        let symbols: vscode.DocumentSymbol[] = [];
        try {
            const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                doc.uri
            );
            symbols = Array.isArray(result) ? result : [];
        } catch {
            symbols = [];
        }
        const flat = this.flattenSymbols(symbols);

        // STAY AT THE CLICK LINE. Always. No walking, no symbol-header snapping.
        // The annotation lands exactly where the user clicked. The only enrichment
        // is recording symbol metadata when the cursor is *already* on a symbol's
        // start line (e.g. clicking directly on `function foo()`), so the
        // annotation tracks `foo` when it moves later.
        let symbolAtCursor: vscode.DocumentSymbol | null = null;
        for (const sym of flat) {
            if (sym.range.start.line === cursorLine) {
                symbolAtCursor = sym;
                break;
            }
        }

        return {
            targetLine: cursorLine,
            symbolName: symbolAtCursor?.name ?? null,
            symbolKind: symbolAtCursor ? vscode.SymbolKind[symbolAtCursor.kind] : null,
        };
    }

    private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
        const flat: vscode.DocumentSymbol[] = [];
        const visit = (list: vscode.DocumentSymbol[]): void => {
            for (const s of list) {
                flat.push(s);
                if (s.children?.length) {
                    visit(s.children);
                }
            }
        };
        visit(symbols);
        return flat;
    }

    /**
     * Single source of truth for setting anchor fields on a freshly-created
     * annotation. Callers MUST go through this helper at every creation path
     * so fileUri, languageId, structured anchor, and the legacy lineHash/
     * contextBefore/contextAfter triple stay in sync.
     *
     * Resolution order:
     *   - Symbol via DocumentSymbolProvider (kind: 'symbol').
     *   - Otherwise the captured target line (kind: 'line').
     */
    public async populateAnchor(annotation: Annotation, doc: vscode.TextDocument, cursorLine: number): Promise<void> {
        // Store two anchors:
        //   - exactAnchor is the line where the user asked to render the note.
        //   - trackingAnchor may walk from a blank line to nearby code, so a note
        //     placed on the blank line above a function can still follow that
        //     function when the line is dragged or pasted elsewhere.
        const exactAnchor = captureAnchor(doc, cursorLine, { walkForward: 0, walkBackward: 0 });
        const trackingAnchor = captureAnchor(doc, cursorLine);
        const targetLine = cursorLine;
        const trackingLine = trackingAnchor.targetLine ?? cursorLine;

        annotation.fileUri = doc.uri.toString();
        annotation.languageId = doc.languageId;
        annotation.line = targetLine;
        annotation.lineHash = exactAnchor.lineHash;
        annotation.contextBefore = exactAnchor.contextBefore;
        annotation.contextAfter = exactAnchor.contextAfter;

        const anchor: AnnotationAnchor = {
            kind: 'line',
            originalLine: cursorLine,
            targetLine: trackingLine,
            symbolName: null,
            symbolKind: null,
            symbolSignature: null,
            anchorTextHash: trackingAnchor.lineHash,
            contextBefore: trackingAnchor.contextBefore,
            contextAfter: trackingAnchor.contextAfter,
        };
        annotation.anchor = anchor;

        // Provisional resolved state -- the regular refresh path will recompute.
        annotation.resolvedAnchor = {
            status: 'attached',
            line: targetLine,
            confidence: 1,
            reason: 'Line anchor',
        };
    }

    private resolveTrackingAnchor(
        annotation: Annotation,
        doc: vscode.TextDocument
    ): { renderLine: number; targetLine: number } | null {
        const structuredAnchor = annotation.anchor;
        if (!structuredAnchor?.anchorTextHash || structuredAnchor.anchorTextHash === EMPTY_LINE_HASH) {
            return null;
        }

        const foundTargetLine = findAnchor(
            doc,
            {
                lineHash: structuredAnchor.anchorTextHash,
                contextBefore: structuredAnchor.contextBefore ?? [],
                contextAfter: structuredAnchor.contextAfter ?? [],
            },
            structuredAnchor.targetLine,
            { allowUniqueHashFallback: true }
        );
        if (foundTargetLine === null) {
            return null;
        }

        const renderLine = foundTargetLine + (annotation.line - structuredAnchor.targetLine);
        if (renderLine < 0 || renderLine >= doc.lineCount) {
            return null;
        }
        return {
            renderLine,
            targetLine: foundTargetLine,
        };
    }

    private resolveTrackingAnchorLine(annotation: Annotation, doc: vscode.TextDocument): number | null {
        return this.resolveTrackingAnchor(annotation, doc)?.renderLine ?? null;
    }

    /**
     * Re-resolve an annotation against a document. Pure: never mutates the
     * stored annotation. Returns the runtime status to attach via
     * annotation.resolvedAnchor at refresh time.
     */
    public computeResolvedAnchor(doc: vscode.TextDocument, annotation: Annotation): ResolvedAnnotationAnchor {
        // Cross-document call -- do not even try.
        if (!this.annotationMatchesDocument(annotation, doc)) {
            return {
                status: 'orphaned',
                line: null,
                confidence: 0,
                reason: 'Annotation does not belong to this document',
            };
        }

        const lineCount = doc.lineCount;
        const storedLine = annotation.line;
        const storedHash = annotation.lineHash;
        const structuredAnchor = annotation.anchor;
        const renderLineFromTracking = this.resolveTrackingAnchorLine(annotation, doc);
        if (renderLineFromTracking !== null && structuredAnchor) {
            const targetMoved = renderLineFromTracking !== storedLine;
            return {
                status: targetMoved ? 'moved' : 'attached',
                line: renderLineFromTracking,
                confidence: targetMoved ? 0.85 : 1,
                reason: targetMoved
                    ? `Relocated tracking target from line ${structuredAnchor.targetLine + 1}`
                    : 'Tracking anchor match at stored target line',
            };
        }

        // New-schema annotations may intentionally target blank lines. Keep
        // non-empty lines attached at the stored line when the line still
        // matches. Empty lines need context/tracking because their hash matches
        // every blank line in the file.
        const hasStructuredAnchor = structuredAnchor !== undefined;
        if (
            hasStructuredAnchor &&
            storedHash &&
            storedHash !== EMPTY_LINE_HASH &&
            storedLine >= 0 &&
            storedLine < lineCount &&
            hashLine(doc.lineAt(storedLine).text) === storedHash
        ) {
            return {
                status: 'attached',
                line: storedLine,
                confidence: storedHash === EMPTY_LINE_HASH ? 0.5 : 1,
                reason:
                    storedHash === EMPTY_LINE_HASH
                        ? 'Intentional blank-line anchor at stored line'
                        : 'Hash match at stored line',
            };
        }

        // Degenerate anchor -- legacy/corrupted entries.
        if (!storedHash || storedHash === EMPTY_LINE_HASH) {
            const meaningful =
                (annotation.contextBefore ?? []).filter((l) => l !== '').length +
                (annotation.contextAfter ?? []).filter((l) => l !== '').length;
            if (meaningful < 2) {
                return {
                    status: 'stale',
                    line: storedLine,
                    confidence: 0,
                    reason: 'Empty-line hash with insufficient context',
                };
            }
        }

        // 1. Symbol-aware: if anchor recorded a symbol, prefer it.
        const sym = structuredAnchor;
        if (sym?.kind === 'symbol' && sym.symbolName) {
            // Symbol probe is async via executeDocumentSymbolProvider; that lives
            // in resolveSymbolForLine. To stay synchronous here we rely on the
            // hash+context resolver, which already finds the symbol's body line
            // when the symbol is still present.
        }

        // 2. Hash + context resolver. Enable the unique-hash fallback so that
        //    line swaps (Alt+Up/Down) where the diff misses one half and the
        //    annotation's contextBefore no longer aligns can still be
        //    re-located when the line content itself is unique in the file.
        if (storedHash) {
            const found = findAnchor(
                doc,
                {
                    lineHash: storedHash,
                    contextBefore: annotation.contextBefore ?? [],
                    contextAfter: annotation.contextAfter ?? [],
                },
                storedLine,
                { allowUniqueHashFallback: true }
            );
            if (found !== null) {
                if (found === storedLine) {
                    return { status: 'attached', line: found, confidence: 1, reason: 'Hash match at stored line' };
                }
                return {
                    status: 'moved',
                    line: found,
                    confidence: 0.8,
                    reason: `Relocated from line ${storedLine + 1}`,
                };
            }
        }

        // 3. Stored line still in range but anchor cannot be confirmed.
        if (storedLine >= 0 && storedLine < lineCount) {
            return {
                status: 'orphaned',
                line: null,
                confidence: 0,
                reason: 'Anchor target removed',
            };
        }

        return {
            status: 'orphaned',
            line: null,
            confidence: 0,
            reason: 'Stored line out of document range',
        };
    }

    /**
     * On-load migration. Pure (returns a possibly-mutated copy reference) and
     * NEVER deletes user data. Marks suspicious annotations as 'stale' so
     * they remain in the panel/tree but are filtered from gutter rendering.
     *
     * Suspicions:
     *   - lineHash === EMPTY_LINE_HASH AND no meaningful context.
     *   - .py file with TypeScript syntax in context (cross-file leak).
     *   - Missing fileUri (best-effort assignment from workspace folder).
     */
    private migrateLegacyAnnotation(a: Annotation): Annotation {
        // Best-effort fileUri assignment for legacy entries.
        if (!a.fileUri && a.file) {
            const wsFolders = vscode.workspace.workspaceFolders ?? [];
            if (wsFolders.length >= 1) {
                try {
                    const fsPath = path.join(wsFolders[0].uri.fsPath, a.file);
                    a.fileUri = vscode.Uri.file(fsPath).toString();
                } catch {
                    /* leave undefined */
                }
            }
        }

        const meaningful =
            (a.contextBefore ?? []).filter((l) => l !== '').length +
            (a.contextAfter ?? []).filter((l) => l !== '').length;

        // Empty-hash + no context -> cannot be re-resolved.
        if ((!a.lineHash || a.lineHash === EMPTY_LINE_HASH) && meaningful < 2) {
            a.resolvedAnchor = {
                status: 'stale',
                line: a.line,
                confidence: 0,
                reason: 'Legacy anchor on empty line; cannot re-resolve',
            };
            return a;
        }

        // Cross-language: TypeScript/JavaScript syntax recorded under a Python file
        // (the symptom from the bug report -- TS context inside test.py).
        const filePath = (a.fileUri || a.file || '').toLowerCase();
        const ctx = [...(a.contextBefore ?? []), ...(a.contextAfter ?? [])].join('\n');
        const looksLikeTs = /\b(function|interface |const |let |=>|: Promise<|async function|export \{)\b/.test(ctx);
        if ((filePath.endsWith('.py') || filePath.endsWith('.rb')) && looksLikeTs) {
            a.resolvedAnchor = {
                status: 'stale',
                line: a.line,
                confidence: 0,
                reason: 'Cross-language context (TS/JS syntax in non-JS file)',
            };
        }

        return a;
    }

    /**
     * Drop exact-duplicate legacy entries.
     *
     *   Pass 1 -- same (fileKey, timestamp, message): catches same-event
     *             duplicates from the original duplication bug.
     *   Pass 2 -- same (fileKey, line, lineHash, contextBefore, contextAfter,
     *             message): catches true content-equal duplicates created
     *             across separate events (different timestamps), the symptom
     *             of the cut+paste-after-expiry bug. Conservative: every
     *             content field must match.
     */
    private deduplicateLegacyAnnotations(list: Annotation[]): Annotation[] {
        const tsKeyed = new Map<string, Annotation>();
        const afterPass1: Annotation[] = [];
        for (const a of list) {
            const fileKey = a.fileUri || a.file || '';
            const key = `${fileKey}|${a.timestamp}|${a.message}`;
            const existing = tsKeyed.get(key);
            if (existing) {
                this.log(`migration: dedupe(ts) ${a.id} (collides with ${existing.id})`);
                continue;
            }
            tsKeyed.set(key, a);
            afterPass1.push(a);
        }

        const contentKeyed = new Map<string, Annotation>();
        const afterPass2: Annotation[] = [];
        for (const a of afterPass1) {
            const fileKey = a.fileUri || a.file || '';
            const ctxBefore = JSON.stringify(a.contextBefore ?? []);
            const ctxAfter = JSON.stringify(a.contextAfter ?? []);
            const key = `${fileKey}|${a.line}|${a.lineHash ?? ''}|${ctxBefore}|${ctxAfter}|${a.message}`;
            const existing = contentKeyed.get(key);
            if (existing) {
                // Keep the earlier entry; the later one is the spurious duplicate.
                const keep = existing.timestamp <= a.timestamp ? existing : a;
                const drop = keep === existing ? a : existing;
                this.log(`migration: dedupe(content) drop ${drop.id} (kept ${keep.id})`);
                if (keep !== existing) {
                    contentKeyed.set(key, keep);
                    // Replace in result.
                    const idx = afterPass2.findIndex((x) => x.id === existing.id);
                    if (idx >= 0) {
                        afterPass2[idx] = keep;
                    }
                }
                continue;
            }
            contentKeyed.set(key, a);
            afterPass2.push(a);
        }

        return afterPass2;
    }

    private getAbsolutePath(relativePath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return path.join(workspaceFolders[0].uri.fsPath, relativePath).split(path.sep).join(path.posix.sep);
        }
        return relativePath;
    }

    public getAnnotationsForFile(fileName: string): Annotation[] {
        return Array.from(this.annotations.values()).filter((a) => this.annotationMatchesFsPath(a, fileName));
    }

    private async handleDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (this.lifecycleDelegatedToStore) {
            return;
        }
        if (event.contentChanges.length === 0) {
            return;
        }

        const document = event.document;
        const fileKey = document.uri.toString();
        const relativeFilePath = this.getRelativePath(document.fileName);
        const now = Date.now();
        const preChangeLinesByAnnotationId = new Map<string, number>();
        const preChangeTrackingLinesByAnnotationId = new Map<string, number>();
        this.annotations.forEach((annotation) => {
            if (this.annotationMatchesDocument(annotation, document)) {
                preChangeLinesByAnnotationId.set(annotation.id, annotation.line);
                preChangeTrackingLinesByAnnotationId.set(annotation.id, this.getAnnotationTrackingLine(annotation));
            }
        });
        const clipboardTextForCutRecovery = this.recentDeletions.size > 0 ? await this.readClipboardTextSafely() : '';

        // IDs handled by the cut/paste recovery phase below. Mutual exclusion: any
        // annotation restored from recentDeletions in this event MUST be skipped by
        // both the per-annotation arithmetic loop (otherwise the same paste range
        // shifts the just-restored annotation past the inserted block) and the
        // copy-paste duplication step (otherwise a ghost duplicate is created).
        const restoredThisEvent = new Set<string>();

        // Expire deferred cut-paste entries whose clipboard window has elapsed.
        // Move them to the silent-delete undo buffer (no modal, toast only).
        const expiredAnnotations: Annotation[] = [];
        for (const [id, deferred] of this.recentDeletions) {
            if (now - deferred.deletedAt > this.clipboardWindowMs) {
                if (this.deferredClipboardStillMatches(deferred, clipboardTextForCutRecovery)) {
                    deferred.deletedAt = now;
                    continue;
                }
                expiredAnnotations.push(deferred.annotation);
                this.recentDeletions.delete(id);
                this.deletedRecently.set(id, { annotation: deferred.annotation, removedAt: now });
            }
        }

        // Attempt to recover deferred (cut) annotations: check if the current document
        // state now contains the previously-deleted content (paste event in any file).
        if (this.recentDeletions.size > 0) {
            const recovered: string[] = [];
            for (const [id, deferred] of this.recentDeletions) {
                let found: { renderLine: number; trackingLine: number } | null = null;
                let sawMatchingPaste = false;

                // Primary: block-relative position from a paste contentChange.
                // Avoids false negatives caused by sparse context (e.g. leading empty lines).
                for (const change of event.contentChanges) {
                    if (!this.deferredPasteMatchesChange(deferred, change.text, clipboardTextForCutRecovery)) {
                        continue;
                    }
                    sawMatchingPaste = true;
                    const insertedLines = change.text.split('\n');
                    const startLine = change.range.start.line;
                    if (change.text.length === 0) {
                        continue;
                    }
                    const trackingOffset = deferred.trackingOffsetInBlock ?? deferred.offsetInBlock;
                    if (trackingOffset < 0 || trackingOffset >= insertedLines.length) {
                        continue;
                    }
                    const expectedHash = hashLine(insertedLines[trackingOffset]);
                    if (expectedHash === (deferred.trackingLineHash ?? deferred.annotation.lineHash)) {
                        const trackingLine = startLine + trackingOffset;
                        found = {
                            renderLine: this.clampDocumentLine(
                                trackingLine + (deferred.renderOffsetFromTracking ?? 0),
                                document
                            ),
                            trackingLine: this.clampDocumentLine(trackingLine, document),
                        };
                        break;
                    }
                }

                // Fallback: full-document findAnchor (covers same-file atomic paste
                // and clipboard recovery triggered by non-paste events).
                if (found === null && sawMatchingPaste && deferred.annotation.lineHash) {
                    const anchor: AnchorData = {
                        lineHash: deferred.annotation.lineHash,
                        contextBefore: deferred.annotation.contextBefore ?? [],
                        contextAfter: deferred.annotation.contextAfter ?? [],
                    };
                    const foundRenderLine = findAnchor(document, anchor, -1);
                    if (foundRenderLine !== null) {
                        const renderOffsetFromTracking = deferred.renderOffsetFromTracking ?? 0;
                        found = {
                            renderLine: foundRenderLine,
                            trackingLine: this.clampDocumentLine(foundRenderLine - renderOffsetFromTracking, document),
                        };
                    }
                }

                if (found !== null) {
                    // Re-scope to the destination document. Updating `file` alone
                    // leaves a stale fileUri that makes the annotation render in
                    // the SOURCE file at the destination's line number -- the
                    // "annotation reappears at another location" bug after cross-
                    // file cut+paste.
                    deferred.annotation.file = relativeFilePath;
                    deferred.annotation.fileUri = document.uri.toString();
                    deferred.annotation.languageId = document.languageId;
                    deferred.annotation.resolvedAnchor = undefined;
                    if (deferred.annotation.anchor) {
                        // Symbol metadata referred to the source file's symbol --
                        // it may not exist (or may be a different symbol) in the
                        // destination. Demote to a line anchor.
                        deferred.annotation.anchor = {
                            ...deferred.annotation.anchor,
                            kind: 'line',
                            symbolName: null,
                            symbolKind: null,
                            symbolSignature: null,
                        };
                    }
                    this.setAnnotationLineWithTrackingLine(
                        deferred.annotation,
                        found.renderLine,
                        found.trackingLine,
                        document
                    );
                    this.annotations.set(id, deferred.annotation);
                    recovered.push(id);
                    restoredThisEvent.add(id);
                    this.log(
                        `recentDeletions: restored ${id} to ${relativeFilePath}:${found.renderLine} ` +
                            `(trackingLine=${found.trackingLine}, offsetInBlock=${deferred.offsetInBlock})`
                    );
                }
            }
            recovered.forEach((id) => this.recentDeletions.delete(id));
        }

        // Main pipeline: snapshot diff, move detection, arithmetic shift.
        const oldLines = this.documentSnapshots.get(fileKey);
        const newLines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            newLines.push(document.lineAt(i).text);
        }

        // Restore silently-deleted annotations whose content reappears (e.g. Ctrl+Z).
        // Pass restoredThisEvent so the duplication step skips IDs we just put back --
        // otherwise the same paste both restores the annotation AND creates a copy.
        this.tryRestoreFromDeletedRecently(document, relativeFilePath, restoredThisEvent);

        const moves: MovedBlock[] = oldLines ? detectMoves(oldLines, newLines) : [];

        // Undo/Redo are handled by arithmetic + clipboard buffers; the copy-paste
        // duplication step must NOT fire on these reasons, otherwise the cut text
        // still in the OS clipboard re-matches the redone paste and creates ghosts.
        const isUndo = event.reason === vscode.TextDocumentChangeReason.Undo;
        const isRedo = event.reason === vscode.TextDocumentChangeReason.Redo;
        const isUndoRedo = isUndo || isRedo;

        this.annotations.forEach((annotation) => {
            // URI-strict filter: an annotation only mutates if it actually belongs
            // to THIS document. Same-basename files across folders no longer mix.
            if (!this.annotationMatchesDocument(annotation, document)) {
                return;
            }

            // Stale/orphaned annotations are intentionally frozen: arithmetic
            // shift and findAnchor would migrate them to unrelated symbols
            // (the original Bug 4). They stay in the panel for manual triage.
            const status = annotation.resolvedAnchor?.status;
            if (status === 'stale' || status === 'orphaned') {
                return;
            }

            // Mutual exclusion: an annotation just restored from recentDeletions
            // by the cut+paste recovery phase has already been placed at its final
            // line inside the freshly-inserted block. Running the arithmetic shift
            // on the same paste change would push it past the inserted block.
            if (restoredThisEvent.has(annotation.id)) {
                return;
            }

            const oldLine = annotation.line;
            if (isUndo && this.shouldRemoveCopiedAnnotationOnUndo(annotation, event.contentChanges, document)) {
                this.annotations.delete(annotation.id);
                this.disposeDecoration(annotation.id);
                this.log(`undo: removed copied annotation ${annotation.id} from ${relativeFilePath}:${oldLine}`);
                return;
            }

            const trackingLine = this.getAnnotationTrackingLine(annotation);
            const erasureTouchesAnnotation = this.contentChangesEraseAnnotation(event.contentChanges, annotation);
            if (!erasureTouchesAnnotation) {
                const resolvedTrackingAnchor = this.resolveTrackingAnchor(annotation, document);
                if (resolvedTrackingAnchor !== null && resolvedTrackingAnchor.renderLine !== oldLine) {
                    this.setAnnotationLineWithTrackingLine(
                        annotation,
                        resolvedTrackingAnchor.renderLine,
                        resolvedTrackingAnchor.targetLine,
                        document
                    );
                    return;
                }
            }

            const trackingTargetLine = annotation.anchor?.targetLine;
            if (trackingTargetLine !== undefined) {
                const trackingMove = moves.find(
                    (m) => trackingTargetLine >= m.oldStart && trackingTargetLine <= m.oldEnd
                );
                if (trackingMove) {
                    const newTrackingTarget = trackingMove.newStart + (trackingTargetLine - trackingMove.oldStart);
                    const newRenderLine = newTrackingTarget + (oldLine - trackingTargetLine);
                    this.setAnnotationLineWithTrackingLine(annotation, newRenderLine, newTrackingTarget, document);
                    return;
                }
            }

            const move = moves.find((m) => oldLine >= m.oldStart && oldLine <= m.oldEnd);
            if (move) {
                this.setAnnotationLine(annotation, move.newStart + (oldLine - move.oldStart), document);
                return;
            }

            let currentLine = oldLine;
            let markedDeleted = false;
            let pureCutTouchedLine = false;

            for (const change of event.contentChanges) {
                const startLine = change.range.start.line;
                const endLine = change.range.end.line;
                const touchedEndLine = this.getTouchedEndLine(change);
                const lineDelta = change.text.split('\n').length - (endLine - startLine + 1);

                if (currentLine > endLine) {
                    currentLine += lineDelta;
                } else if (currentLine >= startLine && currentLine <= touchedEndLine && lineDelta < 0) {
                    markedDeleted = true;
                    if (change.text === '') {
                        pureCutTouchedLine = true;
                    }
                }
                if (
                    trackingLine !== oldLine &&
                    trackingLine >= startLine &&
                    trackingLine <= touchedEndLine &&
                    lineDelta < 0
                ) {
                    markedDeleted = true;
                    if (change.text === '') {
                        pureCutTouchedLine = true;
                    }
                }
            }

            // Detect content displacement: arithmetic alone misses selection-based
            // cuts whose lineDelta is 0 (the line is emptied without being removed).
            // To avoid pulling annotations into the buffer on routine edits we
            // require BOTH a hash mismatch at the predicted line AND that the
            // triggering change was an erasure (text === '') touching this line.
            const newLineCount = document.lineCount;
            const predictedInRange = currentLine >= 0 && currentLine < newLineCount;
            const predictedHashMatches =
                annotation.lineHash !== undefined &&
                predictedInRange &&
                hashLine(document.lineAt(currentLine).text) === annotation.lineHash;
            let lineDisplaced = false;
            if (!markedDeleted && annotation.lineHash !== undefined && !predictedHashMatches) {
                for (const ch of event.contentChanges) {
                    const erased = ch.text.replace(/\r\n/g, '').length === 0;
                    if (
                        erased &&
                        (this.contentChangeTouchesLine(ch, oldLine) || this.contentChangeTouchesLine(ch, trackingLine))
                    ) {
                        lineDisplaced = true;
                        break;
                    }
                }
            }

            // Defensive guard: if pure-arithmetic shift would push the line out of
            // the new document (negative or >= lineCount), the line was implicitly
            // removed by an upstream cut. Treat it as markedDeleted so we defer
            // instead of writing a stale negative/oversized line.
            const arithmeticOutOfRange =
                !markedDeleted && !lineDisplaced && (currentLine < 0 || currentLine >= newLineCount);
            if (arithmeticOutOfRange) {
                markedDeleted = true;
            }

            if (markedDeleted || lineDisplaced) {
                if (!erasureTouchesAnnotation) {
                    const displacedTrackingAnchor = this.resolveTrackingAnchor(annotation, document);
                    if (displacedTrackingAnchor !== null) {
                        this.setAnnotationLineWithTrackingLine(
                            annotation,
                            displacedTrackingAnchor.renderLine,
                            displacedTrackingAnchor.targetLine,
                            document
                        );
                        return;
                    }
                }

                // Phase A -- reanchor rescue. Tries exact-hash match at the
                // stored line, then full-document hash + context vote with
                // unique-hash fallback enabled. Covers cut+paste atomic events
                // (the regression where the original was deleted and replaced
                // by a fresh-id duplicate at the destination) and large-block
                // moves where detectMoves picked the inverse Myers orientation.
                const reanchored = reanchor(annotation, document);
                if (reanchored.status === 'matched' || reanchored.status === 'moved') {
                    const newLine = reanchored.newLine ?? annotation.line;
                    this.setAnnotationLine(annotation, newLine, document);
                    this.log(
                        `cut/displace: reanchored ${annotation.id} from ${relativeFilePath}:${oldLine} ` +
                            `to :${newLine} (status=${reanchored.status})`
                    );
                    return;
                }

                // Phase B -- legacy findAnchor path. Kept as a defensive
                // fallback even though reanchor above subsumes it for
                // non-degenerate cases. Pure deletion (Ctrl+X / Backspace on
                // the annotated line, text='') is gated to avoid low-context
                // false positives at line 0 or 1 when the cut text recurs
                // near the top of the document.
                const allowFindAnchor =
                    annotation.lineHash !== EMPTY_LINE_HASH && !pureCutTouchedLine && !arithmeticOutOfRange;
                if (allowFindAnchor && annotation.lineHash) {
                    const anchor: AnchorData = {
                        lineHash: annotation.lineHash,
                        contextBefore: annotation.contextBefore ?? [],
                        contextAfter: annotation.contextAfter ?? [],
                    };
                    const found = findAnchor(document, anchor, -1);
                    if (found !== null) {
                        this.setAnnotationLine(annotation, found, document);
                        return;
                    }
                }

                // Phase C -- orphan. KEEP the annotation in the live map: the
                // user-visible contract is "follow code or stay orphaned,
                // never silently delete". resolvedAnchor is marked so the
                // tree can render an orphaned badge; the existing freeze
                // guard around line 3858 protects the entry from further
                // arithmetic mutation in subsequent events. The
                // recentDeletions buffer is no longer populated from this
                // site -- its read path stays operational for legacy
                // recoveries and remains available as a future second-
                // recourse fallback.
                annotation.resolvedAnchor = {
                    status: 'orphaned',
                    line: null,
                    confidence: 0,
                    reason: 'cut/displace: no relocation candidate',
                };
                this.log(
                    `cut/displace: orphaned annotation ${annotation.id} at ${relativeFilePath}:${oldLine} ` +
                        `(markedDeleted=${markedDeleted}, displaced=${lineDisplaced}, ` +
                        `pureCut=${pureCutTouchedLine})`
                );
            } else if (currentLine !== oldLine) {
                // Defensive clamp: never write a negative or oversized line to the
                // live map. The arithmeticOutOfRange branch above should already
                // have caught this, but keep the guard so a future regression can
                // not produce a phantom annotation at line 0/1.
                if (currentLine < 0 || currentLine >= newLineCount) {
                    return;
                }
                this.setAnnotationLine(annotation, currentLine, document);
            }
        });

        // Update snapshot AFTER processing so the next event sees the correct state.
        this.documentSnapshots.set(fileKey, newLines);

        // Automatically duplicate annotations found in pasted blocks (no prompt).
        // Skip on Undo/Redo: those events replay the user's existing edits and the
        // arithmetic + clipboard-buffer paths already restore positions correctly;
        // running detectAndDuplicateOnCopyPaste here would create ghost copies
        // because the clipboard still holds the cut text from the original action.
        if (!isUndoRedo) {
            await this.detectAndDuplicateOnCopyPaste(
                event.contentChanges,
                document,
                relativeFilePath,
                restoredThisEvent,
                oldLines,
                preChangeLinesByAnnotationId,
                preChangeTrackingLinesByAnnotationId
            );
        } else {
            this.log(`undo/redo: skipped detectAndDuplicateOnCopyPaste (reason=${event.reason})`);
        }

        // Non-modal toast for annotations whose clipboard window expired silently.
        if (expiredAnnotations.length > 0) {
            this.showCutExpiredToast(expiredAnnotations, document, relativeFilePath);
        }

        await this.saveAnnotations();
        setTimeout(() => {
            this.refreshAnnotations();
        }, 300);
        this.updateAnnotationsPanel();
        // Tree provider listens on annotationChanged. Without this emit the tree
        // still shows the cut annotation at its old line until the next manual
        // refresh, which the user perceives as a stale phantom entry.
        this.emit('annotationChanged');
    }

    /**
     * After a paste event, automatically duplicate annotations whose content appears
     * in the pasted block.  Guards prevent false positives from keystrokes and autocomplete.
     * No prompt is shown -- duplication is immediate, matching VS Code's "paste = duplicate".
     */
    private async detectAndDuplicateOnCopyPaste(
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
        document: vscode.TextDocument,
        relativeFilePath: string,
        restoredThisEvent: ReadonlySet<string> = new Set<string>(),
        previousTargetLines?: string[],
        preChangeLinesByAnnotationId: ReadonlyMap<string, number> = new Map<string, number>(),
        preChangeTrackingLinesByAnnotationId: ReadonlyMap<string, number> = new Map<string, number>()
    ): Promise<void> {
        // Primary guard: clipboard must be non-empty and match the inserted text.
        // Keystrokes, Enter, and autocomplete do NOT change the OS clipboard.
        const rawClipboard = await vscode.env.clipboard.readText();
        if (this.normalizeClipboardText(rawClipboard).length === 0) {
            return;
        }

        const clipboardLines = this.splitClipboardLines(rawClipboard);
        if (clipboardLines.length === 0) {
            return;
        }

        const sourceCandidatesByOffset = this.collectCopySourceCandidates(
            clipboardLines,
            document,
            previousTargetLines,
            preChangeLinesByAnnotationId,
            preChangeTrackingLinesByAnnotationId,
            restoredThisEvent
        );
        if (sourceCandidatesByOffset.size === 0) {
            return;
        }

        const createdCopies = new Set<string>();

        for (const change of contentChanges) {
            if (change.text.length === 0) {
                continue;
            }
            if (!this.clipboardTextMatches(change.text, rawClipboard)) {
                continue;
            }

            const insertedLines = this.splitClipboardLines(change.text);
            const startLine = change.range.start.line;

            for (let k = 0; k < insertedLines.length; k++) {
                const newLine = startLine + k;
                const sourceCandidates = sourceCandidatesByOffset.get(k) ?? [];

                for (const source of sourceCandidates) {
                    const annotation = source.annotation;
                    const renderLine = this.clampDocumentLine(newLine + source.renderOffsetFromSource, document);
                    const copyKey = `${annotation.id}:${renderLine}`;
                    if (createdCopies.has(copyKey)) {
                        continue;
                    }

                    // Anti-duplicate guard: never create a second annotation at the same
                    // (file, line) carrying the same message.  Belt-and-suspenders against
                    // edge cases where undo/redo, multi-cursor, or rapid events would
                    // otherwise re-fire duplication on top of an existing annotation.
                    if (this.sameLocationSameMessage(document, renderLine, annotation.message)) {
                        this.log(`anti-duplicate: skipped creating duplicate at ${relativeFilePath}:${renderLine}`);
                        continue;
                    }

                    // Belt-and-suspenders: an annotation in the cut buffer with the
                    // same message at the target line means the paste is reviving a
                    // cut. Recovery should have handled it; refuse to also duplicate.
                    let cutBufferShadowsTarget = false;
                    for (const deferred of this.recentDeletions.values()) {
                        if (deferred.annotation.message === annotation.message) {
                            cutBufferShadowsTarget = true;
                            break;
                        }
                    }
                    if (cutBufferShadowsTarget) {
                        this.log(
                            `anti-duplicate: cut buffer holds same message, skipped at ${relativeFilePath}:${newLine}`
                        );
                        continue;
                    }

                    const newAnnotation: Annotation = {
                        ...annotation,
                        id: this.generateId(),
                        file: relativeFilePath, // always the paste-destination file
                        fileUri: document.uri.toString(),
                        languageId: document.languageId,
                        line: renderLine,
                        timestamp: new Date().toISOString(),
                        origin: {
                            kind: 'copy-paste',
                            sourceId: annotation.id,
                            sourceFile: annotation.file,
                            sourceFileUri: annotation.fileUri,
                            sourceLine: source.sourceLine,
                            pastedAtLine: renderLine,
                        },
                        anchor: undefined, // re-anchored against the destination below
                        resolvedAnchor: undefined,
                    };
                    this.setAnnotationLineWithTrackingLine(newAnnotation, renderLine, newLine, document);
                    this.annotations.set(newAnnotation.id, newAnnotation);
                    createdCopies.add(copyKey);
                    this.log(
                        `copy-paste: duplicated annotation ${annotation.id} ` +
                            `from ${source.sourceUri}:${source.sourceLine} to ${relativeFilePath}:${renderLine}`
                    );
                }
            }
        }
    }

    private normalizeClipboardText(text: string): string {
        return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    private async readClipboardTextSafely(): Promise<string> {
        try {
            return await vscode.env.clipboard.readText();
        } catch {
            return '';
        }
    }

    private stripSingleTrailingLineBreak(text: string): string {
        return text.endsWith('\n') ? text.slice(0, -1) : text;
    }

    private splitClipboardLines(text: string): string[] {
        return this.stripSingleTrailingLineBreak(this.normalizeClipboardText(text)).split('\n');
    }

    private clipboardTextMatches(changeText: string, clipboardText: string): boolean {
        const normalizedChange = this.normalizeClipboardText(changeText);
        const normalizedClipboard = this.normalizeClipboardText(clipboardText);
        return (
            normalizedChange === normalizedClipboard ||
            this.stripSingleTrailingLineBreak(normalizedChange) ===
                this.stripSingleTrailingLineBreak(normalizedClipboard)
        );
    }

    private normalizedTextEquals(a: string | undefined, b: string | undefined): boolean {
        if (a === undefined || b === undefined) {
            return false;
        }
        return (
            this.stripSingleTrailingLineBreak(this.normalizeClipboardText(a)) ===
            this.stripSingleTrailingLineBreak(this.normalizeClipboardText(b))
        );
    }

    private isLowSignalText(text: string | undefined): boolean {
        if (text === undefined) {
            return true;
        }
        return this.stripSingleTrailingLineBreak(this.normalizeClipboardText(text)).trim().length === 0;
    }

    private deferredClipboardStillMatches(
        deferred: {
            cutText?: string;
            annotation: Annotation;
        },
        clipboardText: string
    ): boolean {
        if (this.isLowSignalText(deferred.cutText)) {
            return false;
        }
        if (this.normalizedTextEquals(deferred.cutText, clipboardText)) {
            return true;
        }

        const normalizedClipboard = this.stripSingleTrailingLineBreak(this.normalizeClipboardText(clipboardText));
        return (
            normalizedClipboard.length > 0 &&
            deferred.annotation.lineHash !== undefined &&
            this.splitClipboardLines(normalizedClipboard).some(
                (line) => hashLine(line) === deferred.annotation.lineHash
            )
        );
    }

    private deferredPasteMatchesChange(
        deferred: {
            cutText?: string;
            cutLineHashes?: string[];
        },
        changeText: string,
        clipboardText: string
    ): boolean {
        if (changeText.length === 0) {
            return false;
        }
        if (deferred.cutText !== undefined) {
            return (
                this.normalizedTextEquals(deferred.cutText, clipboardText) &&
                this.clipboardTextMatches(changeText, clipboardText) &&
                this.clipboardTextMatches(changeText, deferred.cutText)
            );
        }

        if (
            !this.isLowSignalText(clipboardText) &&
            this.clipboardTextMatches(changeText, clipboardText) &&
            deferred.cutLineHashes?.length
        ) {
            const insertedHashes = this.splitClipboardLines(changeText).map((line) => hashLine(line));
            if (
                insertedHashes.length === deferred.cutLineHashes.length &&
                insertedHashes.every((hash, index) => hash === deferred.cutLineHashes?.[index])
            ) {
                return true;
            }
        }
        return false;
    }

    private getCutLinesForChange(
        oldLines: readonly string[],
        change: vscode.TextDocumentContentChangeEvent,
        offsetInBlock: number
    ): string[] {
        const start = Math.max(0, change.range.start.line);
        const end = Math.max(start + 1, change.range.end.line);
        const exclusive = oldLines.slice(start, end);
        if (offsetInBlock < exclusive.length) {
            return exclusive;
        }

        const inclusive = oldLines.slice(start, Math.min(oldLines.length, end + 1));
        if (offsetInBlock < inclusive.length) {
            return inclusive;
        }

        return exclusive.length > 0 ? exclusive : inclusive;
    }

    private contentChangesEraseLine(
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
        line: number
    ): boolean {
        return contentChanges.some(
            (change) => change.text.replace(/\r\n/g, '').length === 0 && this.contentChangeTouchesLine(change, line)
        );
    }

    private contentChangeTouchesLine(change: vscode.TextDocumentContentChangeEvent, line: number): boolean {
        return line >= change.range.start.line && line <= this.getTouchedEndLine(change);
    }

    private getTouchedEndLine(change: vscode.TextDocumentContentChangeEvent): number {
        if (change.text === '' && change.range.end.character === 0 && change.range.end.line > change.range.start.line) {
            return change.range.end.line - 1;
        }
        return change.range.end.line;
    }

    private contentChangesEraseAnnotation(
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
        annotation: Annotation
    ): boolean {
        return (
            this.contentChangesEraseLine(contentChanges, annotation.line) ||
            this.contentChangesEraseLine(contentChanges, this.getAnnotationTrackingLine(annotation))
        );
    }

    private getAnnotationTrackingLine(annotation: Annotation): number {
        return annotation.anchor?.targetLine ?? annotation.line;
    }

    private getAnnotationTrackingHash(annotation: Annotation): string | undefined {
        return annotation.anchor?.anchorTextHash ?? annotation.lineHash;
    }

    private shouldRemoveCopiedAnnotationOnUndo(
        annotation: Annotation,
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
        document: vscode.TextDocument
    ): boolean {
        const removedByUndo = contentChanges.some(
            (change) =>
                change.text === '' &&
                (this.contentChangeTouchesLine(change, annotation.line) ||
                    this.contentChangeTouchesLine(change, this.getAnnotationTrackingLine(annotation)))
        );
        if (!removedByUndo) {
            return false;
        }

        if (annotation.origin?.kind === 'copy-paste') {
            return true;
        }

        // Compatibility for annotations duplicated before origin metadata existed:
        // if Undo removes one copy while an equivalent annotation still exists
        // outside the removed range, the removed one is the paste-derived copy.
        return this.hasEquivalentAnnotationOutsideChangeRanges(annotation, contentChanges, document);
    }

    private hasEquivalentAnnotationOutsideChangeRanges(
        annotation: Annotation,
        contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
        document: vscode.TextDocument
    ): boolean {
        const lineInsideRemovedRanges = (line: number): boolean =>
            contentChanges.some((change) => change.text === '' && this.contentChangeTouchesLine(change, line));

        for (const other of this.annotations.values()) {
            if (other.id === annotation.id) {
                continue;
            }
            if (!this.annotationMatchesDocument(other, document)) {
                continue;
            }
            if (lineInsideRemovedRanges(other.line)) {
                continue;
            }
            if (other.message !== annotation.message) {
                continue;
            }
            if (annotation.lineHash && other.lineHash === annotation.lineHash) {
                return true;
            }
        }

        return false;
    }

    private collectCopySourceCandidates(
        clipboardLines: readonly string[],
        targetDocument: vscode.TextDocument,
        previousTargetLines: string[] | undefined,
        preChangeLinesByAnnotationId: ReadonlyMap<string, number>,
        preChangeTrackingLinesByAnnotationId: ReadonlyMap<string, number>,
        restoredThisEvent: ReadonlySet<string>
    ): Map<number, CopySourceCandidate[]> {
        const clipboardHashes = clipboardLines.map((line) => hashLine(line));
        const snapshots = this.getCopySourceSnapshots(targetDocument, previousTargetLines);
        const byOffset = new Map<number, CopySourceCandidate[]>();
        const seenCandidateKeys = new Set<string>();
        const singleLineSourceLocations = new Set<string>();

        for (const snapshot of snapshots) {
            const starts = this.findMatchingClipboardBlockStarts(snapshot.lines, clipboardHashes);
            if (starts.length === 0) {
                continue;
            }

            for (const annotation of this.annotations.values()) {
                if (this.recentDeletions.has(annotation.id) || restoredThisEvent.has(annotation.id)) {
                    continue;
                }
                const status = annotation.resolvedAnchor?.status;
                if (status === 'stale' || status === 'orphaned') {
                    continue;
                }
                if (!this.annotationMatchesSnapshot(annotation, snapshot)) {
                    continue;
                }

                const renderSourceLine = snapshot.usePreChangeLines
                    ? (preChangeLinesByAnnotationId.get(annotation.id) ?? annotation.line)
                    : annotation.line;
                const trackingSourceLine = snapshot.usePreChangeLines
                    ? (preChangeTrackingLinesByAnnotationId.get(annotation.id) ??
                      this.getAnnotationTrackingLine(annotation))
                    : this.getAnnotationTrackingLine(annotation);

                for (const start of starts) {
                    const operation = this.selectCopyOperationLine(
                        annotation,
                        snapshot.lines,
                        start,
                        clipboardHashes,
                        renderSourceLine,
                        trackingSourceLine
                    );
                    if (!operation) {
                        continue;
                    }

                    const { sourceLine, offset, renderOffsetFromSource } = operation;

                    const candidateKey = `${annotation.id}:${snapshot.uri}:${sourceLine}:${offset}:${renderOffsetFromSource}`;
                    if (seenCandidateKeys.has(candidateKey)) {
                        continue;
                    }
                    seenCandidateKeys.add(candidateKey);

                    if (clipboardHashes.length === 1) {
                        singleLineSourceLocations.add(`${snapshot.uri}:${sourceLine}`);
                    }

                    const candidates = byOffset.get(offset) ?? [];
                    candidates.push({
                        annotation,
                        sourceUri: snapshot.uri,
                        sourceLine,
                        offset,
                        renderOffsetFromSource,
                    });
                    byOffset.set(offset, candidates);
                }
            }
        }

        // A single-line clipboard payload has no block context. If multiple
        // annotated source locations have the same text, copying annotations
        // would be guesswork, so skip instead of duplicating the wrong note.
        if (clipboardHashes.length === 1 && singleLineSourceLocations.size > 1) {
            this.log(
                `copy-paste: skipped single-line annotation copy; ` +
                    `${singleLineSourceLocations.size} annotated source lines match the clipboard`
            );
            return new Map();
        }

        return byOffset;
    }

    private selectCopyOperationLine(
        annotation: Annotation,
        snapshotLines: readonly string[],
        blockStart: number,
        clipboardHashes: readonly string[],
        renderSourceLine: number,
        trackingSourceLine: number
    ): { sourceLine: number; offset: number; renderOffsetFromSource: number } | null {
        const blockEndExclusive = blockStart + clipboardHashes.length;
        const candidates = [
            {
                line: trackingSourceLine,
                hash: this.getAnnotationTrackingHash(annotation),
                renderOffsetFromSource: renderSourceLine - trackingSourceLine,
            },
            {
                line: renderSourceLine,
                hash: annotation.lineHash,
                renderOffsetFromSource: 0,
            },
        ];

        for (const candidate of candidates) {
            if (candidate.line < blockStart || candidate.line >= blockEndExclusive) {
                continue;
            }
            if (candidate.line < 0 || candidate.line >= snapshotLines.length) {
                continue;
            }
            const offset = candidate.line - blockStart;
            const sourceHash = candidate.hash ?? hashLine(snapshotLines[candidate.line]);
            if (sourceHash !== clipboardHashes[offset]) {
                continue;
            }
            return {
                sourceLine: candidate.line,
                offset,
                renderOffsetFromSource: candidate.renderOffsetFromSource,
            };
        }

        return null;
    }

    private getCopySourceSnapshots(
        targetDocument: vscode.TextDocument,
        previousTargetLines?: string[]
    ): CopySourceSnapshot[] {
        const snapshots: CopySourceSnapshot[] = [];
        const seenUris = new Set<string>();
        const targetUri = targetDocument.uri.toString();

        if (previousTargetLines) {
            snapshots.push({
                uri: targetUri,
                relativeFilePath: this.getRelativePath(targetDocument.fileName),
                lines: previousTargetLines,
                usePreChangeLines: true,
            });
            seenUris.add(targetUri);
        }

        for (const [uri, lines] of this.documentSnapshots) {
            if (seenUris.has(uri)) {
                continue;
            }
            const relativeFilePath = this.getRelativePathFromUriString(uri);
            if (!relativeFilePath) {
                continue;
            }
            snapshots.push({
                uri,
                relativeFilePath,
                lines,
                usePreChangeLines: false,
            });
            seenUris.add(uri);
        }

        for (const doc of vscode.workspace.textDocuments) {
            const uri = doc.uri.toString();
            if (seenUris.has(uri)) {
                continue;
            }
            const lines: string[] = [];
            for (let i = 0; i < doc.lineCount; i++) {
                lines.push(doc.lineAt(i).text);
            }
            snapshots.push({
                uri,
                relativeFilePath: this.getRelativePath(doc.fileName),
                lines,
                usePreChangeLines: uri === targetUri,
            });
            seenUris.add(uri);
        }

        return snapshots;
    }

    private getRelativePathFromUriString(uriString: string): string | null {
        try {
            const uri = vscode.Uri.parse(uriString);
            return this.getRelativePath(uri.fsPath);
        } catch {
            return null;
        }
    }

    private annotationMatchesSnapshot(annotation: Annotation, snapshot: CopySourceSnapshot): boolean {
        if (annotation.fileUri) {
            return annotation.fileUri === snapshot.uri;
        }
        return this.normalizePath(annotation.file) === this.normalizePath(snapshot.relativeFilePath);
    }

    private findMatchingClipboardBlockStarts(lines: readonly string[], clipboardHashes: readonly string[]): number[] {
        if (clipboardHashes.length === 0 || clipboardHashes.length > lines.length) {
            return [];
        }

        const starts: number[] = [];
        for (let start = 0; start <= lines.length - clipboardHashes.length; start++) {
            let matches = true;
            for (let offset = 0; offset < clipboardHashes.length; offset++) {
                if (hashLine(lines[start + offset]) !== clipboardHashes[offset]) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                starts.push(start);
            }
        }
        return starts;
    }

    /**
     * Show a non-modal informational toast when cut annotations expire silently.
     * The Undo button restores them to the nearest valid line.  No modal blocking.
     */
    private showCutExpiredToast(
        expiredAnnotations: Annotation[],
        document: vscode.TextDocument,
        relativeFilePath: string
    ): void {
        vscode.window
            .showInformationMessage(
                localize(
                    'annotationsCutExpired',
                    '{0} annotation(s) removed (not pasted). Press Undo to restore.',
                    expiredAnnotations.length
                ),
                localize('undo', 'Undo')
            )
            .then((answer) => {
                if (answer !== localize('undo', 'Undo')) {
                    return;
                }
                for (const annotation of expiredAnnotations) {
                    const clamped = Math.max(0, Math.min(annotation.line, document.lineCount - 1));
                    annotation.file = relativeFilePath;
                    annotation.fileUri = document.uri.toString();
                    annotation.languageId = document.languageId;
                    annotation.resolvedAnchor = undefined;
                    if (annotation.anchor) {
                        annotation.anchor = {
                            ...annotation.anchor,
                            kind: 'line',
                            symbolName: null,
                            symbolKind: null,
                            symbolSignature: null,
                        };
                    }
                    this.setAnnotationLine(annotation, clamped, document);
                    this.annotations.set(annotation.id, annotation);
                    this.deletedRecently.delete(annotation.id);
                }
                this.saveAnnotations().then(() => this.refreshAnnotations());
            });
    }

    /**
     * Attempt to restore silently-deleted annotations whose content has reappeared
     * in the document (e.g. after the user pressed Ctrl+Z to undo a text edit).
     * Also cleans up entries older than deletedRecentlyTtlMs.
     *
     * `restoredThisEvent`, when provided, accumulates the ids of annotations
     * that were just restored so the downstream `detectAndDuplicateOnCopyPaste`
     * step skips them (otherwise the restored annotation gets duplicated AGAIN
     * because the same paste insert that triggered the restore also matches
     * the duplication clipboard guard).
     */
    private tryRestoreFromDeletedRecently(
        doc: vscode.TextDocument,
        relativeFilePath: string,
        restoredThisEvent?: Set<string>
    ): void {
        const now = Date.now();
        for (const [id, entry] of this.deletedRecently) {
            if (now - entry.removedAt > this.deletedRecentlyTtlMs) {
                this.deletedRecently.delete(id);
                continue;
            }
            if (!entry.annotation.lineHash) {
                continue;
            }
            const anchor: AnchorData = {
                lineHash: entry.annotation.lineHash,
                contextBefore: entry.annotation.contextBefore ?? [],
                contextAfter: entry.annotation.contextAfter ?? [],
            };
            const found = findAnchor(doc, anchor, entry.annotation.line);
            if (found !== null) {
                entry.annotation.file = relativeFilePath;
                entry.annotation.fileUri = doc.uri.toString();
                entry.annotation.languageId = doc.languageId;
                entry.annotation.resolvedAnchor = undefined;
                if (entry.annotation.anchor) {
                    entry.annotation.anchor = {
                        ...entry.annotation.anchor,
                        kind: 'line',
                        symbolName: null,
                        symbolKind: null,
                        symbolSignature: null,
                    };
                }
                this.setAnnotationLine(entry.annotation, found, doc);
                this.annotations.set(id, entry.annotation);
                this.deletedRecently.delete(id);
                restoredThisEvent?.add(id);
                this.log(`deletedRecently: restored ${id} at ${relativeFilePath}:${found} (undo-buffer)`);
            }
        }
    }

    private async handleDocumentOpen(document: vscode.TextDocument): Promise<void> {
        if (this.lifecycleDelegatedToStore) {
            return;
        }
        this.snapshotDocument(document);

        const relativeFilePath = this.getRelativePath(document.fileName);

        // Restore silently-deleted annotations if their content reappears after reload.
        this.tryRestoreFromDeletedRecently(document, relativeFilePath);

        let changed = this.repairBlankLineTrackingAnchors(document);

        for (const annotation of this.annotations.values()) {
            if (!this.annotationMatchesDocument(annotation, document)) {
                continue;
            }

            // Legacy annotation without anchor fields: migrate silently
            if (!annotation.lineHash) {
                if (annotation.line >= 0 && annotation.line < document.lineCount) {
                    this.setAnnotationLine(annotation, annotation.line, document);
                    changed = true;
                }
                continue;
            }

            // Fast path: stored line still holds the correct content
            if (annotation.line >= 0 && annotation.line < document.lineCount) {
                const currentHash = hashLine(document.lineAt(annotation.line).text);
                if (currentHash === annotation.lineHash) {
                    continue;
                }
            }

            // Hash mismatch: external edit may have shifted the line -- try to relocate
            const anchor: AnchorData = {
                lineHash: annotation.lineHash,
                contextBefore: annotation.contextBefore ?? [],
                contextAfter: annotation.contextAfter ?? [],
            };
            const found = findAnchor(document, anchor, annotation.line);
            if (found !== null) {
                this.setAnnotationLine(annotation, found, document);
                changed = true;
            }
            // Not found: annotation drifted; leave stored position, will re-try on next open
        }

        if (changed) {
            await this.saveAnnotations();
        }

        const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
        if (editor) {
            await this.refreshAnnotations();
        }
    }

    private repairBlankLineTrackingAnchors(document: vscode.TextDocument): boolean {
        let changed = false;

        for (const annotation of this.annotations.values()) {
            if (!this.annotationMatchesDocument(annotation, document)) {
                continue;
            }
            if (annotation.lineHash !== EMPTY_LINE_HASH) {
                continue;
            }
            if (annotation.line < 0 || annotation.line >= document.lineCount) {
                continue;
            }

            const exactAnchor: AnchorData = {
                lineHash: annotation.lineHash,
                contextBefore: annotation.contextBefore ?? [],
                contextAfter: annotation.contextAfter ?? [],
            };
            const exactLine = findAnchor(document, exactAnchor, annotation.line);
            if (exactLine === null) {
                continue;
            }

            const exactRecapture = captureAnchor(document, exactLine, {
                walkForward: 0,
                walkBackward: 0,
            });
            const trackingAnchor = captureAnchor(document, exactLine);
            if (trackingAnchor.lineHash === EMPTY_LINE_HASH) {
                continue;
            }

            const current = annotation.anchor;
            if (
                current &&
                annotation.line === exactLine &&
                current.targetLine === trackingAnchor.targetLine &&
                current.anchorTextHash === trackingAnchor.lineHash &&
                JSON.stringify(annotation.contextBefore ?? []) === JSON.stringify(exactRecapture.contextBefore) &&
                JSON.stringify(annotation.contextAfter ?? []) === JSON.stringify(exactRecapture.contextAfter) &&
                JSON.stringify(current.contextBefore ?? []) === JSON.stringify(trackingAnchor.contextBefore) &&
                JSON.stringify(current.contextAfter ?? []) === JSON.stringify(trackingAnchor.contextAfter)
            ) {
                continue;
            }

            annotation.line = exactLine;
            annotation.lineHash = exactRecapture.lineHash;
            annotation.contextBefore = exactRecapture.contextBefore;
            annotation.contextAfter = exactRecapture.contextAfter;
            annotation.anchor = {
                ...(current ?? {
                    kind: 'line' as const,
                    originalLine: exactLine,
                    symbolName: null,
                    symbolKind: null,
                    symbolSignature: null,
                }),
                targetLine: trackingAnchor.targetLine ?? annotation.line,
                anchorTextHash: trackingAnchor.lineHash,
                contextBefore: trackingAnchor.contextBefore,
                contextAfter: trackingAnchor.contextAfter,
            };
            annotation.resolvedAnchor = undefined;
            changed = true;
        }

        return changed;
    }

    // applyAnnotations with targeted clearDecorations
    private async applyAnnotations(editor: vscode.TextEditor, annotations: Annotation[]): Promise<void> {
        if (!this.annotationsEnabled || !this.config.enableAnnotations) {
            this.clearDecorations(editor);
            return;
        }

        // First clear all decorations for this editor
        this.clearDecorations(editor);

        // Then apply the new annotations
        for (const annotation of annotations) {
            // Pure render: orphaned/stale entries are kept in the model and shown
            // in the side panel/tree, but never decorated in the editor gutter.
            const status = annotation.resolvedAnchor?.status;
            if (status === 'orphaned' || status === 'stale') {
                continue;
            }
            if (this.shouldAnnotationBeVisible(annotation)) {
                await this.applyAnnotation(editor, annotation);
            }
        }
    }

    public shouldAnnotationBeVisible(annotation: Annotation): boolean {
        const disabledTags = this.config.disabledTags;

        if (annotation.tags && annotation.tags.some((t) => disabledTags.includes(t))) {
            return false;
        }

        if (this.currentFilter.startsWith('keyword:')) {
            const keyword = this.currentFilter.replace('keyword:', '').toLowerCase();
            return (
                (annotation.message?.toLowerCase().includes(keyword) ?? false) ||
                (annotation.thread?.some((c) => c.message.toLowerCase().includes(keyword)) ?? false)
            );
        }

        if (this.currentFilter.startsWith('severity:')) {
            const sev = this.currentFilter.replace('severity:', '');
            return annotation.severity === sev;
        }

        if (
            this.currentFilter !== 'all' &&
            this.currentFilter.trim() !== '' &&
            !this.currentFilter.startsWith('keyword:') &&
            !this.currentFilter.startsWith('severity:')
        ) {
            const filterTag = this.currentFilter.toLowerCase();
            if (!annotation.tags || !annotation.tags.map((t) => t.toLowerCase()).includes(filterTag)) {
                // Handle tag or file filter here
                const fileFilter = filterTag;
                if (annotation.file.toLowerCase().includes(fileFilter)) {
                    return true;
                } else {
                    return false;
                }
            }
        }

        return true;
    }

    private createDecorationForAnnotation(annotation: Annotation): vscode.TextEditorDecorationType {
        const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const colors = isDark ? this.config.colors.dark : this.config.colors.light;

        // Get severity icon
        const severityIcon = this.getSeverityIcon(annotation.severity || 'info');

        // Configurable per-tag / per-severity styling (better-comments style).
        // Resolved fields override the theme defaults from annotation.colors;
        // undefined fields keep the existing fallbacks.
        const styleSettings = vscode.workspace.getConfiguration('annotation');
        const style = resolveAnnotationStyle(annotation, {
            severityStyles: styleSettings.get<Record<string, StyleSpec>>('severityStyles', {}),
            tagStyles: styleSettings.get<Record<string, StyleSpec>>('tagStyles', {}),
        });

        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: style.backgroundColor ?? colors.highlightBackground,
            after: {
                contentText: ` 💬 ${severityIcon} ${annotation.message}${annotation.pinned ? '📌' : ''}`,
                color: style.annotationColor ?? colors.annotation,
                margin: '0 0 0 1em',
            },
            borderColor: style.border ?? colors.commentBorder,
            borderWidth: '0 0 0 2px',
            borderStyle: 'solid',
            gutterIconPath: style.gutterIcon ? this.getGutterIconPath() : undefined,
            gutterIconSize: 'contain',
        });
    }

    private async applyAnnotation(editor: vscode.TextEditor, annotation: Annotation): Promise<void> {
        // Render at the resolved line when the resolver moved the anchor; otherwise
        // fall back to the persisted line. Persisted line is left untouched so the
        // resolution remains transient (refresh = projection, not mutation).
        const resolvedLine =
            annotation.resolvedAnchor?.status === 'attached' || annotation.resolvedAnchor?.status === 'moved'
                ? annotation.resolvedAnchor.line
                : null;
        const renderLine = resolvedLine ?? annotation.line;

        if (renderLine < 0 || renderLine >= editor.document.lineCount) {
            // Out of range: mark orphaned and skip decoration. Silent deletion was
            // a data-loss footgun -- the user's annotation must survive even when
            // the document temporarily shrinks (Undo/Redo, branch switch, etc.).
            annotation.resolvedAnchor = {
                status: 'orphaned',
                line: null,
                confidence: 0,
                reason: `Line ${renderLine + 1} out of document range (${editor.document.lineCount} lines)`,
            };
            return;
        }

        const existingDecoration = this.decorationTypes.get(annotation.id);
        if (existingDecoration) {
            existingDecoration.dispose();
        }

        const decorationType = this.createDecorationForAnnotation(annotation);
        this.decorationTypes.set(annotation.id, decorationType);
        // Single-line zero-width range: gutter icon only on the anchor line.
        const range = new vscode.Range(renderLine, 0, renderLine, 0);

        const snippet = annotation.message.substring(0, 15);
        const viewInPanelLabel = localize('viewInPanelLabel', 'View in Panel →');
        const hoverMessage = new vscode.MarkdownString(
            `${snippet}... [${viewInPanelLabel}](command:annotations.navigateToPanel?${encodeURIComponent(JSON.stringify(annotation.id))})`
        );
        hoverMessage.isTrusted = true;

        const decorationOptions: vscode.DecorationOptions = {
            range: range,
            hoverMessage: hoverMessage,
        };
        editor.setDecorations(decorationType, [decorationOptions]);
    }

    public async refreshAnnotations(): Promise<void> {
        if (!this.annotationsEnabled || !this.config.enableAnnotations) {
            return;
        }

        // Cancel previous timeout if any
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }

        // Use debounce to avoid multiple rapid calls
        this.refreshTimeout = setTimeout(async () => {
            if (this.isRefreshing) {
                return; // Avoid concurrent calls
            }

            this.isRefreshing = true;
            try {
                const editors = vscode.window.visibleTextEditors;
                for (const editor of editors) {
                    // Strict URI filter (with legacy fallback). Cross-file rendering
                    // is the data-corruption symptom -- block it at the boundary.
                    const fileAnnotations = Array.from(this.annotations.values()).filter((a) =>
                        this.annotationMatchesDocument(a, editor.document)
                    );
                    // Recompute resolution status (pure -- attaches transient state only).
                    for (const annotation of fileAnnotations) {
                        annotation.resolvedAnchor = this.computeResolvedAnchor(editor.document, annotation);
                    }
                    await this.applyAnnotations(editor, fileAnnotations);
                }
                this.updateAnnotationsPanel();
            } finally {
                this.isRefreshing = false;
            }
        }, 100); // 100ms debounce
    }

    private async handleEditorChange(editor: vscode.TextEditor | undefined): Promise<void> {
        this.updateStatusBar();
        if (editor && this.annotationsEnabled) {
            // Short delay to prevent multiple rapid calls
            setTimeout(() => {
                this.refreshAnnotations();
            }, 50);
        }
    }

    private findAnnotation(file: string, line: number): Annotation | undefined {
        return Array.from(this.annotations.values()).find(
            (annotation) =>
                this.annotationMatchesFsPath(annotation, file) && this.getEffectiveAnnotationLine(annotation) === line
        );
    }

    private getEffectiveAnnotationLine(annotation: Annotation): number {
        const resolved = annotation.resolvedAnchor;
        if ((resolved?.status === 'attached' || resolved?.status === 'moved') && resolved.line !== null) {
            return resolved.line;
        }
        return annotation.line;
    }

    /**
     * True when the live map already contains an annotation at exactly
     * (relativeFile, line) carrying the same message text.  Used as the
     * final guard before creating a duplicate via copy-paste detection.
     */
    private sameLocationSameMessage(document: vscode.TextDocument, line: number, message: string): boolean {
        for (const a of this.annotations.values()) {
            if (
                this.annotationMatchesDocument(a, document) &&
                this.getEffectiveAnnotationLine(a) === line &&
                a.message === message
            ) {
                return true;
            }
        }
        return false;
    }

    private getProjectAnnotationsPath(): string | null {
        // Read configuration from the 'annotation' block
        const config = vscode.workspace.getConfiguration('annotation');
        let customPath = config.get<string>('path', '').trim();

        let annotationFilePath: string;
        if (customPath) {
            // If a custom path is set via `annotation.path`, decide whether
            // it is absolute or relative to the workspace root.
            if (!path.isAbsolute(customPath)) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    return null;
                }
                customPath = path.join(workspaceFolders[0].uri.fsPath, customPath);
                const wsRoot = workspaceFolders[0].uri.fsPath;
                const resolved = path.resolve(customPath);
                if (!resolved.startsWith(wsRoot + path.sep) && resolved !== wsRoot) {
                    throw new Error(`Annotation path is outside workspace: ${resolved}`);
                }
                customPath = resolved;
            }

            // If the path already points to a .json file, use it as-is;
            // otherwise treat it as a directory and append annotations.json.
            if (path.extname(customPath).toLowerCase() === '.json') {
                annotationFilePath = customPath;
            } else {
                annotationFilePath = path.join(customPath, 'annotations.json');
            }
        } else {
            // No custom config: use the first workspace folder.
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return null;
            }
            annotationFilePath = path.join(workspaceFolders[0].uri.fsPath, '.out-of-code-insights', 'annotations.json');
        }

        return annotationFilePath;
    }

    /**
     * Verifies the annotations file exists; creates the directory and an
     * empty JSON array if not. No-op when no workspace folder is open.
     */
    private async ensureAnnotationsFileExists(): Promise<void> {
        const annotationFilePath = this.getProjectAnnotationsPath();
        if (!annotationFilePath) {
            this.log('No workspace folder open; skipping annotation file initialization.');
            return;
        }
        const fileUri = vscode.Uri.file(annotationFilePath);

        try {
            await vscode.workspace.fs.stat(fileUri);
            // File already exists, nothing to do
        } catch (error) {
            // File does not exist, create it
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                const dirUri = vscode.Uri.file(path.dirname(annotationFilePath));
                await vscode.workspace.fs.createDirectory(dirUri);
                const initialContent = Buffer.from(JSON.stringify([], null, 2), 'utf8');
                await vscode.workspace.fs.writeFile(fileUri, initialContent);
            } else {
                throw error;
            }
        }
    }

    public async deleteAnnotationCommand(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const line = editor.selection.active.line;
        const annotation = this.findAnnotation(editor.document.fileName, line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationDelete', 'No annotation found on this line.'));
            return;
        }
        await this.deleteAnnotation(annotation.id);
    }

    public async editAnnotationCommand(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const line = editor.selection.active.line;
        const annotation = this.findAnnotation(editor.document.fileName, line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationEdit', 'No annotation found on this line.'));
            return;
        }
        await this.modifyAnnotation(annotation.id);
    }

    public async moveUpCommand(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const line = editor.selection.active.line;
        const annotation = this.findAnnotation(editor.document.fileName, line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationMove', 'No annotation found on this line.'));
            return;
        }
        await this.moveAnnotationUp(annotation.id);
    }

    public async moveDownCommand(): Promise<void> {
        const editor = this.getActiveEditor();
        if (!editor) return;
        const line = editor.selection.active.line;
        const annotation = this.findAnnotation(editor.document.fileName, line);
        if (!annotation) {
            vscode.window.showErrorMessage(localize('noAnnotationMove', 'No annotation found on this line.'));
            return;
        }
        await this.moveAnnotationDown(annotation.id);
    }

    // Explicit string type for the id parameter
    private async modifyAnnotation(id: string): Promise<void> {
        const annotation = this.annotations.get(id);
        if (!annotation) return; // Guard: annotation not found

        // Show quick pick for modification options
        const modifyOptions = [
            { label: localize('modifyMessage', 'Modify Message'), value: 'message' },
            { label: localize('modifySeverity', 'Modify Severity'), value: 'severity' },
            { label: localize('modifyBoth', 'Modify Both'), value: 'both' },
        ];

        const selectedOption = await vscode.window.showQuickPick(modifyOptions, {
            placeHolder: localize('selectModificationOption', 'What would you like to modify?'),
        });

        if (!selectedOption) return;

        let messageChanged = false;
        let severityChanged = false;

        // Modify message if selected
        if (selectedOption.value === 'message' || selectedOption.value === 'both') {
            const newMessage = await vscode.window.showInputBox({
                prompt: localize('modifyAnnotation', 'Modify annotation message'),
                value: annotation.message,
                validateInput: (text) =>
                    text.trim().length === 0 ? localize('emptyMessageError', 'Message cannot be empty') : null,
            });
            if (newMessage && newMessage !== annotation.message) {
                annotation.message = newMessage;
                messageChanged = true;
            }
        }

        // Modify severity if selected
        if (selectedOption.value === 'severity' || selectedOption.value === 'both') {
            const severityOptions = [
                { label: '❌ Error', value: 'error' },
                { label: '⚠️ Warning', value: 'warning' },
                { label: 'ℹ️ Info', value: 'info' },
            ];

            const selectedSeverityItem = await vscode.window.showQuickPick(severityOptions, {
                placeHolder: localize('selectSeverity', 'Select annotation severity'),
            });

            if (selectedSeverityItem && selectedSeverityItem.value !== annotation.severity) {
                annotation.severity = selectedSeverityItem.value;
                severityChanged = true;
            }
        }

        // Save changes if any were made
        if (messageChanged || severityChanged) {
            annotation.timestamp = new Date().toISOString();
            await this.saveAnnotations();
            await this.refreshAnnotations();
            this.updateAnnotationsPanel();
            const editor = this.getActiveEditor();
            if (editor) {
                this.highlightLineTemporarily(editor, annotation.line);
            }
            vscode.window.showInformationMessage(localize('annotationModified', 'Annotation modified successfully!'));
            this.emit('annotationChanged');
        }
    }

    private async deleteAnnotation(annotationId: string): Promise<void> {
        try {
            const annotation = this.annotations.get(annotationId);
            if (!annotation) return;
            this.annotations.delete(annotationId);
            this.disposeDecoration(annotationId);
            await this.saveAnnotations();
            await this.refreshAnnotations();
            this.updateAnnotationsPanel();
            vscode.window.showInformationMessage(localize('annotationDeleted', 'Annotation deleted successfully!'));
            this.emit('annotationChanged');
        } catch (error) {
            this.handleError(localize('deleteAnnotationError', 'Failed to delete annotation'), error);
        }
    }

    private async replyToAnnotation(annotationId: string): Promise<void> {
        try {
            const annotation = this.annotations.get(annotationId);
            if (!annotation) return;
            const reply = await vscode.window.showInputBox({
                prompt: localize('enterReply', 'Enter your reply'),
                placeHolder: localize('replyPlaceholder', 'Type your comment here...'),
            });
            if (!reply) return;
            const comment: Comment = {
                id: this.generateId(),
                message: reply,
                author: this.currentUser,
                timestamp: new Date().toISOString(),
            };
            annotation.thread = annotation.thread || [];
            annotation.thread.push(comment);
            await this.saveAnnotations();
            await this.refreshAnnotations();
            this.updateAnnotationsPanel();
        } catch (error) {
            this.handleError(localize('replyAnnotationError', 'Failed to reply to annotation'), error);
        }
    }

    private async clearAnnotations(): Promise<void> {
        try {
            const confirm = await vscode.window.showWarningMessage(
                localize('confirmClear', 'Are you sure you want to clear all annotations?'),
                localize('yes', 'Yes'),
                localize('no', 'No')
            );
            if (confirm !== localize('yes', 'Yes')) return;
            this.decorationTypes.forEach((d) => d.dispose());
            this.decorationTypes.clear();
            this.annotations.clear();
            await this.saveAnnotations();
            this.updateStatusBar();
            vscode.window.showInformationMessage(localize('annotationsCleared', 'All annotations cleared!'));
        } catch (error) {
            this.handleError(localize('clearAnnotationsError', 'Failed to clear annotations'), error);
        }
    }

    private getActiveEditor(): vscode.TextEditor | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage(localize('noActiveEditor', 'No active editor!'));
            return undefined;
        }
        return editor;
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }

    private getGutterIconPath(): vscode.Uri {
        return vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'comment.svg'));
    }

    private async promptAnnotationMessage(): Promise<string | undefined> {
        return vscode.window.showInputBox({
            prompt: localize('enterAnnotation', 'Enter annotation message'),
            placeHolder: localize('annotationPlaceholder', 'Type your comment here...'),
            validateInput: (text) =>
                text.trim().length === 0 ? localize('emptyMessageError', 'Message cannot be empty') : null,
        });
    }

    private updateStatusBar(): void {
        if (!this.annotationsEnabled) {
            this.statusBarItem.text = localize('annotationsOff', 'Annotations: Off');
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                this.statusBarItem.hide();
                return;
            }
            const fileAnnotations = Array.from(this.annotations.values())
                .filter((a) => this.annotationMatchesDocument(a, editor.document))
                .filter((a) => this.shouldAnnotationBeVisible(a));
            this.statusBarItem.text = localize(
                'annotationsCount',
                '$(comment) {0} annotation{1}',
                fileAnnotations.length,
                fileAnnotations.length !== 1 ? 's' : ''
            );
            this.statusBarItem.tooltip = localize('viewAnnotations', 'Click to view annotations');
            this.statusBarItem.command = 'annotations.show';
        }
        this.statusBarItem.show();
    }

    private normalizePath(filePath: string): string {
        if (typeof filePath !== 'string') {
            return filePath;
        }
        return path.normalize(filePath).replace(/\\/g, '/');
    }

    // disposeDecoration (improved)
    private disposeDecoration(annotationId: string): void {
        const decorationType = this.decorationTypes.get(annotationId);
        if (decorationType) {
            // First clear decorations from all editors
            const editors = vscode.window.visibleTextEditors;
            for (const editor of editors) {
                editor.setDecorations(decorationType, []);
            }

            decorationType.dispose();
            this.decorationTypes.delete(annotationId);
        }
    }

    public handleError(message: string, error: unknown): void {
        const errorMessage = `${message}: ${error instanceof Error ? error.message : String(error)}`;
        const fullError = error instanceof Error ? error.stack || error.message : String(error);

        // Log to output channel
        this.log(`ERROR: ${message}`);
        this.log(`Details: ${fullError}`);

        // Also log to console for debugging
        console.error(`${message}:`, error);

        // Show error message to user
        vscode.window.showErrorMessage(errorMessage);
    }

    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    private clearDecorations(editor: vscode.TextEditor): void {
        // Remove decorations only for annotations that belong to this exact document.
        const decorationsToRemove: string[] = [];

        for (const [annotationId, decorationType] of this.decorationTypes) {
            const annotation = this.annotations.get(annotationId);
            if (annotation && this.annotationMatchesDocument(annotation, editor.document)) {
                editor.setDecorations(decorationType, []); // Clear decorations for this editor
                decorationType.dispose();
                decorationsToRemove.push(annotationId);
            }
        }

        // Remove decorations from the map
        decorationsToRemove.forEach((id) => this.decorationTypes.delete(id));
    }

    private loadConfiguration() {
        this.configManager.updateConfiguration();
    }

    private async handleConfigurationChange(event: vscode.ConfigurationChangeEvent): Promise<void> {
        if (event.affectsConfiguration('annotation')) {
            this.loadConfiguration();
            this.annotationsEnabled = this.config.enableAnnotations === true;
            await this.refreshAnnotations();
            this.updateStatusBar();
            vscode.window.showInformationMessage(
                localize('configurationUpdated', 'Annotation settings have been updated.')
            );
        }
    }

    public toggleAnnotationsDisplay(): void {
        this.annotationsEnabled = !this.annotationsEnabled;

        // Persist state in globalState
        this.context.globalState.update('annotationsEnabled', this.annotationsEnabled);

        if (this.annotationsEnabled) {
            vscode.window.showInformationMessage('Annotations enabled');
            this.registerCodeLensProvider();

            // Use setTimeout to ensure state is fully set before reading
            setTimeout(() => {
                this.refreshAnnotations();
            }, 50);
        } else {
            vscode.window.showInformationMessage('Annotations disabled');
            this.clearAllAnnotationsFromEditors(); // More targeted method
            this.unregisterCodeLensProvider();
        }
        this.updateStatusBar();
    }

    private clearAllAnnotationsFromEditors(): void {
        // Clear all decorations from all visible editors
        const editors = vscode.window.visibleTextEditors;
        for (const editor of editors) {
            this.clearDecorations(editor);
        }

        // Dispose all decorations restantes
        for (const decorationType of this.decorationTypes.values()) {
            decorationType.dispose();
        }
        this.decorationTypes.clear();

        // Update the panel
        this.updateAnnotationsPanel();
        this.statusBarItem.hide();
    }

    public initializeStatusBar(): void {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.updateStatusBar();
        this.statusBarItem.command = 'annotations.toggleDisplay';
        this.statusBarItem.show();
    }

    private registerCodeLensProvider(): void {
        // Lot 5 R2 worktree A: legacy registration is a no-op. The new
        // AnnotationCodeLensProvider takes (store, visibilityFilter) and is
        // wired by extension.ts directly. Constructing it from here would
        // subscribe to a null filter and throw — keeping the call alive
        // serves no purpose now that the new path exists.
    }

    private unregisterCodeLensProvider(): void {
        if (this.codeLensProviderDisposable) {
            this.codeLensProviderDisposable.dispose();
            this.codeLensProviderDisposable = null;
        }
    }

    public async resolveAnnotation(annotationId?: string): Promise<void> {
        try {
            if (!annotationId) {
                const editor = this.getActiveEditor();
                if (!editor) return;
                const line = editor.selection.active.line;
                const annotation = this.findAnnotation(editor.document.fileName, line);
                if (!annotation) {
                    vscode.window.showErrorMessage(
                        localize('noAnnotationResolve', 'No annotation found on this line.')
                    );
                    return;
                }
                annotationId = annotation.id;
            }
            const annotation = this.annotations.get(annotationId);
            if (!annotation) return;
            await this.deleteAnnotation(annotationId);
            vscode.window.showInformationMessage(localize('annotationResolved', 'Annotation resolved successfully!'));
        } catch (error) {
            this.handleError(localize('resolveAnnotationError', 'Failed to resolve annotation'), error);
        }
    }

    private getSeverityIcon(severity: string): string {
        switch (severity) {
            case 'error':
                return '❌';
            case 'warning':
                return '⚠️';
            case 'info':
            default:
                return 'ℹ️';
        }
    }
}
