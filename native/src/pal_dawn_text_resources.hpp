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
    TextGpuCapture capture;

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
    std::uint64_t capture_id = 0;

    ~DawnTextLease() { retire(); }
    void destroy() noexcept {
        if constexpr (Destroy != nullptr) {
            if (handle && !destroyed) Destroy(handle);
        }
        if (!destroyed && capture_id) owner->capture.destroy(capture_id);
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
struct DawnTextPipelineLease : DawnTextLease<WGPURenderPipeline, wgpuRenderPipelineRelease> {
    TextGpuDrawCapture capture;
};

template<class Lease, class Handle>
std::shared_ptr<Lease> retain_dawn_text_resource(const std::shared_ptr<DawnTextDevice>& owner, Handle handle,
    std::string_view role = {}, std::size_t bytes = 0, std::size_t width = 0, std::size_t rows = 0) {
    if (!handle) throw std::runtime_error("Text GPU resource creation failed.");
    auto lease = std::make_shared<Lease>();
    lease->owner = owner;
    lease->handle = handle;
    if (owner->capture.enabled() && !role.empty()) lease->capture_id = owner->capture.create_resource(role, bytes, width, rows);
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
    std::vector<TextGpuBindingCapture> bindings;
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
    std::shared_ptr<DawnTextPipelineLease> current_pipeline;
    std::shared_ptr<DawnTextGroup> current_group;
    std::shared_ptr<DawnTextBufferLease> current_quad, current_instances;

    explicit DawnTextResourceOps(std::shared_ptr<DawnTextDevice> device) : owner(std::move(device)) {}

    DawnTextBuffer create_buffer(WGPUBufferUsage usage, std::size_t bytes, std::string_view role = "buffer") {
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = bytes;
        descriptor.usage = usage | WGPUBufferUsage_CopyDst;
        return {retain_dawn_text_resource<DawnTextBufferLease>(owner,
            wgpuDeviceCreateBuffer(owner->device, &descriptor), role, bytes), bytes};
    }

    void create_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t bytes) {
        if (!gpu.backend) gpu.backend = std::make_shared<DawnTextRenderableResources>();
        auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        const auto usage = kind == TextBufferKind::uniform ? WGPUBufferUsage_Uniform
            : kind == TextBufferKind::instances ? WGPUBufferUsage_Vertex : WGPUBufferUsage_Storage;
        auto& buffer = dawn_text_buffer(*resources, kind);
        buffer = create_buffer(usage, bytes, kind == TextBufferKind::uniform ? "uniform" :
            kind == TextBufferKind::instances ? "instances" : "styles");
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
            wgpuDeviceCreateTexture(owner->device, &descriptor), kind == TextAtlasTextureKind::curves ? "curves" : "bands",
            width * rows * 4u * sizeof(float), width, rows);
        texture.view = retain_dawn_text_resource<DawnTextViewLease>(owner,
            wgpuTextureCreateView(texture.texture->get(), nullptr), "texture-view");
        auto destroy = [lease = texture.texture] { lease->destroy(); };
        if (kind == TextAtlasTextureKind::curves) atlas.destroy_curves = destroy;
        else atlas.destroy_bands = destroy;
    }

    void create_atlas_metadata(TextAtlasGpuState& atlas, std::size_t bytes) {
        if (!atlas.backend) atlas.backend = std::make_shared<DawnTextAtlasResources>();
        auto resources = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        resources->metadata = create_buffer(WGPUBufferUsage_Storage, bytes, "metadata");
        atlas.destroy_metadata = [lease = resources->metadata.lease] { lease->destroy(); };
    }

    void write_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t offset,
        std::span<const std::uint8_t> bytes) {
        const auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        const auto& buffer = dawn_text_buffer(*resources, kind);
        wgpuQueueWriteBuffer(owner->queue, buffer.lease->get(), offset, bytes.data(), bytes.size());
        owner->capture.write(buffer.lease->capture_id, offset, bytes);
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
        owner->capture.write(texture.texture->capture_id, 0u, bytes);
    }

    void write_atlas_metadata(TextAtlasGpuState& atlas, std::span<const std::uint8_t> bytes) {
        const auto resources = std::static_pointer_cast<DawnTextAtlasResources>(atlas.backend);
        wgpuQueueWriteBuffer(owner->queue, resources->metadata.lease->get(), 0u, bytes.data(), bytes.size());
        owner->capture.write(resources->metadata.lease->capture_id, 0u, bytes);
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
            if (owner->capture.enabled()) {
                TextGpuBindingCapture receipt;
                receipt.binding = row.binding; receipt.role = text_binding_role_name(row.role);
                if (buffer) receipt.resource = buffer->lease->capture_id;
                else {
                    const auto& texture = row.role == TextBindingRole::curves ? result->curves : result->bands;
                    receipt.resource = texture.texture->capture_id; receipt.view = texture.view->capture_id;
                }
                result->bindings.push_back(std::move(receipt));
            }
        }
        WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        descriptor.layout = layout->layout->get();
        descriptor.entryCount = entries.size();
        descriptor.entries = entries.data();
        result->group = retain_dawn_text_resource<DawnTextGroupLease>(owner,
            wgpuDeviceCreateBindGroup(owner->device, &descriptor), "bind-group");
        return result;
    }

    void set_quad_vertex_buffer(const std::shared_ptr<void>& quad) {
        const auto buffer = std::static_pointer_cast<DawnTextBuffer>(quad);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0u, buffer->lease->get(), 0u, WGPU_WHOLE_SIZE);
        if (owner->capture.enabled()) current_quad = buffer->lease;
    }
    void set_instance_vertex_buffer(const TextGpuState& gpu) {
        const auto resources = std::static_pointer_cast<DawnTextRenderableResources>(gpu.backend);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 1u, resources->instances.lease->get(), 0u, WGPU_WHOLE_SIZE);
        if (owner->capture.enabled()) current_instances = resources->instances.lease;
    }
    void set_pipeline(const std::shared_ptr<void>& pipeline) {
        const auto value = std::static_pointer_cast<DawnTextPipelineLease>(pipeline);
        wgpuRenderPassEncoderSetPipeline(pass, value->get());
        if (owner->capture.enabled()) current_pipeline = value;
    }
    void set_bind_group(const std::shared_ptr<void>& group) {
        const auto value = std::static_pointer_cast<DawnTextGroup>(group);
        wgpuRenderPassEncoderSetBindGroup(pass, 0u, value->group->get(), 0u, nullptr);
        if (owner->capture.enabled()) current_group = value;
    }
    void draw(std::size_t vertices, std::size_t instances, std::size_t first_vertex, std::size_t first_instance) {
        wgpuRenderPassEncoderDraw(pass, text_gpu_u32(vertices), text_gpu_u32(instances), text_gpu_u32(first_vertex), text_gpu_u32(first_instance));
        if (owner->capture.enabled()) {
            auto receipt = current_pipeline->capture;
            receipt.pipeline = current_pipeline->capture_id; receipt.group = current_group->group->capture_id;
            receipt.quad = current_quad->capture_id; receipt.instances = current_instances->capture_id;
            receipt.bindings = current_group->bindings;
            receipt.vertices = text_gpu_u32(vertices); receipt.instance_count = text_gpu_u32(instances);
            receipt.first_vertex = text_gpu_u32(first_vertex); receipt.first_instance = text_gpu_u32(first_instance);
            owner->capture.draw(std::move(receipt));
        }
    }
};

} // namespace bbl::pal
