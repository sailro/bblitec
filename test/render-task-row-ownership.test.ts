import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedSurfaceHeader } from "../src/lowering/pinned-surface.js";
import { renderTaskShaderPacketOwnersCpp } from "../src/lowering/render-task-mesh-refresh.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { renderTaskRemovalHeader } from "../src/lowering/render-task-removal.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { lowerThinInstanceBindingCreation } from "../src/lowering/thin-instance-binding-update.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface OracleMesh {
    id: number;
}
interface OracleMaterial {
    id: number;
    _buildGroup: object;
}
interface OracleResources {
    _lifetimeDisposers: Array<() => void>;
}
interface OracleRenderable {
    mesh: OracleMesh;
    material: OracleMaterial;
    packet: object;
    _lifetimeDisposers?: Array<() => void>;
}
interface OracleScene {
    meshes: OracleMesh[];
    _renderables: OracleRenderable[];
    _groups: Map<
        object,
        {
            r(
                scene: OracleScene,
                mesh: OracleMesh,
                material: OracleMaterial,
                resources: OracleResources,
            ): OracleRenderable;
        }
    >;
}
interface OraclePopulation {
    scene: OracleScene;
    _renderables: OracleRenderable[];
    _pendingMeshes: Array<{ mesh: OracleMesh; material: OracleMaterial }>;
}

async function pinnedTaskOwnership() {
    const { resolvePendingTaskMeshes } = await importPinnedModule<{
        resolvePendingTaskMeshes(
            this: void,
            population: OraclePopulation,
        ): OracleResources[];
    }>("frame-graph/render-task-transaction.js");
    const builder = {};
    const ordinary = { id: 0 },
        taskOnly = { id: 1 },
        added = { id: 2 };
    const firstMaterial = { id: 1, _buildGroup: builder },
        secondMaterial = { id: 2, _buildGroup: builder };
    const scene: OracleScene = {
        meshes: [ordinary],
        _renderables: [],
        _groups: new Map([
            [
                builder,
                {
                    r(_scene, mesh, material) {
                        return { mesh, material, packet: {} };
                    },
                },
            ],
        ]),
    };
    const first: OraclePopulation = {
        scene,
        _renderables: [],
        _pendingMeshes: [{ mesh: taskOnly, material: firstMaterial }],
    };
    const second: OraclePopulation = {
        scene,
        _renderables: [],
        _pendingMeshes: [{ mesh: taskOnly, material: secondMaterial }],
    };
    const firstResources = resolvePendingTaskMeshes(first);
    const secondResources = resolvePendingTaskMeshes(second);
    assert.equal(first._renderables[0]?.mesh, taskOnly);
    assert.equal(first._renderables[0]?.material, firstMaterial);
    assert.equal(second._renderables[0]?.material, secondMaterial);
    assert.notEqual(firstResources[0], secondResources[0]);
    assert.notEqual(
        first._renderables[0]?.packet,
        second._renderables[0]?.packet,
    );
    const retained = first._renderables[0];
    first._pendingMeshes.push({ mesh: added, material: firstMaterial });
    resolvePendingTaskMeshes(first);
    assert.equal(first._renderables[0], retained);
    assert.deepEqual(scene.meshes, [ordinary]);
    assert.deepEqual(scene._renderables, []);
    assert.deepEqual(first._pendingMeshes, []);
    return {
        firstMeshes: first._renderables.map((entry) => entry.mesh.id),
        secondMeshes: second._renderables.map((entry) => entry.mesh.id),
        sceneMeshes: scene.meshes.map((entry) => entry.id),
    };
}

test("pinned explicit task construction owns meshes outside scene membership", async () => {
    assert.deepEqual(await pinnedTaskOwnership(), {
        firstMeshes: [1, 2],
        secondMeshes: [1],
        sceneMeshes: [0],
    });
});

test("task-only rows preserve scene membership, packet owners and surviving GPU leases", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const oracle = await pinnedTaskOwnership();
    const context = new LoweringContext();
    const compiled = compileSource(`
import {createEngine,createShaderMaterial} from '@babylonjs/lite';
const engine=await createEngine(document.createElement('canvas'));
const material=createShaderMaterial({name:'task-owner',attributes:['position'],uniforms:[],
vertexSource:'struct VertexOutput{@builtin(position) position:vec4f};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=vec4f(input.position,1.0);return out;}',
fragmentSource:'@fragment fn mainFragment()->@location(0) vec4f{return vec4f(1.0);}'});
`);
    const renderer = new RendererLowerer(context).lowerRenderPlan({
        gpuInstancing: true,
        picking: true,
        shaderPrograms: compiled.manifest.customShaderPrograms,
    });
    const directory = resolve("artifacts/render-task-row-ownership");
    const include = join(directory, "include/bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(join(include, "renderer_plan.hpp"), renderer.header);
    writeFileSync(
        join(include, "pinned_surface.hpp"),
        pinnedSurfaceHeader(context),
    );
    writeFileSync(
        join(include, "camera_math.hpp"),
        new CameraLowerer(context).lowerArcRotateFactory().header,
    );
    const synchronize = readFileSync(
        "native/src/pal_scene_synchronize.hpp",
        "utf8",
    );
    const picking = readFileSync("native/src/pal_gpu_picking.hpp", "utf8");
    const shared = readFileSync("native/src/pal_gpu_shared.cpp", "utf8");
    const sceneCore = new SceneLowerer(context).lowerCore().source;
    const renderFunctions = [
        "std::uint32_t shader_variant_count(",
        "const ShaderVariantInfo& shader_variant_info(",
        "RenderItem bind_render_item(",
        "bool mesh_draws(",
        "bool render_item_material_draws(",
        "bool pick_candidate(",
        "RenderPipelineKind render_pipeline_kind(",
        "void append_draw(",
        "void order_draw_lists(",
        "double default_render_order(",
        "RenderDrawLists build_render_draw_lists(",
    ];
    runGeneratedProgram(
        tools,
        "render-task-row-ownership",
        `#include <bblite/upstream/renderer_plan.hpp>
#include <algorithm>
#include <cassert>
#include <span>
#include <utility>
namespace bbl {
${lowerThinInstanceBindingCreation(context)}
${lowerMeshMaterialSetter(context)}
${cppFunction(renderTaskRemovalHeader(context), "inline void remove_mesh_from_render_task(")}
${["void require_scene_engine(", "void mark_mesh_dirty(", "void erase_first_mesh(", "void clear_mesh_parent(", "bool remove_mesh_from_scene_tasks(", "void remove_from_scene(Scene& scene, MeshHandle"].map((signature) => cppFunction(sceneCore, signature)).join("\n")}
}
namespace bbl::upstream {
${renderFunctions.map((signature) => cppFunction(renderer.source, signature)).join("\n")}
${renderTaskShaderPacketOwnersCpp(context, true)}
${cppFunction(renderer.source, "RenderDrawLists build_render_task_draw_lists(")}
${cppFunction(renderer.source, "RenderPlan build_render_plan(")}
// Picking's world transport is irrelevant to candidate membership.
std::array<float,16> mesh_world_matrix(const Engine&,const MeshRecord&) { return {}; }
}
namespace bbl::pal {
${cppFunction(shared, "void validate_render_plan_items(")}
${cppFunction(synchronize, "inline bool same_render_mesh_source(")}
template<class GpuMesh,class ReleaseMesh,class UploadItem>
${cppFunction(synchronize, "inline std::vector<GpuMesh> rematch_render_meshes(")}
template<class GpuMesh,class ReleaseMesh,class UploadItem>
${cppFunction(synchronize, "inline bool rebuild_render_plan_meshes(")}
${["struct PickMeshUniforms", "struct PickRange", "struct PickMeshCandidate"].map((signature) => cppRecord(picking, signature)).join("\n")}
template<class HasGeometry>
${cppFunction(picking, "inline std::vector<PickMeshCandidate> collect_pick_mesh_candidates(")}
}
struct Row {
    std::shared_ptr<unsigned> lease;
    explicit Row(unsigned id):lease(std::make_shared<unsigned>(id)) {}
    Row(const Row&)=delete;
    Row& operator=(const Row&)=delete;
    Row(Row&&)=default;
    Row& operator=(Row&&)=default;
};
int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    Engine engine;
    engine.materials.resize(3);
    for (unsigned index: {1u,2u}) {
        auto& material=engine.materials[index];
        material.shader_material=true; material.shader_variant=0;
        material.shader_uniform_snapshot=[](const MaterialRecord& record)->const std::vector<float>& { return record.shader_uniform_values; };
    }
    engine.geometries.resize(3);
    engine.meshes.resize(3);
    for (unsigned index=0;index<3;++index) { engine.meshes[index].geometry=index; engine.meshes[index].material={0}; }
    // Explicit material overrides must work even when no mesh material exists.
    engine.meshes[1].material={};
    engine.meshes[2].material={};
    Scene scene; scene.engine=&engine; scene.meshes.push_back({0});
    engine.frame_tasks.resize(2);
    for (std::size_t index=0;index<2;++index) {
        auto& task=engine.frame_tasks[index];
        task.kind=FrameTaskKind::render; task.source_scene=scene.state;
        task.render.auto_mirror=false; task.render_recorded=true;
        task.render_meshes.push_back({MeshHandle{1},MaterialHandle{static_cast<std::uint32_t>(index+1)}});
        scene.tasks.push_back({static_cast<std::uint32_t>(index)});
    }
    auto plan=build_render_plan(scene,engine);
    assert(plan.items.size()==2 && plan.scene_items().size()==1);
    assert(plan.draw_lists.opaque.commands.size()==1);
    assert(plan.draw_lists.opaque.commands[0].item.mesh.value==0);
    auto first=build_render_task_draw_lists(plan,engine,engine.frame_tasks[0]);
    auto second=build_render_task_draw_lists(plan,engine,engine.frame_tasks[1]);
    assert(first.opaque.commands.size()==1 && second.opaque.commands.size()==1);
    const auto firstCommand=first.opaque.commands[0], secondCommand=second.opaque.commands[0];
    assert(firstCommand.item.mesh.value==1 && firstCommand.item.material.value==1);
    assert(secondCommand.item.mesh.value==1 && secondCommand.item.material.value==2);
    assert(firstCommand.item_index==secondCommand.item_index);
    assert(firstCommand.item.thin_binding && secondCommand.item.thin_binding);
    assert(firstCommand.item.thin_binding!=secondCommand.item.thin_binding);
    assert(firstCommand.item.shader_packet && secondCommand.item.shader_packet);
    assert(firstCommand.item.shader_packet!=secondCommand.item.shader_packet);
    FrameTaskRecord automatic; automatic.kind=FrameTaskKind::render; automatic.render.auto_mirror=true;
    FrameTaskRecord geometry; geometry.kind=FrameTaskKind::geometry;
    const auto checkSceneOnly=[&] {
        assert(scene.meshes.size()==${oracle.sceneMeshes.length} && scene.meshes[0].value==${oracle.sceneMeshes[0]});
        assert(scene.state->material_outputs.empty());
        for (const auto* task: {&automatic,&geometry}) {
            const auto draws=build_render_task_draw_lists(plan,engine,*task);
            assert(draws.opaque.commands.size()==1 && draws.opaque.commands[0].item.mesh.value==0);
        }
        std::vector<pal::PickRange> ranges; std::uint32_t next=1;
        const auto picks=pal::collect_pick_mesh_candidates(engine,scene,plan,plan.items.size(),[](std::size_t){return true;},ranges,next);
        assert(picks.size()==1 && ranges.size()==1 && ranges[0].index==0 && next==2);
    };
    checkSceneOnly();
    unsigned uploaded=0, released=0;
    const auto upload=[&](const RenderItem&){return Row(++uploaded);};
    const auto release=[&](Row& row){assert(row.lease); ++released;row.lease.reset();};
    std::vector<Row> rows;
    for (const auto& item:plan.items) rows.push_back(upload(item));
    const auto sceneLease=rows[0].lease, taskLease=rows[1].lease;
    // A source add after registration changes only the draw-list epoch.
    engine.frame_tasks[0].render_meshes.push_back({MeshHandle{2},MaterialHandle{1}});
    ++engine.draw_list_epoch;
    assert(pal::rebuild_render_plan_meshes(scene,engine,plan,rows,release,upload));
    assert(rows.size()==3 && uploaded==3 && released==0);
    assert(rows[0].lease==sceneLease && rows[1].lease==taskLease);
    first=build_render_task_draw_lists(plan,engine,engine.frame_tasks[0]);
    second=build_render_task_draw_lists(plan,engine,engine.frame_tasks[1]);
    assert(first.opaque.commands.size()==${oracle.firstMeshes.length});
    assert(first.opaque.commands[0].item.mesh.value==${oracle.firstMeshes[0]} && first.opaque.commands[1].item.mesh.value==${oracle.firstMeshes[1]});
    assert(second.opaque.commands.size()==${oracle.secondMeshes.length});
    assert(first.opaque.commands[0].item.shader_packet==firstCommand.item.shader_packet);
    assert(second.opaque.commands[0].item.shader_packet==secondCommand.item.shader_packet);
    checkSceneOnly();
    const auto addedLease=rows[2].lease;
    engine.meshes[1].visible=false; ++engine.draw_list_epoch;
    assert(!pal::rebuild_render_plan_meshes(scene,engine,plan,rows,release,upload));
    first=build_render_task_draw_lists(plan,engine,engine.frame_tasks[0]);
    assert(first.opaque.commands.size()==1 && first.opaque.commands[0].item.mesh.value==2);
    assert(first.opaque.binding_updates.size()==2);
    assert(uploaded==3 && released==0 && rows[0].lease==sceneLease && rows[1].lease==taskLease && rows[2].lease==addedLease);
    engine.meshes[1].visible=true; ++engine.draw_list_epoch;
    assert(!pal::rebuild_render_plan_meshes(scene,engine,plan,rows,release,upload));
    first=build_render_task_draw_lists(plan,engine,engine.frame_tasks[0]);
    assert(first.opaque.commands[0].item.shader_packet==firstCommand.item.shader_packet);
    assert(first.opaque.commands[0].item.thin_binding==firstCommand.item.thin_binding);
    checkSceneOnly();
    // Removing a mesh that was never in scene.meshes must still invalidate
    // native task rows before its slot or geometry can be reused.
    const auto topology=scene.render_topology_version;
    const auto epoch=engine.draw_list_epoch;
    remove_from_scene(scene,MeshHandle{2});
    assert(scene.render_topology_version==topology && engine.draw_list_epoch==epoch+1);
    assert(pal::rebuild_render_plan_meshes(scene,engine,plan,rows,release,upload));
    assert(rows.size()==2 && uploaded==3 && released==1);
    assert(rows[0].lease==sceneLease && rows[1].lease==taskLease);
    first=build_render_task_draw_lists(plan,engine,engine.frame_tasks[0]);
    assert(first.opaque.commands.size()==1 && first.opaque.commands[0].item.mesh.value==1);
    checkSceneOnly();
}
`,
        {
            flags: [
                `/I${join(directory, "include")}`,
                "/DBBLITE_GPU_INSTANCING=1",
                "/DBBLITE_DEFORM_PICKING=0",
                "/DBBLITE_VAT_PICKING=0",
                "/DBBLITE_NODE_VARIANTS=0",
                "/DBBLITE_STANDARD_VARIANTS=0",
            ],
            expectedOutput: "",
        },
    );
});
