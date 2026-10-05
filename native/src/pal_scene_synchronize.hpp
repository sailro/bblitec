// A scene frame's synchronization, the one order both scene backends
// instantiate: sprite contexts, overlay and scene plans, the per-row mesh
// refresh, storage publication, the upload submit, the camera advance, the
// scene pass's camera and transparent sort, the renderables that read that
// camera, and the backend's own pass-block writes. The backend supplies the
// GPU operations; nothing here names an API.
#pragma once

#include <bblite/features/has_text.hpp>
#include <bblite/features/mesh_attribute_update.hpp>
#include <bblite/features/shader_external_textures.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/runtime.hpp>
#include <bblite/pal_iteration.hpp>
#include <bblite/pal_native_workers.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

#include "pal_camera_controls.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_vertex.hpp"
#include "pal_gpu_materials.hpp"
#include "pal_texture_upload_cache.hpp"
#include "pal_gpu_pipeline.hpp"
#include "pal_pass_camera.hpp"
#include "pal_runtime_trace.hpp"
#if BBLITE_HAS_TEXT
#include <bblite/text_gpu.hpp>
#include "pal_text_scene.hpp"
#endif

namespace bbl::pal {

/**
 * Jobs contain native GPU data only; their owner outlives this preparation.
 * They run as one piece of native work, yielding to the realm until it
 * finishes, or in place, between startup-budget yields, in worker-free
 * builds and when `native` is false. The first `advance` starts them, so a
 * caller can start several preparations before awaiting any.
 */
inline Iteration<bool> run_native_preparation(std::vector<std::function<void()>> jobs,
                                              [[maybe_unused]] bool native = true) {
#if BBLITE_WORKERS
    if (native && !jobs.empty()) {
        auto pending = start_native_work([jobs = std::move(jobs)] {
            for (const auto& create : jobs)
                create();
        });
        while (!pending.ready())
            co_yield false;
        pending.get();
        co_return true;
    }
#endif
    StartupWorkBudget budget;
    for (const auto& create : jobs) {
        create();
        if (budget.exhausted()) {
            co_yield false;
            budget.resume();
        }
    }
    co_return true;
}

/**
 * Setup's material images: every new one the `plans`' rows bind, decoded and
 * uploaded through `cache` as one piece of native work, so the rows' uploads
 * that follow find them there and never wait. The result holds the images
 * until those bindings acquire them; the cache holds none. Worker-free builds,
 * and `native` false, prepare nothing here: each row's upload then creates its
 * own.
 */
template <typename Resource, typename Prepare>
Iteration<std::vector<std::shared_ptr<Resource>>>
prepare_scene_textures(const Engine& engine, std::vector<const upstream::RenderPlan*> plans,
                       TextureUploadCache<Resource>& cache, Prepare prepare,
                       [[maybe_unused]] bool native = true) {
#if BBLITE_WORKERS
    struct Request {
        TextureData data;
        bool srgb{};
        std::array<std::uint8_t, 4> fallback{};
    };
    std::vector<Request> sources;
    const auto add = [&](const TextureData& data, bool srgb, std::array<std::uint8_t, 4> fallback) {
        if (!data.has_image() || data.gpu_source || data.render_source ||
            cache.find(data, srgb, fallback))
            return;
        if (std::none_of(sources.begin(), sources.end(), [&](const auto& other) {
                return other.srgb == srgb && other.fallback == fallback &&
                       same_texture_image(data, other.data);
            }))
            sources.push_back({data, srgb, fallback});
    };
    if (!native)
        plans.clear();
    for (const upstream::RenderPlan* plan : plans)
        for (const upstream::RenderItem& item : plan->items) {
            const auto* material = handle_find(engine.materials, item.material);
            if (!material)
                continue;
            const bool standard = item.material_kind == upstream::RenderMaterialKind::standard;
            if (standard || item.material_kind == upstream::RenderMaterialKind::pbr)
                for (const auto& slot : upstream::material_texture_slots)
                    if (slot.slot != upstream::material_texture_no_slot)
                        if (const auto* data =
                                material_slot_texture(*material, slot.source, standard))
                            add(*data, material_slot_srgb(data, slot.fallback, material, standard),
                                material_slot_fallback(slot.fallback, material, standard));
            if (material->shader_material || material->node_material)
                for (const auto& texture : material->shader_textures)
                    add(texture.data, texture.data.srgb, {255, 255, 255, 255});
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
            for (const auto& texture : material->plugin_textures)
                add(texture.data, texture.data.srgb, {255, 255, 255, 255});
#endif
        }
    if (!sources.empty()) {
        // Only native snapshots and GPU handles cross the thread boundary.
        auto pending =
            start_native_work([sources = std::move(sources), &cache, prepare = std::move(prepare)] {
                std::vector<std::shared_ptr<Resource>> images;
                images.reserve(sources.size());
                for (const auto& source : sources)
                    images.push_back(cache.acquire(source.data, source.srgb, source.fallback, [&] {
                        return prepare(source.data, source.srgb, source.fallback);
                    }));
                return images;
            });
        while (!pending.ready())
            co_yield false;
        co_return pending.get();
    }
#else
    static_cast<void>(engine);
    static_cast<void>(plans);
    static_cast<void>(cache);
    static_cast<void>(prepare);
#endif
    co_return {};
}

/**
 * Setup's mesh rows, in the order both scene backends run: the plans of the
 * overlay layers (every registered scene after the first, the pin's
 * `configureSwapchainOverlayScene` trigger; each owns a plan because a draw
 * command indexes one), then the new material images every plan binds
 * (`prepare_scene_textures`), then `upload(item)` for the root plan's rows and
 * each layer's, between startup-budget yields. A layer's topology version is
 * the one its plan was built from.
 */
template <typename Mesh, typename Resource, typename Prepare, typename Upload>
Iteration<bool> upload_scene_meshes(const Engine& engine,
                                    const std::vector<std::shared_ptr<Scene>>& layers,
                                    const upstream::RenderPlan& plan, std::vector<Mesh>& meshes,
                                    std::vector<upstream::RenderPlan>& overlay_plans,
                                    std::vector<std::vector<Mesh>>& overlay_meshes,
                                    std::vector<std::uint64_t>& overlay_versions,
                                    TextureUploadCache<Resource>& cache, Prepare prepare,
                                    Upload upload, bool native = true) {
    std::vector<upstream::RenderPlan> overlays;
    std::vector<std::uint64_t> versions;
    for (std::size_t layer = 1; layer < layers.size(); ++layer) {
        const Scene* overlay_scene = layers[layer].get();
        if (!overlay_scene)
            continue;
        overlays.push_back(upstream::build_render_plan(*overlay_scene, engine));
        validate_render_plan_items(overlays.back());
        versions.push_back(overlay_scene->render_topology_version);
    }
    std::vector<const upstream::RenderPlan*> plans{&plan};
    for (const upstream::RenderPlan& overlay : overlays)
        plans.push_back(&overlay);
#if BBLITE_SHADER_EXTERNAL_TEXTURES
    // The pin binds a packet's external textures as it builds the packet.
    for (const upstream::RenderPlan* checked : plans)
        upstream::require_shader_external_textures(engine, *checked);
#endif
    auto textures = prepare_scene_textures(engine, std::move(plans), cache, prepare, native);
    while (textures.advance())
        co_yield false;
    const auto prepared = textures.result();
    StartupWorkBudget budget;
    for (std::size_t layer = 0; layer <= overlays.size(); ++layer) {
        const upstream::RenderPlan& rows = layer == 0 ? plan : overlays[layer - 1];
        std::vector<Mesh> layer_meshes;
        std::vector<Mesh>& uploaded = layer == 0 ? meshes : layer_meshes;
        uploaded.reserve(rows.items.size());
        for (const upstream::RenderItem& item : rows.items) {
            uploaded.push_back(upload(item));
            if (budget.exhausted()) {
                co_yield false;
                budget.resume();
            }
        }
        if (layer > 0) {
            overlay_plans.push_back(std::move(overlays[layer - 1]));
            overlay_meshes.push_back(std::move(layer_meshes));
            overlay_versions.push_back(versions[layer - 1]);
        }
    }
    co_return true;
}

/** Prepare only the plans' reached draws, before frame callbacks or publication. */
template <typename TaskLists, typename Prepare>
Iteration<bool> prepare_scene_pipeline_draws(Engine& engine, const Scene& scene,
                                             const upstream::RenderPlan& plan, TaskLists task_lists,
                                             Prepare prepare) {
    StartupWorkBudget budget;
    auto tasks = scene.tasks;
    if (tasks.empty())
        tasks.push_back({});
    for (const TaskHandle handle : tasks) {
        const FrameTaskRecord* task =
            handle.value == invalid_handle ? nullptr : &handle_at(engine.frame_tasks, handle);
        if (task && (task->execution_enabled == false || (task->kind != FrameTaskKind::render &&
                                                          task->kind != FrameTaskKind::geometry)))
            continue;
        if (task && task->kind == FrameTaskKind::geometry &&
            upstream::geometry_task_skips(geometry_pass_camera(engine, scene)))
            continue;
        // Ordinary depth-only tasks already use the eager generic pipelines.
        if (task && task->kind == FrameTaskKind::render &&
            task->render.shadow_generator.value == invalid_handle &&
            !handle_at(engine.render_targets, task->render.target).has_color)
            continue;
        const auto& lists = task ? task_lists(handle) : plan.draw_lists;
        for (const auto* list : {&lists.opaque, &lists.transparent})
            for (const auto& draw : list->commands) {
                if (!upstream::render_item_draws_now(draw.item, engine))
                    continue;
                prepare(draw, task);
                if (budget.exhausted()) {
                    co_yield false;
                    budget.resume();
                }
            }
    }
    co_return true;
}

/**
 * Setup's pipeline preparation, the order both scene backends run: the
 * `background` job (the background arms', or none) starts first and builds
 * beside the material pipelines `prepare` collects from every registered
 * layer's reached draws, which run with the backend's `extra` jobs; both
 * finish before the first frame.
 */
template <typename TaskLists, typename Prepare>
Iteration<bool> prepare_scene_pipelines(Engine& engine,
                                        const std::vector<std::shared_ptr<Scene>>& layers,
                                        const upstream::RenderPlan& plan,
                                        const std::vector<upstream::RenderPlan>& overlay_plans,
                                        TaskLists task_lists, Prepare prepare,
                                        std::vector<std::function<void()>> background,
                                        std::vector<std::function<void()>> extra, bool native) {
    auto backgrounds = run_native_preparation(std::move(background), native);
    static_cast<void>(backgrounds.advance());
    std::vector<std::function<void()>> jobs;
    for (std::size_t layer = 0; layer < layers.size(); ++layer) {
        const Scene& layer_scene = *layers[layer];
        auto pipelines = prepare_scene_pipeline_draws(
            engine, layer_scene, layer == 0 ? plan : overlay_plans[layer - 1], task_lists,
            [&](const upstream::RenderDrawCommand& draw, const FrameTaskRecord* task) {
                prepare(layer_scene, draw, task, jobs);
            });
        while (pipelines.advance())
            co_yield false;
    }
    std::move(extra.begin(), extra.end(), std::back_inserter(jobs));
    auto preparation = run_native_preparation(std::move(jobs), native);
    while (preparation.advance())
        co_yield false;
    while (backgrounds.advance())
        co_yield false;
    co_return true;
}

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
    const auto scenes = engine.scenes();
    if (plans.size() != meshes.size() || plans.size() != versions.size() ||
        plans.size() + 1 != scenes.size()) {
        throw std::runtime_error("Overlay registration changed after renderer initialization.");
    }
    bool changed = false;
    auto overlay = std::next(scenes.begin());
    for (std::size_t layer = 0; layer < plans.size(); ++layer, ++overlay) {
        Scene& scene = **overlay;
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
 * attribute-version gated vertex upload, and the morph weights. The vertex
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
#if BBLITE_MESH_ATTRIBUTE_UPDATE
        const ModelGeometry& geometry = engine.geometries[item.geometry];
        if (gpu.attribute_version != geometry.attribute_version) {
            rows.upload_vertices(gpu, mesh_gpu_vertices(geometry, mesh));
            gpu.attribute_version = geometry.attribute_version;
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
 * backends: the retained bindings' scene checks, the capture's frame, the
 * rebind a build since the last frame calls for, then the bindings' own
 * updates through the pass camera and extent.
 */
template <class TextState>
void update_scene_text(TextState& text, const Scene& scene, long frame,
                       const PixelViewport& surface_extent, const PassCamera& pass) {
    validate_text_scene(scene);
    text.device->owner->capture.begin_frame(static_cast<std::uint64_t>(frame));
    text.scene.follow(scene);
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
#if BBLITE_SHADER_EXTERNAL_TEXTURES
    // A shader packet with external textures rebinds them on every refresh,
    // and the pin checks each slot as it binds.
    upstream::require_shader_external_textures(engine, sync.render_plan);
    for (const upstream::RenderPlan& overlay_plan : sync.overlay_plans)
        upstream::require_shader_external_textures(engine, overlay_plan);
#endif
    sync.synced_draw_list_epoch = engine.draw_list_epoch;
    // After the rebuild: the previous plan can still list a mesh this frame
    // retired, whose slot a new mesh may already hold.
    auto& rows = backend.mesh_rows();
    sync_plan_mesh_rows(scene, engine, sync.render_plan, sync.meshes, rows);
    const auto scenes = engine.scenes();
    auto overlay = std::next(scenes.begin());
    for (std::size_t layer = 0;
         layer < sync.overlay_plans.size() && layer < sync.overlay_meshes.size();
         ++layer, ++overlay) {
        sync_plan_mesh_rows(**overlay, engine, sync.overlay_plans[layer],
                            sync.overlay_meshes[layer], rows);
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
