import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Promise combinators resolve represented values while consuming synchronous iterables", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        (async()=>{
            const numbers=[2,3];
            if((await Promise.all(numbers)).join()!=='2,3')throw new Error('array values');
            const record={value:4};
            const records=new Set([record]);
            const results=await Promise.all(records);
            if(results[0]!==record)throw new Error('iterable identity');
            results[0]!.value=7;
            if(record.value!==7)throw new Error('iterable mutation');
            let order='';
            function head(){order+='head';return record;}
            function tail(){order+='tail';return new Set([2,3]);}
            const spread=await Promise.all([head(),...tail(),Promise.resolve(5)]);
            if(order!=='headtail'||spread[0]!==record||spread[1]!==2||spread[2]!==3||spread[3]!==5)throw new Error('spread ordering');
            const mixed:Array<number|Promise<number>>=[1,Promise.resolve(2),3];
            if((await Promise.all(mixed)).join()!=='1,2,3')throw new Error('mixed input');
            const optional:Array<number|Promise<number>|undefined>=[undefined,Promise.resolve(4),5];
            const optionalValues=await Promise.all(optional);
            if(optionalValues[0]!==undefined||optionalValues[1]!==4||optionalValues[2]!==5)throw new Error('optional mixed input');
            const different:Array<string|Promise<number>>=['first',Promise.resolve(8)];
            const values=await Promise.all(different);
            if(values[0]!=='first'||values[1]!==8)throw new Error('different settled types');
            const states=await Promise.allSettled(new Set([2,3]));
            if(states[0]!.status!=='fulfilled'||states[0]!.value!==2||states[1]!.status!=='fulfilled'||states[1]!.value!==3)throw new Error('all settled');
            if(await Promise.race(new Set([4,5]))!==4)throw new Error('race values');
            if(await Promise.race([4,Promise.resolve('later')])!==4)throw new Error('mixed literal race');
            if(await Promise.any([Promise.resolve('first'),5])!=='first')throw new Error('mixed literal any');
            function* raw():Generator<number>{yield 6;yield 7;}
            if(await Promise.any(raw())!==6)throw new Error('any values');
            const missing:Array<number|undefined>=[undefined,9];
            const kept=await Promise.all(missing);
            if(kept[0]!==undefined||kept[1]!==9)throw new Error('explicit undefined');
            if((await Promise.all(new Set<number>())).length!==0)throw new Error('empty all');
            let emptyRejected=false;
            await Promise.any(new Set<number>()).catch(error=>{emptyRejected=error instanceof AggregateError;});
            if(!emptyRejected)throw new Error('empty any');
            if((await Promise.all(new Uint8Array([1,2]))).join()!=='1,2')throw new Error('typed values');
            if((await Promise.all('ab')).join()!=='a,b')throw new Error('string values');
            let current=1;
            const packed=await Promise.all([0,...[current,current++],current]);
            if(packed.join()!=='0,1,1,2')throw new Error('spread snapshots');
            globalThis.close();
        })();
    `;
    await assertAsyncSourceCloses(source);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "promise-value-iterables/values",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise iterable resolution observes each yield before advancing and rejects iteration errors", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        (async()=>{
            let order='';
            const first=Promise.resolve(1);
            function* interleaved():Generator<number|Promise<number>> {
                yield first;
                void first.then(()=>{void Promise.resolve().then(()=>{order+='inner';});});
            }
            await Promise.all(interleaved()).then(()=>{order+='all';});
            await Promise.resolve();await Promise.resolve();
            if(order!=='allinner')throw new Error('observation order');
            const failure=new Error('iteration');
            let closed=0;
            function* broken():Generator<number> {try{yield 1;throw failure;}finally{closed++;}}
            let sync=false;
            let all:Promise<number[]>|undefined;
            try{all=Promise.all(broken());}catch{sync=true;}
            if(sync||closed!==1)throw new Error('all rejection timing');
            await all!.catch(error=>{if(error!==failure)throw new Error('all rejection');return [];});
            await Promise.allSettled(broken()).catch(error=>{if(error!==failure)throw new Error('settled rejection');return [];});
            await Promise.race(broken()).catch(error=>{if(error!==failure)throw new Error('race rejection');return 0;});
            await Promise.any(broken()).catch(error=>{if(error!==failure)throw new Error('any rejection');return 0;});
            if(closed!==4)throw new Error('iterator cleanup');
            sync=false;
            try{void Promise.all([0,...broken()]);}catch(error){sync=error===failure;}
            if(!sync||closed!==5)throw new Error('spread throws synchronously');
            globalThis.close();
        })();
    `;
    await assertAsyncSourceCloses(source);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "promise-value-iterables/timing",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise iterable values refuse thenable protocols, async iterators and sparse spread literals", () => {
    for (const operation of ["all", "allSettled", "race", "any"]) {
        assert.throws(
            () =>
                compileSource(
                    `queueMicrotask(()=>{});const values=[{then(resolve:(value:number)=>void){resolve(1);}}];void Promise.${operation}(values);`,
                ),
            /thenable|owned common settlement|native data|Promise storage/,
        );
        assert.throws(
            () =>
                compileSource(
                    `queueMicrotask(()=>{});async function* values():AsyncGenerator<number>{yield 1;}void Promise.${operation}(values());`,
                ),
            /synchronous iterable/,
        );
        assert.throws(
            () =>
                compileSource(
                    `queueMicrotask(()=>{});void Promise.${operation}([1,...[2],,3]);`,
                ),
            /sparse spread literals/,
        );
    }
});

test("Promise reactions refuse erased returned promises even when their settlements are void", () => {
    for (const operation of ["then", "catch", "finally"]) {
        assert.throws(
            () =>
                compileSource(`
            queueMicrotask(()=>{});
            const clean:()=>void=()=>Promise.resolve().then(()=>{throw new Error('delayed');});
            void Promise.resolve().${operation}(clean);
        `),
            /void result requires a proven undefined completion/,
        );
    }
});

test("Stored async callbacks cannot retain an undefined completion proof after replacement", () => {
    for (const replacement of [
        "fn=async()=>hidden();",
        "const replacement=async()=>hidden();fn=replacement;",
    ]) {
        assert.throws(
            () =>
                compileSource(`
                    queueMicrotask(()=>{});
                    const hidden:()=>void=()=>7;
                    let fn=async()=>{};
                    ${replacement}
                    void fn();
                `),
            /proven undefined completion after awaiting/,
        );
    }
    compileSource(`
        queueMicrotask(()=>{});
        let fn=async()=>{};
        fn=async()=>{return undefined;};
        const replacement=async()=>{void 7;};
        fn=replacement;
        void fn();
    `);
});
