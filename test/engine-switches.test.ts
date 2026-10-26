import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerShaderUniformRangeUpdates } from "../src/lowering/shader-uniforms.js";
import { lowerMaterialTracking } from "../src/lowering/material-tracking.js";
import { lowerSurfaceResize } from "../src/lowering/surface-resize.js";
import { lowerGpuFrameTimer } from "../src/lowering/gpu-frame-timer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { compileShaderMaterialFixture } from "./shader-material-fixture.js";

const shaderOptions = `{
vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return shaderUniforms.uVector;}",
attributes:["position"],uniforms:["worldViewProjection",{name:"uScalar",type:"f32",defaultValue:-1},{name:"uVector",type:"vec4<f32>",defaultValue:[1,2,3,4]}]}`;

test("strict switches lower without deferred boundaries", () => {
    const compiled = compileSource(`
        import {createEngine,createSceneContext,createShaderMaterial,enableShaderUniformRangeUpdates,enableAsyncShaderPipelineCompilation} from "@babylonjs/lite";
        async function main(){
            const engines=[await createEngine({})];let reads=0;
            enableAsyncShaderPipelineCompilation(engines[reads++]!);
            const scene=createSceneContext(engines[0]!);
            const material=createShaderMaterial(${shaderOptions});
            enableShaderUniformRangeUpdates(scene,material);
            if(reads!==1)throw new Error("engine argument");
        }
        main();`);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    assert(
        compiled.manifest.features.includes("material:shader-uniform-ranges"),
    );
    assert.match(
        compiled.cpp,
        /bbl::enable_shader_uniform_range_updates\(\w+, v_scene, v_material\)/,
    );
    assert.doesNotMatch(compiled.cpp, /async_shader_pipeline/);
});

test("range updates mark direct slot writes and upload them before render", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { cpp } = compileShaderMaterialFixture(
        `import {createEngine,createShaderMaterial} from "babylon-lite";
        async function main(){const engine=await createEngine({});createShaderMaterial(${shaderOptions});}main();`,
    );
    runGeneratedProgram(
        native,
        "engine-switches/uniform-ranges",
        `#include <bit>
#include <iterator>
#include <utility>
${cpp}
namespace bbl {
${lowerShaderUniformRangeUpdates(new LoweringContext())}
}
int main(){
bbl::Engine engine;bbl::Scene scene;scene.engine=&engine;
const auto handle=bbl::create_shader_material(engine,0);auto& material=bbl::shader_material(engine,handle);
auto& state=*material.shader_uniforms;
bbl::enable_shader_uniform_range_updates(engine,scene,handle);
bbl::enable_shader_uniform_range_updates(engine,scene,handle);
assert(scene.before_render.size()==1);
// onBeforeRender unshifts, so the range upload stays after public callbacks.
scene.before_render.insert(scene.before_render.begin(),bbl::js::Callback<void(double)>([](double){}));
bbl::enable_shader_uniform_range_updates(engine,scene,handle);
assert(scene.before_render.size()==2);
const auto update=scene.before_render[1];
auto held=std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,handle,"uVector"));
held.store(0,7);update(16);
assert(state.version==0&&!material.shader_uniform_upload);
assert(bbl::shader_uniform_render_values(material)[1]==7);
held.store(0,8);update(16);
assert(material.shader_uniform_values[1]==8&&state.version==1&&state.ubo_version==1);
assert(material.shader_uniform_upload->version==1&&state.slots[2].version==1);
assert(bbl::shader_uniform_render_values(material)[1]==8);
update(16);assert(state.version==1&&state.slots[2].version==1);
bbl::set_shader_uniform(engine,handle,"uVector",bbl::js::F32Array(std::vector<float>{9,2,3,4}));
const double set=state.version;held.store(1,5);update(16);
assert(state.version==set&&material.shader_uniform_upload->version==set);
assert(material.shader_uniform_values[1]==9&&material.shader_uniform_values[2]==5);
bbl::Scene other;other.engine=&engine;bbl::enable_shader_uniform_range_updates(engine,other,handle);
assert(other.before_render.size()==1&&!(other.before_render[0]==update));
assert(state.range_updates->scenes.size()==2);
}`,
        { expectedOutput: "", flags: ["/DBBLITE_GPU_INSTANCING=0"] },
    );
});

test("material tracking installs after its module hop and re-reads tracked colors", (t) => {
    const compiled = compileSource(`
        import {createEngine,createStandardMaterial,createPbrMaterial,enableMaterialTracking,type PbrMaterial} from "@babylonjs/lite";
        const entries:{mat:PbrMaterial;base:number}[]=[];
        async function main(){
            await createEngine({});
            const from=entries.length;
            entries.push({mat:createPbrMaterial({}),base:1});
            void Promise.all(entries.slice(from).map((entry)=>enableMaterialTracking(entry.mat as never)));
            await enableMaterialTracking(createStandardMaterial());
        }
        main();`);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    assert.equal(
        compiled.cpp.match(/bblscene::v_bblite_enable_material_tracking_\d+\(/g)
            ?.length,
        2,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const lowered = lowerMaterialTracking(new LoweringContext(), "track");
    runGeneratedProgram(
        native,
        "engine-switches/material-tracking",
        `#include <bblite/runtime.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/js_promise.hpp>
#include <cassert>
namespace bblscene {
${lowered.lines.join("\n")}
}
int main(){
const bbl::js::RealmScope scope;bbl::pal::EventLoop loop;bbl::Engine engine;
bbl::MaterialRecord standard;standard.standard_material=true;standard.diffuse_color={0.5f,0.25f,1.0f};
standard.source_diffuse_color=std::make_shared<std::vector<double>>(std::vector<double>{0.5,0.25,1});
engine.materials.push_back(standard);
bbl::MaterialRecord view;view.source_material=bbl::MaterialHandle{0};engine.materials.push_back(view);
engine.materials.push_back(bbl::MaterialRecord{});
const auto before=engine.materials[0].source_diffuse_color;std::string order;
loop.run([&]{
    const auto tracked=bblscene::track(engine,bbl::MaterialHandle{1});
    bblscene::track(engine,bbl::MaterialHandle{2});
    assert(engine.tracked_materials.empty()&&engine.materials[0].source_diffuse_color==before);
    bbl::js::Promise<bbl::js::PromiseVoid>::resolved({}).then([&](const bbl::js::PromiseVoid&){
        assert(engine.tracked_materials.size()==2);order+="a";});
    tracked.then([&](const bbl::js::PromiseVoid&){order+="t";});
    bbl::js::Promise<bbl::js::PromiseVoid>::resolved({}).then([&](const bbl::js::PromiseVoid&){order+="b";})
        .then([&](const bbl::js::PromiseVoid&){order+="c";});
    loop.post([&]{loop.close();});
});
assert(order=="abtc");
assert(engine.tracked_materials[0]==bbl::MaterialHandle{0}&&engine.tracked_materials[1]==bbl::MaterialHandle{2});
auto& record=engine.materials[0];
assert(record.source_diffuse_color!=before&&*record.source_diffuse_color==*before);
(*before)[0]=0.125;bbl::project_tracked_material_colors(engine);assert(record.diffuse_color.r==0.5f&&record.ubo_version==0);
(*record.source_diffuse_color)[0]=0.75;bbl::project_tracked_material_colors(engine);
assert(record.diffuse_color.r==0.75f&&record.ubo_version==1);
bbl::project_tracked_material_colors(engine);assert(record.ubo_version==1);
}`,
        { expectedOutput: "", flags: ["/DBBLITE_WORKERS=1"] },
    );
});

test("surface pixel ratio writes evaluate their owner first and install the pinned resize", (t) => {
    const compiled = compileSource(`
        import {createEngine,resizeEngine} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        let effects=0;
        function owner(){effects++; return engine;}
        if(owner().maxDevicePixelRatio!==Infinity) throw new Error("default cap");
        owner().maxDevicePixelRatio=++effects*0.25;
        resizeEngine(engine);
        if(owner().maxDevicePixelRatio!==0.75 || effects!==4) throw new Error("surface cap");`);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    assert(compiled.manifest.features.includes("platform:window"));
    assert.match(
        compiled.cpp,
        /auto& (v_bblite_surface_owner_\d+) = [^;]+;\s*bbl::set_surface_max_device_pixel_ratio\(\1, \(\(\+\+v_fn0_effects\) \* 0\.25\), &bblscene::v_bblite_resize_surface_\d+\);[\s\S]*?bbl::resize_engine\(/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const lowered = lowerSurfaceResize(new LoweringContext(), "resize");
    runGeneratedProgram(
        native,
        "engine-switches/surface-resize",
        `#include <bblite/pal_async_engine.hpp>
#include <bblite/pal_worker.hpp>
#include <cassert>
#include <cmath>
namespace { double ratio=1.5; double window_ratio(){return ratio;} }
namespace bblscene {
${lowered.lines.join("\n")}
}
struct Device final:bbl::pal::OffscreenDevice{};
int main(){
const bbl::js::RealmScope scope;bbl::pal::EventLoop loop;bbl::pal::WorkerRealm realm(loop);bbl::Engine engine;auto surface=std::make_shared<bbl::pal::OffscreenSurface>(1920,1080);
engine.offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(surface,std::make_shared<Device>());
engine.canvas_client_width=1280;engine.canvas_client_height=720;
const auto extent=[&](std::uint32_t width,std::uint32_t height){return surface->extent().width==width&&surface->extent().height==height;};
assert(std::isinf(bbl::surface_max_device_pixel_ratio(engine)));
bbl::set_surface_max_device_pixel_ratio(engine,0.5,&bblscene::resize);bbl::resize_engine(engine);
assert(extent(1920,1080)&&bbl::surface_max_device_pixel_ratio(engine)==0.5);
engine.dom_canvas=true;
// A realm with no Window host has no devicePixelRatio: the pin's \`|| 1\`.
bbl::set_surface_max_device_pixel_ratio(engine,2,&bblscene::resize);bbl::resize_engine(engine);assert(extent(1280,720));
realm.provide_host_accessor(bbl::pal::HostAccessor::device_pixel_ratio,window_ratio);
bbl::set_surface_max_device_pixel_ratio(engine,0.5,&bblscene::resize);bbl::resize_engine(engine);
assert(extent(640,360)&&engine.options.width==640&&engine.options.height==360);
bbl::set_surface_max_device_pixel_ratio(engine,2,&bblscene::resize);bbl::resize_engine(engine);assert(extent(1920,1080));
engine.canvas_client_width=1001;engine.canvas_client_height=601;
bbl::set_surface_max_device_pixel_ratio(engine,0.75,&bblscene::resize);bbl::resize_engine(engine);assert(extent(750,450));
ratio=0;bbl::set_surface_max_device_pixel_ratio(engine,1,&bblscene::resize);bbl::resize_engine(engine);assert(extent(1001,601));
for(const double cap:{0.0,-1.0,std::nan("")}){bbl::set_surface_max_device_pixel_ratio(engine,cap,&bblscene::resize);bbl::resize_engine(engine);assert(extent(1001,601));}
engine.canvas_client_width=0;bbl::set_surface_max_device_pixel_ratio(engine,0.5,&bblscene::resize);bbl::resize_engine(engine);assert(extent(1001,601));
// An additional canvas uses the same pinned sizing, with its independent default DPR cap.
auto second=std::make_shared<bbl::pal::OffscreenSurface>(300,150);
bbl::pal::OffscreenRun auxiliary(second,std::make_shared<Device>());
ratio=1.5;bblscene::resize_auxiliary(auxiliary,81.25,60.75);
assert(auxiliary.extent().width==121&&auxiliary.extent().height==91);
assert(extent(1001,601));
}`,
        {
            expectedOutput: "",
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"],
        },
    );
});

test("frame GPU timing installs after its module hop and smooths settled readbacks", (t) => {
    const compiled = compileSource(`
        import {createEngine,isGpuTimingSupported} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const setGpuTiming=async(enabled:boolean):Promise<void>=>{
            const {setGpuTimingEnabled}=await import("@babylonjs/lite");
            setGpuTimingEnabled(engine,enabled);
        };
        await setGpuTiming(isGpuTimingSupported(engine));
        if(engine.gpuFrameTimeMs!==0) throw new Error("first sample");`);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    assert(compiled.manifest.features.includes("engine:gpu-task-timing"));
    assert.match(
        compiled.cpp,
        /bblscene::v_bblite_set_gpu_timing_enabled_\d+\(bbl::pal::gpu_task_timing_state\(/,
    );
    assert.match(compiled.cpp, /->gpu_frame_time_ms/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const lowered = lowerGpuFrameTimer(new LoweringContext(), "timing");
    runGeneratedProgram(
        native,
        "engine-switches/gpu-frame-timing",
        `#include <bblite/pal_gpu_task_timing.hpp>
#include <bblite/pal_event_loop.hpp>
#include <cassert>
#include <cmath>
using namespace bbl::pal;
namespace bblscene {
${lowered.lines.join("\n")}
}
struct Queries final:GpuTimestampQuerySet{};
struct Readback final:GpuTimestampReadback{
    std::optional<std::vector<std::uint64_t>> value;bool failed=false;
    std::optional<std::vector<std::uint64_t>> poll() override{if(failed)throw std::runtime_error("lost");return value;}
};
struct Device final:OffscreenDevice{
    std::vector<std::shared_ptr<Readback>> issued;std::size_t query_sets=0;
    bool supports_gpu_timestamps() const override{return true;}
    std::shared_ptr<GpuTimestampQuerySet> create_gpu_timestamp_query_set(std::uint32_t count) override{assert(count==2);++query_sets;return std::make_shared<Queries>();}
    std::shared_ptr<GpuTimestampReadback> resolve_gpu_timestamps(const std::shared_ptr<GpuTimestampQuerySet>&,std::uint32_t count) override{assert(count==2);return issued.emplace_back(std::make_shared<Readback>());}
};
int main(){
const bbl::js::RealmScope scope;EventLoop loop;bbl::Engine engine;auto device=std::make_shared<Device>();
auto state=std::make_shared<GpuTaskTimingState>();state->device=device;state->supported=true;engine.gpu_task_timing=state;
const auto frame=[&]{const auto begin=gpu_frame_timer_begin(engine);const auto end=gpu_frame_timer_end(engine);
    assert(begin.has_value()==end.has_value());if(begin)assert(begin->index==0&&begin->beginning&&end->index==1&&!end->beginning);
    resolve_gpu_frame_timer(engine);return begin.has_value();};
std::string order;
loop.run([&]{
    bblscene::timing(state,true);assert(state->frame_timer_wanted&&!state->frame_timer_begin);
    bbl::js::Promise<bbl::js::PromiseVoid>::resolved({}).then([&](const bbl::js::PromiseVoid&){assert(state->frame_timer_begin);order+="a";});
    loop.post([&]{loop.close();});
});
assert(order=="a"&&device->query_sets==1);
assert(frame()&&device->issued.size()==1&&state->gpu_frame_time_ms==0);
device->issued[0]->value=std::vector<std::uint64_t>{1000000,3000000};
assert(frame()&&state->gpu_frame_time_ms==2);
device->issued[1]->value=std::vector<std::uint64_t>{0,4000000};
assert(frame()&&std::abs(state->gpu_frame_time_ms-2.4)<1e-12);
device->issued[2]->value=std::vector<std::uint64_t>{5,1};
assert(frame()&&std::abs(state->gpu_frame_time_ms-2.4)<1e-12&&(*state->frame_timer)->in_flight==1);
device->issued[3]->failed=true;
assert(frame()&&std::abs(state->gpu_frame_time_ms-2.4)<1e-12&&(*state->frame_timer)->in_flight==1&&device->issued.size()==5);
for(int i=0;i<3;++i)frame();
assert(device->issued.size()==8&&(*state->frame_timer)->in_flight==4);
frame();assert(device->issued.size()==8);
bblscene::timing(state,false);assert(state->gpu_frame_time_ms==0&&!frame());
loop.run([&]{bblscene::timing(state,true);loop.post([&]{loop.close();});});
assert(device->query_sets==1&&frame());
auto unsupported=std::make_shared<GpuTaskTimingState>();bblscene::timing(unsupported,true);assert(!unsupported->frame_timer_wanted);
}`,
        {
            expectedOutput: "",
            flags: [
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
                "/DBBLITE_GPU_TASK_TIMING=1",
            ],
        },
    );
});
