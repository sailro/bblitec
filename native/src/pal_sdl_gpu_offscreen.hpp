#pragma once

#include "pal_sdl_gpu_shared.hpp"
#include "pal_offscreen_gpu.hpp"

namespace bbl::pal {

/** The host retains the device until all producers and image leases end. */
struct SdlOffscreenDevice final : OffscreenDevice {
    explicit SdlOffscreenDevice(SDL_GPUDevice* value) : device(value) {}
    SDL_GPUDevice* device;
};

struct SdlOffscreenImage final : OffscreenImage {
    SdlOffscreenImage(SDL_GPUDevice* owner, std::uint32_t width, std::uint32_t height)
        : device(owner), texture(create_frame_texture(owner,
              SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM, SDL_GPU_SAMPLECOUNT_1,
              width, height, SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER)) {}
    ~SdlOffscreenImage() override { SDL_ReleaseGPUTexture(device, texture); }
    SDL_GPUDevice* device;
    SDL_GPUTexture* texture;
};

/** Three GPU images, reused only after the presenter releases its GPU fences. */
class SdlOffscreenTarget {
  public:
    explicit SdlOffscreenTarget(SDL_GPUDevice* device) : device_(device) {}

    SDL_GPUTexture* acquire(std::uint32_t width, std::uint32_t height, OffscreenRun& run) {
        auto* image = images_.acquire(width, height, run, [&](auto w, auto h) {
            return std::make_shared<SdlOffscreenImage>(device_, w, h);
        });
        return image ? image->texture : nullptr;
    }

    void publish(SDL_GPUCommandBuffer* command, OffscreenRun& run) {
        if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer offscreen");
        // The presenter's submit follows this one on the same device queue.
        images_.publish(run);
    }

  private:
    SDL_GPUDevice* device_;
    OffscreenImagePool<SdlOffscreenImage> images_;
};

} // namespace bbl::pal
