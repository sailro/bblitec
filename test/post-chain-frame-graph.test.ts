import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerFrameGraphTaskBuild } from "../src/lowering/frame-graph-task-build.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * Frame-graph facts a post-process chain reads or writes: a render target's
 * `_colorView` presence read through a cast, a copy task owning its target,
 * a run-time sample count, an option written `undefined`, and the scene's
 * mesh list copied into a Set.
 */
const program = (body: string): string => `
import { addTask, addToScene, createBox, createCopyToTextureTask, createEffectRenderTask, createEffectWrapper, createEngine, createRenderTarget, createRenderTargetTexture, createRenderTask, createSceneContext, onBeforeRender, registerScene, startEngine, type Mesh } from "@babylonjs/lite";
interface RenderTargetInternals { _colorView: GPUTextureView | null }
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine, { defaultRenderTask: false });
const box = createBox(engine, { size: 1 });
addToScene(scene, box);
const fill = createEffectWrapper(engine, { name: "fill", fragmentWGSL: "@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(input.uv,0.0,1.0);}" });
${body}
await registerScene(scene);
await startEngine(engine);
`;

test("a render target's colour view is tested for presence", () => {
    const compiled = compileSource(
        program(`
const built = createRenderTarget({ lbl: "built", format: "rgba8unorm", samples: 1, size: engine });
const eager = createRenderTargetTexture(engine, { lbl: "eager", format: "rgba8unorm", samples: 1, size: { width: 4, height: 4 } });
addTask(scene, createEffectRenderTask({ name: "fill", effect: fill, target: built }, engine, scene));
const builtView = built as unknown as RenderTargetInternals;
onBeforeRender(scene, () => {
    if (!builtView._colorView || !(built as unknown as RenderTargetInternals)._colorView || !(eager.rt as unknown as RenderTargetInternals)._colorView) return;
    throw new Error("built");
});`),
    );
    assert.match(
        compiled.cpp,
        /if \(\(\(!\(bbl::render_target_color_view_set\(v_engine, v_builtView\)\) \|\| !\(bbl::render_target_color_view_set\(v_engine, v_built\)\)\) \|\| !\(bbl::render_target_color_view_set\(v_engine, v_eager\.rt\)\)\)\)/,
    );
    assert.ok(
        compiled.manifest.features.includes("frame-graph:color-view-state"),
    );
    // Its value is the view object of the target's colour allocation.
    assert.match(
        compileSource(
            program(`
const built = createRenderTarget({ lbl: "built", format: "rgba8unorm", samples: 1, size: engine });
const view = (built as unknown as RenderTargetInternals)._colorView;
if (view) throw new Error("view");`),
        ).cpp,
        /v_view = bbl::render_target_color_view_object\(v_engine, v_built\);/,
    );
});

test("the colour-view state is recorded where the pin builds a target, and only when it is read", () => {
    const context = new LoweringContext();
    const eager = new RenderTargetLowerer(context, { colorView: true }).lower()
        .source;
    assert.match(
        eager,
        /create_render_target\(engine, options\);\n\s*\n\s*\/\/ Eager: buildRenderTarget allocated the colour view\.\n\s*.*\.color_view = options\.has_color;/,
    );
    assert.doesNotMatch(
        new RenderTargetLowerer(context).lower().source,
        /color_view/,
    );
    assert.match(
        lowerFrameGraphTaskBuild(context, "", {}, false, true),
        /record_task_color_views\(engine, task\);/,
    );
    assert.doesNotMatch(
        lowerFrameGraphTaskBuild(context, "", {}, false, false),
        /color_view/,
    );
});

test("a copy task owning its target checks the target where it is made", () => {
    const copy = (owns: string): string =>
        compileSource(
            program(`
const source = createRenderTargetTexture(engine, { lbl: "source", format: "rgba8unorm", samples: 1, size: { width: 4, height: 4 } });
const history = createRenderTarget({ lbl: "history", format: "rgba8unorm", samples: 1, size: engine });
addTask(scene, createCopyToTextureTask({ name: "keep", sourceTexture: source.rt, targetTexture: history${owns} }, engine, scene));`),
        ).cpp;
    assert.match(
        copy(", ownsTargetTexture: true"),
        /bbl::create_copy_to_texture_task\(v_engine, v_scene, bbl::copy_task_owning_target\(v_engine, bbl::CopyTaskOptions\{"keep", bbl::render_target_texture\(v_source\.rt\), v_history, bbl::RenderTargetHandle\{\}, false, bbl::NormalizedViewport\{\}\}, true\)\)/,
    );
    assert.match(
        copy(", ownsTargetTexture: false"),
        /bbl::create_copy_to_texture_task\(v_engine, v_scene, bbl::CopyTaskOptions\{"keep"/,
    );
});

test("a render target's run-time sample count and an option written undefined", () => {
    const compiled = compileSource(
        program(`
const samples = Math.random() > 0.5 ? 4 : 1;
const sceneRT = createRenderTarget({ lbl: "scene", format: "rgba8unorm", dFormat: "depth24plus-stencil8", samples, size: engine });
const single = 1;
const resolve = single > 1 ? createRenderTarget({ lbl: "resolve", format: "rgba8unorm", samples: 1, size: engine }) : null;
addTask(scene, createRenderTask({ name: "scene", rt: sceneRT, rst: resolve ?? undefined, clrColor: scene.clearColor }, engine, scene));`),
    ).cpp;
    assert.match(
        compiled,
        /bbl::RenderTargetOptions\{bbl::render_target_sample_count\(v_samples\), true, true, false, 0u, 0u\}/,
    );
    assert.match(
        compiled,
        /bbl::RenderTaskOptions\{"scene", v_sceneRT, .*, bbl::RenderTextureRef\{\}, bbl::RenderTargetHandle\{\}\}/,
    );
});

test("the scene's meshes copy into a Set of engine-owned handles", () => {
    const compiled = compileSource(
        program(`
const registered = new Map<Mesh, number>([[box, 1]]);
const live = new Set(scene.meshes);
for (const [mesh] of registered) if (!live.has(mesh)) registered.delete(mesh);
if (registered.size !== 1) throw new Error("live");`),
    ).cpp;
    assert.match(
        compiled,
        /bbl::js::array_from_iterable<std::pair<bbl::StoredEngine, bbl::MeshHandle>>\(v_scene\.meshes, \[&\]\(const auto& handle\) \{ return std::pair<bbl::StoredEngine, bbl::MeshHandle>\{bbl::StoredEngine\{v_engine\}, handle\}; \}\)/,
    );
});

test("colour views, owned copy targets and sample counts keep the pin's facts natively", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "post-chain-frame-graph",
        `#include <bblite/runtime.hpp>
#include <iostream>
using namespace bbl;
template <class F> bool refused(F function) {
    try { function(); } catch (const std::runtime_error&) { return true; }
    return false;
}
RenderTargetHandle target(Engine& engine, bool color, std::uint32_t samples, std::uint32_t width) {
    RenderTargetRecord record;
    record.has_color = color;
    record.samples = samples;
    record.width = width;
    record.height = width;
    engine.render_targets.push_back(record);
    return RenderTargetHandle{static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}
int main() {
    Engine engine;
    const RenderTargetHandle msaa = target(engine, true, 4, 0), resolve = target(engine, true, 1, 0),
                             shared = target(engine, true, 1, 0), effect = target(engine, true, 1, 0),
                             copied = target(engine, true, 1, 0), depth = target(engine, false, 1, 0),
                             fixed = target(engine, true, 1, 4);
    engine.render_targets[shared.value].samples = 4;
    const auto set = [&](RenderTargetHandle handle) { return render_target_color_view_set(engine, handle); };
    // Nothing is built before a record.
    std::cout << set(msaa) << set(effect) << " ";
    FrameTaskRecord render;
    render.kind = FrameTaskKind::render;
    render.render.target = msaa;
    render.render.resolve_target = resolve;
    record_task_color_views(engine, render);
    FrameTaskRecord sharing;
    sharing.kind = FrameTaskKind::render;
    sharing.render.target = shared;
    sharing.render.shared_target = true;
    record_task_color_views(engine, sharing);
    FrameTaskRecord drawing;
    drawing.kind = FrameTaskKind::effect;
    drawing.effect.target = effect;
    record_task_color_views(engine, drawing);
    FrameTaskRecord copying;
    copying.kind = FrameTaskKind::copy;
    copying.copy.target = copied;
    copying.copy.resolve_target = depth;
    record_task_color_views(engine, copying);
    std::cout << set(msaa) << set(resolve) << set(shared) << set(effect) << set(copied) << set(depth);
    // Disposal clears it; the swapchain's is always set.
    engine.render_targets[effect.value].retired = true;
    const RenderTargetHandle swapchain = target(engine, true, 1, 0);
    engine.render_targets[swapchain.value].swapchain = true;
    std::cout << " " << set(effect) << set(swapchain);
    // An owned copy target is surface-sized; a fixed one is not represented.
    CopyTaskOptions options;
    options.target = copied;
    std::cout << " " << refused([&] { (void)copy_task_owning_target(engine, options, true); });
    options.target = fixed;
    std::cout << refused([&] { (void)copy_task_owning_target(engine, options, true); })
              << refused([&] { (void)copy_task_owning_target(engine, options, false); });
    std::cout << " " << render_target_sample_count(4) << render_target_sample_count(1)
              << refused([] { (void)render_target_sample_count(2); });
}
`,
        {
            timeoutMs: 20000,
            expectedOutput: "00 110110 01 010 411",
        },
    );
});
