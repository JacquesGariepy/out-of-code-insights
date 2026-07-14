// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { AnnotationTemplate, TemplateManager } from '../../managers/TemplateManager';

const STORAGE_KEY = 'annotation.templates';

interface ContextHarness {
    context: vscode.ExtensionContext;
    updates: AnnotationTemplate[][];
}

function cloneTemplates(value: unknown): AnnotationTemplate[] {
    return JSON.parse(JSON.stringify(value)) as AnnotationTemplate[];
}

function makeContext(
    initial: unknown = [],
    onUpdate?: (templates: AnnotationTemplate[], callIndex: number) => Promise<void>
): ContextHarness {
    const state = new Map<string, unknown>([[STORAGE_KEY, initial]]);
    const updates: AnnotationTemplate[][] = [];

    const globalState = {
        get<T>(key: string, defaultValue?: T): T | undefined {
            return (state.has(key) ? state.get(key) : defaultValue) as T | undefined;
        },
        async update(key: string, value: unknown): Promise<void> {
            const templates = cloneTemplates(value);
            const callIndex = updates.length;
            updates.push(templates);
            await onUpdate?.(templates, callIndex);
            state.set(key, value);
        },
        keys(): readonly string[] {
            return Array.from(state.keys());
        },
        setKeysForSync(keys: readonly string[]): void {
            void keys;
        },
    };

    return {
        context: { globalState } as unknown as vscode.ExtensionContext,
        updates,
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function nextMicrotask(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

suite('TemplateManager — loading and validation', () => {
    test('keeps built-ins intact and safely normalizes valid persisted templates', () => {
        const initial = [
            { id: 'bug', name: 'Custom Bug', content: '{{ value }}', isBuiltIn: false },
            { id: 'valid-template', name: '  Valid   template ', content: '{{ first }} {{first}}', tags: [' a ', 'a'] },
            { id: 'broken', name: '', content: 'x' },
            { id: 'bad-tags', name: 'Bad tags', content: 'x', tags: 'not-an-array' },
            { id: 'fake-built-in', name: 'Fake built-in', content: 'x', isBuiltIn: 'false' },
            null,
        ];
        const manager = new TemplateManager(makeContext(initial).context);

        const builtIn = manager.getTemplate('bug');
        assert.strictEqual(builtIn?.name, 'Bug');
        assert.strictEqual(builtIn?.isBuiltIn, true);

        const collision = manager.getTemplate('custom-bug');
        assert.strictEqual(collision?.name, 'Custom Bug');
        assert.deepStrictEqual(collision?.variables, ['value']);

        const valid = manager.getTemplate('valid-template');
        assert.strictEqual(valid?.name, 'Valid template');
        assert.deepStrictEqual(valid?.tags, ['a']);
        assert.deepStrictEqual(valid?.variables, ['first']);
        assert.strictEqual(manager.getAllTemplates().length, 7, 'five built-ins plus two valid custom templates');
    });

    test('ignores a corrupt non-array storage value', () => {
        const manager = new TemplateManager(makeContext({ unexpected: true }).context);
        assert.strictEqual(manager.getAllTemplates().length, 5);
    });

    test('returns defensive copies so callers cannot bypass validation or persistence', async () => {
        const harness = makeContext();
        const manager = new TemplateManager(harness.context);
        const custom = await manager.createTemplate({ name: 'Protected', content: '{{value}}', tags: ['safe'] });

        const byId = manager.getTemplate(custom.id);
        assert.ok(byId);
        byId.name = 'Mutated';
        byId.tags?.push('unsafe');
        const fromList = manager.getAllTemplates().find((template) => template.id === custom.id);
        assert.ok(fromList);
        fromList.content = 'changed without updateTemplate';

        assert.strictEqual(manager.getTemplate(custom.id)?.name, 'Protected');
        assert.strictEqual(manager.getTemplate(custom.id)?.content, '{{value}}');
        assert.deepStrictEqual(manager.getTemplate(custom.id)?.tags, ['safe']);
        assert.strictEqual(harness.updates.length, 1, 'no hidden persistence was triggered by caller mutations');
    });

    test('validates required and optional fields at runtime', async () => {
        const manager = new TemplateManager(makeContext().context);

        await assert.rejects(manager.createTemplate({ name: '   ', content: 'x' }), /Template name is required/);
        await assert.rejects(
            manager.createTemplate({ name: 'Name', content: '  \n ' }),
            /Template content is required/
        );
        await assert.rejects(
            manager.createTemplate({ name: 42, content: 'x' } as unknown as Omit<AnnotationTemplate, 'id'>),
            /Template name must be a string/
        );
        await assert.rejects(
            manager.createTemplate({ name: 'Name', content: 'x', tags: 'bad' } as unknown as Omit<
                AnnotationTemplate,
                'id'
            >),
            /Template tags must be an array of strings/
        );
    });

    test('normalizes names and metadata and creates stable collision-safe IDs', async () => {
        const manager = new TemplateManager(makeContext().context);
        const first = await manager.createTemplate({
            name: '  Performance   Étude  ',
            description: '  Useful template  ',
            content: '{{ value }}',
            tags: [' perf ', '', 'perf', ' review '],
            severity: ' warning ',
        });
        const second = await manager.createTemplate({ name: 'Performance Étude', content: 'plain' });
        const fallback = await manager.createTemplate({ name: '🚀', content: 'plain' });

        assert.strictEqual(first.id, 'performance-etude');
        assert.strictEqual(first.name, 'Performance Étude');
        assert.strictEqual(first.description, 'Useful template');
        assert.deepStrictEqual(first.tags, ['perf', 'review']);
        assert.strictEqual(first.severity, 'warning');
        assert.strictEqual(second.id, 'performance-etude-1');
        assert.strictEqual(fallback.id, 'template');
    });
});

suite('TemplateManager — variable parsing and application', () => {
    test('extracts ordinary, spaced and regex-significant names once in source order', async () => {
        const manager = new TemplateManager(makeContext().context);
        const created = await manager.createTemplate({
            name: 'Variables',
            content: '{{name}} / {{ name }} / {{user.name}} / {{price+tax}} / {{ name }}',
        });

        assert.deepStrictEqual(created.variables, ['name', 'user.name', 'price+tax']);
    });

    test('replaces regex-significant variables and replacement tokens literally', async () => {
        const manager = new TemplateManager(makeContext().context);
        const template: AnnotationTemplate = {
            id: 'literal',
            name: 'Literal',
            content: '{{ user.name }}|{{price+tax}}|{{missing}}|{{user.name}}',
        };

        const result = await manager.applyTemplate(template, {
            'user.name': '$& and $` remain literal',
            'price+tax': '$$',
            ignored: 'not present',
        });
        assert.strictEqual(result, '$& and $` remain literal|$$||$& and $` remain literal');
    });

    test('prompts once per distinct variable in source order', async () => {
        const manager = new TemplateManager(makeContext().context);
        const original = vscode.window.showInputBox;
        const prompts: string[] = [];
        try {
            (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = async (
                options
            ) => {
                prompts.push(options?.placeHolder ?? '');
                return `value-${options?.placeHolder}`;
            };
            const result = await manager.applyTemplate({
                id: 'prompt',
                name: 'Prompt',
                content: '{{ first }} then {{second}} and {{first}}',
            });

            assert.deepStrictEqual(prompts, ['first', 'second']);
            assert.strictEqual(result, 'value-first then value-second and value-first');
        } finally {
            (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = original;
        }
    });

    test('reports cancellation and rejects non-string runtime values', async () => {
        const manager = new TemplateManager(makeContext().context);
        const original = vscode.window.showInputBox;
        try {
            (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = async () =>
                undefined;
            await assert.rejects(
                manager.applyTemplate({ id: 'cancel', name: 'Cancel', content: '{{value}}' }),
                /Template application cancelled/
            );
        } finally {
            (vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = original;
        }

        await assert.rejects(
            manager.applyTemplate({ id: 'type', name: 'Type', content: '{{value}}' }, {
                value: 42,
            } as unknown as Record<string, string>),
            /must be a string/
        );
    });
});

suite('TemplateManager — durable mutations', () => {
    test('does not resolve createTemplate before globalState persistence completes', async () => {
        const gate = deferred();
        const harness = makeContext([], () => gate.promise);
        const manager = new TemplateManager(harness.context);
        let settled = false;

        const creation = manager.createTemplate({ name: 'Awaited', content: 'content' }).then((template) => {
            settled = true;
            return template;
        });
        await nextMicrotask();

        assert.strictEqual(harness.updates.length, 1);
        assert.strictEqual(settled, false);
        gate.resolve();
        const created = await creation;
        assert.strictEqual(created.id, 'awaited');
        assert.strictEqual(settled, true);
    });

    test('rolls back a create when persistence rejects', async () => {
        const harness = makeContext([], async () => {
            throw new Error('disk unavailable');
        });
        const manager = new TemplateManager(harness.context);

        await assert.rejects(manager.createTemplate({ name: 'Rollback', content: 'content' }), /disk unavailable/);
        assert.strictEqual(manager.getTemplate('rollback'), undefined);
    });

    test('updates content variables, preserves protected fields and rolls back a failed update', async () => {
        const initial = [{ id: 'custom', name: 'Custom', content: '{{old}}', isBuiltIn: false }];
        let fail = false;
        const harness = makeContext(initial, async () => {
            if (fail) {
                throw new Error('write failed');
            }
        });
        const manager = new TemplateManager(harness.context);

        const updated = await manager.updateTemplate('custom', {
            id: 'hijack',
            isBuiltIn: true,
            variables: ['forged'],
            name: '  Updated  ',
            content: '{{ new.value }}',
        });
        assert.strictEqual(updated?.id, 'custom');
        assert.strictEqual(updated?.isBuiltIn, false);
        assert.strictEqual(updated?.name, 'Updated');
        assert.deepStrictEqual(updated?.variables, ['new.value']);

        fail = true;
        await assert.rejects(manager.updateTemplate('custom', { content: '{{lost}}' }), /write failed/);
        assert.strictEqual(manager.getTemplate('custom')?.content, '{{ new.value }}');
        assert.deepStrictEqual(manager.getTemplate('custom')?.variables, ['new.value']);
    });

    test('protects built-ins and restores a custom template after failed deletion', async () => {
        const initial = [{ id: 'custom', name: 'Custom', content: 'content', isBuiltIn: false }];
        const harness = makeContext(initial, async () => {
            throw new Error('write failed');
        });
        const manager = new TemplateManager(harness.context);

        assert.strictEqual(await manager.deleteTemplate('bug'), false);
        assert.strictEqual(harness.updates.length, 0, 'no persistence for a rejected built-in mutation');
        await assert.rejects(manager.deleteTemplate('custom'), /write failed/);
        assert.strictEqual(manager.getTemplate('custom')?.name, 'Custom');
    });

    test('serializes concurrent mutations so the final snapshot cannot lose updates', async () => {
        const firstWrite = deferred();
        const harness = makeContext([], (_templates, callIndex) =>
            callIndex === 0 ? firstWrite.promise : Promise.resolve()
        );
        const manager = new TemplateManager(harness.context);

        const first = manager.createTemplate({ name: 'First', content: 'one' });
        await nextMicrotask();
        const second = manager.createTemplate({ name: 'Second', content: 'two' });
        await nextMicrotask();
        assert.strictEqual(harness.updates.length, 1, 'second mutation waits behind the first write');

        firstWrite.resolve();
        await Promise.all([first, second]);
        assert.strictEqual(harness.updates.length, 2);
        assert.deepStrictEqual(
            harness.updates[1].map((template) => template.name),
            ['First', 'Second']
        );
    });
});

suite('TemplateManager — import, export and selection', () => {
    test('imports only valid custom templates, sanitizes fields and persists once', async () => {
        const harness = makeContext();
        const manager = new TemplateManager(harness.context);
        const count = await manager.importTemplates(
            JSON.stringify([
                {
                    name: '  Imported  ',
                    description: '  description ',
                    content: '{{ value }}',
                    tags: [' one ', 'one', 'two'],
                    variables: ['forged'],
                    unknown: 'discard me',
                },
                { id: 'ignored', name: 'Imported', content: 'second', isBuiltIn: false },
                { name: 'Built-in payload', content: 'x', isBuiltIn: true },
                { name: '', content: 'x' },
                { name: 'Bad content', content: 12 },
                { name: 'Bad tags', content: 'x', tags: 'not-an-array' },
                null,
            ])
        );

        assert.strictEqual(count, 2);
        assert.strictEqual(harness.updates.length, 1);
        const first = manager.getTemplate('imported');
        const second = manager.getTemplate('imported-1');
        assert.strictEqual(first?.description, 'description');
        assert.deepStrictEqual(first?.tags, ['one', 'two']);
        assert.deepStrictEqual(first?.variables, ['value']);
        assert.strictEqual((first as unknown as Record<string, unknown>).unknown, undefined);
        assert.strictEqual(second?.content, 'second');

        const exported = JSON.parse(await manager.exportTemplates()) as AnnotationTemplate[];
        assert.strictEqual(exported.length, 2);
        assert.ok(exported.every((template) => template.isBuiltIn === false));
    });

    test('rejects malformed JSON roots and rolls back a failed import write', async () => {
        const harness = makeContext([], async () => {
            throw new Error('storage rejected');
        });
        const manager = new TemplateManager(harness.context);

        await assert.rejects(manager.importTemplates('{"name":"not an array"}'), /expected an array of templates/);
        await assert.rejects(
            manager.importTemplates(JSON.stringify([{ name: 'Valid', content: 'content' }])),
            /storage rejected/
        );
        assert.strictEqual(manager.getTemplate('valid'), undefined);
    });

    test('selects duplicate display names by template ID, not by label', async () => {
        const manager = new TemplateManager(makeContext().context);
        const custom = await manager.createTemplate({ name: 'Bug', content: 'custom bug' });
        assert.strictEqual(custom.id, 'bug-1');

        type TemplatePick = vscode.QuickPickItem & { templateId: string };
        const windowWithPick = vscode.window as unknown as {
            showQuickPick: (items: readonly TemplatePick[]) => Thenable<TemplatePick | undefined>;
        };
        const original = windowWithPick.showQuickPick;
        try {
            windowWithPick.showQuickPick = async (items) => items.find((item) => item.templateId === custom.id);
            const selected = await manager.showTemplateQuickPick();
            assert.strictEqual(selected?.id, custom.id);
            assert.strictEqual(selected?.content, 'custom bug');
        } finally {
            windowWithPick.showQuickPick = original;
        }
    });

    test('deletes the selected duplicate name by ID without touching the built-in', async () => {
        const manager = new TemplateManager(makeContext().context);
        const custom = await manager.createTemplate({ name: 'Bug', content: 'custom bug' });
        type TemplatePick = vscode.QuickPickItem & { templateId: string };
        const windowWithMessages = vscode.window as unknown as {
            showQuickPick: (items: readonly TemplatePick[]) => Thenable<TemplatePick | undefined>;
            showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
            showInformationMessage: (message: string) => Thenable<string | undefined>;
        };
        const originalQuickPick = windowWithMessages.showQuickPick;
        const originalWarning = windowWithMessages.showWarningMessage;
        const originalInformation = windowWithMessages.showInformationMessage;

        try {
            windowWithMessages.showQuickPick = async (items) => items.find((item) => item.templateId === custom.id);
            windowWithMessages.showWarningMessage = async (_message, ...items) => items[0];
            windowWithMessages.showInformationMessage = async () => undefined;

            await manager.deleteTemplateFromUI();
            assert.strictEqual(manager.getTemplate(custom.id), undefined);
            assert.strictEqual(manager.getTemplate('bug')?.isBuiltIn, true);
        } finally {
            windowWithMessages.showQuickPick = originalQuickPick;
            windowWithMessages.showWarningMessage = originalWarning;
            windowWithMessages.showInformationMessage = originalInformation;
        }
    });

    test('Manage Templates dispatches to a real edit flow instead of duplicating Create Template', async () => {
        const manager = new TemplateManager(makeContext().context);
        const custom = await manager.createTemplate({ name: 'Before', content: '{{old}}', tags: ['old'] });
        type ManagePick = vscode.QuickPickItem & { value?: string; templateId?: string };
        const windowWithManage = vscode.window as unknown as {
            showQuickPick: (items: readonly ManagePick[]) => Thenable<ManagePick | undefined>;
            showInputBox: () => Thenable<string | undefined>;
            showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
        };
        const originalQuickPick = windowWithManage.showQuickPick;
        const originalInput = windowWithManage.showInputBox;
        const originalInformation = windowWithManage.showInformationMessage;
        const answers = ['After', 'Updated description', 'new, team'];
        let pickCount = 0;
        try {
            windowWithManage.showQuickPick = async (items) => {
                pickCount += 1;
                if (pickCount === 1) {
                    return items.find((item) => item.value === 'edit');
                }
                if (pickCount === 2) {
                    return items.find((item) => item.templateId === custom.id);
                }
                return items.find((item) => item.value === '__none__');
            };
            windowWithManage.showInputBox = async () => answers.shift();
            windowWithManage.showInformationMessage = async (_message, ...items) => {
                // The edit flow also emits a fire-and-forget success notification after
                // closing the temporary editor.  Only the actionable confirmation owns
                // the editor content; leave the terminal notification untouched.
                if (items.length === 0) {
                    return undefined;
                }
                const editor = vscode.window.activeTextEditor;
                assert.ok(editor, 'the multiline template editor must be visible before confirmation');
                const lastLine = editor.document.lineCount - 1;
                const end = editor.document.lineAt(lastLine).range.end;
                await editor.edit((builder) =>
                    builder.replace(new vscode.Range(new vscode.Position(0, 0), end), '{{new}}')
                );
                return items[0];
            };

            await manager.manageTemplatesFromUI();

            const updated = manager.getTemplate(custom.id);
            assert.strictEqual(updated?.name, 'After');
            assert.strictEqual(updated?.description, 'Updated description');
            assert.strictEqual(updated?.content, '{{new}}');
            assert.deepStrictEqual(updated?.tags, ['new', 'team']);
            assert.deepStrictEqual(updated?.variables, ['new']);
        } finally {
            windowWithManage.showQuickPick = originalQuickPick;
            windowWithManage.showInputBox = originalInput;
            windowWithManage.showInformationMessage = originalInformation;
        }
    });
});
