#pragma once

#include <bblite/text.hpp>

#include <webgpu/webgpu.h>
#include "pal_text_resources.hpp"

#include <memory>
#include <span>
#include <utility>

namespace bbl::pal {

struct DawnTextDevice {
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    TextResourceRetirement resources;

    void retire() noexcept {
        resources.retire();
        device = nullptr;
        queue = nullptr;
    }
};

template<class Handle, auto Release, auto Destroy = nullptr>
struct DawnTextLease {
    std::shared_ptr<DawnTextDevice> owner;
    Handle handle = nullptr;
    bool destroyed = false;

    ~DawnTextLease() { retire(); }
    void destroy() noexcept {
        if constexpr (Destroy != nullptr) {
            if (handle && !destroyed) Destroy(handle);
        }
        destroyed = true;
    }
    void retire() noexcept {
        destroy();
        if (handle) Release(std::exchange(handle, nullptr));
    }
    Handle get() const {
        if (!handle || destroyed) throw std::runtime_error("Text GPU resource was destroyed.");
        return handle;
    }
};

using DawnTextBufferLease = DawnTextLease<WGPUBuffer, wgpuBufferRelease, wgpuBufferDestroy>;
using DawnTextTextureLease = DawnTextLease<WGPUTexture, wgpuTextureRelease, wgpuTextureDestroy>;
using DawnTextViewLease = DawnTextLease<WGPUTextureView, wgpuTextureViewRelease>;
using DawnTextGroupLease = DawnTextLease<WGPUBindGroup, wgpuBindGroupRelease>;
using DawnTextLayoutLease = DawnTextLease<WGPUBindGroupLayout, wgpuBindGroupLayoutRelease>;
using DawnTextPipelineLease = DawnTextLease<WGPURenderPipeline, wgpuRenderPipelineRelease>;

template<class Lease, class Handle>
std::shared_ptr<Lease> retain_dawn_text_resource(const std::shared_ptr<DawnTextDevice>& owner, Handle handle) {
    if (!handle) throw std::runtime_error("Text GPU resource creation failed.");
    auto lease = std::make_shared<Lease>();
    lease->owner = owner;
    lease->handle = handle;
    owner->resources.track(lease);
    return lease;
}

struct DawnTextBuffer {
    std::shared_ptr<DawnTextBufferLease> lease;
    std::size_t bytes = 0;
};
struct DawnTextTexture {
    std::shared_ptr<DawnTextTextureLease> texture;
    std::shared_ptr<DawnTextViewLease> view;
};
struct DawnTextRenderableResources {
    DawnTextBuffer uniform, instances, styles;
};
struct DawnTextAtlasResources {
    DawnTextTexture curves, bands;
    DawnTextBuffer metadata;
};
using DawnTextBindingRole = TextBindingRole;
struct DawnTextBinding {
    std::uint32_t binding = 0;
    DawnTextBindingRole role = DawnTextBindingRole::uniform;
};
struct DawnTextLayout {
    std::shared_ptr<DawnTextLayoutLease> layout;
    std::vector<DawnTextBinding> bindings;
};
struct DawnTextGroup {
    std::shared_ptr<DawnTextGroupLease> group;
    // Keep exactly the resources captured by the data-owned bind group.
    DawnTextBuffer uniform, styles, metadata;
    DawnTextTexture curves, bands;
};

inline DawnTextBuffer& dawn_text_buffer(DawnTextRenderableResources& resources, TextBufferKind kind) {
    switch (kind) {
        case TextBufferKind::uniform: return resources.uniform;
        case TextBufferKind::instances: return resources.instances;
        case TextBufferKind::styles: return resources.styles;
    }
    throw std::runtime_error("Unknown text buffer role.");
}

/** Native resource operations borrowed synchronously by the generated text lifecycle. */
struct DawnTextResourceOps {
    std::shared_ptr<DawnTextDevice> owner;
    WGPURenderPassEncoder pass = nullptr;

    DawnTextBuffer create_buffer(WGPUBufferUsage usage, std::size_t bytes) {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = bytes;
        descriptor.usage = usage | WGPUBufferUsage_CopyDst;
        return {retain_dawn_text_resource<DawnTextBufferLease>(owner,
            wgpuDeviceCreateBuffer(owner->device, &descriptor)), bytes};
    }

    void create_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t bytes) {
        if (!gpu.backend) gpu.backend = std::make_shared<DawnTextRenderableResources>();
        auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        const auto usage = kind == TextBufferKind::uniform ? WGPUBufferUsage_Uniform
            : kind == TextBufferKind::instances ? WGPUBufferUsage_Vertex : WGPUBufferUsage_Storage;
        auto& buffer = dawn_text_buffer(*resources, kind);
        buffer = create_buffer(usage, bytes);
        auto destroy = [lease = buffer.lease] { lease->destroy(); };
        switch (kind) {
            case TextBufferKind::uniform: gpu.destroy_uniform = destroy; break;
            case TextBufferKind::instances: gpu.destroy_instances = destroy; break;
            case TextBufferKind::styles: gpu.destroy_styles = destroy; break;
        }
    }

    void create_atlas_texture(TextAtlasGpuState& atlas, TextAtlasTextureKind kind, std::size_t width, std::size_t rows) {
        if (!atlas.backend) atlas.backend = std::make_shared<DawnTextAtlasResources>();
        auto resources = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        auto& texture = kind == TextAtlasTextureKind::curves ? resources->curves : resources->bands;
        WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
        descriptor.dimension = WGPUTextureDimension_2D;
        descriptor.size = WGPUExtent3D{text_gpu_u32(width), text_gpu_u32(rows), 1u};
        descriptor.format = WGPUTextureFormat_RGBA32Float;
        descriptor.usage = WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc | WGPUTextureUsage_TextureBinding;
        texture.texture = retain_dawn_text_resource<DawnTextTextureLease>(owner,
            wgpuDeviceCreateTexture(owner->device, &descriptor));
        texture.view = retain_dawn_text_resource<DawnTextViewLease>(owner,
            wgpuTextureCreateView(texture.texture->get(), nullptr));
        auto destroy = [lease = texture.texture] { lease->destroy(); };
        if (kind == TextAtlasTextureKind::curves) atlas.destroy_curves = destroy;
        else atlas.destroy_bands = destroy;
    }

    void create_atlas_metadata(TextAtlasGpuState& atlas, std::size_t bytes) {
        if (!atlas.backend) atlas.backend = std::make_shared<DawnTextAtlasResources>();
        auto resources = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        resources->metadata = create_buffer(WGPUBufferUsage_Storage, bytes);
        atlas.destroy_metadata = [lease = resources->metadata.lease] { lease->destroy(); };
    }

    void write_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t offset,
        std::span<const std::uint8_t> bytes) {
        const auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        const auto& buffer = dawn_text_buffer(*resources, kind);
        wgpuQueueWriteBuffer(owner->queue, buffer.lease->get(), offset, bytes.data(), bytes.size());
    }

    void write_atlas_texture(TextAtlasGpuState& atlas, TextAtlasTextureKind kind, std::span<const std::uint8_t> bytes,
        std::size_t bytes_per_row, std::size_t width, std::size_t rows) {
        const auto resources = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        const auto& texture = kind == TextAtlasTextureKind::curves ? resources->curves : resources->bands;
        WGPUTexelCopyTextureInfo target = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        target.texture = texture.texture->get();
        WGPUTexelCopyBufferLayout layout{};
        layout.bytesPerRow = text_gpu_u32(bytes_per_row);
        layout.rowsPerImage = text_gpu_u32(rows);
        const WGPUExtent3D extent{text_gpu_u32(width), text_gpu_u32(rows), 1u};
        wgpuQueueWriteTexture(owner->queue, &target, bytes.data(), bytes.size(), &layout, &extent);
    }

    void write_atlas_metadata(TextAtlasGpuState& atlas, std::span<const std::uint8_t> bytes) {
        const auto resources = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        wgpuQueueWriteBuffer(owner->queue, resources->metadata.lease->get(), 0u, bytes.data(), bytes.size());
    }

    std::shared_ptr<void> create_bind_group(const TextGpuState& gpu, const TextAtlasGpuState& atlas, const std::shared_ptr<void>& opaque_layout) {
        const auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        const auto textures = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        const auto layout = std::static_pointer_cast<DawnTextLayout>(opaque_layout);
        auto result = std::make_shared<DawnTextGroup>();
        result->uniform = resources->uniform;
        result->styles = resources->styles;
        result->metadata = textures->metadata;
        result->curves = textures->curves;
        result->bands = textures->bands;
        std::vector<WGPUBindGroupEntry> entries;
        for (const auto& row : layout->bindings) {
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = row.binding;
            const DawnTextBuffer* buffer = nullptr;
            switch (row.role) {
                case DawnTextBindingRole::uniform: buffer = &result->uniform; break;
                case DawnTextBindingRole::styles: buffer = &result->styles; break;
                case DawnTextBindingRole::metadata: buffer = &result->metadata; break;
                case DawnTextBindingRole::curves: entry.textureView = result->curves.view->get(); break;
                case DawnTextBindingRole::bands: entry.textureView = result->bands.view->get(); break;
            }
            if (buffer) { entry.buffer = buffer->lease->get(); entry.size = buffer->bytes; }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layout->layout->get();
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        result->group = retain_dawn_text_resource<DawnTextGroupLease>(owner,
            wgpuDeviceCreateBindGroup(owner->device, &descriptor));
        return result;
    }

    void set_quad_vertex_buffer(const std::shared_ptr<void>& quad) {
        const auto buffer = std::static_pointer_cast<DawnTextBuffer>(quad);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0u, buffer->lease->get(), 0u, WGPU_WHOLE_SIZE);
    }
    void set_instance_vertex_buffer(const TextGpuState& gpu) {
        const auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 1u, resources->instances.lease->get(), 0u, WGPU_WHOLE_SIZE);
    }
    void set_pipeline(const std::shared_ptr<void>& pipeline) {
        wgpuRenderPassEncoderSetPipeline(pass, std::static_pointer_cast<DawnTextPipelineLease>(pipeline)->get());
    }
    void set_bind_group(const std::shared_ptr<void>& group) {
        wgpuRenderPassEncoderSetBindGroup(pass, 0u, std::static_pointer_cast<DawnTextGroup>(group)->group->get(), 0u, nullptr);
    }
    void draw(std::size_t vertices, std::size_t instances, std::size_t first_vertex, std::size_t first_instance) {
        wgpuRenderPassEncoderDraw(pass, text_gpu_u32(vertices), text_gpu_u32(instances), text_gpu_u32(first_vertex), text_gpu_u32(first_instance));
    }
};

} // namespace bbl::pal
