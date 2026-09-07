import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { resolveBundledAsset } from "../src/compiler/assets.js";
import { stringLiteral } from "../src/cpp-literals.js";
import { parseDataUrl } from "../src/data-url.js";
import { LoweringContext } from "../src/lowering/context.js";
import { TextLowerer } from "../src/lowering/text-lowerer.js";
import { composeDefaultTextPipelines, textPipelineHeader } from "../src/pinned-text-pipeline-cpp.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";

const directory = resolve("artifacts/test-text-entities");
mkdirSync(directory, { recursive: true });
const fileName = resolve(directory, "source.ts");
writeFileSync(resolve(directory, "Roboto-Regular.ttf"), readAssetBytesSync(resolveBundledAsset("/fonts/Roboto-Regular.ttf"), fileName));
const source = (body: string) => `import { createEngine,loadFont,createDefaultTextData,createTextRenderable,
    disposeTextRenderable,disposeDefaultTextData,addTextRenderable,createSceneContext,setAlphaToCoverage,getAlphaToCoverage,
    createFreeCamera,attachFreeControl,onBeforeRender,registerScene,disposeScene,unregisterScene,rebuildSceneRenderables,
    type TextRenderable,type DefaultTextData } from "@babylonjs/lite";
async function main(){const engine=await createEngine({});const font=await loadFont("./Roboto-Regular.ttf");${body}}`;
const compile = (body: string) => compileSource(source(body), { fileName });
const setup = `const data=createDefaultTextData(font,18,"Hi");const r=createTextRenderable(data);`;

test("text entity aliases, helpers, containers and escaped callbacks preserve native identity and setter order", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable"); return; }
    const body = `${setup}
        const other=createTextRenderable(data);
        const dataAlias=data;
        const separate=createDefaultTextData(font,18,"Hi");
        let currentData=data;
        function chooseOpacity():number{currentData=separate;return .5;}
        const ordered=createTextRenderable(currentData,{opacity:chooseOpacity()});
        if(ordered._data!==data||ordered.opacity!==.5)throw new Error("data before options");
        let lane=1;
        const options=createTextRenderable(data,{position:{x:lane,y:(lane=2),z:3}});
        if(options.position.x!==1||options.position.y!==2)throw new Error("option component snapshot");
        setAlphaToCoverage(r,true);
        if(!getAlphaToCoverage(r)||getAlphaToCoverage(other))throw new Error("membership identity");
        if(data!==dataAlias || data===separate || r===other || r._data!==data)throw new Error("identity");
        const list:TextRenderable[]=[r,other];
        function identity(value:TextRenderable):TextRenderable{return value;}
        if(identity(list[0]!)!==r)throw new Error("transport");
        const p=r.position;
        if(p!==r.position || p===r.scaling)throw new Error("vector identity");
        p.x=2; const previous=p.x++; if(previous!==2||r.position.x!==3)throw new Error("postfix");
        let selected:TextRenderable=r;
        function replace():number{selected=other;return 4;}
        selected.position.x+=replace();
        if(r.position.x!==7||other.position.x!==0)throw new Error("owner before RHS");
        let calls=0;
        function owner():TextRenderable{calls++;return r;}
        let order=0;
        function argument(value:number):number{order=order*10+value;return value;}
        owner().position.set(argument(1),argument(2),argument(3));
        if(calls!==1||r.position.x!==1||r.position.y!==2||r.position.z!==3)throw new Error("bulk receiver");
        if(order!==123)throw new Error("bulk argument order");
        const holder={get item():TextRenderable{return owner();}};
        holder.item.opacity=.4;
        if(calls!==2||r.opacity!==.4)throw new Error("getter evaluated twice");
        const holderAlias=holder;
        holderAlias.item.opacity=.6;
        if(calls!==3||r.opacity!==.6)throw new Error("aliased getter evaluated twice");
        r.rotationQuaternion.set(0,0,0,1);
        r.rotation.y=.25;
        if(r.rotation.y!==.25)throw new Error("Euler cache");
        let retained:()=>number=()=>0;
        { const local=createTextRenderable(data);const vector=local.position;
          retained=()=>{vector.x+=2;return vector.x;}; }
        if(retained()!==2||retained()!==4)throw new Error("escaped owner");
        disposeTextRenderable(r);
        if(r._data!==data||identity(list[0]!)!==r)throw new Error("renderable disposal identity");
        disposeDefaultTextData(data);
        if(r._data!==dataAlias||data.width!==separate.width)throw new Error("data disposal identity");
    `;
    const { createFontFromBuffer } = await importPinnedModule<{createFontFromBuffer(bytes:ArrayBuffer):unknown}>("text/font.js");
    const textData = await importPinnedModule<Record<string, unknown>>("text/default-text-data.js");
    const renderable = await importPinnedModule<Record<string, unknown>>("text/text-renderable.js");
    const coverage = await importPinnedModule<Record<string, unknown>>("render/alpha-to-coverage.js");
    const font = createFontFromBuffer(Uint8Array.from(readAssetBytesSync(resolveBundledAsset("/fonts/Roboto-Regular.ttf"), fileName)).buffer);
    const js = ts.transpileModule(source(body).replace(/^import[\s\S]*?from "@babylonjs\/lite";/, "") + "\nreturn main();", {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await new Function("createEngine", "loadFont", "createDefaultTextData", "createTextRenderable", "disposeTextRenderable", "disposeDefaultTextData", "setAlphaToCoverage", "getAlphaToCoverage", js)(
        async () => ({}), async () => font, textData.createDefaultTextData, renderable.createTextRenderable,
        renderable.disposeTextRenderable, textData.disposeDefaultTextData, coverage.setAlphaToCoverage, coverage.getAlphaToCoverage);
    const result = compile(body);
    writeFileSync(resolve(directory, "program.hpp"), result.cpp);
    const include = resolve(directory, "bblite");
    mkdirSync(resolve(include, "upstream"), { recursive: true });
    const lowerer = new TextLowerer(new LoweringContext());
    writeFileSync(resolve(include, "upstream_text.hpp"), lowerer.header());
    writeFileSync(resolve(include, "upstream/text_data.hpp"), "#pragma once\n#include <bblite/text.hpp>\nnamespace bbl {TextData create_compiled_text_data(std::uint32_t);}\n");
    const pipelines = await composeDefaultTextPipelines();
    writeFileSync(resolve(include, "upstream_text_pipeline.hpp"), textPipelineHeader(pipelines));
    for (const asset of result.manifest.assets) {
        const data = result.assetPayloads?.get(asset.source);
        if (data?.startsWith("data:")) writeFileSync(resolve(directory, asset.output), parseDataUrl(data)!.bytes);
    }
    const constructor = result.manifest.textData!.map((row) => `case ${row.id}:return ${lowerer.dataExpression(row, (blob) => `read_bytes(${stringLiteral(blob.assetOutput)})`)};`).join("\n");
    writeFileSync(resolve(directory, "check.cpp"), `#include <fstream>
#include <iterator>
#include <bblite/upstream_text_pipeline.hpp>
#define main generated_main
#include "program.hpp"
#undef main
static std::vector<std::uint8_t> read_bytes(const char* path) {std::ifstream file(path,std::ios::binary);return {std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};}
namespace bbl {Engine create_engine(EngineOptions){return {};}
TextData create_compiled_text_data(std::uint32_t index){switch(index){${constructor}default:throw std::out_of_range("data");}}}
int main(){if(bbl::upstream::text_pipeline_rows.size()!=5)return 2;return generated_main();}
`);
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/fp:strict", "/MD", "/O2",
        `/I${resolve("native/include")}`, `/I${directory}`, resolve(directory, "check.cpp"), `/Fo${resolve(directory, "check.obj")}`, `/Fe${executable}`]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("text pipeline-affecting writes and internal data operations keep explicit source boundaries", () => {
    for (const [body, diagnostic] of [
        [`${setup} r.position={x:1,y:2,z:3};`, /read-only|replacement/],
        [`${setup} const p=r.position;p["x"]=2;`, /Computed text property/],
        [`${setup} Object.assign(r,{opacity:.5});`, /Reflective text property/],
        [`${setup} const p=Math.random()>.5?r.position:r.scaling;p.x=2;`, /Conditional text transform/],
        [`${setup} r._data=data;`, /read-only|replacement/],
        [`${setup} data.width=4;`, /read-only|replacement/],
        [`${setup} const scene=createSceneContext(engine);addTextRenderable(scene,r);const alias=r;setAlphaToCoverage(alias,true);`, /before text attachment/],
        [`${setup} const scene=createSceneContext(engine);addTextRenderable(scene,r);r.ignoreDepth=true;`, /before text attachment/],
        [`${setup} const scene=createSceneContext(engine);addTextRenderable(scene,r);r.order=4;`, /before text attachment/],
        [`${setup} const scene=createSceneContext(engine);addTextRenderable(scene,r);disposeTextRenderable(r);`, /before text attachment/],
        [`${setup} const scene=createSceneContext(engine);onBeforeRender(scene,()=>disposeDefaultTextData(data));`, /before text attachment/],
        [`${setup} const scene=createSceneContext(engine);onBeforeRender(scene,()=>addTextRenderable(scene,r));`, /definite initialization/],
        [`${setup} const camera=createFreeCamera({x:0,y:0,z:-10},{x:0,y:0,z:0});camera.target.x=2;`, /static camera/],
        [`${setup} const camera=createFreeCamera({x:0,y:0,z:-10},{x:0,y:0,z:0});const scene=createSceneContext(engine);attachFreeControl(camera,scene);`, /static camera/],
        [`${setup} const scene=createSceneContext(engine);const first=createFreeCamera({x:0,y:0,z:-10},{x:0,y:0,z:0});const second=createFreeCamera({x:0,y:0,z:-20},{x:0,y:0,z:0});scene.camera=first;onBeforeRender(scene,()=>{scene.camera=second;});`, /static camera/],
        [`const scene=createSceneContext(engine);const camera=createFreeCamera({x:0,y:0,z:-10},{x:0,y:0,z:0});const alias=scene;function replace(){alias.camera=camera;}onBeforeRender(scene,()=>replace());${setup}`, /static camera/],
        [`${setup} const first=createSceneContext(engine);const second=createSceneContext(engine);await registerScene(first);await registerScene(second);`, /one registered scene/],
        [`${setup} const scene=createSceneContext(engine);disposeScene(scene);`, /binding topology/],
        [`${setup} const scene=createSceneContext(engine);unregisterScene(scene);`, /binding topology/],
        [`${setup} const scene=createSceneContext(engine);rebuildSceneRenderables(scene);`, /binding topology/],
        [`${setup} const scene=createSceneContext(engine,{defaultRenderTask:false});addTextRenderable(scene,r);await registerScene(scene);`, /default scene render task/],
        [`const scene=createSceneContext(engine,{defaultRenderTask:false});${setup}addTextRenderable(scene,r);await registerScene(scene);`, /default scene render task/],
    ] as const) assert.throws(() => compile(body), diagnostic);
});

test("text projection refuses mixed draw and custom task families in either feature order", () => {
    for (const feature of ["material:standard", "material:no-color-view", "loader:splat", "particle:node",
        "sprite:billboard", "renderer:sprite", "renderer:frame-graph", "renderer:post-process",
        "background:ground", "camera:arc-rotate", "camera:geospatial", "platform:workers"]) {
        for (const features of [["core", "text:renderable", feature], ["core", feature, "text:renderable"]])
            assert.throws(() => emitUpstreamGenerated(resolve(directory, "refused"), features), /merged draw ordering or camera\/task transport/);
    }
});

test("text owner classification preserves existing splat components and imported root bulk transforms", () => {
    for (const id of [125, 269]) {
        const sourcePath = `corpus/babylon-lite/lab/lite/src/lite/scene${id}.ts`;
        const result = compileSource(readFileSync(sourcePath, "utf8"), { fileName: sourcePath });
        assert.ok(!result.manifest.features.some((feature) => feature.startsWith("text:")));
        assert.match(result.cpp, id === 125 ? /\.position\.y = 1\.7f/ : /set_asset_root_position\(/);
    }
});

test("exact text source projects unchanged shaders, observed descriptors and compilable native declarations", async (t) => {
    const output = resolve(directory, "exact");
    execFileSync(process.execPath, ["dist/src/cli.js", "corpus/babylon-lite/lab/lite/src/lite/scene275.ts", "--out", output], {stdio:"pipe"});
    const pipelines = await composeDefaultTextPipelines();
    const composition = JSON.parse(readFileSync(resolve(output, "upstream/shaders/composition.json"), "utf8")) as {
        modules: Array<{ output:string;entryPoint:string;pinnedBindings:boolean;constants?:unknown }>;
    };
    for (const [index, pipeline] of pipelines.entries()) for (const stage of ["vertex", "fragment"] as const) {
        const path = `upstream/shaders/text-${index}.${stage === "vertex" ? "vert" : "frag"}.native.wgsl`;
        const module = composition.modules.find((row) => row.output === path)!;
        assert.ok(module);
        assert.equal(readFileSync(resolve(output, path), "utf8"), pipeline.descriptor[stage].module.code);
        assert.equal(module.entryPoint, pipeline.descriptor[stage].entryPoint);
        assert.equal(module.pinnedBindings, true);
        assert.deepEqual(module.constants, stage === "vertex" ? pipeline.vertexConstants : pipeline.fragmentConstants);
    }
    assert.match(readFileSync(resolve(output, "upstream/include/bblite/upstream/camera_change_key.hpp"), "utf8"), /scene_camera_change_key/);
    assert.ok(readFileSync(resolve(output, "upstream/include/bblite/upstream_text_gpu.hpp"), "utf8").includes("ensure_text_gpu"));
    const dataSource = readFileSync(resolve(output, "upstream/src/text_data.cpp"), "utf8");
    const payloadReads = [...dataSource.matchAll(/bbl::pal::read_binary_file\(([^\n]+?)\)/g)];
    assert.ok(payloadReads.length > 0);
    assert.ok(payloadReads.every((match) => match[1]!.startsWith("bbl::asset_path(")), "Every text payload resolves under the executable assets directory");
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable"); return; }
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/c", "/DBBLITE_HAS_TEXT=1",
        `/I${resolve("native/include")}`, `/I${resolve(output, "upstream/include")}`, `/Fo${output}\\`,
        resolve(output, "main.cpp"), resolve(output, "upstream/src/text_data.cpp")]);
    const typeOnly = compileSource(`import {createEngine,type TextData,type TextRenderable} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const data:TextData[]=[];const entities:TextRenderable[]=[];
        if(data.length!==entities.length)throw new Error("empty");}`);
    assert.ok(!typeOnly.manifest.features.some((feature) => feature.startsWith("text:")));
    writeFileSync(resolve(directory, "type-only.cpp"), typeOnly.cpp);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/c", `/I${resolve("native/include")}`,
        resolve(directory, "type-only.cpp"), `/Fo${resolve(directory, "type-only.obj")}`]);
});
