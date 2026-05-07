import * as vscode from 'vscode';
import { DEFAULT_CONFIG, ExtensionConfig } from '../common/types';

export class ConfigurationManager {
    private _config: ExtensionConfig;

    constructor() {
        this._config = { ...DEFAULT_CONFIG };
        this.loadConfiguration();
    }

    private loadConfiguration(): void {
        const workspaceConfig = vscode.workspace.getConfiguration('annotation');
        this._config = {
            colors: {
                light: {
                    annotation: workspaceConfig.get<string>(
                        'colors.light.annotation',
                        DEFAULT_CONFIG.colors.light.annotation
                    ),
                    highlightBackground: workspaceConfig.get<string>(
                        'colors.light.highlightBackground',
                        DEFAULT_CONFIG.colors.light.highlightBackground
                    ),
                    commentBorder: workspaceConfig.get<string>(
                        'colors.light.commentBorder',
                        DEFAULT_CONFIG.colors.light.commentBorder
                    ),
                },
                dark: {
                    annotation: workspaceConfig.get<string>(
                        'colors.dark.annotation',
                        DEFAULT_CONFIG.colors.dark.annotation
                    ),
                    highlightBackground: workspaceConfig.get<string>(
                        'colors.dark.highlightBackground',
                        DEFAULT_CONFIG.colors.dark.highlightBackground
                    ),
                    commentBorder: workspaceConfig.get<string>(
                        'colors.dark.commentBorder',
                        DEFAULT_CONFIG.colors.dark.commentBorder
                    ),
                },
            },
            debounceDelay: workspaceConfig.get<number>('debounceDelay', DEFAULT_CONFIG.debounceDelay),
            maxAnnotationsPerFile: workspaceConfig.get<number>(
                'maxAnnotationsPerFile',
                DEFAULT_CONFIG.maxAnnotationsPerFile
            ),
            username: workspaceConfig.get<string>('username', '') || DEFAULT_CONFIG.username,
            codelens: {
                enable: workspaceConfig.get<boolean>('codelens.enable', DEFAULT_CONFIG.codelens.enable),
                showCommands: workspaceConfig.get<boolean>(
                    'codelens.showCommands',
                    DEFAULT_CONFIG.codelens.showCommands
                ),
            },
            enableAnnotations: workspaceConfig.get<boolean>('enableAnnotations') ?? DEFAULT_CONFIG.enableAnnotations,
            disabledTags: workspaceConfig.get<string[]>('disabledTags') ?? DEFAULT_CONFIG.disabledTags,
            enableAiSuggest: workspaceConfig.get<boolean>('enableAiSuggest', DEFAULT_CONFIG.enableAiSuggest),
            defaultSeverity: workspaceConfig.get<string>('defaultSeverity', DEFAULT_CONFIG.defaultSeverity),
        };
    }

    public get config(): ExtensionConfig {
        return this._config;
    }

    public updateConfiguration(): void {
        this.loadConfiguration();
    }
}
