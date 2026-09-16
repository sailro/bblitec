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
