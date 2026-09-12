import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

function nativeCheck(name:string, source:string, t:test.TestContext):void {
    const directory=resolve("artifacts/callback-values",name);
    mkdirSync(directory,{recursive:true});
    const compiled=compileSource(source,{fileName:join(directory,"entry.ts")});
    const native=optionalNativeFixtureTools(false);
    if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");
    writeFileSync(cpp,compiled.cpp);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/I","native/include",
        `/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
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

test("stored variadic Math functions refuse a missing calling convention", () => {
    for(const member of ["max","min","hypot"])
        assert.throws(()=>compileSource(`const callback=Math.${member};`),/variable-argument function representation/);
});
