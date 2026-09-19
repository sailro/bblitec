import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
    engineFrameCaptureModule,
    waitForCapturedEngines,
} from "../src/capture-engine-frames.js";

test("independent engines retain pinned readiness, render exact frame counts and flush without drawing again", async () => {
    const callbacks = new Map<number, () => void>();
    let nextFrame = 0;
    const raf = (callback: () => void): number => {
        callbacks.set(++nextFrame, callback);
        return nextFrame;
    };
    interface Engine {
        _renderFn?: (time: number) => void;
        _animFrameId?: number;
        _device: { queue: { onSubmittedWorkDone(): Promise<void> } };
        timestamps: number[];
    }
    const completed: string[] = [];
    const startPinnedEngine = (engine: Engine): Promise<void> =>
        new Promise((resolve) => {
            engine._renderFn = (time) => {
                engine.timestamps.push(time);
                resolve();
                engine._animFrameId = raf(() => engine._renderFn?.(time));
            };
            engine._animFrameId = raf(() => engine._renderFn?.(0));
        });
    const module = engineFrameCaptureModule(3, "/pin.js")
        .replace(/^export \*[^\n]+\nimport[^\n]+\n/, "")
        .replace("export function startEngine", "function startEngine");
    const start = runInNewContext(`${module}\nstartEngine`, {
        startPinnedEngine,
        crypto: { randomUUID: () => "realm" },
        requestAnimationFrame: raf,
        cancelAnimationFrame: (id: number) => callbacks.delete(id),
        encodeURIComponent,
        fetch: async (url: string) => {
            completed.push(url);
            return { ok: true };
        },
    }) as (engine: Engine) => Promise<void>;
    const engine = (): Engine => ({
        timestamps: [],
        _device: { queue: { onSubmittedWorkDone: async () => {} } },
    });
    const left = engine(),
        right = engine();
    const ready = start(left);
    const tick = async (): Promise<void> => {
        const due = [...callbacks];
        callbacks.clear();
        for (const [, callback] of due) callback();
        await Promise.resolve();
    };
    await tick();
    await ready;
    assert.equal(left.timestamps.length, 1);
    const rightReady = start(right);
    for (let index = 0; index < 8; ++index) await tick();
    await rightReady;
    const expected = [0, 1000 / 60, 2 * (1000 / 60), 50];
    assert.deepEqual(left.timestamps, expected);
    assert.deepEqual(right.timestamps, expected);
    assert.equal(callbacks.size, 0);
    assert.equal(new Set(completed).size, 2);
});

test("engine capture waits for asynchronous completion from every realm", async () => {
    const polls: Array<() => void> = [];
    let reads = 0;
    let completed = false;
    const waiting = runInNewContext(
        `(${waitForCapturedEngines.toString()})(60000)`,
        {
            Date: { now: () => 0 },
            fetch: async () => ({
                ok: true,
                json: async () => ({ completed: reads++, expected: 2 }),
            }),
            setTimeout: (callback: () => void) => polls.push(callback),
        },
    ) as Promise<void>;
    void waiting.then(() => {
        completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(completed, false);
    assert.equal(polls.length, 1);
    polls.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(completed, false);
    assert.equal(polls.length, 1);
    polls.shift()?.();
    await waiting;
    assert.equal(reads, 3);
    assert.equal(completed, true);
    assert.equal(polls.length, 0);
});

test("engine capture rejects undeclared engines and failed status requests", async () => {
    for (const [ok, message] of [
        [true, /More engines started/],
        [false, /status request failed/],
    ] as const) {
        const waiting = runInNewContext(
            `(${waitForCapturedEngines.toString()})(60000)`,
            {
                Date: { now: () => 0 },
                fetch: async () => ({
                    ok,
                    json: async () => ({ completed: 3, expected: 2 }),
                }),
            },
        ) as Promise<void>;
        await assert.rejects(waiting, message);
    }
});

test("engine capture times out instead of accepting an unfinished realm", async () => {
    let now = 0;
    let reads = 0;
    const waiting = runInNewContext(
        `(${waitForCapturedEngines.toString()})(50)`,
        {
            Date: { now: () => now },
            fetch: async () => {
                reads++;
                return {
                    ok: true,
                    json: async () => ({ completed: 1, expected: 2 }),
                };
            },
            setTimeout: (callback: () => void, delay: number) => {
                now += delay;
                queueMicrotask(callback);
            },
        },
    ) as Promise<void>;
    await assert.rejects(waiting, /Timed out waiting for every engine/);
    assert.equal(reads, 2);
});
