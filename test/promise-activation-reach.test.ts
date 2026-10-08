import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("unrelated identity uses do not activate immediate promises", () => {
    const settlement = `const answer=await Promise.resolve(3);if(answer!==3)throw new Error('settlement');`;
    for (const source of [
        settlement,
        `function unused(){return new Set<object>();}${settlement}`,
        `function unused(a:unknown,b:unknown){return a===b;}${settlement}`,
        `function unused(){const p=Promise.resolve(3);return p===p;}${settlement}`,
        `function cast(value:unknown){return value as {x:number};}function equal(a:{x:number},b:{x:number}){return a===b;}${settlement}`,
        `function equal(a:unknown,b:unknown){return a===b;}if(!equal(1,1))throw new Error('scalar');${settlement}`,
        `const keys=new Set<number>([1,2]);if(keys.size!==2)throw new Error('keys');${settlement}`,
        `const cache=new Map<string,Promise<number>>();cache.set('a',Promise.resolve(3));if(await cache.get('a')!==3)throw new Error('value');`,
        `const values:Promise<number>[]=[Promise.resolve(1),Promise.resolve(1)];if(await values[0]!==1)throw new Error('value');`,
        `const value:unknown=await Promise.resolve(1);if(value!==1)throw new Error('value');`,
        `async function value(){return 1;}const item:unknown=await value();if(item!==1)throw new Error('value');`,
        `async function read():Promise<ArrayBuffer>{return Promise.resolve(new ArrayBuffer(4));}if((await read()).byteLength!==4)throw new Error('adoption');`,
        `let value:string|null=null;if(value===null)value=await Promise.resolve('ready');if(value!=='ready')throw new Error('assignment');`,
    ]) {
        const result = compileSource(source);
        assert.ok(
            !result.manifest.features.includes("platform:workers"),
            source,
        );
        assert.doesNotMatch(result.cpp, /bbl::js::Promise</, source);
    }
});

test("reached promise identities and erased aliases require owned storage", () => {
    for (const source of [
        `const a=Promise.resolve(1),b=Promise.resolve(1);if(new Set([a,b]).size!==2)throw new Error('identity');`,
        `const a=Promise.resolve(1),b=Promise.resolve(1);if(new Map([[a,1],[b,2]]).size!==2)throw new Error('identity');`,
        `const a:unknown=Promise.resolve(1),b:unknown=Promise.resolve(1);if(a===b)throw new Error('identity');`,
        `function equal(a:unknown,b:unknown){return a===b;}if(equal(Promise.resolve(1),Promise.resolve(1)))throw new Error('identity');`,
        `function hide():unknown{return Promise.resolve(1);}if(hide()===hide())throw new Error('identity');`,
        `const [a,b]:unknown[]=[Promise.resolve(1),Promise.resolve(1)];if(a===b)throw new Error('identity');`,
        `interface Box{value:unknown}const p=Promise.resolve(1),q=Promise.resolve(1);const boxes:Box[]=[{value:p},{value:q}];if(boxes[0]!.value===boxes[1]!.value)throw new Error('identity');`,
        `function hide(value:Promise<number>[]):unknown[]{return value;}const values=hide([Promise.resolve(1),Promise.resolve(1)]);if(values[0]===values[1])throw new Error('identity');`,
        `function hide<T>(value:T):unknown{return value;}if(hide(Promise.resolve(1))===hide(Promise.resolve(1)))throw new Error('identity');`,
        `const values=new Map<string,Promise<number>>([['a',Promise.resolve(1)]]);const hidden:unknown=values;`,
        `const p:PromiseLike<number>=Promise.resolve(1);const q:PromiseLike<number>=Promise.resolve(1);if(p===q)throw new Error('PromiseLike aliases');`,
        `const p=Promise.resolve(1);if(typeof p!=='object')throw new Error('object type');`,
    ]) {
        const result = compileSource(source);
        assert.ok(
            result.manifest.features.includes("platform:workers"),
            source,
        );
        assert.match(result.cpp, /bbl::js::Promise</, source);
    }
});

test("unrepresented reached promise identity operations refuse instead of comparing settlements", () => {
    for (const [source, message] of [
        [
            `const p=Promise.resolve(1),q=Promise.resolve(1);switch(p){case q:throw new Error('identity');}`,
            /Switch discriminants.*promise/,
        ],
        [
            `const p=Promise.resolve(1),q=Promise.resolve(1);[p].includes(q);`,
            /Array.includes.*not promise/,
        ],
        [
            `Object.is(Promise.resolve(1),Promise.resolve(1));`,
            /Object.is compares numbers/,
        ],
        [
            `const p=Promise.resolve(1);if(p===1)throw new Error('object comparison');`,
            /Strict Promise-to-primitive/,
        ],
        [
            `const p=Promise.resolve(1),q=Promise.resolve(1);new Set<object>([p,q]);`,
            /new Set requires concrete/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

test("owned promise aliases retain identity before and after awaiting", async (t) => {
    const source = `
        (async()=>{
            const a=Promise.resolve(1),b=Promise.resolve(1);
            if(typeof a!=='object')throw new Error('object observation');
            if(new Set([a,b]).size!==2||new Map([[a,1],[b,2]]).size!==2)throw new Error('keys');
            const hidden:unknown=a,other:unknown=b;
            function equal(left:unknown,right:unknown){return left===right;}
            function hide():unknown{return Promise.resolve(1);}
            function generic<T>(value:T):unknown{return value;}
            if(hidden===other||!equal(hidden,a)||equal(a,b)||hide()===hide())throw new Error('aliases');
            if(generic(a)!==a||generic(a)===generic(b))throw new Error('generic aliases');
            const [first,second]:unknown[]=[a,b];
            if(first!==a||second!==b||first===second)throw new Error('destructured aliases');
            const boxes:Array<{value:unknown}>=[{value:a},{value:b}];
            if(boxes[0]!.value!==a||boxes[0]!.value===boxes[1]!.value)throw new Error('field aliases');
            function widen(values:Promise<number>[]):unknown[]{return values;}
            const values=widen([a,b]);
            if(values[0]!==a||values[0]===values[1])throw new Error('returned collection');
            if(await a!==1||await b!==1)throw new Error('settlements');
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            close() {
                closed = true;
            },
        },
    );
    assert.equal(closed, true);
    const compiled = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !tools }, () => {
        runGeneratedProgram(
            tools!,
            "promise-activation-reach/aliases",
            compiled.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 20_000,
            },
        );
    });
});

test("immediate promise adoption preserves wrapped results and effects", async (t) => {
    const source = `
        (async()=>{
            let calls=0;
            function bytes(size:number){calls++;return Promise.resolve(new ArrayBuffer(size));}
            async function read(flag:boolean):Promise<ArrayBuffer>{
                return flag ? (bytes(4)) : (bytes(8));
            }
            const wrapped=async ():Promise<ArrayBuffer> => (bytes(2));
            const first=await (read(true));
            const second=await (read(false));
            await (wrapped());
            if(first.byteLength!==4||second.byteLength!==8||calls!==3)
                throw new Error('adopted results and effects');
            let text:string|null=null;
            function choose(flag:boolean){calls++;return flag;}
            if(text===null)text=await (choose(true) ? Promise.resolve('ready') : Promise.resolve('wrong'));
            if(text!=='ready'||calls!==4)throw new Error('awaited assignment');
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            close() {
                closed = true;
            },
        },
    );
    assert.equal(closed, true);
    const compiled = compileSource(source);
    assert.ok(!compiled.manifest.features.includes("platform:workers"));
    assert.doesNotMatch(compiled.cpp, /bbl::js::Promise</);
    const tools = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !tools }, () => {
        runGeneratedProgram(
            tools!,
            "promise-activation-reach/adoption",
            compiled.cpp,
        );
    });
});
