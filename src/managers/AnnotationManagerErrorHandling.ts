import * as vscode from 'vscode';
import { localize } from '../common/localize';

/**
 * Error handling utilities for AnnotationManager
 */
export class AnnotationManagerErrorHandling {
    private static initializationError: Error | undefined;
    private static isInitialized = false;

    /**
     * Mark the manager as initialized
     */
    static setInitialized(success: boolean, error?: Error): void {
        this.isInitialized = success;
        this.initializationError = error;
    }

    /**
     * Check if the manager is initialized and show appropriate error if not
     */
    static checkInitialized(functionName: string): boolean {
        if (!this.isInitialized) {
            const baseMessage = localize('extensionNotInitialized', 
                'The annotation extension is not fully initialized.');
            
            let detailMessage = '';
            if (this.initializationError) {
                detailMessage = localize('initializationErrorDetails',
                    'Initialization failed with error: {0}', 
                    this.initializationError.message);
            } else {
                detailMessage = localize('stillInitializing',
                    'The extension may still be initializing. Please wait a moment and try again.');
            }

            const fullMessage = `${baseMessage}\n\n${detailMessage}`;
            
            // Show error with retry option
            vscode.window.showErrorMessage(
                fullMessage,
                localize('retry', 'Retry'),
                localize('openSettings', 'Open Settings')
            ).then(selection => {
                if (selection === localize('retry', 'Retry')) {
                    // Re-execute the command
                    vscode.commands.executeCommand(`annotations.${functionName}`);
                } else if (selection === localize('openSettings', 'Open Settings')) {
                    // Open extension settings
                    vscode.commands.executeCommand('workbench.action.openSettings', 'annotation');
                }
            });

            return false;
        }
        return true;
    }

    /**
     * Wrap a command function with initialization check
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static wrapCommand<T extends (...args: any[]) => any>(
        commandName: string,
        fn: T,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        thisArg?: any
    ): T {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ((...args: any[]) => {
            if (!this.checkInitialized(commandName)) {
                return;
            }
            return fn.apply(thisArg, args);
        }) as T;
    }

    /**
     * Create a fallback command that shows helpful error message
     */
    static createFallbackCommand(commandName: string, helpMessage?: string): () => void {
        return () => {
            const baseMessage = localize('commandNotAvailable',
                'The command "{0}" is not available because the extension failed to initialize.',
                commandName);
            
            const help = helpMessage || localize('checkExtensionSettings',
                'Please check the extension settings and ensure all required configurations are correct.');

            const fullMessage = `${baseMessage}\n\n${help}`;

            vscode.window.showErrorMessage(
                fullMessage,
                localize('openSettings', 'Open Settings'),
                localize('viewLogs', 'View Logs')
            ).then(selection => {
                if (selection === localize('openSettings', 'Open Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'annotation');
                } else if (selection === localize('viewLogs', 'View Logs')) {
                    vscode.commands.executeCommand('workbench.action.output.show', {
                        preserveFocus: false,
                        viewColumn: vscode.ViewColumn.Beside
                    });
                }
            });
        };
    }

    /**
     * Show a warning for reduced functionality
     */
    static showReducedFunctionalityWarning(): void {
        vscode.window.showWarningMessage(
            localize('reducedFunctionality',
                'The annotation extension is running with reduced functionality. Some features may not be available.'),
            localize('viewDetails', 'View Details')
        ).then(selection => {
            if (selection === localize('viewDetails', 'View Details')) {
                this.showInitializationReport();
            }
        });
    }

    /**
     * Show detailed initialization report
     */
    static showInitializationReport(): void {
        const report = this.generateInitializationReport();
        
        // Create output channel for detailed report
        const channel = vscode.window.createOutputChannel('Annotation Extension - Initialization Report');
        channel.clear();
        channel.appendLine(report);
        channel.show();
    }

    /**
     * Generate initialization report
     */
    private static generateInitializationReport(): string {
        const lines: string[] = [
            '=== Annotation Extension Initialization Report ===',
            '',
            `Status: ${this.isInitialized ? 'Initialized' : 'Failed'}`,
            `Time: ${new Date().toLocaleString()}`,
            ''
        ];

        if (this.initializationError) {
            lines.push('Error Details:');
            lines.push(`  Message: ${this.initializationError.message}`);
            lines.push(`  Stack: ${this.initializationError.stack || 'No stack trace available'}`);
            lines.push('');
        }

        lines.push('Troubleshooting Steps:');
        lines.push('1. Check the extension settings (Ctrl+Comma -> Extensions -> Out-of-Code Insights)');
        lines.push('2. Ensure your username is configured');
        lines.push('3. If using AI features, verify your API keys are set');
        lines.push('4. Check the main output channel for more detailed logs');
        lines.push('5. Try reloading the VS Code window (Ctrl+Shift+P -> "Developer: Reload Window")');
        lines.push('');
        lines.push('If the problem persists, please report an issue at:');
        lines.push('https://github.com/JacquesGariepy/out-of-code-insights/issues');

        return lines.join('\n');
    }
}