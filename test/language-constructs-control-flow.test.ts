import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

check(
    "a-var-is-one-binding-per-function-undefined-until-assigned",
    `
    function blocks(c: boolean): string {
        if (c) { var s = "yes"; } else { s = "no"; }
        return s;
    }
    if (blocks(true) + blocks(false) !== "yesno") throw new Error("block " + blocks(true));
    function redeclared(): number {
        var z = 1;
        var z = z + 1;
        { var z = z * 10; }
        return z;
    }
    if (redeclared() !== 20) throw new Error("redeclared " + redeclared());
    function loops(): string {
        const seen: string[] = [];
        const fns: (() => number)[] = [];
        for (let i = 0; i < 3; i++) {
            var x: number | undefined;
            if (i === 0) x = 5;
            seen.push(String(x));
            var captured = i;
            fns.push(() => captured);
        }
        for (var k = 0; k < 2; k++) fns.push(() => k * 100);
        return seen.join() + "|" + fns.map((f) => f()).join() + "|" + k;
    }
    if (loops() !== "5,5,5|2,2,2,200,200|2") throw new Error("loops " + loops());
    function early(): string {
        const read = (): number | undefined => late;
        const before = typeof late + String(read());
        var late: number | undefined = 7;
        return before + read();
    }
    if (early() !== "undefinedundefined7") throw new Error("early " + early());
    function patterns(c: boolean): string {
        if (c) { var [a, b] = [1, 2]; var { t } = { t: "x" }; } else { a = 3; b = 4; t = "y"; }
        let out = t + (a + b);
        for (var item of ["p", "q"]) out += item;
        var item = "r";
        return out + item;
    }
    if (patterns(true) + patterns(false) !== "x3pqry7pqr") throw new Error("patterns " + patterns(true) + patterns(false));
    function cases(k: number): string {
        switch (k) {
            case 1:
                var tag: string | undefined = "one";
            // falls through
            case 2:
                return String(tag);
        }
        return "none";
    }
    if (cases(1) + cases(2) !== "oneundefined") throw new Error("cases " + cases(1) + cases(2));
    var counter = 1;
    var counter = counter + 1;
    function bump(): number { return ++counter; }
    if (bump() !== 3 || counter !== 3) throw new Error("module " + counter);
`,
);

check(
    "a-for-in-of-head-assigns-an-existing-target-as-an-assignment-would",
    `
    let x = 0;
    let sum = 0;
    for (x of [1, 2, 3]) sum += x;
    let a = 0, b = 0, product = 0;
    const pairs: [number, number][] = [[1, 2], [3, 4]];
    for ([a, b] of pairs) product += a * b;
    let k = "";
    const seen: string[] = [];
    for ({ k } of [{ k: "u" }, { k: "v" }]) seen.push(k);
    const o = { v: 0 };
    for (o.v of [2, 5]) sum += o.v;
    let key = "";
    const keyed: Record<string, number> = { m: 1, n: 2 };
    for (key in keyed) seen.push(key);
    let found = 0;
    for (found of [3, 8, 11, 20]) if (found > 10) break;
    const m = new Map<string, number>([["a", 1], ["b", 2]]);
    let mk = "", mv = 0, entries = "";
    for ([mk, mv] of m) entries += mk + mv;
    let cur = 0;
    const get = (): number => cur;
    for (cur of [5, 6]) {}
    const items: { n: number }[] = [];
    for (let i = 0; i < 3; i++) items.push({ n: i });
    let item: { n: number } = { n: -1 };
    for (item of items) item.n += 10;
    const result = x + "|" + sum + "|" + a + "|" + b + "|" + product + "|" + seen.join("") + "|" + o.v + "|" + key + "|" + found + "|" + entries + "|" + get() + "|" + items.map((i) => i.n).join() + "|" + item.n;
    if (result !== "3|13|3|4|14|uvmn|5|n|11|a1b2|6|10,11,12|12") throw new Error(result);
`,
);

check(
    "a-body-running-off-its-end-returns-undefined",
    `
    function f(x: number): number | undefined { if (x > 0) return x; }
    function g(n: number): number | undefined { if (n === 0) return 0; if (n > 0) return g(n - 1); }
    function s(x: number): string | undefined { if (x > 0) return "p"; }
    function find(xs: number[], t: number): number | undefined { for (const x of xs) { if (x === t) return x; } }
    class A { m(x: number): number | undefined { if (x > 0) return x; } }
    if (f(-1) !== undefined || f(2) !== 2) throw new Error("function");
    if (g(-1) !== undefined || g(3) !== 0) throw new Error("recursive function");
    if (s(-1) !== undefined || s(1) !== "p") throw new Error("string result");
    if (find([1, 2], 3) !== undefined || find([1, 2], 2) !== 2) throw new Error("loop");
    if (new A().m(-1) !== undefined) throw new Error("method");
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

check(
    "labeled-jumps-over-retained-callback-records",
    `
    interface T { id: string; when?: (n: number) => boolean; }
    const TS: readonly T[] = [
        { id: "a" },
        { id: "b", when: (n) => n > 1 },
        { id: "c" },
    ];
    let continued = 0;
    outer: for (const t of TS) {
        for (let i = 0; i < 3; i++) {
            if (t.when && t.when(i)) continue outer;
            continued++;
        }
    }
    if (continued !== 8) throw new Error("retained record continue " + continued);
    let broken = 0;
    outer: for (const t of TS) {
        for (let i = 0; i < 3; i++) {
            if (t.when && t.when(i)) break outer;
            broken++;
        }
    }
    if (broken !== 5) throw new Error("retained record break " + broken);
`,
);

test("labeled jumps refuse what they cannot leave", () => {
    for (const [source, message] of [
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
    "an-early-returning-function-returns-records-whose-methods-take-unknown-members",
    `
    interface Input { kind: "error" | "boot"; error: unknown }
    interface Handle { report(input: Input): string | null; dispose(): void }
    interface State { disposed: boolean }
    let state: State | null = null;
    function describe(error: unknown): string {
        if (typeof error === "string") return error;
        if (error instanceof Error) return error.message;
        return String(error);
    }
    function handleOf(s: State): Handle {
        return {
            report: (input) => (s.disposed ? null : input.kind + ":" + describe(input.error)),
            dispose: () => { s.disposed = true; },
        };
    }
    function install(): Handle {
        if (state && !state.disposed) return handleOf(state);
        const s: State = { disposed: false };
        state = s;
        return handleOf(s);
    }
    let out = install().report({ kind: "boot", error: "plain" }) ?? "";
    try { throw new Error("thrown"); } catch (err) { out += install().report({ kind: "error", error: err }) ?? ""; }
    out += install().report({ kind: "error", error: 3 }) ?? "";
    const first = install();
    first.dispose();
    out += String(first.report({ kind: "boot", error: null })) + install().report({ kind: "boot", error: "again" });
    if (out !== "boot:plainerror:thrownerror:3nullboot:again") throw new Error("handle " + out);
`,
);

// A function lowered at its call returns a `map` building empty lists as
// the lists of records it declares, each list its own.
check(
    "early-return-of-a-map-building-empty-lists-in-a-function-lowered-at-its-call",
    `
    interface Crossing { at: number; height: number }
    interface Save { paths?: { x1: number; x2: number }[] }
    interface Carve { pathAt(x: number): number }
    function crossings(runs: number[][], save: Save, carve: Carve, max: number): Crossing[][] {
        const segs = (save.paths ?? []).map((p) => ({ x1: p.x1, x2: p.x2 }));
        if (segs.length === 0) {
            return runs.map(() => []);
        }
        return runs.map((run) => run.filter((at) => carve.pathAt(at) > 0 && segs.some((s) => s.x1 <= at && at <= s.x2)).map((at) => ({ at, height: max })));
    }
    const flag = Math.random() >= 0;
    const runs = [[1, 5, 9], [2]];
    const carve: Carve = { pathAt: (x) => x - 1 };
    const none = crossings(runs, flag ? {} : { paths: [] }, carve, 2);
    if (none.length !== 2 || none[0]!.length !== 0 || none[1]!.length !== 0) throw new Error("none");
    none[1]!.push({ at: 7, height: 1 });
    if (none[0]!.length !== 0 || none[1]![0]!.at !== 7) throw new Error("own lists");
    const some = crossings(runs, { paths: [{ x1: 4, x2: 10 }] }, carve, 3);
    if (some[0]!.length !== 2 || some[0]![1]!.at !== 9 || some[0]![0]!.height !== 3 || some[1]!.length !== 0) throw new Error("some");
`,
);

check(
    "generic-wrapper-with-early-returns-at-a-void-result",
    `
    const rows = Math.random() >= 0 ? new Map<string, number>() : null;
    let uploads = 0;
    const record = (label: string, elapsed: number): void => {
        rows?.set(label, elapsed);
    };
    const track = <T>(label: string, work: () => T): T => {
        if (!rows) return work();
        const started = Date.now();
        try {
            return work();
        } finally {
            record(label, Date.now() - started);
        }
    };
    const upload = (): void => {
        uploads++;
    };
    track("carve", () => upload());
    const welded = track("weld", () => uploads * 2);
    track("mark", () => upload());
    if (uploads !== 2 || welded !== 2 || rows?.size !== 3) throw new Error("uploads " + uploads + " welded " + welded);
`,
);

checkInRealm(
    "a-document-member-called-with-a-dynamic-parameter-runs-or-throws-as-javascript-does",
    `
    async function sameEntry(a: unknown, b: unknown): Promise<boolean> {
        if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
        if (a === b) return true;
        const native = a as { isSameEntry?: (other: unknown) => Promise<boolean> };
        if (typeof native.isSameEntry !== "function") return false;
        try {
            return await native.isSameEntry(b);
        } catch {
            return false;
        }
    }
    const list: unknown[] = JSON.parse('[{"name":"a"},{"name":"b"}]');
    const one: unknown = JSON.parse('{"name":"a"}');
    void (async () => {
        const answers = [await sameEntry(list, list.slice()), await sameEntry(one, list), await sameEntry(one, one)];
        if (answers.join() !== "false,false,true") throw new Error("answers " + answers.join());
        // A member that holds no function throws, as JavaScript does.
        const held = JSON.parse('{"run":3}') as { run?: (value: unknown) => boolean };
        let thrown = "";
        try {
            held.run!(1);
        } catch (error) {
            thrown = error instanceof TypeError ? "type" : "other";
        }
        if (thrown !== "type") throw new Error("thrown " + thrown);
        globalThis.close();
    })();
`,
);

check(
    "for-of-over-an-optional-collection-or-nothing",
    `
    interface Reuse { bucketMeta: Map<string, { variant: number }>; seen?: Set<number> }
    function total(reuse?: Reuse): number {
        let n = 0;
        for (const [key, meta] of reuse?.bucketMeta ?? []) n += meta.variant + key.length;
        for (const id of reuse?.seen ?? []) n += id * 100;
        return n;
    }
    const reuses: (Reuse | undefined)[] = [{ bucketMeta: new Map([["ab", { variant: 3 }]]), seen: new Set([1, 2]) }, undefined, { bucketMeta: new Map() }];
    const totals = reuses.map((reuse) => total(reuse));
    if (totals.join(",") !== "305,0,0") throw new Error("totals " + totals.join(","));
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

// The scheduler runs the callback only after it returns, when the `var`
// holds the id: a stale read would leave the interval running.
checkInRealm(
    "a-var-read-by-the-callback-its-own-initializer-schedules",
    `
    void (async () => {
        await Promise.resolve();
        let ticks = 0;
        var poll = setInterval(() => {
            ticks++;
            if (ticks === 2) {
                clearInterval(poll);
                setTimeout(() => {
                    if (ticks !== 2) throw new Error("the interval read its own id");
                    globalThis.close();
                }, 5);
            }
        }, 0);
    })();
`,
);

// A function read before the assignment sees `undefined`: cancelling it
// clears nothing, as JavaScript's `clearTimeout(undefined)`.
checkInRealm(
    "a-var-a-function-reads-before-its-assignment-holds-undefined",
    `
    void (async () => {
        await Promise.resolve();
        let ticks = 0;
        function tick(): void { ticks++; clearTimeout(t); }
        tick();
        if (ticks === 1) {
            var t = setTimeout(tick, 0);
        }
        setTimeout(() => {
            if (ticks !== 2) throw new Error("the timer read its own id");
            globalThis.close();
        }, 5);
    })();
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
    "a-declaration-initialized-by-a-call-that-always-throws-throws-there",
    `
    interface Shape { kind: string; size: number }
    function need(x: Shape | undefined, check: (s: Shape) => boolean): Shape {
        if (!x || !check(x)) throw new Error("need");
        return x;
    }
    function pick<T extends { kind: string }>(x: T | undefined, kind: string): T {
        if (!x || x.kind !== kind) throw new Error("pick " + kind);
        return x;
    }
    let after = 0, caught = "";
    try {
        const shape = need(undefined, (s) => s.kind === "box");
        after += shape.size;
    } catch (error) {
        caught = error instanceof Error ? error.message : "other";
    }
    if (caught !== "need" || after !== 0) throw new Error("checked helper " + caught);
    try {
        let first = 1, shape = pick<Shape>(undefined, "box"), last = 2;
        after += shape.size + first + last;
    } catch (error) {
        caught = error instanceof Error ? error.message : "other";
    }
    if (caught !== "pick box" || after !== 0) throw new Error("generic helper " + caught);
    const valid = need({ kind: "box", size: 3 }, (s) => s.kind === "box");
    if (valid.size !== 3 || pick<Shape>(valid, "box") !== valid) throw new Error("valid configuration");
`,
);

// Write sites: every write form counts where a proof depends on a binding
// or an array staying unchanged.
check(
    "a loop bound by an array it reassigns keeps checked reads",
    `
    function sum(input: number[]): number {
        let rows = input;
        let total = 0;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i]! < 0) rows = [];
            total += rows[i] ?? 100;
        }
        return total;
    }
    if (sum([1, -1, 2]) !== 101) throw new Error("reassigned bound");
    `,
);

check(
    "a counter its loop writes by destructuring bounds no growth",
    `
    const limit = 2;
    const values: number[] = [];
    for (let i = 0; i < limit; i++) {
        [i] = [i + 3];
        values[i] = i;
    }
    if (values.length !== 4 || values[3] !== 3)
        throw new Error("counter written in its loop");
    `,
);

check(
    "a case's final break to an enclosing loop leaves the loop",
    `
    let hits = 0;
    outer: for (let i = 0; i < 3; i++) {
        switch (i) {
            case 1: hits += 10; break outer;
        }
        hits++;
    }
    let braced = 0;
    outer2: for (let i = 0; i < 3; i++) {
        switch (i) {
            case 1: { braced += 10; break outer2; }
        }
        braced++;
    }
    let own = 0;
    for (let i = 0; i < 3; i++) {
        sw: switch (i) {
            case 1: own += 10; break sw;
        }
        own++;
    }
    if (hits !== 11 || braced !== 11 || own !== 13) throw new Error(hits + ":" + braced + ":" + own);
    `,
);

check(
    "a method call on a nullish receiver throws a TypeError",
    `
    let kind = "";
    const o: { m(): number } | null = Math.random() > 2 ? { m: () => 1 } : null;
    try { o!.m(); } catch (e) { kind = e instanceof TypeError ? "TypeError" : "other"; }
    if (kind !== "TypeError") throw new Error("kind " + kind);
    `,
);

check(
    "case labels evaluate in order until one matches",
    `
    let log = "";
    function c(n: number): number { log += n; return n; }
    function pick(x: number): string {
        switch (x) { case c(1): return "a"; case c(2): return "b"; case c(3): return "c"; }
        return "none";
    }
    function fall(x: number): string {
        let out = "";
        switch (x) { case c(1): out += "a"; case c(2): out += "b"; break; default: out += "d"; case c(3): out += "c"; }
        return out;
    }
    const first = pick(2) + ":" + log;
    log = "";
    const second = fall(1) + ":" + log;
    log = "";
    const third = fall(5) + ":" + log;
    if (first !== "b:12" || second !== "ab:1" || third !== "dc:123") throw new Error("case order " + first + " " + second + " " + third);
    `,
);

check(
    "Object.keys, Object.entries and for-in enumerate an unknown element as the member it holds",
    `
    const boxed: unknown[] = [];
    boxed.push({ a: 1, b: 2 });
    boxed.push(7);
    boxed.push("xy");
    let out = "";
    for (const value of boxed) {
        const record = value as Record<string, unknown>;
        out += Object.keys(value as object).join() + "|" + Object.keys(record).join() + "|";
        for (const key in value as object) out += key;
        for (const key in record) out += key;
        out += "|" + Object.entries(record).map(([key, item]) => key + "=" + String(item)).join() + ";";
    }
    if (out !== "a,b|a,b|abab|a=1,b=2;|||;0,1|0,1|0101|0=x,1=y;") throw new Error(out);
    `,
);

check(
    "for-in walks no keys of a null or undefined document",
    `
    const docs: unknown[] = JSON.parse('[{"a":1},null,3,"xy"]');
    docs.push(undefined);
    let out = "";
    for (const doc of docs) {
        for (const key in doc as object) out += key;
        out += ";";
    }
    if (out !== "a;;;01;;") throw new Error(out);
    `,
);

check(
    "a folded if that breaks leaves the switch clause, not the switch",
    `
    const T = true;
    function f(k: number): number { switch (k) { case 0: if (T) break; default: return 2; } return 1; }
    function g(n: number): number { let s = 0; for (let i = 0; i < n; i++) { switch (i) { case 0: if (T) break; default: s += 10; } s += 1; } return s; }
    if (f(0) !== 1 || f(5) !== 2 || g(3) !== 23) throw new Error("folded break " + f(0) + f(5) + g(3));
    `,
);

check(
    "writing a getter-only member throws a TypeError",
    // A module is strict code; the reference run is a script, so it says so.
    `"use strict";
    const o = { get x(): number { return 1; } };
    let threw = false;
    try { (o as { x: number }).x = 5; } catch (e) { threw = e instanceof TypeError; }
    if (!threw || o.x !== 1) throw new Error("getter-only write " + threw);
    `,
);

check(
    "a switch clause's early break reaches the code after the switch",
    `
    function grade(k: number, x: boolean): number {
        switch (k) { case 1: if (x) break; return 10; default: return 20; }
        return 30;
    }
    let n = 0;
    function run(k: number, x: boolean): number {
        try { switch (k) { case 1: if (x) break; return 1; default: return 2; } }
        finally { n++; }
        return 3;
    }
    const k = Date.now() > 0 ? 1 : 2;
    if (grade(k, true) !== 30 || grade(k, false) !== 10 || grade(k + 1, true) !== 20) throw new Error("grade");
    if (run(k, true) + run(k, false) * 10 !== 13 || n !== 2) throw new Error("try break " + n);
    `,
);

check(
    "a closure over a for-of binding sees a later write in the loop body",
    `
    const fns: (() => number)[] = [];
    for (let v of [1, 2]) {
        fns.push(() => v);
        v *= 10;
    }
    function make(o: { n: number }): () => number {
        let { n } = o;
        const get = () => n;
        n = 5;
        return get;
    }
    if (fns.map((f) => f()).join() !== "10,20" || make({ n: 1 })() !== 5) throw new Error("late write " + fns.map((f) => f()).join());
    `,
);

check(
    "a hoisted var reads where every path assigned it",
    `
    function sw(k: number): string {
        switch (k) {
            case 1:
                var s = "one";
                break;
            default:
                s = "other";
        }
        return s;
    }
    function tc(fail: boolean): number {
        try {
            if (fail) throw new Error("x");
            var v = 2;
        } catch {
            v = -1;
        }
        return v;
    }
    function loop(): number {
        for (;;) {
            var n = 4;
            break;
        }
        return n!;
    }
    function cond(c: boolean): number {
        {
            var t: number;
        }
        c ? (t = 1) : (t = 2);
        return t;
    }
    if (sw(1) + sw(2) !== "oneother") throw new Error("switch");
    if (tc(false) !== 2 || tc(true) !== -1) throw new Error("try");
    if (loop() !== 4) throw new Error("loop");
    if (cond(true) + cond(false) !== 3) throw new Error("cond");
    `,
);

check(
    "a-bare-early-return-beside-a-final-value-return-returns-undefined",
    `
    const gate = new Float32Array([1, 0]);
    let applied = 0;
    const apply = (): boolean => { applied++; return true; };
    const set = (id: number): number | undefined => {
        if (gate[1]! > 0 || id < 0) {
            apply();
            return;
        }
        const request = id * 2;
        return request + (apply() ? 1 : 0);
    };
    const skipped = set(-1);
    const kept = set(3);
    if (skipped !== undefined || kept !== 7 || applied !== 2) throw new Error("set " + String(skipped) + " " + String(kept));
`,
);
