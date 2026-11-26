import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runGeneratedProgram } from "./native-fixture.js";
import {
    check,
    executeGeneratedAssertions,
    native,
} from "./language-constructs.js";

check(
    "a store through a call result writes the object the call returns",
    `
    const st: { v?: number } = {};
    const obj = () => st;
    obj().v = 3;
    function named() { return st; }
    named().v ??= 9;
    if (st.v !== 3) throw new Error("annotated object written through a call " + st.v);
`,
);

check(
    "a-compound-assignment-reads-its-old-value-first-and-is-a-value",
    `
    let x = 1;
    const bump = (): number => { x = 10; return 1; };
    x += bump();
    if (x !== 2) throw new Error("local order " + x);
    const st = { v: 1 };
    const obj = () => st;
    const write = (): number => { st.v = 10; return 1; };
    obj().v += write();
    if (st.v !== 2) throw new Error("receiver order " + st.v);
    class S { private n = 1; get v(): number { return this.n; } set v(k: number) { this.n = Math.min(k, 2); } }
    const s = new S();
    const r = (s.v += 5);
    if (r !== 6 || s.v !== 2) throw new Error("setter value " + r);
    const m: Record<string, number> = { a: 1 };
    let b = 6;
    const u = new Uint8Array(1);
    u[0] = 200;
    let t = 0;
    while ((t += 3) < 10) b |= 1;
    if ((m["a"] += 4) !== 5 || (b >>>= 1) !== 3 || (u[0] += 100) !== 300 || u[0] !== 44 || t !== 12)
        throw new Error("values");
    let text = "a";
    const rewrite = (): string => { text = "z"; return "b"; };
    text += rewrite();
    const label = { s: "x" };
    if (text !== "ab" || (label.s += 1) !== "x1" || (text += "c") !== "abc") throw new Error("strings " + text);
`,
);

check(
    "a-discarded-getter-read-runs-the-getter-once",
    `
    let reads = 0;
    class G { get v(): number { reads++; return 1; } }
    const g = new G();
    void g.v;
    g.v;
    if (reads !== 2) throw new Error("getter runs " + reads);
`,
);

check(
    "a-stored-closure-calling-a-method-shares-the-bindings-it-writes",
    `
    let n = 0;
    class C { m(): void { n++; } }
    const c = new C();
    const fs: Array<() => void> = [];
    fs.push(() => c.m());
    fs[0]!(); fs[0]!();
    if (n !== 2) throw new Error("method write through a stored closure");
    let reads = 0, made = 0;
    class G { get v(): number { reads++; return 1; } }
    class K { constructor() { made++; } }
    const g = new G();
    const more: Array<() => void> = [() => { void g.v; }, () => { new K(); }];
    more[0]!(); more[1]!();
    if (reads !== 1 || made !== 1) throw new Error("getter or constructor write through a stored closure");
`,
);

check(
    "construction-evaluates-arguments-before-own-members",
    `
    let c = 0;
    class A { f = c++; constructor(public a: number) {} }
    const x = new A(c++);
    if (x.a !== 0 || x.f !== 1) throw new Error("base order");
    const log: string[] = [];
    const t = (s: string) => { log.push(s); return s.length; };
    class B { b = t("bfield"); constructor(_x: number) { t("bbody"); } }
    class D extends B { d = t("dfield"); constructor(public p: number) { super(t("superarg")); t("dbody"); } }
    const v = new D(t("arg"));
    if (log.join() !== "arg,superarg,bfield,bbody,dfield,dbody" || v.p !== 3) throw new Error("derived order");
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
    "element-writes-through-record-field-arrays-reach-later-reads",
    `
    type Lanes = { readonly name: string; readonly lanes?: number[] };
    type Mixed = { readonly name: string; readonly lanes?: number | number[] };
    const WATER: Lanes = { name: "water", lanes: [1, 2, 3] };
    const MIXED: Mixed = { name: "mixed", lanes: [1, 2, 3] };
    function describe(item: Lanes | Mixed): string {
        return \`\${item.name}=\${JSON.stringify(item.lanes)}\`;
    }
    (WATER.lanes as number[])[0] = 7;
    (MIXED.lanes as number[])[1] = 8;
    const water = \`\${describe(WATER)}\`;
    const mixed = \`\${describe(MIXED)}\`;
    if (water !== "water=[7,2,3]") throw new Error(water);
    if (mixed !== "mixed=[1,8,3]") throw new Error(mixed);
`,
);

check(
    "callee-element-writes-through-record-parameters-reach-later-reads",
    `
    type Lanes = { readonly name: string; readonly lanes?: number[] };
    type Mixed = { readonly name: string; readonly lanes?: number | number[] };
    const WATER: Lanes = { name: "water", lanes: [1, 2, 3] };
    const MIXED: Mixed = { name: "mixed", lanes: [1, 2, 3] };
    function describe(item: Lanes | Mixed): string {
        return \`\${item.name}=\${JSON.stringify(item.lanes)}\`;
    }
    function poke(item: Lanes | Mixed, index: number): void {
        (item.lanes as number[])[index] = 7;
    }
    poke(WATER, 0);
    poke(MIXED, 2);
    const water = \`\${describe(WATER)}\`;
    const mixed = \`\${describe(MIXED)}\`;
    if (water !== "water=[7,2,3]") throw new Error(water);
    if (mixed !== "mixed=[1,2,7]") throw new Error(mixed);
`,
);

check(
    "deferred-readers-of-union-field-arrays-see-later-writes",
    `
    type Mixed = { readonly name: string; readonly lanes?: number | number[] };
    type Fixed = { readonly name: string; readonly lanes?: number | readonly number[] };
    const MIXED: Mixed = { name: "mixed", lanes: [1, 2, 3] };
    const FIXED: Fixed = { name: "fixed", lanes: [1, 2, 3] };
    function describe(item: Mixed | Fixed): string {
        return \`\${item.name}=\${JSON.stringify(item.lanes)}\`;
    }
    const readers: Array<() => string> = [];
    readers.push(() => \`\${describe(MIXED)}\`);
    readers.push(() => \`\${describe(FIXED)}\`);
    (MIXED.lanes as number[])[0] = 7;
    (FIXED as unknown as { lanes: number[] }).lanes[2] = 9;
    const mixed = readers[0]!();
    const fixed = readers[1]!();
    if (mixed !== "mixed=[7,2,3]") throw new Error(mixed);
    if (fixed !== "fixed=[1,2,9]") throw new Error(fixed);
`,
);

check(
    "records-holding-a-constant-array-see-its-later-writes",
    `
    type Fixed = { readonly name: string; readonly lanes?: number | readonly number[] };
    const KEPT: [number, number, number] = [1, 2, 3];
    const DIRECT: [number, number, number] = [1, 2, 3];
    const ALIASED: [number, number, number] = [1, 2, 3];
    const HANDED: [number, number, number] = [1, 2, 3];
    const kept: Fixed = { name: "kept", lanes: KEPT };
    const direct: Fixed = { name: "direct", lanes: DIRECT };
    const aliased: Fixed = { name: "aliased", lanes: ALIASED };
    const handed: Fixed = { name: "handed", lanes: HANDED };
    function describe(item: Fixed): string {
        return \`\${item.name}=\${JSON.stringify(item.lanes)}\`;
    }
    function bump(lanes: number[]): void {
        lanes[2] = lanes[2]! + 10;
    }
    const list: Fixed[] = [kept, direct, aliased, handed];
    const readers = list.map((item) => () => describe(item));
    DIRECT[0] = 7;
    const alias: number[] = ALIASED;
    alias[1] = 8;
    bump(HANDED);
    const seen = readers.map((read) => read()).join(" ");
    if (seen !== "kept=[1,2,3] direct=[7,2,3] aliased=[1,8,3] handed=[1,2,13]") throw new Error(seen);
    const lanes = kept.lanes as readonly number[];
    if (lanes[0]! + lanes[1]! + lanes[2]! !== 6) throw new Error("kept lanes");
    const read = direct.lanes as readonly number[];
    if (read[0] !== 7) throw new Error("direct lanes");
`,
);

check(
    "a record holding a constant array sees a write through an assertion",
    `
    type Fixed = { readonly name: string; readonly lanes?: number | readonly number[] };
    const LANES: [number, number, number] = [1, 2, 3];
    const fixed: Fixed = { name: "fixed", lanes: LANES };
    const list: Fixed[] = [fixed];
    (list[0]!.lanes as number[])[1] = 9;
    const lanes = fixed.lanes as readonly number[];
    if (lanes[1] !== 9 || LANES[1] !== 9) throw new Error(String(lanes[1]));
`,
);

check(
    "a method returning this returns the receiver its call read once",
    `
    class Tally { count = 0; bump(): void { this.count++; } self(): Tally { return this; } }
    let reads = 0;
    const tallies = new Map<number, Tally>([[1, new Tally()]]);
    function pick(key: number): Tally { reads++; return tallies.get(key)!; }
    const same = tallies.get(1)!.self();
    tallies.get(1)!.bump();
    if (same !== tallies.get(1) || same.count !== 1) throw new Error("self");
    const again = pick(1).self();
    if (again !== same || reads !== 1) throw new Error("receiver read once");
    interface Owner { tally: Tally }
    const owners: Owner[] = [{ tally: same }];
    if (owners[0]!.tally.self() !== same || owners[0]!.tally.self().count !== 1) throw new Error("field receiver");
    `,
);

// A comma expression's value is its right side, stored as the sink stores
// it (an empty array as the other arm's record array), after its left side
// runs in the arm that takes it.
check(
    "a-comma-arm-stores-its-right-side-as-the-other-arms-array",
    `
    interface Range { binding: number; from: number }
    class Batch {
        count = 0;
        begun = 0;
        begin(): void { this.count = 0; this.begun++; }
        beginRetaining(bindings: number[]): Range[] { this.count = bindings.length; return bindings.map((binding, from) => ({ binding, from })); }
    }
    const batch = new Batch();
    const gate = new Float32Array([1, 0]);
    const kept = gate[0]! > 0.5 ? batch.beginRetaining([3, 4]) : (batch.begin(), []);
    if (kept.length !== 2 || kept[1]!.binding !== 4 || batch.begun !== 0) throw new Error("retained " + kept.length + " " + batch.begun);
    const fresh = gate[1]! > 0.5 ? batch.beginRetaining([3, 4]) : (batch.begin(), []);
    let total = 0;
    for (const range of fresh) total += range.from;
    if (fresh.length !== 0 || total !== 0 || batch.begun !== 1 || batch.count !== 0) throw new Error("begun " + fresh.length + " " + batch.begun);
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
    "a bound function runs called at once and in every callback consumer",
    `
    function add(this: { n: number }, a: number, b: number): number { this.n += a + b; return this.n; }
    function tally(this: { n: number }, value: number): void { this.n += value; }
    function scale(this: { k: number }, value: number): number { return value * this.k; }
    const box = { n: 1 };
    if (add.bind(box, 2)(3) !== 6 || box.n !== 6) throw new Error("now " + box.n);
    const counter = { n: 0 };
    new Map([["a", 1], ["b", 2]]).forEach(tally.bind(counter));
    new Set([3, 4]).forEach(tally.bind(counter));
    if (counter.n !== 10) throw new Error("collections " + counter.n);
    const scaled = Array.from([1, 2, 3], scale.bind({ k: 10 }));
    if (scaled.join() !== "10,20,30") throw new Error("from " + scaled.join());
    `,
);

test("supports logical assignment through a call in an array index", () => {
    assert.doesNotThrow(() =>
        compileSource(
            "function f(xs: number[]): void { xs[Math.trunc(Math.random())] ??= 2; } f([1]);",
        ),
    );
});

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
    "fresh-array-local-read-once-stored-as-another-element-type",
    `
    interface Tower { roofMaterial?: string; shape: "cone" | "dome"; id: number }
    interface Needs { towerRoof?: readonly (string | null | undefined)[]; towers?: readonly Tower[] }
    interface Deps { ensureMaterials(needs: Needs): number }
    const kept: Needs[] = [];
    const deps: Deps = { ensureMaterials: (needs) => { kept.push(needs); return needs.towerRoof?.length ?? -1; } };
    const towers: Tower[] = [{ roofMaterial: "slate", shape: "cone", id: 1 }, { shape: "cone", id: 2 }, { roofMaterial: "x", shape: "dome", id: 3 }];
    function run(): number {
      const visible = towers.filter((t) => t.shape === "cone").map((t) => t.roofMaterial);
      return deps.ensureMaterials({ towers, towerRoof: visible });
    }
    let names = "";
    if (run() !== 2) throw new Error("run");
    for (const m of kept[0]!.towerRoof ?? []) names += m == null ? "x" : m;
    if (names !== "slatex") throw new Error("sole " + names);
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

test(
    "arrays of always-present objects grow through length writes",
    { skip: !native },
    () => {
        const result = compileSource(`
    function main(): void {
        const rows: Array<{ id: number }> = [];
        rows.length = 3;
        for (let index = 0; index < rows.length; index++) rows[index] = { id: index };
        if (rows.length !== 3 || rows[2]!.id !== 2) throw new Error("growth");
        rows.length = 1;
        if (rows.length !== 1 || rows[0]!.id !== 0) throw new Error("truncation");
    }
    main();
`);
        runGeneratedProgram(
            native!,
            "language-constructs/dense-length-growth",
            result.cpp,
        );
    },
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
    "declared-record-key-order-through-writes-after-creation",
    `
    type ToolId = "move" | "clone" | "delete" | "resize" | "paint";
    interface Tool { name: string }
    const tools: Partial<Record<ToolId, Tool>> = {};
    tools.resize = { name: "r" };
    tools.move = { name: "m" };
    if (Object.keys(tools).join() !== "resize,move") throw new Error("written keys");
    if (JSON.stringify(tools) !== '{"resize":{"name":"r"},"move":{"name":"m"}}') throw new Error("written json");
    const visited: string[] = [];
    for (const key in tools) visited.push(key);
    if (visited.join() !== "resize,move") throw new Error("written for-in");
    const copy = { ...tools };
    if (Object.keys(copy).join() !== "resize,move") throw new Error("written spread");
    interface Slots { a?: number; b?: number; c?: number }
    const values = [1, 2, 3];
    const first: Slots = {};
    first.b = values[0]!;
    first.a = values[1]!;
    const second: Slots = {};
    second.c = values[2]!;
    second.b = values[0]!;
    const slots: Slots[] = [first, second];
    if (slots.map((row) => Object.keys(row).join()).join("|") !== "b,a|c,b") throw new Error("two write orders");
    if (JSON.stringify(slots) !== '[{"b":1,"a":2},{"c":3,"b":1}]') throw new Error("two write orders json");
    const flags = JSON.parse("[true,false]") as boolean[];
    const runs: string[] = [];
    for (const flag of flags) {
        const run: Slots = {};
        if (flag) run.a = values[0]!;
        run.b = values[1]!;
        run.a = values[2]!;
        runs.push(Object.keys(run).join() + "=" + JSON.stringify(run));
    }
    if (runs.join("|") !== 'a,b={"a":3,"b":2}|b,a={"b":2,"a":3}') throw new Error("conditional write " + runs.join("|"));
`,
);

check(
    "declared-record-key-order-through-writes-no-creation-places",
    `
    interface ThroughAlias { a?: number; b?: number; c?: number }
    interface ThroughParameter { a?: number; b?: number; c?: number }
    interface ThroughKey { a?: number; b?: number; c?: number }
    const values = [1, 2, 3];
    const base: ThroughAlias = {};
    const alias = base;
    alias.c = values[0]!;
    base.a = values[1]!;
    if (Object.keys(base).join() !== "c,a") throw new Error("alias keys " + Object.keys(base).join());
    if (JSON.stringify(base) !== '{"c":1,"a":2}') throw new Error("alias json " + JSON.stringify(base));
    function fill(target: ThroughParameter, first: number): void {
        target.b = first;
        target.a = first + 1;
    }
    const filled: ThroughParameter = {};
    fill(filled, values[2]!);
    const visited: string[] = [];
    for (const key in filled) visited.push(key);
    if (visited.join() !== "b,a") throw new Error("parameter keys " + visited.join());
    if (JSON.stringify({ ...filled }) !== '{"b":3,"a":4}') throw new Error("parameter json " + JSON.stringify(filled));
    const order = JSON.parse('["c","b"]') as (keyof ThroughKey)[];
    const keyed: ThroughKey = {};
    for (const key of order) keyed[key] = values[0]!;
    if (Object.keys(keyed).join() !== "c,b") throw new Error("computed keys " + Object.keys(keyed).join());
    if (JSON.stringify(keyed) !== '{"c":1,"b":1}') throw new Error("computed json " + JSON.stringify(keyed));
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

check(
    "this-field-writes-invalidate-shared-row-facts",
    `
    interface Counter { k: number; untouched: number }
    function assign(this: Counter, value: number): number {
        this.k = value;
        return this.k;
    }
    function assignValue(this: Counter, value: number): number {
        return this["k"] = value;
    }
    function add(this: Counter, by: number): number {
        this.k += by;
        return this.k;
    }
    function addKey(this: Counter, by: number): number {
        this["k"] += by;
        return this["k"];
    }
    const assigned: Counter[] = [{k:1,untouched:7}];
    const assignedAlias = assigned[0]!;
    if (assign.call(assigned[0]!,4)!==4 || assignedAlias.k!==4 || assigned[0]!.k!==4 || assignedAlias.untouched!==7)
        throw new Error("this assignment alias");
    const assignedValue: Counter[] = [{k:2,untouched:8}];
    const valueAlias = assignedValue[0]!;
    if (assignValue.call(assignedValue[0]!,5)!==5 || valueAlias.k!==5 || assignedValue[0]!.k!==5 || valueAlias.untouched!==8)
        throw new Error("this assignment expression alias");
    const compounded: Counter[] = [{k:3,untouched:9}];
    const compoundAlias = compounded[0]!;
    if (add.call(compounded[0]!,4)!==7 || compoundAlias.k!==7 || compounded[0]!.k!==7 || compoundAlias.untouched!==9)
        throw new Error("this compound alias");
    const computed: Counter[] = [{k:4,untouched:10}];
    const computedAlias = computed[0]!;
    if (addKey.call(computed[0]!,5)!==9 || computedAlias.k!==9 || computed[0]!.k!==9 || computedAlias.untouched!==10)
        throw new Error("this computed compound alias");
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

// A write through a selection writes the object it picks; a method writing
// a member's array, or one of the object's own methods writing through
// `this`, gives that array storage.
check(
    "writes-through-selections-and-members-reach-their-objects",
    `
    function local(): void {
        const a = { n: 1 };
        const b = { n: 2 };
        (Number("1") > 0 ? a : b).n = 10;
        const rows = [{ n: 1 }, { n: 2 }];
        (Number("1") > 0 ? rows[1]! : rows[0]!).n = 7;
        const cfg = { list: [1, 2], groups: { a: [1] as number[] } };
        cfg.list.push(3);
        cfg.groups.a.push(4);
        const store = { items: [] as number[], add(v: number): void { this.items.push(v); } };
        store.add(5);
        if (a.n !== 10 || b.n !== 2 || rows[1]!.n !== 7 || rows[0]!.n !== 1 || cfg.list.join() !== "1,2,3" ||
            cfg.groups.a.join() !== "1,4" || store.items.join() !== "5")
            throw new Error("local");
    }
    local();
    const left = { n: 1 };
    const right = { n: 2 };
    (Number("0") > 0 ? left : right).n = 20;
    const shared = { items: [] as number[], add(v: number): void { this.items.push(v); } };
    shared.add(6);
    if (left.n !== 1 || right.n !== 20 || shared.items.length !== 1) throw new Error("module");
`,
);

check(
    "a nested write through a local literal keeps it from folding",
    `
    function configured(): number {
        const config = { limits: { count: 1 }, names: [] as string[] };
        config.limits.count = 2;
        config.names.push("late");
        [config.limits.count] = [config.limits.count + config.names.length];
        return config.limits.count;
    }
    if (configured() !== 3) throw new Error("stale literal");
    `,
);

check(
    "a write through an element read reaches the literal's record",
    `
    function second(): number {
        const values = [{ v: 1 }, { v: 2 }];
        const second = values[1]!;
        second.v = 7;
        return values[1]!.v;
    }
    if (second() !== 7) throw new Error("index alias");
    `,
);

check(
    "a nested write through a literal's element reaches its record",
    `
    function f(): number {
        const values = [{ v: 1 }, { v: 2 }];
        values[1]!.v = 7;
        return values[1]!.v;
    }
    if (f() !== 7) throw new Error("direct nested");
    `,
);

check(
    "an optional callback argument's writes order the arguments read before it",
    `
    function pair(a: number, b: number[]): number { return a; }
    let n = 0;
    function s(xs: number[], cmp?: (a: number, b: number) => number): number { return pair(n, xs.sort(cmp)); }
    const before = s([2, 1], (a, b) => { n++; return a - b; });
    if (before !== 0 || n === 0) throw new Error("order " + before + " " + n);
    `,
);

check(
    "a write through a call's fresh result lands on that result",
    `
    let calls = 0;
    function make(): { n: number; list: number[] } { calls++; return { n: 1, list: [1, 2] }; }
    make().n = 5;
    make().n += 5;
    make().list[0] = 5;
    make().list.push(3);
    const fresh = make();
    if (calls !== 5 || fresh.n !== 1 || fresh.list.join() !== "1,2") throw new Error("fresh " + calls + fresh.n + fresh.list.join());
    `,
);

check(
    "a compound store and an update through an accessor run its setter",
    `
    let gets = 0, sets = 0;
    class A { private x = 1; get v(): number { gets++; return this.x; } set v(n: number) { sets++; this.x = n; } }
    const a = new A();
    a.v += 4;
    a.v++;
    if (a.v !== 6 || gets !== 3 || sets !== 2) throw new Error("compound accessor " + gets + " " + sets);
    `,
);

check(
    "a setter runs for a write by a const key",
    `
    let order = "";
    class A { set v(n: number) { order += "s" + n; } get v(): number { return 0; } }
    const a = new A();
    const k = "v";
    function rhs(): number { order += "r"; return 1; }
    a[k] = rhs();
    if (order !== "rs1") throw new Error("const key setter " + order);
    `,
);

check(
    "a callee's write through a run-time key reaches the argument",
    `
    function pushAt(p: Record<string, number[]>, k: string): void { p[k]!.push(9); }
    const obj = { list: [1] };
    pushAt(obj, Date.now() > 0 ? "list" : "x");
    if (obj.list.length !== 2) throw new Error("run-time key write " + obj.list.length);
    `,
);

check(
    "a-set-of-objects-keeps-each-object-once-by-identity",
    `
    class UploadBatch<T extends object> {
        private readonly dirty = new Set<T>();
        mark(material: T): void { this.dirty.add(material); }
        flush(upload: (material: T) => void): number {
            let count = 0;
            for (const material of this.dirty) { upload(material); count++; }
            this.dirty.clear();
            return count;
        }
    }
    const seen = new Set<object>();
    const a = { n: 1 };
    const b = { n: 2 };
    seen.add(a);
    seen.add(a);
    seen.add(b);
    const batch = new UploadBatch<{ n: number }>();
    batch.mark(a);
    batch.mark(a);
    batch.mark(b);
    let uploaded = 0;
    const flushed = batch.flush((material) => { uploaded += material.n; });
    if (seen.size !== 2 || !seen.has(a) || seen.has({ n: 1 }) || flushed !== 2 || uploaded !== 3) throw new Error("set " + seen.size + " " + flushed);
`,
);

check(
    "a-record-argument-container-field-holds-the-absence-the-program-writes",
    `
    interface Pt { x: number; z: number; w?: number }
    interface Resolved { name: string; easedFull?: readonly { x: number; z: number }[] }
    type Ctx = Pick<Resolved, "name" | "easedFull">;
    function lay(r: Ctx, corners: number): number {
        if (corners > 0) r.easedFull = undefined;
        if (r.easedFull) { const pos = r.easedFull.map((p) => ({ x: p.x, z: p.z })); return pos.length; }
        return -1;
    }
    const gate = new Float32Array([1, 0]);
    const pts: Pt[] = [{ x: 0, z: 0 }, { x: 1, z: 1 }];
    const cleared = lay({ name: "a", easedFull: pts }, gate[0]! > 0.5 ? 1 : 0);
    const kept = lay({ name: "b", easedFull: pts }, gate[1]! > 0.5 ? 1 : 0);
    if (cleared !== -1 || kept !== 2) throw new Error("eased " + cleared + " " + kept);
`,
);
