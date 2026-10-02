import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    nativeFixtureVcpkgRoot,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("contextual maps store mesh and scene-node unions through the shared node handle", () => {
    const result = compileSource(`
        import type {Mesh, SceneNode, PhysicsBody} from "babylon-lite";
        interface Body {readonly body:PhysicsBody; readonly mesh:Mesh|SceneNode;}
        interface State {readonly bodies:Map<PhysicsBody,Body>;}
        function create():State {return {bodies:new Map()};}
        const state=create();
        state.bodies.clear();
    `);
    assert.match(result.cpp, /bbl::SceneNodeHandle mesh/);
    assert.match(result.cpp, /Map<bbl::upstream::PhysicsBody/);
});

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
    const events: number[] = [];
    async function dictionary(): Promise<Record<string,number>> {
        const definitions = [["first",2],["second",3]] as const;
        const pairs = await Promise.all(definitions.map(async ([name, value]) => {
            events.push(value);
            const resolved = await Promise.resolve(value * 2);
            events.push(resolved);
            return [name, resolved] as const;
        }));
        return Object.fromEntries(pairs);
    }
    async function main() {
        async function parsed(text:string):Promise<Record<string,{count:number}>> {
            await Promise.resolve();
            try {return JSON.parse(text) as Record<string,{count:number}>;}catch{return {};}
        }
        async function parsedList(text:string):Promise<{count:number}[]> {
            await Promise.resolve();
            try {return JSON.parse(text) as {count:number}[];}catch{return [];}
        }
        const parsedPending=parsed('{"x":{"count":2,"extra":4}}');
        const parsedValue=await parsedPending;
        const parsedAlias=await parsedPending;
        const missingParsed=await parsed("{");
        parsedAlias.x!.count++;
        if(parsedValue!==parsedAlias||JSON.stringify(parsedValue)!=='{"x":{"count":3,"extra":4}}'||Object.keys(missingParsed).length!==0)
            throw new Error("async dictionary document");
        const parsedRows=await parsedList('[{"count":1,"extra":4}]');
        const missingRows=await parsedList("[");
        parsedRows[0]!.count=2;
        if(JSON.stringify(parsedRows)!=='[{"count":2,"extra":4}]'||missingRows.length!==0)
            throw new Error("async array document");
        interface Document {count: number; nested: {label:string};}
        const document = JSON.parse('{"count":2,"nested":{"label":"first"}}') as Document;
        async function documentResult(): Promise<{document: Document}> {return {document};}
        const wrappedDocument = await documentResult();
        document.count = 7;
        wrappedDocument.document.nested.label = "changed";
        if (wrappedDocument.document !== document || wrappedDocument.document.count !== 7 || document.nested.label !== "changed")
            throw new Error("JSON result identity");
        const dictionaryPromise = dictionary();
        const entries = await dictionaryPromise;
        const entriesAlias = await dictionaryPromise;
        if (entries !== entriesAlias || entries.first !== 4 || entries.second !== 6)
            throw new Error("dictionary results");
        if (events.join(",") !== "2,3,4,6") throw new Error("parallel map activations");
        if (Object.keys(await dictionary()).join(",") !== "first,second" ||
            Object.values(await dictionary()).join(",") !== "4,6")
            throw new Error("awaited projection arguments");
        if (events.join(",") !== "2,3,4,6,2,3,4,6,2,3,4,6")
            throw new Error("awaited projection activation count");
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
    const tools = optionalNativeFixtureTools();
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
        `/external:I${resolve(nativeFixtureVcpkgRoot, "include")}`,
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
    // A realm decodes the image in a native job; the load settles its promise.
    assert.match(result.cpp, /co_await bbl::pal::load_realm_file_texture\(/);
});

test("async texture payloads preserve nullable snapshots, tuple leaves and factory counts", (t) => {
    const directory = resolve("artifacts/async-texture-payloads");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        import {createEngine,createSolidTexture2D,type Texture2D} from "@babylonjs/lite";
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        const engine=await createEngine(new OffscreenCanvas(1,1));
        const original=createSolidTexture2D(engine,.25,.5,.75,1);
        let calls=0;
        async function make():Promise<Texture2D> {
            await Promise.resolve();
            calls++;
            return createSolidTexture2D(engine,.25,.5,.75,1);
        }
        async function retained(value:Texture2D|null):Promise<Texture2D|null> {
            await Promise.resolve();
            return value;
        }
        const selection:{current:Texture2D|null}={current:original};
        const present=retained(selection.current);
        selection.current=null;
        const absent=retained(selection.current);
        selection.current=original;
        if(await present!==original || await absent!==null) throw new Error("texture argument snapshot");
        const boxed=await Promise.resolve(original);
        const fresh=await make();
        if(boxed!==original || fresh===original || calls!==1) throw new Error("texture boxing and factory count");
        async function pair(value:Texture2D|null):Promise<readonly [Texture2D,Texture2D|null]> {
            await Promise.resolve();
            return [original,value] as const;
        }
        const [first,second]=await pair(null);
        if(first!==original || second!==null) throw new Error("texture tuple payload");
        const textures:Texture2D[]=[original];
        async function selected(index:number):Promise<Texture2D|undefined> {
            return textures[index];
        }
        if(await selected(0)!==original || await selected(1)!==undefined)
            throw new Error("texture indexed presence");
        async function describe([label,texture]:readonly [string,Texture2D|null]):Promise<string> {
            const read=()=>texture;
            await Promise.resolve();
            return label+(read()===original?":present":":absent");
        }
        const rows=[["first",original],["second",null]] as const;
        const descriptions=await Promise.all(rows.map(describe));
        if(descriptions.join(",")!=="first:present,second:absent")
            throw new Error("optional texture tuple argument captures");
        const reaction=await Promise.resolve(["reaction",original] as const).then(async ([label,texture])=>{
            await Promise.resolve();
            return describe([label,texture]);
        });
        if(reaction!=="reaction:present")throw new Error("texture tuple reaction captures");
        globalThis.close();
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const factory = new FactoryLowerer(
        new LoweringContext(),
    ).lowerFileTextureFactory().source;
    runGeneratedProgram(
        tools,
        "async-texture-payloads",
        `
#include <bblite/pal_async_engine.hpp>
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
    return std::make_shared<Engine>();
}
}
${result.cpp}
namespace bbl {
${cppFunction(factory, "[[maybe_unused]] static TextureData solid_texture_data(")}
${cppFunction(factory, "[[maybe_unused]] static FileTexture retained_solid_texture(")}
${cppFunction(factory, "SolidTexture create_solid_texture(")}
${cppFunction(factory, "FileTexture solid_texture_file(")}
}
`,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
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
