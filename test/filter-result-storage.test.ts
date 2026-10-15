import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("filter predicates retain parsed object and array identities", async (t) => {
    const source = `
        function isRecord(value:unknown):value is Record<string,unknown> {
            return typeof value==='object'&&value!==null&&!Array.isArray(value);
        }
        const values:unknown[]=JSON.parse('[{"gain":3},[1,2],true,null]');
        const records=values.filter(isRecord);
        const arrays=values.filter(Array.isArray);
        if(records.length!==1||arrays.length!==1)throw new Error('predicate selection');
        records[0]!.gain=7;
        arrays[0]!.push(3);
        if((values[0] as Record<string,unknown>).gain!==7)throw new Error('object identity');
        if((values[1] as number[]).length!==3)throw new Error('array identity');
        if(Object.keys(records[0]!).join()!=='gain')throw new Error('own keys');
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
            "filter-result-storage/json-identities",
            result.cpp,
        );
    });
});

test("filter narrows optional union elements before storing the array", async (t) => {
    const source = `
        interface Row { ids:number[]; }
        function make():Row[] {
            const values:Array<number|'missing'|null>=[1,'missing',null,2];
            const ids=values.filter((value):value is number=>typeof value==='number');
            const rows:Row[]=[];
            rows.push({ids});
            ids.push(3);
            if(rows[0]!.ids!==ids || rows[0]!.ids.join()!=='1,2,3')throw new Error('array identity');
            return rows;
        }
        const kept:Array<typeof make>=[make];
        if(kept[0]!()[0]!.ids.length!==3)throw new Error('stored callback');
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
            "filter-result-storage/optional-union",
            result.cpp,
        );
    });
});
