import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("optional numeric collection keys preserve absence, NaN equality and positive stored zero", () => {
    const source = `
        const map = new Map<number | undefined, string>();
        map.set(undefined, 'absent'); map.set(-0, 'zero'); map.set(NaN, 'first'); map.set(NaN, 'nan');
        if (map.size !== 3 || map.get(undefined) !== 'absent' || map.get(0) !== 'zero' || map.get(NaN) !== 'nan') throw new Error('map key equality');
        for (const key of map.keys()) if (key !== undefined && key === 0 && 1 / key !== Infinity) throw new Error('stored negative zero');
        if (!map.delete(NaN) || map.has(NaN) || !map.has(undefined)) throw new Error('map deletion');
        const set = new Set<number | undefined>();
        set.add(undefined); set.add(-0); set.add(0); set.add(NaN); set.add(NaN);
        if (set.size !== 3 || !set.has(undefined) || !set.has(0) || !set.has(NaN)) throw new Error('set key equality');
        for (const key of set) if (key !== undefined && key === 0 && 1 / key !== Infinity) throw new Error('stored set zero');
    `;
    runInNewContext(ts.transpile(source));
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "nullable-map-keys", result.cpp, {
        expectedOutput: "",
        timeoutMs: 10000,
    });
});
