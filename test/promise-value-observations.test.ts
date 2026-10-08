import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("reached promises retain identity without another asynchronous API", (t) => {
    const source = `
        const a=Promise.resolve(1),b=Promise.resolve(1);
        if(new Set([a,b]).size!==2)throw new Error('promise set identity');
        if(a===b||a!==a)throw new Error('promise comparison');
        if(Promise.resolve(a)!==a)throw new Error('promise adoption identity');
        const values=new Map([[a,2],[b,3]]);
        if(values.size!==2||values.get(a)!==2||values.get(b)!==3)throw new Error('promise map identity');
        const all=Promise.all([1,2]),other=Promise.all([1,2]);
        if(all===other)throw new Error('aggregate identity');
        async function make(){return 1;}
        if(make()===make())throw new Error('async call identity');
        const callbacks=[1,1].map(async value=>value);
        if(new Set(callbacks).size!==2)throw new Error('async callback identity');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    assert.match(compileSource(source).cpp, /bbl::js::Promise</);
    const result = compileSource(`${source}\nglobalThis.close();`);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "promise-value-observations/identity",
        result.cpp,
        {
            defines: ["BBLITE_WORKERS=1"],
            timeoutMs: 20_000,
        },
    );
});

test("each observed promise producer activates owned storage", () => {
    for (const source of [
        `const a=Promise.resolve(1),b=Promise.resolve(1);if(new Set([a,b]).size!==2)throw new Error('set');`,
        `if(Promise.resolve(1)===Promise.resolve(1))throw new Error('comparison');`,
        `async function make(){return 1;}if(make()===make())throw new Error('async identity');`,
        `async function make<T>(value:T){return value;}if(make(1)===make(1))throw new Error('generic async identity');`,
        `const items=[1,1].map(async value=>value);if(new Set(items).size!==2)throw new Error('callback identity');`,
        `if(Promise.all([1])===Promise.all([1]))throw new Error('aggregate identity');`,
    ])
        assert.match(compileSource(source).cpp, /bbl::js::Promise</);
    assert.throws(
        () =>
            compileSource(`Object.is(Promise.resolve(1),Promise.resolve(1));`),
        /Object.is compares numbers, strings and booleans/,
    );
});

test("unobserved promise caches retain immediate settlement lowering", () => {
    const result = compileSource(`
        const cache=new Map<string,Promise<number>>();
        cache.set('a',Promise.resolve(3));
        const answer=await cache.get('a')!;
        if(answer!==3)throw new Error('settled cache');
    `);
    assert.doesNotMatch(result.cpp, /bbl::js::Promise</);
});

test("rejection callback scalar comparisons keep immediate promise lowering", async (t) => {
    const source = `
        let armed=true;
        async function risky():Promise<void>{if(armed)throw new Error('boom');}
        risky().catch(error=>{
            const expected=['boom',4][0]!;
            if(error.message!=='boom'||'boom'!==error.message||error.message.length!==4)
                throw new Error('strict scalar comparisons');
            if(!Object.is(error.message,'boom')||!Object.is(4,error.message.length))
                throw new Error('scalar SameValue');
            if(error.message!==expected)throw new Error('primitive union');
        });
    `;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.doesNotMatch(result.cpp, /bbl::js::Promise</);
    assert.ok(!result.manifest.features.includes("platform:workers"));
    const tools = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !tools }, () => {
        runGeneratedProgram(
            tools!,
            "promise-value-observations/scalar-comparisons",
            result.cpp,
        );
    });
});

test("awaited values retain settled storage in member and comparison expressions", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        (async()=>{
            const record={x:2,child:{y:3}};
            const full=Promise.resolve(record);
            if((await full).x!==2||(await full).child.y!==3)throw new Error('awaited members');
            (await full).x=4;
            if(record.x!==4||(await full)!==record)throw new Error('awaited identity and write');
            const present:Promise<{x:number}|null>=Promise.resolve(record);
            const absent=new Promise<{x:number}|null>((resolve)=>resolve(null));
            if((await present)?.x!==4||(await absent)?.x!==undefined)throw new Error('optional awaited members');
            const widened:Promise<number|string>=Promise.resolve(1);
            if(await widened!==1||await widened===2)throw new Error('awaited union equality');
            if(await Promise.resolve(3)!==3||!(await Promise.resolve(true)))throw new Error('awaited scalars');
            globalThis.close();
        })();
    `;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        { queueMicrotask, close() {} },
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "promise-value-observations/awaited-storage",
        result.cpp,
        {
            defines: ["BBLITE_WORKERS=1"],
            timeoutMs: 20_000,
        },
    );
});
