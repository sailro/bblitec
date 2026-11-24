import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { absenceKind } from "../src/compiler/type-facts.js";
import type { Value } from "../src/compiler/types.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("mixed primitive absence retains null and undefined through fields, loops and scalar sinks", (t) => {
    const result = compileSource(`
        interface Match {key?: string | null; weight?: number | null; enabled?: boolean | null;}
        const matches: Match[] = [{}, {}];
        if (matches[0]!.key !== undefined || matches[0]!.key === null) throw new Error("missing tag");
        const prepare: (index:number)=>string|null = index => index === 0 ? "ready" : null;
        let index = 0;
        for (const match of matches) {match.key = prepare(index++);}
        function consume(value:string): number {return value.length;}
        let length = 0;
        for (const match of matches) {
            if (match.key !== null) length += consume(match.key!);
        }
        if (length !== 5 || matches[1]!.key !== null || matches[1]!.key === undefined) throw new Error("prepared tag");
        matches[0]!.key = undefined;
        if (matches[0]!.key === null || matches[0]!.key !== undefined) throw new Error("explicit undefined");
        if (String(matches[0]!.key) !== "undefined" || String(matches[1]!.key) !== "null") throw new Error("absence text");
        matches[0]!.weight = 3;
        matches[0]!.enabled = false;
        function numberSink(value:number):number {return value * 2;}
        function booleanSink(value:boolean):boolean {return !value;}
        if (numberSink(matches[0]!.weight!) !== 6 || !booleanSink(matches[0]!.enabled!)) throw new Error("scalar sinks");
        matches[0]!.weight = null;
        matches[0]!.enabled = undefined;
        if (matches[0]!.weight !== null || matches[0]!.enabled !== undefined) throw new Error("primitive tags");
    `);
    assert(result.manifest.features.includes("data:json"));
    runChecked(t, result.cpp, "mixed-absence-check");
});

test("a map callback's record keeps a null member's absence in a declared record's document slot", (t) => {
    const result = compileSource(`
        type State = "met" | "missing";
        interface Line { key: string; state?: State | null; tone?: "problem" }
        interface Row { key: string; state: State | null; tone?: "problem" }
        let first: State | null = null;
        for (let at = 0; at < 3; at++) if (at === 4) first = "met";
        const rows: Row[] = [
            { key: "a", state: first },
            { key: "b", state: "missing", tone: "problem" },
        ];
        const lines: Line[] = rows.map((row) => ({ key: row.key, state: row.state, ...(row.tone ? { tone: row.tone } : {}) }));
        const all: Line[] = [...lines, { key: "c" }];
        if (all[0]!.state !== null || all[1]!.state !== "missing" || all[2]!.state !== undefined) throw new Error("states");
        if (all[0]!.tone !== undefined || all[1]!.tone !== "problem") throw new Error("tones");
    `);
    runChecked(t, result.cpp, "map-record-absence-check");
});

// A function returning `Spot | null | undefined` whose caller keeps its
// committed spot on `undefined` and stores `null` or a spot: the returns
// keep the two absent values apart, as JavaScript does.
const SPOT_CALLER = `
    const committed: { spot: Spot | null } = { spot: null };
    function reachable(x: number, held: boolean): Spot | null {
        pending = held;
        const result = scan(x);
        if (result === undefined) return committed.spot;
        committed.spot = result;
        return result;
    }
    const seen = [reachable(1, false), reachable(2, true), reachable(2, false)]
        .map((spot) => spot?.id ?? "null").join(",");
    if (seen !== "1,1,null") throw new Error(seen);
`;
const SPOT_PRELUDE = `
    interface Spot { id: number }
    const spots: Spot[] = [{ id: 1 }];
    let pending = false;
`;
for (const [name, callee] of [
    [
        "an arrow returning another arrow's result",
        `const project = (x: number, pick: (spot: Spot) => Spot): Spot | null | undefined => {
            if (pending) return undefined;
            const spot = spots.find((s) => s.id === x);
            return spot ? pick(spot) : null;
        };
        const scan = (x: number): Spot | null | undefined => project(x, (spot) => spot);`,
    ],
    [
        "a function declaration",
        `function scan(x: number): Spot | null | undefined {
            if (pending) return undefined;
            return spots.find((s) => s.id === x) ?? null;
        }`,
    ],
    [
        "a function reading only its parameters",
        `function find(x: number, held: boolean, from: Spot[]): Spot | null | undefined {
            if (held) return undefined;
            for (const spot of from) if (spot.id === x) return spot;
            return null;
        }
        const scan = (x: number): Spot | null | undefined => find(x, pending, spots);`,
    ],
] as const)
    test(`a call's result keeps null and undefined apart through ${name}`, (t) => {
        const source = SPOT_PRELUDE + callee + SPOT_CALLER;
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        assert.match(result.cpp, /bbl::js::Tagged<bblscene::Spot>/);
        runChecked(
            t,
            result.cpp,
            `call-result-absence-${name.replace(/\W+/g, "-")}`,
        );
    });

test("a call's result stays refused where no one function's returns hold it", () => {
    // An overload, and a function stored with several call signatures,
    // name no one return to keep the two absent values apart in.
    for (const callee of [
        `function scan(x: number): Spot | null | undefined;
        function scan(x: string): Spot | null | undefined;
        function scan(x: number | string): Spot | null | undefined {
            if (pending) return undefined;
            return spots.find((s) => s.id === Number(x)) ?? null;
        }`,
        `const scan: {
            (x: number): Spot | null | undefined;
            (x: string): Spot | null | undefined;
        } = (x: number | string): Spot | null | undefined =>
            pending ? undefined : (spots.find((s) => s.id === Number(x)) ?? null);`,
    ])
        assert.throws(
            () => compileSource(SPOT_PRELUDE + callee + SPOT_CALLER),
            /told apart only once one of them is ruled out/,
        );
});

// A function stored in an options slot whose signature admits `null` and
// `undefined` returns only `undefined`: a strict comparison of a call
// through the slot answers from the function's own storage, as
// JavaScript does.
const CROWN_LAYOUT = `
    interface Save { crown?: string; flat: boolean; bare?: boolean }
    type Part = string | number | boolean | null | undefined | readonly Part[];
    interface Options { effectiveCrown(save: Save): Part; roofIsFlat(save: Save): boolean }
    function createLayout(options: Options) {
        const extra = (save: Save): number =>
            options.effectiveCrown(save) !== undefined || options.roofIsFlat(save) ? 0 : 2;
        const label = (save: Save): string => String(options.effectiveCrown(save) ?? "roof");
        return { extra, label };
    }
    const saves: Save[] = [{ flat: false }, { crown: "crenel", flat: false }, { crown: "crenel", flat: false, bare: true }, { flat: true }];
`;
for (const [name, layout, expected] of [
    [
        "a function literal of the options record",
        `const layout = createLayout({ effectiveCrown: (s) => s.crown, roofIsFlat: (s) => s.flat });`,
        "2:roof,0:crenel,0:crenel,0:roof",
    ],
    [
        "a function another record lends",
        `interface Catalog { crownOf(s: Save): string | undefined }
        function createCatalog(): Catalog {
            return { crownOf: (s) => (s.bare && s.crown === "crenel" ? undefined : s.crown) };
        }
        const { crownOf } = createCatalog();
        const layout = createLayout({ effectiveCrown: crownOf, roofIsFlat: (s) => s.flat });`,
        "2:roof,0:crenel,2:roof,0:roof",
    ],
    [
        "a function chosen at run time",
        `let rounds = 0;
        for (let at = 0; at < 2; at++) rounds += at;
        const flatOnly = (s: Save): Part => (s.flat ? null : undefined);
        const layout = createLayout(rounds > 5
            ? { effectiveCrown: flatOnly, roofIsFlat: (s) => s.flat }
            : { effectiveCrown: (s) => s.crown, roofIsFlat: (s) => s.flat });`,
        "2:roof,0:crenel,0:crenel,0:roof",
    ],
] as const)
    test(`a call through an options slot compares with undefined exactly for ${name}`, (t) => {
        const source = `${CROWN_LAYOUT}${layout}
            const seen = saves.map((s) => layout.extra(s) + ":" + layout.label(s)).join(",");
            if (seen !== "${expected}") throw new Error(seen);`;
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        runChecked(
            t,
            compileSource(source).cpp,
            `slot-call-absence-${name.replace(/\W+/g, "-")}`,
        );
    });

/** Builds the program into `artifacts/<name>` and runs it: it throws on a wrong value. */
function runChecked(t: test.TestContext, cpp: string, name: string): void {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve(`artifacts/${name}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "program.hpp"), cpp);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        directory,
        "test/fixtures/mixed-absence-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
}

test("an optional chain is undefined where it is absent, unless its type names null alone", () => {
    // `input?.kind` over a receiver the checker calls present still tests
    // the receiver's storage: its one absence is the chain's short-circuit.
    const { checker, sourceFile } = createCompilerProgram(
        `
        interface Input { kind: "a" | "b"; label: string | null }
        declare const present: Input;
        declare const maybe: Input | null;
        export const reads = [present?.kind, maybe?.kind, present?.label, present.kind];
    `,
        "absence-kind.ts",
    );
    const reads: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isArrayLiteralExpression(node)) reads.push(...node.elements);
        else ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const slot: Value = {
        kind: "data",
        cpp: "slot",
        dataType: { kind: "optional", inner: { kind: "string" } },
    };
    assert.deepEqual(
        reads.map((read) => absenceKind(checker, slot, read)),
        ["undefined", "undefined", "null", "unconstrained"],
    );
});
