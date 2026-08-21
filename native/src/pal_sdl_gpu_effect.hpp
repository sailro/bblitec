#pragma once

// The fullscreen-effect pass on SDL_GPU.
//
// An `EffectRenderer` is a rendering CONTEXT on the engine, not a renderer of
// its own — the same shape a `SpriteRenderer` has, and for the same reason:
// upstream's frame loop walks `engine._renderingContexts` and each one records
// into the frame the loop owns. So this header holds only the context's two
// half, and the window, the device and the loop stay with whoever drives the
// frame:
//
//   `record_effect_pass` — `_record`: bind and draw three vertices into a
//                          render pass the caller already opened, so the caller
//                          decides the target and whether it clears.
//
// There is no `_update` half on this backend. SDL_GPU pushes uniform data on
// the command buffer rather than into a buffer of its own, so the write has to
// happen inside the record; Dawn owns a buffer and therefore has the pin's
// second half for real.
//
// The frame-graph task draws through the same pair, which is what keeps the
// two entry points upstream ships from being two implementations here.
//
// SDL_GPU only; Dawn owns the same two halves in `pal_dawn_effect.hpp`.

#include <bblite/runtime.hpp>
#include <bblite/upstream/effect_variants.hpp>

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include "pal_gpu_shared.hpp"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

/** One `EffectWrapper` as GPU state, for one target signature. */
struct EffectPass {
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    /** The 1x1 texels `setEffectTexture` stored, in declared binding order. */
    std::vector<SDL_GPUTextureSamplerBinding> textures;
    /**
     * Whether the compiled fragment kept a uniform block at all — the
     * sidecar's answer, not the WGSL's: a block the caller's body never reads
     * does not survive Tint. It is the only block a stage can declare, so
     * surviving means slot zero.
     */
    bool has_uniform_block = false;
};

/**
 * The 1x1 texture `createSolidTexture2D` built: the texel the record already
 * carries, in an `rgba8unorm` with no mip chain and no sRGB view, paired with
 * the bilinear sampler (`getBilinearSampler`: linear min and mag), which for
 * a single texel is every sampler. Nothing here rounds -- the pin's own
 * rounding happened once, in the lowered `create_solid_texture`.
 */
inline SDL_GPUTextureSamplerBinding upload_solid_texture(
    SDL_GPUDevice* device,
    const SolidTexture& texture) {
    return SDL_GPUTextureSamplerBinding{
        upload_2d_texture(
            device,
            texture.texel.data(),
            texture.texel.size(),
            1,
            1,
            SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
            "SDL_CreateGPUTexture effect solid"),
        create_texture_sampler(device, TextureSamplerState{})};
}

/**
 * Build the pass for one wrapper against one target signature.
 *
 * The pin caches a pipeline per `targetSignatureKey`, so the format and the
 * sample count belong to the pipeline rather than to the wrapper; a caller
 * that draws one effect into two targets builds two passes.
 */
inline EffectPass create_effect_pass(
    SDL_GPUDevice* device,
    const Engine& engine,
    EffectWrapperHandle handle,
    SDL_GPUTextureFormat format,
    std::uint32_t samples) {
    const EffectWrapperRecord& wrapper =
        engine.effect_wrappers.at(handle.value);
    const upstream::EffectVariantEntry& entry =
        upstream::effect_variants.at(wrapper.variant);
    EffectPass pass;
    // What the compiled stage kept, from the sidecar the shader step wrote
    // beside it -- the same authority the composed material families bind
    // through. Counting the descriptor's own rows instead would over-count a
    // binding the caller's body never samples, and SDL_GPU takes both
    // samplers and uniform buffers by dense slot.
    const PinnedStageSlots slots =
        read_pinned_stage_slots(std::string(entry.fragment_stem));
    const std::uint32_t sampler_count =
        static_cast<std::uint32_t>(slots.textures.size());
    const std::uint32_t uniform_count =
        static_cast<std::uint32_t>(slots.uniforms.size());
    pass.has_uniform_block = !slots.uniforms.empty();

    // The vertex stage is the pin's own fullscreen triangle: no vertex
    // buffers, no samplers, no uniforms.
    SDL_GPUShader* vertex = load_shader(
        device,
        std::string(entry.vertex_stem).c_str(),
        SDL_GPU_SHADERSTAGE_VERTEX,
        0,
        0);
    SDL_GPUShader* fragment = load_shader(
        device,
        std::string(entry.fragment_stem).c_str(),
        SDL_GPU_SHADERSTAGE_FRAGMENT,
        sampler_count,
        uniform_count);

    SDL_GPUColorTargetDescription color{};
    color.format = format;
    // `blend: options.blend` — the reached slice declares none, and a
    // descriptor that does refuses at generation.
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex;
    info.fragment_shader = fragment;
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.multisample_state.sample_count = samples > 1
        ? SDL_GPU_SAMPLECOUNT_4
        : SDL_GPU_SAMPLECOUNT_1;
    info.target_info.num_color_targets = 1;
    info.target_info.color_target_descriptions = &color;
    info.target_info.has_depth_stencil_target = false;
    pass.pipeline = SDL_CreateGPUGraphicsPipeline(device, &info);
    SDL_ReleaseGPUShader(device, vertex);
    SDL_ReleaseGPUShader(device, fragment);
    if (!pass.pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline effect");

    // The textures the caller set, in the order the sidecar kept them: the
    // fragment names each binding, and a texture the body never samples does
    // not survive to the compiled stage.
    for (const std::string& name : slots.textures) {
        const EffectTextureSlot* slot = nullptr;
        for (const EffectTextureSlot& candidate : wrapper.textures) {
            if (candidate.name != name) continue;
            slot = &candidate;
            break;
        }
        if (!slot || !slot->set) {
            throw std::runtime_error(
                "Effect texture binding '" + name +
                "' was not set before the first render.");
        }
        pass.textures.push_back(
            upload_solid_texture(device, slot->texture));
    }
    return pass;
}

inline void release_effect_pass(SDL_GPUDevice* device, EffectPass& pass) {
    release_sprite_fragment_textures(device, pass.textures);
    if (pass.pipeline) SDL_ReleaseGPUGraphicsPipeline(device, pass.pipeline);
    pass.pipeline = nullptr;
}

/** `_record`: the pin's own three-vertex draw, into an already-open pass. */
inline void record_effect_pass(
    SDL_GPUCommandBuffer* command,
    SDL_GPURenderPass* render_pass,
    const Engine& engine,
    const EffectPass& pass,
    EffectWrapperHandle handle) {
    SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline);
    const EffectWrapperRecord& wrapper =
        engine.effect_wrappers.at(handle.value);
    if (pass.has_uniform_block && !wrapper.uniform_values.empty()) {
        push_stage_uniform(
            command,
            0,
            wrapper.uniform_values.data(),
            wrapper.uniform_values.size() * sizeof(float));
    }
    if (!pass.textures.empty()) {
        SDL_BindGPUFragmentSamplers(
            render_pass,
            0,
            pass.textures.data(),
            static_cast<Uint32>(pass.textures.size()));
    }
    SDL_DrawGPUPrimitives(render_pass, 3, 1, 0, 0);
}

} // namespace bbl::pal
