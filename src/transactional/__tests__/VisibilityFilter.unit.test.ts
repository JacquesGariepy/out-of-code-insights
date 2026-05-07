// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { VisibilityFilter, type AnnotationVisibilityConfig, type AnnotationVisibilityInput } from '../VisibilityFilter';

function configure(overrides: Partial<AnnotationVisibilityConfig> = {}): AnnotationVisibilityConfig {
    return {
        enableAnnotations: true,
        disabledTags: [],
        currentFilter: 'all',
        ...overrides,
    };
}

function ann(overrides: Partial<AnnotationVisibilityInput> = {}): AnnotationVisibilityInput {
    return {
        file: 'src/foo.ts',
        message: 'hello world',
        ...overrides,
    };
}

suite('VisibilityFilter — global enable', () => {
    test('isGloballyEnabled tracks the config flag', () => {
        let cfg = configure({ enableAnnotations: true });
        const filter = new VisibilityFilter(() => cfg);
        assert.strictEqual(filter.isGloballyEnabled(), true);
        cfg = configure({ enableAnnotations: false });
        assert.strictEqual(filter.isGloballyEnabled(), false);
    });
});

suite('VisibilityFilter — disabled tags', () => {
    test('annotation with a disabled tag is hidden', () => {
        const filter = new VisibilityFilter(() => configure({ disabledTags: ['noisy'] }));
        assert.strictEqual(filter.isVisible(ann({ tags: ['noisy', 'spec'] })), false);
    });

    test('annotation without disabled tags is visible (filter=all)', () => {
        const filter = new VisibilityFilter(() => configure({ disabledTags: ['noisy'] }));
        assert.strictEqual(filter.isVisible(ann({ tags: ['important'] })), true);
    });
});

suite('VisibilityFilter — keyword filter', () => {
    test('keyword match in message → visible', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'keyword:bug' }));
        assert.strictEqual(filter.isVisible(ann({ message: 'small bug here' })), true);
    });

    test('keyword match in thread comment → visible', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'keyword:later' }));
        assert.strictEqual(filter.isVisible(ann({ message: 'x', thread: [{ message: 'fix later' }] })), true);
    });

    test('keyword without match → hidden', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'keyword:absent' }));
        assert.strictEqual(filter.isVisible(ann()), false);
    });

    test('empty keyword (`keyword:`) → all visible', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'keyword:' }));
        assert.strictEqual(filter.isVisible(ann()), true);
    });
});

suite('VisibilityFilter — severity filter', () => {
    test('severity match → visible', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'severity:error' }));
        assert.strictEqual(filter.isVisible(ann({ severity: 'error' })), true);
    });

    test('severity mismatch → hidden', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'severity:error' }));
        assert.strictEqual(filter.isVisible(ann({ severity: 'info' })), false);
    });
});

suite('VisibilityFilter — tag/file fallback', () => {
    test('matching tag → visible', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'arch' }));
        assert.strictEqual(filter.isVisible(ann({ tags: ['Arch'] })), true);
    });

    test('matching file substring → visible (when no tag matches)', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'foo' }));
        assert.strictEqual(filter.isVisible(ann({ file: 'src/foo.ts', tags: [] })), true);
    });

    test('no match anywhere → hidden', () => {
        const filter = new VisibilityFilter(() => configure({ currentFilter: 'zzz' }));
        assert.strictEqual(filter.isVisible(ann({ file: 'src/foo.ts', tags: [] })), false);
    });
});

suite('VisibilityFilter — events', () => {
    test('refresh fires onDidChange', () => {
        const filter = new VisibilityFilter(() => configure());
        const events: number[] = [];
        const sub = filter.onDidChange(() => events.push(1));
        filter.refresh();
        filter.refresh();
        sub.dispose();
        assert.strictEqual(events.length, 2);
    });
});
