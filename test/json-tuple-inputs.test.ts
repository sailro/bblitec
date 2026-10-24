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

test("JSON callback results retain one source record identity", async (t) => {
    const source = `
        function read(callback:()=>unknown):unknown { return callback(); }
        const record={value:1};
        const alias=record;
        let effects=0;
        const first=read(()=>{effects++;return record;});
        const second=read(()=>{effects++;return alias;});
        if(first!==second||effects!==2)throw new Error('retained identity');
        alias.value=2;
        if(JSON.stringify([first,second])!=='[{"value":2},{"value":2}]')throw new Error('retained mutation');
        const other=read(()=>({value:2}));
        if(other===first)throw new Error('distinct owner');
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
            "json-tuple-inputs/callback-record-identity",
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

test("JSON number arrays build and fill typed arrays element by element", (t) => {
    const source = `
        interface Mesh { positions: number[]; indices: number[]; colors?: number[] }
        const mesh = JSON.parse('{"positions":[0.5,1,2.25],"indices":[0,1,4294967297]}') as Mesh;
        const positions = new Float32Array(mesh.positions);
        const indices = new Uint32Array(mesh.indices);
        const target = new Float32Array(4);
        target.set(mesh.positions, 1);
        if (positions.length !== 3 || positions[2] !== 2.25) throw new Error('positions');
        if (indices.length !== 3 || indices[2] !== 1) throw new Error('indices');
        if (target[0] !== 0 || target[3] !== 2.25) throw new Error('set');
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
    assert.match(
        result.cpp,
        /bbl::js::f32_array_from\(bbl::js::json_number_array\(v_mesh\.read_property\("positions"\)\)\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::u32_array_from\(bbl::js::json_number_array\(v_mesh\.read_property\("indices"\)\)\)/,
    );
    assert.doesNotMatch(result.cpp, /_array_sized\([^;]*read_property/);
    assert.throws(
        () =>
            compileSource(
                `const like = { length: 2 } as ArrayLike<number>; console.log(new Float32Array(like).length);`,
            ),
        /new Float32Array expects a length or a numeric sequence/,
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "json-tuple-inputs/typed-arrays", result.cpp);
});
