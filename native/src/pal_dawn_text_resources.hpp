#pragma once

#include "pal_gpu_frame.hpp"
#include <bblite/text.hpp>

#include <webgpu/webgpu.h>
#include "pal_text_resources.hpp"
#include "pal_dawn_resources.hpp"

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

template <class Handle, auto Release, auto Destroy = nullptr> struct DawnTextLease {
    std::shared_ptr<DawnTextDevice> owner;
    Handle handle = nullptr;
    bool destroyed = false;
    std::uint64_t capture_id = 0;

    ~DawnTextLease() { retire(); }
    void destroy() noexcept {
        if constexpr (Destroy != nullptr) {
            if (handle && !destroyed)
                Destroy(handle);
        }
        if (!destroyed && capture_id)
            owner->capture.release(capture_id);
        destroyed = true;
    }
    void retire() noexcept {
        destroy();
        if (handle)
            Release(std::exchange(handle, nullptr));
    }
    Handle get() const {
        if (!handle || destroyed)
            throw std::runtime_error("Text GPU resource was destroyed.");
        return handle;
    }
};

using DawnTextBufferLease = DawnTextLease<WGPUBuffer, wgpuBufferRelease, wgpuBufferDestroy>;
using DawnTextTextureLease = DawnTextLease<WGPUTexture, wgpuTextureRelease, wgpuTextureDestroy>;
using DawnTextViewLease = DawnTextLease<WGPUTextureView, wgpuTextureViewRelease>;
using DawnTextGroupLease = DawnTextLease<WGPUBindGroup, wgpuBindGroupRelease>;
using DawnTextLayoutLease = DawnTextLease<WGPUBindGroupLayout, wgpuBindGroupLayoutRelease>;
using DawnTextPipelineLease = DawnTextLease<WGPURenderPipeline, wgpuRenderPipelineRelease>;

template <class Lease, class Handle>
std::shared_ptr<Lease> retain_dawn_text_resource(const std::shared_ptr<DawnTextDevice>& owner,
                                                 Handle handle, std::string_view role = {},
                                                 std::size_t bytes = 0, std::size_t width = 0,
                                                 std::size_t rows = 0) {
    if (!handle)
        throw std::runtime_error("Text GPU resource creation failed.");
    auto lease = std::make_shared<Lease>();
    lease->owner = owner;
    lease->handle = handle;
    if (owner->capture.enabled() && !role.empty())
        lease->capture_id = owner->capture.create_resource(role, bytes, width, rows);
    owner->resources.track(lease);
    return lease;
}

/** `GPUBuffer`. */
struct DawnTextGpuBuffer final : GpuObject {
    const void* device_identity() const override { return lease->owner->queue; }
    std::shared_ptr<DawnTextBufferLease> lease;
    void destroy() override { lease->destroy(); }
    std::optional<std::size_t> buffer_capacity() const override { return gpu_size(size); }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        write_dawn_gpu_buffer(lease->owner->queue, lease->get(), offset, bytes);
        lease->owner->capture.write(lease->capture_id, offset, bytes);
    }
};
/** `GPUTextureView`: one per `createView()`, as the pin creates them. */
struct DawnTextGpuView final : GpuObject {
    std::shared_ptr<DawnTextViewLease> lease;
    /** The texture the view reads, kept alive by the view as WebGPU does. */
    std::shared_ptr<DawnTextTextureLease> texture;
    /** A swapchain or capture target the frame owns. */
    WGPUTextureView target = nullptr;
    WGPUTextureView get() const { return lease ? lease->get() : target; }
};
/** `GPUTexture`. */
struct DawnTextGpuTexture final : GpuObject {
    const void* device_identity() const override { return lease->owner->queue; }
    std::shared_ptr<DawnTextTextureLease> lease;
    void write_texture_bytes(std::span<const std::uint8_t> data,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        const auto row_bytes = layout.bytes_per_row.value_or(extent.width * 16u);
        const auto count = static_cast<std::size_t>(row_bytes) * extent.height;
        const auto bytes =
            gpu_bytes(data, static_cast<double>(layout.offset), static_cast<double>(count));
        WGPUTexelCopyTextureInfo target = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        target.texture = lease->get();
        write_dawn_gpu_texture(lease->owner->queue, target, bytes,
                               {0, row_bytes, layout.rows_per_image.value_or(extent.height)},
                               extent);
        lease->owner->capture.write(lease->capture_id, 0u, bytes);
    }
    void destroy() override { lease->destroy(); }
    GpuHandle create_view() override {
        auto view = std::make_shared<DawnTextGpuView>();
        view->texture = lease;
        view->lease = retain_dawn_text_resource<DawnTextViewLease>(
            lease->owner, create_dawn_texture_view(lease->get(), nullptr), "texture-view");
        return view;
    }
};
/** `GPUBindGroupLayout`, with the composed shader's binding roles. */
struct DawnTextGpuLayout final : GpuObject {
    std::shared_ptr<DawnTextLayoutLease> layout;
    std::vector<std::pair<std::uint32_t, TextBindingRole>> bindings;
};
/** `GPUBindGroup`, holding what it binds. */
struct DawnTextGpuGroup final : GpuObject {
    std::shared_ptr<DawnTextGroupLease> group;
    std::vector<GpuHandle> resources;
    std::vector<TextGpuBindingCapture> bindings;
};
/** `GPURenderPipeline`. */
struct DawnTextGpuPipeline final : GpuObject {
    std::shared_ptr<DawnTextPipelineLease> pipeline;
    TextGpuDrawCapture capture;
};

template <class Object> std::shared_ptr<Object> dawn_text_object(const GpuHandle& handle) {
    auto object = std::dynamic_pointer_cast<Object>(handle);
    if (!object)
        throw std::runtime_error("Text GPU object belongs to another kind or device.");
    return object;
}

/** `GPURenderPassEncoder` over a Dawn render pass. */
struct DawnTextPassEncoder final : GpuEncoder {
    std::shared_ptr<DawnTextDevice> owner;
    WGPURenderPassEncoder pass = nullptr;
    /** A pass `beginRenderPass` opened; a scene pass borrows the frame's. */
    DawnRenderPass owned_pass;
    std::shared_ptr<DawnTextGpuPipeline> current_pipeline;
    std::shared_ptr<DawnTextGpuGroup> current_group;
    std::shared_ptr<DawnTextBufferLease> current_quad, current_instances;

    void set_pipeline(const GpuHandle& handle) override {
        const auto value = dawn_text_object<DawnTextGpuPipeline>(handle);
        wgpuRenderPassEncoderSetPipeline(pass, value->pipeline->get());
        if (owner->capture.enabled())
            current_pipeline = value;
    }
    void set_vertex_buffer(double slot, const GpuHandle& handle) override {
        const auto buffer = dawn_text_object<DawnTextGpuBuffer>(handle);
        const auto index = gpu_u32(gpu_size(slot));
        wgpuRenderPassEncoderSetVertexBuffer(pass, index, buffer->lease->get(), 0u,
                                             WGPU_WHOLE_SIZE);
        if (owner->capture.enabled())
            (index == 0 ? current_quad : current_instances) = buffer->lease;
    }
    void set_bind_group(double index, const GpuHandle& handle) override {
        const auto group = dawn_text_object<DawnTextGpuGroup>(handle);
        wgpuRenderPassEncoderSetBindGroup(pass, gpu_u32(gpu_size(index)), group->group->get(), 0u,
                                          nullptr);
        if (owner->capture.enabled())
            current_group = group;
    }
    void draw(double vertices, double instances, double first_vertex,
              double first_instance) override {
        const auto count = gpu_u32(gpu_size(vertices)),
                   instance_count = gpu_u32(gpu_size(instances)),
                   first = gpu_u32(gpu_size(first_vertex)),
                   first_instance_index = gpu_u32(gpu_size(first_instance));
        wgpuRenderPassEncoderDraw(pass, count, instance_count, first, first_instance_index);
        if (owner->capture.enabled()) {
            auto receipt = current_pipeline->capture;
            receipt.pipeline = current_pipeline->pipeline->capture_id;
            receipt.group = current_group->group->capture_id;
            receipt.quad = current_quad->capture_id;
            receipt.instances = current_instances->capture_id;
            receipt.bindings = current_group->bindings;
            receipt.vertices = count;
            receipt.instance_count = instance_count;
            receipt.first_vertex = first;
            receipt.first_instance = first_instance_index;
            owner->capture.draw(std::move(receipt));
        }
    }
    void execute_bundles(const js::Array<GpuHandle>& bundles) override {
        replay_text_bundles(*this, bundles);
    }
    void end() override {
        if (!owned_pass.get())
            throw std::runtime_error("Text pass encoder does not own its pass.");
        wgpuRenderPassEncoderEnd(pass);
        owned_pass.reset();
        pass = nullptr;
    }
};

/** `GPUCommandEncoder` over the frame's Dawn encoder. */
struct DawnTextCommandEncoder final : GpuCommandEncoder {
    std::shared_ptr<DawnTextDevice> owner;
    WGPUCommandEncoder encoder = nullptr;

    GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor& descriptor) override {
        if (descriptor.color_attachments.size() != 1)
            throw std::runtime_error("Text render passes have one color attachment.");
        const auto& color = descriptor.color_attachments[0];
        WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        attachment.view = dawn_text_object<DawnTextGpuView>(color.view)->get();
        if (color.clear_value) {
            const auto& value = *color.clear_value;
            attachment.clearValue = {value.r, value.g, value.b, value.a};
        }
        if (color.load_op == "clear")
            attachment.loadOp = WGPULoadOp_Clear;
        else if (color.load_op == "load")
            attachment.loadOp = WGPULoadOp_Load;
        else
            throw std::runtime_error("Unmapped text pass load op: " + color.load_op);
        if (color.store_op != "store")
            throw std::runtime_error("Unmapped text pass store op: " + color.store_op);
        attachment.storeOp = WGPUStoreOp_Store;
        WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &attachment;
        auto result = std::make_shared<DawnTextPassEncoder>();
        result->owner = owner;
        result->owned_pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
        result->pass = result->owned_pass.get();
        return result;
    }
};

/** The WebGPU half of the Dawn text device: objects, writes and bind groups. */
struct DawnTextGpuResources : GpuDevice {
    std::shared_ptr<DawnTextDevice> owner = std::make_shared<DawnTextDevice>();

    DawnTextGpuResources(WGPUDevice device, WGPUQueue queue, bool capture) {
        owner->device = device;
        owner->queue = queue;
        owner->capture = TextGpuCapture(capture);
    }
    const void* device_identity() const override { return owner->queue; }
    ~DawnTextGpuResources() override { owner->retire(); }

    GpuHandle create_buffer(const GpuBufferDescriptor& descriptor) override {
        const auto bytes = gpu_size(descriptor.size);
        WGPUBufferDescriptor info = WGPU_BUFFER_DESCRIPTOR_INIT;
        info.size = bytes;
        // WebGPU's usage bits are Dawn's.
        info.usage = static_cast<WGPUBufferUsage>(gpu_size(descriptor.usage));
        const bool uniform = text_usage_has(descriptor.usage, text_buffer_usage_uniform);
        auto buffer = std::make_shared<DawnTextGpuBuffer>();
        buffer->size = descriptor.size;
        buffer->lease = retain_dawn_text_resource<DawnTextBufferLease>(
            owner, wgpuDeviceCreateBuffer(owner->device, &info),
            uniform ? std::string_view("uniform") : text_resource_role(descriptor.label), bytes);
        return buffer;
    }

    GpuHandle create_texture(const GpuTextureDescriptor& descriptor) override {
        if (descriptor.format != "rgba32float")
            throw std::runtime_error("Unmapped text texture format: " + descriptor.format);
        const auto width = gpu_size(descriptor.size.width), rows = gpu_size(descriptor.size.height);
        WGPUTextureDescriptor info = WGPU_TEXTURE_DESCRIPTOR_INIT;
        info.dimension = WGPUTextureDimension_2D;
        info.size = WGPUExtent3D{gpu_u32(width), gpu_u32(rows),
                                 gpu_u32(gpu_size(descriptor.size.depth_or_array_layers))};
        info.format = WGPUTextureFormat_RGBA32Float;
        info.usage = static_cast<WGPUTextureUsage>(gpu_size(descriptor.usage));
        auto texture = std::make_shared<DawnTextGpuTexture>();
        texture->lease = retain_dawn_text_resource<DawnTextTextureLease>(
            owner, wgpuDeviceCreateTexture(owner->device, &info),
            text_resource_role(descriptor.label), width * rows * 4u * sizeof(float), width, rows);
        return texture;
    }

    GpuHandle create_bind_group(const GpuBindGroupDescriptor& descriptor) override {
        const auto layout_object = dawn_text_object<DawnTextGpuLayout>(descriptor.layout);
        auto group = std::make_shared<DawnTextGpuGroup>();
        std::vector<WGPUBindGroupEntry> entries;
        for (const auto& source : descriptor.entries) {
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = gpu_u32(gpu_size(source.binding));
            TextGpuBindingCapture receipt;
            receipt.binding = entry.binding;
            const auto role =
                std::find_if(layout_object->bindings.begin(), layout_object->bindings.end(),
                             [&](const auto& row) { return row.first == entry.binding; });
            if (role == layout_object->bindings.end())
                throw std::runtime_error("Text bind group entry has no layout binding.");
            receipt.role = text_binding_role_name(role->second);
            if (const auto* binding = std::get_if<GpuBufferBinding>(&source.resource)) {
                const auto buffer = dawn_text_object<DawnTextGpuBuffer>(binding->buffer);
                entry.buffer = buffer->lease->get();
                entry.offset = gpu_size(binding->offset.value_or(0));
                if (binding->size)
                    entry.size = gpu_size(*binding->size);
                receipt.resource = buffer->lease->capture_id;
                group->resources.push_back(buffer);
            } else {
                const auto view =
                    dawn_text_object<DawnTextGpuView>(std::get<GpuHandle>(source.resource));
                entry.textureView = view->get();
                receipt.resource = view->texture ? view->texture->capture_id : 0;
                receipt.view = view->lease ? view->lease->capture_id : 0;
                group->resources.push_back(view);
            }
            entries.push_back(entry);
            if (owner->capture.enabled())
                group->bindings.push_back(std::move(receipt));
        }
        WGPUBindGroupDescriptor info = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        info.layout = layout_object->layout->get();
        info.entryCount = entries.size();
        info.entries = entries.data();
        group->group = retain_dawn_text_resource<DawnTextGroupLease>(
            owner, wgpuDeviceCreateBindGroup(owner->device, &info), "bind-group");
        return group;
    }

    GpuEncoderHandle
    create_render_bundle_encoder(const GpuRenderBundleEncoderDescriptor&) override {
        return std::make_shared<TextBundleRecorder>();
    }
};

} // namespace bbl::pal
