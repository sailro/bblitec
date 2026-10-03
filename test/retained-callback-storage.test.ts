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
