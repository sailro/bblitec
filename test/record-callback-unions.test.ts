import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const { cpp } = compileSource(source);
        assert.match(cpp, /bbl::js::Callback<double\(\)>/);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(tools, `record-callback-unions/${name}`, cpp);
    });
}

check(
    "common-record-callback-fields-retain-identity-and-captures",
    `
    let value = 1;
    const first = {key: 'a', read: () => value};
    const second = {key: 'b', read: () => value + 1};
    const rows = [first, second] as const;
    const callbacks: Array<() => number> = [];
    for (const row of rows) {
        if(row.read !== row.read) throw new Error('unstable callback');
        callbacks.push(row.read);
    }
    if(callbacks[0] !== first.read || callbacks[1] !== second.read || callbacks[0] === callbacks[1])
        throw new Error('callback identity');
    value = 4;
    if(callbacks[0]!() !== 4 || callbacks[1]!() !== 5) throw new Error('live captures');
`,
);

check(
    "tagged-record-callback-fields-share-retained-layouts",
    `
    let value = 2;
    const first = {kind: 'left' as const, read: () => value, left: 3};
    const second = {kind: 'right' as const, read: () => value + 1, right: 'r'};
    const rows = [first, second] as const;
    const callbacks: Array<() => number> = [];
    let tags = '';
    for (const row of rows) {
        tags += row.kind === 'left' ? String(row.left) : row.right;
        callbacks.push(row.read);
    }
    value = 6;
    if(tags !== '3r' || callbacks[0]!() !== 6 || callbacks[1]!() !== 7)
        throw new Error('tagged callbacks');
    if(callbacks[0] !== first.read || callbacks[1] !== second.read)
        throw new Error('tagged callback identity');
`,
);

check(
    "record-callback-presence-follows-the-declaring-arm",
    `
    let value = 5;
    const first = {label: 'a', read: () => value};
    const second = {label: 'b', extra: 'e'};
    const rows = [first, second] as const;
    const callbacks: Array<() => number> = [];
    let absent = 0;
    for (const row of rows) {
        if('read' in row) callbacks.push(row.read);
        else absent++;
    }
    value = 8;
    if(absent !== 1 || callbacks.length !== 1 || callbacks[0] !== first.read || callbacks[0]!() !== 8)
        throw new Error('callback presence');
`,
);
