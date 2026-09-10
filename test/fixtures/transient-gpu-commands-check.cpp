#include "pal_sdl_gpu_resources.hpp"
#include <array>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <cstdio>
#include <stdexcept>
#include <string>

struct SDL_GPUCommandBuffer { bool consumed = false; bool acquired = false; int passes = 0; };
struct SDL_GPURenderPass { SDL_GPUCommandBuffer* command; bool ended = false; };
struct SDL_GPUCopyPass { SDL_GPUCommandBuffer* command; bool ended = false; };
struct SDL_GPUComputePass { SDL_GPUCommandBuffer* command; bool ended = false; };
struct SDL_GPUTexture {};
struct SDL_GPUFence {};
struct SDL_GPUBuffer { bool released = false; };
struct SDL_GPUTransferBuffer { bool released = false; bool mapped = false; std::array<std::uint8_t, 4> bytes{}; };
static SDL_GPUTexture texture;
static SDL_GPUFence fence;
static bool acquire_success = true, acquire_texture = true, submit_success = true;
static std::string events;
static int fail_step = 0;
static SDL_GPUBuffer uploaded_buffer;
static SDL_GPUTransferBuffer uploaded_transfer;
static SDL_GPUCommandBuffer upload_command;
static SDL_GPUCopyPass upload_copy{&upload_command};

extern "C" SDL_GPUBuffer* SDLCALL SDL_CreateGPUBuffer(SDL_GPUDevice*, const SDL_GPUBufferCreateInfo*) {
    return fail_step == 1 ? nullptr : &uploaded_buffer;
}
extern "C" void SDLCALL SDL_ReleaseGPUBuffer(SDL_GPUDevice*, SDL_GPUBuffer* buffer) {
    assert(!buffer->released);
    buffer->released = true;
}
extern "C" SDL_GPUTransferBuffer* SDLCALL SDL_CreateGPUTransferBuffer(SDL_GPUDevice*, const SDL_GPUTransferBufferCreateInfo*) {
    return fail_step == 2 ? nullptr : &uploaded_transfer;
}
extern "C" void SDLCALL SDL_ReleaseGPUTransferBuffer(SDL_GPUDevice*, SDL_GPUTransferBuffer* transfer) {
    assert(!transfer->released && !transfer->mapped);
    transfer->released = true;
}
extern "C" void* SDLCALL SDL_MapGPUTransferBuffer(SDL_GPUDevice*, SDL_GPUTransferBuffer* transfer, bool) {
    if (fail_step == 3) return nullptr;
    transfer->mapped = true;
    return transfer->bytes.data();
}
extern "C" void SDLCALL SDL_UnmapGPUTransferBuffer(SDL_GPUDevice*, SDL_GPUTransferBuffer* transfer) {
    assert(transfer->mapped);
    transfer->mapped = false;
}
extern "C" SDL_GPUCommandBuffer* SDLCALL SDL_AcquireGPUCommandBuffer(SDL_GPUDevice*) {
    return fail_step == 4 ? nullptr : &upload_command;
}
extern "C" SDL_GPUCopyPass* SDLCALL SDL_BeginGPUCopyPass(SDL_GPUCommandBuffer* command) {
    if (fail_step == 5) return nullptr;
    ++command->passes;
    return &upload_copy;
}
extern "C" void SDLCALL SDL_UploadToGPUBuffer(SDL_GPUCopyPass* pass, const SDL_GPUTransferBufferLocation* source,
    const SDL_GPUBufferRegion*, bool) {
    assert(pass && !pass->ended && !source->transfer_buffer->released);
}
namespace bbl::pal {
[[noreturn]] void gpu_error(const char* operation) { throw std::runtime_error(operation); }
#include "upload-buffer.hpp"
}

extern "C" bool SDLCALL SDL_WaitAndAcquireGPUSwapchainTexture(
    SDL_GPUCommandBuffer* command, SDL_Window*, SDL_GPUTexture** output, Uint32*, Uint32*) {
    assert(!command->consumed);
    *output = acquire_success && acquire_texture ? &texture : nullptr;
    command->acquired = *output != nullptr;
    return acquire_success;
}
static void consume(SDL_GPUCommandBuffer* command, char event) {
    assert(command && !command->consumed && command->passes == 0);
    command->consumed = true;
    events += event;
}
extern "C" bool SDLCALL SDL_SubmitGPUCommandBuffer(SDL_GPUCommandBuffer* command) {
    consume(command, 'S');
    return submit_success && fail_step != 6;
}
extern "C" SDL_GPUFence* SDLCALL SDL_SubmitGPUCommandBufferAndAcquireFence(SDL_GPUCommandBuffer* command) {
    consume(command, 'F');
    return submit_success ? &fence : nullptr;
}
extern "C" bool SDLCALL SDL_CancelGPUCommandBuffer(SDL_GPUCommandBuffer* command) {
    assert(!command->acquired);
    consume(command, 'C');
    return true;
}
template <typename Pass> static void end(Pass* pass) {
    assert(pass && !pass->ended && !pass->command->consumed);
    pass->ended = true;
    --pass->command->passes;
    events += 'E';
}
extern "C" void SDLCALL SDL_EndGPURenderPass(SDL_GPURenderPass* pass) { end(pass); }
extern "C" void SDLCALL SDL_EndGPUCopyPass(SDL_GPUCopyPass* pass) { end(pass); }
extern "C" void SDLCALL SDL_EndGPUComputePass(SDL_GPUComputePass* pass) { end(pass); }

int main() {
    using namespace bbl::pal;
    for (bool acquired : {false, true}) {
        events.clear();
        SDL_GPUCommandBuffer raw;
        SDL_GPURenderPass raw_pass{&raw};
        try {
            SdlGpuCommand command{&raw};
            if (acquired) {
                SDL_GPUTexture* target = nullptr;
                assert(command.acquire_swapchain(nullptr, &target, nullptr, nullptr) && target);
            }
            ++raw.passes;
            SdlRenderPass pass{&raw_pass};
            throw std::runtime_error("recording failed");
        } catch (const std::runtime_error&) {}
        assert(raw.consumed && raw_pass.ended && events == (acquired ? "ES" : "EC"));
    }
    for (bool success : {false, true}) {
        submit_success = success;
        for (bool fenced : {false, true}) {
            events.clear();
            SDL_GPUCommandBuffer raw;
            {
                SdlGpuCommand command{&raw};
                if (fenced) assert((command.submit_with_fence() != nullptr) == success);
                else assert(command.submit() == success);
                assert(!command);
            }
            assert(raw.consumed && events == (fenced ? "F" : "S"));
        }
    }
    submit_success = true;
    for (bool success : {false, true}) {
        events.clear();
        acquire_success = success;
        acquire_texture = false;
        SDL_GPUCommandBuffer raw;
        {
            SdlGpuCommand command{&raw};
            SDL_GPUTexture* target = nullptr;
            assert(command.acquire_swapchain(nullptr, &target, nullptr, nullptr) == success && !target);
        }
        assert(events == "C");
    }
    acquire_success = acquire_texture = true;
    events.clear();
    SDL_GPUCommandBuffer first, second;
    {
        SdlGpuCommand command{&first};
        SDL_GPUTexture* target = nullptr;
        command.acquire_swapchain(nullptr, &target, nullptr, nullptr);
        SdlGpuCommand moved{std::move(command)};
        SdlGpuCommand replaced{&second};
        replaced = std::move(moved);
        assert(!command && !moved && replaced.get() == &first);
    }
    assert(first.consumed && second.consumed && events == "CS");
    events.clear();
    SDL_GPUCommandBuffer raw;
    SDL_GPUCopyPass copy_raw{&raw};
    SDL_GPUComputePass compute_raw{&raw};
    {
        SdlGpuCommand command{&raw};
        ++raw.passes;
        SdlCopyPass copy{&copy_raw};
        SdlCopyPass moved{std::move(copy)};
        moved.end();
        assert(!copy && !moved);
        ++raw.passes;
        SdlComputePass compute{&compute_raw};
        compute.end();
        command.submit();
    }
    assert(events == "EES");
    const std::array<std::uint8_t, 4> bytes{1, 3, 5, 7};
    for (fail_step = 0; fail_step <= 6; ++fail_step) {
        events.clear();
        uploaded_buffer = {};
        uploaded_transfer = {};
        upload_command = {};
        upload_copy = {&upload_command};
        bool failed = false;
        try {
            auto* buffer = upload_buffer(nullptr, SDL_GPU_BUFFERUSAGE_VERTEX, bytes.data(), bytes.size());
            assert(fail_step == 0 && buffer == &uploaded_buffer && !buffer->released);
            assert(uploaded_transfer.released && uploaded_transfer.bytes == bytes);
            SDL_ReleaseGPUBuffer(nullptr, buffer);
        } catch (const std::runtime_error&) { failed = true; }
        assert(failed == (fail_step != 0));
        assert(uploaded_buffer.released == (fail_step != 1));
        assert(uploaded_transfer.released == (fail_step == 0 || fail_step >= 3));
        if (fail_step == 0 || fail_step == 6) assert(events == "ES");
        else if (fail_step == 5) assert(events == "C");
        else assert(events.empty());
    }
    std::puts("transient-gpu-commands-check: ok");
}
