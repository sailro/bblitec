#pragma once

#include <SDL3/SDL_gpu.h>
#include <utility>

namespace bbl::pal {

/** A command is consumed even when submission fails. Acquired swapchains forbid cancellation. */
class SdlGpuCommand {
    SDL_GPUCommandBuffer* command_ = nullptr;
    bool acquired_swapchain_ = false;
public:
    explicit SdlGpuCommand(SDL_GPUCommandBuffer* command) noexcept : command_(command) {}
    SdlGpuCommand(const SdlGpuCommand&) = delete;
    SdlGpuCommand& operator=(const SdlGpuCommand&) = delete;
    SdlGpuCommand(SdlGpuCommand&& other) noexcept
        : command_(std::exchange(other.command_, nullptr)), acquired_swapchain_(other.acquired_swapchain_) {}
    SdlGpuCommand& operator=(SdlGpuCommand&& other) noexcept {
        if (this != &other) {
            reset();
            command_ = std::exchange(other.command_, nullptr);
            acquired_swapchain_ = other.acquired_swapchain_;
        }
        return *this;
    }
    ~SdlGpuCommand() { reset(); }
    SDL_GPUCommandBuffer* get() const noexcept { return command_; }
    operator SDL_GPUCommandBuffer*() const noexcept { return get(); }
    bool acquire_swapchain(SDL_Window* window, SDL_GPUTexture** texture, Uint32* width, Uint32* height) {
        const bool success = SDL_WaitAndAcquireGPUSwapchainTexture(command_, window, texture, width, height);
        if (success && *texture) acquired_swapchain_ = true;
        return success;
    }
    bool submit() noexcept { return SDL_SubmitGPUCommandBuffer(std::exchange(command_, nullptr)); }
    SDL_GPUFence* submit_with_fence() noexcept {
        return SDL_SubmitGPUCommandBufferAndAcquireFence(std::exchange(command_, nullptr));
    }
    void reset() noexcept {
        if (auto* command = std::exchange(command_, nullptr)) {
            if (acquired_swapchain_) SDL_SubmitGPUCommandBuffer(command);
            else SDL_CancelGPUCommandBuffer(command);
        }
        acquired_swapchain_ = false;
    }
};

/** End a recording pass before its command is submitted or abandoned. */
template <typename Pass, auto End>
class SdlGpuPass {
    Pass* pass_ = nullptr;
public:
    SdlGpuPass() noexcept = default;
    explicit SdlGpuPass(Pass* pass) noexcept : pass_(pass) {}
    SdlGpuPass(const SdlGpuPass&) = delete;
    SdlGpuPass& operator=(const SdlGpuPass&) = delete;
    SdlGpuPass(SdlGpuPass&& other) noexcept : pass_(std::exchange(other.pass_, nullptr)) {}
    SdlGpuPass& operator=(SdlGpuPass&& other) noexcept {
        if (this != &other) { end(); pass_ = std::exchange(other.pass_, nullptr); }
        return *this;
    }
    SdlGpuPass& operator=(Pass* pass) noexcept { end(); pass_ = pass; return *this; }
    ~SdlGpuPass() { end(); }
    Pass* get() const noexcept { return pass_; }
    operator Pass*() const noexcept { return get(); }
    void end() noexcept { if (auto* pass = std::exchange(pass_, nullptr)) End(pass); }
};

using SdlRenderPass = SdlGpuPass<SDL_GPURenderPass, SDL_EndGPURenderPass>;
using SdlCopyPass = SdlGpuPass<SDL_GPUCopyPass, SDL_EndGPUCopyPass>;
using SdlComputePass = SdlGpuPass<SDL_GPUComputePass, SDL_EndGPUComputePass>;

} // namespace bbl::pal
