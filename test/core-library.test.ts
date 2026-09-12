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

check("regexp-replacement-callbacks", `
    function edit(text:string):string {
        return text.replace(/([a-z]+)([0-9]+)/g, (match:string, word:string, digits:string, offset:number, original:string) => {
            if(original !== text || match !== word+digits) throw new Error('callback arguments');
            return word.toUpperCase() + (Number(digits)+offset);
        });
    }
    if(edit('ab12 cd3') !== 'AB12 CD8') throw new Error('global captures');
    let seen = '';
    const optional = 'a b'.replace(/(a)|(b)/g, (match, first, second, offset) => {
        seen += (first === undefined ? '-' : first) + (second === undefined ? '-' : second) + offset;
        return match;
    });
    if(optional !== 'a b' || seen !== 'a-0-b2') throw new Error('unmatched capture');
    if('word'.replace(/(word)/, (_match, word) => word.toUpperCase()) !== 'WORD') throw new Error('inferred capture method');
    const pattern = /a/g;
    const alias = pattern;
    pattern.lastIndex = 20;
    let calls = 0;
    const replaced = 'aa'.replace(pattern, (match:string, offset:number) => {
        if(calls === 0 && pattern.lastIndex !== 0) throw new Error('global initial state');
        calls++;
        alias.lastIndex = 7;
        return match.toUpperCase() + offset;
    });
    if(replaced !== 'A0A1' || calls !== 2 || pattern.lastIndex !== 7) throw new Error('snapshot matches and shared regex state');
    const first = /a/;
    first.lastIndex = 3;
    if('aa'.replace(first, () => '!') !== '!a' || first.lastIndex !== 3) throw new Error('non-global state');
    let unicode = '';
    const text = 'é😀x';
    const unchanged = text.replace(/./g, (match:string, offset:number) => { unicode += offset; return match; });
    if(unchanged !== text || unicode !== '0123') throw new Error('UTF16 units and offsets');
    if('ab'.replace(/(?:)/g, (_match:string, offset:number) => String(offset)) !== '0a1b2') throw new Error('empty match progress');
    if('aaa'.replace(/^a/g, () => '!') !== '!aa') throw new Error('anchored global search');
    if('ab ab'.replace(/\\ba/g, () => '!') !== '!b !b') throw new Error('word boundaries');
    if('aba'.replaceAll(/a/g, () => '!') !== '!b!') throw new Error('global replaceAll');
    function runtime(source:string):string {
        const regex = new RegExp(source, 'g');
        return 'a2 b3'.replace(regex, (match:string, word:string|undefined, digits:string|undefined, offset:number) =>
            (word ?? '') + (digits ?? '') + offset);
    }
    const patterns:string[] = ['([a-z])([0-9])'];
    for(const source of patterns) if(runtime(source) !== 'a20 b33') throw new Error('runtime regex arguments');
    const choices:boolean[] = [false,true];
    for(const captured of choices) {
        const selected = captured ? /(a)/g : /a/g;
        const result = 'a'.replace(selected, (match:string, second:string|number|undefined, third:string|number|undefined) => {
            if(captured) {
                if(second !== 'a' || third !== 0) throw new Error('selected capture positions');
            } else if(second !== 0 || third !== 'a') throw new Error('selected offset positions');
            return match;
        });
        if(result !== 'a') throw new Error('selected regex');
    }
    const callbacks:((match:string, capture:string|undefined, offset:number, source:string)=>string)[] = [];
    callbacks.push((match, capture, offset, source) => {
            callbacks.pop();
            callbacks.push(() => 'changed');
            if(source !== 'b ab') throw new Error('stored callback input');
            return (capture ?? '-') + offset;
        });
    if('b ab'.replace(/(a)?b/g, callbacks[0]) !== '-0 a2') throw new Error('stored callback snapshot');
    const retained:(()=>string)[] = [];
    const literals = 'b ab'.replace(/(a)?b/g, (match:string, capture:string|undefined) => {
        retained.push(() => capture ?? 'missing');
        return '$&';
    });
    if(literals !== '$& $&' || retained[0]() !== 'missing' || retained[1]() !== 'a') throw new Error('owned captures and literal results');
    let missingCalls = 0;
    const missing = /z/g;
    missing.lastIndex = 7;
    if('abc'.replace(missing, () => { missingCalls++; return ''; }) !== 'abc' || missingCalls !== 0 || missing.lastIndex !== 0)
        throw new Error('missing global match');
    let rejected = false;
    try { 'a'.replaceAll(/a/, () => { missingCalls++; return ''; }); } catch { rejected = true; }
    if(!rejected || missingCalls !== 0) throw new Error('replaceAll global requirement');
    const empty = /(?:)/g;
    const emptyResult = '😀'.replace(empty, (_match:string, offset:number) => String(offset));
    if(emptyResult.length !== 5 || emptyResult.charCodeAt(1) !== 0xd83d || emptyResult.charCodeAt(3) !== 0xde00)
        throw new Error('empty match advances one UTF16 unit');
    if(text.charCodeAt(0) !== 233 || text.charCodeAt(NaN) !== 233 || text.charCodeAt(1.9) !== 0xd83d ||
        !Number.isNaN(text.charCodeAt(-1)) || !Number.isNaN(text.charCodeAt(Infinity)) || !Number.isNaN(text.charCodeAt(4)))
        throw new Error('UTF16 character codes and bounds');
    const shared = /./g;
    const sharedAlias = shared;
    if(!shared.test('😀') || sharedAlias.lastIndex !== 1 || !sharedAlias.test('😀') || shared.lastIndex !== 2 || shared.test('😀'))
        throw new Error('exec shares UTF16 state');
`);

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
