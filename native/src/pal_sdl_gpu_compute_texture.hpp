#pragma once

#include "pal_sdl_gpu_resources.hpp"
#include <bblite/pal_compute_texture.hpp>
#include <stdexcept>
#include <string_view>

namespace bbl::pal {

struct SdlComputeTexture final : ComputeTextureAllocation {
    explicit SdlComputeTexture(SDL_GPUDevice* value) : device(value) {}
    SDL_GPUDevice* device;
    SDL_GPUTexture* texture = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    ~SdlComputeTexture() override { destroy(); }
    void destroy() override {
        if (texture)
            SDL_ReleaseGPUTexture(device, std::exchange(texture, nullptr));
        if (sampler)
            SDL_ReleaseGPUSampler(device, std::exchange(sampler, nullptr));
    }
};

inline SDL_GPUTextureFormat sdl_compute_texture_format(std::string_view value) {
    static constexpr std::pair<std::string_view, SDL_GPUTextureFormat> formats[] = {
        {"rgba8unorm", SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM},
        {"rgba8snorm", SDL_GPU_TEXTUREFORMAT_R8G8B8A8_SNORM},
        {"rgba16float", SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT},
        {"r32float", SDL_GPU_TEXTUREFORMAT_R32_FLOAT},
        {"rg32float", SDL_GPU_TEXTUREFORMAT_R32G32_FLOAT},
        {"rgba32float", SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT}};
    for (const auto& [name, format] : formats)
        if (value == name)
            return format;
    throw std::runtime_error("Unrepresented SDL compute texture format: " + std::string(value));
}

inline SDL_GPUSamplerAddressMode sdl_compute_address(std::string_view value) {
    if (value == "repeat")
        return SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    if (value == "mirror-repeat")
        return SDL_GPU_SAMPLERADDRESSMODE_MIRRORED_REPEAT;
    if (value == "clamp-to-edge")
        return SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    throw std::runtime_error("Invalid compute sampler address mode.");
}

inline void create_sdl_gpu_compute_texture(SDL_GPUDevice* device,
                                           const ComputeTextureDescriptor& options,
                                           ComputeTextureCreated complete) {
    std::shared_ptr<SdlComputeTexture> image;
    std::exception_ptr error;
    try {
        if (options.dimension != "2d")
            throw std::runtime_error("Native compute texture views currently require 2d.");
        if (options.storage_view_dimension != "2d" && options.storage_view_dimension != "2d-array")
            throw std::runtime_error("Unrepresented compute storage view dimension.");
        if (options.sampled_view_dimension != "2d" &&
            options.sampled_view_dimension != "2d-array" &&
            options.sampled_view_dimension != "cube")
            throw std::runtime_error("Unrepresented compute sampled view dimension.");
        const bool storage_array = options.storage_view_dimension == "2d-array";
        if (storage_array && !SDL_GetBooleanProperty(SDL_GetGPUDeviceProperties(device),
                                                     "bblite.gpu.storage_texture_array", false))
            throw std::runtime_error("SDL backend does not provide whole-array storage bindings.");
        SDL_GPUTextureCreateInfo info{};
        info.type = options.sampled_view_dimension == "cube" ? SDL_GPU_TEXTURETYPE_CUBE
                    : options.extent[2] > 1                  ? SDL_GPU_TEXTURETYPE_2D_ARRAY
                                                             : SDL_GPU_TEXTURETYPE_2D;
        info.format = sdl_compute_texture_format(options.format);
        info.width = options.extent[0];
        info.height = options.extent[1];
        info.layer_count_or_depth = options.extent[2];
        info.num_levels = options.mip_levels;
        info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        for (const auto& access : options.accesses) {
            if (access == "write-only")
                info.usage |= SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_WRITE;
            else if (access == "read-only")
                info.usage |= SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_READ;
            else if (access == "read-write")
                info.usage |= SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_SIMULTANEOUS_READ_WRITE;
            else
                throw std::runtime_error("Invalid compute storage texture access.");
        }
        if (options.sampled)
            info.usage |= SDL_GPU_TEXTUREUSAGE_SAMPLER;
        if (options.render_attachment)
            info.usage |= SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
        if (!SDL_GPUTextureSupportsFormat(device, info.format, info.type, info.usage))
            throw std::runtime_error(
                "SDL device does not support the requested compute texture usages.");
        image = std::make_shared<SdlComputeTexture>(device);
        auto release_properties = bbl::js::finally([&]() noexcept {
            if (info.props)
                SDL_DestroyProperties(info.props);
        });
        if (storage_array) {
            info.props = SDL_CreateProperties();
            if (!info.props ||
                !SDL_SetBooleanProperty(info.props, "bblite.gpu.texture.storage_array", true))
                throw std::runtime_error(SDL_GetError());
        }
        image->texture = SDL_CreateGPUTexture(device, &info);
        if (!image->texture)
            throw std::runtime_error(SDL_GetError());
        if (!options.label.empty())
            SDL_SetGPUTextureName(device, image->texture, options.label.c_str());
        if (options.sampled) {
            if (options.sample_type != "float" && options.sample_type != "unfilterable-float")
                throw std::runtime_error("Unrepresented native compute texture sample type.");
            if (options.sampler_type != "filtering" && options.sampler_type != "non-filtering")
                throw std::runtime_error("Unrepresented native compute sampler type.");
            SDL_GPUSamplerCreateInfo sampler{};
            sampler.address_mode_u = sdl_compute_address(options.sampler.address_u);
            sampler.address_mode_v = sdl_compute_address(options.sampler.address_v);
            sampler.address_mode_w = sdl_compute_address(options.sampler.address_w);
            sampler.min_filter = compute_filter_linear(options.sampler.min_filter)
                                     ? SDL_GPU_FILTER_LINEAR
                                     : SDL_GPU_FILTER_NEAREST;
            sampler.mag_filter = compute_filter_linear(options.sampler.mag_filter)
                                     ? SDL_GPU_FILTER_LINEAR
                                     : SDL_GPU_FILTER_NEAREST;
            sampler.mipmap_mode = compute_filter_linear(options.sampler.mip_filter)
                                      ? SDL_GPU_SAMPLERMIPMAPMODE_LINEAR
                                      : SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
            sampler.enable_anisotropy = options.sampler.anisotropy > 1;
            sampler.max_anisotropy = static_cast<float>(options.sampler.anisotropy);
            sampler.max_lod = 32.0f; // WebGPU's GPUSamplerDescriptor default.
            image->sampler = SDL_CreateGPUSampler(device, &sampler);
            if (!image->sampler)
                throw std::runtime_error(SDL_GetError());
        }
    } catch (...) {
        error = std::current_exception();
        image.reset();
    }
    complete(std::move(image), error);
}

} // namespace bbl::pal
