import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CompileError, compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

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
    "coalesce-record-lacking-fields",
    `
    interface City { x: number; y: number; size: number; name: string }
    const cities: City[] = [];
    if (Date.now() < 0) cities.push({ x: 1, y: 2, size: 3, name: "a" });
    const tiles: { x: number; y: number }[] = [];
    for (let i = 1; i < 4; i++) tiles.push({ x: i, y: i * 2 });
    // The checker types the result as City (its left is never nullish to
    // it); the fallback is the tile itself, which has no size.
    const start = cities[0] ?? tiles[1]!;
    if (start.x !== 2 || start.y !== 4) throw new Error("selected tile");
    if (start.size !== undefined || "size" in start) throw new Error("lacked field");
    start.x = 7;
    if (tiles[1]!.x !== 7) throw new Error("one object");
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

check(
    "overlapping-nullable-union-values-retain-array-length",
    `
    type R = { ok: false; a: string | null } | { ok: false; b: number } | { ok: true };
    const rs: R[] = [{ ok: false, a: null }, { ok: false, b: 1 }, { ok: true }];
    if (rs.length !== 3) throw new Error("n");
`,
);

test("overlapping nullable union membership refuses unrepresented arm fields", () => {
    const source = `
        type R = { ok: false; a: string | null } | { ok: false; b: number } | { ok: true };
        function describe(row: R): string {
            if (row.ok) return "ok";
            if ("a" in row) {
                if (!Object.hasOwn(row, "a") || Object.hasOwn(row, "b")) throw new Error("a own key");
                return row.a === null ? "null" : row.a;
            }
            if (Object.hasOwn(row, "a") || !Object.hasOwn(row, "b")) throw new Error("b own key");
            return String(row.b);
        }
        const observers: Array<typeof describe> = [describe];
        const rs: R[] = [{ ok: false, a: null }, { ok: false, b: 1 }, { ok: true }];
    `;
    const refuses = (observed: string): void => {
        runInNewContext(
            ts.transpileModule(observed, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        assert.throws(
            () => compileSource(observed),
            (error: unknown) =>
                error instanceof CompileError &&
                error.detail ===
                    "Own-property membership requires represented field 'a'.",
        );
    };
    refuses(
        source +
            `
            if (observers[0]!(rs[0]!) !== "null" || observers[0]!(rs[1]!) !== "1" ||
                observers[0]!(rs[2]!) !== "ok") throw new Error("union presence oracle");
        `,
    );
    for (const membership of [
        "Object.hasOwn(row, 'a')",
        "key in row",
        "Object.hasOwn(row, key)",
    ])
        refuses(`
            type R = { ok: false; a: string | null } | { ok: false; b: number } | { ok: true };
            const rs: R[] = [{ ok: false, a: null }, { ok: false, b: 1 }, { ok: true }];
            function observe(row: R, key: string): boolean { return ${membership}; }
            const observers: Array<typeof observe> = [observe];
            if (!observers[0]!(rs[0]!, 'a') || observers[0]!(rs[1]!, 'a') || observers[0]!(rs[2]!, 'a'))
                throw new Error("own null and missing arm keys differ");
        `);
});

check(
    "absent-value-asserted-present-and-passed-on",
    `
    function reach(packed: Float32Array, stride: number): number { const declared = Math.max(0, Math.trunc(packed[0] ?? 0)); return declared * stride; }
    function penReach(enclosures: Float32Array, pen: number): number { return reach(enclosures, 2) + pen; }
    function accessible(pen: number, enclosures?: Float32Array): boolean {
        if (pen === 0) return true;
        const r = penReach(enclosures!, pen);
        return r > 1;
    }
    const free = Math.random() >= 0 ? 0 : 1;
    if (!accessible(free)) throw new Error("unrestricted");
    if (!accessible(1 - free, new Float32Array([3, 0]))) throw new Error("present");
    let thrown = false;
    try { accessible(1 - free); } catch (error) { thrown = error instanceof TypeError; }
    if (!thrown) throw new Error("absent read");
`,
);

// One arm names a single literal, another a set of them, both optional:
// the field stores every arm's literals with the one empty state.
check(
    "union-field-with-different-optional-literals-across-arms",
    `
    type Structure = "cell" | "post" | "wall";
    interface Segment { structure?: Structure; run?: number }
    type Source =
        | { kind: "polygon"; index: number; structure?: "cell"; run?: number }
        | { kind: "segment"; index: number; structure?: Segment["structure"]; run?: number }
        | { kind: "blocker"; index: number }
        | { kind: "gap" };
    const flag = Math.random() >= 0;
    const sources = new Map<string, readonly Source[]>();
    const segments: Segment[] = [{ structure: flag ? "post" : "wall", run: 2 }, {}];
    function trace(key: string, found: readonly Source[]): void { sources.set(key, found.slice()); }
    trace("a", [{ kind: "polygon", index: 0, structure: "cell" }, { kind: "segment", index: 1, structure: segments[0]!.structure, run: segments[0]!.run }, { kind: "gap" }]);
    trace("b", [{ kind: "segment", index: 2, structure: segments[1]!.structure }, { kind: "blocker", index: 3 }]);
    const describe = (source: Source): string =>
        source.kind === "polygon" || source.kind === "segment"
            ? source.kind + ":" + source.index + ":" + (source.structure ?? "-") + ":" + (source.run ?? "-")
            : source.kind === "blocker"
              ? "blocker:" + source.index
              : source.kind;
    const out = (sources.get("a") ?? []).map(describe).join() + "|" + (sources.get("b") ?? []).map(describe).join();
    if (out !== "polygon:0:cell:-,segment:1:post:2,gap|segment:2:-:-,blocker:3") throw new Error(out);
    const posts = (sources.get("a") ?? []).filter((source) => source.kind === "segment" && source.structure === "post").length;
    if (posts !== 1) throw new Error("posts " + posts);
`,
);

check(
    "union-field-required-optional-and-absent-across-arms",
    `
    type Event = { kind: "birth"; where: number } | { kind: "death"; index: number; cause: number } | { kind: "debug"; index: number; cause?: number };
    function make(flag: number): Event {
        if (flag === 0) return { kind: "birth", where: 1 };
        if (flag === 1) return { kind: "death", index: 2, cause: 3 };
        return { kind: "debug", index: 4 };
    }
    const made = [make(Math.random() >= 0 ? 1 : 0), make(2), make(0)];
    let sum = 0;
    for (const event of made) sum += event.kind === "death" ? event.cause : event.kind === "debug" ? (event.cause ?? 10) : event.where;
    if (sum !== 14) throw new Error("sum " + sum);
`,
);

check(
    "absent-properties-of-records-whose-type-does-not-require-them",
    `
    type Outcome = { changed: true; id: number } | { changed: false; reason: "dimensions" | "lift" };
    const describe = (result: Outcome): string =>
        result.changed ? "made " + result.id : "refused " + (result.reason === "lift" ? "by lift" : result.reason);
    const made: Outcome = { changed: true, id: 7 };
    const refused: Outcome = { changed: false, reason: "lift" };
    function plain(value: any): any { return value !== null && typeof value === "object" ? value : {}; }
    function variants(raw: any, fallback: string[]): string[] {
        const fish = plain(plain(raw).fish);
        return fish.variants === undefined ? fallback : fish.variants;
    }
    // A keyed read and a destructuring read the absence as a member does.
    type Kind = "wood" | "pot" | "egg" | "beer";
    const TALLY_KEY: Readonly<Partial<Record<Kind, "logs" | "pots">>> = { wood: "logs", pot: "pots" };
    const tracker = { note(kind: Kind): string { const key = TALLY_KEY[kind]; return key === undefined ? "none" : key; } };
    function keyOf(input: number | undefined): number | undefined { return typeof input === "number" ? input : undefined; }
    function ids<T extends { id?: unknown }>(rows: readonly T[]): string {
        const projected = rows.map(({ id, ...row }) => ({ ...row, id: keyOf(id as number | undefined) }));
        return projected.map((row) => (row.id === undefined ? "new" : String(row.id))).join(",");
    }
    const text = [
        describe(made),
        describe(refused),
        variants({}, ["perch"]).join("+"),
        variants({ fish: { variants: ["carp", "pike"] } }, ["perch"]).join("+"),
        variants(null, ["perch"]).join("+"),
        tracker.note("wood"),
        tracker.note("beer"),
        ids([{ id: 2, v: "a" }, { v: "b" }]),
    ].join("|");
    if (text !== "made 7|refused by lift|perch|carp+pike|perch|logs|none|2,new") throw new Error(text);
`,
);

// An element read past the end falls back to a field a partial record
// assertion left optional; the fallback reads as the element's number.
check(
    "a-missed-element-falls-back-to-a-field-a-partial-assertion-left-optional",
    `
    interface Tower { id: string; yaw: number }
    const towers: Tower[] = [];
    const built: number[] = [];
    const tower = { id: "a" } as Tower;
    tower.yaw = new Float32Array([0.5])[0]!;
    towers.push(tower);
    const first = towers.every((t, index) => (built[index] ?? t.yaw) === t.yaw);
    if (!first) throw new Error("fallback");
    built[0] = 2;
    const second = towers.every((t, index) => (built[index] ?? t.yaw) === t.yaw);
    if (second) throw new Error("element");
`,
);

// A conditional whose arms generation knows absent selects the absence the
// taken arm gives: the one both give, its condition still run, or
// `undefined` against `null`.
check(
    "a-conditional-whose-arms-give-one-absence-is-that-absence",
    `
    const gate = new Float32Array([0, 1]);
    const off = gate[0]! > 0;
    const unset: { a?: unknown; b?: unknown } = {};
    const both = off ? unset.a : unset.b;
    if (both !== undefined || typeof both !== "undefined") throw new Error("undefined pair");
    const nulls = off ? null : null;
    if (nulls !== null) throw new Error("null pair");
    let runs = 0;
    const tick = (): boolean => ++runs > 1;
    const counted = tick() ? undefined : undefined;
    if (counted !== undefined || runs !== 1) throw new Error("condition effects " + runs);
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
    "selection-of-absent-members",
    `
    // A selection of two members a call omits is absent in that call; the
    // same body holds a value in the call that passes one.
    interface Cell { u: number; v: number; w: number; h: number }
    interface Options {
        name: string;
        cells?: { cells: readonly Cell[]; vFlip: boolean };
        map?: { cells: readonly Cell[]; vFlip: boolean; capacity: number; keySource: "a" | "b" };
    }
    function build(opts: Options): string {
        const cells = opts.cells;
        const map = opts.map;
        const mode = cells ?? map;
        const setup = mode ? "cells " + (cells ? "direct" : map ? map.keySource : "") : "";
        let total = 0;
        if (mode) {
            const count = Math.max(1, mode.cells.length);
            const data = new Float32Array((count + 1) * 4);
            data[0] = count;
            data[1] = mode.vFlip ? -1 : 1;
            const source = mode.cells.length ? mode.cells : [{ u: 0, v: 0, w: 1, h: 1 }];
            for (let i = 0; i < count; i++) {
                const cell = source[i]!;
                data.set([cell.u, cell.v, cell.w, cell.h], (i + 1) * 4);
            }
            total += data.length + data[1]!;
        }
        return opts.name + "[" + setup + "]" + total;
    }
    const plain = build({ name: "body" });
    const direct = build({ name: "cells", cells: { cells: [{ u: 0, v: 0, w: 1, h: 1 }], vFlip: true } });
    const keyed = build({ name: "map", map: { cells: [], vFlip: false, capacity: 4, keySource: "b" } });
    if (plain !== "body[]0" || direct !== "cells[cells direct]7" || keyed !== "map[cells b]9") throw new Error(plain + " " + direct + " " + keyed);
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
    "array-coalesced-with-a-record-into-a-record-or-array-parameter",
    `
    interface Frame { id: number; stations: number[] }
    const isFrameArray = (value: Frame | readonly Frame[]): value is readonly Frame[] => Array.isArray(value);
    const seen: number[] = [];
    const recordBodyFollow = (frames: Frame | readonly Frame[], sink: number | null): void => {
      const frameList = isFrameArray(frames) ? frames : [frames];
      const stations = isFrameArray(frames) ? frames.flatMap((frame) => frame.stations) : frames.stations;
      seen.push(frameList.length * 100 + stations.length + (sink ?? 0));
    };
    const requests: { frame: Frame }[][] = [[{ frame: { id: 1, stations: [1, 2] } }], [{ frame: { id: 2, stations: [3] } }, { frame: { id: 3, stations: [4, 5] } }]];
    for (const group of requests) {
      const first = group[0]!;
      const groupedFrames = group.length > 1 ? group.map((request) => request.frame) : null;
      recordBodyFollow(groupedFrames ?? first.frame, null);
    }
    if (seen.join(",") !== "102,203") throw new Error("frames " + seen.join(","));
`,
);

check(
    "found-element-coalesced-with-a-parsed-member",
    `
    interface Tower { yaw: number; x: number; name: string }
    const towers = JSON.parse('[{"yaw":1,"x":0,"name":"a"},{"yaw":2,"x":1,"name":"b"}]') as Tower[];
    const builtYaw: number[] = [];
    const builtName: string[] = ["c"];
    builtYaw[0] = 1;
    const ok = towers.every((t, index) => (builtYaw[index] ?? t.yaw) === t.yaw);
    let shift = 0, names = "";
    for (let i = 0; i < towers.length; i++) { const t = towers[i]!; shift += t.x - (builtYaw[i] ?? t.yaw); names += builtName[i] ?? t.name; }
    if (!ok || shift !== -2 || names !== "cb") throw new Error("coalesce " + ok + " " + shift + " " + names);
`,
);

check(
    "coalesced-literal-the-left-record-cannot-hold",
    `
    interface Result { code: string; quantity?: number; woodCost?: number }
    interface Outcome { handled: boolean; payload?: { quantity: number; woodCost?: number } }
    function run(o: Outcome): number {
        let payload: Pick<Result, "quantity" | "woodCost"> = {};
        if (o.handled) payload = o.payload ?? {};
        return (payload.quantity ?? -1) + (payload.woodCost ?? 0);
    }
    const outcomes: Outcome[] = [{ handled: true, payload: { quantity: 3, woodCost: 2 } }, { handled: true }, { handled: false }];
    if (run(outcomes[0]!) !== 5 || run(outcomes[1]!) !== -1 || run(outcomes[2]!) !== -1) throw new Error("payload");
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

for (const [index, body] of [
    "list.push(make(1)); const read = readB(list[0]!);",
    "const read = readB(list[0]!); list.push(make(1));",
    "list.push(make(1)); const mids: { a: number; z?: string }[] = []; for (const item of list) mids.push(item); const read = readB(mids[0]!);",
    "list.push(make(1)); function bOf({ b }: View): number { return b ?? -1; } const read = bOf(list[0]!);",
    "list.push(make(1)); const views: readonly View[] = list; let read = 0; for (const { b } of views) read += b ?? -1;",
].entries()) {
    const declarations = `
    interface Narrow { a: number }
    interface View { a: number; b?: number }
    function readB(v: View): number { return v.b ?? -1; }
    function make(a: number): { a: number; b: number } { return { a, b: a * 2 }; }
    const list: Narrow[] = [{ a: 3 }];
    `;
    check(
        `converted-record-property-presence-${index}`,
        declarations +
            body +
            `
            if (read !== ${index === 4 ? 1 : -1} || readB(list[1]!) !== 2)
                throw new Error("converted field");
            if ("b" in list[0]! || !("b" in list[1]!)) throw new Error("own presence");
        `,
    );
}

check(
    "asserted-optional-record-property-keeps-absence",
    `
            interface Source { a: number; b?: number }
            interface Shape { a: number }
            function make(): Shape { return { a: 1 }; }
            const read = (make() as Source).b;
            if (read !== undefined || "b" in make()) throw new Error("absent field");
    `,
);

check(
    "stored-unknown-parameters-take-absent-values-and-empty-objects",
    `
    function classify(x: unknown): string {
        if (x === undefined) return "u";
        if (x === null) return "n";
        if (typeof x === "object") return "o" + Object.keys(x).length;
        return typeof x;
    }
    const classifiers: Array<(x: unknown) => string> = [classify];
    const text = classifiers[0]!(undefined) + classifiers[0]!(null) + classifiers[0]!({}) + classifiers[0]!(5) + classifiers[0]!({ a: 1 });
    if (text !== "uno0numbero1") throw new Error("absent values and empty objects " + text);
    let looped = "";
    for (let i = 0; i < 2; i++) looped += classifiers[0]!(i === 0 ? null : undefined);
    if (looped !== "nu") throw new Error("absent union argument " + looped);
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
    "optional-literal-unions-compare-by-spelling",
    `
    type Trade = "none" | "priest" | "baker" | "smith";
    type Operator = "priest" | "baker" | "witch";
    type Site = "church" | "mill" | "tower" | "forge";
    interface Claimant { id: number; trade: Trade; }
    interface Plate { site: Site; claimant: Claimant | null; }
    const OPERATOR: Readonly<Partial<Record<Site, Operator>>> = { church: "priest", mill: "baker", tower: "witch" };
    function claimed(plate: Plate): string {
        const operator = OPERATOR[plate.site] ?? null;
        return String(plate.claimant?.trade === operator) + "/" + String(plate.claimant?.trade !== operator);
    }
    const plates: Plate[] = [
        { site: "church", claimant: { id: 1, trade: "priest" } },
        { site: "mill", claimant: { id: 2, trade: "priest" } },
        { site: "forge", claimant: null },
        { site: "forge", claimant: { id: 3, trade: "smith" } },
        { site: "tower", claimant: null },
        { site: "church", claimant: { id: 4, trade: "none" } },
    ];
    const seen = plates.map(claimed);
    if (seen.join(",") !== "true/false,false/true,false/true,false/true,false/true,false/true") throw new Error(seen.join(","));
    const gate = new Float32Array([0, 1]);
    const off = gate[0]! > 0;
    const missingTrade: Trade | undefined = off ? "priest" : undefined;
    const missingOperator: Operator | undefined = off ? "priest" : undefined;
    const nullOperator: Operator | null = off ? "priest" : null;
    const trade: Trade | null = gate[1]! > 0 ? "baker" : null;
    const operator: Operator | undefined = gate[1]! > 0 ? "baker" : undefined;
    const label: string | undefined = gate[1]! > 0 ? "baker" : undefined;
    const pairs = [missingTrade === missingOperator, missingTrade === nullOperator, trade === operator, label === operator, operator !== label, label === missingOperator];
    if (pairs.map((flag) => String(flag)).join(",") !== "true,false,true,true,false,false") throw new Error(pairs.map((flag) => String(flag)).join(","));
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
    "Object.assign onto a fresh literal copies a struct's optional keys as the run holds them",
    `
    interface M { a?: number; b?: string }
    const ms: M[] = [{ a: 1 }, { b: "x" }, {}];
    const out = ms.map((m) => JSON.stringify(Object.assign({}, m))).join("|");
    if (out !== '{"a":1}|{"b":"x"}|{}') throw new Error(out);
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

check(
    "a-type-parameter-can-be-determined-by-its-declared-default",
    `function count<T = number>(): number { const xs: T[] = []; return xs.length; }
     if (count() !== 0) throw new Error("default type");`,
);

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

// An optional member holding a function with properties is called only
// while present, through an optional owner too.
checkInRealm(
    "an optional callable record member calls only when present",
    `
    type Source = (() => number) & { onResize?: (callback: () => void) => () => void };
    const listeners: (() => void)[] = [];
    function makeSource(value: number): Source {
        return Object.assign(() => value, {
            onResize: (callback: () => void): (() => void) => {
                listeners.push(callback);
                return () => listeners.splice(listeners.indexOf(callback), 1);
            },
        });
    }
    function bind(sources: readonly (readonly [number, Source])[]): number {
        let total = 0;
        for (const [slot, source] of sources) {
            total += slot * source();
            source.onResize?.(() => {});
        }
        return total;
    }
    function outline(opts?: { sceneDepth?: Source }): number {
        return bind([
            [1, makeSource(2)],
            [2, Object.assign(() => opts?.sceneDepth?.() ?? 7, { onResize: opts?.sceneDepth?.onResize })],
        ]);
    }
    const withDepth = outline({ sceneDepth: makeSource(Math.random() < 2 ? 0.25 : 1) });
    const without = outline();
    if (withDepth !== 2.5 || without !== 16 || listeners.length !== 3) throw new Error("sources " + withDepth + " " + without + " " + listeners.length);
    globalThis.close();
    `,
);

check(
    "a parsed document compares with a member an optional parameter may lack",
    `
    interface Line { key: string; state?: string | null }
    interface Selection { key: string | null; onSelect?: (key: string) => void }
    const lines = JSON.parse('[{"key":"a","state":null},{"key":"b"}]') as Line[];
    function pick(copy: readonly Line[], selection?: Selection): string {
        const current = copy.find((line) => line.key === selection?.key) ?? copy[0];
        return current?.key ?? "-";
    }
    const keys: (string | null)[] = [null, "b"];
    let picked = pick(lines) + ",";
    for (const key of keys) picked += pick(lines, { key }) + ",";
    if (picked !== "a,a,b,") throw new Error("picked " + picked);
    `,
);

check(
    "an optional chain skips an element call on an absent owner",
    `
    const pick = (present: boolean): Record<string, () => number> | undefined => (present ? { m: () => 1 } : undefined);
    const k = "m";
    const absent = pick(Math.random() > 2)?.[k]();
    const present = pick(Math.random() < 2)?.[k]();
    const lists: (() => number)[] | undefined = Math.random() > 2 ? [() => 2] : undefined;
    const none = lists?.[0]();
    if (absent !== undefined || present !== 1 || none !== undefined) throw new Error("optional element call " + absent + " " + present + " " + none);
    `,
);

check(
    "a coalesce chain reads a key missing from a dictionary as absent",
    `
    type Dict = Record<string, string>;
    const EN: Dict = { greet: "Hello", bye: "Bye" };
    const FR: Dict = { greet: "Bonjour" };
    const TABLES: Record<"en" | "fr", Dict> = { en: EN, fr: FR };
    let lang: "en" | "fr" = "en";
    lang = Math.random() > 2 ? "en" : "fr";
    function t(key: string): string { return TABLES[lang][key] ?? EN[key] ?? key; }
    if (t("greet") !== "Bonjour" || t("bye") !== "Bye" || t("missing") !== "missing")
        throw new Error("chain " + t("bye") + " " + t("missing"));
    `,
);

check(
    "an element read the source tests for absence, on every owner kind",
    `
    function local(i: number): number { const L = [3, 0, 5]; return L[i] ?? 9; }
    function truthy(i: number): number { const L = [3, 0, 5]; return L[i] || 7; }
    function present(i: number): boolean { const L = [3, 4, 5]; return L[i] !== undefined; }
    function kind(i: number): string { const L = [3, 4, 5]; return typeof L[i]; }
    function table(i: number, j: number): number { const T = [[1, 2], [3, 4]]; return T[i]?.[j] ?? 9; }
    const rows: number[][] = [];
    rows.push([1, 2], [3, 4]);
    function vectorRows(i: number, j: number): number { return rows[i]?.[j] ?? 9; }
    let out = 1;
    for (let k = 0; k < 2; k++) out += 2;
    const results = [local(out), local(1), truthy(out), truthy(1), truthy(2), table(out, 0), table(1, 1), table(0, out), vectorRows(out, 0), vectorRows(1, 1)];
    if (results.join() !== "9,0,7,7,5,9,4,9,9,4" || present(out) || !present(0) || kind(out) !== "undefined" || kind(0) !== "number")
        throw new Error("absent elements " + results.join() + kind(out));
    `,
);
