import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { CompileError, compileSource } from "../src/compiler.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { assertCameraScalarWrite, labDeployment } from "./compiler-fixtures.js";

test("preserves reached box, ground, and sphere options", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createGround,
            createSphere,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const box = createBox(engine, {
                size: 2,
                width: 3,
            });
            const ground = createGround(engine, {
                width: 6,
                height: 7,
                subdivisions: 4,
                uvScale: [2, 3],
            });
            const sphere = createSphere(engine, {
                segments: 8,
                diameter: 2,
                diameterY: 4,
                diameterZ: 5,
            });
        }
    `);

    assert.match(result.cpp, /BoxOptions\{3\.0f, 2\.0f, 2\.0f\}/);
    assert.match(
        result.cpp,
        /GroundOptions\{6\.0, 7\.0, 4u, bbl::Vec2\{2\.0f, 3\.0f\}\}/,
    );
    assert.match(result.cpp, /SphereOptions\{8u, 2\.0, 4\.0, 5\.0\}/);
});

test("carries a handle annotation on a declaration the intrinsic produced", () => {
    // `const box: Mesh = createBox(...)` names the same engine value the
    // unannotated spelling does. Routing it to data storage instead loses
    // every mesh write the value path owns, starting with `box.material`.
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
        } from "@babylonjs/lite";
        import type { Mesh } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const box: Mesh = createBox(engine, 2);
            const mat = createStandardMaterial();
            mat.diffuseColor = [0.85, 0.32, 0.22];
            box.material = mat;
            box.position.x = -2.6;
            addToScene(scene, box);
        }
    `);

    assert.match(result.cpp, /bbl::create_box/);
    assert.match(
        result.cpp,
        /bbl::set_material_diffuse_color\([^;]+bbl::js::Array<double>\{/,
    );
    assert.match(result.cpp, /-2\.6/);
});

test("keeps a handle annotation on an object literal as a data record", () => {
    // The other half of the same rule, and the one a bare `handle` exemption
    // broke: freeciv and the platformer spell their atlas as an annotated
    // object LITERAL, which is a record the data lowerer materializes rather
    // than a value an intrinsic produced.
    const result = compileSource(`
        import {
            createEngine,
            createSprite2DLayer,
            createSpriteRenderer,
            createTexture2DFromPixels,
            registerSpriteRenderer,
            startEngine,
        } from "@babylonjs/lite";
        import type { SpriteAtlas } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const pixels = new Uint8Array(64 * 64 * 4).fill(255);
            const texture = createTexture2DFromPixels(engine, pixels, 64, 64, {
                minFilter: "linear",
                magFilter: "linear",
            });
            const atlas: SpriteAtlas = {
                texture,
                textureSizePx: [64, 64],
                frames: [
                    {
                        uvMin: [0, 0],
                        uvMax: [0.5, 0.5],
                        sourceSizePx: [32, 32],
                        pivot: [0.5, 0.5],
                    },
                ],
                premultipliedAlpha: false,
            };
            const layer = createSprite2DLayer(atlas, {
                capacity: 16,
                depth: "none",
            });
            const sr = createSpriteRenderer(engine, { layers: [layer] });
            registerSpriteRenderer(sr);
            await startEngine(engine);
        }
    `);

    assert.ok(result.manifest.features.includes("sprite:2d"));
    assert.ok(result.manifest.features.includes("texture:pixels"));
});

test("snapshots an Array wrapper when swapping JavaScript object bindings", () => {
    const result = compileSource(`
        let current: number[] = [];
        let next: number[] = [1, 2, 3];
        const tmp = current;
        current = next;
        next = tmp;
        next.length = 0;
        const selected = current[0];
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<double> v_tmp = bbl::js::snapshot_value\(v_current\);/,
    );
    assert.doesNotMatch(result.cpp, /bbl::js::Array<double>& v_tmp/);
    assert.match(result.cpp, /v_current = v_next;/);
    assert.match(result.cpp, /v_next = v_tmp;/);
    assert.match(result.cpp, /array_truncate\(v_next, 0\.0\)/);
});

test("a const names the result its call holds for the record's facts", () => {
    const { cpp } = compileSource(`
        interface Image { width: number; height: number; indices: Uint8Array }
        function decode(data: Uint8Array): Image {
            const indices = data.slice(0, 4);
            return { width: 2, height: 2, indices };
        }
        function area(image: Image): number {
            return image.width * image.height + image.indices.length;
        }
        function main(): void {
            const img = decode(new Uint8Array(8));
            img.indices[0] = img.width;
            console.log(area(img) + img.indices[0]!);
            let other = decode(new Uint8Array(4));
            console.log(area(other));
        }
        main();
    `);
    // The const is the object the holder holds, written through in place; a
    // `let` the program may rebind keeps its own copy.
    assert.match(
        cpp,
        /auto (v_bblite_function_result_\d+) = bblscene::decode\(bbl::js::u8_array_sized\(8\.0\)\);\s+\[\[maybe_unused\]\] bblscene::Image& v_img = \1;/,
    );
    assert.match(cpp, /array_store_checked\(v_img\.indices, 0\.0,/);
    assert.match(
        cpp,
        /auto (v_bblite_function_result_\d+) = bblscene::decode\(bbl::js::u8_array_sized\(4\.0\)\);\s+\[\[maybe_unused\]\] bblscene::Image v_other = \1;/,
    );
});

test("uses TypeChecker types for local function arguments", () => {
    assert.throws(
        () =>
            compileSource(
                `
                    import {
                        createEngine,
                    } from "@babylonjs/lite";
                    import {
                        configureScene,
                    } from "./fixtures/compiler-modules/index.js";

                    async function main() {
                        const engine = await createEngine({});
                        configureScene(engine);
                    }
                `,
                {
                    fileName: "test/compiler-multi-file-entry.ts",
                },
            ),
        /Argument 1 of 'configureScene' is EngineContext, not SceneContext/,
    );
});

test("emits plain-data user functions once as native functions", () => {
    const result = compileSource(`
        function doubled(value: number): number {
            const result = value * 2;
            return result;
        }
        const first = doubled(2);
        const second = doubled(3);
    `);

    assert.equal(
        result.cpp.match(/double doubled\(double v_fn0_value\) \{/g)?.length,
        1,
    );
    assert.match(result.cpp, /double v_first = bblscene::doubled\(2\.0\);/);
    assert.match(result.cpp, /double v_second = bblscene::doubled\(3\.0\);/);
    assert.match(result.cpp, /return v_fn0_result;/);
});

test("stabilizes stored record representation before native parameter emission", () => {
    const result = compileSource(`
        interface Archive {
            names: Map<string, number>;
            bytes: Uint8Array;
        }
        interface Holder { archive: Archive }

        function indexOf(archive: Archive, name: string): number {
            return archive.names.get(name) ?? -1;
        }
        function parse(seed: string | number): Archive {
            const names = new Map<string, number>();
            names.set(String(seed), 3);
            return {
                names,
                bytes: new Uint8Array(4),
            };
        }

        const archive = parse("START");
        const index = indexOf(archive, "START");
        const holder: Holder = { archive };
    `);

    assert.match(result.cpp, /using Archive = bbl::js::Ref<ArchiveData>;/);
    assert.match(
        result.cpp,
        /double indexOf\(const bblscene::Archive& v_fn\d+_archive, std::string v_fn\d+_name\)/,
    );
    assert.match(result.cpp, /v_fn\d+_archive->names\.get_owned\(/);
    assert.doesNotMatch(result.cpp, /v_fn\d+_archive\.names/);
});

test("borrows stable Ref parameters and snapshots rebindable call arguments", () => {
    const result = compileSource(`
        interface State {
            value: number;
        }
        function add(state: State, amount: number): number {
            state.value += amount;
            return state.value;
        }
        const stable: State = { value: 1 };
        const first = add(stable, 2);
        let current = stable;
        function replace(): number {
            current = { value: 10 };
            return 3;
        }
        const second = add(current, replace());
    `);

    assert.match(
        result.cpp,
        /double add\(const bblscene::State& v_fn\d+_state, double v_fn\d+_amount\)/,
    );
    assert.match(result.cpp, /bblscene::add\(v_stable, 2\.0\)/);
    assert.match(
        result.cpp,
        /auto (v_bblite_function_argument_\d+) = bbl::js::snapshot_value\(v_current\);\s+\[\[maybe_unused\]\] const double (v_bblite_shared_result_\d+) = bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_current\}, bblscene::\w+\)\(\);[\s\S]*bblscene::add\(\1, \2\)/,
    );
});

test("supports early returns in native data functions", () => {
    const result = compileSource(`
        function clamp01(value: number): number {
            if (value < 0) {
                return 0;
            }
            if (value > 1) {
                return 1;
            }
            return value;
        }
        const low = clamp01(-2);
        const high = clamp01(3);
    `);

    assert.equal(result.cpp.match(/return 0\.0;/g)?.length, 1);
    assert.match(result.cpp, /return 1\.0;/);
    assert.match(result.cpp, /return v_fn0_value;/);
});

test("emits qualifying class methods once as native functions", () => {
    const result = compileSource(`
        class Stack {
            private readonly heights: number[] = [];
            private total = 0;
            add(height: number, repeat = 2): void {
                for (let i = 0; i < repeat; i++) {
                    this.heights.push(height);
                    this.total += height;
                }
            }
        }
        const stack = new Stack();
        stack.add(1);
        stack.add(2, 1);
    `);

    // One definition over mutable field reference channels; the body
    // exists exactly once however many call sites there are.
    assert.match(
        result.cpp,
        /void Stack_add\(\[\[maybe_unused\]\] bbl::js::Array<double>& v_fn\d+_this_heights, \[\[maybe_unused\]\] double& v_fn\d+_this_total, double v_fn\d+_height, double v_fn\d+_repeat\) \{/,
    );
    assert.equal((result.cpp.match(/push_back/g) ?? []).length, 1);
    // Each call passes the instance's own field locals; the omitted
    // default is compiled at the call site.
    assert.match(
        result.cpp,
        /bblscene::Stack_add\(v_bblite_class_field_heights_\d+, \(\*v_bblite_class_field_total_\d+\), 1\.0, 2\.0\);/,
    );
    assert.match(
        result.cpp,
        /bblscene::Stack_add\(v_bblite_class_field_heights_\d+, \(\*v_bblite_class_field_total_\d+\), 2\.0, 1\.0\);/,
    );
});

test("native method field writes alias every reference to the instance", () => {
    const result = compileSource(`
        class Meter {
            level = 0;
            bump(amount: number): number {
                this.level += amount;
                return this.level;
            }
        }
        const meter = new Meter();
        const alias = meter;
        const first = meter.bump(2);
        const second = alias.bump(3);
        const total = first + second;
    `);

    // The mutation goes through the field reference channel once.
    assert.match(result.cpp, /v_fn\d+_this_level \+= v_fn\d+_amount;/);
    // Both references dispatch to the same emitted function and pass the
    // one field local, so each call observes the other's write.
    const calls = [
        ...result.cpp.matchAll(
            /bblscene::Meter_bump\(\(\*(v_bblite_class_field_level_\d+)\), /g,
        ),
    ];
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map((match) => match[1])).size, 1);
});

test("keeps structurally narrowed mutable arguments on the inline path", () => {
    // Doom's lift stepper: the parameter is a structural narrowing of the
    // caller's wider stored object, and the method writes through it. A
    // once-emitted function would have to materialize the narrow record
    // from the wide one — a copy — and the write would never reach the
    // caller's sector. Such calls must stay inline, where the parameter
    // aliases the caller's object by construction.
    const result = compileSource(`
        interface Sector { floorHeight: number; tag: number; }
        class Manager {
            private dirty = false;
            step(target: { floorHeight: number }): void {
                target.floorHeight -= 1;
                this.dirty = true;
            }
            consume(): boolean {
                const was = this.dirty;
                this.dirty = false;
                return was;
            }
        }
        const manager = new Manager();
        const sectors: Sector[] = [{ floorHeight: 8, tag: 1 }];
        manager.step(sectors[0]!);
        const moved = manager.consume() && sectors[0]!.floorHeight < 8;
    `);

    // The narrowing call did not become a namespace function, so no
    // narrow-record copy of the sector was materialized for it.
    assert.doesNotMatch(result.cpp, /bblscene::Manager_step\(/);
    // The write lands on the stored sector itself, through its reference.
    assert.match(result.cpp, /->floorHeight -= 1\.0;/);
    // The identity rule is per-call: the sibling method with exact-typed
    // arguments still qualifies for the once-emitted arm.
    assert.match(result.cpp, /bblscene::Manager_consume\(/);
});

test("keeps structurally narrowed free-function arguments inline", () => {
    // The free-function arm shares the sink conversion with the method
    // arm, so it declines the same way: a narrowing call falls back to
    // the function inliner, which aliases by construction.
    const result = compileSource(`
        interface Sector { floorHeight: number; tag: number; }
        function step(target: { floorHeight: number }): void {
            target.floorHeight -= 1;
        }
        const sectors: Sector[] = [{ floorHeight: 8, tag: 1 }];
        step(sectors[0]!);
        const moved = sectors[0]!.floorHeight < 8;
    `);

    assert.doesNotMatch(result.cpp, /bblscene::step\(/);
    assert.match(result.cpp, /->floorHeight -= 1\.0;/);
});

test("extracts methods whose stored-object arguments match exactly", () => {
    const result = compileSource(`
        interface Entry { amount: number; }
        class Registry {
            total = 0;
            absorb(entry: Entry): void {
                this.total += entry.amount;
            }
        }
        const registry = new Registry();
        const entries: Entry[] = [{ amount: 3 }, { amount: 4 }];
        registry.absorb(entries[0]!);
        registry.absorb(entries[1]!);
    `);

    // Same declared type on both sides: the shared pointer passes
    // through, identity is preserved, and the method is emitted once.
    assert.match(result.cpp, /bblscene::Registry_absorb\(/);
    assert.equal((result.cpp.match(/total \+= /g) ?? []).length, 1);
});

test("shares closures over entry locals", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            registerScene,
            startEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(1, 1, 5, { x: 0, y: 0, z: 0 });
            scene.camera = camera;
            const nudge = (): void => {
                camera.alpha = camera.alpha + 0.5;
            };
            nudge();
            nudge();
            await registerScene(scene);
            await startEngine(engine);
        }
    `);

    assert.doesNotMatch(result.cpp, /bblscene::nudge/);
    assert.equal(
        result.cpp.match(
            /write_camera_scalar\([^\n]+&bbl::CameraRecord::alpha,/g,
        )?.length,
        1,
    );
});

test("lowers '??' over the data model", () => {
    const result = compileSource(`
        interface Slot {
            fallback: number;
            current: number | null;
        }
        function pick(slot: Slot): number {
            return slot.current ?? slot.fallback;
        }
        const slot: Slot = { fallback: 4, current: null };
        const viaFunction = pick(slot);
        const atTopLevel = slot.current ?? 6;
        const identity = (atTopLevel ?? 987654) + viaFunction;
    `);
    // An optional left evaluates once into a temporary and selects
    // natively, with the fallback inside the ternary -- JavaScript's own
    // laziness.
    assert.match(
        result.cpp,
        /auto (v_bblite_nullish_\d+) = bbl::js::snapshot_value\(v_fn\d+_slot\.current\);\s*return \(\1\.has_value\(\) \? \(\*\1\) : v_fn\d+_slot\.fallback\);/,
    );
    // A left the model proves non-nullish IS the result: the dead right
    // side is discarded exactly as JavaScript never evaluates it.
    assert.doesNotMatch(result.cpp, /987654/);
});

test("'??' outside its lowerable routes refuses by name", () => {
    assert.throws(
        () =>
            compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const doubled =
                createArcRotateCamera(1, 1, 5, { x: 0, y: 0, z: 0 }) ??
                createArcRotateCamera(1, 1, 5, { x: 0, y: 0, z: 0 });
        }
        void main();
    `),
        /'\?\?' lowers over a static record property, an asset-derived handle collection, a handle a search produced, or a data-model value/,
    );
});

test("'??' reaches sinks and conditions through the same dispatch", () => {
    const result = compileSource(`
        interface Item {
            weight: number;
        }
        interface Bag {
            primary: Item | null;
            backup: Item;
        }
        function armed(flag: boolean): boolean | null {
            if (flag) {
                return true;
            }
            return null;
        }
        function pick(bag: Bag): number {
            const chosen: Item = bag.primary ?? bag.backup;
            return chosen.weight;
        }
        const bag: Bag = { primary: null, backup: { weight: 2 } };
        const weight = pick(bag);
        let count = 0;
        if (armed(false) ?? false) {
            count = count + 1;
        }
    `);
    // The sink arm serves the struct sink from the one select (string and
    // enum inners follow as soon as the model can produce a null of them);
    // the condition position routes the selected boolean.
    assert.match(
        result.cpp,
        /bblscene::Item v_fn\d+_chosen = \(static_cast<bool>\(v_fn\d+_bag\.primary\) \? v_fn\d+_bag\.primary : v_fn\d+_bag\.backup\);/,
    );
    assert.match(result.cpp, /double v_count = 0\.0;/);
    assert.doesNotMatch(result.cpp, /v_count = \(v_count \+ 1\.0\)/);
});

test("uses the value as well as presence for optional boolean truthiness", () => {
    const result = compileSource(`
        interface Options { receiverOnly: boolean; }
        function pool(options?: Options): number {
            return options?.receiverOnly ? 1 : 0;
        }
        const selected = pool({ receiverOnly: false });
    `);

    assert.match(result.cpp, /bbl::js::nullable_truthy\(/);
});

test("guards emitted right-hand work in logical conditions", () => {
    const result = compileSource(`
        import { dotVec3, type Vec3 } from "@babylonjs/lite";
        function countFlips(points: readonly Vec3[]): number {
            let previous: Vec3 | undefined;
            let flips = 0;
            for (const point of points) {
                if (previous && dotVec3(previous, point) < 0) {
                    flips++;
                }
                previous = point;
            }
            return flips;
        }
        const flips = countFlips([
            { x: 1, y: 0, z: 0 },
            { x: -1, y: 0, z: 0 },
        ]);
    `);

    assert.match(
        result.cpp,
        /\(\[&\]\(\) -> bool \{\s*if \(!\(static_cast<bool>\([^)]*previous[^)]*\)\)\) return false;[\s\S]*return [^;]* < 0\.0;\s*\}\(\)\)/,
    );
});

test("retains callback record owners across guarded expression scopes", async (t) => {
    const source = `
        import { createEngine } from "@babylonjs/lite";
        interface Handlers {
            go(): void;
            stop(): void;
        }
        function install(handlers: Handlers): void {
            const actions: Record<string, () => void> = {
                go: handlers.go,
                stop: handlers.stop,
            };
            window.addEventListener("keydown", (event) => {
                const action = event.code;
                if (action && actions[action]) {
                    actions[action]!();
                }
            });
        }
        async function main() {
            await createEngine({});
            let started = false;
            let calls = 0;
            const handlers: Handlers = {
                go: () => { started = true; calls++; },
                stop: () => { started = false; calls++; },
            };
            install(handlers);
            handlers.go = () => { throw new Error("replaced callback"); };
            window.addEventListener("keyup", (event) => {
                if (event.code !== (started ? "on:" : "off:") + calls)
                    throw new Error("guarded callback state");
                event.preventDefault();
            });
        }
    `;
    interface TestEvent {
        code: string;
        preventDefault(): void;
    }
    const listeners = new Map<string, Array<(event: TestEvent) => void>>();
    await runInNewContext(
        transpileCommonJs(`${source}\nmain();`, "guarded-callback-table.ts"),
        {
            exports: {},
            require(name: string) {
                assert.equal(name, "@babylonjs/lite");
                return { createEngine: async () => ({}) };
            },
            window: {
                addEventListener(
                    type: string,
                    callback: (event: TestEvent) => void,
                ) {
                    const entries = listeners.get(type) ?? [];
                    entries.push(callback);
                    listeners.set(type, entries);
                },
            },
        },
    );
    const steps = [
        ["", "off:0"],
        ["missing", "off:0"],
        ["go", "on:1"],
        ["missing", "on:1"],
        ["stop", "off:2"],
        ["go", "on:3"],
        ["go", "on:4"],
        ["stop", "off:5"],
        ["", "off:5"],
    ] as const;
    assert.equal(listeners.get("keydown")?.length, 1);
    assert.equal(listeners.get("keyup")?.length, 1);
    for (const [action, expected] of steps) {
        let prevented = false;
        for (const callback of listeners.get("keydown")!)
            callback({ code: action, preventDefault() {} });
        for (const callback of listeners.get("keyup")!)
            callback({
                code: expected,
                preventDefault() {
                    prevented = true;
                },
            });
        assert.equal(prevented, true);
    }

    const result = compileSource(source);
    const nativeTools = optionalNativeFixtureTools();
    if (!nativeTools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        nativeTools,
        "guarded-callback-table",
        `
#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace { std::shared_ptr<bbl::DomInput> registry_input; }
namespace bbl {
Engine create_engine(EngineOptions) {
    Engine engine;
    engine.dom_input = std::make_shared<DomInput>();
    registry_input = engine.dom_input;
    return engine;
}
}
int main() {
    assert(generated_main() == 0);
    assert(registry_input);
    const auto dispatch = [](const char* type, const char* code) {
        auto event = bbl::dom_event(bbl::PlatformKeyboardEvent{.code=code}, type,
            {bbl::DomEventTarget::window()});
        registry_input->keyboard.dispatch(event);
        return event.default_prevented;
    };
    ${steps.map(([action, expected]) => `dispatch("keydown", ${JSON.stringify(action)});\n    assert(dispatch("keyup", ${JSON.stringify(expected)}));`).join("\n    ")}
    registry_input.reset();
}
`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

test("self-referential struct callbacks capture the initialized binding", () => {
    const result = compileSource(`
        interface State {
            values: number[];
            read(): number;
        }
        function createState(): State {
            const state: State = {
                values: [4],
                read(): number {
                    return state.values[0]!;
                },
            };
            return state;
        }
        const states: State[] = [createState()];
        const value = states[0]!.read();
    `);

    // The literal allocates the object its binding names before the method
    // closure captures it, then stores its fields into that object.
    const declaration = result.cpp.match(
        /auto (v_fn\d+_state) = bbl::js::make_ref<bblscene::StateData>\(\);/,
    );
    assert.ok(declaration);
    const name = declaration[1]!;
    assert.match(result.cpp, new RegExp(`\\*${name} = bblscene::StateData\\{`));
    assert.match(result.cpp, new RegExp(`${name}->values`));
    assert.doesNotMatch(result.cpp, /make_gc_shared<bblscene::State>/);
});

test("lowers optional data property and element chains generically", () => {
    const result = compileSource(`
        type Trigger = "push" | "switch";
        interface Def {
            trigger: Trigger;
            speed: number;
        }
        function isSwitch(def: Def | undefined): boolean {
            return def?.trigger === "switch";
        }
        function speed(def: Def | undefined): number {
            return def?.speed ?? 0;
        }
        const rows: Def[] = [{ trigger: "push", speed: 2 }];
        let index = 1;
        const selected = rows[index]?.speed ?? speed(undefined);
        const matched = isSwitch(undefined);
    `);

    assert.match(
        result.cpp,
        /\[\[maybe_unused\]\] const bblscene::Def& (v_bblite_optional_chain_\d+) = v_fn\d+_def;\s*auto v_bblite_nullish_\d+ = \(static_cast<bool>\(\1\) \? bbl::js::Nullable<double>\{\1->speed\} : bbl::js::Nullable<double>\{std::nullopt\}\)/,
    );
    assert.match(result.cpp, /bool v_matched = false;/);
    assert.match(result.cpp, /#include <bblite\/js_data\.hpp>/);
    // The element read binds once; a missing index reads as the default
    // (empty) reference, so the chain tests the reference it bound.
    assert.match(
        result.cpp,
        /const bblscene::Def& (v_bblite_optional_chain_\d+) = bbl::js::array_at_or_default\([\s\S]{0,200}static_cast<bool>\(\1\)/,
    );
});

test("compares the value of an optional boolean from a dynamic record lookup", () => {
    const result = compileSource(`
        interface Def {
            active: boolean;
        }
        const defs: Record<number, Def> = {
            1: { active: false },
        };
        function active(id: number): boolean {
            return defs[id]?.active === true;
        }
        const missing = active(Math.floor(performance.now()) % 3);
    `);

    assert.match(
        result.cpp,
        /\[\[maybe_unused\]\] const bblscene::Def& (v_bblite_optional_chain_\d+) = .*\.get\([^;]+;\s*auto (\w+) = \(static_cast<bool>\(\1\) \? bbl::js::Nullable<bool>\{\1->active\} : bbl::js::Nullable<bool>\{std::nullopt\}\);\s*const auto& (v_bblite_optional_compare_\d+) = \2;\s*return \(\3\.has_value\(\) && \(\*\3\) == true\);/s,
    );
    assert.doesNotMatch(
        result.cpp,
        /Nullable<bool>[^;]*\.has_value\(\) == true/,
    );
});

test("lowers interface-typed structs, optionals, and enums", () => {
    const result = compileSource(`
        type Tag = "idle" | "busy";
        interface Item {
            weight: number;
            active: boolean;
        }
        interface Bucket {
            items: Item[];
            current: Item | null;
            tags: Tag[];
            total: number;
        }
        function makeBucket(): Bucket {
            return {
                items: [],
                current: null,
                tags: [],
                total: 0,
            };
        }
        function fill(bucket: Bucket): void {
            bucket.items.push({ weight: 2, active: true });
            bucket.current = { weight: 3, active: false };
            bucket.tags.push("busy");
            bucket.total += bucket.items.length;
            if (bucket.current !== null) {
                bucket.total += bucket.current.weight;
            }
            bucket.current = null;
        }
        const bucket = makeBucket();
        fill(bucket);
        const total = bucket.total;
    `);

    assert.match(result.cpp, /enum class Tag \{/);
    assert.match(result.cpp, /struct ItemData \{/);
    assert.match(result.cpp, /using Item = bbl::js::Ref<ItemData>;/);
    assert.match(result.cpp, /bblscene::Item current;/);
    assert.match(result.cpp, /bbl::js::Array<bblscene::Tag> tags;/);
    assert.match(
        result.cpp,
        /push_back\(bbl::js::make_ref<bblscene::ItemData>\(bblscene::ItemData\{2\.0, true\}\)\)/,
    );
    assert.match(result.cpp, /push_back\(bblscene::Tag::busy\)/);
    assert.match(result.cpp, /current = bblscene::Item\{\};/);
    assert.match(result.cpp, /v_fn\d+_bucket\.current->weight/);
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "plain-data-value-model",
        ),
    );
});

test("lowers dynamic arrays with fill, pop, truncation, and index writes", () => {
    const result = compileSource(`
        const board: number[] = new Array<number>(6).fill(0);
        board[2] = 5;
        const popped = board.pop()!;
        board.length = 3;
        const scratch: number[] = new Array(4);
        scratch[0] = board.length;
        let sum = 0;
        for (const value of board) {
            sum += value;
        }
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<double>\(static_cast<std::size_t>\(6\.0\), 0\.0\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::array_index_write\(v_board, bbl::js::array_index\(2\.0\)\) = 5\.0;/,
    );
    assert.match(
        result.cpp,
        /double v_popped = bbl::js::array_pop\(v_board\);/,
    );
    assert.match(result.cpp, /bbl::js::array_truncate\(v_board, 3\.0\);/);
    assert.match(
        result.cpp,
        /bbl::js::Array<double>\(static_cast<std::size_t>\(4\.0\)\)/,
    );
    assert.match(result.cpp, /const auto&? \w+ = v_board;/);
    assert.match(result.cpp, /for \(std::size_t/);
});

test("lowers nested Array.from length allocations", () => {
    const result = compileSource(`
        const grid: number[][] = Array.from(
            { length: 2 },
            () => Array.from({ length: 3 }, () => 7),
        );
        grid[1]![2] = 9;
    `);

    assert.match(
        result.cpp,
        /const std::size_t v_bblite_array_from_count_\d+ = bbl::js::array_from_length\(2\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<bbl::js::Array<double>> v_bblite_array_from_result_\d+;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Array<double> v_bblite_array_from_result_\d+;/,
    );
    assert.match(result.cpp, /return 7\.0;/);
    assert.match(result.cpp, /\.push_back\(v_bblite_shared_result_\d+\);/);
});

test("owns readonly arrays stored inside native records", () => {
    const result = compileSource(`
        interface Holder { readonly values: readonly number[]; }
        const holders: Holder[] = [{ values: [1, 2, 3] }];
        const value = holders[0]!.values[1];
    `);

    assert.match(result.cpp, /bbl::js::Array<double> values;/);
    assert.doesNotMatch(result.cpp, /Span<const double> values/);
});

test("stores homogeneous object tuples with JavaScript array identity", () => {
    const result = compileSource(`
        interface Point { x: number }
        const point: Point = { x: 1 };
        const edges: [Point, Point][][] = Array.from(
            { length: 2 },
            () => [],
        );
        edges[0]!.push([point, point]);
        edges[0]![0]![1]!.x = 4;
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<bbl::js::Array<bbl::js::Array<bblscene::Point>>>/,
    );
    assert.match(result.cpp, /\.push_back\(bbl::js::Array<bblscene::Point>\{/);
});

test("marks object tuple elements as references before emitting their users", () => {
    const result = compileSource(`
        interface Point { x: number }
        const points: [Point, Point] = [
            { x: Math.random() },
            { x: Math.random() },
        ];
        const index = Math.floor(Math.random() * 2);
        const selected = points[index]!;
        const x = selected.x;
        const later: Point[] = [];
        later.push({ x: 3 });
    `);

    assert.match(result.cpp, /using Point = bbl::js::Ref<PointData>;/);
    assert.match(result.cpp, /v_selected->x/);
    const first =
        /auto (\w+) = bbl::js::make_ref<bblscene::PointData>\(bblscene::PointData\{bbl::js::random_js\(\)\}\);/.exec(
            result.cpp,
        );
    assert.ok(first);
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::js::Array<bblscene::Point>\\{${first[1]}, bbl::js::make_ref<bblscene::PointData>`,
        ),
    );
});

test("keeps canonical length-bound loop indices raw and checks the rest", () => {
    const result = compileSource(`
        const seed: number[] = [1, 2, 3, 4, 5];
        const values = seed.filter((value) => value > 1);
        let total = 0;
        for (let i = 0; i < values.length; i++) {
            const value = values[i]!;
            total += value;
        }
        for (let j = 0; j < values.length; j += 2) {
            const value = values[j]!;
            total += value;
        }
        for (let k = 0; k < values.length; k++) {
            const value = values[k]!;
            total += value;
            if (total > 90) {
                values.pop();
            }
        }
        for (let q = 0; q < values.length; q++) {
            const raw = values[q]!;
            const value = Math.abs(raw);
            total += value;
        }
        console.log(total);
    `);

    // The canonical loops (plain and with a pure Math call) keep the
    // raw fast path over their own induction variable.
    const rawReads =
        result.cpp.match(/v_values\[static_cast<std::size_t>\(v_\w+\)\]/g) ??
        [];
    assert.equal(rawReads.length, 2);
    // The stride loop's condition no longer proves the read, and the
    // pop() in the third loop's body could shrink the array mid-walk,
    // so both read through the located checked accessor.
    const checkedReads =
        result.cpp.match(
            /bbl::js::array_index_checked\(v_values, static_cast<double>\(v_\w+\), "[^"]+:\d+:\d+"\)/g,
        ) ?? [];
    assert.equal(checkedReads.length, 2);
});

test("splits array writes between growth-proven and checked arms", () => {
    const result = compileSource(`
        const seed: number[] = [2, 4, 6];
        const values = seed.filter((value) => value > 2);
        let total = 0;
        for (let i = 0; i < values.length; i++) {
            values[i] = total;
            total += 1;
        }
        for (let j = 0; j < values.length; j += 2) {
            values[j] = 1;
        }
        console.log(values.length);
    `);

    // A canonical-loop index writes raw; JavaScript growth semantics
    // are untouched either way.
    assert.match(
        result.cpp,
        /bbl::js::array_index_write\(v_values, static_cast<std::size_t>\(v_\w+\)\) = /,
    );
    // The unproven stride index writes through the checked grower.
    assert.match(
        result.cpp,
        /bbl::js::array_index_write_checked\(v_values, static_cast<double>\(v_\w+\), "[^"]+:\d+:\d+"\) = /,
    );
});

test("emits a checked read for a dead-guarded static out-of-bounds index", () => {
    // scene20's parent-chain shape keeps chain[-1] behind a runtime guard.
    // That index must
    // compile (never a generation refusal) and must refuse by name only
    // if the guard ever let it run.
    const result = compileSource(`
        const chain: number[] = [10, 20, 30];
        let level = 0;
        let acc = 0;
        for (let s = 0; s < 3; s++) {
            if (level !== 0) {
                const previous = chain[s - 1]!;
                acc += previous;
            }
            level++;
        }
        console.log(acc);
    `);

    assert.match(
        result.cpp,
        /bbl::js::array_index_checked\([^,]+, \(static_cast<double>\(v_\w+_s\) - 1\.0\), "[^"]+:\d+:\d+"\)/,
    );
});

test("proves const typed-array lengths for static stores and checks runtime ones", () => {
    const result = compileSource(`
        const seed: number[] = [1, 2, 3];
        const values = seed.filter((value) => value > 0);
        const lane = new Float32Array(4);
        lane[3] = 0.5;
        let w = 0;
        for (const value of values) {
            lane[w] = value;
            w++;
        }
        let spare = new Float32Array(4);
        function regrow(): number {
            spare = new Float32Array(8);
            return 2;
        }
        spare[1] = regrow();
        console.log(lane.length, spare.length);
    `);

    // The const binding of a fixed-size construction proves the static
    // store in bounds, so the slot skips the dynamic bounds check; a value
    // that runs no store cannot release the named owner, so the slot
    // borrows it.
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::typed_array_borrowed_slot\(v_lane, bbl::js::array_index\(3\.0\)\);\s+\1 = static_cast<float>\(0\.5\);/,
    );
    // The counter-driven store cannot be proven and is checked.
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::array_store_borrowed\(v_lane, v_w, "[^"]+:\d+:\d+"\);\s+\1 = /,
    );
    // A value that rebinds the array keeps the evaluated view alive.
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::array_store_checked\(v_spare, 1\.0, "[^"]+:\d+:\d+"\);[\s\S]*?\1 = /,
    );
});

test("snapshots a returned value the next call in the same expression moves", () => {
    // Scene 179's `seededRandom` shape: the returned arrow advances the state
    // it closes over and returns an expression READING that state, so three
    // draws in one argument list must not all read the final value.
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        function seededRandom(seed: number): () => number {
            let s = seed >>> 0;
            return () => {
                s = (1664525 * s + 1013904223) >>> 0;
                return s / 0x100000000;
            };
        }

        async function main() {
            const engine = await createEngine({});
            const rnd = seededRandom(7);
            const box = createBox(engine);
            box.position.set(rnd(), rnd(), rnd());
        }
    `);

    const snapshots = [
        ...result.cpp.matchAll(
            /const double (v_bblite_shared_result_\d+) = bbl::js::make_closure\([^\n]+\)\(\);/g,
        ),
    ].map(([, name]) => name);
    assert.equal(snapshots.length, 3);
    assert.equal(new Set(snapshots).size, 3);
    assert.match(
        result.cpp,
        new RegExp(
            `position = bbl::Vec3d\\{${snapshots[0]!}, ${snapshots[1]!}, ${snapshots[2]!}\\}`,
        ),
    );
});

test("leaves a returned value its own locals already snapshot", () => {
    // The corpus's other PRNG: mulberry32 advances `a` but returns an
    // expression over `t`, a local the inline frame allocates per call, so the
    // splice is already safe and no temporary is introduced.
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        function mulberry32(seed: number): () => number {
            let a = seed >>> 0;
            return () => {
                a = (a + 0x6d2b79f5) | 0;
                let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        async function main() {
            const engine = await createEngine({});
            const rand = mulberry32(1337);
            const box = createBox(engine);
            box.position.set(rand(), rand(), rand());
        }
    `);

    assert.doesNotMatch(result.cpp, /v_bblite_return_/);
});

test("rebinds a vector from a helper proven to return a fresh array", () => {
    const result = compileSource(`
        function clipped(input: number[]): number[] {
            const out: number[] = [];
            if (input.length === 0) return out;
            out.push(input[0]!);
            return out;
        }
        let poly: number[] = [1, 2, 3];
        poly = clipped(poly);
    `);

    assert.match(result.cpp, /v_poly = bblscene::clipped\(v_poly\);/);
});

test("folds string-literal comparisons in specialized callbacks", () => {
    const result = compileSource(`
        const classify = (kind: "coin" | "flower"): number =>
            kind === "flower" ? 1 : 0;
        const coin = classify("coin");
        const flower = classify("flower");
    `);

    assert.doesNotMatch(
        result.cpp,
        /std::string\("(?:coin|flower)"\) == std::string\("flower"\)/,
    );
    assert.match(result.cpp, /return 0\.0;/);
    assert.match(result.cpp, /return 1\.0;/);
});

test("writes nested mutable record fields through native lvalues", () => {
    const result = compileSource(`
        interface Box { x: number; y: number }
        interface Actor { box: Box; speed: number }
        const actor: Actor = {
            box: { x: 0, y: 70 * 2.8 },
            speed: 1,
        };
        actor.box.x = 4;
        actor.box.y += 2;
    `);

    assert.match(result.cpp, /v_actor->box->x = 4\.0;/);
    assert.match(result.cpp, /v_actor->box->y \+= 2\.0;/);
    assert.doesNotMatch(result.cpp, /0\.0 =|70\.0 \* 2\.8\) \+=/);
});

test("retains static facts for readonly reference-record fields", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";
        interface Config {
            readonly enabled?: boolean;
        }
        const engine = await createEngine({});
        const config: Config = { enabled: false };
        if (config.enabled ?? true) createBox(engine);
    `);

    assert.doesNotMatch(result.cpp, /bbl::create_box/);
    assert.ok(!result.manifest.features.includes("mesh:box"));
});

test("reads live moving-sector heights for collision", () => {
    const result = compileSource(`
        interface Sector {
            floorHeight: number;
            ceilHeight: number;
        }
        function blocksStep(
            sectors: Sector[],
            currentFloor: number,
        ): boolean {
            const front = sectors[0]!;
            const back = sectors[1]!;
            const openBottom = Math.max(
                front.floorHeight,
                back.floorHeight,
            );
            return openBottom - currentFloor > 24;
        }
        const sectors: Sector[] = [
            { floorHeight: -128, ceilHeight: 128 },
            { floorHeight: -124, ceilHeight: 128 },
        ];
        sectors[1]!.floorHeight = 12;
        const blocked = blocksStep(sectors, -128);
    `);

    assert.match(result.cpp, /->floorHeight = 12\.0/);
    assert.match(
        result.cpp,
        /bbl::js::math_extreme<true>\(\{v_fn\d+_front->floorHeight, v_fn\d+_back->floorHeight\}\)/,
    );
    assert.doesNotMatch(result.cpp, /std::max\(-128\.0, -124\.0\)/);
});

test("selects a fallback for nullable reference records by presence", () => {
    const result = compileSource(`
        interface Cell { x: number; y: number }
        function finish(entries: Record<string, Cell>): Cell {
            return entries.start ?? { x: 3, y: 11 };
        }
        const cell = finish({ start: { x: 2, y: 9 } });
    `);

    assert.match(result.cpp, /auto .*nullish.* = .*\.get_owned\("start"\);/);
    assert.match(result.cpp, /nullish.* \? .*nullish.* : /);
    assert.doesNotMatch(result.cpp, /static_cast<bool>\(\(\*/);
});

test("keeps returned callbacks as compile-time bindings", () => {
    const result = compileSource(`
        const makeAdder = (amount: number) => (value: number): number =>
            value + amount;
        const addTwo = makeAdder(2);
        const total = addTwo(3);
    `);

    assert.doesNotMatch(result.cpp, /auto v_addTwo =\s*;/);
    assert.match(result.cpp, /return \(v_fn\d+_value \+ 2\.0\);/);
    assert.match(result.cpp, /make_closure\([^\n]+\)\(3\.0\)/);
});

test("coerces missing partial Record numbers to NaN in arithmetic", () => {
    const result = compileSource(`
        type Kind = "a" | "b";
        interface Item { kind: Kind }
        const foot: Partial<Record<Kind, number>> = { a: 0.5 };
        const items: Item[] = [{ kind: "a" }, { kind: "b" }];
        let total = 0;
        for (const item of items) {
            total += 1 - foot[item.kind];
        }
    `);

    assert.match(result.cpp, /bbl::js::Nullable<double>/);
    assert.match(result.cpp, /bbl::js::number_from_optional/);
});

test("retains lexical constant-expression tuple arrays for runtime break", () => {
    const result = compileSource(`
        const TILE = 70;
        function launch(): number {
            const shots: readonly [number, number][] = [
                [-TILE * 2, -TILE * 7.5],
                [TILE * 2, -TILE * 7.5],
            ];
            let total = 0;
            for (const [vx, vy] of shots) {
                total += vy;
                if (vx > 0) break;
            }
            return total;
        }
        const total = launch();
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<bbl::js::Tuple<2>> v_fn\d+_shots = bbl::js::Array<bbl::js::Tuple<2>>/,
    );
    const range = /const auto&? (\w+) = v_fn\d+_shots;/.exec(result.cpp);
    assert.ok(range);
    const iteration = new RegExp(
        `for \\(std::size_t (\\w+) = 0; \\1 < ${range[1]}\\.size\\(\\); \\+\\+\\1\\) \\{\\s+\\[\\[maybe_unused\\]\\] const auto& (\\w+) = ${range[1]}\\[\\1\\];`,
    ).exec(result.cpp);
    assert.ok(iteration);
    // The pattern binds its lanes from the item in place, as a declaration does.
    const lane = new RegExp(`double (\\w+_vx) = ${iteration[2]}\\[0\\];`).exec(
        result.cpp,
    );
    assert.ok(lane);
    assert.match(
        result.cpp,
        new RegExp(`if \\(${lane[1]} > 0\\.0\\) \\{\\s+break;`),
    );
});

test("returns the value of chained numeric field assignments", () => {
    const result = compileSource(`
        interface Box { w: number; h: number }
        const box: Box = { w: 1, h: 1 };
        box.w = box.h = 42;
    `);

    assert.match(result.cpp, /->w = \(v_box->h = 42\.0\);/);
});

test("returns the value of chained scalar-local assignments", () => {
    const result = compileSource(`
        let x = 1;
        let y = 2;
        let z = 3;
        x = y = z = 0;
    `);

    assert.match(result.cpp, /v_x = \(v_y = \(v_z = 0\.0\)\);/);
});

test("spreads a native partial struct into a wider struct", () => {
    const result = compileSource(`
        interface Options {
            label?: string;
            enabled?: boolean;
        }
        interface Item {
            id: number;
            label?: string;
            enabled?: boolean;
        }
        const options: Options = { label: "ready" };
        const item: Item = { id: 3, ...options };
        options.enabled = item.label !== undefined;
    `);

    // Nothing reads a copied key's presence, so an own undefined needs no
    // document: the wider record stays native and copies present fields.
    // The program stores only a boolean read off `item`, so `item` holds its
    // fields in place.
    assert.match(result.cpp, /bblscene::Item v_item\{\};/);
    for (const key of ["label", "enabled"])
        assert.match(
            result.cpp,
            new RegExp(
                String.raw`if \(v_options->${key}\.has_value\(\)\) \{\s*v_item\.${key} = \(\*v_options->${key}\);`,
            ),
        );
    // `label` is never written, so the copy's presence is known statically.
    assert.ok(
        result.cpp.includes(
            "v_options->enabled = bbl::js::Nullable<bool>{true};",
        ),
    );

    // Reading a copied key's presence: with no own undefined ever written,
    // the copied slot's presence is the key's; an own undefined makes the
    // source a document, which records that the key is there.
    const observed = compileSource(`
        interface Options {
            label?: string;
            enabled?: boolean;
        }
        interface Item {
            id: number;
            label?: string;
            enabled?: boolean;
        }
        const options: Options = { label: "ready" };
        const item: Item = { id: 3, ...options };
        options.enabled = "label" in item;
    `);
    assert.ok(
        observed.cpp.includes(
            "v_options->enabled = bbl::js::Nullable<bool>{v_item->label.has_value()};",
        ),
    );
    const ownUndefined = compileSource(`
        interface Options { label?: string; enabled?: boolean }
        interface Item { id: number; label?: string; enabled?: boolean }
        const options: Options = { label: undefined };
        const item: Item = { id: 3, ...options };
        options.enabled = "label" in item;
    `);
    assert.match(ownUndefined.cpp, /bbl::js::JsonValue v_options =/);
    assert.ok(
        ownUndefined.cpp.includes(
            'v_options.set("enabled", bbl::js::json_value(true));',
        ),
    );
});

test("lowers array callbacks through one native iteration protocol", () => {
    const result = compileSource(`
        const values: number[] = [1, 2, 3];
        const found = values.find((value, index, owner) => value === owner[index]);
        const filtered = values.filter((value) => value > 1);
        const present = values.some((value) => value === 2);
        const mapped = values.map((value) => value * 2);
        let total = 0;
        values.forEach((value) => { total += value; });
    `);

    for (const label of [
        "find_source",
        "filter_source",
        "some_source",
        "map_source",
        "for_each_source",
    ]) {
        assert.match(result.cpp, new RegExp(`v_bblite_${label}_\\d+`));
    }
    assert.match(
        result.cpp,
        /v_bblite_find_result_\d+ = v_bblite_find_source_\d+\[/,
    );
    assert.match(result.cpp, /v_bblite_filter_result_\d+\.push_back/);
    assert.match(result.cpp, /v_bblite_some_result_\d+ = true/);
    assert.match(result.cpp, /v_bblite_map_result_\d+\.push_back/);
    assert.match(result.cpp, /const std::size_t v_bblite_for_each_count_\d+/);
});

test("unrolls some over a readonly tuple table", () => {
    const result = compileSource(`
        const ranges: ReadonlyArray<readonly [number, number]> = [
            [1, 3],
            [8, 10],
        ];
        function contains(value: number): boolean {
            return ranges.some(([first, last]) =>
                value >= first && value <= last,
            );
        }
        let value = 9;
        const found = contains(value);
    `);

    assert.match(
        result.cpp,
        /return .*v_fn\d+_first.*v_fn\d+_last.*\|\|.*v_fn\d+_first.*v_fn\d+_last/s,
    );
});

test("unrolls destructured forEach blocks over readonly tuple tables", () => {
    const result = compileSource(`
        const ranges: ReadonlyArray<readonly [number, number]> = [
            [1, 3],
            [8, 10],
        ];
        const widths: number[] = [];
        ranges.forEach(([first, last], index) => {
            if (index === 0) widths.push(last - first);
        });
    `);

    assert.equal(result.cpp.match(/v_widths\.push_back/g)?.length, 1);
});

test("writes a tuple lane at its sink's own width", () => {
    // A lane is stored and read back by a sink it cannot see, so the width
    // belongs to the sink: `position.set` is a double record field, and a
    // lane frozen at the default float width would round it a step early —
    // half a unit at the large-world coordinates scene 206 writes.
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createSceneContext,
            registerScene,
            startEngine,
        } from "babylon-lite";

        const OFFSET = 5_000_000;

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const place = (at: [number, number, number]): void => {
                const box = createBox(engine, 1);
                box.position.set(at[0], at[1], at[2]);
            };
            place([OFFSET, 0.65, OFFSET + 2.45]);
            await registerScene(scene);
            await startEngine(engine);
        }
        void main();
    `);

    assert.match(
        result.cpp,
        /bbl::js::Tuple<3>\{5000000\.0, 0\.65, 5000002\.45\};/,
    );
    assert.match(result.cpp, /position = bbl::Vec3d\{[^;]+\};/);
});

test("leaves an ordinary numeric expression unfolded", () => {
    // The boundary `laneValue` draws. `staticNumber` is also what a
    // condition reads to fold, and an unrolled loop's index carries one, so
    // recording the fold on every number Value would additionally collapse
    // conditions over that index — a different change with its own
    // measurement. A lane's width is undecided; this one's is not.
    const result = compileSource(`
        const SIZE = 4;
        let total = 0;
        for (let i = 0; i < 3; i++) {
            total += SIZE * 2 + i;
        }
    `);

    assert.match(result.cpp, /\(4\.0 \* 2\.0\)/);
});

test("retains tuple array storage through fixed and runtime indices", () => {
    const result = compileSource(`
        const WEIGHTS: readonly (readonly [number, number])[] = [
            [1, 2],
            [3, 4],
            [5, 6],
        ];
        const staticRead = WEIGHTS[1][0];
        function pick(index: number): number {
            return WEIGHTS[index]![1];
        }
        let total = pick(2);
        for (const [left, right] of WEIGHTS) {
            total += left + right;
        }
    `);

    assert.match(
        result.cpp,
        /bbl::js::Array<bbl::js::Tuple<2>> v_WEIGHTS = bbl::js::Array<bbl::js::Tuple<2>>\{bbl::js::Tuple<2>\{1\.0, 2\.0\}, bbl::js::Tuple<2>\{3\.0, 4\.0\}, bbl::js::Tuple<2>\{5\.0, 6\.0\}\};/,
    );
    // Identity-bearing tuple rows share lexical storage even at fixed indices.
    assert.match(
        result.cpp,
        /double v_staticRead = bbl::js::array_index_checked\(v_WEIGHTS, 1\.0, "[^"]+"\)\[bbl::js::array_index\(0\.0\)\];/,
    );
    // The runtime row index is checked; the static in-range lane index
    // keeps the raw fast path.
    assert.match(
        result.cpp,
        /bbl::js::array_index_checked\(v_WEIGHTS, v_fn\d+_index, "[^"]+"\)\[bbl::js::array_index\(1\.0\)\]/,
    );
    assert.match(
        result.cpp,
        /double (v_block\d+_left) = (v_bblite_item_\d+)\[0\];\s+\[\[maybe_unused\]\] double (v_block\d+_right) = \2\[1\];\s+v_total \+= \(\1 \+ \3\);/,
    );
});

test("lowers a class instance into per-field bindings", () => {
    const result = compileSource(`
        class Stack {
            private readonly heights: number[] = [];
            private total = 0;
            add(height: number, repeat = 2): void {
                for (let i = 0; i < repeat; i++) {
                    this.heights.push(height);
                    this.total += height;
                }
            }
        }
        const stack = new Stack();
        stack.add(1);
        stack.add(2, 1);
    `);

    // No runtime object survives: fields are locals; the qualifying
    // method emits once over field reference channels.
    assert.match(result.cpp, /bbl::js::Array<double> v_\w*heights/);
    assert.match(
        result.cpp,
        /auto v_bblite_class_field_total_\d+ = bbl::js::make_gc_shared<double>\(0\.0\)/,
    );
    assert.doesNotMatch(result.cpp, /struct Stack/);
    // One emitted loop body; the default and explicit repeat values are
    // compiled at their call sites as ordinary arguments.
    assert.match(
        result.cpp,
        /bblscene::Stack_add\(v_bblite_class_field_heights_\d+, \(\*v_bblite_class_field_total_\d+\), 1\.0, 2\.0\);/,
    );
    assert.match(
        result.cpp,
        /bblscene::Stack_add\(v_bblite_class_field_heights_\d+, \(\*v_bblite_class_field_total_\d+\), 2\.0, 1\.0\);/,
    );
    assert.equal((result.cpp.match(/push_back/g) ?? []).length, 1);
});

test("evaluates constructor arguments with the caller's this", () => {
    const result = compileSource(`
        class Parent {
            private value = 7;
            readonly child: Child;

            get current(): number {
                return this.value;
            }

            constructor() {
                this.child = new Child(this);
            }
        }

        class Child {
            private readonly parent: Parent;

            constructor(parent: Parent) {
                this.parent = parent;
            }

            read(): number {
                return this.parent.current;
            }
        }

        const parent = new Parent();
        const selected = parent.child.read();
    `);

    assert.match(
        result.cpp,
        /return \(\*v_bblite_class_field_value_\d+\);[\s\S]*double v_selected = bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_bblite_class_field_value_\d+\}, bblscene::bbl_recursive_fn\d+_group\)\(\);/,
    );
});

test("calls a class method on a record returned by a helper", () => {
    const result = compileSource(`
        class Batch {
            values: number[] = [];
            add(amount: number): void {
                this.values.push(amount);
            }
        }

        const left = new Batch();
        const right = new Batch();
        const select = (useRight: boolean): Batch =>
            useRight ? right : left;
        const dynamic = Math.random() > 0.5;
        select(dynamic).add(3);
    `);

    assert.equal(
        (result.cpp.match(/bool v_fn\d+_useRight =/g) ?? []).length,
        1,
        "probing a data method must not evaluate the selected batch twice",
    );
    const selected = result.cpp.match(
        /auto (v_bblite_return_select_values_\d+) = bbl::js::make_gc_shared<bbl::js::Array<double>>\(\(v_fn\d+_useRight \? \(\*v_bblite_class_field_values_\d+\) : \(\*v_bblite_class_field_values_\d+\)\)\);/,
    );
    assert.ok(selected);
    assert.match(
        result.cpp,
        new RegExp(
            `auto (v_bblite_array_receiver_\\d+) = bbl::js::snapshot_value\\(\\(\\*${selected[1]}\\)\\);[\\s\\S]*\\1\\.push_back\\(v_fn\\d+_amount\\)`,
        ),
    );
});

test("keeps immediate class callback parameters compile-time", () => {
    const result = compileSource(`
        class Walker {
            visit(callback: (value: number) => number): number {
                let total = 0;
                for (let i = 0; i < 4; i++) total += callback(i);
                return total;
            }
        }
        const values = new Uint8Array([1, 2, 3, 4]);
        const read = (index: number): number => values[index]!;
        const walker = new Walker();
        const total = walker.visit(read);
    `);

    assert.doesNotMatch(result.cpp, /std::function|bbl::js::Callback/);
    assert.equal(
        (result.cpp.match(/array_index_checked\(v_values,/g) ?? []).length,
        1,
    );
});

test("wires an optional class callback through a later property assignment", () => {
    const result = compileSource(`
        class Queue {
            onBuilt?: (x: number) => void;
            run(): void {
                this.onBuilt?.(3);
            }
        }

        function keep(value: number): void {
            console.log(value);
        }

        const queue = new Queue();
        queue.onBuilt = (value) => keep(value);
        queue.run();
    `);

    assert.match(result.cpp, /3\.0/);
});

test("calls a stored class callback field after a source truthiness guard", () => {
    const result = compileSource(`
        class Filter {
            predicate: ((value: number) => boolean) | null = null;
            accepts(value: number): boolean {
                return !this.predicate || this.predicate(value);
            }
        }
        const filter = new Filter();
        const accepted = filter.accepts(3);
    `);

    assert.match(result.cpp, /bbl::js::Callback<bool\(double\)>/);
    assert.match(
        result.cpp,
        /if \(!\(static_cast<bool>\(\(\*(v_bblite_class_field_predicate_\d+)\)\)\)\) return true;\s*const auto (\w+) = bbl::js::snapshot_callback\(\(\*\1\)\);\s*return \2\([^)]+\);/,
    );
});

test("guards optional class method calls before evaluating their body", () => {
    const result = compileSource(`
        class Target {
            private count = 0;
            private _destroyed = false;
            get destroyed(): boolean {
                return this._destroyed;
            }
            detach(): void {
                this.count += 1;
            }
        }
        class Owner {
            private readonly targets: Target[] = [];
            target: Target | null = null;
            constructor() {
                const target = new Target();
                this.targets.push(target);
                this.target = target;
            }
            clear(): void {
                if (Math.random() > 0.5) {
                    this.target = null;
                }
                if (this.target?.destroyed) {
                    this.target = null;
                }
                this.target?.detach();
            }
        }
        const owner = new Owner();
        owner.clear();
    `);

    assert.match(
        result.cpp,
        /if \(static_cast<bool>\(\(\*v_bblite_class_field_target_\d+\)\)\) \{\s*bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_bblite_target_receiver_\d+\}, bblscene::bbl_recursive_fn\d+_group\)\(\);/,
    );
    assert.match(
        result.cpp,
        /static_cast<bool>\(v_bblite_optional_chain_\d+\) \? bbl::js::Nullable<bool>\{v_bblite_optional_chain_\d+->_destroyed\}/,
    );
    assert.doesNotMatch(result.cpp, /if \(v_[A-Za-z0-9_]+->_destroyed\)/);
});

test("initializes constructor parameter-properties before the body", () => {
    const result = compileSource(`
        class Accumulator {
            private total = 0;
            constructor(private readonly scale: number) {
                this.initialize(scale);
            }
            private initialize(value: number): void {
                this.total = value;
            }
            add(value: number): void {
                this.total += value * this.scale;
            }
        }
        const accumulator = new Accumulator(2);
        accumulator.add(3);
    `);

    assert.match(result.cpp, /double v_fn\d+_scale = 2\.0/);
    // initialize touches only the plain total field, so it emits once
    // and writes through its reference channel.
    assert.match(result.cpp, /v_fn\d+_this_total = v_fn\d+_value/);
    // add reads the scale parameter property, which stays on the inline
    // path, so its compound write still targets the field local.
    assert.match(
        result.cpp,
        /\(\*v_bblite_class_field_total_\d+\) \+= \(v_fn\d+_value \* v_fn\d+_scale\)/,
    );
});

test("iterates data nested inside a class record field", () => {
    const result = compileSource(`
        interface Entry { enabled: boolean; }
        interface Catalog { entries: Entry[]; }
        class Counter {
            private readonly catalog: Catalog;
            private total = 0;
            constructor(catalog: Catalog) {
                this.catalog = catalog;
                this.scan();
            }
            private scan(): void {
                for (const entry of this.catalog.entries) {
                    if (!entry.enabled) continue;
                    this.total += 1;
                }
            }
        }
        const entries: Entry[] = [
            { enabled: false },
            { enabled: true },
        ];
        const counter = new Counter({ entries });
    `);

    assert.match(result.cpp, /for \(std::size_t/);
    assert.match(result.cpp, /continue;/);
});

test("guards a missing open Record key before dereferencing its local", () => {
    const result = compileSource(`
        const weapons: Record<string, number> = { Digit1: 1, Digit2: 2 };
        function select(code: string): number {
            const weapon = weapons[code];
            if (weapon !== undefined) return weapon;
            return -1;
        }
        let code = "ArrowUp";
        const selected = select(code);
    `);

    const lookup = result.cpp.match(
        /bbl::js::Nullable<double> (v_\w*weapon) = .*\.get_owned\(.*\);/,
    );
    assert.ok(lookup);
    const local = lookup[1]!;
    const guard = result.cpp.indexOf(`${local}.has_value()`);
    const dereference = result.cpp.search(
        new RegExp(
            `\\(\\*${local}\\)|bbl::js::number_from_optional\\(${local}\\)`,
        ),
    );
    assert.ok(guard >= 0, "the undefined guard tests the stored lookup");
    assert.ok(
        dereference > guard,
        "the lookup is not dereferenced until after its guard",
    );
    assert.doesNotMatch(result.cpp, /double& v_\w*weapon = \*[^;]+\.get\(/);
});

test("inserts runtime keys through a named open Record alias", () => {
    const result = compileSource(`
        type Values = Record<string, string>;
        function insert(key: string, value: string): Values {
            const entries: Values = {};
            entries[key] = value;
            return entries;
        }
        const entries = insert("name", "value");
        const missing = Number(entries["missing"]) || 0;
    `);

    assert.match(result.cpp, /bbl::js::Dictionary<std::string, std::string>/);
    assert.match(
        result.cpp,
        /v_fn\d+_entries\.set\(v_fn\d+_key, v_fn\d+_value\);/,
    );
    assert.match(result.cpp, /std::numeric_limits<double>::quiet_NaN\(\)/);
});

test("stores runtime indexed-string keys and values in an open Record", () => {
    const result = compileSource(`
        function pair(text: string): Record<string, string> {
            const entries: Record<string, string> = {};
            let index = 0;
            entries[text[index]] = text[index + 1];
            return entries;
        }
        const entries = pair("ab");
    `);

    assert.match(
        result.cpp,
        /\.set\(bbl::js::snapshot_value\(\(\*bbl::js::string_index\([^\r\n]+, bbl::js::snapshot_value\(\(\*bbl::js::string_index\([^\r\n]+\)\);/,
    );
});

test("preserves object identity through a dynamic Record lookup", () => {
    const result = compileSource(`
        interface Entry { value: number; }
        const entries: Record<string, Entry> = {
            one: { value: 1 },
        };
        function mutate(code: string): void {
            const entry = entries[code];
            if (entry !== undefined) entry.value++;
        }
        let code = "missing";
        mutate(code);
    `);

    assert.match(result.cpp, /using Entry = bbl::js::Ref<EntryData>;/);
    assert.match(
        result.cpp,
        /bbl::js::Dictionary<std::string, bblscene::Entry> v_entries = bbl::js::Dictionary/,
    );
    assert.match(result.cpp, /auto& v_entries = [^;]+\.capture0;/);
    assert.doesNotMatch(result.cpp, /record_table_|static thread_local/);
    assert.match(result.cpp, /\.get_owned\(v_\w*code\)/);
    assert.match(result.cpp, /static_cast<bool>\(v_\w*entry\)/);
    assert.match(result.cpp, /v_\w*entry->value\+\+;/);
});

test("keeps generic Record instantiations type-distinct", () => {
    const result = compileSource(`
        type Area = "overworld" | "cave";
        interface Cell { x: number; y: number; }
        interface World {
            areas: Record<Area, Cell>;
            entries: Record<string, Cell>;
        }
        const entries: Record<string, Cell> = {
            start: { x: 1, y: 2 },
        };
        const world: World = {
            areas: {
                overworld: { x: 3, y: 4 },
                cave: { x: 5, y: 6 },
            },
            entries,
        };
    `);

    assert.match(result.cpp, /Generated by bblitec/);
});

test("defaults an absent nullable array element before nullish coalescing", () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const noPads: (Gamepad | null)[] = [];
            const pads = navigator.getGamepads?.() ?? noPads;
            const sampledPads: (Gamepad | null)[] = [null, null];
            sampledPads[0] = pads[0] ?? null;
            await startEngine(engine);
        }
        main();
    `);

    assert.match(result.cpp, /platform_gamepads\(/);
    assert.match(result.cpp, /array_at_or_default\(v_\w*pads,/);
    assert.doesNotMatch(result.cpp, /array_index_checked\(v_\w*pads,/);
});

test("a record or an element kept as an object is selected by the record's presence", () => {
    // `list ?? root` under `object | null`: a record and an element, each
    // stored as the document value the name keeps for its identity (the
    // identities themselves run in `language-constructs.test.ts`). A call
    // binding `root` present reads its element without a presence test.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        await createEngine(canvas);
        interface Lister { options(): readonly HTMLElement[]; entry(): HTMLElement | null }
        const outer = document.createElement("div");
        const inner = document.createElement("ul");
        outer.appendChild(inner);
        document.body.appendChild(outer);
        let current: { inner: HTMLElement; lister: Lister } | null = null;
        function listerIn(root: Node): Lister | null { return current && root.contains(current.inner) ? current.lister : null; }
        let kept: object | null = null;
        function handle(root: HTMLElement | null): void {
            const list = root ? listerIn(root) : null;
            const area: object | null = list ?? root;
            kept = area;
        }
        handle(outer);
        current = { inner, lister: { options: () => [inner], entry: () => null } };
        handle(outer);
        handle(null);
        if (kept !== null) throw new Error("kept");
    `);
    assert.match(
        result.cpp,
        /_area = \(v_fn\d+_list\.is_null\(\) \|\| v_fn\d+_list\.is_undefined\(\) \? bbl::js::json_value\(bbl::dom_target_value\(/,
    );
});

test("preserves the optional first value of a temporary Map iterator", () => {
    const result = compileSource(`
        import { createBox, createEngine, startEngine } from "babylon-lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const values = new Map<string, { size: number }>();
            values.set("first", { size: 2 });
            const first = values.values().next().value ?? { size: 1 };
            createBox(engine, first.size);
            await startEngine(engine);
        }
        main();
    `);
    assert.match(result.cpp, /map_iterator<[^\n]+MapPart::values>/);
    assert.match(result.cpp, /\.next\(\)/);
    assert.match(result.cpp, /\.value/);
});

test("stores and mutates a runtime string local", () => {
    const result = compileSource(`
        function build(bytes: Uint8Array): { name: string } {
            let name = "";
            for (let i = 0; i < bytes.length; i++) {
                name += String.fromCharCode(bytes[i]!);
            }
            name = name.toUpperCase();
            return { name };
        }
        const record = build(new Uint8Array([97, 98]));
    `);

    assert.match(result.cpp, /std::string v_\w*name = ""/);
    assert.match(
        result.cpp,
        /bbl::js::concat_append\(v_\w*name, bbl::js::string_from_char_code/,
    );
    assert.match(result.cpp, /v_\w*name = bbl::js::string_to_upper_case/);
});

test("preserves undefined in typeof for maybe-absent runtime values", () => {
    assert.doesNotThrow(() =>
        compileSource(`
            const absent = typeof undefined;
            const nil = typeof null;
        `),
    );
    const result = compileSource(`
        interface Entry { value: number; }
        const entries: Entry[] = [];
        let index = 0;
        const entry = entries[index];
        const kind = typeof entry;
    `);
    assert.match(
        result.cpp,
        /v_bblite_element_found_\d+ \? "object" : "undefined"/,
    );
});

test("specializes typeof for a settled inlined union parameter", () => {
    const result = compileSource(`
        function select(value: string | number): number {
            return typeof value === "number"
                ? value
                : 3;
        }
        const fromString = select("abc");
        const fromNumber = select(7);
    `);

    assert.match(result.cpp, /double v_fromString = 3\.0/);
    assert.match(result.cpp, /double v_fromNumber = 7\.0/);
});

test("preserves existence guards for dynamically indexed object arrays", () => {
    const result = compileSource(`
        const sets: Set<number>[] = [new Set<number>(), new Set<number>()];
        let left = 0;
        let right = 1;
        if (sets[left] && sets[right]) {
            sets[left].add(right);
            sets[right].add(left);
        }
    `);

    assert.match(result.cpp, /if \(\(\[&\]\(\) -> bool \{/);
    assert.equal(
        (result.cpp.match(/bbl::js::array_has_index\(/g) ?? []).length,
        2,
    );
    assert.match(result.cpp, /return false;/);
    assert.equal((result.cpp.match(/\.add\(/g) ?? []).length, 2);
});

test("carries an unchecked object element's existence through a local", () => {
    const result = compileSource(`
        interface Entry { value: number; }
        const entries: Entry[] = [{ value: 4 }];
        let index = 1;
        const entry = entries[index];
        const values = entry ? [entry.value] : [];
    `);

    assert.match(result.cpp, /bbl::js::array_at_or_default\(/);
    assert.match(
        result.cpp,
        /const bool v_bblite_element_found_\d+ = static_cast<bool>\(v_entry\)/,
    );
});

test("lowers typed values returned by class methods", () => {
    const result = compileSource(`
        class Counter {
            private n = 1;
            value(enabled: boolean): number {
                if (!enabled) return 0;
                return this.n;
            }
        }
        const counter = new Counter();
        let enabled = true;
        const total = counter.value(enabled);
    `);

    assert.match(
        result.cpp,
        /double Counter_value\(\[\[maybe_unused\]\] double& v_fn\d+_this_n, bool v_fn\d+_enabled\) \{/,
    );
    assert.match(result.cpp, /return 0\.0;/);
    assert.match(result.cpp, /return v_fn\d+_this_n;/);
    assert.match(
        result.cpp,
        /bblscene::Counter_value\(\(\*v_bblite_class_field_n_\d+\), v_\w*enabled\)/,
    );
});

test("lowers direct recursive plain-data class methods once", () => {
    const result = compileSource(`
        class Counter {
            sum(n: number): number {
                if (n <= 0) return 0;
                return n + this.sum(n - 1);
            }
        }
        const counter = new Counter();
        const total = counter.sum(3);
    `);

    // The once-emitted arm handles the recursion as an ordinary native
    // back edge; no per-call-site bbl::js::Callback survives.
    assert.equal(
        result.cpp.match(/double Counter_sum\(double v_fn\d+_n\) \{/g)?.length,
        1,
    );
    assert.match(result.cpp, /bblscene::Counter_sum\(\(v_fn\d+_n - 1\.0\)\)/);
    assert.doesNotMatch(result.cpp, /recursive_method/);
    assert.ok(result.cpp.length < 20_000);
});

test("folds static readonly class scalars", () => {
    const result = compileSource(`
        class Particle {
            private static readonly GRAVITY = 520;
            step(dt: number): number {
                return Particle.GRAVITY * dt;
            }
        }
        const particle = new Particle();
        const fall = particle.step(0.5);
    `);

    assert.match(result.cpp, /return \(520\.0 \* v_fn\d+_dt\);/);
    assert.doesNotMatch(result.cpp, /class_field_GRAVITY/);
});

test("rejects inheritance from something other than a local class", () => {
    assert.throws(
        () =>
            compileSource(`
                class Derived extends Map<string, number> {
                    bump(): void {
                        this.set("n", 1);
                    }
                }
                const derived = new Derived();
                derived.bump();
            `),
        /extends 'Map', which is not a local class with a body/,
    );
});

test("erases type-only class implements clauses", () => {
    const result = compileSource(`
        interface Counter {
            bump(): void;
        }
        class ImplementedCounter implements Counter {
            value = 0;
            bump(): void {
                this.value++;
            }
        }
        const counter = new ImplementedCounter();
        counter.bump();
    `);

    // An `implements` clause names no base: the class lowers as a plain one,
    // its method a native function over the field.
    assert.match(
        result.cpp,
        /ImplementedCounter_bump\(\(\*v_bblite_class_field_value_\d+\)\)/,
    );
});

test("runs a discarded local-class constructor for its side effects", () => {
    const result = compileSource(`
        let constructed = 0;
        class SideEffect {
            constructor() {
                constructed++;
            }
        }
        new SideEffect();
    `);

    assert.match(result.cpp, /v_constructed\+\+/);
});

test("copies inlined handle parameters before a factory can reallocate their owner", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            createStandardMaterial,
        } from "@babylonjs/lite";

        function build(engine: EngineContext, material: Material): Mesh {
            const mesh = createBox(engine, 1);
            mesh.material = material;
            return mesh;
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const source = createBox(engine, 1);
            source.material = createStandardMaterial();
            build(engine, source.material);
        }
    `);

    assert.match(
        result.cpp,
        /auto v_fn\d+_material = bbl::handle_at\(v_engine\.meshes, v_source\)\.material;/,
    );
    assert.doesNotMatch(
        result.cpp,
        /auto&& v_fn\d+_material = bbl::handle_at\(v_engine\.meshes, v_source\)\.material;/,
    );
});

test("gives constructor-assigned resource fields distinct native storage", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
        class Renderer {
            private engine: EngineContext;
            private scene: SceneContext;
            constructor(engine: EngineContext, scene: SceneContext) {
                this.engine = engine;
                this.scene = scene;
            }
            draw(): void {
                addToScene(this.scene, createBox(this.engine, 1));
            }
        }
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const renderer = new Renderer(engine, scene);
            renderer.draw();
        }
        main();
    `);

    assert.doesNotMatch(result.cpp, /auto&\s+(v_[A-Za-z0-9_]+)\s*=\s*\1;/);
    assert.match(result.cpp, /v_bblite_class_field_engine_/);
    assert.match(result.cpp, /v_bblite_class_field_scene_/);
});

test("a reassigned record method with no native signature names the part that has none", () => {
    assert.throws(
        () =>
            compileSource(`
                const late = { held: ((value: WeakRef<object>) => value.deref() !== undefined) as (value: WeakRef<object>) => boolean };
                late.held = () => false;
            `),
        /A mutable record method requires a concrete native function signature: 'WeakRef<object>' > type argument 'object': no native representation\./,
    );
});

test("rejects reassigning a resource-holding class field", () => {
    // Resource storage is wired once; branch-sensitive rebinding needs a
    // runtime class representation that this subset does not yet provide.
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createStandardMaterial,
                } from "@babylonjs/lite";
                class Painter {
                    private material: StandardMaterial;
                    constructor(material: StandardMaterial) {
                        this.material = material;
                    }
                    swap(other: StandardMaterial): void {
                        this.material = other;
                    }
                }
                async function main(): Promise<void> {
                    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                    const engine = await createEngine(canvas);
                    const painter = new Painter(createStandardMaterial());
                    painter.swap(createStandardMaterial());
                }
                main();
            `),
        /is already bound; a class field that holds a resource is wired once/,
    );
});

test("lowers a Record keyed by a string union into tag-ordered slots", () => {
    const result = compileSource(`
        type Mode = "pets" | "arcade" | "smooth";
        interface RenderSet { scale: number; }
        const sets: Record<Mode, RenderSet> = {
            pets: { scale: 1 },
            arcade: { scale: 2 },
            smooth: { scale: 3 },
        };
        let mode: Mode = "smooth";
        const active = sets[mode];
        const picked = active.scale + sets["arcade"].scale;
    `);
    // Enum members are numbered in sorted order, so the slots emit as
    // arcade, pets, smooth regardless of how the literal was written.
    assert.match(result.cpp, /enum class Mode \{\s*arcade,\s*pets,\s*smooth,/);
    // pets/arcade/smooth were written in that order and pinned to
    // reference temporaries in it; the map then takes them in tag order.
    assert.match(
        result.cpp,
        /RenderSet v_bblite_slot_0 = bbl::js::make_ref<bblscene::RenderSetData>\(bblscene::RenderSetData\{1\.0\}\);/,
    );
    assert.match(
        result.cpp,
        /RenderSet v_bblite_slot_1 = bbl::js::make_ref<bblscene::RenderSetData>\(bblscene::RenderSetData\{2\.0\}\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::EnumMap<bblscene::RenderSet, 3>\{v_bblite_slot_1, v_bblite_slot_0, v_bblite_slot_2\}/,
    );
    // A runtime tag indexes the slots; a literal key reads the entry
    // generation knows, which nothing replaces.
    assert.match(result.cpp, /enum_map_at\(v_sets, v_mode\)/);
    assert.match(result.cpp, /v_picked = \(v_active->scale \+ 2\.0\);/);
});

test("a literal key reads the entry it names beside writes into another literal's record", () => {
    const result = compileSource(`
        type Mode = "pets" | "arcade" | "smooth";
        interface RenderSet { scale: number; }
        const sets: Record<Mode, RenderSet> = {
            pets: { scale: 1 },
            arcade: { scale: 2 },
            smooth: { scale: 3 },
        };
        function unify(objects: readonly Record<string, unknown>[]): Record<string, unknown> {
            const merged: Record<string, unknown> = {};
            for (const object of objects)
                for (const key of Object.keys(object)) merged[key] = object[key];
            return merged;
        }
        let mode: Mode = "smooth";
        const active = sets[mode];
        const picked = active.scale + sets["arcade"].scale;
        console.log(Object.keys(unify([{ picked }, { mode }])).length);
    `);
    // \`merged[key]\` writes only the object its own literal creates.
    assert.match(result.cpp, /v_picked = \(v_active->scale \+ 2\.0\);/);
});

test("a record read by a literal-union key holds only the properties the key names", (t) => {
    // `input[side]` over "left" | "right" never reads `reach`, a record of
    // another shape, nor the scalar gaps beside it.
    const result = compileSource(`type RingWindowSide = "left" | "right";
interface RingWindowPlacement { id: string; side: RingWindowSide; left: number; top: number; width: number }
interface RingWindowReach { left: number; right: number; top: number; bottom: number }
interface RingWindowStack { placements: readonly RingWindowPlacement[]; reach: RingWindowReach }
interface RingWindowStackInput {
  left: { width: number; items: readonly { id: string; height: number }[] };
  right: { width: number; items: readonly { id: string; height: number }[] };
  reach: RingWindowReach;
  sideGap: number;
  stackGap: number;
}
function stackRingWindowColumns(input: Readonly<RingWindowStackInput>): RingWindowStack {
  const placements: RingWindowPlacement[] = [];
  const reach: RingWindowReach = { ...input.reach };
  for (const side of ["left", "right"] as const) {
    const column = input[side];
    if (column.items.length === 0) continue;
    const total = column.items.reduce((sum, item) => sum + item.height, 0) + input.stackGap * (column.items.length - 1);
    const left = side === "left" ? -(input.reach.left + input.sideGap) - column.width : input.reach.right + input.sideGap;
    let top = -total / 2;
    for (const item of column.items) {
      placements.push({ id: item.id, side, left, top, width: column.width });
      top += item.height + input.stackGap;
    }
    if (side === "left") reach.left = Math.max(reach.left, -left);
    else reach.right = Math.max(reach.right, left + column.width);
    reach.top = Math.min(reach.top, -total / 2);
    reach.bottom = Math.max(reach.bottom, total / 2);
  }
  return { placements, reach };
}
const items = [{ id: "a", height: Math.random() * 10 }];
const out = stackRingWindowColumns({ left: { width: 10, items }, right: { width: 12, items: [] }, reach: { left: 1, right: 2, top: -3, bottom: 3 }, sideGap: 4, stackGap: 2 });
if (out.placements.length !== 1 || out.placements[0]!.width !== 10 || out.reach.left !== 15 || out.reach.right !== 2) throw new Error("stack");
`);
    const tools = optionalNativeFixtureTools();
    if (!tools)
        return t.skip(
            "Native fixture compiler unavailable; generation assertions passed.",
        );
    runGeneratedProgram(
        tools,
        "compiler-literal-union-key-subset",
        result.cpp,
        {
            expectedOutput: "",
        },
    );
});

test("a member a literal key's entry never sets compares unequal to a present value", () => {
    const result = compileSource(`
        type Mode = "pets" | "arcade" | "smooth";
        interface RenderSet { scale: number; fade?: boolean; }
        const sets: Record<Mode, RenderSet> = {
            pets: { scale: 1 },
            arcade: { scale: 2, fade: true },
            smooth: { scale: 3 },
        };
        let mode: Mode = "smooth";
        const active = sets[mode];
        const fading = sets["pets"].fade === true ? 1 : 0;
        const still = sets["pets"].fade !== true;
        console.log(active.scale, fading, still);
    `);
    assert.match(result.cpp, /v_fading = 0\.0;/);
    assert.match(result.cpp, /v_still = true;/);
});

test("narrows an optional string-union key before Record lookup", () => {
    const result = compileSource(`
        type Face = "left" | "right";
        const normals: Readonly<Record<Face, readonly [number, number, number]>> = {
            left: [-1, 0, 0],
            right: [1, 0, 0],
        };
        class Picker {
            face: Face | null = null;
            read(): readonly [number, number, number] | null {
                if (!this.face) return null;
                return normals[this.face];
            }
        }
        const picker = new Picker();
        const normal = picker.read();
    `);

    // A read-only record is the record it wraps: one slot per tag.
    assert.match(
        result.cpp,
        /enum_map_at\(v_normals, \(\*\(\*v_bblite_class_field_face_\d+\)\)\)/,
    );
});

test("narrows an optional string-union key passed to Map.get", () => {
    const result = compileSource(`
        type Tool = "move" | "paint";
        const labels = new Map<Tool, string>();
        labels.set("move", "Move");
        labels.set("paint", "Paint");
        class Toolbar {
            active: Tool | null = "move";
            label(): string | undefined {
                if (this.active === null) return undefined;
                return labels.get(this.active);
            }
        }
        const toolbar = new Toolbar();
        const label = toolbar.label();
    `);

    assert.match(result.cpp, /\.get\(\(\*\(\*v_bblite_class_field_active_/);
});

test("evaluates Record slots in source order, places them in tag order", () => {
    // A slot initializer can emit statements, and JavaScript runs those
    // in the order the properties were written. Compiling in tag order
    // instead would reorder the side effects.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function count(n: number): number[] {
            const out: number[] = [];
            for (let i = 0; i < n; i++) { out.push(i); }
            return out;
        }
        const sets: Record<Mode, number[]> = {
            pets: count(2),
            arcade: count(3),
        };
        let mode: Mode = "pets";
        const picked = sets[mode].length;
    `);
    // `pets` is written first, so its call runs first...
    const first = result.cpp.indexOf("count(2.0)");
    const second = result.cpp.indexOf("count(3.0)");
    assert.ok(first > 0 && second > first);
    // ...into a temporary, because `arcade` sorts first and therefore
    // takes slot 0. Without the temporaries the braced initializer
    // would run the calls in slot order instead.
    assert.match(result.cpp, /(\w+) = bblscene::count\(2\.0\);/);
    assert.match(
        result.cpp,
        /EnumMap<bbl::js::Array<double>, 2>\{v_bblite_slot_4, v_bblite_slot_3\}/,
    );
});

test("skips Record slot temporaries when the orders already agree", () => {
    // Written in tag order, the braces already evaluate left to right
    // in source order, so no temporary is needed.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function count(n: number): number[] {
            const out: number[] = [];
            for (let i = 0; i < n; i++) { out.push(i); }
            return out;
        }
        const sets: Record<Mode, number[]> = {
            arcade: count(3),
            pets: count(2),
        };
        let mode: Mode = "pets";
        const picked = sets[mode].length;
    `);
    assert.doesNotMatch(result.cpp, /v_bblite_slot/);
    assert.match(
        result.cpp,
        /EnumMap<bbl::js::Array<double>, 2>\{bblscene::count\(3\.0\), bblscene::count\(2\.0\)\}/,
    );
});

test("rejects a Record literal missing a slot", () => {
    assert.throws(
        () =>
            compileSource(`
                type Mode = "pets" | "arcade" | "smooth";
                const sets: Record<Mode, number> = { pets: 1, arcade: 2 };
                let mode: Mode = "pets";
                const picked = sets[mode];
            `),
        /Record literal is missing the 'smooth' slot/,
    );
});

test("keeps an interface with the same keys a struct", () => {
    // Only the `Record` alias becomes a tag-indexed map; an ordinary
    // interface that happens to share the key names stays a struct, so
    // existing scenes keep the representation they had.
    const result = compileSource(`
        interface Plain { pets: number; arcade: number; smooth: number; }
        const plain: Plain = { pets: 1, arcade: 2, smooth: 3 };
        const picked = plain.arcade;
    `);
    assert.match(result.cpp, /struct Plain/);
    assert.doesNotMatch(result.cpp, /EnumMap/);
});

test("a record's methods and getter reach the scope it closed over", () => {
    // The factory's scope is left before the record is used, so the
    // record has to carry it: both the inlined method and the getter
    // must still resolve `currentMode` to the factory's local.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function createRenderer() {
            let currentMode: Mode = "pets";
            function setMode(mode: Mode): void {
                currentMode = mode;
            }
            return {
                setMode,
                get mode() { return currentMode; },
            };
        }
        const sets: Record<Mode, number> = { pets: 1, arcade: 2 };
        const renderer = createRenderer();
        renderer.setMode("arcade");
        const picked = sets[renderer.mode];
    `);
    const state = result.cpp.match(
        /auto (v_\w*currentMode) = bbl::js::make_gc_shared<bblscene::Mode>\(bblscene::Mode::pets\);/,
    );
    assert.ok(state);
    const local = state[1]!;
    // The method writes the captured local...
    assert.match(
        result.cpp,
        new RegExp(`\\(\\*${local}\\) = bblscene::Mode::arcade;`),
    );
    // ...and the getter reads it, rather than a snapshot of it.
    assert.match(
        result.cpp,
        new RegExp(`enum_map_at\\(v_sets, \\(\\*${local}\\)\\)`),
    );
});

test("evaluates object-literal setters in their captured scope", () => {
    const result = compileSource(`
        import {
            createEngine,
            createTransformNode,
            type TransformNode,
        } from "@babylonjs/lite";
        function createDriver(pivot: TransformNode) {
            let current = 0;
            return {
                get angle(): number { return current; },
                set angle(next: number) {
                    current = next * 2;
                    pivot.rotationQuaternion.x = current;
                },
            };
        }
        await createEngine({});
        const pivot = createTransformNode("pivot");
        const driver = createDriver(pivot);
        driver.angle = 3;
        const angle = driver.angle;
    `);

    // An accessor pair on a returned record literal is a stored callback
    // pair, so the binding both close over is one shared cell.
    assert.match(
        result.cpp,
        /auto v_fn\d+_current = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    assert.match(result.cpp, /\(\*v_fn\d+_current\) = \([^;]+ \* 2\.0\)/);
    assert.match(result.cpp, /set_transform_node_rotation_quaternion/);
    assert.match(result.cpp, /v_angle = \(\*v_fn\d+_current\)/);
});

test("keeps an early return inside the invoked setter", () => {
    const result = compileSource(`
        class Target {
            current = 1;
            set value(next: number) {
                if (next === this.current) {
                    return;
                }
                this.current = next;
            }
        }
        class Driver {
            target = new Target();
            completed = false;
            run(): void {
                this.target.value = 1;
                this.completed = true;
            }
        }
        const driver = new Driver();
        driver.run();
    `);

    assert.match(
        result.cpp,
        /\[&\]\(\) -> void \{[\s\S]*?return;[\s\S]*?\}\(\);\s*[^;]*completed[^;]*= true;/,
    );
});

test("record getters admit local statements and early returns", () => {
    assert.doesNotThrow(() =>
        compileSource(`
                const api = {
                    get total() {
                        let sum = 0;
                        return sum;
                    },
                };
                const read = api.total;
            `),
    );
    assert.doesNotThrow(() =>
        compileSource(
            `const api={get value(){if(Math.random()>0.5)return 1;return 2;}};const read=api.value;`,
        ),
    );
});

test("compiles record method arguments in the caller's scope", () => {
    // `chosen` belongs to the call site, not to the record's captured
    // scope, so it must resolve there.
    const result = compileSource(`
        type Mode = "pets" | "arcade";
        function createRenderer() {
            let currentMode: Mode = "pets";
            function setMode(mode: Mode): void {
                currentMode = mode;
            }
            return { setMode, get mode() { return currentMode; } };
        }
        const sets: Record<Mode, number> = { pets: 1, arcade: 2 };
        const renderer = createRenderer();
        const chosen: Mode = "arcade";
        renderer.setMode(chosen);
        const picked = sets[renderer.mode];
    `);
    assert.match(result.cpp, /Mode v_chosen = bblscene::Mode::arcade;/);
});

test("cycles a constant tag array with indexOf and a runtime index", () => {
    // The demo's `toggleMode`. The array folds to a compile-time tuple
    // on its own, so a computed index needs it materialized.
    const result = compileSource(`
        type Mode = "pets" | "arcade" | "smooth";
        const MODE_CYCLE: readonly Mode[] = ["pets", "arcade", "smooth"];
        let currentMode: Mode = "arcade";
        const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length]!;
        currentMode = next;
    `);
    assert.match(
        result.cpp,
        /inline const std::array<bblscene::Mode, 3> MODE_CYCLE\{bblscene::Mode::pets, bblscene::Mode::arcade, bblscene::Mode::smooth\}/,
    );
    // Both the search and the index read that one constant...
    assert.match(
        result.cpp,
        /array_index_of\(bblscene::MODE_CYCLE, v_currentMode\)/,
    );
    assert.equal(
        (result.cpp.match(/inline const std::array<bblscene::Mode/g) ?? [])
            .length,
        1,
    );
    // ...and the element copies, since a span's elements are const. The
    // cycling index is runtime, so the read is checked.
    assert.match(
        result.cpp,
        /bblscene::Mode v_next = bbl::js::array_index_checked\(bblscene::MODE_CYCLE, /,
    );
});

test("searches a runtime array with indexOf", () => {
    const result = compileSource(`
        const ys: number[] = [3, 5, 7];
        let needle = 5;
        const found = ys.indexOf(needle);
    `);
    assert.match(result.cpp, /array_index_of\(v_ys, v_needle\)/);
});

test("compares array members the way JavaScript compares objects", () => {
    // An object stored in an array is a `Ref`, whose equality is its control
    // block -- the same object identity `indexOf` compares in JavaScript.
    const result = compileSource(`
        interface Point { x: number; }
        const points: Point[] = [{ x: 1 }];
        const found = points.indexOf(points[0]!);
    `);
    assert.match(
        result.cpp,
        /bbl::js::array_index_of\(v_points, bbl::js::array_at_or_default\(v_points, /,
    );

    // A numeric tuple keeps its retained array identity when read back.
    const tuples = compileSource(`
        const rows: [number, number][] = [[1, 2]];
        const found = rows.indexOf(rows[0]!);
    `);
    assert.match(tuples.cpp, /bbl::js::Array<bbl::js::Tuple<2>> v_rows/);
    assert.match(
        tuples.cpp,
        /bbl::js::array_index_of\(v_rows, bbl::js::array_index_checked\(v_rows, 0\.0, "[^"]+"\)\)/,
    );
});

test("binds object data-path locals with shared identity", () => {
    const result = compileSource(`
        interface Holder {
            inner: { count: number };
        }
        function poke(holder: Holder): void {
            const alias = holder.inner;
            alias.count = 5;
        }
        const holder: Holder = {
            inner: { count: 1 },
        };
        poke(holder);
    `);

    // Copying the shared object handle preserves JavaScript identity, so the
    // field write still reaches the object stored in the holder.
    assert.match(
        result.cpp,
        /bblscene::Record\d+ v_fn\d+_alias = bbl::js::snapshot_value\(v_fn\d+_holder->inner\);/,
    );
    assert.match(result.cpp, /v_fn\d+_alias->count = 5\.0;/);
});

test("writes through a data struct returned by a reached call", () => {
    const result = compileSource(`
        interface Chunk { blocks: Uint8Array }
        const chunk: Chunk = { blocks: new Uint8Array(4) };

        function getChunk(select: boolean): Chunk {
            if (select) return chunk;
            return chunk;
        }

        const dynamic = Math.random() > 0.5;
        getChunk(dynamic).blocks[2] = 7;
    `);

    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::array_store_checked\([^\n]+2\.0[^\n]+\);\s+\1 = bbl::js::to_uint8\(7\.0\)/,
    );
    // Retained field metadata pins the struct before projecting its blocks.
    assert.equal(
        (result.cpp.match(/auto v_bblite_shared_return_\d+ =/g) ?? []).length,
        1,
        "probing an unchecked element must not evaluate its call-shaped owner twice",
    );
});

test("evaluates call-shaped numeric comparison operands once", () => {
    const result = compileSource(`
        function sampled(select: boolean): number {
            if (select) return Math.random();
            return 0;
        }

        const select = Math.random() > 0.5;
        const matched = sampled(select) === 1;
    `);

    assert.equal(
        (result.cpp.match(/bblscene::sampled\(v_select\)/g) ?? []).length,
        1,
        "comparison lowering must not emit its call-shaped operand while probing and then emit it again",
    );
    assert.match(result.cpp, /bblscene::sampled\(v_select\) == 1\.0/);
});

test("rebinds an optional Map from a fresh constructor", () => {
    const result = compileSource(`
        const outer = new Map<string, Map<number, number>>();
        let inner = outer.get("spawn");
        if (!inner) {
            inner = new Map();
            outer.set("spawn", inner);
        }
        inner.set(1, 2);
    `);

    assert.match(result.cpp, /Nullable<bbl::js::Map<double, double>>/);
    assert.match(result.cpp, /Map<double, double>\{\}/);
});

test("preserves missing Map handle storage in nullable locals", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            type Mesh,
        } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const meshes = new Map<string, Mesh>();
            let mesh = meshes.get("wall");
            if (!mesh) {
                mesh = createBox(engine);
                meshes.set("wall", mesh);
            }
        }
    `);

    const lookup = result.cpp.match(
        /const auto (v_bblite_map_get_\d+) = .*\.get\("wall"\);/,
    );
    assert.ok(lookup);
    const ownedMesh = "std::pair<bbl::StoredEngine, bbl::MeshHandle>";
    assert.match(
        result.cpp,
        new RegExp(
            String.raw`std::optional<${ownedMesh}> v_mesh = bbl::js::Nullable<${ownedMesh}>\{\(${lookup[1]}\.has_value\(\) \? bbl::js::Nullable<${ownedMesh}>\{${ownedMesh}\{bbl::StoredEngine\{v_engine\}, ${lookup[1]}\.value_or\(bbl::MeshHandle\{\}\)\}\} : bbl::js::Nullable<${ownedMesh}>\{std::nullopt\}\)\}\.to_optional\(\);`,
        ),
    );
    assert.equal(
        (result.cpp.match(/v_meshes\.get\("wall"\)/g) ?? []).length,
        1,
    );
    assert.equal((result.cpp.match(/bbl::create_box\(/g) ?? []).length, 1);
    assert.match(
        result.cpp,
        /if \(!\(v_mesh\.has_value\(\)\)\) \{\s*v_mesh = [^\n]+bbl::StoredEngine\{v_engine\}[^\n]+bbl::create_box\(v_engine,[^\n]+;\s*const auto (\w+) = "wall";\s*static_cast<void>\(v_meshes\.set\(\1, \(\(\*v_mesh\)\)\.second\)\);/,
    );
    assert.doesNotMatch(
        result.cpp,
        new RegExp(`v_mesh = \\(\\*${lookup[1]}\\)`),
    );
});

test("compares nullable handle parameters without dereferencing absence", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            type Mesh,
        } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const mesh = createBox(engine);
            let hovered: Mesh | null = null;
            function selected(flag: boolean): Mesh | null {
                if (flag) return mesh;
                return null;
            }
            function setHovered(next: Mesh | null): void {
                if (next === hovered) return;
                hovered = next;
            }
            setHovered(selected(Math.random() > 0.5));
            setHovered(null);
        }
        void main();
    `);

    assert.match(result.cpp, /\.has_value\(\) == .*\.has_value\(\)/);
    assert.match(result.cpp, /!.*\.has_value\(\)/);
    assert.doesNotMatch(result.cpp, /if \(\s*==/);
});

test("copies spread objects and destructures reference-backed array entries", () => {
    const result = compileSource(`
        interface Row {
            row: number;
            colors: number[];
        }
        function sumRows(rows: Row[]): number {
            let total = 0;
            for (const { row, colors } of rows) {
                total += row + colors[0]!;
            }
            return total;
        }
        const rows: Row[] = [];
        const original: Row = { row: 1, colors: [2, 3] };
        const moved: Row = { ...original, row: original.row + 1 };
        rows.push(original, moved);
        const total = sumRows(rows);
    `);

    assert.match(
        result.cpp,
        /bblscene::Row v_moved = bbl::js::make_ref<bblscene::RowData>\(\*\(v_original\)\);/,
    );
    // `original.row` is never written, so the moved row folds.
    assert.match(result.cpp, /v_moved->row = \(1\.0 \+ 1\.0\);/);
    // The pattern reads the item in place.
    assert.match(
        result.cpp,
        /auto&& (v_bblite_destructure_\d+) = v_bblite_item_\d+;\s+double v_fn\d+_block\d+_row = \1->row;\s+bbl::js::Array<double> v_fn\d+_block\d+_colors = \1->colors;/,
    );
});

test("keeps an object element alive after its container is resized", () => {
    const result = compileSource(`
        interface Entry { value: number; }
        const list: Entry[] = [{ value: 1 }];
        const entry = list[0]!;
        list.push({ value: 2 });
        entry.value = 5;
    `);
    // The initializer proves index zero present. The source binding owns
    // the selected reference before the array grows.
    assert.match(result.cpp, /using Entry = bbl::js::Ref<EntryData>;/);
    const selected = result.cpp.indexOf(
        "bblscene::Entry v_entry = bbl::js::snapshot_value(v_list[bbl::js::array_index(0.0)]);",
    );
    const resized = result.cpp.indexOf("v_list.push_back(");
    const written = result.cpp.indexOf("v_entry->value = 5.0;");
    assert.ok(selected >= 0 && selected < resized && resized < written);
});

test("mutable object aliases retain JavaScript identity", () => {
    const result = compileSource(`
        interface Holder {
            inner: { count: number };
        }
        function poke(holder: Holder): void {
            let alias = holder.inner;
            alias.count = 5;
        }
        const holder: Holder = {
            inner: { count: 1 },
        };
        poke(holder);
    `);
    assert.match(
        result.cpp,
        /bblscene::Record\d+ v_fn\d+_alias = bbl::js::snapshot_value\(v_fn\d+_holder->inner\);/,
    );
    assert.match(result.cpp, /v_fn\d+_alias->count = 5\.0;/);
});

test("shares explicitly typed mutable objects with stored callbacks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface State { count: number }
        interface Driver { update: () => void }
        async function main() {
            const engine = await createEngine({});
            const state: State = { count: 0 };
            const driver: Driver = {
                update: () => { state.count = 1; },
            };
            driver.update();
        }
    `);

    assert.match(result.cpp, /using State = bbl::js::Ref<StateData>;/);
    assert.match(result.cpp, /v_state->count = 1\.0;/);
    assert.match(
        result.cpp,
        /stored_callback\{\d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_state\}, bblscene::\w+/,
    );
});

test("stored callbacks may ignore arguments supplied by their container", () => {
    const result = compileSource(`
        const handlers = new Set<(value: number) => void>();
        let calls = 0;
        const handler = (): void => { calls += 1; };
        handlers.add(handler);
        for (const callback of handlers) callback(42);
    `);

    assert.match(
        result.cpp,
        /make_closure\(bblscene::bbl_environment_\w+\{v_calls\}, bblscene::\w+/,
    );
});

test("wires an optional callback field through nullish coalescing", () => {
    const result = compileSource(`
        class Toolbar {
            private readonly _onChange: ((value: number) => void) | null;
            constructor(options?: { onChange?: (value: number) => void }) {
                this._onChange = options?.onChange ?? null;
            }
            fire(): void { this._onChange?.(3); }
        }
        let total = 0;
        const toolbar = new Toolbar({
            onChange: (value): void => { total += value; },
        });
        toolbar.fire();
    `);

    assert.match(result.cpp, /\(\*v_total\) \+= v_fn\d+_value/);
    assert.match(
        result.cpp,
        /make_closure\(bblscene::bbl_environment_\w+\{v_total\}, bblscene::\w+\)\(3\.0\)/,
    );
});

test("class-field callbacks keep lexical this across another class", () => {
    const result = compileSource(`
        class Manager {
            private _count = 0;
            readonly onChange = (): void => { this._count += 1; };
            get count(): number { return this._count; }
        }
        class Host {
            private readonly _callback: () => void;
            constructor(callback: () => void) {
                this._callback = callback;
            }
            run(): void { this._callback(); }
        }
        const manager = new Manager();
        const host = new Host(manager.onChange);
        host.run();
        const count = manager.count;
    `);

    assert.match(result.cpp, /\(\*v_bblite_class_field__count_\d+\) \+= 1\.0/);
});

test("stores interface methods for runtime-selected implementations", () => {
    const result = compileSource(`
        type ToolId = "move" | "paint";
        interface Tool {
            activate(): void;
            deactivate(): void;
        }
        class MoveTool {
            private _active = false;
            activate(): void { this._active = true; }
            deactivate(): void { this._active = false; }
        }
        class PaintTool {
            private _active = false;
            activate(): void { this._active = true; }
            deactivate(): void { this._active = false; }
        }
        const tools: Partial<Record<ToolId, Tool>> = {
            move: new MoveTool(),
            paint: new PaintTool(),
        };
        let active: Tool | null = null;
        function select(id: ToolId | null): void {
            active?.deactivate();
            active = (id && tools[id]) || null;
            active?.activate();
        }
        select("move");
        select("paint");
        const dynamic: ToolId | null =
            Math.random() > 0.5 ? "move" : null;
        select(dynamic);
    `);

    assert.match(result.cpp, /bbl::js::Callback<void\(\)> activate/);
    assert.match(result.cpp, /if \(!\([^)]*callback_receiver/);
    assert.match(result.cpp, /snapshot_callback\([^;]+->deactivate\);/);
    assert.match(result.cpp, /snapshot_callback\([^;]+->activate\);/);
    assert.doesNotMatch(result.cpp, /const auto v_bblite_property_key_\d+ =/);
    assert.match(
        result.cpp,
        /\(\[&\]\(const auto v_bblite_property_key_\d+\) -> decltype\(auto\)/,
    );
});

test("maps TypeScript keyword fields to safe native struct names", () => {
    const result = compileSource(`
        interface Entry { delete: number; }
        const entries: Entry[] = [{ delete: 3 }];
        const value = entries[0]!.delete;
    `);

    assert.match(result.cpp, /double delete_\{\};/);
    assert.match(result.cpp, /EntryData\{3\.0\}/);
    assert.match(result.cpp, /->delete_/);
});

test("folds a string-array join used as a general value", () => {
    const result = compileSource(`
        const icon = ["<svg>", "<path/>", "</svg>"].join("");
        const wrapped = "[" + icon + "]";
    `);

    assert.match(result.cpp, /<svg><path\/><\/svg>/);
});

test("shares mutable primitive and render-target bindings across stored callbacks", () => {
    const result = compileSource(
        `
            import {
                createEngine,
                createRenderTexture2D,
                type Texture2D,
            } from "babylon-lite";
            interface Controller {
                resize: () => void;
                width: () => number;
            }
            async function main(): Promise<void> {
                const engine = await createEngine({} as HTMLCanvasElement);
                let width = 64;
                let target: Texture2D | null =
                    createRenderTexture2D(engine, width, width);
                const controller: Controller = {
                    resize: () => {
                        target!.texture.destroy();
                        target = createRenderTexture2D(engine, 128, 128);
                        width = 128;
                    },
                    width: () => width,
                };
                controller.resize();
                controller.width();
            }
            void main();
        `,
        {
            fileName:
                "corpus/babylon-lite/lab/lite/src/demos/closure-storage-test.ts",
        },
    );

    assert.match(result.cpp, /bbl::js::make_gc_shared<double>\(64\.0\)/);
    assert.match(
        result.cpp,
        /bbl::js::make_gc_shared<std::optional<bbl::SpriteRenderTextureHandle>>/,
    );
    assert.match(result.cpp, /bbl::dispose_sprite_render_texture/);
    assert.match(result.cpp, /\(\*v(?:_fn\d+)?_width\) = 128\.0/);
});

test("shares mutable bindings captured through stored callback helpers", () => {
    const result = compileSource(`
        interface Counter {
            first(): number;
            second(): number;
        }
        function createCounter(): Counter {
            let current = 0;
            const next = (): number => {
                current += 1;
                return current;
            };
            return {
                first(): number { return next(); },
                second(): number { return next(); },
            };
        }
        const counter = createCounter();
        const one = counter.first();
        const two = counter.second();
    `);

    assert.match(
        result.cpp,
        /auto v_fn\d+_current = bbl::js::make_gc_shared<double>\(0\.0\);/,
    );
    assert.match(result.cpp, /\(\*v_fn\d+_current\) \+= 1\.0;/);
});

test("shares a reassigned array binding across stored callbacks", () => {
    const result = compileSource(`
        interface Queue {
            replace(values: number[]): void;
            take(): number;
        }
        function createQueue(): Queue {
            let values: number[] = [];
            return {
                replace(next: number[]): void {
                    values = next.map((value) => value);
                },
                take(): number {
                    return values.shift() ?? -1;
                },
            };
        }
        const queue = createQueue();
        queue.replace([3]);
        const value = queue.take();
    `);

    const storage = result.cpp.match(
        /auto (v_fn\d+_values) = bbl::js::make_gc_shared<bbl::js::Array<double>>/,
    );
    assert.ok(storage);
    assert.match(result.cpp, new RegExp(`\\(\\*${storage[1]}\\) = `));
    assert.match(
        result.cpp,
        new RegExp(`array_shift_or_absent\\(\\(\\*${storage[1]}\\)\\)`),
    );
});

test("reads an operand early only when a later one writes what it touches", () => {
    const result = compileSource(`
        let count = 1;
        function half(value: number): number {
            return value / 2;
        }
        function show(a: number, b: number): string {
            return a + ":" + b;
        }
        count = 3;
        const pure = show(half(count), half(4));
        const draws = show(Math.random(), Math.random());
    `);

    assert.match(
        result.cpp,
        /bblscene::show\(bblscene::half\(v_count\), bblscene::half\(4\.0\)\)/,
    );
    const first = result.cpp.match(
        /const double (v_bblite_native_argument_\d+) = bbl::js::random_js\(\);/,
    );
    assert.ok(first);
    assert.match(
        result.cpp,
        new RegExp(`bblscene::show\\(${first[1]}, bbl::js::random_js\\(\\)\\)`),
    );
});

test("spells a missed array slot in text only where the index may miss", () => {
    const result = compileSource(`
        const plain: number[] = [1, 2];
        let text = "";
        for (let i = 0; i < plain.length; i++) text += plain[i];
        let index = 3;
        text += plain[index];
    `);

    const missable = result.cpp.match(
        /\(bbl::js::array_has_index\(v_plain, (v_bblite_element_index_\d+)\) \? bbl::js::concat\(bbl::js::NumberPart\(bbl::js::number_at\(v_plain, \1\)\)\) : std::string\("undefined"\)\)/g,
    );
    assert.equal(missable?.length, 1);
    assert.match(
        result.cpp,
        /concat_append\(v_text, bbl::js::NumberPart\(bbl::js::number_at\(v_plain, v_bblite_element_index_\d+\)\)\);/,
    );
});

test("seeds Math.random deterministically and records the adaptation", () => {
    const result = compileSource(`
        function roll(sides: number): number {
            return Math.floor(Math.random() * sides);
        }
        const value = roll(6);
    `);

    assert.match(result.cpp, /bbl::js::seed_random\(1u\);/);
    assert.match(
        result.cpp,
        /std::floor\(\(bbl::js::random_js\(\) \* v_fn\d+_sides\)\)/,
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "deterministic-seeded-random",
        ),
    );
});

test("lowers Math.imul through its exact wrapped 32-bit semantics", () => {
    const result = compileSource(`
        function step(state: number): number {
            return Math.imul(state ^ (state >>> 15), state | 1);
        }
        const next = step(-1);
    `);

    assert.match(
        result.cpp,
        /bbl::js::math_imul\(bbl::js::bitwise_xor\([^,]+, bbl::js::shift_right_unsigned\([^)]*\)\), bbl::js::bitwise_or\([^)]*\)\)/,
    );
});

test("lowers Array.every with JavaScript empty-array and early-exit semantics", () => {
    const result = compileSource(`
        const points: [number, number][] = [[0, 0], [3, 4]];
        const distant = points.every(([x, y]) => Math.hypot(x, y) >= 0);
    `);

    assert.match(result.cpp, /bool \w*_every_result_\d+ = true;/);
    assert.match(
        result.cpp,
        /if \(!\(bbl::js::hypot_js\(\{[^}]*\}\) >= 0\.0\)\) \{/,
    );
    assert.match(result.cpp, /\w*_every_result_\d+ = false;\s+break;/);
});

test("shares a tuple predicate through an unknown parameter", () => {
    const result = compileSource(`
        function finiteVector(value: unknown): boolean {
            return Array.isArray(value) &&
                value.every((entry) =>
                    typeof entry === "number" && Number.isFinite(entry));
        }
        const valid = finiteVector([1, 2, 3]);
        const invalid = finiteVector([1, 1 / 0]);
    `);

    assert.equal(
        result.cpp.match(/bool \w*_every_result_\d+ = true;/g)?.length,
        1,
    );
    assert.match(result.cpp, /std::isfinite\(/);
    assert.match(result.cpp, /auto& v_valid = v_bblite_shared_result_\d+;/);
    assert.match(result.cpp, /auto& v_invalid = v_bblite_shared_result_\d+;/);
});

test("specializes a generation-known read-only scalar parameter", () => {
    const result = compileSource(`
        function sameLength(value: unknown, expected: number): boolean {
            return Array.isArray(value) && value.length === expected;
        }
        const matches = sameLength([1, 2, 3], 3);
    `);

    assert.match(
        result.cpp,
        /\.read_property\("length"\)\.strict_equals\(v_fn\d+_expected\)/,
    );
    assert.match(
        result.cpp,
        /JsonValue::from_array\(bbl::js::JsonValue::Array\{[^\n]+\}\), 3\.0\)/,
    );
});

test("lowers typed arrays with storage-exact reads and writes", () => {
    const result = compileSource(`
        function build(): Float32Array {
            const values: number[] = [];
            values.push(0.25, 0.5, 0.75);
            return new Float32Array(values);
        }
        const data = build();
        const first = data[0]!;
        data[1] = 2.5;
        const count = data.length;
        const indices = new Uint32Array([0, 1, 2]);
        indices[0] = 7;
        const signed = new Int32Array([-1, 2147483648]);
        signed[0] = 4294967295;
        const signedShorts = new Int16Array([-1, 32768]);
        signedShorts[0] = 65535;
        const zeros = new Float32Array(8);
    `);

    assert.match(result.cpp, /bbl::js::f32_array_from\(v_fn\d+_values\)/);
    assert.match(
        result.cpp,
        /\((v_fn\d+_values)\.push_back\(0\.25\), \1\.push_back\(0\.5\), \1\.push_back\(0\.75\), static_cast<double>\(\1\.size\(\)\)\)/,
    );
    // `data` comes from a call, so its length is not statically known
    // and even static indices are checked; the literal-constructed
    // arrays below prove their lengths and skip dynamic bounds checks.
    // Every stored value here runs no store, so each slot borrows its
    // named array instead of retaining it.
    assert.match(
        result.cpp,
        /double v_first = static_cast<double>\(bbl::js::array_index_checked\(v_data, 0\.0, "[^"]+"\)\);/,
    );
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::array_store_borrowed\(v_data, 1\.0, "[^"]+"\);\s+\1 = static_cast<float>\(2\.5\);/,
    );
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::typed_array_borrowed_slot\(v_indices, bbl::js::array_index\(0\.0\)\);\s+\1 = bbl::js::to_uint32\(7\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::u32_array_from\(bbl::js::Array<double>\{0\.0, 1\.0, 2\.0\}\)/,
    );
    assert.match(result.cpp, /bbl::js::f32_array_sized\(8\.0\)/);
    assert.match(
        result.cpp,
        /bbl::js::i32_array_from\(bbl::js::Array<double>\{\(-1\.0\), 2147483648\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::typed_array_borrowed_slot\(v_signed, bbl::js::array_index\(0\.0\)\);\s+\1 = bbl::js::to_int32\(4294967295\.0\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::i16_array_from\(bbl::js::Array<double>\{\(-1\.0\), 32768\.0\}\)/,
    );
    assert.match(
        result.cpp,
        /auto&& (v_bblite_typed_slot_\d+) = bbl::js::typed_array_borrowed_slot\(v_signedShorts, bbl::js::array_index\(0\.0\)\);\s+\1 = bbl::js::to_int16\(65535\.0\);/,
    );
});

test("defaults omitted Uint8Array slice and subarray bounds", () => {
    const result = compileSource(`
        const source = new Uint8Array([1, 2, 3]);
        const copy = source.slice();
        const view = source.subarray();
        const buffer = source.buffer;
        const tail = new Uint8Array(buffer, 1);
        const middle = new Uint8Array(buffer, 1, 1).slice();
        const holder = { buffer };
        const replacementSource = new Uint8Array([9]);
        const replacement = replacementSource.buffer;
        function offset(): number {
            holder.buffer = replacement;
            return 1;
        }
        const retained = new Uint8Array(holder.buffer, offset());
    `);

    assert.match(
        result.cpp,
        /bbl::js::typed_array_slice\(v_source, 0\.0, static_cast<double>\(v_source\.size\(\)\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::typed_array_subarray\(v_source, 0\.0, static_cast<double>\(v_source\.size\(\)\)\)/,
    );
    assert.match(
        result.cpp,
        /const double (v_bblite_view_index_\d+) = 1\.0;\s+auto (v_bblite_typed_view_\d+) = bbl::js::U8Array\(v_buffer, bbl::js::buffer_view_index\(\1\)\);\s+\[\[maybe_unused\]\] bbl::js::U8Array& v_tail = \2;/,
    );
    assert.doesNotMatch(result.cpp, /v_bblite_view_buffer_\d+ = v_buffer;/);
    assert.match(
        result.cpp,
        /auto (v_bblite_view_buffer_\d+) = bbl::js::snapshot_value\(v_holder->buffer\);\s+\[\[maybe_unused\]\] const double v_bblite_shared_result_\d+ = bbl::js::make_closure\([^\n]+\)\(\);\s+const double (v_bblite_view_index_\d+) = v_bblite_shared_result_\d+;\s+auto (v_bblite_typed_view_\d+) = bbl::js::U8Array\(\1, bbl::js::buffer_view_index\(\2\)\);\s+\[\[maybe_unused\]\] bbl::js::U8Array& v_retained = \3;/,
    );
    assert.match(
        result.cpp,
        /const double (v_bblite_view_index_\d+) = 1\.0;\s+const double (v_bblite_view_index_\d+) = 1\.0;\s+auto (v_bblite_typed_view_\d+) = bbl::js::U8Array\(v_buffer, bbl::js::buffer_view_index\(\1\), bbl::js::buffer_view_index\(\2\)\);\s+\[\[maybe_unused\]\] bbl::js::U8Array v_middle = bbl::js::typed_array_slice\(\3, 0\.0, static_cast<double>\(\3\.size\(\)\)\);/,
    );
});

test("copies vector-backed typed arrays through slice", () => {
    const result = compileSource(`
        const source = new Float32Array([1, 2, 3]);
        const copy = source.slice();
        const tail = source.slice(-2);
    `);

    assert.match(
        result.cpp,
        /bbl::js::typed_array_slice\(v_source, 0\.0, static_cast<double>\(v_source\.size\(\)\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::typed_array_slice\(v_source, \(-2\.0\), static_cast<double>\(v_source\.size\(\)\)\)/,
    );
});

test("rebinds optional typed arrays from fresh constructors", () => {
    const result = compileSource(`
        let bytes: Uint8Array | null = null;
        bytes = new Uint8Array(4).slice();
        let signed: Int32Array | null = null;
        signed = new Int32Array(2);
    `);

    assert.match(
        result.cpp,
        /auto (v_bblite_constructed_receiver_\d+) = bbl::js::u8_array_sized\(4\.0\);\s+v_bytes = bbl::js::Nullable<bbl::js::U8Array>\{bbl::js::typed_array_slice\(\1, /,
    );
    assert.match(
        result.cpp,
        /v_signed = bbl::js::Nullable<bbl::js::I32Array>\{bbl::js::i32_array_sized\(2\.0\)\};/,
    );
});

test("rebinds an optional Uint8Array returned by a helper", () => {
    const result = compileSource(`
        function makeBytes(): Uint8Array {
            return new Uint8Array(4);
        }
        let bytes: Uint8Array | null = null;
        bytes = makeBytes();
        const length = bytes.length;
    `);

    assert.match(
        result.cpp,
        /v_bytes = bbl::js::Nullable<bbl::js::U8Array>\{bblscene::makeBytes\(\)\};/,
    );
    assert.match(
        result.cpp,
        /double v_length = bbl::js::array_length\(\(\*v_bytes\)\)/,
    );
});

test("distinguishes omitted and explicit zero DataView lengths", () => {
    const result = compileSource(`
        const bytes = new Uint8Array(4);
        const remaining = new DataView(bytes.buffer, 2);
        const empty = new DataView(bytes.buffer, 2, 0);
        const totalBytes = bytes.buffer.byteLength;
        const byte = remaining.getUint8(0);
        const signed = remaining.getInt8(0);
        const scalar = remaining.getFloat32(0, true);
    `);

    assert.match(
        result.cpp,
        /bbl::js::DataView\(v_bytes\.buffer\(\), bbl::js::array_index\(2\.0\)\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::DataView\(v_bytes\.buffer\(\), bbl::js::array_index\(2\.0\), bbl::js::array_index\(0\.0\)\);/,
    );
    assert.match(
        result.cpp,
        /v_remaining\.get_uint8\(bbl::js::array_index\(0\.0\)\)/,
    );
    assert.match(result.cpp, /v_bytes\.buffer\(\)\.byte_length\(\)/);
    assert.match(
        result.cpp,
        /v_remaining\.get_int8\(bbl::js::array_index\(0\.0\)\)/,
    );
    assert.match(
        result.cpp,
        /v_remaining\.get_float32\(bbl::js::array_index\(0\.0\), true\)/,
    );
});

test("indexes runtime strings as one-character strings", () => {
    const result = compileSource(`
        function opening(text: string, index: number): boolean {
            return text[index] === "{" && text.toLowerCase() === text;
        }
        const found = opening("{}", 0);
    `);

    assert.match(result.cpp, /bbl::js::string_index\([^\r\n]+/);
    assert.match(result.cpp, /bbl::js::string_to_lower_case\(v_fn\d+_text\)/);
});

test("narrows guarded optional strings before trim", () => {
    const result = compileSource(`
        function clean(value: string | undefined): string {
            if (!value) return "";
            return value.trim();
        }
        // A pure helper handed a known value folds at its call.
        let input: string | undefined = " value ";
        if (Date.now() < 0) input = undefined;
        const cleaned = clean(input);
        const words = cleaned.split(/\\s+/);
        const numbers = "1 2".split(/\\s+/).map(Number);
    `);

    assert.match(result.cpp, /bbl::js::string_trim\(\(\*v_fn\d+_value\)\)/);
    assert.match(
        result.cpp,
        /bbl::js::RegExp\("\\\\s\+", false, false\)\.split\(v_cleaned\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::number_from_string\(v_bblite_map_source_\d+\[v_bblite_map_index_\d+\]\)/,
    );
});

test("calls a string method on a compile-time record property", () => {
    const result = compileSource(`
        function dataUri(record: Record<string, unknown>): string {
            const texture = record.texture as { name?: string };
            return texture.name && texture.name.startsWith("data:")
                ? texture.name
                : "fallback";
        }
        const selected = dataUri({
            texture: { name: "data:image/png;base64,AA==" },
        });
    `);

    assert.match(
        result.cpp,
        /std::string v_selected = .*"data:image\/png;base64,AA=="/,
    );
    assert.doesNotMatch(result.cpp, /string_starts_with/);
});

test("keeps a generation-known optional const at its selected scalar", () => {
    const result = compileSource(`
        const texture = {
            url: "/albedo.png",
            name: "/albedo.png",
        } as { url?: string; name?: string };
        const url = texture.url && texture.url.length > 0
            ? texture.url
            : texture.name && texture.name.startsWith("data:")
              ? texture.name
              : undefined;
        if (!url) throw new Error("missing texture");

        const block = { name: "Albedo", id: 7 } as Record<string, unknown>;
        const key = (block.name as string | undefined) || \`tex\${block.id}\`;
    `);

    assert.match(result.cpp, /std::string v_url = "\/albedo\.png";/);
    assert.doesNotMatch(result.cpp, /Nullable<std::string> v_url/);
    assert.match(result.cpp, /std::string v_key = "Albedo";/);
});

test("compares a missing optional scalar as absent", () => {
    // A write may give the field a value: the comparison reads it.
    const written = compileSource(`
        interface Entry { shape?: number }
        const entry: Entry = {};
        if (Math.random() > 2) entry.shape = 3;
        const wedge = entry.shape === 1;
        console.log(wedge);
    `);
    assert.match(
        written.cpp,
        /auto (\w+) = bbl::js::snapshot_value\(v_entry->shape\);\s*const auto& \w+_optional_compare_\d+ = \1;/,
    );
    assert.match(written.cpp, /\.has_value\(\)/);
    // Where none does, the field is absent and equals no present value.
    const unwritten = compileSource(`
        interface Entry { shape?: number }
        const entry: Entry = {};
        const wedge = entry.shape === 1;
    `);
    assert.match(unwritten.cpp, /bool v_wedge = false;/);
});

test("a live comparison selecting a number is emitted once", () => {
    // The const-number fold probes the condition first; a declined probe
    // must not leave its comparison temporary behind (-Wunused-variable).
    const result = compileSource(`
        function read(): string | null { return localStorage.getItem("toggle"); }
        const toggle = read();
        const migrated = toggle === "off" ? 0 : 1;
        console.log(migrated);
    `);

    const temporaries = [
        ...result.cpp.matchAll(/(v_bblite_optional_compare_\d+) = /g),
    ].map((match) => match[1]!);
    assert.equal(temporaries.length, 1);
    assert.match(result.cpp, new RegExp(`${temporaries[0]}\\.has_value\\(\\)`));
});

test("calls function-valued parameters from native loops", () => {
    const result = compileSource(`
        function apply(count: number, producer: (index: number) => number): number {
            let total = 0;
            for (let index = 0; index < count; index++) {
                total += producer(index);
            }
            return total;
        }
        const doubled = apply(3, (index) => {
            return index * 2;
        });
    `);

    assert.equal(result.cpp.match(/for \(;/g)?.length, 1);
    assert.equal(
        result.cpp.match(/return \(v_fn\d+_index \* 2\.0\);/g)?.length,
        1,
    );
    const named = compileSource(`
        function apply(count: number, producer: (index: number) => number): number {
            let total = 0;
            for (let index = 0; index < count; index++) {
                total += producer(index);
            }
            return total;
        }
        const offset = 5;
        const produce = (index: number): number => index + offset;
        const result = apply(2, produce);
    `);
    assert.equal(named.cpp.match(/for \(;/g)?.length, 1);
    assert.equal(
        named.cpp.match(/return \(v_fn\d+_index \+ 5\.0\);/g)?.length,
        1,
    );
});

test("keeps mutable locals unfolded when bound as arguments", () => {
    const result = compileSource(`
        function twice(value: number): number {
            return value * 2;
        }
        let counter = 0;
        counter++;
        const result = twice(counter);
    `);

    assert.match(result.cpp, /bblscene::twice\(v_counter\)/);
    assert.doesNotMatch(result.cpp, /bblscene::twice\(0\.0\)/);
});

test("lowers early bare returns of inlined closures through a wrapper", () => {
    const result = compileSource(`
        const values: number[] = [];
        function record(value: number): void {
            if (value < 0) {
                return;
            }
            values.push(value);
        }
        record(-1);
        record(2);
    `);

    assert.match(result.cpp, /if \(v_fn\d+_value < 0\.0\) \{\s+return;/);
    assert.equal(result.cpp.match(/v_values\.push_back/g)?.length, 1);
    // Each call builds the shared body's environment for that call alone,
    // holding the array by reference.
    assert.equal(
        result.cpp.match(
            /make_closure\(bblscene::bbl_environment_\w+\{v_values\}/g,
        )?.length,
        2,
    );
    assert.match(
        result.cpp,
        /std::remove_reference_t<bbl::js::Array<double>>& capture0;/,
    );
});

test("supports mutable tuple locals with runtime index writes", () => {
    const result = compileSource(`
        function axisVector(axis: number, sign: number): number {
            const p: [number, number, number] = [0, 0, 0];
            p[axis] = sign;
            return p[0] + p[1] + p[2];
        }
        const total = axisVector(1, 5) || 1;
    `);

    assert.match(
        result.cpp,
        /bbl::js::Tuple<3> v_fn\d+_p = bbl::js::Tuple<3>\{0\.0, 0\.0, 0\.0\};/,
    );
    // The tuple's fixed arity cannot absorb an out-of-range runtime
    // write, so the unproven index stores through the checked accessor.
    assert.match(
        result.cpp,
        /bbl::js::array_store_checked\(v_fn\d+_p, v_fn\d+_axis, "[^"]+"\) = v_fn\d+_sign;/,
    );
    assert.match(
        result.cpp,
        /bbl::js::or_number\(bblscene::axisVector\(1\.0, 5\.0\), 1\.0\)/,
    );
});

test("a selection of members a call omits is absent where that call is lowered", () => {
    const result = compileSource(`
        interface Cell { u: number; v: number; w: number; h: number }
        interface Options {
            name: string;
            cells?: { cells: readonly Cell[]; vFlip: boolean };
            map?: { cells: readonly Cell[]; vFlip: boolean; capacity: number; keySource: "a" | "b" };
        }
        function build(opts: Options): string {
            const cells = opts.cells;
            const map = opts.map;
            const mode = cells ?? map;
            const setup = mode ? \`cells \${cells ? "direct" : map ? map.keySource : ""}\` : "";
            let total = 0;
            if (mode) {
                const count = Math.max(1, mode.cells.length);
                const data = new Float32Array((count + 1) * 4);
                data[0] = count;
                data[1] = mode.vFlip ? -1 : 1;
                const source = mode.cells.length ? mode.cells : [{ u: 0, v: 0, w: 1, h: 1 }];
                for (let i = 0; i < count; i++) {
                    const cell = source[i]!;
                    data.set([cell.u, cell.v, cell.w, cell.h], (i + 1) * 4);
                }
                total += data.length;
            }
            return opts.name + "[" + setup + "]" + total;
        }
        const options = { name: "body" };
        console.log(build(options));
        const withCells = { name: "cells", cells: { cells: [{ u: 0, v: 0, w: 1, h: 1 }], vFlip: true } };
        console.log(build(withCells));
    `);
    // The call that omits both reads no storage: the test of the name folds.
    assert.match(result.cpp, /std::string v_fn\d+_setup = "";/);
});

test("a builder handed options a table's entry gives, directly or spread into a literal, reads that entry's facts in each key's arm", () => {
    // The species table, the options builder and the iteration share one
    // module; the builder awaits and caches before composing its shader. A
    // spread hands the entry's fields on by name.
    for (const [form, handed] of [
        ["direct", "optionsFor(type, capacity)"],
        ["spread", "{ ...optionsFor(type, capacity), tone: 1 }"],
    ]) {
        const directory = resolve(
            `artifacts/compiler-keyed-table-options-${form}`,
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "noop-worker.ts"), "self.close();\n");
        writeFileSync(
            join(directory, "species.ts"),
            `import type { EngineContext, ShaderMaterial } from "@babylonjs/lite";
import { herd, type HerdOptions } from "./herd";
export type Species = "deer" | "fox" | "hen";
interface SpeciesDef { file: string; height: number; glow?: boolean; base: { speed: number } }
const SPECIES: Record<Species, SpeciesDef> = {
    deer: { file: "Deer.glb", height: 2.9, base: { speed: 1 } },
    fox: { file: "Fox.glb", height: 0.8, glow: true, base: { speed: 2 } },
    hen: { file: "Hen.glb", height: 0.4, base: { speed: 0.5 } },
};
export function speciesSpeed(type: Species): number { return SPECIES[type].base.speed; }
export function isSpecies(value: string): value is Species { return Object.prototype.hasOwnProperty.call(SPECIES, value); }
function optionsFor(type: Species, capacity: number): HerdOptions {
    const def = SPECIES[type];
    return { file: def.file, height: def.height, glow: def.glow, capacity };
}
export async function buildHerds(engine: EngineContext, capacity: number): Promise<ShaderMaterial[]> {
    const types = Object.keys(SPECIES) as Species[];
    return Promise.all(types.map((type) => herd(engine, ${handed})));
}
`,
        );
        writeFileSync(
            join(directory, "herd.ts"),
            `import { createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
export interface HerdOptions { file: string; height: number; glow?: boolean; capacity: number; tone?: number }
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*HEIGHT*/, 1.0);
  return out;
}\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.2, 1.0); }\`;
const cache = new Map<string, Promise<number>>();
async function prepare(opts: HerdOptions): Promise<number> {
    await Promise.resolve();
    return opts.capacity;
}
function prepared(opts: HerdOptions): Promise<number> {
    let prep = cache.get(opts.file);
    if (!prep) {
        prep = prepare(opts);
        prep.catch(() => cache.delete(opts.file));
        cache.set(opts.file, prep);
    }
    return prep;
}
export async function herd(engine: EngineContext, opts: HerdOptions): Promise<ShaderMaterial> {
    const capacity = await prepared(opts);
    let vertex = VERTEX.replace("/*HEIGHT*/", String(opts.height));
    if (opts.glow) vertex = vertex.replace("input.position", "(input.position * 1.1)");
    await Promise.resolve();
    return createShaderMaterial({ name: opts.file + capacity, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
`,
        );
        const result = compileSource(
            `import { addToScene, createArcRotateCamera, createEngine, createPlane, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
import { buildHerds, isSpecies, speciesSpeed } from "./species";
const worker = new Worker(new URL("./noop-worker.ts", import.meta.url), { type: "module" });
worker.terminate();
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });
    const materials = await buildHerds(engine, 8);
    const plane = createPlane(engine, { width: 2, height: 2 });
    plane.material = materials[0]!;
    addToScene(scene, plane);
    console.log(speciesSpeed(isSpecies(String(Math.random())) ? "fox" : "deer"));
    await registerScene(scene);
    await startEngine(engine);
}
void main();
`,
            {
                fileName: join(directory, "entry.ts"),
            },
        );
        assert.deepEqual(
            result.manifest.customShaderPrograms.map((program) => [
                /\* ([0-9.]+), 1\.0\)/.exec(program.vertexSource)?.[1],
                program.vertexSource.includes("(input.position * 1.1)"),
            ]),
            [
                ["2.9", false],
                ["0.8", true],
                ["0.4", false],
            ],
        );
    }
});

/** A repair of a parsed value: each non-finite number under it reset to 0. */
const REPAIR = `interface Mutable { [key: string]: unknown }
export function repairNonFinite(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    let repaired = false;
    const record = value as Mutable;
    for (const key of Object.keys(record)) {
        const child = record[key];
        if (typeof child === "number") {
            if (!Number.isFinite(child)) {
                record[key] = 0;
                repaired = true;
            }
            continue;
        }
        if (child !== null && typeof child === "object" && repairNonFinite(child)) repaired = true;
    }
    return repaired;
}
`;

test("a builder holding options a native table's entry fills as one object reads the members neither sets as absent in each key's arm", () => {
    // The table's entries hold a run-time value, so it is native; the
    // builder observes its options' identity, so it holds them as one
    // native object. `fade`, which neither sets, alone would create the
    // buffer.
    // A repair of a parsed value that writes a slot only while it holds a
    // non-finite number replaces neither the record entry nor its finite or
    // absent members, so it keeps the same facts.
    for (const repaired of [false, true]) {
        const directory = resolve(
            `artifacts/compiler-stored-table-options${repaired ? "-repaired" : ""}`,
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "noop-worker.ts"), "self.close();\n");
        if (repaired) writeFileSync(join(directory, "repair.ts"), REPAIR);
        writeFileSync(
            join(directory, "species.ts"),
            `import type { EngineContext } from "@babylonjs/lite";
import { herd, type Herd, type HerdOptions } from "./herd";
export type Species = "deer" | "fox" | "hen";
interface SpeciesDef { file: string; height: number; glow?: boolean; base: { speed: number }; seed: number }
const SPECIES: Record<Species, SpeciesDef> = {
    deer: { file: "Deer.glb", height: 2.9, base: { speed: 1 }, seed: Math.random() },
    fox: { file: "Fox.glb", height: 0.8, glow: true, base: { speed: 2 }, seed: Math.random() },
    hen: { file: "Hen.glb", height: 0.4, base: { speed: 0.5 }, seed: Math.random() },
};
export function speciesSpeed(type: Species): number { return SPECIES[type].base.speed; }
export function isSpecies(value: string): value is Species { return Object.prototype.hasOwnProperty.call(SPECIES, value); }
function optionsFor(type: Species, capacity: number): HerdOptions {
    const def = SPECIES[type];
    return { file: def.file, height: def.height, glow: def.glow, capacity };
}
export async function buildHerds(engine: EngineContext, capacity: number): Promise<Herd[]> {
    const types = Object.keys(SPECIES) as Species[];
    return Promise.all(types.map((type) => herd(engine, optionsFor(type, capacity))));
}
`,
        );
        writeFileSync(
            join(directory, "herd.ts"),
            `import { createShaderMaterial, createStorageBuffer, updateStorageBuffer, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
export interface HerdOptions { file: string; height: number; glow?: boolean; capacity: number; fade?: boolean; dither?: boolean }
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*HEIGHT*/, 1.0);
  return out;
}\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.2, 1.0); }\`;
export interface Herd { material: ShaderMaterial; label(): string }
const seen = new WeakSet<HerdOptions>();
async function prepare(opts: HerdOptions): Promise<number> {
    await Promise.resolve();
    return opts.capacity;
}
interface SurfaceOptions { height: number; glow?: boolean; fade?: boolean; dither?: boolean }
function surface(engine: EngineContext, name: string, opts: SurfaceOptions): ShaderMaterial {
    let vertex = VERTEX.replace("/*HEIGHT*/", String(opts.height));
    if (opts.glow) vertex = vertex.replace("input.position", "(input.position * 1.1)");
    if (opts.fade) vertex = vertex.replace("1.0);", "0.5);");
    if (opts.dither) vertex = vertex.replace("out.position", "out.position * 0.5");
    return createShaderMaterial({ name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
function build(engine: EngineContext, opts: HerdOptions, capacity: number): Herd {
    seen.add(opts);
    const fade = opts.fade === true;
    const fadeBuffer = fade ? createStorageBuffer(engine, 16, "fade") : null;
    if (fadeBuffer) updateStorageBuffer(engine, fadeBuffer, new Float32Array(4));
    const material = surface(engine, opts.file + capacity, {
        height: opts.height,
        glow: opts.glow,
        fade: opts.fade === true,
        dither: opts.dither,
    });
    return {
        material,
        label(): string {
            return "herd " + opts.file;
        },
    };
}
export async function herd(engine: EngineContext, opts: HerdOptions): Promise<Herd> {
    const capacity = await prepare(opts);
    return build(engine, opts, capacity);
}
`,
        );
        const result = compileSource(
            `import { addToScene, createArcRotateCamera, createEngine, createPlane, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
import { buildHerds, isSpecies, speciesSpeed } from "./species";
${repaired ? 'import { repairNonFinite } from "./repair";\n' : ""}const worker = new Worker(new URL("./noop-worker.ts", import.meta.url), { type: "module" });
worker.terminate();
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });
${repaired ? '    if (repairNonFinite(JSON.parse(\'{"x":1e999,"y":{"z":2}}\'))) console.log("repaired");\n' : ""}    const herds = await buildHerds(engine, 8);
    const plane = createPlane(engine, { width: 2, height: 2 });
    plane.material = herds[0]!.material;
    console.log(herds[1]!.label());
    addToScene(scene, plane);
    console.log(speciesSpeed(isSpecies(String(Math.random())) ? "fox" : "deer"));
    await registerScene(scene);
    await startEngine(engine);
}
void main();
`,
            {
                fileName: join(directory, "entry.ts"),
            },
        );
        assert.deepEqual(
            result.manifest.customShaderPrograms.map((program) => [
                /\* ([0-9.]+), ([0-9.]+)\)/
                    .exec(program.vertexSource)
                    ?.slice(1),
                program.vertexSource.includes("(input.position * 1.1)"),
            ]),
            [
                [["2.9", "1.0"], false],
                [["0.8", "1.0"], true],
                [["0.4", "1.0"], false],
            ],
        );
        // The buffer only a present `fade` creates is never made or written.
        assert.doesNotMatch(result.cpp, /bbl::update_storage_buffer\(/);
    }
});

test("a known-key read of a native table folds the members a repair of a parsed value cannot replace, and runs as JavaScript does", (t) => {
    // The repair resets a parsed value's non-finite number; the table's
    // entry, its string, its finite numbers and the member it lacks are
    // none, so the read by a literal key folds while the loop's run-time
    // keys read the native table.
    const source = `
type Kind = "deer" | "fox";
interface Def { file: string; height: number; bad: number; glow?: boolean; seed: number }
const TABLE: Record<Kind, Def> = {
    deer: { file: "Deer.glb", height: 2.9, bad: 3, seed: Math.random() },
    fox: { file: "Fox.glb", height: 0.8, bad: 1, glow: true, seed: Math.random() },
};
${REPAIR.replace("export ", "")}
function describe(kind: Kind): string {
    const def = TABLE[kind];
    return def.file + ":" + def.height + ":" + def.bad + ":" + (def.glow ? "glow" : "plain");
}
const saved = JSON.parse('{"a":1,"b":{"c":2}}') as { a: number; b: { c: number } };
saved.a /= 0;
if (!repairNonFinite(saved) || saved.a !== 0 || saved.b.c !== 2) throw new Error("repair");
const kinds = Object.keys(TABLE) as Kind[];
const seen = kinds.map((kind) => describe(kind)).join(",");
if (seen !== "Deer.glb:2.9:3:plain,Fox.glb:0.8:1:glow") throw new Error(seen);
if (describe("deer") !== "Deer.glb:2.9:3:plain") throw new Error("deer " + describe("deer"));
`;
    runInNewContext(transpileCommonJs(source, "native-table-repair.ts"), {
        exports: {},
    });
    const result = compileSource(source);
    // The known key's description is generation's: its check folds away.
    assert.doesNotMatch(result.cpp, /"deer "/);
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "compiler/native-table-repair", result.cpp, {
        expectedOutput: "",
    });
});

test("an async callee's optional record parameter it was handed reads its members without a presence test", () => {
    // The argument is a record, so the parameter's object is present.
    const result = compileSource(`
        interface Lit { glow?: boolean; tint: number }
        const seen = new WeakSet<Lit>();
        async function shade(lit?: Lit): Promise<number> {
            await Promise.resolve();
            if (lit) seen.add(lit);
            return (lit?.glow ? 1 : 0) + (lit?.tint ?? 0);
        }
        async function main(): Promise<void> {
            const lighting: Lit = { glow: true, tint: 2 };
            console.log(await shade(lighting));
        }
        void main();
    `);
    assert.doesNotMatch(result.cpp, /optional_chain/);
});

test("a table entry a shared helper builds from a module constant keeps its known fields", () => {
    // The helper spreads a module constant, reads its fields, and computes
    // one through a local: its shared call keeps the fields the body knows,
    // and the table read by an arm's key keeps the entry present.
    const programs = (source: string): readonly string[] =>
        compileSource(source).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        );
    for (const source of [
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Bounds { minY: number; maxY: number }
interface Profile { file: string; height: number; bounds: Bounds; shared?: boolean; tint: "body" | false }
const BASE: Profile = { file: "base.glb", height: 4.4, bounds: { minY: 0, maxY: 1.7 }, tint: "body" };
const DEMO = typeof location === "undefined" ? false : location.search.includes("demo");
function allows(kind: Kind): boolean { return kind !== "b"; }
function matched(file: string, bounds: Readonly<Bounds>): Profile {
    const height = (bounds.maxY - bounds.minY) * BASE.height / (BASE.bounds.maxY - BASE.bounds.minY);
    return { ...BASE, file, height, bounds, shared: true };
}
const MODELS: Readonly<{ a: Profile } & Partial<Record<Kind, Profile>>> = {
    a: BASE,
    b: matched("b.glb", { minY: 0, maxY: 1.6 }),
};
function profile(kind: Kind): Profile {
    const p = MODELS[kind] ?? BASE;
    if (!p) throw new Error(\`no \${kind}\`);
    return p;
}
function options(kind: Kind) {
    const p = profile(kind);
    return { file: p.file, shared: p.shared === true, tinted: p.tint !== false } as const;
}
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
function surface(engine: EngineContext, o: { file: string; shared: boolean; tinted: boolean }): ShaderMaterial {
    const vertex = VERTEX.replace("/*S*/", o.shared ? (o.tinted ? "0.5" : "0.6") : "1.0");
    return createShaderMaterial({ name: o.file, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): ShaderMaterial => surface(engine, options(kind));
    kinds.map(build);
}
void main();
`,
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Bounds { minY: number; maxY: number }
interface Profile { file: string; height: number; bounds: Bounds; shared?: boolean; tint: "body" | false }
const BASE: Profile = { file: "base.glb", height: 4.4, bounds: { minY: 0, maxY: 1.7 }, tint: "body" };
const DEMO = typeof location === "undefined" ? false : location.search.includes("demo");
function allows(kind: Kind): boolean { return kind !== "b"; }
function matched(file: string, bounds: Readonly<Bounds>): Profile {
    return { ...BASE, file, height: BASE.height, bounds, shared: true };
}
const MODELS: Readonly<{ a: Profile } & Partial<Record<Kind, Profile>>> = {
    a: BASE,
    b: matched("b.glb", { minY: 0, maxY: 1.6 }),
};
function profile(kind: Kind): Profile {
    const p = MODELS[kind] ?? BASE;
    if (!p) throw new Error(\`no \${kind}\`);
    return p;
}
function options(kind: Kind) {
    const p = profile(kind);
    return { file: p.file, shared: p.shared === true, tinted: p.tint !== false } as const;
}
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
function surface(engine: EngineContext, o: { file: string; shared: boolean; tinted: boolean }): ShaderMaterial {
    const vertex = VERTEX.replace("/*S*/", o.shared ? (o.tinted ? "0.5" : "0.6") : "1.0");
    return createShaderMaterial({ name: o.file, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    const build = (kind: Kind): ShaderMaterial => surface(engine, options(kind));
    kinds.map(build);
}
void main();
`,
    ])
        assert.deepEqual(programs(source), ["1.0", "0.5"]);
});

test("an options record a known key selects between literals keeps its fields through an async call", () => {
    // Nine flags exceed one call's run-time tests, so the call splits on
    // the kind; each arm's options helper selects one literal, and its
    // fields reach the material through an async function's parameter.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type SceneContext, type ShaderMaterial } from "@babylonjs/lite";
type Kind = "a" | "b";
interface Opts { file: string; f1?: boolean; f2?: boolean; f3?: boolean; f4?: boolean; f5?: boolean; f6?: boolean; f7?: boolean; f8?: boolean; f9?: boolean; capacity: number }
interface Prepared { claimed: Set<SceneContext>; count: number }
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
const cache = new Map<string, Prepared>();
async function prepare(opts: Opts): Promise<Prepared> {
    const known = cache.get(opts.file);
    if (known) return known;
    const fresh: Prepared = { claimed: new Set(), count: opts.capacity };
    await Promise.resolve();
    cache.set(opts.file, fresh);
    return fresh;
}
function build(engine: EngineContext, opts: Opts, prepared: Prepared): ShaderMaterial {
    let scale = "1.0";
    if (opts.f1 === true) scale += " * 1.1";
    if (opts.f2 === true) scale += " * 1.2";
    if (opts.f3 === true) scale += " * 1.3";
    if (opts.f4 === true) scale += " * 1.4";
    if (opts.f5 === true) scale += " * 1.5";
    if (opts.f6 === true) scale += " * 1.6";
    if (opts.f7 === true) scale += " * 1.7";
    if (opts.f8 === true) scale += " * 1.8";
    if (opts.f9 === true) scale += " * 1.9";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name: \`creature-\${opts.file}-\${prepared.count}\`, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function create(engine: EngineContext, scene: SceneContext, opts: Opts): Promise<ShaderMaterial> {
    let prepared = await prepare(opts);
    if (prepared.claimed.has(scene)) prepared = { claimed: new Set(), count: opts.capacity };
    prepared.claimed.add(scene);
    return build(engine, opts, prepared);
}
function options(kind: Kind): Opts {
    return kind === "a" ? { file: "a.glb", f1: true, f3: true, capacity: 4 } : { file: "b.glb", f2: true, f9: true, capacity: 8 };
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine);
    const kinds = (["a", "b"] as const).filter(() => Math.random() < 2);
    await Promise.all(kinds.map((kind) => create(engine, scene, options(kind))));
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1] ??
                "",
        );
    assert.deepEqual(programs, ["1.0 * 1.1 * 1.3", "1.0 * 1.2 * 1.9"]);
});

test("a record argument known present stays present in an async function's parameter", () => {
    // `lit?.f5` reads the record the call passes: it is no run-time
    // test, so the nine flags compose one program.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Opts { name: string; f1?: boolean; f2?: boolean; f3?: boolean; f4?: boolean; f5?: boolean; f6?: boolean; f7?: boolean; f8?: boolean; f9?: boolean }
async function create(engine: EngineContext, opts: Opts): Promise<ShaderMaterial> {
    await Promise.resolve();
    let scale = "1.0";
    if (opts.f1 === true) scale += " * 1.1";
    if (opts.f2 === true) scale += " * 1.2";
    if (opts.f3 === true) scale += " * 1.3";
    if (opts.f4 === true) scale += " * 1.4";
    if (opts.f5 === true) scale += " * 1.5";
    if (opts.f6 === true) scale += " * 1.6";
    if (opts.f7 === true) scale += " * 1.7";
    if (opts.f8 === true) scale += " * 1.8";
    if (opts.f9 === true) scale += " * 1.9";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name: opts.name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function preload(engine: EngineContext, lit?: { f5?: boolean; f6?: boolean }, f4 = false): Promise<ShaderMaterial[]> {
    const build = (name: string): Promise<ShaderMaterial> => create(engine, { name, f1: true, f2: false, f3: true, f4, f5: lit?.f5, f6: lit?.f6, f7: false, f8: true, f9: false });
    const names = ["a", "b", "c"].filter(() => Math.random() < 2);
    return Promise.all(names.map(build));
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    await preload(engine, { f5: true, f6: false }, false);
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1] ??
                "",
        );
    assert.deepEqual(programs, ["1.0 * 1.1 * 1.3 * 1.5 * 1.8"]);
});

test("a native helper's returned record keeps the fields its body knows, and two known strings compare at generation", () => {
    // `options(24)` compiles to a native function; its result still says
    // `dir` is "humans" and `fade` is true, directly, through a spread into
    // an options literal, and through an async call's parameter.
    const programs = (source: string): readonly string[] =>
        compileSource(source).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        );
    assert.deepEqual(
        programs(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Opts { dir?: string; fade?: boolean; extra?: boolean; capacity: number }
function options(capacity: number) {
    return { dir: "humans", fade: true, capacity } as const;
}
async function create(engine: EngineContext, opts: Opts): Promise<ShaderMaterial> {
    await Promise.resolve();
    const vertex = VERTEX.replace("/*S*/", opts.fade === true ? (opts.dir === "humans" ? "0.5" : "0.6") : "1.0");
    return createShaderMaterial({ name: \`m\${opts.capacity}\`, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    await create(engine, { ...options(24), extra: false });
}
void main();
`),
        ["0.5"],
    );
    assert.deepEqual(
        programs(`import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Opts { dir?: string; fade?: boolean; extra?: boolean; capacity: number }
function options(capacity: number) {
    return { dir: "humans", fade: true, capacity } as const;
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const direct = options(24);
    const a = VERTEX.replace("/*S*/", direct.dir === "humans" ? "0.5" : "0.6");
    createShaderMaterial({ name: "a", vertexSource: wgsl\`\${a}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
    const spread: Opts = { ...options(24), extra: false };
    const b = VERTEX.replace("/*S*/", spread.dir === "humans" ? "0.7" : "0.8");
    createShaderMaterial({ name: "b", vertexSource: wgsl\`\${b}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`),
        ["0.5", "0.7"],
    );
});

test("a native helper's returned record literal is an object an optional field holds", () => {
    // `scaleOf` tests the optional `profile` its options hold: the record
    // `profileOf()` returns is there. A helper that may return `undefined`
    // leaves the test a run-time one.
    const source = (helper: string): string =>
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
interface Profile { readonly a: number }
interface Opts { profile?: Profile | undefined }
${helper}
function scaleOf(opts: Opts): string { const p = opts.profile; return p ? p.a.toFixed(1) : "1.0"; }
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const profile = profileOf();
    const scale = scaleOf({ profile });
    const vertex = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * \${scale}, 1.0); return out; }\`;
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertex}\`, fragmentSource: wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`;
    assert.deepEqual(
        compileSource(
            source(
                "function profileOf(): Profile { return Object.freeze({ a: 0.4 }); }",
            ),
        ).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        ),
        ["0.4"],
    );
    assert.throws(
        () =>
            compileSource(
                source(
                    "function profileOf(): Profile | undefined { return Math.random() > 2 ? undefined : Object.freeze({ a: 0.4 }); }",
                ),
            ),
        /'vertex' is bound as data without a static string/,
    );
});

test("a static record's number field folds inside a Math call whatever another record's whole-object writes", () => {
    // `reset` assigns over a `Toggle`, which the options type's `enabled`
    // could view; the options record `limitOf` reads is a static one, so its
    // `max` is what reading it yields. Writing that record leaves the read
    // a run-time one.
    const source = (body: string): string =>
        `import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
interface Opts { max?: number; enabled?: boolean }
interface Toggle { enabled: boolean; label: string }
const toggle: Toggle = { enabled: true, label: "a" };
function reset(target: Toggle): void { Object.assign(target, { enabled: false }); }
function limitOf(options: Opts = {}): number { return Math.max(1, options.max ?? 40); }
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    reset(toggle);
    console.log(toggle.enabled);
    ${body}
    const vertex = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * \${limit.toFixed(1)}, 1.0); return out; }\`;
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertex}\`, fragmentSource: wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`;
    assert.deepEqual(
        compileSource(
            source("const limit = limitOf({ max: 30 });"),
        ).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        ),
        ["30.0"],
    );
    assert.throws(
        () =>
            compileSource(
                source(
                    "const opts: Opts = { max: 30 }; Object.assign(opts, { max: 50 }); const limit = limitOf(opts);",
                ),
            ),
        /'vertex' is bound as data without a static string/,
    );
});

test("a parameter's scalar no write in the program replaces keeps its value when another field is written", () => {
    // `opts.count` is written, so the parameter is mutated; the flags no write
    // in the program reaches keep their values, and the nine compose one program.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Opts { name: string; count?: number; f1?: boolean; f2?: boolean; f3?: boolean; f4?: boolean; f5?: boolean; f6?: boolean; f7?: boolean; f8?: boolean; f9?: boolean }
const registered: Opts[] = [];
function remember(opts: Opts): number { registered.push(opts); for (const r of registered) r.count = (r.count ?? 0) + 1; return registered.length; }
async function create(engine: EngineContext, opts: Opts): Promise<ShaderMaterial> {
    opts.count = 1;
    remember(opts);
    await Promise.resolve();
    let scale = "1.0";
    if (opts.f1 === true) scale += " * 1.1";
    if (opts.f2 === true) scale += " * 1.2";
    if (opts.f3 === true) scale += " * 1.3";
    if (opts.f4 === true) scale += " * 1.4";
    if (opts.f5 === true) scale += " * 1.5";
    if (opts.f6 === true) scale += " * 1.6";
    if (opts.f7 === true) scale += " * 1.7";
    if (opts.f8 === true) scale += " * 1.8";
    if (opts.f9 === true) scale += " * 1.9";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name: opts.name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function preload(engine: EngineContext, lit?: { f5?: boolean; f6?: boolean }, f4 = false): Promise<ShaderMaterial[]> {
    const build = (name: string): Promise<ShaderMaterial> => create(engine, { name, f1: true, f2: false, f3: true, f4, f5: lit?.f5, f6: lit?.f6, f7: false, f8: true, f9: false });
    const names = ["a", "b", "c"].filter(() => Math.random() < 2);
    return Promise.all(names.map(build));
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    await preload(engine, { f5: true, f6: false }, false);
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1] ??
                "",
        );
    assert.deepEqual(programs, ["1.0 * 1.1 * 1.3 * 1.5 * 1.8"]);
});

test("a shared options record keeps what it knows of its members' presence", () => {
    // The options a map holds and the program writes are one shared object:
    // its coat, a constant the call sets, is present, and the flags it
    // leaves unset are absent, through a stored copy and a field read.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Coat { tint: number }
const COAT: Coat = { tint: 0.5 };
interface Opts { name: string; count?: number; coat?: Coat; f1?: boolean; f2?: boolean; f3?: boolean; f4?: boolean; f5?: boolean; f6?: boolean; f7?: boolean; f8?: boolean; f9?: boolean }
const live = new Map<string, Opts>();
function build(engine: EngineContext, opts: Opts): ShaderMaterial {
    let scale = "1.0";
    if (opts.coat) scale += " * 0.9";
    if (opts.f1 === true) scale += " * 1.1";
    if (opts.f2 === true) scale += " * 1.2";
    if (opts.f3 === true) scale += " * 1.3";
    if (opts.f4 === true) scale += " * 1.4";
    if (opts.f5 === true) scale += " * 1.5";
    if (opts.f6 === true) scale += " * 1.6";
    if (opts.f7 === true) scale += " * 1.7";
    if (opts.f8 === true) scale += " * 1.8";
    if (opts.f9 === true) scale += " * 1.9";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name: opts.name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function create(engine: EngineContext, opts: Opts): Promise<ShaderMaterial> {
    live.set(opts.name, opts);
    await Promise.resolve();
    return build(engine, opts);
}
function touch(): void { for (const o of live.values()) o.count = (o.count ?? 0) + 1; }
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const names = ["a", "b", "c"].filter(() => Math.random() < 2);
    await Promise.all(names.map((name) => create(engine, { name, coat: COAT, f1: true, f3: true, f8: true })));
    touch();
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1] ??
                "",
        );
    assert.deepEqual(programs, ["1.0 * 0.9 * 1.1 * 1.3 * 1.8"]);
});

test("a case split reads a value generation knows absent as no test", () => {
    // Three run-time tests split the call; the options' unset flags, passed
    // on as values, are known absent and add none.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl, type EngineContext, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Coat { tint: number }
const COAT: Coat = { tint: 0.5 };
interface Opts { name: string; count?: number; coat?: Coat; f1?: boolean; f2?: boolean; f3?: boolean; f4?: boolean; f5?: boolean; f6?: boolean; f7?: boolean; f8?: boolean; f9?: boolean }
const live = new Map<string, Opts>();
interface Surface { name: string; coat?: Coat; f1?: boolean; f2?: boolean; f3?: boolean; f4?: boolean; f5?: boolean; f6?: boolean; f7?: boolean; f8?: boolean; f9?: boolean; x: boolean; y: boolean; z: boolean }
function surface(engine: EngineContext, o: Surface): ShaderMaterial {
    let scale = o.x ? "1.0" : "2.0";
    if (o.y) scale += " * 0.7";
    if (o.z) scale += " * 0.6";
    if (o.coat) scale += " * 0.9";
    if (o.f1 === true) scale += " * 1.1";
    if (o.f2 === true) scale += " * 1.2";
    if (o.f3 === true) scale += " * 1.3";
    if (o.f4 === true) scale += " * 1.4";
    if (o.f5 === true) scale += " * 1.5";
    if (o.f6 === true) scale += " * 1.6";
    if (o.f7 === true) scale += " * 1.7";
    if (o.f8 === true) scale += " * 1.8";
    if (o.f9 === true) scale += " * 1.9";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name: o.name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
function build(engine: EngineContext, opts: Opts, part: { x: boolean; y: boolean; z: boolean }): ShaderMaterial {
    return surface(engine, { name: opts.name, coat: opts.coat, f1: opts.f1, f2: opts.f2, f3: opts.f3, f4: opts.f4, f5: opts.f5, f6: opts.f6, f7: opts.f7, f8: opts.f8, f9: opts.f9, x: part.x, y: part.y, z: part.z });
}
async function create(engine: EngineContext, opts: Opts): Promise<ShaderMaterial> {
    live.set(opts.name, opts);
    await Promise.resolve();
    const part = { x: Math.random() < 0.5, y: Math.random() < 0.5, z: Math.random() < 0.5 };
    return build(engine, opts, part);
}
function touch(): void { for (const o of live.values()) o.count = (o.count ?? 0) + 1; }
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const names = ["a", "b", "c"].filter(() => Math.random() < 2);
    await Promise.all(names.map((name) => create(engine, { name, coat: COAT, f1: true, f3: true, f8: true })));
    touch();
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1] ??
                "",
        );
    assert.equal(programs.length, 8);
    assert.ok(
        programs.every((scale) => scale.endsWith(" * 0.9 * 1.1 * 1.3 * 1.8")),
    );
});

test("a config record's object field and a weak record type's member stay present", () => {
    // The lighting record's highlight is a config field its type declares
    // an object; the lighting type's properties are all optional, so only a
    // value sharing one of them can be viewed as it, and the engine call that
    // may write the shadow generator writes no lighting record.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, createDirectionalLight, addToScene, createCsmDirectionalShadowGenerator, setShadowGeneratorEnabled, wgsl, type EngineContext, type ShaderMaterial, type ShadowGenerator } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * /*S*/, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Highlight { color: [number, number, number]; strength: number }
interface Config { interaction: { light: Highlight; radius: number } }
function loadConfig(radius: number): Config { return { interaction: { light: { color: [1, 0.4, 0.1], strength: 0.2 }, radius } }; }
interface Lighting { shadow?: ShadowGenerator; highlight?: Highlight; tint?: number }
interface Opts { name: string; highlight?: Highlight; x: boolean; y: boolean; z: boolean; w: boolean }
function surface(engine: EngineContext, o: Opts): ShaderMaterial {
    let scale = o.x ? "1.0" : "2.0";
    if (o.y) scale += " * 0.7";
    if (o.z) scale += " * 0.6";
    if (o.w) scale += " * 0.5";
    if (o.highlight) scale += " * 1.1";
    const vertex = VERTEX.replace("/*S*/", scale);
    return createShaderMaterial({ name: o.name, vertexSource: wgsl\`\${vertex}\`, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
async function preload(engine: EngineContext, lit?: Lighting): Promise<ShaderMaterial[]> {
    const build = (name: string): ShaderMaterial => {
        const part = { x: Math.random() < 0.5, y: Math.random() < 0.5, z: Math.random() < 0.5, w: Math.random() < 0.5 };
        return surface(engine, { name, highlight: lit?.highlight, x: part.x, y: part.y, z: part.z, w: part.w });
    };
    await Promise.resolve();
    return ["a", "b"].filter(() => Math.random() < 2).map(build);
}
const bag: Record<string, unknown> = {};
const lights: Lighting[] = [];
function put(o: Record<string, unknown>, k: string, v: unknown): void { o[k] = v; }
async function main(): Promise<void> {
    put(bag, String(Math.random()), 1);
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine);
    const sun = createDirectionalLight([-0.5, -1, -0.4], 1.2);
    addToScene(scene, sun);
    const shadow = createCsmDirectionalShadowGenerator(engine, sun, { mapSize: 1024, numCascades: 3 });
    setShadowGeneratorEnabled(shadow, true);
    const config = loadConfig(Math.random());
    const lighting: Lighting = { shadow, highlight: config.interaction.light, tint: config.interaction.radius };
    lights.push(lighting);
    await preload(engine, lighting);
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([^,]+), 1\.0/.exec(program.vertexSource)?.[1] ??
                "",
        );
    assert.equal(programs.length, 16);
    assert.ok(programs.every((scale) => scale.endsWith(" * 1.1")));
});

test("a string search over known text and position folds, and a known string has a known length", () => {
    // A shader variant replaces a token it requires once: indexOf, indexOf
    // from the position after it, and the slices around it are known.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
const HEAD = "// skinned";
function vertexFor(bones: boolean, scale: number): string {
    return \`\${HEAD}
struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * \${bones ? scale : 1}, 1.0); return out; }\`;
}
function withPresence(vertex: string): { vertex: string } {
    const output = "struct VertexOutput {";
    const field = \`\${output} @location(9) vPresence: f32,\`;
    const once = (source: string, token: string, replacement: string): string => {
        const at = source.indexOf(token);
        if (at < 0 || source.indexOf(token, at + token.length) >= 0) throw new Error(\`token not unique: \${token}\`);
        return source.slice(0, at) + replacement + source.slice(at + token.length);
    };
    return { vertex: once(vertex, output, field) };
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    let vertexSource = vertexFor(true, 0.5);
    const present = withPresence(vertexSource);
    vertexSource = present.vertex;
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertexSource}\`, fragmentSource: wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        );
    assert.deepEqual(programs, ["0.5"]);
});

test("a const holding a fresh record only read through its properties keeps the record's fields", () => {
    // A dynamic-key write on a dictionary may reach any record of string
    // fields, but not the helper's fresh result a const holds and only reads.
    const programs =
        compileSource(`import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
const VERTEX = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * 0.5, 1.0); return out; }\`;
const FRAGMENT = "@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }";
type Sources = { vertex: string; fragment: string };
function withTag(vertex: string, fragment: string): Sources {
    return { vertex: \`// tagged\\n\${vertex}\`, fragment };
}
const kept: Sources[] = [];
const names: Record<string, string> = {};
function put(record: Record<string, string>, key: string, value: string): void { record[key] = value; }
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    kept.push({ vertex: "a", fragment: "b" });
    put(names, String(Math.random()), "x");
    let vertexSource = VERTEX;
    const present = withTag(vertexSource, FRAGMENT);
    vertexSource = present.vertex;
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertexSource}\`, fragmentSource: wgsl\`\${present.fragment}\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`).manifest.customShaderPrograms.map(
            (program) =>
                /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
        );
    assert.deepEqual(programs, ["0.5"]);
});

test("a field a const's literal stores keeps its nested record's fields", () => {
    // The defaults' `drops` object is the one their literal creates there,
    // so a write through a function's own fresh dictionary reaches none of
    // its fields; writing it through another reference or replacing it
    // leaves the field a run-time read.
    const source = `import { createEngine, createSceneContext, createShaderMaterial, wgsl } from "@babylonjs/lite";
interface Config { drops: { saturationDrift: number }; level: string }
const DEFAULT_CONFIG: Config = { drops: { saturationDrift: 0.5 }, level: "high" };
const configs: Config[] = [DEFAULT_CONFIG, { drops: { saturationDrift: 0.1 }, level: "low" }];
function tally(names: readonly string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    return counts;
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    createSceneContext(engine);
    const picked = configs[Math.floor(Math.random() * configs.length)]!;
    console.log(picked.level, picked.drops === DEFAULT_CONFIG.drops, Object.keys(tally([picked.level, "x"])).length);
    const tone = DEFAULT_CONFIG.drops.saturationDrift;
    const vertex = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * \${tone.toFixed(1)}, 1.0); return out; }\`;
    createShaderMaterial({ name: "m", vertexSource: wgsl\`\${vertex}\`, fragmentSource: wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
}
void main();
`;
    const programs = compileSource(source).manifest.customShaderPrograms.map(
        (program) =>
            /position \* ([0-9.]+)/.exec(program.vertexSource)?.[1] ?? "",
    );
    assert.deepEqual(programs, ["0.5"]);
    for (const write of [
        "picked.drops.saturationDrift = 2;",
        "picked.drops = { saturationDrift: 3 };",
    ])
        assert.throws(
            () =>
                compileSource(
                    source.replace(
                        "const tone = DEFAULT_CONFIG",
                        `${write} const tone = DEFAULT_CONFIG`,
                    ),
                ),
            /'vertex' is bound as data without a static string/,
        );
});

test("a record's own scalars stay generation-known beside handles its callee hands on", () => {
    const program = (write: string, helper = ""): string => `
        import { createEngine, createSceneContext, type EngineContext, type SceneContext } from "@babylonjs/lite";
        interface Options { engine: EngineContext; scene: SceneContext; tint?: boolean; name?: string }
        function paint(scene: SceneContext): void { scene.clearColor = { r: 0.1, g: 0.1, b: 0.1, a: 1 }; }
        ${helper}
        function describe(opts: Options): string {
            // The scene is written through; it is no way back to the options.
            paint(opts.scene);
            ${write}
            const label = opts.tint ? "tinted" : "plain";
            return label + (opts.name ?? "");
        }
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const options = { engine, scene, tint: true, name: "body" };
            console.log(describe(options));
        }
        main().catch(console.error);
    `;
    assert.match(
        compileSource(program("")).cpp,
        /std::string v_fn\d+_label = "tinted";/,
    );
    // A write of the scalar itself, or by a helper handed the record, is read where it is stored.
    for (const [write, helper] of [
        ["if (Date.now() > 0) opts.tint = false;", ""],
        [
            "retint(opts);",
            "function retint(o: Options): void { if (Date.now() > 0) o.tint = false; }",
        ],
    ] as const)
        assert.match(
            compileSource(program(write, helper)).cpp,
            /std::string v_fn\d+_label = \(v_fn\d+_opts->tint \? "tinted" : "plain"\);/,
        );
});

test("uses a boolean fallback for an explicitly undefined record property", () => {
    const result = compileSource(
        `
        import { createEngine, loadTexture2D } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const settings = [
                { invertY: undefined },
                { invertY: false },
            ];
            for (const setting of settings) {
                await loadTexture2D(
                    engine,
                    "/textures/nme/ebf71b300f43563f.png",
                    { invertY: setting.invertY ?? true },
                );
            }
        }
    `,
        labDeployment,
    );

    const loads = result.cpp.match(/bbl::load_file_texture\([^;]+/g) ?? [];
    assert.equal(loads.length, 2);
    assert.match(loads[0], /, true, false, false\)/);
    assert.match(loads[1]!, /, false, false, false\)/);
});

test("lowers early bare returns from native frame callbacks", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            onBeforeRender,
            stopEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            let frozen = false;
            let frames = 0;
            onBeforeRender(scene, () => {
                if (frozen) {
                    return;
                }
                frames++;
                if (frames >= 2) {
                    frozen = true;
                    return;
                }
                if (frames === 99) {
                    return stopEngine(engine);
                }
                frames += 10;
            });
        }
    `);

    assert.equal(result.cpp.match(/return;/g)?.length, 3);
    assert.match(result.cpp, /if \(v_frozen\) \{/);
    assert.match(
        result.cpp,
        /if \(v_frames == 99\.0\) \{\s*bbl::stop_engine\(v_engine\);\s*return;/,
    );
    assert.match(result.cpp, /v_frames \+= 10\.0;/);
});

test("retains frame callback closure storage after its installer returns", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            onBeforeRender,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const button = document.createElement("button");
            button.addEventListener("click", () => {
                let disposed = false;
                onBeforeRender(scene, () => {
                    if (disposed) return;
                });
                window.addEventListener("pointerdown", () => {
                    disposed = true;
                });
            });
            document.body.appendChild(button);
        }
    `);

    const disposed = result.cpp.match(
        /auto (v_\w*disposed) = bbl::js::make_gc_shared<[^;]+;/,
    )?.[1];
    assert.ok(disposed);
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::on_before_render\\([^,]+, bbl::js::make_closure\\(bblscene::bbl_environment_\\w+\\{${disposed}\\}, bblscene::\\w+`,
        ),
    );
    assert.match(result.cpp, new RegExp(`if \\(\\(\\*${disposed}\\)\\)`));
    assert.doesNotMatch(
        result.cpp,
        new RegExp(`bbl::on_before_render\\([^\\n]*std::ref\\(${disposed}\\)`),
    );
});

test("retains an escaping recursive callback's closure and self reference", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            let busy = false;
            let queued = false;
            const run = (): void => {
                busy = true;
                try {
                    queued = queued && busy;
                } finally {
                    busy = false;
                    if (queued) {
                        queued = false;
                        void run();
                    }
                }
            };
            window.addEventListener("pointermove", () => {
                if (busy) queued = true;
                else void run();
            });
        }
    `);

    const owner = result.cpp.match(
        /auto (v_\w*run_owner) = bbl::js::make_gc_shared<bbl::js::Callback<void\(\)>>\(\);/,
    )?.[1];
    assert.ok(owner);
    assert.match(
        result.cpp,
        new RegExp(
            `\\(\\*${owner}\\) = bbl::js::make_closure\\(bblscene::bbl_environment_\\w+\\{v_busy, v_queued, ${owner}\\}, bblscene::\\w+`,
        ),
    );
    const mouseCaptures = result.cpp.match(
        /bbl::on_dom_pointer\([^\n]*?bblscene::bbl_environment_\w+\{([^}]+)\}/,
    )?.[1];
    assert.deepEqual(
        mouseCaptures?.split(", ").sort(),
        ["v_busy", "v_queued", owner].sort(),
    );
    assert.doesNotMatch(result.cpp, new RegExp(`std::ref\\(${owner}\\)`));
});

test("restores outer symbols after explicit blocks", () => {
    const result = compileSource(`
        const value = 1;
        {
            const value = 2;
            const inside = value * 3;
        }
        const outside = value * 4;
    `);

    assert.match(result.cpp, /double v_value = 1\.0/);
    assert.match(result.cpp, /double v_block\d+_value = 2\.0/);
    assert.match(result.cpp, /double v_outside = \(1\.0 \* 4\.0\)/);
    assert.doesNotMatch(result.cpp, /v_outside = \(v_block\d+_value/);
});

test("lowers numeric for and while loops", () => {
    const result = compileSource(
        readFileSync(resolve("examples/control-flow-scene.ts"), "utf8"),
        {
            fileName: "examples/control-flow-scene.ts",
        },
    );

    const writes = [
        ...result.cpp.matchAll(
            /(v_fn\d+)_samples \+= static_cast<double>\(v_\w+_index\);/g,
        ),
    ];
    assert.equal(writes.length, 1);
    const scope = writes[0]![1];
    assert.ok(writes.every((write) => write[1] === scope));
    assert.match(
        result.cpp,
        new RegExp(`while \\(${scope}_remaining > 0\\.0\\)`),
    );
    assert.match(result.cpp, new RegExp(`${scope}_remaining--`));
});

test("evaluates shared method calls inside loop conditions", () => {
    const result = compileSource(`
        import {
            createEngine,
            createTransformNode,
            type TransformNode,
        } from "@babylonjs/lite";

        class Scanner {
            private readonly marker: TransformNode;
            constructor() {
                this.marker = createTransformNode("marker");
            }
            occupied(height: number): boolean {
                return height < this.marker.position.x + 3;
            }
        }

        await createEngine({});
        const scanner = new Scanner();
        let height = 0;
        while (scanner.occupied(height)) {
            height++;
        }
    `);

    assert.match(
        result.cpp,
        /while \(bbl::js::make_closure\([^\n]+, bblscene::bbl_recursive_fn\d+_group\)\(v_height\)\) \{/,
    );
});

test("lowers break and continue in runtime loops", () => {
    const result = compileSource(`
        let total = 0;
        let index = 0;
        while (index < 10) {
            index++;
            if (index === 3) {
                continue;
            }
            if (index > 6) {
                break;
            }
            total += index;
        }
    `);

    assert.match(result.cpp, /continue;/);
    assert.match(result.cpp, /break;/);
    assert.match(result.cpp, /while \(v_index < 10\.0\)/);
});

test("keeps the for incrementor reachable from continue", () => {
    const result = compileSource(`
        let total = 0;
        for (let index = 0; index < count(); index++) {
            if (index === 1) {
                continue;
            }
            total += index;
        }
        function count(): number {
            return 4;
        }
    `);

    assert.match(
        result.cpp,
        /for \(; static_cast<double>\(v_block\d+_index\) < bblscene::count\(\); \+\+v_block\d+_index\) \{/,
    );
    assert.match(result.cpp, /continue;/);
});

test("refuses unsupported properties on a native catch binding", () => {
    assert.throws(
        () =>
            compileSource(`
                try {
                    throw new Error("failed");
                } catch (error) {
                    const details = error.details;
                }
            `),
        /(?:Unsupported (?:data )?property|Static record has no property) 'details'/,
    );
});

test("does not carry a folded continue into the next static iteration", () => {
    const result = compileSource(`
        function selectTextures(json: unknown): Record<string, string> {
            const blocks = (json as {
                blocks?: Array<Record<string, unknown>>;
            }).blocks ?? [];
            const selected: Record<string, string> = {};
            for (const block of blocks) {
                if (block.customType !== "TextureBlock") continue;
                selected[block.name as string] = "loaded";
            }
            return selected;
        }

        const selected = selectTextures({
            blocks: [
                { customType: "InputBlock", name: "ignored" },
                { customType: "TextureBlock", name: "albedo" },
            ],
        });
        const albedo = selected.albedo;
    `);

    assert.match(
        result.cpp,
        /strict_equals\("TextureBlock"\)\)\) \{\s+continue;/,
    );
    assert.match(
        result.cpp,
        /\.set\([^\n]+read_property\("name"\)\.to_string\(\), "loaded"\);/,
    );
    assert.equal(result.cpp.match(/\.set\(/g)?.length, 1);
});

test("keeps a nested continue inside native loops", () => {
    const result = compileSource(`
        const board = new Uint8Array(4);
        let total = 0;
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                const value = board[y * 2 + x]!;
                if (value === 0) continue;
                total += value;
            }
        }
    `);

    assert.equal(result.cpp.match(/for \(; .*_x </g)?.length, 1);
    assert.equal(result.cpp.match(/for \(; .*_y </g)?.length, 1);
    assert.equal(result.cpp.match(/continue;/g)?.length, 1);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 1);
});

test("lowers a labeled break out of nested loops", () => {
    const result = compileSource(`
        let value = 0;
        outer: while (value < 2) {
            while (value < 1) {
                value++;
                break outer;
            }
        }
    `);

    assert.match(result.cpp, /goto v_bblite_label_outer_\d+;/);
    assert.match(result.cpp, /v_bblite_label_outer_\d+:;/);
});

test("lowers numeric switch statements to native branches", () => {
    const result = compileSource(`
        function scoreFor(lines: number): number {
            switch (lines) {
                case 1:
                    return 100;
                case 2:
                case 3:
                    return 300;
                default:
                    return 0;
            }
        }
        const score = scoreFor(2);
    `);

    assert.match(result.cpp, /const double v_bblite_switch_\d+ = v_fn0_lines;/);
    assert.match(result.cpp, /if \(v_bblite_switch_\d+ == 1\.0\) \{/);
    assert.match(
        result.cpp,
        /\} else if \(v_bblite_switch_\d+ == 2\.0 \|\| v_bblite_switch_\d+ == 3\.0\) \{/,
    );
    assert.match(result.cpp, /\} else \{/);
});

test("selects a falling-through switch clause by index", () => {
    const result = compileSource(`
        function pick(value: number): number {
            switch (value) {
                case 1:
                    value += 1;
                case 2:
                    return value;
                default:
                    return 0;
            }
        }
        const picks: Array<typeof pick> = [pick];
        const picked = picks[0]!(1);
    `);
    assert.match(
        result.cpp,
        /const int v_bblite_switch_\d+_selected = \(v_bblite_switch_\d+ == 1\.0\) \? 0 : \(v_bblite_switch_\d+ == 2\.0\) \? 1 : 2;/,
    );
    assert.match(result.cpp, /if \(v_bblite_switch_\d+_selected <= 1\) \{/);
});

test("keeps for-of over static arrays native", () => {
    const result = compileSource(
        readFileSync(resolve("examples/control-flow-scene.ts"), "utf8"),
        {
            fileName: "examples/control-flow-scene.ts",
        },
    );

    assert.equal(
        result.cpp.match(/samples \+= v_bblite_item_\d+;/g)?.length,
        1,
    );
    assert.match(result.cpp, /for \([^\n]*auto&&/);
});

test("keeps counted loops native even when their container has a known length", () => {
    const result = compileSource(`
        const rows: [number, number][] = [[1, 2], [3, 4], [5, 6]];
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            const [left, right] = rows[i]!;
            total += left + right + i;
        }
    `);

    assert.match(result.cpp, /for \(/);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 1);
});

test("keeps large constant-count data loops at runtime", () => {
    const result = compileSource(`
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            bytes[i] = i;
        }
    `);

    assert.match(
        result.cpp,
        /for \(; v_block\d+_i < 256; \+\+v_block\d+_i\) \{/,
    );
    assert.equal(
        result.cpp.match(
            /bbl::js::to_uint8\(static_cast<double>\(v_block\d+_i\)\)/g,
        )?.length,
        1,
    );
});

test("keeps helper construction loops native with every composition row", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "babylon-lite";
        function addBox(engine: Awaited<ReturnType<typeof createEngine>>): void {
            createBox(engine, 1);
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            for (let i = 0; i < 40; i++) {
                addBox(engine);
            }
        }
    `);

    assert.match(result.cpp, /for \(; \w+ < 40; \+\+\w+\)/);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 1);
    assert.equal(result.manifest.sceneMeshes.length, 40);
    assert.ok(
        result.manifest.sceneMeshes.every((mesh) => !mesh.runtimeInstances),
    );
});

test("grows JavaScript arrays on indexed writes", () => {
    const result = compileSource(`
        interface Row { value: number }
        const rows: Row[] = [];
        rows[4] = { value: 7 };
    `);

    assert.match(
        result.cpp,
        /bbl::js::array_index_write\(v_rows, bbl::js::array_index\(4\.0\)\) = /,
    );
});

test("preserves inferred object identity through container storage", () => {
    const result = compileSource(`
        interface Image { frame: number }
        interface Pending { img: Image }
        const image = { frame: -1 };
        const pending: Pending[] = [];
        pending.push({ img: image });
        pending[0]!.img.frame = 4;
        const observed = image.frame;
    `);

    assert.match(
        result.cpp,
        /bblscene::Image v_image = bbl::js::make_ref<bblscene::ImageData>/,
    );
    assert.match(result.cpp, /v_image->frame/);
});

test("keeps a rebound inferred Map object nullable until its fallback", () => {
    const result = compileSource(`
        interface Batch { values: number[] }
        function batchFor(map: Map<string, Batch>, name: string): Batch {
            let batch = map.get(name);
            if (!batch) {
                batch = { values: [] };
                map.set(name, batch);
            }
            return batch;
        }
        const batches = new Map<string, Batch>();
        let name = "walls";
        batchFor(batches, name);
    `);

    assert.match(result.cpp, /static_cast<bool>\(v_\w*batch\)/);
    assert.match(result.cpp, /v_\w*batch = bbl::js::make_ref/);
});

test("keeps a rebound inferred array object as a writable reference", () => {
    const result = compileSource(`
        interface Frame { rotated: boolean; values: number[] }
        const frames: (Frame | undefined)[] = [];
        let frame = frames[0];
        if (!frame) {
            frame = { rotated: false, values: [] };
            frames[0] = frame;
        }
        frame.rotated = true;
    `);

    assert.match(result.cpp, /static_cast<bool>\(v_frame\)/);
    assert.match(result.cpp, /v_frame->rotated = true/);
});

test("evaluates conditional data-branch preparation lazily", () => {
    const result = compileSource(`
        interface Row { value: number }
        const rows: Row[] = [{ value: 2 }];
        let index = -1;
        const selected = index >= 0 ? rows[index]! : null;
        const nested = selected ? rows[selected.value]! : null;
    `);

    const guardedIndex = result.cpp.indexOf("= v_selected->value;");
    assert.notEqual(guardedIndex, -1);
    const branch = result.cpp.lastIndexOf(
        "if (v_bblite_element_found_",
        guardedIndex,
    );
    assert.notEqual(branch, -1);
    assert.ok(branch < guardedIndex);
    assert.equal(result.cpp.match(/= v_selected->value;/g)?.length, 1);
});

test("keeps iteration locals scoped inside the native loop", () => {
    const result = compileSource(`
        const rows: [number, number][] = [[1, 2], [3, 4]];
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            const scaled = rows[i]![0] * 2;
            total += scaled;
        }
    `);

    assert.match(result.cpp, /for \([^]*double v_\w+_scaled =/);
    assert.equal(result.cpp.match(/double v_\w+_scaled =/g)?.length, 1);
});

test("keeps the run-time length where the container is resized", () => {
    // The fold is allowed only while nothing can change the count. One
    // `push` anywhere in the entry source withdraws it, whether it runs
    // before the loop or after.
    const result = compileSource(`
        const rows: [number, number][] = [[1, 2], [3, 4], [5, 6]];
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            total += rows[i]![0];
        }
        rows.push([7, 8]);
    `);

    assert.match(
        result.cpp,
        /for \(; static_cast<double>\(v_block\d+_i\) < bbl::js::array_length/,
    );
});

test("withdraws the length fold from a container handed to a call", () => {
    // The case a downstream invalidation hook cannot catch. Every reached
    // function inlines, and a container parameter binds BY REFERENCE, so the
    // callee's `list.push` grows the caller's array while being spelled
    // against a name the scan never sees. Handing the name to any call is
    // what gives up the fold.
    const result = compileSource(`
        function grow(list: number[]): void {
            list.push(9);
        }
        const offsets: number[] = [1, 2, 3];
        grow(offsets);
        let total = 0;
        for (let i = 0; i < offsets.length; i++) {
            total += offsets[i]!;
        }
    `);

    assert.match(
        result.cpp,
        /for \(; static_cast<double>\(v_block\d+_i\) < bbl::js::array_length/,
    );
    assert.match(
        result.cpp,
        /void grow\(bbl::js::Array<double>& v_fn\d+_list\)/,
    );
});

test("keeps a length fold past writes that build another function's own array", () => {
    // `keep` pushes only into the array its `out` creates, before returning
    // it: no other array, `NONE.rules` included, changes, so the stylesheet
    // the length selects stays a known string.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface Layer {
            readonly rules: readonly string[];
            readonly bind: (n: number) => void;
        }
        const NONE: Layer = { rules: [], bind: () => {} };
        function layer(on: boolean): Layer {
            if (!on) return NONE;
            return { rules: [".a { width: 3px; }"], bind: (n: number) => { console.log(n); } };
        }
        function keep<T>(items: readonly T[], count: number): T[] {
            const out: T[] = [];
            for (let i = 0; i < count; i++) out.push(items[i]!);
            return out;
        }
        async function main() {
            await createEngine({});
            const chosen = layer(false);
            const sheet = document.createElement("style");
            sheet.textContent = chosen.rules.length > 0 ? ".panel { width: 1px; }" : ".panel { width: 2px; }";
            document.head.appendChild(sheet);
        }
        void main();
    `);

    assert.match(result.cpp, /ui_add_class_style[^\n]*"panel"[^\n]*width:2px/);
    assert.doesNotMatch(result.cpp, /width:1px/);
});

test("withdraws the length fold past a write after another function shares its array", () => {
    // `keep`, called with strings, hands its array to `sink` before
    // pushing: once shared, the push may change any string array,
    // `NONE.rules` included.
    assert.throws(
        () =>
            compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface Layer {
            readonly rules: readonly string[];
            readonly bind: (n: number) => void;
        }
        const NONE: Layer = { rules: [], bind: () => {} };
        function layer(on: boolean): Layer {
            if (!on) return NONE;
            return { rules: [".a { width: 3px; }"], bind: (n: number) => { console.log(n); } };
        }
        function sink(a: readonly unknown[]): void { console.log(a.length); }
        function keep<T>(items: readonly T[], count: number): T[] {
            const out: T[] = [];
            sink(out);
            for (let i = 0; i < count; i++) out.push(items[i]!);
            return out;
        }
        async function main() {
            await createEngine({});
            keep([".b { width: 4px; }"], 1);
            const chosen = layer(false);
            const sheet = document.createElement("style");
            sheet.textContent = chosen.rules.length > 0 ? ".panel { width: 1px; }" : ".panel { width: 2px; }";
            document.head.appendChild(sheet);
        }
        void main();
    `),
        /Expected a string literal/,
    );
});

test("keeps a length fold past writes no call can aim at the array", () => {
    // `append` only ever pushes numbers, `mark` writes a named key and
    // `brand` defines one: none changes the elements or length of a
    // string array, so the stylesheet the length selects stays a known
    // string.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        interface Layer {
            readonly rules: readonly string[];
            readonly bind: (n: number) => void;
        }
        const NONE: Layer = { rules: [], bind: () => {} };
        function layer(on: boolean): Layer {
            if (!on) return NONE;
            return { rules: [".a { width: 3px; }"], bind: (n: number) => { console.log(n); } };
        }
        function append<T>(list: T[], item: T): void { list.push(item); }
        function mark<T extends object>(item: T): T & { mark?: number } {
            const copy: T & { mark?: number } = { ...item };
            copy.mark = 2;
            return copy;
        }
        function brand<T extends object>(item: T): T {
            const copy = { ...item };
            Object.defineProperty(copy, "id", { value: 1, enumerable: true, writable: false, configurable: false });
            return copy;
        }
        const totals: number[] = [];
        async function main() {
            await createEngine({});
            append(totals, 3);
            mark({ x: 1 });
            const chosen = layer(false);
            const sheet = document.createElement("style");
            sheet.textContent = chosen.rules.length > 0 ? ".panel { width: 1px; }" : ".panel { width: 2px; }";
            document.head.appendChild(sheet);
        }
        void main();
        void brand;
    `);

    assert.match(result.cpp, /ui_add_class_style[^\n]*"panel"[^\n]*width:2px/);
    assert.doesNotMatch(result.cpp, /width:1px/);
});

test("builds ribbon paths through native nested loops", () => {
    const result = compileSource(`
        import { createEngine, createRibbon } from "@babylonjs/lite";
        const engine = await createEngine({});
        const rows: { x: number; y: number; z: number }[][] = [];
        for (let p = 0; p < 2; p++) {
            const row: { x: number; y: number; z: number }[] = [];
            for (let i = 0; i < 2; i++) {
                row.push({ x: i, y: p, z: 0 });
            }
            row.push(row[0]!);
            rows.push(row);
        }
        createRibbon(engine, { pathArray: rows });
    `);

    assert.equal(result.cpp.match(/for \(;/g)?.length, 2);
    assert.equal(
        result.cpp.match(
            /push_back\(bbl::js::make_ref<bblscene::Record\d+Data>/g,
        )?.length,
        1,
    );
    assert.match(result.cpp, /bbl::create_ribbon\(/);
});

test("spreads a runtime numeric tuple into a numeric array", () => {
    const result = compileSource(`
        const rows = new Map<string, [number, number, number]>();
        rows.set("one", [1, 2, 3]);
        const values: number[] = [];
        for (const row of rows.values()) {
            values.push(...row);
        }
    `);

    assert.match(
        result.cpp,
        /auto (v_bblite_push_spread_\d+) = bbl::js::array_from_iterable<double>\([^;]+\);\s*[^;]*bbl::js::array_append\(v_values, \1\)/,
    );
});

test("copies a runtime numeric tuple through an array literal", () => {
    const result = compileSource(`
        interface Mover {
            position: [number, number, number];
            destination: [number, number, number];
        }
        function advance(mover: Mover): void {
            mover.destination = [...mover.position];
        }
        const mover: Mover = {
            position: [1, 2, 3],
            destination: [0, 0, 0],
        };
        advance(mover);
    `);

    assert.match(
        result.cpp,
        /destination = bbl::js::clone_tuple\([^)]*position\)/,
    );
});

test("settles nullish optional resource parameters in each specialization", () => {
    const result = compileSource(`
        import {
            createBox,
            createEngine,
            type EngineContext,
            type Mesh,
        } from "@babylonjs/lite";

        function choose(engine: EngineContext, mesh?: Mesh): Mesh {
            return mesh ?? createBox(engine);
        }

        const engine = await createEngine({});
        const existing = createBox(engine);
        choose(engine);
        choose(engine, existing);
    `);

    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 2);
});

test("does not snapshot a push behind a runtime condition", () => {
    const result = compileSource(`
        interface Row { value: number }
        const rows: Row[] = [];
        if (Math.random() > 0.5) {
            rows.push({ value: 1 });
        }
        let total = 0;
        for (const row of rows) {
            total += row.value;
        }
    `);

    assert.match(result.cpp, /if \([^)]*random/);
    assert.match(result.cpp, /const auto&? \w+ = v_rows;/);
    assert.match(result.cpp, /for \(std::size_t/);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 1);
});

test("does not leak a conditionally pushed handle outside its block", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
            type SceneContext,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const scenes: SceneContext[] = [createSceneContext(engine)];
        if (Math.random() > 0.5) {
            const second = createSceneContext(engine);
            scenes.push(second);
        }
        for (const scene of scenes) {
            scene.clearColor = [0, 0, 0, 1];
        }
    `);

    assert.match(result.cpp, /const auto&? \w+ = v_scenes;/);
    assert.match(result.cpp, /for \(std::size_t/);
    assert.equal((result.cpp.match(/\.clear_color =/g) ?? []).length, 1);
});

test("does not snapshot a Record write behind a runtime condition", () => {
    const result = compileSource(`
        const values: Record<string, number> = {};
        if (Math.random() > 0.5) {
            values["one"] = 1;
        }
        const selected = values["one"];
    `);

    assert.match(result.cpp, /\.set\("one", 1\.0\);/);
    assert.match(result.cpp, /\.get_owned\("one"\)/);
});

test("turns a conditionally spread scalar property into an optional field", () => {
    const result = compileSource(`
        interface Entry {
            value: number;
            shape?: number;
        }
        const wedge = Math.random() > 0.5;
        const entry: Entry = {
            value: 1,
            ...(wedge ? { shape: 1 } : {}),
        };
        const selected = entry.shape === 1;
    `);

    assert.match(
        result.cpp,
        /Nullable<double>\{1\.0\} : bbl::js::Nullable<double>\{std::nullopt\}/,
    );
    assert.match(result.cpp, /\.has_value\(\)/);
});

test("a document spread with a member no dictionary holds is the record its callee only reads", () => {
    // Each key the parameter's type declares reads one copy of the
    // document's own properties; a record held past the call refuses.
    const source = (use: string): string => `
        import { createBox, createEngine, type Mesh } from "@babylonjs/lite";
        interface Options { a?: number; c?: number; sink?: Mesh }
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const doc = JSON.parse('{"a":1,"z":2}') as { a: number };
        function read(options: Options): number { return (options.a ?? 0) + (options.c ?? 0); }
        ${use}
    `;
    const result = compileSource(
        source("const total = read({ ...doc, sink: createBox(engine) });"),
    );
    assert.match(
        result.cpp,
        /bbl::js::json_spread_into\(v_bblite_document_spread_\d+, v_doc\);/,
    );
    assert.match(result.cpp, /v_bblite_document_spread_\d+\.get\("c"\)/);
    assert.throws(
        () =>
            compileSource(
                source(
                    "const options: Options = { ...doc, sink: createBox(engine) };\nconst total = read(options);",
                ),
            ),
        /A document spread into the closed record type 'Options' holds only the keys it declares: it is built as an argument its callee only reads/,
    );
});

test("shares a static element snapshot through a const array alias", () => {
    const result = compileSource(`
        interface Row { value: number }
        const rows: Row[] = [];
        const alias = rows;
        alias.push({ value: 1 });
        let total = 0;
        for (const row of rows) {
            total += row.value;
        }
    `);

    assert.match(result.cpp, /v_alias\.push_back/);
    assert.match(result.cpp, /const auto&? \w+ = v_rows;/);
    assert.match(result.cpp, /for \(std::size_t/);
    assert.equal(result.cpp.match(/v_total \+=/g)?.length, 1);
});

test("writes through native elements of a statically grown record list", () => {
    const result = compileSource(`
        interface Item {
            active: boolean;
            count: number;
        }
        const items: Item[] = [];
        for (let i = 0; i < 2; i++) {
            items.push({ active: false, count: 0 });
        }
        for (const item of items) {
            item.active = false;
            item.count = 0;
        }
    `);

    assert.doesNotMatch(result.cpp, /false = false|0\.0 = 0\.0/);
    assert.equal(result.cpp.match(/->active = false;/g)?.length, 1);
    assert.equal(result.cpp.match(/->count = 0\.0;/g)?.length, 1);
});

test("keeps an inferred loop-grown handle list available to render composition", () => {
    const result = compileSource(`
        import {
            addToScene,
            createBox,
            createDirectionalLight,
            createEngine,
            createPcfDirectionalShadowGenerator,
            createSceneContext,
            createSphere,
            setShadowTaskCasterMeshes,
        } from "babylon-lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            const sphere = createSphere(engine, { diameter: 1 });
            addToScene(scene, sphere);
            const casters = [sphere];
            for (let i = 0; i < 2; i++) {
                const box = createBox(engine, 1);
                addToScene(scene, box);
                casters.push(box);
            }
            const shadow = createPcfDirectionalShadowGenerator(
                engine,
                light,
            );
            setShadowTaskCasterMeshes(shadow, casters);
        }

        void main();
    `);

    assert.equal(result.manifest.sceneMeshes.length, 3);
    assert.equal(result.manifest.shadowGenerators[0]?.dynamicCasters, true);
    assert.match(result.cpp, /Array<bbl::MeshHandle> v_casters/);
    assert.match(
        result.cpp,
        /set_shadow_task_caster_meshes\([^;]+array_to_vector\(v_casters\)/,
    );
});

test("compares handles read from runtime arrays by object identity", () => {
    const result = compileSource(`
        import { createBox, createEngine, type Mesh } from "babylon-lite";
        async function main() {
            const engine = await createEngine({});
            const mesh = createBox(engine, 1);
            const meshes: Mesh[] = [mesh];
            const same = meshes.some((entry, index) => entry !== meshes[index]);
            if (same) mesh.position.y = 1;
        }
        void main();
    `);

    const snapshots = [
        ...result.cpp.matchAll(
            /const auto (\w+) = bbl::js::snapshot_value\(std::pair<bbl::StoredEngine, bbl::MeshHandle>\{bbl::StoredEngine\{v_engine\}, ([^\n]+)\}\);/g,
        ),
    ];
    assert.equal(snapshots.length, 2);
    const entry =
        /auto (\w+) = bbl::js::snapshot_value\(v_bblite_some_source_\d+\[v_bblite_some_index_\d+\]\);/.exec(
            result.cpp,
        );
    assert.ok(entry);
    assert.equal(snapshots[0]![2], entry[1]);
    assert.match(
        result.cpp,
        new RegExp(
            String.raw`make_closure\(bblscene::\w+\{${entry[1]}, v_engine, v_meshes\}`,
        ),
    );
    assert.match(
        snapshots[1]![2]!,
        /^bbl::js::array_at_or_default\(v_meshes, \w+\)$/,
    );
    assert.ok(
        result.cpp.includes(
            `return !bbl::js::detail::same_value_zero(${snapshots[0]![1]}, ${snapshots[1]![1]});`,
        ),
    );
});

test("rebinds JavaScript arrays through their shared native identity", () => {
    const result = compileSource(`
        let current: number[] = [1];
        const alias = current;
        const next: number[] = [2];
        current = next;
        alias.push(3);
    `);

    assert.match(result.cpp, /v_current = v_next;/);
    assert.match(result.cpp, /v_alias\.push_back\(3\.0\)/);
});

test("iterates strings through their JavaScript characters", () => {
    const result = compileSource(`
        for (const item of "abc") {
            const value = item;
        }
    `);
    const range =
        /const auto& (\w+) = bbl::js::string_characters\("abc"\);/.exec(
            result.cpp,
        );
    assert.ok(range);
    assert.match(
        result.cpp,
        new RegExp(
            `for \\(std::size_t (\\w+) = 0; \\1 < ${range[1]}\\.size\\(\\); \\+\\+\\1\\) \\{\\s+\\[\\[maybe_unused\\]\\] const auto& (\\w+) = ${range[1]}\\[\\1\\];\\s+\\[\\[maybe_unused\\]\\] std::string \\w+ = bbl::js::snapshot_value\\(\\2\\);`,
        ),
    );
});

test("lowers do-while loops with post-tested conditions", () => {
    const result = compileSource(`
        let value = 0;
        do {
            value++;
        } while (value < 3);
    `);
    assert.match(
        result.cpp,
        /do \{[\s\S]*v_value\+\+;[\s\S]*\} while \(v_value < 3\.0\);/,
    );
});

test("lowers recursive plain-data functions natively", () => {
    const result = compileSource(`
        function recurse(value: number): number {
            if (value <= 0) return 0;
            return recurse(value - 1);
        }
        const value = recurse(1);
    `);
    assert.match(result.cpp, /double recurse\(double v_\w*value\);/);
    assert.match(
        result.cpp,
        /return bblscene::recurse\(\(v_\w*value - 1\.0\)\);/,
    );
});

test("uses void completion for immediate recursive async callbacks", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let visits = 0;
            const early = async (value: number): Promise<void> => {
                if (value <= 0) return;
                visits += 1;
                await early(value - 1);
            };
            const falling = async (value: number): Promise<void> => {
                visits += 1;
                if (value > 0) await falling(value - 1);
            };
            await early(3);
            await falling(2);
            if (visits !== 6) throw new Error("recursive completion effects");
        }
        main();
    `);

    assert.equal(
        result.cpp.match(
            /bbl::js::Callback<void\(double\)> v_\w*(?:early|falling);/g,
        )?.length,
        2,
    );
    assert.doesNotMatch(result.cpp, /bbl::js::Callback<bool\(double\)>/);
});

test("keeps synchronous recursive callbacks local to native data functions", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        function triangular(limit: number): number {
            let total = 0;
            const visit = (value: number): void => {
                if (value <= 0) return;
                total += value;
                visit(value - 1);
            };
            visit(limit);
            return total;
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const total = triangular(3);
        }
        main();
    `);

    const definition = cppFunction(result.cpp, "double triangular(");
    assert.ok(definition);
    assert.match(definition, /bbl::js::Callback<void\(double\)> v_fn\d+_visit/);
    assert.doesNotMatch(definition, /native_callback_owners|v_engine/);
});

test("keeps synchronous frame-local recursive callbacks in local storage", () => {
    // Direct recursive calls borrow the frame's callback. Mutable captures
    // share a cell without extending the callback's lifetime to the engine.
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let total = 0;
            const tick = (time: number): void => {
                let burst = 0;
                const drain = (value: number): void => {
                    if (value <= 0) return;
                    burst += value;
                    drain(value - 1);
                };
                drain(3);
                total += burst;
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            await startEngine(engine);
        }
        main();
    `);

    assert.match(
        result.cpp,
        /bbl::js::Callback<void\(double\)> v_fn\d+_drain;/,
    );
    assert.match(
        result.cpp,
        /v_fn\d+_drain = bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_fn\d+_burst, std::ref\(v_fn\d+_drain\)\}, bblscene::\w+/,
    );
    assert.match(
        result.cpp,
        /v_fn\d+_burst = bbl::js::make_gc_shared<double>\(0\.0\)/,
    );
    assert.doesNotMatch(result.cpp, /drain_owner/);
    assert.doesNotMatch(result.cpp, /native_callback_owners/);
});

test("keeps synchronous recursive groups in automatic callable storage", () => {
    // The recursive-group arm of the same rule: a local declaration that
    // captures scoped state keeps its environment in automatic storage,
    // even when a named invoker implements its body.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let total = 0;
            function drain(value: number): void {
                if (value <= 0) return;
                total += value;
                drain(value - 1);
            }
            drain(3);
        }
        main();
    `);

    assert.match(
        result.cpp,
        /auto bbl_recursive_\w*group = bbl::js::make_recursive_group\(/,
    );
    assert.match(
        result.cpp,
        /bbl::js::make_closure\(bblscene::bbl_environment_\w+\{std::ref\(v_total\)\}, bblscene::\w+\{\}/,
    );
    assert.doesNotMatch(result.cpp, /native_callback_owners/);
    assert.doesNotMatch(result.cpp, /drain_owner/);
    assert.doesNotMatch(result.cpp, /bbl::js::Callback<void\(double\)>/);
});

test("reads mutated flat-entry variables from live generated state", (t) => {
    const body = `
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        const box = createBox(engine, 1);
        let counter = 0;
        counter++;
        counter++;
        box.position.x = counter;
        box.rotation.y += 0.3;
        if (counter !== 2 || box.position.x !== 2 || Math.abs(box.rotation.y - 0.3) > 0.000001)
            throw new Error("scalar and compound transform writes must read live state");
    `;
    const imports = `
        import {
            createBox,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";
    `;
    const flat = compileSource(`${imports}${body}`);
    const main = compileSource(`
        ${imports}
        async function main(): Promise<void> {
            ${body}
        }
    `);

    for (const result of [flat, main]) {
        assert.match(
            result.cpp,
            /double v_counter = 0\.0;\s+v_counter\+\+;\s+v_counter\+\+;/s,
        );
        assert.match(result.cpp, /\.position\.x = v_counter;/);
        assert.doesNotMatch(result.cpp, /\.position\.x = 0\.0;/);
        assert.match(
            result.cpp,
            /\.rotation\.y = static_cast<float>\(static_cast<double>\([^\n]*\.rotation\.y\) \+ 0\.3\)/,
        );
        assert.equal(
            (result.cpp.match(/bbl::mark_mesh_dirty\(/g) ?? []).length,
            2,
        );
    }
    assert.ok(
        !flat.manifest.adaptations.some(
            ({ id }) => id === "entry-main-wrapper-erasure",
        ),
    );
    const tools = optionalNativeFixtureTools();
    if (!tools)
        return t.skip(
            "Native fixture compiler unavailable; generation assertions passed.",
        );
    for (const [name, result] of [
        ["flat", flat],
        ["main", main],
    ] as const)
        runGeneratedProgram(
            tools,
            `compiler-live-state-${name}`,
            `
#define main generated_main
${result.cpp}
#undef main
#include <cassert>
namespace { unsigned writes = 0; }
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
MeshHandle create_box(Engine& engine, BoxOptions) {
    const auto index = static_cast<std::uint32_t>(engine.meshes.size());
    engine.meshes.emplace_back();
    return MeshHandle{index};
}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
    const auto& record = handle_at(engine.meshes, mesh);
    assert(record.position.x == 2.0);
    if (++writes == 2) assert(std::abs(record.rotation.y - 0.3f) < 0.000001f);
}
}
int main() { assert(generated_main() == 0); assert(writes == 2); }
`,
        );
});

test("preserves compound assignments for numeric properties", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
            onBeforeRender,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(0, 1, 2, { x: 0, y: 0, z: 0 });
            scene.camera = camera;
            const box = createBox(engine, 1);
            const material = createStandardMaterial();
            box.material = material;
            scene.fixedDeltaMs += 1;
            scene.imageProcessing.exposure -= 0.1;
            scene.imageProcessing.contrast += 0.2;
            scene.camera.alpha += 0.3;
            camera.beta -= 0.4;
            material.alpha += 0.1;
            material.specularPower -= 1;
            onBeforeRender(scene, () => {
                box.position.x -= 0.02;
                box.rotation.y += 0.01;
                box.scaling.z += 0.03;
            });
        }
    `);

    assert.match(result.cpp, /\.fixed_delta_ms \+= 1\.0;/);
    assert.match(
        result.cpp,
        /\.environment\.exposure = static_cast<float>\(static_cast<double>\([^\n]*\.environment\.exposure\) - 0\.1\)/,
    );
    assert.match(
        result.cpp,
        /\.environment\.contrast = static_cast<float>\(static_cast<double>\([^\n]*\.environment\.contrast\) \+ 0\.2\)/,
    );
    assertCameraScalarWrite(result.cpp, "alpha", /\(\w+ \+ 0\.3\)/);
    assertCameraScalarWrite(result.cpp, "beta", /\(\w+ - 0\.4\)/);
    assert.match(
        result.cpp,
        /\.alpha = static_cast<float>\(static_cast<double>\([^\n]*\.alpha\) \+ 0\.1\)/,
    );
    assert.match(
        result.cpp,
        /\.specular_power = static_cast<float>\(static_cast<double>\([^\n]*\.specular_power\) - 1\.0\)/,
    );
    assert.match(result.cpp, /\.position\.x -= 0\.02/);
    assert.match(
        result.cpp,
        /\.rotation\.y = static_cast<float>\(static_cast<double>\([^\n]*\.rotation\.y\) \+ 0\.01\)/,
    );
    assert.match(
        result.cpp,
        /\.scaling\.z = static_cast<float>\(static_cast<double>\([^\n]*\.scaling\.z\) \+ 0\.03\)/,
    );
});

test("captures function-local const values once", () => {
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const camera = createArcRotateCamera(
                0,
                1,
                5,
                [0, 0, 0],
            );
            camera.radius = 5;
            const captured = camera.radius;
            camera.radius = 9;
            const box = createBox(engine, captured);
        }
    `);

    assert.match(
        result.cpp,
        /double v_captured = bbl::handle_at\(v_engine\.cameras, v_camera\)\.radius/,
    );
    assert.match(
        result.cpp,
        /BoxOptions\{static_cast<float>\(v_captured\), static_cast<float>\(v_captured\), static_cast<float>\(v_captured\)\}/,
    );
});

test("does not collapse conditional values to the true branch", () => {
    const result = compileSource(`
        function choose(flag: boolean): number {
            const value = flag ? 0.6 : 0.4;
            return value;
        }
        const selected = choose(false);
    `);

    assert.match(
        result.cpp,
        /double v_fn0_value = \(v_fn0_flag \? 0\.6 : 0\.4\);/,
    );
    assert.doesNotMatch(result.cpp, /double v_fn0_value = 0\.6;/);
});

test("an assignment used as a value constructs once and yields what it stored", () => {
    // `const camera = (scene.camera = createArcRotateCamera(...))` is an
    // assignment in expression position. Compiling the right-hand side a
    // second time to produce the value would construct a second camera, so
    // the store binds the camera it constructs and the value is that binding.
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const camera = (scene.camera = createArcRotateCamera(
                0,
                1,
                12,
                { x: 0, y: 0, z: 0 },
            ));
            camera.radius = 6;
        }
    `);

    assert.equal(
        result.cpp.match(/create_arc_rotate_camera\(/g)?.length,
        1,
        "the camera factory must be emitted exactly once",
    );
    assert.match(
        result.cpp,
        /auto (v_bblite_assigned_\d+) = bbl::create_arc_rotate_camera\([^;]*;\s*v_scene\.camera = \1;\s*\[\[maybe_unused\]\] auto& v_camera = \1;/,
    );
    assertCameraScalarWrite(result.cpp, "radius", /6\.0/);
});

test("an engine-property assignment used as a value evaluates its target once and yields the assigned value", () => {
    // The store runs as its statement and binds the right side it consumes;
    // the value is that binding, never the property read back, and the
    // owner `boxes[index++]` is read once for every lane the store writes.
    const result = compileSource(`
        import { createBox, createEngine, createHemisphericLight } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const boxes = [createBox(engine), createBox(engine)];
            let index = 0;
            const x = (boxes[index++]!.position.x = 3);
            boxes[1]!.position.y = x + index;
            const light = createHemisphericLight([0, 1, 0], 1);
            const intensity = (light.intensity = 0.25);
            boxes[1]!.position.z = intensity;
        }
    `);
    assert.equal(result.cpp.match(/v_index\+\+/g)?.length, 1);
    assert.match(
        result.cpp,
        /auto (v_bblite_transform_owner_\d+) = [^;]*\(v_index\+\+\)[^;]*;\s*\[\[maybe_unused\]\] const double (v_bblite_assigned_\d+) = 3\.0;\s*[^;]*\1\)\.position\.x = \2;\s*bbl::mark_mesh_dirty\(v_engine, \1\);\s*\[\[maybe_unused\]\] auto& v_x = \2;/,
    );
    assert.match(
        result.cpp,
        /const double (v_bblite_assigned_\d+) = 0\.25;\s*[^;]*\.intensity = \1;\s*\[\[maybe_unused\]\] auto& v_intensity = \1;/,
    );
});

test("nullish coalescing selects on absence where || selects on falsity", () => {
    // `??` takes its right operand only for null or undefined, so a present
    // but empty parameter keeps the empty string. `||` takes the right
    // operand for every falsy value, including that one -- compiling both
    // against the same query is what distinguishes the two operators.
    const withOperator = (operator: string): string => `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const params = new URLSearchParams(window.location.search);
            const mode = params.get("mode") ${operator} "fallback";
            if (mode === "") {
                box.position.x = 3;
            }
        }
    `;

    const present = { search: "?mode=" };
    assert.match(
        compileSource(withOperator("??"), present).cpp,
        /\.position\.x = 3\.0/,
    );
    assert.doesNotMatch(
        compileSource(withOperator("||"), present).cpp,
        /\.position\.x = 3\.0/,
    );
    // An absent parameter is null, so both operators take the fallback.
    const absent = { search: "?other=1" };
    assert.doesNotMatch(
        compileSource(withOperator("??"), absent).cpp,
        /\.position\.x = 3\.0/,
    );
    assert.doesNotMatch(
        compileSource(withOperator("||"), absent).cpp,
        /\.position\.x = 3\.0/,
    );
});

test("a tagged union arm with an unrepresented field refuses at that field", () => {
    assert.throws(
        () =>
            compileSource(`
                type Outcome = { kind: "hit"; token: FinalizationRegistry<number> } | { kind: "miss" };
                function outcome(hit: boolean): Outcome {
                    return hit ? { kind: "hit", token: new FinalizationRegistry<number>(() => {}) } : { kind: "miss" };
                }
                const first = outcome(Date.now() > 0);
                if (first.kind !== "hit") throw new Error("outcome");
            `),
        (error: Error) =>
            /Unsupported constructor expression/.test(error.message) &&
            !/unknown field/.test(error.message),
    );
});

test("does not lower an unreachable logical right operand", () => {
    assert.doesNotThrow(() =>
        compileSource(`
            if (false && document.getElementById("definitelyMissing")) {
                throw new Error("unreachable");
            }
            if (true || document.getElementById("definitelyMissing")) {
                const reached = 1;
            }
        `),
    );
});

test("a float field's compound store rounds once, at the store", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const box = createBox(engine);
            box.scaling.x = 3;
            box.scaling.x *= 1.1;
            box.scaling.y = 1e39;
        }
        void main();
    `);
    // JavaScript computes 3 * 1.1 in double and rounds at the float32
    // store; an out-of-range number stores as an infinity.
    assert.match(
        result.cpp,
        /scaling\.x = static_cast<float>\(static_cast<double>\([^\n]*scaling\.x\) \* 1\.1\);/,
    );
    assert.match(
        result.cpp,
        /scaling\.y = std::numeric_limits<float>::infinity\(\);/,
    );
    assert.doesNotMatch(result.cpp, /\*= 1\.1f|1e\+39f/);
});

test("shares one cell between the closures that capture and write a by-value binding", () => {
    // A for-of variable gets one cell per iteration; a destructured binding
    // one cell where the pattern binds it.
    for (const source of [
        "const incs: Array<() => void> = [], gets: Array<() => number> = []; for (let x of [1, 10]) { incs.push(() => { x++; }); gets.push(() => x); } incs[0]!(); console.log(gets[0]!());",
        "function counter(o: { n: number }) { let { n } = o; return { inc: () => { n++; }, get: () => n }; } const c = counter({ n: 0 }); c.inc(); console.log(c.get());",
    ])
        assert.match(
            compileSource(source).cpp,
            /auto \w*shared_binding\w* = bbl::js::make_gc_shared<double>\(/,
        );
});

test("refuses a hoisted var read while it can be undefined its type cannot hold", () => {
    // The scope's own read some path reaches unassigned, `!` or not.
    for (const read of ["y", "y!"])
        assert.throws(
            () =>
                compileSource(
                    `function f(c: boolean): number { if (c) { var y = 3; } return ${read}; } console.log(f(true));`,
                ),
            /The `var` 'y' can be read here before it is assigned/,
        );
    // A read inside a class the definite-assignment walk does not follow.
    assert.throws(
        () =>
            compileSource(
                "function f(c: boolean): number { if (c) { var y = 3; } class K { static v = y; } return K.v; } console.log(f(true));",
            ),
        /The `var` 'y' is read where its assignment runs through a ClassDeclaration, which the definite-assignment analysis does not follow/,
    );
    // A function lowered before the walk reached an assignment, or one its
    // own initializer's call may run before returning (only a scheduler, an
    // observer or a reaction runs it later), reads storage that holds
    // undefined until the assignment; a read that needs the value then
    // throws.
    for (const source of [
        "function f(): number { const get = (): number => w; const before = get(); var w = 7; return before; } console.log(f());",
        "function run(g: () => number): number { return g(); } function f(): number { var w = run(() => w); return w; } console.log(f());",
    ])
        assert.match(
            compileSource(source).cpp,
            /bbl::js::Nullable<double> v_bblite_var_w_\d+\{\};/,
        );
    // One binding with a parameter is not a storage of its own.
    assert.throws(
        () =>
            compileSource(
                "function f(a: number): number { var a = 2; return a; } console.log(f(1));",
            ),
        /The `var` 'a' shares its binding with a parameter/,
    );
});

test("refuses direct style writes and reads outside the reviewed surface", () => {
    const withStatement = (statement: string): string => `
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            const panel = document.createElement("div");
            document.body.appendChild(panel);
            ${statement}
        }

        void main();
    `;

    assert.throws(
        () =>
            compileSource(
                withStatement('panel.style.mixBlendMode = "screen";'),
            ),
        /Retained UI style property 'mix-blend-mode' is not lowered/,
    );
    assert.throws(
        () =>
            compileSource(
                withStatement(
                    'if (panel.style.shapeOutside === "") panel.remove();',
                ),
            ),
        /Retained UI style property 'shape-outside' is not lowered/,
    );
});

test("names the refused element tag, context kind, and event type", () => {
    const withStatement = (statement: string): string => `
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            await createEngine({});
            ${statement}
        }

        void main();
    `;

    assert.throws(
        () =>
            compileSource(withStatement('document.createElement("bad tag");')),
        /Native UI element tag 'bad tag' is not valid/,
    );
    assert.throws(
        () =>
            compileSource(
                withStatement(
                    'const canvas = document.createElement("canvas"); canvas.getContext("webgl2");',
                ),
            ),
        /Retained native canvas only supports the '2d' context/,
    );
    assert.throws(
        () =>
            compileSource(
                withStatement(
                    'const button = document.createElement("button"); button.addEventListener("animationend", () => {});',
                ),
            ),
        /do not support the 'animationend' event/,
    );
});

test("supplies omitted optional arguments to stored functions", () => {
    const result = compileSource(`
        interface Hud {
            banner: (text: string | null, sub?: string) => void;
        }
        const hud: Hud = {
            banner(text: string | null, sub = ""): void {
                if (text !== null) {
                    const combined = text + sub;
                }
            },
        };
        hud.banner("READY");
    `);

    assert.match(
        result.cpp,
        /const auto (\w+) = bbl::js::snapshot_callback\([^;]+\.banner\);\s*\1\([^,]+, bbl::js::Nullable<std::string>\{std::nullopt\}\)/,
    );
    assert.match(
        result.cpp,
        /if \((\w+)\.has_value\(\)\) return \*\1;\s*return "";/,
    );
});

test("lowers boolean data-field assignment expression callbacks", () => {
    const result = compileSource(`
        interface State { left: boolean; }
        function invoke(set: (value: boolean) => void): void {
            set(true);
        }
        const state: State = { left: false };
        invoke((value) => (state.left = value));
    `);

    assert.match(result.cpp, /v_state->left = true/);
});

test("reuses a stored callback while compiling its self-referential record", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        interface RaceOptions {
            restart(): void;
        }

        function buildRace(options: RaceOptions): void {
            if (Math.random() > 0.5) options.restart();
        }

        function startRace(): () => void {
            const start = (): void => {
                buildRace({ restart: start });
            };
            return start;
        }

        async function main(): Promise<void> {
            await createEngine({});
            const start = startRace();
            start();
        }

        void main();
    `);

    const declaration = result.cpp.match(
        /auto (fn\d+_stored_callback_owner) = bbl::js::make_gc_shared<bbl::js::Callback<void\(\)>>\(\);/,
    );
    assert.ok(declaration);
    assert.match(
        result.cpp,
        new RegExp(
            `\\(\\*${declaration[1]}\\) = bbl::js::make_closure\\(bblscene::bbl_environment_\\w+\\{fn\\d+_stored_callback_weak\\}, bblscene::\\w+`,
        ),
    );
    assert.match(
        result.cpp,
        /std::weak_ptr<bbl::js::Callback<void\(\)>> fn\d+_stored_callback_weak = fn\d+_stored_callback_owner;/,
    );
    assert.match(
        result.cpp,
        /const auto (\w+) = bbl::js::snapshot_callback\(bbl::js::retain_callback\(fn\d+_stored_callback_weak\.lock\(\)\)\);\s*\1\(\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Callback<void\(\)> fn\d+_stored_callback = bbl::js::retain_callback\(fn\d+_stored_callback_owner\);/,
    );
});

test("keeps lowering a helper this evaluator cannot answer", () => {
    // The narrowing, stated as behaviour. A body reaching a statement the
    // evaluator does not model -- here a `let` the branch writes -- has to
    // lower exactly as it does today rather than be given a made-up
    // value, so the native function survives and its caller's guard with
    // it.
    const result = compileSource(
        `
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        function readCaptureFrame(): number | null {
            let frame: number | null = null;
            const params = new URLSearchParams(location.search);
            if (params.get("captureFrame") !== null) {
                frame = 3;
            }
            return frame;
        }

        async function main() {
            const engine = await createEngine({});
            const box = createBox(engine);
            const captureFrame = readCaptureFrame();
            if (captureFrame !== null) {
                box.position.x = captureFrame;
            }
        }
    `,
        { search: "?captureFrame=7" },
    );
    assert.match(result.cpp, /readCaptureFrame/);
});

test("lowers platform time declarations to the native clock", () => {
    const source = `
        import { createEngine } from "@babylonjs/lite";

        async function main() {
            const started = performance.now();
            await createEngine({});
        }
    `;
    const result = compileSource(
        source.replace(
            "await createEngine({});",
            'await createEngine({}); if (started < 0) throw new Error("negative clock");',
        ),
    );
    const unread = compileSource(source);

    assert.match(result.cpp, /bbl::pal::performance_milliseconds\(\)/);
    assert.doesNotMatch(unread.cpp, /bbl::pal::performance_milliseconds\(\)/);
    for (const compiled of [result, unread])
        assert.ok(
            !compiled.manifest.adaptations.some(
                ({ id }) => id === "browser-setup-erasure",
            ),
        );
});

test("a global member written through a receiver holding the global object stays present", () => {
    // Each write reaches the global object through another value: a call's
    // result, a parameter, `any`. None is spelled `window.queue`.
    for (const install of [
        "function host(): QueueHost { return window as QueueHost; } host().queue ??= [3];",
        "function fill(options: { host: QueueHost }): void { options.host.queue = [3]; } fill({ host: window as QueueHost });",
        "const any: any = window; any.queue = [3];",
    ]) {
        const result = compileSource(`
            type QueueHost = Window & { queue?: number[] };
            ${install}
            if ((window as QueueHost).queue?.[0] !== 3) throw new Error("installed");
        `);
        assert.doesNotMatch(
            result.cpp,
            /static_cast<void>\(std::nullopt\);\s*static_cast<void>\(3\.0\);/,
            install,
        );
    }
});

test("lowers boolean negation in value position", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            let muted = false;
            function setMuted(value: boolean): void {
                muted = value;
            }
            setMuted(!muted);
            if (muted) {
                createBox(engine);
            }
        }
    `);

    assert.match(result.cpp, /make_closure\([^\n]+\)\(!\(v_muted\)\)/);
    assert.match(result.cpp, /v_muted = v_fn\d+_value;/);
    assert.match(result.cpp, /if \(v_muted\)/);
});

test("swaps mutable numeric locals through destructuring", () => {
    const result = compileSource(`
        let left = 1;
        let right = 2;
        [left, right] = [right, left];
    `);

    assert.match(
        result.cpp,
        /const auto (v_bblite_destructure_value_\d+) = v_right;\s+const auto (v_bblite_destructure_value_\d+) = v_left;\s+v_left = \1;\s+v_right = \2;/,
    );
});

test("stringifies a native exception through a catch binding", () => {
    const result = compileSource(`
        import { createEngine, loadGltf } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            try {
                await loadGltf(engine, "ship.glb");
            } catch (cause) {
                throw new Error(\`Model load failed: \${String(cause)}\`, { cause });
            }
        }
    `);

    assert.match(result.cpp, /catch \(const std::exception&/);
    assert.match(
        result.cpp,
        /bbl::js::error_message\(v_bblite_caught_error_\d+\)/,
    );
    assert.match(result.cpp, /std::rethrow_exception\(bbl::js::make_error/);
    assert.doesNotMatch(result.cpp, /std::string v_[\w]*cause =/);
});

test("projects open string records into optional struct parameters", () => {
    const result = compileSource(`
        type Entity = Record<string, string>;
        interface SpawnEnt {
            classname?: string;
            origin?: string;
        }
        function spawn(entities: SpawnEnt[]): number {
            return entities.length;
        }
        const entities: Entity[] = [{ classname: "monster" }];
        const count = spawn(entities);
    `);

    // Each struct views its record's entries: reads see later writes, and
    // an absent entry reads as undefined.
    assert.match(result.cpp, /project_result/);
    assert.match(
        result.cpp,
        /optional_entry_accessor<.+>\([^,]+, "classname"\)/,
    );
    assert.match(result.cpp, /optional_entry_accessor<.+>\([^,]+, "origin"\)/);
});

test("runs data cleanup in finally across an early return", () => {
    const result = compileSource(`
        const pending = new Map<string, number>();
        function load(): number {
            try {
                return 3;
            } finally {
                pending.delete("item");
            }
        }
        const loaded = load();
    `);

    assert.match(result.cpp, /bbl::js::finally\(\[&\]\(\) \{/);
    assert.match(result.cpp, /v_pending\.erase\("item"\)/);
});

test("preserves numeric tuple identity except through array spread", () => {
    const result = compileSource(`
        type V3 = [number, number, number];
        interface Bounds { mins: V3; }
        const source: Bounds = { mins: [1, 2, 3] };
        const alias: V3 = source.mins;
        const copy: V3 = [...source.mins];
    `);

    assert.match(
        result.cpp,
        /bbl::js::Tuple<3> v_alias = bbl::js::snapshot_value\(v_source\.mins\);/,
    );
    assert.match(
        result.cpp,
        /bbl::js::Tuple<3> v_copy = bbl::js::clone_tuple\(v_source\.mins\);/,
    );
});

test("tests runtime strings against RegExp values", () => {
    const result = compileSource(`
        const items = /^(item_|weapon_)/;
        function isItem(name: string): boolean {
            return items.test(name);
        }
        const found = isItem("item_shells");
    `);

    assert.match(result.cpp, /\.test\(/);
});

test("matches runtime strings with RegExp values", () => {
    const result = compileSource(`
        function captures(line: string): string[] {
            if (!/^\\d+,/.test(line)) return [];
            const prefix = "^(\\\\d+),(.+)$";
            const first = line.match(new RegExp(prefix));
            if (!first) return [];
            const names: string[] = [];
            for (const match of first[2]!.matchAll(/"([^"]+)"/g)) {
                names.push(match[1]!);
            }
            return names;
        }
        const values = captures('2,"road","river"');
    `);

    assert.match(result.cpp, /\.match\(v_fn\d+_line\)/);
    assert.match(result.cpp, /\.match_all\(/);
});

test("mutates a Map array fallback before storing it back", () => {
    const result = compileSource(`
        const groups = new Map<string, number[]>();
        const key = "items";
        const list = groups.get(key) ?? [];
        list.push(3);
        groups.set(key, list);
    `);

    assert.match(result.cpp, /v_list\.push_back\(3\.0\)/);
    assert.match(
        result.cpp,
        /v_list\.push_back\(3\.0\)[\s\S]*const auto (v_bblite_map_key_\d+) = "items";\s+static_cast<void>\(v_groups\.set\(\1, v_list\)\)/,
    );
});

test("serializes a runtime string enum for a string Set lookup", () => {
    const result = compileSource(`
        type Kind = "door" | "button";
        const kinds = new Set(["door", "button"]);
        function includes(kind: Kind): boolean {
            return kinds.has(kind);
        }
        const runtimeKind: Kind = Math.random() > 0.5 ? "door" : "button";
        const found = includes(runtimeKind);
    `);

    assert.match(result.cpp, /Kind_to_string/);
    assert.match(result.cpp, /v_kinds\.has\(/);
});

test("coerces Array predicate return expressions with JavaScript truthiness", () => {
    const result = compileSource(`
        interface Entry { name: string; bytes: Uint8Array | null; }
        const entries: Entry[] = [{ name: "sky", bytes: new Uint8Array(2) }];
        const index = entries.findIndex(
            (entry) => entry && entry.name.startsWith("sky") && entry.bytes
        );
    `);

    assert.match(result.cpp, /find_index_result/);
});

test("keeps early boolean returns in block Array predicates", () => {
    const result = compileSource(`
        const values: number[] = [1, 2, 3];
        const positive = values.filter((value) => {
            if (value < 2) return false;
            return value > 0;
        });
    `);

    assert.match(result.cpp, /filter_result/);
});

test("lowers Uint16Array construction, mutation, and native references", () => {
    const result = compileSource(`
        function write(values: Uint16Array, fill: number): void {
            values.fill(fill);
            values[0] = 65537;
        }

        const values = new Uint16Array([1, 2]);
        write(values, 7);
        const selected = values[0];
    `);

    assert.match(result.cpp, /bbl::js::u16_array_from/);
    assert.match(result.cpp, /bbl::js::U16Array&/);
    assert.match(result.cpp, /bbl::js::to_uint16\(65537\.0\)/);
    assert.match(result.cpp, /bbl::js::array_fill/);
    assert.match(result.cpp, /static_cast<double>\(/);
});

test("lowers global RegExp exec loops and lastIndex", () => {
    const result = compileSource(`
        const ATTRIBUTE = /(\\w+)\\s*=\\s*"([^"]*)"/g;

        function names(source: string): string[] {
            const result: string[] = [];
            ATTRIBUTE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = ATTRIBUTE.exec(source)) !== null) {
                result.push(match[1]!);
            }
            return result;
        }

        function main() {
            const result = names('x="1" y="2"');
        }
    `);

    assert.match(result.cpp, /bbl::js::RegExp/);
    assert.match(result.cpp, /\.last_index\(\) = 0\.0/);
    assert.match(result.cpp, /\.exec\(/);
});

test("converts runtime strings with Number", () => {
    // The reached reassignment leaves the string a run-time value.
    const result = compileSource(`
        function main() {
            let value = "42";
            if (Math.random() > 2) value = "7";
            const converted = Number(value);
        }
    `);

    assert.match(result.cpp, /bbl::js::number_from_string\(v_value\)/);
});

test("rejects compound assignments for nonnumeric properties", () => {
    const source = (assignment: string): string => `
        import {
            createArcRotateCamera,
            createBox,
            createEngine,
            createSceneContext,
            createStandardMaterial,
        } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(0, 1, 2, { x: 0, y: 0, z: 0 });
            const box = createBox(engine, 1);
            const material = createStandardMaterial();
            ${assignment}
        }
    `;
    for (const [assignment, target] of [
        ["scene.clearColor += [0, 0, 0, 1];", "scene clearColor"],
        ["scene.camera -= camera;", "scene camera"],
        ["box.material += material;", "mesh material"],
        ["material.diffuseColor -= [1, 1, 1];", "material diffuseColor"],
        ["material.disableLighting += true;", "material disableLighting"],
        [
            "scene.imageProcessing.toneMappingEnabled -= true;",
            "image-processing property 'toneMappingEnabled'",
        ],
    ] as const) {
        assert.throws(
            () => compileSource(source(assignment)),
            (error: unknown) => {
                assert.ok(error instanceof CompileError);
                assert.match(
                    error.message,
                    new RegExp(
                        `Compound assignment is not supported for ${target.replace(
                            /[.*+?^${}()|[\]\\]/g,
                            "\\$&",
                        )}`,
                    ),
                );
                return true;
            },
        );
    }
});

test("destructures a dynamically mapped native vector with checked reads", () => {
    const result = compileSource(`
        import {
            createEngine,
            createBox,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const box = createBox(engine);
        const key = "1,2";
        const [x, y] = key.split(",").map(Number);
        box.position.x = x!;
        box.position.y = y!;
    `);

    assert.match(result.cpp, /bbl::js::Array<double> v_bblite_map_result_/);
    assert.match(
        result.cpp,
        /array_index_checked\(v_bblite_destructure_vector_\d+, 0\.0,/,
    );
    assert.match(
        result.cpp,
        /array_index_checked\(v_bblite_destructure_vector_\d+, 1\.0,/,
    );
});

test("parses reached decimal strings with parseInt radix 10", () => {
    const result = compileSource(`
        import { createBox, createEngine } from "@babylonjs/lite";

        const engine = await createEngine({});
        const box = createBox(engine);
        const key = "-12,4";
        const comma = key.indexOf(",");
        box.position.x = parseInt(key.slice(0, comma), 10);
    `);

    assert.match(result.cpp, /bbl::js::parse_int_decimal\(/);
    assert.throws(
        () =>
            compileSource(`
            import { createEngine } from "@babylonjs/lite";
            await createEngine({});
            parseInt("ff", 1);
        `),
        /literal radix 0 or 2 through 36/,
    );
});

test("initializes optional plain-data class fields to undefined", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        await createEngine({});
        let fired = 0;
        class Toast {
            private timer?: ReturnType<typeof setTimeout>;

            show(): void {
                if (this.timer) clearTimeout(this.timer);
                this.timer = setTimeout(() => { fired += 1; }, 100);
            }
        }
        const toast = new Toast();
        toast.show();
    `);

    assert.match(
        result.cpp,
        /auto v_bblite_.*class_field_timer.* = bbl::js::make_gc_shared<bbl::js::Nullable<double>>\(\);/,
    );
    assert.match(result.cpp, /bbl::clear_timeout/);
    assert.match(result.cpp, /bbl::set_timeout/);
});

test("clears native Maps", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        await createEngine({});
        const values = new Map<string, number>();
        values.set("one", 1);
        values.clear();
    `);

    assert.match(result.cpp, /v_values\.clear\(\)/);
});

test("truncates an array stored on a class instance", () => {
    const result = compileSource(`
        import {
            createEngine,
            type TransformNode,
        } from "@babylonjs/lite";

        await createEngine({});
        interface Entry { root: TransformNode; value: number }
        class Bucket {
            private readonly values: Entry[] = [];

            reset(): void {
                this.values.length = 0;
            }
        }
        const bucket = new Bucket();
        bucket.reset();
    `);

    assert.match(result.cpp, /bbl::js::array_truncate\(/);
});

test("reads a TransformNode name in a runtime template", () => {
    const result = compileSource(`
        import {
            createEngine,
            createMeshFromData,
            createSceneContext,
            createTransformNode,
            addToScene,
        } from "@babylonjs/lite";

        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        let index = 0;
        const root = createTransformNode(\`root_\${index++}\`);
        addToScene(scene, root);
        root.rotation.set(0, index, 0);
        const name = \`\${root.name}_part\`;
        createMeshFromData(
            engine,
            name,
            new Float32Array([0, 0, 0]),
            new Float32Array([0, 1, 0]),
            new Uint32Array([0]),
        );
    `);

    assert.match(
        result.cpp,
        /bbl::handle_at\(v_engine\.transform_nodes, v_root\)\.name/,
    );
    assert.match(result.cpp, /bbl::add_to_scene\(v_scene, v_root\)/);
    assert.match(result.cpp, /bbl::set_transform_node_rotation\(/);
});

test("discards side-effect-free void expressions and preserves void calls", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        await createEngine({});
        let count = 0;
        function update(dt: number): void {
            void dt;
            void (() => { count += 1; })();
        }
        update(16);
    `);

    assert.doesNotMatch(result.cpp, /v_fn\d+_dt;/);
    assert.match(result.cpp, /v_count \+= 1\.0;/);
});

test("shares mutable enum state across functions returned in a record", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        type Mode = "one" | "two";

        function createMode() {
            let current: Mode = "one";
            function toggle(): Mode {
                current = current === "one" ? "two" : "one";
                return current;
            }
            function read(): Mode {
                return current;
            }
            return { toggle, read };
        }

        async function main(): Promise<void> {
            await createEngine({});
            const mode = createMode();
            const button = document.createElement("button");
            button.addEventListener("click", () => {
                button.textContent = mode.toggle() === "two" ? "two" : "one";
            });
            window.addEventListener("keydown", () => {
                button.textContent = mode.read() === "two" ? "two" : "one";
            });
            document.body.appendChild(button);
        }

        void main();
    `);

    assert.match(result.cpp, /bbl::js::make_gc_shared<bblscene::Mode>/);
    assert.match(result.cpp, /\(\*v_\w*current\)/);
});

test("retains mutable containers in records returned by factories", () => {
    const result = compileSource(`
        import { createEngine, type EngineContext } from "@babylonjs/lite";

        interface Store {
            readonly engine: EngineContext;
            _state: {
                values: Map<number, string>;
            };
        }

        function createStore(engine: EngineContext): Store {
            return {
                engine,
                _state: {
                    values: new Map<number, string>(),
                },
            };
        }

        function write(store: Store, key: number, value: string): void {
            store._state.values.set(key, value);
        }

        function read(store: Store, key: number): string | undefined {
            return store._state.values.get(key);
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const store = createStore(engine);
            write(store, 1, "kept");
            const value = read(store, 1);
        }

        void main();
    `);

    // The record keeps the engine and its state record: both calls reach
    // the one map the factory created.
    assert.match(
        result.cpp,
        /bblscene::StoreData\{bbl::StoredEngine\{v_engine\}, bbl::js::make_ref<bblscene::(\w+)Data>\(bblscene::\1Data\{bbl::js::Map<double, std::string>\{\}\}\)\}/,
    );
    assert.match(result.cpp, /store->_state->values\.set\(/);
    assert.match(result.cpp, /store->_state->values\.get\(/);
    assert.doesNotMatch(
        result.cpp,
        /bbl::js::Map<double, std::string>\{\}\.(?:set|get)\(/,
    );
});

test("converts a TypedArray.set source the target's own kind does not match", () => {
    // The spec reads each element as a number and stores it through the
    // TARGET's store, which is exactly what the constructor's
    // `<stem>_array_from` applies to the same sequence -- so a plain array,
    // a runtime tuple and another typed array all reach `typed_array_set`
    // through one conversion, and a same-kind source still copies directly.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        type ColorTuple = [number, number, number];

        function shade(color: ColorTuple): ColorTuple {
            return [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5];
        }

        async function main() {
            const engine = await createEngine({});
            void engine;
            const values = new Float32Array(12);
            values.set([1, 0, 0, 0], 0);
            values.set(shade([0.2, 0.4, 0.6]), 4);
            const source = new Float32Array([9, 8, 7]);
            values.set(source, 8);
            const lanes = new Float32Array([1, 2, 3, 4]);
            const wide = new Uint16Array(4);
            wide.set(lanes, 0);
        }
    `);

    assert.match(
        result.cpp,
        /typed_array_set\([^;]*bbl::js::f32_array_from\(bbl::js::Array<double>\{1\.0, 0\.0, 0\.0, 0\.0\}\)[^;]*, 0\.0\)/,
    );
    assert.match(
        result.cpp,
        /typed_array_set\([^;]*bbl::js::f32_array_from\([^;]*\), 4\.0\)/,
    );
    assert.match(result.cpp, /typed_array_set\([^;]*, 8\.0\)/);
    assert.doesNotMatch(
        result.cpp,
        /typed_array_set\([^;]*bbl::js::f32_array_from\([^;]*\), 8\.0\)/,
    );
    assert.match(
        result.cpp,
        /typed_array_set\([^;]*bbl::js::u16_array_from\([^;]*\), 0\.0\)/,
    );
});

test("retains a whole typed-array buffer behind an escaping byte view", () => {
    const result = compileSource(`
        import {
            createEngine,
            createStorageBuffer,
            updateStorageBuffer,
            type EngineContext,
            type StorageBuffer,
        } from "babylon-lite";

        interface Updater {
            push(): void;
        }

        function makeUpdater(engine: EngineContext): Updater {
            const history = new Float32Array(4);
            const bytes = new Uint8Array(history.buffer);
            const buffer: StorageBuffer = createStorageBuffer(engine, history);
            return {
                push(): void {
                    history[0] = 1;
                    updateStorageBuffer(engine, buffer, bytes);
                },
            };
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            makeUpdater(engine).push();
        }

        void main();
    `);

    const bytes = result.cpp.match(
        /auto (v_bblite_view_buffer_\d+) = bbl::js::ArrayBuffer\(v_fn\d+_history\);\s+auto (v_bblite_typed_view_\d+) = bbl::js::U8Array\(\1\);\s+\[\[maybe_unused\]\] bbl::js::U8Array& (v_fn\d+_bytes) = \2;/,
    );
    assert.ok(bytes);
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::update_storage_buffer\\([^;]+, ${bytes[3]}, 0\\.0f\\)`,
        ),
    );
});

test("a storage buffer a nested callback replaces is read through its shared cell", () => {
    const result = compileSource(`
        import {
            createEngine,
            createStorageBuffer,
            disposeStorageBuffer,
            updateStorageBuffer,
            type EngineContext,
            type StorageBuffer,
        } from "babylon-lite";

        function makePalette(engine: EngineContext): { grow(need: number): void; flush(): void } {
            let slots = 4;
            let data = new Float32Array(slots * 4);
            let buffer: StorageBuffer = createStorageBuffer(engine, data, "palette");
            const ensure = (need: number): void => {
                if (need <= slots) return;
                const grown = new Float32Array(need * 4);
                grown.set(data);
                const retired = buffer;
                data = grown;
                slots = need;
                buffer = createStorageBuffer(engine, data, "palette");
                disposeStorageBuffer(retired);
            };
            return {
                grow(need: number): void { ensure(need); },
                flush(): void { updateStorageBuffer(engine, buffer, data); },
            };
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const palette = makePalette(engine);
            palette.grow(8);
            palette.flush();
        }

        void main();
    `);
    const engineAlias = /auto& (\w+) = v_engine;/.exec(result.cpp);
    assert.ok(engineAlias, "the palette borrows the entry engine");
    const buffer =
        /auto (v_fn\d+_buffer) = bbl::js::make_gc_cell\(bbl::create_storage_buffer\(/.exec(
            result.cpp,
        );
    assert.ok(buffer, "the replaceable buffer has shared storage");
    assert.match(
        result.cpp,
        new RegExp(
            `\\(\\*${buffer[1]}\\) = bbl::create_storage_buffer\\((?:v_engine|${engineAlias[1]}), `,
        ),
    );
    assert.match(
        result.cpp,
        new RegExp(
            `bbl::update_storage_buffer\\(${engineAlias[1]}, \\(\\*${buffer[1]}\\), `,
        ),
    );
});

test("refuses a TypedArray.set source that is not a numeric sequence", () => {
    // A bound container of the wrong element type reaches the shared
    // conversion and is refused by the sink rather than by luck.
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    void engine;
                    const names = ["a", "b"];
                    const values = new Float32Array(4);
                    values.set(names as unknown as number[], 0);
                }
            `),
        /TypedArray\.set expects a numeric sequence/,
    );
    // A literal is refused one level lower, per element, which is the
    // message the constructor's own array-literal arm already gives.
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";

                async function main() {
                    const engine = await createEngine({});
                    void engine;
                    const values = new Float32Array(4);
                    values.set(["a", "b"] as unknown as number[], 0);
                }
            `),
        /Expected a compileable number/,
    );
});

test("a null-defaulted guard over a nullable pick conjoins its presence test", () => {
    // `info.hit ? info.pickedMesh : null`. Upstream `pickedMesh` is one
    // nullable reference -- `createEmptyPickingInfo` sets `hit: false` and
    // `pickedMesh: null` together, and a contributor hit sets `hit` with a
    // null mesh -- and this port spells that reference as the value plus
    // its own presence test. So the guard is another term of that test,
    // not a second native branch: `null` has no native storage to select.
    const guarded = compileSource(`
        import { createCylinder, createEngine, createGpuPicker, createSceneContext, pickAsync, registerScene } from "babylon-lite";
        import type { Mesh } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const cylinder = createCylinder(engine, { height: 2, diameter: 1 });
            const cylinders: Mesh[] = [cylinder];
            await registerScene(scene);
            const picker = createGpuPicker(scene);
            canvas.addEventListener("pointerdown", async (e) => {
                const info = await pickAsync(picker, e.offsetX, e.offsetY);
                const picked = info.hit ? info.pickedMesh : null;
                const target = picked && cylinders.includes(picked as Mesh) ? (picked as Mesh) : null;
                canvas.dataset.picked = target ? "yes" : "no";
            });
        }
        void main();
    `);
    assert.match(
        guarded.cpp,
        /\w+\.hit && \(\w+\.picked_kind != bbl::PickedNodeKind::none\)/,
    );
    // Represented native alternatives keep their payloads and identities.
    const mixed = compileSource(`
        import { createCylinder, createEngine, createSceneContext } from "babylon-lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const cylinder = createCylinder(engine, { height: 2, diameter: 1 });
            const chooseMesh = canvas.clientWidth > 100;
            const chosen = chooseMesh ? cylinder : scene;
            if (chooseMesh ? chosen !== cylinder : chosen !== scene) {
                throw new Error("selected owner identity");
            }
        }
        void main();
    `);
    assert.match(
        mixed.cpp,
        /std::variant<bbl::MeshHandle, bbl::Scene> v_chosen = \(v_chooseMesh \?/,
    );
    assert.match(mixed.cpp, /std::in_place_index<0>, v_cylinder/);
    assert.match(mixed.cpp, /std::in_place_index<1>, v_scene/);
    assert.match(mixed.cpp, /std::get<0>\(\w+\) == \w+/);
    assert.match(mixed.cpp, /std::get<1>\(\w+\) == \w+/);
});

test("a CSM receiver callback reaches the consts its registration precedes", () => {
    // The callback runs at each fit, after `blendData` and `savedVP` exist.
    const result = compileSource(`
        import { addToScene, createArcRotateCamera, createCsmDirectionalShadowGenerator, createDirectionalLight, createEngine, createSceneContext, onCsmReceiverUpdate } from "@babylonjs/lite";
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const scene = createSceneContext(engine);
        scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 50, { x: 0, y: 0, z: 0 });
        const light = createDirectionalLight([0, -1, -1], 0.8);
        addToScene(scene, light);
        const generator = createCsmDirectionalShadowGenerator(engine, light, { mapSize: 256, numCascades: 2 });
        function install(): () => number {
            const uData = new Float32Array(84);
            const upload = (): void => { blendData[1] = uData[0]!; savedVP.set(uData.subarray(0, 16)); };
            onCsmReceiverUpdate(generator, (data) => { uData.set(data.subarray(0, 80), 0); upload(); });
            const blendData = new Float32Array(48);
            const savedVP = new Float32Array(16);
            return () => blendData[1]! + savedVP[0]!;
        }
        const read = install();
        if (read() < 0) throw new Error("read");
    `);
    assert.match(result.cpp, /on_csm_receiver_update\(/);
    assert.match(result.cpp, /v_\w*blendData/);
});
