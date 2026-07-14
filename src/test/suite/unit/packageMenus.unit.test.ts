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
        viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
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
            'outOfCodeInsightsReviewSubMenu',
            'outOfCodeInsightsTemplatesSnippetsSubMenu',
            'outOfCodeInsightsDocumentationSubMenu',
            'outOfCodeInsightsKanbanSubMenu',
            'aiAnalysisSubMenu',
            'outOfCodeInsightsToolsSubMenu',
            'outOfCodeInsightsSettingsSubMenu',
        ]);
        assert.strictEqual(
            items.length,
            14,
            'the first-level context menu contains only primary actions and task groups'
        );
        assert.strictEqual(items.find((item) => item.command === 'annotations.delete')?.group, '9_danger@1');
        assert.ok(items.every((item) => /^(1_primary|2_workflows|9_danger)@\d+$/.test(item.group ?? '')));
    });

    test('task submenu labels and command ownership stay stable without duplication', () => {
        const expectedLabels = new Map([
            ['outOfCodeInsightsViewSearchSubMenu', 'View & Search'],
            ['outOfCodeInsightsEditOrganizeSubMenu', 'Edit & Organize'],
            ['outOfCodeInsightsMoveReanchorSubMenu', 'Move & Re-anchor'],
            ['outOfCodeInsightsLinksCollaborationSubMenu', 'Links & Collaboration'],
            ['outOfCodeInsightsReviewSubMenu', 'Review Workflow'],
            ['outOfCodeInsightsTemplatesSnippetsSubMenu', 'Templates & Snippets'],
            ['outOfCodeInsightsDocumentationSubMenu', 'Documentation'],
            ['outOfCodeInsightsKanbanSubMenu', 'Kanban'],
            ['aiAnalysisSubMenu', 'AI Analysis'],
            ['outOfCodeInsightsToolsSubMenu', 'Import/Export & Tools'],
            ['outOfCodeInsightsSettingsSubMenu', 'Settings & Accounts'],
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
            allHubCommands.filter((command) => command === 'annotations.createDevelopmentIssue').length,
            1
        );
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
        const supported = new Set(['annotations.treeEdit', 'annotations.treeDelete', 'annotations.pickUpForMove']);

        assert.deepStrictEqual(new Set(items.flatMap((item) => (item.command ? [item.command] : []))), supported);
        assert.deepStrictEqual(
            items.flatMap((item) => (item.submenu ? [item.submenu] : [])),
            [
                'outOfCodeInsightsTreeMoveSubMenu',
                'outOfCodeInsightsTreeCollaborationSubMenu',
                'outOfCodeInsightsTreeStateSubMenu',
                'outOfCodeInsightsTreeCodeSubMenu',
                'outOfCodeInsightsTreeDocumentationSubMenu',
            ]
        );
        assert.ok(items.every((item) => item.when?.includes('view == annotationsView')));
        assert.ok(items.every((item) => item.when?.includes('view == annotationsExplorerView')));
        assert.ok(!items.some((item) => item.command === 'annotations.delete'), 'cursor-based delete is unsafe here');
        assert.ok(!items.some((item) => item.command === 'annotations.edit'), 'cursor-based edit is unsafe here');
        assert.strictEqual(items.find((item) => item.command === 'annotations.treeDelete')?.group, '9_danger@1');
    });

    test('TreeView code conversion routes both directions through annotation-aware handlers', () => {
        const items = menus.outOfCodeInsightsTreeCodeSubMenu;
        assert.deepStrictEqual(
            items.map((item) => item.command),
            ['annotations.writeAnnotationsToCodeComments', 'annotations.convertCodeComments']
        );
        assert.ok(items.every((item) => item.group?.match(/^\d+_(?:export|import)@\d+$/)));
    });

    test('TreeView collaboration groups the complete link workflow next to annotations', () => {
        const items = menus.outOfCodeInsightsTreeCollaborationSubMenu;
        assert.deepStrictEqual(
            items.map((item) => item.command),
            [
                'annotations.createLink',
                'annotations.navigateToLinked',
                'annotations.showLinks',
                'annotations.removeLink',
                'annotations.createDevelopmentIssue',
            ]
        );
        assert.strictEqual(items[0].when, undefined, 'creating a link must work from every annotation item');
        assert.ok(
            items.slice(1, 4).every((item) => item.when === 'viewItem == annotation-linked'),
            'link inspection and removal only apply to annotations that already expose links'
        );
        assert.strictEqual(items[4].when, undefined, 'issue creation must accept every annotation item');
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
            visible.map((item) => item.command ?? `submenu:${String(item.submenu)}`),
            [
                'annotations.bulkActions',
                'annotations.keywordSearch',
                'annotations.show',
                'submenu:outOfCodeInsightsTreeMoreSubMenu',
            ]
        );
        const more = menus.outOfCodeInsightsTreeMoreSubMenu;
        assert.ok(more.some((item) => item.command === 'annotations.syncNow' && item.group === '7_collaboration@1'));
        assert.ok(
            more.some(
                (item) => item.command === 'annotations.createDevelopmentIssue' && item.group === '7_collaboration@3'
            )
        );
        assert.ok(
            more.some((item) => item.command === 'annotations.configureDocs' && item.group === '6_documentation@1')
        );
        assert.ok(
            more.some((item) => item.command === 'annotations.generateDocs' && item.group === '6_documentation@2')
        );
        assert.ok(items.every((item) => item.when?.includes('view == annotationsExplorerView')));
    });

    test('Explorer resources expose a guided workspace hub and stateful shortcuts preserve native navigation', () => {
        const explorer = menus['explorer/context'];
        assert.deepStrictEqual(
            explorer.map((item) => item.submenu),
            ['outOfCodeInsightsExplorerSubMenu']
        );
        assert.ok(menus.outOfCodeInsightsExplorerSubMenu.some((item) => item.command === 'annotations.configureDocs'));
        assert.ok(
            menus.outOfCodeInsightsExplorerSubMenu
                .filter((item) =>
                    ['annotations.convertCodeComments', 'annotations.writeAnnotationsToCodeComments'].includes(
                        item.command ?? ''
                    )
                )
                .every((item) => item.when === '!explorerResourceIsFolder'),
            'file conversion actions must not be offered on folders'
        );

        const manifestWithKeys = loadManifest() as ExtensionManifest & {
            contributes: { keybindings: Array<{ command: string; when?: string }> };
        };
        const keybindings = manifestWithKeys.contributes.keybindings;
        assert.ok(
            keybindings
                .find((item) => item.command === 'annotations.nextAnnotation')
                ?.when?.includes('outOfCodeInsights.reviewModeActive')
        );
        assert.ok(
            keybindings
                .find((item) => item.command === 'stack.back')
                ?.when?.includes('outOfCodeInsights.navigationCanBack')
        );
    });

    test('empty annotation trees teach the first workflows without prior product knowledge', () => {
        const welcomeByView = new Map(
            (manifest.contributes.viewsWelcome ?? []).map(({ view, contents }) => [view, contents])
        );
        assert.deepStrictEqual(new Set(welcomeByView.keys()), new Set(['annotationsView', 'annotationsExplorerView']));

        const expectedCommands = [
            'annotations.add',
            'annotations.importCommentsWorkspace',
            'annotations.show',
            'annotations.configureDocs',
            'annotations.openSettings',
        ];
        for (const [view, contents] of welcomeByView) {
            const linkedCommands = [...contents.matchAll(/\(command:([^)]+)\)/g)].map((match) => match[1]);
            assert.deepStrictEqual(
                linkedCommands,
                expectedCommands,
                `${view} needs the complete guided start sequence`
            );
            assert.match(contents, /right-click/i, `${view} must explain how to discover its context menus`);
        }
    });
});
