import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

// The generic TypeScript user-code surface: every source below runs its own
// assertions in JavaScript first, then the generated C++ must build and run
// them identically.
const native = optionalNativeFixtureTools(false);

check(
    "indexed-boolean-presence-in-optional-sinks",
    `
    const flags: boolean[] = [false, true];
    interface State { flag: boolean | undefined; }
    function retain(flag: boolean | undefined): State { return {flag}; }
    const indices = new Float32Array([2, 0, 1]);
    for (const index of indices) {
        const selected = flags[index];
        const state: State = {flag: selected};
        const saved: Array<boolean | undefined> = [selected];
        const result = retain(selected);
        if (index === 2) {
            if (state.flag !== undefined || saved[0] !== undefined || result.flag !== undefined)
                throw new Error("missing scalar became present");
        } else if (index === 0) {
            if (state.flag !== false || saved[0] !== false || result.flag !== false)
                throw new Error("false scalar became absent");
        } else if (state.flag !== true || saved[0] !== true || result.flag !== true)
            throw new Error("present scalar changed");
    }
`,
);

check(
    "cyclic-class-record-materialization",
    `
    class World {
        seed: number;
        readonly light: Light;
        readonly chunks = new Map<string, number>();
        constructor(seed: number) { this.seed = seed; this.light = new Light(this); }
    }
    class Light {
        readonly world: World;
        constructor(world: World) { this.world = world; }
        update(): void { this.world.seed++; this.world.chunks.set("origin", this.world.seed); }
    }
    class Renderer {
        readonly world: World;
        constructor(world: World) { this.world = world; }
        render(): void { this.world.light.update(); }
    }
    const world = new World(3);
    const renderer = new Renderer(world);
    renderer.render();
    if (world.seed !== 4 || renderer.world.seed !== 4 || world.light.world.seed !== 4 ||
        world.chunks.get("origin") !== 4) throw new Error("cyclic owner alias");
    world.seed = 8;
    renderer.render();
    if (world.seed !== 9 || world.light.world.seed !== 9) throw new Error("shared cyclic scalar");
`,
);

check(
    "partial-record-replaced-data-fields",
    `
    function choose<T>(value: T): T { return value; }
    interface State { select: typeof choose; point: {x: number; y: number}; }
    function create(): State { return {select: choose, point: {x: 1, y: 2}}; }
    const state = create();
    const original = state.point;
    const handlers: Array<() => void> = [];
    handlers.push(() => { state.point = {x: 7, y: 8}; });
    let observed = 0;
    handlers.push(() => { observed = state.point.x + state.point.y; });
    handlers[1]!();
    if (observed !== 3) throw new Error("deferred record replacement");
    handlers[0]!(); handlers[1]!();
    if (observed !== 15 || original === state.point || original.x !== 1) throw new Error("record field ownership");
    original.x = 9;
    if (state.point.x !== 7) throw new Error("replacement preserves old aliases");
`,
);

check(
    "computed-function-target-evaluation-order",
    `
    type Operation = (value: number) => number;
    const order: string[] = [];
    function plus(value: number): number { order.push("plus"); return value + 1; }
    function minus(value: number): number { order.push("minus"); return value - 1; }
    let current: Operation | undefined = plus;
    function read(): Operation | undefined { order.push("read"); return current; }
    function fallback(): Operation { order.push("fallback"); return minus; }
    function argument(): number { order.push("argument"); current = undefined; return 5; }
    if ((read() ?? fallback())(argument()) !== 6) throw new Error("selected target changed");
    if (order.join(",") !== "read,argument,plus") throw new Error("callee evaluated before arguments");
    if ((read() ?? fallback())(argument()) !== 4) throw new Error("missing target fallback");
    if (order.join(",") !== "read,argument,plus,read,fallback,argument,minus") throw new Error("lazy target fallback");
    const gate = new Float32Array([0]);
    if ((gate[0] ? plus : minus)(9) !== 8) throw new Error("conditional function target");
`,
);

check(
    "destructured-parameter-readonly-and-writable-facts",
    `
    const entries = Object.entries({left: 1, right: "saved", callback: () => 3});
    const selected = entries.find(([name]) => name === "right");
    if (!selected || selected[1] !== "saved") throw new Error("destructured readonly key");
    function update([text, amount, enabled]: [string, number, boolean]): string {
        text = "after";
        amount += 2;
        enabled = !enabled;
        return text + ":" + amount + ":" + enabled;
    }
    if (update(["before", 3, false]) !== "after:5:true") throw new Error("destructured writable scalars");
    function increment([record]: [{value: number}]): void { record.value++; }
    const record = {value: 5};
    increment([record]);
    if (record.value !== 6) throw new Error("destructured mutable record");
`,
);

check(
    "partial-record-declared-array-and-phase",
    `
    function choose<T>(value: T): T { return value; }
    interface State {
        select: typeof choose;
        phase: "loading" | "ready";
        cancel: () => void;
        charge: {value: number} | null;
        pending: {value: number} | undefined;
        readonly cleanup: Array<() => void>;
    }
    let oldCalls = 0;
    const state: State = {select: choose, phase: "loading", cancel: () => {oldCalls++;}, charge: null, pending: undefined, cleanup: []};
    const alias = state;
    let calls = 0;
    state.cleanup.push(() => {calls++; alias.phase = "ready";});
    alias.cleanup.push(choose(() => {calls += 2;}));
    const previous = state.cancel;
    function install(target: State): void { target.cancel = () => {calls += 4; target.charge = {value: 9}; target.pending = target.charge;}; }
    install(alias);
    state.cancel(); previous();
    if (!state.charge) throw new Error("nullable record initialized");
    const saved = state.charge;
    const kept = state.pending;
    alias.charge = null;
    alias.pending = undefined;
    if (saved.value !== 9 || state.charge !== null) throw new Error("nullable record alias");
    if (kept !== saved || kept?.value !== 9 || state.pending !== undefined) throw new Error("optional record alias");
    for (const callback of state.cleanup) callback();
    if (String(state.phase) !== "ready" || calls !== 7 || oldCalls !== 1 || alias.cleanup !== state.cleanup) throw new Error("partial record storage");
`,
);

check(
    "evolving-empty-array-storage",
    `
    const count = new Float32Array([3]);
    const rows = [];
    for (let index = 0; index < count[0]!; index++) rows.push({value: index});
    const alias = rows;
    alias[0]!.value = 9;
    if (rows.length !== 3 || rows[0]!.value !== 9 || rows[2]!.value !== 2) throw new Error("evolving array storage");
`,
);

check(
    "optional-call-comparison-evaluation-order",
    `
    const values: string[] = ["a", "b"];
    let calls = 0;
    function first(): string { calls++; values[0] = "x"; return "x"; }
    const equal = first() === values.shift();
    if (!equal || values.join(",") !== "b" || calls !== 1) throw new Error("right optional ordering");
    function second(): string { calls++; values[0] = "c"; return "b"; }
    const other = values.shift() === second();
    if (!other || values.join(",") !== "c" || calls !== 2) throw new Error("left optional snapshot");
    const log: number[] = [];
    function take(index: number): string | undefined { log.push(index); return values.shift(); }
    const pair = take(1) === take(2);
    if (pair || log.join(",") !== "1,2" || values.length !== 0) throw new Error("two optional calls");
`,
);

check(
    "conditional-numeric-tuple-array-identity",
    `
    const gate = new Float32Array([1]);
    const tuple: [number, number, number, number] = gate[0] ? [1, 2, 3, 4] : [5, 6, 7, 8];
    const array: number[] = tuple;
    array[0] = 9;
    tuple[1] = 10;
    if (tuple[0] !== 9 || array[1] !== 10 || array !== tuple) throw new Error("tuple array identity");
    const fixed: [number, number] = [1, 2];
    const alias: number[] = fixed;
    alias[0] = 7;
    if (fixed[0] !== 7 || alias !== fixed) throw new Error("tuple array static aliases");
`,
);

check(
    "callable-array-constructor-fill",
    `
    let evaluations = 0;
    function count(): number { evaluations++; return 3; }
    const words: string[] = Array(count()).fill("sound") as string[];
    const typed = Array<number>(2).fill(7);
    const values: number[] = Array<number>(2);
    values[0] = 4; values[1] = 9;
    if (evaluations !== 1 || words.join(",") !== "sound,sound,sound" || typed.join(",") !== "7,7" || values.join(",") !== "4,9") throw new Error("callable Array");
`,
);

check(
    "runtime-fixed-precision",
    `
    let number = 1.26;
    function precision(): number { number = 9; return 1; }
    const snapshot = number.toFixed(precision());
    function format(value: number, digits: number): string { return value.toFixed(digits); }
    if (snapshot !== "1.3" || format(4.6, 1.9) !== "4.6" || format(4.6, NaN) !== "5") throw new Error("toFixed runtime precision");
    let rejected = 0;
    for (const digits of [-1, 101, Infinity]) {
        try { format(1, digits); } catch { rejected++; }
    }
    if (rejected !== 3) throw new Error("toFixed precision range");
`,
);

check(
    "switch-on-temporary-string",
    `
    function classify(prefix: string, tail: string): number {
        switch (prefix + tail) {
            case "ab": return 1;
            case "abc": return 2;
            default: return 0;
        }
    }
    let total = 0;
    for (const tail of ["b", "bc", "x"]) total = total * 10 + classify("a", tail);
    if (total !== 120) throw new Error("switch on a concatenation " + total);
`,
);

check(
    "scoped-switch-returns",
    `
    function classify(value: number): number {
        switch (value) {
            case 0: { const local = 4; return local; }
            case 1: { if (value > 0) return 7; else throw new Error("unreachable"); }
            default: { const local = 9; return local; }
        }
    }
    let total = 0;
    for (const value of [0, 1, 2]) total += classify(value);
    if (total !== 20) throw new Error("scoped returns");
`,
);

check(
    "switch-fallthrough-and-final-clauses",
    `
    function final(k: number): number { let r = 0; switch (k) { case 1: r = 1; break; default: r = 2; } return r; }
    function through(k: number): number { let r = 0; switch (k) { case 1: r += 1; case 2: r += 10; break; default: r = 100; } return r; }
    function middle(k: number): string { let r = ""; switch (k) { case 1: r += "a"; default: r += "d"; case 2: r += "b"; break; case 3: r += "c"; } return r; }
    function early(k: string): number { let r = 0; switch (k) { case "a": r += 1; case "b": if (r > 0) break; r += 2; case "c": r += 4; } return r; }
    function trailing(k: number): number { let r = 0; switch (k) { case 1: r = 1; break; case 2: case 3: } return r; }
    if (final(1) !== 1 || final(3) !== 2) throw new Error("final clause");
    if (through(1) !== 11 || through(2) !== 10 || through(3) !== 100) throw new Error("fallthrough");
    if (middle(1) + middle(2) + middle(3) + middle(9) !== "adbbcdb") throw new Error("default in the middle");
    if (early("a") !== 1 || early("b") !== 6 || early("c") !== 4 || early("z") !== 0) throw new Error("early break");
    if (trailing(1) !== 1 || trailing(2) !== 0) throw new Error("trailing labels");
    const kind: string = "a";
    let folded = 0;
    switch (kind) { case "a": folded += 1; case "b": folded += 2; break; case "c": folded += 4; }
    if (folded !== 3) throw new Error("static fallthrough");
    let n = 0;
    for (let i = 0; i < 4; i++) {
        switch (i % 3) { case 0: n += 1; case 1: if (i === 1) continue; n += 10; break; default: n += 100; }
        n += 1000;
    }
    if (n !== 3122) throw new Error("continue through a fallthrough switch " + n);
    const stored: Array<typeof middle> = [middle];
    if (stored[0]!(1) !== "adb" || stored[0]!(9) !== "db") throw new Error("stored fallthrough");
`,
);

check(
    "switch-maybe-absent-discriminants",
    `
    type Reason = "wet" | "dry" | "far";
    function text(reason: string | null): number { switch (reason) { case null: return 0; case "prop": case "tree": return 1; default: return 2; } }
    function pick(reason: Reason | null | undefined): Reason | null { switch (reason) { case "wet": case "dry": return reason; default: return null; } }
    function both(reason: Reason | null | undefined): number { switch (reason) { case "wet": return 1; case null: return 2; case undefined: return 3; default: return 4; } }
    function field(input: { by?: Reason | null; wood: boolean }): string { switch (input.by) { case "wet": return "w"; case "far": return input.wood ? "f" : "g"; default: return "-"; } }
    function count(value?: number): number { switch (value) { case undefined: return 0; case 1: return 10; default: return -1; } }
    const texts: Array<typeof text> = [text];
    const picks: Array<typeof pick> = [pick];
    const boths: Array<typeof both> = [both];
    const fields: Array<typeof field> = [field];
    const counts: Array<typeof count> = [count];
    if (text("tree") !== 1 || text(null) !== 0 || text("x") !== 2) throw new Error("inline nullable string");
    if (texts[0]!("prop") !== 1 || texts[0]!(null) !== 0 || texts[0]!("x") !== 2) throw new Error("stored nullable string");
    if (pick("wet") !== "wet" || pick(null) !== null || picks[0]!("dry") !== "dry" || picks[0]!(undefined) !== null || picks[0]!("far") !== null) throw new Error("optional union");
    const all: Array<Reason | null | undefined> = ["wet", null, undefined, "dry"];
    let order = "";
    for (const reason of all) order += both(reason) + "" + boths[0]!(reason);
    if (order !== "11223344") throw new Error("null and undefined labels " + order);
    if (field({ by: "wet", wood: false }) !== "w" || field({ wood: true }) !== "-" || fields[0]!({ by: "far", wood: true }) !== "f" ||
        fields[0]!({ by: null, wood: true }) !== "-" || fields[0]!({ wood: false }) !== "-") throw new Error("optional field");
    if (count() !== 0 || counts[0]!() !== 0 || counts[0]!(1) !== 10 || counts[0]!(2) !== -1) throw new Error("optional number");
`,
);

test("switch refuses an absent label over a number", () => {
    assert.throws(
        () =>
            compileSource(
                "function f(v: number): number { switch (v) { case null: return 0; default: return 1; } } const unused = f(2);",
            ),
        /null or undefined case label requires a discriminant that holds null and undefined apart/,
    );
});

check(
    "unrolled-loop-runtime-exits",
    `
    interface Template { id: string; weight: number; when?: (n: number) => boolean; }
    const TEMPLATES: readonly Template[] = [
        { id: "a", weight: 1 },
        { id: "b", weight: 2, when: (n) => n > 2 },
        { id: "c", weight: 4, when: (n) => n > 5 },
        { id: "d", weight: 8, when: (n) => n !== 7 },
    ];
    function pick(n: number, stop: string): string {
        let text = "";
        let total = 0;
        for (const template of TEMPLATES) {
            if (template.when && !template.when(n)) continue;
            text += template.id;
            if (template.id === stop) break;
            total += template.weight;
        }
        return text + total;
    }
    function firstHeavy(n: number): string {
        let found = "-";
        for (const template of TEMPLATES) {
            if (template.when && !template.when(n)) continue;
            if (template.weight < 2) continue;
            found = template.id;
            break;
        }
        return found;
    }
    function labeled(n: number): number {
        let count = 0;
        outer: for (const template of TEMPLATES) {
            if (template.when && !template.when(n)) continue outer;
            if (template.weight > 4) break outer;
            count += template.weight;
        }
        return count;
    }
    if (pick(1, "z") !== "ad9" || pick(3, "c") !== "abd11" || pick(6, "b") !== "ab1" || pick(7, "x") !== "abc7")
        throw new Error("continue and break " + pick(1, "z") + pick(3, "c") + pick(6, "b") + pick(7, "x"));
    if (firstHeavy(1) !== "d" || firstHeavy(3) !== "b" || firstHeavy(7) !== "b") throw new Error("static exit after a runtime one");
    if (labeled(1) !== 1 || labeled(3) !== 3 || labeled(7) !== 7) throw new Error("labeled exits of the loop itself");
    const stored: Array<typeof pick> = [pick];
    if (stored[0]!(3, "d") !== "abd3") throw new Error("stored unrolled exits");
`,
);

check(
    "labeled-continue-of-an-outer-loop",
    `
    let n = 0;
    outer: for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (j === 1) continue outer;
            if (i === 2) break outer;
            n++;
        }
    }
    if (n !== 2) throw new Error("labeled continue " + n);
    let text = "";
    outer: for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            for (let k = 0; k < 3; k++) {
                if (k === 1) continue outer;
                text += "" + i + j + k + ",";
            }
            text += "x";
        }
        text += "y";
    }
    if (text !== "000,100,200,") throw new Error("deep labeled continue " + text);
    let i = 0;
    let sum = 0;
    scan: while (i < 4) {
        i++;
        const values = [1, 2, 3];
        for (const value of values) {
            if (value === i) continue scan;
            sum += value;
        }
        sum += 100;
    }
    if (sum !== 110) throw new Error("while labeled continue " + sum);
`,
);

test("labeled jumps refuse what they cannot leave", () => {
    const templates =
        "interface T { id: string; when?: (n: number) => boolean; } const TS: readonly T[] = [{ id: 'a' }, { id: 'b', when: (n) => n > 1 }]; let c = 0;";
    for (const [source, message] of [
        [
            `${templates} outer: for (const t of TS) { for (let i = 0; i < 3; i++) { if (t.when && t.when(i)) continue outer; c++; } }`,
            /labeled continue of a statically unrolled loop is not lowered/,
        ],
        [
            `${templates} outer: for (const t of TS) { for (let i = 0; i < 3; i++) { if (t.when && t.when(i)) break outer; c++; } }`,
            /labeled break out of a statically unrolled loop is not lowered/,
        ],
        [
            "let n = 0; outer: for (let i = 0; i < 3; i++) { switch (i) { case 1: for (let j = 0; j < 2; j++) { if (j === 1) continue outer; n++; } break; default: n += 10; } }",
            /labeled continue cannot leave a switch or try statement/,
        ],
        [
            "let n = 0; loop: for (let i = 0; i < 3; i++) { switch (i) { case 0: if (n > 0) break; n++; continue loop; default: n += 10; } n++; }",
            /switch case with an early break cannot also continue an enclosing loop/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "for-of-over-a-constructed-collection",
    `
    function plan(source: string, hosts: readonly string[] | undefined, known: (key: string) => boolean): string {
        const out: string[] = [];
        for (const seed of new Set<string>([source, ...(hosts ?? [])])) {
            if (!known(seed)) continue;
            if (seed === "stop") break;
            out.push(seed);
        }
        return out.join();
    }
    const plans: Array<typeof plan> = [plan];
    if (plan("a", ["b", "a", "c"], (key) => key !== "b") !== "a,c" || plans[0]!("a", undefined, () => true) !== "a" ||
        plans[0]!("a", ["stop", "z"], () => true) !== "a") throw new Error("constructed set");
    let keys = "";
    for (const [key, value] of new Map<string, number>([["x", 1], ["y", 2]])) keys += key + value;
    if (keys !== "x1y2") throw new Error("constructed map");
`,
);

check(
    "never-typed-returns",
    `
    interface Box { kind: string; size: number; tags: Map<string, number> }
    function fail(message: string): never { throw new Error("box: " + message); }
    function decode(text: string): Box {
        if (text.length === 0) fail("empty");
        let size: number;
        try {
            size = Number.parseInt(text, 10);
            if (Number.isNaN(size)) throw new Error("nan");
        } catch {
            return fail("malformed");
        }
        const tags = new Map<string, number>();
        tags.set("size", size);
        return { kind: "box", size, tags };
    }
    function message(text: string, decoder: (text: string) => Box): string {
        try { return "" + decoder(text).size; } catch (error) { return (error as Error).message; }
    }
    const decoders: Array<typeof decode> = [decode];
    if (decode("12").tags.get("size") !== 12 || message("x", decode) !== "box: malformed" || message("", decode) !== "box: empty")
        throw new Error("inline never returns");
    if (message("7", decoders[0]!) !== "7" || message("y", decoders[0]!) !== "box: malformed") throw new Error("stored never returns");
    const failures: Array<(message: string) => never> = [fail];
    function pick(index: number): number { if (index < 0) return failures[0]!("negative"); return index * 2; }
    const picks: Array<typeof pick> = [pick];
    let caught = "";
    try { picks[0]!(-1); } catch (error) { caught = (error as Error).message; }
    if (picks[0]!(3) !== 6 || caught !== "box: negative") throw new Error("stored never-returning callee " + caught);
`,
);

check(
    "getter-early-returns-and-boolean-predicates",
    `
    function counter(limit: number) {
        let disposed = false;
        const values = new Float32Array([1, 2, 3]);
        return {
            get value(): number {
                if (disposed || limit < 0) return -1;
                for (const v of values) if (v > limit) return v;
                return values[0]! > 0 ? 0 : 1;
            },
            dispose(): void { disposed = true; },
        };
    }
    function read(source: { readonly value: number }): number { return source.value; }
    const made: Array<typeof counter> = [counter];
    const c = made[0]!(1);
    if (read(c) !== 2 || counter(5).value !== 0 || counter(-1).value !== -1) throw new Error("getter early returns");
    c.dispose();
    if (read(c) !== -1) throw new Error("getter after dispose");
    function label(a: string, b: string): string { return [a.trim(), b.trim(), ""].filter(Boolean).join(" "); }
    const labels: Array<typeof label> = [label];
    const numbers = [0, 3, NaN, -1];
    if (label(" x ", "") !== "x" || labels[0]!("a", "b") !== "a b" || numbers.filter(Boolean).join() !== "3,-1" ||
        !numbers.some(Boolean) || numbers.every(Boolean) || numbers.find(Boolean) !== 3 || numbers.findIndex(Boolean) !== 1)
        throw new Error("Boolean predicate");
`,
);

check(
    "conditional-expression-statements",
    `
    let log = "";
    function a(): void { log += "a"; }
    function b(): number { log += "b"; return 1; }
    function c(): string { log += "c"; return "c"; }
    const set = new Set<string>();
    const values: number[] = [];
    function run(k: number): void { k === 0 ? a() : k === 1 ? b() : c(); }
    function toggle(key: string, on: boolean): void { on ? set.add(key) : set.delete(key); }
    function mixed(flag: boolean): void { flag ? a() : values.push(1); }
    const runs: Array<typeof run> = [run];
    const toggles: Array<typeof toggle> = [toggle];
    const mixes: Array<typeof mixed> = [mixed];
    run(0); runs[0]!(1); runs[0]!(2);
    toggles[0]!("a", true); toggles[0]!("b", true); toggles[0]!("a", false);
    mixes[0]!(true); mixes[0]!(false);
    const always = true;
    always ? a() : b();
    if (log !== "abcaa" || set.size !== 1 || !set.has("b") || values.length !== 1) throw new Error("conditional statements " + log);
`,
);

check(
    "exponent-compound-assignment",
    `
    const h = [2, 10];
    let p = h[0]! ** h[1]!;
    p **= 0.5;
    if (p !== 32) throw new Error("local");
    const o = { v: 3 };
    o.v **= 2;
    const a = [2];
    a[0]! **= 3;
    if (o.v !== 9 || a[0] !== 8) throw new Error("field and element");
    const edge = [1, -1, NaN, Infinity, 0];
    let one = edge[0]!;
    one **= edge[2]!;
    let minus = edge[1]!;
    minus **= edge[3]!;
    if (!Number.isNaN(one) || !Number.isNaN(minus) || !Number.isNaN(edge[0]! ** edge[3]!) || edge[2]! ** edge[4]! !== 1)
        throw new Error("JavaScript exponent edges");
    if (!Number.isNaN(Math.pow(edge[0]!, edge[3]!)) || !Number.isNaN(Math.pow(edge[1]!, -edge[3]!)) ||
        !Number.isNaN(Math.pow(edge[0]!, edge[2]!)) || Math.pow(edge[2]!, edge[4]!) !== 1 || Math.pow(edge[3]!, -1) !== 0 ||
        Math.pow(h[0]!, 10) !== 1024 || edge[1]! ** 3 !== -1 || Math.pow(h[0]!, -2) !== 0.25)
        throw new Error("Math.pow follows the exponent rules");
    const powers = [edge[0]!, edge[1]!].map((base) => Math.pow(base, edge[3]!));
    const pairwise = [edge[1]!, h[0]!].map(Math.pow);
    if (!Number.isNaN(powers[0]!) || !Number.isNaN(powers[1]!) || pairwise[0] !== 1 || pairwise[1] !== 2)
        throw new Error("Math.pow as a value");
`,
);

test("an exponent compound assignment with a static exponent spells std::pow as ** does", () => {
    const { cpp } = compileSource(`
    const h = new Float64Array([3, 2]);
    let x = h[0]!;
    x **= 2;
    const o = { v: h[1]! };
    o.v **= 3;
    h[0] **= 0.5;
    let y = h[1]!;
    y = y ** 2;
    if (x + o.v + h[0]! + y === 0) throw new Error("read");
    `);
    assert.doesNotMatch(cpp, /power_js/);
    assert.equal(cpp.match(/std::pow\(/g)?.length, 4);
});

check(
    "numeric-updates-on-optional-and-entry-places",
    `
    type Job = "none" | "a" | "b";
    const JOBS = ["a", "b"] as const;
    type Counts = Record<Exclude<Job, "none">, number>;
    function empty(): Counts { const counts = {} as Counts; for (const job of JOBS) counts[job] = 0; return counts; }
    function living(villagers: readonly { job?: Job }[]): Counts {
        const counts = empty();
        for (const v of villagers) { if (!v.job || v.job === "none") continue; counts[v.job]++; }
        return counts;
    }
    const stored: Array<typeof living> = [living];
    const census = stored[0]!([{ job: "a" }, { job: "none" }, {}, { job: "a" }, { job: "b" }]);
    if (census.a !== 2 || census.b !== 1) throw new Error("optional field increments");
    const sparse = {} as Counts;
    sparse.a = 4;
    const before = sparse.a++;
    const after = ++sparse.a;
    const missing = sparse.b++;
    if (before !== 4 || after !== 6 || !Number.isNaN(missing) || !Number.isNaN(sparse.b)) throw new Error("optional slot values");
    sparse.a -= 1;
    sparse.a **= 2;
    if (sparse.a !== 25) throw new Error("optional slot compound");
    const tally: Record<string, number> = {};
    let reads = 0;
    function key(name: string): string { reads++; return name; }
    for (const word of ["x", "y", "x"]) { tally[word] = tally[word] ?? 0; tally[key(word)]!++; }
    const old = tally["x"]!--;
    const fresh = ++tally["y"]!;
    tally["z"] = 1;
    tally["z"]! += 4;
    tally.w = 2;
    tally.w! *= 3;
    const absent = tally["q"]!++;
    if (reads !== 3 || old !== 2 || tally["x"] !== 1 || fresh !== 2 || tally["z"] !== 5 || tally["w"] !== 6 ||
        !Number.isNaN(absent) || !Number.isNaN(tally["q"])) throw new Error("dictionary entries");
    const slots = new Map<string, { batch: number; next: number }>();
    slots.set("k", { batch: 7, next: 0 });
    const assigned: { slot: number }[] = [{ slot: -1 }, { slot: -1 }, { slot: -1 }];
    for (let i = 0; i < assigned.length; i++) { const g = slots.get("k")!; assigned[i]!.slot = g.next++; }
    if (assigned.map((item) => item.slot).join() !== "0,1,2" || slots.get("k")!.next !== 3) throw new Error("field postfix value");
`,
);

test("numeric updates refuse places without a number", () => {
    for (const source of [
        "const t: Record<string, number | string> = {}; t['k'] = 1; (t['k'] as number)++;",
        "function f(o: { v?: number | null }): number { return o.v!++; } const fs: Array<typeof f> = [f]; const unused = fs[0]!({ v: 1 });",
    ])
        assert.throws(
            () => compileSource(source),
            /increment or decrement requires a number, optional number or dictionary entry/,
        );
});

check(
    "integer-loop-counters",
    `
    const values: number[] = [5, 7, 11, 13];
    let text = "";
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[i]! * i;
    for (let i = -3; i <= 3; i += 3) text += i + ",";
    for (let i = 10; i > 0; i -= 4) text += (i / 4) + ";";
    for (let i = 3; i >= 0; i--) {
        if (i === 2) continue;
        text += (i % 2) + (1 / (i - 1)) + "|";
    }
    for (let i = 1; i < 4; i++) for (let j = 1; j < 3; j++) total += i / j;
    let captured = 0;
    for (let i = 0; i < 3; i++) {
        const read = () => i;
        captured += read();
    }
    for (let i = 0; i < 5; i++) {
        if (i === 1) i += 1;
        total += i;
    }
    if (text !== "-3,0,3,2.5;1.5;0.5;1.5|Infinity|-1|") throw new Error("counted text " + text);
    if (total !== 86 || captured !== 3) throw new Error("counted totals " + total + " " + captured);
`,
);

check(
    "string-collection-foreach",
    `
    const names = new Set<string>(["alpha", "beta"]);
    const seen: string[] = [];
    names.forEach(name => {
        seen.push(name);
        if (name === "alpha") names.delete("beta");
    });
    if (seen.join(",") !== "alpha") throw new Error("set forEach order " + seen.join(","));
    const labels = new Map<string, string>([["a", "one"], ["b", "two"]]);
    const pairs: string[] = [];
    labels.forEach((value, key) => { pairs.push(key + "=" + value); });
    if (pairs.join(",") !== "a=one,b=two") throw new Error("map forEach " + pairs.join(","));
`,
);

check(
    "record-arrow-lexical-this",
    `
    function select(values: number[], options: {test: (value: number) => boolean}): number[] {
        function filter(test: (value: number) => boolean): number[] {
            const selected: number[] = [];
            for (const value of values) if (test(value)) selected.push(value);
            return selected;
        }
        return filter(options.test);
    }
    class Selection {
        private readonly allowed = new Set([2, 4]);
        run(): number[] {
            return select([1, 2, 3, 4], {test: value => this.allowed.has(value)});
        }
    }
    const result = new Selection().run();
    if (result.join(",") !== "2,4") throw new Error("arrow receiver");
`,
);

check(
    "constant-null-guard",
    `
    function sum(x: number, y: number): number { return x + y; }
    function select(x: number | null, y: number | null): number {
        const valid = x !== null && y !== null && x >= 0 && y >= 0;
        if (!valid) return -1;
        return sum(x, y);
    }
    if (select(null, null) !== -1 || select(2, 3) !== 5) throw new Error("guarded arithmetic");
`,
);

check(
    "callback-helper-signatures",
    `
    function accepts(callback: (value: number) => boolean): boolean { return callback(7); }
    function invokes(count: number): number {
        return accepts(() => true) ? count + 1 : count;
    }
    if (invokes(1) !== 2 || invokes(3) !== 4) throw new Error("omitted callback parameter");
`,
);

check(
    "ambient-typeof-guards",
    `
    declare const OPTIONAL_BUILD: boolean | undefined;
    declare function OPTIONAL_HOOK(): void;
    declare namespace OPTIONAL_PACKAGE { function run(): void; }
    declare class OptionalClass { value: number; }
    const enabled = typeof OPTIONAL_BUILD !== "undefined" && OPTIONAL_BUILD === true;
    if (enabled || typeof OPTIONAL_HOOK !== "undefined") throw new Error("absent ambient globals");
    if (typeof NEVER_PROVIDED !== "undefined") throw new Error("unbound typeof");
    if (typeof OPTIONAL_PACKAGE !== "undefined" || typeof OptionalClass !== "undefined") throw new Error("erased declarations");
    function kind(OPTIONAL_BUILD: number): string { return typeof OPTIONAL_BUILD; }
    if (kind(7) !== "number") throw new Error("parameter binding");
    {
        const OPTIONAL_BUILD = true;
        if (typeof OPTIONAL_BUILD !== "boolean") throw new Error("local binding");
    }
    const selected = typeof OPTIONAL_BUILD === "undefined" ? "fallback" : "provided";
    if (selected !== "fallback") throw new Error("conditional guard");
    let effects=0;
    function receiver(): {value:number} { effects++; return {value:7}; }
    if (typeof receiver().value !== "number" || effects !== 1) throw new Error("member operand evaluation");
`,
);

test("absent typeof support preserves errors for unprovided reads and imported implementations", () => {
    assert.throws(
        () =>
            compileSource(
                "declare const OPTIONAL_BUILD: boolean; const value=OPTIONAL_BUILD;",
            ),
        /Unknown or unsupported variable/,
    );
    assert.throws(
        () =>
            compileSource(
                "declare const OPTIONAL_BUILD: {value:number}; const value=typeof OPTIONAL_BUILD.value;",
            ),
        /Unknown or unsupported variable/,
    );
    const directory = resolve("artifacts/ambient-typeof-import");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "provider.ts"),
        "export declare const supplied: number;",
    );
    assert.throws(() =>
        compileSource(
            'import {supplied} from "./provider.js"; const kind=typeof supplied;',
            { fileName: join(directory, "entry.ts") },
        ),
    );
});

test("ambient availability guards settle through imported helpers", async (t) => {
    const directory = resolve("artifacts/ambient-typeof-module");
    mkdirSync(directory, { recursive: true });
    const module = `declare const OPTIONAL_LABEL: string | undefined;
        export const label = typeof OPTIONAL_LABEL === "undefined" ? "baseline" : OPTIONAL_LABEL;
        export function describe(prefix="value"): string { return prefix+":"+label; }`;
    writeFileSync(join(directory, "feature.ts"), module);
    const javascript = ts.transpileModule(module, {
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.CommonJS,
        },
    }).outputText;
    assert.equal(
        runInNewContext(
            "const exports={};" + javascript + ";exports.describe()",
        ),
        "value:baseline",
    );
    const result = compileSource(
        'import {describe,label} from "./feature.js"; if(describe()!=="value:baseline" || label!=="baseline") throw new Error("module fallback");',
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(t, "ambient-typeof-module", result.cpp);
});

check(
    "optional-container-method-continuations",
    `
    const original = new Set<number>([4]);
    const groups = new Map<string, Set<number>>([['entry', original]]);
    let calls = 0;
    function argument(): number { calls++; groups.clear(); return 4; }
    const removed = groups.get('entry')?.delete(argument());
    const missing = groups.get('missing')?.delete(argument());
    groups.get('missing')?.clear();
    if (removed !== true || missing !== undefined || original.size !== 0 || calls !== 1)
        throw new Error('optional receiver snapshot and argument guard');
    const state: {values: number[] | null} = {values: [3, 5, 7]};
    let sum = 0;
    function start(): number { calls++; state.values = null; return 1; }
    state.values?.slice(start()).forEach(value => { sum += value; });
    state.values?.slice(start()).forEach(value => { sum += value; });
    if (sum !== 12 || calls !== 2) throw new Error('chain continuation');
    const rows: Record<string, string>[] = [{}, {code:'north'}, {code:'south'}];
    const match = rows.find(row => row.code?.startsWith('n'));
    if (match?.code !== 'north' || rows.findIndex(row => row.code?.startsWith('s')) !== 2 ||
        rows.filter(row => row.code?.startsWith('n')).length !== 1 ||
        !rows.some(row => row.code?.startsWith('s')) || rows.every(row => row.code?.startsWith('n')))
        throw new Error('predicate truthiness after unchecked lookup');
`,
);

check(
    "nullable-coalesce-widening",
    `
    type Tag = "north" | "south";
    const values: (Tag | null)[] = ["north", null, "south"];
    let calls = 0;
    function fallback(): string { calls++; return "fallback"; }
    let observed = "";
    for (const value of values) {
        const tag: Tag | "" = value ?? "";
        observed += "[" + tag + "]";
        const text = value ?? fallback();
        observed += text;
        const mixed = value ?? 7;
        if (typeof mixed === "number") observed += mixed + 1;
        else observed += mixed.toUpperCase();
    }
    if (observed !== "[north]northNORTH[]fallback8[south]southSOUTH" || calls !== 1)
        throw new Error("joined nullish alternatives");
    let reads = 0;
    function read(index: number): Tag | null { reads++; return values[index]!; }
    const selected: string = read(1) ?? "empty";
    if (selected !== "empty" || reads !== 1) throw new Error("one evaluation across string sink");
    function optional(value: boolean): string | undefined { calls++; return value ? "later" : undefined; }
    const states = [true, false];
    for (const state of states) {
        const present = read(0) ?? optional(state);
        const absent = read(1) ?? optional(state);
        if (present !== "north") throw new Error("present wider fallback");
        if (state) { if (absent !== "later") throw new Error("present optional fallback"); }
        else if (absent !== undefined) throw new Error("absent optional fallback");
    }
    if (calls !== 3 || reads !== 5) throw new Error("lazy optional fallback");
    const record: {tag: Tag | null} = {tag: "north"};
    function turn(): void { record.tag = "south"; }
    if (record.tag === "north") {
        turn();
        if (String(record.tag ?? "") !== "south") throw new Error("live tag after narrowed helper call");
    }
`,
);

check(
    "scalar-union-strict-comparisons",
    `
    const values:(string|number|boolean)[] = ['head',2,false,NaN];
    if(values[0] !== 'head' || values[1] !== 2 || values[2] !== false) throw new Error('matching type and value');
    if(values[1] === '2' || values[2] === 0 || values[3] === values[3]) throw new Error('strict types and NaN');
    let calls = '';
    const state:{value:string|number} = {value:'before'};
    function left():string|number {calls+='l';return state.value;}
    function right():string|number {calls+='r';state.value='after';return 'before';}
    if(left() !== right() || calls !== 'lr' || state.value !== 'after') throw new Error('operand snapshots');
    const lookup = new Map<string,string|number>([['entry','before']]);
    function clear():string|number|undefined {lookup.clear();return 'before';}
    if(lookup.get('entry') !== clear()) throw new Error('borrowed optional snapshot');
    function absent():string|number|undefined {return undefined;}
    if(absent() !== lookup.get('missing')) throw new Error('absent union equality');
    const rows:Record<string,string|number>[]=[{text:'value',amount:3}];
    for(const row of rows) {
        if(row.text !== 'value' || row.amount !== 3 || row.missing === 'value' || row.missing === 0)
            throw new Error('unchecked optional union');
    }
    const [head,...tail] = values;
    if(head !== 'head' || tail[0] !== 2 || tail[1] !== false) throw new Error('union rest values');
    type Tag = 'north' | 'south';
    const tagged:(Tag|number)[] = ['north',3];
    for(const tag of tagged) {
        if(tag === 'north') continue;
        if(tag !== 3 || tag === 'outside') throw new Error('tagged scalar equality');
    }
`,
);

check(
    "mixed-tuple-rest-bindings",
    `
    const object = {score:4};
    const source:[string,number,{score:number}|null] = ['head',2,object];
    const [head,...tail] = source;
    source[1] = 9;
    if(head !== 'head' || tail[0] !== 2 || tail.length !== 2) throw new Error('fresh rest storage');
    if(tail[1]) tail[1].score++;
    if(object.score !== 5) throw new Error('shallow object identity');
    tail[0] = 7;
    if(source[1] !== 9) throw new Error('independent rest writes');
    const pair:[string,number] = ['key',3];
    const [,,...empty] = pair;
    if(empty.length !== 0) throw new Error('empty rest');
    function copy(value:[string,number,boolean]):[number,boolean] {
        const [,...rest] = value;
        return rest;
    }
    const result = copy(['value',6,true]);
    if(result[0] !== 6 || result[1] !== true) throw new Error('returned rest');
    function parameter([head,...rest]:[string,number,boolean]):[number,boolean] {
        if(head !== 'value') throw new Error('parameter head');
        rest[0]++;
        return rest;
    }
    const row:[string,number,boolean] = ['value',8,false];
    const parameterTail = parameter(row);
    if(parameterTail[0] !== 9 || parameterTail[1] !== false || row[1] !== 8) throw new Error('parameter rest copy');
    const retained:(()=>number)[] = [];
    const rows:[string,number,boolean][] = [['a',3,true],['b',5,false]];
    for(const [head,...rest] of rows) {
        rest[0]++;
        retained.push(() => rest[0] + head.length);
    }
    if(retained[0]() !== 5 || retained[1]() !== 7 || rows[0][1] !== 3) throw new Error('loop rest lifetime');
    const numbers:[number,number,number] = [2,4,6];
    const [,...numericTail] = numbers;
    numericTail[0] = 10;
    if(numericTail[0] !== 10 || numbers[1] !== 4) throw new Error('numeric tuple rest');
    const entries = new Map<string,number>([['x',11]]);
    for(const [key,...rest] of entries) {
        rest[0]++;
        if(key !== 'x' || rest[0] !== 12 || entries.get(key) !== 11) throw new Error('map entry rest');
    }
    const values = new Set<number>([13]);
    for(const [,...rest] of values.entries()) {
        rest[0]++;
        if(rest[0] !== 14 || !values.has(13)) throw new Error('set entry rest');
    }
    const list:string[] = ['first','second'];
    for(const [index,...rest] of list.entries()) {
        rest[0] = 'changed';
        if(list[index] === 'changed') throw new Error('array entry rest');
    }
    for(const [,,...rest] of entries) if(rest.length !== 0) throw new Error('empty entry rest');
`,
);

check(
    "iterable-parameter-storage",
    `
    class Collector {
        items:string[] = [];
        append(values:Iterable<string>):void {
            for(const value of values) this.items.push(value);
        }
    }
    const collector = new Collector();
    const values = new Set(['one','two']);
    collector.append(values);
    collector.append(['three']);
    const iterator = values.entries();
    function count(pairs:Iterable<[string,string]>):number {
        let total = 0;
        for(const [key,value] of pairs) {if(key !== value) throw new Error('entry identity');total++;}
        return total;
    }
    if(collector.items.join(',') !== 'one,two,three' || count(iterator) !== 2 || count(iterator) !== 0)
        throw new Error('iterable uses its actual collection');
`,
);

check(
    "mixed-tuple-mutations",
    `
    const pair:[string,number] = ['head',2];
    const alias = pair;
    const positions:number[] = [0,1];
    for(const index of positions) pair[index] = index + 10;
    for(const index of positions) {
        const value = alias[index];
        if(typeof value !== 'number' || value !== index + 10) throw new Error('dynamic writes and shared identity');
    }
    if(pair.push('tail') !== 3 || alias.length !== 3) throw new Error('push result and alias');
    if(pair.pop() !== 'tail' || pair.shift() !== 10) throw new Error('pop and shift values');
    if(pair.unshift('new') !== 2) throw new Error('unshift length');
    const removed = pair.splice(1,1,20,30);
    const indices:number[] = [1,2];
    if(removed[0] !== 11 || pair.length !== 3) throw new Error('splice result');
    for(const index of indices) if(pair[index] !== (index + 1) * 10) throw new Error('splice insertion');
    pair.length = 0 as 2;
    if(alias.length !== 0 || pair.pop() !== undefined || pair.shift() !== undefined) throw new Error('empty mutation results');
    for(const index of positions) if(pair[index] !== undefined) throw new Error('out of range after truncation');
`,
);

check(
    "mixed-tuple-mutation-boundaries",
    `
    const source:[string,number] = ['head',2];
    const positions:number[] = [0];
    for(const index of positions) source[index] = 4;
    const value = source[0];
    if(typeof value !== 'number' || value !== 4) throw new Error('changed static lane');
    if(typeof value === 'number' && value + 1 !== 5) throw new Error('guarded numeric operation');
    function tail(pair:[string,number,boolean]):[number,boolean] {
        const [,...rest] = pair;
        return rest;
    }
    const row:[string,number,boolean] = ['head',2,true];
    const rows:[number,boolean][] = [];
    rows.push(tail(row));
    if(rows[0][0] !== 2 || rows[0][1] !== true) throw new Error('stored returned rest');
    let pair:[string,number] = ['head',2];
    const original = pair;
    function argument():number {pair=['new',3];return 4;}
    if(pair.push(argument()) !== 3 || original.length !== 3 || pair.length !== 2) throw new Error('push receiver snapshot');
    let numbers:number[] = [1];
    const before = numbers;
    let current = 2;
    function replace():number {numbers=[9];current=3;return 4;}
    if(numbers.push(current, replace()) !== 3 || before[1] !== 2 || before[2] !== 4 || numbers.length !== 1) throw new Error('ordinary push evaluation');
    if(numbers.push() !== 1) throw new Error('empty push length');
    const prepend = numbers;
    if(numbers.unshift(current, replace()) !== 3 || prepend[0] !== 3 || prepend[1] !== 4 || numbers.length !== 1) throw new Error('unshift evaluation');
    const spread:number[] = [5,6];
    function editSpread():number {spread[0]=7;return 8;}
    numbers.push(...spread, editSpread());
    if(numbers[1] !== 5 || numbers[2] !== 6 || numbers[3] !== 8) throw new Error('spread arguments evaluated before mutation');
    numbers.push(...numbers);
    if(numbers.length !== 8 || numbers[5] !== 5) throw new Error('self spread');
`,
);

check(
    "push-spreads-what-an-array-literal-spreads",
    `
    const gate = new Float32Array([1]);
    const letters: string[] = ["<"];
    letters.push(..."ab", ...new Set(["c", "c", "d"]));
    const tags = new Map<string, number>([["x", 1], ["y", 2]]);
    letters.push(...tags.keys());
    if (letters.join("") !== "<abcdxy") throw new Error("string, Set and iterator spreads");
    const numbers: number[] = [0];
    numbers.push(...new Float32Array([0.5, 1.5]), ...new Set([2, 2, 3]), ...tags.values());
    if (numbers.join(",") !== "0,0.5,1.5,2,3,1,2") throw new Error("typed array, Set and iterator spreads");
    const pairs: [string, number][] = [];
    pairs.push(...tags);
    if (pairs.length !== 2 || pairs[1]![0] !== "y" || pairs[1]![1] !== 2) throw new Error("Map entry spread");
    numbers.length = 1;
    numbers.push(...numbers.map((v) => v + gate[0]!), ...numbers);
    if (numbers.join(",") !== "0,1,0") throw new Error("receiver read before the push");
    const points: string[] = [];
    points.push(..."a\u{1F600}");
    if (points.length !== 2 || points[1] !== "\u{1F600}") throw new Error("code points");
`,
);

check(
    "mixed-tuple-destructuring-assignments",
    `
    const row:[string,number,boolean] = ['head',2,true];
    let head = '';
    let tail:(number|boolean)[] = [];
    [head,...tail] = row;
    if(head !== 'head' || tail[0] !== 2 || tail[1] !== true) throw new Error('assigned rest');
    tail[0] = 7;
    if(row[1] !== 2) throw new Error('rest is fresh');
    let count = 0;
    let enabled = false;
    [head,count,enabled] = row;
    if(head !== 'head' || count !== 2 || enabled !== true) throw new Error('assigned lanes');
    [head,count,enabled] = ['next',3,false];
    if(head !== 'next' || count !== 3 || enabled !== false) throw new Error('literal assignment');
    [,count] = row;
    if(count !== 2) throw new Error('omitted assignment');
    let first = 1, second = 2;
    [first,second] = [second,first];
    if(first !== 2 || second !== 1) throw new Error('numeric swap');
    function mutate():number {second=9;return 7;}
    [first,second] = [second,mutate()];
    if(first !== 1 || second !== 7) throw new Error('source values precede assignments');
    let calls = 0;
    function source():[string,number,boolean] {calls++;return row;}
    [head,...tail] = source();
    if(calls !== 1 || head !== 'head' || tail[0] !== 2) throw new Error('single source evaluation');
    const object = {value:4};
    const objects:[string,{value:number}] = ['object',object];
    let selected = {value:0};
    [head,selected] = objects;
    selected.value = 9;
    if(object.value !== 9) throw new Error('assigned object identity');
    let empty:(number|boolean)[] = [1];
    [,,,...empty] = row;
    if(empty.length !== 0) throw new Error('empty assigned rest');
    [...tail] = [];
    if(tail.length !== 0) throw new Error('empty literal rest');
`,
);

check(
    "unshift-callback-snapshots",
    `
    function first():number {return 1;}
    function second():number {return 2;}
    let selected:()=>number=first;
    function replace():()=>number {selected=second;return second;}
    const callbacks:(()=>number)[]=[];
    callbacks.unshift(selected,replace());
    if(callbacks[0]!()!==1 || callbacks[1]!()!==2 || selected()!==2)
        throw new Error("unshift snapshots before later effects");
    callbacks.unshift(selected);
    if(callbacks[0]!()!==2 || callbacks[1]!()!==1)
        throw new Error("unshift borrows until insertion");
    `,
);

check(
    "mixed-tuple-dynamic-reads",
    `
    let pair: [string, number] = ["value", 7];
    const indices = [0, 1, 2, -1, 0.5, NaN];
    let observed = "";
    for (const index of indices) {
        const lookup = pair[index];
        const value = lookup;
        if (typeof value === "string") observed += value.toUpperCase();
        else if (typeof value === "number") observed += value + 1;
        else if (value === undefined) observed += "?";
    }
    if (observed !== "VALUE8????") throw new Error("dynamic tuple values and absence");
    let calls = 0;
    function index(): number { calls++; pair = ["new", 10]; return 1; }
    if (pair[index()] !== 7 || calls !== 1 || pair[1] !== 10) throw new Error("dynamic tuple evaluation order");
    const item = {score: 3};
    const recordPair: [string, {score:number} | null] = ["key", item];
    const recordIndices: number[] = [1, 0, 2];
    for (const offset of recordIndices) {
        const value = recordPair[offset];
        if (typeof value === "object" && value !== null) value.score++;
    }
    if (item.score !== 4) throw new Error("dynamic tuple object identity");
`,
);

check(
    "set-entry-iteration",
    `
    const values = new Set<number>([2, 3, 4]);
    let seen = "";
    for (const [first, second] of values.entries()) {
        if (first !== second) throw new Error("entry lanes");
        seen += first;
        if (first === 2) { values.delete(3); values.add(5); }
    }
    if (seen !== "245") throw new Error("live entry iteration");
    const pairs = [...values.entries()];
    pairs[0]![0] = 99;
    if (!values.has(2) || values.has(99) || pairs[0]![1] !== 2) throw new Error("fresh numeric pairs");
    const copied = Array.from(values.entries());
    if (copied.map(([a,b]) => a + b).join(",") !== "4,8,10") throw new Error("entry array copy");
    let visits = 0;
    const projected = Array.from(values.entries(), ([a,b], index) => { visits++; return a + b + index; });
    if (visits !== 3 || projected.join(",") !== "4,9,12") throw new Error("entry array mapper");
    for (let [a,b] of values.entries()) { a = 20; b = 30; if (a + b !== 50) throw new Error("local entry bindings"); }
    const mutated = Array.from(values.entries(), pair => { pair[0] = 100; return pair[1]; });
    if (mutated.join(",") !== "2,4,5" || Array.from(values).join(",") !== "2,4,5") throw new Error("mapper pair identity");
    const records = new Set<{score:number}>();
    const record = {score:7}; records.add(record);
    for (const pair of records.entries()) {
        if (pair[0] !== pair[1] || pair[0] !== record) throw new Error("shared entry object");
        pair[0].score++;
        pair[0] = {score:20};
        if (pair[1] !== record) throw new Error("independent entry lanes");
    }
    const objects = [...records.entries()];
    if (record.score !== 8 || objects[0]![0] !== record || objects[0]![1] !== record) throw new Error("retained object identity");
    const secondCopy = [...records.entries()];
    if (objects[0] === secondCopy[0]) throw new Error("fresh entry identities");
    const cleared = new Set<number>([1,2]);
    let clearedSeen = "";
    for (const [value] of cleared.entries()) { clearedSeen += value; if (value === 1) { cleared.clear(); cleared.add(3); } }
    if (clearedSeen !== "13") throw new Error("clear during iteration");
    const mapping = new Map<string, number>([["a",1],["b",2]]);
    for (let [key, value] of mapping.entries()) { key = "other"; value = 9; if (key !== "other" || value !== 9) throw new Error("map locals"); }
    const mappedPairs = Array.from(mapping.entries(), pair => { pair[0] = "new"; return pair; });
    if (mapping.has("other") || mapping.has("new") || mapping.get("a") !== 1 || mappedPairs[0]![0] !== "new") throw new Error("map fresh pairs");
    const source = {values: new Set<number>([1,2])};
    const original = source.values;
    const rewritten = Array.from(source.values, value => { source.values = new Set<number>([9]); value += 10; return value; });
    if (rewritten.join(",") !== "11,12" || Array.from(original).join(",") !== "1,2") throw new Error("mapper receiver and value snapshots");
`,
);

check(
    "stored-set-entry-iterators",
    `
    const values = new Set<number>([2,3]);
    const entries = values.entries();
    const alias = entries;
    if(!entries || entries !== alias) throw new Error('iterator identity and truthiness');
    values.add(4);
    const first = entries.next();
    if(first.done || first.value[0] !== 2 || first.value[1] !== 2) throw new Error('first');
    first.value[0] = 99;
    if(first.value[1] !== 2 || !values.has(2)) throw new Error('fresh pair lanes');
    values.delete(2);
    values.delete(3);
    let seen = '';
    for(const [a,b] of alias) {
        if(a !== b) throw new Error('matching lanes');
        seen += a;
        if(a === 4) { values.clear(); values.add(7); }
    }
    if(seen !== '47') throw new Error('live cursor');
    values.add(8);
    const exhausted = entries.next();
    if(!entries) throw new Error('exhausted iterator is still an object');
    if(!exhausted.done || exhausted.value !== undefined) throw new Error('sticky exhaustion');
    const delayedValues = new Set<string>();
    const delayed = delayedValues.entries();
    delayedValues.add('later');
    const copied = [...delayed];
    if(copied.length !== 1 || copied[0]![0] !== 'later') throw new Error('deferred start');
    const shared = {count:1};
    const objects = new Set<{count:number}>([shared]);
    const objectEntries = objects.entries();
    for(const pair of objectEntries) {
        pair[0].count++;
        if(pair[1].count !== 2) throw new Error('object identity');
    }
    if(shared.count !== 2) throw new Error('retained object');
    const partial = new Set<number>([1,2,3]).entries();
    for(const [a] of partial) { if(a !== 1) throw new Error('break'); break; }
    const remaining = Array.from(partial);
    if(remaining.length !== 2 || remaining[0]![0] !== 2 || remaining[1]![1] !== 3) throw new Error('resume after break');
    const mappedValues = new Set<number>([2]);
    const mappedEntries = mappedValues.entries();
    const mapped = Array.from(mappedEntries, ([a,b], index) => {
        if(a === 2) mappedValues.add(3);
        return a+b+index;
    });
    if(mapped.join(',') !== '4,7') throw new Error('mapped iterator');
    function make(): IterableIterator<[number,number]> {
        const owner = new Set<number>([5,6]);
        return owner.entries();
    }
    const returned = make();
    const retained: () => number = () => {
        const next = returned.next();
        return next.done ? -1 : next.value[0];
    };
    if(retained() !== 5 || retained() !== 6 || retained() !== -1) throw new Error('iterator lifetime');
    const keyed = new Set<number>([2,3]);
    const keys = keyed.keys();
    const scalarValues = keyed.values();
    if(keys.next().value !== 2 || scalarValues.next().value !== 2) throw new Error('independent cursors');
    const keysArray = [...keys];
    if(keysArray.join(',') !== '3') throw new Error('key cursor');
`,
);

check(
    "string-replacement-callbacks",
    `
    let calls = 0;
    let input = "aba";
    const result = input.replaceAll("a", (match, index: number, original: string) => {
        calls++;
        input = "changed";
        if (original !== "aba" || match !== "a") throw new Error("callback input snapshot");
        return "$&" + index;
    });
    if (result !== "$&0b$&2" || calls !== 2 || input !== "changed") throw new Error("literal callback result");
    function replace(match: string, offset: number, source: string): string {
        return match + offset + source.length;
    }
    if ("aba".replace("a", replace) !== "a03ba") throw new Error("first replacement");
    let stored: (match: string) => string = match => match.toUpperCase();
    if ("aba".replaceAll("a", stored) !== "AbA") throw new Error("stored replacement");
    calls = 0;
    const untouched = "abc".replaceAll("z", () => { calls++; return "bad"; });
    if (untouched !== "abc" || calls !== 0) throw new Error("missing match callback");
    const padded = "😀".replaceAll("", (_match, offset: number) => "[" + offset + "]");
    if (padded !== "[0]\\ud83d[1]\\ude00[2]") throw new Error("empty search UTF16 positions");
    let order = "";
    function source(): string { order += "s"; return "x"; }
    function search(): string { order += "p"; return "x"; }
    function callback(): (value: string) => string { order += "c"; return value => { order += "r"; return value; }; }
    if (source().replace(search(), callback()) !== "x" || order !== "spcr") throw new Error("replacement evaluation order");
`,
);

check(
    "known-nullish-string-conversion",
    `
    function show(value: unknown): string { return String(value); }
    const missing = undefined;
    const empty = null;
    if (typeof missing !== "undefined" || typeof empty !== "object") throw new Error("nullish typeof");
    if (show(missing) !== "undefined" || show(empty) !== "null") throw new Error("nullish String");
    if ("value=" + missing !== "value=undefined" || "value=" + empty !== "value=null") throw new Error("nullish concatenation");
    if (\`value=\${missing}\` !== "value=undefined" || \`value=\${empty}\` !== "value=null") throw new Error("nullish interpolation");
`,
);

check(
    "array-predicates-preserve-effects-and-absence",
    `
    let calls = 0;
    function numbers(): number[] { calls++; return [1, 2]; }
    function record(): {value:number} { calls++; return {value: 1}; }
    function optional(present: boolean): number[] | null { return present ? [1] : null; }
    if (!Array.isArray(numbers()) || Array.isArray(record()) || calls !== 2) throw new Error("array predicate effects");
    const inputs = [true, false];
    for (const input of inputs) if (Array.isArray(optional(input)) !== input) throw new Error("absent array");
    if (Array.isArray(undefined) || Array.isArray(null) || Array.isArray(new Float32Array(2))) throw new Error("nonarrays");
`,
);

check(
    "tuple-aliases-survive-binding-replacement",
    `
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
`,
);

check(
    "empty-audio-resource-collections",
    `
    const nodes = new Map<AudioNode, number>();
    const parameters = new Map<AudioParam, number>();
    const contexts = new Set<AudioContext>();
    const streams = new Map<MediaStream, number>();
    const tracks = new Set<MediaStreamTrack>();
    if (nodes.size + parameters.size + contexts.size + streams.size + tracks.size !== 0) throw new Error("resource collections");
`,
);

check(
    "enum-parameter-defaults",
    `
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
`,
);

check(
    "object-prototype-own-property-call",
    `
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
`,
);

check(
    "callback-factory-record-assignment",
    `
    let count = 0;
    function handler(step: number): () => void { count++; return () => { count += step; }; }
    const registry = { identity: <T>(value: T): T => value, action: (): void => {} };
    registry.action();
    registry.action = handler(3);
    registry.action();
    if (registry.identity(count) !== 4) throw new Error("callback factory assignment");
`,
);

check(
    "ignored-generic-record-returns-preserve-branch-effects",
    `
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
`,
);

check(
    "open-records-asserted-as-closed-records",
    `
    type Drop = "seat-changed" | "gesture-end";
    const DROPS: readonly Drop[] = Object.freeze(["seat-changed", "gesture-end"] as const);
    const DROP_INDEX: Readonly<Record<Drop, number>> = Object.freeze(
        Object.fromEntries(DROPS.map((code, index) => [code, index])),
    ) as Readonly<Record<Drop, number>>;
    const tally = [0, 0];
    function drop(code: Drop): void { tally[DROP_INDEX[code]]!++; }
    drop("gesture-end"); drop("gesture-end"); drop("seat-changed");
    if (tally.join(",") !== "1,2") throw new Error("asserted closed record");
    type Action = "jump" | "run" | "crouch";
    type Profile = Record<Action, string>;
    const DEFINITIONS: readonly { action: Action; key: string }[] = [{ action: "jump", key: "Space" }, { action: "run", key: "Shift" }];
    function profileFromDefaults(): Profile {
        return Object.fromEntries(DEFINITIONS.map((definition) => [definition.action, definition.key])) as Profile;
    }
    // "crouch" is never read, so its absence never refuses.
    const profile = profileFromDefaults();
    if (profile.jump !== "Space" || profile.run !== "Shift") throw new Error("asserted closed record");
    const entries: Record<string, string> = {};
    const view: Profile = entries as Profile;
    entries["jump"] = "J";
    view.run = "R";
    if (view.jump !== "J" || entries["run"] !== "R") throw new Error("the view and its record share entries");
    const alias = entries as Profile;
    entries["crouch"] = "C";
    if (alias.crouch !== "C" || view.crouch !== "C") throw new Error("a later entry reads through the view");
    function rebind(profile: Profile, action: Action, key: string): void { profile[action] = key; }
    rebind(view, Date.now() > 0 ? "jump" : "run", "K");
    view["run"] = "L";
    if (entries["jump"] !== "K" || entries["run"] !== "L") throw new Error("keyed writes through the view");
    const partial: Partial<Profile> = entries as Partial<Profile>;
    partial.run = undefined;
    if (partial.jump !== "K" || partial.run !== undefined || entries["run"] !== undefined) throw new Error("optional view");
`,
);

check(
    "rebound-nullable-records-select-objects",
    `
    interface Indicator { show: (enabled: boolean) => void; hide: () => void; }
    let shown = 0;
    function createIndicator(step: number): Indicator {
        let visible = false;
        return { show: (enabled: boolean) => { visible = enabled; shown += step; }, hide: () => { visible = false; } };
    }
    let indicator: Indicator | undefined;
    const later = (): void => indicator?.show(true);
    later();
    indicator = createIndicator(1);
    later();
    const first = indicator;
    indicator = createIndicator(10);
    later();
    first.show(true);
    indicator?.hide();
    if (shown !== 12) throw new Error("rebound nullable record");
`,
);

check(
    "rebound-readonly-arrays-own-their-arrays",
    `
    interface Surface { y: number; holes: readonly number[]; }
    const NO_HOLES: readonly number[] = Object.freeze([]);
    const NONE: readonly Surface[] = Object.freeze([]);
    function profile(kind: number): { tops: readonly Surface[]; envelope: readonly Surface[] } {
        const wall: Surface = { y: 1, holes: NO_HOLES };
        let tops: readonly Surface[];
        let envelope: readonly Surface[];
        switch (kind) {
            case 0:
                tops = NONE;
                envelope = [wall, { y: 2, holes: NO_HOLES }];
                break;
            default:
                tops = [{ y: kind, holes: NO_HOLES }];
                envelope = [wall];
                break;
        }
        return { tops, envelope };
    }
    const flat = profile(3);
    const pitched = profile(0);
    if (flat.tops.length !== 1 || flat.tops[0]!.y !== 3 || pitched.tops.length !== 0) throw new Error("assigned arrays");
    if (pitched.envelope.length !== 2 || flat.envelope[0]!.y !== 1) throw new Error("assigned literals");
    if (pitched.tops !== NONE || profile(0).tops !== pitched.tops) throw new Error("shared constant identity");
    interface Fact { key: string; score: number; }
    function createStore(read: () => readonly Fact[]) {
        let candidates: readonly Fact[] = [];
        let current: readonly Fact[] = [];
        return {
            refresh(): readonly Fact[] {
                candidates = read();
                current = candidates.filter((fact) => fact.score > 0);
                return current;
            },
            list: () => current,
            candidates: () => candidates,
        };
    }
    const source: Fact[] = [{ key: "a", score: 1 }, { key: "b", score: 0 }];
    const store = createStore(() => source);
    if (store.list().length !== 0 || store.candidates().length !== 0) throw new Error("initial arrays");
    const published = store.refresh();
    if (store.candidates() !== source || store.list() !== published || published.length !== 1) throw new Error("rebound identity");
    source.push({ key: "c", score: 2 });
    source[0]!.score = 9;
    if (store.candidates().length !== 3 || store.list()[0]!.score !== 9) throw new Error("alias after rebinding");
    let members: readonly number[] = [];
    const before = members;
    const next = [1, 2];
    members = next;
    next.push(3);
    if (members.length !== 3 || before.length !== 0 || members === before) throw new Error("rebinding copies");
`,
);

check(
    "rebound-readonly-array-identity-comparisons",
    `
    interface Collider { x: number; }
    let indexed: readonly Collider[] | null = null;
    let builds = 0;
    function narrow(colliders: readonly Collider[]): number {
        if (colliders !== indexed) {
            indexed = colliders;
            builds++;
        }
        return colliders.length;
    }
    function serves(colliders: readonly Collider[]): boolean { return indexed === colliders; }
    function indexedSet(): readonly Collider[] | null { return indexed; }
    const first: Collider[] = [{ x: 1 }];
    const second: Collider[] = [{ x: 1 }];
    narrow(first);
    narrow(first);
    narrow(second);
    if (builds !== 2 || !serves(second) || serves(first) || indexedSet() !== second) throw new Error("identity cache");
    second.push({ x: 2 });
    if (indexedSet()!.length !== 2) throw new Error("retained alias");
    indexed = null;
    if (indexedSet() !== null || serves(second)) throw new Error("cleared cache");
    interface FadeState { readonly members: readonly number[]; readonly fade: number; }
    function createPacker(getState: () => Readonly<FadeState>) {
        let packed: readonly number[] | null = null;
        let packs = 0;
        const pack = (members: readonly number[]): void => { packed = members; packs++; };
        return {
            refresh(): number {
                const state = getState();
                if (packed !== state.members) pack(state.members);
                return packs;
            },
            packed: () => packed,
        };
    }
    let fadeState: FadeState = { members: [4, 5], fade: 1 };
    const packer = createPacker(() => fadeState);
    packer.refresh();
    if (packer.refresh() !== 1 || packer.packed() !== fadeState.members) throw new Error("field identity");
    fadeState = { members: [4, 5], fade: 0 };
    if (packer.refresh() !== 2 || packer.packed() !== fadeState.members) throw new Error("replaced field identity");
`,
);

check(
    "nullable-readonly-array-conditionals-own-the-selected-array",
    `
    interface Sample { c: number; h: number; }
    interface Geom { eave: number; chain: readonly Sample[] | null; }
    let cached: readonly Sample[] | null = null;
    function chainFor(round: number): readonly Sample[] {
        if (cached !== null && cached.length === round + 1) return cached;
        const chain: Sample[] = [];
        for (let i = 0; i <= round; i++) chain.push({ c: i, h: round - i });
        cached = chain;
        return chain;
    }
    function geom(eave: number, round: number): Geom {
        return { eave, chain: round > 0 ? chainFor(round) : null };
    }
    function heightWith(g: Geom, c: number): number { return g.chain ? g.chain[0]!.h + c : g.eave; }
    function height(eave: number, round: number, c: number): number { return heightWith(geom(eave, round), c); }
    const heights: Array<typeof height> = [height];
    if (heights[0]!(5, 2, 1) !== 3 || heights[0]!(5, 0, 1) !== 5) throw new Error("selected chain");
    if (geom(1, 2).chain !== geom(3, 2).chain || geom(1, 0).chain !== null) throw new Error("selected chain identity");
`,
);

check(
    "field-aliases-survive-sibling-field-resizes",
    `
    class Store {
        private flags: number[] = [];
        private pending: number[] = [];
        private scratch: number[] = [];
        private firstChild: number[] = [];
        private nextSibling: number[] = [];
        add(parent: number): number {
            const slot = this.flags.length;
            this.flags.push(0);
            this.firstChild.push(-1);
            this.nextSibling.push(-1);
            if (parent >= 0) { this.nextSibling[slot] = this.firstChild[parent]!; this.firstChild[parent] = slot; }
            return slot;
        }
        markSubtree(slot: number): void {
            const stack = this.scratch;
            stack.length = 0;
            this.mark(slot);
            stack.push(slot);
            while (stack.length > 0) {
                const node = stack.pop()!;
                let child = this.firstChild[node]!;
                while (child >= 0) {
                    this.mark(child);
                    stack.push(child);
                    child = this.nextSibling[child]!;
                }
            }
        }
        private mark(slot: number): void {
            if (this.flags[slot] === 1) return;
            this.flags[slot] = 1;
            this.pending.push(slot);
        }
        seal(): string {
            const marked = this.pending.join(",");
            for (const slot of this.pending) this.flags[slot] = 0;
            this.pending.length = 0;
            return marked;
        }
    }
    interface Options { transforms: Store; label: string; }
    function createController(options: Options) {
        const { transforms } = options;
        return {
            attach: (parent: number): number => transforms.add(parent),
            dirty: (root: number): string => { transforms.markSubtree(root); return transforms.seal(); },
        };
    }
    const factories: Array<typeof createController> = [createController];
    const controller = factories[0]!({ transforms: new Store(), label: "a" });
    const root = controller.attach(-1);
    const child = controller.attach(root);
    controller.attach(child);
    controller.attach(root);
    if (controller.dirty(root) !== "0,3,1,2" || controller.dirty(child) !== "1,2") throw new Error("subtree marks");
`,
);

test("an alias into a field container refuses after that container resizes", () => {
    assert.throws(
        () =>
            compileSource(
                "class Store { private scratch: number[] = []; fill(): number { const stack = this.scratch; this.scratch.push(1); stack.push(2); return stack.length; } } function create(options: { store: Store }) { const { store } = options; return { fill: () => store.fill() }; } const factories: Array<typeof create> = [create]; const unused = factories[0]!({ store: new Store() }).fill();",
            ),
        /'stack' refers into a container that was resized after the binding/,
    );
});

check(
    "rebound-records-alias-the-assigned-object",
    `
    interface Sky { horizon: number[]; gold: number; }
    function normalize(gold?: number): Sky { return { horizon: [1, 2], gold: gold ?? 0.5 }; }
    let sky: Sky = { horizon: [0, 0], gold: 0 };
    function configure(gold: number): void { sky = normalize(gold); }
    const original = sky;
    configure(2);
    if (sky.gold !== 2 || original.gold !== 0 || original === sky) throw new Error("rebinding copies");
    const alias = sky;
    alias.gold = 7;
    if (sky.gold !== 7) throw new Error("alias after rebinding");
    sky = original;
    original.gold = 3;
    if (sky !== original || sky.gold !== 3) throw new Error("rebinding to an earlier object");
    interface Policy { available: boolean; ids: number[]; }
    function world(seed: number) {
        let n = seed;
        let current: Policy;
        const read = (): Policy => ({ available: n % 2 === 0, ids: [n] });
        current = read();
        const first = current;
        return {
            refresh: (): void => { n++; current = read(); },
            available: () => current.available,
            id: () => current.ids[0]!,
            first: () => first,
            current: () => current,
        };
    }
    const w = world(2);
    if (!w.available() || w.id() !== 2 || w.first() !== w.current()) throw new Error("initial record");
    w.refresh();
    if (w.available() || w.id() !== 3 || w.first() === w.current() || w.first().ids[0] !== 2) throw new Error("refreshed record");
`,
);

check(
    "rebound-optional-shared-storage",
    `
    function levels(grid: Uint8Array | null, size: number): number {
        let scratch: Int32Array | null = null;
        let current: Uint8Array | Int32Array | null = grid ?? null;
        if (!current) {
            scratch ??= new Int32Array(size);
            for (let i = 0; i < size; i++) scratch[i] = i * 2;
            current = scratch;
        }
        const lv = current;
        if (scratch) scratch[0] = 9;
        return lv instanceof Int32Array ? lv[0]! + lv.length : lv.length;
    }
    if (levels(null, 3) !== 12 || levels(new Uint8Array([4, 5]), 3) !== 2) throw new Error("typed-array union");
    function byteSum(buffer: ArrayBuffer): number { return new Uint8Array(buffer)[0]! + buffer.byteLength; }
    function split(bytes: Uint8Array): number {
        let bin: ArrayBuffer | null = null;
        const body = bytes.slice(1, 3);
        bin = body.buffer as ArrayBuffer;
        body[0] = 42;
        if (!bin) throw new Error("missing buffer");
        return byteSum(bin);
    }
    if (split(new Uint8Array([1, 2, 3, 4])) !== 44) throw new Error("buffer alias");
    interface Peer { key: string; }
    function createAligner<P extends Peer>() {
        let peers: readonly P[] | null = null;
        return {
            begin(next: readonly P[]): void { peers = next; },
            end(): void { peers = null; },
            count: (): number => (peers ? peers.length : -1),
        };
    }
    const aligner = createAligner<Peer>();
    const list: Peer[] = [{ key: "a" }];
    aligner.begin(list);
    list.push({ key: "b" });
    if (aligner.count() !== 2) throw new Error("generic readonly alias");
    aligner.end();
    if (aligner.count() !== -1) throw new Error("cleared alias");
`,
);

// A readonly array constant is one array wherever it is stored or
// compared: a default, an argument and a field all hold the same object.
check(
    "named-constant-arrays-keep-one-identity",
    `
    interface Collider { readonly x: number; readonly r: number; group?: number }
    const EMPTY: readonly Collider[] = [];
    const NUMS: readonly number[] = [1, 2];
    let kept: readonly Collider[] | null = null;
    let keptNums: readonly number[] | null = null;
    function keep(list: readonly Collider[] = EMPTY): boolean {
        const same = kept === list;
        kept = list;
        return same;
    }
    function keepNums(list: readonly number[] = NUMS): boolean {
        const same = keptNums === list;
        keptNums = list;
        return same;
    }
    const keeps: Array<typeof keep> = [keep];
    const keepsNums: Array<typeof keepNums> = [keepNums];
    if (keeps[0]!() || !keeps[0]!() || keeps[0]!(EMPTY) !== true) throw new Error("default constant");
    if (keepsNums[0]!() || !keepsNums[0]!() || keepsNums[0]!(NUMS) !== true || keepsNums[0]!([1, 2])) throw new Error("numbers");
    interface Index { colliders: readonly Collider[]; count: number }
    let active: Index | null = null;
    function matches(index: Index | null, colliders: readonly Collider[]): index is Index {
        return index !== null && index.colliders === colliders && index.count === colliders.length;
    }
    function prime(colliders: readonly Collider[]): number {
        if (matches(active, colliders)) return 0;
        active = { colliders, count: colliders.length };
        return 1;
    }
    function clear(x: number, colliders: readonly Collider[] = NO_COLLIDERS): number {
        return prime(colliders) + x;
    }
    const NO_COLLIDERS: readonly Collider[] = [];
    function run(x: number): number { return clear(x) + clear(x); }
    const runs: Array<typeof run> = [run];
    if (runs[0]!(1) !== 3) throw new Error("first prime");
    const first = active;
    if (runs[0]!(1) !== 2 || active !== first) throw new Error("one empty array");
`,
);

// A recursive function's readonly array parameter is its caller's array
// where the function compares it by identity.
check(
    "recursive-readonly-array-parameter-identity",
    `
    interface Collider { ax: number; radius: number; group?: number }
    interface Index { colliders: readonly Collider[]; count: number }
    let active: Index | null = null;
    function matches(index: Index | null, colliders: readonly Collider[]): index is Index {
        return index !== null && index.colliders === colliders && index.count === colliders.length;
    }
    function serves(colliders: readonly Collider[]): boolean { return matches(active, colliders); }
    function prime(colliders: readonly Collider[]): void {
        if (!matches(active, colliders)) active = { colliders, count: colliders.length };
    }
    let indexed = 0;
    function pointClear(x: number, colliders: readonly Collider[], depth: number): boolean {
        if (depth > 0 && !pointClear(x + 1, colliders, depth - 1)) return false;
        if (serves(colliders)) { indexed++; return active!.colliders.every((c) => Math.abs(c.ax - x) > c.radius); }
        return colliders.every((c) => Math.abs(c.ax - x) > c.radius);
    }
    function run(x: number, list: readonly Collider[], depth: number): boolean { return pointClear(x, list, depth); }
    const set: Collider[] = [{ ax: 0, radius: 1 }];
    const primes: Array<typeof prime> = [prime];
    const runs: Array<typeof run> = [run];
    primes[0]!(set);
    if (runs[0]!(5, set, 2) !== true || runs[0]!(-1, set, 1) !== false || indexed !== 4) throw new Error("indexed set");
    if (runs[0]!(5, [{ ax: 0, radius: 1 }], 1) !== true || indexed !== 4) throw new Error("equal set is another array");
`,
);

test("borrowed array views refuse rebinding and identity", () => {
    assert.throws(
        () =>
            compileSource(
                "function pick(a: ArrayLike<number>, b: ArrayLike<number>): number { let view: ArrayLike<number> = a; if (a.length === 0) view = b; return view.length; } const unused = pick([1], [2]);",
            ),
        /'view' holds a span; rebinding it would copy/,
    );
    assert.throws(
        () =>
            compileSource(
                "function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean { return a === b; } const xs = [1]; const unused = same(xs, xs);",
            ),
        /A borrowed array view cannot preserve JavaScript object identity in a comparison/,
    );
});

check(
    "record-accessors-are-stored-native-accessors",
    `
    "use strict";
    interface Counter {
        readonly count: number;
        label: string;
        add(): void;
    }
    function createCounter(start: number): Counter {
        let value = start;
        let text = "c";
        const counter: Counter = {
            get count() { return value; },
            get label() { return text + counter.count; },
            set label(next: string) { text = next; },
            add() { value++; },
        };
        return counter;
    }
    const counters: Counter[] = [createCounter(1), { count: 7, label: "plain", add() {} }];
    counters[0]!.add();
    counters[0]!.add();
    if (counters[0]!.count !== 3) throw new Error("getter through an array");
    const { count: destructured } = counters[0]!;
    if (destructured !== 3) throw new Error("destructured getter");
    counters[0]!.label = "n";
    if (counters[0]!.label !== "n3") throw new Error("setter through an array");
    if (counters[1]!.count !== 7 || counters[1]!.label !== "plain") throw new Error("stored value in an accessor slot");
    counters[1]!.label = "changed";
    if (counters[1]!.label !== "changed") throw new Error("stored value write");
    let current = createCounter(5);
    const byName = new Map<string, Counter>([["a", current]]);
    current.add();
    if (byName.get("a")!.count !== 6) throw new Error("getter through a map");
    const readCurrent = (): number => current.count;
    current = createCounter(20);
    if (readCurrent() !== 20 || byName.get("a")!.count !== 6) throw new Error("rebound accessor record");
    interface Sized { size: number; }
    let side = 3;
    const sizes: Sized[] = [{ get size() { return side; } }];
    let threw = false;
    try { sizes[0]!.size = 4; } catch (error) { threw = error instanceof TypeError; }
    side = 5;
    if (!threw || sizes[0]!.size !== 5) throw new Error("getter-only write");
    interface Mixed { a: number; b: number; }
    let backing = 0;
    const mixed: Mixed[] = [{ a: 1, get b() { return backing; }, set b(next: number) { backing = next; } }];
    function put(record: Mixed, key: "a" | "b", next: number): void { record[key] = next; }
    put(mixed[0]!, Date.now() > 0 ? "a" : "b", 5);
    put(mixed[0]!, Date.now() > 0 ? "b" : "a", 6);
    if (mixed[0]!.a !== 5 || backing !== 6 || mixed[0]!["b"] !== 6) throw new Error("keyed accessor writes");
    function read(record: Mixed, key: "a" | "b"): number { return record[key]; }
    if (read(mixed[0]!, Date.now() > 0 ? "b" : "a") !== 6) throw new Error("keyed accessor read");

    interface Reading { readonly count: number; name: string; }
    function createReading(): Reading {
        let reads = 0;
        return { get count() { reads++; return reads; }, name: "r" };
    }
    const readings: Reading[] = [createReading()];
    if (JSON.stringify(readings[0]) !== '{"count":1,"name":"r"}') throw new Error("JSON runs the getter");
    if (readings[0]!.count !== 2) throw new Error("each read runs the getter");

    class Tally implements Reading {
        private reads = 10;
        name = "t";
        get count(): number { return ++this.reads; }
    }
    const views: Reading[] = [new Tally()];
    if (views[0]!.count !== 11 || views[0]!.count !== 12) throw new Error("class getter through an interface");
`,
);

check(
    "kept-callbacks-through-wrappers-share-caller-bindings",
    `
    const kept: Array<() => void> = [];
    function keep(cb: () => void): void { kept.push(cb); }
    let ready = true;
    const noop = (): void => {};
    let viaAs = 0, viaSatisfies = 0, viaParens = 0, viaArm = 0, viaCoalesce = 0, viaLocal = 0, viaCalled = 0;
    keep((() => { viaAs++; }) as () => void);
    keep((() => { viaSatisfies++; }) satisfies () => void);
    keep((() => { viaParens++; }));
    keep(ready ? () => { viaArm++; } : noop);
    const missing: (() => void) | undefined = ready ? undefined : noop;
    keep(missing ?? (() => { viaCoalesce++; }));
    const local = ready ? () => { viaLocal++; } : noop;
    keep(local);
    const chosen = missing ?? (() => { viaCalled++; });
    chosen();
    for (const cb of kept) cb();
    ready = false;
    if (viaAs !== 1 || viaSatisfies !== 1 || viaParens !== 1) throw new Error("wrapped argument");
    if (viaArm !== 1 || viaCoalesce !== 1 || viaLocal !== 1) throw new Error("selected argument");
    if (viaCalled !== 1) throw new Error("selected callback called in place");
`,
);

check(
    "kept-callbacks-through-cycles-and-awaits",
    `
    class Relay {
        private kept: Array<() => void> = [];
        a(cb: () => void, depth: number): void {
            if (depth > 0) this.b(() => cb(), depth - 1);
            else this.kept.push(cb);
        }
        b(cb: () => void, depth: number): void { this.a(() => cb(), depth); }
        fire(): void { for (const cb of this.kept) cb(); }
    }
    async function later(cb: () => void): Promise<void> {
        await Promise.resolve(0);
        cb();
    }
    async function main(): Promise<void> {
        let viaA = 0, viaB = 0, viaAwait = 0;
        const relay = new Relay();
        relay.a(() => { viaA++; }, 2);
        relay.b(() => { viaB++; }, 2);
        relay.fire();
        if (viaA !== 1 || viaB !== 1) throw new Error("mutual recursion");
        await later(() => { viaAwait++; });
        if (viaAwait !== 1) throw new Error("callback after an await");
    }
    void main();
`,
);

check(
    "factory-records-share-their-frame-and-keep-callbacks",
    `
    interface Batch {
        count(): number;
        keyAt(index: number): number | null;
        setTint(rgb: readonly number[]): void;
        add(x: number): void;
        total(): number;
        dispose(): void;
    }
    const disposers: Array<() => void> = [];
    let disposals = 0;
    function createBatch(): Batch {
        let box = 0;
        let tint = 1;
        const keys: number[] = [];
        const keyAt = (index: number): number | null => index < box ? keys[index]! : null;
        const batch: Batch = {
            count: () => box,
            keyAt,
            setTint(rgb) { tint = rgb[0]!; },
            add(x) { keys.push(x * tint); box++; },
            total() { let sum = 0; for (let index = 0; index < box; index++) sum += batch.keyAt(index) ?? 0; return sum; },
            dispose() { disposals++; },
        };
        disposers.push(batch.dispose);
        return batch;
    }
    const wood = createBatch();
    const stone = createBatch();
    wood.setTint([2]);
    wood.add(3);
    wood.add(4);
    stone.add(5);
    if (wood.count() !== 2 || stone.count() !== 1 || wood.total() !== 14 || wood.keyAt(2) !== null) throw new Error("factory frames");
    for (const dispose of disposers) dispose();
    if (disposals !== 2) throw new Error("method value");

    interface Splash {
        setProgress: (p: number, key?: string) => void;
        onAbout(cb: () => void): void;
        onValue: (cb: () => void) => void;
        about(): void;
        caption(): string;
    }
    function createSplash(): Splash {
        let target = 0;
        let status = "sub";
        let aboutCallback: (() => void) | null = null;
        const listeners: Array<() => void> = [];
        return {
            setProgress(p: number, key?: string): void {
                if (key) status = key;
                target = Math.max(target, p);
            },
            onAbout(cb: () => void): void { aboutCallback = cb; },
            onValue: (cb) => { listeners.push(cb); },
            about(): void {
                if (aboutCallback) aboutCallback();
                for (const listener of listeners) listener();
            },
            caption: () => status + ":" + Math.round(target * 100),
        };
    }
    const splash = createSplash();
    const marks: string[] = [];
    {
        const inner = splash.setProgress;
        splash.setProgress = (p: number, key?: string): void => { marks.push(key ?? "p"); inner(p, key); };
    }
    let abouts = 0;
    let values = 0;
    splash.onAbout(() => abouts++);
    splash.onValue(() => { values += 2; });
    splash.setProgress(0.25, "load");
    splash.setProgress(0.5);
    splash.about();
    if (splash.caption() !== "load:50" || marks.join(",") !== "load,p") throw new Error("shared factory state");
    if (abouts !== 1 || values !== 2) throw new Error("record member keeps its callback");

    class Keeper {
        private kept: Array<() => void> = [];
        keep(cb: () => void): void { this.kept.push(cb); }
        wire(cb: () => void): void { this.keep(cb); }
        fire(): void { for (const cb of this.kept) cb(); }
    }
    const keeper = new Keeper();
    let viaMethod = 0;
    let viaThis = 0;
    keeper.keep(() => viaMethod++);
    keeper.wire(() => viaThis++);
    const kept: Array<() => void> = [];
    function forward(register: (cb: () => void) => void, step: number): void {
        let local = 0;
        register(() => { local += step; viaParameter = local; });
    }
    let viaParameter = 0;
    forward((cb) => kept.push(cb), 3);
    function keepAll(...callbacks: Array<() => void>): void { for (const cb of callbacks) kept.push(cb); }
    let viaRest = 0;
    keepAll(() => {}, () => viaRest++);
    keeper.fire();
    for (const cb of kept) cb();
    for (const cb of kept) cb();
    if (viaMethod !== 1 || viaThis !== 1) throw new Error("class method keeps its callback");
    if (viaParameter !== 6 || viaRest !== 2) throw new Error("function value keeps its callback");
`,
);

check(
    "record-method-rebinding-is-visible-to-retained-callbacks",
    `
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
`,
);

check(
    "nullable-string-enum-assertions",
    `
    const keys = ["low", "high"] as const;
    type Key = typeof keys[number];
    function parse(raw: string | null): Key | null {
        return (keys as readonly string[]).includes(raw ?? "") ? raw as Key : null;
    }
    const inputs: Array<string | null> = ["high", null, "unknown", "low"];
    const parsed = inputs.map(parse);
    if (parsed[0] !== "high" || parsed[1] !== null || parsed[2] !== null || parsed[3] !== "low") throw new Error("nullable enum assertion");
`,
);

async function executeGeneratedAssertions(
    t: TestContext,
    name: string,
    source: string,
): Promise<void> {
    await t.test(
        "generated C++ executes the same assertions",
        { skip: !native },
        () => {
            runGeneratedProgram(native!, `language-constructs/${name}`, source);
        },
    );
}

/**
 * The snippet sees one deployment query on both sides: the Node run reads
 * it as `location.search`, the compiler folds it as the reference query.
 */
function check(
    name: string,
    source: string,
    { search = "" }: { search?: string } = {},
): void {
    test(name, async (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            {
                location: { search },
                URLSearchParams,
                TextDecoder,
                TextEncoder,
                WeakRef,
                atob,
                btoa,
            },
        );
        const result = compileSource(source, {
            fileName: `${name}.ts`,
            search,
        });
        await executeGeneratedAssertions(t, name, result.cpp);
    });
}

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
    "constant-tables-use-literals-outside-local-scopes",
    `
    type Row = [number, number, "run" | null, boolean?];
    const first = 3, second = 7, enabled = true;
    const totals: number[] = [];
    function append(rows: Row[]): void {
        for (const [value, multiplier, , active] of rows) {
            totals.push(value * multiplier + (active ? 1 : 0));
        }
    }
    append([[first, 4, null, enabled], [second, 2, null, enabled]]);
    if (totals.join(",") !== "13,15") throw new Error("constant tuple table");
`,
);

check(
    "mixed-tuple-storage",
    `
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
`,
);

check(
    "conditional-json-null",
    `
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
`,
);

check(
    "fixed-record-entry-projection",
    `
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
`,
);

check(
    "compound-union-tags",
    `
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
`,
);

check(
    "contextual-string-array-results",
    `
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
`,
);

check(
    "stored-array-predicates",
    `
    interface Filter { run: (accept: (value: number) => boolean) => number[]; }
    const numbers: number[] = [1, 2, 3];
    const filter: Filter = {run: accept => [...numbers].filter(accept)};
    if (filter.run(value => value > 1).join(",") !== "2,3") throw new Error("stored predicate");
    let predicate: (value: number) => boolean = value => { predicate = () => false; return value > 0; };
    if (numbers.filter(predicate).length !== 3 || numbers.filter(predicate).length !== 0) throw new Error("callback argument snapshot");
`,
);

check(
    "assigned-optional-array-result",
    `
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
`,
);

check(
    "constructor-callback-instance-capture",
    `
    interface Hooks { change: () => number; }
    class Counter {
        value = 0;
        constructor(private readonly hooks: Hooks) {}
        next(): number { this.value++; return this.hooks.change(); }
    }
    const counter = new Counter({change: () => counter.value});
    if (counter.next() !== 1 || counter.next() !== 2) throw new Error("constructor closure observes instance");
`,
);

check(
    "absent-optional-iteration",
    `
    const input: {items?: readonly number[]} = {};
    let visited = 0;
    for (const item of input.items ?? []) {
        if (item < 0) continue;
        visited++;
        if (item === 4) break;
    }
    if (visited !== 0) throw new Error("absent iterable");
`,
);

check(
    "constant-array-slices",
    `
    const entries = [{score: 2}, {score: 7}, {score: 11}] as const;
    const gaps = entries.slice(1).map((entry, index) => entry.score - entries[index]!.score);
    if (Math.min(...gaps) !== 4 || entries.slice(-2, -0.5).length !== 0) throw new Error("constant slice bounds");
    let visits = 0;
    function next(): number { return ++visits; }
    const first = [next(), next(), next()].slice(0, 1);
    if (first[0] !== 1 || visits !== 3) throw new Error("discarded slice effects");
    const minimum = Math.min(...[2, 7, 11].map(value => value + 1));
    if (minimum !== 3 || Math.max(...[]) !== -Infinity) throw new Error("constant numeric spread");
`,
);

check(
    "indexed-and-union-string-parts",
    `
    function token(text: string): string { let i = 0, value = ""; while (i < text.length) value += text[i++]; return value; }
    if (token("text") !== "text") throw new Error("indexed concat");
    let index = 0;
    const text = "x" + ""[index++];
    if (text !== "xundefined" || index !== 1) throw new Error("missing character once");
    interface Label { text: (value: string | number) => string; }
    const label: Label = {text: value => \`value:\${value}\`};
    if (label.text(3) !== "value:3" || label.text("name") !== "value:name") throw new Error("union template");
`,
);

check(
    "logical-assignment",
    `
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
`,
);

check(
    "logical-string-selection",
    `
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
`,
);

check(
    "retained-nonfinite-records",
    `
    function entry() { return {invalid: Number.NaN, high: Number.POSITIVE_INFINITY, low: Number.NEGATIVE_INFINITY}; }
    const entries = Array.from({length: 3}, () => entry());
    for (const value of entries) {
        if (!Number.isNaN(value.invalid) || value.high !== Infinity || value.low !== -Infinity) throw new Error("nonfinite retained fields");
    }
`,
);

check(
    "contextual-conditional-arrays",
    `
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
`,
);

check(
    "recursive-array-callback",
    `
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
`,
);

check(
    "error-values",
    `
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
`,
);

check(
    "object-statics",
    `
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
`,
);

check(
    "string-indexing",
    `
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
`,
);

check(
    "string-indexing-parameter-lifetime",
    `
    function scan(text: string): number {
        let sum = 0;
        const n = text.length;
        for (let i = 0; i < n;) sum += text[i++]!.charCodeAt(0);
        for (let i = n - 1; i >= 0; i--) sum -= text.charCodeAt(i);
        if (text[n] !== undefined || text[-1] !== undefined || text[0.5] !== undefined ||
            !Number.isNaN(text.charCodeAt(Infinity))) throw new Error("indexed bounds");
        return sum;
    }
    if (scan("aé😀Z".repeat(20000)) !== 0 || scan("different") !== 0 || scan("") !== 0)
        throw new Error("repeated string traversal");
    function replace(text: string): string {
        const first = text[0];
        function change(): number { text = "cd"; return 1; }
        const selected = text[change()];
        return first + selected + text[0];
    }
    const runtimeText = "ab".repeat(Math.trunc(Math.random()) + 1);
    if (replace(runtimeText) !== "abc") throw new Error("mutable parameter snapshot");
    function retained(text: string): () => string | undefined {
        const first = text[0];
        return () => first + text[1];
    }
    const first = retained("ab"), second = retained("cd");
    if (first() !== "ab" || second() !== "cd") throw new Error("retained string capture");
`,
);

check(
    "literal-key-record-lookup",
    `
    type Mode = "low" | "high";
    interface Settings { amount: number; enabled: boolean; }
    const options: Readonly<Record<Mode, Settings>> = {
        low: { amount: 1, enabled: false }, high: { amount: 3, enabled: true },
    };
    const selected: Mode = "high";
    const settings = options[selected];
    if (settings.amount !== 3 || !settings.enabled) throw new Error("literal key lookup");
`,
);

check(
    "constant-filter-effects",
    `
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
`,
);

check(
    "readonly-record-array-lookup",
    `
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
`,
);

check(
    "iterators",
    `
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
`,
);

check(
    "dictionaries",
    `
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
`,
);

check(
    "weak-collections",
    `
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
`,
);

check(
    "readonly-sets-retain-container-identity-and-live-iteration",
    `
    interface State { members: ReadonlySet<string>; }
    function borrow(members: ReadonlySet<string>): ReadonlySet<string> { return members; }
    const source = new Set<string>(["alpha", "beta"]);
    const state: State = {members: source};
    const groups = new Map<string, ReadonlySet<string>>([["saved", borrow(state.members)]]);
    const saved = groups.get("saved")!;
    const copy = new Set(saved);
    const mutableCopy = new Set(source);
    source.add("gamma");
    if (saved !== source || saved !== state.members || saved.size !== 3 ||
        copy.size !== 2 || mutableCopy.size !== 2 || copy === mutableCopy || copy === source)
        throw new Error("readonly set aliases");
    let visited = "";
    saved.forEach((value, key, owner) => {
        if (value !== key || owner !== source) throw new Error("forEach identity");
        visited += value + ",";
        if (value === "gamma") source.add("delta");
    });
    if (visited !== "alpha,beta,gamma,delta," || !saved.has("delta"))
        throw new Error("live readonly iteration");
    const spread = [...saved];
    if (spread.join(",") !== "alpha,beta,gamma,delta" ||
        Array.from(saved.values()).join(",") !== "alpha,beta,gamma,delta")
        throw new Error("readonly iterable order");
    source.delete("beta");
    if (state.members.has("beta") || !copy.has("beta")) throw new Error("copy and alias");
`,
);

check(
    "readonly-sets-in-stored-catalogue-callbacks",
    `
    interface World { guests: ReadonlySet<string>; }
    interface Rule { id: string; when?: (world: World) => boolean; }
    const rules: Rule[] = [
        {id: "open"},
        {id: "gated", when: world => world.guests.has("entry")},
    ];
    const byId = new Map(rules.map(rule => [rule.id, rule]));
    const guests = new Set<string>();
    const world: World = {guests};
    const selected = byId.get("gated");
    if (!selected?.when || selected.when(world)) throw new Error("stored predicate");
    guests.add("entry");
    if (!selected.when(world) || byId.get("open")?.when !== undefined)
        throw new Error("nested readonly set signature");
    if (selected !== rules[1]) throw new Error("catalogue record identity");
`,
);

check(
    "set-copies-and-constructed-receivers",
    `
    interface Request { readonly clips: readonly string[] }
    function unique(request: Request): boolean {
        return Array.isArray(request.clips) && new Set(request.clips).size === request.clips.length;
    }
    if (!unique({ clips: ["a", "b"] }) || unique({ clips: ["a", "a"] })) throw new Error("literal requests");
    const pairs: [string, number][] = [["a", 1], ["b", 2], ["a", 3]];
    if (new Map(pairs).size !== 2 || new Float32Array([1, 2]).length !== 2) throw new Error("constructed sizes");
    if (new Uint8Array(new ArrayBuffer(8), 2).byteOffset !== 2) throw new Error("constructed view");
    const requests: Request[] = [{ clips: ["p"] }, { clips: ["q", "q"] }];
    if (requests.map(unique).join(",") !== "true,false") throw new Error("stored requests");
    function distinct(values: readonly number[]): number {
        const copy = Array.isArray(values) ? new Set(values) : new Set<number>();
        return copy.size;
    }
    if (distinct([1, 2, 2]) !== 2 || distinct([]) !== 0) throw new Error("number copies");
`,
);

check(
    "weak-references",
    `
    interface Item { id: number }
    class Node { constructor(public label: string) {} }
    const item: Item = { id: 1 };
    const refs: WeakRef<Item>[] = [new WeakRef(item), new WeakRef({ id: 2 })];
    const nodeRef = new WeakRef(new Node("a"));
    const node = nodeRef.deref()!;
    let total = 0;
    for (const ref of refs) {
        const target = ref.deref();
        if (!target) continue;
        total += target.id;
    }
    refs[0]!.deref()!.id = 5;
    nodeRef.deref()!.label += "b";
    if (total !== 3 || item.id !== 5 || node.label !== "ab" || nodeRef.deref() !== node) throw new Error("targets");
    const twin = new WeakRef(item);
    if (twin === refs[0] || twin.deref() !== refs[0]!.deref()) throw new Error("reference identity");
`,
);

check(
    "destructuring",
    `
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
`,
);

check(
    "generics",
    `
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
`,
);

check(
    "function-parameters",
    `
    function sum(...xs: number[]): number { let t = 0; for (const x of xs) t += x; return t; }
    function join(separator: string, ...parts: string[]): string { return parts.join(separator); }
    function sum3(a: number, b: number, c: number): number { return a + b + c; }
    const args: [number, number, number] = [1, 2, 3];
    const spread = [4, 5];
    if (sum(1, 2) + sum() + sum(...spread) !== 12) throw new Error("rest parameters");
    if (join("-", "a", "b") !== "a-b" || join("+") !== "") throw new Error("rest after fixed");
    if (sum3(...args) !== 6) throw new Error("tuple spread call");
`,
);

check(
    "module-state",
    `
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
`,
);

check(
    "class-shapes",
    `
    class A { v = 1; }
    class B { w = 2; }
    class Counter { constructor(private n: number) {} get doubled(): number { return this.n * 2; } read(): number { return [1].map(x => x + this.n)[0] ?? 0; } }
    function tag(x: unknown): number { return x instanceof A ? 1 : x instanceof B ? 2 : 0; }
    const items: Array<A | B> = [new A(), new B()];
    let total = 0;
    for (const item of items) total += item instanceof A ? item.v : item.w;
    if (total !== 3 || tag(new A()) + tag(new B()) + tag(3) !== 3) throw new Error("instanceof");
    if (new Counter(2).doubled + new Counter(3).read() !== 8) throw new Error("temporaries as receivers");
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
    "unary-numeric-json",
    `
    interface Rig { readonly axis: readonly [number, number, number]; readonly offset: number; readonly text: number; }
    const rig = JSON.parse('{"axis":[1,-2,0.5],"offset":3,"text":"4"}') as Rig;
    const flipped = { x: -rig.axis[0] * rig.offset, y: +rig.axis[1], z: -rig.axis[2] };
    if (flipped.x !== -3 || flipped.y !== -2 || flipped.z !== -0.5) throw new Error("unary over parsed lanes");
    if (-rig.text !== -4 || +rig.text !== 4) throw new Error("unary applies ToNumber to a parsed string");
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

checkInRealm(
    "promise-combinators-and-microtasks-without-engine",
    `
    let log = "";
    queueMicrotask(() => { log += "m"; });
    log += "s";
    void (async () => {
        await Promise.resolve();
        if (log !== "sm") throw new Error("microtask order " + log);
        const raced = await Promise.race([Promise.resolve(1), new Promise<number>(() => {})]);
        const first = await Promise.any([Promise.reject(new Error("x")), Promise.resolve(2)]);
        const settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("y"))]);
        if (raced !== 1 || first !== 2 || settled[1]!.status !== "rejected") throw new Error("combinators");
        const reasons: string[] = [];
        try {
            await Promise.any([Promise.reject(new Error("a")), Promise.reject(new Error("b"))]);
        } catch (error) {
            if (!(error instanceof AggregateError)) throw new Error("not aggregate");
            reasons.push(error.message);
        }
        try { await Promise.any([] as Promise<number>[]); } catch (error) { reasons.push(String(error instanceof AggregateError)); }
        if (reasons.join("|") !== "All promises were rejected|true") throw new Error("aggregate " + reasons.join("|"));
        const stored: Promise<number>[] = [Promise.reject(new Error("c")), Promise.resolve(4)];
        if ((await Promise.any(stored)) !== 4) throw new Error("stored any");
        globalThis.close();
    })();
`,
);

checkInRealm(
    "structured-clone-copies-data",
    `
    interface Row { a: number[]; name: string; when?: Date }
    const shared = [1, 2];
    const r: { left: Row; right: Row; map: Map<string, number>; bytes: Uint8Array } = {
        left: { a: shared, name: "l" }, right: { a: shared, name: "r", when: new Date(5) },
        map: new Map([["k", 1]]), bytes: new Uint8Array([1, 2, 3]),
    };
    const c = structuredClone(r);
    c.left.a.push(3);
    if (r.left.a.length !== 2 || c.right.a.length !== 3 || c.left.a !== c.right.a) throw new Error("aliases");
    if (c.right.when!.getTime() !== 5 || c.right.when === r.right.when || c.map.get("k") !== 1 || c.map === r.map) throw new Error("copies");
    c.bytes[0] = 9;
    if (r.bytes[0] !== 1 || c.bytes.length !== 3) throw new Error("bytes");
    let failed = "";
    interface Holder { f?: () => number; n: number }
    const holder: Holder = { n: 1, f: () => 2 };
    try { structuredClone(holder); failed += "no-throw;"; } catch (error) { if ((error as Error).name !== "DataCloneError") failed += "name;"; }
    const plain: Holder = { n: 3 };
    if (structuredClone(plain).n !== 3) failed += "absent function;";
    if (failed) throw new Error(failed);
    globalThis.close();
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
});

check(
    "regexp-unicode-flag-matches-code-points",
    String.raw`
    function stripMarks(value: string): string { return value.replace(/\p{Diacritic}/gu, "").toLowerCase().trim(); }
    if (stripMarks("Élodie Brontë ") !== "elodie bronte") throw new Error("diacritics");
    const s = ["abc", "a\u{1F600}b", "x\ud800y", "😀"];
    const astral = s[1]!;
    if (!/^a/u.test(s[0]!) || astral.match(/./gu)!.length !== 3 || astral.match(/./g)!.length !== 4) throw new Error("dot");
    if (!/^a.b$/u.test(astral) || /^a.b$/.test(astral)) throw new Error("dot anchors");
    if (astral.replace(/(?:)/gu, "-") !== "-a-\u{1F600}-b-") throw new Error("empty matches advance by code point");
    const parts = s[3]!.split(/(?:)/u);
    if (parts.length !== 1 || parts[0] !== "\u{1F600}" || "a,b".split(/,/u).join("|") !== "a|b" || "".split(/x/u).length !== 1) throw new Error("split");
    if (/\ude00/u.test(s[3]!) || !/😀/u.test(s[3]!) || !/^[\u{1F600}-\u{1F64F}]$/u.test(s[3]!)) throw new Error("surrogates");
    if (!/^x[\ud800-\udbff]y$/u.test(s[2]!) || !/^x.y$/u.test(s[2]!) || /^x𐀀/u.test("x\ud800")) throw new Error("lone lead");
    if (/[^a]/u.exec(s[3]!)![0] !== "\u{1F600}" || !/^\S$/u.test(s[3]!)) throw new Error("negated sets");
    if (!/ſ/iu.test("s") || /ſ/i.test("s") || !/[a-z]/iu.test("K") || !/^K$/iu.test("k")) throw new Error("case folding");
    if (!/^\p{Lu}+$/u.test("ÀB") || /^\P{L}$/u.test("é") || !/^\p{Script=Greek}$/u.test("α")) throw new Error("properties");
    const re = /./gu;
    re.lastIndex = 1;
    const found = re.exec("\u{1F600}\u{1F600}");
    if (!found || found[0] !== "\u{1F600}" || re.lastIndex !== 2) throw new Error("lastIndex inside a pair");
    if ("a1b22".replace(/(\d)(\d)?/gu, "[$1|$2|$&|$$|$01|$3]") !== "a[1||1|$|1|$3]b[2|2|22|$|2|$3]") throw new Error("substitution");
    if ("x\u{1F600}y".replace(/\u{1F600}/u, "$` +
        "`" +
        String.raw`$'") !== "xxyy") throw new Error("context substitution");
    const words = [..."é a\u{1F600}b".matchAll(/\w+/gu)].map((m) => m[0]);
    if (words.join(",") !== "a,b" || !/\bx/u.test("éx") || /\bé/u.test(" é")) throw new Error("words");
    const dynamic = new RegExp("^\\p{N}+$", "u");
    if (!dynamic.test("٣" + "3") || dynamic.test("x")) throw new Error("constructor");
    let count = 0;
    const replaced = "a\u{1F600}".replace(/(.)/gu, (match, char: string, offset: number) => { count++; return char + offset; });
    if (replaced !== "a0\u{1F600}1" || count !== 2) throw new Error("callback offsets");
`,
);

check(
    "map-reads-of-reference-backed-objects-are-absent-when-missing",
    `
    const dates = new Map<string, Date>();
    const missing = dates.get("x");
    if (missing !== undefined || dates.has("x")) throw new Error("missing date");
    dates.set("a", new Date(5));
    const found = dates.get("a");
    if (!found || found.getTime() !== 5 || dates.get("a") !== found) throw new Error("found date");
    let fallback = dates.get("y") ?? new Date(7);
    if (fallback.getTime() !== 7) throw new Error("fallback");
    fallback = dates.get("a") ?? new Date(9);
    if (fallback !== found) throw new Error("present identity");
`,
);

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
    "json-parse-revivers-rewrite-members-before-holders",
    `
    const s = JSON.parse('{"a":1}', (_k, v) => v) as { a: number };
    if (s.a !== 1) throw new Error("identity reviver");
    const keys: string[] = [];
    const doubled = JSON.parse('{"x":1,"y":{"z":2},"list":[3,4],"drop":5}', (key: string, value: unknown) => {
        keys.push(key);
        if (key === "drop") return undefined;
        return typeof value === "number" ? value * 2 : value;
    }) as { x: number; y: { z: number }; list: number[]; drop?: number };
    if (doubled.x !== 2 || doubled.y.z !== 4 || doubled.list[1] !== 8 || "drop" in doubled) throw new Error("revived");
    if (keys.join(",") !== "x,z,y,0,1,list,drop,") throw new Error("order " + keys.join(","));
    const root = JSON.parse("7", (_k: string, v: unknown) => (typeof v === "number" ? v + 1 : v)) as number;
    if (root !== 8) throw new Error("root");
`,
);

check(
    "object-create-define-property-and-prototype-tests",
    `
    const o: { x?: number; y: string } = { y: "a" };
    Object.defineProperty(o, "x", { value: 3, writable: true, enumerable: true, configurable: true });
    if (o.x !== 3 || o.y !== "a" || !("x" in o)) throw new Error("defineProperty");
    const counts: Record<string, number> = Object.create(null);
    counts["a"] = 1;
    counts["toString"] = 2;
    if (counts["a"] !== 1 || Object.keys(counts).join() !== "a,toString" || !("toString" in counts) || "valueOf" in counts) throw new Error("create(null)");
    class A { n = 1; }
    class B { n = 2; }
    const a = new A();
    const values: A[] = [a];
    if (Object.getPrototypeOf(a) !== A.prototype || Object.getPrototypeOf(values[0]!) !== A.prototype || Object.getPrototypeOf(new B()) === A.prototype) throw new Error("getPrototypeOf");
`,
);

test("a global-object member the program adds is window realm state", () => {
    const result = compileSource(
        `const g = globalThis as { __count?: number };
        if (!(g.__count === undefined)) throw new Error("absent member");`,
    );
    assert.match(result.cpp, /bbl::dom_window_property</);
});

test("Object.create, defineProperty and getPrototypeOf refuse unrepresented forms", () => {
    for (const [source, message] of [
        [
            "const p = { a: 1 }; const o: Record<string, number> = Object.create(p);",
            /Object\.create lowers with a null prototype only/,
        ],
        [
            "const o: { x?: number } = {}; Object.defineProperty(o, 'x', { value: 3 });",
            /Object\.defineProperty represents a value with writable, enumerable and configurable all true only/,
        ],
        [
            "const o: { x?: number } = {}; Object.defineProperty(o, 'x', { get: () => 3, enumerable: true, configurable: true });",
            /Object\.defineProperty represents writable, enumerable and configurable data properties only/,
        ],
        [
            "class A {} class B extends A {} const a = new A(); const r = Object.getPrototypeOf(a) === A.prototype;",
            /a class other classes extend is not represented/,
        ],
        [
            "const p = Object.getPrototypeOf({ a: 1 }); const r = p === null;",
            /Unsupported call target 'Object\.getPrototypeOf'/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

test("u-flag RegExp forms the runtime engine cannot express refuse", () => {
    for (const [source, message] of [
        [
            String.raw`const t = ["a"]; const r = /(?<=a)b/u.test(t[0]!);`,
            /Lookbehind assertions are not lowered/,
        ],
        [
            String.raw`const t = ["a"]; const r = /(?<x>a)/u.test(t[0]!);`,
            /Named groups are not lowered/,
        ],
        [
            String.raw`const t = ["aa"]; const r = /(a)\1/iu.test(t[0]!);`,
            /A backreference under the i and u flags/,
        ],
        [
            String.raw`const t = ["a"]; const r = /\ba/iu.test(t[0]!);`,
            /A word boundary under the i and u flags/,
        ],
        [
            String.raw`const t = ["a,b"]; const r = t[0]!.split(/(,)/u);`,
            /String\.split by a u-flag RegExp with capture groups/,
        ],
        [
            String.raw`const p = ["a"]; const r = new RegExp(p[0]!, "u");`,
            /A u-flag RegExp constructor needs a pattern known at generation/,
        ],
        [
            String.raw`const t = ["a"]; const r = /a/y.test(t[0]!);`,
            /support the g, i and u flags, not 'y'/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

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

test("instanceof a view class refuses over an ArrayBufferView member", () => {
    assert.throws(
        () =>
            compileSource(
                "function f(s: ArrayBuffer | ArrayBufferView): boolean { return s instanceof Uint8Array; } const unused = f(new ArrayBuffer(1));",
            ),
        /instanceof Uint8Array cannot be decided for an ArrayBufferView/,
    );
});

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
    "contextual-record-map-spreads",
    `
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
`,
);

check(
    "contextual-array-from-spreads",
    `
    const fields: readonly (readonly [string, "f32" | "vec4<f32>"])[] = [
        ...Array.from({ length: 2 }, (_, i) => [\`u\${i}\`, "vec4<f32>"] as const),
        ["s", "f32"],
    ];
    interface Option { name: string; size: number }
    const options: readonly Option[] = [...Array.from({ length: 3 }, (_, i) => ({ name: \`o\${i}\`, size: i * 2 })), { name: "z", size: 9 }];
    const text = fields.map(([name, type]) => name + ":" + type).join(",");
    if (text !== "u0:vec4<f32>,u1:vec4<f32>,s:f32") throw new Error("contextual tuples");
    if (options.map((o) => o.name + o.size).join(",") !== "o00,o12,o24,z9") throw new Error("contextual records");
`,
);

check(
    "spread-string-literal-sets",
    `
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
`,
);

check(
    "flat-map-tuple-alternatives",
    `
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
`,
);

check(
    "runtime-parameter-defaults",
    `
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
`,
);

check(
    "fixed-record-enumeration",
    `
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
`,
);

check(
    "readonly-numeric-dictionaries",
    `
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
`,
);

check(
    "numeric-index-outputs",
    `
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
`,
);

check(
    "strings-and-numbers",
    `
    function text(s: string): string { return s.charAt(0) + s.charAt(9) + s.padEnd(4, "-") + s.trimStart().trimEnd() + "|"; }
    if (text(" ab") !== " " + " ab-" + "ab|") throw new Error("string methods");
    function spell(n: number): string { return n.toString(16) + ":" + n.toString(2) + ":" + n.toString(); }
    if (spell(255) !== "ff:11111111:255" || (-10).toString(16) !== "-a" || (0.5).toString(2) !== "0.1") throw new Error("radix");
    function parse(s: string): number { return parseFloat(s) + Number.parseFloat(s) + parseInt(s, 10); }
    if (parse("1.5x") !== 4 || !Number.isNaN(parseFloat("x")) || parseFloat("  -2e1z") !== -20) throw new Error("parseFloat");
    if ("\\u00a0\\u3000x\\u2028\\ufeff".trim() !== "x" || parseFloat("\\u00a0\\u2029 3.5") !== 3.5) throw new Error("JavaScript white space");
    function num(s: string): number { return Number(s); }
    if (num(" \\u00a012\\u3000") !== 12 || num("\\u2028") !== 0 || num("5.") !== 5 || num("-Infinity") !== -Infinity || parseInt("\\u00a0 42px") !== 42)
        throw new Error("Number of decimal strings");
    if (num("0x1F") !== 31 || num("0o17") !== 15 || num("0B101") !== 5 || num("0x20000000000001") !== 9007199254740992)
        throw new Error("Number of radix strings");
    for (const bad of ["inf", "-0x10", "0x", "1e", "1_0", "0x1p3", "Infinityx", "."])
        if (!Number.isNaN(num(bad))) throw new Error("Number of " + bad);
    function truthy(n: number, s: string): number { return (Boolean(n) ? 1 : 0) + (Boolean(s) ? 2 : 0); }
    if (truthy(0, "x") !== 2 || truthy(3, "") !== 1) throw new Error("Boolean()");
    if (String(null) + String(undefined) !== "nullundefined") throw new Error("String of nullish");
    let a = 1;
    const comma = (a += 1, a * 10);
    if (comma !== 20 || Date.now() <= 0) throw new Error("comma and clock");
`,
);

check(
    "nullish-equality",
    `
    function absent(value: number | null | undefined): boolean { return value == null; }
    function present(value: string | null | undefined): boolean { return value != null; }
    if (!absent(null) || !absent(undefined) || absent(0) || absent(NaN)) throw new Error("numeric absence");
    if (present(null) || present(undefined) || !present("") || !present("text")) throw new Error("string presence");
    const document = JSON.parse('{"nil":null,"zero":0,"empty":"","no":false}');
    if (document.nil != null || document.missing != null || document.zero == null || document.empty == null || document.no == null)
        throw new Error("JSON nullish values");
    if (document.nil === undefined || document.missing === null) throw new Error("strict null distinction");
`,
);

test("raw text imports read the file beside the module", () => {
    const result = compileSource(
        'import shader from "./raw-text-import.wgsl?raw";\nif (shader.length !== 27) throw new Error("raw text length");\n',
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"),
        "the text file is a recorded input",
    );
});

test("raw text imports support constant string replacement through helpers", () => {
    const result = compileSource(
        `
        import shader from "./raw-text-import.wgsl?raw";
        function replacement(): string { return "return"; }
        const expanded = shader.replace(" r ", " " + replacement() + " ").replaceAll("1.0", "2.0");
        if (!expanded.includes("return 2.0")) throw new Error("raw text expansion");
    `,
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(result.cpp.includes("return 2.0"));
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"),
    );
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

check(
    "static-return-paths",
    `
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
`,
);

test("unsupported language shapes refuse explicitly", () => {
    for (const [source, message] of [
        [
            "function* gen(): Generator<number> { yield* new Set([1]); } for (const v of gen()) {}",
            /yield\* delegates to a generator, an iterator or an array/,
        ],
        [
            "const a = { x: 1 }; const b = { x: 1 }; if (Object.is(a, b)) {}",
            /Object.is compares/,
        ],
        [
            'function f(n: number): boolean { return "x" in n; } f(1);',
            /'in' is decided/,
        ],
        [
            "interface R { a: number } const rs: R[] = [{ a: 1 }]; rs.push({ a: 2 }); function f(r: R): void { delete (r as { a?: number }).a; } f(rs[0]!);",
            /required field/,
        ],
        [
            "function f(xs: number[]): void { xs[Math.trunc(Math.random())] ??= 2; } f([1]);",
            /must not contain a call/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "promise-rejection-parameters",
    `
    let seen = "";
    let calm = 0;
    let armed = true;
    async function risky(): Promise<void> {
        if (armed) throw new Error("boom");
        calm++;
    }
    void risky().catch((error) => {
        if (!(error instanceof Error) || error.message !== "boom") throw new Error("catch binding");
        seen = error.message;
    });
    void risky().then(() => { if (calm >= 0) throw new Error("fulfilled"); }, (error) => {
        if (error.message !== "boom") throw new Error("rejection binding");
    });
    void risky().catch((error) => { if (error.message.length !== 4) return; seen += "!"; });
    armed = false;
    void risky().catch((error) => { throw new Error("unexpected " + error.message); });
`,
);

check(
    "private-class-members",
    `
    interface Request { id: number; text: string; }
    class Queue<T extends Request> {
        readonly #pending: T[] = [];
        #priorityCount = 0;
        #current: T | null = null;
        get current(): T | null { return this.#current; }
        get size(): number { return this.#pending.length; }
        get #head(): T | undefined { return this.#pending[0]; }
        push(request: T, priority = false): void {
            if (this.#current) {
                if (priority) { this.#pending.splice(this.#priorityCount, 0, request); this.#priorityCount++; }
                else this.#pending.push(request);
                return;
            }
            this.#current = request;
        }
        advance(): T | null {
            if (this.#priorityCount > 0) this.#priorityCount--;
            const next = this.#pending.shift();
            this.#current = next ?? null;
            return this.#current;
        }
        #describe(): string { return this.#current ? this.#current.text : "idle"; }
        describe(): string { return this.#describe() + "/" + (this.#head?.text ?? "-"); }
    }
    const queue = new Queue<Request>();
    queue.push({ id: 1, text: "one" });
    queue.push({ id: 2, text: "two" });
    queue.push({ id: 3, text: "three" }, true);
    const before = queue.describe();
    const advanced = queue.advance();
    const after = queue.describe();
    if (before !== "one/three" || advanced?.id !== 3 || after !== "three/two" || queue.size !== 1 || queue.current?.text !== "three") {
        throw new Error(before + " " + after + " " + queue.size);
    }
    class Slot<T extends Request> {
        #value: T;
        #hits = 0;
        constructor(value: T) { this.#value = value; }
        touch(): number { this.#hits++; return this.#value.id + this.#hits; }
    }
    const slots: Slot<Request>[] = [];
    for (let index = 0; index < 3; index++) slots.push(new Slot<Request>({ id: index, text: "slot" }));
    let total = 0;
    for (const slot of slots) total += slot.touch() + slot.touch();
    if (total !== 15) throw new Error("stored generic private fields " + total);
`,
);

check(
    "struct-results-evaluate-once",
    `
    interface Item { id: number; }
    const queue: Item[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    let current: Item | null = null;
    current = queue.shift() ?? null;
    if (current?.id !== 1 || queue.length !== 2) throw new Error("shift once");
    const spare: Item = { id: 9 };
    const last = queue.pop() ?? spare;
    if (last.id !== 3 || queue.length !== 1) throw new Error("pop once");
    function next(): Item | undefined { return queue.pop(); }
    const inlined = next() ?? spare;
    if (inlined.id !== 2 || queue.length !== 0) throw new Error("inlined call once");
    let taken = 0;
    const pool: Item[] = [{ id: 5 }, { id: 6 }];
    function take(): Item { taken++; return pool[taken - 1]; }
    const sum = take().id + take().id;
    if (sum !== 11 || taken !== 2) throw new Error("snapshot once " + sum);
    class Node { id: number; constructor(id: number) { this.id = id; } bump(): void { this.id++; } }
    const nodes: Node[] = [new Node(1), new Node(2)];
    nodes.pop()?.bump();
    if (nodes.length !== 1 || nodes[0].id !== 1) throw new Error("receiver once");
`,
);

check(
    "string-append-storage",
    `
    class Log {
        private parts: string[] = ["a", "b"];
        private text = "";
        describe(): string { return this.parts.join("/"); }
        get size(): number { return this.parts.length; }
        add(entry: string): void { this.text += entry + ";"; }
        get all(): string { return this.text; }
    }
    const log = new Log();
    let text = log.describe();
    text += "|" + log.describe() + "|" + log.size;
    text += 2;
    if (text !== "a/b|a/b|22") throw new Error(text);
    log.add("x"); log.add("y");
    if (log.all !== "x;y;") throw new Error(log.all);
    interface Entry { text: string; count: number; }
    const entries: Entry[] = [{ text: "a", count: 0 }];
    entries[0].text += "b";
    if (entries[0].text !== "ab") throw new Error(entries[0].text);
    const words: string[] = ["a", "b"];
    words[1] += "c";
    words[0] += log.size;
    if (words.join(",") !== "a2,bc") throw new Error(words.join(","));
    const emoji = "😀";
    let joined = emoji.at(0) ?? "";
    joined += emoji.at(1) ?? "";
    if (joined !== emoji || joined.codePointAt(0) !== 128512) throw new Error("surrogate append");
`,
);

check(
    "resolved-query-values-in-native-expressions",
    `
    const qs = new URLSearchParams(location.search);
    const labTest = qs.has("labtest");
    const godMode = qs.has("godmode");
    const cleanLab = qs.has("guidedtour") || qs.has("rocktest");
    const enabled = Date.now() > 0;
    interface Save { size: number; }
    const saves: (Save | null)[] = [{ size: 3 }, null];
    const loaded = saves[enabled ? 0 : 1];
    function fits(size: number): boolean { return size === 3; }
    const sizeOk = labTest || loaded === null || fits(loaded.size);
    const content = loaded !== null && sizeOk ? loaded : null;
    if (content === null || content.size !== 3) throw new Error("mixed chain");
    const skipSplash = godMode || loaded === null;
    const persist = !labTest && !cleanLab && enabled;
    if (!skipSplash || !persist) throw new Error("folded and native operands");
    const base = enabled ? 10 : 20;
    const count = Number(qs.get("count") ?? "3") + base;
    const modeName = qs.get("mode") ?? "walk";
    const current = enabled ? "fly" : "walk";
    let matched = 0;
    if (current === modeName) matched += 1;
    if (count !== 14 || matched !== 1) throw new Error("query constants beside natives " + count + " " + matched);
    const driveName = (qs.get("drive") || "Studio").toLowerCase();
    if (driveName !== "studio" || (qs.get("mode") ?? "").length !== 3) throw new Error("query receivers " + driveName);
`,
    { search: "?godmode&count=4&mode=fly" },
);

check(
    "query-helpers-with-parameters",
    `
    const qs = new URLSearchParams(location.search);
    const num = (k: string, d: number): number => {
        const v = qs.get(k);
        return v !== null && Number.isFinite(Number(v)) ? Number(v) : d;
    };
    function str(k: string, d: string): string {
        const v = qs.get(k);
        return v !== null && v !== "" ? v : d;
    }
    let report = "";
    function main(): void {
        const keys: string[] = ["w", "h", "mode"];
        for (const key of keys) report += num(key, -1) + ":" + str(key, "none") + ";";
        report += num("w", 4) + ":" + qs.has("wire");
    }
    main();
    const moduleKeys: string[] = ["mode", "h"];
    for (const key of moduleKeys) report += "," + (qs.get(key) ?? "-");
    if (report !== "6:6;-1:none;-1:fly;6:true,fly,-") throw new Error(report);
`,
    { search: "?w=6&wire=1&mode=fly" },
);

check(
    "narrowed-type-parameters",
    `
    interface Save { size: number; }
    type Plan<S> = { kind: "fresh" } | { kind: "restore"; save: S };
    interface Intent<S> { plan: Plan<S>; skipSplash: boolean; }
    function plan<S>(save: S | null): Plan<S> {
        return save === null ? { kind: "fresh" } : { kind: "restore", save };
    }
    function intent<S>(plan: Plan<S>): Intent<S> {
        return { plan, skipSplash: false };
    }
    function pick<S>(candidate: S | null, fallback: S): S {
        return candidate === null ? fallback : candidate;
    }
    const saves: (Save | null)[] = [{ size: 3 }, null];
    const restored = plan(saves[Date.now() > 0 ? 0 : 1]);
    const fresh = intent(plan(saves[1]));
    const chosen = pick(saves[1], { size: 7 });
    if (restored.kind !== "restore" || restored.save.size !== 3 || fresh.plan.kind !== "fresh" || chosen.size !== 7) throw new Error("narrowed " + restored.kind + fresh.plan.kind);
    const index = Date.now() > 0 ? 1 : 0;
    let seen = "";
    if (saves[index] === null) seen += "null;";
    if (saves[index]) seen += "truthy;";
    if (seen !== "null;") throw new Error(seen);
`,
);

check(
    "class-inheritance-construction-order-and-super",
    `
    const log: string[] = [];
    function note(entry: string): number {
        log.push(entry);
        return log.length;
    }
    class Base {
        readonly order = note("base field");
        protected count = 0;
        #secret = 7;
        constructor(public label: string) {
            note("base body " + label);
        }
        get secret(): number {
            return this.#secret;
        }
        set secret(value: number) {
            this.#secret = value;
        }
        get doubled(): number {
            return this.count * 2;
        }
        bump(step: number = 1): number {
            this.count += step;
            return this.count;
        }
        name(): string {
            return "base";
        }
        who(): string {
            return this.name() + "/" + this.label;
        }
    }
    class Middle extends Base {
        readonly middle = note("middle field");
        constructor(label: string, public extra: number) {
            const prefix = "m-";
            note("middle before super");
            super(prefix + label);
            note("middle body " + this.extra);
        }
        override name(): string {
            return "middle(" + super.name() + ")";
        }
        override bump(step: number = 1): number {
            return super.bump(step * 10);
        }
        get doubled(): number {
            return super.doubled + 1;
        }
    }
    class Leaf extends Middle {
        readonly leaf = note("leaf field");
        override name(): string {
            return "leaf:" + super.name();
        }
    }
    const leaf = new Leaf("x", 5);
    if (log.join("|") !== "middle before super|base field|base body m-x|middle field|middle body 5|leaf field")
        throw new Error("construction order " + log.join("|"));
    if (leaf.order !== 2 || leaf.middle !== 4 || leaf.leaf !== 6) throw new Error("field initializer values");
    if (leaf.who() !== "leaf:middle(base)/m-x") throw new Error("virtual chain " + leaf.who());
    if (leaf.bump() !== 10 || leaf.bump(2) !== 30) throw new Error("super bump");
    if (leaf.doubled !== 61) throw new Error("super getter " + leaf.doubled);
    leaf.secret = 11;
    if (leaf.secret !== 11) throw new Error("inherited accessor pair");
    if (leaf.extra !== 5 || leaf.label !== "m-x") throw new Error("parameter properties");
    if (!(leaf instanceof Base) || !(leaf instanceof Middle) || !(leaf instanceof Leaf)) throw new Error("instanceof chain");
    const base = new Base("b");
    if (base instanceof Middle) throw new Error("base is not middle");
    if (base.who() !== "base/b" || base.doubled !== 0) throw new Error("base methods");
    class Plain extends Base {}
    const plain = new Plain("p");
    if (plain.who() !== "base/p" || plain.bump(3) !== 3) throw new Error("implicit constructor");
`,
);

check(
    "class-inheritance-generic-base",
    `
    class Box<T> {
        constructor(readonly value: T) {}
        get(): T {
            return this.value;
        }
        pair(other: T): T[] {
            return [this.value, other];
        }
    }
    class NumberBox extends Box<number> {
        doubled(): number {
            return this.get() * 2;
        }
    }
    class Labeled<T> extends Box<T> {
        constructor(value: T, readonly label: string) {
            super(value);
        }
    }
    const box = new NumberBox(3);
    if (box.get() + 1 !== 4 || box.doubled() !== 6 || box.pair(5).length !== 2) throw new Error("generic base");
    const labeled = new Labeled<string>("v", "l");
    if (labeled.get() + labeled.label !== "vl") throw new Error("generic chain");
`,
);

check(
    "class-hierarchy-virtual-dispatch-through-stored-references",
    `
    abstract class Shape {
        constructor(readonly name: string) {}
        abstract area(): number;
        describe(): string {
            return this.name + ":" + this.area();
        }
        get kind(): string {
            return "shape";
        }
    }
    class Square extends Shape {
        constructor(readonly side: number) {
            super("square");
        }
        area(): number {
            return this.side * this.side;
        }
        get kind(): string {
            return "square";
        }
    }
    class Circle extends Shape {
        radius: number;
        constructor(radius: number) {
            super("circle");
            this.radius = radius;
        }
        area(): number {
            return 3 * this.radius * this.radius;
        }
    }
    class Unit extends Square {
        constructor() {
            super(1);
        }
        describe(): string {
            return "unit/" + super.describe();
        }
    }
    const shapes: Shape[] = [new Square(2), new Circle(1), new Unit()];
    let total = 0;
    const names: string[] = [];
    for (const shape of shapes) {
        total += shape.area();
        names.push(shape.describe());
        names.push(shape.kind);
    }
    if (total !== 4 + 3 + 1) throw new Error("total " + total);
    if (names.join(",") !== "square:4,square,circle:3,shape,unit/square:1,square") throw new Error("names " + names.join(","));
    let squares = 0;
    for (const shape of shapes) {
        if (shape instanceof Square) squares++;
    }
    if (squares !== 2) throw new Error("instanceof " + squares);
    const areas = shapes.map((shape) => shape.area());
    if (areas.join(",") !== "4,3,1") throw new Error("areas " + areas.join(","));
`,
);

check(
    "class-hierarchy-with-callbacks-and-containers",
    `
    abstract class Animal {
        static population = 0;
        protected energy = 10;
        readonly listeners: Array<(animal: Animal) => void> = [];
        constructor(readonly name: string) {
            Animal.population++;
        }
        abstract speak(): string;
        get tired(): boolean {
            return this.energy < 5;
        }
        set boost(amount: number) {
            this.energy += amount;
        }
        act(times: number): number {
            for (let index = 0; index < times; index++) this.energy -= this.cost();
            for (const listener of this.listeners) listener(this);
            return this.energy;
        }
        protected cost(): number {
            return 1;
        }
    }
    class Dog extends Animal {
        tricks: string[] = [];
        speak(): string {
            return this.name + " barks";
        }
        protected override cost(): number {
            return 2;
        }
        set boost(amount: number) {
            this.energy += amount * 2;
        }
    }
    class Cat extends Animal {
        lives = 9;
        speak(): string {
            return this.name + " meows x" + this.lives;
        }
        override get tired(): boolean {
            return false;
        }
    }
    class Kitten extends Cat {
        override speak(): string {
            return "tiny " + super.speak();
        }
    }
    const zoo = new Map<string, Animal>();
    const seen = new Set<Animal>();
    const heard: string[] = [];
    function adopt(animal: Animal): void {
        zoo.set(animal.name, animal);
        animal.listeners.push((who) => {
            seen.add(who);
            heard.push(who.speak());
        });
    }
    adopt(new Dog("rex"));
    adopt(new Cat("tom"));
    adopt(new Kitten("kit"));
    if (Animal.population !== 3) throw new Error("population " + Animal.population);
    const energies: number[] = [];
    zoo.forEach((animal) => {
        energies.push(animal.act(3));
    });
    if (energies.join(",") !== "4,7,7") throw new Error("energies " + energies.join(","));
    if (heard.join("|") !== "rex barks|tom meows x9|tiny kit meows x9") throw new Error("heard " + heard.join("|"));
    if (seen.size !== 3) throw new Error("seen");
    const tired = [...zoo.values()].filter((animal) => animal.tired).map((animal) => animal.name);
    if (tired.join(",") !== "rex") throw new Error("tired " + tired.join(","));
    for (const animal of zoo.values()) animal.boost = 3;
    const after = [...zoo.values()].map((animal) => animal.act(0));
    if (after.join(",") !== "10,10,10") throw new Error("boost " + after.join(","));
    const cats = [...zoo.values()].filter((animal) => animal instanceof Cat).length;
    if (cats !== 2) throw new Error("cats " + cats);
    const rex = zoo.get("rex");
    if (rex instanceof Dog) rex.tricks.push("sit");
    const dog = zoo.get("rex");
    if (!(dog instanceof Dog) || dog.tricks.length !== 1) throw new Error("narrowed subclass field");
    const sorted = [...zoo.values()].sort((left, right) => left.speak().length - right.speak().length).map((animal) => animal.name);
    if (sorted.join(",") !== "rex,tom,kit") throw new Error("sorted " + sorted.join(","));
`,
);

check(
    "class-setter-on-stored-instance",
    `
    class Part {
        energy = 1;
        set boost(amount: number) {
            this.energy += amount;
        }
    }
    const parts: Part[] = [new Part(), new Part()];
    for (const part of parts) part.boost = 2;
    if (parts[0]!.energy !== 3) throw new Error("setter");
`,
);

check(
    "class-static-fields-and-blocks",
    `
    const order: string[] = [];
    class Counter {
        static created = 0;
        static readonly limit = 3;
        static names: string[] = [];
        static last = "";
        static {
            order.push("block " + Counter.created);
            this.last = "init";
        }
        static tail = Counter.created + 10;
        readonly id: number;
        constructor(readonly name: string) {
            Counter.created += 1;
            this.id = Counter.created;
            Counter.names.push(name);
            Counter.last = name;
        }
        static reset(): void {
            this.created = 0;
            this.names = [];
        }
        static describe(): string {
            return this.last + "#" + this.created + "/" + Counter.limit;
        }
        tag(): string {
            return this.name + "@" + this.id + "of" + Counter.created;
        }
    }
    order.push("after class");
    if (order.join(",") !== "block 0,after class") throw new Error("static block order " + order.join(","));
    if (Counter.tail !== 10 || Counter.last !== "init") throw new Error("static initializers");
    const a = new Counter("a");
    const b = new Counter("b");
    if (Counter.created !== 2 || Counter.names.join(",") !== "a,b") throw new Error("shared statics");
    if (a.tag() !== "a@1of2" || b.tag() !== "b@2of2") throw new Error("instance reads statics");
    Counter.created++;
    Counter.created *= 2;
    if (Counter.describe() !== "b#6/3") throw new Error("static method this " + Counter.describe());
    Counter.reset();
    if (Counter.created !== 0 || Counter.names.length !== 0) throw new Error("static reset");
    class Registry {
        static count = 0;
        static register(): number {
            return ++this.count;
        }
    }
    class Special extends Registry {
        static label = "special";
        static make(): string {
            const seen = Special.count;
            const next = Registry.register();
            return this.label + seen + next;
        }
    }
    Registry.register();
    if (Special.count !== 1) throw new Error("inherited static read");
    if (Special.make() !== "special12") throw new Error("inherited static method " + Special.count);
    if (Registry.count !== 2) throw new Error("shared inherited storage");
    function makeLocal(start: number): number {
        class Local {
            static value = start;
            static { Local.value *= 2; }
        }
        Local.value += 1;
        return Local.value;
    }
    if (makeLocal(3) !== 7 || makeLocal(5) !== 11) throw new Error("local class statics");
`,
);

check(
    "class-static-class-typed-fields",
    `
    class Settings {
        static #instance: Settings | null = null;
        volume = 5;
        static get(): Settings {
            if (Settings.#instance === null) Settings.#instance = new Settings();
            return Settings.#instance;
        }
    }
    Settings.get().volume = 7;
    if (Settings.get().volume !== 7) throw new Error("singleton");
    class Pool {
        static items: number[] = [];
        static take(): number {
            return this.items.length > 0 ? this.items.pop()! : -1;
        }
    }
    Pool.items.push(3, 4);
    if (Pool.take() !== 4 || Pool.take() !== 3 || Pool.take() !== -1) throw new Error("pool");
`,
);

check(
    "class-private-brand-checks",
    `
    class Token {
        #value: number;
        static #issued = 0;
        constructor(value: number) {
            this.#value = value;
            Token.#issued++;
        }
        static isToken(candidate: object): boolean {
            return #value in candidate;
        }
        static isTokenClass(candidate: object): boolean {
            return #issued in candidate;
        }
        equals(other: Token | Other): boolean {
            return #value in other && other.#value === this.#value;
        }
    }
    class Derived extends Token {}
    class Other {
        value = 1;
    }
    const token = new Token(3);
    const derived = new Derived(3);
    const other = new Other();
    if (!Token.isToken(token) || !Token.isToken(derived) || Token.isToken(other)) throw new Error("instance brand");
    if (!token.equals(derived) || token.equals(other)) throw new Error("brand narrowing");
    const plain = { value: 1 };
    if (Token.isToken(plain)) throw new Error("plain object brand");
    if (!Token.isTokenClass(Token) || Token.isTokenClass(token)) throw new Error("static brand");
    if (Token.isTokenClass(Derived)) throw new Error("static brand is not inherited");
`,
);

check(
    "class-static-block-at-module-evaluation",
    `
    let hits = 0;
    class Counter {
        static readonly base = 2;
        static { hits = 5; }
        value(): number { return hits; }
    }
    class Unused { static { hits += 1; } }
    function main(): void {
        if (new Counter().value() !== 6 || Counter.base + hits !== 8) throw new Error("static blocks " + hits);
    }
    main();
`,
);

check(
    "array-removal-yields-absent-on-empty-arrays",
    `
    const items: number[] = [];
    if ((items.pop() ?? -1) !== -1) throw new Error("pop empty");
    items.shift();
    items.pop();
    items.push(3, 4);
    const last = items.pop();
    if (last === undefined || last !== 4) throw new Error("pop value");
    const first = items.shift();
    if (first !== 3 || items.shift() !== undefined) throw new Error("shift value");
    const words: string[] = ["a"];
    const word = words.pop();
    if (word !== "a" || words.pop() !== undefined) throw new Error("string pop");
    const maybe: (number | null)[] = [null];
    if (maybe.pop() !== null || maybe.pop() !== undefined) throw new Error("nullable pop");
    class Node { constructor(readonly id: number) {} }
    const nodes: Node[] = [new Node(1)];
    const node = nodes.pop();
    if (!node || node.id !== 1 || nodes.pop()) throw new Error("reference pop");
    const stack = [5, 6];
    let sum = 0;
    let next = stack.pop();
    while (next !== undefined) { sum += next; next = stack.pop(); }
    if (sum !== 11) throw new Error("drain " + sum);
    const seven = [7];
    if (stack.length !== 0 || seven.pop()! !== 7) throw new Error("asserted pop");
`,
);

check(
    "evaluation-order-around-calls-that-write",
    `
    let count = 1;
    function reg(): number {
        count += 1;
        return count;
    }
    function regInline(extra: number[]): number {
        count += 1;
        extra.push(count);
        return count;
    }
    const s = "x" + count + reg();
    if (s !== "x12") throw new Error("concatenation order " + s);
    const t = count + regInline([]);
    if (t !== 5) throw new Error("arithmetic order " + t);
    const values = [count, reg()];
    if (values[0] !== 3 || values[1] !== 4) throw new Error("array order " + values.join(","));
    function pair(a: number, b: number): number {
        return a * 10 + b;
    }
    if (pair(count, reg()) !== 45) throw new Error("argument order");
    if (count === reg()) throw new Error("comparison order");
    function build(): void {
        const record = { before: count, after: reg() };
        if (record.before !== 6 || record.after !== 7) throw new Error("record order " + record.before);
    }
    build();
    class Box {
        constructor(readonly first: number, readonly second: number) {}
    }
    const box = new Box(count, reg());
    if (box.first !== 7 || box.second !== 8) throw new Error("constructor argument order");
    const scaled = count * 2 - reg();
    if (scaled !== 7) throw new Error("nested arithmetic order " + scaled);
    let item = 1;
    function changeList(): number[] { item = 2; return [3]; }
    const spread = [item, ...changeList(), item];
    if (spread.join(",") !== "1,3,2") throw new Error("spread evaluation order " + spread.join(","));
    const assigned = [item, item = 4];
    if (assigned.join(",") !== "2,4") throw new Error("array assignment order " + assigned.join(","));
`,
);

check(
    "evaluation-order-around-writes-before-reads",
    `
    let count = 1;
    function reg(): number {
        count += 1;
        return count;
    }
    function show(a: number, b: number): string {
        return a + ":" + b;
    }
    const first = show(reg(), count);
    if (first !== "2:2") throw new Error("writer first " + first);
    const joined = "x" + reg() + count;
    if (joined !== "x33") throw new Error("concatenation writer first " + joined);
    let n = 1;
    const sum = n + (n = 5);
    if (sum !== 6) throw new Error("assignment in the same expression " + sum);
    class Counter {
        value = 0;
        bump(): number {
            this.value += 1;
            return this.value;
        }
    }
    const counter = new Counter();
    const before = show(counter.value, counter.bump());
    if (before !== "0:1") throw new Error("reader before a method " + before);
    const after = show(counter.bump(), counter.value);
    if (after !== "2:2") throw new Error("method before a reader " + after);
    function fill(): number {
        const fresh: number[] = [];
        fresh.push(count);
        return fresh.length;
    }
    const values: number[] = [];
    const both = show(values.length, fill());
    if (both !== "0:1") throw new Error("a function writing only its own array " + both);
`,
);

check(
    "recursion-through-stored-instances",
    `
    class TreeNode {
        children: TreeNode[] = [];
        constructor(readonly value: number) {}
        add(child: TreeNode): TreeNode {
            this.children.push(child);
            return this;
        }
        sum(): number {
            let total = this.value;
            for (const child of this.children) total += child.sum();
            return total;
        }
    }
    const root = new TreeNode(1);
    const mid = new TreeNode(2);
    mid.add(new TreeNode(3));
    root.add(mid).add(new TreeNode(4));
    if (root.sum() !== 10) throw new Error("sum " + root.sum());
`,
);

check(
    "recursion-through-a-stored-hierarchy",
    `
    abstract class Shape {
        abstract area(): number;
        describe(depth: number): string {
            return "shape@" + depth;
        }
    }
    class Square extends Shape {
        constructor(readonly side: number) {
            super();
        }
        area(): number {
            return this.side * this.side;
        }
    }
    class Group extends Shape {
        readonly children: Shape[] = [];
        add(shape: Shape): Group {
            this.children.push(shape);
            return this;
        }
        area(): number {
            let total = 0;
            for (const child of this.children) total += child.area();
            return total;
        }
        override describe(depth: number): string {
            const parts: string[] = [];
            for (const child of this.children) parts.push(child.describe(depth + 1));
            return "group@" + depth + "[" + parts.join(",") + "]";
        }
        count(): number {
            return this.children.reduce((sum, child) => sum + (child instanceof Group ? child.count() : 1), 0);
        }
    }
    const inner = new Group().add(new Square(1)).add(new Square(2));
    const root = new Group().add(inner).add(new Square(3));
    if (root.area() !== 14) throw new Error("composite area " + root.area());
    if (root.describe(0) !== "group@0[group@1[shape@2,shape@2],shape@1]") throw new Error("describe " + root.describe(0));
    if (root.count() !== 3) throw new Error("count " + root.count());
    const shapes: Shape[] = [root, new Square(4)];
    let total = 0;
    for (const shape of shapes) total += shape.area();
    if (total !== 30) throw new Error("total " + total);
`,
);

check(
    "mutual-recursion-through-stored-instances",
    `
    class Ping {
        next: Pong | null = null;
        constructor(readonly weight: number) {}
        total(): number {
            return this.weight + (this.next ? this.next.total() : 0);
        }
    }
    class Pong {
        next: Ping | null = null;
        constructor(readonly weight: number) {}
        total(): number {
            return this.weight * 10 + (this.next ? this.next.total() : 0);
        }
    }
    const pongs: Pong[] = [];
    const chain: Ping[] = [];
    const a = new Ping(1);
    const b = new Pong(2);
    const c = new Ping(3);
    a.next = b;
    b.next = c;
    pongs.push(b);
    chain.push(a, c);
    if (a.total() !== 24) throw new Error("mutual " + a.total());
    let sum = 0;
    for (const ping of chain) sum += ping.total();
    if (sum !== 27) throw new Error("sum " + sum);
`,
);

check(
    "callbacks-calling-abstract-methods",
    `
    abstract class Animal {
        constructor(readonly name: string) {}
        abstract speak(): string;
    }
    class Dog extends Animal { speak(): string { return this.name + " barks"; } }
    class Cat extends Animal { speak(): string { return this.name + " meows"; } }
    const zoo: Animal[] = [new Dog("rex"), new Cat("po")];
    let total = 0;
    for (const animal of zoo) total += animal.speak().length;
    const sorted = [...zoo].sort((left, right) => left.speak().length - right.speak().length).map((animal) => animal.name);
    if (sorted.join(",") !== "po,rex" || total !== 17) throw new Error("sorted " + sorted.join(",") + total);
`,
);

check(
    "map-foreach-invokes-stored-instance-callbacks",
    `
    class Animal {
        readonly listeners: Array<(animal: Animal) => void> = [];
        constructor(readonly name: string) {}
        speak(): string { return this.name + " speaks"; }
    }
    const zoo = new Map<string, Animal>();
    const heard: string[] = [];
    function adopt(animal: Animal): void {
        zoo.set(animal.name, animal);
        animal.listeners.push((who) => {
            heard.push(who.speak());
        });
    }
    adopt(new Animal("rex"));
    adopt(new Animal("tom"));
    zoo.forEach((animal) => { for (const listener of animal.listeners) listener(animal); });
    if (heard.join("|") !== "rex speaks|tom speaks") throw new Error("heard " + heard.join("|"));
`,
);

check(
    "record-and-tuple-members-hold-their-built-values",
    `
    let count = 0;
    const holder = { value: 1 };
    const record = { seen: count, field: holder.value, draw: Math.random() };
    count = 5;
    holder.value = 9;
    if (record.seen !== 0) throw new Error("variable member " + record.seen);
    if (record.field !== 1) throw new Error("property member " + record.field);
    if (record.draw !== record.draw) throw new Error("draw member read twice");
    function bump(): void { count += 1; }
    const later = { seen: count };
    bump();
    if (later.seen !== 5) throw new Error("member across a call " + later.seen);
    function inside(): void {
        const snapshot = { seen: count };
        count = 7;
        if (snapshot.seen !== 6) throw new Error("function record " + snapshot.seen);
    }
    inside();
    const nested = { inner: { seen: count } };
    count = 8;
    if (nested.inner.seen !== 7) throw new Error("nested member " + nested.inner.seen);
    const list = [{ seen: count }];
    count = 9;
    if (list[0]!.seen !== 8) throw new Error("array element member " + list[0]!.seen);
    const lanes = [count, Math.random()];
    count = 10;
    if (lanes[0] !== 9) throw new Error("tuple lane " + lanes[0]);
    if (lanes[1] !== lanes[1]) throw new Error("tuple draw lane read twice");
    let label = "a";
    function tag(name: string): { name: string } { return { name }; }
    const tagged = tag(label);
    label = "b";
    if (tagged.name !== "a") throw new Error("parameter member " + tagged.name);
    function readAfterWrite(options: { seen: number }): number {
        const first = options.seen;
        count = 99;
        return first + options.seen;
    }
    if (readAfterWrite({ seen: count }) !== 20) throw new Error("argument member read after the callee writes");
    let title = "first";
    const titled = { title };
    const copied = title;
    title = "second";
    if (copied !== "first" || titled.title !== "first")
        throw new Error("a record read does not make its source constant " + copied);
`,
);

check(
    "array-literal-receivers-take-mutating-methods",
    `
    const last = [7, 8].pop();
    if (last !== 8) throw new Error("literal pop");
    const first = [7, 8].shift();
    if (first !== 7) throw new Error("literal shift");
    const none = ([] as number[]).pop();
    if (none !== undefined) throw new Error("empty literal pop");
    let count = 1;
    const drawn = [count, 5].pop()!;
    if (drawn !== 5) throw new Error("asserted literal pop " + drawn);
    count = 2;
    const pushed = [1, 2].push(3);
    if (pushed !== 3) throw new Error("literal push");
    const removed = [1, 2, 3].splice(1, 1);
    if (removed.length !== 1 || removed[0] !== 2) throw new Error("literal splice");
    const reversed = [1, 2, 3].reverse();
    if (reversed[0] !== 3) throw new Error("literal reverse");
`,
);

check(
    "absent values spell undefined or null in text",
    `
    enum Shape {
        Box = 0,
        Ball = 1,
    }
    enum Tone {
        Soft = "soft",
    }
    interface Options {
        label?: string;
        size?: number;
        wide?: boolean;
    }
    function describe(options: Options): string {
        return options.label + ":" + options.size + ":" + options.wide;
    }
    function main(): void {
        const items: number[] = [];
        if ("last " + items.pop() !== "last undefined") throw new Error("absent number");
        items.push(4);
        if (\`value \${items.pop()}\` !== "value 4") throw new Error("present number in a template");
        const flags: boolean[] = [];
        if ("flag " + flags.shift() !== "flag undefined") throw new Error("absent boolean");
        const lookup = new Map<string, number>([["a", 1]]);
        if (\`\${lookup.get("a")}/\${lookup.get("b")}\` !== "1/undefined") throw new Error("map lookups");
        let maybe: number | null = null;
        if ("maybe " + maybe !== "maybe null") throw new Error("null number");
        maybe = 2.5;
        if ("maybe " + maybe !== "maybe 2.5") throw new Error("present nullable number");
        if (describe({}) !== "undefined:undefined:undefined") throw new Error("absent fields " + describe({}));
        if (describe({ label: "x", size: 3, wide: true }) !== "x:3:true") throw new Error("present fields");
        const shapes: Shape[] = [];
        shapes.push(Shape.Ball);
        if ("shape " + shapes.pop() + shapes.pop() !== "shape 1undefined") throw new Error("enum");
        const tones: Tone[] = [];
        tones.push(Tone.Soft);
        if ("tone " + tones.pop() + tones.pop() !== "tone softundefined") throw new Error("string enum");
        const mixed: Array<number | string> = ["a"];
        if (\`\${mixed.pop()}|\${mixed.pop()}\` !== "a|undefined") throw new Error("absent union");
        let text = "sum";
        text += items.pop();
        if (text !== "sumundefined") throw new Error("append " + text);
        if (String(items.pop()) !== "undefined") throw new Error("String of an absent value");
        const pair: [number, number?] = [1];
        if ("second " + pair[1] !== "second undefined") throw new Error("missing tuple lane");
        const omitted: Options = {};
        if (typeof omitted.size !== "undefined") throw new Error("typeof an omitted field");
    }
    main();
`,
);

check(
    "text distinguishes null and undefined in mixed primitive storage",
    `
    function main(): void {
        const values: Array<number | null | undefined> = [];
        values.push(null);
        const spelled = "value " + values[0];
        if (spelled !== "value null") throw new Error("null spelling");
        values.push(undefined, 4);
        if (String(values[1]) !== "undefined" || String(values[2]) !== "4") throw new Error("distinct spellings");
    }
    main();
`,
);

check(
    "strict null and undefined equality follows the operand's type",
    `
    interface Options {
        label?: string;
        size?: number | null;
        onPick?: () => void;
    }
    function flags(options: Options): string {
        const parts: string[] = [];
        parts.push(options.label === null ? "n" : "-");
        parts.push(options.label === undefined ? "u" : "-");
        parts.push(options.label !== null ? "N" : "-");
        parts.push(options.label !== undefined ? "U" : "-");
        parts.push(options.label == null ? "nn" : "--");
        parts.push(options.label != undefined ? "UU" : "--");
        parts.push(options.onPick === null ? "fn" : "-");
        parts.push(options.onPick === undefined ? "fu" : "-");
        return parts.join("");
    }
    function main(): void {
        const absent = flags({});
        if (absent !== "-uN-nn---fu") throw new Error("absent field " + absent);
        const present = flags({ label: "x", onPick: () => {} });
        if (present !== "--NU--UU--") throw new Error("present field " + present);
        const sizes: Array<number | null> = [];
        sizes.push(null);
        const first = sizes[0];
        if (first !== null) throw new Error("stored null");
        const lookup = new Map<string, number>();
        const miss = lookup.get("a");
        if (miss === null || miss !== undefined) throw new Error("map miss is undefined");
        const items: number[] = [];
        const popped = items.pop();
        if (popped === null || popped !== undefined) throw new Error("pop of an empty array is undefined");
        const omitted: Options = {};
        if (omitted.label === null || omitted.label !== undefined) throw new Error("omitted field is undefined");
        const walls = new Map<string, { w: number } | null>();
        let built = 0;
        function wall(name: string): { w: number } | null {
            const cached = walls.get(name);
            if (cached !== undefined) return cached;
            built++;
            const result = name === "missing" ? null : { w: name.length };
            walls.set(name, result);
            return result;
        }
        if (wall("missing") !== null || wall("missing") !== null || built !== 1) throw new Error("a stored null is found " + built);
        const nullableSizes = new Map<string, number | null>([["none", null]]);
        const none = nullableSizes.get("none");
        const gone = nullableSizes.get("gone");
        if (none !== null || none === undefined || gone !== undefined || gone === null) throw new Error("stored null and miss");
        if ("a" + nullableSizes.get("none") + nullableSizes.get("gone") !== "anullundefined") throw new Error("lookup spelling");
    }
    main();
`,
);

check(
    "strict equality distinguishes null and undefined in mixed primitive storage",
    `
    function main(): void {
        const values: Array<number | null | undefined> = [];
        values.push(null, undefined, 0);
        const isNull = values[0] === null;
        if (!isNull || values[0] === undefined) throw new Error("stored null");
        if (values[1] !== undefined || values[1] === null) throw new Error("stored undefined");
        if (values[2] === undefined || values[2] === null || values[2] !== 0) throw new Error("stored zero");
    }
    main();
`,
);

check(
    "enum members inside array and object literals",
    `
    enum Shape {
        Box,
        Ball,
    }
    enum Tone {
        Soft = "soft",
        Bold = "bold",
    }
    function main(): void {
        const shapes: Shape[] = [Shape.Ball, Shape["Box"]];
        if (shapes.length !== 2 || shapes[0] !== Shape.Ball || shapes[1] !== 0) throw new Error("numeric enum array literal");
        const tones: Tone[] = [Tone.Bold, Tone["Soft"]];
        if (tones.join(",") !== "bold,soft") throw new Error("string enum array literal " + tones.join(","));
        const pair: [Shape, number] = [Shape.Ball, 2];
        if (pair[0] + pair[1] !== 3) throw new Error("enum tuple lane");
        const counts = [5, 7];
        counts[Shape.Box] -= 1;
        if (counts[Shape.Ball] !== 7 || counts[Shape.Box] !== 4) throw new Error("array indexed by an enum member");
        const byShape: Record<string, Shape> = { ball: Shape.Ball };
        if (byShape.ball !== 1) throw new Error("enum record member");
    }
    main();
`,
);

check(
    "strict null and undefined comparisons read whether the slot existed",
    `
    interface Attachment {
        label: string;
    }
    interface Entry {
        id: string;
        attachment: Attachment | null;
        note: string | null;
    }
    const catalog: Entry[] = [
        { id: "a", attachment: null, note: null },
        { id: "b", attachment: { label: "x" }, note: "n" },
    ];
    function find(id: string): Entry | undefined {
        return catalog.find((entry) => entry.id === id);
    }
    function main(): void {
        // Optional chain over a nullable field.
        if (find("a")?.attachment !== null) throw new Error("present owner, null field");
        if (find("a")?.attachment === undefined) throw new Error("present owner is not undefined");
        if (find("missing")?.attachment !== undefined) throw new Error("missing owner");
        if (find("missing")?.attachment === null) throw new Error("missing owner is not null");
        if (find("b")?.attachment === null || find("b")?.attachment === undefined) throw new Error("present field");
        const chained = find("a")?.attachment;
        if (chained !== null || chained === undefined) throw new Error("bound chain");
        if ("c" + find("a")?.note + find("missing")?.note + find("b")?.note !== "cnullundefinedn") throw new Error("chain spelling");
        // pop/shift of nullable elements.
        const maybe: (number | null)[] = [null];
        if (maybe.pop() !== null) throw new Error("popped null");
        if (maybe.pop() !== undefined) throw new Error("popped from empty");
        const queue: Array<string | null> = [null, "q"];
        const head = queue.shift();
        if (head !== null || head === undefined) throw new Error("shifted null");
        if (queue.shift() !== "q" || queue.shift() !== undefined) throw new Error("shifted rest");
        let order = "";
        const pops: (number | null)[] = [1, null];
        if (pops.pop() === null) order += "n";
        if (pops.pop() === 1) order += "1";
        if (pops.pop() === undefined) order += "u";
        if (order !== "n1u") throw new Error("two pops in turn " + order);
        // Index into an array of nullable elements.
        const sizes: Array<number | null> = [null, 3];
        if (sizes[0] !== null || sizes[1] !== 3) throw new Error("stored elements");
        let index = 5;
        if (sizes[index] === null || sizes[index] !== undefined) throw new Error("past the end");
        index = 0;
        if ("s" + sizes[index] + sizes[index + 7] !== "snullundefined") throw new Error("element spelling");
        const plain: number[] = [1];
        if (plain[3] === null) throw new Error("past the end of a never-null array");
    }
    main();
`,
);

check(
    "array reads past the end spell undefined in text",
    `
    function main(): void {
        const plain: number[] = [1, 2];
        let index = 3;
        if ("x" + plain[index] !== "xundefined") throw new Error("past the end in text " + plain[index]);
        index = 1;
        if (\`v\${plain[index]}\` !== "v2") throw new Error("in range in a template");
        const words: string[] = ["a"];
        let at = 4;
        if ("w" + words[at] !== "wundefined") throw new Error("string element past the end");
        const flags: boolean[] = [true];
        if ("f" + flags[at] + flags[0] !== "fundefinedtrue") throw new Error("boolean element");
        let text = "";
        for (let i = 0; i < plain.length; i++) text += plain[i];
        if (text !== "12") throw new Error("canonical loop " + text);
        if (String(plain[index + 5]) !== "undefined") throw new Error("String() past the end");
        const held = plain[index + 9];
        plain.push(3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
        if ("h" + held !== "hundefined") throw new Error("a local keeps its missed slot " + held);
        const heldWord = words[at];
        words.push("b", "c", "d", "e");
        if ("h" + heldWord !== "hundefined") throw new Error("a string local keeps its missed slot");
        if ("h" + words[at] !== "he") throw new Error("the slot filled later");
    }
    main();
`,
);

check(
    "enum array reads past the end spell undefined in text",
    `
    enum Tone {
        Soft = 1,
        Loud = 2,
    }
    enum Name {
        A = "a",
    }
    function main(): void {
        const tones: Tone[] = [Tone.Soft, Tone.Loud];
        const names: Name[] = [Name.A];
        let at = 5;
        if ("t" + tones[at] + tones[1] !== "tundefined2") throw new Error("numeric enum element past the end");
        if (\`n\${names[at]}\${names[0]}\` !== "nundefineda") throw new Error("string enum element past the end");
        at = 0;
        if ("t" + tones[at] !== "t1") throw new Error("numeric enum element in range");
    }
    main();
`,
);

check(
    "Array.sort takes a class field, property or stored function comparator",
    `
    class Store {
        private readonly depth: number[] = [3, 1, 2, 0];
        private readonly topoLess = (a: number, b: number): number => (this.depth[a]! - this.depth[b]!) || (a - b);
        order(slots: number[]): string {
            slots.sort(this.topoLess);
            return slots.join(",");
        }
    }
    function main(): void {
        if (new Store().order([0, 1, 2, 3]) !== "3,1,2,0") throw new Error("class field comparator");
        const holder = { compare: (a: number, b: number): number => b - a };
        const values = [1, 3, 2];
        values.sort(holder.compare);
        if (values.join(",") !== "3,2,1") throw new Error("property comparator");
        let picked = 0;
        const descending = (a: number, b: number): number => b - a;
        const ascending = (a: number, b: number): number => a - b;
        const choose = (down: boolean): ((a: number, b: number) => number) => {
            picked++;
            return down ? descending : ascending;
        };
        const numbers = [2, 9, 4];
        numbers.sort(choose(numbers.length > 2));
        if (numbers.join(",") !== "9,4,2" || picked !== 1) throw new Error("evaluated once " + picked);
        let receiver = [3, 1];
        const original = receiver;
        const rebind = (): ((a: number, b: number) => number) => {
            receiver = [8, 9];
            return ascending;
        };
        receiver.sort(rebind());
        if (original.join(",") !== "1,3" || receiver.join(",") !== "8,9") throw new Error("receiver before comparator");
    }
    main();
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

test("dense arrays refuse sparse length growth", { skip: !native }, () => {
    const result = compileSource(`
    function main(): void {
        const counts: Array<number | undefined> = [1];
        let refused = false;
        try { counts.length = 3; } catch { refused = true; }
        if (!refused || counts.length !== 1) throw new Error("optional sparse growth must refuse without mutation");
        const objects: Array<{ id: number } | null> = [{ id: 2 }];
        refused = false;
        try { objects.length = 3; } catch { refused = true; }
        if (!refused || objects.length !== 1) throw new Error("object sparse growth must refuse without mutation");
        counts.length = 0;
        objects.length = 0;
        if (counts.length !== 0 || objects.length !== 0) throw new Error("truncation");
    }
    main();
`);
    runGeneratedProgram(
        native!,
        "language-constructs/sparse-length-refusal",
        result.cpp,
    );
});

check(
    "a generic call binds its type parameter through a discriminated union alias",
    `
    interface Save { size: number; seed: number }
    type Plan<S> = { kind: "fresh" } | { kind: "restore"; save: S };
    function plan<S>(save: S | null): Plan<S> {
        return save === null ? { kind: "fresh" } : { kind: "restore", save };
    }
    function buildsFresh<S>(p: Plan<S>): p is { kind: "fresh" } {
        return p.kind === "fresh";
    }
    function restoreSize<S extends Save>(p: Plan<S>): number {
        return p.kind === "restore" ? p.save.size : 0;
    }
    function main(): void {
        const loaded: Save | null = { size: 3, seed: 7 };
        const initial = plan(loaded);
        let restored = 0;
        if (!buildsFresh(initial)) restored = initial.save.seed;
        if (restored !== 7) throw new Error("narrowed by a generic predicate");
        if (restoreSize(initial) !== 3) throw new Error("bound through the restore member");
        if (!buildsFresh(plan<Save>(null))) throw new Error("fresh member");
    }
    main();
`,
);

check(
    "a stored closure reads later bindings through the functions it reaches",
    `
    function main(): void {
        const handlers: Array<() => void> = [];
        handlers.push(() => markCommitted());
        let edits = 0;
        let admitted = false;
        const log: string[] = [];
        const label = "edit" + log.length;
        const markEdited = (): void => {
            if (admitted) return;
            edits += 1;
            log.push(label + ":" + edits);
        };
        const markCommitted = (): void => markEdited();
        for (const handler of handlers) handler();
        admitted = true;
        for (const handler of handlers) handler();
        if (edits !== 1 || log.join() !== "edit0:1") throw new Error("stored callback " + log.join());
    }
    main();
`,
);

check(
    "stored closures preserve the temporal dead zone of pure later bindings",
    `
    function main(): void {
        const seed = 7;
        const readers: Array<() => number> = [];
        readers.push(() => literal);
        readers.push(() => reference);
        readers.push(() => dependent);
        let refused = 0;
        for (const read of readers) {
            try { read(); } catch { refused++; }
        }
        const literal = 7;
        const reference = seed;
        const laterSeed = 7;
        const dependent = laterSeed * 2;
        if (refused !== 3) throw new Error("later initializer ran early");
        if (readers[0]!() !== 7 || readers[1]!() !== 7 || readers[2]!() !== 14)
            throw new Error("later initializer value");
    }
    main();
`,
);

check(
    "stored closures preserve the temporal dead zone of later callback records",
    `
    const readers: Array<() => number> = [];
    readers.push(() => options.read());
    readers.push(() => readOptions());
    let refused = 0;
    for (const read of readers) {
        try { read(); }
        catch (error) {
            if (!String(error).includes("before initialization")) throw error;
            refused++;
        }
    }
    if (refused !== 2) throw new Error("later callback record initialized early");
    const options = { read: () => 7 };
    function readOptions(): number { return options.read(); }
    if (readers[0]!() !== 7 || readers[1]!() !== 7)
        throw new Error("later callback record value");
`,
);

check(
    "a named function expression calls itself by its own name",
    `
    function countdown(n: number): number[] {
        const out: number[] = [];
        const run = function step(k: number): void {
            out.push(k);
            if (k > 0) step(k - 1);
        };
        run(n);
        return out;
    }
    function main(): void {
        if (countdown(3).join() !== "3,2,1,0") throw new Error("statement recursion");
        const factorial = function f(n: number): number {
            return n <= 1 ? 1 : n * f(n - 1);
        };
        if (factorial(5) !== 120) throw new Error("value recursion");
    }
    main();
`,
);

check(
    "Array.sort takes a class field comparator",
    `
    class Store {
        private readonly depth: number[] = [3, 1, 2, 1];
        private readonly topoLess = (a: number, b: number): number =>
            this.depth[a]! - this.depth[b]! || a - b;
        order(slots: number[]): number[] {
            const dirty = slots.slice();
            dirty.sort(this.topoLess);
            return dirty;
        }
    }
    function main(): void {
        const store = new Store();
        if (store.order([0, 1, 2, 3]).join() !== "1,3,2,0") throw new Error("field comparator");
        if (store.order([2, 0]).join() !== "2,0") throw new Error("second sort");
    }
    main();
`,
);

test("engine calls that write their arguments keep operand order and object storage", async (t) => {
    // The pinned normalizeVec3ToRef and scaleVec3ToRef write `out`; the
    // expected values follow their bodies (`v.x * (1 / len)`).
    const result = compileSource(
        `import { normalizeVec3ToRef, scaleVec3ToRef } from "@babylonjs/lite";
        function show(a: number, b: number): string { return a + ":" + b; }
        const v = { x: 3, y: 0, z: 4 };
        const normalized = show(v.x, normalizeVec3ToRef(v, v).x);
        if (normalized !== "3:" + 3 * (1 / 5)) throw new Error("engine argument write " + normalized);
        const w = { x: 1, y: 2, z: 3 };
        function grow(target: { x: number; y: number; z: number }): number {
            scaleVec3ToRef(target, 2, target);
            return target.z;
        }
        const grown = show(w.x, grow(w));
        if (grown !== "1:6" || w.x !== 2) throw new Error("engine write through a function " + grown);`,
        { fileName: "engine-argument-writes.ts" },
    );
    await executeGeneratedAssertions(t, "engine-argument-writes", result.cpp);
});

test("imported class static fields and blocks run when their module evaluates", async (t) => {
    const directory = resolve("artifacts/class-static-state-module");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "counter.ts"),
        `export class Counter {
            static count = 0;
            static readonly step = 2;
            static { Counter.count = 10; }
            static next(): number { this.count += Counter.step; return this.count; }
        }
        let evaluated = 0;
        class Unused { static { evaluated += 1; } }
        export function peek(): number { return Counter.count + evaluated * 100; }`,
    );
    const result = compileSource(
        `import { Counter, peek } from "./counter.js";
        if (Counter.next() !== 12 || peek() !== 112) throw new Error("imported statics " + peek());`,
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(
        t,
        "class-static-state-module",
        result.cpp,
    );
});

test("class inheritance and static state refuse what one record or struct cannot represent", () => {
    const refusals: ReadonlyArray<readonly [string, RegExp]> = [
        [
            `class A { constructor(readonly x: number) {} }
            class B extends A { constructor(flag: boolean) { if (flag) { super(1); } else { super(2); } } }
            const b = new B(true); const unused = b.x;`,
            /super\(\.\.\.\) is lowered as a top-level statement/,
        ],
        [
            `class A { static count = 0; }
            class B extends A {}
            B.count++;`,
            /Static field 'count' is inherited by class 'B'/,
        ],
        [
            `class A { static count = 0; static bump(): void { this.count += 1; } }
            class B extends A {}
            B.bump();`,
            /Static field 'count' is inherited by class 'B'/,
        ],
        [
            `class Box<T> { constructor(readonly value: T) {} }
            class NumberBox extends Box<number> {}
            const boxes: Box<number>[] = [new NumberBox(1)];
            const unused = boxes.length;`,
            /is generic; a stored instance of a hierarchy needs one layout/,
        ],
        [
            `abstract class A {}
            class B extends A { tag = 1; }
            class C extends A { tag = "x"; }
            const all: A[] = [new B(), new C()];
            const unused = all.length;`,
            /Field 'tag' has a different native type in class 'C'/,
        ],
        [
            `class Clock extends Date { constructor() { super(0); } }
            const clock = new Clock(); const unused = clock.getTime();`,
            /extends 'Date', which is not a local class with a body/,
        ],
        [
            `class A { #x = 1; readA(): number { return this.#x; } }
            class B extends A { #x = 2; readB(): number { return this.#x; } }
            const b = new B(); const unused = b.readA() + b.readB();`,
            /Private name '#x' is declared by both 'A' and 'B'/,
        ],
        [
            `class Leaf { constructor(readonly weight: number) {} }
            class Holder {
                other: Leaf | null = null;
                read(): number { return this.other ? this.other.weight : -1; }
            }
            const holders: Holder[] = [];
            const holder = new Holder();
            holders.push(holder);
            const leaf = new Leaf(5);
            holder.other = leaf;
            const unused = holder.read();`,
            /Field 'other' of a shared class instance is not stored per instance/,
        ],
        [
            `class A { value = 1; }
            class B extends A { value!: number; }
            const b = new B(); const unused = b.value;`,
            /redeclares an inherited field without an initializer/,
        ],
        [
            `class A { value = 1; }
            class B extends A { read(): number { return super.value; } }
            const b = new B(); const unused = b.read();`,
            /'super\.value' reads a base class accessor/,
        ],
    ];
    for (const [source, message] of refusals) {
        assert.throws(() => compileSource(source), message);
    }
});

test("promise rejection callbacks refuse parameters the rejection cannot supply", () => {
    assert.throws(
        () =>
            compileSource(`
        let calm = 0;
        async function risky(): Promise<void> { calm++; }
        void risky().catch((error, extra) => { if (error || extra) calm++; });
    `),
        /declares more parameters than the operation supplies/,
    );
});

test("setter-only properties permit direct writes and refuse stored accessor assignment", () => {
    compileSource(`
        let written = 0;
        const target = { set value(next: number) { written = next; } };
        target.value = 3;
        console.log(written);
    `);
    assert.throws(
        () =>
            compileSource(`
        let written = 0;
        const targets = [{ set value(next: number) { written = next; } }];
        targets[0]!.value = 3;
        console.log(written, targets.length);
    `),
        /This data assignment requires a stored field rather than an accessor/,
    );
});

check(
    "optional-property-own-key-presence",
    `
    interface Stops { day?: string; strength?: number }
    interface Quality { postProcess: boolean; steps?: number; maxPixels: number | undefined; stops?: Stops; charm?: { points: number } | null }
    interface Config { name: string; quality: Quality; extra?: { scale: number } }
    const DEFAULTS: Config = { name: "garden", quality: { postProcess: true, maxPixels: undefined, stops: { day: "a" }, charm: { points: 2 } } };
    function isPlainObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function validate(candidate: unknown, defaults: unknown): string[] {
        const problems: string[] = [];
        const walk = (value: unknown, base: unknown, path: string): void => {
            if (!isPlainObject(value) || !isPlainObject(base)) return;
            for (const key of Object.keys(value)) {
                const here = path === "" ? key : path + "." + key;
                if (!(key in base)) { problems.push("unknown " + here); continue; }
                const expected = base[key];
                if (expected === undefined) { problems.push("open " + here); continue; }
                walk(value[key], expected, here);
            }
        };
        walk(candidate, defaults, "");
        return problems;
    }
    const parsed = JSON.parse('{"name":"x","quality":{"steps":3,"maxPixels":5,"stops":{"day":"b","strength":2},"charm":{"points":1,"x":0}},"extra":{"scale":1}}') as unknown;
    if (validate(parsed, DEFAULTS).join(",") !== "unknown quality.steps,open quality.maxPixels,unknown quality.stops.strength,unknown quality.charm.x,unknown extra")
        throw new Error("dynamic view own keys");
    const viewed = DEFAULTS.quality as unknown as Record<string, unknown>;
    if (Object.keys(viewed).join(",") !== "postProcess,maxPixels,stops,charm" || "steps" in viewed || !("maxPixels" in viewed) || !("charm" in DEFAULTS.quality))
        throw new Error("dynamic view keys");
    type Weights = { base: number; bonus?: number; cap: number | undefined };
    const weights: Weights = { base: 1, bonus: 4, cap: 2 };
    if (Object.keys(weights).join(",") !== "base,bonus,cap" || Object.values(weights).map((value) => String(value)).join(",") !== "1,4,2")
        throw new Error("present optional keys");
    delete weights.bonus;
    const entries = Object.entries(weights).map(([key, value]) => key + "=" + String(value));
    if (entries.join(",") !== "base=1,cap=2" || "bonus" in weights || !("maxPixels" in DEFAULTS.quality))
        throw new Error("deleted optional key");
    const copy: Record<string, unknown> = { ...(DEFAULTS.quality as unknown as Record<string, unknown>) };
    if (Object.keys(copy).join(",") !== "postProcess,maxPixels,stops,charm" || copy["maxPixels"] !== undefined)
        throw new Error("spread own keys");
`,
);

check(
    "struct-spread-into-record-literal",
    `
    interface Spec { id: string; rgb: [number, number, number] }
    interface Swatch extends Spec { swatch: string }
    const SPECS: Spec[] = [{ id: "a", rgb: [1, 0.5, 0.25] }, { id: "b", rgb: [0.5, 1, 0.25] }];
    const hex = (rgb: readonly [number, number, number]): string => rgb.map((c) => Math.round(c * 100)).join("-");
    const swatches: Swatch[] = SPECS.map((s) => ({ ...s, swatch: hex(s.rgb) }));
    if (swatches.length !== 2 || swatches[1]!.swatch !== "50-100-25" || swatches[0]!.id !== "a") throw new Error("spread fields");
    SPECS[0]!.rgb[0] = 9;
    SPECS[0]!.id = "z";
    if (swatches[0]!.rgb[0] !== 9 || swatches[0]!.id !== "a") throw new Error("spread copies scalars and shares nested objects");
    const lilies: { model: string; labelKey: string }[] = [{ model: "lily", labelKey: "k" }];
    const list = [{ model: "x", labelKey: "y", tool: "flower" as const }, ...lilies.map((f) => ({ ...f, tool: "lily" as const }))];
    if (list.length !== 2 || list[1]!.tool !== "lily" || list[1]!.model !== "lily" || list[0]!.labelKey !== "y") throw new Error("spread element");
`,
);

check(
    "for-in-own-keys",
    `
    const urls: Partial<Record<string, string>> = {};
    urls["a"] = "x";
    urls["b"] = "y";
    urls["c"] = "z";
    urls["d"] = "w";
    const seen: string[] = [];
    for (const k in urls) {
        if (k === "a") delete urls["b"];
        if (k === "c") continue;
        if (k === "d") break;
        seen.push(k + "=" + urls[k]!);
    }
    if (seen.join(",") !== "a=x") throw new Error("dictionary keys");
    const fixed = { one: 1, three: 3 };
    let total = 0;
    for (const key in fixed) total += key.length;
    if (total !== 8) throw new Error("record keys");
    const doc = JSON.parse('{"p":1,"q":[2],"r":null}') as Record<string, unknown>;
    const names: string[] = [];
    for (const name in doc) names.push(name);
    if (names.join(",") !== "p,q,r") throw new Error("document keys");
    type Weights = { base: number; extra?: number; cap: number | undefined };
    const weights: Weights[] = [{ base: 1, cap: undefined }, { base: 2, extra: 3, cap: 4 }];
    const keys: string[] = [];
    for (const item of weights) for (const key in item) keys.push(key);
    if (keys.join(",") !== "base,cap,base,extra,cap") throw new Error("struct keys");
`,
);

check(
    "for-in-observes-struct-deletions",
    `
    const data: { a?: number; b?: number } = { a: 1, b: 2 };
    const seen: string[] = [];
    for (const key in data) {
        seen.push(key);
        if (key === "a") delete data.b;
    }
    if (seen.join(",") !== "a") throw new Error("enumerated deleted key");
`,
);

check(
    "for-in-retains-owner-after-rebinding",
    `
    let dictionary: Record<string, number> = { a: 1, b: 2 };
    const original = dictionary;
    const seen: string[] = [];
    for (const key in dictionary) {
        seen.push(key);
        dictionary = { replacement: 3 };
    }
    if (seen.join(",") !== "a,b" || original.b !== 2)
        throw new Error("enumeration changed owner");
`,
);

check(
    "runtime-for-of-renamed-fields-snapshot",
    `
    const items: { x: number; nested: { value: number } }[] = [{ x: 1, nested: { value: 3 } }];
    const retained: Array<() => number> = [];
    for (const { x: saved, nested: original } of items) {
        items[0]!.x = 2;
        items[0]!.nested = { value: 4 };
        if (saved !== 1 || original.value !== 3) throw new Error("field snapshot");
        retained.push(() => saved + original.value);
    }
    if (retained[0]!() !== 4) throw new Error("retained snapshot");
`,
);

check(
    "static-for-of-object-destructuring",
    `
    const CREDITS = [
        { key: "us", name: "A" },
        { key: "es", name: "B" },
    ] as const;
    const handlers: Array<() => string> = [];
    for (const { key, name: who } of CREDITS) handlers.push(() => key + ":" + who);
    if (handlers.map((handler) => handler()).join(",") !== "us:A,es:B") throw new Error("destructured elements");
`,
);

check(
    "runtime-for-of-enum-field-snapshot",
    `
    type Phase = "before" | "after";
    const rows: { phase: Phase }[] = [{phase: "before"}, {phase: "after"}];
    const readers: Array<() => string> = [];
    for (const {phase: saved} of rows) {
        rows[0]!.phase = "after";
        readers.push(() => saved);
    }
    if (rows[0]!.phase !== "after" || readers.map(read => read()).join(",") !== "before,after")
        throw new Error("enum field snapshot");
`,
);

check(
    "array-entries-of-nullish-selection",
    `
    interface View { buffer?: number; byteLength: number }
    interface Doc { bufferViews?: View[] }
    const doc = JSON.parse('{"bufferViews":[{"buffer":0,"byteLength":4},{"byteLength":8}]}') as Doc;
    let sum = 0;
    for (const [index, view] of (doc.bufferViews ?? []).entries()) sum += index * 100 + (view.buffer ?? 7) + view.byteLength;
    const empty = JSON.parse("{}") as Doc;
    for (const [index] of (empty.bufferViews ?? []).entries()) sum += 1000 + index;
    const typed: { list?: number[] } = { list: [5, 6] };
    for (const [index, value] of (typed.list ?? []).entries()) sum += index * value;
    if (sum !== 125) throw new Error("entries " + sum);
`,
);

check(
    "number-array-asserted-as-tuple",
    `
    type Vec3 = [number, number, number];
    const BASE = [200, 100, 50] as const;
    function scale(factor: number): [number, number, number] | null {
        if (factor <= 0) return null;
        return BASE.map((channel) => channel * factor) as [number, number, number];
    }
    function parse(raw: string, fallback: Vec3): Vec3 {
        const parts = raw.split(",").map(Number);
        return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as Vec3) : fallback;
    }
    const scaled = scale(0.5);
    if (scaled === null || scaled[0] !== 100 || scaled[2] !== 25 || scale(0) !== null) throw new Error("mapped tuple");
    const parsed = parse("1,2,3", [0, 0, 0]);
    if (parsed[2] !== 3 || parse("1,2", [7, 8, 9])[0] !== 7) throw new Error("asserted tuple");
    const parts = [4, 5, 6];
    const view = parts as unknown as Vec3;
    view[1] = 50;
    if (parts[1] !== 50) throw new Error("asserted tuple keeps identity");
`,
);

check(
    "dictionary-entries-and-dynamic-record-keys",
    `
    const keys = ["a", "bb"];
    const dict: Record<string, number> = {};
    for (const k of keys) dict[k] = k.length * 10;
    let sum = 0;
    for (const [key, value] of Object.entries(dict)) sum += key.length + value;
    function bones(captures: Readonly<Record<number, Float32Array>> | undefined): string {
        if (!captures) return "none";
        const out: string[] = [];
        for (const [bone, values] of Object.entries(captures)) out.push(bone + ":" + values.length);
        return out.join(",");
    }
    const captured: Record<number, Float32Array> = {};
    captured[2] = new Float32Array(3);
    captured[0] = new Float32Array(1);
    if (sum !== 33 || bones(captured) !== "0:1,2:3" || bones(undefined) !== "none") throw new Error("dictionary entries " + sum + bones(captured));
    type Slot = "chrome" | "hub" | "toast";
    const SLOTS: readonly Slot[] = ["chrome", "hub", "toast"];
    function stack(base: number, gap: number): Record<Slot, number> {
        const bottoms = {} as Record<Slot, number>;
        let cursor = base;
        for (const slot of SLOTS) {
            bottoms[slot] = cursor;
            cursor += gap;
        }
        return bottoms;
    }
    const stacked = stack(10, 4);
    if (stacked.chrome !== 10 || stacked.toast !== 18 || Object.keys(stacked).join(",") !== "chrome,hub,toast") throw new Error("dynamic record keys");
`,
);

check(
    "document-entries",
    `
    function names(value: unknown): string {
        if (!value || typeof value !== "object" || Array.isArray(value)) return "none";
        const out: string[] = [];
        for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
            const clip = raw as { from?: number } | null;
            out.push(name + "=" + String(clip?.from));
        }
        return out.join(",");
    }
    const doc = JSON.parse('{"walk":{"from":2},"7":{"from":1},"idle":null}') as unknown;
    if (names(doc) !== "7=1,walk=2,idle=undefined" || names(JSON.parse("[1]")) !== "none") throw new Error(names(doc));
`,
);

check(
    "number-predicates-as-callbacks",
    `
    interface Pose { x: number; y: number; z: number; yaw: number }
    function admitted(origin: Readonly<Pose>): boolean {
        return [origin.x, origin.y, origin.z, origin.yaw].every(Number.isFinite);
    }
    const values = [1, 2.5, Number.NaN, 4];
    const isFinite = Number.isInteger;
    if (!admitted({ x: 1, y: 2, z: 3, yaw: 0 }) || admitted({ x: 1, y: Number.POSITIVE_INFINITY, z: 3, yaw: 0 }))
        throw new Error("every");
    if (values.filter(Number.isFinite).length !== 3 || !values.some(Number.isNaN) || values.filter(isFinite).length !== 2)
        throw new Error("predicates");
`,
);

check(
    "array-spread-of-wider-records",
    `
    type Spec = { id: string; rgb: [number, number, number] };
    type Swatch = Spec & { swatch: string };
    function palette(): { id: string; labelKey: string; rgb: [number, number, number]; swatch: string }[] {
        return [{ id: "a", labelKey: "tint.a", rgb: [1, 2, 3], swatch: "#a" }];
    }
    const base = palette();
    const extra: Spec = { id: "b", rgb: [4, 5, 6] };
    const all: Swatch[] = [...base, { ...extra, swatch: "#b" }];
    if (all.length !== 2 || all[0]!.swatch !== "#a" || all[0]!.rgb[2] !== 3 || all[1]!.id !== "b") throw new Error("spread records");
    base[0]!.rgb[0] = 9;
    if (all[0]!.rgb[0] !== 9) throw new Error("nested arrays stay shared");
`,
);

check(
    "array-search-from-index-and-last-callbacks",
    `
    const values = [1, 2, 1, Number.NaN, 2];
    if (values.indexOf(1, 1) !== 2 || values.indexOf(2, -1) !== 4 || values.indexOf(1, 9) !== -1 || values.indexOf(1, Number.NaN) !== 0)
        throw new Error("indexOf fromIndex");
    if (!values.includes(Number.NaN, -2) || values.includes(Number.NaN, 4) || !values.includes(1, -5) || values.includes(1, 3))
        throw new Error("includes fromIndex");
    const names = ["a", "b", "a"];
    let from = 0;
    function start(): number { from++; return 1; }
    if (names.indexOf("a", start()) !== 2 || from !== 1 || names.includes("b", 2)) throw new Error("string fromIndex");
    const visited: number[] = [];
    const last = values.findLast((value, index) => { visited.push(index); return value === 1; });
    if (last !== 1 || visited.join(",") !== "4,3,2") throw new Error("findLast order");
    if (values.findLastIndex((value) => value === 2) !== 4 || values.findLastIndex((value) => value > 5) !== -1)
        throw new Error("findLastIndex");
    if (values.findLast((value) => value > 5) !== undefined) throw new Error("findLast miss");
    function lastEven(input: readonly number[]): number | undefined { return input.findLast((value) => value % 2 === 0); }
    function lastOddIndex(input: number[]): number { return input.findLastIndex((value) => value % 2 === 1); }
    const stored: Array<typeof lastEven> = [lastEven];
    if (stored[0]!([2, 3, 4, 5]) !== 4 || lastOddIndex([1, 2, 3, 4]) !== 2 || stored[0]!([1]) !== undefined)
        throw new Error("findLast through parameters");
    const lanes = new Float32Array([0.5, 1.5, 2.5]);
    if (lanes.findLast((value) => value < 2) !== 1.5 || lanes.findLastIndex((value) => value > 9) !== -1)
        throw new Error("typed findLast");
    const records = [{ id: 1, on: true }, { id: 2, on: false }, { id: 3, on: true }];
    if (records.findLast((record) => record.on)?.id !== 3) throw new Error("record findLast");
`,
);

check(
    "array-copying-methods",
    `
    const source = [3, 1, 2];
    const ascending = source.toSorted((a, b) => a - b);
    const lexical = [10, 9, 1].toSorted();
    if (ascending.join() !== "1,2,3" || source.join() !== "3,1,2" || lexical.join() !== "1,10,9") throw new Error("toSorted");
    const reversed = source.toReversed();
    reversed.push(7);
    if (reversed.join() !== "2,1,3,7" || source.length !== 3) throw new Error("toReversed");
    const replaced = source.with(-1, 9);
    if (replaced.join() !== "3,1,9" || source[2] !== 2 || source.with(0, 5)[0] !== 5) throw new Error("with");
    let name = "";
    try { source.with(3, 0); } catch (error) { name = (error as Error).name; }
    if (name !== "RangeError") throw new Error("with range");
    function sortedNames(input: readonly string[]): string[] { return input.toSorted(); }
    function flipped(input: readonly number[]): number[] { return input.toReversed(); }
    const words = ["pear", "apple"];
    if (sortedNames(words).join() !== "apple,pear" || words[0] !== "pear" || flipped([1, 2]).join() !== "2,1")
        throw new Error("readonly copies");
    const flags = [true, false];
    if (flags.with(1, true).join() !== "true,true" || flags[1] !== false) throw new Error("boolean with");
`,
);

check(
    "array-reduce-without-initial-value-and-right",
    `
    const values = [4, 1, 3];
    if (values.reduce((sum, value) => sum + value) !== 8) throw new Error("reduce without initial value");
    if (values.reduce((best, value) => (value < best ? value : best)) !== 1) throw new Error("reduce pick");
    const letters = ["a", "b", "c"];
    if (letters.reduceRight((text, letter) => text + letter, "") !== "cba") throw new Error("reduceRight");
    if (letters.reduceRight((text, letter) => text + letter) !== "cba") throw new Error("reduceRight without initial value");
    const indexes: number[] = [];
    letters.reduceRight((count, _letter, index) => { indexes.push(index); return count + 1; }, 0);
    if (indexes.join() !== "2,1,0") throw new Error("reduceRight order");
    if ([7].reduce((sum, value) => sum + value) !== 7) throw new Error("single element");
    let name = "";
    const empty: number[] = [];
    try { empty.reduce((sum, value) => sum + value); } catch (error) { name = (error as Error).name; }
    if (name !== "TypeError") throw new Error("empty reduce");
    name = "";
    try { empty.reduceRight((sum, value) => sum + value); } catch (error) { name = (error as Error).name; }
    if (name !== "TypeError") throw new Error("empty reduceRight");
    function smallest(input: readonly number[]): number { return input.reduce((best, value) => Math.min(best, value)); }
    const stored: Array<typeof smallest> = [smallest];
    if (stored[0]!([5, 2, 8]) !== 2) throw new Error("readonly reduce");
    const lanes = new Float32Array([1, 2, 4]);
    if (lanes.reduceRight((text, value) => text + value, "") !== "421") throw new Error("typed reduceRight");
`,
);

check(
    "numeric-tuple-observing-methods",
    `
    type Vec3 = [number, number, number];
    function summary(v: Vec3): string {
        const doubled = v.map((value) => value * 2);
        return \`\${v.join("/")};\${v.indexOf(2)};\${v.lastIndexOf(2)};\${v.includes(3, 2)};\${v.at(-1)};\` +
            \`\${doubled.join()};\${v.filter((value) => value > 1).length};\${v.concat([9]).length};\` +
            \`\${v.toSorted((a, b) => b - a).join()};\${v.reduce((sum, value) => sum + value)};\${v.findLast((value) => value < 3)}\`;
    }
    const stored: Array<typeof summary> = [summary];
    if (stored[0]!([1, 2, 3]) !== "1/2/3;1;1;true;3;2,4,6;2;4;3,2,1;6;2") throw new Error(stored[0]!([1, 2, 3]));
    function reset(v: Vec3): Vec3 { v.fill(0, 1); return v; }
    const lanes: Vec3 = [4, 5, 6];
    if (reset(lanes) !== lanes || lanes.join() !== "4,0,0") throw new Error("tuple fill");
`,
);

check(
    "numeric-tuples-as-arrays",
    `
    type Vec3 = [number, number, number];
    function writeInto(x: number, out: number[]): void { out[0] = x; out[2] = x * 2; }
    function frameInto(x: number, outU: number[], outV: number[]): void { writeInto(x, outU); writeInto(x + 1, outV); }
    function dot(a: readonly number[], b: readonly number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
    function sum(values: ArrayLike<number>): number { let total = 0; for (let i = 0; i < values.length; i++) total += values[i]!; return total; }
    function frame(x: number, brick: { v: Vec3 }): Vec3 { const u: Vec3 = [0, 0, 0]; frameInto(x, u, brick.v as number[]); return u; }
    const stored: Array<typeof frame> = [frame];
    const brick = { v: [0, 0, 0] as Vec3 };
    const u = stored[0]!(3, brick);
    if (u.join() !== "3,0,6" || brick.v.join() !== "4,0,8") throw new Error("tuple written through an array parameter");
    const direct: Vec3 = [1, 1, 1];
    frameInto(5, direct, brick.v);
    if (direct.join() !== "5,1,10" || brick.v.join() !== "6,0,12") throw new Error("direct tuple arguments");
    if (dot(u, brick.v) !== 90 || sum(u) !== 9) throw new Error("tuple read through array views");
    function first2(out: number[]): number { out[0] = 1; return out[0] + out.length; }
    const counted: Array<typeof first2> = [first2];
    if (counted[0]!([5, 6]) !== 3 || first2([7]) !== 2) throw new Error("array literal argument");
    function normal(x: number, out: Vec3 = [0, 0, 0]): Vec3 { out[0] = x; out[1] = x + 1; return out; }
    const scratch: Vec3 = [9, 9, 9];
    const first = normal(1), second = normal(2), shared = normal(5, scratch);
    if (first === second || first.join() !== "1,2,0" || second[0] !== 2 || shared !== scratch || scratch.join() !== "5,6,9")
        throw new Error("defaulted tuple out-parameter");
    const fog: [number, number, number, number] = [1, 2, 3, 4];
    fog.fill(0, 2);
    if (fog.join() !== "1,2,0,0") throw new Error("tuple fill range");
    fog.fill(7);
    fog[3] = 1;
    fog.copyWithin(0, 3);
    if (fog.join() !== "1,7,7,1") throw new Error("tuple fill and copyWithin");
    const albedo: Vec3 = [0.5, 0.25, 1];
    const uniform = { name: "albedo", defaultValue: [...albedo] };
    albedo[0] = 2;
    if (uniform.defaultValue[0] !== 0.5 || uniform.defaultValue.length !== 3) throw new Error("spread copies tuple lanes");
    function corner(x: number, z: number): [number, number] { return [x, z]; }
    const outline: number[] = [...corner(1, 2), ...corner(3, 4), 5];
    if (outline.join() !== "1,2,3,4,5") throw new Error("tuple spreads into an array");
    function withAlpha(rgb: Vec3): [number, number, number, number] { return [...rgb, 1]; }
    if (withAlpha(albedo).join() !== "2,0.25,1,1") throw new Error("tuple spread into a wider tuple");
    function waterY(x: number, z: number): number { return x * 10 + z; }
    function sampler(ax: number, dx: number, at3: (x: number, z: number) => number): (t: number) => number {
        const at = (t: number): [number, number] => [ax + dx * t, ax - dx * t];
        return (t: number): number => at3(...at(t));
    }
    if (sampler(1, 2, waterY)(1) !== 29) throw new Error("tuple spread into a function value");
    interface Batch { shift(seq: number, dx: number, dz: number): number }
    const batch: Batch = { shift: (seq, dx, dz) => seq + dx * 10 + dz * 100 };
    const delta: readonly [number, number] = [2, 3];
    if (batch.shift(1, ...delta) !== 321) throw new Error("tuple spread into a method");
`,
);

check(
    "array-sequences-length-updates-and-boolean-callbacks",
    `
    const lanes: [number, number, number] = [7, 8, 9];
    const copied = Array.from(lanes);
    copied.push(1);
    if (copied.length !== 4 || lanes.length !== 3 || Array.from([1, 2]).length !== 2) throw new Error("Array.from tuple");
    const matrices = new Float32Array([1, 2, 3, 4, 5, 6]);
    const row = Array.from(matrices.subarray(3, 6));
    if (row.join() !== "4,5,6" || new Set(Array.from(new Int32Array([4, 5, 4]))).size !== 2) throw new Error("Array.from typed array");
    const text = ["a😀b"][0]!;
    if ([...text].length !== 3 || Array.from(text)[1] !== "😀" || [...text, "c"].join("") !== "a😀bc") throw new Error("string code points");
    const tones: Array<[number, number, number]> = [[1, 2, 3]];
    function tone(index: number): [number, number, number] { return tones[index] ?? ([0.5, 0.5, 0.5] as [number, number, number]); }
    if (tone(0)[0] !== 1 || tone(4)[2] !== 0.5) throw new Error("missed search tuple fallback");
    const run = [1, 2, 3, 4, 5];
    run.length -= 2;
    if (run.join() !== "1,2,3") throw new Error("length subtraction");
    let reads = 0;
    function shrink(): number { reads++; run.pop(); return 1; }
    run.length -= shrink();
    if (run.length !== 2 || reads !== 1) throw new Error("length read before the right side");
    const worlds = new Map<string, number>([["b", 2]]);
    const found = ["a", "b"].map((key) => worlds.get(key)).find(Boolean);
    if (found !== 2) throw new Error("find(Boolean) over optional elements");
    function anyMasked(mask: Array<boolean | undefined> | undefined): boolean { return mask?.some(Boolean) === true; }
    if (!anyMasked([undefined, true]) || anyMasked([undefined, false]) || anyMasked(undefined)) throw new Error("some(Boolean)");
`,
);

check(
    "numeric-tuple-bindings-grown-through-array-parameters-take-array-storage",
    `
    function push(out: number[]): void { out.push(1); }
    function beyond(out: number[]): void { (out[3]) = 1; }
    function truncate(out: number[]): void { out.length = 1; }
    function pop(values: number[]): void { values.pop(); }
    function nested(out: number[]): void { out[0] = 1; pop(out); }
    function viaPush(): number { const t: [number, number, number] = [0, 0, 0]; push(t); return t.length * 10 + t[0]; }
    function viaBeyond(): number { const t: [number, number, number] = [0, 0, 0]; beyond(t); return t.length * 10 + t[0]; }
    function viaTruncate(): number { const t: [number, number, number] = [0, 0, 0]; truncate(t); return t.length * 10 + t[0]; }
    function viaNested(): number { const t: [number, number, number] = [0, 0, 0]; nested(t); return t.length * 10 + t[0]; }
    const frames: Array<() => number> = [viaPush, viaBeyond, viaTruncate, viaNested];
    const lengths = frames.map((frame) => frame());
    if (lengths.join() !== "40,40,10,21") throw new Error(lengths.join());
`,
);

check(
    "record-tuple-fields-grown-through-array-parameters",
    `
    function push(out: number[]): void { out.push(1); }
    interface Holder { lanes: [number, number, number] }
    function make(): Holder { return { lanes: [0, 0, 0] }; }
    const holder = make();
    push(holder.lanes);
    if (holder.lanes.length !== 4 || holder.lanes[3] !== 1) throw new Error("grown field");
`,
);

test("numeric tuple parameters refuse array parameters that may grow them", () => {
    for (const source of [
        `function frame(t: [number, number, number]): void { push(t); }
        const frames: Array<typeof frame> = [frame];
        const lanes: [number, number, number] = [0, 0, 0];
        frames[0]!(lanes);`,
    ])
        assert.throws(
            () =>
                compileSource(
                    `function push(out: number[]): void { out.push(1); }
                    ${source}`,
                ),
            /fixed-length tuple stored as a number array could grow through that array/,
        );
});

check(
    "parsed-document-array-destructuring",
    `
    interface RawNode { translation?: number[]; rotation?: number[] }
    function sum(node: RawNode): number {
        const [tx, ty, tz] = node.translation ?? [0, 0, 0];
        const [qx, , , qw] = node.rotation ?? [0, 0, 0, 1];
        return tx! + ty! + tz! + qx! + qw!;
    }
    const doc = JSON.parse('{"nodes":[{"translation":[1,2,3]},{"rotation":[0.5,0,0,2]}]}') as { nodes: RawNode[] };
    if (sum(doc.nodes[0]!) !== 7 || sum(doc.nodes[1]!) !== 2.5) throw new Error("document lanes");
    const [first, second] = JSON.parse('"ab"') as unknown as string[];
    if (first !== "a" || second !== "b") throw new Error("document string");
    const sources = ['"\\ud83d\\ude00\\u00e9xyz"'];
    const [emoji, accent, , fourth] = JSON.parse(sources[0]!) as unknown as string[];
    if (emoji !== "\\ud83d\\ude00" || accent !== "\\u00e9" || fourth !== "y") throw new Error("document code points");
    const [one, missing] = JSON.parse("[1]") as number[];
    if (one !== 1 || missing !== undefined) throw new Error("document lane past the end");
    let name = "";
    try { const [lane] = JSON.parse("{}") as number[]; if (lane === 0) name = "zero"; } catch (error) { name = (error as Error).name; }
    if (name !== "TypeError") throw new Error("document not iterable");
    function parse(value: unknown): [number, number, number] | null {
        if (!Array.isArray(value) || value.length !== 3) return null;
        const ok = (v: unknown): v is number => typeof v === "number" && v >= 0;
        const [r, g, b] = value as unknown[];
        if (!ok(r) || !ok(g) || !ok(b)) return null;
        return [r, g, b];
    }
    const parsed = parse(JSON.parse("[1,2,3]"));
    if (!parsed || parsed[2] !== 3 || parse(JSON.parse('[1,"2",3]')) !== null) throw new Error("unknown lanes");
`,
);

check(
    "numeric-tuples-in-array-sinks",
    `
    interface Decl { name: string; defaultValue?: number | number[] }
    const cloud: [number, number, number, number] = [1, 2, 3, 4];
    const decls: Decl[] = [{ name: "cloud", defaultValue: cloud }, { name: "scale", defaultValue: 2 }];
    cloud[0] = 9;
    const value = decls[0]!.defaultValue;
    if (!Array.isArray(value) || value[0] !== 9 || value.length !== 4) throw new Error("tuple keeps identity in a union field");
    const lanes: [number, number, number] = [1, 2, 3];
    const record = { copy: [...lanes], list: [...[4, 5], ...lanes] };
    lanes[0] = 7;
    if (record.copy[0] !== 1 || record.list.join() !== "4,5,1,2,3") throw new Error("spreads copy where the record is built");
`,
);

check(
    "absent-optional-properties-of-narrower-records",
    `
    interface FieldSource {
        readonly tex: Uint8Array;
        readonly res: number;
        readonly dirtyRow0?: number;
        readonly dirtyRow1?: number;
    }
    interface ShapeField {
        clear(): void;
        readonly tex: Uint8Array;
        readonly res: number;
        readonly version: number;
    }
    interface DirtyField {
        readonly tex: Uint8Array;
        readonly res: number;
        dirtyRow0: number;
        dirtyRow1: number;
    }
    function rowsToSend(field: FieldSource): number {
        const row0 = field.dirtyRow0;
        const row1 = field.dirtyRow1;
        if (row0 === undefined || row1 === undefined) return field.res;
        return row1 < row0 ? 0 : row1 - row0 + 1;
    }
    function shapeField(res: number): ShapeField {
        const tex = new Uint8Array(res * res * 4);
        let version = 0;
        return { clear() { tex.fill(0); version++; }, tex, res, get version() { return version; } };
    }
    const sendShape = (field: ShapeField): number => rowsToSend(field);
    const sendDirty = (field: DirtyField): number => rowsToSend(field);
    const senders: Array<(field: ShapeField) => number> = [sendShape];
    const shape = shapeField(8);
    const dirty: DirtyField = { tex: new Uint8Array(4), res: 4, dirtyRow0: 1, dirtyRow1: 2 };
    if (senders[0]!(shape) !== 8 || sendDirty(dirty) !== 2) throw new Error("absent rows read undefined");
    dirty.dirtyRow1 = 0;
    if (sendDirty(dirty) !== 0) throw new Error("present rows stay live");

    interface Encoding { on: string; off: string }
    interface ToggleOptions { key: string; fallback: boolean; stored: string | null; encoding?: Encoding }
    const ON_OFF: Encoding = { on: "on", off: "off" };
    function toggle(options: ToggleOptions): boolean {
        const encoding = options.encoding ?? ON_OFF;
        return options.stored === encoding.on ? true : options.stored === encoding.off ? false : options.fallback;
    }
    function advice(options: { stored: string | null }): boolean {
        return toggle({ ...options, key: "advice", fallback: true });
    }
    const toggles: Array<typeof advice> = [advice];
    if (toggles[0]!({ stored: "off" }) || !toggles[0]!({ stored: null })) throw new Error("absent encoding");

    interface FamilyMetadata { family?: unknown; legacy?: unknown }
    function familyOf(metadata: Readonly<FamilyMetadata>): string {
        if (metadata.family === undefined) return metadata.legacy ? "plaster" : "bricks";
        return typeof metadata.family === "string" ? metadata.family : "other";
    }
    interface Manifest { name: string; legacy: boolean }
    const describe = (manifest: Manifest): string => manifest.name + ":" + familyOf(manifest);
    const manifests: Manifest[] = [{ name: "a", legacy: true }, { name: "b", legacy: false }];
    if (manifests.map(describe).join(",") !== "a:plaster,b:bricks") throw new Error("absent unknown property");

    function homeId(entity: { kind: string }): number {
        const seq = entity.kind === "house" && "seq" in entity && typeof entity.seq === "number" ? entity.seq : undefined;
        return seq ?? -1;
    }
    const homes: Array<(kind: string) => number> = [(kind) => homeId({ kind })];
    if (homes[0]!("house") !== -1) throw new Error("absent key after in");

    interface Moved { x: number; tag: string }
    function nudge(target: { x: number; step?: number }): void { target.x += target.step ?? 1; }
    const moved: Moved[] = [{ x: 1, tag: "a" }];
    const nudges: Array<(item: Moved) => void> = [(item) => nudge(item)];
    nudges[0]!(moved[0]!);
    if (moved[0]!.x !== 2) throw new Error("the record keeps its identity");

    interface Labelled { a: number; extra?: number; label?: string }
    function twice(value: number | undefined): number { return value === undefined ? -1 : value * 2; }
    function uses(source: Labelled): string {
        let held: number | undefined = source.extra;
        const first = twice(source.extra);
        held = held ?? 4;
        const values = [source.extra, source.a];
        return first + "," + held + "," + typeof source.extra + ",x" + source.label + "-" + (source.label ?? "none") + "," + (values[0] === undefined);
    }
    const reads: Array<(item: { a: number }) => string> = [(item) => uses(item)];
    const used = reads[0]!({ a: 1 });
    if (used !== "-1,4,undefined,xundefined-none,true") throw new Error(used);
    interface Signed { x: number; tint?: [number, number, number]; onDone?: () => void }
    function signature(p: Signed): string {
        p.onDone?.();
        return p.x.toFixed(1) + "," + (p.tint?.join(",") ?? "") + "," + (p.tint?.length ?? -1);
    }
    const signatures: Array<(item: { x: number }) => string> = [(item) => signature(item)];
    if (signatures[0]!({ x: 1 }) !== "1.0,,-1") throw new Error("absent optional chains");

    interface Appearance { seed?: number; pattern?: number; foot?: number }
    function sanitize<T extends Appearance>(record: T): T {
        const clean = { ...record };
        if (typeof clean.seed !== "number") delete clean.seed;
        if (clean.foot === undefined) delete clean.foot;
        return clean;
    }
    interface Kept { pattern: number; foot?: number }
    const sanitizers: Array<(item: Kept) => string> = [(item) => JSON.stringify(sanitize(item))];
    if (sanitizers[0]!({ pattern: 2, foot: 3 }) !== '{"pattern":2,"foot":3}' || sanitizers[0]!({ pattern: 2 }) !== '{"pattern":2}')
        throw new Error("deleting absent and present properties");

    interface Spot { x: number; z: number }
    interface Blocker { id?: number; save: Spot }
    function free(blockers: () => readonly Blocker[], vacating?: ReadonlySet<number>): number {
        let total = 0;
        for (const { id, save } of blockers()) {
            if (id !== undefined && vacating?.has(id)) continue;
            total += save.x;
        }
        return total;
    }
    function blockerId({ id, save }: Blocker): number { return id === undefined ? -save.x : id; }
    interface Area { props(): readonly { save: Spot }[] }
    function wire(area: Area): string {
        let ids = 0;
        for (const prop of area.props()) ids += blockerId(prop);
        return free(area.props, new Set([1])) + "," + ids;
    }
    const placed = [{ save: { x: 2, z: 0 } }, { save: { x: 3, z: 1 } }];
    if (wire({ props: () => placed }) !== "5,-5") throw new Error("destructured absent properties");
`,
);

test("absent property reads refuse properties a converted record may carry", () => {
    const declarations = `
    interface Narrow { a: number }
    interface View { a: number; b?: number }
    function readB(v: View): number { return v.b ?? -1; }
    function make(a: number): { a: number; b: number } { return { a, b: a * 2 }; }
    const list: Narrow[] = [{ a: 3 }];
    `;
    for (const body of [
        "list.push(make(1)); const read = readB(list[0]!);",
        "const read = readB(list[0]!); list.push(make(1));",
        "list.push(make(1)); const mids: { a: number; z?: string }[] = []; for (const item of list) mids.push(item); const read = readB(mids[0]!);",
        // Destructuring reads the property as a property access does.
        "list.push(make(1)); function bOf({ b }: View): number { return b ?? -1; } const read = bOf(list[0]!);",
        "list.push(make(1)); const views: readonly View[] = list; let read = 0; for (const { b } of views) read += b ?? -1;",
    ])
        assert.throws(
            () => compileSource(declarations + body),
            /Property 'b' is not stored by '\w+' records, but a record converted into that storage may carry it/,
        );
    assert.throws(
        () =>
            compileSource(`
            interface Source { a: number; b?: number }
            interface Shape { a: number }
            function make(): Shape { return { a: 1 }; }
            const read = (make() as Source).b;
            `),
        /has no field 'b'/,
    );
    // An object rest copies what a converted record carried too.
    assert.throws(
        () =>
            compileSource(`
            interface Source { a: number; c: number }
            interface View { a: number; b?: number }
            function readB(v: View): number { return v.b ?? -1; }
            function make(a: number): { a: number; c: number; b: number } { return { a, c: 0, b: a * 2 }; }
            const list: Source[] = [{ a: 3, c: 1 }];
            list.push(make(1));
            const { c, ...rest } = list[1]!;
            const read = readB(rest) + c;
            `),
        /Property 'b' is not stored by 'rest' records, but a record converted into that storage may carry it/,
    );
});

check(
    "union-tags-admitting-several-literals",
    `
    type Job = "farmer" | "potter" | "priest";
    type Requirement =
        | { id: string; kind: "default" | "field" | "pond"; satisfied: boolean }
        | { id: string; kind: "staffedAnyOf"; jobs: readonly Job[]; satisfied: boolean }
        | { id: string; kind: "mana"; satisfied: boolean; current: number; goal: number };
    function label(requirement: Requirement): string {
        if (requirement.kind === "staffedAnyOf") return "jobs:" + requirement.jobs.join("|");
        if (requirement.kind === "mana") return "mana:" + requirement.current + "/" + requirement.goal;
        return requirement.kind + (requirement.satisfied ? "+" : "-");
    }
    const requirements: Requirement[] = [
        { id: "a", kind: "field", satisfied: true },
        { id: "b", kind: "staffedAnyOf", jobs: ["farmer", "potter"], satisfied: false },
        { id: "c", kind: "mana", satisfied: false, current: 3, goal: 40 },
        { id: "d", kind: "pond", satisfied: false },
    ];
    const labels: Array<typeof label> = [label];
    const text = requirements.map(labels[0]!).join(",");
    if (text !== "field+,jobs:farmer|potter,mana:3/40,pond-") throw new Error(text);
    const pond = requirements[3]!;
    if (pond.kind === "staffedAnyOf" || pond.kind === "mana" || pond.kind !== "pond") throw new Error("tag set member");
    const alias = requirements[1]!;
    if (alias.kind === "staffedAnyOf") alias.satisfied = true;
    if (!requirements[1]!.satisfied) throw new Error("arm identity");
    function plain(kind: "default" | "field" | "pond", id: string): Requirement {
        return { id, kind, satisfied: kind !== "pond" };
    }
    const kinds: Array<"default" | "field" | "pond"> = ["pond", "default"];
    const made = kinds.map((kind, index) => plain(kind, "r" + index));
    made.push({ id: "m", kind: "mana", current: 2, goal: 4, satisfied: true });
    if (made.map(labels[0]!).join(",") !== "pond-,default+,mana:2/4") throw new Error("run-time tags");
`,
);

test("union arms whose tag literals overlap keep their common fields", () => {
    assert.throws(
        () =>
            compileSource(
                'type Overlap = { kind: "a" | "b"; x: number } | { kind: "b" | "c"; y: string }; const items: Overlap[] = [{ kind: "a", x: 1 }];',
            ),
        /Struct literal has unknown field 'x'/,
    );
});

check(
    "union-arm-own-keys-follow-tags",
    `
    type Requirement =
        | { id: string; kind: "field" | "pond"; satisfied: boolean }
        | { id: string; kind: "staffedAnyOf"; satisfied: boolean; jobs: readonly string[] }
        | { id: string; kind: "mana"; satisfied: boolean; current: number; extra?: number };
    const requirements: Requirement[] = [
        { id: "a", kind: "field", satisfied: true },
        { id: "b", kind: "staffedAnyOf", satisfied: false, jobs: ["farmer"] },
        { id: "c", kind: "mana", satisfied: false, current: 3 },
        { id: "d", kind: "mana", satisfied: false, current: 3, extra: 1 },
    ];
    const has = requirements.map((r) => ("jobs" in r ? "j" : "-") + ("current" in r ? "c" : "-") + ("extra" in r ? "e" : "-")).join(",");
    if (has !== "---,j--,-c-,-ce") throw new Error(has);
    const keys = requirements.map((r) => Object.keys(r).join("+")).join(",");
    if (keys !== "id+kind+satisfied,id+kind+satisfied+jobs,id+kind+satisfied+current,id+kind+satisfied+current+extra") throw new Error(keys);
    const json = requirements.map((r) => JSON.stringify(r)).join("");
    if (json !== '{"id":"a","kind":"field","satisfied":true}{"id":"b","kind":"staffedAnyOf","satisfied":false,"jobs":["farmer"]}{"id":"c","kind":"mana","satisfied":false,"current":3}{"id":"d","kind":"mana","satisfied":false,"current":3,"extra":1}') throw new Error(json);
    interface Circle { kind: "circle"; x: number; radius: number; grow?: number }
    interface Rect { kind: "rect"; cx: number; halfW: number; grow?: number }
    type Boundary = Circle | Rect;
    const reach = (boundary: Boundary): number => (boundary.grow ?? 0) + (boundary.kind === "circle" ? boundary.radius + boundary.x : boundary.halfW + boundary.cx);
    const pair = (a: { boundary: Boundary }, b: { boundary: Boundary }): number => reach({ ...a.boundary, grow: 0 }) + reach({ ...b.boundary, grow: 1 });
    const pairs: Array<typeof pair> = [pair];
    const hosts: Array<{ boundary: Boundary }> = [
        { boundary: { kind: "circle", x: 1, radius: 2, grow: 5 } },
        { boundary: { kind: "rect", cx: 1, halfW: 3 } },
    ];
    if (pairs[0]!(hosts[0]!, hosts[1]!) !== 8 || hosts[0]!.boundary.grow !== 5) throw new Error("spread arm override");
`,
);

check(
    "spread-struct-literals-omit-absent-optional-fields",
    `
    interface Arch { span: number }
    interface WallOptions { width: number; seed: number; arch?: Arch; groundY?: () => number; dims?: number[] }
    function compose(o: WallOptions): string {
        return o.width + ":" + (o.arch ? o.arch.span : "none") + ":" + (o.groundY ? o.groundY() : -1) + ":" + (o.dims ? o.dims.length : 0);
    }
    function crown(width: number, dims: number[] | undefined): string {
        const options: WallOptions = { width, seed: 3, ...(dims && dims.length > 0 ? { dims } : {}) };
        return compose(options);
    }
    function arched(width: number, span: number): string {
        const options: WallOptions = { ...{ width, seed: 1 }, arch: { span }, groundY: () => width * 2 };
        return compose(options);
    }
    const crowns: Array<typeof crown> = [crown];
    const arches: Array<typeof arched> = [arched];
    if (crowns[0]!(2, [1, 2]) !== "2:none:-1:2" || crowns[0]!(4, undefined) !== "4:none:-1:0") throw new Error("absent optional fields");
    if (arches[0]!(3, 5) !== "3:5:6:0") throw new Error("present optional fields");
`,
);

check(
    "type-guard-filters-narrow-string-tags",
    `
    type Failure = "a" | "b" | "c";
    type Candidate = "a" | "b";
    const isCandidate = (f: Failure): f is Candidate => f !== "c";
    interface Facts { id: number; failures: Candidate[] }
    function facts(id: number, failures: Failure[]): Facts {
        return { id, failures: failures.filter(isCandidate) };
    }
    const roots: Array<typeof facts> = [facts];
    const made = roots[0]!(1, ["a", "c", "b"]);
    if (made.failures.join(",") !== "a,b") throw new Error("filtered tags");
    const source: Failure[] = ["c", "a"];
    const kept: Candidate[] = source.filter((f): f is Candidate => f === "a");
    source[1] = "b";
    if (kept.length !== 1 || kept[0] !== "a") throw new Error("a fresh array");
    interface Perk { jobs: readonly Failure[] }
    const WIDE: readonly Failure[] = Object.freeze(source.filter(isCandidate));
    const perk: Perk = { jobs: WIDE };
    const widen: Array<(all: Failure[]) => Failure[]> = [(all) => all.filter(isCandidate)];
    if (perk.jobs.join() !== "b" || widen[0]!(["c", "a"]).join() !== "a") throw new Error("a wider destination keeps the source tags");
`,
);

check(
    "type-guard-filters-narrow-into-contextual-destinations",
    `
    type Failure = "a" | "b" | "c";
    type Candidate = "a" | "b";
    const isCandidate = (f: Failure): f is Candidate => f !== "c";
    function count(candidates: Candidate[]): number { return candidates.filter((c) => c === "a").length; }
    const source: Failure[] = ["c", "a", "b"];
    let kept: Candidate[] = [];
    kept = source.filter(isCandidate);
    const pick = (): Candidate[] => source.filter(isCandidate);
    const nested: Candidate[][] = [source.filter(isCandidate)];
    const frozen: readonly Failure[] = Object.freeze(source.filter(isCandidate));
    source[0] = "a";
    if (kept.join() !== "a,b" || count(source.filter(isCandidate)) !== 2 || pick().join() !== "a,a,b") throw new Error("declared destinations");
    if (nested[0]!.join() !== "a,b" || frozen.join() !== "a,b") throw new Error("element and inferred destinations");
`,
);

check(
    "record-spreads-copy-methods-into-struct-literals",
    `
    interface Live { update(dt: number): void; active(): boolean; count: number }
    interface SwanLive extends Live { state(): string; height: number }
    function createLive(count: number): Live {
        let elapsed = 0;
        return { update(dt) { elapsed += dt; }, active: () => elapsed > 1, count };
    }
    function createSwan(count: number): SwanLive {
        const live = createLive(count);
        return { ...live, state: () => (live.active() ? "awake" : "asleep"), height: 3 };
    }
    const swans: Array<typeof createSwan> = [createSwan];
    const swan = swans[0]!(2);
    if (swan.active() || swan.state() !== "asleep") throw new Error("initial state");
    swan.update(2);
    if (!swan.active() || swan.state() !== "awake" || swan.count !== 2 || swan.height !== 3) throw new Error("copied methods share state");
`,
);

test("record spreads with accessors refuse in struct literals", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Clock { readonly now: number; tick(): void }
            function clock(): Clock { let t = 0; return { get now() { return t; }, tick() { t++; } }; }
            const make = (): Clock => ({ ...clock(), tick() {} });
            const clocks: Array<typeof make> = [make];
            clocks[0]!().tick();
            `),
        /A record with accessors spreads into a compile-time record, not a struct literal/,
    );
});

check(
    "literal-methods-read-their-home-object-through-this",
    `
    interface Mover {
        carryBegin(id: number): boolean;
        prepareBegin(id: number): (() => void) | null;
        carried(): number;
        self(): Mover;
    }
    function createMover(limit: number): Mover {
        const carried = new Set<number>();
        return {
            carryBegin(id) {
                const begin = this.prepareBegin(id);
                if (!begin) return false;
                begin();
                return true;
            },
            prepareBegin(id) {
                if (id > limit) return null;
                return () => { carried.add(id); };
            },
            carried() { return carried.size; },
            self() { return this; },
        };
    }
    interface Ledger { balance: number; grant(amount: number): void; morning(shares: number): number }
    function createLedger(): Ledger {
        return {
            balance: 0,
            grant(amount) { if (amount > 0) this.balance += amount; },
            morning: function (shares) { const amount = shares * 2; this.grant(amount); return this.balance; },
        };
    }
    const movers: Array<typeof createMover> = [createMover];
    const mover = movers[0]!(3);
    const other = movers[0]!(9);
    if (!mover.carryBegin(2) || mover.carryBegin(5) || mover.carried() !== 1) throw new Error("sibling through this");
    if (!other.carryBegin(5) || other.carried() !== 1 || mover.carried() !== 1) throw new Error("separate home objects");
    if (mover.self() !== mover || other.self() === mover) throw new Error("this identity");
    mover.prepareBegin = () => null;
    if (mover.carryBegin(1) || !other.carryBegin(1)) throw new Error("this reads the live field");
    const ledgers: Array<typeof createLedger> = [createLedger];
    const ledger = ledgers[0]!();
    if (ledger.morning(3) !== 6 || ledger.balance !== 6) throw new Error("void sibling and field through this");
    ledger.balance = 1;
    if (ledger.morning(1) !== 3) throw new Error("field written outside");
`,
);

test("literal methods reading this refuse reads of their function value", () => {
    const factory = `
        interface Mover { carryBegin(id: number): boolean; prepareBegin(id: number): boolean }
        function createMover(): Mover {
            return { carryBegin(id) { return this.prepareBegin(id); }, prepareBegin(id) { return id > 0; } };
        }
        const movers: Array<typeof createMover> = [createMover];
        const mover = movers[0]!();`;
    for (const use of [
        "const extracted = mover.carryBegin; const unused = extracted(1);",
        "const unused = mover.carryBegin.call(mover, 1);",
        "const { carryBegin } = mover; const unused = carryBegin(1);",
        "const copy: Mover = { ...mover }; const unused = copy.carryBegin(1);",
        // A wider type the object flows to reads the same function value.
        "interface View { carryBegin(id: number): boolean } const view: View = mover; const extracted = view.carryBegin; const unused = extracted(1);",
        "function take(source: { carryBegin(id: number): boolean }) { const { carryBegin } = source; return carryBegin(1); } const unused = take(mover);",
    ])
        assert.throws(
            () => compileSource(`${factory}\n${use}`),
            /Method 'carryBegin' reads `this`, and .*:\d+ reads its function value, which could call it with another receiver/,
        );
});

check(
    "literal-methods-reading-this-admit-reads-of-objects-that-cannot-hold-them",
    `
    interface Mover { carryBegin(id: number): boolean; prepareBegin(id: number): boolean; total: number }
    interface Other { carryBegin: (id: number) => boolean; prepareBegin: number }
    function createMover(): Mover {
        return { total: 0, carryBegin(id) { this.total += id; return this.prepareBegin(id); }, prepareBegin(id) { return id > 0; } };
    }
    const movers: Array<typeof createMover> = [createMover];
    const mover = movers[0]!();
    const other: Other = { carryBegin: (id) => id > 1, prepareBegin: 3 };
    const extracted = other.carryBegin;
    const { prepareBegin } = other;
    const copy = { ...other };
    const values = Object.values(other).length;
    if (!mover.carryBegin(2) || mover.carryBegin(-1) || mover.total !== 1) throw new Error("home object");
    if (extracted(1) || prepareBegin !== 3 || !copy.carryBegin(2) || values !== 2) throw new Error("unrelated reads");
`,
);

check(
    "literal-methods-reach-their-object-by-this-and-by-name",
    `
    interface Counter {
        value: number;
        next: Counter | null;
        bump(): number;
        twice(): number;
        owner(): Counter;
        self(): Counter;
        peek(): number;
        link(other: Counter): void;
    }
    function createCounter(start: number): Counter {
        const counter: Counter = {
            value: start,
            next: null,
            bump() { this.value++; return counter.value; },
            twice() { counter.bump(); return this.bump(); },
            owner() { return counter; },
            self() { return this; },
            peek: () => counter.value,
            link(other) { this.next = other; other.next = counter; },
        };
        return counter;
    }
    const counters: Array<typeof createCounter> = [createCounter];
    const a = counters[0]!(1);
    const b = counters[0]!(10);
    if (a.twice() !== 3 || b.bump() !== 11 || a.peek() !== 3) throw new Error("this and name read one object");
    if (a.owner() !== a || a.self() !== a || b.owner() !== b || a.owner() === b) throw new Error("object identity");
    const peek = a.peek;
    if (peek !== a.peek || peek === b.peek || peek() !== 3) throw new Error("method value identity");
    a.link(a);
    if (a.next !== a || a.next.self() !== a) throw new Error("an object holding itself");
    a.link(b);
    if (a.next !== b || b.next !== a || b.next.next !== b) throw new Error("two objects holding each other");
    for (let round = 0; round < 64; round++) counters[0]!(round).link(counters[0]!(-round));
    if (a.twice() !== 5 || b.next?.owner() !== a) throw new Error("objects after collection");
`,
);

check(
    "optional-class-method-call-values",
    `
    class Contacts {
        constructor(private readonly base: number) {}
        age(a: number, b: number): number { return this.base + a + b; }
        retains(a: number): boolean { return a > this.base; }
        envelope(slot?: number): { compact: boolean } { return { compact: slot !== undefined }; }
        touch(): void { touched++; }
    }
    let touched = 0;
    const pairs = new Map<string, Contacts>();
    pairs.set("x", new Contacts(10));
    let evaluated = 0;
    function argument(value: number): number { evaluated++; return value; }
    function age(key: string): number { return pairs.get(key)?.age(argument(1), 2) ?? -1; }
    function retains(key: string, a: number): boolean { return pairs.get(key)?.retains(a) ?? false; }
    const normal = { compact: false };
    function envelope(key: string): { compact: boolean } { return pairs.get(key)?.envelope(1) ?? normal; }
    if (age("x") !== 13 || age("y") !== -1 || evaluated !== 1) throw new Error("optional method value");
    if (!retains("x", 11) || retains("y", 11) || retains("x", 3)) throw new Error("optional boolean method");
    if (!envelope("x").compact || envelope("y") !== normal) throw new Error("optional record method");
    const missing = pairs.get("y")?.age(1, 2);
    const touchedNone = pairs.get("y")?.touch();
    const touchedOne = pairs.get("x")?.touch();
    pairs.get("x")?.age(argument(1), 0);
    if (missing !== undefined || touchedNone !== undefined || touchedOne !== undefined || touched !== 1 || evaluated !== 2)
        throw new Error("absent receiver is undefined");
    const stored: Array<typeof age> = [age];
    if (stored[0]!("x") !== 13) throw new Error("stored caller");
`,
);

check(
    "error-constructors-called-without-new",
    `
    function fail(kind: number): number {
        if (kind === 0) throw Error("plain");
        if (kind === 1) throw RangeError("range " + kind);
        return kind;
    }
    let caught = "";
    for (const kind of [0, 1, 2]) {
        try { caught += fail(kind); } catch (error) { if (error instanceof Error) caught += error.name + ":" + error.message + ";"; }
    }
    if (caught !== "Error:plain;RangeError:range 1;2") throw new Error(caught);
    const held = TypeError("held");
    if (held.name !== "TypeError" || held.message !== "held") throw new Error("held error value");
`,
);

check(
    "expression-bodied-recursive-callbacks",
    `
    function root(values: readonly number[], index: number): number {
        const parent = values.slice();
        const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
        return find(index) * 10 + parent[index]!;
    }
    const seen: number[] = [];
    function log(k: number): void { seen.push(k); }
    function visit(k: number, next: (k: number) => void): void { seen.push(k); if (k > 0) next(k - 1); }
    function walk(n: number): string {
        const down = (k: number): void => (k > 0 ? down(k - 1) : log(k));
        const each = (k: number): void => visit(k, each);
        down(n);
        each(n);
        return seen.join(",");
    }
    const roots: Array<typeof root> = [root];
    const walks: Array<typeof walk> = [walk];
    if (roots[0]!([1, 1, 1, 2], 3) !== 11 || walks[0]!(2) !== "0,2,1,0") throw new Error("expression-bodied recursion");
`,
);

check(
    "functions-re-entered-through-their-callback-arguments",
    `
    interface Extent { pos: number; neg: number }
    function walkAlternating<T>(firstSide: 1 | -1, step: number, extent: Extent, tryOffset: (offset: number) => T | null): T | null {
        const first = tryOffset(0);
        if (first) return first;
        for (let n = 1; step > 0 && (n * step <= extent.pos || n * step <= extent.neg); n++) {
            const near = tryOffset(firstSide * n * step);
            if (near) return near;
            const far = tryOffset(-firstSide * n * step);
            if (far) return far;
        }
        return null;
    }
    function findFreePoint(base: number, blocked: (x: number) => boolean): { x: number } | null {
        return walkAlternating(1, 1, { pos: 3, neg: 3 }, (offset) => (blocked(base + offset) ? null : { x: base + offset }));
    }
    function findHook(side: 1 | -1, blocked: (x: number) => boolean): { x: number; hook: number } | null {
        return walkAlternating(side, 1, { pos: 2, neg: 2 }, (offset) => {
            const point = findFreePoint(offset * 10, blocked);
            return point ? { x: point.x, hook: offset } : null;
        });
    }
    const hooks: Array<typeof findHook> = [findHook];
    const found = hooks[0]!(1, (x) => x < 11);
    const reversed = findHook(-1, (x) => x > -9 && x < 30);
    if (!found || found.x !== 11 || found.hook !== 1) throw new Error("nested walk");
    if (!reversed || reversed.x !== -10 || reversed.hook !== -1) throw new Error("nested walk from the far side");
`,
);

test("module const function aliases call the aliased function", async (t) => {
    const directory = resolve("artifacts/const-function-aliases");
    mkdirSync(directory, { recursive: true });
    const module = `
        function archKey(x: number, z: number): string { return Math.round(x * 10) + "," + Math.round(z * 10); }
        const f32 = Math.fround;
        const quantKey = archKey;
        const sameKey = quantKey;
        function append(log: number[]): number { log.push(log.length); return log.length; }
        const record = append;
        export function noise(x: number): number { const px = f32(x); return f32(f32(px * px) * f32(3 - f32(2 * px))); }
        export function loopKey(x: number, z: number): string { return quantKey(x, z) + "~" + sameKey(z, x); }
        export function aliasIdentity(): boolean { return quantKey === archKey && sameKey === archKey; }
        export function recordTwice(log: number[]): number { record(log); return record(log); }`;
    writeFileSync(join(directory, "aliases.ts"), module);
    const entry = `
        import { aliasIdentity, loopKey, noise, recordTwice } from "./aliases.js";
        const x = 0.3, px = Math.fround(x);
        if (noise(x) !== Math.fround(Math.fround(px * px) * Math.fround(3 - Math.fround(2 * px)))) throw new Error("Math alias");
        if (loopKey(1, 0.25) !== "10,3~3,10" || !aliasIdentity()) throw new Error("function alias");
        const log: number[] = [];
        if (recordTwice(log) !== 2 || log.join(",") !== "0,1") throw new Error("alias calls run once each");
        const stored: Array<typeof noise> = [noise];
        if (stored[0]!(x) !== noise(x)) throw new Error("stored alias caller");`;
    const commonJs = (source: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    const exported: Record<string, unknown> = {};
    runInNewContext(commonJs(module), { exports: exported });
    runInNewContext(commonJs(entry), { exports: {}, require: () => exported });
    const result = compileSource(entry, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(t, "const-function-aliases", result.cpp);
});

check(
    "optional-generic-methods-and-caught-errors-in-stored-functions",
    `
    interface Deps { run(): void; track?<T>(label: string, work: () => T): T }
    interface Publication { publish(): void; consequence(): boolean }
    let ran = 0;
    let labels = "";
    function createPublication(deps: Deps): Publication {
        const track = deps.track ?? (<T>(_label: string, work: () => T): T => work());
        return {
            publish() { track("publish", () => deps.run()); },
            consequence() { return track("consequence", () => ran > 0); },
        };
    }
    interface Options { onUncertain?(command: string, error: unknown): void }
    interface Ledger { execute(command: string, apply: (command: string) => number): number }
    function createLedger(options: Options = {}): Ledger {
        return {
            execute(command, apply) {
                try { return apply(command); }
                catch (error) { options.onUncertain?.(command, error); return -1; }
            },
        };
    }
    const publications: Array<typeof createPublication> = [createPublication];
    const plain = publications[0]!({ run: () => { ran++; } });
    plain.publish();
    if (!plain.consequence() || ran !== 1) throw new Error("default generic track");
    const traced = publications[0]!({ run: () => { ran++; }, track: <T>(label: string, work: () => T): T => { labels += label + ";"; return work(); } });
    traced.publish();
    if (!traced.consequence() || ran !== 2 || labels !== "publish;consequence;") throw new Error("optional generic method");
    const ledgers: Array<typeof createLedger> = [createLedger];
    let seen = "";
    const ledger = ledgers[0]!({ onUncertain: (command, error) => { seen = command + ":" + (error instanceof Error ? error.message : "?"); } });
    if (ledger.execute("a", () => 3) !== 3 || seen !== "") throw new Error("applied command");
    if (ledger.execute("b", () => { throw new Error("broken"); }) !== -1 || seen !== "b:broken") throw new Error("caught error argument");
    if (ledgers[0]!().execute("c", () => { throw new Error("quiet"); }) !== -1) throw new Error("absent handler");
`,
);

check(
    "caught-error-aliases-in-stored-unknown-parameters",
    `
    interface Options { onUncertain?(command: string, error: unknown): void }
    function attempt(options: Options, command: string, apply: () => number): number {
        try { return apply(); }
        catch (caught) {
            const error = caught;
            const again = error;
            options.onUncertain?.(command, again);
            return -1;
        }
    }
    const attempts: Array<typeof attempt> = [attempt];
    let seen = "";
    const options: Options = { onUncertain: (command, error) => { seen += command + ":" + (error instanceof Error ? error.message : "?") + ";"; } };
    if (attempts[0]!(options, "a", () => 2) !== 2 || seen !== "") throw new Error("applied command");
    if (attempts[0]!(options, "b", () => { throw new RangeError("broken"); }) !== -1 || seen !== "b:broken;") throw new Error("caught error alias");
`,
);

check(
    "stored-unknown-parameters-take-literal-arguments",
    `
    function count(raw: unknown): number { return raw === undefined ? 0 : 1; }
    const counters: Array<typeof count> = [count];
    if (counters[0]!({ h: 1 }) !== 1) throw new Error("object literal");
    if (counters[0]!({ h: 2 }) + counters[0]!({ w: "x", h: 3 }) + counters[0]!({ h: 4 }) !== 3) throw new Error("several object literals");
    if (counters[0]!([1, 2]) + counters[0]!([{ a: 1 }]) !== 2) throw new Error("array literals");
    if (counters[0]!({ n: { b: 1 }, list: [{ c: "z" }] }) !== 1) throw new Error("nested object literal");
    let looped = 0;
    for (let i = 0; i < 3; i++) looped += counters[0]!({ i });
    if (looped !== 3) throw new Error("literal in a loop");
    function wrap<T>(value: T): number { return counters[0]!({ value }); }
    if (wrap(1) + wrap("text") !== 2) throw new Error("literal of a type parameter");
    function size(...raw: unknown[]): number { return raw.length; }
    const sizes: Array<typeof size> = [size];
    if (sizes[0]!("a", { h: 1 }, [{ b: 2 }]) !== 3) throw new Error("rest literals");
    function describe(raw: unknown): string {
        if (raw === undefined) return "absent";
        if (Array.isArray(raw)) return "array:" + raw.length;
        if (typeof raw === "object" && raw !== null) return "object:" + JSON.stringify(raw);
        return typeof raw;
    }
    const describers: Array<typeof describe> = [describe];
    const text = describers[0]!({ h: 1 }) + "|" + describers[0]!([1, 2]) + "|" + describers[0]!({ n: { b: 1 } });
    if (text !== 'object:{"h":1}|array:2|object:{"n":{"b":1}}') throw new Error("literal values " + text);
`,
);

check(
    "stored-unknown-methods-callbacks-and-map-values-take-literals",
    `
    interface Counter { count(raw: unknown): number; }
    const counters: Counter[] = [{ count(raw: unknown): number { return raw === undefined ? 0 : 1; } }];
    if (counters[0]!.count({ h: 1 }) + counters[0]!.count({ w: [1, 2] }) !== 2) throw new Error("stored record method");
    const handlers: Array<(x: unknown) => number> = [(x: unknown) => (x === null ? 5 : 7)];
    function apply(handler: (x: unknown) => number): number { return handler({ h: 1 }) + handler([{ a: 2 }]); }
    if (apply(handlers[0]!) !== 14) throw new Error("callback parameter");
    if (handlers[0]!({ n: { m: 1 } }) !== 7) throw new Error("stored callback");
    const table = new Map<string, (raw: unknown) => number>();
    table.set("count", (raw: unknown) => (raw === undefined ? 0 : 1));
    if (table.get("count")!({ h: 1 }) + table.get("count")!({ n: { m: [1] } }) + table.get("count")!([{ k: 1 }]) !== 3) throw new Error("map value");
    if (table.get("missing") !== undefined || table.get("count") === undefined) throw new Error("map value presence");
    const found = table.get("count");
    if (!found || found({ h: 1 }) !== 1) throw new Error("narrowed map value");
`,
);

check(
    "immediate-promise-callbacks-destructure-their-value",
    `
    interface Pair { wave: number; caustics: number }
    async function load(n: number): Promise<number> { return n * 2; }
    async function loadPair(): Promise<Pair> { return { wave: 3, caustics: 4 }; }
    void Promise.all([load(1), load(2)]).then(([wave, caustics]) => {
        if (wave !== 2 || caustics !== 4) throw new Error("tuple destructuring");
    });
    void loadPair().then(({ wave, caustics: renamed }) => {
        if (wave !== 3 || renamed !== 4) throw new Error("record destructuring");
    });
`,
);

test("immediate promise callbacks refuse rest parameters", () => {
    assert.throws(
        () =>
            compileSource(
                "async function load(): Promise<number> { return 1; } void load().then((...values) => { const unused = values.length; });",
            ),
        /Immediate promise callback accepts zero parameters or one parameter binding/,
    );
});

/**
 * Asynchronous work that needs an owned promise runs in an application
 * realm; the snippet closes it once its last assertion has run, which both
 * sides observe.
 */
function checkInRealm(name: string, source: string): void {
    test(name, async (t) => {
        let closed = false;
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            {
                close: () => (closed = true),
                setTimeout,
                clearTimeout,
                queueMicrotask,
                structuredClone,
            },
        );
        // A realm may close from a timer callback as well as a reaction.
        for (let turn = 0; turn < 20 && !closed; turn++)
            await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(closed, true);
        const result = compileSource(source, { fileName: `${name}.ts` });
        await t.test(
            "generated C++ executes the same assertions",
            { skip: !native },
            () => {
                runGeneratedProgram(
                    native!,
                    `language-constructs/${name}`,
                    result.cpp,
                    { defines: ["BBLITE_WORKERS=1"] },
                );
            },
        );
    });
}

checkInRealm(
    "async-returns-of-a-promise-or-a-record-branch",
    `
    type Result = { status: "loaded"; text: string } | { status: "invalid" } | { status: "cancelled" } | { status: "error" };
    async function parse(text: string): Promise<Result> {
        await Promise.resolve();
        return text.length > 0 ? { status: "loaded", text } : { status: "invalid" };
    }
    interface Picked { name: string; }
    async function choose(name: string): Promise<Picked | null> {
        await Promise.resolve();
        if (name === "-") return null;
        return { name };
    }
    async function pick(name: string): Promise<Result> {
        try {
            const file = await choose(name);
            return file ? parse(file.name) : { status: "cancelled" };
        } catch {
            return { status: "error" };
        }
    }
    async function direct(name: string): Promise<Result> {
        return name === "" ? { status: "cancelled" } : parse(name);
    }
    void (async () => {
        const seen = [await pick("a"), await pick("-"), await pick(""), await direct(""), await direct("b")].map((r) => r.status);
        if (seen.join(",") !== "loaded,cancelled,invalid,cancelled,loaded") throw new Error(seen.join(","));
        globalThis.close();
    })();
`,
);

checkInRealm(
    "awaited-nullish-fallbacks-run-only-when-absent",
    `
    const order: string[] = [];
    async function load(n: number): Promise<number> {
        order.push("load" + n);
        await Promise.resolve();
        return n * 2;
    }
    const sizes = new Map<string, number>([["a", 1]]);
    async function count(key: string): Promise<number> {
        order.push("count:" + key);
        const value = sizes.get(key) ?? (await load(5));
        order.push("got" + value);
        return value;
    }
    const labels = new Map<string, string>([["a", "x"]]);
    async function label(key: string): Promise<string> {
        return labels.get(key) ?? String(await load(1));
    }
    void (async () => {
        const counted = [await count("a"), await count("b")];
        const labelled = [await label("a"), await label("b")];
        if (counted.join(",") !== "1,10" || labelled.join(",") !== "x,2") throw new Error(counted.join(",") + labelled.join(","));
        if (order.join(",") !== "count:a,got1,count:b,load5,got10,load1") throw new Error(order.join(","));
        globalThis.close();
    })();
`,
);

checkInRealm(
    "async-callees-read-records-past-the-call",
    `
    interface Wide { x: number; y: number; tag: string }
    interface Narrow { x: number; y: number }
    const third: Wide = { x: 1, y: 2, tag: "c" };
    async function readLater(p: Narrow): Promise<number> { await Promise.resolve(); return p.x; }
    void (async () => {
        const pending = readLater(third);
        third.x = 50;
        if ((await pending) !== 50) throw new Error("an async callee reads the original after the call returns");
        globalThis.close();
    })();
`,
);
checkInRealm(
    "async-results-of-another-record-type-settle-as-the-declared-type",
    `
    interface Info { name: string; icon: string | null; tint: [number, number, number] | null }
    const cache = new Map<string, Promise<Info>>();
    function delay(value: number): Promise<number> { return new Promise((resolve) => setTimeout(() => resolve(value), 0)); }
    async function readUncached(url: string): Promise<Info> {
        const size = await delay(url.length);
        return { name: url, icon: size > 3 ? "icon" : null, tint: size > 100 ? [1, 2, 3] : null };
    }
    function readInfo(url: string): Promise<Info> {
        let p = cache.get(url);
        if (!p) {
            p = readUncached(url);
            cache.set(url, p);
        }
        return p;
    }
    const first = readInfo("abcd");
    if (first !== readInfo("abcd")) throw new Error("cached promise");
    void first.then((info) => {
        if (info.icon !== "icon" || info.name !== "abcd" || info.tint !== null) throw new Error("settled record");
        globalThis.close();
    });
`,
);
checkInRealm(
    "stored-promise-then-finally",
    `
    interface Deps { spawn(x: number): Promise<boolean>; despawn(): void }
    let spawned = 0;
    let spawning = false;
    let finished = 0;
    function createLive(deps: Deps): { start(x: number): void } {
        return {
            start(x) {
                spawning = true;
                void deps.spawn(x)
                    .then((ok) => { if (ok) spawned++; else deps.despawn(); })
                    .finally(() => {
                        spawning = false;
                        finished++;
                        if (spawned !== 1) throw new Error("fulfillment reaction runs before cleanup");
                        globalThis.close();
                    });
            },
        };
    }
    const lives: Array<typeof createLive> = [createLive];
    lives[0]!({ spawn: async (x) => x > 0, despawn: () => {} }).start(1);
    if (!spawning || finished !== 0) throw new Error("cleanup waits for settlement");
`,
);

checkInRealm(
    "generic-method-over-a-value-or-promise-union",
    `
    type Outcome = { readonly committed: true; readonly created: number } | { readonly committed: false; readonly reason: string };
    interface Deps { runWorldEdit<T>(operation: () => T | Promise<T>): Promise<T | null>; syncNow(): void }
    async function runEdit(deps: Deps, command: () => Outcome): Promise<Outcome> {
        return (await deps.runWorldEdit(async () => {
            const outcome = command();
            if (outcome.committed) deps.syncNow();
            return outcome;
        })) ?? { committed: false, reason: "transaction" };
    }
    let synced = 0;
    const deps: Deps = { runWorldEdit: async (operation) => await operation(), syncNow: () => { synced++; } };
    const refusing: Deps = { runWorldEdit: async () => null, syncNow: () => { synced += 10; } };
    const edits: Array<typeof runEdit> = [runEdit];
    void (async () => {
        const created = await edits[0]!(deps, () => ({ committed: true, created: 3 }));
        const refused = await edits[0]!(refusing, () => ({ committed: true, created: 4 }));
        if (!created.committed || created.created !== 3 || refused.committed || refused.reason !== "transaction" || synced !== 1)
            throw new Error("generic edit lane");
        globalThis.close();
    })();
`,
);

check(
    "defaulted-parameters-through-stored-method-views",
    `
    interface Frame { bind(handle: number, publish: (x: number) => void, localY?: number, datum?: string): number }
    class HostFrame implements Frame {
        bind(handle: number, publish: (x: number) => void, localY = 0, datum?: string): number {
            publish(handle + localY);
            return datum ? 1 : 0;
        }
    }
    function use(frame: Pick<HostFrame, "bind">): number {
        let seen = 0;
        const plain = frame.bind(3, (x) => { seen += x; });
        const placed = frame.bind(1, (x) => { seen += x * 100; }, 2, "datum");
        return seen + plain * 1000 + placed * 10000;
    }
    function scaled(value: number, factor = 2, offset = factor * 10): number { return value * factor + offset; }
    const users: Array<typeof use> = [use];
    const scales: Array<typeof scaled> = [scaled];
    if (users[0]!(new HostFrame()) !== 10303) throw new Error("defaulted method view");
    if (scales[0]!(1) !== 22 || scales[0]!(1, 3) !== 33 || scales[0]!(1, 3, 1) !== 4) throw new Error("defaulted stored function");
`,
);

check(
    "conditional-spread-record-tuple-callback-properties",
    `
    const gate = new Float32Array([0, 1, 2]);
    interface Output { kind: string; batchYield: number }
    interface Profile {
        name: string;
        secondary?: Output;
        indices?: number[];
        tint?: [number, number, number];
        eave?: { inset: readonly [number, number] };
        terrainY?: () => number;
        onRelease?: (speed: number) => void;
    }
    let released = 0;
    function profile(job: string, bone: number | undefined, footY: number, notify?: (value: number) => void): Profile {
        return {
            name: job,
            ...(job === "inn" ? { secondary: { kind: "keg", batchYield: Math.max(1, footY * 2) } } : {}),
            ...(bone === undefined ? {} : { indices: [bone] }),
            ...(job === "inn" ? { tint: [footY, 2, 3] as [number, number, number] } : {}),
            ...(footY > 0 ? { eave: { inset: [footY, footY] as const } } : {}),
            ...(footY > 0 ? { terrainY: () => footY } : {}),
            ...(notify ? { onRelease: (speed: number) => notify(speed * 2) } : {}),
        };
    }
    const full = profile(gate[1]! > 0 ? "inn" : "x", gate[2]!, gate[1]!, (value) => { released += value; });
    const bare = profile(gate[0]! > 0 ? "inn" : "x", undefined, gate[0]!);
    if (full.secondary?.kind !== "keg" || full.secondary.batchYield !== 2 || full.indices?.[0] !== 2 || full.tint?.[0] !== 1)
        throw new Error("present record, array and tuple properties");
    if (full.eave?.inset[1] !== 1 || full.terrainY?.() !== 1) throw new Error("present nested tuple and callback");
    full.onRelease?.(3);
    if (released !== 6) throw new Error("present callback property");
    if (bare.secondary !== undefined || bare.indices !== undefined || bare.tint !== undefined || bare.eave !== undefined ||
        bare.terrainY !== undefined || bare.onRelease !== undefined)
        throw new Error("absent properties");
    if ("secondary" in bare || !("secondary" in full) || "terrainY" in bare || !("onRelease" in full)) throw new Error("own keys");
`,
);

// A readonly array a conditional spread builds is the record's own array,
// stored and serialized as the one array JavaScript keeps.
check(
    "conditional-spread-readonly-array-member",
    `
    interface HerdOptions { file: string; capacity: number; anchors?: readonly number[]; bones?: readonly number[]; shadow?: boolean }
    interface Prototype { file: string; bone?: number }
    function herdOptions(options: Prototype): HerdOptions {
        return { file: options.file, capacity: 1, ...(options.bone === undefined ? {} : { bones: [options.bone, options.bone + 1] }) };
    }
    function cacheKey(opts: HerdOptions): string {
        return JSON.stringify({ file: opts.file, anchors: opts.anchors ?? null, bones: opts.bones ?? null });
    }
    const prepared = new Map<string, number>();
    function create(file: string, shell: { bone: number } | null, shadow: boolean): string {
        const opts: HerdOptions = { ...herdOptions({ file, ...(shell ? { bone: shell.bone } : {}) }), shadow };
        const key = cacheKey(opts);
        if (!prepared.has(key)) prepared.set(key, prepared.size);
        return key + "#" + prepared.get(key) + ":" + (opts.bones === opts.bones) + ":" + (opts.shadow === true);
    }
    const creates: Array<typeof create> = [create];
    if (creates[0]!("t", { bone: 3 }, true) !== '{"file":"t","anchors":null,"bones":[3,4]}#0:true:true') throw new Error("present");
    if (creates[0]!("t", null, false) !== '{"file":"t","anchors":null,"bones":null}#1:true:false') throw new Error("absent");
    if (creates[0]!("t", { bone: 3 }, false) !== '{"file":"t","anchors":null,"bones":[3,4]}#0:true:false') throw new Error("cached");
    interface Track { name: string; points?: readonly number[] }
    function track(name: string, from: number | null): Track {
        return { name, ...(from === null ? {} : { points: [from, from * 2] }) };
    }
    const tracks: Array<typeof track> = [track];
    const t = tracks[0]!("a", 2);
    const points = t.points;
    if (points !== t.points || points?.length !== 2 || points[1] !== 4 || tracks[0]!("b", null).points !== undefined)
        throw new Error("one member array");
`,
);

check(
    "conditional-spread-own-keys",
    `
    const gate = new Float32Array([0, 1]);
    const absent = { name: "a", ...(gate[0]! > 0 ? { extra: 3 } : {}), tail: true };
    const present = { name: "a", ...(gate[1]! > 0 ? { extra: 4 } : {}), tail: true };
    if ("extra" in absent || !("extra" in present)) throw new Error("in");
    const key = gate[1]! > 0 ? "extra" : "name";
    if (key in absent || !(key in present)) throw new Error("dynamic in");
    if (Object.hasOwn(absent, "extra") || !Object.hasOwn(present, "extra")) throw new Error("hasOwn");
    if (Object.keys(absent).join() !== "name,tail" || Object.keys(present).join() !== "name,extra,tail")
        throw new Error("keys " + Object.keys(present).join());
    if (Object.values(present).length !== 3 || Object.values(absent).length !== 2) throw new Error("values");
    const entries = Object.entries(present).map(([k, v]) => k + "=" + v).join();
    if (entries !== "name=a,extra=4,tail=true") throw new Error("entries " + entries);
    let visited = "";
    for (const k in absent) visited += k;
    for (const k in present) visited += k;
    if (visited !== "nametailnameextratail") throw new Error("for in " + visited);
    if (JSON.stringify(absent).includes("extra") || JSON.parse(JSON.stringify(present)).extra !== 4) throw new Error("json");
    const kept = { extra: 1, ...(gate[0]! > 0 ? { extra: 2 } : {}) };
    const replaced = { extra: 1, ...(gate[1]! > 0 ? { extra: 2 } : {}) };
    if (kept.extra !== 1 || replaced.extra !== 2) throw new Error("override");
    const copy = { ...absent, more: 1 };
    const copied = { ...present, more: 1 };
    if ("extra" in copy || copied.extra !== 4 || Object.keys(copied).join() !== "name,extra,tail,more") throw new Error("copy");
    const table: Record<string, number> = { base: 1, ...(gate[1]! > 0 ? { added: 2 } : {}), ...(gate[0]! > 0 ? { skipped: 3 } : {}) };
    if (Object.keys(table).join() !== "base,added") throw new Error("dictionary " + Object.keys(table).join());
    interface Options { width: number; tint?: number; label?: string }
    function read(index: number): Options { return index > 0 ? { width: 2, tint: 5 } : { width: 1 }; }
    const a = { ...read(gate[1]!), kind: "a" };
    const b = { ...read(gate[0]!), kind: "b" };
    if (a.tint !== 5 || !("tint" in a) || "tint" in b || "label" in a) throw new Error("struct spread keys");
    const over = { tint: 9, ...read(gate[0]!) };
    const under = { tint: 9, ...read(gate[1]!) };
    if (over.tint !== 9 || under.tint !== 5) throw new Error("struct spread override");
`,
);

check(
    "for-in-over-conditional-keys-with-nested-exits",
    `
    const gate = new Float32Array([0, 1]);
    const record = { name: "a", ...(gate[1]! > 0 ? { extra: 4 } : {}), ...(gate[0]! > 0 ? { skipped: 1 } : {}), tail: true };
    let visited = "";
    for (const key in record) {
        let inner = 0;
        for (let i = 0; i < 4; i++) {
            if (i === 1) continue;
            if (i === 3) break;
            inner += i;
        }
        switch (key.length) {
            case 4: visited += "4"; break;
            default: visited += "d";
        }
        visited += key + inner;
    }
    if (visited !== "4name2dextra24tail2") throw new Error("for in with nested exits " + visited);
`,
);

check(
    "conditional-spread-prepared-arms",
    `
    const gate = new Float32Array([0, 1]);
    let draws = 0;
    function rng(): number { draws++; return gate[1]! * 0.5; }
    interface Style { level: number; roofHeight?: number; endSlope?: number; crown?: string; ivyOff?: boolean }
    function style(crown: string): Partial<Style> {
        return {
            level: Math.round(rng() * 20) / 20,
            ...(crown === "roof" ? { roofHeight: rng() * 2, endSlope: rng() < 0.75 ? 0 : 1 } : { crown: "railing" }),
            ...(rng() < 0.2 ? { ivyOff: true } : {}),
        };
    }
    const roof = style(gate[1]! > 0 ? "roof" : "flat");
    if (roof.roofHeight !== 1 || roof.endSlope !== 0 || roof.crown !== undefined || "crown" in roof || draws !== 4)
        throw new Error("selected arm " + draws);
    const flat = style(gate[0]! > 0 ? "roof" : "flat");
    if (flat.roofHeight !== undefined || flat.crown !== "railing" || flat.ivyOff !== undefined || draws !== 6)
        throw new Error("other arm " + draws);
    interface Run { id: number }
    interface Snap { x: number; target?: { runIndex: number }; run?: Run }
    const runs: Run[] = [{ id: 7 }, { id: 9 }];
    function snap(x: number | undefined, target: { runIndex: number } | undefined): Snap | null {
        return x !== undefined ? { x, ...(target ? { target, run: runs[target.runIndex] } : {}) } : null;
    }
    const target = { runIndex: 1 };
    const hit = snap(gate[1]!, gate[1]! > 0 ? target : undefined);
    if (hit?.run?.id !== 9 || hit.target !== target) throw new Error("prepared member identity");
    if (snap(gate[0]!, undefined)?.run !== undefined) throw new Error("prepared absent");
    interface Arch { span: number; seatDepth?: number }
    const arches = (list: readonly Arch[], sink?: number): Arch[] =>
        list.map((arch) => ({ ...arch, ...(sink !== undefined ? { seatDepth: (arch.seatDepth ?? 0.25) + sink } : {}) }));
    const sunk = arches([{ span: 1 }, { span: 2, seatDepth: 1 }], gate[1]!);
    if (sunk[0]!.seatDepth !== 1.25 || sunk[1]!.seatDepth !== 2 || arches([{ span: 1, seatDepth: 3 }])[0]!.seatDepth !== 3)
        throw new Error("prepared fallback member");
    interface State { mix: number }
    const store: State[] = [{ mix: 1 }, { mix: 2 }];
    const find = (id: number) => (Number.isSafeInteger(id) && id > 0 ? store.find((state) => state.mix === id) : undefined);
    if (find(gate[1]!) !== store[0] || find(gate[0]!) !== undefined || find(3) !== undefined) throw new Error("prepared search");
    interface Badge { level: number; label?: string }
    function badge(on: boolean): Badge { return { level: 1, ...(on ? { label: rng() > 0 ? "on" : "off" } : {}) }; }
    const shown = badge(gate[1]! > 0);
    if (shown.label !== "on" || shown.label.length !== 2 || badge(gate[0]! > 0).label !== undefined) throw new Error("prepared string member");
`,
);

check(
    "conditional-branches-of-different-native-kinds",
    `
    const gate = new Float32Array([0, 1, 2]);
    const jobs = ["baker", "priest", "queen"];
    function availability(job: string, unlocked: boolean): { unlocked: boolean; goalMana?: number } {
        const goal = job === "priest" ? { goalMana: 5 } : job === "queen" ? { goalMana: 7 } : {};
        return unlocked ? { unlocked: true, ...goal } : { unlocked: false, ...goal };
    }
    const priest = availability(jobs[gate[1]!]!, gate[1]! > 0);
    const queen = availability(jobs[gate[2]!]!, gate[0]! > 0);
    const baker = availability(jobs[gate[0]!]!, gate[1]! > 0);
    if (priest.goalMana !== 5 || queen.goalMana !== 7 || queen.unlocked || baker.goalMana !== undefined || "goalMana" in baker)
        throw new Error("nested conditional records");
    interface Projection { inside: boolean }
    let bestInside = false;
    let picks = 0;
    for (const value of gate) {
        const intent: Projection = { inside: value > 0.5 };
        const better = intent.inside !== bestInside ? intent.inside : value < 1.5;
        if (better) { picks++; bestInside = intent.inside; }
    }
    if (picks !== 2 || !bestInside) throw new Error("data and boolean branches");
    function reads(shared: boolean): { cascade: (layer: string) => string; frustum: string } {
        return shared ? { cascade: (layer) => "scene(" + layer + ")", frustum: "a" } : { cascade: (layer) => "own(" + layer + ")", frustum: "b" };
    }
    if (reads(gate[1]! > 0).cascade("1") !== "scene(1)" || reads(gate[0]! > 0).cascade("2") !== "own(2)") throw new Error("callback members");
    type Blocked = "ambiguous" | "unqualified";
    function facts(active: boolean, blocked: Blocked): { fn: "church" | "none"; blocked: Blocked | null } {
        const base = { fn: "none" as const };
        return active ? { ...base, fn: "church" as const, blocked: null } : { ...base, blocked };
    }
    if (facts(gate[1]! > 0, "ambiguous").blocked !== null || facts(gate[0]! > 0, "unqualified").blocked !== "unqualified")
        throw new Error("null member");
    type Kind = "well" | "bench" | "keg";
    const KINDS: readonly Kind[] = ["well", "bench", "keg"];
    function kinds(config: { kinds?: readonly Kind[] } | undefined): readonly Kind[] {
        const listed = Array.isArray(config?.kinds) ? config.kinds : [];
        return KINDS.filter((kind) => listed.includes(kind));
    }
    const configs: ({ kinds?: readonly Kind[] } | undefined)[] = [{ kinds: ["keg", "well"] }, undefined, {}];
    if (kinds(configs[0]).join() !== "well,keg" || kinds(configs[1]).length !== 0 || kinds(configs[2]).length !== 0)
        throw new Error("array or empty literal");
    let ran = 0;
    function settle<T>(world: boolean, settlement: () => T): T | undefined { return world ? settlement() : undefined; }
    settle(gate[1]! > 0, () => { ran++; });
    settle(gate[0]! > 0, () => { ran++; });
    if (ran !== 1 || settle(gate[1]! > 0, () => 4) !== 4) throw new Error("void branch");
`,
);

check(
    "logical-and-selects-values",
    `
    const gate = new Float32Array([0, 1]);
    type Job = "baker" | "priest";
    interface Model { file: string }
    const MODELS: Partial<Record<Job, Model>> = { baker: { file: "b.glb" } };
    const plan = (job: Job | null): Model | null => (job && MODELS[job]) ?? null;
    if (plan(gate[1]! > 0 ? "baker" : null)?.file !== "b.glb" || plan(null) !== null || plan(gate[1]! > 0 ? "priest" : null) !== null)
        throw new Error("guarded table read");
    interface Surface { y: number }
    let reads = 0;
    const readLocal = (surface: Surface): { id: number } => { reads++; return { id: surface.y }; };
    function attach(surface: Surface | null): { id: number } | null {
        const handle = surface && readLocal(surface);
        return handle;
    }
    if (attach(gate[1]! > 0 ? { y: 4 } : null)?.id !== 4 || attach(null) !== null || reads !== 1) throw new Error("lazy right operand");
    const byKey = new Map<string, { id: number }>([["house:1", { id: 1 }]]);
    const lookup = (rec: { id: number } | undefined) => rec && byKey.get("house:" + rec.id);
    if (lookup({ id: gate[1]! })?.id !== 1 || lookup(undefined) !== undefined || lookup({ id: 2 }) !== undefined) throw new Error("map read");
    const r = { a: true, b: true, c: true };
    r.a = r.b = r.c = false;
    if (r.a || r.b || r.c) throw new Error("chained assignment");
    const frame = { admitted: false };
    const presence = { admitted: false };
    presence.admitted = frame.admitted = gate[0]! < gate[1]!;
    if (!presence.admitted || !frame.admitted) throw new Error("chained comparison");
    interface Peer { id: string }
    const peer: Peer = { id: "p" };
    const slots: { target0: Peer | null; target1: Peer | null; key0: string | null; key1: string | null; line0: number; line1: number } =
        { target0: peer, target1: peer, key0: "a", key1: "b", line0: 1, line1: 2 };
    slots.target0 = slots.target1 = null;
    slots.key0 = slots.key1 = null;
    slots.line0 = slots.line1 = -1;
    if (slots.target0 !== null || slots.target1 !== null || slots.key0 !== null || slots.key1 !== null || slots.line0 !== -1 || slots.line1 !== -1)
        throw new Error("chained stores");
`,
);

check(
    "assignment-values-evaluate-their-target-once",
    `
    const gate = new Float32Array([0, 1]);
    const flags: boolean[] = [false, false];
    let i = 0;
    let hits = 0;
    if ((flags[i++] = gate[1]! > 0)) hits++;
    if (i !== 1 || !flags[0] || flags[1] || hits !== 1) throw new Error("boolean element condition");
    const names: string[] = ["a", "b", "c"];
    let j = 0;
    const stored = (names[j++] = "x");
    if ((names[j++] = "")) hits++;
    if (j !== 2 || stored !== "x" || names.join(",") !== "x,,c" || hits !== 1) throw new Error("string elements");
    interface Row { label: string | null; tags: string[] }
    const rows: Row[] = [{ label: "r0", tags: [] }, { label: "r1", tags: [] }];
    let k = 0;
    const label = (rows[k++]!.label = "set");
    if (k !== 1 || label !== "set" || rows[0]!.label !== "set" || rows[1]!.label !== "r1") throw new Error("record element field");
    const tags = (rows[--k]!.tags = ["t"]);
    tags.push("u");
    if (k !== 0 || rows[0]!.tags.length !== 2 || rows[1]!.tags.length !== 0) throw new Error("assigned array identity");
    let n = 0;
    const counts = [1, 2];
    const total = (counts[n++] = 5) + (counts[n++] = 6);
    if (n !== 2 || total !== 11 || counts.join(",") !== "5,6") throw new Error("number elements");
    const bytes = new Uint8Array(2);
    let b = 0;
    const raw = (bytes[b++] = 300);
    if (b !== 1 || raw !== 300 || bytes[0] !== 44 || bytes[1] !== 0) throw new Error("typed array assignment value");
    const holder = { f: false };
    let calls = 0;
    function owner(): { f: boolean } { calls++; return holder; }
    const picked = (owner().f = gate[1]! > 0) ? 1 : 2;
    if (picked !== 1 || calls !== 1 || !holder.f) throw new Error("call target");
    const cursor = { node: 0 };
    const next = [2, 0, 1];
    let visits = 0;
    while ((cursor.node = next[cursor.node]!) !== 0) visits++;
    if (visits !== 2) throw new Error("loop condition store");
`,
);

check(
    "assignment-values-through-setters-yield-the-assigned-value",
    `
    const gate = new Float32Array([0, 1]);
    class Gauge {
        private level = 0;
        get value(): number { return this.level * 10; }
        set value(next: number) { this.level = Math.max(0, Math.min(1, next)); }
    }
    const gauge = new Gauge();
    const assigned = (gauge.value = 5);
    if (assigned !== 5 || gauge.value !== 10) throw new Error("setter value");
    const negative = (gauge.value = -3 * gate[1]!);
    if (negative !== -3 || gauge.value !== 0) throw new Error("normalized setter value");
    if ((gauge.value = 0)) throw new Error("falsy assigned value");
    const gauges: Gauge[] = [new Gauge(), new Gauge()];
    let g = 0;
    const half = (gauges[g++]!.value = 0.5);
    if (g !== 1 || half !== 0.5 || gauges[0]!.value !== 5 || gauges[1]!.value !== 0) throw new Error("stored instance setter");
    interface Labelled { label: string }
    function labelled(): Labelled {
        let text = "";
        return { get label() { return "<" + text + ">"; }, set label(next: string) { text = next.trim(); } };
    }
    const items: Labelled[] = [labelled(), { label: "plain" }];
    let c = 0;
    const shown = (items[c++]!.label = " hi ");
    if (c !== 1 || shown !== " hi " || items[0]!.label !== "<hi>" || items[1]!.label !== "plain") throw new Error("accessor slot");
    const plain = (items[c]!.label = " p ");
    if (plain !== " p " || items[1]!.label !== " p ") throw new Error("data slot");
`,
);

check(
    "chained-assignments-share-the-assigned-value",
    `
    const gate = new Float32Array([0, 1]);
    interface Peer { id: number }
    interface Slot { n: number; s: string; peer: Peer | null; list: number[]; maybe?: number }
    const make = (): Slot => ({ n: 0, s: "", peer: null, list: [] });
    const a = make(), b = make(), c = make();
    a.n = b.n = c.n = 4 * gate[1]!;
    a.s = b.s = c.s = "q";
    const shared: Peer = { id: 1 };
    a.peer = b.peer = c.peer = shared;
    shared.id = 2;
    if (a.peer!.id !== 2 || b.peer !== c.peer || a.peer !== shared) throw new Error("chained record identity");
    a.list = b.list = c.list = [];
    a.list.push(1);
    if (c.list.length !== 1 || b.list !== a.list) throw new Error("chained array identity");
    let x = 0, y = 0;
    x = y = a.n = 9;
    if (x !== 9 || y !== 9 || a.n !== 9 || b.n !== 4) throw new Error("chained locals");
    const sum = (a.maybe = 3) + 1;
    if (sum !== 4 || a.maybe !== 3) throw new Error("optional field value");
    a.s = b.s = a.n > 5 ? "big" : "small";
    if (a.s !== "big" || b.s !== "big" || c.s !== "q") throw new Error("chained conditional");
`,
);

check(
    "assignment-values-yield-the-right-side-for-every-target",
    `
    const gate = new Float32Array([0, 1]);
    let text = "a";
    let other = "b";
    const chained = (text = other = "z" + gate[1]!);
    if (chained !== "z1" || text !== "z1" || other !== "z1") throw new Error("string locals");
    interface Labelled { label: string }
    function labelled(): Labelled {
        let held = "";
        return { get label() { return "<" + held + ">"; }, set label(next: string) { held = next.trim(); } };
    }
    const target = labelled();
    const shown = (target.label = " hi ");
    if (shown !== " hi " || target.label !== "<hi>") throw new Error("accessor record");
    class Gauge {
        private level = 0;
        get value(): number { return this.level; }
        set value(next: number) { this.level = Math.max(0, Math.min(1, next)); }
    }
    const gauges = [new Gauge(), new Gauge()];
    let g = 1;
    const level = (gauges[g--]!.value = 7 * gate[1]!);
    if (level !== 7 || g !== 0 || gauges[1]!.value !== 1 || gauges[0]!.value !== 0) throw new Error("class setter through an element");
    interface Bag { items: number[]; count: number }
    const bags: Bag[] = [{ items: [], count: 0 }, { items: [], count: 0 }];
    let r = 0;
    const items = (bags[r++]!.items = [1, 2]);
    items.push(3);
    const count = (bags[r++]!.count = 5);
    if (r !== 2 || bags[0]!.items.length !== 3 || bags[0]!.items !== items || count !== 5 || bags[1]!.count !== 5) throw new Error("record fields through elements");
    let picked: Bag | null = null;
    const assigned = (picked = bags[1]!);
    assigned.count = 6;
    if (picked!.count !== 6 || assigned !== bags[1]) throw new Error("record local keeps identity");
`,
);

test("conditional record values refuse unrepresented key and absence shapes", () => {
    for (const [source, message] of [
        [
            "const g = new Float32Array([1]); const r = { a: 1, ...(g[0]! > 0 ? { b: 2 } : {}) }; for (const k in r) { if (k === 'b') break; }",
            /for\.\.\.in over a record whose keys a conditional spread decides cannot leave the loop early/,
        ],
        [
            "const g = new Float32Array([1]); const r = { a: 1, ...(g[0]! > 0 ? { b: 2 } : {}) }; const t = { c: 0 }; Object.assign(t, r);",
            /Enumerating a record whose keys a conditional spread decides as a fixed list requires known own keys/,
        ],
        [
            "const g = new Float32Array([1]); const r = { m() { return 1; }, ...(g[0]! > 0 ? { m: 2 } : {}) }; const n = r.m;",
            /conditionally present spread key 'm' cannot replace a method or accessor/,
        ],
        [
            "const g = new Float32Array([1]); function f(o: { x: number } | null | undefined): number | null | undefined { return o && o.x; } const v = f(g[0]! > 0 ? { x: 1 } : null);",
            /may be null or undefined selects a value only where its storage tells them apart/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "paired-null-and-undefined-tests",
    `
    const gate = new Float32Array([0, 1]);
    interface Bounds { x: number }
    interface Opts { linkedHandle?: Bounds | null; current: boolean }
    const dirty = (opts: Opts): boolean => opts.linkedHandle !== null && opts.linkedHandle !== undefined && opts.current === false;
    const handles: (Bounds | null | undefined)[] = [{ x: 1 }, null, undefined];
    let count = 0;
    for (let i = 0; i < 3; i++) if (dirty({ linkedHandle: handles[i], current: gate[0]! > 0 })) count++;
    if (count !== 1) throw new Error("present pair " + count);
    const absent = (value: Bounds | null | undefined): boolean => value === null || value === undefined;
    if (absent(handles[0]) || !absent(handles[1]) || !absent(handles[2])) throw new Error("absent pair");
    let pending: Bounds | null | undefined = gate[1]! > 0 ? null : undefined;
    let changed = pending !== null && pending !== undefined;
    if (changed) throw new Error("null pending");
    pending = { x: 2 };
    changed = pending !== null && pending !== undefined;
    if (!changed) throw new Error("present pending");
`,
);

check(
    "callbacks-run-once-per-element-in-returned-array-methods",
    `
    let calls = 0;
    const twice = (x: number): number => {
        calls++;
        return x * 2;
    };
    const keep = (x: number): boolean => {
        calls++;
        return x > 3;
    };
    const add = (sum: number, x: number): number => {
        calls++;
        return sum + x;
    };
    function blockMap(w: number): number[] {
        return [w, w + 1].map(twice);
    }
    const arrowMap = (w: number): number[] => [w, w + 1].map(twice);
    const inlineMap = (w: number): number[] =>
        [w, w + 1].map((x) => {
            calls++;
            return x + 1;
        });
    const filtered = (w: number): number[] => [w, w + 1, w + 2].filter(keep);
    const reduced = (w: number): number => [w, w + 1].reduce(add, 0);
    const spread = (w: number): number[] => [...[w, w + 1].map(twice)];
    const chosen = (w: number): number[] => (w > 0 ? [w, w].map(twice) : [w].map(twice));
    const flat = (w: number): number[] =>
        [w, w].flatMap((x) => {
            calls++;
            return [x, x];
        });
    const some = (w: number): boolean => [w, w + 1].some(keep);
    const local = (w: number): number => {
        const mapped: number[] = [w, w + 1].map(twice);
        return mapped.length;
    };
    const runtime = (w: number): number[] => {
        const xs: number[] = [];
        for (let i = 0; i < w; i++) xs.push(i);
        return xs.map(twice);
    };
    const shapes: [string, (w: number) => unknown, number][] = [
        ["block map", blockMap, 2],
        ["arrow map", arrowMap, 2],
        ["inline map", inlineMap, 2],
        ["filter", filtered, 3],
        ["reduce", reduced, 2],
        ["spread", spread, 2],
        ["conditional", chosen, 2],
        ["flatMap", flat, 2],
        ["some", some, 1],
        ["local", local, 2],
        ["runtime map", runtime, 4],
    ];
    const failures: string[] = [];
    for (const [label, run, expected] of shapes) {
        calls = 0;
        run(4);
        if (calls !== expected) failures.push(label + " stored " + calls + "/" + expected);
    }
    calls = 0;
    blockMap(4);
    arrowMap(4);
    spread(4);
    chosen(4);
    if (calls !== 8) failures.push("direct " + calls + "/8");
    if (failures.length > 0) throw new Error(failures.join("; "));
`,
);

check(
    "callbacks-run-once-per-element-in-array-method-sinks",
    `
    let calls = 0;
    const twice = (x: number): number => {
        calls++;
        return x * 2;
    };
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    const total = (xs: readonly number[]): number => xs.length;
    const asTuple = (w: number): [number, number] => [w, w + 1].map(twice) as [number, number];
    const asReadonly = (w: number): readonly number[] => [w, w + 1].map(twice);
    const inRecord = (w: number): { values: number[] } => ({ values: [w, w + 1].map(twice) });
    const asArgument = (w: number): number => sum([w, w + 1].map(twice));
    const asReadonlyArgument = (w: number): number => total([w, w + 1].map(twice));
    const joined = (w: number): string => [w, w + 1].map(twice).join(",");
    const maximum = (w: number): number => Math.max(...[w, w + 1].map(twice));
    const typed = (w: number): Float32Array => new Float32Array([w, w + 1].map(twice));
    const chained = (w: number): number[] => [w, w + 1].map(twice).map(twice);
    const assigned = (w: number): number[] => {
        let out: number[] = [];
        out = [w, w + 1].map(twice);
        return out;
    };
    const nested = (w: number): number[][] => [[w, w + 1].map(twice)];
    const viaFrom = (w: number): number[] => Array.from([w, w + 1], twice);
    const pair = (x: number): [string, number] => {
        calls++;
        return [String(x), x];
    };
    const asSet = (w: number): ReadonlySet<number> => new Set([w, w + 1].map(twice));
    const asMap = (w: number): ReadonlyMap<string, number> => new Map([w, w + 1].map(pair));
    const shapes: [string, (w: number) => unknown, number][] = [
        ["tuple", asTuple, 2],
        ["readonly", asReadonly, 2],
        ["record", inRecord, 2],
        ["argument", asArgument, 2],
        ["readonly argument", asReadonlyArgument, 2],
        ["join", joined, 2],
        ["max", maximum, 2],
        ["typed", typed, 2],
        ["chained", chained, 4],
        ["assigned", assigned, 2],
        ["nested", nested, 2],
        ["from", viaFrom, 2],
        ["set", asSet, 2],
        ["map", asMap, 2],
    ];
    const failures: string[] = [];
    for (const [label, run, expected] of shapes) {
        calls = 0;
        run(4);
        if (calls !== expected) failures.push(label + " stored " + calls + "/" + expected);
    }
    calls = 0;
    asTuple(4);
    inRecord(4);
    asArgument(4);
    assigned(4);
    nested(4);
    if (calls !== 10) failures.push("direct " + calls + "/10");
    if (failures.length > 0) throw new Error(failures.join("; "));
`,
);

check(
    "absence-tagged-locals-and-inlined-parameters",
    `
    interface Region { minX: number; maxX: number; }
    const gate = new Float32Array([0, 1]);
    let pending: Region | null | undefined;
    const log: string[] = [];
    const queue = (dirty: Region | null | undefined): void => {
        if (dirty === undefined || pending === null) return;
        pending = dirty === null ? null : { minX: Math.min(pending?.minX ?? dirty.minX, dirty.minX), maxX: dirty.maxX };
    };
    const consume = (): string => {
        const taken = pending;
        pending = undefined;
        return taken === undefined ? "none" : taken === null ? "full" : String(taken.minX);
    };
    queue(undefined);
    log.push(consume());
    queue({ minX: 3, maxX: 4 });
    queue({ minX: 1, maxX: 5 });
    log.push(consume());
    queue(null);
    queue({ minX: 7, maxX: 8 });
    log.push(consume());
    log.push(consume());
    let picked: Region | null | undefined = gate[1]! > 0 ? null : undefined;
    log.push(String(picked === null), typeof picked);
    picked = gate[0]! > 0 ? null : undefined;
    log.push(String(picked === null), typeof picked, String(picked === undefined));
    picked = { minX: 9, maxX: 9 };
    const alias = picked;
    alias.minX = 10;
    log.push(String(picked.minX), String(alias === picked));
    if (log.join(",") !== "none,1,full,none,true,object,false,undefined,true,10,true") throw new Error(log.join(","));
`,
);

check(
    "absence-tagged-stored-parameters-and-defaults",
    `
    interface Region { minX: number; }
    interface Field { rebuild(base?: Region | null): string; }
    function createField(): Field {
        const describe = (dirty: Region | null | undefined): string =>
            dirty === undefined ? "none" : dirty === null ? "full" : "r" + dirty.minX;
        const rebuild = (base?: Region | null): string => describe(base);
        return { rebuild };
    }
    const field = createField();
    const results = [field.rebuild(), field.rebuild(null), field.rebuild({ minX: 2 }), field.rebuild(undefined)];
    if (results.join(",") !== "none,full,r2,none") throw new Error(results.join(","));
    let made = 0;
    interface Ticket { id: number; }
    function make(studio: boolean): Ticket | null { made++; return studio ? null : { id: made }; }
    function kickoff(studio: boolean, ready: Ticket | null = make(studio)): string {
        return ready === null ? "null" : "t" + ready.id;
    }
    const roots: Array<typeof kickoff> = [kickoff];
    const outcomes = [roots[0]!(false), roots[0]!(false, null), roots[0]!(true), roots[0]!(true, { id: 7 })];
    if (outcomes.join(",") !== "t1,null,null,t7" || made !== 2) throw new Error(outcomes.join(",") + made);
`,
);

check(
    "absence-tagged-record-fields",
    `
    interface Mask { cells: number; }
    interface Reach { ok(x: number): boolean; }
    interface Options { mask?: Mask | null; reach?: Reach | null; }
    const describe = (opts: Options): string =>
        opts.mask === undefined ? "build" : opts.mask === null ? "none" : "m" + opts.mask.cells;
    const step = (opts: Options, x: number): string =>
        opts.reach === null ? "pending" : opts.reach === undefined ? "direct" : opts.reach.ok(x) ? "yes" : "no";
    const all: Options[] = [{}, { mask: null }, { mask: { cells: 3 } }, { mask: undefined, reach: null }, { reach: { ok: (x) => x > 1 } }];
    const seen = all.map((opts) => describe(opts) + ":" + step(opts, 2));
    if (seen.join(",") !== "build:direct,none:direct,m3:direct,build:pending,build:yes") throw new Error(seen.join(","));
    const changed = all[0]!;
    changed.mask = null;
    changed.reach = { ok: (x) => x > 5 };
    if (describe(changed) !== "none" || step(changed, 2) !== "no") throw new Error("field writes");
    changed.mask = undefined;
    if (describe(changed) !== "build" || step(changed, 9) !== "yes") throw new Error("undefined field");
`,
);

check(
    "absence-tagged-shared-function-parameters",
    `
    interface Reach { ok(x: number): boolean; }
    interface Step { reach?: Reach | null; x: number; }
    const log: string[] = [];
    function find(x: number, reach: Reach | null | undefined): string {
        if (reach === null) return "pending";
        if (reach !== undefined && !reach.ok(x)) return "blocked";
        return "free";
    }
    function select(step: Step): string {
        if (step.reach === null) return "nav";
        return find(step.x, step.reach);
    }
    function selectAll(steps: Step[]): void {
        for (const step of steps) log.push(select(step), find(step.x * 2, step.reach));
    }
    const roots: Array<typeof selectAll> = [selectAll];
    roots[0]!([{ x: 1 }, { x: 2, reach: null }, { x: 3, reach: { ok: (x) => x > 4 } }]);
    if (log.join(",") !== "free,free,nav,pending,blocked,free") throw new Error(log.join(","));
`,
);

check(
    "absence-tagged-option-records-through-stored-signatures",
    `
    interface Region { minX: number; }
    interface Pipeline {
        refreshOnly(baseDirty?: Region | null): string;
        refreshAndDecor(opts?: { decorations?: boolean; baseDirty?: Region | null }): string;
    }
    function createPipeline(): Pipeline {
        let pending: Region | null | undefined;
        const queue = (dirty: Region | null | undefined): void => {
            if (dirty === undefined || pending === null) return;
            pending = dirty;
        };
        const refreshOnly = (baseDirty?: Region | null): string => {
            queue(baseDirty);
            const taken = pending;
            pending = undefined;
            return taken === undefined ? "none" : taken === null ? "full" : "r" + taken.minX;
        };
        const refreshAndDecor = (opts: { decorations?: boolean; baseDirty?: Region | null } = {}): string => {
            const result = refreshOnly(opts.baseDirty);
            return opts.decorations !== false ? result + "+decor" : result;
        };
        const kick = (): string => refreshAndDecor({ baseDirty: null });
        return { refreshOnly, refreshAndDecor: (opts) => (opts ? refreshAndDecor(opts) : kick()) };
    }
    const roots: Array<typeof createPipeline> = [createPipeline];
    const pipeline = roots[0]!();
    const seen = [pipeline.refreshOnly(), pipeline.refreshAndDecor({ baseDirty: { minX: 3 } }), pipeline.refreshAndDecor(), pipeline.refreshAndDecor({ decorations: false })];
    if (seen.join(",") !== "none,r3+decor,full+decor,none") throw new Error(seen.join(","));
`,
);

check(
    "tuple-spreads-into-class-method-parameters",
    `
    type Pose = readonly [dx: number, dy: number, dz: number, yaw?: number, pivotX?: number, pivotZ?: number];
    type Shift = [number, number, number, number, number, number];
    class Placement {
        dx = 0; dy = 0; dz = 0; yaw = 0; pivotX = 0; pivotZ = 0;
        set(dx: number, dy: number, dz: number, yaw = 0, pivotX = 0, pivotZ = 0): boolean {
            if (dx === this.dx && dy === this.dy && dz === this.dz && yaw === this.yaw && pivotX === this.pivotX && pivotZ === this.pivotZ) return false;
            this.dx = dx; this.dy = dy; this.dz = dz; this.yaw = yaw; this.pivotX = pivotX; this.pivotZ = pivotZ;
            return true;
        }
    }
    const gate = new Float32Array([1, 0]);
    const current = new Placement();
    const base = new Placement();
    const shift: Shift = [1, 2, 3, 4, 5, 6];
    const zero: Shift = [0, 0, 0, 0, 0, 0];
    const bases = new Map<number, Shift>();
    if (!current.set(...shift) || current.set(...shift)) throw new Error("fixed lanes");
    base.set(...(bases.get(1) ?? zero));
    bases.set(1, [9, 8, 7, 6, 5, 4]);
    base.set(...(bases.get(1) ?? zero));
    const offset = (wide: boolean): Pose => (wide ? shift : [7, 8, 9]);
    const render = new Placement();
    render.set(...offset(gate[1]! > 0));
    if (current.yaw !== 4 || base.pivotZ !== 4 || render.dz !== 9 || render.yaw !== 0 || render.pivotZ !== 0) throw new Error("spread lanes");
    render.set(...offset(gate[0]! > 0));
    if (render.pivotZ !== 6 || render.yaw !== 4) throw new Error("present optional lanes");
    let extra = 0;
    const lanes = (): Shift => { extra++; return shift; };
    render.set(1, ...lanes());
    if (extra !== 1 || render.dx !== 1 || render.dy !== 1 || render.pivotZ !== 5) throw new Error("leading argument then lanes");
`,
);

check(
    "optional-receivers-typed-present-and-runtime-tuple-loops",
    `
    interface Control { u: number; y?: number; }
    interface Curve { controls?: readonly { u?: unknown; y?: unknown }[]; }
    const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    function sanitize(value: unknown): Control[] {
        if (!Array.isArray(value)) return [];
        const parsed: Control[] = [];
        for (let index = 0; index < value.length; index++) {
            const raw = value[index] as { u?: unknown; y?: unknown };
            const u = finite(raw.u);
            if (u === undefined) continue;
            const y = finite(raw.y);
            parsed.push(y === undefined ? { u } : { u, y });
        }
        return parsed;
    }
    const normalize = (curve: Curve): number => sanitize(curve.controls).length;
    const curves: Curve[] = [{ controls: [{ u: 1, y: 2 }, { u: "x" }, { u: 3 }] }, {}];
    if (curves.map(normalize).join(",") !== "2,0") throw new Error("narrowed optional receiver");
    const counts = (rows: readonly { readonly id?: number }[] | undefined): Map<number, number> => {
        const out = new Map<number, number>();
        if (!Array.isArray(rows)) return out;
        for (const row of rows) if (typeof row?.id === "number") out.set(row.id, (out.get(row.id) ?? 0) + 1);
        return out;
    };
    const world: { props?: readonly { readonly id?: number }[] }[] = [{ props: [{ id: 2 }, {}, { id: 2 }] }, {}];
    if (world.map((each) => counts(each.props).get(2) ?? 0).join(",") !== "2,0") throw new Error("narrowed optional iteration");
    function endInset(width: number, heights: readonly [bottom: number, top: number] = [-0.5, 0]): number[] {
        return [-width / 2, width / 2].map((across) => {
            let inset = 0;
            for (const height of heights) inset = Math.max(inset, across * height);
            return inset;
        });
    }
    const insets: Array<typeof endInset> = [endInset];
    if (insets[0]!(4).join(",") !== "1,0" || insets[0]!(2, [2, 3]).join(",") !== "0,3") throw new Error("tuple loop");
`,
);

check(
    "record-tuple-fields-entering-number-arrays-take-array-storage",
    `
    type Vec4 = [number, number, number, number];
    type Vec3 = [number, number, number];
    interface Params { hs: number; bump: number; sunDir: Vec3; }
    function pack(p: Params): { uParams0: Vec4; uSunDir: Vec3 } {
        return { uParams0: [p.hs, p.bump, 0, 1], uSunDir: p.sunDir };
    }
    const uploaded: string[] = [];
    const kept: number[][] = [];
    function upload(name: string, value: number | number[]): void {
        if (typeof value !== "number") kept.push(value);
        uploaded.push(name + ":" + (typeof value === "number" ? value : value.join("/")));
    }
    function setParameters(params: Params, scale?: number): void {
        const packed = pack(params);
        for (const [name, value] of Object.entries(packed)) upload(name, value);
        upload("uScale", scale ?? 1);
    }
    const roots: Array<typeof setParameters> = [setParameters];
    const params: Params = { hs: 2, bump: 3, sunDir: [0, 1, 0] };
    roots[0]!(params);
    if (uploaded.join(",") !== "uParams0:2/3/0/1,uSunDir:0/1/0,uScale:1") throw new Error(uploaded.join(","));
    kept[1]!.push(7);
    if (params.sunDir.length !== 4 || kept[1] !== params.sunDir) throw new Error("one growable array");
`,
);

test("absence tags, spread lanes and tuple storage refuse what no storage represents", () => {
    for (const [source, message] of [
        [
            "interface R { x: number } const gate = new Float32Array([1]); function pick(i: number): R | null | undefined { return i > 0 ? { x: 1 } : i < 0 ? null : undefined; } const roots: Array<typeof pick> = [pick]; let p: R | null | undefined = roots[0]!(gate[0]!); if (p === null) throw new Error('null');",
            /stored where they are told apart only once one of them is ruled out/,
        ],
        [
            "class Placement { x = 0; set(a: number, b = 0): void { this.x = a + b; } } const numbers: number[] = [1, 2]; const placement = new Placement(); placement.set(...numbers);",
            /A spread argument of a class method expands a tuple of a fixed length/,
        ],
        [
            "function grow(t: [number, number]): number { const a: number[] = t; a.push(1); return a.length; } const roots: Array<typeof grow> = [grow]; if (roots[0]!([1, 2]) !== 3) throw new Error('grow');",
            /A fixed-length tuple stored as a number array could grow through that array/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "nullish-fallbacks-that-never-complete-or-are-null",
    `
    interface Geometry { name: string; size: number; }
    const names = ["a", "b"] as const;
    function failMissing(name: string): never { throw new Error("missing " + name); }
    function load(bundle: Map<string, Geometry>): Geometry[] {
        return names.map((name) => bundle.get(name) ?? failMissing(name));
    }
    const bundle = new Map<string, Geometry>([["a", { name: "a", size: 1 }], ["b", { name: "b", size: 2 }]]);
    const loaded = load(bundle);
    if (loaded[1]!.size !== 2 || loaded[0] !== bundle.get("a")) throw new Error("present results");
    let threw = "";
    try { load(new Map([["a", { name: "a", size: 1 }]])); } catch (error) { threw = (error as Error).message; }
    if (threw !== "missing b") throw new Error("never fallback " + threw);
    const counts = new Map<string, number>([["x", 0]]);
    const zero = counts.get("x") ?? failMissing("x");
    if (zero !== 0) throw new Error("falsy present number");
    interface Controls { pip?: () => { reading: string } | null; }
    const read = (controls: Controls): string => {
        const pip = controls.pip?.() ?? null;
        return String(pip === null) + String(pip === undefined);
    };
    const controls: Controls[] = [{}, { pip: () => null }, { pip: () => ({ reading: "rain" }) }];
    const roots: Array<typeof read> = [read];
    if (controls.map((each) => roots[0]!(each)).join(",") !== "truefalse,truefalse,falsefalse") throw new Error("null fallback");
    const slots: (Geometry | null)[] = [null];
    const missing = slots[3] ?? null;
    if (missing !== null || (slots[0] ?? undefined) !== undefined) throw new Error("fallback absence");
`,
);

check(
    "tuple-lanes-and-readonly-number-array-slots",
    `
    type Kind = "workshop" | "castle";
    interface Facts { run: number; }
    interface Home { id: number; workshop: Facts | null; castle: Facts | null; }
    const rows: string[] = [];
    function collect(list: readonly Home[]): void {
        for (const home of list) {
            const retained: readonly (readonly [Kind, number | null])[] = [
                ["workshop", home.workshop?.run ?? null],
                ["castle", home.castle?.run ?? null],
            ];
            for (const [kind, run] of retained) {
                if (run === null || !Number.isSafeInteger(run) || run < 0) continue;
                rows.push(kind + run);
            }
        }
    }
    collect([{ id: 1, workshop: { run: 2 }, castle: null }, { id: 2, workshop: null, castle: { run: -1 } }]);
    if (rows.join(",") !== "workshop2") throw new Error(rows.join(","));
    const ranked = [{ run: 2, settled: false }, { run: 1, settled: false }, { run: 2, settled: true }];
    ranked.sort((a, b) => a.run - b.run || Number(b.settled) - Number(a.settled));
    if (ranked.map((row) => row.run + String(row.settled)).join(",") !== "1false,2true,2false") throw new Error("Number(boolean)");
    type Vec3 = readonly [number, number, number];
    function aim(position: Vec3, lookAt: Vec3 | null = null): readonly number[] {
        let target: readonly number[];
        if (lookAt) {
            target = lookAt;
        } else {
            target = [position[0] + 1, position[1], position[2]];
        }
        return target;
    }
    const fixed: Vec3 = [9, 9, 9];
    if (aim([1, 2, 3])[0] !== 2 || aim([1, 2, 3], fixed) !== fixed || aim([1, 2, 3], fixed).length !== 3) throw new Error("readonly target");
    interface Decl { name: string; value?: number | readonly number[]; }
    function decls(cloud: readonly [number, number, number, number] = [0, 0, 0, 0]): Decl[] {
        return [{ name: "a", value: 1 }, { name: "cloud", value: cloud }];
    }
    const cloud: [number, number, number, number] = [1, 2, 3, 4];
    const made = decls(cloud);
    cloud[0] = 5;
    if ((made[1]!.value as readonly number[])[0] !== 5 || (decls()[1]!.value as readonly number[])[3] !== 0) throw new Error("readonly field");
`,
);

check(
    "paired-absence-tests-inside-longer-chains",
    `
    const gate = new Float32Array([0, 1]);
    interface Bounds { x: number }
    interface Opts { linked?: Bounds | null; current: boolean }
    const all: Opts[] = [{ linked: { x: 2 }, current: true }, { linked: null, current: true }, { current: false }];
    const ready = gate[1]! > 0;
    let present = 0;
    let missing = 0;
    for (const opts of all) {
        if (ready && opts.linked !== null && opts.linked !== undefined) present += opts.linked.x;
        if (!ready || opts.linked === null || opts.linked === undefined) missing++;
        if (opts.current && opts.linked !== undefined && opts.linked !== null && ready) present += 10;
    }
    if (present !== 12 || missing !== 2) throw new Error("chained pairs " + present + " " + missing);
    const pick = (opts: Opts): boolean => ready && opts.linked !== null && opts.linked !== undefined;
    if (!pick(all[0]!) || pick(all[1]!) || pick(all[2]!)) throw new Error("chained pair value");
`,
);

check(
    "typed-conditional-spread-optional-fields",
    `
    const gate = new Float32Array([0, 1]);
    interface Frame { x: number }
    interface Spec { value: number; scrub?: string; onCommit?: () => void; frame?: Frame }
    const keep: Spec = { value: 0, frame: { x: 1 } };
    const specs: Spec[] = [keep];
    specs.push({ value: 2, ...(gate[1]! > 0 ? { scrub: "x" } : {}) });
    const kept: Spec = { value: 3, scrub: "a", ...(gate[0]! > 0 ? { scrub: "b" } : {}) };
    const replaced: Spec = { value: 3, scrub: "a", ...(gate[1]! > 0 ? { scrub: "b" } : {}) };
    if (specs[1]!.scrub !== "x" || specs[1]!.onCommit !== undefined || specs[1]!.frame !== undefined)
        throw new Error("absent optional fields");
    if (kept.scrub !== "a" || replaced.scrub !== "b") throw new Error("typed spread override");
`,
);

check(
    "math-constants-and-members",
    `
    const ln2 = Math.LN2;
    const read = [Math.E, Math.LN2, Math.LN10, Math.LOG2E, Math.LOG10E, Math.SQRT2, Math.SQRT1_2, Math.PI];
    const spelled = [2.718281828459045, 0.6931471805599453, 2.302585092994046, 1.4426950408889634,
        0.4342944819032518, 1.4142135623730951, 0.7071067811865476, 3.141592653589793];
    for (let index = 0; index < read.length; ++index)
        if (read[index] !== spelled[index]) throw new Error("constant " + index);
    const lanes = new Float32Array(2);
    lanes[0] = Math.E;
    lanes[1] = Math.LOG10E * 2;
    if (lanes[0] !== Math.fround(2.718281828459045) || lanes[1] !== Math.fround(0.8685889638065036)) throw new Error("float sink");
    function bits(value: number): number { return Math.log(2 ** value) / ln2; }
    if (Math.abs(bits(8) - 8) > 1e-12) throw new Error("module constant");
    const xs = new Float64Array([0, -0, -1, Infinity, -Infinity, NaN, 1000, 1, -2, 1e-10]);
    if (!Object.is(Math.log1p(xs[1]!), -0) || Math.log1p(xs[2]!) !== -Infinity || !Number.isNaN(Math.log1p(xs[8]!)))
        throw new Error("log1p edges");
    if (Math.abs(Math.log1p(xs[9]!) - 9.9999999995e-11) > 1e-24 || Math.log1p(xs[3]!) !== Infinity) throw new Error("log1p");
    if (Math.expm1(xs[0]!) !== 0 || !Object.is(Math.expm1(xs[1]!), -0) || Math.expm1(xs[4]!) !== -1 || Math.expm1(xs[3]!) !== Infinity)
        throw new Error("expm1 edges");
    if (Math.abs(Math.expm1(xs[9]!) - 1.00000000005e-10) > 1e-24) throw new Error("expm1");
    if (Math.log10(xs[6]!) !== 3 || Math.cosh(xs[0]!) !== 1 || Math.tanh(xs[3]!) !== 1 || !Object.is(Math.asinh(xs[1]!), -0) ||
        Math.acosh(xs[7]!) !== 0 || Math.atanh(xs[7]!) !== Infinity || !Number.isNaN(Math.acosh(xs[0]!)))
        throw new Error("hyperbolic");
    if (Math.abs(Math.sinh(xs[7]!) - 1.1752011936438014) > 1e-15 || Math.abs(Math.atanh(0.5) - 0.5493061443340548) > 1e-15)
        throw new Error("hyperbolic values");
    const mapped = [xs[0]!, xs[7]!].map(Math.log1p);
    if (mapped[0] !== 0 || Math.abs(mapped[1]! - Math.LN2) > 1e-15) throw new Error("member as callback");
`,
);

check(
    "string-searches-with-utf16-positions",
    `
    const words = ["a/b/c", "\\u00e9/\\u00fc/\\u20ac", "x\\ud83d\\ude00y\\ud83d\\ude00z"];
    const s = words[0]!, u = words[1]!, e = words[2]!;
    if (s.indexOf("/", 2) !== 3 || s.indexOf("/", -5) !== 1 || s.indexOf("/", NaN) !== 1 || s.indexOf("/", Infinity) !== -1 ||
        s.indexOf("", 99) !== 5 || s.indexOf("c", 4.9) !== 4) throw new Error("indexOf position");
    if (s.lastIndexOf("/") !== 3 || s.lastIndexOf("/", 2) !== 1 || s.lastIndexOf("/", -1) !== -1 || s.lastIndexOf("a", -1) !== 0 ||
        s.lastIndexOf("/", NaN) !== 3 || s.lastIndexOf("") !== 5 || s.lastIndexOf("", 2) !== 2 || s.lastIndexOf("x") !== -1)
        throw new Error("lastIndexOf");
    if (u.indexOf("/") !== 1 || u.indexOf("\\u00fc", 1) !== 2 || u.lastIndexOf("/") !== 3 || u.indexOf("\\u20ac") !== 4 ||
        u.lastIndexOf("/", 2) !== 1) throw new Error("non-ASCII indices");
    if (e.indexOf("y") !== 3 || e.lastIndexOf("\\ud83d\\ude00") !== 4 || e.indexOf("\\ud83d\\ude00", 2) !== 4 ||
        !e.includes("z", 6) || e.includes("y", 4) || e.indexOf("\\ude00") !== 2) throw new Error("surrogate indices");
    if (!s.startsWith("b", 2) || !s.startsWith("a", -3) || s.startsWith("c", 99) || !s.startsWith("", 99) ||
        !e.startsWith("y", 3) || !u.startsWith("\\u00fc", 2) || e.startsWith("y", 2)) throw new Error("startsWith position");
    if (!s.endsWith("b", 3) || !s.endsWith("a", 1) || !s.endsWith("c", 99) || s.endsWith("a", -1) || !s.endsWith("", -1) ||
        !e.endsWith("y", 4) || !u.endsWith("\\u00e9", 1) || s.endsWith("c", NaN)) throw new Error("endsWith position");
    function find(text: string, at?: number): number { return text.indexOf("/", at); }
    function ends(text: string, end?: number): boolean { return text.endsWith("b", end); }
    function last(text: string, at?: number): number { return text.lastIndexOf("/", at); }
    function starts(text: string, at?: number): boolean { return text.startsWith("a", at); }
    if (find(s) !== 1 || find(s, 2) !== 3 || ends(s) || !ends(s, 3) || last(s) !== 3 || last(s, 0) !== -1 || !starts(s) || starts(s, 1))
        throw new Error("optional positions");
    let log = "";
    function receiver(): string { log += "r"; return "a/b"; }
    function needle(): string { log += "s"; return "/"; }
    function position(): number { log += "p"; return 0; }
    if (receiver().indexOf(needle(), position()) !== 1 || log !== "rsp") throw new Error("evaluation order " + log);
    log = "";
    if (!receiver().endsWith(needle(), position() + 2) || log !== "rsp") throw new Error("endsWith order " + log);
`,
);

check(
    "string-searches-over-wtf8-storage",
    `
    const texts = ["a\\u00e9\\u20ac\\ud83d\\ude00b\\ud83d\\ude00", "x\\ud83dy\\ude00z", "\\ud83d\\ude00", "\\ud83d", "\\ude00"];
    const t = texts[0]!, lone = texts[1]!, pair = texts[2]!, high = texts[3]!, low = texts[4]!;
    // t's UTF-16 units: a é € H L b H L.
    if (t.length !== 8 || t.indexOf("b") !== 5 || t.indexOf("\\ud83d\\ude00") !== 3 || t.indexOf("\\ud83d\\ude00", 4) !== 6 ||
        t.indexOf("\\ud83d\\ude00", 3) !== 3 || t.indexOf("", 4) !== 4 || t.indexOf("", 99) !== 8 || t.indexOf("\\u20ac", -3) !== 2 ||
        t.indexOf("b", NaN) !== 5 || t.indexOf("a", Infinity) !== -1 || t.indexOf("\\u00e9", 1.7) !== 1 || t.indexOf("\\u00e9\\u20ac") !== 1)
        throw new Error("indexOf");
    if (t.includes("b", 6) || !t.includes("\\ud83d\\ude00", 4) || t.includes("\\ud83d\\ude00", 7) || !t.includes("", 99) ||
        !t.includes("a", -Infinity) || !t.includes("\\u20ac") || t.includes("c"))
        throw new Error("includes");
    if (t.lastIndexOf("\\ud83d\\ude00") !== 6 || t.lastIndexOf("\\ud83d\\ude00", 7) !== 6 || t.lastIndexOf("\\ud83d\\ude00", 5) !== 3 ||
        t.lastIndexOf("\\ud83d\\ude00", 4) !== 3 || t.lastIndexOf("\\ud83d\\ude00", 2) !== -1 || t.lastIndexOf("", 4) !== 4 ||
        t.lastIndexOf("", 99) !== 8 || t.lastIndexOf("") !== 8 || t.lastIndexOf("b", NaN) !== 5 || t.lastIndexOf("a", -Infinity) !== 0 ||
        t.lastIndexOf("\\u20ac", 2) !== 2 || t.lastIndexOf("\\u20ac", 1) !== -1)
        throw new Error("lastIndexOf");
    if (!t.startsWith("\\ud83d\\ude00", 3) || !t.startsWith("", 4) || t.startsWith("b", 4) || !t.startsWith("\\u00e9\\u20ac", 1) ||
        !t.startsWith("a", NaN) || t.startsWith("b", Infinity) || !t.startsWith("", Infinity) || !t.startsWith("b", 5) ||
        !t.startsWith("a") || t.startsWith("\\u00e9"))
        throw new Error("startsWith");
    if (!t.endsWith("\\ud83d\\ude00") || !t.endsWith("\\u20ac", 3) || !t.endsWith("", 4) || t.endsWith("\\u20ac", 4) ||
        !t.endsWith("b", 6) || t.endsWith("a", NaN) || !t.endsWith("", NaN) || !t.endsWith("\\ud83d\\ude00", Infinity) ||
        t.endsWith("a", -1) || !t.endsWith("\\ud83d\\ude00b", 6) || t.endsWith("b"))
        throw new Error("endsWith");
    // A needle holding a lone surrogate matches one half of a pair.
    if (t.indexOf(low) !== 4 || t.lastIndexOf(high) !== 6 || t.indexOf(high, 4) !== 6 || !t.includes(low, 5) ||
        t.lastIndexOf(low, 6) !== 4 || !t.startsWith(low, 4) || !t.endsWith(high, 4) || !t.endsWith(low) || t.startsWith(high, 4) ||
        t.indexOf(low + "b") !== 4 || t.indexOf("\\u20ac" + high) !== 2 || t.lastIndexOf(low + "b", 99) !== 4)
        throw new Error("lone surrogate needles");
    // Lone surrogates in the receiver are single code units.
    if (lone.length !== 5 || lone.indexOf("y") !== 2 || lone.indexOf(high) !== 1 || lone.lastIndexOf(low + "z") !== 3 ||
        !lone.endsWith(low + "z") || !lone.startsWith(high + "y", 1) || lone.includes("\\ud83d\\ude00") || lone.indexOf("z", 3) !== 4 ||
        lone.indexOf("z", 5) !== -1 || lone.lastIndexOf("x", 1) !== 0 || !lone.includes(low, 3) || lone.includes(low, 4))
        throw new Error("lone surrogate receiver");
    if (pair.indexOf(high) !== 0 || pair.indexOf(low) !== 1 || pair.lastIndexOf(low) !== 1 || !pair.startsWith(high) ||
        !pair.endsWith(low) || pair.indexOf("", 1) !== 1 || pair.lastIndexOf("", 1) !== 1 || pair.endsWith(high) ||
        !pair.endsWith(high, 1) || pair.startsWith(low) || !pair.startsWith(low, 1) || pair.includes("x"))
        throw new Error("pair halves");
    // Concatenated halves are one pair.
    const joined = high + low;
    if (joined.length !== 2 || joined.indexOf("\\ud83d\\ude00") !== 0 || joined !== pair || !t.includes(joined, 6))
        throw new Error("joined pair");
    // A null position reads as 0; undefined reads as the method's absent position.
    const none: number | null = texts.length > 9 ? 1 : null;
    // @ts-expect-error null is outside the declared position type
    if (t.lastIndexOf("a", none) !== 0 || t.lastIndexOf("b", null) !== -1 || t.endsWith("b", none) || !t.endsWith("", none) ||
        // @ts-expect-error null is outside the declared position type
        t.indexOf("b", none) !== 5 || !t.startsWith("a", none) || !t.includes("a", null))
        throw new Error("null positions");
    function ends(text: string, end?: number): boolean { return text.endsWith("\\ud83d\\ude00", end); }
    function last(text: string, at?: number): number { return text.lastIndexOf("\\ud83d\\ude00", at); }
    function has(text: string, at?: number): boolean { return text.includes("\\ud83d\\ude00", at); }
    if (!ends(t) || ends(t, 4) || !ends(t, 5) || last(t) !== 6 || last(t, 4) !== 3 || !has(t) || has(t, 7) || !has(t, 4))
        throw new Error("optional positions");
    let log = "";
    function receiver(): string { log += "r"; return "a/b"; }
    function needle(): string { log += "s"; return "/"; }
    if (!receiver().includes(needle()) || log !== "rs") throw new Error("includes order " + log);
    log = "";
    if (receiver().lastIndexOf(needle()) !== 1 || log !== "rs") throw new Error("lastIndexOf order " + log);
`,
);

check(
    "defaulted-number-arguments-read-null-as-zero",
    `
    const gate = new Float32Array([0, 1]);
    const text = "abcabc";
    const none: number | null = gate[1]! > 0 ? null : 2;
    const omitted: number | undefined = gate[1]! > 0 ? undefined : 2;
    // @ts-expect-error a null position is ToNumber(null), 0
    if (text.lastIndexOf("b", none) !== -1 || text.lastIndexOf("a", none) !== 0) throw new Error("lastIndexOf null");
    // @ts-expect-error a null position is ToNumber(null), 0
    if (text.indexOf("b", none) !== 1 || text.endsWith("c", none) || !text.startsWith("a", none)) throw new Error("null positions");
    if (text.lastIndexOf("b", omitted) !== 4 || text.indexOf("b", omitted) !== 1 || !text.endsWith("c", omitted))
        throw new Error("undefined positions");
    if (text.lastIndexOf("b", undefined) !== 4) throw new Error("undefined literal position");
    const loose: number | null | undefined = gate[0]! > 0 ? 3 : undefined;
    // @ts-expect-error null and undefined both read 0 here
    if (text.indexOf("c", loose) !== 2) throw new Error("indexOf either absence");
    const table: Record<string, number | null> = { a: null };
    const key = gate[1]! > 0 ? "a" : "b";
    // @ts-expect-error a stored null and a missing entry both read 0 here
    if (text.indexOf("b", table[key]) !== 1 || text.indexOf("b", table[key + "z"]) !== 1) throw new Error("indexOf lookups");
    const buffer = new ArrayBuffer(8);
    // @ts-expect-error a null byte offset is ToIndex(null), 0
    if (new Uint8Array(buffer, none).length !== 8 || new Uint8Array(buffer, omitted).length !== 8) throw new Error("byte offsets");
`,
);

test("a defaulted number argument refuses storage that cannot tell null from undefined", () => {
    assert.throws(
        () =>
            compileSource(
                'const g = new Float32Array([1]); const r: Record<string, number | null> = { a: null }; const key = g[0]! > 0 ? "a" : "b"; // @ts-expect-error\nconst i = "ab".lastIndexOf("b", r[key]);',
            ),
        /requires distinguishable null and undefined storage/,
    );
});

check(
    "string-from-code-point",
    `
    const codes = [65, 0x1f600, 0xd83d, 0xde00, 0xd800];
    const text = String.fromCodePoint(codes[0]!, codes[1]!, codes[2]!, codes[3]!);
    if (text !== "A\\ud83d\\ude00\\ud83d\\ude00" || text.length !== 5) throw new Error("code points");
    const lone = String.fromCodePoint(codes[4]!);
    if (lone.length !== 1 || lone.charCodeAt(0) !== 0xd800 || String.fromCodePoint() !== "") throw new Error("lone surrogate");
    const invalid = [-1, 1.5, NaN, 0x110000, Infinity];
    let refused = 0;
    for (const value of invalid) {
        try { String.fromCodePoint(value); } catch (error) { if (error instanceof RangeError) refused++; }
    }
    if (refused !== invalid.length) throw new Error("range " + refused);
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
    "date-utc-fields-and-date-utc",
    `
    const times = [0, -1, 951782400000, 8.64e15, -8.64e15, 1700000000123, -62198755200000];
    for (const time of times) {
        const date = new Date(time);
        const rebuilt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(),
            date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
        if (rebuilt !== time) throw new Error("round trip " + time);
    }
    const before = new Date(times[1]!);
    if (before.getUTCFullYear() !== 1969 || before.getUTCMonth() !== 11 || before.getUTCDate() !== 31 || before.getUTCDay() !== 3 ||
        before.getUTCHours() !== 23 || before.getUTCMinutes() !== 59 || before.getUTCSeconds() !== 59 || before.getUTCMilliseconds() !== 999)
        throw new Error("fields before the epoch");
    const leap = new Date(times[2]!), first = new Date(times[4]!);
    if (leap.getUTCMonth() !== 1 || leap.getUTCDate() !== 29 || leap.getUTCDay() !== 2 || first.getUTCFullYear() !== -271821 ||
        first.getUTCMonth() !== 3 || first.getUTCDate() !== 20 || first.getUTCDay() !== 2) throw new Error("calendar fields");
    const invalid = new Date(NaN);
    if (!Number.isNaN(invalid.getUTCFullYear()) || !Number.isNaN(invalid.getUTCDay())) throw new Error("invalid date");
    const years = [99, -1, 275760, 1e6, NaN];
    if (Date.UTC(years[0]!, 0) !== Date.UTC(1999, 0) || Date.UTC(years[1]!, 0) !== -62198755200000 ||
        Date.UTC(years[2]!, 8, 13) !== 8.64e15 || !Number.isNaN(Date.UTC(years[2]!, 8, 13, 0, 0, 0, 1)) ||
        !Number.isNaN(Date.UTC(years[3]!, 0)) || !Number.isNaN(Date.UTC(years[4]!)))
        throw new Error("Date.UTC years");
    if (Date.UTC(2020, 13, 1) !== Date.UTC(2021, 1, 1) || Date.UTC(2020, -1, 1) !== Date.UTC(2019, 11, 1) ||
        Date.UTC(2020, 0, 1, 25) !== Date.UTC(2020, 0, 2, 1) || Date.UTC(1970, 0, 1, 0, 0, 0, 0.9) !== 0 ||
        Date.UTC(2020) !== 1577836800000 || Date.UTC(1970, 0, 2) !== 86400000) throw new Error("Date.UTC fields");
`,
);

check(
    "element-reads-of-absent-receivers",
    `
    interface Control { u: number; lat?: number }
    interface Options { size: number; controls?: readonly Control[]; extra?: Float32Array }
    function lateral(controls: readonly Control[] | undefined): number {
        let sum = 0;
        for (let i = 0; i < (controls?.length ?? 0); i++) {
            const control = controls![i]!;
            if (control.lat === undefined) continue;
            sum += control.lat * control.u;
        }
        return sum;
    }
    function pack(options: Options): number[] {
        const out: number[] = [];
        for (let i = 0; i < options.size; i++) out.push(options.extra?.[i] ?? -1);
        return out;
    }
    const plain: Options = { size: 2 };
    if (lateral(plain.controls) !== 0 || pack(plain).join() !== "-1,-1") throw new Error("absent optional reads");
    let reads = 0;
    function index(): number { reads++; return 0; }
    function optionalRead(options: { list?: number[] }): number | undefined { return options.list?.[index()]; }
    function assertedRead(options: { list?: number[] }): number { return options.list![index()]!; }
    if (optionalRead({}) !== undefined || reads !== 0) throw new Error("optional index short-circuits");
    let threw = false;
    try { assertedRead({}); } catch (error) { threw = error instanceof TypeError; }
    if (!threw || reads !== 1) throw new Error("asserted read evaluates its key, then throws");
`,
);

check(
    "delete-struct-fields-by-known-key",
    `
    interface Style { tint?: number; label?: string; scale?: number; size: number }
    const setNumber = <T extends object, K extends keyof T>(target: T, key: K, value: number | undefined): void => {
        if (value === undefined) delete target[key];
        else target[key] = value as T[K];
    };
    const setTint = (target: { tint?: number }, key: "tint", value: number | null): void => {
        if (value) target[key] = value;
        else delete target[key];
    };
    const style: Style = { tint: 1, label: "a", scale: 2, size: 3 };
    const inputs = [undefined, 4];
    setNumber(style, "scale", inputs[0]);
    setTint(style, "tint", null);
    delete style["label"];
    if ("scale" in style || "tint" in style || "label" in style || style.size !== 3) throw new Error("deleted fields");
    if (Object.keys(style).join() !== "size" || JSON.stringify(style) !== '{"size":3}') throw new Error("own keys after delete");
    setNumber(style, "scale", inputs[1]);
    setTint(style, "tint", 5);
    if (style.scale !== 4 || style.tint !== 5) throw new Error("restored fields");
`,
);

check(
    "object-rest-copies-nullable-optional-fields",
    `
    interface Entry { id: number; note?: string | null; tint?: number }
    const entries: Entry[] = [{ id: 1, note: null }, { id: 2 }, { id: 3, note: "x", tint: 4 }];
    let text = "";
    for (const entry of entries) {
        const { id, ...rest } = entry;
        text += id + (rest.note ?? "-") + (rest.tint ?? 0) + ";";
    }
    if (text !== "1-0;2-0;3x4;") throw new Error(text);
`,
);

check(
    "object-assign-copies-own-optional-struct-fields",
    `
    interface Mix { amount?: number; material?: string; tint?: [number, number, number] }
    function copy(source: Readonly<Mix>): Mix {
        return {
            ...(source.amount !== undefined ? { amount: source.amount } : {}),
            ...(source.material !== undefined ? { material: source.material } : {}),
            ...(source.tint ? { tint: [...source.tint] as [number, number, number] } : {}),
        };
    }
    function replace(target: Mix, source: Readonly<Mix>): void {
        const next = copy(source);
        delete target.amount; delete target.material; delete target.tint;
        Object.assign(target, next);
    }
    const target: Mix = { amount: 1, tint: [1, 2, 3] };
    replace(target, { material: "stone" });
    if (target.amount !== undefined || target.material !== "stone" || "tint" in target) throw new Error("replaced fields");
    if (Object.keys(target).join() !== "material") throw new Error("own keys " + Object.keys(target).join());
    let reads = 0;
    function source(): Mix { reads++; return { amount: 7, tint: [4, 5, 6] }; }
    Object.assign(target, source());
    if (reads !== 1 || target.amount !== 7 || target.material !== "stone" || target.tint![2] !== 6) throw new Error("source read once");
    interface Door { kind: string; y?: number }
    function commit(existing: Door, candidate: Door): Door {
        Object.assign(existing, candidate);
        if (candidate.y === undefined) delete existing.y;
        return existing;
    }
    const doors: Door[] = [{ kind: "a", y: 3 }, { kind: "b" }];
    const door = commit(doors[0]!, doors[1]!);
    if (door !== doors[0] || door.kind !== "b" || "y" in door) throw new Error("door commit");
`,
);

check(
    "object-entries-of-documents-and-dictionaries",
    `
    function strings(raw: unknown): Record<string, string> {
        const p: Record<string, string> = {};
        if (!raw || typeof raw !== "object") return p;
        const fact = raw as { p?: unknown };
        if (fact.p && typeof fact.p === "object") {
            for (const [k, v] of Object.entries(fact.p)) if (typeof v === "string") p[k] = v;
        }
        return p;
    }
    const doc = JSON.parse('{"p":{"b":"x","2":"two","a":1}}') as unknown;
    const read = strings(doc);
    if (Object.keys(read).join() !== "2,b" || read["b"] !== "x" || read["2"] !== "two") throw new Error("document entries");
    interface State { issue: number; lastUsed: Record<string, number> }
    function counts(raw: unknown): Record<string, number> {
        const state = raw as Partial<Record<keyof State, unknown>> | undefined;
        const out: Record<string, number> = {};
        if (!state || !state.lastUsed || typeof state.lastUsed !== "object") return out;
        for (const [id, n] of Object.entries(state.lastUsed)) if (Number.isFinite(n)) out[id] = n as number;
        return out;
    }
    const used: Record<string, number> = {};
    used["z"] = 2;
    used["a"] = Number.NaN;
    used["1"] = 5;
    const saved: State = { issue: 1, lastUsed: used };
    const restored = counts(saved);
    if (Object.keys(restored).join() !== "1,z" || restored["z"] !== 2) throw new Error("dictionary entries " + Object.keys(restored).join());
    function digest(table: Readonly<Record<string, unknown>>): string {
        const fields: string[] = [];
        for (const [name, value] of Object.entries(table)) if (typeof value === "number") fields.push(name + "=" + value);
        return fields.sort().join(";");
    }
    if (digest(used) !== "1=5;a=NaN;z=2") throw new Error("unknown-valued entries " + digest(used));
`,
);

check(
    "record-lookup-with-document-key",
    `
    const SIGN: Record<string, number> = { door: -1, "2": 5 };
    function sign(raw: unknown): number {
        const node = raw as { name: string };
        return SIGN[node.name] ?? 1;
    }
    const nodes = JSON.parse('[{"name":"door"},{"name":"pane"},{"name":2},{}]') as unknown[];
    const signs = nodes.map(sign);
    if (signs.join() !== "-1,1,5,1") throw new Error("document keys " + signs.join());
`,
);

check(
    "branded-primitives-are-their-primitive",
    `
    type SourceId = string & { readonly __source: unique symbol };
    type Meters = number & { readonly __unit: "m" };
    interface Row { source: SourceId; cycle: number; length: Meters }
    function source(id: string): SourceId { return id as SourceId; }
    const rows = new Map<number, Row>();
    rows.set(1, { source: source("well"), cycle: 2, length: 3 as Meters });
    const row = rows.get(1)!;
    const ids = new Set<SourceId>([row.source]);
    if (row.source !== "well" || row.source.length !== 4 || !ids.has(source("well")) || row.length + 1 !== 4)
        throw new Error("branded values");
`,
);

check(
    "object-spread-of-a-narrowed-union-member",
    `
    type Policy = "durable" | "fresh";
    interface Portion { kind: string; nutrition: number; policy: Policy; expires: number | null }
    function normalize(raw: number | Readonly<Portion>): Portion | null {
        if (typeof raw === "number") return raw > 0 ? { kind: "generic", nutrition: raw, policy: "durable", expires: null } : null;
        if (!(raw.nutrition > 0)) return null;
        const expiry = raw.policy === "durable" ? null : Number.isFinite(raw.expires) && raw.expires! >= 1 ? Math.trunc(raw.expires!) : null;
        if (raw.policy !== "durable" && expiry === null) return null;
        return { ...raw, expires: expiry };
    }
    const inputs: Array<number | Portion> = [2, { kind: "bread", nutrition: 1, policy: "fresh", expires: 3.5 }];
    const first = normalize(inputs[0]!), second = normalize(inputs[1]!);
    if (first?.kind !== "generic" || second?.kind !== "bread" || second.expires !== 3 || second === inputs[1])
        throw new Error("spread member");
    if ((inputs[1] as Portion).expires !== 3.5) throw new Error("spread copies its source");
`,
);

check(
    "map-entry-struct-destructuring",
    `
    interface Host { boundary: { kind: string }; size: number }
    const byKey = new Map<string, { host: Host; count: number }>();
    byKey.set("tower:a", { host: { boundary: { kind: "circle" }, size: 2 }, count: 1 });
    byKey.set("house:b", { host: { boundary: { kind: "rect" }, size: 3 }, count: 5 });
    const seen: string[] = [];
    for (const [key, { host, count: total }] of byKey)
        if (key.startsWith("tower:") || host.boundary.kind === "rect") seen.push(key + "=" + (host.size * total));
    if (seen.join() !== "tower:a=2,house:b=15") throw new Error("entries " + seen.join());
`,
);

check(
    "json-stringify-omits-undefined-record-members",
    `
    interface Row { id: number; note?: string; label: string | undefined; parent: number | null; tags: Array<string | undefined> }
    interface Doc { rows: Row[]; inner: { maybe: number | undefined; nested: { deep?: number; deeper: string | undefined } } }
    const rows: Row[] = [
        { id: 1, label: undefined, parent: null, tags: ["a", undefined] },
        { id: 2, note: "n", label: "x", parent: 3, tags: [] },
    ];
    const doc: Doc = { rows, inner: { maybe: undefined, nested: { deeper: undefined } } };
    const expected = '{"rows":[{"id":1,"parent":null,"tags":["a",null]},{"id":2,"note":"n","label":"x","parent":3,"tags":[]}],"inner":{"nested":{}}}';
    if (JSON.stringify(doc) !== expected) throw new Error("document " + JSON.stringify(doc));
    rows[1]!.label = undefined;
    rows[1]!.note = undefined;
    doc.inner.maybe = 4;
    doc.inner.nested.deeper = "d";
    const changed = '{"rows":[{"id":1,"parent":null,"tags":["a",null]},{"id":2,"parent":3,"tags":[]}],"inner":{"maybe":4,"nested":{"deeper":"d"}}}';
    if (JSON.stringify(doc) !== changed) throw new Error("changed " + JSON.stringify(doc));
    const values: Array<number | undefined> = [1, undefined];
    if (JSON.stringify(values) !== "[1,null]" || JSON.stringify(rows[0]) !== '{"id":1,"parent":null,"tags":["a",null]}')
        throw new Error("arrays keep null");
    const record = { a: 1, b: values[1], c: values[0] };
    if (JSON.stringify(record) !== '{"a":1,"c":1}') throw new Error("record member " + JSON.stringify(record));
    interface Loose { value: unknown; id: number }
    const loose: Loose[] = [{ value: undefined, id: 1 }, { value: JSON.parse("[2]") as unknown, id: 2 }];
    if (JSON.stringify(loose) !== '[{"id":1},{"value":[2],"id":2}]') throw new Error("unknown member " + JSON.stringify(loose));
    class Slot { held: number | undefined = undefined; owner: number | null = null; }
    const slots = [new Slot(), new Slot()];
    slots[1]!.held = 3;
    if (JSON.stringify(slots) !== '[{"owner":null},{"held":3,"owner":null}]') throw new Error("class fields " + JSON.stringify(slots));
`,
);

check(
    "object-literal-key-order-follows-creation",
    `
    const values = [1, 2, 3, 4];
    const name = "n" + values[0], extra = values[1]!, tail = values[2]! > 2;
    const between = { name, ...{ extra }, tail };
    if (JSON.stringify(between) !== '{"name":"n1","extra":2,"tail":true}') throw new Error("between " + JSON.stringify(between));
    if (Object.keys(between).join() !== "name,extra,tail") throw new Error("keys " + Object.keys(between).join());
    const keys: string[] = [];
    for (const key in between) keys.push(key);
    if (keys.join() !== "name,extra,tail") throw new Error("for-in " + keys.join());
    const before = { ...{ extra, tail }, name };
    if (JSON.stringify(before) !== '{"extra":2,"tail":true,"name":"n1"}') throw new Error("before " + JSON.stringify(before));
    const after = { tail, name, ...{ extra } };
    if (JSON.stringify(after) !== '{"tail":true,"name":"n1","extra":2}') throw new Error("after " + JSON.stringify(after));
    const base = { a: values[0]!, b: values[1]! };
    const overwritten = { z: values[3]!, ...base, a: values[2]!, c: 0 };
    if (JSON.stringify(overwritten) !== '{"z":4,"a":3,"b":2,"c":0}' || Object.keys(overwritten).join() !== "z,a,b,c")
        throw new Error("overwritten " + JSON.stringify(overwritten));
    const spreadOver = { a: 0, q: values[0]!, ...base };
    if (JSON.stringify(spreadOver) !== '{"a":1,"q":1,"b":2}') throw new Error("spread overwrite " + JSON.stringify(spreadOver));
    const numeric = { b: 1, ...{ 2: "two", a: 0 }, 1: "one" };
    if (JSON.stringify(numeric) !== '{"1":"one","2":"two","b":1,"a":0}') throw new Error("integer keys " + JSON.stringify(numeric));
    const rows = [between];
    rows.push({ ...between, extra: values[3]! });
    const stored = rows[values[0]!]!;
    const storedKeys: string[] = [];
    for (const key in stored) storedKeys.push(key);
    if (JSON.stringify(rows) !== '[{"name":"n1","extra":2,"tail":true},{"name":"n1","extra":4,"tail":true}]' ||
        Object.keys(stored).join() !== "name,extra,tail" || storedKeys.join() !== "name,extra,tail")
        throw new Error("stored records " + JSON.stringify(rows));
`,
);

test("dynamic object and built-in boundaries refuse explicitly", () => {
    const refusals: Array<[string, RegExp]> = [
        [
            "const codes = [65, 66]; console.log(String.fromCodePoint(...codes));",
            /String\.fromCodePoint takes its code points as separate arguments/,
        ],
        [
            "const parts: [number, number] = [2020, 1]; console.log(Date.UTC(...parts));",
            /Date\.UTC takes a year and up to six numeric fields as separate arguments/,
        ],
        [
            `const s = ["abc"];
            const i = (s[0]! as unknown as { indexOf(a: string, b: number, c: number): number }).indexOf("b", 0, 1);
            console.log(i);`,
            /String\.indexOf expects a search string and an optional position/,
        ],
        [
            `interface S { size: number; tint?: number }
            const clear = <T extends object, K extends keyof T>(t: T, k: K): void => { delete t[k]; };
            const s: S = { size: 1, tint: 2 };
            clear(s, "size");
            console.log(s.size);`,
            /'size' is a required field of its type; only an optional field can be deleted/,
        ],
        [
            `const doc = JSON.parse("{}") as unknown;
            if (doc && typeof doc === "object") {
                const { a, ...rest } = doc as { a?: unknown; b?: unknown };
                console.log(a, rest);
            }`,
            /Object rest over a parsed document is not represented/,
        ],
        [
            `interface M { a?: number; b?: string }
            const ms: M[] = [{ a: 1 }];
            console.log(Object.assign({}, ms[0]!));`,
            /Enumerating a struct with optional properties as a fixed list requires known own keys/,
        ],
        [
            `const names = ["a"]; console.log(/^a/m.test(names[0]!));`,
            /Reached RegExp literals support the g, i and u flags, not 'm'/,
        ],
    ];
    for (const [source, message] of refusals)
        assert.throws(() => compileSource(source), message);
});

check(
    "null-defaults-take-null-and-undefined-arguments",
    `
    interface Claims { n: number }
    function assign(out: number[], claims: Claims | null = null): number { return claims ? claims.n : -1; }
    function filter(xs: number[], keep: ((x: number) => boolean) | null = null): number {
        return keep ? xs.filter(keep).length : -1;
    }
    const stored: Array<typeof assign> = [assign];
    const maybe: Array<Claims | null | undefined> = [undefined, null, { n: 3 }];
    const out: number[] = [];
    for (const m of maybe) out.push(assign(out, m), stored[0]!(out, m));
    const keeps: Array<((x: number) => boolean) | null | undefined> = [undefined, null, (x) => x > 1];
    for (const k of keeps) out.push(filter([1, 2, 3], k));
    if (out.join(",") !== "-1,-1,-1,-1,3,3,-1,-1,2") throw new Error("null default " + out.join(","));
`,
);

check(
    "number-methods-of-numbers-an-asserted-empty-record-lacks",
    `
    interface Env { id: number; fascia: number }
    function sig(env: Env): string {
        return env.id + "," + env.fascia.toFixed(2) + "," + env.fascia.toString() + "," + (env.fascia + 1);
    }
    const envs: Env[] = [{ id: 1, fascia: 0.5 }, {} as Env];
    const out: string[] = [];
    for (const env of envs) {
        try { out.push(sig(env)); } catch (error) { out.push(error instanceof TypeError ? "TypeError" : "other"); }
    }
    if (out.join("|") !== "1,0.50,0.5,1.5|TypeError") throw new Error(out.join("|"));
`,
);

check(
    "calls-typed-never-by-narrowing-still-return",
    `
    interface Item { id: number }
    interface Ev { target: Item | null }
    const ev: Ev = { target: null };
    const node: Item = { id: 1 };
    function mutate(): void { ev.target = node; }
    if (ev.target !== null) throw new Error("initial target");
    mutate();
    // TypeScript keeps ev.target narrowed to null across mutate(), so this
    // comparison narrows node to never, and keep(node) is typed never.
    if (ev.target !== node) throw new Error("target after mutate");
    function keep<T>(value: T): T { return value; }
    keep(node);
    let after = 0;
    after++;
    if (after !== 1) throw new Error("statements after a call typed never by narrowing still run");
`,
);

check(
    "string-search-positions-that-may-be-null-or-undefined",
    `
    function ends(text: string, end: number | null | undefined): boolean {
        // @ts-expect-error null is outside the declared position type
        return text.endsWith("b", end);
    }
    const picks = [2, 1, 0];
    const position = (pick: number): number | null | undefined => (pick === 0 ? undefined : pick === 1 ? null : 1);
    if (!ends("ab", position(picks[2]!)) || ends("ab", position(picks[1]!)) || ends("ab", position(picks[0]!)))
        throw new Error("undefined reads the end, null reads 0, a number reads itself");
`,
);

check(
    "object-destructuring-of-documents",
    `
    function read(raw: string | null): { n: number; k: number | null } {
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (!parsed || typeof parsed !== "object") return { n: 0, k: null };
        const { n, k } = parsed as { n?: unknown; k?: unknown };
        return {
            n: typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0,
            k: typeof k === "number" && Number.isFinite(k) ? k : null,
        };
    }
    const r = read('{"n":2,"k":3.5}');
    if (r.n !== 2 || r.k !== 3.5 || read(null).n !== 0 || read('{"n":-1}').k !== null) throw new Error("members");
    let defaults = 0;
    function fallback(): number { defaults++; return 7; }
    function withDefault(raw: string): number {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return -1;
        const { n = fallback(), "k": renamed } = parsed as { n?: unknown; k?: unknown };
        return (typeof n === "number" ? n : -2) + (renamed === undefined ? 100 : 0);
    }
    if (withDefault("{}") !== 107 || withDefault('{"n":1,"k":0}') !== 1 || withDefault('{"n":null}') !== 98 || defaults !== 1)
        throw new Error("defaults " + defaults);
`,
);

check(
    "coalesced-records-keep-the-selected-object",
    `
    interface Grid { cells: number[]; size: number }
    let created = 0;
    function emptyGrid(size: number | null): Grid | null {
        if (size === null) return null;
        created++;
        return { cells: [], size };
    }
    function current(previous: Grid | undefined, size: number | null): number {
        const grid = previous ?? emptyGrid(size);
        if (!grid) return -1;
        grid.cells.push(grid.size);
        return grid.cells.length;
    }
    const kept: Grid = { cells: [7], size: 3 };
    if (current(kept, null) !== 2 || kept.cells.length !== 2) throw new Error("present operand is the kept grid");
    if (current(undefined, 5) !== 1 || created !== 1) throw new Error("fallback grid");
    if (current(undefined, null) !== -1 || created !== 1) throw new Error("absent fallback stays absent");
    interface Support { readonly x: number; readonly z: number; readonly yaw: number }
    interface Deps {
        centre(id: number): { readonly x: number; readonly z: number } | null;
        support?(id: number): Support | null;
    }
    function locate(deps: Deps, id: number): number {
        const support = deps.support?.(id);
        const parent = support ?? deps.centre(id);
        if (!parent) return -1;
        return parent.x + parent.z;
    }
    const full: Deps = {
        centre: (id) => (id > 1 ? { x: id, z: 1 } : null),
        support: (id) => (id === 7 ? { x: 70, z: 7, yaw: 0 } : null),
    };
    const bare: Deps = { centre: (id) => (id > 1 ? { x: id, z: 2 } : null) };
    if (locate(full, 7) !== 77 || locate(full, 3) !== 4 || locate(full, 0) !== -1) throw new Error("records of two types");
    if (locate(bare, 5) !== 7 || locate(bare, 1) !== -1) throw new Error("absent method");
    interface Cells { cells: readonly number[]; flip: boolean }
    interface CellMap { cells: readonly number[]; flip: boolean; key: string }
    function describe(options: { cells?: Cells; map?: CellMap }): string {
        const mode = options.cells ?? options.map;
        if (!mode) return "plain";
        return mode.cells.length + (mode.flip ? "f" : "n");
    }
    if (describe({}) !== "plain" || describe({ cells: { cells: [1], flip: true } }) !== "1f" || describe({ map: { cells: [], flip: false, key: "k" } }) !== "0n")
        throw new Error("optional records of two types");
`,
);

check(
    "conditional-records-of-two-types-keep-the-selected-object",
    `
    interface A { kind: "a"; x: number }
    interface B { kind: "b"; x: number; y: number }
    const as: A[] = [{ kind: "a", x: 1 }];
    const bs: B[] = [{ kind: "b", x: 2, y: 3 }];
    const gate = new Float32Array([0, 1]);
    const p = gate[1] ? as[0]! : bs[0]!;
    p.x = 10;
    if (as[0]!.x !== 10 || p !== as[0]) throw new Error("selected first record");
    const q = gate[0] ? as[0]! : bs[0]!;
    q.x = 20;
    if (bs[0]!.x !== 20 || q !== bs[0] || (q.kind === "b" && q.y !== 3)) throw new Error("selected second record");
`,
);

check(
    "readonly-array-slices-are-owned-copies",
    `
    function root(values: readonly number[], index: number): number {
        const parent = values.slice();
        const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
        return find(index) * 10 + parent[index]!;
    }
    const roots: Array<typeof root> = [root];
    if (roots[0]!([1, 1, 1, 2], 3) !== 11) throw new Error("stored");
    if (root([1, 1, 1, 2], 3) !== 11) throw new Error("direct");
    const table: readonly number[] = [0, 0, 1, 2];
    if (root(table, 3) !== 0 || roots[0]!(table, 2) !== 0) throw new Error("named table");
    function grown(values: readonly number[]): number[] {
        const copy = values.slice(1);
        copy.push(values.length);
        return copy;
    }
    const sources: readonly number[] = [5, 6];
    const grownCopies = [grown];
    if (grown(sources).join(",") !== "6,2" || grownCopies[0]!(sources).join(",") !== "6,2" || sources.length !== 2) throw new Error("owned slice");
`,
);

check(
    "records-stored-as-another-record-type-stay-one-object",
    `
    interface Wide { a: number; b: number }
    interface Narrow { a: number }
    const w: Wide = { a: 1, b: 2 };
    const n: Narrow = w;
    n.a = 5;
    if (w.a !== 5 || (n as Wide) !== w) throw new Error("local view");
    const list: Narrow[] = [];
    list.push(w);
    list[0]!.a = 7;
    if (w.a !== 7 || list[0] !== n) throw new Error("array element view");
    w.a = 9;
    if (list[0]!.a !== 9) throw new Error("element reads the wide record");
    function bump(view: Narrow): void { view.a++; }
    const stored: Wide[] = [{ a: 3, b: 4 }];
    bump(stored[0]!);
    bump(w);
    if (stored[0]!.a !== 4 || w.a !== 10) throw new Error("parameter view");
    interface State { count: number; readonly ids: number[]; name: string }
    interface CountView { readonly count: number; readonly ids: readonly number[] }
    const contacts = new WeakMap<CountView, string>();
    function remember(view: CountView, label: string): void { contacts.set(view, label); }
    function recall(view: CountView): string { return contacts.get(view) ?? "none"; }
    const state: State = { count: 2, ids: [1, 2], name: "s" };
    remember(state, "kept");
    state.count = 3;
    if (recall(state) !== "kept") throw new Error("keyed view identity");
    interface Point { readonly x: number; readonly y: number }
    interface Labelled { readonly x: number; readonly y: number; readonly label: string }
    function length(point: Point): number { return Math.hypot(point.x, point.y); }
    const labelled: Labelled[] = [{ x: 3, y: 4, label: "p" }];
    if (length(labelled[0]!) !== 5) throw new Error("unobservable copy");
`,
);

check(
    "narrower-literals-share-the-wider-record-layout",
    `
    type Spec = { id: string; rgb: [number, number, number] };
    type Swatch = Spec & { swatch: string };
    function palette(): { id: string; labelKey: string; rgb: [number, number, number]; swatch: string }[] {
        return [{ id: "a", labelKey: "tint.a", rgb: [1, 2, 3], swatch: "#a" }];
    }
    const base = palette();
    const extra: Spec = { id: "b", rgb: [4, 5, 6] };
    const all: Swatch[] = [...base, { ...extra, swatch: "#b" }];
    if (all[0] !== base[0]) throw new Error("converted record keeps its identity");
    all[0]!.swatch = "#c";
    all[0]!.id = "z";
    if (base[0]!.swatch !== "#c" || base[0]!.id !== "z" || base[0]!.labelKey !== "tint.a") throw new Error("write through the narrower view");
    base[0]!.swatch = "#d";
    if (all[0]!.swatch !== "#d") throw new Error("write through the wider record");
    const narrow = all[1]!;
    if (Object.keys(narrow).join(",") !== "id,rgb,swatch") throw new Error("narrower keys " + Object.keys(narrow).join(","));
    if (JSON.stringify(narrow) !== '{"id":"b","rgb":[4,5,6],"swatch":"#b"}') throw new Error("narrower JSON " + JSON.stringify(narrow));
    if (Object.keys(base[0]!).join(",") !== "id,labelKey,rgb,swatch") throw new Error("wider keys " + Object.keys(base[0]!).join(","));
    if (JSON.stringify(all[0]) !== '{"id":"z","labelKey":"tint.a","rgb":[1,2,3],"swatch":"#d"}') throw new Error("wider JSON " + JSON.stringify(all[0]));
`,
);

check(
    "tuples-stored-as-number-arrays-grow-together",
    `
    const store: number[][] = [];
    function keep(values: number[]): number { store.push(values); return values.length; }
    const lane: [number, number] = [1, 2];
    if (keep(lane) !== 2) throw new Error("length");
    store[0]!.push(3);
    if (lane.length !== 3 || store[0] !== lane || lane[2] !== 3) throw new Error("grown through a retained array");
    const direct: [number, number] = [4, 5];
    const view: number[] = direct;
    view.push(6);
    if (direct.length !== 3 || view !== direct) throw new Error("grown through a local array");
    interface Holder { values: number[] }
    const pair: [number, number] = [7, 8];
    const holder: Holder = { values: pair };
    holder.values.push(9);
    pair[0] = 70;
    if (pair.length !== 3 || holder.values[0] !== 70) throw new Error("grown through a field");
    function fresh(): [number, number] { return [1, 1]; }
    const owned: number[] = fresh();
    owned.push(2);
    if (owned.length !== 3) throw new Error("fresh tuple adopted");
    interface Placed { pos: [number, number] }
    const placed: Placed = { pos: [3, 4] };
    function total(values: number | number[]): number {
        if (typeof values === "number") return values;
        let sum = 0;
        for (const value of values) sum += value;
        return sum;
    }
    if (total(placed.pos) !== 7 || total(2) !== 2) throw new Error("a reading callee borrows a field tuple");
`,
);

check(
    "heterogeneous-tuple-lanes-destructure-as-declared",
    `
    const pair: [string, (id: number) => string] = ["tower", (id) => "tower#" + id];
    const [key, keyOf] = pair;
    if (key !== "tower" || keyOf(4) !== "tower#4") throw new Error("destructured pair");
    const pairs: Array<[string, (id: number) => string, number]> = [["a", (id) => "a" + id, 1], ["b", (id) => "b" + id, 2]];
    let out = "";
    for (const [name, nameOf, weight] of pairs) out += name + nameOf(weight);
    const [first, firstOf] = pairs[1]!;
    if (out !== "aa1bb2" || first !== "b" || firstOf(3) !== "b3") throw new Error("destructured lanes");
    function apply([label, format]: [string, (value: number) => string], value: number): string { return label + "=" + format(value); }
    if (apply(["v", (value) => value.toFixed(1)], 2) !== "v=2.0") throw new Error("parameter lanes");
`,
);

check(
    "coalesced-narrower-records-take-the-wider-layout",
    `
    interface P { x: number; z: number }
    interface C { x: number }
    const items: P[] = [{ x: 1, z: 2 }];
    const other: C = { x: 5 };
    function read(i: number): number { const p = items[i] ?? other; other.x += 60; return p.x; }
    if (read(0) !== 1 || read(3) !== 125 || other.x !== 125) throw new Error("selected record reads");
    if ((items[3] ?? other) !== other || (items[0] ?? other) !== items[0]) throw new Error("selected identity");
    if (JSON.stringify(other) !== '{"x":125}' || Object.keys(other).join(",") !== "x") throw new Error("narrower keys");
`,
);

check(
    "coalesced-records-of-two-wider-types-stay-one-object",
    `
    interface P { x: number; z: number }
    interface C { x: number; w: number }
    const items: P[] = [{ x: 1, z: 2 }];
    const other: C = { x: 5, w: 6 };
    function read(i: number): number { const p = items[i] ?? other; other.x = 60; return p.x; }
    if (read(0) !== 1 || read(3) !== 60) throw new Error("selected record reads the written object");
    if ((items[3] ?? other) !== other) throw new Error("selected identity");
    if (JSON.stringify(other) !== '{"x":60,"w":6}' || JSON.stringify(items[0]) !== '{"x":1,"z":2}') throw new Error("each record keeps its own keys");
`,
);
check(
    "records-stored-as-a-type-of-other-fields-stay-one-object",
    `
    interface S { a: number; extra: number }
    interface T { a: number; note?: string }
    const s: S = { a: 1, extra: 2 };
    const t: T = s;
    const seen = new Set<T>([t]);
    t.a = 3;
    t.note = "n";
    if (!seen.has(s) || s.a !== 3 || (s as T).note !== "n") throw new Error("one object keyed and written under both types");
    if (Object.keys(s).join() !== "a,extra,note" || JSON.stringify(t) !== '{"a":3,"extra":2,"note":"n"}') throw new Error("keys of the one object");
    const own: T = { a: 4 };
    if ("extra" in own || JSON.stringify(own) !== '{"a":4}') throw new Error("a record of the other type holds the field absent");
`,
);
check(
    "arrays-of-records-lent-to-reading-callees",
    `
    interface Emit { x: number; y: number; z: number }
    interface Wheel { x: number; z: number; label?: string }
    class Marks {
        total = 0;
        trails: { x: number }[] = [];
        update(wheels: readonly Wheel[]): void {
            if (this.trails.length !== wheels.length) this.trails = wheels.map(() => ({ x: 0 }));
            for (let i = 0; i < wheels.length; i++) this.total += wheels[i]!.x * 10 + wheels[i]!.z;
            wheels.forEach((wheel) => { this.total += wheel.label === undefined ? 1 : 0; });
            for (const wheel of wheels) { const point = wheel; this.total += point.x; }
        }
    }
    const marks = new Marks();
    const points: Emit[] = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }];
    marks.update(points);
    points.push({ x: 7, y: 8, z: 9 });
    marks.update(points);
    if (marks.total !== 219 || marks.trails.length !== 3) throw new Error("lent array " + marks.total);
    const seen = new Set<Emit>(points);
    if (!seen.has(points[2]!) || points.length !== 3) throw new Error("original array");
`,
);

check(
    "arrays-of-records-kept-or-grown-by-callees-stay-one-array",
    `
    interface Emit { x: number; y: number; z: number }
    interface Wheel { x: number; z: number; label?: string }
    const kept: Wheel[] = [];
    function keep(wheels: readonly Wheel[]): void { kept.push(wheels[0]!); }
    const points: Emit[] = [{ x: 1, y: 2, z: 3 }];
    keep(points);
    points[0]!.x = 9;
    if (kept[0]!.x !== 9 || kept[0] !== points[0]) throw new Error("a kept element is the array's own record");
    class Store {
        points: Emit[] = [{ x: 1, y: 2, z: 3 }];
        grow(): void { this.points.push({ x: 4, y: 0, z: 0 }); }
    }
    class Summer {
        total = 0;
        sum(wheels: Wheel[], store: Store): void { store.grow(); for (const wheel of wheels) this.total += wheel.x; }
    }
    const store = new Store();
    const summer = new Summer();
    summer.sum(store.points, store);
    if (summer.total !== 5 || store.points.length !== 2) throw new Error("the callee walks the array the call grew " + summer.total);
`,
);
check(
    "records-lent-to-reading-callees-see-writes-the-call-runs",
    `
    interface Wide { x: number; y: number; tag: string }
    interface Narrow { x: number; y: number }
    const first: Wide = { x: 1, y: 2, tag: "a" };
    function bump(): void { first.x += 10; }
    function readAfterCallback(p: Narrow): number { [0].forEach(bump); return p.x; }
    if (readAfterCallback(first) !== 11) throw new Error("a callback handed to forEach writes the original");
    const second: Wide = { x: 1, y: 2, tag: "b" };
    class Probe {
        stored = 0;
        get reading(): number { second.x += 100; return 0; }
        get writing(): number { return this.stored; }
        set writing(value: number) { this.stored = value; second.y = value; }
    }
    function readAfterGetter(probe: Probe, p: Narrow): number { return probe.reading + p.x; }
    if (readAfterGetter(new Probe(), second) !== 101) throw new Error("a getter writes the original");
    function readAfterSetter(probe: Probe, p: Narrow): number { probe.writing = 7; return p.y; }
    if (readAfterSetter(new Probe(), second) !== 7) throw new Error("a setter writes the original");
`,
);

check(
    "records-converted-to-two-wider-types-stay-one-object",
    `
    interface P { x: number }
    interface Labeled { x: number; label?: string }
    interface Weighted { x: number; w?: number }
    const p: P = { x: 1 };
    const labeled: Labeled = p;
    const weighted: Weighted = p;
    labeled.x = 5;
    if (weighted.x !== 5 || p.x !== 5) throw new Error("one object under three types");
    labeled.label = "a";
    weighted.w = 2;
    if ((labeled as P) !== (weighted as P) || (weighted as P) !== p) throw new Error("one identity");
    if (Object.keys(p).sort().join() !== "label,w,x") throw new Error("keys added through either view " + Object.keys(p).join());
    const plain: Labeled = { x: 3 };
    if ("label" in plain || "w" in plain || Object.keys(plain).join() !== "x") throw new Error("a member's own record holds the others' fields absent");
    const seen = new Set<P>([labeled]);
    if (!seen.has(weighted) || !seen.has(p)) throw new Error("keyed identity");
`,
);

check(
    "union-arms-keep-nested-records-of-their-own-types",
    `
    const archiveTypes = [{ description: "Archive", accept: { "application/zip": [".zip"] } }];
    const plainTypes = [{ description: "Plain", accept: { "application/json": [".json"] } }];
    const saveTypes = [...archiveTypes, ...plainTypes];
    const openTypes = saveTypes;
    if (saveTypes[0] !== archiveTypes[0] || openTypes[1] !== plainTypes[0]) throw new Error("spread elements keep their objects");
    saveTypes[0]!.description = "Zip";
    if (archiveTypes[0]!.description !== "Zip") throw new Error("write through the union");
    const accept = saveTypes[1]!.accept;
    if (accept !== plainTypes[0]!.accept || !("application/json" in accept) || "application/zip" in accept) throw new Error("nested record of each arm");
    plainTypes[0]!.accept["application/json"].push(".txt");
    if (Object.keys(saveTypes[0]!.accept).join() !== "application/zip" || Object.keys(accept).join() !== "application/json") throw new Error("nested keys");
    if (JSON.stringify(openTypes) !== '[{"description":"Zip","accept":{"application/zip":[".zip"]}},{"description":"Plain","accept":{"application/json":[".json",".txt"]}}]') throw new Error("json " + JSON.stringify(openTypes));
`,
);

check(
    "records-wider-than-a-union-keep-their-fields-in-its-layout",
    `
    interface End { s: number; x: number; y: number; z: number }
    type Flat = Readonly<{ x: number; z: number }>;
    type Mark = { readonly x: number; readonly z: number };
    const ends: End[] = [{ s: 1, x: 2, y: 3, z: 4 }];
    const flat: Flat = { x: 5, z: 6 };
    const mark: Mark = { x: 7, z: 8 };
    const spots: (Flat | Mark)[] = [flat, mark];
    spots.push(ends[0]!);
    const seen = new Set<Flat | Mark>(spots);
    if (!seen.has(ends[0]!) || spots[2] !== ends[0] || spots[0] !== flat) throw new Error("one object");
    ends[0]!.x = 20;
    if (spots[2]!.x !== 20) throw new Error("write through the wider type");
    if (Object.keys(spots[2]!).join() !== "s,x,y,z" || JSON.stringify(spots[2]) !== '{"s":1,"x":20,"y":3,"z":4}') throw new Error("wider keys " + Object.keys(spots[2]!).join());
    if (Object.keys(spots[0]!).join() !== "x,z" || JSON.stringify(spots[1]) !== '{"x":7,"z":8}') throw new Error("arm keys");
    if ("s" in spots[0]! || !("s" in spots[2]!)) throw new Error("absent field");
`,
);

check(
    "union-records-narrowed-to-an-arm-stay-one-object",
    `
    interface Circle { kind: "circle"; x: number; z: number; radius: number; grow?: number }
    interface Rect { kind: "rect"; cx: number; cz: number; half: number; grow?: number }
    type Boundary = Circle | Rect;
    function area(r: Rect): number { r.grow = (r.grow ?? 0) + 1; return r.half * r.half * 4; }
    function measure(b: Boundary): number { if (b.kind === "circle") return b.radius * 3; return area(b); }
    const shapes: Boundary[] = [{ kind: "rect", cx: 1, cz: 2, half: 3 }, { kind: "circle", x: 0, z: 0, radius: 1 }];
    if (Object.keys(shapes[0]!).join() !== "kind,cx,cz,half" || Object.keys(shapes[1]!).join() !== "kind,x,z,radius") throw new Error("keys " + Object.keys(shapes[0]!).join());
    if (measure(shapes[0]!) !== 36 || shapes[0]!.grow !== 1 || !("grow" in shapes[0]!) || measure(shapes[1]!) !== 3) throw new Error("write through the arm");
    const found = shapes.find((shape): shape is Rect => shape.kind === "rect");
    if (found === undefined || found !== shapes[0] || found.half !== 3) throw new Error("guarded find keeps the object");
`,
);

check(
    "conditional-arms-of-own-fields-stay-one-object",
    `
    interface TowerRoof { x: number; z: number; yaw: number; baseY: number; baseRadius: number }
    type Host =
        | { readonly kind: "cone"; readonly roof: TowerRoof; readonly radius: number }
        | { readonly kind: "flat"; readonly x: number; readonly z: number; readonly yaw: number; readonly y: number; readonly radius: number };
    function frameOf(host: Host) { return host.kind === "cone" ? host.roof : host; }
    const roof: TowerRoof = { x: 1, z: 2, yaw: 0, baseY: 3, baseRadius: 4 };
    const hosts: Host[] = [{ kind: "cone", roof, radius: 1 }, { kind: "flat", x: 5, z: 6, yaw: 0, y: 7, radius: 2 }];
    const frames = hosts.map(frameOf);
    if (frames[0] !== roof || frames[1] !== hosts[1]) throw new Error("selected objects");
    roof.x = 10;
    if (frames[0]!.x + frames[1]!.z !== 16) throw new Error("reads through the frame");
    if (Object.keys(frames[0]!).join() !== "x,z,yaw,baseY,baseRadius" || Object.keys(frames[1]!).join() !== "kind,x,z,yaw,y,radius") throw new Error("keys");
`,
);

check(
    "records-of-two-unions-take-one-layout",
    `
    interface A { tag: "a"; v: number }
    interface B { tag: "b"; w: number }
    interface C { tag: "c"; v: number; w: number }
    const a: A = { tag: "a", v: 1 };
    const first: (A | B)[] = [a, { tag: "b", w: 2 }];
    const second: (A | C)[] = [a, { tag: "c", v: 3, w: 4 }];
    if (first[0] !== second[0]) throw new Error("one object in two unions");
    const held = first[0]!;
    if (held.tag === "a") held.v = 10;
    const other = second[0]!;
    if (a.v !== 10 || other.tag !== "a" || other.v !== 10) throw new Error("write through one union");
    if (Object.keys(first[1]!).join() !== "tag,w" || JSON.stringify(second) !== '[{"tag":"a","v":10},{"tag":"c","v":3,"w":4}]') throw new Error("keys");
`,
);

check(
    "records-stored-as-a-generic-instantiation-stay-one-object",
    `
    interface Projection<State> { readonly state: State; readonly distance: number; owns: boolean }
    interface TowerState { tower: number }
    interface TowerProjection extends Projection<TowerState> { readonly support: number }
    interface AdapterOptions<State> { current(): Projection<State> }
    interface Adapter<State> { candidate(): object; projectionOf(key: object): Projection<State> | undefined }
    function createAdapter<State>(options: AdapterOptions<State>): Adapter<State> {
        const byCandidate = new WeakMap<object, Projection<State>>();
        return {
            candidate() {
                const projection = options.current();
                const key = { distance: projection.distance };
                byCandidate.set(key, projection);
                return key;
            },
            projectionOf(key) { return byCandidate.get(key); },
        };
    }
    const towerProjection: TowerProjection = { state: { tower: 1 }, distance: 2, owns: false, support: 3 };
    const adapter = createAdapter<TowerState>({ current: () => towerProjection });
    const found = adapter.projectionOf(adapter.candidate());
    if (found !== towerProjection) throw new Error("one projection");
    found.owns = true;
    if (!towerProjection.owns || found.state.tower !== 1) throw new Error("write through the generic view");
    interface Peer { key: string; x: number }
    interface Request<P> { readonly key: string; axis0: number; readonly allow0?: boolean; readonly admit?: (peer: P) => boolean }
    interface Session<P> { resolve(request: Request<P>): number }
    function createSession<P extends Peer>(peers: readonly P[]): Session<P> {
        const resolveAxis = (request: Request<P>): number => {
            let best = request.axis0;
            for (const peer of peers) if (request.admit === undefined || request.admit(peer)) best = Math.max(best, peer.x);
            return best;
        };
        return { resolve(request) { return resolveAxis(request) + (request.allow0 === false ? 0 : 1); } };
    }
    const session = createSession<Peer>([{ key: "a", x: 4 }, { key: "b", x: 9 }]);
    const request = { key: "a", axis0: 2, allow0: true, admit: (peer: Peer) => peer.key === "a" };
    if (session.resolve(request) !== 5) throw new Error("resolve");
    request.axis0 = 7;
    if (session.resolve(request) !== 8) throw new Error("written request");
    interface Box<T> { value: T }
    interface Held<S> { readonly state: S; distance: number }
    interface Concrete extends Held<Box<number>> { readonly extra: number }
    function keep<T>(make: () => Held<Box<T>>): Held<Box<T>>[] {
        const kept: Held<Box<T>>[] = [];
        const held = make();
        kept.push(held);
        held.distance = 3;
        return kept;
    }
    const concrete: Concrete = { state: { value: 1 }, distance: 2, extra: 4 };
    const kept = keep<number>(() => concrete);
    if (kept[0] !== concrete || concrete.distance !== 3 || kept[0]!.state.value !== 1) throw new Error("nested instantiation");
`,
);

check(
    "narrowed-union-records-returned-as-another-union-stay-one-object",
    `
    interface Ready { state: "ready"; pickupX: number; goalX: number }
    interface Pending { state: "pending" }
    interface Blocked { state: "blocked" }
    type Rendezvous = Ready | Pending | Blocked;
    type StandPoint = { state: "ready"; x: number; z: number } | Pending | Blocked;
    const points: StandPoint[] = [{ state: "pending" }, { state: "ready", x: 1, z: 2 }];
    function rendezvous(point: StandPoint): Rendezvous {
        if (point.state !== "ready") return point;
        return { state: "ready", pickupX: point.x, goalX: point.z };
    }
    const seen = new Set<Rendezvous>();
    const first = rendezvous(points[0]!);
    const second = rendezvous(points[1]!);
    seen.add(first);
    if (first !== points[0] || second === points[1] || seen.size !== 1) throw new Error("selected objects");
    if (second.state !== "ready" || second.pickupX !== 1 || Object.keys(second).join() !== "state,pickupX,goalX") throw new Error("fresh arm");
    if (Object.keys(first).join() !== "state" || JSON.stringify(points) !== '[{"state":"pending"},{"state":"ready","x":1,"z":2}]') throw new Error("keys");
`,
);

check(
    "records-holding-a-field-only-undefined-share-the-other-type-layout",
    `
    interface Pose { pitch?: number; pivot?: readonly [number, number, number] }
    const upright = { pitch: 0, pivot: undefined };
    const suspended = { pitch: Math.PI / 2, pivot: [0.5, 0.5, 0] as const };
    function orientation(kind: string): Pose { return kind === "fish" ? suspended : upright; }
    const fish = orientation("fish");
    const seen = new Set<Pose>([fish, orientation("x")]);
    if (!seen.has(suspended) || !seen.has(upright) || fish.pivot?.[1] !== 0.5 || orientation("x").pivot !== undefined) throw new Error("one object per pose");
    fish.pitch = 1;
    if (suspended.pitch !== 1 || JSON.stringify(orientation("x")) !== '{"pitch":0}') throw new Error("write through the declared type");
`,
);

check(
    "union-arms-requiring-a-field-another-arm-makes-optional-enumerate-it",
    `
    interface Appearance { seed?: number }
    interface Tower extends Appearance { seed: number }
    interface House extends Appearance { label: string }
    function keysOf(before: Tower | House, after: Tower | House): string { return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().join(); }
    const classify: Array<typeof keysOf> = [keysOf];
    const tower: Tower = { seed: 3 };
    const house: House = { label: "h" };
    const seeded: House = { label: "s", seed: 2 };
    if (classify[0]!(tower, tower) !== "seed" || classify[0]!(house, house) !== "label" || classify[0]!(seeded, house) !== "label,seed") throw new Error("own keys");
`,
);

test("union arms holding an undefined field another arm makes optional refuse its own-key presence", () => {
    assert.throws(
        () =>
            compileSource(`interface Tower { seed: number | undefined }
            interface House { seed?: number; label: string }
            function keysOf(before: Tower | House): string { return Object.keys(before).join(); }
            const classify: Array<typeof keysOf> = [keysOf];
            if (classify[0]!({ seed: undefined }) !== "seed") throw new Error("own undefined key");`),
        /Own-property presence of 'seed' is not represented/,
    );
});

check(
    "union-records-narrowed-to-an-arm-with-methods-stay-one-object",
    `
    interface Step { id: number }
    interface ReleasePlan { readonly steps: readonly Step[]; commit(): void }
    type ReleasePreparation = ReleasePlan | { readonly state: "pending" } | { readonly state: "refused" };
    const planOf = (preparation: ReleasePreparation): ReleasePlan | null => ("steps" in preparation ? preparation : null);
    const roots: Array<typeof planOf> = [planOf];
    let committed = 0;
    const plan: ReleasePlan = { steps: [{ id: 1 }], commit() { committed++; } };
    const preparations: ReleasePreparation[] = [plan, { state: "pending" }];
    const found = roots[0]!(preparations[0]!);
    if (found !== plan || roots[0]!(preparations[1]!) !== null) throw new Error("narrowed plan");
    found.commit();
    if (committed !== 1 || found.steps[0]!.id !== 1) throw new Error("commit");
`,
);

check(
    "records-holding-a-field-only-null-keep-it",
    `
    interface Face { polygon: readonly number[]; houseArc: readonly number[] | null }
    interface Ring extends Face { houseArc: null }
    interface Enclosure extends Face { houseArc: readonly number[] }
    function ringFrom(n: number): Ring | null {
        if (n < 0) return null;
        const polygon = [n, n + 1];
        if (polygon.length > 5) return null;
        return { polygon, houseArc: null };
    }
    const make: Array<typeof ringFrom> = [ringFrom];
    const yards: (Ring | Enclosure)[] = [{ polygon: [1], houseArc: [2] }];
    const ring = make[0]!(3);
    if (ring) yards.push(ring);
    if (yards.length !== 2 || yards[1] !== ring || yards[1]!.houseArc !== null || make[0]!(-1) !== null) throw new Error("ring");
    const text = JSON.stringify(ring);
    if (!text.includes('"houseArc":null') || !text.includes('"polygon":[3,4]') || Object.keys(ring!).sort().join() !== "houseArc,polygon") throw new Error("keys " + text);
`,
);

check(
    "records-storing-a-function-of-a-narrower-signature-share-the-declared-layout",
    `
    interface Storage { readonly name: string; readonly vertex?: boolean; readonly data: (n: number) => number[] | null | undefined }
    interface Part { readonly storage: readonly Storage[] }
    function compose(parts: readonly Part[]): Storage[] { const flat: Storage[] = []; for (const part of parts) flat.push(...part.storage); return flat; }
    function makePart(scale: number): Part {
        const entry = { name: "clip", vertex: true as const, data: (n: number): number[] | null => (n > 0 ? [n * scale] : null) };
        return { storage: [entry] };
    }
    const roots = [compose];
    const parts: Part[] = [makePart(2)];
    const flat = roots[0]!(parts);
    const first = flat[0]!;
    if (first.name !== "clip" || first.data(3)?.[0] !== 6 || first.data(0) != null || parts[0]!.storage[0] !== first || first.vertex !== true) throw new Error("storage");
`,
);

check(
    "records-stored-as-a-tagged-union-stay-one-object",
    `
    interface A { kind: "a"; x: number }
    interface B { kind: "b"; y: number }
    const a: A = { kind: "a", x: 1 };
    const u: A | B = a;
    if (u.kind === "a") u.x = 5;
    if (a.x !== 5) throw new Error("one object");
    const w = { kind: "a" as const, x: 2, extra: 3 };
    const v: A | B = w;
    if (v.kind === "a") v.x = 7;
    if (w.x !== 7 || Object.keys(v).join() !== "kind,x,extra" || "y" in v) throw new Error("wider object");
    const b: A | B = { kind: "b", y: 4 };
    if (b.kind !== "b" || b.y !== 4 || Object.keys(b).join() !== "kind,y") throw new Error("other arm");
`,
);

check(
    "records-stored-in-nullable-slots-of-another-type-stay-one-object",
    `
    interface Wide { a: number; b: number }
    interface Narrow { a: number }
    const slots: (Narrow | null)[] = [null];
    const w: Wide = { a: 1, b: 2 };
    slots[0] = w;
    slots[0]!.a = 5;
    if (w.a !== 5 || slots[0] !== w) throw new Error("one object in a nullable slot");
    let held: Narrow | undefined;
    held = w;
    held.a = 7;
    if (w.a !== 7 || Object.keys(held).join() !== "a,b") throw new Error("one object in a nullable local");
`,
);

check(
    "union-records-narrowed-in-generic-bodies-stay-one-object",
    `
    interface Circle { kind: "circle"; r: number }
    interface Square { kind: "square"; side: number }
    type Shape = Circle | Square;
    function grow(s: Square): void { s.side += 1; }
    function apply<T>(items: Shape[], tag: T): T { for (const item of items) if (item.kind === "square") grow(item); return tag; }
    const shapes: Shape[] = [{ kind: "square", side: 1 }, { kind: "circle", r: 2 }];
    if (apply(shapes, 3) !== 3 || apply(shapes, "x") !== "x") throw new Error("tags");
    const first = shapes[0]!;
    if (first.kind !== "square" || first.side !== 3) throw new Error("written through the arm in a generic body");
`,
);

check(
    "records-stored-as-an-engine-record-type-stay-one-object",
    `
    type VatClip = import("@babylonjs/lite").VatClip;
    interface Holder { frozen: { fromRow: number; frameCount: number; fps: number }; slot: number }
    const holder: Holder = { frozen: { fromRow: 0, frameCount: 1, fps: 0 }, slot: 0 };
    const gait: (VatClip | undefined)[] = [undefined, { fromRow: 4, frameCount: 2, fps: 12 }];
    function sum(a: VatClip, b: VatClip): number { return a.fps + b.fps; }
    function pick(hold: boolean): VatClip {
        Object.assign(holder.frozen, { fromRow: 2, frameCount: 3, fps: 24 });
        const fallback = gait[1]!;
        const clip = hold ? holder.frozen : gait[holder.slot] ?? fallback;
        return clip;
    }
    const held = pick(true);
    if (held !== holder.frozen || sum(held, gait[1]!) !== 36) throw new Error("one object under the engine type");
    holder.frozen.fps = 30;
    if (held.fps !== 30 || pick(false) !== gait[1]) throw new Error("writes reach the held record");
`,
);

check(
    "fresh-records-stored-as-a-mapped-record-type",
    `
    interface Debug { kind: string; slot: number; open: number | null; id: number; matrix: readonly number[] }
    type FieldDebug = Omit<Debug, "kind" | "id"> & { slot: number };
    interface Field { instances(key: number): readonly FieldDebug[] }
    const owners = new Map<number, number[]>([[1, [0, 1]]]);
    const values = [new Float32Array([1, 2]), new Float32Array([3, 4])];
    function makeField(): Field {
        return {
            instances(key) {
                const slots = owners.get(key);
                if (!slots) return [];
                return slots.flatMap((slot) => values.map((m) => ({ open: slot > 0 ? m[0]! : null, slot, matrix: Array.from(m.subarray(slot, slot + 1)) })));
            },
        };
    }
    const fields = new Map<string, Field>([["door", makeField()]]);
    const out: Debug[] = [];
    for (const [kind, field] of fields)
        for (const item of field.instances(1)) out.push({ kind, slot: item.slot, open: item.open, id: 1, matrix: item.matrix });
    const list = fields.get("door")!.instances(1);
    if (out.length !== 4 || out[3]!.slot !== 1 || out[2]!.open !== 1 || out[0]!.open !== null || out[3]!.matrix[0] !== 4) throw new Error("records of a mapped type");
    if (Object.keys(list[0]!).sort().join() !== "matrix,open,slot") throw new Error("keys of the fresh records " + Object.keys(list[0]!).join());
`,
);

check(
    "retained-factories-store-literal-function-fields-through-a-declared-type",
    `
    interface Action { id: string; label: string; variant: string; onSelect: () => void; large?: boolean }
    interface Groups { first: Action[]; second: Action[] }
    let selected = "";
    function same(a: unknown, b: unknown): boolean { return a === b; }
    function createGroups(select: (() => void) | undefined): Groups {
        const optional = (id: string, label: string, onSelect: (() => void) | undefined, extra: Pick<Action, "variant" | "large">): Action | null =>
            onSelect ? { id, label, onSelect, ...extra } : null;
        return {
            first: [{ id: "a", label: "A", variant: "x", onSelect: () => { selected = "a"; } }],
            second: [optional("b", "B", select, { variant: "y", large: true }), optional("c", "C", undefined, { variant: "z" })].filter((action): action is Action => action !== null),
        };
    }
    const roots: Array<typeof createGroups> = [createGroups];
    const groups = roots[0]!(() => { selected = "b"; });
    const action = groups.second[0]!;
    action.onSelect();
    if (selected !== "b" || groups.second.length !== 1 || action.large !== true || !same(action, groups.second[0]) || Object.keys(action).sort().join() !== "id,label,large,onSelect,variant") throw new Error("actions " + Object.keys(action).join());
    groups.first[0]!.onSelect();
    if (selected !== "a" || Object.keys(groups.first[0]!).join() !== "id,label,variant,onSelect") throw new Error("declared record keys");
`,
);

check(
    "narrower-records-reached-through-wider-arrays-copy-their-absence",
    `
    interface Wide { a: number; b: number }
    interface Narrow { a: number }
    const wides: Wide[] = [{ a: 1, b: 2 }];
    const narrows: Narrow[] = wides;
    narrows.push({ a: 3 });
    const second = wides[1]!;
    if (Object.keys(second).join() !== "a" || JSON.stringify(second) !== '{"a":3}') throw new Error("narrower record keys");
    const copy = { ...second };
    if (copy.a !== 3 || "b" in copy || Object.keys(copy).join() !== "a") throw new Error("narrower record copied through a wider array");
    const first = { ...wides[0]! };
    if (first.a !== 1 || first.b !== 2 || Object.keys(first).join() !== "a,b") throw new Error("wider record copy");
`,
);

test("records of one object refuse a property no one layout stores both ways", () => {
    assert.throws(
        () =>
            compileSource(`interface S { v: number }
            interface T { v: number | string }
            const s: S = { v: 1 };
            const t: T = s;
            t.v = "x";
            const unused = s.v;`),
        /'S' record stored as 'T' would be a copy of the one object JavaScript keeps, and the program writes 'v' of such records; no shared layout holds both record types/,
    );
});

check(
    "any-assertions-leave-record-copies-unobservable",
    `
    interface Source { a: number; extra: number }
    interface Target { a: number; note?: string }
    interface Other { z: number }
    const source: Source = { a: 1, extra: 2 };
    const target: Target = source;
    const raw = source as any;
    const left: Other = { z: 1 };
    const right: Other = { z: 2 };
    if (left === right || target.a !== 1 || raw === null) throw new Error("an any assertion keeps the copy unobservable");
`,
);

check(
    "awaited-records-keep-their-record-type",
    `
    interface Grid { section: string; columns: number }
    interface Sheet { texture: number; grids: Map<string, Grid>; grid: (section: string) => Grid }
    async function loadSheet(texture: number): Promise<Sheet> {
        const grids = new Map<string, Grid>();
        grids.set("main", { section: "main", columns: texture });
        return { texture, grids, grid: (section) => grids.get(section)! };
    }
    interface Sheets { terrain: Sheet; hills: Sheet }
    async function main(): Promise<void> {
        const [terrain, hills] = await Promise.all([loadSheet(1), loadSheet(2)]);
        const sheets: Sheets = { terrain, hills };
        if (sheets.terrain !== terrain || sheets.hills.grid("main").columns !== 2) throw new Error("awaited sheets");
        const seen = new Set<Sheet>([terrain]);
        if (!seen.has(sheets.terrain) || seen.has(hills)) throw new Error("awaited identity");
    }
    void main();
`,
);

check(
    "readonly-record-views-share-the-written-layout",
    `
    interface Vec { x: number; y: number; z: number }
    interface Rest {
        readonly transforms: ReadonlyArray<{
            readonly position: { readonly x: number; readonly y: number; readonly z: number };
            readonly rotation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
        }>;
        launched: boolean;
    }
    const meshes: Vec[] = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }];
    const state: Rest = {
        transforms: meshes.map((mesh) => ({
            position: { x: mesh.x, y: mesh.y, z: mesh.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        })),
        launched: false,
    };
    const live = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    live.position = { x: 7, y: 8, z: 9 };
    const rest = state.transforms[1]!;
    if (rest.position.y !== 5 || rest.rotation.w !== 1 || live.position.z !== 9) throw new Error("readonly views");
`,
);

check(
    "union-arm-fields-own-while-undefined",
    `
    type Shape = { kind: "a"; x: number | undefined } | { kind: "b"; y: number };
    const shapes: Shape[] = [{ kind: "a", x: undefined }, { kind: "b", y: 2 }, { kind: "a", x: 4 }];
    let total = 0;
    let numbers = 0;
    let undefinedOwn = 0;
    let keys = "";
    for (const shape of shapes) {
        for (const [key, value] of Object.entries(shape)) {
            keys += key;
            if (typeof value === "number") { numbers++; total += value; }
        }
        const copy = { ...shape };
        if (copy.kind === "a" && "x" in copy && copy.x === undefined) undefinedOwn++;
        if (copy.kind === "a" && copy.x !== undefined) total += copy.x * 10;
    }
    if (total !== 46 || numbers !== 2 || undefinedOwn !== 1 || keys !== "kindxkindykindx") throw new Error("own arm fields " + total + " " + numbers + " " + undefinedOwn + " " + keys);
`,
);

check(
    "literal-accessors-read-the-object-the-literal-creates",
    `
    interface Box { w: number; readonly width: number; grow(): void }
    const box: Box = { w: 1, get width(): number { return this.w; }, grow(): void { this.w += 1; } };
    box.grow();
    if (box.width !== 2) throw new Error("getter after a method write " + box.width);
    box.w = 5;
    if (box.width !== 5) throw new Error("getter after a field write " + box.width);
    interface Gauge { level: number; readonly doubled: number; percent: number }
    const gauge: Gauge = {
        level: 1,
        get doubled(): number { return this.level * 2; },
        get percent(): number { return this.level * 100; },
        set percent(value: number) { this.level = value / 100; },
    };
    gauge.level = 3;
    if (gauge.doubled !== 6) throw new Error("getter-only literal " + gauge.doubled);
    gauge.percent = 250;
    if (gauge.level !== 2.5 || gauge.doubled !== 5 || gauge.percent !== 250) throw new Error("setter writes the live field");
`,
);

check(
    "arrays-held-in-nested-members-stay-one-object",
    `
    interface Emit { x: number; y: number; z: number }
    interface Narrow { x: number }
    interface Holder { points: Narrow[] }
    interface Outer { inner: Holder; lists: Narrow[][] }
    const points: Emit[] = [{ x: 1, y: 2, z: 3 }];
    const holder: Holder = { points };
    const nested: Outer = { inner: { points }, lists: [points] };
    const flag = points.length > 0;
    const chosen: Holder = { points: flag ? points : [] };
    const base = { points };
    const spread: Holder = { ...base };
    function make(): { points: Emit[] } { return { points }; }
    const made: Holder = make();
    points.push({ x: 4, y: 5, z: 6 });
    if (holder.points !== points || nested.inner.points !== points || nested.lists[0] !== points) throw new Error("literal members");
    if (chosen.points !== points || spread.points !== points || made.points !== points) throw new Error("selected, spread and returned members");
    if (holder.points.length !== 2 || made.points.length !== 2) throw new Error("shared growth");
    holder.points[1]!.x = 9;
    if (points[1]!.x !== 9) throw new Error("shared element");
`,
);

check(
    "fresh-nested-members-are-copied",
    `
    interface Emit { x: number; y: number; z: number }
    interface Wheel { x: number; z: number; label?: string }
    interface Holder { points: Wheel[]; first: { at: Wheel } }
    const source: Emit[] = [{ x: 1, y: 2, z: 3 }];
    const holder: Holder = {
        points: source.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        first: { at: { x: 5, y: 6, z: 7 } as Emit },
    };
    const rows = source.map((p) => ({ cell: { x: p.x, y: 0, z: p.z } as Emit }));
    const cells: { cell: Wheel }[] = rows.map((row) => ({ cell: row.cell }));
    if (holder.points[0]!.x !== 1 || holder.first.at.z !== 7 || cells[0]!.cell.z !== 3) throw new Error("fresh members");
`,
);

check(
    "shared-arrays-in-nested-members-of-another-record-type-stay-one-array",
    `
    interface Emit { x: number; y: number; z: number }
    interface Wheel { x: number; z: number; label?: string }
    interface Holder { points: Wheel[] }
    const points: Emit[] = [{ x: 1, y: 2, z: 3 }];
    const holder: Holder = { points };
    const outer: { inner: Holder } = { inner: { points } };
    const flag = points.length > 0;
    const chosen: Holder = { points: flag ? points : [] };
    const base = { points };
    const spread: Holder = { ...base };
    const lists: Wheel[][] = [points];
    function make(): { points: Emit[] } { return { points }; }
    const made: Holder = make();
    points.push({ x: 4, y: 5, z: 6 });
    if (holder.points !== points || outer.inner.points !== points || chosen.points !== points || spread.points !== points || lists[0] !== points || made.points !== points)
        throw new Error("one array under every member type");
    holder.points[1]!.label = "rear";
    if (holder.points.length !== 2 || (points[1] as Wheel).label !== "rear") throw new Error("one array, one record");
`,
);
check(
    "record-tuple-fields-stored-in-number-array-containers",
    `
    interface H { pos: [number, number] }
    const h: H = { pos: [1, 2] };
    const store: number[][] = [];
    store.push(h.pos);
    store[0]!.push(3);
    if (h.pos.length !== 3 || store[0] !== h.pos) throw new Error("one growable array");
`,
);

test("tuple parameters stored as growable number arrays need growable storage", () => {
    assert.throws(
        () =>
            compileSource(`const store: number[][] = [];
            function keep(lane: [number, number]): void { store.push(lane); }
            const lanes: Array<[number, number]> = [[1, 2], [3, 4]];
            for (const lane of lanes) keep(lane);`),
        /fixed-length tuple stored as a number array could grow through that array/,
    );
});

check(
    "array-callbacks-walk-the-receiver-and-length-read-at-the-call",
    `
    const seen: number[] = [];
    const popped: number[] = [1, 2, 3, 4];
    popped.forEach((value, index, array) => { seen.push(value); if (index === 0) array.pop(); });
    if (seen.join() !== "1,2,3" || popped.length !== 3) throw new Error("forEach skips a popped index");
    const grown: number[] = [1, 2];
    let visits = 0;
    grown.forEach((value, _index, array) => { visits++; array.push(value * 10); });
    if (visits !== 2 || grown.join() !== "1,2,10,20") throw new Error("forEach visits the length read at the call");
    const truncated: number[] = [1, 2, 3, 4];
    const probed: number[] = [];
    const any = truncated.some((value) => { probed.push(value); truncated.length = 2; return false; });
    if (any || probed.join() !== "1,2") throw new Error("some skips truncated indices");
    const spliced: number[] = [5, 6, 7];
    const tested: number[] = [];
    const all = spliced.every((value, index, array) => { tested.push(value); array.splice(index, 1); return value > 0; });
    if (!all || tested.join() !== "5,7" || spliced.join() !== "6") throw new Error("every skips spliced indices");
    const replaced: number[] = [1, 2, 3, 4];
    const kept = replaced.filter((value, index, array) => { array[index] = -value; if (index === 1) array.pop(); return value > 1; });
    if (kept.join() !== "2,3" || replaced.join() !== "-1,-2,-3") throw new Error("filter keeps the value it read");
    const scanned: number[] = [1, 2, 3];
    const found = scanned.find((value, index, array) => { array[index] = 0; return value === 2; });
    if (found !== 2 || scanned.join() !== "0,0,3") throw new Error("find keeps the value it read");
    const summed: number[] = [1, 2, 3, 4];
    const total = summed.reduce((sum, value, index, array) => { if (index === 0) array.splice(2); return sum + value; }, 0);
    if (total !== 3) throw new Error("seeded reduce skips removed indices");
    const unseeded: number[] = [1, 2, 3, 4];
    const partial = unseeded.reduce((sum, value, _index, array) => { array.pop(); return sum + value; });
    if (partial !== 6) throw new Error("unseeded reduce skips removed indices");
    const shifted: number[] = [1, 2, 3, 4];
    const fromRight = shifted.reduceRight((sum, value, _index, array) => { array.shift(); return sum + value; }, 0);
    if (fromRight !== 16 || shifted.length !== 0) throw new Error("reduceRight reads each index still present");
    const flattened: number[] = [1, 2, 3];
    const pairs = flattened.flatMap((value, _index, array) => { array.length = 1; return [value, value]; });
    if (pairs.join() !== "1,1") throw new Error("flatMap skips truncated indices");
    let rebound: number[] = [1, 2, 3];
    const original = rebound;
    const order: number[] = [];
    rebound.forEach((value) => { order.push(value); rebound = []; });
    if (order.join() !== "1,2,3" || rebound.length !== 0 || original.length !== 3) throw new Error("the walk keeps the receiver it started with");
    const listed: number[] = [1, 2, 3, 4];
    function drop(): void { listed.pop(); }
    const survivors = listed.filter(() => { drop(); return true; });
    if (survivors.join() !== "1,2" || listed.length !== 2) throw new Error("a called function shrinks the receiver");
    const ordered: number[] = [3, 1, 2];
    const sorted = ordered.sort((a, b) => { if (ordered.length > 2) ordered.pop(); return a - b; });
    if (sorted !== ordered || ordered.join() !== "1,2,3") throw new Error("sort writes back the values it collected");
`,
);

check(
    "array-callbacks-shrinking-the-receiver-through-a-wider-alias",
    `
    const queue: number[] = [];
    queue.push(1, 2, 3, 4);
    const view: unknown[] = queue;
    const seen: number[] = [];
    queue.forEach((value) => { seen.push(value); view.length = 2; });
    if (seen.join() !== "1,2" || queue.length !== 2) throw new Error("an unknown[] alias truncates the receiver");
    function drain<L extends number[]>(list: L, alias: L): number {
        let visits = 0;
        list.forEach(() => { alias.pop(); visits++; });
        return visits;
    }
    const items: number[] = [];
    items.push(5, 6, 7, 8);
    if (drain(items, items) !== 2 || items.length !== 2) throw new Error("a type-parameter alias pops the receiver");
    function clear<T>(list: T[], alias: T[]): T[] {
        return list.filter(() => { alias.length = 1; return true; });
    }
    const words: string[] = [];
    words.push("a", "b", "c");
    if (clear(words, words).join() !== "a" || words.length !== 1) throw new Error("a generic alias truncates the receiver");
    const scores: number[] = [];
    scores.push(3, 1, 2);
    const loose: unknown[] = scores;
    const sorted = scores.sort((a, b) => { if (loose.length > 2) loose.pop(); return a - b; });
    if (sorted !== scores || scores.join() !== "1,2,3") throw new Error("an unknown[] alias shrinks the sorted receiver");
`,
);

check(
    "array-callbacks-writing-other-objects-walk-the-receiver",
    `
    interface Item { id: string; weight: number; disposed: boolean }
    class Model {
        public total = 0;
        public disposed = false;
        add(values: number[]): void { values.forEach((x) => (this.total += x)); }
        dispose(): void { this.disposed = true; }
    }
    const items: Item[] = [{ id: "a", weight: 1, disposed: false }, { id: "b", weight: 2, disposed: false }];
    const byId = items.reduce((acc, item) => { acc[item.id] = item; return acc; }, {} as Record<string, Item>);
    byId["b"]!.weight = 7;
    if (items[1]!.weight !== 7) throw new Error("the accumulator keeps the element identity");
    const models = [new Model(), new Model()];
    models.forEach((m) => m.dispose());
    models[0]!.add([1, 2, 3]);
    const heavy = items.filter((item) => { item.weight += 1; return item.weight > 2; });
    const counts = new Map<string, number>();
    items.forEach((item) => counts.set(item.id, item.weight));
    if (!models[1]!.disposed || models[0]!.total !== 6 || heavy.length !== 1 || heavy[0] !== items[1] || counts.get("a") !== 2)
        throw new Error("callbacks writing records, instances and maps");
`,
);

check(
    "spreads-and-sequence-copies-read-one-iteration-protocol",
    `
    type Vec3 = [number, number, number];
    const lanes: Vec3 = [4, 9, 2];
    if (Math.max(...lanes) !== 9 || Math.min(...lanes) !== 2) throw new Error("Math over a numeric tuple");
    const set = new Set<number>([5, -1, 3]);
    if (Math.max(...set) !== 5 || Math.min(...set.values()) !== -1) throw new Error("Math over a Set and its iterator");
    interface Holder { pos: [number, number] }
    function holderAt(x: number): Holder { return { pos: [x, x + 1] }; }
    const holder = holderAt(3);
    holder.pos[1] = 4;
    if (Math.hypot(...holder.pos) !== 5) throw new Error("tuple field spread into a rest pack");
    function total(...items: number[]): number {
        let sum = 0;
        for (const item of items) sum += item;
        return sum;
    }
    const totals: Array<(...items: number[]) => number> = [total];
    const typed = new Uint8Array([1, 2]);
    if (totals[0]!(...set, ...typed, ...holder.pos, 10) !== 27) throw new Error("rest pack over a Set, a typed array and a tuple field");
    function letters(...items: string[]): string { return items.join("-"); }
    const named: Array<(...items: string[]) => string> = [letters];
    if (named[0]!(..."ab", "c") !== "a-b-c") throw new Error("rest pack over a string");
    const fromValues = new Float32Array(set.values());
    const fromIterator = Float64Array.from(set.values());
    if (fromValues.join() !== "5,-1,3" || fromIterator.join() !== "5,-1,3") throw new Error("typed arrays from an iterator");
    if (Array.from(typed).join() !== "1,2" || Array.from(lanes).length !== 3) throw new Error("Array.from over sequences");
`,
);

check(
    "asserted-wrappers-keep-never-calls-and-narrowed-tag-filters",
    `
    function fail(message: string): never { throw new Error(message); }
    function pick(flag: boolean): number { if (flag) return 1; return fail("no pick") as number; }
    function label(flag: boolean): string { if (flag) return "yes"; return fail("no label") satisfies never; }
    function guard(flag: boolean): void { if (!flag) fail("bad") as void; }
    let caught = "";
    try { pick(false); } catch (error) { caught += (error as Error).message; }
    try { label(false); } catch (error) { caught += "," + (error as Error).message; }
    try { guard(false); } catch (error) { caught += "," + (error as Error).message; }
    if (pick(true) !== 1 || label(true) !== "yes" || caught !== "no pick,no label,bad") throw new Error(caught);
    type Tag = "a" | "b" | "c";
    type Narrow = "a" | "b";
    function isNarrow(tag: Tag): tag is Narrow { return tag !== "c"; }
    const tags: Tag[] = ["a", "c", "b"];
    const asserted: Narrow[] = tags.filter(isNarrow) as Narrow[];
    const checked: Narrow[] = tags.filter(isNarrow) satisfies Narrow[];
    const record: { values: Narrow[] } = { values: tags.filter(isNarrow) as Narrow[] };
    function narrowed(): Narrow[] { return tags.filter(isNarrow) as Narrow[]; }
    if (asserted.join() !== "a,b" || checked.join() !== "a,b" || record.values.join() !== "a,b" || narrowed().join() !== "a,b")
        throw new Error("narrowed tag filters through assertions");
`,
);

checkInRealm(
    "settled-records-enumerate-the-keys-their-tags-select",
    `
    setTimeout(() => {
        void (async () => {
            const failure = new RangeError("first");
            const settled = await Promise.allSettled([Promise.resolve(3), Promise.reject(failure)]);
            const rejected = settled[1]!;
            if (rejected.status !== "rejected" || rejected.reason !== failure) throw new Error("rejection");
            if (Object.keys(rejected).join() !== "status,reason") throw new Error("rejected keys " + Object.keys(rejected).join());
            const keys: string[] = [];
            for (const entry of settled) keys.push(Object.keys(entry).join("+"));
            if (keys.join() !== "status+value,status+reason") throw new Error("keys per element " + keys.join());
            if (!("value" in settled[0]!) || "reason" in settled[0]!) throw new Error("membership");
            globalThis.close();
        })();
    }, 0);
`,
);

check(
    "array-length-follows-every-alias-that-can-resize",
    `
    const local = [1, 2];
    const alias = local;
    alias.push(3);
    if (local.length !== 3) throw new Error("local alias " + local.length);
    const sorted = [2, 1];
    const view = sorted.sort();
    view.pop();
    if (sorted.length !== 1) throw new Error("returned receiver alias " + sorted.length);
    const fielded: number[] = [1, 2];
    const holder = { items: fielded };
    holder.items.push(4);
    if (fielded.length !== 3) throw new Error("field alias " + fielded.length);
    const captured: number[] = [1, 2];
    let later: number[] = [];
    const grow = (): void => { later.push(5); };
    later = captured;
    grow();
    if (captured.length !== 3) throw new Error("captured alias " + captured.length);
    function append(list: number[]): void { list.push(6); }
    const passed: number[] = [1, 2];
    const forwarded = passed;
    append(forwarded);
    if (passed.length !== 3) throw new Error("callee alias " + passed.length);
    class Bag { constructor(public items: number[]) {} grow(): void { this.items.push(7); } }
    const owned: number[] = [1, 2];
    new Bag(owned).grow();
    if (owned.length !== 3) throw new Error("constructed alias " + owned.length);
    const grown = [1, 2];
    grown[2] = 3;
    if (grown.length !== 3) throw new Error("element growth " + grown.length);
    const kept = [1, 2];
    kept[1] = 5;
    const reader = kept;
    let sum = 0;
    for (let index = 0; index < kept.length; index++) sum += reader[index]!;
    if (kept.length !== 2 || sum !== 6) throw new Error("in-range writes keep the length");
`,
);

check(
    "element-store-keys-evaluate-before-the-right-side",
    `
    const order: string[] = [];
    function key(name: string, value: number): number { order.push(name); return value; }
    function right(name: string, value: number): number { order.push(name); return value; }
    const names: string[] = ["a", "b", "c"];
    let j = 0;
    names[j++] = String(j);
    if (names.join() !== "1,b,c" || j !== 1) throw new Error("array " + names.join());
    const yielded = (names[j++] = String(j));
    if (yielded !== "2" || names.join() !== "1,2,c") throw new Error("array value " + names.join());
    const numbers = [10, 20, 30];
    numbers[key("k", 1)] = right("r", 5);
    if (order.join() !== "k,r" || numbers.join() !== "10,5,30") throw new Error("call order " + order.join());
    const floats = new Float32Array(3);
    let k = 0;
    floats[k++] = k + 10;
    if (floats[0] !== 11 || floats[1] !== 0) throw new Error("typed " + Array.from(floats).join());
    const table: Record<string, number> = {};
    let m = 0;
    table["k" + m++] = m;
    if (table["k0"] !== 1 || table["k1"] !== undefined) throw new Error("record " + JSON.stringify(table));
    const slots: Record<"left" | "right", number> = { left: 0, right: 0 };
    let side: "left" | "right" = "left";
    function flip(): number { side = "right"; return 4; }
    slots[side] = flip();
    if (slots.left !== 4 || slots.right !== 0) throw new Error("keyed fields " + slots.left + "," + slots.right);
    const tuple: [number, number] = [0, 0];
    let n = 0;
    tuple[n++] = n;
    if (tuple[0] !== 1 || tuple[1] !== 0) throw new Error("tuple " + tuple.join());
    const counts = [1, 2, 3];
    let p = 0;
    function bump(): number { p += 5; return 100; }
    counts[p++] += bump();
    if (counts.join() !== "101,2,3" || p !== 6) throw new Error("compound " + counts.join() + " " + p);
    const powers = [2, 3];
    let q = 0;
    powers[q++] **= 2;
    if (powers.join() !== "4,3" || q !== 1) throw new Error("helper compound " + powers.join() + " " + q);
    const totals = [1, 1];
    function reset(): number { totals[0] = 50; return 1; }
    totals[0] += reset();
    if (totals[0] !== 2) throw new Error("compound reads before the right side " + totals.join());
    const grid = [[0, 0], [0, 0]];
    let c = 0;
    grid[1]![c++] = c;
    if (grid[1]!.join() !== "1,0") throw new Error("nested " + grid[1]!.join());
    interface Row { x: number }
    const rows: Row[] = [{ x: 0 }, { x: 0 }];
    let r = 0;
    rows[r++]!.x = r;
    if (rows[0]!.x !== 1 || rows[1]!.x !== 0) throw new Error("row field " + rows[0]!.x);
`,
);

// The checks accumulate into a string: passing an array to a call is an
// escape of its own, which would hide the one under test.
check(
    "arrays-escaping-into-other-owners-stay-one-array",
    `
    let failed = "";
    const fielded = [1, 2];
    const holder = { items: fielded };
    holder.items.push(4);
    if (fielded.length !== 3 || fielded[2] !== 4) failed += "field;";
    const nested = [1, 2];
    const deep = { outer: { inner: nested } };
    deep.outer.inner.push(5);
    if (nested.length !== 3) failed += "nested literal;";
    const element = [1, 2];
    const lists = [element, [9]];
    lists[0]!.push(6);
    if (element.length !== 3) failed += "array element;";
    const written = [1, 2];
    const wrapper = { items: written };
    wrapper.items[0] = 7;
    if (written[0] !== 7) failed += "element write through a field;";
    function grow(target: { items: number[] }): void { target.items.push(8); }
    const passed = [1, 2];
    grow({ items: passed });
    if (passed.length !== 3) failed += "argument to a callee that pushes;";
    const captured = [1, 2];
    const read = (): number[] => captured;
    read().push(9);
    const append = (value: number): void => { captured.push(value); };
    append(10);
    if (captured.length !== 4 || captured[3] !== 10) failed += "captured closure;";
    const returned = [1, 2];
    function make(): { items: number[] } { return { items: returned }; }
    make().items.push(11);
    if (returned.length !== 3) failed += "returned record;";
    class Bag { constructor(public items: number[]) {} }
    const constructed = [1, 2];
    new Bag(constructed).items.push(12);
    if (constructed.length !== 3) failed += "constructor argument;";
    let flag = true;
    const selected = [1, 2];
    const chosen = { items: flag ? selected : [0] };
    chosen.items.pop();
    if (selected.length !== 1) failed += "selected field;";
    flag = false;
    if (failed) throw new Error(failed);
`,
);

check(
    "stored-function-extra-arguments-are-read-and-ignored",
    `
    function inner(
        count: number,
        canConnect: (ax: number, az: number, bx: number, bz: number, member: number, next: number) => boolean,
    ): number {
        let hits = 0;
        for (let member = 0; member < count; member++)
            if (canConnect(member, member + 1, member * 2, member * 3, member, member + 1)) hits++;
        return hits;
    }
    function outer(count: number, canSee: (ax: number, az: number, bx: number, bz: number) => boolean): number {
        return inner(count, canSee);
    }
    const outers: Array<typeof outer> = [outer];
    if (outers[0]!(3, (a, b, c, d) => a + b + c + d > 4) !== 2) throw new Error("narrow callback through a wider parameter");
    const order: string[] = [];
    function note(label: string, value: number): number { order.push(label); return value; }
    function callWide(f: (a: number, b: number, c: number) => number): number {
        return f(note("a", 1), note("b", 2), note("c", 3));
    }
    function callNarrow(g: (a: number) => number): number { return callWide(g); }
    const narrows: Array<typeof callNarrow> = [callNarrow];
    if (narrows[0]!((a) => a * 2) !== 2) throw new Error("extra arguments reach no parameter");
    if (order.join(",") !== "a,b,c") throw new Error("extra arguments evaluated once, in order: " + order.join(","));
    let counter = 0;
    const bump = (): number => ++counter;
    function callTwice(f: (a: number, b: number) => number): number { return f(bump(), bump()); }
    function callOnce(g: (a: number) => number): number { return callTwice(g); }
    const onces: Array<typeof callOnce> = [callOnce];
    if (onces[0]!((a) => a * 10 + counter) !== 12 || counter !== 2) throw new Error("extra argument effects " + counter);
`,
);

test("stored function storage refuses values reading arguments it drops", () => {
    for (const source of [
        `const stores: Array<(a: number) => number> = [(a, b = 7) => a + b];
        const wide: Array<(a: number, b: number) => number> = [stores[0]!];
        if (wide[0]!(1, 2) !== 3) throw new Error("x");`,
        `function callWide(f: (a: number, b: number) => number): number { return f(1, 2); }
        const narrow: Array<(a: number) => number> = [(a) => a];
        const first = callWide(narrow[0]!);
        const later: Array<(a: number) => number> = [(a, b = 7) => a + b];
        if (first + later[0]!(1) !== 9) throw new Error("x");`,
    ])
        assert.throws(
            () => compileSource(source),
            /reading arguments past its storage signature cannot share that signature with calls passing more arguments/,
        );
});

check(
    "stored-function-spread-of-an-optional-lane-tuple",
    `
    type Pose = readonly [dx: number, dy: number, dz: number, yaw?: number, pivotX?: number];
    interface Batch { shiftKey(key: number, dx: number, dy: number, dz: number, yaw?: number, pivotX?: number): void }
    function reapply(batch: Pick<Batch, "shiftKey">, seqs: readonly number[], read: (seq: number) => Pose): number {
        let applied = 0;
        for (const seq of seqs) {
            const delta = read(seq);
            batch.shiftKey(seq, ...delta);
            applied++;
        }
        return applied;
    }
    const reapplies: Array<typeof reapply> = [reapply];
    const log: string[] = [];
    const batch: Batch = {
        shiftKey: (key, dx, dy, dz, yaw = 0, pivotX?: number) => {
            log.push(key + ":" + (dx + dy + dz) + ":" + yaw + ":" + (pivotX === undefined ? "none" : pivotX));
        },
    };
    const count = reapplies[0]!(batch, [1, 2], (seq) => (seq === 1 ? [1, 2, 3] : [4, 5, 6, 0.5, 7]));
    if (count !== 2 || log.join(",") !== "1:6:0:none,2:15:0.5:7") throw new Error("tuple lanes " + log.join(","));
`,
);

check(
    "function-valued-union-fields-and-parameters",
    `
    interface CellFillDeps { cell: number | (() => number); radius(): number; }
    function makeStamp(deps: CellFillDeps): { stamp(cx: number): number } {
        return {
            stamp(cx) {
                const cell = typeof deps.cell === "function" ? deps.cell() : deps.cell;
                return cx * cell + deps.radius();
            },
        };
    }
    const stamps: Array<typeof makeStamp> = [makeStamp];
    let spacing = 2;
    const live = stamps[0]!({ cell: () => spacing, radius: () => 1 });
    if (live.stamp(3) !== 7) throw new Error("function arm");
    spacing = 5;
    if (live.stamp(3) !== 16) throw new Error("function arm reads live state");
    if (stamps[0]!({ cell: 4, radius: () => 1 }).stamp(3) !== 13) throw new Error("number arm");
    function row(enabled: boolean | (() => boolean) = true): string {
        const isEnabled = typeof enabled === "function" ? enabled() : enabled;
        return String(!isEnabled);
    }
    const rows: Array<typeof row> = [row];
    let gate = true;
    if (rows[0]!() !== "false" || rows[0]!(false) !== "true" || rows[0]!(() => gate) !== "false")
        throw new Error("boolean or getter parameter");
    gate = false;
    if (rows[0]!(() => gate) !== "true") throw new Error("getter parameter reads live state");
`,
);

test("a union with several function arms refuses a function value", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Slot { pick: number | (() => number) | ((value: number) => number) }
            const slots: Slot[] = [{ pick: () => 1 }];
            if (slots.length !== 1) throw new Error("x");`),
        /does not match the expected data union/,
    );
});

check(
    "recursive-function-varying-literal-argument",
    `
    function makeLoop(limit: number): { begin(): void; log: string[] } {
        const log: string[] = [];
        let runs = 0;
        function start(fadeIn: boolean): void {
            runs++;
            log.push(fadeIn ? "in" : "cut");
            if (runs < limit) retry();
        }
        function retry(): void { start(false); }
        return { begin: () => start(true), log };
    }
    const loop = makeLoop(3);
    loop.begin();
    if (loop.log.join(",") !== "in,cut,cut") throw new Error("recursive literal argument " + loop.log.join(","));
    function countdown(label: string, n: number): string {
        return n === 0 ? label : countdown(label, n - 1) + label;
    }
    if (countdown("x", 2) !== "xxx") throw new Error("same literal recursion");
`,
);

check(
    "function-call-with-this-and-partial-bind",
    `
    function f(this: { k: number }, n: number): number { return this.k + n; }
    if (f.call({ k: 1 }, 2) !== 3) throw new Error("call with this");
    interface Counter { k: number }
    function bump(this: Counter, by: number): number { this.k += by; return this.k; }
    const counters: Counter[] = [{ k: 1 }];
    if (bump.call(counters[0]!, 2) !== 3 || counters[0]!.k !== 3) throw new Error("call writes through this");
    function add(a: number, b: number): number { return a + b; }
    const inc = add.bind(null, 1);
    if (inc(2) !== 3) throw new Error("bind partial");
    const order: string[] = [];
    function trace(label: string, value: number): number { order.push(label); return value; }
    const three = (a: number, b: number, c: number): number => a * 100 + b * 10 + c;
    const fns: Array<typeof three> = [three];
    const bound = fns[0]!.bind(null, trace("a", 1), trace("b", 2));
    if (order.join(",") !== "a,b") throw new Error("bound arguments read at bind");
    if (bound(trace("c", 3)) !== 123 || bound(4) !== 124 || order.join(",") !== "a,b,c")
        throw new Error("bound arguments read once " + order.join(","));
    if (inc === add.bind(null, 1)) throw new Error("bind identity");
`,
);

test("an imported typed array answers its methods where it is read", async (t) => {
    const directory = resolve("artifacts/imported-typed-array-methods");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "matrix.ts"),
        `export const IDENTITY = new Float32Array([1, 0, 0, 1]);`,
    );
    const result = compileSource(
        `import { IDENTITY } from "./matrix.js";
        class Frame {
            point(x: number): Float32Array {
                const matrix = IDENTITY.slice(), first = IDENTITY.indexOf(1);
                matrix[1] = x + first;
                return matrix;
            }
        }
        const frames: Frame[] = [new Frame()];
        const placed = frames[0]!.point(3);
        if (placed[1] !== 3 || IDENTITY[1] !== 0 || placed === IDENTITY) throw new Error("imported typed array slice");`,
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(
        t,
        "imported-typed-array-methods",
        result.cpp,
    );
});

checkInRealm(
    "closures-calling-each-other-through-record-callbacks",
    `
    type Decision = "quit" | "cancel";
    interface Deps {
        decide: (decision: Decision) => void;
        showConfirm: (opts: { onSave: () => void; onCancel: () => void }) => void;
        save: () => Promise<boolean> | boolean;
    }
    interface Attempt { phase: "confirm" | "saving"; }
    function createGate(deps: Deps): () => void {
        let active: Attempt | null = null;
        const showConfirm = (attempt: Attempt): void => {
            if (active !== attempt) return;
            attempt.phase = "confirm";
            deps.showConfirm({
                onSave: () => { if (active === attempt && attempt.phase === "confirm") save(attempt); },
                onCancel: () => { if (active === attempt) { active = null; deps.decide("cancel"); } },
            });
        };
        const save = (attempt: Attempt): void => {
            attempt.phase = "saving";
            void Promise.resolve()
                .then(() => deps.save())
                .then(
                    (saved) => {
                        if (active !== attempt) return;
                        if (saved === true) { active = null; deps.decide("quit"); }
                        else showConfirm(attempt);
                    },
                    () => showConfirm(attempt),
                );
        };
        return () => {
            if (active !== null) return;
            const attempt: Attempt = { phase: "confirm" };
            active = attempt;
            showConfirm(attempt);
        };
    }
    const gates: Array<typeof createGate> = [createGate];
    const decisions: string[] = [];
    let shown = 0;
    let saves = 0;
    const gate = gates[0]!({
        decide: (decision) => {
            decisions.push(decision);
            if (shown !== 2 || saves !== 2 || decisions.join(",") !== "quit") throw new Error("gate " + shown + saves + decisions.join(","));
            globalThis.close();
        },
        showConfirm: (opts) => { shown++; opts.onSave(); },
        save: () => ++saves > 1,
    });
    gate();
    if (shown !== 1 || saves !== 0) throw new Error("save waits for its promise");
`,
);

check(
    "number-as-a-callback-converts-each-value",
    `
    const parsed = JSON.parse('{"errors":[1,"2.5",true,null,"x"]}') as { errors: unknown };
    if (!Array.isArray(parsed.errors)) throw new Error("array");
    const errors = Float32Array.from(parsed.errors.map(Number));
    if (errors[0] !== 1 || errors[1] !== 2.5 || errors[2] !== 1 || errors[3] !== 0 || !Number.isNaN(errors[4]!))
        throw new Error("Number over parsed values");
    const plain = ["1", "", " 4 "].map(Number);
    if (plain.join(",") !== "1,0,4") throw new Error("Number over strings " + plain.join(","));
`,
);

check(
    "void-results-in-bindings-and-generic-memos",
    `
    let builds = 0;
    let stamp = -1;
    let revision = 0;
    const memoized = <T>(build: () => T): (() => T) => {
        let value: T;
        return (): T => {
            if (stamp === revision) return value;
            value = build();
            stamp = revision;
            return value;
        };
    };
    let tops: number[] = [];
    const refresh = memoized((): void => {
        builds++;
        const out: number[] = [];
        for (const v of [1, -2, 3]) {
            if (v < 0) continue;
            out.push(v * revision);
        }
        tops = out;
    });
    refresh();
    refresh();
    revision++;
    refresh();
    if (builds !== 2 || tops.join(",") !== "1,3") throw new Error("memoized void builder " + builds + ":" + tops.join(","));
    function quiet(): void { builds += 10; }
    let done: void;
    done = quiet();
    if (done !== undefined || builds !== 12) throw new Error("void binding");
`,
);

test("a void binding refuses a result without a proven undefined completion", () => {
    assert.throws(
        () =>
            compileSource(`
            const hooks: Array<() => void> = [() => {}];
            let done: void;
            done = hooks[0]!();
            if (done !== undefined) throw new Error("x");`),
        /requires a proven undefined completion/,
    );
});

check(
    "string-literal-union-truthiness",
    `
    type Status = "" | "earned" | "missing";
    function shown(status: Status, flags: Status[]): number {
        return flags.filter((flag) => !status || flag === status).length;
    }
    const counters: Array<typeof shown> = [shown];
    if (counters[0]!("", ["earned", "missing"]) !== 2 || counters[0]!("earned", ["earned", "missing"]) !== 1)
        throw new Error("string-literal union truthiness");
    type Mode = "on" | "off";
    function enabled(mode: Mode): boolean { return mode ? true : false; }
    const modes: Array<typeof enabled> = [enabled];
    if (!modes[0]!("off")) throw new Error("a union without an empty member is always truthy");
`,
);

check(
    "type-parameters-only-in-a-constraint-take-the-constraint",
    `
    interface Desired { key: string }
    interface Slot<D extends Desired> { active: boolean; target: number; pending: D | null }
    function fadeOut<D extends Desired, S extends Slot<D>>(states: readonly S[], xOf: (state: S) => number): number {
        let faded = 0;
        for (const state of states) if (state.active && xOf(state) > 0) { state.target = 0; state.pending = null; faded++; }
        return faded;
    }
    interface Lily extends Slot<Desired> { x: number }
    const lilies: Lily[] = [{ active: true, target: 1, pending: { key: "a" }, x: 2 }, { active: true, target: 1, pending: null, x: -1 }];
    if (fadeOut(lilies, (lily) => lily.x) !== 1 || lilies[0]!.target !== 0 || lilies[1]!.target !== 1)
        throw new Error("type parameter only in a constraint");
`,
);

test("a type parameter no argument determines and no constraint fixes still refuses", () => {
    assert.throws(
        () =>
            compileSource(`
            function first<D, S extends { value: D }>(items: readonly S[]): number { return items.length; }
            const counted = first([{ value: 1 }]);
            if (counted !== 1) throw new Error("x");`),
        /Type parameter 'D' is not determined by this call's arguments/,
    );
});

checkInRealm(
    "value-or-promise-results-are-awaited-as-either-arm",
    `
    type Result = { changed: true; hostId: number } | { changed: false; reason: "stale" | "missing" };
    type MaybeAsync<T> = T | Promise<T>;
    function createCommand(deps: { read(id: number): { mix: number } | undefined; prepare: () => Promise<void> }) {
        const refused = (reason: "stale" | "missing"): Result => ({ changed: false, reason });
        const publish = (id: number, slow: boolean): MaybeAsync<Result> => {
            if (slow)
                return (async (): Promise<Result> => {
                    await deps.prepare();
                    return { changed: true, hostId: id };
                })();
            return { changed: true, hostId: id };
        };
        const pick = (id: number, slow: boolean): MaybeAsync<Result> => {
            const record = deps.read(id);
            if (!record) return refused("missing");
            if (record.mix < 0) return refused("stale");
            return publish(id, slow);
        };
        return {
            preview: (id: number): MaybeAsync<Result> => pick(id, false),
            commit: async (id: number): Promise<boolean> => (await pick(id, true)).changed,
        };
    }
    const creates: Array<typeof createCommand> = [createCommand];
    let prepared = 0;
    const command = creates[0]!({ read: (id) => (id > 0 ? { mix: id - 2 } : undefined), prepare: async () => { prepared++; } });
    const order: string[] = [];
    void (async () => {
        const quick = await command.preview(3);
        order.push("quick:" + quick.changed);
        const missing = await command.preview(0);
        order.push("missing:" + (missing.changed ? "" : missing.reason));
        const committed = await command.commit(4);
        order.push("commit:" + committed + ":" + prepared);
        const stale = await command.commit(1);
        order.push("stale:" + stale);
        if (order.join(",") !== "quick:true,missing:missing,commit:true:1,stale:false") throw new Error(order.join(","));
        globalThis.close();
    })();
`,
);

check(
    "function-objects-given-properties-are-callable-records",
    `
    type Source = (() => number) & { onResize?: (callback: () => void) => () => void };
    type Binding = (() => void) & { dispose(): void };
    function constantSource(value: number): Source {
        return Object.assign(() => value * 2, {
            onResize: (callback: () => void) => { callback(); return () => { value = -1; }; },
        });
    }
    function bind(source: Source, log: number[]): Binding {
        let disposed = false;
        const refresh = (): void => { if (!disposed) log.push(source()); };
        refresh();
        const unsubscribe = source.onResize?.(refresh);
        const dispose = (): void => { disposed = true; unsubscribe?.(); };
        return Object.assign(refresh, { dispose });
    }
    const binds: Array<typeof bind> = [bind];
    const log: number[] = [];
    const source = constantSource(3);
    const binding = binds[0]!(source, log);
    binding();
    if (typeof binding !== "function" || typeof source !== "function") throw new Error("typeof callable record");
    binding.dispose();
    binding();
    if (log.join(",") !== "6,6,6" || source() !== -2) throw new Error("callable record calls " + log.join(","));
    const callbacks: Array<() => void> = [binding];
    callbacks[0]!();
    if (log.length !== 3) throw new Error("callable record as a function value");
    function wrap(): { binding: Binding; refresh: () => void } {
        const refresh = (): void => {};
        return { binding: Object.assign(refresh, { dispose: () => {} }), refresh };
    }
    const wrapped = wrap();
    const other = wrap();
    if (wrapped.binding !== wrapped.refresh || wrapped.binding === other.binding || other.refresh === wrapped.binding)
        throw new Error("a callable record is the function it calls");
`,
);

check(
    "rest-parameters-of-fixed-tuples-bind-their-lanes",
    `
    type Vec3 = readonly [number, number, number];
    interface Clearance { isClear(a: Vec3, b: Vec3, sag: number, label: string): boolean; }
    function create(options: { limit: () => number }): Clearance {
        const isClear = (limit: number, ...[a, b, sag, label]: Parameters<Clearance["isClear"]>): boolean =>
            a[0] + b[0] + sag < limit && label.length > 0;
        return { isClear: (...args) => isClear(options.limit(), ...args) };
    }
    const creates: Array<typeof create> = [create];
    let limit = 10;
    const clearance = creates[0]!({ limit: () => limit });
    if (!clearance.isClear([1, 0, 0], [2, 0, 0], 3, "x")) throw new Error("tuple rest lanes");
    limit = 5;
    if (clearance.isClear([1, 0, 0], [2, 0, 0], 3, "x") || clearance.isClear([0, 0, 0], [0, 0, 0], 1, ""))
        throw new Error("tuple rest lanes read live");
`,
);

test("a rest object pattern keeps refusing", () => {
    assert.throws(
        () =>
            compileSource(`
            function count(...{ length }: number[]): number { return length; }
            if (count(1, 2) !== 2) throw new Error("x");`),
        /A rest parameter is the last parameter and an identifier or array pattern/,
    );
});

check(
    "phantom-branded-objects-keep-their-object",
    `
    declare const keyBrand: unique symbol;
    type Key = Readonly<{ readonly [keyBrand]: true }>;
    class Holder { text = ""; }
    function issue(text: string): Key {
        const holder = new Holder();
        holder.text = text;
        return holder as unknown as Key;
    }
    function rename(key: Key, text: string): void { (key as unknown as Holder).text = text; }
    function read(key: Key): string { return (key as unknown as Holder).text; }
    const issues: Array<typeof issue> = [issue];
    const renames: Array<typeof rename> = [rename];
    const reads: Array<typeof read> = [read];
    const first = issues[0]!("a");
    const second = issues[0]!("a");
    const keys: Key[] = [first, second];
    renames[0]!(keys[0]!, "b");
    if (reads[0]!(first) !== "b" || reads[0]!(second) !== "a" || keys[0] !== first || first === second)
        throw new Error("branded identity");
`,
);

test("a phantom brand asserted from several object types refuses", () => {
    assert.throws(
        () =>
            compileSource(`
            declare const brand: unique symbol;
            type Key = Readonly<{ readonly [brand]: true }>;
            class A { a = 1; }
            class B { b = 2; }
            const keys: Key[] = [new A() as unknown as Key, new B() as unknown as Key];
            if (keys.length !== 2) throw new Error("x");`),
        /Compile-time record is missing required field '__@brand/,
    );
});

check(
    "object-assign-copies-methods-without-this",
    `
    type Predicate = (a: number, b: number) => boolean;
    interface Read { surfaces(): number; isClear: Predicate }
    type Clear = Predicate & { read(): Read };
    function create(limit: () => number): Clear {
        const predicateFor = (offset: number): Predicate => (a, b) => a + b + offset < limit();
        return Object.assign(predicateFor(0), {
            read(): Read {
                const surfaces = limit();
                return { surfaces: () => surfaces, isClear: predicateFor(1) };
            },
        });
    }
    const creates: Array<typeof create> = [create];
    let bound = 5;
    const clear = creates[0]!(() => bound);
    const read = clear.read();
    bound = 6;
    if (!clear(1, 2) || clear(3, 3) || !read.isClear(1, 3) || read.surfaces() !== 5 || clear.read().surfaces() !== 6)
        throw new Error("methods copied by Object.assign");
    const merged = Object.assign({ base: 1 }, { twice(value: number): number { return value * 2; } });
    if (merged.twice(merged.base) !== 2) throw new Error("method copied into a record");
`,
);

test("Object.assign refuses a source method reading this", () => {
    assert.throws(
        () =>
            compileSource(`
            const target = { value: 1 };
            const merged = Object.assign(target, { read(): number { return this.value; } });
            if (merged.read() !== 1) throw new Error("x");`),
        /this source's accessors or methods are not represented/,
    );
});

check(
    "void-operator-and-proven-undefined-results",
    `
    let calls = 0;
    function touch(): void { calls++; }
    const v = void 0;
    const w = void touch();
    if (v !== undefined || w !== undefined || calls !== 1) throw new Error("void operator");
    function apply<T>(deps: { finish(): T; commit(result: T): void }): T {
        const result = deps.finish();
        deps.commit(result);
        return result;
    }
    let committed = 0;
    const done = apply({
        finish: () => undefined,
        commit: (result) => { if (result === undefined) committed++; },
    });
    if (done !== undefined || committed !== 1) throw new Error("generic undefined result");
`,
);

test("a void-typed result without a proven undefined completion refuses", () => {
    assert.throws(
        () =>
            compileSource(
                "const cb: () => void = () => 5; const r = cb(); export {};",
            ),
        /Expression assigned to 'r' does not produce a native value/,
    );
});

check(
    "static-fields-assigned-by-static-blocks",
    `
    class Ids {
        static next: number;
        static label: string;
        static {
            const offset = 2;
            Ids.next = offset * 2;
            this.label = "id";
        }
        static take(): string { return Ids.label + Ids.next++; }
    }
    if (Ids.next !== 4 || Ids.label !== "id") throw new Error("static block assignment");
    if (Ids.take() !== "id4" || Ids.next !== 5) throw new Error("static field storage");
`,
);

test("a static field a static block may read before assigning refuses", () => {
    for (const source of [
        "class C { static n: number; static { const m = [C.n]; C.n = m.length; } } export {};",
        "class C { static n: number; static { C.n = [1].length; } } export {};",
    ])
        assert.throws(
            () => compileSource(source),
            /Static field 'n' has no initializer, so it starts undefined/,
        );
});

check(
    "enum-objects-reverse-and-forward-mappings",
    `
    enum Dir { Up, Down, Left = 10, Right }
    enum Tone { Soft = "soft", Loud = "loud" }
    const picked = [Dir.Down, Dir.Right][1]!;
    if (Dir.Right !== 11 || Dir[picked] !== "Right") throw new Error("reverse mapping");
    const down = [1][0]!;
    if (Dir[down] !== "Down" || Dir[-0] !== "Up") throw new Error("number key");
    const missing = Dir[down + 5];
    if (missing !== undefined) throw new Error("missing reverse key");
    const key = ["Left"][0] as keyof typeof Dir;
    if (Dir[key] !== 10) throw new Error("forward mapping");
    const toneKey = ["Loud"][0] as keyof typeof Tone;
    if (Tone[toneKey] !== "loud") throw new Error("string member");
    function local(index: number): string {
        enum Local { A = 1, B }
        return Local[index] ?? "none";
    }
    if (local(2) !== "B" || local(3) !== "none") throw new Error("local enum");
`,
);

test("an enum object refuses outside member and computed-key reads", () => {
    assert.throws(
        () =>
            compileSource(
                "enum Dir { A, B } const keys = Object.keys(Dir); export {};",
            ),
        /Enum object 'Dir' is a value only as the receiver/,
    );
    assert.throws(
        () =>
            compileSource(
                "function f(): number { enum E { A = 'x'.length } return E.A; } const n = f(); export {};",
            ),
        /needs a runtime enum object/,
    );
});

check(
    "namespace-members-and-merging",
    `
    namespace Geometry {
        export const unit = 2;
        const hidden = unit * 3;
        export let count = 0;
        export function scaled(n: number): number { count++; return n * hidden; }
        export namespace Inner { export const depth = unit + 1; }
    }
    namespace Geometry { export const extra = unit * 10; }
    namespace A.B { export const deep = 7; }
    if (Geometry.unit !== 2 || Geometry.scaled(2) !== 12 || Geometry.count !== 1) throw new Error("members");
    if (Geometry.Inner.depth !== 3 || Geometry.extra !== 20 || A.B.deep !== 7) throw new Error("nesting and merging");
`,
);

test("namespace objects refuse writes and value uses", () => {
    assert.throws(
        () =>
            compileSource(
                "namespace G { export let c = 0; } G.c = 3; export {};",
            ),
        /Namespace member 'c' is written through its own name/,
    );
    assert.throws(
        () =>
            compileSource(
                "namespace G { export const k = 1; } const g = G; export {};",
            ),
        /Namespace object 'G' is a value only as the receiver/,
    );
});

check(
    "tagged-templates-and-string-raw",
    `
    function tag(strings: TemplateStringsArray, ...values: number[]): string {
        return strings.join("|") + values.join(",");
    }
    const x = [1, 2];
    if (tag\`a\${x[0]!}b\${x[1]!}c\` !== "a|b|c1,2") throw new Error("tag call");
    const order: string[] = [];
    function note(label: string, value: number): number { order.push(label); return value; }
    function pair(strings: TemplateStringsArray, first: number, second: number): number {
        order.push("call");
        return strings.length * 100 + first * 10 + second;
    }
    if (pair\`<\${note("first", 1)}|\${note("second", 2)}>\` !== 312) throw new Error("fixed parameters");
    if (order.join(",") !== "first,second,call") throw new Error("substitution order");
    const seen: TemplateStringsArray[] = [];
    function keep(strings: TemplateStringsArray): number {
        seen.push(strings);
        return strings.length;
    }
    for (let i = 0; i < 2; i++) keep\`x\${i}y\`;
    keep\`x\${0}y\`;
    if (seen[0] !== seen[1] || seen[0] === seen[2]) throw new Error("site identity");
    if (seen[0]!.raw[0] !== "x" || seen[0]!.raw !== seen[1]!.raw) throw new Error("raw identity");
    function rawTag(strings: TemplateStringsArray): string { return strings.raw.join("/") + strings.join("/"); }
    if (rawTag\`a\\n\${1}b\` !== "a\\\\n/ba\\n/b") throw new Error("raw and cooked");
    const v = String.raw\`a\\nb\${x[0]!}\`;
    if (v.length !== 5 || v !== "a\\\\nb1") throw new Error("String.raw");
`,
);

test("tagged templates refuse undefined cooked strings and method tags", () => {
    assert.throws(
        () =>
            compileSource(
                "function tag(s: TemplateStringsArray): number { return s.length; } const v = tag`\\unicode`; export {};",
            ),
        /A template escape without a cooked value/,
    );
    assert.throws(
        () =>
            compileSource(
                "const o = { tag(s: TemplateStringsArray): string { return s[0]!; } }; const v = o.tag`x`; export {};",
            ),
        /A template tag is a function named by an identifier/,
    );
});

check(
    "symbol-values-and-symbol-keyed-brands",
    `
    const s = Symbol("k");
    const t = Symbol("k");
    if (s.description !== "k" || s === t || typeof s !== "symbol") throw new Error("identity");
    const alias = s;
    if (alias !== s || !s) throw new Error("alias");
    if (s.toString() !== "Symbol(k)" || String(t) !== "Symbol(k)") throw new Error("text");
    const anonymous = Symbol();
    if (anonymous.description !== undefined || anonymous.toString() !== "Symbol()") throw new Error("anonymous");
    const registered = Symbol.for("app");
    if (registered !== Symbol.for("app") || Symbol.keyFor(registered) !== "app" || Symbol.keyFor(s) !== undefined)
        throw new Error("registry");
    const symbols: symbol[] = [s, t];
    if (symbols.indexOf(t) !== 1 || !symbols.includes(s)) throw new Error("search");
    const brand: unique symbol = Symbol("occluder");
    interface Occluders {
        readonly [brand]: true;
        readonly clips: readonly number[];
        readonly key: string;
    }
    function make(clips: readonly number[]): Occluders {
        const copy = clips.map((clip) => clip * 2);
        return Object.freeze({ [brand]: true as const, clips: Object.freeze(copy), key: copy.join(",") });
    }
    const made = make([1, 2]);
    if (made.key !== "2,4" || made.clips.length !== 2 || made[brand] !== true) throw new Error("brand fields");
    if (Object.keys(made).join(",") !== "clips,key" || JSON.stringify(made) !== '{"clips":[2,4],"key":"2,4"}')
        throw new Error("symbol keys are not string keys");
`,
);

test("a symbol refuses implicit string conversion", () => {
    assert.throws(
        () =>
            compileSource(
                'const s = Symbol("x"); const t = `${s}`; export {};',
            ),
        /A symbol converts to text only through String\(symbol\)/,
    );
});

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
    "generator-delegation-empty-yields-and-iterable-classes",
    `
    function* inner(): Generator<number> { yield 1; yield 2; }
    function* outer(): Generator<number> { yield* inner(); yield* [3, 4]; yield 5; }
    if ([...outer()].join(",") !== "1,2,3,4,5") throw new Error("delegation");
    function* gaps(): Generator<number | undefined> { yield 1; yield; yield 3; }
    const seen: Array<number | undefined> = [];
    for (const value of gaps()) seen.push(value);
    if (seen.length !== 3 || seen[1] !== undefined || seen[2] !== 3) throw new Error("empty yield");
    const log: string[] = [];
    function* guarded(): Generator<number> {
        try { yield 1; yield 2; } finally { log.push("inner closed"); }
    }
    function* delegating(): Generator<number> {
        try { yield* guarded(); yield 9; } finally { log.push("outer closed"); }
    }
    for (const value of delegating()) { if (value === 1) break; }
    if (log.join(",") !== "inner closed,outer closed") throw new Error("return forwarded to the delegate");
    const items = [1, 2];
    function* live(): Generator<number> { yield* items; }
    const iterator = live();
    const first = iterator.next();
    items.push(3);
    if (first.value !== 1 || [...iterator].join(",") !== "2,3") throw new Error("array delegate reads live");
    class Range {
        constructor(private readonly end: number) {}
        *[Symbol.iterator](): Generator<number> { for (let i = 0; i < this.end; i++) yield i; }
        *scaled(factor: number): Generator<number> { for (const value of this) yield value * factor; }
    }
    const range = new Range(3);
    if ([...range].join(",") !== "0,1,2") throw new Error("iterable class spread");
    let sum = 0;
    for (const value of range.scaled(10)) sum += value;
    if (sum !== 30) throw new Error("generator method");
    class Bag { items = [1, 2]; *[Symbol.iterator](): Iterator<number> { yield* this.items; } }
    let total = 0;
    for (const value of new Bag()) total += value;
    if (total !== 3) throw new Error("iterable class");
`,
);

test("generator delegation and empty yields refuse unrepresented protocols", () => {
    for (const [source, message] of [
        [
            "function* g(): Generator<number> { yield* new Set([1]); } const xs = [...g()]; export {};",
            /yield\* delegates to a generator, an iterator or an array/,
        ],
        [
            "interface P { a: number } function* g(): Generator<P | undefined> { yield; } const xs = [...g()]; export {};",
            /A generator's empty yields produce undefined/,
        ],
        [
            "class Bag { [Symbol.iterator](): Iterator<number> { return [1, 2][Symbol.iterator](); } } let t = 0; for (const v of new Bag()) t += v; export {};",
            /A \[Symbol\.iterator\] method is lowered as a generator method/,
        ],
        [
            "class N { constructor(readonly v: number, readonly next: N | null) {} *walk(): Generator<number> { yield this.v; if (this.next) yield* this.next.walk(); } } const xs = [...new N(1, new N(2, null)).walk()]; export {};",
            /Recursive generator method 'N\.walk' is not supported/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "class-expressions-bound-to-constants",
    `
    const K = class { n = 1; };
    if (new K().n !== 1) throw new Error("class expression");
    const Counter = class Tally {
        static created = 0;
        count: number;
        constructor(start: number) { this.count = start; Tally.created++; }
        bump(): number { return ++this.count; }
    };
    const first = new Counter(5);
    const second = new Counter(1);
    if (first.bump() !== 6 || second.bump() !== 2 || Counter.created !== 2) throw new Error("named class expression");
    if (!(first instanceof Counter)) throw new Error("instanceof");
    class Base { kind(): string { return "base"; } }
    const Derived = class extends Base { kind(): string { return "derived:" + super.kind(); } };
    if (new Derived().kind() !== "derived:base") throw new Error("extends");
`,
);

test("a class expression outside a const initializer refuses", () => {
    for (const source of [
        "let K = class { n = 1; }; const k = new K(); export {};",
        "function make(c: new () => { n: number }): number { return new c().n; } const n = make(class { n = 1; }); export {};",
    ])
        assert.throws(
            () => compileSource(source),
            /A class expression is lowered as the initializer of a const it names/,
        );
});

check(
    "symbol-keyed-struct-literals",
    `
    const brand: unique symbol = Symbol("occluder");
    interface Occluders {
        readonly [brand]: true;
        readonly clips: readonly number[];
        readonly key: string;
    }
    const byKey = new Map<number, Occluders>();
    function make(clips: readonly number[]): Occluders {
        const snapshot = clips.map((clip) => Object.freeze([clip, clip + 1]));
        return Object.freeze({
            [brand]: true as const,
            clips: Object.freeze(snapshot.map((pair) => pair[0]!)),
            key: \`C\${clips.join(",")}\`,
        });
    }
    byKey.set(1, make([1, 2]));
    const direct: Occluders = { [brand]: true, clips: [3], key: "direct" };
    byKey.set(2, direct);
    if (byKey.get(1)!.key !== "C1,2" || byKey.get(2)![brand] !== true) throw new Error("brand records");
    if (Object.keys(direct).join(",") !== "clips,key") throw new Error("string keys");
`,
);

// Entry pairs a callback builds at run time are typed as the entries their
// consumer stores: array and tuple values beside literal-union keys.
check(
    "collection-entries-from-callback-pairs",
    `
    type Job = "none" | "farmer" | "smith" | "baker";
    interface Perk { id: string; job: Job; value: number }
    const ORDER: readonly Exclude<Job, "none">[] = ["farmer", "smith", "baker"];
    const GROW: Perk = Object.freeze({ id: "grow", job: "farmer", value: 2 });
    const FORGE: Perk = Object.freeze({ id: "forge", job: "smith", value: 3 });
    const BY_JOB = Object.freeze(Object.fromEntries(
        ORDER.map((job) => [job, Object.freeze(job === "farmer" ? [GROW] : job === "smith" ? [FORGE, GROW] : [])]),
    )) as Readonly<Record<Exclude<Job, "none">, readonly Perk[]>>;
    function count(job: Exclude<Job, "none">): number { return BY_JOB[job].length; }
    const counts: Array<typeof count> = [count];
    if (counts[0]!("smith") !== 2 || counts[0]!("baker") !== 0 || BY_JOB.farmer[0] !== GROW || BY_JOB.smith[1] !== GROW)
        throw new Error("perk table");
    const KEYS: readonly string[] = ["a", "b"];
    const lists = Object.fromEntries(KEYS.map((key) => [key, key === "a" ? [1, 2] : []]));
    if (lists.a!.length !== 2 || lists.b!.length !== 0 || Object.keys(lists).join() !== "a,b") throw new Error("list entries");
    type Tint = [number, number, number];
    interface Slot { key: string; tint: Tint }
    function changed(before: readonly Slot[], after: readonly Slot[]): string {
        const byKey = new Map(before.map((s) => [s.key, s.tint]));
        let out = "";
        for (const s of after) {
            const old = byKey.get(s.key);
            if (!old || old[0] !== s.tint[0]) out += s.key;
        }
        return out;
    }
    const tint: Tint = [1, 0, 0];
    if (changed([{ key: "a", tint }, { key: "c", tint }], [{ key: "a", tint: [2, 0, 0] }, { key: "b", tint }, { key: "c", tint }]) !== "ab")
        throw new Error("tuple values");
`,
);

// Number() is ToNumber over every representation of its operand.
check(
    "number-conversion-of-documents-booleans-and-optionals",
    `
    const texts: Array<string | undefined> = ["3", undefined, " 4 ", ""];
    const flags: Array<boolean | null> = [true, null, false];
    const numbers: Array<number | undefined> = [2, undefined];
    let total = "";
    for (const t of texts) total += Number(t) + ";";
    for (const f of flags) total += Number(f) + ";";
    for (const n of numbers) total += Number(n) + ";";
    const doc = JSON.parse('{"a":"5","b":null,"c":[2],"d":{},"e":true,"f":"x","g":[1,2]}') as Record<string, unknown>;
    for (const k of ["a", "b", "c", "d", "e", "f", "g", "h"]) total += Number(doc[k]) + ";";
    if (total !== "3;NaN;4;0;1;0;0;2;NaN;5;0;2;NaN;1;NaN;NaN;NaN;") throw new Error(total);
    interface Placement { bucket: number; slope: boolean }
    const placements: Placement[] = [{ bucket: 1, slope: true }, { bucket: 0, slope: true }, { bucket: 1, slope: false }];
    placements.sort((a, b) => a.bucket - b.bucket || Number(a.slope) - Number(b.slope));
    if (placements.map((p) => p.bucket + (p.slope ? "t" : "f")).join() !== "0t,1f,1t") throw new Error("boolean order");
    function levels(text: string): number[] {
        const value = JSON.parse(text) as unknown;
        if (!Array.isArray(value)) throw new Error("levels");
        const out: number[] = [];
        for (const raw of value) {
            const { size } = raw as { size?: unknown };
            out.push(Number(size));
        }
        return out;
    }
    const decoded = levels('[{"size":"4"},{"size":2},{"size":null},{}]');
    if (decoded[0] !== 4 || decoded[1] !== 2 || decoded[2] !== 0 || !Number.isNaN(decoded[3])) throw new Error("fields");
`,
);

// An array stored as an array of another element type is a copy, admitted
// only where JavaScript could not tell it from the one array it keeps.
check(
    "arrays-stored-with-converted-elements",
    `
    const ORDER = ["deer", "rabbit", "fox"] as const;
    type Kind = (typeof ORDER)[number];
    interface Def { airborne?: boolean; clips?: { fly?: string[] } }
    const TABLE: Record<Kind, Def> = { deer: {}, rabbit: { airborne: true, clips: { fly: ["a"] } }, fox: { airborne: true } };
    function grounded(): readonly Kind[] {
        return (Object.keys(TABLE) as Kind[]).filter((kind) => TABLE[kind].airborne === true && (TABLE[kind].clips?.fly?.length ?? 0) === 0);
    }
    const kinds: Array<typeof grounded> = [grounded];
    if (kinds[0]!().join() !== "fox") throw new Error("keys as literal union");
    type ChurchFailure = "nave" | "bell";
    type MillFailure = "wheel" | "water";
    interface Plate { kind: "church" | "mill"; church?: { failures: readonly ChurchFailure[] }; mill?: { failures: readonly MillFailure[] } }
    function failures(plate: Readonly<Plate>): readonly string[] {
        switch (plate.kind) {
            case "church": return plate.church?.failures ?? [];
            case "mill": return plate.mill?.failures ?? [];
        }
    }
    const reports: Array<typeof failures> = [failures];
    if (reports[0]!({ kind: "church", church: { failures: ["bell"] } }).join() !== "bell" || reports[0]!({ kind: "mill" }).length !== 0)
        throw new Error("literal unions as strings");
    type Mask = readonly (boolean | undefined)[];
    function dirty(mask: Mask | null): boolean { return mask?.some(Boolean) === true; }
    function merge(current: boolean[] | null, next: Mask): boolean[] {
        const out = current ? current.slice() : new Array<boolean>(next.length).fill(false);
        for (let i = 0; i < next.length; i++) if (next[i]) out[i] = true;
        return out;
    }
    function run(): string {
        let pending: boolean[] | null = null;
        const touched: boolean[] = [false, true];
        pending = merge(pending, touched);
        pending = merge(pending, [true]);
        return (dirty(pending) ? "dirty:" : "clean:") + pending.join();
    }
    const runs: Array<typeof run> = [run];
    if (runs[0]!() !== "dirty:true,true") throw new Error("lent optional lanes");
    type Ids = readonly (string | null | undefined)[];
    function ids(wall: Ids | undefined, houses: readonly { primary: string; secondary?: string }[]): string[] {
        const resolve = (requested: Ids | undefined) => [...new Set((requested ?? []).map((id) => id ?? "none"))];
        const parts = (h: { primary: string; secondary?: string }): string[] => h.secondary ? [h.primary, h.secondary] : [h.primary];
        return resolve([...(wall ?? []), ...houses.flatMap(parts)]);
    }
    const resolved: Array<typeof ids> = [ids];
    if (resolved[0]!(["a", null, undefined, "a"], [{ primary: "b", secondary: "c" }]).join() !== "a,none,b,c") throw new Error("fresh optional lanes");
    interface Sample { readonly lastMs: number; readonly maxMs: number }
    interface Timings { record(slot: number, ms: number): void; frame(): [string, Sample][] }
    function timings(labels: readonly string[]): Timings {
        const last = new Float32Array(labels.length);
        const max = new Float32Array(labels.length);
        return {
            record(slot, ms) { last[slot] = ms; if (ms > max[slot]!) max[slot] = ms; },
            frame() { return labels.map((label, i) => [label, { lastMs: last[i]!, maxMs: max[i]! }]); },
        };
    }
    const factories: Array<typeof timings> = [timings];
    const t = factories[0]!(["a", "b"]);
    t.record(1, 4);
    const frame = t.frame();
    if (frame[1]![0] !== "b" || frame[1]![1].maxMs !== 4 || frame[0]![1].lastMs !== 0) throw new Error("tuple record lanes");
    const parsed = JSON.parse('["a", 1, "b", null]') as unknown;
    const strings = new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
    if (strings.size !== 2 || !strings.has("b")) throw new Error("guarded document strings");
`,
);

// A selection of tuples of different lengths destructured where it is
// produced reads a converted copy nothing else holds, even though the
// program changes number arrays elsewhere.
check(
    "destructured-selection-of-converted-arrays",
    `
    function clearPoint(x: number, z: number, margin = 0.5): [number, number] {
        const out: [number, number] = [x, z];
        if (x < margin) out[0] = margin;
        return out;
    }
    function seatNearby(x: number, z: number, admitted: (x: number, z: number) => boolean): [number, number, boolean] | null {
        for (let r = 1; r < 4; r++) if (admitted(x + r, z)) return [x + r, z, true];
        return null;
    }
    function reseat(x: number, z: number, admitted: ((x: number, z: number) => boolean) | null): [x: number, z: number, admitted: boolean] {
        const cleared = clearPoint(x, z);
        const stranded = admitted !== null && !admitted(cleared[0], cleared[1]);
        if (admitted && stranded) {
            const seat = seatNearby(cleared[0], cleared[1], admitted);
            if (seat) return seat;
        }
        return [cleared[0], cleared[1], !stranded];
    }
    function place(x: number, z: number, restore = false): [number, number] {
        const admitted = (px: number, _pz: number): boolean => px > 2;
        const [seatX, seatZ] = restore ? reseat(x, z, admitted) : clearPoint(x, z, 0.2);
        const [, , kept = false] = (restore ? seatNearby(x, z, admitted) : null) ?? [0, 0];
        return [seatX, kept ? seatZ : -seatZ];
    }
    const places: Array<typeof place> = [place];
    const a = places[0]!(0, 1, true);
    const b = places[0]!(0.1, 1);
    if (a[0] !== 2.5 || a[1] !== 1 || b[0] !== 0.2 || b[1] !== -1) throw new Error("destructured selection");
    const trail: number[] = [];
    function note(v: number): number { trail.push(v); return trail.length; }
    const notes: Array<typeof note> = [note];
    if (notes[0]!(1) !== 1) throw new Error("trail");
`,
);

test("arrays destructured with code between their reads refuse a converted copy", () => {
    const shapes = `
        const trail: number[] = [];
        function note(v: number): number { trail.push(v); return v; }
        const stored: [number, number] = [1, 2];
        function pair(x: number): [number, number] { stored[0] = x; return stored; }
        const seat: [number, number, boolean] = [0, 0, true];
        function triple(x: number): [number, number, boolean] { seat[1] = x; return seat; }
    `;
    for (const destructuring of [
        "const [a = note(4), b] = flag ? triple(x) : pair(x); return a + b;",
        "let a = 0, b = 0; [a, b] = flag ? triple(x) : pair(x); return a + b;",
        "const [a, ...rest] = flag ? triple(x) : pair(x); return a + rest.length;",
    ])
        assert.throws(
            () =>
                compileSource(
                    `${shapes} function run(x: number, flag: boolean): number { ${destructuring} } const runs: Array<typeof run> = [run]; if (runs[0]!(1, true) < 0) throw new Error('x');`,
                ),
            /is a copy, and the program changes the elements of such arrays/,
        );
});

test("arrays stored with converted elements refuse where JavaScript keeps one observable array", () => {
    for (const [source, message] of [
        [
            "type K = 'a' | 'b'; const kinds: K[] = []; function names(): readonly string[] { return kinds; } const roots: Array<typeof names> = [names]; kinds.push('a'); if (roots[0]!().length !== 1) throw new Error('x');",
            /is a copy, and the program changes the elements of such arrays/,
        ],
        [
            "type K = 'a' | 'b'; const kinds: readonly K[] = [1, 2].map((i) => (i % 2 ? 'a' : 'b')); function names(): readonly string[] { return kinds; } const roots: Array<typeof names> = [names]; if (roots[0]!() !== roots[0]!()) throw new Error('x');",
            /is a copy, and the program compares such arrays by identity/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

// `x || undefined` and `x && y` over optional scalars keep absence apart
// from the falsy values the left operand selects.
check(
    "optional-scalar-logical-values",
    `
    interface Tower { id?: number; name: string; label?: string }
    interface Input { towers: readonly Tower[]; idOf(tower: Tower, index: number): number | undefined }
    function assemble(input: Input): string { return input.towers.map((t, i) => String(input.idOf(t, i))).join(); }
    function live(towers: readonly Tower[]): string {
        return assemble({ towers, idOf: (tower) => tower.id || undefined });
    }
    const lives: Array<typeof live> = [live];
    if (lives[0]!([{ id: 3, name: "a" }, { name: "b" }, { id: 0, name: "c" }, { id: NaN, name: "d" }]) !== "3,undefined,undefined,undefined")
        throw new Error("number or undefined");
    function label(tower: Tower): string | undefined { return tower.label || undefined; }
    const labels: Array<typeof label> = [label];
    if (labels[0]!({ name: "a", label: "" }) !== undefined || labels[0]!({ name: "a", label: "x" }) !== "x") throw new Error("string or undefined");
    function guarded(tower: Tower): number | undefined { return tower.id && tower.id + 1; }
    const guards: Array<typeof guarded> = [guarded];
    if (guards[0]!({ name: "a", id: 0 }) !== 0 || guards[0]!({ name: "a" }) !== undefined || guards[0]!({ name: "a", id: 2 }) !== 3)
        throw new Error("number and number");
`,
);

// A parameter defaulted to a value that may itself be undefined stays optional.
check(
    "defaulted-parameter-that-may-be-undefined",
    `
    interface Idle { day?: number; built?: number }
    interface Fields { od?: number; os?: number }
    function fields(idle: Idle, mutation = false, built = idle.built): Fields {
        const out: Fields = {};
        if (!mutation && idle.day !== undefined) out.od = idle.day;
        if (built !== undefined) out.os = built;
        return out;
    }
    const stored: Array<typeof fields> = [fields];
    const f = stored[0]!({ day: 2, built: 1 });
    if (f.od !== 2 || f.os !== 1) throw new Error("defaults");
    const g = stored[0]!({}, true, 5);
    if (g.od !== undefined || g.os !== 5) throw new Error("override");
    if (stored[0]!({}).os !== undefined || "os" in stored[0]!({})) throw new Error("absent default");
`,
);

// An assertion to a record type reads the record member of a union of a
// string and one record type.
check(
    "asserted-record-member-of-a-string-union",
    `
    interface Decl { readonly name: string; readonly sampleType?: "float" | "depth" }
    type Sampler = string | Decl;
    function samplers(shadows: boolean): readonly Sampler[] {
        return shadows ? [{ name: "csm", sampleType: "depth" }, { name: "stable" } as Sampler] : [{ name: "albedo" }];
    }
    function names(shadows: boolean): string[] { return samplers(shadows).map((sampler) => (sampler as { name: string }).name); }
    const stored: Array<typeof names> = [names];
    if (stored[0]!(true).join() !== "csm,stable" || stored[0]!(false).join() !== "albedo") throw new Error("names");
    const name = (sampler: Sampler): string => (sampler as { name: string }).name;
    if (name({ name: "x" }) !== "x") throw new Error("name");
`,
);

// A spread copies a field only to have a later property replace it.
check(
    "spread-fields-a-later-property-replaces",
    `
    interface Span { ax: number; bx: number; banked: boolean; stepYA?: number; stepYB?: number; tint?: [number, number, number] }
    function split(span: Span, cuts: number[]): Span[] {
        const bounds = [0, ...cuts, 1];
        const segs: Span[] = [];
        for (let i = 0; i + 1 < bounds.length; i++)
            segs.push({ ...span, ax: bounds[i]!, bx: bounds[i + 1]!, banked: i === 0 ? span.banked : false, stepYA: undefined, stepYB: undefined });
        for (let i = 0; i + 1 < segs.length; i++) segs[i]!.stepYB = i;
        return segs;
    }
    const stored: Array<typeof split> = [split];
    const tint: [number, number, number] = [1, 2, 3];
    const s = stored[0]!({ ax: 0, bx: 1, banked: true, stepYA: 4, tint }, [0.5]);
    if (s.length !== 2 || s[0]!.stepYA !== undefined || s[0]!.stepYB !== 0 || s[1]!.stepYB !== undefined) throw new Error("replaced fields");
    if (s[1]!.tint !== tint || s[1]!.banked || !s[0]!.banked || s[1]!.ax !== 0.5) throw new Error("copied fields");
`,
);

// Collections whose type arguments name unknown hold parsed documents,
// keyed by SameValueZero: object identity, string value, one NaN.
check(
    "collections-of-parsed-documents",
    `
    function asRecord(v: unknown): Record<string, unknown> | null {
        return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
    }
    function firstById(text: string): string {
        const rows = JSON.parse(text) as unknown[];
        const byId = new Map<number, Record<string, unknown>>();
        for (const raw of rows) {
            const row = asRecord(raw);
            const id = row?.id;
            if (row !== null && typeof id === "number" && !byId.has(id)) byId.set(id, row);
        }
        if (byId.get(1) !== asRecord(rows[0])) throw new Error("identity");
        let out = "";
        for (const [id, row] of byId) out += id + "=" + String(row.name) + ";";
        return out;
    }
    const stored: Array<typeof firstById> = [firstById];
    if (stored[0]!('[{"id":1,"name":"a"},{"id":2,"name":"b"},{"id":1,"name":"c"},3]') !== "1=a;2=b;") throw new Error("first rows");
    type Row = Record<string, unknown>;
    function count(text: string): string {
        const seen = new Map<Row, number>();
        const values = new Set<unknown>();
        const rows = JSON.parse(text) as unknown[];
        for (const raw of rows) {
            values.add(raw);
            if (raw && typeof raw === "object") seen.set(raw as Row, (seen.get(raw as Row) ?? 0) + 1);
        }
        for (const raw of rows) if (raw && typeof raw === "object") seen.set(raw as Row, (seen.get(raw as Row) ?? 0) + 1);
        values.add(-0);
        return seen.size + ":" + values.size + ":" + [...seen.values()].join();
    }
    const counts: Array<typeof count> = [count];
    if (counts[0]!('[{"a":1},{"a":1},"x","x",0,null,null]') !== "2:5:2,2") throw new Error("keys " + counts[0]!('[{"a":1},{"a":1},"x","x",0,null,null]'));
`,
);

test("collections refuse type arguments without a represented storage", () => {
    assert.throws(
        () =>
            compileSource(
                "const pending = new Map<string, object>(); pending.set('a', {}); if (pending.size !== 1) throw new Error('x');",
            ),
        /new Map requires concrete data type arguments or a contextual container type/,
    );
});

// A parsed array read as a typed array copies its elements where the
// source builds a new collection (a spread, a Set), and finds its own
// elements whatever record type the source reads them as.
check(
    "parsed-arrays-copied-into-typed-collections",
    `
    interface Request { asset: string; clips: readonly string[] }
    function fail(message: string): never { throw new Error(message); }
    function normalize(request: Request): Request {
        if (
            !Array.isArray(request?.clips) ||
            request.clips.length === 0 ||
            request.clips.some((clip) => typeof clip !== "string" || clip.length === 0) ||
            new Set(request.clips).size !== request.clips.length
        )
            fail("clips must be unique names");
        return { asset: request.asset, clips: [...request.clips] };
    }
    function decode(text: string): Request {
        const metadata = JSON.parse(text) as { request?: unknown };
        return normalize(metadata.request as Request);
    }
    const decoders: Array<typeof decode> = [decode];
    const r = decoders[0]!('{"request":{"asset":"a","clips":["x","y"]}}');
    if (r.clips.join() !== "x,y" || r.asset !== "a" || r.clips.length !== 2) throw new Error("normalized");
    let threw = false;
    try { decoders[0]!('{"request":{"asset":"a","clips":["x","x"]}}'); } catch { threw = true; }
    if (!threw) throw new Error("duplicates");
    type Usage = "walls" | "roof" | "ground";
    function usages(m: { usages?: readonly Usage[]; usage?: Usage }): Usage[] {
        if (m.usages && m.usages.length > 0) return [...new Set(m.usages)];
        return m.usage ? [m.usage] : ["walls"];
    }
    function parse(text: string): Usage[] { return usages(JSON.parse(text) as { usages?: Usage[]; usage?: Usage }); }
    const parsers: Array<typeof parse> = [parse];
    if (parsers[0]!('{"usages":["roof","walls","roof"]}').join() !== "roof,walls" || parsers[0]!('{"usage":"ground"}').join() !== "ground")
        throw new Error("literal union set");
    interface RawNode { name?: string; mesh?: number }
    interface RawJson { nodes?: RawNode[]; meshes?: { name?: string }[] }
    function meshName(text: string): string {
        const json = JSON.parse(text) as RawJson;
        const node = (json.nodes ?? []).find((n) => n.mesh !== undefined);
        if (!node || node.mesh === undefined) return "none";
        if (node !== json.nodes![1]) throw new Error("found element identity");
        return (node.name ?? "?") + ":" + (json.meshes?.[node.mesh]?.name ?? "-");
    }
    const names: Array<typeof meshName> = [meshName];
    if (names[0]!('{"nodes":[{"name":"a"},{"name":"b","mesh":0}],"meshes":[{"name":"m"}]}') !== "b:m" || names[0]!('{"nodes":[{}]}') !== "none")
        throw new Error("found node");
`,
);

// Cancelling a timer whose identifier may be absent cancels nothing while it
// is absent.
checkInRealm(
    "timer-cancellation-of-an-absent-identifier",
    `
    const ready = new Promise<void>((resolve) => setTimeout(resolve, 0));
    let fired = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    function end(): void { fired++; }
    function key(): void { clearTimeout(settle); settle = setTimeout(end, 0); }
    function cancel(): void { clearTimeout(settle); settle = undefined; }
    const handlers: Array<() => void> = [key, cancel];
    void (async () => {
        await ready;
        handlers[1]!();
        handlers[0]!();
        handlers[0]!();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (fired !== 1) throw new Error("one settled burst " + fired);
        handlers[0]!();
        handlers[1]!();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (fired !== 1) throw new Error("cancelled burst");
        globalThis.close();
    })();
`,
);

// A record read as `Record<string, unknown>` by a run-time key reads a
// parsed view of it; a property no prototype of a number defines reads
// undefined, and compares strictly unequal to any string.
check(
    "unknown-records-read-by-runtime-keys",
    `
    class ParseError extends Error {
        readonly path: string;
        constructor(path: string, message: string) { super(path + ": " + message); this.name = "ParseError"; this.path = path; }
    }
    const fail = (path: string, message: string): never => { throw new ParseError(path, message); };
    function isPlainObject(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
    function ownKeys(o: Record<string, unknown>): string[] { return Object.keys(o).filter((k) => !k.startsWith("_")); }
    type ConstantValue = number | number[];
    function parseConstants(raw: unknown, path: string): Record<string, ConstantValue> {
        if (!isPlainObject(raw)) return fail(path, "constants must be an object");
        const out: Record<string, ConstantValue> = {};
        for (const k of ownKeys(raw)) {
            const v = raw[k];
            if (typeof v === "number") out[k] = v;
            else if (Array.isArray(v)) out[k] = v.map((n) => n as number);
            else fail(path + "." + k, "constant must be a number or an array");
        }
        return out;
    }
    const FORMAT = "behavior";
    interface Def { kind: string; constants: Record<string, ConstantValue> }
    function parse(raw: unknown): Def {
        if (!isPlainObject(raw)) return fail("$", "root must be an object");
        if (raw["format"] !== FORMAT) fail("$.format", "format");
        if (raw["version"] !== 1) fail("$.version", "version");
        const kind = raw["kind"];
        if (typeof kind !== "string") return fail("$.kind", "kind");
        return { kind, constants: parseConstants(raw["constants"] ?? {}, "$.constants") };
    }
    const raw: unknown = { format: "behavior", version: 1, kind: "animal", constants: { urge: 0.4, _note: "x", window: [4, 9] } };
    const parsed = parse(raw);
    if (parsed.kind !== "animal" || parsed.constants["urge"] !== 0.4 || (parsed.constants["window"] as number[])[1] !== 9 || "_note" in parsed.constants)
        throw new Error("parsed");
    let rejected = "";
    try { parse(42); } catch (error) { rejected = error instanceof ParseError ? error.path : "other"; }
    if (rejected !== "$") throw new Error("rejected " + rejected);
    const n: unknown = 42;
    const format = (n as Record<string, unknown>)["format"];
    if (format !== undefined || (n as Record<string, unknown>)["format"] === FORMAT) throw new Error("number property");
`,
);

// Fresh tuples of different lane types select through one conditional;
// Array.isArray proves an optional readonly array present; a string read
// asserted present (`map.get(k)!`) stores as a string.
check(
    "tuple-arms-guarded-arrays-and-asserted-strings",
    `
    function clear(x: number, z: number): [number, number] { return [x + 1, z]; }
    function reseat(x: number, z: number): [x: number, z: number, admitted: boolean] {
        const c = clear(x, z);
        return [c[0], c[1], c[0] > 2];
    }
    function seat(x: number, z: number, restore: boolean): [number, number] {
        const [sx, sz] = restore ? reseat(x, z) : clear(x, z);
        return [sx * 2, sz];
    }
    const seats: Array<typeof seat> = [seat];
    if (seats[0]!(1, 3, true).join() !== "4,3" || seats[0]!(2, 5, false).join() !== "6,5") throw new Error("seats");
    let refunded: number[] = [];
    const ledger = { setRefunded(ids: readonly number[]): void { refunded = ids.filter((id) => id > 0); } };
    function restore(save: { mana?: number; refunded?: readonly number[] }): void {
        ledger.setRefunded(Array.isArray(save.refunded) ? save.refunded : []);
    }
    const restores: Array<typeof restore> = [restore];
    restores[0]!({ refunded: [3, -1, 4] });
    if (refunded.join() !== "3,4") throw new Error("refunded " + refunded.join());
    restores[0]!({});
    if (refunded.length !== 0) throw new Error("empty");
    function roots(pairs: readonly [string, string][]): string {
        const parent = new Map<string, string>();
        for (const [a] of pairs) parent.set(a, a);
        const find = (k: string): string => {
            let root = k;
            while (parent.get(root) !== root) root = parent.get(root)!;
            return root;
        };
        for (const [a, b] of pairs) if (find(a) !== find(b)) parent.set(find(b), find(a));
        return pairs.map(([a]) => find(a)).join();
    }
    const finders: Array<typeof roots> = [roots];
    if (finders[0]!([["a", "a"], ["b", "a"], ["c", "b"]]) !== "c,c,c") throw new Error("roots");
`,
);

// A value whose type admits both null and undefined keeps which one it is:
// a method call an optional chain skips is undefined while the method's own
// null stays null, an argument whose type admits one absence forwards it,
// and an element read out of a map is undefined where its key is missing.
check(
    "absences-kept-apart-across-chains-arguments-and-documents",
    `
    interface Build { bottomY(): number | null }
    function bottomAt(entry: { floorY: number; build: Build } | undefined): number | null | undefined {
        const bottom = entry?.build.bottomY();
        return entry && bottom != null ? bottom + entry.floorY : bottom;
    }
    const bottoms: Array<typeof bottomAt> = [bottomAt];
    const read = (entry: { floorY: number; build: Build } | undefined): string => String(bottoms[0]!(entry));
    if (read(undefined) + "," + read({ floorY: 2, build: { bottomY: () => null } }) + "," + read({ floorY: 2, build: { bottomY: () => 3 } }) !== "undefined,null,5")
        throw new Error("chain absences");
    interface Control { id: number; u: number; lat?: number }
    function find(controls: readonly Control[], u: number, controlId?: number | null): Control | undefined {
        const byId = controlId !== undefined && controlId !== null ? controls.find((c) => c.id === controlId) : undefined;
        if (byId?.lat !== undefined) return byId;
        return controls.find((c) => c.u === u);
    }
    const finders: Array<typeof find> = [find];
    function clear(controls: readonly Control[], u: number, controlId?: number | null): string {
        const hit = find(controls, u, controlId);
        return String(hit?.id ?? controlId ?? "none") + ":" + (controlId === null ? "null" : controlId === undefined ? "undefined" : "id");
    }
    function edit(controls: readonly Control[], u: number, controlId: number | null): string { return clear(controls, u, controlId); }
    const edits: Array<typeof edit> = [edit];
    const controls: Control[] = [{ id: 1, u: 0, lat: 2 }, { id: 2, u: 1 }];
    if (edits[0]!(controls, 1, 1) !== "1:id" || edits[0]!(controls, 1, null) !== "2:null" || edits[0]!(controls, 5, null) !== "none:null" || finders[0]!(controls, 0)?.id !== 1)
        throw new Error("forwarded absence");
    function digest(value: unknown): string {
        if (value === null) return "n";
        if (value === undefined) return "u";
        if (Array.isArray(value)) return "[" + value.map(digest).join() + "]";
        return String(value);
    }
    function keys(heights: Map<string, number>, key: string): string {
        return digest([heights.get(key), heights.has(key), [key]]);
    }
    const keyed: Array<typeof keys> = [keys];
    const heights = new Map([["a", 2]]);
    if (keyed[0]!(heights, "a") !== "[2,true,[a]]" || keyed[0]!(heights, "b") !== "[u,false,[b]]") throw new Error("digest");
`,
);

// A Map iterator kept past its call is live over the map; searches compare
// optional and union lanes of plain values by value.
check(
    "live-map-iterators-and-plain-lane-searches",
    `
    interface Rec { id: number; kind: string }
    interface Store { values(): IterableIterator<Rec>; keys(): IterableIterator<number>; set(rec: Rec): void }
    function createStore(): Store {
        const records = new Map<number, Rec>();
        return { values: () => records.values(), keys: () => records.keys(), set: (rec) => { records.set(rec.id, rec); } };
    }
    const stores: Array<typeof createStore> = [createStore];
    const store = stores[0]!();
    store.set({ id: 2, kind: "a" });
    const values = store.values();
    store.set({ id: 5, kind: "b" });
    let out = "";
    for (const r of values) out += r.kind;
    for (const k of store.keys()) out += k;
    if (out !== "ab25" || [...store.keys()].join() !== "2,5") throw new Error(out);
    const props = new Map<number, number>([[1, 1], [2, 2], [3, 1]]);
    const refs = { propId: (id: number): number | "ambiguous" | null => (props.get(id) ?? 0) > 1 ? "ambiguous" : props.has(id) ? id : null };
    function resolved(ids: readonly number[]): string {
        const found = ids.map((id) => refs.propId(id));
        return (found.includes("ambiguous") ? "a" : "-") + (found.includes(null) ? "n" : "-") + (found.includes(3) ? "3" : "-") + found.indexOf(null);
    }
    const resolvers: Array<typeof resolved> = [resolved];
    if (resolvers[0]!([1, 3]) !== "--3-1" || resolvers[0]!([2, 9]) !== "an-1") throw new Error("searches");
`,
);

// A record type the program reads parsed documents as is stored as a
// document: its records keep their own fields and identity, and a literal
// of the type is an owned document.
check(
    "parsed-documents-stored-as-their-record-types",
    `
    interface Meta { description?: string; savedAt?: number }
    interface Contents { save: string; meta?: Meta | null }
    function decodeMeta(text: string | undefined): Meta | null {
        if (!text) return null;
        try {
            const m = JSON.parse(text) as Meta;
            return m && typeof m === "object" ? m : null;
        } catch {
            return null;
        }
    }
    function unpack(save: string, meta: string | undefined): Contents { return { save, meta: decodeMeta(meta) }; }
    const unpackers: Array<typeof unpack> = [unpack];
    const contents = unpackers[0]!("save", '{"description":"d","savedAt":5,"extra":1}');
    if (contents.meta?.description !== "d" || contents.meta.savedAt !== 5) throw new Error("fields");
    if (JSON.stringify(contents.meta) !== '{"description":"d","savedAt":5,"extra":1}') throw new Error("kept keys");
    if (unpackers[0]!("s", undefined).meta !== null || unpackers[0]!("s", "{").meta !== null || unpackers[0]!("s", "3").meta !== null)
        throw new Error("absent meta");
    const made: Meta = { description: "x" };
    made.savedAt = 5;
    const list: Meta[] = [made, contents.meta!];
    list[0]!.description = "y";
    list[1]!.savedAt = 2;
    if (made.description !== "y" || list[0] !== made || contents.meta!.savedAt !== 2) throw new Error("identity");
    if (JSON.stringify(list) !== '[{"description":"y","savedAt":5},{"description":"d","savedAt":2,"extra":1}]') throw new Error(JSON.stringify(list));
    interface RawNode { name?: string; mesh?: number; children?: number[] }
    interface RoleMesh { node: RawNode; role: string }
    function roles(text: string): string {
        const nodes = (JSON.parse(text) as { nodes?: RawNode[] }).nodes ?? [];
        const out: RoleMesh[] = [];
        const gather = (index: number, role: string): void => {
            const n = nodes[index]!;
            if (n.mesh !== undefined) out.push({ node: n, role });
            for (const c of n.children ?? []) gather(c, n.name === "shutter" ? "shutter" : role);
        };
        gather(0, "leaf");
        return out.map((r) => (r.node === nodes[r.node.mesh!] ? "" : "!") + r.role + r.node.mesh).join();
    }
    const gatherers: Array<typeof roles> = [roles];
    if (gatherers[0]!('{"nodes":[{"children":[1,2]},{"name":"shutter","mesh":1,"children":[2]},{"mesh":2}]}') !== "leaf1,shutter2,leaf2")
        throw new Error("nodes");
`,
);

// A numeric index view with a length writes through any numeric array; a
// literal union assigned to a string local spells its string.
check(
    "numeric-index-views-and-literal-union-strings",
    `
    const LANE = { a: 3, b: 15 } as const;
    function stamp(matrix: { [index: number]: number; readonly length: number }, id: number, offset = 0, lane: "a" | "b" = "a"): void {
        const at = offset + LANE[lane];
        if (offset < 0 || at >= matrix.length) throw new RangeError("offset out of range");
        matrix[at] = lane === "b" ? id * 2 : id;
    }
    const stamps: Array<typeof stamp> = [stamp];
    const floats = new Float32Array(32);
    stamps[0]!(floats, 7, 16);
    const numbers: number[] = new Array<number>(16).fill(0);
    stamps[0]!(numbers, 5, 0, "b");
    if (floats[19] !== 7 || numbers[15] !== 10) throw new Error("stamp");
    let threw = false;
    try { stamps[0]!(numbers, 1, 8, "b"); } catch (error) { threw = error instanceof RangeError; }
    if (!threw) throw new Error("range");
    type Kind = "deer" | "fox";
    let animal = "";
    const spawn: Array<(kind: Kind) => void> = [(kind) => { animal = kind; }];
    spawn[0]!("fox");
    if (animal !== "fox") throw new Error("spelled kind");
`,
);

test("a parsed document read as a record type with stored functions refuses", () => {
    assert.throws(
        () =>
            compileSource(
                "interface Handler { name: string; run(): number } function load(text: string): Handler { return JSON.parse(text) as Handler; } const loaders: Array<typeof load> = [load]; const handler: Handler = { name: 'a', run: () => 1 }; if (loaders.length !== 1 || handler.run() !== 1) throw new Error('x');",
            ),
        /Expression does not produce the expected data \{"kind":"struct","name":"Handler"\} value; received data \{"kind":"json"\}/,
    );
});

// instanceof Map, Set, WeakMap and WeakSet answer from the storage holding
// the value; a dictionary or parsed document is none of them.
check(
    "collection-instanceof-over-unknown-values",
    `
    const m: unknown = new Map();
    const s: unknown = new Set<number>([1]);
    const ws = new WeakSet<{ id: number }>();
    const wm = new WeakMap<object, number>();
    const record: Record<string, number> = { a: 1 };
    const parsed: unknown = JSON.parse('{"a":1}');
    function kinds(value: unknown): string {
        return (value instanceof Map ? "M" : "") + (value instanceof Set ? "S" : "") + (value instanceof WeakSet ? "w" : "") + (value instanceof WeakMap ? "W" : "");
    }
    let out = "";
    out += (m instanceof Map ? "M" : "-") + (m instanceof Set ? "S" : "-");
    out += (s instanceof Set ? "S" : "-") + (s instanceof Map ? "M" : "-");
    out += (ws instanceof WeakSet ? "w" : "-") + ((ws as unknown) instanceof Set ? "S" : "-");
    out += (wm instanceof WeakMap ? "W" : "-") + ((wm as unknown) instanceof Map ? "M" : "-");
    out += ((record as unknown) instanceof Map ? "M" : "-") + (parsed instanceof Map ? "M" : "-");
    const maybe: Map<string, number> | Set<string> | null = out.length > 3 ? new Set(["x"]) : null;
    out += (maybe instanceof Set ? "S" : "-") + (maybe instanceof Map ? "M" : "-");
    out += kinds(new Map<string, string>());
    if (out !== "M-S-w-W---S-M") throw new Error(out);
`,
);

// A record initializing a local declared as a closed Record of its keys is
// that record.
check(
    "closed-record-locals-initialized-from-records",
    `
    interface Line { comfort: "inert" | "warm"; days: number }
    interface Board { food: Line; fuel: Line }
    interface Stats { comfort: Board }
    let god = true;
    function readStats(): Stats { return { comfort: { food: { comfort: "warm", days: 2 }, fuel: { comfort: "inert", days: 0 } } }; }
    function render(): string {
        const lines: Record<"food" | "fuel", Line> | null = god ? readStats().comfort : null;
        const active = lines !== null && (lines.food.comfort !== "inert" || lines.fuel.comfort !== "inert");
        return active ? lines!.food.days + ":" + lines!.fuel.comfort : "hidden";
    }
    const roots: Array<typeof render> = [render];
    if (roots[0]!() !== "2:inert") throw new Error("render");
    god = false;
    if (roots[0]!() !== "hidden") throw new Error("hidden");
`,
);

// Array.from results read through Object.freeze take the frozen array's
// own context, readonly included.
check(
    "array-from-results-typed-through-freeze",
    `
    const SLOT_COUNT = 4;
    interface Timing { readonly seconds: number; readonly frameCount: number; readonly contactPhase?: number }
    type Profile = readonly (Timing | null)[];
    function normalize(input: Profile): Profile {
        if (!Array.isArray(input) || input.length > SLOT_COUNT) throw new Error("Invalid profile");
        return Object.freeze(Array.from({ length: SLOT_COUNT }, (_, slot) => {
            const row = input[slot];
            if (row == null) return null;
            if (!Number.isFinite(row.seconds) || row.frameCount < 1) throw new Error("Invalid timing " + slot);
            return Object.freeze({ seconds: row.seconds, frameCount: row.frameCount, ...(row.contactPhase === undefined ? {} : { contactPhase: row.contactPhase }) });
        }));
    }
    const roots: Array<typeof normalize> = [normalize];
    const p = roots[0]!([{ seconds: 1, frameCount: 2 }, null, { seconds: 2, frameCount: 3, contactPhase: 0.5 }]);
    if (p.length !== 4 || p[1] !== null || p[3] !== null || p[2]!.contactPhase !== 0.5 || p[0]!.contactPhase !== undefined || p[0]!.frameCount !== 2) throw new Error("profile");
`,
);

// Unary plus and minus of a field a shared record layout may hold absent
// apply ToNumber to the slot.
check(
    "unary-numbers-of-fields-a-shared-layout-may-lack",
    `
    interface Small { halfW: number }
    interface Spec { yaw: number; halfW: number; flat?: boolean }
    const smalls: Small[] = [{ halfW: 5 }];
    function keep(spec: Spec): void { smalls.push(spec); }
    function turn(spec: Spec & { flat: true }): number { keep(spec); smalls[1]!.halfW = 4; return -spec.yaw + +spec.yaw * 2 + spec.halfW; }
    const turns: Array<typeof turn> = [turn];
    if (turns[0]!({ yaw: 2, halfW: 1, flat: true }) !== 6) throw new Error("turn");
    if (smalls.length !== 2 || smalls[1]!.halfW !== 4) throw new Error("kept");
`,
);

// A string an imported module binding holds from generation reaches a
// string sink, here a nullish fallback's.
test("an imported generation-time string feeds a string sink", async (t) => {
    const directory = resolve("artifacts/imported-generation-string");
    mkdirSync(directory, { recursive: true });
    const module = `export const GENERATIONS = ["legacy", "new"] as const;
        export type Generation = typeof GENERATIONS[number];
        export function forSearch(search: string): Generation { return new URLSearchParams(search).get("v") === "new" ? "new" : "legacy"; }
        export const ACTIVE = forSearch(typeof location === "undefined" ? "" : location.search);`;
    writeFileSync(join(directory, "generation.ts"), module);
    const entry = `import { ACTIVE, type Generation } from "./generation.js";
        interface Deps { modelGeneration?: Generation; count: number }
        function spawn(deps: Deps): string { const generation = deps.modelGeneration ?? ACTIVE; return generation + deps.count; }
        const spawners: Array<typeof spawn> = [spawn];
        if (spawners[0]!({ count: 1 }) !== "legacy1" || spawners[0]!({ count: 2, modelGeneration: "new" }) !== "new2") throw new Error("generation");`;
    const commonJs = (source: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    runInNewContext(
        "const exports = {};" +
            commonJs(module) +
            ";const required = exports; (function (exports, require) {" +
            commonJs(entry) +
            "})({}, () => required);",
        { URLSearchParams },
    );
    const result = compileSource(entry, {
        fileName: join(directory, "entry.ts"),
    });
    await executeGeneratedAssertions(
        t,
        "imported-generation-string",
        result.cpp,
    );
});

// A closed Record is written by JSON.stringify keys in its union's order,
// which every record of the union in the program is created in.
check(
    "closed-records-written-as-json",
    `
    type Scheme = "wasd" | "classic";
    type Action = "run" | "jump";
    interface Prefs { scheme: Scheme; shortcuts: Record<Scheme, Record<Action, string>>; note?: Record<Action, number> }
    function save(prefs: Prefs): string { return JSON.stringify(prefs); }
    const savers: Array<typeof save> = [save];
    const first: Prefs = { scheme: "wasd", shortcuts: { classic: { jump: "j", run: "r" }, wasd: { jump: "space", run: "shift" } } };
    const text = savers[0]!(first);
    if (text !== '{"scheme":"wasd","shortcuts":{"classic":{"jump":"j","run":"r"},"wasd":{"jump":"space","run":"shift"}}}') throw new Error(text);
    const second: Prefs = { scheme: "classic", shortcuts: { classic: { jump: "j", run: "r" }, wasd: { jump: "space", run: "shift" } } };
    second.note = { jump: 1, run: 2 };
    second.shortcuts.wasd.run = "ctrl";
    const pretty = JSON.stringify(second.shortcuts.wasd, null, 1);
    if (pretty !== '{\\n "jump": "space",\\n "run": "ctrl"\\n}') throw new Error(pretty);
    const again = savers[0]!(second);
    if (again !== '{"scheme":"classic","shortcuts":{"classic":{"jump":"j","run":"r"},"wasd":{"jump":"space","run":"ctrl"}},"note":{"jump":1,"run":2}}') throw new Error(again);
`,
);

test("a closed Record created in another key order than JSON writes refuses", () => {
    assert.throws(
        () =>
            compileSource(
                "type Action = 'run' | 'jump'; interface Prefs { keys: Record<Action, string> } function save(prefs: Prefs): string { return JSON.stringify(prefs); } const savers: Array<typeof save> = [save]; if (savers[0]!({ keys: { run: 'r', jump: 'j' } }) !== '{\"keys\":{\"run\":\"r\",\"jump\":\"j\"}}') throw new Error('order');",
            ),
        /JSON\.stringify writes a closed Record's keys in its union's order; this record creates them in another order\./,
    );
    assert.throws(
        () =>
            compileSource(
                "type Action = 'run' | 'jump'; function save(rows: Array<Record<Action, number>>): string { return JSON.stringify(rows); } const savers: Array<typeof save> = [save]; if (savers[0]!([{ jump: 1, run: 2 }]) !== '[{\"jump\":1,\"run\":2}]') throw new Error('rows');",
            ),
        /JSON\.stringify writes a closed Record where the stringified value, a record field or another closed Record holds it\./,
    );
});

// A number asserted from a slot that may be absent, or that an unknown type
// hides, reads as ToNumber reads the slot: NaN for undefined.
check(
    "numbers-asserted-from-optional-slots",
    `
    interface Saved { e?: number; n?: number }
    function epoch(record: Saved): number | undefined {
        return Number.isFinite(record.e) && (record.e as number) >= 0 ? Math.trunc(record.e as number) : undefined;
    }
    const reads: Array<typeof epoch> = [epoch];
    if (reads[0]!({ e: 3.7 }) !== 3 || reads[0]!({}) !== undefined || reads[0]!({ e: -1 }) !== undefined) throw new Error("epoch");
    const loose = (record: Saved): number => (record.n as number) + 1;
    const looses: Array<typeof loose> = [loose];
    if (!Number.isNaN(looses[0]!({})) || looses[0]!({ n: 1 }) !== 2) throw new Error("loose");
    interface Home { i: number; e?: number }
    function epochOf(item: Home): number {
        const record = item as { i?: unknown; e?: unknown };
        return Number.isFinite(record.e) && (record.e as number) >= 0 ? Math.trunc(record.e as number) : -1;
    }
    const homeReads: Array<typeof epochOf> = [epochOf];
    const homes: Home[] = [{ i: 1, e: 3.5 }, { i: 2 }, { i: 3, e: -1 }];
    if (homes.map((home) => homeReads[0]!(home)).join() !== "3,-1,-1") throw new Error("unknown slots");
`,
);

// Nested numeric literals whose rows differ in length are arrays, not a
// static table.
check(
    "jagged-numeric-literal-tables",
    `
    const LAYOUTS: readonly (readonly [number, number, number])[][] = [
        [[2, 0.5, 0.52]],
        [[1, 0.5, 0.48], [3, 0.5, 0.58]],
        [[1, 0.5, 0.48], [2, 0.5, 0.58], [3, 0.5, 0.48]],
    ];
    interface Window { side: number; fraction: number; height: number }
    function windows(count: number): Window[] {
        return LAYOUTS[count - 1]!.map(([side, fraction, heightFraction]) => ({ side, fraction, height: heightFraction * 2 }));
    }
    const recipes: Array<typeof windows> = [windows];
    const w = recipes[0]!(2);
    if (w.length !== 2 || w[1]!.side !== 3 || w[0]!.height !== 0.96 || recipes[0]!(3).length !== 3) throw new Error("windows");
`,
);
