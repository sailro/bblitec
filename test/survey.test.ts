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
import { compileSource, surveySource } from "../src/compiler.js";
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
    assert.deepEqual(
        inheritance.rolledBackAt.map((site) => site.split(":").at(-1)),
        ["6"],
    );
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
        { progress: { report: (line) => lines.push(line), intervalMs: 0 } },
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

test("a survey pass rolls back a storage demand's statement and the next pass replays with it", () => {
    // Rebinding a literal record to a parsed one demands document storage
    // for the record type (line 2) at the assignment (line 5).
    const lines: string[] = [];
    const { report } = surveySource(
        `
        interface Settings { gain: number }
        function parsed(text: string): Settings { return JSON.parse(text); }
        let active: Settings = { gain: 2 };
        active = parsed('{"gain":3}');
        console.log(active.gain);
    `,
        { fileName: resolve("survey-restart.ts") },
        { progress: { report: (line) => lines.push(line), intervalMs: 0 } },
    );
    assert.deepEqual(
        lines.filter((line) => line.startsWith("Survey pass")),
        ["Survey pass 1: 1 demand added for the next pass"],
    );
    assert.match(lines.at(-1)!, /^Survey progress: attempt 2, /);
    // The last pass lowered every statement with the demand held.
    assert.equal(report.complete, true);
    assert.deepEqual(report.demands, []);
    assert.equal(report.statements.demanded, 0);
});

test("one survey pass meets every independent demand", () => {
    // Three record types each demand document storage: the first pass
    // meets all three at their statements, the second lowers with them.
    const lines: string[] = [];
    const source = `
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
        console.log(first.a + second.b + third.c);
    `;
    const { report } = surveySource(
        source,
        { fileName: resolve("survey-plan.ts") },
        { progress: { report: (line) => lines.push(line), intervalMs: 0 } },
    );
    assert.equal(report.complete, true);
    assert.deepEqual(
        lines.filter((line) => line.startsWith("Survey pass")),
        ["Survey pass 1: 3 demands added for the next pass"],
    );
    assert.equal(report.statements.demanded, 0);
    assert.equal(report.passes, 2);
    // A pass limit of one ends there, the three demands left in the census.
    const capped = surveySource(
        source,
        { fileName: resolve("survey-plan.ts") },
        { passLimit: 1 },
    ).report;
    assert.equal(capped.passes, 1);
    assert.equal(capped.statements.demanded, 3);
    // Each demand names the assignment it rolled back.
    assert.deepEqual(
        capped.demands
            .flatMap((demand) =>
                demand.rolledBackAt.map((site) =>
                    Number(site.split(":").at(-1)),
                ),
            )
            .sort((a, b) => a - b),
        [9, 11, 13],
    );
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
    // hole, so its declaration refuses at the one site inside `pick`. The
    // survey lowers `pick`'s body once: the later call takes empty storage
    // of its result.
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
    assert.equal(declaration.occurrences, 1);
    assert.equal(declaration.statements, 1);
    assert.equal(declaration.cascade, undefined);
    assert.deepEqual(report.statements, {
        attempted: 5,
        distinct: 5,
        rooted: 0,
        refused: 1,
        distinctRefused: 1,
        demanded: 0,
    });
});

test("a refused declaration keeps its binding, so later statements lower against it", () => {
    // The initializer refuses at its own statement; the store reads the
    // binding kept with empty storage of its type instead of cascading.
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
    assert.deepEqual(
        report.refusals.map((refusal) => [
            refusal.statement.line,
            refusal.message,
        ]),
        [
            [
                7,
                "An array stored as an array of another element type is a copy, and the program changes the elements of such arrays; JavaScript keeps one array.",
            ],
        ],
        listed(report),
    );
});

test("a survey lowers every function the program never reached as a root", () => {
    // Nothing calls `unused`, `Counter.add` or `inner`: each is lowered once
    // on its own, its parameters, `this` and captured locals holding empty
    // storage of their types, so the refusal inside each is found.
    const { report } = surveySource(
        `
        let total = 0;
        export function unused(name: string, scale: number): number {
            const sum = name.length * scale;
            total += new FinalizationRegistry<string>(() => {}).unregister({ name }) ? sum : 0;
            return sum;
        }
        export function outer(start: number): () => number {
            let count = start;
            function inner(step: number): number {
                count += step;
                total += new FinalizationRegistry<string>(() => {}).unregister({ count }) ? 1 : 0;
                return count;
            }
            return () => 0;
        }
        class Counter {
            private value = 0;
            add(step: number): void {
                this.value += step;
                total += new FinalizationRegistry<string>(() => {}).unregister(this) ? this.value : 0;
            }
        }
        export const counter = new Counter();
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-roots.ts") },
    );
    assert.equal(report.complete, true);
    assert.deepEqual(
        report.refusals.map((refusal) => [
            refusal.statement.function,
            refusal.statement.line,
            refusal.message,
        ]),
        [
            ["unused", 5, "Unsupported constructor expression."],
            ["inner", 12, "Unsupported constructor expression."],
            ["Counter.add", 21, "Unsupported constructor expression."],
        ],
        listed(report),
    );
    assert.ok(
        report.refusals.every(
            (refusal) => refusal.rootOccurrences === refusal.occurrences,
        ),
    );
    assert.equal(report.statements.demanded, 0);
    // Every statement of the program was attempted.
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
});

test("a root held by its own storage demand lowers in the same pass", () => {
    // `Counter.add` reads `this`, whose class must be shared: the pass takes
    // that demand at the root and lowers the root again with it.
    const { report } = surveySource(
        `
        let total = 0;
        class Counter {
            private value = 0;
            add(step: number): void {
                this.value += step;
                total += new FinalizationRegistry<string>(() => {}).unregister(this) ? this.value : 0;
            }
        }
        export const counter = new Counter();
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-root-demand.ts") },
        { passLimit: 1 },
    );
    assert.deepEqual(
        report.refusals.map((refusal) => refusal.statement.function),
        ["Counter.add"],
        listed(report),
    );
});

test("a generic root lowers at the type arguments a call in the program binds", () => {
    // `sum` is rooted before `unused`, which calls it: its `T` is the
    // call's element type, so the refusal inside it is found.
    const { report } = surveySource(
        `
        let total = 0;
        function sum<T extends { id: number }>(items: readonly T[]): number {
            let found = 0;
            for (const item of items) found += item.id;
            total += new FinalizationRegistry<string>(() => {}).unregister({ found }) ? 1 : 0;
            return found;
        }
        export function unused(): number {
            return sum([{ id: 1, name: "a" }]);
        }
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-generic-root.ts") },
    );
    assert.equal(report.complete, true, report.terminal);
    assert.ok(
        report.refusals.some(
            (refusal) =>
                refusal.statement.function === "sum" &&
                refusal.message === "Unsupported constructor expression.",
        ),
        listed(report),
    );
    assert.ok(
        report.refusals.every(
            (refusal) => !refusal.message.startsWith("A survey root's"),
        ),
        listed(report),
    );
});

test("a survey lowers the statements of a module the program never evaluates", (t) => {
    // The entry imports only a type from `tools.ts`, so nothing runs that
    // module: its statements lower as module roots, before the function
    // roots, so `reset` writes the `count` they declared.
    const directory = mkdtempSync(join(tmpdir(), "bblite-module-roots-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
        join(directory, "tools.ts"),
        `
        export interface Tool { name: string }
        let count = 0;
        const REGISTRY = new FinalizationRegistry<string>(() => {});
        export function reset(): void {
            count = 0;
        }
    `,
    );
    const { report } = surveySource(
        `
        import type { Tool } from "./tools.js";
        const tool: Tool = { name: "saw" };
        localStorage.setItem("tool", tool.name);
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.equal(report.complete, true, report.terminal);
    assert.deepEqual(
        report.refusals.map((refusal) => [
            refusal.statement.line,
            refusal.message,
        ]),
        [[4, "Unsupported constructor expression."]],
        listed(report),
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
});

test("a survey lowers the statements a reached function's lowering left", () => {
    // `params.has("debug")` is generation-known: the arm it leaves is a
    // statement root, its loop's break bound to the block standing for the
    // loop and its return leaving the root.
    const { report } = surveySource(
        `
        let total = 0;
        function step(params: URLSearchParams): number {
            if (params.has("debug")) {
                for (let i = 0; i < 3; i++) {
                    total += i;
                    if (total > 2) break;
                }
                return total;
            }
            total += 1;
            return total;
        }
        step(new URLSearchParams(location.search));
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-statement-roots.ts") },
    );
    assert.equal(report.complete, true);
    assert.deepEqual(report.refusals, [], listed(report));
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
});

test("a survey root leaves out a trailing parameter with a default", () => {
    // The default `{}` leaves `pointProjection` unset, so the shader source
    // the root composes is generation-known.
    const { report } = surveySource(
        `
        import { createShaderMaterial, wgsl } from "@babylonjs/lite";
        interface BatchOptions { pointProjection?: boolean }
        export function makeMaterial(opts: BatchOptions = {}): unknown {
            const projection = opts.pointProjection ? "fn project() {}" : "fn flat() {}";
            return createShaderMaterial({
                name: "batch",
                vertexSource: wgsl\`\${projection + "\\n@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }"}\`,
                attributes: ["position"],
                fragmentSource: wgsl\`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`,
            });
        }
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-root-default.ts") },
    );
    assert.deepEqual(report.refusals, [], listed(report));
});

test("an evaluated module's total constants are tried; an ambient declaration is no statement", (t) => {
    // `STRIDE` folds where it is read and `UNUSED` is never read: neither
    // statement lowers, and both run as the evaluated module's folds.
    const directory = mkdtempSync(join(tmpdir(), "bblite-total-constants-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
        join(directory, "layout.ts"),
        `
        declare const __FLAG__: boolean | undefined;
        export const STRIDE = 170;
        export const UNUSED = 42;
    `,
    );
    const { report } = surveySource(
        `
        import { STRIDE } from "./layout.js";
        localStorage.setItem("stride", String(STRIDE * 2));
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.statements, 3);
    assert.equal(report.program.attempted, report.program.statements);
});

test("an evaluated module's constant no read folds lowers as a root", (t) => {
    // `LOOK` and `NEXT` are pure but not total: no read folds `LOOK`, and
    // `NEXT` folds where it is read; the roots lower `LOOK`'s initializer.
    const directory = mkdtempSync(join(tmpdir(), "bblite-module-constants-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
        join(directory, "layout.ts"),
        `
        export const STRIDE = 170;
        export const NEXT = STRIDE + 1;
        export const LOOK = { tint: [0.9, 0.8, 0.7], brightness: 0.6 };
    `,
    );
    const { report } = surveySource(
        `
        import { NEXT } from "./layout.js";
        localStorage.setItem("next", String(NEXT * 2));
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.statements, 4);
    assert.equal(report.program.attempted, report.program.statements);
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a refused statement returning from a root's body leaves the rest of the body tried", () => {
    // The root's call refuses at `a === b`, a statement returning a value:
    // the statement root then lowers the body, whose returns go nowhere,
    // and the statements after the refused one are tried.
    const { report } = surveySource(
        `
        export const sameTuple = (a?: ArrayLike<number>, b?: ArrayLike<number>): boolean => {
            if (a === b) return true;
            if (!a || !b || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
            return true;
        };
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-refused-return.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    assert.deepEqual(
        report.refusals.map((refusal) => refusal.statement.line),
        [3],
        listed(report),
    );
});

test("a stored generic method reads the type arguments its receiver binds", () => {
    // `constrain` is generic in `T` and reads `Choice`, a parameter of
    // `Deps`: the root's `deps: Deps<Choice>` binds it to the factory's own
    // `Choice`, which the root holds at its constraint.
    const { report } = surveySource(
        `
        interface Plan { id: string; scale: number }
        interface Seat { x: number; z: number }
        interface Ground extends Seat { onDeck: boolean }
        interface Deps<Choice> {
            constrain<T extends Seat>(kind: string, choice: Choice, point: T): T | null;
            weight(choice: Choice): number;
        }
        export function createTools<Choice extends Plan = Plan>(deps: Deps<Choice>) {
            return (kind: string, choice: Choice, point: Ground): number => {
                const bounded = deps.constrain(kind, choice, point);
                const moved = deps.constrain(kind, choice, { ...point, x: point.x + 1 });
                return (bounded ? bounded.x : 0) + (moved ? moved.z : 0) + deps.weight(choice);
            };
        }
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-receiver-type-arguments.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a survey tries the bodies of accessors and constructors no lowering reaches", () => {
    // `Store` is never constructed and `makeObstacle` never called: each
    // accessor's and the constructor's statements lower as statement roots,
    // their returns included, `this` the class's instance.
    const { report } = surveySource(
        `
        export class Store {
            private capacityValue = 16;
            private revision = 0;
            constructor(initial = 8) {
                this.capacityValue = Math.max(initial, 1);
                this.revision++;
            }
            get capacity(): number { return this.capacityValue; }
            get doubled(): number {
                const twice = this.capacityValue * 2;
                return twice + this.revision;
            }
            set capacity(value: number) {
                if (value < 1) return;
                this.capacityValue = value;
            }
        }
        export const makeObstacle = (pose: { x: number; z: number }, radius: number) => ({
            get x() { return pose.x; },
            get z() { return pose.z; },
            radius,
        });
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-accessor-roots.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a root of a generic function no call binds lowers at its constraints", () => {
    // `timed` is only stored, so no call binds its `T`: the root lowers at
    // `unknown`, and `work` is a function returning a document.
    const { report } = surveySource(
        `
        const timed = <T>(label: string, work: () => T): T => {
            localStorage.setItem("label", label);
            return work();
        };
        export const runner = { timed };
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-unbound-generic.ts") },
    );
    assert.deepEqual(report.refusals, [], listed(report));
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
});

test("a root's capture with no storage of its type stays unbound", () => {
    // `track` is a generic function or nothing, which no storage holds: the
    // inner root lowers its other statements, the one reading `track`
    // cascades from it, and the reason rolls back no statement.
    const { report } = surveySource(
        `
        interface Options { track?: <T>(label: string, work: () => T) => T }
        export function outer(opts: Options): () => number {
            const track = opts.track ? <T>(label: string, work: () => T): T => opts.track!(label, work) : undefined;
            let total = 0;
            return () => {
                total += 1;
                track?.("x", () => total);
                return total;
            };
        }
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-unbound-capture.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    const [reason, read] = report.refusals;
    assert.ok(reason && read, listed(report));
    assert.equal(
        reason.message,
        "A survey root's track has no native storage of its type ('(<T>(label: string, work: () => T) => T) | undefined' > '() => T' > 'T': no call binds the type parameter here).",
    );
    assert.equal(reason.statements, 0);
    assert.equal(read.statement.line, 8);
    assert.deepEqual(read.cascade, reason.site);
});

test("a root's engine object no storage holds stands as its pinned base's handle", () => {
    // An ArcRotateCamera has no storage of its own; a Camera is a handle.
    const { report } = surveySource(
        `
        import { getCameraPosition, type ArcRotateCamera } from "@babylonjs/lite";
        export function follow(camera: ArcRotateCamera): number {
            const position = getCameraPosition(camera);
            return position.x;
        }
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-root-camera.ts") },
    );
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a root's captured nullable resource is its declaration's empty slot", () => {
    // `upload` is never used, so it is a root of its own: `patchMesh` holds
    // the empty mesh slot its null-initialized declaration binds, which
    // `patchMesh!` reads as a mesh.
    const { report } = surveySource(
        `
        import { createMeshFromData, updateMeshPositions, type EngineContext, type Mesh } from "@babylonjs/lite";
        export function createGround(engine: EngineContext): void {
            let patchMesh: Mesh | null = null;
            const positions = new Float32Array(9);
            const ensure = (): void => {
                patchMesh ??= createMeshFromData(engine, "p", positions, new Float32Array(9), new Uint32Array([0, 1, 2]));
            };
            const upload = (): void => {
                updateMeshPositions(engine, patchMesh!, positions, 0);
            };
            ensure();
        }
        localStorage.setItem("ready", "1");
    `,
        { fileName: resolve("survey-root-resource.ts") },
    );
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a root's parameter with no storage of its type stays unbound", () => {
    // `track` is a generic function or nothing: the root lowers its body as
    // statements, `scale` bound, and only the one reading `track` refuses.
    const { report } = surveySource(
        `
        let total = 0;
        export function step(track: (<T>(label: string, work: () => T) => T) | undefined, scale: number): void {
            total += scale;
            track?.("x", () => total);
            total *= 2;
        }
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-unbound-parameter.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    assert.deepEqual(
        report.refusals.map((refusal) => [
            refusal.statement.line,
            refusal.statements,
            refusal.message,
        ]),
        [
            [
                4,
                0,
                "A survey root's track has no native storage of its type ('(<T>(label: string, work: () => T) => T) | undefined' > '() => T' > 'T': no call binds the type parameter here).",
            ],
            [5, 1, "Unknown or unsupported variable 'track'."],
        ],
        listed(report),
    );
});

test("a root's string parameter holds a generation-known string a call passes", () => {
    // `makeMaterial`'s one call passes a module constant: its root composes
    // the shader from it, where an empty string parameter would refuse.
    const { report } = surveySource(
        [
            'import { createShaderMaterial, wgsl } from "@babylonjs/lite";',
            'const BASE = "fn base() {}";',
            "export function makeMaterial(prelude: string): unknown {",
            "    return createShaderMaterial({",
            '        name: "batch",',
            '        vertexSource: wgsl`${prelude + "\\n@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }"}`,',
            '        attributes: ["position"],',
            "        fragmentSource: wgsl`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,",
            "    });",
            "}",
            "export function later(): unknown { return makeMaterial(BASE); }",
            'localStorage.setItem("ready", "1");',
        ].join("\n"),
        { fileName: resolve("survey-root-static-argument.ts") },
    );
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a root binds a captured const function literal and what it captures", () => {
    // `send` is rooted: `post` holds an arrow reading `health` and `limit`,
    // which the root binds as the program's own bindings would hold them.
    const { report } = surveySource(
        `
        type Post = (message: { kind: string; payload: unknown }) => void;
        let sent = 0;
        export function createHost(limit: number): { send(kind: string): void } {
            const health = { failures: 0 };
            const post: Post = (message) => { if (health.failures > limit) return; sent += message.kind.length; };
            function send(kind: string): void {
                post({ kind, payload: null });
                sent += 1;
            }
            return { send };
        }
        localStorage.setItem("sent", String(sent));
    `,
        { fileName: resolve("survey-root-literal.ts") },
    );
    assert.equal(report.complete, true, report.terminal);
    assert.deepEqual(report.refusals, [], listed(report));
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
});

test("a root's array parameter is an array its caller owns", () => {
    // Capturing `items` in a stored closure keeps the array's identity:
    // a borrowed view could not, an owned array can.
    const { report } = surveySource(
        `
        let total = 0;
        const later: Array<() => number> = [];
        export function keep(items: readonly number[]): void {
            later.push(() => items.length);
            total += items.length;
        }
        localStorage.setItem("total", String(total + later.length));
    `,
        { fileName: resolve("survey-root-array.ts") },
    );
    assert.equal(report.complete, true, report.terminal);
    assert.ok(
        report.refusals.every(
            (refusal) => !refusal.message.startsWith("A borrowed array view"),
        ),
        listed(report),
    );
});

test("the program census lists the functions holding statements no lowering tried", (t) => {
    // A class of a module only types are imported from is no root: the
    // module never evaluates its declaration or its static block, whose
    // statements stay untried, listed by the module that holds them.
    const directory = mkdtempSync(join(tmpdir(), "bblite-untried-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
        join(directory, "box.ts"),
        `
        export let total = 0;
        export class Box {
            static seed = 1;
            static {
                total += Box.seed;
                total *= 2;
            }
        }
    `,
    );
    const { report } = surveySource(
        `
        import type { Box } from "./box.js";
        const boxes: Box[] = [];
        localStorage.setItem("boxes", String(boxes.length));
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(report.program);
    assert.deepEqual(
        report.program.untried.map((entry) => [entry.kind, entry.statements]),
        [["SourceFile", 3]],
    );
});

test("a survey lowers the statements a rolled-back compound statement holds", () => {
    // The `if` condition and the loop's iterable refuse; each body is still
    // lowered on its own, the loop variable holding empty storage, so the
    // refusal inside the loop is found too.
    const { report } = surveySource(
        `
        let total = 0;
        const registry = new FinalizationRegistry<string>(() => {});
        if (registry.unregister({})) {
            total += 1;
            total *= 2;
        }
        for (const value of registry.entries()) {
            total += value.length;
            total += new FinalizationRegistry<string>(() => {}).unregister({ value }) ? 1 : 0;
            if (total > 9) break;
        }
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-held.ts") },
    );
    assert.equal(report.complete, true);
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    assert.ok(
        report.refusals.some(
            (refusal) =>
                refusal.statement.line === 10 && refusal.rootOccurrences > 0,
        ),
        listed(report),
    );
    // The loop's own break binds the block that stands for the loop.
    assert.ok(
        report.refusals.every(
            (refusal) => refusal.message !== "A jump has no active target.",
        ),
        listed(report),
    );
});

test("a survey root's resources belong to the entry's engine, declared for roots when none is", () => {
    // No statement creates an engine: the roots hold one of their own, so
    // the mesh a root receives is associated with it.
    const { report } = surveySource(
        `
        import type { Mesh } from "@babylonjs/lite";
        let tinted = 0;
        export function tint(mesh: Mesh): void {
            const material = mesh.material;
            tinted += material ? 1 : 0;
        }
        localStorage.setItem("tinted", String(tinted));
    `,
        { fileName: resolve("survey-root-engine.ts") },
    );
    assert.equal(report.complete, true);
    assert.deepEqual(report.refusals, [], listed(report));
});

test("a PBR setter on a material no scene record stands for refuses at its call", () => {
    // A root's material is empty storage that no createPbrMaterial made:
    // the setter refuses at its call and the survey goes on past it.
    const { report } = surveySource(
        `
        import { setPbrUnlit } from "@babylonjs/lite";
        let stamped = 0;
        export function flatten(material: Parameters<typeof setPbrUnlit>[0]): void {
            setPbrUnlit(material);
            stamped += 1;
        }
        localStorage.setItem("stamped", String(stamped));
    `,
        { fileName: resolve("survey-root-pbr-setter.ts") },
    );
    assert.equal(report.complete, true, report.terminal);
    assert.deepEqual(
        report.refusals.map((refusal) => refusal.message),
        [
            "setPbrUnlit names no scene-code PBR material; only a value createPbrMaterial produced, or a mesh one was assigned to, resolves which record to stamp.",
        ],
    );
});

test("a survey root of an async function runs as its activation", () => {
    // Its awaits lower inside the activation a call would start; what the
    // survey meets is the fetch of a run-time URL, not the await.
    const { report } = surveySource(
        `
        let total = 0;
        export async function fetchLength(url: string): Promise<number> {
            const response = await fetch(url);
            const text = await response.text();
            total += text.length;
            return text.length;
        }
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-root-async.ts") },
    );
    assert.equal(report.complete, true);
    assert.ok(
        report.refusals.every(
            (refusal) =>
                refusal.message !==
                "This await needs an asynchronous realm activation.",
        ),
        listed(report),
    );
});

test("a statement root of an async function awaits as its activation does", () => {
    // `track` has no storage, so the root lowers `step`'s body as
    // statements: they run in a coroutine body, where the await suspends,
    // and only the statement reading `track` refuses.
    const { report } = surveySource(
        `
        let total = 0;
        export async function step(track: (<T>(label: string, work: () => T) => T) | undefined, scale: number): Promise<void> {
            const late = await new Promise<number>((done) => setTimeout(() => done(3), 1));
            total += late * scale;
            track?.("x", () => total);
        }
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-async-statement-root.ts") },
    );
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
    assert.deepEqual(
        report.refusals.map((refusal) => refusal.statement.line),
        [4, 6],
        listed(report),
    );
});

test("a survey root's record parameter no native layout holds is a record of its members", () => {
    // `Deps` holds a method, so no native layout stores it: the root binds
    // the record a literal of that type would be, each member empty storage.
    const { report } = surveySource(
        `
        interface Deps { count: number; label: string; notify(text: string): void }
        let total = 0;
        export function step(deps: Deps, scale: number): number {
            const next = deps.count * scale;
            total += next + deps.label.length;
            deps.notify("stepped");
            return next;
        }
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-root-record.ts") },
    );
    assert.equal(report.complete, true);
    assert.deepEqual(report.refusals, [], listed(report));
    assert.ok(report.program);
    assert.equal(report.program.attempted, report.program.statements);
});

test("a generation-time bake in a program outside the repository refuses at its site", () => {
    // A zero-argument module producer runs at generation from the checkout
    // the program lies in; outside every checkout its call refuses, and the
    // survey goes on.
    const directory = mkdtempSync(join(tmpdir(), "bblite-outside-"));
    try {
        writeFileSync(
            join(directory, "pixels.ts"),
            "export function checker(): Uint8Array { return new Uint8Array(16).fill(255); }\n",
        );
        const { report } = surveySource(
            `
            import { createEngine, createTexture2DFromPixels } from "@babylonjs/lite";
            import { checker } from "./pixels.js";
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const texture = createTexture2DFromPixels(engine, checker(), 2, 2);
            localStorage.setItem("width", String(texture ? 2 : 0));
        `,
            { fileName: join(directory, "main.ts") },
        );
        assert.equal(report.complete, true, report.terminal);
        assert.ok(
            report.refusals.some(
                (refusal) =>
                    refusal.statement.line === 6 &&
                    refusal.message ===
                        "'checker' runs at generation, which needs the program inside the bblitec repository.",
            ),
            listed(report),
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a survey leaves its census as it goes", () => {
    // Each progress line hands out the census as it stands, marked
    // incomplete; the refusal is in it before the survey ends.
    const left: SurveyReport[] = [];
    const { report } = surveySource(
        `
        let total = 0;
        total += new FinalizationRegistry<string>(() => {}).unregister({}) ? 1 : 0;
        localStorage.setItem("total", String(total));
    `,
        { fileName: resolve("survey-left.ts") },
        {
            progress: {
                report: () => {},
                intervalMs: 0,
                census: (found) => left.push(found),
            },
        },
    );
    assert.equal(report.complete, true);
    const last = left.at(-1);
    assert.ok(last);
    assert.equal(last.complete, false);
    assert.match(
        last.terminal ?? "",
        /^Survey still running: Survey progress: /,
    );
    assert.equal(last.refusals.length, report.refusals.length);
});

test("a survey ended outside statement lowering publishes its last full pass with what ended it", () => {
    const census = (
        attempted: number,
        more: Partial<SurveyReport> = {},
    ): SurveyReport => ({
        schemaVersion: 1,
        complete: false,
        statements: {
            attempted,
            distinct: attempted,
            rooted: 0,
            refused: 0,
            distinctRefused: 0,
            demanded: 0,
        },
        refusals: [],
        classes: [],
        demands: [],
        passes: 1,
        slowest: [],
        ...more,
    });
    const furthest = census(25, { terminal: "Survey still running" });
    const ended = census(0, {
        terminal: "a record layout refused",
        terminalStack: ["at setup"],
    });
    assert.deepEqual(
        publishedSurvey(ended, furthest),
        census(25, {
            terminal: "a record layout refused",
            terminalStack: ["at setup"],
        }),
    );
    // An attempt that ran to the end, or further, is its own census.
    const complete = census(30, { complete: true });
    assert.equal(publishedSurvey(complete, furthest), complete);
    assert.equal(publishedSurvey(ended, undefined), ended);
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
        /Survey: \d+ statement lowerings \(\d+ in roots\), 3 refused \(3 sites, 3 classes\)/,
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
