/**
 * Pure-logic tests for the trailing-edge debouncer used by the docs watch
 * mode. No vscode dependency — runs in the fast `test:unit` pass.
 */
import * as assert from 'assert';
import { createDebounced } from '../../../utils/debounce';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('createDebounced', () => {
    test('runs the wrapped function once after the delay', async () => {
        let calls = 0;
        const debounced = createDebounced(() => {
            calls++;
        }, 20);
        debounced.schedule();
        assert.strictEqual(calls, 0, 'must not fire synchronously');
        assert.strictEqual(debounced.isPending(), true);
        await sleep(60);
        assert.strictEqual(calls, 1);
        assert.strictEqual(debounced.isPending(), false);
    });

    test('coalesces rapid schedules into a single invocation', async () => {
        let calls = 0;
        const debounced = createDebounced(() => {
            calls++;
        }, 25);
        debounced.schedule();
        await sleep(5);
        debounced.schedule();
        await sleep(5);
        debounced.schedule();
        await sleep(80);
        assert.strictEqual(calls, 1, 'three rapid schedules must produce one call');
    });

    test('fires again after a completed cycle', async () => {
        let calls = 0;
        const debounced = createDebounced(() => {
            calls++;
        }, 10);
        debounced.schedule();
        await sleep(40);
        debounced.schedule();
        await sleep(40);
        assert.strictEqual(calls, 2);
    });

    test('cancel drops the pending invocation', async () => {
        let calls = 0;
        const debounced = createDebounced(() => {
            calls++;
        }, 15);
        debounced.schedule();
        debounced.cancel();
        assert.strictEqual(debounced.isPending(), false);
        await sleep(50);
        assert.strictEqual(calls, 0);
    });

    test('cancel is idempotent and safe without a pending call', () => {
        const debounced = createDebounced(() => undefined, 15);
        debounced.cancel();
        debounced.cancel();
        assert.strictEqual(debounced.isPending(), false);
    });

    test('rejects a negative or non-finite delay', () => {
        assert.throws(() => createDebounced(() => undefined, -1), RangeError);
        assert.throws(() => createDebounced(() => undefined, Number.NaN), RangeError);
        assert.throws(() => createDebounced(() => undefined, Number.POSITIVE_INFINITY), RangeError);
    });
});
