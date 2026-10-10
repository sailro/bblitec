import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("document optional chains preserve lazy keys, continuations and typed lengths", (t) => {
    const source = `
        interface Tree { row?: number[] | null; nested?: { missing?: { value: number } } | null; }
        const tree = JSON.parse('{"row":[1,2],"nested":{}}') as Tree;
        const blank = JSON.parse('null') as Tree | null;
        let calls = 0;
        function key(): 'row' { calls++; return 'row'; }
        if ((blank?.[key()]?.length ?? 7) !== 7 || calls !== 0) throw new Error('lazy key');
        if ((tree?.[key()]?.length ?? 7) !== 2 || calls !== 1) throw new Error('present key');
        if (blank?.nested!.missing!.value !== undefined) throw new Error('chain continuation');
        if (tree?.nested?.missing?.value !== undefined) throw new Error('nested absence');
        let threw = 0;
        try { tree?.nested!.missing!.value; } catch { threw++; }
        try { (blank?.nested)!.missing; } catch { threw++; }
        if (threw !== 2) throw new Error('unguarded missing value');
        tree.row = null;
        if ((tree.row?.length ?? 0) !== 0) throw new Error('null length');
        delete tree.row;
        if ((tree.row?.length ?? 3) !== 3) throw new Error('absent length');
        const text = JSON.parse('"abc"') as string;
        const sized = JSON.parse('{"length":"wide"}') as { length: string };
        const unsized = JSON.parse('{}') as { length?: number };
        if (text.length !== 3 || sized.length !== 'wide') throw new Error('dynamic length');
        if ((unsized.length ?? 9) !== 9) throw new Error('missing length');
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
    assert.match(result.cpp, /optional_json/);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "json-optional-chains/semantics", result.cpp);
});
