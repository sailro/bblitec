import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Promise result views retain settlement and promise identities", async (t) => {
    const source = `
        interface Full { x:number; y:number; }
        interface Base { x:number; }
        function widen(input:Promise<number>):Promise<number|string>{return input;}
        (async()=>{
            await Promise.resolve();
            const original=Promise.resolve(1);
            const widened=widen(original);
            const repeated:Promise<number|string>=original;
            const separate:Promise<number|string>=Promise.resolve(1);
            const held=new Set<Promise<number|string>>([widened,repeated,separate]);
            if(widened!==original || held.size!==2 || !held.has(repeated))throw new Error('promise identity/hash');
            if(!held.delete(repeated)||held.size!==1||held.has(widened))throw new Error('promise aliases');
            const value=await widened;
            if(value!==1)throw new Error('union settlement');
            const object:Full={x:1,y:2};
            const full:Promise<Full>=Promise.resolve(object);
            const base:Promise<Base>=full;
            const a=await base,b=await base;
            if(a!==b||a!==object)throw new Error('settled object identity');
            a.x=9;
            const read=await full;
            if(object.x!==9||read.x!==9)throw new Error('settled aliases');
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
        {
            close: () => {
                closed = true;
            },
        },
    );
    assert.equal(closed, true);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "promise-result-views/identity",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise result views refuse aliased array representation copies", () => {
    assert.throws(
        () =>
            compileSource(`
        const values:number[]=[1];
        const source:Promise<number[]>=Promise.resolve(values);
        const widened:Promise<Array<number|string>>=source;
        void widened.then(result=>{result.push('next');if(values.length!==2)throw new Error('alias');});
    `),
        /array stored as an array of another element type is a copy/,
    );
});
