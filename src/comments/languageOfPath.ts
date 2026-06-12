// SPDX-License-Identifier: MPL-2.0
//
// languageOfPath — infer a VS Code languageId from a file path's extension.
// Pure (no vscode import) so the workspace-wide comment import can classify
// files read via the filesystem API without opening text documents, and so
// the mapping stays unit-testable. Only the extensions targeted by the
// workspace-import glob are mapped; anything else falls back to
// DEFAULT_LANGUAGE_ID (the comment scanner then uses its default `//` + `#`
// prefixes).

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    cs: 'csharp',
    sh: 'shellscript',
    ps1: 'powershell',
    sql: 'sql',
    lua: 'lua',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    html: 'html',
    vue: 'vue',
    md: 'markdown',
};

/** Fallback languageId when the extension is unknown or absent. */
export const DEFAULT_LANGUAGE_ID = 'plaintext';

/**
 * VS Code languageId inferred from the extension of `filePath` (Windows or
 * POSIX separators accepted). Case-insensitive on the extension; dotfiles,
 * extension-less names and unknown extensions yield
 * {@link DEFAULT_LANGUAGE_ID}.
 */
export function languageOfPath(filePath: string): string {
    const base = filePath.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) {
        return DEFAULT_LANGUAGE_ID;
    }
    return EXTENSION_TO_LANGUAGE[base.slice(dot + 1).toLowerCase()] ?? DEFAULT_LANGUAGE_ID;
}
