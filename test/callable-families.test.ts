import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function nativeCheck(
    t: test.TestContext,
    name: string,
    source: string,
    realm = false,
): void {
    const directory = resolve("artifacts/callable-families", name);
    mkdirSync(directory, { recursive: true });
    if (realm) writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        (realm
            ? 'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();\n'
            : "") + source,
        { fileName: join(directory, "entry.ts") },
    );
    const native = optionalNativeFixtureTools(
        result.manifest.features.includes("data:json"),
    );
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, `callable-families/${name}`, result.cpp, {
        defines: realm ? ["BBLITE_WORKERS=1"] : [],
        timeoutMs: 10000,
        expectedOutput: "",
    });
}

test("call and bind refuse unrepresented dynamic receivers and partial binding", () => {
    for (const method of ["call", "bind"])
        assert.throws(
            () =>
                compileSource(`
                function read(this:{value:number}):number{return this.value;}
                read.${method}({value:7});
            `),
            /dynamic this parameter/,
        );
    assert.throws(
        () =>
            compileSource(`
            const owner={value:1,read(){return this.value;}};
            owner.read.call({value:7});
        `),
        /without dynamic this/,
    );
    assert.throws(
        () =>
            compileSource(`
            const add=(a:number,b:number):number=>a+b;
            add.bind(undefined,1);
        `),
        /arguments/,
    );
});

test("stored callable selection, receiver effects and arguments run in source order", (t) =>
    nativeCheck(
        t,
        "call-order",
        `
    let trace="";
    const owners:{run:(value:number)=>number}[]=[{run:value=>value+10}];
    function key():number{trace+="K";return 0;}
    function receiver():undefined{trace+="R";owners[0]!.run=value=>-value;return undefined;}
    function argument():number{trace+="A";return 3;}
    const value=owners[key()]!.run.call(receiver(),argument());
    if(value!==13||trace!=="KRA"||owners[0]!.run(3)!==-3)throw new Error("selected callable");
    let scalar=1;
    const pairs:((a:number,b:number)=>number)[]=[(a,b)=>a*10+b];
    if(pairs[0]!.call(undefined,scalar,++scalar)!==12)throw new Error("call argument order");
    scalar=3;
    if(pairs[0]!(scalar,++scalar)!==34)throw new Error("indexed argument order");
    const record={run:pairs[0]!};scalar=5;
    if(record.run(scalar,++scalar)!==56)throw new Error("record argument order");
    const old=pairs[0]!;
    function replace():number{pairs[0]=(a,b)=>-1;return 8;}
    if(pairs[0]!(7,replace())!==78||pairs[0]===old)throw new Error("indexed target snapshot");
    function defaults(a:number,b=2):number{return a+b;}
    const optional:(a:number,b?:number)=>number=defaults;
    if(optional.call(undefined,3)!==5)throw new Error("call defaults");
    const sum=(...values:number[]):number=>values.reduce((a,b)=>a+b,0);
    if(sum.call(undefined,1,2,3)!==6)throw new Error("call rest");
    let disposed=0;
    const host={dispose():void{disposed++;}};
    const dispose=host.dispose.bind(host);
    const twice=dispose.bind(undefined);
    dispose();twice();
    if(disposed!==2||twice===dispose)throw new Error("bound record method");
    let threw=false;
    function rejected():undefined{trace+="E";throw new Error("receiver failure");}
    try{optional.call(rejected(),argument());}catch(error){if(error.message!=="receiver failure")throw error;threw=true;}
    if(!threw||trace!=="KRAE")throw new Error("receiver throw order");
`,
    ));

test("record callback transport retains declaration, factory and forwarded identities", (t) =>
    nativeCheck(
        t,
        "record-identity",
        `
    function task():number{return 3;}
    const arrow=()=>4;
    type Slot={task:()=>number,optional?:()=>number};
    const slots:Slot[]=[{task,optional:arrow}];
    function forward(slot:Slot):()=>number{return slot.task;}
    const selected=forward(slots[0]!);
    if(selected!==task||selected!==slots[0]!.task||slots[0]!.optional!==arrow||selected()!==3)throw new Error("record identity");
    const keys=new Set<()=>number>([task,selected]);
    if(keys.size!==1||!keys.has(slots[0]!.task))throw new Error("record key identity");
    function create(seed:number):Slot{let state=seed;const task=():number=>++state;return {task};}
    const first=create(1),second=create(10);
    const aliases:Slot[]=[first,second];
    if(first.task!==aliases[0]!.task||first.task===second.task||forward(first)!==first.task)throw new Error("factory identity");
    if(first.task()!==2||forward(first)()!==3||second.task()!==11)throw new Error("factory captures");
    aliases[0]!.task=arrow;
    if(first.task!==arrow||first.task()!==4||second.task()!==12)throw new Error("rebound field");
`,
    ));

test("generic queue returns preserve existing records and callback fields across branches", (t) =>
    nativeCheck(
        t,
        "queue-return",
        `
    class Queue<T>{
        readonly pending:T[]=[];current:T|null=null;
        push(item:T):T|null{if(this.current){this.pending.push(item);return null;}this.current=item;return item;}
        advance():T|null{this.current=this.pending.shift()??null;return this.current;}
        clear():void{this.current=null;this.pending.length=0;}
    }
    type Item={value:number,run:()=>number};
    const action=()=>9;const first:Item={value:1,run:action},second:Item={value:2,run:action};
    const queue=new Queue<Item>();
    const admitted=queue.push(first);
    if(admitted!==first||queue.current!==first||admitted!.run!==action)throw new Error("first record identity");
    admitted!.value=7;
    if(first.value!==7||queue.push(second)!==null||queue.current!==first)throw new Error("early return and mutation");
    const next=queue.advance();
    if(next!==second||next!.run!==action||next!.run()!==9)throw new Error("queued record identity");
    const numbers=new Queue<number>();
    if(numbers.push(4)!==4||numbers.push(6)!==null||numbers.advance()!==6||queue.current!==second)throw new Error("generic instantiations");
    queue.clear();if(queue.current!==null||queue.advance()!==null)throw new Error("cleared queue");
`,
    ));

test("stored nullable record callback arguments follow shared record storage", (t) =>
    nativeCheck(
        t,
        "nullable-record-arguments",
        `
    let visits=0;
    type Entry={value:number};
    type Rule={test:(entry:Entry|null)=>boolean,optional:(entry?:Entry)=>boolean};
    const rules:Rule[]=[{test:()=>{visits++;return true;},optional:()=>{visits++;return true;}}];
    const entries:Entry[]=[{value:7}];
    function absent():undefined{visits++;return undefined;}
    if(!rules[0]!.test(null)||!rules[0]!.test(entries[0]!)||!rules[0]!.test(entries[3]??null))throw new Error("nullable record arguments");
    if(!rules[0]!.optional()||!rules[0]!.optional(undefined)||!rules[0]!.optional(absent())||!rules[0]!.optional(entries[0]!))throw new Error("optional record arguments");
    if(!rules[0]!.optional.call(undefined,entries[0]!)||visits!==9)throw new Error("callback argument effects");
`,
    ));

test("array absence guards retain missing elements through nullable function results", (t) =>
    nativeCheck(
        t,
        "array-absence-guards",
        `
    const items:string[]=["first"];
    let reads=0,index=0;
    function next():number{reads++;return index++;}
    if(items[next()]===undefined||items[next()]!==undefined||reads!==2)throw new Error("indexed presence and effects");
    function collect(count:number):string[]|null{if(count<0)return null;const result:string[]=[];for(let i=0;i<count;i++)result.push("entry");return result;}
    let seen=0;
    for(let count=0;count<3;count++){
        const values=collect(count);
        if(!values)throw new Error("present array");
        if(values[0]!==undefined)seen++;
        if(values[1]!==undefined)seen+=10;
    }
    if(seen!==12||collect(-1)!==null)throw new Error("nullable array index guard");
`,
    ));

test("deferred recursive callbacks and async record methods retain independent activation state", (t) =>
    nativeCheck(
        t,
        "deferred-state",
        `
    let completed=0,seen=0,cancelled=0;
    type Item={value:number,onShow?:()=>void};
    function presenter(label:number){
        const pending:Item[]=[];let current:Item|null=null;let timer=0,disposed=false;
        const present=(item:Item):void=>{current=item;seen+=label*item.value;item.onShow?.();timer=setTimeout(()=>{timer=0;close();},1);};
        const close=():void=>{if(disposed||!current)return;if(timer){clearTimeout(timer);timer=0;}current=null;const next=pending.shift();if(next)present(next);else completed++;};
        return {push(item:Item){if(disposed)return;if(current){pending.push(item);return;}present(item);},close,dispose(){if(disposed)return;disposed=true;if(timer)clearTimeout(timer);pending.length=0;current=null;}};
    }
    const first=presenter(1),second=presenter(10),retired=presenter(100);
    first.push({value:1,onShow:()=>{}});first.push({value:2});
    second.push({value:3});second.push({value:4});
    retired.push({value:5});retired.push({value:6,onShow:()=>{cancelled++;}});retired.dispose();retired.dispose();
    function create(seed:number){let count=seed;return {async add(amount:number):Promise<number>{if(amount<0)throw new Error("negative");await Promise.resolve();count+=amount;return count;},read:()=>count};}
    const left=create(1),right=create(10);
    function recursive(){let total=0;const visit=async(n:number):Promise<number>=>{if(n===0)return total;await Promise.resolve();total+=n;return await visit(n-1);};return visit;}
    const visitA=recursive(),visitB=recursive();
    void(async()=>{
        const a=left.add(2),b=right.add(3),c=left.add(4);
        if(await a!==3||await b!==13||await c!==7||left.read()!==7||right.read()!==13)throw new Error("independent activations");
        if(await left.add(-1).catch(()=>-1)!==-1||left.read()!==7)throw new Error("rejected activation");
        if(await visitA(3)!==6||await visitB(2)!==3)throw new Error("recursive activation");
        await new Promise<void>(resolve=>setTimeout(resolve,20));
        if(completed!==2||seen!==573||cancelled!==0)throw new Error("deferred cycles and cancellation");
        first.dispose();second.dispose();globalThis.close();
    })();
`,
        true,
    ));
