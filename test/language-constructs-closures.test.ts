import { check, checkInRealm } from "./language-constructs.js";

check(
    "locals-holding-record-field-arrays-share-their-elements",
    `
    type Lanes = { readonly name: string; readonly lanes?: number[] };
    type Mixed = { readonly name: string; readonly lanes?: number | number[] };
    const WATER: Lanes = { name: "water", lanes: [1, 2, 3] };
    const MIXED: Mixed = { name: "mixed", lanes: [1, 2, 3] };
    function describe(item: Lanes | Mixed): string {
        return \`\${item.name}=\${JSON.stringify(item.lanes)}\`;
    }
    const waterLanes = WATER.lanes;
    if (waterLanes) waterLanes[0] = 7;
    const mixedLanes = MIXED.lanes;
    if (Array.isArray(mixedLanes)) mixedLanes[1] = 8;
    const water = \`\${describe(WATER)}\`;
    const mixed = \`\${describe(MIXED)}\`;
    if (water !== "water=[7,2,3]") throw new Error(water);
    if (mixed !== "mixed=[1,8,3]") throw new Error(mixed);
`,
);

// A recursive function's readonly array parameter is its caller's array
// where the function compares it by identity.
check(
    "recursive-readonly-array-parameter-identity",
    `
    interface Collider { ax: number; radius: number; group?: number }
    interface Index { colliders: readonly Collider[]; count: number }
    let active: Index | null = null;
    function matches(index: Index | null, colliders: readonly Collider[]): index is Index {
        return index !== null && index.colliders === colliders && index.count === colliders.length;
    }
    function serves(colliders: readonly Collider[]): boolean { return matches(active, colliders); }
    function prime(colliders: readonly Collider[]): void {
        if (!matches(active, colliders)) active = { colliders, count: colliders.length };
    }
    let indexed = 0;
    function pointClear(x: number, colliders: readonly Collider[], depth: number): boolean {
        if (depth > 0 && !pointClear(x + 1, colliders, depth - 1)) return false;
        if (serves(colliders)) { indexed++; return active!.colliders.every((c) => Math.abs(c.ax - x) > c.radius); }
        return colliders.every((c) => Math.abs(c.ax - x) > c.radius);
    }
    function run(x: number, list: readonly Collider[], depth: number): boolean { return pointClear(x, list, depth); }
    const set: Collider[] = [{ ax: 0, radius: 1 }];
    const primes: Array<typeof prime> = [prime];
    const runs: Array<typeof run> = [run];
    primes[0]!(set);
    if (runs[0]!(5, set, 2) !== true || runs[0]!(-1, set, 1) !== false || indexed !== 4) throw new Error("indexed set");
    if (runs[0]!(5, [{ ax: 0, radius: 1 }], 1) !== true || indexed !== 4) throw new Error("equal set is another array");
`,
);

// A slot handed arrays of several kinds stores one numeric view of
// whichever it holds, keeping that array's identity.
check(
    "array-like-slots-share-one-view-across-kinds",
    `
    function total(values: ArrayLike<number>): number {
        let sum = 0;
        for (let i = 0; i < values.length; i++) sum += values[i]!;
        return sum;
    }
    function poke(view: { [index: number]: number }, index: number, value: number): void { view[index] = value; }
    interface Sample { values: ArrayLike<number>; readonly label: string; }
    const floats = new Float32Array([1, 2, 3]);
    const numbers: number[] = [4, 5];
    const tuple: [number, number, number] = [7, 8, 9];
    const sample: Sample = { values: floats, label: "s" };
    if (total(sample.values) !== 6 || sample.values.length !== 3) throw new Error("typed array");
    floats[0] = 10;
    if (sample.values[0] !== 10) throw new Error("typed array alias");
    poke(sample.values, 1, 20);
    if (floats[1] !== 20) throw new Error("writes through the view");
    sample.values = numbers;
    numbers.push(6);
    if (sample.values.length !== 3 || total(sample.values) !== 15 || sample.values !== numbers) throw new Error("number array");
    if (sample.values === floats) throw new Error("identity");
    if (Array.from(sample.values, (value) => value * 2).join(",") !== "8,10,12") throw new Error("Array.from over the view");
    sample.values = tuple;
    tuple[1] = 0;
    if (total(sample.values) !== 16) throw new Error("tuple");

    let view: ArrayLike<number> | null = null;
    const viewed = (): number => (view ? view.length : -1);
    if (viewed() !== -1) throw new Error("empty view");
    view = floats;
    if (viewed() !== 3) throw new Error("typed binding");
    view = numbers;
    numbers[0] = 40;
    if (view[0] !== 40 || viewed() !== 3) throw new Error("array binding");

    interface Pose { pose(): ArrayLike<number>; list(): readonly ArrayLike<number>[]; }
    const poses: Pose[] = [
        { pose: () => floats, list: () => [floats, tuple] },
        { pose: () => numbers, list: () => [numbers] },
    ];
    let sum = 0;
    for (const pose of poses) {
        sum += pose.pose()[0]!;
        for (const entry of pose.list()) sum += entry.length;
    }
    if (sum !== 10 + 40 + 3 + 3 + 3) throw new Error("results");
    floats[2] = 30;
    if (poses[0]!.pose()[2] !== 30 || poses[0]!.list()[0]![2] !== 30) throw new Error("result aliases");
`,
);

check(
    "kept-callbacks-through-wrappers-share-caller-bindings",
    `
    const kept: Array<() => void> = [];
    function keep(cb: () => void): void { kept.push(cb); }
    let ready = true;
    const noop = (): void => {};
    let viaAs = 0, viaSatisfies = 0, viaParens = 0, viaArm = 0, viaCoalesce = 0, viaLocal = 0, viaCalled = 0;
    keep((() => { viaAs++; }) as () => void);
    keep((() => { viaSatisfies++; }) satisfies () => void);
    keep((() => { viaParens++; }));
    keep(ready ? () => { viaArm++; } : noop);
    const missing: (() => void) | undefined = ready ? undefined : noop;
    keep(missing ?? (() => { viaCoalesce++; }));
    const local = ready ? () => { viaLocal++; } : noop;
    keep(local);
    const chosen = missing ?? (() => { viaCalled++; });
    chosen();
    for (const cb of kept) cb();
    ready = false;
    if (viaAs !== 1 || viaSatisfies !== 1 || viaParens !== 1) throw new Error("wrapped argument");
    if (viaArm !== 1 || viaCoalesce !== 1 || viaLocal !== 1) throw new Error("selected argument");
    if (viaCalled !== 1) throw new Error("selected callback called in place");
`,
);

check(
    "factory-records-share-their-frame-and-keep-callbacks",
    `
    interface Batch {
        count(): number;
        keyAt(index: number): number | null;
        setTint(rgb: readonly number[]): void;
        add(x: number): void;
        total(): number;
        dispose(): void;
    }
    const disposers: Array<() => void> = [];
    let disposals = 0;
    function createBatch(): Batch {
        let box = 0;
        let tint = 1;
        const keys: number[] = [];
        const keyAt = (index: number): number | null => index < box ? keys[index]! : null;
        const batch: Batch = {
            count: () => box,
            keyAt,
            setTint(rgb) { tint = rgb[0]!; },
            add(x) { keys.push(x * tint); box++; },
            total() { let sum = 0; for (let index = 0; index < box; index++) sum += batch.keyAt(index) ?? 0; return sum; },
            dispose() { disposals++; },
        };
        disposers.push(batch.dispose);
        return batch;
    }
    const wood = createBatch();
    const stone = createBatch();
    wood.setTint([2]);
    wood.add(3);
    wood.add(4);
    stone.add(5);
    if (wood.count() !== 2 || stone.count() !== 1 || wood.total() !== 14 || wood.keyAt(2) !== null) throw new Error("factory frames");
    for (const dispose of disposers) dispose();
    if (disposals !== 2) throw new Error("method value");

    interface Splash {
        setProgress: (p: number, key?: string) => void;
        onAbout(cb: () => void): void;
        onValue: (cb: () => void) => void;
        about(): void;
        caption(): string;
    }
    function createSplash(): Splash {
        let target = 0;
        let status = "sub";
        let aboutCallback: (() => void) | null = null;
        const listeners: Array<() => void> = [];
        return {
            setProgress(p: number, key?: string): void {
                if (key) status = key;
                target = Math.max(target, p);
            },
            onAbout(cb: () => void): void { aboutCallback = cb; },
            onValue: (cb) => { listeners.push(cb); },
            about(): void {
                if (aboutCallback) aboutCallback();
                for (const listener of listeners) listener();
            },
            caption: () => status + ":" + Math.round(target * 100),
        };
    }
    const splash = createSplash();
    const marks: string[] = [];
    {
        const inner = splash.setProgress;
        splash.setProgress = (p: number, key?: string): void => { marks.push(key ?? "p"); inner(p, key); };
    }
    let abouts = 0;
    let values = 0;
    splash.onAbout(() => abouts++);
    splash.onValue(() => { values += 2; });
    splash.setProgress(0.25, "load");
    splash.setProgress(0.5);
    splash.about();
    if (splash.caption() !== "load:50" || marks.join(",") !== "load,p") throw new Error("shared factory state");
    if (abouts !== 1 || values !== 2) throw new Error("record member keeps its callback");

    class Keeper {
        private kept: Array<() => void> = [];
        keep(cb: () => void): void { this.kept.push(cb); }
        wire(cb: () => void): void { this.keep(cb); }
        fire(): void { for (const cb of this.kept) cb(); }
    }
    const keeper = new Keeper();
    let viaMethod = 0;
    let viaThis = 0;
    keeper.keep(() => viaMethod++);
    keeper.wire(() => viaThis++);
    const kept: Array<() => void> = [];
    function forward(register: (cb: () => void) => void, step: number): void {
        let local = 0;
        register(() => { local += step; viaParameter = local; });
    }
    let viaParameter = 0;
    forward((cb) => kept.push(cb), 3);
    function keepAll(...callbacks: Array<() => void>): void { for (const cb of callbacks) kept.push(cb); }
    let viaRest = 0;
    keepAll(() => {}, () => viaRest++);
    keeper.fire();
    for (const cb of kept) cb();
    for (const cb of kept) cb();
    if (viaMethod !== 1 || viaThis !== 1) throw new Error("class method keeps its callback");
    if (viaParameter !== 6 || viaRest !== 2) throw new Error("function value keeps its callback");
`,
);

check(
    "closure-calling-its-enclosing-function",
    `
    let gen = 0;
    let seen = "";
    function request(depth: number): void {
        const generation = ++gen;
        const finish = (): void => {
            if (generation !== gen) return;
            if (depth < 2) {
                request(depth + 1);
                return;
            }
            seen += "d" + depth + "g" + generation;
        };
        finish();
        seen += ";" + depth;
    }
    request(0);
    if (seen !== "d2g3;2;1;0") throw new Error(seen);
    let calls = "";
    function walk(depth: number): void {
        const level = depth;
        ((): void => {
            if (level < 2) walk(level + 1);
        })();
        calls += level;
    }
    walk(0);
    if (calls !== "210") throw new Error("immediate " + calls);
`,
);

// A closure built above a destructuring pattern calls the names the
// pattern declares, once they are initialized.
check(
    "closure-calling-names-a-later-pattern-declares",
    `
    const flag = Math.random() >= 0;
    interface Boundary { cellRadius(index: number): number; postRadius(index: number): number; margin: number }
    function makeBoundary(scale: number): Boundary {
        return { cellRadius: (index) => index * scale, postRadius: (index) => index * scale + 1, margin: scale / 2 };
    }
    interface Align { read(index: number): number }
    function makeAlign(deps: { radius: (index: number) => number; grounded: () => boolean }): Align {
        return { read: (index) => (deps.grounded() ? deps.radius(index) : -1) };
    }
    function build(scale: number): number {
        const align = makeAlign({ radius: (index) => postLimit(index) + cellRadius(index) + margin, grounded: () => ready });
        const boundary = makeBoundary(scale);
        const { cellRadius, postRadius: postLimit, margin } = boundary;
        const ready = flag;
        return align.read(2);
    }
    if (build(3) !== 14.5) throw new Error("returned record " + build(3));
    function local(scale: number): number {
        const align = makeAlign({ radius: (index) => twice(index) + offset, grounded: () => true });
        const tools = { twice: (index: number): number => index * 2 * scale, offset: flag ? 1 : 0 };
        const { twice, offset } = tools;
        return align.read(3);
    }
    if (local(2) !== 13) throw new Error("literal record " + local(2));
`,
);

// A closure stored where a union holds several function types takes the
// one with its own parameter and result types.
check(
    "a-closure-in-a-union-of-function-types-takes-the-arm-its-signature-fits",
    `
    interface Batch { resume: number | (() => number) | ((mark: number) => number) }
    const base = new Float32Array([2])[0]!;
    const batches: Batch[] = [{ resume: () => base + 1 }, { resume: (mark: number) => mark * base }, { resume: 7 }];
    let total = 0;
    for (const batch of batches) {
        const resume = batch.resume;
        if (typeof resume === "number") total += resume;
    }
    const none = batches[0]!.resume as () => number;
    const marked = batches[1]!.resume as (mark: number) => number;
    total += none() + marked(5);
    if (total !== 7 + 3 + 10) throw new Error("total " + total);
`,
);

check(
    "constructor-callback-instance-capture",
    `
    interface Hooks { change: () => number; }
    class Counter {
        value = 0;
        constructor(private readonly hooks: Hooks) {}
        next(): number { this.value++; return this.hooks.change(); }
    }
    const counter = new Counter({change: () => counter.value});
    if (counter.next() !== 1 || counter.next() !== 2) throw new Error("constructor closure observes instance");
`,
);

check(
    "recursive-array-callback",
    `
    function evaluate(seed: number): number {
        const memo = new Map<number, number>();
        const depth = (value: number): number => {
            const known = memo.get(value);
            if (known !== undefined) return known;
            const parents: number[] = value > 1 ? [value - 1, value - 2] : [];
            const result = parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
            memo.set(value, result);
            return result;
        };
        return depth(seed);
    }
    if (evaluate(6) !== 5 || evaluate(3) !== 2) throw new Error("recursive array callback captures");
`,
);

checkInRealm(
    "a-record-holding-an-instance-where-its-base-holds-a-dynamic-value-shares-one-layout",
    `
    class Failure extends Error {
        constructor(readonly code: number) {
            super("failure " + code);
            this.name = "Failure";
        }
    }
    interface Report {
        kind: string;
        error: unknown;
        context?: string;
    }
    let log = "";
    let last: Report | null = null;
    let gate: ((input: Report) => boolean) | null = null;
    function describe(error: unknown): string {
        if (!error || typeof error !== "object") return typeof error === "string" ? error : "?";
        const message = (error as Record<string, unknown>)["message"];
        return typeof message === "string" ? message : "?";
    }
    function funnel(input: Report): void {
        if (gate?.(input) === true) return;
        log += input.kind + ":" + describe(input.error) + (input.context ?? "") + ";";
    }
    function reportFailure(input: Report & { error: Failure }): void {
        if (!(input.error instanceof Failure)) return;
        funnel(input);
    }
    // An open value asserted to a record type and compared by identity: a
    // copy of the narrower record could not be told apart from it.
    interface Token {
        readonly id?: number;
    }
    const tokens = new Set<Token>();
    function remember(value: unknown): boolean {
        const token = value as Token;
        if (tokens.has(token)) return false;
        tokens.add(token);
        return true;
    }
    gate = (input) => {
        last = input;
        return input.kind === "quiet";
    };
    const parsed: unknown = JSON.parse('{"id":1}');
    log += (remember(parsed) ? "new" : "old") + (remember(parsed) ? "new" : "old") + ";";
    const boot = { kind: "boot", error: new Failure(7), context: "@1" };
    reportFailure(boot);
    if (last !== boot || boot.error.code !== 7) throw new Error("shared record");
    reportFailure({ kind: "quiet", error: new Failure(8) });
    funnel({ kind: "plain", error: "text" });
    if (log !== "newold;boot:failure 7@1;plain:text;") throw new Error("log " + log);
    globalThis.close();
`,
);

check(
    "getter-and-data-property-share-one-accessor-slot",
    `
    interface Plain { cx: number; cz: number }
    interface Live { readonly cx: number; readonly cz: number }
    const flag = Math.random() >= 0;
    let reads = 0;
    const live: Live = { get cx() { reads++; return flag ? 1 : 0; }, cz: 2 };
    const plains: Plain[] = [{ cx: 3, cz: 4 }];
    const all: Live[] = [live];
    all.push(plains[0]!);
    plains[0]!.cx = 9;
    let total = 0;
    for (const entry of all) total += entry.cx + entry.cz;
    if (total !== 16) throw new Error("total " + total);
    if (reads !== 1) throw new Error("reads " + reads);
`,
);

check(
    "recursion-through-stored-instances",
    `
    class TreeNode {
        children: TreeNode[] = [];
        constructor(readonly value: number) {}
        add(child: TreeNode): TreeNode {
            this.children.push(child);
            return this;
        }
        sum(): number {
            let total = this.value;
            for (const child of this.children) total += child.sum();
            return total;
        }
    }
    const root = new TreeNode(1);
    const mid = new TreeNode(2);
    mid.add(new TreeNode(3));
    root.add(mid).add(new TreeNode(4));
    if (root.sum() !== 10) throw new Error("sum " + root.sum());
`,
);

check(
    "recursion-through-a-stored-hierarchy",
    `
    abstract class Shape {
        abstract area(): number;
        describe(depth: number): string {
            return "shape@" + depth;
        }
    }
    class Square extends Shape {
        constructor(readonly side: number) {
            super();
        }
        area(): number {
            return this.side * this.side;
        }
    }
    class Group extends Shape {
        readonly children: Shape[] = [];
        add(shape: Shape): Group {
            this.children.push(shape);
            return this;
        }
        area(): number {
            let total = 0;
            for (const child of this.children) total += child.area();
            return total;
        }
        override describe(depth: number): string {
            const parts: string[] = [];
            for (const child of this.children) parts.push(child.describe(depth + 1));
            return "group@" + depth + "[" + parts.join(",") + "]";
        }
        count(): number {
            return this.children.reduce((sum, child) => sum + (child instanceof Group ? child.count() : 1), 0);
        }
    }
    const inner = new Group().add(new Square(1)).add(new Square(2));
    const root = new Group().add(inner).add(new Square(3));
    if (root.area() !== 14) throw new Error("composite area " + root.area());
    if (root.describe(0) !== "group@0[group@1[shape@2,shape@2],shape@1]") throw new Error("describe " + root.describe(0));
    if (root.count() !== 3) throw new Error("count " + root.count());
    const shapes: Shape[] = [root, new Square(4)];
    let total = 0;
    for (const shape of shapes) total += shape.area();
    if (total !== 30) throw new Error("total " + total);
`,
);

check(
    "mutual-recursion-through-stored-instances",
    `
    class Ping {
        next: Pong | null = null;
        constructor(readonly weight: number) {}
        total(): number {
            return this.weight + (this.next ? this.next.total() : 0);
        }
    }
    class Pong {
        next: Ping | null = null;
        constructor(readonly weight: number) {}
        total(): number {
            return this.weight * 10 + (this.next ? this.next.total() : 0);
        }
    }
    const pongs: Pong[] = [];
    const chain: Ping[] = [];
    const a = new Ping(1);
    const b = new Pong(2);
    const c = new Ping(3);
    a.next = b;
    b.next = c;
    pongs.push(b);
    chain.push(a, c);
    if (a.total() !== 24) throw new Error("mutual " + a.total());
    let sum = 0;
    for (const ping of chain) sum += ping.total();
    if (sum !== 27) throw new Error("sum " + sum);
`,
);

check(
    "a stored closure reads later bindings through the functions it reaches",
    `
    function main(): void {
        const handlers: Array<() => void> = [];
        handlers.push(() => markCommitted());
        let edits = 0;
        let admitted = false;
        const log: string[] = [];
        const label = "edit" + log.length;
        const markEdited = (): void => {
            if (admitted) return;
            edits += 1;
            log.push(label + ":" + edits);
        };
        const markCommitted = (): void => markEdited();
        for (const handler of handlers) handler();
        admitted = true;
        for (const handler of handlers) handler();
        if (edits !== 1 || log.join() !== "edit0:1") throw new Error("stored callback " + log.join());
    }
    main();
`,
);

check(
    "stored closures preserve the temporal dead zone of pure later bindings",
    `
    function main(): void {
        const seed = 7;
        const readers: Array<() => number> = [];
        readers.push(() => literal);
        readers.push(() => reference);
        readers.push(() => dependent);
        let refused = 0;
        for (const read of readers) {
            try { read(); } catch { refused++; }
        }
        const literal = 7;
        const reference = seed;
        const laterSeed = 7;
        const dependent = laterSeed * 2;
        if (refused !== 3) throw new Error("later initializer ran early");
        if (readers[0]!() !== 7 || readers[1]!() !== 7 || readers[2]!() !== 14)
            throw new Error("later initializer value");
    }
    main();
`,
);

check(
    "stored closures preserve the temporal dead zone of later callback records",
    `
    const readers: Array<() => number> = [];
    readers.push(() => options.read());
    readers.push(() => readOptions());
    let refused = 0;
    for (const read of readers) {
        try { read(); }
        catch (error) {
            if (!String(error).includes("before initialization")) throw error;
            refused++;
        }
    }
    if (refused !== 2) throw new Error("later callback record initialized early");
    const options = { read: () => 7 };
    function readOptions(): number { return options.read(); }
    if (readers[0]!() !== 7 || readers[1]!() !== 7)
        throw new Error("later callback record value");
`,
);

check(
    "expression-bodied-recursive-callbacks",
    `
    function root(values: readonly number[], index: number): number {
        const parent = values.slice();
        const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
        return find(index) * 10 + parent[index]!;
    }
    const seen: number[] = [];
    function log(k: number): void { seen.push(k); }
    function visit(k: number, next: (k: number) => void): void { seen.push(k); if (k > 0) next(k - 1); }
    function walk(n: number): string {
        const down = (k: number): void => (k > 0 ? down(k - 1) : log(k));
        const each = (k: number): void => visit(k, each);
        down(n);
        each(n);
        return seen.join(",");
    }
    const roots: Array<typeof root> = [root];
    const walks: Array<typeof walk> = [walk];
    if (roots[0]!([1, 1, 1, 2], 3) !== 11 || walks[0]!(2) !== "0,2,1,0") throw new Error("expression-bodied recursion");
`,
);

check(
    "functions-re-entered-through-their-callback-arguments",
    `
    interface Extent { pos: number; neg: number }
    function walkAlternating<T>(firstSide: 1 | -1, step: number, extent: Extent, tryOffset: (offset: number) => T | null): T | null {
        const first = tryOffset(0);
        if (first) return first;
        for (let n = 1; step > 0 && (n * step <= extent.pos || n * step <= extent.neg); n++) {
            const near = tryOffset(firstSide * n * step);
            if (near) return near;
            const far = tryOffset(-firstSide * n * step);
            if (far) return far;
        }
        return null;
    }
    function findFreePoint(base: number, blocked: (x: number) => boolean): { x: number } | null {
        return walkAlternating(1, 1, { pos: 3, neg: 3 }, (offset) => (blocked(base + offset) ? null : { x: base + offset }));
    }
    function findHook(side: 1 | -1, blocked: (x: number) => boolean): { x: number; hook: number } | null {
        return walkAlternating(side, 1, { pos: 2, neg: 2 }, (offset) => {
            const point = findFreePoint(offset * 10, blocked);
            return point ? { x: point.x, hook: offset } : null;
        });
    }
    const hooks: Array<typeof findHook> = [findHook];
    const found = hooks[0]!(1, (x) => x < 11);
    const reversed = findHook(-1, (x) => x > -9 && x < 30);
    if (!found || found.x !== 11 || found.hook !== 1) throw new Error("nested walk");
    if (!reversed || reversed.x !== -10 || reversed.hook !== -1) throw new Error("nested walk from the far side");
`,
);

check(
    "narrower-literals-share-the-wider-record-layout",
    `
    type Spec = { id: string; rgb: [number, number, number] };
    type Swatch = Spec & { swatch: string };
    function palette(): { id: string; labelKey: string; rgb: [number, number, number]; swatch: string }[] {
        return [{ id: "a", labelKey: "tint.a", rgb: [1, 2, 3], swatch: "#a" }];
    }
    const base = palette();
    const extra: Spec = { id: "b", rgb: [4, 5, 6] };
    const all: Swatch[] = [...base, { ...extra, swatch: "#b" }];
    if (all[0] !== base[0]) throw new Error("converted record keeps its identity");
    all[0]!.swatch = "#c";
    all[0]!.id = "z";
    if (base[0]!.swatch !== "#c" || base[0]!.id !== "z" || base[0]!.labelKey !== "tint.a") throw new Error("write through the narrower view");
    base[0]!.swatch = "#d";
    if (all[0]!.swatch !== "#d") throw new Error("write through the wider record");
    const narrow = all[1]!;
    if (Object.keys(narrow).join(",") !== "id,rgb,swatch") throw new Error("narrower keys " + Object.keys(narrow).join(","));
    if (JSON.stringify(narrow) !== '{"id":"b","rgb":[4,5,6],"swatch":"#b"}') throw new Error("narrower JSON " + JSON.stringify(narrow));
    if (Object.keys(base[0]!).join(",") !== "id,labelKey,rgb,swatch") throw new Error("wider keys " + Object.keys(base[0]!).join(","));
    if (JSON.stringify(all[0]) !== '{"id":"z","labelKey":"tint.a","rgb":[1,2,3],"swatch":"#d"}') throw new Error("wider JSON " + JSON.stringify(all[0]));
`,
);

check(
    "records-storing-a-function-of-a-narrower-signature-share-the-declared-layout",
    `
    interface Storage { readonly name: string; readonly vertex?: boolean; readonly data: (n: number) => number[] | null | undefined }
    interface Part { readonly storage: readonly Storage[] }
    function compose(parts: readonly Part[]): Storage[] { const flat: Storage[] = []; for (const part of parts) flat.push(...part.storage); return flat; }
    function makePart(scale: number): Part {
        const entry = { name: "clip", vertex: true as const, data: (n: number): number[] | null => (n > 0 ? [n * scale] : null) };
        return { storage: [entry] };
    }
    const roots = [compose];
    const parts: Part[] = [makePart(2)];
    const flat = roots[0]!(parts);
    const first = flat[0]!;
    if (first.name !== "clip" || first.data(3)?.[0] !== 6 || first.data(0) != null || parts[0]!.storage[0] !== first || first.vertex !== true) throw new Error("storage");
`,
);

check(
    "readonly-record-views-share-the-written-layout",
    `
    interface Vec { x: number; y: number; z: number }
    interface Rest {
        readonly transforms: ReadonlyArray<{
            readonly position: { readonly x: number; readonly y: number; readonly z: number };
            readonly rotation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
        }>;
        launched: boolean;
    }
    const meshes: Vec[] = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }];
    const state: Rest = {
        transforms: meshes.map((mesh) => ({
            position: { x: mesh.x, y: mesh.y, z: mesh.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        })),
        launched: false,
    };
    const live = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    live.position = { x: 7, y: 8, z: 9 };
    const rest = state.transforms[1]!;
    if (rest.position.y !== 5 || rest.rotation.w !== 1 || live.position.z !== 9) throw new Error("readonly views");
`,
);

check(
    "later-bindings-read-from-nested-levels",
    `
    interface Follow { settled(): void; count(): number }
    function createFollow(step: number): Follow { let n = 0; return { settled: () => { n += step; }, count: () => n }; }
    // A closure built in a nested block reads a binding the enclosing block
    // declares later: the binding's storage exists ahead of the block.
    function nestedBlock(active: boolean): number {
        const handlers: (() => void)[] = [];
        if (active) {
            const finish = (): void => { casters.settled(); };
            handlers.push(finish);
        }
        const casters = createFollow(2);
        for (const handler of handlers) handler();
        return casters.count();
    }
    if (nestedBlock(true) !== 2 || nestedBlock(false) !== 0) throw new Error("nested block");
    function nestedNumber(active: boolean): number {
        const handlers: (() => void)[] = [];
        let total = 0;
        if (active) {
            const finish = (): void => { total += limit; };
            handlers.push(finish);
        }
        const limit = handlers.length + 4;
        for (const handler of handlers) handler();
        return total;
    }
    if (nestedNumber(true) !== 5 || nestedNumber(false) !== 0) throw new Error("nested number");
    function twoLevels(active: boolean): number {
        const handlers: (() => void)[] = [];
        if (active) {
            for (let i = 0; i < 2; i++) {
                const finish = (): void => { casters.settled(); };
                handlers.push(finish);
            }
        }
        const casters = createFollow(2);
        for (const handler of handlers) handler();
        return casters.count();
    }
    if (twoLevels(true) !== 4) throw new Error("two levels");
    function reassigned(active: boolean): number {
        let finish = (): void => {};
        if (active) {
            finish = (): void => { casters.settled(); };
        }
        const casters = createFollow(3);
        finish();
        return casters.count();
    }
    if (reassigned(true) !== 3 || reassigned(false) !== 0) throw new Error("reassigned");
    // Two later bindings, one a pattern's name, read by one nested closure.
    function several(active: boolean): string {
        const handlers: (() => string)[] = [];
        if (active) {
            handlers.push(() => label + ":" + radius + ":" + casters.count());
        }
        const casters = createFollow(1);
        const { radius } = { radius: 7 };
        const label = "ring" + handlers.length;
        casters.settled();
        return handlers.map((handler) => handler()).join();
    }
    if (several(true) !== "ring1:7:1") throw new Error("several " + several(true));
    // Its temporal dead zone holds: a read before the declaration throws.
    function early(): string {
        const handlers: (() => number)[] = [];
        {
            handlers.push(() => limit + 1);
        }
        let outcome = "";
        try {
            handlers[0]!();
            outcome = "read";
        } catch {
            outcome = "threw";
        }
        const limit = 4;
        return outcome + ":" + handlers[0]!();
    }
    if (early() !== "threw:5") throw new Error("temporal dead zone " + early());
    // A closure handed to a function reads bindings its caller's block
    // declares later, from that function's own nested block.
    interface World { night(): number; drop(): void }
    interface Options { onDrop: () => void; label: string }
    const registry: (() => void)[] = [];
    function makeCounter(): { bump(): void; read(): number } { let n = 0; return { bump: () => { n++; }, read: () => n }; }
    function buildWorld(options: Options): World {
        const counter = makeCounter();
        registry.push(() => options.onDrop());
        if (options.label.length > 0) {
            const drop = (): void => { options.onDrop(); counter.bump(); };
            registry.push(drop);
        }
        return { night: () => counter.read(), drop: () => { for (const entry of registry) entry(); } };
    }
    function main(): string {
        const world = buildWorld({ onDrop: () => { dropped.push(tag); }, label: "w" });
        const follow = (): number => world.night() + dropped.length;
        const dropped: string[] = [];
        const tag = "t" + registry.length;
        world.drop();
        return follow() + ":" + dropped.join();
    }
    if (main() !== "3:t2,t2") throw new Error("handed closure " + main());
    // Each lowering of the function's block declares its own storage.
    function twice(apply: (v: number) => number): number {
        const handlers: (() => number)[] = [];
        {
            handlers.push(() => apply(base));
        }
        const base = handlers.length + 1;
        return handlers[0]!();
    }
    if (twice((v) => v * 2) !== 4 || twice((v) => v + 5) !== 7) throw new Error("two lowerings");
    // A closure built by a closure of a nested block, and a function of the
    // block called from one, read the later binding all the same.
    function layered(active: boolean): number {
        const handlers: (() => () => number)[] = [];
        const register = (): void => {
            if (active) handlers.push(() => () => scale * 2);
        };
        if (active) {
            handlers.push(() => () => scale + 1);
            register();
        }
        const scale = handlers.length * 10;
        let total = 0;
        for (const handler of handlers) total += handler()();
        return total;
    }
    if (layered(true) !== 61 || layered(false) !== 0) throw new Error("layered " + layered(true));
    // Each iteration of a loop body declares its own storage.
    function perIteration(): string {
        const reads: (() => number)[] = [];
        for (let i = 0; i < 3; i++) {
            if (i !== 1) {
                reads.push(() => squared + i);
            }
            const squared = i * i;
        }
        return reads.map((read) => read()).join();
    }
    if (perIteration() !== "0,6") throw new Error("per iteration " + perIteration());
    // The block that declares it later is a loop's body or a plain block,
    // the closure at its level or nested in it.
    function loops(count: number): string {
        const reads: (() => number)[] = [];
        for (let i = 0; i < count; i++) {
            reads.push(() => squared + i);
            const squared = i * i;
        }
        for (const i of [5, 6]) {
            if (i !== 5) {
                reads.push(() => doubled - i);
            }
            const doubled = i * 2;
        }
        let k = 0;
        while (k < 2) {
            const step = k;
            {
                reads.push(() => cubed + step);
            }
            const cubed = step * step * step;
            k++;
        }
        {
            reads.push(() => last * 10);
            const last = reads.length;
        }
        return reads.map((read) => read()).join();
    }
    if (loops(Number("3")) !== "0,2,6,6,0,2,70") throw new Error("loops " + loops(Number("3")));
`,
);

check(
    "recursive-function-varying-literal-argument",
    `
    function makeLoop(limit: number): { begin(): void; log: string[] } {
        const log: string[] = [];
        let runs = 0;
        function start(fadeIn: boolean): void {
            runs++;
            log.push(fadeIn ? "in" : "cut");
            if (runs < limit) retry();
        }
        function retry(): void { start(false); }
        return { begin: () => start(true), log };
    }
    const loop = makeLoop(3);
    loop.begin();
    if (loop.log.join(",") !== "in,cut,cut") throw new Error("recursive literal argument " + loop.log.join(","));
    function countdown(label: string, n: number): string {
        return n === 0 ? label : countdown(label, n - 1) + label;
    }
    if (countdown("x", 2) !== "xxx") throw new Error("same literal recursion");
`,
);

checkInRealm(
    "closures-calling-each-other-through-record-callbacks",
    `
    type Decision = "quit" | "cancel";
    interface Deps {
        decide: (decision: Decision) => void;
        showConfirm: (opts: { onSave: () => void; onCancel: () => void }) => void;
        save: () => Promise<boolean> | boolean;
    }
    interface Attempt { phase: "confirm" | "saving"; }
    function createGate(deps: Deps): () => void {
        let active: Attempt | null = null;
        const showConfirm = (attempt: Attempt): void => {
            if (active !== attempt) return;
            attempt.phase = "confirm";
            deps.showConfirm({
                onSave: () => { if (active === attempt && attempt.phase === "confirm") save(attempt); },
                onCancel: () => { if (active === attempt) { active = null; deps.decide("cancel"); } },
            });
        };
        const save = (attempt: Attempt): void => {
            attempt.phase = "saving";
            void Promise.resolve()
                .then(() => deps.save())
                .then(
                    (saved) => {
                        if (active !== attempt) return;
                        if (saved === true) { active = null; deps.decide("quit"); }
                        else showConfirm(attempt);
                    },
                    () => showConfirm(attempt),
                );
        };
        return () => {
            if (active !== null) return;
            const attempt: Attempt = { phase: "confirm" };
            active = attempt;
            showConfirm(attempt);
        };
    }
    const gates: Array<typeof createGate> = [createGate];
    const decisions: string[] = [];
    let shown = 0;
    let saves = 0;
    const gate = gates[0]!({
        decide: (decision) => {
            decisions.push(decision);
            if (shown !== 2 || saves !== 2 || decisions.join(",") !== "quit") throw new Error("gate " + shown + saves + decisions.join(","));
            globalThis.close();
        },
        showConfirm: (opts) => { shown++; opts.onSave(); },
        save: () => ++saves > 1,
    });
    gate();
    if (shown !== 1 || saves !== 0) throw new Error("save waits for its promise");
`,
);

check(
    "closures capture each iteration's own for-let binding",
    `
    const plain: Array<() => number> = [];
    for (let i = 0; i < 3; i++) plain.push(() => i);
    const written: Array<() => number> = [];
    for (let i = 0; i < 4; i++) { written.push(() => i * 10); if (i === 1) i++; }
    const skipped: Array<() => number> = [];
    for (let i = 0; i < 4; i++) { if (i % 2) continue; skipped.push(() => i); }
    const manual: Array<() => number> = [];
    for (let i = 0; i < 3;) { manual.push(() => i); i++; }
    const pairs: Array<() => string> = [];
    for (let i = 0, j = 10; i < 2; i++, j--) pairs.push(() => i + ":" + j);
    const seen = [plain, written, skipped, manual].map((list) => list.map((f) => f()).join()).join("|") + "|" + pairs.map((f) => f()).join();
    if (seen !== "0,1,2|0,20,30|0,2|1,2,3|0:10,1:9") throw new Error(seen);
    `,
);

check(
    "a callback kept by splice or fill shares the bindings it captures",
    `
    let n = 0;
    const fns: (() => void)[] = [];
    fns.splice(0, 0, () => { n++; });
    fns[0]!();
    fns.fill(() => { n += 10; });
    fns[0]!();
    if (n !== 11) throw new Error("kept callback " + n);
    `,
);

check(
    "a-main-entry-shares-the-state-a-module-factory-call-created",
    `
    function createSampler() {
        let active = 0;
        return { sample: (x: number) => { active = x; return x; }, pending: () => active !== 0 };
    }
    const sampler = createSampler();
    function main(): void {
        if (sampler.pending()) throw new Error("fresh");
        sampler.sample(3);
        if (!sampler.pending()) throw new Error("pending");
    }
    main();
    `,
);
