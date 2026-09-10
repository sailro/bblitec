import assert from "node:assert/strict";
import test from "node:test";
import { ClosureCaptures } from "../src/compiler/closure-captures.js";
import { cppIdentifiers } from "../src/compiler/cpp-identifiers.js";
import { compileSource } from "../src/compiler.js";

test("capture reads exclude comments, strings, characters and raw strings", () => {
    const reads = cppIdentifiers(String.raw`
        use(real, longer_name); // comment
        /* block */ const char* text = "escaped \" hidden";
        char letter = 'x'; auto count = 1'000ULL;
        auto raw = u8R"tag( raw_name " extra )tag";
    `);
    for (const name of ["real", "longer_name", "use"]) assert.ok(reads.has(name));
    for (const name of ["comment", "block", "escaped", "hidden", "x", "ULL", "raw_name", "extra"]) {
        assert.ok(!reads.has(name), name);
    }
});

test("capture pruning preserves order and reference ownership", () => {
    const capture = new ClosureCaptures("environment", 4);
    for (const [index, name] of ["first", "unused", "last"].entries()) {
        capture.use({ name, sequence: index + 1, borrowed: name === "last", allowReference: true, entryLifetime: false });
    }
    capture.retainReferenced([`first += last; log("unused"); // unused`]);
    assert.equal(capture.initializer, "std::tuple{first, std::ref(last)}");
    assert.deepEqual(capture.declarations, [
        "auto& first = std::get<0>(environment);",
        "auto& last = std::get<1>(environment).get();",
    ]);
});

test("a projected record callback captures only the field its body reads", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        let used = 1;
        let unused = 2;
        const state = { used, unused };
        onBeforeRender(scene, () => { if (state.used < 0) throw new Error("unused"); });
    `);
    const captures = [...result.cpp.matchAll(/auto& (\w+) = std::get<\d+>\([^\n]+/g)].map(match => match[1]);
    assert.ok(captures.length > 0);
    for (const name of captures) assert.ok(!name?.includes("unused"));
    assert.doesNotMatch(result.cpp, /\[\[maybe_unused\]\] auto& \w+ = std::get/);
});
