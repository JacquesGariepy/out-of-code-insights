// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'crypto';

export const DOCUMENTATION_MANIFEST_FILE = '.ooci-docs-manifest.json';

export interface DocumentationManifestEntry {
    path: string;
    sha256: string;
    bytes: number;
}

export interface DocumentationManifest {
    schemaVersion: 1;
    generator: 'out-of-code-insights';
    generatorVersion: string;
    template: string;
    formats: string[];
    generatedAt?: string;
    files: DocumentationManifestEntry[];
}

export interface DocumentationManifestOptions {
    generatorVersion: string;
    template: string;
    formats: string[];
    generatedAt?: string;
}

/** Normalize and validate a bundle path before it reaches a workspace FS API. */
export function normalizeDocumentationPath(input: string): string {
    const normalized = input.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (
        normalized.length === 0 ||
        normalized.length > 240 ||
        normalized.startsWith('/') ||
        /^[A-Za-z]:/.test(normalized) ||
        segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
        segments.some(
            (segment) =>
                /[:*?"<>|]/.test(segment) ||
                [...segment].some((character) => {
                    const codePoint = character.codePointAt(0) ?? 0;
                    return codePoint <= 31 || codePoint === 127;
                })
        ) ||
        segments.some((segment) => /[. ]$/.test(segment)) ||
        segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))
    ) {
        throw new Error(`Unsafe generated documentation path "${input}".`);
    }
    return normalized;
}

export function normalizeDocumentationFiles(files: ReadonlyMap<string, string>): Map<string, string> {
    const normalized = new Map<string, string>();
    const caseInsensitive = new Set<string>();
    for (const [rawPath, content] of files) {
        const filePath = normalizeDocumentationPath(rawPath);
        if (filePath === DOCUMENTATION_MANIFEST_FILE) {
            throw new Error(`${DOCUMENTATION_MANIFEST_FILE} is reserved for the documentation writer.`);
        }
        const folded = filePath.toLocaleLowerCase('en-US');
        if (caseInsensitive.has(folded)) {
            throw new Error(`Generated documentation contains a case-insensitive path collision at "${filePath}".`);
        }
        caseInsensitive.add(folded);
        normalized.set(filePath, content.replace(/\r\n/g, '\n'));
    }
    const paths = new Set([...normalized.keys()].map((filePath) => filePath.toLocaleLowerCase('en-US')));
    for (const filePath of paths) {
        const segments = filePath.split('/');
        for (let index = 1; index < segments.length; index++) {
            const ancestor = segments.slice(0, index).join('/');
            if (paths.has(ancestor)) {
                throw new Error(
                    `Generated documentation path "${filePath}" conflicts with file ancestor "${ancestor}".`
                );
            }
        }
    }
    return new Map([...normalized].sort(([left], [right]) => left.localeCompare(right)));
}

export function createDocumentationManifest(
    files: ReadonlyMap<string, string>,
    options: DocumentationManifestOptions
): DocumentationManifest {
    const normalized = normalizeDocumentationFiles(files);
    const entries: DocumentationManifestEntry[] = [];
    for (const [filePath, content] of normalized) {
        const bytes = Buffer.from(content, 'utf8');
        entries.push({
            path: filePath,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.byteLength,
        });
    }
    return {
        schemaVersion: 1,
        generator: 'out-of-code-insights',
        generatorVersion: options.generatorVersion,
        template: options.template,
        formats: [...new Set(options.formats)].sort(),
        ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
        files: entries,
    };
}

export function serializeDocumentationManifest(manifest: DocumentationManifest): string {
    return JSON.stringify(manifest, null, 2) + '\n';
}

/** Parse only manifests owned by this generator; malformed files are never trusted for deletion. */
export function parseDocumentationManifest(input: string): DocumentationManifest | undefined {
    try {
        const value = JSON.parse(input) as Partial<DocumentationManifest>;
        if (
            value.schemaVersion !== 1 ||
            value.generator !== 'out-of-code-insights' ||
            typeof value.generatorVersion !== 'string' ||
            typeof value.template !== 'string' ||
            !Array.isArray(value.formats) ||
            !Array.isArray(value.files)
        ) {
            return undefined;
        }
        const files: DocumentationManifestEntry[] = [];
        const seen = new Set<string>();
        for (const entry of value.files) {
            if (
                typeof entry !== 'object' ||
                entry === null ||
                typeof entry.path !== 'string' ||
                typeof entry.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(entry.sha256) ||
                typeof entry.bytes !== 'number' ||
                !Number.isSafeInteger(entry.bytes) ||
                entry.bytes < 0
            ) {
                return undefined;
            }
            const filePath = normalizeDocumentationPath(entry.path);
            const folded = filePath.toLocaleLowerCase('en-US');
            if (seen.has(folded) || filePath === DOCUMENTATION_MANIFEST_FILE) {
                return undefined;
            }
            seen.add(folded);
            files.push({ path: filePath, sha256: entry.sha256, bytes: entry.bytes });
        }
        const ownedPaths = new Set(files.map((entry) => entry.path.toLocaleLowerCase('en-US')));
        for (const filePath of ownedPaths) {
            const segments = filePath.split('/');
            for (let index = 1; index < segments.length; index++) {
                if (ownedPaths.has(segments.slice(0, index).join('/'))) {
                    return undefined;
                }
            }
        }
        return {
            schemaVersion: 1,
            generator: 'out-of-code-insights',
            generatorVersion: value.generatorVersion,
            template: value.template,
            formats: value.formats.filter((format): format is string => typeof format === 'string'),
            ...(typeof value.generatedAt === 'string' ? { generatedAt: value.generatedAt } : {}),
            files,
        };
    } catch {
        return undefined;
    }
}
