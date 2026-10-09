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
    source = '"use strict";\n' + source;
    test(name, async (t) => {
        await runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            { setTimeout: () => 0 },
        );
        const result = compileSource(source + "\nglobalThis.close();");
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `record-proxies/${name}`, result.cpp, {
            defines: ["BBLITE_WORKERS=1"],
            expectedOutput: "",
            timeoutMs: 10000,
        });
    });
}

check(
    "getter-receivers-and-live-targets",
    `
setTimeout(()=>{},0);
interface Item { value: number; total: number }
function create(offset: number): Item {
  return { value: 2, get total() { return this.value + offset; } };
}
const target = create(3);
const other = create(9);
const view = new Proxy(target, {
  get(owner, key, receiver) {
    return key === "value" ? owner.value + 10 : Reflect.get(owner, key, receiver);
  }
});
if (view === target || view.value !== 12 || view.total !== 15 || target.total !== 5 || other.total !== 11)
  throw new Error("receiver or identity");
target.value = 5;
if (view.total !== 18) throw new Error("live target");
view.value = 7;
if (target.value !== 7 || view.total !== 20) throw new Error("forwarded write");
const owners = new Map<Item, number>(); owners.set(target, 1); owners.set(view, 2);
if (owners.size !== 2 || owners.get(view) !== 2) throw new Error("map identity");
`,
);

test("nonliteral handlers refuse", () => {
    assert.throws(
        () => compileSource(`setTimeout(()=>{},0); new Proxy({},{});`),
        /finite plain record target|declared finite target layout/,
    );
    assert.throws(
        () =>
            compileSource(
                `setTimeout(()=>{},0); const target={value:1}; const handler={}; new Proxy(target,handler);`,
            ),
        /fresh literal handler/,
    );
});

test("dynamic receiver methods and unrepresented traps refuse", () => {
    assert.throws(
        () =>
            compileSource(
                `setTimeout(()=>{},0);new Proxy({value:1},{get(target){return this===target?1:2;}});`,
            ),
        /traps require a receiver-independent authored function/,
    );
    assert.throws(
        () =>
            compileSource(
                `setTimeout(()=>{},0); interface Item{value:number;read():number} const target:Item={value:1,read(){return this.value;}}; const view=new Proxy(target,{}); view.read();`,
            ),
        /receiver-independent stored function/,
    );
    assert.throws(
        () =>
            compileSource(
                `setTimeout(()=>{},0); new Proxy({value:1},{ownKeys(){return ["value"];}});`,
            ),
        /no finite native contract/,
    );
});

check(
    "readonly-views-forward-optional-keys-and-reject-mutations",
    `
setTimeout(()=>{},0);
interface Item { x:number; y:number; angle:number; label?:string; scale?:number }
const target:Item={x:1,y:2,angle:3};
let shift=10;
let writes=0;
const view = new Proxy(target, {
 get(owner,key) {
   if(key === "x") return owner.x + shift;
   if(key === "y") return owner.y + shift;
   if(key === "angle") return owner.angle + shift;
   return owner[key as keyof Item];
 },
 set() {writes++;return false;},
 deleteProperty() {writes++;return false;},
 defineProperty() {writes++;return false;}
});
if(view.x!==11||view.y!==12||view.angle!==13||view.label!==undefined||Object.hasOwn(view,"label")) throw new Error("initial view");
target.label="a";target.scale=0;shift=20;
if(view.label!=="a"||view.x!==21||!Object.hasOwn(view,"scale")||Object.keys(view).length!==5) throw new Error("optional presence");
const views=new Map<number,Readonly<Item>>();views.set(1,view);
const cached=views.get(1)!;
if(cached!==view||cached.x!==21||cached.label!=="a")throw new Error("readonly cache identity");
let denied=0;
try{view.x=99;}catch{denied++;}
try{delete view.label;}catch{denied++;}
try{Object.defineProperty(view,"scale",{value:4});}catch{denied++;}
if(Reflect.set(view,"x",9)||Reflect.deleteProperty(view,"label")||Reflect.defineProperty(view,"scale",{value:7})) throw new Error("reflect rejection");
if(denied!==3||writes!==6||target.x!==1||target.label!=="a"||target.scale!==0) throw new Error("denied mutation effects");
delete target.label;
if(view.label!==undefined||Object.hasOwn(view,"label")||Object.keys(view).length!==4) throw new Error("deleted target key");
`,
);

check(
    "generic-weak-cache-and-callable-identity",
    `
setTimeout(()=>{},0);
interface Base { run:(value:number)=>number }
function views<W extends Base>(increment:number):(target:W)=>W {
 const cache=new WeakMap<W,W>();
 return target=>{
   const cached=cache.get(target);if(cached)return cached;
   const run=(value:number)=>target.run(value)+increment;
   const view=new Proxy(target,{get:(owner,key,receiver)=>key==="run"?run:Reflect.get(owner,key,receiver)});
   cache.set(target,view);return view;
 };
}
interface Item extends Base { value:number; other:()=>number }
let current=2;
const target:Item={value:3,run:value=>value*2,other:()=>current};
const viewOf=views<Item>(5);
const view=viewOf(target);
if(view===target||viewOf(target)!==view||view.run(4)!==13||view.other!==target.other||view.other()!==2)throw new Error("cache and callback identity");
current=7;target.value=9;
if(view.value!==9||view.other()!==7)throw new Error("live callback captures");
`,
);

check(
    "presence-is-independent-of-get-trap-values",
    `
setTimeout(()=>{},0);
type Item = { label?:string };
const target:Item={label:"held"};
let reads=0;
const view=new Proxy(target,{get(){reads++;return undefined;}});
if(!Object.hasOwn(view,"label")||Object.keys(view).length!==1||reads!==0)throw new Error("key presence invoked getter");
const values=Object.values<string|undefined>(view);
if(values.length!==1||values[0]!==undefined||reads!==1)throw new Error("present key optional result");
const entries=Object.entries<string|undefined>(view);
if(entries.length!==1||entries[0][0]!=="label"||entries[0][1]!==undefined||reads!==2)throw new Error("entry optional result");
const nullableTarget:{label?:string|null}={label:null};
const nullableView=new Proxy(nullableTarget,{});
if(!Object.hasOwn(nullableView,"label")||nullableView.label!==null)throw new Error("owned null");
delete nullableTarget.label;
if(Object.hasOwn(nullableView,"label"))throw new Error("absent dynamic value");
`,
);

test("descriptor-inspecting traps refuse", () => {
    for (const body of [
        "defineProperty(){return arguments.length===3;}",
        "defineProperty(...args:unknown[]){return args.length===3;}",
        "defineProperty(target,key,descriptor){return descriptor.value===2;}",
    ])
        assert.throws(
            () =>
                compileSource(
                    `setTimeout(()=>{},0); new Proxy({value:1},{set(){return false;},${body}});`,
                ),
            /cannot inspect an unrepresented descriptor/,
        );
});

test("nullable own keys are represented and absent definitions retain their runtime boundary", (t) => {
    const result = compileSource(`
setTimeout(()=>{},0);
try {
    interface Item { label?:{n:number}|null; other?:string }
    const target:Item={label:null};
    const view=new Proxy(target,{});
    if(!Object.hasOwn(view,"label")||view.label!==null)throw new Error("own null presence");
    delete target.label;
    if(Object.hasOwn(view,"label"))throw new Error("deleted key presence");
    let refused=0;
    try{Object.defineProperty(view,"other",{value:"new"});}catch(error){if(String(error).includes("descriptor attributes"))refused++;}
    if(refused!==1||target.other!==undefined)throw new Error("explicit representation boundary");
} finally {
    globalThis.close();
}
`);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "record-proxies/explicit-runtime-boundaries",
        result.cpp,
        { defines: ["BBLITE_WORKERS=1"], expectedOutput: "", timeoutMs: 10000 },
    );
});
