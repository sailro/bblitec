import assert from "node:assert/strict";
import test from "node:test";
import {
    importAugmentedModule,
    loadAugmentedModule,
} from "../src/pinned-module-loader.js";

test("sync and async pinned loads share execution, private bindings and cached exports", async () => {
    const source = `const state = { calls: 0 }; const __proto__ = "ordinary"; function next() { return ++state.calls; } export { state };`;
    const sync = loadAugmentedModule(source, "shared.mjs");
    const async = await importAugmentedModule(source, "shared.mjs");
    assert.strictEqual(sync, async);
    assert.strictEqual(loadAugmentedModule(source, "shared.mjs"), sync);
    assert.equal(sync.__proto__, "ordinary");
    assert.equal(Object.hasOwn(sync, "__proto__"), true);
    assert.equal(typeof sync.next, "function");
    if (typeof sync.next !== "function")
        throw new Error("Missing augmented function.");
    assert.equal(Reflect.apply(sync.next, undefined, []), 1);
    assert.equal(Reflect.apply(sync.next, undefined, []), 2);
    const changed = loadAugmentedModule(
        source.replace("calls: 0", "calls: 10"),
        "shared.mjs",
    );
    assert.notStrictEqual(changed.state, sync.state);
});

test("async pinned modules finish top-level await before exposing bindings", async () => {
    const source = `const ready = await Promise.resolve(42);`;
    const loaded = await importAugmentedModule(source, "awaited.mjs");
    assert.equal(loaded.ready, 42);
    assert.strictEqual(loadAugmentedModule(source, "awaited.mjs"), loaded);
});
