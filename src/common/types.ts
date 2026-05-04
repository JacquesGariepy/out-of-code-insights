import { localize } from './localize';

export interface LinkedAnnotation {
    targetFile: string;
    targetLine: number;
    relationship: 'implements' | 'references' | 'related' | string;
}

export interface AnnotationTemplate {
    id: string;
    name: string;
    content: string;
    variables: Array<{
        name: string;
        description: string;
        defaultValue: string;
    }>;
}

export interface ReviewState {
    viewed: boolean;
    viewedBy: string;
    viewedAt: string;
}

export interface KanbanColumn {
    id: string;
    name: string;
    annotations: string[];
}

export interface Annotation {
    id: string;
    file: string;
    line: number;
    message: string;
    author?: string;
    timestamp: string;
    thread?: Comment[];
    tags?: string[];
    pinned?: boolean;
    priority?: number;
    severity?: string;
    resolved?: boolean;
    linkedAnnotations?: LinkedAnnotation[];
    template?: string;
    reviewState?: ReviewState;
    kanbanColumn?: string;
    snippet?: {
        code: string;
        language: string;
    };
}

export interface Comment {
    id: string;
    message: string;
    author?: string;
    timestamp: string;
}

export interface ExtensionConfig {
    colors: {
        light: {
            annotation: string;
            highlightBackground: string;
            commentBorder: string;
        };
        dark: {
            annotation: string;
            highlightBackground: string;
            commentBorder: string;
        };
    };
    debounceDelay: number;
    maxAnnotationsPerFile: number;
    username: string;
    codelens: {
        enable: boolean;
        showCommands: boolean;
    };
    enableAnnotations: boolean;
    disabledTags: string[];
    enableAiSuggest: boolean;
    defaultSeverity: string;
}

export function ensureStringArray(arr: string[] | undefined): string[] {
    return arr ?? [];
}

export const DEFAULT_CONFIG: ExtensionConfig = {
    colors: {
        light: {
            annotation: '#0366d6',
            highlightBackground: '#f1f8ff',
            commentBorder: '#e1e4e8'
        },
        dark: {
            annotation: '#58a6ff',
            highlightBackground: '#182030',
            commentBorder: '#30363d'
        }
    },
    debounceDelay: 300,
    maxAnnotationsPerFile: 100,
    username: localize('anonymous', 'Anonymous'),
    codelens: {
        enable: true,
        showCommands: true
    },
    enableAnnotations: true,
    disabledTags: [],
    enableAiSuggest: false,
    defaultSeverity: 'info'
};
