import * as vscode from 'vscode';
import { Annotation } from '../common/types';
import { localize } from '../common/localize';
import { Message } from 'multi-llm-ts';

export interface AIProfile {
    id: string;
    name: string;
    description: string;
    prompts: {
        analyze: string;
        suggest: string;
        review: string;
    };
    annotationDefaults: {
        prefix: string;
        tags: string[];
        severity: 'info' | 'warning' | 'error';
        priority?: number;
    };
}

export interface UnifiedAIConfig {
    provider: string;
    model: string;
    apiKeys: Record<string, string>;
    context: vscode.ExtensionContext;
}

export class UnifiedAIProvider {
    private config: UnifiedAIConfig;
    private profiles: Map<string, AIProfile>;
    private activeProfile: AIProfile;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private llm: any | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private models: any | null = null;

    constructor(config: UnifiedAIConfig) {
        this.config = config;
        this.profiles = new Map();
        this.initializeProfiles();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.activeProfile = this.profiles.get('developer')!;
    }

    public addCustomProfile(profile: AIProfile): void {
        this.profiles.set(profile.id, profile);
    }

    public removeCustomProfile(profileId: string): void {
        if (this.profiles.has(profileId) && !['developer', 'analyst', 'architect'].includes(profileId)) {
            this.profiles.delete(profileId);
        }
    }

    private initializeProfiles(): void {
        // Developer Profile
        this.profiles.set('developer', {
            id: 'developer',
            name: 'Developer',
            description: 'Focus on code fixes, bugs, and improvements',
            prompts: {
                analyze: `You are a senior developer reviewing code. Analyze the following code and identify:
                - Potential bugs or issues
                - Code improvements and optimizations
                - Best practice violations
                - Performance concerns
                Format your response as actionable annotations.`,
                suggest: `Based on this code context, suggest specific fixes or improvements that a developer should implement.`,
                review: `Review this code change and provide developer-focused feedback on implementation quality.`
            },
            annotationDefaults: {
                prefix: '[DEV]',
                tags: ['fix', 'bug', 'optimization', 'refactor'],
                severity: 'warning',
                priority: 1
            }
        });

        // Analyst Profile
        this.profiles.set('analyst', {
            id: 'analyst',
            name: 'Business Analyst',
            description: 'Focus on business logic and documentation',
            prompts: {
                analyze: `You are a business analyst reviewing code. Focus on:
                - Business logic clarity and correctness
                - Missing documentation
                - Feature behavior explanation
                - Requirements alignment
                Provide annotations that help understand the business purpose.`,
                suggest: `Analyze this code from a business perspective and suggest documentation or clarifications needed.`,
                review: `Review this code for business logic clarity and requirements compliance.`
            },
            annotationDefaults: {
                prefix: '[ANALYST]',
                tags: ['documentation', 'business-logic', 'requirements', 'clarification'],
                severity: 'info',
                priority: 0
            }
        });

        // Architect Profile
        this.profiles.set('architect', {
            id: 'architect',
            name: 'Software Architect',
            description: 'Focus on design patterns and architecture',
            prompts: {
                analyze: `You are a software architect reviewing code. Evaluate:
                - Architectural patterns and design principles
                - Scalability concerns
                - Security considerations
                - Module dependencies and coupling
                Provide high-level architectural insights.`,
                suggest: `From an architectural perspective, suggest design improvements or pattern applications.`,
                review: `Review this code for architectural soundness and design pattern adherence.`
            },
            annotationDefaults: {
                prefix: '[ARCH]',
                tags: ['architecture', 'design-pattern', 'security', 'scalability'],
                severity: 'info',
                priority: 2
            }
        });
    }

    public async initialize(): Promise<boolean> {
        try {
            // Dynamic import of multi-llm-ts
            const multiLLM = await import('multi-llm-ts');
            
            // Get the API key for the configured provider
            const apiKey = this.config.apiKeys[this.config.provider];
            
            if (!apiKey) {
                // Try to get from secrets
                const secretKey = await this.config.context.secrets.get(`${this.config.provider}-api-key`);
                if (!secretKey) {
                    console.error(`No API key found for ${this.config.provider} in settings or secrets`);
                    const providerName = this.config.provider.charAt(0).toUpperCase() + this.config.provider.slice(1);
                    
                    // Provide helpful error message based on provider
                    let helpMessage = `No API key found for ${providerName}.`;
                    switch (this.config.provider) {
                        case 'openai':
                            helpMessage += ' You need an OpenAI API key from https://platform.openai.com/api-keys';
                            break;
                        case 'anthropic':
                            helpMessage += ' You need an Anthropic API key from https://console.anthropic.com/';
                            break;
                        case 'azure':
                            helpMessage += ' You need Azure OpenAI credentials from your Azure portal';
                            break;
                        case 'ollama':
                            helpMessage = 'Ollama should work without an API key. Make sure Ollama is running locally on port 11434';
                            break;
                    }
                    
                    vscode.window.showWarningMessage(
                        localize('apiKeyMissing', helpMessage)
                    );
                    return false;
                }
                this.config.apiKeys[this.config.provider] = secretKey;
            }

            // Create LLM instance using igniteEngine
            const { igniteEngine, loadModels } = multiLLM;
            this.llm = igniteEngine(this.config.provider, {
                apiKey: this.config.apiKeys[this.config.provider]
            });
            
            // Load available models
            try {
                this.models = await loadModels(this.config.provider, {
                    apiKey: this.config.apiKeys[this.config.provider]
                });
                
                // Verify we have chat models
                if (!this.models?.chat || this.models.chat.length === 0) {
                    console.warn(`No chat models available for provider ${this.config.provider}`);
                    // Some providers might not return models list but still work
                    // Create a default model structure
                    this.models = {
                        chat: [{ id: this.config.model || 'default', name: 'Default Model' }]
                    };
                }
            } catch (error) {
                console.warn('Failed to load models, using defaults:', error);
                // Fallback for providers that don't support model listing
                this.models = {
                    chat: [{ id: this.config.model || 'default', name: 'Default Model' }]
                };
            }

            return true;
        } catch (error) {
            console.error('Failed to initialize UnifiedAIProvider:', error);
            return false;
        }
    }

    public setActiveProfile(profileId: string): void {
        const profile = this.profiles.get(profileId);
        if (profile) {
            this.activeProfile = profile;
        }
    }

    public getProfiles(): AIProfile[] {
        return Array.from(this.profiles.values());
    }

    public getActiveProfile(): AIProfile {
        return this.activeProfile;
    }

    private buildPrompt(code: string, filePath: string, context?: { language?: string; projectInfo?: string; additionalContext?: string }): string {
        const profile = this.activeProfile;
        let prompt = profile.prompts.analyze + '\n\n';
        
        if (context?.language) {
            prompt += `Language: ${context.language}\n`;
        }
        if (context?.projectInfo) {
            prompt += `Project Context: ${context.projectInfo}\n`;
        }
        prompt += `File: ${filePath}\n\n`;
        
        // Add line numbers to the code
        const codeWithLineNumbers = code.split('\n').map((line, index) => 
            `${(index + 1).toString().padStart(4, ' ')}: ${line}`
        ).join('\n');
        
        prompt += `Code to analyze (with line numbers):\n\`\`\`\n${codeWithLineNumbers}\n\`\`\`\n\n`;
        
        if (context?.additionalContext) {
            prompt += `Additional Context: ${context.additionalContext}\n\n`;
        }
        
        prompt += `Generate annotations in JSON format with the following structure:
        [
            {
                "message": "Annotation message",
                "line": <actual_line_number_in_file_starting_from_1>,
                "severity": "info|warning|error",
                "tags": ["tag1", "tag2"],
                "suggestedFix": "Optional code fix"
            }
        ]
        
        IMPORTANT: The "line" field must be the actual line number in the file (starting from 1), not a relative offset.`;
        
        return prompt;
    }

    private async callAI(prompt: string): Promise<string> {
        if (!this.llm || !this.models) {
            throw new Error('AI provider not initialized. Please check your API key configuration.');
        }

        try {
            // Get the chat models
            if (!this.models.chat || !Array.isArray(this.models.chat) || this.models.chat.length === 0) {
                throw new Error(`No chat models available for ${this.config.provider}. Please check your API key and provider settings.`);
            }
            
            // Find the specified model or use the first available
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const modelObj = this.models.chat.find((m: any) => m.id === this.config.model) || this.models.chat[0];
            
            // Create messages
            const messages = [
                new Message('system', 'You are a code annotation assistant.'),
                new Message('user', prompt)
            ];
            
            // Call the LLM
            const response = await this.llm.complete(modelObj, messages);
            
            // Extract content from response
            const content = response?.choices?.[0]?.message?.content?.trim() || 
                           response?.content?.trim() || 
                           response?.text?.trim() ||
                           '';
            
            if (!content) {
                throw new Error('No response from AI. The API might be down or your API key might be invalid.');
            }
            
            return content;
        } catch (error) {
            console.error('AI call failed:', error);
            const typedError = error as Error;
            
            // Provide more specific error messages
            if (typedError.message?.includes('401') || typedError.message?.includes('Unauthorized')) {
                throw new Error(`Authentication failed for ${this.config.provider}. Please check your API key.`);
            } else if (typedError.message?.includes('429')) {
                throw new Error(`Rate limit exceeded for ${this.config.provider}. Please try again later.`);
            } else if (typedError.message?.includes('insufficient_quota') || typedError.message?.includes('quota')) {
                throw new Error(`API quota exceeded for ${this.config.provider}. Please check your account.`);
            } else if (typedError.message?.includes('ECONNREFUSED')) {
                throw new Error(`Cannot connect to ${this.config.provider}. Please check if the service is running (especially for Ollama).`);
            }
            
            throw error;
        }
    }

    public async generateAnnotations(
        code: string,
        filePath: string,
        lineNumber: number,
        context?: {
            language?: string;
            projectInfo?: string;
            additionalContext?: string;
        }
    ): Promise<Partial<Annotation>[]> {
        try {
            const prompt = this.buildPrompt(code, filePath, context);
            const response = await this.callAI(prompt);
            return this.parseAnnotations(response, filePath, lineNumber);
        } catch (error) {
            console.error('Failed to generate annotations:', error);
            throw new Error(`Failed to generate annotations: ${error}`);
        }
    }

    private parseAnnotations(response: string, filePath: string, baseLineNumber: number): Partial<Annotation>[] {
        try {
            // Try to extract JSON from the response
            const jsonMatch = response.match(/\[\s*\{[\s\S]*\}\s*\]/);
            const jsonString = jsonMatch ? jsonMatch[0] : response;
            
            const parsedAnnotations = JSON.parse(jsonString);
            const profile = this.activeProfile;
            
            if (!Array.isArray(parsedAnnotations)) {
                return [];
            }
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return parsedAnnotations.map((ann: any) => {
                // Log for debugging
                
                const annotation: Partial<Annotation> = {
                    message: `${profile.annotationDefaults.prefix} ${ann.message}`,
                    file: filePath,
                    line: ann.line ? (ann.line - 1) : baseLineNumber, // Convert to 0-based index
                    severity: ann.severity || profile.annotationDefaults.severity,
                    tags: [...(ann.tags || []), ...profile.annotationDefaults.tags],
                    kanbanColumn: 'todo'
                };
                
                if (profile.annotationDefaults.priority !== undefined) {
                    annotation.priority = profile.annotationDefaults.priority;
                }
                
                return annotation;
            });
        } catch (error) {
            console.error('Failed to parse AI response:', error);
            // Fallback: create a simple annotation with the response
            return [{
                message: `${this.activeProfile.annotationDefaults.prefix} ${response.substring(0, 200)}`,
                file: filePath,
                line: baseLineNumber,
                severity: this.activeProfile.annotationDefaults.severity,
                tags: this.activeProfile.annotationDefaults.tags.slice(0, 2),
                kanbanColumn: 'todo'
            }];
        }
    }

    public async analyzeFile(
        document: vscode.TextDocument,
        profile?: string
    ): Promise<Partial<Annotation>[]> {
        // Ensure AI provider is initialized before proceeding
        const initialized = await this.ensureInitialized();
        if (!initialized) {
            throw new Error('Failed to initialize AI provider');
        }

        if (profile) {
            this.setActiveProfile(profile);
        }

        const code = document.getText();
        const filePath = document.fileName;
        const language = document.languageId;

        return this.generateAnnotations(code, filePath, 0, {
            language,
            projectInfo: vscode.workspace.name || 'Unknown Project'
        });
    }

    public async suggestAnnotationForLine(
        document: vscode.TextDocument,
        lineNumber: number,
        profile?: string,
        customPrompt?: string
    ): Promise<Partial<Annotation> | null> {
        // Ensure AI provider is initialized before proceeding
        const initialized = await this.ensureInitialized();
        if (!initialized) {
            throw new Error('Failed to initialize AI provider');
        }

        if (profile) {
            this.setActiveProfile(profile);
        }

        // Get context around the current line
        const startLine = Math.max(0, lineNumber - 5);
        const endLine = Math.min(document.lineCount - 1, lineNumber + 5);
        
        let codeContext = '';
        for (let i = startLine; i <= endLine; i++) {
            codeContext += document.lineAt(i).text + '\n';
        }

        const context: { language?: string; projectInfo?: string; additionalContext?: string } = {
            language: document.languageId,
            additionalContext: `Focus on line ${lineNumber - startLine + 1} of the provided context (which is line ${lineNumber + 1} in the full file)`
        };
        
        if (customPrompt) {
            context.additionalContext += `\n\nUser instructions: ${customPrompt}`;
        }
        
        const annotations = await this.generateAnnotations(
            codeContext,
            document.fileName,
            startLine, // Use startLine as base
            context
        );

        return annotations.length > 0 ? annotations[0] : null;
    }

    public updateConfig(config: Partial<UnifiedAIConfig>): void {
        this.config = { ...this.config, ...config };
        // Reset LLM if provider changed
        if (config.provider || config.model) {
            this.llm = null;
            this.models = null;
        }
    }

    public async ensureInitialized(): Promise<boolean> {
        if (!this.llm || !this.models) {
            return await this.initialize();
        }
        return true;
    }

    public getCurrentProvider(): string {
        return this.config.provider;
    }
}
