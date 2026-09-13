import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

const cases=[
    {name:"main", worker:"self.close();", source:`
        let total=0;function add(value:number){total+=value;}
        async function main(){
            worker.terminate();let count=3;const record={value:7};const bytes=new Uint8Array([9]);
            setTimeout(()=>{count++;add(count);if(count!==5||total!==7||record.value!==9||bytes[0]!==11)throw new Error("escaped startup captures");globalThis.close();},5);
            await Promise.resolve();count++;record.value=9;bytes[0]=11;add(2);
        }
        void main();
    `},
    {name:"module", worker:"self.close();", source:`
        worker.terminate();let count=1;function read(){return count;}
        setTimeout(()=>{if(read()!==3)throw new Error("module capture after startup");globalThis.close();},5);
        const value=await Promise.resolve(2);count+=value;
    `},
    {name:"worker", worker:`
        let count=1;await Promise.resolve();count+=2;
        self.addEventListener("message",()=>{count++;self.postMessage(count);});
    `, source:`
        let replies=0;
        worker.addEventListener("message",(event:MessageEvent<number>)=>{
            replies++;if(event.data!==3+replies)throw new Error("worker module startup");
            if(replies===2)globalThis.close();else worker.postMessage(0);
        });
        worker.postMessage(0);
    `},
] as const;

for(const sample of cases)test(`asynchronous ${sample.name} startup owns suspended and escaped bindings`, t=>{
    const directory=resolve("artifacts/startup-awaits",sample.name);mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),sample.worker);
    const prefix='const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});';
    const result=compileSource(prefix+sample.source,{fileName:join(directory,"entry.ts")});
    const tools=optionalNativeFixtureTools(false);if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,`#define main generated_main\n${result.cpp}\n#undef main\n`+
        `int main(){const auto baseline=bbl::js::managed_node_count();const int result=generated_main();`+
        `bbl::js::collect_cycles();if(bbl::js::managed_node_count()!=baseline)throw std::runtime_error("startup ownership leak");return result;}\n`);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    const execution=spawnSync(exe,{encoding:"utf8",timeout:10000});
    assert.ifError(execution.error);assert.equal(execution.status,0,execution.stderr);
    assert.equal(execution.stdout,"");assert.equal(execution.stderr,"");
});
