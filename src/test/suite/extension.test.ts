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

        const contributions = ext.packageJSON.contributes?.commands as Array<{ command?: unknown }> | undefined;
        assert.ok(Array.isArray(contributions), 'package.json must contribute commands');
        const allExpected = contributions
            .map(({ command }) => command)
            .filter((command): command is string => typeof command === 'string');

        const missing = allExpected.filter((cmd) => !commands.includes(cmd));
        assert.strictEqual(missing.length, 0, `The following commands are not registered: ${missing.join(', ')}`);
    });
});
