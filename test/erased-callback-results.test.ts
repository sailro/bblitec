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
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `erased-callback-results/${name}`,
            result.cpp,
        );
    });
}

check(
    "erased-same-value",
    `
    function same(a: unknown, b: unknown): boolean { return Object.is(a, b); }
    const callbacks: Array<typeof same> = [same];
    const values: unknown[] = JSON.parse('[0,-0,0,null,null,"0",false]');
    values[0] = NaN;
    values[4] = undefined;
    for (let i = 0; i < values.length; ++i) {
        if (!callbacks[0]!(values[i], values[i])) throw new Error('reflexive');
        for (let j = i + 1; j < values.length; ++j)
            if (callbacks[0]!(values[i], values[j])) throw new Error('distinct ' + i + ':' + j);
    }
    const parsed: unknown = JSON.parse('{"value":1}');
    const other: unknown = JSON.parse('{"value":1}');
    if (!callbacks[0]!(parsed, parsed) || callbacks[0]!(parsed, other)) throw new Error('identity');
    function spelling(value: unknown): string {
        if (typeof value === 'number') return Object.is(value, -0) ? 'minus' : 'number';
        return 'other';
    }
    const spellings: Array<typeof spelling> = [spelling];
    if (spellings[0]!(values[1]) !== 'minus' || spellings[0]!(values[2]) !== 'number' ||
        spellings[0]!(values[5]) !== 'other') throw new Error('narrowed');
`,
);

check(
    "same-value-argument-order",
    `
    let number = 1;
    function next(): number { number += 1; return number; }
    if (Object.is(number, next()) || number !== 2) throw new Error('number snapshot');
    let text = 'before';
    function replace(): string { text = 'after'; return text; }
    if (Object.is(text, replace()) || text !== 'after') throw new Error('string snapshot');
    const values: unknown[] = [1];
    function replaceErased(): unknown { values[0] = 2; return values[0]; }
    if (Object.is(values[0], replaceErased()) || values[0] !== 2) throw new Error('erased snapshot');
    let trace = '';
    function operand(label: string): unknown { trace += label; return NaN; }
    if (!Object.is(operand('left'), operand('right')) || trace !== 'leftright') throw new Error('order');
`,
);

check(
    "json-parser-preserves-signed-zero-tokens",
    `
    const negative = ['-0', '-0.0', '-0e0', '-0E+3', '-0e-3'];
    for (const token of negative) {
        if (!Object.is(JSON.parse(token), -0) || Object.is(JSON.parse(token), 0)) throw new Error('negative zero');
    }
    const positive = ['0', '0.0', '0e0', '0E+3', '0e-3'];
    for (const token of positive) {
        if (!Object.is(JSON.parse(token), 0) || Object.is(JSON.parse(token), -0)) throw new Error('positive zero');
    }
    const nested = JSON.parse('{"-0":0,"quoted":"-0","value":-0,"array":[-1,-0,0,1]}');
    if (!Object.is(nested.value, -0) || !Object.is(nested['-0'], 0) || nested.quoted !== '-0' ||
        nested.array[0] !== -1 || !Object.is(nested.array[1], -0) || !Object.is(nested.array[2], 0) ||
        nested.array[3] !== 1) throw new Error('nested zeros');
    const revived = JSON.parse('[-0,0]', (key, value) => value);
    if (!Object.is(revived[0], -0) || !Object.is(revived[1], 0)) throw new Error('reviver zeros');
    let failures = 0;
    for (const token of ['-00', '[-0,]', '{"value":-0e}']) {
        try { JSON.parse(token); } catch { failures += 1; }
    }
    if (failures !== 3) throw new Error('number grammar');
`,
);

check(
    "erased-map-record-and-tuple-results",
    `
    interface Entry { id: string; weight: number; }
    function records(input: readonly Entry[]) {
        if (!Array.isArray(input)) throw new Error('array');
        return input.map((entry, index) => ({id: entry.id, index, nested: {weight: entry.weight}}));
    }
    function pairs(input: readonly Entry[]) {
        if (!Array.isArray(input)) throw new Error('array');
        return input.map((entry, index) => [entry.id, index] as const);
    }
    const input: Entry[] = [];
    input.push({id: 'one', weight: 3}, {id: 'two', weight: 4});
    const mapped = records(input);
    const paired = pairs(input);
    if (mapped[1]!.id !== 'two' || mapped[0]!.nested.weight !== 3 || mapped[1]!.index !== 1 ||
        paired[0]![0] !== 'one' || paired[1]![1] !== 1) throw new Error('results');
`,
);

check(
    "erased-flat-map-record-results",
    `
    interface Entry { id: string; }
    function collect(input: readonly Entry[]) {
        if (!Array.isArray(input)) throw new Error('array');
        return input.flatMap((entry, index) => [{id: entry.id, index}]);
    }
    const input: Entry[] = [];
    input.push({id: 'one'}, {id: 'two'});
    const result = collect(input);
    if (result.length !== 2 || result[0]!.id !== 'one' || result[1]!.index !== 1) throw new Error('flat');
    function keys(input: readonly Entry[]) {
        if (!Array.isArray(input)) throw new Error('array');
        return input.flatMap(entry => entry.id);
    }
    if (keys(input).join() !== 'one,two') throw new Error('scalar flatMap');
`,
);

check(
    "flat-map-stored-product-results",
    `
    function pair(value: string): readonly [string, string] { return [value, value]; }
    const callbacks: Array<typeof pair> = [pair];
    const input: string[] = [];
    input.push('one', 'two');
    const result = input.flatMap(value => callbacks[0]!(value));
    if (result.join() !== 'one,one,two,two') throw new Error('product flatten');
`,
);

check(
    "erased-flat-map-flattens-one-array-level",
    `
    const source: unknown = JSON.parse('[[1,2],3,[],[4,[5]]]');
    if (!Array.isArray(source)) throw new Error('array');
    let calls = 0;
    const result = source.flatMap(entry => { calls += 1; return entry; });
    if (calls !== 4 || JSON.stringify(result) !== '[1,2,3,4,[5]]') throw new Error('flatten');
    const objects: unknown = JSON.parse('[[{"x":1}]]');
    if (!Array.isArray(objects)) throw new Error('array');
    const flat = objects.flatMap(entry => entry);
    if (flat[0] !== objects[0][0]) throw new Error('flattened identity');
`,
);

test("erased callback record inference refuses methods and conditional own keys", () => {
    for (const result of [
        `({id: entry.id, read() { return entry.id; }})`,
        `({nested: {id: entry.id, read() { return entry.id; }}})`,
        `({id: entry.id, ...(index ? {extra: 1} : {})})`,
    ])
        assert.throws(
            () =>
                compileSource(`
        interface Entry { id: string; }
        function collect(input: readonly Entry[]) {
            if (!Array.isArray(input)) throw new Error('array');
            return input.map((entry, index) => ${result});
        }
        const input: Entry[] = [];
        input.push({id: 'one'}, {id: 'two'});
        const values = collect(input);
        if (values.length !== 2) throw new Error('length');
    `),
            /callback results must belong to the native data model/,
        );
});
