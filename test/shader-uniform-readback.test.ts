import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    cppFunction,
    cppRecord,
} from "./native-fixture.js";
import { compileShaderMaterialFixture as nativeParts } from "./shader-material-fixture.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerMaterialPublication } from "../src/lowering/material-publication.js";
import { lowerDeviceRecovery } from "../src/lowering/device-recovery-lowerer.js";
import { lowerShaderBindingUpdate } from "../src/lowering/shader-binding-update.js";

const options = `{
vertexSource:"struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}",
fragmentSource:"@fragment fn mainFragment()->@location(0) vec4f{return shaderUniforms.uVector;}",
attributes:["position"],uniforms:["worldViewProjection",{name:"uScalar",type:"f32",defaultValue:-1},{name:"uVector",type:"vec4<f32>",defaultValue:new Float32Array([1,2,3,4])},{name:"uMatrix",type:"mat4x4<f32>",defaultValue:new Array(16).fill(0)}]}`;

function program(body: string): string {
    return `import {createEngine,createShaderMaterial,getShaderUniform,setShaderUniform,setShaderFloat,setShaderMatrix,enableShaderMaterialUniformCaching} from "babylon-lite";
async function main(){const engine=await createEngine({});const source=createShaderMaterial(${options});const target=createShaderMaterial(${options});${body}}main();`;
}

test("readback and dynamic selector copying preserve scalar and independent live array slots", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const source = program(`
const scalar=getShaderUniform(source,"uScalar");
const held=getShaderUniform(source,"uVector");
const matrix=getShaderUniform(source,"uMatrix");
if(typeof held==="number"||typeof matrix==="number")throw new Error("array type");
if(held!==getShaderUniform(source,"uVector")||held.buffer===matrix.buffer||held.byteOffset!==0||held.buffer.byteLength!==16)throw new Error("owned slot identity");
held[1]=9;
const bytes=new Float32Array(held.buffer);bytes[2]=8;
let nameEvaluations=0;setShaderUniform(source,\`\${(nameEvaluations++,"uVector")}\`,new Float32Array([1,9,8,4]));if(nameEvaluations!==1)throw new Error("name evaluated twice");
setShaderFloat(source,"uScalar",6);
if(scalar!==-1||getShaderUniform(source,"uScalar")!==6)throw new Error("scalar snapshot");
const selectors:string[]=["uScalar","uVector","uMatrix"];
for(const name of selectors){const value=getShaderUniform(source,name);setShaderUniform(target,name,typeof value==="number"?value:Float32Array.from(value));}
const copied=getShaderUniform(target,"uVector");
if(typeof copied==="number"||copied===held||copied.buffer===held.buffer||copied[1]!==9||copied[2]!==8)throw new Error("selector copy");
setShaderUniform(source,"uVector",new Float32Array([4,3,2,1]));
if(held!==getShaderUniform(source,"uVector")||held[0]!==4||copied[0]!==1)throw new Error("setter retains owner");
const storage=new Float32Array(32).fill(7);setShaderMatrix(source,"uMatrix",storage.subarray(16));
if(matrix!==getShaderUniform(source,"uMatrix")||matrix[15]!==7)throw new Error("matrix alias");
const system=getShaderUniform(source,"worldViewProjection");if(typeof system==="number"||system.length!==16||system[0]!==0)throw new Error("system stored slot");
let missing=false;try{getShaderUniform(source,"missing");}catch(error){missing=error.message.includes("#479");}if(!missing)throw new Error("missing name");
const absentNames:string[]=["missing"];for(const name of absentNames){let missingWrite=false;try{setShaderUniform(source,name,new Float32Array(1));}catch(error){missingWrite=error.message.includes("#477");}if(!missingWrite)throw new Error("missing write name");}
let length=false;for(const name of ["uVector"]){try{setShaderUniform(source,name,new Float32Array(3));}catch(error){length=error.message.includes("#478");}}if(!length)throw new Error("dynamic length");
enableShaderMaterialUniformCaching();`);
    const { compiled, cpp } = nativeParts(source);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    runGeneratedProgram(
        native,
        "shader-uniform-readback/compiled",
        `${cpp}\n#define main generated_main\n${compiled.cpp}\n#undef main\nint main(){assert(generated_main()==0);assert(bbl::shader_uniform_caching_enabled);}`,
        { expectedOutput: "" },
    );
});

test("default and cached render snapshots observe pinned material and slot version gates", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { cpp } = nativeParts(
        program("").replaceAll("new Float32Array([1,2,3,4])", "[1,2,3,4]"),
    );
    runGeneratedProgram(
        native,
        "shader-uniform-readback/version-gates",
        `${cpp}
int main(){for(bool cached:{false,true}){
bbl::shader_uniform_caching_enabled=cached;bbl::Engine engine;const auto handle=bbl::create_shader_material(engine,0);auto& material=bbl::shader_material(engine,handle);
assert(material.shader_alpha_cutoff(material)==0.4);
auto held=std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,handle,"uVector"));
assert(bbl::shader_uniform_render_values(material)[1]==1);held.store(0,8);
assert(std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,handle,"uVector")).load(0)==8);
assert(bbl::shader_uniform_render_values(material)[1]==1);
bbl::set_shader_uniform(engine,handle,"uScalar",2.0);
assert(bbl::shader_uniform_render_values(material)[1]==(cached?1:8));
bbl::set_shader_uniform(engine,handle,"uVector",bbl::js::F32Array(std::vector<float>{8,2,3,4}));
assert(bbl::shader_uniform_render_values(material)[1]==(cached?1:8));
bbl::set_shader_uniform(engine,handle,"uVector",bbl::js::F32Array(std::vector<float>{9,2,3,4}));
assert(bbl::shader_uniform_render_values(material)[1]==9);
assert(held.load(0)==9);
if(cached){
auto& slot=material.shader_uniforms->slots[2];slot.version=2147483648.0;material.shader_uniforms->version++;
assert(bbl::shader_uniform_render_values(material)[1]==9);
assert(material.shader_uniform_upload->slot_versions[2]==std::numeric_limits<std::int32_t>::min());
held.store(0,11);bbl::set_shader_uniform(engine,handle,"uScalar",3.0);
assert(bbl::shader_uniform_render_values(material)[1]==11);
slot.version=-1;material.shader_uniform_upload.reset();
assert(bbl::shader_uniform_render_values(material)[1]==0);
}
}}
`,
        { expectedOutput: "", flags: ["/DBBLITE_GPU_INSTANCING=0"] },
    );
});

test("bound shader updates publish hidden material writes before draw visibility checks", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { cpp } = nativeParts(
        program("").replaceAll("new Float32Array([1,2,3,4])", "[1,2,3,4]"),
    );
    const binding = lowerShaderBindingUpdate(new LoweringContext());
    const shader = readFileSync(
        resolve("native/src/pal_gpu_shader_passes.hpp"),
        "utf8",
    );
    runGeneratedProgram(
        native,
        "shader-uniform-readback/hidden-binding",
        `${cpp}
namespace bbl::upstream {
${binding}
inline constexpr bool public_camera_matrix_caches=false;
enum class RenderBucket { opaque,alpha_blend };
enum class RenderMaterialKind { shader };
struct RenderItem { MeshHandle mesh; MaterialHandle material; ShaderPacketSystemOwner shader_packet; RenderBucket bucket=RenderBucket::opaque; RenderMaterialKind material_kind=RenderMaterialKind::shader; };
struct RenderDrawCommand { RenderItem item; };
struct RenderDrawList { std::vector<RenderDrawCommand> commands,binding_updates; };
bool render_item_material_draws(const RenderItem&,const Engine&){return true;}
}
namespace bbl::pal {
${cppRecord(shader, "struct ShaderPassMatrices")}
std::array<float,16> mesh_block_world(const Scene&,const Engine&,const MeshRecord&);
ShaderPassMatrices shader_packet_system_matrices(const ShaderPacketSystemOwner&,const Scene&,const Engine&,const MeshRecord&,const MaterialRecord&,const ShaderPassMatrices&);
template<class Rows,class BindBuffers>
${cppFunction(shader, "void update_material_bindings(")}
}
int main(){for(bool cached:{false,true})for(bool transparent:{false,true}){
bbl::shader_uniform_caching_enabled=cached;bbl::Engine engine;const auto handle=bbl::create_shader_material(engine,0);auto& material=bbl::shader_material(engine,handle);
auto held=std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,handle,"uVector"));material.shader_uniform_snapshot(material);
bbl::set_shader_uniform(engine,handle,"uVector",bbl::js::F32Array(std::vector<float>{8,2,3,4}));
bbl::Scene scene;scene.engine=&engine;engine.meshes.emplace_back();engine.meshes[0].visible=false;
bbl::upstream::RenderDrawList bindings;bindings.binding_updates.push_back({{bbl::MeshHandle{0},handle,{},transparent?bbl::upstream::RenderBucket::alpha_blend:bbl::upstream::RenderBucket::opaque}});assert(bindings.commands.empty());int rows=0;
auto update=[&]{bbl::pal::update_material_bindings(scene,engine,bindings,{},rows,[]{});};
update();assert(!engine.meshes[0].visible&&material.shader_uniform_values[1]==8);
held.store(0,9);engine.meshes[0].visible=true;update();assert(material.shader_uniform_values[1]==8);
std::string order;for(bool disposed:{false,true}){order.clear();bbl::upstream::update_shader_binding(transparent,disposed,false,[&]{order+='C';},[&]{order+='S';});assert(order==(transparent?"":"C"));}
}}
`,
        { expectedOutput: "", flags: ["/DBBLITE_GPU_INSTANCING=0"] },
    );
});

test("shader registration latches live values, capture is read-only, and recovery invalidates upload owners", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { cpp } = nativeParts(
        program("").replaceAll("new Float32Array([1,2,3,4])", "[1,2,3,4]"),
    );
    const context = new LoweringContext();
    const scene = new SceneLowerer(context).lowerCore().source;
    const publication = lowerMaterialPublication(context);
    const recovery = lowerDeviceRecovery(context).source;
    const capture = readFileSync(
        resolve("native/src/pal_render_capture.hpp"),
        "utf8",
    );
    assert.doesNotMatch(
        cppFunction(capture, "void write_material("),
        /shader_uniform_snapshot/,
    );
    runGeneratedProgram(
        native,
        "shader-uniform-readback/lifecycle",
        `${cpp}
namespace bbl {
struct ShaderPacketSystemState {};
${cppFunction(scene, "void require_scene_engine(")}
${cppFunction(scene, "std::uint32_t material_family_bit(")}
${cppFunction(scene, "std::uint32_t scene_material_families(")}
${cppFunction(scene, "void drain_scene_deferred_builders(")}
${cppFunction(scene, "void register_scene(")}
bool source_material_draw_matches(MaterialHandle,MaterialHandle,bool){return true;}
bool source_standard_material_draw_matches(MaterialHandle,MaterialHandle,bool){return true;}
bool source_shader_material_draw_matches(MaterialHandle,MaterialHandle,bool){return true;}
${cppFunction(publication, "SourceMaterialOutput capture_material_output(")}
${cppFunction(recovery, "static Engine::DeviceRecoveryState& recovery_state(")}
void device_lost(Engine&,Engine::DeviceRecoveryState& state){state.recovering=true;}
void assert_every_active_context_kind_is_recoverable(const Engine&,const std::vector<std::shared_ptr<DeviceRecoveryRegistration>>&){}
void recover_retained_meshes(Engine&){}
${cppFunction(recovery, "static void rebuild_cpu_storage_buffers(")}
${cppFunction(recovery, "void begin_device_recovery(")}
}
int main(){for(bool cached:{false,true}){
bbl::shader_uniform_caching_enabled=cached;bbl::Engine engine;const auto handle=bbl::create_shader_material(engine,0);const auto late=bbl::create_shader_material(engine,0);const auto taskOnly=bbl::create_shader_material(engine,0);
auto& material=bbl::shader_material(engine,handle);auto held=std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,handle,"uVector"));
material.shader_uniforms->slots.push_back({"alphaCutoff","f32",bbl::invalid_handle,bbl::normalize_shader_uniform_value("alphaCutoff","f32",1,bbl::default_shader_uniform_values("alphaCutoff",1)),0});
assert(material.shader_alpha_cutoff(material)==static_cast<double>(0.4f));
material.shader_uniforms->slots.back().value.store(0,0.7f);
assert(material.shader_alpha_cutoff(material)==static_cast<double>(0.7f));
held.store(0,8);assert(!material.shader_uniform_upload);
bbl::Scene scene;scene.engine=&engine;engine.meshes.emplace_back();engine.meshes[0].material=handle;scene.meshes.push_back(bbl::MeshHandle{0});
engine.frame_tasks.emplace_back();engine.frame_tasks[0].source_scene=scene.state;engine.frame_tasks[0].render_meshes.push_back(bbl::RenderTaskMesh{bbl::MeshHandle{0},taskOnly});scene.tasks.push_back(bbl::TaskHandle{0});
auto taskValues=std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,taskOnly,"uVector"));taskValues.store(0,12);
bbl::register_scene(scene);assert(material.shader_uniform_upload);assert(material.shader_uniform_values[1]==8);
assert(engine.frame_tasks[0].record_state==bbl::FrameTaskRecordState::recorded);
assert(engine.frame_tasks[0].shader_packet_scene_version == static_cast<double>(scene.state->renderable_version));
assert(engine.frame_tasks[0].render_meshes[0].shader_packet);
taskValues.store(0,13);assert(bbl::shader_uniform_render_values(bbl::shader_material(engine,taskOnly))[1]==12);
held.store(0,9);bbl::register_scene(scene);assert(bbl::shader_uniform_render_values(material)[1]==8);
assert(!bbl::shader_material(engine,late).shader_uniform_upload);
auto lateValues=std::get<bbl::js::F32Array>(bbl::get_shader_uniform(engine,late,"uVector"));lateValues.store(0,5);
engine.meshes[0].material=late;auto output=bbl::capture_material_output(scene,bbl::MeshHandle{0});scene.state->source_material_publication=true;scene.state->material_outputs.push_back(output);
assert(bbl::shader_material(engine,late).shader_uniform_values[1]==5);
lateValues.store(0,6);assert(bbl::shader_uniform_render_values(bbl::shader_material(engine,late))[1]==5);
output->shader_packet=std::make_shared<std::shared_ptr<bbl::ShaderPacketSystemState>>(std::make_shared<bbl::ShaderPacketSystemState>());
auto rowOwner=output->shader_packet;
auto& taskEntry=engine.frame_tasks[0].render_meshes[0];taskEntry.shader_packet=std::make_shared<std::shared_ptr<bbl::ShaderPacketSystemState>>(std::make_shared<bbl::ShaderPacketSystemState>());
auto taskRowOwner=taskEntry.shader_packet;
bbl::shader_material(engine,late).shader_packet_initialize=[](const bbl::Scene&,const bbl::MaterialRecord& value){assert(value.shader_uniform_upload);assert(value.shader_uniform_values[1]==6);};
bbl::begin_device_recovery(engine);assert(!material.shader_uniform_upload);assert(bbl::shader_material(engine,late).shader_uniform_upload);
assert(rowOwner==output->shader_packet&&!(*rowOwner));assert(taskRowOwner==taskEntry.shader_packet&&!(*taskRowOwner));
assert(bbl::shader_material(engine,taskOnly).shader_uniform_values[1]==13);
assert(bbl::shader_uniform_render_values(material)[1]==9);assert(bbl::shader_uniform_render_values(bbl::shader_material(engine,late))[1]==6);
}}
`,
        { expectedOutput: "", flags: ["/DBBLITE_GPU_INSTANCING=0"] },
    );
});
