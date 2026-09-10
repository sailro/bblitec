import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {AnimationLowerer} from "../src/lowering/animation-lowerer.js";
import {LoweringContext} from "../src/lowering/context.js";
import {nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

async function sourceResult():Promise<unknown>{
    const pin=await import("@babylonjs/lite");
    return [false,true].map(blending=>{
        const manager=pin.createAnimationManager(),events:Array<[number,number]>=[];
        const clip=pin.createPropertyAnimationClip("value",[{path:"value",keys:[{time:0,value:0},{time:1,value:8}]}]);
        let added=false;
        const add=(id:number)=>{
            let value=0;
            const target={get value(){return value;},set value(next:number){value=next;events.push([id,next]);
                if(id===1&&!added){added=true;for(let child=2;child<22;child++)add(child);}}};
            return pin.createPropertyAnimationGroup(manager,target,clip,{loop:false});
        };
        const first=add(0);add(1);if(blending){pin.enablePropertyAnimationBlending(manager);pin.setAnimationWeight(first,0.5);}
        pin.updateAnimationManager(manager,250);const a=events.splice(0);pin.updateAnimationManager(manager,250);
        return [a,events];
    });
}
test("native manager keeps registered group identities during callback growth and preserves source engine absence",async t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const directory=resolve("artifacts/test-animation-manager-membership");mkdirSync(directory,{recursive:true});
    const source=resolve(directory,"animation.cpp"),file=resolve(directory,"check.cpp"),executable=resolve(directory,"check.exe");
    writeFileSync(source,new AnimationLowerer(new LoweringContext()).lowerPropertyAnimation({blending:true,managedGroups:true,gltfLoaderAvailable:false}).source);
    writeFileSync(resolve(directory,"cases.json"),JSON.stringify(await sourceResult()));
    writeFileSync(file,`#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <functional>
using Json=nlohmann::json;
namespace bbl {void mark_mesh_runtime_transform(Engine&,MeshHandle){}}
int main(){using namespace bbl;Engine engine;Json expected;std::ifstream("cases.json")>>expected;Json actual=Json::array();
    for(bool blending:{false,true}){
        auto manager=create_animation_manager(engine);Json events=Json::array();bool added=false;
        const auto clip=create_property_animation_clip("value",{{PropertyAnimationPath::record_scalar,PropertyAnimationComponent::whole_lane,PropertyAnimationInterpolation::linear,false,{{0,{0}},{1,{8}}}}},60);
        std::vector<std::shared_ptr<float>> owners;
        std::function<PropertyAnimationGroup(int)> add=[&](int id){
            auto owner=std::make_shared<float>(0.0f);owners.push_back(owner);
            PropertyAnimationTarget target;target.kind=PropertyAnimationTargetKind::callback;target.object_identity=owner.get();target.property="value";
            target.write_scalar=[&,owner,id](float value){*owner=value;events.push_back({id,value});if(id==1&&!added){added=true;for(int child=2;child<22;++child)add(child);}};
            return create_property_animation_group(manager,engine,{target},clip,{0,1,1,false});
        };
        const auto first=add(0);add(1);if(blending){enable_property_animation_blending(manager);set_animation_weight(first,0.5f);}
        update_animation_manager(manager,engine,250);Json a=events;events.clear();update_animation_manager(manager,engine,250);actual.push_back(Json::array({a,events}));
    }
    if(actual!=expected){std::ofstream("actual.json")<<actual;return 1;}
    const auto absent=create_animation_manager();const auto inferred=create_animation_manager(engine,{.source_engine_present=false});const auto explicit_engine=create_animation_manager(engine);
    if(absent->source_engine_present||inferred->source_engine_present||!explicit_engine->source_engine_present)return 2;
    engine.assets.emplace_back();std::vector<bool> engine_flags;
    engine.assets[0].animation_tick_group=[&](std::size_t,double,bool with_engine){engine_flags.push_back(with_engine);};
    for(const auto& manager:{absent,inferred,explicit_engine}){
        const auto index=static_cast<std::uint32_t>(engine.animation_groups.size());engine.animation_groups.push_back({"gltf",0,index,1,{}});
        add_animation_groups(manager,engine,{{index}});add_animation_groups(manager,engine,{{index}});
        update_animation_manager(manager,engine,1);
        if(manager->ordered_groups.size()!=1)return 3;
    }
    if(engine_flags!=std::vector<bool>{false,false,true})return 4;
    try{add_animation_groups(explicit_engine,engine,{{0}});return 5;}catch(const std::runtime_error& error){if(std::string(error.what())!=${JSON.stringify('AnimationGroup "gltf" is already attached to another AnimationManager')})return 6;}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2","/Gy",`/Fo:${directory}/`,`/Fe:${executable}`,"/I",resolve("native/include"),"/I",resolve(nativeFixtureVcpkgRoot,"include"),source,file,"/link","/OPT:REF"]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
