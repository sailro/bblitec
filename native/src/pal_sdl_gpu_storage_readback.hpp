#pragma once
#include "pal_sdl_gpu_storage_buffer.hpp"
#include <bblite/pal_storage_readback.hpp>
#include <thread>

namespace bbl::pal {
struct SdlStorageMapCompletion final : OffscreenCompletion {
    std::jthread waiter;
    SdlStorageMapCompletion(SDL_GPUDevice* device, SDL_GPUFence* fence,
                            std::function<void(std::exception_ptr)> complete)
        : waiter([device, fence, complete = std::move(complete)] {
              std::exception_ptr error;
              try {
                  if (!wait_sdl_fence(device, fence))
                      gpu_error("SDL storage readback fence");
              } catch (...) {
                  error = std::current_exception();
              }
              complete(error);
          }) {}
};
struct SdlStorageReadback final : StorageReadback {
    SDL_GPUDevice* device;
    OwnedSdlTransfer buffer;
    OwnedSdlFence fence;
    std::size_t length;
    const std::uint8_t* mapped = nullptr;
    SdlStorageReadback(SDL_GPUDevice* owner, const StorageReadbackDescriptor& descriptor)
        : device(owner), buffer(nullptr, {owner}), fence(nullptr, {owner}),
          length(descriptor.size) {
        if (descriptor.usage != 9 || length > std::numeric_limits<Uint32>::max())
            throw std::runtime_error("SDL storage readback descriptor is unsupported.");
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
        info.size = static_cast<Uint32>(length);
        buffer.reset(SDL_CreateGPUTransferBuffer(device, &info));
        if (!buffer)
            gpu_error("SDL storage readback allocation");
    }
    ~SdlStorageReadback() override { destroy(); }
    std::size_t byte_length() const override { return length; }
    void destroy() override {
        unmap();
        buffer.reset();
    }
    void copy_from(const std::shared_ptr<StorageBufferAllocation>& allocation, std::size_t offset,
                   std::size_t target, std::size_t count, const std::string&) override {
        const auto source = std::dynamic_pointer_cast<SdlStorageBuffer>(allocation);
        if (!source || !source->buffer || !buffer || offset > source->byte_length ||
            count > source->byte_length - offset || target > length || count > length - target)
            throw std::runtime_error(
                "SDL storage readback requires a live compatible buffer range.");
        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
        if (!command)
            gpu_error("SDL storage readback command");
        SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
        SDL_GPUBufferRegion from{source->buffer, static_cast<Uint32>(offset),
                                 static_cast<Uint32>(count)};
        SDL_GPUTransferBufferLocation to{buffer.get(), static_cast<Uint32>(target)};
        SDL_DownloadFromGPUBuffer(pass, &from, &to);
        pass.end();
        fence.reset(command.submit_with_fence());
        if (!fence)
            gpu_error("SDL storage readback submit");
    }
    std::unique_ptr<OffscreenCompletion>
    map_async(std::size_t offset, std::size_t count,
              std::function<void(std::exception_ptr)> complete) override {
        if (!buffer || !fence || offset > length || count > length - offset)
            throw std::runtime_error("SDL storage readback is not ready to map.");
        return std::make_unique<SdlStorageMapCompletion>(device, fence.get(), std::move(complete));
    }
    std::span<const std::uint8_t> mapped_range(std::size_t offset, std::size_t count) override {
        if (!buffer || offset > length || count > length - offset)
            throw std::runtime_error("SDL storage readback range is unavailable.");
        if (!mapped)
            mapped = static_cast<const std::uint8_t*>(
                SDL_MapGPUTransferBuffer(device, buffer.get(), false));
        if (!mapped)
            gpu_error("SDL storage readback mapping");
        return {mapped + offset, count};
    }
    void unmap() override {
        if (mapped) {
            SDL_UnmapGPUTransferBuffer(device, buffer.get());
            mapped = nullptr;
        }
    }
};
} // namespace bbl::pal
