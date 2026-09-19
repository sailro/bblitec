import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("generic optional promise results retain identity, aliases and reaction order", (t) => {
    const directory = resolve("artifacts/generic-optional-promise");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        function maybe<T>(skip:boolean,run:()=>Promise<T>):Promise<T|undefined> {
            if(skip)return Promise.resolve(undefined);
            return run();
        }
        void(async()=>{
            const flags:boolean[]=[false,true];
            const original=Promise.resolve(7);
            const view=maybe(flags[0]!,()=>original);
            const stored:Promise<number|undefined>=original;
            if(view!==original||stored!==original)throw new Error("promise result view identity");
            const order:string[]=[];
            original.then(()=>{order.push("first");});
            queueMicrotask(()=>{order.push("middle");});
            view.then(value=>{if(value!==7)throw new Error("view value");order.push("last");});
            await Promise.resolve();
            if(order.join(",")!=="first,middle,last")throw new Error("view reaction ordering");
            let calls=0;
            const absent=maybe(flags[1]!,()=>{calls++;return original;});
            if(await absent!==undefined||calls!==0||await stored!==7)throw new Error("optional result effects");
            const rows:Array<{score:number}>=[{score:3}];
            const record=await maybe(flags[0]!,()=>Promise.resolve(rows[0]!));
            if(!record||record!==rows[0])throw new Error("generic record result");
            record.score=9;
            if(rows[0]!.score!==9)throw new Error("generic record alias");
            if(await maybe(flags[0]!,()=>Promise.resolve("ready"))!=="ready")throw new Error("generic string result");
            const optional:Promise<number|undefined>=Promise.resolve(undefined);
            if(await maybe(flags[0]!,()=>optional)!==undefined)throw new Error("nested optional result");
            if(await optional||!(await original))throw new Error("awaited result truthiness");
            let missingCalls=0;
            async function missing():Promise<{score:number}|undefined>{missingCalls++;return undefined;}
            const missingValue=await missing();
            if(missingValue!==undefined||missingCalls!==1)throw new Error("specialized undefined result");
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
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
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});

test("stored callbacks preserve promise and synchronous void outcomes", (t) => {
    const directory = resolve("artifacts/optional-promise");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        interface Action { run: (mode: number) => Promise<void> | void; }
        let effects = 0;
        let completed = 0;
        function effect(): void { effects++; }
        function produce(): Promise<void> { effects++; return Promise.resolve(); }
        const action: Action = {run: (mode: number): Promise<void> | void => {
            effects++;
            if (mode === 0) return;
            if (mode === 1) return effect();
            return produce();
        }};
        const empty: Action = {run: () => { effects++; }};
        const asynchronous: Action = {run: async () => { await Promise.resolve(); effects++; }};
        if (typeof produce().then !== "function") throw new Error("promise method");
        function invoke(action: Action, mode: number): void {
            const result = action.run(mode);
            if (result && typeof (result as Promise<void>).then === "function") result.then(() => { completed++; });
            else completed++;
        }
        invoke(action, 0);
        invoke(action, 1);
        invoke(action, 2);
        invoke(empty, 0);
        invoke(asynchronous, 0);
        queueMicrotask(() => { queueMicrotask(() => {
            if (effects !== 8 || completed !== 5) throw new Error("callback outcome or effects");
            globalThis.close();
        }); });
    `;
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
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
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }),
        "",
    );
});
