import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("numeric tuple spreads copy guarded document fields in evaluation order", async (t) => {
    const source = `
        interface Fields { tint?: [number, number, number] }
        function copy(record: Readonly<Fields>): Fields {
            return { ...(record.tint ? { tint: [...record.tint] as [number, number, number] } : {}) };
        }
        const copyFunctions: Array<typeof copy> = [copy];
        const input = JSON.parse('{"tint":[1,2,3]}') as Fields;
        const copied = copyFunctions[0]!(input);
        input.tint![0] = 9;
        if (copied.tint![0] !== 1 || copied.tint === input.tint) throw new Error('fresh copy');
        if (copyFunctions[0]!({}).tint !== undefined) throw new Error('absent field');

        let effects = 0;
        const tuple = JSON.parse('[4,5]') as [number, number];
        function read(): [number, number] { effects++; return tuple; }
        function update(): number { effects++; tuple[0] = 8; return 6; }
        const mixed: [number, number, number] = [...read(), update()];
        if (mixed[0] !== 4 || mixed[1] !== 5 || mixed[2] !== 6 || effects !== 2) throw new Error('ordered lanes');
        function add(left: number, right: number): number { return left + right; }
        if (add(...tuple) !== 13) throw new Error('call lanes');
        const callTuple: [number, number] = [2, 3];
        function sum3(a: number, b: number, c: number): number { return a + b + c; }
        function later(): number { callTuple[0] = 9; return 4; }
        if (sum3(...callTuple, later()) !== 9) throw new Error('call argument order');
        const typed = new Float32Array([...tuple, 7]);
        if (typed[0] !== 8 || typed[2] !== 7) throw new Error('typed array lanes');
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
            "tuple-spread-boundaries/document",
            result.cpp,
        );
    });
});

test("existing numeric color assignment normalizes tuple spreads before arity checking", () => {
    const source = (channels: string) => `
        import { createEngine, createSceneContext, createStandardMaterial, createBox, addToScene } from '@babylonjs/lite';
        async function main(): Promise<void> {
            const engine = await createEngine(document.getElementById('canvas') as HTMLCanvasElement);
            const scene = createSceneContext(engine);
            const material = createStandardMaterial();
            const colors: { full: [number, number, number]; pair: [number, number] } = { full: [1, 0, 0], pair: [1, 0] };
            material.diffuseColor = ${channels};
            const box = createBox(engine);
            box.material = material;
            addToScene(scene, box);
        }
    `;
    for (const channels of [
        "[...colors.full]",
        "[...colors.pair, 0]",
        "[1, ...colors.pair]",
    ])
        assert.match(
            compileSource(source(channels)).cpp,
            /set_material_diffuse_color\(/,
        );
    assert.throws(
        () => compileSource(source("[...colors.pair, ...colors.pair]")),
        /three-channel numeric array/,
    );
});

test("document tuple spreads refuse an unrepresented runtime length", async (t) => {
    const result = compileSource(`
        const source = JSON.parse('[1,2,3,4]') as [number, number, number];
        let refused = false;
        try { const copied: [number, number, number] = [...source]; console.log(copied[0]); }
        catch { refused = true; }
        if (!refused) throw new Error('unsupported tuple length');
    `);
    const native = optionalNativeFixtureTools(false);
    await t.test("native refusal", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "tuple-spread-boundaries/length",
            result.cpp,
        );
    });
});
