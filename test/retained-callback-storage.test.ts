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
            `retained-callback-storage/${name}`,
            result.cpp,
            {
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
}

check(
    "dynamic raw callback tables preserve flat absence and dispatch",
    `
    function dispatch(key:string,value:number):number {
        const offset=3;
        const callbacks:Record<string,(input:number)=>number>={
            first:input=>input+offset,
            second:input=>input*2,
        };
        if(callbacks[key])return callbacks[key]!(value);
        return -1;
    }
    const roots:Array<typeof dispatch>=[dispatch];
    if(roots[0]!('first',4)!==7 || roots[0]!('second',4)!==8 || roots[0]!('missing',4)!==-1)
        throw new Error('dynamic callable table');
`,
);

check(
    "map callback reads snapshot before ordered argument effects",
    `
    let order=0;
    let state=2;
    const originals:Array<(value:number)=>number>=[value=>value+state];
    const callback=originals[0]!;
    const callbacks=new Map<string,(value:number)=>number>();
    callbacks.set('present',callback);
    function owner():Map<string,(value:number)=>number>{order=order*10+1;return callbacks;}
    function key():string{order=order*10+2;return 'present';}
    function argument():number{order=order*10+3;callbacks.clear();state=7;return 3;}
    const result=owner().get(key())?.(argument());
    if(result!==10 || order!==123 || callbacks.size!==0)throw new Error('ordered callback snapshot');
    const absent=callbacks.get('missing');
    if(absent!==undefined || absent?.(argument())!==undefined || order!==123)
        throw new Error('missing callback suppresses arguments');
    callbacks.set('present',callback);
    const retained=callbacks.get('present');
    callbacks.delete('present');
    if(retained!==callback || !retained || retained(4)!==11)
        throw new Error('retained callback identity');
`,
);

check(
    "weak map callbacks retain captures after owner removal",
    `
    interface Key {id:number;}
    const key:Key={id:1};
    const missing:Key={id:2};
    const state={value:4};
    function retain():()=>number {
        const callbacks=new WeakMap<Key,()=>number>();
        const originals:Array<()=>number>=[()=>state.value];
        const callback=originals[0]!;
        callbacks.set(key,callback);
        const saved=callbacks.get(key);
        if(callbacks.get(missing)!==undefined || !saved || saved!==callback)
            throw new Error('weak callback presence');
        callbacks.delete(key);
        return saved;
    }
    const saved=retain();state.value=9;
    if(saved()!==9)throw new Error('retained callback capture');
`,
);

check(
    "shared map lookup lowering preserves nullable scalars and record identity",
    `
    const numbers=new Map<string,number|null>();
    numbers.set('zero',0);numbers.set('null',null);
    if(numbers.get('zero')!==0 || numbers.get('null')!==null || numbers.get('missing')!==undefined)
        throw new Error('scalar lookup presence');
    interface Item {value:number;}
    const item:Item={value:2};
    const records=new Map<string,Item>();records.set('present',item);
    const saved=records.get('present');records.clear();item.value=7;
    if(!saved || saved!==item || saved.value!==7 || records.get('missing')!==undefined)
        throw new Error('record lookup owner');
`,
);

check(
    "wrapped map arrays retain identity through clearing and alias mutation",
    `
    const original:number[]=[1,2];
    const alias=original;
    const entries=new Map<string,number[]>();
    entries.set('present',original);
    function retain(value:number[]|undefined):number[] {
        entries.clear();
        if(!value)throw new Error('array lookup lost before call');
        value.push(3);
        return value;
    }
    const saved=retain(entries.get('present'));
    if(entries.size!==0 || saved!==original || saved!==alias || saved.length!==3)
        throw new Error('array lookup ownership');
    alias[0]=7;
    if(saved[0]!==7)throw new Error('caller mutation');
    saved[1]=9;
    if(original[1]!==9)throw new Error('retained mutation');
    if(entries.get('present')!==undefined)throw new Error('cleared lookup');
`,
);

check(
    "optional map array indexing snapshots the selected payload before effects",
    `
    const original:number[]=[4];
    const entries=new Map<string,number[]>();entries.set('present',original);
    let order=0;
    function owner():Map<string,number[]>{order=order*10+1;return entries;}
    function key():string{order=order*10+2;return 'present';}
    function index():number{order=order*10+3;entries.clear();entries.set('present',[99]);original[0]=7;return 0;}
    const found=owner().get(key())?.[index()];
    if(found!==7 || order!==123 || entries.get('present')?.[0]!==99)
        throw new Error('selected array before index');
    entries.clear();order=0;
    if(owner().get(key())?.[index()]!==undefined || order!==12)
        throw new Error('absent array suppresses index');
    entries.set('present',[]);order=0;
    if(owner().get(key())?.[index()]!==undefined || order!==123)
        throw new Error('present empty array evaluates index');
`,
);

check(
    "optional weak map array indexing retains a removed payload",
    `
    interface Key {id:number;}
    const present:Key={id:1},missing:Key={id:2};
    const original:number[]=[4];
    const entries=new WeakMap<Key,number[]>();entries.set(present,original);
    let keys=0,indices=0;
    function key():Key{keys++;return present;}
    function index():number{indices++;entries.delete(present);original[0]=8;return 0;}
    if(entries.get(key())?.[index()]!==8 || keys!==1 || indices!==1)
        throw new Error('weak selected array');
    if(entries.get(missing)?.[index()]!==undefined || indices!==1)
        throw new Error('weak absence suppresses index');
`,
);

check(
    "optional dictionary array indexing preserves unchecked absence and order",
    `
    const original:number[]=[4];
    const entries:Record<string,number[]>={present:original};
    let order=0,selectedKey='present';
    function owner():Record<string,number[]>{order=order*10+1;return entries;}
    function key():string{order=order*10+2;return selectedKey;}
    function index():number{order=order*10+3;entries.present=[99];original[0]=9;return 0;}
    if(owner()[key()]?.[index()]!==9 || order!==123 || entries.present?.[0]!==99)
        throw new Error('dictionary selected array');
    selectedKey='missing';order=0;
    if(owner()[key()]?.[index()]!==undefined || order!==12)
        throw new Error('dictionary absence suppresses index');
`,
);

check(
    "narrowed map union payloads reach scalar sinks and retained callbacks",
    `
    const entries=new Map<string,string|number>();entries.set('text','before');entries.set('number',7);
    const numbers:number[]=[],texts:string[]=[];
    numbers.push(entries.get('number') as number);
    texts.push(entries.get('text') as string);
    function retain(key:string):()=>string {
        const value=entries.get(key);
        if(typeof value==='number') {numbers.push(value);return ()=>String(value);}
        if(typeof value==='string') {texts.push(value);return ()=>value;}
        return ()=>'absent';
    }
    const text=retain('text'),number=retain('number'),absent=retain('missing');
    entries.clear();
    if(text()!=='before' || number()!=='7' || absent()!=='absent' || texts.length!==2 || numbers.length!==2 || texts[0]!=='before' || numbers[0]!==7 || texts[1]!=='before' || numbers[1]!==7)
        throw new Error('narrowed owned union payload');
`,
);

check(
    "mapper writes remain live in returned records",
    `
    function update<T extends {value?:number}>(values:readonly T[],next:number):{items:(T & {value:number})[];next:number} {
        const items=values.map(value=>{const assigned=value.value??next;next=Math.max(next,assigned+1);return {...value,value:assigned};});
        return {items,next};
    }
    const input:Array<{value?:number;name:string}>=[{name:'a'},{value:9,name:'b'},{name:'c'}];
    const result=update(input,4);
    if(result.next!==11 || result.items[0]!.value!==4 || result.items[2]!.value!==10)throw new Error('live captured number');
`,
);

check(
    "retained removal uses the original method record identity",
    `
    interface Item { visit(value?:number):boolean; }
    interface Registry { add(item:Item):()=>void; visit():void; readonly size:number; }
    function registry():Registry {const items:Item[]=[];return {
        add(item){items.push(item);let active=true;return ()=>{if(!active)return;active=false;const index=items.indexOf(item);if(index>=0)items.splice(index,1);};},
        visit(){for(const item of items)item.visit();},get size(){return items.length;}
    };}
    const list=registry();let calls=0;
    const item:Item={visit(value){calls+=value??1;return true;}};
    const remove=list.add(item);
    list.visit();remove();remove();list.visit();
    const removeAgain=list.add(item);list.visit();removeAgain();
    if(list.size!==0 || calls!==2)throw new Error('retained item identity');
`,
);

check(
    "record storage demands preserve identity without capturing the parameter",
    `
    interface Item { value:number; visit():number; }
    const items:Item[]=[];
    function add(item:Item):void {items.push(item);}
    const item:Item={value:1,visit(){return 7;}};
    add(item);add(item);
    items[0]!.value=9;
    if(items[0]!==item || items[1]!==item || item.value!==9 || items[1]!.visit()!==7)throw new Error('stored record owner');
`,
);

check(
    "nullable map callbacks snapshot before argument side effects",
    `
    interface Deps { readonly values:Readonly<Record<string,(value:number)=>readonly number[]>>; }
    function factory(deps:Deps):(key:string,argument:()=>number)=>number {
        return (key,argument)=>{const value=deps.values[key]?.(argument());return value?value[0]!: -1;};
    }
    const roots:Array<typeof factory>=[factory];
    const callbacks:Record<string,(value:number)=>readonly number[]>={present:value=>[value+2]};
    const read=roots[0]!({values:callbacks});
    let argumentsCalled=0;
    function replace():number {argumentsCalled++;callbacks.present=value=>[value+10];return 3;}
    if(read('present',replace)!==5 || read('present',replace)!==13 || read('absent',replace)!==-1 || argumentsCalled!==2)throw new Error('optional callback lookup');
`,
);

check(
    "shared helpers own writable fresh record fields",
    `
    interface Flags { left:boolean; right:boolean; }
    function fill(bits:number,out:Flags):Flags{const value=Math.round(bits);out.left=(value&1)!==0;out.right=(value&2)!==0;return out;}
    function decode(bits:number):Flags{return fill(bits,{left:false,right:false});}
    const roots:Array<typeof decode>=[decode];
    const a=roots[0]!(1),b=roots[0]!(2);
    if(!a.left || a.right || b.left || !b.right)throw new Error('mutable literal storage');
`,
);

check(
    "ordered output arguments retain the original record",
    `
    interface Output { start:number; end:number; }
    const scratch:Output={start:0,end:0};
    function update(out:Output,value:number,read:()=>number):Output {out.start=value;out.end=read();return out;}
    function run(value:number):Output {return update(scratch,value,()=>scratch.start+1);}
    const roots:Array<typeof run>=[run];
    const first=roots[0]!(4),second=roots[0]!(8);
    if(first!==scratch || second!==first || scratch.start!==8 || first.end!==9)throw new Error('ordered output owner');
`,
);

check(
    "specialized optional record members retain their caller dependencies",
    `
    interface Options { value?:number; flag:boolean; }
    interface Input { value?:number; extra?:number; sample:()=>number; }
    function sample():number{return 10;}
    function read(input:Input):number {
        let total=input.sample();
        for(let i=0;i<2;i++)total+=i;
        return total+(input.value??2)+(input.extra??3);
    }
    function forward(options:Options):number {
        return read({sample,...(options.value!==undefined?{value:options.value}:{}),...(options.flag?{extra:7}:{})});
    }
    const roots:Array<typeof forward>=[forward];
    if(roots[0]!({value:5,flag:true})!==23 || roots[0]!({flag:false})!==16)throw new Error('optional member capture');
`,
);

check(
    "prepared boolean members retain their snapshot across shared helpers",
    `
    interface Source { enabled?:boolean; }
    interface Result { enabled:boolean; }
    function inspect(result:Result,read:()=>number):number {return result.enabled?read():0;}
    function sample():number{return 7;}
    function create(source:Source):()=>number {
        const result={enabled:source.enabled===true};
        source.enabled=false;
        return ()=>inspect(result,sample);
    }
    const roots:Array<typeof create>=[create];
    const yes=roots[0]!({enabled:true}),no=roots[0]!({});
    if(yes()!==7 || yes()!==7 || no()!==0)throw new Error('prepared boolean snapshot');
`,
);

check(
    "native reference arguments reuse effectful record fields once",
    `
    interface Row { value:number; enabled:number; }
    function append(out:number[],row:Row):void {out.push(row.value,row.enabled);}
    function enabled(source:{active?:boolean}):number {return source.active===true?1:0;}
    function collect(source:{active?:boolean},read:()=>boolean):number[] {
        const out:number[]=[];
        append(out,{value:read()?3:4,enabled:enabled(source)});
        return out;
    }
    const roots:Array<typeof collect>=[collect];let calls=0;
    const values=roots[0]!({active:true},()=>{calls++;return true;});
    if(calls!==1 || values.length!==2 || values[0]!==3 || values[1]!==1)throw new Error('argument evaluated once');
`,
);
