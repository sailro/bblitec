import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

/** A worker realm: the entry owns a worker, so every realm-sensitive lowering takes the worker path,
 *  and its event loop runs until the program closes it. */
const workerRealm='const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();\n';

function nativeCheck(name:string, source:string, t:test.TestContext, workers=false):void {
    const directory=resolve("artifacts/callback-values",name);
    mkdirSync(directory,{recursive:true});
    if(workers)writeFileSync(join(directory,"worker.ts"),"self.close();");
    const compiled=compileSource(workers?workerRealm+source+"\nglobalThis.close();":source,{fileName:join(directory,"entry.ts")});
    const native=optionalNativeFixtureTools(false);
    if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,compiled.cpp);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD",...(workers?["/DBBLITE_WORKERS=1"]:[]),
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    assert.equal(execFileSync(exe,{encoding:"utf8",timeout:10000}),"");
}

test("Math function values preserve defaults, storage, identity and fixed signatures", t => nativeCheck("math",`
    function sample(next:()=>number=Math.random):number{return next();}
    const first=sample(),second=sample();
    if(first<0||first>=1||second<0||second>=1||first===second) throw new Error("random defaults");
    if(sample(()=>0.25)!==0.25) throw new Error("explicit callback");
    const abs=Math.abs;
    if(abs(-3)!==3) throw new Error("unary function");
    const pow=Math.pow;
    if(pow(2,3)!==8) throw new Error("binary function");
    const callbacks:((x:number)=>number)[]=[Math.floor,Math.ceil];
    if(callbacks[0](1.5)!==1||callbacks[1](1.5)!==2) throw new Error("stored functions");
    if(callbacks[0]!==Math.floor) throw new Error("stored identity");
    const floor=Math.floor,other=Math.floor;
    if(floor!==other||floor===Math.ceil) throw new Error("function identity");
    const set=new Set<(x:number)=>number>([floor,other]);
    if(set.size!==1||!set.has(Math.floor)||set.has(Math.ceil)) throw new Error("function keys");
    const direct=[1.5,2.5].map(Math.floor);
    const alias=[1.5,2.5].map(floor);
    if(direct.join(",")!=="1,2"||alias.join(",")!=="1,2") throw new Error("callback invocation");
    const values=[0,-2,3];values.push(-4);
    if(values.filter(Math.abs).join(",")!=="-2,3,-4") throw new Error("numeric predicate");
    function local(){const Math={floor:(x:number)=>x+10};return Math.floor(2);}
    if(local()!==12) throw new Error("lexical shadow");
`,t));

test("forwarded array predicates preserve captured state, truthiness and short circuiting", t => nativeCheck("predicates",`
    function some(fn:(x:number)=>boolean):boolean{return [1,2,3].some(fn);}
    function every(fn:(x:number)=>boolean):boolean{return [1,2,3].every(fn);}
    function filter(fn:(x:number)=>number):number[]{return [0,2,3].filter(fn);}
    function find(fn:(x:number)=>boolean){return [1,2,3].find(fn);}
    let count=0;
    if(!some(x=>{count++;return x===2;})||count!==2) throw new Error("some short circuit");
    count=0;
    if(every(x=>{count++;return x<2;})||count!==2) throw new Error("every short circuit");
    count=0;
    if(find(x=>{count++;return x===2;})!==2||count!==2) throw new Error("find short circuit");
    if(filter(x=>x).join(",")!=="2,3") throw new Error("numeric truthiness");
    let bound=0;bound++;
    if(!every(x=>x>=bound)) throw new Error("captured predicate");
    if(!some(x=>{if(x<2)return false;return true;})) throw new Error("early returns");
    function forward(fn:(x:number)=>boolean){return some(fn);}
    if(!forward(x=>x===3)) throw new Error("nested forwarding");
    function named(x:number):boolean{return x===3;}
    if(!some(named)) throw new Error("named callback");
    function make(bound:number):(x:number)=>boolean{return x=>x===bound;}
    const captured=make(2);
    if(!some(captured)) throw new Error("returned callback");
    let selected:(x:number)=>boolean=x=>{selected=()=>false;return x===2;};
    if(!some(selected)) throw new Error("callback selection snapshot");
    const owner={limit:2,check(x:number){return x>=this.limit;}};
    if(!some(x=>owner.check(x))) throw new Error("record capture");
    const ranges=[[1,3],[8,10]] as const;
    let inspected=0;
    if(!ranges.some(([first,last])=>{inspected++;return 9>=first&&9<=last;})||inspected!==2)
        throw new Error("tuple parameter binding");
`,t));

test("variadic Math callbacks retain identity, numeric edge cases and spread order", t => nativeCheck("variadic-math", `
    const maximum = Math.max, minimum = Math.min, length = Math.hypot;
    if(maximum() !== -Infinity || minimum() !== Infinity || length() !== 0)
        throw new Error("empty numeric rest");
    if(Math.max() !== -Infinity || Math.min() !== Infinity || Math.hypot() !== 0 || Math.hypot(-4) !== 4)
        throw new Error("direct empty and single numeric calls");
    if(maximum(-3) !== -3 || minimum(7) !== 7 || length(-4) !== 4)
        throw new Error("single numeric rest");
    const values = [3, 4]; values.push(12);
    if(length(...values) !== 13 || maximum(-1, ...values, 20) !== 20)
        throw new Error("numeric spread");
    if(Math.hypot(...values) !== 13 || Math.min(20, ...values, -1) !== -1 ||
        Math.hypot(NaN, Infinity) !== Infinity || length(Infinity, NaN) !== Infinity)
        throw new Error("direct spread and infinite norm");
    if(1 / maximum(-0, 0) !== Infinity || 1 / minimum(0, -0) !== -Infinity ||
        !Number.isNaN(maximum(1, NaN, 2)) || !Number.isNaN(minimum(NaN, 1)))
        throw new Error("extreme numeric values");
    if(1 / Math.max(-0, 0) !== Infinity || 1 / Math.min(0, -0) !== -Infinity ||
        !Number.isNaN(Math.max(1, NaN, 2))) throw new Error("direct extreme numeric values");
    const stored: Array<(...items: number[]) => number> = [Math.min, Math.max, Math.hypot];
    if(stored[0](5, 2, 9) !== 2 || stored[1]() !== -Infinity || stored[2](3, 4) !== 5)
        throw new Error("stored numeric rest");
    const fixed: (a: number, b: number) => number = maximum;
    const functions = new Set<(a: number, b: number) => number>([fixed, Math.max]);
    if(fixed(2, 8) !== 8 || functions.size !== 1 || !functions.has(Math.max) || functions.has(Math.min))
        throw new Error("fixed signature adaptation and identity");
    let step = 0;
    function next(): number { step++; return step; }
    if(maximum(next(), next(), next()) !== 3 || step !== 3)
        throw new Error("argument evaluation count");
    const changing = [1]; changing.push(2);
    function clear(): number { changing.length = 0; return 0; }
    if(Math.max(...changing) + clear() !== 2) throw new Error("spread read before later effects");
`, t));

test("stored rest parameters own fresh arrays and preserve prefix evaluation", t => nativeCheck("stored-rest", `
    const callbacks: Array<(...values: number[]) => number> = [
        (...values: number[]) => { values.push(5); return values.reduce((sum, value) => sum + value, 0); }
    ];
    const source = [1, 2]; source.push(3);
    if(callbacks[0](...source) !== 11 || source.length !== 3 || callbacks[0]() !== 5)
        throw new Error("rest array ownership");
    let prefix = "before";
    const labels: Array<(prefix: string, ...words: string[]) => string> = [
        (prefix: string, ...words: string[]) => prefix + ":" + words.join(",")
    ];
    function mutate(): string { prefix = "after"; return prefix; }
    if(labels[0](prefix, mutate(), "last") !== "before:after,last")
        throw new Error("fixed prefix snapshot");
    const fixed: (a: number, b: number) => number = (...values: number[]) => values[0] + values[1];
    if(fixed(2, 3) !== 5) throw new Error("rest declaration in a fixed signature");
    function collect(...values: number[]): number { values.push(5); return values.length; }
    if(collect(...source) !== 4 || source.length !== 3) throw new Error("direct rest owns its array");
    interface Item { value: number; }
    const items: Item[] = [{value:1}, {value:2}];
    function edit(...values: Item[]): number { values[0].value = 9; values.pop(); return values.length; }
    if(edit(...items) !== 1 || items.length !== 2 || items[0].value !== 9)
        throw new Error("rest copy preserves element identity");
`, t));

/** A callback that names itself is materialized once; every sink shares that storage, adapted when the
 *  sink supplies more than the callback reads or reads less than it returns. The plain realm materializes
 *  a callback on a direct call, the worker realm on any self reference, so both realms run the same source. */
const sharedStorage=`
    const queue: Array<(time: number) => void> = [];
    let visits = 0;
    const poll = (): void => { visits++; if (visits < 3) queue.push(poll); };
    poll();
    while (queue.length > 0) { const next = queue.shift()!; next(16); }
    if (visits !== 3) throw new Error("wider signature");
    const again: Array<() => void> = [];
    let ticks = 0;
    const tick = (): void => { ticks++; if (ticks < 3) again.push(tick); };
    tick();
    while (again.length > 0) { const next = again.shift()!; next(); }
    if (ticks !== 3) throw new Error("same signature in an identity-carrying sink");
    const seen: number[] = [];
    const tally: Array<(value: number, index: number) => void> = [];
    const count = (value: number): number => { seen.push(value); if (seen.length < 3) tally.push(count); return seen.length; };
    count(-1);
    tally.push(count);
    while (tally.length > 0) { const next = tally.shift()!; next(seen.length, 99); }
    if (seen.join(",") !== "-1,1,2,3") throw new Error("supplied prefix, dropped extras and result");
`;

test("self-referential callbacks share their storage across sink signatures", t =>
    nativeCheck("shared-storage", sharedStorage, t));

test("self-referential callbacks share their storage across sink signatures in a worker realm", t =>
    nativeCheck("shared-storage-worker", sharedStorage, t, true));

test("a stored callback reaching a signature its storage cannot serve refuses instead of recursing", () => {
    assert.throws(() => compileSource(`
        const steps: Array<() => void> = [];
        const walk = (step = 1): void => { if (step > 0) steps.push(walk); };
        walk(2);
    `), /re-enters its own lowering/);
});
