import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {gltfAnimationLoadingCpp,gltfAnimationPoseTransportCpp} from "../src/lowering/gltf/animation-runtime.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {cppFunction,nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

interface Resource {weights:number[]; bone:number}
interface Mesh {name:string;children:Mesh[];_gpu:object;skeleton:Resource;morphTargets:Resource;
    position:{x:number;y:number;z:number};scaling:{x:number;y:number;z:number};
    rotationQuaternion:{x:number;y:number;z:number;w:number;set(...values:number[]):void}}
const scenarios=[
    {sharedMorph:false,clones:[0,2,1,3]},
    {sharedMorph:true,clones:[0,1,2,4]},
];
function sourceResults():unknown[] {
    const context=new LoweringContext(),module="src/scene/transform-node.ts";
    const body=context.functionDeclaration(module,"cloneMeshNode").declaration.getText();
    const clone=new Function("initMeshTransform","retain",transpileCommonJs(body,module)+"\nreturn cloneMeshNode;")(
        (value:Mesh)=>({...value,rotationQuaternion:{...value.rotationQuaternion,set(){}}}),()=>{}) as (value:Mesh)=>Mesh;
    return scenarios.map(scenario=>{
        const skeleton:Resource={weights:[],bone:1};
        const morphs:Resource[]=[{weights:[.25,.5],bone:0},{weights:[.75,.125],bone:0}];
        const meshes:Mesh[]=[0,1].map(index=>({name:`source${index}`,children:[],_gpu:{},skeleton,
            morphTargets:morphs[scenario.sharedMorph?0:index]!,position:{x:0,y:0,z:0},scaling:{x:1,y:1,z:1},
            rotationQuaternion:{x:0,y:0,z:0,w:1,set(){}}}));
        const observations:unknown[]=[];
        const snapshot=()=>meshes.map(mesh=>({weights:mesh.morphTargets.weights,bone:mesh.skeleton.bone}));
        observations.push(snapshot());
        for(const source of scenario.clones) {
            meshes.push(clone(meshes[source]!));
            skeleton.bone+=2;
            morphs[0]!.weights=morphs[0]!.weights.map(value=>Math.fround(value+.125));
            morphs[1]!.weights=morphs[1]!.weights.map(value=>Math.fround(value-.0625));
            observations.push(snapshot());
        }
        return observations;
    });
}

test("skinned morph clones follow the source's shared skeleton and morph resource identities",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const directory=resolve("artifacts/test-gltf-animation-clone");mkdirSync(directory,{recursive:true});
    const file=resolve(directory,"check.cpp"),executable=resolve(directory,"check.exe");
    writeFileSync(resolve(directory,"cases.json"),JSON.stringify({scenarios,expected:sourceResults()}));
    const loading=gltfAnimationLoadingCpp({},"{}"),pose=gltfAnimationPoseTransportCpp({},"");
    const clone=cppFunction(loading,"asset.clone_mesh_animation=");
    const uploadMorph=cppFunction(pose,"[&](auto& morph,const auto& values,double count)");
    writeFileSync(file,`#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
using Json=nlohmann::json;
namespace bbl {
struct Binding {std::uint32_t mesh=0;std::size_t skin=0,geometry=0,skeleton_binding=0;std::vector<float> morph_default_weights;};
struct Resource {std::vector<std::size_t> meshes;};
struct Rows {std::vector<std::shared_ptr<Resource>> entries;std::size_t size()const{return entries.size();}Resource& at(std::size_t index){return *entries.at(index);}};
struct AnimationRuntime {std::vector<Binding> meshes;Rows source_skeletons,source_morphs;};
Json run(const Json& scenarios) {
    Json result=Json::array();
    for(const auto& scenario:scenarios) {
        Engine engine;engine.meshes.resize(2);engine.geometries.resize(1);AssetRecord asset;
        auto animation_runtime=std::make_shared<AnimationRuntime>();
        animation_runtime->source_skeletons.entries.push_back(std::make_shared<Resource>(Resource{{0,1}}));
        animation_runtime->source_morphs.entries.push_back(std::make_shared<Resource>());
        animation_runtime->source_morphs.entries.push_back(std::make_shared<Resource>());
        std::vector<std::vector<float>> weights{{.25f,.5f},{.75f,.125f}};
        for(std::size_t index=0;index<2;++index) {
            const auto resource=scenario.at("sharedMorph").get<bool>()?0u:index;
            animation_runtime->meshes.push_back(Binding{static_cast<std::uint32_t>(index),0,0,0,weights[resource]});
            animation_runtime->source_morphs.at(resource).meshes.push_back(index);
        }
        ${clone};
        const auto upload_morph=${uploadMorph};
        int bone=1;Json observations=Json::array();
        const auto snapshot=[&]{Json rows=Json::array();for(const auto& binding:animation_runtime->meshes) {
            const auto& subscribers=animation_runtime->source_skeletons.at(0).meshes;
            const auto found=std::find(subscribers.begin(),subscribers.end(),static_cast<std::size_t>(binding.mesh));
            rows.push_back({{"weights",binding.morph_default_weights},{"bone",found!=subscribers.end()?bone:1}});
        }return rows;};
        observations.push_back(snapshot());
        for(const auto& source:scenario.at("clones")) {
            const auto source_index=source.get<std::uint32_t>();const auto clone_index=static_cast<std::uint32_t>(engine.meshes.size());
            engine.meshes.push_back(engine.meshes.at(source_index));
            asset.clone_mesh_animation(MeshHandle{source_index},MeshHandle{clone_index});
            bone+=2;
            for(std::size_t resource=0;resource<2;++resource) {
                for(auto& value:weights[resource])value+=resource==0?.125f:-.0625f;
                upload_morph(animation_runtime->source_morphs.at(resource),weights[resource],2.0);
            }
            observations.push_back(snapshot());
        }
        result.push_back(observations);
    }
    return result;
}
}
int main(){Json cases;std::ifstream("cases.json")>>cases;const auto actual=bbl::run(cases.at("scenarios"));
    if(actual!=cases.at("expected")){std::cerr<<actual.dump(2);return 1;}}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",
        `/Fo:${directory}/`,`/Fe:${executable}`,"/I","native/include","/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8",stdio:"pipe"}),"");
});
