import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const imports = `import {createStandardMaterial, type EngineContext, type Mesh, type SceneContext} from "@babylonjs/lite";`;
const retain = (parameters: string, body: string): string => `${imports}
    function make(${parameters}): () => number {
        return () => {${body}};
    }
    const callbacks: Array<typeof make> = [make];
    if (callbacks.length !== 1) throw new Error("retained factory");
`;
const materialBody = `const material = createStandardMaterial();
    material.alpha = 0.25;
    return 0.25;`;

test("unused stored engine parameters reuse their owning argument storage", () => {
    const { cpp } = compileSource(`
        import type {EngineContext} from "@babylonjs/lite";
        function read(value: number, engine: EngineContext): number {return value;}
        const readers: Array<typeof read> = [read];
        if (readers.length !== 1) throw new Error("retained reader");
    `);
    assert.match(cpp, /bbl::StoredEngine fn\d+_arg_1/);
    assert.doesNotMatch(cpp, /const bbl::StoredEngine \w+ = fn\d+_arg_1;/);
});

test("camera callbacks retain construction owners after nullable engine reset", (t) => {
    const { cpp, manifest } = compileSource(`
        import {createEngine, createSceneContext, createArcRotateCamera, attachControl,
            type EngineContext, type ArcRotateCamera} from "@babylonjs/lite";
        function camera() {
            return createArcRotateCamera(0.5, 1, 2, {x: 0, y: 0, z: 0});
        }
        function read(camera: ArcRotateCamera): number {return camera.alpha;}
        async function main(): Promise<void> {
            let engine: EngineContext | null = null;
            engine = await createEngine(new OffscreenCanvas(1, 1));
            const scene = createSceneContext(engine);
            const view = camera();
            const dispose = attachControl(view, scene);
            engine = null;
            const readers: Array<() => number> = [() => {dispose(); return read(view);}];
            if (readers[0]!() !== 0.5) throw new Error("lost camera owner");
            globalThis.close();
        }
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const output = resolve("artifacts/camera-context-snapshot");
    emitUpstreamGenerated(output, manifest.features);
    runGeneratedProgram(
        tools,
        "camera-context-snapshot",
        `
        #include <bblite/pal_async_engine.hpp>
        namespace { std::weak_ptr<bbl::Engine> lifetime; unsigned attached = 0; }
        namespace bbl::pal {
            std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
                auto engine = std::make_shared<Engine>();
                engine->realm_owner = engine;
                lifetime = engine;
                return engine;
            }
        }
        #define main generated_main
        ${cpp}
        #undef main
        namespace bbl {
            Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
            CameraHandle create_arc_rotate_camera(Engine& engine, double alpha, double, double, Vec3d) {
                if (lifetime.lock().get() != &engine) throw std::runtime_error("wrong construction owner");
                engine.cameras.emplace_back();
                engine.cameras.back().alpha = alpha;
                return {static_cast<std::uint32_t>(engine.cameras.size() - 1)};
            }
            void attach_control(Engine& engine, CameraHandle camera, const Scene&) {
                if (lifetime.lock().get() != &engine || handle_at(engine.cameras, camera).alpha != 0.5)
                    throw std::runtime_error("wrong control owner");
                ++attached;
            }
        }
        int main() {
            const int result = generated_main();
            if (attached != 1 || !lifetime.expired()) throw std::runtime_error("camera owner lifetime");
            return result;
        }
        `,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
            includeDirectories: [resolve(output, "upstream/include")],
            timeoutMs: 10000,
        },
    );
});

for (const [owned, demanded] of [
    [false, false],
    [true, false],
    [true, true],
] as const) {
    test(`${demanded ? "demanded record" : owned ? "owned nullable" : "entry"} engine aliases share class and nested helper contexts`, (t) => {
        const { cpp } = compileSource(`
            import {createEngine, createStandardMaterial, stopEngine, type EngineContext} from "@babylonjs/lite";
            function context(engine: EngineContext) {
                return {engine, stop() {stopEngine(engine);}};
            }
            let creations = 0;
            interface State {readonly engine: EngineContext; ${demanded ? "" : "values: number[];"} count: number;}
            function stored(engine: EngineContext): State {
                creations++;
                return {engine, ${demanded ? "" : "values: [],"} count: 1};
            }
            function construct(): void {
                const material = createStandardMaterial();
                material.alpha = 0.25;
            }
            function build(left: ReturnType<typeof context>, right: State): void {
                ${demanded ? "" : "right.values.push(1);"}
                right["count"] = 2;
                const {count} = right;
                if (count !== 2) throw new Error("stale record value");
                construct();
                left.stop(); stopEngine(right.engine);
            }
            class Owner {
                readonly engine: EngineContext;
                constructor(engine: EngineContext) {
                    this.engine = engine;
                    construct();
                }
            }
            async function main(): Promise<void> {
                ${
                    owned
                        ? "let engine: EngineContext | null = null; engine = await createEngine(new OffscreenCanvas(1, 1));"
                        : "const engine = await createEngine({});"
                }
                new Owner(engine);
                const state${demanded ? "" : ": State"} = stored(engine);
                ${
                    demanded
                        ? `const states: State[] = [state];
                state["count"] = 2;
                if (states[0]!.count !== 2) throw new Error("lost stored record alias");`
                        : ""
                }
                build(context(engine), state);
                if (creations !== 1) throw new Error("repeated initializer");
                stopEngine(engine);
                ${owned ? "globalThis.close();" : ""}
            }
        `);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Requires the Windows native fixture compiler.");
            return;
        }
        runGeneratedProgram(
            tools,
            `engine-context-aliases-${demanded ? "demanded" : owned ? "owned" : "entry"}`,
            `
            #include <bblite/${owned ? "pal_async_engine" : "runtime"}.hpp>
            namespace { bbl::Engine* original = nullptr; unsigned stops = 0; }
            ${
                owned
                    ? `
            namespace { std::weak_ptr<bbl::Engine> lifetime; }
            namespace bbl::pal {
                std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
                    auto engine = std::make_shared<Engine>();
                    engine->realm_owner = engine;
                    lifetime = engine;
                    return engine;
                }
            }`
                    : "namespace bbl { Engine create_engine(EngineOptions) { return {}; } }"
            }
            #define main generated_main
            ${cpp}
            #undef main
            namespace bbl {
                MaterialHandle create_standard_material(Engine& engine) {
                    if (original && original != &engine) throw std::runtime_error("different alias owner");
                    original = &engine;
                    engine.materials.emplace_back();
                    return {static_cast<std::uint32_t>(engine.materials.size() - 1)};
                }
                void stop_engine(Engine& engine) {
                    if (original != &engine || engine.materials.size() != 2 ||
                        engine.materials[0].alpha != 0.25f || engine.materials[1].alpha != 0.25f)
                        throw std::runtime_error("wrong context owner");
                    ++stops;
                }
            }
            int main() {
                const int result = generated_main();
                if (stops != 3) throw std::runtime_error("lost alias call");
                ${owned ? 'if (!lifetime.expired()) throw std::runtime_error("engine alias leak");' : ""}
                return result;
            }
        `,
            {
                ...(owned
                    ? {
                          defines: [
                              "BBLITE_WORKERS=1",
                              "BBLITE_OFFSCREEN_SURFACES=1",
                          ],
                      }
                    : {}),
                timeoutMs: 10000,
            },
        );
    });
}

for (const [label, parameter, depth] of [
    ["direct", "engine: EngineContext", 0],
    ["record", "state: {engine: EngineContext}", 1],
    ["nested record", "state: {context: {engine: EngineContext}}", 2],
] as const) {
    test(`retained ${label} engine contexts keep independent owners and callback lifetimes`, (t) => {
        const engine =
            depth === 0
                ? "engine"
                : depth === 1
                  ? "state.engine"
                  : "state.context.engine";
        const { cpp } = compileSource(
            retain(
                parameter,
                materialBody.replace(
                    "return 0.25;",
                    `
            const aliases: EngineContext[] = [${engine}, ${engine}];
            const keys = new Set<EngineContext>();
            keys.add(aliases[0]!); keys.add(aliases[1]!);
            const values = new Map<EngineContext, number>();
            values.set(aliases[0]!, 3); values.set(aliases[1]!, 4);
            const present: EngineContext | null = ${engine}.drawCallCount > 0 ? aliases[0]! : null;
            const absent: EngineContext | null = ${engine}.drawCallCount < 0 ? aliases[0]! : null;
            if (!present || absent || present !== ${engine} || keys.size !== 1 || values.size !== 1 || values.get(present) !== 4)
                throw new Error("engine storage identity");
            return 0.25;
        `,
                ),
            ),
        );
        // Invoke the generated retained boundary with two real owners. The entry
        // itself deliberately has no engine allocation or ambient owner.
        const factory =
            /bbl::js::Callback<double\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] ([\w:]+) \w+\);/.exec(
                cpp,
            );
        assert.ok(factory, "retained factory prototype");
        const [, name, environment, parameterType] = factory;
        const argument = (owner: string): string => {
            let value = `bbl::StoredEngine{${owner}}`;
            if (depth === 2) {
                const inner = /using (\w+) = bbl::js::Ref<(\w+)>;/.exec(cpp);
                assert.ok(inner, "nested record reference storage");
                value = `bbl::js::make_ref<bblscene::${inner[2]}>(bblscene::${inner[2]}{${value}})`;
            }
            return depth
                ? `bbl::js::make_ref<${parameterType}::element_type>(${parameterType}::element_type{${value}})`
                : value;
        };
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Requires the Windows native fixture compiler.");
            return;
        }
        runGeneratedProgram(
            tools,
            `engine-boundary-${depth}`,
            `
            #define main generated_main
            ${cpp}
            #undef main
            #include <cassert>
            namespace bbl {
                MaterialHandle create_standard_material(Engine& engine) {
                    ++engine.draw_call_count;
                    engine.materials.emplace_back();
                    return {static_cast<std::uint32_t>(engine.materials.size() - 1)};
                }
            }
            int main() {
                const bbl::js::RealmScope realm;
                auto first = std::make_shared<bbl::Engine>();
                auto second = std::make_shared<bbl::Engine>();
                std::weak_ptr<bbl::Engine> first_weak = first, second_weak = second;
                bblscene::${environment} environment{};
                auto left = bblscene::${name}(environment, ${argument("first")});
                auto right = bblscene::${name}(environment, ${argument("second")});
                first.reset(); second.reset();
                assert(!first_weak.expired() && !second_weak.expired());
                assert(left() == 0.25 && left() == 0.25 && right() == 0.25);
                assert(first_weak.lock()->draw_call_count == 2);
                assert(second_weak.lock()->draw_call_count == 1);
                assert(first_weak.lock()->materials.size() == 2);
                assert(second_weak.lock()->materials.size() == 1);
                assert(first_weak.lock()->materials[0].alpha == 0.25f);
                assert(second_weak.lock()->materials[0].alpha == 0.25f);
                left = {}; right = {};
                bbl::js::collect_cycles();
                assert(first_weak.expired() && second_weak.expired());

                bbl::StoredEngine borrowed;
                { bbl::Engine entry; borrowed = bbl::StoredEngine{entry}; }
                bool expired = false;
                try { static_cast<void>(*borrowed); }
                catch (const std::runtime_error&) { expired = true; }
                assert(expired);
            }
        `,
            {
                defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
                timeoutMs: 10000,
            },
        );
    });
}

test("implicit constructors refuse ambiguous contexts and unowned raw handles", () => {
    for (const parameter of [
        "first: EngineContext, second: EngineContext",
        "state: {first: EngineContext, second: EngineContext}",
    ])
        assert.throws(
            () => compileSource(retain(parameter, materialBody)),
            /one unambiguous engine context/,
        );
    assert.throws(
        () => compileSource(retain("", materialBody)),
        /requires createEngine to run first/,
    );
    assert.throws(
        () =>
            compileSource(
                retain(
                    "first: SceneContext, second: SceneContext",
                    materialBody,
                ),
            ),
        /requires createEngine to run first/,
    );
    assert.throws(
        () =>
            compileSource(
                retain(
                    "engine: EngineContext, mesh: Mesh",
                    "mesh.position.x += 1; return mesh.position.x;",
                ),
            ),
        /not associated with an engine/,
    );
});

test("nullable engine reassignment keeps earlier and later snapshots distinct", () => {
    assert.throws(
        () =>
            compileSource(`
            import {createStandardMaterial, type EngineContext} from "@babylonjs/lite";
            function context(engine: EngineContext) {
                return {engine, read() {return engine.drawCallCount;}};
            }
            function build(first: ReturnType<typeof context>, second: ReturnType<typeof context>): void {
                createStandardMaterial();
            }
            function make(firstOwner: EngineContext, secondOwner: EngineContext): () => number {
                let engine: EngineContext | null = null;
                engine = firstOwner;
                const first = context(engine);
                engine = null;
                engine = secondOwner;
                const second = context(engine);
                return () => {build(first, second); return 0;};
            }
            const factories: Array<typeof make> = [make];
            if (factories.length !== 1) throw new Error("retained factory");
        `),
        /one unambiguous engine context/,
    );
});

test("stored engine Promise results preserve the owned ABI and source identity", (t) => {
    const { cpp } = compileSource(
        `
        import {createEngine, stopEngine, type EngineContext} from "@babylonjs/lite";
        async function carry(engine: EngineContext): Promise<EngineContext> {
            await new Promise<void>(resolve => queueMicrotask(resolve));
            return await Promise.resolve(engine);
        }
        const callbacks: Array<typeof carry> = [carry];
        const engine = await createEngine(new OffscreenCanvas(1, 1));
        const result = await callbacks[0]!(engine);
        if (result !== engine) throw new Error("promise engine identity");
        stopEngine(result);
        globalThis.close();
    `,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    runGeneratedProgram(
        tools,
        "stored-engine-promise",
        `
        #include <bblite/pal_async_engine.hpp>
        namespace { std::weak_ptr<bbl::Engine> original; unsigned stops = 0; }
        namespace bbl::pal {
            std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
                auto engine = std::make_shared<Engine>();
                engine->realm_owner = engine;
                original = engine;
                return engine;
            }
        }
        #define main generated_main
        ${cpp}
        #undef main
        namespace bbl {
            void stop_engine(Engine& engine) {
                if (original.lock().get() != &engine) throw std::runtime_error("wrong engine");
                ++stops;
            }
        }
        int main() {
            const int result = generated_main();
            if (stops != 1 || !original.expired()) throw std::runtime_error("engine result lifetime");
            return result;
        }
    `,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
            timeoutMs: 10000,
        },
    );
});

test("retained shader factories use their represented engine and bounded shader layout", () => {
    const { cpp, manifest } = compileSource(`
        import {createShaderMaterial, setShaderFloat, type EngineContext} from "@babylonjs/lite";
        function make(engine: EngineContext): void {
            const material = createShaderMaterial({
                vertexSource: "struct Output{@builtin(position) position:vec4<f32>,}; @vertex fn mainVertex(input:VertexInput)->Output{var result:Output;result.position=vec4<f32>(input.position,1.0);return result;}",
                fragmentSource: "@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(shaderUniforms.amount);}",
                attributes: ["position"],
                uniforms: [{name: "amount", type: "f32", defaultValue: 0}],
            });
            setShaderFloat(material, "amount", 0.5);
        }
        const callbacks: Array<typeof make> = [make];
        if(callbacks.length !== 1) throw new Error("retained shader");
    `);
    assert.match(cpp, /create_shader_material\(/);
    assert.match(cpp, /set_shader_uniform_value\(/);
    assert.equal(manifest.shaderVariants.length, 1);
});
