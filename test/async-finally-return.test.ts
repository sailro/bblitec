import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("non-void coroutine finally preserves abrupt results and rejection cleanup", (t) => {
    const available = optionalNativeFixtureTools(false);
    if (!available) {
        t.skip("Native fixture compiler unavailable");
        return;
    }
    const tools =
        process.platform === "win32"
            ? discoverWindowsBuildTools("clangcl")
            : available;
    const directory = resolve("artifacts/async-finally-return-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();
        void(async()=>{
            const original=new Error("body"),replacement=new Error("cleanup");
            const seen:number[]=[];
            const work:((mode:number)=>Promise<Float32Array>)[]=[async(mode)=>{
                try {
                    await Promise.resolve();
                    if(mode===1||mode===2)throw original;
                    return new Float32Array([7,9]);
                } finally {
                    seen.push(mode);
                    if(mode===2||mode===3)throw replacement;
                }
            }];
            const value=await work[0]!(0);
            if(value[0]!==7||value[1]!==9||seen.join(',')!=='0')throw new Error("return cleanup");
            for(const mode of [1,2,3]){
                let rejected=false;
                try {await work[0]!(mode);}catch(error){
                    rejected=true;
                    if(error!==(mode===1?original:replacement))throw new Error("rejection identity");
                }
                if(!rejected)throw new Error("missing rejection");
            }
            if(seen.join(',')!=='0,1,2,3')throw new Error("cleanup order");
            async function recover(mode:number):Promise<number>{
                try {await Promise.resolve();if(mode===1)throw original;return 11;}
                catch {return 13;}
                finally {seen.push(3);}
            }
            if(await recover(0)!==11||await recover(1)!==13||seen.length!==6)throw new Error("returning catch");
            async function normal():Promise<number>{
                let value=1;
                try {await Promise.resolve();value=2;}finally{value+=3;}
                return value;
            }
            if(await normal()!==5)throw new Error("normal completion");
            let caughtByOwnHandler=false;
            async function ownHandler():Promise<number>{
                try {return await Promise.resolve(31);}
                catch {caughtByOwnHandler=true;return 32;}
                finally {throw replacement;}
            }
            let ownHandlerRejected=false;
            try {await ownHandler();}catch(error){
                ownHandlerRejected=true;
                if(error!==replacement)throw new Error("cleanup rejection identity");
            }
            if(!ownHandlerRejected||caughtByOwnHandler)throw new Error("cleanup catch boundary");
            async function adopt(fail:boolean):Promise<number|undefined>{
                try {return Promise.resolve(23);}
                finally {if(fail)throw replacement;}
            }
            if(await adopt(false)!==23)throw new Error("converted return adoption");
            let adoptionRejected=false;
            try {await adopt(true);}catch(error){
                adoptionRejected=true;
                if(error!==replacement)throw new Error("adoption cleanup identity");
            }
            if(!adoptionRejected)throw new Error("cleanup overrides adoption");
            const shared=new Float32Array([1]);
            async function mutate():Promise<Float32Array>{
                try {return shared;}
                finally {shared[0]=17;}
            }
            const alias=await mutate();
            if(alias!==shared||alias[0]!==17)throw new Error("return value identity");
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const source = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(
        execFileSync(exe, {
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
        }),
        "",
    );
});
