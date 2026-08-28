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

#include <SDL3/SDL_gpu.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace bbl::pal {

/** The pin's `SceneUniforms`: the sheared VP, then the sampled pixel. */
struct PickSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 2> fragment_coord{};
    std::array<float, 2> _pad{};
};

/** The pin's `MeshUniforms`: the world matrix, then the id. */
struct PickMeshUniforms {
    std::array<float, 16> world{};
    std::uint32_t pick_id = 0;
    std::array<std::uint32_t, 3> _pad{};
};

/**
 * `computePickVP`, lowered from its own body.
 *
 * The shear maps the sampled point to the one pixel the target has: each
 * column's x and y are scaled by the viewport extent and offset by the
 * sample's NDC, so the sample lands at the origin of a 1x1 clip volume.
 */
inline void compute_pick_view_projection(
    std::array<float, 20>& out,
    const std::array<float, 16>& vp,
    double sample_x,
    double sample_y,
    double width,
    double height) {
    const double ndc_x = 2.0 * sample_x / width - 1.0;
    const double ndc_y = 1.0 - 2.0 * sample_y / height;
    for (int column = 0; column < 4; ++column) {
        const int base = column * 4;
        const double w3 = static_cast<double>(vp[base + 3]);
        out[static_cast<std::size_t>(base)] = static_cast<float>(
            width * (static_cast<double>(vp[base]) - ndc_x * w3));
        out[static_cast<std::size_t>(base) + 1] = static_cast<float>(
            height * (static_cast<double>(vp[base + 1]) - ndc_y * w3));
        out[static_cast<std::size_t>(base) + 2] = vp[base + 2];
        out[static_cast<std::size_t>(base) + 3] = vp[base + 3];
    }
}

/**
 * `computeGsPickMatrix`, lowered from its own body.
 *
 * The cloud's vertex stage already produced clip space, so its shear is a
 * post-multiply rather than a replacement projection: scale by the viewport
 * and translate by the sample's NDC.
 */
inline void compute_cloud_pick_matrix(
    std::array<float, 16>& out,
    double sample_x,
    double sample_y,
    double width,
    double height) {
    const double ndc_x = 2.0 * sample_x / width - 1.0;
    const double ndc_y = 1.0 - 2.0 * sample_y / height;
    out = {};
    out[0] = static_cast<float>(width);
    out[5] = static_cast<float>(height);
    out[10] = 1.0f;
    out[12] = static_cast<float>(-ndc_x * width);
    out[13] = static_cast<float>(-ndc_y * height);
    out[15] = 1.0f;
}

/** `encodeIdToColor`: the id's three bytes as unit floats. */
inline std::array<float, 3> encode_pick_id_to_color(std::uint32_t id) {
    return {
        static_cast<float>((id >> 16) & 0xFFu) / 255.0f,
        static_cast<float>((id >> 8) & 0xFFu) / 255.0f,
        static_cast<float>(id & 0xFFu) / 255.0f,
    };
}

/** The colour attachment's three bytes back into the id they encode. */
inline std::uint32_t decode_pick_id(const std::uint8_t* texel) {
    return (static_cast<std::uint32_t>(texel[0]) << 16) |
           (static_cast<std::uint32_t>(texel[1]) << 8) |
           static_cast<std::uint32_t>(texel[2]);
}

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
        throw std::runtime_error(
            std::string("SDL_CreateGPUTexture ") + label + " failed: " +
            SDL_GetError());
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
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER,
        "pick-color");
    targets.depth_color = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_R32_FLOAT,
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER,
        "pick-depth-color");
    targets.depth = create_pick_attachment(
        device,
        SDL_GPU_TEXTUREFORMAT_D24_UNORM,
        SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET,
        "pick-depth");
    // Both attachments are copied into one buffer, each at its own
    // 256-aligned row, which is what a texture-to-buffer copy requires.
    SDL_GPUTransferBufferCreateInfo transfer{};
    transfer.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer.size = 512;
    targets.staging = SDL_CreateGPUTransferBuffer(device, &transfer);
    if (!targets.staging) {
        throw std::runtime_error(
            std::string("SDL_CreateGPUTransferBuffer pick failed: ") +
            SDL_GetError());
    }
}

} // namespace bbl::pal
