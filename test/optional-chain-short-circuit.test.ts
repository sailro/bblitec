/**
 * A `?.` short-circuits the whole chain to its end: calls, element reads
 * and property reads after it never run on an absent receiver, an element
 * read past the end is undefined, and a later `?.` tests that value. Each
 * program runs in Node first, so its checks hold in JavaScript, then
 * natively.
 */
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const check = `
const check = (label: string, actual: string, expected: string): void => {
    if (actual !== expected) throw new Error(label + ": " + actual);
};
`;

const programs: Record<string, string> = {
    "optional-chain-calls": `
interface Box { values: string[] }
interface Holder { box: Box }
function sliceFirst(holder: Holder | undefined): string {
    return holder?.box.values.slice()[0]?.toUpperCase() ?? "none";
}
check("slice index", sliceFirst(undefined) + "," + sliceFirst({ box: { values: [] } }) + "," + sliceFirst({ box: { values: ["a", "b"] } }), "none,none,A");

interface Counter { next(): number; label(): string }
function read(counter: Counter | undefined): number { return counter?.next() ?? -1; }
function labelOf(counter: Counter | undefined): string { return counter?.label().toUpperCase() ?? "none"; }
let calls = 0;
const counter: Counter = { next: () => ++calls, label: () => "c" };
check("optional call", String(read(undefined)) + "," + String(read(counter)) + "," + String(read(counter)) + "|" + labelOf(undefined) + labelOf(counter), "-1,1,2|noneC");

interface Item { id: number }
function items(count: number): Item[] { const out: Item[] = []; for (let i = 0; i < count; i++) out.push({ id: i + 10 }); return out; }
function firstId(count: number): number { return items(count)[0]?.id ?? -1; }
function lastId(count: number): number { const list = items(count); return list[list.length - 1]?.id ?? -1; }
check("call index", String(firstId(0)) + "," + String(firstId(2)) + "," + String(lastId(0)) + "," + String(lastId(3)), "-1,10,-1,12");

interface Named { name: string }
interface Source { list(): Named[] }
function size(source: Source | undefined): number { return source?.list()[0]?.name.length ?? -1; }
check("element after call", String(size(undefined)) + String(size({ list: () => [] })) + String(size({ list: () => [{ name: "abc" }] })), "-1-13");

function upper(list: string[]): string { return list[0]?.toUpperCase() ?? "none"; }
function trimmed(list: string[], index: number): number { return list[index]?.trim().length ?? -1; }
check("element then call", upper([]) + upper(["a"]) + String(trimmed([" ab "], 0)) + String(trimmed([], 3)), "noneA2-1");

function second(text: string | undefined): string { return text?.split(",")[1]?.trim() ?? "none"; }
check("split index", second(undefined) + "|" + second("a") + "|" + second("a, b "), "none|none|b");

interface Target { add(value: number): number; inner: { add(value: number): number } }
let order = 0;
function nextOrder(): number { return ++order; }
function apply(target: Target | undefined): number { return (target?.add(nextOrder()) ?? 0) + (target?.inner.add(nextOrder()) ?? 0); }
const target: Target = { add: (value) => value * 10, inner: { add: (value) => value * 100 } };
check("skipped arguments", String(apply(undefined)) + "," + String(order) + "," + String(apply(target)) + "," + String(order), "0,0,210,2");

interface Tool { f(): number[]; g(): Tool }
let made = 0;
function none(): Tool | undefined { made++; return undefined; }
function some(): Tool | undefined { made++; const tool: Tool = { f: () => [made * 10], g: () => tool }; return tool; }
const a = none()?.f()[0] ?? -1;
const b = none()?.g().f()[0] ?? -2;
const c = some()?.g().f()[0] ?? -3;
const d = some()?.f()[1] ?? -4;
check("receiver effects", String(a) + "," + String(b) + "," + String(c) + "," + String(d) + "," + String(made), "-1,-2,30,-4,4");

interface Runner { run(): void }
interface Runners { list(): Runner[] }
let ran = 0;
function go(runners: Runners | undefined): void { runners?.list()[0]?.run(); }
go(undefined); go({ list: () => [] }); go({ list: () => [{ run: () => { ran++; } }] });
check("statement", String(ran), "1");

class Bumper { count = 0; items: number[] = []; bump(): number[] { this.count++; return this.items; } }
function bumped(bumper: Bumper | undefined): number { return bumper?.bump().slice()[0] ?? bumper?.count ?? -1; }
const bumper = new Bumper();
const before = String(bumped(undefined)) + "," + String(bumped(bumper)) + "," + String(bumper.count);
bumper.items.push(9);
check("class methods", before + "," + String(bumped(bumper)), "-1,1,1,9");

interface Step { f(): Step | undefined; g(): Step[]; v: number }
function make(): Step { const step: Step = { f: () => step, g: () => [step], v: 3 }; return step; }
function walk(step: Step | undefined): number { return step?.f()?.f()?.g()[0]?.f()!.g()[0]!.f()?.v ?? -1; }
interface Hop { f(): Hop; v: number }
function hop(): Hop { const step: Hop = { f: () => step, v: 3 }; return step; }
function stepFrom(step: Hop | undefined): number { return step?.f().f().f().f().f().f().f().f().v ?? -1; }
check("long chains", String(walk(undefined)) + String(walk(make())) + String(stepFrom(undefined)) + String(stepFrom(hop())), "-13-13");

interface Sounds { play(): void }
let played = 0;
class Player {
    private readonly sounds: Sounds | null;
    readonly listeners: (() => void)[] = [];
    constructor(sounds: Sounds | null = null) {
        this.sounds = sounds;
        this.listeners.push(() => { this.sounds?.play(); });
    }
}
const players = [new Player({ play: () => { played++; } }), new Player()];
for (const player of players) for (const listener of player.listeners) listener();
check("nullable field", String(played), "1");
`,
    "optional-chain-operators": `
interface Node2 { child?: Node2; value: number; tags: string[] }
function pick(node: Node2 | undefined, flag: boolean): string {
    const a = node?.child?.value ?? 7;
    const b = node?.tags[0]?.length || 9;
    const c = node?.child?.tags[1] ? "yes" : "no";
    const d = flag ? node?.tags[0] ?? "x" : node?.child?.tags[0] ?? "y";
    return String(a) + ":" + String(b) + ":" + c + ":" + d;
}
const leaf: Node2 = { value: 3, tags: ["ab", "cd"] };
const root: Node2 = { value: 1, child: leaf, tags: [] };
check("nested operators", pick(undefined, true) + "," + pick(root, true) + "," + pick(root, false) + "," + pick(leaf, true), "7:9:no:x,3:9:yes:x,3:9:yes:ab,7:2:no:ab");

function orNumber(x: number | undefined): number { return x || 9; }
interface MaybeCount { n?: number }
function orChain(h: MaybeCount | undefined): number { return h?.n || 9; }
check("or fallback", String(orNumber(undefined)) + String(orNumber(0)) + String(orNumber(3)) + String(orChain(undefined)) + String(orChain({ n: 4 })), "99394");

interface Row { cells: { text: string }[] }
function show(value: string): string { return "[" + value + "]"; }
function describe(row: Row | undefined): string {
    return show(row?.cells[0]?.text ?? "-") + \`\${row?.cells[1]?.text}\` + \`\${row?.cells.length}\`;
}
check("arguments and templates", describe(undefined) + "," + describe({ cells: [] }) + "," + describe({ cells: [{ text: "a" }, { text: "b" }] }), "[-]undefinedundefined,[-]undefined0,[a]b2");

function label(text: string | undefined): string { return text === undefined ? "?" : text; }
function shown(row: Row | undefined): string { return label(row?.cells[0]?.text); }
check("absent argument", shown(undefined) + shown({ cells: [] }) + shown({ cells: [{ text: "t" }] }), "??t");

interface Group { members: { name: string }[] }
let result = "start";
function assign(group: Group | undefined): void { result = group?.members[0]?.name ?? "nobody"; }
let assigned = "";
assign(undefined); assigned += result + ",";
assign({ members: [] }); assigned += result + ",";
assign({ members: [{ name: "z" }] }); assigned += result;
check("assignment", assigned, "nobody,nobody,z");

interface Values { values(): { v: number }[] }
const stored = { total: 0 };
function store(source: Values | undefined): void { stored.total = source?.values()[0]?.v ?? 9; }
let totals = "";
store(undefined); totals += String(stored.total);
store({ values: () => [] }); totals += String(stored.total);
store({ values: () => [{ v: 4 }] }); totals += String(stored.total);
check("field assignment", totals, "994");

interface Flags { values: { flag: boolean }[] }
function conditions(box: Flags | undefined): string {
    let out = "";
    if (box?.values[0]?.flag) out += "a";
    if (!box?.values[0]) out += "b";
    const both = box?.values[0] && box.values.length > 0;
    out += both ? "c" : "d";
    return out;
}
check("conditions", conditions(undefined) + "," + conditions({ values: [] }) + "," + conditions({ values: [{ flag: true }] }) + "," + conditions({ values: [{ flag: false }] }), "bd,bd,ac,c");

interface Names { names: string[] }
function joined(holder: Names | undefined): string { return \`\${holder?.names[0]?.toUpperCase()}-\${holder?.names.length ?? 0}\`; }
check("template", joined(undefined) + "," + joined({ names: [] }) + "," + joined({ names: ["q"] }), "undefined-0,undefined-0,Q-1");

interface Point { x: number }
interface Points { items: Point[]; list(): Point[] }
function absent(holder: Points | undefined): boolean { return holder?.items[0]?.x === undefined; }
function kind(holder: Points | undefined): string { return typeof holder?.items[0]?.x; }
const empty: Points = { items: [], list: () => [] };
const one: Points = { items: [{ x: 0 }], list: () => [{ x: 5 }] };
check("comparisons", String(absent(undefined)) + String(absent(empty)) + String(absent(one)) + kind(undefined) + kind(one), "truetruefalseundefinednumber");

const fallback: Point = { x: -1 };
function pickPoint(holder: Points | undefined): Point { return holder?.list()[0] ?? fallback; }
check("record fallback", String(pickPoint(undefined).x) + "," + String(pickPoint(empty).x) + "," + String(pickPoint(one).x), "-1,-1,5");

interface Numbers { items: number[] }
function pair(holder: Numbers | undefined): number[] { return [holder?.items[0] ?? 1, holder?.items.at(-1) ?? 2]; }
const absentPair = pair(undefined);
const presentPair = pair({ items: [7, 8] });
check("array literal", String(absentPair[0]) + String(absentPair[1]) + String(presentPair[0]) + String(presentPair[1]), "1278");

interface Pair { items: { n: number }[] }
function choose(holder: Pair | undefined, flag: boolean): number { return (flag ? holder?.items[0]?.n : holder?.items[1]?.n) ?? -1; }
const pairs: Pair = { items: [{ n: 1 }, { n: 2 }] };
check("ternary branches", String(choose(undefined, true)) + String(choose(pairs, true)) + String(choose(pairs, false)) + String(choose({ items: [] }, false)), "-112-1");

interface Inner { list?: number[] }
interface Outer { inner?: Inner }
function asserted(outer: Outer | undefined): number { return outer?.inner!.list![0] ?? -1; }
check("non-null links", String(asserted(undefined)) + "," + String(asserted({ inner: { list: [] } })) + "," + String(asserted({ inner: { list: [6] } })), "-1,-1,6");

interface Labels { names: string[] }
function labelOr(holder: Labels | undefined): string { return holder?.names[0] || "x"; }
check("string or", labelOr(undefined) + labelOr({ names: [] }) + labelOr({ names: [""] }) + labelOr({ names: ["y"] }), "xxxy");
`,
    "optional-chain-collections": `
interface Entry { name: string; score: number }
interface Board { entries: Entry[] }
function best(board: Board | undefined, minimum: number): string {
    return board?.entries.filter((entry) => entry.score >= minimum).map((entry) => entry.name)[0]?.toLowerCase() ?? "none";
}
const board: Board = { entries: [{ name: "A", score: 1 }, { name: "B", score: 5 }] };
check("record methods", best(undefined, 0) + "," + best(board, 9) + "," + best(board, 3), "none,none,b");

interface Point { x: number; y: number; z: number }
const map = new Map<string, Point>([["a", { x: 1, y: 2, z: 3 }]]);
const list: Point[] = [{ x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }];
function mapX(key: string): number { return map.get(key)?.x ?? -1; }
function findY(limit: number): number { return list.find((point) => point.x > limit)?.y ?? -1; }
function last(points: Point[]): number { return points.at(-1)?.z ?? -1; }
check("map find at", String(mapX("a")) + "," + String(mapX("b")) + "," + String(findY(5)) + "," + String(findY(9)) + "," + String(last(list)) + "," + String(last([])), "1,-1,8,-1,9,-1");

interface Item { id: number; tags: string[] }
const groups = new Map<string, { items: Item[] }>([["a", { items: [{ id: 7, tags: ["x", "yz"] }] }], ["b", { items: [] }]]);
const tagged: Item[] = [{ id: 1, tags: [] }, { id: 2, tags: ["p", "qrs"] }];
function firstItem(key: string): number { return groups.get(key)?.items[0]?.id ?? -1; }
function lastTag(limit: number): number { return tagged.find((item) => item.id > limit)?.tags.at(-1)?.length ?? -1; }
check("deep collections", String(firstItem("a")) + "," + String(firstItem("b")) + "," + String(firstItem("c")) + "," + String(lastTag(1)) + "," + String(lastTag(0)) + "," + String(lastTag(5)), "7,-1,-1,3,-1,-1");

interface Path { points: { z: number }[] }
function lastZ(path: Path | undefined): number { return path?.points.at(-1)?.z ?? -1; }
check("chained at", String(lastZ(undefined)) + "," + String(lastZ({ points: [] })) + "," + String(lastZ({ points: [{ z: 1 }, { z: 2 }] })), "-1,-1,2");

function firstLength(strings: string[]): number { return strings[0]?.length ?? -1; }
const handlers: ((value: number) => number)[] = [];
function callAt(index: number): number { return handlers[index]?.(3) ?? -1; }
const lists = new Map<string, number[]>([["a", [4, 5]]]);
function listAt(key: string, index: number): number { return lists.get(key)?.[index] ?? -1; }
handlers.push((value) => value + 1);
check("element calls", String(firstLength([])) + "," + String(firstLength(["ab"])) + "," + String(callAt(0)) + "," + String(callAt(1)) + "," + String(listAt("a", 1)) + "," + String(listAt("a", 5)) + "," + String(listAt("b", 0)), "-1,2,4,-1,5,-1,-1");

interface Grid { rows: number[][] }
function cell(grid: Grid | undefined, r: number, c: number): number { return grid?.rows[r]?.[c] ?? -1; }
function direct(grid: Grid | undefined): number { return grid?.rows[0][1] ?? -2; }
const grid: Grid = { rows: [[1, 2], [3]] };
check("nested index", String(cell(grid, 0, 1)) + "," + String(cell(grid, 1, 1)) + "," + String(cell(grid, 5, 0)) + "," + String(cell(undefined, 0, 0)) + "," + String(direct(grid)) + "," + String(direct(undefined)), "2,-1,-1,-1,2,-2");

interface Link { next?: Link; items: number[] }
function deep(link: Link | undefined): number { return link?.next?.next?.items[0] ?? -1; }
function sum(link: Link | undefined): number { return (link?.items[0] ?? 0) + (link?.next?.items[1] ?? 0); }
function total(start: Link | undefined): number { let out = 0; let link = start; while (link) { out += link.next?.items[0] ?? 100; link = link.next; } return out; }
const chain: Link = { items: [1], next: { items: [2, 3], next: { items: [] } } };
check("links", String(deep(chain)) + "," + String(deep(chain.next)) + "," + String(deep(undefined)) + "," + String(sum(chain)) + "," + String(sum(undefined)) + "," + String(total(chain)), "-1,-1,-1,4,0,202");

function initial(name: string | undefined): string { return name?.[0]?.toUpperCase() ?? "?"; }
function charAt(name: string | undefined): string { return name?.charAt(0).toUpperCase() ?? "?"; }
check("strings", initial(undefined) + initial("") + initial("ab") + charAt(undefined) + charAt("") + charAt("cd"), "??A?C");

interface Tool { run?: (value: number) => number }
let evaluated = 0;
function argument(): number { evaluated++; return 5; }
function use(tool: Tool | undefined): number { return tool?.run?.(argument()) ?? -1; }
const doubler: Tool = { run: (value) => value * 2 };
check("optional callbacks", String(use(undefined)) + "," + String(use({})) + "," + String(use(doubler)) + "," + String(evaluated), "-1,-1,10,1");

interface Kind1 { kind: "a"; items: number[] }
interface Kind2 { kind: "b"; items: number[] }
function unionFirst(value: Kind1 | Kind2 | undefined): number { return value?.items[0] ?? -1; }
function copy(holder: Kind1 | undefined): number { return [...(holder?.items.slice(1) ?? [])].length; }
check("unions and spreads", String(unionFirst(undefined)) + "," + String(unionFirst({ kind: "a", items: [] })) + "," + String(unionFirst({ kind: "b", items: [4] })) + "," + String(copy(undefined)) + "," + String(copy({ kind: "a", items: [1, 2, 3] })), "-1,-1,4,0,2");

const data: unknown = JSON.parse('{"a":{"list":[{"x":1}]}}');
const parsed = data as { a?: { list: { x: number }[] } };
const emptyJson = JSON.parse("{}") as { a?: { list: { x: number }[] } };
check("json", String(parsed.a?.list[0]?.x ?? -1) + "," + String(emptyJson.a?.list[0]?.x ?? -1) + "," + String(parsed.a?.list[3]?.x ?? -2), "1,-1,-2");

function longWord(words: string[]): string { return words.find((word) => word.length > 2)?.toUpperCase() ?? "none"; }
const dictionary = new Map<string, string>([["a", "x"]]);
function entry(key: string): string { return dictionary.get(key)?.toUpperCase() ?? "none"; }
function tail(rows: string[][]): number { return rows.at(-1)?.slice(1).length ?? -1; }
check("search results", longWord(["ab"]) + longWord(["abc"]) + entry("a") + entry("b") + String(tail([])) + String(tail([["p", "q"]])), "noneABCXnone-11");
`,
};

const native = optionalNativeFixtureTools(false);

for (const [name, body] of Object.entries(programs)) {
    test(`${name}: a ?. short-circuits the whole chain, as in JavaScript`, async (t) => {
        const source = check + body;
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ESNext },
            }).outputText,
        );
        const result = compileSource(source, { fileName: `${name}.ts` });
        await t.test("native", { skip: !native }, () => {
            runGeneratedProgram(native!, name, result.cpp, {
                expectedOutput: "",
            });
        });
    });
}

test("an optional call on a method of a present receiver lowers as a call", () => {
    for (const source of [
        `const canvas = document.createElement("canvas");
document.body.appendChild(canvas);
canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    if (!canvas.hasPointerCapture?.(event.pointerId)) throw new Error("capture");
});`,
        `document.documentElement.requestFullscreen?.();`,
    ])
        compileSource(source);
});
