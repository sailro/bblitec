import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {packLocalCubemap, type LocalCubemapPlan} from "../src/pinned-local-cubemap.js";
import {readUpstreamPin} from "../src/upstream-source.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("resource members execute once and flattened typed-array lanes preserve source width", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {t.skip("Native fixture compiler unavailable."); return;}
    const result = compileSource(`import {createEngine,createBox} from "@babylonjs/lite";
async function main() {
    const engine = await createEngine({});
    const faces = {left:createBox(engine,2), right:createBox(engine,3)};
    faces.left.position.x = 7;
    faces.right.position.y = 8;
    if (faces.left === faces.right || faces.left.position.x !== 7 || faces.right.position.y !== 8) throw new Error("resource members");
    const rows = [[1,2],[3,4]] as const;
    const flattened = new Float32Array(rows.flat());
    if(flattened.length !== 4 || flattened[2] !== 3) throw new Error("flat depth");
    const deep = new Float32Array([[[1,2]],[[3,4]]].flat(2));
    if(deep.length !== 4 || deep[3] !== 4) throw new Error("nested flat");
    const value = faces.left.position.x;
    const wide = new Float64Array([[value, 1/3]].flat());
    if(wide[0] !== value || wide[1] !== 1/3) throw new Error("numeric width");
}
main();`);
    const directory = resolve("artifacts/test-scene-integration-boundaries");
    mkdirSync(directory, {recursive:true});
    const input = resolve(directory,"check.cpp"), executable = resolve(directory,"check.exe");
    writeFileSync(input, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
static int factories=0;
namespace bbl {
Engine create_engine(EngineOptions) {return {};}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {assert(mesh.value < engine.meshes.size());}
MeshHandle create_box(Engine& engine, BoxOptions) {
    ++factories;
    const auto index=engine.meshes.size(); engine.meshes.emplace_back(); return MeshHandle{static_cast<std::uint32_t>(index)};
}
}
#define main source_main
${result.cpp}
#undef main
int main() {assert(source_main()==0); assert(factories==2);}
`);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/EHsc","/W4","/WX","/Od",`/I${resolve("native/include")}`,
        input,`/Fe:${executable}`,`/Fo:${resolve(directory,"check.obj")}`]);
    execFileSync(executable,[],{stdio:"pipe"});
});

test("retained surface admission follows actual canvas tags and registration boundaries", () => {
    const nativeHostUi = {sourcePath:"fixture.json", elements:[
        {tag:"canvas",attributes:{id:"renderCanvas"}}, {tag:"canvas",attributes:{id:"secondary"}}, {tag:"button",attributes:{id:"button"}},
    ]};
    const source = (canvas: string) => `import {createEngine,createSurface,createSceneContext,registerScene} from "@babylonjs/lite";
    async function main() {const primary=document.getElementById("renderCanvas")!;
    const engine=await createEngine(primary); const surface=createSurface(engine,document.getElementById("${canvas}")!);
    const scene=createSceneContext(surface); await registerScene(scene);}`;
    const valid = compileSource(source("secondary"),{nativeHostUi});
    assert(valid.manifest.features.includes("renderer:surface"));
    assert.match(valid.cpp,/surface_canvas =/);
    const independentSamples = compileSource(source("secondary").replace("createEngine(primary)", "createEngine(primary,{msaaSamples:1})"),{nativeHostUi});
    assert.doesNotMatch(independentSamples.cpp,/configure_scene_render_defaults\(bbl::create_scene_context\(v_surface\), true, 1u\)/);
    assert.throws(()=>compileSource(source("button"),{nativeHostUi}), /canvas elements/);
    assert.throws(()=>compileSource(`import {createEngine,createSceneContext,registerScene,enablePbrLocalCubemap} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const scene=createSceneContext(engine);await registerScene(scene);await enablePbrLocalCubemap();}`), /before scene registration/);
    assert.throws(()=>compileSource(`import {createEngine,createSceneContext,registerScene,createPbrMaterial,createSolidTexture2D} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const scene=createSceneContext(engine);const material=createPbrMaterial({});
        await registerScene(scene);material.ormTexture=createSolidTexture2D(engine,1,1,1,1);}`), /before scene registration/);
});

test("selected conditional material records retain static local-cubemap setup", () => {
    const fileName = resolve("corpus/babylon-lite/lab/lite/src/lite/scene186.ts");
    const source = readFileSync(fileName, "utf8");
    for (const [search, probes] of [["", 4], ["?compare=0", 2], ["?blend=0", 2]] as const) {
        const result = compileSource(source, {fileName, search});
        assert.equal(result.manifest.scenePbrMaterials.filter(material => material.localCubemapCandidates !== undefined).length, probes);
    }
    const runtimeSelection = source.replace("if (hardLeftMaterials && hardRightMaterials && hardLeftRoom && hardRightRoom)",
        "if (Math.random() > 0 && hardLeftMaterials && hardRightMaterials && hardLeftRoom && hardRightRoom)");
    assert.throws(() => compileSource(runtimeSelection, {fileName}), /Local cubemap configuration currently requires static calls/);
});

test("pinned local probes retain distinct cube layers, grid bytes, writer fields and debug state", async () => {
    const pin = readUpstreamPin();
    const environments = ["left","right"].map(name=>`https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${pin.sourceVersion}/lab/public/textures/scene186/${name}.env`);
    const plan: LocalCubemapPlan = {kind:"probes",maxCandidates:2,entryFileName:resolve("test/local-probes.ts"),environments,
        options:{probes:[0,1].map(environment=>({environment,capturePosition:[environment*6-3,0,1.5],
            projectionPosition:[environment*6-3,0,2],projectionSize:[6,5,5],influencePosition:[environment*6-3,0,2],
            influenceInnerSize:[.075,5,5],influenceOuterPosition:[0,0,2],influenceOuterSize:[24,6,6]})),
            voxelGrid:{minimum:[-6,-2.5,-.5],maximum:[6,2.5,4.5],cellSize:2}}};
    const packet = await packLocalCubemap(plan);
    assert.equal(packet.uniform.length*4,65536);
    assert.equal(packet.uniform[0],2);
    assert.equal(packet.layers,12);
    assert.equal(packet.copies.length,packet.mipCount*12);
    assert.deepEqual([...new Set(packet.copies.filter(copy=>copy.layer<6).map(copy=>copy.source))],[0]);
    assert.deepEqual([...new Set(packet.copies.filter(copy=>copy.layer>=6).map(copy=>copy.source))],[1]);
    assert.equal(packet.overridesEnvironment,false);
    assert(packet.grid.length>4 && new Set(packet.grid).size>1);
    const debug = await packLocalCubemap({...plan,debug:true});
    assert.deepEqual(debug.copies,packet.copies);
    assert.deepEqual(debug.grid,packet.grid);
    assert.deepEqual(debug.fields,packet.fields);
    assert.deepEqual(debug.uniform.map((lane,index)=>lane===packet.uniform[index] ? -1 : index).filter(index=>index>=0),[3]);
    for (const shape of ["box","sphere"]) {
        const single = await packLocalCubemap({...plan,kind:"single",environments:[environments[0]!],
            options:{shape,projectionPosition:[1,2,3],projectionSize:[4,5,6],projectionRadius:2}});
        assert.equal(single.layers,6);
        assert.equal(single.overridesEnvironment,true);
        assert.notDeepEqual(single.fields,packet.fields);
    }
    const unprojected = await packLocalCubemap({...plan,kind:"environment",environments:[environments[1]!],options:{}});
    assert.equal(unprojected.overridesEnvironment,true);
    assert.equal(unprojected.layers,6);
    assert.notDeepEqual(unprojected.fields,packet.fields);
    await assert.rejects(packLocalCubemap({...plan,kind:"single",options:{projectionPosition:[0,0,0],projectionSize:[1,-1,1]}}), /#249/);
    assert.deepEqual(await packLocalCubemap(plan),packet, "Independent repeated packing changed bytes");
});
