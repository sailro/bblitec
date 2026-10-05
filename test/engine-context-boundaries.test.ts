import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
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
            return depth ? `${parameterType}{${value}}` : value;
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
