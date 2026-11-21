import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const program = (options: string, body = ""): string => `
import {addTask,createEngine,createRenderTarget,createRenderTask,createSceneContext,createShaderMaterial,createSolidTexture2D,createTexture2DFromPixels,enableRenderTaskTransmission,onBeforeRender,setShaderTexture,type Texture2D} from "@babylonjs/lite";
async function main(){
    const engine=await createEngine({} as HTMLCanvasElement);
    const scene=createSceneContext(engine,{defaultRenderTask:false});
    const target=createRenderTarget({lbl:"scene",format:engine.format,dFormat:"depth24plus",samples:1,size:engine});
    const task=createRenderTask({name:"scene",rt:target,clr:true},engine,scene);
    addTask(scene,task);
    const grab=enableRenderTaskTransmission(task,engine${options});
    const material=createShaderMaterial({vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
        fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return textureSample(picture,pictureSampler,vec2f(0.5));}",
        attributes:["position"],samplers:["picture"],transmissive:true,needAlphaBlending:true});
    const pixels=createTexture2DFromPixels(engine,new Uint8Array([0,0,0,255]),1,1);
    ${body}
}
main();`;

test("render-task transmission stores the pin's raw-mode options on the task", () => {
    const compiled = compileSource(
        program(
            `,{linear:false,copyCount:0,generateMipmaps:true,mipLevelCount:3,grabDepth:true}`,
        ),
    );
    // The backends' pass break and its grab modules compile only when reached.
    assert.ok(
        compiled.manifest.features.includes(
            "frame-graph:render-task-transmission",
        ),
    );
    const cpp = compiled.cpp;
    assert.match(
        cpp,
        /bbl::enable_render_task_transmission\(v_engine, v_task, bbl::RenderTaskTransmission\{\d+u, 0\.0, true, 3\.0, true\}\)/,
    );
    assert.match(
        cpp,
        /bbl::mark_shader_material_transmissive\(v_engine, bbl::create_shader_material\(/,
    );
    assert.match(
        compileSource(program(`,{linear:false}`)).cpp,
        /bbl::RenderTaskTransmission\{\d+u, std::nullopt, std::nullopt, std::nullopt, std::nullopt\}/,
    );
});

test("render-task transmission refuses the linear retarget", () => {
    for (const options of ["", `,{grabDepth:true}`, `,{linear:true}`])
        assert.throws(
            () => compileSource(program(options)),
            /requires linear: false/,
        );
});

test("a raw grab accepts a geometry depth attachment independent of the colour target", () => {
    const result = compileSource(`
        import { addTask, createEngine, createRenderTarget, createRenderTask, createSceneContext,
            createGeometryRendererTask, enableRenderTaskTransmission, GeometryTextureType } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine, {defaultRenderTask: false});
        const g = createGeometryRendererTask({samples: 1, textureDescriptions: [
            {type: GeometryTextureType.VIEW_NORMAL}]}, engine, scene);
        const rt = createRenderTarget({format: engine.format, samples: 1, size: engine});
        const task = createRenderTask({rt, depth: g.geometryDepthTexture}, engine, scene);
        addTask(scene, g);
        addTask(scene, task);
        enableRenderTaskTransmission(task, engine, {linear: false, grabDepth: true});
    `);
    assert.match(result.cpp, /bbl::geometry_task_depth_texture\(v_g\)/);
});

test("grabDepth publishes the pass depth, even with a late geometry producer", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native compiler unavailable");
    const sceneCore = new SceneLowerer(new LoweringContext()).lowerCore({
        sceneTransmission: true,
    }).source;
    runGeneratedProgram(
        tools,
        "transmission-depth-owner",
        `#include <bblite/runtime.hpp>
#include "pal_gpu_target_lifetimes.hpp"
#include <cassert>
namespace bbl {
${cppFunction(sceneCore, "void require_scene_engine(")}
${cppFunction(sceneCore, "void enable_scene_transmission(")}
}
using namespace bbl;
struct Target { unsigned width = 640, height = 360; const char* depth = nullptr; };
struct Geometry { const char* view = nullptr; };
struct Targets {
    unsigned frame_graph_width = 640, frame_graph_height = 360;
    std::vector<Target> render_targets{{}, {}};
    std::vector<Geometry> geometry_tasks{{"geometry"}};
};
unsigned task_sample_count(const Targets&, unsigned samples) { return samples; }
unsigned target_sample_count(const Targets&, const RenderTargetRecord& rt) { return rt.samples; }
int main() {
    Engine engine;
    Targets gpu;
    engine.frame_tasks.resize(2);
    auto& producer = engine.frame_tasks[0];
    producer.kind = FrameTaskKind::geometry;
    auto& task = engine.frame_tasks[1];
    engine.render_targets.resize(2);
    auto& color = engine.render_targets[0];
    task.render.target = RenderTargetHandle{0};
    const auto source = [&](bool grab) {
        return pal::task_grab_depth_source<const char*>(engine, task, gpu, gpu.render_targets[0],
                                                        &Target::depth, &Geometry::view, grab);
    };
    task.render.depth.source = RenderTextureSource::geometry_depth;
    task.render.depth.task = TaskHandle{0};
    for (bool unrelated_depth : {false, true}) {
        task.record_state = FrameTaskRecordState::queued;
        producer.record_state = FrameTaskRecordState::queued;
        color.has_depth = unrelated_depth;
        gpu.render_targets[0].depth = unrelated_depth ? "colour owner's depth" : nullptr;
        const auto grab = enable_render_task_transmission(engine, TaskHandle{1}, {128u, {}, {}, {}, true});
        assert(!color.depth_binding);
        bool sampled = false, attached = false;
        pal::visit_task_textures(task, [&](const auto& ref) {sampled = ref.task == TaskHandle{0};},
                                       [&](const auto& ref) {attached = ref.task == TaskHandle{0};});
        assert(sampled && attached);
        task.record_state = FrameTaskRecordState::recorded;
        sync_transmission_geometry_depth(engine, task);
        assert(!transmission_grab_depth_texture(engine, grab));
        producer.record_state = FrameTaskRecordState::recorded;
        assert(!transmission_grab_depth_texture(engine, grab));
        assert(!source(false));
        assert(source(true) == gpu.geometry_tasks[0].view);
        const auto texture = transmission_grab_depth_texture(engine, grab);
        assert(texture && std::get<FileTexture>(*texture).width == static_cast<unsigned>(engine.options.width));
    }
    task.record_state = FrameTaskRecordState::queued;
    task.render.depth = {};
    color.has_depth = false;
    gpu.render_targets[0].depth = nullptr;
    const auto grab = enable_render_task_transmission(engine, TaskHandle{1}, {128u, {}, {}, {}, true});
    task.record_state = FrameTaskRecordState::recorded;
    assert(!transmission_grab_depth_texture(engine, grab) && !source(true));
    task.record_state = FrameTaskRecordState::queued;
    color.has_depth = true;
    gpu.render_targets[0].depth = "own";
    enable_render_task_transmission(engine, TaskHandle{1}, {128u, {}, {}, {}, true});
    task.record_state = FrameTaskRecordState::recorded;
    assert(color.depth_binding && transmission_grab_depth_texture(engine, grab));
    assert(source(true) == gpu.render_targets[0].depth);

    // The automatic overlay task borrows colour but owns a distinct depth-only RT.
    Scene scene;
    scene.engine = &engine;
    scene.tasks.push_back(TaskHandle{1});
    task.render.shared_target = true;
    task.render.depth.target = RenderTargetHandle{1};
    task.transmission.reset();
    bool refused = false;
    try { enable_scene_transmission(scene); } catch (const std::runtime_error&) { refused = true; }
    assert(refused && !scene.transmission_enabled);
    auto& overlay_depth = engine.render_targets[1];
    overlay_depth.has_depth = true;
    overlay_depth.width = 27;
    gpu.render_targets[1].depth = "overlay";
    color.depth_binding = false;
    task.record_state = FrameTaskRecordState::queued;
    enable_render_task_transmission(engine, TaskHandle{1}, {128u, {}, {}, {}, true});
    task.record_state = FrameTaskRecordState::recorded;
    const auto overlay_grab = transmission_grab_depth_texture(engine, grab);
    assert(overlay_grab && std::get<FileTexture>(*overlay_grab).width == 27);
    assert(overlay_depth.depth_binding && !overlay_depth.sampled_depth && !color.depth_binding);
    assert(source(true) == gpu.render_targets[1].depth);
    enable_scene_transmission(scene);
    assert(scene.transmission_enabled);
    --gpu.render_targets[1].width;
    refused = false;
    try { (void)source(true); } catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}
`,
        { flags: ["/I", "native/src", "/DBBLITE_RENDER_TASK_TRANSMISSION=1"] },
    );
});

test("grab textures are nullable Texture2D values beside ordinary textures", () => {
    const fallback = compileSource(
        program(
            `,{linear:false}`,
            `const solid=createSolidTexture2D(engine,1,0,0,1);onBeforeRender(scene,()=>{setShaderTexture(material,"picture",grab.texture ?? solid);});`,
        ),
    ).cpp;
    assert.match(
        fallback,
        /auto (v_bblite_nullish_\d+) = bbl::transmission_grab_texture\(v_engine, v_grab\);\s+\[\[maybe_unused\]\] auto (v_bblite_shader_texture_\d+) = \(\1.has_value\(\) \? \(\*\1\) : bbl::StoredTexture\{bbl::solid_texture_file\(v_solid\)\}\);\s+bbl::set_shader_pixels_texture\(v_engine, v_material, 0u, \2\);/,
    );
    const local = compileSource(
        program(
            `,{linear:false,grabDepth:true}`,
            `let bound:Texture2D|null=null;onBeforeRender(scene,()=>{if(grab.depthTexture!==bound){bound=grab.depthTexture;setShaderTexture(material,"picture",bound ?? pixels);}});`,
        ),
    ).cpp;
    // The local holds the same nullable stored texture a grab read returns.
    assert.match(
        local,
        /bbl::js::Nullable<bbl::StoredTexture> v_bound = bbl::js::Nullable<bbl::StoredTexture>\{std::nullopt\}/,
    );
    assert.match(
        local,
        /v_bound = bbl::transmission_grab_depth_texture\(v_engine, v_grab\);/,
    );
    assert.match(
        local,
        /auto (v_bblite_nullish_\d+) = bbl::js::snapshot_value\(v_bound\);\s+\[\[maybe_unused\]\] auto (v_bblite_shader_texture_\d+) = \(\1.has_value\(\) \? \(\*\1\) : bbl::StoredTexture\{v_pixels\}\);\s+bbl::set_shader_pixels_texture\(v_engine, v_material, 0u, \2\);/,
    );
});
