import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, executeGeneratedAssertions } from "./language-constructs.js";

// An ArrayLike<number> slot (a record or class field, a binding, a stored
// function's result and its elements) holding typed arrays stores them as
// themselves: one buffer, seen through every alias.
check(
    "array-like-slots-store-typed-arrays",
    `
    function poke(view: { [index: number]: number }, index: number, value: number): void { view[index] = value; }
    interface Budget { startX: ArrayLike<number>; startZ: ArrayLike<number>; dt: number; }
    let stepX = new Float32Array(0);
    const budget: Budget = { startX: stepX, startZ: stepX, dt: 0 };
    let stepZ = new Float32Array(0);
    function step(count: number): number {
        if (stepX.length < count) { stepX = new Float32Array(count); stepZ = new Float32Array(count); }
        for (let i = 0; i < count; i++) { stepX[i] = i; stepZ[i] = i * 2; }
        budget.startX = stepX; budget.startZ = stepZ; budget.dt = 1;
        let total = 0;
        for (let i = 0; i < count; i++) total += budget.startX[i]! + budget.startZ[i]!;
        return total + budget.startX.length;
    }
    if (step(3) !== 12) throw new Error("record field");
    stepX[1] = 0.5;
    if (budget.startX[1] !== 0.5 || budget.startX !== stepX) throw new Error("the field is the typed array");
    poke(budget.startZ, 2, 9);
    if (stepZ[2] !== 9) throw new Error("writes through the field");
    if (Array.from(budget.startX).join(",") !== "0,0.5,2") throw new Error("Array.from over the field");

    interface Binding { readonly local: ArrayLike<number>; replace(placements: ArrayLike<number>): boolean; }
    function bind(count: number): Binding {
        const local = new Float32Array(count);
        const replace = (placements: ArrayLike<number>): boolean => {
            let changed = false;
            for (let i = 0; i < local.length; i++) {
                const value = Math.fround(placements[i]!);
                if (local[i] !== value) { local[i] = value; changed = true; }
            }
            return changed;
        };
        const binding: Binding = { local, replace };
        return binding;
    }
    const binding = bind(2);
    if (!binding.replace([1.5, 2.5]) || binding.local[1] !== 2.5 || binding.local.length !== 2) throw new Error("readonly field");

    interface Ops<S> { poseOf(state: S): ArrayLike<number>; list(): readonly ArrayLike<number>[]; }
    interface State { base: Float32Array; }
    function moved(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
        for (let i = 0; i < 2; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-3) return true;
        return false;
    }
    let extra = new Float32Array(0);
    const states: State[] = [{ base: new Float32Array([1, 2]) }, { base: new Float32Array([1, 3]) }];
    const ops: Ops<State> = { poseOf: (state) => state.base, list: () => [states[0]!.base, extra] };
    if (moved(ops.poseOf(states[0]!), ops.poseOf(states[0]!)) || !moved(ops.poseOf(states[0]!), ops.poseOf(states[1]!))) throw new Error("results");
    states[0]!.base[0] = 7;
    if (ops.poseOf(states[0]!)[0] !== 7) throw new Error("the result is the typed array");
    extra = new Float32Array([4, 5, 6]);
    let lanes = 0;
    for (const entry of ops.list()) lanes += entry.length;
    if (lanes !== 5 || ops.list()[1]![2] !== 6) throw new Error("result elements");
    interface Query { obstacles: readonly ArrayLike<number>[]; }
    const widened: Ops<State> = { ...ops, list: () => [...ops.list(), stepX] };
    const query = (source: Ops<State>): Query => ({ obstacles: source.list() });
    extra = new Float32Array(1);
    let circles = 0;
    for (const entry of query(widened).obstacles) circles += entry.length;
    if (circles !== 2 + 1 + 3) throw new Error("arrays of ArrayLike results");
    interface Corridor { obstacles: readonly ArrayLike<number>[]; radius: number; x: number; }
    interface Obstacles { obstacles(): readonly ArrayLike<number>[]; }
    function segmentClear(x: number, circles: ArrayLike<number>, radius: number): boolean {
        for (let i = 0; i + 2 < circles.length; i += 3) if (Math.abs(x - circles[i]!) < circles[i + 2]! + radius) return false;
        return true;
    }
    function clears(x: number, obstacles: readonly ArrayLike<number>[], radius: number): boolean {
        return obstacles.every((set) => segmentClear(x, set, radius));
    }
    function corridor(input: Corridor): boolean {
        return clears(input.x, input.obstacles, input.radius) && clears(input.x + 10, input.obstacles, input.radius);
    }
    function corridorQuery(deps: Obstacles): (x: number) => boolean {
        return (x) => corridor({ obstacles: deps.obstacles(), radius: 0.25, x });
    }
    let pad = new Float32Array([5, 0, 1]);
    const queries: Array<typeof corridorQuery> = [corridorQuery];
    const clear = queries[0]!({ obstacles: () => [new Float32Array([1, 0, 0.5]), pad] });
    if (!clear(0)) throw new Error("clear corridor");
    pad = new Float32Array([0.5, 0, 1]);
    if (clear(0)) throw new Error("the corridor reads the current obstacles");

    function invert(scale: number): Float32Array | null { return scale === 0 ? null : new Float32Array([1 / scale]); }
    let prepared: ArrayLike<number> | null = null;
    const prepare = (scale: number): boolean => {
        prepared = invert(scale);
        if (!prepared) return false;
        return prepared !== null;
    };
    const read = (index: number): number => (prepared ? prepared[index]! : -1);
    if (!prepare(4) || read(0) !== 0.25 || prepare(0) || read(0) !== -1) throw new Error("rebound nullable binding");
    function preparer(): (scale: number) => number {
        let held: ArrayLike<number> | null = null;
        return (scale: number): number => {
            held = invert(scale);
            return held ? held[0]! : -1;
        };
    }
    const prepareHeld = preparer();
    if (prepareHeld(2) !== 0.5 || prepareHeld(0) !== -1) throw new Error("captured nullable binding");
`,
);

check(
    "optional-typed-array-beside-a-scalar-fallback",
    `
    interface Domain { radius: number; barriers?: Float32Array; tag: string | null }
    function terms(domain: Domain): readonly unknown[] {
        const { radius, barriers } = domain;
        return [radius, barriers ?? "-", domain.tag ?? "none"];
    }
    const lanes = new Float32Array([1, 2.5]);
    const kept = terms({ radius: 1, barriers: lanes, tag: "a" });
    if (kept[1] !== lanes || JSON.stringify(kept) !== '[1,{"0":1,"1":2.5},"a"]') throw new Error("present " + JSON.stringify(kept));
    if (JSON.stringify(terms({ radius: 2, tag: null })) !== '[2,"-","none"]') throw new Error("fallback");
`,
);

// Hoisted typed-array tables store their elements converted at generation;
// every element must read back as the value the runtime store produces.
const hoistedTableValues = [
    -0.1555, 0.4098, 0.1, 0.3333333333333333, 1e-7, -2.5, 1e21, 16777217,
    33565870, 33565872, 33565874, 3.4028234663852886e38, 1.1754943508222875e-38,
    1.401298464324817e-45, 65504.5, 0.30000000000000004, -98765.4321,
    4294967296.5, -1.9, 300,
];

for (let seed = 12345; hoistedTableValues.length < 132;) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const mantissa = (seed / 2147483648) * 2 - 1;
    hoistedTableValues.push(
        Number((mantissa * 10 ** ((seed % 13) - 6)).toPrecision(9)),
    );
}

check(
    "hoisted-typed-array-tables-store-converted-elements",
    `
    const raw: number[] = [${hoistedTableValues.join(", ")}];
    const floats = new Float32Array([${hoistedTableValues.join(", ")}]);
    const words = new Uint32Array([${hoistedTableValues.join(", ")}]);
    const bytes = new Int8Array([${hoistedTableValues.join(", ")}]);
    const expectedWords = new Uint32Array(raw);
    const expectedBytes = new Int8Array(raw);
    for (let index = 0; index < raw.length; ++index) {
        if (floats[index] !== Math.fround(raw[index]!)) throw new Error("float " + index);
        if (words[index] !== expectedWords[index]) throw new Error("word " + index);
        if (bytes[index] !== expectedBytes[index]) throw new Error("byte " + index);
    }
`,
);

check(
    "binary-data",
    `
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
`,
);

check(
    "typed-array-from-and-of",
    `
    function clamp(value: number): number { return value > 3 ? 3 : value; }
    const positions: number[] = [0, 1.5, -2];
    const floats = Float32Array.from(positions);
    positions[0] = 9;
    const widened = Float64Array.from(Float32Array.from([0.1]));
    const words = Uint32Array.from([-1, 2.9]);
    const pair: [number, number] = [256, -1];
    const bytes = Uint8Array.from(pair);
    const copy = Int16Array.from(floats);
    copy[0] = 5;
    if (floats[0] !== 0 || floats[2] !== -2 || floats.length !== 3 || copy[1] !== 1) throw new Error("from copies");
    if (widened[0] !== Math.fround(0.1) || words[0] !== 4294967295 || words[1] !== 2 || bytes[0] !== 0 || bytes[1] !== 255) throw new Error("from converts");
    const of = Int32Array.of(4, -2.7, positions[1]!);
    const wrapped = Uint8Array.of(300);
    if (of.length !== 3 || of[1] !== -2 || of[2] !== 1 || wrapped[0] !== 44 || Float32Array.of().length !== 0) throw new Error("of");
    let calls = "";
    const mapped = Uint8Array.from(positions, (value, index) => { calls += index; return clamp(value) * 2; });
    const named = Uint16Array.from(positions as ArrayLike<number>, clamp);
    const ranged = Int32Array.from({ length: 4 }, (_, index) => index * -3);
    const samples = [{ s: 1.25 }, { s: 2 }];
    const picked = Float32Array.from(samples, (sample) => sample.s);
    const lanes = Float64Array.from(floats, (value) => value / 2);
    if (calls !== "012" || mapped[0] !== 6 || mapped[1] !== 3 || mapped[2] !== 252 || named[0] !== 3 || named[2] !== 65534) throw new Error("mapped");
    if (ranged[3] !== -9 || picked[0] !== 1.25 || picked.length !== 2 || lanes[1] !== 0.75) throw new Error("mapped sources");
`,
);

check(
    "utf8-text-codecs",
    `
    const strict = new TextDecoder("UTF-8 ", { fatal: true });
    const encoder = new TextEncoder();
    function decodeName(bytes: Uint8Array, start: number, length: number): string {
        const decoder = new TextDecoder();
        return decoder.decode(bytes.subarray(start, start + length));
    }
    const document = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x32, 0x7d]);
    const parsed = JSON.parse(new TextDecoder().decode(document)) as { n: number };
    if (parsed.n !== 2) throw new Error("decoded document without its BOM");
    if (new TextDecoder("utf8", { ignoreBOM: true }).decode(document).length !== 8) throw new Error("kept BOM");
    if (decodeName(document, 4, 3) !== "\\"n\\"" || new TextDecoder().decode() !== "") throw new Error("views");
    const broken = new Uint8Array([0x61, 0xff, 0xed, 0xa0, 0x80]);
    if (new TextDecoder().decode(broken) !== "a\\ufffd\\ufffd\\ufffd\\ufffd") throw new Error("replacement");
    let name = "";
    try { strict.decode(broken); } catch (error) { name = (error as Error).name; }
    if (name !== "TypeError") throw new Error("fatal decode");
    const fatal = true;
    const settings = { fatal, ignoreBOM: false, label: "kept" };
    let refused = 0;
    for (const decoder of [new TextDecoder("utf-8", { fatal }), new TextDecoder("utf-8", settings)]) {
        try { decoder.decode(broken); } catch { refused++; }
    }
    if (refused !== 2) throw new Error("shorthand and record options");
    const encoded = encoder.encode("\\u00e9\\u20ac\\ud800");
    if (encoded.length !== 8 || encoded[0] !== 0xc3 || encoded[2] !== 0xe2 || encoded[5] !== 0xef || encoded[7] !== 0xbd) throw new Error("encode");
    if (strict.decode(encoded.buffer) !== "\\u00e9\\u20ac\\ufffd" || encoder.encode().length !== 0) throw new Error("round trip");
    const view = new DataView(encoded.buffer, 2, 3);
    if (new TextDecoder().decode(view) !== "\\u20ac") throw new Error("data view");
`,
);

check(
    "typed-array-array-methods",
    `
    const bytes = new Uint8Array([32, 32, 0, 7]);
    const padding = bytes.subarray(0, 2);
    const floats = new Float32Array([1.5, -2, 3]);
    const view = new Int16Array(new ArrayBuffer(8), 2, 3);
    view[0] = -4; view[1] = 9; view[2] = 2;
    if (padding.some((byte) => byte !== 0x20) || !padding.every((byte) => byte === 0x20)) throw new Error("predicates over a view");
    if (bytes.find((b) => b < 8) !== 0 || bytes.findIndex((b) => b === 7) !== 3 || bytes.find((b) => b > 99) !== undefined) throw new Error("find");
    if (floats.indexOf(3) !== 2 || !floats.includes(-2) || floats.lastIndexOf(9) !== -1 || floats.at(-1) !== 3) throw new Error("search");
    const missing: number[] = [1, NaN];
    if (!Float32Array.of(NaN).includes(NaN) || !missing.includes(NaN) || missing.indexOf(NaN) !== -1) throw new Error("includes is SameValueZero");
    if (floats.join("|") !== "1.5|-2|3" || view.join() !== "-4,9,2") throw new Error("join");
    if (floats.reduce((sum, value) => sum + value, 0) !== 2.5 || view.reduce((max, value) => Math.max(max, value), -99) !== 9) throw new Error("reduce");
    const doubled = floats.map((value) => value * 2);
    const wrapped = bytes.map((value) => value * 10);
    const kept = view.filter((value) => value > 0);
    if (!(doubled instanceof Float32Array) || doubled[1] !== -4 || wrapped[0] !== 64 || wrapped[3] !== 70) throw new Error("map keeps the kind");
    if (!(kept instanceof Int16Array) || kept.length !== 2 || kept[1] !== 2) throw new Error("filter keeps the kind");
    let order = "";
    floats.forEach((value, index) => { order += index + ":" + value + ";"; if (index === 0) floats[2] = 8; });
    if (order !== "0:1.5;1:-2;2:8;") throw new Error("forEach reads live elements");
    const sorted = new Float64Array([3, NaN, -0, 0, -1]);
    if (sorted.sort() !== sorted || sorted.join() !== "-1,0,0,3,NaN" || !Object.is(sorted[1], -0)) throw new Error("numeric sort");
    view.sort((a, b) => b - a);
    if (view.join() !== "9,2,-4" || new Uint8Array(view.buffer)[2] !== 9) throw new Error("comparator sort writes the view");
`,
);

test("typed-array from refuses sources it reads differently from the constructor", () => {
    for (const [source, message] of [
        [
            "const b = new ArrayBuffer(8); const t = Float32Array.from(b as unknown as ArrayLike<number>); const unused = t.length;",
            /Float32Array\.from expects a numeric sequence/,
        ],
        [
            "const n = 4; const t = Uint8Array.from(n as unknown as ArrayLike<number>); const unused = t.length;",
            /Uint8Array\.from expects a numeric sequence/,
        ],
        [
            "const xs = [1, 2]; const t = Int32Array.of(...xs); const unused = t.length;",
            /Int32Array\.of takes its elements as separate arguments/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

test("typed-array callbacks refuse the array parameter", () => {
    assert.throws(
        () =>
            compileSource(
                "const f = new Float32Array(2); f.forEach((v, i, a) => { a[i] = v + 1; });",
            ),
        /typed array's forEach callback takes no array parameter/,
    );
});

check(
    "atomics-access-integer-typed-arrays",
    `
    const HDR_SEQ = 0, HDR_FRONT = 1;
    if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") throw new Error("typeof");
    const sab = new SharedArrayBuffer(16);
    const header = new Int32Array(sab, 0, 4);
    const buffers: [Float32Array, Float32Array] = [new Float32Array(2), new Float32Array(2)];
    buffers[1][0] = 7;
    function copyStable(view: Int32Array | null): number {
        if (!view) return -1;
        const s0 = Atomics.load(view, HDR_SEQ);
        const value = buffers[Atomics.load(view, HDR_FRONT)]![0]!;
        return Atomics.load(view, HDR_SEQ) === s0 ? value : -2;
    }
    if (Atomics.store(header, HDR_FRONT, 1.9) !== 1 || copyStable(header) !== 7 || copyStable(null) !== -1) throw new Error("load and store");
    if (!Object.is(Atomics.store(header, 2, -0.5), 0) || Atomics.store(header, 2, Infinity) !== Infinity || header[2] !== 0) throw new Error("store result");
    const bytes = new Uint8Array(4);
    if (Atomics.add(bytes, 0, 250) !== 0 || Atomics.add(bytes, 0, 10) !== 250 || bytes[0] !== 4) throw new Error("add wraps");
    if (Atomics.sub(bytes, 1, 1) !== 0 || bytes[1] !== 255) throw new Error("sub wraps");
    const words = new Int16Array([0x0f0f]);
    if (Atomics.and(words, 0, 0x00ff) !== 0x0f0f || Atomics.or(words, 0, 0x7000) !== 0x000f) throw new Error("and, or");
    if (Atomics.xor(words, 0, -1) !== 0x700f || words[0] !== ~0x700f) throw new Error("xor");
    if (Atomics.exchange(words, 0, 70000) !== ~0x700f || words[0] !== 4464) throw new Error("exchange converts");
    const unsigned = new Uint32Array([5]);
    if (Atomics.compareExchange(unsigned, 0, 4, 9) !== 5 || unsigned[0] !== 5) throw new Error("compareExchange miss");
    if (Atomics.compareExchange(unsigned, 0, 5 + 2 ** 32, -1) !== 5 || unsigned[0] !== 4294967295) throw new Error("compareExchange converts");
    if (Atomics.load(new Int8Array([-3]), 0.9) !== -3 || Atomics.load(header, NaN) !== 0) throw new Error("index conversion");
    if (Atomics.notify(header, 0) !== 0 || Atomics.notify(header, 0, 3) !== 0) throw new Error("notify");
    const sizes = [1, 2, 3, 4, 8];
    let lockFree = "";
    for (const size of sizes) lockFree += Atomics.isLockFree(size) ? "t" : "f";
    if (lockFree !== "ttftt" || !Atomics.isLockFree(4)) throw new Error("isLockFree " + lockFree);
    let ranges = "";
    for (const index of [4, -1, Infinity, 2 ** 53]) {
        try { Atomics.load(header, index); ranges += "none;"; }
        catch (error) { ranges += error instanceof RangeError ? "r" : "other;"; }
    }
    let order = "";
    function at(index: number): number { order += "i"; return index; }
    function value(v: number): number { order += "v"; return v; }
    try { Atomics.store(header, at(9), value(1)); } catch (error) { order += error instanceof RangeError ? "r" : "x"; }
    if (ranges !== "rrrr" || order !== "ivr") throw new Error("range " + ranges + order);
    const plain = new Int32Array(new ArrayBuffer(8));
    Atomics.store(plain, 1, 3);
    if (plain[1] !== 3 || plain.buffer instanceof SharedArrayBuffer || !(header.buffer instanceof SharedArrayBuffer)) throw new Error("brand");
    const buffers2: ArrayBufferLike[] = [sab, plain.buffer, sab.slice(4)];
    let brands = "";
    for (const buffer of buffers2) brands += (buffer instanceof SharedArrayBuffer ? "s" : "") + (buffer instanceof ArrayBuffer ? "a" : "");
    if (brands !== "sas" || sab.slice(4).byteLength !== 12) throw new Error("brands " + brands);
`,
);

test("Atomics refuse forms one realm cannot represent", () => {
    for (const [source, message] of [
        [
            "const v = new Int32Array(new SharedArrayBuffer(8)); Atomics.wait(v, 0, 0);",
            /Atomics\.wait suspends an agent until another agent notifies it/,
        ],
        [
            "function f(a: Int32Array | Uint8Array) { return Atomics.load(a, 0); } f(new Uint8Array(2));",
            /Atomics\.load takes one integer typed-array kind/,
        ],
        [
            "const b = new SharedArrayBuffer(8, { maxByteLength: 16 });",
            /new SharedArrayBuffer takes one byte length/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "string-substr-and-base64",
    `
    const s = ["abcdef", "a\u{1F600}b"];
    const text = s[0]!;
    function sub(start: number, length?: number): string { return text.substr(start, length); }
    const starts = [1, -3, -10, 4, 2, 2, NaN, 6, Infinity];
    const lengths = [2, 2, 2, 10, 0, -1, 2, 1, 1];
    const expected = ["bc", "de", "ab", "ef", "", "", "ab", "", ""];
    for (let index = 0; index < starts.length; index++)
        if (sub(starts[index]!, lengths[index]!) !== expected[index]) throw new Error("substr " + index);
    if (sub(2) !== "cdef" || sub(2, undefined) !== "cdef") throw new Error("absent length");
    if (text.substr(3) !== "def" || s[1]!.substr(1, 2) !== "\u{1F600}" || s[1]!.substr(2, 1) !== "\\ude00") throw new Error("substr units");
    const plain = ["ab", "", "f", "fo", "foo", "\\u00ff\\u0000"];
    for (const value of plain)
        if (btoa(value) !== ["YWI=", "", "Zg==", "Zm8=", "Zm9v", "/wA="][plain.indexOf(value)] || atob(btoa(value)) !== value) throw new Error("base64 " + value);
    if (atob(" Zm 9v\\n") !== "foo" || atob("Zg") !== "f" || atob("Zm8") !== "fo" || atob("") !== "") throw new Error("forgiving decode");
    if (btoa(String(12)) !== "MTI=") throw new Error("ToString");
    let invalid = "";
    for (const value of ["Zm9v=", "Z", "Zm9v!", "Zg=a", "Z===", "Zm=="])
        try { atob(value); invalid += "ok;"; } catch (error) { invalid += (error as Error).name === "InvalidCharacterError" ? "e" : "other;"; }
    try { btoa("Ā"); invalid += "ok;"; } catch (error) { invalid += (error as Error).name === "InvalidCharacterError" ? "e" : "other;"; }
    if (invalid !== "eeeeeok;e") throw new Error("invalid " + invalid);
    const pair = [5, 6];
    const keys = [...pair.keys()];
    if (keys.length !== 2 || keys[1] !== 1) throw new Error("tuple keys");
`,
);

test("structuredClone refuses shapes without a clone codec", () => {
    assert.throws(
        () =>
            compileSource(
                "class K { n = 1; } const k = structuredClone(new K()); const n = k.n;",
            ),
        /structuredClone 'value' is an instance of class K/,
    );
    for (const options of [
        "{ transfer: [bytes.buffer] }",
        "selected",
        "{ ...selected }",
    ])
        assert.throws(
            () =>
                compileSource(
                    `const bytes = new Uint8Array(2); const selected: StructuredSerializeOptions = {}; const copy = structuredClone(bytes, ${options}); if (copy.length !== 2) throw new Error("copy");`,
                ),
            /structuredClone options admit only an empty literal transfer list/,
        );
});

check(
    "typed-array-classes-are-values",
    `
    const a = new Int32Array(2);
    const B = a.constructor;
    if (B !== Int32Array || a.constructor === Float32Array || !(Uint8Array === new Uint8Array(1).constructor)) throw new Error("class identity");
    const made = new B(3);
    if (made.length !== 3 || typeof Int32Array !== "function") throw new Error("construct through the class");
`,
);

check(
    "uint8-clamped-arrays-clamp-and-round-half-to-even",
    `
    const a = new Uint8ClampedArray([300, -5, 1.5, 2.5, 0.5, 254.5, 253.5, NaN, Infinity, -Infinity, 127.4999]);
    const expected = [255, 0, 2, 2, 0, 254, 254, 0, 255, 0, 127];
    for (let index = 0; index < expected.length; index++)
        if (a[index] !== expected[index]) throw new Error("clamp " + index);
    a[0] = 3.5;
    a[1] = -1;
    if (a[0] !== 4 || a[1] !== 0) throw new Error("store");
    const sized = new Uint8ClampedArray(3);
    sized.set([1000, 2.5], 1);
    if (sized[0] !== 0 || sized[1] !== 255 || sized[2] !== 2) throw new Error("set");
    const view = new Uint8ClampedArray(new Uint8Array([7, 8, 9]).buffer, 1, 2);
    if (view[0] !== 8 || view.length !== 2 || !(view instanceof Uint8ClampedArray) || view.constructor !== Uint8ClampedArray) throw new Error("view");
    const doubled = view.map((value) => value * 100);
    if (doubled[0] !== 255 || doubled[1] !== 255) throw new Error("map keeps the kind");
    if (a.join() !== "4,0,2,2,0,254,254,0,255,0,127" || a.indexOf(254) !== 5 || !a.includes(127)) throw new Error("search");
    if (Uint8ClampedArray.from([-1, 256, 3.5]).join("|") !== "0|255|4") throw new Error("from");
`,
);

check(
    "buffer-source-unions",
    `
    function sourceBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
        return source instanceof ArrayBuffer
            ? new Uint8Array(source)
            : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    function magic(source: ArrayBuffer | ArrayBufferView): number {
        const bytes = sourceBytes(source);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return view.getUint32(0, true);
    }
    const buffer = new ArrayBuffer(12);
    new DataView(buffer).setUint32(4, 0x46546c67, true);
    if (magic(buffer) !== 0 || magic(new Uint8Array(buffer, 4)) !== 0x46546c67) throw new Error("buffer and byte view");
    if (magic(new DataView(buffer, 4, 8)) !== 0x46546c67 || magic(new Uint32Array(buffer, 4, 1)) !== 0x46546c67) throw new Error("other views");
    const sources: (ArrayBuffer | Uint8Array)[] = [buffer, new Uint8Array(buffer, 8)];
    let kinds = "";
    for (const source of sources) kinds += source instanceof ArrayBuffer ? "b" + source.byteLength : "v" + source.length;
    if (kinds !== "b12v4") throw new Error("stored sources");
    function text(source: ArrayBuffer | ArrayBufferView): string { return new TextDecoder().decode(source); }
    if (text(new Uint8Array([104, 105])) !== "hi" || text(new Uint8Array([111, 107]).buffer) !== "ok") throw new Error("decoded sources");
    function width(indices: Uint16Array | Uint32Array): number { return indices instanceof Uint32Array ? indices.length * 4 : indices.length * 2; }
    if (width(new Uint16Array(3)) !== 6 || width(new Uint32Array(3)) !== 12) throw new Error("typed-array unions");
`,
);

check(
    "buffer-view-storage",
    `
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
`,
);

check(
    "typed-array-set-and-constructor-sources",
    `
    function negate(m: Float32Array): Float32Array | null { return m[0] === 0 ? null : Float32Array.from(m, (v) => -v); }
    const identity = new Float32Array([1, 0, 0, 1]);
    const target = new Float32Array(12);
    const inverse = negate(new Float32Array([2, 3]));
    if (inverse) target.set(inverse as ArrayLike<number>);
    target.set((negate(new Float32Array([0])) ?? identity) as unknown as ArrayLike<number>, 4);
    const checked = negate(new Float32Array([5]));
    if (!checked) throw new Error("present source");
    target.set(checked as unknown as ArrayLike<number>, 8);
    if (target.join() !== "-2,-3,0,0,1,0,0,1,-5,0,0,0") throw new Error("narrowed and selected sources");
    interface Part { uvs: Float32Array; uvs2?: Float32Array; mask?: Uint8Array; }
    const merged: Part = { uvs: new Float32Array(4), uvs2: new Float32Array(4), mask: new Uint8Array(3) };
    const parts: Part[] = [{ uvs: new Float32Array([1, 2]) }, { uvs: new Float32Array([3, 4]), uvs2: new Float32Array([7, 8]), mask: new Uint8Array([256, 9]) }];
    let offset = 0;
    for (const part of parts) {
        merged.uvs2?.set(part.uvs2 ?? part.uvs, offset);
        if (part.mask) merged.mask?.set(part.mask, offset / 2);
        offset += 2;
    }
    if (merged.uvs2!.join() !== "1,2,7,8" || merged.mask!.join() !== "0,0,9") throw new Error("optional targets and sources");
    function load(into: Float32Array, source: Float32Array | Float64Array, at: number): void { into.set(source, at); }
    const lanes = new Float32Array(3);
    load(lanes, new Float64Array([0.1, 2]), 1);
    load(lanes, new Float32Array([4]), 0);
    if (lanes[0] !== 4 || lanes[1] !== Math.fround(0.1) || lanes[2] !== 2) throw new Error("union source converts its member");
    const unique = Float32Array.from(new Set([3, 1, 3]));
    const wrapped = new Uint16Array(new Set([70000, -1]));
    if (unique.join() !== "3,1" || wrapped.join() !== "4464,65535") throw new Error("Set sources");
    const words = new Uint16Array([1, 65535, 7]);
    const widened = Uint32Array.from(new Uint16Array(words.buffer, 2, 2));
    const signed = new Int8Array(new Uint8Array([200, 5]));
    if (widened.join() !== "65535,7" || signed.join() !== "-56,5") throw new Error("constructed sources");
    const shared = new Uint8Array([1, 2, 3, 4, 5]);
    shared.set(shared.subarray(0, 3), 2);
    if (shared.join() !== "1,2,1,2,3") throw new Error("overlapping set");
`,
);

check(
    "array-buffer-slice",
    `
    const bin = new ArrayBuffer(12);
    const bytes = new Uint8Array(bin);
    for (let i = 0; i < 12; i++) bytes[i] = i;
    const middle = bin.slice(4, 8);
    bytes[5] = 99;
    if (middle.byteLength !== 4 || new Uint8Array(middle)[1] !== 5 || middle === bin) throw new Error("slice copies its range");
    if (new Uint8Array(bin.slice(-3))[0] !== 9 || bin.slice(-3).byteLength !== 3) throw new Error("relative begin");
    if (bin.slice(8, 4).byteLength !== 0 || bin.slice().byteLength !== 12 || bin.slice(2, 100).byteLength !== 10 || bin.slice(1, -1).byteLength !== 10) throw new Error("clamped range");
    const words = new Uint32Array(bin.slice(4, 12));
    const floats = new Float32Array(bin.slice(0, 8));
    if (words.length !== 2 || words[1] !== 0x0b0a0908 || floats.length !== 2) throw new Error("views over a slice");
    const widened = Uint32Array.from(new Uint16Array(bin.slice(8, 12)));
    if (widened.join() !== "2312,2826") throw new Error("from over a constructed view");
    if (bytes.subarray(-2).join() !== "10,11" || bytes.slice(-3, -1).join() !== "9,10" || bytes.subarray(10, 2).length !== 0) throw new Error("relative Uint8Array ranges");
`,
);

check(
    "typed-array-union-reads",
    `
    function bytes(values: Float32Array | Uint32Array): Uint8Array {
        return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    }
    const floats = new Float32Array([1]);
    const viewed = new Uint32Array(new ArrayBuffer(16), 4, 2);
    viewed[0] = 0x01020304;
    const fromFloats = bytes(floats), fromWords = bytes(viewed);
    if (fromFloats.length !== 4 || fromFloats[3] !== 0x3f || fromWords.length !== 8 || fromWords.byteOffset !== 4 || fromWords[0] !== 4) throw new Error("union buffer range");
    fromWords[1] = 0xff;
    if (viewed[0] !== 0x0102ff04) throw new Error("views alias the union member's buffer");
    function differs(published: Float32Array | Float64Array | undefined, count: number): boolean {
        if (!published || published.length < count) return true;
        for (let index = 0; index < count; index++) if (published[index] !== index) return true;
        return false;
    }
    if (differs(new Float64Array([0, 1, 2]), 3) || differs(new Float32Array([0, 1]), 2) || !differs(undefined, 1) || !differs(new Float32Array([0, 2]), 2) || !differs(new Float64Array(1), 2)) throw new Error("optional union length and elements");
    function connected(levels: Uint8Array | Int32Array | null): number {
        const lv = levels;
        const same = lv ? (a: number, b: number): boolean => lv[a] === lv[b] : undefined;
        let count = 0;
        for (let i = 1; i < 4; i++) if (same && same(i - 1, i)) count++;
        for (let i = 1; i < 4; i++) if (!levels || levels[i - 1] === -1) count += 10;
        return count;
    }
    if (connected(new Uint8Array([1, 1, 2, 2])) !== 2 || connected(new Int32Array([-1, -1, -1, 0])) !== 32 || connected(null) !== 30) throw new Error("union elements in closures");
    function pick(bytes: boolean): Uint8Array | Int32Array { return bytes ? new Uint8Array([255, 1]) : new Int32Array([-5, -6]); }
    const state = { current: pick(true) };
    let reads = 0;
    function next(): number { state.current = pick(false); return reads++; }
    const first = state.current[next()];
    if (first !== 255 || state.current[1] !== -6 || reads !== 1 || state.current.length !== 2) throw new Error("owner read before its index, index read once");
    function size(value: Float32Array | string): number { return value.length; }
    if (size("abc") + size(new Float32Array(2)) !== 5) throw new Error("length of a string or typed array");
`,
);

check(
    "typed-array-union-writes",
    `
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const colors = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const streams: (Float32Array | Uint8Array)[] = [positions, colors];
    for (const stream of streams) { stream.copyWithin(0, 2, 4); stream.fill(300.5, 4); }
    if (positions.join() !== "3,4,3,4,300.5,300.5" || colors.join() !== "30,40,30,40,44,44,44,44") throw new Error("fill and copyWithin through an array of typed arrays");
    const picked: Float32Array | Uint8Array = positions.length > 2 ? positions : colors;
    picked.fill(7, -1);
    picked.copyWithin(1, -1);
    if (positions.join() !== "3,7,3,4,300.5,7") throw new Error("a union binding writes the array it names");
    const lanes: ReadonlyArray<readonly [Float32Array | Uint8Array, number]> = [[positions, 3], [colors, 4]];
    let order = "";
    function index(at: number): number { order += at; return at; }
    for (const [stream, stride] of lanes) stream.copyWithin(index(0), stride, 2 * stride);
    if (positions.join() !== "4,300.5,7,4,300.5,7" || colors.join() !== "44,44,44,44,44,44,44,44" || order !== "00") throw new Error("copyWithin through a lane of a pair array");
    const extra = lanes.length > 1 ? new Float32Array([9, 8]) : null;
    const all: ReadonlyArray<readonly [Float32Array | Uint8Array, number]> = [
        [positions, 3], [colors, 4],
        ...(extra ? [[extra, 1] as const] : []),
    ];
    let total = 0;
    for (const [stream, stride] of all) { stream.set([1, 2], stride - 1); total += stream.length / stride; }
    if (total !== 6 || positions.join() !== "4,300.5,1,2,300.5,7" || colors[4] !== 2 || extra![0] !== 1) throw new Error("set and length through a lane");
    function head(stream: Float32Array | Uint8Array): number { return stream[0]!; }
    let heads = 0;
    for (const [stream] of lanes) heads += head(stream);
    for (const pair of lanes) pair[0].fill(pair[1], 0, 1);
    if (heads !== 48 || positions[0] !== 3 || colors[0] !== 4) throw new Error("a lane passed on and filled through its pair");
`,
);

check(
    "typed-array-spreads-and-reverse",
    `
    const floats = new Float32Array([1.5, -2, 3]);
    const copied = [...floats];
    copied[0] = 9;
    const joined = [0, ...new Uint8Array([7, 8]), 9];
    if (copied.length !== 3 || copied[0] !== 9 || floats[0] !== 1.5 || joined.join() !== "0,7,8,9") throw new Error("array spreads");
    const text = new Uint8Array([104, 105, 33, 63]);
    if (String.fromCharCode(...text.subarray(0, 3)) !== "hi!" || String.fromCharCode(72, ...text.subarray(1, 2)) !== "Hi") throw new Error("fromCharCode spreads");
    let chunked = "";
    for (let i = 0; i < text.length; i += 3) chunked += String.fromCharCode(...text.subarray(i, i + 3));
    interface Analysis { errors: Float32Array; }
    const analysis: Analysis = { errors: new Float32Array([0.5, 2]) };
    const metadata = { errors: [...analysis.errors] };
    analysis.errors[0] = 7;
    if (chunked !== "hi!?" || metadata.errors.join() !== "0.5,2") throw new Error("chunked and record-field spreads");
    if (Math.max(...floats) !== 3 || Math.min(...floats, ...new Int8Array([-7])) !== -7 || Math.max(...new Float64Array(0)) !== -Infinity) throw new Error("Math spreads");
    const order = new Float32Array([1, 2, 3, 4]);
    const reversed = order.reverse();
    if (reversed !== order || order.join() !== "4,3,2,1") throw new Error("reverse in place");
    const view = new Int16Array(new ArrayBuffer(10), 2, 3);
    view.set([1, 2, 3]);
    view.subarray(1).reverse();
    if (view.join() !== "1,3,2" || new Int16Array(view.buffer)[2] !== 3) throw new Error("reverse through a view");
`,
);

check(
    "typed-array-view-optional-offset",
    `
    interface Layout { byteLength?: number; }
    function tail(bin: ArrayBuffer, layout: Layout): Uint8Array { return new Uint8Array(bin, layout.byteLength); }
    const bin = new ArrayBuffer(6);
    if (tail(bin, { byteLength: 4 }).length !== 2 || tail(bin, {}).length !== 6 || tail(bin, {}).byteOffset !== 0) throw new Error("optional byte offset");
    function floats(buffer: ArrayBuffer, offset: number | undefined, length: number): Float32Array { return new Float32Array(buffer, offset, length); }
    const buffer = new ArrayBuffer(16);
    if (floats(buffer, 8, 2).byteOffset !== 8 || floats(buffer, undefined, 3).length !== 3 || floats(buffer, undefined, 1).byteOffset !== 0) throw new Error("optional offset with a length");
`,
);

check(
    "binary-asserted-and-default-absent-values",
    `
    const worldOf = new Map<number, Float32Array>();
    worldOf.set(1, new Float32Array([4, 5]));
    interface Root { name: string; world: Float32Array; }
    function root(inherited: Root | null, starts: boolean): Root | null {
        return starts ? { name: "n", world: worldOf.get(1)! } : inherited;
    }
    const made = root(null, true);
    if (!made || made.world !== worldOf.get(1) || root(made, false) !== made || root(null, false) !== null) throw new Error("asserted map value in a record");
    made.world[0] = 9;
    if (worldOf.get(1)![0] !== 9) throw new Error("asserted value aliases the stored array");
    function first(n: number, policies: Uint8Array | undefined = undefined): number { return policies ? policies[0]! : n; }
    function count(values: number[] | undefined = undefined): number { return values ? values.length : -1; }
    const firsts: Array<typeof first> = [first];
    const counts: Array<typeof count> = [count];
    if (firsts[0]!(2) !== 2 || firsts[0]!(2, new Uint8Array([7])) !== 7 || firsts[0]!(3, undefined) !== 3) throw new Error("undefined default of a stored function");
    if (counts[0]!() !== -1 || counts[0]!([1, 2]) !== 2) throw new Error("undefined default of an array parameter");
`,
);

check(
    "typed-array-constructor-values",
    `
    function grow<T extends Uint8Array | Int32Array | Float32Array>(value: T, length: number): T {
        const Constructor = value.constructor as { new (length: number): T };
        const next = new Constructor(length);
        next.set(value);
        return next;
    }
    const bytes = grow(new Uint8Array([1, 255]), 3);
    const floats = grow(new Float32Array([0.5]), 2);
    const words = grow(new Int32Array([-7]), 1);
    if (!(bytes instanceof Uint8Array) || bytes.join() !== "1,255,0" || !(floats instanceof Float32Array) || floats.join() !== "0.5,0" || words[0] !== -7) throw new Error("constructor of each kind");
    const source = new Uint16Array([70000, 3]);
    const Same = source.constructor as { new (length: number): Uint16Array; from(values: ArrayLike<number>): Uint16Array };
    const copied = Same.from([1, 65537]);
    if (copied.join() !== "1,1" || new Same(2).length !== 2 || copied === source) throw new Error("constructor statics");
    function factory(value: Float64Array): () => Float64Array {
        const Kind = value.constructor as { new (length: number): Float64Array };
        return () => new Kind(3);
    }
    if (factory(new Float64Array(1))().length !== 3) throw new Error("constructor captured by a closure");
`,
);

check(
    "typed-array-constructor-reads-as-callees",
    `
    function grow<T extends Uint8Array | Float32Array>(value: T, length: number): T {
        const next = new (value.constructor as { new (length: number): T })(length);
        next.set(value);
        return next;
    }
    function twin(value: Int16Array): Int16Array {
        return (value.constructor as { from(values: ArrayLike<number>): Int16Array }).from(value);
    }
    let reads = 0;
    const held = new Uint32Array([4, 5]);
    function source(): Uint32Array { reads++; return held; }
    const bytes = grow(new Uint8Array([1, 255]), 3);
    const floats = grow(new Float32Array([0.5]), 2);
    const copied = twin(new Int16Array([7, -3]));
    const sized = new (source().constructor as { new (length: number): Uint32Array })(2);
    if (!(bytes instanceof Uint8Array) || bytes.join() !== "1,255,0" || !(floats instanceof Float32Array) || floats.join() !== "0.5,0") throw new Error("new through the read");
    if (!(copied instanceof Int16Array) || copied.join() !== "7,-3") throw new Error("from through the read");
    if (!(sized instanceof Uint32Array) || sized.join() !== "0,0" || reads !== 1) throw new Error("owner evaluated once");
`,
);

check(
    "typed-array-or-number-array-parameter",
    `
    interface Field {
        restore(levels: Uint8Array | readonly number[]): boolean;
        readonly total: number;
    }
    function createField(): Field {
        const level = new Uint8Array(4);
        let total = 0;
        return {
            restore(levels) {
                let changed = false;
                for (let i = 0; i < level.length; i++) {
                    const v = Math.min(3, levels[i] ?? 0);
                    if (level[i] !== v) { level[i] = v; changed = true; }
                }
                total += levels.length;
                return changed;
            },
            get total() { return total; },
        };
    }
    const fields: Field[] = [createField()];
    const field = fields[0]!;
    if (!field.restore(new Uint8Array([1, 2, 9])) || field.restore([1, 2, 3]) || field.total !== 6) throw new Error("union reads");
`,
);

check(
    "typed-array-or-number-array-writes",
    `
    function pushPoint(out: Float32Array | number[], index: number, x: number): number {
        out[index * 2] = x;
        out[index * 2 + 1] = x + 0.1;
        return out.length;
    }
    const floats = new Float32Array(4);
    const numbers = [0, 0, 0, 0];
    if (pushPoint(floats, 1, 2) !== 4 || pushPoint(numbers, 0, 3) !== 4) throw new Error("lengths");
    if (floats[2] !== 2 || floats[3] !== Math.fround(2.1) || floats[0] !== 0) throw new Error("float lanes " + floats.join());
    if (numbers.join() !== "3,3.1,0,0") throw new Error("number lanes " + numbers.join());
`,
);

check(
    "typed-array-bytes-per-element",
    `
    const sizes = [Int8Array.BYTES_PER_ELEMENT, Uint8Array.BYTES_PER_ELEMENT, Uint8ClampedArray.BYTES_PER_ELEMENT, Int16Array.BYTES_PER_ELEMENT, Uint16Array.BYTES_PER_ELEMENT, Int32Array.BYTES_PER_ELEMENT, Uint32Array.BYTES_PER_ELEMENT, Float32Array.BYTES_PER_ELEMENT, Float64Array.BYTES_PER_ELEMENT, BigInt64Array.BYTES_PER_ELEMENT, BigUint64Array.BYTES_PER_ELEMENT];
    if (sizes.join() !== "1,1,1,2,2,4,4,4,8,8,8") throw new Error("class constants " + sizes.join());
    function floatsAt(section: Uint8Array, floats: number): Float32Array {
        return section.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
            ? new Float32Array(section.buffer, section.byteOffset, floats)
            : new Float32Array(Uint8Array.from(section).buffer, 0, floats);
    }
    const buffer = new ArrayBuffer(16);
    const whole = new Float32Array(buffer);
    whole[1] = 2.5;
    const aligned = floatsAt(new Uint8Array(buffer, 4, 8), 2);
    const copied = floatsAt(new Uint8Array(buffer, 2, 8), 2);
    if (aligned.buffer !== buffer || aligned[0] !== 2.5 || copied.buffer === buffer || copied.byteOffset !== 0) throw new Error("aligned view or copy");
    const words = new Uint32Array(3);
    if (words.BYTES_PER_ELEMENT * words.length !== words.byteLength || new BigInt64Array(1).BYTES_PER_ELEMENT !== 8) throw new Error("instance constants");
    const Kind = Int16Array;
    const ofView = words.constructor as Uint32ArrayConstructor;
    if (Kind.BYTES_PER_ELEMENT !== 2 || ofView.BYTES_PER_ELEMENT !== 4) throw new Error("class values");
    function pick(wide: boolean): Float64Array | Uint8Array { return wide ? new Float64Array(1) : new Uint8Array(1); }
    if (pick(true).BYTES_PER_ELEMENT !== 8 || pick(false).BYTES_PER_ELEMENT !== 1) throw new Error("union members");
    const order: string[] = [];
    function make(): Int8Array { order.push("make"); return new Int8Array(2); }
    function mark(step: string): number { order.push(step); return 0; }
    if (mark("left") + make().BYTES_PER_ELEMENT + mark("right") !== 1) throw new Error("owner constant");
    if (order.join() !== "left,make,right") throw new Error("owner evaluated once, in order " + order.join());
`,
);

test("typed-array unions and views refuse what they do not represent", () => {
    const pick =
        "function pick(text: boolean): Float32Array | string { return text ? 'ab' : new Float32Array(2); }";
    for (const [source, message] of [
        [
            "function pick(f: boolean): Float32Array | Uint8Array { return f ? new Float32Array(2) : new Uint8Array(2); } const v = pick(true); v[0] = 1;",
            /Element writes through a data union are not supported/,
        ],
        [
            `${pick} const v = pick(true); const unused = v[0];`,
            /Element access is not supported on data union/,
        ],
        [
            `${pick} const v = pick(true); const unused = (v as { byteLength: number }).byteLength;`,
            /Unsupported data property 'byteLength' on string/,
        ],
        [
            "function f(b: ArrayBuffer, n: number | undefined): Uint8Array { return new Uint8Array(b, 0, n); } const unused = f(new ArrayBuffer(2), 1);",
            /Expected number, received data/,
        ],
        [
            "const t = new Float32Array(2); const u = t.reverse(1 as never); const unused = u.length;",
            /TypedArray\.reverse expects no arguments/,
        ],
        [
            "const C = new Float32Array(1).constructor; const unused: string = C.name;",
            /Unsupported property value 'C\.name' \(owner typed-array-constructor/,
        ],
        [
            "interface Rec { n: number } const recs: Rec[] = [{ n: 1 }]; const made = new (recs[0]!.constructor as { new (): Rec })(); const unused = made.n;",
            /Struct Rec has no field 'constructor'/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "typed-array-held-in-a-parsed-document",
    `
    const doc = JSON.parse('{"id":1}') as { id: number; simOut?: Float32Array };
    const out = new Float32Array(4);
    doc.simOut = out;
    const read = doc.simOut;
    read[2] = 1.5;
    out[1] = 0.25;
    const back = doc.simOut!;
    const keys = Object.keys(doc).join(",");
    const checks = [back instanceof Float32Array, !Array.isArray(back), back.length === 4, back[1] === 0.25, out[2] === 1.5, back === out, keys === "id,simOut"];
    if (checks.some((ok) => !ok)) throw new Error("doc f32 " + checks.map((ok) => (ok ? "1" : "0")).join(""));
`,
);

check(
    "byte-arrays-held-in-a-parsed-document",
    `
    const doc = JSON.parse('{"id":1}') as { rows?: Uint8Array[]; mask?: Uint8Array };
    const mask = new Uint8Array([1, 2, 300]);
    doc.mask = mask;
    doc.rows = [new Uint8Array([4, 5]), mask];
    const rows = doc.rows!;
    const back = doc.mask!;
    back[0] = 9;
    const checks = [back instanceof Uint8Array, back === mask, mask[0] === 9, mask[2] === 44, rows.length === 2, rows[1] === mask, rows[0]![1] === 5];
    if (checks.some((ok) => !ok)) throw new Error("doc u8 " + checks.map((ok) => (ok ? "1" : "0")).join(""));
`,
);

check(
    "array-buffer-views-among-document-values",
    `
    function bytes(values: readonly unknown[]): number {
        let total = 0;
        for (const value of values) total += ArrayBuffer.isView(value) ? value.byteLength : 100;
        return total;
    }
    const mixed: unknown[] = [new Uint8Array(2), 3, "x", new Float32Array(1), [1]];
    if (bytes(mixed) !== 306) throw new Error("views " + bytes(mixed));
`,
);

check(
    "json-stringify-writes-a-typed-array-as-its-indices",
    `
    interface Animal { id: number; simOut: Float32Array | null; label?: string }
    const herd: unknown[] = [];
    function spawn(id: number): Animal {
      const animal: Animal = { id, simOut: null };
      herd.push(animal);
      return animal;
    }
    const a = spawn(1);
    const simOut = a.simOut ?? (a.simOut = new Float32Array(4));
    simOut[2] = 1.5;
    const doc = herd[0] as { simOut: Float32Array };
    const view = doc.simOut;
    view[1] = 0.25;
    const asText = JSON.stringify(herd[0]);
    if (!(view instanceof Float32Array) || Array.isArray(view) || view.length !== 4 || simOut[1] !== 0.25 || view[2] !== 1.5 || asText !== '{"id":1,"simOut":{"0":0,"1":0.25,"2":1.5,"3":0}}') throw new Error("f32 " + asText);
`,
);

check(
    "Uint8Array.set copies a source into the view at an offset",
    `
    function grow(source: Uint8Array, length: number): Uint8Array {
        const next = new Uint8Array(length);
        next.set(source, 0);
        return next;
    }
    function main(): void {
        const grown = grow(new Uint8Array([7, 8, 9]), 5);
        if (grown.join(",") !== "7,8,9,0,0") throw new Error("same-kind set " + grown.join(","));
        const view = grown.subarray(1, 5);
        view.set([1, 2], 2);
        if (grown.join(",") !== "7,8,9,1,2") throw new Error("array set through a subarray " + grown.join(","));
        let refused = false;
        const longer = new Uint8Array(3);
        try { view.set(longer, 2); } catch { refused = true; }
        if (!refused) throw new Error("a run past the end refuses");
    }
    main();
`,
);

check(
    "global-number-predicates-and-uri-codecs",
    `
    const values = [NaN, 1, Infinity, -0];
    if (!isNaN(values[0]!) || isNaN(values[1]!) || isNaN(values[2]!) || isFinite(values[2]!) || !isFinite(values[3]!))
        throw new Error("predicates");
    const texts = ["http://x.y/a b?q=1&r=\\u00e9#h[]", "a%20b%2Fc%3F%23%41", "a%20b%2Fc%3F%23%C3%A9%F0%9F%98%80"];
    if (encodeURI(texts[0]!) !== "http://x.y/a%20b?q=1&r=%C3%A9#h%5B%5D") throw new Error("encodeURI");
    if (encodeURIComponent(texts[0]!) !== "http%3A%2F%2Fx.y%2Fa%20b%3Fq%3D1%26r%3D%C3%A9%23h%5B%5D") throw new Error("encodeURIComponent");
    if (decodeURI(texts[1]!) !== "a b%2Fc%3F%23A") throw new Error("decodeURI keeps reserved escapes");
    if (decodeURIComponent(texts[2]!) !== "a b/c?#\\u00e9\\ud83d\\ude00") throw new Error("decodeURIComponent");
    if (decodeURIComponent(encodeURIComponent(texts[0]!)) !== texts[0]) throw new Error("round trip");
    const malformed = ["%", "%2", "%zz", "%C3", "%C3%28", "%E0%80%80", "%ED%A0%80", "%F8%80%80%80%80", "%80", "%C0%AF"];
    let refused = 0;
    for (const text of malformed) {
        try { decodeURIComponent(text); } catch (error) { if (error instanceof URIError) refused++; }
        try { decodeURI(text); } catch (error) { if (error instanceof URIError) refused++; }
    }
    if (refused !== malformed.length * 2) throw new Error("malformed " + refused);
    const lone = ["\\ud800"];
    let unpaired = false;
    try { encodeURI(lone[0]!); } catch (error) { unpaired = error instanceof URIError; }
    if (!unpaired) throw new Error("unpaired surrogate");
`,
);

check(
    "typed-array-and-array-length-range-errors",
    `
    const empty = new Float32Array(Number("x"));
    let typed = "";
    try { void new Uint8Array(-1); } catch (error) { typed = (error as Error).name; }
    const values = [1, 2, 3];
    let plain = "";
    try { values.length = -1; } catch (error) { plain = (error as Error).name; }
    if (empty.length !== 0 || typed !== "RangeError" || plain !== "RangeError") throw new Error("lengths " + typed + " " + plain);
`,
);

check(
    "bigint-values-exact-arithmetic",
    `
    const b = 10n;
    if (b * 2n !== 20n || typeof b !== "bigint") throw new Error("literal");
    const huge = 2n ** 100n;
    if (huge.toString() !== "1267650600228229401496703205376" || huge.toString(16) !== "10000000000000000000000000")
        throw new Error("power");
    if (huge / 3n !== 422550200076076467165567735125n || huge % 7n !== 2n) throw new Error("long division");
    let counter = 5n;
    counter += 3n;
    counter++;
    counter *= -2n;
    --counter;
    if (counter !== -19n) throw new Error("compound and update");
    if (-7n / 2n !== -3n || -7n % 2n !== -1n) throw new Error("truncating division");
    if (-5n >> 1n !== -3n || 1n << 70n !== 1180591620717411303424n || 8n >> -2n !== 32n) throw new Error("shift");
    if ((-6n & 3n) !== 2n || ~0n !== -1n || (5n ^ 3n) !== 6n || (-4n | 1n) !== -3n) throw new Error("bitwise");
    if (BigInt(42) !== 42n || BigInt("0x10") !== 16n || BigInt(" -12 ") !== -12n || BigInt(true) !== 1n) throw new Error("conversion");
    if (Number(huge) !== 2 ** 100 || Number(2n ** 53n + 1n) !== 2 ** 53 || String(-12n) !== "-12" || \`\${b}!\` !== "10!")
        throw new Error("text and number");
    if (BigInt.asIntN(8, 255n) !== -1n || BigInt.asUintN(8, -1n) !== 255n || BigInt.asIntN(64, 2n ** 63n) !== -(2n ** 63n))
        throw new Error("wrap");
    if (!(1n < 2) || !(3n > 2.5) || 2n < 1.5 || 2n >= Infinity || !(2n <= 2)) throw new Error("mixed comparison");
    const order: string[] = [];
    function step(label: string, value: bigint): bigint { order.push(label); return value; }
    if (step("a", 2n) - step("b", 3n) !== -1n || order.join("") !== "ab") throw new Error("operand order");
    const errors: string[] = [];
    const zero = [0n][0]!;
    try { if (1n / zero) errors.push("none"); } catch (error) { errors.push(error instanceof RangeError ? "range" : "other"); }
    try { if (2n ** -zero - 1n) errors.push("ok"); } catch { errors.push("unexpected"); }
    try { if (BigInt(1.5)) errors.push("none"); } catch (error) { errors.push(error instanceof RangeError ? "range" : "other"); }
    try { if (BigInt("1.5")) errors.push("none"); } catch (error) { errors.push(error instanceof SyntaxError ? "syntax" : "other"); }
    if (errors.join(",") !== "range,range,syntax") throw new Error("errors " + errors.join(","));
    if (zero || !huge) throw new Error("truthiness");
    const list: bigint[] = [1n, 2n, 3n];
    if (list.indexOf(2n) !== 1 || !list.includes(3n)) throw new Error("search");
`,
);

test("BigInt operators refuse Number operands and unrepresented conversions", () => {
    for (const [source, message] of [
        [
            "const x = [1n][0]!; const y = x + (1 as unknown as bigint); export {};",
            /A BigInt operator's operands are both BigInts/,
        ],
        [
            "const x = [1n][0]!; const s = JSON.stringify({ x }); export {};",
            /JSON\.stringify does not serialize a 'bigint' value/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

test("BigInt, Symbol and tagged-template headers come only with their families", () => {
    const headers = (source: string): string[] => {
        const cpp = compileSource(source).cpp;
        return ["js_bigint", "js_symbol", "js_template"].filter((header) =>
            cpp.includes(`#include <bblite/${header}.hpp>`),
        );
    };
    assert.deepEqual(
        headers(
            "const x = [1, 2]; x.push(3); if (x.length !== 3) throw new Error(); export {};",
        ),
        [],
    );
    assert.deepEqual(
        headers(
            "const x = [1n][0]!; if (x + 1n !== 2n) throw new Error(); export {};",
        ),
        ["js_bigint"],
    );
    assert.deepEqual(
        headers(
            'const s = Symbol("k"); if (s.description !== "k") throw new Error(); export {};',
        ),
        ["js_symbol"],
    );
    assert.deepEqual(
        headers(
            'function tag(strings: TemplateStringsArray): string { return strings.raw.join("|"); }\n' +
                'if (tag`a${1}b` !== "a|b") throw new Error(); export {};',
        ),
        ["js_template"],
    );
});

check(
    "bigint-typed-arrays",
    `
    const a = new BigInt64Array(2);
    if (a.length !== 2 || a[0] !== 0n || a.byteLength !== 16) throw new Error("length");
    a[0] = -5n;
    a[1] = 2n ** 63n;
    if (a[0] !== -5n || a[1] !== -(2n ** 63n)) throw new Error("signed wrap");
    a[0] += 7n;
    if (a[0] !== 2n) throw new Error("compound element");
    const u = new BigUint64Array([1n, -1n]);
    if (u[1] !== 2n ** 64n - 1n) throw new Error("unsigned wrap");
    const view = new BigUint64Array(a.buffer, 8, 1);
    if (view[0] !== 2n ** 63n || view.byteOffset !== 8) throw new Error("buffer view");
    view[0] = 1n;
    if (a[1] !== 1n) throw new Error("shared bytes");
    const copy = new BigInt64Array(u);
    if (copy[1] !== -1n || copy.buffer === u.buffer) throw new Error("copy");
`,
);

check(
    "typed-arrays-view-shared-array-buffers",
    `
    const shared = new SharedArrayBuffer(16);
    const values = new Float32Array(shared);
    values[0] = 1.5;
    const again = new Float32Array(shared);
    if (again[0] !== 1.5 || values.buffer !== shared || !(values.buffer instanceof SharedArrayBuffer)) throw new Error("shared view");
`,
);

test("crypto.getRandomValues fills integer typed arrays in place", async (t) => {
    const source = `
        const bytes = new Uint8Array(16);
        const same = crypto.getRandomValues(bytes);
        const words = crypto.getRandomValues(new Uint32Array(4));
        let filled = false;
        for (let tries = 0; tries < 4 && !filled; tries++) {
            crypto.getRandomValues(bytes);
            filled = bytes.some((value) => value !== 0) && words.some((value) => value !== 0);
        }
        if (same !== bytes || words.length !== 4 || !filled) throw new Error("random values");
    `;
    const result = compileSource(source, { fileName: "random-values.ts" });
    assert.ok(result.manifest.features.includes("data:crypto"));
    await executeGeneratedAssertions(t, "random-values", result.cpp);
    assert.throws(
        () => compileSource(`crypto.getRandomValues(new Float32Array(2));`),
        /fills an integer typed array/,
    );
    assert.throws(
        () =>
            compileSource(`const xs = [1]; Array.prototype.push.call(xs, 2);`),
        /borrows a library method for another receiver/,
    );
});

check(
    "a bigint key is its decimal text",
    `
    const o = { 1n: "one" };
    if (o[1] !== "one") throw new Error("bigint key");
    `,
);
