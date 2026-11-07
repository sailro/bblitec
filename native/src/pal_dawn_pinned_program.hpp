#pragma once
// A pinned GPU program's Dawn objects from the layout and stages a generated
// plan carries (`PinnedLayoutEntry`): its group-0 layout through the WebGPU
// layout converter and its full-screen render pipeline. The screen-space
// stages and the SSAO programs build theirs here.

#include "pal_dawn_compute_pipeline.hpp"

#include <bblite/pinned_layout.hpp>

#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pal {

/** A plan's group-0 layout, every entry visible to `visibility`. */
inline DawnBindGroupLayout
create_dawn_pinned_group_layout(WGPUDevice device, std::span<const PinnedLayoutEntry> entries,
                                WGPUShaderStage visibility, std::string label) {
    ComputeGroupLayoutDescriptor descriptor;
    descriptor.label = std::move(label);
    for (const PinnedLayoutEntry& entry : entries) {
        ComputeLayoutEntry layout;
        layout.binding = entry.binding;
        layout.visibility = static_cast<double>(visibility);
        if (!entry.buffer_type.empty())
            layout.buffer.emplace().type = entry.buffer_type;
        if (!entry.sample_type.empty()) {
            ComputeTextureLayout& texture = layout.texture.emplace();
            texture.sample_type = entry.sample_type;
            texture.view_dimension = "2d";
        }
        if (!entry.sampler_type.empty())
            layout.sampler.emplace().type = entry.sampler_type;
        if (!entry.storage_access.empty()) {
            ComputeStorageTextureLayout& storage = layout.storage_texture.emplace();
            storage.access = entry.storage_access;
            storage.format = entry.storage_format;
            storage.view_dimension = "2d";
        }
        descriptor.entries.push_back(std::move(layout));
    }
    const auto created = std::dynamic_pointer_cast<DawnComputeGroupLayout>(
        create_dawn_compute_group_layout(device, descriptor));
    return std::move(created->handle);
}

/** A pipeline layout of the one group a pinned program binds. */
inline DawnPipelineLayout
create_dawn_pinned_pipeline_layout(WGPUDevice device, WGPUBindGroupLayout group, const char* what) {
    WGPUPipelineLayoutDescriptor layout = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layout.bindGroupLayoutCount = 1;
    layout.bindGroupLayouts = &group;
    return DawnPipelineLayout{
        require_dawn_resource(wgpuDeviceCreatePipelineLayout(device, &layout), what)};
}

/**
 * A full-screen pass's pipeline over one module's two entry points: a
 * triangle list, no cull, one sample, unblended targets of `formats`, the
 * fragment stage specialized by `constants`.
 */
inline DawnRenderPipeline
create_dawn_fullscreen_pipeline(WGPUDevice device, WGPUPipelineLayout layout,
                                WGPUShaderModule module, std::string_view vertex_entry,
                                std::string_view fragment_entry,
                                std::span<const WGPUConstantEntry> constants,
                                std::span<const WGPUTextureFormat> formats, const char* what) {
    std::vector<WGPUColorTargetState> targets;
    targets.reserve(formats.size());
    for (const WGPUTextureFormat format : formats) {
        WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
        target.format = format;
        targets.push_back(target);
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = module;
    fragment.entryPoint = WGPUStringView{fragment_entry.data(), fragment_entry.size()};
    fragment.constantCount = constants.size();
    fragment.constants = constants.data();
    fragment.targetCount = targets.size();
    fragment.targets = targets.data();
    WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.layout = layout;
    descriptor.vertex.module = module;
    descriptor.vertex.entryPoint = WGPUStringView{vertex_entry.data(), vertex_entry.size()};
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.cullMode = WGPUCullMode_None;
    descriptor.multisample.count = 1;
    descriptor.fragment = &fragment;
    return DawnRenderPipeline{
        require_dawn_resource(wgpuDeviceCreateRenderPipeline(device, &descriptor), what)};
}

} // namespace bbl::pal
