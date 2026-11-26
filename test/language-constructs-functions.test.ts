import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runGeneratedProgram } from "./native-fixture.js";
import { check, checkInRealm, native } from "./language-constructs.js";

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
    "dynamic-objects-hold-and-call-their-functions",
    `
    interface Handle { get: () => number; set: (radius: number) => void; min: number; max: number }
    interface Config { left: string; brush?: Handle }
    interface Context { scope: object; label: string }
    function create() {
        let brush: Handle | null = null;
        let current: Config | null = null;
        let seen = 0;
        const poll = (): void => { if (brush) { seen += brush.get(); brush.set(brush.get() + 1); } };
        return {
            show(config: Config) { current = config; brush = config.brush ?? null; poll(); },
            context(): Context | null { return current ? { scope: current, label: current.left } : null; },
            nudge(to: number): number | undefined { brush?.set(to); return brush?.get(); },
            seen: () => seen,
        };
    }
    let radius = 3;
    const hint = create();
    const config: Config = { left: "a", brush: { get: () => radius, set: (value: number) => { radius = value; }, min: 0, max: 5 } };
    hint.show(config);
    const context = hint.context();
    if (hint.seen() !== 3 || radius !== 4) throw new Error("calls");
    if (!context || context.scope !== config || context.label !== "a") throw new Error("scope");
    if (typeof config.brush?.get !== "function" || typeof config.brush.min !== "number") throw new Error("typeof");
    if (JSON.stringify(config) !== '{"left":"a","brush":{"min":0,"max":5}}') throw new Error("stringify " + JSON.stringify(config));
    if (hint.nudge(7) !== 7 || radius !== 7) throw new Error("optional calls");
    hint.show({ left: "b" });
    if (hint.seen() !== 3 || radius !== 7 || hint.nudge(9) !== undefined || radius !== 7) throw new Error("no brush");
`,
);

check(
    "batch-method-unions-in-returned-records-and-optional-containers",
    `
    interface ScalarBatch {
        add(x: number, y: number): number;
        resumeFrom(n: number): void;
    }
    interface ListBatch {
        add(variant: number, x: number, y: number): number;
        resumeFrom(marks: readonly number[]): void;
    }
    const calls: number[] = [];
    function scalar(): ScalarBatch {
        return {
            add(x, y) { return x + y; },
            resumeFrom(n) { calls.push(n * 2); },
        };
    }
    function list(): ListBatch {
        return {
            add(variant, x, y) { return variant * (x + y); },
            resumeFrom(marks) { calls.push(marks.length * 3); },
        };
    }
    type Add = number | ScalarBatch["add"] | ListBatch["add"];
    type Resume = number | ScalarBatch["resumeFrom"] | ListBatch["resumeFrom"];
    interface Schedule { add?: Add[]; resume?: Resume[]; direct?: Resume }
    function adds() { return [scalar().add, list().add]; }
    function resumes() { return [scalar().resumeFrom, list().resumeFrom]; }
    // The returned arrays' elements have no contextual expression at the
    // record sink; the closures must keep their checked declarations.
    const schedules = new Map<string, Schedule>();
    schedules.set("active", { add: adds(), resume: resumes(), direct: list().resumeFrom });
    schedules.set("empty", {});
    const schedule = schedules.get("active")!;
    const indices = new Int32Array([0, 1]);
    const scalarAdd = schedule.add![indices[0]!] as ScalarBatch["add"];
    const listAdd = schedule.add![indices[1]!] as ListBatch["add"];
    const scalarResume = schedule.resume![indices[0]!] as ScalarBatch["resumeFrom"];
    const listResume = schedule.resume![indices[1]!] as ListBatch["resumeFrom"];
    scalarResume(scalarAdd(2, 3));
    listResume([listAdd(2, 3, 4), 7]);
    const direct = schedule.direct as ListBatch["resumeFrom"];
    direct([1]);
    if (scalarAdd(2, 3) !== 5 || listAdd(2, 3, 4) !== 14 || calls.join(",") !== "10,6,3")
        throw new Error("stored batch methods " + calls.join(","));
    if (schedules.get("empty")!.resume !== undefined) throw new Error("absent methods");
`,
);

check(
    "shared-batch-record-layouts-keep-each-method-signature",
    `
    interface Group { values: number[] }
    interface ScalarBatch extends Group {
        add(x: number, y: number): void;
        resumeFrom(n: number): void;
    }
    interface ListBatch extends Group {
        add(variant: number, x: number, y: number): void;
        resumeFrom(marks: readonly number[]): void;
    }
    function scalar(): ScalarBatch {
        const values = [0];
        return {
            values,
            add: (x: number, y: number): void => { values[0] += x + y; },
            resumeFrom: (n: number): void => { values[0] = n; },
        };
    }
    function list(): ListBatch {
        const values = [0];
        return {
            values,
            add: (variant: number, x: number, y: number): void => { values[0] += variant * (x + y); },
            resumeFrom: (marks: readonly number[]): void => { values[0] = marks.length; },
        };
    }
    function retain(batch: ScalarBatch | ListBatch): ScalarBatch | ListBatch { return batch; }
    const retained = [retain(scalar()), retain(list())];
    const plain = retained[0]! as ScalarBatch, marked = retained[1]! as ListBatch;
    const indices = new Int32Array([0, 1]);
    const extra = indices[1]! ? marked : undefined;
    const shared: readonly Group[] = [plain, marked, ...(extra ? [extra] : [])];
    if (shared[0] !== plain || shared[1] !== marked) throw new Error("shared identity");
    const a = shared[indices[0]!]! as ScalarBatch;
    const b = shared[indices[1]!]! as ListBatch;
    a.resumeFrom(5); a.add(2, 3);
    b.resumeFrom([1, 2, 3]); b.add(2, 3, 4);
    let total = 0;
    for (const group of shared) total += group.values[0]!;
    if (total !== 44) throw new Error("shared batch calls " + total);
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
    "one-layout-holds-a-method-two-shapes-declare-apart",
    `
    interface Brick { bind(from: number, variant: number, count: number): number; reupload(): void; bricks: number }
    interface Solid { bind(from: number, count: number): number; reupload(): void; solid: boolean }
    let uploads = 0;
    const brick: Brick = { bind: (from, variant, count) => from + variant * count, reupload: () => { uploads++; }, bricks: 3 };
    const solid: Solid = { bind: (from, count) => from + count, reupload: () => { uploads += 10; }, solid: true };
    const touched = new Set<{ reupload(): void }>();
    const bound = brick.bind(1, 2, 3) + solid.bind(4, 5);
    touched.add(brick);
    touched.add(solid);
    touched.add(brick);
    for (const batch of touched) batch.reupload();
    const bricks: Brick[] = [brick];
    const solids: Solid[] = [solid];
    let stored = 0;
    for (const each of bricks) stored += each.bind(2, 1, 1);
    for (const each of solids) stored += each.bind(3, 4);
    if (uploads !== 11 || bound !== 16 || stored !== 10 || touched.size !== 2) throw new Error("uploads " + uploads + " bound " + bound + " stored " + stored);
`,
);

check(
    "stored-callback-returns-an-object-by-identity",
    `
    interface Frame { halfX: number }
    interface MotionTarget {
        readonly handle: number;
        readonly readRenderFrame?: (out: Frame) => boolean;
        readonly publicationToken?: () => object | null;
    }
    interface PlacementTarget {
        readonly motionId: number;
        readonly readRenderFrame: (out: Frame) => boolean;
    }
    const frame: Frame = { halfX: 1 };
    const first = { id: 1 };
    const second = { id: 2 };
    let current: object = first;
    let retained: MotionTarget | null = null;
    let placement: PlacementTarget | null = null;
    let releaseToken: object | null = null;
    const activeTarget = (): MotionTarget | PlacementTarget | null => placement ?? retained;
    let log = "";
    function write(): void {
        const active = activeTarget();
        if (!active) return;
        if ("motionId" in active) {
            if (active.readRenderFrame(frame)) log += "p" + active.motionId;
        } else {
            log += "m" + active.handle;
            if (active.readRenderFrame) active.readRenderFrame(frame);
        }
        if (retained && active === retained && retained.publicationToken?.() !== releaseToken) log += "!";
    }
    retained = { handle: 1, publicationToken: () => current };
    releaseToken = retained.publicationToken?.() ?? null;
    write();
    current = second;
    write();
    placement = { motionId: 3, readRenderFrame: (out) => out.halfX > 0 };
    write();
    if (log !== "m1m1!p3") throw new Error("log " + log);
`,
);

check(
    "callback-returned-arrays-store-at-the-collection-element-type",
    `
    interface Desired { key: string; matrix: Float32Array }
    interface State extends Desired { visibility: number; target: 0 | 1; pending: Desired | null; active: boolean }
    const order: string[] = [];
    const groups = 2 + Math.trunc(Math.random());
    const states: State[][] = Array.from({ length: groups }, (_, group) => {
        order.push("g" + group);
        return Array.from({ length: 3 }, (_, slot) => {
            order.push(group + ":" + slot);
            return { key: "", matrix: new Float32Array(16), visibility: slot, target: 0 as const, pending: null, active: false };
        });
    });
    const flat: State[][] = Array.from({ length: 2 }, () =>
        Array.from({ length: 2 }, () => ({ key: "f", matrix: new Float32Array(4), visibility: 0, target: 0 as const, pending: null, active: false })),
    );
    if (order.join() !== "g0,0:0,0:1,0:2,g1,1:0,1:1,1:2") throw new Error("mapper order " + order.join());
    if (states.length !== 2 || states[1]!.length !== 3 || states[1]![2]!.visibility !== 2) throw new Error("nested shape");
    if (states[0]![0] === states[0]![1] || states[0] === states[1] || states[0]![0]!.matrix === states[0]![1]!.matrix) throw new Error("fresh records");
    const parked: Desired = { key: "parked", matrix: new Float32Array(16) };
    states[1]![2]!.pending = parked;
    states[1]![2]!.target = 1;
    if (states[1]![2]!.pending !== parked || states[0]![2]!.pending !== null || states[1]![1]!.target !== 0) throw new Error("nullable field");
    if (flat[1]![1]!.key !== "f" || flat[1]![1]!.pending !== null || flat[0] === flat[1]) throw new Error("expression mappers");
    interface Cell { key: string; pending: Desired | null; active: boolean }
    const keys = ["x", "y"];
    const grid: Cell[][] = keys.map((row) => keys.map((column) => ({ key: row + column, pending: null, active: row === column })));
    const spread: Cell[][] = keys.map((row) => keys.flatMap((column) => [{ key: column + row, pending: null, active: false }]));
    const mixed: Cell[][] = Array.from({ length: 2 }, (_, index) => keys.map((key) => ({ key: key + index, pending: null, active: true })));
    if (grid.map((cells) => cells.map((cell) => cell.key + (cell.active ? "!" : "")).join()).join("|") !== "xx!,xy|yx,yy!") throw new Error("nested map");
    grid[0]![1]!.pending = parked;
    if (grid[1]![0]!.pending !== null || grid[0]![1]!.pending?.key !== "parked") throw new Error("nested map records");
    if (spread[1]!.map((cell) => cell.key).join() !== "xy,yy" || mixed[1]![0]!.key !== "x1" || !mixed[0]![1]!.active) throw new Error("flatMap and from-map");
`,
);

check(
    "fresh-array-results-take-mutating-methods",
    `
    const table = { stride: 4, label: "x", offset: 1, scale: 2.5, zero: -0 };
    const fields = Object.entries(table)
        .filter(([name, value]) => typeof value === "number" && name !== "zero")
        .map(([name, value]) => \`\${name}=\${value as number}\`)
        .sort();
    if (fields.join(";") !== "offset=1;scale=2.5;stride=4") throw new Error("entries filter map sort " + fields.join(";"));
    const rows = [{ k: 2, id: "a" }, { k: 1, id: "b" }, { k: 2, id: "c" }, { k: 1, id: "d" }];
    let compared = 0;
    const byKey = rows.map((row) => ({ k: row.k, id: row.id + Math.trunc(Math.random()) })).sort((a, b) => { compared++; return a.k - b.k; });
    if (byKey.map((row) => row.id).join() !== "b0,d0,a0,c0" || compared === 0) throw new Error("stable comparator");
    const doubled = [3, 1, 2].map((value) => value * 2);
    const reversed = [3, 1, 2].map((value) => value * 2).reverse();
    if (reversed.join() !== "4,2,6" || doubled.join() !== "6,2,4") throw new Error("reverse");
    const names = Object.keys(table).filter((name) => name.length > 5);
    const grown = Object.keys(table).filter((name) => name.length > 5).push("extra");
    if (grown !== 3 || names.join() !== "stride,offset") throw new Error("push " + grown + " " + names.join());
    const weights = { b: 2, a: 0.5, c: 2.5 };
    const numbers = Object.values(weights).sort((a, b) => b - a);
    if (numbers.join() !== "2.5,2,0.5") throw new Error("values sort " + numbers.join());
    // A user method named like a built-in returns the array it keeps.
    const items = [3, 1, 2];
    const pool = { filter(): number[] { return items; } };
    pool.filter().sort();
    if (items.join() !== "1,2,3") throw new Error("user method keeps its array");
`,
);

check(
    "stored-function-returning-an-iterable-array",
    `
    interface Deps { slots(): Iterable<number> }
    const list = [1, 2, 3];
    const deps: Deps = { slots: () => list };
    let total = 0;
    for (const s of deps.slots()) { total += s; if (s === 1) list.push(10); }
    const held = deps.slots();
    let twice = 0;
    for (const x of held) twice += x;
    for (const x of held) twice += x;
    const copy = [...deps.slots()];
    const from = Array.from(deps.slots());
    function sum(xs: Iterable<number>): number { let t = 0; for (const x of xs) t += x; return t; }
    const summed = sum(deps.slots()) + sum(list);
    if (total !== 16 || twice !== 32 || copy.join(",") !== "1,2,3,10" || from.length !== 4 || summed !== 32)
        throw new Error("array " + total + " " + twice + " " + copy.join(",") + " " + from.length + " " + summed);
`,
);

check(
    "stored-function-returning-an-iterable-set-or-iterator",
    `
    interface Deps { slots(): Iterable<number> }
    const set = new Set<number>([4, 5]);
    const map = new Map<number, string>([[6, "a"], [7, "b"]]);
    const fromSet: Deps = { slots: () => set };
    const fromKeys: Deps = { slots: () => map.keys() };
    let total = 0;
    for (const s of fromSet.slots()) total += s;
    for (const s of fromKeys.slots()) total += s;
    const held = fromKeys.slots();
    let resumed = 0;
    for (const x of held) { resumed += x; break; }
    for (const x of held) resumed += x * 10;
    const unique = new Set(fromSet.slots());
    const holder: { it: Iterable<number> } = { it: set };
    set.add(6);
    let fielded = 0;
    for (const x of holder.it) fielded += x;
    for (const x of holder.it) fielded += x;
    if (total !== 22 || resumed !== 76 || unique.size !== 2 || fielded !== 30)
        throw new Error("set " + total + " " + resumed + " " + unique.size + " " + fielded);
`,
);

check(
    "stored-function-returning-an-iterable-of-records",
    `
    interface Entry { readonly id: number; save: string }
    interface Fns { homeIds(kind: string): Iterable<number> }
    interface Deps { entries(): Iterable<Readonly<Entry>>; functions(): Fns }
    const rows: Entry[] = [{ id: 1, save: "a" }, { id: 2, save: "b" }];
    const homes = new Map<string, number[]>([["tower", [3, 4]]]);
    const fns: Fns = { homeIds: (kind) => homes.get(kind) ?? [] };
    const deps: Deps = { entries: () => rows, functions: () => fns };
    let ids = "";
    for (const e of deps.entries()) ids += e.id + e.save;
    let t = 0;
    for (const id of deps.functions().homeIds("tower")) t += id;
    for (const id of deps.functions().homeIds("none")) t += id;
    if (ids !== "1a2b" || t !== 7) throw new Error("records " + ids + " " + t);
`,
);

check(
    "flat-map-callback-returning-an-element-or-an-array",
    `
    const xs = [1, 2, 3];
    const ys = xs.flatMap((x) => x > 1 ? x * 10 : []);
    if (ys.join(",") !== "20,30") throw new Error("element " + ys.join(","));
    const zs = xs.flatMap((x) => x === 2 ? [x, x] : x);
    if (zs.join(",") !== "1,2,2,3") throw new Error("array " + zs.join(","));
    interface Geometry { id: number; r: number }
    const known = new Map<number, Geometry>([[1, { id: 1, r: 2 }]]);
    const geometry = (id: number): Geometry | null => known.get(id) ?? null;
    const towers: { id?: number }[] = [{ id: 1 }, { id: 2 }, {}];
    const all = towers.flatMap((tower) => tower.id === undefined ? [] : geometry(tower.id) ?? []);
    if (all.length !== 1 || all[0]!.r !== 2) throw new Error("coalesce " + all.length);
    const names = new Map<number, { steam?: string }>([[1, { steam: "A" }], [2, {}]]);
    const steam = [1, 2, 3].flatMap((id) => names.get(id)?.steam ?? []);
    if (steam.join(",") !== "A") throw new Error("names " + steam.join(","));
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

test("a missing primitive method refuses effectful arguments", () => {
    assert.throws(
        () =>
            compileSource(
                'let calls = 0; function next(): number { calls++; return calls; } type Slots = Readonly<Record<string, string | number[]>>; function word(slots: Slots, name: string): string { const value = slots[name]; if (value === undefined) return "-"; return typeof value === "string" ? value : value.fill(next()).length + ""; } interface Row { key: string; nouns?: Record<string, string> } const rows: Row[] = [{ key: "a", nouns: { a: "potter" } }]; const words = rows.map((row) => (row.nouns ? word(row.nouns, row.key) : "none")); if (words.join() !== "potter") throw new Error("w");',
            ),
        /Unsupported call target 'value.fill' on data:optional/,
    );
});

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
    assert.throws(
        () =>
            compileSource(`const stores: Array<(a: number) => number> = [(a, b = 7) => a + b];
        const wide: Array<(a: number, b: number) => number> = [stores[0]!];
        if (wide[0]!(1, 2) !== 3) throw new Error("x");`),
        /reading arguments past its storage signature cannot share that signature with calls passing more arguments/,
    );
});

check(
    "methods-picked-by-a-runtime-key-are-called",
    `
    type Shape = "circle" | "square";
    interface Costs {
        circle(label: string, scaled: boolean): number;
        square(label: string, scaled: boolean): number;
    }
    const order: string[] = [];
    function note<T>(label: string, value: T): T { order.push(label); return value; }
    function pricing(costs: Costs) {
        return {
            price(shape: Shape, label: string, scaled: boolean): { shape: Shape; cost: number } {
                return { shape, cost: costs[note("key", shape)](note("label", label), note("scaled", scaled)) };
            },
        };
    }
    let calls = 0;
    const made = pricing({
        circle: (label, scaled) => { calls++; return label.length + (scaled ? 100 : 0); },
        square: (label, scaled) => { calls++; return label.length * 2 + (scaled ? 100 : 0); },
    });
    if (made.price("circle", "ring", false).cost !== 4) throw new Error("circle");
    if (made.price("square", "tile", true).cost !== 108) throw new Error("square");
    if (calls !== 2 || order.join(",") !== "key,label,scaled,key,label,scaled") throw new Error("order " + order.join(","));
    const stored: Array<typeof pricing> = [pricing];
    const runtime = stored[0]!({ circle: (label) => label.length, square: (label) => -label.length });
    if (runtime.price("square", "ab", false).cost !== -2) throw new Error("runtime record");
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

check(
    "functions-stored-in-unknown-slots-of-a-document",
    `
    // A function stored where the slot is declared unknown is held as its
    // own type: a member of a record's parameter, a method, an arrow, an
    // async arrow, one with a default.
    interface Deps { pick(x: number, y: number): number; snapshot(): string[] }
    function install(target: Record<string, unknown>, deps: Deps): void {
        target.ccPick = deps.pick;
        target.ccSnapshot = deps.snapshot;
        target.ccTrace = async (x: number): Promise<number> => deps.pick(x, x);
        target.ccGround = (x: number, z: number, radius = 0) => ({ x, z, radius });
    }
    const bag: Record<string, unknown> = JSON.parse('{"kept":1}');
    install(bag, { pick: (x, y) => x + y, snapshot: () => ["a"] });
    const kinds = Object.keys(bag).map((key) => key + ":" + typeof bag[key]).join();
    if (kinds !== "kept:number,ccPick:function,ccSnapshot:function,ccTrace:function,ccGround:function") throw new Error(kinds);
    if (JSON.stringify(bag) !== '{"kept":1}') throw new Error("serialized " + JSON.stringify(bag));
`,
);

check(
    "function-slots-over-records-holding-unknown-values",
    `
    // A declared slot starting null takes a function whose parameter
    // record holds an unknown value: the slot's unknown positions are
    // stored as the values they are.
    interface CrashInput { kind: "boot" | "frame"; error: unknown; context?: string }
    let gate: ((input: CrashInput) => boolean) | null = null;
    function setGate(next: ((input: CrashInput) => boolean) | null): void { gate = next; }
    function report(input: CrashInput): string {
        let withheld = false;
        if (gate) {
            try { withheld = gate(input) === true; } catch { /* a broken gate hides nothing */ }
        }
        return withheld ? "withheld" : "shown:" + String(input.error);
    }
    const first = report({ kind: "boot", error: "a" });
    const absorbed: unknown[] = [];
    setGate((input) => { absorbed.push(input.error); return input.kind === "frame"; });
    const second = report({ kind: "frame", error: "b" });
    const third = report({ kind: "boot", error: 3 });
    setGate((input) => { if (input.error === null) throw new Error("broken"); return typeof input.error === "number"; });
    const fourth = report({ kind: "boot", error: null });
    const fifth = report({ kind: "boot", error: 5, context: "late" });
    setGate(null);
    const seen = [first, second, third, fourth, fifth, report({ kind: "frame", error: true }), absorbed.length, typeof absorbed[1]].join("|");
    if (seen !== "shown:a|withheld|shown:3|shown:null|withheld|shown:true|2|number") throw new Error(seen);
`,
);

check(
    "a-constant-callback-selects-its-declared-union-arm",
    `
    interface Slot { pick: number | (() => number) | ((value: number) => number) }
    const slots: Slot[] = [{ pick: () => 1 }, { pick: (value: number) => value * 2 }];
    const first = slots[0]!.pick as () => number;
    const second = slots[1]!.pick as (value: number) => number;
    if (first() !== 1 || second(3) !== 6) throw new Error("function arms");
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

// A record type with methods that parsed values reach is a document: a
// literal's method stays callable, a parsed record's call throws TypeError.
check(
    "parsed-documents-read-as-record-types-with-stored-functions",
    `
    interface Handler { name: string; run(): number }
    function load(text: string): Handler { return JSON.parse(text) as Handler; }
    const loaders: Array<typeof load> = [load];
    const handler: Handler = { name: 'a', run: () => 1 };
    const parsed = loaders[0]!('{"name":"b"}');
    let refused = false;
    try { parsed.run(); } catch (error) { refused = error instanceof TypeError; }
    if (handler.run() !== 1 || parsed.name !== "b" || !refused) throw new Error("handlers");
`,
);

// A record handed to a function that compares it is the one object its
// literal created, whether the call is inlined or runs a compiled body.
check(
    "records-compared-by-a-called-function-stay-one-object",
    `
    interface Point { x: number; y: number }
    const point = { x: 1, y: 2 };
    const other = { x: 1, y: 2 };
    function sameAs(value: Point, against: Point): boolean { return value === against; }
    const compares: Array<typeof sameAs> = [sameAs];
    if (!sameAs(point, point) || sameAs(point, other)) throw new Error("direct");
    if (!compares[0]!(point, point) || compares[0]!(point, other)) throw new Error("stored");
    const alias = point;
    if (alias !== point || alias === other) throw new Error("alias");
`,
);

// Meshes are native handles the Node run has no engine for: the generated
// program runs the same assertions over two engines whose first meshes
// share a slot, so only the engine tells them apart.
test(
    "an object parameter compares the mesh it is passed by identity through a stored method",
    { skip: !native },
    () => {
        const { cpp } = compileSource(`
        import { createBox, type EngineContext, type Mesh } from "@babylonjs/lite";
        interface Fence { mesh: Mesh; elementAt(pickedMesh: object | null, faceId: number): number | null }
        function createFence(engine: EngineContext): Fence {
            const mesh = createBox(engine);
            const hits: number[] = [7, 8, 9];
            const elementAt = (pickedMesh: object | null, faceId: number): number | null => {
                if (pickedMesh !== mesh) return null;
                return hits[faceId] ?? null;
            };
            return { mesh, elementAt };
        }
        function inspect(first: EngineContext, second: EngineContext): number {
            const fence = createFence(first);
            const other = createFence(second);
            if (fence.elementAt(fence.mesh, 1) !== 8) throw new Error("its own mesh");
            if (fence.elementAt(null, 1) !== null) throw new Error("no mesh");
            if (fence.elementAt(other.mesh, 1) !== null) throw new Error("another engine's mesh");
            if (other.elementAt(other.mesh, 2) !== 9) throw new Error("the other fence");
            return 1;
        }
        const inspections: Array<typeof inspect> = [inspect];
    `);
        const entry =
            /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
                cpp,
            );
        assert.ok(entry, "two-engine inspection");
        runGeneratedProgram(
            native!,
            "language-constructs/object-parameter-mesh-identity",
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
                auto first = std::make_shared<bbl::Engine>();
                auto second = std::make_shared<bbl::Engine>();
                bblscene::${entry[2]} environment{};
                assert(bblscene::${entry[1]}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}) == 1);
            }
        `,
        );
    },
);

checkInRealm(
    "a stored function a builder returns completes as the callback it was handed",
    `
    function rollbackTo<T>(read: () => T, present: (value: T) => void): () => void {
        return () => present(read());
    }
    let committed = 0;
    let shown = 0;
    const pick = (value: number): Promise<boolean> | boolean => (value > 1 ? Promise.resolve(false) : true);
    const previous = committed;
    const rollback = rollbackTo(() => previous, (value) => {
        if (committed === 5) return;
        shown = value;
    });
    committed = 7;
    shown = 7;
    const result = pick(committed);
    if (result instanceof Promise)
        void result.then((accepted) => { if (!accepted) rollback(); }).catch(rollback).then(() => {
            if (shown !== 0) throw new Error("rolled back to " + shown);
            globalThis.close();
        });
    `,
);

check(
    "a clause that falls into a returning default ends the function",
    `
    function fail(m: string): never { throw new Error(m); }
    function f(n: number): number { switch (n) { case 0: fail("zero"); default: return n * 2; } }
    function g(n: number): string { switch (n) { case 1: n += 1; case 2: n += 1; default: return "v" + n; } }
    let caught = "";
    try { f(Date.now() > 0 ? 0 : 1); } catch (e) { caught = (e as Error).message; }
    if (caught !== "zero" || f(3) !== 6 || g(1) !== "v3" || g(5) !== "v5") throw new Error("fallthrough end " + caught);
    `,
);

test("a method key that runs code refuses", () => {
    assert.throws(
        () =>
            compileSource(
                'class K { m(): number { return 1; } } const k = new K(); const key = (): "m" => "m"; const unused = k[key()]();',
            ),
        /A method key that runs code/,
    );
});

check(
    "a-generic-function-reads-a-read-only-record-of-its-type-argument",
    `
    interface State { wall?: string; tint?: [number, number, number] }
    interface House extends State { id: number }
    interface Deps<S extends State> { read(id: number): Readonly<S> | undefined; copy(record: Readonly<S>): S }
    function plan<S extends State>(deps: Deps<S>, id: number): S | null {
        const current = id > 0 ? deps.read(id) : undefined;
        return current ? deps.copy(current) : null;
    }
    const houses: House[] = [{ id: 1, wall: "stone", tint: [1, 0.5, 0] }];
    const copied = plan<House>({ read: (id) => houses.find((house) => house.id === id), copy: (house) => ({ ...house }) }, 1);
    if (!copied || copied === houses[0] || copied.wall !== "stone" || copied.tint?.[1] !== 0.5) throw new Error("plan");
    if (plan<House>({ read: () => undefined, copy: (house) => ({ ...house }) }, 0) !== null) throw new Error("none");
`,
);

check(
    "one-layout-holds-a-field-one-shape-declares-a-method",
    `
    interface Brick { readonly count: number; reupload(): void; bricks: number }
    interface Solid { count(): number; reupload(): void; solid: boolean }
    let uploads = 0;
    let live = 3;
    const gate = new Float32Array([5]);
    const brick: Brick = { get count() { return live; }, reupload: () => { uploads++; }, bricks: 3 };
    const solid: Solid = { count: () => gate[0]!, reupload: () => { uploads += 10; }, solid: true };
    const touched = new Set<{ reupload(): void }>();
    touched.add(brick);
    touched.add(solid);
    touched.add(brick);
    for (const batch of touched) batch.reupload();
    const bricks: Brick[] = [brick];
    const solids: Solid[] = [solid];
    live = 4;
    const total = bricks[0]!.count + solids[0]!.count();
    if (uploads !== 11 || total !== 9 || typeof solid.count !== "function") throw new Error("uploads " + uploads + " total " + total);
`,
);

test("an optional property refuses function storage that erased installed properties", () => {
    for (const [writeFirst, parameter] of [
        [true, ""],
        [false, ""],
        [true, "index: number"],
        [false, "index: number"],
    ] as const) {
        assert.throws(
            () =>
                compileSource(`
                type Reader = ((${parameter}) => number) & { changed?: () => void };
                const readers: Array<(${parameter}) => number> = [() => 1];
                const decorated: (() => number) & { changed?: () => void } = Object.assign(() => 2, { changed: () => {} });
                function inspect(reader: Reader): boolean { return !!reader.changed; }
                ${writeFirst ? "readers.push(decorated);" : ""}
                inspect(readers[0]!);
                ${writeFirst ? "" : "readers.push(decorated);"}
                `),
            /properties cannot be read after callable record storage erased them/,
        );
    }
});
