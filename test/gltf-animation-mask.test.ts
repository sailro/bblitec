import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {compileSource} from "../src/compiler.js";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAnimationMask} from "../src/lowering/gltf/animation-mask.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";
const maskModule="src/animation/animation-group-mask.ts",controllerModule="src/skeleton/skeleton-updater.ts";
function contexts():LoweringContext[]{return [new LoweringContext(),
    doctoredContext(maskModule,"(mask.names.indexOf(name) !== -1) === (mask.mode === AnimationGroupMaskMode.Include)","(mask.names.indexOf(name) !== -1) !== (mask.mode === AnimationGroupMaskMode.Include)"),
    doctoredContext(controllerModule,"names.length === cLen","names.length !== cLen"),
    doctoredContext(maskModule,"return { mode, names: names.slice(), disabled: false };","return { mode, names: names.slice(), disabled: true };"),
    doctoredContext(maskModule,"Include = 0,","Include = 2,")];}
function sourceResult(context:LoweringContext):unknown{
    const controller=context.functionDeclaration(controllerModule,"createAnimationController");
    const setter=context.variableInitializer(controller.declaration,"_setMask").getText();
    const source=context.findNodes(context.sourceFile(maskModule),ts.isEnumDeclaration)[0]!.getText()+"\n"+
        ["animationGroupMaskRetainsTarget","resolveAnimationMask","createAnimationGroupMask"].map(name=>context.functionDeclaration(maskModule,name).declaration.getText()).join("\n");
    const defaults=["maskedNodes","maskActive","cMask","cNames","cLen","cMode","cDisabled"].map(name=>`let ${name}=${context.variableInitializer(controller.declaration,name).getText()};`).join("\n");
    const run=new Function("exports","U8","_installAnimationMaskResolver",transpileCommonJs(source+`\n${defaults}
const nodeNames=["hip",undefined,"child"],numNodes=nodeNames.length;let _maskResolver=null;
const set=${setter};const mask=createAnimationGroupMask(["hip"],AnimationGroupMaskMode.Include);const result=[];
const tick=(value)=>{set(value);result.push({active:maskActive,flags:maskedNodes?[...maskedNodes]:null,length:cLen,mode:cMode,disabled:cDisabled});};
tick(null);tick(mask);_maskResolver=resolveAnimationMask;tick(mask);
mask.names[0]="child";tick(mask);mask.names.push("");tick(mask);
mask.disabled=true;tick(mask);mask.disabled=false;tick(mask);mask.mode=1;tick(mask);
tick(createAnimationGroupMask(["hip"],AnimationGroupMaskMode.Include));tick(null);return result;`,maskModule));
    return run({},Uint8Array,()=>{});
}
test("source controller masks retain cache identity and resolve source include/exclude membership",()=>{
    const variants=contexts(),results=variants.map(sourceResult);
    for(const output of results.slice(1))assert.notDeepEqual(output,results[0]);
    for(const context of variants)assert.ok(lowerGltfAnimationMask(context));
    assert.throws(()=>lowerGltfAnimationMask(doctoredContext(controllerModule,"_maskResolver(mask, nodeNames, maskedNodes, numNodes)","_maskResolver(mask, nodeNames, maskedNodes, 1)")),/arguments|changed/);
});
test("compiled animation masks refuse mutable names, mode and disabled state",()=>{
    for(const mutation of ['mask.names[0] = "child";','mask.names = ["child"];','mask.mode = 1;','mask.disabled = true;'])
        assert.throws(()=>compileSource('import {createAnimationGroupMask} from "@babylonjs/lite"; const mask=createAnimationGroupMask(["hip"]); '+mutation),/Only property assignments|Unsupported property assignment/);
});
test("native controller mask cache follows actual source and cache/membership mutations",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const variants=contexts(),directory=resolve("artifacts/test-gltf-animation-mask");mkdirSync(directory,{recursive:true});
    const file=resolve(directory,"check.cpp"),executable=resolve(directory,"check.exe");writeFileSync(resolve(directory,"cases.json"),JSON.stringify(variants.map(sourceResult)));
    writeFileSync(file,`#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstdint>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <vector>
using Json=nlohmann::json;
struct Mask{std::vector<std::string> names;double mode=0;bool disabled=false;};
struct Pose{std::vector<int> nodes=std::vector<int>(3);std::vector<std::uint8_t> masked_nodes;bool mask_active=false,mask_resolver=false;};
${variants.map((context,index)=>`namespace variant_${index}{
${lowerGltfAnimationMask(context)}
struct Group{std::shared_ptr<Mask> mask;std::shared_ptr<Pose> pose=std::make_shared<Pose>();GltfAnimationControllerMaskCache<Mask> mask_cache;};
Json run(){Group group;const std::vector<std::optional<std::string>> node_names{"hip",std::nullopt,"child"};auto mask=gltf_make_animation_mask<Mask>({"hip"},true);Json result=Json::array();
    const auto tick=[&](std::shared_ptr<Mask> value){group.mask=std::move(value);gltf_sync_animation_mask(group,node_names);result.push_back({{"active",group.pose->mask_active},{"flags",group.mask_cache.allocated?Json(group.pose->masked_nodes):Json(nullptr)},{"length",group.mask_cache.length},{"mode",group.mask_cache.mode},{"disabled",group.mask_cache.disabled}});};
    tick({});tick(mask);group.pose->mask_resolver=true;tick(mask);
    mask->names.at(0)="child";tick(mask);mask->names.push_back("");tick(mask);
    mask->disabled=true;tick(mask);mask->disabled=false;tick(mask);mask->mode=1;tick(mask);
    tick(gltf_make_animation_mask<Mask>({"hip"},true));tick({});return result;
}
}`).join("\n")}
int main(){Json expected;std::ifstream("cases.json")>>expected;
${variants.map((_,index)=>`if(variant_${index}::run()!=expected.at(${index}))return ${index+1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${executable}`,"/I",resolve("native/include"),"/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
