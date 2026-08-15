#pragma once

// SDL_GPU mechanics shared by the renderers that draw through it.
//
// These are the operations every SDL_GPU path needs and none of them knows
// anything about Babylon: report a failure, load a compiled shader, upload
// or refresh a buffer, upload a 2D texture, build a sampler, read a target
// back as a PNG. They lived inside the PBR renderer's translation unit
// while it was the only one; the sprite renderer is the second, and it is
// a separate translation unit because a sprite-only scene generates no
// camera or render-plan headers for the PBR one to include.

#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#include <SDL3_image/SDL_image.h>

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "shaders"
#endif

namespace bbl::pal {

[[noreturn]] inline void gpu_error(const char* operation) {
    throw std::runtime_error(std::string(operation) + ": " + SDL_GetError());
}

inline void save_texture_png(
    SDL_GPUDevice* device,
    SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* swapchain,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height,
    const std::string& path,
    const std::string& raw_path = {}) {
    const std::uint32_t bytes_per_pixel =
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
            ? 8u
            : format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT
                ? 2u
                : 4u;
    const std::uint32_t source_row_bytes = width * bytes_per_pixel;
    const std::uint32_t aligned_row_bytes =
        (source_row_bytes + 255u) & ~255u;
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer_info.size = aligned_row_bytes * height;
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer screenshot");

    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureRegion source{
        swapchain, 0, 0, 0, 0, 0, width, height, 1};
    const SDL_GPUTextureTransferInfo destination{
        transfer, 0, aligned_row_bytes / bytes_per_pixel, height};
    SDL_DownloadFromGPUTexture(copy, &source, &destination);
    SDL_EndGPUCopyPass(copy);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    if (!fence) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence");
    }
    if (!SDL_WaitForGPUFences(device, true, &fence, 1)) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_WaitForGPUFences");
    }

    const auto* mapped = static_cast<const std::uint8_t*>(
        SDL_MapGPUTransferBuffer(device, transfer, false));
    if (!mapped) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_MapGPUTransferBuffer screenshot");
    }
    if (
        !raw_path.empty() &&
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            SDL_UnmapGPUTransferBuffer(device, transfer);
            SDL_ReleaseGPUFence(device, fence);
            SDL_ReleaseGPUTransferBuffer(device, transfer);
            throw std::runtime_error(
                "Unable to open HDR diagnostic output '" + raw_path + "'.");
        }
        for (std::uint32_t y = 0; y < height; ++y) {
            raw.write(
                reinterpret_cast<const char*>(
                    mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
                source_row_bytes);
        }
    }
    const std::uint32_t output_row_bytes = width * 4;
    std::vector<std::uint8_t> rgba(
        static_cast<std::size_t>(output_row_bytes) * height);
    const bool bgra =
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ||
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB;
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row = mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row =
            rgba.data() + static_cast<std::size_t>(y) * output_row_bytes;
        if (format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                for (std::uint32_t channel = 0; channel < 4; ++channel) {
                    destination_row[x * 4 + channel] =
                        half_to_byte(source_pixels[x * 4 + channel]);
                }
            }
        } else if (format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                destination_row[x * 4] = half_to_byte(source_pixels[x]);
                destination_row[x * 4 + 1] = 0;
                destination_row[x * 4 + 2] = 0;
                destination_row[x * 4 + 3] = 255;
            }
        } else {
            std::memcpy(destination_row, source_row, output_row_bytes);
            if (bgra) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    std::swap(
                        destination_row[x * 4],
                        destination_row[x * 4 + 2]);
                }
            }
        }
    }
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SDL_Surface* surface = SDL_CreateSurfaceFrom(
        static_cast<int>(width),
        static_cast<int>(height),
        SDL_PIXELFORMAT_RGBA32,
        rgba.data(),
        static_cast<int>(output_row_bytes));
    if (!surface) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_CreateSurfaceFrom screenshot");
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    SDL_ReleaseGPUFence(device, fence);
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    if (!saved) gpu_error("IMG_SavePNG screenshot");
}

inline SDL_GPUShader* load_shader(
    SDL_GPUDevice* device,
    const char* base_name,
    SDL_GPUShaderStage stage,
    std::uint32_t samplers,
    std::uint32_t uniform_buffers,
    const char* entrypoint_override = nullptr,
    std::uint32_t storage_buffers = 0) {
    const SDL_GPUShaderFormat supported = SDL_GetGPUShaderFormats(device);
    SDL_GPUShaderFormat format = SDL_GPU_SHADERFORMAT_INVALID;
    const char* extension = nullptr;
    const char* entrypoint = nullptr;
    if (supported & SDL_GPU_SHADERFORMAT_DXIL) {
        format = SDL_GPU_SHADERFORMAT_DXIL;
        extension = ".dxil";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_SPIRV) {
        format = SDL_GPU_SHADERFORMAT_SPIRV;
        extension = ".spv";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_MSL) {
        format = SDL_GPU_SHADERFORMAT_MSL;
        extension = ".msl";
        entrypoint = "main0";
    } else {
        throw std::runtime_error("SDL_GPU backend has no supported bblitec shader format.");
    }
    if (entrypoint_override) {
        entrypoint = entrypoint_override;
    }
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> code = read_binary_file(
        join_path(
            shader_root,
            std::string(base_name) + extension));
    SDL_GPUShaderCreateInfo info{};
    info.code_size = code.size();
    info.code = code.data();
    info.entrypoint = entrypoint;
    info.format = format;
    info.stage = stage;
    info.num_samplers = samplers;
    info.num_uniform_buffers = uniform_buffers;
    info.num_storage_buffers = storage_buffers;
    SDL_GPUShader* shader = SDL_CreateGPUShader(device, &info);
    if (!shader) gpu_error("SDL_CreateGPUShader");
    return shader;
}

inline SDL_GPUBuffer* upload_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBufferUsageFlags usage,
    const void* data,
    std::size_t size) {
    SDL_GPUBufferCreateInfo buffer_info{};
    buffer_info.usage = usage;
    buffer_info.size = static_cast<Uint32>(size);
    SDL_GPUBuffer* buffer = SDL_CreateGPUBuffer(device, &buffer_info);
    if (!buffer) gpu_error("SDL_CreateGPUBuffer");

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    SDL_GPUTransferBufferLocation source{transfer, 0};
    SDL_GPUBufferRegion destination{buffer, 0, static_cast<Uint32>(size)};
    SDL_UploadToGPUBuffer(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return buffer;
}

inline void update_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBuffer* buffer,
    const void* data,
    std::size_t size) {
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer =
        SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped =
        SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command =
        SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTransferBufferLocation source{transfer, 0};
    const SDL_GPUBufferRegion destination{
        buffer,
        0,
        static_cast<Uint32>(size),
    };
    SDL_UploadToGPUBuffer(
        copy,
        &source,
        &destination,
        true);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
    SDL_ReleaseGPUTransferBuffer(device, transfer);
}

inline SDL_GPUSampler* create_texture_sampler(
    SDL_GPUDevice* device,
    const TextureSamplerState& sampler) {
    const auto filter = [](TextureFilter value) {
        return value == TextureFilter::nearest
            ? SDL_GPU_FILTER_NEAREST
            : SDL_GPU_FILTER_LINEAR;
    };
    const auto address = [](TextureAddressMode value) {
        return value == TextureAddressMode::clamp
            ? SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE
            : value == TextureAddressMode::mirror
                ? SDL_GPU_SAMPLERADDRESSMODE_MIRRORED_REPEAT
                : SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    };
    SDL_GPUSamplerCreateInfo info{};
    info.min_filter = filter(sampler.min_filter);
    info.mag_filter = filter(sampler.mag_filter);
    info.mipmap_mode =
        sampler.mipmap_mode == TextureMipmapMode::nearest
            ? SDL_GPU_SAMPLERMIPMAPMODE_NEAREST
            : SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
    info.address_mode_u = address(sampler.address_u);
    info.address_mode_v = address(sampler.address_v);
    info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    info.max_anisotropy = sampler.max_anisotropy;
    info.max_lod = sampler.max_lod;
    info.enable_anisotropy = sampler.max_anisotropy > 1.0f;
    SDL_GPUSampler* result = SDL_CreateGPUSampler(device, &info);
    if (!result) gpu_error("SDL_CreateGPUSampler material texture");
    return result;
}

inline SDL_GPUTexture* upload_2d_texture(
    SDL_GPUDevice* device,
    const void* bytes,
    std::size_t byte_size,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureFormat format,
    const char* label) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = format;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error(label);

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(byte_size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error(label);
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error(label);
    std::memcpy(mapped, bytes, byte_size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error(label);
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureTransferInfo source{
        transfer, 0, width, height};
    const SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0,
        width, height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error(label);
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

} // namespace bbl::pal
