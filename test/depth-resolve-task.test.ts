import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    pinnedDepthResolveHeader,
    pinnedDepthResolveModule,
} from "../src/lowering/pinned-depth-resolve.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * A multisampled scene target whose depth a depth-resolve task writes into
 * a single-sample, sampled one, as a post chain builds it.
 */
const resolveProgram = (config: string): string => `
import { addTask, createDepthResolveTask, createEngine, createRenderTask, createSceneContext, createSurfaceRenderTargetTexture, registerScene, startEngine, withSampledDepthTexture } from "@babylonjs/lite";
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement, { msaaSamples: 4 });
const scene = createSceneContext(engine, { defaultRenderTask: false });
const source = createSurfaceRenderTargetTexture(engine, { lbl: "scene", format: "rgba8unorm", dFormat: "depth24plus-stencil8", samples: 4, size: scene.surface }).rt;
const resolved = createSurfaceRenderTargetTexture(engine, { lbl: "resolved", dFormat: "depth24plus", samples: 1, size: scene.surface }, withSampledDepthTexture);
addTask(scene, createRenderTask({ name: "scene", rt: source }, engine, scene));
addTask(scene, createDepthResolveTask(${config}, engine, scene));
await registerScene(scene);
await startEngine(engine);
`;

test("a depth-resolve task lowers over its two targets, named as the pin names it", () => {
    const named = compileSource(
        resolveProgram(
            '{ name: "scene-depth-resolve", sourceTexture: source, targetTexture: resolved.rt }',
        ),
    );
    assert.match(
        named.cpp,
        /bbl::create_depth_resolve_task\([^;]*, bbl::DepthResolveTaskOptions\{"scene-depth-resolve", true, v_\w*source, v_\w*resolved\.rt\}\)/,
    );
    assert.ok(named.manifest.features?.includes("frame-graph:depth-resolve"));
    // Unnamed, the task takes the pin's default and its refusals quote none.
    assert.match(
        compileSource(
            resolveProgram(
                "{ sourceTexture: source, targetTexture: resolved.rt }",
            ),
        ).cpp,
        /bbl::DepthResolveTaskOptions\{"depth-resolve", false, /,
    );
    assert.throws(
        () =>
            compileSource(
                resolveProgram(
                    "{ sourceTexture: source, targetTexture: resolved.rt, lodLevel: 1 }",
                ),
            ),
        /Reached depth-resolve tasks support name, sourceTexture and targetTexture\./,
    );
    assert.throws(
        () => compileSource(resolveProgram("{ sourceTexture: source }")),
        /A depth-resolve task requires targetTexture\./,
    );
});

test("the depth-resolve module, pass and refusals are read off the pin's own run", () => {
    const module = pinnedDepthResolveModule();
    assert.equal(module.stem, "depth-resolve");
    assert.match(module.wgsl, /texture_depth_multisampled_2d/);
    assert.match(module.wgsl, /@builtin\(frag_depth\)/);
    const header = pinnedDepthResolveHeader(new LoweringContext());
    assert.match(
        header,
        /inline constexpr float depth_resolve_clear_depth = 0\.0f;/,
    );
    // The packaged factory throws its codes for three refusals and the
    // size mismatch as written.
    for (const [refusal, code] of [
        ["depth_resolve_source_without_depth", 116],
        ["depth_resolve_single_sample_source", 117],
        ["depth_resolve_target_without_depth", 118],
    ] as const)
        assert.match(
            header,
            new RegExp(
                `${refusal}\\(\\[\\[maybe_unused\\]\\] const std::string& name\\) \\{\\n    return std::string\\("#${code}"\\);`,
            ),
        );
    assert.match(
        header,
        /return std::string\("DepthResolveTask \\""\) \+ name \+ "\\": targetTexture size " \+ std::to_string\(target_width\) \+ "×" \+ std::to_string\(target_height\) \+ " must match sourceTexture size " \+ std::to_string\(source_width\) \+ "×" \+ std::to_string\(source_height\)/,
    );
});

/** A target recorded by a render task, read for its colour texture identity. */
const identityProgram = (read: string): string => `
import { addTask, createEffectRenderTask, createEffectWrapper, createEngine, createRenderTarget, createSceneContext, onBeforeRender, registerScene, startEngine } from "@babylonjs/lite";
interface RenderTargetInternals { _colorView: GPUTextureView | null; _colorTexture: GPUTexture | null }
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
const stable = createRenderTarget({ lbl: "stable", format: "rgba8unorm", samples: 1, size: engine });
const fill = createEffectWrapper(engine, { name: "fill", fragmentWGSL: "@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{return vec4<f32>(input.uv,0.0,1.0);}" });
addTask(scene, createEffectRenderTask({ name: "fill", effect: fill, target: stable }, engine, scene));
const stableI = stable as unknown as RenderTargetInternals;
let lastStableTex: GPUTexture | null = null;
let reallocations = 0;
onBeforeRender(scene, () => {
    if (!stableI._colorView) return;
${read}
    if (bufferRealloc) reallocations++;
});
await registerScene(scene);
await startEngine(engine);
`;

test("a render target's colour texture is read as a nullable identity a let keeps and compares", () => {
    const compiled = compileSource(
        identityProgram(`
    const bufferRealloc = lastStableTex !== null && stableI._colorTexture !== lastStableTex;
    lastStableTex = stableI._colorTexture;`),
    );
    assert.match(
        compiled.cpp,
        /bbl::js::Nullable<bbl::GpuTextureIdentity> v_lastStableTex = bbl::js::Nullable<bbl::GpuTextureIdentity>\{std::nullopt\};/,
    );
    assert.match(
        compiled.cpp,
        /v_lastStableTex = bbl::render_target_color_texture\(v_engine, v_stableI\);/,
    );
    assert.ok(
        compiled.manifest.features?.includes(
            "frame-graph:color-texture-identity",
        ),
    );
    // An eager target's allocation is published where the factory made it,
    // and only when an identity is read.
    const hook =
        /\.allocation = surface_sized \? TargetAllocation::surface : TargetAllocation::fixed;\n\s+if \(options\.has_color\) [^;]+\.color_texture = publish_gpu_texture_identity\(engine\);/;
    const lowered = (colorTexture: boolean): string =>
        new RenderTargetLowerer(new LoweringContext(), {
            colorView: true,
            colorTexture,
        }).lower().source;
    assert.match(lowered(true), hook);
    assert.doesNotMatch(lowered(false), /TargetAllocation/);
});

test("colour textures and depth-resolve tasks keep the pin's facts natively", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "depth-resolve-task",
        `#include <bblite/runtime.hpp>
#include <iostream>
using namespace bbl;
template <class F> bool refused(F function) {
    try { function(); } catch (const std::exception&) { return true; }
    return false;
}
RenderTargetHandle target(Engine& engine, bool color, bool depth) {
    RenderTargetRecord record;
    record.has_color = color;
    record.has_depth = depth;
    engine.render_targets.push_back(record);
    return RenderTargetHandle{static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}
TaskHandle effect(Engine& engine, RenderTargetHandle output) {
    FrameTaskRecord task;
    task.kind = FrameTaskKind::effect;
    task.effect.target = output;
    return append_frame_task(engine, std::move(task));
}
int main() {
    Engine engine;
    const RenderTargetHandle stable = target(engine, true, false), fixed = target(engine, true, false),
                             surface = target(engine, true, false);
    engine.render_targets[fixed.value].allocation = TargetAllocation::fixed;
    engine.render_targets[fixed.value].color_view = true;
    engine.render_targets[fixed.value].color_texture = publish_gpu_texture_identity(engine);
    engine.render_targets[surface.value].allocation = TargetAllocation::surface;
    const auto texture = [&](RenderTargetHandle handle) { return render_target_color_texture(engine, handle); };
    // Null before the record builds it; one object per build after.
    std::cout << texture(stable).has_value() << " ";
    const TaskHandle fill = effect(engine, stable), still = effect(engine, fixed);
    record_task_color_views(engine, handle_at(engine.frame_tasks, fill));
    const auto first = texture(stable);
    const auto eager = texture(fixed);
    record_task_color_views(engine, handle_at(engine.frame_tasks, still));
    std::cout << first.has_value() << (texture(stable) == first) << (texture(fixed) == eager) << " ";
    // A resize rebuilds the targets of the engine canvas's registered scenes.
    Scene scene, other;
    scene.engine = &engine;
    other.engine = &engine;
    other.surface_canvas = UiElementHandle{0};
    const RenderTargetHandle elsewhere = target(engine, true, false), waiting = target(engine, true, false);
    const TaskHandle painted = effect(engine, elsewhere), pending = effect(engine, waiting);
    record_task_color_views(engine, handle_at(engine.frame_tasks, painted));
    record_task_color_views(engine, handle_at(engine.frame_tasks, pending));
    handle_at(engine.frame_tasks, pending).record_state = FrameTaskRecordState::pending_build;
    scene.tasks = {fill, still, pending};
    other.tasks = {painted};
    engine.rendering_contexts.push_back("scene", std::make_shared<Scene>(scene));
    engine.rendering_contexts.push_back("scene", std::make_shared<Scene>(other));
    const auto painted_texture = texture(elsewhere), waiting_texture = texture(waiting);
    rebuild_canvas_task_targets(engine);
    std::cout << (texture(stable) == first) << (texture(fixed) == eager)
              << (texture(elsewhere) == painted_texture) << (texture(waiting) == waiting_texture) << " ";
    // Disposal clears it; the swapchain's and a surface target's refuse.
    engine.render_targets[stable.value].retired = true;
    const RenderTargetHandle swapchain = target(engine, true, false);
    engine.render_targets[swapchain.value].swapchain = true;
    std::cout << texture(stable).has_value() << refused([&] { (void)texture(swapchain); })
              << refused([&] { (void)texture(surface); }) << " ";
    // The task's source depth gains its binding once, rebuilding the targets once.
    const RenderTargetHandle msaa = target(engine, true, true), depth = target(engine, true, true),
                             depthless = target(engine, true, false);
    engine.render_targets[msaa.value].samples = 4;
    const auto version = engine.render_targets_version;
    const TaskHandle resolve =
        create_depth_resolve_task(engine, scene, DepthResolveTaskOptions{"resolve", true, msaa, depth});
    (void)create_depth_resolve_task(engine, scene, DepthResolveTaskOptions{"again", true, msaa, depthless});
    std::cout << engine.render_targets[msaa.value].depth_binding
              << engine.render_targets[depth.value].depth_binding
              << engine.render_targets_version - version
              << (handle_at(engine.frame_tasks, resolve).kind == FrameTaskKind::depth_resolve) << " ";
    // Its record builds the target only while that has no depth texture.
    FrameTaskRecord record = handle_at(engine.frame_tasks, resolve);
    record_task_color_views(engine, record);
    const auto built = texture(depth);
    record_task_color_views(engine, record);
    record.depth_resolve.target = depthless;
    record_task_color_views(engine, record);
    const auto rebuilt = texture(depthless);
    record_task_color_views(engine, record);
    std::cout << built.has_value() << (texture(depth) == built) << (texture(depthless) == rebuilt)
              << refused([&] {
                     (void)create_depth_resolve_task(engine, scene, DepthResolveTaskOptions{"x", false, RenderTargetHandle{99}, depth});
                 });
}
`,
        {
            timeoutMs: 20000,
            expectedOutput: "0 111 0111 011 1011 1101",
        },
    );
});
