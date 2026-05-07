import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { localize } from '../common/localize';

export interface UserProfile {
    id: string;
    name: string;
    email?: string;
    role: 'developer' | 'analyst' | 'architect' | 'custom';
    isActive: boolean;
    preferences: {
        defaultTags: string[];
        defaultSeverity: 'info' | 'warning' | 'error';
        defaultPriority: 'low' | 'medium' | 'high';
        autoSuggestEnabled: boolean;
        preferredProvider: string;
        claudeProfileId?: string;
    };
    permissions: {
        canCreateAnnotations: boolean;
        canEditAllAnnotations: boolean;
        canDeleteAnnotations: boolean;
        canExportAnnotations: boolean;
        canUseAI: boolean;
    };
}

export class UserProfileManager extends EventEmitter {
    private profiles: Map<string, UserProfile>;
    private activeProfile: UserProfile | null = null;
    private context: vscode.ExtensionContext;
    private statusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext) {
        super();
        this.context = context;
        this.profiles = new Map();
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.initialize();
    }

    private async initialize(): Promise<void> {
        // Load profiles from workspace state
        const savedProfiles = this.context.workspaceState.get<UserProfile[]>('userProfiles', []);
        savedProfiles.forEach((profile) => this.profiles.set(profile.id, profile));

        // Create default profiles if none exist
        if (this.profiles.size === 0) {
            this.createDefaultProfiles();
        }

        // Load active profile
        const activeProfileId = this.context.workspaceState.get<string>('activeProfile');
        if (activeProfileId) {
            this.activeProfile = this.profiles.get(activeProfileId) || null;
        }

        // Set default active profile if none
        if (!this.activeProfile && this.profiles.size > 0) {
            this.activeProfile = this.profiles.values().next().value ?? null;
        }

        this.updateStatusBar();
    }

    private createDefaultProfiles(): void {
        // Developer Profile
        const developerProfile: UserProfile = {
            id: 'default-developer',
            name: 'Developer',
            role: 'developer',
            isActive: true,
            preferences: {
                defaultTags: ['fix', 'bug', 'optimization'],
                defaultSeverity: 'warning',
                defaultPriority: 'medium',
                autoSuggestEnabled: true,
                preferredProvider: 'claude',
                claudeProfileId: 'developer',
            },
            permissions: {
                canCreateAnnotations: true,
                canEditAllAnnotations: true,
                canDeleteAnnotations: true,
                canExportAnnotations: true,
                canUseAI: true,
            },
        };

        // Analyst Profile
        const analystProfile: UserProfile = {
            id: 'default-analyst',
            name: 'Business Analyst',
            role: 'analyst',
            isActive: true,
            preferences: {
                defaultTags: ['documentation', 'business-logic', 'requirements'],
                defaultSeverity: 'info',
                defaultPriority: 'low',
                autoSuggestEnabled: true,
                preferredProvider: 'claude',
                claudeProfileId: 'analyst',
            },
            permissions: {
                canCreateAnnotations: true,
                canEditAllAnnotations: false,
                canDeleteAnnotations: false,
                canExportAnnotations: true,
                canUseAI: true,
            },
        };

        // Architect Profile
        const architectProfile: UserProfile = {
            id: 'default-architect',
            name: 'Software Architect',
            role: 'architect',
            isActive: true,
            preferences: {
                defaultTags: ['architecture', 'design-pattern', 'security'],
                defaultSeverity: 'info',
                defaultPriority: 'high',
                autoSuggestEnabled: true,
                preferredProvider: 'claude',
                claudeProfileId: 'architect',
            },
            permissions: {
                canCreateAnnotations: true,
                canEditAllAnnotations: true,
                canDeleteAnnotations: true,
                canExportAnnotations: true,
                canUseAI: true,
            },
        };

        this.profiles.set(developerProfile.id, developerProfile);
        this.profiles.set(analystProfile.id, analystProfile);
        this.profiles.set(architectProfile.id, architectProfile);

        this.saveProfiles();
    }

    private async saveProfiles(): Promise<void> {
        const profilesArray = Array.from(this.profiles.values());
        await this.context.workspaceState.update('userProfiles', profilesArray);
    }

    private updateStatusBar(): void {
        if (this.activeProfile) {
            this.statusBarItem.text = `$(account) ${this.activeProfile.name}`;
            this.statusBarItem.tooltip = `Active Profile: ${this.activeProfile.name}\nRole: ${this.activeProfile.role}\nClick to change profile`;
            this.statusBarItem.command = 'annotations.selectProfile';
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    public async createProfile(profile: Omit<UserProfile, 'id'>): Promise<UserProfile> {
        const newProfile: UserProfile = {
            ...profile,
            id: `profile-${Date.now()}`,
        };

        this.profiles.set(newProfile.id, newProfile);
        await this.saveProfiles();
        this.emit('profileCreated', newProfile);

        return newProfile;
    }

    public async updateProfile(profileId: string, updates: Partial<UserProfile>): Promise<UserProfile | null> {
        const profile = this.profiles.get(profileId);
        if (!profile) {
            return null;
        }

        const updatedProfile = { ...profile, ...updates, id: profileId };
        this.profiles.set(profileId, updatedProfile);
        await this.saveProfiles();

        if (this.activeProfile?.id === profileId) {
            this.activeProfile = updatedProfile;
            this.updateStatusBar();
        }

        this.emit('profileUpdated', updatedProfile);
        return updatedProfile;
    }

    public async deleteProfile(profileId: string): Promise<boolean> {
        if (this.profiles.size <= 1) {
            vscode.window.showErrorMessage(localize('cannotDeleteLastProfile', 'Cannot delete the last profile'));
            return false;
        }

        const profile = this.profiles.get(profileId);
        if (!profile) {
            return false;
        }

        this.profiles.delete(profileId);
        await this.saveProfiles();

        if (this.activeProfile?.id === profileId) {
            this.activeProfile = this.profiles.values().next().value ?? null;
            if (this.activeProfile) {
                await this.setActiveProfile(this.activeProfile.id);
            }
        }

        this.emit('profileDeleted', profile);
        return true;
    }

    public async setActiveProfile(profileId: string): Promise<void> {
        const profile = this.profiles.get(profileId);
        if (!profile) {
            throw new Error(`Profile ${profileId} not found`);
        }

        this.activeProfile = profile;
        await this.context.workspaceState.update('activeProfile', profileId);
        this.updateStatusBar();
        this.emit('activeProfileChanged', profile);
    }

    public getActiveProfile(): UserProfile | null {
        return this.activeProfile;
    }

    public getProfile(profileId: string): UserProfile | null {
        return this.profiles.get(profileId) || null;
    }

    public getAllProfiles(): UserProfile[] {
        return Array.from(this.profiles.values());
    }

    public getProfilesByRole(role: UserProfile['role']): UserProfile[] {
        return Array.from(this.profiles.values()).filter((p) => p.role === role);
    }

    public async showProfileSelector(): Promise<UserProfile | undefined> {
        const profiles = this.getAllProfiles();
        const items = profiles.map((profile) => ({
            label: `$(account) ${profile.name}`,
            description: `${profile.role} - ${profile.isActive ? 'Active' : 'Inactive'}`,
            detail: `Tags: ${profile.preferences.defaultTags.join(', ')}`,
            profile,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a user profile',
            title: 'User Profiles',
        });

        if (selected) {
            await this.setActiveProfile(selected.profile.id);
            return selected.profile;
        }

        return undefined;
    }

    public async showProfileManager(): Promise<void> {
        const actions = [
            { label: '$(account) Switch Profile', action: 'switch' },
            { label: '$(add) Create New Profile', action: 'create' },
            { label: '$(edit) Edit Current Profile', action: 'edit' },
            { label: '$(trash) Delete Profile', action: 'delete' },
            { label: '$(gear) Manage All Profiles', action: 'manage' },
        ];

        const selected = await vscode.window.showQuickPick(actions, {
            placeHolder: 'What would you like to do?',
            title: 'Profile Management',
        });

        if (!selected) {
            return;
        }

        switch (selected.action) {
            case 'switch':
                await this.showProfileSelector();
                break;
            case 'create':
                await this.createProfileWizard();
                break;
            case 'edit':
                if (this.activeProfile) {
                    await this.editProfileWizard(this.activeProfile.id);
                }
                break;
            case 'delete':
                await this.deleteProfileWizard();
                break;
            case 'manage':
                await this.showProfilesWebview();
                break;
        }
    }

    private async createProfileWizard(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: localize('enterProfileName', 'Enter profile name'),
            placeHolder: localize('profileNamePlaceholder', 'My Profile'),
        });

        if (!name) {
            return;
        }

        const roles = [
            { label: 'Developer', value: 'developer' },
            { label: 'Business Analyst', value: 'analyst' },
            { label: 'Software Architect', value: 'architect' },
            { label: 'Custom', value: 'custom' },
        ];

        const roleSelection = await vscode.window.showQuickPick(roles, {
            placeHolder: 'Select role',
        });

        if (!roleSelection) {
            return;
        }

        const role = roleSelection.value as UserProfile['role'];

        // Get default preferences based on role
        const defaultPreferences = this.getDefaultPreferencesForRole(role);

        await this.createProfile({
            name,
            role,
            isActive: true,
            preferences: defaultPreferences,
            permissions: this.getDefaultPermissionsForRole(role),
        });

        vscode.window.showInformationMessage(
            localize('profileCreatedSuccessfully', "Profile '{0}' created successfully!", name)
        );
    }

    private async editProfileWizard(profileId: string): Promise<void> {
        const profile = this.profiles.get(profileId);
        if (!profile) {
            return;
        }

        // This would open a more complex editor in a real implementation
        vscode.window.showInformationMessage(localize('profileEditingUI', 'Profile editing UI would open here'));
    }

    private async deleteProfileWizard(): Promise<void> {
        const profiles = this.getAllProfiles();
        const items = profiles.map((profile) => ({
            label: profile.name,
            description: profile.role,
            profile,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select profile to delete',
        });

        if (selected) {
            const confirm = await vscode.window.showWarningMessage(
                localize(
                    'deleteProfileConfirm',
                    "Are you sure you want to delete the profile '{0}'?",
                    selected.profile.name
                ),
                'Delete',
                'Cancel'
            );

            if (confirm === 'Delete') {
                await this.deleteProfile(selected.profile.id);
            }
        }
    }

    private async showProfilesWebview(): Promise<void> {
        // This would open a webview panel for comprehensive profile management
        vscode.window.showInformationMessage(
            localize('profileManagementWebview', 'Profile management webview would open here')
        );
    }

    private getDefaultPreferencesForRole(role: UserProfile['role']): UserProfile['preferences'] {
        switch (role) {
            case 'developer':
                return {
                    defaultTags: ['fix', 'bug', 'optimization'],
                    defaultSeverity: 'warning',
                    defaultPriority: 'medium',
                    autoSuggestEnabled: true,
                    preferredProvider: 'claude',
                    claudeProfileId: 'developer',
                };
            case 'analyst':
                return {
                    defaultTags: ['documentation', 'business-logic'],
                    defaultSeverity: 'info',
                    defaultPriority: 'low',
                    autoSuggestEnabled: true,
                    preferredProvider: 'claude',
                    claudeProfileId: 'analyst',
                };
            case 'architect':
                return {
                    defaultTags: ['architecture', 'design-pattern'],
                    defaultSeverity: 'info',
                    defaultPriority: 'high',
                    autoSuggestEnabled: true,
                    preferredProvider: 'claude',
                    claudeProfileId: 'architect',
                };
            default:
                return {
                    defaultTags: [],
                    defaultSeverity: 'info',
                    defaultPriority: 'medium',
                    autoSuggestEnabled: false,
                    preferredProvider: 'openai',
                };
        }
    }

    private getDefaultPermissionsForRole(role: UserProfile['role']): UserProfile['permissions'] {
        switch (role) {
            case 'developer':
            case 'architect':
                return {
                    canCreateAnnotations: true,
                    canEditAllAnnotations: true,
                    canDeleteAnnotations: true,
                    canExportAnnotations: true,
                    canUseAI: true,
                };
            case 'analyst':
                return {
                    canCreateAnnotations: true,
                    canEditAllAnnotations: false,
                    canDeleteAnnotations: false,
                    canExportAnnotations: true,
                    canUseAI: true,
                };
            default:
                return {
                    canCreateAnnotations: true,
                    canEditAllAnnotations: false,
                    canDeleteAnnotations: false,
                    canExportAnnotations: false,
                    canUseAI: false,
                };
        }
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }
}
