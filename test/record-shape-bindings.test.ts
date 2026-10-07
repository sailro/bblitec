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
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Requires the Windows native fixture compiler.");
            return;
        }
        runGeneratedProgram(
            tools,
            `record-shape-bindings/${name}`,
            result.cpp,
            {
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
}

check(
    "finite record tables retain differently sized tuple fields",
    `
    const short={tag:'short' as const,slots:[2] as const,offset:{x:3},count:1};
    const long={tag:'long' as const,slots:[5,7,11] as const,offset:{x:13},count:2,extra:17};
    const table={short,long};
    const tableHolder:(typeof table)[]=[table];
    function retain(value:typeof table):typeof table{return value;}
    const stored=retain(tableHolder[0]);
    function pick(key:keyof typeof table){return stored[key];}
    const a=pick('short'),b=pick('long');
    if(stored!==table || a!==short || b!==long || a.slots!==short.slots || b.slots!==long.slots)
        throw new Error('table identities');
    if(a.slots.length!==1 || b.slots.length!==3 || a.slots[0]!==2 || b.slots[2]!==11)
        throw new Error('tuple lengths and values');
    if(b.tag==='long' && b.extra!==17)throw new Error('arm field');
    a.count=19;long.count=23;a.offset.x=29;
    if(short.count!==19 || b.count!==23 || short.offset.x!==29)
        throw new Error('selected and original mutation');
`,
);

check(
    "contextual record enum fields preserve template string evaluation",
    `
    let calls=0;
    const greenName='green';
    function color():'green'|'yellow'{calls++;return calls===1?'green':'yellow';}
    const values:{stand:'green_stand'|'yellow_stand'}[]=[
        {stand:\`\${greenName}_stand\`},
        {stand:\`\${color()}_stand\`},
        {stand:\`\${color()}_stand\`},
    ];
    if(values[0].stand!=='green_stand' || values[1].stand!=='green_stand' || values[2].stand!=='yellow_stand')
        throw new Error('record template values');
    if(calls!==2)throw new Error('template expression evaluation');
`,
);

check(
    "array and tuple alternatives share their original storage",
    `
    const live:number[]=[2,3];
    const fixed=[5,7,11] as const;
    const table={live:{tag:'live',values:live},fixed:{tag:'fixed',values:fixed}} as const;
    function select(key:keyof typeof table){return table[key].values;}
    function same(a:readonly number[],b:readonly number[]):boolean{return a===b;}
    const selected=select('live'),other=select('fixed');
    live.push(13);
    if(selected!==live || !same(other,fixed) || selected.length!==3 || selected[2]!==13)
        throw new Error('selected array identity');
`,
);

check(
    "record union storage keeps retained source fields",
    `
    const original={value:1,extra:2};
    const retained:(typeof original)[]=[original];
    const small={value:3};
    const table={original:retained[0],small};
    const read:(key:keyof typeof table)=>typeof original|typeof small=key=>table[key];
    const result=read(Date.now()>0?'original':'small');
    if(result!==original || read('small')!==small || result.value!==1)throw new Error('selected identities');
    original.extra=5;
    if(!('extra' in result) || 'extra' in small || (result as typeof original).extra!==5)throw new Error('retained field');
    if(Object.keys(result).join()!=='value,extra' || JSON.stringify(read('small'))!=='{"value":3}')throw new Error('keys');
`,
);

test("record union storage refuses widening a mutable scalar field", () => {
    assert.throws(
        () =>
            compileSource(`
            const first={tag:'number' as const,value:1};
            const second={tag:'text' as const,value:'text'};
            const stored:(typeof first)[]=[first];
            const table={first,second};
            const read:(key:keyof typeof table)=>typeof first|typeof second=key=>table[key];
            const selected=read(Date.now()>0?'first':'second');
            if(selected===stored[0])throw new Error('selected');
        `),
        /preserving its original fields and storage kinds/,
    );
});

check(
    "retained aliases share one layout across two record unions",
    `
    const a={tag:'a' as const,values:[1] as const};
    const b={tag:'b' as const,values:[2,3] as const};
    const c={tag:'c' as const,values:[4,5,6] as const};
    const shared:(typeof a)[]=[a];
    const first={a:shared[0],b},second={a:shared[0],c};
    const read1:(key:keyof typeof first)=>typeof a|typeof b=key=>first[key];
    const read2:(key:keyof typeof second)=>typeof a|typeof c=key=>second[key];
    const result1=read1('a'),result2=read2('a');
    if(result1!==a || result2!==a || read1('b')!==b || read2('c')!==c)throw new Error('selected identities');
    if(result1.values!==result2.values || result1.values[0]!==1 || read1('b').values[1]!==3 || read2('c').values.length!==3)throw new Error('tuple fields');
    if(Object.keys(read2('c')).join()!=='tag,values' || JSON.stringify(read1('b'))!=='{"tag":"b","values":[2,3]}')throw new Error('keys');
`,
);

test("record union storage refuses a wider record's field stored another way", () => {
    assert.throws(
        () =>
            compileSource(`
            interface End { x: number; label: number }
            type Flat = { x: number };
            type Mark = { x: number; label?: string };
            const end: End = { x: 1, label: 2 };
            const spots: (Flat | Mark)[] = [{ x: 3 }];
            spots.push(end);
            const seen = new Set<Flat | Mark>(spots);
            if (!seen.has(end)) throw new Error('identity');
        `),
        /no one layout stores their property 'label' both ways/,
    );
});

check(
    "nested record and array bindings keep aliases and defaults lazy",
    `
    interface Item {value:number;}
    interface Source {item?:Item;rows:Item[];label:string;}
    const events:number[]=[];
    const shared:Item={value:3};
    function fallback(value:number):Item {events.push(value);return {value};}
    let calls=0;
    function source():Source {calls++;return {item:shared,rows:[shared],label:'kept'};}
    const {item:{value}=fallback(20),rows:[{value:first}=fallback(30),{value:second}=fallback(40)],...rest}=source();
    if(calls!==1 || value!==3 || first!==3 || second!==40 || events.join(',')!=='40' || rest.label!=='kept')
        throw new Error('nested evaluation order');
    const {item:alias}=source();
    shared.value=9;
    if(alias!==shared || alias!.value!==9)throw new Error('nested owner identity');
    const missing:Source={rows:[],label:'empty'};
    const {item:{value:fromDefault}=fallback(50)}=missing;
    if(fromDefault!==50 || events.join(',')!=='40,50')throw new Error('object default');
    const rows:(Item|undefined)[]=[undefined,shared];
    const [{value:empty}=fallback(60),{value:present}=fallback(70)]=rows;
    if(empty!==60 || present!==9 || events.join(',')!=='40,50,60')throw new Error('undefined lane default');
    const nullable:(Item|null)[]=[null,shared];
    const [keptNull=fallback(80),keptItem=fallback(90)]=nullable;
    if(keptNull!==null || keptItem!==shared || events.join(',')!=='40,50,60')throw new Error('null lane default');
`,
);

check(
    "nested patterns compose with tuple rest and contextual callbacks",
    `
    interface Item {value:number;}
    const item:Item={value:2};
    const data={nested:{item,pair:[3,5,7] as const}};
    const {nested:{item:{value},pair:[first,...tail]}}=data;
    const [[{value:lane}],{nested:{item:alias}}]=[[item],data] as const;
    function read({nested:{item:{value}}}:typeof data):number{return value;}
    const mapped=[data].map(({nested:{item:{value},pair:[first]}})=>({value,first}));
    if(value!==2 || first!==3 || tail.length!==2 || tail[0]!==5 || tail[1]!==7 || lane!==2 || alias!==item || read(data)!==2 || mapped[0].first!==3)
        throw new Error('composed nested bindings');
`,
);
