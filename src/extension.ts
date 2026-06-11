// Polyfill AbortController for environments that don't have it
import { AbortController } from 'node-abort-controller';
if (typeof globalThis.AbortController === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AbortController = AbortController;
}

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

export function deactivate(): void {
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
async function bootstrapTransactionalStack(context: vscode.ExtensionContext, logger: ActivationLogger): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    annotationStore = new AnnotationStore({ suspendTtlMs: 30_000 });

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
    const flushSave = (): void => {
        saveTimer = undefined;
        if (!annotationStore || !annotationPersistence) {
            return;
        }
        const payload = annotationStore.serialize();
        annotationPersistence.save(payload).catch((err: unknown) => {
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
    // AnnotationStore owns position tracking too (applyDocumentChange:
    // offset shift + suspend/resume across cut/copy/paste). The legacy
    // line-based tracker fired on the SAME onDidChangeTextDocument event,
    // AFTER the store listener and the store→manager mirror had already
    // updated `annotation.line` — so its arithmetic shift ran on
    // already-shifted lines (double shift), and the saveAnnotations bridge
    // then reconciled the corrupted lines back into the store. Symptom:
    // annotations drift or orphan on move/copy/cut+paste.
    manager.documentChangeTrackingDelegatedToStore = true;
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
            async (args?: { line?: number; offset?: number; message?: string }) => {
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
                try {
                    if (typeof args?.offset === 'number') {
                        annotationStore.add(
                            {
                                fileUri,
                                file,
                                origin: { kind: 'manual' },
                                message,
                                timestamp: new Date().toISOString(),
                            },
                            { offset: args.offset },
                            document
                        );
                    } else {
                        const line = args?.line ?? editor.selection.active.line;
                        annotationStore.add(
                            {
                                fileUri,
                                file,
                                origin: { kind: 'manual' },
                                message,
                                timestamp: new Date().toISOString(),
                            },
                            { line },
                            document
                        );
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
