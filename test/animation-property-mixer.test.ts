import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const module = "src/animation/weighted-pointer-mixer.ts";
function contexts(): LoweringContext[] {
    return [
        new LoweringContext(),
        doctoredContext(module, "contestedCount === 0", "contestedCount >= 0"),
        doctoredContext(module, "deltaMs / 1000", "deltaMs / 500"),
        doctoredContext(module, "if (weight === 0)", "if (weight === 0.5)"),
    ];
}
function sourceResult(context: LoweringContext): unknown {
    const modules = [
        "src/animation/evaluate.ts",
        "src/animation/property-animation.ts",
        module,
    ];
    const body =
        modules
            .map((name) => {
                const file = context.sourceFile(name);
                return file.statements
                    .filter((statement) => !ts.isImportDeclaration(statement))
                    .map((statement) => statement.getText(file))
                    .join("\n");
            })
            .join("\n") +
        "\n" +
        ["playAnimation", "syncControllerFromGroup", "tickAnimationCore"]
            .map((name) =>
                context
                    .functionDeclaration(
                        "src/animation/animation-group.ts",
                        name,
                    )
                    .declaration.getText(),
            )
            .join("\n");
    return createJavaScriptFunction(
        "exports",
        "F32",
        "INTERP_STEP",
        "INTERP_LINEAR",
        "INTERP_CUBICSPLINE",
        transpileCommonJs(
            `
const _installTickAnimation=()=>{};
const addAnimationGroup=(manager,group)=>manager.groups.push(group);
const getAnimationGroups=manager=>manager.groups;
${body}
const manager={groups:[]},events=[],result=[];
const first={set value(value){events.push([0,value]);}},second={set value(value){events.push([1,value]);}};
for(let index=0;index<3;index++){
 const clip=createPropertyAnimationClip("clip",[{path:"value",keys:[{time:0,value:index+2},{time:1,value:(index+2)*2}]}]);
 const group=createPropertyAnimationGroup(manager,index<2?first:second,clip,{fromTime:0.25,toTime:1,loop:false});group.weight=index===0?0.5:1;
}
for(const delta of [250,500,1000]){
 if(!_updateWeightedPointerAnimations(manager,delta))for(const group of manager.groups)tickAnimationCore(group,delta);
 result.push({events:events.splice(0),groups:manager.groups.map(group=>[group.currentTime,group.isPlaying,group._stopped])});
}
return result;`,
            module,
        ),
    )({}, Float32Array, 1, 0, 2);
}

test("weighted property traversal follows source early-out, clock and weight mutations natively", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const variants = contexts(),
        expected = variants.map(sourceResult);
    for (const variant of expected.slice(1))
        assert.notDeepEqual(variant, expected[0]);
    const directory = resolve("artifacts/test-animation-property-mixer");
    mkdirSync(directory, { recursive: true });
    for (const [index, context] of variants.entries()) {
        const source = resolve(directory, `animation-${index}.cpp`),
            file = resolve(directory, "check.cpp"),
            exe = resolve(directory, `check-${index}.exe`);
        writeFileSync(
            source,
            new AnimationLowerer(context).lowerPropertyAnimation({
                blending: true,
            }).source,
        );
        writeFileSync(
            resolve(directory, "cases.json"),
            JSON.stringify(expected[index]),
        );
        writeFileSync(
            file,
            `#include <bblite/runtime.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
namespace bbl {void mark_mesh_dirty(Engine&,MeshHandle){}}
using Json=nlohmann::json;
int main(){using namespace bbl;Engine engine;auto manager=create_animation_manager(engine);enable_property_animation_blending(manager);Json result=Json::array(),events=Json::array();int identities[2]{};
 for(int index=0;index<3;++index){const float value=static_cast<float>(index+2);const auto clip=create_property_animation_clip("clip",{{PropertyAnimationPath::record_scalar,PropertyAnimationComponent::whole_lane,PropertyAnimationInterpolation::linear,false,{{0,{value}},{1,{value*2}}}}},60);
 PropertyAnimationTarget target;target.kind=PropertyAnimationTargetKind::callback;target.object_identity=&identities[index<2?0:1];target.property="value";target.write_scalar=[&,id=index<2?0:1](float sample){events.push_back({id,sample});};auto group=create_property_animation_group(manager,engine,{target},clip,{0.25,1,1,false});set_animation_weight(group,index==0?0.5:1);}
 for(double delta:{250.0,500.0,1000.0}){update_animation_manager(manager,engine,delta);Json groups=Json::array();for(const auto& group:manager->groups)groups.push_back({group->current_time,group->playing,group->stopped});result.push_back({{"events",events},{"groups",groups}});events.clear();}
 Json expected;std::ifstream("cases.json")>>expected;if(result!=expected){std::ofstream("actual.json")<<result.dump(2);return 1;}
}`,
        );
        runNativeFixtureCompiler(native, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            "/O2",
            "/Gy",
            `/Fo:${directory}/`,
            `/Fe:${exe}`,
            "/I",
            resolve("native/include"),
            "/I",
            resolve(nativeFixtureVcpkgRoot, "include"),
            source,
            file,
            "/link",
            "/OPT:REF",
        ]);
        assert.equal(
            execFileSync(exe, { cwd: directory, encoding: "utf8" }),
            "",
        );
    }
});
