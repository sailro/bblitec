import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check } from "./language-constructs.js";

check(
    "a-binding-pattern-binds-alike-in-every-position",
    `
    function f([a, b = 3]: [number, number?], { p: [x, y] }: { p: [number, number] }): number { return a * 10 + b + x - y; }
    if (f([1], { p: [5, 2] }) !== 16 || f([1, 2], { p: [0, 0] }) !== 12) throw new Error("parameters");
    const rows: [string, number?][] = [["a"], ["b", 2]];
    if (rows.map(([k, v = 0]) => k + v).join() !== "a0,b2") throw new Error("callback");
    let [text, amount] = ["before", 3] as [string, number];
    text = "after";
    amount += 2;
    let { s, n } = { s: "a", n: 1 };
    s = "b";
    n++;
    if (text + amount !== "after5" || s + n !== "b2") throw new Error("rebound " + text + amount + s + n);
    const m = new Map<string, { n: number; w?: number }>([["a", { n: 1 }], ["b", { n: 2, w: 3 }]]);
    let out = "";
    for (const [k, { n: count, w = 10 }] of m) out += k + count * w;
    for (const [i, [first, second]] of ([[1], [2, 3]] as [number, number?][]).entries()) out += i + String(second) + first;
    for (let [a, b] of [[1, 2]] as [number, number][]) { a *= 10; out += a + b; }
    if (out !== "a10b60undefined113212") throw new Error("for-of patterns " + out);
`,
);

check(
    "destructured-parameter-readonly-and-writable-facts",
    `
    const entries = Object.entries({left: 1, right: "saved", callback: () => 3});
    const selected = entries.find(([name]) => name === "right");
    if (!selected || selected[1] !== "saved") throw new Error("destructured readonly key");
    function update([text, amount, enabled]: [string, number, boolean]): string {
        text = "after";
        amount += 2;
        enabled = !enabled;
        return text + ":" + amount + ":" + enabled;
    }
    if (update(["before", 3, false]) !== "after:5:true") throw new Error("destructured writable scalars");
    function increment([record]: [{value: number}]): void { record.value++; }
    const record = {value: 5};
    increment([record]);
    if (record.value !== 6) throw new Error("destructured mutable record");
`,
);

// A helper's spread of the declarations it is given returns new arrays over
// the same records, searched at generation and written where they live.
check(
    "spread-results-a-helper-returns-keep-element-identity-and-writes",
    `
    interface Row { name: string; size: number }
    function hasRow<T extends { name: string }>(rows: readonly T[], name: string): boolean {
        let visits = 0;
        const found = rows.some((row) => { visits++; return row.name === name; });
        if (visits === 0 && rows.length > 0) throw new Error("predicate effects");
        return found;
    }
    function withRow<T extends { name: string }>(rows: readonly T[], row: T): T[] {
        return hasRow(rows, row.name) ? [...rows] : [...rows, row];
    }
    const EXTRA: Row = { name: "extra", size: 4 };
    const READ: readonly Row[] = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
    const SAME: readonly Row[] = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
    const GROWN: readonly Row[] = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
    const PUSHED: readonly Row[] = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
    function reads(): void {
        const added = withRow(withRow(READ, EXTRA), EXTRA);
        if (added.length !== 3 || added[2]!.name !== "extra" || !hasRow(added, "a") || hasRow(added, "z")) throw new Error("reads");
    }
    function identity(): void {
        const added = withRow(SAME, EXTRA);
        const kept = withRow(SAME, SAME[0]!);
        if (added.length !== 3 || kept.length !== 2 || added === kept || kept === SAME) throw new Error("helper results");
        if (added[0] !== SAME[0] || added[2] !== EXTRA || kept[1] !== SAME[1]) throw new Error("element identity");
    }
    function writes(): void {
        const added = withRow(GROWN, EXTRA);
        added[0]!.size += 1;
        if (GROWN[0]!.size !== 2 || added[0]!.size !== 2 || added.length !== 3) throw new Error("writes through results");
    }
    function pushes(): void {
        const added = withRow(PUSHED, EXTRA);
        added.push({ name: "pushed", size: 0 });
        if (added.length !== 4 || PUSHED.length !== 2 || added[3]!.name !== "pushed" || added[0]!.size !== 1) throw new Error("push onto results");
    }
    reads();
    identity();
    writes();
    pushes();
`,
);

// A field `Object.assign` replaces on a record a helper's spread returns is
// read where it lives.
check(
    "spread-results-a-helper-returns-read-a-field-object-assign-replaces",
    `
    interface Row { name: string; size: number }
    function hasRow<T extends { name: string }>(rows: readonly T[], name: string): boolean {
        return rows.some((row) => row.name === name);
    }
    function withRow<T extends { name: string }>(rows: readonly T[], row: T): T[] {
        return hasRow(rows, row.name) ? [...rows] : [...rows, row];
    }
    const EXTRA: Row = { name: "extra", size: 4 };
    const ROWS: readonly Row[] = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
    function assigns(): void {
        const added = withRow(ROWS, EXTRA);
        Object.assign(added[0]!, { name: "assigned" });
        if (ROWS[0]!.name !== "assigned" || !hasRow(added, "assigned") || hasRow(added, "a")) throw new Error("writes the program spells otherwise");
    }
    assigns();
`,
);

// A field a write through another record type replaces on a record a
// helper's spread returns is read where it lives.
check(
    "spread-results-a-helper-returns-read-a-field-another-type-replaces",
    `
    interface Row { name: string; size: number }
    function withRow<T extends { name: string }>(rows: readonly T[], row: T): T[] {
        return [...rows, row];
    }
    function rename(row: { name: string }): void {
        row.name = "renamed";
    }
    const EXTRA: Row = { name: "extra", size: 4 };
    const ROWS: readonly Row[] = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
    function renames(): void {
        const added = withRow(ROWS, EXTRA);
        rename(added[1]!);
        if (added[1]!.name !== "renamed") throw new Error("result renamed");
        if (ROWS[1]!.name !== "renamed") throw new Error("source renamed");
    }
    renames();
`,
);

check(
    "push-spreads-what-an-array-literal-spreads",
    `
    const gate = new Float32Array([1]);
    const letters: string[] = ["<"];
    letters.push(..."ab", ...new Set(["c", "c", "d"]));
    const tags = new Map<string, number>([["x", 1], ["y", 2]]);
    letters.push(...tags.keys());
    if (letters.join("") !== "<abcdxy") throw new Error("string, Set and iterator spreads");
    const numbers: number[] = [0];
    numbers.push(...new Float32Array([0.5, 1.5]), ...new Set([2, 2, 3]), ...tags.values());
    if (numbers.join(",") !== "0,0.5,1.5,2,3,1,2") throw new Error("typed array, Set and iterator spreads");
    const pairs: [string, number][] = [];
    pairs.push(...tags);
    if (pairs.length !== 2 || pairs[1]![0] !== "y" || pairs[1]![1] !== 2) throw new Error("Map entry spread");
    numbers.length = 1;
    numbers.push(...numbers.map((v) => v + gate[0]!), ...numbers);
    if (numbers.join(",") !== "0,1,0") throw new Error("receiver read before the push");
    const points: string[] = [];
    points.push(..."a\u{1F600}");
    if (points.length !== 2 || points[1] !== "\u{1F600}") throw new Error("code points");
`,
);

check(
    "spreads-read-own-accessors-once",
    `
    interface Save { cx: number; cz: number; name: string; }
    let reads = 0;
    let live = 4;
    const saves: Save[] = [{ cx: 1, cz: 2, name: "a" }];
    const views: Save[] = [{ get cx() { reads++; return live; }, cz: 5, name: "v" }];
    const copyOf = (save: Save): Save => ({ ...save });
    const plain = copyOf(saves[0]!);
    const snapshot = copyOf(views[0]!);
    live = 9;
    if (plain.cx !== 1 || snapshot.cx !== 4 || reads !== 1 || views[0]!.cx !== 9 || reads !== 2) throw new Error("spread snapshots getters");
    if (Object.keys(snapshot).join() !== "cx,cz,name") throw new Error("keys");
`,
);

check(
    "spreads-carrying-properties-the-target-type-lacks",
    `
    interface Options { widthPad?: number; clusterDist?: number; pillarGap?: number; arcAt?: (x: number) => number; }
    function fromHits(hits: readonly number[], opts: Pick<Options, "clusterDist" | "pillarGap" | "arcAt"> = {}): number[] {
        const arc = opts.arcAt ?? ((x: number) => x * 2);
        return hits.map((hit) => arc(hit) + (opts.clusterDist ?? 0) + (opts.pillarGap ?? 0));
    }
    function crossings(hits: readonly number[], opts: Options = {}): number[] {
        return fromHits(hits, { ...opts, arcAt: (x) => x + 100 });
    }
    const inputs: Options[] = [{ widthPad: 3, clusterDist: 0.5 }, {}];
    if (crossings([1, 2], inputs[0]).join(",") !== "101.5,102.5" || crossings([4], inputs[1]).join(",") !== "104" ||
        crossings([5]).join(",") !== "105") throw new Error("crossings");
    interface CommandKey { villagerId: number; incarnation: number; }
    interface Command extends CommandKey { kind: "chop" | "carry"; targetId: number; quantity?: number; expectedEpoch: number; }
    interface CommandResult extends CommandKey { code: "APPLIED" | "REJECTED_RETRY"; targetId: number; resultingVersion?: number; quantity?: number; }
    function executeForLive(command: Command, alive: readonly number[], resultOf: (command: Command) => CommandResult | null,
        execute: (command: Command) => CommandResult): CommandResult {
        const existing = resultOf(command);
        if (existing) return existing;
        const villager = alive.find((id) => id === command.villagerId) ?? null;
        return villager !== null ? execute(command) : { ...command, code: "REJECTED_RETRY" };
    }
    const journal = new Map<number, CommandResult>();
    const resultOf = (command: Command): CommandResult | null => journal.get(command.targetId) ?? null;
    const run = (command: Command): CommandResult =>
        ({ villagerId: command.villagerId, incarnation: command.incarnation, code: "APPLIED", targetId: command.targetId, resultingVersion: 2 });
    const command: Command = { villagerId: 1, incarnation: 3, kind: "chop", targetId: 7, expectedEpoch: 9 };
    const applied = executeForLive(command, [1], resultOf, run);
    const retried = executeForLive(command, [], resultOf, run);
    journal.set(7, applied);
    if (applied.code !== "APPLIED" || applied.resultingVersion !== 2 || executeForLive(command, [], resultOf, run) !== applied) throw new Error("applied");
    if (retried.code !== "REJECTED_RETRY" || retried.targetId !== 7 || retried.villagerId !== 1) throw new Error("retried");
    if (Object.keys(retried).sort().join(",") !== "code,expectedEpoch,incarnation,kind,targetId,villagerId" || "quantity" in retried) throw new Error("spread keys");
`,
);

check(
    "dictionary-copied-by-spread-where-a-closed-record-is-declared",
    `
    type Action = "jump" | "run";
    type Profile = Record<Action, string>;
    interface Preferences { scheme: string; shortcuts: { classic: Profile; wasd: Profile } }
    const definitions: readonly { action: Action; keys: Record<"classic" | "wasd", string> }[] = [
        { action: "jump", keys: { classic: "Space", wasd: "KeyJ" } },
        { action: "run", keys: { classic: "Shift", wasd: "KeyR" } },
    ];
    function profile(scheme: "classic" | "wasd"): Profile {
        return Object.fromEntries(definitions.map((definition) => [definition.action, definition.keys[scheme]])) as Profile;
    }
    function defaults(): Preferences {
        return { scheme: "classic", shortcuts: { classic: profile("classic"), wasd: profile("wasd") } };
    }
    function clone(preferences: Preferences): Preferences {
        return {
            scheme: preferences.scheme,
            shortcuts: { classic: { ...preferences.shortcuts.classic }, wasd: { ...preferences.shortcuts.wasd } },
        };
    }
    const original = defaults();
    const copy = clone(original);
    copy.shortcuts.classic.jump = "Enter";
    if (original.shortcuts.classic.jump !== "Space" || copy.shortcuts.classic.jump !== "Enter" || copy.shortcuts.wasd.run !== "KeyR")
        throw new Error("clone " + original.shortcuts.classic.jump + copy.shortcuts.classic.jump + copy.shortcuts.wasd.run);
`,
);

// A parsed list of lists spread into a new array stores each inner list as
// the array sink stores a parsed one.
check(
    "parsed-list-of-lists-spread-with-a-new-list",
    `
    interface State { issueNo: number; recent: readonly (readonly string[])[] }
    function next(state: State, chosen: readonly { identity: string }[]): State {
        const nextRecent = [...state.recent, chosen.map((c) => c.identity)].slice(-2);
        return { issueNo: state.issueNo + 1, recent: nextRecent };
    }
    const flag = Math.random() >= 0;
    const loaded = JSON.parse(flag ? '{"issueNo":3,"recent":[["a"],["b","c"]]}' : '{"issueNo":0,"recent":[]}') as State;
    const after = next(loaded, [{ identity: "d" }, { identity: "e" }]);
    if (after.issueNo !== 4 || after.recent.length !== 2 || after.recent[0]!.join() !== "b,c" || after.recent[1]!.join() !== "d,e") throw new Error("recent");
    const seen = new Set<string>();
    for (const ids of after.recent) for (const id of ids) seen.add(id);
    if (seen.size !== 4 || JSON.stringify(after) !== '{"issueNo":4,"recent":[["b","c"],["d","e"]]}') throw new Error("kept " + JSON.stringify(after));
`,
);

check(
    "object-destructuring-assignments-and-keyed-absence",
    `
    interface Auto { dawn?: string; dusk?: string; stops?: readonly { dawn?: string }[]; }
    const flags = (auto: Auto): { hasDawn: boolean; hasDusk: boolean } =>
        ({ hasDawn: !!(auto.dawn || auto.stops?.some((stop) => !!stop.dawn)), hasDusk: !!auto.dusk });
    function prepare(config: { auto?: Auto }): string {
        let autoHasDawn = false;
        let autoHasDusk = false;
        if (config.auto) ({ hasDawn: autoHasDawn, hasDusk: autoHasDusk } = flags(config.auto));
        return autoHasDawn + ":" + autoHasDusk;
    }
    const configs: { auto?: Auto }[] = [{}, { auto: { dawn: "a" } }, { auto: { dusk: "b", stops: [{ dawn: "c" }] } }];
    if (configs.map(prepare).join(",") !== "false:false,true:false,true:true") throw new Error("destructuring assignment");
    interface Args { readonly point?: { x: number }; readonly hostId?: number; readonly label?: string; }
    const argsOnly = (args: Args, allowed: readonly (keyof Args)[]): boolean =>
        (Object.keys(args) as Array<keyof Args>).every((key) => args[key] === undefined || allowed.includes(key));
    const all: Args[] = [{ point: { x: 1 } }, { hostId: 3, label: "x" }, {}];
    if (all.map((args) => argsOnly(args, ["point", "hostId"])).join(",") !== "true,false,true") throw new Error("keyed absence");
    interface Recorder<T extends Record<string, number>> { push(t: number, values: T): void; samples(): readonly ({ t: number } & T)[]; }
    function createRecorder<T extends Record<string, number>>(): Recorder<T> {
        const data: ({ t: number } & T)[] = [];
        const same = (a: { t: number } & T, b: T): boolean => {
            for (const k of Object.keys(b)) if (a[k] !== b[k]) return false;
            return true;
        };
        return {
            push(t: number, values: T): void {
                const last = data[data.length - 1];
                if (last && same(last, values)) { last.t = t; return; }
                data.push({ t, ...values });
            },
            samples: () => data,
        };
    }
    const recorder = createRecorder<{ deer: number; rabbit: number }>();
    recorder.push(1, { deer: 1, rabbit: 2 });
    recorder.push(2, { deer: 1, rabbit: 2 });
    recorder.push(3, { deer: 2, rabbit: 2 });
    const samples = recorder.samples();
    if (samples.length !== 2 || samples[0]!.t !== 2 || samples[1]!.deer !== 2) throw new Error("string-keyed reads");
`,
);

test("object destructuring assignments with defaults refuse", () => {
    assert.throws(
        () =>
            compileSource(`
            let a = 0;
            const source = (): { a?: number } => ({});
            ({ a = 3 } = source());
            if (a !== 3) throw new Error("a");
            `),
        /Only property assignments are supported/,
    );
});

check(
    "destructuring",
    `
    function lanes(xs: number[]): number {
        const [first = 5, second = 7, ...rest] = xs;
        let a = 1;
        let b = 2;
        [a, b] = [b, a];
        return first + second * 10 + rest.length * 100 + a * 1000;
    }
    if (lanes([1]) !== 1 + 70 + 0 + 2000 || lanes([1, 2, 3, 4]) !== 1 + 20 + 200 + 2000) throw new Error("array defaults and rest");
    const source = { a: 1, b: 2, c: 3 };
    const { a, ...rest } = source;
    const { b = 9, d = 4 } = { b: 2 } as { b?: number; d?: number };
    if (a + rest.b + rest.c + b + d !== 12) throw new Error("object defaults and rest");
    interface Options { width?: number; height: number }
    function area({ width = 2, height }: Options): number { return width * height; }
    if (area({ height: 3 }) + area({ width: 4, height: 1 }) !== 10) throw new Error("destructured parameters");
    function struct(options: Options): number {
        const { width = 6, height } = options;
        return width + height;
    }
    if (struct({ height: 1 }) + struct({ width: 1, height: 1 }) !== 9) throw new Error("struct defaults");
`,
);

check(
    "contextual-record-map-spreads",
    `
    interface Item { name: string; category: "first" | "second"; metadata: { size: number } | null; }
    const first: string[] = ["a", "b"];
    const second: string[] = ["long"];
    const items: readonly Item[] = [
        ...first.map(name => ({ name, category: "first" as const, metadata: null })),
        ...second.map(name => ({ name, category: "second" as const, metadata: { size: name.length } })),
    ];
    if (items.length !== 3 || items[0]!.metadata !== null || items[2]!.metadata!.size !== 4)
        throw new Error("contextual record fields");
    if (items.filter(item => item.metadata === null).map(item => item.name).join(",") !== "a,b")
        throw new Error("contextual record filtering");
`,
);

check(
    "contextual-array-from-spreads",
    `
    const fields: readonly (readonly [string, "f32" | "vec4<f32>"])[] = [
        ...Array.from({ length: 2 }, (_, i) => [\`u\${i}\`, "vec4<f32>"] as const),
        ["s", "f32"],
    ];
    interface Option { name: string; size: number }
    const options: readonly Option[] = [...Array.from({ length: 3 }, (_, i) => ({ name: \`o\${i}\`, size: i * 2 })), { name: "z", size: 9 }];
    const text = fields.map(([name, type]) => name + ":" + type).join(",");
    if (text !== "u0:vec4<f32>,u1:vec4<f32>,s:f32") throw new Error("contextual tuples");
    if (options.map((o) => o.name + o.size).join(",") !== "o00,o12,o24,z9") throw new Error("contextual records");
`,
);

check(
    "struct-spread-into-record-literal",
    `
    interface Spec { id: string; rgb: [number, number, number] }
    interface Swatch extends Spec { swatch: string }
    const SPECS: Spec[] = [{ id: "a", rgb: [1, 0.5, 0.25] }, { id: "b", rgb: [0.5, 1, 0.25] }];
    const hex = (rgb: readonly [number, number, number]): string => rgb.map((c) => Math.round(c * 100)).join("-");
    const swatches: Swatch[] = SPECS.map((s) => ({ ...s, swatch: hex(s.rgb) }));
    if (swatches.length !== 2 || swatches[1]!.swatch !== "50-100-25" || swatches[0]!.id !== "a") throw new Error("spread fields");
    SPECS[0]!.rgb[0] = 9;
    SPECS[0]!.id = "z";
    if (swatches[0]!.rgb[0] !== 9 || swatches[0]!.id !== "a") throw new Error("spread copies scalars and shares nested objects");
    const lilies: { model: string; labelKey: string }[] = [{ model: "lily", labelKey: "k" }];
    const list = [{ model: "x", labelKey: "y", tool: "flower" as const }, ...lilies.map((f) => ({ ...f, tool: "lily" as const }))];
    if (list.length !== 2 || list[1]!.tool !== "lily" || list[1]!.model !== "lily" || list[0]!.labelKey !== "y") throw new Error("spread element");
`,
);

check(
    "array-spread-of-wider-records",
    `
    type Spec = { id: string; rgb: [number, number, number] };
    type Swatch = Spec & { swatch: string };
    function palette(): { id: string; labelKey: string; rgb: [number, number, number]; swatch: string }[] {
        return [{ id: "a", labelKey: "tint.a", rgb: [1, 2, 3], swatch: "#a" }];
    }
    const base = palette();
    const extra: Spec = { id: "b", rgb: [4, 5, 6] };
    const all: Swatch[] = [...base, { ...extra, swatch: "#b" }];
    if (all.length !== 2 || all[0]!.swatch !== "#a" || all[0]!.rgb[2] !== 3 || all[1]!.id !== "b") throw new Error("spread records");
    base[0]!.rgb[0] = 9;
    if (all[0]!.rgb[0] !== 9) throw new Error("nested arrays stay shared");
`,
);

check(
    "parsed-document-array-destructuring",
    `
    interface RawNode { translation?: number[]; rotation?: number[] }
    function sum(node: RawNode): number {
        const [tx, ty, tz] = node.translation ?? [0, 0, 0];
        const [qx, , , qw] = node.rotation ?? [0, 0, 0, 1];
        return tx! + ty! + tz! + qx! + qw!;
    }
    const doc = JSON.parse('{"nodes":[{"translation":[1,2,3]},{"rotation":[0.5,0,0,2]}]}') as { nodes: RawNode[] };
    if (sum(doc.nodes[0]!) !== 7 || sum(doc.nodes[1]!) !== 2.5) throw new Error("document lanes");
    const [first, second] = JSON.parse('"ab"') as unknown as string[];
    if (first !== "a" || second !== "b") throw new Error("document string");
    const sources = ['"\\ud83d\\ude00\\u00e9xyz"'];
    const [emoji, accent, , fourth] = JSON.parse(sources[0]!) as unknown as string[];
    if (emoji !== "\\ud83d\\ude00" || accent !== "\\u00e9" || fourth !== "y") throw new Error("document code points");
    const [one, missing] = JSON.parse("[1]") as number[];
    if (one !== 1 || missing !== undefined) throw new Error("document lane past the end");
    let name = "";
    try { const [lane] = JSON.parse("{}") as number[]; if (lane === 0) name = "zero"; } catch (error) { name = (error as Error).name; }
    if (name !== "TypeError") throw new Error("document not iterable");
    function parse(value: unknown): [number, number, number] | null {
        if (!Array.isArray(value) || value.length !== 3) return null;
        const ok = (v: unknown): v is number => typeof v === "number" && v >= 0;
        const [r, g, b] = value as unknown[];
        if (!ok(r) || !ok(g) || !ok(b)) return null;
        return [r, g, b];
    }
    const parsed = parse(JSON.parse("[1,2,3]"));
    if (!parsed || parsed[2] !== 3 || parse(JSON.parse('[1,"2",3]')) !== null) throw new Error("unknown lanes");
`,
);

// A rest element collects the values the document iterates past it into a
// new array: an array's elements, a string's code points, none past the end.
check(
    "parsed-document-array-rest-destructuring",
    `
    const doc = JSON.parse('{"stories":[{"no":1},{"no":2},{"no":3}]}') as { stories: { no: number }[] };
    const [lead, ...rest] = doc.stories;
    if (lead!.no !== 1 || rest.length !== 2 || rest[0]!.no !== 2 || rest[1]!.no !== 3) throw new Error("document rest");
    const [first, ...others] = JSON.parse('"a😀b"') as unknown as string[];
    if (first !== "a" || others.length !== 2 || others.join("") !== "😀b") throw new Error("document string rest");
    const [, , ...tail] = JSON.parse("[1]") as number[];
    if (tail.length !== 0) throw new Error("document rest past the end");
`,
);

check(
    "object-rest-retains-converted-record-properties",
    `
            interface Source { a: number; c: number }
            interface View { a: number; b?: number }
            function readB(v: View): number { return v.b ?? -1; }
            function make(a: number): { a: number; c: number; b: number } { return { a, c: 0, b: a * 2 }; }
            const list: Source[] = [{ a: 3, c: 1 }];
            list.push(make(1));
            const { c, ...rest } = list[1]!;
            const read = readB(rest) + c;
            if (read !== 2 || "c" in rest || !("c" in list[1]!)) throw new Error("rest fields");
    `,
);

check(
    "spread-struct-literals-omit-absent-optional-fields",
    `
    interface Arch { span: number }
    interface WallOptions { width: number; seed: number; arch?: Arch; groundY?: () => number; dims?: number[] }
    function compose(o: WallOptions): string {
        return o.width + ":" + (o.arch ? o.arch.span : "none") + ":" + (o.groundY ? o.groundY() : -1) + ":" + (o.dims ? o.dims.length : 0);
    }
    function crown(width: number, dims: number[] | undefined): string {
        const options: WallOptions = { width, seed: 3, ...(dims && dims.length > 0 ? { dims } : {}) };
        return compose(options);
    }
    function arched(width: number, span: number): string {
        const options: WallOptions = { ...{ width, seed: 1 }, arch: { span }, groundY: () => width * 2 };
        return compose(options);
    }
    const crowns: Array<typeof crown> = [crown];
    const arches: Array<typeof arched> = [arched];
    if (crowns[0]!(2, [1, 2]) !== "2:none:-1:2" || crowns[0]!(4, undefined) !== "4:none:-1:0") throw new Error("absent optional fields");
    if (arches[0]!(3, 5) !== "3:5:6:0") throw new Error("present optional fields");
`,
);

check(
    "record-spreads-copy-methods-into-struct-literals",
    `
    interface Live { update(dt: number): void; active(): boolean; count: number }
    interface SwanLive extends Live { state(): string; height: number }
    function createLive(count: number): Live {
        let elapsed = 0;
        return { update(dt) { elapsed += dt; }, active: () => elapsed > 1, count };
    }
    function createSwan(count: number): SwanLive {
        const live = createLive(count);
        return { ...live, state: () => (live.active() ? "awake" : "asleep"), height: 3 };
    }
    const swans: Array<typeof createSwan> = [createSwan];
    const swan = swans[0]!(2);
    if (swan.active() || swan.state() !== "asleep") throw new Error("initial state");
    swan.update(2);
    if (!swan.active() || swan.state() !== "awake" || swan.count !== 2 || swan.height !== 3) throw new Error("copied methods share state");
`,
);

test("record spreads with accessors refuse in struct literals", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Clock { readonly now: number; tick(): void }
            function clock(): Clock { let t = 0; return { get now() { return t; }, tick() { t++; } }; }
            const make = (): Clock => ({ ...clock(), tick() {} });
            const clocks: Array<typeof make> = [make];
            clocks[0]!().tick();
            `),
        /A record with accessors spreads into a compile-time record, not a struct literal/,
    );
});

// A readonly array a conditional spread builds is the record's own array,
// stored and serialized as the one array JavaScript keeps.
check(
    "conditional-spread-readonly-array-member",
    `
    interface HerdOptions { file: string; capacity: number; anchors?: readonly number[]; bones?: readonly number[]; shadow?: boolean }
    interface Prototype { file: string; bone?: number }
    function herdOptions(options: Prototype): HerdOptions {
        return { file: options.file, capacity: 1, ...(options.bone === undefined ? {} : { bones: [options.bone, options.bone + 1] }) };
    }
    function cacheKey(opts: HerdOptions): string {
        return JSON.stringify({ file: opts.file, anchors: opts.anchors ?? null, bones: opts.bones ?? null });
    }
    const prepared = new Map<string, number>();
    function create(file: string, shell: { bone: number } | null, shadow: boolean): string {
        const opts: HerdOptions = { ...herdOptions({ file, ...(shell ? { bone: shell.bone } : {}) }), shadow };
        const key = cacheKey(opts);
        if (!prepared.has(key)) prepared.set(key, prepared.size);
        return key + "#" + prepared.get(key) + ":" + (opts.bones === opts.bones) + ":" + (opts.shadow === true);
    }
    const creates: Array<typeof create> = [create];
    if (creates[0]!("t", { bone: 3 }, true) !== '{"file":"t","anchors":null,"bones":[3,4]}#0:true:true') throw new Error("present");
    if (creates[0]!("t", null, false) !== '{"file":"t","anchors":null,"bones":null}#1:true:false') throw new Error("absent");
    if (creates[0]!("t", { bone: 3 }, false) !== '{"file":"t","anchors":null,"bones":[3,4]}#0:true:false') throw new Error("cached");
    interface Track { name: string; points?: readonly number[] }
    function track(name: string, from: number | null): Track {
        return { name, ...(from === null ? {} : { points: [from, from * 2] }) };
    }
    const tracks: Array<typeof track> = [track];
    const t = tracks[0]!("a", 2);
    const points = t.points;
    if (points !== t.points || points?.length !== 2 || points[1] !== 4 || tracks[0]!("b", null).points !== undefined)
        throw new Error("one member array");
`,
);

check(
    "conditional-spread-own-keys",
    `
    const gate = new Float32Array([0, 1]);
    const absent = { name: "a", ...(gate[0]! > 0 ? { extra: 3 } : {}), tail: true };
    const present = { name: "a", ...(gate[1]! > 0 ? { extra: 4 } : {}), tail: true };
    if ("extra" in absent || !("extra" in present)) throw new Error("in");
    const key = gate[1]! > 0 ? "extra" : "name";
    if (key in absent || !(key in present)) throw new Error("dynamic in");
    if (Object.hasOwn(absent, "extra") || !Object.hasOwn(present, "extra")) throw new Error("hasOwn");
    if (Object.keys(absent).join() !== "name,tail" || Object.keys(present).join() !== "name,extra,tail")
        throw new Error("keys " + Object.keys(present).join());
    if (Object.values(present).length !== 3 || Object.values(absent).length !== 2) throw new Error("values");
    const entries = Object.entries(present).map(([k, v]) => k + "=" + v).join();
    if (entries !== "name=a,extra=4,tail=true") throw new Error("entries " + entries);
    let visited = "";
    for (const k in absent) visited += k;
    for (const k in present) visited += k;
    if (visited !== "nametailnameextratail") throw new Error("for in " + visited);
    if (JSON.stringify(absent).includes("extra") || JSON.parse(JSON.stringify(present)).extra !== 4) throw new Error("json");
    const kept = { extra: 1, ...(gate[0]! > 0 ? { extra: 2 } : {}) };
    const replaced = { extra: 1, ...(gate[1]! > 0 ? { extra: 2 } : {}) };
    if (kept.extra !== 1 || replaced.extra !== 2) throw new Error("override");
    const copy = { ...absent, more: 1 };
    const copied = { ...present, more: 1 };
    if ("extra" in copy || copied.extra !== 4 || Object.keys(copied).join() !== "name,extra,tail,more") throw new Error("copy");
    const table: Record<string, number> = { base: 1, ...(gate[1]! > 0 ? { added: 2 } : {}), ...(gate[0]! > 0 ? { skipped: 3 } : {}) };
    if (Object.keys(table).join() !== "base,added") throw new Error("dictionary " + Object.keys(table).join());
    interface Options { width: number; tint?: number; label?: string }
    function read(index: number): Options { return index > 0 ? { width: 2, tint: 5 } : { width: 1 }; }
    const a = { ...read(gate[1]!), kind: "a" };
    const b = { ...read(gate[0]!), kind: "b" };
    if (a.tint !== 5 || !("tint" in a) || "tint" in b || "label" in a) throw new Error("struct spread keys");
    const over = { tint: 9, ...read(gate[0]!) };
    const under = { tint: 9, ...read(gate[1]!) };
    if (over.tint !== 9 || under.tint !== 5) throw new Error("struct spread override");
`,
);

check(
    "conditional-spread-prepared-arms",
    `
    const gate = new Float32Array([0, 1]);
    let draws = 0;
    function rng(): number { draws++; return gate[1]! * 0.5; }
    interface Style { level: number; roofHeight?: number; endSlope?: number; crown?: string; ivyOff?: boolean }
    function style(crown: string): Partial<Style> {
        return {
            level: Math.round(rng() * 20) / 20,
            ...(crown === "roof" ? { roofHeight: rng() * 2, endSlope: rng() < 0.75 ? 0 : 1 } : { crown: "railing" }),
            ...(rng() < 0.2 ? { ivyOff: true } : {}),
        };
    }
    const roof = style(gate[1]! > 0 ? "roof" : "flat");
    if (roof.roofHeight !== 1 || roof.endSlope !== 0 || roof.crown !== undefined || "crown" in roof || draws !== 4)
        throw new Error("selected arm " + draws);
    const flat = style(gate[0]! > 0 ? "roof" : "flat");
    if (flat.roofHeight !== undefined || flat.crown !== "railing" || flat.ivyOff !== undefined || draws !== 6)
        throw new Error("other arm " + draws);
    interface Run { id: number }
    interface Snap { x: number; target?: { runIndex: number }; run?: Run }
    const runs: Run[] = [{ id: 7 }, { id: 9 }];
    function snap(x: number | undefined, target: { runIndex: number } | undefined): Snap | null {
        return x !== undefined ? { x, ...(target ? { target, run: runs[target.runIndex] } : {}) } : null;
    }
    const target = { runIndex: 1 };
    const hit = snap(gate[1]!, gate[1]! > 0 ? target : undefined);
    if (hit?.run?.id !== 9 || hit.target !== target) throw new Error("prepared member identity");
    if (snap(gate[0]!, undefined)?.run !== undefined) throw new Error("prepared absent");
    interface Arch { span: number; seatDepth?: number }
    const arches = (list: readonly Arch[], sink?: number): Arch[] =>
        list.map((arch) => ({ ...arch, ...(sink !== undefined ? { seatDepth: (arch.seatDepth ?? 0.25) + sink } : {}) }));
    const sunk = arches([{ span: 1 }, { span: 2, seatDepth: 1 }], gate[1]!);
    if (sunk[0]!.seatDepth !== 1.25 || sunk[1]!.seatDepth !== 2 || arches([{ span: 1, seatDepth: 3 }])[0]!.seatDepth !== 3)
        throw new Error("prepared fallback member");
    interface State { mix: number }
    const store: State[] = [{ mix: 1 }, { mix: 2 }];
    const find = (id: number) => (Number.isSafeInteger(id) && id > 0 ? store.find((state) => state.mix === id) : undefined);
    if (find(gate[1]!) !== store[0] || find(gate[0]!) !== undefined || find(3) !== undefined) throw new Error("prepared search");
    interface Badge { level: number; label?: string }
    function badge(on: boolean): Badge { return { level: 1, ...(on ? { label: rng() > 0 ? "on" : "off" } : {}) }; }
    const shown = badge(gate[1]! > 0);
    if (shown.label !== "on" || shown.label.length !== 2 || badge(gate[0]! > 0).label !== undefined) throw new Error("prepared string member");
`,
);

check(
    "typed-conditional-spread-optional-fields",
    `
    const gate = new Float32Array([0, 1]);
    interface Frame { x: number }
    interface Spec { value: number; scrub?: string; onCommit?: () => void; frame?: Frame }
    const keep: Spec = { value: 0, frame: { x: 1 } };
    const specs: Spec[] = [keep];
    specs.push({ value: 2, ...(gate[1]! > 0 ? { scrub: "x" } : {}) });
    const kept: Spec = { value: 3, scrub: "a", ...(gate[0]! > 0 ? { scrub: "b" } : {}) };
    const replaced: Spec = { value: 3, scrub: "a", ...(gate[1]! > 0 ? { scrub: "b" } : {}) };
    if (specs[1]!.scrub !== "x" || specs[1]!.onCommit !== undefined || specs[1]!.frame !== undefined)
        throw new Error("absent optional fields");
    if (kept.scrub !== "a" || replaced.scrub !== "b") throw new Error("typed spread override");
`,
);

check(
    "typed-conditional-spread-readonly-array-fields",
    `
    interface Options { file: string; bones?: readonly number[]; names?: readonly string[] }
    function options(file: string, bone: number | undefined): Options {
        return { file, ...(bone === undefined ? {} : { bones: [bone, bone + 1] }), names: ["mesh"] };
    }
    function key(opts: Options): string { return JSON.stringify({ file: opts.file, bones: opts.bones ?? null }); }
    const some = options("a", 4), none = options("b", undefined);
    if (key(some) !== '{"file":"a","bones":[4,5]}' || key(none) !== '{"file":"b","bones":null}' || "bones" in none) throw new Error("conditional readonly array field");
    const bones: number[] = [];
    bones.push(9);
    function hold(shared: readonly number[]): Options { return { file: "c", ...(shared.length > 0 ? { bones: shared } : {}) }; }
    if (hold(bones).bones !== bones) throw new Error("spread keeps the array's identity");
`,
);

check(
    "object-rest-copies-nullable-optional-fields",
    `
    interface Entry { id: number; note?: string | null; tint?: number }
    const entries: Entry[] = [{ id: 1, note: null }, { id: 2 }, { id: 3, note: "x", tint: 4 }];
    let text = "";
    for (const entry of entries) {
        const { id, ...rest } = entry;
        text += id + (rest.note ?? "-") + (rest.tint ?? 0) + ";";
    }
    if (text !== "1-0;2-0;3x4;") throw new Error(text);
`,
);

check(
    "object-spread-of-a-narrowed-union-member",
    `
    type Policy = "durable" | "fresh";
    interface Portion { kind: string; nutrition: number; policy: Policy; expires: number | null }
    function normalize(raw: number | Readonly<Portion>): Portion | null {
        if (typeof raw === "number") return raw > 0 ? { kind: "generic", nutrition: raw, policy: "durable", expires: null } : null;
        if (!(raw.nutrition > 0)) return null;
        const expiry = raw.policy === "durable" ? null : Number.isFinite(raw.expires) && raw.expires! >= 1 ? Math.trunc(raw.expires!) : null;
        if (raw.policy !== "durable" && expiry === null) return null;
        return { ...raw, expires: expiry };
    }
    const inputs: Array<number | Portion> = [2, { kind: "bread", nutrition: 1, policy: "fresh", expires: 3.5 }];
    const first = normalize(inputs[0]!), second = normalize(inputs[1]!);
    if (first?.kind !== "generic" || second?.kind !== "bread" || second.expires !== 3 || second === inputs[1])
        throw new Error("spread member");
    if ((inputs[1] as Portion).expires !== 3.5) throw new Error("spread copies its source");
`,
);

check(
    "map-entry-struct-destructuring",
    `
    interface Host { boundary: { kind: string }; size: number }
    const byKey = new Map<string, { host: Host; count: number }>();
    byKey.set("tower:a", { host: { boundary: { kind: "circle" }, size: 2 }, count: 1 });
    byKey.set("house:b", { host: { boundary: { kind: "rect" }, size: 3 }, count: 5 });
    const seen: string[] = [];
    for (const [key, { host, count: total }] of byKey)
        if (key.startsWith("tower:") || host.boundary.kind === "rect") seen.push(key + "=" + (host.size * total));
    if (seen.join() !== "tower:a=2,house:b=15") throw new Error("entries " + seen.join());
`,
);

check(
    "object-destructuring-of-documents",
    `
    function read(raw: string | null): { n: number; k: number | null } {
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (!parsed || typeof parsed !== "object") return { n: 0, k: null };
        const { n, k } = parsed as { n?: unknown; k?: unknown };
        return {
            n: typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0,
            k: typeof k === "number" && Number.isFinite(k) ? k : null,
        };
    }
    const r = read('{"n":2,"k":3.5}');
    if (r.n !== 2 || r.k !== 3.5 || read(null).n !== 0 || read('{"n":-1}').k !== null) throw new Error("members");
    let defaults = 0;
    function fallback(): number { defaults++; return 7; }
    function withDefault(raw: string): number {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return -1;
        const { n = fallback(), "k": renamed } = parsed as { n?: unknown; k?: unknown };
        return (typeof n === "number" ? n : -2) + (renamed === undefined ? 100 : 0);
    }
    if (withDefault("{}") !== 107 || withDefault('{"n":1,"k":0}') !== 1 || withDefault('{"n":null}') !== 98 || defaults !== 1)
        throw new Error("defaults " + defaults);
`,
);

check(
    "spreads-and-sequence-copies-read-one-iteration-protocol",
    `
    type Vec3 = [number, number, number];
    const lanes: Vec3 = [4, 9, 2];
    if (Math.max(...lanes) !== 9 || Math.min(...lanes) !== 2) throw new Error("Math over a numeric tuple");
    const set = new Set<number>([5, -1, 3]);
    if (Math.max(...set) !== 5 || Math.min(...set.values()) !== -1) throw new Error("Math over a Set and its iterator");
    interface Holder { pos: [number, number] }
    function holderAt(x: number): Holder { return { pos: [x, x + 1] }; }
    const holder = holderAt(3);
    holder.pos[1] = 4;
    if (Math.hypot(...holder.pos) !== 5) throw new Error("tuple field spread into a rest pack");
    function total(...items: number[]): number {
        let sum = 0;
        for (const item of items) sum += item;
        return sum;
    }
    const totals: Array<(...items: number[]) => number> = [total];
    const typed = new Uint8Array([1, 2]);
    if (totals[0]!(...set, ...typed, ...holder.pos, 10) !== 27) throw new Error("rest pack over a Set, a typed array and a tuple field");
    function letters(...items: string[]): string { return items.join("-"); }
    const named: Array<(...items: string[]) => string> = [letters];
    if (named[0]!(..."ab", "c") !== "a-b-c") throw new Error("rest pack over a string");
    const fromValues = new Float32Array(set.values());
    const fromIterator = Float64Array.from(set.values());
    if (fromValues.join() !== "5,-1,3" || fromIterator.join() !== "5,-1,3") throw new Error("typed arrays from an iterator");
    if (Array.from(typed).join() !== "1,2" || Array.from(lanes).length !== 3) throw new Error("Array.from over sequences");
`,
);

check(
    "spread-of-a-literal-factory-typed-wider",
    `
    // The factory's one literal decides the own keys, not the optional
    // fields its declared intersection adds.
    interface Init { a?: number; target?: { id: number } | null; flag?: boolean }
    const pressed = { value: 0 };
    const init = (): Init & { kind: string } => ({ a: 1, kind: "pointer", flag: pressed.value > 0 });
    const make = (b: number) => ({ ...init(), b });
    const makers: Array<typeof make> = [make];
    pressed.value = 1;
    const rows = [makers[0]!(2), makers[0]!(3)];
    const text = rows.map((row) => row.a + ":" + row.kind + ":" + row.flag + ":" + row.b + ":" + ("target" in row)).join(",");
    if (text !== "1:pointer:true:2:false,1:pointer:true:3:false") throw new Error("own keys " + text);
`,
);

check(
    "spread-of-nullable-optional-fields",
    `
    // A spread reads whether each optional field is own; one admitting null
    // keeps its absence apart from null.
    interface Init { a?: number; target?: { id: number } | null; flag?: boolean }
    const make = (extra: Init = {}) => {
        const full: Init & { kind: string } = { kind: "p", ...extra };
        return full;
    };
    const makers: Array<typeof make> = [make];
    const rows = [makers[0]!(), makers[0]!({ a: 5, target: null }), makers[0]!({ target: { id: 2 } })];
    const text = rows.map((r) => ("target" in r) + ":" + r.a + ":" + (r.target === null ? "null" : r.target?.id)).join(",");
    if (text !== "false:undefined:undefined,true:5:null,true:undefined:2") throw new Error("presence " + text);
`,
);

check(
    "destructured-record-function-and-getter-members",
    `
    interface Deps { height(x: number): number; scale: number; field: { at(x: number): number }; readonly doubled: number }
    let reads = 0;
    function make(deps: Deps): (x: number) => number {
        const { height, scale, field, doubled } = deps;
        return (x) => height(x) * scale + field.at(x) + doubled;
    }
    function h(x: number): number { return x * 2; }
    const f = make({ height: h, scale: 3, field: { at: (x: number) => x + 1 }, get doubled() { reads++; return 10; } });
    if (f(2) !== 25 || reads !== 1) throw new Error("members " + f(2) + " " + reads);
`,
);

test("a rest object pattern keeps refusing", () => {
    assert.throws(
        () =>
            compileSource(`
            function count(...{ length }: number[]): number { return length; }
            if (count(1, 2) !== 2) throw new Error("x");`),
        /A rest parameter is the last parameter and an identifier or array pattern/,
    );
});

// A selection of tuples of different lengths destructured where it is
// produced reads a converted copy nothing else holds, even though the
// program changes number arrays elsewhere.
check(
    "destructured-selection-of-converted-arrays",
    `
    function clearPoint(x: number, z: number, margin = 0.5): [number, number] {
        const out: [number, number] = [x, z];
        if (x < margin) out[0] = margin;
        return out;
    }
    function seatNearby(x: number, z: number, admitted: (x: number, z: number) => boolean): [number, number, boolean] | null {
        for (let r = 1; r < 4; r++) if (admitted(x + r, z)) return [x + r, z, true];
        return null;
    }
    function reseat(x: number, z: number, admitted: ((x: number, z: number) => boolean) | null): [x: number, z: number, admitted: boolean] {
        const cleared = clearPoint(x, z);
        const stranded = admitted !== null && !admitted(cleared[0], cleared[1]);
        if (admitted && stranded) {
            const seat = seatNearby(cleared[0], cleared[1], admitted);
            if (seat) return seat;
        }
        return [cleared[0], cleared[1], !stranded];
    }
    function place(x: number, z: number, restore = false): [number, number] {
        const admitted = (px: number, _pz: number): boolean => px > 2;
        const [seatX, seatZ] = restore ? reseat(x, z, admitted) : clearPoint(x, z, 0.2);
        const [, , kept = false] = (restore ? seatNearby(x, z, admitted) : null) ?? [0, 0];
        return [seatX, kept ? seatZ : -seatZ];
    }
    const places: Array<typeof place> = [place];
    const a = places[0]!(0, 1, true);
    const b = places[0]!(0.1, 1);
    if (a[0] !== 2.5 || a[1] !== 1 || b[0] !== 0.2 || b[1] !== -1) throw new Error("destructured selection");
    const trail: number[] = [];
    function note(v: number): number { trail.push(v); return trail.length; }
    const notes: Array<typeof note> = [note];
    if (notes[0]!(1) !== 1) throw new Error("trail");
`,
);

test("arrays destructured with code between their reads refuse a converted copy", () => {
    const shapes = `
        const trail: number[] = [];
        function note(v: number): number { trail.push(v); return v; }
        const stored: [number, number] = [1, 2];
        function pair(x: number): [number, number] { stored[0] = x; return stored; }
        const seat: [number, number, boolean] = [0, 0, true];
        function triple(x: number): [number, number, boolean] { seat[1] = x; return seat; }
    `;
    for (const destructuring of [
        "const [a = note(4), b] = flag ? triple(x) : pair(x); return a + b;",
        "let a = 0, b = 0; [a, b] = flag ? triple(x) : pair(x); return a + b;",
        "const [a, ...rest] = flag ? triple(x) : pair(x); return a + rest.length;",
    ])
        assert.throws(
            () =>
                compileSource(
                    `${shapes} function run(x: number, flag: boolean): number { ${destructuring} } const runs: Array<typeof run> = [run]; if (runs[0]!(1, true) < 0) throw new Error('x');`,
                ),
            /is a copy, and the program changes the elements of such arrays/,
        );
});

// A spread copies a field only to have a later property replace it.
check(
    "spread-fields-a-later-property-replaces",
    `
    interface Span { ax: number; bx: number; banked: boolean; stepYA?: number; stepYB?: number; tint?: [number, number, number] }
    function split(span: Span, cuts: number[]): Span[] {
        const bounds = [0, ...cuts, 1];
        const segs: Span[] = [];
        for (let i = 0; i + 1 < bounds.length; i++)
            segs.push({ ...span, ax: bounds[i]!, bx: bounds[i + 1]!, banked: i === 0 ? span.banked : false, stepYA: undefined, stepYB: undefined });
        for (let i = 0; i + 1 < segs.length; i++) segs[i]!.stepYB = i;
        return segs;
    }
    const stored: Array<typeof split> = [split];
    const tint: [number, number, number] = [1, 2, 3];
    const s = stored[0]!({ ax: 0, bx: 1, banked: true, stepYA: 4, tint }, [0.5]);
    if (s.length !== 2 || s[0]!.stepYA !== undefined || s[0]!.stepYB !== 0 || s[1]!.stepYB !== undefined) throw new Error("replaced fields");
    if (s[1]!.tint !== tint || s[1]!.banked || !s[0]!.banked || s[1]!.ax !== 0.5) throw new Error("copied fields");
`,
);

check(
    "bound-arguments-lead-each-call-including-into-a-rest-parameter",
    `
    type Box = { n: number };
    const box: Box = { n: 3 };
    function scale(this: Box, factor: number, offset: number): number { return this.n * factor + offset; }
    const twice = scale.bind(box, 2);
    const first = twice(1);
    box.n = 4;
    function collect(this: Box, first: string, ...rest: number[]): string { rest.push(this.n); return first + rest.join(); }
    const gather = collect.bind(box, "x", 1, 2);
    const head = collect.bind(box, "y");
    let trace = "";
    function arg(label: string, value: number): number { trace += label; return value; }
    function receiver(): Box { trace += "R"; return box; }
    const ordered = scale.bind(receiver(), arg("A", 1), arg("B", 2));
    const count = (...values: number[]): number => values.length;
    const counts = [count];
    const counted = counts[0]!.bind(undefined, 1);
    function lanes(this: Box, a: number, b?: string, ...rest: number[]): string { return a + (b ?? "-") + rest.join() + this.n; }
    const inferred = [lanes.bind(box)];
    inferred.push(lanes.bind({ n: 8 }));
    const partial = new Map([["f", lanes.bind(box, 1)]]);
    if (first !== 7 || twice(0) !== 8 || gather(3) !== "x1,2,3,4" || gather() !== "x1,2,4" || head(5, 6) !== "y5,6,4")
        throw new Error("bound arguments");
    if (trace !== "RAB" || ordered() !== 6 || counted(2) !== 2 || counted() !== 1)
        throw new Error("bind order and plain rest " + trace);
    if (inferred[0]!(1) !== "1-4" || inferred[1]!(2, "x", 3, 4) !== "2x3,48" || partial.get("f")!("y", 5) !== "1y54")
        throw new Error("tuple lanes");
`,
);

check(
    "an element after a spread is read at its shifted index",
    `
    const xs = [2, 3];
    const picked = [1, ...xs, 5][2];
    if (picked !== 3) throw new Error(String(picked));
    `,
);

check(
    "a write through an object destructuring reaches the literal's record",
    `
    function second(): number {
        const record = { a: { v: 1 }, b: { v: 2 } };
        const { b } = record;
        b.v = 7;
        return record.b.v;
    }
    if (second() !== 7) throw new Error("object alias");
    `,
);

check(
    "a write through an array destructuring reaches the literal's record",
    `
    function second(): number {
        const values = [{ v: 1 }, { v: 2 }];
        const [, second] = values;
        second!.v = 7;
        return values[1]!.v;
    }
    if (second() !== 7) throw new Error("element alias");
    `,
);

check(
    "an array rest binding shifts its indices",
    `
    function second(): number {
        const values = [{ v: 1 }, { v: 2 }];
        const [, ...rest] = values;
        rest[0]!.v = 7;
        return values[1]!.v;
    }
    if (second() !== 7) throw new Error("rest not shifted");
    `,
);

check(
    "an array rest assignment shifts its indices",
    `
    function second(): number {
        const values = [{ v: 1 }, { v: 2 }];
        let first: { v: number } = { v: 0 };
        let rest: { v: number }[] = [];
        [first, ...rest] = values;
        rest[0]!.v = 7;
        return values[1]!.v + first.v;
    }
    if (second() !== 8) throw new Error("rest assignment");
    `,
);

check(
    "a write through an assigned destructuring reaches the literal's record",
    `
    function f(): number {
        const record = { a: { v: 1 }, b: { v: 2 } };
        let b = { v: 0 };
        ({ b } = record);
        b.v = 7;
        return record.b.v;
    }
    if (f() !== 7) throw new Error("assigned destructuring");
    `,
);

check(
    "a spread copy shares the objects its source holds",
    `
    function main(): void {
        const inner = { n: 1 };
        const o = { inner };
        const c = { ...o };
        c.inner.n = 5;
        const d = { ...c, extra: 1 };
        d.inner.n += 1;
        const leaf = { n: 1 };
        const top = { mid: { leaf } };
        const copy = { ...top };
        copy.mid.leaf.n = 6;
        if (inner.n !== 6 || o.inner.n !== 6 || leaf.n !== 6) throw new Error("spread member " + inner.n + " " + leaf.n);
        const state = { x: 1 };
        const own = { ...state };
        own.x = 9;
        if (state.x !== 1) throw new Error("spread own slot");
    }
    main();
    `,
);

check(
    "a callee writing a spread copy's member writes the source's object",
    `
    function write(q: { inner: { x: number } }): void { q.inner.x += 7; }
    function pass(p: { inner: { x: number } }): void { write(p); }
    function first(p: { a: { n: number }; b: { n: number } }): void { const v = Object.values(p)[0]!; v.n = 8; }
    function setOwn(p: { x: number; inner: { y: number } }): number { p.x = 9; return p.x + p.inner.y; }
    function main(): void {
        const obj = { inner: { x: 1 } };
        write({ ...obj });
        pass({ ...obj });
        const pair = { a: { n: 1 }, b: { n: 2 } };
        first({ ...pair });
        const own = { x: 1, inner: { y: 2 } };
        const sum = setOwn({ ...own });
        if (obj.inner.x !== 15 || pair.a.n !== 8 || own.x !== 1 || sum !== 11) throw new Error("copy writes " + obj.inner.x + " " + pair.a.n + " " + own.x);
    }
    main();
    `,
);

check(
    "a-conditionally-spread-key-is-own-only-where-its-arm-wrote-it",
    `
    interface Rect { kind: "rect"; cx: number; halfW: number; grow?: number }
    interface Circle { kind: "circle"; x: number; radius: number; grow?: number }
    type Boundary = Rect | Circle;
    interface Body { cx: number; halfW: number }
    const gate = new Float32Array([0.5, 0]);
    const rectBoundary = (fp: Body, grow = 0): Rect => ({ kind: "rect", cx: fp.cx, halfW: fp.halfW, ...(grow !== 0 ? { grow } : {}) });
    function bodyWidth(body: Body): number { return body.halfW * 2; }
    function reach(b: Boundary): number { return (b.kind === "rect" ? b.halfW : b.radius) + (b.grow ?? 0); }
    const grown = rectBoundary({ cx: 0, halfW: 1 }, gate[0]!);
    const plain = rectBoundary({ cx: 0, halfW: 2 }, gate[1]!);
    const hosts: Boundary[] = [grown, plain, { kind: "circle", x: 0, radius: 3 }];
    const total = hosts.reduce((sum, host) => sum + reach(host), 0) + bodyWidth(grown) + bodyWidth(plain);
    if (total !== 12.5 || !("grow" in grown) || "grow" in plain || Object.keys(plain).length !== 3) throw new Error("total " + total);
`,
);
