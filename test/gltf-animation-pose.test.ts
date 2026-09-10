import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAnimationPose} from "../src/lowering/gltf/animation-pose.js";
import {lowerMatrixComposeCpp} from "../src/lowering/gltf/matrix-leaves.js";
import {pinnedMatrixHeader} from "../src/lowering/pinned-matrix.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const modulePath = "src/skeleton/skeleton-updater.ts";
interface NodeRest {tx:number;ty:number;tz:number;rx:number;ry:number;rz:number;rw:number;sx:number;sy:number;sz:number;parentIdx:number;_matrix?:Float32Array}
interface Channel {nodeIdx:number;samplerIdx:number;path:number;pointerArity?:number;pointerQuaternion?:boolean;pointerWriter?:(values:Float32Array,offset:number)=>void}
interface Morph {nodeIdx:number;targetCount:number;weights:Float32Array;runtimeMorphTargets?:{_disposed:boolean;weightsBuffer:number};weightsBuffer:number}
interface Skeleton {jointNodes:number[];boneCount:number;invMeshWorld:Float32Array;inverseBindMatrices:Float32Array;boneMatrices:Float32Array;runtimeSkeleton?:{_disposed:boolean;boneTexture:number};boneTexture:number}
interface Captured {
    ctrl:{time:number;playing:boolean;tick(delta:number,engine?:object):void;_tickCpu(delta:number,engine?:object):void;_setMask(mask:object):void};
    currentTRS:Float32Array;localMat:Float32Array;worldMat:Float32Array;topoOrder:Int32Array;clipSkeletons:Skeleton[];
    nodeTrsBindings:Array<{target:{index:number};off:number;mask:number}>;
    pointerScratch:Float32Array;getMorph():Float32Array;
}
const matrix = (x=0):Float32Array => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]);
const bits = (array:Float32Array):number[] => [...new Uint32Array(array.buffer,array.byteOffset,array.length)];
function sourceCase(context:LoweringContext, count:number, masked:boolean, upload:boolean, disposed:boolean) {
    const file=context.sourceFile(modulePath), printer=ts.createPrinter();
    let source=file.statements.filter(statement=>!ts.isImportDeclaration(statement)).map(statement=>
        printer.printNode(ts.EmitHint.Unspecified,statement,file).replace(/^export /gm, "")).join("\n");
    assert.equal(source.split("return ctrl;").length,2);
    source=source.replace("return ctrl;", "return {ctrl,currentTRS,localMat,worldMat,topoOrder,clipSkeletons,nodeTrsBindings,pointerScratch,getMorph:()=>morphUploadF32};");
    const events:unknown[]=[];
    const math=(path:string,symbol:string) => new Function(transpileCommonJs(
        context.functionDeclaration(path,symbol).declaration.getText().replace(/^export /, ""),path)+`\nreturn ${symbol};`)() as (...args:unknown[])=>void;
    const compose=math("src/math/mat4-compose-into.ts","mat4ComposeInto");
    const multiply=math("src/math/mat4-multiply-into.ts","mat4MultiplyInto");
    const names=["PATH_TRANSLATION","PATH_ROTATION","PATH_SCALE","PATH_WEIGHTS","PATH_POINTER"];
    const types=context.sourceFile("src/animation/types.ts");
    const constants=names.map(name=>context.numericValue(context.moduleScopeConstant(types,name)!,types));
    const sampler=(factor:number,time:number,arity:number,quaternion:boolean,out:Float32Array,offset:number)=>{
        events.push(["sample",factor,time,arity,quaternion]);
        for(let i=0;i<arity;i++)out[offset+i]=factor+time+i+.123456789;
    };
    const overrides=(_map:Map<number,unknown>,trs:Float32Array,_count:number,visibility=false)=>{
        events.push(["override",visibility]); trs[visibility?7:0]=visibility?0:42;
    };
    const runtime=new Function("F32","I32","U8",...names,"mat4ComposeInto","mat4MultiplyInto","evaluateSampler","_boneApplier",
        transpileCommonJs(source,modulePath)+"\nreturn {createAnimationController,_installAnimationMaskResolver};")(
        Float32Array,Int32Array,Uint8Array,...constants,compose,multiply,sampler,overrides) as {
            createAnimationController(clip:object,nodes:NodeRest[],skeletons:Skeleton[],morphs:Morph[],targets:object[],excluded:Set<number>,overrides:Map<number,unknown>,names:string[]):Captured;
            _installAnimationMaskResolver(resolver:(mask:unknown,names:unknown,out:Uint8Array)=>void):void;
        };
    runtime._installAnimationMaskResolver((_mask,_names,out)=>{out.fill(0);if(masked)out[2]=1;});
    const nodes:NodeRest[]=Array.from({length:4},(_,index)=>({tx:index+.25,ty:index/3,tz:-index,rx:0,ry:0,rz:0,rw:1,sx:1,sy:1,sz:1,parentIdx:index===1||index===2?0:-1,
        ...(index===1?{_matrix:matrix(3)}:{})}));
    const targets=nodes.map((_node,index)=>({index,position:{set:(...v:number[])=>events.push(["translation",index,...v])},
        rotationQuaternion:{set:(...v:number[])=>events.push(["rotation",index,...v])},scaling:{set:(...v:number[])=>events.push(["scale",index,...v])}}));
    const channels:Channel[]=[{nodeIdx:0,path:0,samplerIdx:0},{nodeIdx:2,path:4,samplerIdx:1,pointerArity:3,pointerQuaternion:true},
        {nodeIdx:2,path:3,samplerIdx:2},{nodeIdx:2,path:0,samplerIdx:3},{nodeIdx:2,path:1,samplerIdx:4},
        {nodeIdx:2,path:2,samplerIdx:5},{nodeIdx:-1,path:4,samplerIdx:6,pointerArity:2},
        {nodeIdx:3,path:3,samplerIdx:7},{nodeIdx:-1,path:4,samplerIdx:8,pointerArity:0}];
    for(const channel of channels)if(channel.path===4)channel.pointerWriter=(values,offset)=>events.push(["pointer",channel.samplerIdx,...bits(values.subarray(offset,offset+(channel.pointerArity??0)))]);
    const skeletons:Skeleton[]=[1,3].map((joint,index)=>({jointNodes:[joint],boneCount:1,invMeshWorld:matrix(-2.25),inverseBindMatrices:matrix(.125),boneMatrices:new Float32Array(16),
        boneTexture:index,runtimeSkeleton:{_disposed:disposed,boneTexture:index}}));
    const morphs:Morph[]=[false,true].map((dead,index)=>({nodeIdx:2,targetCount:count,weights:new Float32Array(count),weightsBuffer:index,
        runtimeMorphTargets:{_disposed:dead,weightsBuffer:index}}));
    const clip={duration:2,channels,samplers:channels.map((_channel,index)=>index+.5)};
    const capture=runtime.createAnimationController(clip,nodes,skeletons,morphs,targets,new Set([0,1]),new Map([[0,{}]]),nodes.map((_n,i)=>String(i)));
    const initial={nodes:nodes.map(n=>({...n,_matrix:n._matrix?[...n._matrix]:null})),channels:channels.map(ch=>({...ch,pointerWriter:!!ch.pointerWriter})),samplers:clip.samplers,
        topo:[...capture.topoOrder],bindings:capture.nodeTrsBindings.map(b=>({...b,target:b.target.index})),
        skeletons:capture.clipSkeletons.map(s=>({...s,invMeshWorld:[...s.invMeshWorld],inverseBindMatrices:[...s.inverseBindMatrices],boneMatrices:[...s.boneMatrices]})),
        morphs:morphs.map(m=>({...m,weights:[...m.weights]})),count,masked,upload,disposed};
    capture.ctrl._setMask({names:["2"],mode:0,disabled:false});capture.ctrl.time=.25;capture.ctrl.playing=false;
    const engine={_device:{queue:{writeBuffer:(id:number,_offset:number,buffer:ArrayBuffer,_begin:number,length:number)=>events.push(["morph",id,...bits(new Float32Array(buffer,0,length/4))]),
        writeTexture:(destination:{texture:number},buffer:ArrayBuffer,layout:{bytesPerRow:number},size:{width:number})=>events.push(["bones",destination.texture,layout.bytesPerRow,size.width,...bits(new Float32Array(buffer))])}}};
    if(upload)capture.ctrl.tick(0,engine);else capture.ctrl._tickCpu(0);
    return {initial,expected:{events,trs:bits(capture.currentTRS),local:bits(capture.localMat),world:bits(capture.worldMat),pointer:bits(capture.pointerScratch),
        morphScratch:bits(capture.getMorph()),morphs:morphs.map(m=>bits(m.weights)),bones:capture.clipSkeletons.map(s=>bits(s.boneMatrices))}};
}
const contexts=()=>[new LoweringContext(),doctoredContext(modulePath,"currentTRS[off + T_OFF] = n.tx;","currentTRS[off + T_OFF] = n.tx + 2;"),
    doctoredContext(modulePath,"if (uploadGpu && !skel.runtimeSkeleton?._disposed)","if (uploadGpu && skel.runtimeSkeleton?._disposed)")];

test("source live pose cases cover masks, node exclusion, upload lifetime and source mutations",()=>{
    for(const context of contexts()) {assert.ok(lowerGltfAnimationPose(context));for(const count of [3,20])for(const masked of [false,true])for(const upload of [false,true])for(const disposed of [false,true])
        assert.ok(sourceCase(context,count,masked,upload,disposed).expected.world.length);}
    assert.throws(()=>lowerGltfAnimationPose(doctoredContext(modulePath,
        "if (ch.pointerArity && ch.pointerWriter) {", "if (!ch.pointerWriter) { break; } if (ch.pointerArity && ch.pointerWriter) {")),/explicit switch boundary/);
});

test("native live pose follows the complete source tick with exact float stores and ordered callbacks",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const variants=contexts(), cases=variants.map(context=>[3,20].flatMap(count=>[false,true].flatMap(masked=>[false,true].flatMap(upload=>[false,true].map(disposed=>sourceCase(context,count,masked,upload,disposed))))));
    const directory=resolve("artifacts/test-gltf-animation-pose");mkdirSync(directory,{recursive:true});
    writeFileSync(resolve(directory,"cases.json"),JSON.stringify(cases));
    writeFileSync(resolve(directory,"pinned_matrix.hpp"),pinnedMatrixHeader(variants[0]!));
    const file=resolve(directory,"check.cpp"),exe=resolve(directory,"check.exe");
    writeFileSync(file,`#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <bit>
#include <fstream>
#include "pinned_matrix.hpp"
using Json=nlohmann::json;
using Floats=std::vector<float>;
using Matrix=std::array<float,16>;
using bbl::Vec3;using bbl::Vec4;
Matrix identity_matrix(){return {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};}
${lowerMatrixComposeCpp(variants[0]!.sourceFile("src/math/mat4-compose-into.ts"))}
Json bits(const Floats& values){Json result=Json::array();for(float v:values)result.push_back(std::bit_cast<std::uint32_t>(v));return result;}
struct Node{double tx,ty,tz,rx,ry,rz,rw,sx,sy,sz,parentIdx;std::optional<Floats> matrix;};
struct Channel{double nodeIdx,samplerIdx,path,pointerArity;bool pointerQuaternion,pointer_writer;};
struct Binding{std::size_t target;double off,mask;};
struct Skeleton{Floats invMeshWorld,inverseBindMatrices;std::vector<double> jointNodes;double boneCount;bool disposed;int id;};
struct Morph{double targetCount;Floats weights;bool disposed;int id;};
struct State{std::vector<Node> nodes;std::vector<Channel> channels;std::vector<double> samplers,topo_order;std::vector<Binding> node_trs_bindings;std::vector<Skeleton> skeletons;std::vector<Floats> bone_scratch;std::vector<Morph> morphs;
Floats currentTRS,localMat,worldMat,_boneTmp=Floats(16),RH_TO_LH={-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
std::shared_ptr<Floats> pointerScratch=std::make_shared<Floats>(16),morphUploadF32=pointerScratch;std::vector<std::uint8_t> masked_nodes;
bool mask_active=true,mask_resolver=true,has_bone_overrides=true;double bone_override_count=1;};
template<class Evaluate> Json run(const Json& row,Evaluate evaluate){const auto& input=row.at("initial");State state;
for(const auto& n:input.at("nodes")){Node v{n.at("tx"),n.at("ty"),n.at("tz"),n.at("rx"),n.at("ry"),n.at("rz"),n.at("rw"),n.at("sx"),n.at("sy"),n.at("sz"),n.at("parentIdx"),{}};if(!n.at("_matrix").is_null())v.matrix=n.at("_matrix").get<Floats>();state.nodes.push_back(v);}
for(const auto& ch:input.at("channels"))state.channels.push_back({ch.at("nodeIdx"),ch.at("samplerIdx"),ch.at("path"),ch.value("pointerArity",0.0),ch.value("pointerQuaternion",false),ch.at("pointerWriter")});
for(const auto& b:input.at("bindings"))state.node_trs_bindings.push_back({b.at("target").get<std::size_t>(),b.at("off"),b.at("mask")});
for(const auto& s:input.at("skeletons")){state.skeletons.push_back({s.at("invMeshWorld").get<Floats>(),s.at("inverseBindMatrices").get<Floats>(),s.at("jointNodes").get<std::vector<double>>(),s.at("boneCount"),input.at("disposed"),s.at("boneTexture")});state.bone_scratch.push_back(s.at("boneMatrices").get<Floats>());}
for(const auto& m:input.at("morphs"))state.morphs.push_back({m.at("targetCount"),m.at("weights").get<Floats>(),m.at("runtimeMorphTargets").at("_disposed"),m.at("weightsBuffer")});
state.samplers=input.at("samplers").get<std::vector<double>>();state.topo_order=input.at("topo").get<std::vector<double>>();state.currentTRS.resize(state.nodes.size()*12);state.localMat.resize(state.nodes.size()*16);state.worldMat.resize(state.nodes.size()*16);state.masked_nodes.resize(state.nodes.size());state.masked_nodes[2]=input.at("masked").get<bool>()?1:0;
Json events=Json::array();
auto sample=[&](double factor,double time,double arity,bool quaternion,Floats& out,double offset){events.push_back({"sample",factor,time,arity,quaternion});for(std::size_t i=0;i<static_cast<std::size_t>(arity);++i)out.at(static_cast<std::size_t>(offset)+i)=static_cast<float>(factor+time+static_cast<double>(i)+.123456789);};
auto compose=[](Floats& out,double offset,double tx,double ty,double tz,double rx,double ry,double rz,double rw,double sx,double sy,double sz){auto m=trs_matrix({float(tx),float(ty),float(tz)},{float(rx),float(ry),float(rz),float(rw)},{float(sx),float(sy),float(sz)});std::copy(m.begin(),m.end(),out.begin()+static_cast<std::size_t>(offset));};
auto multiply=[](Floats& out,double offset,const Floats& a,double ao,const Floats& b,double bo){Matrix result{};bbl::upstream::mat4_multiply_into(result,0,a,static_cast<std::int64_t>(ao),b,static_cast<std::int64_t>(bo));std::copy(result.begin(),result.end(),out.begin()+static_cast<std::size_t>(offset));};
auto morph=[&](double node)->std::vector<Morph>*{return node==2?&state.morphs:nullptr;};
auto overrides=[&](Floats& trs,double,bool visibility){events.push_back({"override",visibility});trs[visibility?7:0]=visibility?0.0f:42.0f;};
auto pointer=[&](const Channel& ch,const Floats& values,double offset){Json event={"pointer",ch.samplerIdx};for(std::size_t i=0;i<static_cast<std::size_t>(ch.pointerArity);++i)event.push_back(std::bit_cast<std::uint32_t>(values.at(static_cast<std::size_t>(offset)+i)));events.push_back(event);};
auto translation=[&](std::size_t target,double x,double y,double z){events.push_back({"translation",target,x,y,z});};
auto rotation=[&](std::size_t target,double x,double y,double z,double w){events.push_back({"rotation",target,x,y,z,w});};
auto scale=[&](std::size_t target,double x,double y,double z){events.push_back({"scale",target,x,y,z});};
auto uploadMorph=[&](const Morph& m,const Floats& values,double count){Json event={"morph",m.id};for(std::size_t i=0;i<static_cast<std::size_t>(count);++i)event.push_back(std::bit_cast<std::uint32_t>(values.at(i)));events.push_back(event);};
auto uploadBones=[&](const Skeleton& s,const Floats& values,double width){Json event={"bones",s.id,width*16,width};for(float v:values)event.push_back(std::bit_cast<std::uint32_t>(v));events.push_back(event);};
evaluate(state,.25,input.at("upload").get<bool>(),sample,compose,multiply,morph,overrides,pointer,translation,rotation,scale,uploadMorph,uploadBones);
Json morphs=Json::array(),bones=Json::array();for(const auto& m:state.morphs)morphs.push_back(bits(m.weights));for(const auto& b:state.bone_scratch)bones.push_back(bits(b));
return {{"events",events},{"trs",bits(state.currentTRS)},{"local",bits(state.localMat)},{"world",bits(state.worldMat)},{"pointer",bits(*state.pointerScratch)},{"morphScratch",bits(*state.morphUploadF32)},{"morphs",morphs},{"bones",bones}};}
${variants.map((context,index)=>`namespace variant_${index}{${lowerGltfAnimationPose(context)}}`).join("\n")}
int main(){Json cases;std::ifstream("cases.json")>>cases;
${variants.map((_context,index)=>`for(const auto& row:cases.at(${index})){const auto actual=run(row,[](auto&&... args){variant_${index}::gltf_evaluate_animation_pose(args...);});if(actual!=row.at("expected")){std::ofstream("actual.json")<<actual.dump(2);std::ofstream("expected.json")<<row.at("expected").dump(2);return ${index+1};}}`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${exe}`,"/I","native/include","/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(exe,{cwd:directory,encoding:"utf8"}),"");
});
