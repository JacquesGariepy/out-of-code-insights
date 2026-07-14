import * as assert from 'assert';
import {
    DurableDestinationError,
    lineBreaksOnly,
    runDurableDestinationMutation,
    runSourceFirstConversion,
    restoreSourceOrKeepDestination,
    SourceConversionTransactionError,
} from '../../../comments/sourceConversionTransaction';

suite('Source conversion transaction', () => {
    test('does not mutate annotations when VS Code rejects the source edit', async () => {
        const calls: string[] = [];

        const result = await runSourceFirstConversion({
            applySource: async () => {
                calls.push('source');
                return false;
            },
            applyDestination: () => {
                calls.push('destination');
            },
            restoreSource: async () => {
                calls.push('restore');
                return true;
            },
        });

        assert.strictEqual(result, 'source-edit-rejected');
        assert.deepStrictEqual(calls, ['source']);
    });

    test('commits the annotation mutation only after the source edit', async () => {
        const calls: string[] = [];

        const result = await runSourceFirstConversion({
            applySource: async () => {
                calls.push('source');
                return true;
            },
            applyDestination: () => {
                calls.push('destination');
            },
            restoreSource: async () => {
                calls.push('restore');
                return true;
            },
        });

        assert.strictEqual(result, 'completed');
        assert.deepStrictEqual(calls, ['source', 'destination']);
    });

    test('makes the source durable before a destructive destination mutation', async () => {
        const calls: string[] = [];

        await runSourceFirstConversion({
            applySource: async () => {
                calls.push('source');
                return true;
            },
            makeSourceDurable: async () => {
                calls.push('save-source');
            },
            applyDestination: () => {
                calls.push('destination');
            },
            restoreSource: async () => {
                calls.push('restore');
                return true;
            },
        });

        assert.deepStrictEqual(calls, ['source', 'save-source', 'destination']);
    });

    test('restores the source and skips destination when making source durable fails', async () => {
        const calls: string[] = [];

        await assert.rejects(
            runSourceFirstConversion({
                applySource: async () => {
                    calls.push('source');
                    return true;
                },
                makeSourceDurable: async () => {
                    calls.push('save-source');
                    throw new Error('save rejected');
                },
                applyDestination: () => {
                    calls.push('destination');
                },
                restoreSource: async () => {
                    calls.push('restore');
                    return true;
                },
            }),
            SourceConversionTransactionError
        );

        assert.deepStrictEqual(calls, ['source', 'save-source', 'restore']);
    });

    test('restores the source when the annotation transaction fails', async () => {
        const calls: string[] = [];
        const destinationError = new Error('store commit failed');

        await assert.rejects(
            runSourceFirstConversion({
                applySource: async () => {
                    calls.push('source');
                    return true;
                },
                applyDestination: () => {
                    calls.push('destination');
                    throw destinationError;
                },
                restoreSource: async () => {
                    calls.push('restore');
                    return true;
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof SourceConversionTransactionError);
                assert.strictEqual(error.cause, destinationError);
                assert.strictEqual(error.sourceRestored, true);
                return true;
            }
        );

        assert.deepStrictEqual(calls, ['source', 'destination', 'restore']);
    });

    test('reports a rollback failure without hiding the destination error', async () => {
        await assert.rejects(
            runSourceFirstConversion({
                applySource: async () => true,
                applyDestination: () => {
                    throw new Error('destination failed');
                },
                restoreSource: async () => {
                    throw new Error('restore failed');
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof SourceConversionTransactionError);
                assert.strictEqual(error.sourceRestored, false);
                assert.match(error.message, /destination failed/);
                return true;
            }
        );
    });

    test('removes comment content while preserving every original line break', () => {
        assert.strictEqual(lineBreaksOnly('/* first\r\n * second\r\n */'), '\r\n\r\n');
        assert.strictEqual(lineBreaksOnly('// one\n// two'), '\n');
        assert.strictEqual(lineBreaksOnly('// one'), '');
    });

    test('strictly persists a destination mutation before reporting success', async () => {
        const calls: string[] = [];
        await runDurableDestinationMutation({
            mutate: () => calls.push('mutate'),
            persist: async () => {
                calls.push('persist');
            },
            compensate: () => calls.push('compensate'),
            persistCompensation: async () => {
                calls.push('persist-compensation');
            },
        });
        assert.deepStrictEqual(calls, ['mutate', 'persist']);
    });

    test('compensates memory and disk when strict destination persistence fails', async () => {
        const calls: string[] = [];
        await assert.rejects(
            runDurableDestinationMutation({
                mutate: () => calls.push('mutate'),
                persist: async () => {
                    calls.push('persist');
                    throw new Error('disk full');
                },
                compensate: () => calls.push('compensate'),
                persistCompensation: async () => {
                    calls.push('persist-compensation');
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof DurableDestinationError);
                assert.strictEqual(error.destinationRestored, true);
                return true;
            }
        );
        assert.deepStrictEqual(calls, ['mutate', 'persist', 'compensate', 'persist-compensation']);
    });

    test('reports when destination compensation could not be persisted', async () => {
        await assert.rejects(
            runDurableDestinationMutation({
                mutate: () => undefined,
                persist: async () => {
                    throw new Error('first write failed');
                },
                compensate: () => undefined,
                persistCompensation: async () => {
                    throw new Error('compensation write failed');
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof DurableDestinationError);
                assert.strictEqual(error.destinationRestored, false);
                return true;
            }
        );
    });

    test('compensates a mutation that changes state and then throws', async () => {
        const state: string[] = [];
        await assert.rejects(
            runDurableDestinationMutation({
                mutate: () => {
                    state.push('partially-mutated');
                    throw new Error('listener failed after commit');
                },
                persist: async () => {
                    state.push('must-not-persist');
                },
                compensate: () => {
                    state.length = 0;
                },
                persistCompensation: async () => {
                    state.push('compensation-persisted');
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof DurableDestinationError);
                assert.strictEqual(error.destinationRestored, true);
                return true;
            }
        );
        assert.deepStrictEqual(state, ['compensation-persisted']);
    });

    test('keeps and persists the destination when asynchronous source restore rejects', async () => {
        const calls: string[] = [];
        const restored = await restoreSourceOrKeepDestination({
            restoreSource: async () => {
                calls.push('restore-source');
                throw new Error('workspace edit rejected asynchronously');
            },
            ensureDestination: () => calls.push('ensure-destination'),
            releasePersistence: () => calls.push('release-gate'),
            persistDestination: async () => {
                calls.push('persist-destination');
            },
        });
        assert.strictEqual(restored, false);
        assert.deepStrictEqual(calls, ['restore-source', 'ensure-destination', 'release-gate', 'persist-destination']);
    });

    test('releases and attempts persistence even when conservative reinstall throws', async () => {
        const calls: string[] = [];
        await assert.rejects(
            restoreSourceOrKeepDestination({
                restoreSource: async () => false,
                ensureDestination: () => {
                    calls.push('ensure-destination');
                    throw new Error('destination diverged');
                },
                releasePersistence: () => calls.push('release-gate'),
                persistDestination: async () => {
                    calls.push('persist-destination');
                },
            }),
            /destination diverged/
        );
        assert.deepStrictEqual(calls, ['ensure-destination', 'release-gate', 'persist-destination']);
    });
});
