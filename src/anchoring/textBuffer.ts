// SPDX-License-Identifier: MPL-2.0
//
// TextBuffer — a pure, offset-aware implementation of the TextDocumentLike
// contract from ./anchor over a plain string. Used by tooling that runs
// outside the VS Code extension host (e.g. the standalone MCP server under
// mcp-server/) to call captureAnchor/hashLine and to convert between
// 0-based line numbers and UTF-16 code-unit offsets, mirroring
// vscode.TextDocument offsetAt/positionAt semantics.
//
// Line separators recognised: '\n', '\r\n' and lone '\r'. An empty input is
// a single empty line, and a trailing separator yields a final empty line —
// both matching vscode.TextDocument behaviour.

import type { TextDocumentLike } from './anchor';

export class TextBuffer implements TextDocumentLike {
    private readonly lines: string[];
    /** Start offset (UTF-16 code units) of each line, parallel to `lines`. */
    private readonly lineStarts: number[];
    private readonly length: number;

    constructor(text: string) {
        this.length = text.length;
        this.lines = [];
        this.lineStarts = [];
        let lineStart = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code === 13 /* \r */) {
                this.lines.push(text.slice(lineStart, i));
                this.lineStarts.push(lineStart);
                if (i + 1 < text.length && text.charCodeAt(i + 1) === 10 /* \n */) {
                    i++;
                }
                lineStart = i + 1;
            } else if (code === 10 /* \n */) {
                this.lines.push(text.slice(lineStart, i));
                this.lineStarts.push(lineStart);
                lineStart = i + 1;
            }
        }
        this.lines.push(text.slice(lineStart));
        this.lineStarts.push(lineStart);
    }

    get lineCount(): number {
        return this.lines.length;
    }

    /** Text of the given line, without its EOL sequence. Clamped into range. */
    lineAt(line: number): { readonly text: string } {
        return { text: this.lines[this.clampLine(line)] };
    }

    /** Start offset of the given line (clamped into the valid line range). */
    offsetAt(line: number): number {
        return this.lineStarts[this.clampLine(line)];
    }

    /** Exclusive end offset of the line content (before its EOL sequence). */
    lineEndOffset(line: number): number {
        const clamped = this.clampLine(line);
        return this.lineStarts[clamped] + this.lines[clamped].length;
    }

    /**
     * 0-based line containing `offset`. Offsets are clamped into
     * [0, text.length]; an offset inside an EOL sequence belongs to the line
     * the sequence terminates.
     */
    lineAtOffset(offset: number): number {
        const target = Math.max(0, Math.min(offset, this.length));
        let low = 0;
        let high = this.lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (this.lineStarts[mid] <= target) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low;
    }

    private clampLine(line: number): number {
        return Math.max(0, Math.min(line, this.lines.length - 1));
    }
}
