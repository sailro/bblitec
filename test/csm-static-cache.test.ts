import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { csmRefitLibrary } from "../src/lowering/csm-static-cache.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface PinCaster {
    worldMatrixVersion: number;
    thinInstances?: { _version: number };
}
interface PinGate {
    syncCasters(next: readonly PinCaster[]): void;
    isDynamic(caster: PinCaster): boolean;
    _lastRefitDriftOnly(): boolean;
    _lastDynamicChanged(): boolean;
    update(
        x: number,
        y: number,
        z: number,
        nowMs: number,
        cameraChanged: boolean,
        force: boolean,
        onPromote: (caster: PinCaster) => void,
        onDemote: (caster: PinCaster) => void,
    ): { refit: boolean; renderDynamic: boolean };
}
interface PinScheduler {
    arm(spread: boolean): void;
    pending(): boolean;
    take(): number[];
}

/** One frame of the script both sides run: who moves, where the light points, what else changed. */
interface ScriptFrame {
    moved: number[];
    light: [number, number, number];
    nowMs: number;
    cameraChanged: boolean;
    force: boolean;
    casters: number[];
}

function script(): ScriptFrame[] {
    const frames: ScriptFrame[] = [];
    for (let frame = 0; frame < 420; frame++) {
        const moved = [0];
        if (frame === 10 || frame === 260) moved.push(1);
        if (frame === 300) moved.push(2);
        // The light drifts in small steps (a drift refit every few frames
        // under a 0.01 rad threshold), and pauses between 140 and 220.
        const angle =
            frame < 140
                ? frame * 0.004
                : frame < 220
                  ? 0.56
                  : 0.56 + (frame - 220) * 0.004;
        frames.push({
            moved,
            light: [Math.sin(angle), -1, -Math.cos(angle)],
            nowMs: frame * 16,
            cameraChanged: frame === 50,
            force: frame === 70,
            casters: frame >= 150 && frame < 160 ? [0, 1] : [0, 1, 2, 3],
        });
    }
    return frames;
}

test("the CSM refit gate and static refit scheduler match the pin frame by frame", async (t) => {
    const { createCsmRefitGate, createCsmStaticRefitScheduler } =
        await importPinnedModule<{
            createCsmRefitGate(this: void, options: object): PinGate;
            createCsmStaticRefitScheduler(
                this: void,
                count: number,
                perFrame: number,
            ): PinScheduler;
        }>("shadow/csm-refit-gate.js");
    const frames = script();
    const casters: PinCaster[] = [0, 1, 2, 3].map((index) => ({
        worldMatrixVersion: index,
        ...(index === 3 ? { thinInstances: { _version: 2.7 } } : {}),
    }));
    const gate = createCsmRefitGate({
        refitAngle: 0.01,
        refitMaxIntervalMs: 1000,
    });
    const scheduler = createCsmStaticRefitScheduler(4, 1);
    let list: PinCaster[] = [];
    let listKey = "";
    const lines: string[] = [];
    for (const frame of frames) {
        for (const index of frame.moved) casters[index]!.worldMatrixVersion++;
        const key = frame.casters.join(",");
        if (key !== listKey) {
            list = frame.casters.map((index) => casters[index]!);
            listKey = key;
        }
        gate.syncCasters(list);
        const decision = gate.update(
            ...frame.light,
            frame.nowMs,
            frame.cameraChanged,
            frame.force,
            () => {},
            () => {},
        );
        if (decision.refit)
            scheduler.arm(gate._lastRefitDriftOnly() && !scheduler.pending());
        const taken = scheduler.pending() ? scheduler.take().join("") : "-";
        lines.push(
            `${+decision.refit}${+decision.renderDynamic}${+gate._lastRefitDriftOnly()}${+gate._lastDynamicChanged()}:${casters.map((caster) => +gate.isDynamic(caster)).join("")}:${taken}`,
        );
    }
    // Every arm is exercised: the first refit publishes every cascade at
    // once, a drift refit spreads them one per frame, quiet casters demote
    // on a refit, a moved static caster promotes, and a re-supplied caster
    // set re-enters dynamic.
    const joined = lines.join("|");
    for (const reached of [
        "1101:1111:0123",
        "1111:1111:0",
        "1101:1000:2301",
        "1101:1011:2301",
        "1101:1111:3012",
        "0101:1011:-",
    ])
        assert.ok(lines.includes(reached), reached);

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const cpp = (values: readonly (number | boolean)[]): string =>
        values
            .map((value) =>
                typeof value === "boolean" ? String(value) : String(value),
            )
            .join(", ");
    const library = csmRefitLibrary(new LoweringContext());
    runGeneratedProgram(
        tools,
        "csm-static-cache/refit-gate",
        `#include <bblite/runtime.hpp>
${library.includes.map((header) => `#include <${header}>`).join("\n")}
#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
${library.source}
using namespace bbl;
struct Frame { std::vector<int> moved; double x, y, z, now; bool camera, force; std::vector<int> casters; };
int main() {
    Engine engine;
    engine.meshes.resize(4);
    for (std::size_t index = 0; index < 4; ++index) engine.meshes[index].transform_version = index;
    engine.meshes[3].thin_instances = std::make_shared<ThinInstancePoolData>();
    engine.meshes[3].thin_instances->version = 2.7;
    const std::vector<Frame> frames = {
${frames.map((frame) => `        {{${cpp(frame.moved)}}, ${frame.light.map((v) => v.toPrecision(17)).join(", ")}, ${frame.nowMs}, ${frame.cameraChanged}, ${frame.force}, {${cpp(frame.casters)}}}`).join(",\n")}
    };
    ShadowGeneratorRecord generator;
    CsmStaticCacheState cache;
    cache.refit_angle = 0.01;
    cache.refit_max_interval_ms = 1000;
    cache.static_cascades_per_frame = 1;
    upstream::csm_refit_start(engine, cache, generator, 4);
    CsmRefitRuntime& refit = *upstream::csm_refit_runtime(cache);
    std::string key, out;
    for (const Frame& frame : frames) {
        for (const int index : frame.moved) ++engine.meshes[index].transform_version;
        std::string next;
        for (const int index : frame.casters) next += std::to_string(index) + ",";
        if (next != key) {
            generator.caster_meshes.clear();
            for (const int index : frame.casters) generator.caster_meshes.push_back(MeshHandle{static_cast<std::uint32_t>(index)});
            ++generator.caster_list_version;
            key = next;
        }
        upstream::csm_refit_sync(engine, refit, generator);
        const auto decision = refit.gate->update(frame.x, frame.y, frame.z, frame.now, frame.camera, frame.force, refit.on_move, refit.on_move);
        if (decision.refit) refit.scheduler->arm(refit.gate->last_refit_drift_only() && !refit.scheduler->pending());
        std::string taken = "-";
        if (refit.scheduler->pending()) {
            taken.clear();
            for (const double cascade : refit.scheduler->take()) taken += std::to_string(static_cast<int>(cascade));
        }
        std::string dynamic;
        for (std::uint32_t index = 0; index < 4; ++index) dynamic += upstream::csm_refit_is_dynamic(engine, cache, MeshHandle{index}) ? "1" : "0";
        out += std::string(out.empty() ? "" : "|") + (decision.refit ? "1" : "0") + (decision.render_dynamic ? "1" : "0") +
               (refit.gate->last_refit_drift_only() ? "1" : "0") + (refit.gate->last_dynamic_changed() ? "1" : "0") + ":" + dynamic + ":" + taken;
    }
    std::cout << out;
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 20000,
            expectedOutput: joined,
        },
    );
});

test("enableCsmStaticCache lowers in a scene and refuses an unawaited call", () => {
    const prefix = `import {createEngine,createSceneContext,createFreeCamera,createTorusKnot,addToScene,createDirectionalLight,
createCsmDirectionalShadowGenerator,setShadowTaskCasterMeshes,registerSceneWithShadowSupport,enableCsmStaticCache,
createStandardMaterial} from "@babylonjs/lite";
const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene=createSceneContext(engine);
scene.camera=createFreeCamera([0,10,-20],[0,0,0]);
const light=createDirectionalLight([0,-1,-1],1);
addToScene(scene,light);
const knot=createTorusKnot(engine,{radius:2,tube:0.5});
knot.material=createStandardMaterial();
addToScene(scene,knot);
const sg=createCsmDirectionalShadowGenerator(engine,light,{numCascades:2});
light.shadowGenerator=sg;
setShadowTaskCasterMeshes(sg,[knot]);
`;
    const result = compileSource(
        `${prefix}await enableCsmStaticCache(engine,sg,{refitAngle:0.01,staticCascadesPerFrame:1});
await registerSceneWithShadowSupport(scene);`,
    );
    assert.equal(result.manifest.deferredCapabilities?.length ?? 0, 0);
    assert.ok(result.manifest.features.includes("shadow:csm-static-cache"));
    assert.match(
        result.cpp,
        /bbl::enable_csm_static_cache\(v_engine, v_sg, 0\.01, std::nullopt, std::optional<double>\{1\.0\}, false\)/,
    );
    assert.throws(
        () =>
            compileSource(
                `${prefix}void enableCsmStaticCache(engine,sg,{refitAngle:0.01});`,
            ),
        /awaits enableCsmStaticCache directly/,
    );
});
