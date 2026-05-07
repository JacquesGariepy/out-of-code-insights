// SPDX-License-Identifier: MPL-2.0
//
// VisibilityFilter — filters annotations from the active map for display
// purposes (Tree, Kanban, CodeLens). Pure logic; depends on a config getter
// passed by DI so the class stays unit-testable in pure Node.

import { TypedEventEmitter } from './internal/event-emitter';

/**
 * Subset of the project's annotation configuration consumed by the filter.
 * Mirrors the legacy `AnnotationManager.config` and `currentFilter` fields.
 */
export interface AnnotationVisibilityConfig {
    /** Kill switch for the whole annotations feature. */
    enableAnnotations: boolean;
    /** Tags whose annotations are hidden globally. */
    disabledTags: ReadonlyArray<string>;
    /**
     * Active filter expression. Recognised forms:
     *   - 'all'         → no filtering.
     *   - 'keyword:foo' → match `message` or any thread comment.
     *   - 'severity:s'  → match annotation.severity exactly.
     *   - <tag>         → annotation has the tag (case-insensitive); else
     *                     match if `file` contains the term (case-insensitive).
     * Default: 'all'.
     */
    currentFilter?: string;
}

/** Subset of AnnotationV2 that VisibilityFilter consults. */
export interface AnnotationVisibilityInput {
    tags?: ReadonlyArray<string>;
    severity?: string;
    file: string;
    message: string;
    thread?: ReadonlyArray<{ message: string }>;
}

export class VisibilityFilter {
    private readonly _onDidChange = new TypedEventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly getConfig: () => AnnotationVisibilityConfig) {}

    /** Global enable/disable from `outOfCodeInsights.enableAnnotations`. */
    isGloballyEnabled(): boolean {
        return this.getConfig().enableAnnotations;
    }

    /**
     * Per-annotation visibility decision. Returns `true` iff the annotation
     * passes the disabled-tags gate AND the active filter expression.
     */
    isVisible(annotation: AnnotationVisibilityInput): boolean {
        const config = this.getConfig();
        if (annotation.tags && annotation.tags.some((t) => config.disabledTags.includes(t))) {
            return false;
        }

        const filter = (config.currentFilter ?? 'all').trim();
        if (filter === '' || filter === 'all') {
            return true;
        }

        if (filter.startsWith('keyword:')) {
            const keyword = filter.substring('keyword:'.length).toLowerCase();
            if (keyword === '') {
                return true;
            }
            const inMessage = annotation.message.toLowerCase().includes(keyword);
            const inThread = annotation.thread?.some((c) => c.message.toLowerCase().includes(keyword)) ?? false;
            return inMessage || inThread;
        }

        if (filter.startsWith('severity:')) {
            const sev = filter.substring('severity:'.length);
            return annotation.severity === sev;
        }

        // Tag-or-file fallback (legacy behaviour from
        // AnnotationManager.shouldAnnotationBeVisible).
        const filterTag = filter.toLowerCase();
        if (annotation.tags && annotation.tags.map((t) => t.toLowerCase()).includes(filterTag)) {
            return true;
        }
        return annotation.file.toLowerCase().includes(filterTag);
    }

    /**
     * Notify subscribers that the filter has changed (e.g. user toggled a
     * tag or switched filter). Idempotent; consumers re-query state on tick.
     */
    refresh(): void {
        this._onDidChange.fire();
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
