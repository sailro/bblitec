import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runGeneratedProgram } from "./native-fixture.js";
import { check, checkInRealm, native } from "./language-constructs.js";

check(
    "an-asserted-number-runs-its-operand-once",
    `
    // A call whose result is asserted a number, in a compound assignment,
    // an argument and an operand: each read runs the call once.
    let calls = 0;
    function pick(flag: boolean): number | string {
        calls++;
        for (let i = 0; i < 1; i++) if (flag) return 1;
        return 2;
    }
    const flags = JSON.parse("[true,false]") as boolean[];
    let total = 0;
    for (const flag of flags) total += pick(flag) as number;
    let largest = 0;
    for (const flag of flags) largest = Math.max(largest, pick(flag) as number);
    const scaled = (pick(true) as number) * 3;
    if (total !== 3 || largest !== 2 || scaled !== 3 || calls !== 5)
        throw new Error("calls " + calls + " " + total + " " + largest + " " + scaled);
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

// A shared instance's stored array field is viewed by numeric index as that
// array.
check(
    "stored-field-arrays-viewed-by-numeric-index",
    `
    class Shift {
        private dx = 0;
        private readonly scratch: [number, number, number] = [0, 0, 0];
        private readonly lanes: number[] = [0];
        get offset(): number { return this.dx; }
        get lane(): number { return this.lanes[0]!; }
        set(dx: number): void { this.dx = dx; }
        relativeTo(base: Shift, out: Shift): void {
            this.point(this.scratch, 1, base.dx);
            this.point(this.lanes, 0, base.dx);
            out.set(this.scratch[1] - base.dx);
        }
        point(out: { [index: number]: number }, offset: number, x: number): void { out[offset] = x + this.dx; }
    }
    const shifts: Shift[] = [new Shift(), new Shift(), new Shift()];
    shifts[0]!.set(5);
    shifts[1]!.set(2);
    shifts[0]!.relativeTo(shifts[1]!, shifts[2]!);
    if (shifts[2]!.offset !== 5 || shifts[0]!.lane !== 7) throw new Error("a stored field's array viewed by index");
`,
);

check(
    "optional-number-coerced-tells-null-from-undefined",
    `
    interface Rec { born: number; expires?: number | null; policy: "durable" | "fresh" }
    function normalize(record: Rec): number | null {
        const born = Math.max(0, Math.trunc(record.born));
        return record.policy === "durable" ? null : Number.isFinite(record.expires) ? Math.max(1, Math.trunc(record.expires!)) : born + 1;
    }
    const records: Rec[] = [{ born: 2, policy: "fresh" }, { born: 3, expires: 7.5, policy: "fresh" }, { born: 1, expires: null, policy: "fresh" }, { born: 1, expires: 4, policy: "durable" }];
    const out = records.map((record) => String(normalize(record))).join(",");
    if (out !== "3,7,2,null") throw new Error(out);
    const absent = records.map((record) => String(Math.trunc(record.expires!))).join(",");
    if (absent !== "NaN,7,0,4") throw new Error(absent);
`,
);

// The record stored closures share is materialized; its optional numbers
// keep the values generation knows, which the static `??` fold selects.
check(
    "optional-number-of-a-materialized-record-with-a-default",
    `
    interface Spec { homeX: number; race?: number; surfaceId?: number; surfaceY?: number }
    interface State { race: Int8Array; surfaceId: Int32Array; surfaceY: Float32Array; homeX: Float32Array }
    function createState(count: number): State {
        return { race: new Int8Array(count), surfaceId: new Int32Array(count), surfaceY: new Float32Array(count), homeX: new Float32Array(count) };
    }
    function addAt(state: State, i: number, spec: Spec): number {
        state.homeX[i] = spec.homeX;
        state.race[i] = spec.race ?? -1;
        state.surfaceId[i] = spec.surfaceId ?? -1;
        state.surfaceY[i] = spec.surfaceY ?? 0;
        return i;
    }
    function sanitize(spec: Spec): Spec { return { ...spec, homeX: Number.isFinite(spec.homeX) ? spec.homeX : 0 }; }
    function pack(specs: readonly Spec[]): Float32Array {
        const out = new Float32Array(specs.length * 3);
        for (let i = 0; i < specs.length; i++) {
            const s = sanitize(specs[i]!);
            out[i * 3] = s.homeX;
            out[i * 3 + 1] = s.race ?? -1;
            out[i * 3 + 2] = s.surfaceId ?? -1;
        }
        return out;
    }
    const spec: Spec = { homeX: 1, race: 2, surfaceId: 10002, surfaceY: 1.5 };
    const tests: (() => void)[] = [];
    tests.push(() => {
        const packed = pack([spec]);
        if (packed[1] !== 2 || packed[2] !== 10002) throw new Error("packed");
    });
    tests.push(() => {
        const state = createState(1);
        addAt(state, 0, spec);
        if (state.race[0] !== 2 || state.surfaceId[0] !== 10002 || state.surfaceY[0] !== 1.5) throw new Error("restored");
    });
    tests.push(() => {
        const state = createState(1);
        const fresh = { ...spec, surfaceId: undefined, surfaceY: undefined };
        addAt(state, 0, fresh);
        if (state.race[0] !== 2 || state.surfaceId[0] !== -1 || state.surfaceY[0] !== 0) throw new Error("fresh");
    });
    for (const test of tests) test();
`,
);

// A callback's `[key, value]` of two numbers is a stored number tuple; a
// Map built from the mapped list takes each as an entry.
check(
    "map-built-from-number-entries-a-callback-returns",
    `
    interface CellRun { cellIndex: number; run: number }
    const flag = Math.random() >= 0;
    const records: CellRun[] = [{ cellIndex: flag ? 4 : 0, run: 0 }, { cellIndex: 6, run: 1 }];
    const byIndex = new Map(records.map((cell) => [cell.cellIndex, cell.cellIndex]));
    if (byIndex.size !== 2 || byIndex.get(4) !== 4 || byIndex.get(6) !== 6 || byIndex.get(5) !== undefined) throw new Error("same");
    const runOf = new Map(records.map((cell) => [cell.cellIndex, cell.run] as const));
    const named = new Map<string, CellRun>(records.map((cell) => ["h" + cell.cellIndex, cell]));
    if (runOf.get(6) !== 1 || runOf.get(4) !== 0 || named.get("h4")!.run !== 0 || named.size !== 2) throw new Error("entries");
    let sum = 0;
    for (const [index, run] of runOf) sum += index * 10 + run;
    if (sum !== 101) throw new Error("iterated " + sum);
`,
);

// A parsed number list assigned to a declared number list is stored as the
// list sink stores it.
check(
    "parsed-number-list-assigned-to-a-declared-number-list",
    `
    interface Point { position: number[]; look?: number[] }
    interface Path { points: Point[]; lookAt?: number[] }
    const flag = Math.random() >= 0;
    const path = JSON.parse(flag ? '{"points":[{"position":[1,2,3]},{"position":[4,5,6],"look":[7,8,9]}],"lookAt":[10,11,12]}' : '{"points":[]}') as Path;
    function aim(p: Path, index: number, locked: boolean): number {
        const lookAt = locked ? p.lookAt : undefined;
        let target: readonly number[];
        if (lookAt) {
            target = lookAt;
        } else {
            const point = p.points[index]!;
            target = point.look ?? point.position;
        }
        return target[0]! + target[1]! + target[2]!;
    }
    if (aim(path, 0, true) !== 33 || aim(path, 0, false) !== 6 || aim(path, 1, false) !== 24) throw new Error("aim");
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
    "unary-numeric-json",
    `
    interface Rig { readonly axis: readonly [number, number, number]; readonly offset: number; readonly text: number; }
    const rig = JSON.parse('{"axis":[1,-2,0.5],"offset":3,"text":"4"}') as Rig;
    const flipped = { x: -rig.axis[0] * rig.offset, y: +rig.axis[1], z: -rig.axis[2] };
    if (flipped.x !== -3 || flipped.y !== -2 || flipped.z !== -0.5) throw new Error("unary over parsed lanes");
    if (-rig.text !== -4 || +rig.text !== 4) throw new Error("unary applies ToNumber to a parsed string");
`,
);

checkInRealm(
    "structured-clone-rest-records-options-and-errors",
    `
    interface Pose { readonly x: number; readonly yaw: number }
    interface Placement {
        readonly host?: { readonly handle: { readonly id: number }; readonly bake: Readonly<Pose>; readonly localY?: number };
        readonly key: string;
        readonly child: "house" | "tower";
        readonly cx: number;
        readonly halfW?: number;
        readonly materialId?: string;
        readonly uvMul?: number;
        readonly tint?: readonly [number, number, number];
        readonly parent?: { readonly x: number; readonly minY: number; readonly footprint: { readonly shape: "rect"; readonly halfW: number } | { readonly shape: "circle"; readonly radius: number } };
    }
    const placements: Placement[] = [
        { key: "house:7", child: "house", cx: 2, materialId: "m", tint: [1, 0.5, 0.25], uvMul: 2, host: { handle: { id: 3 }, bake: { x: 1, yaw: 0.5 } }, parent: { x: 4, minY: 1, footprint: { shape: "circle", radius: 2 } } },
        { key: "tower:3", child: "tower", cx: 5, halfW: 2 },
    ];
    const copies = placements.map((placement) => {
        const { materialId: _material, tint: _tint, uvMul: _uv, ...bake } = placement;
        return { key: placement.key, bake: structuredClone(bake) };
    });
    const house = copies[0]!.bake;
    const tower = copies[1]!.bake;
    if (house.key !== "house:7" || house.child !== "house" || house.host!.bake.yaw !== 0.5 || house.host === placements[0]!.host || house.parent!.minY !== 1 || house.parent!.footprint.shape !== "circle") throw new Error("house");
    if (tower.host !== undefined || "host" in tower || "materialId" in tower || tower.halfW !== 2) throw new Error("tower");
    const options = structuredClone({ n: 1 }, { transfer: [] });
    const absent = structuredClone([1, 2], undefined);
    if (options.n !== 1 || absent[1] !== 2) throw new Error("options");
    interface Holder { f?: () => number; n: number }
    const holder: Holder = { n: 1, f: () => 2 };
    let failed = "";
    try { structuredClone(holder); failed += "no-throw;"; } catch (error) { if (!(error instanceof DOMException) || error.name !== "DataCloneError") failed += "kind;"; }
    let reads = 0;
    const getter = { get value(): number { ++reads; return 4; } };
    const copied = structuredClone(getter);
    if (copied.value !== 4 || copied.value !== 4 || reads !== 1) failed += "getter;";
    if (failed) throw new Error(failed);
    globalThis.close();
`,
);

test("a global-object member the program adds is window realm state", () => {
    const result = compileSource(
        `const g = globalThis as { __count?: number };
        if (!(g.__count === undefined)) throw new Error("absent member");
        g.__count = 1;`,
    );
    assert.match(result.cpp, /bbl::dom_window_property</);
});

test("a global-object member only a host page could install reads absent", () => {
    const result = compileSource(
        `const g = globalThis as { bridge?: { send(text: string): void } };
        if (g.bridge !== undefined) throw new Error("installed bridge");`,
    );
    assert.doesNotMatch(result.cpp, /bbl::dom_window_property</);
});

test("a global-object member nothing declares reads absent through an index signature", () => {
    const result = compileSource(
        `const params = new URLSearchParams(location.search);
        const rows = params.has("debug") ? new Map<string, number>() : null;
        if (rows) (window as unknown as Record<string, unknown>).hook = { calls: rows.size };
        const hook = (window as unknown as Record<string, unknown>).hook as { calls: number } | undefined;
        if (hook) throw new Error("installed hook");`,
    );
    assert.doesNotMatch(result.cpp, /installed hook|bbl::dom_window_property</);
});

test("a global-object member another function writes under a ?debug flag reads absent", () => {
    // The flag is the builder's own const, which deciding the write reads
    // outside the builder's scope.
    const result = compileSource(
        `async function build(): Promise<number> {
            const params = new URLSearchParams(location.search);
            const rows = params.has("debug") ? new Map<string, number>() : null;
            if (rows) (window as unknown as Record<string, unknown>).hook = { calls: rows.size };
            return 1;
        }
        async function main(): Promise<void> {
            const built = await build();
            const hook = (window as unknown as Record<string, unknown>).hook as { calls: number } | undefined;
            if (hook) throw new Error("installed hook");
            console.log(built);
        }
        void main();`,
    );
    assert.doesNotMatch(result.cpp, /installed hook|bbl::dom_window_property</);
});

test("a global-object member a library declares never reads absent through an index signature", () => {
    for (const name of ["document", "Promise"])
        assert.throws(
            () =>
                compileSource(
                    `const member = (window as unknown as Record<string, unknown>).${name};
                    if (member === undefined) throw new Error("absent member");`,
                ),
            /Browser-dependent condition cannot be determined/,
        );
});

checkInRealm(
    "an-authored-error-a-dynamic-slot-holds-is-the-error-it-is",
    `
    class Failure extends Error {
        readonly reason: string;
        visible = 3;
        constructor(reason: string) {
            super("failed: " + reason);
            this.name = "Failure";
            this.reason = reason;
        }
    }
    interface Report {
        kind: string;
        error: unknown;
    }
    function readString(obj: unknown, key: string): string {
        if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return "";
        const value = (obj as Record<string, unknown>)[key];
        return typeof value === "string" ? value : typeof value === "number" ? \`\${value}\` : "";
    }
    const reports: Report[] = [];
    function funnel(input: Report): string {
        reports.push(input);
        const error = input.error;
        const parts = [readString(error, "message"), readString(error, "name"), readString(error, "reason"), readString(error, "visible"), readString(error, "stackless")];
        return parts.join("|") + (error instanceof Error ? ";error" : "") + (error instanceof Failure ? ";failure" : "") + ";" + typeof error;
    }
    const failure = new Failure("timeout");
    let log = funnel({ kind: "boot", error: failure });
    const held = reports[0]!.error;
    failure.visible = 4;
    log += "/" + readString(held, "visible") + (held === failure ? ";same" : ";other");
    log += "/" + JSON.stringify(held) + "/" + Object.keys(held as object).join(",");
    log += "/" + (held as Failure).reason;
    log += "/" + funnel({ kind: "plain", error: "text" });
    const expected = 'failed: timeout|Failure|timeout|3|;error;failure;object/4;same/{"reason":"timeout","visible":4,"name":"Failure"}/reason,visible,name/timeout/||||;string';
    if (log !== expected) throw new Error("log " + log);
    globalThis.close();
`,
);

test("an authored error a dynamic slot holds refuses a name its view cannot place", () => {
    const held = (classes: string, after = ""): string => `
    ${classes}
    const slots: { error: unknown }[] = [{ error: "text" }];
    const failure = new Failure("x");
    slots.push({ error: failure });
    ${after}
    export {};`;
    for (const source of [
        // A base class names it before a subclass creates its fields.
        held(`class Base extends Error { constructor(m: string) { super(m); this.name = "Base"; } }
              class Failure extends Base { code = 1; }`),
        held(
            `class Failure extends Error { constructor(m: string) { super(m); } }`,
            `failure.name = "Renamed";`,
        ),
    ])
        assert.throws(
            () => compileSource(source),
            /owns 'name' only where its class's constructor assigns it as a statement/,
        );
});

check(
    "stored-number-formats-at-run-time",
    `
    interface Saved { ax: number; yaw: number }
    const saved = JSON.parse('{"ax":1.235,"yaw":0.5}') as Saved;
    const rounded = [+saved.ax.toFixed(2), +saved.yaw.toFixed(3)];
    if (rounded.join() !== "1.24,0.5" || saved.yaw.toFixed(1) !== "0.5") throw new Error("formatted " + rounded.join());
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

test("a constant numeric table of frozen rows supports runtime indexing", () => {
    // `Object.freeze(row)` is the row itself, so the table's rows are the
    // literals its shape test reads.
    const result = compileSource(`
        const CELLS: readonly (readonly [number, number, number, number])[] = Object.freeze([
            Object.freeze([0, 0, 0.5, 0.5] as const),
            Object.freeze([0.5, 0, 0.5, 0.5] as const),
        ]);
        const cell = CELLS[Math.random() < 0.5 ? 0 : 1]!;
        if (cell[2] !== 0.5) throw new Error("frozen table row");
    `);
    assert.match(
        result.cpp,
        /\{\{\{0\.0, 0\.0, 0\.5, 0\.5\}, \{0\.5, 0\.0, 0\.5, 0\.5\}\}\}/,
    );
});

check(
    "error-subclass-holding-an-unknown-cause-built-at-two-sites",
    `
    class BakeError extends Error {
      constructor(readonly stage: "body" | "gable", readonly cause: unknown) {
        super(stage === "body" ? "body failed" : "gable failed");
      }
    }
    const caught: string[] = [];
    function bake(stage: "body" | "gable", fail: boolean): void {
      if (stage === "body") {
        try {
          if (fail) throw new Error("inner " + stage);
        } catch (e) {
          throw new BakeError("body", e);
        }
        return;
      }
      try {
        if (fail) throw new Error("inner " + stage);
      } catch (e) {
        throw new BakeError("gable", e);
      }
    }
    for (const [stage, fail] of [["body", true], ["gable", true], ["body", false]] as const) {
      try { bake(stage, fail); caught.push("ok"); } catch (e) {
        if (e instanceof BakeError) caught.push(e.stage + ":" + (e.cause instanceof Error ? e.cause.message : "?"));
      }
    }
    if (caught.join(",") !== "body:inner body,gable:inner gable,ok") throw new Error("cause " + caught.join(","));
`,
);

check(
    "math-min-and-max-over-a-spread-of-parsed-numbers",
    `
    interface Config { speedStops: number[] }
    const config = JSON.parse('{"speedStops":[0.5,2,4]}') as Config;
    const finiteStops = config.speedStops.filter((stop) => Number.isFinite(stop));
    const minimumSpeed = finiteStops.length > 0 ? Math.max(0.1, Math.min(...finiteStops)) : 0.1;
    const maximumSpeed = finiteStops.length > 0 ? Math.min(5, Math.max(...finiteStops)) : 5;
    if (minimumSpeed !== 0.5 || maximumSpeed !== 4) throw new Error("speed " + minimumSpeed + " " + maximumSpeed);
`,
);

check(
    "object-is-on-nullable-numbers",
    `
    interface Request { runId: number; bedSink: number | null }
    const requests: Request[] = [{ runId: 1, bedSink: null }, { runId: 1, bedSink: NaN }, { runId: 2, bedSink: 0 }, { runId: 2, bedSink: -0 }, { runId: 3, bedSink: null }];
    const same = (a: Request, b: Request): boolean => Object.is(a.bedSink, b.bedSink);
    const answers = [same(requests[0]!, requests[4]!), same(requests[1]!, requests[1]!), same(requests[2]!, requests[3]!), same(requests[0]!, requests[2]!), same(requests[2]!, requests[2]!)];
    if (answers.join(",") !== "true,true,false,false,true") throw new Error("same value " + answers.join(","));
`,
);

check(
    "compound-assignment-to-a-nullable-number-past-its-guard",
    `
    const ys = new Map<string, number>([["a", 2]]);
    const groundYAt = (key: string): number | null => ys.get(key) ?? null;
    const doors = [1, 3, 2];
    function lift(key: string, raise: number): number | null {
        let datum: number | null = null;
        for (const d of doors) {
            const y = d > 2 ? groundYAt(key) : null;
            if (y !== null && (datum === null || y < datum)) datum = y;
        }
        datum = datum ?? groundYAt(key);
        if (datum === null) return null;
        datum += raise;
        datum *= 2;
        datum **= 1;
        return datum;
    }
    const from = ys.get("a")!;
    if (lift("a", 0.5) !== 5 || lift("b", 1) !== null || ys.get("a") !== from) throw new Error("lift " + lift("a", 0.5));
`,
);

check(
    "date-now-as-a-function-value",
    `
    interface Deps { stamp?: () => number }
    function make(deps: Deps): () => number {
        const stamp = deps.stamp ?? Date.now;
        return () => stamp();
    }
    const fixed = make({ stamp: () => 7 });
    const live = make({});
    const now = Date.now;
    const first = live();
    if (fixed() !== 7 || !(first > 1e12) || !(now() >= first)) throw new Error("clock " + first);
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
    "number array reads past the end are undefined to arithmetic, comparisons and tests",
    `
    class Slots {
        private readonly members: number[] = [];
        add(slot: number): void { this.members[slot] = 1; }
        has(slot: number): boolean { return this.members[slot]! > 0; }
    }
    function main(): void {
        const slots = new Slots();
        slots.add(0);
        if (!slots.has(0) || slots.has(1)) throw new Error("asserted comparison past the end");
        const values: number[] = [3];
        const floats = new Float32Array(2);
        const pair: [number, number] = [1, 2];
        let at = 2;
        let text = String(values[at]! + 1) + (values[at]! * 2) + (values[at]! <= 0) + (values[at]! >= 0);
        text += "," + (values[at]! === 3) + (values[at]! !== 3) + (values[at]! == 3) + -values[at]! + ~values[at]! + (values[at]! | 0) + !values[at]!;
        text += "," + (values[at]! || 7) + (values[at]! ? "t" : "f") + (floats[at]! < 1) + (floats[at]! + 1) + (pair[at]! > 0) + (pair[at - 1]! + 1);
        let sum = 1;
        sum += values[at]!;
        let bits = 5;
        bits |= values[at]!;
        text += "," + sum + bits + (values[0]! + 1);
        if (values[at]!) throw new Error("truthy past the end");
        while (values[at]!) throw new Error("a loop test past the end");
        if (text !== "NaNNaNfalsefalse,falsetruefalseNaN-10true,7ffalseNaNfalse3,NaN54") throw new Error(text);
        at = 0;
        if (values[at]! + 1 !== 4 || !(values[at]! > 2)) throw new Error("in range");
    }
    main();
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
    "optional-chained-number-methods",
    `
    // value?.toFixed(n) and value?.toString() run on a present number and
    // are undefined otherwise; their arguments run only when it is present.
    interface Row { y?: number }
    let precisions = 0;
    function precision(): number { precisions++; return 3; }
    function sig(key: string, crown: number | undefined, reserve: number | null, row: Row): string {
        return key + "|cy" + (crown?.toFixed(precision()) ?? "") + "|r" + (reserve?.toFixed(2) ?? "none") +
            "|y" + (row.y?.toFixed() ?? "-") + "|s" + (crown?.toString() ?? "?") + "|x" + (reserve?.toString(16) ?? "?");
    }
    const crowns: (number | undefined)[] = [1.23456, undefined];
    const reserves: (number | null)[] = [255.5, null];
    const rows: Row[] = [{ y: 7.6 }, {}];
    const out: string[] = [];
    for (let i = 0; i < 2; i++) out.push(sig("k" + i, crowns[i], reserves[i]!, rows[i]!));
    if (out.join(";") !== "k0|cy1.235|r255.50|y8|s1.23456|xff.8;k1|cy|rnone|y-|s?|x?") throw new Error(out.join(";"));
    if (precisions !== 1) throw new Error("precision evaluated " + precisions);
    const formatted = crowns.map((crown) => crown?.toFixed(1));
    if (formatted[0] !== "1.2" || formatted[1] !== undefined) throw new Error("chain value");
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
    "date-utc-field-setters",
    `
    const when = new Date(Date.UTC(2020, 0, 15, 10, 20, 30, 400));
    const first = when.setUTCFullYear(2001);
    when.setUTCMonth(5, 2);
    when.setUTCHours(23, 59);
    when.setUTCSeconds(1, 2);
    when.setUTCMilliseconds(999);
    when.setUTCMinutes(7);
    when.setUTCDate(31);
    if (when.toISOString() !== "2001-07-01T23:07:01.999Z" || first !== Date.UTC(2001, 0, 15, 10, 20, 30, 400))
        throw new Error("setters " + when.toISOString());
    const early = new Date(0);
    early.setUTCFullYear(50);
    const invalid = new Date(NaN);
    const hours = invalid.setUTCHours(1);
    invalid.setUTCFullYear(2000);
    if (early.getUTCFullYear() !== 50 || !Number.isNaN(hours) || invalid.getUTCFullYear() !== 2000 || invalid.getUTCMonth() !== 0)
        throw new Error("year and invalid time");
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
    "calling-an-absent-function-value-throws-a-type-error",
    `
    const handlers = new Map<string, () => number>();
    handlers.set("one", () => 1);
    function kindOf(run: () => void): string {
        try {
            run();
            return "none";
        } catch (error) {
            return error instanceof TypeError ? "type" : "other";
        }
    }
    if (kindOf(() => { handlers.get("one")!(); }) !== "none") throw new Error("present handler");
    if (kindOf(() => { handlers.get("missing")!(); }) !== "type") throw new Error("absent map handler");
    interface Hooks { done?: (value: number) => void }
    const hooks: Hooks[] = [{}, { done: () => {} }];
    if (kindOf(() => { hooks[0]!.done!(3); }) !== "type") throw new Error("absent optional field");
    if (kindOf(() => { hooks[1]!.done!(3); }) !== "none") throw new Error("present optional field");
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

check(
    "tagged-union-arms-hold-symbol-fields",
    `
    type Outcome = { kind: "hit"; token: symbol } | { kind: "miss" };
    const hitToken = Symbol("hit");
    function outcome(hit: boolean): Outcome {
        return hit ? { kind: "hit", token: hitToken } : { kind: "miss" };
    }
    const first = outcome(Date.now() > 0);
    if (first.kind !== "hit" || first.token !== hitToken || first.token.description !== "hit") throw new Error("symbol arm");
    if (outcome(false).kind !== "miss") throw new Error("miss arm");
`,
);

check(
    "numeric-logical-operators-and-array-membership",
    `
    const L = [3, 0, 5];
    let calls = 0;
    function next(): number { calls++; return 7; }
    function pick(i: number): number { return (L[i] && 1) || 2; }
    let far = 1;
    for (let k = 0; k < 2; k++) far += 2;
    const either = L[0]! || next();
    const both = L[1]! && next();
    if (pick(0) !== 1 || pick(1) !== 2 || pick(far) !== 2 || either !== 3 || both !== 0 || calls !== 0)
        throw new Error("logical " + calls);
    if (!(1 in L) || far in L || !("length" in L) || !("push" in L) || !("2" in L) || Object.hasOwn(L, "push"))
        throw new Error("membership");
`,
);

check(
    "an enum's reverse mapping reads the last member with a value",
    `
    enum D { A = 0, B = 0, C = 1 }
    let k = 0;
    if (D[0] !== "B" || D[k] !== "B" || D[1] !== "C") throw new Error("reverse " + D[0]);
    `,
);

check(
    "an erased console call still runs its arguments' effects",
    `
    let calls = 0;
    let formats = 0;
    function tag(s: TemplateStringsArray): string { calls++; return s[0]!; }
    class Meter { v = 2; toFixed(d: number): string { formats++; return this.v.toFixed(d); } }
    const meter = new Meter();
    console.log(tag\`x\`, meter.toFixed(2), (3.14159).toFixed(2));
    if (calls !== 1 || formats !== 1) throw new Error("erased effects " + calls + formats);
    `,
);

check(
    "Math.round of a small negative value is negative zero",
    `
    let d = -0.4;
    const values = [Math.round(d), Math.round(d - 0.1), Math.round(-0.4)];
    if (!values.every((v) => Object.is(v, -0)) || Math.round(d - 0.2) !== -1) throw new Error("round sign");
    `,
);

check(
    "a language global read through globalThis is the global",
    `
    const st = { s: 1 };
    function next(): number { globalThis.Object.assign(st, { s: st.s * 2 }); return st.s; }
    const a = next(), b = next();
    const text = globalThis.JSON.stringify({ id: 1, meta: { tag: "m" } });
    if (a !== 2 || b !== 4 || text !== '{"id":1,"meta":{"tag":"m"}}') throw new Error("globalThis " + a + b + text);
    `,
);

test("parsed documents, number-keyed dictionaries and unread Error properties lower as JavaScript runs them", (t) => {
    const result = compileSource(
        `interface Tagged extends Error { code?: readonly unknown[] }
        function fail(code: number, ...args: readonly unknown[]): never {
            const error: Tagged = new Error("#" + code);
            error.code = args;
            throw error;
        }
        enum Kind { Lines = 0, Points = 1 }
        type Primitive = { kind: Kind.Lines; positions: number[]; width?: number } | { kind: Kind.Points; positions: number[]; size: number };
        function record(value: unknown): value is Record<string, unknown> {
            return typeof value === "object" && value !== null && !Array.isArray(value);
        }
        function integer(value: unknown): value is number {
            return Number.isSafeInteger(value);
        }
        let message = "";
        try { fail(7, "a"); } catch (error) { message = error instanceof Error ? error.message : ""; }
        if (message !== "#7") throw new Error("error message");
        const pool: { [key: number]: number[] } = {};
        pool[4] = [1]; pool[2] = [2, 3]; pool[10] = [4];
        let names = "";
        let total = 0;
        for (const key in pool) { names += key + ","; total += pool[key]!.length; }
        if (names !== "2,4,10," || total !== 4) throw new Error("number-keyed for-in " + names);
        const asset: unknown = JSON.parse('{"base":2,"count":3,"links":[1,4]}');
        if (!record(asset) || !integer(asset.base) || !integer(asset.count) || !Array.isArray(asset.links)) throw new Error("document guards");
        let sum = 0;
        for (let i = asset.base; i < asset.base + asset.count; i++) sum += i;
        if (sum !== 9 || !asset.links.includes(4) || asset.links.includes(2)) throw new Error("document reads");
        const primitives: Primitive[] = [];
        primitives.push({ kind: Kind.Points, positions: [1, 2, 3], size: 2 });
        primitives.push({ kind: Kind.Lines, positions: [4, 5, 6, 7, 8, 9] });
        let points = 0;
        for (const primitive of primitives) points += primitive.kind === Kind.Points ? primitive.size : primitive.positions.length;
        const copy = structuredClone(primitives);
        if (points !== 8 || copy[0]!.kind !== Kind.Points || copy.length !== 2) throw new Error("enum-tagged union");
        globalThis.close();`,
        { fileName: "program-data-constructs.ts" },
    );
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "program-data-constructs", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
    });
});
