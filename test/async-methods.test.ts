import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("async methods preserve activation timing, receivers and conditional evaluation", async (t) => {
    const directory = resolve("artifacts/async-methods");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const body = `(async()=>{
        const order:string[]=[];
        function create(initial:number){return {
            value:initial,
            async add(left:number,right:number){order.push("start");await Promise.resolve();this.value+=left+right;order.push("end");return this.value;},
            async flush(){await Promise.resolve();order.push("flush");},
            async fail():Promise<number>{await Promise.resolve();throw new Error("expected");}
        };}
        const first=create(1),second=create(10);
        let argument=2;
        const pending=first.add(argument,argument++);
        if(argument!==3||first.value!==1||order.join(",")!=="start")throw new Error("argument order or early suspension");
        argument=20;
        if(await pending!==5||first.value!==5)throw new Error("parameter snapshot or receiver mutation");
        if(await second["add"](1,2)!==13||first.value!==5)throw new Error("independent receivers");
        const flags:boolean[]=[false,true];
        let conditions=0,argumentsRead=0;
        function condition(value:boolean){conditions++;return value;}
        function next(){argumentsRead++;return 1;}
        for(const enabled of flags){
            const selected=condition(enabled)?first.add(next(),next()):Promise.resolve(first.value);
            const value=await selected;
            if(value!==(enabled?7:5)||argumentsRead!==(enabled?2:0))throw new Error("conditional branch effects");
            const completion=condition(enabled)?first.flush():Promise.resolve();await completion;
        }
        if(conditions!==4||order.join(",")!=="start,end,start,end,start,end,flush")throw new Error("conditional activation order");
        const recovered=await first.fail().catch(error=>{if(error.message!=="expected")throw error;return 17;});
        if(recovered!==17)throw new Error("method rejection");
        let count=0;
        async function named(){await Promise.resolve();count++;}
        const callbacks={named,arrow:async()=>{await Promise.resolve();count++;},async literal(){await Promise.resolve();count++;}};
        const a=callbacks.named(),b=callbacks.arrow(),c=callbacks.literal();
        if(count!==0)throw new Error("separate activations");await a;await b;await c;
        const alias=callbacks.literal;await alias();if(count!==4)throw new Error("callback alias");
        class Counter{value=0;async add(left:number,right:number){await Promise.resolve();this.value+=left+right;return this.value;}}
        const counter=new Counter();let input=3;const result=counter.add(input,input++);input=100;
        if(await result!==6||counter.value!==6)throw new Error("class argument snapshots");
        class StoredCounter {
            constructor(public value:number) {}
            read():number {return this.value;}
        }
        const storedCounters:StoredCounter[]=[new StoredCounter(7)];
        async function readStored():Promise<number> {
            const value=storedCounters[0]!.read();
            await Promise.resolve();
            return value;
        }
        const earlier=readStored(),later=readStored();
        if(await earlier!==7||await later!==7)
            throw new Error("overlapping computed receiver lifetimes");
        const delayed:((count:number,fallback?:number,label?:string)=>Promise<string>)[]=[
            async(count:number,fallback=60,label="default")=>{
                await Promise.resolve();
                return label+":"+String(count+fallback);
            }
        ];
        let copiedCount=2,copiedLabel="kept";
        const copied=delayed[0]!(copiedCount,undefined,copiedLabel);
        copiedCount=40;copiedLabel="changed";
        if(await copied!=="kept:62"||await delayed[0]!(copiedCount,2)!=="default:42")
            throw new Error("stored coroutine parameter ownership");
        const owned=async(value:number):Promise<number>=>{await Promise.resolve();return value+3;};
        const ownedAlias:(value:number)=>Promise<number>=owned;
        const inputs:number[]=[1,2];
        const mapped=await Promise.all(inputs.map(value=>owned(value)));
        if(mapped[0]!==4||mapped[1]!==5||await ownedAlias(4)!==7||await owned(5)!==8)
            throw new Error("stored callbacks transfer fresh owners and retain aliases");
        globalThis.close();
    })();`;
    let closed = false;
    await runInNewContext(
        ts.transpile(body, { target: ts.ScriptTarget.ES2022 }),
        {
            close: () => {
                closed = true;
            },
        },
    );
    assert.equal(closed, true, "JavaScript oracle completed");
    const prefix =
        'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();';
    const result = compileSource(prefix + body, {
        fileName: join(directory, "entry.ts"),
    });
    const parameters = result.cpp.match(
        /double (fn\d+_)arg_0, \[\[maybe_unused\]\] bbl::js::Nullable<double> \1arg_1, \[\[maybe_unused\]\] bbl::js::Nullable<std::string> \1arg_2/,
    );
    assert.ok(parameters, "stored async callback keeps typed parameters");
    const parameterPrefix = parameters[1]!;
    assert.match(
        result.cpp,
        new RegExp(
            `bblscene::v_bblite_async_body_\\d+\\(v_bblite_environment_\\d+, ${parameterPrefix}arg_0, ${parameterPrefix}arg_1, std::move\\(${parameterPrefix}arg_2\\)\\);`,
        ),
        "coroutine frame copies numeric parameters and moves owned strings",
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(
        cpp,
        `#define main generated_main\n${result.cpp}\n#undef main\n` +
            `int main(){const auto baseline=bbl::js::managed_node_count();const int result=generated_main();` +
            `bbl::js::collect_cycles();if(bbl::js::managed_node_count()!=baseline)throw std::runtime_error("async method ownership leak");return result;}\n`,
    );
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
    const execution = spawnSync(exe, {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
    });
    assert.equal(execution.stdout, "");
    assert.equal(execution.stderr, "");
    assert.ifError(execution.error);
    assert.equal(execution.status, 0);
});
