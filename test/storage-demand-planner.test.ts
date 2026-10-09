import assert from "node:assert/strict";
import test from "node:test";
import { compileSource, surveySource } from "../src/compiler.js";
import { SourceCoverage } from "../src/compiler/source-coverage.js";
import {
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
    };
}

test("discarded storage planning batches generic signatures and preserves strict output", (t) => {
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
    assert.equal(planned.planning, 1);
    assert.ok(planned.collected >= 3);
    assert.ok(planned.constructions < baseline.constructions);
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
        assert.equal(planned.writes, 1);
        assert.equal(planned.collected, 1);
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
    assert.equal(planned.planning, 1);
    assert.equal(planned.dependent, 1);
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
    // Each statement declares only its own name: one plan collects the
    // remaining presence and absence demands without changing strict output.
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
    assert.equal(planned.planning, 1);
    assert.ok(planned.collected >= 3);
    assert.ok(planned.constructions < baseline.constructions);
    runGeneratedProgram(
        tools,
        "storage-demand-planner/absence-tags",
        planned.result.cpp,
    );
    // A rolled-back statement's write loses `seen`: the next statement
    // reading it ends discovery.
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
    assert.equal(countedPlanned.planning, 1);
    assert.equal(countedPlanned.dependent, 1);
    assert.equal(countedPlanned.collected, 1);
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
    // Each join ends a strict attempt; the plan goes on with a copy.
    assert.equal(baseline.constructions, 5);
    assert.equal(planned.planning, 1);
    assert.equal(planned.collected, 2);
    assert.equal(planned.constructions, 4);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "storage-demand-planner/record-joins",
        planned.result.cpp,
    );
});
