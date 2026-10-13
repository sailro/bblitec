// SDL_GPU scene targets: depth, color, transmission and frame-graph
// textures and the geometry id readback. Dawn's twin is
// pal_dawn_scene_targets.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_canvas_targets.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_targets.hpp"
#include "pal_gpu_pipeline.hpp"
#include <bblite/features/has_effect_task.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_post_process.hpp>
#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/features/live_task_add.hpp>
#include <bblite/features/render_target_disposal.hpp>
#include <bblite/features/render_task_transmission.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER
void release_sized_texture(GpuState& state, SDL_GPUTexture*& texture, std::uint32_t& width,
                           std::uint32_t& height) {
    if (texture) {
        SDL_ReleaseGPUTexture(state.device, texture);
        texture = nullptr;
    }
    width = 0;
    height = 0;
}

void create_depth(GpuState& state, std::uint32_t width, std::uint32_t height) {
    if (state.depth && state.depth_width == width && state.depth_height == height)
        return;
    release_sized_texture(state, state.depth, state.depth_width, state.depth_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = state.depth_format;
    info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = state.sample_count;
    state.depth = SDL_CreateGPUTexture(state.device, &info);
    if (!state.depth)
        gpu_error("SDL_CreateGPUTexture depth");
    state.depth_width = width;
    state.depth_height = height;
}

void create_msaa_color(GpuState& state, SDL_GPUTextureFormat format, std::uint32_t width,
                       std::uint32_t height) {
    if (state.sample_count == SDL_GPU_SAMPLECOUNT_1)
        return;
    if (state.msaa_color && state.msaa_color_width == width && state.msaa_color_height == height) {
        return;
    }
    release_sized_texture(state, state.msaa_color, state.msaa_color_width, state.msaa_color_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    // GRAPHICS_STORAGE_READ is what lets the final pass process each
    // sample instead of the resolved pixel. Stock SDL rejects a
    // multisample texture carrying any read usage; libsdl-org/SDL#15838
    // relaxes that to COMPUTE_STORAGE_WRITE only and gives D3D12 a
    // TEXTURE2DMS shader-resource view.
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = state.sample_count;
    state.msaa_color = SDL_CreateGPUTexture(state.device, &info);
    if (!state.msaa_color)
        gpu_error("SDL_CreateGPUTexture MSAA color");
    state.msaa_color_width = width;
    state.msaa_color_height = height;
}

void create_color(GpuState& state, SDL_GPUTextureFormat format, std::uint32_t width,
                  std::uint32_t height, bool canvas) {
    if (state.color && state.color_width == width && state.color_height == height)
        return;
    release_sized_texture(state, state.color, state.color_width, state.color_height);
    state.color = create_frame_texture(
        state.device, format, SDL_GPU_SAMPLECOUNT_1, width, height,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER, 1, canvas);
    state.color_width = width;
    state.color_height = height;
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_RENDERER_TRANSMISSION
void create_processed_color(GpuState& state, SDL_GPUTextureFormat format, std::uint32_t width,
                            std::uint32_t height) {
    if (state.processed_color && state.processed_color_width == width &&
        state.processed_color_height == height) {
        return;
    }
    release_sized_texture(state, state.processed_color, state.processed_color_width,
                          state.processed_color_height);
    state.processed_color = create_frame_texture(
        state.device, format, SDL_GPU_SAMPLECOUNT_1, width, height,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER, 1, true);
    state.processed_color_width = width;
    state.processed_color_height = height;
}

void create_transmission_color(GpuState& state) {
    // The pin's refraction grab: the shared fixed-extent, shortened-chain
    // contract (shared GPU helpers), whatever the surface size
    // (frame-graph/transmission.ts).
    const std::uint32_t width = transmission_grab_size;
    const std::uint32_t height = transmission_grab_size;
    if (state.transmission_color && state.transmission_width == width &&
        state.transmission_height == height) {
        return;
    }
    release_sized_texture(state, state.transmission_color, state.transmission_width,
                          state.transmission_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = transmission_grab_mip_count();
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.transmission_color = SDL_CreateGPUTexture(state.device, &info);
    if (!state.transmission_color) {
        gpu_error("SDL_CreateGPUTexture transmission color");
    }
    state.transmission_width = width;
    state.transmission_height = height;
}
#endif

#if BBLITE_HAS_PBR_RENDERER
void encode_metal_depth_copy(GpuState& state, SDL_GPUCommandBuffer* command,
                             const GpuRenderTarget& target) {
    if (!state.depth_copy_pipeline) {
        constexpr const char* source = R"msl(
#include <metal_stdlib>
using namespace metal;
vertex float4 copy_vs(uint i [[vertex_id]]) {
    return float4(float2(i == 1 ? 3.0 : -1.0, i == 2 ? 3.0 : -1.0), 0, 1);
}
fragment float copy_fs(float4 p [[position]], depth2d<float> t [[texture(0)]]) {
    return t.read(uint2(p.xy));
}
)msl";
        SDL_GPUShaderCreateInfo shader{};
        shader.code = reinterpret_cast<const Uint8*>(source);
        shader.code_size = std::strlen(source);
        shader.format = SDL_GPU_SHADERFORMAT_MSL;
        shader.entrypoint = "copy_vs";
        shader.stage = SDL_GPU_SHADERSTAGE_VERTEX;
        OwnedSdlShader vertex{SDL_CreateGPUShader(state.device, &shader), {state.device}};
        if (!vertex)
            gpu_error("SDL_CreateGPUShader depth copy vertex");
        shader.entrypoint = "copy_fs";
        shader.stage = SDL_GPU_SHADERSTAGE_FRAGMENT;
        shader.num_samplers = 1;
        OwnedSdlShader fragment{SDL_CreateGPUShader(state.device, &shader), {state.device}};
        if (!fragment)
            gpu_error("SDL_CreateGPUShader depth copy fragment");
        SDL_GPUColorTargetDescription color{};
        color.format = SDL_GPU_TEXTUREFORMAT_R32_FLOAT;
        SDL_GPUGraphicsPipelineCreateInfo pipeline{};
        pipeline.vertex_shader = vertex.get();
        pipeline.fragment_shader = fragment.get();
        pipeline.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline.target_info.num_color_targets = 1;
        pipeline.target_info.color_target_descriptions = &color;
        state.depth_copy_pipeline = OwnedSdlPipeline{
            create_sdl_gpu_graphics_pipeline(state.device, vertex, &pipeline), {state.device}};
        if (!state.depth_copy_pipeline)
            gpu_error("SDL_CreateGPUGraphicsPipeline depth copy");
    }
    SDL_GPUColorTargetInfo color{};
    color.texture = target.depth_copy;
    color.load_op = SDL_GPU_LOADOP_DONT_CARE;
    color.store_op = SDL_GPU_STOREOP_STORE;
    SdlRenderPass pass{SDL_BeginGPURenderPass(command, &color, 1, nullptr)};
    if (!pass)
        gpu_error("SDL_BeginGPURenderPass depth copy");
    SDL_BindGPUGraphicsPipeline(pass, state.depth_copy_pipeline.get());
    const SDL_GPUTextureSamplerBinding binding{target.depth, state.depth_sampler};
    SDL_BindGPUFragmentSamplers(pass, 0, &binding, 1);
    count_gpu_draw(SDL_DrawGPUPrimitives, pass, 3, 1, 0, 0);
}

void release_render_target(SDL_GPUDevice* device, GpuRenderTarget& target) {
    if (target.retained) {
        target = {};
        return;
    }
    if (target.sampled_color && target.sampled_color != target.color) {
        SDL_ReleaseGPUTexture(device, target.sampled_color);
    }
    if (target.color)
        SDL_ReleaseGPUTexture(device, target.color);
    if (target.depth)
        SDL_ReleaseGPUTexture(device, target.depth);
    if (target.depth_copy)
        SDL_ReleaseGPUTexture(device, target.depth_copy);
    target = {};
}

std::shared_ptr<GpuRenderTarget> retain_render_target(SDL_GPUDevice* device,
                                                      GpuRenderTarget& target) {
    if (!target.retained) {
        target.retained = std::shared_ptr<GpuRenderTarget>(
            new GpuRenderTarget(target), [device](GpuRenderTarget* image) {
                release_render_target(device, *image);
                delete image;
            });
    }
    return target.retained;
}

void release_frame_graph_textures(GpuState& state, const Engine* preserve) {
    for (std::size_t index = 0; index < state.render_targets.size(); ++index) {
        if (preserve && index < preserve->render_targets.size() &&
            preserve->render_targets[index].lifecycle && !preserve->render_targets[index].retired)
            continue;
        release_render_target(state.device, state.render_targets[index]);
    }
    for (GpuGeometryTask& task : state.geometry_tasks) {
        for (std::size_t index = 0; index < task.colors.size(); ++index) {
            if (index < task.sampled_colors.size() && task.sampled_colors[index] &&
                task.sampled_colors[index] != task.colors[index]) {
                SDL_ReleaseGPUTexture(state.device, task.sampled_colors[index]);
            }
            if (task.colors[index]) {
                SDL_ReleaseGPUTexture(state.device, task.colors[index]);
            }
        }
        if (task.depth)
            SDL_ReleaseGPUTexture(state.device, task.depth);
        if (task.params)
            SDL_ReleaseGPUBuffer(state.device, task.params);
        task.colors.clear();
        task.sampled_colors.clear();
        task.depth = nullptr;
        task.params = nullptr;
    }
#if BBLITE_HAS_POST_PROCESS
    for (std::vector<GpuPostProcessTask>& passes : state.post_process_tasks) {
        for (GpuPostProcessTask& task : passes) {
            task = {};
        }
    }
    state.post_process_tasks.clear();
    // The programs outlive no build: a rebuilt graph may target different
    // formats, and every pass that borrowed one is being reset above.
    state.post_process_programs.clear();
    if (state.post_process_present) {
        SDL_ReleaseGPUTexture(state.device, state.post_process_present);
        state.post_process_present = nullptr;
    }
#endif
#if BBLITE_HAS_EFFECT_TASK
    // An effect pass outlives no build either: its pipeline was built
    // against the target's format and sample count, and a rebuilt graph may
    // change both.
    for (EffectPass& pass : state.effect_tasks) {
        release_effect_pass(state.device, pass);
    }
    state.effect_tasks.clear();
#endif
    state.frame_graph_width = 0;
    state.frame_graph_height = 0;
}

SDL_GPUTextureFormat depth_texture_format(const GpuState& state, const RenderTargetRecord& record) {
    if (record.shadow_map)
        return SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
    switch (record.depth_format) {
    // Stencil is not used by reached scene pipelines; retain the backend's supported depth format.
    case DepthTextureFormat::depth24_plus_stencil8:
    case DepthTextureFormat::depth24_plus:
        return state.depth_format;
    case DepthTextureFormat::depth16_unorm:
        return SDL_GPU_TEXTUREFORMAT_D16_UNORM;
    case DepthTextureFormat::depth32_float:
        return SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
    }
    throw std::runtime_error("Unrepresented depth texture format.");
}

void create_frame_graph_textures(GpuState& state, const Engine& engine,
                                 SDL_GPUTextureFormat surface_format, std::uint32_t width,
                                 std::uint32_t height) {
#if BBLITE_RENDER_TARGET_DISPOSAL
    require_live_render_targets(engine);
#endif
#if BBLITE_LIVE_TASK_ADD
    require_recorded_tasks(engine);
#endif
    if (state.render_targets_version == engine.render_targets_version &&
        state.render_targets.size() == engine.render_targets.size() &&
        state.frame_graph_width == width && state.frame_graph_height == height &&
        !surface_targets_changed(engine, state.render_targets, width, height)) {
        synchronize_render_target_lifecycles(engine);
        return;
    }
    const auto target_plans =
        plan_render_targets(engine, width, height, surface_format,
                            [](TextureFormatClass format) { return texture_format(format); });
    release_frame_graph_textures(state, &engine);
#if BBLITE_SHADOW_RECEIVERS
    // Every shadow map was just released with the other targets, so the
    // render gate's "already rendered" sentinels no longer describe a
    // texture that exists: each generator's next frame must render.
    state.shadow_refresh.invalidate_rendered_maps();
#endif
    state.render_targets.resize(engine.render_targets.size());
    const auto canvas_resolves = canvas_resolve_targets(engine);
    for (std::size_t index = 0; index < target_plans.size(); ++index) {
        const RenderTargetRecord record = engine.render_targets[index];
        if (record.retired)
            continue;
        const auto& planned = target_plans[index];
        auto& current = state.render_targets[index];
        std::shared_ptr<GpuRenderTarget> replacement;
        const auto release = [device = state.device
#if BBLITE_OFFSCREEN_SURFACES
                              ,
                              owner = engine.offscreen_run
#endif
        ](GpuRenderTarget* target) {
#if BBLITE_OFFSCREEN_SURFACES
            (void)owner;
#endif
            release_render_target(device, *target);
            delete target;
        };
        if (record.lifecycle) {
            if (current.allocation && current.width == planned.width &&
                current.height == planned.height && current.color_format == planned.color_format) {
                record.lifecycle->synchronize();
                continue;
            }
            record.lifecycle->prepare_resize();
            replacement = std::shared_ptr<GpuRenderTarget>(new GpuRenderTarget{}, release);
        }
        GpuRenderTarget& target = replacement ? *replacement : current;
        target.width = planned.width;
        target.height = planned.height;
        target.color_format = planned.color_format;
        target.depth_format =
            record.has_depth ? depth_texture_format(state, record) : SDL_GPU_TEXTUREFORMAT_INVALID;
        if (record.swapchain)
            continue;
        target.allocation = ++state.render_target_allocations;
        const auto samples = task_sample_count(state, record.samples);
        const auto color_format = planned.color_format;
        if (record.has_color) {
            auto color_usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
            if (samples == SDL_GPU_SAMPLECOUNT_1) {
                color_usage |= SDL_GPU_TEXTUREUSAGE_SAMPLER;
            }
            target.color =
                create_frame_texture(state.device, color_format, samples, target.width,
                                     target.height, color_usage, 1, canvas_resolves[index]);
            target.sampled_color =
                samples == SDL_GPU_SAMPLECOUNT_1
                    ? target.color
                    : create_frame_texture(state.device, color_format, SDL_GPU_SAMPLECOUNT_1,
                                           target.width, target.height,
                                           SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                                               SDL_GPU_TEXTUREUSAGE_SAMPLER);
        }
        if (record.has_depth) {
            // A shadow map states its own format: the pinned generator
            // creates `depth32float` where every other attachment takes the
            // device's own preferred sampled-depth format.
            target.depth = create_frame_texture(
                state.device, target.depth_format, samples, target.width, target.height,
                SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET |
                    (record.sampled_depth ? SDL_GPU_TEXTUREUSAGE_SAMPLER : 0),
                // One layer per cascade for a cascaded shadow map, one for
                // every other attachment. `create_render_target` normalises
                // it, so the record's own invariant is at least one.
                record.depth_layers);
            if (record.sampled_depth && !record.shadow_map && !record.has_color &&
                std::strcmp(SDL_GetGPUDeviceDriver(state.device), "metal") == 0) {
                if (record.depth_layers != 1 || samples != SDL_GPU_SAMPLECOUNT_1) {
                    throw std::runtime_error(
                        "Sampled color-less Metal depth requires one layer and one sample.");
                }
                target.depth_copy = create_frame_texture(
                    state.device, SDL_GPU_TEXTUREFORMAT_R32_FLOAT, SDL_GPU_SAMPLECOUNT_1,
                    target.width, target.height,
                    SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
            }
        }
        if (replacement) {
            auto previous = std::shared_ptr<GpuRenderTarget>(
                new GpuRenderTarget(std::exchange(current, std::exchange(*replacement, {}))),
                release);
            if (previous->allocation) {
                record.lifecycle->replaced([previous, device = state.device] {
                    release_render_target(device, *previous);
                });
            }
        }
    }

    if (state.geometry_tasks.size() < engine.frame_tasks.size()) {
        state.geometry_tasks.resize(engine.frame_tasks.size());
    }
#if BBLITE_HAS_POST_PROCESS
    if (state.post_process_tasks.size() < engine.frame_tasks.size()) {
        state.post_process_tasks.resize(engine.frame_tasks.size());
    }
    // Each post-process task keeps one entry per pass it records, sized here
    // rather than grown from the record path: a composite's chain is known
    // before a frame starts and its entries own vectors worth not moving.
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& task = engine.frame_tasks[index];
        // A screen-space task's history copy and composite are ordinary
        // passes in the same list, recorded by the same pass path.
        if (task.kind != FrameTaskKind::post_process && task.kind != FrameTaskKind::screen_space) {
            continue;
        }
        if (state.post_process_tasks[index].size() < task.post_process.passes.size()) {
            state.post_process_tasks[index].resize(task.post_process.passes.size());
        }
    }
#endif
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& record = engine.frame_tasks[index];
        if (record.kind != FrameTaskKind::geometry)
            continue;
        GpuGeometryTask& task = state.geometry_tasks[index];
        record_pinned_velocity(task.velocity);
        task.depth_borrowed = geometry_depth_is_borrowed(engine, index);
        const SDL_GPUSampleCount samples = task_sample_count(state, record.geometry.samples);
        task.colors.reserve(record.geometry.attachments.size());
        task.sampled_colors.reserve(record.geometry.attachments.size());
        for (const GeometryTextureDescription& description : record.geometry.attachments) {
            const SDL_GPUTextureFormat format = geometry_texture_format(description);
            SDL_GPUTexture* color = create_frame_texture(
                state.device, format, samples, width, height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    (samples == SDL_GPU_SAMPLECOUNT_1 ? SDL_GPU_TEXTUREUSAGE_SAMPLER : 0));
            task.colors.push_back(color);
            task.sampled_colors.push_back(
                samples == SDL_GPU_SAMPLECOUNT_1
                    ? color
                    : create_frame_texture(
                          state.device, format, SDL_GPU_SAMPLECOUNT_1, width, height,
                          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER));
        }
        task.depth = create_frame_texture(state.device, state.depth_format, samples, width, height,
                                          SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET);
    }
    state.frame_graph_width = width;
    state.render_targets_version = engine.render_targets_version;
    state.frame_graph_height = height;
}

void save_geometry_id_buffer_png(GpuState& state, std::uint32_t width, std::uint32_t height,
                                 const std::array<float, 16>& view_projection,
                                 std::span<const upstream::RenderItem> render_plan,
                                 const Scene& scene, const Engine& engine, const std::string& path,
                                 bool cluster_ids) {
    SDL_GPUTextureCreateInfo color_info{};
    color_info.type = SDL_GPU_TEXTURETYPE_2D;
    color_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    color_info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    color_info.width = width;
    color_info.height = height;
    color_info.layer_count_or_depth = 1;
    color_info.num_levels = 1;
    color_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture color_owner{SDL_CreateGPUTexture(state.device, &color_info), {state.device}};
    auto* color = color_owner.get();
    if (!color)
        gpu_error("SDL_CreateGPUTexture ID buffer");

    SDL_GPUTextureCreateInfo depth_info{};
    depth_info.type = SDL_GPU_TEXTURETYPE_2D;
    depth_info.format = state.depth_format;
    depth_info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    depth_info.width = width;
    depth_info.height = height;
    depth_info.layer_count_or_depth = 1;
    depth_info.num_levels = 1;
    depth_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    OwnedSdlTexture depth_owner{SDL_CreateGPUTexture(state.device, &depth_info), {state.device}};
    auto* depth = depth_owner.get();
    if (!depth) {
        color_owner.reset();
        gpu_error("SDL_CreateGPUTexture ID depth");
    }

    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(state.device)};
    if (!command) {
        depth_owner.reset();
        color_owner.reset();
        gpu_error("SDL_AcquireGPUCommandBuffer ID buffer");
    }
    SdlGpuWriteDevice{}.write_vertex_uniform(command, 0, view_projection.data(),
                                             sizeof(view_projection));

    SDL_GPUColorTargetInfo target{};
    target.texture = color;
    target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    target.load_op = SDL_GPU_LOADOP_CLEAR;
    target.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPUDepthStencilTargetInfo depth_target{};
    depth_target.texture = depth;
    depth_target.clear_depth = upstream::pinned_depth_clear;
    depth_target.load_op = SDL_GPU_LOADOP_CLEAR;
    depth_target.store_op = SDL_GPU_STOREOP_DONT_CARE;
    depth_target.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    depth_target.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
    SdlRenderPass pass{SDL_BeginGPURenderPass(command, &target, 1, &depth_target)};
    for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
        SDL_BindGPUGraphicsPipeline(
            pass,
            cluster_ids
                ? (sided_mode == 0 ? state.cluster_pipeline : state.cluster_double_sided_pipeline)
                : (sided_mode == 0 ? state.id_pipeline : state.id_double_sided_pipeline));
        std::uint32_t cluster_id_base = 1;
        for (std::size_t mesh_index = 0;
             mesh_index < state.meshes.size() && mesh_index < render_plan.size(); ++mesh_index) {
            const GpuMesh& mesh = state.meshes[mesh_index];
            const ClusterRange cluster = advance_cluster_range(mesh.index_count, cluster_id_base);
            const std::uint32_t current_cluster_base = cluster.id_start;
            const upstream::RenderItem& item = render_plan[mesh_index];
            const MaterialRecord* material = handle_find(engine.materials, item.material);
            const bool double_sided = item.cull_mode == upstream::RenderCullMode::none;
            if (double_sided != (sided_mode == 1))
                continue;

            const std::array<float, 4> alpha_options = diagnostic_alpha_options(item, material);
            if (cluster_ids) {
                const DiagnosticClusterUniforms uniforms =
                    diagnostic_cluster_uniforms(current_cluster_base, alpha_options);
                SdlGpuWriteDevice{}.write_fragment_uniform(command, 0, &uniforms, sizeof(uniforms));
            } else {
                const DiagnosticIdUniforms uniforms = diagnostic_id_uniforms(
                    static_cast<std::uint32_t>(mesh_index + 1), alpha_options);
                SdlGpuWriteDevice{}.write_fragment_uniform(command, 0, &uniforms, sizeof(uniforms));
            }

            push_mesh_stage_blocks(command, scene, engine, handle_at(engine.meshes, item.mesh));
            const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
            const SDL_GPUTextureSamplerBinding texture_binding{
                mesh.base_color,
                state.sampler,
            };
            bind_mesh_vertex_buffers(pass, mesh);
            SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
            SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
            encode_sdl_gpu_indexed_draw(pass, mesh.index_count,
                                        mesh.indirect_args ? 0u : mesh.instance_count(),
                                        mesh.indirect_args);
        }
    }
    pass.end();
    save_texture_png(state.device, command, color, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, width,
                     height, path);
    depth_owner.reset();
    color_owner.reset();
}
#endif

#if BBLITE_RENDER_TASK_TRANSMISSION
namespace {
/** One fullscreen triangle of a pinned module into a single-sample target. */
SDL_GPUGraphicsPipeline* task_grab_pipeline(GpuState& state, const std::string& stem,
                                            SDL_GPUTextureFormat format, const char* label) {
    const PinnedStage vertex =
        load_pinned_stage(state.device, stem + ".vert", SDL_GPU_SHADERSTAGE_VERTEX);
    const PinnedStage fragment =
        load_pinned_stage(state.device, stem + ".frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    SDL_GPUColorTargetDescription target{};
    target.format = format;
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.fragment_shader = fragment.shader.get();
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    SDL_GPUGraphicsPipeline* pipeline =
        create_sdl_gpu_graphics_pipeline(state.device, vertex.shader, &info);
    if (!pipeline)
        gpu_error(label);
    return pipeline;
}

SDL_GPUSampler* task_grab_sampler(GpuState& state, bool depth) {
    SDL_GPUSampler*& sampler = depth ? state.task_depth_grab_sampler : state.task_grab_sampler;
    if (sampler)
        return sampler;
    SDL_GPUSamplerCreateInfo info{};
    if (depth) {
        // transmission-depth-grab.ts: nearest, clamped.
        info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    } else {
        // getTrilinearAnisotropicSampler, as the scene grab's.
        info.min_filter = SDL_GPU_FILTER_LINEAR;
        info.mag_filter = SDL_GPU_FILTER_LINEAR;
        info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
        info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        info.max_lod = 1000.0f;
        info.enable_anisotropy = true;
        info.max_anisotropy = static_cast<float>(transmission_sampler_max_anisotropy);
    }
    sampler = SDL_CreateGPUSampler(state.device, &info);
    if (!sampler)
        gpu_error("SDL_CreateGPUSampler render-task transmission");
    return sampler;
}

/** A fullscreen pass of the pipeline into the target's top level, reading the source. */
void encode_task_grab_pass(SDL_GPUCommandBuffer* command, SDL_GPUGraphicsPipeline* pipeline,
                           SDL_GPUTexture* target, SDL_GPUTextureSamplerBinding source) {
    SDL_GPUColorTargetInfo color{};
    color.texture = target;
    color.mip_level = 0;
    color.load_op = SDL_GPU_LOADOP_CLEAR;
    color.store_op = SDL_GPU_STOREOP_STORE;
    SdlRenderPass pass{SDL_BeginGPURenderPass(command, &color, 1, nullptr)};
    SDL_BindGPUGraphicsPipeline(pass, pipeline);
    SDL_BindGPUFragmentSamplers(pass, 0, &source, 1);
    count_gpu_draw(SDL_DrawGPUPrimitives, pass, 3, 1, 0, 0);
}
} // namespace

GpuState::TaskTransmission& prepare_task_transmission(GpuState& state, const Engine& engine,
                                                      TaskHandle task) {
    const FrameTaskRecord& record = handle_at(engine.frame_tasks, task);
    if (!record.transmission)
        throw std::runtime_error("A transmission texture names a task without transmission.");
    const RenderTaskTransmission& settings = *record.transmission;
    if (record.render.target.value >= state.render_targets.size())
        pal::refuse_invalid_frame_handle("A render-task transmission names no render target.");
    const RenderTargetRecord& target_record =
        handle_at(engine.render_targets, record.render.target);
    const GpuRenderTarget& target = handle_at(state.render_targets, record.render.target);
    task_transmission(record, target_sample_count(state, target_record) != SDL_GPU_SAMPLECOUNT_1,
                      target_record.swapchain);
    if (state.task_transmissions.size() <= task.value)
        state.task_transmissions.resize(task.value + 1);
    GpuState::TaskTransmission& grab = state.task_transmissions[task.value];
    // createRenderTaskTransmission: a fixed square rgba16float, with the
    // chain transmissionMipLevelCount allows.
    const std::uint32_t mips = task_transmission_mip_count(settings);
    if (!grab.color || grab.mip_count != mips) {
        if (grab.color)
            SDL_ReleaseGPUTexture(state.device, grab.color);
        SDL_GPUTextureCreateInfo info{};
        info.type = SDL_GPU_TEXTURETYPE_2D;
        info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
        info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
        info.width = settings.grab_size;
        info.height = settings.grab_size;
        info.layer_count_or_depth = 1;
        info.num_levels = mips;
        info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        grab.color = SDL_CreateGPUTexture(state.device, &info);
        if (!grab.color)
            gpu_error("SDL_CreateGPUTexture render-task transmission");
        grab.mip_count = mips;
    }
    // transmission-depth-grab.ts: the target's own extent, r32float.
    const bool depth = settings.grab_depth.value_or(false) && target_record.has_depth &&
                       target.depth && target.width > 0 && target.height > 0;
    if (!depth || grab.depth_width != target.width || grab.depth_height != target.height) {
        if (grab.depth)
            SDL_ReleaseGPUTexture(state.device, grab.depth);
        grab.depth = depth ? create_frame_texture(
                                 state.device, SDL_GPU_TEXTUREFORMAT_R32_FLOAT,
                                 SDL_GPU_SAMPLECOUNT_1, target.width, target.height,
                                 SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER)
                           : nullptr;
        if (depth && !grab.depth)
            gpu_error("SDL_CreateGPUTexture render-task depth grab");
        grab.depth_width = depth ? target.width : 0;
        grab.depth_height = depth ? target.height : 0;
    }
    return grab;
}

void encode_task_transmission_grab(GpuState& state, const Engine& engine,
                                   SDL_GPUCommandBuffer* command, TaskHandle task) {
    GpuState::TaskTransmission& grab = prepare_task_transmission(state, engine, task);
    const FrameTaskRecord& record = handle_at(engine.frame_tasks, task);
    const GpuRenderTarget& target = handle_at(state.render_targets, record.render.target);
    if (!target.color)
        pal::fail_render_target_has_no_texture();
    if (!state.task_grab_pipeline)
        state.task_grab_pipeline = task_grab_pipeline(
            state, "transmission-grab-single", SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
            "SDL_CreateGPUGraphicsPipeline render-task transmission grab");
    // blitToTransmission through the bilinear sampler the pin binds.
    encode_task_grab_pass(command, state.task_grab_pipeline, grab.color,
                          {target.color, state.ground_sampler});
    generate_texture_mipmaps(state.device, command, grab.color, record.transmission->grab_size,
                             record.transmission->grab_size, grab.mip_count);
    if (grab.depth) {
        if (!state.task_depth_grab_pipeline)
            state.task_depth_grab_pipeline = task_grab_pipeline(
                state, "transmission-depth-grab-single", SDL_GPU_TEXTUREFORMAT_R32_FLOAT,
                "SDL_CreateGPUGraphicsPipeline render-task depth grab");
        encode_task_grab_pass(command, state.task_depth_grab_pipeline, grab.depth,
                              {target.depth, task_grab_sampler(state, true)});
    }
}

SDL_GPUTextureSamplerBinding task_transmission_binding(GpuState& state, const Engine& engine,
                                                       const RenderTextureRef& reference) {
    const GpuState::TaskTransmission& grab =
        prepare_task_transmission(state, engine, reference.task);
    if (reference.source == RenderTextureSource::transmission_depth) {
        if (!grab.depth)
            pal::fail_render_target_has_no_texture();
        return {grab.depth, task_grab_sampler(state, true)};
    }
    return {grab.color, task_grab_sampler(state, false)};
}

void release_task_transmissions(GpuState& state) {
    for (GpuState::TaskTransmission& grab : state.task_transmissions) {
        if (grab.color)
            SDL_ReleaseGPUTexture(state.device, grab.color);
        if (grab.depth)
            SDL_ReleaseGPUTexture(state.device, grab.depth);
    }
    state.task_transmissions.clear();
    for (SDL_GPUGraphicsPipeline* pipeline :
         {state.task_grab_pipeline, state.task_depth_grab_pipeline})
        if (pipeline)
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
    for (SDL_GPUSampler* sampler : {state.task_grab_sampler, state.task_depth_grab_sampler})
        if (sampler)
            SDL_ReleaseGPUSampler(state.device, sampler);
    state.task_grab_pipeline = nullptr;
    state.task_depth_grab_pipeline = nullptr;
    state.task_grab_sampler = nullptr;
    state.task_depth_grab_sampler = nullptr;
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal
