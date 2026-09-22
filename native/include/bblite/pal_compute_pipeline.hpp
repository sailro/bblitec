#pragma once
#include <optional>
#include <bblite/pal_compute_binding.hpp>
#include <bblite/pal_compute_texture.hpp>
#include <bblite/pal_storage_buffer.hpp>
#include <array>
#include <variant>
#include <memory>
#include <string>
#include <vector>

namespace bbl::pal {
/** Numeric limits exposed by the backend; absence means the API cannot query it. */
struct ComputeShaderLimits {
    std::optional<double> max_bind_groups;
    std::optional<double> max_bindings_per_bind_group;
    std::optional<double> max_uniform_buffers_per_shader_stage;
    std::optional<double> max_storage_buffers_per_shader_stage;
    std::optional<double> max_dynamic_uniform_buffers_per_pipeline_layout;
    std::optional<double> max_dynamic_storage_buffers_per_pipeline_layout;
    std::optional<double> max_sampled_textures_per_shader_stage;
    std::optional<double> max_samplers_per_shader_stage;
    std::optional<double> max_storage_textures_per_shader_stage;
    std::optional<double> min_storage_buffer_offset_alignment;
    std::optional<double> max_storage_buffer_binding_size;
    std::optional<double> max_uniform_buffer_binding_size;
    std::optional<double> max_compute_workgroups_per_dimension;
};
struct ComputeLayoutEntry : ComputeResourceLayout {
    double binding = 0, visibility = 0;
};
struct ComputeGroupLayoutDescriptor {
    std::string label;
    std::vector<ComputeLayoutEntry> entries;
};
struct ComputeGroupLayout {
    virtual ~ComputeGroupLayout() = default;
};
using ComputeGroupLayouts = std::vector<std::shared_ptr<ComputeGroupLayout>>;
struct ComputePipelineLayoutDescriptor {
    std::string label;
    std::shared_ptr<ComputeGroupLayouts> groups;
};
struct ComputePipelineLayout {
    virtual ~ComputePipelineLayout() = default;
};
struct ComputeShaderModuleDescriptor {
    std::string label, source;
};
struct ComputeShaderModule {
    virtual ~ComputeShaderModule() = default;
};
struct ComputeStageDescriptor {
    std::shared_ptr<ComputeShaderModule> module;
    std::string entry_point;
};
struct ComputePipelineDescriptor {
    std::string label;
    std::shared_ptr<ComputePipelineLayout> layout;
    ComputeStageDescriptor compute;
};
struct ComputePipeline {
    virtual ~ComputePipeline() = default;
};
struct ComputeBufferResource {
    std::shared_ptr<StorageBufferAllocation> allocation;
    std::size_t offset = 0;
    std::optional<std::size_t> size;
};
enum class ComputeTextureViewRole { sampled, storage, sampler };
struct ComputeTextureResource {
    std::shared_ptr<ComputeTextureAllocation> allocation;
    ComputeTextureViewRole role = ComputeTextureViewRole::sampled;
};
using ComputeBindingResource = std::variant<ComputeBufferResource, ComputeTextureResource>;
struct ComputeBindGroupEntry {
    std::uint32_t binding = 0;
    ComputeBindingResource resource;
};
struct ComputeBindGroupDescriptor {
    std::string label;
    std::shared_ptr<ComputeGroupLayout> layout;
    std::vector<ComputeBindGroupEntry> entries;
};
struct ComputeBindGroup {
    virtual ~ComputeBindGroup() = default;
};
struct ComputeDispatchGroup {
    std::shared_ptr<ComputeBindGroup> group;
    std::vector<std::uint32_t> dynamic_offsets;
};
struct ComputeDispatch {
    std::shared_ptr<ComputePipeline> pipeline;
    std::vector<ComputeDispatchGroup> groups;
    std::array<std::uint32_t, 3> workgroups{1, 1, 1};
    std::optional<ComputeBufferResource> indirect;
};
struct ComputePipelinePreparation;
} // namespace bbl::pal
