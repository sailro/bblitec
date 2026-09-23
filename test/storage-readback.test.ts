import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerStorageBuffer } from "../src/lowering/storage-buffer-lowerer.js";
import { lowerStorageReadback } from "../src/lowering/storage-readback-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("storage readback source coalesces, serializes, reuses staging and rejects invalid lifetimes", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/storage-readback-check");
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe"),
        context = new LoweringContext();
    writeFileSync(
        file,
        [
            lowerStorageBuffer(context, true).source,
            lowerStorageReadback(context).source,
            readFileSync("test/fixtures/storage-readback-check.cpp", "utf8"),
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
        file,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
test("readStorageBuffer retains ArrayBuffer promises through typed wrappers", () => {
    const result = compileSource(`
import {createEngine,createStorageBuffer,readStorageBuffer} from "@babylonjs/lite";
async function main(){
 const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const buffer=createStorageBuffer(engine,64,{writable:true});
 const read=(value:ReturnType<typeof createStorageBuffer>)=>readStorageBuffer(value,4,16);
 const bytes=await read(buffer);const values=new Float32Array(bytes);console.log(values[0]);
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:storage-readback"));
    assert.match(result.cpp, /read_gpu_storage_buffer/);
});
