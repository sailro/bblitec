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

test("observable lazy initialization refuses instead of becoming eager or disappearing", () => {
    const directory = resolve("artifacts/dynamic-module-refusals");
    mkdirSync(directory, { recursive: true });
    for (const source of [
        `export let count=0; export function bump(){count++;}`,
        `export const stamp=Date.now();`,
        `throw new Error("module failure"); export const result=1;`,
        `function fail(){throw "failure";} export const ignored=fail(); export const result=1;`,
        `function fail(){throw "failure";} const {ignored=fail()}={}; export const result=1;`,
        `namespace Nested { export const stamp=Date.now(); } export const result=1;`,
        `const values:number[]=[]; export function add(){values.push(1);}`,
        `export const item={value:1};`,
        `export const values=[1,2];`,
        `export const pattern=/value/g;`,
    ]) {
        writeFileSync(join(directory, "lazy.ts"), source);
        assert.throws(
            () =>
                compileSource(
                    `async function run(){await import("./lazy");} run();`,
                    { fileName: join(directory, "entry.ts") },
                ),
            /Lazy module initialization with observable state/,
        );
    }
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
