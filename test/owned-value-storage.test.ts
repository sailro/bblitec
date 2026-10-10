import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string, realm = false): void {
    test(name, async (t) => {
        await runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            { close: () => {} },
        );
        const directory = resolve("artifacts/owned-value-storage", name);
        mkdirSync(directory, { recursive: true });
        if (realm) writeFileSync(join(directory, "worker.ts"), "self.close();");
        const prefix = realm
            ? `const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();\n`
            : "";
        const result = compileSource(prefix + source, {
            fileName: join(directory, "entry.ts"),
        });
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `owned-value-storage/${name}`, result.cpp, {
            flags: realm ? ["/DBBLITE_WORKERS=1"] : [],
            timeoutMs: 10000,
        });
    });
}

check(
    "optional-undefined-own-presence",
    `
    interface Item { value?:undefined; name:string; }
    const items:Item[]=[{name:'absent'},{value:undefined,name:'present'}];
    const absent=items[0]!, present=items[1]!;
    if(absent.value!==present.value||absent.value!=present.value)throw new Error('undefined equality ignores presence');
    if('value' in absent||!('value' in present)||Object.hasOwn(absent,'value')||!Object.hasOwn(present,'value'))throw new Error('own presence');
    if(Object.keys(absent).join()!=='name'||Object.keys(present).join()!=='value,name')throw new Error('own keys');
    for(const item of items){
        if(item.value!==undefined||item.value===null||item.value!=null||item.value)throw new Error('undefined value');
        if(typeof item.value!=='undefined'||String(item.value)!=='undefined'||(''+item.value)!=='undefined')throw new Error('undefined text');
        if((item.value??'fallback')!=='fallback'||JSON.stringify(item.value)!==undefined)throw new Error('undefined sinks');
        if(JSON.stringify(item)!=='{"name":"'+item.name+'"}')throw new Error('JSON omission');
    }
    let effects=0;
    function value():undefined{effects++;return undefined;}
    absent.value=value();
    if(!Object.hasOwn(absent,'value')||effects!==1)throw new Error('present assignment');
    delete present.value;
    if(Object.hasOwn(present,'value')||present.value!==undefined)throw new Error('deletion');
    const copies:Item[]=[{...absent},{...present}];
    if(!Object.hasOwn(copies[0]!,'value')||Object.hasOwn(copies[1]!,'value'))throw new Error('spread presence');
    const last:Item[]=[{value:undefined,name:'before',...present}];
    if(!Object.hasOwn(last[0]!,'value')||last[0]!.name!=='present')throw new Error('absent spread preserves earlier key');
    present.value??=value();
    present.value??=value();
    if(effects!==3||!Object.hasOwn(present,'value'))throw new Error('nullish assignment evaluates undefined');
    let values=0;
    for(const result of Object.values({value:absent.value})){if(result!==undefined)throw new Error('values');values++;}
    if(values!==1)throw new Error('value count');
    const snapshot=absent.value;
    delete absent.value;
    if(snapshot!==undefined||Object.hasOwn(absent,'value'))throw new Error('snapshot');
    let comparisons=0;
    function read(index:number):undefined{comparisons++;return items[index]!.value;}
    if(read(0)!==read(1)||comparisons!==2)throw new Error('equality operand effects');
    const numbers:Array<{value?:number}>=[{}, {value:3}];
    if(present.value!==numbers[0]!.value||numbers[1]!.value===present.value)throw new Error('undefined compared with optional number');
`,
);

check(
    "optional-callback-call-and-adoption",
    `
    interface State{ready():boolean;run<T>(operation:()=>T,prepare?:()=>void):T;}
    let calls=0;
    function make():State{return{ready:()=>true,run<T>(operation:()=>T,prepare?:()=>void):T{prepare?.();return operation();}};}
    const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();
    if(state.run(()=>3)!==3||state.run(()=>'ok',()=>{calls++;})!=='ok')throw new Error('optional generic');
    if(state.run(()=>4,undefined)!==4||calls!==1)throw new Error('explicit absence');
    const callbacks:Array<(prepare?:()=>void)=>number>=[prepare=>{prepare?.();return 7;}];
    if(callbacks[0]!()!==7||callbacks[0]!(undefined)!==7||callbacks[0]!(()=>{calls++;})!==7||calls!==2)throw new Error('stored optional callback');
    const adopted:Array<()=>number>=[callbacks[0]!];
    if(adopted[0]!()!==7||calls!==2)throw new Error('adapted omission');
    function invoke(operation:()=>number):number{return operation();}
    if(invoke(callbacks[0]!)!==7)throw new Error('callback parameter adoption');
    const defaults:Array<(prepare?:()=>void)=>number>=[(prepare=()=>{calls++;})=>{prepare();return calls;}];
    if(defaults[0]!()!==3||defaults[0]!(undefined)!==4||defaults[0]!(()=>{})!==4)throw new Error('default callback');
`,
);

check(
    "async-optional-callback-and-undefined-result",
    `
    interface State{ready():boolean;run<T>(operation:()=>Promise<T>,prepare?:()=>void):Promise<{accepted:true;value:T}|{accepted:false}>;}
    let calls=0;
    function make():State{return{ready:()=>true,async run<T>(operation:()=>Promise<T>,prepare?:()=>void):Promise<{accepted:true;value:T}|{accepted:false}>{prepare?.();return {accepted:true,value:await operation()};}};}
    (async()=>{
        const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();
        const first=await state.run(async()=>3,()=>{calls++;});
        const second=await state.run(async()=>{calls++;});
        const third=await state.run(async()=>4,undefined);
        if(!first.accepted||first.value!==3||!second.accepted||second.value!==undefined||!third.accepted||third.value!==4||calls!==2)throw new Error('async optional callback');
        let rejected=false;
        try{await state.run(async()=>{calls++;},()=>{throw new Error('prepare');});}catch{rejected=true;}
        if(!rejected||calls!==2)throw new Error('prepare failure');
        globalThis.close();
    })();
`,
    true,
);

check(
    "stored-defaults-and-local-recursion",
    `
    let defaults=0, total=0;
    function fallback():string{defaults++;return 'default';}
    const readers:Array<(value?:string)=>string>=[(value=fallback())=>value];
    if(readers[0]!()!=='default'||readers[0]!(undefined)!=='default'||readers[0]!('')!==''||defaults!==2)throw new Error('lazy stored default');
    const frames:Array<()=>void>=[()=>{
        let burst=0;
        const drain=(value:number):void=>{if(value<=0)return;burst+=value;drain(value-1);};
        drain(3);total+=burst;
    }];
    frames[0]!();frames[0]!();
    if(total!==12)throw new Error('independent recursive frames');
    const settings=[{enabled:undefined},{enabled:false}];
    const visited:boolean[]=[];
    for(const setting of settings)visited.push(setting.enabled??true);
    if(visited.join()!=='true,false')throw new Error('mixed field fallback');
`,
);

test("imported mixed catalog retains optional undefined fields", (t) => {
    const directory = resolve("artifacts/owned-value-storage/imported-catalog");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "catalog.mjs"),
        `export const entries=[{name:'one',options:{enabled:true}},{name:'two'}];`,
    );
    const result = compileSource(
        `import {entries} from './catalog.mjs';
        const names=entries.map(entry=>entry.name);
        if(names.join()!=='one,two')throw new Error('catalog map');
        if(JSON.stringify(entries)!=='[{"name":"one","options":{"enabled":true}},{"name":"two"}]')throw new Error('catalog JSON presence');
        function select(name:string){return entries.find(entry=>entry.name===name);}
        const first=select('one'), second=select('two');
        if(first?.options?.enabled!==true||second?.options!==undefined||select('absent')!==undefined)throw new Error('catalog find');
        first!.options!.enabled=false;
        if(select('one')?.options?.enabled!==false)throw new Error('catalog live alias');
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "owned-value-storage/imported-catalog",
        result.cpp,
    );
});

test("void annotation does not invent an undefined payload", () => {
    assert.throws(
        () =>
            compileSource(
                `const produce:()=>void=()=>3;const items:Array<{value?:void}>=[{value:produce()}];JSON.stringify(items);`,
            ),
        /proven undefined completion/,
    );
});

check(
    "generic-and-tagged-undefined-presence",
    `
    interface State{read<T>(operation:()=>T):T;ready():boolean;}
    function make():State{return{read<T>(operation:()=>T):T{return operation();},ready:()=>true};}
    const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();
    const first=state.read(()=>({} as {value?:undefined}));
    const second=state.read(()=>({value:undefined} as {value?:undefined}));
    if(Object.hasOwn(first,'value')||!Object.hasOwn(second,'value'))throw new Error('generic result presence');
    type Item={ok:true;value?:undefined}|{ok:false};
    const items:Item[]=[{ok:true},{ok:true,value:undefined},{ok:false}];
    if(Object.hasOwn(items[0]!,'value')||!Object.hasOwn(items[1]!,'value')||Object.hasOwn(items[2]!,'value'))throw new Error('tagged presence');
    if(JSON.stringify(items)!=='[{"ok":true},{"ok":true},{"ok":false}]')throw new Error('tagged JSON');
`,
);

check(
    "recursive-dynamic-callback-domains",
    `
    class Packet {constructor(readonly values:readonly number[]) {}}
    class Counter {constructor(public count:number) {}}
    class Marker {}
    function total(root:unknown):number {
        let sum=0;
        const list=(values:readonly unknown[]):void=>{for(const value of values)visit(value);};
        const visit=(value:unknown):void=>{
            if(value instanceof Packet){list(value.values);return;}
            if(value instanceof Counter){sum+=value.count;return;}
            if(Array.isArray(value)){list(value);return;}
            if(value!==null&&typeof value==='object'){
                const object=value as Record<string,unknown>;
                for(const key of Object.keys(object))visit(object[key]);
            }else if(typeof value==='number')sum+=value;
        };
        visit(root);
        return sum;
    }
    const document=JSON.parse('{"a":[1,{"b":2}],"empty":null,"text":"ignored"}');
    if(total(document)!==3)throw new Error('recursive document');
    const counters:Counter[]=[new Counter(4)];
    const packets:Packet[]=[new Packet([3,4])];
    if(total(packets[0]!)!==7||total(counters[0]!)!==4)throw new Error('native class view');
    counters[0]!.count=9;
    if(total(counters[0]!)!==9)throw new Error('retained native identity');
    const plain:unknown={count:9};
    if(total(plain)!==9)throw new Error('ordinary object traversal');
    const markers:Marker[]=[new Marker()];
    if(total(markers[0]!)!==0)throw new Error('empty native class view');
`,
);

check(
    "optional-shared-record-json-omission",
    `
    interface Item{child?:{value:number};}
    const records:Item[]=[{},{child:{value:3}}];
    if(JSON.stringify(records)!=='[{}, {"child":{"value":3}}]'.replace(' ',''))throw new Error('shared optional JSON');
    records[0]!.child=records[1]!.child;
    if(JSON.stringify(records[0]!)!=='{"child":{"value":3}}')throw new Error('shared assigned JSON');
`,
);

check(
    "synthetic-accessor-json-key-snapshots",
    `
    interface Row { first: number; later?: { value: number }; added?: { value: number }; }
    const child = { value: 2 };
    const rows: Row[] = [{ first: 0, later: child }, { first: 9, added: undefined }];
    const row = rows[0]!;
    let reads = 0;
    Object.defineProperty(row, 'first', {
        get() { reads++; delete row.later; row.added = child; return 1; },
        enumerable: true,
        configurable: true,
    });
    if (JSON.stringify(row) !== '{"first":1}' || reads !== 1)
        throw new Error('own-key snapshot or getter read count');
    if (JSON.stringify(row) !== '{"first":1,"added":{"value":2}}' || reads !== 2)
        throw new Error('next serialization observes installed key');
    if (Object.hasOwn(row, 'later') || !Object.hasOwn(row, 'added'))
        throw new Error('explicit own presence');
    interface ProxyRow { leading: number; following?: { value: number }; inserted?: { value: number }; }
    const target: ProxyRow = { leading: 0, following: child };
    const observed = new Proxy(target, {});
    let proxyReads = 0;
    Object.defineProperty(observed, 'leading', {
        get() { proxyReads++; delete observed.following; observed.inserted = child; return 3; },
        enumerable: true,
        configurable: true,
    });
    if (JSON.stringify(observed) !== '{"leading":3}' || proxyReads !== 1)
        throw new Error('synthetic own-key snapshot or getter read count');
    if (JSON.stringify(observed) !== '{"leading":3,"inserted":{"value":2}}' || proxyReads !== 2)
        throw new Error('synthetic next serialization observes installed key');
`,
);

test("dynamic callback domains refuse nonrepresented function payloads", () => {
    assert.throws(
        () =>
            compileSource(`
        function invoke(input:unknown):void {
            const walk=(value:unknown):void=>{if(Array.isArray(value)){for(const entry of value)walk(entry);}else if(typeof value==='function')throw new Error('callable');};
            walk(input);
        }
        const callback:unknown=()=>3;invoke(callback);
    `),
        /callback value does not match the expected data json/,
    );
});

test("dynamic class views refuse fields without stored representations", () => {
    assert.throws(
        () =>
            compileSource(`
        class Packet {constructor(readonly values:readonly unknown[]) {}}
        const packets:Packet[]=[new Packet([3])];
        function count(value:unknown,depth:number):number{if(depth>0)return count(value,depth-1);return value instanceof Packet?value.values.length:0;}
        count(packets[0]!,1);
    `),
        /Dynamic class storage requires a represented field 'values'/,
    );
});
