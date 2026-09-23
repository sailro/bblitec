import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("async record results retain object identity and independent method captures", (t) => {
    const directory = resolve("artifacts/async-record-result-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
    const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"}); worker.terminate();
    interface Counter { values: number[]; bump(delta:number):number; read():number; }
    async function make(seed:number):Promise<Counter> {
        await Promise.resolve();
        let count=seed;
        const values:number[]=[];
        return {values, bump(delta:number) {count+=delta; values.push(count); return count;}, read(){return count;}};
    }
    async function main() {
        const pending=make(2);
        const first=await pending;
        const alias=await pending;
        const second=await make(10);
        if(first!==alias || first===second) throw new Error("result identity");
        if(first.bump(3)!==5 || alias.read()!==5 || second.read()!==10) throw new Error("method captures");
        if(alias.values[0]!==5 || second.values.length!==0) throw new Error("array identity");
        second.bump(4);
        if(first.read()!==5 || second.read()!==14) throw new Error("independent captures");
        globalThis.close();
    }
    void main();
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        result.cpp +
            `
namespace bbl::pal {
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_UI=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("owned async records store opaque assets without changing synchronous record specialization", () => {
    const result = compileSource(`
        import {createEngine, loadGltf, waitForGpuIdle, type EngineContext,
            type AssetContainer, type SceneNode} from "@babylonjs/lite";
        interface Loaded {readonly asset: AssetContainer; readonly root: SceneNode; move(y:number):void;}
        async function load(engine: EngineContext): Promise<Loaded> {
            const asset = await loadGltf(engine, "model.glb");
            const root = asset.entities.find(entity => !("lightType" in entity))!;
            return {asset, root, move(y:number) { root.position.y = y; }};
        }
        async function main() {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const loaded = await load(engine);
            loaded.move(3);
            await waitForGpuIdle(engine);
        }
        void main();
    `);
    assert.match(result.cpp, /bbl::AssetHandle asset/);
    assert.match(result.cpp, /bbl::SceneNodeHandle root/);
    assert.match(result.cpp, /set_asset_root_position/);
});

test("awaited file textures retain the owned texture carrier through helper and promise results", () => {
    const result = compileSource(`
        import {createEngine, loadTexture2D, waitForGpuIdle, type EngineContext} from "@babylonjs/lite";
        async function load(engine: EngineContext) {
            const texture = await loadTexture2D(engine, "foam.png");
            return texture;
        }
        async function main() {
            const engine = await createEngine(document.querySelector("canvas")!);
            const pending = load(engine);
            const texture = await pending;
            const again = await pending;
            if (texture !== again) throw new Error("texture result");
            await waitForGpuIdle(engine);
        }
        void main();
    `);
    assert.match(result.cpp, /Promise<bbl::StoredTexture>/);
    assert.match(result.cpp, /load_file_texture/);
});

test("async records own arrays of opaque material handles", () => {
    const result = compileSource(`
        import {createEngine,createPbrMaterial,waitForGpuIdle,type PbrMaterialProps} from "@babylonjs/lite";
        interface Materials {readonly all: readonly PbrMaterialProps[];}
        async function make():Promise<Materials> {
            await Promise.resolve(0);
            const material=createPbrMaterial({metallicFactor:0,roughnessFactor:1});
            const all=[material] as const;
            return {all};
        }
        async function main(){
            const engine=await createEngine(document.querySelector("canvas")!);
            const materials=await make();
            if(materials.all.length!==1) throw new Error("material array");
            await waitForGpuIdle(engine);
        }
        void main();
    `);
    assert.match(result.cpp, /Array<bbl::MaterialHandle> all/);
});
