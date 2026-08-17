// SPDX-License-Identifier: MPL-2.0
//
// AnnotationRehoming - rebase foreign annotation URIs onto the current
// workspace at load time.
//
// annotations.json is designed to be shared (committed to Git, synced by the
// MCP server or the sync service), but each `fileUri` is the absolute
// `vscode.Uri.toString()` of the machine that last saved it. On a teammate's
// workstation those URIs point at a nonexistent path, so decorations never
// attach and `navigate` fails with "Unable to resolve nonexistent file".
//
// Every annotation also persists `file`, its path relative to the workspace
// root. Rehoming uses that portable path to rewrite any `fileUri` that does
// not live under the current workspace folder. Like AnnotationPersistence,
// this module is deliberately vscode-free so the path handling can be
// unit-tested natively; the caller supplies the workspace URI and a
// `vscode.Uri.joinPath`-backed factory.

import type { AnnotationStoreFileV2, AnnotationV2 } from './types';

/** Everything rehoming needs to know about the current workspace. */
export interface RehomingTarget {
    /**
     * `vscode.WorkspaceFolder.uri.toString()` for the folder that owns the
     * annotations file. Annotations whose fileUri already lives under this
     * prefix are left untouched.
     */
    workspaceUri: string;
    /**
     * Build the canonical URI string for a workspace-relative POSIX path.
     * Production callers back this with
     * `vscode.Uri.joinPath(folder.uri, ...relativePath.split('/')).toString()`
     * so the produced URI matches the encoding of URIs created by the editor
     * at runtime (drive-letter casing, percent-encoding, remote schemes).
     */
    toUriString(relativePath: string): string;
}

/** Outcome of a rehoming pass. The input payload is never mutated. */
export interface RehomingResult {
    payload: AnnotationStoreFileV2;
    /** Number of annotations whose fileUri was rebased onto the workspace. */
    rehomedCount: number;
}

/**
 * Validate and normalize a persisted workspace-relative path so a hostile or
 * corrupted annotations file cannot redirect an annotation outside the
 * workspace. Returns the POSIX form, or undefined when the path is unusable
 * (empty, absolute, UNC, drive-qualified, or attempting `..` traversal).
 */
export function sanitizeRelativeAnnotationPath(candidate: string | undefined): string | undefined {
    if (typeof candidate !== 'string') {
        return undefined;
    }
    const trimmed = candidate.trim();
    if (trimmed === '') {
        return undefined;
    }
    // Absolute forms: POSIX (/x), Windows drive (C:\x or C:/x), UNC (\\host).
    if (/^[/\\]/.test(trimmed) || /^[A-Za-z]:[/\\]/.test(trimmed)) {
        return undefined;
    }
    const segments = trimmed.split(/[/\\]+/).filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.some((segment) => segment === '..')) {
        return undefined;
    }
    return segments.join('/');
}

/**
 * Rebase every annotation whose `fileUri` does not live under the current
 * workspace folder onto that folder, using the annotation's persisted
 * relative `file` path. Annotations already scoped to the workspace, and
 * annotations whose relative path is missing or unsafe, pass through
 * unchanged — an unresolvable foreign annotation is preserved as-is rather
 * than dropped, so no data is lost by loading a file authored elsewhere.
 */
export function rehomeAnnotationsPayload(payload: AnnotationStoreFileV2, target: RehomingTarget): RehomingResult {
    const prefix = target.workspaceUri.endsWith('/') ? target.workspaceUri : `${target.workspaceUri}/`;

    let rehomedCount = 0;
    const annotations = payload.annotations.map((annotation): AnnotationV2 => {
        const { fileUri } = annotation;
        if (fileUri === target.workspaceUri || fileUri.startsWith(prefix)) {
            return annotation;
        }
        const relativePath = sanitizeRelativeAnnotationPath(annotation.file);
        if (relativePath === undefined) {
            return annotation;
        }
        const rebasedUri = target.toUriString(relativePath);
        if (rebasedUri === fileUri) {
            return annotation;
        }
        rehomedCount++;
        return { ...annotation, fileUri: rebasedUri, file: relativePath };
    });

    if (rehomedCount === 0) {
        return { payload, rehomedCount };
    }
    return { payload: { ...payload, annotations }, rehomedCount };
}
