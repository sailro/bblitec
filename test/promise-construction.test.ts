import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("promise constructors own escaping resolvers and races preserve settlement order", async t=>{
    const directory=resolve("artifacts/promise-construction");mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const body=`(async()=>{
        let calls=0;
        const immediate=new Promise<number>(resolve=>{calls++;resolve(7);calls++;});
        if(calls!==2||await immediate!==7)throw new Error("synchronous executor");
        const thrown=await new Promise<number>(()=>{throw new Error("executor");}).catch(error=>{if(error.message!=="executor")throw error;return 9;});
        if(thrown!==9)throw new Error("executor rejection");
        const first=await new Promise<number>((resolve,reject)=>{resolve(11);reject(new Error("ignored"));resolve(13);throw new Error("also ignored");});
        if(first!==11)throw new Error("first settlement");
        const adopted=await new Promise<number>((resolve,reject)=>{resolve(Promise.resolve(17));reject(new Error("ignored adoption"));});
        if(adopted!==17)throw new Error("adoption locks settlement");
        const order:string[]=[];
        const adoption=new Promise<number>(resolve=>resolve(Promise.resolve(1))).then(()=>{order.push("result");});
        const turns=Promise.resolve().then(()=>{order.push("one");}).then(()=>{order.push("two");}).then(()=>{order.push("three");});
        await adoption;await turns;if(order.join(",")!=="one,two,result,three")throw new Error("resolver adoption microtask order: "+order.join(","));
        const record={value:43};const recordPromise=new Promise<{value:number}>(resolve=>resolve(record));
        const alias=await recordPromise;alias.value=47;if(alias!==record||record.value!==47)throw new Error("resolver record identity");
        let finish:(value:number)=>void=()=>{};
        const later=new Promise<number>(resolve=>{finish=resolve;});
        finish(19);if(await later!==19)throw new Error("stored resolving function");
        await new Promise<void>(resolve=>resolve(Promise.resolve()));
        await Promise.resolve(undefined).then(()=>undefined);
        await Promise.race([undefined,undefined]);
        async function absent(){await Promise.resolve();return undefined;}
        await absent();
        if(await new Promise<number>(async resolve=>{await Promise.resolve();resolve(53);})!==53)throw new Error("async executor activation");
        await new Promise<void>(resolve=>setTimeout(resolve,0));
        let winner=0;
        const fast=new Promise<number>(resolve=>setTimeout(()=>resolve(23),0));
        const slow=new Promise<number>((_resolve,reject)=>setTimeout(()=>reject(new Error("loser")),10));
        winner=await Promise.race([fast,slow]);if(winner!==23)throw new Error("race winner");
        await new Promise<void>(resolve=>setTimeout(resolve,20));
        const values:number[]=[29,31];if(await Promise.race(values)!==29)throw new Error("stored values");
        const promises:Promise<void>[]=[Promise.resolve(),Promise.resolve()];await Promise.race(promises);
        const rejected=await Promise.race([new Promise<number>((_resolve,reject)=>reject(new Error("race"))),Promise.resolve(37)])
            .catch(error=>{if(error.message!=="race")throw error;return 41;});
        if(rejected!==41)throw new Error("race rejection");
        let emptySettled=false;Promise.race([]).then(()=>{emptySettled=true;});
        await Promise.resolve();await Promise.resolve();if(emptySettled)throw new Error("empty race");
        globalThis.close();
    })();`;
    let closed=false;
    await runInNewContext(ts.transpile(body,{target:ts.ScriptTarget.ES2022}),{setTimeout,close:()=>{closed=true;}});
    assert.equal(closed,true,"JavaScript oracle completed");
    const prefix='const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const result=compileSource(prefix+body,{fileName:join(directory,"entry.ts")});
    const tools=optionalNativeFixtureTools(false);if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,`#define main generated_main\n${result.cpp}\n#undef main\n`+
        `int main(){const auto baseline=bbl::js::managed_node_count();const int result=generated_main();`+
        `bbl::js::collect_cycles();if(bbl::js::managed_node_count()!=baseline)throw std::runtime_error("promise construction ownership leak");return result;}\n`);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    const execution=spawnSync(exe,{encoding:"utf8",timeout:10000});
    assert.equal(execution.stdout,"");assert.equal(execution.stderr,"");
    assert.ifError(execution.error);assert.equal(execution.status,0);
});
