import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

check(
    "outlined-member-body-reads-its-receiver",
    `
    class A { v(): number { return 1; } twice(): number { return this.v() * 2; } isB(): boolean { return this instanceof B; } }
    class B extends A { override v(): number { return 5; } }
    const xs: A[] = [new A(), new B()];
    if (xs.map((x) => x.twice()).join() !== "2,10") throw new Error("virtual call on this");
    if (xs.map((x) => x.isB()).join() !== "false,true") throw new Error("instanceof this");
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
    "open-record-views-setters-and-document-deletes",
    `
    type Job = "none" | "hunter" | "baker" | "witch";
    const JOBS: readonly Exclude<Job, "none">[] = ["hunter", "baker", "witch"];
    interface Capacity { readonly posts: number; readonly activeByJob: Readonly<Record<Exclude<Job, "none">, number>>; }
    function capacityOf(workers: readonly { id: number; job: Job }[], posts: number): Capacity {
        const activeByJob = {} as Record<Exclude<Job, "none">, number>;
        for (const job of JOBS) activeByJob[job] = 0;
        for (const worker of workers) if (worker.job !== "none" && activeByJob[worker.job] < posts) activeByJob[worker.job]++;
        return { posts, activeByJob };
    }
    const capacity = capacityOf([{ id: 1, job: "hunter" }, { id: 2, job: "hunter" }, { id: 3, job: "baker" }, { id: 4, job: "none" }], 1);
    if (JSON.stringify(capacity.activeByJob) !== '{"hunter":1,"baker":1,"witch":0}') throw new Error("view of an open record");
    interface Appearance { seed?: number; patternSeed?: number; }
    interface HouseSave extends Appearance { cx: number; cz: number; }
    const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
    const adopt = (record: Appearance, legacy: number): void => { if (!finite(record.seed)) record.seed = legacy; };
    const fields: [string, number][] = [["cx", 1], ["cz", 2]];
    const house = Object.fromEntries(fields) as unknown as HouseSave;
    const adopters: Array<(record: Appearance, legacy: number) => void> = [adopt];
    adopters[0]!(house, 9);
    adopters[0]!(house, 4);
    if (house.seed !== 9 || house.cx !== 1 || JSON.stringify(house) !== '{"cx":1,"cz":2,"seed":9}') throw new Error("setter through a view");
    const parsed = JSON.parse('{"a":1,"b":2,"c":3}') as Record<string, number>;
    delete parsed.a;
    const key = "b";
    delete parsed[key];
    if (JSON.stringify(parsed) !== '{"c":3}') throw new Error("document delete");
    interface Field { count: number; refresh(): number; }
    interface Live extends Field { publish(): number; }
    const createField = (): Field => { let n = 0; return { count: 1, refresh: () => ++n }; };
    function createLive(): Live {
        const field = createField();
        return { ...field, publish() { return field.refresh() * 10; } };
    }
    const live = createLive();
    if (live.publish() !== 10 || live.publish() !== 20 || live.count !== 1) throw new Error("spread method");
    const SLOT_REEL = 19, SLOT_PICK = 7;
    interface Profile { readonly file: string; readonly contacts?: Readonly<Partial<Record<number, number>>>; }
    const profiles: Profile[] = [{ file: "base.glb", contacts: { [SLOT_REEL]: 0.876, [SLOT_PICK]: 0.459 } }, { file: "other.glb" }];
    if (profiles.map((profile) => profile.contacts?.[SLOT_REEL] ?? -1).join(",") !== "0.876,-1") throw new Error("numeric keys");
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

checkInRealm(
    "structured-clone-of-a-view-copies-own-fields-not-prototype-getters",
    `
    interface Flag { readonly on: boolean; }
    class Switch { count = 0; get on(): boolean { return this.count > 0; } view(): Flag { return this; } }
    const flags: Flag[] = [{ on: false }, new Switch().view()];
    const out = flags.map((flag) => JSON.stringify(structuredClone(flag))).join("|");
    if (out !== '{"on":false}|{"count":0}') throw new Error(out);
    globalThis.close();
`,
);

check(
    "stored-generic-method-of-a-generic-receiver",
    `
    interface Plan { id: string; scale: number }
    interface Seat { x: number; z: number }
    interface Ground extends Seat { onDeck: boolean }
    interface Deps<Choice> {
        constrain<T extends Seat>(kind: string, choice: Choice, point: T): T | null;
    }
    const all: Deps<Plan>[] = [
        { constrain: (kind, choice, point) => (kind === "rock" && choice.scale > 2 ? null : point) },
        { constrain: (_kind, choice, point) => (choice.id === "b" ? null : point) },
    ];
    let placed = 0;
    for (const deps of all) {
        const ground: Ground = { x: 1, z: 2, onDeck: false };
        const bounded = deps.constrain("tree", { id: "a", scale: 3 }, ground);
        if (bounded) placed += bounded.x + (bounded.onDeck ? 10 : 0);
        const seat = deps.constrain("rock", { id: "b", scale: 3 }, { x: 5, z: 7 });
        if (seat) placed += seat.z;
    }
    if (placed !== 2) throw new Error("placed " + placed);
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

test("a compile-time handle list holds only pushes that run where it was bound", () => {
    const program = (calls: string): string => `
        import { createBox, createEngine, createSceneContext, createShaderMaterial, createShaderNoColorMaterialView, onSceneDispose } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const views: any[] = [];
        const material = createShaderMaterial({
            vertexSource: "struct VertexOutput{@builtin(position) position:vec4<f32>,};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}",
            fragmentSource: "@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(1.0);}",
            attributes: ["position"], uniforms: ["worldViewProjection"],
        });
        const box = createBox(engine);
        const register = (): void => { views.push(createShaderNoColorMaterialView(material)); };
        ${calls}
        onSceneDispose(scene, () => { for (const view of views) box.material = view; });
    `;
    // Each call's view is made at its call, where the dispose callback's
    // capture of it can name it.
    const { cpp } = compileSource(program("register(); register();"));
    const entry = cpp.slice(cpp.indexOf("int main()"));
    assert.equal(
        entry.match(
            /auto v_bblite_pushed_element_\d+ = bbl::create_shader_no_color_material_view/g,
        )?.length,
        2,
    );
    assert.doesNotMatch(
        cpp.slice(0, cpp.indexOf("int main()")),
        /auto v_bblite_pushed_element_/,
    );
    // A timer pushes at run time, which no generation-known list holds.
    assert.throws(
        () => compileSource(program("setTimeout(() => register(), 10);")),
        /A runtime-grown handle list requires native array storage/,
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
    "methods-reading-this-preserve-the-receiver-through-a-runtime-key",
    `
    type Shape = "circle" | "square";
    interface Costs { scale: number; circle(label: string): number; square(label: string): number; }
    function pricing(costs: Costs) {
        return { price(shape: Shape, label: string): number { return costs[shape](label); } };
    }
    const costs: Costs = {
        scale: 10,
        circle(label) { return this.scale * label.length; },
        square(label) { return this.scale * 2 * label.length; },
    };
    const made = pricing(costs);
    if (made.price("circle", "ring") !== 40 || made.price("square", "ring") !== 80)
        throw new Error("selected method receiver");
    costs.scale = 3;
    if (made.price("circle", "ring") !== 12 || made.price("square", "ring") !== 24)
        throw new Error("live method receiver");
`,
);

check(
    "methods-reading-this-beside-copies-of-enumerated-values",
    `
    // An untyped value a loop takes out of a typed object is one of that
    // object's property values: spreading it reads no method of a record
    // those properties cannot hold.
    interface Row { id: number; name: string; glass: { r: number; g: number } }
    function copyRow<T extends object>(row: T): T {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
            out[key] = value !== null && typeof value === "object" ? { ...value } : value;
        }
        return out as T;
    }
    interface Ledger { get(): number; grant(amount: number): void; grantMorning(shares: number): number }
    function createLedger(start: number): Ledger {
        let balance = start;
        return {
            get: () => balance,
            grant(amount) { if (amount > 0) balance += amount; },
            grantMorning(shares) { const amount = shares * 2; this.grant(amount); return amount; },
        };
    }
    let ledger: Ledger = createLedger(1);
    function configure(start: number): void { ledger = createLedger(start); }
    const row: Row = { id: 1, name: "a", glass: { r: 1, g: 2 } };
    const copy = copyRow(row);
    copy.glass.r = 7;
    const first = ledger.grantMorning(3) + ":" + ledger.get();
    configure(10);
    const seen = [first, String(ledger.grantMorning(1)), String(ledger.get()), String(row.glass.r), String(copy.glass.r), String(copy.id), copy.name].join("|");
    if (seen !== "6:7|2|12|1|7|1|a") throw new Error(seen);
`,
);

test("a method reading this refuses beside a copy of an enumerated value that can hold it", () => {
    // The enumerated object holds the ledger: its copy's method would run
    // with the copy as receiver.
    assert.throws(
        () =>
            compileSource(`
    function copyRow<T extends object>(row: T): T {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
            out[key] = value !== null && typeof value === "object" ? { ...value } : value;
        }
        return out as T;
    }
    interface Ledger { get(): number; grant(amount: number): void; grantMorning(shares: number): number }
    function createLedger(start: number): Ledger {
        let balance = start;
        return {
            get: () => balance,
            grant(amount) { if (amount > 0) balance += amount; },
            grantMorning(shares) { const amount = shares * 2; this.grant(amount); return amount; },
        };
    }
    let ledger: Ledger = createLedger(1);
    function configure(start: number): void { ledger = createLedger(start); }
    interface Bag { id: number; ledger: Ledger }
    const bag: Bag = { id: 1, ledger };
    const copy = copyRow(bag);
    configure(10);
    console.log(copy.id, ledger.grantMorning(1));
`),
        /Method 'grantMorning' reads `this`, and .*:\d+ reads its function value, which could call it with another receiver/,
    );
});

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
    "functions-run-on-a-receiver-they-are-handed",
    `
    const box = { n: 1 };
    function bump(this: { n: number }, by: number): void { this.n += by; }
    bump.call(box, 2);
    bump.apply(box, [3]);
    Reflect.apply(bump, box, [4]);
    const bound = bump.bind(box);
    bound(5);
    if (box.n !== 15) throw new Error("receiver " + box.n);
`,
);

// A bound function is a function value: every callback consumer runs it on
// its receiver.
check(
    "bound-functions-reach-library-callbacks-with-their-receiver",
    `
    type Box = { n: number; tag: string };
    function add(this: Box, by: number): void { this.n += by; }
    function label(this: Box, value: number): string { return this.tag + value; }
    function above(this: Box, value: number): boolean { return value > this.n; }
    function order(this: Box, a: number, b: number): number { return this.n * (a - b); }
    function weigh(this: Box, total: number, value: number): number { return total + value * this.n; }
    function shout(this: Box, match: string): string { return match.toUpperCase() + this.n; }
    function pair(this: Box, match: string, group: string): string { return group.toUpperCase() + this.tag; }
    const box: Box = { n: 0, tag: "v" };
    [1, 2, 3].forEach(add.bind(box));
    const values = [3, 1, 2];
    values.push(4);
    const labels = values.map(label.bind(box)).join();
    const kept = values.filter(above.bind({ n: 2, tag: "" })).join();
    values.sort(order.bind({ n: -1, tag: "" }));
    const total = values.reduce(weigh.bind({ n: 10, tag: "" }), 0);
    const shouted = "abc".replace(/b/g, shout.bind(box));
    const sources = ["(b)"];
    sources.push("(c)");
    let text = "abc";
    for (const source of sources) text = text.replace(new RegExp(source, "g"), pair.bind(box));
    if (box.n !== 6 || labels !== "v3,v1,v2,v4" || kept !== "3,4" || values.join() !== "4,3,2,1" || total !== 100 || shouted !== "aB6c" || text !== "aBvCv")
        throw new Error("library callbacks " + box.n + " " + labels + " " + kept + " " + values.join() + " " + total + " " + shouted + " " + text);
`,
);

check(
    "bound-functions-stored-returned-and-compared-keep-their-receiver",
    `
    type Box = { n: number };
    let count = 0;
    function add(this: Box, by: number): void { this.n += by; count++; }
    function read(this: Box): number { return this.n; }
    const box: Box = { n: 0 };
    const bound = add.bind(box);
    const holder = { run: bound, get: read.bind(box) };
    const list = [bound];
    list.push(add.bind(box));
    const table = new Map([["add", bound]]);
    holder.run(1);
    list[1]!(2);
    table.get("add")!(3);
    if (box.n !== 6 || holder.get() !== 6 || count !== 3) throw new Error("stored " + box.n);
    if (list[0] !== bound || table.get("add") !== bound || holder.run !== bound) throw new Error("identity");
    if (list[1] === bound || bound === add.bind(box) || list.indexOf(bound) !== 0) throw new Error("fresh identity");
    function binder(target: Box) { return add.bind(target); }
    const boxes: Box[] = [{ n: 0 }, { n: 10 }];
    const adders = boxes.map((b) => binder(b));
    adders[0]!(1);
    adders[1]!(2);
    let current = add.bind(boxes[0]!);
    current = add.bind(boxes[1]!);
    current(3);
    if (boxes[0]!.n !== 1 || boxes[1]!.n !== 15) throw new Error("receivers " + boxes[0]!.n + " " + boxes[1]!.n);
    function scoped(seed: number): () => number {
        let local = seed;
        function step(this: Box): number { local += this.n; return local; }
        return step.bind({ n: 10 });
    }
    const stepper = scoped(1);
    stepper();
    class Counter {
        n = 0;
        record(values: number[]): void { values.forEach(note.bind(this)); }
    }
    function note(this: Counter, value: number): void { this.n += value; }
    const counters = [new Counter(), new Counter()];
    counters[1]!.record([4, 5]);
    function twice(this: number, add: number): number { return this * 2 + add; }
    function greet(this: string, name: string): string { return this + " " + name; }
    const doubled = function (this: Box): number { return this.n * 2; };
    const values = [twice.bind(3), twice.bind(5)];
    if (stepper() !== 21 || counters[1]!.n !== 9 || counters[0]!.n !== 0 || values[0]!(1) !== 7 || values[1]!(0) !== 10)
        throw new Error("captures and receivers");
    if (["a"].map(greet.bind("hi")).join() !== "hi a" || [doubled.bind({ n: 4 })][0]!() !== 8)
        throw new Error("string receiver and function expression");
`,
);

check(
    "an arrow on a run-time receiver dispatches an overridden method on this",
    `
    const played: number[] = [];
    class Voice {
        start(value: number): void { played.push(value); }
        play(values: number[]): void {
            const go = (value: number): void => this.start(value);
            values.forEach((value) => go(value));
        }
    }
    class Echo extends Voice {
        override start(value: number): void { played.push(value * 10); }
    }
    const voices: Voice[] = [new Voice(), new Echo()];
    voices[0]!.play([1, 2]);
    voices[1]!.play([1, 2]);
    if (played.join() !== "1,2,10,20") throw new Error("receiver dispatch " + played.join());
    `,
);

check(
    "a-generic-function-over-an-object-bound-type-reads-its-callbacks",
    `
    function firstOf<T extends object>(read: () => T | undefined, fallback: T): T {
        const found = read();
        return found ?? fallback;
    }
    const a = { x: 1 };
    const b = { x: 2 };
    const readers: (() => { x: number } | undefined)[] = [() => a, () => undefined];
    if (firstOf(readers[0]!, b) !== a || firstOf(readers[1]!, b) !== b) throw new Error("first");
`,
);
