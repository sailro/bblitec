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
    "selected-optional-records-retain-caller-identity",
    `
interface Bounds { low:number; high:number }
let created=0;
function fresh():Bounds { created++; return {low:0,high:0}; }
function update(low:number, out?:Bounds):Bounds {
 const result=out??fresh(); result.low=low; result.high=low+3; return result;
}
const first=update(2);
const reusable:Bounds={low:0,high:0};
const second=update(7,reusable);
if(second!==reusable||reusable.low!==7||reusable.high!==10||first.low!==2||created!==1)throw new Error('optional record alias');
second.high++;if(reusable.high!==11)throw new Error('returned record alias');
`,
);

check(
    "guarded-tuple-entries-retain-presence-and-aliases",
    `
function merge(input:readonly [number,number][]):[number,number][] {
 const merged:[number,number][]=[];
 for(const item of input){
  const last=merged[merged.length-1];
  if(last&&item[0]<=last[1])last[1]=Math.max(last[1],item[1]);
  else merged.push([item[0],item[1]]);
 }
 return merged;
}
const merged=merge([[1,3],[2,5],[8,9]]);
if(merged.length!==2||merged[0]![1]!==5||merged[1]![0]!==8)throw new Error('tuple entry merge');
const pairs:[number,number][]=[];
let reads=0;function index():number {reads++;return 0;}
const missing=pairs[index()];pairs.push([4,6]);
if(missing||reads!==1)throw new Error('missing tuple snapshot');
const retained=pairs[0];pairs.length=0;
if(!retained||retained[1]!==6)throw new Error('retained tuple snapshot');
const mixed:[number,string][]=[];
const absent=mixed[0];mixed.push([1,'before']);
if(absent)throw new Error('missing mixed tuple');
const present=mixed[0];if(present)present[1]='after';
if(mixed[0]![1]!=='after')throw new Error('mixed tuple alias');
`,
);

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
    "default-parameters-preserve-reference-record-owners",
    `
interface Item { score: number; }
interface Saved { value?: Item; }
let defaults = 0;
function fallback(): Item { defaults++; return { score: 3 }; }
const original: Item = { score: 9 };
const records: Saved[] = [{}, { value: original }];
function choose(value: Item = fallback()): Item { return value; }
const fresh = choose(records[0]!.value);
const selected = choose(records[1]!.value);
if (fresh.score !== 3 || selected !== original || defaults !== 1)
    throw new Error('returned default owner');
function increment(value: Item): void { value.score++; }
increment(fresh); selected.score++;
if (fresh.score !== 4 || original.score !== 10)
    throw new Error('returned owner mutation');
function retain(value: Item = fallback()): () => Item {
    increment(value);
    return () => value;
}
const retained = retain(records[1]!.value);
const retainedFresh = retain(records[0]!.value);
original.score = 20;
if (retained() !== original || retained().score !== 20 || retainedFresh().score !== 4)
    throw new Error('default owner capture');
function replace(value: Item = fallback()): () => Item {
    const read = () => value;
    value = { score: value.score + 1 };
    return read;
}
const replacement = replace(records[1]!.value);
if (replacement() === original || replacement().score !== 21 || original.score !== 20)
    throw new Error('default parameter rebinding');
`,
);

check(
    "default-parameters-preserve-mutable-collection-owners",
    `
interface Saved { values?: number[]; entries?: Map<string, number>; flags?: Set<string>; }
const values = [1];
const entries = new Map<string, number>([['first', 1]]);
const flags = new Set<string>(['first']);
const records: Saved[] = [{}, { values, entries, flags }];
function grow(value: number[] = []): number[] { value.push(2); return value; }
const fresh = grow(records[0]!.values);
const selected = grow(records[1]!.values);
fresh.push(3); selected[0] = 4;
if (fresh.join(',') !== '2,3' || values.join(',') !== '4,2' || selected !== values)
    throw new Error('array default owner');
function map(value: Map<string, number> = new Map<string, number>()): Map<string, number> {
    value.set('second', 2); return value;
}
function set(value: Set<string> = new Set<string>()): Set<string> {
    value.add('second'); return value;
}
const freshMap = map(records[0]!.entries), selectedMap = map(records[1]!.entries);
const freshSet = set(records[0]!.flags), selectedSet = set(records[1]!.flags);
freshMap.set('third', 3); selectedMap.set('first', 4);
freshSet.add('third'); selectedSet.delete('first');
if (freshMap.size !== 2 || entries.get('first') !== 4 || selectedMap !== entries ||
    freshSet.size !== 2 || flags.has('first') || selectedSet !== flags)
    throw new Error('map or set default owner');
const readers: Array<(value?: number[]) => () => number[]> = [
    (value = []) => () => value,
];
const retained = readers[0]!(values), retainedFresh = readers[0]!();
values.push(5); retainedFresh().push(6);
if (retained() !== values || retained().join(',') !== '4,2,5' || retainedFresh()[0] !== 6)
    throw new Error('collection default capture');
`,
);

check(
    "default-parameters-preserve-callable-and-view-owners",
    `
interface Saved { callback?: () => number; bytes?: Uint8Array; pair?: [number, number]; }
let current = 4;
const callback = () => current;
const bytes = new Uint8Array([1, 2]);
const pair: [number, number] = [1, 2];
const records: Saved[] = [{}, { callback, bytes, pair }];
function choose(value: () => number = () => 3): () => number { return value; }
const fresh = choose(records[0]!.callback), selected = choose(records[1]!.callback);
current = 7;
if (fresh() !== 3 || selected() !== 7 || selected !== callback)
    throw new Error('callable default owner');
function view(value: Uint8Array = new Uint8Array([3, 4])): Uint8Array {
    value[0]++; return value;
}
const freshView = view(records[0]!.bytes), selectedView = view(records[1]!.bytes);
freshView[1] = 5; selectedView[1] = 6;
if (freshView[0] !== 4 || freshView[1] !== 5 || bytes[0] !== 2 || bytes[1] !== 6 || selectedView !== bytes)
    throw new Error('view default owner');
function tuple(value: [number, number] = [3, 4]): [number, number] {
    value[0]++; return value;
}
const freshPair = tuple(records[0]!.pair), selectedPair = tuple(records[1]!.pair);
freshPair[1] = 5; selectedPair[1] = 6;
if (freshPair[0] !== 4 || freshPair[1] !== 5 || pair[0] !== 2 || pair[1] !== 6 || selectedPair !== pair)
    throw new Error('tuple default owner');
`,
);

check(
    "default-parameters-preserve-snapshots-mutation-and-captures",
    `
let defaults = 0;
let order = '';
function fallback(value: string): string { defaults++; order += value; return value; }
const readers: Array<(text?: string) => () => string> = [
    (text = fallback('D')) => () => text,
];
let input = 'original';
const present = readers[0]!(input);
input = 'changed';
const missing = readers[0]!();
if (present() !== 'original' || missing() !== 'D' || defaults !== 1)
    throw new Error('defaulted string snapshot or lazy fallback');
const mutations: Array<(text?: string) => () => string> = [
    (text = fallback('M')) => {
        const read = () => text;
        text += '!';
        return read;
    },
];
const mutated = mutations[0]!(input);
const mutatedDefault = mutations[0]!();
if (mutated() !== 'changed!' || mutatedDefault() !== 'M!' || input !== 'changed')
    throw new Error('defaulted parameter mutation or retained capture');
const ordered: Array<(first?: string, second?: string) => string> = [
    (first = fallback('A'), second = fallback(first + 'B')) => first + ':' + second,
];
if (ordered[0]!() !== 'A:AB' || ordered[0]!('X') !== 'X:XB')
    throw new Error('default initialization order');
if (ordered[0]!('Y', 'Z') !== 'Y:Z' || defaults !== 5 || order !== 'DMAABXB')
    throw new Error('provided arguments evaluated a fallback');
const writes: Array<(text?: string) => string> = [
    (text = fallback('W')) => { text += '?'; return text; },
];
if (writes[0]!(input) !== 'changed?' || writes[0]!() !== 'W?' || input !== 'changed')
    throw new Error('defaulted writable parameter changed its caller');
if (defaults !== 6 || order !== 'DMAABXBW') throw new Error('writable default count');
`,
);

check(
    "unchecked-dictionary-lanes-retain-nullable-snapshots",
    `
interface Snapshot { present: string | undefined; missing: string | undefined; }
function snapshot(values: Record<string, string>, observe: () => void): Snapshot {
    observe();
    return { present: values.present, missing: values.missing };
}
const values: Record<string, string> = { present: 'original' };
let calls = 0;
const saved = snapshot(values, () => { calls++; });
const records: Snapshot[] = [{ present: values.present, missing: values.missing }];
const lanes: Array<string | undefined> = [values.present, values.missing];
const readers: Array<() => void> = [() => {
    if (saved.present !== 'original' || saved.missing !== undefined)
        throw new Error('returned record lost its nullable snapshot');
    if (records[0]!.present !== 'original' || records[0]!.missing !== undefined)
        throw new Error('stored record lost its nullable snapshot');
    if (lanes[0] !== 'original' || lanes[1] !== undefined)
        throw new Error('array lanes lost their nullable snapshot');
}];
delete values.present;
values.missing = 'later';
readers[0]!();
if (calls !== 1) throw new Error('snapshot producer repeated');
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
