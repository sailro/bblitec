import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("finite imports retain namespace identity, live exports and asynchronous reactions", (t) => {
    const directory = resolve("artifacts/dynamic-module-imports");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "state.ts"),
        `export let count=1; export let label="before"; export let item={value:3}; export function bump(){count++;label="after";item={value:9};}`,
    );
    writeFileSync(
        join(directory, "lazy.ts"),
        `export const answer=7; export function twice(value:number){return value*2;}`,
    );
    writeFileSync(
        join(directory, "exports.ts"),
        `export {answer as result,twice} from "./lazy";`,
    );
    const result = compileSource(
        `
        import * as state from "./state";
        let order="";
        async function run(){
            const first=import("./lazy");
            const second=import("./lazy");
            if(first===second) throw new Error("fresh import promises");
            const ready=first.then(namespace=>{order+="M";return namespace;});
            order+="S";
            if(order!=="S") throw new Error("synchronous import reaction");
            const [a,b]=await Promise.all([ready,second]);
            if(a!==b||a.answer!==7||a.twice(3)!==6) throw new Error("namespace transport");
            const alias=await import("./exports");
            if(alias.result!==7||alias.twice(4)!==8) throw new Error("reexports");
            const engine=await import("babylon-lite");
            if(typeof engine.createSceneContext!=="function") throw new Error("pinned module callable");
            const live=await import("./state");
            if(live!==state||live.count!==1) throw new Error("static namespace identity");
            const {label,item}=live;
            const {...snapshot}=live;
            live.bump();
            if(live.count!==2||state.count!==2) throw new Error("live export");
            if(label!=="before"||item.value!==3||snapshot.count!==1||snapshot.label!=="before"||snapshot.item.value!==3) throw new Error("export binding snapshots");
            let calls=0;
            const readers:Array<()=>typeof state>=[()=>{calls++;return state;}];
            if(readers[0]().count!==2||calls!==1) throw new Error("namespace receiver effects");
            const {count: readCount, label: readLabel}=readers[0]();
            const {}=readers[0]();
            const {count: again,...rest}=readers[0]();
            if(calls!==4||readCount!==2||readLabel!=="after"||again!==2||rest.label!=="after") throw new Error("destructuring receiver evaluation");
            if(Object.keys(a).join(",")!=="answer,twice"||order!=="SM") throw new Error("namespace keys and scheduling");
        }
        run().then(()=>globalThis.close());
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "dynamic-module-imports-native", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
    });
});

test("unrepresented lazy initialization remains an explicit refusal", () => {
    const directory = resolve("artifacts/dynamic-module-refusals");
    mkdirSync(directory, { recursive: true });
    const entry = `export {}; async function run(){await import("./lazy");} run();`;
    writeFileSync(join(directory, "entry.ts"), entry);
    for (const source of [
        `function fail(){throw "failure";} const {ignored=fail()}={}; export const result=1;`,
        `namespace Nested { export const stamp=Date.now(); } export const result=1;`,
        `export class Item { static count=Date.now(); }`,
        `export const answer=await Promise.resolve(1);`,
        `import './entry'; export const result=[1];`,
        `export const values=[1]; enum Runtime { Value=Date.now() }`,
        `export var value=1;`,
        `export class Item {} export const values=[1];`,
    ]) {
        writeFileSync(join(directory, "lazy.ts"), source);
        assert.throws(
            () =>
                compileSource(entry, { fileName: join(directory, "entry.ts") }),
            /Lazy module|Lazy enum|Lazy namespace\/class|Lazy dependencies|Top-level await/,
        );
    }
});

test("lazy modules retain activation order, live state, cycles and cached failures", () => {
    const directory = resolve("artifacts/dynamic-module-activation");
    mkdirSync(directory, { recursive: true });
    const modules = {
        "state.ts": `export let order=""; export let calls=0; export function mark(value:string){order+=value;return ++calls;}`,
        "dependency.ts": `import {mark} from './state'; export const value=mark('D');`,
        "lazy.ts": `
            import {mark} from './state'; import {value} from './dependency';
            export let count=mark('L');
            export const item={value};
            export const table=Object.freeze([{value:3},{value:4}]);
            const transform=(input:number)=>input*3;
            export const derived=[{value:transform(value)}];
            export const read=()=>item.value;
            export function bump(){count++;item.value++;}
        `,
        "failure.ts": `import {mark} from './state'; mark('F'); throw new Error('cached failure'); export const value=1;`,
        "cycle-a.ts": `import {mark} from './state'; import {readB} from './cycle-b'; export const a=mark('A'); export function readA(){return a;} export function peer(){return readB();}`,
        "cycle-b.ts": `import {mark} from './state'; import {readA} from './cycle-a'; export const b=mark('B'); export function readB(){return b;} export function peer(){return readA();}`,
        "tdz-a.ts": `import {b} from './tdz-b'; export const a:number=b+1;`,
        "tdz-b.ts": `import {a} from './tdz-a'; export const b:number=a+1;`,
        "cycle-failure-a.ts": `import './cycle-failure-b'; import {mark} from './state'; mark('X'); throw new Error('cycle failure'); export const a=1;`,
        "cycle-failure-b.ts": `import './cycle-failure-a'; import {mark} from './state'; mark('Y'); export const b=1;`,
    };
    for (const [name, source] of Object.entries(modules))
        writeFileSync(join(directory, name), source);
    const result = compileSource(
        `
        import * as state from './state';
        async function run(){
            const first=import('./lazy');const second=import('./lazy');
            if(first===second||state.calls!==0||state.order!=="")throw new Error('eager activation');
            state.mark('S');
            const a=await first;const b=await second;
            if(a!==b||state.order!=="SDL"||state.calls!==3||a.count!==3)throw new Error('once order');
            const item=a.item;const table=a.table;
            a.bump();
            if(b.count!==4||item!==b.item||item.value!==3||table!==b.table||table[1].value!==4||b.derived[0].value!==6||b.read()!==3)throw new Error('live state identity');
            const again=await import('./lazy');
            if(again!==a||state.calls!==3||again.count!==4)throw new Error('repeated import');
            let failures=0;
            for(let i=0;i<2;i++)try{await import('./failure');}catch(error){
                if(!error.message.includes('cached failure'))throw error;failures++;
            }
            if(failures!==2||state.order!=="SDLF")throw new Error('failure cached');
            const cycle=await import('./cycle-a');const peer=await import('./cycle-b');
            if(state.order!=="SDLFBA"||cycle.peer()!==peer.b||peer.peer()!==cycle.a)throw new Error('cycle state');
            let tdz=0;
            try{await import('./tdz-a');}catch(error){if(error.message.includes('before initialization'))tdz++;}
            if(tdz!==1)throw new Error('cycle TDZ');
            let cyclicFailures=0;
            try{await import('./cycle-failure-a');}catch(error){if(error.message.includes('cycle failure'))cyclicFailures++;}
            try{await import('./cycle-failure-b');}catch(error){if(error.message.includes('cycle failure'))cyclicFailures++;}
            if(cyclicFailures!==2||state.order!=="SDLFBAYX")throw new Error('cycle failure cached');
        }
        run().then(()=>globalThis.close());
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "dynamic-module-activation-native", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
    });
});

test("lazy module bindings of deployment constants hold their folded values", (t) => {
    const directory = resolve("artifacts/dynamic-module-deployment");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "env.d.ts"),
        `interface ImportMetaEnv { readonly VITE_ENDPOINT?: string } interface ImportMeta { readonly env: ImportMetaEnv }`,
    );
    writeFileSync(
        join(directory, "base.ts"),
        `/// <reference path="./env.d.ts" />
        const BASE = import.meta.env.BASE_URL;
        const PRODUCTION = import.meta.env.PROD;
        export const appUrl = (path: string): string => BASE + path;
        export const mode = (): string => (PRODUCTION ? "prod" : "dev");`,
    );
    const result = compileSource(
        `/// <reference path="./env.d.ts" />
        async function run(){
            const base=await import("./base");
            if(base.appUrl("x")!=="/x"||base.mode()!=="prod") throw new Error("deployment constants");
        }
        run().then(()=>globalThis.close());`,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "dynamic-module-deployment-native", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
    });
});

test("namespace exports refuse writes while their object contents stay mutable", (t) => {
    const directory = resolve("artifacts/dynamic-module-write-refusals");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "state.ts"),
        `export let count=1; export const item={value:1}; export const values:number[]=[];`,
    );
    for (const write of ["state.count=4", "state.count++", 'state["count"]=4'])
        assert.throws(
            () =>
                compileSource(`import * as state from "./state"; ${write};`, {
                    fileName: join(directory, "entry.ts"),
                }),
            /read-only/,
        );
    const result = compileSource(
        `import * as state from "./state"; import {item,values} from "./state"; state.item.value=4; state["item"].value+=1; state.values.push(7); if(item.value!==5||state.item.value!==5||values[0]!==7) throw new Error("exported object mutation");`,
        {
            fileName: join(directory, "entry.ts"),
        },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "dynamic-module-exported-object", result.cpp);
});
