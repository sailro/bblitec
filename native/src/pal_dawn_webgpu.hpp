#pragma once

#include "pal_dawn_formats.hpp"
#include "pal_dawn_completion.hpp"
#include "pal_dawn_resources.hpp"
#include "pal_webgpu_common.hpp"

#include <webgpu/webgpu.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

// The WebGPU subset (`gpu.hpp`) over a Dawn device: WebGPU's own objects, one
// to one. Generated code holds them by `GpuHandle`; the device owner retires
// every native lease when the device ends.

namespace bbl::pal {

struct DawnWebGpuOwner;
/** One native reference (`DawnLease`); `destroy()` is WebGPU's. */
template <class Handle, auto Release, auto Destroy = nullptr>
using DawnWebGpuLease = DawnLease<DawnWebGpuOwner, Handle, Release, Destroy>;
using DawnWebGpuBufferLease = DawnWebGpuLease<WGPUBuffer, wgpuBufferRelease, wgpuBufferDestroy>;
using DawnWebGpuTextureLease = DawnWebGpuLease<WGPUTexture, wgpuTextureRelease, wgpuTextureDestroy>;
using DawnWebGpuViewLease = DawnWebGpuLease<WGPUTextureView, wgpuTextureViewRelease>;
using DawnWebGpuSamplerLease = DawnWebGpuLease<WGPUSampler, wgpuSamplerRelease>;
using DawnWebGpuLayoutLease = DawnWebGpuLease<WGPUBindGroupLayout, wgpuBindGroupLayoutRelease>;
using DawnWebGpuGroupLease = DawnWebGpuLease<WGPUBindGroup, wgpuBindGroupRelease>;
using DawnWebGpuModuleLease = DawnWebGpuLease<WGPUShaderModule, wgpuShaderModuleRelease>;
using DawnWebGpuPipelineLayoutLease =
    DawnWebGpuLease<WGPUPipelineLayout, wgpuPipelineLayoutRelease>;
using DawnWebGpuComputeLease = DawnWebGpuLease<WGPUComputePipeline, wgpuComputePipelineRelease>;
using DawnWebGpuRenderLease = DawnWebGpuLease<WGPURenderPipeline, wgpuRenderPipelineRelease>;
using DawnWebGpuCommandsLease = DawnWebGpuLease<WGPUCommandBuffer, wgpuCommandBufferRelease>;

/** The device a WebGPU object belongs to; it outlives no lease it created. */
struct DawnWebGpuOwner : std::enable_shared_from_this<DawnWebGpuOwner> {
    WGPUInstance instance = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    GpuLeaseRetirement leases;

    DawnWebGpuOwner(WGPUInstance context, WGPUDevice owner, WGPUQueue submitted)
        : instance(context), device(owner), queue(submitted) {
        if (!instance || !device || !queue)
            webgpu_refuse("a Dawn WebGPU device needs its instance, device and queue.");
        wgpuInstanceAddRef(instance);
        wgpuDeviceAddRef(device);
        wgpuQueueAddRef(queue);
    }
    DawnWebGpuOwner(const DawnWebGpuOwner&) = delete;
    DawnWebGpuOwner& operator=(const DawnWebGpuOwner&) = delete;
    ~DawnWebGpuOwner() { retire(); }

    template <class Lease, class Handle>
    std::shared_ptr<Lease> adopt(Handle handle, const char* what) {
        if (!device)
            webgpu_refuse("the GPU device was retired.");
        if (!handle)
            webgpu_refuse(std::string(what) + " creation failed.");
        auto lease = std::make_shared<Lease>();
        lease->owner = shared_from_this();
        lease->handle = handle;
        leases.track(lease);
        return lease;
    }
    void retire() noexcept {
        leases.retire();
        if (queue)
            wgpuQueueRelease(std::exchange(queue, nullptr));
        if (device)
            wgpuDeviceRelease(std::exchange(device, nullptr));
        if (instance)
            wgpuInstanceRelease(std::exchange(instance, nullptr));
    }
    WGPUDevice live_device() const {
        if (!device)
            webgpu_refuse("the GPU device was retired.");
        return device;
    }
};

/** An optional WebGPU string; absent is Dawn's null view, not an empty string. */
inline WGPUStringView dawn_webgpu_label(const bbl::js::Nullable<std::string>& label) {
    return label ? WGPUStringView{label->data(), label->size()}
                 : WGPUStringView{nullptr, WGPU_STRLEN};
}

/** `GPUBuffer`. */
struct DawnWebGpuBuffer final : GpuObject,
                                GpuBufferMapping,
                                std::enable_shared_from_this<DawnWebGpuBuffer> {
    std::shared_ptr<DawnWebGpuOwner> owner;
    std::shared_ptr<DawnWebGpuBufferLease> lease;
    std::uint32_t usage = 0;
    WebGpuBufferMapState mapping;

    std::size_t byte_size() const { return gpu_size(size); }
    const void* device_identity() const override { return owner->queue; }
    bool resource_alive() const noexcept override { return lease && lease->live(); }
    std::optional<std::size_t> buffer_capacity() const override { return byte_size(); }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        require_webgpu_buffer_write(usage, mapping, byte_size(), offset, bytes.size());
        write_dawn_gpu_buffer(owner->queue, lease->get(), offset, bytes);
    }
    void destroy() override {
        if (!mapping.unmapped())
            unmap();
        lease->destroy();
    }
    js::ArrayBuffer get_mapped_range(bbl::js::Nullable<double> offset,
                                     bbl::js::Nullable<double> count) override {
        return mapping.get_mapped_range(
            offset, count, byte_size(), [this](std::size_t start, std::size_t length) {
                const auto* data = static_cast<const std::uint8_t*>(
                    wgpuBufferGetConstMappedRange(lease->get(), start, length));
                if (!data)
                    webgpu_refuse("Dawn returned no mapped range.");
                return std::vector<std::uint8_t>(data, data + length);
            });
    }
    void unmap() override {
        const bool native = !mapping.unmapped();
        for (const auto& range : mapping.unmap()) {
            auto* target =
                wgpuBufferGetMappedRange(lease->get(), range.offset, range.bytes.byte_length());
            if (!target)
                webgpu_refuse("Dawn returned no writable mapped range.");
            std::memcpy(target, range.bytes.data(), range.bytes.byte_length());
        }
        if (native && lease->live())
            wgpuBufferUnmap(lease->get());
    }
    js::Promise<js::PromiseVoid> map_async(double mode, bbl::js::Nullable<double> offset,
                                           bbl::js::Nullable<double> count) override {
        std::pair<std::size_t, std::size_t> range;
        try {
            lease->get();
            range = mapping.begin_read(mode, offset, count, byte_size(),
                                       (usage & webgpu_buffer_usage::map_read) != 0);
        } catch (...) {
            return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
        }
        js::Promise<js::PromiseVoid> result;
        mapping.set_pending_promise(result);
        const auto generation = mapping.generation();
        return settle_webgpu_operation(
            [instance = owner->instance, buffer = lease->get(),
             range](std::function<void(std::exception_ptr)> complete) {
                return dawn_buffer_map_read(instance, buffer, range.first, range.second,
                                            std::move(complete));
            },
            [weak = weak_from_this(), generation](std::exception_ptr error) {
                const auto self = weak.lock();
                if (self && !self->mapping.complete(generation, !error) && !error)
                    error = std::make_exception_ptr(
                        std::runtime_error("AbortError: the mapping ended before it completed."));
                return error;
            },
            result);
    }
    std::string map_state() const override { return mapping.map_state(); }
};

/** `GPUTextureView` over a whole texture, which it keeps alive. */
struct DawnWebGpuView final : GpuObject {
    std::shared_ptr<DawnWebGpuViewLease> lease;
    std::shared_ptr<DawnWebGpuTextureLease> texture;
};

/** `GPUSampler`. */
struct DawnWebGpuSampler final : GpuObject {
    std::shared_ptr<DawnWebGpuSamplerLease> lease;
};

/** `GPUTexture`: rgba8unorm, as the subset creates them. */
struct DawnWebGpuTexture final : GpuObject {
    std::shared_ptr<DawnWebGpuOwner> owner;
    std::shared_ptr<DawnWebGpuTextureLease> lease;
    std::uint32_t usage = 0;
    const void* device_identity() const override { return owner->queue; }
    void write_texture_bytes(std::span<const std::uint8_t> bytes,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        if (!(usage & webgpu_texture_usage::copy_dst))
            webgpu_refuse("writeTexture requires a texture created with COPY_DST.");
        WGPUTexelCopyTextureInfo target = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        target.texture = lease->get();
        write_dawn_gpu_texture(owner->queue, target, bytes, layout, extent);
    }
    void destroy() override { lease->destroy(); }
    GpuHandle create_view() override {
        auto view = std::make_shared<DawnWebGpuView>();
        view->texture = lease;
        view->lease = owner->adopt<DawnWebGpuViewLease>(
            create_dawn_texture_view(lease->get(), nullptr), "texture view");
        return view;
    }
};

struct DawnWebGpuBindGroupLayout final : GpuObject {
    std::shared_ptr<DawnWebGpuLayoutLease> lease;
};
struct DawnWebGpuShaderModule final : GpuObject {
    std::shared_ptr<DawnWebGpuModuleLease> lease;
};
struct DawnWebGpuPipelineLayout final : GpuObject {
    std::shared_ptr<DawnWebGpuPipelineLayoutLease> lease;
    std::vector<GpuHandle> groups;
};
/** A pipeline's layout choice: its explicit layout, or none for `"auto"` (Dawn derives it). */
inline WGPUPipelineLayout dawn_webgpu_pipeline_layout(const GpuPipelineLayoutChoice& choice) {
    return choice.layout ? webgpu_object<DawnWebGpuPipelineLayout>(choice.layout, "pipeline layout")
                               ->lease->get()
                         : nullptr;
}
struct DawnWebGpuComputePipeline final : GpuObject {
    std::shared_ptr<DawnWebGpuComputeLease> lease;
    GpuHandle layout;
    std::shared_ptr<DawnWebGpuOwner> owner;
    GpuHandle get_bind_group_layout(double index) override;
};
struct DawnWebGpuRenderPipeline final : GpuObject {
    std::shared_ptr<DawnWebGpuRenderLease> lease;
    GpuHandle layout;
    std::shared_ptr<DawnWebGpuOwner> owner;
    GpuHandle get_bind_group_layout(double index) override;
};
/** `GPUBindGroup`, holding what it binds. */
struct DawnWebGpuBindGroup final : GpuObject {
    std::shared_ptr<DawnWebGpuGroupLease> lease;
    std::vector<GpuHandle> resources;
};
/** `getBindGroupLayout(index)`: the group Dawn derived or was given. */
inline GpuHandle dawn_webgpu_group_layout(DawnWebGpuOwner& owner, WGPUBindGroupLayout layout) {
    auto result = std::make_shared<DawnWebGpuBindGroupLayout>();
    result->lease = owner.adopt<DawnWebGpuLayoutLease>(layout, "bind group layout");
    return result;
}
inline GpuHandle DawnWebGpuComputePipeline::get_bind_group_layout(double index) {
    return dawn_webgpu_group_layout(
        *owner, wgpuComputePipelineGetBindGroupLayout(lease->get(), webgpu_flags(index)));
}
inline GpuHandle DawnWebGpuRenderPipeline::get_bind_group_layout(double index) {
    return dawn_webgpu_group_layout(
        *owner, wgpuRenderPipelineGetBindGroupLayout(lease->get(), webgpu_flags(index)));
}
struct DawnWebGpuCommandBuffer final : GpuObject {
    std::shared_ptr<DawnWebGpuCommandsLease> lease;
};

/** `GPUComputePassEncoder`. */
struct DawnWebGpuComputePass final : GpuComputePassEncoder {
    DawnOwned<WGPUComputePassEncoder, wgpuComputePassEncoderRelease> pass;
    WGPUComputePassEncoder live() const {
        if (!pass.get())
            webgpu_refuse("the compute pass has ended.");
        return pass.get();
    }
    void set_pipeline(const GpuHandle& pipeline) override {
        wgpuComputePassEncoderSetPipeline(
            live(),
            webgpu_object<DawnWebGpuComputePipeline>(pipeline, "compute pipeline")->lease->get());
    }
    void set_bind_group(double index, const GpuHandle& group,
                        const js::Array<double>& dynamic_offsets) override {
        const auto offsets = webgpu_offsets(dynamic_offsets);
        wgpuComputePassEncoderSetBindGroup(
            live(), webgpu_flags(index),
            webgpu_object<DawnWebGpuBindGroup>(group, "bind group")->lease->get(), offsets.size(),
            offsets.data());
    }
    void dispatch_workgroups(double x, double y, double z) override {
        wgpuComputePassEncoderDispatchWorkgroups(live(), webgpu_flags(x), webgpu_flags(y),
                                                 webgpu_flags(z));
    }
    void dispatch_workgroups_indirect(const GpuHandle& buffer, double offset) override {
        wgpuComputePassEncoderDispatchWorkgroupsIndirect(
            live(), webgpu_object<DawnWebGpuBuffer>(buffer, "buffer")->lease->get(),
            gpu_size(offset));
    }
    void end() override {
        wgpuComputePassEncoderEnd(live());
        pass.reset();
    }
};

/**
 * `GPUCommandEncoder`: one the device created, which `finish()` closes, or
 * a renderer's frame encoder borrowed for the commands recorded before its
 * passes.
 */
struct DawnWebGpuCommandEncoder final : GpuCommandEncoder {
    std::shared_ptr<DawnWebGpuOwner> owner;
    DawnCommandEncoder owned;
    WGPUCommandEncoder encoder = nullptr;
    WGPUCommandEncoder live() const {
        if (!encoder)
            webgpu_refuse("the command encoder has finished.");
        return encoder;
    }
    GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor&) override {
        webgpu_refuse("render passes belong to the renderer; the subset records compute passes.");
    }
    GpuComputePassEncoderHandle
    begin_compute_pass(const GpuComputePassDescriptor& descriptor) override {
        WGPUComputePassDescriptor info = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        auto pass = std::make_shared<DawnWebGpuComputePass>();
        pass->pass = require_dawn_resource(wgpuCommandEncoderBeginComputePass(live(), &info),
                                           "compute pass");
        return pass;
    }
    void copy_buffer_to_buffer(const GpuHandle& source, double source_offset,
                               const GpuHandle& destination, double destination_offset,
                               double size) override {
        const auto from = webgpu_object<DawnWebGpuBuffer>(source, "buffer");
        const auto to = webgpu_object<DawnWebGpuBuffer>(destination, "buffer");
        wgpuCommandEncoderCopyBufferToBuffer(live(), from->lease->get(), gpu_size(source_offset),
                                             to->lease->get(), gpu_size(destination_offset),
                                             gpu_size(size));
    }
    void clear_buffer(const GpuHandle& buffer, bbl::js::Nullable<double> offset,
                      bbl::js::Nullable<double> size) override {
        const auto target = webgpu_object<DawnWebGpuBuffer>(buffer, "buffer");
        wgpuCommandEncoderClearBuffer(live(), target->lease->get(), gpu_size(offset.value_or(0)),
                                      size ? gpu_size(*size) : WGPU_WHOLE_SIZE);
    }
    GpuHandle finish() override {
        if (!owned.get())
            webgpu_refuse("a renderer's frame encoder is finished by its renderer.");
        auto result = std::make_shared<DawnWebGpuCommandBuffer>();
        result->lease = owner->adopt<DawnWebGpuCommandsLease>(
            wgpuCommandEncoderFinish(live(), nullptr), "command buffer");
        owned.reset();
        encoder = nullptr;
        return result;
    }
};

/** A renderer's `GPURenderPassEncoder`: the pass a renderable's `draw` records into. */
struct DawnWebGpuRenderPass final : WebGpuLentPass<WGPURenderPassEncoder> {
    void set_pipeline(const GpuHandle& pipeline) override {
        wgpuRenderPassEncoderSetPipeline(
            pass,
            webgpu_object<DawnWebGpuRenderPipeline>(pipeline, "render pipeline")->lease->get());
        bound_pipeline = pipeline;
    }
    void set_vertex_buffer(double, const GpuHandle&) override {
        webgpu_refuse("the subset's render pipelines take no vertex buffers.");
    }
    void set_bind_group(double index, const GpuHandle& group) override {
        const auto slot = webgpu_flags(index);
        if (slot >= bound_groups.size())
            webgpu_refuse("a render pass binds at most four groups.");
        wgpuRenderPassEncoderSetBindGroup(
            pass, slot, webgpu_object<DawnWebGpuBindGroup>(group, "bind group")->lease->get(), 0,
            nullptr);
        bound_groups[slot] = group;
    }
    void draw(double vertices, double instances, double first_vertex,
              double first_instance) override {
        wgpuRenderPassEncoderDraw(pass, webgpu_flags(vertices), webgpu_flags(instances),
                                  webgpu_flags(first_vertex), webgpu_flags(first_instance));
    }
    void draw_indirect(const GpuHandle& buffer, double offset) override {
        wgpuRenderPassEncoderDrawIndirect(
            pass, webgpu_object<DawnWebGpuBuffer>(buffer, "buffer")->lease->get(),
            gpu_size(offset));
    }
    /** A draw's own state: a renderable sets what it draws with. */
    void clear() {
        bound_pipeline.reset();
        bound_groups = {};
    }

protected:
    /** The resumed pass replays the pipeline and groups set so far (gps-pass.ts `pause`). */
    void resumed() override {
        if (bound_pipeline)
            set_pipeline(bound_pipeline);
        for (std::uint32_t index = 0; index < bound_groups.size(); ++index)
            if (bound_groups[index])
                set_bind_group(index, bound_groups[index]);
    }

private:
    GpuHandle bound_pipeline;
    std::array<GpuHandle, 4> bound_groups;
};

inline WGPUCompareFunction dawn_webgpu_compare(const std::string& name) {
    static constexpr std::pair<std::string_view, WGPUCompareFunction> functions[] = {
        {"never", WGPUCompareFunction_Never},
        {"less", WGPUCompareFunction_Less},
        {"equal", WGPUCompareFunction_Equal},
        {"less-equal", WGPUCompareFunction_LessEqual},
        {"greater", WGPUCompareFunction_Greater},
        {"not-equal", WGPUCompareFunction_NotEqual},
        {"greater-equal", WGPUCompareFunction_GreaterEqual},
        {"always", WGPUCompareFunction_Always}};
    for (const auto& [text, function] : functions)
        if (text == name)
            return function;
    webgpu_refuse("compare function '" + name + "' is not admitted.");
}
inline WGPUCullMode dawn_webgpu_cull(const std::string& name) {
    if (name == "none")
        return WGPUCullMode_None;
    if (name == "front")
        return WGPUCullMode_Front;
    if (name == "back")
        return WGPUCullMode_Back;
    webgpu_refuse("cull mode '" + name + "' is not admitted.");
}
inline WGPUBlendComponent dawn_webgpu_blend(const GpuBlendComponent& source) {
    const auto factor = [](const std::string& name) {
        if (name == "zero")
            return WGPUBlendFactor_Zero;
        if (name == "one")
            return WGPUBlendFactor_One;
        if (name == "src-alpha")
            return WGPUBlendFactor_SrcAlpha;
        if (name == "one-minus-src-alpha")
            return WGPUBlendFactor_OneMinusSrcAlpha;
        webgpu_refuse("blend factor '" + name + "' is not admitted.");
    };
    if (source.operation.value_or(std::string("add")) != "add")
        webgpu_refuse("blend operations other than 'add' are not admitted.");
    WGPUBlendComponent result{};
    result.operation = WGPUBlendOperation_Add;
    result.srcFactor = factor(source.src_factor.value_or(std::string("one")));
    result.dstFactor = factor(source.dst_factor.value_or(std::string("zero")));
    return result;
}

/** The WebGPU subset over a Dawn device; it retires every lease it created when it ends. */
struct DawnWebGpuDevice : GpuDevice {
    std::shared_ptr<DawnWebGpuOwner> owner;

    DawnWebGpuDevice(WGPUInstance instance, WGPUDevice device, WGPUQueue queue)
        : owner(std::make_shared<DawnWebGpuOwner>(instance, device, queue)) {}
    ~DawnWebGpuDevice() override { owner->retire(); }
    const void* device_identity() const override { return owner->queue; }

    GpuSupportedLimits limits() const override {
        WGPULimits limits = WGPU_LIMITS_INIT;
        if (wgpuDeviceGetLimits(owner->live_device(), &limits) != WGPUStatus_Success)
            webgpu_refuse("Dawn device limits are unavailable.");
        return {static_cast<double>(limits.maxBufferSize),
                static_cast<double>(limits.maxStorageBufferBindingSize),
                static_cast<double>(limits.maxComputeWorkgroupsPerDimension),
                static_cast<double>(limits.maxColorAttachmentBytesPerSample)};
    }

    GpuHandle create_buffer(const GpuBufferDescriptor& descriptor) override {
        WGPUBufferDescriptor info = WGPU_BUFFER_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.size = gpu_size(descriptor.size);
        info.usage = static_cast<WGPUBufferUsage>(webgpu_flags(descriptor.usage));
        info.mappedAtCreation = descriptor.mapped_at_creation;
        auto buffer = std::make_shared<DawnWebGpuBuffer>();
        buffer->owner = owner;
        buffer->size = descriptor.size;
        buffer->usage = webgpu_flags(descriptor.usage);
        if (descriptor.mapped_at_creation)
            buffer->mapping.map_at_creation(gpu_size(descriptor.size));
        buffer->lease = owner->adopt<DawnWebGpuBufferLease>(
            wgpuDeviceCreateBuffer(owner->live_device(), &info), "buffer");
        return buffer;
    }

    GpuHandle create_texture(const GpuTextureDescriptor& descriptor) override {
        if (descriptor.format != "rgba8unorm")
            webgpu_refuse("the subset creates rgba8unorm textures only.");
        if (descriptor.sample_count.value_or(1) != 1)
            webgpu_refuse("the subset creates single-sample textures only.");
        WGPUTextureDescriptor info = WGPU_TEXTURE_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.dimension = WGPUTextureDimension_2D;
        info.size = WGPUExtent3D{gpu_u32(gpu_size(descriptor.size.width)),
                                 gpu_u32(gpu_size(descriptor.size.height)),
                                 gpu_u32(gpu_size(descriptor.size.depth_or_array_layers))};
        info.format = WGPUTextureFormat_RGBA8Unorm;
        info.usage = static_cast<WGPUTextureUsage>(webgpu_flags(descriptor.usage));
        auto texture = std::make_shared<DawnWebGpuTexture>();
        texture->owner = owner;
        texture->usage = webgpu_flags(descriptor.usage);
        texture->lease = owner->adopt<DawnWebGpuTextureLease>(
            wgpuDeviceCreateTexture(owner->live_device(), &info), "texture");
        return texture;
    }

    GpuHandle create_bind_group_layout(const GpuBindGroupLayoutDescriptor& descriptor) override {
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (const auto& source : webgpu_layout_entries(descriptor)) {
            WGPUBindGroupLayoutEntry entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
            entry.binding = source.binding;
            entry.visibility = static_cast<WGPUShaderStage>(source.visibility);
            if (source.texture) {
                entry.texture.sampleType = WGPUTextureSampleType_Float;
                entry.texture.viewDimension =
                    source.cube ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D;
            } else if (source.sampler) {
                entry.sampler.type = source.filtering ? WGPUSamplerBindingType_Filtering
                                                      : WGPUSamplerBindingType_NonFiltering;
            } else {
                entry.buffer.type = source.buffer == WebGpuBufferBinding::uniform
                                        ? WGPUBufferBindingType_Uniform
                                    : source.buffer == WebGpuBufferBinding::storage
                                        ? WGPUBufferBindingType_Storage
                                        : WGPUBufferBindingType_ReadOnlyStorage;
                entry.buffer.hasDynamicOffset = source.dynamic_offset;
            }
            entries.push_back(entry);
        }
        // `minBindingSize` is the declared size WebGPU validates bindings against.
        for (std::size_t index = 0; index < entries.size(); ++index) {
            const auto& buffer = descriptor.entries[index].buffer;
            if (buffer && buffer->min_binding_size)
                entries[index].buffer.minBindingSize = gpu_size(*buffer->min_binding_size);
        }
        WGPUBindGroupLayoutDescriptor info = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.entryCount = entries.size();
        info.entries = entries.data();
        auto layout = std::make_shared<DawnWebGpuBindGroupLayout>();
        layout->lease = owner->adopt<DawnWebGpuLayoutLease>(
            wgpuDeviceCreateBindGroupLayout(owner->live_device(), &info), "bind group layout");
        return layout;
    }

    GpuHandle create_shader_module(const GpuShaderModuleDescriptor& descriptor) override {
        WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
        wgsl.code = {descriptor.code.data(), descriptor.code.size()};
        WGPUShaderModuleDescriptor info = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        info.nextInChain = &wgsl.chain;
        info.label = dawn_webgpu_label(descriptor.label);
        auto module = std::make_shared<DawnWebGpuShaderModule>();
        module->lease = owner->adopt<DawnWebGpuModuleLease>(
            wgpuDeviceCreateShaderModule(owner->live_device(), &info), "shader module");
        return module;
    }

    GpuHandle create_pipeline_layout(const GpuPipelineLayoutDescriptor& descriptor) override {
        auto layout = std::make_shared<DawnWebGpuPipelineLayout>();
        std::vector<WGPUBindGroupLayout> groups;
        for (const auto& group : descriptor.bind_group_layouts) {
            groups.push_back(
                webgpu_object<DawnWebGpuBindGroupLayout>(group, "bind group layout")->lease->get());
            layout->groups.push_back(group);
        }
        WGPUPipelineLayoutDescriptor info = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.bindGroupLayoutCount = groups.size();
        info.bindGroupLayouts = groups.data();
        layout->lease = owner->adopt<DawnWebGpuPipelineLayoutLease>(
            wgpuDeviceCreatePipelineLayout(owner->live_device(), &info), "pipeline layout");
        return layout;
    }

    GpuHandle create_compute_pipeline(const GpuComputePipelineDescriptor& descriptor) override {
        WGPUComputePipelineDescriptor info = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.layout = dawn_webgpu_pipeline_layout(descriptor.layout);
        info.compute.module =
            webgpu_object<DawnWebGpuShaderModule>(descriptor.compute.module, "shader module")
                ->lease->get();
        info.compute.entryPoint = dawn_webgpu_label(descriptor.compute.entry_point);
        auto pipeline = std::make_shared<DawnWebGpuComputePipeline>();
        pipeline->layout = descriptor.layout.layout;
        pipeline->owner = owner;
        pipeline->lease = owner->adopt<DawnWebGpuComputeLease>(
            wgpuDeviceCreateComputePipeline(owner->live_device(), &info), "compute pipeline");
        return pipeline;
    }

    GpuHandle create_sampler(const GpuSamplerDescriptor& descriptor) override {
        const auto sampler = webgpu_sampler(descriptor);
        const auto filter = [](bool linear) {
            return linear ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;
        };
        const auto address = [](WebGpuSampler::Address mode) {
            return mode == WebGpuSampler::Address::repeat          ? WGPUAddressMode_Repeat
                   : mode == WebGpuSampler::Address::mirror_repeat ? WGPUAddressMode_MirrorRepeat
                                                                   : WGPUAddressMode_ClampToEdge;
        };
        WGPUSamplerDescriptor info = WGPU_SAMPLER_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.magFilter = filter(sampler.mag_linear);
        info.minFilter = filter(sampler.min_linear);
        info.mipmapFilter =
            sampler.mipmap_linear ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
        info.addressModeU = address(sampler.address_u);
        info.addressModeV = address(sampler.address_v);
        info.addressModeW = address(sampler.address_w);
        info.lodMinClamp = sampler.lod_min_clamp;
        info.lodMaxClamp = sampler.lod_max_clamp;
        info.maxAnisotropy = sampler.max_anisotropy;
        auto result = std::make_shared<DawnWebGpuSampler>();
        result->lease = owner->adopt<DawnWebGpuSamplerLease>(
            wgpuDeviceCreateSampler(owner->live_device(), &info), "sampler");
        return result;
    }

    GpuHandle create_render_pipeline(const GpuRenderPipelineDescriptor& descriptor) override {
        require_webgpu_vertex_state(descriptor.vertex);
        WGPURenderPipelineDescriptor info = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.layout = dawn_webgpu_pipeline_layout(descriptor.layout);
        info.vertex.module =
            webgpu_object<DawnWebGpuShaderModule>(descriptor.vertex.module, "shader module")
                ->lease->get();
        info.vertex.entryPoint = dawn_webgpu_label(descriptor.vertex.entry_point);
        if (descriptor.primitive) {
            if (descriptor.primitive->topology.value_or(std::string("triangle-list")) !=
                "triangle-list")
                webgpu_refuse("render pipelines draw triangle lists.");
            info.primitive.cullMode =
                dawn_webgpu_cull(descriptor.primitive->cull_mode.value_or(std::string("none")));
            info.primitive.frontFace =
                webgpu_front_face_ccw(*descriptor.primitive) ? WGPUFrontFace_CCW : WGPUFrontFace_CW;
        }
        info.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
        if (descriptor.depth_stencil) {
            depth.format = dawn_webgpu_format(descriptor.depth_stencil->format);
            depth.depthWriteEnabled = descriptor.depth_stencil->depth_write_enabled.value_or(false)
                                          ? WGPUOptionalBool_True
                                          : WGPUOptionalBool_False;
            depth.depthCompare = dawn_webgpu_compare(
                descriptor.depth_stencil->depth_compare.value_or(std::string("always")));
            info.depthStencil = &depth;
        }
        info.multisample.count =
            descriptor.multisample ? webgpu_flags(descriptor.multisample->count.value_or(1)) : 1u;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        std::vector<WGPUColorTargetState> targets;
        std::vector<WGPUBlendState> blends;
        if (descriptor.fragment) {
            const auto& stage = *descriptor.fragment;
            fragment.module =
                webgpu_object<DawnWebGpuShaderModule>(stage.module, "shader module")->lease->get();
            fragment.entryPoint = dawn_webgpu_label(stage.entry_point);
            blends.reserve(stage.targets.size());
            for (const auto& source : stage.targets) {
                WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
                target.format = dawn_webgpu_format(source.format);
                target.writeMask =
                    static_cast<WGPUColorWriteMask>(webgpu_flags(source.write_mask.value_or(0xF)));
                if (source.blend) {
                    blends.push_back({dawn_webgpu_blend(source.blend->color),
                                      dawn_webgpu_blend(source.blend->alpha)});
                    target.blend = &blends.back();
                }
                targets.push_back(target);
            }
            fragment.targetCount = targets.size();
            fragment.targets = targets.data();
            info.fragment = &fragment;
        }
        auto pipeline = std::make_shared<DawnWebGpuRenderPipeline>();
        pipeline->layout = descriptor.layout.layout;
        pipeline->owner = owner;
        pipeline->lease = owner->adopt<DawnWebGpuRenderLease>(
            wgpuDeviceCreateRenderPipeline(owner->live_device(), &info), "render pipeline");
        return pipeline;
    }

    GpuHandle create_bind_group(const GpuBindGroupDescriptor& descriptor) override {
        auto group = std::make_shared<DawnWebGpuBindGroup>();
        std::vector<WGPUBindGroupEntry> entries;
        for (const auto& source : descriptor.entries) {
            WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
            entry.binding = webgpu_flags(source.binding);
            if (const auto* binding = std::get_if<GpuBufferBinding>(&source.resource)) {
                const auto buffer = webgpu_object<DawnWebGpuBuffer>(binding->buffer, "buffer");
                entry.buffer = buffer->lease->get();
                entry.offset = gpu_size(binding->offset.value_or(0));
                entry.size = binding->size ? gpu_size(*binding->size) : WGPU_WHOLE_SIZE;
                group->resources.push_back(binding->buffer);
            } else if (const auto& handle = std::get<GpuHandle>(source.resource);
                       const auto sampler = std::dynamic_pointer_cast<DawnWebGpuSampler>(handle)) {
                entry.sampler = sampler->lease->get();
                group->resources.push_back(handle);
            } else {
                entry.textureView =
                    webgpu_object<DawnWebGpuView>(handle, "texture view")->lease->get();
                group->resources.push_back(handle);
            }
            entries.push_back(entry);
        }
        WGPUBindGroupDescriptor info = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        info.layout =
            webgpu_object<DawnWebGpuBindGroupLayout>(descriptor.layout, "bind group layout")
                ->lease->get();
        info.entryCount = entries.size();
        info.entries = entries.data();
        group->lease = owner->adopt<DawnWebGpuGroupLease>(
            wgpuDeviceCreateBindGroup(owner->live_device(), &info), "bind group");
        return group;
    }

    GpuCommandEncoderHandle
    create_command_encoder(const GpuCommandEncoderDescriptor& descriptor) override {
        WGPUCommandEncoderDescriptor info = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
        info.label = dawn_webgpu_label(descriptor.label);
        auto encoder = std::make_shared<DawnWebGpuCommandEncoder>();
        encoder->owner = owner;
        encoder->owned = require_dawn_resource(
            wgpuDeviceCreateCommandEncoder(owner->live_device(), &info), "command encoder");
        encoder->encoder = encoder->owned.get();
        return encoder;
    }

    void submit(const js::Array<GpuHandle>& command_buffers) override {
        std::vector<WGPUCommandBuffer> commands;
        for (const auto& handle : command_buffers)
            commands.push_back(
                webgpu_object<DawnWebGpuCommandBuffer>(handle, "command buffer")->lease->get());
        if (!owner->queue)
            webgpu_refuse("the GPU device was retired.");
        wgpuQueueSubmit(owner->queue, commands.size(), commands.data());
    }

    js::Promise<js::PromiseVoid> on_submitted_work_done() override {
        if (!owner->queue)
            return js::Promise<js::PromiseVoid>::rejected(std::make_exception_ptr(
                std::runtime_error("WebGPU subset: the GPU device was retired.")));
        return settle_webgpu_operation([instance = owner->instance, queue = owner->queue](
                                           std::function<void(std::exception_ptr)> complete) {
            return dawn_queue_work_done(instance, queue, std::move(complete));
        });
    }

    /** A renderer's frame encoder, for the commands a renderable records before its pass. */
    GpuCommandEncoderHandle borrow_command_encoder(WGPUCommandEncoder encoder) const {
        auto result = std::make_shared<DawnWebGpuCommandEncoder>();
        result->owner = owner;
        result->encoder = require_dawn_resource(encoder, "frame command encoder");
        return result;
    }
    /**
     * A renderer's open pass, lent through `slot` for one renderable's `draw`
     * (`lend_webgpu_pass`), with its split on a frame a library splits it.
     */
    static const GpuEncoderHandle& lend_render_pass(
        GpuEncoderHandle& slot, WGPURenderPassEncoder pass, const bool* drawn = nullptr,
        const std::function<WGPURenderPassEncoder(const std::function<void()>&)>* pause = nullptr) {
        auto& lent = lend_webgpu_pass<DawnWebGpuRenderPass>(slot);
        lent.pass = require_dawn_resource(pass, "renderer pass");
        lent.drawn = drawn;
        lent.pause = pause;
        return slot;
    }
};

/** `Engine::webgpu_device` over the engine's Dawn device and its scene group, created on first use. */
inline DawnWebGpuDevice& dawn_engine_webgpu_device(Engine& engine, WGPUInstance instance,
                                                   WGPUDevice device, WGPUQueue queue) {
    if (!engine.webgpu_device) {
        engine.webgpu_device = std::make_shared<DawnWebGpuDevice>(instance, device, queue);
        bind_engine_scene_group(engine);
    }
    auto* result = dynamic_cast<DawnWebGpuDevice*>(engine.webgpu_device.get());
    if (!result || result->device_identity() != queue)
        webgpu_refuse("the engine's WebGPU device belongs to another GPU device.");
    return *result;
}

} // namespace bbl::pal
