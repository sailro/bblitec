#pragma once
#include "pal_sdl_gpu_storage_buffer.hpp"
#include "pal_sdl_gpu_compute_texture.hpp"
#include <bblite/pal_compute_pipeline.hpp>
#include <sstream>
#include <algorithm>

namespace bbl::pal {
struct SdlComputeGroupLayout final : ComputeGroupLayout {
    explicit SdlComputeGroupLayout(ComputeGroupLayoutDescriptor value)
        : descriptor(std::move(value)) {
        for (const auto& field : descriptor.entries)
            if (field.buffer && field.buffer->has_dynamic_offset)
                dynamic_bindings.push_back(static_cast<std::uint32_t>(field.binding));
        std::sort(dynamic_bindings.begin(), dynamic_bindings.end());
    }
    const ComputeGroupLayoutDescriptor descriptor;
    std::vector<std::uint32_t> dynamic_bindings;
};
struct SdlComputePipelineLayout final : ComputePipelineLayout {
    explicit SdlComputePipelineLayout(ComputePipelineLayoutDescriptor value)
        : descriptor(std::move(value)) {}
    ComputePipelineLayoutDescriptor descriptor;
};
struct SdlComputeShaderModule final : ComputeShaderModule {
    SdlComputeShaderModule(const ComputeShaderModuleDescriptor&, std::string value)
        : artifact(std::move(value)) {}
    std::string artifact;
};
struct SdlComputeSlot {
    char kind = 0;
    std::uint32_t index = 0, group = 0, binding = 0;
    int sampler_group = -1, sampler_binding = -1;
};
struct SdlComputePipeline final : ComputePipeline {
    SDL_GPUDevice* device = nullptr;
    SDL_GPUComputePipeline* handle = nullptr;
    SDL_GPUSampler* fallback_sampler = nullptr;
    SDL_GPUShaderFormat format = SDL_GPU_SHADERFORMAT_INVALID;
    std::vector<SdlComputeSlot> slots;
    std::array<Uint32, 6> counts{};
    ~SdlComputePipeline() override {
        if (handle)
            SDL_ReleaseGPUComputePipeline(device, handle);
        if (fallback_sampler)
            SDL_ReleaseGPUSampler(device, fallback_sampler);
    }
};
struct SdlComputeBindGroup final : ComputeBindGroup {
    explicit SdlComputeBindGroup(ComputeBindGroupDescriptor value) : descriptor(std::move(value)) {}
    ComputeBindGroupDescriptor descriptor;
};
template <class Native, class Base>
const Native& sdl_compute_resource(const std::shared_ptr<Base>& value) {
    const auto* native = dynamic_cast<const Native*>(value.get());
    if (!native)
        throw std::runtime_error("Compute resource belongs to a different backend.");
    return *native;
}
inline std::shared_ptr<ComputePipeline>
create_sdl_gpu_compute_pipeline(SDL_GPUDevice* device, const ComputePipelineDescriptor& source) {
    const auto& module = sdl_compute_resource<SdlComputeShaderModule>(source.compute.module);
    const std::string override = environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string root =
        override.empty() ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR) : override;
    auto result = std::make_shared<SdlComputePipeline>();
    result->device = device;
    const auto supported = SDL_GetGPUShaderFormats(device);
    std::string extension, entry = source.compute.entry_point;
    if (supported & SDL_GPU_SHADERFORMAT_DXIL) {
        result->format = SDL_GPU_SHADERFORMAT_DXIL;
        extension = ".dxil";
    } else if (supported & SDL_GPU_SHADERFORMAT_SPIRV) {
        result->format = SDL_GPU_SHADERFORMAT_SPIRV;
        extension = ".spv";
    } else if (supported & SDL_GPU_SHADERFORMAT_MSL) {
        result->format = SDL_GPU_SHADERFORMAT_MSL;
        extension = ".msl";
        entry = "main0";
    } else
        throw std::runtime_error("SDL compute has no supported shader format.");
    const auto code = read_binary_file(join_path(root, module.artifact + extension));
    const auto metadata = read_binary_file(join_path(root, module.artifact + ".slots"));
    std::istringstream input(std::string(metadata.begin(), metadata.end()));
    SDL_GPUComputePipelineCreateInfo info{};
    std::string line;
    bool threads = false;
    while (std::getline(input, line)) {
        std::istringstream row(line);
        std::string key, name;
        if (!(row >> key))
            continue;
        if (key == "@workgroup") {
            if (threads || !(row >> info.threadcount_x >> info.threadcount_y >> info.threadcount_z))
                throw std::runtime_error("Invalid compute workgroup metadata.");
            threads = true;
            continue;
        }
        SdlComputeSlot slot;
        slot.kind = key.at(0);
        slot.index = static_cast<std::uint32_t>(std::stoul(key.substr(1)));
        if (!(row >> name >> slot.group >> slot.binding >> slot.sampler_group >>
              slot.sampler_binding))
            throw std::runtime_error("Compute binding metadata is incomplete.");
        const std::string kinds = "tirjwb";
        const auto category = kinds.find(slot.kind);
        if (category != std::string::npos)
            result->counts[category] = std::max(result->counts[category], slot.index + 1);
        else if (slot.kind != 's')
            throw std::runtime_error("Invalid compute binding metadata kind.");
        result->slots.push_back(slot);
    }
    if (!threads)
        throw std::runtime_error("Compute artifact has no workgroup metadata.");
    info.code = code.data();
    info.code_size = code.size();
    info.entrypoint = entry.c_str();
    info.format = result->format;
    info.num_samplers = result->counts[0];
    info.num_readonly_storage_textures = result->counts[1];
    info.num_readonly_storage_buffers = result->counts[2];
    info.num_readwrite_storage_textures = result->counts[3];
    info.num_readwrite_storage_buffers = result->counts[4];
    info.num_uniform_buffers = result->counts[5];
    result->handle = SDL_CreateGPUComputePipeline(device, &info);
    if (!result->handle)
        gpu_error("SDL_CreateGPUComputePipeline");
    if (info.num_samplers) {
        SDL_GPUSamplerCreateInfo sampler{};
        sampler.address_mode_u = sampler.address_mode_v = sampler.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        result->fallback_sampler = SDL_CreateGPUSampler(device, &sampler);
        if (!result->fallback_sampler)
            gpu_error("SDL_CreateGPUSampler compute texture load");
    }
    return result;
}
inline std::shared_ptr<ComputeBindGroup>
create_sdl_gpu_compute_bind_group(const ComputeBindGroupDescriptor& source) {
    const auto& layout = sdl_compute_resource<SdlComputeGroupLayout>(source.layout);
    for (const auto& entry : source.entries) {
        const auto found =
            std::find_if(layout.descriptor.entries.begin(), layout.descriptor.entries.end(),
                         [&](const auto& field) { return field.binding == entry.binding; });
        if (found == layout.descriptor.entries.end())
            throw std::runtime_error("Compute binding is absent from its layout.");
        if (const auto* buffer = std::get_if<ComputeBufferResource>(&entry.resource)) {
            if (found->buffer && found->buffer->type == "uniform") {
                const auto& native = sdl_compute_resource<SdlUniformBuffer>(buffer->allocation);
                const auto size = buffer->size.value_or(
                    native.bytes.size() - std::min(buffer->offset, native.bytes.size()));
                if (buffer->offset > native.bytes.size() ||
                    size > native.bytes.size() - buffer->offset)
                    throw std::runtime_error("Compute uniform range exceeds allocation.");
            } else {
                const auto& native = sdl_compute_resource<SdlStorageBuffer>(buffer->allocation);
                if (!native.buffer)
                    throw std::runtime_error("Compute storage allocation is destroyed.");
                // SDL binds whole buffers; subranges require shader offset transport.
                if (!found->buffer || buffer->offset != 0 || found->buffer->has_dynamic_offset ||
                    (buffer->size && *buffer->size != native.byte_length))
                    throw std::runtime_error(
                        "SDL compute storage buffer subranges are not represented.");
            }
        } else {
            const auto& resource = std::get<ComputeTextureResource>(entry.resource);
            const auto& native = sdl_compute_resource<SdlComputeTexture>(resource.allocation);
            if (resource.role == ComputeTextureViewRole::sampler ? !native.sampler
                                                                 : !native.texture)
                throw std::runtime_error("Compute texture allocation is destroyed.");
        }
    }
    return std::make_shared<SdlComputeBindGroup>(source);
}
/** Binding arrays are consumed during encoding; only their capacity spans dispatches. */
struct SdlComputeBindingScratch {
    std::vector<SDL_GPUTextureSamplerBinding> sampled;
    std::vector<SDL_GPUTexture*> readonly_textures;
    std::vector<SDL_GPUBuffer*> readonly_buffers;
    std::vector<SDL_GPUStorageTextureReadWriteBinding> writable_textures;
    std::vector<SDL_GPUStorageBufferReadWriteBinding> writable_buffers;
};
inline void encode_sdl_gpu_compute(SDL_GPUCommandBuffer* command, const ComputeDispatch& source,
                                   SdlComputeBindingScratch& scratch) {
    const auto& pipeline = sdl_compute_resource<SdlComputePipeline>(source.pipeline);
    const auto resource = [&](std::uint32_t group,
                              std::uint32_t binding) -> ComputeBindingResource {
        const auto& input = source.groups.at(group);
        const auto& descriptor = sdl_compute_resource<SdlComputeBindGroup>(input.group).descriptor;
        auto found = std::find_if(descriptor.entries.begin(), descriptor.entries.end(),
                                  [&](const auto& entry) { return entry.binding == binding; });
        if (found == descriptor.entries.end())
            throw std::runtime_error("Compute shader resource is unbound.");
        auto result = found->resource;
        if (auto* buffer = std::get_if<ComputeBufferResource>(&result)) {
            const auto& dynamic =
                sdl_compute_resource<SdlComputeGroupLayout>(descriptor.layout).dynamic_bindings;
            const auto index = std::find(dynamic.begin(), dynamic.end(), binding);
            if (index != dynamic.end())
                buffer->offset +=
                    input.dynamic_offsets.at(static_cast<std::size_t>(index - dynamic.begin()));
        }
        return result;
    };
    auto& [sampled, readonly_textures, readonly_buffers, writable_textures, writable_buffers] =
        scratch;
    sampled.assign(pipeline.counts[0], {nullptr, pipeline.fallback_sampler});
    readonly_textures.assign(pipeline.counts[1], nullptr);
    readonly_buffers.assign(pipeline.counts[2], nullptr);
    writable_textures.assign(pipeline.counts[3], {});
    writable_buffers.assign(pipeline.counts[4], {});
    for (const auto& slot : pipeline.slots) {
        const auto value = resource(slot.group, slot.binding);
        if (slot.kind == 'b') {
            const auto& buffer = std::get<ComputeBufferResource>(value);
            const auto& bytes = sdl_compute_resource<SdlUniformBuffer>(buffer.allocation).bytes;
            const auto size =
                buffer.size.value_or(bytes.size() - std::min(buffer.offset, bytes.size()));
            if (buffer.offset > bytes.size() || size > bytes.size() - buffer.offset ||
                size > std::numeric_limits<Uint32>::max())
                throw std::runtime_error("Compute uniform range exceeds allocation.");
            SdlGpuWriteDevice{}.write_compute_uniform(
                command, slot.index, bytes.data() + buffer.offset, static_cast<Uint32>(size));
        } else if (slot.kind == 'r' || slot.kind == 'w') {
            const auto& buffer = std::get<ComputeBufferResource>(value);
            const auto handle = sdl_compute_resource<SdlStorageBuffer>(buffer.allocation).buffer;
            if (buffer.offset)
                throw std::runtime_error("SDL compute storage buffer offsets are not represented.");
            if (slot.kind == 'r')
                readonly_buffers.at(slot.index) = handle;
            else
                writable_buffers.at(slot.index) = {handle, false, 0, 0, 0};
        } else {
            const auto& texture = std::get<ComputeTextureResource>(value);
            const auto& native = sdl_compute_resource<SdlComputeTexture>(texture.allocation);
            if (slot.kind == 't') {
                auto& pair = sampled.at(slot.index);
                pair.texture = native.texture;
                if (slot.sampler_group >= 0 && pipeline.format != SDL_GPU_SHADERFORMAT_DXIL) {
                    const auto sampler = resource(static_cast<std::uint32_t>(slot.sampler_group),
                                                  static_cast<std::uint32_t>(slot.sampler_binding));
                    pair.sampler = sdl_compute_resource<SdlComputeTexture>(
                                       std::get<ComputeTextureResource>(sampler).allocation)
                                       .sampler;
                }
            } else if (slot.kind == 's') {
                if (pipeline.format == SDL_GPU_SHADERFORMAT_DXIL)
                    sampled.at(slot.index).sampler = native.sampler;
            } else if (slot.kind == 'i')
                readonly_textures.at(slot.index) = native.texture;
            else if (slot.kind == 'j')
                writable_textures.at(slot.index) = {native.texture, 0, 0, false, 0, 0, 0};
        }
    }
    // The indirect-buffer lookup below can refuse; the guard still ends the
    // pass before the command buffer is cancelled.
    SdlComputePass pass{SDL_BeginGPUComputePass(
        command, writable_textures.data(), static_cast<Uint32>(writable_textures.size()),
        writable_buffers.data(), static_cast<Uint32>(writable_buffers.size()))};
    if (!pass)
        gpu_error("SDL_BeginGPUComputePass");
    SDL_BindGPUComputePipeline(pass, pipeline.handle);
    if (!sampled.empty())
        SDL_BindGPUComputeSamplers(pass, 0, sampled.data(), static_cast<Uint32>(sampled.size()));
    if (!readonly_textures.empty())
        SDL_BindGPUComputeStorageTextures(pass, 0, readonly_textures.data(),
                                          static_cast<Uint32>(readonly_textures.size()));
    if (!readonly_buffers.empty())
        SDL_BindGPUComputeStorageBuffers(pass, 0, readonly_buffers.data(),
                                         static_cast<Uint32>(readonly_buffers.size()));
    if (source.indirect)
        SDL_DispatchGPUComputeIndirect(
            pass, sdl_compute_resource<SdlStorageBuffer>(source.indirect->allocation).buffer,
            static_cast<Uint32>(source.indirect->offset));
    else
        SDL_DispatchGPUCompute(pass, source.workgroups[0], source.workgroups[1],
                               source.workgroups[2]);
    pass.end();
}
inline void dispatch_sdl_gpu_compute(SDL_GPUDevice* device, const ComputeDispatch& source) {
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer compute");
    SdlComputeBindingScratch scratch;
    encode_sdl_gpu_compute(command, source, scratch);
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer compute");
}
} // namespace bbl::pal
