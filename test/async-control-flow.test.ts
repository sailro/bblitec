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

function runNative(
    result: ReturnType<typeof compileSource>,
    directory: string,
    t: test.TestContext,
): void {
    const tools = optionalNativeFixtureTools(false);
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
        `/I${nativeFixtureVcpkgRoot}/include`,
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
}

test("discarded value-promise recovery preserves reactions and async cleanup", (t) => {
    const directory = resolve("artifacts/async-discarded-recovery");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();
        void(async()=>{
            let successes=0,failures=0;
            async function work(fail:boolean):Promise<boolean>{await Promise.resolve();if(fail)throw new Error('expected');successes++;return true;}
            await work(false).catch(()=>{failures++;});
            if(successes!==1||failures!==0)throw new Error('fulfillment');
            await work(true).catch(async(error:unknown)=>{await Promise.resolve();if(!(error instanceof Error)||error.message!=='expected')throw new Error('reason');failures++;});
            if(successes!==1||failures!==1)throw new Error('async recovery');
            let later=false;
            void work(true).catch(()=>{later=true;});
            for(let i=0;i<8;i++)await Promise.resolve();
            if(!later)throw new Error('discarded reaction');
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    runNative(result, directory, t);
});

test("Promise.allSettled retains ordered values and original rejection identities", (t) => {
    const directory = resolve("artifacts/async-all-settled");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        void(async()=>{
            const first=new RangeError("first");
            const second=new TypeError("second");
            const flags:boolean[]=[false,true,true];
            let finished=0;
            async function prepare(index:number):Promise<void> {
                await Promise.resolve();
                if(index===0){await Promise.resolve();await Promise.resolve();}
                finished++;
                if(flags[index])throw index===1 ? first : second;
            }
            const pending:Promise<void>[]=[];
            for(let index=0;index<flags.length;index++)pending.push(prepare(index));
            const results=await Promise.allSettled(pending);
            if(finished!==3||results.length!==3)throw new Error("settlement completion");
            if(results[0]!.status!=="fulfilled"||results[0]!.value!==undefined)throw new Error("void settlement");
            const failures:unknown[]=[];
            for(const result of results)if(result.status==="rejected")failures.push(result.reason);
            if(failures.length!==2||failures[0]!==first||failures[1]!==second)throw new Error("rejection order and identity");
            if(results[1]===results[2])throw new Error("settlement identity");
            let visited=0;
            for(const settled of await Promise.allSettled(flags.map((_flag,index)=>prepare(index)))) {
                if(visited===0 && settled.status!=="fulfilled")throw new Error("awaited iteration fulfillment");
                if(visited>0 && (settled.status!=="rejected" || settled.reason!==(visited===1?first:second)))throw new Error("awaited iteration rejection");
                visited++;
            }
            if(visited!==3||finished!==6)throw new Error("awaited range evaluated once");
            const original={count:3};
            const mixed=await Promise.allSettled([Promise.resolve(original), 7, Promise.reject(first)]);
            if(mixed[0].status!=="fulfilled"||mixed[0].value!==original)throw new Error("object fulfillment identity");
            if(mixed[1].status!=="fulfilled"||mixed[1].value!==7)throw new Error("immediate settlement");
            if(mixed[2].status!=="rejected"||mixed[2].reason!==first)throw new Error("immediate rejection");
            const empty:Promise<number>[]=[];
            let synchronous=true;
            const done=Promise.allSettled(empty).then(values=>{if(synchronous||values.length)throw new Error("empty settlement ordering");});
            synchronous=false;
            await done;
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    runNative(result, directory, t);
});

test("coroutine returns retain dynamic storage through suspension and adoption", (t) => {
    const directory = resolve("artifacts/async-dynamic-returns");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        void(async()=>{
            interface Config {branch:{size:number};keep:{value:number}}
            const defaults={branch:{size:1},keep:{value:2}};
            const flags:boolean[]=[false,true];
            let effects=0;
            function parse(source:unknown):Config {
                effects++;
                return {...(source as Record<string,unknown>),keep:defaults.keep} as unknown as Config;
            }
            async function load(source:unknown,fail:boolean):Promise<Config> {
                await Promise.resolve();
                try {
                    if(fail)throw new Error("fallback");
                    if(source===null)return defaults;
                    return parse(source);
                } catch {return defaults;}
            }
            async function forward(source:unknown,fail:boolean):Promise<Config> {
                if(fail)return load(source,true);
                return load(source,false);
            }
            const loaded=await forward(JSON.parse('{"branch":{"size":3}}'),flags[0]!);
            const empty=await load(JSON.parse('null'),flags[0]!);
            const failed=await forward(JSON.parse('{}'),flags[1]!);
            if(loaded.branch.size!==3||loaded.keep!==defaults.keep||loaded===defaults||effects!==1)
                throw new Error("dynamic coroutine result");
            if(empty!==defaults||failed!==defaults)throw new Error("coroutine fallback identity");
            defaults.keep.value=7;
            if(loaded.keep.value!==7||empty.keep.value!==7||failed.keep.value!==7)
                throw new Error("coroutine aliases");
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    runNative(result, directory, t);
});

test("async branches, loops and handlers complete in their owning activation", (t) => {
    const directory = resolve("artifacts/async-control-flow");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const prefix =
        'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const result = compileSource(
        prefix +
            `
        void(async()=>{
            const flags:boolean[]=[true,false];
            const input:number[]=[1,2];
            async function choose(flag:boolean):Promise<number|null>{await Promise.resolve();if(flag)return null;return 2;}
            if(await choose(flags[0]!)!==null||await choose(flags[1]!)!==2)throw new Error("nullable branches");
            async function search(values:number[]):Promise<number>{for(const value of values){await Promise.resolve();if(value>1)return value;}return 0;}
            if(await search(input)!==2||await search([])!==0)throw new Error("loop returns");
            async function fail():Promise<number>{throw new Error("failure");}
            const failure = new TypeError("retained rejection");
            async function failRetained():Promise<number>{throw failure;}
            if(await failRetained().catch(error=>error===failure && error instanceof TypeError ? 17 : 0)!==17)
                throw new Error("rejected identity");
            const rejected = new Promise<number>((_resolve,reject)=>reject(failure));
            if(await rejected.catch(error=>error===failure?19:0)!==19)
                throw new Error("resolver rejection identity");
            function rollback(error:unknown):never { throw error; }
            async function guarded(flag:boolean):Promise<number>{
                try { if(flag) await fail(); return 11; }
                catch(error) { rollback(error); }
            }
            if(await guarded(flags[1]!)!==11 || await guarded(flags[0]!).catch(error=>error.message==="failure"?13:0)!==13)
                throw new Error("never cleanup completion");
            let caught=0,cleaned=0;
            async function adopt(flag:boolean):Promise<number>{try{if(flag)return fail();return 3;}catch{caught++;return 4;}}
            async function recover(flag:boolean):Promise<number>{try{if(flag)return await fail();return 3;}catch{caught++;return 4;}}
            if(await adopt(flags[0]!).catch(()=>5)!==5||caught!==0)throw new Error("adoption catch boundary");
            if(await recover(flags[0]!)!==4||caught!==1)throw new Error("await catch boundary");
            async function suspendedRecovery():Promise<number>{try{await fail();return 0;}catch(error){await Promise.resolve();if(error.message!=="failure")throw error;return 7;}}
            if(await suspendedRecovery()!==7)throw new Error("suspended catch boundary");
            async function cleanup():Promise<number>{try{await Promise.resolve();return 3;}finally{cleaned++;}}
            if(await cleanup()!==3||cleaned!==1)throw new Error("finally effects");
            const reaction=await Promise.resolve(input[0]!).then(async value=>{await Promise.resolve();if(value>0)return 3;return 4;});
            const recovery=await fail().catch(async error=>{await Promise.resolve();if(error.message==="failure")return 3;return 4;});
            if(reaction!==3||recovery!==3)throw new Error("reaction branches");
            let effects=0;
            async function optional(flag:boolean):Promise<void>{await Promise.resolve();if(flag)return;effects++;}
            await optional(flags[0]!);await optional(flags[1]!);
            if(effects!==1)throw new Error("bare returns");
            const conditional=async()=>flags[0]?await Promise.resolve(1):await Promise.resolve(2);
            if(await conditional()!==1)throw new Error("conditional await");
            let timed=0,microtask=0;
            setTimeout(async()=>{await Promise.resolve();timed++;return 9;},0);
            queueMicrotask(async()=>{await Promise.resolve();microtask++;});
            if(timed!==0||microtask!==0)throw new Error("deferred scheduling");
            setTimeout(()=>{if(timed!==1||microtask!==1)throw new Error("deferred completion");globalThis.close();},20);
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    "void(async()=>{try{return;}finally{await Promise.resolve();}})();",
                { fileName: join(directory, "unsupported.ts") },
            ),
        /Await in finally requires asynchronous cleanup completion/,
    );
    runNative(result, directory, t);
});

test("nested cleanup preserves exception identity and runs every finalizer after suspension", (t) => {
    const directory = resolve("artifacts/async-nested-cleanup");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        void(async()=>{
            const original=new RangeError("retirement");
            const inner=new TypeError("simulation disposal");
            const outer=new Error("engine disposal");
            let order="";
            async function dispose(failRetirement:boolean,failInner:boolean,failOuter:boolean):Promise<void> {
                try {
                    try {
                        await Promise.resolve();
                        order+="retire;";
                        if(failRetirement)throw original;
                    } finally {
                        order+="inner;";
                        if(failInner)throw inner;
                    }
                } finally {
                    order+="outer;";
                    if(failOuter)throw outer;
                }
            }
            const flags:boolean[]=[false,true];
            for(const failRetirement of flags)for(const failInner of flags)for(const failOuter of flags) {
                order="";
                let caught=false;
                try {await dispose(failRetirement,failInner,failOuter);}
                catch(error) {
                    caught=true;
                    const expected=failOuter?outer:failInner?inner:original;
                    if(error!==expected)throw new Error("cleanup replaced wrong completion");
                }
                if(order!=="retire;inner;outer;"||caught!==(failRetirement||failInner||failOuter))
                    throw new Error("cleanup order or completion");
            }
            order="";
            function synchronous():void {
                try {throw original;}
                finally {order+="sync;";throw inner;}
            }
            try {synchronous();throw new Error("missing cleanup throw");}
            catch(error) {if(error!==inner||order!=="sync;")throw new Error("sync cleanup replacement");}
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    runNative(result, directory, t);
});
