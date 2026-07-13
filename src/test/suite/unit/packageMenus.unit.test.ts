// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface MenuItem {
    command?: string;
    submenu?: string;
    group?: string;
    when?: string;
    order?: number;
}

interface ExtensionManifest {
    contributes: {
        commands: Array<{ command: string }>;
        submenus: Array<{ id: string; label: string }>;
        menus: Record<string, MenuItem[]>;
    };
}

function loadManifest(): ExtensionManifest {
    const manifestPath = path.resolve(__dirname, '../../../..', 'package.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
}

suite('package.json native annotation menus', () => {
    const manifest = loadManifest();
    const menus = manifest.contributes.menus;

    test('every menu target is contributed and appears only once per surface', () => {
        const commandIds = new Set(manifest.contributes.commands.map(({ command }) => command));
        const submenuIds = new Set(manifest.contributes.submenus.map(({ id }) => id));

        for (const [surface, items] of Object.entries(menus)) {
            const targets = items.map((item) => item.command ?? `submenu:${String(item.submenu)}`);
            assert.strictEqual(
                new Set(targets).size,
                targets.length,
                `${surface} must not contain duplicate command or submenu entries`
            );
            for (const item of items) {
                if (item.command) {
                    assert.ok(
                        commandIds.has(item.command),
                        `${surface} references uncontributed command ${item.command}`
                    );
                }
                if (item.submenu) {
                    assert.ok(submenuIds.has(item.submenu), `${surface} references unknown submenu ${item.submenu}`);
                }
            }
        }
    });

    test('editor context is a compact task hub with three direct actions', () => {
        const items = menus.outOfCodeInsightsSubMenu;
        const directCommands = items.filter((item) => item.command).map((item) => item.command);
        const nestedMenus = items.filter((item) => item.submenu).map((item) => item.submenu);

        assert.deepStrictEqual(directCommands, ['annotations.add', 'annotations.show', 'annotations.delete']);
        assert.deepStrictEqual(nestedMenus, [
            'outOfCodeInsightsViewSearchSubMenu',
            'outOfCodeInsightsEditOrganizeSubMenu',
            'outOfCodeInsightsMoveReanchorSubMenu',
            'outOfCodeInsightsLinksCollaborationSubMenu',
            'outOfCodeInsightsTemplatesSnippetsSubMenu',
            'aiAnalysisSubMenu',
            'outOfCodeInsightsToolsSubMenu',
        ]);
        assert.strictEqual(items.length, 10, 'the first-level context menu must remain compact');
        assert.strictEqual(items.find((item) => item.command === 'annotations.delete')?.group, '9_danger@1');
        assert.ok(items.every((item) => /^(1_primary|2_workflows|9_danger)@\d+$/.test(item.group ?? '')));
    });

    test('task submenu labels and command ownership stay stable without duplication', () => {
        const expectedLabels = new Map([
            ['outOfCodeInsightsViewSearchSubMenu', 'View & Search'],
            ['outOfCodeInsightsEditOrganizeSubMenu', 'Edit & Organize'],
            ['outOfCodeInsightsMoveReanchorSubMenu', 'Move & Re-anchor'],
            ['outOfCodeInsightsLinksCollaborationSubMenu', 'Links & Collaboration'],
            ['outOfCodeInsightsTemplatesSnippetsSubMenu', 'Templates & Snippets'],
            ['aiAnalysisSubMenu', 'AI Analysis'],
            ['outOfCodeInsightsToolsSubMenu', 'Import/Export & Tools'],
        ]);
        const definitions = new Map(manifest.contributes.submenus.map(({ id, label }) => [id, label]));
        const rootItems = menus.outOfCodeInsightsSubMenu;
        const rootCommands = rootItems.flatMap((item) => (item.command ? [item.command] : []));
        const workflowIds = rootItems.flatMap((item) => (item.submenu ? [item.submenu] : []));
        const workflowCommands = workflowIds.flatMap((id) => {
            assert.ok(menus[id], `submenu ${id} must have a menu contribution`);
            assert.strictEqual(definitions.get(id), expectedLabels.get(id), `${id} has an unexpected label`);
            return menus[id].flatMap((item) => (item.command ? [item.command] : []));
        });
        const allHubCommands = [...rootCommands, ...workflowCommands];

        assert.strictEqual(
            new Set(allHubCommands).size,
            allHubCommands.length,
            'one editor workflow command must have exactly one home in the hub'
        );
        assert.strictEqual(allHubCommands.filter((command) => command === 'annotations.createLink').length, 1);
        assert.strictEqual(
            menus.outOfCodeInsightsToolsSubMenu.find((item) => item.command === 'annotations.clearAll')?.group,
            '9_danger@1'
        );
        for (const id of workflowIds) {
            for (const item of menus[id]) {
                assert.match(item.group ?? '', /^\d+_[a-z]+@\d+$/);
                assert.strictEqual(
                    item.order,
                    undefined,
                    'menu ordering belongs in group@order, not an ignored order property'
                );
            }
        }
    });

    test('TreeView exposes only handlers that understand native TreeItem arguments', () => {
        const items = menus['view/item/context'];
        const supported = new Set([
            'annotations.treeEdit',
            'annotations.treeDelete',
            'annotations.treeTogglePin',
            'annotations.treeSetSeverity',
            'annotations.pickUpForMove',
            'annotations.reanchorToCursor',
            'annotations.moveByDragAndDrop',
            'annotations.showLinks',
            'annotations.bulkActions',
        ]);

        assert.deepStrictEqual(new Set(items.map((item) => item.command)), supported);
        assert.ok(items.every((item) => item.when?.includes('view == annotationsView')));
        assert.ok(!items.some((item) => item.command === 'annotations.delete'), 'cursor-based delete is unsafe here');
        assert.ok(!items.some((item) => item.command === 'annotations.edit'), 'cursor-based edit is unsafe here');
        assert.strictEqual(items.find((item) => item.command === 'annotations.treeDelete')?.group, '9_danger@1');
    });

    test('comment deletion is a thread-level danger action, never a per-reply shortcut', () => {
        const threadContext = menus['comments/commentThread/context'];
        assert.strictEqual(
            threadContext.find((item) => item.command === 'annotations.commentDelete')?.group,
            '9_danger@1'
        );
        assert.ok(!('comments/comment/context' in menus));
        assert.ok(!menus['comments/commentThread/title'].some((item) => item.command === 'annotations.commentDelete'));
    });

    test('TreeView title keeps primary navigation visible and secondary workflows in overflow groups', () => {
        const items = menus['view/title'];
        const visible = items.filter((item) => item.group?.startsWith('navigation@'));
        assert.deepStrictEqual(
            visible.map((item) => item.command),
            [
                'annotations.bulkActions',
                'annotations.keywordSearch',
                'annotations.show',
                'annotations.showKanban',
                'annotations.toggleDisplay',
            ]
        );
        assert.ok(items.some((item) => item.command === 'annotations.syncNow' && item.group === '6_collaboration@1'));
        assert.ok(items.some((item) => item.command === 'annotations.generateDocs' && item.group === '5_tools@2'));
    });
});
