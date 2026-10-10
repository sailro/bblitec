import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("nested readonly array defaults retain outer and inner owners", async (t) => {
    const source = `
        function keep(rows: readonly (readonly number[])[] = []): readonly (readonly number[])[] {
            return rows;
        }
        function run(): void {
            const empty: readonly (readonly number[])[] = [];
            if (keep(empty) !== empty) throw new Error('empty owner');
            const row = [1, 2];
            const rows = [row];
            const options: { rows?: readonly (readonly number[])[] } = { rows };
            const kept = keep(options.rows ?? []);
            if (kept !== rows || kept[0] !== row) throw new Error('nested owners');
            row[0] = 7;
            row.push(9);
            if (kept[0]![0] !== 7 || kept[0]!.length !== 3) throw new Error('inner alias mutation');
            const next = [11];
            rows.push(next);
            if (kept.length !== 2 || kept[1] !== next) throw new Error('outer alias mutation');
            const read = () => kept[0]![0];
            row[0] = 13;
            if (read() !== 13 || keep(kept) !== kept) throw new Error('retained alias');
            const firstDefault = keep();
            const secondDefault = keep();
            if (firstDefault === secondDefault || firstDefault.length !== 0) throw new Error('fresh defaults');
        }
        run();
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
            "nested-array-owners/retained",
            result.cpp,
        );
    });
});

test("nested array ownership does not turn a borrowed view into a JavaScript array", () => {
    assert.throws(
        () =>
            compileSource(`
        function keep(rows: readonly (readonly number[])[]): readonly (readonly number[])[] { return rows; }
        const view: ArrayLike<number> = new Float32Array([1, 2]);
        const row = view as readonly number[];
        const rows = [row];
        const kept = keep(rows);
        if (kept[0] !== row) throw new Error('owner');
    `),
        /borrowed array view|does not match the expected data|typed-array/,
    );
});
