#pragma once

#include <bblite/joining_thread.hpp>
#include <bblite/pal_offscreen.hpp>

#include "pal_sdl_gpu_error.hpp"
#include "pal_sdl_gpu_resources.hpp"

#include <exception>
#include <functional>
#include <utility>

namespace bbl::pal {

/** Capture the queue boundary on its owner; only the native fence wait leaves that thread. */
class SdlSubmissionCompletion final : public OffscreenCompletion {
public:
    SdlSubmissionCompletion(SDL_GPUDevice* owner, std::function<void(std::exception_ptr)> complete)
        : device_(owner), fence_(capture(owner), {owner}),
          waiter_([this, complete = std::move(complete)] {
              std::exception_ptr error;
              try {
                  if (!wait_sdl_gpu_fence(device_, fence_.get()))
                      gpu_error("SDL_WaitForGPUFences submitted work");
              } catch (...) {
                  error = std::current_exception();
              }
              complete(error);
          }) {}

private:
    static SDL_GPUFence* capture(SDL_GPUDevice* device) {
        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
        if (!command)
            gpu_error("SDL_AcquireGPUCommandBuffer completion fence");
        auto* fence = command.submit_with_fence();
        if (!fence)
            gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence completion");
        return fence;
    }
    SDL_GPUDevice* device_;
    OwnedSdlFence fence_;
    JoiningThread waiter_;
};

} // namespace bbl::pal
