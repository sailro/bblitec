import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {compileSource} from "../src/compiler.js";
import {FactoryLowerer} from "../src/lowering/factory/material-factories.js";
import {LoweringContext} from "../src/lowering/context.js";
import {cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const scenePath = "corpus/babylon-lite/lab/lite/src/lite/scene149.ts";
const scene = ts.createSourceFile(scenePath,readFileSync(scenePath,"utf8"),ts.ScriptTarget.Latest,true);
const resolveAlbedo = scene.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "resolveAlbedo");
assert.ok(resolveAlbedo);
const source = `import {createEngine,createPbrMaterial,createStandardMaterial,createSolidTexture2D,createTexture2DFromPixels} from "@babylonjs/lite";
import type {Material,Texture2D} from "@babylonjs/lite";
${resolveAlbedo.getText(scene)}
async function main() {
    const engine=await createEngine({});
    const solid=createSolidTexture2D(engine,.25,.5,.75,1);
    const pbr=createPbrMaterial({baseColorTexture:solid});
    const shared=createPbrMaterial({baseColorTexture:solid});
    const distinct=createPbrMaterial({baseColorTexture:createSolidTexture2D(engine,.25,.5,.75,1)});
    const first=resolveAlbedo(engine,pbr);
    const byMaterial=new Map<Material,Texture2D>();
    byMaterial.set(pbr,first);
    byMaterial.set(shared,solid);
    byMaterial.set(pbr,solid);
    if(byMaterial.size!==2 || byMaterial.get(pbr)!==solid || byMaterial.has(distinct)) throw new Error("material map identity");
    const held:Texture2D[]=[first,resolveAlbedo(engine,shared)];
    if(first!==solid || held[1]!==solid || first===resolveAlbedo(engine,distinct)) throw new Error("source/cross-material identity");
    const standard=createStandardMaterial();
    standard.diffuseTexture=pbr.baseColorTexture!;
    if(resolveAlbedo(engine,standard)!==solid) throw new Error("PBR to Standard identity");
    standard.diffuseTexture=solid;
    if(resolveAlbedo(engine,standard)!==solid) throw new Error("shared Standard source");
    const pixels=createTexture2DFromPixels(engine,new Uint8Array([11,22,33,255]),1,1);
    standard.diffuseTexture=pixels;
    const transferred=createStandardMaterial();
    transferred.diffuseTexture=standard.diffuseTexture!;
    if(resolveAlbedo(engine,transferred)!==pixels) throw new Error("Stored pixel transfer identity");
    if(resolveAlbedo(engine,standard)!==pixels || held[0]!==solid) throw new Error("replacement retains original arm and old alias");
    const fallback=createPbrMaterial({baseColorFactor:[.25,.5,.75,1]});
    if(resolveAlbedo(engine,fallback)===resolveAlbedo(engine,fallback)) throw new Error("fresh solid fallback identity");
}
main();`;

test("the unchanged scene149 fallback observes source textures and fresh fallback factories", async () => {
    const pin = await import("@babylonjs/lite");
    const writes: number[][] = [];
    const engine = {_device:{
        createTexture:()=>({createView:()=>({})}),createSampler:()=>({}),
        queue:{writeTexture:(_target:object,bytes:Uint8Array)=>writes.push([...bytes])},
    }};
    const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    await new Function("require","exports",js.replace(/main\(\);\s*$/,"return main();"))(
        ()=>({...pin,createEngine:async()=>engine}),{});
    assert.deepEqual(writes,[[64,128,191,255],[64,128,191,255],[11,22,33,255],[64,128,191,255],[64,128,191,255]]);
});

test("native material getters retain producer variants, replacement aliases and exact149 fallback order", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {t.skip("Native fixture compiler unavailable.");return;}
    const result = compileSource(source);
    assert.ok(result.manifest.features.includes("material:source-texture-read"));
    assert.ok(!compileSource(`import {createEngine,createStandardMaterial,createSolidTexture2D} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const material=createStandardMaterial();
        material.diffuseTexture=createSolidTexture2D(engine,1,1,1,1);}`).manifest.features.includes("material:source-texture-read"));
    const lowerer = new FactoryLowerer(new LoweringContext());
    const texture = lowerer.lowerFileTextureFactory().source;
    const pbr = lowerer.lowerPbrMaterialFactory().source;
    const standard = lowerer.lowerStandardMaterialSetters({solid:true,pixels:true,diffuseFile:true,
        diffuse:false,emissive:false,emissiveFile:false,uvTransform:false,plugins:false,pluginTextures:false}).source;
    const pixel = lowerer.lowerPixelsTextureFactory().source;
    const functions = [
        cppFunction(texture,"[[maybe_unused]] static TextureData solid_texture_data("),
        cppFunction(texture,"[[maybe_unused]] static FileTexture retained_solid_texture("),
        cppFunction(texture,"SolidTexture create_solid_texture("),
        cppFunction(texture,"FileTexture solid_texture_file("),
        cppFunction(pbr,"MaterialHandle create_pbr_material("),
        cppFunction(pbr,"void set_material_base_color_file("),
        cppFunction(lowerer.lowerStandardMaterialFactory().source,"MaterialHandle create_standard_material("),
        cppFunction(standard,"MaterialRecord& standard_slot_material("),
        cppFunction(standard,"TextureData& take_standard_diffuse_slot("),
        cppFunction(standard,"void set_standard_diffuse_solid_texture("),
        cppFunction(standard,"void set_standard_diffuse_pixels_texture("),
        cppFunction(standard,"void set_standard_diffuse_file_texture("),
        cppFunction(pixel,"PixelsTexture create_texture_2d_from_bytes("),
    ].join("\n");
    const directory=resolve("artifacts/test-material-texture-identity");
    mkdirSync(directory,{recursive:true});
    const input=resolve(directory,"check.cpp"), executable=resolve(directory,"check.exe");
    writeFileSync(input,`#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cmath>
namespace bbl {
namespace upstream { enum class MaterialTextureSrgb { linear, srgb, srgb_unless_standard, base_color }; }
${cppFunction(readFileSync("native/src/pal_gpu_shared.hpp", "utf8"), "inline bool material_slot_srgb(")}
Engine create_engine(EngineOptions) {return {};}
${functions}
PixelsTexture create_texture_2d_from_pixels(Engine& engine,const js::U8Array& pixels,double width,double height,PixelsTextureOptions options) {
    return create_texture_2d_from_bytes(engine,pixels.to_vector(),width,height,options);
}
}
#define main source_main
${result.cpp}
#undef main
int main() {
    assert(source_main()==0);
    bbl::Engine engine;
    auto a=bbl::create_standard_material(engine), b=bbl::create_standard_material(engine);
    bbl::PixelsTexture pixels; pixels.identity=42; pixels.width=1; pixels.height=1;
    pixels.rgba=std::vector<std::uint8_t>{11,22,33,255};
    bbl::set_standard_diffuse_pixels_texture(engine,a,pixels);
    bbl::set_standard_diffuse_pixels_texture(engine,b,pixels);
    const auto old=bbl::material_source_texture(engine,a,bbl::MaterialTextureSlot::diffuse);
    assert(std::holds_alternative<bbl::PixelsTexture>(old));
    assert(old==bbl::StoredTexture{pixels} && old==bbl::material_source_texture(engine,b,bbl::MaterialTextureSlot::diffuse));
    bbl::FileTexture file; file.identity=42; file.srgb=true; file.width=1; file.height=1;
    file.data.bytes=std::vector<std::uint8_t>{44,55,66,255};file.data.rgba_width=1;file.data.rgba_height=1;
    bbl::set_standard_diffuse_file_texture(engine,a,file);
    assert(bbl::material_source_texture(engine,a,bbl::MaterialTextureSlot::diffuse)==bbl::StoredTexture{file});
    assert(old!=bbl::StoredTexture{file});
    auto pbr=bbl::create_pbr_material(engine,{});
    bbl::set_material_base_color_file(engine,pbr,file);
    assert(bbl::material_source_texture(engine,pbr,bbl::MaterialTextureSlot::base_color)==bbl::StoredTexture{file});
    bbl::set_standard_diffuse_texture(engine,b,bbl::material_source_texture(engine,pbr,bbl::MaterialTextureSlot::base_color));
    assert(bbl::material_source_texture(engine,b,bbl::MaterialTextureSlot::diffuse)==bbl::StoredTexture{file});
    assert(bbl::material_slot_srgb(bbl::upstream::MaterialTextureSrgb::base_color, &engine.materials[b.value], true));
    bbl::set_standard_diffuse_texture(engine,b,old);
    assert(!bbl::material_slot_srgb(bbl::upstream::MaterialTextureSrgb::base_color, &engine.materials[b.value], true));
    engine.materials.clear();
    assert(std::get<bbl::PixelsTexture>(old).rgba[2]==33);
}`);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/EHsc","/W4","/WX","/Od",`/I${resolve("native/include")}`,input,`/Fe:${executable}`,`/Fo:${resolve(directory,"check.obj")}`]);
    execFileSync(executable,[],{stdio:"pipe"});
});
