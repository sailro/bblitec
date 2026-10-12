import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { renderTaskShaderPacketOwnersCpp } from "../src/lowering/render-task-mesh-refresh.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("explicit shader packets retain source ownership and publish refreshed replacements atomically", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    runGeneratedProgram(
        tools,
        "shader-packet-ownership",
        `#include <bblite/runtime.hpp>
#include <cassert>
int shader_snapshots = 0, shader_packets = 0;
namespace bbl {
${renderTaskShaderPacketOwnersCpp(new LoweringContext())}
}
int main() {
    using namespace bbl;
    Engine engine;
    engine.materials.resize(1);
    engine.meshes.resize(2);
    engine.meshes[0].material = {0};
    engine.materials[0].shader_uniform_snapshot = [](const MaterialRecord& material) -> const std::vector<float>& {
        ++shader_snapshots; return material.shader_uniform_values;
    };
    engine.materials[0].shader_packet_initialize = [](const Scene&, const MaterialRecord&) {
        assert(shader_snapshots == shader_packets + 1); ++shader_packets;
    };
    FrameTaskRecord task;
    task.source_scene = std::make_shared<SceneState>();
    task.source_scene->engine = &engine;
    task.render_meshes.resize(2);
    task.render_meshes[0].mesh = {0};
    // Registration constructs tracked shader renderables and stamps the source version.
    task.render_mesh_refresh = true;
    task.render_meshes[0].follows_material = true;
    task.render_meshes[0].shader_packet = std::make_shared<std::shared_ptr<ShaderPacketSystemState>>();
    task.shader_packet_scene_version = static_cast<double>(task.source_scene->renderable_version);
    const auto first = prepare_render_task_shader_packets(task);
    assert(first[0] && first[1] && first[0] != first[1]);
    assert(task.render_meshes[0].shader_packet == first[0]);
    assert(!task.render_meshes[1].shader_packet);
    publish_render_task_shader_packets(task, first);
    assert(shader_packets == 0);
    task.render_mesh_refresh = false;
    ++task.source_scene->renderable_version;
    assert(prepare_render_task_shader_packets(task) == first);
    task.render_mesh_refresh = true;
    task.render_meshes[0].follows_material = true;
    const auto replacement = prepare_render_task_shader_packets(task);
    assert(shader_packets == 1);
    assert(replacement[0] != first[0] && replacement[1] == first[1]);
    assert(task.render_meshes[0].shader_packet == first[0]);
    publish_render_task_shader_packets(task, replacement);
    assert(prepare_render_task_shader_packets(task) == replacement);
    assert(shader_packets == 1);
    task.render_meshes_dirty = true;
    const auto dirty = prepare_render_task_shader_packets(task);
    assert(shader_packets == 2);
    assert(dirty[0] != replacement[0] && dirty[1] == replacement[1]);
    publish_render_task_shader_packets(task, dirty);
    task.render_meshes_dirty = false;
    task.shader_packet_rebuild_pending = true;
    const auto requested = prepare_render_task_shader_packets(task);
    assert(shader_packets == 2);
    assert(requested[0] != dirty[0] && requested[1] == dirty[1]);
    publish_render_task_shader_packets(task, requested);
    assert(!task.shader_packet_rebuild_pending);
    assert(prepare_render_task_shader_packets(task) == requested);
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});
