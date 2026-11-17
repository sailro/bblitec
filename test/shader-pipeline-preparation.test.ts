import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerShaderPipelinePreparation } from "../src/lowering/shader-pipeline-preparation.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

// A registered scene, a render task on a render target and a ShaderMaterial,
// then `body`.
const program = (body: string): string => `
import { createEngine, createSceneContext, createFreeCamera, createSphere, addToScene, registerScene, createRenderTask, addTask, createRenderTargetTexture, createStandardMaterial, createShaderMaterial, prepareShaderMaterialPipelineForTask, startEngine, wgsl } from "@babylonjs/lite";
const VERTEX = wgsl\`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera([0, 0, -5], [0, 0, 0]);
const sphere = createSphere(engine, { diameter: 1 });
sphere.material = createStandardMaterial();
addToScene(scene, sphere);
const target = createRenderTargetTexture(engine, { lbl: "t", format: "rgba8unorm", dFormat: "depth24plus", samples: 1, size: { width: 8, height: 8 } });
const task = createRenderTask({ name: "mask", rt: target.rt, autoMirror: false }, engine, scene);
addTask(scene, task);
const silhouette = createShaderMaterial({ name: "silhouette", vertexSource: VERTEX, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
await registerScene(scene);
${body}
await startEngine(engine);
`;

test("prepareShaderMaterialPipelineForTask settles the native preparation of a task's material", () => {
    const { cpp } = compileSource(
        program(`
let ready = false;
await Promise.all([
    prepareShaderMaterialPipelineForTask(task, silhouette, "mesh"),
    prepareShaderMaterialPipelineForTask(task, silhouette, "thin-instances", sphere),
]).then(() => { ready = true; });
if (!ready) throw new Error("preparation");`),
    );
    const calls = cpp.match(
        /bblscene::(v_\w+prepare_shader_material_pipeline_for_task\w*)\([^;]*, v_\w*task, v_\w*silhouette\)/g,
    );
    assert.equal(calls?.length, 2);
    // One preparation per program, emitted where a call reaches it.
    assert.equal(
        cpp.match(
            /bbl::js::Promise<bbl::js::PromiseVoid> v_\w+prepare_shader_material_pipeline_for_task\w*\(bbl::Engine& engine, bbl::TaskHandle task, bbl::MaterialHandle material\) \{/g,
        )?.length,
        1,
    );
    assert.doesNotMatch(
        compileSource(program("")).cpp,
        /prepare_shader_material_pipeline_for_task/,
    );
});

test("a preparation resolves for a render task's ShaderMaterial and rejects what the pin's reads reject", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const { prototype, lines } = lowerShaderPipelinePreparation(
        new LoweringContext(),
        "prepare",
    );
    runGeneratedProgram(
        tools,
        "shader-pipeline-preparation-check",
        `#include <bblite/runtime.hpp>
#include <bblite/js_promise.hpp>
#include <cassert>
#include <string>
namespace check {
${prototype}
${lines.join("\n")}
}
int main() {
    const bbl::js::RealmScope scope;
    bbl::pal::EventLoop loop;
    bbl::Engine engine;
    engine.frame_tasks.push_back(bbl::FrameTaskRecord{});
    bbl::FrameTaskRecord effect;
    effect.kind = bbl::FrameTaskKind::effect;
    engine.frame_tasks.push_back(effect);
    bbl::MaterialRecord shader;
    shader.shader_material = true;
    engine.materials.push_back(shader);
    engine.materials.push_back(bbl::MaterialRecord{});
    std::string outcomes;
    const auto observe = [&](bbl::js::Promise<bbl::js::PromiseVoid> promise, char name) {
        static_cast<void>(promise.then(
            [&outcomes, name](const bbl::js::PromiseVoid&) { outcomes += name; },
            [&outcomes, name](std::exception_ptr) { outcomes += static_cast<char>(name - 'a' + 'A'); }));
    };
    loop.run([&] {
        observe(check::prepare(engine, bbl::TaskHandle{0}, bbl::MaterialHandle{0}), 'a');
        observe(check::prepare(engine, bbl::TaskHandle{1}, bbl::MaterialHandle{0}), 'b');
        observe(check::prepare(engine, bbl::TaskHandle{0}, bbl::MaterialHandle{1}), 'c');
        // The pin's preparation is an async function: nothing settles in this turn.
        assert(outcomes.empty());
        loop.post([&] { loop.close(); });
    });
    assert(outcomes == "aBC");
}
`,
        { expectedOutput: "", timeoutMs: 10000 },
    );
});
