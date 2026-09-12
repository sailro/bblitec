import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("async IIFEs aggregate owned ordered values before applying assignments", t => {
    const directory=resolve("artifacts/async-loading");
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const result=compileSource(`
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.terminate();
        let started="";
        async function load(value:number):Promise<number> {
            started+=String(value);
            await Promise.resolve();
            return value;
        }
        let assigned:number|null=null;
        const record:{value:number}={value:0};
        const slots=[0,0];
        let index=0;
        function target(){started+="T";return record;}
        function next(){started+=String(record.value);return index++;}
        async function fail():Promise<number>{throw new Error("input failure");}
        void(async()=>{
            const pending=Promise.all([load(1),load(2)]);
            if(started!=="12") throw new Error("concurrent starts");
            const [first,second]=await pending;
            if(first!==1||second!==2) throw new Error("ordered values");
            const [number,text]=await Promise.all([load(3),"text"]);
            if(number!==3||text!=="text") throw new Error("mixed results");
            const values:Promise<number>[]=[load(4),load(5)];
            const all=await Promise.all(values);
            if(all.join(",")!=="4,5") throw new Error("stored inputs");
            const empty=await Promise.all([]);
            if(empty.length!==0) throw new Error("empty inputs");
            [assigned,target().value,slots[next()],slots[next()]]=await Promise.all([load(6),load(7),load(8),load(9)]);
            if(assigned!==6||record.value!==7||slots.join(",")!=="8,9"||started!=="123456789T77")
                throw new Error("awaited assignment order");
            let swapped=0;
            [slots[swapped++],swapped]=[10,11];
            if(slots[0]!==10||swapped!==11) throw new Error("computed target order");
            let dictionary:Record<string,number>={};
            const original=dictionary;
            function replace(){dictionary={};return "first";}
            [dictionary[replace()],dictionary.second]=await Promise.all([load(10),load(11)]);
            if(original.first!==10||dictionary.second!==11||dictionary.first!==undefined) throw new Error("dictionary target identity");
            const bytes=new Uint8Array(1);
            [bytes[0]]=[259];
            if(bytes[0]!==3) throw new Error("typed assignment conversion");
            let recovered="";
            await Promise.all([fail(),load(0)]).then(()=>{throw new Error("unexpected fulfillment");},error=>{recovered=String(error);});
            if(recovered!=="Error: input failure") throw new Error("aggregate recovery");
            const failures:Promise<number>[]=[fail(),load(0)];
            const fallback=await Promise.all(failures).catch(()=>[11,12]);
            if(fallback.join(",")!=="11,12") throw new Error("stored aggregate recovery");
            const nested=await Promise.all([Promise.resolve([slots[0],"nested"] as const)]);
            if(nested[0][0]!==10||nested[0][1]!=="nested") throw new Error("nested tuple ownership");
            const result=await Promise.resolve(1).then(()=>"ready");
            if(result.length!==5) throw new Error("reaction string ownership");
        })().then(()=>{
            if(assigned!==6||record.value!==7) throw new Error("outer assignment lifetime");
            globalThis.close();
        });
    `,{fileName:join(directory,"entry.ts")});
    const tools=optionalNativeFixtureTools(false);
    if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,result.cpp);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    assert.equal(execFileSync(exe,{encoding:"utf8",timeout:10000}),"");
});
