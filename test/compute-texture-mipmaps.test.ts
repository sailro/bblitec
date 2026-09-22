import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeTextureMipmaps } from "../src/lowering/compute-texture-mipmaps-lowerer.js";
import { lowerComputeFrameGraph } from "../src/lowering/compute-frame-graph-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute texture mip tasks retain source arrays and graph ownership", () => {
    const result = compileSource(`
import {createEngine,createSceneContext,createComputeStorageTexture,createComputeStorageTextureMipmapsTask,addTaskAtStart} from '@babylonjs/lite';
async function main(){
 const engine=await createEngine(document.createElement('canvas'));
 const texture=await createComputeStorageTexture(engine,{width:16,viewDimension:'2d',format:'rgba8unorm',mipMaps:true});
 const resources=[texture];
 const task=createComputeStorageTextureMipmapsTask('mipmaps',resources);
 const scene=createSceneContext(engine);addTaskAtStart(scene,task);
 task.dispose();
} void main();`);
    assert.ok(result.manifest.features.includes("compute:texture-mipmaps"));
    assert.match(result.cpp, /create_compute_storage_texture_mipmaps_task/);
});

test("source mip task validates, prepares once, records ordered levels, and retains disposal semantics", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-texture-mipmaps-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe"),
        context = new LoweringContext();
    writeFileSync(
        cpp,
        [
            lowerComputeTextureMipmaps(context).source,
            lowerComputeFrameGraph(context).source,
            readFileSync(
                resolve("test/fixtures/compute-texture-mipmaps-check.cpp"),
                "utf8",
            ),
        ].join("\n"),
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
