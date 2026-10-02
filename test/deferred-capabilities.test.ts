import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

test("deferred calls retain all source sites and later compiler diagnostics", () => {
    const source = `try { atob("first"); btoa("second"); } catch { }`;
    const result = compileSource(source, { deferredCapabilities });
    const sites = result.manifest.deferredCapabilities!;
    assert.deepEqual(
        sites.map((site) => site.id),
        ["dom:atob", "dom:btoa"],
    );
    for (const site of sites) {
        assert.equal(site.kind, "CallExpression");
        assert.match(source.slice(site.start, site.end), /^(atob|btoa)\(/);
        assert.equal(
            site.sourceSha256,
            createHash("sha256").update(source).digest("hex"),
        );
        assert.equal(
            site.signatureHash,
            createHash("sha256").update(site.signature).digest("hex"),
        );
    }
    assert.throws(
        () =>
            compileSource(`atob("first"); new Proxy({}, {});`, {
                deferredCapabilities,
            }),
        /Unsupported constructor/,
    );
    const ordinary = `let x=1; x+=2; if(x!==3)throw new Error("ordinary");`;
    assert.deepEqual(compileSource(ordinary), compileSource(ordinary, {}));
    assert.equal(
        compileSource(ordinary).manifest.deferredCapabilities,
        undefined,
    );
});

test("deferred scalar calls throw clearly after arguments and preserve recovery", () => {
    const source = `
        let order=""; let catches=0;
        function argument(value:string):string { order+=value; return value; }
        try { prompt(argument("a"),argument("b")); } catch(error) {
            if(!error.message.includes("dom:prompt"))throw new Error("capability identity");
            ++catches;
        }
        if(order!=="ab")throw new Error("argument order");
        try{atob(argument("c"));}catch{++catches;}
        try{btoa(argument("d"));}catch{++catches;}
        try{confirm(argument("e"));}catch{++catches;}
        try{alert(argument("f"));}catch{++catches;}
        try{structuredClone({value:argument("g")});}catch{++catches;}
        if(order!=="abcdefg"||catches!==6)throw new Error("trap recovery");
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.equal(result.manifest.deferredCapabilities?.length, 6);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(
        tools,
        "Native fixture compiler is required for deferred runtime tests.",
    );
    runGeneratedProgram(tools, "deferred-capabilities/scalars", result.cpp, {
        expectedOutput: "",
    });
});

test("authored same-name and library-typed functions are not deferred", () => {
    for (const declaration of [
        `function atob(value:string):string{return value;}`,
        `const atob=(value:string):string=>value;`,
        `const local:typeof globalThis.atob=(value:string):string=>value;`,
    ]) {
        const name = declaration.includes("const local") ? "local" : "atob";
        const result = compileSource(
            `${declaration}if(${name}("authored")!=="authored")throw new Error("authored");`,
            { deferredCapabilities },
        );
        assert.equal(result.manifest.deferredCapabilities, undefined);
        assert.doesNotMatch(result.cpp, /deferred_capability/);
    }
});

test("authored callables typed as DOM methods preserve their implementation", () => {
    const result = compileSource(
        `
        let hits=0;
        const own:Window["alert"]=(message)=>{if(message!=="call")throw new Error("argument");++hits;};
        own("call");
        const record:{alert:Window["alert"]}={alert:own};
        const mapped:Pick<Window,"alert">={alert:own};
        let reads=0;
        function selected():Pick<Window,"alert">{++reads;return mapped;}
        record.alert("call");
        selected().alert("call");
        if(hits!==3||reads!==1)throw new Error("authored method identity");
    `,
        { deferredCapabilities },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-capabilities/authored-method",
        result.cpp,
        { expectedOutput: "" },
    );
});

test("deferred calls inside authored callbacks retain lazy activation", () => {
    const result = compileSource(
        `
        let enabled=false; let calls=0; let caught=0;
        function later():void { ++calls; if(enabled)atob("deferred"); }
        const callback=()=>later();
        if(calls!==0)throw new Error("eager callback");
        callback();
        if(calls!==1)throw new Error("first callback");
        enabled=true;
        try{callback();}catch{++caught;}
        if(calls!==2||caught!==1)throw new Error("lazy trap");
    `,
        { deferredCapabilities },
    );
    assert.equal(result.manifest.deferredCapabilities?.length, 1);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-capabilities/lazy", result.cpp, {
        expectedOutput: "",
    });
});

test("optional Window receivers suppress arguments and deferred failures", () => {
    const result = compileSource(
        `
        const targets:Array<Window|null>=[null,window];
        let argumentsRun=0; let caught=0;
        for(let i=0;i<targets.length;i++) {
            try{targets[i]?.alert(++argumentsRun);}catch{++caught;}
        }
        if(argumentsRun!==1||caught!==1)throw new Error("optional receiver");
        globalThis.close();
    `,
        { deferredCapabilities },
    );
    assert.equal(result.manifest.deferredCapabilities?.length, 1);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-capabilities/optional",
        result.cpp +
            `
        namespace bbl::pal {
        Engine& window_document_engine() { static Engine engine; return engine; }
        int run_window_application(WorkerEntry initialize, EngineOptions) {
            const js::RealmScope scope;
            EventLoop loop;
            WorkerRealm realm(loop);
            loop.run([&] { initialize(realm); });
            return 0;
        }
        }
    `,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_HAS_UI=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});

test("deferred promise methods reject on the realm reaction queue", () => {
    const result = compileSource(
        `
        async function main():Promise<void>{
            let synchronous=true; let reactions=0;
            const pending=new Blob(["payload"]).text();
            const handled=pending.catch(error=>{
                if(synchronous||!error.message.includes("dom:Blob.text"))throw new Error("rejection timing");
                ++reactions;
                return "recovered";
            });
            synchronous=false;
            try{await pending;}catch{}
            await handled;
            try{await new Blob(["payload"]).arrayBuffer();}catch{++reactions;}
            if(reactions!==2)throw new Error("rejections");
            globalThis.close();
        }
        void main();
    `,
        { deferredCapabilities },
    );
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.timing),
        ["reject", "reject"],
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-capabilities/promises",
        result.cpp +
            `
        namespace bbl::pal {
        int run_window_application(WorkerEntry initialize, EngineOptions) {
            const js::RealmScope scope;
            EventLoop loop;
            WorkerRealm realm(loop, "");
            loop.run([&] { initialize(realm); });
            return 0;
        }
        }
    `,
        { defines: ["BBLITE_WORKERS=1"], expectedOutput: "", timeoutMs: 10000 },
    );
});

test("pinned public missing calls preserve engine arguments and original strict refusal", () => {
    const source = `
        import {createEngine,enableAsyncShaderPipelineCompilation,setGpuTimingEnabled} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        try{enableAsyncShaderPipelineCompilation(engine);}catch{}
        try{setGpuTimingEnabled(engine,true);}catch{}
    `;
    assert.throws(
        () => compileSource(source),
        /enableAsyncShaderPipelineCompilation.*not supported/,
    );
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.id),
        [
            "babylon:enableAsyncShaderPipelineCompilation",
            "babylon:setGpuTimingEnabled",
        ],
    );
    assert.match(result.cpp, /deferred_capability<void>/);
});

test("pinned matrix and geometry descriptor batch retains declared result shapes", () => {
    const operations = [
        "disposeMeshGpu(mesh)",
        "enableThinInstanceDynamicDrawCount(mesh)",
        "setThinInstanceDrawCount(mesh,2)",
        "setVatTime(engine,mesh,1)",
        "updateMeshColors(engine,mesh,bytes)",
        "updateMeshNormals(engine,mesh,bytes)",
        "updateMeshTangents(engine,mesh,bytes)",
        "updateMeshUv2(engine,mesh,bytes)",
        "updateMeshGeometry(engine,mesh,bytes,bytes,new Uint32Array([0]))",
        "updateMeshGeometryCapacity(engine,mesh,bytes,bytes,new Uint32Array([0]))",
        "getViewMatrix(camera)",
        "getProjectionMatrix(camera,1)",
    ];
    const result = compileSource(
        `
        import * as api from "@babylonjs/lite";
        const engine=await api.createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const mesh=api.createSphere(engine,{diameter:1});
        const camera=api.createFreeCamera([0,0,1],[0,0,0]);
        const bytes=new Float32Array([0,1,2]);
        ${operations.map((operation) => `try{api.${operation};}catch{}`).join("\n")}
    `,
        { deferredCapabilities },
    );
    assert.equal(
        result.manifest.deferredCapabilities?.length,
        operations.length,
    );
    assert.match(result.cpp, /deferred_capability<bbl::js::F32Array>/);
    assert.match(
        result.cpp,
        /deferred_capability<bblscene::MeshGeometryCapacityResult>/,
    );
});

test("deferred result templates never construct successful payloads", () => {
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-capabilities/uninhabited-result",
        `
        #include <bblite/deferred_capability.hpp>
        struct NoSuccessfulValue { NoSuccessfulValue() = delete; };
        int main() {
            try {
                [[maybe_unused]] const auto value = bbl::deferred_capability<NoSuccessfulValue>("fixture:result", "result.ts:1:1");
                return 1;
            } catch (const bbl::DeferredCapabilityError& error) {
                return std::string(error.what()).find("fixture:result") == std::string::npos ? 2 : 0;
            }
        }
    `,
        { expectedOutput: "" },
    );
    const result = compileSource(
        `
        let caught=0;
        try{const result=structuredClone(new Float32Array([1,2]));if(result[0]===1)throw new Error("fabricated array");}
        catch(error){if(!error.message.includes("dom:structuredClone"))throw error;++caught;}
        try{const result=structuredClone({value:3,label:"payload"});if(result.value===3)throw new Error("fabricated record");}
        catch(error){if(!error.message.includes("dom:structuredClone"))throw error;++caught;}
        if(caught!==2)throw new Error("typed failures");
    `,
        { deferredCapabilities },
    );
    runGeneratedProgram(
        tools,
        "deferred-capabilities/owned-results",
        result.cpp,
        { expectedOutput: "" },
    );
});

test("deferred engine arguments retain ordinary checked reads", () => {
    const result = compileSource(
        `
        import {createEngine,setGpuTimingEnabled} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const engines=[engine];
        let index=0; let caught=0;
        try{setGpuTimingEnabled(engines[++index]!,true);}catch(error){
            if(error.message.includes("Deferred native capability"))throw new Error("argument read was dropped");
            ++caught;
        }
        if(index!==1||caught!==1)throw new Error("argument effects");
    `,
        { deferredCapabilities },
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-capabilities/engine-arguments",
        result.cpp +
            `
        namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
    `,
        { expectedOutput: "" },
    );
});

test("worker application manifests join all deferred realm sites", () => {
    const directory = resolve("artifacts/deferred-capabilities/worker-sites");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "worker.ts"),
        `let caught=0;try{btoa("worker");}catch{++caught;}self.postMessage(caught);self.close();`,
    );
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.addEventListener("message",(event:MessageEvent<number>)=>{
            if(event.data!==1)throw new Error("worker trap did not execute");
            globalThis.close();
        });
        try{atob("window");}catch{}
    `,
        { fileName: resolve(directory, "entry.ts"), deferredCapabilities },
    );
    assert.deepEqual(
        result.manifest.deferredCapabilities
            ?.map((site) => [site.id, site.realm])
            .sort(),
        [
            ["dom:atob", "window"],
            ["dom:btoa", "worker"],
        ],
    );
    assert.equal(
        new Set(result.manifest.deferredCapabilities?.map((site) => site.file))
            .size,
        2,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-capabilities/worker-sites",
        result.cpp,
        {
            defines: ["BBLITE_WORKERS=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});
