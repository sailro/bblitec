import assert from "node:assert/strict";
import test from "node:test";
import { ClosureCaptures } from "../src/compiler/closure-captures.js";
import {
    cppIdentifiers,
    cppOuterReads,
} from "../src/compiler/cpp-identifiers.js";
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
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

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

test("outer reads skip a lambda body whose return type spells a function type", () => {
    const reads = cppOuterReads(
        "([&]() -> bbl::js::Callback<void()> { bbl::js::Callback<void()> local = make(ready); return local; })()",
    );
    assert.ok(!reads.has("local"));
    assert.ok(!reads.has("ready"));
    assert.ok(
        cppOuterReads("[&]() -> double { return inner; }() + outer").has(
            "outer",
        ),
    );
    assert.ok(
        !cppOuterReads("[&]() -> double { return inner; }() + outer").has(
            "inner",
        ),
    );
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
        "    std::decay_t<double> capture0{};",
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

test("a shared body captures the record a spread literal built for its call", () => {
    // The literal spreads a parsed document, so it is a map declared at the
    // call; a handle field keeps the callee from taking a document, so its
    // shared body reads the map through its environment.
    const result = compileSource(`
        import { createEngine, type ShadowGenerator } from "@babylonjs/lite";
        interface Surface { maxDepth: number; slopeFalloff: number }
        interface Shell { sunDir?: [number, number, number]; shadow?: ShadowGenerator; maxDepth?: number; slopeFalloff?: number; sparkle?: number; shadeBlue?: number }
        function createShell(opts: Shell): number {
            const params: [number, number, number] = [opts.maxDepth ?? 0.6, opts.slopeFalloff ?? 0.45, opts.sparkle ?? 0.7];
            console.log(params[0], params[1], params[2], opts.shadeBlue ?? 0.5, opts.shadow !== undefined, opts.sunDir?.[1] ?? -1);
            return params[0];
        }
        async function main() {
            await createEngine({});
            const config = JSON.parse(localStorage.getItem("cfg") ?? '{"snow":{"maxDepth":0.5,"slopeFalloff":0.4,"shadeBlue":0.3,"sparkle":0.9}}') as { snow: Surface & { shadeBlue: number; sparkle: number } };
            const cfgSnow = config.snow;
            const surface: Surface = cfgSnow;
            createShell({ ...surface, sunDir: [-0.55, -1, -0.42], shadeBlue: cfgSnow.shadeBlue, sparkle: cfgSnow.sparkle });
        }
        void main();
    `);
    const captured =
        /auto& (v_bblite_record_spread_\d+) = v_bblite_environment_\d+\.capture\d+;/.exec(
            result.cpp,
        );
    assert.ok(
        captured,
        "the shared body reads the map through its environment",
    );
    assert.match(
        result.cpp,
        new RegExp(
            String.raw`make_closure\(bblscene::bbl_environment_\w+\{${captured[1]}\}`,
        ),
    );
});

test(
    "a shared body captures a record argument's member a caller temporary holds",
    { skip: !optionalNativeFixtureTools(false) },
    () => {
        // `walls.filter(...)` is a temporary of the caller; the record literal
        // holding it is the shared body's compile-time argument.
        const { cpp } = compileSource(
            `
            interface Needs { wallSurface?: readonly string[]; houses?: readonly string[] }
            const ids = (requested: readonly string[] | undefined): string[] =>
                [...new Set((requested ?? []).map((id) => id + "!"))];
            function resolve(needs: Needs): string[] {
                return ids([...(needs.wallSurface ?? []), ...(needs.houses ?? [])]);
            }
            const walls: string[] = ["x", "y"];
            const first = resolve({ wallSurface: walls.filter((w) => w !== "y"), houses: ["a"] }).join(",");
            if (first !== "x!,a!") throw new Error("filtered member " + first);
            const second = resolve({ wallSurface: ["w", "z"], houses: ["a"] }).join(",");
            if (second !== "w!,z!,a!") throw new Error("literal member " + second);
            `,
            { fileName: "shared-record-member.ts" },
        );
        runGeneratedProgram(
            optionalNativeFixtureTools(false)!,
            "closure-captures-shared-record-member",
            cpp,
        );
    },
);

test(
    "a spread copies a method with the scope that declared it",
    { skip: !optionalNativeFixtureTools(false) },
    () => {
        const factory = `
            interface Channel { sync(force?: boolean): void; facts(): Float32Array; version(): number }
            interface Deps { pack(): Float32Array; same(a: Float32Array, b: Float32Array): boolean; publish(v: number): void }
            function createChannel(deps: Deps): Channel {
                let facts = new Float32Array(0);
                let version = 0;
                return {
                    sync(force = false): void {
                        const next = deps.pack();
                        if (!force && deps.same(next, facts)) return;
                        version++;
                        facts = next;
                        deps.publish(version);
                    },
                    facts: () => facts,
                    version: () => version,
                };
            }
            let published = 0;
            let n = 1;
            const source = () => createChannel({
                pack: () => new Float32Array(n),
                same: (a, b) => a.length === b.length,
                publish: (v) => { published += v; },
            });`;
        const { cpp } = compileSource(
            `${factory}
            function createChannels() {
                const amenity = source();
                return { amenity: { ...amenity, has: (id: number) => amenity.facts().length > id } };
            }
            const channel = createChannels().amenity;
            channel.sync(true);
            n = 3;
            channel.sync();
            const settled = () => channel.sync(true);
            settled();
            const seen = published + " " + channel.version() + " " + channel.has(2);
            if (seen !== "6 3 true") throw new Error("spread channel " + seen);
            `,
            { fileName: "spread-method-scope.ts" },
        );
        runGeneratedProgram(
            optionalNativeFixtureTools(false)!,
            "closure-captures-spread-method-scope",
            cpp,
        );
        // A copied method reading its own `this` runs on the copy, away from
        // the scope that declared it.
        assert.throws(
            () =>
                compileSource(`
                    function create(step: number) {
                        let total = 0;
                        return { add() { total += step; return this.read(); }, read: () => total };
                    }
                    function wrap() { return { ...create(2), extra: 1 }; }
                    localStorage.setItem("t", String(wrap().add()));
                `),
            /A spread copies method 'add', which reads `this`, out of the scope that declared it\./,
        );
    },
);
