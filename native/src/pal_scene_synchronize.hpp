// A scene frame's synchronization, the one order both scene backends
// instantiate: sprite contexts, overlay and scene plans, the per-row mesh
// refresh, storage publication, the upload submit, the camera advance, the
// scene pass's camera and transparent sort, the renderables that read that
// camera, and the backend's own pass-block writes. The backend supplies the
// GPU operations; nothing here names an API.
#pragma once

#include <bblite/features/has_text.hpp>
#include <bblite/features/mesh_position_update.hpp>

#include <bblite/runtime.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <utility>
#include <vector>

#include "pal_camera_controls.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_vertex.hpp"
#include "pal_gpu_pipeline.hpp"
#include "pal_pass_camera.hpp"
#include "pal_runtime_trace.hpp"
#if BBLITE_HAS_TEXT
#include <bblite/text_gpu.hpp>
#include "pal_text_scene.hpp"
#endif

namespace bbl::pal {

/**
 * Reconcile one backend's uploaded mesh rows with a rebuilt render plan.
 *
 * Plans preserve scene order, so a forward scan moves surviving rows,
 * releases removed rows, and uploads only new rows. The GPU resource type and
 * its release/upload operations remain backend-owned.
 */
template <typename GpuMesh, typename ReleaseMesh, typename UploadItem>
inline std::vector<GpuMesh>
rematch_render_meshes(const std::vector<upstream::RenderItem>& previous_items,
                      const std::vector<upstream::RenderItem>& updated_items,
                      std::vector<GpuMesh>& uploaded_meshes, ReleaseMesh&& release_mesh,
                      UploadItem&& upload_item) {
    if (previous_items.size() != uploaded_meshes.size()) {
        throw std::runtime_error("Render plan and uploaded mesh rows are out of sync.");
    }
    // The whole mesh handle: a row uploaded for a retired mesh must not
    // survive into the mesh that reused its slot (and possibly its
    // geometry slot) before this rebuild.
    const auto same_source = [](const upstream::RenderItem& left,
                                const upstream::RenderItem& right) {
        return left.mesh == right.mesh && left.geometry == right.geometry &&
               left.material.value == right.material.value;
    };
    std::vector<GpuMesh> result;
    result.reserve(updated_items.size());
    std::size_t previous_index = 0;
    for (const upstream::RenderItem& item : updated_items) {
        std::size_t scan = previous_index;
        while (scan < previous_items.size() && !same_source(previous_items[scan], item)) {
            ++scan;
        }
        if (scan < previous_items.size()) {
            for (std::size_t dropped = previous_index; dropped < scan; ++dropped) {
                release_mesh(uploaded_meshes[dropped]);
            }
            result.push_back(std::move(uploaded_meshes[scan]));
            previous_index = scan + 1;
            continue;
        }
        result.push_back(upload_item(item));
    }
    for (std::size_t dropped = previous_index; dropped < uploaded_meshes.size(); ++dropped) {
        release_mesh(uploaded_meshes[dropped]);
    }
    return result;
}

/** Rebuild an existing overlay's rows before uploads/encoding, using backend-owned leases. */
template <typename GpuMesh, typename ReleaseMesh, typename UploadItem>
inline bool refresh_overlay_render_plans(Engine& engine, std::vector<upstream::RenderPlan>& plans,
                                         std::vector<std::vector<GpuMesh>>& meshes,
                                         std::vector<std::uint64_t>& versions,
                                         bool draw_lists_changed, ReleaseMesh&& release_mesh,
                                         UploadItem&& upload_item) {
    if (plans.size() != meshes.size() || plans.size() != versions.size() ||
        plans.size() + 1 != engine.registered_scenes.size()) {
        throw std::runtime_error("Overlay registration changed after renderer initialization.");
    }
    bool changed = false;
    for (std::size_t layer = 0; layer < plans.size(); ++layer) {
        Scene& scene = *engine.registered_scenes[layer + 1];
        if (scene.render_topology_version != versions[layer]) {
            reject_uncomposed_family_growth(scene.material_family_mask);
            upstream::RenderPlan updated = upstream::build_render_plan(scene, engine);
            validate_render_plan_items(updated);
            meshes[layer] = rematch_render_meshes(plans[layer].items, updated.items, meshes[layer],
                                                  release_mesh, upload_item);
            plans[layer] = std::move(updated);
            versions[layer] = scene.render_topology_version;
            changed = true;
        } else if (draw_lists_changed) {
            plans[layer].draw_lists = upstream::build_render_draw_lists(plans[layer].items, engine);
            changed = true;
        }
    }
    return changed;
}

/**
 * One plan's per-frame row refresh over the meshes uploaded for it: the
 * thin-instance pool's re-upload (recreated when the pool grew past what was
 * allocated, which is also a full upload), the backend's per-mesh blocks, the
 * position-version gated vertex upload, and the morph weights. The vertex
 * buffers hold the geometry's local lanes, so a transform uploads nothing
 * here; it reaches the draw through the mesh block.
 *
 * `Rows` supplies the GPU writes: `recreate_instances(gpu, mesh)`,
 * `update_instances(gpu, mesh, count)`, `write_mesh_blocks(scene, item,
 * mesh, gpu)`, `upload_vertices(gpu, vertices)` and
 * `upload_morph_weights(gpu, geometry, mesh)`.
 */
template <class Mesh, class Rows>
void sync_plan_mesh_rows(const Scene& scene, Engine& engine, const upstream::RenderPlan& plan,
                         std::vector<Mesh>& meshes, Rows& rows) {
    for (std::size_t index = 0; index < plan.items.size() && index < meshes.size(); ++index) {
        const upstream::RenderItem& item = plan.items[index];
        const MeshRecord& mesh = handle_at(engine.meshes, item.mesh);
        Mesh& gpu = meshes[index];
#if BBLITE_GPU_INSTANCING
        if (mesh.thin_instanced && gpu.instance_version != mesh.instance_version) {
            // Nothing caches the instance buffers -- every pass reads the
            // row live at the draw -- so a shadow or depth task later this
            // frame binds the recreated ones. Slots past the active count
            // keep their previous contents and are never drawn.
            const bool recreated = thin_instance_pool_grew(mesh, gpu.instance_capacity);
            if (recreated) {
                rows.recreate_instances(gpu, mesh);
                gpu.instance_capacity = static_cast<std::uint32_t>(mesh.instance_matrices.size());
            }
            const std::size_t active_count = thin_instance_active_count(mesh);
            if (!recreated && active_count > 0)
                rows.update_instances(gpu, mesh, active_count);
            gpu.instance_count = static_cast<std::uint32_t>(active_count);
            gpu.instance_version = mesh.instance_version;
        }
#endif
        rows.write_mesh_blocks(scene, item, mesh, gpu);
#if BBLITE_MESH_POSITION_UPDATE
        const ModelGeometry& geometry = engine.geometries[item.geometry];
        if (gpu.position_version != geometry.position_version) {
            rows.upload_vertices(gpu, mesh_gpu_vertices(geometry, mesh));
            gpu.position_version = geometry.position_version;
        }
#endif
#if BBLITE_GPU_MORPH_STORAGE
        if (mesh.gpu_deformation)
            rows.upload_morph_weights(gpu, engine.geometries[item.geometry], mesh);
#endif
    }
}

#if BBLITE_HAS_TEXT
/**
 * The text scene's per-frame update over the scene pass, the same on both
 * backends: the retained bindings' scene checks, the capture's frame, then
 * the bindings' own updates through the pass camera and extent.
 */
template <class TextState>
void update_scene_text(TextState& text, const Scene& scene, long frame,
                       const PixelViewport& surface_extent, const PassCamera& pass) {
    validate_text_scene(scene);
    text.device->owner->capture.begin_frame(static_cast<std::uint64_t>(frame));
    text.scene.update_for_pass(pass.camera, pass.matrices.view_projection, pass.matrices.aspect,
                               static_cast<double>(surface_extent.width),
                               static_cast<double>(surface_extent.height));
}
#endif

/** The run state one scene frame synchronizes, by reference. */
template <class Mesh> struct SceneSyncState {
    Engine& engine;
    Scene& scene;
    long frame;
    double delta_ms;
    /** The surface the frame presents to. */
    std::uint32_t width;
    std::uint32_t height;
    upstream::RenderPlan& render_plan;
    std::vector<upstream::RenderPlan>& overlay_plans;
    std::vector<std::uint64_t>& overlay_topology_versions;
    std::vector<Mesh>& meshes;
    std::vector<std::vector<Mesh>>& overlay_meshes;
    std::uint64_t& synced_render_topology_version;
    std::uint64_t& synced_draw_list_epoch;
    std::uint32_t& synced_material_family_mask;
    CameraTraceState& camera_trace_state;
    /** Each pass's retained blocks; the scene pass keeps its view-projection here. */
    RetainedSceneBlocks& pass_blocks;
};

/** What synchronization settled for the frame's encode. */
struct SceneSyncOutcome {
    bool topology_updated = false;
    PixelViewport surface_extent{};
    /** The scene's own pass: its camera, null for a camera-less scene. */
    PassCamera pass{};
};

/**
 * Synchronize one scene frame, in the one order both backends run.
 *
 * `Backend` supplies the operations only it can perform, each named for the
 * step it serves: `update_sprites(delta_ms)`, `release_mesh(mesh)`,
 * `upload_mesh(item)`, `prune_shared_resources()`,
 * `reject_unbuilt_family_growth(families)`, `shared_shader_geometry_count()`,
 * `shared_shader_material_count()`, `rebuild_task_draw_lists()`,
 * `mesh_rows()` (the `sync_plan_mesh_rows` writes), `publish_storage()`,
 * `submit_uploads()`, `mark_uploaded()`, `settle_pass(outcome)` (the
 * frame's own copy of the pass, which the later steps and the encode read),
 * `stream_bone_palettes()`, `mark_capture(topology_updated)`,
 * `update_text(outcome)`,
 * `update_clustered_lights(outcome)`, `upload_billboards(outcome, delta_ms)`,
 * `upload_splats(outcome)`, `capture_render_state()` and
 * `write_pass_blocks(outcome)`.
 */
template <class Mesh, class Backend>
SceneSyncOutcome synchronize_scene(SceneSyncState<Mesh>& sync, Backend& backend) {
    Engine& engine = sync.engine;
    Scene& scene = sync.scene;
    SceneSyncOutcome outcome;
    trace_dynamic_frame(engine, sync.delta_ms, sync.frame);
    // The renderables' own clocks -- the sprite renderer's hooks, the sprite
    // and billboard FX -- read the engine's `_currentDelta`: a scene's
    // `fixedDeltaMs` steps its callbacks alone.
    const double renderable_delta_ms = engine.current_delta_ms;
    // `_update` for every sprite context precedes every `_record`.
    backend.update_sprites(renderable_delta_ms);
    const auto release = [&](Mesh& mesh) { backend.release_mesh(mesh); };
    const auto upload = [&](const upstream::RenderItem& item) { return backend.upload_mesh(item); };
    const bool draw_lists_moved = engine.draw_list_epoch != sync.synced_draw_list_epoch;
    outcome.topology_updated = refresh_overlay_render_plans(
        engine, sync.overlay_plans, sync.overlay_meshes, sync.overlay_topology_versions,
        draw_lists_moved, release, upload);
    if (outcome.topology_updated)
        backend.prune_shared_resources();
    if (scene.render_topology_version != sync.synced_render_topology_version) {
        const std::size_t previous_item_count = sync.render_plan.items.size();
        const std::uint32_t added_families =
            scene.material_family_mask & ~sync.synced_material_family_mask;
        reject_uncomposed_family_growth(added_families);
        backend.reject_unbuilt_family_growth(added_families);
        upstream::RenderPlan updated_plan = upstream::build_render_plan(scene, engine);
        validate_render_plan_items(updated_plan);
        std::vector<Mesh> updated_meshes = rematch_render_meshes(
            sync.render_plan.items, updated_plan.items, sync.meshes, release, upload);
        backend.prune_shared_resources();
        sync.meshes = std::move(updated_meshes);
        sync.render_plan = std::move(updated_plan);
        sync.synced_render_topology_version = scene.render_topology_version;
        sync.synced_material_family_mask = scene.material_family_mask;
        const std::size_t shader_item_count = static_cast<std::size_t>(
            std::count_if(sync.render_plan.items.begin(), sync.render_plan.items.end(),
                          [](const upstream::RenderItem& item) {
                              return item.material_kind == upstream::RenderMaterialKind::shader;
                          }));
        trace_scene_topology(scene, engine, previous_item_count, sync.render_plan.items.size(),
                             shader_item_count, backend.shared_shader_geometry_count(),
                             backend.shared_shader_material_count(), sync.frame);
        outcome.topology_updated = true;
    } else if (draw_lists_moved) {
        // The pin's visibility epoch re-records the cached opaque render
        // bundles; the draw lists are this port's bundles, so only they and
        // the task lists rebuild -- mesh GPU state is untouched.
        sync.render_plan.draw_lists =
            upstream::build_render_draw_lists(sync.render_plan.items, engine);
    }
    if (outcome.topology_updated || draw_lists_moved)
        backend.rebuild_task_draw_lists();
    sync.synced_draw_list_epoch = engine.draw_list_epoch;
    // After the rebuild: the previous plan can still list a mesh this frame
    // retired, whose slot a new mesh may already hold.
    auto& rows = backend.mesh_rows();
    sync_plan_mesh_rows(scene, engine, sync.render_plan, sync.meshes, rows);
    for (std::size_t layer = 0;
         layer < sync.overlay_plans.size() && layer < sync.overlay_meshes.size(); ++layer) {
        sync_plan_mesh_rows(*engine.registered_scenes[layer + 1u], engine,
                            sync.overlay_plans[layer], sync.overlay_meshes[layer], rows);
    }
    // RAF callbacks write ShaderMaterial storage: publish it with the
    // frame's other uploads, before anything binds it.
    backend.publish_storage();
    backend.submit_uploads();
    backend.mark_uploaded();
    // The cameras' control hooks, then the scene pass's own camera.
    update_surface_cameras(engine, scene_camera(engine, scene));
    CameraRecord* camera = scene_pass_camera(engine, scene);
    trace_camera_state(camera, sync.camera_trace_state, sync.frame);
    upstream::sort_transparent_draws(sync.render_plan.draw_lists.transparent, engine, camera);
    // The frame's product and its two factors, built once: a shader
    // material may declare either factor beside the product, the splat UBO
    // stores them separately, and the billboard sort reads the view. The
    // product is the one the scene pass's block keeps (`keep_view_projection`).
    outcome.surface_extent = scene_surface_extent(engine, scene, sync.width, sync.height);
    outcome.pass =
        build_kept_pass_camera(scene, engine, camera, outcome.surface_extent.width,
                               outcome.surface_extent.height, sync.pass_blocks.scene(scene));
    backend.settle_pass(outcome);
    backend.stream_bone_palettes();
    backend.mark_capture(outcome.topology_updated);
    // The renderables that read the pass camera, in the pin's own order:
    // `prepareRenderTaskPass` runs the clustered updater before the
    // bindings' own updates.
    backend.update_clustered_lights(outcome);
    backend.update_text(outcome);
    backend.upload_billboards(outcome, renderable_delta_ms);
    backend.upload_splats(outcome);
    backend.capture_render_state();
    backend.write_pass_blocks(outcome);
    return outcome;
}

} // namespace bbl::pal
