import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource, surveySource } from "../src/compiler.js";
import { SourceCoverage } from "../src/compiler/source-coverage.js";
import { AbsenceTagStorageRequired } from "../src/compiler/absence-tag-storage.js";
import {
    DynamicBindingStorageRequired,
    ParameterObjectStorageRequired,
} from "../src/compiler/dynamic-binding-storage.js";
import { GenericFunctionStorageRequired } from "../src/compiler/generic-function-storage.js";
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

test("survey and coverage publish only fresh strict attempts after planning refusal", () => {
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
    assert.deepEqual(planned.result.report, baseline.result.report);
    assert.deepEqual(plannedCoverage.report(), baselineCoverage.report());
    assert.equal(planned.planning, 1);
    assert.equal(planned.refused, 1);
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

test("a survey's plan goes on past a dependent demand, skipping what reads it", () => {
    // Each record `let` demands dynamic storage; the statements reading one
    // wait for the next attempt, and the unrelated one is still collected.
    const { checker, statements, context } = plannedStatements(`
        let first = { gain: 1 };
        first = { gain: 2 };
        const doubled = first.gain * 2;
        let second = { level: 1 };
        second = { level: 2 };
    `);
    const plan = (survey: boolean) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker, survey);
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
    assert.deepEqual(plan(false), {
        demands: ["first"],
        dependent: 0,
        writes: 1,
    });
    assert.deepEqual(plan(true), {
        demands: ["first", "second"],
        dependent: 3,
        writes: 0,
    });
});

test("a survey's plan loses a generic signature's statement and goes on", () => {
    // A destructured generic call's demand is not independent: an ordinary
    // plan ends there, a survey's loses the statement's names.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        function pair<T>(value: T): [T, T] { return [value, value]; }
        const [left, right] = pair(1);
        const sum = left + right;
        let other = { gain: 1 };
    `);
    const call = declarationAt(1).initializer as ts.CallExpression;
    const plan = (survey: boolean) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker, survey);
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
    assert.deepEqual(plan(false), {
        demands: ["generic"],
        lowered: 0,
        writes: 1,
    });
    assert.deepEqual(plan(true), {
        demands: ["generic", "dynamic"],
        lowered: 0,
        writes: 0,
    });
});

test("a survey's plan loses a write through this by its class and goes on", () => {
    // The method statement reads the lost binding and writes through
    // `this`: the class's other reads of `this` wait for the next attempt,
    // and the unrelated binding's demand is still collected.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        let first = { gain: 1 };
        class Counter {
            total = 0;
            add(): void { this.total += first.gain; }
            read(): number { return this.total; }
        }
        let second = { level: 1 };
    `);
    const counter = statements[1] as ts.ClassDeclaration;
    const body = (name: string) =>
        (
            counter.members.find(
                (member) => member.name?.getText() === name,
            ) as ts.MethodDeclaration
        ).body!.statements[0]!;
    const before = storagePlanningStatistics();
    const planner = new StorageDemandPlanner(checker, true);
    const binding = (index: number) => () => {
        throw new DynamicBindingStorageRequired(
            declarationAt(index),
            undefined,
        );
    };
    let lowered = 0;
    planner.run(() => {
        attemptPlanned(planner, context, statements[0]!, binding(0));
        for (const name of ["add", "read"])
            attemptPlanned(planner, context, body(name), () => lowered++);
        attemptPlanned(planner, context, statements[2]!, binding(2));
    });
    const after = storagePlanningStatistics();
    assert.deepEqual(
        planner.demands.map((request) =>
            request.kind === "dynamic"
                ? request.declaration.name.getText()
                : request.kind,
        ),
        ["first", "second"],
    );
    assert.equal(lowered, 0);
    assert.equal(after.dependent - before.dependent, 2);
    assert.equal(after.writes - before.writes, 0);
});

test("a survey's plan loses a write through an assignment's value by its target and goes on", () => {
    // `(cache ??= {}).hits = ...` reads the lost binding and writes into
    // what `cache` holds: the later read of `cache` waits for the next
    // attempt, and the unrelated binding's demand is still collected.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        let first = { gain: 1 };
        let cache: { hits?: number } | undefined;
        (cache ??= {}).hits = first.gain;
        const read = cache?.hits;
        let second = { level: 1 };
    `);
    const before = storagePlanningStatistics();
    const planner = new StorageDemandPlanner(checker, true);
    const binding = (index: number) => () => {
        throw new DynamicBindingStorageRequired(
            declarationAt(index),
            undefined,
        );
    };
    let lowered = 0;
    planner.run(() => {
        attemptPlanned(planner, context, statements[0]!, binding(0));
        for (const index of [1, 2, 3])
            attemptPlanned(planner, context, statements[index]!, () => {
                lowered++;
            });
        attemptPlanned(planner, context, statements[4]!, binding(4));
    });
    const after = storagePlanningStatistics();
    assert.deepEqual(
        planner.demands.map((request) =>
            request.kind === "dynamic"
                ? request.declaration.name.getText()
                : request.kind,
        ),
        ["first", "second"],
    );
    assert.equal(lowered, 1);
    assert.equal(after.dependent - before.dependent, 2);
    assert.equal(after.writes - before.writes, 0);
});

test("a survey's plan records a replay besides storage and goes on", () => {
    const { checker, statements, context, declarationAt } = plannedStatements(`
        const state = { query: "a" };
        let other = { gain: 1 };
    `);
    class QueryReplay extends Error {}
    const planner = new StorageDemandPlanner(
        checker,
        true,
        (error): error is Error => error instanceof QueryReplay,
    );
    planner.run(() => {
        attemptPlanned(planner, context, statements[0]!, () => {
            throw new QueryReplay("query state");
        });
        attemptPlanned(planner, context, statements[1]!, () => {
            throw new DynamicBindingStorageRequired(
                declarationAt(1),
                undefined,
            );
        });
    });
    assert.deepEqual(
        planner.replays.map((replay) => replay.message),
        ["query state"],
    );
    assert.deepEqual(
        planner.demands.map((request) => request.kind),
        ["dynamic"],
    );
});

test("a survey's plan forgets a function's lost locals when its body starts again", () => {
    // The first activation loses `seen`, so its read waits; the second
    // activation declares it afresh and its read lowers.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        function count(items: number[]): number {
            let seen = { total: 0 };
            return seen.total + items.length;
        }
    `);
    const body = (statements[0] as ts.FunctionDeclaration).body!.statements;
    const planner = new StorageDemandPlanner(checker, true);
    const declaration = declarationAt(0, body);
    const lowered: number[] = [];
    planner.run(() => {
        for (const activation of [1, 2]) {
            attemptPlanned(planner, context, body[0]!, () => {
                if (activation === 1)
                    throw new DynamicBindingStorageRequired(
                        declaration,
                        undefined,
                    );
            });
            attemptPlanned(planner, context, body[1]!, () =>
                lowered.push(activation),
            );
        }
    });
    assert.deepEqual(lowered, [2]);
});

test("past a rolled-back statement a plan collects only demands of a key", () => {
    // The first statement's absence tag rolls it back. Strict lowering would
    // go on inside it and could meet the binding demand there first, with
    // that site's storage: only a survey's plan collects it here.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        const tagged: string | null | undefined = undefined;
        const other: string | null | undefined = null;
        let bound = { gain: 1 };
    `);
    const declaration = (index: number) => declarationAt(index);
    const plan = (survey: boolean) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker, survey);
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
    assert.deepEqual(plan(false), {
        demands: ["absence-tag", "absence-tag"],
        departed: 1,
    });
    assert.deepEqual(plan(true), {
        demands: ["absence-tag", "absence-tag", "dynamic"],
        departed: 0,
    });
});

test("a demand lowering can go on past is planned, one kind per plan", () => {
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
    planner.run(() => {
        demandOrPlan(demand);
        demandOrPlan(new ParameterObjectStorageRequired(second!));
        // A demand of another kind may follow from the planned ones.
        demandOrPlan(new DynamicBindingStorageRequired(other, undefined));
        assert.fail("planning goes on past a demand of another kind");
    });
    assert.deepEqual(
        planner.demands.map((request) =>
            request.kind === "parameter-object"
                ? request.declaration.name.getText()
                : request.kind,
        ),
        ["first", "second"],
    );
});

test("a survey's plan meets a demand lowering can go on past as its statement's", () => {
    // Lowering on past the parameter's copy would end a plan at the next
    // statement's demand; a survey's plan loses the parameter's function
    // and collects the unrelated binding's demand too.
    const { checker, statements, context, declarationAt } = plannedStatements(`
        function keep(first: { value: number }) {}
        keep({ value: 1 });
        let other = { gain: 1 };
    `);
    const first = (statements[0] as ts.FunctionDeclaration).parameters[0]!;
    const other = declarationAt(2);
    const plan = (survey: boolean) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker, survey);
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
    assert.deepEqual(plan(false), {
        demands: ["parameter-object"],
        writes: 1,
    });
    assert.deepEqual(plan(true), {
        demands: ["parameter-object", "dynamic"],
        writes: 0,
    });
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
    // Every type below is read out of the parsed save and stored as itself:
    // each was one replay of its own, as its first value arrived.
    const source = `
    interface Door { open: boolean; label: string }
    interface Lamp { lit: boolean }
    interface Room { name: string; doors: Door[]; main?: Door; lamps: Record<string, Lamp> }
    interface Owner { name: string; age: number }
    interface House { rooms: Room[]; owner: Owner }
    interface Save { version: number; house: House }
    const text = '{"version":2,"house":{"rooms":[{"name":"hall","doors":[{"open":true,"label":"front"}],"main":{"open":false,"label":"m"},"lamps":{"a":{"lit":true}}}],"owner":{"name":"Ada","age":36}}}';
    const saves: Save[] = [];
    saves.push(JSON.parse(text) as Save);
    const doors: Door[] = [];
    const rooms: Room[] = [];
    const owners: Owner[] = [];
    const lamps: Lamp[] = [];
    const houses: House[] = [];
    for (const save of saves) {
        houses.push(save.house);
        owners.push(save.house.owner);
        for (const room of save.house.rooms) {
            rooms.push(room);
            if (room.main) doors.push(room.main);
            for (const door of room.doors) doors.push(door);
            for (const key of Object.keys(room.lamps)) lamps.push(room.lamps[key]!);
        }
    }
    // A literal of a type so stored is the same kind of object.
    doors.push({ open: true, label: "side" });
    const out = houses.length + "|" + owners[0]!.name + "|" + rooms[0]!.name + "|" + doors.map((door) => door.label).join("+") + "|" + lamps[0]!.lit;
    if (out !== "1|Ada|hall|m+front+side|true") throw new Error(out);
`;
    const strict = measured(false, () => compileSource(source));
    assert.equal(strict.constructions, 2);
    await runSelfCheckingProgram(
        t,
        "storage-demand-planner/read-closure",
        source,
    );
});

test("a record read out of an asserted parse is a document with everything read out of that parse", async (t) => {
    // The save is only asserted and read; its first stored value is a room,
    // far below it. The lamps and owners are siblings of the room, and the
    // helper's `T & { id: number }` holds an owner's own properties.
    const source = `
    interface Door { open: boolean; label: string }
    interface Lamp { lit: boolean }
    interface Room { name: string; doors: Door[]; main?: Door; lamps: Record<string, Lamp> }
    interface Owner { name: string; age: number }
    interface Save { version: number; rooms: Room[]; owners: Owner[]; lamps: Lamp[] }
    const text = '{"version":2,"rooms":[{"name":"hall","doors":[{"open":true,"label":"front"}],"main":{"open":false,"label":"m"},"lamps":{"a":{"lit":true}}}],"owners":[{"name":"Ada","age":36}],"lamps":[{"lit":false}]}';
    function withIds<T>(input: readonly T[]): Array<T & { id: number }> { return input.map((item, index) => ({ ...item, id: index + 1 })); }
    function migrate(d: Partial<Save>): string {
        const rooms: Room[] = [];
        for (const room of d.rooms ?? []) rooms.push(room);
        const owners = withIds(d.owners ?? []);
        const lamps: Lamp[] = [];
        for (const lamp of d.lamps ?? []) lamps.push(lamp);
        const doors: Door[] = [];
        for (const room of rooms) for (const door of room.doors) doors.push(door);
        return rooms[0]!.name + "|" + owners[0]!.name + owners[0]!.id + "|" + lamps.length + "|" + doors[0]!.label;
    }
    const parsed: unknown = JSON.parse(text);
    const out = migrate(parsed as Partial<Save>);
    if (out !== "hall|Ada1|1|front") throw new Error(out);
`;
    const strict = measured(false, () => compileSource(source));
    assert.equal(strict.constructions, 2);
    await runSelfCheckingProgram(
        t,
        "storage-demand-planner/parse-roots",
        source,
    );
});
