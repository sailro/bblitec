export interface ConcurrentRunOptions {
    /** Positive verdict printed after a multi-item run. */
    completed?: string;
    /** Retry only failed items once, with no overlap between retries. */
    retryFailuresSequentially?: boolean;
}

interface ConcurrentFailure<T> {
    item: T;
    message: string;
}

/**
 * Runs independent work with a fixed concurrency limit and reports every
 * failure together. A caller that shares a scarce process-global resource
 * may request one sequential retry after the parallel batch drains.
 */
export async function runConcurrently<T>(
    items: readonly T[],
    limit: number,
    describe: (item: T) => string,
    body: (item: T) => Promise<void>,
    options: ConcurrentRunOptions = {},
): Promise<void> {
    const runBatch = async (
        batch: readonly T[],
        batchLimit: number,
    ): Promise<ConcurrentFailure<T>[]> => {
        const queue = [...batch];
        const failures: ConcurrentFailure<T>[] = [];
        const worker = async (): Promise<void> => {
            for (;;) {
                const item = queue.shift();
                if (item === undefined) return;
                try {
                    await body(item);
                } catch (error) {
                    failures.push({
                        item,
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
            }
        };
        await Promise.all(
            Array.from(
                {
                    length: Math.max(
                        1,
                        Math.min(batchLimit, queue.length),
                    ),
                },
                worker,
            ),
        );
        return failures;
    };

    let failures = await runBatch(items, limit);
    if (
        failures.length > 0 &&
        options.retryFailuresSequentially &&
        limit > 1
    ) {
        console.warn(
            `Retrying ${failures.length} failed item(s) sequentially after the parallel batch.`,
        );
        failures = await runBatch(
            failures.map(({ item }) => item),
            1,
        );
    }
    if (failures.length > 0) {
        throw new Error(
            `${failures.length} of ${items.length} failed:\n  ${failures
                .map(({ item, message }) => `${describe(item)}: ${message}`)
                .join("\n  ")}`,
        );
    }
    if (options.completed !== undefined && items.length > 1) {
        console.log(`All ${items.length} scenes ${options.completed}.`);
    }
}
