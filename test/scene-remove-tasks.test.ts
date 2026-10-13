import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { renderTaskRemovalHeader } from "../src/lowering/render-task-removal.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface PinMesh {
    name: string;
    material: object;
    _gpu: object;
    parent: null;
    children: PinMesh[];
}
interface PinTask {
    _config: { autoMirror?: boolean };
    _pendingMeshes?: { mesh: PinMesh }[];
    _renderables: { mesh: PinMesh }[];
    _lastVersion: number;
    _prepareTaskMeshes?: (
        candidate: { _renderables: object[]; _pendingMeshes: object[] },
        commit: boolean,
    ) => void;
    record(): void;
}

test("removeFromScene keeps queued task requests and empties built entries, as the pin does", async (t) => {
    const { createRenderTask, addMeshToTask } = await importPinnedModule<{
        createRenderTask(
            this: void,
            config: object,
            engine: object,
            scene: object,
        ): PinTask;
        addMeshToTask(
            this: void,
            task: PinTask,
            mesh: PinMesh,
            options?: { material: object },
        ): void;
    }>("frame-graph/render-task.js");
    const { enableRenderTaskMeshRefresh } = await importPinnedModule<{
        enableRenderTaskMeshRefresh(this: void, task: PinTask): void;
    }>("frame-graph/render-task-mesh-refresh.js");
    const { removeFromScene } = await importPinnedModule<{
        removeFromScene(this: void, scene: object, mesh: PinMesh): void;
    }>("scene/scene-remove.js");
    const { registerMeshScene } = await importPinnedModule<{
        registerMeshScene(this: void, scene: object, mesh: PinMesh): void;
    }>("scene/mesh-scene-registry.js");
    const material = {
        _buildGroup: {
            _sceneIndependentRebuild: true,
            _rebuildSingle: (_scene: object, mesh: PinMesh) => {
                const renderable = {
                    mesh,
                    order: 0,
                    bind: () => ({ renderable, pipeline: {}, draw: () => 1 }),
                };
                return renderable;
            },
        },
    };
    const engine = {
        _device: {
            createBuffer: () => ({ destroy() {} }),
            createBindGroupLayout: () => ({}),
            createBindGroup: () => ({}),
            queue: { writeBuffer() {} },
        },
    };
    const tasks: PinTask[] = [];
    const scene = {
        meshes: [] as PinMesh[],
        lights: [],
        _renderables: [],
        _renderableVersion: 1,
        _meshDisposables: new Map(),
        _groups: new Map(),
        _materialSwapQueue: [],
        _disposables: [],
        _frameGraph: { _tasks: tasks },
    };
    const rt = {
        _descriptor: { format: "rgba8unorm", samples: 1 },
        _eager: true,
        _width: 4,
        _height: 4,
    };
    const mesh = (name: string): PinMesh => ({
        name,
        material,
        _gpu: {},
        parent: null,
        children: [],
    });
    const m1 = mesh("m1"),
        m2 = mesh("m2");
    // A second scene keeps m1, so this removal is not its disposal.
    registerMeshScene({ _materialSwapQueue: [] }, m1);
    registerMeshScene(scene, m1);
    scene.meshes.push(m1, m2);
    const task = (refresh: boolean, autoMirror?: boolean): PinTask => {
        const created = createRenderTask(
            { name: `t${tasks.length}`, rt, autoMirror },
            engine,
            scene,
        );
        if (refresh) enableRenderTaskMeshRefresh(created);
        tasks.push(created);
        return created;
    };
    const queued = task(false, false);
    addMeshToTask(queued, m1);
    addMeshToTask(queued, m2);
    const refreshed = task(true, false);
    addMeshToTask(refreshed, m1);
    addMeshToTask(refreshed, m1, { material });
    // An explicit task with the default mirroring: recording turns it off.
    const recorded = task(false);
    addMeshToTask(recorded, m1);
    addMeshToTask(recorded, m2);
    recorded.record();
    const refreshedRecorded = task(true, false);
    addMeshToTask(refreshedRecorded, m1);
    addMeshToTask(refreshedRecorded, m1, { material });
    addMeshToTask(refreshedRecorded, m2);
    refreshedRecorded.record();
    removeFromScene(scene, m1);
    const names = (list: readonly { mesh: PinMesh }[] | undefined): string =>
        (list ?? []).map((entry) => entry.mesh.name).join(" ");
    // The tracked requests the refreshed task's next transaction resolves.
    const candidate = {
        _renderables: [] as object[],
        _pendingMeshes: [] as { mesh: PinMesh }[],
    };
    refreshed._prepareTaskMeshes!(candidate, false);
    const expected = [
        `queued:${names(queued._pendingMeshes)}`,
        `tracked:${names(candidate._pendingMeshes)};pending:${names(refreshed._pendingMeshes)}`,
        `recorded:${names(recorded._renderables)};mirror:${String(recorded._config.autoMirror !== false)};version:${recorded._lastVersion}`,
        `refreshedRecorded:${names(refreshedRecorded._renderables)};version:${refreshedRecorded._lastVersion}`,
    ].join("|");

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const remove = cppFunction(
        new SceneLowerer(new LoweringContext()).lowerCore().source,
        "bool remove_mesh_from_scene_tasks(",
    );
    runGeneratedProgram(
        tools,
        "scene-remove-tasks",
        `#include <bblite/runtime.hpp>
#include <algorithm>
#include <iostream>
namespace bbl {
${cppFunction(renderTaskRemovalHeader(new LoweringContext()), "inline void remove_mesh_from_render_task(")}
${remove}
}
using namespace bbl;
int main() {
    Engine engine;
    Scene scene;
    scene.engine = &engine;
    const MeshHandle m1{0}, m2{1};
    const MaterialHandle own{0}, view{1};
    // Native explicit population: the queued request list, built in place
    // once registration records the task.
    const auto task = [&](bool mirror, bool refresh, bool recorded, std::vector<RenderTaskMesh> entries) {
        FrameTaskRecord record;
        record.render.auto_mirror = mirror;
        record.render_mesh_refresh = refresh;
        record.record_state = recorded ? FrameTaskRecordState::recorded : FrameTaskRecordState::queued;
        record.render_meshes = std::move(entries);
        if (recorded) record.shader_packet_scene_version = 1;
        engine.frame_tasks.push_back(std::move(record));
        scene.tasks.push_back(TaskHandle{static_cast<std::uint32_t>(engine.frame_tasks.size() - 1)});
    };
    task(false, false, false, {{m1, own}, {m2, own}});
    task(false, true, false, {{m1, own, true}, {m1, view}});
    task(true, false, true, {{m1, own}, {m2, own}});
    task(false, true, true, {{m1, own, true}, {m1, view}, {m2, own, true}});
    const auto epoch = engine.draw_list_epoch;
    remove_mesh_from_scene_tasks(engine, scene, m1);
    if (engine.draw_list_epoch == epoch) return 1;
    const char* names[] = {"m1", "m2"};
    const auto list = [&](std::size_t index, int follows) {
        std::string out;
        for (const auto& entry : engine.frame_tasks[index].render_meshes)
            if (follows < 0 || entry.follows_material == (follows == 1))
                out += std::string(out.empty() ? "" : " ") + names[entry.mesh.value];
        return out;
    };
    const auto& recorded = engine.frame_tasks[2];
    std::cout << "queued:" << list(0, -1) << "|tracked:" << list(1, 1) << ";pending:" << list(1, 0)
              << "|recorded:" << list(2, -1) << ";mirror:" << (recorded.render.auto_mirror ? "true" : "false")
              << ";version:" << recorded.shader_packet_scene_version << "|refreshedRecorded:" << list(3, -1)
              << ";version:" << engine.frame_tasks[3].shader_packet_scene_version;
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: expected,
        },
    );
});
