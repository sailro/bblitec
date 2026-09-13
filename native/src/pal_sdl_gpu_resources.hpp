#pragma once

#include "pal_sdl_gpu_commands.hpp"
#include <SDL3/SDL_gpu.h>
#include <memory>
#include <vector>

namespace bbl::pal {

template <typename Resource, auto Release>
struct SdlGpuDeleter {
    SDL_GPUDevice* device = nullptr;
    void operator()(Resource* resource) const noexcept { Release(device, resource); }
};

using OwnedSdlShader = std::unique_ptr<
    SDL_GPUShader, SdlGpuDeleter<SDL_GPUShader, SDL_ReleaseGPUShader>>;
using OwnedSdlPipeline = std::unique_ptr<
    SDL_GPUGraphicsPipeline,
    SdlGpuDeleter<SDL_GPUGraphicsPipeline, SDL_ReleaseGPUGraphicsPipeline>>;
using OwnedSdlBuffer = std::unique_ptr<
    SDL_GPUBuffer, SdlGpuDeleter<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>>;
using OwnedSdlTexture = std::unique_ptr<
    SDL_GPUTexture, SdlGpuDeleter<SDL_GPUTexture, SDL_ReleaseGPUTexture>>;
using OwnedSdlTransfer = std::unique_ptr<
    SDL_GPUTransferBuffer, SdlGpuDeleter<SDL_GPUTransferBuffer, SDL_ReleaseGPUTransferBuffer>>;
using OwnedSdlFence = std::unique_ptr<
    SDL_GPUFence, SdlGpuDeleter<SDL_GPUFence, SDL_ReleaseGPUFence>>;

inline bool wait_sdl_fence(SDL_GPUDevice* device, SDL_GPUFence* fence) {
    return SDL_WaitForGPUFences(device, true, &fence, 1);
}

/** A device-owned texture list; each entry can be populated in allocation order. */
class SdlSampledTextures {
    SDL_GPUDevice* device_;
    std::vector<std::shared_ptr<OwnedSdlTexture>> shared_images_;
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
    void clear() noexcept {
        for (std::size_t i = 0; i < bindings.size(); ++i) {
            const auto& binding = bindings[i];
            if (binding.texture && (i >= shared_images_.size() || !shared_images_[i])) SDL_ReleaseGPUTexture(device_, binding.texture);
            if (binding.sampler) SDL_ReleaseGPUSampler(device_, binding.sampler);
        }
        bindings.clear();
        shared_images_.clear();
    }
};

} // namespace bbl::pal
