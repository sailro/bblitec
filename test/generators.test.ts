import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("generators suspend between pulls, share position and close on abrupt iteration", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const result = compileSource(`
        let state=0,cleanups=0;
        function tick():number {state++;return state;}
        function* sequence(count:number):Generator<number,void,unknown>{
            try { for(let i=0;i<count;i++)yield tick(); }
            finally { cleanups++; }
        }
        const first=sequence(3),alias=first;
        if(state!==0||first!==alias)throw new Error('eager body or lost identity');
        if(first.next().value!==1||tick()!==2||alias.next().value!==3)throw new Error('pull order');
        const output:number[]=[];
        for(const value of first){output.push(value);tick();}
        if(output.join()!=='4'||state!==5||cleanups!==1||!first.next().done)throw new Error('completion');
        const unopened=sequence(2);unopened.return();
        if(cleanups!==1||state!==5||!unopened.next().done)throw new Error('unstarted return');
        const closed=sequence(3);
        for(const value of closed){if(value!==6)throw new Error('wrong next');break;}
        if(cleanups!==2||!closed.next().done)throw new Error('break close');
        const thrown=sequence(3);
        let caught=false;
        try{for(const value of thrown){if(value===7)throw new Error('consumer');}}
        catch(error){caught=true;if((error as Error).message!=='consumer')throw new Error('exception identity');}
        if(!caught||cleanups!==3||!thrown.next().done)throw new Error('throw close');
        let mapped=false;
        try{Array.from(sequence(3),(value):number=>{if(value>0)throw new Error('mapper');return value;});}
        catch(error){mapped=true;if((error as Error).message!=='mapper')throw new Error('mapper identity');}
        if(!mapped||cleanups!==4)throw new Error('mapper close');
        {const abandoned=sequence(3);abandoned.next();}
        if(cleanups!==4)throw new Error('abandonment must not run source cleanup');
        const closeFailure=new Error('nested close'),bodyFailure=new Error('nested body');
        function* broken():Generator<number,void,unknown>{try{yield 1;}finally{throw closeFailure;}}
        function* nested(mode:number):Generator<number,void,unknown>{
            for(const value of broken()){yield value;if(mode===1)throw bodyFailure;if(mode===2)return;}
        }
        for(const mode of [0,1,2]){
            const inner=nested(mode);inner.next();let rejected=false;
            try{if(mode===0)inner.return();else inner.next();}
            catch(error){rejected=true;if(error!==(mode===1?bodyFailure:closeFailure))throw new Error('nested precedence');}
            if(!rejected)throw new Error('missing nested close failure');
        }
    `);
    assert.match(result.cpp, /co_yield/);
    runGeneratedProgram(tools, "generator-control-check", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("asynchronous generators await producers, yield lazily, and close through awaited cleanup", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/async-generator-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();
        void(async()=>{
            const log:string[]=[];let ticks=0;
            const catalog={values:async function*():AsyncGenerator<number,void,unknown>{
                try {log.push('start');const rows=await Promise.resolve([2,4,6]);for(const row of rows){ticks++;yield row+ticks;}}
                finally{await Promise.resolve();log.push('closed');}
            }};
            const iterator=catalog.values();if(log.length!==0)throw new Error('eager async body');
            const result:number[]=[];
            for await(const value of iterator){result.push(value);ticks+=10;}
            if(result.join()!=='3,16,29'||log.join()!=='start,closed')throw new Error('async ordering');
            const partial=catalog.values();for await(const value of partial){if(value<=0)throw new Error('value');break;}
            if(log.join()!=='start,closed,start,closed')throw new Error('async close');
            async function early():Promise<number>{for await(const value of catalog.values())return value;return 0;}
            if(await early()<=0||log.length!==6)throw new Error('async return close');
            let caught=false;try{for await(const value of catalog.values()){if(value>0)throw new Error('consumer');}}
            catch(error){caught=true;if((error as Error).message!=='consumer')throw new Error('async consumer identity');}
            if(!caught||log.length!==8)throw new Error('async exceptional close');
            const queued=catalog.values();const left=queued.next(),right=queued.next(),stop=queued.return();
            const one=await left,two=await right,done=await stop;
            if(one.done||two.done||one.value===undefined||two.value!==one.value+3||!done.done||!(await queued.next()).done||log.length!==10)throw new Error('queued requests');
            const unused=catalog.values();if(!(await unused.return()).done||log.length!==10)throw new Error('async unstarted return');
            const failure=new Error('cleanup failure');
            async function* broken():AsyncGenerator<number,void,unknown>{try{yield 1;}finally{await Promise.resolve();throw failure;}}
            let cleanupCaught=false;try{for await(const value of broken()){if(value===1)break;}}
            catch(error){cleanupCaught=true;if(error!==failure)throw new Error('cleanup identity');}
            if(!cleanupCaught)throw new Error('break cleanup failure');
            let bodyCaught=false;try{for await(const value of broken()){if(value===1)throw new Error('body failure');}}
            catch(error){bodyCaught=true;if((error as Error).message!=='body failure')throw new Error('pending throw priority');}
            if(!bodyCaught)throw new Error('missing body failure');
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "async-generator-check", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("stored generator callbacks retain records, tuples, parameters and their lexical environment", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const result = compileSource(`
        interface Item { value:number; }
        function create(){
            const source=new Map<string,Item[]>([['a',[{value:2}]],['b',[{value:4}]]]);
            const entries=function*():IterableIterator<[string,readonly Item[]]>{
                for(const [key,list] of source)yield [key,Object.freeze([...list])];
            };
            return {entries,add(key:string,value:number){source.set(key,[{value}]);}};
        }
        const view=create();const iterator=view.entries();view.add('c',6);
        const values:number[]=[];const names:string[]=[];
        for(const [key,list] of iterator){names.push(key);values.push(list[0]!.value);}
        if(names.join()!=='a,b,c'||values.join()!=='2,4,6')throw new Error('stored capture');
        const callbacks:(()=>IterableIterator<number>)[]=[function*(){yield 17;yield 19;}];
        const yielded=callbacks[0]!();
        if(yielded.next().value!==17||yielded.next().value!==19||!yielded.next().done)throw new Error('stored invocation');
        function* parameter(value:number):Generator<number,void,unknown>{yield value;value++;yield value;}
        let input=3;const captured=parameter(input);input=8;
        if(captured.next().value!==3||captured.next().value!==4||input!==8)throw new Error('parameter snapshot');
        let shared=5;const mutate=()=>{shared=13;};
        const delayed=parameter(shared);mutate();
        if(delayed.next().value!==5||shared!==13)throw new Error('shared argument snapshot');
        let defaults=0;function initial():number {defaults++;return defaults;}
        function* configured(value=initial()):Generator<number,void,unknown>{yield value;}
        const configuredValue=configured();if(defaults!==1||configuredValue.next().value!==1)throw new Error('parameter initialization timing');
    `);
    runGeneratedProgram(tools, "generator-stored-check", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("unsupported generator protocol and retained iterator cycles refuse explicitly", () => {
    for (const [source, message] of [
        [
            "function* values(){yield* new Set([1,2]);}const iterator=values();iterator.next();",
            /yield\* delegates to a generator, an iterator or an array/,
        ],
        [
            "function* values():Generator<number,void,unknown>{yield;}const iterator=values();iterator.next();",
            /empty yields/,
        ],
        [
            "function* values(){yield 1;return 2;}const iterator=values();iterator.next();",
            /return values/,
        ],
        [
            "function* values(){try{yield 1;}finally{yield 2;}}const iterator=values();iterator.next();",
            /Yield in finally/,
        ],
        [
            "function* values(){yield 1;}const iterator=values();iterator.next(3);",
            /without arguments/,
        ],
        [
            "function* values(){yield 1;}const iterator=values();iterator.throw(new Error('input'));",
            /Stored iterators support/,
        ],
        [
            "function* values():SetIterator<number>{yield 1;}const iterator=values();iterator.next();",
            /A generator cannot declare traced collection iterator storage/,
        ],
        [
            "function* values(){yield 1;}const iterator=values();const readers:(()=>number)[]=[()=>iterator.next().value??0];readers[0]!();",
            /Retained closures cannot capture opaque iterator storage/,
        ],
        [
            "const box:{iterator?:IterableIterator<number>}={};function* values():IterableIterator<number>{if(box.iterator)yield box.iterator.next().value??0;}const iterator=values();box.iterator=iterator;iterator.next();",
            /Retained closures cannot capture opaque iterator storage/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});
