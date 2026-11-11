import assert from "node:assert/strict";
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

test("a plan that went on past a demand ends at the next statement's demand of another kind", () => {
    // Lowering on past the parameter's copy, the next statement's demand
    // may follow from it: the plan ends there.
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
        demands: ["parameter-object"],
        writes: 1,
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
