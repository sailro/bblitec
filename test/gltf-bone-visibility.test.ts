import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerBoneControl} from "../src/lowering/gltf/bone-control.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const module = "src/skeleton/bone-control.ts";
test("bone visibility stores and eager-bake calls follow the complete source setter", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const variants = [new LoweringContext(), doctoredContext(module, "if (!visible)", "if (visible)"),
        doctoredContext(module, "if (o && o.mask & 8)", "if (o && !(o.mask & 8))")];
    const actions = [true, false, false, true, true, false, true];
    const cases = variants.map(context => {
        const source = ["ensureOverride", "setBoneVisible"].map(name =>
            context.functionDeclaration(module, name).declaration.getText().replace(/^export /, "")).join("\n");
        const run = new Function(transpileCommonJs(source, module) + "\nreturn setBoneVisible;")() as (skeleton: object, bone: object, visible: boolean) => void;
        let bakes = 0;
        const overrides = new Map<number, {mask: number}>(), skeleton = {_overrides: overrides, _bake: () => ++bakes};
        return actions.map(visible => {run(skeleton, {_nodeIndex: 0}, visible); return {mask: overrides.get(0)?.mask ?? 0, bakes};});
    });
    const directory = resolve("artifacts/test-gltf-bone-visibility"); mkdirSync(directory, {recursive: true});
    writeFileSync(resolve(directory, "cases.json"), JSON.stringify(cases));
    const file = resolve(directory, "check.cpp"), executable = resolve(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
using namespace bbl;
using Json=nlohmann::json;
${variants.map((context,index)=>`namespace variant_${index} {${lowerBoneControl(context).entryPoints}}`).join("\n")}
template<class Set> void check(const Json& expected,Set set){Engine engine;engine.assets.emplace_back().bone_overrides.resize(1);engine.bones.emplace_back().node_index=0;engine.skeletons.emplace_back().asset=0;
    int bakes=0;engine.assets[0].bake_skeletons=[&]{++bakes;};std::size_t index=0;
    for(bool visible:std::vector<bool>{${actions.join(",")}}){set(engine,SkeletonHandle{0},BoneHandle{0},visible);
        const Json actual={{"mask",engine.assets[0].bone_overrides[0].mask},{"bakes",bakes}};
        if(actual!=expected.at(index++))throw std::runtime_error(actual.dump());}
}
int main(){Json cases;std::ifstream("cases.json")>>cases;
${variants.map((_context,index)=>`check(cases.at(${index}),variant_${index}::set_bone_visible);`).join("\n")}
}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${executable}`,"/I","native/include","/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(executable,{cwd:directory,encoding:"utf8"}),"");
});
