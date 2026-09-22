#pragma once
#include <bblite/pal_compute_storage_texture.hpp>
#include <bblite/pal_compute_command.hpp>
#include <span>

namespace bbl {
/** Native resource transport; every descriptor value comes from pinned source. */
struct ProceduralSkyGpuDescriptor {
    pal::ComputeTextureDescriptor texture;
    pal::ComputeShaderModuleDescriptor shader;
    pal::ComputeGroupLayoutDescriptor group;
    std::string entry_point, artifact;
    std::size_t parameter_byte_length = 0;
    std::uint32_t texture_binding = 0, parameter_binding = 0;
};
struct ProceduralSkyGpu {
    std::shared_ptr<pal::OffscreenRun> run;
    std::shared_ptr<pal::ComputeTextureAllocation> texture;
    pal::ComputeTextureDescriptor texture_descriptor;
    std::shared_ptr<pal::StorageBufferAllocation> parameter_buffer;
    std::size_t parameter_byte_length = 0;
    pal::ComputeDispatch dispatch;
    bool destroyed = false;
};
inline js::Promise<std::shared_ptr<ProceduralSkyGpu>>
create_procedural_sky_gpu(std::shared_ptr<Engine> engine, ProceduralSkyGpuDescriptor descriptor) {
    if (!engine || !engine->offscreen_run)
        throw pal::InvalidCanvasState("Procedural sky requires a GPU device.");
    auto state = std::make_shared<ProceduralSkyGpu>();
    state->run = engine->offscreen_run;
    state->texture_descriptor = std::move(descriptor.texture);
    const auto created =
        co_await pal::allocate_compute_texture(state->run, state->texture_descriptor);
    if (created.creation_error)
        std::rethrow_exception(created.creation_error);
    if (created.validation_error)
        throw pal::ComputeTextureValidationError(*created.validation_error);
    state->texture = created.allocation;
    if (!state->texture)
        throw std::runtime_error("Procedural sky texture allocation returned no texture.");
    auto& device = state->run->device();
    state->parameter_byte_length = descriptor.parameter_byte_length;
    state->parameter_buffer = device.create_storage_buffer(
        {descriptor.parameter_byte_length,
         static_cast<std::uint32_t>(pal::StorageBufferRole::uniform), descriptor.shader.label},
        std::nullopt);
    auto group_layout = device.create_compute_group_layout(descriptor.group);
    auto groups = std::make_shared<pal::ComputeGroupLayouts>();
    groups->push_back(group_layout);
    auto layout = device.create_compute_pipeline_layout({descriptor.shader.label, groups});
    auto module = device.create_compute_shader_module(descriptor.shader, descriptor.artifact);
    state->dispatch.pipeline = device.create_compute_pipeline(
        {descriptor.shader.label, layout, {module, descriptor.entry_point}});
    auto group = device.create_compute_bind_group(
        {descriptor.group.label,
         group_layout,
         {{descriptor.texture_binding,
           pal::ComputeTextureResource{state->texture, pal::ComputeTextureViewRole::storage}},
          {descriptor.parameter_binding,
           pal::ComputeBufferResource{state->parameter_buffer, 0,
                                      descriptor.parameter_byte_length}}}});
    state->dispatch.groups.push_back({std::move(group), {}});
    co_return state;
}
inline void write_procedural_sky_parameters(const std::shared_ptr<ProceduralSkyGpu>& state,
                                            std::span<const float> values) {
    if (!state || state->destroyed || values.size_bytes() != state->parameter_byte_length)
        throw std::runtime_error("Procedural sky parameter buffer is not writable.");
    state->parameter_buffer->write(
        0, {reinterpret_cast<const std::uint8_t*>(values.data()), values.size_bytes()});
}
inline void
record_procedural_sky_dispatch(const std::shared_ptr<pal::ComputeCommandEncoder>& encoder,
                               const std::shared_ptr<ProceduralSkyGpu>& state,
                               std::array<std::uint32_t, 3> workgroups) {
    if (!state || state->destroyed || !encoder || encoder->finished || encoder->pass_active ||
        encoder->device.get() != &state->run->device())
        throw std::runtime_error("Procedural sky command encoder is not recordable.");
    auto dispatch = state->dispatch;
    dispatch.workgroups = workgroups;
    encoder->commands.emplace_back(std::move(dispatch));
}
inline void dispose_procedural_sky_gpu(const std::shared_ptr<ProceduralSkyGpu>& state) {
    if (!state || state->destroyed)
        return;
    state->destroyed = true;
    state->dispatch = {};
    if (state->parameter_buffer)
        state->parameter_buffer->destroy();
    if (state->texture)
        state->texture->destroy();
}
} // namespace bbl
