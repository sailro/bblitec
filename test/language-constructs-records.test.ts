import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runGeneratedProgram } from "./native-fixture.js";
import { check, native } from "./language-constructs.js";

check(
    "a-rebound-object-binding-reads-its-current-object",
    `
    let cfg = { n: 1, s: "a" };
    const read = () => cfg.n;
    cfg = { n: 2, s: "b" };
    if (cfg.n !== 2 || cfg.s !== "b" || read() !== 2) throw new Error("rebound let");
    let last = { n: 0 };
    for (let i = 1; i <= 3; i++) last = { n: i };
    if (last.n !== 3) throw new Error("rebound in a loop");
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
    "union-arms-told-apart-by-their-fields",
    `
    type Refusal = { owner: string; reason: "surface" | "busy" };
    type Outcome = { readonly changed: true; readonly created?: number } | { readonly changed: false; readonly refusal: Refusal };
    type Result =
        | { readonly changed: true; readonly hostId: number; readonly created?: number }
        | { readonly changed: false; readonly reason: "invalid-request" | "unknown-host" }
        | { readonly changed: false; readonly refusal: Refusal };
    function success(hostId: number, outcome: Outcome): Result {
        if (!outcome.changed) return outcome;
        return outcome.created === undefined ? { changed: true, hostId } : { changed: true, hostId, created: outcome.created };
    }
    function execute(raw: number): Result {
        if (raw < 0) return { changed: false, reason: "invalid-request" };
        if (raw === 0) return { changed: false, refusal: { owner: "x", reason: "busy" } };
        return success(raw, { changed: true });
    }
    const a = execute(-1), b = execute(0), c = execute(2);
    if (JSON.stringify(a) !== '{"changed":false,"reason":"invalid-request"}') throw new Error("reason arm");
    if (JSON.stringify(b) !== '{"changed":false,"refusal":{"owner":"x","reason":"busy"}}') throw new Error("refusal arm");
    if (JSON.stringify(c) !== '{"changed":true,"hostId":2}') throw new Error("changed arm");
    if ("refusal" in a || "reason" in b || "hostId" in a || Object.keys(a).join(",") !== "changed,reason") throw new Error("own keys");
    const all: Result[] = [a, b, c, success(5, { changed: true, created: 9 })];
    const reasons = all.map((r) => (!r.changed && "reason" in r ? r.reason : r.changed ? "ok:" + (r.created ?? "-") : "refused:" + r.refusal.reason));
    if (reasons.join(",") !== "invalid-request,refused:busy,ok:-,ok:9") throw new Error("narrowing");
    type Tie = { kind: "tree"; id: number } | { kind: "post"; x: number };
    type Plan = { key: number; tie: Tie; a: number; b: number } | { key: number; tie: null; reason: string };
    const why = new Map<number, { reason: string }>([[2, { reason: "blocked" }]]);
    const plans: Plan[] = [];
    for (const key of [1, 2, 3]) {
        if (key === 1) plans.push({ key, tie: { kind: "tree", id: 2 }, a: 1, b: 2 });
        else plans.push({ key, tie: null, reason: why.get(key)?.reason ?? "unknown" });
    }
    const [first, second, third] = plans;
    if (!first || first.tie === null || first.a !== 1 || !second || second.tie !== null || second.reason !== "blocked") throw new Error("plans");
    if (!third || third.tie !== null || third.reason !== "unknown" || JSON.stringify(third) !== '{"key":3,"tie":null,"reason":"unknown"}') throw new Error("null tie");
`,
);

check(
    "object-fields-keep-the-identity-of-the-records-they-hold",
    `
    interface Config { left: string }
    interface Ctx { scope: object; label: string }
    interface Hint { show(config: Config): void; active(): boolean; context(): Ctx | null }
    function createHint(): Hint {
        let current: Config | null = null;
        return {
            show: (config: Config) => { current = config; },
            active: () => current !== null,
            context: () => (current ? { scope: current, label: current.left } : null),
        };
    }
    let hint: Pick<Hint, "context" | "active"> | null = null;
    let scope: object | null = null;
    let changes = 0;
    function poll(): void {
        const context = hint?.context() ?? null;
        if (context?.scope !== scope) { scope = context?.scope ?? null; changes++; }
    }
    const created = createHint();
    hint = created;
    const first: Config = { left: "x" };
    created.show(first);
    poll();
    poll();
    created.show({ left: "x" });
    poll();
    created.show(first);
    poll();
    if (changes !== 3 || scope !== first || hint.context()?.label !== "x") throw new Error("changes " + changes);
`,
);

check(
    "empty-object-tokens-compare-by-identity",
    `
    declare const brand: unique symbol;
    type Id = Readonly<{ readonly [brand]: true }>;
    const capability = (() => {
        const constructorToken = {};
        let issue!: (value: number) => Id;
        let value!: (id: Id) => number;
        class Capability {
            readonly #value: number;
            constructor(token: object, durable: number) {
                if (token !== constructorToken) throw new TypeError("private constructor token");
                this.#value = durable;
            }
            static {
                issue = (durable) => new Capability(constructorToken, durable) as unknown as Id;
                value = (id) => (id as unknown as Capability).#value;
            }
        }
        return { issue, value } as const;
    })();
    const a = capability.issue(3), b = capability.issue(4);
    if (capability.value(a) !== 3 || capability.value(b) !== 4 || a === b) throw new Error("issued");
    const token = {}, other = {};
    const alias = token;
    if (!(alias === token) || token === (other as object) || alias !== token) throw new Error("tokens");
`,
);

check(
    "list-grown-through-the-parameters-of-inlined-calls",
    `
    type Event = { kind: "birth"; where: number } | { kind: "death"; index: number; cause: number; id: number } | { kind: "debug"; index: number; cause?: number };
    interface State { id: Int32Array; dead: Uint8Array }
    function emitDeath(state: State, index: number, cause: number, events: Event[]): void {
        state.dead[index] = 1;
        events.push({ kind: "death", index, cause, id: state.id[index]! });
    }
    function stepLifecycle(state: State, events: Event[]): void {
        for (let i = 0; i < state.id.length; i++) {
            if (state.id[i]! > 1 && state.dead[i] === 0) emitDeath(state, i, 7, events);
            else if (state.dead[i] === 0) events.push({ kind: "debug", index: i });
        }
    }
    const make = (): State => ({ id: new Int32Array([1, 2, 3]), dead: new Uint8Array(3) });
    const step = (state: State, events: Event[]): void => { stepLifecycle(state, events); };
    const run = (): number => {
        const state = make();
        const events: Event[] = [];
        for (let n = 0; n < 2; n++) step(state, events);
        const debug = events.filter((event) => event.kind === "debug");
        return events.length * 10 + debug.length;
    };
    const out = run();
    if (out !== 42) throw new Error("run " + out);
`,
);

test("a compile-time record lacking a property its type requires refuses the read", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Row { source: string; count: number; }
            const row = { count: 1 } as Row;
            if (row.source !== undefined) throw new Error("source");
            `),
        /Static record has no property 'source'/,
    );
});

test("an open record projected into fields of another entry type refuses", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Named { label: string; }
            const fields: [string, number][] = [["label", 1]];
            const named = Object.fromEntries(fields) as unknown as Named;
            const show = (value: Named): string => value.label;
            const shows: Array<(value: Named) => string> = [show];
            if (shows[0]!(named) !== "1") throw new Error("label");
            `),
        /Open string record cannot project field 'label' into .*; destination fields must hold its entry type/,
    );
});

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

check(
    "record-scalars-beside-written-members",
    `
    // A callee writing through one member of a record it is handed: the
    // record's own scalars hold, unless a member's code can name the record.
    interface Options { seen: Map<string, number>; tint?: boolean; name: string; nested: { count: number }; reset: () => void }
    function grow(seen: Map<string, number>): void { seen.set("k", seen.size + 1); }
    function describe(opts: Options): string {
        grow(opts.seen);
        opts.reset();
        return (opts.tint ? "tinted" : "plain") + opts.name + opts.nested.count + opts.seen.size;
    }
    const resetting: Options = { seen: new Map(), tint: true, name: "-a", nested: { count: 1 }, reset: () => {} };
    resetting.reset = () => { resetting.tint = false; };
    const first = describe(resetting);
    const kept: Options = { seen: new Map<string, number>(), tint: true, name: "-b", nested: { count: 2 }, reset: () => {} };
    const second = describe(kept);
    if (first !== "plain-a11" || second !== "tinted-b21" || resetting.tint !== false) throw new Error(first + " " + second);
`,
);

check(
    "a-conditional-of-two-boolean-literals-knows-neither",
    `
    const present = (x: number | undefined): boolean => (x === undefined ? false : true);
    const checks: ((x: number | undefined) => boolean)[] = [present];
    let trues = 0;
    for (const check of checks) {
        if (check(4)) trues++;
        if (check(undefined)) trues++;
    }
    const read = (): number | undefined => (trues > 0 ? 3 : undefined);
    const x = read();
    const ok = x === undefined ? false : true;
    const text = String(ok);
    if (trues !== 1 || text !== "true") throw new Error("trues " + trues + " text " + text);
`,
);

test("unsupported language shapes refuse explicitly", () => {
    for (const [name, source, message] of [
        [
            "generator delegation to a Set",
            "function* gen(): Generator<number> { yield* new Set([1]); } for (const v of gen()) {}",
            /yield\* delegates to a generator, an iterator or an array/,
        ],
        [
            "Object.is over native plain records",
            "const a = { x: 1 }; const b = { x: 1 }; if (Object.is(a, b)) {}",
            /Object.is compares/,
        ],
        [
            "in operator on a primitive number",
            'function f(n: number): boolean { return "x" in n; } f(1);',
            /'in' is decided/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message, name);
});

check(
    "membership-on-a-union-laid-out-like-another",
    `
    type Vec3 = [number, number, number];
    class SolidBatch { colors: number[] = []; recolorInstances(from: number, len: number, tint: Vec3): void { this.colors.push(from + len + tint[0]); } scaleInstanceColors(from: number, len: number, ratio: Vec3): void { this.colors.push(from * ratio[1] + len); } }
    class BrickBatch { tints: number[] = []; recolorVariantInstances(variant: number, from: number, len: number, tint: Vec3): void { this.tints.push(variant + from + len + tint[2]); } }
    type Action =
      | { solid: SolidBatch; from: number; len: number; tint: Vec3 }
      | { solid: SolidBatch; from: number; len: number; ratio: Vec3 }
      | { pomFlat: BrickBatch; brick: boolean; variant: number; from: number; len: number; tint: Vec3 }
      | { parts: BrickBatch; brick: boolean; variant: number; from: number; len: number; partAt: (i: number) => "body" | "roof" };
    const body = new SolidBatch(), cone = new SolidBatch(), bricks = new BrickBatch();
    const ops: ({ solid: SolidBatch; from: number; len: number } | { brick: BrickBatch; from: number; len: number; variant: number })[] = [
      { solid: body, from: 0, len: 2 }, { solid: cone, from: 2, len: 3 }, { brick: bricks, from: 5, len: 1, variant: 2 }];
    const actions: Action[] = [];
    const tint: Vec3 = [1, 2, 3];
    for (const op of ops) {
      if ("solid" in op) {
        if (op.solid === body) actions.push({ solid: body, from: op.from, len: op.len, tint });
        else actions.push({ solid: op.solid, from: op.from, len: op.len, ratio: [2, 2, 2] });
      } else if (op.variant > 1) actions.push({ pomFlat: op.brick, brick: true, variant: op.variant, from: op.from, len: op.len, tint });
      else actions.push({ parts: op.brick, brick: false, variant: op.variant, from: op.from, len: op.len, partAt: (i) => (i > 0 ? "roof" : "body") });
    }
    for (const a of actions) {
      if ("solid" in a) {
        if ("tint" in a) a.solid.recolorInstances(a.from, a.len, a.tint);
        else a.solid.scaleInstanceColors(a.from, a.len, a.ratio);
      } else if ("pomFlat" in a) a.pomFlat.recolorVariantInstances(a.variant, a.from, a.len, a.tint);
      else a.parts.recolorVariantInstances(a.variant, a.from, a.len, a.partAt(1) === "roof" ? tint : [0, 0, 0]);
    }
    if (body.colors.join(",") !== "3" || cone.colors.join(",") !== "7" || bricks.tints.join(",") !== "11") throw new Error("actions " + body.colors.join(",") + "|" + cone.colors.join(",") + "|" + bricks.tints.join(","));
`,
);

check(
    "fresh-literal-built-in-the-one-record-type-it-reaches",
    `
    interface Sight { point: ArrayLike<number>; body: object | null }
    interface Hit { point: [number, number, number]; distance: number }
    interface PhotographerDeps { sight(u: number, v: number): Sight | null }
    function total(sight: Sight | null): number {
        if (!sight) return -1;
        let sum = 0;
        for (let i = 0; i < sight.point.length; i++) sum += sight.point[i]!;
        return sum;
    }
    function createPhotographer(deps: PhotographerDeps) {
        const bodies = new Map<object, number>();
        return {
            shoot(u: number, v: number): number {
                const seen = deps.sight(u, v);
                if (seen?.body) bodies.set(seen.body, 1);
                return total(seen) + bodies.size;
            },
        };
    }
    interface Picking { pick(x: number, y: number): Hit | null }
    function createGlade(picking: Picking) {
        return createPhotographer({
            sight(u, v) {
                const hit = picking.pick(u, v);
                return hit ? { point: hit.point, body: null } : null;
            },
        });
    }
    const hits: Hit[] = [{ point: [1, 2, 3], distance: 1 }];
    const photographer = createGlade({ pick: (x) => hits[x] ?? null });
    hits[0]!.point[2] = 4;
    const first = photographer.shoot(0, 0);
    const missed = photographer.shoot(1, 0);
    if (first !== 7 || missed !== -1) throw new Error("shots " + first + " " + missed);
`,
);

check(
    "readonly-records-are-their-records",
    `
    const LANGS = ["en", "fr"] as const;
    type Lang = typeof LANGS[number];
    type Dict = Record<string, string>;
    const EN: Dict = { hello: "hello" };
    const FR: Dict = { hello: "bonjour" };
    const TABLES: Record<Lang, Dict> = { en: EN, fr: FR };
    function shipped(): Readonly<Record<Lang, Readonly<Dict>>> { return TABLES; }
    function read(tables: Readonly<Record<Lang, Dict>>, lang: Lang, key: string): string { return tables[lang][key] ?? "?"; }
    const view = shipped();
    if (view.fr !== FR) throw new Error("shared dictionary");
    FR["late"] = "tard";
    if (view.fr["late"] !== "tard" || read(TABLES, "fr", "late") !== "tard") throw new Error("shared dictionary writes");
    if (LANGS.map((lang) => read(view, lang, "hello")).join(",") !== "hello,bonjour") throw new Error("runtime keys");
    const stored: Array<typeof shipped> = [shipped];
    if (stored[0]!().fr["late"] !== "tard") throw new Error("stored function result");
    const DELTA: Readonly<Record<"n" | "s", readonly [number, number]>> = { n: [0, -1], s: [0, 1] };
    const steps: Array<"n" | "s"> = ["s", "n", "s"];
    if (steps.map((d) => DELTA[d][1]).join(",") !== "1,-1,1") throw new Error("read-only table");
`,
);

check(
    "a-record-parameter-stays-one-object-wherever-it-is-stored",
    `
    interface Count { n: number }
    function assign(p: Count): number { let o: Count; o = p; o.n = 2; return p.n; }
    function destructure(p: Count): number { let o: Count; [o] = [p]; o.n = 3; return p.n; }
    function iterate(p: Count): number { for (const o of [p]) o.n = 4; return p.n; }
    function reassigned(p: Count): number { let o: Count = { n: 0 }; o = p; p.n = 5; return o.n; }
    function boxed(p: Count): number { const box = { item: p }; box.item.n = 6; return p.n; }
    function nested(p: { inner: Count }): number { let o: Count; o = p.inner; o.n = 7; return p.inner.n; }
    function twice(p: Count, by: number): number { let o: Count; o = p; o.n += by; return p.n; }
    if (assign({ n: 1 }) !== 2) throw new Error("assignment");
    if (destructure({ n: 1 }) !== 3) throw new Error("destructuring assignment");
    if (iterate({ n: 1 }) !== 4) throw new Error("for-of binding");
    if (reassigned({ n: 1 }) !== 5) throw new Error("write through the parameter");
    if (boxed({ n: 1 }) !== 6) throw new Error("object field");
    if (nested({ inner: { n: 1 } }) !== 7) throw new Error("nested record");
    if (twice({ n: 1 }, 1) !== 2 || twice({ n: 10 }, 5) !== 15) throw new Error("separate calls");
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
            `const names = ["a"]; console.log(/^a/m.test(names[0]!));`,
            /Reached RegExp literals support the g, i and u flags, not 'm'/,
        ],
    ];
    for (const [source, message] of refusals)
        assert.throws(() => compileSource(source), message);
});

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
    "a-record-in-a-discriminated-literal-field-is-the-selected-arm",
    `
    interface ConeHost { x: number; baseY: number }
    interface GableHost { cx: number; eaveY: number }
    interface Envelope { id: number; x: number; baseY: number; radius: number }
    interface Cone { readonly kind: "cone"; readonly host: ConeHost }
    interface Gable { readonly kind: "gable"; readonly host: GableHost }
    interface Disc { readonly kind: "disc"; readonly radius: number }
    type Carrier = Cone | Gable | Disc;
    interface Tower { roof: { kind: "cone"; envelope: Envelope } | { kind: "disc"; radius: number } }
    function append(out: Carrier[], tower: Tower): void {
        if (tower.roof.kind === "cone") out.push({ kind: "cone", host: tower.roof.envelope });
        else out.push({ kind: "disc", radius: tower.roof.radius });
    }
    const envelope: Envelope = { id: 1, x: 2, baseY: 3, radius: 1 };
    const out: Carrier[] = [{ kind: "gable", host: { cx: 5, eaveY: 1 } }];
    for (const tower of [{ roof: { kind: "cone", envelope } }, { roof: { kind: "disc", radius: 4 } }] as Tower[]) append(out, tower);
    envelope.x = 7;
    const cone = out[1]!;
    if (cone.kind !== "cone" || cone.host.x !== 7 || (cone.host as Envelope) !== envelope) throw new Error("one object");
    cone.host.baseY = 9;
    if (envelope.baseY !== 9 || JSON.stringify(cone.host) !== '{"id":1,"x":7,"baseY":9,"radius":1}') throw new Error("written through the arm");
    const gable = out[0]!;
    if (gable.kind !== "gable" || gable.host.cx !== 5 || out[2]!.kind !== "disc") throw new Error("other arms");
`,
);

check(
    "a-map-of-records-stored-as-a-map-of-another-record-type-stays-one-map",
    `
    interface Brick { variant: number; uh: number; vh: number; wh: number; seed: number }
    interface Meta { variant: number; rep: { uh: number; vh: number; wh: number } }
    interface Prepared { bucketMeta: Map<string, Meta>; count: number }
    let kept: Map<string, { variant: number; rep: Brick }> | null = null;
    function prepare(bricks: readonly Brick[]): Prepared {
        const entries = bricks.map((brick): [string, { variant: number; rep: Brick }] => [\`\${brick.variant}\`, { variant: brick.variant, rep: brick }]);
        const bucketMeta = new Map(entries.map(([key, bucket]) => [key, { variant: bucket.variant, rep: bucket.rep }]));
        kept = bucketMeta;
        return { bucketMeta, count: entries.length };
    }
    const brick = (variant: number): Brick => ({ variant, uh: 1, vh: 2, wh: 3, seed: 0.5 });
    const bricks = [brick(0), brick(1)];
    const prepared = prepare(bricks);
    prepared.bucketMeta.get("1")!.rep.vh = 5;
    if (bricks[1]!.vh !== 5 || prepared.bucketMeta.get("0")!.rep !== bricks[0]) throw new Error("one record");
    prepared.bucketMeta.delete("0");
    if (kept!.size !== 1 || kept!.get("1")!.rep.seed !== 0.5) throw new Error("one map");
`,
);

check(
    "a-property-a-parameter-type-declares-joins-the-narrower-record-written-through-it",
    `
    interface Placement { handle: number; y: number }
    interface Body { id: number; baseY: number }
    type NativeEnvelope<T> = T & { hostLocal?: Placement };
    const place = <T extends { id: number }>(envelope: NativeEnvelope<T>, y: number): NativeEnvelope<T> => {
        const handle = envelope.id * 10;
        const placement = envelope.hostLocal ?? (envelope.hostLocal = { handle, y });
        placement.handle = handle;
        placement.y = y;
        return envelope;
    };
    const bodies: Body[] = [{ id: 1, baseY: 2 }, { id: 2, baseY: 3 }];
    for (const body of bodies) place(body, body.baseY);
    const first: NativeEnvelope<Body> = bodies[0]!;
    const kept = first.hostLocal;
    place(first, 7);
    if (first.hostLocal !== kept || kept?.y !== 7 || kept.handle !== 10) throw new Error("one placement");
    if ((bodies[1] as NativeEnvelope<Body>).hostLocal?.y !== 3) throw new Error("second body");
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
    "shared-body-record-argument-members",
    `
    // A shared body specialized on a static key and a record argument reads
    // the record's runtime members from the caller.
    const EN: Record<string, string> = { "status.ready": "Ready {count}", "status.paused": "Paused" };
    const FR: Record<string, string> = { "status.ready": "Pret {count}", "status.paused": "Pause" };
    type Lang = "en" | "fr";
    const TABLES: Record<Lang, Record<string, string>> = { en: EN, fr: FR };
    let current: Lang = "en";
    function translate(lang: Lang, key: string, params?: Record<string, string>): string {
        let s = TABLES[lang][key] ?? EN[key] ?? key;
        if (params) for (const [k, v] of Object.entries(params)) s = s.split("{" + k + "}").join(v);
        return s;
    }
    function t(key: string, params?: Record<string, string>): string { return translate(current, key, params); }
    interface Path { points: number[] }
    interface Snapshot { path?: Path }
    const enum Phase { Paused, Ready }
    function status(snapshot: Snapshot, phase: Phase): string {
        switch (phase) {
            case Phase.Paused: return t("status.paused");
            case Phase.Ready: return t("status.ready", { count: String(snapshot.path?.points.length ?? 0) });
        }
    }
    const statuses: Array<typeof status> = [status];
    if (statuses[0]!({ path: { points: [1, 2, 3] } }, Phase.Ready) !== "Ready 3") throw new Error("ready");
    current = "fr";
    if (statuses[0]!({}, Phase.Ready) !== "Pret 0") throw new Error("ready without a path");
    if (statuses[0]!({}, Phase.Paused) !== "Pause") throw new Error("paused");
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

// An argument is checked against the call's type at its position: a
// generic tuple parameter's instantiation, a bound function's rest element.
check(
    "arguments-checked-at-their-resolved-position",
    `
    function swap<T>(pair: [T, T]): [T, T] { return [pair[1], pair[0]]; }
    let n = 1;
    for (let i = 0; i < 3; i++) n += i;
    const swapped = swap([n, 2]);
    const box = { n: 1 };
    function bump(this: { n: number }, by: number, label: string): void { this.n += by + label.length; }
    const bound = bump.bind(box);
    bound(5, "ab");
    if (swapped[0] !== 2 || swapped[1] !== n || box.n !== 8)
        throw new Error("arguments " + swapped[0] + " " + box.n);
`,
);

check(
    "empty-object-tokens-compare-by-identity",
    `
    const token = {};
    const other = {};
    if (token === other || token !== token) throw new Error("token identity");
    const alias = token;
    if (alias !== token || alias === other) throw new Error("alias");
    function same(value: object): boolean { return value === token; }
    const checks: Array<(value: object) => boolean> = [same];
    if (!same(token) || same(other)) throw new Error("argument identity");
    if (!checks[0]!(token) || checks[0]!(other)) throw new Error("stored token identity");
`,
);

// A record holding meshes, stored in an `object` field, is that very record:
// the document holds it boxed by reference, its live fields read through the
// box, and its mesh field refuses reflection, as no document holds a handle.
test("an object field holds a record whose fields hold meshes as that record", (t) => {
    const { cpp } = compileSource(`
        import { createBox, type EngineContext, type Mesh } from "@babylonjs/lite";
        interface Placed { x: number }
        interface Marker extends Placed { tag: number; meshes: Mesh[] }
        interface Frame { x: number; owner?: object }
        function frameOf(placed: Placed): Frame | null {
            if (!Number.isFinite(placed.x)) return null;
            return { x: placed.x * 2, owner: placed };
        }
        function inspect(engine: EngineContext): number {
            const mesh = createBox(engine);
            const markers: Marker[] = [{ x: 1, tag: 3, meshes: [mesh] }, { x: 2, tag: 4, meshes: [] }];
            const frames = new Map<object, Frame>();
            for (const marker of markers) {
                const frame = frameOf(marker);
                if (frame) frames.set(marker, frame);
            }
            const first = frames.get(markers[0]!);
            if (!first || first.owner !== markers[0] || first.x !== 2) throw new Error("owner identity");
            if (frames.get(markers[1]!)?.owner === markers[0]) throw new Error("distinct owners");
            markers[0]!.tag = 7;
            if ((first.owner as { tag?: unknown }).tag !== 7) throw new Error("live view");
            if (markers[0]!.meshes.length !== 1) throw new Error("meshes");
            return frames.size;
        }
        const inspections: Array<typeof inspect> = [inspect];
    `);
    assert.match(
        cpp,
        /if \(key == "meshes"\) return bbl::js::native_handle_field_json\(key, value->\w+\);/,
    );
    const entry =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "inspection entry");
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        native,
        "language-constructs/object-field-record-with-meshes",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                return {0, 0};
            }
        }
        int main() {
            const bbl::js::RealmScope realm;
            auto engine = std::make_shared<bbl::Engine>();
            bblscene::${entry[2]} environment{};
            assert(bblscene::${entry[1]}(environment, bbl::StoredEngine{engine}) == 2);
            bool refused = false;
            try {
                static_cast<void>(bblscene::json_value_property(bbl::js::make_ref<bblscene::MarkerData>(), "meshes"));
            } catch (const std::runtime_error&) {
                refused = true;
            }
            assert(refused);
        }
    `,
    );
});

check(
    "a record's member kept by a constructed instance or a literal is the same object",
    `
    class H { constructor(public o: { n: number }) {} bump(): void { this.o.n++; } }
    const CFG = { a: { n: 1 }, b: { n: 1 } };
    new H(CFG.a).bump();
    const holder = { o: CFG.b, list: [CFG.b] };
    holder.o.n = 3;
    holder.list[0]!.n += 1;
    const scalar = { speed: 2 };
    const opts = { s: scalar.speed };
    opts.s = 9;
    if (CFG.a.n !== 2 || CFG.b.n !== 4 || scalar.speed !== 2) throw new Error("kept member " + CFG.a.n + " " + CFG.b.n);
    `,
);

check(
    "a record member reached by identity is the member itself",
    `
    function bump(o: { n: number }): void { o.n += 4; }
    function helper(): number { const R: Record<string, { n: number }> = { a: { n: 1 } }; bump(R["a"]!); return R["a"]!.n; }
    function pushed(): number { const R: Record<string, { n: number }> = { a: { n: 1 } }; const list: { n: number }[] = []; list.push(R["a"]!); list[0]!.n = 5; return R["a"]!.n; }
    function held(): number { const R: Record<string, { n: number }> = { a: { n: 1 } }; const h = { o: R["a"]! }; h.o.n = 5; return R["a"]!.n; }
    function values(): number { const R: Record<string, { n: number }> = { a: { n: 1 } }; Object.values(R)[0]!.n = 5; return R["a"]!.n; }
    function looped(): number { const R: Record<string, { n: number }> = { a: { n: 1 } }; for (const v of Object.values(R)) v.n = 5; return R["a"]!.n; }
    function plain(): number { const R = { a: { n: 1 } }; Object.values(R)[0]!.n = 5; return R.a.n; }
    const results = [helper(), pushed(), held(), values(), looped(), plain()];
    if (results.join() !== "5,5,5,5,5,5") throw new Error("members " + results.join());
    `,
);

check(
    "a record nested in a variable or a parameter stays one object where a store holds it",
    `
    function viaParameter(p: { inner: { n: number } }): number {
        const held = [p.inner];
        held[0]!.n = 2;
        return p.inner.n;
    }
    if (viaParameter({ inner: { n: 1 } }) !== 2) throw new Error("parameter");
    function viaSpread(seed: number): number {
        const outer = { inner: { n: seed }, m: 1 };
        const copy = { ...outer };
        const kept = [copy.inner];
        kept[0]!.n = 4;
        return outer.inner.n;
    }
    if (viaSpread(1) !== 4) throw new Error("spread copy " + viaSpread(1));
    `,
);
