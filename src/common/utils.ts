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
