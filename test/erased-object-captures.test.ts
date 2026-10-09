import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("erased object captures retain their lexical state and reseated identity", async (t) => {
    const source = `
        function run(): void {
            const readers: Array<() => boolean> = [];
            readers.push(() => token === expected);
            let refused = 0;
            try { readers[0]!(); } catch { refused++; }
            let token: object | null = null;
            let expected: object | null = null;
            if (refused !== 1 || !readers[0]!()) throw new Error('temporal dead zone/null');
            const first = {};
            token = first;
            if (readers[0]!()) throw new Error('null versus object');
            expected = first;
            if (!readers[0]!()) throw new Error('captured identity');
            token = {};
            if (readers[0]!()) throw new Error('fresh object identity');
            expected = token;
            if (!readers[0]!()) throw new Error('rebound alias');
            token = null;
            if (readers[0]!()) throw new Error('cleared token');
        }
        run();
        let value: object | null = null;
        const first = {};
        value = first;
        if (value !== first) throw new Error('ordinary erased alias');
        value = {};
        if (value === first) throw new Error('ordinary reseat');
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
            "erased-object-captures/lexical",
            result.cpp,
        );
    });
});

test("erased object storage refuses a collection without a retained dynamic view", () => {
    assert.throws(
        () =>
            compileSource(`
        const readers: Array<() => boolean> = [];
        readers.push(() => value !== null);
        let value: object | null = null;
        value = new Map<string, number>([['first', 1]]);
        readers[0]!();
    `),
        /does not match the expected data json|cannot.*JSON|not.*JSON/,
    );
});
