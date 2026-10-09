import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Set constructors consume represented iterable ranges and preserve element owners", async (t) => {
    const source = `
        const item={value:4};
        const map=new Map<number,typeof item>([[2,item],[3,item]]);
        const cursor=map.keys();
        const keys=new Set(cursor);
        if(keys.size!==2||!keys.has(2)||!keys.has(3)||!cursor.next().done)throw new Error('cursor');
        map.set(5,item);
        if(keys.has(5)||keys.size!==2)throw new Error('fresh collection');
        const values=new Set(map.values());
        if(values.size!==1||!values.has(item))throw new Error('owner');
        item.value=8;
        if(values.values().next().value?.value!==8)throw new Error('alias');
        const units=new Set('a😀a');
        if(units.size!==2||!units.has('😀'))throw new Error('code points');
        const numbers=new Set(new Uint8Array([1,2,1]));
        if(numbers.size!==2||!numbers.has(2))throw new Error('typed array');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
    );
    const result = compileSource(source);
    assert.ok(result.cpp.length > 0);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "set-iterable-construction/ranges",
            result.cpp,
        );
    });
});
