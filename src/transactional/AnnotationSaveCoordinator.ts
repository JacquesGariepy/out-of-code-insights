// SPDX-License-Identifier: MPL-2.0

/**
 * Serializes debounced snapshots and exposes an awaitable flush barrier for
 * extension shutdown. Failed writes remain dirty so a later flush can retry.
 */
export class AnnotationSaveCoordinator<T> {
    private timer: NodeJS.Timeout | undefined;
    private queue: Promise<void> = Promise.resolve();
    private dirty = false;
    private disposed = false;

    constructor(
        private readonly snapshot: () => T,
        private readonly persist: (payload: T) => Promise<void>,
        private readonly delayMs: number,
        private readonly onSaved: () => void = () => undefined,
        private readonly onError: (error: unknown) => void = () => undefined
    ) {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new RangeError('AnnotationSaveCoordinator delay must be a finite non-negative number');
        }
    }

    schedule(): void {
        if (this.disposed) {
            return;
        }
        this.dirty = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => undefined);
        }, this.delayMs);
    }

    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.dirty) {
            await this.queue;
            return;
        }

        const payload = this.snapshot();
        this.dirty = false;
        const operation = this.queue.catch(() => undefined).then(() => this.persist(payload));
        this.queue = operation;
        try {
            await operation;
            this.onSaved();
        } catch (error) {
            this.dirty = true;
            this.onError(error);
            throw error;
        }
    }

    isDirty(): boolean {
        return this.dirty;
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}
