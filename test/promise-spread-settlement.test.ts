import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("async records retain concrete erased field owners and shared identities", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        interface Envelope {payload:unknown; rows:unknown; label:string;}
        async function wrap(value:{count:number}, rows:number[]):Promise<Envelope> {
            await Promise.resolve();
            return {payload:value,rows,label:'ready'};
        }
        (async()=>{
            const item={count:1}, rows=[2];
            const pending=wrap(item,rows);
            item.count=3;
            const first=await pending, again=await pending;
            if(first!==again||first.payload!==item||first.rows!==rows||first.label!=='ready')throw new Error('identity');
            (first.payload as {count:number}).count=7;
            (again.rows as number[]).push(4);
            if(item.count!==7||rows.join()!=='2,4')throw new Error('alias');
            globalThis.close();
        })();
    `;
    await assertAsyncSourceCloses(source);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "promise-spread-settlement/erased-fields",
            result.cpp,
            {
                flags: ["/DBBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("Promise combinator spreads retain heterogeneous resource settlements", (t) => {
    const result = compileSource(`
        import {createEngine,createSolidTexture2D,type Texture2D} from '@babylonjs/lite';
        queueMicrotask(()=>{});
        (async()=>{
            const engine=await createEngine(new OffscreenCanvas(1,1));
            const texture=createSolidTexture2D(engine,.25,.5,.75,1);
            let order='';
            function head(){order+='head';return Promise.resolve(engine);}
            function tail(){order+='tail';return [Promise.resolve(texture)];}
            const values=await Promise.all([head(),...tail()]);
            if(order!=='headtail'||values.length!==2||values[0]!==engine||values[1]!==texture)throw new Error('all identity/order');
            const states=await Promise.allSettled([head(),...tail()]);
            if(states[0]!.status!=='fulfilled'||states[0]!.value!==engine||states[1]!.status!=='fulfilled'||states[1]!.value!==texture)throw new Error('settlements');
            const first=await Promise.race([Promise.resolve(engine),...tail()]);
            if(first!==engine)throw new Error('race identity');
            const failure=new Error('failed');
            const winner=await Promise.any([Promise.reject<typeof engine>(failure),...tail()]);
            if(winner!==texture)throw new Error('any identity');
            interface Box {payload:unknown;}
            async function box(value:Texture2D|undefined):Promise<Box>{await Promise.resolve();return {payload:value};}
            const [present,absent]=await Promise.all([box(texture),box(undefined)]);
            if(present.payload!==texture||absent.payload!==undefined)throw new Error('erased optional owner');
            globalThis.close();
        })();
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const factory = new FactoryLowerer(
        new LoweringContext(),
    ).lowerFileTextureFactory().source;
    runGeneratedProgram(
        native,
        "promise-spread-settlement/resource-owners",
        `
#include <bblite/pal_async_engine.hpp>
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
    return std::make_shared<Engine>();
}
}
${result.cpp}
namespace bbl {
${cppFunction(factory, "[[maybe_unused]] static TextureData solid_texture_data(")}
${cppFunction(factory, "[[maybe_unused]] static FileTexture retained_solid_texture(")}
${cppFunction(factory, "SolidTexture create_solid_texture(")}
${cppFunction(factory, "FileTexture solid_texture_file(")}
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("mixed asset and texture Promise spreads keep both owned handle alternatives", () => {
    const result = compileSource(`
        import {createEngine,loadGltf,loadTexture2D,waitForGpuIdle} from '@babylonjs/lite';
        async function main(){
            const engine=await createEngine(document.querySelector('canvas')!);
            const textures=[loadTexture2D(engine,'icon.png')];
            const [asset,...icons]=await Promise.all([loadGltf(engine,'model.glb'),...textures]);
            if(icons.length!==1)throw new Error('contents');
            await waitForGpuIdle(engine);
        }
        void main();
    `);
    assert.match(
        result.cpp,
        /std::variant<bbl::AssetHandle, bbl::StoredTexture>/,
    );
    assert.match(result.cpp, /Promise<[^;]+>::view/);
});

test("async erased result fields refuse unrepresented method owners", () => {
    assert.throws(
        () =>
            compileSource(`
        queueMicrotask(()=>{});
        interface Envelope {payload:unknown;}
        async function wrap():Promise<Envelope> {return {payload:{read(){return 1;}}};}
        void wrap().then(value=>{if(value.payload)globalThis.close();});
    `),
        /Asynchronous result property 'payload' has no owned representation/,
    );
});
