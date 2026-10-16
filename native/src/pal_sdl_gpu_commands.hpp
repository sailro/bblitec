#pragma once

#include <SDL3/SDL_gpu.h>
#include <stdexcept>
#include <utility>

namespace bbl::pal {

class GpuBufferUploadBatch;

/**
 * The queue writes a thread stages into one batch, one staging at a time. Every command buffer
 * the thread submits first submits them, as WebGPU orders `queue.writeBuffer` before later
 * submissions.
 */
class SdlStagedWrites {
public:
    SdlStagedWrites(const SdlStagedWrites&) = delete;
    SdlStagedWrites& operator=(const SdlStagedWrites&) = delete;

    /** The active staging's batch for `device`, or null. */
    static GpuBufferUploadBatch* batch_for(const SDL_GPUDevice* device) {
        return active_ && active_->device_ == device ? active_->batch_ : nullptr;
    }
    /** Submits the active staging, which its own submission does not re-enter. */
    static void submit_active() {
        if (SdlStagedWrites* staged = std::exchange(active_, nullptr)) {
            struct Reset {
                SdlStagedWrites* value;
                ~Reset() { active_ = value; }
            } reset{staged};
            staged->submit();
        }
    }

protected:
    SdlStagedWrites(const SDL_GPUDevice* device, GpuBufferUploadBatch& batch)
        : device_(device), batch_(&batch) {
        if (active_)
            throw std::logic_error("Staged SDL writes do not nest.");
        active_ = this;
    }
    ~SdlStagedWrites() { active_ = nullptr; }
    GpuBufferUploadBatch& batch() const { return *batch_; }
    virtual void submit() = 0;

private:
    const SDL_GPUDevice* device_;
    GpuBufferUploadBatch* batch_;
    inline static thread_local SdlStagedWrites* active_ = nullptr;
};

/** A command is consumed even when submission fails. Acquired swapchains forbid cancellation. */
class SdlGpuCommand {
    SDL_GPUCommandBuffer* command_ = nullptr;
    bool acquired_swapchain_ = false;

public:
    explicit SdlGpuCommand(SDL_GPUCommandBuffer* command) noexcept : command_(command) {}
    SdlGpuCommand(const SdlGpuCommand&) = delete;
    SdlGpuCommand& operator=(const SdlGpuCommand&) = delete;
    SdlGpuCommand(SdlGpuCommand&& other) noexcept
        : command_(std::exchange(other.command_, nullptr)),
          acquired_swapchain_(other.acquired_swapchain_) {}
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
    bool acquire_swapchain(SDL_Window* window, SDL_GPUTexture** texture, Uint32* width,
                           Uint32* height) {
        const bool success =
            SDL_WaitAndAcquireGPUSwapchainTexture(command_, window, texture, width, height);
        if (success && *texture)
            acquired_swapchain_ = true;
        return success;
    }
    // The thread's staged writes go first; if they throw, the destructor consumes this command.
    bool submit() {
        SdlStagedWrites::submit_active();
        return SDL_SubmitGPUCommandBuffer(std::exchange(command_, nullptr));
    }
    SDL_GPUFence* submit_with_fence() {
        SdlStagedWrites::submit_active();
        return SDL_SubmitGPUCommandBufferAndAcquireFence(std::exchange(command_, nullptr));
    }
    void reset() noexcept {
        if (auto* command = std::exchange(command_, nullptr)) {
            // An abandoned frame still owes its swapchain image; it needs no staged writes.
            if (acquired_swapchain_)
                SDL_SubmitGPUCommandBuffer(command);
            else
                SDL_CancelGPUCommandBuffer(command);
        }
        acquired_swapchain_ = false;
    }
};

/** End a recording pass before its command is submitted or abandoned. */
template <typename Pass, auto End> class SdlGpuPass {
    Pass* pass_ = nullptr;

public:
    SdlGpuPass() noexcept = default;
    explicit SdlGpuPass(Pass* pass) noexcept : pass_(pass) {}
    SdlGpuPass(const SdlGpuPass&) = delete;
    SdlGpuPass& operator=(const SdlGpuPass&) = delete;
    SdlGpuPass(SdlGpuPass&& other) noexcept : pass_(std::exchange(other.pass_, nullptr)) {}
    SdlGpuPass& operator=(SdlGpuPass&& other) noexcept {
        if (this != &other) {
            end();
            pass_ = std::exchange(other.pass_, nullptr);
        }
        return *this;
    }
    SdlGpuPass& operator=(Pass* pass) noexcept {
        end();
        pass_ = pass;
        return *this;
    }
    ~SdlGpuPass() { end(); }
    Pass* get() const noexcept { return pass_; }
    operator Pass*() const noexcept { return get(); }
    void end() noexcept {
        if (auto* pass = std::exchange(pass_, nullptr))
            End(pass);
    }
};

using SdlRenderPass = SdlGpuPass<SDL_GPURenderPass, SDL_EndGPURenderPass>;
using SdlCopyPass = SdlGpuPass<SDL_GPUCopyPass, SDL_EndGPUCopyPass>;
using SdlComputePass = SdlGpuPass<SDL_GPUComputePass, SDL_EndGPUComputePass>;

} // namespace bbl::pal
