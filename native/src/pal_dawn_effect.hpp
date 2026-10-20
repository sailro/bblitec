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

#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <utility>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_dawn_shared.hpp"
#include "pal_gpu_targets.hpp"
#include "pal_effect_pixels.hpp"

namespace bbl::pal {

/** Upload factory pixels or the already-rounded texel of a solid texture. */
inline DawnTexture upload_dawn_effect_image(WGPUDevice device, WGPUQueue queue,
                                            const EffectTextureSlot& slot) {
    if (slot.pixels_texture) {
        const auto& texture = *slot.pixels_texture;
        return DawnTexture{upload_dawn_rgba_texture(device, queue, texture.rgba.data(),
                                                    texture.rgba.size(), texture.width,
                                                    texture.height, 1, texture.srgb)};
    }
    return DawnTexture{upload_dawn_rgba_texture(device, queue, slot.texture.texel.data(),
                                                slot.texture.texel.size(), 1, 1)};
}

/** One `EffectWrapper` as GPU state, for one target signature. */
struct DawnEffectPass {
    DawnRenderPipeline pipeline;
    DawnBindGroupLayout group_layout;
    DawnPipelineLayout pipeline_layout;
    DawnBindGroup group;
    DawnBuffer uniforms;
    std::uint32_t uniform_bytes = 0;
    std::vector<DawnSampledTexture> textures;
    EffectTextureImages<DawnTexture> texture_images;
    /** Bind-group entries a render target fills at record time: entry index, binding number. */
    std::vector<std::pair<std::size_t, std::uint32_t>> render_textures;
    /** The entries the group was last built from, kept to rebuild it on a new view. */
    std::vector<WGPUBindGroupEntry> group_entries;
};

inline void release_dawn_effect_pass(DawnEffectPass& pass) {
    release_dawn_extra_textures(pass.textures);
    pass.texture_images = {};
    pass.group.reset();
    pass.uniforms.reset();
    pass.pipeline.reset();
    pass.pipeline_layout.reset();
    pass.group_layout.reset();
}

/**
 * Build the pass for one wrapper against one target signature.
 *
 * The pin caches a pipeline per `targetSignatureKey`, so the format and the
 * sample count belong to the pipeline rather than to the wrapper.
 */
inline DawnEffectPass create_dawn_effect_pass(DawnDevice& device_state, const Engine& engine,
                                              EffectWrapperHandle handle, WGPUTextureFormat format,
                                              std::uint32_t samples) {
    const EffectWrapperRecord& wrapper = handle_at(engine.effect_wrappers, handle);
    const upstream::EffectVariantEntry& entry = upstream::effect_variants.at(wrapper.variant);
    DawnEffectPass pass;

    // The descriptor's own layout, entry for entry: `bindingLayoutEntry`
    // gives a uniform `{ type: "uniform" }`, a texture float or depth/2d, and a
    // sampler `filtering`, all at fragment visibility unless the descriptor
    // named another — and the reached slice names none.
    // The textures first, in their declared order: a sampler can precede the
    // texture it samples in binding order. The lookup and its not-set refusal
    // are the shared `effect_texture_slot`; a render target's view is bound
    // when the pass records, since a rebuilt target replaces it.
    std::vector<std::uint32_t> render_bindings;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::EffectVariantBinding& binding =
            upstream::effect_variant_bindings.at(entry.first_binding + index);
        if (binding.kind != upstream::EffectBindingKind::texture)
            continue;
        const EffectTextureSlot& slot = effect_texture_slot(wrapper, binding.binding);
        const auto image = pass.texture_images.add(
            slot, pass.textures.size(), [&](const EffectTextureSlot& current) {
                return upload_dawn_effect_image(device_state.device, device_state.queue, current);
            });
        DawnSampledTexture sampled;
        if (image) {
            sampled.texture = image->retain();
            sampled.view = create_dawn_texture_view(sampled.texture, nullptr);
        }
        sampled.sampler = create_texture_sampler(device_state.device,
                                                 slot.pixels_texture ? slot.pixels_texture->sampler
                                                                     : effect_texture_sampler());
        pass.textures.push_back(std::move(sampled));
        if (slot.render_texture)
            render_bindings.push_back(binding.binding);
    }
    std::vector<WGPUBindGroupLayoutEntry> layout_entries;
    std::vector<WGPUBindGroupEntry> group_entries;
    std::size_t texture_position = 0;
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
            descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
            descriptor.size = binding.uniform_bytes;
            pass.uniforms = require_dawn_resource(
                wgpuDeviceCreateBuffer(device_state.device, &descriptor), "effect uniform buffer");
            WGPUBindGroupEntry group = WGPU_BIND_GROUP_ENTRY_INIT;
            group.binding = binding.binding;
            group.buffer = pass.uniforms;
            group.size = binding.uniform_bytes;
            group_entries.push_back(group);
        } else if (binding.kind == upstream::EffectBindingKind::texture) {
            layout.texture.sampleType =
                binding.depth_texture ? WGPUTextureSampleType_Depth : WGPUTextureSampleType_Float;
            layout.texture.viewDimension = WGPUTextureViewDimension_2D;
            if (std::find(render_bindings.begin(), render_bindings.end(), binding.binding) !=
                render_bindings.end())
                pass.render_textures.emplace_back(group_entries.size(), binding.binding);
            const DawnSampledTexture& sampled = pass.textures.at(texture_position++);
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
                throw std::runtime_error("Effect sampler binding names a texture the wrapper "
                                         "does not carry.");
            }
            WGPUBindGroupEntry group = WGPU_BIND_GROUP_ENTRY_INIT;
            group.binding = binding.binding;
            group.sampler = pass.textures[binding.texture].sampler;
            group_entries.push_back(group);
        }
        layout_entries.push_back(layout);
    }

    WGPUBindGroupLayoutDescriptor layout_descriptor = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    layout_descriptor.entryCount = layout_entries.size();
    layout_descriptor.entries = layout_entries.data();
    pass.group_layout = require_dawn_resource(
        wgpuDeviceCreateBindGroupLayout(device_state.device, &layout_descriptor),
        "effect bind group layout");
    WGPUPipelineLayoutDescriptor pipeline_layout = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    pipeline_layout.bindGroupLayoutCount = 1;
    const auto group_layout = pass.group_layout.get();
    pipeline_layout.bindGroupLayouts = &group_layout;
    pass.pipeline_layout =
        require_dawn_resource(wgpuDeviceCreatePipelineLayout(device_state.device, &pipeline_layout),
                              "effect pipeline layout");
    pass.group_entries = group_entries;
    if (!group_entries.empty() && pass.render_textures.empty()) {
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = pass.group_layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        pass.group = require_dawn_resource(
            wgpuDeviceCreateBindGroup(device_state.device, &group_descriptor), "effect bind group");
    }

    // Both entry points live in one module, deployed once under the
    // fragment stem (the vertex stem declares only compiled artifacts), so
    // the fragment file is the module.
    DawnShaderModule module{
        load_wgsl_module(device_state.device, std::string(entry.fragment_stem))};
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = string_view("effectFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = pass.pipeline_layout;
    descriptor.vertex.module = module;
    descriptor.vertex.entryPoint = string_view("effectFullscreenVertex");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = samples;
    descriptor.multisample.mask = ~0u;
    descriptor.fragment = &fragment;
    pass.pipeline = wgpuDeviceCreateRenderPipeline(device_state.device, &descriptor);
    if (!pass.pipeline)
        dawn_error("effect pipeline creation failed.");
    return pass;
}

/** Refresh texture bindings, upload pixel writes and update dirty uniforms. */
inline void upload_dawn_effect_pass(DawnDevice& device, Engine& engine, DawnEffectPass& pass,
                                    EffectWrapperHandle handle) {
    EffectWrapperRecord& wrapper = handle_at(engine.effect_wrappers, handle);
    pass.texture_images.refresh(
        wrapper,
        [&](const EffectTextureSlot& slot) {
            return upload_dawn_effect_image(device.device, device.queue, slot);
        },
        [&](std::size_t position, const EffectTextureSlot& slot,
            const std::shared_ptr<DawnTexture>& image) {
            auto& sampled = pass.textures.at(position);
            sampled.texture = image ? image->retain() : DawnTexture{};
            sampled.view =
                image ? create_dawn_texture_view(sampled.texture, nullptr) : DawnTextureView{};
            sampled.sampler = create_texture_sampler(
                device.device,
                slot.pixels_texture ? slot.pixels_texture->sampler : effect_texture_sampler());
            const auto& variant = upstream::effect_variants.at(wrapper.variant);
            std::size_t texture_position = 0;
            for (std::size_t index = 0; index < variant.binding_count; ++index) {
                const auto& binding =
                    upstream::effect_variant_bindings.at(variant.first_binding + index);
                auto& entry = pass.group_entries.at(index);
                if (binding.kind == upstream::EffectBindingKind::texture) {
                    if (texture_position++ == position) {
                        entry.textureView = sampled.view;
                        std::erase_if(pass.render_textures,
                                      [&](const auto& row) { return row.first == index; });
                        if (slot.render_texture)
                            pass.render_textures.emplace_back(index, slot.binding);
                    }
                } else if (binding.kind == upstream::EffectBindingKind::sampler &&
                           binding.texture == position) {
                    entry.sampler = sampled.sampler;
                }
            }
            pass.group.reset();
        });
    pass.texture_images.upload_writes(
        [&](DawnTexture& image, std::span<const std::uint8_t> texels, PixelsTexels::Region region) {
            WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = image.get();
            destination.origin = {region.x, region.y, 0};
            WGPUTexelCopyBufferLayout layout{};
            layout.bytesPerRow = region.width * 4u;
            layout.rowsPerImage = region.height;
            const WGPUExtent3D size{region.width, region.height, 1};
            DawnGpuDevice{device.queue}.write_texture(&destination, texels.data(), texels.size(),
                                                      &layout, &size);
        });
    if (!pass.group && pass.render_textures.empty() && !pass.group_entries.empty()) {
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = pass.group_layout;
        descriptor.entryCount = pass.group_entries.size();
        descriptor.entries = pass.group_entries.data();
        pass.group = require_dawn_resource(wgpuDeviceCreateBindGroup(device.device, &descriptor),
                                           "effect bind group");
    }
    if (!pass.uniforms || pass.uniform_bytes == 0)
        return;
    if (!wrapper.uniforms_dirty || wrapper.uniform_values.empty())
        return;
    // The symmetric size validation (shared GPU helpers): a short write
    // leaves a stale tail behind the declared size.
    require_effect_uniform_size(wrapper, pass.uniform_bytes);
    DawnGpuDevice{device.queue}.write_buffer(pass.uniforms, 0, wrapper.uniform_values.data(),
                                             wrapper.uniform_values.size() * sizeof(float));
    wrapper.uniforms_dirty = false;
}

/** A frame graph's render-target view for an effect binding. */
using DawnEffectRenderTextureSource = std::function<WGPUTextureView(const RenderTextureRef&)>;

/** Bind each render target's current view, rebuilding the group when one changed. */
inline void bind_dawn_effect_render_textures(WGPUDevice device, const Engine& engine,
                                             DawnEffectPass& pass, EffectWrapperHandle handle,
                                             const DawnEffectRenderTextureSource& source) {
    if (pass.render_textures.empty())
        return;
    if (!source)
        throw std::runtime_error(
            "An effect renderer samples render-target textures only in a frame graph.");
    const EffectWrapperRecord& wrapper = handle_at(engine.effect_wrappers, handle);
    bool changed = !pass.group;
    for (const auto& [entry, binding] : pass.render_textures) {
        const EffectTextureSlot& slot = effect_texture_slot(wrapper, binding);
        if (!slot.render_texture)
            throw std::runtime_error(
                "An effect binding changed texture kind after its first draw.");
        const WGPUTextureView view = source(*slot.render_texture);
        changed = changed || pass.group_entries[entry].textureView != view;
        pass.group_entries[entry].textureView = view;
    }
    if (!changed)
        return;
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = pass.group_layout;
    descriptor.entryCount = pass.group_entries.size();
    descriptor.entries = pass.group_entries.data();
    pass.group =
        require_dawn_resource(wgpuDeviceCreateBindGroup(device, &descriptor), "effect bind group");
}

/** `_record`: the pin's own three-vertex draw, into an already-open pass. */
inline void record_dawn_effect_pass(WGPURenderPassEncoder render_pass, const DawnEffectPass& pass) {
    if (!pass.render_textures.empty() && !pass.group)
        throw std::runtime_error(
            "An effect renderer samples render-target textures only in a frame graph.");
    wgpuRenderPassEncoderSetPipeline(render_pass, pass.pipeline);
    if (pass.group) {
        wgpuRenderPassEncoderSetBindGroup(render_pass, 0, pass.group, 0, nullptr);
    }
    wgpuRenderPassEncoderDraw(render_pass, 3, 1, 0, 0);
}

} // namespace bbl::pal
