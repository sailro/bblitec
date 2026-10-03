import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("retained aggregates and promises preserve lazy accessor callbacks", (t) => {
    const result = compileSource(`
        setTimeout(()=>{},0);
        let reads=0;
        let current=4;
        const env={get value(){reads++;return current;}};
        function resolve(options:{env?:typeof env}):{env:Partial<typeof env>}{return{env:options.env??{}};}
        const result=resolve({env});
        if(reads!==0||result.env.value!==4||reads!==1)throw new Error("retained environment getter");
        current=8;
        if(result.env.value!==8||reads!==2)throw new Error("live accessor capture");
        async function make(){return {get value(){reads++;return current;},label:"ok"};}
        async function run(){
            const value=await make();
            if(reads!==2||value.value!==8||reads!==3||value.label!=="ok")throw new Error("async getter");
            current=11;
            const alias=await Promise.resolve(value);
            if(alias!==value||alias.value!==11||reads!==4)throw new Error("promise accessor identity");
        }
        run().then(()=>globalThis.close());
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "retained-accessors", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
        timeoutMs: 10000,
    });
});

test("then accessors retain the explicit assimilation boundary", () => {
    assert.throws(
        () =>
            compileSource(`
        setTimeout(()=>{},0);
        async function make(){return {get then(){return 3;},value:1};}
        make();
    `),
        /thenable assimilation/,
    );
});
