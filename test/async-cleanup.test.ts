import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("suspending cleanup preserves and overrides abrupt completions", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/async-cleanup-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();
        void(async()=>{
            const seen:string[]=[];const original=new Error('body'),replacement=new Error('cleanup');
            async function run(mode:number):Promise<number>{
                try { await Promise.resolve();if(mode===1||mode===2)throw original;return 7; }
                finally { seen.push('start'+mode);await Promise.resolve();seen.push('end'+mode);if(mode===2)throw replacement;if(mode===3)return 9; }
            }
            if(await run(0)!==7||await run(3)!==9)throw new Error('return cleanup');
            for(const mode of [1,2]){
                let caught=false;
                try{await run(mode);}catch(error){await Promise.resolve();caught=true;if(error!==(mode===1?original:replacement))throw new Error('identity');}
                if(!caught)throw new Error('missing rejection');
            }
            if(seen.join()!=='start0,end0,start3,end3,start1,end1,start2,end2')throw new Error('suspension order');
            async function nested():Promise<number>{
                try{try{return 11;}finally{await Promise.resolve();seen.push('inner');}}
                finally{await Promise.resolve();seen.push('outer');}
            }
            if(await nested()!==11||seen.slice(-2).join()!=='inner,outer')throw new Error('nested return');
            let total=0;
            for(let i=0;i<5;i++){
                try{if(i===1)continue;if(i===3)break;total+=i;}
                finally{await Promise.resolve();total+=10;}
            }
            if(total!==42)throw new Error('loop completion');
            async function adopt():Promise<number>{try{return Promise.resolve(19);}finally{await Promise.resolve();seen.push('adopt');}}
            if(await adopt()!==19||seen[seen.length-1]!=='adopt')throw new Error('adoption');
            async function empty():Promise<void>{try{return;}finally{await Promise.resolve();seen.push('empty');}}
            await empty();if(seen[seen.length-1]!=='empty')throw new Error('void completion');
            async function absent():Promise<number|undefined>{try{return;}finally{await Promise.resolve();seen.push('absent');}}
            if(await absent()!==undefined||seen[seen.length-1]!=='absent')throw new Error('undefined completion');
            async function replaceReturn():Promise<number>{try{return 1;}finally{return 2;}}
            if(await replaceReturn()!==2)throw new Error('synchronous return replacement');
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "async-cleanup-check", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
