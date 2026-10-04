import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const cases = {
    "reverse-fresh-owned-array": `
        const reverse: Array<(values: readonly number[]) => number[]> = [
            values => [...values].reverse(),
        ];
        const input = [2, 5, 9];
        const result = reverse[0]!(input);
        if (result === input || result.join(',') !== '9,5,2' || input.join(',') !== '2,5,9')
            throw new Error('fresh reverse ownership');
        const alias = result.reverse();
        alias.push(12);
        if (alias !== result || result.join(',') !== '2,5,9,12') throw new Error('reverse identity');
    `,
    "read-temporary-byte-view": `
        interface Source { get bytes(): Uint8Array; }
        const read: Array<(source: Source, index: number) => number> = [
            (source, index) => source.bytes[index]!,
        ];
        const bytes = new Uint8Array([7, 11, 19]);
        let calls = 0;
        const source: Source = {get bytes() { ++calls; return bytes; }};
        if (read[0]!(source, 1) !== 11 || calls !== 1) throw new Error('getter read');
        bytes[1] = 23;
        if (read[0]!(source, 1) !== 23 || calls !== 2) throw new Error('live view');
    `,
};

for (const [name, source] of Object.entries(cases))
    test(name, () => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        assert.ok(tools);
        runGeneratedProgram(
            tools,
            `temporary-array-receivers/${name}`,
            result.cpp,
            {
                expectedOutput: "",
                timeoutMs: 10000,
            },
        );
    });
