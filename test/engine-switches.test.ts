import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerShaderUniformRangeUpdates } from "../src/lowering/shader-uniforms.js";
import { lowerMaterialTracking } from "../src/lowering/material-tracking.js";
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
