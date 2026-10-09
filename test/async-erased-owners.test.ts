import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("nested and erased async records retain concrete owners through callbacks and combinators", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        interface Envelope {wrapper:{payload:unknown;rows:unknown};}
        let calls=0;
        function count(value:number):number {calls++;return value;}
        async function wrap(value:{count:number}, rows:Float32Array):Promise<Envelope> {
            await Promise.resolve();
            return {wrapper:{payload:value,rows}};
        }
        async function erased(value:{count:number}):Promise<unknown> {
            await Promise.resolve();
            return {child:{value:count(9)},owner:value};
        }
        async function declaredOptional(value:{count:number}):Promise<{wrapper?:{payload:unknown}}> {
            return {wrapper:{payload:value}};
        }
        (async()=>{
            const value={count:1};
            const rows=new Float32Array([2,3]);
            const callbacks:Array<typeof wrap>=[wrap];
            const pending=callbacks[0]!(value,rows);
            const first=await pending,again=await pending;
            if(first!==again||first.wrapper!==again.wrapper||first.wrapper.payload!==value||first.wrapper.rows!==rows)throw new Error('nested identity');
            (first.wrapper.payload as {count:number}).count=7;
            (again.wrapper.rows as Float32Array)[0]=8;
            if(value.count!==7||rows[0]!==8)throw new Error('nested aliases');
            const unknown=await erased(value);
            const view=unknown as {child:{value:number};owner:{count:number}};
            if(view.owner!==value||view.child.value!==9||calls!==1)throw new Error('erased allocation/effects');
            const optional=await declaredOptional(value);
            if(!Object.hasOwn(optional,'wrapper')||optional.wrapper!.payload!==value)throw new Error('present optional field');
            const more=[wrap(value,rows)];
            const results=await Promise.all([wrap(value,rows),...more]);
            if(results.length!==2||results[0]!.wrapper.payload!==value||results[1]!.wrapper.rows!==rows)throw new Error('owned spread');
            const reverse=await Promise.all([...more,wrap(value,rows)]);
            if(reverse[0]!==await more[0]!)throw new Error('spread-first identity');
            const states=await Promise.allSettled([wrap(value,rows),...more]);
            if(states[1]!.status!=='fulfilled'||states[1]!.value.wrapper.payload!==value)throw new Error('settled owners');
            if((await Promise.race([...more,wrap(value,rows)])).wrapper.payload!==value)throw new Error('raced owner');
            if((await Promise.any([wrap(value,rows),...more])).wrapper.rows!==rows)throw new Error('any owner');
        })().then(()=>globalThis.close());
    `;
    await assertAsyncSourceCloses(source);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "async-erased-owners/records",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("nested erased async fields retain present and absent native owners", (t) => {
    const result = compileSource(`
        import {createEngine,createStorageBuffer,type StorageBuffer} from '@babylonjs/lite';
        queueMicrotask(()=>{});
        interface Envelope {nested:{owner:unknown};}
        async function wrap(owner:StorageBuffer|undefined):Promise<Envelope> {
            await Promise.resolve();
            return {nested:{owner}};
        }
        (async()=>{
            const engine=await createEngine(new OffscreenCanvas(1,1));
            const owner=createStorageBuffer(engine,new Float32Array([1]));
            const pending=wrap(owner);
            const present=await pending,again=await pending,absent=await wrap(undefined);
            if(present!==again||present.nested.owner!==owner||absent.nested.owner!==undefined)throw new Error('native nested ownership');
            globalThis.close();
        })();
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "async-erased-owners/native",
        `
        #include <bblite/pal_async_engine.hpp>
        namespace bbl::pal {
        std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {return std::make_shared<Engine>();}
        }
        ${result.cpp}
    `,
        {
            defines: ["BBLITE_WORKERS=1", "BBLITE_OFFSCREEN_SURFACES=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("erased asynchronous records refuse unrepresented descriptors and thenable protocols", () => {
    for (const value of [
        "{read(){return 1;},value:2}",
        "{get value(){return 1;}}",
        "{then(resolve:(value:number)=>void){resolve(1);}}",
    ]) {
        assert.throws(
            () =>
                compileSource(
                    `queueMicrotask(()=>{});async function wrap():Promise<unknown>{return ${value};}void wrap();`,
                ),
            /owned asynchronous representation|thenable/,
        );
    }
    assert.throws(
        () =>
            compileSource(
                `queueMicrotask(()=>{});interface Envelope{wrapper:{payload:unknown};}async function wrap():Promise<Envelope>{return {wrapper:{get payload(){return 1;}}};}void wrap();`,
            ),
        /no owned representation/,
    );
    assert.throws(
        () =>
            compileSource(
                `queueMicrotask(()=>{});async function wrap():Promise<{wrapper?:{payload:unknown}}>{return {};}void wrap();`,
            ),
        /no owned representation/,
    );
});
