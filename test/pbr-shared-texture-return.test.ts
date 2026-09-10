import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {compileSource} from "../src/compiler.js";
import {FactoryLowerer} from "../src/lowering/factory-lowerer.js";
import {LoweringContext} from "../src/lowering/context.js";
import {cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

const source = `import {createEngine,createSolidTexture2D,createPbrMaterial,type Texture2D} from "@babylonjs/lite";
async function main() {
    const engine=await createEngine({});
    let calls=0;
    function orm(roughness:number,metallic:number):Texture2D {
        calls++;
        return createSolidTexture2D(engine,1,roughness,metallic,1);
    }
    createPbrMaterial({ormTexture:orm(.25,0)});
    createPbrMaterial({ormTexture:orm(.75,.5)});
    createPbrMaterial({baseColorTexture:orm(.5,.25),ormTexture:orm(1,0)});
    if(calls!==4)throw new Error("texture return evaluated more than once");
}
main();`;

test("PBR helper texture returns retain their stored payload before material construction", async t => {
    const pin=await import("@babylonjs/lite");
    const writes:number[][]=[],creationWrites:number[]=[];
    const engine={_device:{createTexture:()=>({createView:()=>({})}),createSampler:()=>({}),
        queue:{writeTexture:(_target:unknown,bytes:Uint8Array)=>writes.push([...bytes])}}};
    await new Function("require","exports",transpileCommonJs(source,"fixture.ts").replace(/main\(\);\s*$/,"return main();"))(
        ()=>({...pin,createEngine:async()=>engine,createPbrMaterial:(options:Parameters<typeof pin.createPbrMaterial>[0])=>{
            creationWrites.push(writes.length);return pin.createPbrMaterial(options);
        }}),{});
    assert.deepEqual(writes,[[255,64,0,255],[255,191,128,255],[255,128,64,255],[255,255,0,255]]);
    assert.deepEqual(creationWrites,[1,2,4]);
    const compiled=compileSource(source);
    assert.equal(compiled.cpp.match(/std::get<bbl::FileTexture>/g)?.length,4);
    const tools=optionalNativeFixtureTools(false);
    if(!tools){t.skip("A native compiler is required.");return;}
    const output=resolve("artifacts/test-pbr-shared-texture-return");mkdirSync(output,{recursive:true});
    writeFileSync(join(output,"program.hpp"),compiled.cpp);
    const lowerer=new FactoryLowerer(new LoweringContext());
    const texture=lowerer.lowerFileTextureFactory().source;
    const material=lowerer.lowerPbrMaterialFactory().source;
    const functions=[
        cppFunction(texture,"[[maybe_unused]] static TextureData solid_texture_data("),
        cppFunction(texture,"[[maybe_unused]] static FileTexture retained_solid_texture("),
        cppFunction(texture,"SolidTexture create_solid_texture("),
        cppFunction(texture,"FileTexture solid_texture_file("),
        cppFunction(material,"void set_material_base_color_file("),
        cppFunction(material,"void set_material_orm_file(").replace("void set_material_orm_file(","void apply_material_orm_file("),
    ].join("\n");
    writeFileSync(join(output,"check.cpp"),`#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>
unsigned attachments=0;
namespace bbl {
${functions}
void set_material_orm_file(Engine& engine,MaterialHandle material,FileTexture texture){
    apply_material_orm_file(engine,material,std::move(texture));
    const auto& record=engine.materials.at(material.value);
    const std::array<std::array<std::uint8_t,4>,3> expected{{{255,64,0,255},{255,191,128,255},{255,255,0,255}}};
    const auto& bytes=expected.at(attachments++);
    assert(std::equal(record.metallic_roughness_texture.bytes.begin(),record.metallic_roughness_texture.bytes.end(),bytes.begin(),bytes.end()));
    assert(record.orm_texture_generation==1);
    if(material.value==2){
        const auto& base=std::get<FileTexture>(*record.source_albedo_texture);
        assert(base.identity==3 && !base.srgb);
        const std::array<std::uint8_t,4> albedo{255,128,64,255};
        assert(std::equal(record.base_color_texture.bytes.begin(),record.base_color_texture.bytes.end(),albedo.begin(),albedo.end()));
    }
}
Engine create_engine(EngineOptions){return {};}
MaterialHandle create_pbr_material(Engine& engine,PbrMaterialOptions options){
    const auto index=static_cast<std::uint32_t>(engine.materials.size());
    assert(engine.next_file_texture_identity==(index==0?2u:index==1?3u:5u));
    assert(options.orm.color.r==1 && options.orm.color.g==1 && options.orm.color.b==1);
    engine.materials.emplace_back();return {index};
}
}
int main(){assert(generated_main()==0);assert(attachments==3);}
`);
    const exe=join(output,"check.exe");
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/O2",`/Fo:${output}/`,`/Fe:${exe}`,"/I","native/include",join(output,"check.cpp")]);
    assert.equal(execFileSync(exe,{encoding:"utf8"}),"");
});
