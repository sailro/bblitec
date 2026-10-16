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
    fixtureShaderProgram,
    reachedFixtureProgram,
} from "./shader-program-fixtures.js";
import {
    cppFunction,
    cppSection,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("thin material bindings retain source captures across overrides, refresh and recovery", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const context = new LoweringContext();
    const publication = lowerMaterialPublication(context, true);
    const tasks = new GeometryOutputLowerer(context).lowerTaskRecords({
        thinBindings: true,
    }).source;
    const renderer = new RendererLowerer(context).lowerRenderPlan({
        gpuInstancing: true,
        shaderPrograms: [
            {
                ...reachedFixtureProgram(fixtureShaderProgram("alpha-card")),
                runtimeInstanceLayoutCheck: true,
            },
        ],
    });
    assert.match(renderer.header, /ThinMaterialBindingOwner thin_binding/);
    assert.match(renderer.source, /item\.thin_binding = output->thin_binding/);
    assert.match(
        renderer.source,
        /overridden\.thin_binding = packet_owners\[entry_index\]\.thin_binding/,
    );
    assert.match(
        cppFunction(renderer.source, "void append_draw("),
        /\{\s*require_shader_instance_layout\(item, engine\);/,
    );
    assert.doesNotMatch(
        cppFunction(
            new RendererLowerer(context).lowerRenderPlan().source,
            "void append_draw(",
        ),
        /require_shader_instance_layout/,
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
${cppSection(renderer.header, "enum class RenderMaterialKind", "struct RenderDrawCommand")}
${cppSection(renderer.header, "enum class ShaderSystemMatrix", "std::uint32_t shader_variant_count()")}
const ShaderVariantInfo& shader_variant_info(std::uint32_t variant) {
    static const auto variants=[] {
        std::array<ShaderVariantInfo,4> result{};
        for (auto& info:result) { info.name="layout"; info.runtime_instance_layout_check=true; }
        result[1].thin_instances=true; result[1].thin_instance_color_option=0.0;
        result[2].thin_instances=true; result[2].instance_colors=true;
        result[3].runtime_instance_layout_check=false;
        return result;
    }();
    return variants.at(variant);
}
${cppFunction(renderer.header, "inline void require_shader_instance_layout(")}
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
void check_instance_layouts() {
    using namespace bbl;
    using namespace bbl::upstream;
    Engine engine; engine.materials.resize(3); engine.meshes.resize(1);
    for (auto& material:engine.materials) material.shader_material=true;
    engine.materials[1].shader_thin_instance_colors=0.0;
    RenderItem normal; normal.mesh={0}; normal.material_kind=RenderMaterialKind::shader;
    normal.thin_binding=create_thin_material_binding(engine,{0},{0});
    const auto check=[&](RenderItem item,std::uint32_t variant,bool accepted) {
        item.shader_variant=variant;
        bool refused=false;
        try { require_shader_instance_layout(item,engine); }
        catch (const std::runtime_error& error) {
            assert(std::string_view(error.what()).find("cannot draw with this thin-instance layout")!=std::string_view::npos);
            refused=true;
        }
        assert(refused!=accepted);
    };
    check(normal,0,true);
    const auto pool=std::make_shared<ThinInstancePoolData>();
    pool->colors=js::F32Array(0); engine.meshes[0].thin_instances=pool;
    RenderItem thin=normal; thin.thin_binding=create_thin_material_binding(engine,{0},{1});
    RenderItem colored=normal; colored.thin_binding=create_thin_material_binding(engine,{0},{2});
    assert(pool->count==0 && !thin.thin_binding->shader_has_color && colored.thin_binding->shader_has_color);
    check(thin,1,true); check(colored,2,true);
    check(thin,0,false); check(thin,2,false); check(colored,1,false); check(normal,1,false);
    // The captured empty owner and color selection survive later mesh/pool writes.
    check(normal,0,true);
    pool->colors=std::nullopt; engine.meshes[0].thin_instances.reset();
    check(thin,1,true); check(colored,2,true);
    RenderItem current=normal; current.thin_binding.reset();
    check(current,0,true); check(current,1,false); check(current,2,false);
    engine.meshes[0].thin_instances=std::make_shared<ThinInstancePoolData>();
    check(current,1,true); check(current,2,false); check(current,0,false);
    engine.meshes[0].thin_instances->colors=js::F32Array(0);
    check(current,1,true); check(current,2,true); check(current,3,true);
}
int main() {
    check_instance_layouts();
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
