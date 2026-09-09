import { inlineCpp } from "./generated-cpp.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { importPinnedModule, importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { materialTextureSlotsHeader, pinnedSharedVariantDecls, pinnedStandardVariantsHeader } from "../src/pinned-pbr-variant-cpp.js";
import { composePinnedStandardVariant, pinnedStandardMaterialFeatures, pinnedStandardSupportBlock, pinnedStandardVariantManifestEntry } from "../src/pinned-standard-variants.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const setterFeatures = { diffuse: false, emissive: false, pixels: false, solid: false, diffuseFile: false, emissiveFile: false, lightmapFile: true, uvTransform: false, plugins: false, pluginTextures: false };
interface LightmapTexture { uScale: number; vScale: number; uOffset: number; vOffset: number; uAng: number; invertY: boolean }
interface LightmapMaterial {
    lightmapLevel: number;
    lightmapCoordIndex: number;
    useLightmapAsShadowmap: boolean;
    uvScale: [number, number];
    uvOffset: [number, number];
}
const program = `import {createEngine,createStandardMaterial,loadTexture2D,setStandardLightmapTexture,registerScene,createSceneContext} from "@babylonjs/lite";
async function main(){const engine=await createEngine({});const scene=createSceneContext(engine);const material=createStandardMaterial();
const texture=await loadTexture2D(engine,"https://example.com/lightmap.jpg");texture.uAng=Math.PI;
setStandardLightmapTexture(material,texture);material.useLightmapAsShadowmap=true;material.lightmapLevel=3.2;material.lightmapCoordIndex=1;
setStandardLightmapTexture(material,null);}`;

test("Standard lightmap setup lowers texture replacement, removal and material inputs", () => {
    const result = compileSource(program);
    assert(result.manifest.features.includes("material:standard-lightmap"));
    assert(!result.manifest.features.includes("material:pbr"));
    assert.match(result.cpp, /set_standard_lightmap_texture\([^;]+v_texture\)/);
    assert.match(result.cpp, /set_standard_lightmap_texture\([^;]+bbl::FileTexture\{\}\)/);
    assert.match(result.cpp, /lightmap_shadowmap = true/);
    assert.match(result.cpp, /lightmap_level = 3\.2f/);
    assert.match(result.cpp, /lightmap_coord_index = 1\.0f/);
    assert.throws(() => compileSource(program.replace("setStandardLightmapTexture(material,null);", "texture.uAng=0;")), /written after this texture was bound/);
    assert.throws(() => compileSource(program.replace("setStandardLightmapTexture(material,null);", "registerScene(scene);setStandardLightmapTexture(material,null);")), /before scene registration/);
});

test("Standard lightmap variants compose all UV, blend and legacy-flip branches", async () => {
    for (const lightmapCoordIndex of [0,1]) for (const useLightmapAsShadowmap of [false,true]) for (const uAng of [0,Math.PI]) {
        const variant = await composePinnedStandardVariant({ lightmapTexture: {uAng}, lightmapCoordIndex, useLightmapAsShadowmap });
        assert(variant.fragmentKey.includes("std-lightmap"));
        const uv = lightmapCoordIndex ? "input.vv" : "input.vu";
        assert(variant.fragmentWgsl.includes(`textureSample(lT,lS,${uAng ? `vec2<f32>(${uv}.x,1.0- ${uv}.y)` : uv}).rgb*mat.lmLvl`));
        assert(variant.fragmentWgsl.includes(useLightmapAsShadowmap ? "color.rgb * (" : "color.rgb + "));
    }
});

const tools = optionalNativeFixtureTools(false);
test("native Standard lightmap features, material uniforms and UV lanes match the pin", { skip: !tools }, async () => {
    const store = new UpstreamSourceStore(), context = new LoweringContext(store), factory = new FactoryLowerer(context);
    const directory = resolve("artifacts/standard-lightmap-controls");
    mkdirSync(join(directory,"bblite/upstream"), { recursive: true });
    const variant = pinnedStandardVariantManifestEntry(await composePinnedStandardVariant({ lightmapTexture: {}, lightmapCoordIndex: 1 }));
    writeFileSync(join(directory,"bblite/upstream/pinned_variant_bindings.hpp"), pinnedSharedVariantDecls(context,"lightmap control"));
    writeFileSync(join(directory,"bblite/upstream/material_texture_slots.hpp"), inlineCpp(materialTextureSlotsHeader({ transmission:false,clearcoat:false,sheen:false,iridescence:false,lightmap:true,metallicReflectanceMap:false,reflectanceMap:false,specularGlossiness:false,occlusionUv2:false,standardBump:false,standardReflection:false,clusteredLights:false,vat:false,vatInstances:false }, [], "lightmap control")));
    writeFileSync(join(directory,"standard.hpp"), inlineCpp(pinnedStandardVariantsHeader(context,"lightmap control",[variant])) + inlineCpp(pinnedStandardSupportBlock(context,{selectors:[],uvTransform:true,plugins:false,renderableMeshFeatures:[]})));
    const { createStandardMaterial } = await importPinnedModule<{createStandardMaterial():LightmapMaterial}>("material/standard/create-standard-material.js");
    const { setStandardLightmapTexture } = await importPinnedModule<{setStandardLightmapTexture(material:LightmapMaterial,texture:LightmapTexture|null):void}>("material/standard/set-std-lightmap.js");
    const { writeStdMaterialData } = await importPinnedModule<{writeStdMaterialData(data:Float32Array,material:LightmapMaterial,level:number):void}>("material/standard/standard-pipeline.js");
    const { writeUvTransformData } = await importPinnedModuleWithExports<{
        writeUvTransformData(data:Float32Array,material:LightmapMaterial):void;
    }>("material/standard/fragments/std-uv-transform-fragment.js", ["writeUvTransformData"]);
    const expected:number[][] = [], runs:string[] = [];
    for (const coord of [0,1]) for (const shadowmap of [false,true]) for (const angle of [0,.37,Math.PI]) for (const inverted of [false,true]) {
        const material = createStandardMaterial();
        const texture = {uScale:1.7,vScale:.65,uOffset:.12,vOffset:-.2,uAng:angle,invertY:inverted};
        setStandardLightmapTexture(material,texture);
        Object.assign(material,{lightmapLevel:3.2,lightmapCoordIndex:coord,useLightmapAsShadowmap:shadowmap,uvScale:[2,.5],uvOffset:[.3,-.7]});
        const data = new Float32Array(24), uv = new Float32Array(56);
        writeStdMaterialData(data,material,1);writeUvTransformData(uv,material);
        expected.push([await pinnedStandardMaterialFeatures({lightmapTexture:texture,lightmapCoordIndex:coord,useLightmapAsShadowmap:shadowmap}),data[17]!,...uv.slice(40,48)]);
        runs.push(`{auto handle=bbl::create_standard_material(engine);bbl::FileTexture texture;texture.data.bytes={1,2,3,4};texture.data.rgba_width=1;texture.data.rgba_height=1;
            texture.data.uv_transform={1.7,.65,.12,-.2,${angle}};texture.data.uv_invert_y=${inverted};texture.srgb=${inverted};
            bbl::set_standard_lightmap_texture(engine,handle,texture);auto& material=engine.materials[handle.value];
            assert(material.lightmap_texture_srgb==${inverted});assert(material.lightmap_texture.bytes.size()==4);
            material.lightmap_level=3.2f;material.lightmap_coord_index=${coord};material.lightmap_shadowmap=${shadowmap};material.diffuse_u_scale=2;material.diffuse_v_scale=.5f;material.standard_uv_offset_x=.3;material.standard_uv_offset_y=-.7;
            auto props=bbl::upstream::standard_material_props(material);bbl::upstream::StandardMaterialUniforms data;bbl::upstream::write_standard_material(props,1,data);
            bbl::upstream::StandardUvTxUniforms uv;bbl::upstream::write_std_uv_transform_data(material,props,uv);
            if(index++)std::cout<<',';std::cout<<'['<<bbl::upstream::standard_material_features(material)<<','<<data.lmLvl;
            for(std::size_t i=40;i<48;++i)std::cout<<','<<uv.data[i];std::cout<<']';
            bbl::set_standard_lightmap_texture(engine,handle,{});assert(!material.lightmap_texture.has_image());assert(bbl::upstream::standard_material_features(material)==0);}`);
    }
    writeFileSync(join(directory,"check.cpp"), `#include "standard.hpp"
        #include <cassert>
        #include <iomanip>
        #include <iostream>
        ${factory.lowerStandardMaterialFactory().source}
        ${factory.lowerStandardMaterialSetters(setterFeatures).source}
        int main(){bbl::Engine engine;std::size_t index=0;std::cout<<std::setprecision(17)<<'[';${runs.join("\n")}std::cout<<']';}`);
    const executable = join(directory,"check.exe");
    runNativeFixtureCompiler(tools!,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/O2","/I","native/include","/I",directory,`/Fo:${directory}\\`,`/Fe:${executable}`,join(directory,"check.cpp")]);
    const actual:number[][] = JSON.parse(execFileSync(executable,{encoding:"utf8",env:tools!.environment}));
    assert.equal(actual.length,expected.length);
    const maxError = Math.max(...actual.flatMap((row,i)=>row.map((value,lane)=>Math.abs(value-expected[i]![lane]!))));
    writeFileSync(join(directory,"report.json"),JSON.stringify({cases:expected.length,maxError,actual,expected},null,2)+"\n");
    assert.equal(maxError,0);
});

test("Standard lightmap setter rejects changed target and extension registration", () => {
    class EditedStore extends UpstreamSourceStore {
        public constructor(private readonly from:string,private readonly to:string){super();}
        public override getSourceFile(module:string):ts.SourceFile{
            const original=super.getSource(module);
            return ts.createSourceFile(module,module.endsWith("/set-std-lightmap.ts")?original.replace(this.from,this.to):original,ts.ScriptTarget.Latest,true);
        }
    }
    for(const [from,to] of [["mat._lightmapTexture = texture","mat._emissiveTexture = texture"],["_registerStdExt(stdLightmapExt)","_registerStdExt(otherExt)"]])
        assert.throws(()=>new FactoryLowerer(new LoweringContext(new EditedStore(from!,to!))).lowerStandardMaterialSetters(setterFeatures),/./);
});
