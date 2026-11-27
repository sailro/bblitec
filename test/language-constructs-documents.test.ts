import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { runGeneratedProgram } from "./native-fixture.js";
import {
    check,
    checkInRealm,
    executeGeneratedAssertions,
    native,
} from "./language-constructs.js";

check(
    "object-prototype-own-property-call",
    `
    const entries: Record<string, number> = {first: 2, second: 3};
    delete entries["first"];
    const keys = ["first", "second", "toString", "missing"];
    let found = "";
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(entries, key)) found += key;
    }
    if (found !== "second") throw new Error("own property membership");
    let calls = 0;
    function owner(): Record<string, number> { calls++; return entries; }
    if (!Object.prototype.hasOwnProperty.call(owner(), "second") || calls !== 1) throw new Error("own property effects");
`,
);

check(
    "plain-record-membership-distinguishes-inherited-and-own-keys",
    `
    interface Row { value: number }
    function inspect(row: Row): number {
        if (Object.hasOwn(row, "toString") || Object.hasOwn(row, "constructor"))
            throw new Error("inherited names are not own keys");
        if (!("toString" in row) || !("constructor" in row))
            throw new Error("inherited names remain present");
        if (!Object.hasOwn(row, "value") || !("value" in row) || Object.hasOwn(row, "missing") || "missing" in row)
            throw new Error("declared and absent own keys");
        return row.value;
    }
    const inspectors: Array<typeof inspect> = [inspect];
    const rows: Row[] = [{ value: 3 }];
    if (inspectors[0]!(rows[0]!) !== 3) throw new Error("stored record membership");
`,
);

check(
    "rebound-readonly-arrays-own-their-arrays",
    `
    interface Surface { y: number; holes: readonly number[]; }
    const NO_HOLES: readonly number[] = Object.freeze([]);
    const NONE: readonly Surface[] = Object.freeze([]);
    function profile(kind: number): { tops: readonly Surface[]; envelope: readonly Surface[] } {
        const wall: Surface = { y: 1, holes: NO_HOLES };
        let tops: readonly Surface[];
        let envelope: readonly Surface[];
        switch (kind) {
            case 0:
                tops = NONE;
                envelope = [wall, { y: 2, holes: NO_HOLES }];
                break;
            default:
                tops = [{ y: kind, holes: NO_HOLES }];
                envelope = [wall];
                break;
        }
        return { tops, envelope };
    }
    const flat = profile(3);
    const pitched = profile(0);
    if (flat.tops.length !== 1 || flat.tops[0]!.y !== 3 || pitched.tops.length !== 0) throw new Error("assigned arrays");
    if (pitched.envelope.length !== 2 || flat.envelope[0]!.y !== 1) throw new Error("assigned literals");
    if (pitched.tops !== NONE || profile(0).tops !== pitched.tops) throw new Error("shared constant identity");
    interface Fact { key: string; score: number; }
    function createStore(read: () => readonly Fact[]) {
        let candidates: readonly Fact[] = [];
        let current: readonly Fact[] = [];
        return {
            refresh(): readonly Fact[] {
                candidates = read();
                current = candidates.filter((fact) => fact.score > 0);
                return current;
            },
            list: () => current,
            candidates: () => candidates,
        };
    }
    const source: Fact[] = [{ key: "a", score: 1 }, { key: "b", score: 0 }];
    const store = createStore(() => source);
    if (store.list().length !== 0 || store.candidates().length !== 0) throw new Error("initial arrays");
    const published = store.refresh();
    if (store.candidates() !== source || store.list() !== published || published.length !== 1) throw new Error("rebound identity");
    source.push({ key: "c", score: 2 });
    source[0]!.score = 9;
    if (store.candidates().length !== 3 || store.list()[0]!.score !== 9) throw new Error("alias after rebinding");
    let members: readonly number[] = [];
    const before = members;
    const next = [1, 2];
    members = next;
    next.push(3);
    if (members.length !== 3 || before.length !== 0 || members === before) throw new Error("rebinding copies");
`,
);

test("arms that type one field with records of their own each hold their record", async (t) => {
    // Two arms give `host` different records and a third lacks it; values
    // come back through a reassigned function slot, whose signature needs
    // the union's storage.
    const source = `
        interface A { readonly kind: "a"; readonly host: { readonly id: number; readonly x: number } }
        interface B { readonly kind: "b"; readonly host: { readonly id: number; readonly y: string } }
        interface C { readonly kind: "c"; readonly r: number }
        type U = A | B | C;
        const late = { f: (() => []) as () => readonly U[] };
        late.f = () => [{ kind: "a", host: { id: 1, x: 7 } }, { kind: "b", host: { id: 2, y: "q" } }, { kind: "c", r: 3 }];
        const list = late.f();
        const text = list.map((v) => v.kind === "a" ? "a" + v.host.x : v.kind === "b" ? "b" + v.host.y : "c" + v.r).join(",");
        if (text !== "a7,bq,c3") throw new Error("arm fields " + text);
        let ids = 0;
        for (const v of list) if (v.kind !== "c") ids += v.host.id;
        if (ids !== 3) throw new Error("shared field " + ids);
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    await executeGeneratedAssertions(t, "arm-record-fields", result.cpp);
});

check(
    "closed-record-own-keys-and-keyed-literals",
    `
    const KINDS = ["deer", "rabbit", "fox"] as const;
    type Kind = (typeof KINDS)[number];
    const DEFS: Record<Kind, { speed: number }> = { deer: { speed: 2 }, rabbit: { speed: 3 }, fox: { speed: 4 } };
    const isKind = (value: string): value is Kind => Object.prototype.hasOwnProperty.call(DEFS, value);
    const kinds = ["deer", "wolf", "toString", "fox"].filter(isKind);
    if (kinds.join(",") !== "deer,fox" || DEFS[kinds[1]!].speed !== 4 || !Object.hasOwn(DEFS, "rabbit")) throw new Error("own keys");
    type Scheme = "classic" | "wasd";
    type Action = "nature" | "build";
    type Profile = Record<Action, string>;
    const DEFINITIONS: readonly { action: Action; defaults: Record<Scheme, string> }[] = [
        { action: "nature", defaults: { classic: "n", wasd: "1" } },
        { action: "build", defaults: { classic: "b", wasd: "2" } },
    ];
    const profileOf = (scheme: Scheme): Profile =>
        Object.fromEntries(DEFINITIONS.map((definition) => [definition.action, definition.defaults[scheme]])) as Profile;
    interface Preferences { scheme: Scheme; shortcuts: Record<Scheme, Profile>; }
    let current: Preferences = { scheme: "classic", shortcuts: { classic: profileOf("classic"), wasd: profileOf("wasd") } };
    const clone = (preferences: Preferences): Preferences =>
        ({ scheme: preferences.scheme, shortcuts: { classic: { ...preferences.shortcuts.classic }, wasd: { ...preferences.shortcuts.wasd } } });
    const reset = (scheme: Scheme): void => { current = { ...current, shortcuts: { ...current.shortcuts, [scheme]: profileOf(scheme) } }; };
    const copy = clone(current);
    copy.shortcuts.classic.nature = "x";
    if (current.shortcuts.classic.nature !== "n" || copy.shortcuts.classic.build !== "b") throw new Error("view spread");
    current.shortcuts.wasd.build = "9";
    reset("wasd");
    if (current.shortcuts.wasd.build !== "2" || current.shortcuts.classic.nature !== "n") throw new Error("keyed record");
    if (Object.values(current.shortcuts.classic).join(",") !== "n,b") throw new Error("view values");
    interface Production { logs: number; pots: number; crates: number; }
    const TALLY: Partial<Record<"wood" | "pot" | "egg", keyof Production>> = { wood: "logs", pot: "pots" };
    let produced: Production = { logs: 0, pots: 0, crates: 0 };
    const note = (kind: "wood" | "pot" | "egg"): boolean => {
        const key = TALLY[kind];
        if (key === undefined) return false;
        produced = { ...produced, [key]: produced[key] + 1 };
        return true;
    };
    note("wood"); note("wood"); note("pot"); note("egg");
    if (JSON.stringify(produced) !== '{"logs":2,"pots":1,"crates":0}') throw new Error("keyed spread");
    interface Params { tint: string; scale: number; relief: number; }
    let params: Params = { tint: "red", scale: 1, relief: 2 };
    const seen: string[] = [];
    const setParams = (p: Partial<Params>): void => { seen.push(Object.keys(p).join("+")); params = { ...params, ...p }; };
    const apply = (key: Exclude<keyof Params, "tint">, value: number): void => { setParams({ [key]: value }); };
    const appliers: Array<(key: Exclude<keyof Params, "tint">, value: number) => void> = [apply];
    const keys: Array<Exclude<keyof Params, "tint">> = ["relief", "scale"];
    appliers[0]!(keys[0]!, 5);
    appliers[0]!(keys[1]!, 3);
    if (params.scale !== 3 || params.relief !== 5 || params.tint !== "red" || seen.join("|") !== "relief|scale") throw new Error("keyed literal");
`,
);

test("a run-time key selecting fields of different types refuses", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Mixed { count: number; label: string; }
            let mixed: Mixed = { count: 1, label: "a" };
            const keys: Array<keyof Mixed> = ["count"];
            const write = (key: keyof Mixed): void => { mixed = { ...mixed, [key]: 2 }; };
            const writers: Array<(key: keyof Mixed) => void> = [write];
            writers[0]!(keys[0]!);
            if (mixed.count !== 2) throw new Error("count");
            `),
        /Dynamic struct keys must select fields with one common data type/,
    );
});

check(
    "run-time-key-over-a-record-lacking-some-of-its-keys",
    `
    type Lang = "en" | "fr" | "de";
    type Names = Partial<Record<Lang, string>>;
    function nameFor(entry: { name: string; names?: Names }, lang: Lang): string {
        return entry.names?.[lang] ?? entry.name;
    }
    const stone = { name: "Stone", names: { fr: "Pierre" } };
    const bare = { name: "Bare", names: {} };
    const counts = { en: 1, de: 3 };
    const countFor = (table: Partial<Record<Lang, number>>, lang: Lang): number => table[lang] ?? 0;
    const langs: Lang[] = ["en", "fr", "de"];
    const out: string[] = [];
    for (const lang of langs) out.push(nameFor(stone, lang), nameFor(bare, lang), String(countFor(counts, lang)));
    if (out.join("|") !== "Stone|Bare|1|Pierre|Bare|0|Stone|Bare|3") throw new Error(out.join("|"));
`,
);

check(
    "fixed-field-views-written-by-literal-keys",
    `
    interface Mutable { [key: string]: unknown; }
    interface SaveData { version: number; season?: number; seasonPhase?: number; name: string; towers: { id: number }[]; }
    const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
    function clampScalars(save: SaveData, repaired: string[]): void {
        const mutable = save as unknown as Mutable;
        const clampUnitField = (key: "season" | "seasonPhase"): void => {
            const value = save[key];
            if (value === undefined) return;
            if (!Number.isFinite(value) || value < 0 || value > 1) {
                mutable[key] = clamp01(Number.isFinite(value) ? value : 0);
                repaired.push(key);
            }
        };
        clampUnitField("season");
        clampUnitField("seasonPhase");
    }
    const described = (save: SaveData, keys: readonly string[]): string[] =>
        keys.filter((key) => (save as unknown as Mutable)[key] !== undefined);
    function rename(save: SaveData): void {
        const alias = save;
        alias.name = alias.name.toUpperCase();
    }
    const saves: SaveData[] = [{ version: 1, season: 3, name: "a", towers: [] }, { version: 2, seasonPhase: -1, name: "b", towers: [{ id: 1 }] }];
    const repaired: string[] = [];
    for (const save of saves) { clampScalars(save, repaired); rename(save); }
    if (saves[0]!.season !== 1 || saves[1]!.seasonPhase !== 0 || repaired.join() !== "season,seasonPhase") throw new Error("view writes");
    if (saves[1]!.name !== "B") throw new Error("alias write");
    if (described(saves[1]!, ["version", "season", "seasonPhase", "towers", "missing", "toString"]).join() !== "version,seasonPhase,towers,toString")
        throw new Error("described keys");
`,
);

check(
    "literal-key-record-lookup",
    `
    type Mode = "low" | "high";
    interface Settings { amount: number; enabled: boolean; }
    const options: Readonly<Record<Mode, Settings>> = {
        low: { amount: 1, enabled: false }, high: { amount: 3, enabled: true },
    };
    const selected: Mode = "high";
    const settings = options[selected];
    if (settings.amount !== 3 || !settings.enabled) throw new Error("literal key lookup");
`,
);

checkInRealm(
    "structured-clone-copies-data",
    `
    interface Row { a: number[]; name: string; when?: Date }
    const shared = [1, 2];
    const r: { left: Row; right: Row; map: Map<string, number>; bytes: Uint8Array } = {
        left: { a: shared, name: "l" }, right: { a: shared, name: "r", when: new Date(5) },
        map: new Map([["k", 1]]), bytes: new Uint8Array([1, 2, 3]),
    };
    const c = structuredClone(r);
    c.left.a.push(3);
    if (r.left.a.length !== 2 || c.right.a.length !== 3 || c.left.a !== c.right.a) throw new Error("aliases");
    if (c.right.when!.getTime() !== 5 || c.right.when === r.right.when || c.map.get("k") !== 1 || c.map === r.map) throw new Error("copies");
    c.bytes[0] = 9;
    if (r.bytes[0] !== 1 || c.bytes.length !== 3) throw new Error("bytes");
    let failed = "";
    interface Holder { f?: () => number; n: number }
    const holder: Holder = { n: 1, f: () => 2 };
    try { structuredClone(holder); failed += "no-throw;"; } catch (error) { if ((error as Error).name !== "DataCloneError") failed += "name;"; }
    const plain: Holder = { n: 3 };
    if (structuredClone(plain).n !== 3) failed += "absent function;";
    if (failed) throw new Error(failed);
    globalThis.close();
`,
);

check(
    "json-parse-revivers-rewrite-members-before-holders",
    `
    const s = JSON.parse('{"a":1}', (_k, v) => v) as { a: number };
    if (s.a !== 1) throw new Error("identity reviver");
    const keys: string[] = [];
    const doubled = JSON.parse('{"x":1,"y":{"z":2},"list":[3,4],"drop":5}', (key: string, value: unknown) => {
        keys.push(key);
        if (key === "drop") return undefined;
        return typeof value === "number" ? value * 2 : value;
    }) as { x: number; y: { z: number }; list: number[]; drop?: number };
    if (doubled.x !== 2 || doubled.y.z !== 4 || doubled.list[1] !== 8 || "drop" in doubled) throw new Error("revived");
    if (keys.join(",") !== "x,z,y,0,1,list,drop,") throw new Error("order " + keys.join(","));
    const root = JSON.parse("7", (_k: string, v: unknown) => (typeof v === "number" ? v + 1 : v)) as number;
    if (root !== 8) throw new Error("root");
`,
);

checkInRealm(
    "keys-of-a-table-select-their-builder",
    `
    // A builder iterated over a constant table's keys compiles once per key.
    const KINDS = { small: { scale: 0.5, wide: false }, large: { scale: 2, wide: true } } as const;
    type Kind = keyof typeof KINDS;
    function describe(kind: Kind): string {
        const def = KINDS[kind];
        let text = "x*" + def.scale;
        if (def.wide) text = text.replace("x", "(2,1,1)*x");
        return text;
    }
    async function load(kind: Kind): Promise<string> {
        await Promise.resolve();
        return describe(kind) + "!";
    }
    async function run(): Promise<void> {
        const kinds = Object.keys(KINDS) as Kind[];
        const texts = kinds.map((kind) => describe(kind));
        const loaded = await Promise.all(kinds.map((kind) => load(kind)));
        let joined = "";
        for (const kind of kinds) joined += describe(kind) + ";";
        const all = texts.join() + "|" + loaded.join() + "|" + joined;
        if (all !== "x*0.5,(2,1,1)*x*2|x*0.5!,(2,1,1)*x*2!|x*0.5;(2,1,1)*x*2;") throw new Error(all);
        globalThis.close();
    }
    void run();
`,
);

check(
    "typed-arm-records-keep-their-own-field-in-a-tagged-union",
    `
    interface TowerHost { x: number; z: number; baseY: number }
    interface HouseHost { cx: number; cz: number; eaveY: number }
    interface Plane { kind: "plane"; px: number }
    interface Cone { readonly kind: "cone"; readonly host: TowerHost }
    interface Roof { readonly kind: "roof"; readonly host: HouseHost }
    type Carrier = Plane | Cone | Roof;
    const makeRoof = (eave: number): Roof | null => (eave > 0 ? { kind: "roof", host: { cx: 1, cz: 2, eaveY: eave } } : null);
    const makeCone = (base: number): Cone => ({ kind: "cone", host: { x: 1, z: 2, baseY: base } });
    const out: Carrier[] = [];
    out.push({ kind: "plane", px: 1 });
    const pitched = makeRoof(4);
    if (pitched) out.push(pitched);
    out.push(makeCone(3));
    let total = 0;
    for (const carrier of out) {
        if (carrier.kind === "plane") total += carrier.px;
        else if (carrier.kind === "cone") total += carrier.host.baseY;
        else total += carrier.host.eaveY;
    }
    if (total !== 8) throw new Error("total " + total);
`,
);

check(
    "fixed-record-enumeration",
    `
    type Key = "north" | "south";
    interface Entry { bounds: readonly [number, number]; }
    const table: Record<Key, Entry> = { south: { bounds: [2, 4] }, north: { bounds: [1, 3] } };
    if (Object.keys(table).join(",") !== "south,north") throw new Error("key order");
    if (Object.values(table).map(entry => entry.bounds[1]).join(",") !== "4,3") throw new Error("value order");
    const pairs = Object.entries(table);
    if (pairs[0][0] !== "south" || pairs[0][1] !== table.south) throw new Error("entry identity");
    function width(key: Key): number { return table[key].bounds[1] - table[key].bounds[0]; }
    const largest = Math.max(...(Object.keys(table) as Key[]).map(key => width(key) * table[key].bounds[1]));
    if (largest !== 8) throw new Error("typed key callbacks");
`,
);

check(
    "literal-union-key-over-layouts-of-different-shapes",
    `
    type Kind = "keg-display" | "beer-display";
    const LAYOUTS = {
        "keg-display": { itemDisplayScale: 2, capacity: 2, slots: [{ pitch: 0 }, { pitch: 1 }], kegs: 3 },
        "beer-display": { itemDisplayScale: 3, capacity: 1, slots: [{ pitch: 2 }] },
    };
    function scaleOf(kind: Kind, propScale: number): number { return LAYOUTS[kind].itemDisplayScale * propScale; }
    function slotOf(kind: Kind, slot: number): number {
        const { slots, capacity } = LAYOUTS[kind];
        return slots[((slot % capacity) + capacity) % capacity]!.pitch;
    }
    const kinds: Kind[] = ["keg-display", "beer-display"];
    const read = [scaleOf(kinds[0]!, 2), scaleOf(kinds[1]!, 2), slotOf(kinds[0]!, 3), slotOf(kinds[1]!, 5)];
    if (read.join(",") !== "4,6,1,2") throw new Error("layouts " + read.join(","));
`,
);

check(
    "document-view-first-made-in-a-short-circuit-is-made-again-after-it",
    `
    function count(values: readonly unknown[]): number {
      let n = 0;
      for (const v of values) if (v !== undefined) n++;
      return n;
    }
    const schema: unknown[] = [1, "x", undefined];
    const config = { depth: 2, name: "n" };
    const probe = (value: unknown): boolean => value !== null && typeof value === "object";
    const seen: number[] = [];
    seen.push(schema.length);
    if (seen[0] !== 3 || count(schema) !== 2) throw new Error("n " + count(schema));
    if (seen.length !== 1 || !probe(config)) throw new Error("record " + probe(config));
    if (!probe(config) || !probe(schema)) throw new Error("views");
`,
);

check(
    "record-members-written-by-runtime-keys-and-replaced-by-documents",
    `
    type Doc = Record<string, unknown>;
    type Kind = "first" | "second";
    interface KindState {
        doc: Doc | null;
        error: string | null;
        dirty: boolean;
        flags: Record<string, boolean>;
        nums: Record<string, number>;
    }
    const REGISTRY: Record<Kind, { flags: readonly string[]; nums: readonly string[] }> = {
        first: { flags: ["awake", "fed"], nums: ["age"] },
        second: { flags: ["awake"], nums: ["age", "hunger"] },
    };
    const SEEDS: Record<string, number> = { age: 2 };
    function freshState(): KindState {
        return { doc: null, error: null, dirty: false, flags: {}, nums: {} };
    }
    const state: Record<Kind, KindState> = { first: freshState(), second: freshState() };
    function seed(st: KindState, k: Kind): void {
        const reg = REGISTRY[k];
        for (const f of reg.flags) {
            if (!(f in st.flags)) st.flags[f] = false;
        }
        for (const n of reg.nums) {
            if (!(n in st.nums)) st.nums[n] = SEEDS[n] ?? 0;
        }
    }
    function load(k: Kind, text: string): void {
        const st = state[k];
        st.doc = JSON.parse(text) as Doc;
        st.dirty = true;
        seed(st, k);
    }
    load("first", '{"rules":[1,2]}');
    load("second", '{"rules":[]}');
    state.first.flags.awake = true;
    seed(state.first, "first");
    if (state.first.flags.awake !== true || state.first.flags.fed !== false || state.second.nums.age !== 2 || state.second.nums.hunger !== 0)
        throw new Error("seeded");
    if (state.first.doc === null || JSON.stringify(state.first.doc) !== '{"rules":[1,2]}' || !state.second.dirty)
        throw new Error("documents");
    if (Object.keys(state.second.flags).join() !== "awake" || Object.keys(state.first.nums).join() !== "age") throw new Error("keys");
    `,
);

test("a literal read through its own type and a growable field keep their refusals", () => {
    assert.throws(
        () =>
            compileSource(`
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
                if (!hit) return null;
                const own = { point: hit.point, body: null };
                return own.point.length === 3 ? own : null;
            },
        });
    }
    const hits: Hit[] = [{ point: [1, 2, 3], distance: 1 }];
    const photographer = createGlade({ pick: (x) => hits[x] ?? null });
    hits[0]!.point[2] = 4;
    const first = photographer.shoot(0, 0);
    const missed = photographer.shoot(1, 0);
    if (first !== 7 || missed !== -1) throw new Error("shots " + first + " " + missed);
            `),
        /record stored as 'Sight' would be a copy of the one object JavaScript keeps/,
    );
    assert.throws(
        () =>
            compileSource(`
    interface Sight { point: number[]; label: string }
    function ray(x: number): [number, number, number] { return [x, x + 1, x + 2]; }
    function aim(x: number) {
        const sight = { point: ray(x), label: "aim" };
        return sight;
    }
    const seen: Sight = aim(Math.random() < 2 ? 1 : 0);
    const shots: Sight[] = [seen];
    shots[0]!.point.push(4);
    if (shots[0]!.point.length !== 4) throw new Error("grown");
            `),
        /A fixed-length tuple stored as a number array could grow through that array/,
    );
});

test("read-only closed-key records refuse what their copies would observe", () => {
    const table =
        'type Lang = "en" | "fr"; const TABLES: Record<Lang, number> = { en: 1, fr: 2 }; function shipped(): Readonly<Record<Lang, number>> { return TABLES; } const view = shipped();';
    for (const [source, message] of [
        [
            `${table} TABLES.fr = 3; const unused = view.fr;`,
            /'TABLES' was copied into another data location/,
        ],
        [
            `${table} if (view !== TABLES) throw new Error("identity");`,
            /stored by value and cannot preserve JavaScript object identity/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "delete-struct-fields-by-known-key",
    `
    interface Style { tint?: number; label?: string; scale?: number; size: number }
    const setNumber = <T extends object, K extends keyof T>(target: T, key: K, value: number | undefined): void => {
        if (value === undefined) delete target[key];
        else target[key] = value as T[K];
    };
    const setTint = (target: { tint?: number }, key: "tint", value: number | null): void => {
        if (value) target[key] = value;
        else delete target[key];
    };
    const style: Style = { tint: 1, label: "a", scale: 2, size: 3 };
    const inputs = [undefined, 4];
    setNumber(style, "scale", inputs[0]);
    setTint(style, "tint", null);
    delete style["label"];
    if ("scale" in style || "tint" in style || "label" in style || style.size !== 3) throw new Error("deleted fields");
    if (Object.keys(style).join() !== "size" || JSON.stringify(style) !== '{"size":3}') throw new Error("own keys after delete");
    setNumber(style, "scale", inputs[1]);
    setTint(style, "tint", 5);
    if (style.scale !== 4 || style.tint !== 5) throw new Error("restored fields");
`,
);

check(
    "record-lookup-with-document-key",
    `
    const SIGN: Record<string, number> = { door: -1, "2": 5 };
    function sign(raw: unknown): number {
        const node = raw as { name: string };
        return SIGN[node.name] ?? 1;
    }
    const nodes = JSON.parse('[{"name":"door"},{"name":"pane"},{"name":2},{}]') as unknown[];
    const signs = nodes.map(sign);
    if (signs.join() !== "-1,1,5,1") throw new Error("document keys " + signs.join());
`,
);

check(
    "object-literal-key-order-follows-creation",
    `
    const values = [1, 2, 3, 4];
    const name = "n" + values[0], extra = values[1]!, tail = values[2]! > 2;
    const between = { name, ...{ extra }, tail };
    if (JSON.stringify(between) !== '{"name":"n1","extra":2,"tail":true}') throw new Error("between " + JSON.stringify(between));
    if (Object.keys(between).join() !== "name,extra,tail") throw new Error("keys " + Object.keys(between).join());
    const keys: string[] = [];
    for (const key in between) keys.push(key);
    if (keys.join() !== "name,extra,tail") throw new Error("for-in " + keys.join());
    const before = { ...{ extra, tail }, name };
    if (JSON.stringify(before) !== '{"extra":2,"tail":true,"name":"n1"}') throw new Error("before " + JSON.stringify(before));
    const after = { tail, name, ...{ extra } };
    if (JSON.stringify(after) !== '{"tail":true,"name":"n1","extra":2}') throw new Error("after " + JSON.stringify(after));
    const base = { a: values[0]!, b: values[1]! };
    const overwritten = { z: values[3]!, ...base, a: values[2]!, c: 0 };
    if (JSON.stringify(overwritten) !== '{"z":4,"a":3,"b":2,"c":0}' || Object.keys(overwritten).join() !== "z,a,b,c")
        throw new Error("overwritten " + JSON.stringify(overwritten));
    const spreadOver = { a: 0, q: values[0]!, ...base };
    if (JSON.stringify(spreadOver) !== '{"a":1,"q":1,"b":2}') throw new Error("spread overwrite " + JSON.stringify(spreadOver));
    const numeric = { b: 1, ...{ 2: "two", a: 0 }, 1: "one" };
    if (JSON.stringify(numeric) !== '{"1":"one","2":"two","b":1,"a":0}') throw new Error("integer keys " + JSON.stringify(numeric));
    const rows = [between];
    rows.push({ ...between, extra: values[3]! });
    const stored = rows[values[0]!]!;
    const storedKeys: string[] = [];
    for (const key in stored) storedKeys.push(key);
    if (JSON.stringify(rows) !== '[{"name":"n1","extra":2,"tail":true},{"name":"n1","extra":4,"tail":true}]' ||
        Object.keys(stored).join() !== "name,extra,tail" || storedKeys.join() !== "name,extra,tail")
        throw new Error("stored records " + JSON.stringify(rows));
`,
);

check(
    "declared-record-key-order-follows-creation",
    `
    interface Plain { a: number; b: string }
    interface Range { local: number; count: number; first: number }
    interface Retained extends Range { first: number; local: number; datum?: string }
    const values = [1, 2, 3];
    const forIn = (row: Retained): string => { const keys: string[] = []; for (const key in row) keys.push(key); return keys.join(); };
    const plain: Plain[] = [];
    plain.push({ b: "x" + values[0], a: values[1]! });
    plain.push({ b: "y", a: values[0]! });
    if (plain.map((row) => Object.keys(row).join()).join("|") !== "b,a|b,a") throw new Error("plain keys");
    if (JSON.stringify(plain) !== '[{"b":"x1","a":2},{"b":"y","a":1}]') throw new Error("plain json");
    if (Object.entries(plain[values[0]!]!).map(([key, value]) => key + "=" + value).join() !== "b=y,a=1") throw new Error("plain entries");
    const range: Omit<Range, "local"> = { count: values[0]!, first: values[1]! };
    const local = values[2]!, datum = "d" + values[0];
    const retained: Retained[] = [{ ...range, local, datum }];
    if (Object.keys(retained[0]!).join() !== "count,first,local,datum" || forIn(retained[0]!) !== "count,first,local,datum") throw new Error("spread then members");
    if (JSON.stringify(retained[0]) !== '{"count":1,"first":2,"local":3,"datum":"d1"}') throw new Error("spread then members json");
    const ranges: Range[] = [];
    ranges.push({ local, ...range });
    ranges.push({ local: values[0]!, ...range, count: values[2]! });
    if (ranges.map((row) => Object.keys(row).join()).join("|") !== "local,count,first|local,count,first") throw new Error("members then spread");
    if (JSON.stringify(ranges) !== '[{"local":3,"count":1,"first":2},{"local":1,"count":3,"first":2}]') throw new Error("members then spread json");
`,
);

check(
    "spread-of-a-method-record-keeps-its-key-order",
    `
    interface Binding { readonly id: number; dispose(): void; project(out: number[], x: number): boolean }
    class Frame {
        private live = 0;
        bind(id: number): Binding {
            this.live++;
            const binding: Binding = { id, project(out, x) { out[0] = x + id; return true; }, dispose: () => { this.live--; } };
            return binding;
        }
        count(): number { return this.live; }
    }
    const frame = new Frame();
    const ranges = new Map<Binding, number>();
    function retain(id: number): Binding {
        const binding = frame.bind(id);
        const retained = { ...binding };
        ranges.set(retained, id);
        return retained;
    }
    const kept = retain(4);
    const out = [0];
    if (!kept.project(out, 1) || out[0] !== 5 || ranges.get(kept) !== 4) throw new Error("members");
    if (Object.keys(kept).join() !== "id,project,dispose") throw new Error("keys " + Object.keys(kept).join());
    kept.dispose();
    if (frame.count() !== 0) throw new Error("dispose");
`,
);

check(
    "declared-record-key-order-indices-conversions-and-copies",
    `
    interface Indexed { b: number; 2: string; a: number; 1: string }
    interface Pair { a: number; b: number }
    const values = [1, 2, 3];
    const indexed: Indexed[] = [];
    indexed.push({ b: values[0]!, 2: "two", a: values[1]!, 1: "one" });
    if (Object.keys(indexed[0]!).join() !== "1,2,b,a") throw new Error("index keys");
    if (JSON.stringify(indexed[0]) !== '{"1":"one","2":"two","b":1,"a":2}') throw new Error("index json");
    const literal = { b: values[0]!, a: values[1]! };
    const converted: Pair = literal;
    const pairs: Pair[] = [converted];
    const source = pairs[0]!;
    if (Object.keys(source).join() !== "b,a") throw new Error("converted keys");
    const copy = { ...source, extra: values[2]! };
    if (Object.keys(copy).join() !== "b,a,extra") throw new Error("copy keys");
    const before = { extra: values[2]!, ...source };
    if (JSON.stringify(before) !== '{"extra":3,"b":1,"a":2}') throw new Error("copy json");
    const dictionary: Record<string, number> = { ...source };
    if (Object.keys(dictionary).join() !== "b,a") throw new Error("dictionary keys");
    if (JSON.stringify({ pairs }) !== '{"pairs":[{"b":1,"a":2}]}') throw new Error("nested json");
    interface Kept { a: number; b: string; c?: number }
    let state: Kept = { b: "x", a: values[0]! };
    const kept: Kept[] = [state];
    state = { ...state, a: values[1]! };
    kept.push(state);
    state = { ...state, c: values[2]! };
    kept.push(state);
    if (kept.map((row) => Object.keys(row).join()).join("|") !== "b,a|b,a|b,a,c") throw new Error("respread keys");
    if (JSON.stringify(kept) !== '[{"b":"x","a":1},{"b":"x","a":2},{"b":"x","a":2,"c":3}]') throw new Error("respread json");
`,
);

check(
    "declared-record-key-order-per-record-where-creations-disagree",
    `
    interface Pair { a: number; b: string }
    interface State { a: number; b: string; c?: number }
    interface Flagged { c: number; b?: number; a: number }
    const values = [1, 2, 3];
    const first: Pair = { a: values[0]!, b: "x" };
    const second: Pair = { b: "y", a: values[1]! };
    const pairs: Pair[] = [first, second];
    if (pairs.map((row) => Object.keys(row).join()).join("|") !== "a,b|b,a") throw new Error("two literal orders");
    if (JSON.stringify(pairs) !== '[{"a":1,"b":"x"},{"b":"y","a":2}]') throw new Error("two literal orders json");
    let state: State = { b: "x", a: values[0]! };
    const states: State[] = [state];
    state = { ...state, c: values[2]! };
    states.push(state, { c: values[1]!, b: "y", a: values[0]! });
    if (states.map((row) => Object.keys(row).join()).join("|") !== "b,a|b,a,c|c,b,a") throw new Error("a key created later");
    const flag = values.length > 1;
    const flagged: Flagged[] = [];
    flagged.push({ a: values[0]!, ...(flag ? { b: values[1]! } : {}), c: values[2]! });
    flagged.push({ a: values[1]!, c: values[0]! });
    if (flagged.map((row) => Object.keys(row).join()).join("|") !== "a,b,c|a,c") throw new Error("conditional spread");
    if (JSON.stringify(flagged) !== '[{"a":1,"b":2,"c":3},{"a":2,"c":1}]') throw new Error("conditional spread json");
`,
);

check(
    "declared-record-key-order-through-definitions-and-copies-of-each-other",
    `
    interface Token { readonly key: number }
    interface Row { height: number; tower: number }
    const values = [1, 2, 3];
    function attach<T extends object>(row: T, id: Token): T & { readonly id: Token } {
        const item = { ...row } as T & { readonly id: Token };
        Object.defineProperty(item, "id", { value: id, enumerable: true, writable: false, configurable: false });
        return item;
    }
    const row: Row = { tower: values[0]!, height: values[1]! };
    const tagged = [attach(row, { key: values[2]! })];
    const { id: _id, ...rest } = tagged[0]!;
    if (Object.keys(rest).join() !== "tower,height") throw new Error("rest keys");
    tagged.push(attach(rest, { key: values[0]! }));
    if (tagged.map((item) => Object.keys(item).join()).join("|") !== "tower,height,id|tower,height,id") throw new Error("defined and copied keys");
    if (JSON.stringify(tagged) !== '[{"tower":1,"height":2,"id":{"key":3}},{"tower":1,"height":2,"id":{"key":1}}]') throw new Error("defined and copied json");
`,
);

test("records no document holds refuse an enumeration their creations order apart", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Pair { a: number; readonly b: number }
            const values = [1, 2];
            const pairs: Pair[] = [];
            pairs.push({ a: values[0]!, get b() { return 2; } });
            pairs.push({ get b() { return 3; }, a: values[1]! });
            console.log(Object.keys(pairs[0]!).join());
            `),
        /'Pair' records create their own keys in different orders; enumerating them requires each record's own order/,
    );
});

check(
    "union-arms-keep-nested-records-of-their-own-types",
    `
    const archiveTypes = [{ description: "Archive", accept: { "application/zip": [".zip"] } }];
    const plainTypes = [{ description: "Plain", accept: { "application/json": [".json"] } }];
    const saveTypes = [...archiveTypes, ...plainTypes];
    const openTypes = saveTypes;
    if (saveTypes[0] !== archiveTypes[0] || openTypes[1] !== plainTypes[0]) throw new Error("spread elements keep their objects");
    saveTypes[0]!.description = "Zip";
    if (archiveTypes[0]!.description !== "Zip") throw new Error("write through the union");
    const accept = saveTypes[1]!.accept;
    if (accept !== plainTypes[0]!.accept || !("application/json" in accept) || "application/zip" in accept) throw new Error("nested record of each arm");
    plainTypes[0]!.accept["application/json"].push(".txt");
    if (Object.keys(saveTypes[0]!.accept).join() !== "application/zip" || Object.keys(accept).join() !== "application/json") throw new Error("nested keys");
    if (JSON.stringify(openTypes) !== '[{"description":"Zip","accept":{"application/zip":[".zip"]}},{"description":"Plain","accept":{"application/json":[".json",".txt"]}}]') throw new Error("json " + JSON.stringify(openTypes));
`,
);

check(
    "conditional-arms-of-own-fields-stay-one-object",
    `
    interface TowerRoof { x: number; z: number; yaw: number; baseY: number; baseRadius: number }
    type Host =
        | { readonly kind: "cone"; readonly roof: TowerRoof; readonly radius: number }
        | { readonly kind: "flat"; readonly x: number; readonly z: number; readonly yaw: number; readonly y: number; readonly radius: number };
    function frameOf(host: Host) { return host.kind === "cone" ? host.roof : host; }
    const roof: TowerRoof = { x: 1, z: 2, yaw: 0, baseY: 3, baseRadius: 4 };
    const hosts: Host[] = [{ kind: "cone", roof, radius: 1 }, { kind: "flat", x: 5, z: 6, yaw: 0, y: 7, radius: 2 }];
    const frames = hosts.map(frameOf);
    if (frames[0] !== roof || frames[1] !== hosts[1]) throw new Error("selected objects");
    roof.x = 10;
    if (frames[0]!.x + frames[1]!.z !== 16) throw new Error("reads through the frame");
    if (Object.keys(frames[0]!).join() !== "x,z,yaw,baseY,baseRadius" || Object.keys(frames[1]!).join() !== "kind,x,z,yaw,y,radius") throw new Error("keys");
`,
);

// A record type the program reads parsed documents as is stored as a
// document: its records keep their own fields and identity, and a literal
// of the type is an owned document.
check(
    "parsed-documents-stored-as-their-record-types",
    `
    interface Meta { description?: string; savedAt?: number }
    interface Contents { save: string; meta?: Meta | null }
    function decodeMeta(text: string | undefined): Meta | null {
        if (!text) return null;
        try {
            const m = JSON.parse(text) as Meta;
            return m && typeof m === "object" ? m : null;
        } catch {
            return null;
        }
    }
    function unpack(save: string, meta: string | undefined): Contents { return { save, meta: decodeMeta(meta) }; }
    const unpackers: Array<typeof unpack> = [unpack];
    const contents = unpackers[0]!("save", '{"description":"d","savedAt":5,"extra":1}');
    if (contents.meta?.description !== "d" || contents.meta.savedAt !== 5) throw new Error("fields");
    if (JSON.stringify(contents.meta) !== '{"description":"d","savedAt":5,"extra":1}') throw new Error("kept keys");
    if (unpackers[0]!("s", undefined).meta !== null || unpackers[0]!("s", "{").meta !== null || unpackers[0]!("s", "3").meta !== null)
        throw new Error("absent meta");
    const made: Meta = { description: "x" };
    made.savedAt = 5;
    const list: Meta[] = [made, contents.meta!];
    list[0]!.description = "y";
    list[1]!.savedAt = 2;
    if (made.description !== "y" || list[0] !== made || contents.meta!.savedAt !== 2) throw new Error("identity");
    if (JSON.stringify(list) !== '[{"description":"y","savedAt":5},{"description":"d","savedAt":2,"extra":1}]') throw new Error(JSON.stringify(list));
    interface RawNode { name?: string; mesh?: number; children?: number[] }
    interface RoleMesh { node: RawNode; role: string }
    function roles(text: string): string {
        const nodes = (JSON.parse(text) as { nodes?: RawNode[] }).nodes ?? [];
        const out: RoleMesh[] = [];
        const gather = (index: number, role: string): void => {
            const n = nodes[index]!;
            if (n.mesh !== undefined) out.push({ node: n, role });
            for (const c of n.children ?? []) gather(c, n.name === "shutter" ? "shutter" : role);
        };
        gather(0, "leaf");
        return out.map((r) => (r.node === nodes[r.node.mesh!] ? "" : "!") + r.role + r.node.mesh).join();
    }
    const gatherers: Array<typeof roles> = [roles];
    if (gatherers[0]!('{"nodes":[{"children":[1,2]},{"name":"shutter","mesh":1,"children":[2]},{"mesh":2}]}') !== "leaf1,shutter2,leaf2")
        throw new Error("nodes");
`,
);

// A closed Record is written by JSON.stringify keys in its union's order,
// which every record of the union in the program is created in.
check(
    "closed-records-written-as-json",
    `
    type Scheme = "wasd" | "classic";
    type Action = "run" | "jump";
    interface Prefs { scheme: Scheme; shortcuts: Record<Scheme, Record<Action, string>>; note?: Record<Action, number> }
    function save(prefs: Prefs): string { return JSON.stringify(prefs); }
    const savers: Array<typeof save> = [save];
    const first: Prefs = { scheme: "wasd", shortcuts: { classic: { jump: "j", run: "r" }, wasd: { jump: "space", run: "shift" } } };
    const text = savers[0]!(first);
    if (text !== '{"scheme":"wasd","shortcuts":{"classic":{"jump":"j","run":"r"},"wasd":{"jump":"space","run":"shift"}}}') throw new Error(text);
    const second: Prefs = { scheme: "classic", shortcuts: { classic: { jump: "j", run: "r" }, wasd: { jump: "space", run: "shift" } } };
    second.note = { jump: 1, run: 2 };
    second.shortcuts.wasd.run = "ctrl";
    const pretty = JSON.stringify(second.shortcuts.wasd, null, 1);
    if (pretty !== '{\\n "jump": "space",\\n "run": "ctrl"\\n}') throw new Error(pretty);
    const again = savers[0]!(second);
    if (again !== '{"scheme":"classic","shortcuts":{"classic":{"jump":"j","run":"r"},"wasd":{"jump":"space","run":"ctrl"}},"note":{"jump":1,"run":2}}') throw new Error(again);
`,
);

// A static key is an index only in its canonical form; typed arrays and
// tuples answer as arrays do.
check(
    "array-membership-index-keys",
    `
    const xs = [1, 2, 3];
    const bytes = new Uint8Array(2);
    const pair: [number, string] = [1, "a"];
    let k = 0;
    for (let i = 0; i < 2; i++) k += i;
    if ("-1" in xs || "01" in xs || "1.5" in xs || !("2" in xs) || "3" in xs)
        throw new Error("vector");
    if (!("1" in bytes) || "2" in bytes || !(k in bytes) || !Object.hasOwn(bytes, "0"))
        throw new Error("typed");
    if (!("1" in pair) || "2" in pair || !(k in pair))
        throw new Error("tuple");
`,
);

// A document record (keys in two orders, enumerated) holding a record whose
// parts hold meshes: that record stays native, held by reference, and a read
// out of the document is that very record, so its mesh fields keep handles.
test("a document record reads a held record whose parts hold meshes as that record", (t) => {
    const { cpp } = compileSource(`
        import { createBox, type EngineContext, type Mesh } from "@babylonjs/lite";
        interface Part { mesh: Mesh; weight: number }
        interface Model { parts: Part[]; count: number }
        interface Holder { label: string; model: Model }
        function inspect(engine: EngineContext): number {
            const mesh = createBox(engine);
            const parts: Part[] = [];
            parts.push({ mesh, weight: 2 });
            const model: Model = { parts, count: 0 };
            const first: Holder = { label: "a", model };
            const second: Holder = { model, label: "b" };
            const holders = [first, second];
            const orders = holders.map((holder) => Object.keys(holder).join());
            if (orders.join(";") !== "label,model;model,label") throw new Error("key orders");
            let weight = 0;
            for (const holder of holders) {
                holder.model.count++;
                for (const part of holder.model.parts) {
                    if (part.mesh !== mesh) throw new Error("mesh handle");
                    weight += part.weight;
                }
            }
            if (first.model !== second.model || model.count !== 2 || weight !== 4) throw new Error("held record");
            return holders.length;
        }
        const inspections: Array<typeof inspect> = [inspect];
    `);
    assert.match(
        cpp,
        /\.read_property\("model"\)\.asserted_instance<bblscene::Model>\(\)/,
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
        "language-constructs/document-held-record-with-meshes",
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
        }
    `,
    );
});

check(
    "a-local-record-stored-as-a-closed-key-record-is-that-record",
    `
    type Element = "a" | "b" | "c";
    const ELEMENTS: readonly Element[] = ["a", "b", "c"];
    interface Frozen { points: Readonly<Record<Element, number>>; total: number }
    interface Open { points: Record<Element, number> }
    function compute(n: number): Frozen {
        const points = { a: 0, b: 0, c: 0 };
        let total = 0;
        for (const element of ELEMENTS) {
            points[element] = n;
            total += n;
        }
        return { points, total };
    }
    function open(): Open {
        const points = { a: 1, b: 2, c: 3 };
        return { points };
    }
    const frozen = compute(2);
    if (frozen.points.a !== 2 || frozen.points.c !== 2 || frozen.total !== 6) throw new Error("frozen");
    if (open().points.b !== 2) throw new Error("open");
`,
);

check(
    "Object.assign into a Record adds and replaces its keys",
    `
    function run(): string { const R: Record<string, number> = { a: 1 }; const extra = { c: 3 }; Object.assign(R, { a: 5, b: 2 }, extra); return Object.keys(R).join() + ":" + R["a"] + R["b"] + R["c"]; }
    function same(): number { const R: Record<string, number> = { a: 1 }; const result = Object.assign(R, { b: 2 }); result["c"] = 3; return Object.keys(R).length; }
    if (run() !== "a,b,c:523" || same() !== 3) throw new Error("assign " + run() + same());
    `,
);

check(
    "a-union-of-scalars-and-arrays-of-itself-is-a-document",
    `
    type Part = string | number | boolean | null | undefined | readonly Part[];
    const quantized = (value: number): number => Math.round((Number.isFinite(value) ? value : 0) * 10000);
    function normalized(part: Part): Part {
        if (typeof part === "number") return quantized(part);
        if (Array.isArray(part)) return part.map(normalized);
        return part;
    }
    function signature(parts: readonly Part[]): string {
        return JSON.stringify(parts.map(normalized));
    }
    const gate = new Float32Array([0.5, 2]);
    const parts: Part[] = ["door", gate[0]!, [1.23456, true, null, ["x", gate[1]!]], undefined];
    const text = signature(parts);
    if (text !== '["door",5000,[12346,true,null,["x",20000]],null]') throw new Error(text);
`,
);

check(
    "a-parsed-element-compared-with-a-record-compares-its-identity",
    `
    interface Rec { x: number; mbase: Float32Array }
    const gate = new Float32Array([1]);
    const rec: Rec = { x: gate[0]!, mbase: new Float32Array([2]) };
    const recs: Rec[] = [rec];
    const docs = JSON.parse("[0, 1, {}]") as unknown[];
    let matches = 0;
    for (const doc of docs) if (doc === rec) matches++;
    const differs = docs[2] !== rec;
    if (matches !== 0 || !differs || recs[0]!.mbase[0] !== 2 || recs[0] !== rec) throw new Error("identity " + matches);
`,
);
