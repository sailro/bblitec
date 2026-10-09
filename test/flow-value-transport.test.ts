import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
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
        assert.equal(
            runGeneratedProgram(
                tools,
                `flow-value-transport/${name}`,
                result.cpp,
                {
                    timeoutMs: 10000,
                },
            ),
            "",
        );
    });
}

check(
    "generic optional field transport retains absence",
    `
    interface Style {label:string|null; count?:number;}
    function set<T extends object,K extends keyof T>(owner:T,key:K,value:string|null|undefined):void {
        if(!value) delete owner[key]; else owner[key]=value as T[K];
    }
    function apply(owner:{label?:string},style:Style):void {set(owner,'label',style.label);}
    const styles:Style[]=[{label:null},{label:'ready'},{label:''}];
    const owner:{label?:string}={label:'initial'};
    const alias=owner;
    for(const style of styles) {
        apply(owner,style);
        if(style.label) {if(alias.label!=='ready') throw new Error('stored value');}
        else if(Object.hasOwn(alias,'label')) throw new Error('deleted value');
    }
    const document:Record<string,unknown>=JSON.parse('{}');
    for(const style of styles) {document.label=style.label; document.count=style.count;}
    if(JSON.stringify(document)!=='{"label":""}') throw new Error('optional JSON fields');
`,
);

check(
    "raw record views retain optional member absence",
    `
    interface Measure {fit?:number;label:string|null;}
    function make(fit:number):Measure {return {fit:fit>=1?undefined:fit,label:fit===0?null:'ready'};}
    function erase(measure:Measure):string {
        const owner:Record<string,unknown>=JSON.parse('{}');
        owner.measure=measure;
        return JSON.stringify(owner);
    }
    if(erase(make(0))!=='{"measure":{"fit":0,"label":null}}') throw new Error('zero and null');
    if(erase(make(1))!=='{"measure":{"label":"ready"}}') throw new Error('missing optional field');
`,
);

check(
    "short circuit selections retain optional callback absence",
    `
    interface Item {x:number;}
    let calls=0;
    function run(enabled:boolean,point?:()=>Item|null):string {
        const selected=enabled && point?.();
        return selected===null?'null':selected===undefined?'undefined':selected===false?'false':String(selected.x);
    }
    const present=()=>{calls++;return {x:3};};
    const absent=()=>{calls++;return null;};
    if(run(false,present)!=='false'||calls!==0) throw new Error('short circuit');
    if(run(true)!=='undefined'||run(true,absent)!=='null'||run(true,present)!=='3'||calls!==2) throw new Error('selected absence');
    let next:(()=>Item|null)|undefined;
    next=()=>{next=undefined;return {x:7};};
    if(run(true,next)!=='7'||run(true,next)!=='undefined') throw new Error('callback replacement');
    function maybe(enabled:boolean,point?:()=>Item|undefined):boolean {
        const value=enabled && point?.(); return value===undefined;
    }
    if(!maybe(true,()=>undefined)||maybe(false,()=>({x:1}))) throw new Error('undefined completion');
`,
);

check(
    "dynamic Error views retain identity and nonenumerable properties",
    `
    const document:Record<string,unknown>=JSON.parse('{}');
    const cause=new Error('cause');
    const error=new TypeError('failed',{cause});
    document.error=error;
    document.alias=error;
    document.empty=new Error('');
    document.missing=new Error();
    document.plain={name:'TypeError',message:'failed'};
    const value=document.error as {name:string;message:string;cause:unknown};
    if(value.name!=='TypeError'||value.message!=='failed') throw new Error('error properties');
    if(document.error!==document.alias||document.error===document.plain) throw new Error('error identity');
    document.cause=cause;
    if(value.cause!==document.cause) throw new Error('cause identity');
    if(!Object.hasOwn(document.error as object,'message')||Object.hasOwn(document.error as object,'name')) throw new Error('error own properties');
    if(!('name' in (document.error as object))||!Object.hasOwn(document.empty as object,'message')||Object.hasOwn(document.missing as object,'message')) throw new Error('message presence');
    if(Object.keys(document.error as object).length!==0||JSON.stringify(document.error)!=='{}') throw new Error('error enumeration');
    if(String(document.error)!=='TypeError: failed') throw new Error('error text');
    const retain:(value:Error)=>Error=value=>value;
    const retained=retain(document.error as Error);
    let same=false;
    try {throw retained;} catch(caught) {same=caught===error;}
    if(!same) throw new Error('rethrow identity');
`,
);

check(
    "stored callbacks retain mixed null and undefined returns",
    `
    interface Item {x:number;}
    interface Owner {point?(index:number):Item|null|undefined;}
    let calls=0;
    function select(space:'inside'|'outside'|undefined,owner:Owner,index:number):string {
        const selected=space && owner.point?.(index);
        return selected===null?'null':selected===undefined?'undefined':String(selected.x);
    }
    const owner:Owner={point:index=>{calls++;return index===0?null:index===1?undefined:{x:7};}};
    if(select(undefined,owner,2)!=='undefined'||select('inside',{},0)!=='undefined'||calls!==0) throw new Error('skipped callback');
    if(select('inside',owner,0)!=='null'||select('inside',owner,1)!=='undefined'||select('outside',owner,2)!=='7'||calls!==3) throw new Error('mixed completion');
    owner.point=()=>{delete owner.point;return null;};
    if(select('inside',owner,0)!=='null'||select('inside',owner,0)!=='undefined') throw new Error('reentrant owner mutation');
    const read:(index:number)=>number|null|undefined=index=>index===0?null:index===1?undefined:0;
    const readers=[read];
    const document:Record<string,unknown>=JSON.parse('{}');
    document.null=readers[0]!(0);document.absent=readers[0]!(1);document.zero=readers[0]!(2);
    if(JSON.stringify(document)!=='{"null":null,"zero":0}') throw new Error('scalar return storage');
    let numberCalls=0;
    const numbers:Array<(index:number)=>number|null|undefined>=[index=>{numberCalls++;return index===0?null:index===1?undefined:0;}];
    const values=[numbers[0]!(0),numbers[0]!(1),numbers[0]!(2)];
    if(values[0]!==null||values[1]!==undefined||values[2]!==0||numberCalls!==3) throw new Error('scalar absence identity');
`,
);

test("unrepresented AggregateError descriptors refuse dynamic boxing", () => {
    assert.throws(
        () =>
            compileSource(`const document:Record<string,unknown>=JSON.parse('{}');
            document.error=new AggregateError([]);`),
        /AggregateError reflection requires represented property descriptors/,
    );
});

check(
    "late typed array captures preserve ordered writes and owner snapshots",
    `
    function create():()=>number {
        const update=()=>{const [a,b]=[3,4] as const;data[0]=a;data[1]=b;};
        const data=new Float32Array(2);
        const alias=data;
        return ()=>{update();return alias[0]!+alias[1]!;};
    }
    const callbacks:(()=>number)[]=[create()];
    if(callbacks[0]!()!==7) throw new Error('late capture');
    let buffer=new Float32Array(2);
    const previous=buffer;
    function replace():number {buffer=new Float32Array(2);return 9;}
    buffer[0]=replace();
    if(previous[0]!==9||buffer[0]!==0) throw new Error('assignment owner');
`,
);

test("named deferred callbacks retain captures after registration", async (t) => {
    const source = `
    import {createEngine,createSceneContext,onSceneDispose,disposeScene} from '@babylonjs/lite';
    const engine=await createEngine(document.createElement('canvas'));
    const scene=createSceneContext(engine);
    let count=0;
    function install():void {
        const owner={value:2};
        const unsubscribe=()=>{count+=owner.value;};
        const dispose=()=>{unsubscribe();};
        onSceneDispose(scene,dispose);
        owner.value=7;
    }
    install();
    if(count!==0) throw new Error('eager callback');
    disposeScene(scene);
    if(count!==7) throw new Error('retained callback');`;
    const callbacks: Array<() => void> = [];
    await runInNewContext(
        `(async () => {${
            ts.transpileModule(source.replace(/^\s*import[^;]+;/, ""), {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText
        }})()`,
        {
            document: { createElement: () => ({}) },
            createEngine: () => ({}),
            createSceneContext: () => ({}),
            onSceneDispose: (_scene: object, callback: () => void) =>
                callbacks.push(callback),
            disposeScene: () =>
                callbacks.splice(0).forEach((callback) => callback()),
        },
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    // Only the lifecycle transport is inert; generated closures and their
    // managed capture ownership execute unchanged.
    const lifecycle = `
    namespace bbl {
    Engine create_engine([[maybe_unused]] EngineOptions options) { return {}; }
    Scene create_scene_context(Engine& engine) {
        Scene scene;
        scene.engine = &engine;
        return scene;
    }
    void on_scene_dispose(Scene& scene, js::Callback<void()> callback) {
        scene.disposables.push_back(std::move(callback));
    }
    void dispose_scene(Scene& scene) {
        for (auto& callback : scene.disposables) callback();
        scene.disposables.clear();
    }
    }`;
    assert.equal(
        runGeneratedProgram(
            tools,
            "flow-value-transport/named-deferred-capture",
            result.cpp + lifecycle,
            { timeoutMs: 10000 },
        ),
        "",
    );
});
