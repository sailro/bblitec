import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { check, checkInRealm } from "./language-constructs.js";

check(
    "conditional-numeric-tuple-array-identity",
    `
    const gate = new Float32Array([1]);
    const tuple: [number, number, number, number] = gate[0] ? [1, 2, 3, 4] : [5, 6, 7, 8];
    const array: number[] = tuple;
    array[0] = 9;
    tuple[1] = 10;
    if (tuple[0] !== 9 || array[1] !== 10 || array !== tuple) throw new Error("tuple array identity");
    const fixed: [number, number] = [1, 2];
    const alias: number[] = fixed;
    alias[0] = 7;
    if (fixed[0] !== 7 || alias !== fixed) throw new Error("tuple array static aliases");
`,
);

check(
    "mixed-tuple-rest-bindings",
    `
    const object = {score:4};
    const source:[string,number,{score:number}|null] = ['head',2,object];
    const [head,...tail] = source;
    source[1] = 9;
    if(head !== 'head' || tail[0] !== 2 || tail.length !== 2) throw new Error('fresh rest storage');
    if(tail[1]) tail[1].score++;
    if(object.score !== 5) throw new Error('shallow object identity');
    tail[0] = 7;
    if(source[1] !== 9) throw new Error('independent rest writes');
    const pair:[string,number] = ['key',3];
    const [,,...empty] = pair;
    if(empty.length !== 0) throw new Error('empty rest');
    function copy(value:[string,number,boolean]):[number,boolean] {
        const [,...rest] = value;
        return rest;
    }
    const result = copy(['value',6,true]);
    if(result[0] !== 6 || result[1] !== true) throw new Error('returned rest');
    function parameter([head,...rest]:[string,number,boolean]):[number,boolean] {
        if(head !== 'value') throw new Error('parameter head');
        rest[0]++;
        return rest;
    }
    const row:[string,number,boolean] = ['value',8,false];
    const parameterTail = parameter(row);
    if(parameterTail[0] !== 9 || parameterTail[1] !== false || row[1] !== 8) throw new Error('parameter rest copy');
    const retained:(()=>number)[] = [];
    const rows:[string,number,boolean][] = [['a',3,true],['b',5,false]];
    for(const [head,...rest] of rows) {
        rest[0]++;
        retained.push(() => rest[0] + head.length);
    }
    if(retained[0]() !== 5 || retained[1]() !== 7 || rows[0][1] !== 3) throw new Error('loop rest lifetime');
    const numbers:[number,number,number] = [2,4,6];
    const [,...numericTail] = numbers;
    numericTail[0] = 10;
    if(numericTail[0] !== 10 || numbers[1] !== 4) throw new Error('numeric tuple rest');
    const entries = new Map<string,number>([['x',11]]);
    for(const [key,...rest] of entries) {
        rest[0]++;
        if(key !== 'x' || rest[0] !== 12 || entries.get(key) !== 11) throw new Error('map entry rest');
    }
    const values = new Set<number>([13]);
    for(const [,...rest] of values.entries()) {
        rest[0]++;
        if(rest[0] !== 14 || !values.has(13)) throw new Error('set entry rest');
    }
    const list:string[] = ['first','second'];
    for(const [index,...rest] of list.entries()) {
        rest[0] = 'changed';
        if(list[index] === 'changed') throw new Error('array entry rest');
    }
    for(const [,,...rest] of entries) if(rest.length !== 0) throw new Error('empty entry rest');
`,
);

check(
    "mixed-tuple-mutations",
    `
    const pair:[string,number] = ['head',2];
    const alias = pair;
    const positions:number[] = [0,1];
    for(const index of positions) pair[index] = index + 10;
    for(const index of positions) {
        const value = alias[index];
        if(typeof value !== 'number' || value !== index + 10) throw new Error('dynamic writes and shared identity');
    }
    if(pair.push('tail') !== 3 || alias.length !== 3) throw new Error('push result and alias');
    if(pair.pop() !== 'tail' || pair.shift() !== 10) throw new Error('pop and shift values');
    if(pair.unshift('new') !== 2) throw new Error('unshift length');
    const removed = pair.splice(1,1,20,30);
    const indices:number[] = [1,2];
    if(removed[0] !== 11 || pair.length !== 3) throw new Error('splice result');
    for(const index of indices) if(pair[index] !== (index + 1) * 10) throw new Error('splice insertion');
    pair.length = 0 as 2;
    if(alias.length !== 0 || pair.pop() !== undefined || pair.shift() !== undefined) throw new Error('empty mutation results');
    for(const index of positions) if(pair[index] !== undefined) throw new Error('out of range after truncation');
`,
);

check(
    "mixed-tuple-mutation-boundaries",
    `
    const source:[string,number] = ['head',2];
    const positions:number[] = [0];
    for(const index of positions) source[index] = 4;
    const value = source[0];
    if(typeof value !== 'number' || value !== 4) throw new Error('changed static lane');
    if(typeof value === 'number' && value + 1 !== 5) throw new Error('guarded numeric operation');
    function tail(pair:[string,number,boolean]):[number,boolean] {
        const [,...rest] = pair;
        return rest;
    }
    const row:[string,number,boolean] = ['head',2,true];
    const rows:[number,boolean][] = [];
    rows.push(tail(row));
    if(rows[0][0] !== 2 || rows[0][1] !== true) throw new Error('stored returned rest');
    let pair:[string,number] = ['head',2];
    const original = pair;
    function argument():number {pair=['new',3];return 4;}
    if(pair.push(argument()) !== 3 || original.length !== 3 || pair.length !== 2) throw new Error('push receiver snapshot');
    let numbers:number[] = [1];
    const before = numbers;
    let current = 2;
    function replace():number {numbers=[9];current=3;return 4;}
    if(numbers.push(current, replace()) !== 3 || before[1] !== 2 || before[2] !== 4 || numbers.length !== 1) throw new Error('ordinary push evaluation');
    if(numbers.push() !== 1) throw new Error('empty push length');
    const prepend = numbers;
    if(numbers.unshift(current, replace()) !== 3 || prepend[0] !== 3 || prepend[1] !== 4 || numbers.length !== 1) throw new Error('unshift evaluation');
    const spread:number[] = [5,6];
    function editSpread():number {spread[0]=7;return 8;}
    numbers.push(...spread, editSpread());
    if(numbers[1] !== 5 || numbers[2] !== 6 || numbers[3] !== 8) throw new Error('spread arguments evaluated before mutation');
    numbers.push(...numbers);
    if(numbers.length !== 8 || numbers[5] !== 5) throw new Error('self spread');
`,
);

// A spread literal of compile-time tuples is one: each spread builds a new
// array, read at generation, mutated, aliased, stored and compared as the
// run time keeps it.
check(
    "spread-literals-of-compile-time-tuples-are-new-arrays",
    `
    function reads(): void {
        const rows = [{ name: "a", n: 1 }, { name: "b", n: 2 }];
        const more = [...rows, { name: "c", n: 3 }];
        if (more.length !== 3 || more[2]!.n !== 3 || more[0]!.name !== "a" || !more.some((row) => row.name === "c")) throw new Error("reads");
    }
    function mutation(): void {
        const lanes = [1, 2];
        const grown = [...lanes, 3];
        grown.push(4);
        grown[0] = 9;
        if (lanes.length !== 2 || lanes[0] !== 1 || grown.join(",") !== "9,2,3,4") throw new Error("mutation after the spread");
    }
    function aliasing(): void {
        const lanes = [1, 2];
        const grown = [...lanes, 3];
        const alias = grown;
        alias.push(5);
        alias[1] = 8;
        if (grown.length !== 4 || grown[1] !== 8 || alias !== grown || lanes[1] !== 2) throw new Error("aliasing");
    }
    function identity(): void {
        const lanes = [1, 2];
        const copy = [...lanes];
        const again = [...lanes];
        if (copy === lanes || copy === again || copy.length !== again.length) throw new Error("identity");
    }
    function escape(): void {
        const lanes = [1, 2];
        const lists: number[][] = [];
        const copy = [...lanes];
        lists.push(copy);
        lists[0]![0] = 7;
        const holder: { items: number[] } = { items: [...lanes, ...copy] };
        holder.items.push(6);
        if (copy[0] !== 7 || lists[0] !== copy || holder.items.join(",") !== "1,2,7,2,6" || lanes[0] !== 1) throw new Error("escape into storage");
    }
    function records(): void {
        const rows = [{ name: "a", n: 1 }, { name: "b", n: 2 }];
        const more = [...rows, { name: "c", n: 3 }];
        more[0]!.n = 5;
        more.push({ name: "d", n: 4 });
        if (more[0] !== rows[0] || rows[0]!.n !== 5 || rows.length !== 2 || more.length !== 4) throw new Error("record elements");
    }
    function elementWrite(): void {
        const rows = [{ name: "a", n: 1 }, { name: "b", n: 2 }];
        const copy = [...rows];
        copy[1]!.n = 6;
        if (rows[1]!.n !== 6 || copy[1] !== rows[1]) throw new Error("element write");
    }
    reads();
    mutation();
    aliasing();
    identity();
    escape();
    records();
    elementWrite();
`,
);

check(
    "mixed-tuple-destructuring-assignments",
    `
    const row:[string,number,boolean] = ['head',2,true];
    let head = '';
    let tail:(number|boolean)[] = [];
    [head,...tail] = row;
    if(head !== 'head' || tail[0] !== 2 || tail[1] !== true) throw new Error('assigned rest');
    tail[0] = 7;
    if(row[1] !== 2) throw new Error('rest is fresh');
    let count = 0;
    let enabled = false;
    [head,count,enabled] = row;
    if(head !== 'head' || count !== 2 || enabled !== true) throw new Error('assigned lanes');
    [head,count,enabled] = ['next',3,false];
    if(head !== 'next' || count !== 3 || enabled !== false) throw new Error('literal assignment');
    [,count] = row;
    if(count !== 2) throw new Error('omitted assignment');
    let first = 1, second = 2;
    [first,second] = [second,first];
    if(first !== 2 || second !== 1) throw new Error('numeric swap');
    function mutate():number {second=9;return 7;}
    [first,second] = [second,mutate()];
    if(first !== 1 || second !== 7) throw new Error('source values precede assignments');
    let calls = 0;
    function source():[string,number,boolean] {calls++;return row;}
    [head,...tail] = source();
    if(calls !== 1 || head !== 'head' || tail[0] !== 2) throw new Error('single source evaluation');
    const object = {value:4};
    const objects:[string,{value:number}] = ['object',object];
    let selected = {value:0};
    [head,selected] = objects;
    selected.value = 9;
    if(object.value !== 9) throw new Error('assigned object identity');
    let empty:(number|boolean)[] = [1];
    [,,,...empty] = row;
    if(empty.length !== 0) throw new Error('empty assigned rest');
    [...tail] = [];
    if(tail.length !== 0) throw new Error('empty literal rest');
`,
);

check(
    "mixed-tuple-dynamic-reads",
    `
    let pair: [string, number] = ["value", 7];
    const indices = [0, 1, 2, -1, 0.5, NaN];
    let observed = "";
    for (const index of indices) {
        const lookup = pair[index];
        const value = lookup;
        if (typeof value === "string") observed += value.toUpperCase();
        else if (typeof value === "number") observed += value + 1;
        else if (value === undefined) observed += "?";
    }
    if (observed !== "VALUE8????") throw new Error("dynamic tuple values and absence");
    let calls = 0;
    function index(): number { calls++; pair = ["new", 10]; return 1; }
    if (pair[index()] !== 7 || calls !== 1 || pair[1] !== 10) throw new Error("dynamic tuple evaluation order");
    const item = {score: 3};
    const recordPair: [string, {score:number} | null] = ["key", item];
    const recordIndices: number[] = [1, 0, 2];
    for (const offset of recordIndices) {
        const value = recordPair[offset];
        if (typeof value === "object" && value !== null) value.score++;
    }
    if (item.score !== 4) throw new Error("dynamic tuple object identity");
`,
);

check(
    "tuple-aliases-survive-binding-replacement",
    `
    let numeric: [number, number] = [1, 2];
    const oldNumeric = numeric;
    numeric = [3, 4];
    numeric[0] = 5;
    if (oldNumeric[0] !== 1 || numeric[0] !== 5) throw new Error("numeric tuple binding");
    let mixed: [string, number] = ["old", 1];
    const oldMixed = mixed;
    mixed = ["new", 2];
    mixed[1] = 3;
    if (oldMixed[0] !== "old" || oldMixed[1] !== 1 || mixed[1] !== 3) throw new Error("mixed tuple binding");
`,
);

// A tagged record union whose arms hold points of two lengths, one of them
// optional, beside arms with no point: one array stores the field.
check(
    "tagged-union-field-of-two-tuple-lengths-some-arms-lacking-it",
    `
    type Hit =
        | { kind: "link"; span: number; point: [number, number] }
        | { kind: "marker"; host: "post" | "cell"; index: number; point: [number, number, number] }
        | { kind: "wall"; run: number; point?: [number, number, number] }
        | { kind: "prop"; id: number };
    const flag = Math.random() >= 0;
    const late = { hits: (() => []) as () => readonly Hit[] };
    if (late.hits().length !== 0) throw new Error("before");
    late.hits = () => [
        { kind: "link", span: 2, point: [1, 2] },
        { kind: "marker", host: flag ? "cell" : "post", index: 4, point: [1, 2, 3] },
        { kind: "wall", run: 6 },
        { kind: "wall", run: 7, point: [8, 9, 10] },
        { kind: "prop", id: 5 },
    ];
    let sum = 0;
    let text = "";
    for (const hit of late.hits()) {
        if (hit.kind === "link") sum += hit.point[1] + hit.span + hit.point.length;
        else if (hit.kind === "marker") { sum += hit.point[2] + hit.index + hit.point.length; text += hit.host; }
        else if (hit.kind === "wall") sum += hit.run + (hit.point ? hit.point[2] : 100);
        else sum += hit.id;
    }
    if (sum !== 144 || text !== "cell") throw new Error("sum " + sum + text);
`,
);

check(
    "mixed-tuple-storage",
    `
    interface Item { score: number; }
    const item: Item = {score: 3};
    const pairs: [string, Item][] = [["b", item], ["a", {score: 5}]];
    const alias = pairs[0]!;
    alias[0] = "c";
    alias[1].score += 4;
    if (pairs[0]![0] !== "c" || item.score !== 7) throw new Error("tuple aliases");
    const [key, value] = alias;
    if (key !== "c" || value !== item || alias.length !== 2) throw new Error("destructure");
    const byKey = new Map<string, Item>(pairs);
    const entries = [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.map(([k, v]) => k + v.score).join(",") !== "a5,c7") throw new Error("ordered entries");
    entries[0]![0] = "other";
    entries[0]![1].score = 9;
    if (byKey.has("other") || byKey.get("a")!.score !== 9) throw new Error("fresh entry pair");
    const object = Object.fromEntries(pairs);
    if (object["c"] !== item) throw new Error("fromEntries identity");
    let total = 0;
    for (const [, entry] of pairs) total += entry.score;
    if (total !== 16) throw new Error("iteration");
    const seen = new Set<[string, Item]>();
    seen.add(alias); seen.add(pairs[0]!); seen.add(["c", item]);
    if (seen.size !== 2 || !seen.has(alias)) throw new Error("tuple key identity");
    const groups = new Map<number, string[]>();
    groups.set(2, ["b"]); groups.set(1, ["a", "c"]);
    const ordered = [...groups].sort(([a], [b]) => a - b).map(([, names]) => [...names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    if (ordered.map(names => names.join("+")).join(";") !== "a+c;b") throw new Error("nested entry arrays");
    const weights = new Map<string, number>();
    weights.set("a", 2); weights.set("b", 1);
    const sortedKeys: string[] = ["a", "b"];
    if (sortedKeys.sort((a, b) => weights.get(a)! - weights.get(b)!).join("") !== "ba") throw new Error("asserted Map result");
`,
);

checkInRealm(
    "a-local-array-handed-where-its-lanes-may-be-absent-stays-one-array",
    `
    interface Vine {
        rebuild: (runs: readonly (readonly number[])[], heights?: readonly (number | undefined)[]) => void;
        total(): number;
    }
    function createVine(): Vine {
        let kept: readonly (number | undefined)[] = [];
        return {
            rebuild: (runs, heights) => {
                kept = heights ?? [];
                if (runs.length !== 1) throw new Error("runs");
            },
            total: () => kept.reduce((sum: number, height) => sum + (height ?? 0), 0),
        };
    }
    const vine = createVine();
    const hs: number[] = [];
    hs.push(1, 2);
    vine.rebuild([[0]], hs);
    // The vine holds the caller's array: later writes reach it.
    hs.push(3);
    hs[0] = hs[0]! * 10;
    let sum = 0;
    for (const height of hs) sum += height;
    if (vine.total() !== 15 || sum !== 15 || hs.length !== 3) throw new Error("heights " + vine.total() + " " + sum);
    globalThis.close();
`,
);

check(
    "flat-map-tuple-alternatives",
    `
    type Tag = "a" | "b";
    const tags: Tag[] = ["a", "b"];
    function location(tag: Tag | "unused" | undefined): "north" | "south" | null { return tag === "unused" ? null : tag === "a" ? "north" : null; }
    function temperature(tag: Tag): "hot" | "cold" { return tag === "a" ? "hot" : "cold"; }
    const byName: ReadonlyMap<string, Tag> = new Map(tags.flatMap(tag => {
        const place = location(tag);
        const heat = temperature(tag);
        return [...(place === null ? [] : [[place, tag] as const]), ...(heat === "cold" ? [[heat, tag] as const] : [])];
    }));
    if (byName.size !== 2 || byName.get("north") !== "a" || byName.get("cold") !== "b") throw new Error("flattened alternatives");
    const original = new Map<Tag, number>([["a", 1], ["b", 2]]);
    const widened: Map<string, number> = new Map(original);
    widened.set("extra", 3);
    if (widened.get("b") !== 2 || original.size !== 2) throw new Error("fresh widened map");
`,
);

check(
    "nested-pattern-destructuring-a-lane-of-shared-union-storage",
    `
    interface Brick { variant: number; w: number }
    interface BrickBucket { variant: number; tint: [number, number, number] | null; bs: Brick[]; rep: Brick }
    interface Prepared { bucketEntries: [string, BrickBucket][] }
    function prepare(bricks: { brick: Brick; tint: [number, number, number] | null }[]): Prepared {
      const byBucket = new Map<string, BrickBucket>();
      for (const tb of bricks) {
        const key = \`\${tb.brick.variant}|\${tb.tint ? tb.tint.join(",") : "-"}\`;
        const arr = byBucket.get(key);
        if (arr) arr.bs.push(tb.brick); else byBucket.set(key, { variant: tb.brick.variant, tint: tb.tint, bs: [tb.brick], rep: tb.brick });
      }
      const bucketEntries = [...byBucket.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return { bucketEntries };
    }
    function build(prepared: Prepared): number {
      let total = 0;
      for (const [key, { variant, bs, rep }] of prepared.bucketEntries) total += variant * 10 + bs.length + rep.w + key.length;
      return total;
    }
    const p = prepare([{ brick: { variant: 1, w: 2 }, tint: null }, { brick: { variant: 1, w: 3 }, tint: null }, { brick: { variant: 2, w: 1 }, tint: [1, 1, 1] }]);
    if (build(p) !== 1 * 10 + 2 + 2 + 3 + 2 * 10 + 1 + 1 + 7) throw new Error("build " + build(p));
`,
);

check(
    "spreading-numbers-among-union-lanes-and-joining-them",
    `
    const profile: number[] = [1.5, 2, 3];
    function key(id: number, shape: "cone" | "dome"): string {
      return [id, shape, ...profile].join("|");
    }
    const mixed: (number | string)[] = ["a", ...profile];
    const maybe: (number | undefined)[] = [...profile, undefined];
    profile.push(4);
    const flags: (number | boolean)[] = [true, ...profile];
    if (flags.join("/") !== "true/1.5/2/3/4" || key(7, "cone") !== "7|cone|1.5|2|3|4" || mixed.length !== 4 || mixed[1] !== 1.5 || maybe.length !== 4 || maybe[3] !== undefined) throw new Error("spread " + key(7, "cone"));
`,
);

check(
    "conditional-of-tuples-selects-each-lane-as-its-own-type",
    `
    interface Edge { x: number; z: number; nx: number; nz: number }
    function aim(edges: readonly Edge[], cx: number, cz: number, m: number): number[] | null {
      let best: Edge | null = null;
      for (const e of edges) if (!best || e.x > best.x) best = e;
      if (!best) return null;
      const toAim = Math.hypot(best.x - cx, best.z - cz);
      const [ux, uz, x1, z1] = toAim > m
        ? [(best.x - cx) / toAim, (best.z - cz) / toAim, cx, cz]
        : [best.nx, best.nz, best.x - best.nx * m, best.z - best.nz * m];
      return [ux, uz, x1, z1];
    }
    const parsed = JSON.parse('[{"x":3,"z":4,"nx":1,"nz":0}]') as Edge[];
    const literal: Edge[] = [{ x: 0.5, z: 0, nx: 0, nz: 1 }];
    const a = aim(parsed, 0, 0, 1)!, b = aim(literal, 0, 0, 1)!;
    if (a.join(",") !== "0.6,0.8,0,0" || b.join(",") !== "0,1,0.5,-1") throw new Error("aim " + a.join(",") + " " + b.join(","));
`,
);

check(
    "spreading-parsed-elements-into-scalar-lanes",
    `
    interface Run { points: number[] }
    const run = (JSON.parse('{"points":[1,2,3,4,5,6]}') as Run).points;
    const head = { x: 0, z: 0 }, tail = { x: 9, z: 9 };
    const seam = [head.x, head.z, ...run.slice(2, 4), tail.x, tail.z];
    const copy = [...run];
    const names = (JSON.parse('{"n":["p","q"]}') as { n: string[] }).n;
    const labels = ["o", ...names.slice(0, 2)];
    if (labels.join("") !== "opq" || seam.join(",") !== "0,0,3,4,9,9" || copy.length !== 6 || copy[5] !== 6) throw new Error("seam " + seam.join(","));
`,
);

check(
    "record-and-tuple-members-hold-their-built-values",
    `
    let count = 0;
    const holder = { value: 1 };
    const record = { seen: count, field: holder.value, draw: Math.random() };
    count = 5;
    holder.value = 9;
    if (record.seen !== 0) throw new Error("variable member " + record.seen);
    if (record.field !== 1) throw new Error("property member " + record.field);
    if (record.draw !== record.draw) throw new Error("draw member read twice");
    function bump(): void { count += 1; }
    const later = { seen: count };
    bump();
    if (later.seen !== 5) throw new Error("member across a call " + later.seen);
    function inside(): void {
        const snapshot = { seen: count };
        count = 7;
        if (snapshot.seen !== 6) throw new Error("function record " + snapshot.seen);
    }
    inside();
    const nested = { inner: { seen: count } };
    count = 8;
    if (nested.inner.seen !== 7) throw new Error("nested member " + nested.inner.seen);
    const list = [{ seen: count }];
    count = 9;
    if (list[0]!.seen !== 8) throw new Error("array element member " + list[0]!.seen);
    const lanes = [count, Math.random()];
    count = 10;
    if (lanes[0] !== 9) throw new Error("tuple lane " + lanes[0]);
    if (lanes[1] !== lanes[1]) throw new Error("tuple draw lane read twice");
    let label = "a";
    function tag(name: string): { name: string } { return { name }; }
    const tagged = tag(label);
    label = "b";
    if (tagged.name !== "a") throw new Error("parameter member " + tagged.name);
    function readAfterWrite(options: { seen: number }): number {
        const first = options.seen;
        count = 99;
        return first + options.seen;
    }
    if (readAfterWrite({ seen: count }) !== 20) throw new Error("argument member read after the callee writes");
    let title = "first";
    const titled = { title };
    const copied = title;
    title = "second";
    if (copied !== "first" || titled.title !== "first")
        throw new Error("a record read does not make its source constant " + copied);
`,
);

check(
    "number-array-asserted-as-tuple",
    `
    type Vec3 = [number, number, number];
    const BASE = [200, 100, 50] as const;
    function scale(factor: number): [number, number, number] | null {
        if (factor <= 0) return null;
        return BASE.map((channel) => channel * factor) as [number, number, number];
    }
    function parse(raw: string, fallback: Vec3): Vec3 {
        const parts = raw.split(",").map(Number);
        return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as Vec3) : fallback;
    }
    const scaled = scale(0.5);
    if (scaled === null || scaled[0] !== 100 || scaled[2] !== 25 || scale(0) !== null) throw new Error("mapped tuple");
    const parsed = parse("1,2,3", [0, 0, 0]);
    if (parsed[2] !== 3 || parse("1,2", [7, 8, 9])[0] !== 7) throw new Error("asserted tuple");
    const parts = [4, 5, 6];
    const view = parts as unknown as Vec3;
    view[1] = 50;
    if (parts[1] !== 50) throw new Error("asserted tuple keeps identity");
`,
);

check(
    "numeric-tuple-observing-methods",
    `
    type Vec3 = [number, number, number];
    function summary(v: Vec3): string {
        const doubled = v.map((value) => value * 2);
        return \`\${v.join("/")};\${v.indexOf(2)};\${v.lastIndexOf(2)};\${v.includes(3, 2)};\${v.at(-1)};\` +
            \`\${doubled.join()};\${v.filter((value) => value > 1).length};\${v.concat([9]).length};\` +
            \`\${v.toSorted((a, b) => b - a).join()};\${v.reduce((sum, value) => sum + value)};\${v.findLast((value) => value < 3)}\`;
    }
    const stored: Array<typeof summary> = [summary];
    if (stored[0]!([1, 2, 3]) !== "1/2/3;1;1;true;3;2,4,6;2;4;3,2,1;6;2") throw new Error(stored[0]!([1, 2, 3]));
    function reset(v: Vec3): Vec3 { v.fill(0, 1); return v; }
    const lanes: Vec3 = [4, 5, 6];
    if (reset(lanes) !== lanes || lanes.join() !== "4,0,0") throw new Error("tuple fill");
`,
);

check(
    "numeric-tuples-as-arrays",
    `
    type Vec3 = [number, number, number];
    function writeInto(x: number, out: number[]): void { out[0] = x; out[2] = x * 2; }
    function frameInto(x: number, outU: number[], outV: number[]): void { writeInto(x, outU); writeInto(x + 1, outV); }
    function dot(a: readonly number[], b: readonly number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
    function sum(values: ArrayLike<number>): number { let total = 0; for (let i = 0; i < values.length; i++) total += values[i]!; return total; }
    function frame(x: number, brick: { v: Vec3 }): Vec3 { const u: Vec3 = [0, 0, 0]; frameInto(x, u, brick.v as number[]); return u; }
    const stored: Array<typeof frame> = [frame];
    const brick = { v: [0, 0, 0] as Vec3 };
    const u = stored[0]!(3, brick);
    if (u.join() !== "3,0,6" || brick.v.join() !== "4,0,8") throw new Error("tuple written through an array parameter");
    const direct: Vec3 = [1, 1, 1];
    frameInto(5, direct, brick.v);
    if (direct.join() !== "5,1,10" || brick.v.join() !== "6,0,12") throw new Error("direct tuple arguments");
    if (dot(u, brick.v) !== 90 || sum(u) !== 9) throw new Error("tuple read through array views");
    function first2(out: number[]): number { out[0] = 1; return out[0] + out.length; }
    const counted: Array<typeof first2> = [first2];
    if (counted[0]!([5, 6]) !== 3 || first2([7]) !== 2) throw new Error("array literal argument");
    function normal(x: number, out: Vec3 = [0, 0, 0]): Vec3 { out[0] = x; out[1] = x + 1; return out; }
    const scratch: Vec3 = [9, 9, 9];
    const first = normal(1), second = normal(2), shared = normal(5, scratch);
    if (first === second || first.join() !== "1,2,0" || second[0] !== 2 || shared !== scratch || scratch.join() !== "5,6,9")
        throw new Error("defaulted tuple out-parameter");
    const fog: [number, number, number, number] = [1, 2, 3, 4];
    fog.fill(0, 2);
    if (fog.join() !== "1,2,0,0") throw new Error("tuple fill range");
    fog.fill(7);
    fog[3] = 1;
    fog.copyWithin(0, 3);
    if (fog.join() !== "1,7,7,1") throw new Error("tuple fill and copyWithin");
    const albedo: Vec3 = [0.5, 0.25, 1];
    const uniform = { name: "albedo", defaultValue: [...albedo] };
    albedo[0] = 2;
    if (uniform.defaultValue[0] !== 0.5 || uniform.defaultValue.length !== 3) throw new Error("spread copies tuple lanes");
    function corner(x: number, z: number): [number, number] { return [x, z]; }
    const outline: number[] = [...corner(1, 2), ...corner(3, 4), 5];
    if (outline.join() !== "1,2,3,4,5") throw new Error("tuple spreads into an array");
    function withAlpha(rgb: Vec3): [number, number, number, number] { return [...rgb, 1]; }
    if (withAlpha(albedo).join() !== "2,0.25,1,1") throw new Error("tuple spread into a wider tuple");
    function waterY(x: number, z: number): number { return x * 10 + z; }
    function sampler(ax: number, dx: number, at3: (x: number, z: number) => number): (t: number) => number {
        const at = (t: number): [number, number] => [ax + dx * t, ax - dx * t];
        return (t: number): number => at3(...at(t));
    }
    if (sampler(1, 2, waterY)(1) !== 29) throw new Error("tuple spread into a function value");
    interface Batch { shift(seq: number, dx: number, dz: number): number }
    const batch: Batch = { shift: (seq, dx, dz) => seq + dx * 10 + dz * 100 };
    const delta: readonly [number, number] = [2, 3];
    if (batch.shift(1, ...delta) !== 321) throw new Error("tuple spread into a method");
`,
);

check(
    "numeric-tuple-bindings-grown-through-array-parameters-take-array-storage",
    `
    function push(out: number[]): void { out.push(1); }
    function beyond(out: number[]): void { (out[3]) = 1; }
    function truncate(out: number[]): void { out.length = 1; }
    function pop(values: number[]): void { values.pop(); }
    function nested(out: number[]): void { out[0] = 1; pop(out); }
    function viaPush(): number { const t: [number, number, number] = [0, 0, 0]; push(t); return t.length * 10 + t[0]; }
    function viaBeyond(): number { const t: [number, number, number] = [0, 0, 0]; beyond(t); return t.length * 10 + t[0]; }
    function viaTruncate(): number { const t: [number, number, number] = [0, 0, 0]; truncate(t); return t.length * 10 + t[0]; }
    function viaNested(): number { const t: [number, number, number] = [0, 0, 0]; nested(t); return t.length * 10 + t[0]; }
    const frames: Array<() => number> = [viaPush, viaBeyond, viaTruncate, viaNested];
    const lengths = frames.map((frame) => frame());
    if (lengths.join() !== "40,40,10,21") throw new Error(lengths.join());
`,
);

check(
    "record-tuple-fields-grown-through-array-parameters",
    `
    function push(out: number[]): void { out.push(1); }
    interface Holder { lanes: [number, number, number] }
    function make(): Holder { return { lanes: [0, 0, 0] }; }
    const holder = make();
    push(holder.lanes);
    if (holder.lanes.length !== 4 || holder.lanes[3] !== 1) throw new Error("grown field");
`,
);

test("numeric tuple parameters refuse array parameters that may grow them", () => {
    for (const source of [
        `function frame(t: [number, number, number]): void { push(t); }
        const frames: Array<typeof frame> = [frame];
        const lanes: [number, number, number] = [0, 0, 0];
        frames[0]!(lanes);`,
    ])
        assert.throws(
            () =>
                compileSource(
                    `function push(out: number[]): void { out.push(1); }
                    ${source}`,
                ),
            /fixed-length tuple stored as a number array could grow through that array/,
        );
});

check(
    "tuple-stored-through-a-readonly-array-field",
    `
    interface Sight { point: ArrayLike<number>; label: string }
    function ray(x: number): [number, number, number] { return [x, x + 1, x + 2]; }
    function aim(x: number) {
        const sight = { point: ray(x), label: "aim" };
        return sight;
    }
    function total(s: Sight): number {
        let t = 0;
        for (let i = 0; i < s.point.length; i++) t += s.point[i]!;
        return t;
    }
    const seen: Sight = aim(Math.random() < 2 ? 1 : 0);
    const shots: Sight[] = [seen];
    if (total(shots[0]!) !== 6) throw new Error("total");
`,
);

check(
    "numeric-tuples-in-array-sinks",
    `
    interface Decl { name: string; defaultValue?: number | number[] }
    const cloud: [number, number, number, number] = [1, 2, 3, 4];
    const decls: Decl[] = [{ name: "cloud", defaultValue: cloud }, { name: "scale", defaultValue: 2 }];
    cloud[0] = 9;
    const value = decls[0]!.defaultValue;
    if (!Array.isArray(value) || value[0] !== 9 || value.length !== 4) throw new Error("tuple keeps identity in a union field");
    const lanes: [number, number, number] = [1, 2, 3];
    const record = { copy: [...lanes], list: [...[4, 5], ...lanes] };
    lanes[0] = 7;
    if (record.copy[0] !== 1 || record.list.join() !== "4,5,1,2,3") throw new Error("spreads copy where the record is built");
`,
);

check(
    "conditional-spread-record-tuple-callback-properties",
    `
    const gate = new Float32Array([0, 1, 2]);
    interface Output { kind: string; batchYield: number }
    interface Profile {
        name: string;
        secondary?: Output;
        indices?: number[];
        tint?: [number, number, number];
        eave?: { inset: readonly [number, number] };
        terrainY?: () => number;
        onRelease?: (speed: number) => void;
    }
    let released = 0;
    function profile(job: string, bone: number | undefined, footY: number, notify?: (value: number) => void): Profile {
        return {
            name: job,
            ...(job === "inn" ? { secondary: { kind: "keg", batchYield: Math.max(1, footY * 2) } } : {}),
            ...(bone === undefined ? {} : { indices: [bone] }),
            ...(job === "inn" ? { tint: [footY, 2, 3] as [number, number, number] } : {}),
            ...(footY > 0 ? { eave: { inset: [footY, footY] as const } } : {}),
            ...(footY > 0 ? { terrainY: () => footY } : {}),
            ...(notify ? { onRelease: (speed: number) => notify(speed * 2) } : {}),
        };
    }
    const full = profile(gate[1]! > 0 ? "inn" : "x", gate[2]!, gate[1]!, (value) => { released += value; });
    const bare = profile(gate[0]! > 0 ? "inn" : "x", undefined, gate[0]!);
    if (full.secondary?.kind !== "keg" || full.secondary.batchYield !== 2 || full.indices?.[0] !== 2 || full.tint?.[0] !== 1)
        throw new Error("present record, array and tuple properties");
    if (full.eave?.inset[1] !== 1 || full.terrainY?.() !== 1) throw new Error("present nested tuple and callback");
    full.onRelease?.(3);
    if (released !== 6) throw new Error("present callback property");
    if (bare.secondary !== undefined || bare.indices !== undefined || bare.tint !== undefined || bare.eave !== undefined ||
        bare.terrainY !== undefined || bare.onRelease !== undefined)
        throw new Error("absent properties");
    if ("secondary" in bare || !("secondary" in full) || "terrainY" in bare || !("onRelease" in full)) throw new Error("own keys");
`,
);

check(
    "optional-receivers-typed-present-and-runtime-tuple-loops",
    `
    interface Control { u: number; y?: number; }
    interface Curve { controls?: readonly { u?: unknown; y?: unknown }[]; }
    const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    function sanitize(value: unknown): Control[] {
        if (!Array.isArray(value)) return [];
        const parsed: Control[] = [];
        for (let index = 0; index < value.length; index++) {
            const raw = value[index] as { u?: unknown; y?: unknown };
            const u = finite(raw.u);
            if (u === undefined) continue;
            const y = finite(raw.y);
            parsed.push(y === undefined ? { u } : { u, y });
        }
        return parsed;
    }
    const normalize = (curve: Curve): number => sanitize(curve.controls).length;
    const curves: Curve[] = [{ controls: [{ u: 1, y: 2 }, { u: "x" }, { u: 3 }] }, {}];
    if (curves.map(normalize).join(",") !== "2,0") throw new Error("narrowed optional receiver");
    const counts = (rows: readonly { readonly id?: number }[] | undefined): Map<number, number> => {
        const out = new Map<number, number>();
        if (!Array.isArray(rows)) return out;
        for (const row of rows) if (typeof row?.id === "number") out.set(row.id, (out.get(row.id) ?? 0) + 1);
        return out;
    };
    const world: { props?: readonly { readonly id?: number }[] }[] = [{ props: [{ id: 2 }, {}, { id: 2 }] }, {}];
    if (world.map((each) => counts(each.props).get(2) ?? 0).join(",") !== "2,0") throw new Error("narrowed optional iteration");
    function endInset(width: number, heights: readonly [bottom: number, top: number] = [-0.5, 0]): number[] {
        return [-width / 2, width / 2].map((across) => {
            let inset = 0;
            for (const height of heights) inset = Math.max(inset, across * height);
            return inset;
        });
    }
    const insets: Array<typeof endInset> = [endInset];
    if (insets[0]!(4).join(",") !== "1,0" || insets[0]!(2, [2, 3]).join(",") !== "0,3") throw new Error("tuple loop");
`,
);

check(
    "record-tuple-fields-entering-number-arrays-take-array-storage",
    `
    type Vec4 = [number, number, number, number];
    type Vec3 = [number, number, number];
    interface Params { hs: number; bump: number; sunDir: Vec3; }
    function pack(p: Params): { uParams0: Vec4; uSunDir: Vec3 } {
        return { uParams0: [p.hs, p.bump, 0, 1], uSunDir: p.sunDir };
    }
    const uploaded: string[] = [];
    const kept: number[][] = [];
    function upload(name: string, value: number | number[]): void {
        if (typeof value !== "number") kept.push(value);
        uploaded.push(name + ":" + (typeof value === "number" ? value : value.join("/")));
    }
    function setParameters(params: Params, scale?: number): void {
        const packed = pack(params);
        for (const [name, value] of Object.entries(packed)) upload(name, value);
        upload("uScale", scale ?? 1);
    }
    const roots: Array<typeof setParameters> = [setParameters];
    const params: Params = { hs: 2, bump: 3, sunDir: [0, 1, 0] };
    roots[0]!(params);
    if (uploaded.join(",") !== "uParams0:2/3/0/1,uSunDir:0/1/0,uScale:1") throw new Error(uploaded.join(","));
    kept[1]!.push(7);
    if (params.sunDir.length !== 4 || kept[1] !== params.sunDir) throw new Error("one growable array");
`,
);

test("spread lanes and tuple storage refuse what no storage represents", () => {
    for (const [name, source, message] of [
        [
            "class method spread requires a fixed tuple",
            "class Placement { x = 0; set(a: number, b = 0): void { this.x = a + b; } } const numbers: number[] = [1, 2]; const placement = new Placement(); placement.set(...numbers);",
            /A spread argument of a class method expands a tuple of a fixed length/,
        ],
        [
            "stored fixed tuple parameter cannot grow through an array alias",
            "function grow(t: [number, number]): number { const a: number[] = t; a.push(1); return a.length; } const roots: Array<typeof grow> = [grow]; if (roots[0]!([1, 2]) !== 3) throw new Error('grow');",
            /A fixed-length tuple stored as a number array could grow through that array/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message, name);
});

check(
    "tuple-lanes-and-readonly-number-array-slots",
    `
    type Kind = "workshop" | "castle";
    interface Facts { run: number; }
    interface Home { id: number; workshop: Facts | null; castle: Facts | null; }
    const rows: string[] = [];
    function collect(list: readonly Home[]): void {
        for (const home of list) {
            const retained: readonly (readonly [Kind, number | null])[] = [
                ["workshop", home.workshop?.run ?? null],
                ["castle", home.castle?.run ?? null],
            ];
            for (const [kind, run] of retained) {
                if (run === null || !Number.isSafeInteger(run) || run < 0) continue;
                rows.push(kind + run);
            }
        }
    }
    collect([{ id: 1, workshop: { run: 2 }, castle: null }, { id: 2, workshop: null, castle: { run: -1 } }]);
    if (rows.join(",") !== "workshop2") throw new Error(rows.join(","));
    const ranked = [{ run: 2, settled: false }, { run: 1, settled: false }, { run: 2, settled: true }];
    ranked.sort((a, b) => a.run - b.run || Number(b.settled) - Number(a.settled));
    if (ranked.map((row) => row.run + String(row.settled)).join(",") !== "1false,2true,2false") throw new Error("Number(boolean)");
    type Vec3 = readonly [number, number, number];
    function aim(position: Vec3, lookAt: Vec3 | null = null): readonly number[] {
        let target: readonly number[];
        if (lookAt) {
            target = lookAt;
        } else {
            target = [position[0] + 1, position[1], position[2]];
        }
        return target;
    }
    const fixed: Vec3 = [9, 9, 9];
    if (aim([1, 2, 3])[0] !== 2 || aim([1, 2, 3], fixed) !== fixed || aim([1, 2, 3], fixed).length !== 3) throw new Error("readonly target");
    interface Decl { name: string; value?: number | readonly number[]; }
    function decls(cloud: readonly [number, number, number, number] = [0, 0, 0, 0]): Decl[] {
        return [{ name: "a", value: 1 }, { name: "cloud", value: cloud }];
    }
    const cloud: [number, number, number, number] = [1, 2, 3, 4];
    const made = decls(cloud);
    cloud[0] = 5;
    if ((made[1]!.value as readonly number[])[0] !== 5 || (decls()[1]!.value as readonly number[])[3] !== 0) throw new Error("readonly field");
`,
);

check(
    "document-entries-preserve-value-lanes-and-row-identity",
    `
    const owner = JSON.parse('{"2":4,"text":"t","flag":true}') as { "2": number; text: string; flag: boolean };
    let reads = 0;
    function read(): typeof owner { reads++; return owner; }
    const entries = Object.entries(read());
    if (reads !== 1 || entries.map(([key, value]) => key + "=" + value).join() !== "2=4,text=t,flag=true")
        throw new Error("ordered represented entries");
    const first = entries[0]!;
    if (first !== entries[0] || first === entries[1] || first.length !== 2) throw new Error("row identity");
    owner["2"] = 9;
    if (first[1] !== 4) throw new Error("entry snapshots primitive value");
    first[1] = "changed";
    if (entries[0]![1] !== "changed" || owner["2"] !== 9) throw new Error("row alias is independent of owner");
    const again = Object.entries(owner);
    if (again === entries || again[0] === first || again[0]![1] !== 9) throw new Error("fresh entry arrays");
    const document = JSON.parse('{"empty":null,"child":{"x":2}}') as Record<string, unknown>;
    document["unset"] = undefined;
    const rows = Object.entries(document);
    if (rows.map(([key]) => key).join() !== "empty,child,unset" || rows[0]![1] !== null || rows[2]![1] !== undefined)
        throw new Error("document tags and own undefined");
    const child = rows[1]![1] as { x: number };
    if (child !== document["child"]) throw new Error("nested member identity");
    child.x = 7;
    if ((document["child"] as { x: number }).x !== 7) throw new Error("nested member mutation");
`,
);

check(
    "tuples-stored-as-number-arrays-grow-together",
    `
    const store: number[][] = [];
    function keep(values: number[]): number { store.push(values); return values.length; }
    const lane: [number, number] = [1, 2];
    if (keep(lane) !== 2) throw new Error("length");
    store[0]!.push(3);
    if (lane.length !== 3 || store[0] !== lane || lane[2] !== 3) throw new Error("grown through a retained array");
    const direct: [number, number] = [4, 5];
    const view: number[] = direct;
    view.push(6);
    if (direct.length !== 3 || view !== direct) throw new Error("grown through a local array");
    interface Holder { values: number[] }
    const pair: [number, number] = [7, 8];
    const holder: Holder = { values: pair };
    holder.values.push(9);
    pair[0] = 70;
    if (pair.length !== 3 || holder.values[0] !== 70) throw new Error("grown through a field");
    function fresh(): [number, number] { return [1, 1]; }
    const owned: number[] = fresh();
    owned.push(2);
    if (owned.length !== 3) throw new Error("fresh tuple adopted");
    interface Placed { pos: [number, number] }
    const placed: Placed = { pos: [3, 4] };
    function total(values: number | number[]): number {
        if (typeof values === "number") return values;
        let sum = 0;
        for (const value of values) sum += value;
        return sum;
    }
    if (total(placed.pos) !== 7 || total(2) !== 2) throw new Error("a reading callee borrows a field tuple");
`,
);

check(
    "map-keys-outlive-temporary-destructured-lanes",
    `
    const entries: Array<readonly [string, number]> = [
        ["short", 1],
        ["bowling-ball-carpet-thump.mp3", 2],
        ["bowling-pin-hard-1.mp3", 3],
    ];
    const values = new Map<string, number>();
    for (const [key, value] of entries) values.set(key, value);
    if (values.size !== 3 || values.get("short") !== 1 ||
        values.get("bowling-ball-carpet-thump.mp3") !== 2 ||
        values.get("bowling-pin-hard-1.mp3") !== 3)
        throw new Error("destructured Map key lifetime");
    if (Array.from(values.keys()).join(",") !== entries.map(([key]) => key).join(","))
        throw new Error("Map key contents and order");
    let key = entries[1]![0];
    function nextValue(): number { key = "changed"; return 4; }
    values.set(key, nextValue());
    if (values.get("bowling-ball-carpet-thump.mp3") !== 4 || values.has("changed"))
        throw new Error("Map key must be read before its value");
    const keys = ["array-key-one", "array-key-two"];
    const observed = new Map<string, number>();
    function replaceKeys(): number {
        keys[0] = "replaced";
        if (keys.length === 2) keys.push("array-key-three");
        return 4;
    }
    for (const key of keys) observed.set(key, replaceKeys());
    if (Array.from(observed.keys()).join(",") !== "array-key-one,array-key-two,array-key-three" ||
        observed.get("array-key-one") !== 4)
        throw new Error("Map key must survive source array mutation");
`,
);

check(
    "heterogeneous-tuple-lanes-destructure-as-declared",
    `
    const pair: [string, (id: number) => string] = ["tower", (id) => "tower#" + id];
    const [key, keyOf] = pair;
    if (key !== "tower" || keyOf(4) !== "tower#4") throw new Error("destructured pair");
    const pairs: Array<[string, (id: number) => string, number]> = [["a", (id) => "a" + id, 1], ["b", (id) => "b" + id, 2]];
    let out = "";
    for (const [name, nameOf, weight] of pairs) out += name + nameOf(weight);
    const [first, firstOf] = pairs[1]!;
    if (out !== "aa1bb2" || first !== "b" || firstOf(3) !== "b3") throw new Error("destructured lanes");
    function apply([label, format]: [string, (value: number) => string], value: number): string { return label + "=" + format(value); }
    if (apply(["v", (value) => value.toFixed(1)], 2) !== "v=2.0") throw new Error("parameter lanes");
`,
);

check(
    "record-tuple-fields-stored-in-number-array-containers",
    `
    interface H { pos: [number, number] }
    const h: H = { pos: [1, 2] };
    const store: number[][] = [];
    store.push(h.pos);
    store[0]!.push(3);
    if (h.pos.length !== 3 || store[0] !== h.pos) throw new Error("one growable array");
`,
);

test("tuple parameters stored as growable number arrays need growable storage", () => {
    assert.throws(
        () =>
            compileSource(`const store: number[][] = [];
            function keep(lane: [number, number]): void { store.push(lane); }
            const lanes: Array<[number, number]> = [[1, 2], [3, 4]];
            for (const lane of lanes) keep(lane);`),
        /fixed-length tuple stored as a number array could grow through that array/,
    );
});

check(
    "stored-function-adapts-required-lanes-to-optional-parameters",
    `
    interface Host {
        place(x: number, height: (x: number, z: number, floor: number) => number | null): number | null;
        label(name: (id: number) => string | undefined): string;
    }
    function sampler(base: number) {
        return {
            heightAt(x: number, z: number, floor?: number): number | null {
                if (x < 0) return null;
                return (floor ?? base) + x + z;
            },
            name(id: number): string { return "#" + id; },
        };
    }
    function live(deps: Host): (x: number) => [number | null, string] {
        const samplers: ReturnType<typeof sampler>[] = [sampler(10)];
        const sampled = samplers[0]!;
        return (x) => [deps.place(x, sampled.heightAt), deps.label(sampled.name)];
    }
    const lives: Array<typeof live> = [live];
    const seen: Array<number | null> = [];
    const run = lives[0]!({
        place: (x, height) => {
            const held = height;
            seen.push(held(x, 2, 5));
            return height(x, 3, 0.5);
        },
        label: (name) => name(7) ?? "none",
    });
    const [first, label] = run(1);
    if (first !== 4.5 || seen[0] !== 8 || label !== "#7") throw new Error("adapted lanes");
    if (run(-1)[0] !== null || seen[1] !== null) throw new Error("adapted absent result");
`,
);

test("stored function adapters refuse lanes the value does not hold", () => {
    for (const [source, message] of [
        [
            `interface Deps { run(f: (value: number | undefined) => number): number }
            function make(deps: Deps): number {
                const table: Array<{ twice(value: number): number }> = [{ twice: (value) => value * 2 }];
                return deps.run(table[0]!.twice);
            }
            const makes: Array<typeof make> = [make];
            if (makes[0]!({ run: (f) => f(undefined) }) !== 0) throw new Error("x");`,
            /does not match the expected data function/,
        ],
        [
            `interface Deps { run(f: (key: string) => number): number }
            function make(deps: Deps): number {
                const table: Array<{ rank(key: "low" | "high"): number }> = [{ rank: (key) => (key === "low" ? 1 : 2) }];
                return deps.run(table[0]!.rank);
            }
            const makes: Array<typeof make> = [make];
            if (makes[0]!({ run: (f) => f("other") }) !== 2) throw new Error("x");`,
            /does not match the expected data function/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "stored-function-spread-of-an-optional-lane-tuple",
    `
    type Pose = readonly [dx: number, dy: number, dz: number, yaw?: number, pivotX?: number];
    interface Batch { shiftKey(key: number, dx: number, dy: number, dz: number, yaw?: number, pivotX?: number): void }
    function reapply(batch: Pick<Batch, "shiftKey">, seqs: readonly number[], read: (seq: number) => Pose): number {
        let applied = 0;
        for (const seq of seqs) {
            const delta = read(seq);
            batch.shiftKey(seq, ...delta);
            applied++;
        }
        return applied;
    }
    const reapplies: Array<typeof reapply> = [reapply];
    const log: string[] = [];
    const batch: Batch = {
        shiftKey: (key, dx, dy, dz, yaw = 0, pivotX?: number) => {
            log.push(key + ":" + (dx + dy + dz) + ":" + yaw + ":" + (pivotX === undefined ? "none" : pivotX));
        },
    };
    const count = reapplies[0]!(batch, [1, 2], (seq) => (seq === 1 ? [1, 2, 3] : [4, 5, 6, 0.5, 7]));
    if (count !== 2 || log.join(",") !== "1:6:0:none,2:15:0.5:7") throw new Error("tuple lanes " + log.join(","));
`,
);

check(
    "destructured-tuples-stored-as-number-arrays",
    `
    // A tuple a parameter pattern reads from a record, stored where a
    // union's layout keeps a number array, is the record's own array: its
    // property takes growable storage, as for a member read of it.
    type Hit = { kind: "bridge"; span: number; point: [number, number] } | { kind: "tower"; index: number; point: [number, number, number] };
    interface MeshHit { id: number; point: [number, number, number] }
    const resolvers: ((hit: MeshHit) => Hit | null)[] = [];
    resolvers.push(({ id, point }) => id > 0 ? { kind: "tower", index: id, point } : null);
    resolvers.push(({ id, point: [x, y] }) => id === 0 ? { kind: "bridge", span: x + y, point: [x, y] } : null);
    const hits: MeshHit[] = [{ id: 1, point: [1, 2, 3] }, { id: 0, point: [4, 5, 6] }];
    const seen: string[] = [];
    for (const hit of hits) for (const resolve of resolvers) {
        const found = resolve(hit);
        if (!found) { seen.push("none"); continue; }
        // A write through the stored array is read through the hit's.
        found.point[0] = 9;
        seen.push(found.kind + ":" + found.point.join(",") + ":" + hit.point.join(",") + ":" + (found.kind === "tower" && found.point === hit.point));
    }
    if (seen.join("|") !== "tower:9,2,3:9,2,3:true|none|none|bridge:9,5:4,5,6:false") throw new Error(seen.join("|"));
`,
);

check(
    "rest-parameters-of-fixed-tuples-bind-their-lanes",
    `
    type Vec3 = readonly [number, number, number];
    interface Clearance { isClear(a: Vec3, b: Vec3, sag: number, label: string): boolean; }
    function create(options: { limit: () => number }): Clearance {
        const isClear = (limit: number, ...[a, b, sag, label]: Parameters<Clearance["isClear"]>): boolean =>
            a[0] + b[0] + sag < limit && label.length > 0;
        return { isClear: (...args) => isClear(options.limit(), ...args) };
    }
    const creates: Array<typeof create> = [create];
    let limit = 10;
    const clearance = creates[0]!({ limit: () => limit });
    if (!clearance.isClear([1, 0, 0], [2, 0, 0], 3, "x")) throw new Error("tuple rest lanes");
    limit = 5;
    if (clearance.isClear([1, 0, 0], [2, 0, 0], 3, "x") || clearance.isClear([0, 0, 0], [0, 0, 0], 1, ""))
        throw new Error("tuple rest lanes read live");
`,
);

// A local array read where its lanes may be absent holds them so: every
// view is the one array, changed through either.
check(
    "a-local-array-viewed-with-absent-lanes-is-one-array",
    `
    const values: number[] = [];
    function view(): readonly (number | undefined)[] { return values; }
    const roots: Array<typeof view> = [view];
    values.push(1);
    if (roots[0]!().length !== 1 || roots[0]!()[0] !== 1 || roots[0]!() !== roots[0]!()) throw new Error("one array");
    `,
);

// Fresh tuples of different lane types select through one conditional;
// Array.isArray proves an optional readonly array present; a string read
// asserted present (`map.get(k)!`) stores as a string.
check(
    "tuple-arms-guarded-arrays-and-asserted-strings",
    `
    function clear(x: number, z: number): [number, number] { return [x + 1, z]; }
    function reseat(x: number, z: number): [x: number, z: number, admitted: boolean] {
        const c = clear(x, z);
        return [c[0], c[1], c[0] > 2];
    }
    function seat(x: number, z: number, restore: boolean): [number, number] {
        const [sx, sz] = restore ? reseat(x, z) : clear(x, z);
        return [sx * 2, sz];
    }
    const seats: Array<typeof seat> = [seat];
    if (seats[0]!(1, 3, true).join() !== "4,3" || seats[0]!(2, 5, false).join() !== "6,5") throw new Error("seats");
    let refunded: number[] = [];
    const ledger = { setRefunded(ids: readonly number[]): void { refunded = ids.filter((id) => id > 0); } };
    function restore(save: { mana?: number; refunded?: readonly number[] }): void {
        ledger.setRefunded(Array.isArray(save.refunded) ? save.refunded : []);
    }
    const restores: Array<typeof restore> = [restore];
    restores[0]!({ refunded: [3, -1, 4] });
    if (refunded.join() !== "3,4") throw new Error("refunded " + refunded.join());
    restores[0]!({});
    if (refunded.length !== 0) throw new Error("empty");
    function roots(pairs: readonly [string, string][]): string {
        const parent = new Map<string, string>();
        for (const [a] of pairs) parent.set(a, a);
        const find = (k: string): string => {
            let root = k;
            while (parent.get(root) !== root) root = parent.get(root)!;
            return root;
        };
        for (const [a, b] of pairs) if (find(a) !== find(b)) parent.set(find(b), find(a));
        return pairs.map(([a]) => find(a)).join();
    }
    const finders: Array<typeof roots> = [roots];
    if (finders[0]!([["a", "a"], ["b", "a"], ["c", "b"]]) !== "c,c,c") throw new Error("roots");
`,
);

// A Map iterator kept past its call is live over the map; searches compare
// optional and union lanes of plain values by value.
check(
    "live-map-iterators-and-plain-lane-searches",
    `
    interface Rec { id: number; kind: string }
    interface Store { values(): IterableIterator<Rec>; keys(): IterableIterator<number>; set(rec: Rec): void }
    function createStore(): Store {
        const records = new Map<number, Rec>();
        return { values: () => records.values(), keys: () => records.keys(), set: (rec) => { records.set(rec.id, rec); } };
    }
    const stores: Array<typeof createStore> = [createStore];
    const store = stores[0]!();
    store.set({ id: 2, kind: "a" });
    const values = store.values();
    store.set({ id: 5, kind: "b" });
    let out = "";
    for (const r of values) out += r.kind;
    for (const k of store.keys()) out += k;
    if (out !== "ab25" || [...store.keys()].join() !== "2,5") throw new Error(out);
    const props = new Map<number, number>([[1, 1], [2, 2], [3, 1]]);
    const refs = { propId: (id: number): number | "ambiguous" | null => (props.get(id) ?? 0) > 1 ? "ambiguous" : props.has(id) ? id : null };
    function resolved(ids: readonly number[]): string {
        const found = ids.map((id) => refs.propId(id));
        return (found.includes("ambiguous") ? "a" : "-") + (found.includes(null) ? "n" : "-") + (found.includes(3) ? "3" : "-") + found.indexOf(null);
    }
    const resolvers: Array<typeof resolved> = [resolved];
    if (resolvers[0]!([1, 3]) !== "--3-1" || resolvers[0]!([2, 9]) !== "an-1") throw new Error("searches");
`,
);

check(
    "an-empty-tuple-is-an-array-of-no-elements",
    `
    interface Moved { created?: readonly number[] }
    type Outcome = ({ committed: true } & Moved) | { committed: false; reason: string };
    const gate = new Float32Array([2, 0]);
    let held = { committed: true, created: [] } as const;
    if (gate[0]! > 1) held = { committed: true, created: [] } as const;
    if (held.created.length !== 0 || !Array.isArray(held.created)) throw new Error("empty");
    if (JSON.stringify(held) !== '{"committed":true,"created":[]}') throw new Error("json " + JSON.stringify(held));
    const outcomes: Outcome[] = [];
    outcomes.push(held, { committed: true, created: [gate[0]!, 3] }, { committed: false, reason: "no" });
    let total = 0;
    for (const outcome of outcomes) {
        if (!outcome.committed) { total += outcome.reason.length; continue; }
        for (const id of outcome.created ?? []) total += id;
    }
    if (total !== 7) throw new Error("total " + total);
`,
);

check(
    "a-tuple-with-a-rest-element-is-an-array-of-its-elements",
    `
    type Seat = Readonly<{ x: number; y: number }>;
    const MODEL: { readonly capacity: number; readonly seats: readonly [Seat, ...Seat[]]; readonly priority: readonly number[] } = {
        capacity: 3,
        seats: [{ x: -1, y: 0.5 }, { x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
        priority: [1, 0, 2],
    };
    const POTTER = { outputKind: "pots", capacity: MODEL.capacity, slots: MODEL.seats, priority: MODEL.priority } as const;
    const KEG = { outputKind: "keg", capacity: 2, slots: [{ x: 0, y: 0 }, { x: 0, y: 1 }], priority: [1, 0], itemDisplayScale: 0.5 } as const;
    const LAYOUTS = { potter: POTTER, keg: KEG } as const;
    const layoutOf = (kind: keyof typeof LAYOUTS) => LAYOUTS[kind];
    const kinds: (keyof typeof LAYOUTS)[] = [];
    const gate = new Float32Array([1]);
    kinds.push(gate[0]! > 0 ? "potter" : "keg", "keg");
    let total = 0;
    for (const kind of kinds) {
        const layout = layoutOf(kind);
        total += layout.capacity * 10 + layout.slots.length + layout.slots[0]!.x + layout.priority[0]!;
    }
    const nonEmpty: readonly [Seat, ...Seat[]] = MODEL.seats;
    if (total !== 56 || nonEmpty[2]!.x !== 1) throw new Error("total " + total);
`,
);

check(
    "a-generic-wrapper-forwards-its-tuple-rest-parameter-as-lanes",
    `
    const rows = new Map<string, number>();
    const gate = new Float32Array([1]);
    const measure = <Args extends unknown[], Result>(label: string, work: (...args: Args) => Result): ((...args: Args) => Result) => {
        if (gate[0]! < 0) return work;
        return (...args: Args): Result => {
            try {
                return work(...args);
            } finally {
                rows.set(label, (rows.get(label) ?? 0) + 1);
            }
        };
    };
    interface Point { x: number; y: number }
    const dig = measure("dig", (x: number, z: number): boolean => x + z > 2);
    const addWindow = measure("window", (index: number, mount: "wall" | "gable", point: Point): number => index + point.x + (mount === "wall" ? 1 : 2));
    const plant = measure("plant", (x: number, z: number, plan?: { kind: string }): string => (plan?.kind ?? "none") + (x + z));
    const total = (dig(1, 3) ? 10 : 0) + addWindow(2, "gable", { x: 3, y: 0 });
    type Brush = (ground: readonly [number, number] | null, from?: readonly [number, number]) => { accepted: boolean };
    const makeDot = (limit: number): Brush => (ground, from) => ({ accepted: !!ground && ground[0] < limit && (from === undefined || from[0] < limit) });
    const restore = measure("restore", makeDot(5));
    if (!restore([1, 2]).accepted || restore([1, 2], [9, 9]).accepted || restore(null).accepted) throw new Error("restore");
    if (plant(1, 2) !== "none3" || plant(2, 2, { kind: "oak" }) !== "oak4") throw new Error("plant");
    if (total !== 17 || rows.get("dig") !== 1 || rows.get("window") !== 1 || rows.get("plant") !== 2 || rows.get("restore") !== 3) throw new Error("total " + total);
`,
);

check(
    "a-constant-table-row-defaulted-with-its-first-row-is-a-tuple",
    `
    const TILE_TINTS: readonly (readonly [number, number, number])[] = [[1, 0.9, 0.8], [0.9, 0.85, 0.8], [0.8, 0.8, 0.75]];
    let seed = 0.4;
    const rng = (): number => { seed = (seed * 9301 + 0.49297) % 1; return seed; };
    let total = 0;
    for (let i = 0; i < 4; i++) {
        const tint = TILE_TINTS[Math.floor(rng() * TILE_TINTS.length)] ?? TILE_TINTS[0]!;
        total += tint[0] + tint[1] + tint[2];
    }
    const missed = TILE_TINTS[7] ?? TILE_TINTS[0]!;
    if (!(total > 9 && total < 11) || missed[1] !== 0.9) throw new Error("tints " + total);
`,
);

check(
    "optional-function-properties-survive-mixed-tuple-array-sources",
    `
    type Reader = (() => number) & { changed?: (notify: () => void) => () => void };
    let notifications = 0;
    let stopped = 0;
    function watched(value: number): Reader {
        return Object.assign(() => value, {
            changed: (notify: () => void) => {
                notify();
                return () => { stopped += value; };
            },
        });
    }
    function connect(rows: readonly (readonly [string | number, Reader])[]): number {
        const cleanup: Array<() => void> = [];
        let total = 0;
        rows.forEach(([, read], index) => {
            total += read();
            if (read.changed) cleanup.push(read.changed(() => { notifications += index + 1; }));
        });
        cleanup.forEach((stop) => stop());
        return total;
    }
    const plain: Array<() => number> = [() => 5, () => 11];
    const gate = new Float32Array([1, 0]);
    const present = watched(3);
    const fallback = () => 5;
    const selected = gate[0]! > 0 ? present : fallback;
    const absent = gate[1]! > 0 ? watched(9) : () => 5;
    const total = connect([["first", selected], [1, plain[0]!], ["last", watched(7)], [3, plain[1]!], ["absent", absent]]);
    if (total !== 31 || notifications !== 4 || stopped !== 10 || selected !== present)
        throw new Error("readers " + total + " " + notifications + " " + stopped);
    let produced = 0;
    const factories: Array<() => () => number> = [() => { produced++; return () => 13; }];
    if ((factories[0]!() as Reader).changed !== undefined || produced !== 1)
        throw new Error("receiver evaluated " + produced);
`,
);
