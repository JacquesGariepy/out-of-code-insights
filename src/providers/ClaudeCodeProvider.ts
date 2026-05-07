import * as vscode from 'vscode';
import { Annotation } from '../common/types';
import { ClaudeSDKWrapper } from './ClaudeSDKWrapper';

export interface ClaudeProfile {
    id: string;
    name: string;
    description: string;
    prompts: {
        analyze: string;
        suggest: string;
        review: string;
    };
    annotationTemplates: {
        prefix: string;
        tags: string[];
        severity: 'info' | 'warning' | 'error';
        priority?: 'low' | 'medium' | 'high';
    };
}

export interface ClaudeCodeConfig {
    apiKey: string;
    cwd?: string;
    maxTurns?: number;
    useSDK?: boolean; // Toggle between SDK and REST API
}

export class ClaudeCodeProvider {
    private config: ClaudeCodeConfig;
    private profiles: Map<string, ClaudeProfile>;
    private activeProfile: ClaudeProfile;
    private sdkWrapper: ClaudeSDKWrapper;

    constructor(config: ClaudeCodeConfig) {
        this.config = config;
        this.profiles = new Map();
        this.sdkWrapper = new ClaudeSDKWrapper();
        this.initializeProfiles();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.activeProfile = this.profiles.get('developer')!;
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
                review: `Review this code change and provide developer-focused feedback on implementation quality.`,
            },
            annotationTemplates: {
                prefix: '[DEV]',
                tags: ['fix', 'bug', 'optimization', 'refactor'],
                severity: 'warning',
                priority: 'medium',
            },
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
                review: `Review this code for business logic clarity and requirements compliance.`,
            },
            annotationTemplates: {
                prefix: '[ANALYST]',
                tags: ['documentation', 'business-logic', 'requirements', 'clarification'],
                severity: 'info',
                priority: 'low',
            },
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
                review: `Review this code for architectural soundness and design pattern adherence.`,
            },
            annotationTemplates: {
                prefix: '[ARCH]',
                tags: ['architecture', 'design-pattern', 'security', 'scalability'],
                severity: 'info',
                priority: 'high',
            },
        });
    }

    public setActiveProfile(profileId: string): void {
        const profile = this.profiles.get(profileId);
        if (profile) {
            this.activeProfile = profile;
        }
    }

    public getProfiles(): ClaudeProfile[] {
        return Array.from(this.profiles.values());
    }

    public getActiveProfile(): ClaudeProfile {
        return this.activeProfile;
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

            const response = await this.callClaudeAPI(prompt);

            const parsedAnnotations = this.parseAnnotations(response, filePath, lineNumber);

            return parsedAnnotations;
        } catch (error) {
            console.error('❌ generateAnnotations failed:', error);
            throw new Error(`Failed to generate annotations: ${error}`);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private buildPrompt(code: string, filePath: string, context?: any): string {
        const profile = this.activeProfile;
        let prompt = profile.prompts.analyze + '\n\n';

        if (context?.language) {
            prompt += `Language: ${context.language}\n`;
        }
        if (context?.projectInfo) {
            prompt += `Project Context: ${context.projectInfo}\n`;
        }
        prompt += `File: ${filePath}\n\n`;
        prompt += `Code to analyze:\n\`\`\`\n${code}\n\`\`\`\n\n`;

        if (context?.additionalContext) {
            prompt += `Additional Context: ${context.additionalContext}\n\n`;
        }

        prompt += `Generate annotations in JSON format with the following structure:
        [
            {
                "message": "Annotation message",
                "line": <line_number_offset>,
                "severity": "info|warning|error",
                "tags": ["tag1", "tag2"],
                "suggestedFix": "Optional code fix"
            }
        ]`;

        return prompt;
    }

    private async callClaudeAPI(prompt: string): Promise<string> {
        if (this.config.useSDK === true) {
            // Only try SDK if explicitly enabled
            try {
                return await this.callClaudeSDK(prompt);
            } catch (error) {
                console.warn('Claude Code SDK failed, falling back to REST API:', error);
                // Fall back to REST API
            }
        }

        // Use REST API by default
        return this.callClaudeREST(prompt);
    }

    private async callClaudeSDK(prompt: string): Promise<string> {
        try {
            // Initialize SDK wrapper if needed
            if (!this.sdkWrapper.isAvailable()) {
                const initSuccess = await this.sdkWrapper.initialize();
                if (!initSuccess) {
                    const error = this.sdkWrapper.getInitError();
                    throw new Error(`Failed to initialize Claude SDK: ${error?.message}`);
                }
            }

            // Query using the wrapper
            const messages = await this.sdkWrapper.query({
                prompt,
                options: {
                    maxTurns: this.config.maxTurns || 1,
                    cwd: this.config.cwd,
                },
            });

            // Extract JSON annotations from the response
            const jsonResult = this.sdkWrapper.extractJSON(messages);
            if (jsonResult) {
                return JSON.stringify(jsonResult);
            }

            // If no JSON found, create annotation from the response text
            const responseText = messages
                .map((m) => (typeof m === 'string' ? m : m.content || JSON.stringify(m)))
                .join('\n');

            return JSON.stringify([
                {
                    message: `${this.activeProfile.annotationTemplates.prefix} ${responseText.substring(0, 200)}`,
                    line: 0,
                    severity: this.activeProfile.annotationTemplates.severity,
                    tags: this.activeProfile.annotationTemplates.tags.slice(0, 2),
                },
            ]);
        } catch (error) {
            console.error('Claude Code SDK error:', error);
            throw error;
        }
    }

    private async callClaudeREST(prompt: string): Promise<string> {
        const endpoint = 'https://api.anthropic.com/v1/messages';
        const model = 'claude-3-opus-20240229';
        const maxTokens = 4000;
        const temperature = 0.3;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.config.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: maxTokens,
                    temperature,
                    messages: [
                        {
                            role: 'user',
                            content: prompt,
                        },
                    ],
                }),
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('❌ Claude API error:', error);
                throw new Error(`Claude API error: ${response.status} - ${error}`);
            }

            const data = await response.json();
            const content = data.content?.[0]?.text || '';

            // Try to extract JSON annotations from the response
            const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/g);
            if (jsonMatch) {
                return jsonMatch[0];
            }

            // If no JSON found, create a simple annotation
            const simpleAnnotation = JSON.stringify([
                {
                    message: `${this.activeProfile.annotationTemplates.prefix} ${content.substring(0, 200)}`,
                    line: 0,
                    severity: this.activeProfile.annotationTemplates.severity,
                    tags: this.activeProfile.annotationTemplates.tags.slice(0, 2),
                },
            ]);

            return simpleAnnotation;
        } catch (error) {
            console.error('❌ Claude REST API error:', error);
            throw new Error(`Failed to call Claude REST API: ${error}`);
        }
    }

    private parseAnnotations(response: string, filePath: string, baseLineNumber: number): Partial<Annotation>[] {
        try {
            const parsedAnnotations = JSON.parse(response);

            const profile = this.activeProfile;

            if (!Array.isArray(parsedAnnotations)) {
                console.warn('⚠️ Parsed data is not an array:', parsedAnnotations);
                return [];
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mappedAnnotations = parsedAnnotations.map((ann: any, _index: number) => {
                const mapped = {
                    message: ann.message,
                    file: filePath,
                    line: baseLineNumber + (ann.line || 0),
                    severity: ann.severity || profile.annotationTemplates.severity,
                    tags: [...(ann.tags || []), ...profile.annotationTemplates.tags],
                    kanbanColumn: 'todo',
                };
                return mapped;
            });

            return mappedAnnotations;
        } catch (error) {
            console.error('❌ Failed to parse Claude response:', error);
            console.error('📄 Raw response was:', response);
            return [];
        }
    }

    public async analyzeFile(document: vscode.TextDocument, profile?: string): Promise<Partial<Annotation>[]> {
        if (profile) {
            this.setActiveProfile(profile);
        }

        const code = document.getText();
        const filePath = document.fileName;
        const language = document.languageId;

        // Analyze the entire file and generate annotations
        const result = await this.generateAnnotations(code, filePath, 0, {
            language,
            projectInfo: vscode.workspace.name || 'Unknown Project',
        });

        return result;
    }

    public async suggestAnnotationForLine(
        document: vscode.TextDocument,
        lineNumber: number,
        profile?: string
    ): Promise<Partial<Annotation> | null> {
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

        const annotations = await this.generateAnnotations(codeContext, document.fileName, lineNumber, {
            language: document.languageId,
            additionalContext: `Focus on line ${lineNumber - startLine + 1} of the provided context`,
        });

        return annotations.length > 0 ? annotations[0] : null;
    }
}
