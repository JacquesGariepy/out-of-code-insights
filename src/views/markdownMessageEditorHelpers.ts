// SPDX-License-Identifier: MPL-2.0
//
// Pure helpers for the Markdown message editor (no vscode import so the
// fast unit pass can exercise them without an extension host).

/** Maximum label length used by the annotation QuickPick. */
export const QUICK_PICK_LABEL_MAX_LENGTH = 80;

/**
 * First non-empty line of an annotation message, trimmed and truncated to
 * `maxLength` characters (with an ellipsis when cut). Returns an empty
 * string for blank messages — callers decide on a fallback label.
 */
export function firstMessageLine(message: string, maxLength: number = QUICK_PICK_LABEL_MAX_LENGTH): string {
    for (const rawLine of message.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }
        if (line.length <= maxLength) {
            return line;
        }
        return `${line.slice(0, Math.max(0, maxLength - 1))}…`;
    }
    return '';
}

/**
 * `file:line` location string for QuickPick descriptions. `line` is the
 * 0-based line resolved by `AnnotationStore.getLineForAnnotation`, or null
 * when the document is not open — in that case only the file is shown.
 * Displayed line numbers are 1-based, matching the editor gutter.
 */
export function formatAnnotationLocation(file: string, line: number | null): string {
    if (line === null) {
        return file;
    }
    return `${file}:${String(line + 1)}`;
}

/**
 * Escape a string for safe embedding inside webview HTML (element content
 * and double-quoted attribute values). Escaping `<` also neutralises a
 * literal `</textarea>` inside the annotation message.
 */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
