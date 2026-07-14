// SPDX-License-Identifier: MPL-2.0

const PYTHON_ENCODING_COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*[-_.a-zA-Z0-9]+/;

/** Number of leading lines that must remain before generated comments. */
export function sourcePreambleLineCount(lines: readonly string[], languageId: string): number {
    if (lines.length === 0) {
        return 0;
    }
    const first = (lines[0] ?? '').trimStart().toLocaleLowerCase('en-US');
    const normalizedLanguage = languageId.trim().toLocaleLowerCase('en-US');

    if (normalizedLanguage === 'python') {
        if (PYTHON_ENCODING_COOKIE.test(lines[0] ?? '')) {
            return 1;
        }
        if (lines.length > 1 && PYTHON_ENCODING_COOKIE.test(lines[1] ?? '')) {
            return 2;
        }
        return first.startsWith('#!') ? 1 : 0;
    }
    if (
        first.startsWith('#!') ||
        first.startsWith('<?xml') ||
        first.startsWith('<?php') ||
        first.startsWith('<!doctype') ||
        (normalizedLanguage === 'css' && first.startsWith('@charset '))
    ) {
        return 1;
    }
    return 0;
}
