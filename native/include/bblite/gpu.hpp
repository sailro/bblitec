#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/gpu_object.hpp>
#include <bblite/runtime.hpp>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>

namespace bbl {

/**
 * The WebGPU surface the pinned GPU writers speak, as generated code lowered
 * from the pin calls it: `device.createBuffer(descriptor)` is
 * `device->create_buffer(descriptor)` with the pin's own descriptor, and
 * `device.queue.writeBuffer(...)` carries the pin's offsets. Each backend
 * implements the device and its encoders with WebGPU's semantics.
 */

struct GpuBufferDescriptor {
    bbl::js::Nullable<std::string> label;
    double size = 0;
    double usage = 0;
    bool mapped_at_creation = false;
};
struct GpuExtent3D {
    double width = 0;
    double height = 1;
    double depth_or_array_layers = 1;
};
struct GpuTextureDescriptor {
    bbl::js::Nullable<std::string> label;
    std::string format;
    GpuExtent3D size;
    double usage = 0;
};
struct GpuBufferBinding {
    GpuHandle buffer;
    bbl::js::Nullable<double> offset;
    bbl::js::Nullable<double> size;
};
/** `GPUBindingResource`: a buffer binding, or a view or sampler. */
using GpuBindingResource = std::variant<GpuBufferBinding, GpuHandle>;
struct GpuBindGroupEntry {
    double binding = 0;
    GpuBindingResource resource;
};
struct GpuBindGroupDescriptor {
    bbl::js::Nullable<std::string> label;
    GpuHandle layout;
    js::Array<GpuBindGroupEntry> entries;
};
struct GpuTexelCopyTextureInfo {
    GpuHandle texture;
};
struct GpuTexelCopyBufferLayout {
    bbl::js::Nullable<double> offset;
    bbl::js::Nullable<double> bytes_per_row;
    bbl::js::Nullable<double> rows_per_image;
};
struct GpuRenderBundleEncoderDescriptor {
    js::Array<std::string> color_formats;
    bbl::js::Nullable<double> sample_count;
};
struct GpuRenderPassColorAttachment {
    GpuHandle view;
    bbl::js::Nullable<Color4d> clear_value;
    std::string load_op;
    std::string store_op;
};
struct GpuRenderPassDescriptor {
    js::Array<GpuRenderPassColorAttachment> color_attachments;
};

/** `GPUSupportedLimits`: the members a reached pin reads. */
struct GpuSupportedLimits {
    double max_buffer_size = 0;
    double max_storage_buffer_binding_size = 0;
    double max_compute_workgroups_per_dimension = 0;
    double max_color_attachment_bytes_per_sample = 0;
};
/** WebGPU's default limits: a device requested without `requiredLimits` reports these. */
inline constexpr GpuSupportedLimits gpu_default_limits{268435456, 134217728, 65535, 32};
/**
 * An engine's `requiredLimits` (`EngineOptions::required_limits`) over the
 * defaults, refusing a limit this port does not raise. A value below the
 * default keeps the default, as `requestDevice` does.
 */
inline GpuSupportedLimits
gpu_required_limits(const std::vector<std::pair<std::string, double>>& required) {
    GpuSupportedLimits result = gpu_default_limits;
    for (const auto& [name, value] : required) {
        double* limit = name == "maxBufferSize" ? &result.max_buffer_size
                        : name == "maxStorageBufferBindingSize"
                            ? &result.max_storage_buffer_binding_size
                        : name == "maxComputeWorkgroupsPerDimension"
                            ? &result.max_compute_workgroups_per_dimension
                        : name == "maxColorAttachmentBytesPerSample"
                            ? &result.max_color_attachment_bytes_per_sample
                            : nullptr;
        if (!limit)
            throw std::runtime_error("requestDevice: required limit '" + name +
                                     "' is not one this port raises.");
        if (!std::isfinite(value) || value < 0 || std::trunc(value) != value)
            throw std::runtime_error("requestDevice: required limit '" + name +
                                     "' is not a GPUSize64.");
        *limit = std::max(*limit, value);
    }
    return result;
}
/** `GPUBufferBindingLayout`; absent members take WebGPU's defaults. */
struct GpuBufferBindingLayout {
    bbl::js::Nullable<std::string> type;
    bbl::js::Nullable<bool> has_dynamic_offset;
    bbl::js::Nullable<double> min_binding_size;
};
/** `GPUTextureBindingLayout`. */
struct GpuTextureBindingLayout {
    bbl::js::Nullable<std::string> sample_type;
    bbl::js::Nullable<std::string> view_dimension;
    bbl::js::Nullable<bool> multisampled;
};
/** `GPUBindGroupLayoutEntry` with a buffer or a sampled texture. */
struct GpuBindGroupLayoutEntry {
    double binding = 0;
    double visibility = 0;
    bbl::js::Nullable<GpuBufferBindingLayout> buffer;
    bbl::js::Nullable<GpuTextureBindingLayout> texture;
};
struct GpuBindGroupLayoutDescriptor {
    bbl::js::Nullable<std::string> label;
    js::Array<GpuBindGroupLayoutEntry> entries;
};
struct GpuShaderModuleDescriptor {
    bbl::js::Nullable<std::string> label;
    std::string code;
};
struct GpuPipelineLayoutDescriptor {
    bbl::js::Nullable<std::string> label;
    js::Array<GpuHandle> bind_group_layouts;
};
/** `GPUProgrammableStage` without constants. */
struct GpuProgrammableStage {
    GpuHandle module;
    bbl::js::Nullable<std::string> entry_point;
};
/** `GPUComputePipelineDescriptor` with an explicit layout. */
struct GpuComputePipelineDescriptor {
    bbl::js::Nullable<std::string> label;
    GpuHandle layout;
    GpuProgrammableStage compute;
};
struct GpuBlendComponent {
    bbl::js::Nullable<std::string> operation;
    bbl::js::Nullable<std::string> src_factor;
    bbl::js::Nullable<std::string> dst_factor;
};
struct GpuBlendState {
    GpuBlendComponent color;
    GpuBlendComponent alpha;
};
struct GpuColorTargetState {
    std::string format;
    bbl::js::Nullable<GpuBlendState> blend;
    bbl::js::Nullable<double> write_mask;
};
struct GpuFragmentState {
    GpuHandle module;
    bbl::js::Nullable<std::string> entry_point;
    js::Array<GpuColorTargetState> targets;
};
struct GpuPrimitiveState {
    bbl::js::Nullable<std::string> topology;
    bbl::js::Nullable<std::string> cull_mode;
};
struct GpuDepthStencilState {
    std::string format;
    bbl::js::Nullable<bool> depth_write_enabled;
    bbl::js::Nullable<std::string> depth_compare;
};
struct GpuMultisampleState {
    bbl::js::Nullable<double> count;
};
/** `GPURenderPipelineDescriptor`: a vertex stage without vertex buffers. */
struct GpuRenderPipelineDescriptor {
    bbl::js::Nullable<std::string> label;
    GpuHandle layout;
    GpuProgrammableStage vertex;
    bbl::js::Nullable<GpuFragmentState> fragment;
    bbl::js::Nullable<GpuPrimitiveState> primitive;
    bbl::js::Nullable<GpuDepthStencilState> depth_stencil;
    bbl::js::Nullable<GpuMultisampleState> multisample;
};
struct GpuCommandEncoderDescriptor {
    bbl::js::Nullable<std::string> label;
};
struct GpuComputePassDescriptor {
    bbl::js::Nullable<std::string> label;
};

/** WebGPU's `GPUMapMode.READ`, the one mode `map_async` admits. */
inline constexpr double gpu_map_mode_read = 1;

/**
 * `GPUBuffer`'s mapping members. A buffer handle a WebGPU-subset device
 * creates implements them; `gpu_buffer_mapping` reaches them from the handle.
 */
struct GpuBufferMapping {
    GpuBufferMapping() = default;
    GpuBufferMapping(const GpuBufferMapping&) = delete;
    GpuBufferMapping& operator=(const GpuBufferMapping&) = delete;
    virtual ~GpuBufferMapping() = default;
    /** `getMappedRange(offset, size)`: a write mapping's bytes reach the buffer at `unmap()`. */
    virtual js::ArrayBuffer get_mapped_range(bbl::js::Nullable<double> offset,
                                             bbl::js::Nullable<double> size) = 0;
    virtual void unmap() = 0;
    /** `mapAsync(mode, offset, size)`, settled on the calling realm. */
    virtual js::Promise<js::PromiseVoid> map_async(double mode, bbl::js::Nullable<double> offset,
                                                   bbl::js::Nullable<double> size) = 0;
    /** `mapState`: "unmapped", "pending" or "mapped". */
    virtual std::string map_state() const = 0;
};
inline GpuBufferMapping& gpu_buffer_mapping(const GpuHandle& buffer) {
    auto* mapping = dynamic_cast<GpuBufferMapping*>(buffer.get());
    if (!mapping)
        throw std::runtime_error("GPU object is not a mappable buffer.");
    return *mapping;
}

/** `GPUComputePassEncoder`. */
struct GpuComputePassEncoder {
    GpuComputePassEncoder() = default;
    GpuComputePassEncoder(const GpuComputePassEncoder&) = delete;
    GpuComputePassEncoder& operator=(const GpuComputePassEncoder&) = delete;
    virtual ~GpuComputePassEncoder() = default;
    virtual void set_pipeline(const GpuHandle& pipeline) = 0;
    virtual void set_bind_group(double index, const GpuHandle& group,
                                const js::Array<double>& dynamic_offsets) = 0;
    void set_bind_group(double index, const GpuHandle& group) {
        set_bind_group(index, group, js::Array<double>{});
    }
    virtual void dispatch_workgroups(double x, double y, double z) = 0;
    void dispatch_workgroups(double x) { dispatch_workgroups(x, 1, 1); }
    void dispatch_workgroups(double x, double y) { dispatch_workgroups(x, y, 1); }
    virtual void dispatch_workgroups_indirect(const GpuHandle& buffer, double offset) = 0;
    virtual void end() = 0;
};
using GpuComputePassEncoderHandle = std::shared_ptr<GpuComputePassEncoder>;

/** `GPURenderPassEncoder` and `GPURenderBundleEncoder`. */
struct GpuEncoder {
    GpuEncoder() = default;
    GpuEncoder(const GpuEncoder&) = delete;
    GpuEncoder& operator=(const GpuEncoder&) = delete;
    virtual ~GpuEncoder() = default;
    virtual void set_pipeline(const GpuHandle& pipeline) = 0;
    virtual void set_vertex_buffer(double slot, const GpuHandle& buffer) = 0;
    virtual void set_bind_group(double index, const GpuHandle& group) = 0;
    virtual void draw(double vertices, double instances, double first_vertex,
                      double first_instance) = 0;
    /** `GPURenderBundleEncoder.finish()`. */
    virtual GpuHandle finish() {
        throw std::runtime_error("GPU pass encoder cannot finish a render bundle.");
    }
    /** `GPURenderPassEncoder.executeBundles(bundles)`. */
    virtual void execute_bundles(const js::Array<GpuHandle>&) {
        throw std::runtime_error("GPU bundle encoder cannot execute bundles.");
    }
    /** `GPURenderPassEncoder.end()`. */
    virtual void end() { throw std::runtime_error("GPU bundle encoder has no pass to end."); }
    /** `GPURenderPassEncoder.drawIndirect(indirectBuffer, indirectOffset)`. */
    virtual void draw_indirect(const GpuHandle&, double) {
        throw std::runtime_error("This GPU encoder does not draw indirectly.");
    }
};
using GpuEncoderHandle = std::shared_ptr<GpuEncoder>;

/** The reached `GPUCommandEncoder` surface. */
struct GpuCommandEncoder {
    GpuCommandEncoder() = default;
    GpuCommandEncoder(const GpuCommandEncoder&) = delete;
    GpuCommandEncoder& operator=(const GpuCommandEncoder&) = delete;
    virtual ~GpuCommandEncoder() = default;
    virtual GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor& descriptor) = 0;
    virtual GpuComputePassEncoderHandle begin_compute_pass(const GpuComputePassDescriptor&) {
        throw std::runtime_error("This GPU command encoder does not record compute passes.");
    }
    GpuComputePassEncoderHandle begin_compute_pass() {
        return begin_compute_pass(GpuComputePassDescriptor{});
    }
    /** `copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size)`. */
    virtual void copy_buffer_to_buffer(const GpuHandle&, double, const GpuHandle&, double, double) {
        throw std::runtime_error("This GPU command encoder does not copy buffers.");
    }
    /** `clearBuffer(buffer, offset, size)`; an absent size clears to the buffer's end. */
    virtual void clear_buffer(const GpuHandle&, bbl::js::Nullable<double>,
                              bbl::js::Nullable<double>) {
        throw std::runtime_error("This GPU command encoder does not clear buffers.");
    }
    void clear_buffer(const GpuHandle& buffer) { clear_buffer(buffer, {}, {}); }
    /** `finish()`: the `GPUCommandBuffer` its device's `submit` takes. */
    virtual GpuHandle finish() {
        throw std::runtime_error("This GPU command encoder is finished by its renderer.");
    }
};
using GpuCommandEncoderHandle = std::shared_ptr<GpuCommandEncoder>;

/** Byte views over WebGPU sizes (`gpu_size`, `gpu_u32` in runtime.hpp). */
inline std::span<const std::uint8_t> gpu_bytes(std::span<const std::uint8_t> data, double offset,
                                               double size) {
    const auto start = gpu_size(offset), count = gpu_size(size);
    if (start > data.size() || count > data.size() - start)
        throw std::runtime_error("GPU write exceeds its source bytes.");
    return data.subspan(start, count);
}
inline std::span<const std::uint8_t> gpu_bytes(const js::ArrayBuffer& data, double offset,
                                               double size) {
    return gpu_bytes({data.data(), data.byte_length()}, offset, size);
}

/** `GPUDevice` and its ordered queue. Resource transports own native handles and lifetimes. */
struct GpuDevice {
    GpuDevice() = default;
    GpuDevice(const GpuDevice&) = delete;
    GpuDevice& operator=(const GpuDevice&) = delete;
    virtual ~GpuDevice() = default;
    virtual const void* device_identity() const { return nullptr; }
    void require_own_resource(const GpuObject& resource) const {
        if (const auto identity = device_identity();
            identity && resource.device_identity() != identity)
            throw std::runtime_error("GPU write destination belongs to another device.");
    }
    virtual GpuHandle create_buffer(const GpuBufferDescriptor&) {
        throw std::runtime_error("This GPU device does not provide buffer creation.");
    }
    virtual GpuHandle create_texture(const GpuTextureDescriptor&) {
        throw std::runtime_error("This GPU device does not provide texture creation.");
    }
    virtual GpuHandle create_bind_group(const GpuBindGroupDescriptor&) {
        throw std::runtime_error("This GPU device does not provide bind groups.");
    }
    virtual GpuEncoderHandle create_render_bundle_encoder(const GpuRenderBundleEncoderDescriptor&) {
        throw std::runtime_error("This GPU device does not provide render bundles.");
    }
    /** `GPUDevice.limits`. */
    virtual GpuSupportedLimits limits() const {
        throw std::runtime_error("This GPU device does not report its limits.");
    }
    virtual GpuHandle create_bind_group_layout(const GpuBindGroupLayoutDescriptor&) {
        throw std::runtime_error("This GPU device does not provide bind group layouts.");
    }
    virtual GpuHandle create_shader_module(const GpuShaderModuleDescriptor&) {
        throw std::runtime_error("This GPU device does not provide shader modules.");
    }
    virtual GpuHandle create_pipeline_layout(const GpuPipelineLayoutDescriptor&) {
        throw std::runtime_error("This GPU device does not provide pipeline layouts.");
    }
    virtual GpuHandle create_compute_pipeline(const GpuComputePipelineDescriptor&) {
        throw std::runtime_error("This GPU device does not provide compute pipelines.");
    }
    virtual GpuHandle create_render_pipeline(const GpuRenderPipelineDescriptor&) {
        throw std::runtime_error("This GPU device does not provide render pipelines.");
    }
    virtual GpuCommandEncoderHandle create_command_encoder(const GpuCommandEncoderDescriptor&) {
        throw std::runtime_error("This GPU device does not provide command encoders.");
    }
    GpuCommandEncoderHandle create_command_encoder() {
        return create_command_encoder(GpuCommandEncoderDescriptor{});
    }
    /** `GPUQueue.submit(commandBuffers)`. */
    virtual void submit(const js::Array<GpuHandle>&) {
        throw std::runtime_error("This GPU device does not submit command buffers.");
    }
    /** `GPUQueue.onSubmittedWorkDone()`, settled on the calling realm. */
    virtual js::Promise<js::PromiseVoid> on_submitted_work_done() {
        throw std::runtime_error("This GPU device does not report submitted work.");
    }
    void write_buffer(GpuObject& buffer, std::size_t offset, std::span<const std::uint8_t> bytes) {
        require_own_resource(buffer);
        if (const auto capacity = buffer.buffer_capacity();
            capacity && (offset > *capacity || bytes.size() > *capacity - offset))
            throw std::runtime_error("GPU buffer write exceeds its allocation.");
        buffer.write_buffer_bytes(offset, bytes);
    }
    void write_buffer(const GpuHandle& buffer, double offset, std::span<const std::uint8_t> data) {
        if (!buffer)
            throw std::runtime_error("GPU buffer write has no destination.");
        write_buffer(*buffer, gpu_size(offset), data);
    }
    void write_buffer(const GpuHandle& buffer, double buffer_offset, const js::ArrayBuffer& data,
                      double data_offset, double size) {
        write_buffer(buffer, buffer_offset, gpu_bytes(data, data_offset, size));
    }
    /** `writeBuffer(buffer, offset, data)`: all of an ArrayBuffer. */
    void write_buffer(const GpuHandle& buffer, double buffer_offset, const js::ArrayBuffer& data) {
        write_buffer(buffer, buffer_offset,
                     std::span<const std::uint8_t>{data.data(), data.byte_length()});
    }
    /** `writeBuffer(buffer, offset, view)`: all of a typed array's elements. */
    template <typename T>
    void write_buffer(const GpuHandle& buffer, double buffer_offset,
                      const js::TypedArray<T>& data) {
        write_buffer(buffer, buffer_offset, typed_array_bytes(data));
    }
    void write_texture(GpuObject& texture, std::span<const std::uint8_t> data,
                       const GpuTextureWriteLayout& layout, const GpuWriteExtent& size) {
        require_own_resource(texture);
        if (layout.offset > data.size())
            throw std::runtime_error("GPU texture write exceeds its source bytes.");
        texture.write_texture_bytes(data, layout, size);
    }
    void write_texture(const GpuTexelCopyTextureInfo& destination, const js::ArrayBuffer& data,
                       const GpuTexelCopyBufferLayout& layout, const GpuExtent3D& size) {
        write_texture(destination, std::span<const std::uint8_t>{data.data(), data.byte_length()},
                      layout, size);
    }
    /** `writeTexture` from a typed array: the layout's offset counts from the view's start. */
    template <typename T>
    void write_texture(const GpuTexelCopyTextureInfo& destination, const js::TypedArray<T>& data,
                       const GpuTexelCopyBufferLayout& layout, const GpuExtent3D& size) {
        write_texture(destination, typed_array_bytes(data), layout, size);
    }

    void write_texture(const GpuTexelCopyTextureInfo& destination,
                       std::span<const std::uint8_t> data, const GpuTexelCopyBufferLayout& layout,
                       const GpuExtent3D& size) {
        if (!destination.texture)
            throw std::runtime_error("GPU texture write has no destination.");
        GpuTextureWriteLayout bytes{gpu_size(layout.offset.value_or(0)), {}, {}};
        if (layout.bytes_per_row)
            bytes.bytes_per_row = gpu_u32(gpu_size(*layout.bytes_per_row));
        if (layout.rows_per_image)
            bytes.rows_per_image = gpu_u32(gpu_size(*layout.rows_per_image));
        write_texture(*destination.texture, data, bytes,
                      {gpu_u32(gpu_size(size.width)), gpu_u32(gpu_size(size.height)),
                       gpu_u32(gpu_size(size.depth_or_array_layers))});
    }

private:
    template <typename T>
    static std::span<const std::uint8_t> typed_array_bytes(const js::TypedArray<T>& data) {
        const auto buffer = data.buffer();
        return {buffer.data() + data.byte_offset(), data.byte_length()};
    }
};
using GpuDeviceHandle = std::shared_ptr<GpuDevice>;

/** `queue.writeBuffer(buffer, offset, data)` with an ArrayBuffer or typed-array source. */
template <typename... Sources>
void gpu_queue_write_buffer(GpuDevice& device, const GpuHandle& buffer, double offset,
                            const std::variant<Sources...>& data) {
    std::visit([&](const auto& source) { device.write_buffer(buffer, offset, source); }, data);
}

/**
 * `queue.writeBuffer(buffer, offset, data, dataOffset, size)`: a range of the
 * source, in bytes for an ArrayBuffer and in elements for a typed array,
 * counted from the view's start, as WebGPU defines it.
 */
template <typename... Sources>
void gpu_queue_write_buffer(GpuDevice& device, const GpuHandle& buffer, double offset,
                            const std::variant<Sources...>& data, double data_offset, double size) {
    std::visit(
        [&](const auto& source) {
            using Source = std::remove_cvref_t<decltype(source)>;
            if constexpr (std::is_same_v<Source, js::ArrayBuffer>) {
                device.write_buffer(buffer, offset, source, data_offset, size);
            } else {
                constexpr double element = sizeof(typename Source::value_type);
                const auto bytes = source.buffer();
                device.write_buffer(
                    buffer, offset,
                    gpu_bytes({bytes.data() + source.byte_offset(), source.byte_length()},
                              data_offset * element, size * element));
            }
        },
        data);
}

} // namespace bbl
