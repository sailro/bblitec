#pragma once

#include <bblite/runtime.hpp>
#include <bblite/gpu.hpp>
#include <webgpu/webgpu.h>
#include <source_location>
#include <utility>

namespace bbl::pal {

/** Terminal Dawn transports; both owned resources and borrowed PAL destinations use them. */
inline void write_dawn_gpu_buffer(WGPUQueue queue, WGPUBuffer buffer, std::size_t offset,
                                  std::span<const std::uint8_t> bytes) {
    if (!buffer || !queue)
        throw std::runtime_error("Dawn buffer write has no resource.");
    wgpuQueueWriteBuffer(queue, buffer, offset, bytes.data(), bytes.size());
}
inline void write_dawn_gpu_texture(WGPUQueue queue, const WGPUTexelCopyTextureInfo& texture,
                                   std::span<const std::uint8_t> bytes,
                                   const GpuTextureWriteLayout& source,
                                   const GpuWriteExtent& extent) {
    if (!texture.texture || !queue)
        throw std::runtime_error("Dawn texture write has no resource.");
    WGPUTexelCopyBufferLayout native{};
    native.offset = source.offset;
    native.bytesPerRow = source.bytes_per_row.value_or(WGPU_COPY_STRIDE_UNDEFINED);
    native.rowsPerImage = source.rows_per_image.value_or(WGPU_COPY_STRIDE_UNDEFINED);
    const WGPUExtent3D dimensions{extent.width, extent.height, extent.depth_or_array_layers};
    wgpuQueueWriteTexture(queue, &texture, bytes.data(), bytes.size(), &native, &dimensions);
}
struct DawnBufferDestination final : GpuObject {
    WGPUQueue queue;
    WGPUBuffer buffer;
    DawnBufferDestination(WGPUQueue owner, WGPUBuffer value) : queue(owner), buffer(value) {}
    const void* device_identity() const override { return queue; }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        write_dawn_gpu_buffer(queue, buffer, offset, bytes);
    }
};
struct DawnTextureDestination final : GpuObject {
    WGPUQueue queue;
    WGPUTexelCopyTextureInfo texture;
    DawnTextureDestination(WGPUQueue owner, const WGPUTexelCopyTextureInfo& value)
        : queue(owner), texture(value) {}
    const void* device_identity() const override { return queue; }
    void write_texture_bytes(std::span<const std::uint8_t> bytes,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        write_dawn_gpu_texture(queue, texture, bytes, layout, extent);
    }
};
/** A WebGPU device view over Dawn's queue; destinations remain owned by their callers. */
struct DawnGpuDevice : GpuDevice {
    WGPUQueue queue;
    explicit DawnGpuDevice(WGPUQueue value) : queue(value) {}
    const void* device_identity() const override { return queue; }
    using GpuDevice::write_buffer;
    using GpuDevice::write_texture;
    void write_buffer(WGPUBuffer buffer, std::size_t offset, const void* data, std::size_t count) {
        if (!data && count)
            throw std::runtime_error("Dawn buffer write has no source bytes.");
        DawnBufferDestination destination{queue, buffer};
        GpuDevice::write_buffer(destination, offset,
                                {static_cast<const std::uint8_t*>(data), count});
    }
    void write_texture(const WGPUTexelCopyTextureInfo* texture, const void* data, std::size_t count,
                       const WGPUTexelCopyBufferLayout* layout, const WGPUExtent3D* extent) {
        if (!texture || !layout || !extent || (!data && count))
            throw std::runtime_error("Dawn texture write has no descriptor or source bytes.");
        DawnTextureDestination destination{queue, *texture};
        GpuTextureWriteLayout source{static_cast<std::size_t>(layout->offset), {}, {}};
        if (layout->bytesPerRow != WGPU_COPY_STRIDE_UNDEFINED)
            source.bytes_per_row = layout->bytesPerRow;
        if (layout->rowsPerImage != WGPU_COPY_STRIDE_UNDEFINED)
            source.rows_per_image = layout->rowsPerImage;
        GpuDevice::write_texture(destination, {static_cast<const std::uint8_t*>(data), count},
                                 source,
                                 {extent->width, extent->height, extent->depthOrArrayLayers});
    }
};

inline std::string view_text(WGPUStringView view) {
    if (!view.data)
        return {};
    return view.length == WGPU_STRLEN ? std::string(view.data)
                                      : std::string(view.data, view.length);
}

/** Owns one API reference; raw construction and assignment adopt that reference. */
template <typename Handle, auto Release, auto AddRef = nullptr> class DawnOwned {
public:
    DawnOwned() noexcept = default;
    explicit DawnOwned(Handle handle) noexcept : handle_(handle) {}
    DawnOwned(const DawnOwned&) = delete;
    DawnOwned& operator=(const DawnOwned&) = delete;
    DawnOwned(DawnOwned&& other) noexcept : handle_(other.release()) {}
    DawnOwned& operator=(DawnOwned&& other) noexcept {
        if (this != &other)
            reset(other.release());
        return *this;
    }
    DawnOwned& operator=(Handle handle) noexcept {
        reset(handle);
        return *this;
    }
    ~DawnOwned() { reset(); }

    [[nodiscard]] Handle get() const noexcept { return handle_; }
    operator Handle() const noexcept { return get(); }
    [[nodiscard]] Handle release() noexcept { return std::exchange(handle_, nullptr); }
    [[nodiscard]] DawnOwned retain() const noexcept
        requires(AddRef != nullptr)
    {
        if (handle_)
            AddRef(handle_);
        return DawnOwned{handle_};
    }
    void reset(Handle handle = nullptr) noexcept {
        if (auto previous = std::exchange(handle_, handle))
            Release(previous);
    }

private:
    Handle handle_ = nullptr;
};

using DawnTexture = DawnOwned<WGPUTexture, wgpuTextureRelease, wgpuTextureAddRef>;
using DawnTextureView = DawnOwned<WGPUTextureView, wgpuTextureViewRelease, wgpuTextureViewAddRef>;
using DawnSampler = DawnOwned<WGPUSampler, wgpuSamplerRelease>;
using DawnBuffer = DawnOwned<WGPUBuffer, wgpuBufferRelease>;
using DawnShaderModule = DawnOwned<WGPUShaderModule, wgpuShaderModuleRelease>;
using DawnBindGroup = DawnOwned<WGPUBindGroup, wgpuBindGroupRelease>;
using DawnBindGroupLayout = DawnOwned<WGPUBindGroupLayout, wgpuBindGroupLayoutRelease>;
using DawnPipelineLayout = DawnOwned<WGPUPipelineLayout, wgpuPipelineLayoutRelease>;
using DawnRenderPipeline = DawnOwned<WGPURenderPipeline, wgpuRenderPipelineRelease>;
using DawnCommandEncoder = DawnOwned<WGPUCommandEncoder, wgpuCommandEncoderRelease>;
using DawnCommandBuffer = DawnOwned<WGPUCommandBuffer, wgpuCommandBufferRelease>;
using DawnRenderPass = DawnOwned<WGPURenderPassEncoder, wgpuRenderPassEncoderRelease>;

inline void submit_dawn_command(WGPUQueue queue, WGPUCommandBuffer command) {
    wgpuQueueSubmit(queue, 1, &command);
}

struct DawnSampledTexture {
    DawnTexture texture;
    DawnTextureView view;
    DawnSampler sampler;
    std::uint64_t uploaded_version = 0;
    std::shared_ptr<GpuTextureLease> borrowed_image;
};

template <typename Handle>
Handle require_dawn_resource(Handle handle, const char* label,
                             std::source_location site = std::source_location::current()) {
    if (!handle)
        throw GpuTransportError(std::string(label) + " at " + site.file_name() + ":" +
                                std::to_string(site.line()));
    return handle;
}

inline WGPUTextureView
create_dawn_texture_view(WGPUTexture texture, const WGPUTextureViewDescriptor* descriptor,
                         const char* label = "wgpuTextureCreateView",
                         std::source_location site = std::source_location::current()) {
    require_dawn_resource(texture, "texture view source", site);
    return require_dawn_resource(wgpuTextureCreateView(texture, descriptor), label, site);
}

} // namespace bbl::pal
