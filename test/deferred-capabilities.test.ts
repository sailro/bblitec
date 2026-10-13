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
    const source = `try { prompt("first"); prompt("second"); } catch { }`;
    const result = compileSource(source, { deferredCapabilities });
    const sites = result.manifest.deferredCapabilities!;
    assert.deepEqual(
        sites.map((site) => site.id),
        ["dom:prompt", "dom:prompt"],
    );
    for (const site of sites) {
        assert.equal(site.kind, "CallExpression");
        assert.match(source.slice(site.start, site.end), /^prompt\(/);
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
            compileSource(
                `prompt("first"); new FinalizationRegistry(() => {});`,
                {
                    deferredCapabilities,
                },
            ),
        /Unsupported constructor/,
    );
    const ordinary = `let x=1; x+=2; if(x!==3)throw new Error("ordinary");`;
    assert.deepEqual(compileSource(ordinary), compileSource(ordinary, {}));
    assert.equal(
        compileSource(ordinary).manifest.deferredCapabilities,
        undefined,
    );
});

test("admitted base64, structured clone and session storage stay authoritative", () => {
    const source = `
        function dataUrlToBytes(url: string): Uint8Array | null {
            const comma = url.indexOf(",");
            if (comma < 0) return null;
            const bin = atob(url.slice(comma + 1));
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
            let bin = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
            return \`data:\${mime};base64,\${btoa(bin)}\`;
        }
        interface Placement { readonly host?: { readonly id: number }; readonly key: string; readonly tint?: readonly [number, number, number] }
        const placement: Placement = { key: "house:7", tint: [1, 0.5, 0.25], host: { id: 3 } };
        const { tint: _tint, ...bake } = placement;
        const copy = structuredClone(bake);
        const bytes = dataUrlToBytes(bytesToDataUrl(new Uint8Array([0, 255, 128]), "application/zip"))!;
        if (bytes.length !== 3 || bytes[1] !== 255 || bytes[2] !== 128) throw new Error("base64");
        if (window.atob(window.btoa("ab")) !== "ab" || globalThis.structuredClone([1])[0] !== 1) throw new Error("global members");
        if (copy.key !== "house:7" || copy.host === bake.host || copy.host!.id !== 3 || "tint" in copy) throw new Error("clone");
        if (typeof sessionStorage === "undefined") throw new Error("session availability");
        window.sessionStorage.setItem("pending", "1");
        if (sessionStorage.getItem("pending") !== "1") throw new Error("session");
        globalThis.close();
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /bbl::js::string_from_base64\(/);
    assert.match(result.cpp, /bbl::js::string_to_base64\(/);
    assert.match(result.cpp, /bbl::js::structured_clone\(/);
    assert.match(result.cpp, /bbl::js::session_storage_object\(\)/);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler is required.");
    runGeneratedProgram(tools, "deferred-capabilities/admitted", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        expectedOutput: "",
        timeoutMs: 10000,
    });
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
        try{prompt(argument("c"));}catch{++catches;}
        try{prompt(argument("d"));}catch{++catches;}
        try{confirm(argument("e"));}catch{++catches;}
        try{alert(argument("f"));}catch{++catches;}
        try{prompt(argument("g"));}catch{++catches;}
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
        `function prompt(value?:string):string|null{return value??null;}`,
        `const prompt=(value?:string):string|null=>value??null;`,
        `const local:typeof globalThis.prompt=(value?:string):string|null=>value??null;`,
    ]) {
        const name = declaration.includes("const local") ? "local" : "prompt";
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
        function later():void { ++calls; if(enabled)prompt("deferred"); }
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
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_HAS_UI=1"],
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
            const pending=document.exitFullscreen();
            const handled=pending.catch(error=>{
                if(synchronous||!error.message.includes("dom:Document.exitFullscreen"))throw new Error("rejection timing");
                ++reactions;
            });
            synchronous=false;
            try{await pending;}catch{}
            await handled;
            try{await document.exitFullscreen();}catch{++reactions;}
            if(reactions!==2)throw new Error("rejections");
            // Blob reads are native.
            if(await new Blob(["payload"]).text()!=="payload")throw new Error("blob text");
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
        Engine& window_document_engine() { static Engine engine; return engine; }
        int run_window_application(WorkerEntry initialize, EngineOptions) {
            const js::RealmScope scope;
            EventLoop loop;
            WorkerRealm realm(loop, "");
            loop.run([&] { initialize(realm); });
            return 0;
        }
        }
    `,
        { flags: ["/DBBLITE_WORKERS=1"], expectedOutput: "", timeoutMs: 10000 },
    );
});

test("pinned public missing calls preserve engine arguments and original strict refusal", () => {
    const source = `
        import {createEngine,setGpuTimingEnabled} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        try{setGpuTimingEnabled(engine,true);}catch{}
    `;
    assert.throws(
        () => compileSource(source),
        /setGpuTimingEnabled.*not supported/,
    );
    const result = compileSource(source, { deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.id),
        ["babylon:setGpuTimingEnabled"],
    );
    assert.match(result.cpp, /deferred_capability<void>/);
});

test("pinned geometry descriptor batch retains declared result shapes", () => {
    const operations = [
        "disposeMeshGpu(mesh)",
        "enableThinInstanceDynamicDrawCount(mesh)",
        "setThinInstanceDrawCount(mesh,2)",
        "setVatTime(engine,mesh,1)",
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
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => site.id),
        ["babylon:setVatTime"],
    );
    assert.match(result.cpp, /bbl::dispose_mesh_gpu\(/);
    assert.match(result.cpp, /bbl::enable_thin_instance_dynamic_draw_count\(/);
    assert.match(result.cpp, /bbl::set_thin_instance_draw_count\(/);
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
        try{const result=prompt("first");throw new Error("fabricated "+String(result));}
        catch(error){if(!error.message.includes("dom:prompt"))throw error;++caught;}
        try{const result=prompt("second","default");if(result===null||result.length>=0)throw new Error("fabricated result");}
        catch(error){if(!error.message.includes("dom:prompt"))throw error;++caught;}
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
        `let caught=0;try{prompt("worker");}catch{++caught;}self.postMessage(caught);self.close();`,
    );
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.addEventListener("message",(event:MessageEvent<number>)=>{
            if(event.data!==1)throw new Error("worker trap did not execute");
            globalThis.close();
        });
        try{prompt("window");}catch{}
    `,
        { fileName: resolve(directory, "entry.ts"), deferredCapabilities },
    );
    assert.deepEqual(
        result.manifest.deferredCapabilities
            ?.map((site) => [site.id, site.realm])
            .sort(),
        [
            ["dom:prompt", "window"],
            ["dom:prompt", "worker"],
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
            flags: ["/DBBLITE_WORKERS=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        },
    );
});
