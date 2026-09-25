// The SDL_GPU scene renderer's driver: the pass helpers, the state's
// release and the frame run. The feature families it draws through are
// their own files (pal_sdl_gpu_scene_<family>.cpp), compiled with it as one
// translation unit (pal_sdl_gpu_scene_all.cpp).
#include <bblite/features/compute_frame_graph.hpp>
#include <bblite/features/device_recovery.hpp>
#include <bblite/features/gpu_task_timing.hpp>
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_clustered_lights.hpp>
#include <bblite/features/has_detailed_picking.hpp>
#include <bblite/features/has_effect_task.hpp>
#include <bblite/features/has_geometry_output.hpp>
#include <bblite/features/has_material_plugin_textures.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/has_screen_space.hpp>
#include <bblite/features/has_splats.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_text.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/mesh_position_update.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/workers.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER
SDL_GPUPrimitiveType gpu_primitive_type(MeshTopology topology) {
    switch (topology) {
    case MeshTopology::points:
        return SDL_GPU_PRIMITIVETYPE_POINTLIST;
    case MeshTopology::lines:
        return SDL_GPU_PRIMITIVETYPE_LINELIST;
    case MeshTopology::line_strip:
        return SDL_GPU_PRIMITIVETYPE_LINESTRIP;
    case MeshTopology::triangles:
        return SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    }
    return SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
}

void set_pass_viewport(SDL_GPURenderPass* pass, const std::optional<PixelViewport>& resolved) {
    if (!resolved.has_value())
        return;
    const PixelViewport& rect = *resolved;
    SDL_GPUViewport viewport{
        static_cast<float>(rect.x),
        static_cast<float>(rect.y),
        static_cast<float>(rect.width),
        static_cast<float>(rect.height),
        0.0f,
        1.0f,
    };
    SDL_SetGPUViewport(pass, &viewport);
    const SDL_Rect scissor{
        static_cast<int>(rect.x),
        static_cast<int>(rect.y),
        static_cast<int>(rect.width),
        static_cast<int>(rect.height),
    };
    SDL_SetGPUScissor(pass, &scissor);
}

void set_task_camera_viewport(SDL_GPURenderPass* pass, const CameraRecord* camera,
                              std::uint32_t target_width, std::uint32_t target_height) {
    set_pass_viewport(pass,
                      upstream::pass_camera_viewport(camera, static_cast<double>(target_width),
                                                     static_cast<double>(target_height)));
}

void release(GpuState& state) {
    state.depth_copy_pipeline.reset();
#if BBLITE_HAS_TEXT
    state.text.reset();
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
    release_sprite_ui_sdl_resources(state.device, state.ui);
    state.ui_readable_surface.release(state.device);
#endif
    release_frame_graph_textures(state);
#if BBLITE_HAS_SCREEN_SPACE
    // The screen-space programs key only the generated stage table's
    // formats, so they outlive every frame-graph rebuild and go with the
    // device.
    state.screen_space_programs.clear();
#endif
    for (GpuState::StorageBuffer& storage : state.storage_buffers) {
        if (storage.buffer && !storage.borrowed_owner) {
            SDL_ReleaseGPUBuffer(state.device, storage.buffer);
        }
    }
    state.storage_buffers.clear();
#if BBLITE_HAS_BILLBOARDS
    for (BillboardPass& billboard : state.billboard_passes) {
        release_billboard_pass(state.device, billboard);
    }
    state.billboard_passes.clear();
#endif
#if BBLITE_HAS_PICKING
    release_pick_targets(state.device, state.pick_targets);
    if (state.pick_mesh_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.pick_mesh_pipeline);
        state.pick_mesh_pipeline = nullptr;
    }
#if BBLITE_GPU_INSTANCING
    if (state.pick_thin_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.pick_thin_pipeline);
        state.pick_thin_pipeline = nullptr;
    }
#endif
#if BBLITE_HAS_DETAILED_PICKING
    if (state.pick_detailed_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.pick_detailed_pipeline);
        state.pick_detailed_pipeline = nullptr;
    }
#endif
#if BBLITE_DEFORM_PICKING
    for (auto& modes : state.pick_deform_programs) {
        for (auto& program : modes) {
            if (program.pipeline)
                SDL_ReleaseGPUGraphicsPipeline(state.device, program.pipeline);
            program.pipeline = nullptr;
        }
    }
#endif
#if BBLITE_HAS_SPLATS
    if (state.pick_cloud_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.pick_cloud_pipeline);
        state.pick_cloud_pipeline = nullptr;
    }
#endif
#endif
#if BBLITE_HAS_SPLATS
    for (SplatPass& splat : state.splat_passes) {
        release_splat_pass(state.device, splat);
    }
    state.splat_passes.clear();
#endif
#if BBLITE_HAS_CLUSTERED_LIGHTS
    release_clustered_lights(state.device, state.clustered);
#endif
    for (GpuMesh& mesh : state.meshes) {
        release_gpu_mesh(state, mesh);
    }
    for (std::vector<GpuMesh>& layer : state.overlay_meshes) {
        for (GpuMesh& mesh : layer) {
            release_gpu_mesh(state, mesh);
        }
    }
    state.overlay_meshes.clear();
    release_all_shared(state.shared_shader_geometries, [&](SharedShaderGeometry& geometry) {
        geometry.vertex_buffer.reset();
        geometry.index_buffer.reset();
    });
    release_all_shared(state.shared_shader_material_textures,
                       [](SharedShaderMaterialTextures& textures) { textures.clear(); });
#if BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES
    release_all_shared(state.shared_plugin_material_textures,
                       [](SharedPluginMaterialTextures& textures) { textures.clear(); });
#endif
    release_all_shared(state.shared_composed_material_textures,
                       [&](SharedComposedMaterialTextures& textures) {
                           release_sprite_fragment_textures(state.device, textures.bindings);
                       });
#if BBLITE_GPU_MORPH_STORAGE
    if (state.empty_morph_deltas) {
        SDL_ReleaseGPUBuffer(state.device, state.empty_morph_deltas);
    }
    if (state.empty_morph_weights) {
        SDL_ReleaseGPUBuffer(state.device, state.empty_morph_weights);
    }
#endif
#if BBLITE_PINNED_BACKGROUNDS
    for (GpuBackgroundArm& arm : state.background_arms) {
        if (arm.pipeline)
            SDL_ReleaseGPUGraphicsPipeline(state.device, arm.pipeline);
        for (SDL_GPUBuffer* buffer : arm.vertex_buffers)
            SDL_ReleaseGPUBuffer(state.device, buffer);
        if (arm.indices)
            SDL_ReleaseGPUBuffer(state.device, arm.indices);
        if (arm.texture && arm.owns_texture)
            SDL_ReleaseGPUTexture(state.device, arm.texture);
    }
    state.background_arms.clear();
#endif
    if (state.environment && !state.environment_gpu)
        SDL_ReleaseGPUTexture(state.device, state.environment);
    if (state.brdf_lut)
        SDL_ReleaseGPUTexture(state.device, state.brdf_lut);
    if (state.reflection_fallback) {
        SDL_ReleaseGPUTexture(state.device, state.reflection_fallback);
    }
    for (SDL_GPUTexture* texture : state.reflection_cubes) {
        SDL_ReleaseGPUTexture(state.device, texture);
    }
    release_sized_texture(state, state.color, state.color_width, state.color_height);
#if BBLITE_RENDERER_TRANSMISSION
    release_sized_texture(state, state.processed_color, state.processed_color_width,
                          state.processed_color_height);
    release_sized_texture(state, state.transmission_color, state.transmission_width,
                          state.transmission_height);
#endif
    release_sized_texture(state, state.msaa_color, state.msaa_color_width, state.msaa_color_height);
    release_sized_texture(state, state.depth, state.depth_width, state.depth_height);
    if (state.background_sampler)
        SDL_ReleaseGPUSampler(state.device, state.background_sampler);
#if BBLITE_RENDERER_TRANSMISSION
    if (state.transmission_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.transmission_sampler);
    }
#endif
    if (state.ground_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.ground_sampler);
    }
#if BBLITE_HAS_POST_PROCESS
    if (state.post_process_bilinear_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.post_process_bilinear_sampler);
        state.post_process_bilinear_sampler = nullptr;
    }
    if (state.post_process_nearest_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.post_process_nearest_sampler);
        state.post_process_nearest_sampler = nullptr;
    }
#endif
    if (state.depth_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.depth_sampler);
    }
#if BBLITE_SHADOW_RECEIVERS
    for (const GpuState::ShadowGenerator& generator : state.shadow_generators) {
        if (generator.info) {
            SDL_ReleaseGPUBuffer(state.device, generator.info);
        }
    }
    state.shadow_generators.clear();
#if BBLITE_SHADOWS_ESM
    // `source` stays: it is the caster target's own colour map, borrowed.
    for (const GpuState::EsmBlur& blur : state.esm_blurs) {
        if (blur.blur_h)
            SDL_ReleaseGPUTexture(state.device, blur.blur_h);
        if (blur.blur_v)
            SDL_ReleaseGPUTexture(state.device, blur.blur_v);
        if (blur.pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, blur.pipeline);
        }
        if (blur.params_buffer) {
            SDL_ReleaseGPUBuffer(state.device, blur.params_buffer);
        }
    }
    state.esm_blurs.clear();
#endif
    if (state.shadow_comparison_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.shadow_comparison_sampler);
        state.shadow_comparison_sampler = nullptr;
    }
    if (state.shadow_filtering_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.shadow_filtering_sampler);
        state.shadow_filtering_sampler = nullptr;
    }
#endif
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    if (state.pinned_bone_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.pinned_bone_sampler);
    }
    if (state.pinned_float_transfer) {
        SDL_ReleaseGPUTransferBuffer(state.device, state.pinned_float_transfer);
        state.pinned_float_transfer = nullptr;
        state.pinned_float_transfer_bytes = 0;
    }
#endif
    if (state.sampler)
        SDL_ReleaseGPUSampler(state.device, state.sampler);
    if (state.id_pipeline)
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_pipeline);
    if (state.id_double_sided_pipeline)
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_double_sided_pipeline);
    if (state.cluster_pipeline)
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.cluster_pipeline);
    if (state.cluster_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.cluster_double_sided_pipeline);
    }
    if (state.blit_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.blit_pipeline);
    }
    if (state.blit_msaa_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.blit_msaa_pipeline);
    }
#if BBLITE_RENDERER_TRANSMISSION
    if (state.image_processing_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.image_processing_pipeline);
    }
#endif
    for (SDL_GPUGraphicsPipeline* pipeline : state.depth_only_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.depth_only_double_sided_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
#if BBLITE_PBR_VARIANTS > 0
    state.pinned_pipelines.clear();
#endif
#if BBLITE_STANDARD_VARIANTS > 0
    state.standard_variant_pipelines.clear();
#endif
#if BBLITE_NODE_VARIANTS > 0
    state.node_variant_pipelines.clear();
#endif
    for (SDL_GPUGraphicsPipeline* pipeline : state.shader_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.shader_a2c_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.shader_shadow_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    state.shader_task_pipelines.clear();
#if BBLITE_LOCAL_CUBEMAP
    state.local_cubemaps.clear();
#endif
    state.release();
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal

namespace bbl::pal {
#if BBLITE_HAS_PBR_RENDERER
class SdlSceneRun {

    struct Resources {
        GpuState state;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        UiRmlRuntime* ui_runtime = nullptr;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        std::vector<SpritePass> sprite_passes;
        std::vector<SDL_GPUTexture*> sprite_render_textures;
        SceneSpritePass scene_sprite_pass;
        bool has_scene_sprite_pass = false;
#endif
        ~Resources() {
#if BBLITE_HAS_UI && !BBLITE_WORKERS
            destroy_ui_rml_runtime(ui_runtime);
#endif
#if BBLITE_HAS_SPRITE_RENDERER
            if (has_scene_sprite_pass)
                release_scene_sprite_pass(state.device, scene_sprite_pass);
            for (SpritePass& pass : sprite_passes)
                release_sprite_pass(state.device, pass);
            for (SDL_GPUTexture* texture : sprite_render_textures)
                if (texture)
                    SDL_ReleaseGPUTexture(state.device, texture);
#endif
            release(state);
        }
    };

    struct State : FrameSession {
        const bool cpu_profile = environment_variable("BBLITE_CPU_PROFILE") == "1";
        const MemoryProfile mem_profile;
        CpuStartupMark cpu_startup_mark{cpu_profile, "sdl"};
        const std::vector<std::shared_ptr<Scene>> active_registered_scenes =
            engine.registered_scenes;
        const std::shared_ptr<Scene> active_scene = active_registered_scenes.front();
        Scene& scene = *active_scene;
        Resources resources;
        SDL_GPUTextureFormat swapchain_format = SDL_GPU_TEXTUREFORMAT_INVALID;
#if BBLITE_RENDERER_TRANSMISSION
        bool transmission_enabled = false;
#else
        static constexpr bool transmission_enabled = false;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        OffscreenRun* offscreen = nullptr;
        std::optional<SdlOffscreenTarget> offscreen_target;
#endif
        upstream::RenderPlan render_plan;
        std::vector<upstream::RenderPlan> overlay_plans;
        std::vector<std::uint64_t> overlay_topology_versions;
        std::vector<upstream::RenderDrawLists> task_draw_lists;
        std::uint64_t synced_render_topology_version = 0, synced_draw_list_epoch = 0;
        std::uint32_t synced_material_family_mask = 0;
        CameraPointerState pointer_state;
        SurfaceCameraPointerState surface_pointer_state;
        CameraTraceState camera_trace_state;
        // Each pass's view-projection and scene blocks, which a camera-less
        // pass keeps.
        RetainedSceneBlocks pass_blocks;
        std::vector<float> shader_block_scratch;
#if BBLITE_HAS_PICKING
#if BBLITE_HAS_BILLBOARDS
        BillboardPickContributor billboard_pick;
#endif
        std::optional<PickHookGuard> pick_hook_guard;
#endif
        std::optional<GpuBufferUploadBatch> frame_buffer_uploads;
#if BBLITE_DEVICE_RECOVERY
        std::optional<DrawCountScope> draw_count_scope;
#endif
        explicit State(Engine& target) : FrameSession(target) {}
    } data_;

    struct Frame {
        // Keep construction explicit while optional inspects this nested type.
        Frame() {}
        bool yield_when_skipped = false, graph = false;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        const UiRenderFrame* ui_frame = nullptr;
        SDL_GPUTexture* present_swapchain = nullptr;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        SDL_GPUTexture* offscreen_texture = nullptr;
#endif
        SdlGpuCommand command{nullptr};
        SDL_GPUTexture* swapchain = nullptr;
        Uint32 width = 0, height = 0;
        double start = 0, delta_ms = 0, updated = 0, uploaded = 0, acquired = 0;
        bool capture_ready = false, capture_frame = false, capture_ids = false,
             capture_clusters = false;
        PixelViewport surface_extent{};
        CameraPassMatrices frame_camera{};
        ShaderPassMatrices frame_pass_matrices{};
        SDL_GPUTexture* capture_texture = nullptr;
        SDL_GPUTexture* visible_color = nullptr;
    };
    std::optional<Frame> frame_;

    /** The frame `prepare` opened; every later stage records into it. */
    Frame& current_frame() {
        if (!frame_)
            throw std::logic_error("SDL_GPU scene stage ran outside an acquired frame.");
        return *frame_;
    }

    /** The run scene's `scene_camera`. */
    CameraRecord* active_camera() { return scene_camera(data_.engine, data_.scene); }

    void rebuild_task_draw_lists() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& task_draw_lists = data_.task_draw_lists;

        task_draw_lists.resize(engine.frame_tasks.size());
        for (upstream::RenderDrawLists& lists : task_draw_lists) {
            lists = {};
        }
        for (std::size_t layer = 0; layer < engine.registered_scenes.size(); ++layer) {
            const Scene& task_scene = *engine.registered_scenes[layer];
            const upstream::RenderPlan& task_plan =
                layer == 0 ? render_plan : overlay_plans[layer - 1];
            for (const TaskHandle handle : task_scene.tasks) {
                if (handle.value >= engine.frame_tasks.size()) {
                    throw std::runtime_error("Scene frame task handle is invalid.");
                }
                handle_at(task_draw_lists, handle) = upstream::build_render_task_draw_lists(
                    task_plan.items, engine, handle_at(engine.frame_tasks, handle));
                auto& task = handle_at(engine.frame_tasks, handle);
                task.render_recorded = true;
                task.render_meshes_dirty = false;
            }
        }
    }

    void capture_render_state() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& state = data_.resources.state;
        [[maybe_unused]] auto& width = current_frame().width;
        [[maybe_unused]] auto& height = current_frame().height;
        [[maybe_unused]] const auto& matrix = current_frame().frame_camera.view_projection;
        [[maybe_unused]] const auto& capture_ready = current_frame().capture_ready;

        if (capture_ready && !captures.render_capture_saved &&
            !frame_options.render_capture_path.empty()) {
            const CameraRecord* camera = active_camera();
            if (!camera) {
                throw std::runtime_error("The render capture records the active camera and the "
                                         "draws it projects; this scene has no active camera.");
            }
            write_render_capture(frame_options.render_capture_path, "sdl_gpu", scene, engine,
                                 *camera, render_plan, matrix, static_cast<int>(width),
                                 static_cast<int>(height), frame
#if BBLITE_HAS_TEXT
                                 ,
                                 &state.text->device->owner->capture
#elif BBLITE_NODE_GEOMETRY_VARIANTS > 0
                                 ,
                                 nullptr
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                                 ,
                                 &state.node_capture.capture
#endif
            );
            captures.render_capture_saved = true;
        }
    }

public:
    static constexpr FrameAcquirePhase acquire_phase = FrameAcquirePhase::before_update;
    explicit SdlSceneRun(Engine& engine) : data_(engine) {}
    bool keep_running() const { return data_.keep_running(); }
    void discard_frame() { frame_.reset(); }
    bool yield_when_skipped() const { return frame_ && frame_->yield_when_skipped; }

    void setup() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& cpu_startup_mark = data_.cpu_startup_mark;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        [[maybe_unused]] auto& task_draw_lists = data_.task_draw_lists;
        [[maybe_unused]] auto& synced_render_topology_version =
            data_.synced_render_topology_version;
        [[maybe_unused]] auto& synced_draw_list_epoch = data_.synced_draw_list_epoch;
        [[maybe_unused]] auto& synced_material_family_mask = data_.synced_material_family_mask;
        [[maybe_unused]] auto& swapchain_format = data_.swapchain_format;
        [[maybe_unused]] auto& transmission_enabled = data_.transmission_enabled;
        [[maybe_unused]] auto& state = data_.resources.state;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.resources.ui_runtime;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& sprite_passes = data_.resources.sprite_passes;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& sprite_render_textures = data_.resources.sprite_render_textures;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& scene_sprite_pass = data_.resources.scene_sprite_pass;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& has_scene_sprite_pass = data_.resources.has_scene_sprite_pass;
#endif
        [[maybe_unused]] auto& id_buffer_path = data_.frame_options.id_buffer_path;
        [[maybe_unused]] auto& cluster_buffer_path = data_.frame_options.cluster_buffer_path;
#if BBLITE_HAS_PICKING && BBLITE_HAS_BILLBOARDS
        [[maybe_unused]] auto& billboard_pick = data_.billboard_pick;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
        reject_unsupported_frame_options(frame_options, "SDL_GPU",
                                         /*supports_single_sample=*/true,
                                         /*supports_copy_task=*/true);
        apply_animation_seek(frame_options, scene);

#if BBLITE_OFFSCREEN_SURFACES
        offscreen = OffscreenRun::current();
        if (offscreen) {
            auto* shared = dynamic_cast<SdlOffscreenDevice*>(&offscreen->device());
            if (!shared)
                throw std::runtime_error("Offscreen surface does not own an SDL GPU device.");
            state.device = shared->device;
            state.owns_device = false;
            sync_engine_canvas_size(nullptr, engine);
            if (!frame_options.screenshot_path.empty()) {
                throw std::runtime_error("Capture offscreen output from its presentation host.");
            }
        } else {
#endif
            create_sdl_gpu_device(engine.options, frame_device_options(frame_options), state);
            sync_engine_canvas_size(state.window, engine);
#if BBLITE_OFFSCREEN_SURFACES
        }
        data_.offscreen_target.emplace(state.device);
#endif
        for (const SDL_GPUTextureFormat candidate : {
                 SDL_GPU_TEXTUREFORMAT_D32_FLOAT,
                 SDL_GPU_TEXTUREFORMAT_D24_UNORM,
             }) {
            if (SDL_GPUTextureSupportsFormat(state.device, candidate, SDL_GPU_TEXTURETYPE_2D,
                                             SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET |
                                                 SDL_GPU_TEXTUREUSAGE_SAMPLER)) {
                state.depth_format = candidate;
                break;
            }
        }
        swapchain_format =
#if BBLITE_OFFSCREEN_SURFACES
            offscreen ? SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM :
#endif
                      SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        ui_runtime = create_ui_rml_runtime(engine, state.window,
                                           static_cast<std::uint32_t>(engine.options.width),
                                           static_cast<std::uint32_t>(engine.options.height));
#endif
#if BBLITE_RENDERER_TRANSMISSION
        transmission_enabled = scene.transmission_enabled;
        // The frame-graph path takes the main pass's else arm, where the
        // mid-pass scene-colour grab never runs — refuse, exactly as the
        // Dawn backend does, rather than render transmission-less.
        if (transmission_enabled && !scene.tasks.empty()) {
            throw std::runtime_error("transmission combined with frame-graph tasks is not "
                                     "implemented yet.");
        }
#else
        // A tree that composes no transmission carries no grab path; the
        // remaining arms below fold to their plain side.

#endif
        if (!frame_options.single_sample &&
            upstream::preferred_sample_count(engine.options.msaa_samples) >= 4 &&
            SDL_GPUTextureSupportsSampleCount(state.device, swapchain_format,
                                              SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(state.device, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                                              SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device, SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT, SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(state.device, SDL_GPU_TEXTUREFORMAT_R16_FLOAT,
                                              SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(state.device, state.depth_format,
                                              SDL_GPU_SAMPLECOUNT_4)) {
            state.sample_count = SDL_GPU_SAMPLECOUNT_4;
        }
        cpu_startup_mark("window-device");

        // The scene matrix, the deformation block, and the mesh world.
        auto vertex_shader = load_shader(state.device, "pbr.vert", SDL_GPU_SHADERSTAGE_VERTEX, 0,
                                         mesh_world_uniform_slot + 1, "mainVertex",
#if BBLITE_GPU_MORPH_STORAGE
                                         2);
#else
                                         0);
#endif
#if BBLITE_RENDERER_TRANSMISSION
        // The module the pinned image-processing task composes for this
        // frame's source: per-sample over the multisampled attachment,
        // averaged after `ip()`, or over the single-sample one. Reading the
        // multisampled attachment needs a texture SDL refuses to create with
        // a read usage until libsdl-org/SDL#15838 lands, so a single-sample
        // run takes the pin's single-sample arm.
        const bool per_sample_image_processing =
            transmission_enabled && state.sample_count != SDL_GPU_SAMPLECOUNT_1;
        const std::string image_processing_stem =
            per_sample_image_processing ? "image-processing" : "image-processing-single";
        PinnedStage image_processing_vertex =
            transmission_enabled ? load_pinned_stage(state.device, image_processing_stem + ".vert",
                                                     SDL_GPU_SHADERSTAGE_VERTEX)
                                 : PinnedStage{};
        PinnedStage image_processing_fragment =
            transmission_enabled ? load_pinned_stage(state.device, image_processing_stem + ".frag",
                                                     SDL_GPU_SHADERSTAGE_FRAGMENT)
                                 : PinnedStage{};
        auto& image_processing_vertex_shader = image_processing_vertex.shader;
        auto& image_processing_fragment_shader = image_processing_fragment.shader;
        state.image_processing_params_slot =
            stage_uniform_slot(image_processing_fragment.slots, "p");
#endif
        const upstream::RenderFeatures render_features =
            upstream::build_render_features(scene, engine);
        // The Standard family's reflection cubes still upload when the
        // family is present; its stages themselves are the composed
        // variant-std-* modules, loaded lazily per variant.
        const bool use_standard_material = render_features.standard_material;
        const bool use_no_color_material = render_features.no_color_material;
        const bool use_shader_shadow_material = std::any_of(
            render_features.shader_shadow_variants.begin(),
            render_features.shader_shadow_variants.end(), [](bool reached) { return reached; });
        auto depth_only_fragment_shader =
            use_no_color_material || use_shader_shadow_material
                ? load_shader(state.device, "depth-only.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, 0, 0,
                              "mainFragment")
                : nullptr;
        const bool use_shader_materials = render_features.shader_material;
        std::vector<OwnedSdlShader> shader_vertex_shaders;
        std::vector<OwnedSdlShader> shader_fragment_shaders;
        if (use_shader_materials) {
            const std::uint32_t shader_variant_total = upstream::shader_variant_count();
            shader_vertex_shaders.resize(shader_variant_total);
            shader_fragment_shaders.resize(shader_variant_total);
            state.shader_vertex_slots.resize(shader_variant_total);
            state.shader_fragment_slots.resize(shader_variant_total);
            for (std::uint32_t variant = 0; variant < shader_variant_total; ++variant) {
                const upstream::ShaderVariantInfo& info = upstream::shader_variant_info(variant);
                const std::string vertex_name = std::string(info.name) + ".vert";
                const std::string fragment_name = std::string(info.name) + ".frag";
                // A shader material's stage is composed from the caller's
                // own WGSL, so which blocks and textures survive to the
                // compiled artifact is the caller's text to decide -- a
                // sampler read only inside a branch a define folds away is
                // stripped, and the registers behind it move up. bblite-tint
                // writes the slots it assigned beside the stage, so the PAL
                // binds by that sidecar rather than by the reflection
                // generation derived, exactly as the post-process and
                // billboard programs already do.
                PinnedStage vertex_stage =
                    load_pinned_stage(state.device, vertex_name, SDL_GPU_SHADERSTAGE_VERTEX);
                PinnedStage fragment_stage =
                    load_pinned_stage(state.device, fragment_name, SDL_GPU_SHADERSTAGE_FRAGMENT);
                shader_vertex_shaders[variant] = std::move(vertex_stage.shader);
                shader_fragment_shaders[variant] = std::move(fragment_stage.shader);
                state.shader_vertex_slots[variant] = std::move(vertex_stage.slots);
                state.shader_fragment_slots[variant] = std::move(fragment_stage.slots);
            }
        }
        auto id_fragment_shader =
            !id_buffer_path.empty()
                ? load_shader(state.device, "diagnostic-id.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, 1,
                              1, "mainFragment")
                : nullptr;
        auto cluster_fragment_shader =
            !cluster_buffer_path.empty()
                ? load_shader(state.device, "diagnostic-cluster.frag", SDL_GPU_SHADERSTAGE_FRAGMENT,
                              1, 1, "mainFragment")
                : nullptr;

        std::array<SDL_GPUVertexBufferDescription,
#if BBLITE_GPU_INSTANCING
                   2
#else
                   1
#endif
                   >
            vertex_buffers{};
        vertex_buffers[0].slot = 0;
        vertex_buffers[0].pitch = sizeof(GpuVertex);
        vertex_buffers[0].input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
        // The shared material stage's `VertexInput`, at the locations it
        // declares; deformation appends joints, weights and the morph deltas
        // at 8-15 exactly like the Dawn backend.
#if BBLITE_GPU_DEFORMATION
        constexpr Uint32 base_attribute_count = 14;
#else
        constexpr Uint32 base_attribute_count = 6;
#endif
        std::array<SDL_GPUVertexAttribute,
#if BBLITE_GPU_INSTANCING
                   base_attribute_count + 4
#else
                   base_attribute_count
#endif
                   >
            attributes{};
        constexpr Uint32 attribute_count = static_cast<Uint32>(attributes.size());
        {
            Uint32 next = 0;
            const auto attribute = [&](Uint32 location, SDL_GPUVertexElementFormat format,
                                       std::size_t offset) {
                attributes[next++] =
                    SDL_GPUVertexAttribute{location, 0, format, static_cast<Uint32>(offset)};
            };
            attribute(0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(GpuVertex, position));
            attribute(1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(GpuVertex, normal));
            attribute(2, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, offsetof(GpuVertex, tangent));
            attribute(3, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, offsetof(GpuVertex, uv));
            attribute(5, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, offsetof(GpuVertex, uv2));
            attribute(6, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, offsetof(GpuVertex, color));
#if BBLITE_GPU_DEFORMATION
            attribute(8, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, offsetof(GpuVertex, joints));
            attribute(9, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, offsetof(GpuVertex, weights));
            attribute(10, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3,
                      offsetof(GpuVertex, morph_position_0));
            attribute(11, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3,
                      offsetof(GpuVertex, morph_position_1));
            attribute(12, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(GpuVertex, morph_normal_0));
            attribute(13, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(GpuVertex, morph_normal_1));
            attribute(14, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(GpuVertex, morph_tangent_0));
            attribute(15, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(GpuVertex, morph_tangent_1));
#endif
            if (next != base_attribute_count) {
                throw std::logic_error("The shared stage's vertex table lost a lane.");
            }
        }
#if BBLITE_GPU_INSTANCING
        vertex_buffers[1].slot = 1;
        vertex_buffers[1].pitch = sizeof(std::array<float, 16>);
        vertex_buffers[1].input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
        attributes[base_attribute_count] =
            SDL_GPUVertexAttribute{16, 1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 0};
        attributes[base_attribute_count + 1] =
            SDL_GPUVertexAttribute{17, 1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 16};
        attributes[base_attribute_count + 2] =
            SDL_GPUVertexAttribute{18, 1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 32};
        attributes[base_attribute_count + 3] =
            SDL_GPUVertexAttribute{19, 1, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 48};
#endif
        SDL_GPUColorTargetDescription color_target{};
        color_target.format =
            transmission_enabled ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT : swapchain_format;
#if BBLITE_HAS_SPRITE_RENDERER
        // Sprite rendering contexts and their render targets may be created
        // by a before-render callback. Mirror all newly appended CPU records
        // in handle order both here and immediately after each callback run.
        sync_sdl_scene_sprites(state, engine, sprite_passes, sprite_render_textures,
                               swapchain_format);
        if (!scene.depth_hosted_sprite_layers.empty()) {
            scene_sprite_pass = create_scene_sprite_pass(
                state.device, engine, scene.depth_hosted_sprite_layers, sprite_render_textures,
                color_target.format, state.depth_format, state.sample_count);
            has_scene_sprite_pass = true;
        }
#endif
        // Every material family and scene stage targets this frame attachment.
        state.frame_color_format = color_target.format;
#if BBLITE_HAS_SPLATS
        // One pass per cloud the scene registered, against the same
        // attachment and depth the scene's own draws use.
        for (const SplatMeshHandle splat : scene.splat_meshes) {
            state.splat_passes.push_back(create_splat_pass(state.device, engine, splat,
                                                           color_target.format, state.depth_format,
                                                           state.sample_count));
        }
#endif

#if BBLITE_HAS_BILLBOARDS
        // One pass per system the scene registered, targeting the same
        // attachment and depth the scene's own draws do.
        for (const BillboardSystemHandle system : scene.billboard_systems) {
            state.billboard_passes.push_back(
                create_billboard_pass(state.device, engine, system, color_target.format,
                                      state.depth_format, state.sample_count));
        }
#endif
        // The shared material vertex with no fragment: the PBR fragment text
        // is retired -- PBR draws run the pin's own composed stages -- so this
        // info is only the base the standard and diagnostic pipelines
        // copy before setting their own fragment.
        SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
        pipeline_info.vertex_shader = vertex_shader.get();
        pipeline_info.vertex_input_state = SDL_GPUVertexInputState{
            vertex_buffers.data(),
            static_cast<Uint32>(vertex_buffers.size()),
            attributes.data(),
            attribute_count,
        };
        pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        pipeline_info.rasterizer_state.enable_depth_clip = true;
        pipeline_info.depth_stencil_state.compare_op =
            gpu_depth_compare(upstream::pinned_depth_compare);
        pipeline_info.depth_stencil_state.enable_depth_test = true;
        pipeline_info.depth_stencil_state.enable_depth_write = true;
        pipeline_info.multisample_state.sample_count = state.sample_count;
        pipeline_info.target_info.color_target_descriptions = &color_target;
        pipeline_info.target_info.num_color_targets = 1;
        pipeline_info.target_info.depth_stencil_format = state.depth_format;
        pipeline_info.target_info.has_depth_stencil_target = true;
#if BBLITE_RENDERER_TRANSMISSION
        if (image_processing_vertex_shader && image_processing_fragment_shader) {
            SDL_GPUColorTargetDescription image_processing_target{};
            image_processing_target.format = swapchain_format;
            SDL_GPUGraphicsPipelineCreateInfo image_processing_info{};
            image_processing_info.vertex_shader = image_processing_vertex_shader.get();
            image_processing_info.fragment_shader = image_processing_fragment_shader.get();
            image_processing_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
            image_processing_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
            image_processing_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            image_processing_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            image_processing_info.target_info.color_target_descriptions = &image_processing_target;
            image_processing_info.target_info.num_color_targets = 1;
            state.per_sample_image_processing = per_sample_image_processing;
            state.image_processing_pipeline =
                create_sdl_graphics_pipeline(state.device, &image_processing_info);
            if (!state.image_processing_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline image processing");
            }
        }
#endif
        for (std::size_t index = 0;
             depth_only_fragment_shader && index < state.depth_only_pipelines.size(); ++index) {
            SDL_GPUGraphicsPipelineCreateInfo depth_pipeline_info = pipeline_info;
            depth_pipeline_info.fragment_shader = depth_only_fragment_shader.get();
            depth_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            depth_pipeline_info.multisample_state.sample_count =
                index == 0 ? SDL_GPU_SAMPLECOUNT_1 : state.sample_count;
            depth_pipeline_info.target_info.color_target_descriptions = nullptr;
            depth_pipeline_info.target_info.num_color_targets = 0;
            depth_pipeline_info.target_info.depth_stencil_format = state.depth_format;
            depth_pipeline_info.target_info.has_depth_stencil_target = true;
            state.depth_only_pipelines[index] =
                create_sdl_graphics_pipeline(state.device, &depth_pipeline_info);
            if (!state.depth_only_pipelines[index]) {
                gpu_error("SDL_CreateGPUGraphicsPipeline depth-only");
            }
            depth_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.depth_only_double_sided_pipelines[index] =
                create_sdl_graphics_pipeline(state.device, &depth_pipeline_info);
            if (!state.depth_only_double_sided_pipelines[index]) {
                gpu_error("SDL_CreateGPUGraphicsPipeline depth-only double-sided");
            }
        }
        if (use_shader_materials) {
            const std::uint32_t shader_variant_total = upstream::shader_variant_count();
            state.shader_pipelines.resize(shader_variant_total, nullptr);
            state.shader_a2c_pipelines.resize(shader_variant_total, nullptr);
            state.shader_shadow_pipelines.resize(shader_variant_total, nullptr);
            state.shader_task_pipelines.resize(shader_variant_total);
            for (std::uint32_t variant = 0; variant < shader_variant_total; ++variant) {
                SDL_GPUShader* variant_vertex_shader = shader_vertex_shaders[variant].get();
                SDL_GPUShader* variant_fragment_shader = shader_fragment_shaders[variant].get();
                if (!variant_vertex_shader) {
                    continue;
                }
                const upstream::ShaderVariantInfo& info = upstream::shader_variant_info(variant);
                // The pinned shader-pipeline mapping: needAlphaBlending
                // selects the src-alpha/one-minus-src-alpha blend,
                // backFaceCulling selects the cull mode, and
                // depthWrite=false turns depth writes off.
                SDL_GPUColorTargetDescription shader_target = color_target;
                if (info.alpha_blending) {
                    shader_target.blend_state = blend_state_from(
                        info.additive_blending ? shader_additive_blend : transparent_blend);
                }
                SDL_GPUGraphicsPipelineCreateInfo shader_pipeline_info = pipeline_info;
                shader_pipeline_info.vertex_shader = variant_vertex_shader;
                shader_pipeline_info.fragment_shader = variant_fragment_shader;
                shader_pipeline_info.rasterizer_state.cull_mode =
                    info.back_face_culling ? SDL_GPU_CULLMODE_BACK : SDL_GPU_CULLMODE_NONE;
                // The material's own primitive: the pin builds a shader
                // pipeline at `material._topology ?? "triangle-list"`, and
                // a line material is the one reached material that names
                // the second one.
                shader_pipeline_info.primitive_type =
                    info.topology == upstream::ShaderTopology::line_list
                        ? SDL_GPU_PRIMITIVETYPE_LINELIST
                        : SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
                if (!info.depth_write) {
                    shader_pipeline_info.depth_stencil_state.enable_depth_write = false;
                }
                if (info.depth_compare) {
                    shader_pipeline_info.depth_stencil_state.compare_op =
                        gpu_depth_compare(*info.depth_compare);
                }
                shader_pipeline_info.target_info.color_target_descriptions = &shader_target;
#if BBLITE_GPU_INSTANCE_COLORS
                // A material reading the per-instance RGBA stream draws
                // through a widened vertex input: the shared layout plus
                // the lane the pin's own thin-instance module appends,
                // in its own tightly-packed instance buffer. Only this
                // family declares it, so every other pipeline keeps the
                // layout it had.
                std::array<SDL_GPUVertexBufferDescription, 3> color_vertex_buffers{};
                std::array<SDL_GPUVertexAttribute, attributes.size() + 1> color_attributes{};
                if (info.instance_colors) {
                    std::copy(vertex_buffers.begin(), vertex_buffers.end(),
                              color_vertex_buffers.begin());
                    color_vertex_buffers[2].slot = 2;
                    color_vertex_buffers[2].pitch = sizeof(std::array<float, 4>);
                    color_vertex_buffers[2].input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
                    std::copy(attributes.begin(), attributes.end(), color_attributes.begin());
                    color_attributes[attributes.size()] = SDL_GPUVertexAttribute{
                        instance_color_location, 2, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 0};
                    shader_pipeline_info.vertex_input_state.vertex_buffer_descriptions =
                        color_vertex_buffers.data();
                    shader_pipeline_info.vertex_input_state.num_vertex_buffers =
                        static_cast<Uint32>(color_vertex_buffers.size());
                    shader_pipeline_info.vertex_input_state.vertex_attributes =
                        color_attributes.data();
                    shader_pipeline_info.vertex_input_state.num_vertex_attributes =
                        static_cast<Uint32>(color_attributes.size());
                }
#endif
                // A custom material installed only as a shadow caster keeps
                // its vertex stage and drops the placeholder fragment. SDL
                // still requires a fragment stage for a depth-only pipeline,
                // so use the existing no-output depth fragment. The pipeline
                // targets the generator's one-sample depth32 texture and uses
                // its standard-Z comparison, just like the composed families.
                if (render_features.shader_shadow_variants[variant]) {
                    if (!depth_only_fragment_shader) {
                        gpu_error("Shader shadow caster requires the depth-only fragment");
                    }
                    SDL_GPUGraphicsPipelineCreateInfo shadow_pipeline_info = shader_pipeline_info;
                    shadow_pipeline_info.fragment_shader = depth_only_fragment_shader.get();
                    shadow_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
                    shadow_pipeline_info.depth_stencil_state.compare_op =
                        gpu_depth_compare(pass_depth_compare(true));
                    shadow_pipeline_info.target_info.color_target_descriptions = nullptr;
                    shadow_pipeline_info.target_info.num_color_targets = 0;
                    shadow_pipeline_info.target_info.depth_stencil_format =
                        SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
                    shadow_pipeline_info.target_info.has_depth_stencil_target = true;
                    state.shader_shadow_pipelines[variant] =
                        create_sdl_graphics_pipeline(state.device, &shadow_pipeline_info);
                    if (!state.shader_shadow_pipelines[variant]) {
                        gpu_error("SDL_CreateGPUGraphicsPipeline shader shadow caster");
                    }
                }
                // `fragment.present` describes the reflected custom-uniform
                // block, not whether the shader has a fragment stage. A
                // colour shader with no fragment uniforms still needs its
                // ordinary pipeline; the shadow pipeline above is an
                // additional depth-only view, never a replacement for it.
                if (!variant_fragment_shader)
                    continue;
                state.shader_pipelines[variant] =
                    create_sdl_graphics_pipeline(state.device, &shader_pipeline_info);
                if (!state.shader_pipelines[variant]) {
                    gpu_error("SDL_CreateGPUGraphicsPipeline shader material");
                }
                // The one a2c rule (pal_gpu_shared.hpp): coverage needs
                // samples to spread across, so a single-sample run draws
                // the same un-cut pixels Dawn does instead of a2c's
                // implicit 0.5 cutoff.
                shader_pipeline_info.multisample_state.enable_alpha_to_coverage =
                    alpha_to_coverage_enabled(true, gpu_sample_count_value(state.sample_count));
                state.shader_a2c_pipelines[variant] =
                    create_sdl_graphics_pipeline(state.device, &shader_pipeline_info);
                if (!state.shader_a2c_pipelines[variant]) {
                    gpu_error("SDL_CreateGPUGraphicsPipeline alpha to coverage");
                }
                if (!scene.tasks.empty()) {
                    state.shader_task_pipelines[variant] = ShaderTaskPipeline{
                        std::move(shader_vertex_shaders[variant]),
                        std::move(shader_fragment_shaders[variant]), shader_pipeline_info};
                }
            }
        }
        state.geometry_tasks.resize(engine.frame_tasks.size());
        if (!scene.tasks.empty()) {
            auto blit_vertex_shader = load_shader(state.device, "blit.vert",
                                                  SDL_GPU_SHADERSTAGE_VERTEX, 0, 0, "mainVertex");
            auto blit_fragment_shader = load_shader(
                state.device, "blit.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, 1, 0, "mainFragment");
            SDL_GPUColorTargetDescription blit_target{};
            blit_target.format = swapchain_format;
            SDL_GPUGraphicsPipelineCreateInfo blit_pipeline_info{};
            blit_pipeline_info.vertex_shader = blit_vertex_shader.get();
            blit_pipeline_info.fragment_shader = blit_fragment_shader.get();
            blit_pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
            blit_pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
            blit_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            blit_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            blit_pipeline_info.target_info.color_target_descriptions = &blit_target;
            blit_pipeline_info.target_info.num_color_targets = 1;
            state.blit_pipeline = create_sdl_graphics_pipeline(state.device, &blit_pipeline_info);
            if (!state.blit_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline blit");
            }
            blit_pipeline_info.multisample_state.sample_count = state.sample_count;
            state.blit_msaa_pipeline =
                create_sdl_graphics_pipeline(state.device, &blit_pipeline_info);
            if (!state.blit_msaa_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline blit MSAA");
            }
        }
        if (id_fragment_shader) {
            SDL_GPUColorTargetDescription id_target{};
            id_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo id_pipeline_info = pipeline_info;
            id_pipeline_info.fragment_shader = id_fragment_shader.get();
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            id_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            id_pipeline_info.target_info.color_target_descriptions = &id_target;
            state.id_pipeline = create_sdl_graphics_pipeline(state.device, &id_pipeline_info);
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.id_double_sided_pipeline =
                create_sdl_graphics_pipeline(state.device, &id_pipeline_info);
        }
        if (cluster_fragment_shader) {
            SDL_GPUColorTargetDescription cluster_target{};
            cluster_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo cluster_pipeline_info = pipeline_info;
            cluster_pipeline_info.fragment_shader = cluster_fragment_shader.get();
            cluster_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            cluster_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            cluster_pipeline_info.target_info.color_target_descriptions = &cluster_target;
            state.cluster_pipeline =
                create_sdl_graphics_pipeline(state.device, &cluster_pipeline_info);
            cluster_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.cluster_double_sided_pipeline =
                create_sdl_graphics_pipeline(state.device, &cluster_pipeline_info);
        }
        color_target.blend_state = blend_state_from(transparent_blend);
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.depth_stencil_state.enable_depth_write = false;
#if BBLITE_PINNED_BACKGROUNDS
        // The background arms build over the pass state every scene
        // pipeline shares; their own buffers and textures upload with the
        // environment below.
        const SDL_GPUGraphicsPipelineCreateInfo background_base = pipeline_info;
        const SDL_GPUColorTargetDescription background_target = color_target;
#endif
        if (id_fragment_shader && (!state.id_pipeline || !state.id_double_sided_pipeline)) {
            gpu_error("SDL_CreateGPUGraphicsPipeline ID buffer");
        }
        if (cluster_fragment_shader &&
            (!state.cluster_pipeline || !state.cluster_double_sided_pipeline)) {
            gpu_error("SDL_CreateGPUGraphicsPipeline triangle cluster");
        }

        vertex_shader.reset();
#if BBLITE_RENDERER_TRANSMISSION
        image_processing_vertex_shader.reset();
        image_processing_fragment_shader.reset();
#endif
        depth_only_fragment_shader.reset();
        shader_vertex_shaders.clear();
        shader_fragment_shaders.clear();
        id_fragment_shader.reset();
        cluster_fragment_shader.reset();

        SDL_GPUSamplerCreateInfo sampler_info{};
        sampler_info.min_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mag_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
        sampler_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.max_lod = 1000.0f;
        state.sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.sampler)
            gpu_error("SDL_CreateGPUSampler");
#if BBLITE_RENDERER_TRANSMISSION
        // Scene-color grab sampler mirrors Babylon Lite's
        // trilinear-anisotropic sampler: linear filters, repeat
        // addressing, and the shared anisotropy (inert under
        // explicit-LOD sampling but kept for descriptor parity).
        sampler_info.enable_anisotropy = true;
        sampler_info.max_anisotropy = static_cast<float>(transmission_sampler_max_anisotropy);
        state.transmission_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.transmission_sampler) {
            gpu_error("SDL_CreateGPUSampler transmission");
        }
        sampler_info.enable_anisotropy = false;
        sampler_info.max_anisotropy = 0.0f;
#endif
#if BBLITE_GPU_MORPH_STORAGE
        {
            const std::array<float, 1> zero_delta{0.0f};
            state.empty_morph_deltas =
                upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                              zero_delta.data(), sizeof(zero_delta));
            state.empty_morph_weights =
                upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                              empty_morph_weight_data.data(), sizeof(empty_morph_weight_data));
        }
#endif
        sampler_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.background_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.background_sampler)
            gpu_error("SDL_CreateGPUSampler background");
        sampler_info.max_lod = 0.0f;
        state.ground_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.ground_sampler) {
            gpu_error("SDL_CreateGPUSampler ground");
        }
        sampler_info.max_lod = 1000.0f;
        sampler_info.min_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mag_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        state.depth_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.depth_sampler) {
            gpu_error("SDL_CreateGPUSampler depth");
        }
#if BBLITE_HAS_POST_PROCESS
        {
            SDL_GPUSamplerCreateInfo post_process_info{};
            post_process_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
            post_process_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
            post_process_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
            post_process_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
            post_process_info.min_filter = SDL_GPU_FILTER_NEAREST;
            post_process_info.mag_filter = SDL_GPU_FILTER_NEAREST;
            state.post_process_nearest_sampler =
                SDL_CreateGPUSampler(state.device, &post_process_info);
            if (!state.post_process_nearest_sampler) {
                gpu_error("SDL_CreateGPUSampler post-process nearest");
            }
            post_process_info.min_filter = SDL_GPU_FILTER_LINEAR;
            post_process_info.mag_filter = SDL_GPU_FILTER_LINEAR;
            state.post_process_bilinear_sampler =
                SDL_CreateGPUSampler(state.device, &post_process_info);
            if (!state.post_process_bilinear_sampler) {
                gpu_error("SDL_CreateGPUSampler post-process bilinear");
            }
        }
#endif
        cpu_startup_mark("shaders-pipelines");
        state.environment =
            upload_environment(state.device, scene.environment, 6, false, &state.environment_gpu);
        state.brdf_lut = upload_brdf_lut(state.device, scene.environment);
        if (use_standard_material) {
            state.reflection_fallback = upload_cube_texture(state.device, nullptr);
            state.reflection_cubes.reserve(engine.reflection_cubes.size());
            for (const auto& cube : engine.reflection_cubes) {
                state.reflection_cubes.push_back(upload_cube_texture(state.device, &cube));
            }
        }
#if BBLITE_PINNED_BACKGROUNDS
        state.background_draws = pal::select_pinned_backgrounds(frame_options, scene.environment);
        create_background_arms(state, scene, background_base, background_target);
#endif
        cpu_startup_mark("environment-background");
        render_plan = upstream::build_render_plan(scene, engine);
        // Every item's kind and variant against the generated tables
        // before anything uploads — the same shared walk the Dawn
        // backend runs, so a plan the build cannot draw fails here
        // rather than at (or past) the draw.
        validate_render_plan_items(render_plan);
        cpu_startup_mark("render-plan");

#if BBLITE_HAS_PICKING
        // The pick pass. Installed once the mesh buffers and the cloud
        // textures exist, because that is what it draws; a pick taken
        // before this point reports a miss, exactly as the pin's own
        // `pickAsync` does for a scene with no camera. The guard clears
        // the hook when this scope ends, however it ends: the hook holds
        // `state`, the scene and the render plan by reference, all of
        // which die with the scope.
        data_.pick_hook_guard.emplace(engine);
#if BBLITE_HAS_BILLBOARDS
        // The contributor's own GPU state, scoped to the hook it serves:
        // upstream it lives in the closure the picker cached and frees in
        // `disposePicker`, which is this scope.

#endif
        engine.pick_hook = [&state, &engine, &root_plan = render_plan, &overlay_plans,
                            &active_registered_scenes
#if BBLITE_HAS_BILLBOARDS
                            ,
                            &billboard_pick
#endif
        ]([[maybe_unused]] GpuPickerHandle picker, double x, double y,
                           const Engine::PickFilter* filter) -> PickingInfo {
            return pick_sdl_scene(state, engine, root_plan, overlay_plans, active_registered_scenes,
                                  picker, x, y, filter
#if BBLITE_HAS_BILLBOARDS
                                  ,
                                  billboard_pick
#endif
            );
        };
#endif
        for (const upstream::RenderItem& item : render_plan.items) {
            state.meshes.push_back(upload_sdl_scene_mesh(state, engine, item));
        }
        // Swapchain overlay layers: every scene registered after the first.
        // `configureSwapchainOverlayScene` is the pin's own trigger -- a
        // later scene sharing the surface keeps the base scene's colour and
        // clears only its own depth -- so registration order is what makes
        // a layer, exactly as it does upstream. Each layer owns a plan and
        // an uploaded mesh array because a draw command indexes its plan.
        // Each layer rematches changed rows before encoding the next frame.

        for (std::size_t layer = 1; layer < engine.registered_scenes.size(); ++layer) {
            Scene* overlay_scene = engine.registered_scenes[layer].get();
            if (!overlay_scene)
                continue;
            upstream::RenderPlan overlay_plan = upstream::build_render_plan(*overlay_scene, engine);
            validate_render_plan_items(overlay_plan);
            std::vector<GpuMesh> overlay_layer_meshes;
            overlay_layer_meshes.reserve(overlay_plan.items.size());
            for (const upstream::RenderItem& item : overlay_plan.items) {
                overlay_layer_meshes.push_back(upload_sdl_scene_mesh(state, engine, item));
            }
            overlay_plans.push_back(std::move(overlay_plan));
            state.overlay_meshes.push_back(std::move(overlay_layer_meshes));
            overlay_topology_versions.push_back(overlay_scene->render_topology_version);
        }
        cpu_startup_mark("mesh-uploads");
        task_draw_lists.resize(engine.frame_tasks.size());

        rebuild_task_draw_lists();
        cpu_startup_mark("draw-lists-ready");
        synced_render_topology_version = scene.render_topology_version;
        synced_draw_list_epoch = engine.draw_list_epoch;
        synced_material_family_mask = scene.material_family_mask;

#if BBLITE_HAS_TEXT
        state.text = std::make_unique<SdlTextRenderer>(
            state.device, !environment_variable("BBLITE_RENDER_CAPTURE").empty());
        state.text->device->color_format = swapchain_format;
        state.text->device->depth_format = state.depth_format;
        const std::string text_color_format =
            swapchain_format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ? "bgra8unorm"
            : swapchain_format == SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM
                ? "rgba8unorm"
                : throw std::runtime_error("Unrepresented default text color target.");
        const auto& text_surface = bbl::text_surface(engine);
        text_surface->device = state.text->device;
        state.text->scene.bind(
            scene, text_surface,
            TextTargetSignature{
                .color_format = text_color_format,
                .depth_format = "depth24plus-stencil8",
                .depth_compare = std::nullopt,
                .sample_count = static_cast<double>(gpu_sample_count_value(state.sample_count))});
#endif

#if BBLITE_HAS_UI && !BBLITE_WORKERS

#endif

        // Caller-owned scratch for the custom-shader stage blocks: the
        // packer fills it in place, so the per-draw pushes reuse one
        // allocation across draws and frames.

#if BBLITE_GPU_INSTANCING && BBLITE_PBR_VARIANTS > 0

#endif
        // The shared drain owns the per-event contract; the scene loop
        // only adds its camera-controls dispatch, which rides the hook so
        // every event the scene receives also reaches the camera -- and
        // none does in a deterministic test pass.

        // One batch for the run: its transfer buffer persists across
        // frames, so a per-frame mesh mutation stages its dirty span and
        // shares one copy-pass submission instead of paying a
        // transfer-buffer create/release per frame.
        data_.frame_buffer_uploads.emplace(state.device);
#if BBLITE_DEVICE_RECOVERY
        data_.draw_count_scope.emplace(engine);
#endif
    }

    FramePreparation prepare() {
        frame_.emplace();
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& input_replay = data_.input_replay;
        [[maybe_unused]] auto& running = data_.running;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& pointer_state = data_.pointer_state;
        [[maybe_unused]] auto& surface_pointer_state = data_.surface_pointer_state;
        [[maybe_unused]] auto& state = data_.resources.state;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.resources.ui_runtime;
#endif
        [[maybe_unused]] auto& hidden_test_pass = data_.frame_options.test_pass;
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_target = *data_.offscreen_target;
#endif
        [[maybe_unused]] auto& start = current_frame().start;
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_texture = current_frame().offscreen_texture;
#endif
        const auto camera_pointer_hook = [&](const SDL_Event& event) {
            if (hidden_test_pass && !is_replayed_ui_event(event))
                return;
            dispatch_surface_camera_pointer(engine, event, active_camera(), pointer_state,
                                            surface_pointer_state);
        };

#if BBLITE_DEVICE_RECOVERY
        engine.draw_call_count = 0;
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
        state.node_capture.capture.begin_frame(static_cast<std::uint64_t>(frame));
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        poll_platform_events(
            engine, running, hidden_test_pass,
            [&](SDL_Event& event) { return handle_ui_rml_event(*ui_runtime, event); },
            camera_pointer_hook);
#else
        poll_platform_events(
            engine, running, hidden_test_pass, [](const SDL_Event&) { return true; },
            camera_pointer_hook);
#endif
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen && !running)
            return FramePreparation::stop;
#endif
        input_replay.dispatch(frame, state.window, engine);
        sync_engine_canvas_size(state.window, engine);
        if (request_renderer_restart_if_scene_set_changed(engine, active_registered_scenes)) {
            return FramePreparation::restart;
        }
        // The swapchain is acquired before the scene advances, because
        // SDL only reports an unavailable texture *from*
        // `SDL_WaitAndAcquireGPUSwapchainTexture` -- it cannot be tested
        // for first. An iteration that gets none produces no frame, so it
        // must not advance the clock, run the before-render callbacks or
        // upload anything either; those all live below the check now, and
        // time stops behind a minimised window the way a throttled
        // `requestAnimationFrame` stops it. The cost of the early acquire
        // is holding the image across the scene half of the frame.
        //
        // The benchmark bracket therefore starts here, covering the whole
        // loop body; `pal_dawn.cpp` starts its own at the same point so
        // the published pair stays comparable.
        start = monotonic_milliseconds();
#if BBLITE_OFFSCREEN_SURFACES
        offscreen_texture = nullptr;
        if (offscreen) {
            offscreen_texture =
                offscreen_target.acquire(static_cast<Uint32>(engine.options.width),
                                         static_cast<Uint32>(engine.options.height), *offscreen);
            if (!offscreen_texture) {
                current_frame().yield_when_skipped = true;
                return FramePreparation::skip;
            }
        }
#endif

        return FramePreparation::ready;
    }

    bool acquire() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& state = data_.resources.state;
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
        [[maybe_unused]] auto& acquired = current_frame().acquired;
        [[maybe_unused]] auto& width = current_frame().width;
        [[maybe_unused]] auto& height = current_frame().height;
        [[maybe_unused]] auto& swapchain = current_frame().swapchain;
        [[maybe_unused]] auto& command = current_frame().command;
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_texture = current_frame().offscreen_texture;
#endif
        command = SdlGpuCommand{SDL_AcquireGPUCommandBuffer(state.device)};
        if (!command)
            gpu_error("SDL_AcquireGPUCommandBuffer");
        swapchain = nullptr;
        width = 0;
        height = 0;
#if BBLITE_OFFSCREEN_SURFACES
        if (offscreen) {
            width = static_cast<Uint32>(engine.options.width);
            height = static_cast<Uint32>(engine.options.height);
            swapchain = offscreen_texture;
        } else
#endif
            if (!command.acquire_swapchain(state.window, &swapchain, &width, &height)) {
            gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture");
        }
        if (!swapchain) {
            command.reset();
            return false;
        }
        // The three phase stamps below feed only the CPU profile, so
        // with profiling off they cost nothing; `start` and `end` stay
        // unconditional because the benchmark bracket reads them.
        acquired = cpu_profile ? monotonic_milliseconds() : 0.0;
        // The frame trace, sprite passes and animated billboard passes
        // read the frame's own delta.

        return true;
    }

    FramePreparation update() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& frame_clock = data_.frame_clock;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& active_registered_scenes = data_.active_registered_scenes;
        [[maybe_unused]] auto& scene = data_.scene;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& ui_runtime = data_.resources.ui_runtime;
#endif
        [[maybe_unused]] auto& delta_ms = current_frame().delta_ms;
        [[maybe_unused]] auto& updated = current_frame().updated;
        [[maybe_unused]] auto& width = current_frame().width;
        [[maybe_unused]] auto& height = current_frame().height;
        [[maybe_unused]] auto& command = current_frame().command;
        delta_ms = advance_frame(engine, scene, frame_clock, frame_options.frame_delta_ms);
        // A before-render callback can replace the scene (for example,
        // leaving Attract mode with Escape). Its old plan and material
        // views are no longer valid, even though the wrapper stays alive.
        if (request_renderer_restart_if_scene_set_changed(engine, active_registered_scenes)) {
            // SDL forbids cancelling after acquiring a swapchain image.
            // Submit the empty buffer to release it without stale draws.
            if (!command.submit()) {
                gpu_error("SDL_SubmitGPUCommandBuffer on scene replacement");
            }
            return FramePreparation::restart;
        }
#if BBLITE_GPU_TASK_TIMING
        begin_gpu_task_timing_frame(engine);
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
        begin_compute_frame_prefix(engine);
#endif
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        // Browser layout observes DOM changes made by this turn's RAF
        // callbacks before painting the frame.
        update_ui_rml_runtime(*ui_runtime, width, height);
#endif
        updated = cpu_profile ? monotonic_milliseconds() : 0.0;

        return FramePreparation::ready;
    }

    /**
     * The GPU writes one plan row's refresh makes (`sync_plan_mesh_rows`),
     * staged into the frame's upload batch. The mesh world and deformation
     * blocks are pushed per draw on this backend, so a row writes none.
     */
    struct MeshRowUploads {
        GpuState& state;
        GpuBufferUploadBatch& uploads;

#if BBLITE_GPU_INSTANCING
        void recreate_instances(GpuMesh& gpu, const MeshRecord& mesh) {
            // SDL retires a released buffer only once the command buffers
            // still holding it have finished.
            const std::size_t rows = mesh.instance_matrices.size();
            SDL_ReleaseGPUBuffer(state.device, gpu.instances);
            gpu.instances = uploads.upload(
                SDL_GPU_BUFFERUSAGE_VERTEX | SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                mesh.instance_matrices.data(), rows * sizeof(mesh.instance_matrices.front()));
#if BBLITE_GPU_INSTANCE_COLORS
            if (gpu.instance_colors) {
                // The colour mirror is the scene's own array and may still
                // be the shorter one; pad to the pool the way registration
                // does.
                std::vector<float> instance_colors = instance_colors_for_upload(mesh);
                instance_colors.resize(rows * 4, 1.0f);
                SDL_ReleaseGPUBuffer(state.device, gpu.instance_colors);
                gpu.instance_colors =
                    uploads.upload(SDL_GPU_BUFFERUSAGE_VERTEX, instance_colors.data(),
                                   instance_colors.size() * sizeof(float));
            }
#endif
        }

        void update_instances(GpuMesh& gpu, const MeshRecord& mesh, std::size_t active_count) {
            uploads.update(gpu.instances, mesh.instance_matrices.data(),
                           active_count * sizeof(mesh.instance_matrices.front()));
#if BBLITE_GPU_INSTANCE_COLORS
            if (gpu.instance_colors) {
                const auto colors = instance_colors_for_upload(mesh);
                if (colors.size() >= active_count * 4) {
                    uploads.update(gpu.instance_colors, colors.data(),
                                   active_count * 4 * sizeof(float));
                }
            }
#endif
        }
#endif

        void write_mesh_blocks(const Scene&, const upstream::RenderItem&, const MeshRecord&,
                               GpuMesh&) {}

#if BBLITE_MESH_POSITION_UPDATE
        void upload_vertices(GpuMesh& gpu, const std::vector<GpuVertex>& vertices) {
            uploads.update(gpu.vertices, vertices.data(), vertices.size() * sizeof(GpuVertex));
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            state.node_capture.update(gpu.vertices, vertices.data(),
                                      vertices.size() * sizeof(GpuVertex));
#endif
        }
#endif

#if BBLITE_GPU_MORPH_STORAGE
        void upload_morph_weights(GpuMesh& gpu, const ModelGeometry& geometry,
                                  const MeshRecord& mesh) {
            sync_morph_weights(uploads, gpu, geometry, mesh);
        }
#endif
    };

    /** The SDL_GPU operations `synchronize_scene` orders. */
    struct SceneSync {
        SdlSceneRun& run;
        MeshRowUploads rows;

        void update_sprites([[maybe_unused]] double delta_ms) {
#if BBLITE_HAS_SPRITE_RENDERER
            auto& data = run.data_;
            auto& resources = data.resources;
            // `_update` for every sprite context precedes every `_record`,
            // sharing the scene's one batched upload submission.
            // Registration controls drawing, not whether its layer data
            // stays current.
            sync_sdl_scene_sprites(rows.state, data.engine, resources.sprite_passes,
                                   resources.sprite_render_textures, data.swapchain_format);
            for (SpritePass& sprite_pass : resources.sprite_passes) {
                // `spriteRendererUpdate` runs the renderer's own hooks
                // before it reads its layers, so an overlay HUD's hook is
                // seen by this frame rather than the next.
                begin_sprite_renderer_update(data.engine, sprite_pass.renderer, delta_ms);
                sync_sprite_pass_layers(rows.state.device, data.engine, sprite_pass,
                                        resources.sprite_render_textures);
                upload_sprite_pass(rows.state.device, data.engine, sprite_pass, delta_ms,
                                   rows.uploads);
            }
            if (resources.has_scene_sprite_pass) {
                upload_scene_sprite_pass(rows.state.device, data.engine,
                                         resources.scene_sprite_pass, delta_ms, rows.uploads);
            }
#endif
        }

        void release_mesh(GpuMesh& mesh) { release_gpu_mesh(rows.state, mesh); }

        GpuMesh upload_mesh(const upstream::RenderItem& item) {
            return upload_sdl_scene_mesh(rows.state, run.data_.engine, item, &rows.uploads);
        }

        // SDL releases GPU resources only once pending command buffers are
        // finished with them, so a rematch retires removed entries at once
        // without stalling every topology update on the whole GPU.
        void prune_shared_resources() {
            prune_shared_shader_geometries(rows.state);
            prune_shared_shader_material_textures(rows.state);
            prune_shared_composed_material_textures(rows.state);
        }

        // This backend's residue beside the shared table guard: its modules
        // are built eagerly at startup, so a family the initial plan never
        // reached has none.
        void reject_unbuilt_family_growth(std::uint32_t added_families) const {
            if ((added_families & material_family_shader) != 0 &&
                rows.state.shader_pipelines.empty()) {
                throw std::runtime_error(
                    "Post-registration shader material family has no reached pipeline.");
            }
        }

        std::size_t shared_shader_geometry_count() const {
            return rows.state.shared_shader_geometries.size();
        }
        std::size_t shared_shader_material_count() const {
            return rows.state.shared_shader_material_textures.size();
        }

        void rebuild_task_draw_lists() { run.rebuild_task_draw_lists(); }

        MeshRowUploads& mesh_rows() { return rows; }

        void publish_storage() {
            sync_shader_storage_buffers(rows.state, run.data_.engine, rows.uploads);
        }

        void submit_uploads() { rows.uploads.submit(); }

        void mark_uploaded() {
            run.current_frame().uploaded = run.data_.cpu_profile ? monotonic_milliseconds() : 0.0;
        }

        void settle_pass(const SceneSyncOutcome& outcome) {
            Frame& frame = run.current_frame();
            frame.surface_extent = outcome.surface_extent;
            frame.frame_camera = outcome.pass.matrices;
            frame.frame_pass_matrices = frame.frame_camera.pass();
        }

        void stream_bone_palettes() {
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
            // The pin's bone palettes for every draw the gate resolves,
            // streamed here because a copy pass cannot open inside the
            // render pass. The draw branch keys its skinned handling on the
            // texture this leaves behind.
            //
            // A palette is per PLAN ITEM, not per draw, and the same item
            // is drawn by the main lists and again by every task that names
            // it as a caster -- a cascaded generator alone draws each of its
            // casters once per cascade. Each upload is a transfer buffer, a
            // copy pass and its own submit, so the sweep streams an item
            // once and the later sightings of it cost one lookup.
            auto& data = run.data_;
            Engine& engine = data.engine;
            GpuState& state = rows.state;
            std::vector<bool>& streamed = state.streamed_palettes;
            streamed.assign(state.meshes.size(), false);
            const auto stream_palettes = [&]([[maybe_unused]] const Scene& palette_scene,
                                             std::vector<GpuMesh>& meshes,
                                             const upstream::RenderDrawList& list) {
                for (const upstream::RenderDrawCommand& draw : list.commands) {
                    if (draw.item_index >= meshes.size())
                        continue;
                    if (draw.item.mesh.value >= engine.meshes.size()) {
                        continue;
                    }
                    if (streamed[draw.item_index])
                        continue;
                    bool skeleton_draw = false;
#if BBLITE_STANDARD_SKELETON
                    if (draw.item.material_kind == upstream::RenderMaterialKind::standard) {
                        const std::size_t variant =
                            standard_variant_for_draw(palette_scene, engine, draw);
                        skeleton_draw =
                            variant != npos && upstream::standard_variant_skeleton(
                                                   upstream::standard_variants[variant]);
                    }
#endif
#if BBLITE_PBR_VARIANTS > 0
                    const std::size_t palette_variant =
                        pinned_variant_for_draw(palette_scene, engine, draw);
                    if (palette_variant != npos) {
#if BBLITE_VAT
                        // Copy passes must precede render passes for baked
                        // palettes as well as live palettes.
                        if (pinned_variant_vat(palette_variant)) {
                            write_pinned_vat_texture(state, meshes[draw.item_index],
                                                     handle_at(engine.meshes, draw.item.mesh),
                                                     engine);
                            streamed[draw.item_index] = true;
                            continue;
                        }
#endif
                        skeleton_draw = pinned_variant_skeleton(palette_variant);
                    }
#endif
                    if (!skeleton_draw)
                        continue;
                    write_pinned_bone_texture(state, meshes[draw.item_index],
                                              handle_at(engine.meshes, draw.item.mesh));
                    streamed[draw.item_index] = true;
                }
            };
            stream_palettes(data.scene, state.meshes, data.render_plan.draw_lists.opaque);
            stream_palettes(data.scene, state.meshes, data.render_plan.draw_lists.transparent);
            for (const upstream::RenderDrawLists& task_lists : data.task_draw_lists) {
                stream_palettes(data.scene, state.meshes, task_lists.opaque);
                stream_palettes(data.scene, state.meshes, task_lists.transparent);
            }
            for (std::size_t layer = 0;
                 layer < data.overlay_plans.size() && layer < state.overlay_meshes.size();
                 ++layer) {
                const Scene* overlay_scene = engine.registered_scenes[layer + 1u].get();
                if (!overlay_scene)
                    continue;
                auto& meshes = state.overlay_meshes[layer];
                streamed.assign(meshes.size(), false);
                stream_palettes(*overlay_scene, meshes,
                                data.overlay_plans[layer].draw_lists.opaque);
                stream_palettes(*overlay_scene, meshes,
                                data.overlay_plans[layer].draw_lists.transparent);
            }
#endif
        }

        void mark_capture(bool topology_updated) {
            auto& data = run.data_;
            const FrameOptions& options = data.frame_options;
            Frame& frame = run.current_frame();
            frame.capture_ready = data.frame >= options.screenshot_frame && !topology_updated &&
                                  data.captures.drains_resolved();
            frame.capture_frame = frame.capture_ready && !data.captures.screenshot_saved &&
                                  !options.screenshot_path.empty();
            frame.capture_ids = frame.capture_ready && !data.captures.id_buffer_saved &&
                                !options.id_buffer_path.empty();
            frame.capture_clusters = frame.capture_ready && !data.captures.cluster_buffer_saved &&
                                     !options.cluster_buffer_path.empty();
        }

        void update_clustered_lights([[maybe_unused]] const SceneSyncOutcome& outcome) {
#if BBLITE_HAS_CLUSTERED_LIGHTS
            // The cluster binning reads this frame's camera and the draws
            // read what it wrote. The pin's updater runs for every colour
            // pass over its camera and target, and its refresh returns
            // without a camera (render-task-base.ts, clustered.ts).
            Engine& engine = run.data_.engine;
            const Scene& scene = run.data_.scene;
            if (ClusteredLightContainer* clustered =
                    upstream::clustered_container(engine, scene.clustered_lights)) {
                upload_clustered_lights(rows.state.device, engine, *clustered, scene.camera,
                                        static_cast<double>(outcome.surface_extent.width),
                                        static_cast<double>(outcome.surface_extent.height),
                                        rows.state.clustered);
            }
#endif
        }

        void update_text([[maybe_unused]] const SceneSyncOutcome& outcome) {
#if BBLITE_HAS_TEXT
            update_scene_text(*rows.state.text, run.data_.scene, run.data_.frame,
                              outcome.surface_extent, outcome.pass);
#endif
        }

        void upload_billboards([[maybe_unused]] const SceneSyncOutcome& outcome,
                               [[maybe_unused]] double delta_ms) {
#if BBLITE_HAS_BILLBOARDS
            // Uploaded here because the upload submits a command buffer of
            // its own; the draw reads the same view.
            for (BillboardPass& billboard : rows.state.billboard_passes) {
                upload_billboard_pass(rows.state.device, run.data_.scene, run.data_.engine,
                                      billboard, outcome.pass.matrices.view, delta_ms);
            }
#endif
        }

        void upload_splats([[maybe_unused]] const SceneSyncOutcome& outcome) {
#if BBLITE_HAS_SPLATS
            // The sort runs on this thread before the draw that reads it,
            // which is the state `firstSortReady` waits for. The renderable
            // tests `scene.camera`, not the pass's.
            Engine& engine = run.data_.engine;
            GpuState& state = rows.state;
            const CameraPassMatrices& matrices = outcome.pass.matrices;
            const CameraRecord* const camera = scene_camera(engine, run.data_.scene);
            for (SplatPass& splat : state.splat_passes) {
                upload_splat_pass(state.device, engine, splat, camera, matrices.view);
            }
#endif
        }

        void capture_render_state() {
#if !BBLITE_HAS_TAA && !BBLITE_HAS_TEXT
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            if (!rows.state.node_capture.capture.enabled())
#endif
                run.capture_render_state();
#endif
        }

        // This backend pushes each pass's blocks at its draws.
        void write_pass_blocks(const SceneSyncOutcome&) {}
    };

    void synchronize() {
        State& data = data_;
        Frame& frame = current_frame();
        SceneSync hooks{*this, MeshRowUploads{data.resources.state, *data.frame_buffer_uploads}};
        SceneSyncState<GpuMesh> sync{data.engine,
                                     data.scene,
                                     data.frame,
                                     frame.delta_ms,
                                     frame.width,
                                     frame.height,
                                     data.render_plan,
                                     data.overlay_plans,
                                     data.overlay_topology_versions,
                                     data.resources.state.meshes,
                                     data.resources.state.overlay_meshes,
                                     data.synced_render_topology_version,
                                     data.synced_draw_list_epoch,
                                     data.synced_material_family_mask,
                                     data.camera_trace_state,
                                     data.pass_blocks};
        static_cast<void>(synchronize_scene(sync, hooks));
    }

    void encode() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame_options = data_.frame_options;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& overlay_plans = data_.overlay_plans;
        [[maybe_unused]] auto& overlay_topology_versions = data_.overlay_topology_versions;
        [[maybe_unused]] auto& task_draw_lists = data_.task_draw_lists;
        [[maybe_unused]] auto& shader_block_scratch = data_.shader_block_scratch;
        [[maybe_unused]] auto& swapchain_format = data_.swapchain_format;
        [[maybe_unused]] const bool transmission_enabled = data_.transmission_enabled;
        [[maybe_unused]] auto& state = data_.resources.state;
        [[maybe_unused]] auto& pass_blocks = data_.pass_blocks;
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& sprite_passes = data_.resources.sprite_passes;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& sprite_render_textures = data_.resources.sprite_render_textures;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& scene_sprite_pass = data_.resources.scene_sprite_pass;
#endif
#if BBLITE_HAS_SPRITE_RENDERER
        [[maybe_unused]] auto& has_scene_sprite_pass = data_.resources.has_scene_sprite_pass;
#endif
        // The scene's own pass camera, the one the frame's matrices were
        // settled from.
        const CameraRecord* const camera = scene_pass_camera(engine, scene);
        [[maybe_unused]] auto& frame_buffer_uploads = *data_.frame_buffer_uploads;
        [[maybe_unused]] auto& width = current_frame().width;
        [[maybe_unused]] auto& height = current_frame().height;
        [[maybe_unused]] const auto& matrix = current_frame().frame_camera.view_projection;
        [[maybe_unused]] const auto& frame_view = current_frame().frame_camera.view;
        [[maybe_unused]] const auto& frame_projection = current_frame().frame_camera.projection;
        [[maybe_unused]] const auto& frame_camera_position =
            current_frame().frame_camera.camera_position;
        [[maybe_unused]] auto& frame_pass_matrices = current_frame().frame_pass_matrices;
        [[maybe_unused]] const auto& capture_frame = current_frame().capture_frame;
        [[maybe_unused]] auto& swapchain = current_frame().swapchain;
        [[maybe_unused]] auto& command = current_frame().command;
        [[maybe_unused]] auto& capture_texture = current_frame().capture_texture;
        [[maybe_unused]] auto& visible_color = current_frame().visible_color;
#if BBLITE_COMPUTE_FRAME_GRAPH
        SdlGpuCommand surface_command{nullptr};
        if (compute_frame_prefix_deferred(engine)) {
            surface_command = std::move(command);
            command = SdlGpuCommand{SDL_AcquireGPUCommandBuffer(state.device)};
            if (!command)
                gpu_error("SDL_AcquireGPUCommandBuffer shadow prefix");
        }
#endif
        current_frame().graph = !scene.tasks.empty();
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        current_frame().ui_frame = &record_ui_rml_frame(*data_.resources.ui_runtime, width, height);
        current_frame().present_swapchain = swapchain;
        swapchain = state.ui_readable_surface.target(
            state.device, swapchain, swapchain_format, width, height,
            ui_frame_reads_target(*current_frame().ui_frame) &&
                !(capture_frame && data_.frame_options.capture_ui));
#endif
        if (!engine.render_targets.empty()) {
#if BBLITE_HAS_TAA
            if (!engine.stopped)
#endif
                create_frame_graph_textures(state, engine, swapchain_format, width, height);
        }
        if (current_frame().graph) {
            capture_texture = nullptr;
#if BBLITE_HAS_TAA
            // Queue occurrences, preserving task aliases and cross-scene order.
            // No draw is encoded if a later logical hook throws.
            std::vector<std::variant<PreparedSdlScenePass, PreparedSdlPostProcessPass>>
                temporal_passes;
            if (!engine.stopped) {
#endif
                // Each registered context owns its tasks, camera and draw indices.
                // Finish its graph before composing the next context's surface.
                for (std::size_t graph_layer = 0; graph_layer < engine.registered_scenes.size();
                     ++graph_layer) {
                    const Scene& graph_scene = *engine.registered_scenes[graph_layer];
                    const auto& graph_meshes =
                        graph_layer == 0 ? state.meshes : state.overlay_meshes[graph_layer - 1];
                    const auto& graph_plan =
                        graph_layer == 0 ? render_plan : overlay_plans[graph_layer - 1];
                    const PixelViewport graph_extent =
                        scene_surface_extent(engine, graph_scene, width, height);
                    // The layer's own scene pass, whose matrix the slot-zero
                    // push carries between tasks.
                    const PassCamera graph_pass = build_kept_pass_camera(
                        graph_scene, engine, scene_pass_camera(engine, graph_scene),
                        graph_extent.width, graph_extent.height, pass_blocks.scene(graph_scene));
                    const std::array<float, 16>& graph_matrix = graph_pass.matrices.view_projection;
                    // A geometry task renders through its scene's camera.
                    const PassCamera geometry_pass = build_pass_camera(
                        graph_scene, engine, geometry_pass_camera(engine, graph_scene),
                        graph_extent.width, graph_extent.height);
#if BBLITE_SHADOW_RECEIVERS
                    update_shadow_generators(state, graph_scene, engine);
                    // CSM receiver-data callbacks can rewrite a shader storage
                    // buffer; publish that rewrite before any caster or colour
                    // draw in this command buffer reads it.
                    sync_shader_storage_buffers(state, engine, frame_buffer_uploads);
                    frame_buffer_uploads.submit();
#endif
                    SDL_PushGPUVertexUniformData(command, 0, graph_matrix.data(),
                                                 sizeof(graph_matrix));

                    const auto target_texture = [&](RenderTargetHandle handle, bool sampled,
                                                    bool depth_only = false) {
                        if (handle.value >= state.render_targets.size()) {
                            pal::refuse_invalid_frame_handle(
                                "Frame graph render target handle is invalid.");
                        }
                        const RenderTargetRecord& record = handle_at(engine.render_targets, handle);
                        if (record.swapchain)
                            return swapchain;
                        const GpuRenderTarget& target = handle_at(state.render_targets, handle);
                        if (depth_only) {
                            if (!record.sampled_depth || !target.depth) {
                                pal::fail_render_target_has_no_texture();
                            }
                            return target.depth;
                        }
                        if (pal::render_target_samples_depth(record)) {
                            if (sampled && record.has_depth && target.depth) {
                                return target.depth_copy ? target.depth_copy : target.depth;
                            }
                            pal::fail_render_target_has_no_texture();
                        }
                        return sampled ? target.sampled_color : target.color;
                    };
                    /** The depth texture a reference names. */
                    const auto task_depth_texture =
                        [&](const RenderTextureRef& reference) -> SDL_GPUTexture* {
                        if (reference.source != RenderTextureSource::geometry_depth ||
                            reference.task.value >= state.geometry_tasks.size()) {
                            throw std::runtime_error(
                                "Render task depth must name a geometry task.");
                        }
                        SDL_GPUTexture* depth =
                            handle_at(state.geometry_tasks, reference.task).depth;
                        if (!depth) {
                            throw std::runtime_error("Geometry task has no depth attachment to "
                                                     "share.");
                        }
                        return depth;
                    };
                    const auto source_texture =
                        [&](const RenderTextureRef& source) -> SDL_GPUTexture* {
                        if (source.source == RenderTextureSource::render_target) {
                            return target_texture(source.target, true, source.depth_only);
                        }
                        const FrameTaskRecord& task = handle_at(engine.frame_tasks, source.task);
                        if (task.kind != FrameTaskKind::geometry) {
                            throw std::runtime_error("Frame graph source task is not geometry.");
                        }
                        if (source.source == RenderTextureSource::geometry_output) {
                            return target_texture(task.geometry.target, true);
                        }
                        const auto found = std::find_if(
                            task.geometry.attachments.begin(), task.geometry.attachments.end(),
                            [&](const GeometryTextureDescription& description) {
                                return description.type == source.geometry_type;
                            });
                        if (found == task.geometry.attachments.end()) {
                            throw std::runtime_error(
                                "Geometry source attachment was not requested.");
                        }
                        const std::size_t attachment_index = static_cast<std::size_t>(
                            std::distance(task.geometry.attachments.begin(), found));
                        return handle_at(state.geometry_tasks, source.task)
                            .sampled_colors[attachment_index];
                    };
                    const auto gpu_mesh_index = [&](MeshHandle handle) {
                        for (std::size_t index = 0; index < graph_plan.items.size(); ++index) {
                            if (graph_plan.items[index].mesh == handle) {
                                return index;
                            }
                        }
                        return graph_meshes.size();
                    };
                    // The compiler-owned default render task replaces the
                    // ordinary scene pass when another feature (notably a
                    // shadow generator) materializes the frame graph. Its
                    // auto-mirrored mesh lists are only the opaque/transparent
                    // stages, so retain the background stages explicitly around
                    // those lists. Arbitrary user render tasks keep their own
                    // render-list-only contract (`scene_stages == false`).
#if BBLITE_PINNED_BACKGROUNDS
                    // A compiler-owned scene-stage task draws the background
                    // arms around its mirrored lists, each over the task's
                    // own scene block -- which a camera-less task keeps as it
                    // was. The mesh paths read slot zero as the task matrix,
                    // so it is restored after.
                    const auto draw_task_background =
                        [&](SDL_GPURenderPass* task_pass, TaskHandle task_handle,
                            const std::array<float, 16>& task_matrix,
                            const CameraRecord* task_camera,
                            std::optional<upstream::PinnedBackgroundArmKind> kind) {
                            if (!kind)
                                return;
                            draw_background_arm(
                                command, task_pass, state.background_arm(*kind),
                                write_pass_scene_block(pass_blocks.task(task_handle), graph_scene,
                                                       engine, task_camera, task_matrix));
                            SDL_PushGPUVertexUniformData(command, 0, task_matrix.data(),
                                                         sizeof(task_matrix));
                        };
#endif
#if BBLITE_HAS_BILLBOARDS
                    const auto draw_task_billboards =
                        [&](SDL_GPURenderPass* pass, BillboardDepthMode mode,
                            const upstream::SceneUniforms& scene_block) {
                            for (const BillboardPass& billboard : state.billboard_passes) {
                                if (handle_at(engine.billboard_systems, billboard.system)
                                        .depth_mode != mode) {
                                    continue;
                                }
                                record_billboard_pass(command, pass, engine, billboard,
                                                      scene_block);
                            }
                        };
#endif
                    const auto draw_scene = [&](const Scene& draw_context,
                                                const std::vector<GpuMesh>& draw_meshes,
                                                SDL_GPURenderPass* task_pass,
                                                const std::vector<SDL_GPUGraphicsPipeline*>&
                                                    shader_variant_pipelines,
                                                const std::vector<SDL_GPUGraphicsPipeline*>&
                                                    shader_variant_a2c_pipelines,
                                                [[maybe_unused]] const std::array<float, 16>&
                                                    draw_matrix,
                                                // Null for a pass without a camera.
                                                [[maybe_unused]] const CameraRecord* draw_camera,
                                                // The three matrices this pass
                                                // renders with, for a shader
                                                // material declaring the product
                                                // or either of its factors.
                                                [[maybe_unused]] const ShaderPassMatrices&
                                                    draw_pass_matrices,
                                                // The frame task this pass is, or
                                                // none for a scene's own pass:
                                                // whose scene block it keeps.
                                                [[maybe_unused]] std::optional<TaskHandle>
                                                    pass_task,
                                                const upstream::RenderDrawLists& draw_lists,
                                                [[maybe_unused]] const FrameTaskRecord*
                                                    geometry_task,
                                                [[maybe_unused]] const PinnedGeometryParams*
                                                    geometry_params,
                                                [[maybe_unused]] SDL_GPUBuffer*
                                                    geometry_params_buffer,
                                                // A geometry task's velocity
                                                // history, updated for the frame.
                                                [[maybe_unused]] const PinnedVelocityHistory*
                                                    velocity_history,
                                                // Set when this pass renders one
                                                // generator's shadow map: the
                                                // pass block takes the light's
                                                // own matrices and every pipeline
                                                // renders standard-Z.
                                                [[maybe_unused]] const ShadowGeneratorRecord*
                                                    shadow_generator = nullptr,
                                                [[maybe_unused]] bool draw_scene_billboard_stages =
                                                    false
#if BBLITE_HAS_TAA
                                                ,
                                                std::vector<PreparedSdlDraw>* deferred = nullptr,
                                                const std::shared_ptr<PersistentSceneUniforms>&
                                                    deferred_scene = {},
                                                std::optional<SDL_GPUSampleCount> deferred_samples =
                                                    {}
#endif
                                                ,
                                                std::optional<ShaderTaskTarget> shader_target =
                                                    {}) {
                        // Composed materials must use the render task's sample count,
                        // just as custom materials do, rather than the main target's.
                        [[maybe_unused]] const auto task_samples =
                            shader_target
                                ? std::optional<SDL_GPUSampleCount>{shader_target->samples}
#if BBLITE_HAS_TAA
                                : deferred_samples;
#else
                            : std::optional<SDL_GPUSampleCount>{};
#endif
                        bool scene_matrix_bound = true;
                        // One dispatch for both passes; only the sources
                        // differ (`secondary_pipeline_for`).
                        const SecondaryPipelines secondary{
                            &shader_variant_pipelines,
                            &shader_variant_a2c_pipelines,
                        };
                        const auto pipeline_for = [&](upstream::RenderPipelineKind kind,
                                                      std::uint32_t shader_variant) {
                            if (shader_target && pipeline_kind_traits(kind).family ==
                                                     upstream::RenderMaterialKind::shader) {
                                return state.shader_task_pipelines.at(shader_variant)
                                    .get(state.device, *shader_target,
                                         pipeline_kind_wants_a2c(kind),
                                         state.shader_pipelines.at(shader_variant),
                                         state.shader_a2c_pipelines.at(shader_variant));
                            }
                            if (shader_target &&
                                (shader_target->color != state.frame_color_format ||
                                 shader_target->depth != state.depth_format ||
                                 shader_target->samples != state.sample_count))
                                throw std::runtime_error(
                                    "Grid task pipelines require the frame attachment formats and sample count.");
                            return secondary_pipeline_for(secondary, kind, shader_variant,
                                                          "task dispatch");
                        };
#if BBLITE_PINNED_MATERIALS
                        // The pass's scene and lights blocks, once per pass
                        // rather than per draw: their builders run camera and
                        // view math whose repetition was pure cost. Every
                        // pinned family reads them, the node graphs included --
                        // this is the frame-state question, not the
                        // composed-variant one.
                        if (!draw_camera && shadow_generator) {
                            throw std::runtime_error(
                                "A shadow caster pass fills its scene block's camera lanes from "
                                "the scene's active camera; a scene without one is not reached.");
                        }
                        // A pass without a camera pushes the block it last
                        // wrote, as the pin's task keeps its scene UBO.
                        upstream::SceneUniforms pass_scene_block =
#if BBLITE_HAS_TAA
                            deferred_scene ? temporal_clean_scene_block(*deferred_scene) :
#endif
                                           write_pass_scene_block(
                                               pass_blocks.pass(draw_context, pass_task),
                                               draw_context, engine, draw_camera, draw_matrix);
#if BBLITE_SHADOW_RECEIVERS
                        // The pin installs the light-space matrices on a camera
                        // facade whose caches it pins, so its caster pass reads
                        // them straight back. There is no facade here: the pass
                        // block takes the generator's own biased view-projection
                        // and its light-space view directly.
                        // The PASS's own matrices, not the generator's: a
                        // cascaded generator renders one pass per cascade and
                        // each carries its own cascade's pair, which the
                        // caller has already resolved into these two.
                        if (shadow_generator && draw_pass_matrices.view) {
                            pass_scene_block.viewProjection = draw_matrix;
                            pass_scene_block.view = *draw_pass_matrices.view;
                        }
#endif
                        // A caster pass of the two COMPOSED families declares
                        // no lights block in either stage -- its fragment is
                        // the no-colour view -- so building the pin's 16-entry
                        // array for it would be ~2 KB zeroed and copied per
                        // frame for nothing. A node caster is the exception:
                        // the pin re-compiles the graph's own bodies for it, so
                        // its fragment still runs the lighting the graph wrote
                        // and still declares `nmeLights`. The exception is the
                        // NODE SHADOW define, not the node variant one -- a
                        // graph that neither casts nor receives never reaches a
                        // caster pass, and would otherwise pay for one.
                        const std::vector<std::uint8_t> pass_lights_block =
#if BBLITE_SHADOW_RECEIVERS && BBLITE_NODE_SHADOWS == 0
                            shadow_generator ? std::vector<std::uint8_t>{} :
#endif
                                             pinned_lights_block(draw_context, engine);
#endif
                        const auto draw_list = [&](const upstream::RenderDrawList& list) {
                            SDL_GPUGraphicsPipeline* bound_pipeline = nullptr;
                            for (const upstream::RenderDrawCommand& draw : list.commands) {
                                if (!upstream::render_item_draws_now(draw.item, engine))
                                    continue;
                                if (draw.item_index >= draw_meshes.size()) {
                                    continue;
                                }
                                const GpuMesh& mesh = draw_meshes[draw.item_index];
                                const upstream::RenderItem& draw_item = draw.item;
                                const MaterialRecord* material =
                                    handle_find(engine.materials, draw_item.material);
#if BBLITE_HAS_TAA
                                if (deferred && draw_item.material_kind !=
                                                    upstream::RenderMaterialKind::standard) {
                                    throw std::runtime_error(
                                        "Deferred temporal rendering requires a prepared material draw adapter.");
                                }
#endif
#if BBLITE_PBR_VARIANTS > 0
                                // The task pass draws PBR through the pin's own
                                // stages exactly as the main pass does, from the
                                // task's own camera and matrix.
                                if (draw_item.material_kind == upstream::RenderMaterialKind::pbr) {
                                    const std::size_t task_shader =
                                        geometry_task ? static_cast<std::size_t>(
                                                            geometry_task->geometry.shader_index)
                                                      : npos;
                                    pal::PinnedVariantKey pinned_key;
                                    const std::size_t pinned_variant = pinned_variant_for_draw(
                                        draw_context, engine, draw, task_shader, &pinned_key);
                                    if (pinned_variant == npos) {
                                        gpu_error(
                                            ("PBR draw for mesh " +
                                             std::to_string(draw_item.mesh.value) + ", material " +
                                             std::to_string(draw_item.material.value) +
                                             " resolves no pinned variant in a "
                                             "render task: " +
                                             pal::pinned_variant_request(pinned_key, task_shader))
                                                .c_str());
                                    }
                                    ensure_pinned_slots(state, pinned_variant);
                                    draw_pinned_variant(
                                        state, command, task_pass, draw_context, engine,
                                        pass_scene_block, pass_lights_block, draw, mesh, material,
                                        pinned_variant, bound_pipeline, geometry_task,
                                        geometry_params, geometry_params_buffer,
                                        shadow_generator != nullptr
#if BBLITE_SHADOWS_ESM
                                        ,
                                        shadow_generator && shadow_generator->filter ==
                                                                ShadowFilter::esm_directional
                                            ? shadow_generator->esm_index
                                            : invalid_handle
#else
                                        ,
                                        invalid_handle
#endif
                                        ,
                                        task_samples, shader_target);
                                    continue;
                                }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                                // The task pass draws Standard through the
                                // pin's own stages exactly as it draws PBR,
                                // from the task's own camera and matrix.
                                if (draw_item.material_kind ==
                                    upstream::RenderMaterialKind::standard) {
                                    StandardVariantKey standard_key;
                                    const std::size_t standard_variant = standard_variant_for_draw(
                                        draw_context, engine, draw,
                                        geometry_task ? static_cast<std::size_t>(
                                                            geometry_task->geometry.shader_index)
                                                      : npos,
                                        &standard_key);
                                    if (standard_variant == npos) {
                                        gpu_error(
                                            ("Standard draw for mesh " +
                                             std::to_string(draw_item.mesh.value) + ", material " +
                                             std::to_string(draw_item.material.value) +
                                             " resolves no composed variant in "
                                             "a render task: " +
                                             standard_variant_request(draw_context, engine, draw))
                                                .c_str());
                                    }
                                    draw_standard_variant(
                                        state, command, task_pass, draw_context, engine,
                                        pass_scene_block, pass_lights_block, draw, mesh, material,
                                        standard_variant, standard_key.features, bound_pipeline,
                                        geometry_task, geometry_params,
                                        material_render_textures(material, source_texture),
                                        geometry_params_buffer, velocity_history,
                                        shadow_generator != nullptr
#if BBLITE_SHADOWS_ESM
                                        ,
                                        shadow_generator && shadow_generator->filter ==
                                                                ShadowFilter::esm_directional
                                            ? shadow_generator->esm_index
                                            : invalid_handle
#else
                                        ,
                                        invalid_handle
#endif
#if BBLITE_HAS_TAA
                                        ,
                                        deferred, deferred_scene
#endif
                                        ,
                                        task_samples, shader_target);
                                    continue;
                                }
#else
                            if (draw_item.material_kind == upstream::RenderMaterialKind::standard) {
                                gpu_error("Standard draw in a build with no "
                                          "composed variant table; the "
                                          "transcribed fragment is retired.");
                            }
#endif
#if BBLITE_NODE_VARIANTS > 0
                                // A node graph in a task pass: a shadow caster,
                                // or -- when the task is a geometry-output one --
                                // the graph's own MRT view. The family's own
                                // dispatcher either way, with the task deciding
                                // which of the graph's compiled modules draws.
                                if (draw_item.material_kind == upstream::RenderMaterialKind::node) {
                                    draw_node_variant(
                                        state, command, task_pass, draw_context, engine,
                                        pass_scene_block, pass_lights_block, draw, mesh,
                                        draw_item.shader_variant, bound_pipeline,
                                        shadow_generator != nullptr, material,
#if BBLITE_SHADOWS_ESM
                                        shadow_generator && shadow_generator->filter ==
                                                                ShadowFilter::esm_directional
                                            ? shadow_generator->esm_index
                                            : invalid_handle,
#else
                                        invalid_handle,
#endif
                                        geometry_task, geometry_params, geometry_params_buffer,
                                        shader_target);
                                    continue;
                                }
#else
                            if (draw_item.material_kind == upstream::RenderMaterialKind::node) {
                                gpu_error("a node material in a build with no "
                                          "composed graphs.");
                            }
#endif
                                SDL_GPUGraphicsPipeline* pipeline =
                                    pipeline_for(draw.pipeline, draw.item.shader_variant);
                                if (!pipeline) {
                                    throw std::runtime_error(
                                        "Reached secondary render pipeline was not created.");
                                }
                                if (pipeline != bound_pipeline) {
                                    SDL_BindGPUGraphicsPipeline(task_pass, pipeline);
                                    bound_pipeline = pipeline;
                                }
                                const bool shader_bucket =
                                    draw_item.material_kind == upstream::RenderMaterialKind::shader;
                                if (shader_bucket) {
                                    if (!material) {
                                        pal::refuse_invalid_frame_handle(
                                            "Shader draw has an invalid material.");
                                    }
                                    const ShaderDrawMatrices shader_matrices(
                                        draw_context, engine,
                                        handle_at(engine.meshes, draw_item.mesh),
                                        draw_pass_matrices);
                                    const ShaderPassMatrices shader_pass_matrices =
                                        shader_matrices.apply(draw_pass_matrices);
                                    // Per-stage blocks from the generated
                                    // variant table: [the declared system
                                    // matrices][custom floats gathered from
                                    // the material's flat value storage].
                                    const upstream::ShaderVariantInfo& shader_info =
                                        upstream::shader_variant_info(draw_item.shader_variant);
                                    const auto push_stage_block =
                                        [&](const upstream::ShaderVariantStageBlock& block,
                                            bool fragment_stage) {
                                            if (!block.present)
                                                return;
                                            shader_stage_block_floats(block, shader_pass_matrices,
                                                                      *material,
                                                                      shader_block_scratch);
                                            if (fragment_stage) {
                                                SDL_PushGPUFragmentUniformData(
                                                    command, 0, shader_block_scratch.data(),
                                                    static_cast<Uint32>(
                                                        shader_block_scratch.size() *
                                                        sizeof(float)));
                                            } else {
                                                SDL_PushGPUVertexUniformData(
                                                    command, 0, shader_block_scratch.data(),
                                                    static_cast<Uint32>(
                                                        shader_block_scratch.size() *
                                                        sizeof(float)));
                                            }
                                        };
                                    push_stage_block(shader_info.vertex, false);
                                    push_stage_block(shader_info.fragment, true);
                                    bind_stage_storage(
                                        task_pass,
                                        state.shader_vertex_slots[draw_item.shader_variant], false,
                                        "shader material vertex stage",
                                        state.storage_binding_scratch,
                                        [&](const std::string& name, std::size_t) {
                                            return shader_storage_buffer(state, *material,
                                                                         shader_info, name);
                                        });
                                    bind_stage_storage(
                                        task_pass,
                                        state.shader_fragment_slots[draw_item.shader_variant], true,
                                        "shader material fragment stage",
                                        state.storage_binding_scratch,
                                        [&](const std::string& name, std::size_t) {
                                            return shader_storage_buffer(state, *material,
                                                                         shader_info, name);
                                        });
                                    bind_shader_material_textures(state, task_pass, draw_context,
                                                                  engine, *material,
                                                                  draw_item.shader_variant, mesh);
                                    if (shader_info.vertex.present) {
                                        // A pure scene-matrix vertex block
                                        // leaves the shared binding valid;
                                        // custom vertex floats invalidate
                                        // it for the next draw.
                                        scene_matrix_bound =
                                            block_is_shared_scene_matrix(shader_info.vertex);
                                    }
                                }
                                const SDL_GPUBufferBinding index_binding{
                                    mesh.indices,
                                    0,
                                };
                                bind_mesh_vertex_buffers(task_pass, mesh);
                                SDL_BindGPUIndexBuffer(task_pass, &index_binding,
                                                       SDL_GPU_INDEXELEMENTSIZE_32BIT);
                                count_gpu_draw(SDL_DrawGPUIndexedPrimitives, task_pass,
                                               mesh.index_count, mesh.instance_count, 0, 0, 0);
                            }
                        };
                        draw_list(draw_lists.opaque);
#if BBLITE_HAS_BILLBOARDS
                        if (draw_scene_billboard_stages) {
                            if (!draw_pass_matrices.view)
                                throw std::runtime_error(
                                    "Billboard scene stages require a view matrix.");
                            draw_task_billboards(task_pass, BillboardDepthMode::cutout,
                                                 write_billboard_scene_block(
                                                     pass_blocks.pass(draw_context, pass_task),
                                                     draw_context, engine, draw_camera, draw_matrix,
                                                     *draw_pass_matrices.view));
                        }
#endif
                        draw_list(draw_lists.transparent);
                    };

#if BBLITE_HAS_TAA
                    if (graph_layer == 0) {
                        for (const auto& registered : engine.registered_scenes) {
                            for (const TaskHandle recorded_handle : registered->tasks) {
                                auto& recorded = handle_at(engine.frame_tasks, recorded_handle);
                                if (!recorded.post_process.taa)
                                    continue;
                                auto& first =
                                    state.post_process_tasks.at(recorded_handle.value).at(0);
                                if (first.temporal_recorded)
                                    continue;
                                upstream::record_taa_post_process(*recorded.post_process.taa, [&] {
                                    for (std::size_t child = 0;
                                         child < recorded.post_process.passes.size(); ++child) {
                                        (void)prepare_post_process_pass(
                                            state, engine, recorded_handle, swapchain,
                                            swapchain_format, width, height, child, source_texture,
                                            target_texture);
                                    }
                                });
                                first.temporal_recorded = true;
                            }
                        }
                    }
#endif
#if BBLITE_GPU_TASK_TIMING
                    GpuTaskTimingSequence timing_sequence(
                        engine,
                        [&](const auto& write) { encode_sdl_gpu_timestamp(command, write); },
                        &graph_scene);
#endif
                    for (const TaskHandle handle : graph_scene.tasks) {
                        [[maybe_unused]] FrameTaskRecord& task =
                            handle_at(engine.frame_tasks, handle);
                        if (task.execution_enabled == false)
                            continue;
#if BBLITE_GPU_TASK_TIMING
                        const auto timing_scope = timing_sequence.scoped_task(engine, handle);
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
                        if (task.kind == FrameTaskKind::compute) {
                            if (surface_command) {
                                if (!command.submit())
                                    gpu_error("SDL_SubmitGPUCommandBuffer shadow prefix");
                                command = std::exchange(surface_command, SdlGpuCommand{nullptr});
                                begin_compute_frame_prefix(engine, true);
                                SDL_PushGPUVertexUniformData(command, 0, graph_matrix.data(),
                                                             sizeof(graph_matrix));
                            }
                            continue;
                        }
#endif
#if BBLITE_HAS_TAA
                        if (task.kind != FrameTaskKind::render &&
                            task.kind != FrameTaskKind::post_process) {
                            throw std::runtime_error(
                                "Temporal submission requires a prepared frame-task encoding adapter.");
                        }
#endif
                        if (task.kind == FrameTaskKind::render) {
                            const RenderTargetRecord& target_record =
                                handle_at(engine.render_targets, task.render.target);
                            GpuRenderTarget& target =
                                handle_at(state.render_targets, task.render.target);
#if BBLITE_HAS_TAA
                            if (task.source_scene != graph_scene.state ||
                                task.render.scene_stages ||
                                task.render.shadow_generator.value != invalid_handle ||
                                !target.color || target.color_format != state.frame_color_format) {
                                throw std::runtime_error(
                                    "Temporal source requires a prepared Standard color pass in its owning scene.");
                            }
#endif
                            CameraRecord* const task_camera = task_pass_camera(engine, task);
#if BBLITE_HAS_TAA
                            validate_temporal_source(engine, task, task_camera,
                                                     handle_at(task_draw_lists, handle));
                            prepare_temporal_scene_uniforms(
                                task, task_camera, target.width, target.height, graph_extent.width,
                                graph_extent.height, [](const float*, std::size_t) {});
#endif
                            // `_writePassSceneUBO` folds the camera's own
                            // viewport into whichever extent the task was
                            // configured for -- the canvas or the target.
                            const bool canvas_extent = task.render.canvas_size;
                            CameraPassMatrices task_camera_pass =
                                build_pass_camera(graph_scene, engine, task_camera,
                                                  canvas_extent ? graph_extent.width
                                                                : static_cast<double>(target.width),
                                                  canvas_extent
                                                      ? graph_extent.height
                                                      : static_cast<double>(target.height))
                                    .matrices;
                            keep_view_projection(task_camera_pass, task_camera,
                                                 pass_blocks.task(handle));
                            // A shadow task renders from the light, not from
                            // a camera: the generator's own matrices replace
                            // the product below, which stays the zero matrix
                            // and is never pushed.
                            const bool shadow_task =
                                task.render.shadow_generator.value != invalid_handle;
                            if (shadow_task)
                                task_camera_pass.view_projection = {};
                            const std::array<float, 16>& task_matrix =
                                task_camera_pass.view_projection;
                            [[maybe_unused]] const std::array<float, 16>& task_view =
                                task_camera_pass.view;
                            const ShaderPassMatrices task_pass_matrices = task_camera_pass.pass();
                            if (!shadow_task) {
                                SDL_PushGPUVertexUniformData(command, 0, task_matrix.data(),
                                                             sizeof(task_matrix));
                            }
#if BBLITE_SHADOW_RECEIVERS
                            if (task.render.shadow_generator.value <
                                engine.shadow_generators.size()) {
                                // The pin's render gate: `renderEsmShadowMap` /
                                // `renderPcfShadowMap` return before the caster
                                // pass and both blur passes when nothing moved
                                // since the last render, and the map textures
                                // persist — the receiver keeps sampling last
                                // render's bit-identical content. The verdict
                                // was written onto the gate by
                                // `refresh_shadow_generators` earlier this
                                // frame.
                                if (!state.shadow_refresh.gates[task.render.shadow_generator.value]
                                         .due) {
                                    continue;
                                }
                                if (!target_record.has_depth || !target.depth) {
                                    throw std::runtime_error(
                                        "Shadow render task has no depth attachment.");
                                }
                                const ShadowGeneratorRecord& generator = handle_at(
                                    engine.shadow_generators, task.render.shadow_generator);
                                // A cascaded generator has one pass per
                                // cascade, each clearing and writing its own
                                // layer of the shared depth array and
                                // rendering through that cascade's own biased
                                // view-projection. Every other generator has
                                // one pass, one layer and one pair.
                                const pal::ShadowCasterMatrices caster =
                                    pal::shadow_caster_matrices(engine, task);
                                const std::array<float, 16>& caster_view_projection =
                                    caster.view_projection;
                                const std::array<float, 16>& caster_view = caster.view;
                                SDL_GPUDepthStencilTargetInfo shadow_depth{};
                                shadow_depth.texture = target.depth;
                                shadow_depth.layer = static_cast<Uint8>(task.render.depth_layer);
                                // The pin's own shadow target clears to ITS
                                // far value, which standard-Z puts at 1 where
                                // this port's reverse-Z puts it at 0.
                                shadow_depth.clear_depth = pass_depth_clear(true);
                                shadow_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                                shadow_depth.store_op = SDL_GPU_STOREOP_STORE;
                                shadow_depth.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
                                shadow_depth.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
                                // An ESM caster pass STORES a colour: the
                                // exponential depth its material view writes.
                                // A PCF one has no colour attachment at all,
                                // which is the difference between the two
                                // pinned targets.
                                SDL_GPUColorTargetInfo shadow_color{};
                                if (target_record.has_color) {
                                    if (!target.color) {
                                        throw std::runtime_error("ESM shadow task has no colour "
                                                                 "attachment.");
                                    }
                                    shadow_color.texture = target.color;
                                    shadow_color.load_op = SDL_GPU_LOADOP_CLEAR;
                                    shadow_color.store_op = SDL_GPU_STOREOP_STORE;
                                    // `createRenderTask({clrColor:{0,0,0,0}})`.
                                    shadow_color.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
                                }
                                SdlRenderPass shadow_pass{SDL_BeginGPURenderPass(
                                    command, target_record.has_color ? &shadow_color : nullptr,
                                    target_record.has_color ? 1u : 0u, &shadow_depth)};
                                SDL_PushGPUVertexUniformData(command, 0,
                                                             caster_view_projection.data(),
                                                             sizeof(caster_view_projection));
                                ShaderPassMatrices caster_pass_matrices{
                                    caster_view_projection.data(), &caster_view, nullptr};
                                caster_pass_matrices.camera_position =
                                    &task_camera_pass.camera_position;
                                draw_scene(graph_scene, graph_meshes, shadow_pass,
                                           state.shader_shadow_pipelines,
                                           state.shader_shadow_pipelines, caster_view_projection,
                                           task_camera, caster_pass_matrices, handle,
                                           handle_at(task_draw_lists, handle), nullptr, nullptr,
                                           nullptr, nullptr, &generator);
                                shadow_pass.end();
#if BBLITE_SHADOWS_ESM
                                // `renderEsmShadowMap` blurs the map it just
                                // drew, in two passes, before anything samples
                                // it.
                                if (generator.filter == ShadowFilter::esm_directional) {
                                    run_esm_blur(state, command, generator.esm_index);
                                }
#endif
                                continue;
                            }
#endif
                            if (!target_record.has_color) {
                                if (!target_record.has_depth || !target.depth) {
                                    throw std::runtime_error(
                                        "Depth-only render task has no depth attachment.");
                                }
                                if (target.depth_format != state.depth_format ||
                                    (target_record.samples != 1 &&
                                     target_record.samples !=
                                         gpu_sample_count_value(state.sample_count))) {
                                    throw std::runtime_error(
                                        "Depth-only render task requires the renderer's depth format and sample count.");
                                }
                                if (task.render_meshes.empty()) {
                                    throw std::runtime_error(
                                        "Depth-only render task requires explicit meshes.");
                                }
                                SDL_GPUDepthStencilTargetInfo task_depth{};
                                task_depth.texture = target.depth;
                                // Zero for every target but a layered one, and
                                // the record carries the layer either way --
                                // an ordinary pass into a layered target would
                                // otherwise silently write layer 0.
                                task_depth.layer = static_cast<Uint8>(task.render.depth_layer);
                                task_depth.clear_depth = upstream::pinned_depth_clear;
                                task_depth.load_op = upstream::render_task_loads_depth(
                                                         false, false, task.render.depth_clear)
                                                         ? SDL_GPU_LOADOP_LOAD
                                                         : SDL_GPU_LOADOP_CLEAR;
                                task_depth.store_op = SDL_GPU_STOREOP_STORE;
                                task_depth.stencil_load_op = task_depth.load_op;
                                task_depth.stencil_store_op = SDL_GPU_STOREOP_STORE;
                                SdlRenderPass task_pass{
                                    SDL_BeginGPURenderPass(command, nullptr, 0, &task_depth)};
                                set_task_camera_viewport(task_pass, task_camera, target.width,
                                                         target.height);
                                const std::size_t pipeline_index =
                                    target_record.samples == 4 ? 1u : 0u;
                                for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
                                    SDL_BindGPUGraphicsPipeline(
                                        task_pass, sided_mode == 0
                                                       ? state.depth_only_pipelines[pipeline_index]
                                                       : state.depth_only_double_sided_pipelines
                                                             [pipeline_index]);
                                    for (const RenderTaskMesh& entry : task.render_meshes) {
                                        const auto material_handle =
                                            render_task_mesh_material(engine, entry);
                                        const MaterialRecord& material =
                                            handle_at(engine.materials, material_handle);
                                        if (!material.no_color) {
                                            throw std::runtime_error(
                                                "Depth-only render task requires a no-color material view.");
                                        }
                                        if (material.double_sided != (sided_mode == 1)) {
                                            continue;
                                        }
                                        // geometry-renderer-task.ts skips a hidden mesh at the draw
                                        // itself. This path consumes no draw list -- it walks the task's
                                        // own meshes and resolves each against the plan -- so it cannot
                                        // inherit append_draw's answer and asks the same predicate.
                                        if (!upstream::mesh_draws(
                                                handle_at(engine.meshes, entry.mesh))) {
                                            continue;
                                        }
                                        const std::size_t mesh_index = gpu_mesh_index(entry.mesh);
                                        if (mesh_index >= graph_meshes.size()) {
                                            throw std::runtime_error(
                                                "Depth task mesh is not in the scene.");
                                        }
                                        const GpuMesh& mesh = graph_meshes[mesh_index];
                                        // The stage's mesh block: the mesh's own world.
                                        const std::array<float, 16> world =
                                            mesh_block_world(graph_scene, engine,
                                                             handle_at(engine.meshes, entry.mesh));
                                        SDL_PushGPUVertexUniformData(command,
                                                                     mesh_world_uniform_slot,
                                                                     world.data(), sizeof(world));
                                        const SDL_GPUBufferBinding index_binding{
                                            mesh.indices,
                                            0,
                                        };
                                        bind_mesh_vertex_buffers(task_pass, mesh);
                                        SDL_BindGPUIndexBuffer(task_pass, &index_binding,
                                                               SDL_GPU_INDEXELEMENTSIZE_32BIT);
                                        count_gpu_draw(SDL_DrawGPUIndexedPrimitives, task_pass,
                                                       mesh.index_count, mesh.instance_count, 0, 0,
                                                       0);
                                    }
                                }
                                task_pass.end();
                                if (target.depth_copy)
                                    encode_metal_depth_copy(state, command, target);
                                continue;
                            }
                            SDL_GPUColorTargetInfo target_info{};
                            target_info.texture =
                                target_record.swapchain ? swapchain : target.color;
                            const Color4 task_clear_color = task_pass_clear_color(task);
                            target_info.clear_color = SDL_FColor{
                                task_clear_color.r,
                                task_clear_color.g,
                                task_clear_color.b,
                                task_clear_color.a,
                            };
                            target_info.load_op =
                                task.render.clear ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
                            target_info.store_op = SDL_GPU_STOREOP_STORE;
                            // The pin resolves into `rst` at end-of-pass, and
                            // ignores it outright when the task's own target is
                            // single-sample. That is the count the target was
                            // *allocated* at, not the one it asked for: a run
                            // forced to one sample resolves nothing.
                            if (task.render.resolve_target.value != invalid_handle &&
                                task_sample_count(state, target_record.samples) !=
                                    SDL_GPU_SAMPLECOUNT_1) {
                                target_info.store_op = SDL_GPU_STOREOP_RESOLVE_AND_STORE;
                                target_info.resolve_texture =
                                    target_texture(task.render.resolve_target, false);
                            }
                            SDL_GPUDepthStencilTargetInfo task_depth{};
                            SDL_GPUDepthStencilTargetInfo* task_depth_pointer = nullptr;
                            // The pin's external-depth arm: a task handed another
                            // task's depth binds that texture and LOADS it,
                            // because a geometry output is eager and its owner
                            // already cleared and wrote it.
                            if (task.render.depth.source == RenderTextureSource::geometry_depth) {
                                task_depth.texture = task_depth_texture(task.render.depth);
                                task_depth.load_op = SDL_GPU_LOADOP_LOAD;
                                task_depth.store_op = SDL_GPU_STOREOP_STORE;
                                task_depth.stencil_load_op = SDL_GPU_LOADOP_LOAD;
                                task_depth.stencil_store_op = SDL_GPU_STOREOP_STORE;
                                task_depth_pointer = &task_depth;
                            } else if (target_record.has_depth && target.depth) {
                                task_depth.texture = target.depth;
                                // Its own layer, as the two passes above take
                                // theirs; zero for every target but a layered
                                // one, and an ordinary pass into a layered
                                // target would otherwise write layer 0.
                                task_depth.layer = static_cast<Uint8>(task.render.depth_layer);
                                task_depth.clear_depth = upstream::pinned_depth_clear;
                                task_depth.load_op = upstream::render_task_loads_depth(
                                                         false, false, task.render.depth_clear)
                                                         ? SDL_GPU_LOADOP_LOAD
                                                         : SDL_GPU_LOADOP_CLEAR;
                                task_depth.store_op = SDL_GPU_STOREOP_STORE;
                                task_depth.stencil_load_op = task_depth.load_op;
                                task_depth.stencil_store_op = SDL_GPU_STOREOP_STORE;
                                task_depth_pointer = &task_depth;
                            }
#if BBLITE_HAS_TAA
                            PreparedSdlScenePass prepared;
                            prepared.target = target_info;
                            if (task_depth_pointer)
                                prepared.depth = *task_depth_pointer;
                            if (const std::optional<PixelViewport> rectangle =
                                    upstream::pass_camera_viewport(
                                        task_camera, static_cast<double>(target.width),
                                        static_cast<double>(target.height))) {
                                prepared.viewport =
                                    SDL_GPUViewport{static_cast<float>(rectangle->x),
                                                    static_cast<float>(rectangle->y),
                                                    static_cast<float>(rectangle->width),
                                                    static_cast<float>(rectangle->height),
                                                    0.0f,
                                                    1.0f};
                                prepared.scissor = SDL_Rect{rectangle->x, rectangle->y,
                                                            rectangle->width, rectangle->height};
                            }
                            upstream::sort_transparent_draws(
                                handle_at(task_draw_lists, handle).transparent, engine,
                                task_camera);
                            draw_scene(graph_scene, graph_meshes, nullptr, {}, {}, task_matrix,
                                       task_camera, task_pass_matrices, handle,
                                       handle_at(task_draw_lists, handle), nullptr, nullptr,
                                       nullptr, nullptr, nullptr, false, &prepared.draws,
                                       task.scene_uniforms,
                                       task_sample_count(state, target_record.samples));
                            temporal_passes.emplace_back(std::move(prepared));
                            continue;
#endif
                            SdlRenderPass task_pass{SDL_BeginGPURenderPass(command, &target_info, 1,
                                                                           task_depth_pointer)};
                            set_task_camera_viewport(task_pass, task_camera, target.width,
                                                     target.height);
                            upstream::sort_transparent_draws(
                                handle_at(task_draw_lists, handle).transparent, engine,
                                task_camera);
                            if (task.render.scene_stages) {
                                if (!task_depth_pointer ||
                                    target.color_format != state.frame_color_format ||
                                    target.depth_format != state.depth_format ||
                                    task_sample_count(state, target_record.samples) !=
                                        state.sample_count)
                                    throw std::runtime_error(
                                        "Compiler-owned scene stages require the frame attachment formats and sample count.");
#if BBLITE_PINNED_BACKGROUNDS
                                for (const SkyboxLayer layer : skybox_stage_order) {
                                    draw_task_background(task_pass, handle, task_matrix,
                                                         task_camera,
                                                         state.background_draws.skybox(layer));
                                }
#endif
                            }
                            draw_scene(
                                graph_scene, graph_meshes, task_pass, state.shader_pipelines,
                                state.shader_a2c_pipelines, task_matrix, task_camera,
                                task_pass_matrices, handle, handle_at(task_draw_lists, handle),
                                nullptr, nullptr, nullptr, nullptr, nullptr,
                                task.render.scene_stages
#if BBLITE_HAS_TAA
                                ,
                                nullptr, {}, {}
#endif
                                ,
                                ShaderTaskTarget{target.color_format,
                                                 task_depth_pointer
                                                     ? (task.render.depth.source ==
                                                                RenderTextureSource::geometry_depth
                                                            ? state.depth_format
                                                            : target.depth_format)
                                                     : SDL_GPU_TEXTUREFORMAT_INVALID,
                                                 task_sample_count(state, target_record.samples)});
                            if (task.render.scene_stages) {
#if BBLITE_PINNED_BACKGROUNDS
                                draw_task_background(task_pass, handle, task_matrix, task_camera,
                                                     state.background_draws.ground);
#endif
#if BBLITE_HAS_BILLBOARDS
                                draw_task_billboards(
                                    task_pass, BillboardDepthMode::transparent,
                                    write_billboard_scene_block(pass_blocks.task(handle),
                                                                graph_scene, engine, task_camera,
                                                                task_matrix, task_view));
#endif
                            }
                            task_pass.end();
                            if (graph_layer == 0 && task.render.scene_stages) {
                                // Utility layers share the primary surface's MSAA
                                // attachment, before its resolve/present tasks run.
                                for (std::size_t layer = 0; layer < overlay_plans.size(); ++layer) {
                                    const Scene& utility = *engine.registered_scenes[layer + 1];
                                    if (utility.surface_canvas || !utility.tasks.empty())
                                        continue;
                                    // The layer's own scene pass: its camera,
                                    // with no fallback to the base scene's.
                                    const PassCamera utility_pass_camera = build_kept_pass_camera(
                                        utility, engine, scene_pass_camera(engine, utility),
                                        target.width, target.height, pass_blocks.scene(utility));
                                    const std::array<float, 16>& utility_matrix =
                                        utility_pass_camera.matrices.view_projection;
                                    target_info.load_op = SDL_GPU_LOADOP_LOAD;
                                    if (task_depth_pointer)
                                        task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                                    SdlRenderPass utility_pass{SDL_BeginGPURenderPass(
                                        command, &target_info, 1, task_depth_pointer)};
                                    set_pass_camera_viewport(utility_pass, utility, engine,
                                                             utility_pass_camera.camera,
                                                             target.width, target.height);
                                    SDL_PushGPUVertexUniformData(command, 0, utility_matrix.data(),
                                                                 sizeof(utility_matrix));
                                    upstream::sort_transparent_draws(
                                        overlay_plans[layer].draw_lists.transparent, engine,
                                        utility_pass_camera.camera);
                                    draw_scene(utility, state.overlay_meshes[layer], utility_pass,
                                               state.shader_pipelines, state.shader_a2c_pipelines,
                                               utility_matrix, utility_pass_camera.camera,
                                               utility_pass_camera.pass(), std::nullopt,
                                               overlay_plans[layer].draw_lists, nullptr, nullptr,
                                               nullptr, nullptr);
                                    utility_pass.end();
                                }
                            }
                            continue;
                        }
                        if (task.kind == FrameTaskKind::geometry) {
                            // Without a camera the task does not execute, not
                            // even its clears.
                            if (upstream::geometry_task_skips(geometry_pass.camera))
                                continue;
                            const std::array<float, 16>& geometry_matrix =
                                geometry_pass.matrices.view_projection;
                            GpuGeometryTask& geometry = handle_at(state.geometry_tasks, handle);
                            const SDL_GPUSampleCount task_samples =
                                task_sample_count(state, task.geometry.samples);
                            std::vector<SDL_GPUColorTargetInfo> target_infos;
                            target_infos.reserve(
                                task.geometry.attachments.size() +
                                (task.geometry.target.value != invalid_handle ? 1u : 0u));
                            for (std::size_t index = 0; index < task.geometry.attachments.size();
                                 ++index) {
                                SDL_GPUColorTargetInfo target_info{};
                                target_info.texture = geometry.colors[index];
                                target_info.clear_color =
                                    geometry_clear_color(task.geometry.attachments[index].type);
                                target_info.load_op = SDL_GPU_LOADOP_CLEAR;
                                target_info.store_op = task_samples == SDL_GPU_SAMPLECOUNT_1
                                                           ? SDL_GPU_STOREOP_STORE
                                                           : SDL_GPU_STOREOP_RESOLVE;
                                target_info.resolve_texture = task_samples == SDL_GPU_SAMPLECOUNT_1
                                                                  ? nullptr
                                                                  : geometry.sampled_colors[index];
                                target_infos.push_back(target_info);
                            }
                            if (task.geometry.target.value != invalid_handle) {
                                GpuRenderTarget& output_target =
                                    handle_at(state.render_targets, task.geometry.target);
                                SDL_GPUColorTargetInfo target_info{};
                                target_info.texture = output_target.color;
                                target_info.clear_color = SDL_FColor{
                                    task.geometry.target_clear_color.r,
                                    task.geometry.target_clear_color.g,
                                    task.geometry.target_clear_color.b,
                                    task.geometry.target_clear_color.a,
                                };
                                target_info.load_op = task.geometry.clear_target
                                                          ? SDL_GPU_LOADOP_CLEAR
                                                          : SDL_GPU_LOADOP_LOAD;
                                target_info.store_op = task_samples == SDL_GPU_SAMPLECOUNT_1
                                                           ? SDL_GPU_STOREOP_STORE
                                                           : SDL_GPU_STOREOP_RESOLVE;
                                target_info.resolve_texture = task_samples == SDL_GPU_SAMPLECOUNT_1
                                                                  ? nullptr
                                                                  : output_target.sampled_color;
                                target_infos.push_back(target_info);
                            }
                            SDL_GPUDepthStencilTargetInfo task_depth{};
                            // The pin's gpUniforms for the task's MRT variants:
                            // last frame's view-projection (seeded with the
                            // current one on the first frame) and the camera's
                            // near/far planes.
                            if (!geometry.has_previous_view_projection) {
                                geometry.previous_view_projection = geometry_matrix;
                                geometry.has_previous_view_projection = true;
                            }
                            const PinnedGeometryParams geometry_params{
                                geometry.previous_view_projection,
                                {
                                    static_cast<float>(geometry_pass.camera->near_plane),
                                    static_cast<float>(geometry_pass.camera->far_plane),
                                    0.0f,
                                    0.0f,
                                },
                            };
#if BBLITE_PINNED_MATERIALS
                            // The same block as a real buffer, for a composed
                            // geometry fragment whose gp the shader compile
                            // demoted out of SDL_GPU's four uniform slots --
                            // which happens to either family once scene, lights,
                            // mesh and material fill them. The upload runs on its
                            // own command buffer, submitted (and so executed)
                            // ahead of this frame's, and cycles the buffer so a
                            // frame still in flight keeps last frame's contents.
                            {
                                if (!geometry.params) {
                                    geometry.params = upload_buffer(
                                        state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                        &geometry_params, sizeof(geometry_params));
                                } else {
                                    update_buffer(state.device, geometry.params, &geometry_params,
                                                  sizeof(geometry_params));
                                }
                            }
#endif
                            task_depth.texture = geometry.depth;
                            task_depth.clear_depth = upstream::pinned_depth_clear;
                            task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                            task_depth.store_op = geometry.depth_borrowed
                                                      ? SDL_GPU_STOREOP_STORE
                                                      : SDL_GPU_STOREOP_DONT_CARE;
                            task_depth.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
                            task_depth.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
                            SdlRenderPass task_pass{SDL_BeginGPURenderPass(
                                command, target_infos.data(),
                                static_cast<Uint32>(target_infos.size()), &task_depth)};
                            // Over the task's own attachments, which the frame
                            // graph allocates at the frame's extent.
                            set_task_camera_viewport(task_pass, geometry_pass.camera, width,
                                                     height);
                            SDL_PushGPUVertexUniformData(command, 0, geometry_matrix.data(),
                                                         sizeof(geometry_matrix));
                            upstream::sort_transparent_draws(
                                handle_at(task_draw_lists, handle).transparent, engine,
                                geometry_pass.camera);
#if BBLITE_STANDARD_VARIANTS > 0
                            update_pinned_velocity_frame(geometry.velocity, graph_scene, engine,
                                                         graph_plan.items);
#endif
                            draw_scene(graph_scene, graph_meshes, task_pass, {}, {},
                                       geometry_matrix, geometry_pass.camera, geometry_pass.pass(),
                                       handle, handle_at(task_draw_lists, handle), &task,
                                       &geometry_params, geometry.params, &geometry.velocity);
#if BBLITE_GEOMETRY_TASK_FAMILIES
                            // The previous view-projection is a property of the
                            // TASK, tracked only when a composed family reads it.
                            geometry.previous_view_projection = geometry_matrix;
#endif
                            task_pass.end();
                            continue;
                        }

#if BBLITE_HAS_EFFECT_TASK
                        if (task.kind == FrameTaskKind::effect) {
                            // The same two halves the swapchain renderer draws
                            // through, recorded into the frame graph's command
                            // buffer instead: the pin ships two entry points
                            // over one pass, not two passes.
                            if (state.effect_tasks.size() < engine.frame_tasks.size()) {
                                state.effect_tasks.resize(engine.frame_tasks.size());
                            }
                            EffectPass& pass = handle_at(state.effect_tasks, handle);
                            const RenderTargetRecord& target_record =
                                handle_at(engine.render_targets, task.effect.target);
                            if (!pass.pipeline) {
                                pass = create_effect_pass(
                                    state.device, engine, task.effect.effect,
                                    target_record.swapchain
                                        ? swapchain_format
                                        : handle_at(state.render_targets, task.effect.target)
                                              .color_format,
                                    // Through the MSAA gate like every other
                                    // task pipeline, so a single-sample run
                                    // matches the 1-sample texture the gate
                                    // allocated (Dawn's site reads the same
                                    // gate).
                                    target_record.swapchain
                                        ? 1u
                                        : gpu_sample_count_value(
                                              task_sample_count(state, target_record.samples)));
                            }
                            SDL_GPUColorTargetInfo effect_target{};
                            effect_target.texture = target_texture(task.effect.target, false);
                            effect_target.load_op =
                                task.effect.clear ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
                            effect_target.clear_color =
                                SDL_FColor{task.effect.clear_color.r, task.effect.clear_color.g,
                                           task.effect.clear_color.b, task.effect.clear_color.a};
                            effect_target.store_op = SDL_GPU_STOREOP_STORE;
                            SdlRenderPass effect_pass{
                                SDL_BeginGPURenderPass(command, &effect_target, 1, nullptr)};
                            record_effect_pass(command, effect_pass, engine, pass,
                                               task.effect.effect);
                            effect_pass.end();
                            continue;
                        }
#endif
#if BBLITE_HAS_POST_PROCESS
                        if (task.kind == FrameTaskKind::post_process) {
#if BBLITE_HAS_TAA
                            if (task.post_process.taa) {
                                auto& taa = *task.post_process.taa;
                                auto& source = engine.frame_tasks.at(
                                    task.post_process.source_tasks.at(0).value);
                                if (!source.source_scene || !source.scene_uniforms) {
                                    throw std::runtime_error(
                                        "Temporal task source has no retained scene UBO.");
                                }
                                CameraRecord* camera =
                                    handle_find(engine.cameras, source.source_scene->camera);
                                [[maybe_unused]] const double draws =
                                    upstream::execute_taa_post_process(
                                        taa, task.post_process.passes.at(0).params[0], camera,
                                        [](CameraRecord* value) {
                                            return upstream::scene_camera_change_key(*value);
                                        },
                                        [&](std::size_t child) {
                                            write_sdl_post_process_uniforms(state, engine, handle,
                                                                            child, width, height);
                                        },
                                        [&](std::size_t child) -> std::optional<double> {
                                            temporal_passes.emplace_back(prepare_post_process_pass(
                                                state, engine, handle, swapchain, swapchain_format,
                                                width, height, child, source_texture,
                                                target_texture, false));
                                            return upstream::post_process_leaf_draw_count();
                                        },
                                        [&](TaaPostProcessState& value) {
                                            const auto& blend = task.post_process.passes.at(0);
                                            const auto extent = resolve_post_process_extent(
                                                handle_at(engine.render_targets,
                                                          blend.output_target),
                                                state.render_targets, blend, width, height);
                                            advance_temporal_jitter(
                                                value, *source.scene_uniforms, extent.source_width,
                                                extent.source_height,
                                                [](std::size_t, const float*, std::size_t) {});
                                        });
                                ++taa.execution_count;
                            } else {
                                for (std::size_t child = 0; child < task.post_process.passes.size();
                                     ++child) {
                                    temporal_passes.emplace_back(prepare_post_process_pass(
                                        state, engine, handle, swapchain, swapchain_format, width,
                                        height, child, source_texture, target_texture));
                                }
                            }
                            continue;
#endif
                            // A composite records the chain its own factory
                            // built; a plain effect is the same loop over one.
                            for (std::size_t index = 0; index < task.post_process.passes.size();
                                 ++index) {
                                record_post_process_pass(state, engine, handle, command, swapchain,
                                                         swapchain_format, width, height, index,
                                                         capture_texture, source_texture,
                                                         target_texture);
                            }
                            continue;
                        }
#endif
#if BBLITE_HAS_SCREEN_SPACE
                        if (task.kind == FrameTaskKind::screen_space) {
                            record_screen_space_task(
                                state, engine, handle, command, swapchain, swapchain_format, width,
                                height, capture_texture, source_texture, target_texture);
                            continue;
                        }
#endif
                        const CopyTaskOptions& copy = task.copy;
                        if (frame_options.skip_copy_task(copy))
                            continue;
                        const bool force_full_viewport = frame_options.full_copy_viewport(copy);
                        if (copy.resolve_target.value != invalid_handle &&
                            copy.target.value == invalid_handle) {
                            if (copy.source.source != RenderTextureSource::render_target) {
                                throw std::runtime_error("Resolve source must be a render target.");
                            }
                            if (state.sample_count == SDL_GPU_SAMPLECOUNT_1) {
                                // Nothing to average: the pinned resolve of a
                                // single-sample source is the source, so the
                                // frame graph's resolve step is a texture copy
                                // — the same degradation `pal_dawn.cpp` makes.
                                // Asking for STOREOP_RESOLVE here instead
                                // builds a command list D3D12 refuses to
                                // close, which is why every geometry-output
                                // scene failed under BBLITE_MSAA=1.
                                const GpuRenderTarget& resolve_source =
                                    handle_at(state.render_targets, copy.source.target);
                                SDL_GPUTextureLocation copy_source{};
                                copy_source.texture = target_texture(copy.source.target, false);
                                SDL_GPUTextureLocation copy_destination{};
                                copy_destination.texture =
                                    target_texture(copy.resolve_target, false);
                                SdlCopyPass resolve_copy{SDL_BeginGPUCopyPass(command)};
                                SDL_CopyGPUTextureToTexture(resolve_copy, &copy_source,
                                                            &copy_destination, resolve_source.width,
                                                            resolve_source.height, 1, false);
                                resolve_copy.end();
                                continue;
                            }
                            SDL_GPUColorTargetInfo resolve_info{};
                            resolve_info.texture = target_texture(copy.source.target, false);
                            resolve_info.load_op = SDL_GPU_LOADOP_LOAD;
                            resolve_info.store_op = SDL_GPU_STOREOP_RESOLVE;
                            resolve_info.resolve_texture =
                                target_texture(copy.resolve_target, false);
                            SdlRenderPass resolve_pass{
                                SDL_BeginGPURenderPass(command, &resolve_info, 1, nullptr)};
                            resolve_pass.end();
                            continue;
                        }

                        const RenderTargetRecord& target_record =
                            handle_at(engine.render_targets, copy.target);
                        // A copy writing a VIEWPORT of the swapchain composes
                        // with whatever else wrote the rest of it -- scene 187
                        // presents SMAA into one half and the raw image into
                        // the other -- and an SDL_GPU swapchain texture cannot
                        // be read back. So it draws into the same readable
                        // present copy a presenting post-process pass uses, and
                        // that copy is what gets blitted and captured. Drawing
                        // straight to the swapchain instead left the capture
                        // reading this copy's own source: half the frame, at
                        // half the width.
                        const auto surface_pane =
                            target_record.swapchain && !force_full_viewport
                                ? scene_surface_pane(engine, graph_scene, width, height)
                                : std::nullopt;
                        if (surface_pane) {
                            create_color(state, swapchain_format, width, height);
                            SDL_GPUColorTargetInfo surface_target{};
                            surface_target.texture = state.color;
                            surface_target.load_op =
                                graph_layer == 0 ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
                            surface_target.store_op = SDL_GPU_STOREOP_STORE;
                            SdlRenderPass surface_pass{
                                SDL_BeginGPURenderPass(command, &surface_target, 1, nullptr)};
                            const SDL_GPUViewport viewport{static_cast<float>(surface_pane->x),
                                                           static_cast<float>(surface_pane->y),
                                                           static_cast<float>(surface_pane->width),
                                                           static_cast<float>(surface_pane->height),
                                                           0.0f,
                                                           1.0f};
                            const SDL_Rect scissor{surface_pane->x, surface_pane->y,
                                                   surface_pane->width, surface_pane->height};
                            SDL_SetGPUViewport(surface_pass, &viewport);
                            SDL_SetGPUScissor(surface_pass, &scissor);
                            SDL_BindGPUGraphicsPipeline(surface_pass, state.blit_pipeline);
                            const SDL_GPUTextureSamplerBinding binding{source_texture(copy.source),
                                                                       state.background_sampler};
                            SDL_BindGPUFragmentSamplers(surface_pass, 0, &binding, 1);
                            count_gpu_draw(SDL_DrawGPUPrimitives, surface_pass, 3, 1, 0, 0);
                            surface_pass.end();
                            capture_texture = state.color;
                            continue;
                        }
                        const bool partial_present =
                            target_record.swapchain && copy.has_viewport && !force_full_viewport;
#if BBLITE_HAS_POST_PROCESS
                        if (partial_present && !state.post_process_present) {
                            state.post_process_present = create_frame_texture(
                                state.device, swapchain_format, SDL_GPU_SAMPLECOUNT_1, width,
                                height,
                                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
                        }
#else
                    if (partial_present) {
                        throw std::runtime_error("A copy task writing a viewport of the "
                                                 "swapchain needs the readable present copy, "
                                                 "which only a post-process build carries.");
                    }
#endif
                        SDL_GPUColorTargetInfo blit_target{};
#if BBLITE_HAS_POST_PROCESS
                        blit_target.texture = partial_present ? state.post_process_present
                                                              : target_texture(copy.target, false);
#else
                    blit_target.texture = target_texture(copy.target, false);
#endif
                        blit_target.load_op = copy.has_viewport && !force_full_viewport
                                                  ? SDL_GPU_LOADOP_LOAD
                                                  : SDL_GPU_LOADOP_DONT_CARE;
                        blit_target.store_op = SDL_GPU_STOREOP_STORE;
                        SdlRenderPass blit_pass{
                            SDL_BeginGPURenderPass(command, &blit_target, 1, nullptr)};
                        SDL_BindGPUGraphicsPipeline(blit_pass, target_record.samples == 4
                                                                   ? state.blit_msaa_pipeline
                                                                   : state.blit_pipeline);
                        if (force_full_viewport || copy.has_viewport) {
#if BBLITE_HAS_GEOMETRY_OUTPUT
                            const GpuRenderTarget& target =
                                handle_at(state.render_targets, copy.target);
                            const NormalizedViewport normalized_viewport =
                                force_full_viewport ? NormalizedViewport{} : copy.viewport;
                            const PixelViewport pixel_viewport = upstream::resolve_copy_viewport(
                                normalized_viewport, target.width, target.height);
                            const SDL_GPUViewport gpu_viewport{
                                static_cast<float>(pixel_viewport.x),
                                static_cast<float>(pixel_viewport.y),
                                static_cast<float>(pixel_viewport.width),
                                static_cast<float>(pixel_viewport.height),
                                0.0f,
                                1.0f,
                            };
                            SDL_SetGPUViewport(blit_pass, &gpu_viewport);
                            const SDL_Rect scissor{
                                pixel_viewport.x,
                                pixel_viewport.y,
                                pixel_viewport.width,
                                pixel_viewport.height,
                            };
                            SDL_SetGPUScissor(blit_pass, &scissor);
#else
                        throw std::runtime_error("Viewport copy requires geometry-output support.");
#endif
                        }
                        const SDL_GPUTextureSamplerBinding texture_binding{
                            source_texture(copy.source),
                            state.background_sampler,
                        };
                        SDL_BindGPUFragmentSamplers(blit_pass, 0, &texture_binding, 1);
                        count_gpu_draw(SDL_DrawGPUPrimitives, blit_pass, 3, 1, 0, 0);
                        blit_pass.end();
#if BBLITE_HAS_POST_PROCESS
                        if (partial_present) {
                            // Present what the frame composed, and capture the
                            // same texture -- the post-process present pass
                            // does exactly this after its own draw.
                            SDL_GPUBlitInfo present_blit{};
                            present_blit.source = SDL_GPUBlitRegion{
                                state.post_process_present, 0, 0, 0, 0, width, height};
                            present_blit.destination = SDL_GPUBlitRegion{
                                target_texture(copy.target, false), 0, 0, 0, 0, width, height};
                            present_blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                            present_blit.flip_mode = SDL_FLIP_NONE;
                            present_blit.filter = SDL_GPU_FILTER_NEAREST;
                            SDL_BlitGPUTexture(command, &present_blit);
                            capture_texture = state.post_process_present;
                        } else
#endif
                            if (target_record.swapchain) {
                            capture_texture = source_texture(copy.source);
                        }
                    }
                }
#if BBLITE_HAS_TAA
                for (const auto& prepared : temporal_passes) {
                    if (const auto* source = std::get_if<PreparedSdlScenePass>(&prepared)) {
                        encode_sdl_prepared_scene(command, *source);
                    } else {
                        encode_post_process_pass(state, command,
                                                 std::get<PreparedSdlPostProcessPass>(prepared),
                                                 capture_texture);
                    }
                }
            } else if (state.post_process_present) {
                // stopEngine clears the pin's render callback. Keep presenting
                // its final image without executing history or jitter again.
                SDL_GPUBlitInfo present{};
                const bool resized =
                    width != state.frame_graph_width || height != state.frame_graph_height;
                if (resized)
                    create_color(state, swapchain_format, width, height);
                present.source = SDL_GPUBlitRegion{
                    state.post_process_present, 0, 0, 0, 0, state.frame_graph_width,
                    state.frame_graph_height};
                present.destination =
                    SDL_GPUBlitRegion{resized ? state.color : swapchain, 0, 0, 0, 0, width, height};
                present.load_op = SDL_GPU_LOADOP_DONT_CARE;
                present.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &present);
                capture_texture = resized ? state.color : state.post_process_present;
            }
            capture_render_state();
#endif
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
            capture_render_state();
#endif
        } else {
            if (capture_frame || transmission_enabled) {
                create_color(state,
                             transmission_enabled ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
                                                  : swapchain_format,
                             width, height);
            }
#if BBLITE_RENDERER_TRANSMISSION
            if (transmission_enabled) {
                create_transmission_color(state);
                create_processed_color(state, swapchain_format, width, height);
            }
#endif
            create_msaa_color(state,
                              transmission_enabled ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
                                                   : swapchain_format,
                              width, height);
            create_depth(state, width, height);
            SDL_PushGPUVertexUniformData(command, 0, matrix.data(), sizeof(matrix));

            SDL_GPUColorTargetInfo color_info{};
            const bool multisampled = state.sample_count != SDL_GPU_SAMPLECOUNT_1;
            color_info.texture = multisampled                            ? state.msaa_color
                                 : capture_frame || transmission_enabled ? state.color
                                                                         : swapchain;
            // The scene's own pass configures no clear colour.
            const Color4 clear_color = scene_pass_clear_color(scene);
            // The pin's inverse runs in f64 and WebGPU's clear value stays
            // double; SDL_FColor is the one store that narrows, so the cast
            // sits at the store exactly like the pin's own f32 boundaries.
            color_info.clear_color =
                transmission_enabled
                    ? SDL_FColor{static_cast<float>(upstream::inverse_image_processed_channel(
                                     clear_color.r, scene.environment.exposure,
                                     scene.environment.contrast,
                                     scene.environment.tone_mapping_enabled)),
                                 static_cast<float>(upstream::inverse_image_processed_channel(
                                     clear_color.g, scene.environment.exposure,
                                     scene.environment.contrast,
                                     scene.environment.tone_mapping_enabled)),
                                 static_cast<float>(upstream::inverse_image_processed_channel(
                                     clear_color.b, scene.environment.exposure,
                                     scene.environment.contrast,
                                     scene.environment.tone_mapping_enabled)),
                                 clear_color.a}
                    : SDL_FColor{clear_color.r, clear_color.g, clear_color.b, clear_color.a};
            color_info.load_op = SDL_GPU_LOADOP_CLEAR;
            // Resolve opaque color for transmission sampling while preserving
            // the multisample attachment so transmissive draws can resume it.
            // An overlay layer preserves it for the same reason the pin's own
            // overlay does: "both scenes must use the base task's MSAA colour
            // texture before the overlay can load its pixels and resolve the
            // composited result" (scene/swapchain-overlay.ts).
            color_info.store_op = multisampled ? transmission_enabled || !overlay_plans.empty()
                                                     ? SDL_GPU_STOREOP_RESOLVE_AND_STORE
                                                     : SDL_GPU_STOREOP_RESOLVE
                                               : SDL_GPU_STOREOP_STORE;
            color_info.resolve_texture =
                multisampled ? capture_frame || transmission_enabled ? state.color : swapchain
                             : nullptr;
            SDL_GPUDepthStencilTargetInfo depth_info{};
            depth_info.texture = state.depth;
            depth_info.clear_depth = upstream::pinned_depth_clear;
            depth_info.load_op = SDL_GPU_LOADOP_CLEAR;
            depth_info.store_op = SDL_GPU_STOREOP_DONT_CARE;
            if (transmission_enabled) {
                depth_info.store_op = SDL_GPU_STOREOP_STORE;
            }
            depth_info.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
            depth_info.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
            SdlRenderPass pass{SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info)};
            set_pass_camera_viewport(pass, scene, engine, camera, width, height);
            bool scene_matrix_bound = true;
#if BBLITE_RENDERER_TRANSMISSION
            // The pin's transmission grab fires once, before the first
            // transmissive draw: the opaque scene colour resolved so far is
            // blitted into the 1024x1024 mip-chained refraction texture the
            // composed fragments sample.
            bool transmission_copied = false;
#endif
            const auto pipeline_for = [&](upstream::RenderPipelineKind kind,
                                          std::uint32_t shader_variant) {
                return secondary_pipeline_for(
                    SecondaryPipelines{
                        &state.shader_pipelines,
                        &state.shader_a2c_pipelines,
                    },
                    kind, shader_variant, "main dispatch");
            };
            // Which scene the pass being recorded belongs to. The base
            // scene records first and a swapchain overlay layer repoints
            // these before its own pass: the draw walk is the same one,
            // and what changes is the scene it reads its light selection,
            // its plan and its uploaded meshes from.
            // Which scene the pass being recorded belongs to: the base
            // scene, or the overlay layer whose own plan is being drawn.
            // Every reader is a material-variant draw, so a build that
            // composes no variants at all -- a splat-only scene, say --
            // sets it and never reads it.
            [[maybe_unused]] const Scene* pass_scene = &scene;
            const std::vector<GpuMesh>* pass_meshes = &state.meshes;
#if BBLITE_PINNED_MATERIALS
            // The frame's scene and lights blocks, once per frame rather
            // than per draw — the same hoist the Dawn backend's
            // write_pinned_frame_blocks already makes. A scene without a
            // camera pushes the block its pass last wrote.
            upstream::SceneUniforms pass_scene_block =
                write_pass_scene_block(pass_blocks.scene(scene), scene, engine, camera, matrix);
            std::vector<std::uint8_t> pass_lights_block = pinned_lights_block(scene, engine);
#endif
            const auto draw_render_list = [&](const upstream::RenderDrawList& list) {
                SDL_GPUGraphicsPipeline* bound_pipeline = nullptr;
                for (const upstream::RenderDrawCommand& draw : list.commands) {
                    if (!upstream::render_item_draws_now(draw.item, engine))
                        continue;
                    if (draw.item_index >= (*pass_meshes).size()) {
                        continue;
                    }
                    const upstream::RenderItem& item = draw.item;
                    const GpuMesh& mesh = (*pass_meshes)[draw.item_index];
                    const MaterialRecord* material = handle_find(engine.materials, item.material);
#if BBLITE_RENDERER_TRANSMISSION
                    if (transmission_enabled && !transmission_copied &&
                        transmissive_draw_material(material)) {
                        // executePassWithTransmission: end the pass (which
                        // resolves the multisampled colour), copy it into
                        // the refraction texture with its mip chain, and
                        // resume loading what was stored.
                        pass.end();
                        SDL_GPUBlitInfo transmission_blit{};
                        transmission_blit.source = SDL_GPUBlitRegion{
                            state.color, 0, 0, 0, 0, width, height,
                        };
                        transmission_blit.destination = SDL_GPUBlitRegion{
                            state.transmission_color,  0, 0, 0, 0, state.transmission_width,
                            state.transmission_height,
                        };
                        transmission_blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                        transmission_blit.flip_mode = SDL_FLIP_NONE;
                        transmission_blit.filter = SDL_GPU_FILTER_LINEAR;
                        SDL_BlitGPUTexture(command, &transmission_blit);
                        generate_texture_mipmaps(state.device, command, state.transmission_color,
                                                 state.transmission_width,
                                                 state.transmission_height,
                                                 transmission_grab_mip_count());
                        color_info.load_op = SDL_GPU_LOADOP_LOAD;
                        // Image processing reads the multisample attachment after
                        // this pass. Resolving alone discards its updated samples.
                        color_info.store_op = multisampled ? SDL_GPU_STOREOP_RESOLVE_AND_STORE
                                                           : SDL_GPU_STOREOP_STORE;
                        depth_info.load_op = SDL_GPU_LOADOP_LOAD;
                        pass = SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info);
                        // A restarted pass starts at the whole target
                        // again, so the camera's rectangle is set once
                        // per PASS rather than once per frame.
                        set_pass_camera_viewport(pass, scene, engine, camera, width, height);
                        bound_pipeline = nullptr;
                        transmission_copied = true;
                    }
#endif
#if BBLITE_PBR_VARIANTS > 0
                    // Babylon Lite's own composed stages own every PBR draw:
                    // the transcribed fragment is retired, so a draw the
                    // shared gate refuses is an error naming the mesh rather
                    // than a silent fallback.
                    pal::PinnedVariantKey pinned_key;
                    const std::size_t pinned_variant =
                        item.material_kind == upstream::RenderMaterialKind::pbr
                            ? pinned_variant_for_draw(*pass_scene, engine, draw, npos, &pinned_key)
                            : npos;
                    if (item.material_kind == upstream::RenderMaterialKind::pbr &&
                        pinned_variant == npos) {
                        gpu_error(("PBR draw for mesh " + std::to_string(item.mesh.value) +
                                   ", material " + std::to_string(item.material.value) +
                                   " resolves no pinned variant: " +
                                   pal::pinned_variant_request(pinned_key))
                                      .c_str());
                    }
                    if (pinned_variant != npos) {
                        ensure_pinned_slots(state, pinned_variant);
                    }
                    if (pinned_variant != npos) {
                        draw_pinned_variant(state, command, pass, *pass_scene, engine,
                                            pass_scene_block, pass_lights_block, draw, mesh,
                                            material, pinned_variant, bound_pipeline);
                        continue;
                    }
#else
                    if (item.material_kind == upstream::RenderMaterialKind::pbr) {
                        gpu_error("PBR draw in a build with no composed variant "
                                  "table; the transcribed fragment is retired.");
                    }
#endif
#if BBLITE_STANDARD_VARIANTS > 0
                    // Babylon Lite's own composed stages own every Standard
                    // draw too; a draw the gate refuses is an error naming
                    // the mesh rather than a silent fallback.
                    if (item.material_kind == upstream::RenderMaterialKind::standard) {
                        // The main pass carries no frame graph, so a
                        // render-target texture on a material has nothing
                        // to resolve against — refused by name rather
                        // than trusted to never happen.
                        if (material && (material->has_emissive_render_texture ||
                                         material->has_diffuse_render_texture)) {
                            gpu_error("a Standard material samples a "
                                      "render-target texture in the main pass, "
                                      "which carries no frame graph to resolve "
                                      "it.");
                        }
                        StandardVariantKey standard_key;
                        const std::size_t standard_variant = standard_variant_for_draw(
                            *pass_scene, engine, draw, npos, &standard_key);
                        if (standard_variant == npos) {
                            gpu_error(("Standard draw for mesh " + std::to_string(item.mesh.value) +
                                       ", material " + std::to_string(item.material.value) +
                                       " resolves no composed variant: " +
                                       standard_variant_request(*pass_scene, engine, draw))
                                          .c_str());
                        }
                        draw_standard_variant(state, command, pass, *pass_scene, engine,
                                              pass_scene_block, pass_lights_block, draw, mesh,
                                              material, standard_variant, standard_key.features,
                                              bound_pipeline);
                        continue;
                    }
#else
                    if (item.material_kind == upstream::RenderMaterialKind::standard) {
                        gpu_error("Standard draw in a build with no composed "
                                  "variant table; the transcribed fragment is "
                                  "retired.");
                    }
#endif
#if BBLITE_NODE_VARIANTS > 0
                    // A node graph's own compiled stages, the third
                    // composed family. Its variant is the graph's index,
                    // which the plan carries on the item.
                    if (item.material_kind == upstream::RenderMaterialKind::node) {
                        draw_node_variant(state, command, pass, *pass_scene, engine,
                                          pass_scene_block, pass_lights_block, draw, mesh,
                                          item.shader_variant, bound_pipeline, false, material);
                        continue;
                    }
#else
                    if (item.material_kind == upstream::RenderMaterialKind::node) {
                        gpu_error("a node material in a build with no composed "
                                  "graphs.");
                    }
#endif
                    SDL_GPUGraphicsPipeline* pipeline =
                        pipeline_for(draw.pipeline, draw.item.shader_variant);
                    if (!pipeline) {
                        throw std::runtime_error("Reached render pipeline was not created.");
                    }
                    if (pipeline != bound_pipeline) {
                        SDL_BindGPUGraphicsPipeline(pass, pipeline);
                        bound_pipeline = pipeline;
                    }
                    if (item.material_kind == upstream::RenderMaterialKind::shader) {
                        if (!material) {
                            pal::refuse_invalid_frame_handle(
                                "Shader draw has an invalid material.");
                        }
                        const ShaderDrawMatrices shader_matrices(
                            *pass_scene, engine, handle_at(engine.meshes, item.mesh),
                            frame_pass_matrices);
                        const ShaderPassMatrices shader_pass_matrices =
                            shader_matrices.apply(frame_pass_matrices);
                        // Per-stage blocks from the generated variant
                        // table: [optional scene worldViewProjection]
                        // [custom floats gathered from the material's
                        // flat value storage].
                        const upstream::ShaderVariantInfo& shader_info =
                            upstream::shader_variant_info(item.shader_variant);
                        const auto push_stage_block =
                            [&](const upstream::ShaderVariantStageBlock& block,
                                bool fragment_stage) {
                                if (!block.present)
                                    return;
                                shader_stage_block_floats(block, shader_pass_matrices, *material,
                                                          shader_block_scratch);
                                if (fragment_stage) {
                                    SDL_PushGPUFragmentUniformData(
                                        command, 0, shader_block_scratch.data(),
                                        static_cast<Uint32>(shader_block_scratch.size() *
                                                            sizeof(float)));
                                } else {
                                    SDL_PushGPUVertexUniformData(
                                        command, 0, shader_block_scratch.data(),
                                        static_cast<Uint32>(shader_block_scratch.size() *
                                                            sizeof(float)));
                                }
                            };
                        push_stage_block(shader_info.vertex, false);
                        push_stage_block(shader_info.fragment, true);
                        bind_stage_storage(
                            pass, state.shader_vertex_slots[item.shader_variant], false,
                            "shader material vertex stage", state.storage_binding_scratch,
                            [&](const std::string& name, std::size_t) {
                                return shader_storage_buffer(state, *material, shader_info, name);
                            });
                        bind_stage_storage(
                            pass, state.shader_fragment_slots[item.shader_variant], true,
                            "shader material fragment stage", state.storage_binding_scratch,
                            [&](const std::string& name, std::size_t) {
                                return shader_storage_buffer(state, *material, shader_info, name);
                            });
                        bind_shader_material_textures(state, pass, *pass_scene, engine, *material,
                                                      item.shader_variant, mesh);
                        if (shader_info.vertex.present) {
                            scene_matrix_bound = block_is_shared_scene_matrix(shader_info.vertex);
                        }
                    }
                    const SDL_GPUBufferBinding index_binding{
                        mesh.indices,
                        0,
                    };
                    bind_mesh_vertex_buffers(pass, mesh);
                    SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
                    count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, mesh.index_count,
                                   mesh.instance_count, 0, 0, 0);
                }
            };
#if BBLITE_PINNED_BACKGROUNDS
            // One background arm over the pass's scene block. Without a
            // camera the arm projects through the unwritten zero block and
            // reaches no fragment. The arm's blocks take slot zero, which
            // the mesh paths read as the scene matrix.
            const auto draw_background =
                [&](std::optional<upstream::PinnedBackgroundArmKind> kind) {
                    if (!kind)
                        return;
                    draw_background_arm(command, pass, state.background_arm(*kind),
                                        pass_scene_block);
                    scene_matrix_bound = false;
                };
#endif
#if BBLITE_HAS_BILLBOARDS
            // A billboard system draws in the slot its depth mode gives it:
            // 100 among the opaque meshes, because a cutout system writes
            // depth and everything after has to see it, and 200 after the
            // scene's own stages for the transparent modes.
            const auto draw_billboards = [&](BillboardDepthMode mode) {
                const upstream::SceneUniforms billboard_block = write_billboard_scene_block(
                    pass_blocks.scene(scene), scene, engine, camera, matrix, frame_view);
                for (const BillboardPass& billboard : state.billboard_passes) {
                    if (handle_at(engine.billboard_systems, billboard.system).depth_mode != mode) {
                        continue;
                    }
                    record_billboard_pass(command, pass, engine, billboard, billboard_block);
                }
            };
#endif
            for (const upstream::RenderStage stage : render_plan.stages) {
                switch (stage) {
                case upstream::RenderStage::skybox:
                    // The sub-order comes from the shared
                    // `skybox_stage_order`.
#if BBLITE_PINNED_BACKGROUNDS
                    for (const SkyboxLayer layer : skybox_stage_order)
                        draw_background(state.background_draws.skybox(layer));
#endif
                    break;
                case upstream::RenderStage::opaque:
                    draw_render_list(render_plan.draw_lists.opaque);
#if BBLITE_HAS_SPRITE_RENDERER
                    if (has_scene_sprite_pass) {
                        record_scene_sprite_pass(command, pass, engine, scene_sprite_pass,
                                                 Sprite2DDepthMode::test_write, width, height);
                    }
#endif
#if BBLITE_HAS_BILLBOARDS
                    draw_billboards(BillboardDepthMode::cutout);
#endif
                    break;
                case upstream::RenderStage::transparent:
                    draw_render_list(render_plan.draw_lists.transparent);
#if BBLITE_HAS_TEXT
                    state.text->scene.draw(state.text->borrow_pass(command, pass),
                                           bbl::text_surface(engine));
#endif
#if BBLITE_HAS_SPRITE_RENDERER
                    if (has_scene_sprite_pass) {
                        record_scene_sprite_pass(command, pass, engine, scene_sprite_pass,
                                                 Sprite2DDepthMode::test, width, height);
                    }
#endif
#if BBLITE_HAS_SPLATS
                    // `isTransparent: true` on the pinned renderable, so
                    // a cloud belongs to this bucket. The Dawn sibling
                    // states the ordering caveat.
                    for (const SplatPass& splat : state.splat_passes) {
                        record_splat_pass(command, pass, engine, splat, frame_view,
                                          frame_projection, frame_camera_position,
                                          static_cast<double>(width), static_cast<double>(height));
                    }
#endif
                    break;
                case upstream::RenderStage::ground:
#if BBLITE_PINNED_BACKGROUNDS
                    draw_background(state.background_draws.ground);
#endif
                    break;
                }
            }
#if BBLITE_HAS_BILLBOARDS
            // The transparent systems close the scene's pass: they blend
            // over every stage above and test against the depth they wrote.
            draw_billboards(BillboardDepthMode::transparent);
#endif
            pass.end();
#if BBLITE_HAS_TEXT || BBLITE_NODE_GEOMETRY_VARIANTS > 0
            capture_render_state();
#endif
            // The swapchain overlay layers. Each is its own render pass on
            // the same colour attachment with a FRESH depth buffer, which is
            // what `createUtilityLayer` documents: the overlay scene keeps
            // normal depth testing among its own meshes and never tests
            // against the base scene's, so a gizmo body occludes its own
            // back faces while sitting in front of everything below it.
            for (std::size_t layer = 0;
                 layer < overlay_plans.size() && layer < state.overlay_meshes.size(); ++layer) {
                Scene* overlay_scene = engine.registered_scenes[layer + 1u].get();
                if (!overlay_scene)
                    continue;
                if (layer < overlay_topology_versions.size() &&
                    overlay_scene->render_topology_version != overlay_topology_versions[layer]) {
                    gpu_error(
                        "A swapchain overlay changed its renderables after resource synchronization.");
                }
                // The layer's own scene pass: upstream each scene's render
                // task resolves `cfg.cam ?? scene.camera` over its OWN scene
                // and projects at its own extent's aspect, so two scenes
                // splitting one target by viewport project at two ratios. A
                // layer without a camera draws through the zero block.
                const PixelViewport overlay_surface_extent =
                    scene_surface_extent(engine, *overlay_scene, width, height);
                const PassCamera overlay_pass = build_kept_pass_camera(
                    *overlay_scene, engine, scene_pass_camera(engine, *overlay_scene),
                    overlay_surface_extent.width, overlay_surface_extent.height,
                    pass_blocks.scene(*overlay_scene));
                const std::array<float, 16>& overlay_matrix = overlay_pass.matrices.view_projection;
                pass_scene = overlay_scene;
                pass_meshes = &state.overlay_meshes[layer];
#if BBLITE_PINNED_MATERIALS
                pass_scene_block = write_pass_scene_block(pass_blocks.scene(*overlay_scene),
                                                          *overlay_scene, engine, overlay_pass);
                pass_lights_block = pinned_lights_block(*overlay_scene, engine);
#endif
                color_info.load_op = SDL_GPU_LOADOP_LOAD;
                depth_info.load_op = SDL_GPU_LOADOP_CLEAR;
                depth_info.clear_depth = upstream::pinned_depth_clear;
                pass = SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info);
                set_pass_camera_viewport(pass, *overlay_scene, engine, overlay_pass.camera, width,
                                         height);
                SDL_PushGPUVertexUniformData(command, 0, overlay_matrix.data(),
                                             sizeof(overlay_matrix));
                scene_matrix_bound = true;
                for (const upstream::RenderStage stage : overlay_plans[layer].stages) {
                    switch (stage) {
                    case upstream::RenderStage::opaque:
                        draw_render_list(overlay_plans[layer].draw_lists.opaque);
                        break;
                    case upstream::RenderStage::transparent:
                        draw_render_list(overlay_plans[layer].draw_lists.transparent);
                        break;
                    default:
                        // A utility layer carries no environment, so
                        // its plan reaches no background stage; a plan
                        // that grew one would need its own resources
                        // rather than the base scene's.
                        break;
                    }
                }
                pass.end();
            }
            visible_color = capture_frame ? state.color : swapchain;
#if BBLITE_RENDERER_TRANSMISSION
            if (transmission_enabled) {
                SDL_GPUColorTargetInfo image_processing_target{};
                image_processing_target.texture = state.processed_color;
                image_processing_target.load_op = SDL_GPU_LOADOP_DONT_CARE;
                image_processing_target.store_op = SDL_GPU_STOREOP_STORE;
                SdlRenderPass image_processing_pass{
                    SDL_BeginGPURenderPass(command, &image_processing_target, 1, nullptr)};
                SDL_BindGPUGraphicsPipeline(image_processing_pass, state.image_processing_pipeline);
                const ImageProcessingUniforms image_processing{{
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
                    0.0f,
                }};
                push_stage_uniform(command, state.image_processing_params_slot, &image_processing,
                                   sizeof(image_processing));
                if (state.per_sample_image_processing) {
                    // A Texture2DMS is Load()-ed and carries no sampler,
                    // so it binds as a storage texture rather than as a
                    // sampler pair.
                    SDL_BindGPUFragmentStorageTextures(image_processing_pass, 0, &state.msaa_color,
                                                       1);
                } else {
                    const SDL_GPUTextureSamplerBinding source_binding{
                        state.color,
                        state.background_sampler,
                    };
                    SDL_BindGPUFragmentSamplers(image_processing_pass, 0, &source_binding, 1);
                }
                count_gpu_draw(SDL_DrawGPUPrimitives, image_processing_pass, 3, 1, 0, 0);
                image_processing_pass.end();
                visible_color = state.processed_color;
            }
#endif
#if BBLITE_HAS_SPRITE_RENDERER
            // The scene is the first rendering context; registered sprite
            // contexts then load and blend over its final single-sample
            // colour, in registration order. Rendering before the blit keeps
            // screenshots and presentation on the same composed image.
            if (!engine.registered_sprite_renderers.empty()) {
                for (const SpriteRendererHandle handle : engine.registered_sprite_renderers) {
                    if (handle.value >= sprite_passes.size()) {
                        throw std::runtime_error("A SpriteRenderer created after the scene frame "
                                                 "started has no GPU pass yet.");
                    }
                    const SpriteRendererRecord& renderer =
                        handle_at(engine.sprite_renderers, handle);
                    SDL_GPUColorTargetInfo sprite_target{};
                    sprite_target.texture = renderer.has_target
                                                ? handle_at(sprite_render_textures, renderer.target)
                                                : visible_color;
                    sprite_target.load_op =
                        renderer.clear ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
                    sprite_target.store_op = SDL_GPU_STOREOP_STORE;
                    sprite_target.clear_color =
                        SDL_FColor{renderer.clear_value.r, renderer.clear_value.g,
                                   renderer.clear_value.b, renderer.clear_value.a};
                    SdlRenderPass sprite_pass{
                        SDL_BeginGPURenderPass(command, &sprite_target, 1, nullptr)};
                    record_sprite_pass(command, sprite_pass, engine,
                                       handle_at(sprite_passes, handle), width, height);
                    sprite_pass.end();
                }
            }
#endif
        }
    }

    void present_readable_surface() {
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        UiSdlReadableSurface::present(current_frame().command, current_frame().swapchain,
                                      current_frame().present_swapchain, current_frame().width,
                                      current_frame().height);
#endif
    }

    void present() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& captures = data_.captures;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& swapchain_format = data_.swapchain_format;
        [[maybe_unused]] auto& transmission_enabled = data_.transmission_enabled;
        [[maybe_unused]] auto& state = data_.resources.state;
        [[maybe_unused]] auto& screenshot_path = data_.frame_options.screenshot_path;
        [[maybe_unused]] auto& id_buffer_path = data_.frame_options.id_buffer_path;
        [[maybe_unused]] auto& cluster_buffer_path = data_.frame_options.cluster_buffer_path;
#if BBLITE_HAS_UI && !BBLITE_WORKERS
        [[maybe_unused]] auto& capture_ui = data_.frame_options.capture_ui;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen = data_.offscreen;
#endif
#if BBLITE_OFFSCREEN_SURFACES
        [[maybe_unused]] auto& offscreen_target = *data_.offscreen_target;
#endif
        [[maybe_unused]] auto& width = current_frame().width;
        [[maybe_unused]] auto& height = current_frame().height;
        [[maybe_unused]] const auto& matrix = current_frame().frame_camera.view_projection;
        [[maybe_unused]] const auto& capture_frame = current_frame().capture_frame;
        [[maybe_unused]] const auto& capture_ids = current_frame().capture_ids;
        [[maybe_unused]] const auto& capture_clusters = current_frame().capture_clusters;
        [[maybe_unused]] auto& swapchain = current_frame().swapchain;
        [[maybe_unused]] auto& command = current_frame().command;
        [[maybe_unused]] auto& capture_texture = current_frame().capture_texture;
        [[maybe_unused]] auto& visible_color = current_frame().visible_color;
        if (current_frame().graph) {
            if (capture_texture == state.color && capture_texture) {
                SDL_GPUBlitInfo present{};
                present.source = SDL_GPUBlitRegion{state.color, 0, 0, 0, 0, width, height};
                present.destination = SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
                present.load_op = SDL_GPU_LOADOP_DONT_CARE;
                present.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &present);
            }
#if BBLITE_HAS_UI && !BBLITE_WORKERS
            SDL_GPUTexture* ui_target = capture_frame && capture_ui ? capture_texture : swapchain;
            if (!ui_target) {
                throw std::runtime_error("Frame graph did not present a native UI target.");
            }
            render_sprite_ui_sdl_frame(state.device, command, ui_target, swapchain_format, state.ui,
                                       *current_frame().ui_frame, nullptr, nullptr,
                                       state.sample_count);
            if (ui_target != swapchain) {
                // The graph presented before the overlay was recorded.
                // Present the same composite that the explicit UI
                // screenshot mode reads back below.
                SDL_GPUBlitInfo ui_blit{};
                ui_blit.source = SDL_GPUBlitRegion{ui_target, 0, 0, 0, 0, width, height};
                ui_blit.destination = SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
                ui_blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                ui_blit.flip_mode = SDL_FLIP_NONE;
                ui_blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &ui_blit);
            }
#endif
            present_readable_surface();
            if (capture_frame) {
                if (!capture_texture) {
                    throw std::runtime_error("Frame graph did not present a capture source.");
                }
                save_texture_png(state.device, command, capture_texture, swapchain_format, width,
                                 height, screenshot_path);
                captures.screenshot_saved = true;
            }
#if BBLITE_OFFSCREEN_SURFACES
            else if (offscreen) {
                offscreen_target.publish(command, *offscreen);
            }
#endif
            else if (!command.submit()) {
                gpu_error("SDL_SubmitGPUCommandBuffer frame graph");
            }
        } else {
#if BBLITE_HAS_UI && !BBLITE_WORKERS
            if (capture_frame && capture_ui) {
                // Render the UI into the readback texture, then present that
                // exact result below.
                render_sprite_ui_sdl_frame(state.device, command, visible_color, swapchain_format,
                                           state.ui, *current_frame().ui_frame, nullptr, nullptr,
                                           state.sample_count);
            }
#endif
            if (capture_frame || transmission_enabled) {
                SDL_GPUBlitInfo blit{};
                blit.source = SDL_GPUBlitRegion{visible_color, 0, 0, 0, 0, width, height};
                blit.destination = SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
                blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                blit.flip_mode = SDL_FLIP_NONE;
                blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &blit);
            }
#if BBLITE_HAS_UI && !BBLITE_WORKERS
            if (!(capture_frame && capture_ui)) {
                // A canvas-only attribution capture omits the UI from
                // `visible_color` but still draws it over the presented
                // swapchain.
                render_sprite_ui_sdl_frame(state.device, command, swapchain, swapchain_format,
                                           state.ui, *current_frame().ui_frame, nullptr, nullptr,
                                           state.sample_count);
            }
#endif
            present_readable_surface();
            if (capture_frame) {
                save_texture_png(state.device, command, visible_color, swapchain_format, width,
                                 height, screenshot_path);
                captures.screenshot_saved = true;
            }
#if BBLITE_OFFSCREEN_SURFACES
            else if (offscreen) {
                offscreen_target.publish(command, *offscreen);
            }
#endif
            else if (!command.submit()) {
                gpu_error("SDL_SubmitGPUCommandBuffer");
            }
        }
#if BBLITE_GPU_TASK_TIMING
        finish_gpu_task_timing_frame(engine);
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
        finish_compute_frame_prefix(engine);
#endif
        if (capture_ids) {
            save_geometry_id_buffer_png(state, width, height, matrix, render_plan.items, scene,
                                        engine, id_buffer_path, false);
            captures.id_buffer_saved = true;
        }
        if (capture_clusters) {
            save_geometry_id_buffer_png(state, width, height, matrix, render_plan.items, scene,
                                        engine, cluster_buffer_path, true);
            captures.cluster_buffer_saved = true;
        }
#if BBLITE_DEVICE_RECOVERY
        if (engine.device_recovery) {
            auto& recovery = *engine.device_recovery;
            recovery.environments[scene.state.get()] = {
                engine.device_generation, reinterpret_cast<std::uintptr_t>(state.environment)};
            std::size_t renderable_count = state.meshes.size();
#if BBLITE_PINNED_BACKGROUNDS
            renderable_count += state.background_arms.size();
#endif
            recovery.renderable_counts[scene.state.get()] = renderable_count;
#if BBLITE_SHADOW_RECEIVERS
            recovery.shadows.resize(state.shadow_generators.size());
            for (std::size_t i = 0; i < state.shadow_generators.size(); ++i) {
                recovery.shadows[i] = {
                    engine.device_generation,
                    reinterpret_cast<std::uintptr_t>(state.shadow_generators[i].map)};
            }
#endif
            recovery.resources_ready = true;
        }
#endif
    }

    void complete() {
        [[maybe_unused]] auto& engine = data_.engine;
        [[maybe_unused]] auto& frame = data_.frame;
        [[maybe_unused]] auto& cpu_profile = data_.cpu_profile;
        [[maybe_unused]] auto& mem_profile = data_.mem_profile;
        [[maybe_unused]] auto& scene = data_.scene;
        [[maybe_unused]] auto& render_plan = data_.render_plan;
        [[maybe_unused]] auto& task_draw_lists = data_.task_draw_lists;
        [[maybe_unused]] auto& state = data_.resources.state;
        [[maybe_unused]] auto& samples = data_.samples_ms;
        [[maybe_unused]] const auto benchmark = data_.frame_options.benchmarking();
        [[maybe_unused]] const auto warmup = data_.frame_options.benchmark_warmup();
        [[maybe_unused]] const auto& start = current_frame().start;
        [[maybe_unused]] const auto& updated = current_frame().updated;
        [[maybe_unused]] const auto& uploaded = current_frame().uploaded;
        [[maybe_unused]] const auto& acquired = current_frame().acquired;
        finish_frame(engine);
        ++frame;
        const double end = monotonic_milliseconds();
        const long completed_frame = frame - 1;
        data_.frame_rate_profile.complete(completed_frame);
        if (cpu_profile && frame_profile_due(completed_frame, end - start)) {
            std::size_t draw_commands = render_plan.draw_lists.opaque.commands.size() +
                                        render_plan.draw_lists.transparent.commands.size();
            for (const upstream::RenderDrawLists& lists : task_draw_lists) {
                draw_commands += lists.opaque.commands.size() + lists.transparent.commands.size();
            }
            // No `write_ms`: per-draw uniform writes are Dawn's own
            // phase, so this line never carried the field.
            print_cpu_frame_profile(completed_frame, end - start, acquired - start,
                                    updated - acquired, uploaded - updated, std::nullopt,
                                    end - uploaded, render_plan.items.size(), draw_commands);
        }
        if (mem_profile.due(completed_frame)) {
            mem_profile.print(completed_frame, engine, scene, state.meshes,
                              state.shared_shader_geometries);
        }
        if (benchmark && completed_frame >= warmup) {
            samples.push_back(end - start);
        }
    }

    void finish_run() {
        [[maybe_unused]] auto& state = data_.resources.state;
        [[maybe_unused]] auto& samples = data_.samples_ms;
        report_benchmark(samples, "SDL_GPU", SDL_GetGPUDeviceDriver(state.device));
        if (!SDL_WaitForGPUIdle(state.device)) {
            gpu_error("SDL_WaitForGPUIdle");
        }
    }
};
#endif

SceneRun run_gpu_engine(Engine& engine) {
#if BBLITE_HAS_PBR_RENDERER
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front())
        throw std::runtime_error("GPU renderer requires a registered scene.");
    SdlSceneRun renderer(engine);
    renderer.setup();
    for (;;) {
        renderer.discard_frame();
        const FrameOutcome outcome = conduct_frame(renderer);
        if (outcome == FrameOutcome::stopped || outcome == FrameOutcome::restart)
            break;
        if (outcome == FrameOutcome::rendered || renderer.yield_when_skipped())
            BBLITE_FRAME_YIELD(outcome == FrameOutcome::rendered);
    }
    renderer.discard_frame();
    renderer.finish_run();
    BBLITE_RUN_RETURN(true);
#else
    const FrameOptions frame_options = read_frame_options();
    reject_unsupported_frame_options(frame_options, "SDL_GPU",
                                     /*supports_single_sample=*/true,
                                     /*supports_copy_task=*/true);
    (void)engine;
    BBLITE_RUN_RETURN(false);
#endif
}

} // namespace bbl::pal
