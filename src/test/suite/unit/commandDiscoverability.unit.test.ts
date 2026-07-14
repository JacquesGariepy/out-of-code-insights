import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface CommandContribution {
    command: string;
    title: string;
    category?: string;
    enablement?: string;
}

interface MenuContribution {
    command?: string;
    submenu?: string;
    group?: string;
    when?: string;
}

interface ExtensionManifest {
    contributes: {
        commands: CommandContribution[];
        submenus: Array<{ id: string; label: string }>;
        menus: Record<string, MenuContribution[]>;
    };
}

function loadManifest(): ExtensionManifest {
    const manifestPath = path.resolve(__dirname, '../../../../package.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
}

function collectSubmenuCommands(manifest: ExtensionManifest, menuId: string, visited = new Set<string>()): Set<string> {
    if (visited.has(menuId)) {
        return new Set();
    }
    visited.add(menuId);

    const commands = new Set<string>();
    for (const entry of manifest.contributes.menus[menuId] ?? []) {
        if (entry.command) {
            commands.add(entry.command);
        }
        if (entry.submenu) {
            for (const command of collectSubmenuCommands(manifest, entry.submenu, visited)) {
                commands.add(command);
            }
        }
    }
    return commands;
}

function collectRuntimeCommandIds(directory: string): Set<string> {
    const commandIds = new Set<string>();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'test') {
                for (const command of collectRuntimeCommandIds(absolutePath)) {
                    commandIds.add(command);
                }
            }
            continue;
        }
        if (!entry.name.endsWith('.ts')) {
            continue;
        }
        const source = fs.readFileSync(absolutePath, 'utf8');
        for (const match of source.matchAll(/register(?:TextEditor)?Command\(\s*['"]([^'"]+)['"]/g)) {
            commandIds.add(match[1]);
        }
    }
    return commandIds;
}

suite('Command discoverability', () => {
    test('places every declared user command in at least one native menu', () => {
        const manifest = loadManifest();
        const menuCommands = new Set(
            Object.values(manifest.contributes.menus)
                .flat()
                .filter((entry) => entry.when?.trim() !== 'false')
                .flatMap((entry) => (entry.command ? [entry.command] : []))
        );
        const commandIds = manifest.contributes.commands.map((command) => command.command);

        assert.strictEqual(new Set(commandIds).size, commandIds.length, 'command ids must be unique');
        for (const command of manifest.contributes.commands) {
            assert.ok(command.title.trim(), `${command.command} needs a visible title`);
            assert.strictEqual(
                command.category,
                'Out-of-Code Insights',
                `${command.command} needs the shared category`
            );
            assert.ok(menuCommands.has(command.command), `${command.command} is missing from native menus`);
        }
    });

    test('keeps submenu references valid and exposes documentation in author-configure-generate order', () => {
        const manifest = loadManifest();
        const submenuIds = new Set(manifest.contributes.submenus.map((submenu) => submenu.id));
        const referencedSubmenus = new Set<string>();
        for (const entries of Object.values(manifest.contributes.menus)) {
            for (const entry of entries) {
                if (entry.submenu) {
                    assert.ok(submenuIds.has(entry.submenu), `unknown submenu ${entry.submenu}`);
                    referencedSubmenus.add(entry.submenu);
                }
            }
        }
        assert.deepStrictEqual(referencedSubmenus, submenuIds, 'every submenu must be reachable from a native surface');

        const documentation = manifest.contributes.menus.outOfCodeInsightsDocumentationSubMenu;
        assert.deepStrictEqual(
            documentation.map((entry) => entry.command),
            ['annotations.addDocBlock', 'annotations.configureDocs', 'annotations.generateDocs']
        );
        assert.deepStrictEqual(
            documentation.map((entry) => entry.group),
            ['1_author@1', '2_generate@1', '2_generate@2']
        );
    });

    test('keeps stateful shortcuts and context-only commands from becoming silent palette actions', () => {
        const manifest = loadManifest();
        const commandById = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
        for (const command of [
            'annotations.stopReview',
            'annotations.nextAnnotation',
            'annotations.previousAnnotation',
            'annotations.markAsViewed',
            'annotations.reviewMode.filter',
        ]) {
            assert.strictEqual(commandById.get(command)?.enablement, 'outOfCodeInsights.reviewModeActive');
        }

        const hiddenPaletteCommands = new Set(
            manifest.contributes.menus.commandPalette
                .filter((entry) => entry.when === 'false')
                .flatMap((entry) => (entry.command ? [entry.command] : []))
        );
        for (const command of [
            'annotations.commentReply',
            'annotations.commentResolve',
            'annotations.commentUnresolve',
            'annotations.commentDelete',
            'annotations.commentPickUp',
            'annotations.treeEdit',
            'annotations.treeDelete',
            'annotations.treeTogglePin',
            'annotations.treeSetSeverity',
        ]) {
            assert.ok(hiddenPaletteCommands.has(command), `${command} must stay on its native context surface`);
        }

        assert.strictEqual(
            commandById.get('annotations.dropPickedAtCursor')?.enablement,
            'outOfCodeInsights.annotationMoveActive'
        );
        assert.strictEqual(
            commandById.get('annotations.cancelPickedMove')?.enablement,
            'outOfCodeInsights.annotationMoveActive'
        );
    });

    test('routes every general command through the novice-facing editor task hub', () => {
        const manifest = loadManifest();
        const hubCommands = collectSubmenuCommands(manifest, 'outOfCodeInsightsSubMenu');
        const surfaceSpecificCommands = new Set([
            // Guided multi-selection and drag/drop actions live with the Tree View.
            'annotations.bulkActions',
            'annotations.moveByDragAndDrop',
            // These handlers require a concrete TreeItem argument.
            'annotations.treeEdit',
            'annotations.treeDelete',
            'annotations.treeTogglePin',
            'annotations.treeSetSeverity',
            // These handlers require a concrete VS Code comment thread/reply argument.
            'annotations.commentReply',
            'annotations.commentResolve',
            'annotations.commentUnresolve',
            'annotations.commentDelete',
            'annotations.commentPickUp',
        ]);

        const commandsOutsideHub = manifest.contributes.commands
            .map(({ command }) => command)
            .filter((command) => !hubCommands.has(command));

        assert.deepStrictEqual(
            new Set(commandsOutsideHub),
            surfaceSpecificCommands,
            'general commands need a path from the editor context task hub; add only genuinely contextual handlers to the explicit exception set'
        );

        const contextualCommands = new Set([
            ...collectSubmenuCommands(manifest, 'view/item/context'),
            ...collectSubmenuCommands(manifest, 'comments/commentThread/context'),
            ...collectSubmenuCommands(manifest, 'comments/commentThread/title'),
        ]);
        for (const command of surfaceSpecificCommands) {
            const isGuidedTreeWorkflow =
                command === 'annotations.bulkActions' || command === 'annotations.moveByDragAndDrop';
            assert.ok(
                isGuidedTreeWorkflow || contextualCommands.has(command),
                `${command} needs a visible native context-menu home`
            );
        }
    });

    test('keeps runtime-only commands limited to verified native UI bridges', () => {
        const manifest = loadManifest();
        const declaredCommands = new Set(manifest.contributes.commands.map(({ command }) => command));
        const sourceRoot = path.resolve(__dirname, '../../../../src');
        const runtimeOnlyCommands = [...collectRuntimeCommandIds(sourceRoot)]
            .filter((command) => !declaredCommands.has(command))
            .sort();

        assert.deepStrictEqual(runtimeOnlyCommands, [
            'annotations.kanban.addColumn',
            'annotations.kanban.delete',
            'annotations.kanban.deleteColumn',
            'annotations.kanban.getColumns',
            'annotations.kanban.moveToColumn',
            'annotations.kanban.refresh',
            'annotations.kanban.removeFromKanban',
            'annotations.kanban.updateColumns',
            'annotations.manage',
            'annotations.navigateToPanel',
        ]);
    });
});
