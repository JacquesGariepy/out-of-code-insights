// SPDX-License-Identifier: MPL-2.0
//
// Pure helpers for the "Set Up AI Agent Instructions" command: build the
// marked instruction block and upsert it into an agent-instruction file
// (CLAUDE.md / AGENTS.md). No vscode runtime dependency — the command layer
// reads/writes the files and resolves the configured docs output path.

/** Opening marker of the managed block. NEVER change — existing files are keyed on it. */
export const AGENT_INSTRUCTIONS_START_MARKER = '<!-- out-of-code-insights:start -->';

/** Closing marker of the managed block. NEVER change — existing files are keyed on it. */
export const AGENT_INSTRUCTIONS_END_MARKER = '<!-- out-of-code-insights:end -->';

/** Agent-instruction files maintained at the workspace root. */
export const AGENT_INSTRUCTION_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];

/**
 * Build the managed instruction block (English), markers included. The block
 * tells AI agents to annotate through the out-of-code-insights MCP tools
 * instead of writing comments into source files, how to tag documentation
 * annotations, and where the generated documentation lives.
 *
 * @param docsOutputPath workspace-relative value of `annotation.docs.outputPath`.
 */
export function buildAgentInstructionsBlock(docsOutputPath: string): string {
    return [
        AGENT_INSTRUCTIONS_START_MARKER,
        '## Out-of-Code Insights — annotation workflow for AI agents',
        '',
        '- Use the out-of-code-insights MCP tools to annotate code instead of writing comments into source',
        '  files. Annotations are stored outside the codebase (`.out-of-code-insights/annotations.json`) and',
        '  never modify the source itself.',
        '- Tag documentation annotations with a documentation role: `doc:module`, `doc:class`, `doc:function`,',
        '  `doc:example` or `doc:guide`. Tagged annotations are assembled into authored API and guide pages.',
        '- For repository documentation, use `doc:readme`, `doc:changelog`, `doc:architecture`, `doc:adr`,',
        '  `doc:onboarding`, `doc:runbook` or `doc:reference`. Changelog entries also need exactly one',
        '  `version:`/`release:` tag and one explicit change category; dates are optional and never inferred.',
        '  Never invent project claims or API routes.',
        `- Generated documentation lives at \`${docsOutputPath}\` (setting \`annotation.docs.outputPath\`).`,
        '  Regenerate it with the "Generate Annotation Documentation" command.',
        AGENT_INSTRUCTIONS_END_MARKER,
    ].join('\n');
}

/**
 * Insert `block` into `content`, or replace the existing marked block in
 * place. Idempotent: applying the same block twice yields the same output.
 *
 *  - Empty (or whitespace-only) content → the block alone, newline-terminated.
 *  - Content without markers → block appended after a separating blank line.
 *  - Content with markers → everything between (and including) the markers is
 *    replaced; surrounding content is preserved byte-for-byte.
 */
export function upsertAgentInstructionsBlock(content: string, block: string): string {
    const startIndex = content.indexOf(AGENT_INSTRUCTIONS_START_MARKER);
    const endIndex = content.indexOf(AGENT_INSTRUCTIONS_END_MARKER);
    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        const before = content.slice(0, startIndex);
        const after = content.slice(endIndex + AGENT_INSTRUCTIONS_END_MARKER.length);
        return before + block + after;
    }
    if (content.trim().length === 0) {
        return block + '\n';
    }
    const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return content + separator + block + '\n';
}
