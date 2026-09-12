import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("promise caches retain identity and async reactions own registration snapshots", t => {
    const directory=resolve("artifacts/promise-caches");
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const result=compileSource(`
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.terminate();
        let starts=0;
        const cache=new Map<string,Promise<number>>();
        function load(key:string):Promise<number>{
            let pending=cache.get(key);
            if(!pending){
                starts++;
                pending=Promise.resolve(7).then(async value=>{
                    await Promise.resolve();
                    if(key==="bad")throw new Error("load failure");
                    return value;
                }).catch(error=>{cache.delete(key);throw error;});
                cache.set(key,pending);
            }
            return pending;
        }
        let pending=Promise.resolve(1);
        const original=pending;
        const observed=(async()=>{await Promise.resolve();return await pending;})();
        let numeric=4;
        const runtimeReaction=Promise.resolve(numeric).then(async value=>{await Promise.resolve();return value+1;});
        numeric=20;
        async function maybeReject(flag:boolean):Promise<number>{if(flag)throw new Error("immediate");return 5;}
        let callback:(value:number)=>number=value=>value+1;
        const registered=Promise.resolve(1).then(callback);
        callback=value=>value+10;
        let order="";
        function reaction():(value:number)=>Promise<number>{order+="G";return async(value:number)=>{await Promise.resolve();return value+2;};}
        const callbacks={get run(){return reaction();}};
        function receiver():Promise<number>{order+="R";return Promise.resolve(2);}
        const propertyReaction=receiver().then(callbacks.run);
        const nullable:()=>Promise<number|null>=async()=>Promise.resolve(9);
        let done=false;
        const ignored:()=>void=async()=>{await Promise.resolve();done=true;return Promise.resolve(3);};
        const voidResult:()=>Promise<void>=async()=>{await Promise.resolve();};
        ignored();
        pending=Promise.resolve(2);
        void(async()=>{
            const first=load("good"),second=load("good");
            if(first!==second||first===Promise.resolve(7)||starts!==1)throw new Error("cache identity");
            if(await first!==7||await second!==7||await pending!==2||await original!==1)throw new Error("cache/rebind results");
            if(await observed!==2||await runtimeReaction!==5)throw new Error("suspended binding ownership");
            if(await maybeReject(true).catch(()=>6)!==6)throw new Error("immediate rejection");
            if(await registered!==2||await propertyReaction!==4||order!=="RG")throw new Error("registration snapshots");
            let errors=0;
            await load("bad").catch(async error=>{await Promise.resolve();if(String(error)!=="Error: load failure")throw new Error("rejection");errors++;return 0;});
            await load("bad").catch(()=>{errors++;return 0;});
            if(errors!==2||starts!==3||cache.has("bad"))throw new Error("failure eviction");
            if(await nullable()!==9)throw new Error("nullable adoption");
            await voidResult();
            if(!done)throw new Error("discarded result activation");
            let selected:Promise<number>|undefined=undefined;
            selected=Promise.resolve(8);
            if(await selected!==8)throw new Error("nullable local");
            selected=undefined;
            if(selected!==undefined)throw new Error("clear local");
            globalThis.close();
        })();
    `,{fileName:join(directory,"entry.ts")});
    const tools=optionalNativeFixtureTools(false);
    if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,result.cpp);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    assert.equal(execFileSync(exe,{encoding:"utf8",timeout:10000}),"");
});
