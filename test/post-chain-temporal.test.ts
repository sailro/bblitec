import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { pinnedMultisampledTaskTransmissionModules } from "../src/pinned-utility-passes.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * A TAA task a helper creates after the entry awaited, before the scene
 * registers, as a post chain builds its halton arm.
 */
const temporalProgram = (registerFirst: boolean): string => `
import { addTask, addToScene, createArcRotateCamera, createBox, createEngine, createRenderTarget, createRenderTask, createSceneContext, createStandardMaterial, createTaaPostProcessTask, registerScene, startEngine } from "@babylonjs/lite";
type Engine = Awaited<ReturnType<typeof createEngine>>;
type Scene = ReturnType<typeof createSceneContext>;
function setup(engine: Engine, scene: Scene, temporal: boolean): void {
    const sceneRT = createRenderTarget({ lbl: "scene", format: engine.format, dFormat: "depth24plus-stencil8", samples: 1, size: engine });
    const sceneTask = createRenderTask({ name: "scene", rt: sceneRT }, engine, scene);
    addTask(scene, sceneTask);
    if (temporal)
        addTask(scene, createTaaPostProcessTask({ name: "taa", sourceTexture: sceneRT, sourceRenderTask: sceneTask, factor: 0.2 }, engine, scene));
}
async function main(): Promise<void> {
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.camera = createArcRotateCamera(0.6, 1.1, 4, { x: 0, y: 0, z: 0 });
    const box = createBox(engine, { size: 1.4 });
    box.material = createStandardMaterial();
    addToScene(scene, box);
    await new Promise((resolve) => setTimeout(resolve, 1));
    ${registerFirst ? "await registerScene(scene);" : ""}
    setup(engine, scene, Math.random() < 2);
    ${registerFirst ? "" : "await registerScene(scene);"}
    await startEngine(engine);
}
main().catch(console.error);
`;

test("a TAA task created after an await, before registration, lowers with its source's retained block", () => {
    assert.match(
        compileSource(temporalProgram(false)).cpp,
        /bbl::create_composite_post_process_task_0\(/,
    );
    assert.throws(
        () => compileSource(temporalProgram(true)),
        /TAA tasks must be constructed and attached before initial scene registration/,
    );
});

/** A render task grabbing its target mid-pass, at a sample count `samples` spells. */
const grabProgram = (samples: string): string => `
import { addTask, createEngine, createRenderTarget, createRenderTask, createSceneContext, enableRenderTaskTransmission, registerScene, startEngine } from "@babylonjs/lite";
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement, { msaaSamples: 4 });
const scene = createSceneContext(engine, { defaultRenderTask: false });
const target = createRenderTarget({ lbl: "scene", format: engine.format, dFormat: "depth24plus-stencil8", samples: ${samples}, size: engine });
const resolved = createRenderTarget({ lbl: "resolved", format: engine.format, samples: 1, size: engine });
const task = createRenderTask({ name: "scene", rt: target, rst: resolved }, engine, scene);
addTask(scene, task);
enableRenderTaskTransmission(task, engine, { linear: false, generateMipmaps: false, grabDepth: true });
await registerScene(scene);
await startEngine(engine);
`;

test("a grab of a target not proven single-sample deploys the pin's multisampled arms", () => {
    const reaches = (samples: string): boolean =>
        compileSource(grabProgram(samples)).manifest.features?.includes(
            "frame-graph:multisampled-task-transmission",
        ) ?? false;
    assert.equal(reaches("engine.msaaSamples"), true);
    assert.equal(reaches("4"), true);
    assert.equal(reaches("1"), false);
    const [color, depth] = pinnedMultisampledTaskTransmissionModules();
    assert.equal(color?.stem, "transmission-grab");
    assert.match(color.wgsl, /texture_multisampled_2d<f32>/);
    assert.equal(depth?.stem, "transmission-depth-grab");
    assert.match(depth.wgsl, /texture_depth_multisampled_2d/);
});

test("multisampled grabs and temporal frames keep the pin's facts natively", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "post-chain-temporal",
        `#include <bblite/runtime.hpp>
#include <iostream>
using namespace bbl;
template <class F> bool refused(F function) {
    try { function(); } catch (const std::exception&) { return true; }
    return false;
}
RenderTargetHandle target(Engine& engine, std::uint32_t samples) {
    RenderTargetRecord record;
    record.samples = samples;
    record.has_depth = true;
    engine.render_targets.push_back(record);
    return RenderTargetHandle{static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}
TaskHandle render(Engine& engine, RenderTargetHandle output) {
    FrameTaskRecord task;
    task.kind = FrameTaskKind::render;
    task.render.target = output;
    return append_frame_task(engine, std::move(task));
}
RenderTaskTransmission grab() {
    RenderTaskTransmission options;
    options.grab_size = 1024;
    return options;
}
int main() {
    Engine engine;
    // A multisampled target's grab reads its colour samples; a single-sample one's does not.
    const RenderTargetHandle msaa = target(engine, 4), single = target(engine, 1), late = target(engine, 4);
    (void)enable_render_task_transmission(engine, render(engine, msaa), grab());
    (void)enable_render_task_transmission(engine, render(engine, single), grab());
    const TaskHandle recorded = render(engine, late);
    handle_at(engine.frame_tasks, recorded).record_state = FrameTaskRecordState::recorded;
    std::cout << engine.render_targets[msaa.value].color_binding
              << engine.render_targets[single.value].color_binding
              << refused([&] { (void)enable_render_task_transmission(engine, recorded, grab()); })
              << " ";
    // Only a registered scene's frame graph holding a TAA task makes a frame temporal.
    Scene scene;
    scene.engine = &engine;
    const std::vector<std::shared_ptr<Scene>> scenes{std::make_shared<Scene>(scene)};
    FrameTaskRecord post;
    post.kind = FrameTaskKind::post_process;
    const TaskHandle plain = append_frame_task(engine, post);
    post.post_process.taa = std::make_shared<TaaPostProcessState>();
    const TaskHandle temporal = append_frame_task(engine, post);
    scene.tasks = {plain};
    const bool before = frame_has_temporal_task(engine, scenes);
    scene.tasks.push_back(temporal);
    std::cout << before << frame_has_temporal_task(engine, scenes)
              << frame_has_temporal_task(engine, {});
}
`,
        {
            timeoutMs: 20000,
            expectedOutput: "101 010",
        },
    );
});
