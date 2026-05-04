// Polyfill AbortController for environments that don't have it
import { AbortController } from 'node-abort-controller';
if (typeof globalThis.AbortController === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AbortController = AbortController;
}

import * as vscode from 'vscode';
import { AnnotationManager } from './managers/AnnotationManager';
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

let annotationManager: AnnotationManager | undefined;
let profileManager: UserProfileManager | undefined;
let aiAdapter: UnifiedAIAdapter | undefined;
let aiProfileManager: AIProfileManager | undefined;
let isInitialized = false;

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
        annotationManager = new AnnotationManager(context);
        profileManager = new UserProfileManager(context);
        aiProfileManager = new AIProfileManager(context);
        aiAdapter = new UnifiedAIAdapter(context, annotationManager, profileManager, aiProfileManager);
        
        const treeDataProvider = new AnnotationsTreeDataProvider(annotationManager);
        const dragAndDropController = new AnnotationsDragAndDropController(annotationManager);
        const view = vscode.window.createTreeView('annotationsView', {
            treeDataProvider,
            dragAndDropController
        });
        const stackDataProvider = new NavigationStackDataProvider(annotationManager);
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
                if (e.affectsConfiguration('annotation.provider') ||
                    e.affectsConfiguration('annotation.model') ||
                    e.affectsConfiguration('llm.apiKeys')) {
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

        logger.info(`Extension v${version} activated successfully`);
        isInitialized = true;
        AnnotationManagerErrorHandling.setInitialized(true);

        const welcomed = context.globalState.get<boolean>('welcomeShown', false);
        if (!welcomed) {
            void context.globalState.update('welcomeShown', true);
            void vscode.window.showInformationMessage(
                localize('welcomeMessage', 'Out-of-Code Insights is ready. To enable AI features, run "Update AI Provider API Key".'),
                localize('configure', 'Configure')
            ).then(selection => {
                if (selection === localize('configure', 'Configure')) {
                    vscode.commands.executeCommand('annotations.updateApiKey');
                }
            });
        }

        // ReviewModeManager is already created and managed by AnnotationManager

        // Register KanbanView commands
        const showKanbanCommand = vscode.commands.registerCommand('annotations.showKanban', async () => {
            try {
                if (!annotationManager) {
                    vscode.window.showErrorMessage(loc('kanbanError', 'Failed to show Kanban board') + ': Annotation manager not initialized');
                    return;
                }
                // Convert annotations Map to array
                const annotationsArray = Array.from(annotationManager.annotations.values());
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (annotationManager as any).log(`Opening Kanban board with ${annotationsArray.length} annotations`);

                // Debug log first few annotations
                if (annotationsArray.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (annotationManager as any).log(`First annotation: ${JSON.stringify(annotationsArray[0])}`);
                }
                
                await KanbanView.createOrShow(context, annotationsArray);
                
                // Listen for annotation changes to update Kanban
                const updateKanban = () => {
                    if (KanbanView.currentPanel && annotationManager) {
                        const updatedAnnotations = Array.from(annotationManager.annotations.values());
                        KanbanView.currentPanel.webview.postMessage({
                            command: 'updateAnnotations',
                            annotations: updatedAnnotations.map(annotation => ({
                                id: annotation.id,
                                message: annotation.message,
                                severity: annotation.severity,
                                file: annotation.file?.split('/').pop() || 'Unknown',
                                filePath: annotation.file,
                                line: annotation.line,
                                tags: annotation.tags || [],
                                kanbanColumn: annotation.kanbanColumn || 'todo',
                                timestamp: annotation.timestamp
                            }))
                        });
                    }
                };
                
                annotationManager.on('annotationChanged', updateKanban);
                
                // Listen for column changes
                const updateColumns = async () => {
                    if (KanbanView.currentPanel) {
                        const columns = await vscode.commands.executeCommand<[string, string][]>('annotations.kanban.getColumns');
                        if (columns) {
                            KanbanView.currentPanel.webview.postMessage({
                                command: 'updateColumns',
                                columns: columns
                            });
                        }
                    }
                };
                
                annotationManager.on('kanbanColumnsChanged', updateColumns);
                
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
                    vscode.window.showErrorMessage(localize('kanbanColumnError', 'Failed to add Kanban column') + ': Annotation manager not initialized');
                    return;
                }
                
                const columnName = await vscode.window.showInputBox({
                    prompt: localize('kanbanColumnPrompt', 'Enter new column name'),
                    placeHolder: localize('kanbanColumnPlaceholder', 'e.g., Testing, Blocked')
                });

                if (columnName) {
                    // This command will be handled by the KanbanView instance if it exists
                    vscode.window.showInformationMessage(localize('kanbanColumnAdded', 'Kanban column functionality will be available when the board is open'));
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
        vscode.window.showErrorMessage(
            localize('activationError', 'Failed to activate the annotation extension') + `: ${errorMessage}`,
            localize('viewDetails', 'View Details'),
            localize('retry', 'Retry')
        ).then(selection => {
            if (selection === localize('viewDetails', 'View Details')) {
                AnnotationManagerErrorHandling.showInitializationReport();
            } else if (selection === localize('retry', 'Retry')) {
                // Reload the window to retry initialization
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
        
        // Log to output channel if available
        annotationManager?.handleError(localize('activationError', 'Failed to activate the annotation extension'), error);
    }
}

/**
 * Register essential commands that should always be available, even if initialization fails
 */
function registerEssentialCommands(context: vscode.ExtensionContext): void {
    // Core annotation commands with error handling
    // Map command names to method names when they differ
    const commandMappings: { [key: string]: string } = {
        'add': 'addAnnotation',
        'reply': 'replyToAnnotation',
        'show': 'showAnnotationsPanel',
        'clearAll': 'clearAnnotations',
        'delete': 'deleteAnnotationCommand',
        'edit': 'editAnnotationCommand',
        'toggleDisplay': 'toggleAnnotationsDisplay',
        'navigate': 'navigateToAnnotation',
        'exportJSON': 'exportAnnotationsJSON',
        'importJSON': 'importAnnotationsJSON',
        'pinToggle': 'togglePinAnnotation',
        'setSeverity': 'setAnnotationSeverity',
        'batchEdit': 'batchEditAnnotations',
        'keywordSearch': 'keywordSearch',
        'aiSuggest': 'aiSuggestAnnotation',
        'moveUp': 'moveUpCommand',
        'moveDown': 'moveDownCommand'
    };

    const AI_COMMANDS = new Set(['aiSuggest', 'aiSuggestWithProfile', 'aiAnalyzeFile', 'aiBatchAnnotate', 'aiAnalyzeFileWithProfile']);

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
                    if (!configured) { return; }
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
                ...(logFilePath ? [
                    { label: '$(file-text) Open Log File', description: logFilePath },
                    { label: '$(folder-opened) Reveal Log Folder', description: vscode.Uri.file(logFilePath).fsPath.replace(/[^\\/]+$/, '') }
                ] : [])
            ];
            const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Out-of-Code Insights Logs' });
            if (!selected) { return; }
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
    isInitialized = false;
}
