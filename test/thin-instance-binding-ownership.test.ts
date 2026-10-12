import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { lowerMaterialPublication } from "../src/lowering/material-publication.js";
import { renderTaskShaderPacketOwnersCpp } from "../src/lowering/render-task-mesh-refresh.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { shaderUniformRecoveryPublication } from "../src/lowering/shader-uniforms.js";
import { lowerThinInstanceBindingCreation } from "../src/lowering/thin-instance-binding-update.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("thin material bindings retain source captures across overrides, refresh and recovery", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const context = new LoweringContext();
    const publication = lowerMaterialPublication(context, true);
    const tasks = new GeometryOutputLowerer(context).lowerTaskRecords(
        true,
    ).source;
    const renderer = new RendererLowerer(context).lowerRenderPlan({
        gpuInstancing: true,
    });
    assert.match(renderer.header, /ThinMaterialBindingOwner thin_binding/);
    assert.match(renderer.source, /item\.thin_binding = output->thin_binding/);
    assert.match(
        renderer.source,
        /overridden\.thin_binding = packet_owners\[entry_index\]\.thin_binding/,
    );
    runGeneratedProgram(
        native,
        "thin-instance-binding-ownership",
        `
#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream {
struct NodeAttribute { std::string_view name; };
struct NodeVariant { std::size_t first_attribute, attribute_count; bool uses_instance_index; };
constexpr std::array<NodeAttribute,3> node_variant_attributes{{{"world1"},{"world0"},{"position"}}};
constexpr std::array<NodeVariant,3> node_variants{{{0,1,false},{1,1,false},{2,1,true}}};
}
namespace bbl {
${lowerThinInstanceBindingCreation(context)}
${["bool source_material_draw_matches(", "bool source_standard_material_draw_matches(", "bool source_shader_material_draw_matches("].map((name) => cppFunction(publication, name)).join("\n")}
${cppFunction(publication, "SourceMaterialOutput capture_material_output(")}
${cppFunction(tasks, "static void initialize_render_task_shader_material(")}
${cppFunction(tasks, "static void initialize_refreshed_render_task_shader_materials(")}
${renderTaskShaderPacketOwnersCpp(context, true)}
void recover_bindings(Engine& engine) { ${shaderUniformRecoveryPublication(context, true)} }
}
int main() {
    using namespace bbl;
    Engine engine; engine.materials.resize(5); engine.meshes.resize(1);
    engine.materials[0].standard_material=true;
    for (unsigned index:{1u,2u}) { engine.materials[index].shader_material=true; engine.materials[index].shader_variant=index-1; }
    engine.materials[1].shader_thin_instance_colors=0.0;
    engine.materials[3].node_material=true; engine.materials[3].shader_variant=0;
    engine.materials[4].node_material=true; engine.materials[4].shader_variant=1;
    auto& mesh=engine.meshes[0]; mesh.material={0};
    const auto first_pool=std::make_shared<ThinInstancePoolData>();
    first_pool->colors=js::F32Array(0); mesh.thin_instances=first_pool;
    Scene scene; scene.engine=&engine; scene.state->source_material_publication=true;
    auto first=capture_material_output(scene,MeshHandle{0});
    assert(first->thin_binding->pool==first_pool);
    const auto second_pool=std::make_shared<ThinInstancePoolData>(); mesh.thin_instances=second_pool;
    auto second=capture_material_output(scene,MeshHandle{0});
    assert(first->thin_binding!=second->thin_binding && first->thin_binding->pool==first_pool);
    assert(second->thin_binding->pool==second_pool);
    assert(first->thin_binding->mesh_features!=second->thin_binding->mesh_features);
    assert(!create_thin_material_binding(engine,{0},{3})->node_requires_instances);
    assert(create_thin_material_binding(engine,{0},{4})->node_requires_instances);
    engine.materials[4].shader_variant=2;
    assert(create_thin_material_binding(engine,{0},{4})->node_requires_instances);
    FrameTaskRecord task; task.kind=FrameTaskKind::render; task.source_scene=scene.state;
    second_pool->colors=js::F32Array(0);
    task.render_meshes={{MeshHandle{0},MaterialHandle{1}},{MeshHandle{0},MaterialHandle{2}}};
    const auto initial=prepare_render_task_shader_packets(task,engine);
    assert(initial[0].thin_binding && initial[1].thin_binding && initial[0].thin_binding!=initial[1].thin_binding);
    assert(!initial[0].thin_binding->shader_has_color && initial[1].thin_binding->shader_has_color);
    engine.materials[1].shader_thin_instance_colors=1.0;
    assert(create_thin_material_binding(engine,{0},{1})->shader_has_color);
    assert(!initial[0].thin_binding->shader_has_color);
    assert(!initial[0].shader_packet && !initial[1].shader_packet);
    assert(!task.render_meshes[0].thin_binding);
    publish_render_task_shader_packets(task,initial);
    mesh.thin_instances=first_pool; ++scene.state->renderable_version;
    assert(prepare_render_task_shader_packets(task,engine)[0].thin_binding==initial[0].thin_binding);
    assert(task.render_meshes[0].thin_binding->pool==second_pool);
    task.render_mesh_refresh=true; task.render_meshes[0].follows_material=true;
    const auto refreshed=prepare_render_task_shader_packets(task,engine);
    assert(refreshed[0].thin_binding!=initial[0].thin_binding && refreshed[0].thin_binding->pool==first_pool);
    assert(refreshed[1].thin_binding==initial[1].thin_binding);
    assert(task.render_meshes[0].thin_binding==initial[0].thin_binding);
    publish_render_task_shader_packets(task,refreshed);
    mesh.thin_instances=second_pool;
    initialize_refreshed_render_task_shader_materials(engine,task);
    const auto eager=task.render_meshes[0].thin_binding;
    mesh.thin_instances=first_pool;
    const auto pending=prepare_render_task_shader_packets(task,engine);
    assert(pending[0].thin_binding==eager && eager->pool==second_pool);
    publish_render_task_shader_packets(task,pending);
    scene.state->material_outputs={first}; engine.frame_tasks.push_back(std::move(task)); scene.tasks.push_back({0});
    engine.rendering_contexts.push_back("scene",std::make_shared<Scene>(scene));
    const auto retained_scene=first->thin_binding, retained_task=engine.frame_tasks[0].render_meshes[0].thin_binding;
    mesh.thin_instances=second_pool;
    second_pool->colors=std::nullopt;
    recover_bindings(engine);
    assert(first->thin_binding==retained_scene && retained_scene->pool==second_pool);
    assert(retained_scene->mesh_features==second->thin_binding->mesh_features);
    assert(engine.frame_tasks[0].render_meshes[0].thin_binding==retained_task && retained_task->pool==second_pool);
}
`,
        {
            flags: ["/DBBLITE_GPU_INSTANCING=1", "/DBBLITE_NODE_VARIANTS=1"],
            expectedOutput: "",
        },
    );
});
