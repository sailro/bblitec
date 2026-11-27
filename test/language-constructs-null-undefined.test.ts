import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

check(
    "nullish-coalesce-over-a-returned-callback",
    `
    interface Hooks { suspend?: () => () => void; }
    const order: string[] = [];
    function fallback(): (() => void) | null { order.push("fallback"); return null; }
    function visit(hooks: Hooks): { show(): void; hide(): void } {
        let resume: (() => void) | null = null;
        return {
            show(): void { resume = hooks.suspend?.() ?? fallback(); },
            hide(): void { const run = resume; resume = null; run?.(); },
        };
    }
    const suspended = visit({ suspend: () => { order.push("suspend"); return () => { order.push("resume"); }; } });
    suspended.show();
    suspended.hide();
    suspended.hide();
    const plain = visit({});
    plain.show();
    plain.hide();
    if (order.join(",") !== "suspend,resume,fallback") throw new Error(order.join(","));
`,
);

check(
    "constant-null-guard",
    `
    function sum(x: number, y: number): number { return x + y; }
    function select(x: number | null, y: number | null): number {
        const valid = x !== null && y !== null && x >= 0 && y >= 0;
        if (!valid) return -1;
        return sum(x, y);
    }
    if (select(null, null) !== -1 || select(2, 3) !== 5) throw new Error("guarded arithmetic");
`,
);

check(
    "callback-results-of-void-or-a-value",
    `
    interface Act { run(): void | boolean; }
    const acts: Act[] = [{ run: () => true }, { run: () => {} }, { run(): void | boolean { return false; } }];
    let trace = "";
    for (const act of acts) {
        const result = act.run();
        trace += result === undefined ? "u" : result ? "t" : "f";
    }
    if (trace !== "tuf") throw new Error("results " + trace);
    // A stored closure reading a later binding of that callback type.
    const handlers: (() => void)[] = [];
    handlers.push(() => { trace += String(deps.act.run()); });
    const deps: { act: Act } = { act: { run: () => true } };
    for (const handler of handlers) handler();
    if (trace !== "tuftrue") throw new Error("later binding " + trace);
`,
);

check(
    "scalar-union-strict-comparisons",
    `
    const values:(string|number|boolean)[] = ['head',2,false,NaN];
    if(values[0] !== 'head' || values[1] !== 2 || values[2] !== false) throw new Error('matching type and value');
    if(values[1] === '2' || values[2] === 0 || values[3] === values[3]) throw new Error('strict types and NaN');
    let calls = '';
    const state:{value:string|number} = {value:'before'};
    function left():string|number {calls+='l';return state.value;}
    function right():string|number {calls+='r';state.value='after';return 'before';}
    if(left() !== right() || calls !== 'lr' || state.value !== 'after') throw new Error('operand snapshots');
    const lookup = new Map<string,string|number>([['entry','before']]);
    function clear():string|number|undefined {lookup.clear();return 'before';}
    if(lookup.get('entry') !== clear()) throw new Error('borrowed optional snapshot');
    function absent():string|number|undefined {return undefined;}
    if(absent() !== lookup.get('missing')) throw new Error('absent union equality');
    const rows:Record<string,string|number>[]=[{text:'value',amount:3}];
    for(const row of rows) {
        if(row.text !== 'value' || row.amount !== 3 || row.missing === 'value' || row.missing === 0)
            throw new Error('unchecked optional union');
    }
    const [head,...tail] = values;
    if(head !== 'head' || tail[0] !== 2 || tail[1] !== false) throw new Error('union rest values');
    type Tag = 'north' | 'south';
    const tagged:(Tag|number)[] = ['north',3];
    for(const tag of tagged) {
        if(tag === 'north') continue;
        if(tag !== 3 || tag === 'outside') throw new Error('tagged scalar equality');
    }
`,
);

check(
    "a-void-callback-slot-stores-a-function-whose-unread-result-is-not-undefined",
    `
    const listeners = new Set<() => void>();
    function subscribe(apply: () => void): () => void {
        listeners.add(apply);
        return () => listeners.delete(apply);
    }
    interface Coin { dispose(): void }
    function createCoin(): Coin {
        const dispose = subscribe(() => {});
        return { dispose };
    }
    let release = (): void => {};
    function open(): void {
        release();
        const coin = createCoin();
        release = coin.dispose;
    }
    open();
    open();
    if (listeners.size !== 1) throw new Error("released " + listeners.size);
    release();
    if (listeners.size !== 0) throw new Error("final " + listeners.size);
`,
);

test("a void callback slot holding a function that returns a value refuses a read of its result", () => {
    assert.throws(
        () =>
            compileSource(`
                const listeners = new Set<() => void>();
                const subscribe = (apply: () => void): (() => void) => () => listeners.delete(apply);
                interface Coin { dispose(): void }
                const coin: Coin = { dispose: subscribe(() => {}) };
                let release = (): void => {};
                release = coin.dispose;
                const result = release();
                if (result !== undefined) throw new Error("read");
            `),
        /Expression assigned to 'result' does not produce a native value/,
    );
});

check(
    "array-elements-keep-null-and-undefined-apart",
    `
    type Tint = readonly [number, number, number];
    interface Plan { recolor: (Tint | null | undefined)[]; }
    function plan(count: number): Plan {
        const recolor: (Tint | null | undefined)[] = new Array(count).fill(undefined);
        recolor[1] = null;
        recolor[2] = [0.5, 0.25, 1];
        return { recolor };
    }
    const planned = plan(3);
    let untouched = 0, reset = 0, tinted = 0;
    for (let i = 0; i < planned.recolor.length; i++) {
        const tint = planned.recolor[i];
        if (tint === undefined) { untouched++; continue; }
        const [r, g, b] = tint ?? [1, 1, 1];
        if (tint === null) reset += r + g + b;
        else tinted += r + g + b;
    }
    if (untouched !== 1 || reset !== 3 || tinted !== 1.75) throw new Error("element absence tags");
`,
);

check(
    "loose equality between objects compares identity without coercion",
    `
    const notes = new WeakMap<object, string[]>();
    const other = new WeakMap<object, string[]>();
    const alias = notes;
    if (notes == other || notes != alias) throw new Error("weak map identity");
    const seen = new WeakSet<object>();
    if (seen != seen || seen == new WeakSet<object>()) throw new Error("weak set identity");
    const maps = new Map<string, number>();
    const same = maps;
    if (maps != same || maps == new Map<string, number>()) throw new Error("map identity");
    const record = { value: 1 }, sameRecord = record, different = { value: 1 };
    if (record != sameRecord || record == different) throw new Error("record identity");
    let calls = 0;
    function get(): WeakMap<object, string[]> { calls++; return notes; }
    if (get() != get() || calls !== 2) throw new Error("evaluation order");
    `,
);

check(
    "null-fields-absent-reads-and-typed-parsed-views",
    `
    interface Wall { centreline: readonly number[]; halfThickness: number; }
    interface DetachedRing { polygon: readonly number[]; houseArc: null; contact: Wall; }
    function detachedRingFrom(wall: Wall, touches: boolean): DetachedRing | null {
        if (touches) return null;
        const polygon = wall.centreline.map((value) => value * 2);
        return { polygon, houseArc: null, contact: { centreline: wall.centreline, halfThickness: wall.halfThickness } };
    }
    const wall: Wall = { centreline: [1, 2, 3], halfThickness: 0.5 };
    const ring = detachedRingFrom(wall, false);
    if (!ring || ring.houseArc !== null || ring.houseArc === undefined || detachedRingFrom(wall, true) !== null) throw new Error("null field");
    if (JSON.stringify(ring) !== '{"polygon":[2,4,6],"houseArc":null,"contact":{"centreline":[1,2,3],"halfThickness":0.5}}') throw new Error("null json");
    interface Generation { targets: Float32Array | null; count: number; grid: { cells: number[] } | null; }
    const generations: Generation[] = Array.from({ length: 2 }, () => ({ targets: null, count: 0, grid: null }));
    generations[0]!.grid = { cells: [1] };
    if (generations[0]!.grid?.cells[0] !== 1 || generations[1]!.grid !== null || generations[1]!.targets !== null) throw new Error("widened null literal");
    function row(label: string, options: { value: string; label?: string; labelKey?: string; hidden?: boolean }[], current: string): string {
        const shown: string[] = [];
        for (let i = 0; i < options.length; i++) {
            if (options[i]!.hidden) { if (options[i]!.value === current) shown.push(options[i]!.value); }
            else shown.push(options[i]!.label ?? options[i]!.labelKey ?? options[i]!.value);
        }
        return label + ":" + shown.join(",");
    }
    const rows = [
        row("autosave", [{ value: "1", label: "1m" }, { value: "5", label: "5m" }], "1"),
        row("scheme", [{ value: "classic", labelKey: "c.classic" }, { value: "wasd", labelKey: "c.wasd" }], "wasd"),
    ];
    const sizes: { value: string; hidden?: boolean }[] = [{ value: "small" }, { value: "huge", hidden: true }];
    rows.push(row("size", sizes, "huge"));
    if (rows.join("|") !== "autosave:1m,5m|scheme:c.classic,c.wasd|size:small,huge") throw new Error("absent through an element");
    interface Settings { dof: boolean; bloom: boolean; antialiasing: boolean; }
    type Feature = keyof Settings;
    const DEFAULTS: Settings = { dof: true, bloom: false, antialiasing: true };
    const stored = new Map<string, string>([["custom", '{"bloom":3,"antialiasing":"smaa"}']]);
    function getCustom(): Settings {
        try {
            const raw = stored.get("custom") ?? null;
            if (!raw) return { ...DEFAULTS };
            const parsed = JSON.parse(raw) as Partial<Settings>;
            const merged = { ...DEFAULTS, ...parsed };
            for (const key of Object.keys(DEFAULTS) as Feature[])
                if (key !== "antialiasing" && typeof merged[key] !== "boolean") merged[key] = DEFAULTS[key];
            if (typeof merged.antialiasing === "string") merged.antialiasing = merged.antialiasing !== "smaa";
            else if (typeof merged.antialiasing !== "boolean") merged.antialiasing = DEFAULTS.antialiasing;
            return merged;
        } catch {
            return { ...DEFAULTS };
        }
    }
    const getters: Array<() => Settings> = [getCustom];
    const custom = getters[0]!();
    const active = (Object.keys(DEFAULTS) as Feature[]).filter((key) => custom[key]);
    custom.dof = false;
    if (active.join() !== "dof" || custom.bloom || custom.antialiasing || custom.dof) throw new Error("typed view of a parsed record");
`,
);

check(
    "conditional-json-null",
    `
    function parse(text: string): number {
        const value = text ? JSON.parse(text) : null;
        return value === null ? -1 : value.count;
    }
    if (parse("") !== -1 || parse('{"count":3}') !== 3) throw new Error("nullable document");
    function missing(text: string): boolean {
        const value = text ? JSON.parse(text) : undefined;
        return value === undefined;
    }
    if (!missing("") || missing("null")) throw new Error("undefined document");
    type Mode = "slow" | "normal" | "fast";
    function mode(value: unknown): Mode { return value === "slow" || value === "fast" ? value : "normal"; }
    const inputs = JSON.parse('["slow", "fast", 0, null]');
    let modes = "";
    for (const input of inputs) modes += mode(input) + ";";
    if (modes !== "slow;fast;normal;normal;") throw new Error("guarded JSON enum");
`,
);

check(
    "a-conditional-over-undefined-and-null-gives-its-taken-arms-absence",
    `
    const gate = new Float32Array([0, 1]);
    const off = gate[0]! > 0;
    const on = gate[1]! > 0;
    const unset: { a?: unknown } = {};
    const missed = off ? unset.a : null;
    if (missed !== null || typeof missed !== "object") throw new Error("null arm " + missed);
    const taken = on ? unset.a : null;
    if (taken !== undefined || taken === null) throw new Error("undefined arm " + taken);
    function body(entity: unknown): object | null {
        const hit = entity as { kind?: unknown; animal?: { animal?: unknown } } | null;
        const found = hit?.kind === "animal" ? hit.animal?.animal : null;
        return typeof found === "object" && found !== null ? found : null;
    }
    const spheres: { kind: "sphere" }[] = [{ kind: "sphere" }];
    if (body(on ? spheres[0] : null) !== null || body(off ? spheres[0] : null) !== null) throw new Error("absent body");
`,
);

checkInRealm(
    "a-call-that-completes-undefined-passes-undefined-to-a-parameter",
    `
    interface Selection {
        set(id: string): void | boolean;
    }
    let log = "";
    const finish = (result: void | boolean, then: (accepted: void | boolean) => void): void => {
        then(result);
    };
    const preview = (selection: Selection, id: string): void => {
        finish(selection.set(id), (accepted) => {
            log += accepted === undefined ? "u" : accepted ? "y" : "n";
        });
    };
    preview({ set: (id) => { log += id; } }, "a");
    preview({ set: (id) => id.length > 3 }, "b");
    if (log !== "aun") throw new Error("log " + log);
    globalThis.close();
`,
);

check(
    "stored-callback-of-a-boolean-or-void-parameter",
    `
    let count = 0;
    const committed = (accepted: void | boolean): boolean => {
        if (accepted === false) return false;
        count++;
        return accepted === undefined ? false : true;
    };
    const handlers: ((accepted: void | boolean) => boolean)[] = [committed];
    let trues = 0;
    for (const handler of handlers) {
        if (handler(true)) trues++;
        if (handler(undefined)) trues++;
        if (handler(false)) trues++;
    }
    if (count !== 2 || trues !== 1) throw new Error("count " + count + " trues " + trues);
`,
);

check(
    "stored-generic-runner-of-a-void-edit",
    `
    type Runner = <T>(operation: () => T | Promise<T>) => Promise<T | null>;
    const late = { runWorldEdit: (async <T>(operation: () => T | Promise<T>): Promise<T | null> => await operation()) as Runner };
    let total = 0;
    async function edits(): Promise<void> {
        const counted = await late.runWorldEdit(() => 2);
        const done = await late.runWorldEdit(() => { total += 10; });
        total += counted ?? 0;
        if (done !== undefined || total !== 12) throw new Error("void edit " + total);
    }
    void edits();
`,
);

check(
    "callback-returned arrays infer null-only record fields without a typed collection",
    `
    const keys = ["x", "y"];
    const grid = keys.map((row) => keys.map((column) => ({ key: row + column, pending: null })));
    if (grid.map((row) => row.map((cell) => cell.key).join()).join("|") !== "xx,xy|yx,yy")
        throw new Error("grid values");
    if (grid[0] === grid[1] || grid[0]![0] === grid[0]![1] || grid[0]![0] === grid[1]![0])
        throw new Error("fresh arrays and records");
    const cell = grid[0]![1]!;
    if (cell.pending !== null || !Object.hasOwn(cell, "pending"))
        throw new Error("null-only field");
    cell.key = "changed";
    if (grid[0]![1]!.key !== "changed" || grid[1]![0]!.key !== "yx")
        throw new Error("record aliases");
`,
);

check(
    "nullish-equality",
    `
    function absent(value: number | null | undefined): boolean { return value == null; }
    function present(value: string | null | undefined): boolean { return value != null; }
    if (!absent(null) || !absent(undefined) || absent(0) || absent(NaN)) throw new Error("numeric absence");
    if (present(null) || present(undefined) || !present("") || !present("text")) throw new Error("string presence");
    const document = JSON.parse('{"nil":null,"zero":0,"empty":"","no":false}');
    if (document.nil != null || document.missing != null || document.zero == null || document.empty == null || document.no == null)
        throw new Error("JSON nullish values");
    if (document.nil === undefined || document.missing === null) throw new Error("strict null distinction");
`,
);

check(
    "stored-function-with-an-undefined-only-parameter",
    `
    interface Port { spawn(spec: number, founder?: undefined, restore?: number): number }
    const seen: string[] = [];
    const port: Port = { spawn: (spec, founder, restore) => { seen.push(spec + ":" + (founder === undefined ? "u" : "d") + ":" + (restore ?? -1)); return seen.length; } };
    const ports: Port[] = [port];
    for (const p of ports) { p.spawn(1); p.spawn(2, undefined, 7); }
    if (seen.join(",") !== "1:u:-1,2:u:7") throw new Error("undef " + seen.join(","));
`,
);

check(
    "void-callback-result-compared-with-true",
    `
    let seen = 0;
    function walk(values: unknown[], visit: (path: string, value: number) => boolean | void): boolean {
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (typeof value === "number" && visit("[" + i + "]", value) === true) return true;
        }
        return false;
    }
    const found = walk([1, "a", 3], (path, value) => { seen += value; if (value > 2) return true; });
    const none = walk([1, 2], (path, value) => { seen += value * 10; });
    if (!found || none || seen !== 34) throw new Error("walk " + seen);
`,
);

check(
    "non-null-asserted-optional-stored-in-a-document",
    `
    type Tint = [number, number, number];
    const tintCopy = (value: readonly [number, number, number] | null | undefined): Tint | null =>
        value ? [value[0], value[1], value[2]] : null;
    interface Tower { woodTint?: Tint; ivyOff?: boolean }
    function apply(target: Tower, trim: Tint | null, from: Tint | null): void {
        if (trim) target.woodTint = tintCopy(from)!;
        else delete target.woodTint;
    }
    const tower = JSON.parse('{"ivyOff":true}') as Tower;
    const tints: (Tint | null)[] = [[1, 2, 3], null];
    apply(tower, tints[0] ?? null, tints[0] ?? null);
    if (JSON.stringify(tower) !== '{"ivyOff":true,"woodTint":[1,2,3]}') throw new Error(JSON.stringify(tower));
    apply(tower, tints[0] ?? null, tints[1] ?? null);
    if (JSON.stringify(tower) !== '{"ivyOff":true,"woodTint":null}') throw new Error("asserted " + JSON.stringify(tower));
    apply(tower, tints[1] ?? null, tints[0] ?? null);
    if (JSON.stringify(tower) !== '{"ivyOff":true}') throw new Error("deleted " + JSON.stringify(tower));
`,
);

check(
    "non-null-asserted-optional-array-stored-as-an-array",
    `
    interface Rect { u: number; w: number }
    interface Manifest { cells?: Rect[]; names?: string[] }
    const authored = (manifest: Manifest): boolean => (manifest.cells?.length ?? 0) > 0;
    function cellsOf(manifest: Manifest): Rect[] {
        const cells: Rect[] = authored(manifest) ? manifest.cells! : [{ u: 0, w: 1 }];
        return cells;
    }
    const names = (manifest: Manifest): string[] => manifest.names!;
    const manifests: Manifest[] = [{ cells: [{ u: 0, w: 0.5 }, { u: 0.5, w: 0.5 }], names: ["a"] }, { names: [] }];
    const first = cellsOf(manifests[0]!);
    if (first.length !== 2 || first !== manifests[0]!.cells || cellsOf(manifests[1]!)[0]!.w !== 1) throw new Error("cells");
    names(manifests[1]!).push("b");
    if (names(manifests[0]!).length !== 1 || manifests[1]!.names!.join() !== "b") throw new Error("names");
`,
);

check(
    "strict null and undefined equality follows the operand's type",
    `
    interface Options {
        label?: string;
        size?: number | null;
        onPick?: () => void;
    }
    function flags(options: Options): string {
        const parts: string[] = [];
        parts.push(options.label === null ? "n" : "-");
        parts.push(options.label === undefined ? "u" : "-");
        parts.push(options.label !== null ? "N" : "-");
        parts.push(options.label !== undefined ? "U" : "-");
        parts.push(options.label == null ? "nn" : "--");
        parts.push(options.label != undefined ? "UU" : "--");
        parts.push(options.onPick === null ? "fn" : "-");
        parts.push(options.onPick === undefined ? "fu" : "-");
        return parts.join("");
    }
    function main(): void {
        const absent = flags({});
        if (absent !== "-uN-nn---fu") throw new Error("absent field " + absent);
        const present = flags({ label: "x", onPick: () => {} });
        if (present !== "--NU--UU--") throw new Error("present field " + present);
        const sizes: Array<number | null> = [];
        sizes.push(null);
        const first = sizes[0];
        if (first !== null) throw new Error("stored null");
        const lookup = new Map<string, number>();
        const miss = lookup.get("a");
        if (miss === null || miss !== undefined) throw new Error("map miss is undefined");
        const items: number[] = [];
        const popped = items.pop();
        if (popped === null || popped !== undefined) throw new Error("pop of an empty array is undefined");
        const omitted: Options = {};
        if (omitted.label === null || omitted.label !== undefined) throw new Error("omitted field is undefined");
        const walls = new Map<string, { w: number } | null>();
        let built = 0;
        function wall(name: string): { w: number } | null {
            const cached = walls.get(name);
            if (cached !== undefined) return cached;
            built++;
            const result = name === "missing" ? null : { w: name.length };
            walls.set(name, result);
            return result;
        }
        if (wall("missing") !== null || wall("missing") !== null || built !== 1) throw new Error("a stored null is found " + built);
        const nullableSizes = new Map<string, number | null>([["none", null]]);
        const none = nullableSizes.get("none");
        const gone = nullableSizes.get("gone");
        if (none !== null || none === undefined || gone !== undefined || gone === null) throw new Error("stored null and miss");
        if ("a" + nullableSizes.get("none") + nullableSizes.get("gone") !== "anullundefined") throw new Error("lookup spelling");
    }
    main();
`,
);

check(
    "strict equality distinguishes null and undefined in mixed primitive storage",
    `
    function main(): void {
        const values: Array<number | null | undefined> = [];
        values.push(null, undefined, 0);
        const isNull = values[0] === null;
        if (!isNull || values[0] === undefined) throw new Error("stored null");
        if (values[1] !== undefined || values[1] === null) throw new Error("stored undefined");
        if (values[2] === undefined || values[2] === null || values[2] !== 0) throw new Error("stored zero");
    }
    main();
`,
);

check(
    "strict null and undefined comparisons read whether the slot existed",
    `
    interface Attachment {
        label: string;
    }
    interface Entry {
        id: string;
        attachment: Attachment | null;
        note: string | null;
    }
    const catalog: Entry[] = [
        { id: "a", attachment: null, note: null },
        { id: "b", attachment: { label: "x" }, note: "n" },
    ];
    function find(id: string): Entry | undefined {
        return catalog.find((entry) => entry.id === id);
    }
    function main(): void {
        // Optional chain over a nullable field.
        if (find("a")?.attachment !== null) throw new Error("present owner, null field");
        if (find("a")?.attachment === undefined) throw new Error("present owner is not undefined");
        if (find("missing")?.attachment !== undefined) throw new Error("missing owner");
        if (find("missing")?.attachment === null) throw new Error("missing owner is not null");
        if (find("b")?.attachment === null || find("b")?.attachment === undefined) throw new Error("present field");
        const chained = find("a")?.attachment;
        if (chained !== null || chained === undefined) throw new Error("bound chain");
        if ("c" + find("a")?.note + find("missing")?.note + find("b")?.note !== "cnullundefinedn") throw new Error("chain spelling");
        // pop/shift of nullable elements.
        const maybe: (number | null)[] = [null];
        if (maybe.pop() !== null) throw new Error("popped null");
        if (maybe.pop() !== undefined) throw new Error("popped from empty");
        const queue: Array<string | null> = [null, "q"];
        const head = queue.shift();
        if (head !== null || head === undefined) throw new Error("shifted null");
        if (queue.shift() !== "q" || queue.shift() !== undefined) throw new Error("shifted rest");
        let order = "";
        const pops: (number | null)[] = [1, null];
        if (pops.pop() === null) order += "n";
        if (pops.pop() === 1) order += "1";
        if (pops.pop() === undefined) order += "u";
        if (order !== "n1u") throw new Error("two pops in turn " + order);
        // Index into an array of nullable elements.
        const sizes: Array<number | null> = [null, 3];
        if (sizes[0] !== null || sizes[1] !== 3) throw new Error("stored elements");
        let index = 5;
        if (sizes[index] === null || sizes[index] !== undefined) throw new Error("past the end");
        index = 0;
        if ("s" + sizes[index] + sizes[index + 7] !== "snullundefined") throw new Error("element spelling");
        const plain: number[] = [1];
        if (plain[3] === null) throw new Error("past the end of a never-null array");
    }
    main();
`,
);

check(
    "array-entries-of-nullish-selection",
    `
    interface View { buffer?: number; byteLength: number }
    interface Doc { bufferViews?: View[] }
    const doc = JSON.parse('{"bufferViews":[{"buffer":0,"byteLength":4},{"byteLength":8}]}') as Doc;
    let sum = 0;
    for (const [index, view] of (doc.bufferViews ?? []).entries()) sum += index * 100 + (view.buffer ?? 7) + view.byteLength;
    const empty = JSON.parse("{}") as Doc;
    for (const [index] of (empty.bufferViews ?? []).entries()) sum += 1000 + index;
    const typed: { list?: number[] } = { list: [5, 6] };
    for (const [index, value] of (typed.list ?? []).entries()) sum += index * value;
    if (sum !== 125) throw new Error("entries " + sum);
`,
);

check(
    "paired-null-and-undefined-tests",
    `
    const gate = new Float32Array([0, 1]);
    interface Bounds { x: number }
    interface Opts { linkedHandle?: Bounds | null; current: boolean }
    const dirty = (opts: Opts): boolean => opts.linkedHandle !== null && opts.linkedHandle !== undefined && opts.current === false;
    const handles: (Bounds | null | undefined)[] = [{ x: 1 }, null, undefined];
    let count = 0;
    for (let i = 0; i < 3; i++) if (dirty({ linkedHandle: handles[i], current: gate[0]! > 0 })) count++;
    if (count !== 1) throw new Error("present pair " + count);
    const absent = (value: Bounds | null | undefined): boolean => value === null || value === undefined;
    if (absent(handles[0]) || !absent(handles[1]) || !absent(handles[2])) throw new Error("absent pair");
    let pending: Bounds | null | undefined = gate[1]! > 0 ? null : undefined;
    let changed = pending !== null && pending !== undefined;
    if (changed) throw new Error("null pending");
    pending = { x: 2 };
    changed = pending !== null && pending !== undefined;
    if (!changed) throw new Error("present pending");
`,
);

check(
    "strict-equality-tells-null-from-undefined-across-optionals",
    `
    const gate = new Float32Array([0, 1]);
    const off = gate[0]! > 0;
    const log: string[] = [];
    const n: number | null = off ? 1 : null;
    const u: number | undefined = off ? 1 : undefined;
    const n2: number | null = off ? 2 : null;
    const u2: number | undefined = off ? 2 : undefined;
    log.push(String(n === u), String(n !== u), String(n === n2), String(u === u2));
    const s: string | null = off ? "x" : null;
    const t: string | undefined = off ? "x" : undefined;
    const b: boolean | null = off ? true : null;
    const c: boolean | undefined = off ? true : undefined;
    log.push(String(s === t), String(b === c), String(t !== s));
    const one: number | null = gate[1]! > 0 ? gate[1]! : null;
    const alsoOne: number | undefined = gate[1]! > 0 ? gate[1]! : undefined;
    log.push(String(one === alsoOne), String(one === u), String(alsoOne !== n));
    interface Cell { size?: number; weight: number | null; }
    const cells: Cell[] = [{ weight: null }, { size: 3, weight: 3 }, { size: 4, weight: null }];
    for (const cell of cells) log.push(String(cell.size === cell.weight));
    interface Owner { cell: Cell | null; }
    const owners: Owner[] = [{ cell: null }, { cell: cells[0]! }, { cell: cells[1]! }];
    for (const owner of owners)
        log.push(String(owner.cell?.size === n), String(owner.cell?.size === u), String(owner.cell?.weight === n), String(owner.cell?.weight === u));
    interface Box { v: number; }
    const box: Box = { v: 1 };
    const nullBox: Box | null = off ? box : null;
    const missingBox: Box | undefined = off ? box : undefined;
    const heldBox: Box | null = gate[1]! > 0 ? box : null;
    log.push(String(nullBox === missingBox), String(nullBox !== missingBox), String(heldBox === box), String(heldBox === missingBox));
    if (log.join(",") !== "false,true,true,true,false,false,true,true,false,true,false,true,false,false,true,false,true,false,true,true,false,false,false,false,false,false,true,true,false") throw new Error(log.join(","));
`,
);

check(
    "strict-equality-of-storage-holding-both-absent-values",
    `
    interface Box { v: number; }
    interface Slots { a?: number | null; b?: number | null; s?: string | null; t?: string | null; x?: Box | null; y?: Box | null; }
    const shared: Box = { v: 1 };
    const all: Slots[] = [
        {},
        { a: null, s: null, x: null },
        { b: null, t: null, y: null },
        { a: null, b: null, s: null, t: null, x: null, y: null },
        { a: 0, b: 0, s: "", t: "", x: shared, y: shared },
        { a: 0, s: "null", x: shared },
        { b: 0, t: "x", x: { v: 1 }, y: { v: 1 } },
    ];
    const bit = (flag: boolean): string => (flag ? "1" : "0");
    const seen = all.map((slot) =>
        bit(slot.a === slot.b) + bit(slot.s === slot.t) + bit(slot.x === slot.y) + bit(slot.a !== slot.b) + bit(slot.a === 0) + bit(slot.s === "null") + bit("" === slot.t),
    );
    if (seen.join(",") !== "1110000,0001000,0001000,1110000,1110101,0001110,0001000") throw new Error(seen.join(","));
    type Reach = () => number;
    function sameReach(f: Reach | null | undefined, g: Reach | null | undefined): boolean { return f === g; }
    function sameNumber(p: number | null | undefined, q: number | null | undefined): boolean { return p === q; }
    const near: Reach = () => 1;
    const far: Reach = () => 2;
    const reaches = [sameReach(null, undefined), sameReach(undefined, undefined), sameReach(null, null), sameReach(near, near), sameReach(near, null), sameReach(undefined, near), sameReach(near, far)];
    const numbers = [sameNumber(null, undefined), sameNumber(undefined, undefined), sameNumber(null, null), sameNumber(0, null), sameNumber(NaN, NaN), sameNumber(-0, 0)];
    if (reaches.map(bit).join("") !== "0111000" || numbers.map(bit).join("") !== "011001") throw new Error(reaches.map(bit).join("") + " " + numbers.map(bit).join(""));
`,
);

test("strict equality refuses operands that may be null or undefined without storage telling them apart", () => {
    assert.throws(
        () =>
            compileSource(
                "type Fn = () => number; const fns: Array<Fn | null | undefined> = [null, undefined]; let last: Fn | null | undefined = null; for (const f of fns) { if (f === last) throw new Error(); last = f; }",
            ),
        /compared strictly with another value that may be absent only once one of them is ruled out/,
    );
});

// A function's result whose callers tell null from undefined is tagged
// storage, so strict equality of two results compares them exactly.
check(
    "strict-equality-of-tagged-call-results",
    `
    interface Box { v: number; }
    const boxes: Box[] = [{ v: 1 }, { v: 2 }];
    function pick(i: number): Box | null | undefined { return i < 0 ? null : i > 5 ? undefined : boxes[i]; }
    const g = new Float32Array([0, 1, -1, -2, 7, 9]);
    const same = (a: number, b: number): boolean => pick(g[a]!) === pick(g[b]!);
    if (same(0, 1) || !same(0, 0) || !same(2, 3) || !same(4, 5) || same(2, 4)) throw new Error("tagged results");
`,
);

// So is the result of a body inlined with early returns, through a function
// returning its call.
check(
    "tagged-results-of-inlined-early-return-bodies",
    `
    interface Spot { x: number; z: number; }
    const spots: Spot[] = [{ x: 1, z: 2 }, { x: 4, z: 5 }];
    const gate = new Float32Array([0, 1]);
    const project = <T>(x: number, keep: (spot: Spot) => T | null): T | null | undefined => {
        if (gate[1]! < 0.5) return undefined;
        let best: T | null = null;
        for (const spot of spots) { const kept = keep(spot); if (kept !== null && spot.x > x) best = kept; }
        return best;
    };
    const scan = (x: number): Spot | null | undefined => project(x, (spot) => spot);
    const committed = new Map<number, { spot: Spot | null }>();
    function reach(id: number, x: number): Spot | null {
        const entry = committed.get(id);
        if (entry) {
            const result = scan(x);
            if (result === undefined) return entry.spot;
            entry.spot = result;
            return result;
        }
        const spot = scan(x) ?? null;
        committed.set(id, { spot });
        return spot;
    }
    if (reach(1, 0)?.x !== 4 || reach(1, 9) !== null || committed.get(1)!.spot !== null) throw new Error("inlined tagged results");
    gate[1] = 0;
    if (reach(1, 0) !== null) throw new Error("undefined keeps the committed spot");
`,
);

// A member typed unknown read through an element of an absent array's empty
// fallback is the dynamic value such a read would hold.
check(
    "unknown-members-of-empty-fallback-elements",
    `
    interface Arch { x: number; spec: unknown }
    function sameValue(a: unknown, b: unknown): boolean { return Object.is(a, b); }
    function sameArches(previous: readonly Arch[] | undefined, current: readonly Arch[] | undefined): boolean {
        const a = previous ?? [];
        const b = current ?? [];
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            const p = a[i]!;
            const q = b[i]!;
            if (p.x !== q.x || !sameValue(p.spec, q.spec)) return false;
        }
        return true;
    }
    const spec = { kind: "round" };
    const arches: Arch[] = [{ x: 1, spec }];
    if (!sameArches(undefined, undefined) || !sameArches(arches, [{ x: 1, spec }]) || sameArches(arches, [{ x: 1, spec: { kind: "round" } }]) || sameArches(arches, undefined))
        throw new Error("unknown members");
`,
);

test("stored callback results represent both null and undefined", () => {
    assert.doesNotThrow(() =>
        compileSource(
            "interface R { x: number } const gate = new Float32Array([1]); function pick(i: number): R | null | undefined { return i > 0 ? { x: 1 } : i < 0 ? null : undefined; } const roots: Array<typeof pick> = [pick]; let p: R | null | undefined = roots[0]!(gate[0]!); if (p === null) throw new Error('null');",
        ),
    );
});

check(
    "nullish-fallbacks-that-never-complete-or-are-null",
    `
    interface Geometry { name: string; size: number; }
    const names = ["a", "b"] as const;
    function failMissing(name: string): never { throw new Error("missing " + name); }
    function load(bundle: Map<string, Geometry>): Geometry[] {
        return names.map((name) => bundle.get(name) ?? failMissing(name));
    }
    const bundle = new Map<string, Geometry>([["a", { name: "a", size: 1 }], ["b", { name: "b", size: 2 }]]);
    const loaded = load(bundle);
    if (loaded[1]!.size !== 2 || loaded[0] !== bundle.get("a")) throw new Error("present results");
    let threw = "";
    try { load(new Map([["a", { name: "a", size: 1 }]])); } catch (error) { threw = (error as Error).message; }
    if (threw !== "missing b") throw new Error("never fallback " + threw);
    const counts = new Map<string, number>([["x", 0]]);
    const zero = counts.get("x") ?? failMissing("x");
    if (zero !== 0) throw new Error("falsy present number");
    interface Controls { pip?: () => { reading: string } | null; }
    const read = (controls: Controls): string => {
        const pip = controls.pip?.() ?? null;
        return String(pip === null) + String(pip === undefined);
    };
    const controls: Controls[] = [{}, { pip: () => null }, { pip: () => ({ reading: "rain" }) }];
    const roots: Array<typeof read> = [read];
    if (controls.map((each) => roots[0]!(each)).join(",") !== "truefalse,truefalse,falsefalse") throw new Error("null fallback");
    const slots: (Geometry | null)[] = [null];
    const missing = slots[3] ?? null;
    if (missing !== null || (slots[0] ?? undefined) !== undefined) throw new Error("fallback absence");
`,
);

check(
    "paired-absence-tests-inside-longer-chains",
    `
    const gate = new Float32Array([0, 1]);
    interface Bounds { x: number }
    interface Opts { linked?: Bounds | null; current: boolean }
    const all: Opts[] = [{ linked: { x: 2 }, current: true }, { linked: null, current: true }, { current: false }];
    const ready = gate[1]! > 0;
    let present = 0;
    let missing = 0;
    for (const opts of all) {
        if (ready && opts.linked !== null && opts.linked !== undefined) present += opts.linked.x;
        if (!ready || opts.linked === null || opts.linked === undefined) missing++;
        if (opts.current && opts.linked !== undefined && opts.linked !== null && ready) present += 10;
    }
    if (present !== 12 || missing !== 2) throw new Error("chained pairs " + present + " " + missing);
    const pick = (opts: Opts): boolean => ready && opts.linked !== null && opts.linked !== undefined;
    if (!pick(all[0]!) || pick(all[1]!) || pick(all[2]!)) throw new Error("chained pair value");
`,
);

check(
    "json-stringify-omits-undefined-record-members",
    `
    interface Row { id: number; note?: string; label: string | undefined; parent: number | null; tags: Array<string | undefined> }
    interface Doc { rows: Row[]; inner: { maybe: number | undefined; nested: { deep?: number; deeper: string | undefined } } }
    const rows: Row[] = [
        { id: 1, label: undefined, parent: null, tags: ["a", undefined] },
        { id: 2, note: "n", label: "x", parent: 3, tags: [] },
    ];
    const doc: Doc = { rows, inner: { maybe: undefined, nested: { deeper: undefined } } };
    const expected = '{"rows":[{"id":1,"parent":null,"tags":["a",null]},{"id":2,"note":"n","label":"x","parent":3,"tags":[]}],"inner":{"nested":{}}}';
    if (JSON.stringify(doc) !== expected) throw new Error("document " + JSON.stringify(doc));
    rows[1]!.label = undefined;
    rows[1]!.note = undefined;
    doc.inner.maybe = 4;
    doc.inner.nested.deeper = "d";
    const changed = '{"rows":[{"id":1,"parent":null,"tags":["a",null]},{"id":2,"parent":3,"tags":[]}],"inner":{"maybe":4,"nested":{"deeper":"d"}}}';
    if (JSON.stringify(doc) !== changed) throw new Error("changed " + JSON.stringify(doc));
    const values: Array<number | undefined> = [1, undefined];
    if (JSON.stringify(values) !== "[1,null]" || JSON.stringify(rows[0]) !== '{"id":1,"parent":null,"tags":["a",null]}')
        throw new Error("arrays keep null");
    const record = { a: 1, b: values[1], c: values[0] };
    if (JSON.stringify(record) !== '{"a":1,"c":1}') throw new Error("record member " + JSON.stringify(record));
    interface Loose { value: unknown; id: number }
    const loose: Loose[] = [{ value: undefined, id: 1 }, { value: JSON.parse("[2]") as unknown, id: 2 }];
    if (JSON.stringify(loose) !== '[{"id":1},{"value":[2],"id":2}]') throw new Error("unknown member " + JSON.stringify(loose));
    class Slot { held: number | undefined = undefined; owner: number | null = null; }
    const slots = [new Slot(), new Slot()];
    slots[1]!.held = 3;
    if (JSON.stringify(slots) !== '[{"owner":null},{"held":3,"owner":null}]') throw new Error("class fields " + JSON.stringify(slots));
`,
);

check(
    "null-defaults-take-null-and-undefined-arguments",
    `
    interface Claims { n: number }
    function assign(out: number[], claims: Claims | null = null): number { return claims ? claims.n : -1; }
    function filter(xs: number[], keep: ((x: number) => boolean) | null = null): number {
        return keep ? xs.filter(keep).length : -1;
    }
    const stored: Array<typeof assign> = [assign];
    const maybe: Array<Claims | null | undefined> = [undefined, null, { n: 3 }];
    const out: number[] = [];
    for (const m of maybe) out.push(assign(out, m), stored[0]!(out, m));
    const keeps: Array<((x: number) => boolean) | null | undefined> = [undefined, null, (x) => x > 1];
    for (const k of keeps) out.push(filter([1, 2, 3], k));
    if (out.join(",") !== "-1,-1,-1,-1,3,3,-1,-1,2") throw new Error("null default " + out.join(","));
`,
);

check(
    "records-holding-a-field-only-undefined-share-the-other-type-layout",
    `
    interface Pose { pitch?: number; pivot?: readonly [number, number, number] }
    const upright = { pitch: 0, pivot: undefined };
    const suspended = { pitch: Math.PI / 2, pivot: [0.5, 0.5, 0] as const };
    function orientation(kind: string): Pose { return kind === "fish" ? suspended : upright; }
    const fish = orientation("fish");
    const seen = new Set<Pose>([fish, orientation("x")]);
    if (!seen.has(suspended) || !seen.has(upright) || fish.pivot?.[1] !== 0.5 || orientation("x").pivot !== undefined) throw new Error("one object per pose");
    fish.pitch = 1;
    if (suspended.pitch !== 1 || JSON.stringify(orientation("x")) !== '{"pitch":0}') throw new Error("write through the declared type");
`,
);

test("union arms holding an undefined field another arm makes optional refuse its own-key presence", () => {
    assert.throws(
        () =>
            compileSource(`interface Tower { seed: number | undefined }
            interface House { seed?: number; label: string }
            function keysOf(before: Tower | House): string { return Object.keys(before).join(); }
            const classify: Array<typeof keysOf> = [keysOf];
            if (classify[0]!({ seed: undefined }) !== "seed") throw new Error("own undefined key");`),
        /Own-property presence of 'seed' is not represented/,
    );
});

check(
    "records-holding-a-field-only-null-keep-it",
    `
    interface Face { polygon: readonly number[]; houseArc: readonly number[] | null }
    interface Ring extends Face { houseArc: null }
    interface Enclosure extends Face { houseArc: readonly number[] }
    function ringFrom(n: number): Ring | null {
        if (n < 0) return null;
        const polygon = [n, n + 1];
        if (polygon.length > 5) return null;
        return { polygon, houseArc: null };
    }
    const make: Array<typeof ringFrom> = [ringFrom];
    const yards: (Ring | Enclosure)[] = [{ polygon: [1], houseArc: [2] }];
    const ring = make[0]!(3);
    if (ring) yards.push(ring);
    if (yards.length !== 2 || yards[1] !== ring || yards[1]!.houseArc !== null || make[0]!(-1) !== null) throw new Error("ring");
    const text = JSON.stringify(ring);
    if (!text.includes('"houseArc":null') || !text.includes('"polygon":[3,4]') || Object.keys(ring!).sort().join() !== "houseArc,polygon") throw new Error("keys " + text);
`,
);

check(
    "union-arm-fields-own-while-undefined",
    `
    type Shape = { kind: "a"; x: number | undefined } | { kind: "b"; y: number };
    const shapes: Shape[] = [{ kind: "a", x: undefined }, { kind: "b", y: 2 }, { kind: "a", x: 4 }];
    let total = 0;
    let numbers = 0;
    let undefinedOwn = 0;
    let keys = "";
    for (const shape of shapes) {
        for (const [key, value] of Object.entries(shape)) {
            keys += key;
            if (typeof value === "number") { numbers++; total += value; }
        }
        const copy = { ...shape };
        if (copy.kind === "a" && "x" in copy && copy.x === undefined) undefinedOwn++;
        if (copy.kind === "a" && copy.x !== undefined) total += copy.x * 10;
    }
    if (total !== 46 || numbers !== 2 || undefinedOwn !== 1 || keys !== "kindxkindykindx") throw new Error("own arm fields " + total + " " + numbers + " " + undefinedOwn + " " + keys);
`,
);

check(
    "nullish-fallback-of-another-union-member-and-optional-method-calls",
    `
    interface Move { readonly id: number; readonly target: { readonly x: number; readonly z: number } | null }
    interface Plan { readonly moves: readonly Move[]; commit(): void }
    type Proposal = Plan | { readonly state: "waiting" } | { readonly state: "rejected" };
    const planIn = (proposal: Proposal): Plan | null => ("moves" in proposal ? proposal : null);
    const log: string[] = [];
    let fallbackCount = 0;
    const origin = (): "origin" => { fallbackCount++; return "origin"; };
    function createMover(deps: { targetOf(id: number): { x: number; z: number } | null; reject(): boolean }) {
        const seen: Array<{ x: number; z: number } | "origin"> = [];
        const apply = (id: number, target: { x: number; z: number } | "origin"): void => {
            seen.push(target);
            if (target === "origin") { log.push(id + ":origin"); return; }
            log.push(id + ":" + target.x + "," + target.z);
        };
        const prepare = (ids: readonly number[]): Proposal => {
            if (deps.reject()) return { state: "rejected" };
            const moves: Move[] = [];
            for (const id of ids) moves.push({ id, target: deps.targetOf(id) });
            return {
                moves,
                commit: () => {
                    for (const move of moves) apply(move.id, move.target ?? origin());
                },
            };
        };
        const applyAll = (ids: readonly number[]): boolean => {
            const plan = planIn(prepare(ids));
            plan?.commit();
            if (plan) {
                const first = plan.moves[0];
                if (first && first.target && seen[0] !== first.target) throw new Error("target identity");
            }
            return plan !== null;
        };
        return { applyAll };
    }
    let rejected = false;
    const mover = createMover({ targetOf: (id) => (id % 2 ? { x: id, z: -id } : null), reject: () => rejected });
    if (!mover.applyAll([1, 2])) throw new Error("applied");
    rejected = true;
    if (mover.applyAll([3])) throw new Error("rejected");
    if (log.join(";") !== "1:1,-1;2:origin" || fallbackCount !== 1) throw new Error("log " + log.join(";") + " " + fallbackCount);
`,
);

check(
    "function-slots-declared-with-a-stub-returning-undefined",
    `
    // A slot whose first function always returns undefined takes functions
    // that return values later: a call reads what the stored one returns.
    interface Footprint { w: number; d: number }
    const cache = new Map<number, { fp: Footprint; floorY: number }>();
    let fpOf = (_seq: number): Footprint | undefined => undefined;
    let floorOf = (_seq: number): number | undefined => undefined;
    let bottomOf = (_seq: number): number | null | undefined => undefined;
    function bottom(entry: { fp: Footprint; floorY: number } | undefined): number | null | undefined { return entry ? entry.floorY - 1 : null; }
    function describe(seq: number): string {
        const fp = fpOf(seq);
        return (fp ? fp.w + "x" + fp.d : "none") + "@" + floorOf(seq) + "/" + bottomOf(seq);
    }
    const before = describe(1);
    if (cache.size === 0) {
        cache.set(1, { fp: { w: 2, d: 3 }, floorY: 4 });
        fpOf = (seq: number): Footprint | undefined => cache.get(seq)?.fp;
        floorOf = (seq: number): number | undefined => cache.get(seq)?.floorY;
        bottomOf = seq => bottom(cache.get(seq));
    }
    const seen = [before, describe(1), describe(2)].join("|");
    if (seen !== "none@undefined/undefined|2x3@4/3|none@undefined/null") throw new Error(seen);
`,
);

check(
    "void-results-returned-from-void-bodies",
    `
    // \`return work()\` in a body whose result is void runs the call and
    // returns: the declared void, and a type parameter's void argument.
    const rows = new Map<string, number>();
    const record = (label: string): void => { rows.set(label, (rows.get(label) ?? 0) + 1); };
    const track = <T>(label: string, work: () => T): T => {
        if (label === "skip") return work();
        try {
            return work();
        } finally {
            record(label);
        }
    };
    const measure = <Args extends unknown[], Result>(label: string, work: (...args: Args) => Result): ((...args: Args) => Result) => {
        if (label === "plain") return work;
        return (...args: Args): Result => {
            try {
                return work(...args);
            } finally {
                record(label);
            }
        };
    };
    let total = 0;
    function bump(): void { total += 1; }
    function run(skip: boolean): void { if (skip) return; return bump(); }
    run(false);
    run(true);
    track("a", () => { total += 10; });
    track("skip", () => { total += 100; });
    const three = track("b", () => 3);
    const add = measure("add", (amount: number): void => { total += amount; });
    add(1000);
    add(1000);
    const twice = measure("twice", (amount: number): number => amount * 2);
    const plain = measure("plain", (amount: number): void => { total += amount; });
    plain(10000);
    const seen = [total, three, twice(4), [...rows].map(([label, calls]) => label + "," + calls).join(";")].join("|");
    if (seen !== "12111|3|8|a,1;b,1;add,2;twice,1") throw new Error(seen);
`,
);

check(
    "void-results-in-bindings-and-generic-memos",
    `
    let builds = 0;
    let stamp = -1;
    let revision = 0;
    const memoized = <T>(build: () => T): (() => T) => {
        let value: T;
        return (): T => {
            if (stamp === revision) return value;
            value = build();
            stamp = revision;
            return value;
        };
    };
    let tops: number[] = [];
    const refresh = memoized((): void => {
        builds++;
        const out: number[] = [];
        for (const v of [1, -2, 3]) {
            if (v < 0) continue;
            out.push(v * revision);
        }
        tops = out;
    });
    refresh();
    refresh();
    revision++;
    refresh();
    if (builds !== 2 || tops.join(",") !== "1,3") throw new Error("memoized void builder " + builds + ":" + tops.join(","));
    function quiet(): void { builds += 10; }
    let done: void;
    done = quiet();
    if (done !== undefined || builds !== 12) throw new Error("void binding");
`,
);

test("a void binding refuses a result without a proven undefined completion", () => {
    assert.throws(
        () =>
            compileSource(`
            const hooks: Array<() => void> = [() => {}];
            let done: void;
            done = hooks[0]!();
            if (done !== undefined) throw new Error("x");`),
        /requires a proven undefined completion/,
    );
});

check(
    "void-operator-and-proven-undefined-results",
    `
    let calls = 0;
    function touch(): void { calls++; }
    const v = void 0;
    const w = void touch();
    if (v !== undefined || w !== undefined || calls !== 1) throw new Error("void operator");
    function apply<T>(deps: { finish(): T; commit(result: T): void }): T {
        const result = deps.finish();
        deps.commit(result);
        return result;
    }
    let committed = 0;
    const done = apply({
        finish: () => undefined,
        commit: (result) => { if (result === undefined) committed++; },
    });
    if (done !== undefined || committed !== 1) throw new Error("generic undefined result");
`,
);

test("a void-typed result without a proven undefined completion refuses", () => {
    assert.throws(
        () =>
            compileSource(
                "const cb: () => void = () => 5; const r = cb(); export {};",
            ),
        /Expression assigned to 'r' does not produce a native value/,
    );
});

// A parameter defaulted to a value that may itself be undefined stays optional.
check(
    "defaulted-parameter-that-may-be-undefined",
    `
    interface Idle { day?: number; built?: number }
    interface Fields { od?: number; os?: number }
    function fields(idle: Idle, mutation = false, built = idle.built): Fields {
        const out: Fields = {};
        if (!mutation && idle.day !== undefined) out.od = idle.day;
        if (built !== undefined) out.os = built;
        return out;
    }
    const stored: Array<typeof fields> = [fields];
    const f = stored[0]!({ day: 2, built: 1 });
    if (f.od !== 2 || f.os !== 1) throw new Error("defaults");
    const g = stored[0]!({}, true, 5);
    if (g.od !== undefined || g.os !== 5) throw new Error("override");
    if (stored[0]!({}).os !== undefined || "os" in stored[0]!({})) throw new Error("absent default");
`,
);

check(
    "a void call proven undefined reads undefined and still runs",
    `
    let calls = 0;
    function quiet(): void { calls++; }
    const silent: () => void = () => { calls++; };
    function pick(a: unknown = 5): unknown { return a; }
    if (typeof quiet() !== "undefined" || typeof silent() !== "undefined") throw new Error("typeof");
    if (pick(quiet()) !== 5 || pick(silent()) !== 5) throw new Error("default");
    if (calls !== 4) throw new Error("calls " + calls);
    `,
);

test("a void result read without a proven undefined completion refuses", () => {
    for (const source of [
        "const ask: () => void = () => 3; const kind = typeof ask(); export {};",
        "function three(): number { return 3; } const ask: () => void = three; const kind = typeof ask(); export {};",
        "const ask: () => void = () => 3; function pick(a: unknown = 5): unknown { return a; } const v = pick(ask()); export {};",
    ])
        assert.throws(
            () => compileSource(source),
            /requires a proven undefined completion/,
        );
});

check(
    "a void receiver reads as undefined for calls, property and element reads",
    `
    let trace = "";
    function quiet(): void { trace += "q"; }
    function key(): string { trace += "k"; return "m"; }
    function arg(): number { trace += "a"; return 1; }
    function message(run: () => void): string {
        try { run(); } catch (error) { return error instanceof TypeError ? error.message : "other"; }
        return "none";
    }
    const call = message(() => { (quiet() as unknown as { m(a: number): number }).m(arg()); });
    const read = message(() => { const v = (quiet() as unknown as { x: number }).x; void v; });
    if (call !== "Cannot read properties of undefined (reading 'm')" || read !== "Cannot read properties of undefined (reading 'x')" || trace !== "qq")
        throw new Error("member " + call + " " + read + " " + trace);
    trace = "";
    const element = message(() => { const v = (quiet() as unknown as Record<string, number>)[key()]; void v; });
    if (!element.startsWith("Cannot read properties of undefined") || trace !== "qk") throw new Error("element " + element + " " + trace);
    trace = "";
    const skipped = (quiet() as unknown as { m(a: number): number } | undefined)?.m(arg());
    const absent = (quiet() as unknown as { x: number } | undefined)?.x;
    if (skipped !== undefined || absent !== undefined || trace !== "qq") throw new Error("optional " + trace);
    `,
);

test("a void receiver without a proven undefined completion refuses", () => {
    // The annotation erased what ask returns: JavaScript reads its object.
    for (const read of [
        "(ask() as unknown as { m(): number }).m()",
        "(ask() as unknown as { x: number }).x",
        "(ask() as unknown as { m(): number } | undefined)?.m()",
        '(ask() as unknown as Record<string, number>)["x"]',
    ])
        assert.throws(
            () =>
                compileSource(
                    `const ask: () => void = () => ({ m() { return 3; }, x: 4 }); const v = ${read}; export {};`,
                ),
            /A void receiver requires a proven undefined completion/,
            read,
        );
});

check(
    "an undefined-typed method result compares as undefined",
    `
    class C {
        n = 0;
        add(): undefined { this.n += 10; return undefined; }
    }
    const c = new C();
    if (c.add() !== undefined || c.n !== 10) throw new Error("undefined result " + c.n);
    `,
);

check(
    "records-of-two-literal-shapes-keep-a-field-one-shape-declares-undefined",
    `
    interface Passage { x: number; r: number; transition?: number }
    interface Opening { x: number; r: number; passageTransition?: number; hint?: number }
    const openings: Opening[] = [{ x: 1, r: 0.5, passageTransition: 3, hint: 1 }, { x: 4, r: 0.5 }, { x: 2, r: 1, hint: 2 }];
    const found = openings.flatMap((opening) => opening.hint !== undefined
        ? [{ x: opening.x, r: opening.r, transition: opening.passageTransition }]
        : [{ x: opening.x, r: opening.r }]);
    let sum = 0;
    for (const each of found) sum += each.x;
    const passages: Passage[] = found;
    let total = 0;
    for (const passage of passages) total += passage.x + (passage.transition ?? passage.r * 10);
    if (sum !== 7 || total !== 25) throw new Error("sum " + sum + " total " + total);
`,
);

check(
    "in-tells-an-own-undefined-a-map-callback-writes-from-a-missing-key",
    `
    interface Passage { x: number; r: number; transition?: number }
    interface Opening { x: number; r: number; passageTransition?: number }
    const openings: Opening[] = [{ x: 1, r: 0.5, passageTransition: 3 }, { x: 4, r: 0.5 }];
    const written = openings.map((opening) => ({ x: opening.x, r: opening.r, transition: opening.passageTransition }));
    const passages: Passage[] = written;
    const bare: Passage[] = [{ x: 2, r: 1 }];
    let owns = 0;
    for (const each of [...passages, ...bare]) if ("transition" in each) owns++;
    if (owns !== 2) throw new Error("owns " + owns);
`,
);

check(
    "in-tells-apart-records-of-two-literal-shapes-one-declaring-the-key-undefined",
    `
    interface Opening { x: number; r: number; passageTransition?: number; hint?: number }
    const openings: Opening[] = [{ x: 1, r: 0.5, passageTransition: 3, hint: 1 }, { x: 4, r: 0.5 }, { x: 2, r: 1, hint: 2 }];
    const found = openings.flatMap((opening) => opening.hint !== undefined
        ? [{ x: opening.x, r: opening.r, transition: opening.passageTransition }]
        : [{ x: opening.x, r: opening.r }]);
    let owns = 0;
    for (const each of found) if ("transition" in each) owns++;
    if (owns !== 2) throw new Error("owns " + owns);
`,
);

check(
    "a-stored-generic-method-returning-t-or-null-runs-a-void-operation",
    `
    interface Runner { run<T>(operation: () => T): T | null }
    const gate = new Float32Array([1]);
    let edits = 0;
    const runners: Runner[] = [{ run: (operation) => (gate[0]! > 0 ? operation() : null) }];
    const value = runners[0]!.run(() => 5);
    const nothing = runners[0]!.run(() => { edits++; });
    if (value !== 5 || nothing !== undefined || edits !== 1) throw new Error("run " + value + " " + nothing + " " + edits);
`,
);

check(
    "a-map-callback-returning-undefined-fills-an-array-of-documents",
    `
    interface Thumb { shot: string; at: number }
    const gate = new Float32Array([1]);
    function parse(text: string): unknown { return JSON.parse(text); }
    function listSaves(keys: string[]): string {
        let cached: (Thumb | undefined)[];
        if (gate[0]! > 2) cached = keys.map((key) => parse(key) as Thumb | undefined);
        else cached = keys.map(() => undefined);
        let missing = 0;
        for (const value of cached) if (value === undefined) missing++;
        return missing + ":" + cached.length + ":" + String(cached[1]);
    }
    const listed = listSaves(["a", "b"]);
    if (listed !== "2:2:undefined") throw new Error(listed);
`,
);

check(
    "a-chained-null-assignment-stores-null-in-each-slot",
    `
    let patchPos: Float32Array | null = new Float32Array([1, 2]);
    let patchNrm: Float32Array | null = new Float32Array([3]);
    let patchIdx: Uint32Array | null = new Uint32Array([4, 5, 6]);
    const gate = new Float32Array([1]);
    const total = (patchPos?.length ?? 0) + (patchNrm?.length ?? 0) + (patchIdx?.length ?? 0);
    if (gate[0]! > 0) patchPos = patchNrm = patchIdx = null;
    if (total !== 6 || patchPos !== null || patchNrm !== null || patchIdx !== null) throw new Error("patch " + total);
`,
);
