import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    check,
    checkInRealm,
    executeGeneratedAssertions,
} from "./language-constructs.js";

check(
    "a-static-initializer-reads-this-as-its-class",
    `
    class R { static readonly F = 10; static readonly H = this.F / 2; value(): number { return R.H; } }
    if (new R().value() !== 5 || R.H !== 5) throw new Error("static this");
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
    "stored-class-instances-keep-an-optional-shared-field-apart",
    `
    class Registry {
        private readonly lookups: number[] = [];
        parent(slot: number): number { this.lookups.push(slot); return slot * 10; }
        get count(): number { return this.lookups.length; }
    }
    class Pose {
        private parentValue = -1;
        private world = 0;
        constructor(private readonly frame?: Registry) {}
        bind(slot: number): boolean {
            if (!this.frame) throw new Error("standalone pose");
            this.parentValue = this.frame.parent(slot);
            return true;
        }
        place(x: number): void { this.world = x; }
        get x(): number { return this.parentValue >= 0 ? this.parentValue : this.world; }
        get native(): boolean { return this.frame !== undefined; }
    }
    const registry = new Registry();
    const poses: Pose[] = [];
    for (let i = 0; i < 3; i++) poses.push(i < 2 ? new Pose(registry) : new Pose());
    poses[0]!.bind(1); poses[1]!.bind(2); poses[2]!.place(7);
    let refused = false;
    try { poses[2]!.bind(3); } catch { refused = true; }
    if (!refused || poses[0]!.x !== 10 || poses[1]!.x !== 20 || poses[2]!.x !== 7) throw new Error("pose values");
    if (!poses[0]!.native || poses[2]!.native || registry.count !== 2) throw new Error("presence");
`,
);

check(
    "class-getters-stored-as-record-accessors",
    `
    interface Envelope { readonly compact: boolean; preferred(a: number): number; }
    class Pairs {
        count = 0;
        get compact(): boolean { return this.count > 0; }
        preferred(a: number): number { return a * 2; }
        envelope(slot?: number): Envelope { return this.count > 0 && (slot === undefined || slot > 0) ? this : normal; }
    }
    const normal: Envelope = { compact: false, preferred: (a) => a };
    const registry = new Map<number, Pairs>();
    function envelopeFor(key: number, slot?: number): Envelope { return registry.get(key)?.envelope(slot) ?? normal; }
    registry.set(1, new Pairs());
    const e0 = envelopeFor(1);
    if (e0.compact || e0.preferred(3) !== 3) throw new Error("normal");
    registry.get(1)!.count = 2;
    const e1 = envelopeFor(1, 1);
    if (!e1.compact || e1.preferred(3) !== 6) throw new Error("pairs");
    registry.get(1)!.count = 0;
    if (e1.compact || envelopeFor(2).compact) throw new Error("live getter");
    interface Knob { value: number; readonly label: string; }
    class Clamp {
        private stored = 1;
        get value(): number { return this.stored; }
        set value(next: number) { this.stored = Math.min(10, Math.max(0, next)); }
        get label(): string { return "clamp:" + this.stored; }
        view(): Knob { return this; }
    }
    const clamp = new Clamp();
    const knobs: Knob[] = [{ value: 3, label: "plain" }, clamp.view()];
    for (const knob of knobs) knob.value = 42;
    if (knobs[0]!.value !== 42 || clamp.value !== 10 || knobs[1]!.label !== "clamp:10") throw new Error("setter");
    knobs[1]!.value = -3;
    if (clamp.value !== 0 || knobs[1]!.value !== 0) throw new Error("live setter");
`,
);

check(
    "class-accessor-field-writes-refresh-live-array-slots",
    `
    interface View { value: number; readonly label: string; }
    class Samples {
        private values: number[] = [1];
        get value(): number { return this.values[0]!; }
        set value(next: number) {
            this.values = [next];
            this.values.push(next + 1);
            this.values = [next + 2];
        }
        get label(): string { return this.values.length + ":" + this.values[0]; }
        view(): View { return this; }
    }
    function createView(): View { return new Samples().view(); }
    const view = createView();
    const alias = view;
    if (view.value !== 1 || view.label !== "1:1") throw new Error("initial fields");
    view.value = 3;
    if (alias.value !== 5 || alias.label !== "1:5") throw new Error("replacement fields");
    alias.value = 9;
    if (view.value !== 11 || view.label !== "1:11") throw new Error("repeated setter");
`,
);

check(
    "a spread of a record holding a class instance copies the instance's own fields, not its prototype accessor",
    `
    interface Flag { readonly on: boolean; }
    class Switch { count = 0; get on(): boolean { return this.count > 0; } view(): Flag { return this; } }
    const flags: Flag[] = [{ on: false }, new Switch().view()];
    const copies = flags.map((flag) => ({ ...flag }));
    const seen = copies.map((copy) => JSON.stringify(copy) + Object.keys(copy).join()).join(";");
    if (seen !== '{"on":false}on;{"count":0}count' || copies[0]!.on !== false) throw new Error(seen);
    `,
);

check(
    "a class instance keeps one object under an interface-typed binding",
    `
    interface Counting { n: number; inc(): number }
    type Shaped = { n: number; inc(): number };
    class Counter implements Counting { n = 0; inc(): number { return ++this.n; } }
    const a: Counting = new Counter();
    a.inc(); a.inc();
    const b: Counting = new Counter();
    b.n = 5;
    const stepped = b.inc();
    let c: Counting = new Counter();
    c.inc();
    const k = new Counter();
    const d: Counting = k;
    d.inc(); k.inc();
    const e: Shaped = new Counter();
    e.inc();
    if (a.n !== 2 || stepped !== 6 || b.n !== 6 || c.n !== 1 || k.n !== 2 || d.n !== 2 || d !== k || e.n !== 1)
        throw new Error([a.n, stepped, b.n, c.n, k.n, d.n, e.n].join());
    `,
);

check(
    "a class instance fills an interface array where its copy is unobservable",
    `
    interface Named { readonly name: string; greet(): string }
    class Person implements Named { constructor(readonly name: string) {} greet(): string { return "hi " + this.name; } }
    interface Point { x: number; size(): number }
    class Spot implements Point { x = 3; size(): number { return this.x; } }
    const people: Named[] = [new Person("a"), new Person("b")];
    const spots: Point[] = [new Spot()];
    if (people.map((p) => p.greet()).join() !== "hi a,hi b" || spots[0]!.size() !== 3 || spots[0]!.x !== 3)
        throw new Error("views");
    `,
);

check(
    "a class instance keeps its optional interface methods and its identity",
    `
    interface Part { update?(): void; ticks: number }
    class Ticker implements Part { ticks = 0; update(): void { this.ticks++; } }
    interface Counting { n: number; inc(): number }
    class Counter implements Counting { n = 0; inc(): number { return ++this.n; } }
    const p: Part = new Ticker();
    if (p.update) p.update();
    p.update?.();
    const a: Counting = new Counter();
    const b: Counting = new Counter();
    a.inc();
    if (p.ticks !== 2 || a === b || a.n !== 1 || b.n !== 0) throw new Error("kept " + p.ticks);
    `,
);

check(
    "a class instance stored as a record type is that instance where a copy would be observable",
    `
    interface Counting { n: number; inc(): number }
    class Counter implements Counting { n = 0; inc(): number { return ++this.n; } }
    const first = new Counter();
    const xs: Counting[] = [first];
    xs[0]!.inc();
    const holder: { c: Counting } = { c: first };
    holder.c.inc();
    function make(): Counter[] { return [new Counter()]; }
    const made: Counting[] = make();
    made[0]!.inc();
    if (first.n !== 2 || xs[0] !== first || holder.c !== first || xs[0]!.n !== 2 || made[0]!.n !== 1)
        throw new Error("one counter " + first.n);
    interface Named { readonly name: string }
    class Person implements Named { constructor(readonly name: string) {} }
    const ada = new Person("ada");
    const people: Named[] = [ada];
    if (people[0] !== ada || people[0]!.name !== "ada") throw new Error("one person");
    interface Busy { count: number; readonly busy: boolean }
    class Tally { count = 0; get busy(): boolean { return this.count > 0; } bump(): void { this.count++; } view(): Busy { return this; } }
    const tally = new Tally();
    const tallies = new Map<number, Tally>([[1, tally]]);
    const view = tally.view();
    if (view.busy) throw new Error("idle");
    tallies.get(1)!.bump();
    if (!view.busy || view.count !== 1 || view !== tallies.get(1)) throw new Error("one tally");
    view.count = 5;
    if (tallies.get(1)!.count !== 5) throw new Error("written through the view");
    interface Handle { slot: number }
    class Store {
        private readonly alive = new Set<number>();
        add(slot: number): Handle { this.alive.add(slot); return { slot }; }
        isAlive(handle: Handle): boolean { return this.alive.has(handle.slot); }
        remove(handle: Handle): void { this.alive.delete(handle.slot); }
    }
    type Liveness = Pick<Store, "isAlive">;
    class Frame {
        private readonly entries = new Map<number, string>();
        constructor(private readonly core: Liveness) {}
        bind(handle: Handle, label: string): void { this.entries.set(handle.slot, label); }
        label(handle: Handle): string { return this.core.isAlive(handle) ? this.entries.get(handle.slot) ?? "" : "dead"; }
        reads(core: Liveness): boolean { return this.core === core; }
    }
    interface Labels { label(handle: Handle): string }
    class Bounds {
        constructor(private readonly frame: Labels | null) {}
        describe(handle: Handle): string { return this.frame ? this.frame.label(handle) : "none"; }
        shows(frame: Labels): boolean { return this.frame === frame; }
    }
    const store = new Store();
    const frame = new Frame(store);
    const bounds = new Bounds(frame);
    const empty = new Bounds(null);
    const slot = store.add(1);
    frame.bind(slot, "one");
    if (!frame.reads(store) || !bounds.shows(frame) || empty.shows(frame)) throw new Error("one store and frame");
    if (bounds.describe(slot) !== "one" || empty.describe(slot) !== "none") throw new Error("bound");
    store.remove(slot);
    if (bounds.describe(slot) !== "dead") throw new Error("removed");
    `,
);

check(
    "a class handing out this is one object under its interface view",
    `
    interface Tool { activate(): void }
    const made: Tool[] = [];
    let active = 0;
    class Move implements Tool { constructor() { made.push(this); } activate(): void { active++; } }
    const tools: Tool[] = [new Move()];
    if (tools[0] !== made[0]) throw new Error("one tool");
    tools[0]!.activate();
    made[0]!.activate();
    if (active !== 2) throw new Error("activated");
    `,
);

check(
    "a record type a class's instances and other objects both are holds each instance's one view",
    `
    interface Tool { activate(): void }
    const made: Tool[] = [];
    let active = "";
    class Move implements Tool { constructor() { made.push(this); } activate(): void { active += "m"; } }
    class Paint implements Tool { activate(): void { active += "p"; } }
    const move = new Move();
    const paint = new Paint();
    const literal: Tool = { activate(): void { active += "l"; } };
    const tools: Tool[] = [move, paint, literal];
    for (const tool of tools) tool.activate();
    if (active !== "mpl" || tools[0] !== made[0] || tools[0] !== move || tools[1] !== paint || tools[2] !== literal)
        throw new Error("one tool each " + active);
    if (tools.indexOf(paint) !== 1 || tools.indexOf(move) !== 0 || made.indexOf(move) !== 0 || (tools[0] as object) === paint)
        throw new Error("searched by identity");
    const seen = new Set<Tool>([move, literal]);
    const order = new Map<Tool, number>([[paint, 2]]);
    if (!seen.has(tools[0]!) || seen.has(paint) || order.get(tools[1]!) !== 2 || order.has(move)) throw new Error("keyed by identity");
    const notes = new WeakMap<object, string>();
    notes.set(move, "move");
    notes.set(tools[1]!, "paint");
    if (notes.get(tools[0]!) !== "move" || notes.get(paint) !== "paint" || notes.has(literal)) throw new Error("weak keys");
    interface Counter { count: number; readonly busy: boolean; bump(): number }
    class Tally {
        count = 0;
        get busy(): boolean { return this.count > 0; }
        bump(): number { return ++this.count; }
        view(): Counter { return this.count < 0 ? idle : this; }
    }
    const idle: Counter = { count: -1, busy: false, bump: () => 0 };
    const tally = new Tally();
    const counter = tally.view();
    counter.count = 4;
    if (tally.count !== 4 || !counter.busy || counter.bump() !== 5 || tally.count !== 5) throw new Error("written through the view");
    tally.count = 7;
    if (counter.count !== 7 || tally.view() !== counter || counter !== tally || idle === tally.view()) throw new Error("one tally " + counter.count);
    `,
);

test("a record type stored as one class's instances refuses a method read as a value", () => {
    assert.throws(
        () =>
            compileSource(
                "interface Counting { n: number; inc(): number } class Counter implements Counting { n = 0; inc(): number { return ++this.n; } } const c: Counting = new Counter(); const f = c.inc.bind(c); export {};",
            ),
        /Method 'inc' is read as a value; method values are unsupported/,
    );
});

check(
    "one interface two unrelated classes' instances hold is each instance",
    `
    interface Shape { readonly size: number; area(): number }
    class Square { constructor(private side: number) {} get size(): number { return this.side; } area(): number { return this.side * this.side; } grow(): void { this.side++; } }
    class Disc { constructor(private radius: number) {} get size(): number { return this.radius; } area(): number { return 3 * this.radius * this.radius; } }
    const square = new Square(2);
    const disc = new Disc(1);
    const shapes: Shape[] = [];
    shapes.push(square);
    shapes.push(disc);
    shapes.push({ size: 1, area: () => 3 });
    let total = 0;
    for (const shape of shapes) total += shape.area() + shape.size;
    if (total !== 14 || shapes[0] !== square || shapes.indexOf(disc) !== 1 || shapes.includes(new Disc(1))) throw new Error("shapes " + total);
    square.grow();
    if (shapes[0]!.size !== 3 || shapes[0]!.area() !== 9) throw new Error("grown");
    `,
);

check(
    "a write through an element read as a class instance's interface view writes the instance",
    `
    interface Counter { count: number; label: string; note?: string }
    class Tally { count = 0; extra = 1; label = "t"; note?: string; }
    const tally = new Tally();
    const counters: Counter[] = [tally, { count: 5, label: "l" }];
    if (counters[0] !== tally) throw new Error("identity");
    counters[0]!.count = 7;
    counters[1]!.count += 1;
    counters[0]!.count++;
    counters[0]!["count"] = counters[0]!.count + 1;
    counters[0]!.label += "x";
    counters[0]!.note ??= "n";
    counters[1]!.note ||= "m";
    let total = 0;
    for (const counter of counters) { counter.count *= 2; total += counter.count; }
    const out = String(tally.count) + "," + counters[1]!.count + "," + tally.extra + tally.label + tally.note + counters[1]!.note + total;
    if (out !== "18,12,1txnm30") throw new Error(out);
    `,
);

check(
    "a class instance's interface view enumerates and serializes as the instance",
    `
    interface Rec { a: number; b: string }
    class Tally { constructor(public a: number, public b: string, private c = 3) {} bump(): number { return this.c; } }
    class Other { z = 0; a = 5; b = "o"; }
    const rs: Rec[] = [{ a: 1, b: "x" }];
    const t = new Tally(2, "y");
    rs.push(t);
    rs.push(new Other());
    let out = "";
    for (const r of rs) {
        out += JSON.stringify(r) + Object.keys(r).join() + "|";
        for (const key in r) out += key;
        out += "|" + Object.entries(r).map(([k, v]) => k + "=" + v).join() + "|" + Object.values(r).join();
        const copy: Record<string, unknown> = { ...r, w: 1 };
        out += "|" + JSON.stringify(copy) + ";";
    }
    rs[1]!.a = 7;
    out += t.a + JSON.stringify(rs[1]) + t.bump();
    const boxed: unknown[] = [JSON.parse("1")];
    boxed.push(rs[1]);
    for (const value of boxed) {
        const record = value as Record<string, unknown>;
        out += "|" + Object.keys(record).join() + JSON.stringify(value);
    }
    const literal: Rec[] = [{ a: 1, b: "x" }, new Tally(2, "y")];
    out += "|" + JSON.stringify(literal);
    const want = '{"a":1,"b":"x"}a,b|ab|a=1,b=x|1,x|{"a":1,"b":"x","w":1};{"a":2,"b":"y","c":3}a,b,c|abc|a=2,b=y,c=3|2,y,3|{"a":2,"b":"y","c":3,"w":1};{"z":0,"a":5,"b":"o"}z,a,b|zab|z=0,a=5,b=o|0,5,o|{"z":0,"a":5,"b":"o","w":1};7{"a":7,"b":"y","c":3}3|1|a,b,c{"a":7,"b":"y","c":3}|[{"a":1,"b":"x"},{"a":2,"b":"y","c":3}]';
    if (out !== want) throw new Error(out);
    `,
);

check(
    "a copy of a class instance's interface view has the instance's own keys",
    `
    interface Rec { a: number; b: string }
    class Tally { constructor(public a: number, public b: string, private c = 3) {} bump(): number { return this.c; } }
    const rs: Rec[] = [{ a: 1, b: "x" }, new Tally(2, "y")];
    let out = "";
    for (const r of rs) {
        const narrow: { a: number } = { ...r };
        const same: Rec = { ...r };
        same.a += 10;
        const assigned = Object.assign({}, r);
        out += JSON.stringify(narrow) + Object.keys(narrow).join() + JSON.stringify(same) + r.a + JSON.stringify(assigned) + ";";
    }
    out += JSON.stringify(rs.map((r) => ({ ...r })));
    interface Opt { a?: number; b: string }
    const os: Opt[] = [{ a: 1, b: "x" }, { b: "y" }];
    for (const o of os) { const copied = Object.assign({}, o); out += "|" + JSON.stringify(copied) + Object.keys(copied).join(); }
    const want = '{"a":1,"b":"x"}a,b{"a":11,"b":"x"}1{"a":1,"b":"x"};{"a":2,"b":"y","c":3}a,b,c{"a":12,"b":"y","c":3}2{"a":2,"b":"y","c":3};[{"a":1,"b":"x"},{"a":2,"b":"y","c":3}]|{"a":1,"b":"x"}a,b|{"b":"y"}b';
    if (out !== want) throw new Error(out);
    `,
);

// A class handing out `this` as an interface a literal also produces, in a
// program whose identity uses hold no such record.
const unrelatedIdentityPrelude = `
    interface Gauge { readonly tight: boolean; span(a: number, b: number): number }
    class Tally {
        count = 0;
        get tight(): boolean { return this.count > 0; }
        span(a: number, b: number): number { return a * b + this.count; }
        gauge(): Gauge { return this.count > 0 ? this : loose; }
    }
    const loose: Gauge = { tight: false, span: (a, b) => a + b };
    const tally = new Tally();
    const before = tally.gauge();
    tally.count = 1;
    const after = tally.gauge();
    if (before.tight || before.span(2, 3) !== 5 || !after.tight || after.span(2, 3) !== 7) throw new Error("gauges");
`;

check(
    "an interface a class's this and a literal produce compiles beside an unrelated object identity",
    `${unrelatedIdentityPrelude}
    const tokens: object[] = [{}, {}];
    if (tokens[0] === tokens[1]) throw new Error("tokens");
    `,
);

check(
    "an interface a class's this and a literal produce compiles beside an unrelated asserted document",
    `${unrelatedIdentityPrelude}
    const parsed = JSON.parse('{"x":1}') as { x: number };
    const others = [parsed, parsed];
    if (others[0] !== others[1] || parsed.x !== 1) throw new Error("parsed");
    `,
);

// A weak map keyed through an `object` parameter keys what the calls of
// its function pass; only a key that can hold the record type keeps a
// class handing out `this` from being copied as it.
const objectKeyedNotes = `
    interface Gauge { readonly tight: boolean; span(a: number, b: number): number }
    class Tally {
        count = 0;
        get tight(): boolean { return this.count > 0; }
        span(a: number, b: number): number { return a * b + this.count; }
        gauge(): Gauge { return this.count > 0 ? this : loose; }
    }
    const loose: Gauge = { tight: false, span: (a, b) => a + b };
    interface World { readonly tallies: Tally[] }
    const notes = new WeakMap<object, string[]>();
    function note(owner: object, text: string): number {
        let list = notes.get(owner);
        if (!list) { list = []; notes.set(owner, list); }
        list.push(text);
        return list.length;
    }
    function annotate(world: World): number { return note(world, "seen"); }
    const world: World = { tallies: [new Tally(), new Tally()] };
`;

check(
    "a class handing out this stays one object where a broad key only takes other types",
    `${objectKeyedNotes}
    world.tallies[1]!.count = 2;
    const gauges = world.tallies.map((tally) => tally.gauge());
    world.tallies[1]!.count = 3;
    if (gauges[0]!.tight || gauges[0]!.span(2, 3) !== 5 || !gauges[1]!.tight || gauges[1]!.span(2, 3) !== 9)
        throw new Error("gauges");
    `,
);

check(
    "a broad key that can hold a class's interface view keys the instance",
    `${objectKeyedNotes}
    world.tallies[1]!.count = 2;
    const gauges: Gauge[] = world.tallies.map((tally) => tally.gauge());
    function mark(): number { return note(world.tallies[1]!.gauge(), "kept"); }
    notes.set(world, []);
    const handed: unknown = notes;
    if (mark() !== 1 || note(gauges[1]!, "again") !== 2 || note(world.tallies[1]!, "instance") !== 3 || gauges[0] !== loose)
        throw new Error("keyed by the instance");
    if (annotate(world) !== 1 || !gauges[1]!.tight || gauges[1] !== world.tallies[1]) throw new Error("world");
    if (notes.has(loose) || handed !== notes) throw new Error("loose");
    `,
);

check(
    "fresh class instances are the only handle of their interface views",
    `
    const log: string[] = [];
    interface Tool { activate(): void; deactivate(): void }
    class Move implements Tool { private on = false; activate(): void { this.on = true; log.push("m+"); } deactivate(): void { this.on = false; log.push("m-"); } }
    class Paint implements Tool { private strokes = 0; activate(): void { this.strokes++; log.push("p+" + this.strokes); } deactivate(): void { log.push("p-"); } }
    class Manager {
        private active: Tool | null = null;
        constructor(private readonly tools: Record<string, Tool>) {}
        select(id: string): void {
            const next = this.tools[id] ?? null;
            if (next === this.active) return;
            this.active?.deactivate();
            this.active = next;
            this.active?.activate();
        }
    }
    const manager = new Manager({ move: new Move(), paint: new Paint() });
    manager.select("move"); manager.select("paint"); manager.select("paint"); manager.select("move"); manager.select("paint");
    if (log.join() !== "m+,m-,p+1,p-,m+,m-,p+2") throw new Error(log.join());
    `,
);

check(
    "a class instance whose fields nothing writes is viewed through its getters",
    `
    interface Counter { count: number; readonly busy: boolean; }
    class Tally {
        count = 0;
        get busy(): boolean { return this.count > 0; }
        view(): Counter { return this; }
    }
    const tallies = new Map<number, Tally>([[1, new Tally()]]);
    const view = tallies.get(1)!.view();
    if (view.busy) throw new Error("busy");
    `,
);

test("Object.is reads a static NaN or infinite operand beside a call", async (t) => {
    const source = `
        const missing = NaN;
        let calls = 0;
        function read(): number { calls++; return Number("x" + calls); }
        if (!Object.is(read(), missing)) throw new Error("NaN is NaN");
        if (Object.is(missing, 0) || !Object.is(-Infinity, -1 / 0)) throw new Error("static operands");
        if (calls !== 1) throw new Error("operand order");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.match(result.cpp, /quiet_NaN/);
    await executeGeneratedAssertions(t, "object-is-nan", result.cpp);
});

check(
    "phantom-brand-capabilities-store-their-issuing-class",
    `
    declare const slitIdBrand: unique symbol;
    type SlitId = Readonly<{ readonly [slitIdBrand]: true }>;
    const capability = (() => {
        const constructorToken = {};
        let issue!: (value: number) => SlitId;
        let value!: (id: SlitId) => number;
        class Capability {
            readonly #value: number;
            constructor(token: object, durableValue: number) {
                if (token !== constructorToken) throw new TypeError("private constructor token");
                this.#value = durableValue;
                Object.freeze(this);
            }
            static {
                issue = (durableValue) => new Capability(constructorToken, durableValue) as unknown as SlitId;
                value = (id) => (id as unknown as Capability).#value;
            }
        }
        void Capability;
        return { issue, value } as const;
    })();
    function keyOf(id: unknown): number | null {
        if ((typeof id !== "object" && typeof id !== "function") || id === null) return null;
        try { return capability.value(id as SlitId); } catch { return null; }
    }
    function same(a: unknown, b: unknown): boolean { return a === b && keyOf(a) !== null; }
    function serialize(id: SlitId): number {
        const key = keyOf(id);
        if (key === null) throw new TypeError("invalid live slit identity");
        return key;
    }
    const first = capability.issue(7);
    const second = capability.issue(8);
    if (keyOf(first) !== 7 || keyOf(second) !== 8) throw new Error("issued keys");
    if (keyOf({}) !== null || keyOf(7) !== null || keyOf(null) !== null) throw new Error("forged keys");
    if (!same(first, first) || same(first, second) || same({}, {})) throw new Error("identity");
    const rows: { readonly id: SlitId; height: number }[] = [{ id: first, height: 1 }, { id: second, height: 2 }];
    rows.push({ id: capability.issue(9), height: 3 });
    const byId = new Map<SlitId, number>(rows.map((row) => [row.id, row.height]));
    if (byId.get(second) !== 2 || byId.get(capability.issue(8)) !== undefined) throw new Error("identity keys");
    const found = rows.findIndex((row) => same(row.id, second));
    if (found !== 1 || serialize(rows[2]!.id) !== 9) throw new Error("collection identity");
    let forged = "";
    try { serialize({} as SlitId); } catch (error) { forged = error instanceof TypeError ? "TypeError" : "other"; }
    if (forged !== "TypeError") throw new Error("forged serialize");
    let direct = "";
    try { capability.value({} as SlitId); } catch (error) { direct = error instanceof TypeError ? "TypeError" : "other"; }
    if (direct !== "TypeError") throw new Error("forged private read");
`,
);

check(
    "private-names-read-only-the-instances-documents-hold",
    `
    class Key {
        readonly #value: number;
        readonly label: string;
        constructor(value: number) { this.#value = value; this.label = "k" + value; }
        static read(candidate: unknown): number { return (candidate as Key).#value; }
    }
    const held: unknown[] = [];
    for (let index = 1; index <= 3; index++) held.push(index === 2 ? { "#value": 5 } : new Key(index * 10));
    let reads = "";
    for (const candidate of held) {
        try { reads += Key.read(candidate) + ","; } catch (error) { reads += error instanceof TypeError ? "T," : "E,"; }
    }
    if (reads !== "10,T,30,") throw new Error("reads " + reads);
    if (Object.keys(held[0] as object).join(",") !== "label") throw new Error("keys " + Object.keys(held[0] as object).join(","));
    if (JSON.stringify(held[2]) !== '{"label":"k30"}') throw new Error("json " + JSON.stringify(held[2]));
    let forged = "";
    try { Key.read({}); } catch (error) { forged = error instanceof TypeError ? "T" : "E"; }
    if (forged !== "T") throw new Error("forged read");
    class Tally {
        #total = 1;
        static read(candidate: unknown): number { return (candidate as Tally).#total; }
    }
    let counted = 0;
    try { counted = Tally.read({}); } catch (error) { counted = error instanceof TypeError ? -1 : -2; }
    if (counted !== -1 || Tally.read(new Tally()) !== 1) throw new Error("initialized private read");
`,
);

test("a phantom brand asserted from two classes keeps its refusal", () => {
    assert.throws(
        () =>
            compileSource(`
    declare const brand: unique symbol;
    type Token = Readonly<{ readonly [brand]: true }>;
    class A { readonly #a = 1; static read(t: Token): number { return (t as unknown as A).#a; } }
    class B { readonly #b = 2; }
    const tokens: Token[] = [new A() as unknown as Token, new B() as unknown as Token];
    if (A.read(tokens[0]!) !== 1) throw new Error("two classes");
`),
        /Compile-time record is missing required field/,
    );
});

check(
    "a class method called through a document runs on the instance the document holds",
    `
    class Counter { total = 0; add(v: number): number { this.total += v; return this.total; } }
    interface Holder { counter?: Counter; label: string }
    const counter = new Counter();
    const doc = JSON.parse('{"label":"x"}') as Holder;
    const holder: Holder = { ...doc, counter };
    const first = holder.counter?.add(2);
    const second = holder.counter!.add(3);
    if (first !== 2 || second !== 5 || counter.total !== 5) throw new Error("method " + first + " " + second + " " + counter.total);
    const forged = JSON.parse('{"counter":{"total":1},"label":"y"}') as Holder;
    let threw = "none";
    try { forged.counter!.add(1); } catch (error) { threw = error instanceof TypeError ? "TypeError" : "other"; }
    if (threw !== "TypeError") throw new Error("forged " + threw);
    const missing = JSON.parse('{"label":"z"}') as Holder;
    if (missing.counter?.add(1) !== undefined) throw new Error("absent");
`,
);

check(
    "a document spread beside a class instance keeps each last writer and the instance its callee calls",
    `
    interface Base { a: number; b: string }
    class Sink { total = 0; add(v: number): void { this.total += v; } }
    interface Opts { a?: number; b?: string; c?: number; d?: [number, number]; sink?: Sink; e?: number }
    function run(o: Opts = {}): string {
        o.sink?.add(o.a ?? -1);
        return String(o.a ?? "none") + "|" + (o.b ?? "none") + "|" + String(o.c ?? 7) + "|" + String(o.d?.[1] ?? 0) + "|" + String(o.e ?? 5);
    }
    const plain: Opts = { a: 1 };
    if (Object.keys(plain).join() !== "a") throw new Error("plain keys");
    const doc = JSON.parse('{"a":1,"b":"x","c":3,"z":9}') as Base & { c: number };
    const base: Base = doc;
    const sink = new Sink();
    const copied = run({ ...base, d: [1, 2], sink, e: (doc.c = 50) });
    if (copied !== "1|x|3|2|50" || sink.total !== 1) throw new Error("copied where spread " + copied + " " + sink.total);
    const missing = JSON.parse('{"b":"y"}') as Base;
    const kept = run({ a: 4, c: 8, ...missing, sink });
    if (kept !== "4|y|8|0|5" || sink.total !== 5) throw new Error("earlier writer kept " + kept + " " + sink.total);
    const replaced = run({ ...base, a: 10, sink });
    if (replaced !== "10|x|50|0|5" || sink.total !== 15) throw new Error("later writer " + replaced + " " + sink.total);
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

test("a class method read as a value refuses, bound or not", () => {
    for (const read of ["c.inc", "c.inc.bind(c)", "[1].map(c.inc)"])
        assert.throws(
            () =>
                compileSource(
                    `class Counter { n = 0; inc(): number { return ++this.n; } } const c = new Counter(); const v = ${read}; export {};`,
                ),
            /Method 'inc' is read as a value; method values are unsupported/,
            read,
        );
});

checkInRealm(
    "structured-clone-of-an-interface-view-copies-the-instance",
    `
    interface Rec { a: number; b: string }
    class Tally { constructor(public a: number, public b: string, private c = 3) {} bump(): number { return this.c; } }
    const rs: Rec[] = [{ a: 1, b: "x" }, new Tally(2, "y")];
    let out = "";
    for (const r of rs) { const clone = structuredClone(r); out += JSON.stringify(clone) + Object.keys(clone).join() + ";"; }
    out += JSON.stringify(structuredClone(rs));
    if (out !== '{"a":1,"b":"x"}a,b;{"a":2,"b":"y","c":3}a,b,c;[{"a":1,"b":"x"},{"a":2,"b":"y","c":3}]') throw new Error(out);
    globalThis.close();
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
    "records-of-several-shapes-held-as-one-interface",
    `
    // Records of different types held as one interface, called and found by identity.
    interface Bounds { minX: number; maxX: number }
    interface Follower { followGround(dirty?: Bounds | null): boolean }
    interface Ferns { items: number[]; wind: string; followGround(dirty?: Bounds | null): boolean; scale: number }
    interface Bushes { items: string[]; winter: number; followGround(dirty?: Bounds | null): boolean }
    function registry() {
        const followers: Follower[] = [];
        return {
            add(follower: Follower): () => void {
                followers.push(follower);
                return () => { const i = followers.indexOf(follower); if (i >= 0) followers.splice(i, 1); };
            },
            follow(bounds: Bounds | null): boolean {
                let changed = false;
                for (const follower of followers) changed = follower.followGround(bounds) || changed;
                return changed;
            },
        };
    }
    function makeFerns(): Ferns {
        let moved = 0;
        return { items: [1, 2], wind: "w", scale: 2, followGround: (dirty) => { moved += 1; return !!dirty && moved > 0; } };
    }
    function makeBushes(): Bushes {
        const items = ["a"];
        return { items, winter: 0, followGround: (dirty) => items.length > 0 && !dirty };
    }
    const followers = registry();
    const ferns = makeFerns();
    const removeFerns = followers.add(ferns);
    followers.add(makeBushes());
    followers.add({ followGround: (dirty) => dirty === null });
    const a = followers.follow(null);
    removeFerns();
    const b = followers.follow({ minX: 0, maxX: 1 });
    if (a !== true || b !== false || ferns.items.length !== 2) throw new Error(\`\${a} \${b}\`);
`,
);

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
    // Both branches fold through the early returns, so the composed text is
    // static and the comparison against it leaves no check behind.
    assert.ok(
        result.cpp.includes('bbl::js::concat("enabled", ":", "disabled")'),
    );
    assert.ok(!result.cpp.includes("composition branch"));
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
    "class-field-of-unknown-values-read-through-instanceof",
    `
    class AnyOf { constructor(readonly options: readonly unknown[]) {} }
    function unifyAll(values: readonly unknown[]): number {
      const flat: unknown[] = [];
      for (const v of values) {
        if (v instanceof AnyOf) flat.push(...v.options);
        else if (v !== undefined) flat.push(v);
      }
      return flat.length;
    }
    const schema: unknown[] = [1, new AnyOf(["a", 2]), undefined, "x"];
    const nested = new AnyOf([schema[1], 3]);
    const inner = nested.options[0];
    if (!(inner instanceof AnyOf) || inner.options.length !== 2 || unifyAll([nested]) !== 2 || unifyAll(schema) !== 4) throw new Error("anyof");
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
    "a-spread-of-a-class-instance-copies-the-fields-its-own-class-declares",
    `
    class Base { a = 1; }
    class Left extends Base { b = 2; }
    const items: Base[] = [];
    items.push(new Base());
    items.push(new Left());
    let out = "";
    for (const item of items) {
        const copy: Record<string, unknown> = { ...item, z: 9 };
        out += JSON.stringify(copy) + Object.keys(copy).join() + ";";
    }
    if (out !== '{"a":1,"z":9}a,z;{"a":1,"b":2,"z":9}a,b,z;') throw new Error("spread " + out);
`,
);

check(
    "a spread of a base-typed class instance into its own literal keeps the subclass's keys in its class order",
    `
    class A { a = 1; }
    class B extends A { b = 2; c = 5; }
    class C extends A { c = 3; b = 4; }
    const items: A[] = [new A(), new B(), new C()];
    let out = "";
    for (const item of items) {
        const copy = { ...item };
        const more = { ...item, z: 3 };
        out += JSON.stringify(copy) + Object.keys(copy).join() + "|" + JSON.stringify(more) + copy.a + ";";
    }
    const want = '{"a":1}a|{"a":1,"z":3}1;{"a":1,"b":2,"c":5}a,b,c|{"a":1,"b":2,"c":5,"z":3}1;{"a":1,"c":3,"b":4}a,c,b|{"a":1,"c":3,"b":4,"z":3}1;';
    if (out !== want) throw new Error(out);
`,
);

check(
    "class-hierarchy-instances-list-their-keys-in-their-own-class-order",
    `
    class A { a = 1; }
    class B extends A { b = 2; }
    class C extends A { c = 3; b = 4; }
    const agreed: A[] = [new B(), new C()];
    if (JSON.stringify(agreed) !== '[{"a":1,"b":2},{"a":1,"c":3,"b":4}]') throw new Error("agreed order " + JSON.stringify(agreed));
    class P { p = 0; }
    class Q extends P { x = 1; y = 2; }
    class R extends P { y = 3; x = 4; }
    const items: P[] = [new Q(), new R(), new P()];
    let out = JSON.stringify(items) + ";";
    for (const item of items) {
        out += Object.keys(item).join() + "|";
        for (const key in item) out += key;
        out += "|" + Object.entries(item).map(([k, v]) => k + v).join() + "|" + Object.values(item).join();
        const copy: Record<string, unknown> = { ...item, z: 9 };
        out += "|" + JSON.stringify(copy) + ";";
    }
    if (out !== '[{"p":0,"x":1,"y":2},{"p":0,"y":3,"x":4},{"p":0}];p,x,y|pxy|p0,x1,y2|0,1,2|{"p":0,"x":1,"y":2,"z":9};p,y,x|pyx|p0,y3,x4|0,3,4|{"p":0,"y":3,"x":4,"z":9};p|p|p0|0|{"p":0,"z":9};') throw new Error("class orders " + out);
    const boxed: unknown[] = [JSON.parse("7")];
    boxed.push(new Q());
    boxed.push(new R());
    let viewed = "";
    for (const value of boxed) {
        const record = value as Record<string, unknown>;
        viewed += Object.keys(record).join() + "|";
        for (const key in record) viewed += key;
        viewed += "|" + JSON.stringify(value) + ";";
    }
    if (viewed !== '||7;p,x,y|pxy|{"p":0,"x":1,"y":2};p,y,x|pyx|{"p":0,"y":3,"x":4};') throw new Error("views " + viewed);
`,
);

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
    "built-in-global-static-calls-are-not-data-methods",
    `
    interface Deps { readonly meshesOf: Readonly<Record<string, () => readonly number[]>> }
    interface Debug { systems(): readonly string[]; count(system: string): number }
    function create(deps: Deps): Debug {
        const count = (system: string): number => {
            const meshes = deps.meshesOf[system]?.();
            if (!meshes) return -1;
            return meshes.length;
        };
        return { systems: () => Object.keys(deps.meshesOf), count: (system) => count(system) };
    }
    const debug = create({ meshesOf: { trees: () => [1, 2], grass: () => [3] } });
    if (debug.systems().join() !== "trees,grass") throw new Error("keys");
    if (debug.count("trees") !== 2 || debug.count("rocks") !== -1) throw new Error("count");
`,
);

check(
    "in sees a class instance's inherited methods and accessors",
    `
    class B { b(): number { return 1; } get g(): number { return 2; } }
    class C extends B { v = 1; c(): number { return 3; } }
    const c = new C();
    if (!("b" in c) || !("g" in c) || !("c" in c) || !("v" in c) || ("z" in c) || !("toString" in c))
        throw new Error("in chain");
    `,
);

check(
    "a static readonly field with effects or a fresh object is evaluated once",
    `
    let next = 0;
    class Q { static readonly id = next++; static readonly free: number[] = []; static readonly HALF = Math.PI / 2; }
    const a = Q.id, b = Q.id;
    Q.free.push(1);
    Q.free.push(2);
    if (a !== 0 || b !== 0 || next !== 1 || Q.free.length !== 2 || Q.HALF !== Math.PI / 2)
        throw new Error("static once " + a + b + next + Q.free.length);
    `,
);

checkInRealm(
    "a class a later store shares is one object from its first construction",
    `
    class Physics {
        x = 1;
        step(): void { this.x++; }
    }
    interface Items { physics: Physics; count: number; }
    async function spawn(items: Items): Promise<number> {
        await Promise.resolve();
        items.physics.step();
        return items.count;
    }
    class Monsters {
        constructor(private readonly physics: Physics) {}
        async load(): Promise<void> {
            await Promise.resolve();
            this.physics.step();
        }
    }
    void (async () => {
        const physics = new Physics();
        physics.step();
        const count = await spawn({ physics, count: 2 });
        await new Monsters(physics).load();
        if (physics.x !== 4 || count !== 2) throw new Error("shared instance " + physics.x);
        globalThis.close();
    })();
    `,
);

check(
    "Object.assign into a Record copies a source's optional and class-ordered keys as the run holds them",
    `
    class A { a = 1; }
    class B extends A { b = 2; c = 5; }
    class C extends A { c = 3; b = 4; }
    const items: A[] = [new A(), new B(), new C()];
    let out = "";
    for (const item of items) {
        const target: Record<string, number> = { z: 0 };
        Object.assign(target, item);
        out += JSON.stringify(target) + ";";
    }
    interface Opt { a: number; b?: number; }
    const opts: Opt[] = [{ a: 1 }, { a: 2, b: 3 }];
    for (const opt of opts) {
        const target: Record<string, number> = {};
        Object.assign(target, opt);
        out += Object.keys(target).join() + "=" + Object.values(target).join() + ";";
    }
    const want = '{"z":0,"a":1};{"z":0,"a":1,"b":2,"c":5};{"z":0,"a":1,"c":3,"b":4};a=1;a,b=2,3;';
    if (out !== want) throw new Error(out);
    `,
);

check(
    "a setter runs for a write by a static key",
    `
    let writes = 0;
    class A { private v = 0; set x(n: number) { writes++; this.v = n; } get x(): number { return this.v; } }
    const a = new A();
    a["x"] = 3;
    a.x = 4;
    let seen = 0;
    const o = { set x(n: number) { seen = n; } };
    o["x"] = 7;
    if (writes !== 2 || a.x !== 4 || seen !== 7) throw new Error("setters " + writes + " " + a.x + " " + seen);
    `,
);

check(
    "a class's own then is an ordinary method",
    `
    class Task { then(f: (n: number) => void): void { f(42); } catch(n: number): number { return n + 1; } }
    let seen = 0;
    new Task().then((n) => { seen = n; });
    const caught = new Task().catch(1);
    if (seen !== 42 || caught !== 2) throw new Error("own then " + seen + " " + caught);
    `,
);

check(
    "a class method is called by a quoted, numeric or const key",
    `
    class K { private n = 2; "my-key"(): number { return 4; } 1(): number { return 5; } twice(): number { return this.n * 2; } }
    const k = new K();
    const m = "twice";
    if (k["my-key"]() !== 4 || k[1]() !== 5 || k[m]() !== 4) throw new Error("keyed method");
    `,
);

check(
    "a library method called by a static key is the dotted call",
    `
    const xs = [3, 1, 2];
    const push = "push";
    xs["sort"]((a, b) => a - b);
    xs[push](4);
    const fns: Array<(x: number) => number> = [(x) => x + 1];
    if (xs.join() !== "1,2,3,4" || xs.length !== 4 || xs["indexOf"](3) !== 2 || fns[0](1) !== 2)
        throw new Error("array " + xs.join());
    const m = new Map<string, number>();
    m["set"]("a", 1);
    const s = "a,b";
    if (m["get"]("a") !== 1 || m.size !== 1 || s["split"](",").length !== 2 || s["toUpperCase"]() !== "A,B")
        throw new Error("map and string");
    const n = 3.14159;
    if (Math["max"](1, 2) !== 2 || JSON["stringify"]({ a: 1 }) !== '{"a":1}' || n["toFixed"](2) !== "3.14" ||
        !Array["isArray"](xs) || Number["parseFloat"]("1.5") !== 1.5 || globalThis["parseInt"]("12", 10) !== 12)
        throw new Error("statics");
    class C { static f(x: number): number { return x * 3; } }
    function g(this: { n: number }, x: number): number { return this.n + x; }
    const o: number[] | undefined = Math.random() < 2 ? [5] : undefined;
    if (C["f"](2) !== 6 || g["call"]({ n: 1 }, 2) !== 3 || o?.["indexOf"](5) !== 0) throw new Error("static, call, optional");
    `,
);
