/**
 * Pure-logic tests for the configurable annotation styling resolver.
 * No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import { resolveAnnotationStyle, type StyleConfig, type StyleSpec } from '../../../decorations/annotationStyle';

function config(overrides: Partial<StyleConfig> = {}): StyleConfig {
    return {
        severityStyles: {},
        tagStyles: {},
        ...overrides,
    };
}

suite('annotationStyle — defaults and fallbacks', () => {
    test('no styles configured leaves color fields undefined and gutterIcon true', () => {
        const style = resolveAnnotationStyle({ severity: 'info', tags: ['todo'] }, config());
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.backgroundColor, undefined);
        assert.strictEqual(style.border, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });

    test('annotation without severity or tags resolves to all defaults', () => {
        const style = resolveAnnotationStyle(
            {},
            config({
                severityStyles: { warning: { annotationColor: '#ff8800' } },
                tagStyles: { todo: { annotationColor: '#00ff00' } },
            })
        );
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });

    test('default empty severity entries (info/warning/error: {}) behave as unstyled', () => {
        const style = resolveAnnotationStyle(
            { severity: 'warning' },
            config({ severityStyles: { info: {}, warning: {}, error: {} } })
        );
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.backgroundColor, undefined);
        assert.strictEqual(style.border, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });
});

suite('annotationStyle — severity styles', () => {
    test('severity style applies all fields', () => {
        const spec: StyleSpec = {
            annotationColor: '#ff0000',
            backgroundColor: '#330000',
            border: '#aa0000',
            gutterIcon: false,
        };
        const style = resolveAnnotationStyle({ severity: 'error' }, config({ severityStyles: { error: spec } }));
        assert.strictEqual(style.annotationColor, '#ff0000');
        assert.strictEqual(style.backgroundColor, '#330000');
        assert.strictEqual(style.border, '#aa0000');
        assert.strictEqual(style.gutterIcon, false);
    });

    test('unknown severity falls back to defaults', () => {
        const style = resolveAnnotationStyle(
            { severity: 'critical' },
            config({ severityStyles: { error: { annotationColor: '#ff0000' } } })
        );
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });

    test('severity matching is case-insensitive', () => {
        const style = resolveAnnotationStyle(
            { severity: 'Warning' },
            config({ severityStyles: { warning: { border: '#ffcc00' } } })
        );
        assert.strictEqual(style.border, '#ffcc00');
    });

    test('partial severity style only overrides the defined fields', () => {
        const style = resolveAnnotationStyle(
            { severity: 'warning' },
            config({ severityStyles: { warning: { backgroundColor: '#332200' } } })
        );
        assert.strictEqual(style.backgroundColor, '#332200');
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.border, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });
});

suite('annotationStyle — tag styles and precedence', () => {
    test('tag style overrides severity style per field', () => {
        const style = resolveAnnotationStyle(
            { severity: 'error', tags: ['todo'] },
            config({
                severityStyles: { error: { annotationColor: '#ff0000', border: '#aa0000' } },
                tagStyles: { todo: { annotationColor: '#00ff00' } },
            })
        );
        // Tag wins where it defines a field …
        assert.strictEqual(style.annotationColor, '#00ff00');
        // … severity fills the fields the tag leaves open.
        assert.strictEqual(style.border, '#aa0000');
        assert.strictEqual(style.backgroundColor, undefined);
    });

    test('first matching tag wins over later tags', () => {
        const style = resolveAnnotationStyle(
            { tags: ['security', 'todo'] },
            config({
                tagStyles: {
                    security: { annotationColor: '#ff00ff' },
                    todo: { annotationColor: '#00ff00', backgroundColor: '#003300' },
                },
            })
        );
        assert.strictEqual(style.annotationColor, '#ff00ff');
        // Only the first matching tag style is used — later tags do not merge in.
        assert.strictEqual(style.backgroundColor, undefined);
    });

    test('tags without a configured style are skipped in order', () => {
        const style = resolveAnnotationStyle(
            { tags: ['unstyled', 'todo'] },
            config({ tagStyles: { todo: { annotationColor: '#00ff00' } } })
        );
        assert.strictEqual(style.annotationColor, '#00ff00');
    });

    test('empty tag entry does not shadow a later styled tag', () => {
        const style = resolveAnnotationStyle(
            { tags: ['first', 'second'] },
            config({ tagStyles: { first: {}, second: { border: '#123456' } } })
        );
        assert.strictEqual(style.border, '#123456');
    });

    test('tag matching is case-insensitive', () => {
        const style = resolveAnnotationStyle(
            { tags: ['TODO'] },
            config({ tagStyles: { todo: { backgroundColor: '#003300' } } })
        );
        assert.strictEqual(style.backgroundColor, '#003300');
    });

    test('tag can re-enable the gutter icon disabled by the severity style', () => {
        const style = resolveAnnotationStyle(
            { severity: 'info', tags: ['pin'] },
            config({
                severityStyles: { info: { gutterIcon: false } },
                tagStyles: { pin: { gutterIcon: true } },
            })
        );
        assert.strictEqual(style.gutterIcon, true);
    });
});

suite('annotationStyle — malformed settings input', () => {
    test('non-object style entries are ignored', () => {
        const styles = { todo: 'red' } as unknown as Record<string, StyleSpec>;
        const style = resolveAnnotationStyle({ tags: ['todo'] }, config({ tagStyles: styles }));
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });

    test('wrongly typed fields inside a spec are dropped, valid ones kept', () => {
        const styles = {
            warning: { annotationColor: 42, border: '#ffcc00', gutterIcon: 'no' },
        } as unknown as Record<string, StyleSpec>;
        const style = resolveAnnotationStyle({ severity: 'warning' }, config({ severityStyles: styles }));
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.border, '#ffcc00');
        assert.strictEqual(style.gutterIcon, true);
    });

    test('missing style maps are tolerated', () => {
        const broken = {} as StyleConfig;
        const style = resolveAnnotationStyle({ severity: 'info', tags: ['todo'] }, broken);
        assert.strictEqual(style.annotationColor, undefined);
        assert.strictEqual(style.gutterIcon, true);
    });
});
