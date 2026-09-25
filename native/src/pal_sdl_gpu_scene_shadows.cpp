// SDL_GPU shadows: the ESM blur and the shadow generators' passes. Dawn's
// twin is pal_dawn_scene_shadows.cpp.
#include <bblite/features/has_pbr_renderer.hpp>

#include "pal_sdl_gpu_scene.hpp"

namespace bbl::pal {
inline namespace sdl_scene {

#if BBLITE_HAS_PBR_RENDERER && BBLITE_SHADOW_RECEIVERS && BBLITE_SHADOWS_ESM
GpuState::EsmBlur& ensure_esm_blur(GpuState& state, const ShadowGeneratorRecord& generator,
                                   SDL_GPUTexture* source) {
    const std::uint32_t esm_index = generator.esm_index;
    if (state.esm_blurs.size() <= esm_index) {
        state.esm_blurs.resize(esm_index + 1);
    }
    GpuState::EsmBlur& blur = state.esm_blurs[esm_index];
    if (blur.pipeline && blur.source == source)
        return blur;
    blur.clear(state.device);
    blur.source = source;
    // Written once: neither `bias` nor `depthScale` has a setter, which is
    // the same reason Dawn creates its own buffer once.
    blur.params = upstream::shadow_params_block(generator);
#if BBLITE_NODE_SHADOWS
    blur.params_buffer = upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                       blur.params.data(), blur.params.size() * sizeof(float));
#endif
    const upstream::EsmShadowResources& resources = upstream::esm_shadow_resources[esm_index];
    const upstream::EsmTextureDescriptor& half = resources.textures[2];
    const auto create_half = [&]() {
        return create_frame_texture(
            state.device, esm_texture_format(half.format), SDL_GPU_SAMPLECOUNT_1, half.width,
            half.height, SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER);
    };
    blur.blur_h = create_half();
    blur.blur_v = create_half();
    const std::string stem = "shadow-blur-" + std::to_string(esm_index);
    // The `.slots` sidecars are the only authority on which register each
    // block kept in the compiled stage, exactly as for a composed variant.
    auto vertex_shader =
        load_pinned_stage(state.device, stem + ".vert", SDL_GPU_SHADERSTAGE_VERTEX).shader;
    auto fragment_shader =
        load_pinned_stage(state.device, stem + ".frag", SDL_GPU_SHADERSTAGE_FRAGMENT).shader;
    SDL_GPUColorTargetDescription color_target{};
    // The one target `blurPipeline` declares, as the factory declared it.
    color_target.format = esm_texture_format(resources.blur_target_format);
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex_shader.get();
    info.fragment_shader = fragment_shader.get();
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    info.target_info.color_target_descriptions = &color_target;
    info.target_info.num_color_targets = 1;
    blur.pipeline = create_sdl_gpu_graphics_pipeline(state.device, &info);
    if (!blur.pipeline) {
        gpu_error("SDL_CreateGPUGraphicsPipeline ESM blur");
    }
    return blur;
}

void run_esm_blur(GpuState& state, SDL_GPUCommandBuffer* command, std::uint32_t esm_index) {
    const GpuState::EsmBlur& blur = state.esm_blurs[esm_index];
    const upstream::EsmShadowResources& resources = upstream::esm_shadow_resources[esm_index];
    const auto blur_pass = [&](SDL_GPUTexture* into, SDL_GPUTexture* read,
                               const std::array<float, 4>& direction) {
        SDL_GPUColorTargetInfo target{};
        target.texture = into;
        target.load_op = SDL_GPU_LOADOP_CLEAR;
        target.store_op = SDL_GPU_STOREOP_STORE;
        target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
        SdlRenderPass pass{SDL_BeginGPURenderPass(command, &target, 1, nullptr)};
        SDL_BindGPUGraphicsPipeline(pass, blur.pipeline);
        SDL_GPUTextureSamplerBinding binding{};
        binding.texture = read;
        binding.sampler = state.shadow_filtering_sampler;
        SDL_BindGPUFragmentSamplers(pass, 0, &binding, 1);
        // `BlurParams` is declared in both stages, so both are pushed.
        SDL_PushGPUVertexUniformData(command, 0, direction.data(),
                                     static_cast<Uint32>(direction.size() * sizeof(float)));
        SDL_PushGPUFragmentUniformData(command, 0, direction.data(),
                                       static_cast<Uint32>(direction.size() * sizeof(float)));
        count_gpu_draw(SDL_DrawGPUPrimitives, pass, 3, 1, 0, 0);
        pass.end();
    };
    blur_pass(blur.blur_h, blur.source, resources.blur_directions[0]);
    blur_pass(blur.blur_v, blur.blur_h, resources.blur_directions[1]);
}
#endif

#if BBLITE_HAS_PBR_RENDERER && BBLITE_SHADOW_RECEIVERS
void update_shadow_generators(GpuState& state, const Scene& scene, Engine& engine) {
    if (engine.shadow_generators.empty())
        return;
    for (std::size_t index = 0; index < state.shadow_generators.size(); ++index) {
        if (engine.shadow_generators[index].map_target.value != invalid_handle)
            continue;
        auto& retired = state.shadow_generators[index];
        if (retired.info)
            SDL_ReleaseGPUBuffer(state.device, retired.info);
        retired = {};
    }
#if BBLITE_SHADOWS_ESM
    for (std::uint32_t index = 0; index < state.esm_blurs.size(); ++index) {
        if (!esm_map_is_active(engine, index))
            state.esm_blurs[index].clear(state.device);
    }
#endif
    if (state.shadow_generators.size() < engine.shadow_generators.size()) {
        state.shadow_generators.resize(engine.shadow_generators.size());
    }
    state.shadow_light_slots.assign(scene.lights.size(), invalid_handle);
    for_each_shadow_generator(scene, engine,
                              [&](ShadowGeneratorHandle handle, LightHandle, std::size_t slot) {
                                  state.shadow_light_slots[slot] = handle.value;
                              });
    if (!state.shadow_comparison_sampler) {
        SDL_GPUSamplerCreateInfo info{};
        // The pinned PCF generator's own sampler: a comparison sampler under
        // `less`, with linear filtering so the hardware averages the four
        // comparisons each of the nine taps takes.
        info.enable_compare = true;
        info.compare_op = SDL_GPU_COMPAREOP_LESS;
        info.min_filter = SDL_GPU_FILTER_LINEAR;
        info.mag_filter = SDL_GPU_FILTER_LINEAR;
        info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.shadow_comparison_sampler = SDL_CreateGPUSampler(state.device, &info);
        if (!state.shadow_comparison_sampler) {
            gpu_error("SDL_CreateGPUSampler shadow comparison");
        }
    }
    if (!state.shadow_filtering_sampler) {
        // The pinned ESM generator reads its blurred map through
        // `getBilinearSampler`. Its two filters are what the factory asked
        // its device for; everything else it left at WebGPU's defaults,
        // which clamp and sample the base level.
        SDL_GPUSamplerCreateInfo info{};
#if BBLITE_SHADOWS_ESM
        const auto& blur_sampler = upstream::esm_shadow_resources[0].blur_sampler;
        info.min_filter = blur_sampler.minify == upstream::EsmFilter::linear
                              ? SDL_GPU_FILTER_LINEAR
                              : SDL_GPU_FILTER_NEAREST;
        info.mag_filter = blur_sampler.magnify == upstream::EsmFilter::linear
                              ? SDL_GPU_FILTER_LINEAR
                              : SDL_GPU_FILTER_NEAREST;
#else
        info.min_filter = SDL_GPU_FILTER_LINEAR;
        info.mag_filter = SDL_GPU_FILTER_LINEAR;
#endif
        info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.shadow_filtering_sampler = SDL_CreateGPUSampler(state.device, &info);
        if (!state.shadow_filtering_sampler) {
            gpu_error("SDL_CreateGPUSampler shadow filtering");
        }
    }
    pal::refresh_shadow_generators(
        scene, engine, state.shadow_refresh,
        [&](const ShadowGeneratorRecord& generator, ShadowGeneratorHandle handle, std::size_t,
            const upstream::ShadowReceiverBlock& block, bool moved) {
            GpuState::ShadowGenerator& gpu = handle_at(state.shadow_generators, handle);
            gpu.block = block;
            if (generator.map_target.value < state.render_targets.size()) {
                const GpuRenderTarget& target =
                    handle_at(state.render_targets, generator.map_target);
#if BBLITE_SHADOWS_ESM
                if (generator.filter == ShadowFilter::esm_directional) {
                    // `sg._depthTexture` is the SECOND blur half, never the
                    // depth buffer the caster pass wrote.
                    gpu.map = ensure_esm_blur(state, generator, target.color).blur_v;
                } else
#endif
                    gpu.map = target.depth;
            }
            if (!gpu.map) {
                gpu_error("a shadow generator has no rendered map.");
            }
            if (!gpu.info) {
                gpu.info = upload_buffer(state.device, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                         block.bytes.data(), block.size);
            } else if (moved) {
                // `update_buffer` costs a transfer buffer and a second
                // command submit, so it runs only when the block moved.
                update_buffer(state.device, gpu.info, block.bytes.data(), block.size);
            }
        });
}
#endif

} // namespace sdl_scene
} // namespace bbl::pal
