import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { doubleCpp } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { CameraMutationLowerer } from "../src/lowering/camera-mutation-lowerer.js";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { lowerShaderSystemProducts } from "../src/lowering/shader-system-cache.js";
import { lowerCameraMatrixCaches } from "../src/lowering/camera-matrix-cache.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { SceneUboLowerer } from "../src/lowering/scene-ubo-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const entry = (
    body: string,
    options = "{}",
) => `import {createEngine,createFreeCamera,getViewMatrix,getProjectionMatrix,getViewProjectionMatrix} from "@babylonjs/lite";
const engine=await createEngine({},${options});
const camera=createFreeCamera({x:2.1,y:3.2,z:-4.3},{x:1.4,y:-.5,z:6.7});
${body}`;

test("public camera getters retain owned array aliases and reject unguarded cameras and HPM", () => {
    const compiled = compileSource(
        entry(`const view=getViewMatrix(camera);const projection=getProjectionMatrix(camera,2);const vp=getViewProjectionMatrix(camera,2);
const alias=view as unknown as Float32Array;alias[0]=4;
if(view!==getViewMatrix(camera))throw new Error("identity");`),
    );
    for (const getter of ["view", "projection", "view_projection"])
        assert.match(compiled.cpp, new RegExp(`get_camera_${getter}_matrix`));
    assert.doesNotMatch(compiled.cpp, /F32Array\(matrix\.begin/);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    assert(compiled.manifest.features.includes("camera:world-matrix-version"));
    const animated = new AnimationLowerer(
        new LoweringContext(),
    ).lowerPropertyAnimation({
        cameraVersions: compiled.manifest.features.includes(
            "camera:world-matrix-version",
        ),
    });
    assert.match(
        animated.source,
        /write_camera_scalar\(camera, &CameraRecord::alpha, value\[0\]\)/,
    );
    for (const getter of [
        "getViewMatrix",
        "getProjectionMatrix",
        "getViewProjectionMatrix",
    ]) {
        const args = getter === "getViewMatrix" ? "camera" : "camera,2";
        assert.throws(
            () =>
                compileSource(
                    entry(
                        `${getter}(${args});`,
                        "{useHighPrecisionMatrix:true}",
                    ),
                ),
            /Float32|high-precision/,
        );
        assert.throws(
            () =>
                compileSource(`import {createEngine,createFreeCamera,${getter},type Camera} from "@babylonjs/lite";
function read(camera:Camera){return ${getter}(${args})[0];}
const engine=await createEngine({},{useHighPrecisionMatrix:true});
const camera=createFreeCamera({x:0,y:0,z:-2},{x:0,y:0,z:0});read(camera);`),
            /Float32|high-precision/,
        );
        assert.throws(
            () =>
                compileSource(`import {createEngine,createSceneContext,${getter}} from "@babylonjs/lite";
const engine=await createEngine({});const scene=createSceneContext(engine);const camera=scene.camera;${getter}(${args});`),
            /camera may be absent/,
        );
    }
});

test("tracked camera controls retain independent startup and callback attachments", () => {
    const compile = (attachment: string) =>
        compileSource(`
import {createEngine,createSceneContext,createArcRotateCamera,createBox,setThinInstances,attachControl,getViewProjectionMatrix,onBeforeRender} from "@babylonjs/lite";
async function main():Promise<void> {
    const canvas=document.createElement("canvas");
    const engine=await createEngine(canvas);
    const scene=createSceneContext(engine);
    const camera=createArcRotateCamera(0,1,4,{x:0,y:0,z:0});
    scene.camera=camera;
    const mesh=createBox(engine,1);
    setThinInstances(mesh,new Float32Array(16),1);
    ${attachment}
    getViewProjectionMatrix(camera,1);
}
void main();`);
    const setup = compile("attachControl(camera,canvas,scene);");
    assert(setup.manifest.features.includes("engine:gpu-retirement"));
    assert(setup.manifest.features.includes("camera:world-matrix-version"));
    assert.match(setup.cpp, /bbl::attach_control\(/);
    const runtime = compile(
        "onBeforeRender(scene,()=>{attachControl(camera,canvas,scene);});",
    );
    assert.match(runtime.cpp, /bbl::attach_control\(/);
    const parallel = compile(
        "attachControl(camera,canvas,scene);attachControl(camera,canvas,scene);",
    );
    assert.equal(
        (parallel.cpp.match(/bbl::attach_control\(/g) ?? []).length,
        2,
    );
});

interface PinCamera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    position: { x: number; y: number; z: number };
    worldMatrixVersion: number;
}

test("camera caches match pinned identities, mutation gates, rounding, aspect equality and orthographic invalidation", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const { createFreeCamera } = await importPinnedModule<{
        createFreeCamera(
            this: void,
            position: object,
            target: object,
        ): PinCamera;
    }>("camera/free-camera.js");
    const { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix } =
        await importPinnedModule<{
            getViewMatrix(this: void, camera: PinCamera): Float32Array;
            getProjectionMatrix(
                this: void,
                camera: PinCamera,
                aspect: number,
            ): Float32Array;
            getViewProjectionMatrix(
                this: void,
                camera: PinCamera,
                aspect: number,
            ): Float32Array;
        }>("camera/camera.js");
    const { enableOrthographicCamera } = await importPinnedModule<{
        enableOrthographicCamera(
            this: void,
            camera: PinCamera,
            bounds: object,
        ): unknown;
    }>("camera/orthographic.js");
    const camera = createFreeCamera(
        { x: 2.1, y: 3.2, z: -4.3 },
        { x: 1.4, y: -0.5, z: 6.7 },
    );
    const view = getViewMatrix(camera),
        projection = getProjectionMatrix(camera, 2),
        vp = getViewProjectionMatrix(camera, 2);
    const checks: string[] = [];
    const compare = (expression: string, expected: Float32Array) => {
        const words = new Uint32Array(
            expected.buffer,
            expected.byteOffset,
            expected.length,
        );
        checks.push(
            `check(${expression},std::array<std::uint32_t,16>{${Array.from(words, (word) => `${word}u`).join(",")}});`,
        );
    };
    checks.push(
        `auto view=get_camera_view_matrix(camera());auto projection=get_camera_projection_matrix(camera(),2);auto vp=get_camera_view_projection_matrix(camera(),2);`,
    );
    compare("view", view);
    compare("projection", projection);
    compare("vp", vp);
    view[0] = 7;
    projection[1] = 9;
    projection[0] = 11;
    vp[2] = 13;
    checks.push("view[0]=7;projection[1]=9;projection[0]=11;vp[2]=13;");
    compare("get_camera_view_matrix(camera())", getViewMatrix(camera));
    compare(
        "get_camera_projection_matrix(camera(),2)",
        getProjectionMatrix(camera, 2),
    );
    compare(
        "get_camera_view_projection_matrix(camera(),2)",
        getViewProjectionMatrix(camera, 2),
    );
    checks.push(
        "assert(view.identity()==get_camera_view_matrix(camera()).identity());assert(projection.identity()==get_camera_projection_matrix(camera(),2).identity());assert(vp.identity()==get_camera_view_projection_matrix(camera(),2).identity());assert(view.identity()!=projection.identity()&&projection.identity()!=vp.identity());",
    );
    camera.fov = 1.1;
    checks.push("camera().fov=1.1;");
    compare(
        "get_camera_projection_matrix(camera(),2)",
        getProjectionMatrix(camera, 2),
    );
    compare(
        "get_camera_view_projection_matrix(camera(),2)",
        getViewProjectionMatrix(camera, 2),
    );
    checks.push("assert(view[0]==7&&projection[1]==9);");
    camera.position.x += 2.5;
    checks.push(
        `bbl::upstream::write_camera_vector_component(camera(),&bbl::CameraRecord::position,&bbl::Vec3d::x,camera().position.x+2.5);assert(camera().world_matrix_version==${camera.worldMatrixVersion});`,
    );
    compare("get_camera_view_matrix(camera())", getViewMatrix(camera));
    compare(
        "get_camera_view_projection_matrix(camera(),2)",
        getViewProjectionMatrix(camera, 2),
    );
    checks.push(
        "assert(view.identity()==get_camera_view_matrix(camera()).identity());",
    );
    for (const aspect of [0, -0, -2, Infinity, NaN, NaN, 2]) {
        projection[0] = 17;
        checks.push("projection[0]=17;");
        compare(
            `get_camera_projection_matrix(camera(),${doubleCpp(aspect)})`,
            getProjectionMatrix(camera, aspect),
        );
    }
    camera.nearPlane = 0.25;
    camera.farPlane = 50;
    checks.push("camera().near_plane=.25;camera().far_plane=50;");
    compare(
        "get_camera_projection_matrix(camera(),2)",
        getProjectionMatrix(camera, 2),
    );
    enableOrthographicCamera(camera, {
        halfHeight: 3,
        left: -4,
        right: 7,
        bottom: -2,
        top: 5,
    });
    checks.push("bbl::enable_orthographic_camera(engine,handle,3,-4,7,-2,5);");
    compare(
        "get_camera_projection_matrix(camera(),2)",
        getProjectionMatrix(camera, 2),
    );
    compare(
        "get_camera_view_projection_matrix(camera(),2)",
        getViewProjectionMatrix(camera, 2),
    );
    checks.push(`auto second=bbl::create_free_camera(engine,{2.1,3.2,-4.3},{1.4,-.5,6.7});assert(get_camera_view_matrix(bbl::handle_at(engine.cameras,second)).identity()!=view.identity());
for(int i=0;i<1000;++i)bbl::create_free_camera(engine,{0,0,-5},{0,0,0});
assert(view.identity()==get_camera_view_matrix(camera()).identity());
view[0]=23;projection[1]=29;
assert(build_camera_view_matrix(camera())[0]==23);assert(build_scene_projection(camera(),2)[1]==29);
assert(build_view_projection(camera(),2)[2]==vp[2]);
for(bool parent:{false,true}){bbl::CameraRecord unsupported;unsupported.has_parent_world=parent;unsupported.kind=parent?bbl::CameraKind::free:bbl::CameraKind::geospatial;bool refused=false;try{get_camera_view_matrix(unsupported);}catch(const std::runtime_error& error){refused=std::string(error.what()).find("unparented")!=std::string::npos;}assert(refused);}
check_pass_cache(engine,handle);
const float retained_view=view[0],retained_projection=projection[1];engine.cameras.clear();assert(view[0]==retained_view&&projection[1]==retained_projection);`);
    const context = new LoweringContext(),
        lowerer = new CameraLowerer(context);
    const setters = new CameraMutationLowerer(context).setters();
    const arc = lowerer.lowerArcRotateFactory();
    const plan = new RendererLowerer(context).lowerRenderPlan({
        publicCameraMatrices: true,
        orthographicCamera: true,
    });
    const render = plan.source;
    assert(
        render.indexOf("list.binding_updates.push_back(command)") <
            render.indexOf("if (!mesh_draws("),
    );
    const pass = readFileSync("native/src/pal_pass_camera.hpp", "utf8");
    const shader = readFileSync("native/src/pal_gpu_shader_passes.hpp", "utf8");
    const shared = readFileSync("native/src/pal_gpu_shared.cpp", "utf8");
    const directory = resolve("artifacts/camera-cache-native");
    mkdirSync(join(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "bblite/upstream/camera_math.hpp"),
        arc.header,
    );
    writeFileSync(
        join(directory, "bblite/upstream/pinned_matrix.hpp"),
        pinnedMatrixHeader(context),
    );
    const code = `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <cassert>
#include <bit>
${arc.source}
${lowerer.lowerFreeFactory().source}
${lowerer.lowerOrthographic().source}
${lowerCameraMatrixCaches(context, true)}
namespace bbl::upstream {
${cppFunction(setters, "void dirty_camera_transform(")}
${cppFunction(setters, "void write_camera_vector_component(")}
${cppFunction(render, "std::array<float, 16> build_camera_view_matrix(")}
${cppFunction(render, "std::array<float, 16> build_scene_projection(")}
${cppFunction(render, "std::array<float, 16> build_view_projection(")}
${cppFunction(render, "double effective_aspect_ratio(")}
${cppFunction(render, "void read_shader_packet_camera_matrices(")}
}
${new SceneUboLowerer(context).cacheHeader()}
namespace bbl::upstream {
inline constexpr bool public_camera_matrix_caches = true;
${cppFunction(plan.header, "inline bool pass_scene_block_skips(")}
template<class Source,class Engine,class Scene,class Camera,class CameraKey,class WriteFull>
${cppFunction(plan.header, "void write_retained_pass_scene_ubo(")}
struct SceneUniforms { std::array<float,16> viewProjection{},view{}; };
template<class Cache,class WriteSystem>
${cppFunction(plan.header, "void update_shader_packet_system(")}
template<class Clear,class WriteView,class WriteViewProjection>
${cppFunction(plan.header, "void write_shader_packet_products(")}
template<class Custom,class System>
${cppFunction(plan.header, "void update_shader_binding(")}
enum class RenderBucket { opaque,alpha_blend };
enum class RenderMaterialKind { shader };
struct RenderItem { bbl::MeshHandle mesh; bbl::MaterialHandle material; bbl::ShaderPacketSystemOwner shader_packet; RenderBucket bucket=RenderBucket::opaque; RenderMaterialKind material_kind=RenderMaterialKind::shader; };
struct RenderDrawCommand { RenderItem item; };
struct RenderDrawList { std::vector<RenderDrawCommand> commands,binding_updates; };
bool render_item_material_draws(const RenderItem&, const Engine&){return true;}
}
namespace bbl {
${cppRecord(shader, "struct ShaderPacketSystemState")}
${cppFunction(render, "void initialize_shader_packet_camera_cache(")}
}
namespace bbl::pal {
struct CameraPassMatrices { double aspect=0; std::array<float,16> view_projection{},view{}; };
${cppRecord(shader, "struct ShaderPassMatrices")}
int world_reads=0;
std::array<float,16> world_value{};
std::array<float,16> mesh_block_world(const Scene&, const Engine&, const MeshRecord&) {++world_reads;return world_value;}
${cppFunction(shader, "inline std::optional<std::array<float, 16>> shader_world_view(")}
${cppRecord(shader, "struct ShaderDrawMatrices")}
${cppFunction(shared, "ShaderPassMatrices shader_packet_published_matrices(")}
${cppFunction(shared, "ShaderPassMatrices shader_packet_system_matrices(")}
template<class Rows,class BindBuffers>
${cppFunction(shader, "void update_material_bindings(")}
int packed=0;
upstream::SceneUniforms pinned_scene_block(const Scene&,const Engine&,const CameraRecord& camera,const std::array<float,16>& vp){++packed;return {vp,upstream::build_camera_view_matrix(camera)};}
upstream::SceneUniforms billboard_scene_block(const Scene&,const Engine&,const CameraRecord&,const std::array<float,16>& vp,const std::array<float,16>& view){++packed;return {vp,view};}
${cppRecord(pass, "template <class Block> class RetainedBlock")}
${cppRecord(pass, "struct RetainedSceneBlock")}
${cppFunction(pass, "inline void keep_view_projection(")}
}
void check_pass_cache(bbl::Engine& engine,bbl::CameraHandle handle){
 using namespace bbl;using namespace bbl::pal;using namespace bbl::upstream;
 Scene scene;RetainedSceneBlock retained;auto* camera=&handle_at(engine.cameras,handle);
 const auto prepare=[&](CameraRecord* value,double width=640){CameraPassMatrices matrices;matrices.aspect=width/320;if(value)matrices.view=build_camera_view_matrix(*value);keep_view_projection(matrices,value,retained,scene,engine,width,320);return matrices;};
 const auto first=prepare(camera);assert(packed==2&&retained.publish);
 const auto first_view=retained.pass.block().view;auto live_vp=get_camera_view_projection_matrix(*camera,2);auto live_view=get_camera_view_matrix(*camera);const float saved_vp=live_vp[3],saved_view=live_view[3];live_vp[3]=31;live_view[3]=37;
 const auto hit=prepare(camera);assert(!retained.publish&&packed==2&&hit.view_projection==first.view_projection);assert(retained.pass.block().view==first_view&&retained.billboard.block().view==first_view);
 // A hit must not re-read projection at the pass aspect after an unrelated public read.
 get_camera_projection_matrix(*camera,5);prepare(camera);assert(camera->projection_cache_aspect==5);
 MeshRecord mesh;MaterialRecord material;material.shader_alpha_cutoff=+[](const MaterialRecord&){return .4;};
 const auto owner=std::make_shared<std::shared_ptr<ShaderPacketSystemState>>();auto& world=world_value;world[0]=world[5]=world[10]=world[15]=1;
 ShaderPassMatrices input{};input.camera=camera;input.target_width=640;input.target_height=320;input.world=&world;
 const auto packet=shader_packet_system_matrices(owner,scene,engine,mesh,material,input);const auto packet_vp=**owner;
 assert(camera->projection_cache_aspect==2&&packet.view_projection[3]==31&&world_reads==1);
 live_vp[3]=43;live_view[3]=47;get_camera_projection_matrix(*camera,5);
 const auto packet_hit=shader_packet_system_matrices(owner,scene,engine,mesh,material,input);assert(packet_hit.view_projection[3]==31&&camera->projection_cache_aspect==5&&world_reads==1);prepare(camera);assert(!retained.publish&&retained.view_projection.block()[3]==first.view_projection[3]);
 const ShaderDrawMatrices draw(scene,engine,mesh,input);assert(shader_packet_published_matrices(owner,draw.apply(input)).world==&(*owner)->world&&world_reads==1);
 ++mesh.transform_version;const auto packet_miss=shader_packet_system_matrices(owner,scene,engine,mesh,material,input);assert(packet_miss.view_projection[3]==43&&(*packet_miss.view)[3]==47&&camera->projection_cache_aspect==2&&world_reads==2);prepare(camera);assert(!retained.publish);
 assert(packet_vp.view_projection[3]==31);
 const auto new_owner=std::make_shared<std::shared_ptr<ShaderPacketSystemState>>();shader_packet_system_matrices(new_owner,scene,engine,mesh,material,input);assert(new_owner!=owner&&*new_owner!=*owner);
 input.camera=nullptr;world[0]=std::numeric_limits<float>::infinity();world[1]=std::numeric_limits<float>::quiet_NaN();shader_packet_system_matrices(owner,scene,engine,mesh,material,input);assert((*owner)->camera.has_value()&&*(*owner)->camera==nullptr);for(const auto value:(*owner)->world_view)assert(value==0);for(const auto value:(*owner)->world_view_projection)assert(value==0);(*owner)->view_projection[0]=59;shader_packet_system_matrices(owner,scene,engine,mesh,material,input);assert((*owner)->view_projection[0]==59);input.camera=camera;world[0]=1;world[1]=0;
 input.shadow_camera_facade=true;bool refused=false;try{shader_packet_system_matrices(owner,scene,engine,mesh,material,input);}catch(const std::runtime_error& error){refused=std::string(error.what()).find("createShadowCamera")!=std::string::npos;}assert(refused);input.shadow_camera_facade=false;
 const auto before_capture=(*owner)->camera;shader_packet_published_matrices(owner,input);assert((*owner)->camera==before_capture&&(*owner)->view_projection[0]==59);
 live_vp[3]=31;live_view[3]=37;
 engine.meshes.push_back(MeshRecord{});engine.materials.push_back(material);const MeshHandle hidden_mesh{static_cast<std::uint32_t>(engine.meshes.size()-1)};const MaterialHandle hidden_material{static_cast<std::uint32_t>(engine.materials.size()-1)};
 handle_at(engine.meshes,hidden_mesh).visible=false;const auto hidden_owner=std::make_shared<std::shared_ptr<ShaderPacketSystemState>>();RenderDrawList bindings;bindings.binding_updates.push_back({{hidden_mesh,hidden_material,hidden_owner}});assert(bindings.commands.empty());int rows=0;
 update_material_bindings(scene,engine,bindings,input,rows,[]{});assert((*hidden_owner)->view_projection[3]==31);live_vp[3]=61;handle_at(engine.meshes,hidden_mesh).visible=true;update_material_bindings(scene,engine,bindings,input,rows,[]{});assert(shader_packet_published_matrices(hidden_owner,input).view_projection[3]==31);live_vp[3]=31;
 for(int i=0;i<1000;++i)create_free_camera(engine,{0,0,-5},{0,0,0});assert(camera==&handle_at(engine.cameras,handle));prepare(camera);assert(packed==2&&!retained.publish);
 scene.environment.exposure+=1;const auto changed=prepare(camera);assert(retained.publish&&packed==4&&changed.view_projection[3]==31);assert(retained.pass.block().view[3]==37&&retained.billboard.block().view[3]==37);
 prepare(camera);assert(packed==4&&!retained.publish);prepare(nullptr);assert(packed==4&&!retained.publish);
 prepare(camera,320);assert(packed==6&&retained.publish);
 auto other=create_free_camera(engine,{0,0,-5},{0,0,0});prepare(&handle_at(engine.cameras,other),320);assert(packed==8&&retained.publish);
 live_vp[3]=saved_vp;live_view[3]=saved_view;
 scene.engine=&engine;scene.camera=handle;engine.options.width=0;engine.options.height=0;initialize_shader_packet_camera_cache(scene,material);assert(camera->projection_cache_aspect==1&&camera->view_projection_cache_aspect==1);
}
void check(const bbl::js::F32Array& actual,const std::array<std::uint32_t,16>& expected){for(std::size_t i=0;i<16;++i){const auto value=std::bit_cast<float>(expected[i]);assert((std::isnan(value)&&std::isnan(actual[i]))||std::bit_cast<std::uint32_t>(actual[i])==expected[i]);}}
int main(){bbl::Engine engine;const auto handle=bbl::create_free_camera(engine,{2.1,3.2,-4.3},{1.4,-.5,6.7});auto camera=[&]() -> bbl::CameraRecord& {return bbl::handle_at(engine.cameras,handle);};using namespace bbl::upstream;
${checks.join("\n")}
}`;
    runGeneratedProgram(native, "camera-cache-native", code, {
        flags: [
            `/I${directory}`,
            "/DBBLITE_PINNED_MATERIALS=1",
            "/DBBLITE_GPU_INSTANCING=0",
            "/DBBLITE_HAS_BILLBOARDS=1",
        ],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("camera cache math and cache conditions remain source-derived", () => {
    const products = lowerShaderSystemProducts(
        doctoredContext(
            "src/material/shader/shader-renderable.ts",
            'case "worldView":\n                if (view)',
            'case "worldView":\n                if (!view)',
        ),
    );
    assert.match(products, /if \(camera == nullptr\)/);
    const altered = lowerCameraMatrixCaches(
        doctoredContext("src/camera/camera.ts", "v[15] = 1;", "v[15] = 2;"),
        false,
    );
    assert.match(
        altered,
        /view_cache\)\[static_cast<std::size_t>\(15\.0\)\] = static_cast<float>\(2\.0\)/,
    );
    assert.throws(
        () =>
            lowerCameraMatrixCaches(
                doctoredContext(
                    "src/camera/arc-rotate.ts",
                    "_viewCache: allocateMat4()",
                    "_viewVer: 0, _viewCache: allocateMat4()",
                ),
                false,
            ),
        /initially absent camera stamp/,
    );
});
