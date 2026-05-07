import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { AIProfile } from '../providers/UnifiedAIProvider';
import { EventEmitter } from 'events';
import { loc } from './LocalizationManager';
import { getLogger } from '../utils/logger';

export class AIProfileManager extends EventEmitter {
    private context: vscode.ExtensionContext;
    private customProfiles: Map<string, AIProfile>;
    private profilesFile: string;
    private profilesLoaded: Promise<void>;

    constructor(context: vscode.ExtensionContext) {
        super();
        this.context = context;
        this.customProfiles = new Map();
        // Use context.globalStoragePath which is more reliable
        const storagePath = context.globalStorageUri?.fsPath || context.globalStoragePath || context.extensionPath;
        this.profilesFile = path.join(storagePath, 'ai-profiles.json');
        // Load profiles asynchronously and store the promise
        this.profilesLoaded = this.loadProfiles().catch((err: unknown) =>
            getLogger().error('Failed to load AI profiles on startup', err)
        );
    }

    public async ensureLoaded(): Promise<void> {
        await this.profilesLoaded;
    }

    private async loadProfiles(): Promise<void> {
        try {
            await fs.ensureDir(path.dirname(this.profilesFile));
            if (await fs.pathExists(this.profilesFile)) {
                const data = await fs.readJson(this.profilesFile);
                for (const profile of data.profiles || []) {
                    this.customProfiles.set(profile.id, profile);
                }
            } else {
                // intentionally empty
            }
        } catch (error) {
            getLogger().error('Failed to load AI profiles', error);
        }
    }

    private async saveProfiles(): Promise<void> {
        try {
            await fs.ensureDir(path.dirname(this.profilesFile));
            const profiles = Array.from(this.customProfiles.values());
            await fs.writeJson(this.profilesFile, { profiles }, { spaces: 2 });
        } catch (error) {
            getLogger().error('Failed to save AI profiles', error);
            vscode.window.showErrorMessage(loc('failedToSaveAIProfiles', `Failed to save AI profiles: {0}`, error));
        }
    }

    public getCustomProfiles(): AIProfile[] {
        return Array.from(this.customProfiles.values());
    }

    public async reloadProfiles(): Promise<void> {
        this.customProfiles.clear();
        await this.loadProfiles();
    }

    public async showProfileManager(): Promise<void> {
        const items = [
            {
                label: loc('createNewAIProfile', '$(add) Create New Profile'),
                description: loc('createCustomAIProfile', 'Create a custom AI profile'),
                action: 'create',
            },
            {
                label: loc('editProfile', '$(edit) Edit Profile'),
                description: loc('modifyExistingProfile', 'Modify an existing profile'),
                action: 'edit',
            },
            {
                label: loc('deleteProfile', '$(trash) Delete Profile'),
                description: loc('removeCustomProfile', 'Remove a custom profile'),
                action: 'delete',
            },
            {
                label: loc('exportProfiles', '$(export) Export Profiles'),
                description: loc('exportProfilesToFile', 'Export profiles to file'),
                action: 'export',
            },
            {
                label: loc('importProfiles', '$(cloud-download) Import Profiles'),
                description: loc('importProfilesFromFile', 'Import profiles from file'),
                action: 'import',
            },
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: loc('manageAIProfiles', 'Manage AI Profiles'),
        });

        if (!selected) return;

        switch (selected.action) {
            case 'create':
                await this.createProfile();
                break;
            case 'edit':
                await this.editProfile();
                break;
            case 'delete':
                await this.deleteProfile();
                break;
            case 'export':
                await this.exportProfiles();
                break;
            case 'import':
                await this.importProfiles();
                break;
        }
    }

    private async createProfile(): Promise<void> {
        // Get profile ID
        const id = await vscode.window.showInputBox({
            prompt: loc('profileIdPrompt', 'Profile ID (lowercase, no spaces)'),
            placeHolder: 'security-auditor',
            validateInput: (value) => {
                if (!value) return loc('idRequired', 'ID is required');
                if (!/^[a-z0-9-]+$/.test(value)) return loc('idFormat', 'Only lowercase letters, numbers, and hyphens');
                if (this.customProfiles.has(value)) return loc('profileIdExists', 'Profile ID already exists');
                return null;
            },
        });

        if (!id) {
            return;
        }

        // Get profile name
        const name = await vscode.window.showInputBox({
            prompt: loc('profileNamePrompt', 'Profile Name'),
            placeHolder: loc('profileNamePlaceholder', 'Security Auditor'),
        });

        if (!name) return;

        // Get description
        const description = await vscode.window.showInputBox({
            prompt: loc('profileDescriptionPrompt', 'Profile Description'),
            placeHolder: loc('profileDescriptionPlaceholder', 'Focus on security vulnerabilities and best practices'),
        });

        if (!description) return;

        // Get analyze prompt
        const analyzePrompt = await vscode.window.showInputBox({
            prompt: loc('analyzePromptPrompt', 'Analyze Prompt (what the AI should look for)'),
            placeHolder: loc('analyzePromptPlaceholder', 'You are a security expert. Look for vulnerabilities...'),
            ignoreFocusOut: true,
            validateInput: (value) => (value ? null : loc('promptRequired', 'Prompt is required')),
        });

        if (!analyzePrompt) return;

        // Get prefix
        const prefix = await vscode.window.showInputBox({
            prompt: loc('annotationPrefixPrompt', 'Annotation Prefix'),
            placeHolder: '[SEC]',
            value: `[${name.substring(0, 4).toUpperCase()}]`,
        });

        if (!prefix) return;

        // Get tags
        const tagsInput = await vscode.window.showInputBox({
            prompt: loc('defaultTagsPrompt', 'Default Tags (comma-separated)'),
            placeHolder: loc('defaultTagsPlaceholder', 'security, vulnerability, audit'),
        });

        if (!tagsInput) return;

        const tags = tagsInput
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t);

        // Get severity
        const severityItems = [
            { label: loc('severityError', 'Error'), value: 'error' },
            { label: loc('severityWarning', 'Warning'), value: 'warning' },
            { label: loc('severityInfo', 'Info'), value: 'info' },
        ];

        const severity = await vscode.window.showQuickPick(severityItems, {
            placeHolder: loc('defaultSeverity', 'Default Severity'),
        });

        if (!severity) return;

        // Get priority
        const priorityItems = [
            { label: loc('priorityHigh', 'High (2)'), value: 2 },
            { label: loc('priorityMedium', 'Medium (1)'), value: 1 },
            { label: loc('priorityLow', 'Low (0)'), value: 0 },
        ];

        const priority = await vscode.window.showQuickPick(priorityItems, {
            placeHolder: loc('defaultPriority', 'Default Priority'),
        });

        // Create the profile
        const profile: AIProfile = {
            id,
            name,
            description,
            prompts: {
                analyze: analyzePrompt,
                suggest: `Based on the ${name.toLowerCase()} perspective, suggest improvements.`,
                review: `Review this code from a ${name.toLowerCase()} standpoint.`,
            },
            annotationDefaults: {
                prefix,
                tags,
                severity: severity.value as 'info' | 'warning' | 'error',
                priority: priority?.value,
            },
        };

        this.customProfiles.set(id, profile);

        await this.saveProfiles();

        // Emit event that profiles have changed
        this.emit('profilesChanged');

        vscode.window.showInformationMessage(
            loc('profileCreatedSuccessfully', `Profile "{0}" created successfully!`, name)
        );
    }

    private async editProfile(): Promise<void> {
        const profiles = this.getCustomProfiles();
        if (profiles.length === 0) {
            vscode.window.showInformationMessage(loc('noCustomProfilesToEdit', 'No custom profiles to edit'));
            return;
        }

        const items = profiles.map((p) => ({
            label: p.name,
            description: p.description,
            profile: p,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: loc('selectProfileToEdit', 'Select profile to edit'),
        });

        if (!selected) return;

        // For simplicity, we'll just allow editing the prompt
        const newPrompt = await vscode.window.showInputBox({
            prompt: loc('editAnalyzePrompt', 'Edit Analyze Prompt'),
            value: selected.profile.prompts.analyze,
            ignoreFocusOut: true,
        });

        if (newPrompt !== undefined) {
            selected.profile.prompts.analyze = newPrompt;
            this.customProfiles.set(selected.profile.id, selected.profile);
            await this.saveProfiles();
            this.emit('profilesChanged');
            vscode.window.showInformationMessage(loc('profileUpdatedSuccessfully', 'Profile updated successfully!'));
        }
    }

    private async deleteProfile(): Promise<void> {
        const profiles = this.getCustomProfiles();
        if (profiles.length === 0) {
            vscode.window.showInformationMessage(loc('noCustomProfilesToDelete', 'No custom profiles to delete'));
            return;
        }

        const items = profiles.map((p) => ({
            label: p.name,
            description: p.description,
            profile: p,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: loc('selectProfileToDelete', 'Select profile to delete'),
        });

        if (!selected) return;

        const confirm = await vscode.window.showWarningMessage(
            loc('deleteProfileConfirm', `Delete profile "{0}"?`, selected.profile.name),
            loc('delete', 'Delete'),
            loc('cancel', 'Cancel')
        );

        if (confirm === loc('delete', 'Delete')) {
            this.customProfiles.delete(selected.profile.id);
            await this.saveProfiles();
            this.emit('profilesChanged');
            vscode.window.showInformationMessage(loc('profileDeletedSuccessfully', 'Profile deleted successfully!'));
        }
    }

    private async exportProfiles(): Promise<void> {
        const profiles = this.getCustomProfiles();
        if (profiles.length === 0) {
            vscode.window.showInformationMessage(loc('noCustomProfilesToExport', 'No custom profiles to export'));
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('ai-profiles.json'),
            filters: {
                JSON: ['json'],
            },
        });

        if (uri) {
            try {
                await fs.writeJson(uri.fsPath, { profiles }, { spaces: 2 });
                vscode.window.showInformationMessage(
                    loc('profilesExportedSuccessfully', 'Profiles exported successfully!')
                );
            } catch (error) {
                vscode.window.showErrorMessage(loc('failedToExportProfiles', 'Failed to export profiles'));
            }
        }
    }

    private async importProfiles(): Promise<void> {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                JSON: ['json'],
            },
        });

        if (uri && uri[0]) {
            try {
                const raw = await fs.readJson(uri[0].fsPath);
                if (!raw || typeof raw !== 'object' || !Array.isArray(raw.profiles)) {
                    vscode.window.showErrorMessage(loc('invalidProfileFileFormat', 'Invalid profile file format'));
                    return;
                }
                let imported = 0;
                let skipped = 0;
                for (const profile of raw.profiles) {
                    // Validate required string fields with length limits.
                    const idOk = typeof profile.id === 'string' && profile.id.length > 0 && profile.id.length <= 64;
                    const nameOk =
                        typeof profile.name === 'string' && profile.name.length > 0 && profile.name.length <= 128;
                    if (!idOk || !nameOk) {
                        skipped++;
                        continue;
                    }
                    // Validate optional prompt strings: must be strings within length limit to prevent prompt injection.
                    if (profile.prompts !== undefined) {
                        if (typeof profile.prompts !== 'object' || profile.prompts === null) {
                            skipped++;
                            continue;
                        }
                        for (const key of Object.keys(profile.prompts)) {
                            if (typeof profile.prompts[key] !== 'string' || profile.prompts[key].length > 4096) {
                                skipped++;
                                continue;
                            }
                        }
                    }
                    // Guard against prototype pollution.
                    const safeProfile = Object.assign(Object.create(null), profile);
                    this.customProfiles.set(safeProfile.id as string, safeProfile as AIProfile);
                    imported++;
                }
                const data = raw;
                await this.saveProfiles();
                this.emit('profilesChanged');
                if (skipped > 0) {
                    vscode.window.showWarningMessage(
                        loc(
                            'importedProfilesWithSkipped',
                            `Imported {0} profiles; {1} skipped (failed validation).`,
                            imported,
                            skipped
                        )
                    );
                } else {
                    vscode.window.showInformationMessage(
                        loc('importedProfilesSuccessfully', `Imported {0} profiles successfully!`, data.profiles.length)
                    );
                }
            } catch (error) {
                vscode.window.showErrorMessage(loc('failedToImportProfiles', 'Failed to import profiles'));
            }
        }
    }

    public dispose(): void {
        // Cleanup if needed
    }
}
