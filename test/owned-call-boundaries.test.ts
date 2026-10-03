import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(
    name: string,
    source: string,
    realm = false,
    storage = false,
): void {
    test(name, async (t) => {
        const values = new Map<string, string>();
        const localStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, value);
            },
            removeItem: (key: string) => {
                values.delete(key);
            },
        };
        await runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            { setTimeout, queueMicrotask, close: () => {}, localStorage },
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        const cpp = storage
            ? result.cpp +
              `
namespace bbl::pal {
 std::optional<std::string> read_local_storage(const std::string&) { return std::nullopt; }
 void write_local_storage(const std::string&,const std::string&) {}
 void remove_local_storage(const std::string&) {}
}
`
            : result.cpp;
        runGeneratedProgram(tools, `owned-call-boundaries/${name}`, cpp, {
            defines: realm ? ["BBLITE_WORKERS=1"] : [],
            timeoutMs: 10000,
            expectedOutput: "",
        });
    });
}

check(
    "optional-promise-adoption-and-required-formals",
    `
setTimeout(()=>{},0);
interface Device{active:boolean;value:number}
interface Profile{devices:Device[]}
interface Service{read?:()=>Promise<Profile>}
const profiles:Profile[]=[];profiles.push({devices:[{active:true,value:7}]});
const shared=profiles[0]!;
let effects=0;
const services:Service[]=[{}, {read:async()=>{effects++;await Promise.resolve();return shared;}}, {read:async()=>{effects++;throw new Error('expected');}}];
function active(profile:Profile):Device|undefined{return profile.devices.find(device=>device.active)??profile.devices[0];}
async function read(service:Service|undefined):Promise<Profile|undefined>{return service?.read?.();}
async function recommend(service:Service|undefined):Promise<number|undefined>{const profile=await read(service);return profile?active(profile)?.value:undefined;}
async function main():Promise<void>{
 if(await recommend(services[0])!==undefined||await read(undefined)!==undefined||effects!==0)throw new Error('absent callback');
 if(await recommend(services[1])!==7||effects!==1)throw new Error('required formal');
 const result=await read(services[1]);if(!result||result!==shared)throw new Error('settled identity');
 result.devices[0]!.value=11;if(shared.devices[0]!.value!==11)throw new Error('settled alias');
 const direct=await services[1]!.read?.();if(direct!==shared)throw new Error('direct await');
 const resolved=await Promise.resolve(services[1]!.read?.());if(resolved!==shared)throw new Error('resolve adoption');
 const all=await Promise.all([services[0]!.read?.(),services[1]!.read?.()]);if(all[0]!==undefined||all[1]!==shared)throw new Error('all adoption');
 const reaction=await Promise.resolve().then(()=>services[1]!.read?.());if(reaction!==shared)throw new Error('reaction adoption');
 let rejected=false;try{await read(services[2]);}catch{rejected=true;}if(!rejected||effects!==7)throw new Error('rejected optional promise');
 globalThis.close();
}main().catch(error=>{setTimeout(()=>{throw error;},0);});`,
    true,
);

check(
    "optional-promises-preserve-scalar-void-and-order",
    `
setTimeout(()=>{},0);
interface Actions{number?:()=>Promise<number>;void?:()=>Promise<void>}
let effects=0;
const original=Promise.resolve(0);
const actions:Actions[]=[{}, {number:()=>original,void:async()=>{effects++;await Promise.resolve();effects++;}}];
async function number(action:Actions):Promise<number|undefined>{return action.number?.();}
async function nothing(action:Actions):Promise<void>{return action.void?.();}
async function main():Promise<void>{
 const same=Promise.resolve(actions[1]!.number?.());if(same!==original)throw new Error('promise identity');
 const order:string[]=[];
 original.then(()=>{order.push('first');});queueMicrotask(()=>{order.push('middle');});same.then(()=>{order.push('last');});
 await Promise.resolve();if(order.join(',')!=='first,middle,last')throw new Error('reaction order');
 if(await number(actions[0]!)!==undefined||await number(actions[1]!)!==0)throw new Error('scalar adoption');
 if(await nothing(actions[0]!)!==undefined||effects!==0)throw new Error('absent void');
 if(await nothing(actions[1]!)!==undefined||effects!==2)throw new Error('present void');
 const pair=await Promise.all([actions[0]!.number?.(),actions[1]!.number?.()]);if(pair[0]!==undefined||pair[1]!==0)throw new Error('scalar tuple');
 globalThis.close();
}main().catch(error=>{setTimeout(()=>{throw error;},0);});`,
    true,
);

check(
    "coalesced-callable-receivers-and-live-records",
    `
interface State{phase:'idle'|'ready';position:number;points:readonly number[];path:{name:string;points:[number,number,number][]}|null}
interface Handle{set(value:number):void}
interface Registry{register(key:string):Handle}
let sum=0;let calls=0;let ownerCalls=0;let keyCalls=0;
function create():Registry{return{register(key:string){sum+=key.length;return{set(value:number){sum+=value;}}}};}
function fallback():Registry{calls++;return create();}
function owner(value:Registry|undefined):Registry|undefined{ownerCalls++;return value;}
function key():string{keyCalls++;return 'a';}
function use(value?:Registry):Handle{return(owner(value)??fallback()).register(key());}
use().set(3);use(create()).set(4);
if(sum!==9||calls!==1||ownerCalls!==2||keyCalls!==2)throw new Error('receiver evaluation');
interface View{render(state:State):void;read():number;clear():void}
function view():View{let current:State|null=null;const render=(snapshot:State):void=>{current=snapshot;};return{render,read:()=>current?.position??-1,clear(){current=null;}};}
const views:View[]=[view()];const selected=views[0]!;
const first:State={phase:'ready',position:2,points:[1],path:null};
selected.render(first);first.position=3;if(selected.read()!==3)throw new Error('retained source alias');
selected.render({phase:'idle',position:4,points:[],path:null});first.position=8;if(selected.read()!==4)throw new Error('live replacement');
selected.clear();if(selected.read()!==-1)throw new Error('clear');
function options(signal?:Date){return{...(signal?{signal}:{}),capture:false};}
const date=new Date(0),present=options(date),missing=options();
if(present.signal!==date||!Object.hasOwn(present,'signal')||Object.hasOwn(missing,'signal'))throw new Error('narrowed record lane');
`,
);

check(
    "native-services-retain-identity-through-structural-views",
    `
interface Store{getItem(key:string):string|null;setItem(key:string,value:string):void}
interface Options{storage:Store|null}
function boundaries():Pick<Options,'storage'>{let storage:Store|null=null;try{storage=typeof localStorage==='undefined'?null:localStorage;}catch{storage=null;}return{storage};}
function create(options:Options):(area:Storage|null)=>boolean{return(area)=>area!==null&&area===options.storage;}
const callbacks:Array<(area:Storage|null)=>boolean>=[create({...boundaries()}),create({...boundaries()})];
if(!callbacks[0]!(localStorage)||!callbacks[1]!(localStorage)||callbacks[0]!(null))throw new Error('native identity');
const typed:Store=localStorage;
if(typed!==localStorage||localStorage!==typed)throw new Error('typed native alias');
function retain():{read():boolean;reset():void}{let store:Store|null=null;store=localStorage;return{read:()=>store===localStorage,reset(){store=null;}};}
const retained=retain();if(!retained.read())throw new Error('captured native binding');retained.reset();if(retained.read())throw new Error('native replacement');
const fake:Store={getItem(_key:string){return null;},setItem(_key:string,_value:string){}};
const alias=fake;if(alias!==fake)throw new Error('authored identity');
`,
    false,
    true,
);

test("mixed native and authored mutable service storage refuses incompatible ownership", () => {
    assert.throws(
        () =>
            compileSource(
                `interface Store{getItem(key:string):string|null;setItem(key:string,value:string):void}let store:Store|null=null;store=localStorage;store={getItem(key:string){return key;},setItem(_key:string,_value:string){}};if(store===localStorage)throw new Error('distinct');`,
            ),
        /expected data storage/,
    );
});
