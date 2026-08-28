#pragma once

// GPU picking on SDL_GPU.
//
// The pin renders the whole candidate set into a ONE-PIXEL target through a
// view projection sheared so the sampled point lands on that pixel
// (`computePickVP` in `picking/gpu-picker.ts`), writes each candidate's id
// as a colour and its clip-space depth to a second attachment, and reads
// both back. Nothing here casts a ray, which is the reason a Gaussian cloud
// picks at all: it has no triangles to intersect, and its own pass draws
// the same splats it draws for the frame with the pick colour substituted.
//
// Two contracts are this port's rather than the pin's, and both come from
// where the world transform lives:
//
//   * an ordinary mesh's vertices are baked to WORLD space here
//     (`transformed_vertices`), while the pin keeps them local and multiplies
//     by `mesh.worldMatrix` in the pick vertex stage. So the mesh block
//     carries the IDENTITY for a baked mesh -- the same positions reach the
//     shader either way. A thin-instanced or floating-origin mesh keeps
//     local vertices precisely because its transform travels as a matrix,
//     and neither is composed with picking by any reached scene, so both
//     refuse rather than picking the wrong geometry.
//   * the position stream is the renderer's interleaved `GpuVertex` buffer
//     read at its own stride rather than a second position-only upload. The
//     pin binds `gpu.positionBuffer`; these are the same numbers at a
//     different pitch.

#include <bblite/runtime.hpp>

#include "pal_sdl_gpu_shared.hpp"

#include <SDL3/SDL_gpu.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace bbl::pal {

/**
 * The one-pixel target set, plus the staging buffer both attachments are
 * copied into. Built on the first pick and released with the renderer, as
 * the pin builds them on first use and releases them in `disposePicker`.
 */
struct PickTargets {
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* depth_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
    SDL_GPUTransferBuffer* staging = nullptr;
};

inline void release_pick_targets(
    SDL_GPUDevice* device,
    PickTargets& targets) {
    if (targets.color) SDL_ReleaseGPUTexture(device, targets.color);
    if (targets.depth_color) {
        SDL_ReleaseGPUTexture(device, targets.depth_color);
    }
    if (targets.depth) SDL_ReleaseGPUTexture(device, targets.depth);
    if (targets.staging) {
        SDL_ReleaseGPUTransferBuffer(device, targets.staging);
    }
    targets = PickTargets{};
}

/** One 1x1 attachment. */
inline SDL_GPUTexture* create_pick_attachment(
    SDL_GPUDevice* device,
    SDL_GPUTextureFormat format,
    SDL_GPUTextureUsageFlags usage,
    const char* label) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = 1;
    info.height = 1;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (!texture) {
        gpu_error(
            (std::string("SDL_CreateGPUTexture ") + label).c_str());
    }
    return texture;
}

inline void ensure_pick_targets(
    SDL_GPUDevice* device,
    PickTargets& targets) {
    if (targets.color) return;
    targets.color = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET,
        "pick-color");
    targets.depth_color = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_R32_FLOAT,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET,
        "pick-depth-color");
    targets.depth = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_D24_UNORM,
        SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET,
        "pick-depth");
    // One 256-aligned row, which is the minimum a texture-to-buffer copy
    // takes. Only the id attachment is read back: the depth one is the
    // pin's own second target and this port consumes nothing from it, so
    // `PickingInfo` declares no `pickedPoint` for it to feed.
    SDL_GPUTransferBufferCreateInfo transfer{};
    transfer.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer.size = 256;
    targets.staging = SDL_CreateGPUTransferBuffer(device, &transfer);
    if (!targets.staging) {
        gpu_error("SDL_CreateGPUTransferBuffer pick");
    }
}

} // namespace bbl::pal
