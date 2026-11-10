import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { jsonArray, jsonObject } from "./json.js";
import ts from "typescript";
import { compileSource, surveySource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    ReplayStorage,
    type StorageRequest,
} from "../src/compiler/replay-storage.js";
import {
    publishedSurvey,
    refusalClass,
    type SurveyReport,
} from "../src/compiler/survey.js";
import {
    getScene,
    registrySceneCompileOptions,
} from "../src/scene-registry.js";

// Three refusals in two functions, each followed by a statement that still
// lowers: the survey must reach all of them and continue past each.
const refusing = `
class Base { value = 1; }
let total = 0;
function first(): void {
    class Derived extends Map<string, number> { }
    total += new Derived().size + new Base().value;
    total += 1;
}
function second(): void {
    const p = new FinalizationRegistry(() => {});
    if (p) total += 2;
    total += 3;
}
function third(): void {
    total += 4;
}
first();
second();
third();
localStorage.setItem("total", String(total));
`;

const listed = (report: SurveyReport): string =>
    report.refusals
        .map((refusal) => `${refusal.site.line}: ${refusal.message}`)
        .join("\n");

test("a survey records every refusal it reaches and continues past each", () => {
    const { report, result } = surveySource(refusing, {
        fileName: resolve("survey-refusals.ts"),
    });
    assert.equal(report.complete, true);
    assert.equal(report.terminal, undefined);
    assert.ok(result, "every realm lowered to the end");
    assert.equal(report.refusals.length, 3, listed(report));
    assert.equal(report.statements.refused, 3);
    assert.ok(report.statements.attempted > report.statements.refused);
    // The class refuses where it is declared; the statement rolled back is
    // the construction that reached it.
    const inheritance = report.refusals.find((refusal) =>
        /inheritance/i.test(refusal.message),
    );
    assert.ok(inheritance, listed(report));
    assert.equal(inheritance.site.line, 5);
    assert.equal(inheritance.statement.line, 6);
    assert.equal(inheritance.statement.kind, "ExpressionStatement");
    assert.equal(inheritance.statement.function, "first");
    assert.equal(inheritance.cascade, undefined);
    const unsupported = report.refusals.find(
        (refusal) => refusal.message === "Unsupported constructor expression.",
    );
    assert.ok(unsupported, listed(report));
    assert.equal(unsupported.statement.function, "second");
    assert.equal(unsupported.statement.kind, "VariableStatement");
    assert.equal(unsupported.cascade, undefined);
    // `p` was declared by the refused statement: its later read is a cascade
    // of that refusal, not a gap of its own.
    const cascade = report.refusals.find(
        (refusal) => refusal.cascade !== undefined,
    );
    assert.ok(cascade, listed(report));
    assert.match(cascade.message, /^Unknown or unsupported variable 'p'\./);
    assert.deepEqual(cascade.cascade, unsupported.site);
    assert.equal(cascade.statement.line, 11);
    assert.equal(cascade.statement.kind, "IfStatement");
    assert.equal(cascade.class, refusalClass(cascade.message));
    // Classes group by message shape and count sites, not lowerings.
    const classes = Object.fromEntries(
        report.classes.map((entry) => [entry.class, entry]),
    );
    assert.equal(classes[unsupported.class]?.sites, 1);
    assert.equal(classes[unsupported.class]?.cascades, 0);
    assert.equal(classes[cascade.class]?.example, cascade.message);
    assert.equal(classes[cascade.class]?.cascades, 1);
    for (const refusal of report.refusals) assert.equal(refusal.occurrences, 1);
});

test("a survey reports its progress and the statement it lowers", () => {
    const lines: string[] = [];
    const { report } = surveySource(
        refusing,
        { fileName: resolve("survey-progress.ts") },
        { report: (line) => lines.push(line), intervalMs: 0 },
    );
    assert.equal(lines.length, report.statements.attempted);
    // The last line counts every refusal recorded before that statement.
    assert.match(
        lines.at(-1)!,
        /^Survey progress: attempt 1, \d+ statement lowerings, [0-3] refused; lowering .*survey-progress\.ts:\d+ \(.+\)$/,
    );
    assert.ok(
        lines.some((line) => / \(second\)$/.test(line)),
        lines.join(" | "),
    );
});

test("a survey's progress names each restart's cause, what it demands and where its demand rose", () => {
    // Rebinding a literal record to a parsed one restarts the program with
    // document storage for the record type (line 2).
    const lines: string[] = [];
    surveySource(
        `
        interface Settings { gain: number }
        function parsed(text: string): Settings { return JSON.parse(text); }
        let active: Settings = { gain: 2 };
        active = parsed('{"gain":3}');
        console.log(active.gain);
    `,
        { fileName: resolve("survey-restart.ts") },
        { report: (line) => lines.push(line), intervalMs: 0 },
    );
    assert.match(
        lines.at(-1)!,
        /^Survey progress: attempt 2, .*; last restart: NativeRecordStorageRequired: .* at .*survey-restart\.ts:2$/,
    );
    // Each restart is reported as it happens, naming the record it stores.
    assert.equal(
        lines.filter((line) =>
            /^Survey restart after attempt 1: NativeRecordStorageRequired: record \(Settings: document\) at /.test(
                line,
            ),
        ).length,
        1,
    );
});

test("a survey leaves the census it has found at each restart", () => {
    // The unsupported call refuses before the rebinding restarts the
    // program: the census at that restart already holds it.
    const partial: SurveyReport[] = [];
    const { report } = surveySource(
        `
        declare function unknownHostCall(): number;
        interface Settings { gain: number }
        function parsed(text: string): Settings { return JSON.parse(text); }
        const frame = unknownHostCall();
        let active: Settings = { gain: 2 };
        active = parsed('{"gain":3}');
        console.log(active.gain);
    `,
        { fileName: resolve("survey-partial.ts") },
        {
            report: () => {},
            intervalMs: 0,
            partial: (found) => partial.push(found),
        },
    );
    const restarts = partial.filter((found) =>
        found.terminal?.startsWith("Survey still running: restart"),
    );
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0]!.complete, false);
    assert.match(
        restarts[0]!.terminal!,
        /^Survey still running: restart after attempt 1: /,
    );
    assert.ok(report.complete && report.refusals.length > 0);
    assert.deepEqual(
        restarts[0]!.refusals.map((refusal) => refusal.site.line),
        report.refusals.map((refusal) => refusal.site.line),
    );
});

test("a survey reports each plan's demands and what ended it", () => {
    // Three record types would each restart the program once; the plan
    // after the first restart meets the other two and lowers to the end.
    // The plan also meets the refusal past them, which no attempt had
    // reached when it ran; the call whose body reads a record the plan
    // lost is left to the next attempt, not refused.
    const lines: string[] = [];
    const partial: SurveyReport[] = [];
    const { report } = surveySource(
        `
        declare function unknownHostCall(): number;
        interface A { a: number }
        interface B { b: number }
        interface C { c: number }
        function a(text: string): A { return JSON.parse(text); }
        function b(text: string): B { return JSON.parse(text); }
        function c(text: string): C { return JSON.parse(text); }
        let first: A = { a: 1 };
        first = a('{"a":2}');
        let second: B = { b: 1 };
        second = b('{"b":2}');
        let third: C = { c: 1 };
        third = c('{"c":2}');
        function sum(): number { return first.a + second.b + third.c; }
        const total = sum();
        const frame = unknownHostCall();
        console.log(total);
    `,
        { fileName: resolve("survey-plan.ts") },
        {
            report: (line) => lines.push(line),
            intervalMs: 0,
            partial: (found) => partial.push(found),
        },
    );
    assert.equal(report.complete, true);
    const plans = lines.filter((line) => line.startsWith("Survey plan"));
    assert.equal(plans.length, 1, plans.join(" | "));
    assert.match(
        plans[0]!,
        /^Survey plan after attempt 1: 2 demands added in \d+ s; ended by the end of the program; \d+ statement lowerings, \d+ left, 1 refused$/,
    );
    const planned = partial.find((found) =>
        found.terminal?.startsWith("Survey still running: plan"),
    );
    assert.equal(planned?.refusals.length, 0);
    assert.deepEqual(
        planned?.plan?.refusals.map((refusal) => refusal.site.line),
        [17],
    );
    // The attempt that lowers to the end meets it itself; its census is
    // the strict attempts' alone.
    assert.deepEqual(
        report.refusals.map((refusal) => refusal.site.line),
        [17],
    );
    assert.equal(report.plan, undefined);
});

test("a member call through a refused binding is a cascade of its declaration", () => {
    // FinalizationRegistry is deliberately outside the supported runtime.
    const create = `
        let total = 0;
        function create(name: string): { ready: number; add(value: number): void } {
            const raw = { name };
            return { ready: new FinalizationRegistry<string>(() => {}).unregister(raw) ? 1 : 0, add(value: number): void { total += value; } };
        }`;
    // A local `handle` is never bound: its member calls name it, not a gap
    // of their own.
    const { report } = surveySource(
        `${create}
        function run(): void {
            const handle = create("mode");
            handle.add(2);
            (handle!).add(3);
        }
        run();
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-member-cascade.ts") },
    );
    assert.equal(report.complete, true);
    const [declaration, ...members] = report.refusals;
    assert.ok(declaration, listed(report));
    assert.equal(declaration.statement.line, 8);
    assert.equal(declaration.cascade, undefined);
    assert.equal(members.length, 2, listed(report));
    for (const member of members) {
        assert.match(member.message, /handle!?\)?\.add/);
        assert.deepEqual(member.cascade, declaration.site);
    }
    // A module constant's member call reads its initializer, as a read of
    // it does: each use reaches the declaration's refusal again.
    const module = surveySource(
        `${create}
        const handle = create("mode");
        handle.add(2);
        (handle!).add(3);
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-member-cascade.ts") },
    ).report;
    assert.equal(module.refusals.length, 1, listed(module));
    assert.equal(module.refusals[0]!.statement.line, 7);
    assert.equal(module.refusals[0]!.occurrences, 3);
    assert.equal(module.refusals[0]!.statements, 3);
});

test("a refused value return is the calling statement's refusal", () => {
    // `pick` refuses inside its return; the survey must not hand `chosen` a
    // hole, so each declaration that calls it refuses at the one site inside
    // `pick`, and the reads reach that site again through the initializers.
    const { report } = surveySource(
        `
        function pick(name: string): number {
            const raw = { name };
            return new FinalizationRegistry<string>(() => {}).unregister(raw) ? 1 : 0;
        }
        const chosen = pick("mode");
        const other = pick("other");
        localStorage.setItem("chosen", String(chosen + 1));
        localStorage.setItem("other", String(other + 1));
    `,
        { fileName: resolve("survey-return.ts") },
    );
    assert.equal(report.complete, true);
    assert.equal(report.refusals.length, 1, listed(report));
    const [declaration] = report.refusals;
    assert.ok(declaration);
    assert.equal(declaration.statement.line, 6);
    assert.equal(declaration.statement.kind, "VariableStatement");
    assert.equal(declaration.site.line, 4);
    assert.equal(declaration.occurrences, 4);
    assert.equal(declaration.statements, 4);
    assert.equal(declaration.cascade, undefined);
    // Each calling statement also visits the successful local declaration.
    assert.deepEqual(report.statements, { attempted: 8, refused: 4 });
});

test("a record whose native initializer refused refuses where it is stored", () => {
    // The binding's storage demand was met, but its initializer refused, so
    // the store that demanded it refuses too instead of ending the survey.
    const { report } = surveySource(
        `
        // A number array stored as a wider element type is a copy the
        // program observes through the later push.
        interface Facts { id: number; values: (number | string)[] }
        const store = new Map<number, Facts>();
        export function record(id: number, values: number[]): void {
            const facts: Facts = { id, values };
            store.set(id, facts);
            values.push(4);
            if (facts.values.length !== values.length) throw new Error("alias");
        }
        const roots: Array<typeof record> = [record];
        roots[0]!(1, [1, 2]);
    `,
        { fileName: resolve("survey-refused-binding.ts") },
    );
    assert.equal(report.complete, true);
    assert.equal(report.terminal, undefined);
    assert.ok(
        report.refusals.some(
            (refusal) =>
                refusal.site.line === 8 &&
                refusal.message ===
                    "Record 'facts' has no native object: its initializer could not be stored natively.",
        ),
        listed(report),
    );
});

test("a survey names a class member's refusal by its qualified name", () => {
    // The census, refusals and `--source-profile` share one function name.
    const { report } = surveySource(
        `
        let total = 0;
        class Holder {
            run(): void {
                const p = new FinalizationRegistry(() => {});
                if (p) total += 1;
            }
        }
        new Holder().run();
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-member.ts") },
    );
    const unsupported = report.refusals.find(
        (refusal) => refusal.message === "Unsupported constructor expression.",
    );
    assert.ok(unsupported, listed(report));
    assert.equal(unsupported.statement.function, "Holder.run");
});

test("refusal classes elide names, numbers and parenthesised detail", () => {
    assert.equal(
        refusalClass("Unknown or unsupported variable 'p'."),
        "Unknown or unsupported variable '…'.",
    );
    assert.equal(
        refusalClass("Expected 1 arguments, received 0."),
        "Expected N arguments, received N.",
    );
    assert.equal(
        refusalClass(
            "Static record has no property '__hook' (fields: none; getters: none; class: none).",
        ),
        "Static record has no property '…' (…).",
    );
    assert.equal(
        refusalClass("Immediate promise catch requires an inline callback."),
        "Immediate promise catch requires an inline callback.",
    );
});

test("an error outside statement lowering ends the survey as incomplete", () => {
    // Built-in environment names refuse before any statement is lowered.
    const { report, result } = surveySource(
        `localStorage.setItem("mode", import.meta.env.MODE);`,
        {
            fileName: resolve("survey-terminal.ts"),
            environment: { DEV: "true" },
        },
    );
    assert.equal(report.complete, false);
    assert.equal(result, undefined);
    assert.match(report.terminal ?? "", /built-in/);
    assert.deepEqual(report.refusals, []);
    // The frames name the raiser of a refusal that carries no source location.
    const frames = report.terminalStack ?? [];
    assert.ok(frames.length > 0 && frames.length <= 12);
    assert.ok(frames.every((frame) => frame.startsWith("at ")));
});

test("a plan's demands are withdrawn from the replay storage as it stood", () => {
    // A survey plan's demands are provisional: where the attempt replaying
    // with them refuses before it lowers a statement, the storage is put
    // back and the strict attempts go on.
    const frontend = createCompilerProgram(
        `interface Samples { values: ArrayLike<number> }
         function read(samples: Samples): number { return samples.values.length; }
         const held = read({ values: [1] });`,
        resolve("survey-withdraw.ts"),
    );
    const [record, reader, statement] = frontend.sourceFile.statements;
    assert.ok(record && ts.isInterfaceDeclaration(record));
    assert.ok(reader && ts.isFunctionDeclaration(reader));
    assert.ok(statement && ts.isVariableStatement(statement));
    const slot = record.members[0];
    const parameter = reader.parameters[0];
    const binding = statement.declarationList.declarations[0];
    assert.ok(slot && ts.isPropertySignature(slot) && parameter && binding);
    const storage = new ReplayStorage(frontend.checker);
    const before: StorageRequest[] = [
        { kind: "numeric-slot", declaration: slot, numeric: "array" },
        { kind: "enum-array", unions: ["a|b"] },
    ];
    const planned: StorageRequest[] = [
        { kind: "numeric-slot", declaration: slot, numeric: "view" },
        { kind: "parameter-object", declaration: parameter },
        { kind: "dynamic", declaration: binding, storage: undefined },
        { kind: "enum-array", unions: ["c|d"] },
        { kind: "thrown-value", valueKind: "string" },
    ];
    for (const request of before) assert.equal(storage.add(request), true);
    const withdraw = storage.snapshot();
    for (const request of planned) assert.equal(storage.add(request), true);
    for (const request of planned) assert.equal(storage.add(request), false);
    withdraw();
    // What it held before the plan stays; the plan's demands are new again.
    for (const request of before) assert.equal(storage.add(request), false);
    for (const request of planned) assert.equal(storage.add(request), true);
});

test("a survey ended outside statement lowering publishes its furthest attempt with what ended it", () => {
    const census = (
        attempted: number,
        more: Partial<SurveyReport> = {},
    ): SurveyReport => ({
        schemaVersion: 1,
        complete: false,
        statements: { attempted, refused: 0 },
        refusals: [],
        classes: [],
        ...more,
    });
    const plan = {
        statements: { attempted: 40, left: 3, refused: 0 },
        refusals: [],
    };
    const furthest = census(25, { terminal: "Survey still running", plan });
    const ended = census(0, {
        terminal: "a record layout refused",
        terminalStack: ["at setup"],
    });
    assert.deepEqual(
        publishedSurvey(ended, furthest),
        census(25, {
            plan,
            terminal: "a record layout refused",
            terminalStack: ["at setup"],
        }),
    );
    // An attempt that ran to the end, or further, is its own census.
    const complete = census(30, { complete: true });
    assert.equal(publishedSurvey(complete, furthest), complete);
    assert.equal(publishedSurvey(ended, undefined), ended);
    assert.equal(publishedSurvey(census(25), furthest).plan, undefined);
});

test("a joined record layout names the two types that disagree on an accessor", () => {
    // `Live.cx` is the getter its literal defines; a `Plain` stored as a
    // `Live` joins the two types' layouts.
    assert.throws(
        () =>
            compileSource(`
                interface Plain { cx: number; cz: number }
                interface Live { readonly cx: number; readonly cz: number }
                const flag = Math.random() >= 0;
                const live: Live = { get cx() { return flag ? 1 : 0; }, cz: 2 };
                const plains: Plain[] = [{ cx: 3, cz: 4 }];
                const all: Live[] = [live];
                all.push(plains[0]!);
                plains[0]!.cx = 9;
                let total = 0;
                for (const entry of all) total += entry.cx + entry.cz;
                if (total !== 14) throw new Error("total " + total);
            `),
        /Property 'cx' is an accessor in 'Live' but not in 'Plain', and one layout \('Plain'\) stores both\./,
    );
});

test("a site refusal decided after lowering is recorded against its statement", () => {
    // Erased element writes and static class queries are checked once the
    // realm has lowered; the survey counts each site and completes.
    const source = `
document.body.append(document.createElement("div"));
const page = document.scrollingElement as HTMLElement;
page.scrollTop = 4;
const box = document.createElement("div");
box.innerHTML = '<span class="item">a</span>';
document.body.append(box);
const none = box.querySelectorAll(".missing");
page.dataset.mark = String(none.length);
localStorage.setItem("mark", "x");
`;
    const fileName = resolve("survey-after-lowering.ts");
    const { report, result } = surveySource(source, { fileName });
    assert.equal(report.complete, true, report.terminal);
    assert.ok(result, "every realm lowered to the end");
    const erased =
        "A write through a DOM element that the retained UI does not represent cannot be erased in a program with retained UI.";
    assert.deepEqual(
        report.refusals.map((refusal) => [
            refusal.statement.line,
            refusal.statement.kind,
            refusal.message,
        ]),
        [
            [4, "ExpressionStatement", erased],
            [
                8,
                "VariableStatement",
                "Retained UI querySelectorAll('.missing') requires a complete statically-known retained subtree with at least one matching retained element and no matching innerHTML-only node.",
            ],
            [9, "ExpressionStatement", erased],
        ],
    );
    // Generation still stops at the first.
    assert.throws(
        () => compileSource(source, { fileName }),
        /:4:1: A write through a DOM element that the retained UI does not represent/,
    );
});

// The survey is a measurement of generation, never a change to it: scenes
// that generate produce the same bytes under a survey and no census entries,
// which also proves that refusals decided inside speculative probes are the
// probe's and not the survey's.
for (const id of ["scene2", "scene3", "scene240", "scene10"]) {
    test(`a survey of ${id} generates identical bytes and records nothing`, () => {
        const scene = getScene(id);
        const options = registrySceneCompileOptions(scene);
        const source = readFileSync(scene.source, "utf8");
        const expected = compileSource(source, options);
        const { report, result } = surveySource(source, options);
        assert.equal(report.complete, true);
        assert.deepEqual(report.refusals, []);
        assert.equal(report.statements.refused, 0);
        assert.ok(report.statements.attempted > 0);
        assert.ok(result);
        assert.equal(result.cpp, expected.cpp);
        assert.equal(result.cmake, expected.cmake);
        assert.deepEqual(result.manifest.features, expected.manifest.features);
    });
}

test("the CLI writes the census in place of a tree and reports completion in its status", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-survey-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, refusing);
    const census = join(directory, "out", "census.json");
    // The CLI locates the pinned library from the repository it runs in.
    const runCli = (...extra: string[]) =>
        spawnSync(
            process.execPath,
            [resolve("dist/src/cli.js"), entry, "--survey", census, ...extra],
            { encoding: "utf8" },
        );
    const complete = runCli();
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(
        complete.stdout,
        /Survey: \d+ statement lowerings, 3 refused \(3 sites, 3 classes\)/,
    );
    const report = jsonObject(JSON.parse(readFileSync(census, "utf8")));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.complete, true);
    assert.equal(jsonArray(report.refusals).length, 3);
    assert.equal(existsSync(join(directory, "out", "main.cpp")), false);
    const incomplete = runCli("--env", "DEV=true");
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /Survey incomplete:/);
    assert.equal(
        jsonObject(JSON.parse(readFileSync(census, "utf8"))).complete,
        false,
    );
});
