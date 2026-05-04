import * as vscode from 'vscode';
import { AbortController } from 'node-abort-controller';

// Polyfill AbortController for environments that don't have it
if (typeof globalThis.AbortController === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AbortController = AbortController;
}

// Type definitions for Claude Code SDK
export interface SDKMessage {
    role?: string;
    content?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

export interface ClaudeCodeQueryOptions {
    prompt: string;
    abortController?: AbortController;
    options?: {
        maxTurns?: number;
        cwd?: string;
    };
}

/**
 * Wrapper for Claude Code SDK that handles environment compatibility
 */
export class ClaudeSDKWrapper {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private sdkModule: any = null;
    private isInitialized = false;
    private initError: Error | null = null;

    async initialize(): Promise<boolean> {
        if (this.isInitialized) {
            return true;
        }

        try {
            // Ensure environment is properly set up
            this.setupEnvironment();

            // Dynamic import to avoid webpack issues
            try {
                // Try ES module import first
                this.sdkModule = await import('@anthropic-ai/claude-code');
            } catch (importError) {
                // Fallback to require
                this.sdkModule = require('@anthropic-ai/claude-code');
            }

            this.isInitialized = true;
            return true;
        } catch (error) {
            this.initError = error as Error;
            console.error('Failed to initialize Claude Code SDK:', error);
            return false;
        }
    }

    private setupEnvironment(): void {
        // Ensure AbortController is available globally
        if (typeof AbortController === 'undefined') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (global as any).AbortController = AbortController;
        }

        // Set up other potentially missing globals
        if (typeof process === 'undefined') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (global as any).process = { env: {} };
        }

        // Ensure Buffer is available
        if (typeof Buffer === 'undefined') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires
            (global as any).Buffer = require('buffer').Buffer;
        }
    }

    async query(options: ClaudeCodeQueryOptions): Promise<SDKMessage[]> {
        if (!await this.initialize()) {
            throw new Error(`Claude Code SDK initialization failed: ${this.initError?.message}`);
        }

        const messages: SDKMessage[] = [];
        
        try {
            // Use the query function from the SDK
            const queryFn = this.sdkModule.query || this.sdkModule.default?.query;
            
            if (!queryFn) {
                throw new Error('Query function not found in Claude Code SDK');
            }

            const queryOptions = {
                prompt: options.prompt,
                abortController: options.abortController || new AbortController(),
                options: {
                    maxTurns: options.options?.maxTurns || 1,
                    cwd: options.options?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                    ...options.options
                }
            };

            // Execute query
            for await (const message of queryFn(queryOptions)) {
                messages.push(message);
            }

            return messages;
        } catch (error) {
            console.error('Claude SDK query error:', error);
            throw error;
        }
    }

    /**
     * Extract JSON from SDK messages
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractJSON(messages: SDKMessage[]): any {
        const responseText = messages.map(m => 
            typeof m === 'string' ? m : (m.content || JSON.stringify(m))
        ).join('\n');

        // Try to extract JSON from the response
        const jsonMatch = responseText.match(/\[\s*\{[\s\S]*\}\s*\]/g);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.warn('Failed to parse JSON from SDK response');
            }
        }

        return null;
    }

    /**
     * Check if SDK is available
     */
    isAvailable(): boolean {
        return this.isInitialized && this.sdkModule !== null;
    }

    /**
     * Get initialization error if any
     */
    getInitError(): Error | null {
        return this.initError;
    }
}
