// SPDX-License-Identifier: MPL-2.0
import { generateDocSet, type DocAnnotation, type DocGenOptions } from './AnnotationDocGenerator';
import { createStaticSiteBundle, createWikiBundle } from './DocumentationBundles';
import type { DocumentationFormat, TechnicalDocumentKind } from './DocumentTemplateCatalog';
import {
    generateOpenApiDocumentation,
    type OpenApiGenerationProfile,
    type OpenApiDiagnostic,
} from './OpenApiDocumentation';
import { generateStaticHtmlDocumentation } from './StaticHtmlDocumentation';
import { generateTechnicalDocuments } from './TechnicalDocumentGenerator';

export interface DocumentationStudioDiagnostic {
    profile: DocumentationFormat | 'technical' | 'studio';
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    file?: string;
    annotationId?: string;
}

export interface DocumentationStudioOptions {
    title: string;
    language: string;
    formats: readonly DocumentationFormat[];
    /** Repository-native artifacts assembled from explicit annotation roles. */
    technicalDocuments?: readonly TechnicalDocumentKind[];
    /** Number of path segments between the output directory and workspace root. */
    sourceRootDepth: number;
    base: Omit<DocGenOptions, 'title' | 'sourceLinkPrefix'>;
    openApiProfile?: OpenApiGenerationProfile;
    openApiProfileDiagnostics?: readonly OpenApiDiagnostic[];
}

export interface DocumentationStudioResult {
    files: ReadonlyMap<string, string>;
    diagnostics: readonly DocumentationStudioDiagnostic[];
    entryPoint: string;
}

function addFiles(target: Map<string, string>, source: ReadonlyMap<string, string>, prefix = ''): void {
    for (const [name, content] of source) {
        const destination = prefix ? `${prefix}/${name}` : name;
        if (target.has(destination)) {
            throw new Error(`Documentation profiles attempted to write the same file: ${destination}`);
        }
        target.set(destination, content);
    }
}

function technicalTitle(path: string, content: string): string {
    const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(content)?.[1]?.trim();
    if (heading) {
        return heading;
    }
    const fileName = path.split('/').pop()?.replace(/\.md$/i, '') || 'Document';
    return fileName.replace(/[-_]+/g, ' ');
}

function appendTechnicalNavigation(base: Map<string, string>, technical: ReadonlyMap<string, string>): void {
    const markdown = [...technical.entries()].filter(([path]) => path.toLowerCase().endsWith('.md'));
    if (markdown.length === 0) {
        return;
    }
    const current = base.get('toc.yml')?.trimEnd() ?? '';
    const lines = [current, '- name: "Technical documents"', '  items:'].filter(Boolean);
    for (const [path, content] of markdown) {
        lines.push(`    - name: ${JSON.stringify(technicalTitle(path, content))}`);
        lines.push(`      href: ${path}`);
    }
    base.set('toc.yml', `${lines.join('\n')}\n`);
}

function sortedFiles(files: ReadonlyMap<string, string>): Map<string, string> {
    return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

/** Build every selected representation from the same normalized annotation set. */
export function generateDocumentationStudio(
    annotations: readonly DocAnnotation[],
    options: DocumentationStudioOptions
): DocumentationStudioResult {
    const selected = new Set(options.formats);
    if (selected.size === 0) {
        throw new Error('Documentation Studio requires at least one output format.');
    }
    const carriesTechnicalDocuments = [...selected].some((format) => format !== 'openapi');
    if ((options.technicalDocuments?.length ?? 0) > 0 && !carriesTechnicalDocuments) {
        throw new Error(
            'Technical documents require Markdown, static-site, wiki, hosted-wiki, ordered-wiki, or HTML output.'
        );
    }
    const files = new Map<string, string>();
    const diagnostics: DocumentationStudioDiagnostic[] = [];
    let technicalFiles: ReadonlyMap<string, string> = new Map();
    const base = generateDocSet([...annotations], {
        ...options.base,
        title: options.title,
        sourceLinkPrefix: '../'.repeat(options.sourceRootDepth),
    });
    if (options.technicalDocuments) {
        const technical = generateTechnicalDocuments(annotations, {
            kinds: options.technicalDocuments,
            projectTitle: options.title,
            tagPrefix: options.base.tagPrefix,
            sourceRootDepth: options.sourceRootDepth,
        });
        technicalFiles = technical.files;
        const collisions = [...technical.files.keys()].filter((path) => base.has(path));
        if (collisions.length > 0) {
            throw new Error(
                `Technical documents collide with normalized source output at: ${collisions.join(', ')}. ` +
                    'Choose a different documentation guide/API path or disable the conflicting technical document.'
            );
        }
        addFiles(base, technical.files);
        appendTechnicalNavigation(base, technical.files);
        diagnostics.push(
            ...technical.diagnostics.map((item) => ({
                profile: 'technical' as const,
                severity: item.severity,
                code: item.code,
                message: item.message,
                ...(item.path ? { file: item.path } : {}),
                ...(item.annotationId ? { annotationId: item.annotationId } : {}),
            }))
        );
    }

    if (selected.has('static-site')) {
        const result = createStaticSiteBundle(base, {
            title: options.title,
            language: options.language,
            pageIdPrefix: 'ooci',
            outputDirectory: '_site',
        });
        addFiles(files, result.files);
        diagnostics.push(
            ...result.diagnostics.map((item) => ({
                profile: 'static-site' as const,
                severity: item.severity,
                code: item.code,
                message: item.message,
                ...(item.file ? { file: item.file } : {}),
            }))
        );
    } else if (selected.has('markdown')) {
        addFiles(files, base);
    }

    const wikiProfiles: readonly [DocumentationFormat, 'generic' | 'github' | 'azure', string][] = [
        ['wiki', 'generic', 'wiki/portable'],
        ['hosted-wiki', 'github', 'wiki/hosted'],
        ['ordered-wiki', 'azure', 'wiki/ordered'],
    ];
    for (const [format, flavor, output] of wikiProfiles) {
        if (!selected.has(format)) {
            continue;
        }
        const result = createWikiBundle(base, {
            flavor,
            title: options.title,
            sourceFiles: annotations.map((annotation) => annotation.file),
            sourceRootDepth: options.sourceRootDepth,
            outputPathPrefixDepth: output.split('/').length,
        });
        addFiles(files, result.files, output);
        diagnostics.push(
            ...result.diagnostics.map((item) => ({
                profile: format,
                severity: item.severity,
                code: item.code,
                message: item.message,
                ...(item.file ? { file: `${output}/${item.file}` } : {}),
            }))
        );
    }

    if (selected.has('html')) {
        const result = generateStaticHtmlDocumentation(annotations, {
            title: options.title,
            lang: options.language,
            description: 'Generated from out-of-code annotations without modifying source files.',
            technicalDocuments: technicalFiles,
        });
        addFiles(files, result.files, 'html');
        diagnostics.push(
            ...result.diagnostics.map((item) => ({
                profile: 'html' as const,
                severity: item.severity,
                code: item.code,
                message: item.message,
                ...(item.documentPath ? { file: item.documentPath } : {}),
                ...(item.annotationId ? { annotationId: item.annotationId } : {}),
            }))
        );
    }

    if (selected.has('openapi')) {
        diagnostics.push(
            ...(options.openApiProfileDiagnostics ?? []).map((item) => ({
                profile: 'openapi' as const,
                severity: item.severity,
                code: `profile-${item.code}`,
                message: item.message,
                ...(item.location ? { file: item.location } : {}),
                ...(item.annotationId ? { annotationId: item.annotationId } : {}),
            }))
        );
        const profile = {
            ...options.openApiProfile,
            title: options.openApiProfile?.title ?? `${options.title} — API catalogue`,
        };
        const result = generateOpenApiDocumentation(annotations, profile);
        files.set('openapi/openapi.json', result.json);
        diagnostics.push(
            ...result.diagnostics.map((item) => ({
                profile: 'openapi' as const,
                severity: item.severity,
                code: item.code,
                message: item.message,
                ...(item.location ? { file: item.location } : {}),
                ...(item.annotationId ? { annotationId: item.annotationId } : {}),
            }))
        );
    }

    diagnostics.sort(
        (left, right) =>
            left.profile.localeCompare(right.profile) ||
            left.severity.localeCompare(right.severity) ||
            left.code.localeCompare(right.code) ||
            (left.file ?? '').localeCompare(right.file ?? '')
    );
    const report = {
        schemaVersion: 1,
        title: options.title,
        formats: [...selected].sort(),
        technicalDocuments: [...(options.technicalDocuments ?? [])].sort(),
        annotationCount: annotations.length,
        fileCount: files.size + 1,
        diagnostics,
    };
    files.set('documentation-report.json', JSON.stringify(report, null, 2) + '\n');

    const entryPoint = files.has('index.md')
        ? 'index.md'
        : files.has('html/index.html')
          ? 'html/index.html'
          : files.has('wiki/hosted/Home.md')
            ? 'wiki/hosted/Home.md'
            : files.has('wiki/portable/Home.md')
              ? 'wiki/portable/Home.md'
              : files.has('wiki/ordered/Home.md')
                ? 'wiki/ordered/Home.md'
                : 'openapi/openapi.json';
    return { files: sortedFiles(files), diagnostics, entryPoint };
}
