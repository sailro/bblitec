import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

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
    const typedEntries: { [key: string]: string } = entries;
    const readRun = (): string | undefined => partial.run;
    partial.run = undefined;
    if (partial.jump !== "K" || partial.run !== undefined || entries["run"] !== undefined) throw new Error("optional view");
    if (!Object.hasOwn(entries, "run") || !Object.hasOwn(partial, "run")) throw new Error("undefined remains an own entry");
    if (!Object.keys(entries).includes("run") || !Object.keys(typedEntries).includes("run")) throw new Error("undefined entry enumerates through aliases");
    if (typedEntries["run"] !== undefined || readRun() !== undefined) throw new Error("undefined entry reads through aliases");
    delete partial.run;
    if (Object.hasOwn(entries, "run") || Object.hasOwn(typedEntries, "run") || Object.keys(entries).includes("run")) throw new Error("delete removes backing entry");
    if (partial.run !== undefined || readRun() !== undefined) throw new Error("deleted optional view reads undefined");
    typedEntries["run"] = "again";
    if (partial.run !== "again" || view.run !== "again" || entries["run"] !== "again" || readRun() !== "again") throw new Error("aliases retain backing identity");
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

// Assertions retype an array without changing its identity, including
// assertions to an unrelated type through an unknown parameter.
for (const [name, asserted] of [
    ["array", "readonly number[]"],
    ["unrelated-array", "readonly string[]"],
    ["record", "{ tag: string }"],
] as const) {
    check(
        `array-identity-through-an-open-assertion-to-${name}`,
        `
    const VALUES: readonly number[] = [1, 2];
    function keep(values: readonly number[]): { values: readonly number[] } { return { values }; }
    function same(a: unknown, b: unknown): boolean { return (a as ${asserted}) === (b as ${asserted}); }
    const first = keep(VALUES);
    const second = keep(VALUES);
    const other = keep([1, 2]);
    if (!same(first.values, second.values) || same(first.values, other.values)) throw new Error("array assertion identity");
`,
    );
}

check(
    "asserted-literals-lacking-required-properties",
    `
    interface Spec { span: number; height: number; depth: number; seed?: number; }
    interface Ctx { spec: Spec; leaf: number; }
    function ctx(depth: number): Ctx { return { spec: { depth } as Spec, leaf: 0.7 }; }
    function layout(spec: Spec, n: number): number[] { return [-spec.span * 0.5, +spec.height, spec.depth, n]; }
    function lay(r: Ctx, span: number): number[] { return layout({ ...r.spec, span }, 1); }
    const partial = ctx(3).spec;
    if (partial.depth !== 3 || (partial.span as number | undefined) !== undefined || "height" in partial) throw new Error("absent");
    if (Object.keys(partial).join(",") !== "depth" || JSON.stringify(partial) !== '{"depth":3}') throw new Error("own keys");
    const half = layout(partial, 0);
    if (!Number.isNaN(half[0]!) || !Number.isNaN(half[1]!) || half[2] !== 3) throw new Error("absent numbers");
    if (lay(ctx(2), 4).join(",") !== "-2,NaN,2,1") throw new Error("spread copy");
    if (lay({ spec: { span: 1, height: 2, depth: 3 }, leaf: 0.5 }, 6).join(",") !== "-3,2,3,1") throw new Error("complete");
    partial.height = 5;
    if (!("height" in partial) || partial.height !== 5) throw new Error("written");
    interface Swallow { groups: number; tail: boolean; spans: number[]; }
    interface Report extends Swallow { head: { x: number }; }
    function clear(report: Swallow): void { report.groups = 0; report.tail = false; report.spans = []; }
    function empty(): Report { const report = { head: { x: 0 } } as Report; clear(report); return report; }
    const report = empty();
    if (report.groups !== 0 || report.tail || report.spans.length !== 0 || report.head.x !== 0) throw new Error("filled");
`,
);

check(
    "record-read-by-a-key-of-an-unbound-type-parameter",
    `
    function lengths<K extends string>(names: Readonly<Record<K, string>>): string {
        return (Object.keys(names) as K[]).map((key) => key + "=" + names[key].length).join(",");
    }
    const out = lengths({ reach: "stewardReach", pause: "pauseSeconds" });
    if (out !== "reach=12,pause=12") throw new Error(out);
`,
);

// The record a name holds is its success arm; the test that selects the
// arm is not settled at generation, so the other arm's read is lowered too.
check(
    "narrowed-arm-property-read-of-a-record-holding-the-other-arm",
    `
    type Removal<R> =
        | { readonly removed: true; readonly effect: R; readonly settled: boolean }
        | { readonly removed: false; readonly reason: "unknown" | "busy"; readonly settled: false };
    interface Outcome { committed: boolean; removed?: number[]; refusal?: { owner: string; reason: string } }
    const refusal = (owner: string, reason: "surface" | "no-change"): Outcome => ({ committed: false, refusal: { owner, reason } });
    const outcomeFor = <R>(id: number, outcome: Removal<R>): Outcome => outcome.removed
        ? { committed: true, removed: [id] }
        : refusal("remove:" + outcome.reason, outcome.reason === "unknown" ? "surface" : "no-change");
    const log: string[] = [];
    function executors<R>(controller: { remove(id: number): Removal<R> }) {
        return {
            remove(id: number): Outcome {
                const outcome = controller.remove(id);
                if (!outcome.removed) return outcomeFor(id, outcome);
                log.push("settled");
                return outcomeFor(id, outcome);
            },
        };
    }
    const kept = executors({ remove: () => { log.push("remove"); return { removed: true, effect: true, settled: true }; } }).remove(7);
    if (!kept.committed || kept.removed![0] !== 7 || log.join() !== "remove,settled") throw new Error("removed");
    const busy = executors<boolean>({ remove: () => ({ removed: false, reason: "busy", settled: false }) }).remove(8);
    if (busy.committed || busy.refusal!.owner !== "remove:busy" || busy.refusal!.reason !== "no-change") throw new Error("refused");
`,
);

// A generic helper's `T & { id: number }` records are the instantiated
// intersection's where its result is stored: one array, two names for its
// element type.
check(
    "generic-intersection-array-stored-as-its-instantiation",
    `
    interface Migration<T extends { id?: number }, H extends { id?: number }> {
        readonly posts: (T & { id: number })[];
        readonly cells: (H & { id: number })[];
        cellId(id: number): number | null;
    }
    function normalize<T extends { id?: number }>(input: readonly T[]): { items: Array<T & { id: number }>; nextId: number } {
        let next = 1;
        for (const item of input) if (item.id !== undefined) next = Math.max(next, item.id + 1);
        const items = input.map((item) => ({ ...item, id: item.id ?? next++ }));
        return { items, nextId: next };
    }
    function migrate<T extends { id?: number }, H extends { id?: number }>(v: number, rawPosts: readonly T[], rawCells: readonly H[]): Migration<T, H> {
        const posts = normalize(rawPosts).items;
        const cells = normalize(rawCells).items;
        const cellId = (id: number): number | null => (v > 0 && cells.some((cell) => cell.id === id) ? id : null);
        return { posts, cells, cellId };
    }
    interface Save { v?: number; posts?: { x: number; id?: number }[]; cells?: { cx: number; level?: number; edge?: "notched" | "plain"; id?: number }[] }
    const kept: Migration<NonNullable<Save["posts"]>[number], NonNullable<Save["cells"]>[number]>[] = [];
    function normalizeSave(save: Save): Save {
        const ids = migrate(save.v ?? 0, save.posts ?? [], save.cells ?? []);
        kept.push(ids);
        const homes = [7, 9].flatMap((home) => { const id = ids.cellId(home); return id === null ? [] : [id]; });
        return { ...save, v: homes.length, posts: ids.posts, cells: ids.cells.filter((cell) => ids.cellId(cell.id) !== null) };
    }
    const flag = Math.random() >= 0;
    const out = normalizeSave({ v: flag ? 2 : 0, posts: [{ x: 1 }], cells: [{ cx: 1 }, { cx: 2, level: 3, id: 7 }] });
    const text = (out.posts ?? []).map((post) => post.x + ":" + post.id).join() + "|" + (out.cells ?? []).map((cell) => cell.cx + ":" + cell.id + ":" + (cell.level ?? "-")).join();
    if (text !== "1:1|1:8:-,2:7:3" || out.v !== 1) throw new Error(text);
    // The stored result holds the same arrays.
    kept[0]!.cells[0]!.cx = 5;
    if (kept.length !== 1 || (out.cells ?? [])[0]!.cx !== 5 || kept[0]!.cellId(8) !== 8) throw new Error("kept");
`,
);

test("a type outside the data model refuses by the path to the part without a representation", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Planner { plan(from: number): number; cache: WeakRef<object>; }
            interface Scenario { name: string; planner: Planner; }
            const owners = new Map<number, Scenario>();
            console.log(owners.size);
            `),
        /new Map requires concrete data type arguments or a contextual container type: 'Map<number, Scenario>' > type argument 'Scenario' > property 'planner' of type 'Planner' > property 'cache' of type 'WeakRef<object>' > type argument 'object': no native representation/,
    );
});

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

test("Object.create, defineProperty and getPrototypeOf refuse unrepresented forms", () => {
    for (const [source, message] of [
        [
            "const p = { a: 1 }; const o: Record<string, number> = Object.create(p);",
            /Object\.create lowers with a null prototype only/,
        ],
        [
            "const o: { x?: number } = {}; Object.defineProperty(o, 'x', { value: 3 });",
            /Object\.defineProperty represents a value with enumerable true, an explicit boolean writable and an explicit boolean configurable attribute only/,
        ],
        [
            "class A {} class B extends A {} const a = new A(); const r = Object.getPrototypeOf(a) === A.prototype;",
            /a class other classes extend is not represented/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

checkInRealm(
    "a-narrower-record-stored-as-its-base-is-copied-where-only-other-objects-are-compared",
    `
    class Failure {
        constructor(readonly code: number) {}
    }
    interface Report {
        kind: string;
        error: unknown;
        context?: string;
    }
    let log = "";
    let gate: ((input: Report) => boolean) | null = null;
    function funnel(input: Report): void {
        if (gate?.(input) === true) return;
        const error = input.error instanceof Failure ? input.error.code : typeof input.error === "string" ? input.error : "?";
        log += input.kind + ":" + error + (input.context ?? "") + ";";
    }
    function reportFailure(input: Report & { error: Failure }): void {
        if (!(input.error instanceof Failure)) return;
        funnel(input);
    }
    gate = (input) => input.kind === "quiet";
    const failure = new Failure(7);
    const other = new Failure(9);
    // A const holds its initializer's object: this compares Failures only.
    const target = failure as unknown;
    if (!!target && target !== other) log += "target;";
    reportFailure({ kind: "boot", error: failure, context: "@1" });
    reportFailure({ kind: "quiet", error: new Failure(8) });
    funnel({ kind: "plain", error: "text" });
    if (log !== "target;boot:7@1;plain:text;") throw new Error("log " + log);
    globalThis.close();
`,
);

check(
    "typeof-a-call-still-makes-the-call",
    `
    interface Deps { count(): number; list(): number[] }
    let calls = 0;
    const deps: Deps = { count: () => { calls++; return 1; }, list: () => { calls++; return []; } };
    if (typeof deps.count() !== "number") throw new Error("number");
    const kind = typeof deps.list();
    if (kind !== "object" || calls !== 2) throw new Error("calls " + calls);
`,
);

check(
    "typeof-answers-a-value-cannot-give-fold-its-guard",
    `
    class Capability {
        readonly #value: number;
        constructor(value: number) { this.#value = value; }
        static read(id: Capability): number { return id.#value; }
    }
    function keyOf(value: unknown): number | null {
        if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
        try {
            const key = Capability.read(value as unknown as Capability);
            return key > 0 ? key : null;
        } catch {
            return null;
        }
    }
    function keys<T extends { readonly id?: unknown }>(input: readonly T[]): number[] {
        return input.map((_, index) => {
            const source = input[index]?.id;
            return keyOf(source) ?? -1;
        });
    }
    const plain = keys([{ id: 4, tower: 0 }, { id: 5, tower: 1 }]);
    if (plain.join() !== "-1,-1") throw new Error("a number is no capability");
    function tag(value: number | string | undefined): number {
        return typeof value === "function" ? 1 : typeof value === "string" ? 2 : 3;
    }
    const tags = [tag(1), tag("a"), tag(undefined)];
    if (tags.join() !== "3,2,3") throw new Error("typeof tags " + tags.join());
`,
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

// `ShaderMaterial & MaterialView` is one engine material: a list of them is a
// native array of handles, which closures read and truncate.
check(
    "pinned-intersection-lists-hold-native-handles",
    `
    type ShaderMaterialView = import("@babylonjs/lite").ShaderMaterial &
        import("@babylonjs/lite").MaterialView;
    const views: ShaderMaterialView[] = [];
    const seen: number[] = [];
    const observe = (): void => {
        seen.push(views.length);
        for (const view of views) seen.push(view ? -1 : -2);
    };
    const clear = (): void => {
        views.length = 0;
        observe();
    };
    observe();
    clear();
    if (seen.join(",") !== "0,0" || views.length !== 0) throw new Error("views");
`,
);

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

// A value typed `{}` is any value but null and undefined: a stored function
// taking `unknown` receives it as the dynamic value it is.
check(
    "stored-unknown-parameters-take-a-value-typed-empty-object",
    `
    function describe(x: unknown): string { return x === null ? "null" : typeof x; }
    const describers: Array<(x: unknown) => string> = [describe];
    function pick(flag: boolean): {} { return flag ? 1 : "a"; }
    const kinds = describers[0]!(pick(true)) + "," + describers[0]!(pick(false));
    if (kinds !== "number,string") throw new Error(kinds);
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
    "array-or-resolver-fields-and-unknown-fields",
    `
    interface Entry { id: number; view?: unknown }
    interface Request { outline?: readonly Entry[] | (() => readonly Entry[]) }
    // A stored closure reads the handler before its declaration runs.
    let registered: ((request: Request) => number) | undefined;
    const handlers: (() => void)[] = [() => { registered = count; }];
    let live = 7;
    const count = (request: Request): number => {
        const o = request.outline;
        const entries = typeof o === "function" ? o() : (o ?? []);
        return entries.length * 10 + (entries[0]?.id ?? 0);
    };
    handlers[0]!();
    const requests: Request[] = [{ outline: [{ id: 1, view: "a" }] }, { outline: () => [{ id: live }, { id: 2 }] }, {}];
    live = 8;
    const counts = requests.map((request) => registered!(request));
    if (counts.join(",") !== "11,28,0") throw new Error("array or resolver " + counts.join(","));
    const view = (requests[0]!.outline as readonly Entry[])[0]!.view;
    if (typeof view !== "string" || view !== "a") throw new Error("unknown field");
`,
);

check(
    "discriminated-union-with-an-intersection-arm",
    `
    interface Moved { created?: readonly number[]; anchors?: readonly (readonly [number, number, number])[] }
    type Outcome = ({ committed: true } & Moved) | { committed: false; refusal: { owner: string; reason: "a" | "b" } };
    const done = (ids: number[]): Outcome => ({ committed: true, created: ids });
    const refused = (owner: string): Outcome => ({ committed: false, refusal: { owner, reason: "a" } });
    const results: Array<() => Outcome> = [() => done([1, 2]), () => refused("x")];
    const text = results
        .map((result) => {
            const outcome = result();
            return outcome.committed ? "c" + (outcome.created?.length ?? 0) : "r" + outcome.refusal.owner;
        })
        .join(",");
    if (text !== "c2,rx") throw new Error("outcomes " + text);
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
    "collections-retain-object-values-through-erased-type-arguments",
    `
    interface Payload { count:number; }
    const payload:Payload={count:1},replacement:Payload={count:1};
    const pending=new Map<string,object>();
    pending.set("a",payload);
    const held=pending.get("a") as Payload;
    if(pending.size!==1||held!==payload||held===replacement)throw new Error("object value identity");
    payload.count=2;
    if(held.count!==2)throw new Error("producer mutation");
    held.count=3;
    if(payload.count!==3)throw new Error("retrieved alias mutation");
    pending.set("a",replacement);
    replacement.count=4;
    if(pending.size!==1||pending.get("a")!==replacement||(pending.get("a") as Payload).count!==4||
       held!==payload||held.count!==3)throw new Error("replaced entry and held alias");
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

check(
    "empty-record-arrays-retain-independent-owners-and-mutable-aliases",
    `
    interface Entry { id:number; view?:unknown; }
    const NO_ENTRIES:readonly Entry[]=Object.freeze([]);
    const OTHER:readonly Entry[]=Object.freeze([]);
    const alias=NO_ENTRIES;
    const saved:ReadonlyArray<readonly Entry[]>=[NO_ENTRIES,OTHER,alias];
    if(saved[0]!==saved[2]||saved[0]===saved[1]||alias!==NO_ENTRIES)
        throw Error('array identity');
    const mutable:Entry[]=[],mutableAlias=mutable;
    const item:Entry={id:1,view:{value:3}};
    mutableAlias.push(item);
    if(mutable!==mutableAlias||mutable.length!==1||mutable[0]!==item)
        throw Error('mutable array owner');
    mutable[0]!.id=8;
    if(item.id!==8)throw Error('entry mutation');
`,
);

check(
    "a branded primitive is its primitive",
    `
    type Id = number & { readonly brand: unique symbol };
    const make = (n: number): Id => n as Id;
    const ids: Id[] = [make(3), make(4)];
    const total = ids.reduce((sum, id) => sum + id, 0);
    if (total !== 7 || typeof ids[0] !== "number") throw new Error("branded " + total);
    `,
);

check(
    "a-union-narrowed-by-an-intersection-is-its-one-possible-arm",
    `
    type Plan = { readonly ok: true; readonly at: number; readonly key: string } | { readonly ok: false; readonly reason: "far" | "blocked" };
    const gate = new Float32Array([0, 1, 1]);
    function plan(index: number): Plan {
        return gate[index]! > 0 ? { ok: true, at: index * 2, key: "k" + index } : { ok: false, reason: "far" };
    }
    const named = (from: number): { plan: Plan & { readonly ok: true }; at: number } | null => {
        for (let i = from; i < 3; i++) {
            const candidate = plan(i);
            if (!candidate.ok) continue;
            return { plan: candidate, at: i };
        }
        return null;
    };
    let held = "";
    const admitted = named(0);
    if (admitted) held = admitted.plan.key + ":" + admitted.plan.at + ":" + admitted.at;
    const none = named(3);
    if (held !== "k1:2:1" || none !== null) throw new Error(held);
`,
);
