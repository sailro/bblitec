import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Promise all consumes live iterables and registers reactions between yields", async (t) => {
    const source = `
        (async()=>{
            const first=Promise.resolve(1), second=Promise.resolve(2);
            const pending=new Set<Promise<number>>([first,second]);
            if((await Promise.all(pending)).join()!=='1,2')throw new Error('set input');
            if((await Promise.all([Promise.resolve(0),...pending])).join()!=='0,1,2')throw new Error('set spread');
            const cursor=pending.values();
            if(cursor.next().value!==first)throw new Error('cursor head');
            if((await Promise.all(cursor)).join()!=='2'||!cursor.next().done)throw new Error('cursor position');
            let order='';
            function* ordered():Generator<Promise<number>> {
                yield first;
                void first.then(()=>{void Promise.resolve().then(()=>{order+='inner';});});
            }
            await Promise.all(ordered()).then(()=>{order+='all';});
            await Promise.resolve();await Promise.resolve();
            if(order!=='allinner')throw new Error('interleaved reactions');
            const iterationError=new Error('iterator'), inputError=new Error('input');
            let finalized=0;
            function* throwsAfterYield():Generator<Promise<number>> {
                try {yield Promise.reject<number>(inputError);throw iterationError;}
                finally {finalized++;}
            }
            let synchronous=false, rejected:Promise<number[]>|undefined;
            try {rejected=Promise.all(throwsAfterYield());}catch{ synchronous=true; }
            if(synchronous||!rejected||finalized!==1)throw new Error('iteration rejection timing');
            await rejected.catch(error=>{if(error!==iterationError)throw new Error('iteration error precedence');return [];});
            function* spreadThrows():Generator<Promise<number>> {yield first;throw iterationError;}
            synchronous=false;
            try {void Promise.all([...spreadThrows()]);}catch(error){synchronous=error===iterationError;}
            if(!synchronous)throw new Error('spread error timing');
            const failures=new Set<Promise<number>>([Promise.reject<number>(inputError),Promise.reject<number>(iterationError)]);
            await Promise.all(failures).catch(error=>{if(error!==inputError)throw new Error('first rejection');return [];});
            const states=await Promise.allSettled(new Set<Promise<number>>([first,Promise.reject<number>(inputError)]));
            if(states[0]!.status!=='fulfilled'||states[0]!.value!==1||states[1]!.status!=='rejected'||states[1]!.reason!==inputError)
                throw new Error('settled order');
            let reactionOrder='';
            const aggregate=Promise.allSettled(new Set<Promise<number>>([first])).then(()=>{reactionOrder+='a';});
            const competing=Promise.resolve().then(()=>{}).then(()=>{reactionOrder+='b';});
            await aggregate;await competing;
            if(reactionOrder!=='ab')throw new Error('settled reaction scheduling');
            let tupleOrder='';
            const tupleAggregate=Promise.allSettled([first,Promise.resolve('x')]).then(values=>{
                if(values[0]!.status!=='fulfilled'||values[0]!.value!==1||values[1]!.status!=='fulfilled'||values[1]!.value!=='x')
                    throw new Error('heterogeneous settlements');
                tupleOrder+='a';
            });
            const tupleCompeting=Promise.resolve().then(()=>{}).then(()=>{tupleOrder+='b';});
            await tupleAggregate;await tupleCompeting;
            if(tupleOrder!=='ab')throw new Error('tuple settlement scheduling');
            const emptySettlements=await Promise.allSettled([]);
            if(emptySettlements.length!==0)throw new Error('empty settled tuple');
            if((await Promise.all(new Set<Promise<number>>())).length!==0)throw new Error('empty set');
            const queued=new Set<Promise<void>>();
            let completed=0;
            function enqueue():void {
                const task=Promise.resolve(true).then(accepted=>{if(accepted)completed++;});
                queued.add(task);
                void task.finally(()=>{queued.delete(task);});
            }
            enqueue();enqueue();
            const completions=await Promise.all([...queued]);
            if(completed!==2||completions.length!==2||completions[0]!==undefined||completions[1]!==undefined)
                throw new Error('void promise spread');
            interface Item { value:number; }
            const item:Item={value:7};
            let evaluation='';
            function head():Promise<Item>{evaluation+='head';return Promise.resolve(item);}
            function tail():Promise<string>[]{evaluation+='tail';return [Promise.resolve('a'),Promise.resolve('b')];}
            const [record,...labels]=await Promise.all([head(),...tail()]);
            if(evaluation!=='headtail'||record!==item||labels.join()!=='a,b')throw new Error('mixed spread order/identity');
            record.value=8;
            if(item.value!==8)throw new Error('mixed spread record alias');
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
            "promise-iterable-boundaries/live-iteration",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise all refuses asynchronous iterators", () => {
    assert.throws(
        () =>
            compileSource(`
        async function* values():AsyncGenerator<number>{yield 1;}
        void Promise.all(values());
    `),
        /synchronous iterable/,
    );
});
