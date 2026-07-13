// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import { AnnotationSaveCoordinator } from '../AnnotationSaveCoordinator';

suite('AnnotationSaveCoordinator', () => {
    test('coalesces scheduled changes and flushes the latest snapshot', async () => {
        let value = 1;
        const saved: number[] = [];
        const coordinator = new AnnotationSaveCoordinator(
            () => value,
            async (payload) => {
                saved.push(payload);
            },
            1000
        );

        coordinator.schedule();
        value = 2;
        coordinator.schedule();
        await coordinator.flush();

        assert.deepStrictEqual(saved, [2]);
        assert.strictEqual(coordinator.isDirty(), false);
        coordinator.dispose();
    });

    test('serializes overlapping writes', async () => {
        let value = 1;
        const saved: number[] = [];
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const coordinator = new AnnotationSaveCoordinator(
            () => value,
            async (payload) => {
                if (payload === 1) {
                    await firstGate;
                }
                saved.push(payload);
            },
            1000
        );

        coordinator.schedule();
        const first = coordinator.flush();
        value = 2;
        coordinator.schedule();
        const second = coordinator.flush();
        releaseFirst?.();
        await Promise.all([first, second]);

        assert.deepStrictEqual(saved, [1, 2]);
        coordinator.dispose();
    });

    test('keeps a failed snapshot dirty and retries it', async () => {
        let attempts = 0;
        const errors: unknown[] = [];
        const coordinator = new AnnotationSaveCoordinator(
            () => 'payload',
            async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Error('disk unavailable');
                }
            },
            1000,
            () => undefined,
            (error) => errors.push(error)
        );

        coordinator.schedule();
        await assert.rejects(coordinator.flush(), /disk unavailable/);
        assert.strictEqual(coordinator.isDirty(), true);
        await coordinator.flush();

        assert.strictEqual(attempts, 2);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(coordinator.isDirty(), false);
        coordinator.dispose();
    });
});
