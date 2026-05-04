import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'JacquesGariepy.out-of-code-insights';

suite('Extension activation', () => {
    test('extension is present', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension "${EXTENSION_ID}" should be installed in the test host`);
    });

    test('extension activates without throwing', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        await ext.activate();
        assert.strictEqual(ext.isActive, true);
    });

    test('core commands are registered after activation', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        await ext.activate();

        const commands = await vscode.commands.getCommands(true);
        const expected = [
            'annotations.add',
            'annotations.delete',
            'annotations.edit',
            'annotations.show',
            'annotations.exportJSON',
            'annotations.importJSON',
            'annotations.toggleDisplay',
        ];
        for (const cmd of expected) {
            assert.ok(commands.includes(cmd), `Command "${cmd}" should be registered`);
        }
    });

    test('all package.json commands are registered after activation', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext);
        await ext.activate();

        const commands = await vscode.commands.getCommands(true);

        // All command IDs declared in package.json contributes.commands
        const allExpected = [
            'annotations.add',
            'annotations.addKanbanColumn',
            'annotations.addSnippet',
            'annotations.aiAnalyzeFile',
            'annotations.aiAnalyzeFileWithProfile',
            'annotations.aiBatchAnnotate',
            'annotations.aiSuggest',
            'annotations.aiSuggestWithProfile',
            'annotations.applySnippet',
            'annotations.applyTemplate',
            'annotations.batchCreateMixed',
            'annotations.batchEdit',
            'annotations.clearAll',
            'annotations.createLink',
            'annotations.createTemplate',
            'annotations.delete',
            'annotations.edit',
            'annotations.exportJSON',
            'annotations.importJSON',
            'annotations.keywordSearch',
            'annotations.manageAIProfiles',
            'annotations.manageProfiles',
            'annotations.manageTemplates',
            'annotations.markAsViewed',
            'annotations.moveDown',
            'annotations.moveToColumn',
            'annotations.moveUp',
            'annotations.navigate',
            'annotations.navigateToLinked',
            'annotations.nextAnnotation',
            'annotations.pinToggle',
            'annotations.previewSnippet',
            'annotations.previousAnnotation',
            'annotations.removeLink',
            'annotations.reply',
            'annotations.reviewMode.filter',
            'annotations.selectProfile',
            'annotations.setSeverity',
            'annotations.show',
            'annotations.showKanban',
            'annotations.showLinks',
            'annotations.startReview',
            'annotations.stopReview',
            'annotations.toggleDisplay',
            'annotations.updateApiKey',
            'stack.back',
            'stack.forward',
        ];

        const missing = allExpected.filter(cmd => !commands.includes(cmd));
        assert.strictEqual(
            missing.length,
            0,
            `The following commands are not registered: ${missing.join(', ')}`
        );
    });
});
