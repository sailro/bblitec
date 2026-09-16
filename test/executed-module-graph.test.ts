import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("a module pass run at generation resolves extensionless siblings and skips type-only imports", () => {
    const result = compileSource(`
        import { emptyBindings } from "./fixtures/executed-module/bindings.js";
        const bindings = emptyBindings();
        const chosen = Date.now() > 0 ? bindings.oak : bindings.pine;
        if (chosen !== 3) throw new Error("bindings " + chosen);
    `, { fileName: "test/executed-module-entry.ts" });
    // The pass ran at generation: its result is data selected at run time,
    // its body never lowers, and the module the type came from, which
    // reaches the engine, was never executed.
    assert.doesNotMatch(result.cpp, /emptyBindings|seedCount|requireEngine/);
    assert.match(result.cpp, /\? 3\.0 : 4\.0/);
});

test("a generation-time fold whose module reaches the engine lowers as an ordinary call", () => {
    const result = compileSource(`
        import { spawnCounts } from "./fixtures/executed-module/engine-pass.js";
        const counts = spawnCounts();
        const chosen = Date.now() > 0 ? counts.oak : counts.pine;
        if (chosen !== 3) throw new Error("counts " + chosen);
    `, { fileName: "test/executed-module-entry.ts" });
    // The module value-imports the engine, so the pass cannot fold; the call
    // lowers as ordinary code and the whole compile does not abort.
    assert.match(result.cpp, /spawnCounts/);
    assert.match(result.cpp, /int main\(\)/);
});

test("a generation-time fold whose result is not round-trip data lowers as an ordinary call", () => {
    const result = compileSource(`
        import { seedBindings } from "./fixtures/executed-module/map-pass.js";
        const bindings = seedBindings();
        if (bindings.a.get(1) !== 2 || bindings.b.get(3) !== 4) throw new Error("bindings");
    `, { fileName: "test/executed-module-entry.ts" });
    // A Map value would serialize to an empty object, so the fold declines
    // and the pass lowers to a real native Map instead of folding to {}.
    assert.match(result.cpp, /bbl::js::Map/);
});
