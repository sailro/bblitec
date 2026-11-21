import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { EffectLowerer } from "../src/lowering/effect-lowerer.js";
import { lowerFrameGraphTaskBuild } from "../src/lowering/frame-graph-task-build.js";
import { lowerSceneDisposalCallbacks } from "../src/lowering/scene-disposal.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { pinnedEffectVariantsHeader } from "../src/pinned-effect-cpp.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const prefix = `
import { createEngine, createSceneContext, createRenderTarget, createEffectWrapper,
createEffectRenderTask, addTask, buildFrameGraphTask, getFrameGraph, disposeScene,
registerScene, type Task } from "@babylonjs/lite";
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine, { defaultRenderTask: false });
const effect = createEffectWrapper(engine, { name: "flat",
    fragmentWGSL: "@fragment fn effectFragment()->@location(0) vec4<f32>{return vec4<f32>(1.0);}" });
const target = createRenderTarget({ lbl: "output", format: "rgba8unorm", samples: 1, size: { width: 4, height: 4 } });
const task = createEffectRenderTask({ name: "flat", effect, target }, engine, scene);
`;

const wrapped = `
let events = "";
function install(task: Task): (() => void) & { dispose(): void } {
    let calls = 0;
    const refresh = (): void => { calls++; events += "r" + calls; };
    const record = task.record.bind(task);
    task.record = (): void => { refresh(); record(); events += "R"; };
    const stop = (): void => { events += "s"; };
    const dispose = task.dispose.bind(task);
    task.dispose = (): void => {
        events += "d";
        try { dispose(); events += "D"; } finally { stop(); }
    };
    return Object.assign(refresh, { dispose: stop });
}
// Nullable base-interface storage is the regression, not the shader or scene.
const selected: Task | null = Math.random() < 2 ? task : null;
if (selected) {
    const binding = install(selected);
    addTask(scene, selected);
    buildFrameGraphTask(getFrameGraph(scene), task);
    buildFrameGraphTask(getFrameGraph(scene), task);
    if (events !== "r1Rr2R") throw new Error("record order " + events);
    task.dispose();
    if (events !== "r1Rr2RdDs") throw new Error("dispose order " + events);
    disposeScene(scene);
    if (events !== "r1Rr2RdDsdDs") throw new Error("scene disposal " + events);
    binding.dispose();
    if (events !== "r1Rr2RdDsdDss") throw new Error("returned closure " + events);
    const failed = task.dispose.bind(task);
    task.dispose = (): void => { failed(); throw new Error("release"); };
    install(task);
    let caught = false;
    try { task.dispose(); } catch (error) { caught = true; }
    if (!caught || !events.endsWith("ddDss")) throw new Error("finally on failure " + events);
}
`;

test("effect task wrappers survive nullable Task storage and reject other method writes", () => {
    const compiled = compileSource(prefix + wrapped);
    assert.ok(
        compiled.manifest.features.includes("frame-graph:task-method-slots"),
    );
    assert.equal(compiled.manifest.deferredCapabilities?.length ?? 0, 0);
    for (const assignment of [
        "task.record = () => {};",
        "task.dispose = () => {};",
        "task.record = async () => { record(); };",
        "task.record = function() { record(); };",
        "task.record = () => { (() => record()); };",
        "task.record = () => { dispose(); };",
    ])
        assert.throws(
            () =>
                compileSource(
                    prefix +
                        `const record = task.record.bind(task);
                const dispose = task.dispose.bind(task); ${assignment}`,
                ),
            /replacement requires a synchronous zero-argument arrow/,
        );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    `task.execute = () => 0; addTask(scene, task); await registerScene(scene);`,
            ),
        /Unsupported|unsupported/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    `const record = task.record.bind(scene);
                task.record = () => { record(); };`,
            ),
        /replacement requires a synchronous zero-argument arrow/,
    );
    for (const assignment of [
        "task.record ||= () => {};",
        "task.dispose &&= () => {};",
        "const kept = (task.record ??= () => {}); kept();",
    ])
        assert.throws(
            () =>
                compileSource(
                    prefix +
                        assignment +
                        "addTask(scene, task); await registerScene(scene);",
                ),
            /Task method replacements require simple assignment/,
        );
});

test("the pin records on build, not execute, and disposes through the replaced method", async () => {
    interface Task {
        name: string;
        _passes: object[];
        record(): void;
        execute(): number;
        dispose(): void;
    }
    const pin = await importPinnedModule<{
        createFrameGraph(
            this: void,
            engine: object,
        ): {
            _tasks: Task[];
            build(): void;
            execute(): number;
            dispose(): void;
        };
    }>("frame-graph/frame-graph.js");
    const events: string[] = [];
    const task: Task = {
        name: "probe",
        _passes: [],
        record: () => {
            events.push("record");
        },
        execute: () => {
            events.push("execute");
            return 1;
        },
        dispose: () => {
            events.push("dispose");
        },
    };
    const record = task.record.bind(task),
        dispose = task.dispose.bind(task);
    task.record = () => {
        events.push("before");
        record();
    };
    task.dispose = () => {
        try {
            dispose();
        } finally {
            events.push("stop");
        }
    };
    const graph = pin.createFrameGraph({});
    graph._tasks.push(task);
    graph.build();
    graph.execute();
    graph.execute();
    graph.build();
    graph.dispose();
    assert.deepEqual(events, [
        "before",
        "record",
        "execute",
        "execute",
        "before",
        "record",
        "dispose",
        "stop",
    ]);
});

test("generated effect task wrappers run before each build and release through scene disposal", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const compiled = compileSource(prefix + wrapped);
    const context = new LoweringContext();
    const factory = new EffectLowerer(context).lowerFactory({
        taskMethodSlots: true,
    }).source;
    const scene = new SceneLowerer(context).lowerCore({
        taskMethodSlots: true,
        liveTaskAdd: true,
    }).source;
    const geometry = new GeometryOutputLowerer(context).lowerTaskRecords()
        .source;
    const variants = pinnedEffectVariantsHeader("fixture", [
        { family: "effect", name: "flat", fragment: "", bindings: [] },
        {
            family: "effect",
            name: "sample",
            fragment: "",
            bindings: [
                {
                    name: "input",
                    binding: 0,
                    kind: "texture",
                    uniformBytes: 0,
                    texture: -1,
                },
            ],
        },
    ]);
    const directory = resolve("artifacts/effect-task-methods");
    mkdirSync(join(directory, "include/bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "include/bblite/upstream/effect_variants.hpp"),
        variants.header,
    );
    runGeneratedProgram(
        tools,
        "effect-task-methods",
        `
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/upstream/effect_variants.hpp>
#include <cassert>
${variants.definitions}
${factory}
${new RenderTargetLowerer(context, { disposal: true }).lower().source}
namespace bbl {
${[
    "FrameTaskRecord& task_record(",
    "void add_task(Scene&",
    "void add_task_at_start(Scene&",
    "TaskHandle create_render_task(",
    "TaskHandle create_copy_to_texture_task(",
]
    .map((signature) => cppFunction(geometry, signature))
    .join("\n")}
${[
    "void require_scene_engine(",
    "Scene create_scene_context(Engine&",
    "void add_live_task(",
    "void unregister_scene(",
    "void erase_mesh_material_scene(",
    "bool unregister_mesh_material_scene(",
    "void retire_scene_shadow_states(",
]
    .map((signature) => cppFunction(scene, signature))
    .join("\n")}
${lowerSceneDisposalCallbacks(context)}
${cppFunction(scene, "void dispose_scene(")}
${lowerFrameGraphTaskBuild(context, "(void)scene; (void)task;", { effect: true }, true)}
Engine create_engine(EngineOptions options) { Engine engine; engine.options = options; return engine; }
}
#define main staged_entry
${compiled.cpp}
#undef main
int main() {
    assert(staged_entry() == 0);
    bbl::Engine engine;
    auto scene = bbl::create_scene_context(engine);
    const auto effect = bbl::create_effect_wrapper(engine, 1u);
    const auto target = bbl::create_render_target(engine, {});
    const auto task = bbl::create_effect_render_task(engine, {"sample", effect, target});
    bbl::add_task(scene, task);
    const auto original = bbl::effect_task_method(engine, task, false);
    bool refused = false;
    try { original(); } catch (const std::runtime_error&) { refused = true; }
    assert(refused); // A bound original must validate missing bindings even without taskBuild.
    int calls = 0;
    bbl::set_effect_task_method(engine, task, false, bbl::js::Callback<void()>([&] {
        ++calls;
        if (calls == 1)
            for (int index = 0; index < 100; ++index)
                (void)bbl::append_frame_task(engine, bbl::FrameTaskRecord{});
        bbl::set_effect_texture(engine, effect, "input", bbl::SolidTexture{});
        original();
    }));
    engine.frame_tasks[task.value].disposed = true;
    bbl::build_frame_graph_task(scene, task);
    assert(calls == 1 && !engine.frame_tasks[task.value].disposed &&
           engine.frame_tasks[task.value].record_state == bbl::FrameTaskRecordState::recorded);
    engine.rendering_contexts.push_back("scene", std::make_shared<bbl::Scene>(scene));
    bbl::rebuild_canvas_task_targets(engine);
    assert(calls == 2);
    const auto dispose = bbl::effect_task_method(engine, task, true);
    int stopped = 0;
    bbl::set_effect_task_method(engine, task, true, bbl::js::Callback<void()>([&] { dispose(); ++stopped; }));
    bbl::dispose_scene(scene);
    assert(stopped == 1 && engine.frame_tasks[task.value].disposed && engine.render_targets[target.value].retired);
    bbl::dispose_scene(scene);
    assert(stopped == 1);
    bbl::FrameTaskRecord other;
    other.kind = bbl::FrameTaskKind::copy;
    const auto wrong = bbl::append_frame_task(engine, std::move(other));
    refused = false;
    try { (void)bbl::effect_task_method(engine, wrong, false); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}
`,
        {
            flags: ["/Gy", `/I${join(directory, "include")}`],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});
