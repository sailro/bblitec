import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Promise reactions join owned results without changing scheduling or aliases", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        async function ready(reject:boolean):Promise<boolean>{if(reject)throw new Error('failed');return false;}
        function recover(_error:unknown):void {}
        (async()=>{
            const preserved=await ready(false).catch(recover);
            const recovered=await ready(true).catch(recover);
            if(preserved!==false||recovered!==undefined)throw new Error('void recovery');
            const number=await Promise.resolve(4).catch(()=> 'fallback');
            const text=await Promise.reject<number>(new Error('source')).catch(()=> 'fallback');
            if(number!==4||text!=='fallback')throw new Error('mixed recovery');
            const fulfilled=await Promise.resolve(2).then(n=>n+1,()=> 'no');
            const rejected=await Promise.reject<number>(new Error('source')).then(n=>n+1,()=> 'yes');
            if(fulfilled!==3||rejected!=='yes')throw new Error('two reactions');
            const asynchronous=await Promise.reject<number>(new Error('source')).catch(async()=> 'later');
            if(asynchronous!=='later')throw new Error('adoption');
            let sibling=0;
            const failure=new Error('reaction');
            let same=false;
            await Promise.resolve(1).then(()=>{throw failure;},()=>{sibling++;return 'wrong';}).catch(error=>{same=error===failure;});
            if(sibling!==0||!same)throw new Error('sibling rejection');
            const record={value:1};
            const kept:Promise<{value:number}|null>=Promise.resolve(record).catch(()=>null);
            const read=await kept;
            if(read!==record)throw new Error('result identity');
            if(read)read.value=7;
            if(record.value!==7)throw new Error('result alias');
            const empty:Promise<{value:number}|null>=Promise.resolve(null);
            if(await empty!==null)throw new Error('contextual null');
            let order='';
            const converted=Promise.resolve(1).catch(()=> 'unused').then(()=>{order+='a';});
            const competitor=Promise.resolve().then(()=>{}).then(()=>{order+='b';});
            await Promise.all([converted,competitor]);
            if(order!=='ab')throw new Error('conversion job');
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
            queueMicrotask,
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
            "promise-settlement-joins/owned",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise recovery refuses erased void values with unproved completion", () => {
    assert.throws(
        () =>
            compileSource(`
        queueMicrotask(()=>{});
        const handler:()=>void=()=>9;
        const callbacks:Array<()=>void>=[handler];
        void Promise.resolve(1).catch(callbacks[0]!).then(value=>{if(value===undefined)throw new Error('erased');globalThis.close();});
    `),
        /void result requires a proven undefined completion|stored void|Promise.*result/,
    );
});

test("Promise resolve uses its checked result for explicit settlement types", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        (async()=>{
            const empty = await Promise.resolve<number|null>(null).catch(()=>0);
            const missing = await Promise.resolve<number|undefined>(undefined).then(value=>value);
            if (empty !== null || missing !== undefined) throw new Error('explicit scalar absence');
            const noRecord = await Promise.resolve<{value:number}|null>(null).catch(()=>({value:0}));
            const absentRecord = await Promise.resolve<{value:number}|undefined>(undefined);
            if (noRecord !== null || absentRecord !== undefined) throw new Error('explicit record absence');
            let effects = 0;
            const record = {value:2};
            function payload(): {value:number} { effects++; return record; }
            const resolved = Promise.resolve<{value:number}|null>(payload());
            const adopted = Promise.resolve<{value:number}|null>(resolved);
            if (adopted !== resolved) throw new Error('existing promise identity');
            record.value = 4;
            const retained = await adopted;
            if (!retained || retained !== record || retained.value !== 4 || effects !== 1) throw new Error('owned explicit result');
            retained.value = 9;
            if (record.value !== 9) throw new Error('result mutation');
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
            queueMicrotask,
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
            "promise-settlement-joins/explicit",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise joins refuse reference settlements with collapsed mixed absence", () => {
    assert.throws(
        () =>
            compileSource(`
        queueMicrotask(()=>{});
        const original:Promise<{value:number}|null>=Promise.resolve(null);
        const mixed=original.catch(()=>undefined);
        void mixed.then(value=>{if(value===undefined||value===null)globalThis.close();});
    `),
        /recovery must preserve|settlement|Promise result|native data type/,
    );
});
