import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfWeightedAnimationTargets} from "../src/lowering/gltf/weighted-animation-targets.js";
import {gltfWeightedAnimationTransportCpp} from "../src/lowering/gltf/weighted-animation-transport.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {cppFunction,cppRecord,nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";
const module="src/animation/weighted-gltf-mixer.ts";
function contexts():LoweringContext[]{
    const base=new LoweringContext(),file=base.sourceFile(module);
    const moved=file.text.replace("scratch.targets.set(nodes, target);","").replace("resetWeightedGltfTarget(target);","resetWeightedGltfTarget(target); scratch.targets.set(nodes, target);");
    return [base,doctoredContext(module,"sample: new F32(16)","sample: new F32(20)"),
        doctoredContext(module,"order[cursor++] = idx;","order[cursor++] = idx + 1;"),
        doctoredContext(module,file.text,moved)];
}
interface Node {parentIdx:number}
interface Target {nodes:Node[];skeletons:unknown[];overrides:{id:number}|undefined;baseRot:Float32Array|undefined;trs:Float32Array;localMat:Float32Array;worldMat:Float32Array;topoOrder:Int32Array;tWeight:Float32Array;rWeight:Float32Array;sWeight:Float32Array;active:boolean}
interface Scratch {keys:Set<object>;targets:Map<object,Target>;sample:Float32Array;reference:Float32Array;delta:Float32Array}
function sourceResult(context:LoweringContext):unknown{
    let scratch:Scratch;let fail=true;const events:unknown[]=[];
    const reset=(target:Target)=>{events.push(["reset",scratch.targets.has(target.nodes)]);if(fail){fail=false;throw Error("reset failed");}};
    const source="let scratchByManager;\n"+["getScratch","getTarget","computeTopoOrder"].map(name=>context.functionDeclaration(module,name).declaration.getText()).join("\n");
    const api=new Function("F32","I32","U8","GLTF_NODES","GLTF_SKELETONS","TRS_STRIDE","resetWeightedGltfTarget",transpileCommonJs(source,module)+"\nreturn {getScratch,getTarget};")(
        Float32Array,Int32Array,Uint8Array,1,2,12,reset) as {getScratch(manager:object):Scratch;getTarget(scratch:Scratch,mixer:unknown[]):Target};
    const manager={};scratch=api.getScratch(manager);scratch.sample[0]=99;
    const nodesA:Node[]=[{parentIdx:1},{parentIdx:-1},{parentIdx:1}],nodesB:Node[]=[{parentIdx:-1},{parentIdx:0}];
    const mixerA=[{},nodesA,[{runtimeSkeleton:{_overrides:{id:1}}}]],mixerSecond=[{},nodesA,[{runtimeSkeleton:{_overrides:{id:2}}}]],mixerB=[{},nodesB,[]];
    try{api.getTarget(scratch,mixerA);}catch(error){events.push((error as Error).message);}
    const first=api.getTarget(scratch,mixerA),again=api.getTarget(scratch,mixerSecond),second=api.getTarget(scratch,mixerB);
    const row=(target:Target)=>({key:target.nodes===nodesA?0:1,overrides:target.overrides?.id??null,baseRot:target.baseRot?.length??null,
        lengths:[target.trs.length,target.localMat.length,target.worldMat.length,target.tWeight.length,target.rWeight.length,target.sWeight.length],
        topology:[...target.topoOrder],active:target.active,zero:[target.trs,target.localMat,target.worldMat,target.tWeight,target.rWeight,target.sWeight].every(values=>values.every(value=>value===0))});
    return {events,same:first===again,distinct:first!==second,scratchSame:scratch===api.getScratch(manager),
        scratchLengths:[scratch.sample.length,scratch.reference.length,scratch.delta.length],sample:scratch.sample[0],targets:[...scratch.targets.values()].map(row)};
}
test("source weighted target cache retains identity, allocation widths and publication on reset failure",()=>{
    const variants=contexts(),outputs=variants.map(sourceResult);
    for(const output of outputs.slice(1))assert.notDeepEqual(output,outputs[0]);
    for(const context of variants)assert.ok(lowerGltfWeightedAnimationTargets(context));
    assert.throws(()=>lowerGltfWeightedAnimationTargets(doctoredContext(module,"scratch.targets.get(nodes)","scratch.targets.get(skeletons)")),/identity|Unsupported/);
});
test("native weighted target allocation follows source mutations and failed initial reset",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const variants=contexts(),directory=resolve("artifacts/test-gltf-weighted-animation-targets");mkdirSync(directory,{recursive:true});
    const file=resolve(directory,"check.cpp"),executable=resolve(directory,"check.exe");writeFileSync(resolve(directory,"cases.json"),JSON.stringify(variants.map(sourceResult)));
    const transport=gltfWeightedAnimationTransportCpp("{}");
    writeFileSync(file,`#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <vector>
#include <unordered_map>
using Json=nlohmann::json;
struct Node {double parentIdx;};
struct Override {int id;};
struct Skeleton {std::shared_ptr<Override> overrides;};
struct Target {const std::vector<Node>* nodes;std::vector<Skeleton> skeletons;std::shared_ptr<Override> overrides;std::optional<std::vector<float>> baseRot;std::vector<float> trs,localMat,worldMat;std::vector<std::int32_t> topoOrder;std::vector<float> tWeight,rWeight,sWeight;bool active;};
using GltfWeightedNodes=std::vector<Node>;
using GltfWeightedTarget=Target;
using GltfAnimationFloats=std::vector<float>;
${cppRecord(transport.types,"struct GltfWeightedScratch")}
using Scratch=GltfWeightedScratch;
struct Mixer {const std::vector<Node>* nodes;std::vector<Skeleton> skeletons;};
struct Transport {
    Scratch& scratch;decltype(scratch.targets)& targets;bool fail=true;Json events=Json::array();
    const auto& nodes(const Mixer& mixer){return *mixer.nodes;}
    const auto& skeletons(const Mixer& mixer){return mixer.skeletons;}
    auto overrides(const Skeleton& skeleton){return skeleton.overrides;}
    ${cppFunction(transport.dispatcher,"std::shared_ptr<GltfWeightedTarget> lookup(")}
    ${cppFunction(transport.dispatcher,"void publish(")}
    auto create_target(const std::vector<Node>& nodes,const std::vector<Skeleton>& skeletons,std::shared_ptr<Override> overrides,std::optional<std::vector<float>> baseRot,std::vector<float> trs,std::vector<float> localMat,std::vector<float> worldMat,std::vector<std::int32_t> topoOrder,std::vector<float> tWeight,std::vector<float> rWeight,std::vector<float> sWeight,bool active){
        return std::make_shared<Target>(Target{&nodes,skeletons,std::move(overrides),std::move(baseRot),std::move(trs),std::move(localMat),std::move(worldMat),std::move(topoOrder),std::move(tWeight),std::move(rWeight),std::move(sWeight),active});
    }
    void reset_target(Target& target){events.push_back({"reset",bool(lookup(*target.nodes))});if(fail){fail=false;throw std::runtime_error("reset failed");}}
};
${variants.map((context,index)=>`namespace variant_${index}{
${lowerGltfWeightedAnimationTargets(context)}
Json run(){
    std::shared_ptr<Scratch> slot;auto& scratch=gltf_get_weighted_scratch(slot);scratch.sample.at(0)=99;
    const std::vector<Node> nodesA{{1},{-1},{1}},nodesB{{-1},{0}};
    const Mixer a{&nodesA,{{std::make_shared<Override>(Override{1})}}},again{&nodesA,{{std::make_shared<Override>(Override{2})}}},b{&nodesB,{}};
    Transport transport{scratch,scratch.targets};
    try{gltf_get_weighted_target(transport,a);}catch(const std::runtime_error& error){transport.events.push_back(error.what());}
    const auto& first=gltf_get_weighted_target(transport,a);const auto& repeated=gltf_get_weighted_target(transport,again);const auto& second=gltf_get_weighted_target(transport,b);
    Json targets=Json::array();
    for(const auto& [key,target]:scratch.targets){bool zero=true;for(const auto* values:{&target.trs,&target.localMat,&target.worldMat,&target.tWeight,&target.rWeight,&target.sWeight})for(float value:*values)zero=zero&&value==0;
        targets.push_back({{"key",key==&nodesA?0:1},{"overrides",target.overrides?Json(target.overrides->id):Json(nullptr)},{"baseRot",target.baseRot?Json(target.baseRot->size()):Json(nullptr)},
        {"lengths",{target.trs.size(),target.localMat.size(),target.worldMat.size(),target.tWeight.size(),target.rWeight.size(),target.sWeight.size()}},{"topology",target.topoOrder},{"active",target.active},{"zero",zero}});
    }
    return {{"events",transport.events},{"same",&first==&repeated},{"distinct",&first!=&second},{"scratchSame",&scratch==&gltf_get_weighted_scratch(slot)},
        {"scratchLengths",{scratch.sample.size(),scratch.reference.size(),scratch.delta.size()}},{"sample",scratch.sample.at(0)},{"targets",targets}};
}
}`).join("\n")}
int main(){Json expected;std::ifstream("cases.json")>>expected;
${variants.map((_,index)=>`if(variant_${index}::run()!=expected.at(${index}))return ${index+1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${executable}`,"/I",resolve("native/include"),"/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
