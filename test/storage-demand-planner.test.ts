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
        new Proxy({},{});
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
