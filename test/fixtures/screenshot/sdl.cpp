// `captureScreenshot`'s readback on an SDL_GPU Direct3D 12 device: each 8-bit
// format's texture is uploaded with the test's texels, copied and mapped by
// the backend's own halves (lifted into `lifted.hpp`), and unpacked by the
// lowered pin.

#include "check.hpp"

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include <cstddef>
#include <cstring>
#include <exception>

#include "pal_sdl_gpu_error.hpp"
#include "pal_sdl_gpu_resources.hpp"

#include "lifted.hpp"
#include "cases.hpp"

using webgpu_fixture::require;

namespace {
SDL_GPUTexture* uploaded(SDL_GPUDevice* device, SDL_GPUTextureFormat format) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    require(texture != nullptr, "SDL_CreateGPUTexture");
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = sizeof(texels);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    require(transfer != nullptr, "SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    require(mapped != nullptr, "SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, texels, sizeof(texels));
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureTransferInfo source{transfer, 0, width, height};
    const SDL_GPUTextureRegion region{texture, 0, 0, 0, 0, 0, width, height, 1};
    SDL_UploadToGPUTexture(copy, &source, &region, false);
    SDL_EndGPUCopyPass(copy);
    require(SDL_SubmitGPUCommandBuffer(command), "SDL_SubmitGPUCommandBuffer");
    require(SDL_WaitForGPUIdle(device), "SDL_WaitForGPUIdle");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}
} // namespace

int main() {
    try {
        require(SDL_Init(SDL_INIT_VIDEO), "SDL_Init");
        SDL_GPUDevice* device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL, true, "direct3d12");
        require(device != nullptr, "SDL_CreateGPUDevice");
        for (const auto& [label, format] :
             {std::pair{"rgba8unorm", SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM},
              std::pair{"bgra8unorm", SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM}}) {
            SDL_GPUTexture* texture = uploaded(device, format);
            SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
            require(command != nullptr, "SDL_AcquireGPUCommandBuffer");
            const bbl::pal::SdlTextureDownload download = bbl::pal::record_sdl_texture_download(
                device, command, texture, width, height, 4,
                bbl::upstream::screenshot_bytes_per_row(width));
            const bbl::pal::OwnedSdlFence submitted{
                SDL_SubmitGPUCommandBufferAndAcquireFence(command), {device}};
            require(submitted != nullptr, "SDL_SubmitGPUCommandBufferAndAcquireFence");
            {
                const bbl::pal::SdlReadbackMap mapped(
                    device, submitted.get(), download.transfer.get(),
                    static_cast<std::size_t>(download.bytes_per_row) * height);
                screenshot_check::print_unpacked(label, mapped.bytes(), width, height,
                                                 download.bytes_per_row,
                                                 *bbl::pal::screenshot_bgra(label));
            }
            SDL_ReleaseGPUTexture(device, texture);
        }
        SDL_DestroyGPUDevice(device);
        SDL_Quit();
        std::printf("sdl ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s: %s\n", error.what(), SDL_GetError());
        return 1;
    }
}
