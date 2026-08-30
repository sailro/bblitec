import assert from "node:assert/strict";
import test from "node:test";
import { runConcurrently } from "../src/run-concurrently.js";

test("retries only failed parallel items after the batch drains", async () => {
    const attempts = new Map<number, number>();
    let active = 0;
    let retryOverlap = false;
    await runConcurrently(
        [1, 2, 3],
        3,
        String,
        async (item) => {
            active += 1;
            const attempt = (attempts.get(item) ?? 0) + 1;
            attempts.set(item, attempt);
            if (attempt > 1 && active > 1) retryOverlap = true;
            await Promise.resolve();
            active -= 1;
            if (attempt === 1 && item !== 2) {
                throw new Error(`transient ${item}`);
            }
        },
        { retryFailuresSequentially: true },
    );

    assert.deepEqual([...attempts], [
        [1, 2],
        [2, 1],
        [3, 2],
    ]);
    assert.equal(retryOverlap, false);
});

test("reports a failure that repeats on its sequential retry", async () => {
    const attempts = new Map<number, number>();
    await assert.rejects(
        runConcurrently(
            [1, 2],
            2,
            (item) => `item-${item}`,
            async (item) => {
                attempts.set(item, (attempts.get(item) ?? 0) + 1);
                if (item === 1) throw new Error("deterministic");
            },
            { retryFailuresSequentially: true },
        ),
        /1 of 2 failed:\n  item-1: deterministic/,
    );
    assert.deepEqual([...attempts], [
        [1, 2],
        [2, 1],
    ]);
});
