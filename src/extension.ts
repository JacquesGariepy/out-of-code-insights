// Polyfill AbortController for environments that don't have it
import { AbortController } from 'node-abort-controller';
if (typeof globalThis.AbortController === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AbortController = AbortController;
}

import * as path from 'path';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { AnnotationManager } from './managers/AnnotationManager';
import type { Annotation, LinkedAnnotation } from './common/types';
import {
    AnnotationsTreeDataProvider,
    AnnotationsDragAndDropController,
    AnnotationTreeItem,
} from './tree/AnnotationsTree';
import { NavigationStackDataProvider } from './tree/NavigationStackTree';
import { KANBAN_HIDDEN_COLUMN_ID, KanbanView } from './views/KanbanView';
import { localize } from './common/localize';
import { LocalizationManager, loc } from './managers/LocalizationManager';
import { UserProfileManager } from './managers/UserProfileManager';
import { UnifiedAIAdapter } from './providers/UnifiedAIAdapter';
import { AIProfileManager } from './managers/AIProfileManager';
import { AnnotationManagerErrorHandling } from './managers/AnnotationManagerErrorHandling';
import { initializeLogger, getLogger } from './utils/logger';

// ── Lot 5 R2 — new transactional stack ─────────────────────────────────────
import { AnnotationStore } from './transactional/AnnotationStore';
import { AnnotationPersistence, DEFAULT_ANNOTATION_FILE_RELATIVE_PATH } from './transactional/AnnotationPersistence';
import { AnnotationSaveCoordinator } from './transactional/AnnotationSaveCoordinator';
import { AnnotationWriteFingerprintTracker } from './transactional/AnnotationWriteFingerprint';
import type { AnnotationStoreFileV2, AnnotationV2 } from './transactional/types';
import { VisibilityFilter } from './transactional/VisibilityFilter';
import { KanbanColumnStore } from './transactional/KanbanColumnStore';
import { AnnotationCodeLensProvider } from './providers/AnnotationCodeLensProvider';
import { AnnotationInlayHintsProvider } from './providers/AnnotationInlayHintsProvider';
import {
    AnnotationDocumentDropEditProvider,
    annotationDocumentDropMetadata,
} from './providers/AnnotationDocumentDropEditProvider';
import type { DocAnnotation } from './docs/AnnotationDocGenerator';
import {
    getBuiltInDocumentTemplate,
    isSupportedDocumentationLanguage,
    listBuiltInDocumentTemplates,
    normalizeDocumentationFormat,
    parseCustomDocumentTemplate,
    SUPPORTED_DOCUMENTATION_FORMATS,
    SUPPORTED_TECHNICAL_DOCUMENT_KINDS,
    type DocumentTemplateDefinition,
    type DocumentationFormat,
    type TechnicalDocumentKind,
} from './docs/DocumentTemplateCatalog';
import { writeDocumentationBundle } from './docs/WorkspaceDocumentationWriter';
import { generateDocumentationStudio } from './docs/DocumentationStudio';
import {
    parseOpenApiGenerationProfile,
    type OpenApiDiagnostic,
    type OpenApiGenerationProfile,
} from './docs/OpenApiDocumentation';
import { scanLineComments } from './comments/commentScanner';
import {
    encodeSourceComment,
    scanSourceComments,
    sourceCommentAnnotationIdFragment,
    sourceCommentAnnotationMarker,
    supportsSourceCommentEncoding,
    supportsSourceCommentLanguage,
    type SourceCommentEncodingStyle,
    type SourceCommentKind,
    type SourceCommentRecord,
} from './comments/sourceCommentCodec';
import { languageOfPath } from './comments/languageOfPath';
import { captureAnchor } from './anchoring/anchor';
import { TextBuffer } from './anchoring/textBuffer';
import { AnnotationMoveService, type MoveAnnotationsRequest } from './commands/AnnotationMoveService';
import { AnnotationEditorMoveController } from './commands/AnnotationEditorMoveController';
import { toFileUriString } from './common/fileUri';
import { MarkdownMessageEditor } from './views/MarkdownMessageEditor';
import { firstMessageLine, formatAnnotationLocation } from './views/markdownMessageEditorHelpers';
import { createDebounced } from './utils/debounce';
import { LicenseManager, getLicenseManager, requireEntitlement } from './pro/LicenseManager';
import { PRO_FEATURE_IDS, localizedFeatureName } from './pro/features';
import { AnnotationSyncService, SYNC_FEATURE_ID } from './sync/AnnotationSyncService';
import { AnnotationCommentsController } from './comments/AnnotationCommentsController';
import {
    AGENT_INSTRUCTION_FILES,
    buildAgentInstructionsBlock,
    upsertAgentInstructionsBlock,
} from './ai/agentInstructions';

let annotationManager: AnnotationManager | undefined;
let profileManager: UserProfileManager | undefined;
let aiAdapter: UnifiedAIAdapter | undefined;
let aiProfileManager: AIProfileManager | undefined;
let isInitialized = false;

// Lot 5 R2 — module-level handles for the new stack. Coexist with the legacy
// AnnotationManager during R2; R3 will retire the manager and these become the
// single source of truth.
let annotationStore: AnnotationStore | undefined;
let annotationPersistence: AnnotationPersistence | undefined;
let visibilityFilter: VisibilityFilter | undefined;
let kanbanColumnStore: KanbanColumnStore | undefined;
let annotationSyncService: AnnotationSyncService | undefined;
let annotationMoveService: AnnotationMoveService | undefined;
let annotationSaveCoordinator: AnnotationSaveCoordinator<AnnotationStoreFileV2> | undefined;
let selectedTreeAnnotationIds: string[] = [];
let selectedTreeAnnotationItems: AnnotationTreeItem[] = [];

/** Serialized generation tail: watch/manual requests never overwrite each other. */
let docsGenerationQueue: Promise<void> = Promise.resolve();

/** Quiet period between the last annotation change and a watch-mode regeneration. */
const DOCS_WATCH_DEBOUNCE_MS = 2000;

/**
 * One-shot toast guard for the docs-watch Pro gate: the first denied
 * watch-triggered regeneration shows the unlock toast, later denials only
 * log and skip. Reset as soon as the feature is entitled again.
 */
let docsWatchDenialNotified = false;

// `annotations.importCommentsWorkspace` scan bounds.
/** Include glob: every comment syntax the scanner knows how to read. */
const WORKSPACE_IMPORT_INCLUDE_GLOB =
    '**/*.{ts,tsx,js,jsx,py,rb,go,rs,java,c,cpp,h,cs,sh,ps1,sql,lua,yaml,yml,toml,html,vue,md}';
/** Exclude glob: dependency, VCS and build-output folders. */
const WORKSPACE_IMPORT_EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/coverage/**}';
/** Hard cap on the number of files visited per run. */
const WORKSPACE_IMPORT_MAX_FILES = 2000;
/** Files larger than this are skipped (likely generated/minified). */
const WORKSPACE_IMPORT_MAX_FILE_BYTES = 1024 * 1024;

// Pro licensing scaffold — fully free by default (no gated features, no
// license server configured). The module-level getter mirrors
// getAnnotationStore(); requireEntitlement() lives next to the manager.
let licenseManager: LicenseManager | undefined;

export { getLicenseManager, requireEntitlement } from './pro/LicenseManager';

/**
 * Lookup hook for the in-process AnnotationStore.
 *
 * Round 2 ergonomic export so worker-authored EDH integration tests
 * (`src/test/suite/lot5-runtime.integration.test.ts`) and the cross-worktree
 * consumer migrations can resolve the live store without owning a reference
 * via extension activation. Returns `undefined` before activation completes.
 */
export function getAnnotationStore(): AnnotationStore | undefined {
    return annotationStore;
}

export function getAnnotationPersistence(): AnnotationPersistence | undefined {
    return annotationPersistence;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const logger = initializeLogger('Out-of-Code Insights', context);
    context.subscriptions.push({ dispose: () => logger.dispose() });
    if (context.logUri) {
        logger.info('Log file', { path: logger.getLogFilePath() ?? context.logUri.fsPath });
    }

    const { version } = context.extension.packageJSON as { version: string };
    logger.info(`Activating extension v${version}`);

    LocalizationManager.getInstance(context);
    registerEssentialCommands(context);

    // Pro licensing scaffold. Constructed before the manager graph so the
    // enter-license command is available even if later activation steps
    // fail. With the default settings (empty licenseServerUrl, empty
    // gatedFeatures) this is inert: refresh() short-circuits and every
    // feature stays free.
    licenseManager = new LicenseManager(context);
    context.subscriptions.push(licenseManager);
    registerLicenseCommands(context);
    void licenseManager.refresh();

    try {
        logger.info('Creating managers');

        // ── Lot 5 R2: bootstrap the new transactional stack FIRST ────────
        // The store and its services own the v2 envelope on disk
        // (.out-of-code-insights/annotations.json, schema 2). The legacy
        // AnnotationManager (instantiated below) is kept for unmigrated
        // consumers (Tree, Kanban, AI adapter) but its disk I/O is stubbed
        // off so the two layers do not race for the same file during R2.
        await bootstrapTransactionalStack(context, logger);

        if (!annotationStore || !visibilityFilter) {
            throw new Error('Transactional stack not bootstrapped before manager and tree wiring');
        }
        const treeStore = annotationStore;

        annotationManager = new AnnotationManager(context, visibilityFilter, treeStore);
        // Stub the legacy disk paths during R2: the v2 envelope on disk is
        // owned by AnnotationStore now. Without this, AnnotationManager
        // would crash on the v2 shape and pop a "failed to load" toast.
        stubLegacyAnnotationManagerIO(annotationManager);

        profileManager = new UserProfileManager(context);
        aiProfileManager = new AIProfileManager(context);
        aiAdapter = new UnifiedAIAdapter(context, annotationManager, profileManager, aiProfileManager, treeStore);

        // Store-backed browsing and menus remain available without a workspace.
        // Move/drop services require persistence and are attached only when a
        // workspace-backed annotations file exists.
        if (annotationPersistence) {
            annotationMoveService = new AnnotationMoveService(treeStore, annotationPersistence);
            context.subscriptions.push(
                new AnnotationEditorMoveController(treeStore, annotationMoveService, {
                    visibilityFilter,
                    selectedIds: () => selectedTreeAnnotationIds,
                })
            );
            context.subscriptions.push(
                vscode.languages.registerDocumentDropEditProvider(
                    { scheme: 'file' },
                    new AnnotationDocumentDropEditProvider(annotationMoveService),
                    annotationDocumentDropMetadata
                )
            );
        }
        const treeDataProvider = new AnnotationsTreeDataProvider(treeStore, visibilityFilter);
        const view = vscode.window.createTreeView('annotationsView', {
            treeDataProvider,
            dragAndDropController: annotationPersistence ? new AnnotationsDragAndDropController() : undefined,
            canSelectMany: true,
        });
        const explorerView = vscode.window.createTreeView('annotationsExplorerView', {
            treeDataProvider,
            dragAndDropController: annotationPersistence ? new AnnotationsDragAndDropController() : undefined,
            canSelectMany: true,
        });
        const annotationViews = [view, explorerView] as const;
        const updateTreeChrome = (): void => {
            const stats = treeDataProvider.getStats();
            for (const annotationView of annotationViews) {
                annotationView.badge = stats.visible
                    ? {
                          value: stats.visible,
                          tooltip: loc(
                              'treeBadgeTooltip',
                              '{0} visible annotations across {1} files',
                              stats.visible,
                              stats.files
                          ),
                      }
                    : undefined;
                annotationView.description = stats.visible
                    ? loc('treeViewDescription', '{0} open · {1} resolved', stats.open, stats.resolved)
                    : undefined;
                annotationView.message =
                    stats.total === 0
                        ? loc('treeEmptyMessage', 'No annotations yet. Press Ctrl+Alt+A in an editor to create one.')
                        : stats.visible === 0
                          ? loc(
                                'treeFilteredEmptyMessage',
                                'Annotations exist, but the current visibility filters hide them.'
                            )
                          : stats.attention > 0
                            ? loc('treeAttentionMessage', '{0} annotations need attention.', stats.attention)
                            : undefined;
            }
        };
        context.subscriptions.push(treeDataProvider.onDidChangeTreeData(updateTreeChrome));
        const publishTreeSelection = (items: readonly vscode.TreeItem[]): void => {
            selectedTreeAnnotationItems = items.filter(
                (item): item is AnnotationTreeItem => item instanceof AnnotationTreeItem
            );
            selectedTreeAnnotationIds = selectedTreeAnnotationItems.map((item) => item.annotation.id);
            void vscode.commands.executeCommand(
                'setContext',
                'outOfCodeInsights.treeSelectionCount',
                selectedTreeAnnotationIds.length
            );
        };
        for (const annotationView of annotationViews) {
            context.subscriptions.push(
                annotationView.onDidChangeSelection((event) => {
                    publishTreeSelection(event.selection);
                })
            );
            context.subscriptions.push(
                annotationView.onDidChangeVisibility(({ visible }) => {
                    if (visible) {
                        publishTreeSelection(annotationView.selection);
                    }
                })
            );
            context.subscriptions.push(
                annotationView.onDidChangeCheckboxState((event) => {
                    const changes = event.items.filter(
                        (entry): entry is [AnnotationTreeItem, vscode.TreeItemCheckboxState] =>
                            entry[0] instanceof AnnotationTreeItem
                    );
                    if (changes.length === 0) {
                        return;
                    }
                    treeStore.beginTransaction();
                    try {
                        for (const [item, state] of changes) {
                            treeStore.update(item.annotation.id, {
                                resolved: state === vscode.TreeItemCheckboxState.Checked,
                            });
                        }
                        treeStore.commit();
                    } catch (error) {
                        treeStore.rollback();
                        getLogger().error('Unable to update annotation resolution from TreeView checkbox', error);
                        vscode.window.showErrorMessage(
                            loc('treeCheckboxUpdateFailed', 'Unable to update annotation state.')
                        );
                    }
                })
            );
        }
        updateTreeChrome();
        void vscode.commands.executeCommand('setContext', 'outOfCodeInsights.treeSelectionCount', 0);
        // Lot 5 R2: NavigationStackTree migrated to (store, navigationStack).
        const stackDataProvider = new NavigationStackDataProvider(annotationStore, annotationManager.navigationStack);
        const stackView = vscode.window.createTreeView('stackView', { treeDataProvider: stackDataProvider });
        const updateNavigationContexts = (): void => {
            void vscode.commands.executeCommand(
                'setContext',
                'outOfCodeInsights.navigationCanBack',
                annotationManager?.navigationStack.canGoBack() ?? false
            );
            void vscode.commands.executeCommand(
                'setContext',
                'outOfCodeInsights.navigationCanForward',
                annotationManager?.navigationStack.canGoForward() ?? false
            );
        };
        context.subscriptions.push(annotationManager.navigationStack.onDidChange(updateNavigationContexts));
        updateNavigationContexts();

        context.subscriptions.push(annotationManager);
        context.subscriptions.push(view);
        context.subscriptions.push(explorerView);
        context.subscriptions.push(stackView);
        context.subscriptions.push(profileManager);
        context.subscriptions.push(aiProfileManager);

        // Register AI profile management command
        context.subscriptions.push(
            vscode.commands.registerCommand('annotations.manageAIProfiles', async () => {
                if (aiProfileManager) {
                    await aiProfileManager.showProfileManager();
                }
            })
        );

        // Listen for configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async (e) => {
                if (
                    e.affectsConfiguration('annotation.provider') ||
                    e.affectsConfiguration('annotation.model') ||
                    e.affectsConfiguration('llm.apiKeys')
                ) {
                    // Refresh AI provider with new settings
                    if (aiAdapter) {
                        await aiAdapter.refreshProvider();
                    }
                }
            })
        );

        // Reload annotations when a workspace folder is opened or removed.
        // The extension can be activated without any folder open; in that
        // case loadAnnotations becomes a no-op until a folder appears.
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                if (annotationManager) {
                    await annotationManager.loadAnnotations();
                    await annotationManager.refreshAnnotations();
                }
            })
        );

        logger.info('Waiting for AnnotationManager initialization');
        await annotationManager.waitUntilInitialized();
        logger.info('AnnotationManager initialized');

        // Lot 5 R2 hot-fix: bridge AnnotationStore → legacy
        // AnnotationManager.annotations Map. Without this, the legacy
        // decoration pipeline (refreshAnnotations → createDecorationForAnnotation
        // → setDecorations) iterates an empty map (loadAnnotations is stubbed
        // by stubLegacyAnnotationManagerIO above), so no gutter icon, no line
        // highlight, and no inline annotation text are rendered even though
        // the v2 envelope on disk and the CodeLens provider both report the
        // annotation correctly. One-directional sync only.
        mirrorStoreToLegacyManager();
        if (annotationStore) {
            context.subscriptions.push(
                annotationStore.onDidChange(() => mirrorStoreToLegacyManager()),
                vscode.window.onDidChangeVisibleTextEditors(() => mirrorStoreToLegacyManager())
            );
        }

        // Lot 5 R2 hot-fix #2: now that the mirror is installed and the
        // manager.annotations Map mirrors the store, repurpose the legacy
        // saveAnnotations() stub to reconcile manager → store on every
        // mutation (modify/delete/reply/severity/tag/pin/move/resolve/...).
        // 29 sites in AnnotationManager.ts call saveAnnotations() after
        // touching the in-memory map, so this single chokepoint persists
        // every legacy mutation through the v2 store.
        // transitional bridge — remove when Option C migration completes
        installLegacySaveBridge();

        // Lot 5 R2: register the store-backed annotations.add / clearAll
        // commands. Done AFTER the legacy initialization so the registration
        // ordering is deterministic relative to context.subscriptions.
        registerStoreCommands(context);
        registerKanbanCommands(context);

        logger.info(`Extension v${version} activated successfully`);
        isInitialized = true;
        AnnotationManagerErrorHandling.setInitialized(true);

        const welcomed = context.globalState.get<boolean>('welcomeShown', false);
        if (!welcomed) {
            void context.globalState.update('welcomeShown', true);
            const exploreActions = localize('exploreActions', 'Explore All Actions');
            const openAnnotations = localize('openAnnotations', 'Open Annotations');
            const configureAi = localize('configureAi', 'Configure AI');
            void vscode.window
                .showInformationMessage(
                    localize(
                        'welcomeMessage',
                        'Out-of-Code Insights is ready. Right-click in a code editor or on an annotation for task-grouped menus, or explore every action now.'
                    ),
                    exploreActions,
                    openAnnotations,
                    configureAi
                )
                .then((selection) => {
                    if (selection === exploreActions) {
                        void vscode.commands.executeCommand('workbench.action.quickOpen', '>Out-of-Code Insights: ');
                    } else if (selection === openAnnotations) {
                        void vscode.commands.executeCommand('annotations.show');
                    } else if (selection === configureAi) {
                        void vscode.commands.executeCommand('annotations.updateApiKey');
                    }
                });
        }

        // ReviewModeManager is already created and managed by AnnotationManager

        // Register KanbanView commands
        const showKanbanCommand = vscode.commands.registerCommand('annotations.showKanban', async () => {
            try {
                if (!annotationStore || !kanbanColumnStore) {
                    vscode.window.showErrorMessage(
                        loc('kanbanError', 'Failed to show Kanban board') + ': Annotation store is not ready yet'
                    );
                    return;
                }
                // Lot 5 R2: Kanban now reads from AnnotationStore directly.
                const annotationsArray = annotationStore.list();
                getLogger().info(`Opening Kanban board with ${annotationsArray.length} annotations`);

                await KanbanView.createOrShow(context, annotationsArray, annotationStore, kanbanColumnStore);
            } catch (error) {
                annotationManager?.handleError(localize('kanbanError', 'Failed to show Kanban board'), error);
            }
        });

        context.subscriptions.push(showKanbanCommand);
    } catch (error) {
        logger.error('Extension activation failed', error);
        AnnotationManagerErrorHandling.setInitialized(false, error as Error);

        // Show user-friendly error with options
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window
            .showErrorMessage(
                localize('activationError', 'Failed to activate the annotation extension') + `: ${errorMessage}`,
                localize('viewDetails', 'View Details'),
                localize('retry', 'Retry')
            )
            .then((selection) => {
                if (selection === localize('viewDetails', 'View Details')) {
                    AnnotationManagerErrorHandling.showInitializationReport();
                } else if (selection === localize('retry', 'Retry')) {
                    // Reload the window to retry initialization
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });

        // Log to output channel if available
        annotationManager?.handleError(
            localize('activationError', 'Failed to activate the annotation extension'),
            error
        );
    }
}

/**
 * Register essential commands that should always be available, even if initialization fails
 */
function registerEssentialCommands(context: vscode.ExtensionContext): void {
    // Core annotation commands with error handling
    // Map command names to method names when they differ
    // Lot 5 R2: 'add' and 'clearAll' are NOT routed through AnnotationManager
    // anymore. They are registered separately by `registerStoreCommands`
    // after the transactional stack is bootstrapped.
    const commandMappings: { [key: string]: string } = {
        reply: 'replyToAnnotation',
        show: 'showAnnotationsPanel',
        delete: 'deleteAnnotationCommand',
        edit: 'editAnnotationCommand',
        toggleDisplay: 'toggleAnnotationsDisplay',
        navigate: 'navigateToAnnotation',
        exportJSON: 'exportAnnotationsJSON',
        importJSON: 'importAnnotationsJSON',
        pinToggle: 'togglePinAnnotation',
        setSeverity: 'setAnnotationSeverity',
        batchEdit: 'batchEditAnnotations',
        keywordSearch: 'keywordSearch',
        aiSuggest: 'aiSuggestAnnotation',
        moveUp: 'moveUpCommand',
        moveDown: 'moveDownCommand',
    };

    const AI_COMMANDS = new Set([
        'aiSuggest',
        'aiSuggestWithProfile',
        'aiAnalyzeFile',
        'aiBatchAnnotate',
        'aiAnalyzeFileWithProfile',
    ]);

    // Register each core command with error handling wrapper
    Object.entries(commandMappings).forEach(([command, methodName]) => {
        context.subscriptions.push(
            vscode.commands.registerCommand(`annotations.${command}`, async (...args: unknown[]) => {
                if (!isInitialized || !annotationManager) {
                    AnnotationManagerErrorHandling.createFallbackCommand(command)();
                    return;
                }

                if (AI_COMMANDS.has(command)) {
                    const configured = await annotationManager.ensureAiConfigured();
                    if (!configured) {
                        return;
                    }
                }

                // Try to execute the command
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const method = (annotationManager as any)[methodName];
                    if (typeof method === 'function') {
                        await method.apply(annotationManager, args);
                    } else {
                        vscode.window.showErrorMessage(
                            localize('commandNotImplemented', 'Command "{0}" is not implemented.', command)
                        );
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(
                        localize('commandExecutionError', 'Error executing command "{0}": {1}', command, errorMessage)
                    );
                }
            })
        );
    });

    // Special handling for settings and configuration commands
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'annotation');
        })
    );

    // Upsert the marked AI-agent instruction block into CLAUDE.md and
    // AGENTS.md at the workspace root. Idempotent: an existing block is
    // replaced in place, surrounding content is preserved.
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.setupAiInstructions', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage(
                    loc('noWorkspaceAiInstructions', 'Open a workspace to set up AI agent instructions.')
                );
                return;
            }
            try {
                const docsConfig = vscode.workspace.getConfiguration('annotation');
                const outputPath = docsConfig.get<string>('docs.outputPath', 'docs/annotations');
                const block = buildAgentInstructionsBlock(outputPath);
                for (const fileName of AGENT_INSTRUCTION_FILES) {
                    const uri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
                    let existing = '';
                    try {
                        existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                    } catch {
                        // File absent — it will be created below.
                    }
                    const next = upsertAgentInstructionsBlock(existing, block);
                    if (next !== existing) {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
                    }
                }
                void vscode.window.showInformationMessage(
                    loc(
                        'aiInstructionsUpserted',
                        'AI agent instructions updated in {0}.',
                        AGENT_INSTRUCTION_FILES.join(', ')
                    )
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    loc('aiInstructionsFailed', 'Failed to set up AI agent instructions') + `: ${message}`
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.showInitializationReport', () => {
            AnnotationManagerErrorHandling.showInitializationReport();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.retryInitialization', () => {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('outOfCodeInsights.showLogs', async () => {
            const logFilePath = getLogger().getLogFilePath();
            const items: vscode.QuickPickItem[] = [
                { label: '$(output) Show Output Channel', description: 'Focus the VS Code output panel' },
                ...(logFilePath
                    ? [
                          { label: '$(file-text) Open Log File', description: logFilePath },
                          {
                              label: '$(folder-opened) Reveal Log Folder',
                              description: vscode.Uri.file(logFilePath).fsPath.replace(/[^\\/]+$/, ''),
                          },
                      ]
                    : []),
            ];
            const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Out-of-Code Insights Logs' });
            if (!selected) {
                return;
            }
            if (selected.label.includes('Output Channel')) {
                getLogger().show();
            } else if (selected.label.includes('Open Log File') && logFilePath) {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(logFilePath));
            } else if (selected.label.includes('Reveal Log Folder') && logFilePath) {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logFilePath));
            }
        })
    );
}

/**
 * Register the `annotations.enterLicenseKey` command: input box → store the
 * key in SecretStorage → validate against the configured license server →
 * toast with the result. With the default empty
 * `annotation.pro.licenseServerUrl` the key is stored and validation is
 * deferred until a server is configured.
 */
function registerLicenseCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.enterLicenseKey', async () => {
            if (!licenseManager) {
                return;
            }
            const entered = await vscode.window.showInputBox({
                prompt: loc('enterLicenseKeyPrompt', 'Enter your Out-of-Code Insights license key'),
                placeHolder: loc('licenseKeyPlaceholder', 'XXXX-XXXX-XXXX-XXXX'),
                password: true,
                ignoreFocusOut: true,
                validateInput: (text) =>
                    text.trim().length === 0 ? loc('licenseKeyEmpty', 'License key cannot be empty') : null,
            });
            if (!entered) {
                return;
            }
            const key = entered.trim();
            await licenseManager.storeLicenseKey(key);
            try {
                const result = await licenseManager.validate(key);
                if (result.skipped) {
                    vscode.window.showInformationMessage(
                        loc(
                            'licenseServerNotConfigured',
                            'License key stored. It will be validated once a license server is configured (annotation.pro.licenseServerUrl).'
                        )
                    );
                } else if (result.valid) {
                    vscode.window.showInformationMessage(
                        loc(
                            'licenseValid',
                            'License key validated — {0} Pro feature(s) unlocked.',
                            result.entitlements.length
                        )
                    );
                } else {
                    vscode.window.showWarningMessage(
                        loc('licenseInvalid', 'License key could not be validated. Pro features remain locked.')
                    );
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(
                    loc('licenseValidationFailed', 'License validation failed') + `: ${msg}`
                );
            }
        })
    );
}

export async function deactivate(): Promise<void> {
    const saveCoordinator = annotationSaveCoordinator;
    annotationSaveCoordinator = undefined;
    if (saveCoordinator) {
        try {
            await saveCoordinator.flush();
        } catch (error) {
            // The coordinator already logged and surfaced the failure. Keep
            // teardown moving so the extension host can close cleanly.
            console.error('Final annotation save failed during deactivation', error);
        }
        saveCoordinator.dispose();
    }
    if (licenseManager) {
        licenseManager.dispose();
        licenseManager = undefined;
    }
    if (annotationManager) {
        annotationManager.dispose();
        annotationManager = undefined;
    }
    if (profileManager) {
        profileManager.dispose();
        profileManager = undefined;
    }
    if (aiAdapter) {
        aiAdapter.dispose();
        aiAdapter = undefined;
    }
    if (aiProfileManager) {
        aiProfileManager.dispose();
        aiProfileManager = undefined;
    }
    if (annotationSyncService) {
        annotationSyncService.dispose();
        annotationSyncService = undefined;
    }
    if (annotationStore) {
        annotationStore.dispose();
        annotationStore = undefined;
    }
    if (annotationPersistence) {
        annotationPersistence.dispose();
        annotationPersistence = undefined;
    }
    if (visibilityFilter) {
        visibilityFilter.dispose();
        visibilityFilter = undefined;
    }
    if (kanbanColumnStore) {
        kanbanColumnStore.dispose();
        kanbanColumnStore = undefined;
    }
    isInitialized = false;
}

// ───────────────────────────────────────────────────────────────────────────
// Lot 5 R2 — transactional stack bootstrap and command wiring
// ───────────────────────────────────────────────────────────────────────────

interface ActivationLogger {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
}

/**
 * Build the new AnnotationStore + 4 services and wire them into the editor:
 *  - load v2 envelope from disk (or start empty), deserialize into the store.
 *  - subscribe `vscode.workspace.onDidChangeTextDocument` →
 *    `store.applyDocumentChange(event, relativeFilePath)`.
 *  - subscribe `store.onDidChange` → `persistence.save(...)` (debounced 500ms).
 *  - register all subscriptions on `context.subscriptions`.
 */
/**
 * `annotation.cutRecoveryWindowSeconds`, clamped to [5, 600], in ms. This is
 * how long a cut/deleted annotation waits in the suspended buffer for its
 * content to be pasted back before the keep-or-delete prompt fires.
 */
function readCutRecoveryWindowMs(): number {
    const seconds = vscode.workspace.getConfiguration('annotation').get<number>('cutRecoveryWindowSeconds', 30);
    return Math.min(600, Math.max(5, seconds)) * 1000;
}

function configuredAnnotationPath(workspaceFolder: vscode.WorkspaceFolder): string {
    const configured = vscode.workspace
        .getConfiguration('annotation')
        .get<string>('path', DEFAULT_ANNOTATION_FILE_RELATIVE_PATH)
        .trim();
    let candidate = configured || DEFAULT_ANNOTATION_FILE_RELATIVE_PATH;
    if (path.isAbsolute(candidate)) {
        const relative = path.relative(workspaceFolder.uri.fsPath, candidate);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(loc('annotationPathOutsideWorkspace', 'Annotation path must stay inside the workspace.'));
        }
        candidate = relative;
    }
    if (path.extname(candidate).toLowerCase() !== '.json') {
        candidate = path.join(candidate, 'annotations.json');
    }
    return candidate;
}

async function bootstrapTransactionalStack(context: vscode.ExtensionContext, logger: ActivationLogger): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    annotationStore = new AnnotationStore({ suspendTtlMs: readCutRecoveryWindowMs() });

    if (workspaceFolder) {
        annotationPersistence = new AnnotationPersistence(workspaceFolder, configuredAnnotationPath(workspaceFolder));
        try {
            const payload = await annotationPersistence.load();
            annotationStore.deserialize(payload);
            logger.info(`AnnotationStore: loaded ${String(payload.annotations.length)} annotation(s) from v2 envelope`);
        } catch (err) {
            // Bad/missing/legacy envelope: start empty so the runtime stays
            // usable. The legacy AnnotationManager (which historically owned
            // this file) would emit a toast here; we log silently because
            // R2 transition explicitly tolerates a one-time format upgrade.
            logger.warn('AnnotationStore: starting empty (v2 load failed or absent)', err);
            annotationStore.markInitialized();
        }
    } else {
        // No workspace open → no persistence to attach. Initialise eagerly so
        // `waitUntilInitialized()` resolves and consumers stop hanging.
        annotationStore.markInitialized();
    }

    visibilityFilter = new VisibilityFilter(() => {
        const cfg = vscode.workspace.getConfiguration('annotation');
        return {
            enableAnnotations: cfg.get<boolean>('enableAnnotations', true),
            disabledTags: cfg.get<string[]>('disabledTags', []),
            currentFilter: 'all',
        };
    });

    kanbanColumnStore = new KanbanColumnStore(context.workspaceState);

    // Wire onDidChangeTextDocument → store.applyDocumentChange.
    //
    // applyDocumentChange mutates `startOffset`/`endOffset` in place when an
    // edit shifts an annotation (Cas A/B/C) but does NOT fire `onDidChange`
    // for those silent offset rewrites — listeners registering on the store
    // never see them. We trigger `notifyChanged()` manually post-shift so the
    // debounced persistence flush picks up the new offsets and writes them
    // to disk.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (!annotationStore) {
                return;
            }
            try {
                annotationStore.applyDocumentChange(event, vscode.workspace.asRelativePath(event.document.uri));
                annotationStore.notifyChanged();
            } catch (err) {
                logger.error('applyDocumentChange threw', err);
            }
        })
    );

    // Wire store.onDidChange → debounced persistence.save (100 ms).
    // The configured delay coalesces mutation bursts. The coordinator keeps
    // writes serialized and exposes a flush barrier used by deactivate().
    const writeFingerprints = new AnnotationWriteFingerprintTracker();
    if (annotationPersistence) {
        const store = annotationStore;
        const persistence = annotationPersistence;
        const coordinator = new AnnotationSaveCoordinator<AnnotationStoreFileV2>(
            () => store.serialize(),
            async (payload) => {
                const fingerprint = writeFingerprints.begin(payload);
                try {
                    await persistence.save(payload);
                    writeFingerprints.commit(fingerprint);
                } catch (error) {
                    writeFingerprints.fail(fingerprint);
                    throw error;
                }
            },
            100,
            () => undefined,
            (error) => {
                logger.error('AnnotationPersistence.save failed', error);
                const retryLabel = loc('retryAnnotationSave', 'Retry save');
                void vscode.window
                    .showErrorMessage(
                        loc(
                            'annotationSaveFailedDirty',
                            'Annotations could not be saved. Changes remain in memory and will be retried.'
                        ),
                        retryLabel
                    )
                    .then((choice) => {
                        if (choice === retryLabel) {
                            void annotationSaveCoordinator?.flush().catch(() => undefined);
                        }
                    });
            }
        );
        annotationSaveCoordinator = coordinator;
        context.subscriptions.push(
            store.onDidChange(() => coordinator.schedule()),
            coordinator
        );
    }

    // Live external-change watcher: the MCP server (or any other tool)
    // writes the same annotations.json. Reload the store when the file
    // changes on disk — unless its canonical content fingerprint matches an
    // in-flight or the latest successful extension-owned save. This exact
    // correlation handles delayed watcher echoes without hiding a distinct
    // external edit. Reloading replaces the in-memory state wholesale
    // (journal/undo mirroring resets), which is the documented contract for
    // external edits.
    if (annotationPersistence && workspaceFolder) {
        const persistence = annotationPersistence;
        const watchedFolder = workspaceFolder;
        const relativeAnnotationsPath = path
            .relative(watchedFolder.uri.fsPath, persistence.getPath())
            .split(path.sep)
            .join('/');
        const externalReload = async (): Promise<void> => {
            if (!annotationStore) {
                return;
            }
            if (!vscode.workspace.getConfiguration('annotation').get<boolean>('watchExternalChanges', true)) {
                return;
            }
            try {
                const payload = await persistence.load();
                if (writeFingerprints.isInternalEcho(payload)) {
                    return;
                }
                annotationStore.deserialize(payload);
                writeFingerprints.observeExternal(payload);
                annotationStore.notifyChanged();
                logger.info(
                    `annotations.json changed externally — reloaded ${String(payload.annotations.length)} annotation(s)`
                );
            } catch (err) {
                logger.warn('external annotations.json change could not be loaded', err);
            }
        };
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(watchedFolder, relativeAnnotationsPath)
        );
        watcher.onDidChange(() => void externalReload());
        watcher.onDidCreate(() => void externalReload());
        context.subscriptions.push(watcher);
    }

    // Follow the user's cut-recovery-window setting live.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('annotation.cutRecoveryWindowSeconds') && annotationStore) {
                annotationStore.updateSuspendTtl(readCutRecoveryWindowMs());
            }
        })
    );

    // Re-anchor annotations whose file changed outside the editor's edit
    // stream (git pull / branch switch / external tools) when the document
    // (re)opens. Also sweep documents already open at activation.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (annotationStore) {
                const moved = annotationStore.reanchorDocument(document);
                if (moved > 0) {
                    logger.info(
                        `reanchorDocument: relocated ${String(moved)} annotation(s) in ${document.uri.toString()}`
                    );
                }
            }
        })
    );
    for (const document of vscode.workspace.textDocuments) {
        annotationStore.reanchorDocument(document);
    }

    // File lifecycle — owned by the store (legacy handlers are disabled via
    // lifecycleDelegatedToStore).
    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles(async (event) => {
            if (!annotationStore) {
                return;
            }
            let renamed = 0;
            for (const file of event.files) {
                renamed += annotationStore.applyFileRename(
                    file.oldUri.toString(),
                    file.newUri.toString(),
                    vscode.workspace.asRelativePath(file.newUri)
                );
            }
            if (renamed > 0) {
                await awaitAnnotationSaveBarrier();
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles(async (event) => {
            if (!annotationStore) {
                return;
            }
            for (const file of event.files) {
                const uriStr = file.toString();
                const folderPrefix = uriStr.endsWith('/') ? uriStr : uriStr + '/';
                // serialize() is the only view that includes suspended
                // entries; a deleted path may be a folder, so match by
                // exact uri OR prefix.
                const affected = annotationStore
                    .serialize()
                    .annotations.filter((a) => a.fileUri === uriStr || a.fileUri.startsWith(folderPrefix));
                if (affected.length === 0) {
                    continue;
                }
                const keepLabel = loc('keepAnnotations', 'Keep annotations');
                const deleteLabel = loc('deleteAnnotations', 'Delete annotations');
                const choice = await vscode.window.showWarningMessage(
                    loc(
                        'fileDeletedWithAnnotations',
                        '{0} annotation(s) reference the deleted file "{1}". Keep them?',
                        affected.length,
                        vscode.workspace.asRelativePath(file)
                    ),
                    keepLabel,
                    deleteLabel
                );
                if (choice === deleteLabel && annotationStore) {
                    annotationStore.beginTransaction();
                    try {
                        for (const a of affected) {
                            annotationStore.remove(a.id);
                        }
                        annotationStore.commit();
                        await awaitAnnotationSaveBarrier();
                    } catch (err) {
                        annotationStore.rollback();
                        getLogger().error('delete-file annotation cleanup failed', err);
                    }
                }
                // Keep (or dismissed): annotations stay in the store and
                // the panel/tree; they render as orphaned references.
            }
        })
    );

    // Never silently lose user data: when annotated code is deleted and not
    // pasted back within the suspend TTL, the store disposes the suspended
    // entry (it stops being serialized). Surface a non-modal choice so the
    // dev decides — restore the annotation (it stays in the panel/tree, shown
    // as orphaned until it is re-attached or deleted) or confirm the removal.
    context.subscriptions.push(
        annotationStore.onDidDispose(({ annotation, reason }) => {
            if (reason !== 'ttl-expired' || !annotationStore) {
                return;
            }
            const keepLabel = loc('keepOrphanedAnnotation', 'Keep annotation');
            const discardLabel = loc('discardAnnotation', 'Delete');
            void vscode.window
                .showWarningMessage(
                    loc(
                        'annotatedCodeDeleted',
                        'The code for annotation "{0}" was deleted. Keep the annotation?',
                        annotation.message.substring(0, 40)
                    ),
                    keepLabel,
                    discardLabel
                )
                .then((choice) => {
                    if (choice === keepLabel && annotationStore && !annotationStore.get(annotation.id)) {
                        annotationStore.upsert({ ...annotation, state: 'active' });
                    }
                });
        })
    );

    context.subscriptions.push(annotationStore, visibilityFilter, kanbanColumnStore);
    if (annotationPersistence) {
        context.subscriptions.push(annotationPersistence);
    }

    // ── Cloud annotation sync ───────────────────────────────────────────
    // Constructed only when a workspace folder (and therefore persistence)
    // exists: the client pulls into / pushes from the same v2 envelope. The
    // service stays inert (hidden status bar item, no network) while
    // `annotation.sync.serverUrl` is empty. `start()` performs the one-time
    // activation pull when `annotation.sync.auto` is enabled.
    if (annotationStore && annotationPersistence) {
        annotationSyncService = new AnnotationSyncService(context, annotationStore, annotationPersistence);
        context.subscriptions.push(annotationSyncService);
        annotationSyncService.start().catch((err: unknown) => {
            logger.error('AnnotationSyncService.start failed', err);
        });
    }

    // ── CodeLens provider ───────────────────────────────────────────────
    // Lot 5 R2 finalisation: the migrated AnnotationCodeLensProvider takes
    // (store, visibilityFilter) and refreshes itself off store.onDidChange.
    // Register it against `{ scheme: 'file' }` so VS Code calls it for every
    // text editor; the provider gates rendering by file matching.
    const codeLensProvider = new AnnotationCodeLensProvider(annotationStore, visibilityFilter);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
        codeLensProvider
    );

    // Interactive inline annotations. Inlay hint label parts are one of the
    // few stable VS Code editor surfaces that can invoke extension commands,
    // so the message opens the panel and the adjacent move handle starts the
    // native pick-up/drop workflow.
    const inlayHintsProvider = new AnnotationInlayHintsProvider(annotationStore, visibilityFilter);
    context.subscriptions.push(
        vscode.languages.registerInlayHintsProvider({ scheme: 'file' }, inlayHintsProvider),
        inlayHintsProvider
    );

    // ── Comments API controller ─────────────────────────────────────────
    // Renders annotations as native editor comment threads. Gated by
    // `annotation.commentsView`; the setting is read once at activation
    // (documented in its description — changes apply on the next reload).
    if (vscode.workspace.getConfiguration('annotation').get<boolean>('commentsView', true)) {
        context.subscriptions.push(new AnnotationCommentsController(annotationStore, awaitAnnotationSaveBarrier));
    }
}

/**
 * Replace AnnotationManager.loadAnnotations and saveAnnotations with no-ops
 * so the legacy manager does not crash on the v2 envelope and does not
 * re-write a flat-array file alongside the new schema-v2 one. The manager
 * keeps its in-memory map (empty) and continues to serve unmigrated
 * consumers (Tree, Kanban, AI adapter) until R3 retires it.
 */
function stubLegacyAnnotationManagerIO(manager: AnnotationManager): void {
    interface Stubbable {
        loadAnnotations: () => Promise<void>;
        saveAnnotations: () => Promise<void>;
    }
    const m = manager as unknown as Stubbable;
    m.loadAnnotations = async () => {
        // intentional R2 no-op — AnnotationStore owns disk.
    };
    m.saveAnnotations = async () => {
        // intentional R2 no-op — AnnotationStore owns disk.
    };
    // AnnotationStore owns the rest of the lifecycle too: document-change
    // tracking (the legacy line-based tracker fired on the SAME event AFTER
    // the store and the mirror, double-shifting lines that the bridge then
    // persisted), open-time re-anchoring, file rename, and file delete
    // (which the legacy handler performed as a SILENT annotation purge —
    // replaced by a store-side prompt).
    manager.lifecycleDelegatedToStore = true;
}

/**
 * Project the v2 AnnotationStore contents into the legacy
 * AnnotationManager.annotations Map so the manager's decoration rendering
 * (gutter icons, line highlights, inline message text) can find the data.
 *
 * V2 anchors via startOffset; V1 expects `line`. We resolve `line` against
 * the open document set; closed-file annotations get line=0 (the manager
 * filters them out per-editor via annotationMatchesDocument so the bogus
 * line is never rendered against the wrong file).
 *
 * Sync is one-directional (store → manager). Mutations made through the
 * legacy command surface (delete/edit/move) are not propagated back to the
 * store -- that is tracked separately as a Lot 5 R2 follow-up because the
 * legacy command surface itself is on the R3 retirement list.
 */
/**
 * Replace the no-op `saveAnnotations` stub installed by
 * `stubLegacyAnnotationManagerIO` with a reconciliation that pushes the
 * current state of `manager.annotations` into the v2 store. Every legacy
 * mutation path (`modifyAnnotation` :5247, `deleteAnnotation` :5265,
 * `replyToAnnotation` :5292, `changeSeverity` :1944, `editAnnotationTags`,
 * `togglePinAnnotation`, `setAnnotationSeverity`, `resolveAnnotation`, etc.)
 * already calls `await this.saveAnnotations()` after touching the map, so
 * patching this single chokepoint persists every mutation through v2.
 *
 * MUST be called AFTER `mirrorStoreToLegacyManager()` runs once. Calling
 * earlier would reconcile an empty manager Map against a populated store
 * and remove every annotation. The init flow at AnnotationManager.ts:220
 * ALSO calls saveAnnotations during startup — that call still happens
 * against the no-op stub installed by stubLegacyAnnotationManagerIO, by
 * design.
 *
 * transitional bridge — remove when Option C migration completes
 */
function installLegacySaveBridge(): void {
    if (!annotationManager) {
        return;
    }
    interface Stubbable {
        saveAnnotations: () => Promise<void>;
    }
    (annotationManager as unknown as Stubbable).saveAnnotations = async () => {
        reconcileLegacyToStore();
        await awaitAnnotationSaveBarrier();
    };
}

/**
 * Wait for the debounced persistence write scheduled by the current mutation.
 *
 * Public commands are awaitable contracts: once they resolve, a caller may
 * immediately read, replace or remove the workspace envelope. Leaving the
 * write queued created a real race where a later command (or an external
 * tool) could delete the previous destination while its atomic rename was
 * still being verified. The coordinator already reports failures and keeps
 * the snapshot dirty for retry, so this barrier deliberately preserves the
 * in-memory change when a write fails.
 */
async function awaitAnnotationSaveBarrier(): Promise<void> {
    try {
        await annotationSaveCoordinator?.flush();
    } catch {
        // AnnotationSaveCoordinator invokes the shared error handler and keeps
        // the latest snapshot dirty. Do not misreport an accepted in-memory
        // mutation as rejected merely because its durable retry is pending.
    }
}

/**
 * Reverse-direction sync: push `manager.annotations` into `store` via a
 * single transaction. Diffs by id only — orphan ids in the store (present
 * there but absent from the manager) are removed; all other ids are
 * upserted with their current legacy fields. The transaction batches
 * everything into ONE `onDidChange` event so the mirror back-patch fires
 * exactly once per save.
 *
 * V1 → V2 projection rules:
 *  - `startOffset`/`endOffset` preserved from the existing V2 entry when
 *    the line is unchanged (typical case for message/severity/tags
 *    edits). Recomputed via `document.lineAt(line)` only when the line
 *    changed AND the document is open.
 *  - `origin` preserved from the existing V2 entry, defaults to
 *    `{kind:'manual'}` for legacy-only annotations.
 *  - `lineHash`/`contextBefore`/`contextAfter` taken from V1 directly
 *    (legacy keeps these in sync via captureAnchor on its own paths).
 *  - `fileUri` MUST be set on every legacy annotation that came from the
 *    mirror (we always populate it). Annotations created via legacy
 *    `addAnnotation` without `fileUri` are skipped with a logged warning
 *    so the upsert validation never throws inside saveAnnotations().
 */
function reconcileLegacyToStore(): void {
    if (!annotationStore || !annotationManager) {
        return;
    }
    const liveIds = new Set<string>();
    for (const v1 of annotationManager.annotations.values()) {
        liveIds.add(v1.id);
    }
    const orphanIds: string[] = [];
    for (const v2 of annotationStore.list()) {
        if (!liveIds.has(v2.id)) {
            orphanIds.push(v2.id);
        }
    }
    const openDocs = vscode.workspace.textDocuments;

    annotationStore.beginTransaction();
    try {
        for (const v1 of annotationManager.annotations.values()) {
            if (!v1.fileUri) {
                getLogger().warn(`reconcileLegacyToStore: skipping annotation ${v1.id} — missing fileUri`);
                continue;
            }
            const existing = annotationStore.get(v1.id);
            const doc = openDocs.find((d) => d.uri.toString() === v1.fileUri);
            let startOffset = existing?.startOffset ?? 0;
            let endOffset = existing?.endOffset ?? 0;
            if (doc) {
                const existingLine = existing ? doc.positionAt(existing.startOffset).line : null;
                if (existingLine === null || existingLine !== v1.line) {
                    if (v1.line >= 0 && v1.line < doc.lineCount) {
                        const lineRange = doc.lineAt(v1.line).range;
                        startOffset = doc.offsetAt(lineRange.start);
                        endOffset = startOffset + doc.lineAt(v1.line).text.length;
                    }
                }
            }
            annotationStore.upsert({
                id: v1.id,
                fileUri: v1.fileUri,
                file: v1.file,
                startOffset,
                endOffset,
                lineHash: v1.lineHash ?? '',
                contextBefore: v1.contextBefore ?? [],
                contextAfter: v1.contextAfter ?? [],
                origin: existing?.origin ?? { kind: 'manual' },
                message: v1.message,
                author: v1.author,
                timestamp: v1.timestamp,
                thread: v1.thread,
                tags: v1.tags,
                pinned: v1.pinned,
                priority: v1.priority,
                severity: v1.severity,
                resolved: v1.resolved,
                linkedAnnotations: v1.linkedAnnotations,
                template: v1.template,
                reviewState: v1.reviewState,
                kanbanColumn: v1.kanbanColumn,
                snippet: v1.snippet,
                languageId: v1.languageId,
            });
        }
        for (const id of orphanIds) {
            annotationStore.remove(id);
        }
        annotationStore.commit();
    } catch (err) {
        annotationStore.rollback();
        getLogger().error('reconcileLegacyToStore: rollback after error', err);
    }
}

function mirrorStoreToLegacyManager(): void {
    if (!annotationStore || !annotationManager) {
        return;
    }
    const openDocs = vscode.workspace.textDocuments;
    annotationManager.annotations.clear();
    for (const v2 of annotationStore.list()) {
        const doc = openDocs.find((d) => d.uri.toString() === v2.fileUri);
        const line = doc ? doc.positionAt(v2.startOffset).line : 0;
        const projected: Annotation = {
            id: v2.id,
            file: v2.file,
            line,
            message: v2.message,
            author: v2.author,
            timestamp: v2.timestamp,
            thread: v2.thread,
            tags: v2.tags,
            pinned: v2.pinned,
            priority: v2.priority,
            severity: v2.severity,
            resolved: v2.resolved,
            linkedAnnotations: v2.linkedAnnotations,
            template: v2.template,
            reviewState: v2.reviewState,
            kanbanColumn: v2.kanbanColumn,
            snippet: v2.snippet,
            lineHash: v2.lineHash,
            contextBefore: v2.contextBefore,
            contextAfter: v2.contextAfter,
            fileUri: v2.fileUri,
            languageId: v2.languageId,
        };
        annotationManager.annotations.set(v2.id, projected);
    }
    void annotationManager.refreshAnnotations();
}

/**
 * Register the store-backed `annotations.add` and `annotations.clearAll`
 * commands. The legacy dispatcher (`registerEssentialCommands`) deliberately
 * skips these two ids so this function can claim them without conflict.
 */
function registerStoreCommands(context: vscode.ExtensionContext): void {
    registerStoreLinkCommands(context);

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'annotations.add',
            async (args?: {
                line?: number;
                offset?: number;
                message?: string;
                tags?: string[];
            }): Promise<string | undefined> => {
                if (!annotationStore) {
                    vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                    return undefined;
                }
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage(localize('noActiveEditor', 'No active editor found.'));
                    return undefined;
                }
                if (
                    editor.document.uri.scheme !== 'file' ||
                    vscode.workspace.getWorkspaceFolder(editor.document.uri) === undefined
                ) {
                    vscode.window.showWarningMessage(
                        loc(
                            'annotationSavedFileRequired',
                            'Open a saved file inside the workspace before adding an annotation.'
                        )
                    );
                    return undefined;
                }
                const message =
                    args?.message ??
                    (await vscode.window.showInputBox({
                        prompt: localize('enterAnnotation', 'Enter annotation message'),
                        placeHolder: localize('annotationPlaceholder', 'Type your comment here...'),
                        validateInput: (text) =>
                            text.trim().length === 0 ? localize('emptyMessageError', 'Message cannot be empty') : null,
                    }));
                if (!message) {
                    return undefined;
                }
                const document = editor.document;
                const fileUri = document.uri.toString();
                const file = vscode.workspace.asRelativePath(document.uri);
                const annotationConfig = vscode.workspace.getConfiguration('annotation');
                const maxPerFile = annotationConfig.get<number>('maxAnnotationsPerFile', 1000);
                if (maxPerFile > 0 && annotationStore.listForFile(fileUri).length >= maxPerFile) {
                    vscode.window.showWarningMessage(
                        loc('maxAnnotationsReached', 'This file has reached its limit of {0} annotations.', maxPerFile)
                    );
                    return undefined;
                }
                const draft = {
                    fileUri,
                    file,
                    origin: { kind: 'manual' } as const,
                    message,
                    author: annotationConfig.get<string>('username', 'Anonymous').trim() || 'Anonymous',
                    timestamp: new Date().toISOString(),
                    severity: annotationConfig.get<string>('defaultSeverity', 'info'),
                    languageId: document.languageId,
                    ...(args?.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
                };
                try {
                    let created: Readonly<{ id: string }>;
                    if (typeof args?.offset === 'number') {
                        created = annotationStore.add(draft, { offset: args.offset }, document);
                    } else {
                        const line = args?.line ?? editor.selection.active.line;
                        created = annotationStore.add(draft, { line }, document);
                    }
                    await awaitAnnotationSaveBarrier();
                    return created.id;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(
                        localize('addAnnotationError', 'Failed to add annotation') + `: ${msg}`
                    );
                    return undefined;
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.clearAll', async () => {
            if (!annotationStore) {
                return;
            }
            const yes = localize('yes', 'Yes');
            const no = localize('no', 'No');
            const confirm = await vscode.window.showWarningMessage(
                localize('confirmClear', 'Are you sure you want to clear all annotations?'),
                yes,
                no
            );
            if (confirm !== yes) {
                return;
            }
            // serialize() is the only view that includes SUSPENDED entries:
            // clearing only list() (active) leaves cut-but-never-pasted
            // annotations alive in the suspended buffer, where they later
            // steal paste-resumes from fresh annotations with the same
            // line hash.
            for (const ann of annotationStore.serialize().annotations) {
                annotationStore.remove(ann.id);
            }
            await awaitAnnotationSaveBarrier();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.resolve', async (commandArg?: unknown) => {
            const store = annotationStore;
            if (!store) {
                return 0;
            }
            const annotationId = await pickStoreAnnotationId(
                commandArg,
                loc('selectAnnotationToResolve', 'Select an annotation to resolve')
            );
            if (!annotationId) {
                return 0;
            }
            store.update(annotationId, { resolved: true, timestamp: new Date().toISOString() });
            vscode.window.setStatusBarMessage(loc('annotationResolved', 'Annotation resolved.'), 3000);
            return 1;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.editTags', async (commandArg?: unknown) => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return 0;
            }
            const annotationId = await pickStoreAnnotationId(
                commandArg,
                loc('selectAnnotationToTag', 'Select an annotation whose tags you want to edit')
            );
            const annotation = annotationId ? store.get(annotationId) : undefined;
            if (!annotation) {
                return 0;
            }
            const input = await vscode.window.showInputBox({
                title: loc('editAnnotationTags', 'Edit annotation tags'),
                prompt: loc('enterTags', 'Enter tags separated by commas'),
                value: (annotation.tags ?? []).join(', '),
                validateInput: (value) =>
                    value.length > 500
                        ? loc('tagsTooLong', 'Tags must contain at most 500 characters in total.')
                        : undefined,
            });
            if (input === undefined) {
                return 0;
            }
            const tags = [
                ...new Set(
                    input
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                ),
            ];
            store.update(annotation.id, { tags, timestamp: new Date().toISOString() });
            vscode.window.setStatusBarMessage(loc('tagsUpdated', 'Annotation tags updated.'), 3000);
            return 1;
        }),

        vscode.commands.registerCommand('annotations.autoResolveStale', async () => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return 0;
            }
            const value = await vscode.window.showInputBox({
                title: loc('resolveStaleTitle', 'Resolve old annotations'),
                prompt: loc('resolveStalePrompt', 'Resolve open annotations older than how many days?'),
                value: '7',
                validateInput: (input) => {
                    const days = Number(input);
                    return Number.isInteger(days) && days >= 1 && days <= 3650
                        ? undefined
                        : loc('resolveStaleInvalidDays', 'Enter a whole number from 1 to 3650.');
                },
            });
            if (!value) {
                return 0;
            }
            const days = Number(value);
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            const stale = store
                .list()
                .filter((annotation) => !annotation.resolved && Date.parse(annotation.timestamp) < cutoff);
            if (stale.length === 0) {
                vscode.window.showInformationMessage(
                    loc('noStale', 'No open annotations are older than {0} day(s).', days)
                );
                return 0;
            }
            const resolveLabel = loc('resolveCount', 'Resolve {0}', stale.length);
            const confirmation = await vscode.window.showWarningMessage(
                loc('confirmResolveStale', 'Resolve {0} annotation(s) older than {1} day(s)?', stale.length, days),
                { modal: true },
                resolveLabel
            );
            if (confirmation !== resolveLabel) {
                return 0;
            }
            store.beginTransaction();
            try {
                const timestamp = new Date().toISOString();
                for (const annotation of stale) {
                    store.update(annotation.id, { resolved: true, timestamp });
                }
                store.commit();
            } catch (error) {
                store.rollback();
                throw error;
            }
            vscode.window.showInformationMessage(loc('staleResolved', '{0} old annotation(s) resolved.', stale.length));
            return stale.length;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.bulkActions', async (commandArg?: unknown) => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return 0;
            }

            type BulkAction = 'resolve' | 'reopen' | 'severity' | 'delete';
            type BulkActionArgument = { ids?: unknown; action?: unknown; severity?: unknown };
            const argument =
                commandArg && typeof commandArg === 'object' ? (commandArg as BulkActionArgument) : undefined;
            let ids = Array.isArray(argument?.ids)
                ? argument.ids.filter((id): id is string => typeof id === 'string')
                : [];
            if (commandArg instanceof AnnotationTreeItem) {
                ids = selectedTreeAnnotationIds.includes(commandArg.annotation.id)
                    ? selectedTreeAnnotationIds
                    : [commandArg.annotation.id];
            } else if (ids.length === 0) {
                ids = selectedTreeAnnotationIds;
            }
            ids = [...new Set(ids)].filter((id) => store.get(id) !== undefined);
            if (ids.length === 0) {
                const picked = await vscode.window.showQuickPick(
                    store.list().map((annotation) => ({
                        label: firstMessageLine(annotation.message) || annotation.id,
                        description: annotation.file,
                        id: annotation.id,
                    })),
                    {
                        canPickMany: true,
                        title: loc('bulkSelectTitle', 'Select annotations for a bulk action'),
                        placeHolder: loc('bulkSelectPlaceholder', 'Select one or more annotations'),
                        matchOnDescription: true,
                    }
                );
                ids = picked?.map((item) => item.id) ?? [];
                if (ids.length === 0) {
                    return 0;
                }
            }

            const suppliedAction = argument?.action;
            let action: BulkAction | undefined =
                suppliedAction === 'resolve' ||
                suppliedAction === 'reopen' ||
                suppliedAction === 'severity' ||
                suppliedAction === 'delete'
                    ? suppliedAction
                    : undefined;
            if (!action) {
                const picked = await vscode.window.showQuickPick(
                    [
                        {
                            label: '$(pass-filled) ' + loc('bulkResolve', 'Mark as resolved'),
                            value: 'resolve' as const,
                        },
                        { label: '$(circle-large-outline) ' + loc('bulkReopen', 'Reopen'), value: 'reopen' as const },
                        { label: '$(warning) ' + loc('bulkSeverity', 'Change severity'), value: 'severity' as const },
                        { label: '$(trash) ' + loc('bulkDelete', 'Delete'), value: 'delete' as const },
                    ],
                    {
                        title: loc('bulkActionTitle', 'Bulk actions'),
                        placeHolder: loc('bulkActionPlaceholder', 'Apply an action to {0} annotations', ids.length),
                    }
                );
                action = picked?.value;
            }
            if (!action) {
                return 0;
            }

            let severity = typeof argument?.severity === 'string' ? argument.severity : undefined;
            if (action === 'severity' && !severity) {
                const picked = await vscode.window.showQuickPick(
                    [
                        { label: '$(info) Info', value: 'info' },
                        { label: '$(warning) Warning', value: 'warning' },
                        { label: '$(error) Error', value: 'error' },
                        { label: '$(flame) Critical', value: 'critical' },
                    ],
                    { placeHolder: loc('bulkSeverityPlaceholder', 'Choose a severity for {0} annotations', ids.length) }
                );
                severity = picked?.value;
            }
            if (action === 'severity' && !severity) {
                return 0;
            }

            if (action === 'delete') {
                const deleteLabel = loc('deleteSelected', 'Delete selected');
                const confirmation = await vscode.window.showWarningMessage(
                    loc('confirmBulkDelete', 'Permanently delete {0} selected annotations?', ids.length),
                    { modal: true },
                    deleteLabel
                );
                if (confirmation !== deleteLabel) {
                    return 0;
                }
            }

            store.beginTransaction();
            try {
                for (const id of ids) {
                    if (action === 'delete') {
                        store.remove(id);
                    } else if (action === 'resolve') {
                        store.update(id, { resolved: true });
                    } else if (action === 'reopen') {
                        store.update(id, { resolved: false });
                    } else {
                        store.update(id, { severity });
                    }
                }
                store.commit();
            } catch (error) {
                store.rollback();
                getLogger().error('Bulk annotation action failed', error);
                vscode.window.showErrorMessage(loc('bulkActionFailed', 'Unable to update the selected annotations.'));
                return 0;
            }

            selectedTreeAnnotationIds = selectedTreeAnnotationIds.filter((id) => store.get(id) !== undefined);
            selectedTreeAnnotationItems = selectedTreeAnnotationItems.filter(
                (item) => store.get(item.annotation.id) !== undefined
            );
            void vscode.commands.executeCommand(
                'setContext',
                'outOfCodeInsights.treeSelectionCount',
                selectedTreeAnnotationIds.length
            );
            vscode.window.setStatusBarMessage(loc('bulkActionComplete', 'Updated {0} annotations.', ids.length), 4000);
            return ids.length;
        })
    );

    // TreeItem-aware commands. Legacy edit/delete/pin commands resolve from
    // the active cursor, which is unsafe when a context menu belongs to a
    // different tree row or file.
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.treeEdit', async (commandArg?: unknown) => {
            const store = annotationStore;
            const id = annotationIdFromCommandArg(commandArg);
            const annotation = id ? store?.get(id) : undefined;
            if (!store || !annotation) {
                return 0;
            }
            const message = await vscode.window.showInputBox({
                title: loc('treeEditTitle', 'Edit annotation'),
                value: annotation.message,
                validateInput: (value) =>
                    value.trim().length === 0 ? loc('emptyMessageError', 'Message cannot be empty') : undefined,
            });
            if (!message || message === annotation.message) {
                return 0;
            }
            store.update(annotation.id, { message, timestamp: new Date().toISOString() });
            return 1;
        }),
        vscode.commands.registerCommand('annotations.treeDelete', async (commandArg?: unknown) => {
            const ids = treeSelectionIds(commandArg);
            return vscode.commands.executeCommand<number>('annotations.bulkActions', { ids, action: 'delete' });
        }),
        vscode.commands.registerCommand('annotations.treeSetSeverity', async (commandArg?: unknown) => {
            const ids = treeSelectionIds(commandArg);
            return vscode.commands.executeCommand<number>('annotations.bulkActions', { ids, action: 'severity' });
        }),
        vscode.commands.registerCommand('annotations.treeTogglePin', (commandArg?: unknown) => {
            const store = annotationStore;
            const clickedId = annotationIdFromCommandArg(commandArg);
            const clicked = clickedId ? store?.get(clickedId) : undefined;
            if (!store || !clicked) {
                return 0;
            }
            const ids = treeSelectionIds(commandArg);
            store.beginTransaction();
            try {
                for (const id of ids) {
                    store.update(id, { pinned: !clicked.pinned });
                }
                store.commit();
                return ids.length;
            } catch (error) {
                store.rollback();
                throw error;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.moveByDragAndDrop', async (commandArg?: unknown) => {
            const store = annotationStore;
            const moveService = annotationMoveService;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return 0;
            }
            if (!moveService) {
                if (!vscode.workspace.workspaceFolders?.length) {
                    const openFolder = loc('openFolder', 'Open Folder...');
                    const action = await vscode.window.showInformationMessage(
                        loc(
                            'workspaceRequiredForAnnotationMove',
                            'Open a workspace folder before moving annotations between files.'
                        ),
                        openFolder
                    );
                    if (action === openFolder) {
                        await vscode.commands.executeCommand('workbench.action.files.openFolder');
                    }
                } else {
                    vscode.window.showErrorMessage(
                        loc(
                            'annotationMoveServiceNotReady',
                            'Annotation moving is not ready. Run "Show Initialization Report" for details.'
                        )
                    );
                }
                return 0;
            }

            const raw = commandArg && typeof commandArg === 'object' ? (commandArg as Record<string, unknown>) : {};
            let ids = Array.isArray(raw.ids)
                ? raw.ids.filter((id): id is string => typeof id === 'string')
                : selectedTreeAnnotationIds;
            if (commandArg instanceof AnnotationTreeItem) {
                ids = selectedTreeAnnotationIds.includes(commandArg.annotation.id)
                    ? selectedTreeAnnotationIds
                    : [commandArg.annotation.id];
            }
            if (ids.length === 0) {
                const picked = await vscode.window.showQuickPick(
                    store.list().map((annotation) => ({
                        label: firstMessageLine(annotation.message) || annotation.id,
                        description: annotation.file,
                        id: annotation.id,
                        picked: false,
                    })),
                    {
                        canPickMany: true,
                        title: loc('moveAnnotationsTitle', 'Move annotations'),
                        placeHolder: loc('pickAnnotationsToMove', 'Select one or more annotations to move'),
                        matchOnDescription: true,
                    }
                );
                ids = picked?.map((item) => item.id) ?? [];
            }
            if (ids.length === 0) {
                return 0;
            }

            const request: MoveAnnotationsRequest = {
                ids,
                ...(typeof raw.targetAnnotationId === 'string' ? { targetAnnotationId: raw.targetAnnotationId } : {}),
                ...(typeof raw.targetFile === 'string' ? { targetFile: raw.targetFile } : {}),
                ...(typeof raw.targetUri === 'string' ? { targetUri: raw.targetUri } : {}),
                ...(typeof raw.targetLine === 'number' ? { targetLine: raw.targetLine } : {}),
            };
            try {
                const result = await moveService.move(request);
                if (!result) {
                    return 0;
                }
                vscode.window.setStatusBarMessage(
                    loc(
                        'annotationsMoved',
                        'Moved {0} annotation(s) to {1}, line {2}.',
                        result.movedIds.length,
                        result.file,
                        result.firstLine + 1
                    ),
                    5000
                );
                return result.movedIds.length;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                getLogger().error('Annotation drag-and-drop move failed', error);
                vscode.window.showErrorMessage(loc('annotationMoveFailed', 'Unable to move annotations: {0}', message));
                return 0;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.reanchorToCursor', async (commandArg?: unknown) => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return;
            }
            // Capture the text editor before a QuickPick/webview can take
            // focus. This command deliberately targets the current cursor.
            let editor = vscode.window.activeTextEditor;
            if (!editor && vscode.window.visibleTextEditors.length === 1) {
                [editor] = vscode.window.visibleTextEditors;
            } else if (!editor && vscode.window.visibleTextEditors.length > 1) {
                const target = await vscode.window.showQuickPick(
                    vscode.window.visibleTextEditors.map((candidate) => ({
                        label: vscode.workspace.asRelativePath(candidate.document.uri),
                        description: loc(
                            'cursorLineDescription',
                            'Cursor on line {0}',
                            candidate.selection.active.line + 1
                        ),
                        editor: candidate,
                    })),
                    { placeHolder: loc('pickReanchorEditor', 'Select the editor containing the destination cursor') }
                );
                editor = target?.editor;
            }
            if (!editor) {
                vscode.window.showErrorMessage(
                    loc('reanchorNeedsEditor', 'Place the cursor on the destination line before re-anchoring.')
                );
                return;
            }

            let annotationId = annotationIdFromCommandArg(commandArg);
            if (!annotationId) {
                const diagnostics = store.diagnose(vscode.workspace.textDocuments);
                const issuesById = new Map(diagnostics.annotations.map((item) => [item.id, item.issues]));
                const items = store
                    .list()
                    .map((annotation) => ({
                        label: firstMessageLine(annotation.message) || annotation.id,
                        description: formatAnnotationLocation(
                            annotation.file,
                            store.getLineForAnnotation(annotation.id, vscode.workspace.textDocuments)
                        ),
                        detail: issuesById.get(annotation.id)?.join(', ') || loc('anchorHealthy', 'Anchor healthy'),
                        id: annotation.id,
                        hasIssues: (issuesById.get(annotation.id)?.length ?? 0) > 0,
                    }))
                    .sort((left, right) => Number(right.hasIssues) - Number(left.hasIssues));
                if (items.length === 0) {
                    vscode.window.showInformationMessage(
                        loc('noAnnotationsToReanchor', 'No annotations to re-anchor.')
                    );
                    return;
                }
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: loc(
                        'pickAnnotationToReanchor',
                        'Select the annotation to attach to the current cursor'
                    ),
                    matchOnDescription: true,
                    matchOnDetail: true,
                });
                if (!picked) {
                    return;
                }
                annotationId = picked.id;
            }

            const targetLine = editor.selection.active.line;
            try {
                const updated = store.reanchor(
                    annotationId,
                    targetLine,
                    editor.document,
                    vscode.workspace.asRelativePath(editor.document.uri)
                );
                const targetRange = editor.document.lineAt(targetLine).range;
                editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                getLogger().info('Annotation manually re-anchored', {
                    annotationId: updated.id,
                    fileUri: updated.fileUri,
                    line: targetLine,
                });
                vscode.window.showInformationMessage(
                    loc(
                        'annotationReanchored',
                        'Annotation re-anchored to {0}, line {1}.',
                        updated.file,
                        targetLine + 1
                    )
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(loc('reanchorFailed', 'Unable to re-anchor annotation: {0}', message));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.showTrackingDiagnostics', async () => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return;
            }
            const report = store.diagnose(vscode.workspace.textDocuments);
            const document = await vscode.workspace.openTextDocument({
                language: 'json',
                content: JSON.stringify(report, null, 2),
            });
            await vscode.window.showTextDocument(document, { preview: true });
            const summary = loc(
                'trackingDiagnosticsSummary',
                'Tracking diagnostics: {0} annotation(s), {1} with issue(s).',
                report.counts.total,
                report.counts.withIssues
            );
            if (report.valid) {
                vscode.window.setStatusBarMessage(summary, 5000);
            } else {
                vscode.window.showWarningMessage(summary);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.addDocBlock', async () => {
            const roles: { label: string; description: string; tag: string }[] = [
                {
                    label: '$(symbol-namespace) Module',
                    description: loc('docRoleModule', 'File-level header — opens the API page for this file'),
                    tag: 'doc:module',
                },
                {
                    label: '$(symbol-class) Class',
                    description: loc('docRoleClass', 'Class section — owns the functions documented below it'),
                    tag: 'doc:class',
                },
                {
                    label: '$(symbol-method) Function',
                    description: loc('docRoleFunction', 'Function/method entry — nests under the preceding class'),
                    tag: 'doc:function',
                },
                {
                    label: '$(beaker) Example',
                    description: loc('docRoleExample', 'Example block — attaches to the entity documented above'),
                    tag: 'doc:example',
                },
                {
                    label: '$(book) Guide',
                    description: loc('docRoleGuide', 'Free-standing guide content assembled into guide.md'),
                    tag: 'doc:guide',
                },
                {
                    label: '$(repo) README section',
                    description: 'Purpose, quick start, usage or project-level guidance',
                    tag: 'doc:readme',
                },
                {
                    label: '$(history) Changelog entry',
                    description: 'Curated release change; combine with version:* and change-category tags',
                    tag: 'doc:changelog',
                },
                {
                    label: '$(type-hierarchy) Architecture',
                    description: 'System context, component, constraint or technical view',
                    tag: 'doc:architecture',
                },
                {
                    label: '$(law) Architecture decision',
                    description: 'Decision context, options, outcome and consequences',
                    tag: 'doc:adr',
                },
                {
                    label: '$(rocket) Developer onboarding',
                    description: 'Prerequisites, setup, development loop or first contribution',
                    tag: 'doc:onboarding',
                },
                {
                    label: '$(tools) Operational runbook',
                    description: 'Trigger, safeguards, steps, verification, rollback or escalation',
                    tag: 'doc:runbook',
                },
                {
                    label: '$(references) Technical reference',
                    description: 'Configuration, concept, schema, CLI or API-oriented reference',
                    tag: 'doc:reference',
                },
            ];
            const picked = await vscode.window.showQuickPick(roles, {
                placeHolder: loc('docRolePlaceholder', 'Documentation role for this annotation'),
            });
            if (!picked) {
                return;
            }
            const tags = [picked.tag];
            if (picked.tag === 'doc:changelog') {
                const version = await vscode.window.showInputBox({
                    prompt: 'Release version for this changelog entry',
                    placeHolder: 'For example: 1.4.4 or Unreleased',
                    validateInput: (value) =>
                        /^(?:unreleased|[0-9A-Za-z][0-9A-Za-z._+-]{0,63})$/i.test(value.trim())
                            ? undefined
                            : 'Use a non-empty portable version (maximum 64 characters).',
                });
                if (!version) {
                    return;
                }
                const category = await vscode.window.showQuickPick(
                    [
                        { label: '$(add) Added', tag: 'added' },
                        { label: '$(edit) Changed', tag: 'changed' },
                        { label: '$(warning) Deprecated', tag: 'deprecated' },
                        { label: '$(remove) Removed', tag: 'removed' },
                        { label: '$(wrench) Fixed', tag: 'fixed' },
                        { label: '$(shield) Security', tag: 'security' },
                    ],
                    { placeHolder: 'Changelog category' }
                );
                if (!category) {
                    return;
                }
                tags.push(`version:${version.trim()}`, category.tag);

                const dateChoice = await vscode.window.showQuickPick(
                    [
                        { label: '$(circle-slash) No release date', enter: false },
                        { label: '$(calendar) Enter an explicit release date', enter: true },
                    ],
                    { placeHolder: 'Release date (optional; never inferred)' }
                );
                if (!dateChoice) {
                    return;
                }
                if (dateChoice.enter) {
                    const releaseDate = await vscode.window.showInputBox({
                        prompt: 'Release date',
                        placeHolder: 'YYYY-MM-DD',
                        validateInput: (value) => {
                            const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
                            if (!match) {
                                return 'Use YYYY-MM-DD.';
                            }
                            const year = Number(match[1]);
                            const month = Number(match[2]);
                            const day = Number(match[3]);
                            const date = new Date(Date.UTC(year, month - 1, day));
                            return date.getUTCFullYear() === year &&
                                date.getUTCMonth() === month - 1 &&
                                date.getUTCDate() === day
                                ? undefined
                                : 'Enter a real calendar date.';
                        },
                    });
                    if (!releaseDate) {
                        return;
                    }
                    tags.push(`release-date:${releaseDate.trim()}`);
                }
            } else if (picked.tag === 'doc:adr') {
                const status = await vscode.window.showQuickPick(
                    [
                        { label: '$(circle-outline) Proposed', tag: 'proposed' },
                        { label: '$(pass) Accepted', tag: 'accepted' },
                        { label: '$(error) Rejected', tag: 'rejected' },
                        { label: '$(archive) Superseded', tag: 'superseded' },
                        { label: '$(circle-slash) No status yet', tag: undefined },
                    ],
                    { placeHolder: 'Architecture decision status (optional)' }
                );
                if (!status) {
                    return;
                }
                if (status.tag) {
                    tags.push(`adr:status:${status.tag}`);
                }
            }
            await vscode.commands.executeCommand('annotations.add', { tags });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.generateDocs', async () => {
            await generateDocumentationNow(false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.configureDocs', async () => {
            await configureDocumentationStudio();
        })
    );

    // Better-comments bridge: import marker comments (`// !`, `// ?`,
    // `// *`, TODO/FIXME/HACK) from the active document as annotations,
    // tagged and severity-mapped per marker. Line-based scan — markers
    // inside string literals may match; the user reviews the result.
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.importComments', async () => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage(localize('noActiveEditor', 'No active editor found.'));
                return;
            }
            const document = editor.document;
            const lines: string[] = [];
            for (let i = 0; i < document.lineCount; i++) {
                lines.push(document.lineAt(i).text);
            }
            const matches = scanLineComments(lines, document.languageId);
            const fileUri = document.uri.toString();
            const occupiedLines = new Set<number>();
            for (const existing of store.getByFile(fileUri)) {
                occupiedLines.add(document.positionAt(existing.startOffset).line);
            }
            let created = 0;
            for (const match of matches) {
                if (occupiedLines.has(match.line)) {
                    continue;
                }
                store.add(
                    {
                        fileUri,
                        file: vscode.workspace.asRelativePath(document.uri),
                        origin: { kind: 'manual' },
                        message: match.text,
                        timestamp: new Date().toISOString(),
                        languageId: document.languageId,
                        tags: [match.tag, 'imported-comment'],
                        severity: match.severity,
                    },
                    { line: match.line },
                    document
                );
                occupiedLines.add(match.line);
                created++;
            }
            if (created > 0) {
                vscode.window.showInformationMessage(
                    loc('commentsImported', '{0} annotation(s) created from code comments.', created)
                );
            } else {
                vscode.window.showInformationMessage(
                    loc('noCommentsToImport', 'No importable comment markers found in this file.')
                );
            }
        })
    );

    // Workspace-wide variant of the better-comments bridge: scan every
    // matching file in the workspace through the filesystem API (no editors
    // opened) and import marker comments as annotations via the store's raw
    // add path. Pro-gateable as `comments.importWorkspace` (free by default).
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.importCommentsWorkspace', async () => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return;
            }
            if (
                !requireEntitlement(
                    PRO_FEATURE_IDS.workspaceCommentImport,
                    localizedFeatureName(PRO_FEATURE_IDS.workspaceCommentImport)
                )
            ) {
                return;
            }
            const uris = await vscode.workspace.findFiles(
                WORKSPACE_IMPORT_INCLUDE_GLOB,
                WORKSPACE_IMPORT_EXCLUDE_GLOB,
                WORKSPACE_IMPORT_MAX_FILES
            );
            if (uris.length === 0) {
                vscode.window.showInformationMessage(
                    loc('workspaceImportNoFiles', 'No matching source files found in the workspace.')
                );
                return;
            }
            const decoder = new TextDecoder();
            let scanned = 0;
            let created = 0;
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: loc('workspaceImportProgressTitle', 'Importing code comments from the workspace…'),
                    cancellable: true,
                },
                async (progress, token) => {
                    const increment = 100 / uris.length;
                    for (const uri of uris) {
                        if (token.isCancellationRequested) {
                            break;
                        }
                        try {
                            const stat = await vscode.workspace.fs.stat(uri);
                            if (stat.size <= WORKSPACE_IMPORT_MAX_FILE_BYTES) {
                                const content = decoder.decode(await vscode.workspace.fs.readFile(uri));
                                created += importCommentsFromContent(store, uri, content);
                            }
                        } catch (err) {
                            getLogger().warn(`importCommentsWorkspace: skipping ${uri.toString()}`, {
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                        scanned++;
                        progress.report({
                            increment,
                            message: loc('workspaceImportProgress', '{0}/{1} file(s) scanned', scanned, uris.length),
                        });
                    }
                }
            );
            vscode.window.showInformationMessage(
                loc(
                    'workspaceCommentsImported',
                    '{0} annotation(s) created from {1} file(s) scanned.',
                    created,
                    scanned
                )
            );
        })
    );

    // Guided, language-aware conversion of standalone comments, file headers
    // and documentation blocks. The existing marker import remains the fast
    // TODO/FIXME workflow; this command previews every detected comment.
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.convertCodeComments', async (argument?: unknown) => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return 0;
            }
            const document = await sourceConversionDocument(argument);
            if (!document) {
                return 0;
            }
            if (!supportsSourceCommentLanguage(document.languageId)) {
                vscode.window.showInformationMessage(
                    loc(
                        'sourceCommentLanguageUnsupported',
                        'Comment conversion is not available for language mode "{0}" yet.',
                        document.languageId
                    )
                );
                return 0;
            }
            const records = scanSourceComments(document.getText(), document.languageId);
            const existing = store.getByFile(document.uri.toString()).map((annotation) => ({
                idFragment: sourceCommentAnnotationIdFragment(annotation.id),
                line: document.positionAt(annotation.startOffset).line,
                message: normalizedConversionText(annotation.message),
            }));
            const candidates = records.filter((record) => {
                if (record.text.trim().length === 0) {
                    return false;
                }
                if (record.annotationIdFragment) {
                    const idMatches = existing.filter(
                        (annotation) => annotation.idFragment === record.annotationIdFragment
                    );
                    if (
                        idMatches.length === 1 ||
                        idMatches.some((annotation) => annotation.message === normalizedConversionText(record.text))
                    ) {
                        return false;
                    }
                }
                return !existing.some(
                    (annotation) =>
                        annotation.line >= record.startLine &&
                        annotation.line <= record.endLine &&
                        annotation.message === normalizedConversionText(record.text)
                );
            });
            if (candidates.length === 0) {
                vscode.window.showInformationMessage(
                    records.length === 0
                        ? loc('noSourceCommentsFound', 'No standalone comments or file headers were found.')
                        : loc('sourceCommentsAlreadyImported', 'All detected comments already have annotations.')
                );
                return 0;
            }

            const selected = await vscode.window.showQuickPick(
                candidates.map((record) => ({
                    label: `$(comment) ${record.text.split(/\r?\n/, 1)[0].slice(0, 100)}`,
                    description: loc(
                        'sourceCommentLocation',
                        'Line {0} · {1}',
                        record.startLine + 1,
                        localizedSourceCommentKind(record.kind)
                    ),
                    detail:
                        record.endLine > record.startLine
                            ? loc(
                                  'sourceCommentRange',
                                  'Lines {0}-{1}; the complete comment becomes one annotation.',
                                  record.startLine + 1,
                                  record.endLine + 1
                              )
                            : loc('sourceCommentSingleLine', 'One source comment becomes one annotation.'),
                    picked: true,
                    record,
                })),
                {
                    title: loc('convertCommentsTitle', 'Convert Code Comments & Headers to Annotations'),
                    placeHolder: loc('selectCommentsToConvert', 'Select the comments to convert'),
                    canPickMany: true,
                    matchOnDescription: true,
                    matchOnDetail: true,
                }
            );
            if (!selected || selected.length === 0) {
                return 0;
            }

            const createLabel = loc('createAnnotations', 'Create Annotations');
            const confirmation = await vscode.window.showWarningMessage(
                loc(
                    'confirmSourceCommentConversion',
                    'Create {0} annotation(s) from selected comments in {1}? The source code will not be changed.',
                    selected.length,
                    vscode.workspace.asRelativePath(document.uri)
                ),
                { modal: true },
                createLabel
            );
            if (confirmation !== createLabel) {
                return 0;
            }

            const configuration = vscode.workspace.getConfiguration('annotation');
            const maxPerFile = configuration.get<number>('maxAnnotationsPerFile', 1000);
            if (maxPerFile > 0 && store.listForFile(document.uri.toString()).length + selected.length > maxPerFile) {
                vscode.window.showWarningMessage(
                    loc('maxAnnotationsReached', 'This file has reached its limit of {0} annotations.', maxPerFile)
                );
                return 0;
            }

            let conversionTransactionStarted = false;
            try {
                store.beginTransaction();
                conversionTransactionStarted = true;
                for (const { record } of selected) {
                    store.add(
                        {
                            fileUri: document.uri.toString(),
                            file: vscode.workspace.asRelativePath(document.uri),
                            origin: { kind: 'manual' },
                            message: record.text,
                            author: configuration.get<string>('username', 'Anonymous').trim() || 'Anonymous',
                            timestamp: new Date().toISOString(),
                            languageId: document.languageId,
                            tags: ['imported-source-comment', `source-comment:${record.kind}`],
                            severity: sourceCommentSeverity(record),
                        },
                        { line: record.startLine },
                        document
                    );
                }
                store.commit();
                conversionTransactionStarted = false;
            } catch (error) {
                if (conversionTransactionStarted) {
                    store.rollback();
                }
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    loc('sourceCommentConversionFailed', 'Could not convert the selected comments: {0}', message)
                );
                return 0;
            }
            vscode.window.showInformationMessage(
                loc('sourceCommentsConverted', '{0} code comment(s) converted to annotations.', selected.length)
            );
            return selected.length;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.writeAnnotationsToCodeComments', async (argument?: unknown) => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return 0;
            }
            const document = await sourceConversionDocument(argument);
            if (!document) {
                return 0;
            }
            if (!supportsSourceCommentLanguage(document.languageId)) {
                vscode.window.showInformationMessage(
                    loc(
                        'sourceCommentLanguageUnsupported',
                        'Comment conversion is not available for language mode "{0}" yet.',
                        document.languageId
                    )
                );
                return 0;
            }
            if (!supportsSourceCommentEncoding(document.languageId)) {
                vscode.window.showInformationMessage(
                    loc(
                        'sourceCommentWritingMixedLanguageUnsupported',
                        'Comments can be converted to annotations in language mode "{0}", but writing annotations is disabled because this mixed template/code mode requires syntax-aware placement.',
                        document.languageId
                    )
                );
                return 0;
            }

            const sourceComments = scanSourceComments(document.getText(), document.languageId);
            const clickedAnnotationId = annotationIdFromCommandArg(argument);
            const candidates = store
                .getByFile(document.uri.toString())
                .map((annotation) => ({
                    annotation,
                    line: document.positionAt(annotation.startOffset).line,
                }))
                .filter(
                    ({ annotation, line }) =>
                        !sourceComments.some(
                            (comment) =>
                                comment.annotationIdFragment === sourceCommentAnnotationIdFragment(annotation.id)
                        ) &&
                        !sourceComments.some(
                            (comment) =>
                                line >= comment.startLine &&
                                line <= comment.endLine &&
                                normalizedConversionText(comment.text) === normalizedConversionText(annotation.message)
                        )
                );
            if (candidates.length === 0) {
                vscode.window.showInformationMessage(
                    loc('noAnnotationsToMaterialize', 'No annotations need to be written into comments in this file.')
                );
                return 0;
            }

            const selected = await vscode.window.showQuickPick(
                candidates.map(({ annotation, line }) => ({
                    label: `$(note) ${annotation.message.split(/\r?\n/, 1)[0].slice(0, 100)}`,
                    description: loc('annotationAtLine', 'Annotation at line {0}', line + 1),
                    detail: loc(
                        'annotationCommentPreview',
                        'Will include marker {0} so reruns never duplicate it.',
                        sourceCommentAnnotationMarker(annotation.id)
                    ),
                    picked: !clickedAnnotationId || annotation.id === clickedAnnotationId,
                    annotation,
                    line,
                })),
                {
                    title: loc('writeAnnotationsTitle', 'Write Annotations into Code Comments'),
                    placeHolder: loc('selectAnnotationsToWrite', 'Select annotations to write into the source file'),
                    canPickMany: true,
                    matchOnDescription: true,
                    matchOnDetail: true,
                }
            );
            if (!selected || selected.length === 0) {
                return 0;
            }

            let docblockAvailable = true;
            try {
                encodeSourceComment('Preview', document.languageId, {
                    annotationId: 'preview',
                    style: 'docblock',
                });
            } catch {
                docblockAvailable = false;
            }
            const style = await vscode.window.showQuickPick(
                [
                    {
                        label: loc('standardSourceComment', 'Standard language comment (Recommended)'),
                        description: loc('standardSourceCommentDescription', 'Uses line comments when available'),
                        value: 'auto' as SourceCommentEncodingStyle,
                    },
                    ...(docblockAvailable
                        ? [
                              {
                                  label: loc('documentationSourceComment', 'Documentation block'),
                                  description: loc(
                                      'documentationSourceCommentDescription',
                                      'Uses the language documentation-comment syntax'
                                  ),
                                  value: 'docblock' as SourceCommentEncodingStyle,
                              },
                          ]
                        : []),
                ],
                {
                    title: loc('chooseCommentStyle', 'Choose Source Comment Style'),
                    placeHolder: loc('chooseCommentStyleDescription', 'Choose how annotations appear in code'),
                }
            );
            if (!style) {
                return 0;
            }

            const writeLabel = loc('writeCodeComments', 'Write Code Comments');
            const confirmation = await vscode.window.showWarningMessage(
                loc(
                    'confirmWriteAnnotations',
                    'Insert {0} comment(s) into {1}? This changes the source file and can be undone once with Undo.',
                    selected.length,
                    vscode.workspace.asRelativePath(document.uri)
                ),
                { modal: true },
                writeLabel
            );
            if (confirmation !== writeLabel) {
                return 0;
            }

            const endOfLine = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const commentsByPosition = new Map<
                string,
                { position: vscode.Position; comments: string[]; appendAfterPreamble: boolean }
            >();
            try {
                for (const { annotation, line } of selected) {
                    const appendAfterPreamble =
                        line === 0 && sourcePreambleMustStayFirst(document) && document.lineCount === 1;
                    const insertionLine = line === 0 && sourcePreambleMustStayFirst(document) ? 1 : line;
                    const insertionPosition = appendAfterPreamble
                        ? document.lineAt(0).range.end
                        : new vscode.Position(insertionLine, 0);
                    const indentation = appendAfterPreamble
                        ? ''
                        : (document.lineAt(insertionLine).text.match(/^\s*/)?.[0] ?? '');
                    const encoded = encodeSourceComment(annotation.message, document.languageId, {
                        annotationId: annotation.id,
                        indentation,
                        style: style.value,
                    }).replace(/\n/g, endOfLine);
                    const positionKey = `${insertionPosition.line}:${insertionPosition.character}`;
                    const bucket = commentsByPosition.get(positionKey);
                    if (bucket) {
                        bucket.comments.push(encoded);
                    } else {
                        commentsByPosition.set(positionKey, {
                            position: insertionPosition,
                            comments: [encoded],
                            appendAfterPreamble,
                        });
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    loc('annotationCommentEncodingFailed', 'Could not create source comments: {0}', message)
                );
                return 0;
            }

            const edit = new vscode.WorkspaceEdit();
            for (const { position, comments, appendAfterPreamble } of commentsByPosition.values()) {
                const joined = comments.join(endOfLine);
                edit.insert(
                    document.uri,
                    position,
                    appendAfterPreamble ? `${endOfLine}${joined}` : `${joined}${endOfLine}`
                );
            }
            await vscode.window.showTextDocument(document, { preserveFocus: false, preview: false });
            if (!(await vscode.workspace.applyEdit(edit))) {
                vscode.window.showErrorMessage(
                    loc('annotationCommentEditRejected', 'VS Code could not apply the source comment edit.')
                );
                return 0;
            }
            const documentVersionAfterEdit = document.version;
            const previousTagsById = new Map<string, readonly string[]>();
            let metadataTransactionStarted = false;
            try {
                store.beginTransaction();
                metadataTransactionStarted = true;
                for (const { annotation } of selected) {
                    const current = store.get(annotation.id);
                    if (current) {
                        previousTagsById.set(annotation.id, [...(current.tags ?? [])]);
                        store.update(annotation.id, {
                            tags: [...new Set([...(current.tags ?? []), 'materialized-source-comment'])],
                        });
                    }
                }
                store.commit();
                metadataTransactionStarted = false;
            } catch (error) {
                if (metadataTransactionStarted) {
                    store.rollback();
                }
                previousTagsById.clear();
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(
                    loc(
                        'sourceCommentMetadataUpdateFailed',
                        'The comments were written, but annotation metadata could not be updated: {0}',
                        message
                    )
                );
            }
            const undoLabel = loc('undo', 'Undo');
            const action = await vscode.window.showInformationMessage(
                loc('annotationsWrittenToComments', '{0} annotation(s) written into code comments.', selected.length),
                undoLabel
            );
            if (action === undoLabel) {
                if (document.version !== documentVersionAfterEdit) {
                    vscode.window.showWarningMessage(
                        loc(
                            'sourceCommentsUndoUnsafe',
                            'The source file changed after insertion, so automatic Undo was not run. Use source control or remove the generated OOCI comments manually.'
                        )
                    );
                } else {
                    await vscode.window.showTextDocument(document, { preserveFocus: false, preview: false });
                    await vscode.commands.executeCommand('undo');
                    if (previousTagsById.size > 0) {
                        let undoMetadataTransactionStarted = false;
                        try {
                            store.beginTransaction();
                            undoMetadataTransactionStarted = true;
                            for (const [annotationId, previousTags] of previousTagsById) {
                                if (store.get(annotationId)) {
                                    store.update(annotationId, { tags: [...previousTags] });
                                }
                            }
                            store.commit();
                            undoMetadataTransactionStarted = false;
                        } catch (error) {
                            if (undoMetadataTransactionStarted) {
                                store.rollback();
                            }
                            const message = error instanceof Error ? error.message : String(error);
                            vscode.window.showWarningMessage(
                                loc(
                                    'sourceCommentUndoMetadataFailed',
                                    'The source edit was undone, but annotation metadata could not be restored: {0}',
                                    message
                                )
                            );
                        }
                    }
                }
            }
            return selected.length;
        })
    );

    // MCP surface: the server is a standalone process (mcp-server/), so the
    // only UI it needs inside VS Code is a setup helper that hands the user
    // a ready-to-paste client configuration.
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.mcpSetup', async () => {
            const serverUri = vscode.Uri.joinPath(
                context.extensionUri,
                'mcp-server',
                'bin',
                'out-of-code-insights-mcp.js'
            );
            let serverAvailable = true;
            try {
                await vscode.workspace.fs.stat(serverUri);
            } catch {
                serverAvailable = false;
            }
            if (!serverAvailable) {
                const openRepo = loc('openRepository', 'Open repository');
                const choice = await vscode.window.showInformationMessage(
                    loc(
                        'mcpNotBundled',
                        'The MCP server ships with the source repository (mcp-server/), not with the Marketplace build. Clone the repository and run "npm install && npm run build" inside mcp-server/.'
                    ),
                    openRepo
                );
                if (choice === openRepo) {
                    void vscode.env.openExternal(
                        vscode.Uri.parse('https://github.com/JacquesGariepy/out-of-code-insights/tree/main/mcp-server')
                    );
                }
                return;
            }
            const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '<your-project>';
            const claudeCodeCmd = `claude mcp add out-of-code-insights -- node "${serverUri.fsPath}" --workspace "${wsPath}"`;
            const desktopJson = JSON.stringify(
                {
                    mcpServers: {
                        'out-of-code-insights': {
                            command: 'node',
                            args: [serverUri.fsPath, '--workspace', wsPath],
                        },
                    },
                },
                null,
                2
            );
            const picked = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(terminal) Claude Code',
                        description: loc('mcpCopyClaudeCode', 'Copy the "claude mcp add" command'),
                        value: claudeCodeCmd,
                    },
                    {
                        label: '$(json) Claude Desktop',
                        description: loc('mcpCopyDesktop', 'Copy the claude_desktop_config.json snippet'),
                        value: desktopJson,
                    },
                ],
                {
                    placeHolder: loc(
                        'mcpSetupPlaceholder',
                        'MCP client to configure (the config is copied to the clipboard)'
                    ),
                }
            );
            if (picked) {
                await vscode.env.clipboard.writeText(picked.value);
                vscode.window.showInformationMessage(
                    loc('mcpConfigCopied', 'MCP configuration copied to the clipboard.')
                );
            }
        })
    );

    // ── Cloud annotation sync ───────────────────────────────────────────
    // Token entry (SecretStorage) + settings reminder. The token prompt is
    // always available; the sync itself is gated below.
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.syncConfigure', async () => {
            if (!annotationSyncService) {
                vscode.window.showErrorMessage(loc('syncNoWorkspace', 'Open a workspace to use annotation sync.'));
                return;
            }
            await annotationSyncService.configureToken();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.syncNow', async () => {
            if (!annotationSyncService) {
                vscode.window.showErrorMessage(loc('syncNoWorkspace', 'Open a workspace to use annotation sync.'));
                return;
            }
            // Free unless 'sync' is listed in annotation.pro.gatedFeatures.
            if (!requireEntitlement(SYNC_FEATURE_ID, loc('syncFeatureName', 'Cloud annotation sync'))) {
                return;
            }
            await annotationSyncService.syncNow({ interactive: true });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.editMessageMarkdown', async (annotationId?: string) => {
            const store = annotationStore;
            if (!store) {
                vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                return;
            }
            // Context-menu invocations may pass tree items or other objects;
            // only a plain string is accepted as a direct id.
            let id = typeof annotationId === 'string' ? annotationId : undefined;
            if (!id) {
                const annotations = store.list();
                if (annotations.length === 0) {
                    vscode.window.showInformationMessage(loc('noAnnotationsToEdit', 'No annotations to edit.'));
                    return;
                }
                const openDocs = vscode.workspace.textDocuments;
                const items = annotations.map((a) => ({
                    label: firstMessageLine(a.message) || a.id,
                    description: formatAnnotationLocation(a.file, store.getLineForAnnotation(a.id, openDocs)),
                    id: a.id,
                }));
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: loc('pickAnnotationToEdit', 'Select an annotation to edit'),
                });
                if (!picked) {
                    return;
                }
                id = picked.id;
            }
            const annotation = store.get(id);
            if (!annotation) {
                vscode.window.showErrorMessage(loc('annotationNotFound', 'Annotation not found: {0}', id));
                return;
            }
            MarkdownMessageEditor.createOrShow(context, annotation, store);
        })
    );

    // ── Docs watch mode (`annotation.docs.watch`) ────────────────────────
    // Regenerate the documentation silently after annotation changes settle
    // (trailing-edge debounce). The setting is read on every event so a
    // toggle takes effect without reload.
    if (annotationStore) {
        const docsWatchDebounce = createDebounced(() => {
            void generateDocumentationNow(true);
        }, DOCS_WATCH_DEBOUNCE_MS);
        context.subscriptions.push(
            annotationStore.onDidChange(() => {
                const watchEnabled = vscode.workspace.getConfiguration('annotation').get<boolean>('docs.watch', false);
                if (!watchEnabled) {
                    return;
                }
                if (!checkDocsWatchEntitlement()) {
                    return;
                }
                docsWatchDebounce.schedule();
            }),
            { dispose: () => docsWatchDebounce.cancel() }
        );
    }
}

function annotationIdFromCommandArg(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as { id?: unknown; annotation?: { id?: unknown } };
    if (typeof candidate.annotation?.id === 'string') {
        return candidate.annotation.id;
    }
    return typeof candidate.id === 'string' ? candidate.id : undefined;
}

async function sourceConversionDocument(argument: unknown): Promise<vscode.TextDocument | undefined> {
    const asUri = (value: unknown): vscode.Uri | undefined => {
        return value instanceof vscode.Uri ? value : undefined;
    };
    const annotationFileUri = (value: unknown): vscode.Uri | undefined => {
        if (typeof value !== 'object' || value === null) {
            return undefined;
        }
        const candidate = value as { fileUri?: unknown; annotation?: { fileUri?: unknown } };
        const serialized = candidate.annotation?.fileUri ?? candidate.fileUri;
        if (typeof serialized !== 'string') {
            return undefined;
        }
        try {
            return vscode.Uri.parse(serialized, true);
        } catch {
            return undefined;
        }
    };
    const directUri = asUri(argument);
    const resourceUri =
        directUri ??
        annotationFileUri(argument) ??
        (typeof argument === 'object' && argument !== null && 'resourceUri' in argument
            ? asUri((argument as { resourceUri?: unknown }).resourceUri)
            : undefined) ??
        vscode.window.activeTextEditor?.document.uri;
    if (!resourceUri) {
        vscode.window.showInformationMessage(
            loc(
                'openCodeFileForCommentConversion',
                'Open or right-click a code file to convert comments and annotations.'
            )
        );
        return undefined;
    }
    if (resourceUri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(resourceUri) === undefined) {
        vscode.window.showWarningMessage(
            loc('workspaceCodeFileRequired', 'Select a saved code file inside the current workspace.')
        );
        return undefined;
    }
    try {
        const stat = await vscode.workspace.fs.stat(resourceUri);
        if ((stat.type & vscode.FileType.File) === 0) {
            vscode.window.showInformationMessage(
                loc('selectCodeFileNotFolder', 'Select a code file, not a folder, for this conversion.')
            );
            return undefined;
        }
        return await vscode.workspace.openTextDocument(resourceUri);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            loc('codeFileOpenFailed', 'Could not open the selected code file: {0}', message)
        );
        return undefined;
    }
}

function normalizedConversionText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function localizedSourceCommentKind(kind: SourceCommentKind): string {
    switch (kind) {
        case 'header':
            return loc('sourceCommentKindHeader', 'file header');
        case 'line':
            return loc('sourceCommentKindLine', 'line comment');
        case 'block':
            return loc('sourceCommentKindBlock', 'block comment');
        case 'docblock':
            return loc('sourceCommentKindDocblock', 'documentation block');
    }
}

function sourceCommentSeverity(record: SourceCommentRecord): string {
    return /\b(?:security|critical|danger)\b|^!\s*/i.test(record.text)
        ? 'error'
        : /\b(?:fixme|bug|hack|xxx|warning)\b/i.test(record.text)
          ? 'warning'
          : 'info';
}

function sourcePreambleMustStayFirst(document: vscode.TextDocument): boolean {
    if (document.lineCount === 0) {
        return false;
    }
    const first = document.lineAt(0).text.trimStart().toLocaleLowerCase();
    return (
        first.startsWith('#!') ||
        first.startsWith('<?xml') ||
        first.startsWith('<?php') ||
        first.startsWith('<!doctype') ||
        (document.languageId === 'css' && first.startsWith('@charset '))
    );
}

function treeSelectionIds(value: unknown): string[] {
    const clickedId = annotationIdFromCommandArg(value);
    if (!clickedId) {
        return [...selectedTreeAnnotationIds];
    }
    return value instanceof AnnotationTreeItem && selectedTreeAnnotationItems.includes(value)
        ? [...selectedTreeAnnotationIds]
        : [clickedId];
}

/**
 * Entitlement gate for watch-triggered documentation regeneration (Pro
 * feature id `docs.watch`). Free by default: with the stock empty
 * `annotation.pro.gatedFeatures` this always returns true. When the feature
 * is gated and not entitled, the first denial surfaces the standard unlock
 * toast through requireEntitlement(); subsequent denials only log and skip
 * so a busy store does not spam notifications.
 */
function checkDocsWatchEntitlement(): boolean {
    const featureId = PRO_FEATURE_IDS.docsWatch;
    if (docsWatchDenialNotified) {
        const manager = getLicenseManager();
        if (manager && !manager.isEntitled(featureId)) {
            getLogger().info('docs watch: regeneration skipped — feature not entitled');
            return false;
        }
        docsWatchDenialNotified = false;
        return true;
    }
    if (!requireEntitlement(featureId, localizedFeatureName(featureId))) {
        docsWatchDenialNotified = true;
        getLogger().info('docs watch: regeneration blocked by Pro gating; further denials will be silent');
        return false;
    }
    return true;
}

/**
 * Per-file unit of `annotations.importCommentsWorkspace`: scan `content`
 * for comment markers and add one annotation per unannotated matching line
 * through the store's raw add path (no TextDocument involved — anchoring is
 * computed over a TextBuffer with the exact options used by
 * AnnotationStore.addWithDocument). Returns the number of annotations
 * created.
 */
function importCommentsFromContent(store: AnnotationStore, uri: vscode.Uri, content: string): number {
    const languageId = languageOfPath(uri.fsPath);
    const buffer = new TextBuffer(content);
    const lines: string[] = [];
    for (let i = 0; i < buffer.lineCount; i++) {
        lines.push(buffer.lineAt(i).text);
    }
    const matches = scanLineComments(lines, languageId);
    if (matches.length === 0) {
        return 0;
    }
    const fileUri = toFileUriString(uri.fsPath);
    const file = vscode.workspace.asRelativePath(uri);
    const occupiedLines = new Set<number>();
    for (const existing of store.getByFile(fileUri)) {
        occupiedLines.add(buffer.lineAtOffset(existing.startOffset));
    }
    let created = 0;
    for (const match of matches) {
        if (occupiedLines.has(match.line)) {
            continue;
        }
        const startOffset = buffer.offsetAt(match.line);
        const anchor = captureAnchor(buffer, match.line, { walkForward: 0, walkBackward: 0 });
        store.add({
            fileUri,
            file,
            startOffset,
            endOffset: startOffset + buffer.lineAt(match.line).text.length,
            lineHash: anchor.lineHash,
            contextBefore: anchor.contextBefore,
            contextAfter: anchor.contextAfter,
            origin: { kind: 'manual' },
            message: match.text,
            timestamp: new Date().toISOString(),
            languageId,
            tags: [match.tag, 'imported-comment'],
            severity: match.severity,
        });
        occupiedLines.add(match.line);
        created++;
    }
    return created;
}

function safeWorkspaceRelativePath(value: string): string | undefined {
    const normalized = value.trim().replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (
        normalized.length === 0 ||
        path.isAbsolute(normalized) ||
        /^[A-Za-z]:/.test(normalized) ||
        segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
        return undefined;
    }
    return normalized;
}

function explicitConfigurationValue<T>(configuration: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const inspected = configuration.inspect<T>(key);
    return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

async function loadDocumentTemplate(
    workspaceFolder: vscode.WorkspaceFolder,
    configuration: vscode.WorkspaceConfiguration
): Promise<DocumentTemplateDefinition> {
    const selected = configuration.get<string>('docs.template', 'complete');
    if (selected !== 'custom') {
        return (
            getBuiltInDocumentTemplate(selected) ??
            (getBuiltInDocumentTemplate('complete') as DocumentTemplateDefinition)
        );
    }
    const rawPath = configuration.get<string>(
        'docs.customTemplatePath',
        '.out-of-code-insights/document-template.json'
    );
    const relativePath = safeWorkspaceRelativePath(rawPath);
    if (!relativePath || !relativePath.toLowerCase().endsWith('.json')) {
        throw new Error('annotation.docs.customTemplatePath must be a relative JSON path inside the workspace.');
    }
    const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(workspaceFolder.uri, ...relativePath.split('/'))
    );
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
        throw new Error(
            `Custom document template is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    return parseCustomDocumentTemplate(parsed);
}

function resolveDocumentationFormats(
    configuration: vscode.WorkspaceConfiguration,
    template: DocumentTemplateDefinition
): DocumentationFormat[] {
    const configured = configuration.get<unknown[]>('docs.formats', []);
    if (configured.length === 0) {
        return [...template.formats];
    }
    const formats: DocumentationFormat[] = [];
    for (const value of configured) {
        const normalized = normalizeDocumentationFormat(value);
        if (!normalized) {
            throw new Error('annotation.docs.formats contains an unsupported documentation format.');
        }
        if (!formats.includes(normalized)) {
            formats.push(normalized);
        }
    }
    return formats;
}

function resolveTechnicalDocumentKinds(
    configuration: vscode.WorkspaceConfiguration,
    template: DocumentTemplateDefinition
): TechnicalDocumentKind[] {
    const configured = configuration.get<unknown[]>('docs.documents', []);
    if (configured.length === 0) {
        return [...template.documents];
    }
    const supported = new Set<string>(SUPPORTED_TECHNICAL_DOCUMENT_KINDS);
    const documents: TechnicalDocumentKind[] = [];
    for (const value of configured) {
        if (typeof value !== 'string' || !supported.has(value)) {
            throw new Error('annotation.docs.documents contains an unsupported technical document kind.');
        }
        if (!documents.includes(value as TechnicalDocumentKind)) {
            documents.push(value as TechnicalDocumentKind);
        }
    }
    return documents;
}

async function loadOpenApiGenerationProfile(
    workspaceFolder: vscode.WorkspaceFolder,
    configuration: vscode.WorkspaceConfiguration
): Promise<{ profile?: OpenApiGenerationProfile; diagnostics: readonly OpenApiDiagnostic[] }> {
    const rawPath = configuration
        .get<string>('docs.openapiProfilePath', '.out-of-code-insights/openapi-profile.json')
        .trim();
    if (rawPath.length === 0) {
        return { diagnostics: [] };
    }
    const relativePath = safeWorkspaceRelativePath(rawPath);
    if (!relativePath || !relativePath.toLowerCase().endsWith('.json')) {
        return {
            diagnostics: [
                {
                    severity: 'error',
                    code: 'invalid-profile-path',
                    message: 'annotation.docs.openapiProfilePath must be a relative JSON path inside the workspace.',
                    location: '#',
                },
            ],
        };
    }
    try {
        const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(workspaceFolder.uri, ...relativePath.split('/'))
        );
        let input: unknown;
        try {
            input = JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch (error) {
            return {
                diagnostics: [
                    {
                        severity: 'error',
                        code: 'invalid-profile-json',
                        message: `OpenAPI profile is not valid JSON: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                        location: '#',
                    },
                ],
            };
        }
        const parsed = parseOpenApiGenerationProfile(input);
        return { profile: parsed.profile, diagnostics: parsed.diagnostics };
    } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            // Missing is an intentional catalogue-only mode, not an error.
            return { diagnostics: [] };
        }
        return {
            diagnostics: [
                {
                    severity: 'error',
                    code: 'profile-read-failed',
                    message: `Unable to read the OpenAPI profile: ${error instanceof Error ? error.message : String(error)}`,
                    location: '#',
                },
            ],
        };
    }
}

async function configureDocumentationStudio(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage(localize('noWorkspaceDocs', 'Open a workspace to configure documentation.'));
        return;
    }
    const configuration = vscode.workspace.getConfiguration('annotation', workspaceFolder.uri);
    const templateItems = listBuiltInDocumentTemplates().map((template) => ({
        label: template.label,
        description: template.id,
        detail: template.description,
        template,
    }));
    const selectedTemplate = configuration.get<string>('docs.template', 'complete');
    const picked = await vscode.window.showQuickPick(
        [
            ...templateItems,
            {
                label: 'Workspace JSON template',
                description: 'custom',
                detail: 'Versioned document structure stored with the project.',
                template: undefined,
            },
        ],
        {
            placeHolder: 'Choose a documentation structure template',
            title: 'Out-of-Code Insights Documentation Studio',
            matchOnDescription: true,
            matchOnDetail: true,
        }
    );
    if (!picked) {
        return;
    }

    let template = picked.template;
    if (!template) {
        const rawPath = configuration.get<string>(
            'docs.customTemplatePath',
            '.out-of-code-insights/document-template.json'
        );
        const relativePath = safeWorkspaceRelativePath(rawPath);
        if (!relativePath || !relativePath.toLowerCase().endsWith('.json')) {
            vscode.window.showErrorMessage(
                'annotation.docs.customTemplatePath must be a relative JSON path inside the workspace.'
            );
            return;
        }
        const templateUri = vscode.Uri.joinPath(workspaceFolder.uri, ...relativePath.split('/'));
        try {
            const bytes = await vscode.workspace.fs.readFile(templateUri);
            template = parseCustomDocumentTemplate(JSON.parse(Buffer.from(bytes).toString('utf8')));
        } catch (error) {
            const isMissing = error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
            if (!isMissing) {
                vscode.window.showErrorMessage(
                    `Unable to load the custom document template: ${error instanceof Error ? error.message : String(error)}`
                );
                return;
            }
            template = {
                ...(getBuiltInDocumentTemplate('complete') as DocumentTemplateDefinition),
                id: 'workspace-docs',
                label: `${workspaceFolder.name} documentation`,
                description: 'Workspace-owned documentation structure.',
            };
            const parentParts = relativePath.split('/');
            parentParts.pop();
            if (parentParts.length > 0) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, ...parentParts));
            }
            await vscode.workspace.fs.writeFile(
                templateUri,
                Buffer.from(
                    JSON.stringify(
                        {
                            $schema:
                                'https://raw.githubusercontent.com/JacquesGariepy/out-of-code-insights/main/schemas/document-template.schema.json',
                            ...template,
                        },
                        null,
                        2
                    ) + '\n',
                    'utf8'
                )
            );
        }
    }

    const currentOverride = configuration.get<string[]>('docs.formats', []);
    const activeFormats = new Set(
        currentOverride.length > 0
            ? currentOverride.map(normalizeDocumentationFormat).filter((value): value is DocumentationFormat => !!value)
            : template.formats
    );
    const formatLabels: Readonly<Record<DocumentationFormat, { label: string; detail: string }>> = {
        markdown: { label: 'Source documents', detail: 'Portable Markdown pages and inventories.' },
        'static-site': { label: 'Publishable static project', detail: 'Navigation, metadata and build configuration.' },
        wiki: { label: 'Portable wiki', detail: 'Host-neutral knowledge-base pages.' },
        'hosted-wiki': { label: 'Hosted wiki package', detail: 'Flattened pages with sidebar and footer.' },
        'ordered-wiki': { label: 'Ordered wiki package', detail: 'Hierarchical pages with explicit ordering files.' },
        html: { label: 'Standalone web documentation', detail: 'Accessible autonomous HTML with local assets.' },
        openapi: {
            label: 'API contract and catalogue',
            detail: 'Current OpenAPI revision with explicit operation bindings only.',
        },
    };
    const formatItems = SUPPORTED_DOCUMENTATION_FORMATS.map((format) => ({
        label: formatLabels[format].label,
        description: format,
        detail: formatLabels[format].detail,
        picked: activeFormats.has(format),
        format,
    }));
    const pickedFormats = await vscode.window.showQuickPick(formatItems, {
        canPickMany: true,
        placeHolder: 'Choose one or more generated formats',
        title: `${template.label} — output profiles`,
    });
    if (!pickedFormats || pickedFormats.length === 0) {
        return;
    }

    const currentDocuments = configuration.get<string[]>('docs.documents', []);
    const activeDocuments = new Set(currentDocuments.length > 0 ? currentDocuments : template.documents);
    const documentLabels: Readonly<Record<TechnicalDocumentKind, { label: string; detail: string }>> = {
        readme: { label: 'README', detail: 'Purpose, audience, quick start, usage and project links.' },
        changelog: { label: 'Changelog', detail: 'Curated releases, changes, fixes and security notes.' },
        architecture: { label: 'Architecture', detail: 'Context, components, constraints and technical views.' },
        adr: { label: 'Architecture decisions', detail: 'One stable, traceable record per decision.' },
        onboarding: {
            label: 'Developer onboarding',
            detail: 'Prerequisites, setup, development loop and first change.',
        },
        runbook: { label: 'Operational runbook', detail: 'Triggers, safeguards, steps, verification and rollback.' },
        reference: {
            label: 'Technical reference',
            detail: 'Structured concepts, configuration and API-oriented notes.',
        },
    };
    const documentItems = SUPPORTED_TECHNICAL_DOCUMENT_KINDS.map((kind) => ({
        label: documentLabels[kind].label,
        description: kind,
        detail: documentLabels[kind].detail,
        picked: activeDocuments.has(kind),
        documentKind: kind,
    }));
    const pickedDocuments = await vscode.window.showQuickPick(documentItems, {
        canPickMany: true,
        placeHolder: 'Choose one or more technical documents',
        title: `${template.label} — document catalogue`,
    });
    if (!pickedDocuments || pickedDocuments.length === 0) {
        return;
    }

    const templateId = picked.description === 'custom' ? 'custom' : template.id;
    await configuration.update('docs.template', templateId, vscode.ConfigurationTarget.Workspace);
    const selectedFormats = pickedFormats.map((item) => item.format);
    const followsTemplate =
        selectedFormats.length === template.formats.length &&
        template.formats.every((format) => selectedFormats.includes(format));
    await configuration.update(
        'docs.formats',
        followsTemplate ? [] : selectedFormats,
        vscode.ConfigurationTarget.Workspace
    );
    const selectedDocuments = pickedDocuments.map((item) => item.documentKind);
    const followsDocumentTemplate =
        selectedDocuments.length === template.documents.length &&
        template.documents.every((kind) => selectedDocuments.includes(kind));
    await configuration.update(
        'docs.documents',
        followsDocumentTemplate ? [] : selectedDocuments,
        vscode.ConfigurationTarget.Workspace
    );

    const generateLabel = 'Generate now';
    const choice = await vscode.window.showInformationMessage(
        `Documentation Studio configured: ${template.label}; ${selectedFormats.length} output(s), ${selectedDocuments.length} technical document(s).`,
        generateLabel
    );
    if (choice === generateLabel) {
        await generateDocumentationNow(false);
    } else if (selectedTemplate !== templateId) {
        getLogger().info(`Documentation template changed from ${selectedTemplate} to ${templateId}`);
    }
}

/**
 * Queue documentation requests so a watch update that lands during a manual
 * generation is applied afterwards instead of being silently discarded.
 */
function generateDocumentationNow(silent: boolean): Promise<void> {
    const run = docsGenerationQueue.then(() => generateDocumentationPass(silent));
    docsGenerationQueue = run.catch((error) => {
        getLogger().error('generateDocumentationNow: queued generation failed', error);
    });
    return run;
}

/**
 * Generate the annotation documentation site. Single implementation shared
 * by the `annotations.generateDocs` command (`silent === false`, surfaces
 * toasts and the Open prompt) and the docs watch mode (`silent === true`,
 * logs only — no UI noise on auto-regeneration).
 *
 * Requests are serialized by {@link generateDocumentationNow}; an empty
 * store still produces a valid empty portal so watch mode removes stale
 * pages after the last annotation is deleted.
 */
async function generateDocumentationPass(silent: boolean): Promise<void> {
    const store = annotationStore;
    if (!store) {
        if (silent) {
            getLogger().warn('generateDocumentationNow: annotation store not ready, skipping');
        } else {
            vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
        }
        return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        if (silent) {
            getLogger().warn('generateDocumentationNow: no workspace folder, skipping');
        } else {
            vscode.window.showErrorMessage(localize('noWorkspaceDocs', 'Open a workspace to generate documentation.'));
        }
        return;
    }
    const all = store.serialize().annotations;
    try {
        const docsConfig = vscode.workspace.getConfiguration('annotation', workspaceFolder.uri);
        const outDirSetting = safeWorkspaceRelativePath(docsConfig.get<string>('docs.outputPath', 'docs/annotations'));
        if (!outDirSetting) {
            const invalidPathMessage = localize(
                'docsPathInvalid',
                'annotation.docs.outputPath must be a non-empty relative path inside the workspace.'
            );
            if (silent) {
                getLogger().warn(`generateDocumentationNow: ${invalidPathMessage}`);
            } else {
                vscode.window.showErrorMessage(invalidPathMessage);
            }
            return;
        }
        const template = await loadDocumentTemplate(workspaceFolder, docsConfig);
        const formats = resolveDocumentationFormats(docsConfig, template);
        const documentKinds = resolveTechnicalDocumentKinds(docsConfig, template);
        const sanitizeSegment = (value: string, fallback: string): string => {
            const v = value.trim();
            return v.length === 0 || v.includes('..') || /[\\/]/.test(v) || path.isAbsolute(v) ? fallback : v;
        };
        const apiFolder = sanitizeSegment(
            explicitConfigurationValue<string>(docsConfig, 'docs.apiFolder') ?? template.apiFolder,
            template.apiFolder
        );
        const guideFile = sanitizeSegment(
            explicitConfigurationValue<string>(docsConfig, 'docs.guideFile') ?? template.guideFile,
            template.guideFile
        );
        const includeInventory =
            explicitConfigurationValue<boolean>(docsConfig, 'docs.includeInventory') ?? template.includeInventory;
        const includeAuthored =
            explicitConfigurationValue<boolean>(docsConfig, 'docs.includeAuthored') ?? template.includeAuthored;
        const includeTimestamp = docsConfig.get<boolean>('docs.includeTimestamp', true);
        const pageMetadata =
            explicitConfigurationValue<boolean>(docsConfig, 'docs.pageMetadata') ??
            docsConfig.get<boolean>('docs.frontMatter', false);
        const siteTitle = docsConfig.get<string>('docs.siteTitle', '').trim();
        const generatedAt = includeTimestamp ? new Date().toISOString() : undefined;

        // Resolve display lines per file. openTextDocument loads the
        // file into memory without showing it — cheap and works for
        // closed files; failures degrade to line -1 (link without
        // a line fragment).
        const lineByAnnotationId = new Map<string, number>();
        const anchorTextByAnnotationId = new Map<string, string>();
        const byUri = new Map<string, typeof all>();
        for (const a of all) {
            const bucket = byUri.get(a.fileUri);
            if (bucket) {
                bucket.push(a);
            } else {
                byUri.set(a.fileUri, [a]);
            }
        }
        for (const [uriStr, anns] of byUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
                for (const a of anns) {
                    const line = doc.positionAt(a.startOffset).line;
                    lineByAnnotationId.set(a.id, line);
                    anchorTextByAnnotationId.set(a.id, doc.lineAt(line).text);
                }
            } catch {
                for (const a of anns) {
                    lineByAnnotationId.set(a.id, -1);
                }
            }
        }

        const docAnnotations: DocAnnotation[] = all.map((a) => ({
            id: a.id,
            file: a.file,
            line: lineByAnnotationId.get(a.id) ?? -1,
            state: a.state,
            message: a.message,
            author: a.author,
            timestamp: a.timestamp,
            tags: a.tags,
            severity: a.severity,
            resolved: a.resolved,
            priority: a.priority,
            kanbanColumn: a.kanbanColumn,
            thread: a.thread,
            linkedAnnotations: a.linkedAnnotations,
            snippet: a.snippet,
            anchorText: anchorTextByAnnotationId.get(a.id),
            language: a.languageId,
        }));

        const depth = outDirSetting.split(/[\\/]/).filter((s) => s.length > 0).length;
        const title =
            siteTitle.length > 0 ? siteTitle : localize('docsTitle', 'Annotations — {0}', workspaceFolder.name);
        const configuredLanguage = docsConfig.get<string>('docs.language', '').trim();
        if (configuredLanguage && !isSupportedDocumentationLanguage(configuredLanguage)) {
            throw new Error(
                localize(
                    'docsLanguageInvalid',
                    'annotation.docs.language must use the canonical language[-Script][-REGION] subset, for example en, fr-CA or zh-Hant-TW.'
                )
            );
        }
        const openApi = formats.includes('openapi')
            ? await loadOpenApiGenerationProfile(workspaceFolder, docsConfig)
            : { diagnostics: [] as readonly OpenApiDiagnostic[] };
        const studio = generateDocumentationStudio(docAnnotations, {
            title,
            language: configuredLanguage || template.language,
            formats,
            technicalDocuments: documentKinds,
            sourceRootDepth: depth,
            openApiProfile: openApi.profile,
            openApiProfileDiagnostics: openApi.diagnostics,
            base: {
                generatedAt,
                tagPrefix: docsConfig.get<string>('docs.tagPrefix', 'doc:'),
                apiFolder,
                guideFile,
                includeInventory,
                includeAuthored,
                untaggedLabel: docsConfig.get<string>('docs.untaggedLabel', 'untagged'),
                pageMetadata,
            },
        });
        const files = studio.files;
        const diagnosticCounts = studio.diagnostics.reduce(
            (counts, diagnostic) => {
                counts[diagnostic.severity] += 1;
                return counts;
            },
            { error: 0, warning: 0, info: 0 }
        );
        for (const diagnostic of studio.diagnostics) {
            const detail = `${diagnostic.profile}/${diagnostic.code}: ${diagnostic.message}`;
            if (diagnostic.severity === 'error') {
                getLogger().error(`documentation studio: ${detail}`);
            } else if (diagnostic.severity === 'warning') {
                getLogger().warn(`documentation studio: ${detail}`);
            } else {
                getLogger().info(`documentation studio: ${detail}`);
            }
        }

        const outDir = vscode.Uri.joinPath(workspaceFolder.uri, ...outDirSetting.split(/[\\/]/));
        const extensionVersion =
            vscode.extensions.getExtension('jacquesgariepy.out-of-code-insights')?.packageJSON.version ?? 'development';
        const writeResult = await writeDocumentationBundle(workspaceFolder.uri, outDir, files, {
            generatorVersion: String(extensionVersion),
            template: template.id,
            formats,
            generatedAt,
        });
        for (const warning of writeResult.warnings) {
            getLogger().warn(`documentation writer: ${warning}`);
        }

        if (silent) {
            const count = String(docAnnotations.length);
            getLogger().info(
                `docs watch: regenerated ${writeResult.written} file(s) for ${count} annotation(s) in ${outDirSetting}; ` +
                    `${diagnosticCounts.error} error(s), ${diagnosticCounts.warning} warning(s)`
            );
            return;
        }

        const openDocumentationLabel = localize('openDocs', 'Open documentation');
        const openReportLabel = localize('openDocsReport', 'Open report');
        const summary = localize(
            'docsGeneratedWithDiagnostics',
            'Documentation generated from {0} annotation(s) in {1}: {2} error(s), {3} warning(s).',
            docAnnotations.length,
            outDirSetting,
            diagnosticCounts.error,
            diagnosticCounts.warning
        );
        const actions = [openDocumentationLabel, openReportLabel] as const;
        const choice =
            diagnosticCounts.error > 0 || diagnosticCounts.warning > 0 || writeResult.warnings.length > 0
                ? await vscode.window.showWarningMessage(summary, ...actions)
                : await vscode.window.showInformationMessage(summary, ...actions);
        const target =
            choice === openDocumentationLabel
                ? studio.entryPoint
                : choice === openReportLabel
                  ? 'documentation-report.json'
                  : undefined;
        if (target) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(outDir, ...target.split('/')));
            await vscode.window.showTextDocument(document);
        }
    } catch (err) {
        if (silent) {
            getLogger().error('generateDocumentationNow: watch regeneration failed', err);
        } else {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(localize('docsFailed', 'Failed to generate documentation') + `: ${msg}`);
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Lot 5 R2 finalisation — Kanban command handlers
// ───────────────────────────────────────────────────────────────────────────
//
// The Kanban webview (`src/views/KanbanView.ts`) emits commands rather than
// owning state directly. Annotation→column mappings flow through
// `KanbanColumnStore` (workspaceState-backed). Column DEFINITIONS (id → name)
// live in a separate Memento entry to keep the column store API focused on a
// single concern.
//
// Mutation flow: `kanban.moveToColumn` → `KanbanColumnStore.setColumn` → the
// single panel-scoped listener owned by KanbanView refreshes the webview.

const KANBAN_COLUMN_DEFINITIONS_KEY = 'outOfCodeInsights.kanban.columnDefinitions';
const KANBAN_DEFAULT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
    ['todo', 'To Do'],
    ['in-progress', 'In Progress'],
    ['review', 'Review'],
    ['done', 'Done'],
];
const KANBAN_MAX_COLUMNS = 50;
const KANBAN_MAX_COLUMN_ID_LENGTH = 64;
const KANBAN_MAX_COLUMN_NAME_LENGTH = 80;

function hasControlCharacters(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
    });
}

export function isValidKanbanColumnId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= KANBAN_MAX_COLUMN_ID_LENGTH &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    );
}

export function isValidKanbanColumnName(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= KANBAN_MAX_COLUMN_NAME_LENGTH &&
        value.trim() === value &&
        !hasControlCharacters(value)
    );
}

/** Strictly validate persisted and API-facing Kanban column definitions. */
export function validateKanbanColumnDefinitions(value: unknown): [string, string][] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > KANBAN_MAX_COLUMNS) {
        return undefined;
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    const columns: [string, string][] = [];
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            return undefined;
        }
        const [id, name] = entry as [unknown, unknown];
        if (!isValidKanbanColumnId(id) || !isValidKanbanColumnName(name)) {
            return undefined;
        }
        const comparableName = name.toLocaleLowerCase();
        if (ids.has(id) || names.has(comparableName)) {
            return undefined;
        }
        ids.add(id);
        names.add(comparableName);
        columns.push([id, name]);
    }
    // Unassigned annotations use `todo`; retaining it guarantees every visible
    // card always has a real destination column.
    return ids.has('todo') ? columns : undefined;
}

export function getKanbanColumnAssignmentIds(assignments: ReadonlyMap<string, string>, columnId: string): string[] {
    return Array.from(assignments)
        .filter(([, assignedColumn]) => assignedColumn === columnId)
        .map(([annotationId]) => annotationId);
}

interface StoreLinkCommandOptions {
    targetId?: string;
    targetIndex?: number;
    relationship?: string;
    targetFileUri?: string;
    targetLine?: number;
    message?: string;
    confirmed?: boolean;
}

function storeLinkCommandOptions(commandArg: unknown): StoreLinkCommandOptions {
    if (!commandArg || typeof commandArg !== 'object') {
        return {};
    }
    const raw = commandArg as Record<string, unknown>;
    return {
        ...(typeof raw.targetId === 'string' ? { targetId: raw.targetId } : {}),
        ...(typeof raw.targetIndex === 'number' ? { targetIndex: raw.targetIndex } : {}),
        ...(typeof raw.relationship === 'string' ? { relationship: raw.relationship } : {}),
        ...(typeof raw.targetFileUri === 'string' ? { targetFileUri: raw.targetFileUri } : {}),
        ...(typeof raw.targetLine === 'number' ? { targetLine: raw.targetLine } : {}),
        ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
        ...(raw.confirmed === true ? { confirmed: true } : {}),
    };
}

function requireStoreLinkServices(): { store: AnnotationStore; manager: AnnotationManager } | undefined {
    if (!annotationStore || !annotationManager) {
        vscode.window.showErrorMessage(
            loc(
                'linkServicesNotReady',
                'Annotation links are not ready yet. Try again after the workspace finishes loading.'
            )
        );
        return undefined;
    }
    return { store: annotationStore, manager: annotationManager };
}

function reportStoreLinkError(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error(`Annotation link command failed: ${operation}`, error);
    vscode.window.showErrorMessage(loc('annotationLinkCommandFailed', 'Unable to {0}: {1}', operation, message));
}

function normalizedRelationship(value: string): string {
    const relationship = value.trim();
    if (relationship.length === 0 || relationship.length > 80) {
        throw new Error(loc('invalidLinkRelationship', 'A relationship must contain from 1 to 80 characters.'));
    }
    return relationship;
}

async function pickLinkRelationship(supplied: string | undefined, programmatic: boolean): Promise<string | undefined> {
    if (supplied !== undefined) {
        return normalizedRelationship(supplied);
    }
    if (programmatic) {
        return 'related';
    }

    const customValue = '__custom__';
    const picked = await vscode.window.showQuickPick(
        [
            { label: '$(link) ' + loc('relationshipRelated', 'Related'), value: 'related' },
            { label: '$(references) ' + loc('relationshipReferences', 'References'), value: 'references' },
            { label: '$(symbol-interface) ' + loc('relationshipImplements', 'Implements'), value: 'implements' },
            { label: '$(circle-slash) ' + loc('relationshipBlocks', 'Blocks'), value: 'blocks' },
            { label: '$(copy) ' + loc('relationshipDuplicates', 'Duplicates'), value: 'duplicates' },
            { label: '$(beaker) ' + loc('relationshipTests', 'Tests'), value: 'tests' },
            { label: '$(edit) ' + loc('relationshipCustom', 'Custom relationship…'), value: customValue },
        ],
        {
            title: loc('linkRelationshipTitle', 'Link relationship'),
            placeHolder: loc('linkRelationshipPlaceholder', 'Describe how the two annotations are related'),
        }
    );
    if (!picked) {
        return undefined;
    }
    if (picked.value !== customValue) {
        return picked.value;
    }
    const custom = await vscode.window.showInputBox({
        title: loc('customRelationshipTitle', 'Custom link relationship'),
        prompt: loc('customRelationshipPrompt', 'Enter a short relationship name'),
        validateInput: (value) => {
            const trimmed = value.trim();
            return trimmed.length >= 1 && trimmed.length <= 80
                ? undefined
                : loc('invalidLinkRelationship', 'A relationship must contain from 1 to 80 characters.');
        },
    });
    return custom === undefined ? undefined : normalizedRelationship(custom);
}

async function pickOutgoingStoreLink(
    annotation: Readonly<AnnotationV2>,
    suppliedIndex: number | undefined,
    placeHolder: string
): Promise<{ link: LinkedAnnotation; index: number } | undefined> {
    const links = annotation.linkedAnnotations ?? [];
    if (links.length === 0) {
        vscode.window.showInformationMessage(
            loc('annotationHasNoOutgoingLinks', 'This annotation has no outgoing links.')
        );
        return undefined;
    }
    if (suppliedIndex !== undefined) {
        if (!Number.isInteger(suppliedIndex) || suppliedIndex < 0 || suppliedIndex >= links.length) {
            throw new Error(loc('invalidLinkIndex', 'The selected link no longer exists.'));
        }
        return { link: links[suppliedIndex], index: suppliedIndex };
    }
    if (links.length === 1) {
        return { link: links[0], index: 0 };
    }
    return await vscode.window.showQuickPick(
        links.map((link, index) => {
            const target = link.targetId ? annotationStore?.get(link.targetId) : undefined;
            const targetLine = target
                ? annotationStore?.getLineForAnnotation(target.id, vscode.workspace.textDocuments)
                : link.targetLine;
            return {
                label: `$(arrow-right) ${link.relationship || 'related'}`,
                description: formatAnnotationLocation(target?.file ?? link.targetFile, targetLine ?? null),
                detail: loc('outgoingLinkDetail', 'Outgoing link'),
                link,
                index,
            };
        }),
        { placeHolder, matchOnDescription: true, matchOnDetail: true }
    );
}

function linkFileTargetsAnnotation(linkFile: string, annotation: Readonly<AnnotationV2>): boolean {
    if (linkFile === annotation.file || linkFile === annotation.fileUri) {
        return true;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(linkFile)) {
        try {
            if (vscode.Uri.parse(linkFile).toString() === vscode.Uri.parse(annotation.fileUri).toString()) {
                return true;
            }
        } catch {
            // Fall through to the display-path comparison below.
        }
    }
    const normalizePath = (value: string): string => {
        const normalized = value.replace(/\\/g, '/');
        return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
    };
    return normalizePath(linkFile) === normalizePath(annotation.file);
}

async function pickNewLinkedAnnotationTarget(options: StoreLinkCommandOptions): Promise<
    | {
          document: vscode.TextDocument;
          line: number;
          message: string;
      }
    | undefined
> {
    let targetUri: vscode.Uri | undefined;
    if (options.targetFileUri) {
        try {
            targetUri = vscode.Uri.parse(options.targetFileUri, true);
        } catch {
            throw new Error(loc('invalidTargetFileUri', 'The target file URI is invalid.'));
        }
    } else {
        [targetUri] =
            (await vscode.window.showOpenDialog({
                title: loc('selectLinkedAnnotationFile', 'Select a file for the linked annotation'),
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: loc('selectFile', 'Select file'),
            })) ?? [];
    }
    if (!targetUri) {
        return undefined;
    }
    if (targetUri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(targetUri) === undefined) {
        vscode.window.showWarningMessage(
            loc('linkedAnnotationWorkspaceFileRequired', 'Select a saved file inside the current workspace.')
        );
        return undefined;
    }

    const document = await vscode.workspace.openTextDocument(targetUri);
    let line = options.targetLine;
    if (line !== undefined && (!Number.isInteger(line) || line < 0 || line >= document.lineCount)) {
        throw new Error(
            loc('invalidLinkedAnnotationLine', 'The target line must be between 1 and {0}.', document.lineCount)
        );
    }
    if (line === undefined) {
        const activeEditor = vscode.window.activeTextEditor;
        const suggestedLine =
            activeEditor?.document.uri.toString() === targetUri.toString() ? activeEditor.selection.active.line + 1 : 1;
        const lineInput = await vscode.window.showInputBox({
            title: loc('linkedAnnotationLineTitle', 'Linked annotation location'),
            prompt: loc('linkedAnnotationLinePrompt', 'Enter a line number from 1 to {0}', document.lineCount),
            value: String(suggestedLine),
            validateInput: (value) => {
                const oneBased = Number(value);
                return Number.isInteger(oneBased) && oneBased >= 1 && oneBased <= document.lineCount
                    ? undefined
                    : loc(
                          'invalidLinkedAnnotationLine',
                          'The target line must be between 1 and {0}.',
                          document.lineCount
                      );
            },
        });
        if (lineInput === undefined) {
            return undefined;
        }
        line = Number(lineInput) - 1;
    }

    let message = options.message;
    if (message === undefined) {
        message = await vscode.window.showInputBox({
            title: loc('newLinkedAnnotationTitle', 'New linked annotation'),
            prompt: loc('newLinkedAnnotationPrompt', 'Describe the annotation to create at the target location'),
            validateInput: (value) =>
                value.trim().length > 0 ? undefined : loc('emptyMessageError', 'Message cannot be empty'),
        });
    }
    if (message === undefined) {
        return undefined;
    }
    if (message.trim().length === 0) {
        throw new Error(loc('emptyMessageError', 'Message cannot be empty'));
    }
    return { document, line, message };
}

function registerStoreLinkCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.createLink', async (commandArg?: unknown): Promise<number> => {
            const services = requireStoreLinkServices();
            if (!services) {
                return 0;
            }
            const { store, manager } = services;
            const options = storeLinkCommandOptions(commandArg);
            const sourceId = await pickStoreAnnotationId(
                commandArg,
                loc('selectSourceAnnotationForLink', 'Select the annotation that will own the link')
            );
            const source = sourceId ? store.get(sourceId) : undefined;
            if (!source) {
                return 0;
            }

            try {
                const existingTargets = store.list().filter((annotation) => annotation.id !== source.id);
                let targetId = options.targetId;
                let createNew = options.targetFileUri !== undefined;

                if (!targetId && !createNew) {
                    const actions = [
                        ...(existingTargets.length > 0
                            ? [
                                  {
                                      label: '$(link) ' + loc('linkExistingAnnotation', 'Link an existing annotation'),
                                      value: 'existing' as const,
                                      description: loc(
                                          'linkExistingAnnotationDescription',
                                          'Choose from {0} other annotation(s)',
                                          existingTargets.length
                                      ),
                                  },
                              ]
                            : []),
                        {
                            label: '$(add) ' + loc('createLinkedAnnotation', 'Create a linked annotation'),
                            value: 'new' as const,
                            description: loc(
                                'createLinkedAnnotationDescription',
                                'Choose a workspace file, line and message'
                            ),
                        },
                    ];
                    const action = await vscode.window.showQuickPick(actions, {
                        title: loc('createAnnotationLinkTitle', 'Create annotation link'),
                        placeHolder: loc('createAnnotationLinkPlaceholder', 'Choose how to create the link'),
                        matchOnDescription: true,
                    });
                    if (!action) {
                        return 0;
                    }
                    createNew = action.value === 'new';
                }

                if (!createNew) {
                    if (targetId === source.id) {
                        throw new Error(loc('cannotLinkAnnotationToItself', 'An annotation cannot link to itself.'));
                    }
                    if (targetId && !store.get(targetId)) {
                        throw new Error(loc('targetAnnotationNotFound', 'The target annotation was not found.'));
                    }
                    if (!targetId) {
                        const target = await vscode.window.showQuickPick(
                            existingTargets.map((annotation) => ({
                                label: firstMessageLine(annotation.message) || annotation.id,
                                description: formatAnnotationLocation(
                                    annotation.file,
                                    store.getLineForAnnotation(annotation.id, vscode.workspace.textDocuments)
                                ),
                                detail: annotation.resolved
                                    ? loc('resolvedAnnotation', 'Resolved annotation')
                                    : loc('openAnnotation', 'Open annotation'),
                                id: annotation.id,
                            })),
                            {
                                title: loc('selectLinkTargetTitle', 'Select link target'),
                                placeHolder: loc('selectLinkTargetPlaceholder', 'Select the annotation to link to'),
                                matchOnDescription: true,
                                matchOnDetail: true,
                            }
                        );
                        targetId = target?.id;
                    }
                    if (!targetId) {
                        return 0;
                    }
                    const relationship = await pickLinkRelationship(
                        options.relationship,
                        options.targetId !== undefined
                    );
                    if (!relationship) {
                        return 0;
                    }
                    const target = await resolveStoreAnnotationLocation(targetId);
                    await manager.createLinkedAnnotation(
                        source.id,
                        target.annotation.file,
                        target.line,
                        relationship,
                        target.annotation.id
                    );
                    vscode.window.showInformationMessage(
                        loc(
                            'annotationLinkCreated',
                            'Linked annotation to {0} ({1}).',
                            formatAnnotationLocation(target.annotation.file, target.line),
                            relationship
                        )
                    );
                    return 1;
                }

                const target = await pickNewLinkedAnnotationTarget(options);
                if (!target) {
                    return 0;
                }
                const relationship = await pickLinkRelationship(
                    options.relationship,
                    options.targetFileUri !== undefined
                );
                if (!relationship) {
                    return 0;
                }
                const annotationConfig = vscode.workspace.getConfiguration('annotation');
                const fileUri = target.document.uri.toString();
                const maxPerFile = annotationConfig.get<number>('maxAnnotationsPerFile', 1000);
                if (maxPerFile > 0 && store.listForFile(fileUri).length >= maxPerFile) {
                    vscode.window.showWarningMessage(
                        loc('maxAnnotationsReached', 'This file has reached its limit of {0} annotations.', maxPerFile)
                    );
                    return 0;
                }

                store.beginTransaction();
                try {
                    const created = store.add(
                        {
                            fileUri,
                            file: vscode.workspace.asRelativePath(target.document.uri),
                            origin: { kind: 'manual' },
                            message: target.message,
                            author: annotationConfig.get<string>('username', 'Anonymous').trim() || 'Anonymous',
                            timestamp: new Date().toISOString(),
                            severity: annotationConfig.get<string>('defaultSeverity', 'info'),
                            languageId: target.document.languageId,
                        },
                        { line: target.line },
                        target.document
                    );
                    await manager.createLinkedAnnotation(
                        source.id,
                        created.file,
                        target.line,
                        relationship,
                        created.id
                    );
                    store.commit();
                    vscode.window.showInformationMessage(
                        loc(
                            'linkedAnnotationCreated',
                            'Created and linked annotation at {0}.',
                            formatAnnotationLocation(created.file, target.line)
                        )
                    );
                    return 1;
                } catch (error) {
                    store.rollback();
                    throw error;
                }
            } catch (error) {
                reportStoreLinkError(loc('createAnnotationLinkOperation', 'create the annotation link'), error);
                return 0;
            }
        }),

        vscode.commands.registerCommand(
            'annotations.navigateToLinked',
            async (commandArg?: unknown): Promise<number> => {
                const services = requireStoreLinkServices();
                if (!services) {
                    return 0;
                }
                const options = storeLinkCommandOptions(commandArg);
                const sourceId = await pickStoreAnnotationId(
                    commandArg,
                    loc('selectAnnotationWithLinks', 'Select an annotation with outgoing links')
                );
                const source = sourceId ? services.store.get(sourceId) : undefined;
                if (!source) {
                    return 0;
                }
                try {
                    const selected = await pickOutgoingStoreLink(
                        source,
                        options.targetIndex,
                        loc('selectLinkedAnnotationToOpen', 'Select a linked annotation to open')
                    );
                    if (!selected) {
                        return 0;
                    }
                    await services.manager.navigateToLinked(source.id, selected.index);
                    return 1;
                } catch (error) {
                    reportStoreLinkError(loc('navigateAnnotationLinkOperation', 'open the linked annotation'), error);
                    return 0;
                }
            }
        ),

        vscode.commands.registerCommand('annotations.showLinks', async (commandArg?: unknown): Promise<number> => {
            const services = requireStoreLinkServices();
            if (!services) {
                return 0;
            }
            const sourceId = await pickStoreAnnotationId(
                commandArg,
                loc('selectAnnotationToShowLinks', 'Select an annotation whose links you want to inspect')
            );
            const source = sourceId ? services.store.get(sourceId) : undefined;
            if (!source) {
                return 0;
            }
            try {
                const { line: sourceLine } = await resolveStoreAnnotationLocation(source.id);
                type LinkListItem = vscode.QuickPickItem &
                    ({ direction: 'outgoing'; index: number } | { direction: 'incoming'; sourceId: string });
                const items: LinkListItem[] = (source.linkedAnnotations ?? []).map((link, index) => ({
                    label: `$(arrow-right) ${link.relationship || 'related'}: ${formatAnnotationLocation(link.targetFile, link.targetLine)}`,
                    detail: loc('outgoingLinkDetail', 'Outgoing link'),
                    direction: 'outgoing',
                    index,
                }));
                for (const candidate of services.store.list()) {
                    for (const link of candidate.linkedAnnotations ?? []) {
                        if (
                            link.targetId === source.id ||
                            (!link.targetId &&
                                link.targetLine === sourceLine &&
                                linkFileTargetsAnnotation(link.targetFile, source))
                        ) {
                            items.push({
                                label: `$(arrow-left) ${link.relationship || 'related'} ← ${firstMessageLine(candidate.message) || candidate.id}`,
                                description: candidate.file,
                                detail: loc('incomingLinkDetail', 'Incoming link'),
                                direction: 'incoming',
                                sourceId: candidate.id,
                            });
                        }
                    }
                }
                if (items.length === 0) {
                    vscode.window.showInformationMessage(
                        loc('annotationHasNoLinks', 'This annotation has no incoming or outgoing links.')
                    );
                    return 0;
                }
                const selected = await vscode.window.showQuickPick(items, {
                    title: loc('annotationLinksTitle', 'Annotation links'),
                    placeHolder: loc('annotationLinksPlaceholder', 'Select a link to navigate to its other endpoint'),
                    matchOnDescription: true,
                    matchOnDetail: true,
                });
                if (!selected) {
                    return 0;
                }
                if (selected.direction === 'outgoing') {
                    await services.manager.navigateToLinked(source.id, selected.index);
                } else {
                    await openStoreAnnotation(selected.sourceId);
                }
                return 1;
            } catch (error) {
                reportStoreLinkError(loc('showAnnotationLinksOperation', 'show annotation links'), error);
                return 0;
            }
        }),

        vscode.commands.registerCommand('annotations.removeLink', async (commandArg?: unknown): Promise<number> => {
            const services = requireStoreLinkServices();
            if (!services) {
                return 0;
            }
            const options = storeLinkCommandOptions(commandArg);
            const sourceId = await pickStoreAnnotationId(
                commandArg,
                loc('selectAnnotationToRemoveLink', 'Select the annotation whose link you want to remove')
            );
            const source = sourceId ? services.store.get(sourceId) : undefined;
            if (!source) {
                return 0;
            }
            try {
                const selected = await pickOutgoingStoreLink(
                    source,
                    options.targetIndex,
                    loc('selectLinkToRemove', 'Select the outgoing link to remove')
                );
                if (!selected) {
                    return 0;
                }
                if (!options.confirmed) {
                    const removeLabel = loc('removeAnnotationLink', 'Remove link');
                    const confirmation = await vscode.window.showWarningMessage(
                        loc(
                            'confirmRemoveAnnotationLink',
                            'Remove the {0} link to {1}?',
                            selected.link.relationship || 'related',
                            formatAnnotationLocation(selected.link.targetFile, selected.link.targetLine)
                        ),
                        { modal: true },
                        removeLabel
                    );
                    if (confirmation !== removeLabel) {
                        return 0;
                    }
                }
                await services.manager.removeLinkedAnnotation(
                    source.id,
                    selected.link.targetFile,
                    selected.link.targetLine,
                    selected.link.targetId
                );
                vscode.window.showInformationMessage(loc('annotationLinkRemoved', 'Annotation link removed.'));
                return 1;
            } catch (error) {
                reportStoreLinkError(loc('removeAnnotationLinkOperation', 'remove the annotation link'), error);
                return 0;
            }
        })
    );
}

async function pickStoreAnnotationId(commandArg: unknown, placeHolder: string): Promise<string | undefined> {
    const store = annotationStore;
    if (!store) {
        vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
        return undefined;
    }
    const suppliedId = annotationIdFromCommandArg(commandArg);
    if (suppliedId && store.get(suppliedId)) {
        return suppliedId;
    }

    const editor = vscode.window.activeTextEditor;
    const cursorMatches = editor
        ? store
              .getByFile(editor.document.uri.toString())
              .filter(
                  (annotation) =>
                      editor.document.positionAt(annotation.startOffset).line === editor.selection.active.line
              )
        : [];
    const candidates = cursorMatches.length > 0 ? cursorMatches : store.list();
    if (candidates.length === 0) {
        vscode.window.showInformationMessage(loc('noAnnotations', 'No annotations found.'));
        return undefined;
    }
    if (candidates.length === 1) {
        return candidates[0].id;
    }
    return (
        await vscode.window.showQuickPick(
            candidates.map((annotation) => ({
                label: firstMessageLine(annotation.message) || annotation.id,
                description: annotation.file,
                detail: annotation.resolved
                    ? loc('resolvedAnnotation', 'Resolved annotation')
                    : loc('openAnnotation', 'Open annotation'),
                id: annotation.id,
            })),
            { placeHolder, matchOnDescription: true, matchOnDetail: true }
        )
    )?.id;
}

async function resolveStoreAnnotationLocation(annotationId: string): Promise<{
    annotation: Readonly<AnnotationV2>;
    document: vscode.TextDocument;
    line: number;
}> {
    const annotation = annotationStore?.get(annotationId);
    if (!annotation) {
        throw new Error(loc('annotationNotFound', 'Annotation not found.'));
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(annotation.fileUri));
    return { annotation, document, line: document.positionAt(annotation.startOffset).line };
}

async function openStoreAnnotation(annotationId: string): Promise<void> {
    const { document, annotation } = await resolveStoreAnnotationLocation(annotationId);
    const editor = await vscode.window.showTextDocument(document);
    const position = document.positionAt(annotation.startOffset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    annotationManager?.navigationStack.push(annotationId);
}

function loadKanbanColumns(context: vscode.ExtensionContext): [string, string][] {
    const stored = validateKanbanColumnDefinitions(context.workspaceState.get<unknown>(KANBAN_COLUMN_DEFINITIONS_KEY));
    if (stored) {
        return stored;
    }
    return KANBAN_DEFAULT_COLUMNS.map(([id, name]) => [id, name] as [string, string]);
}

async function saveKanbanColumns(context: vscode.ExtensionContext, columns: [string, string][]): Promise<void> {
    const validated = validateKanbanColumnDefinitions(columns);
    if (!validated) {
        throw new TypeError('Invalid Kanban column definitions');
    }
    await context.workspaceState.update(KANBAN_COLUMN_DEFINITIONS_KEY, validated);
    KanbanView.updateCurrentColumns(validated);
}

function rejectKanbanCommand(message: string): false {
    void vscode.window.showErrorMessage(message);
    return false;
}

function isKnownKanbanAnnotationId(value: unknown, store: AnnotationStore): value is string {
    return typeof value === 'string' && value.length > 0 && store.get(value) !== undefined;
}

function sameKanbanColumnIds(left: readonly [string, string][], right: readonly [string, string][]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const rightIds = new Set(right.map(([id]) => id));
    return left.every(([id]) => rightIds.has(id));
}

function registerKanbanCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.addKanbanColumn', async () => {
            const existing = loadKanbanColumns(context);
            if (existing.length >= KANBAN_MAX_COLUMNS) {
                rejectKanbanCommand(
                    loc('kanbanTooManyColumns', 'The Kanban board already has the maximum number of columns.')
                );
                return false;
            }
            const name = await vscode.window.showInputBox({
                title: loc('kanbanAddColumnTitle', 'Add Kanban column'),
                prompt: loc('kanbanColumnPrompt', 'Enter a name for the new column'),
                placeHolder: loc('kanbanColumnPlaceholder', 'For example: Testing or Blocked'),
                validateInput: (value) => {
                    const trimmed = value.trim();
                    if (!isValidKanbanColumnName(trimmed)) {
                        return loc('kanbanColumnRequired', 'Column name is required.');
                    }
                    return existing.some(
                        ([, current]) => current.localeCompare(trimmed, undefined, { sensitivity: 'accent' }) === 0
                    )
                        ? loc('kanbanColumnDuplicate', 'A Kanban column already uses this name.')
                        : undefined;
                },
            });
            if (!name) {
                return false;
            }
            const trimmed = name.trim();
            const rawBaseId =
                trimmed
                    .normalize('NFKD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '') || 'column';
            const baseId = rawBaseId.slice(0, KANBAN_MAX_COLUMN_ID_LENGTH).replace(/-+$/g, '') || 'column';
            const ids = new Set(existing.map(([id]) => id));
            let id = baseId;
            for (let suffix = 2; ids.has(id); suffix += 1) {
                const suffixText = `-${suffix}`;
                id = `${baseId.slice(0, KANBAN_MAX_COLUMN_ID_LENGTH - suffixText.length).replace(/-+$/g, '')}${suffixText}`;
            }
            existing.push([id, trimmed]);
            await saveKanbanColumns(context, existing);
            void vscode.window.showInformationMessage(loc('kanbanColumnAdded', 'Kanban column "{0}" added.', trimmed));
            return true;
        }),

        vscode.commands.registerCommand('annotations.moveToColumn', async (commandArg?: unknown) => {
            const annotationId = await pickStoreAnnotationId(
                commandArg,
                loc('selectAnnotationForKanban', 'Select an annotation to move')
            );
            if (!annotationId || !kanbanColumnStore || !annotationStore) {
                return false;
            }
            const currentColumn = kanbanColumnStore.getColumn(annotationId) ?? 'todo';
            const column = await vscode.window.showQuickPick(
                loadKanbanColumns(context).map(([id, name]) => ({
                    label: name,
                    description: id === currentColumn ? loc('currentKanbanColumn', 'Current column') : undefined,
                    id,
                })),
                { placeHolder: loc('selectKanbanColumn', 'Select the destination Kanban column') }
            );
            if (!column) {
                return false;
            }
            await kanbanColumnStore.setColumn(annotationId, column.id);
            void vscode.window.showInformationMessage(
                loc('annotationMovedTo', 'Annotation moved to {0}.', column.label)
            );
            return true;
        }),

        // Returns the current column definitions to the webview. Webview
        // expects `[string, string][]` (id → name pairs); falls back on a
        // default set when the workspace has no override.
        vscode.commands.registerCommand('annotations.kanban.getColumns', () => loadKanbanColumns(context)),

        // Move an annotation to a different real column. KanbanView owns the
        // one panel-scoped KanbanColumnStore listener that refreshes the card.
        vscode.commands.registerCommand(
            'annotations.kanban.moveToColumn',
            async (annotationId: unknown, columnId: unknown): Promise<boolean> => {
                if (!kanbanColumnStore || !annotationStore) {
                    return rejectKanbanCommand(loc('kanbanNotReady', 'The Kanban board is not ready yet.'));
                }
                if (!isKnownKanbanAnnotationId(annotationId, annotationStore)) {
                    return rejectKanbanCommand(loc('kanbanInvalidAnnotation', 'Select an existing annotation.'));
                }
                if (
                    !isValidKanbanColumnId(columnId) ||
                    !loadKanbanColumns(context).some(([existingId]) => existingId === columnId)
                ) {
                    return rejectKanbanCommand(loc('kanbanInvalidDestination', 'Select an existing Kanban column.'));
                }
                await kanbanColumnStore.setColumn(annotationId, columnId);
                return true;
            }
        ),

        // Remove an annotation from the Kanban without deleting it from
        // the store (annotation stays attached to its source code).
        vscode.commands.registerCommand('annotations.kanban.removeFromKanban', async (annotationId: unknown) => {
            if (!kanbanColumnStore || !annotationStore) {
                return rejectKanbanCommand(loc('kanbanNotReady', 'The Kanban board is not ready yet.'));
            }
            if (!isKnownKanbanAnnotationId(annotationId, annotationStore)) {
                return rejectKanbanCommand(loc('kanbanInvalidAnnotation', 'Select an existing annotation.'));
            }
            await kanbanColumnStore.setColumn(annotationId, KANBAN_HIDDEN_COLUMN_ID);
            return true;
        }),

        // Permanently delete an annotation from the store AND clear its
        // Kanban column entry. Triggered from the Kanban "delete" path.
        vscode.commands.registerCommand('annotations.kanban.delete', async (annotationId: unknown) => {
            if (!annotationStore || !kanbanColumnStore) {
                return rejectKanbanCommand(loc('kanbanNotReady', 'The Kanban board is not ready yet.'));
            }
            if (!isKnownKanbanAnnotationId(annotationId, annotationStore)) {
                return rejectKanbanCommand(loc('kanbanInvalidAnnotation', 'Select an existing annotation.'));
            }
            annotationStore.remove(annotationId);
            await kanbanColumnStore.clearColumn(annotationId);
            return true;
        }),

        // Append a new column definition to the workspace's Kanban layout.
        vscode.commands.registerCommand('annotations.kanban.addColumn', async (id: unknown, name: unknown) => {
            const columns = loadKanbanColumns(context);
            if (!isValidKanbanColumnId(id) || !isValidKanbanColumnName(name)) {
                return rejectKanbanCommand(
                    loc('kanbanInvalidColumnArguments', 'Enter a valid, non-empty Kanban column name.')
                );
            }
            if (columns.length >= KANBAN_MAX_COLUMNS) {
                return rejectKanbanCommand(
                    loc('kanbanTooManyColumns', 'The Kanban board already has the maximum number of columns.')
                );
            }
            if (
                columns.some(
                    ([columnId, columnName]) =>
                        columnId === id || columnName.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
                )
            ) {
                return rejectKanbanCommand(
                    loc('kanbanColumnDuplicate', 'A Kanban column already uses this name or identifier.')
                );
            }
            columns.push([id, name]);
            await saveKanbanColumns(context, columns);
            return true;
        }),

        // Replace the entire column-definition layout. Used by rename flows.
        vscode.commands.registerCommand('annotations.kanban.updateColumns', async (value: unknown) => {
            const columns = validateKanbanColumnDefinitions(value);
            const existing = loadKanbanColumns(context);
            if (!columns || !sameKanbanColumnIds(columns, existing)) {
                return rejectKanbanCommand(
                    loc('kanbanInvalidColumnLayout', 'The Kanban column layout is invalid or removes existing columns.')
                );
            }
            await saveKanbanColumns(context, columns);
            return true;
        }),

        // A used column cannot be deleted implicitly: moving its cards is an
        // explicit operation, preventing silent workflow-state changes.
        vscode.commands.registerCommand('annotations.kanban.deleteColumn', async (id: unknown) => {
            if (!kanbanColumnStore || !annotationStore) {
                return rejectKanbanCommand(loc('kanbanNotReady', 'The Kanban board is not ready yet.'));
            }
            const existing = loadKanbanColumns(context);
            if (!isValidKanbanColumnId(id) || !existing.some(([columnId]) => columnId === id)) {
                return rejectKanbanCommand(loc('kanbanUnknownColumn', 'Select an existing Kanban column.'));
            }
            if (id === 'todo') {
                return rejectKanbanCommand(
                    loc('kanbanDefaultColumnRequired', 'The default “To Do” column cannot be deleted.')
                );
            }
            const allAssignedIds = getKanbanColumnAssignmentIds(kanbanColumnStore.getAllColumns(), id);
            const assignedIds = allAssignedIds.filter((annotationId) => annotationStore?.get(annotationId));
            if (assignedIds.length > 0) {
                void vscode.window.showWarningMessage(
                    loc(
                        'kanbanColumnInUse',
                        'This column still contains {0} annotation(s). Move or remove those cards before deleting it.',
                        assignedIds.length
                    )
                );
                return false;
            }
            const deleteLabel = loc('delete', 'Delete');
            const result = await vscode.window.showWarningMessage(
                loc('kanbanDeleteEmptyColumnConfirm', 'Delete this empty Kanban column?'),
                { modal: true },
                deleteLabel
            );
            if (result !== deleteLabel) {
                return false;
            }
            await saveKanbanColumns(
                context,
                existing.filter(([columnId]) => columnId !== id)
            );
            // Remove stale mappings left by annotations deleted outside the
            // Kanban command surface once the now-empty column is gone.
            for (const annotationId of allAssignedIds) {
                await kanbanColumnStore.clearColumn(annotationId);
            }
            return true;
        }),

        // Manual refresh: re-emit annotations + columns to the webview.
        vscode.commands.registerCommand('annotations.kanban.refresh', () => {
            if (!annotationStore) {
                return rejectKanbanCommand(loc('kanbanNotReady', 'The Kanban board is not ready yet.'));
            }
            KanbanView.refreshCurrentAnnotations(annotationStore.list());
            return true;
        })
    );
}
