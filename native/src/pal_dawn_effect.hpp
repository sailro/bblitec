#pragma once

// The fullscreen-effect pass on Dawn (WebGPU).
//
// The mirror of `pal_sdl_gpu_effect.hpp` for this backend, and separate from
// it for the same reason the two renderers are: an `EffectRenderer` is a
// rendering CONTEXT on the engine, so the drawing has to be recordable into a
// frame somebody else owns — the swapchain driver's, or a scene's frame graph.
//
//   `upload_dawn_effect_pass` — `_update`: the uniform bytes the scene set.
//   `record_dawn_effect_pass` — `_record`: bind and draw three vertices into a
//                               render pass the caller opened.
//
// Dawn compiles the deployed `.native.wgsl` directly, so the bind group is the
// pin's own group 0 with the descriptor's own binding numbers — no compaction
// stands between the declared layout and the group, which is why this side
// walks the variant table where SDL_GPU walks the `.slots` sidecar.

#include <bblite/runtime.hpp>
#include <bblite/upstream/effect_variants.hpp>

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_dawn_shared.hpp"
#include "pal_gpu_shared.hpp"

namespace bbl::pal {

/**
 * The 1x1 texture `createSolidTexture2D` built: the texel the record already
 * carries, in an `rgba8unorm` with no mip chain and no sRGB view, paired with
 * the bilinear sampler (`getBilinearSampler`: linear min and mag), which for
 * a single texel is every sampler. Nothing here rounds -- the pin's own
 * rounding happened once, in the lowered `create_solid_texture`.
 */
inline DawnSampledTexture upload_dawn_solid_texture(
    WGPUDevice device,
    WGPUQueue queue,
    const SolidTexture& texture) {
    DawnSampledTexture sampled;
    sampled.texture = upload_dawn_rgba_texture(
        device,
        queue,
        texture.texel.data(),
        texture.texel.size(),
        1,
        1);
    sampled.view = wgpuTextureCreateView(sampled.texture, nullptr);
    sampled.sampler = create_texture_sampler(device, TextureSamplerState{});
    return sampled;
}

/** One `EffectWrapper` as GPU state, for one target signature. */
struct DawnEffectPass {
    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroupLayout group_layout = nullptr;
    WGPUPipelineLayout pipeline_layout = nullptr;
    WGPUBindGroup group = nullptr;
    WGPUBuffer uniforms = nullptr;
    std::uint32_t uniform_bytes = 0;
    std::vector<DawnSampledTexture> textures;
};

inline void release_dawn_effect_pass(DawnEffectPass& pass) {
    release_dawn_extra_textures(pass.textures);
    if (pass.group) wgpuBindGroupRelease(pass.group);
    if (pass.uniforms) wgpuBufferRelease(pass.uniforms);
    if (pass.pipeline) wgpuRenderPipelineRelease(pass.pipeline);
    if (pass.pipeline_layout) wgpuPipelineLayoutRelease(pass.pipeline_layout);
    if (pass.group_layout) wgpuBindGroupLayoutRelease(pass.group_layout);
    pass.group = nullptr;
    pass.uniforms = nullptr;
    pass.pipeline = nullptr;
    pass.pipeline_layout = nullptr;
    pass.group_layout = nullptr;
}

/**
 * Build the pass for one wrapper against one target signature.
 *
 * The pin caches a pipeline per `targetSignatureKey`, so the format and the
 * sample count belong to the pipeline rather than to the wrapper.
 */
inline DawnEffectPass create_dawn_effect_pass(
    DawnDevice& device_state,
    const Engine& engine,
    EffectWrapperHandle handle,
    WGPUTextureFormat format,
    std::uint32_t samples) {
    const EffectWrapperRecord& wrapper =
        engine.effect_wrappers.at(handle.value);
    const upstream::EffectVariantEntry& entry =
        upstream::effect_variants.at(wrapper.variant);
    DawnEffectPass pass;

    // The descriptor's own layout, entry for entry: `bindingLayoutEntry`
    // gives a uniform `{ type: "uniform" }`, a texture float/2d, and a
    // sampler `filtering`, all at fragment visibility unless the descriptor
    // named another — and the reached slice names none.
    std::vector<WGPUBindGroupLayoutEntry> layout_entries;
    std::vector<WGPUBindGroupEntry> group_entries;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::EffectVariantBinding& binding =
            upstream::effect_variant_bindings.at(entry.first_binding + index);
        WGPUBindGroupLayoutEntry layout = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        layout.binding = binding.binding;
        layout.visibility = WGPUShaderStage_Fragment;
        if (binding.kind == upstream::EffectBindingKind::uniform) {
            layout.buffer.type = WGPUBufferBindingType_Uniform;
            pass.uniform_bytes = binding.uniform_bytes;
            WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
            descriptor.usage =
                WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            descriptor.size = binding.uniform_bytes;
            pass.uniforms =
                wgpuDeviceCreateBuffer(device_state.device, &descriptor);
            WGPUBindGroupEntry group = WGPU_BIND_GROUP_ENTRY_INIT;
            group.binding = binding.binding;
            group.buffer = pass.uniforms;
            group.size = binding.uniform_bytes;
            group_entries.push_back(group);
        } else if (binding.kind == upstream::EffectBindingKind::texture) {
            layout.texture.sampleType = WGPUTextureSampleType_Float;
            layout.texture.viewDimension = WGPUTextureViewDimension_2D;
            const EffectTextureSlot* slot = nullptr;
            for (const EffectTextureSlot& candidate : wrapper.textures) {
                if (candidate.name != std::string(binding.name)) continue;
                slot = &candidate;
                break;
            }
            if (!slot || !slot->set) {
                throw std::runtime_error(
                    "Effect texture binding '" + std::string(binding.name) +
                    "' was not set before the first render.");
            }
            const DawnSampledTexture sampled = upload_dawn_solid_texture(
                device_state.device,
                device_state.queue,
                slot->texture);
            pass.textures.push_back(sampled);
            WGPUBindGroupEntry group = WGPU_BIND_GROUP_ENTRY_INIT;
            group.binding = binding.binding;
            group.textureView = sampled.view;
            group_entries.push_back(group);
        } else {
            layout.sampler.type = WGPUSamplerBindingType_Filtering;
            // Generation already performed the pin's own lookup and its
            // fallback, and published the result as a position in this
            // effect's texture rows -- so the sampler indexes what was
            // uploaded rather than rescanning for a binding number.
            if (binding.texture >= pass.textures.size()) {
                throw std::runtime_error(
                    "Effect sampler binding names a texture the wrapper "
                    "does not carry.");
            }
            WGPUBindGroupEntry group = WGPU_BIND_GROUP_ENTRY_INIT;
            group.binding = binding.binding;
            group.sampler = pass.textures[binding.texture].sampler;
            group_entries.push_back(group);
        }
        layout_entries.push_back(layout);
    }

    WGPUBindGroupLayoutDescriptor layout_descriptor =
        WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.entryCount = layout_entries.size();
    layout_descriptor.entries = layout_entries.data();
    pass.group_layout = wgpuDeviceCreateBindGroupLayout(
        device_state.device,
        &layout_descriptor);
    WGPUPipelineLayoutDescriptor pipeline_layout =
        WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    pipeline_layout.bindGroupLayouts = &pass.group_layout;
    pass.pipeline_layout = wgpuDeviceCreatePipelineLayout(
        device_state.device,
        &pipeline_layout);
    if (!group_entries.empty()) {
        WGPUBindGroupDescriptor group_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = pass.group_layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        pass.group =
            wgpuDeviceCreateBindGroup(device_state.device, &group_descriptor);
    }

    // Both entry points live in one module; the two deployed files carry the
    // same text, so either loads it.
    WGPUShaderModule module = load_wgsl_module(
        device_state.device,
        std::string(entry.fragment_stem));
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = string_view("effectFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pass.pipeline_layout;
    descriptor.vertex.module = module;
    descriptor.vertex.entryPoint = string_view("effectFullscreenVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    pass.pipeline =
        wgpuDeviceCreateRenderPipeline(device_state.device, &descriptor);
    wgpuShaderModuleRelease(module);
    if (!pass.pipeline) dawn_error("effect pipeline creation failed.");
    return pass;
}

/**
 * `_update`: the uniform bytes the scene set.
 *
 * Written only when they moved. The pin's own split between mutating a
 * parameter and uploading the block is what makes that safe -- and the
 * reached slice never mutates one, since the per-frame `update` callback is
 * not lowered, so this is one queue write at startup rather than one a frame.
 */
inline void upload_dawn_effect_pass(
    WGPUQueue queue,
    Engine& engine,
    const DawnEffectPass& pass,
    EffectWrapperHandle handle) {
    if (!pass.uniforms || pass.uniform_bytes == 0) return;
    EffectWrapperRecord& wrapper = engine.effect_wrappers.at(handle.value);
    if (!wrapper.uniforms_dirty || wrapper.uniform_values.empty()) return;
    wgpuQueueWriteBuffer(
        queue,
        pass.uniforms,
        0,
        wrapper.uniform_values.data(),
        wrapper.uniform_values.size() * sizeof(float));
    wrapper.uniforms_dirty = false;
}

/** `_record`: the pin's own three-vertex draw, into an already-open pass. */
inline void record_dawn_effect_pass(
    WGPURenderPassEncoder render_pass,
    const DawnEffectPass& pass) {
    wgpuRenderPassEncoderSetPipeline(render_pass, pass.pipeline);
    if (pass.group) {
        wgpuRenderPassEncoderSetBindGroup(
            render_pass,
            0,
            pass.group,
            0,
            nullptr);
    }
    wgpuRenderPassEncoderDraw(render_pass, 3, 1, 0, 0);
}

} // namespace bbl::pal
