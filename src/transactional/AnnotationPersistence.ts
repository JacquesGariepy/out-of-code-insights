// SPDX-License-Identifier: MPL-2.0
//
// AnnotationPersistence — load/save the v2 envelope to disk.
//
// Lot 5 R1 scope: load / save / path traversal guard. No file watcher in
// this round (deferred to R2 if needed). Path resolution is workspace-folder
// relative; configurable via the constructor (default
// `.out-of-code-insights/annotations.json`).
//
// Tests: `src/transactional/__tests__/AnnotationPersistence.unit.test.ts`
// uses Node's `fs/promises` against `os.tmpdir()` so the suite stays
// pure-Node (no EDH).

import { promises as fs } from 'fs';
import * as path from 'path';
import { TypedEventEmitter } from './internal/event-emitter';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2 } from './types';

/** Default location relative to the workspace root. */
export const DEFAULT_ANNOTATION_FILE_RELATIVE_PATH = '.out-of-code-insights/annotations.json';

/**
 * Structural shape used by AnnotationPersistence — matches
 * `vscode.WorkspaceFolder` but free of a runtime dependency on `vscode`.
 */
export interface PersistenceWorkspaceFolder {
    readonly uri: { readonly fsPath: string };
}

export class AnnotationPersistence {
    private readonly absolutePath: string;
    private readonly _onDidLoad = new TypedEventEmitter<AnnotationStoreFileV2>();
    private readonly _onDidSave = new TypedEventEmitter<AnnotationStoreFileV2>();

    readonly onDidLoad = this._onDidLoad.event;
    readonly onDidSave = this._onDidSave.event;

    constructor(
        workspaceFolder: PersistenceWorkspaceFolder,
        relativePath: string = DEFAULT_ANNOTATION_FILE_RELATIVE_PATH
    ) {
        if (path.isAbsolute(relativePath)) {
            throw new Error(`AnnotationPersistence: relative path must not be absolute (got ${relativePath})`);
        }
        const segments = relativePath.split(/[\\/]/);
        if (segments.includes('..')) {
            throw new Error(
                `AnnotationPersistence: relative path must not contain '..' segments (got ${relativePath})`
            );
        }
        this.absolutePath = path.join(workspaceFolder.uri.fsPath, relativePath);
    }

    /** Absolute on-disk path for the annotations file. Stable for the lifetime of the instance. */
    getPath(): string {
        return this.absolutePath;
    }

    /**
     * Read the annotations envelope from disk.
     * - File missing → return an empty v2 envelope (no error).
     * - File present but unreadable / unparsable / wrong schemaVersion → throws.
     */
    async load(): Promise<AnnotationStoreFileV2> {
        let content: string;
        try {
            content = await fs.readFile(this.absolutePath, 'utf8');
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') {
                const empty: AnnotationStoreFileV2 = {
                    schemaVersion: ANNOTATION_SCHEMA_VERSION,
                    annotations: [],
                };
                this._onDidLoad.fire(empty);
                return empty;
            }
            throw err;
        }
        const parsed = JSON.parse(content) as AnnotationStoreFileV2;
        if (parsed.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new Error(
                `AnnotationPersistence.load: unsupported schemaVersion ${String(parsed.schemaVersion)} ` +
                    `(expected ${ANNOTATION_SCHEMA_VERSION}, no migration path in v2)`
            );
        }
        if (!Array.isArray(parsed.annotations)) {
            throw new Error('AnnotationPersistence.load: malformed envelope — `annotations` must be an array');
        }
        this._onDidLoad.fire(parsed);
        return parsed;
    }

    /**
     * Write the envelope to disk as pretty-printed JSON (indent=2). Creates
     * the parent directory recursively if missing.
     */
    async save(payload: AnnotationStoreFileV2): Promise<void> {
        if (payload.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
            throw new Error(
                `AnnotationPersistence.save: payload schemaVersion must be ${ANNOTATION_SCHEMA_VERSION} ` +
                    `(got ${String(payload.schemaVersion)})`
            );
        }
        const dir = path.dirname(this.absolutePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(this.absolutePath, JSON.stringify(payload, null, 2), 'utf8');
        this._onDidSave.fire(payload);
    }

    dispose(): void {
        this._onDidLoad.dispose();
        this._onDidSave.dispose();
    }
}
