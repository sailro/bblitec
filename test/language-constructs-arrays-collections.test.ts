import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runGeneratedProgram } from "./native-fixture.js";
import { check, checkInRealm, native } from "./language-constructs.js";

check(
    "an-array-literal-of-runtime-elements-joins-at-run-time",
    `
    const s = Math.random() > 2 ? "a" : "b";
    const n = Math.random() > 2 ? 1 : 2;
    if ([s, "c"].join("-") !== "b-c" || [n, 3].join() !== "2,3") throw new Error("join");
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

// A search over elements generation holds answers at generation, with
// JavaScript's comparisons: includes finds NaN (SameValueZero), indexOf
// and lastIndexOf do not (strict equality); a predicate over it folds too.
check(
    "array-search-over-generation-known-elements",
    `
    const lanes = [1, NaN, 3, 1];
    const names = ["world", "uTint"];
    const kept = ["world", "view", "uTint"].filter((name) => names.includes(name));
    if (!lanes.includes(NaN) || lanes.indexOf(NaN) !== -1 || lanes.lastIndexOf(1) !== 3 || lanes.indexOf(3) !== 2) throw new Error("search");
    if (kept.length !== 2 || kept[1] !== "uTint" || ["a"].includes("b")) throw new Error("filter");
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

test("ArrayLike slots refuse what cannot keep an array's identity", () => {
    assert.throws(
        () =>
            compileSource(
                "interface Holder { values: ArrayLike<number>; } function keep(values: ArrayLike<number>): Holder { return { values }; } const typed: Holder = { values: new Float32Array(2) }; const kept = keep([1, 2]); const unused = kept.values.length + typed.values.length;",
            ),
        /A borrowed array view cannot retain JavaScript array identity in owning storage/,
    );
    assert.throws(
        () =>
            compileSource(
                "interface Holder { values: ArrayLike<number>; } const floats = new Float32Array(2); const numbers: number[] = [1]; const holder: Holder = { values: floats }; holder.values = numbers; let none: number[] | null = null; if (floats.length > 1) none = numbers; const unused = holder.values === none;",
            ),
        /A numeric view compares by identity only with a present numeric array/,
    );
});

check(
    "weak collections compare, search and key by identity",
    `
    interface Owner { id: number }
    const notes = new WeakMap<object, string[]>();
    const other = new WeakMap<object, string[]>();
    const handed: unknown = notes;
    if (handed !== notes || handed === other || !(notes === notes)) throw new Error("weak map identity");
    const key: Owner = { id: 1 };
    notes.set(key, ["a"]);
    const seen = new WeakSet<Owner>();
    const seenHanded: unknown = seen;
    seen.add(key);
    if (seenHanded !== seen || seen === new WeakSet<Owner>() || !seen.has(key)) throw new Error("weak set identity");
    const kept = [notes, other];
    if (kept.indexOf(other) !== 1 || !kept.includes(notes) || kept.lastIndexOf(notes) !== 0 || kept.includes(new WeakMap<object, string[]>()))
        throw new Error("search");
    const named = new Map<WeakMap<object, string[]>, string>([[notes, "notes"]]);
    if (named.get(notes) !== "notes" || named.has(other) || notes.get(key)![0] !== "a") throw new Error("keyed");
    `,
);

check(
    "collections with different element types compare their storage identities",
    `
    const a = new WeakMap<object, number>();
    const b = new WeakMap<object, string>();
    const unknownA: unknown = a;
    if (unknownA === b || a !== unknownA) throw new Error("different weak maps");
    const strong = new Map<object, number>();
    if (unknownA === strong) throw new Error("weak and strong maps");
    const numbers = new Set<number>();
    const strings = new Set<string>();
    const unknownSet: unknown = numbers;
    if (unknownSet === strings || unknownSet === a) throw new Error("different collections");
    const records = new WeakSet<{ id: number }>();
    const names = new WeakSet<{ name: string }>();
    const unknownRecords: unknown = records;
    if (unknownRecords === names || unknownRecords !== records) throw new Error("different weak sets");
    const list = [a];
    let index = 2;
    if (list[index] !== list[index + 1] || list[index] === a) throw new Error("absent maps");
    `,
);

// A `map` building empty records has no storage of its own: its array is
// the one its place declares, each record its own.
check(
    "map-building-empty-records-for-a-declared-record-list",
    `
    interface Target { name?: string; bone?: number }
    interface Request { asset: string; clips: string[]; targets: Target[] }
    interface View { readonly asset: string; readonly targets: readonly Target[] }
    function describe(view: View): string { return view.asset + ":" + view.targets.length + ":" + view.targets.map((t) => t.name ?? "any").join("|"); }
    const flag = Math.random() >= 0;
    const meshes = [{ skinned: flag }, { skinned: !flag }, { skinned: true }];
    const skinned = meshes.filter((mesh) => mesh.skinned);
    const request: Request = { asset: "assets/a.glb", clips: ["swim"], targets: skinned.map(() => ({})) };
    if (request.targets.length !== 2 || request.targets[0]!.name !== undefined) throw new Error("targets");
    request.targets[1]!.bone = 3;
    if (request.targets[0]!.bone !== undefined || request.targets[1]!.bone !== 3) throw new Error("own records");
    const named: View = { asset: "b", targets: skinned.map((_, index) => (index === 0 ? {} : { name: "n" + index })) };
    if (describe(request) !== "assets/a.glb:2:any|any" || describe(named) !== "b:2:any|n1") throw new Error(describe(named));
`,
);

// `object | null` keeps any object for its identity: a record or, where
// none is open, an array.
check(
    "object-kept-from-a-record-or-an-array-by-identity",
    `
    interface Lister { options(): readonly string[] }
    let open: Lister | null = null;
    let heldIn: object | null = null;
    let log = "";
    const flag = Math.random() >= 0;
    const root: number[] | null = flag ? [1, 2] : null;
    function handle(use: boolean): void {
        const list = use ? open : null;
        const area: object | null = list ?? root;
        if (!area) { heldIn = null; log += "none,"; return; }
        log += heldIn !== area ? "changed," : "same,";
        heldIn = area;
    }
    handle(flag); handle(flag);
    open = { options: () => ["a"] };
    handle(flag); handle(flag); handle(!flag); handle(!flag);
    if (log !== "changed,same,changed,same,changed,same,") throw new Error(log);
`,
);

check(
    "run-time-index-into-an-empty-array",
    `
    function build<Entry>(entries: readonly Entry[], boundsAt: (entry: Entry, out: { min: number; max: number }) => void): number {
        const bounds = entries.map(() => ({ min: 0, max: 0 }));
        for (let index = 0; index < entries.length; index++) boundsAt(entries[index]!, bounds[index]!);
        let widest = 0;
        for (let index = 0; index < bounds.length; index++) widest = Math.max(widest, bounds[index]!.max - bounds[index]!.min);
        return widest;
    }
    const none = build([], () => {});
    const some = build([3, 7], (entry, out) => { out.min = -entry; out.max = entry; });
    if (none !== 0 || some !== 14) throw new Error(none + " " + some);
`,
);

// A missed element falls back to an empty literal its record type cannot
// hold: both are stored as the narrower record the parameter declares.
check(
    "a-missed-record-element-falls-back-to-a-literal-of-the-parameters-record",
    `
    interface Tower { id?: number; level: number; yaw: number }
    const towers: Tower[] = [{ id: 7, level: 1, yaw: new Float32Array([0.5])[0]! }];
    function hostIdentity(tower: Pick<Tower, "id">, index: number): number {
        return tower.id ?? -(index + 1);
    }
    const lanes = new Int32Array([0, 2]);
    const found = hostIdentity(towers[lanes[0]!] ?? {}, lanes[0]!);
    if (found !== 7) throw new Error("present " + found);
    const missed = hostIdentity(towers[lanes[1]!] ?? {}, lanes[1]!);
    if (missed !== -3) throw new Error("fallback " + missed);
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

// A record literal lends its arrays to an async callee that reads them
// before it first awaits, while nothing else can change them.
const lentRecordProgram = `
    type Ids = readonly (string | null | undefined)[];
    interface Needs { roof?: Ids; walls?: Ids; dome?: Ids }
    interface Catalog { resolve(id: string | null | undefined): string }
    interface Resolved { roof: readonly string[]; walls: readonly string[] }
    function resolveNeeds(catalog: Catalog, needs: Needs): Resolved {
        const ids = (requested: Ids | undefined) => [...new Set((requested ?? []).map((id) => catalog.resolve(id)))];
        return { roof: ids([...(needs.roof ?? []), ...(needs.dome ?? [])]), walls: ids(needs.walls) };
    }
    function createPreparer(catalog: Catalog) {
        const hooks: ((needs: Resolved) => Promise<boolean>)[] = [];
        return {
            add(hook: (needs: Resolved) => Promise<boolean>): void { hooks.push(hook); },
            async prepare(needs: Needs): Promise<void> {
                const resolved = resolveNeeds(catalog, needs);
                const ready = await Promise.all(hooks.map((hook) => hook(resolved)));
                if (!ready.every(Boolean)) throw new Error("failed");
            },
        };
    }
    const preparer = createPreparer({ resolve: (id) => id ?? "default" });
    let log = "";
    preparer.add(async (needs) => { log += needs.roof.join() + "/" + needs.walls.join() + ";"; return true; });
    const ensure = preparer.prepare;
    const wanted = ["tile", "slate", "tile", "oak"];
    const missing = [...new Set(wanted.filter((id) => id !== "oak"))];
    const sig = missing.sort().join(",");
    void ensure({ roof: missing, walls: ["oak"] }).then(() => {
        if (log !== "slate,tile/oak;" || sig !== "slate,tile") throw new Error("needs " + log);
        const domes = ["cap"].filter((id) => id.length > 0);
        void ensure({ dome: domes }).then(() => { if (!log.endsWith("cap/;")) throw new Error("dome " + log); globalThis.close(); });
    });
`;

checkInRealm(
    "a-local-array-lent-in-a-record-to-a-callee-that-only-reads-it-is-converted",
    lentRecordProgram,
);

// The copy is refused where the callee keeps the property, reads it only
// after it first awaits, or where code the call runs may change the local.
test("an array lent in a record refuses where the copy could be told apart", () => {
    const prepare = "const resolved = resolveNeeds(catalog, needs);";
    const sorted = 'const sig = missing.sort().join(",");';
    for (const source of [
        lentRecordProgram
            .replace("type Ids", "let kept: Ids = [];\n    type Ids")
            .replace(prepare, `kept = needs.roof ?? []; ${prepare}`),
        lentRecordProgram.replace(
            prepare,
            `await Promise.resolve(); ${prepare}`,
        ),
        lentRecordProgram.replace(
            sorted,
            `${sorted} preparer.add(async () => { missing.length = 0; return true; });`,
        ),
    ])
        assert.throws(
            () => compileSource(source),
            /An array stored as an array of another element type is a copy/,
        );
});

check(
    "writing-an-element-of-the-array-a-call-returns",
    `
    interface Cap { id: number }
    const caps: Cap[] = [{ id: 1 }, { id: 2 }];
    const carried = new Map(caps.map((cap) => [cap, [false, false, false, false] as [boolean, boolean, boolean, boolean]] as const));
    const corner = caps.length - 1;
    carried.get(caps[0]!)![corner] = true;
    const rows = new Map<string, number[]>([["a", [0, 0]]]);
    rows.get("a")![rows.size] = 5;
    const first = carried.get(caps[0]!)!, second = carried.get(caps[1]!)!;
    if (!first[1] || second[1] || rows.get("a")!.join(",") !== "0,5") throw new Error("element " + first.join(",") + " " + rows.get("a")!.join(","));
`,
);

check(
    "truncating-the-array-a-call-returns",
    `
    interface Chimney { id: number }
    const towers: Chimney[] = [{ id: 1 }, { id: 2 }];
    const houses: Chimney[] = [{ id: 3 }];
    const deps = { towerChimneys: (): Chimney[] => towers, houseChimneys: (): Chimney[] => houses };
    function reset(keep: number): void {
        deps.towerChimneys().length = keep;
        deps.houseChimneys().length = 0;
    }
    reset(1);
    if (towers.length !== 1 || towers[0]!.id !== 1 || houses.length !== 0) throw new Error("truncate " + towers.length + houses.length);
`,
);

check(
    "reassigned-let-holding-a-literal-array-argument",
    `
    function count<T>(items: readonly T[], more: readonly T[]): number {
        let current = items;
        if (current.length !== 1) throw new Error("first " + current.length);
        current = more.filter(() => true);
        return current.length;
    }
    if (count([{ k: 1 }], [{ k: 2 }, { k: 3 }]) !== 2) throw new Error("records");
    interface Row { key: string }
    function make(items: readonly Row[]) {
        let current = items;
        const set = (next: readonly Row[]): void => { current = next; };
        return { set, first: () => current[0]?.key ?? "-", size: () => current.length };
    }
    const handle = make([{ key: "v" }]);
    if (handle.first() !== "v") throw new Error("initial " + handle.first());
    const more: Row[] = [];
    more.push({ key: "a" }, { key: "b" });
    handle.set(more);
    more.push({ key: "c" });
    if (handle.size() !== 3 || handle.first() !== "a") throw new Error("closure " + handle.size());
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
    "dictionaries-of-one-arm-pass-as-union-dictionaries",
    `
    type Slots = Readonly<Record<string, string | readonly string[]>>;
    function word(slots: Slots, name: string): string {
        const value = slots[name];
        if (value === undefined) return "-";
        return typeof value === "string" ? value.toUpperCase() : value.map((part) => part.toUpperCase()).join("+");
    }
    function guarded(slots: Slots, name: string): string {
        const value = slots[name];
        try {
            return typeof value === "string" ? value : value.map((part) => part).join("+");
        } catch (error) {
            return error instanceof TypeError ? "type" : "other";
        }
    }
    interface Row { key: string; nouns?: Record<string, string> }
    const rows: Row[] = [{ key: "a", nouns: { a: "potter" } }, { key: "b" }, { key: "c", nouns: { a: "x" } }];
    const words = rows.map((row) => (row.nouns ? word(row.nouns, row.key) + guarded(row.nouns, row.key) : "none"));
    if (words.join(",") !== "POTTERpotter,none,-type") throw new Error("one-arm dictionaries " + words.join(","));
    const lists: Slots = { a: ["p", "q"], b: "r" };
    if (rows.map((row) => word(lists, row.key)).join(",") !== "P+Q,R,-") throw new Error("union dictionary");
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
    "object-entries-and-values-of-run-time-own-keys-iterate-and-map",
    `
    interface Opt { label: string; count: number; detail?: string }
    const items: Opt[] = [];
    items.push({ label: "tag", count: 1 });
    items.push({ label: "tag", count: 2, detail: "extra" });
    items.push({ label: "u", count: 3, detail: undefined });
    let seen = "";
    for (const item of items) {
        seen += Object.entries(item).map(([k, v]) => k + "=" + v).join("+") + ";";
        for (const [k, v] of Object.entries(item)) seen += k + ":" + typeof v + ",";
        seen += Object.values(item).length + "|" + Object.keys(item).join(",") + ";";
    }
    if (seen !== "label=tag+count=1;label:string,count:number,2|label,count;label=tag+count=2+detail=extra;label:string,count:number,detail:string,3|label,count,detail;label=u+count=3+detail=undefined;label:string,count:number,detail:undefined,3|label,count,detail;") throw new Error("optional keys " + seen);
    class Base { label = "tag"; }
    class Left extends Base { detail = "extra"; }
    const shapes: Base[] = [];
    shapes.push(new Base());
    shapes.push(new Left());
    let walked = "";
    for (const shape of shapes) {
        for (const [k, v] of Object.entries(shape)) walked += k + "=" + v + "+";
        walked += Object.values(shape).join("+") + ";";
    }
    if (walked !== "label=tag+tag;label=tag+detail=extra+tag+extra;") throw new Error("hierarchy keys " + walked);
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
    "fresh-records-stored-as-dictionaries",
    `
    // The records a map or flatMap callback builds, held by nothing else,
    // are stored as the dictionaries a stored function's type declares.
    interface Rec { id: number; w: number; name: string }
    const recs: Rec[] = [{ id: 1, w: 2, name: "a" }, { id: 2, w: 0, name: "b" }, { id: 3, w: 1, name: "c" }];
    const fns: (() => Array<Record<string, unknown>>)[] = [];
    fns.push(() => recs.map((rec) => ({ id: rec.id, label: rec.name })));
    fns.push(() => recs.flatMap((rec) => rec.w > 0 ? [{ id: rec.id, wide: rec.w > 1 }] : []));
    fns.push(() => recs.flatMap((rec) => {
        if (rec.w === 0) return [];
        const wide = rec.w > 1;
        return [{ id: rec.id, wide }, { id: -rec.id, wide: false }];
    }));
    const seen = fns.map((fn) => JSON.stringify(fn())).join("|");
    if (seen !== '[{"id":1,"label":"a"},{"id":2,"label":"b"},{"id":3,"label":"c"}]|[{"id":1,"wide":true},{"id":3,"wide":false}]|[{"id":1,"wide":true},{"id":-1,"wide":false},{"id":3,"wide":false},{"id":-3,"wide":false}]')
        throw new Error(seen);
    // Each is a dictionary of its own: it takes a key the record never had.
    const rows = fns[0]!();
    rows[0]!.extra = true;
    if (Object.keys(rows[0]!).join() !== "id,label,extra" || Object.keys(rows[1]!).join() !== "id,label") throw new Error("own dictionary");
`,
);

check(
    "arrays-stored-as-a-union's-array-member",
    `
    // An array of records of another type (a map's or flatMap's results, a
    // function's) is stored as the union's one array member, its elements
    // as that member's.
    interface Ignore { readonly name: string; readonly instance?: number; readonly range?: { readonly start: number; readonly count: number } }
    type Resolver = (key: string) => Ignore | Ignore[] | null;
    const resolvers: Resolver[] = [];
    const names = ["a", "b", "c"];
    function describe(result: Ignore | Ignore[] | null): string {
        if (result === null) return "null";
        if (Array.isArray(result))
            return "[" + result.map((entry) => entry.name + ":" + (entry.instance ?? "-") + ":" + (entry.range ? entry.range.start + "+" + entry.range.count : "-")).join() + "]";
        return result.name + ":" + (result.instance ?? "-");
    }
    resolvers.push((key) => {
        if (key === "none") return null;
        return names.flatMap((name) => name >= key ? [{ name, range: { start: 1, count: 2 } }] : []);
    });
    resolvers.push((key) => names.map((name) => ({ name, instance: key.length })));
    const lookup = (key: string): { name: string }[] | undefined => key === "b" ? [{ name: key }] : undefined;
    resolvers.push((key) => lookup(key) ?? []);
    resolvers.push((key) => key === "x" ? null : { name: key, instance: 2 });
    function pick(key: string): Ignore | Ignore[] | null {
        const found = names.map((name) => ({ name, instance: key.length }));
        return found;
    }
    const seen = resolvers.map((resolve) => describe(resolve("b"))).join(";") + ";" + describe(resolvers[0]!("none")) + ";" + describe(pick("zz"));
    if (seen !== "[b:-:1+2,c:-:1+2];[a:1:-,b:1:-,c:1:-];[b:-:-];b:2;null;[a:2:-,b:2:-,c:2:-]") throw new Error(seen);
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

test("an array stored with converted elements refuses where its local already holds other storage", () => {
    assert.throws(
        () =>
            compileSource(
                "const values: readonly number[] = [1, 2].map((i) => i * 2); function view(): readonly (number | undefined)[] { return values; } const roots: Array<typeof view> = [view]; if (roots[0]!() !== roots[0]!()) throw new Error('x');",
            ),
        /is a copy, and the program compares such arrays by identity/,
    );
});

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

check(
    "an-array-of-records-without-native-storage-keeps-its-constant",
    `
    interface Entry { id: number; view?: unknown }
    const NO_ENTRIES: readonly Entry[] = Object.freeze([]);
    function outline(entries: readonly Entry[] | null): readonly Entry[] {
        return entries ?? NO_ENTRIES;
    }
    function same(a: readonly Entry[], b: readonly Entry[]): boolean {
        return a === b;
    }
    const kept: Array<typeof outline | typeof same> = [outline, same];
    if (kept.length !== 2) throw new Error("kept");
`,
);

check(
    "nested-dictionary-record-views-retain-stored-identity",
    `type Kind = "hint" | "error" | "success";
                interface StatusMessage {
                  key: string;
                  params?: Record<string, string>;
                  kind: Kind;
                }
                function format(key: string, params?: Record<string, string>): string {
                  let text = key;
                  if (params) {
                    for (const [k, v] of Object.entries(params)) text += ";" + k + "=" + v;
                  }
                  return text;
                }
                function create(): { press(mode: number, other: string): void; text(): string } {
                  let statusMessage: StatusMessage = { key: "hint", kind: "hint" };
                  let shown = "";
                  const renderStatus = (): void => {
                    shown = format(statusMessage.key, statusMessage.params) + (statusMessage.kind === "error" ? "!" : "");
                  };
                  const setStatus = (message: StatusMessage): void => {
                    statusMessage = message;
                    renderStatus();
                  };
                  const press = (mode: number, other: string): void => {
                    if (mode === 0) {
                      setStatus(
                        other === "x"
                          ? { key: "swap", params: { action: "a", other: format(other), key: "k" }, kind: "error" }
                          : { key: "single", kind: "error" },
                      );
                      return;
                    }
                    if (mode === 1) {
                      setStatus(
                        other === "y"
                          ? { key: "swapped", params: { action: "a", key: "k", other, otherKey: "o" }, kind: "success" }
                          : { key: "assigned", params: { action: "a", key: "k" }, kind: "success" },
                      );
                      return;
                    }
                    if (mode === 2) {
                      setStatus({ key: "press", params: { action: other }, kind: "hint" });
                      return;
                    }
                    statusMessage.kind = "success";
                    statusMessage = { key: "hint", kind: "hint" };
                    renderStatus();
                  };
                  renderStatus();
                  return { press, text: () => shown };
                }
                const c = create();
                if (c.text() !== "hint") throw new Error("bad hint");
                c.press(0, "x");
                if (c.text() !== "swap;action=a;other=x;key=k!") throw new Error("bad swap");
                c.press(0, "z");
                if (c.text() !== "single!") throw new Error("bad single");
                c.press(1, "y");
                if (c.text() !== "swapped;action=a;key=k;other=y;otherKey=o") throw new Error("bad swapped");
                c.press(1, "n");
                if (c.text() !== "assigned;action=a;key=k") throw new Error("bad assigned");
                c.press(2, "q");
                if (c.text() !== "press;action=q") throw new Error("bad press");
                c.press(3, "q");
                if (c.text() !== "hint") throw new Error("bad reset");`,
);

check(
    "an-array-of-object-elements-keeps-their-identity",
    `
    interface Subject { x: number; radius: number; body?: object; bodies?: readonly object[] }
    interface Creature { x: number; mesh: { id: number } }
    const creatures: Creature[] = [{ x: 1, mesh: { id: 4 } }, { x: 2, mesh: { id: 5 } }];
    function subjectOf(index: number): Subject | null {
        const creature = creatures[index];
        if (!creature) return null;
        if (creature.x > 1) return { x: creature.x, radius: 1, bodies: creatures.map((each) => each.mesh) };
        return { x: creature.x, radius: 2, body: creature.mesh };
    }
    const first = subjectOf(0);
    const pair = subjectOf(1);
    if (!first || first.body !== creatures[0]!.mesh || first.bodies !== undefined) throw new Error("first");
    if (!pair?.bodies || pair.bodies.length !== 2 || pair.bodies[1] !== creatures[1]!.mesh) throw new Error("pair");
    if (pair.bodies.indexOf(creatures[0]!.mesh) !== 0 || pair.bodies.includes({ id: 4 })) throw new Error("identity");
    if (subjectOf(5) !== null) throw new Error("none");
`,
);

check(
    "a-record-or-an-array-of-records-is-a-union-of-the-two",
    `
    interface Ignore { readonly mesh: number; readonly instance?: number }
    interface Options { ignore?: Ignore | readonly Ignore[]; detailed?: boolean }
    interface Context { mesh: number }
    const footprints = new WeakMap<Context, Ignore | readonly Ignore[]>();
    function ignored(ignore: Ignore | readonly Ignore[] | undefined): number[] {
        if (!ignore) return [];
        const list: readonly Ignore[] = Array.isArray(ignore) ? ignore : [ignore as Ignore];
        return list.map((entry) => entry.mesh * 10 + (entry.instance ?? 0));
    }
    function project(ignore: Ignore | readonly Ignore[]): number {
        if (!Array.isArray(ignore)) return (ignore as Ignore).mesh;
        const source = ignore as readonly Ignore[];
        let total = 0;
        for (let i = 0; i < source.length; i++) total += source[i]!.mesh;
        return total;
    }
    const pick = (options?: Options): string => ignored(options?.ignore).join(",");
    const gate = new Float32Array([1]);
    const ctx: Context = { mesh: 4 };
    footprints.set(ctx, gate[0]! > 0 ? [{ mesh: 1 }, { mesh: 2, instance: 3 }] : { mesh: 9 });
    const single = pick({ ignore: { mesh: 5, instance: 1 } });
    const many = pick({ ignore: footprints.get(ctx) });
    const none = pick();
    const projected = project(footprints.get(ctx)!) * 100 + project({ mesh: 7 });
    if (single !== "51" || many !== "10,23" || none !== "" || projected !== 307) throw new Error(single + "|" + many + "|" + none + "|" + projected);
`,
);
