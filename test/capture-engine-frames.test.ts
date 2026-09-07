import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { engineFrameCaptureModule } from "../src/capture-engine-frames.js";

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
    const startPinnedEngine = (engine: Engine): Promise<void> => new Promise((resolve) => {
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
    const start: (engine: Engine) => Promise<void> = runInNewContext(`${module}\nstartEngine`, {
        startPinnedEngine, crypto: { randomUUID: () => "realm" },
        requestAnimationFrame: raf, cancelAnimationFrame: (id: number) => callbacks.delete(id),
        encodeURIComponent, fetch: async (url: string) => { completed.push(url); return { ok: true }; },
    });
    const engine = (): Engine => ({ timestamps: [], _device: { queue: { onSubmittedWorkDone: async () => {} } } });
    const left = engine(), right = engine();
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
    start(right);
    for (let index = 0; index < 8; ++index) await tick();
    const expected = [0, 1000 / 60, 2 * (1000 / 60), 50];
    assert.deepEqual(left.timestamps, expected);
    assert.deepEqual(right.timestamps, expected);
    assert.equal(callbacks.size, 0);
    assert.equal(new Set(completed).size, 2);
});
