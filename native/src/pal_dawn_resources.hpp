#pragma once

#include <bblite/runtime.hpp>
#include <webgpu/webgpu.h>
#include <source_location>
#include <utility>

namespace bbl::pal {

/** Owns one API reference; raw construction and assignment adopt that reference. */
template <typename Handle, auto Release, auto AddRef = nullptr>
class DawnOwned {
public:
    DawnOwned() noexcept = default;
    explicit DawnOwned(Handle handle) noexcept : handle_(handle) {}
    DawnOwned(const DawnOwned&) = delete;
    DawnOwned& operator=(const DawnOwned&) = delete;
    DawnOwned(DawnOwned&& other) noexcept : handle_(other.release()) {}
    DawnOwned& operator=(DawnOwned&& other) noexcept {
        if (this != &other) reset(other.release());
        return *this;
    }
    DawnOwned& operator=(Handle handle) noexcept { reset(handle); return *this; }
    ~DawnOwned() { reset(); }

    [[nodiscard]] Handle get() const noexcept { return handle_; }
    operator Handle() const noexcept { return get(); }
    [[nodiscard]] Handle release() noexcept { return std::exchange(handle_, nullptr); }
    [[nodiscard]] DawnOwned retain() const noexcept requires (AddRef != nullptr) {
        if (handle_) AddRef(handle_);
        return DawnOwned{handle_};
    }
    void reset(Handle handle = nullptr) noexcept {
        if (auto previous = std::exchange(handle_, handle)) Release(previous);
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
};

template <typename Handle>
Handle require_dawn_resource(Handle handle, const char* label,
    std::source_location site = std::source_location::current()) {
    if (!handle) throw GpuTransportError(std::string(label) + " at " + site.file_name() + ":" + std::to_string(site.line()));
    return handle;
}

inline WGPUTextureView create_dawn_texture_view(
    WGPUTexture texture, const WGPUTextureViewDescriptor* descriptor,
    const char* label = "wgpuTextureCreateView",
    std::source_location site = std::source_location::current()) {
    require_dawn_resource(texture, "texture view source", site);
    return require_dawn_resource(wgpuTextureCreateView(texture, descriptor), label, site);
}

} // namespace bbl::pal
