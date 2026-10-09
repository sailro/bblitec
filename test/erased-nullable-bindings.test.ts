import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("erased local logical assignments distinguish nullish and falsy values", (t) => {
    const source = `
        let calls=0;
        function next():number {calls++;return calls;}
        let selected:unknown;
        selected??=next();
        selected??=next();
        if(selected!==1||calls!==1)throw new Error("undefined local");
        selected=null;
        selected??=next();
        if(selected!==2||calls!==2)throw new Error("null local");
        selected=0;
        selected??=next();
        if(selected!==0||calls!==2)throw new Error("falsy is present");
        selected||=next();
        selected&&=next();
        if(selected!==4||calls!==4)throw new Error("truthy operators");
        let document:unknown=JSON.parse('null');
        document??=next();
        if(document!==5||calls!==5)throw new Error("parsed null");
        let explicit:unknown=undefined;
        explicit??=next();
        if(explicit!==6||calls!==6)throw new Error("explicit undefined");
        function collect(rows:Array<{payload?:{value:number}}>) {
            let payload:unknown;
            for(const row of rows)payload??=row.payload;
            return {payload};
        }
        const value={value:7};
        const result=collect([{}, {payload:value}, {payload:{value:8}}]);
        if(result.payload!==value)throw new Error("record accumulator identity");
        if(collect([]).payload!==undefined)throw new Error("empty accumulator");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(tools, "erased-nullable-bindings", result.cpp);
});

test("native erased bindings refuse incompatible later values", () => {
    assert.throws(
        () =>
            compileSource(`
            import {createEngine,createSolidTexture2D} from "@babylonjs/lite";
            async function main() {
                const engine=await createEngine({});
                let selected:unknown;
                selected??=createSolidTexture2D(engine,.2,.3,.4,1);
                selected=1;
            }
        `),
        /Expected a texture value|does not match the expected data handle/,
    );
});
