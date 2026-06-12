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
import type { Annotation } from './common/types';
import { AnnotationsTreeDataProvider, AnnotationsDragAndDropController } from './tree/AnnotationsTree';
import { NavigationStackDataProvider } from './tree/NavigationStackTree';
import { KanbanView } from './views/KanbanView';
import { localize } from './common/localize';
import { LocalizationManager, loc } from './managers/LocalizationManager';
import { UserProfileManager } from './managers/UserProfileManager';
import { UnifiedAIAdapter } from './providers/UnifiedAIAdapter';
import { AIProfileManager } from './managers/AIProfileManager';
import { AnnotationManagerErrorHandling } from './managers/AnnotationManagerErrorHandling';
import { initializeLogger, getLogger } from './utils/logger';

// ── Lot 5 R2 — new transactional stack ─────────────────────────────────────
import { AnnotationStore } from './transactional/AnnotationStore';
import { AnnotationPersistence } from './transactional/AnnotationPersistence';
import { VisibilityFilter } from './transactional/VisibilityFilter';
import { KanbanColumnStore } from './transactional/KanbanColumnStore';
import { AnnotationCodeLensProvider } from './providers/AnnotationCodeLensProvider';
import { generateDocSet, type DocAnnotation } from './docs/AnnotationDocGenerator';
import { scanLineComments } from './comments/commentScanner';
import { languageOfPath } from './comments/languageOfPath';
import { captureAnchor } from './anchoring/anchor';
import { TextBuffer } from './anchoring/textBuffer';
import { toFileUriString } from './common/fileUri';
import { MarkdownMessageEditor } from './views/MarkdownMessageEditor';
import { firstMessageLine, formatAnnotationLocation } from './views/markdownMessageEditorHelpers';
import { createDebounced } from './utils/debounce';
import { LicenseManager, getLicenseManager, requireEntitlement } from './pro/LicenseManager';
import { PRO_FEATURE_IDS, localizedFeatureName } from './pro/features';
import { AnnotationSyncService, SYNC_FEATURE_ID } from './sync/AnnotationSyncService';

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

/** Reentrancy guard for {@link generateDocumentationNow}. */
let docsGenerationInProgress = false;

/** Quiet period between the last annotation change and a watch-mode regeneration. */
const DOCS_WATCH_DEBOUNCE_MS = 2000;

/** Window after our own annotations.json save during which watcher events are treated as echoes. */
const EXTERNAL_WATCH_SUPPRESSION_MS = 2000;

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

        annotationManager = new AnnotationManager(context);
        // Stub the legacy disk paths during R2: the v2 envelope on disk is
        // owned by AnnotationStore now. Without this, AnnotationManager
        // would crash on the v2 shape and pop a "failed to load" toast.
        stubLegacyAnnotationManagerIO(annotationManager);

        profileManager = new UserProfileManager(context);
        aiProfileManager = new AIProfileManager(context);
        aiAdapter = new UnifiedAIAdapter(context, annotationManager, profileManager, aiProfileManager);

        // Lot 5 R2: Tree provider migrated by worker-A to consume store +
        // visibility-filter directly. Drag-and-drop reorder writes through
        // persistence on its own.
        if (!annotationStore || !visibilityFilter || !annotationPersistence) {
            throw new Error('Lot 5 R2: transactional stack not bootstrapped before tree wiring');
        }
        const treeDataProvider = new AnnotationsTreeDataProvider(annotationStore, visibilityFilter);
        const dragAndDropController = new AnnotationsDragAndDropController(annotationStore, annotationPersistence);
        const view = vscode.window.createTreeView('annotationsView', {
            treeDataProvider,
            dragAndDropController,
        });
        // Lot 5 R2: NavigationStackTree migrated to (store, navigationStack).
        const stackDataProvider = new NavigationStackDataProvider(annotationStore, annotationManager.navigationStack);
        const stackView = vscode.window.createTreeView('stackView', { treeDataProvider: stackDataProvider });

        vscode.window.registerTreeDataProvider('annotationsExplorerView', treeDataProvider);
        vscode.window.registerTreeDataProvider('stackView', stackDataProvider);
        context.subscriptions.push(annotationManager);
        context.subscriptions.push(view);
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
        annotationManager.createChatParticipant(context);

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
            void vscode.window
                .showInformationMessage(
                    localize(
                        'welcomeMessage',
                        'Out-of-Code Insights is ready. To enable AI features, run "Update AI Provider API Key".'
                    ),
                    localize('configure', 'Configure')
                )
                .then((selection) => {
                    if (selection === localize('configure', 'Configure')) {
                        vscode.commands.executeCommand('annotations.updateApiKey');
                    }
                });
        }

        // ReviewModeManager is already created and managed by AnnotationManager

        // Register KanbanView commands
        const showKanbanCommand = vscode.commands.registerCommand('annotations.showKanban', async () => {
            try {
                if (!annotationStore) {
                    vscode.window.showErrorMessage(
                        loc('kanbanError', 'Failed to show Kanban board') + ': Annotation store is not ready yet'
                    );
                    return;
                }
                // Lot 5 R2: Kanban now reads from AnnotationStore directly.
                const annotationsArray = annotationStore.list();
                getLogger().info(`Opening Kanban board with ${annotationsArray.length} annotations`);

                await KanbanView.createOrShow(context, annotationsArray, annotationStore);

                // Listen for annotation changes to update Kanban
                const updateKanban = () => {
                    if (KanbanView.currentPanel && annotationStore) {
                        const updatedAnnotations = annotationStore.list();
                        KanbanView.currentPanel.webview.postMessage({
                            command: 'updateAnnotations',
                            annotations: updatedAnnotations.map((annotation) => ({
                                id: annotation.id,
                                message: annotation.message,
                                severity: annotation.severity,
                                file: annotation.file?.split('/').pop() || 'Unknown',
                                filePath: annotation.file,
                                // Display-only line number derived from offset.
                                line: annotation.startOffset,
                                tags: annotation.tags || [],
                                kanbanColumn: annotation.kanbanColumn || 'todo',
                                timestamp: annotation.timestamp,
                            })),
                        });
                    }
                };

                const kanbanAnnotationSubscription = annotationStore.onDidChange(updateKanban);
                context.subscriptions.push(kanbanAnnotationSubscription);
                if (annotationManager) {
                    // Legacy column-changed channel kept until R3 retires the manager.
                    annotationManager.on('annotationChanged', updateKanban);
                }

                // Listen for column changes
                const updateColumns = async () => {
                    if (KanbanView.currentPanel) {
                        const columns = await vscode.commands.executeCommand<[string, string][]>(
                            'annotations.kanban.getColumns'
                        );
                        if (columns) {
                            KanbanView.currentPanel.webview.postMessage({
                                command: 'updateColumns',
                                columns: columns,
                            });
                        }
                    }
                };

                annotationManager?.on('kanbanColumnsChanged', updateColumns);

                // Clean up listeners when panel is disposed
                if (KanbanView.currentPanel) {
                    KanbanView.currentPanel.onDidDispose(() => {
                        annotationManager?.removeListener('annotationChanged', updateKanban);
                        annotationManager?.removeListener('kanbanColumnsChanged', updateColumns);
                    });
                }
            } catch (error) {
                annotationManager?.handleError(localize('kanbanError', 'Failed to show Kanban board'), error);
            }
        });

        const addKanbanColumnCommand = vscode.commands.registerCommand('annotations.addKanbanColumn', async () => {
            try {
                if (!annotationManager) {
                    vscode.window.showErrorMessage(
                        localize('kanbanColumnError', 'Failed to add Kanban column') +
                            ': Annotation manager not initialized'
                    );
                    return;
                }

                const columnName = await vscode.window.showInputBox({
                    prompt: localize('kanbanColumnPrompt', 'Enter new column name'),
                    placeHolder: localize('kanbanColumnPlaceholder', 'e.g., Testing, Blocked'),
                });

                if (columnName) {
                    // This command will be handled by the KanbanView instance if it exists
                    vscode.window.showInformationMessage(
                        localize(
                            'kanbanColumnAdded',
                            'Kanban column functionality will be available when the board is open'
                        )
                    );
                }
            } catch (error) {
                annotationManager?.handleError(localize('kanbanColumnError', 'Failed to add Kanban column'), error);
            }
        });

        context.subscriptions.push(showKanbanCommand, addKanbanColumnCommand);
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

export function deactivate(): void {
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
 *    `store.applyDocumentChange(event)`.
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

async function bootstrapTransactionalStack(context: vscode.ExtensionContext, logger: ActivationLogger): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    annotationStore = new AnnotationStore({ suspendTtlMs: readCutRecoveryWindowMs() });

    if (workspaceFolder) {
        annotationPersistence = new AnnotationPersistence(workspaceFolder);
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
                annotationStore.applyDocumentChange(event);
                annotationStore.notifyChanged();
            } catch (err) {
                logger.error('applyDocumentChange threw', err);
            }
        })
    );

    // Wire store.onDidChange → debounced persistence.save (100 ms).
    // 100 ms is enough to coalesce within-event mutations (keystroke bursts,
    // multi-cursor inserts) without racing the typical 500 ms wait used by
    // the EDH integration suite when it reads back the persisted file.
    let saveTimer: NodeJS.Timeout | undefined;
    let lastSelfWriteAt = 0;
    const flushSave = (): void => {
        saveTimer = undefined;
        if (!annotationStore || !annotationPersistence) {
            return;
        }
        const payload = annotationStore.serialize();
        lastSelfWriteAt = Date.now();
        annotationPersistence
            .save(payload)
            .then(() => {
                lastSelfWriteAt = Date.now();
            })
            .catch((err: unknown) => {
                logger.error('AnnotationPersistence.save failed', err);
            });
    };
    context.subscriptions.push(
        annotationStore.onDidChange(() => {
            if (saveTimer) {
                clearTimeout(saveTimer);
            }
            saveTimer = setTimeout(flushSave, 100);
        })
    );

    // Live external-change watcher: the MCP server (or any other tool)
    // writes the same annotations.json. Reload the store when the file
    // changes on disk — unless the write was our own (suppression window
    // after each save; our own watcher echo would otherwise reload and
    // re-save in a loop). Reloading replaces the in-memory state wholesale
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
            if (Date.now() - lastSelfWriteAt < EXTERNAL_WATCH_SUPPRESSION_MS) {
                return;
            }
            if (!vscode.workspace.getConfiguration('annotation').get<boolean>('watchExternalChanges', true)) {
                return;
            }
            try {
                const payload = await persistence.load();
                annotationStore.deserialize(payload);
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
        vscode.workspace.onDidRenameFiles((event) => {
            if (!annotationStore) {
                return;
            }
            for (const file of event.files) {
                annotationStore.applyFileRename(
                    file.oldUri.toString(),
                    file.newUri.toString(),
                    vscode.workspace.asRelativePath(file.newUri)
                );
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles((event) => {
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
                void vscode.window
                    .showWarningMessage(
                        loc(
                            'fileDeletedWithAnnotations',
                            '{0} annotation(s) reference the deleted file "{1}". Keep them?',
                            affected.length,
                            vscode.workspace.asRelativePath(file)
                        ),
                        keepLabel,
                        deleteLabel
                    )
                    .then((choice) => {
                        if (choice === deleteLabel && annotationStore) {
                            annotationStore.beginTransaction();
                            try {
                                for (const a of affected) {
                                    annotationStore.remove(a.id);
                                }
                                annotationStore.commit();
                            } catch (err) {
                                annotationStore.rollback();
                                getLogger().error('delete-file annotation cleanup failed', err);
                            }
                        }
                        // Keep (or dismissed): annotations stay in the store and
                        // the panel/tree; they render as orphaned references.
                    });
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

    // The save-timer flush helper is reachable through the closure above; the
    // variable declaration here keeps lint happy without a leaked unused-var.
    void flushSave;
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
    };
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
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'annotations.add',
            async (args?: { line?: number; offset?: number; message?: string; tags?: string[] }) => {
                if (!annotationStore) {
                    vscode.window.showErrorMessage(loc('storeNotReady', 'Annotation store is not ready yet.'));
                    return;
                }
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage(localize('noActiveEditor', 'No active editor found.'));
                    return;
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
                    return;
                }
                const document = editor.document;
                const fileUri = document.uri.toString();
                const file = vscode.workspace.asRelativePath(document.uri);
                const draft = {
                    fileUri,
                    file,
                    origin: { kind: 'manual' } as const,
                    message,
                    timestamp: new Date().toISOString(),
                    languageId: document.languageId,
                    ...(args?.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
                };
                try {
                    if (typeof args?.offset === 'number') {
                        annotationStore.add(draft, { offset: args.offset }, document);
                    } else {
                        const line = args?.line ?? editor.selection.active.line;
                        annotationStore.add(draft, { line }, document);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(
                        localize('addAnnotationError', 'Failed to add annotation') + `: ${msg}`
                    );
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
            for (const ann of annotationStore.list()) {
                annotationStore.remove(ann.id);
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
            ];
            const picked = await vscode.window.showQuickPick(roles, {
                placeHolder: loc('docRolePlaceholder', 'Documentation role for this annotation'),
            });
            if (!picked) {
                return;
            }
            await vscode.commands.executeCommand('annotations.add', { tags: [picked.tag] });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('annotations.generateDocs', async () => {
            await generateDocumentationNow(false);
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

/**
 * Generate the annotation documentation site. Single implementation shared
 * by the `annotations.generateDocs` command (`silent === false`, surfaces
 * toasts and the Open prompt) and the docs watch mode (`silent === true`,
 * logs only — no UI noise on auto-regeneration).
 *
 * Reentrancy-guarded: a call made while a generation is already running is
 * skipped (logged). Watch-mode calls additionally skip when the store holds
 * no annotation at all.
 */
async function generateDocumentationNow(silent: boolean): Promise<void> {
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
    if (docsGenerationInProgress) {
        getLogger().info('generateDocumentationNow: a generation is already running, skipping');
        return;
    }

    const all = store.serialize().annotations;
    if (silent && all.length === 0) {
        getLogger().info('generateDocumentationNow: store is empty, skipping watch regeneration');
        return;
    }

    docsGenerationInProgress = true;
    try {
        const docsConfig = vscode.workspace.getConfiguration('annotation');
        const outDirSetting = docsConfig.get<string>('docs.outputPath', 'docs/annotations').trim();
        // Same traversal contract as the annotations file path: the
        // docs always land inside the workspace.
        if (path.isAbsolute(outDirSetting) || outDirSetting.split(/[\\/]/).includes('..')) {
            const invalidPathMessage = localize(
                'docsPathInvalid',
                'annotation.docs.outputPath must be a relative path inside the workspace.'
            );
            if (silent) {
                getLogger().warn(`generateDocumentationNow: ${invalidPathMessage}`);
            } else {
                vscode.window.showErrorMessage(invalidPathMessage);
            }
            return;
        }
        const sanitizeSegment = (value: string, fallback: string): string => {
            const v = value.trim();
            return v.length === 0 || v.includes('..') || /[\\/]/.test(v) || path.isAbsolute(v) ? fallback : v;
        };
        const apiFolder = sanitizeSegment(docsConfig.get<string>('docs.apiFolder', 'api'), 'api');
        const guideFile = sanitizeSegment(docsConfig.get<string>('docs.guideFile', 'guide.md'), 'guide.md');
        const includeTimestamp = docsConfig.get<boolean>('docs.includeTimestamp', true);
        const siteTitle = docsConfig.get<string>('docs.siteTitle', '').trim();

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
        const files = generateDocSet(docAnnotations, {
            title: siteTitle.length > 0 ? siteTitle : localize('docsTitle', 'Annotations — {0}', workspaceFolder.name),
            sourceLinkPrefix: '../'.repeat(depth),
            generatedAt: includeTimestamp ? new Date().toISOString() : undefined,
            tagPrefix: docsConfig.get<string>('docs.tagPrefix', 'doc:'),
            apiFolder,
            guideFile,
            includeInventory: docsConfig.get<boolean>('docs.includeInventory', true),
            includeAuthored: docsConfig.get<boolean>('docs.includeAuthored', true),
            untaggedLabel: docsConfig.get<string>('docs.untaggedLabel', 'untagged'),
            frontMatter: docsConfig.get<boolean>('docs.frontMatter', false),
        });

        const outDir = vscode.Uri.joinPath(workspaceFolder.uri, ...outDirSetting.split(/[\\/]/));
        await vscode.workspace.fs.createDirectory(outDir);
        for (const [name, content] of files) {
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outDir, name), Buffer.from(content, 'utf8'));
        }

        if (silent) {
            const count = String(docAnnotations.length);
            getLogger().info(`docs watch: regenerated docs for ${count} annotation(s) in ${outDirSetting}`);
            return;
        }

        const openLabel = localize('openDocs', 'Open');
        const choice = await vscode.window.showInformationMessage(
            localize(
                'docsGenerated',
                'Annotation documentation generated ({0} annotation(s)) in {1}.',
                docAnnotations.length,
                outDirSetting
            ),
            openLabel
        );
        if (choice === openLabel) {
            const indexDoc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(outDir, 'index.md'));
            await vscode.window.showTextDocument(indexDoc);
        }
    } catch (err) {
        if (silent) {
            getLogger().error('generateDocumentationNow: watch regeneration failed', err);
        } else {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(localize('docsFailed', 'Failed to generate documentation') + `: ${msg}`);
        }
    } finally {
        docsGenerationInProgress = false;
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
// Mutation flow: `kanban.moveToColumn` → `KanbanColumnStore.setColumn` →
// `annotationStore.notifyChanged()` → existing onDidChange listener installed
// by the `annotations.showKanban` command refreshes the webview.

const KANBAN_COLUMN_DEFINITIONS_KEY = 'outOfCodeInsights.kanban.columnDefinitions';
const KANBAN_DEFAULT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
    ['todo', 'To Do'],
    ['in-progress', 'In Progress'],
    ['review', 'Review'],
    ['done', 'Done'],
];

function loadKanbanColumns(context: vscode.ExtensionContext): [string, string][] {
    const stored = context.workspaceState.get<[string, string][]>(KANBAN_COLUMN_DEFINITIONS_KEY);
    if (Array.isArray(stored) && stored.length > 0) {
        return stored;
    }
    return KANBAN_DEFAULT_COLUMNS.map(([id, name]) => [id, name] as [string, string]);
}

async function saveKanbanColumns(context: vscode.ExtensionContext, columns: [string, string][]): Promise<void> {
    await context.workspaceState.update(KANBAN_COLUMN_DEFINITIONS_KEY, columns);
    if (KanbanView.currentPanel) {
        KanbanView.currentPanel.webview.postMessage({
            command: 'updateColumns',
            columns,
        });
    }
}

function registerKanbanCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // Returns the current column definitions to the webview. Webview
        // expects `[string, string][]` (id → name pairs); falls back on a
        // default set when the workspace has no override.
        vscode.commands.registerCommand('annotations.kanban.getColumns', () => loadKanbanColumns(context)),

        // Move an annotation to a different column. Routes through
        // KanbanColumnStore (per the R1 service contract) and signals the
        // store so the existing showKanban-installed onDidChange listener
        // refreshes the webview without a round-trip through the user.
        vscode.commands.registerCommand(
            'annotations.kanban.moveToColumn',
            async (annotationId: string, columnId: string) => {
                if (!kanbanColumnStore || !annotationStore) {
                    return;
                }
                await kanbanColumnStore.setColumn(annotationId, columnId);
                annotationStore.notifyChanged();
            }
        ),

        // Remove an annotation from the Kanban without deleting it from
        // the store (annotation stays attached to its source code).
        vscode.commands.registerCommand('annotations.kanban.removeFromKanban', async (annotationId: string) => {
            if (!kanbanColumnStore || !annotationStore) {
                return;
            }
            await kanbanColumnStore.clearColumn(annotationId);
            annotationStore.notifyChanged();
        }),

        // Permanently delete an annotation from the store AND clear its
        // Kanban column entry. Triggered from the Kanban "delete" path.
        vscode.commands.registerCommand('annotations.kanban.delete', async (annotationId: string) => {
            if (!annotationStore) {
                return;
            }
            annotationStore.remove(annotationId);
            if (kanbanColumnStore) {
                await kanbanColumnStore.clearColumn(annotationId);
            }
        }),

        // Append a new column definition to the workspace's Kanban layout.
        vscode.commands.registerCommand('annotations.kanban.addColumn', async (id: string, name: string) => {
            const columns = loadKanbanColumns(context);
            if (columns.some(([cid]) => cid === id)) {
                return; // duplicate id, no-op
            }
            columns.push([id, name]);
            await saveKanbanColumns(context, columns);
        }),

        // Replace the entire column-definition layout. Used by rename flows.
        vscode.commands.registerCommand('annotations.kanban.updateColumns', async (columns: [string, string][]) => {
            if (!Array.isArray(columns)) {
                return;
            }
            await saveKanbanColumns(context, columns);
        }),

        // Delete a column definition. Annotations previously assigned to
        // that column are reset to the default ('todo') so they remain
        // reachable in the Kanban UI.
        vscode.commands.registerCommand('annotations.kanban.deleteColumn', async (id: string) => {
            const columns = loadKanbanColumns(context).filter(([cid]) => cid !== id);
            await saveKanbanColumns(context, columns);
            if (kanbanColumnStore) {
                for (const [annId, col] of kanbanColumnStore.getAllColumns()) {
                    if (col === id) {
                        await kanbanColumnStore.setColumn(annId, 'todo');
                    }
                }
                if (annotationStore) {
                    annotationStore.notifyChanged();
                }
            }
        }),

        // Manual refresh: re-emit annotations + columns to the webview.
        vscode.commands.registerCommand('annotations.kanban.refresh', () => {
            if (!annotationStore) {
                return;
            }
            annotationStore.notifyChanged();
        })
    );
}
