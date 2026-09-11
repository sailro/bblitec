import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

// The generic TypeScript user-code surface: every source below runs its own
// assertions in JavaScript first, then the generated C++ must build and run
// them identically.
const native = optionalNativeFixtureTools(false);

check("known-nullish-string-conversion", `
    function show(value: unknown): string { return String(value); }
    const missing = undefined;
    const empty = null;
    if (typeof missing !== "undefined" || typeof empty !== "object") throw new Error("nullish typeof");
    if (show(missing) !== "undefined" || show(empty) !== "null") throw new Error("nullish String");
    if ("value=" + missing !== "value=undefined" || "value=" + empty !== "value=null") throw new Error("nullish concatenation");
    if (\`value=\${missing}\` !== "value=undefined" || \`value=\${empty}\` !== "value=null") throw new Error("nullish interpolation");
`);

check("array-predicates-preserve-effects-and-absence", `
    let calls = 0;
    function numbers(): number[] { calls++; return [1, 2]; }
    function record(): {value:number} { calls++; return {value: 1}; }
    function optional(present: boolean): number[] | null { return present ? [1] : null; }
    if (!Array.isArray(numbers()) || Array.isArray(record()) || calls !== 2) throw new Error("array predicate effects");
    const inputs = [true, false];
    for (const input of inputs) if (Array.isArray(optional(input)) !== input) throw new Error("absent array");
    if (Array.isArray(undefined) || Array.isArray(null) || Array.isArray(new Float32Array(2))) throw new Error("nonarrays");
`);

check("tuple-aliases-survive-binding-replacement", `
    let numeric: [number, number] = [1, 2];
    const oldNumeric = numeric;
    numeric = [3, 4];
    numeric[0] = 5;
    if (oldNumeric[0] !== 1 || numeric[0] !== 5) throw new Error("numeric tuple binding");
    let mixed: [string, number] = ["old", 1];
    const oldMixed = mixed;
    mixed = ["new", 2];
    mixed[1] = 3;
    if (oldMixed[0] !== "old" || oldMixed[1] !== 1 || mixed[1] !== 3) throw new Error("mixed tuple binding");
`);

check("empty-audio-resource-collections", `
    const nodes = new Map<AudioNode, number>();
    const parameters = new Map<AudioParam, number>();
    const contexts = new Set<AudioContext>();
    const streams = new Map<MediaStream, number>();
    const tracks = new Set<MediaStreamTrack>();
    if (nodes.size + parameters.size + contexts.size + streams.size + tracks.size !== 0) throw new Error("resource collections");
`);

check("enum-parameter-defaults", `
    enum Tone { Soft = "soft", Bold = "bold" }
    enum Mode { First = 3, Second }
    function tone(value: Tone = Tone.Soft): string { return value; }
    function mode(value: Mode = Mode.Second): number { return value; }
    function main(): void {
        if (tone() !== "soft" || tone(Tone.Bold) !== "bold" || mode() !== 4) throw new Error("enum defaults");
        let order = "";
        function mark(name: string): string { order += name; return order; }
        const labels: Record<Tone, string> = {[Tone.Bold]: mark("b"), [Tone.Soft]: mark("s")};
        if (order !== "bs" || labels[Tone.Bold] !== "b" || labels[Tone.Soft] !== "bs") throw new Error("enum record effects");
        if (Object.keys(labels).join(",") !== "bold,soft" || Object.values(labels).join(",") !== "b,bs") throw new Error("enum record order");
    }
    main();
`);

check("object-prototype-own-property-call", `
    const entries: Record<string, number> = {first: 2, second: 3};
    delete entries["first"];
    const keys = ["first", "second", "toString", "missing"];
    let found = "";
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(entries, key)) found += key;
    }
    if (found !== "second") throw new Error("own property membership");
    let calls = 0;
    function owner(): Record<string, number> { calls++; return entries; }
    if (!Object.prototype.hasOwnProperty.call(owner(), "second") || calls !== 1) throw new Error("own property effects");
`);

check("callback-factory-record-assignment", `
    let count = 0;
    function handler(step: number): () => void { count++; return () => { count += step; }; }
    const registry = { identity: <T>(value: T): T => value, action: (): void => {} };
    registry.action();
    registry.action = handler(3);
    registry.action();
    if (registry.identity(count) !== 4) throw new Error("callback factory assignment");
`);

check("ignored-generic-record-returns-preserve-branch-effects", `
    let visits = 0;
    function createHook() { visits += 10; return {identity: <T>(value:T):T => value}; }
    function install(ready: boolean) {
        try {
            if (ready) return createHook();
            visits++;
            return createHook();
        } finally { visits += 100; }
    }
    for (const ready of [true, false]) install(ready);
    if (visits !== 221) throw new Error("ignored return effects or finally");
    function literal(ready:boolean) {
        if (ready) return {first: visits++, second: createHook()};
        return {first: visits++, second: createHook()};
    }
    for (const ready of [false, true]) literal(ready);
    if (visits !== 243) throw new Error("discarded literal member effects");
    function compared(ready:boolean) {
        if (ready) return visits++ > 0;
        return visits++ < 0;
    }
    for (const ready of [false, true]) compared(ready);
    if (visits !== 245) throw new Error("discarded comparison effects");
    const values = [3, 1, 2];
    values.sort((a,b) => a-b);
    if (values.join(",") !== "1,2,3") throw new Error("discarded sort still consumes comparator result");
`);

check("record-method-rebinding-is-visible-to-retained-callbacks", `
    let count = 0;
    function handler(step: number): () => void { count++; return () => { count += step; }; }
    const registry = {identity: <T>(value:T):T => value, action: ():void => { count += 10; }};
    const callbacks: Array<() => void> = [() => registry.action()];
    const alias = registry;
    const flags = [false, true];
    for (const replace of flags) {
        if (replace) alias.action = handler(3);
        callbacks[0]!();
    }
    if (registry.identity(count) !== 14) throw new Error("retained callback method slot");
`);

check("nullable-string-enum-assertions", `
    const keys = ["low", "high"] as const;
    type Key = typeof keys[number];
    function parse(raw: string | null): Key | null {
        return (keys as readonly string[]).includes(raw ?? "") ? raw as Key : null;
    }
    const inputs: Array<string | null> = ["high", null, "unknown", "low"];
    const parsed = inputs.map(parse);
    if (parsed[0] !== "high" || parsed[1] !== null || parsed[2] !== null || parsed[3] !== "low") throw new Error("nullable enum assertion");
`);

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
                "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), `/Fo:${directory}/`, `/Fe:${exe}`, cpp,
            ]);
            execFileSync(exe, { stdio: "pipe" });
        });
    });
}

check("mixed-tuple-storage", `
    interface Item { score: number; }
    const item: Item = {score: 3};
    const pairs: [string, Item][] = [["b", item], ["a", {score: 5}]];
    const alias = pairs[0]!;
    alias[0] = "c";
    alias[1].score += 4;
    if (pairs[0]![0] !== "c" || item.score !== 7) throw new Error("tuple aliases");
    const [key, value] = alias;
    if (key !== "c" || value !== item || alias.length !== 2) throw new Error("destructure");
    const byKey = new Map<string, Item>(pairs);
    const entries = [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.map(([k, v]) => k + v.score).join(",") !== "a5,c7") throw new Error("ordered entries");
    entries[0]![0] = "other";
    entries[0]![1].score = 9;
    if (byKey.has("other") || byKey.get("a")!.score !== 9) throw new Error("fresh entry pair");
    const object = Object.fromEntries(pairs);
    if (object["c"] !== item) throw new Error("fromEntries identity");
    let total = 0;
    for (const [, entry] of pairs) total += entry.score;
    if (total !== 16) throw new Error("iteration");
    const seen = new Set<[string, Item]>();
    seen.add(alias); seen.add(pairs[0]!); seen.add(["c", item]);
    if (seen.size !== 2 || !seen.has(alias)) throw new Error("tuple key identity");
    const groups = new Map<number, string[]>();
    groups.set(2, ["b"]); groups.set(1, ["a", "c"]);
    const ordered = [...groups].sort(([a], [b]) => a - b).map(([, names]) => [...names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    if (ordered.map(names => names.join("+")).join(";") !== "a+c;b") throw new Error("nested entry arrays");
    const weights = new Map<string, number>();
    weights.set("a", 2); weights.set("b", 1);
    const sortedKeys: string[] = ["a", "b"];
    if (sortedKeys.sort((a, b) => weights.get(a)! - weights.get(b)!).join("") !== "ba") throw new Error("asserted Map result");
`);

check("conditional-json-null", `
    function parse(text: string): number {
        const value = text ? JSON.parse(text) : null;
        return value === null ? -1 : value.count;
    }
    if (parse("") !== -1 || parse('{"count":3}') !== 3) throw new Error("nullable document");
    function missing(text: string): boolean {
        const value = text ? JSON.parse(text) : undefined;
        return value === undefined;
    }
    if (!missing("") || missing("null")) throw new Error("undefined document");
    type Mode = "slow" | "normal" | "fast";
    function mode(value: unknown): Mode { return value === "slow" || value === "fast" ? value : "normal"; }
    const inputs = JSON.parse('["slow", "fast", 0, null]');
    let modes = "";
    for (const input of inputs) modes += mode(input) + ";";
    if (modes !== "slow;fast;normal;normal;") throw new Error("guarded JSON enum");
`);

check("fixed-record-entry-projection", `
    type Action = "left" | "right";
    type Scheme = "first" | "second";
    const definitions = [
        {action: "left", defaults: {first: "a", second: "j"}},
        {action: "right", defaults: {first: "d", second: "l"}},
    ] as const;
    function profile(scheme: Scheme): Record<Action, string> {
        return Object.fromEntries(definitions.map(definition => [definition.action, definition.defaults[scheme]])) as Record<Action, string>;
    }
    const first = profile("first"), second = profile("second");
    if (first.left !== "a" || first.right !== "d" || second.left !== "j" || second.right !== "l") throw new Error("fixed record projection");
    let visits = 0;
    const values = Object.fromEntries(["x", "x", "y"].map(key => [key, ++visits]));
    if (visits !== 3 || values.x !== 2 || values.y !== 3) throw new Error("duplicate entry effects");
`);

check("compound-union-tags", `
    type Key = {kind: "motion"; action: "up" | "down"} | {kind: "command"; action: "save" | "load"};
    type Result = {ok: true; value: number; displaced?: Key} | {ok: false; reason: "invalid"} | {ok: false; reason: "blocked"; key: Key};
    function result(index: number): Result {
        if (index < 0) return {ok: false, reason: "invalid"};
        if (index === 0) return {ok: false, reason: "blocked", key: {kind: "motion", action: "up"}};
        return {ok: true, value: index};
    }
    const results: Result[] = [result(-1), result(0), result(3)];
    let text = "";
    for (const entry of results) {
        if (entry.ok) text += entry.value;
        else if (entry.reason === "blocked") text += entry.key.action;
        else text += entry.reason;
    }
    if (text !== "invalidup3") throw new Error("compound tag narrowing");
`);

check("contextual-string-array-results", `
    interface Definition { name: "first" | "second" | null; }
    interface Group { names: readonly string[]; }
    const definitions: Definition[] = [{name:"first"}, {name:null}, {name:"second"}];
    const names: readonly string[] = definitions.map(value => value.name).filter((name): name is NonNullable<typeof name> => name !== null);
    const groups: Group[] = [{names}];
    const alias = names as string[];
    alias.push("extra");
    if (groups[0]!.names.join(",") !== "first,second,extra") throw new Error("contextual filter identity");
    const mapped: string[] = definitions.filter(value => value.name !== null).map(value => value.name!);
    mapped.push("extra");
    if (mapped.join(",") !== "first,second,extra") throw new Error("contextual map");
`);

check("stored-array-predicates", `
    interface Filter { run: (accept: (value: number) => boolean) => number[]; }
    const numbers: number[] = [1, 2, 3];
    const filter: Filter = {run: accept => [...numbers].filter(accept)};
    if (filter.run(value => value > 1).join(",") !== "2,3") throw new Error("stored predicate");
    let predicate: (value: number) => boolean = value => { predicate = () => false; return value > 0; };
    if (numbers.filter(predicate).length !== 3 || numbers.filter(predicate).length !== 0) throw new Error("callback argument snapshot");
`);

check("assigned-optional-array-result", `
    function group(values: readonly string[]): string[][] {
        const rows: string[][] = [];
        let selected: string[] | null = null;
        for (const value of values) {
            if (!selected) rows.push(selected = []);
            selected.push(value);
        }
        return rows;
    }
    if (group(["a", "b"]).map(row => row.join("")).join(",") !== "ab") throw new Error("assignment returns initialized array");
`);

check("constructor-callback-instance-capture", `
    interface Hooks { change: () => number; }
    class Counter {
        value = 0;
        constructor(private readonly hooks: Hooks) {}
        next(): number { this.value++; return this.hooks.change(); }
    }
    const counter = new Counter({change: () => counter.value});
    if (counter.next() !== 1 || counter.next() !== 2) throw new Error("constructor closure observes instance");
`);

check("absent-optional-iteration", `
    const input: {items?: readonly number[]} = {};
    let visited = 0;
    for (const item of input.items ?? []) {
        if (item < 0) continue;
        visited++;
        if (item === 4) break;
    }
    if (visited !== 0) throw new Error("absent iterable");
`);

check("constant-array-slices", `
    const entries = [{score: 2}, {score: 7}, {score: 11}] as const;
    const gaps = entries.slice(1).map((entry, index) => entry.score - entries[index]!.score);
    if (Math.min(...gaps) !== 4 || entries.slice(-2, -0.5).length !== 0) throw new Error("constant slice bounds");
    let visits = 0;
    function next(): number { return ++visits; }
    const first = [next(), next(), next()].slice(0, 1);
    if (first[0] !== 1 || visits !== 3) throw new Error("discarded slice effects");
    const minimum = Math.min(...[2, 7, 11].map(value => value + 1));
    if (minimum !== 3 || Math.max(...[]) !== -Infinity) throw new Error("constant numeric spread");
`);

check("indexed-and-union-string-parts", `
    function token(text: string): string { let i = 0, value = ""; while (i < text.length) value += text[i++]; return value; }
    if (token("text") !== "text") throw new Error("indexed concat");
    let index = 0;
    const text = "x" + ""[index++];
    if (text !== "xundefined" || index !== 1) throw new Error("missing character once");
    interface Label { text: (value: string | number) => string; }
    const label: Label = {text: value => \`value:\${value}\`};
    if (label.text(3) !== "value:3" || label.text("name") !== "value:name") throw new Error("union template");
`);

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

check("logical-string-selection", `
    let effects = 0;
    function read(value: string): string { effects++; return value; }
    function fallback(): string { effects += 10; return "fallback"; }
    interface Selector { choose: (value: string | null) => string; }
    const selector: Selector = {choose: value => value || fallback()};
    if ((read("kept") || fallback()) !== "kept" || effects !== 1) throw new Error("lazy OR");
    if ((read("") || fallback()) !== "fallback" || effects !== 12) throw new Error("fallback OR");
    if ((read("") && fallback()) !== "" || effects !== 13) throw new Error("lazy AND");
    if ((read("kept") && fallback()) !== "fallback" || effects !== 24) throw new Error("selected AND");
    if (selector.choose(null) !== "fallback" || effects !== 34) throw new Error("nullable OR");
    if (selector.choose("present") !== "present" || effects !== 34) throw new Error("present OR");
`);

check("retained-nonfinite-records", `
    function entry() { return {invalid: Number.NaN, high: Number.POSITIVE_INFINITY, low: Number.NEGATIVE_INFINITY}; }
    const entries = Array.from({length: 3}, () => entry());
    for (const value of entries) {
        if (!Number.isNaN(value.invalid) || value.high !== Infinity || value.low !== -Infinity) throw new Error("nonfinite retained fields");
    }
`);

check("contextual-conditional-arrays", `
    type Key = "first" | "second" | "third";
    class Catalog {
        values(key: Key): readonly Key[] {
            return key === "first" ? ["second", "third"] : key === "second" ? ["first"] : [];
        }
    }
    const catalog = new Catalog();
    const keys: Key[] = ["first", "second", "third"];
    let result = "";
    for (const key of keys) result += catalog.values(key).join(",") + ";";
    if (result !== "second,third;first;;") throw new Error("contextual array selection");
    const defaults = ["first", "second", "first"] as const;
    const unique = new Set<string>(defaults);
    if (unique.size !== 2 || !unique.has("second")) throw new Error("constant iterable constructor");
`);

check("recursive-array-callback", `
    function evaluate(seed: number): number {
        const memo = new Map<number, number>();
        const depth = (value: number): number => {
            const known = memo.get(value);
            if (known !== undefined) return known;
            const parents: number[] = value > 1 ? [value - 1, value - 2] : [];
            const result = parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
            memo.set(value, result);
            return result;
        };
        return depth(seed);
    }
    if (evaluate(6) !== 5 || evaluate(3) !== 2) throw new Error("recursive array callback captures");
`);

check("error-values", `
    if (String(new Error()) !== "Error" || String(new RangeError("limit")) !== "RangeError: limit") throw new Error("error string conversion");
    let text = "first";
    const held = new Error(text);
    const stack = held.stack;
    if (typeof stack !== "undefined" && typeof stack !== "string") throw new Error("optional error stack");
    text = "second";
    if (String(held) !== "Error: first" || \`result: \${held}\` !== "result: Error: first") throw new Error("error message snapshot");
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

check("string-indexing", `
    function at(value: string, index: number): string | undefined { return value[index]; }
    const text = "Aé😀Z";
    if (at(text, 0) !== "A" || at(text, 1) !== "é" || at(text, 4) !== "Z") throw new Error("code unit indexing");
    if (at(text, 2) !== String.fromCharCode(0xd83d) || at(text, 3) !== String.fromCharCode(0xde00)) throw new Error("surrogate indexing");
    if (at(text, -1) !== undefined || at(text, 5) !== undefined || at(text, 1.5) !== undefined || at(text, NaN) !== undefined) throw new Error("absent string property");
    let source = "ab";
    function change(): number { source = "cd"; return 1; }
    const selected = source[change()];
    if (selected !== "b") throw new Error("string receiver snapshot");
    const axes = [[0, 1, 2], [1, 0, 2], [2, 1, 0]] as const;
    const names = axes.map(row => row.map(index => "xyz"[index]).join(""));
    if (names.join(",") !== "xyz,yxz,zyx") throw new Error("static string projection");
`);

check("literal-key-record-lookup", `
    type Mode = "low" | "high";
    interface Settings { amount: number; enabled: boolean; }
    const options: Readonly<Record<Mode, Settings>> = {
        low: { amount: 1, enabled: false }, high: { amount: 3, enabled: true },
    };
    const selected: Mode = "high";
    const settings = options[selected];
    if (settings.amount !== 3 || !settings.enabled) throw new Error("literal key lookup");
`);

check("constant-filter-effects", `
    let calls = 0;
    function step(value: number): number { calls++; return value; }
    const input = [step(1), "skip", step(2)] as const;
    let visits = 0;
    const selected = input.filter(value => { visits++; return typeof value === "number"; });
    if (calls !== 2 || visits !== 3 || selected.join(",") !== "1,2") throw new Error("filter evaluation order");
    const early = [1, 2, 3].filter(value => {
        if (value < 2) return false;
        return value > 0;
    });
    if (early.join(",") !== "2,3") throw new Error("early predicate returns");
`);

check("readonly-record-array-lookup", `
    interface Attachment { position: readonly [number, number, number]; }
    interface Entry { id: string; attachment: Attachment | null; }
    const catalog: readonly Entry[] = [
        { id: "a", attachment: null },
        { id: "b", attachment: { position: [1, 2, 3] } },
    ];
    function find(id: string): Entry | undefined { return catalog.find(entry => entry.id === id); }
    const key = Math.random() > .5 ? "b" : "b";
    const match = find(key);
    if (!match || !match.attachment || match.attachment.position[1] !== 2) throw new Error("runtime lookup");
    if (find("a")?.attachment !== null || find("missing") !== undefined) throw new Error("nullable lookup");
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

check("buffer-view-storage", `
    interface Payload { data: ArrayBufferView; read(): ArrayBufferView | null; }
    const buffer = new ArrayBuffer(32);
    const floats = new Float32Array(buffer, 8, 3);
    const bytes = new Uint8Array(buffer, 4, 12);
    const view = new DataView(buffer, 6, 8);
    const payloads: Payload[] = [
        { data: floats, read: () => floats },
        { data: bytes, read: () => bytes },
        { data: view, read: () => view },
    ];
    function setFirst(value: ArrayBufferView): void {
        const destination = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        destination[0] = 17;
    }
    for (let i = 0; i < payloads.length; i++) {
        const item = payloads[i]!;
        const read = item.read();
        if (read !== item.data || item.data.buffer !== buffer) throw new Error("view and buffer identity");
        setFirst(item.data);
    }
    const all = new Uint8Array(buffer);
    if (all[4] !== 17 || all[6] !== 17 || all[8] !== 17) throw new Error("shared subview bytes");
    if (payloads[0]!.data.byteOffset !== 8 || payloads[0]!.data.byteLength !== 12) throw new Error("numeric view range");
    if (payloads[2]!.data.byteOffset !== 6 || payloads[2]!.data.byteLength !== 8) throw new Error("data view range");
    const aliases: ArrayBufferView[] = [floats, floats, new Float32Array(buffer, 8, 3)];
    if (aliases[0] !== aliases[1] || aliases[0] === aliases[2]) throw new Error("distinct views on one buffer");
    const views = new Set<ArrayBufferView>();
    views.add(floats); views.add(floats); views.add(bytes);
    if (views.size !== 2 || !views.has(floats)) throw new Error("view keys");
`);

check("contextual-record-map-spreads", `
    interface Item { name: string; category: "first" | "second"; metadata: { size: number } | null; }
    const first: string[] = ["a", "b"];
    const second: string[] = ["long"];
    const items: readonly Item[] = [
        ...first.map(name => ({ name, category: "first" as const, metadata: null })),
        ...second.map(name => ({ name, category: "second" as const, metadata: { size: name.length } })),
    ];
    if (items.length !== 3 || items[0]!.metadata !== null || items[2]!.metadata!.size !== 4)
        throw new Error("contextual record fields");
    if (items.filter(item => item.metadata === null).map(item => item.name).join(",") !== "a,b")
        throw new Error("contextual record filtering");
`);

check("spread-string-literal-sets", `
    const labels = { first: "warm", second: "cool", duplicate: "warm" } as const;
    type Label = "start" | "warm" | "cool" | "end";
    const values: readonly Label[] = ["start", ...new Set(Object.values(labels)), "end"];
    if (values.join(",") !== "start,warm,cool,end") throw new Error("set widening and order");
    const small: ("warm" | "cool")[] = ["cool", "warm"];
    const strings: string[] = [...small];
    small[0] = "warm";
    if (strings.join(",") !== "cool,warm") throw new Error("fresh widened array");
    if (values.filter(label => label.startsWith("c")).map(label => label.toUpperCase()).join(",") !== "COOL")
        throw new Error("string methods on literal unions");
    const selected = values[2]!;
    if (selected.length !== 4 || selected[1] !== "o") throw new Error("literal union string members");
`);

check("flat-map-tuple-alternatives", `
    type Tag = "a" | "b";
    const tags: Tag[] = ["a", "b"];
    function location(tag: Tag | "unused" | undefined): "north" | "south" | null { return tag === "unused" ? null : tag === "a" ? "north" : null; }
    function temperature(tag: Tag): "hot" | "cold" { return tag === "a" ? "hot" : "cold"; }
    const byName: ReadonlyMap<string, Tag> = new Map(tags.flatMap(tag => {
        const place = location(tag);
        const heat = temperature(tag);
        return [...(place === null ? [] : [[place, tag] as const]), ...(heat === "cold" ? [[heat, tag] as const] : [])];
    }));
    if (byName.size !== 2 || byName.get("north") !== "a" || byName.get("cold") !== "b") throw new Error("flattened alternatives");
    const original = new Map<Tag, number>([["a", 1], ["b", 2]]);
    const widened: Map<string, number> = new Map(original);
    widened.set("extra", 3);
    if (widened.get("b") !== 2 || original.size !== 2) throw new Error("fresh widened map");
`);

check("runtime-parameter-defaults", `
    let calls = 0;
    function fallback(): number { calls++; return 7; }
    function scale(value = fallback(), multiplier = 2): number { return value * multiplier; }
    const options: { value?: number }[] = [{}, { value: 3 }];
    if (scale(options[0]!.value) !== 14 || calls !== 1) throw new Error("missing value default");
    if (scale(options[1]!.value, 4) !== 12 || calls !== 1) throw new Error("present value skips default");
    if (scale(undefined, 3) !== 21 || calls !== 2) throw new Error("explicit undefined");
    function dependent(first: number, second = first + 1): number { return second; }
    if (dependent(9) !== 10) throw new Error("prior parameter scope");
    let sequence = "";
    function missing(): number | undefined { sequence += "a"; return undefined; }
    function last(): number { sequence += "b"; return 2; }
    function initial(): number { sequence += "c"; return 3; }
    function ordered(value = initial(), factor: number): number { return value * factor; }
    if (ordered(missing(), last()) !== 6 || sequence !== "abc") throw new Error("argument and default order");
    function keepNull(value: number | null = 5): number | null { return value; }
    if (keepNull(null) !== null || keepNull() !== 5) throw new Error("null is not undefined");
    interface Item { score: number; }
    const original: Item = { score: 9 };
    interface Saved { value?: Item; callback?: () => number; }
    const records: Saved[] = [{}, { value: original, callback: () => 6 }];
    function choose(value: Item = { score: 3 }): Item { return value; }
    const fresh = choose(records[0]!.value);
    if (!fresh || fresh.score !== 3 || choose(records[1]!.value) !== original) throw new Error("reference defaults");
    function invoke(callback: () => number = () => 2): number { return callback(); }
    if (invoke(records[0]!.callback) !== 2 || invoke(records[1]!.callback) !== 6) throw new Error("callback defaults");
`);

check("fixed-record-enumeration", `
    type Key = "north" | "south";
    interface Entry { bounds: readonly [number, number]; }
    const table: Record<Key, Entry> = { south: { bounds: [2, 4] }, north: { bounds: [1, 3] } };
    if (Object.keys(table).join(",") !== "south,north") throw new Error("key order");
    if (Object.values(table).map(entry => entry.bounds[1]).join(",") !== "4,3") throw new Error("value order");
    const pairs = Object.entries(table);
    if (pairs[0][0] !== "south" || pairs[0][1] !== table.south) throw new Error("entry identity");
    function width(key: Key): number { return table[key].bounds[1] - table[key].bounds[0]; }
    const largest = Math.max(...(Object.keys(table) as Key[]).map(key => width(key) * table[key].bounds[1]));
    if (largest !== 8) throw new Error("typed key callbacks");
`);

check("readonly-numeric-dictionaries", `
    const samples = new Float32Array([2, 4]);
    const writable: Record<number, Float32Array> = {};
    writable[7] = samples;
    interface Collection { readonly channels: Readonly<Record<number, Float32Array>>; }
    const collections: Collection[] = [{ channels: writable }];
    const key = Number("7");
    const channels = collections[0]!.channels;
    if (channels[key] !== samples || channels[key]![1] !== 4) throw new Error("dictionary identity");
    channels[key]![0] = 9;
    if (samples[0] !== 9) throw new Error("readonly dictionary retains mutable values");
    if (channels[8] !== undefined || !(key in channels) || 8 in channels) throw new Error("key presence");
`);

check("numeric-index-outputs", `
    interface Output { [index: number]: number; }
    interface Projector { write(out: Output, index: number, value: number): void; changed?: () => void; }
    const projectors: Projector[] = [{ write(out, index, value) { out[index] = value; } }];
    const floats = new Float32Array(2);
    const bytes = new Uint8Array(2);
    const numbers: number[] = [0];
    const tuple: [number, number] = [0, 0];
    const outputs: Output[] = [floats, bytes, numbers, tuple];
    for (const out of outputs) projectors[0]!.write(out, 1, 258.1);
    if (floats[1] !== Math.fround(258.1) || bytes[1] !== 2 || numbers[1] !== 258.1 || numbers.length !== 2 || tuple[1] !== 258.1)
        throw new Error("index writes preserve storage");
    function add(out: Output, index: number): number { out[index] += 2; return out[index]++; }
    if (add(bytes, 1) !== 4 || bytes[1] !== 5) throw new Error("index updates");
    let changed = 0;
    projectors[0]!.changed?.();
    projectors[0]!.changed = () => { changed++; };
    projectors[0]!.changed?.();
    if (changed !== 1) throw new Error("optional interface callbacks");
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

check("nullish-equality", `
    function absent(value: number | null | undefined): boolean { return value == null; }
    function present(value: string | null | undefined): boolean { return value != null; }
    if (!absent(null) || !absent(undefined) || absent(0) || absent(NaN)) throw new Error("numeric absence");
    if (present(null) || present(undefined) || !present("") || !present("text")) throw new Error("string presence");
    const document = JSON.parse('{"nil":null,"zero":0,"empty":"","no":false}');
    if (document.nil != null || document.missing != null || document.zero == null || document.empty == null || document.no == null)
        throw new Error("JSON nullish values");
    if (document.nil === undefined || document.missing === null) throw new Error("strict null distinction");
`);

test("raw text imports read the file beside the module", () => {
    const result = compileSource(
        'import shader from "./raw-text-import.wgsl?raw";\nif (shader.length !== 27) throw new Error("raw text length");\n',
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"), "the text file is a recorded input");
});

test("raw text imports support constant string replacement through helpers", () => {
    const result = compileSource(`
        import shader from "./raw-text-import.wgsl?raw";
        function replacement(): string { return "return"; }
        const expanded = shader.replace(" r ", " " + replacement() + " ").replaceAll("1.0", "2.0");
        if (!expanded.includes("return 2.0")) throw new Error("raw text expansion");
    `, { fileName: "test/fixtures/raw-text-import.ts" });
    assert.ok(result.cpp.includes("return 2.0"));
    assert.ok(result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"));
});

test("constant numeric tables support runtime indexing and static string projections", () => {
    const result = compileSource(`
        const AXES = [[0, 1, 2], [1, 0, 2], [2, 1, 0]] as const;
        export function axes(axis: 0 | 1 | 2): readonly [number, number, number] { return AXES[axis]; }
        const names = AXES.map(row => row.map(index => "xyz"[index]).join(""));
        export const shader = \`first=\${names[0]};second=\${names[1]};third=\${names[2]};\`;
        if (axes(Math.random() < 0.5 ? 0 : 1)[2] !== 2) throw new Error("runtime table index");
    `);
    assert.ok(result.cpp.includes("first=xyz;second=yxz;third=zyx;"));
});

test("static early returns preserve shader composition records", () => {
    const result = compileSource(`
        import type { EngineContext, ShaderMaterial, ShaderUniformDecl } from "@babylonjs/lite";
        interface Composition {
            text: string;
            uniforms: readonly ShaderUniformDecl[];
            bind: (engine: EngineContext, material: ShaderMaterial) => void;
        }
        const disabled: Composition = { text: "disabled", uniforms: [], bind: () => {} };
        function composition(enabled: boolean): Composition {
            if (!enabled) return disabled;
            return { text: "enabled", uniforms: [], bind: () => {} };
        }
        const text = composition(true).text + ":" + composition(false).text;
        if (text !== "enabled:disabled") throw new Error("composition branch");
    `);
    assert.ok(result.cpp.includes("enabled:disabled"));
});

check("static-return-paths", `
    let visits = 0;
    function select(enabled: boolean): number {
        visits++;
        if (enabled) { const value = visits; return value; }
        visits++;
        return visits;
    }
    const first = select(true);
    const second = select(false);
    if (first !== 1 || second !== 3 || visits !== 3) throw new Error("static return effects");
    function dynamic(flag: number): number { return select(flag > 0); }
    if (dynamic(1) !== 4 || dynamic(0) !== 6 || visits !== 6) throw new Error("dynamic fallback effects");
`);

test("unsupported language shapes refuse explicitly", () => {
    for (const [source, message] of [
        ["function* gen(): Generator<number> { yield 1; } for (const v of gen()) {}", /Generator functions/],
        ["const a = { x: 1 }; const b = { x: 1 }; if (Object.is(a, b)) {}", /Object.is compares/],
        ["function f(n: number): boolean { return \"x\" in n; } f(1);", /'in' is decided/],
        ["function f(r: { a: number }): void { delete r.a; } f({ a: 1 });", /required field/],
        ["function f(xs: number[]): void { xs[Math.trunc(Math.random())] ??= 2; } f([1]);", /must not contain a call/],
    ] as const) assert.throws(() => compileSource(source), message);
});
