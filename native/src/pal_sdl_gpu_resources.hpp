#pragma once

#include "pal_sdl_gpu_commands.hpp"
#include <SDL3/SDL_gpu.h>
#include <memory>
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace bbl::pal {

template <typename Resource, auto Release> struct SdlGpuDeleter {
    SDL_GPUDevice* device = nullptr;
    void operator()(Resource* resource) const noexcept { Release(device, resource); }
};

/** The SPIR-V vertex-input remap of each compacted vertex shader. */
struct SdlShaderInputs {
    std::mutex mutex;
    std::map<SDL_GPUShader*, std::map<Uint32, Uint32>> layouts;
};
/** Built on first use: a container may allocate, which a namespace-scope
 *  instance would do during static initialization, where nothing can catch. */
inline SdlShaderInputs& sdl_shader_inputs() {
    static SdlShaderInputs inputs;
    return inputs;
}
inline void release_sdl_gpu_shader(SDL_GPUDevice* device, SDL_GPUShader* shader) {
    {
        auto& inputs = sdl_shader_inputs();
        const std::lock_guard lock(inputs.mutex);
        inputs.layouts.erase(shader);
    }
    SDL_ReleaseGPUShader(device, shader);
}
using OwnedSdlShader =
    std::unique_ptr<SDL_GPUShader, SdlGpuDeleter<SDL_GPUShader, release_sdl_gpu_shader>>;

inline SDL_GPUGraphicsPipeline*
create_sdl_gpu_graphics_pipeline(SDL_GPUDevice* device,
                                 const SDL_GPUGraphicsPipelineCreateInfo* source) {
    auto info = *source;
    std::vector<SDL_GPUVertexAttribute> attributes;
    {
        auto& inputs = sdl_shader_inputs();
        const std::lock_guard lock(inputs.mutex);
        if (const auto layout = inputs.layouts.find(info.vertex_shader);
            layout != inputs.layouts.end()) {
            attributes.reserve(layout->second.size());
            for (Uint32 i = 0; i < info.vertex_input_state.num_vertex_attributes; ++i) {
                auto attribute = info.vertex_input_state.vertex_attributes[i];
                if (const auto location = layout->second.find(attribute.location);
                    location != layout->second.end()) {
                    attribute.location = location->second;
                    attributes.push_back(attribute);
                }
            }
            if (attributes.size() != layout->second.size())
                throw std::runtime_error("SPIR-V vertex input has no pipeline attribute.");
            info.vertex_input_state.vertex_attributes = attributes.data();
            info.vertex_input_state.num_vertex_attributes = static_cast<Uint32>(attributes.size());
        }
    }
    return SDL_CreateGPUGraphicsPipeline(device, &info);
}
using OwnedSdlPipeline =
    std::unique_ptr<SDL_GPUGraphicsPipeline,
                    SdlGpuDeleter<SDL_GPUGraphicsPipeline, SDL_ReleaseGPUGraphicsPipeline>>;
using OwnedSdlBuffer =
    std::unique_ptr<SDL_GPUBuffer, SdlGpuDeleter<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>>;
using OwnedSdlTexture =
    std::unique_ptr<SDL_GPUTexture, SdlGpuDeleter<SDL_GPUTexture, SDL_ReleaseGPUTexture>>;
using OwnedSdlTransfer =
    std::unique_ptr<SDL_GPUTransferBuffer,
                    SdlGpuDeleter<SDL_GPUTransferBuffer, SDL_ReleaseGPUTransferBuffer>>;
using OwnedSdlFence =
    std::unique_ptr<SDL_GPUFence, SdlGpuDeleter<SDL_GPUFence, SDL_ReleaseGPUFence>>;

inline bool wait_sdl_gpu_fence(SDL_GPUDevice* device, SDL_GPUFence* fence) {
    return SDL_WaitForGPUFences(device, true, &fence, 1);
}

/** A device-owned texture list; each entry can be populated in allocation order. */
class SdlSampledTextures {
    SDL_GPUDevice* device_;
    std::vector<std::shared_ptr<OwnedSdlTexture>> shared_images_;
    std::vector<std::shared_ptr<GpuTextureLease>> borrowed_images_;
    std::vector<std::shared_ptr<void>> external_images_;

public:
    std::vector<SDL_GPUTextureSamplerBinding> bindings;
    explicit SdlSampledTextures(SDL_GPUDevice* device) noexcept : device_(device) {}
    SdlSampledTextures(const SdlSampledTextures&) = delete;
    SdlSampledTextures& operator=(const SdlSampledTextures&) = delete;
    ~SdlSampledTextures() { clear(); }
    SDL_GPUTextureSamplerBinding& append_shared_texture(std::shared_ptr<OwnedSdlTexture> image) {
        shared_images_.resize(bindings.size());
        shared_images_.push_back(std::move(image));
        bindings.push_back({shared_images_.back()->get(), nullptr});
        return bindings.back();
    }
    void append_borrowed_texture(std::shared_ptr<GpuTextureSource> image, SDL_GPUTexture* texture,
                                 SDL_GPUSampler* sampler) {
        borrowed_images_.resize(bindings.size());
        borrowed_images_.push_back(std::make_shared<GpuTextureLease>(std::move(image)));
        bindings.push_back({texture, sampler});
    }
    void bind_external_texture(std::size_t index, std::shared_ptr<void> owner,
                               SDL_GPUTextureSamplerBinding binding) {
        external_images_.resize(bindings.size());
        external_images_.at(index) = std::move(owner);
        bindings.at(index) = binding;
    }
    void clear() noexcept {
        for (std::size_t i = 0; i < bindings.size(); ++i) {
            const auto& binding = bindings[i];
            if (i < borrowed_images_.size() && borrowed_images_[i])
                continue;
            if (i < external_images_.size() && external_images_[i])
                continue;
            if (binding.texture && (i >= shared_images_.size() || !shared_images_[i]))
                SDL_ReleaseGPUTexture(device_, binding.texture);
            if (binding.sampler)
                SDL_ReleaseGPUSampler(device_, binding.sampler);
        }
        bindings.clear();
        shared_images_.clear();
        borrowed_images_.clear();
        external_images_.clear();
    }
};

} // namespace bbl::pal
