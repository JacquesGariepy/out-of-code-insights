/**
 * Pure-logic tests for the AI agent-instruction block upsert.
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import {
    AGENT_INSTRUCTIONS_END_MARKER,
    AGENT_INSTRUCTIONS_START_MARKER,
    buildAgentInstructionsBlock,
    upsertAgentInstructionsBlock,
} from '../../../ai/agentInstructions';

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

suite('agentInstructions — buildAgentInstructionsBlock', () => {
    test('block is wrapped in the start/end markers', () => {
        const block = buildAgentInstructionsBlock('docs/annotations');
        assert.ok(block.startsWith(AGENT_INSTRUCTIONS_START_MARKER), 'starts with the start marker');
        assert.ok(block.endsWith(AGENT_INSTRUCTIONS_END_MARKER), 'ends with the end marker');
    });

    test('embeds the configured docs output path and the doc role taxonomy', () => {
        const block = buildAgentInstructionsBlock('wiki/generated');
        assert.ok(block.includes('`wiki/generated`'), 'docs path is embedded');
        assert.ok(block.includes('annotation.docs.outputPath'), 'setting name is referenced');
        for (const role of ['doc:module', 'doc:class', 'doc:function', 'doc:example', 'doc:guide']) {
            assert.ok(block.includes(role), `${role} must be listed`);
        }
        assert.ok(block.includes('MCP tools'), 'instructs agents to use the MCP tools');
    });
});

suite('agentInstructions — upsertAgentInstructionsBlock', () => {
    const block = buildAgentInstructionsBlock('docs/annotations');

    test('inserts into an empty file', () => {
        const result = upsertAgentInstructionsBlock('', block);
        assert.strictEqual(result, block + '\n');
        assert.strictEqual(countOccurrences(result, AGENT_INSTRUCTIONS_START_MARKER), 1);
    });

    test('whitespace-only content counts as empty', () => {
        assert.strictEqual(upsertAgentInstructionsBlock('  \n\n', block), block + '\n');
    });

    test('appends to existing content with a separating blank line', () => {
        const existing = '# My project\n\nSome instructions.\n';
        const result = upsertAgentInstructionsBlock(existing, block);
        assert.ok(result.startsWith(existing), 'existing content is preserved');
        assert.ok(result.includes('\n\n' + AGENT_INSTRUCTIONS_START_MARKER), 'blank line before the block');
        assert.ok(result.endsWith(AGENT_INSTRUCTIONS_END_MARKER + '\n'), 'newline-terminated');
    });

    test('appends a blank line even when the content has no trailing newline', () => {
        const result = upsertAgentInstructionsBlock('# Title', block);
        assert.ok(result.startsWith('# Title\n\n' + AGENT_INSTRUCTIONS_START_MARKER));
    });

    test('replaces an existing block in place, preserving surrounding content', () => {
        const before = '# Header\n\n';
        const after = '\n## Trailer\n';
        const stale = AGENT_INSTRUCTIONS_START_MARKER + '\nold stale instructions\n' + AGENT_INSTRUCTIONS_END_MARKER;
        const result = upsertAgentInstructionsBlock(before + stale + after, block);
        assert.strictEqual(result, before + block + after);
        assert.ok(!result.includes('old stale instructions'), 'stale block content is gone');
        assert.strictEqual(countOccurrences(result, AGENT_INSTRUCTIONS_START_MARKER), 1);
        assert.strictEqual(countOccurrences(result, AGENT_INSTRUCTIONS_END_MARKER), 1);
    });

    test('is idempotent: re-applying the same block is a fixed point', () => {
        const once = upsertAgentInstructionsBlock('# Existing\n', block);
        const twice = upsertAgentInstructionsBlock(once, block);
        const thrice = upsertAgentInstructionsBlock(twice, block);
        assert.strictEqual(twice, once);
        assert.strictEqual(thrice, once);
        assert.strictEqual(countOccurrences(thrice, AGENT_INSTRUCTIONS_START_MARKER), 1);
    });

    test('updates the docs path when the setting changed', () => {
        const seeded = upsertAgentInstructionsBlock('', buildAgentInstructionsBlock('docs/annotations'));
        const updated = upsertAgentInstructionsBlock(seeded, buildAgentInstructionsBlock('site/api-docs'));
        assert.ok(updated.includes('`site/api-docs`'), 'new path present');
        assert.ok(!updated.includes('`docs/annotations`'), 'old path replaced');
        assert.strictEqual(countOccurrences(updated, AGENT_INSTRUCTIONS_START_MARKER), 1);
    });
});
