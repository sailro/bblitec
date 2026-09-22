#pragma once
#include "pal_dawn_compute_texture.hpp"
#include "pal_dawn_storage_buffer.hpp"
#include <bblite/pal_compute_pipeline.hpp>

namespace bbl::pal {
struct DawnComputeGroupLayout final : ComputeGroupLayout {
    DawnBindGroupLayout handle;
};
struct DawnComputePipelineLayout final : ComputePipelineLayout {
    DawnPipelineLayout handle;
};
struct DawnComputeShaderModule final : ComputeShaderModule {
    DawnShaderModule handle;
};
struct DawnComputePipeline final : ComputePipeline {
    DawnOwned<WGPUComputePipeline, wgpuComputePipelineRelease> handle;
};
struct DawnComputeBindGroup final : ComputeBindGroup {
    std::vector<ComputeBindGroupEntry> resources;
    DawnBindGroup handle;
};

template <class Native, class Base>
const Native& dawn_compute_resource(const std::shared_ptr<Base>& value) {
    const auto* native = dynamic_cast<const Native*>(value.get());
    if (!native)
        throw std::runtime_error("Compute resource belongs to a different backend.");
    return *native;
}
inline WGPUTextureViewDimension dawn_compute_view_dimension(const std::string& value) {
    if (value == "1d")
        return WGPUTextureViewDimension_1D;
    if (value == "2d")
        return WGPUTextureViewDimension_2D;
    if (value == "2d-array")
        return WGPUTextureViewDimension_2DArray;
    if (value == "cube")
        return WGPUTextureViewDimension_Cube;
    if (value == "cube-array")
        return WGPUTextureViewDimension_CubeArray;
    if (value == "3d")
        return WGPUTextureViewDimension_3D;
    throw std::runtime_error("Invalid compute texture view dimension.");
}
inline std::shared_ptr<ComputeGroupLayout>
create_dawn_compute_group_layout(WGPUDevice device, const ComputeGroupLayoutDescriptor& source) {
    std::vector<WGPUBindGroupLayoutEntry> entries;
    for (const auto& input : source.entries) {
        WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        entry.binding = static_cast<std::uint32_t>(input.binding);
        entry.visibility =
            static_cast<WGPUShaderStage>(static_cast<std::uint64_t>(input.visibility));
        if (input.buffer) {
            const auto& value = *input.buffer;
            if (value.type == "uniform")
                entry.buffer.type = WGPUBufferBindingType_Uniform;
            else if (value.type == "storage")
                entry.buffer.type = WGPUBufferBindingType_Storage;
            else if (value.type == "read-only-storage")
                entry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
            else
                throw std::runtime_error("Invalid compute buffer binding type.");
            entry.buffer.hasDynamicOffset = value.has_dynamic_offset;
            entry.buffer.minBindingSize =
                static_cast<std::uint64_t>(value.min_binding_size.value_or(0));
        }
        if (input.texture) {
            const auto& value = *input.texture;
            if (value.sample_type == "float")
                entry.texture.sampleType = WGPUTextureSampleType_Float;
            else if (value.sample_type == "unfilterable-float")
                entry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
            else if (value.sample_type == "depth")
                entry.texture.sampleType = WGPUTextureSampleType_Depth;
            else if (value.sample_type == "sint")
                entry.texture.sampleType = WGPUTextureSampleType_Sint;
            else if (value.sample_type == "uint")
                entry.texture.sampleType = WGPUTextureSampleType_Uint;
            else
                throw std::runtime_error("Invalid compute texture sample type.");
            entry.texture.viewDimension = dawn_compute_view_dimension(value.view_dimension);
            entry.texture.multisampled = value.multisampled;
        }
        if (input.sampler) {
            const auto& type = input.sampler->type;
            if (type == "filtering")
                entry.sampler.type = WGPUSamplerBindingType_Filtering;
            else if (type == "non-filtering")
                entry.sampler.type = WGPUSamplerBindingType_NonFiltering;
            else if (type == "comparison")
                entry.sampler.type = WGPUSamplerBindingType_Comparison;
            else
                throw std::runtime_error("Invalid compute sampler binding type.");
        }
        if (input.storage_texture) {
            const auto& value = *input.storage_texture;
            if (value.access == "write-only")
                entry.storageTexture.access = WGPUStorageTextureAccess_WriteOnly;
            else if (value.access == "read-only")
                entry.storageTexture.access = WGPUStorageTextureAccess_ReadOnly;
            else if (value.access == "read-write")
                entry.storageTexture.access = WGPUStorageTextureAccess_ReadWrite;
            else
                throw std::runtime_error("Invalid compute storage texture access.");
            entry.storageTexture.viewDimension = dawn_compute_view_dimension(value.view_dimension);
            entry.storageTexture.format = dawn_compute_texture_format(value.format);
        }
        entries.push_back(entry);
    }
    WGPUBindGroupLayoutDescriptor info = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    info.label = {source.label.data(), source.label.size()};
    info.entries = entries.data();
    info.entryCount = entries.size();
    auto result = std::make_shared<DawnComputeGroupLayout>();
    result->handle = require_dawn_resource(wgpuDeviceCreateBindGroupLayout(device, &info),
                                           "compute bind group layout");
    return result;
}
inline std::shared_ptr<ComputePipelineLayout>
create_dawn_compute_pipeline_layout(WGPUDevice device,
                                    const ComputePipelineLayoutDescriptor& source) {
    std::vector<WGPUBindGroupLayout> groups;
    if (source.groups)
        for (const auto& group : *source.groups)
            groups.push_back(dawn_compute_resource<DawnComputeGroupLayout>(group).handle);
    WGPUPipelineLayoutDescriptor info = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    info.label = {source.label.data(), source.label.size()};
    info.bindGroupLayoutCount = groups.size();
    info.bindGroupLayouts = groups.data();
    auto result = std::make_shared<DawnComputePipelineLayout>();
    result->handle = require_dawn_resource(wgpuDeviceCreatePipelineLayout(device, &info),
                                           "compute pipeline layout");
    return result;
}
inline std::shared_ptr<ComputeShaderModule>
create_dawn_compute_shader_module(WGPUDevice device, const ComputeShaderModuleDescriptor& source) {
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = {source.source.data(), source.source.size()};
    WGPUShaderModuleDescriptor info = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    info.nextInChain = &wgsl.chain;
    info.label = {source.label.data(), source.label.size()};
    auto result = std::make_shared<DawnComputeShaderModule>();
    result->handle =
        require_dawn_resource(wgpuDeviceCreateShaderModule(device, &info), "compute shader module");
    return result;
}
inline std::shared_ptr<ComputePipeline>
create_dawn_compute_pipeline(WGPUDevice device, const ComputePipelineDescriptor& source) {
    WGPUComputePipelineDescriptor info = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    info.label = {source.label.data(), source.label.size()};
    info.layout = dawn_compute_resource<DawnComputePipelineLayout>(source.layout).handle;
    info.compute.module =
        dawn_compute_resource<DawnComputeShaderModule>(source.compute.module).handle;
    info.compute.entryPoint = {source.compute.entry_point.data(),
                               source.compute.entry_point.size()};
    auto result = std::make_shared<DawnComputePipeline>();
    result->handle =
        require_dawn_resource(wgpuDeviceCreateComputePipeline(device, &info), "compute pipeline");
    return result;
}
inline std::shared_ptr<ComputeBindGroup>
create_dawn_compute_bind_group(WGPUDevice device, const ComputeBindGroupDescriptor& source) {
    std::vector<WGPUBindGroupEntry> entries;
    for (const auto& input : source.entries) {
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.binding = input.binding;
        if (const auto* buffer = std::get_if<ComputeBufferResource>(&input.resource)) {
            entry.buffer = dawn_compute_resource<DawnStorageBuffer>(buffer->allocation).buffer;
            entry.offset = buffer->offset;
            entry.size = buffer->size.value_or(WGPU_WHOLE_SIZE);
        } else {
            const auto& texture = std::get<ComputeTextureResource>(input.resource);
            const auto& native = dawn_compute_resource<DawnComputeTexture>(texture.allocation);
            if (texture.role == ComputeTextureViewRole::sampler)
                entry.sampler = native.sampler;
            else
                entry.textureView = texture.role == ComputeTextureViewRole::storage
                                        ? native.storage_view.get()
                                        : native.sampled_view.get();
        }
        entries.push_back(entry);
    }
    WGPUBindGroupDescriptor info = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    info.label = {source.label.data(), source.label.size()};
    info.layout = dawn_compute_resource<DawnComputeGroupLayout>(source.layout).handle;
    info.entryCount = entries.size();
    info.entries = entries.data();
    auto result = std::make_shared<DawnComputeBindGroup>();
    result->resources = source.entries;
    result->handle =
        require_dawn_resource(wgpuDeviceCreateBindGroup(device, &info), "compute bind group");
    return result;
}
inline void encode_dawn_compute(WGPUCommandEncoder command, const ComputeDispatch& source) {
    DawnOwned<WGPUComputePassEncoder, wgpuComputePassEncoderRelease> pass{require_dawn_resource(
        wgpuCommandEncoderBeginComputePass(command, nullptr), "compute pass")};
    wgpuComputePassEncoderSetPipeline(
        pass, dawn_compute_resource<DawnComputePipeline>(source.pipeline).handle);
    for (std::size_t index = 0; index < source.groups.size(); ++index) {
        const auto& group = source.groups[index];
        wgpuComputePassEncoderSetBindGroup(
            pass, static_cast<std::uint32_t>(index),
            dawn_compute_resource<DawnComputeBindGroup>(group.group).handle,
            group.dynamic_offsets.size(), group.dynamic_offsets.data());
    }
    if (source.indirect)
        wgpuComputePassEncoderDispatchWorkgroupsIndirect(
            pass, dawn_compute_resource<DawnStorageBuffer>(source.indirect->allocation).buffer,
            source.indirect->offset);
    else
        wgpuComputePassEncoderDispatchWorkgroups(pass, source.workgroups[0], source.workgroups[1],
                                                 source.workgroups[2]);
    wgpuComputePassEncoderEnd(pass);
}
inline void dispatch_dawn_compute(WGPUDevice device, WGPUQueue queue,
                                  const ComputeDispatch& source) {
    DawnCommandEncoder command{require_dawn_resource(
        wgpuDeviceCreateCommandEncoder(device, nullptr), "compute command encoder")};
    encode_dawn_compute(command, source);
    DawnCommandBuffer submitted{require_dawn_resource(wgpuCommandEncoderFinish(command, nullptr),
                                                      "compute command buffer")};
    submit_dawn_command(queue, submitted);
}
} // namespace bbl::pal
