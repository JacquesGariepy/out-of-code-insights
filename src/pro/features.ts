// SPDX-License-Identifier: MPL-2.0
//
// Registry of Pro feature identifiers. These are the values users list in
// `annotation.pro.gatedFeatures` to gate a feature behind a license, and the
// ids the code passes to requireEntitlement()/isEntitled(). With the default
// empty `gatedFeatures` everything stays free — the registry only names the
// gates, it does not lock anything by itself.

import { loc } from '../managers/LocalizationManager';

/** Feature ids recognised by `annotation.pro.gatedFeatures`. */
export const PRO_FEATURE_IDS = {
    /** Watch-triggered documentation regeneration (`annotation.docs.watch`). */
    docsWatch: 'docs.watch',
    /** Workspace-wide comment import (`annotations.importCommentsWorkspace`). */
    workspaceCommentImport: 'comments.importWorkspace',
} as const;

/** Union of the registered Pro feature ids. */
export type ProFeatureId = (typeof PRO_FEATURE_IDS)[keyof typeof PRO_FEATURE_IDS];

/**
 * Human-readable, localized name for a Pro feature id — used as the
 * `friendlyName` shown by requireEntitlement() in the unlock toast.
 * Unknown ids fall back to the id itself so callers never render an
 * empty label.
 */
export function localizedFeatureName(id: string): string {
    switch (id) {
        case PRO_FEATURE_IDS.docsWatch:
            return loc('proFeatureDocsWatch', 'Documentation watch mode');
        case PRO_FEATURE_IDS.workspaceCommentImport:
            return loc('proFeatureWorkspaceCommentImport', 'Workspace-wide comment import');
        default:
            return id;
    }
}
