import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("WeakMap retains lexical callback identity through aliases and inlined parameters", async (t) => {
    const source = `
        const values = new WeakMap<object, number>();
        let state = 3;
        const first = () => state;
        const alias = first;
        function remember(callback: () => number, value: number): void {
            values.set(callback, value);
        }
        remember(first, 7);
        if (values.get(alias) !== 7) throw new Error("lexical callback alias");
        state = 9;
        if (first() !== 9) throw new Error("callback capture");
        function make(value: number): () => number { return () => value; }
        const left = make(1), right = make(2);
        remember(left, 11);
        remember(right, 12);
        if (values.get(left) !== 11 || values.get(right) !== 12)
            throw new Error("separate function evaluations");
        if (left() !== 1 || right() !== 2) throw new Error("separate captures");
        if (!values.delete(alias) || values.has(first)) throw new Error("delete alias");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
    );
    const compiled = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(native!, "weak-lexical-callbacks", compiled.cpp);
    });
});
