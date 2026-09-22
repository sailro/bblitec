import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("callbacks observe completed lexical initializers and preserve failed initialization", (t) => {
    const directory = resolve("artifacts/timer-bindings");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        let early=0,failed=0,count=0,nested=0,repeated=0,named=0;
        try{const value:number=(()=>value)();throw new Error("early read accepted");}
        catch(error){if(!error.message.includes("before initialization"))throw error;early++;}
        let escaped:()=>number=()=>0;
        try{
            const value:number=((read:()=>number):number=>{escaped=read;throw new Error("initializer failed");})(()=>value);
        }catch(error){if(error.message!=="initializer failed")throw error;}
        try{escaped();throw new Error("failed binding initialized");}
        catch(error){if(!error.message.includes("before initialization"))throw error;failed++;}
        const absent:number|null=(()=>{queueMicrotask(()=>{if(absent!==null)throw new Error("initialized absence");});return null;})();
        const timers=new Set<number>();
        function schedule(action:()=>void){
            const ticket=setTimeout(()=>{timers.delete(ticket);action();clearTimeout(ticket);},0);
            timers.add(ticket);
        }
        for(const value of [1,2,3])schedule(()=>{count+=value;});
        const interval=setInterval(()=>{repeated++;if(repeated===2)clearInterval(interval);},1);
        const namedCallback=()=>{named++;clearTimeout(namedTicket);};
        const namedTicket=setTimeout(namedCallback,0);
        function namedLocal(){
            const callback=()=>{named++;clearTimeout(ticket);};
            const ticket=setTimeout(callback,0);
        }
        namedLocal();
        const outer=setTimeout(()=>{
            clearTimeout(outer);
            const inner=setTimeout(()=>{nested++;clearTimeout(inner);},0);
        },0);
        let mutable=setTimeout(()=>{if(mutable!==23)throw new Error("mutable binding capture");},0);mutable=23;
        setTimeout(()=>{
            if(early!==1||failed!==1||count!==6||nested!==1||repeated!==2||named!==2||timers.size!==0)throw new Error("timer results");
            globalThis.close();
        },40);
    `,
        { fileName: join(directory, "entry.ts") },
    );
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
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    const execution = spawnSync(exe, { encoding: "utf8", timeout: 10000 });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
});
