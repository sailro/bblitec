import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { TaaPostProcessLowerer } from "../src/lowering/taa-post-process-lowerer.js";
import { composeComposite } from "../src/pinned-post-process.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const request = { intrinsic: "createTaaPostProcessTask", hasTarget: true,
    options: { factor: 0.125, disableOnCameraMove: true } };

interface Target {
    _descriptor: { size: { width: number; height: number }; format: string };
    _width: number;
    _height: number;
    _eager?: boolean;
}
interface Child {
    updateUniforms(): void;
    record(): void;
    execute?: (() => number) | undefined;
}
interface Camera { worldMatrixVersion: number; fov: number; nearPlane: number; farPlane: number }
interface PinTask {
    factor: number;
    disableOnCameraMove: boolean;
    _factor: number;
    _firstUpdate: boolean;
    _lastCamVer: number;
    _haltonIndex: number;
    _blend: Child;
    _present: Child;
    _historyUpdate: Child;
    _history: Target;
    _temp: Target;
    execute(): number;
    record(): void;
}

test("TAA lowered lifecycle observes pinned pass order, failures and rebuild state", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const composite = await composeComposite(request);
    const header = new TaaPostProcessLowerer(new LoweringContext(), composite).header();
    const pin = await importPinnedModule<{
        createTaaPostProcessTask(config: object, engine: object, scene: object): PinTask;
    }>("post-process/taa.js");
    const source: Target = { _descriptor: { size: { width: 64, height: 32 }, format: "rgba16float" },
        _width: 64, _height: 32 };
    const sourceTask = { scene: { camera: null as Camera | null },
        _suData: new Float32Array(32), _sceneUBO: {} };
    const events: number[][] = [];
    let throwPhase = 0;
    let task: PinTask;
    const observe = (phase: number, result = 0) => {
        events.push([phase, +task._firstUpdate, task._lastCamVer, task._factor, task.factor, result]);
        if (phase === throwPhase) throw new Error(`phase ${phase}`);
    };
    task = pin.createTaaPostProcessTask({ sourceTexture: source, sourceRenderTask: sourceTask,
        targetTexture: source, ...request.options }, {
        scRT: source, _device: { queue: { writeBuffer: () => observe(6) } },
    }, {});
    // Only device boundaries are replaced. The actual pin performs the
    // execute/record branches, camera-key call and final jitter operation.
    task._blend.updateUniforms = () => observe(2);
    const children = [task._blend, task._present, task._historyUpdate];
    let worldVersion = 0;
    const cameras = [0, 1].map(() => ({ fov: 1, nearPlane: 0.1, farPlane: 100,
        get worldMatrixVersion() { observe(1); return worldVersion; } }));
    const steps = [
        ...[2, 3, 4, 5, 6].map((failure) =>
            ({ camera: 0, version: 4, factor: 0.125, disable: true, failure })),
        { camera: 0, version: 4, factor: 0.125, disable: true }, // first update
        { camera: 0, version: 4, factor: 0.375, disable: true }, // live public factor
        { camera: 1, version: 4, factor: 0.25, disable: true }, // different identity, equal pin key
        { camera: 1, version: 5, factor: 0.125, disable: true }, // camera reset
        { camera: 1, version: 6, factor: 0.375, disable: false },
        { camera: -1, version: 0, factor: 0.125, disable: true },
        { camera: -1, version: 0, factor: 0.25, disable: true, missing: 2 },
        ...[1, 2, 3, 4, 5, 6].flatMap((failure) => [
            { camera: 0, version: 10 + failure, factor: 0.125, disable: true, failure },
            { camera: 0, version: 10 + failure, factor: 0.375, disable: true },
        ]),
    ];
    const inputs: number[][] = [];
    for (const step of steps) {
        sourceTask.scene.camera = cameras[step.camera] ?? null;
        worldVersion = step.version;
        task.factor = step.factor;
        task.disableOnCameraMove = step.disable;
        throwPhase = "failure" in step ? step.failure ?? 0 : 0;
        const missing = "missing" in step ? step.missing ?? 0 : 0;
        children.forEach((child, index) => {
            child.execute = missing & (1 << index) ? undefined : () => { observe(3 + index); return 1 << index; };
        });
        try { observe(7, task.execute()); } catch { observe(8); }
        // Camera-key calculation belongs to the separate camera transport
        // fixture. This hook receives the value actually stored by the pin.
        inputs.push([step.camera, task._lastCamVer, step.factor, +step.disable, throwPhase, missing]);
    }
    assert.deepEqual(events.slice(0, 3).map((event) => event[0]), [1, 2, 8]);
    assert.equal(events[2]?.[1], 1, "a failed first upload preserves the first-update reset");
    assert.equal(events.find((event) => event[0] === 7)?.[5], 7);
    // Rebuild resource callbacks can fail before the pinned reset stores.
    for (const target of [task._history, task._temp]) {
        target._eager = true; target._width = source._width; target._height = source._height;
    }
    children.forEach((child, index) => { child.record = () => observe(10 + index); });
    task._firstUpdate = false; task._haltonIndex = 42; task._lastCamVer = 88;
    const recordStates: number[][] = [];
    for (const failure of [11, 0]) {
        throwPhase = failure;
        try { task.record(); } catch { /* The pin owns stores before a failed child record. */ }
        recordStates.push([+task._firstUpdate, task._haltonIndex, task._lastCamVer, task._factor]);
    }
    assert.deepEqual(recordStates.map((state) => state.slice(0, 3)), [[0, 42, 88], [1, 0, -1]]);

    const output = resolve("artifacts/taa-post-process-lifecycle");
    mkdirSync(output, { recursive: true });
    const sourcePath = join(output, "check.cpp");
    const rows = (values: number[][]) => values.map((row) => `{${row.join(", ")}}`).join(",\n");
    writeFileSync(sourcePath, `#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
${header}
int main() {
    auto owner = std::make_shared<bbl::TaaPostProcessState>(
        bbl::upstream::create_taa_post_process_state(0.125, true));
    bbl::Engine engine;
    engine.frame_tasks.resize(1);
    engine.frame_tasks[0].post_process.taa = owner;
    engine.frame_tasks[0].post_process.passes.resize(3);
    engine.frame_tasks[0].post_process.passes[0].params = {1};
    engine.frame_tasks.resize(128);
    assert(engine.frame_tasks[0].post_process.taa == owner);
    auto& state = *owner;
    auto& factor = engine.frame_tasks[0].post_process.passes[0].params[0];
    auto independent = bbl::upstream::create_taa_post_process_state(0.625, false);
    std::vector<std::array<double, 6>> actual;
    int throw_phase = 0;
    const auto observe = [&](int phase, double result = 0) {
        actual.push_back({static_cast<double>(phase), static_cast<double>(state.first_update),
            state.last_camera_version, factor, state.factor, result});
        if (phase == throw_phase) throw std::runtime_error("device boundary");
    };
    const std::array<double, 6> inputs[] = {${rows(inputs)}};
    int cameras[] = {0, 1};
    for (const auto& input : inputs) {
        state.factor = input[2]; state.disable_on_camera_move = input[3] != 0;
        throw_phase = static_cast<int>(input[4]);
        int* camera = input[0] < 0 ? nullptr : &cameras[static_cast<int>(input[0])];
        try {
            const auto draws = bbl::upstream::execute_taa_post_process(state, factor, camera,
                [&](const int* current) { assert(current == camera); observe(1); return input[1]; },
                [&](std::uint32_t pass) { assert(pass == 0); observe(2); },
                [&](std::uint32_t pass) -> std::optional<double> {
                    if (static_cast<int>(input[5]) & (1 << pass)) return std::nullopt;
                    observe(3 + static_cast<int>(pass)); return static_cast<double>(1 << pass);
                },
                [&](bbl::TaaPostProcessState& current) { assert(&current == &state); observe(6); });
            observe(7, draws);
        } catch (const std::runtime_error&) { observe(8); }
    }
    state.first_update = false; state.halton_index = 42; state.last_camera_version = 88;
    std::vector<std::array<double, 4>> record_states;
    for (const int failure : {11, 0}) {
        throw_phase = failure;
        try {
            bbl::upstream::record_taa_post_process(state, [&] { observe(10); observe(11); observe(12); });
        } catch (const std::runtime_error&) {}
        record_states.push_back({static_cast<double>(state.first_update), state.halton_index,
            state.last_camera_version, factor});
    }
    const std::vector<std::array<double, 6>> expected = {${rows(events)}};
    const std::vector<std::array<double, 4>> expected_record_states = {${rows(recordStates)}};
    assert(actual == expected);
    assert(record_states == expected_record_states);
    assert(independent.factor == 0.625 && !independent.disable_on_camera_move);
    assert(independent.first_update && independent.last_camera_version == -1 && independent.halton_index == 0);
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", sourcePath]);
    execFileSync(executable);
});

class EditedStore extends UpstreamSourceStore {
    constructor(private readonly edit: (source: string) => string,
        private readonly editedModule = "src/post-process/taa.ts") { super(); }
    override getSourceFile(module: string): ts.SourceFile {
        return module === this.editedModule
            ? ts.createSourceFile(module, this.edit(super.getSource(module)), ts.ScriptTarget.Latest, true)
            : super.getSourceFile(module);
    }
}

test("TAA lifecycle consumes changed pinned reset arithmetic and refuses new device operations", async () => {
    const composite = await composeComposite(request);
    const header = (edit: (source: string) => string) =>
        new TaaPostProcessLowerer(new LoweringContext(new EditedStore(edit)), composite).header();
    assert.match(header((source) => source.replace("task._lastCamVer = -1;", "task._lastCamVer = -7;")),
        /state\.last_camera_version = \(-7\.0\)/);
    assert.throws(() => header((source) => source.replace("blend.updateUniforms();", "unknownDeviceOperation();")),
        /unknownDeviceOperation/);
    assert.throws(() => header((source) => source.replace("blend.record();", "blend.record(); unknownDeviceOperation();")),
        /TAA record resource prefix changed/);
    assert.throws(() => header((source) => source.replace("blend.updateUniforms();", "blend.updateUniforms(42);")),
        /TAA blend upload gained arguments/);
});

test("deferred post-process leaf draw counts come from the fully asserted pinned device body", async () => {
    const composite = await composeComposite(request);
    const header = (edit: (source: string) => string) => new TaaPostProcessLowerer(
        new LoweringContext(new EditedStore(edit, "src/frame-graph/post-process-task.ts")), composite).header();
    assert.match(header((source) => source), /post_process_leaf_draw_count\(\) \{ return 1.0; \}/);
    assert.match(header((source) => source.replace("return 1;", "return 2;")), /post_process_leaf_draw_count\(\) \{ return 2.0; \}/);
    assert.throws(() => header((source) => source.replace("pass.draw(3);", "pass.draw(6);")), /Deferred post-process leaf device operations/);
    assert.throws(() => header((source) => source.replace("pass.end();", "pass.end(); unknownOperation();")), /Deferred post-process leaf device operations/);
});
