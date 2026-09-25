import assert from "node:assert/strict";
import test from "node:test";
import { ClosureCaptures } from "../src/compiler/closure-captures.js";
import { cppIdentifiers } from "../src/compiler/cpp-identifiers.js";
import { compileSource } from "../src/compiler.js";
import { NativeCaptureCache } from "../src/compiler/native-capture-cache.js";
import type { Value } from "../src/compiler/types.js";
import {
    EmissionMap,
    EmissionTransaction,
    emissionRecord,
    emissionArray,
    writable,
} from "../src/compiler/emission-transaction.js";

test("cached captures follow nested writes, native aliases and speculative rollback", () => {
    const first = {
        name: "first",
        sequence: 1,
        borrowed: false,
        allowReference: false,
        entryLifetime: false,
    };
    const second = { ...first, name: "second", sequence: 2 };
    const names = new EmissionMap([
        [first.name, first],
        [second.name, second],
    ]);
    const cache = new NativeCaptureCache(names);
    const leaf: Value = { kind: "number", cpp: first.name };
    const fields = emissionRecord<Record<string, Value>>({ child: leaf });
    const row: Value = { kind: "record", cpp: "", recordProperties: fields };
    const elements = emissionArray<Value>([row]);
    const root: Value = { kind: "tuple", cpp: "", tupleElements: elements };
    const original = cache.bindingsOf(root);
    assert.deepEqual(original, [first]);
    assert.strictEqual(cache.bindingsOf(root), original);
    new EmissionTransaction().run(() => {
        writable(leaf).cpp = second.name;
        assert.deepEqual(cache.bindingsOf(root), [second]);
        fields.child = root; // A cyclic graph terminates and has no leaf capture.
        assert.deepEqual(cache.bindingsOf(root), []);
        elements.push(leaf);
        assert.deepEqual(cache.bindingsOf(root), [second]);
        return false;
    }, Boolean);
    assert.deepEqual(cache.bindingsOf(root), [first]);
    names.set(first.name, second);
    assert.deepEqual(cache.bindingsOf(root), [second]);
});

test("capture reads exclude comments, strings, characters and raw strings", () => {
    const reads = cppIdentifiers(String.raw`
        use(real, longer_name); // comment
        /* block */ const char* text = "escaped \" hidden";
        char letter = 'x'; auto count = 1'000ULL;
        auto raw = u8R"tag( raw_name " extra )tag";
    `);
    for (const name of ["real", "longer_name", "use"])
        assert.ok(reads.has(name));
    for (const name of [
        "comment",
        "block",
        "escaped",
        "hidden",
        "x",
        "ULL",
        "raw_name",
        "extra",
    ]) {
        assert.ok(!reads.has(name), name);
    }
});

test("capture pruning preserves order and reference ownership", () => {
    const capture = new ClosureCaptures("environment", 4);
    for (const [index, name] of ["first", "unused", "last"].entries()) {
        capture.use({
            name,
            sequence: index + 1,
            borrowed: name === "last",
            allowReference: true,
            entryLifetime: false,
        });
    }
    capture.retainReferenced(
        cppIdentifiers(`first += last; log("unused"); // unused`),
    );
    const struct = capture.environmentStruct;
    assert.equal(
        capture.initializer,
        `bblscene::${struct.name}{first, std::ref(last)}`,
    );
    assert.deepEqual(capture.declarations, [
        "auto& first = environment.capture0;",
        "auto& last = environment.capture1.get();",
    ]);
    // Without binding types the struct is a template over its members, and
    // only owned members are traced.
    assert.equal(struct.declaration, undefined);
    assert.deepEqual(struct.lines, [
        "template <typename T0, typename T1>",
        `struct ${struct.name} {`,
        "    T0 capture0;",
        "    T1 capture1;",
        "    void gc_trace([[maybe_unused]] const bbl::js::TraceVisitor& visitor) const {",
        "        visitor(capture0);",
        "    }",
        "};",
    ]);
});

test("typed captures name a concrete environment struct", () => {
    const capture = new ClosureCaptures("environment", 2, false, (binding) =>
        binding.name === "count" ? "double" : "bbl::Engine",
    );
    for (const [index, name] of ["count", "engine"].entries()) {
        capture.use({
            name,
            sequence: index + 1,
            borrowed: name === "engine",
            allowReference: true,
            entryLifetime: false,
        });
    }
    capture.retainReferenced(cppIdentifiers("count += engine.frame;"));
    const struct = capture.environmentStruct;
    assert.equal(struct.declaration, `struct ${struct.name};`);
    assert.equal(capture.environmentType, `bblscene::${struct.name}`);
    assert.deepEqual(struct.lines.slice(0, 4), [
        `struct ${struct.name} {`,
        "    std::decay_t<double> capture0;",
        "    std::reference_wrapper<bbl::Engine> capture1;",
        "    void gc_trace([[maybe_unused]] const bbl::js::TraceVisitor& visitor) const {",
    ]);
});

test("a captured resource with one native type names a concrete environment", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender, createGpuPicker, disposePicker } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const picker = createGpuPicker(scene);
        onBeforeRender(scene, () => { disposePicker(picker); });
    `);
    assert.match(
        result.cpp,
        /struct bbl_environment_\w+ \{\n {4}std::reference_wrapper<bbl::GpuPickerHandle> capture0;/,
    );
    assert.doesNotMatch(result.cpp, /template<typename Environment>/);
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
    const captures = [
        ...result.cpp.matchAll(
            /auto& (\w+) = v_bblite_environment_\d+\.[^\n]+/g,
        ),
    ].map((match) => match[1]);
    assert.ok(captures.length > 0);
    for (const name of captures) assert.ok(!name?.includes("unused"));
    assert.doesNotMatch(
        result.cpp,
        /\[\[maybe_unused\]\] auto& \w+ = v_bblite_environment_/,
    );
});
