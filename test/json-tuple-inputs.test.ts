import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("JSON stringify accepts represented tuple members after optional unknown calls", async (t) => {
    const source = `
        function snapshot<T extends object>(read:()=>T|undefined, externalState?:()=>unknown):string {
            const record=read();
            if(!record)return '';
            return JSON.stringify([record,externalState?.()]);
        }
        const record={value:1};
        if(snapshot(()=>record)!=='[{"value":1},null]')throw new Error('omitted callback');
        let effects=0;
        const text=snapshot(()=>{effects++;return record;},()=>{effects++;record.value=2;return {extra:3};});
        if(text!=='[{"value":2},{"extra":3}]'||effects!==2)throw new Error('ordered aliases');
        const empty=snapshot(()=>record,()=>undefined);
        if(empty!=='[{"value":2},null]')throw new Error('undefined array member');
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
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "json-tuple-inputs/optional-unknown",
            result.cpp,
        );
    });
});

test("JSON tuple input still refuses unrepresented function members", () => {
    assert.throws(
        () => compileSource(`JSON.stringify([()=>1]);`),
        /JSON|json|document|function/,
    );
});
