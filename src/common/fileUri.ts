// SPDX-License-Identifier: MPL-2.0
//
// toFileUriString — render an absolute filesystem path as a `file:` URI
// string matching what `vscode.Uri.file(p).toString()` produces, so records
// written outside the extension host (MCP server, scripts) remain matchable
// against `document.uri.toString()` once the workspace is reloaded.
//
// Parity notes (mirroring the vscode Uri implementation):
//   - backslashes are converted to forward slashes;
//   - a Windows drive letter is lowercased and its colon percent-encoded
//     (`C:\x` → `file:///c%3A/x`);
//   - each path segment is percent-encoded (spaces → `%20`, non-ASCII →
//     UTF-8 escapes);
//   - UNC paths map the host to the URI authority, lowercased
//     (`\\server\share\f` → `file://server/share/f`).

function encodePathSegments(p: string): string {
    return p
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

/** Absolute filesystem path (Windows or POSIX) → `file:` URI string. */
export function toFileUriString(absolutePath: string): string {
    let p = absolutePath.replace(/\\/g, '/');
    if (p.startsWith('//')) {
        // UNC: //server/share/path → `server` becomes the URI authority.
        const rest = p.slice(2);
        const slash = rest.indexOf('/');
        const authority = slash === -1 ? rest : rest.slice(0, slash);
        const remainder = slash === -1 ? '/' : rest.slice(slash);
        return `file://${authority.toLowerCase()}${encodePathSegments(remainder)}`;
    }
    if (!p.startsWith('/')) {
        p = '/' + p;
    }
    // Lowercase a Windows drive letter, mirroring vscode.Uri.file().
    p = p.replace(/^\/([A-Z])(?=:)/, (_match, drive: string) => '/' + drive.toLowerCase());
    return `file://${encodePathSegments(p)}`;
}
