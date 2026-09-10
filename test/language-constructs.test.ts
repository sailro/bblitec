import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

// The generic TypeScript user-code surface: every source below runs its own
// assertions in JavaScript first, then the generated C++ must build and run
// them identically.
const native = optionalNativeFixtureTools(false);

function check(name: string, source: string): void {
    test(name, async t => {
        runInNewContext(ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
        }).outputText);
        const result = compileSource(source, { fileName: `${name}.ts` });
        await t.test("generated C++ executes the same assertions", { skip: !native }, () => {
            const directory = resolve("artifacts/language-constructs", name);
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

check("logical-assignment", `
    function verify(seed: number | undefined, flag: number): number {
        let a = seed;
        a ??= 2;
        let b = flag;
        b ||= 3;
        b &&= b + 1;
        const r: { a?: number; b: number; s: string } = { b: 0, s: "" };
        r.a ??= 5;
        r.a ??= 9;
        r.b ||= 7;
        r.s ||= "x";
        const groups: Record<string, number[]> = {};
        (groups["k"] ??= []).push(1);
        (groups["k"] ??= []).push(2);
        const cache = new Map<string, number[]>();
        let bucket = cache.get("k");
        bucket ??= [];
        bucket.push(4);
        cache.set("k", bucket);
        const lanes: Array<number | undefined> = [undefined, 2];
        lanes[0] ??= 6;
        return a + b + (r.a ?? 0) + r.b + r.s.length + (groups["k"]?.length ?? 0) + (cache.get("k")?.length ?? 0) + (lanes[0] ?? 0);
    }
    if (verify(undefined, 0) !== 2 + 4 + 5 + 7 + 1 + 2 + 1 + 6) throw new Error("nullish and falsy stores");
    if (verify(1, 5) !== 1 + 6 + 5 + 7 + 1 + 2 + 1 + 6) throw new Error("present values keep their value");
`);

check("error-values", `
    function boom(kind: number): number {
        try {
            if (kind === 1) throw new RangeError("range");
            if (kind === 2) throw new TypeError("type");
            const held = new Error("held");
            if (kind === 3) throw held;
            if (kind === 4) throw new Error();
        } catch (e) {
            if (!(e instanceof Error)) throw new Error("caught value is an Error");
            return e.message.length;
        }
        return -1;
    }
    if (boom(1) !== 5 || boom(2) !== 4 || boom(3) !== 4 || boom(4) !== 0 || boom(5) !== -1) throw new Error("messages");
    const constructed = new RangeError("bad");
    if (constructed.message !== "bad" || constructed.name !== "RangeError") throw new Error("constructed error");
    let rethrown = 0;
    function inner(): void { try { throw new Error("x"); } catch (e) { throw e; } }
    try { inner(); } catch (e) { rethrown = (e as Error).message.length; }
    if (rethrown !== 1) throw new Error("rethrow");
`);

check("object-statics", `
    const TABLE = Object.freeze({ a: 1, b: 2 });
    const XS = Object.freeze([1, 2, 3]);
    if (TABLE.a + TABLE.b + XS.length + XS[2]! !== 9) throw new Error("freeze is the value");
    function dictionary(d: Record<string, number>): number {
        let total = 0;
        for (const [key, value] of Object.entries(d)) total += key.length * value;
        for (const value of Object.values(d)) total += value;
        return total + Object.keys(d).length + (Object.hasOwn(d, "bb") ? 10 : 0) + ("bb" in d ? 20 : 0);
    }
    if (dictionary({ a: 1, bb: 2 }) !== 1 + 4 + 3 + 2 + 10 + 20) throw new Error("dictionary statics");
    const merged = Object.assign({}, { a: 1, b: 2 }, { b: 3, c: 4 });
    if (merged.a + merged.b + merged.c !== 8) throw new Error("assign merges");
    const record = { a: 1, b: 2 };
    Object.assign(record, { b: 5 });
    if (record.b !== 5) throw new Error("assign into target");
    function same(a: number, b: number): number { return Object.is(a, b) ? 1 : 0; }
    if (same(NaN, NaN) !== 1 || same(0, -0) !== 0 || same(2, 2) !== 1) throw new Error("Object.is");
    const fromPairs = Object.fromEntries([["x", 1], ["y", 2]] as Array<[string, number]>);
    const source = new Map<string, number>([["z", 3]]);
    const fromMap = Object.fromEntries(source);
    if ((fromPairs["x"] ?? 0) + (fromPairs["y"] ?? 0) + (fromMap["z"] ?? 0) !== 6) throw new Error("fromEntries");
    if (Object.entries(record).length !== 2 || Object.entries(record)[1]![1] !== 5) throw new Error("record entries");
`);

check("iterators", `
    function walk(xs: number[]): number {
        let total = 0;
        for (const [index, value] of xs.entries()) total += index * value;
        for (const index of xs.keys()) total += index;
        for (const value of xs.values()) total += value;
        return total;
    }
    if (walk([2, 3]) !== 3 + 1 + 5) throw new Error("array iterators");
    const scaled: number[] = [1, 2];
    for (const [index, value] of scaled.entries()) scaled[index] = value * 10;
    if (scaled[0]! + scaled[1]! !== 30) throw new Error("entries index the source");
    const m = new Map<string, number>([["a", 1], ["b", 2]]);
    let text = "";
    for (const [k, v] of m.entries()) text += k + v;
    for (const k of m.keys()) text += k;
    for (const v of m.values()) text += v;
    if (text !== "a1b2ab12") throw new Error("map iterators");
    const s = new Set<number>([3, 4]);
    let sum = 0;
    for (const v of s.values()) sum += v;
    for (const v of s.keys()) sum += v;
    const merged = [...m.keys(), ...m.keys()];
    const valueList = [...m.values()];
    const spread = merged.length + valueList[1]!;
    if (sum !== 14 || spread !== 6) throw new Error("set iterators and spreads");
    const doubled = Array.from(s, (v, i) => v * 2 + i);
    const keys = Array.from(m.keys());
    if (doubled.join() !== "6,9" || keys.join() !== "a,b") throw new Error("Array.from over ranges");
    const lanes = new Float32Array([1.5, 2.5]);
    let lanesTotal = 0;
    for (const lane of lanes) lanesTotal += lane;
    if (lanesTotal !== 4) throw new Error("typed array iteration");
`);

check("dictionaries", `
    interface Table { fallback: number; [id: string]: number }
    function lookup(table: Table, key: string): number {
        return table[key] ?? table.fallback;
    }
    const table: Table = { fallback: 1, deer: 3 };
    table.deer = 4;
    table["fox"] = 5;
    if (lookup(table, "deer") + lookup(table, "fox") + lookup(table, "owl") !== 10) throw new Error("index signature table");
    const counts: Record<string, number> = {};
    for (const word of ["a", "b", "a"]) counts[word] = (counts[word] ?? 0) + 1;
    delete counts["b"];
    if (Object.keys(counts).length !== 1 || counts["a"] !== 2 || "b" in counts) throw new Error("delete and in");
    const groups: Record<string, string[]> = {};
    for (const [key, value] of Object.entries({ x: "1", y: "2" })) (groups[key] ??= []).push(value);
    if (groups["x"]?.join() !== "1" || groups["y"]?.join() !== "2") throw new Error("dictionary of arrays");
`);

check("weak-collections", `
    interface Item { id: number }
    const seen = new WeakMap<Item, number>();
    const marked = new WeakSet<Item>();
    const item: Item = { id: 1 };
    const other: Item = { id: 1 };
    seen.set(item, 2);
    marked.add(item);
    if (seen.get(item) !== 2 || seen.has(other) || !marked.has(item) || marked.has(other)) throw new Error("identity keys");
    seen.delete(item);
    if (seen.has(item)) throw new Error("delete");
`);

check("destructuring", `
    function lanes(xs: number[]): number {
        const [first = 5, second = 7, ...rest] = xs;
        let a = 1;
        let b = 2;
        [a, b] = [b, a];
        return first + second * 10 + rest.length * 100 + a * 1000;
    }
    if (lanes([1]) !== 1 + 70 + 0 + 2000 || lanes([1, 2, 3, 4]) !== 1 + 20 + 200 + 2000) throw new Error("array defaults and rest");
    const source = { a: 1, b: 2, c: 3 };
    const { a, ...rest } = source;
    const { b = 9, d = 4 } = { b: 2 } as { b?: number; d?: number };
    if (a + rest.b + rest.c + b + d !== 12) throw new Error("object defaults and rest");
    interface Options { width?: number; height: number }
    function area({ width = 2, height }: Options): number { return width * height; }
    if (area({ height: 3 }) + area({ width: 4, height: 1 }) !== 10) throw new Error("destructured parameters");
    function struct(options: Options): number {
        const { width = 6, height } = options;
        return width + height;
    }
    if (struct({ height: 1 }) + struct({ width: 1, height: 1 }) !== 9) throw new Error("struct defaults");
`);

check("generics", `
    function first<T>(xs: readonly T[]): T | undefined { return xs[0]; }
    function mapAll<T, U>(xs: readonly T[], f: (x: T) => U): U[] { const out: U[] = []; for (const x of xs) out.push(f(x)); return out; }
    function longest<T extends { length: number }>(a: T, b: T): T { return a.length >= b.length ? a : b; }
    function getOrCreate<K, V>(m: Map<K, V>, k: K, make: () => V): V { let v = m.get(k); if (v === undefined) { v = make(); m.set(k, v); } return v; }
    function pick<T, K extends keyof T>(obj: T, key: K): T[K] { return obj[key]; }
    if ((first([2, 3]) ?? 0) + (first(["ab"]) ?? "").length !== 4) throw new Error("two instantiations");
    if (mapAll([1, 2], x => x * 2).join() !== "2,4" || mapAll(["a"], x => x.length)[0] !== 1) throw new Error("callback types");
    if (longest("abc", "de") !== "abc" || longest([1], [1, 2]).length !== 2) throw new Error("constraints");
    const buckets = new Map<string, number[]>();
    getOrCreate(buckets, "a", () => []).push(1);
    getOrCreate(buckets, "a", () => []).push(2);
    if (getOrCreate(buckets, "a", () => []).length !== 2) throw new Error("nullable rebinding");
    if (pick({ a: 2, b: "x" }, "a") !== 2) throw new Error("keyof");
    class Stack<T> {
        private items: T[] = [];
        push(item: T): void { this.items.push(item); }
        peek(): T | undefined { return this.items[this.items.length - 1]; }
        size(): number { return this.items.length; }
    }
    const numbers = new Stack<number>();
    numbers.push(1);
    numbers.push(2);
    const words = new Stack<string>();
    words.push("x");
    if ((numbers.peek() ?? 0) + numbers.size() + (words.peek() ?? "").length !== 5) throw new Error("generic class");
    type Result<T> = { ok: true; value: T } | { ok: false; error: string };
    function unwrap(r: Result<number>): number { return r.ok ? r.value : -1; }
    if (unwrap({ ok: true, value: 2 }) + unwrap({ ok: false, error: "e" }) !== 1) throw new Error("literal-tagged union alias");
`);

check("function-parameters", `
    function sum(...xs: number[]): number { let t = 0; for (const x of xs) t += x; return t; }
    function join(separator: string, ...parts: string[]): string { return parts.join(separator); }
    function sum3(a: number, b: number, c: number): number { return a + b + c; }
    const args: [number, number, number] = [1, 2, 3];
    const spread = [4, 5];
    if (sum(1, 2) + sum() + sum(...spread) !== 12) throw new Error("rest parameters");
    if (join("-", "a", "b") !== "a-b" || join("+") !== "") throw new Error("rest after fixed");
    if (sum3(...args) !== 6) throw new Error("tuple spread call");
`);

check("module-state", `
    const items: number[] = [];
    const stats = { hits: 0, nested: { depth: 1 } };
    const cache = new Map<string, number>();
    const listeners: Array<() => void> = [];
    const api = { base: 10, get() { return this.base + items.length; } };
    function add(n: number): void { items.push(n); stats.hits += 1; stats.nested.depth += n; }
    function memo(key: string): number { let v = cache.get(key); if (v === undefined) { v = key.length; cache.set(key, v); } return v; }
    function on(l: () => void): () => void { listeners.push(l); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
    function emit(): void { for (const l of listeners) l(); }
    add(1);
    add(2);
    let fired = 0;
    const off = on(() => { fired += 1; });
    emit();
    off();
    emit();
    if (items.length !== 2 || stats.hits !== 2 || stats.nested.depth !== 4) throw new Error("mutated module containers");
    if (memo("ab") + memo("ab") + cache.size !== 5 || fired !== 1) throw new Error("module cache and listeners");
    if (api.get() !== 12) throw new Error("module record method");
`);

check("class-shapes", `
    class A { v = 1; }
    class B { w = 2; }
    class Counter { constructor(private n: number) {} get doubled(): number { return this.n * 2; } read(): number { return [1].map(x => x + this.n)[0] ?? 0; } }
    function tag(x: unknown): number { return x instanceof A ? 1 : x instanceof B ? 2 : 0; }
    const items: Array<A | B> = [new A(), new B()];
    let total = 0;
    for (const item of items) total += item instanceof A ? item.v : item.w;
    if (total !== 3 || tag(new A()) + tag(new B()) + tag(3) !== 3) throw new Error("instanceof");
    if (new Counter(2).doubled + new Counter(3).read() !== 8) throw new Error("temporaries as receivers");
`);

check("binary-data", `
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);
    view.setFloat32(0, 1.5, true);
    view.setUint16(4, 258);
    view.setFloat64(8, -2.25, true);
    view.setInt8(6, -1);
    const bytes = new Uint8Array(buffer);
    if (view.getFloat32(0, true) !== 1.5 || bytes[4] !== 1 || bytes[5] !== 2 || view.getUint8(6) !== 255) throw new Error("setters");
    if (view.getFloat64(8, true) !== -2.25 || view.getInt16(4) !== 258 || view.getUint16(4, true) !== 513) throw new Error("byte order");
    const lanes = new Float32Array(8);
    const window = lanes.subarray(2, 4);
    window[0] = 7;
    const tail = lanes.subarray(6);
    if (lanes[2] !== 7 || window.length !== 2 || tail.length !== 2 || lanes.slice(2, 3)[0] !== 7) throw new Error("subarray shares bytes");
    const words = new Uint32Array(buffer, 4, 2);
    words[0] = 0x01020304;
    if (bytes[4] !== 4 || bytes[7] !== 1) throw new Error("buffer views");
`);

check("strings-and-numbers", `
    function text(s: string): string { return s.charAt(0) + s.charAt(9) + s.padEnd(4, "-") + s.trimStart().trimEnd() + "|"; }
    if (text(" ab") !== " " + " ab-" + "ab|") throw new Error("string methods");
    function spell(n: number): string { return n.toString(16) + ":" + n.toString(2) + ":" + n.toString(); }
    if (spell(255) !== "ff:11111111:255" || (-10).toString(16) !== "-a" || (0.5).toString(2) !== "0.1") throw new Error("radix");
    function parse(s: string): number { return parseFloat(s) + Number.parseFloat(s) + parseInt(s, 10); }
    if (parse("1.5x") !== 4 || !Number.isNaN(parseFloat("x")) || parseFloat("  -2e1z") !== -20) throw new Error("parseFloat");
    function truthy(n: number, s: string): number { return (Boolean(n) ? 1 : 0) + (Boolean(s) ? 2 : 0); }
    if (truthy(0, "x") !== 2 || truthy(3, "") !== 1) throw new Error("Boolean()");
    if (String(null) + String(undefined) !== "nullundefined") throw new Error("String of nullish");
    let a = 1;
    const comma = (a += 1, a * 10);
    if (comma !== 20 || Date.now() <= 0) throw new Error("comma and clock");
`);

test("raw text imports read the file beside the module", () => {
    const result = compileSource(
        'import shader from "./raw-text-import.wgsl?raw";\nif (shader.length !== 27) throw new Error("raw text length");\n',
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"), "the text file is a recorded input");
});

test("unsupported language shapes refuse explicitly", () => {
    for (const [source, message] of [
        ["function* gen(): Generator<number> { yield 1; } for (const v of gen()) {}", /Generator functions/],
        ["const a = { x: 1 }; const b = { x: 1 }; if (Object.is(a, b)) {}", /Object.is compares/],
        ["function f(n: number): boolean { return \"x\" in n; } f(1);", /'in' is decided/],
        ["function f(r: { a: number }): void { delete r.a; } f({ a: 1 });", /required field/],
        ["function f(xs: number[]): void { xs[Math.trunc(Math.random())] ??= 2; } f([1]);", /must not contain a call/],
        ["function f(s: string): number { return s.localeCompare(\"a\"); } f(\"b\");", /localeCompare/],
    ] as const) assert.throws(() => compileSource(source), message);
});
