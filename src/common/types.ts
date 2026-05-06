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

/**
 * Structured anchor recorded at annotation creation. Mirrors the fields the
 * resolver needs to re-locate the annotation after edits without relying on
 * a fragile (file, line) pair. See src/anchoring/anchor.ts.
 */
export interface AnnotationAnchor {
    /** What kind of target this anchor points to. */
    kind: 'symbol' | 'line' | 'file';

    /** Original line at creation (the cursor position). May be the blank line above a symbol. */
    originalLine: number;

    /** The line actually used to compute anchorTextHash (may differ when walked from a blank line). */
    targetLine: number;

    /** Symbol metadata when kind === 'symbol' (resolved via DocumentSymbolProvider). */
    symbolName?: string | null;
    symbolKind?: string | null;
    symbolSignature?: string | null;

    /** FNV-1a hash of the normalized target line text. Empty hash is treated as stale. */
    anchorTextHash: string;

    contextBefore: string[];
    contextAfter: string[];
}

/** Runtime resolution state. NEVER persisted as ground truth -- always recomputed. */
export interface ResolvedAnnotationAnchor {
    status: 'attached' | 'moved' | 'orphaned' | 'ambiguous' | 'stale';
    line: number | null;
    confidence: number;
    reason: string;
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
    lineHash?: string;
    contextBefore?: string[];
    contextAfter?: string[];
    /**
     * Full document URI string (document.uri.toString()). When set, this is
     * the authoritative scope for the annotation. The legacy `file` field
     * remains as display metadata. Annotations created before this field
     * existed have `fileUri` undefined and fall back to `file` matching.
     */
    fileUri?: string;
    /** Language id of the document at creation time, e.g. 'typescript', 'python'. */
    languageId?: string;
    /** Structured anchor (symbol-aware). When absent, lineHash/contextBefore/contextAfter is the legacy anchor. */
    anchor?: AnnotationAnchor;
    /** Metadata for annotations derived from editor text operations. */
    origin?: {
        kind: 'copy-paste';
        sourceId: string;
        sourceFile?: string;
        sourceFileUri?: string;
        sourceLine: number;
        pastedAtLine: number;
    };
    /** Runtime resolution state (transient, recomputed on every refresh). */
    resolvedAnchor?: ResolvedAnnotationAnchor;
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
