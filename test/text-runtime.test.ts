import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { TextLowerer } from "../src/lowering/text-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { materializePinnedText, type CompiledTextData, type TextBlob } from "../src/pinned-text-data.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { resolveBundledAsset } from "../src/compiler/assets.js";
import { stringLiteral } from "../src/cpp-literals.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { assertAsyncSceneBuilder } from "../src/lowering/scene-deferred.js";

test("deferred adapters require the actual async wrapper boundary", () => {
    const context = new LoweringContext();
    const source = context.functionDeclaration("src/scene/scene-core.ts", "addDeferredSceneRenderables").declaration;
    assertAsyncSceneBuilder(context, source);
    const changed = ts.createSourceFile("changed-scene.ts", source.getText().replace("async ()", "()"), ts.ScriptTarget.Latest, true);
    const declaration = changed.statements.find(ts.isFunctionDeclaration)!;
    assert.throws(() => assertAsyncSceneBuilder(context, declaration), /Expected one async deferred scene builder/);
});

interface Vector { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
interface Quaternion extends Vector { w: number; version: number; set(x: number, y: number, z: number, w?: number): void }
interface Renderable {
    position: Vector; scaling: Vector; rotation: Vector; rotationQuaternion: Quaternion;
    opacity: number; order: number; ignoreDepth: boolean; isTransparent: boolean;
    _wmDirty: boolean; _version: number; _worldMatrix(): Float32Array;
    _gpu: object | null; _data: object;
}

test("retained text CPU state matches pinned transforms, Euler cache, uniform writes and disposal", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/test-text-runtime");
    mkdirSync(directory, {recursive: true});
    const context = new LoweringContext();
    writeFileSync(resolve(directory, "upstream_text.hpp"), new TextLowerer(context).header());
    const {createTextRenderable, disposeTextRenderable} = await importPinnedModule<{
        createTextRenderable(data: object, options?: object): Renderable;
        disposeTextRenderable(renderable: Renderable): void;
    }>("text/text-renderable.js");
    const data = {_groups: [], _instanceCount: 0, _version: 1, _dirtyStart: 0, _dirtyEnd: 0};
    const renderable = createTextRenderable(data);
    const {file, declaration} = context.functionDeclaration("src/text/text-renderable.ts", "updateTextRenderable");
    // Execute the real function with recording resource seams. The supplied VP,
    // aspect and camera key are exactly the native adapter's input boundary.
    const js = ts.transpileModule(`${declaration.getText(file).replace(/^export\s+/, "")}\nreturn updateTextRenderable;`, {
        compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText;
    const instantiate = new Function("ensureStyleGpu", "ensureSharedAtlasGpu", "ensureInstanceCapacity", "getEffectiveAspectRatio", "_cameraChangeKey", "getViewProjectionMatrix", "mat4MultiplyInto", "_mvpScratch", js);
    const {mat4MultiplyInto} = await importPinnedModule<{mat4MultiplyInto(...args: unknown[]): void}>("math/mat4-multiply-into.js");
    const update = instantiate(() => false, () => {throw new Error("No atlas upload in the uniform control");}, () => {},
        (camera: {aspect: number}) => camera.aspect, (camera: {key: number}) => camera.key,
        (camera: {vp: Float32Array}) => camera.vp, mat4MultiplyInto, new Float32Array(16)) as
        (r: Renderable, engine: object, gpu: object, layout: object, context: object) => void;
    const vp = Float32Array.from([1.1,.2,.3,0, .4,1.3,.6,0, .7,.8,1.9,.2, 2,3,4,1]);
    const camera = {vp, key: 4, aspect: 1.25};
    const gpu = {_textU: {}, _uploadedDataVersion: -1, _uploadedCameraVersion: -1, _uploadedAspect: -1,
        _uploadedViewportW: 0, _uploadedViewportH: 0, _uploadedOpacity: NaN};
    const expected: number[] = [];
    const writes: Buffer[] = [];
    const engine = {_device: {queue: {writeBuffer(target: unknown, offset: number, buffer: ArrayBuffer, begin: number, count: number) {
        assert.equal(target, gpu._textU);
        const prefix = Buffer.alloc(8); prefix.writeUInt32LE(offset); prefix.writeUInt32LE(count, 4);
        writes.push(prefix, Buffer.from(buffer.slice(begin, begin + count)));
    }}}};
    const record = () => expected.push(renderable.position.x, renderable.position.y, renderable.position.z,
        renderable.rotationQuaternion.x, renderable.rotationQuaternion.y, renderable.rotationQuaternion.z, renderable.rotationQuaternion.w,
        renderable.rotationQuaternion.version, renderable.rotation.x, renderable.rotation.y, renderable.rotation.z,
        renderable.scaling.x, renderable.scaling.y, renderable.scaling.z, renderable.opacity, renderable.order,
        +renderable.ignoreDepth, +renderable.isTransparent, +renderable._wmDirty, renderable._version, ...renderable._worldMatrix());
    const actions: string[] = [];
    const act = (cpp: string, apply: () => void) => { actions.push(cpp, "record();"); apply(); record(); };
    act("", () => {});
    act("text_write_position(*r, 0, 0);", () => renderable.position.x = 0);
    act("text_set_position(*r, 0, 0, 0);", () => renderable.position.set(0,0,0));
    act("text_write_position(*r, 1, 2.123456789123);", () => renderable.position.y = 2.123456789123);
    act("text_set_scaling(*r, -.5, 1.2, 3.1);", () => renderable.scaling.set(-.5,1.2,3.1));
    act("text_set_rotation(*r, .1, 1.5707963267948966, -.3);", () => renderable.rotation.set(.1,Math.PI/2,-.3));
    act("text_write_rotation(*r, 0, .4);", () => renderable.rotation.x = .4);
    act("text_write_rotation(*r, 1, .6);", () => renderable.rotation.y = .6);
    act("text_write_rotation_quaternion(*r, 2, .125);", () => renderable.rotationQuaternion.z = .125);
    act("text_write_rotation(*r, 2, -.8);", () => renderable.rotation.z = -.8);
    act("text_set_rotation_quaternion(*r, .25, -.5, .75, 1);", () => renderable.rotationQuaternion.set(.25,-.5,.75,1));
    act("r->opacity = .234567891; r->order = -4; r->ignore_depth = true;", () => {renderable.opacity=.234567891;renderable.order=-4;renderable.ignoreDepth=true;});
    const uniform = (cpp: string, present = true, width = 800, height = 640) => act(cpp, () =>
        update(renderable, engine, gpu, {}, {_camera: present ? camera : null, targetWidth: width, targetHeight: height}));
    uniform("update_text_uniforms(*r, gpu, &camera, 800, 640, write);");
    uniform("update_text_uniforms(*r, gpu, &camera, 800, 640, write);");
    camera.key = 7;
    uniform("camera.change_key = 7; update_text_uniforms(*r, gpu, &camera, 800, 640, write);");
    camera.aspect = .75;
    uniform("camera.effective_aspect = .75; update_text_uniforms(*r, gpu, &camera, 800, 640, write);");
    uniform("update_text_uniforms(*r, gpu, nullptr, 400, 0, write);", false, 400, 0);
    act("text_write_position(*r, 2, -3);", () => renderable.position.z = -3);
    uniform("update_text_uniforms(*r, gpu, nullptr, 400, 0, write);", false, 400, 0);
    uniform("update_text_uniforms(*r, gpu, &camera, 400, 0, write);", true, 400, 0);
    let destroyed = "";
    renderable._gpu = {_textU: {destroy: () => destroyed += "u"}, _instanceBuf: {destroy: () => destroyed += "i"}, _styleBuf: {destroy: () => destroyed += "s"}};
    disposeTextRenderable(renderable); disposeTextRenderable(renderable);
    assert.equal(destroyed, "uis"); assert.equal(renderable._data, data); assert.equal(renderable._gpu, null);
    const expectedState = Buffer.alloc(expected.length*8);
    expected.forEach((value, index) => expectedState.writeDoubleLE(value,index*8));
    writeFileSync(resolve(directory,"expected-state.bin"), expectedState);
    writeFileSync(resolve(directory,"expected-writes.bin"), Buffer.concat(writes));
    const cpp = `#include "upstream_text.hpp"
#include <fstream>
#include <stdexcept>
int main() {
    using namespace bbl;
    auto data = create_text_data({});
    auto r = create_text_renderable(data);
    auto alias = r;
    auto other = create_text_renderable(data);
    if (alias != r || other == r || other->data != r->data) return 1;
    std::ofstream state("state.bin", std::ios::binary), writes("writes.bin", std::ios::binary);
    auto record = [&]() {
        const double ex = text_read_rotation(*r,0), ey = text_read_rotation(*r,1), ez = text_read_rotation(*r,2);
        const auto world = text_world_matrix(*r);
        const double values[] = {r->position.x,r->position.y,r->position.z,
            r->rotation_quaternion.x,r->rotation_quaternion.y,r->rotation_quaternion.z,r->rotation_quaternion.w,
            r->quaternion_version,ex,ey,ez,r->scaling.x,r->scaling.y,r->scaling.z,r->opacity,r->order,
            double(r->ignore_depth),double(r->is_transparent),double(r->wm_dirty),r->version};
        state.write(reinterpret_cast<const char*>(values),sizeof(values));
        for (float value: world) { const double wide=value; state.write(reinterpret_cast<const char*>(&wide),sizeof(wide)); }
    };
    const std::array<float,16> vp{${Array.from(vp, (value) => `${Number.isInteger(value) ? value.toFixed(1) : value}f`).join(",")}};
    TextCameraInput camera{vp,4,1.25};
    TextGpuState gpu;
    TextUniformWrite write = [&](std::size_t offset, std::span<const std::uint8_t> bytes) {
        const std::uint32_t prefix[] = {static_cast<std::uint32_t>(offset),static_cast<std::uint32_t>(bytes.size())};
        writes.write(reinterpret_cast<const char*>(prefix),sizeof(prefix));
        writes.write(reinterpret_cast<const char*>(bytes.data()),static_cast<std::streamsize>(bytes.size()));
    };
    ${actions.join("\n    ")}
    std::string destroyed;
    auto lease = std::make_shared<TextGpuState>();
    lease->destroy_uniform = [&] { destroyed += "u"; };
    lease->destroy_instances = [&] { destroyed += "i"; };
    lease->destroy_styles = [&] { destroyed += "s"; };
    r->gpu = lease;
    dispose_text_renderable(r); dispose_text_renderable(r);
    if (destroyed != "uis" || r->gpu || r->data != data || other->data != data) return 2;
    data.reset(); r.reset(); alias.reset();
    if (!other->data) return 3;
    return 0;
}
`;
    const source=resolve(directory,"check.cpp"), exe=resolve(directory,"check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/EHsc","/W4","/WX","/fp:strict",`/I${resolve("native/include")}`,source,`/Fo${resolve(directory,"check.obj")}`,`/Fe${exe}`]);
    execFileSync(exe,[],{cwd:directory,stdio:"pipe"});
    const actual=readFileSync(resolve(directory,"state.bin"));
    assert.equal(actual.length,expectedState.length);
    for(let offset=0;offset<actual.length;offset+=8) {
        const a=actual.readDoubleLE(offset), b=expectedState.readDoubleLE(offset);
        assert.ok(Math.abs(a-b)<=1e-14,`state lane ${offset/8}: ${a} vs ${b}`);
        if(a===0 && b===0) assert.equal(Object.is(a,-0),Object.is(b,-0),`zero sign at ${offset/8}`);
    }
    assert.deepEqual(readFileSync(resolve(directory,"writes.bin")),Buffer.concat(writes));
});

test("deferred scene registration observes snapshot order, identity guards, failure and retained text disposal", async (t) => {
    const native=optionalNativeFixtureTools(false);
    if(!native){t.skip("Native fixture compiler unavailable.");return;}
    interface PinScene { _deferredBuilders: Array<()=>void | Promise<void>>; _renderables: Renderable[]; _disposables: Array<()=>void> }
    const pin = await importPinnedModule<{
        createSceneContext(surface: object, options: object): PinScene;
        registerScene(scene: PinScene): Promise<void>;
        disposeScene(scene: PinScene): void;
    }>("scene/scene-core.js");
    const {unregisterRenderingContext} = await importPinnedModule<{unregisterRenderingContext(surface: object, scene: PinScene): void}>("engine/engine.js");
    const text = await importPinnedModule<{createTextRenderable(data: object, options?: object): Renderable; addTextRenderable(scene: PinScene,r: Renderable): void}>("text/text-renderable.js");
    const surface={engine:{},_renderingContexts:[] as PinScene[]};
    const scene=pin.createSceneContext(surface,{defaultRenderTask:false});
    let order="";
    scene._deferredBuilders.push(()=>{order+="a";scene._deferredBuilders.push(()=>{order+="c";});},()=>{order+="b";});
    await pin.registerScene(scene); assert.equal(order,"abc"); assert.deepEqual(surface._renderingContexts,[scene]);
    scene._deferredBuilders.push(()=>{order+="d";});
    await pin.registerScene(scene); assert.equal(order,"abc"); assert.equal(scene._deferredBuilders.length,1);
    unregisterRenderingContext(surface,scene);
    await pin.registerScene(scene); assert.equal(order,"abcd"); assert.equal(scene._deferredBuilders.length,0);
    unregisterRenderingContext(surface,scene);
    scene._deferredBuilders.push(()=>{order+="e";scene._deferredBuilders.push(()=>{order+="g";});throw new Error("builder");},()=>{order+="f";});
    await assert.rejects(pin.registerScene(scene),/builder/);
    assert.equal(order,"abcde"); assert.equal(surface._renderingContexts.length,0); assert.equal(scene._deferredBuilders.length,1);
    await pin.registerScene(scene); assert.equal(order,"abcdeg");
    // Async wrappers reject without aborting Array.map's remaining calls.
    // The next drain still waits for a successful retry of this failed batch.
    const rejectedSurface={engine:{},_renderingContexts:[] as PinScene[]};
    const rejectedScene=pin.createSceneContext(rejectedSurface,{defaultRenderTask:false});
    let rejectedOrder="";
    rejectedScene._deferredBuilders.push(async()=>{
        rejectedOrder+="a";
        rejectedScene._deferredBuilders.push(()=>{rejectedOrder+="c";});
        throw new Error("first rejection");
    },async()=>{rejectedOrder+="b";throw new Error("second rejection");});
    await assert.rejects(pin.registerScene(rejectedScene),/first rejection/);
    assert.equal(rejectedOrder,"ab");
    assert.equal(rejectedScene._deferredBuilders.length,1);
    assert.equal(rejectedSurface._renderingContexts.length,0);
    await pin.registerScene(rejectedScene);assert.equal(rejectedOrder,"abc");
    unregisterRenderingContext(rejectedSurface,rejectedScene);
    rejectedScene._deferredBuilders.push(async()=>{rejectedOrder+="d";},()=>{
        rejectedOrder+="e";throw new Error("synchronous throw");
    },async()=>{rejectedOrder+="f";});
    await assert.rejects(pin.registerScene(rejectedScene),/synchronous throw/);
    assert.equal(rejectedOrder,"abcde");
    const r=text.createTextRenderable({_instanceCount:1});
    const other=text.createTextRenderable({_instanceCount:1},{order:-5});
    text.addTextRenderable(scene,r); text.addTextRenderable(scene,r); text.addTextRenderable(scene,other);
    await pin.registerScene(scene); assert.equal(scene._renderables.length,0);
    unregisterRenderingContext(surface,scene); await pin.registerScene(scene);
    assert.deepEqual(scene._renderables,[other,r,r]);
    let destroyed="";
    r._gpu={_textU:{destroy:()=>destroyed+="u"},_instanceBuf:{destroy:()=>destroyed+="i"},_styleBuf:{destroy:()=>destroyed+="s"}};
    pin.disposeScene(scene);pin.disposeScene(scene);
    assert.equal(destroyed,"uis");assert.equal(scene._renderables.length,0);

    const context=new LoweringContext(), directory=resolve("artifacts/test-text-registration");
    mkdirSync(directory,{recursive:true});
    const source=new SceneLowerer(context).lowerCore({text:true}).source;
    const ordinary=new SceneLowerer(context).lowerCore().source;
    assert.doesNotMatch(ordinary,/text_renderables|bblite\/text\.hpp/);
    writeFileSync(resolve(directory,"upstream_text.hpp"),new TextLowerer(context).header());
    const bodies=["void require_scene_engine(","std::uint32_t material_family_bit(","std::uint32_t scene_material_families(","void drain_scene_deferred_builders(","void register_scene(","void unregister_scene(","void dispose_scene("].map((name)=>cppFunction(source,name)).join("\n");
    const cpp=`#include "upstream_text.hpp"
namespace bbl {
${lowerMeshMaterialSetter(context)}
${bodies}
}
int main(){
    using namespace bbl;
    Engine engine; Scene scene; scene.engine=&engine;
    std::string order;
    scene.deferred_builders.push_back([&]{order+="a";scene.deferred_builders.push_back([&]{order+="c";});});
    scene.deferred_builders.push_back([&]{order+="b";});
    register_scene(scene);
    if(order!="abc" || engine.registered_scenes.size()!=1) return 1;
    auto alias=scene;
    alias.deferred_builders.push_back([&]{order+="d";});
    register_scene(alias);
    if(order!="abc" || scene.deferred_builders.size()!=1) return 2;
    unregister_scene(scene); register_scene(alias);
    if(order!="abcd" || !scene.deferred_builders.empty()) return 3;
    unregister_scene(scene);
    scene.deferred_builders.push_back([&]{order+="e";scene.deferred_builders.push_back([&]{order+="g";});throw std::runtime_error("builder");});
    scene.deferred_builders.push_back([&]{order+="f";});
    try { register_scene(scene); return 4; } catch(const std::runtime_error&) {}
    if(order!="abcde" || !engine.registered_scenes.empty() || scene.deferred_builders.size()!=1) return 5;
    register_scene(scene); if(order!="abcdeg") return 6;
    Scene rejected;rejected.engine=&engine;
    std::string rejected_order;
    rejected.deferred_builders.emplace_back([&]{
        rejected_order+="a";
        rejected.deferred_builders.push_back([&]{rejected_order+="c";});
        throw std::runtime_error("first rejection");
    },SceneDeferredFailure::promise_rejection);
    rejected.deferred_builders.emplace_back([&]{rejected_order+="b";throw std::runtime_error("second rejection");},SceneDeferredFailure::promise_rejection);
    try {register_scene(rejected);return 12;} catch(const std::runtime_error& error) {
        if(std::string(error.what())!="first rejection")return 13;
    }
    if(rejected_order!="ab" || rejected.deferred_builders.size()!=1 || engine.registered_scenes.size()!=1)return 14;
    register_scene(rejected);if(rejected_order!="abc")return 15;
    unregister_scene(rejected);
    rejected.deferred_builders.emplace_back([&]{rejected_order+="d";},SceneDeferredFailure::promise_rejection);
    rejected.deferred_builders.push_back([&]{rejected_order+="e";throw std::runtime_error("synchronous throw");});
    rejected.deferred_builders.emplace_back([&]{rejected_order+="f";},SceneDeferredFailure::promise_rejection);
    try {register_scene(rejected);return 16;} catch(const std::runtime_error& error) {
        if(std::string(error.what())!="synchronous throw")return 17;
    }
    if(rejected_order!=${stringLiteral(rejectedOrder)})return 18;
    auto data=create_text_data({});
    auto r=create_text_renderable(data);
    TextRenderableOptions options; options.order=-5;
    auto other=create_text_renderable(data,options);
    add_text_renderable(scene,r); add_text_renderable(alias,r); add_text_renderable(scene,other);
    register_scene(scene); if(!scene.state->text_renderables.empty()) return 7;
    unregister_scene(scene);register_scene(scene);
    if(scene.state->text_renderables!=std::vector<TextRenderable>{other,r,r}) return 8;
    std::string destroyed;
    r->gpu=std::make_shared<TextGpuState>();
    r->gpu->destroy_uniform=[&]{destroyed+="u";};
    r->gpu->destroy_instances=[&]{destroyed+="i";};
    r->gpu->destroy_styles=[&]{destroyed+="s";};
    dispose_scene(scene);dispose_scene(alias);
    if(destroyed!="uis" || !scene.state->text_renderables.empty() || !engine.registered_scenes.empty()) return 9;
    try { add_text_renderable(scene,r); return 11; } catch(const std::runtime_error&) {}
    std::weak_ptr<SceneState> weak;
    { Scene abandoned;weak=abandoned.state;add_text_renderable(abandoned,r); }
    js::collect_cycles();
    if(!weak.expired()) return 10;
    return 0;
}`;
    const path=resolve(directory,"check.cpp"),exe=resolve(directory,"check.exe");writeFileSync(path,cpp);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/EHsc","/W4","/WX","/DBBLITE_HAS_TEXT=1",`/I${resolve("native/include")}`,path,`/Fo${resolve(directory,"check.obj")}`,`/Fe${exe}`]);
    execFileSync(exe,[],{cwd:directory,stdio:"pipe"});
});

test("materialized text preserves byte streams, source identities, atlas ownership and factory options", async (t) => {
    const native=optionalNativeFixtureTools(false);
    if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const directory=resolve("artifacts/test-text-storage");mkdirSync(directory,{recursive:true});
    const fontBytes=readAssetBytesSync(resolveBundledAsset("/fonts/Roboto-Regular.ttf"),resolve(directory,"source.ts"));
    const layout={fontSizePx:180,text:"A2C"};
    const baked=materializePinnedText(fontBytes,layout)!;
    const chunks: Buffer[]=[];
    const blob=(encoded:string):TextBlob=>{
        const bytes=Buffer.from(encoded,"base64"),assetOutput=`${chunks.length}.bin`;
        chunks.push(bytes);writeFileSync(resolve(directory,assetOutput),bytes);
        return {assetOutput,sha256:"",byteLength:bytes.length};
    };
    const row:CompiledTextData={...baked,id:0,font:{source:"fixture-font",assetOutput:"font",sha256:""},layout,
        instances:{...baked.instances,bytes:blob(baked.instances.bytes)},
        styles:{...baked.styles,bytes:blob(baked.styles.bytes)},
        atlases:baked.atlases.map((atlas)=>({...atlas,curves:{...atlas.curves,bytes:blob(atlas.curves.bytes)},bands:{...atlas.bands,bytes:blob(atlas.bands.bytes)},metadata:{...atlas.metadata,bytes:blob(atlas.metadata.bytes)}}))};
    interface PinData {width:number;height:number;_version:number;_styleVersion:number;_layoutVersion:number;_dirtyStart:number;_dirtyEnd:number;
        _instanceCount:number;_styleCount:number;_groups:Array<{_bindGroup:object|null}>;_storage:{_curveSets:Map<string,{_atlas:{_gpu:object|null}}>}}
    const fontModule=await importPinnedModule<{createFontFromBuffer(bytes:ArrayBuffer):unknown}>("text/font.js");
    const pin=await importPinnedModule<{createDefaultTextData(font:unknown,size:number,text:string):PinData;disposeDefaultTextData(data:PinData):void}>("text/default-text-data.js");
    const data=pin.createDefaultTextData(fontModule.createFontFromBuffer(Uint8Array.from(fontBytes).buffer),layout.fontSizePx,layout.text);
    assert.deepEqual(baked.versions,{data:data._version,style:data._styleVersion,layout:data._layoutVersion});
    assert.deepEqual(baked.dirtyRange,{start:data._dirtyStart,end:data._dirtyEnd});
    let destroyed="";
    for(const set of data._storage._curveSets.values())set._atlas._gpu={_curveTex:{destroy:()=>destroyed+="c"},_bandTex:{destroy:()=>destroyed+="b"},_metaBuf:{destroy:()=>destroyed+="m"}};
    for(const group of data._groups)group._bindGroup={};
    const {disposeTextData}=await importPinnedModule<{disposeTextData(data:PinData):void}>("text/text-data.js");
    disposeTextData(data);
    assert.equal(data._groups.length,0);assert.equal(data._instanceCount,0);assert.equal(data._styleCount,0);
    assert.equal(data._storage._curveSets.size,baked.atlases.length);assert.equal(destroyed,"");
    pin.disposeDefaultTextData(data);pin.disposeDefaultTextData(data);
    assert.equal(destroyed,"cbm".repeat(baked.atlases.length));assert.equal(data.width,baked.width);assert.equal(data.height,baked.height);
    assert.deepEqual({data:data._version,style:data._styleVersion,layout:data._layoutVersion},baked.versions);
    const text=await importPinnedModule<{createTextRenderable(data:object,options:object):Renderable}>("text/text-renderable.js");
    const configured=text.createTextRenderable(data,{position:{x:-0,y:0,z:0},scaling:{x:1,y:1,z:1},rotationQuaternion:{x:0,y:0,z:0,w:1},opacity:0,ignoreDepth:true,order:0});
    assert.ok(Object.is(configured.position.x,-0));assert.ok(!Object.is(configured._worldMatrix()[12],-0));
    const context=new LoweringContext(),lowerer=new TextLowerer(context);
    writeFileSync(resolve(directory,"upstream_text.hpp"),lowerer.header());
    const expression=lowerer.dataExpression(row,(blob)=>`read(${stringLiteral(blob.assetOutput)})`);
    const cpp=`#include "upstream_text.hpp"
#include <fstream>
#include <iterator>
std::vector<std::uint8_t> read(const std::string& path){std::ifstream input(path,std::ios::binary);return {std::istreambuf_iterator<char>(input),{}};}
int main(){
    using namespace bbl;
    auto first=${expression};auto second=${expression};auto alias=first;
    if(first==second || alias!=first) return 1;
    if(first->payload->width!=${row.width} || first->payload->height!=${row.height} || first->version!=${row.versions.data} ||
        first->style_version!=${row.versions.style} || first->layout_version!=${row.versions.layout} || first->dirty_start!=${row.dirtyRange.start} || first->dirty_end!=${row.dirtyRange.end})return 2;
    const auto& payload=*first->payload;
    if(payload.instances.capacity_bytes!=${row.instances.capacityBytes} || payload.instances.stride_bytes!=${row.instances.strideBytes} ||
        payload.styles.capacity_bytes!=${row.styles.capacityBytes} || payload.styles.stride_bytes!=${row.styles.strideBytes}) return 3;
    std::ofstream output("bytes.bin",std::ios::binary);
    auto dump=[&](const auto& bytes){output.write(reinterpret_cast<const char*>(bytes.data()),static_cast<std::streamsize>(bytes.size()));};
    dump(payload.instances.bytes);dump(payload.styles.bytes);
    for(const auto& atlas:payload.atlases){dump(atlas.curves.bytes);dump(atlas.bands.bytes);dump(atlas.metadata.bytes);}
    ${row.atlases.map((atlas,index)=>`if(payload.atlases[${index}].curves.width!=${atlas.curves.width} || payload.atlases[${index}].curves.height!=${atlas.curves.height} || payload.atlases[${index}].curves.used_texels!=${atlas.curves.usedTexels} || payload.atlases[${index}].metadata.capacity_bytes!=${atlas.metadata.capacityBytes} || payload.atlases[${index}].version!=${atlas.version}) return 4;`).join("\n")}
    ${row.groups.map((group,index)=>`if(first->groups[${index}].slot_start!=${group.slotStart} || first->groups[${index}].slot_count!=${group.slotCount} || first->groups[${index}].live_count!=${group.liveCount} || first->groups[${index}].atlas_index!=${group.atlasIndex}) return 5;`).join("\n")}
    std::string destroyed;
    for(auto& gpu:first->atlas_gpu){gpu=std::make_shared<TextAtlasGpuState>();gpu->destroy_curves=[&]{destroyed+="c";};gpu->destroy_bands=[&]{destroyed+="b";};gpu->destroy_metadata=[&]{destroyed+="m";};}
    for(auto& group:first->groups)group.bind_group=std::make_shared<int>(1);
    auto rendered=create_text_renderable(first);first.reset();
    dispose_text_data(alias);
    if(!alias->groups.empty() || alias->instance_count || alias->style_count || !destroyed.empty() || alias->atlas_gpu.size()!=${row.atlases.length})return 6;
    dispose_default_text_data(alias);dispose_default_text_data(rendered->data);
    if(destroyed!=${stringLiteral(destroyed)} || !alias->atlas_gpu.empty() || rendered->data->payload->width!=${data.width} ||
        rendered->data->version!=${data._version} || rendered->data->style_version!=${data._styleVersion})return 7;
    if(second->groups.empty() || !second->instance_count) return 8;
    TextRenderableOptions options;options.position=Vec3d{-0.0,0,0};options.scaling=Vec3d{1,1,1};options.rotation_quaternion=TextQuaternion{0,0,0,1};options.opacity=0;options.ignore_depth=true;options.order=0;
    auto r=create_text_renderable(second,options);
    if(!std::signbit(r->position.x) || std::signbit(text_world_matrix(*r)[12]) || r->opacity || r->order || !r->ignore_depth)return 9;
    return 0;
}`;
    const source=resolve(directory,"check.cpp"),exe=resolve(directory,"check.exe");writeFileSync(source,cpp);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/EHsc","/W4","/WX",`/I${resolve("native/include")}`,source,`/Fo${resolve(directory,"check.obj")}`,`/Fe${exe}`]);
    execFileSync(exe,[],{cwd:directory,stdio:"pipe"});
    assert.deepEqual(readFileSync(resolve(directory,"bytes.bin")),Buffer.concat(chunks));
});
