import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored null-only callbacks preserve values, effects and mixed absence tags", (t) => {
    const source = `
        let calls=0;
        function empty():null {calls++;return null;}
        const readers:Array<()=>null>=[empty,empty];
        const read=readers[0]!;
        if(read!==readers[1]!)throw new Error('callback identity');
        const result=read();
        if(result!==null||result===undefined||calls!==1)
            throw new Error('null result and one evaluation');
        const holder={read:empty};
        const owners:Array<typeof holder>=[holder];
        const alias=owners[0]!;
        if(alias!==holder||alias.read()!==null||Number(calls)!==2)
            throw new Error('stored null-returning method');

        const erased=JSON.parse('{}') as Record<string,unknown>;
        erased.value=readers[1]!();
        if(erased.value!==null||erased.value===undefined||
           Object.keys(erased).join()!=='value'||Number(calls)!==3)
            throw new Error('erased null remains an own value');

        function mixed(mode:number):string|null|undefined {
            if(mode>0)return 'ready';
            if(mode===0)return readers[0]!();
            return undefined;
        }
        const choices:Array<typeof mixed>=[mixed];
        const values=[choices[0]!(1),choices[0]!(0),choices[0]!(-1)];
        if(values[0]!=='ready'||values[1]!==null||values[2]!==undefined||
           Number(calls)!==4)throw new Error('mixed result tags');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.match(result.cpp, /bbl::js::Null/);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "null-only-callback-results", result.cpp);
});
