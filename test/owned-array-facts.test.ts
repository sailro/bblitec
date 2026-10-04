import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { CompileError } from "../src/compiler/compile-error.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("owned literal record arrays retain native identity and evaluate fields once", (t) => {
    const source = `
        let effects=0;
        function next():number {effects++;return effects;}
        const rows:readonly {label:string;score:number;enabled:boolean}[]=[
            {label:'first',score:next(),enabled:true},
            {label:'second',score:next(),enabled:false},
        ];
        const selected=rows[Math.random()<0.5?0:1]!;
        const known=rows[0]!;
        const mapped=rows.map(row=>row.score*2);
        known.score=10;
        const changed=rows.map(row=>row.score);
        selected.enabled=!selected.enabled;
        if(effects!==2||mapped[0]!==2||mapped[1]!==4||changed[0]!==10||
           known!==rows[0]||!rows.includes(selected)) throw new Error('array identity');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "owned-array-facts", result.cpp);
});

test("owned resource maps preserve per-element facts but decline mutated and escaping snapshots", () => {
    const directory = resolve("artifacts/owned-array-resource-facts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    writeFileSync(
        resolve(directory, "paths.ts"),
        `export const paths:readonly {url:string;enabled:boolean}[]=[{url:'./first.glb',enabled:true},{url:'./second.glb',enabled:false}];`,
    );
    writeFileSync(
        resolve(directory, "mutable-paths.ts"),
        `export const paths:{url:string;enabled:boolean}[]=[{url:'./first.glb',enabled:true},{url:'./second.glb',enabled:false}];`,
    );
    const program = (
        before: string,
        callback: string,
        after = "",
        module = "paths",
    ) => `
        import {createEngine,loadGltf,type EngineContext} from '@babylonjs/lite';
        import {paths} from './${module}.js';
        const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();
        async function load(engine:EngineContext,url:string){return await loadGltf(engine,url);}
        function edit(row:{url:string;enabled:boolean}):void {row.url=String(Date.now());}
        const saved:Array<{url:string;enabled:boolean}>=[];
        const canvas=document.querySelector('canvas')!;
        const engine=await createEngine(canvas);
        const selected=paths[Math.random()<0.5?0:1]!;
        ${before}
        const loaded=await Promise.all(paths.map(path=>${callback}));
        if(loaded.length!==2||!paths.includes(selected))throw new Error('selection');
        ${after}
    `;
    const options = {
        fileName: resolve(directory, "entry.ts"),
        publicUrl: "https://assets.example/",
    };
    for (const after of ["", "selected.enabled=!selected.enabled;"]) {
        const result = compileSource(
            program("", "load(engine,path.url)", after),
            options,
        );
        assert.deepEqual(
            result.manifest.assets
                .filter((asset) => asset.kind === "gltf")
                .map((asset) => asset.source),
            ["./first.glb", "./second.glb"],
        );
    }
    const refusals = [];
    for (const [before, callback] of [
        [
            "const alias=paths[0]!;alias.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        ["selected.url=String(Date.now());", "load(engine,path.url)"],
        [
            "const [row]=paths;row!.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const copy=[...paths];copy[0]!.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const copy=Array.from(paths);copy[0]!.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const [...copy]=paths;copy[0]!.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const aliases=new Set([selected]);for(const row of aliases)row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "function pick():{url:string;enabled:boolean}{return paths[0]!;}const row=pick();row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const copy=paths.slice();copy[0]!.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const row=paths.at(0)!;row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const row=paths.find(path=>path.enabled)!;row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "const box={row:paths[0]!};box.row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "for(const [,row] of paths.entries())row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "for(const row of paths)row.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "paths.forEach(row=>{row.url=String(Date.now());});",
            "load(engine,path.url)",
        ],
        [
            "paths.reduce((count,row)=>{row.url=String(Date.now());return count+1;},0);",
            "load(engine,path.url)",
        ],
        [
            "const choice=Math.random()<0.5?paths[0]!:paths[1]!;choice.url=String(Date.now());",
            "load(engine,path.url)",
        ],
        [
            "",
            "{paths[1]!.url=String(Date.now());return load(engine,path.url);}",
        ],
        [
            "",
            "{const pending=load(engine,path.url);edit(paths[1]!);return pending;}",
        ],
        ["", "{saved.push(path);return load(engine,path.url);}"],
        [
            "",
            "{const pending=load(engine,path.url);path.url=String(Date.now());return pending;}",
        ],
    ]) {
        try {
            compileSource(program(before!, callback!), options);
            refusals.push("generated");
        } catch (error) {
            refusals.push(
                error instanceof CompileError &&
                    /generation-known iteration count|static string/.test(
                        error.message,
                    )
                    ? "refused"
                    : String(error),
            );
        }
    }
    assert.deepEqual(refusals, Array<string>(21).fill("refused"));
    assert.throws(
        () =>
            compileSource(
                program(
                    "",
                    "{const pending=load(engine,path.url);paths.push({url:'./third.glb',enabled:true});return pending;}",
                    "",
                    "mutable-paths",
                ),
                options,
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /generation-known iteration count|static string/.test(
                error.message,
            ),
    );
});
