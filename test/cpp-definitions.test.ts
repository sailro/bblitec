import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pinnedEffectVariantsHeader } from "../src/pinned-effect-cpp.js";
import {composeNodeMaterial} from "../src/pinned-node-material.js";
import {nodeVariantStageStems} from "../src/pinned-node-material-cpp.js";
import {executeModuleGraph} from "../src/executed-module-graph.js";
import {emitUpstreamGenerated, type UpstreamEmitOptions} from "../src/upstream-lower.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("effect declarations stay identical across scene data and link from separate sources", (t) => {
    const first = pinnedEffectVariantsHeader("fixture", [
        { family: "effect", name: "first", fragment: "", bindings: [] },
    ]);
    const second = pinnedEffectVariantsHeader("fixture", [
        { family: "effect", name: "second", fragment: "", bindings: [] },
        { family: "effect", name: "third", fragment: "", bindings: [] },
    ]);
    assert.equal(first.header, second.header);
    assert.notEqual(first.definitions, second.definitions);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("A native compiler is required."); return; }
    const output = resolve("artifacts/test-cpp-definitions");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "effect.hpp"), second.header);
    writeFileSync(join(output, "effect.cpp"), '#include "effect.hpp"\n' + second.definitions);
    writeFileSync(join(output, "main.cpp"), `#include "effect.hpp"
int main() {
    using namespace bbl::upstream;
    try { effect_variants.at(2); return 1; }
    catch (const std::out_of_range&) {}
    try { effect_variant_bindings.at(0); return 1; }
    catch (const std::out_of_range&) {}
    return effect_variants.size() == 2 && effect_variants[0].name == "second" &&
        effect_variants[1].name == "third" && effect_variant_bindings.empty() ? 0 : 1;
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/include")}`,
        join(output, "effect.cpp"), join(output, "main.cpp"),
        `/Fe:${executable}`, `/Fo:${output}\\`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

test("node-only variant data owns its light declarations in an isolated translation unit", async t => {
    const tools=optionalNativeFixtureTools(false);
    if(!tools){t.skip("A native compiler is required.");return;}
    const graph=await executeModuleGraph({modulePath:"corpus/babylon-lite/lab/lite/src/shared/scene60-nme.ts",exportName:"SCENE60_NME_JSON"}) as Record<string,unknown>;
    const composed=await composeNodeMaterial(graph,"scene60");
    const options:UpstreamEmitOptions={
        idDiagnostics:false,shaderPrograms:[],spriteCustomShaders:[],effects:[],pureSpriteVertex:true,
        plainSpriteLayer:true,plainBillboardSystem:true,geometryOutputTasks:[],postProcessTasks:[],
        postProcessShaders:[],postProcessComposites:[],gpuDeformation:false,animatedWorldBounds:false,
        morphStorage:false,nonTrianglePrimitives:false,gaussianSplats:false,compressedImages:false,
        nodeVisibility:false,gltfNodeVisibility:false,animationPointer:false,animationPointerMaterials:false,
        assetTransmission:false,materialSpecular:false,selectedMaterialVariant:"",standardLightLists:false,
        standardDiffuseUv2:false,textureTransform:false,imageBasedLighting:false,gpuInstancing:false,
        gpuInstanceColors:false,punctualLights:false,clearcoat:false,sheen:false,iridescence:false,
        specularGlossiness:false,dispersion:false,occlusionUv2:false,
        nodeVariants:[{index:0,...nodeVariantStageStems(0),composed}],
    };
    for(const lit of [false,true]){
        const output=resolve("artifacts/test-cpp-definitions",lit?"node-directional":"node-lightless");
        emitUpstreamGenerated(output,["core","backend:sdl","material:node","renderer:scene",...(lit?["light:directional"]:[])],options);
        const main=join(output,"check.cpp"),exe=join(output,"check.exe");
        writeFileSync(main,`#include <bblite/upstream/node_variants.hpp>
#include <cassert>
int main(){
    assert(bbl::upstream::node_variant_inputs.size()>0);
    bbl::LightRecord light;light.kind=bbl::LightKind::directional;
    light.direction={0,-1,0};light.intensity=2;light.diffuse_color={.25f,.5f,1.f};
    bbl::upstream::LightEntry out{};bbl::upstream::write_pinned_light(light,out);
    assert(out.vLightDiffuse[0]==${lit?".5f":"0.f"});
}
`);
        runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/EHsc","/W4","/WX","/O2",
            `/I${join(output,"upstream/include")}`,`/I${resolve("native/include")}`,
            join(output,"upstream/src/variant_data.cpp"),...(lit?[join(output,"upstream/src/light_matrix.cpp")]:[]),main,
            `/Fe:${exe}`,`/Fo:${output}/`]);
        assert.equal(execFileSync(exe,{encoding:"utf8"}),"");
    }
});
