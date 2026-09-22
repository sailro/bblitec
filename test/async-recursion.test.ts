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

test("recursive async callbacks retain activations, ordered effects and rejection boundaries", (t) => {
    const directory = resolve("artifacts/async-recursion");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.terminate();
        let visits=0;
        const descend=async(n:number):Promise<void>=>{
            await Promise.resolve();
            visits++;
            if(n>0)await descend(n-1);
        };
        const sum=async(n:number):Promise<number>=>n>0?1+await sum(n-1):0;
        type State={value:number;bytes:Uint8Array};
        const advance=async(state:State):Promise<State>=>{
            await Promise.resolve();
            if(state.value>0)return advance({value:state.value-1,bytes:state.bytes});
            return state;
        };
        async function named(n:number):Promise<number>{
            await Promise.resolve();
            if(n>0)return 1+await named(n-1);
            return 0;
        }
        async function first(n:number):Promise<number>{
            await Promise.resolve();
            return n>0?await second(n-1):0;
        }
        async function second(n:number):Promise<number>{
            await Promise.resolve();
            return n>0?await first(n-1):1;
        }
        function launch():Promise<number>{
            let changed=1;
            const local:(n:number)=>Promise<number>=async(n:number)=>{
                await Promise.resolve();
                if(n>0)return changed+await local(n-1);
                return 0;
            };
            const pending=local(3);
            changed=2;
            return pending;
        }
        const reject=async(n:number):Promise<void>=>{
            await Promise.resolve();
            if(n>0)return reject(n-1);
            throw new Error("terminal");
        };
        let locallyCaught=false;
        const adopt:()=>Promise<void>=async()=>{
            try{return reject(1);}catch(error){locallyCaught=true;}
        };
        const conciseVoid:()=>Promise<void>=async()=>reject(1);
        let sideEffects="";
        async function selected(value:number):Promise<number>{sideEffects+=String(value);await Promise.resolve();return value;}
        function schedule():void{
            let count=0;
            const next=async(n:number):Promise<void>=>{
                await Promise.resolve();
                count++;
                if(n>0)setTimeout(()=>{void next(n-1);},0);
                else{
                    if(count!==3)throw new Error("deferred recursive captures");
                    globalThis.close();
                }
            };
            void next(2);
        }
        void(async()=>{
            await descend(3);
            if(visits!==4||await sum(4)!==4||await named(3)!==3||await first(3)!==1||await launch()!==6)
                throw new Error("recursion and activation lifetime");
            const bytes=new Uint8Array([7]);
            const state=await advance({value:2,bytes});
            if(state.value!==0||state.bytes!==bytes||state.bytes[0]!==7)throw new Error("owned result identity");
            let errors=0;
            await adopt().catch(error=>{if(String(error)!=="Error: terminal")throw new Error("adopted rejection");errors++;});
            await conciseVoid().catch(()=>{errors++;});
            if(errors!==2||locallyCaught)throw new Error("return promise catch boundary");
            let flag=true;
            const chosen=flag?await selected(1):await selected(2);
            flag=false;
            const other=flag?await selected(3):await selected(4);
            if(chosen!==1||other!==4||sideEffects!=="14")throw new Error("lazy suspension");
            schedule();
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
