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

/** A one-file program, for driving the planner over real statements. */
function plannedStatements(source: string) {
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 };
    const host = ts.createCompilerHost(options, true);
    const file = ts.createSourceFile("input.ts", source, options.target!, true);
    host.getSourceFile = (path) => (path === "input.ts" ? file : undefined);
    const program = ts.createProgram(["input.ts"], options, host);
    return { checker: program.getTypeChecker(), statements: file.statements };
}

test("a survey's plan goes on past a dependent demand, skipping what reads it", () => {
    // Each record `let` demands dynamic storage; the statements reading one
    // wait for the next attempt, and the unrelated one is still collected.
    const { checker, statements } = plannedStatements(`
        let first = { gain: 1 };
        first = { gain: 2 };
        const doubled = first.gain * 2;
        let second = { level: 1 };
        second = { level: 2 };
    `);
    const plan = (survey: boolean) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker, 0, survey);
        const context = {
            checker,
            transaction: (work: () => void) => work(),
        } as unknown as Parameters<typeof planner.attemptStatement>[0];
        planner.run(() => {
            for (const statement of statements)
                planner.attemptStatement(context, statement, () => {
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

test("past a rolled-back statement a plan collects only demands of a key", () => {
    // The first statement's absence tag rolls it back. Strict lowering would
    // go on inside it and could meet the binding demand there first, with
    // that site's storage: only a survey's plan collects it here.
    const { checker, statements } = plannedStatements(`
        const tagged: string | null | undefined = undefined;
        const other: string | null | undefined = null;
        let bound = { gain: 1 };
    `);
    const declaration = (index: number) =>
        (statements[index] as ts.VariableStatement).declarationList
            .declarations[0]!;
    const plan = (survey: boolean) => {
        const before = storagePlanningStatistics();
        const planner = new StorageDemandPlanner(checker, 0, survey);
        const context = {
            checker,
            transaction: (work: () => void) => work(),
        } as unknown as Parameters<typeof planner.attemptStatement>[0];
        const demands = [
            new AbsenceTagStorageRequired(declaration(0)),
            new AbsenceTagStorageRequired(declaration(1)),
            new DynamicBindingStorageRequired(declaration(2), undefined),
        ];
        planner.run(() => {
            for (const [index, demand] of demands.entries())
                planner.attemptStatement(context, statements[index]!, () => {
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
    const { checker, statements } = plannedStatements(`
        function keep(first: { value: number }, second: { value: number }) {}
        let other = { gain: 1 };
    `);
    const [first, second] = (statements[0] as ts.FunctionDeclaration)
        .parameters;
    const other = (statements[1] as ts.VariableStatement).declarationList
        .declarations[0]!;
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
