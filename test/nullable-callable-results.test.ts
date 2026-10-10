import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("array operands retain nullable callback result tags, identity and evaluation order", (t) => {
    const source = `
        interface Cell<T>{value:T}
        let calls=0;
        function create<T>(cell:Cell<T>):(mode:number)=>Cell<T>|null|undefined{
            return mode=>{calls++;return mode>0?cell:mode===0?null:undefined;};
        }
        const original:Cell<number>={value:3};
        const read=create(original);const readers:Array<typeof read>=[read];
        const values=[readers[0]!(1),readers[0]!(0),readers[0]!(-1)];
        if(values[0]!==original||values[1]!==null||values[2]!==undefined||calls!==3)
            throw new Error('callable nullish tags and one evaluation');
        const held=values[0]!;held.value=8;
        if(original.value!==8)throw new Error('callable returned identity');
        const other=create({value:'a'});const others:Array<typeof other>=[other];
        if(others[0]!(0)!==null||others[0]!(-1)!==undefined||others[0]!(1)!.value!=='a'||Number(calls)!==6)
            throw new Error('independent generic result tags');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.match(result.cpp, /Array<bbl::js::Tagged</);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "nullable-callable-results/array-operands",
        result.cpp,
    );
});
