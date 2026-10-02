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
        runGeneratedProgram(tools, `owned-key-domains/${name}`, result.cpp);
    });
}

check(
    "fixed-field-membership",
    `
    interface Table { small:number; large:number; missing?:number; value:undefined; }
    const table:Table={small:1,large:2,value:undefined};
    const alias=table;
    function has(value:Table,key:string):boolean{return key in value;}
    function own(value:Table,key:string):boolean{return Object.hasOwn(value,key);}
    if(!has(table,'small')||has(table,'other')||has(table,'missing')||!own(table,'value'))throw new Error('initial keys');
    if(!has(table,'toString')||own(table,'toString')||!has(table,'constructor')||own(table,'constructor'))throw new Error('prototype keys');
    alias.missing=0;
    if(!has(table,'missing')||!own(table,'missing'))throw new Error('present zero');
    delete alias.missing;
    if(has(table,'missing')||own(table,'missing'))throw new Error('deleted key');
    let events='';
    function owner():Table{events+='O';return table;}
    function key():string{events+='K';table.missing=4;return 'missing';}
    if(!(key() in owner())||events!=='KO')throw new Error('in evaluation');
    events='';delete table.missing;
    if(!Object.hasOwn(owner(),key())||events!=='OK')throw new Error('own evaluation');
    events='';
    if(!('small' in owner())||events!=='O')throw new Error('required receiver');
    const constant={small:1,large:2} as const;
    function knownKey(name:string):boolean{return name in constant;}
    if(!knownKey('toString')||knownKey('absent'))throw new Error('constant prototype');
    function absent():Table|null{return null;}
    let threw=false;try{has(absent()!,'small');}catch{threw=true;}
    if(!threw)throw new Error('null receiver');
`,
);

check(
    "fixed-field-dictionary-aliases",
    `
    type Table={small:number;large:number};
    const table:Table={small:1,large:2};
    function read(value:Record<string,number>,key:string):number|undefined{return value[key];}
    if(read(table,'large')!==2||read(table,'other')!==undefined)throw new Error('read and miss');
    function fits(value:Record<string,number>,previous:string|undefined,next:string):boolean{
        const current=value[next];const prior=previous===undefined?undefined:value[previous];
        if(prior===undefined||current===undefined)return true;
        return prior<=current;
    }
    if(fits(table,'large','small')||!fits(table,'small','large')||!fits(table,'absent','large')||!fits(table,undefined,'large'))throw new Error('guarded comparison');
    const closed={small:1,large:2} as const;
    if(fits(closed,'large','small')||!fits(closed,'missing','large'))throw new Error('closed constant view');
    function raw(value:Record<string,number>,key:string){return value[key];}
    const missing=raw(closed,'missing');
    if(missing!==undefined||missing===null||String(missing)!=='undefined')throw new Error('undefined miss');
    function greater(value:Record<string,number>,key:string):boolean{return value[key]>0;}
    if(greater(table,'absent')||!greater(table,'small'))throw new Error('unchecked numeric comparison');
    const saved:Array<()=>number|undefined>=[];
    function save(value:Readonly<Record<string,number>>,key:string):void{saved.push(()=>value[key]);}
    save(table,'small');
    const inferred={small:4,large:5};save(inferred,'small');inferred.small=6;
    if(saved[1]!()!==6)throw new Error('inferred source alias');
    table.small=7;
    if(saved[0]!()!==7)throw new Error('live callback view');
    let count=0;
    function key():string{count++;table.large=9;return 'large';}
    if(read(table,key())!==9||count!==1)throw new Error('key mutation');
    type Cells={first:{value:number};second:{value:number}};
    const cells:Cells={first:{value:1},second:{value:2}};
    function lookup(value:Record<string,{value:number}>,key:string){return value[key];}
    const cell=lookup(cells,'first');
    if(cell!==cells.first||lookup(cells,'missing')!==undefined)throw new Error('identity and miss');
    cell!.value=8;
    if(cells.first.value!==8)throw new Error('nested alias');
`,
);

check(
    "weak-object-key-identity",
    `
    class Entry {value=0;increment(){this.value++;}}
    const cache=new WeakMap<object,Map<number,Entry>>();
    function get(owner:object,index:number):Entry{
        let values=cache.get(owner);
        if(!values){values=new Map();cache.set(owner,values);}
        let value=values.get(index);
        if(!value){value=new Entry();values.set(index,value);}
        return value;
    }
    const first={name:'same'};
    const alias=first;
    const second={name:'same'};
    get(first,1).increment();get(alias,1).increment();
    if(get(first,1).value!==2||get(second,1).value!==0||get(first,2).value!==0)throw new Error('identity domains');
    const saved:Array<()=>number>=[()=>get(alias,1).value];
    get(first,1).increment();
    if(saved[0]!()!==3||!cache.has(first)||!cache.has(second))throw new Error('live values');
    const replacement=new Map<number,Entry>();
    const changed=new Entry();changed.value=8;replacement.set(1,changed);
    cache.set(first,replacement);
    if(saved[0]!()!==8)throw new Error('replacement');
    if(!cache.delete(first)||cache.has(alias)||cache.delete(alias)||!cache.has(second))throw new Error('delete');
    let order='';
    function key():object{order+='K';return first;}
    function value():Map<number,Entry>{order+='V';return replacement;}
    cache.set(key(),value());
    if(order!=='KV'||get(first,1)!==changed)throw new Error('key value order');
`,
);

test("unrepresented dictionary mutations and weak keys refuse", () => {
    for (const body of [
        "return key in value;",
        "return Object.hasOwn(value,key);",
    ])
        assert.throws(
            () =>
                compileSource(`
            class Base{method(){return 1;}}class Child extends Base{value=2;}
            const values:Child[]=[new Child()];function read(value:Child,key:string){${body}}read(values[0]!,'method');
        `),
            /membership of class instances requires represented prototype descriptors/,
        );
    assert.throws(
        () =>
            compileSource(`
        type Table={small:number;large:number};const table:Table={small:1,large:2};
        function write(value:Record<string,number>,key:string){value[key]=4;}write(table,'small');
    `),
        /Writing through an open dictionary view/,
    );
    assert.throws(
        () =>
            compileSource(`
        type Table={small:number|null;large:number|null};const table:Table={small:null,large:2};
        function read(value:Record<string,number|null>,key:string){return value[key];}read(table,'small');
    `),
        /one common non-nullable field type/,
    );
    assert.throws(
        () =>
            compileSource(`
        const values=new WeakMap<object,number>([[{value:1},2]]);values.has({value:1});
    `),
        /Erased-key WeakMap construction requires an empty initializer/,
    );
    assert.throws(
        () =>
            compileSource(`
        const values=new WeakMap<object,number>();const key:number[]=[];values.set(key,1);
    `),
        /weak object key requires an owned record or represented DOM target/,
    );
});
