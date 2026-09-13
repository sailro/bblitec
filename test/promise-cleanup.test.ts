import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("promise cleanup preserves settlement, owns callbacks and follows JavaScript microtask order", async t => {
    const directory=resolve("artifacts/promise-cleanup");mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const body=`(async()=>{
        const order:string[]=[];const source=Promise.resolve(7);
        const done=source.finally(()=>{order.push("cleanup");}).then(()=>{order.push("result");});
        const turns=source.then(()=>{order.push("one");}).then(()=>{order.push("two");})
            .then(()=>{order.push("three");}).then(()=>{order.push("four");});
        await done;await turns;
        if(order.join(",")!=="cleanup,one,two,three,result,four")throw new Error("cleanup microtask order");
        let calls=0;
        function cleanup(value=19){if(value!==19)throw new Error("cleanup arguments");calls++;return 31;}
        if(await Promise.resolve(7).finally(cleanup)!==7||calls!==1)throw new Error("ignored cleanup result");
        async function fail():Promise<number>{throw new Error("original");}
        const recovered=await fail().finally(cleanup).catch(error=>{if(error.message!=="original")throw error;return 9;});
        if(recovered!==9||calls!==2)throw new Error("original rejection");
        const thrown=await Promise.resolve(7).finally(()=>{throw new Error("cleanup");})
            .catch(error=>{if(error.message!=="cleanup")throw error;return 11;});
        const rejected=await fail().finally(async()=>{await Promise.resolve();throw new Error("replacement");})
            .catch(error=>{if(error.message!=="replacement")throw error;return 13;});
        if(thrown!==11||rejected!==13)throw new Error("cleanup rejection");
        let finished=false;
        const asyncValue=await Promise.resolve(7).finally(async()=>{await Promise.resolve();finished=true;return 99;});
        if(asyncValue!==7||!finished)throw new Error("await cleanup");
        await Promise.resolve().finally(cleanup);
        const record={value:7};const alias=await Promise.resolve(record).finally(()=>({value:99}));
        alias.value=11;if(alias!==record||record.value!==11)throw new Error("record settlement identity");
        const literal=await Promise.resolve({value:17}).finally(cleanup);
        if(literal.value!==17)throw new Error("literal settlement");
        let reads=0;const holder={get callback(){reads++;const expected=reads;return ()=>{if(expected!==1)throw new Error("getter capture");calls++;};}};
        const pending=Promise.resolve(7).finally(holder.callback);
        if(reads!==1||calls!==4)throw new Error("registration snapshot");
        if(await pending!==7||reads!==1||calls!==5)throw new Error("getter delivery");
        const callbacks:(()=>Promise<number>)[]=[async()=>{await Promise.resolve();return 23;}];
        if(await Promise.resolve(7).finally(callbacks[0]!)!==7)throw new Error("stored cleanup");
        const original=Promise.resolve(7);const next=original.finally(cleanup);
        if(original===next||await next!==7)throw new Error("promise identity");
        if(await original.finally()!==7||await original.finally(null)!==7||await original.finally(undefined)!==7)throw new Error("absent cleanup");
        let maybe:(()=>void)|undefined=cleanup;
        const captured=original.finally(maybe);maybe=undefined;
        if(await captured!==7||await original.finally(maybe)!==7||calls!==7)throw new Error("optional cleanup snapshot");
        globalThis.close();
    })();`;
    let closed=false;
    await runInNewContext(ts.transpile(body,{target:ts.ScriptTarget.ES2022}),{close:()=>{closed=true;}});
    assert.equal(closed,true,"JavaScript oracle completed");
    const prefix='const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const result=compileSource(prefix+body,{fileName:join(directory,"entry.ts")});
    const tools=optionalNativeFixtureTools(false);if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,`#define main generated_main\n${result.cpp}\n#undef main\n`+
        `int main() { const auto baseline=bbl::js::managed_node_count(); `+
        `{ bbl::js::RealmScope realm; bbl::pal::EventLoop loop; loop.run([&] { `+
        `{ bbl::js::Promise<double> source; source.finally(bbl::js::make_closure(std::tuple{source}, [](auto&) {})); } `+
        `bbl::js::collect_cycles(); if(bbl::js::managed_node_count()!=baseline) throw std::runtime_error("pending cleanup cycle"); loop.close(); }); } `+
        `const int result=generated_main(); `+
        `bbl::js::collect_cycles(); if(bbl::js::managed_node_count()!=baseline) throw std::runtime_error("cleanup ownership leak"); return result; }\n`);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    const execution=spawnSync(exe,{encoding:"utf8",timeout:10000});
    assert.ifError(execution.error);assert.equal(execution.status,0,execution.stderr);
    assert.equal(execution.stdout,"");assert.equal(execution.stderr,"");
});

test("promise cleanup refuses unrepresented custom thenable assimilation", () => {
    const directory=resolve("artifacts/promise-cleanup");mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const prefix='const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const thenable='{then(resolve:(value:number)=>void){resolve(7);}}';
    const fileName=resolve("artifacts/promise-cleanup/entry.ts");
    for(const expression of [`Promise.resolve(${thenable})`, `Promise.resolve(7).finally(()=>(${thenable}))`])
        assert.throws(()=>compileSource(prefix+expression,{fileName}),/thenable assimilation/);
});
