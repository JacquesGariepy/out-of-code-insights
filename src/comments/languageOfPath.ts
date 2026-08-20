// SPDX-License-Identifier: MPL-2.0
//
// languageOfPath — infer a VS Code languageId from a file path's extension.
// Pure (no vscode import) so the workspace-wide comment import can classify
// files read via the filesystem API without opening text documents, and so
// the mapping stays unit-testable. It covers the languages the comment codec
// has a syntax for - a superset of the workspace-import glob, since the
// desktop companion vendors this module too. Anything unmapped falls back to
// DEFAULT_LANGUAGE_ID (the comment scanner then uses its default `//` + `#`
// prefixes).

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascriptreact',
    java: 'java',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    dart: 'dart',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    sh: 'shellscript',
    bash: 'bash',
    zsh: 'zsh',
    ps1: 'powershell',
    pl: 'perl',
    r: 'r',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    lua: 'lua',
    hs: 'haskell',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'svg',
    md: 'markdown',
    markdown: 'markdown',
    vue: 'vue',
    css: 'css',
    scss: 'scss',
    clj: 'clojure',
    cljs: 'clojurescript',
    lisp: 'lisp',
    scm: 'scheme',
    ini: 'ini',
    cfg: 'ini',
    json: 'json',
};

const FILE_NAME_TO_LANGUAGE: Readonly<Record<string, string>> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
};

/** Fallback languageId when the extension is unknown or absent. */
export const DEFAULT_LANGUAGE_ID = 'plaintext';

/**
 * VS Code languageId inferred from the extension - or, for the extension-less
 * names in {@link FILE_NAME_TO_LANGUAGE}, the base name - of `filePath`
 * (Windows or POSIX separators accepted). Case-insensitive; dotfiles, other
 * extension-less names and unknown extensions yield {@link DEFAULT_LANGUAGE_ID}.
 */
export function languageOfPath(filePath: string): string {
    const base = filePath.split(/[\\/]/).pop()?.toLocaleLowerCase('en-US') ?? '';
    const byName = FILE_NAME_TO_LANGUAGE[base];
    if (byName) {
        return byName;
    }
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) {
        return DEFAULT_LANGUAGE_ID;
    }
    return EXTENSION_TO_LANGUAGE[base.slice(dot + 1)] ?? DEFAULT_LANGUAGE_ID;
}
