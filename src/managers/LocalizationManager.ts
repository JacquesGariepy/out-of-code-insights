import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';

export class LocalizationManager {
    private static instance: LocalizationManager;
    private currentLanguage: string;
    private messages: { [key: string]: string } = {};
    private extensionPath: string;

    private constructor(context: vscode.ExtensionContext) {
        this.extensionPath = context.extensionPath;
        this.currentLanguage = this.getConfiguredLanguage();
        this.loadMessages();

        // Watch for configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('annotation.language')) {
                    this.handleLanguageChange();
                }
            })
        );
    }

    public static getInstance(context?: vscode.ExtensionContext): LocalizationManager {
        if (!LocalizationManager.instance && context) {
            LocalizationManager.instance = new LocalizationManager(context);
        }
        return LocalizationManager.instance;
    }

    private getConfiguredLanguage(): string {
        const config = vscode.workspace.getConfiguration('annotation');
        return config.get<string>('language', 'en');
    }

    private async loadMessages(): Promise<void> {
        try {
            const nlsFile = this.currentLanguage === 'fr' 
                ? 'package.nls.fr.json' 
                : 'package.nls.json';
            
            const nlsPath = path.join(this.extensionPath, nlsFile);
            const content = await fs.readFile(nlsPath, 'utf8');
            this.messages = JSON.parse(content);
        } catch (error) {
            console.error('Failed to load localization messages:', error);
            // Fallback to English
            try {
                const fallbackPath = path.join(this.extensionPath, 'package.nls.json');
                const content = await fs.readFile(fallbackPath, 'utf8');
                this.messages = JSON.parse(content);
            } catch (fallbackError) {
                console.error('Failed to load fallback messages:', fallbackError);
                this.messages = {};
            }
        }
    }

    private async handleLanguageChange(): Promise<void> {
        const newLanguage = this.getConfiguredLanguage();
        if (newLanguage !== this.currentLanguage) {
            this.currentLanguage = newLanguage;
            await this.loadMessages();

            // Notify user about restart requirement
            const message = this.localize('languageChangedRestart', 'Language changed. Please restart VS Code for the change to take effect.');
            const restartNow = this.localize('restartNow', 'Restart Now');
            const restartLater = this.localize('restartLater', 'Restart Later');

            const choice = await vscode.window.showInformationMessage(
                message,
                restartNow,
                restartLater
            );

            if (choice === restartNow) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
    }

    /**
     * Get a localized message
     * @param key The message key
     * @param defaultValue Default value if key not found
     * @param args Arguments for message formatting
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public localize(key: string, defaultValue?: string, ...args: any[]): string {
        let message = this.messages[key] || defaultValue || key;
        
        // Replace placeholders {0}, {1}, etc. with provided arguments
        if (args.length > 0) {
            args.forEach((arg, index) => {
                message = message.replace(new RegExp(`\\{${index}\\}`, 'g'), String(arg));
            });
        }
        
        return message;
    }

    /**
     * Get the current language
     */
    public getCurrentLanguage(): string {
        return this.currentLanguage;
    }

    /**
     * Get all available languages
     */
    public getAvailableLanguages(): Array<{ code: string; name: string }> {
        return [
            { code: 'en', name: 'English' },
            { code: 'fr', name: 'Français' }
        ];
    }
}

// Export a convenient function for localization
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loc(key: string, defaultValue?: string, ...args: any[]): string {
    const manager = LocalizationManager.getInstance();
    return manager ? manager.localize(key, defaultValue, ...args) : defaultValue || key;
}