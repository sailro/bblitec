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
    assert.doesNotMatch(result.cpp, /emptyBindings|seedCount/);
    assert.match(result.cpp, /\? 3\.0 : 4\.0/);
});

test("a generation-time fold whose module reaches the engine lowers as an ordinary call", () => {
    const result = compileSource(`
        import { spawnCounts } from "./fixtures/executed-module/kinds.js";
        const counts = spawnCounts();
        if (counts.oak !== 3) throw new Error("counts " + counts.oak);
    `, { fileName: "test/executed-module-entry.ts" });
    // The module imports the engine, so the pass declines before any child
    // is spawned and the call lowers as ordinary code.
    assert.match(result.cpp, /spawnCounts/);
});

test("a generation-time fold whose sibling reaches the engine lowers as an ordinary call", () => {
    const result = compileSource(`
        import { siblingCounts } from "./fixtures/executed-module/via-sibling.js";
        const counts = siblingCounts();
        if (counts.pine !== 4) throw new Error("counts " + counts.pine);
    `, { fileName: "test/executed-module-entry.ts" });
    // Only the sibling reaches the engine: the child discovers it while
    // inlining the graph, classifies the decline, and the call lowers.
    assert.match(result.cpp, /siblingCounts/);
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

test("a canvas readback data function whose result is not a document refuses at its site", () => {
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";
                import { paintCounts } from "./fixtures/browser-texture/readback.js";
                import { seedBindings } from "./fixtures/executed-module/map-pass.js";
                async function main() {
                    const engine = await createEngine({});
                    paintCounts(engine, seedBindings());
                }
                main();
            `, { fileName: "test/readback-entry.ts" }),
        /readback-entry\.ts:\d+:\d+: .*not a plain-data JSON document/,
    );
});
