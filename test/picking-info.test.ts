import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PickingLowerer } from "../src/lowering/picking-lowerer.js";
import { pinnedNormalizeVec3Header } from "../src/lowering/pinned-normalize-vec3.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function program(twoEngines=false):string { return `
import {createEngine,createSceneContext,createGpuPicker,pickAsync,disposePicker,getPickedNormal,
 type SceneContext,type PickingInfo} from "@babylonjs/lite";
async function find(scene:SceneContext,name:string):Promise<PickingInfo|null> {
 const picker=createGpuPicker(scene);
 for(let x=0;x<4;x++) {
  const info=await pickAsync(picker,x,0);
  if(info.hit && info.pickedMesh?.name===name) {disposePicker(picker);return info;}
 }
 disposePicker(picker);
 return null;
}
function normalY(info:PickingInfo):number {return getPickedNormal(info)?.[1] ?? -1;}
async function main() {
 const firstEngine=await createEngine({title:"first"});
 const firstScene=createSceneContext(firstEngine);
 const secondEngine=${twoEngines?'await createEngine({title:"second"})':'firstEngine'};
 const secondScene=createSceneContext(secondEngine);
 const first=await find(firstScene,"first");
 const second=await find(secondScene,"${twoEngines?'second':'first'}");
 const miss=await find(firstScene,"absent");
 if(!first?.hit || !second?.hit || miss!==null) throw new Error("nullable early return");
 const alias=first;
 const again=await find(firstScene,"first");
 if(alias!==first || again===first) throw new Error("result identity");
 const rows:PickingInfo[]=[first,second];
 const record:{pick:PickingInfo|null}={pick:second};
 if(!rows.includes(alias) || rows.includes(again!)) throw new Error("array identity");
 const indices=new Map<PickingInfo,number>();
 indices.set(first,7); indices.set(second,11);
 if(indices.get(alias)!==7 || indices.get(again!)!==undefined) throw new Error("Map identity");
 if(!record.pick?.hit) throw new Error("record optional result");
 if(record.pick.pickedMesh?.name!=="${twoEngines?'second':'first'}" || rows[0]!.pickedMesh?.name!=="first") throw new Error("engine provenance");
 if(normalY(rows[0]!)!==0 || normalY(record.pick!)!==${twoEngines?1:0}) throw new Error("normal provenance");
 let index=0;
 if(rows[index++]!.pickedMesh?.name!=="first" || index!==1) throw new Error("owner evaluated twice");
 if(first.bu!==1/3 || first.bv!==1/7) throw new Error("barycentric precision");
 if(!first.pickedPoint) throw new Error("point missing");
 const [x,y,z]=first.pickedPoint;
 if(x!==1 || y!==2 || z!==3) throw new Error("point transport");
 let read:()=>number=()=>-1;
 { const retained=second; read=()=>retained.bu; }
 if(read()!==1/3) throw new Error("retained result");
 alias.bu=0.75; alias.bv=0.5;
 if(first.bu!==0.75 || rows[0]!.bv!==0.5) throw new Error("shared scalar mutation");
}
`; }

test("nullable picking results reuse data returns and preserve the unchanged scene", () => {
    const result = compileSource(program());
    assert.match(result.cpp, /Nullable<bbl::PickingInfo>/);
    assert.match(result.cpp, /return std::nullopt/);
    assert.match(result.cpp, /picked_normal\([^,]+, false\)/);
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene114.ts";
    assert.doesNotThrow(() => compileSource(readFileSync(fileName, "utf8"), { fileName }));
    for (const access of ["if(info.subMeshId>0) throw new Error(\"subMeshId\")", "info.pickedMesh = null", "info.pickedPoint = [3,2,1]"]) {
        assert.throws(() => compileSource(`import {createEngine,createSceneContext,createGpuPicker,pickAsync} from "@babylonjs/lite";
            async function main(){const e=await createEngine({});const s=createSceneContext(e);const p=createGpuPicker(s);const info=await pickAsync(p,0,0);${access};}`), /Unsupported|not supported/);
    }
});

test("data-transported results refuse bare mesh casts and sinks that discard their engine", () => {
    for (const body of [
        "const meshes:Mesh[]=[info.pickedMesh as Mesh]; return meshes[0]!.name;",
        "const meshes:Mesh[]=[info.pickedMesh!]; return meshes[0]!.name;",
        "const mesh=info.pickedMesh as Mesh; return mesh.name;",
        "const selected=direct.pickedMesh ?? info.pickedMesh; const mesh=selected as Mesh; return mesh.name;",
        "let selected=direct; selected=info; const mesh=selected.pickedMesh as Mesh; return mesh.name;",
    ]) {
        assert.throws(() => compileSource(`
            import {createEngine,createSceneContext,createGpuPicker,pickAsync,type PickingInfo,type Mesh} from "@babylonjs/lite";
            async function main() {
                const engine=await createEngine({}); const scene=createSceneContext(engine);
                const picker=createGpuPicker(scene); const direct=await pickAsync(picker,0,0);
                const readers:Array<(info:PickingInfo)=>string>=[(info)=>{${body}}];
                if(readers[0]!(direct)==="wrong") throw new Error("wrong owner");
            }
        `), /data-transported PickingInfo cannot become a bare Mesh handle/, body);
    }
});

test("pinned result identity, nullable helpers and engine provenance satisfy the same assertions", async () => {
    const pin = await import("@babylonjs/lite");
    const { createEmptyPickingInfo } = await importPinnedModule<{
        createEmptyPickingInfo(): import("@babylonjs/lite").PickingInfo;
    }>("picking/picking-info.js");
    const javascript = ts.transpileModule(program(true).replace(/import\s*\{[^}]+\}\s*from\s*"@babylonjs\/lite";/, ""), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    interface Host { title:string; mesh:{name:string;_cpuNormals:Float32Array;_cpuIndices:Uint32Array;worldMatrix:Float32Array} }
    const identity = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    const createEngine = async ({title}:{title:string}):Promise<Host> => ({ title,
        mesh:{name:title,_cpuNormals:new Float32Array(title==="first"?[1,0,0,1,0,0,1,0,0]:[0,1,0,0,1,0,0,1,0]),
        _cpuIndices:new Uint32Array([0,1,2]),worldMatrix:identity} });
    const createSceneContext = (engine:Host) => ({engine});
    const createGpuPicker = (scene:{engine:Host}) => ({scene});
    const pickAsync = async (picker:{scene:{engine:Host}},x:number) => {
        const info=createEmptyPickingInfo();
        if(x===0)return info;
        // Only GPU readback is a seam. The result/default factory and normal
        // helper are the installed pin, and the source assertions are shared.
        Object.assign(info,{hit:true,pickedMesh:picker.scene.engine.mesh,pickedPoint:[1,2,3],faceId:0,bu:1/3,bv:1/7});
        return info;
    };
    const run = new Function("createEngine","createSceneContext","createGpuPicker","pickAsync","disposePicker","getPickedNormal",`${javascript}\nreturn main();`);
    await run(createEngine,createSceneContext,createGpuPicker,pickAsync,()=>{},pin.getPickedNormal);
});

const tools=optionalNativeFixtureTools(false);
test("native picking preserves identity, query order and checked engine lifetime",{skip:!tools},()=>{
    const output=resolve("artifacts/picking-info-check");
    const headers=join(output,"bblite/upstream");
    mkdirSync(headers,{recursive:true});
    const context=new LoweringContext();
    writeFileSync(join(headers,"pinned_normalize_vec3.hpp"),pinnedNormalizeVec3Header(context));
    writeFileSync(join(headers,"renderer_plan.hpp"),`#pragma once\n#include <bblite/runtime.hpp>\nnamespace bbl::upstream { std::array<float,16> mesh_world_matrix(const Engine&,const MeshRecord&); }\n`);
    writeFileSync(join(output,"picking.cpp"),new PickingLowerer(context).lower(false,true).source);
    const source=join(output,"check.cpp");
    const executable=join(output,"check.exe");
    writeFileSync(source,`#define main generated_scene_main\n${compileSource(program()).cpp}\n#undef main\n${readFileSync("test/fixtures/picking-info-check.cpp","utf8")}`);
    runNativeFixtureCompiler(tools!,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/O2","/Gy","/I","native/include","/I",output,
        `/Fo:${output}\\`,`/Fe:${executable}`,source,join(output,"picking.cpp"),"/link","/OPT:REF"]);
    assert.match(execFileSync(executable,{encoding:"utf8"}),/picking-info-check: ok/);
});
