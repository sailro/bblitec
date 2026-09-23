#pragma once

#include "pal_dawn_resources.hpp"
#include <bblite/pal_compute_texture.hpp>
#include <stdexcept>
#include <utility>

namespace bbl::pal {

struct DawnComputeTexture final : ComputeTextureAllocation {
    DawnTexture texture;
    DawnTextureView storage_view;
    DawnTextureView sampled_view;
    DawnSampler sampler;
    ~DawnComputeTexture() override { destroy(); }
    void destroy() override {
        if (texture) {
            wgpuTextureDestroy(texture);
            texture = {};
        }
        storage_view = {};
        sampled_view = {};
        sampler = {};
    }
};

inline WGPUTextureFormat dawn_compute_texture_format(std::string_view value) {
    static constexpr std::pair<std::string_view, WGPUTextureFormat> formats[] = {
        {"rgba8unorm", WGPUTextureFormat_RGBA8Unorm},
        {"rgba8snorm", WGPUTextureFormat_RGBA8Snorm},
        {"rgba16float", WGPUTextureFormat_RGBA16Float},
        {"r32float", WGPUTextureFormat_R32Float},
        {"rg32float", WGPUTextureFormat_RG32Float},
        {"rgba32float", WGPUTextureFormat_RGBA32Float}};
    for (const auto& [name, format] : formats)
        if (name == value)
            return format;
    throw std::runtime_error("Unrepresented Dawn compute texture format: " + std::string(value));
}

inline WGPUAddressMode dawn_compute_address(std::string_view value) {
    if (value == "repeat")
        return WGPUAddressMode_Repeat;
    if (value == "mirror-repeat")
        return WGPUAddressMode_MirrorRepeat;
    if (value == "clamp-to-edge")
        return WGPUAddressMode_ClampToEdge;
    throw std::runtime_error("Invalid compute sampler address mode.");
}

inline WGPUTextureViewDimension dawn_compute_allocation_view(std::string_view value) {
    if (value == "2d")
        return WGPUTextureViewDimension_2D;
    if (value == "2d-array")
        return WGPUTextureViewDimension_2DArray;
    if (value == "cube")
        return WGPUTextureViewDimension_Cube;
    throw std::runtime_error("Unrepresented compute allocation view dimension.");
}

inline void create_dawn_compute_texture(WGPUDevice device, const ComputeTextureDescriptor& options,
                                        ComputeTextureCreated complete) {
    if (options.dimension != "2d")
        throw std::runtime_error("Native compute texture views currently require 2d.");
    if (options.storage_view_dimension != "2d" && options.storage_view_dimension != "2d-array")
        throw std::runtime_error("Unrepresented compute storage view dimension.");
    const auto format = dawn_compute_texture_format(options.format);
    struct Pending {
        std::shared_ptr<DawnComputeTexture> image = std::make_shared<DawnComputeTexture>();
        ComputeTextureCreated complete;
        std::exception_ptr creation_error;
    };
    auto pending = std::make_unique<Pending>();
    pending->complete = std::move(complete);
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    try {
        auto& image = *pending->image;
        WGPUTextureDescriptor info = WGPU_TEXTURE_DESCRIPTOR_INIT;
        info.label = {options.label.data(), options.label.size()};
        info.size = {options.extent[0], options.extent[1], options.extent[2]};
        info.dimension = WGPUTextureDimension_2D;
        info.format = format;
        info.mipLevelCount = options.mip_levels;
        info.usage =
            WGPUTextureUsage_StorageBinding | WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
        if (options.sampled)
            info.usage |= WGPUTextureUsage_TextureBinding;
        if (options.render_attachment)
            info.usage |= WGPUTextureUsage_RenderAttachment;
        image.texture = DawnTexture{wgpuDeviceCreateTexture(device, &info)};
        if (!image.texture)
            throw std::runtime_error("Dawn compute texture allocation failed.");
        WGPUTextureViewDescriptor view = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        view.dimension = dawn_compute_allocation_view(options.storage_view_dimension);
        view.arrayLayerCount = options.storage_view_dimension == "2d" ? 1 : options.extent[2];
        view.mipLevelCount = 1;
        image.storage_view = DawnTextureView{wgpuTextureCreateView(image.texture, &view)};
        for (const auto& access : options.accesses) {
            WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entry.visibility = WGPUShaderStage_Compute;
            entry.storageTexture.format = format;
            entry.storageTexture.viewDimension = view.dimension;
            if (access == "write-only")
                entry.storageTexture.access = WGPUStorageTextureAccess_WriteOnly;
            else if (access == "read-only")
                entry.storageTexture.access = WGPUStorageTextureAccess_ReadOnly;
            else if (access == "read-write")
                entry.storageTexture.access = WGPUStorageTextureAccess_ReadWrite;
            else
                throw std::runtime_error("Invalid compute storage texture access.");
            WGPUBindGroupLayoutDescriptor layout_info = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
            layout_info.entryCount = 1;
            layout_info.entries = &entry;
            DawnBindGroupLayout layout{wgpuDeviceCreateBindGroupLayout(device, &layout_info)};
            WGPUBindGroupEntry binding = WGPU_BIND_GROUP_ENTRY_INIT;
            binding.textureView = image.storage_view;
            WGPUBindGroupDescriptor bind_info = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            bind_info.layout = layout;
            bind_info.entryCount = 1;
            bind_info.entries = &binding;
            DawnBindGroup validation{wgpuDeviceCreateBindGroup(device, &bind_info)};
        }
        if (options.sampled) {
            view.dimension = dawn_compute_allocation_view(options.sampled_view_dimension);
            view.arrayLayerCount = options.sampled_view_dimension == "2d" ? 1 : options.extent[2];
            view.mipLevelCount = options.mip_levels;
            image.sampled_view = DawnTextureView{wgpuTextureCreateView(image.texture, &view)};
            WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
            sampler.addressModeU = dawn_compute_address(options.sampler.address_u);
            sampler.addressModeV = dawn_compute_address(options.sampler.address_v);
            sampler.addressModeW = dawn_compute_address(options.sampler.address_w);
            sampler.minFilter = compute_filter_linear(options.sampler.min_filter)
                                    ? WGPUFilterMode_Linear
                                    : WGPUFilterMode_Nearest;
            sampler.magFilter = compute_filter_linear(options.sampler.mag_filter)
                                    ? WGPUFilterMode_Linear
                                    : WGPUFilterMode_Nearest;
            sampler.mipmapFilter = compute_filter_linear(options.sampler.mip_filter)
                                       ? WGPUMipmapFilterMode_Linear
                                       : WGPUMipmapFilterMode_Nearest;
            sampler.maxAnisotropy = options.sampler.anisotropy;
            image.sampler = DawnSampler{wgpuDeviceCreateSampler(device, &sampler)};
            WGPUBindGroupLayoutEntry entries[2] = {WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT,
                                                   WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT};
            entries[0].visibility = WGPUShaderStage_Compute;
            entries[0].texture.viewDimension = view.dimension;
            if (options.sample_type == "float")
                entries[0].texture.sampleType = WGPUTextureSampleType_Float;
            else if (options.sample_type == "unfilterable-float")
                entries[0].texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
            else
                throw std::runtime_error("Unrepresented native compute texture sample type.");
            entries[1].binding = 1;
            entries[1].visibility = WGPUShaderStage_Compute;
            if (options.sampler_type == "filtering")
                entries[1].sampler.type = WGPUSamplerBindingType_Filtering;
            else if (options.sampler_type == "non-filtering")
                entries[1].sampler.type = WGPUSamplerBindingType_NonFiltering;
            else
                throw std::runtime_error("Unrepresented native compute sampler type.");
            WGPUBindGroupLayoutDescriptor layout_info = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
            layout_info.entryCount = 2;
            layout_info.entries = entries;
            DawnBindGroupLayout layout{wgpuDeviceCreateBindGroupLayout(device, &layout_info)};
            WGPUBindGroupEntry bindings[2] = {WGPU_BIND_GROUP_ENTRY_INIT,
                                              WGPU_BIND_GROUP_ENTRY_INIT};
            bindings[0].textureView = image.sampled_view;
            bindings[1].binding = 1;
            bindings[1].sampler = image.sampler;
            WGPUBindGroupDescriptor bind_info = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            bind_info.layout = layout;
            bind_info.entryCount = 2;
            bind_info.entries = bindings;
            DawnBindGroup validation{wgpuDeviceCreateBindGroup(device, &bind_info)};
        }
    } catch (...) {
        pending->creation_error = std::current_exception();
    }
    WGPUPopErrorScopeCallbackInfo callback = WGPU_POP_ERROR_SCOPE_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_AllowSpontaneous;
    callback.userdata1 = pending.release();
    callback.callback = [](WGPUPopErrorScopeStatus status, WGPUErrorType type,
                           WGPUStringView message, void* userdata, void*) {
        std::unique_ptr<Pending> owner(static_cast<Pending*>(userdata));
        auto error = owner->creation_error;
        if (!error &&
            (status != WGPUPopErrorScopeStatus_Success || type != WGPUErrorType_NoError)) {
            const std::string detail = message.data ? view_text(message) : "GPU validation failed";
            error = std::make_exception_ptr(ComputeTextureValidationError(detail));
        }
        owner->complete(owner->image, error);
    };
    wgpuDevicePopErrorScope(device, callback);
}

} // namespace bbl::pal
