import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { compileSource, surveySource } from "../src/compiler.js";
import { SourceCoverage } from "../src/compiler/source-coverage.js";
import { AbsenceTagStorageRequired } from "../src/compiler/absence-tag-storage.js";
import {
    DynamicBindingStorageRequired,
    ParameterObjectStorageRequired,
} from "../src/compiler/dynamic-binding-storage.js";
import { GenericFunctionStorageRequired } from "../src/compiler/generic-function-storage.js";
import { NativeRecordStorageRequired } from "../src/compiler/native-record-storage.js";
import {
    ReplayStorage,
    type StorageRequest,
} from "../src/compiler/replay-storage.js";
import type { StorageDemand } from "../src/compiler/storage-demand.js";
import {
    demandOrPlan,
    StorageDemandPlanner,
    storagePlanningStatistics,
    withStorageDemandPlanning,
} from "../src/compiler/storage-demand-planner.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

const state = `
    interface State { read<T>(fn:()=>T):T; ready():boolean; }
    function make():State{return {read<T>(fn:()=>T):T{return fn();},ready:()=>true};}
    const saved:Array<()=>boolean>=[];
    saved.push(()=>state.ready());
    const state=make();
`;

test("a compile reports each attempt a replay ends", () => {
    const lines: string[] = [];
    compileSource(
        `
        interface Settings { gain: number }
        function parsed(text: string): Settings { return JSON.parse(text); }
        let active: Settings = { gain: 2 };
        active = parsed('{"gain":3}');
        console.log(active.gain);
    `,
        { compileProgress: (line) => lines.push(line) },
    );
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(
        lines[0]!,
        /^Compile attempt 1 of .+: NativeRecordStorageRequired: record \(Settings: document\) at .+:2 \(\d+ s\)$/,
    );
});

/**
 * A program compiled in one storage replay (two constructions), run
 * natively against its own assertions.
 */
async function oneReplay(
    t: TestContext,
    name: string,
    source: string,
): Promise<void> {
    const strict = measured(false, () => compileSource(source));
    assert.equal(strict.constructions, 2);
    await runSelfCheckingProgram(t, `storage-demand-planner/${name}`, source);
}

function measured<T>(enabled: boolean, run: () => T) {
    const before = storagePlanningStatistics();
    const result = withStorageDemandPlanning(enabled, run);
    const after = storagePlanningStatistics();
    return {
        result,
        constructions:
            after.strict + after.planning - before.strict - before.planning,
        planning: after.planning - before.planning,
        refused: after.refused - before.refused,
        dependent: after.dependent - before.dependent,
        writes: after.writes - before.writes,
        collected: after.collected - before.collected,
        departed: after.departed - before.departed,
    };
}

test("planning meets each generic signature where strict lowering does and preserves its output", (t) => {
    const source =
        state +
        `
        state.read(()=>3);
        state.read(()=>"text");
        state.read(()=>true);
        state.read(()=>[4,5]);
        state.read(()=>({value:6}));
        state.read(()=>({text:"word"}));
        state.read(()=>[false,true]);
    `;
    const baseline = measured(false, () => compileSource(source));
    const coverage = new SourceCoverage();
    const planned = measured(true, () =>
        coverage.run(() => compileSource(source)),
    );
    assert.deepEqual(planned.result, baseline.result);
    // Each call's signature rolls its statement back; strict lowering
    // could meet the next signature inside that call first, so each plan
    // collects one and ends at the next: no more attempts than strict.
    assert.equal(planned.collected, 6);
    assert.equal(planned.departed, 5);
    assert.equal(planned.constructions, baseline.constructions);
    assert.ok(
        coverage
            .report()
            .realms.every(
                (realm) =>
                    realm.complete &&
                    realm.sites.every((site) => site.state === "lowered"),
            ),
    );
    t.diagnostic(
        `Compiler constructions: ${baseline.constructions} baseline, ${planned.constructions} with planning.`,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "storage-demand-planner/signatures",
        planned.result.cpp,
    );
});

test("a plan that lowers every statement is the published compile", () => {
    const source = state + `state.read(()=>3);state.read(()=>"text");`;
    const baselineCoverage = new SourceCoverage();
    const plannedCoverage = new SourceCoverage();
    const baseline = measured(false, () =>
        baselineCoverage.run(() => compileSource(source)),
    );
    const planned = measured(true, () =>
        plannedCoverage.run(() => compileSource(source)),
    );
    assert.deepEqual(planned.result, baseline.result);
    assert.deepEqual(plannedCoverage.report(), baselineCoverage.report());
    // The first plan meets the second signature; the second plan meets no
    // demand and is the compile: no strict attempt lowers it again.
    assert.equal(planned.planning, 2);
    assert.equal(planned.collected, 1);
    assert.equal(planned.constructions, baseline.constructions);
});

test("discarded writes and accessor arguments stop before dependent signatures", () => {
    const sources = [
        `let chosen=false; chosen=state.read(()=>true); if(chosen)state.read(()=>[4,5]); if(!chosen)throw new Error("write lost");`,
        `const holder={chosen:false}; holder.chosen=state.read(()=>true); if(holder.chosen)state.read(()=>[4,5]); if(!holder.chosen)throw new Error("receiver write lost");`,
        `let reads=0; const owner={get callback():()=>boolean {++reads;return ()=>true;}}; state.read(owner.callback); if(reads!==1)throw new Error("getter count"); state.read(()=>[4,5]);`,
    ];
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    for (const [index, tail] of sources.entries()) {
        const source =
            state + `state.read(()=>3);state.read(()=>"text");` + tail;
        const baseline = measured(false, () => compileSource(source));
        const planned = measured(true, () => compileSource(source));
        assert.deepEqual(planned.result, baseline.result);
        // One plan stops at the lost write; each plan collects one signature.
        assert.equal(planned.writes, 1);
        assert.equal(planned.collected, 3);
        assert.equal(planned.constructions, baseline.constructions);
        runGeneratedProgram(
            tools,
            `storage-demand-planner/writes-${index}`,
            planned.result.cpp,
        );
    }
});

test("a rolled-back declaration stops planning at its dependent read", () => {
    const source =
        state +
        `
        state.read(()=>3);
        state.read(()=>"text");
        const chosen=state.read(()=>true);
        if(chosen)state.read(()=>[4,5]);
        if(!chosen)throw new Error("dependent value");
    `;
    const baseline = measured(false, () => compileSource(source));
    const planned = measured(true, () => compileSource(source));
    assert.deepEqual(planned.result, baseline.result);
    assert.equal(planned.dependent, 1);
    assert.equal(planned.constructions, baseline.constructions);
});

test("a survey runs no plan: its census and coverage do not depend on planning", () => {
    const source =
        state +
        `
        state.read(()=>3);
        state.read(()=>"text");
        state.read(()=>true);
        new FinalizationRegistry(() => {});
    `;
    const baselineCoverage = new SourceCoverage();
    const plannedCoverage = new SourceCoverage();
    const baseline = measured(false, () =>
        baselineCoverage.run(() => surveySource(source)),
    );
    const planned = measured(true, () =>
        plannedCoverage.run(() => surveySource(source)),
    );
    // Everything but the lowering times, which are measured.
    const { slowest: _plannedTimes, ...plannedReport } = planned.result.report;
    const { slowest: _baselineTimes, ...baselineReport } =
        baseline.result.report;
    assert.deepEqual(plannedReport, baselineReport);
    assert.deepEqual(plannedCoverage.report(), baselineCoverage.report());
    assert.equal(planned.planning, 0);
    assert.ok(
        planned.result.report.refusals.every(
            (refusal) => !refusal.message.includes("chosen"),
        ),
    );
});

test("planning goes on past declaration storage demands and stops at a lost write", () => {
    const properties = ["first", "second", "third", "fourth", "fifth"];
    const options = `
        interface Mask { cells: number }
        interface Options { ${properties
            .map((name) => `${name}?: Mask | null;`)
            .join(" ")} }
        const all: Options[] = [{ first: null, third: { cells: 4 }, fourth: undefined, second: undefined }, {}];
        const options = all[all.length - 2]!;
    `;
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    // Each statement declares only its own name: plans collect the remaining
    // presence and absence demands without changing strict output.
    const independent =
        options +
        properties
            .map(
                (name) =>
                    `const ${name} = options.${name} === null ? "n" : options.${name} === undefined ? "u" : "s";`,
            )
            .join("\n") +
        `if (${properties.join(" + ")} !== "nusuu") throw new Error("absence tags");`;
    const baseline = measured(false, () => compileSource(independent));
    const planned = measured(true, () => compileSource(independent));
    assert.deepEqual(planned.result, baseline.result);
    assert.equal(planned.planning, 2);
    assert.ok(planned.collected >= 3);
    assert.ok(planned.constructions < baseline.constructions);
    runGeneratedProgram(
        tools,
        "storage-demand-planner/absence-tags",
        planned.result.cpp,
    );
    // A rolled-back statement's write loses `seen`: the next statement
    // reading it ends each plan's discovery, so every plan meets one demand,
    // as many attempts as strict lowering takes.
    const counted =
        options +
        `let seen = 0;` +
        properties
            .map((name) => `if (options.${name} === null) seen += 1;`)
            .join("\n") +
        `if (seen !== 1) throw new Error("absence tags");`;
    const countedBaseline = measured(false, () => compileSource(counted));
    const countedPlanned = measured(true, () => compileSource(counted));
    assert.deepEqual(countedPlanned.result, countedBaseline.result);
    assert.equal(countedPlanned.dependent, 4);
    assert.equal(countedPlanned.collected, 4);
    assert.equal(countedPlanned.constructions, countedBaseline.constructions);
    runGeneratedProgram(
        tools,
        "storage-demand-planner/absence-tag-writes",
        countedPlanned.result.cpp,
    );
});

test("planning collects every record join one statement meets", () => {
    const source = `
        interface Spot { x: number; y: number; label: string }
        interface A { x: number }
        interface B { y: number }
        interface C { x: number; y: number }
        interface D { label: string; x: number }
        function gather(spot: Spot): number {
            const as: A[] = [spot];
            const bs: B[] = [spot];
            const cs: C[] = [spot];
            const ds: D[] = [spot];
            spot.x = 7;
            spot.y = 1;
            return as[0]!.x + bs[0]!.y + cs[0]!.x + ds[0]!.x;
        }
        const spots: Spot[] = [{ x: 1, y: 2, label: "s" }];
        const total = spots.map(gather)[0];
        if (total !== 22) throw new Error("joined records");
    `;
    const baseline = measured(false, () => compileSource(source));
    const planned = measured(true, () => compileSource(source));
    assert.deepEqual(planned.result, baseline.result);
    // Each join ends a strict attempt; a plan goes on with a copy.
    assert.equal(baseline.constructions, 5);
    assert.equal(planned.planning, 2);
    assert.equal(planned.collected, 3);
    assert.equal(planned.constructions, 3);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "storage-demand-planner/record-joins",
        planned.result.cpp,
    );
});

type PlannedContext = Parameters<StorageDemandPlanner["attemptStatement"]>[0];

/**
 * A one-file program, for driving the planner over real statements: its
 * checker, its statements, a lowering context the planner reads, and the
 * declaration of the variable statement at an index.
 */
function plannedStatements(source: string) {
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 };
    const host = ts.createCompilerHost(options, true);
    const file = ts.createSourceFile("input.ts", source, options.target!, true);
    host.getSourceFile = (path) => (path === "input.ts" ? file : undefined);
    const program = ts.createProgram(["input.ts"], options, host);
    const checker = program.getTypeChecker();
    const context = {
        checker,
        transaction: (work: () => void) => work(),
        dataTypes: { substitutesTypeParameters: () => false },
    } as unknown as PlannedContext;
    return {
        checker,
        statements: file.statements,
        context,
        declarationAt: (index: number, statements = file.statements) =>
            (statements[index] as ts.VariableStatement).declarationList
                .declarations[0]!,
    };
}

/** Lowers `statement` under `planner` as statement emission does: its activation, then its recovery. */
function attemptPlanned(
    planner: StorageDemandPlanner,
    context: PlannedContext,
    statement: ts.Statement,
    lower: () => void,
): void {
    planner.beginActivation(statement);
    planner.attemptStatement(context, statement, lower);
}

test("a plan ends at a demand whose change later statements may read", () => {
    // Each record `let` demands dynamic storage, an ownership change the
    // next statements may read: the plan ends at the first.
    const { checker, statements, context } = plannedStatements(`
        let first = { gain: 1 };
        first = { gain: 2 };
        const doubled = first.gain * 2;
        let second = { level: 1 };
        second = { level: 2 };
    `);
    const plan = () => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker);
        planner.run(() => {
            for (const statement of statements)
                attemptPlanned(planner, context, statement, () => {
                    if (
                        ts.isVariableStatement(statement) &&
                        (statement.declarationList.flags & ts.NodeFlags.Let) !==
                            0
                    )
                        throw new DynamicBindingStorageRequired(
                            statement.declarationList.declarations[0]!,
                            undefined,
                        );
                });
        });
        const after = storagePlanningStatistics();
        return {
            demands: planner.demands.map((request) =>
                request.kind === "dynamic"
                    ? request.declaration.name.getText()
                    : request.kind,
            ),
            dependent: after.dependent - before.dependent,
            writes: after.writes - before.writes,
        };
    };
    assert.deepEqual(plan(), {
        demands: ["first"],
        dependent: 0,
        writes: 1,
    });
});

test("one plan collects two independent module-const dynamic demands and stops at their read", () => {
    const { checker, statements, context, declarationAt } = plannedStatements(`
        export const KEG_PIVOT = [0.5, 0.5, 0.5] as const;
        export const BEER_PIVOT = [0.5, 0, 0.5] as const;
        const height = KEG_PIVOT[1];
    `);
    const planner = new StorageDemandPlanner(checker);
    const before = storagePlanningStatistics();
    let read = false;
    planner.run(() => {
        for (let index = 0; index < 2; index++)
            attemptPlanned(planner, context, statements[index]!, () => {
                throw new DynamicBindingStorageRequired(
                    declarationAt(index),
                    "array",
                );
            });
        attemptPlanned(planner, context, statements[2]!, () => {
            read = true;
        });
    });
    assert.deepEqual(
        planner.demands.map((request) =>
            request.kind === "dynamic"
                ? request.declaration.name.getText()
                : request.kind,
        ),
        ["KEG_PIVOT", "BEER_PIVOT"],
    );
    assert.equal(read, false);
    assert.equal(storagePlanningStatistics().dependent - before.dependent, 1);
});

test("independent literal bindings batch without changing generated storage", () => {
    const directory = join(
        process.cwd(),
        "artifacts",
        "storage-demand-planner",
        "module-bindings",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "pivots.ts"),
        `
        export const seed = { value: 0, increment() { this.value++; } };
        export const first = { value: 1, increment() { this.value++; } };
        export const second = { value: 2, increment() { this.value++; } };
        export function mutate(): void {
            seed.increment();
            first.increment();
            second.increment();
        }
        `,
    );
    const source = `
        import { seed, first, second, mutate } from "./pivots";
        async function main(): Promise<void> {
            await Promise.resolve();
            mutate();
            const held = [seed, first, second];
            if (held.indexOf(seed) !== 0 || held.indexOf(first) !== 1 || held.indexOf(second) !== 2) throw new Error("identity");
            globalThis.close();
        }
        void main();
    `;
    const compile = () =>
        compileSource(source, { fileName: join(directory, "entry.ts") });
    const baseline = measured(false, compile);
    const planned = measured(true, compile);
    assert.equal(planned.result.cpp, baseline.result.cpp);
    assert.deepEqual(planned.result.manifest, baseline.result.manifest);
    assert.ok(
        planned.constructions < baseline.constructions,
        `planned ${planned.constructions}, strict ${baseline.constructions}`,
    );
});

test("a dynamic demand for another binding or an effectful initializer ends discovery", () => {
    for (const [source, statementIndex, declarationIndex, storage] of [
        ["let value = []; value = [1]; const next = [];", 1, 0, "array"],
        ["const value = build(); const next = [];", 0, 0, "source"],
        ["const value = holder.value; const next = [];", 0, 0, "source"],
        ["const value = { ...holder }; const next = [];", 0, 0, "source"],
        ["const value = [...items]; const next = [];", 0, 0, "array"],
        ["const value = { [key]: 1 }; const next = [];", 0, 0, "source"],
    ] as const) {
        const { checker, statements, context, declarationAt } =
            plannedStatements(source);
        const planner = new StorageDemandPlanner(checker);
        let next = false;
        const before = storagePlanningStatistics();
        planner.run(() => {
            attemptPlanned(
                planner,
                context,
                statements[statementIndex]!,
                () => {
                    throw new DynamicBindingStorageRequired(
                        declarationAt(declarationIndex),
                        storage,
                    );
                },
            );
            next = true;
        });
        assert.equal(next, false, source);
        assert.equal(planner.demands.length, 1, source);
        assert.equal(storagePlanningStatistics().writes - before.writes, 1);
    }
});

test("a plan ends at a destructured generic call's signature", () => {
    // A destructured generic call's demand is not independent: the plan
    // ends there.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        function pair<T>(value: T): [T, T] { return [value, value]; }
        const [left, right] = pair(1);
        const sum = left + right;
        let other = { gain: 1 };
    `);
    const call = declarationAt(1).initializer as ts.CallExpression;
    const plan = () => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker);
        let lowered = 0;
        planner.run(() => {
            attemptPlanned(planner, context, statements[1]!, () => {
                throw new GenericFunctionStorageRequired({
                    family: "pair",
                    arguments: [],
                    parameters: [],
                    frames: [],
                    ancestors: [],
                    site: call,
                });
            });
            attemptPlanned(planner, context, statements[2]!, () => lowered++);
            attemptPlanned(planner, context, statements[3]!, () => {
                throw new DynamicBindingStorageRequired(
                    declarationAt(3),
                    undefined,
                );
            });
        });
        const after = storagePlanningStatistics();
        return {
            demands: planner.demands.map((request) => request.kind),
            lowered,
            writes: after.writes - before.writes,
        };
    };
    assert.deepEqual(plan(), {
        demands: ["generic"],
        lowered: 0,
        writes: 1,
    });
});

test("a plan forgets a function's lost locals when its body starts again", () => {
    // The first activation loses `seen` and ends before its read; the second
    // activation declares it afresh and its read lowers.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        function count(items: number[]): number {
            let seen = { total: 0 };
            return seen.total + items.length;
        }
    `);
    const body = (statements[0] as ts.FunctionDeclaration).body!.statements;
    const planner = new StorageDemandPlanner(checker);
    const declaration = declarationAt(0, body);
    const lowered: number[] = [];
    planner.run(() => {
        attemptPlanned(planner, context, body[0]!, () => {
            throw new AbsenceTagStorageRequired(declaration);
        });
        attemptPlanned(planner, context, body[0]!, () => {});
        attemptPlanned(planner, context, body[1]!, () => lowered.push(2));
    });
    assert.deepEqual(lowered, [2]);
});

test("past a rolled-back statement a plan collects only demands of a key", () => {
    // The first statement's absence tag rolls it back. Strict lowering would
    // go on inside it and could meet the binding demand there first, with
    // that site's storage: the plan departs instead of collecting it.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        const tagged: string | null | undefined = undefined;
        const other: string | null | undefined = null;
        let bound = { gain: 1 };
    `);
    const declaration = (index: number) => declarationAt(index);
    const plan = () => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker);
        const demands = [
            new AbsenceTagStorageRequired(declaration(0)),
            new AbsenceTagStorageRequired(declaration(1)),
            new DynamicBindingStorageRequired(declaration(2), undefined),
        ];
        planner.run(() => {
            for (const [index, demand] of demands.entries())
                attemptPlanned(planner, context, statements[index]!, () => {
                    throw demand;
                });
        });
        return {
            demands: planner.demands.map((request) => request.kind),
            departed: storagePlanningStatistics().departed - before.departed,
        };
    };
    assert.deepEqual(plan(), {
        demands: ["absence-tag", "absence-tag"],
        departed: 1,
    });
});

test("a demand lowering can go on past is planned, whatever kind follows", () => {
    const { checker, statements, declarationAt } = plannedStatements(`
        function keep(first: { value: number }, second: { value: number }) {}
        let other = { gain: 1 };
    `);
    const [first, second] = (statements[0] as ts.FunctionDeclaration)
        .parameters;
    const other = declarationAt(1);
    const demand = new ParameterObjectStorageRequired(first!);
    // Strict lowering raises it.
    assert.throws(
        () => demandOrPlan(demand),
        (error) => error === demand,
    );
    const planner = new StorageDemandPlanner(checker);
    let lowered = false;
    planner.run(() => {
        demandOrPlan(demand);
        demandOrPlan(new ParameterObjectStorageRequired(second!));
        // Past the copies lowering stores what it stored before them.
        demandOrPlan(new DynamicBindingStorageRequired(other, undefined));
        lowered = true;
    });
    assert.ok(lowered);
    assert.deepEqual(
        planner.demands.map((request) =>
            request.kind === "parameter-object"
                ? request.declaration.name.getText()
                : request.kind,
        ),
        ["first", "second", "dynamic"],
    );
});

test("past a demand lowering went on without, a plan ends at storage its site lowered", () => {
    // A binding's element storage is a data type lowering read off values
    // that may hold the copy: strict lowering could ask for another.
    const { checker, statements, declarationAt } = plannedStatements(`
        function keep(first: { value: number }) {}
        let other = [1];
    `);
    const first = (statements[0] as ts.FunctionDeclaration).parameters[0]!;
    const plan = (lowered: StorageDemand) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker);
        planner.run(() => {
            demandOrPlan(new ParameterObjectStorageRequired(first));
            throw lowered;
        });
        return {
            demands: planner.demands.map((request) => request.kind),
            writes: storagePlanningStatistics().writes - before.writes,
        };
    };
    const elements = { kind: "number" } as const;
    assert.deepEqual(
        plan(new DynamicBindingStorageRequired(declarationAt(1), { elements })),
        { demands: ["parameter-object"], writes: 1 },
    );
    // A named storage is the binding's wherever lowering meets it.
    assert.deepEqual(
        plan(new DynamicBindingStorageRequired(declarationAt(1), "array")),
        { demands: ["parameter-object", "dynamic"], writes: 0 },
    );
});

test("past a demand lowering went on without, a plan lowers on as many statements as before its first", () => {
    // A demand that follows from one the plan met (a join chain's next
    // link) only the next attempt meets: past its latest demand the plan
    // lowers on as far as it lowered before its first, then ends.
    const { checker, statements, context } = plannedStatements(`
        function keep(first: { value: number }, second: { value: number }) {}
        const a = 1;
        const b = 2;
        const c = 3;
        const d = 4;
        const e = 5;
    `);
    const [first, second] = (statements[0] as ts.FunctionDeclaration)
        .parameters;
    const plan = (demands: ReadonlyMap<number, ts.ParameterDeclaration>) => {
        const planner = new StorageDemandPlanner(checker);
        const lowered: number[] = [];
        planner.run(() => {
            for (const [index, statement] of statements.entries())
                attemptPlanned(planner, context, statement, () => {
                    const parameter = demands.get(index);
                    if (parameter)
                        demandOrPlan(
                            new ParameterObjectStorageRequired(parameter),
                        );
                    lowered.push(index);
                });
        });
        return lowered;
    };
    // Two statements up to the demand, two past it.
    assert.deepEqual(plan(new Map([[1, first!]])), [0, 1, 2, 3]);
    // A later demand within them lowers on as far again.
    assert.deepEqual(
        plan(
            new Map([
                [1, first!],
                [3, second!],
            ]),
        ),
        [0, 1, 2, 3, 4, 5],
    );
});

test("a plan that went on past a demand collects the next statement's demand of another kind", () => {
    // Lowering on past the parameter's copy, the next statement's binding
    // demand is collected; that ownership change ends the plan.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        function keep(first: { value: number }) {}
        keep({ value: 1 });
        let other = { gain: 1 };
    `);
    const first = (statements[0] as ts.FunctionDeclaration).parameters[0]!;
    const other = declarationAt(2);
    const plan = () => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker);
        planner.run(() => {
            attemptPlanned(planner, context, statements[1]!, () =>
                demandOrPlan(new ParameterObjectStorageRequired(first)),
            );
            attemptPlanned(planner, context, statements[2]!, () => {
                throw new DynamicBindingStorageRequired(other, undefined);
            });
        });
        return {
            demands: planner.demands.map((request) => request.kind),
            writes: storagePlanningStatistics().writes - before.writes,
        };
    };
    assert.deepEqual(plan(), {
        demands: ["parameter-object", "dynamic"],
        writes: 1,
    });
});

test("replay storage lays out its records and bindings in an order of the program, whatever order it took them in", () => {
    // A compile's predeclaration walks them in that order: a plan that met
    // the demands in another order than strict lowering lays out the same
    // program.
    const { checker, statements, declarationAt } = plannedStatements(`
        interface Target { name: string; type: string }
        const first = { name: "a", type: "f32" };
        const second = { name: "b", type: "u32" };
        let third = { name: "c", type: "i32" };
    `);
    const typeOf = (index: number) =>
        checker.getTypeAtLocation(declarationAt(index).name);
    const target = checker.getDeclaredTypeOfSymbol(
        checker.getSymbolAtLocation(
            (statements[0] as ts.InterfaceDeclaration).name,
        )!,
    );
    const join = (index: number, site: ts.Node) =>
        new NativeRecordStorageRequired({
            identity: typeOf(index),
            type: typeOf(index),
            node: site,
            frames: [],
            joins: [{ source: typeOf(index), target, kind: "value" }],
        }).request;
    const binding = (index: number) =>
        new DynamicBindingStorageRequired(declarationAt(index), "source")
            .request;
    const taken = (requests: readonly StorageRequest[]) => {
        const storage = new ReplayStorage(checker);
        for (const request of requests) storage.add(request);
        return storage;
    };
    const declared = (type: ts.Type) =>
        [1, 2, 3].find((index) => typeOf(index) === type);
    const layout = (storage: ReplayStorage) => ({
        records: storage
            .orderedRecords()
            .map((demand) => declared(demand.type)),
        joins: storage
            .orderedJoins(storage.orderedRecords())
            .map((join) => declared(join.source)),
        bindings: storage
            .sourceOrderedDynamicBindings()
            .map(([declaration]) => declaration.name.getText()),
    });
    const forward = layout(
        taken([
            join(1, statements[1]!),
            join(2, statements[2]!),
            binding(1),
            binding(3),
        ]),
    );
    assert.deepEqual(
        layout(
            taken([
                binding(3),
                join(2, statements[2]!),
                binding(1),
                join(1, statements[1]!),
            ]),
        ),
        forward,
    );
    assert.deepEqual(forward, {
        records: [1, 2],
        joins: [1, 2],
        bindings: ["first", "third"],
    });
    // A record met again at a site its source spells first keeps that site.
    const met = taken([join(1, statements[2]!), join(1, statements[1]!)]);
    assert.equal(met.orderedRecords()[0]!.node, statements[1]);
    // An instantiation comes after the records it resolves through, and a
    // record stored with its declared functions before one mapped without
    // them, wherever their sites are: the first maps a joined component.
    const record = (index: number, stored: boolean, framed: boolean) =>
        new NativeRecordStorageRequired({
            identity: typeOf(index),
            type: typeOf(index),
            node: statements[index]!,
            frames: framed
                ? [new Map([[target.getSymbol()!, typeOf(index)]])]
                : [],
            ...(stored ? { stored: true as const } : {}),
        }).request;
    assert.deepEqual(
        layout(
            taken([
                record(1, true, true),
                record(2, false, false),
                record(3, true, false),
            ]),
        ).records,
        [3, 2, 1],
    );
});

test("a plan goes on past an engine owner and meets the next store's", () => {
    const source = `
        interface A { readonly a: HTMLElement; }
        interface B { readonly b: HTMLElement; }
        interface C { readonly c: HTMLElement; }
        interface D { readonly d: HTMLElement; }
        const as: A[] = [];
        const bs: B[] = [];
        const cs: C[] = [];
        const ds: D[] = [];
        const root = document.createElement("div");
        document.body.appendChild(root);
        as.push({ a: root });
        bs.push({ b: root });
        cs.push({ c: root });
        ds.push({ d: root });
        as[0]!.a.classList.add("a");
        bs[0]!.b.classList.add("b");
        cs[0]!.c.classList.add("c");
        ds[0]!.d.classList.add("open");
    `;
    const strict = measured(false, () => compileSource(source));
    const planned = measured(true, () => compileSource(source));
    assert.deepEqual(planned.result, strict.result);
    // The worker realm, each field's owner, then the compile.
    assert.equal(strict.constructions, 6);
    // After the first owner one plan keeps the others' stores and meets
    // all three; the next plan is the compile.
    assert.equal(planned.collected, 3);
    assert.equal(planned.constructions, 4);
});

test("a plan goes on past a record join and meets the next store's engine owner", () => {
    // The join is stored as a copy; the owner adds only its key, so the
    // plan that goes on past the join collects it.
    const source = `
        interface Spot { x: number; y: number }
        interface A { x: number }
        interface Holder { readonly el: HTMLElement }
        interface Other { readonly other: HTMLElement }
        const holders: Holder[] = [];
        const others: Other[] = [];
        function gather(spot: Spot): number {
            const as: A[] = [spot];
            spot.x = 7;
            return as[0]!.x;
        }
        const root = document.createElement("div");
        document.body.appendChild(root);
        holders.push({ el: root });
        const spots: Spot[] = [{ x: 1, y: 2 }];
        const total = spots.map(gather)[0];
        others.push({ other: root });
        holders[0]!.el.classList.add("x");
        others[0]!.other.classList.add("y");
        if (total !== 7) throw new Error("joined");
    `;
    const strict = measured(false, () => compileSource(source));
    const planned = measured(true, () => compileSource(source));
    assert.deepEqual(planned.result, strict.result);
    // The worker realm, the first owner, the join, the second owner, then
    // the compile.
    assert.equal(strict.constructions, 5);
    // The worker realm and the first owner; one plan meets the join and
    // the second owner; then the compile.
    assert.equal(planned.collected, 2);
    assert.equal(planned.constructions, 4);
});

test("a plan that went on past a demand collects the next one of another kind", () => {
    // Engine owners and constants' objects alternate. Each object's binding
    // demand ends its plan; past an owner a plan still collects it.
    const source = `
        interface Decl { name: string; size: number }
        interface Holder { readonly el: HTMLElement }
        interface Other { readonly other: HTMLElement }
        const A: Decl = { name: "a", size: 1 };
        const B: Decl = { name: "b", size: 2 };
        const holders: Holder[] = [];
        const others: Other[] = [];
        async function main(): Promise<void> {
            await Promise.resolve();
            const root = document.createElement("div");
            document.body.appendChild(root);
            holders.push({ el: root });
            const first: Decl[] = [A];
            others.push({ other: root });
            const second: Decl[] = [B];
            holders[0]!.el.classList.add("x");
            others[0]!.other.classList.add("y");
            if (first.indexOf(A) !== 0 || second.indexOf(B) !== 0 || !root.classList.contains("y")) throw new Error("identity");
            globalThis.close();
        }
        void main();
    `;
    const strict = measured(false, () => compileSource(source));
    const planned = measured(true, () => compileSource(source));
    assert.deepEqual(planned.result, strict.result);
    // The worker realm, each owner, each object, then the compile.
    assert.equal(strict.constructions, 6);
    // The worker realm and the first owner; one plan meets the first
    // object, the next goes on past the second owner and meets the second
    // object; then the compile.
    assert.equal(planned.collected, 3);
    assert.equal(planned.constructions, 5);
});

test("a struct store demands every element field's engine owner in one replay", () => {
    const source = `
        interface Layer { readonly panel: HTMLElement; readonly initial: HTMLElement; }
        const layers: Layer[] = [];
        function open(panel: HTMLElement, initial: HTMLElement): void {
            layers.push({ panel, initial });
        }
        const panel = document.createElement("div");
        const button = document.createElement("button");
        panel.appendChild(button);
        document.body.appendChild(panel);
        open(panel, button);
        const top = layers[layers.length - 1]!;
        top.panel.classList.add("open");
        top.initial.focus();
    `;
    const strict = measured(false, () => compileSource(source));
    // The worker realm, then both fields' owners at once, then the compile.
    assert.equal(strict.constructions, 3);
});

for (const [label, extras, fixture] of [
    [
        // Each element literal has its own layout.
        "records stored into a document demand every element's document storage in one replay",
        ["", ", weight: 1", ", depth: 2", ", speed: 3"],
        "document-elements",
    ],
    [
        // The element literals share one layout; each element's demand
        // names its own record type.
        "records sharing one struct demand each element's document storage in one replay",
        [", weight: 1", ", weight: 1", ", weight: 1", ", weight: 1"],
        "shared-struct-elements",
    ],
] as const)
    test(label, (t) => {
        const elements = extras
            .map(
                (extra, index) =>
                    `{ id: "f${index + 1}", ...BASE[${index}], scale: ${index + 1}${extra} }`,
            )
            .join(", ");
        const last = extras[3].replace(/, (\w+): (\d+)/, ',"$1":$2');
        const source = `
            interface Variant { readonly file: string; readonly clips?: { readonly normal?: string[] } }
            const BASE: readonly [Variant, Variant, Variant, Variant] = [
                { file: "a", clips: { normal: ["w"] } }, { file: "b", clips: { normal: ["x"] } },
                { file: "c", clips: { normal: ["y"] } }, { file: "d", clips: { normal: ["z"] } },
            ];
            const doc = JSON.parse('{"kind":"catalog"}') as Record<string, unknown>;
            doc.variants = [${elements}];
            const text = JSON.stringify(doc);
            if (!text.includes('{"id":"f4","file":"d","clips":{"normal":["z"]},"scale":4${last}}')) throw new Error(text);
        `;
        const strict = measured(false, () => compileSource(source));
        // The document binding, then the variant type with the four
        // elements' own records at once, then the compile.
        assert.equal(strict.constructions, 3);
        const tools = optionalNativeFixtureTools();
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `storage-demand-planner/${fixture}`,
            strict.result.cpp,
            { expectedOutput: "" },
        );
    });

test("a fresh record of records stored into a document demands every member's storage in one replay", (t) => {
    // The document snapshots the literal's members one after another; each
    // const record's type joins the first member's document demand.
    const source = `
        interface Tower { readonly height: number; readonly courses: readonly { shift: number }[] }
        interface House { readonly section: number; readonly length: number }
        interface Mana { readonly max: number; readonly regen: number }
        const TOWER: Tower = { height: 0.3, courses: [{ shift: 0 }] };
        const HOUSE: House = { section: 0.2, length: 1.5 };
        const MANA: Mana = { max: 10, regen: 0.5 };
        const doc = JSON.parse('{"kind":"config"}') as Record<string, unknown>;
        doc.styles = { tower: TOWER, house: HOUSE, mana: MANA };
        const text = JSON.stringify(doc);
        if (text !== '{"kind":"config","styles":{"tower":{"height":0.3,"courses":[{"shift":0}]},"house":{"section":0.2,"length":1.5},"mana":{"max":10,"regen":0.5}}}') throw new Error(text);
    `;
    const strict = measured(false, () => compileSource(source));
    // The three member types at once, then the compile.
    assert.equal(strict.constructions, 2);
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "storage-demand-planner/document-snapshot-members",
        strict.result.cpp,
        {
            expectedOutput: "",
        },
    );
});

test("a record of document arrays stored into a struct demands every element's document storage in one replay", (t) => {
    // The returned literal stores a parsed document's arrays into a
    // record's fields one after another; each element type joins the first
    // field's document demand.
    const source = `
        interface Tint { seq: number; rgb: [number, number, number] }
        interface Width { seq: number; w: number }
        interface Height { key: string; h: number }
        interface Save { v: number; tints?: Tint[]; widths?: Width[]; heights?: Height[] }
        function normalize(d: Save): Save {
            return { v: d.v, tints: d.tints ?? [], widths: d.widths ?? [], heights: d.heights ?? [] };
        }
        function total(save: Save): number {
            let sum = save.v;
            for (const row of save.tints ?? []) sum += row.seq + row.rgb[2];
            for (const row of save.widths ?? []) sum += row.w;
            for (const row of save.heights ?? []) sum += row.h + row.key.length;
            return sum;
        }
        const save = normalize(JSON.parse('{"v":1,"tints":[{"seq":2,"rgb":[0,0,3]}],"heights":[{"key":"ab","h":4}]}') as Save);
        if (total(save) !== 12) throw new Error(String(total(save)));
        const text = JSON.stringify(save);
        if (text !== '{"v":1,"tints":[{"seq":2,"rgb":[0,0,3]}],"widths":[],"heights":[{"key":"ab","h":4}]}') throw new Error(text);
    `;
    const strict = measured(false, () => compileSource(source));
    // The three element types at once, then the compile.
    assert.equal(strict.constructions, 2);
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "storage-demand-planner/document-array-fields",
        strict.result.cpp,
        {
            expectedOutput: "",
        },
    );
});

test("a record of literal tables demands every table's object storage in one replay", (t) => {
    const source = `
        type Lang = "en" | "fr" | "es";
        type Dict = Record<string, string>;
        const EN: Dict = { greet: "Hello", bye: "Bye" };
        const FR: Dict = { greet: "Bonjour", bye: "Salut" };
        const ES: Dict = { greet: "Hola", bye: "Adios" };
        const TABLES: Record<Lang, Dict> = { en: EN, fr: FR, es: ES };
        let current: Lang = "en";
        function has(lang: Lang, key: string): boolean { return Object.prototype.hasOwnProperty.call(TABLES[lang], key); }
        function t(key: string): string { return TABLES[current][key] ?? EN[key] ?? key; }
        current = Math.random() > 2 ? "fr" : "es";
        if (t("greet") !== "Hola" || !has("fr", "bye") || t("bye") !== "Adios") throw new Error("tables");
    `;
    const strict = measured(false, () => compileSource(source));
    // One attempt meets the three tables' demands, the next compiles.
    assert.equal(strict.constructions, 2);
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "storage-demand-planner/literal-tables",
        strict.result.cpp,
        {
            expectedOutput: "",
        },
    );
});

test("a record type read out of a document is a document with it, in one replay", async (t) => {
    // Every type below is read out of the parsed save and stored as itself.
    const source = `
    interface Tab { open: boolean; label: string }
    interface Flag { lit: boolean }
    interface Group { name: string; tabs: Tab[]; main?: Tab; flags: Record<string, Flag> }
    interface Owner { name: string; age: number }
    interface Cell { groups: Group[]; owner: Owner }
    interface Save { version: number; cell: Cell }
    const text = '{"version":2,"cell":{"groups":[{"name":"hall","tabs":[{"open":true,"label":"front"}],"main":{"open":false,"label":"m"},"flags":{"a":{"lit":true}}}],"owner":{"name":"Ada","age":36}}}';
    const saves: Save[] = [];
    saves.push(JSON.parse(text) as Save);
    const tabs: Tab[] = [];
    const groups: Group[] = [];
    const owners: Owner[] = [];
    const flags: Flag[] = [];
    const cells: Cell[] = [];
    for (const save of saves) {
        cells.push(save.cell);
        owners.push(save.cell.owner);
        for (const group of save.cell.groups) {
            groups.push(group);
            if (group.main) tabs.push(group.main);
            for (const tab of group.tabs) tabs.push(tab);
            for (const key of Object.keys(group.flags)) flags.push(group.flags[key]!);
        }
    }
    // A literal of a type so stored is the same kind of object.
    tabs.push({ open: true, label: "side" });
    const out = cells.length + "|" + owners[0]!.name + "|" + groups[0]!.name + "|" + tabs.map((tab) => tab.label).join("+") + "|" + flags[0]!.lit;
    if (out !== "1|Ada|hall|m+front+side|true") throw new Error(out);
`;
    await oneReplay(t, "read-closure", source);
});

test("a record copied out of a parsed document field by field is a document with it, in one replay", async (t) => {
    // A migration rebuilds the save out of spreads and rests of its parsed
    // records.
    const source = `
    interface Part { id: number; post: number; s?: number }
    interface Tab { id: number; cell: number; purpose?: string }
    interface Extra { x: number; lc?: number }
    interface Save { version: number; parts: Part[]; tabs: Tab[]; extra: Extra[] }
    const text = '{"version":3,"parts":[{"id":1,"post":2,"s":1},{"id":2,"post":3,"s":2}],"tabs":[{"id":4,"cell":1,"purpose":"bogus"},{"id":5,"cell":2}],"extra":[{"x":1.5,"lc":7}]}';
    function migrate(d: Save): string {
        const parts = d.parts.map((part) => {
            const normalized = { ...part };
            if (Math.abs((part.s ?? 1) - 1) <= 1e-9) delete normalized.s;
            return normalized;
        });
        const tabs = d.tabs.map((tab) => {
            const raw = (tab as Tab & { purpose?: unknown }).purpose;
            if (raw === "entrance" || raw === undefined) return { ...tab };
            const { purpose: _invalid, ...rest } = tab as Tab & { purpose?: unknown };
            return rest as Tab;
        });
        const extra = d.extra.map(({ lc: _retired, ...kept }) => kept);
        return parts.map((part) => part.id + ":" + (part.s ?? "-")).join() + "|" + tabs.map((tab) => tab.id + ":" + (tab.purpose ?? "-")).join() + "|" + extra.map((kept) => kept.x + ":" + ("lc" in kept ? "lc" : "-")).join();
    }
    const out = migrate(JSON.parse(text) as Save);
    if (out !== "1:-,2:2|4:-,5:-|1.5:-") throw new Error(out);
`;
    await oneReplay(t, "copy-closure", source);
});

test("a document handed where another record type is declared makes that type a document, in one replay", async (t) => {
    // The parameters' own record types keep the parsed records they are
    // handed.
    const source = `
    interface Claim { t: number; h?: number; who: string }
    interface Course { seq: number; v: number }
    interface Step { id: number; courses?: Course[] }
    interface Save { claims: Claim[]; steps: Step[] }
    const text = '{"claims":[{"t":2,"h":7,"who":"ada"},{"t":3,"who":"bob"}],"steps":[{"id":1,"courses":[{"seq":1,"v":4},{"seq":2,"v":5}]},{"id":2}]}';
    const homes: { t: number; h?: number }[] = [];
    function keep(home: { t: number; h?: number }): number { homes.push(home); return home.h ?? home.t; }
    const folded: { seq: number; v: number }[] = [];
    function fold(courses: { seq: number; v: number }[] | undefined): number {
        let total = 0;
        for (const course of courses ?? []) { folded.push(course); total += course.v; }
        return total;
    }
    function migrate(d: Save): string {
        return d.claims.map((claim) => claim.who + keep(claim)).join() + "|" + d.steps.map((step) => step.id + ":" + fold(step.courses)).join();
    }
    const out = migrate(JSON.parse(text) as Save);
    if (out !== "ada7,bob3|1:9,2:0" || homes.length !== 2 || homes[1]!.t !== 3 || folded.length !== 2 || folded[1]!.seq !== 2) throw new Error(out);
`;
    await oneReplay(t, "handed-closure", source);
});

test("an intersection over a parsed record arrived in that record's parse, in one replay", async (t) => {
    // A generic helper returns `T & { id: number }` for each parsed record
    // type it is given: the instantiated intersection, and the helper's own
    // under that instantiation.
    const source = `
    interface Member { id?: number; name: string }
    interface Extra { id?: number; x: number }
    interface Save { members: Member[]; extra: Extra[] }
    function numbered<T extends { id?: number }>(input: readonly T[], minimumNextId = 1): { items: Array<T & { id: number }>; nextId: number } {
        const reserved = new Set<number>();
        for (const item of input) if (Number.isSafeInteger(item.id) && item.id! > 0 && !reserved.has(item.id!)) reserved.add(item.id!);
        const used = new Set<number>();
        let replacement = minimumNextId;
        for (const id of reserved) replacement = Math.max(replacement, id + 1);
        const items = input.map((item) => {
            let id = item.id;
            if (!Number.isSafeInteger(id) || id! <= 0 || used.has(id!)) id = replacement++;
            used.add(id!);
            return { ...item, id: id! };
        });
        let nextId = minimumNextId;
        for (const id of used) nextId = Math.max(nextId, id + 1);
        return { items, nextId };
    }
    const text = '{"members":[{"id":4,"name":"ada"},{"name":"bob"},{"id":4,"name":"cy"}],"extra":[{"x":1.5},{"id":9,"x":2.5}]}';
    function migrate(d: Save): string {
        const members = numbered(d.members).items;
        const extra = numbered(d.extra, 3);
        return members.map((member) => member.name + member.id).join() + "|" + extra.items.map((kept) => kept.x + ":" + kept.id).join() + "|" + extra.nextId;
    }
    const out = migrate(JSON.parse(text) as Save);
    if (out !== "ada4,bob5,cy6|1.5:10,2.5:9|11") throw new Error(out);
`;
    await oneReplay(t, "intersection-closure", source);
});

test("a record read out of an asserted parse is a document with everything read out of that parse", async (t) => {
    // The save is only asserted and read; its first stored value is a group,
    // far below it. The flags and owners are siblings of the group, and the
    // helper's `T & { id: number }` holds an owner's own properties.
    const source = `
    interface Tab { open: boolean; label: string }
    interface Flag { lit: boolean }
    interface Group { name: string; tabs: Tab[]; main?: Tab; flags: Record<string, Flag> }
    interface Owner { name: string; age: number }
    interface Save { version: number; groups: Group[]; owners: Owner[]; flags: Flag[] }
    const text = '{"version":2,"groups":[{"name":"hall","tabs":[{"open":true,"label":"front"}],"main":{"open":false,"label":"m"},"flags":{"a":{"lit":true}}}],"owners":[{"name":"Ada","age":36}],"flags":[{"lit":false}]}';
    function withIds<T>(input: readonly T[]): Array<T & { id: number }> { return input.map((item, index) => ({ ...item, id: index + 1 })); }
    function migrate(d: Partial<Save>): string {
        const groups: Group[] = [];
        for (const group of d.groups ?? []) groups.push(group);
        const owners = withIds(d.owners ?? []);
        const flags: Flag[] = [];
        for (const flag of d.flags ?? []) flags.push(flag);
        const tabs: Tab[] = [];
        for (const group of groups) for (const tab of group.tabs) tabs.push(tab);
        return groups[0]!.name + "|" + owners[0]!.name + owners[0]!.id + "|" + flags.length + "|" + tabs[0]!.label;
    }
    function parseSave(parsed: unknown): string {
        if (!parsed || typeof parsed !== "object") return "";
        const d = parsed as Partial<Save>;
        return migrate(d);
    }
    const out = parseSave(JSON.parse(text));
    if (out !== "hall|Ada1|1|front") throw new Error(out);
`;
    await oneReplay(t, "parse-roots", source);
});

test("an array literal of constants an identity read stores by reference replays once for all of them", () => {
    // Each constant's record needs its own object once the array holds
    // records by reference; a later element naming a constant joins the
    // first element's demand, plain or past a conditional spread, so the
    // literal replays as often as a literal of one constant does.
    const program = (literal: string, last: string, index: number) => `
    interface Decl { name: string; size: number }
    const A: Decl = { name: "a", size: 1 };
    const B: Decl = { name: "b", size: 2 };
    const C: Decl = { name: "c", size: 3 };
    async function main(): Promise<void> {
        await Promise.resolve();
        const held: Decl[] = ${literal};
        if (held.indexOf(${last}) !== ${index} || held[0]!.name !== "a") throw new Error("identity");
        globalThis.close();
    }
    void main();
`;
    const single = measured(false, () =>
        compileSource(program("[A]", "A", 0)),
    ).constructions;
    const tools = optionalNativeFixtureTools(false);
    for (const [name, literal] of [
        ["listed", "[A, B, C]"],
        ["spread", "[...(Date.now() > 0 ? [A, B] : []), C]"],
    ] as const) {
        const compiled = measured(false, () =>
            compileSource(program(literal, "C", 2)),
        );
        assert.equal(compiled.constructions, single, name);
        if (tools)
            runGeneratedProgram(
                tools,
                `storage-demand-planner/literal-constants-${name}`,
                compiled.result.cpp,
                {
                    flags: ["/DBBLITE_WORKERS=1"],
                    expectedOutput: "",
                    timeoutMs: 15000,
                },
            );
    }
});

test("a document's record type takes the record types handed where it is declared in the same demand", async (t) => {
    // `Herd` is read out of a parsed document and holds `Bounds`; `SMALL`'s
    // own record type is handed where `Bounds` is declared, so the strict
    // loop would take it as a document one attempt later.
    const source = `
        interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
        interface Herd { bounds: Bounds; scale: number }
        interface Config { herd: Herd; name: string }
        const DEFAULTS: Config = { herd: { bounds: { minX: -1, maxX: 1, minY: 0, maxY: 2 }, scale: 1 }, name: "defaults" };
        function measure(bounds: Readonly<Bounds>, height: number): number { return (bounds.maxY - bounds.minY) * height + bounds.maxX; }
        const SMALL = { minX: -0.5, maxX: 0.5, minY: 0, maxY: 0.25 };
        const SMALL_METRIC = measure(SMALL, 4);
        function load(text: string): Config { return { ...DEFAULTS, ...(JSON.parse(text) as Config) }; }
        const config = load('{"herd":{"bounds":{"minX":-2,"maxX":3,"minY":1,"maxY":5},"scale":2},"name":"saved"}');
        if (measure(config.herd.bounds, config.herd.scale) !== 11) throw new Error("document bounds");
        if (SMALL_METRIC !== 1.5) throw new Error("handed bounds");
        if (config.name !== "saved") throw new Error("name");
    `;
    const lines: string[] = [];
    compileSource(source, { compileProgress: (line) => lines.push(line) });
    assert.match(lines[0]!, /record \(Herd: document\)/);
    assert.ok(
        !lines.some((line) =>
            /record \(\{ minX, maxX, minY, maxY \}: document\)/.test(line),
        ),
        lines.join("\n"),
    );
    await runSelfCheckingProgram(
        t,
        "storage-demand-planner/handed-document-records",
        source,
    );
});

test("a demanded record whose field holds an instance of a class no replay shares yet shares the class", async (t) => {
    // The options literal's record is demanded before any store shares
    // `Frame` (its instance arrives inside another record), so the record
    // is mapped while `Frame` has no storage yet: the demand shares it,
    // as a lowered store of an instance does, rather than refusing.
    const source = `
        interface Placement { readonly slot: number; readonly y: number }
        interface Node3 { position: { y: number }; parent: object | null }
        class Frame {
          constructor(private readonly origin: number) {}
          private readonly entries = new Map<number, number>();
          private version = 0;
          place(node: Pick<Node3, "position" | "parent">, placement: Placement): void {
            this.entries.set(placement.slot, placement.y);
            this.version++;
            node.position.y = placement.y + this.origin;
          }
          count(): number { return this.entries.size * 10 + this.version; }
        }
        interface BatchOptions { name?: string; frame?: Frame; capacity?: number; tint?: [number, number, number]; drift?: number }
        interface Batch { node: Node3; name: string; add(slot: number, y: number): void; count(): number }
        function createBatch(opts: BatchOptions = {}): Batch {
          const node: Node3 = { position: { y: 0 }, parent: null };
          const frame = opts.frame;
          return { node, name: \`\${opts.name ?? "batch"}:\${opts.capacity ?? 1}:\${opts.tint?.[0] ?? 0}\`, add: (slot, y) => frame?.place(node, { slot, y }), count: () => frame?.count() ?? -1 };
        }
        interface HostRender { frame: Frame }
        interface TowerOptions { hostRender?: HostRender; tinted: boolean; drift: number }
        function createTowers(opts: TowerOptions): Batch[] {
          const nativeOptions = opts.hostRender ? { frame: opts.hostRender.frame } : {};
          const rail = createBatch({ name: "rail", capacity: 8, drift: opts.drift, ...nativeOptions, ...(opts.tinted ? { tint: [1, 0.5, 0.25] as [number, number, number] } : {}) });
          const belt = createBatch({ name: "belt", capacity: 4, drift: opts.drift, ...nativeOptions, ...(opts.tinted ? { tint: [0.5, 0.5, 0.5] as [number, number, number] } : {}) });
          return [rail, belt];
        }
        const hosted = Date.now() > 0;
        const batches = createTowers({ hostRender: hosted ? { frame: new Frame(0.5) } : undefined, tinted: Date.now() < 0, drift: 1 });
        for (let index = 0; index < batches.length; index++) batches[index]!.add(index, 2);
        if (batches[0]!.count() !== 22 || batches[1]!.count() !== 22) throw new Error("one shared frame");
        if (batches[0]!.node.position.y !== 2.5 || batches[1]!.node.position.y !== 2.5) throw new Error("placed nodes");
        if (batches[0]!.name !== "rail:8:0" || batches[1]!.name !== "belt:4:0") throw new Error("options");
    `;
    const lines: string[] = [];
    compileSource(source, { compileProgress: (line) => lines.push(line) });
    assert.ok(
        lines.some((line) => /shared-class/.test(line)),
        lines.join("\n"),
    );
    await runSelfCheckingProgram(
        t,
        "storage-demand-planner/demanded-record-unshared-class",
        source,
    );
});
