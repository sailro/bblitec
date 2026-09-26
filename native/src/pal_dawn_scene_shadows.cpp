// Dawn shadows: the shadow samplers and groups, the ESM blur and the
// shadow generators' passes. SDL_GPU's twin is
// pal_sdl_gpu_scene_shadows.cpp.
#include "pal_gpu_common.hpp"
#include "pal_gpu_shadows.hpp"
#include <bblite/features/has_pbr_renderer.hpp>

#include "pal_dawn_scene.hpp"

namespace bbl::pal {
inline namespace dawn_scene {

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_SHADOWS_ESM
WGPUBuffer esm_caster_params_buffer(const DawnState& state, const MaterialRecord* material) {
    if (!material || !material->esm_shadow ||
        material->esm_shadow_generator.value >= state.shadow_params.size()) {
        return nullptr;
    }
    return handle_at(state.shadow_params, material->esm_shadow_generator);
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_SHADOW_RECEIVERS
void ensure_shadow_samplers(DawnState& state) {
    if (!state.shadow_comparison_sampler) {
        WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
        // The pinned PCF generator's own sampler: a comparison sampler under
        // `less`, with linear filtering so the hardware averages the four
        // comparisons each of the nine taps takes.
        descriptor.compare = WGPUCompareFunction_Less;
        descriptor.magFilter = WGPUFilterMode_Linear;
        descriptor.minFilter = WGPUFilterMode_Linear;
        state.shadow_comparison_sampler = wgpuDeviceCreateSampler(state.device, &descriptor);
        if (!state.shadow_comparison_sampler) {
            dawn_error("shadow comparison sampler creation failed.");
        }
    }
    if (!state.shadow_filtering_sampler) {
        // The pinned ESM generator reads its blurred map through
        // `getBilinearSampler`. Its two filters are what the factory asked
        // its device for; everything else it left at WebGPU's defaults,
        // which are Dawn's defaults too.
        WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
#if BBLITE_SHADOWS_ESM
        const auto& blur_sampler = upstream::esm_shadow_resources[0].blur_sampler;
        descriptor.magFilter = blur_sampler.magnify == upstream::EsmFilter::linear
                                   ? WGPUFilterMode_Linear
                                   : WGPUFilterMode_Nearest;
        descriptor.minFilter = blur_sampler.minify == upstream::EsmFilter::linear
                                   ? WGPUFilterMode_Linear
                                   : WGPUFilterMode_Nearest;
#endif
        state.shadow_filtering_sampler = wgpuDeviceCreateSampler(state.device, &descriptor);
        if (!state.shadow_filtering_sampler) {
            dawn_error("shadow filtering sampler creation failed.");
        }
    }
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_SHADOW_RECEIVERS && BBLITE_SHADOWS_ESM
DawnState::EsmBlur& ensure_esm_blur(DawnState& state, WGPUTextureView source,
                                    std::uint32_t esm_index) {
    if (state.esm_blurs.size() <= esm_index) {
        state.esm_blurs.resize(esm_index + 1);
    }
    DawnState::EsmBlur& blur = state.esm_blurs[esm_index];
    if (blur.pipeline && blur.source == source)
        return blur;
    blur.clear();
    blur.source = source;
    const upstream::EsmShadowResources& resources = upstream::esm_shadow_resources[esm_index];
    const upstream::EsmTextureDescriptor& half = resources.textures[2];
    const auto create_half = [&](WGPUTexture& texture, WGPUTextureView& view) {
        texture = create_frame_texture(
            state, esm_texture_format(half.format), 1, half.width, half.height,
            WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding);
        view = create_dawn_texture_view(texture, nullptr);
    };
    create_half(blur.blur_h, blur.blur_h_view);
    create_half(blur.blur_v, blur.blur_v_view);

    const std::string stem = "shadow-blur-" + std::to_string(esm_index);
    DawnShaderModule vertex_module{load_wgsl_module(state, stem + ".vert")};
    DawnShaderModule fragment_module{load_wgsl_module(state, stem + ".frag")};
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    // The one target `blurPipeline` declares, as the factory declared it.
    target.format = esm_texture_format(resources.blur_target_format);
    target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = fragment_module;
    fragment.entryPoint = {"main", WGPU_STRLEN};
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    // No explicit layout: the composed WGSL already declares the group, and
    // taking the pipeline's own is what every other pass here does.
    descriptor.vertex.module = vertex_module;
    descriptor.vertex.entryPoint = {"main", WGPU_STRLEN};
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.fragment = &fragment;
    blur.pipeline = wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!blur.pipeline)
        dawn_error("ESM blur pipeline creation failed.");
    blur.layout = wgpuRenderPipelineGetBindGroupLayout(blur.pipeline, 0);
    vertex_module.reset();
    fragment_module.reset();

    ensure_shadow_samplers(state);
    const auto bind = [&](WGPUBuffer& uniforms, WGPUBindGroup& group,
                          const std::array<float, 4>& direction, WGPUTextureView read) {
        uniforms = create_buffer(state, WGPUBufferUsage_Uniform, direction.data(),
                                 direction.size() * sizeof(float));
        std::array<WGPUBindGroupEntry, 3> group_entries{};
        for (WGPUBindGroupEntry& entry : group_entries) {
            entry = WGPU_BIND_GROUP_ENTRY_INIT;
        }
        group_entries[0].binding = 0;
        group_entries[0].buffer = uniforms;
        group_entries[0].size = direction.size() * sizeof(float);
        group_entries[1].binding = 1;
        group_entries[1].textureView = read;
        group_entries[2].binding = 2;
        group_entries[2].sampler = state.shadow_filtering_sampler;
        WGPUBindGroupDescriptor group_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        group_descriptor.layout = blur.layout;
        group_descriptor.entryCount = group_entries.size();
        group_descriptor.entries = group_entries.data();
        group = wgpuDeviceCreateBindGroup(state.device, &group_descriptor);
    };
    bind(blur.horizontal_uniforms, blur.horizontal, resources.blur_directions[0], source);
    bind(blur.vertical_uniforms, blur.vertical, resources.blur_directions[1], blur.blur_h_view);
    return blur;
}

void run_esm_blur(DawnState& state, WGPUCommandEncoder encoder, WGPUTextureView source,
                  std::uint32_t esm_index) {
    const DawnState::EsmBlur& blur = ensure_esm_blur(state, source, esm_index);
    const auto pass = [&](WGPUTextureView view, WGPUBindGroup group) {
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = view;
        attachment.loadOp = WGPULoadOp_Clear;
        attachment.storeOp = WGPUStoreOp_Store;
        attachment.clearValue = {0.0, 0.0, 0.0, 0.0};
        WGPURenderPassDescriptor descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        descriptor.colorAttachmentCount = 1;
        descriptor.colorAttachments = &attachment;
        DawnRenderPass render{wgpuCommandEncoderBeginRenderPass(encoder, &descriptor)};
        wgpuRenderPassEncoderSetPipeline(render, blur.pipeline);
        wgpuRenderPassEncoderSetBindGroup(render, 0, group, 0, nullptr);
        count_gpu_draw(wgpuRenderPassEncoderDraw, render, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(render);
        render.reset();
    };
    pass(blur.blur_h_view, blur.horizontal);
    pass(blur.blur_v_view, blur.vertical);
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_SHADOW_RECEIVERS
WGPUTextureView shadow_map_view(DawnState& state, const Engine& engine,
                                ShadowGeneratorHandle handle) {
    const ShadowGeneratorRecord& generator = handle_at(engine.shadow_generators, handle);
    if (generator.map_target.value >= state.render_targets.size()) {
        dawn_error("a shadow generator has no rendered map.");
    }
    const DawnRenderTarget& map = handle_at(state.render_targets, generator.map_target);
#if BBLITE_SHADOWS_ESM
    // The ESM receiver samples `sg._depthTexture`, which the pinned factory
    // set to the SECOND blur half -- not the depth buffer the caster pass
    // wrote.
    if (generator.filter == ShadowFilter::esm_directional) {
        const DawnState::EsmBlur& blur =
            ensure_esm_blur(state, map.sampled_color_view, generator.esm_index);
        return blur.blur_v_view;
    }
#endif
    return map.depth_sampled_view;
}

std::vector<ShadowGeneratorHandle> shadow_generators_in_light_order(const Scene& scene,
                                                                    const Engine& engine) {
    // One entry per scene light, so a row's light slot indexes it directly.
    // A light with no generator keeps the default invalid handle, which is
    // what the caller's bounds test reads.
    std::vector<ShadowGeneratorHandle> generators(scene.lights.size());
    pal::for_each_shadow_generator(scene, engine,
                                   [&](ShadowGeneratorHandle handle, LightHandle,
                                       std::size_t slot) { generators[slot] = handle; });
    return generators;
}

WGPUBindGroupLayoutEntry shadow_layout_entry(const upstream::PinnedShadowBinding& row) {
    WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
    entry.binding = row.binding;
    entry.visibility = 0;
    if (row.vertex)
        entry.visibility |= WGPUShaderStage_Vertex;
    if (row.fragment)
        entry.visibility |= WGPUShaderStage_Fragment;
    switch (row.kind) {
    case upstream::PinnedBindingKind::textureDepth2d:
        entry.texture.sampleType = WGPUTextureSampleType_Depth;
        entry.texture.viewDimension = WGPUTextureViewDimension_2D;
        break;
    case upstream::PinnedBindingKind::textureDepth2dArray:
        // `bglEntry` maps a `_textureType` containing "array" onto
        // `viewDimension: "2d-array"`; the sample type is still depth.
        entry.texture.sampleType = WGPUTextureSampleType_Depth;
        entry.texture.viewDimension = WGPUTextureViewDimension_2DArray;
        break;
    case upstream::PinnedBindingKind::texture2d:
        entry.texture.sampleType = WGPUTextureSampleType_Float;
        entry.texture.viewDimension = WGPUTextureViewDimension_2D;
        break;
    case upstream::PinnedBindingKind::samplerComparison:
        entry.sampler.type = WGPUSamplerBindingType_Comparison;
        break;
    case upstream::PinnedBindingKind::sampler:
        entry.sampler.type = WGPUSamplerBindingType_Filtering;
        break;
    case upstream::PinnedBindingKind::uniformBuffer:
        entry.buffer.type = WGPUBufferBindingType_Uniform;
        break;
    default:
        dawn_error(("a composed shadow binding '" + std::string(row.name) +
                    "' has a kind no receiver can bind.")
                       .c_str());
    }
    return entry;
}

WGPUBindGroupEntry shadow_group_entry(DawnState& state, const Engine& engine,
                                      std::span<const ShadowGeneratorHandle> generators,
                                      const upstream::PinnedShadowBinding& row) {
    if (row.light >= generators.size() ||
        generators[row.light].value >= engine.shadow_generators.size()) {
        dawn_error(("a composed shadow binding names light " + std::to_string(row.light) +
                    ", which carries no generator.")
                       .c_str());
    }
    const ShadowGeneratorHandle handle = generators[row.light];
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = row.binding;
    switch (row.role) {
    case upstream::PinnedShadowRole::map:
        entry.textureView = shadow_map_view(state, engine, handle);
        break;
    case upstream::PinnedShadowRole::map_sampler:
        // Which sampler is the ROW's to say: a PCF map is compared,
        // an ESM one is filtered.
        entry.sampler = row.kind == upstream::PinnedBindingKind::samplerComparison
                            ? state.shadow_comparison_sampler
                            : state.shadow_filtering_sampler;
        break;
    case upstream::PinnedShadowRole::info:
        // How many bytes is the GENERATOR's answer: a single-map
        // receiver binds 96 and a cascaded one 320. The refresh already
        // holds the block this buffer was created from, so its size is
        // read there rather than mirrored into a second vector.
        entry.buffer = handle_at(state.shadow_uniforms, handle);
        entry.size = handle_at(state.shadow_refresh.blocks, handle).size;
        break;
    }
    return entry;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_SHADOW_RECEIVERS &&                     \
    (BBLITE_STANDARD_SHADOWS || BBLITE_PBR_SHADOWS)
std::span<const upstream::PinnedShadowBinding> receiver_shadow_rows(DawnLayoutFamily family,
                                                                    std::size_t variant) {
#if BBLITE_STANDARD_SHADOWS
    if (family == DawnLayoutFamily::standard_shadow)
        return pal::standard_shadow_rows(variant);
#endif
#if BBLITE_PBR_SHADOWS
    if (family == DawnLayoutFamily::pbr_shadow)
        return pal::pbr_shadow_rows(variant);
#endif
    dawn_error("layout family " + std::to_string(static_cast<int>(family)) +
               " composes no receiver rows.");
}

WGPUBindGroupLayout shadow_layout_for(DawnState& state, DawnLayoutFamily family,
                                      std::size_t variant) {
    return state.layouts.group(state.device, {family, variant}, [family, variant] {
        const std::span<const upstream::PinnedShadowBinding> rows =
            receiver_shadow_rows(family, variant);
        std::vector<WGPUBindGroupLayoutEntry> entries;
        entries.reserve(rows.size());
        for (const upstream::PinnedShadowBinding& row : rows)
            entries.push_back(shadow_layout_entry(row));
        return entries;
    });
}

WGPUBindGroup shadow_group_for(DawnState& state, const Scene& scene, const Engine& engine,
                               DawnLayoutFamily family, std::size_t variant) {
    const DawnLayoutKey key{family, variant};
    if (const auto found = state.shadow_groups.find(key); found != state.shadow_groups.end())
        return found->second;
    ensure_shadow_samplers(state);
    const std::vector<ShadowGeneratorHandle> generators =
        shadow_generators_in_light_order(scene, engine);
    const std::span<const upstream::PinnedShadowBinding> rows =
        receiver_shadow_rows(family, variant);
    std::vector<WGPUBindGroupEntry> entries;
    entries.reserve(rows.size());
    for (const upstream::PinnedShadowBinding& row : rows) {
        entries.push_back(shadow_group_entry(state, engine, generators, row));
    }
    WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    descriptor.layout = shadow_layout_for(state, family, variant);
    descriptor.entryCount = entries.size();
    descriptor.entries = entries.data();
    DawnBindGroup group{wgpuDeviceCreateBindGroup(state.device, &descriptor)};
    if (!group)
        dawn_error("shadow receiver bind group creation failed.");
    return state.shadow_groups.emplace(key, std::move(group)).first->second;
}
#endif

#if (BBLITE_HAS_DAWN && BBLITE_HAS_PBR_RENDERER) && BBLITE_SHADOW_RECEIVERS
void write_shadow_generators(DawnState& state, const Scene& scene, Engine& engine) {
    if (engine.shadow_generators.empty())
        return;
    for (std::size_t index = 0; index < state.shadow_uniforms.size(); ++index) {
        if (engine.shadow_generators[index].map_target.value != invalid_handle)
            continue;
        if (const auto buffer = std::exchange(state.shadow_uniforms[index], nullptr))
            wgpuBufferRelease(buffer);
#if BBLITE_SHADOWS_ESM
        if (const auto buffer = std::exchange(state.shadow_params[index], nullptr))
            wgpuBufferRelease(buffer);
#endif
    }
#if BBLITE_SHADOWS_ESM
    mark_active_esm_maps(engine, state.active_esm_maps, state.esm_blurs.size());
    for (std::uint32_t index = 0; index < state.esm_blurs.size(); ++index) {
        if (!state.active_esm_maps[index])
            state.esm_blurs[index].clear();
    }
#endif
    if (state.shadow_uniforms.size() < engine.shadow_generators.size()) {
        state.shadow_uniforms.resize(engine.shadow_generators.size(), nullptr);
#if BBLITE_SHADOWS_ESM
        state.shadow_params.resize(engine.shadow_generators.size(), nullptr);
#endif
    }
    pal::refresh_shadow_generators(
        scene, engine, state.shadow_refresh,
        [&]([[maybe_unused]] const ShadowGeneratorRecord& generator, ShadowGeneratorHandle handle,
            std::size_t, const upstream::ShadowReceiverBlock& block, bool moved) {
#if BBLITE_SHADOWS_ESM
            // `shadow_params_block` reads what the factory fixed -- bias,
            // depth scale, texel size -- so it is built once and outlives
            // every refresh.
            if (generator.filter == ShadowFilter::esm_directional &&
                !handle_at(state.shadow_params, handle)) {
                const std::array<float, 8> params = upstream::shadow_params_block(generator);
                handle_at(state.shadow_params, handle) = create_buffer(
                    state, WGPUBufferUsage_Uniform, params.data(), params.size() * sizeof(float));
            }
#endif
            if (!handle_at(state.shadow_uniforms, handle)) {
                handle_at(state.shadow_uniforms, handle) =
                    create_buffer(state, WGPUBufferUsage_Uniform, block.bytes.data(), block.size);
            } else if (moved) {
                DawnGpuDevice{state.queue}.write_buffer(handle_at(state.shadow_uniforms, handle), 0,
                                                        block.bytes.data(), block.size);
            }
        });
}
#endif

} // namespace dawn_scene
} // namespace bbl::pal
