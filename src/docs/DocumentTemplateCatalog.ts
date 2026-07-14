// SPDX-License-Identifier: MPL-2.0

/** Output profiles supported by the documentation studio. */
export type DocumentationFormat =
    | 'markdown'
    | 'static-site'
    | 'wiki'
    | 'hosted-wiki'
    | 'ordered-wiki'
    | 'html'
    | 'openapi';

export type BuiltInDocumentTemplateId = 'complete' | 'api-reference' | 'team-wiki' | 'knowledge-base';

export type TechnicalDocumentKind =
    | 'readme'
    | 'changelog'
    | 'architecture'
    | 'adr'
    | 'onboarding'
    | 'runbook'
    | 'reference';

export const SUPPORTED_TECHNICAL_DOCUMENT_KINDS: readonly TechnicalDocumentKind[] = [
    'readme',
    'changelog',
    'architecture',
    'adr',
    'onboarding',
    'runbook',
    'reference',
];

export interface DocumentTemplateDefinition {
    schemaVersion: 1;
    id: string;
    label: string;
    description: string;
    formats: DocumentationFormat[];
    documents: TechnicalDocumentKind[];
    includeInventory: boolean;
    includeAuthored: boolean;
    /** A single safe path segment. */
    apiFolder: string;
    /** A single safe Markdown file name. */
    guideFile: string;
    language: string;
}

export const SUPPORTED_DOCUMENTATION_FORMATS: readonly DocumentationFormat[] = [
    'markdown',
    'static-site',
    'wiki',
    'hosted-wiki',
    'ordered-wiki',
    'html',
    'openapi',
];

const FORMATS: ReadonlySet<string> = new Set<DocumentationFormat>(SUPPORTED_DOCUMENTATION_FORMATS);
const LEGACY_FORMATS: Readonly<Record<string, DocumentationFormat>> = {
    docfx: 'static-site',
    'github-wiki': 'hosted-wiki',
    'azure-wiki': 'ordered-wiki',
};

const TECHNICAL_DOCUMENT_KINDS: ReadonlySet<string> = new Set(SUPPORTED_TECHNICAL_DOCUMENT_KINDS);

/** Canonical language[-Script][-REGION] subset supported by every bundled output. */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

export function isSupportedDocumentationLanguage(value: string): boolean {
    return LANGUAGE_TAG.test(value);
}

// Windows device names remain reserved even when followed by an extension.
// Include the console aliases and legacy superscript serial-port variants so a
// template generated on one platform can safely be checked out on another.
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function normalizeDocumentationFormat(value: unknown): DocumentationFormat | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    return FORMATS.has(value) ? (value as DocumentationFormat) : LEGACY_FORMATS[value];
}

const BUILT_INS: Readonly<Record<BuiltInDocumentTemplateId, DocumentTemplateDefinition>> = {
    complete: {
        schemaVersion: 1,
        id: 'complete',
        label: 'Complete documentation portal',
        description: 'Source pages, a static project, team wiki, accessible web output and an API catalogue.',
        formats: ['markdown', 'static-site', 'hosted-wiki', 'html', 'openapi'],
        documents: ['readme', 'changelog', 'architecture', 'adr', 'onboarding', 'runbook', 'reference'],
        includeInventory: true,
        includeAuthored: true,
        apiFolder: 'api',
        guideFile: 'guide.md',
        language: 'en',
    },
    'api-reference': {
        schemaVersion: 1,
        id: 'api-reference',
        label: 'API reference',
        description: 'Authored API pages with static-project, accessible web and safe API-contract outputs.',
        formats: ['markdown', 'static-site', 'html', 'openapi'],
        documents: ['readme', 'changelog', 'reference'],
        includeInventory: false,
        includeAuthored: true,
        apiFolder: 'api',
        guideFile: 'guide.md',
        language: 'en',
    },
    'team-wiki': {
        schemaVersion: 1,
        id: 'team-wiki',
        label: 'Team wiki',
        description: 'Portable team knowledge base packaged for a hosted wiki and accessible web output.',
        formats: ['markdown', 'hosted-wiki', 'html'],
        documents: ['readme', 'changelog', 'architecture', 'adr', 'onboarding', 'runbook'],
        includeInventory: true,
        includeAuthored: true,
        apiFolder: 'api',
        guideFile: 'guide.md',
        language: 'en',
    },
    'knowledge-base': {
        schemaVersion: 1,
        id: 'knowledge-base',
        label: 'Portable knowledge base',
        description: 'Portable Markdown pages with GFM extensions and a static HTML companion.',
        formats: ['markdown', 'wiki', 'html'],
        documents: ['readme', 'architecture', 'adr', 'onboarding', 'runbook', 'reference'],
        includeInventory: true,
        includeAuthored: true,
        apiFolder: 'topics',
        guideFile: 'handbook.md',
        language: 'en',
    },
};

function cloneTemplate(template: DocumentTemplateDefinition): DocumentTemplateDefinition {
    return { ...template, formats: [...template.formats], documents: [...template.documents] };
}

export function listBuiltInDocumentTemplates(): DocumentTemplateDefinition[] {
    return Object.values(BUILT_INS).map(cloneTemplate);
}

export function getBuiltInDocumentTemplate(id: string): DocumentTemplateDefinition | undefined {
    return Object.prototype.hasOwnProperty.call(BUILT_INS, id)
        ? cloneTemplate(BUILT_INS[id as BuiltInDocumentTemplateId])
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, maxLength: number): string {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
        throw new Error(`Document template field "${key}" must be a non-empty string (maximum ${maxLength}).`);
    }
    return value.trim();
}

function requirePortableSegment(record: Record<string, unknown>, key: string, maxLength: number): string {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new Error(`Document template field "${key}" must be a non-empty string (maximum ${maxLength}).`);
    }
    const hasControlCharacter = Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    if (
        value !== value.trim() ||
        value.startsWith('.') ||
        /[ .]$/.test(value) ||
        /[\\/:*?"<>|]/.test(value) ||
        hasControlCharacter ||
        WINDOWS_RESERVED_BASENAME.test(value)
    ) {
        throw new Error(`Document template field "${key}" must be one portable, non-hidden path segment.`);
    }
    return value;
}

/**
 * Parse a workspace-owned JSON template. The schema is deliberately small:
 * document structure belongs here while visual renderer themes stay in their
 * own profile. Unknown fields are rejected so typos cannot silently alter a
 * release build.
 */
export function parseCustomDocumentTemplate(input: unknown): DocumentTemplateDefinition {
    if (!isRecord(input)) {
        throw new Error('Document template must be a JSON object.');
    }
    const allowed = new Set([
        '$schema',
        'schemaVersion',
        'id',
        'label',
        'description',
        'formats',
        'documents',
        'includeInventory',
        'includeAuthored',
        'apiFolder',
        'guideFile',
        'language',
    ]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) {
            throw new Error(`Unknown document template field "${key}".`);
        }
    }
    if (input.schemaVersion !== 1) {
        throw new Error('Document template schemaVersion must be 1.');
    }
    const id = requireString(input, 'id', 64);
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
        throw new Error('Document template id must use lowercase letters, numbers, dots, dashes or underscores.');
    }
    if (!Array.isArray(input.formats) || input.formats.length === 0) {
        throw new Error('Document template formats must contain at least one output format.');
    }
    const formats: DocumentationFormat[] = [];
    for (const value of input.formats) {
        if (typeof value !== 'string' || !FORMATS.has(value)) {
            throw new Error(`Unsupported documentation format "${String(value)}".`);
        }
        const format = value as DocumentationFormat;
        if (formats.includes(format)) {
            throw new Error(`Document template format "${format}" must not be repeated.`);
        }
        formats.push(format);
    }
    const rawDocuments = input.documents;
    if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
        throw new Error('Document template documents must contain at least one technical document kind.');
    }
    const documents: TechnicalDocumentKind[] = [];
    for (const value of rawDocuments) {
        if (typeof value !== 'string' || !TECHNICAL_DOCUMENT_KINDS.has(value)) {
            throw new Error(`Unsupported technical document kind "${String(value)}".`);
        }
        const document = value as TechnicalDocumentKind;
        if (documents.includes(document)) {
            throw new Error(`Technical document kind "${document}" must not be repeated.`);
        }
        documents.push(document);
    }
    if (typeof input.includeInventory !== 'boolean' || typeof input.includeAuthored !== 'boolean') {
        throw new Error('Document template includeInventory and includeAuthored must be booleans.');
    }
    if (!input.includeInventory && !input.includeAuthored) {
        throw new Error('A document template must include inventory or authored documentation.');
    }
    const guideFile = requirePortableSegment(input, 'guideFile', 96);
    if (!guideFile.endsWith('.md')) {
        throw new Error('Document template guideFile must end in lowercase .md.');
    }
    const rawLanguage = input.language;
    const language = requireString(input, 'language', 15);
    if (rawLanguage !== language || !isSupportedDocumentationLanguage(language)) {
        throw new Error(
            'Document template language must use the canonical language[-Script][-REGION] subset (for example en, fr-CA or zh-Hant-TW).'
        );
    }
    return {
        schemaVersion: 1,
        id,
        label: requireString(input, 'label', 120),
        description: requireString(input, 'description', 500),
        formats,
        documents,
        includeInventory: input.includeInventory,
        includeAuthored: input.includeAuthored,
        apiFolder: requirePortableSegment(input, 'apiFolder', 64),
        guideFile,
        language,
    };
}
