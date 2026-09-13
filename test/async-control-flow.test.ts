import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("async branches, loops and handlers complete in their owning activation", t => {
    const directory=resolve("artifacts/async-control-flow");
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const prefix='const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const result=compileSource(prefix+`
        void(async()=>{
            const flags:boolean[]=[true,false];
            const input:number[]=[1,2];
            async function choose(flag:boolean):Promise<number|null>{await Promise.resolve();if(flag)return null;return 2;}
            if(await choose(flags[0]!)!==null||await choose(flags[1]!)!==2)throw new Error("nullable branches");
            async function search(values:number[]):Promise<number>{for(const value of values){await Promise.resolve();if(value>1)return value;}return 0;}
            if(await search(input)!==2||await search([])!==0)throw new Error("loop returns");
            async function fail():Promise<number>{throw new Error("failure");}
            let caught=0,cleaned=0;
            async function adopt(flag:boolean):Promise<number>{try{if(flag)return fail();return 3;}catch{caught++;return 4;}}
            async function recover(flag:boolean):Promise<number>{try{if(flag)return await fail();return 3;}catch{caught++;return 4;}}
            if(await adopt(flags[0]!).catch(()=>5)!==5||caught!==0)throw new Error("adoption catch boundary");
            if(await recover(flags[0]!)!==4||caught!==1)throw new Error("await catch boundary");
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
    `,{fileName:join(directory,"entry.ts")});
    assert.throws(()=>compileSource(prefix+'void(async()=>{try{return;}finally{await Promise.resolve();}})();',
        {fileName:join(directory,"unsupported.ts")}),/Await in finally requires asynchronous cleanup completion/);
    assert.throws(()=>compileSource(prefix+'void(async()=>{try{throw new Error("failure");}catch{await Promise.resolve();}})();',
        {fileName:join(directory,"unsupported.ts")}),/Await in catch requires suspended exception handling/);
    const tools=optionalNativeFixtureTools(false);
    if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,result.cpp);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    assert.equal(execFileSync(exe,{encoding:"utf8",timeout:10000}),"");
});
