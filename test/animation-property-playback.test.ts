import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerPropertyAnimationPlayback} from "../src/lowering/animation-property-playback.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";
const propertyModule="src/animation/property-animation.ts",groupModule="src/animation/animation-group.ts";
function contexts():LoweringContext[]{return [new LoweringContext(),
    doctoredContext(propertyModule,"ctrl.time += (deltaMs / 1000) * ctrl.speedRatio;","ctrl.time += (deltaMs / 500) * ctrl.speedRatio;"),
    doctoredContext(propertyModule,"if (ctrl.loop && ctrl.playing)","if (ctrl.loop)"),
    doctoredContext(groupModule,"group._stopped = true;","group._stopped = false;")];}
function sourceResult(context:LoweringContext):unknown{
    const source=context.functionDeclaration(propertyModule,"createPointerAnimationGroup").declaration.getText()+"\n"+
        ["playAnimation","pauseAnimation","stopAnimation","syncControllerFromGroup","tickAnimationCore"].map(name=>context.functionDeclaration(groupModule,name).declaration.getText()).join("\n");
    const run=new Function("exports","_pointerScratch","_installTickAnimation","DEFAULT_FRAME_RATE","evaluateSampler",transpileCommonJs(source+`
const output=[],events=[];
const group=createPointerAnimationGroup("property",2.5,60,[{sampler:{},stride:1,quaternion:false,mixTarget:{},mixProperty:"x",writer:(sample)=>events.push([group.currentTime,sample[0]])}],0.5,2.5,{});
const tick=(delta)=>{tickAnimationCore(group,delta,{});output.push({time:group.currentTime,playing:group.isPlaying,stopped:group._stopped,events:events.splice(0)});};
playAnimation(group);tick(250);pauseAnimation(group);group.currentTime=5;tick(100);
stopAnimation(group);tick(250);playAnimation(group);tick(-500);
return output;`,propertyModule));
    return run({},new Float32Array(16),()=>{},60,(_sampler:unknown,time:number,_stride:number,_quat:boolean,out:Float32Array)=>{out[0]=time;});
}
test("property source tick distinguishes paused pose publication from stopped tasks",()=>{
    const variants=contexts(),results=variants.map(sourceResult);
    for(const result of results.slice(1))assert.notDeepEqual(result,results[0]);
    for(const context of variants)assert.ok(lowerPropertyAnimationPlayback(context));
});
test("native property playback follows source clock, stopped writes and publication order",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const variants=contexts(),directory=resolve("artifacts/test-animation-property-playback");mkdirSync(directory,{recursive:true});
    const file=resolve(directory,"check.cpp"),executable=resolve(directory,"check.exe");writeFileSync(resolve(directory,"cases.json"),JSON.stringify(variants.map(sourceResult)));
    writeFileSync(file,`#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <fstream>
using Json=nlohmann::json;
struct Group{float current_time=0.5f,from_time=0.5f,to_time=2.5f,speed_ratio=1;bool playing=false,stopped=false,loop=true;};
${variants.map((context,index)=>`namespace variant_${index}{
${lowerPropertyAnimationPlayback(context)}
Json run(){Group group;Json output=Json::array(),events=Json::array();
    const auto tick=[&](double delta){tick_property_animation_group(group,delta,[&](double time){events.push_back({group.current_time,static_cast<float>(time)});});output.push_back({{"time",group.current_time},{"playing",group.playing},{"stopped",group.stopped},{"events",events}});events.clear();};
    property_playAnimation(group);tick(250);property_pauseAnimation(group);group.current_time=5;tick(100);
    property_stopAnimation(group);tick(250);property_playAnimation(group);tick(-500);return output;
}
}`).join("\n")}
int main(){Json expected;std::ifstream("cases.json")>>expected;
${variants.map((_,index)=>`if(variant_${index}::run()!=expected.at(${index}))return ${index+1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${executable}`,"/I",resolve("native/include"),"/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
