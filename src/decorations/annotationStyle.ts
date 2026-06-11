/**
 * Better-comments-style configurable annotation styling.
 *
 * Pure module: no vscode import, so it runs in the fast `test:unit` pass.
 * The caller (AnnotationManager.createDecorationForAnnotation) reads the
 * `annotation.severityStyles` / `annotation.tagStyles` settings, resolves a
 * style here, and falls back to the theme defaults from `annotation.colors`
 * for every field the resolved style leaves undefined.
 *
 * Precedence (per field):
 *   1. the FIRST tag of the annotation (in tag order) that has a styled
 *      entry in `tagStyles`,
 *   2. the `severityStyles` entry for the annotation severity,
 *   3. built-in defaults (handled by the caller; fields stay undefined here,
 *      except `gutterIcon` which defaults to true — current behavior always
 *      shows the gutter icon).
 *
 * Matching is case-insensitive on both severity and tag names, mirroring the
 * tag comparisons elsewhere in the extension. Entries whose value is not an
 * object, or that define none of the style fields (e.g. the default empty
 * `{ "info": {} }`), are treated as unstyled and ignored.
 */

/** One style entry as written by the user in settings.json. */
export interface StyleSpec {
    /** Color of the inline annotation text (decoration `after.color`). */
    annotationColor?: string;
    /** Background color of the annotated line. */
    backgroundColor?: string;
    /** Color of the left border of the annotated line. */
    border?: string;
    /** Whether the gutter icon is shown for matching annotations. */
    gutterIcon?: boolean;
}

/** The two style maps read from the `annotation.*` configuration. */
export interface StyleConfig {
    severityStyles: Record<string, StyleSpec>;
    tagStyles: Record<string, StyleSpec>;
}

/**
 * Style resolved for one annotation. Color fields are undefined when no
 * configured style covers them — the caller then keeps its existing
 * theme-based fallback.
 */
export interface ResolvedStyle {
    annotationColor?: string;
    backgroundColor?: string;
    border?: string;
    /** Always defined; true unless a matching style disables it. */
    gutterIcon: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Settings come from user JSON: only accept the expected primitive types. */
function pickString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** Sanitized view of a raw settings entry; undefined when it styles nothing. */
function sanitizeSpec(raw: unknown): StyleSpec | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const spec: StyleSpec = {};
    const annotationColor = pickString(raw['annotationColor']);
    if (annotationColor !== undefined) {
        spec.annotationColor = annotationColor;
    }
    const backgroundColor = pickString(raw['backgroundColor']);
    if (backgroundColor !== undefined) {
        spec.backgroundColor = backgroundColor;
    }
    const border = pickString(raw['border']);
    if (border !== undefined) {
        spec.border = border;
    }
    const gutterIcon = pickBoolean(raw['gutterIcon']);
    if (gutterIcon !== undefined) {
        spec.gutterIcon = gutterIcon;
    }
    return Object.keys(spec).length > 0 ? spec : undefined;
}

/** Case-insensitive lookup of `key` in a style map. */
function lookupSpec(styles: Record<string, StyleSpec> | undefined, key: string | undefined): StyleSpec | undefined {
    if (!isRecord(styles) || typeof key !== 'string' || key === '') {
        return undefined;
    }
    const direct = sanitizeSpec(styles[key]);
    if (direct) {
        return direct;
    }
    const lower = key.toLowerCase();
    for (const name of Object.keys(styles)) {
        if (name.toLowerCase() === lower) {
            const spec = sanitizeSpec(styles[name]);
            if (spec) {
                return spec;
            }
        }
    }
    return undefined;
}

/** First tag (in tag order) that resolves to a styled entry. */
function firstTagSpec(
    styles: Record<string, StyleSpec> | undefined,
    tags: string[] | undefined
): StyleSpec | undefined {
    if (!Array.isArray(tags)) {
        return undefined;
    }
    for (const tag of tags) {
        const spec = lookupSpec(styles, tag);
        if (spec) {
            return spec;
        }
    }
    return undefined;
}

/**
 * Resolve the decoration style for one annotation.
 *
 * Per field: tag style (first styled tag) > severity style > undefined
 * (caller applies its built-in theme default). `gutterIcon` defaults to
 * true so unstyled annotations keep the current always-on gutter icon.
 */
export function resolveAnnotationStyle(
    annotation: { severity?: string; tags?: string[] },
    config: StyleConfig
): ResolvedStyle {
    const severitySpec = lookupSpec(config?.severityStyles, annotation?.severity);
    const tagSpec = firstTagSpec(config?.tagStyles, annotation?.tags);

    return {
        annotationColor: tagSpec?.annotationColor ?? severitySpec?.annotationColor,
        backgroundColor: tagSpec?.backgroundColor ?? severitySpec?.backgroundColor,
        border: tagSpec?.border ?? severitySpec?.border,
        gutterIcon: tagSpec?.gutterIcon ?? severitySpec?.gutterIcon ?? true,
    };
}
