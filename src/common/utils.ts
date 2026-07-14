import * as crypto from 'crypto';

/**
 * Escapes HTML special characters to prevent XSS injection in webview templates.
 * Apply to every annotation field before interpolating into HTML strings.
 */
export function escapeHtml(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Generates a cryptographically random nonce for Content-Security-Policy
 * script-src and style-src nonce directives.
 */
export function generateNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Render untrusted text as a CommonMark code span without relying on partial
 * character escaping. The delimiter is always longer than every backtick run
 * in the value, and the surrounding spaces keep delimiter-like content
 * unambiguous. CommonMark removes that one padding space when rendering.
 */
export function markdownCodeSpan(value: unknown): string {
    const normalized = String(value ?? '').replace(/[\r\n]+/g, ' ');
    let delimiterLength = 1;
    for (const run of normalized.match(/`+/g) ?? []) {
        delimiterLength = Math.max(delimiterLength, run.length + 1);
    }
    const delimiter = '`'.repeat(delimiterLength);
    return `${delimiter} ${normalized} ${delimiter}`;
}
