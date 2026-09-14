import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("destructuring preserves generic identities, nested storage and lazy assignment order", t => {
    const directory=resolve("artifacts/destructuring-assignments");mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,"worker.ts"),"self.close();");
    const result=compileSource(`
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        function exchange<T>(items:T[]):void{[items[0],items[1]]=[items[1]!,items[0]!];}
        const numbers:number[]=[3,7];exchange(numbers);
        const strings:string[]=["a","b"];exchange(strings);
        const optional:(number|null)[]=[3,null];exchange(optional);
        const first={value:3},second={value:7};const records=[first,second];exchange(records);records[0]!.value=9;
        if(numbers.join(",")!=="7,3"||strings.join(",")!=="b,a"||optional[0]!==null||optional[1]!==3||
            records[0]!==second||second.value!==9||records[1]!==first)throw new Error("generic identities");
        function rotate<T>(items:T[]):T[]{let head=items[0]!;let tail:T[]=[];[head,...tail]=items;tail.push(head);return tail;}
        if(rotate([3,7,9]).join(",")!=="7,9,3")throw new Error("generic rest");
        let a=0,b=0;let rest:number[]=[];const groups:number[][]=[[3,7,9]];
        [[a,b,...rest]]=groups;rest[0]=11;
        if(a!==3||b!==7||rest[0]!==11||groups[0]![2]!==9)throw new Error("nested rest");
        let calls=0;function fallback(){calls++;return 13;}
        const values:(number|undefined)[]=[undefined,7];[a=fallback(),b=fallback()]=values;
        if(a!==13||b!==7||calls!==1)throw new Error("lazy defaults");
        const pair:[number|undefined,number]=[undefined,7];[a=fallback(),b=fallback()]=pair;
        const empty:number[]=[];[b=fallback()]=empty;
        if(a!==13||b!==13||calls!==3)throw new Error("tuple and missing defaults");
        let nullable:number|null=5;const nulls:(number|null)[]=[null];[nullable=fallback()]=nulls;
        if(nullable!==null||calls!==3)throw new Error("null does not default");
        const slots:number[]=[0];let order="";
        function key(){order+="k";return 0;}
        function grow(){order+="d";for(let i=0;i<200;i++)slots.push(i);return 17;}
        [slots[key()]=grow()]=empty;
        if(slots[0]!==17||slots.length!==201||order!=="kd")throw new Error("retained array reference");
        let seen=0;const target={set value(input:number){order+="s";seen=input;}};
        function owner(){order+="o";return target;}
        [owner().value=fallback()]=empty;
        if(seen!==13||order!=="kdos"||calls!==4)throw new Error("setter order");
        let index=0;const indexed:number[]=[3,7];[indexed[index++],indexed[index++]]=[indexed[1]!,indexed[0]!];
        if(index!==2||indexed.join(",")!=="7,3")throw new Error("ordered targets");
        let reads=0;function read(index:number){reads++;return indexed[index]!;}
        [indexed[0],indexed[1]]=[read(1),read(0)];[a,b]=[...indexed];
        if(reads!==2||a!==3||b!==7)throw new Error("source effects and spreads");
        [a=fallback(),nullable=fallback(),b=fallback()]=[undefined,null,,];
        if(a!==13||nullable!==null||b!==13||calls!==6)throw new Error("literal absence defaults");
        let nestedDefault:number[]=[];[nestedDefault=[19]]=[];
        if(nestedDefault[0]!==19)throw new Error("missing array default");
        globalThis.close();
    `,{fileName:join(directory,"entry.ts")});
    const tools=optionalNativeFixtureTools(false);if(!tools){t.skip("Native fixture compiler unavailable.");return;}
    const cpp=join(directory,"check.cpp"),exe=join(directory,"check.exe");writeFileSync(cpp,result.cpp);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/DBBLITE_WORKERS=1",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    const execution=spawnSync(exe,{encoding:"utf8",timeout:10000});
    assert.ifError(execution.error);assert.equal(execution.status,0,execution.stderr);
    assert.equal(execution.stdout,"");assert.equal(execution.stderr,"");
});

test("destructuring refuses defaults when nullable storage cannot distinguish null from undefined", () => {
    assert.throws(()=>compileSource(`let value:number|null=0;const source:(number|null|undefined)[]=[null];[value=3]=source;`),
        /distinguishable null and undefined/);
});
