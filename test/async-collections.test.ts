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

test("collection callbacks start independent async activations and keep promise truthiness", (t) => {
    const directory = resolve("artifacts/async-collections");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.terminate();
        void(async()=>{
            const input:number[]=[1,2];
            let started=0,finished=0;
            const pending=input.map(async(value,index,array)=>{
                started++;
                await Promise.resolve();
                if(array!==input)throw new Error("source identity");
                finished++;
                return {value:value+index,bytes:new Uint8Array([value])};
            });
            if(started!==2||finished!==0)throw new Error("map scheduling");
            const values=await Promise.all(pending);
            if(finished!==2||values[0]!.value!==1||values[1]!.value!==3||values[1]!.bytes[0]!==2)throw new Error("owned records");
            const first=await pending[0]!,alias=await pending[0]!;
            if(first!==alias||first!==values[0])throw new Error("settlement identity");
            first.value=8;
            if(alias.value!==8||values[0]!.value!==8)throw new Error("settlement aliases");
            const records=await Promise.all(input.map(async value=>({value,bytes:await Promise.resolve(new Uint8Array([value]))})));
            if(records[1]!.bytes[0]!==2)throw new Error("concise record await");
            started=0;finished=0;
            const tuple=[1,2] as const;
            const tuplePending=tuple.map(async value=>{started++;await Promise.resolve();finished++;return value+1;});
            if(started!==2||finished!==0)throw new Error("tuple scheduling");
            const tupleValues=await Promise.all(tuplePending);
            if(tupleValues[0]!==2||tupleValues[1]!==3||finished!==2)throw new Error("tuple results");
            let predicateCalls=0;
            async function predicate():Promise<boolean>{await Promise.resolve();predicateCalls++;return false;}
            const kept=input.filter(predicate),some=input.some(predicate),every=input.every(predicate),found=input.find(predicate);
            if(kept.length!==2||!some||!every||found!==1||predicateCalls!==0)throw new Error("promise truthiness");
            await Promise.resolve();
            if(predicateCalls!==6)throw new Error("predicate short circuit");
            let tupleCalls=0;
            const tupleSome=tuple.some(async()=>{await Promise.resolve();tupleCalls++;return false;});
            tuple.forEach(async()=>{await Promise.resolve();tupleCalls++;});
            if(!tupleSome||tupleCalls!==0)throw new Error("tuple callback scheduling");
            await Promise.resolve();
            if(tupleCalls!==3)throw new Error("tuple callback counts");
            let each=0;
            input.forEach(async value=>{await Promise.resolve();each+=value;});
            if(each!==0)throw new Error("forEach scheduling");
            await Promise.resolve();
            if(each!==3)throw new Error("forEach completion");
            const nested=await Promise.all(input.flatMap(async value=>{await Promise.resolve();return [value,value+1];}));
            if(nested.length!==2||nested[1]!.join(",")!=="2,3")throw new Error("flatMap promise element");
            const sum=await input.reduce(async(previous:Promise<number>,value)=>{const accumulated=await previous;return accumulated+value;},Promise.resolve(0));
            if(sum!==3)throw new Error("reduce chain");
            const from=await Promise.all(Array.from(input,async value=>{await Promise.resolve();return value+1;}));
            const allocated=await Promise.all(Array.from({length:2},async()=>{await Promise.resolve();return 6;}));
            if(from.join(",")!=="2,3"||allocated.join(",")!=="6,6")throw new Error("Array.from");
            function launch():Promise<number>[] {
                let offset=3;
                const result=input.map(async value=>{await Promise.resolve();return value+offset;});
                offset=4;
                return result;
            }
            const escaped=await Promise.all(launch());
            if(escaped.join(",")!=="5,6")throw new Error("escaped captures");
            let reads=0;
            function mapper():(value:number)=>Promise<number>{reads++;return async value=>{await Promise.resolve();return value+2;};}
            const callbacks={get run(){return mapper();}};
            const selected=await Promise.all(input.map(callbacks.run));
            if(reads!==1||selected.join(",")!=="3,4")throw new Error("callback getter");
            let rejected=false;
            await Promise.all(input.map(async value=>{await Promise.resolve();if(value===2)throw new Error("map failure");return value;})).then(()=>{throw new Error("unexpected fulfillment");},error=>{rejected=String(error)==="Error: map failure";});
            if(!rejected)throw new Error("map rejection");
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
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
