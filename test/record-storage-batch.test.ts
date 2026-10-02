import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `record-storage-batch/${name}`, result.cpp);
    });
}

check(
    "mixed-union-json",
    `
    interface Cell { score:number; label:'first'|'second'; }
    type Payload=number|boolean|string|Cell|readonly number[];
    interface Entry { value:Payload; missing?:Payload; empty:Payload|null; }
    const cell:Cell={score:4,label:'first'};
    const values:Entry[]=[
        {value:2,empty:null},
        {value:false,missing:'present',empty:''},
        {value:'three',empty:0},
        {value:cell,empty:true},
        {value:[5,6],empty:cell},
    ];
    const expected='[{"value":2,"empty":null},{"value":false,"missing":"present","empty":""},{"value":"three","empty":0},{"value":{"score":4,"label":"first"},"empty":true},{"value":[5,6],"empty":{"score":4,"label":"first"}}]';
    if(JSON.stringify(values)!==expected)throw new Error('union document');
    const dictionary:Record<string,Payload>={'10':cell,'2':[8,9],tail:'end'};
    if(JSON.stringify(dictionary)!=='{"2":[8,9],"10":{"score":4,"label":"first"},"tail":"end"}')throw new Error('dictionary union');
    cell.score=7;
    if(JSON.stringify(values[3]!.value)!=='{"score":7,"label":"first"}')throw new Error('live record alias');
    const numbers:(number|string)[]=[NaN,Infinity,-Infinity,-0,'tail'];
    if(JSON.stringify(numbers)!=='[null,null,null,0,"tail"]')throw new Error('union scalar spelling');
    const nested:(string|readonly (number|string)[])[]=['start',[1,'two']];
    if(JSON.stringify(nested,null,2)!=='[\\n  "start",\\n  [\\n    1,\\n    "two"\\n  ]\\n]')throw new Error('nested pretty union');
`,
);

check(
    "nullable-callback-records",
    `
    interface Control { current:()=>boolean; onChange:(on:boolean)=>void; }
    let enabled=false;
    let state=false;
    let conditions=0;
    let creations=0;
    function condition():boolean {conditions++;return enabled;}
    function createCurrent():()=>boolean {creations++;return ()=>state;}
    function select() {
        return condition()?{current:createCurrent(),onChange:(on:boolean)=>{state=on;}}:undefined;
    }
    const absent=select();
    if(absent!==undefined||conditions!==1||creations!==0)throw new Error('untaken initializer');
    enabled=true;
    const first=select();
    const second=select();
    if(!first||!second||first===second||conditions!==3||creations!==2)throw new Error('fresh record identity');
    first.onChange(true);
    if(!first.current()||!second.current())throw new Error('shared capture');
    const alias=first;
    const previous=first.current;
    first.current=()=>false;
    if(alias.current!==first.current||alias.current()||!previous())throw new Error('live field and old callback');
    const typed:Control|undefined=first;
    if(typed!==first||typed.current())throw new Error('structural typed alias');
    const current=()=>state;
    const onChange=(on:boolean)=>{state=on;};
    const shorthand=condition()?{current,onChange}:null;
    if(!shorthand||shorthand.current!==current||shorthand.onChange!==onChange)throw new Error('shorthand identity');
    shorthand.onChange(false);
    if(previous()||second.current())throw new Error('stored callback capture');
    enabled=false;
    const nil=condition()?{current,onChange}:null;
    if(nil!==null||conditions!==5)throw new Error('null branch');
`,
);

test("mixed-union JSON rejects callback alternatives and recursive record paths", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Entry { value:number|(()=>number); }
            const entries:Entry[]=[];
            JSON.stringify(entries);
        `),
        /JSON.stringify does not serialize a 'function' value/,
    );
    assert.throws(
        () =>
            compileSource(`
            interface Entry { next:string|Entry; }
            const entries:Entry[]=[];
            JSON.stringify(entries);
        `),
        /JSON.stringify reaches a cycle/,
    );
});

test("JSON serialization refuses Set and Map storage, including union alternatives", () => {
    for (const [type, initializer, refusal] of [
        ["Set<number>", "new Set([1, 2])", /does not serialize a 'set' value/],
        [
            "Map<string, number>",
            'new Map([["key", 1]])',
            /does not serialize a Map value/,
        ],
    ] as const) {
        for (const program of [
            `const value: ${type} = ${initializer}; JSON.stringify(value);`,
            `const values: (number | ${type})[] = [1]; JSON.stringify(values);`,
            `const values: (number | ${type})[] = [${initializer}]; JSON.stringify(values);`,
        ])
            assert.throws(() => compileSource(program), refusal);
    }
});

check(
    "nullable-generic-callback-records",
    `
    let enabled=true;
    function create(){return enabled?{call:<T>(value:T):T=>value}:null;}
    const present=create();
    const text=present?.call('text');
    if(present?.call(1)!==1||text!=='text')throw new Error('generic conditional record');
    enabled=false;
    const absent=create();
    let calls=0;
    function argument():number{calls++;return 2;}
    if(absent?.call(argument())!==undefined||calls!==0)throw new Error('absent conditional record');
`,
);
