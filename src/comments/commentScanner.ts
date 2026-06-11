// SPDX-License-Identifier: MPL-2.0
//
// Pure scanner that finds better-comments-style markers inside real source
// comments so they can be imported as annotations: `// ! danger`,
// `# ? question`, `// TODO: refactor`, `<!-- FIXME broken -->`, `// * note`.
// Line-based and intentionally naive about strings ("// not a comment"
// inside a string literal will match) — acceptable for an interactive
// import that the user reviews, and documented on the command.

export interface CommentMatch {
    /** 0-based line index. */
    line: number;
    /** Taxonomy tag derived from the marker (todo, fixme, alert, question, highlight, hack). */
    tag: string;
    /** Severity mapped from the marker. */
    severity: 'info' | 'warning' | 'error';
    /** Comment text with the marker stripped. */
    text: string;
}

interface MarkerSpec {
    pattern: RegExp;
    tag: string;
    severity: CommentMatch['severity'];
}

// Better-comments defaults (! ? * //-strikethrough is skipped) plus the
// classic TODO/FIXME/HACK triage markers.
const MARKERS: MarkerSpec[] = [
    { pattern: /^!\s*/, tag: 'alert', severity: 'error' },
    { pattern: /^\?\s*/, tag: 'question', severity: 'info' },
    { pattern: /^\*\s*/, tag: 'highlight', severity: 'info' },
    { pattern: /^todo\b:?\s*/i, tag: 'todo', severity: 'info' },
    { pattern: /^(?:fixme|bug)\b:?\s*/i, tag: 'fixme', severity: 'warning' },
    { pattern: /^(?:hack|xxx)\b:?\s*/i, tag: 'hack', severity: 'warning' },
];

const LINE_COMMENT_PREFIXES: Record<string, string[]> = {
    python: ['#'],
    ruby: ['#'],
    shellscript: ['#'],
    yaml: ['#'],
    toml: ['#'],
    dockerfile: ['#'],
    makefile: ['#'],
    perl: ['#'],
    r: ['#'],
    powershell: ['#'],
    sql: ['--'],
    lua: ['--'],
    haskell: ['--'],
    html: ['<!--'],
    xml: ['<!--'],
    svg: ['<!--'],
    markdown: ['<!--'],
    vue: ['<!--', '//'],
};

const DEFAULT_PREFIXES = ['//', '#'];

function commentPrefixesFor(languageId: string): string[] {
    return LINE_COMMENT_PREFIXES[languageId] ?? DEFAULT_PREFIXES;
}

/** Cut the text at the HTML comment terminator when present. */
function stripCommentTail(text: string): string {
    const end = text.indexOf('-->');
    return (end === -1 ? text : text.slice(0, end)).trimEnd();
}

/**
 * Scan document lines for comment markers. Returns at most one match per
 * line (the first marker after the earliest comment prefix wins).
 */
export function scanLineComments(lines: readonly string[], languageId: string): CommentMatch[] {
    const prefixes = commentPrefixesFor(languageId);
    const matches: CommentMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let commentStart = -1;
        let prefixLength = 0;
        for (const prefix of prefixes) {
            const idx = line.indexOf(prefix);
            if (idx !== -1 && (commentStart === -1 || idx < commentStart)) {
                commentStart = idx;
                prefixLength = prefix.length;
            }
        }
        if (commentStart === -1) {
            continue;
        }
        const rest = line.slice(commentStart + prefixLength).trimStart();
        for (const marker of MARKERS) {
            if (!marker.pattern.test(rest)) {
                continue;
            }
            const text = stripCommentTail(rest.replace(marker.pattern, '').trim());
            if (text.length > 0) {
                matches.push({ line: i, tag: marker.tag, severity: marker.severity, text });
            }
            break;
        }
    }
    return matches;
}
