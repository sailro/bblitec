import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerAnimationManagerDispatch} from "../src/lowering/animation-manager-dispatch.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";
const module="src/animation/animation-manager.ts";
function contexts():LoweringContext[]{
    const base=new LoweringContext(),{file,declaration}=base.functionDeclaration(module,"updateAnimationManager");
    const body=declaration.body!.statements;
    assert.ok(ts.isVariableStatement(body[4]!));
    const earlySnapshot=[body[0],body[1],body[4],body[2],body[3],body[5]].map(statement=>statement!.getText(file)).join("\n");
    const changed=file.text.slice(0,declaration.body!.getStart(file))+"{\n"+earlySnapshot+"\n}"+file.text.slice(declaration.body!.end);
    return [base,doctoredContext(module,file.text,changed),doctoredContext(module,"task._category === handledCategory","task._category !== handledCategory")];
}
function sourceResult(context:LoweringContext):unknown{
    const source=context.functionDeclaration(module,"updateAnimationManager").declaration.getText();
    const run=new Function("exports",transpileCommonJs(source+`
return [false,true].map(handled=>{
    const events=[];const manager={fixedDeltaMs:0,animations:[],_taskCategory:"animation-group"};
    const make=(id)=>({id,active:true,_category:"animation-group",_update:(_owner,step)=>{events.push(["tick",id,step]);if(id===0)manager.animations.push(make(4));}});
    manager.animations=[make(0),make(1)];
    manager._preUpdate=(_owner,step)=>{events.push(["pre",step]);manager.animations.push(make(2));};
    manager._taskCategoryHandler=(_owner,step)=>{events.push(["handler",step]);manager.animations.push(make(3));return handled;};
    updateAnimationManager(manager,20);return {events,groups:manager.animations.map(task=>task.id)};
});`,module));return run({});
}
test("source manager snapshots tasks after pre-update and category callbacks",()=>{
    const variants=contexts(),results=variants.map(sourceResult);for(const result of results.slice(1))assert.notDeepEqual(result,results[0]);
    for(const context of variants)assert.ok(lowerAnimationManagerDispatch(context));
    assert.throws(()=>lowerAnimationManagerDispatch(doctoredContext(module,"manager.animations.slice()","manager.animations")),/Unsupported/);
});
test("native manager dispatch preserves source callback order and snapshot mutations",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const variants=contexts(),directory=resolve("artifacts/test-animation-manager-dispatch");mkdirSync(directory,{recursive:true});
    const file=resolve(directory,"check.cpp"),executable=resolve(directory,"check.exe");writeFileSync(resolve(directory,"cases.json"),JSON.stringify(variants.map(sourceResult)));
    writeFileSync(file,`#include <nlohmann/json.hpp>
#include <cstdint>
#include <fstream>
#include <vector>
using Json=nlohmann::json;
struct Manager{std::vector<int> ordered_groups{0,1};};
${variants.map((context,index)=>`namespace variant_${index}{
${lowerAnimationManagerDispatch(context)}
Json run(){Json output=Json::array();for(bool handled:{false,true}){
    Manager manager;Json events=Json::array();
    dispatch_animation_manager_groups(manager,20,[&]{events.push_back({"pre",20});manager.ordered_groups.push_back(2);},
        [&]{events.push_back({"handler",20});manager.ordered_groups.push_back(3);return handled;},
        [&](int id,double step){events.push_back({"tick",id,step});if(id==0)manager.ordered_groups.push_back(4);});
    output.push_back({{"events",events},{"groups",manager.ordered_groups}});
}return output;}
}`).join("\n")}
int main(){Json expected;std::ifstream("cases.json")>>expected;
${variants.map((_,index)=>`if(variant_${index}::run()!=expected.at(${index}))return ${index+1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${executable}`,"/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
