import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

function check(name: string, source: string): void {
    test(name, async t => {
        runInNewContext(ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
        }).outputText);
        const result = compileSource(source, { fileName: `${name}.ts` });
        await t.test("generated C++ executes the same assertions", { skip: !native }, () => {
            const directory = resolve("artifacts/core-library", name);
            mkdirSync(directory, { recursive: true });
            const cpp = join(directory, "check.cpp");
            const exe = join(directory, "check.exe");
            writeFileSync(cpp, result.cpp);
            runNativeFixtureCompiler(native!, [
                "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/fp:precise", "/utf-8",
                "/I", "native/include", `/Fo:${directory}/`, `/Fe:${exe}`, cpp,
            ]);
            execFileSync(exe, { stdio: "pipe" });
        });
    });
}

check("math-and-number", `
    function verify(x: number): void {
        if (Math.abs(Math.acos(x) - 1.0471975511965979) > 1e-14) throw new Error("acos");
        if (Math.abs(Math.asin(x) - 0.5235987755982989) > 1e-14) throw new Error("asin");
        if (Math.abs(Math.log(x) + 0.6931471805599453) > 1e-14) throw new Error("log");
        if (Math.log2(x) !== -1 || Math.cbrt(-8 * x) >= 0) throw new Error("log2/cbrt");
        if (Math.abs(Math.sinh(x) - 0.5210953054937474) > 1e-14) throw new Error("sinh");
        if (Math.fround(x + 0.1) !== 0.6000000238418579) throw new Error("fround");
        if (Math.clz32(x) !== 32 || Math.clz32(-1 / x) !== 0) throw new Error("clz32");
        if (!Number.isInteger(1 / x) || Number.isInteger(x)) throw new Error("integer");
        if (!Number.isSafeInteger(Number.MAX_SAFE_INTEGER) || Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1)) throw new Error("safe integer");
        if (!Number.isNaN(Math.acos(4 * x)) || Number.isNaN(x)) throw new Error("NaN");
        if (Number.isInteger(Infinity) || Number.isSafeInteger(NaN)) throw new Error("nonfinite");
        if (Number.EPSILON !== 2.220446049250313e-16) throw new Error("epsilon");
        if (Number.isFinite("2") || Number.isNaN("x") || Number.isInteger(true)) throw new Error("no coercion");
    }
    verify(0.5);
    function boundary(x: number): void {
        if (1 / Math.fround(x) !== -Infinity) throw new Error("signed zero");
        if (Math.clz32(Infinity) !== 32 || Math.clz32(4294967297) !== 31) throw new Error("uint32");
        if (Math.fround(3.4028235677973366e38) !== Infinity) throw new Error("overflow");
    }
    boundary(-0);
    function optional(x: number | undefined): void {
        if (Number.isInteger(x) !== (x !== undefined)) throw new Error("optional predicate");
    }
    optional(2);
    optional(undefined);
`);

check("array-values", `
    function verify(xs: number[]): void {
        if (xs.at(-1) !== 3 || xs.at(-4) !== 1 || xs.at(4) !== undefined) throw new Error("at");
        if (xs.at(NaN) !== 1 || xs.at(-Infinity) !== undefined) throw new Error("at bounds");
        if (xs.lastIndexOf(2) !== 2 || xs.lastIndexOf(2, -3) !== 1 || xs.lastIndexOf(NaN) !== -1) throw new Error("lastIndexOf");
        const ys = xs.concat([4, 5], 6);
        if (ys.join("|") !== "1|2|2|3|4|5|6" || xs.length !== 4) throw new Error("concat");
        ys[0] = 9;
        if (xs[0] !== 1) throw new Error("concat identity");
        const same = xs.copyWithin(1, 0, 3);
        if (same !== xs || xs.join() !== "1,1,2,2") throw new Error("copyWithin overlap");
        if (xs.fill(8, -2) !== xs || xs.join() !== "1,1,8,8") throw new Error("fill");
        const removed = xs.splice(-3, 2, 5, 6, 7);
        if (removed.join() !== "1,8" || xs.join() !== "1,5,6,7,8") throw new Error("splice");
        if (xs.splice(99, 1).length !== 0 || xs.splice().length !== 0) throw new Error("empty splice");
        if (xs.splice(3).join() !== "7,8" || xs.length !== 3) throw new Error("splice tail");
    }
    const input: number[] = [1, 2, 2, 3];
    verify(input);
`);

test("library globals respect local bindings", () => {
    assert.doesNotThrow(() => compileSource(`
        const Number = { isInteger: (value: number) => value > 10, EPSILON: 2 };
        if (Number.isInteger(Number.EPSILON)) throw new Error("shadow");
    `));
});

check("string-values", `
    function verify(s: string): void {
        if (s.replace("a", "z") !== "zbaba" || s.replaceAll("a", "z") !== "zbzbz") throw new Error("replace");
        if (s.replaceAll("", "-") !== "-a-b-a-b-a-") throw new Error("empty pattern");
        if (s.replace("missing", "!") !== s) throw new Error("missing pattern");
        if (s.replace("b", "$$-$&-$1") !== "a$-b-$1aba") throw new Error("substitution");
        if (s.substring(4, 1) !== "bab" || s.substring(-1, 2) !== "ab") throw new Error("substring");
        if (s.substring(NaN, Infinity) !== s || s.substring(99) !== "") throw new Error("substring bounds");
        if (s.repeat(2.9) !== "ababaababa" || s.repeat(NaN) !== "") throw new Error("repeat");
        if (s.concat("-", "end") !== "ababa-end") throw new Error("concat");
        if (s.at(-1) !== "a" || s.at(5) !== undefined || s.at(-99) !== undefined) throw new Error("at");
        if (s.codePointAt(0) !== 97 || s.codePointAt(-1) !== undefined) throw new Error("codePointAt");
        let caught = false;
        try { s.repeat(-1); } catch { caught = true; }
        if (!caught) throw new Error("repeat range");
    }
    verify("ababa");
    function unicode(s: string): void {
        if (s.length !== 4 || (s.at(-1) ?? "").length !== 1 || (s.at(1) ?? "").length !== 1) throw new Error("UTF16 length");
        if (s.substring(1, 3) !== "😀" || s.substring(3) !== "é") throw new Error("UTF16 substring");
        if (s.codePointAt(1) !== 128512 || s.codePointAt(2) !== 56832 || s.at(-1) !== "é") throw new Error("UTF16 index");
        if (s.replaceAll("😀", "é") !== "aéé") throw new Error("unicode replacement");
    }
    unicode("a😀é");
    function surrogates(s: string): void {
        const high = s.at(0) ?? "";
        const low = s.at(1) ?? "";
        if (high.codePointAt(0) !== 55357 || low.codePointAt(0) !== 56832) throw new Error("lone surrogates");
        if ((high + low).codePointAt(0) !== 128512) throw new Error("paired WTF8");
        const units: string[] = [high, low];
        if (high + low !== s || high.concat(low) !== s || units.join("") !== s) throw new Error("surrogate concatenation");
        if (s.at(Infinity) !== undefined || s.codePointAt(NaN) !== 128512) throw new Error("index coercion");
        if (String.fromCharCode(55357, 56832) !== s || String.fromCharCode(233).codePointAt(0) !== 233) throw new Error("constructed Unicode");
    }
    surrogates("😀");
`);

check("collections-and-array-factories", `
    const map = new Map<string, number>([["a", 1], ["b", 2], ["a", 3]]);
    if (map.size !== 2 || map.get("a") !== 3) throw new Error("map initialization");
    const seen: string[] = [];
    map.forEach((value, key, owner) => {
        seen.push(key + value);
        if (key === "a") { owner.delete("b"); owner.set("c", 4); }
    });
    if (seen.join() !== "a3,c4") throw new Error("map callbacks");
    const copy = new Map(map);
    copy.set("a", 99);
    if (map.get("a") !== 3) throw new Error("map copy identity");
    const set = new Set<number>([2, 1, 2]);
    const values: number[] = [];
    set.forEach((value, key, owner) => {
        if (value !== key || owner !== set) throw new Error("set arguments");
        values.push(value);
        if (value === 2) owner.add(3);
    });
    if (values.join() !== "2,1,3" || Array.from(set).join() !== "2,1,3") throw new Error("set order");
    const sequence = Array.from({ length: 3.9 }, (_, index) => index * 2);
    if (sequence.join() !== "0,2,4") throw new Error("arraylike callback index");
    if (Array.from({ length: -2 }, (_, index) => index).length !== 0) throw new Error("ToLength");
    if (Array.of(4, 5).join() !== "4,5") throw new Error("Array.of");
    const clone = Array.from(values);
    clone[0] = 99;
    if (values[0] !== 2) throw new Error("Array.from identity");
    const object = { value: 1 };
    const objects = new Map<string, { value: number }>([["a", object]]);
    objects.forEach(value => { value.value += 1; });
    if (object.value !== 2) throw new Error("Map retains object identity");
`);

check("flat-map", `
    const input: number[] = [1, 2, 3];
    const result = input.flatMap((value, index, source) => {
        if (index === 0) source.push(4);
        return [value, index];
    });
    if (result.join() !== "1,0,2,1,3,2" || input.length !== 4) throw new Error("flatMap order and length");
    const scalars = input.flatMap(value => value * 2);
    if (scalars.join() !== "2,4,6,8") throw new Error("flatMap scalars");
    const shrunk = input.flatMap((value, index, source) => {
        if (index === 0) source.splice(1);
        return [value];
    });
    if (shrunk.join() !== "1") throw new Error("flatMap deleted elements");
    const overwritten: number[] = [1, 2];
    const oldValues = overwritten.flatMap((value, index, source) => {
        source[index] = 99;
        return [value];
    });
    if (oldValues.join() !== "1,2") throw new Error("flatMap value snapshot");
`);

check("library-evaluation-order", `
    let calls = 0;
    function next(): number { calls += 1; return calls; }
    const ordered = Array.of(next(), next());
    if (ordered.join() !== "1,2" || calls !== 2) throw new Error("argument order");
    let text = "abc";
    function search(): string { text = "xyz"; return "b"; }
    const replaced = text.replace(search(), "!");
    if (replaced !== "a!c" || text !== "xyz") throw new Error("string receiver snapshot");
    const original: number[] = [1, 2];
    let current = original;
    function change(): number { current = [9]; return 0; }
    const removed = current.splice(change(), 1);
    if (removed.join() !== "1" || original.join() !== "2" || current.join() !== "9") throw new Error("array receiver snapshot");
    function nonnumeric(): string { calls += 1; return "123"; }
    if (Number.isInteger(nonnumeric()) || calls !== 3) throw new Error("predicate effects");
    if (Number.isInteger({ value: next() }) || calls !== 4) throw new Error("record predicate effects");
    const object = { value: 1 };
    const objects = Array.of(object);
    const selected = objects.at(0);
    if (selected) selected.value = 2;
    if (object.value !== 2 || objects.lastIndexOf(object) !== 0) throw new Error("object identity");
    const retained = objects.splice(0, 1);
    retained[0].value = 3;
    if (object.value !== 3 || objects.length !== 0) throw new Error("removed object identity");
`);

test("unsupported library overloads refuse explicitly", () => {
    for (const [source, message] of [
        ["const xs: number[] = []; xs.at(1, 2);", /Array.at expects/],
        ["const xs = new Map<string, number>([42]);", /key\/value pairs/],
        ["const xs = new Set<number>(); xs.forEach(() => {}, {});", /no thisArg/],
        ['"x".replaceAll(/x/g, "y");', /requires a string pattern/],
        ["Array.from({ length: 2, 0: 9 }, (_, i) => i);", /additional properties/],
    ] as const) assert.throws(() => compileSource(source), message);
});
