import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerAnimationGroupRegistration} from "../src/lowering/gltf/animation-group-registration.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/animation/animation-group-task.ts";
function contexts(): LoweringContext[] {
    return [new LoweringContext(),
        doctoredContext(module, "if (owner === manager)", "if (owner !== manager)"),
        doctoredContext(module, "is already attached to another AnimationManager", "belongs to a different manager"),
    ];
}
function sourceResult(context: LoweringContext): unknown {
    type Group = {name: string; _animationManager?: Manager};
    type Manager = {_animationGroups: Group[]};
    const body = ["getMutableAnimationGroups", "addAnimationGroup"].map(name => context.functionDeclaration(module, name).declaration.getText()).join("\n");
    const add = new Function("exports", "createAnimationTask", "addAnimationTask", "ANIMATION_GROUP_TASK_CATEGORY",
        transpileCommonJs(body, module) + "\nreturn addAnimationGroup;")({}, () => ({}), () => {}, "animation-group") as (manager: Manager, group: Group) => void;
    const managers: Manager[] = [{_animationGroups: []}, {_animationGroups: []}];
    const groups: Group[] = ["property A", "glTF B", "property C", "glTF D"].map(name => ({name}));
    const errors: string[] = [];
    for (const [manager, group] of [[0,0], [0,1], [0,2], [0,1], [1,1], [0,3], [1,3]]) {
        try {add(managers[manager!]!, groups[group!]!);} catch(error) {errors.push((error as Error).message);}
    }
    return {groups: managers.map(manager => manager._animationGroups.map(group => group.name)),
        owners: groups.map(group => managers.indexOf(group._animationManager!)), errors};
}

test("source animation registration preserves interleaving, duplicate no-op and ownership failure", () => {
    const variants = contexts(), results = variants.map(sourceResult);
    assert.deepEqual((results[0] as {groups: string[][]}).groups, [["property A", "glTF B", "property C", "glTF D"], []]);
    for (const result of results.slice(1)) assert.notDeepEqual(result, results[0]);
    for (const context of variants) assert.ok(lowerAnimationGroupRegistration(context));
    assert.throws(() => lowerAnimationGroupRegistration(doctoredContext(module,
        "getMutableAnimationGroups(manager).push(group)", "getMutableAnimationGroups(owner).push(group)")), /publication|changed/);
});

test("native group registration follows source registry order and ownership mutations", t => {
    const native = optionalNativeFixtureTools();
    if (!native) {t.skip("Native fixture compiler unavailable."); return;}
    const variants = contexts(), directory = resolve("artifacts/test-animation-group-registration"); mkdirSync(directory, {recursive:true});
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(variants.map(sourceResult)));
    writeFileSync(file, `#include <nlohmann/json.hpp>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
using Json = nlohmann::json;
struct PropertyAnimationManagerRecord {std::vector<std::string> groups;};
using PropertyAnimationManager=std::shared_ptr<PropertyAnimationManagerRecord>;
struct Group {std::string name; std::weak_ptr<PropertyAnimationManagerRecord> owner;};
${variants.map((context,index) => `namespace variant_${index} {
${lowerAnimationGroupRegistration(context)}
Json run() {
    const std::vector<PropertyAnimationManager> managers{std::make_shared<PropertyAnimationManagerRecord>(),std::make_shared<PropertyAnimationManagerRecord>()};
    std::vector<Group> groups{{"property A",{}},{"glTF B",{}},{"property C",{}},{"glTF D",{}}};
    Json errors=Json::array();
    for(const auto& pair:std::vector<std::pair<int,int>>{{0,0},{0,1},{0,2},{0,1},{1,1},{0,3},{1,3}}) {
        const auto& manager=managers.at(pair.first); auto& group=groups.at(pair.second);
        try {register_animation_group(manager,group.owner,group.name,[&]{manager->groups.push_back(group.name);});}
        catch(const std::runtime_error& error){errors.push_back(error.what());}
    }
    Json owners=Json::array(); for(const auto& group:groups){int owner=-1; for(int index=0;index<2;++index) if(group.owner.lock()==managers.at(index))owner=index; owners.push_back(owner);}
    return {{"groups",Json::array({managers.at(0)->groups,managers.at(1)->groups})},{"owners",owners},{"errors",errors}};
}
}`).join("\n")}
int main(){Json expected; std::ifstream("cases.json")>>expected;
${variants.map((_,index) => `if(variant_${index}::run()!=expected.at(${index}))return ${index+1};`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${executable}`,"/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
