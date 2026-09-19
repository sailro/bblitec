import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("typed module bindings retain dynamic replacements and the aliases of earlier values", (t) => {
    const directory = resolve("artifacts/dynamic-binding-storage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    writeFileSync(
        join(directory, "settings.ts"),
        `
        export interface Settings { gain:number; nested:{enabled:boolean}; }
        export let initializations=0;
        function initialize():Settings {initializations++;return {gain:2,nested:{enabled:true}};}
        export const defaults=initialize();
        let active:Settings=defaults;
        export const initial=active;
        export function install(value:Settings):void {active=value;}
        export function current():Settings {return active;}
        export function read():number {return active.gain;}
        export function adjust(value:number):void {active.gain=value;}
    `,
    );
    const result = compileSource(
        `
        import {defaults,initial,initializations,install,current,read,adjust,type Settings} from "./settings.js";
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        function local(value:Settings):()=>Settings {
            let active:Settings=defaults;
            const observe=()=>active;
            active=value;
            return observe;
        }
        void(async()=>{
            if(initializations!==1||read()!==2||initial!==defaults||current()!==defaults)throw new Error("initial object identity or effects");
            const changed=JSON.parse('{"gain":7,"nested":{"enabled":false},"extra":19}');
            await Promise.resolve();
            install(changed);
            if(current()!==changed||read()!==7||current().nested.enabled)throw new Error("replacement identity or values");
            adjust(9);
            if(changed.gain!==9||defaults.gain!==2||initial.gain!==2)throw new Error("replacement writes or old aliases");
            if(JSON.stringify(current())!==JSON.stringify(changed))throw new Error("replacement lost untyped properties");
            if(local(changed)()!==changed)throw new Error("shadowed binding or escaped capture");
            install(defaults);
            if(current()!==defaults||read()!==2||initializations!==1)throw new Error("default rebinding");
            defaults.gain=3;
            if(read()!==3||initial.gain!==3)throw new Error("default view lost original writes");
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/I",
        "native/include",
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
