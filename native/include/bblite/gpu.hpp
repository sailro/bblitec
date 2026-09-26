#pragma once

#include <bblite/js_data.hpp>
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
};
using GpuEncoderHandle = std::shared_ptr<GpuEncoder>;

/** The reached `GPUCommandEncoder` render-pass surface. */
struct GpuCommandEncoder {
    GpuCommandEncoder() = default;
    GpuCommandEncoder(const GpuCommandEncoder&) = delete;
    GpuCommandEncoder& operator=(const GpuCommandEncoder&) = delete;
    virtual ~GpuCommandEncoder() = default;
    virtual GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor& descriptor) = 0;
};
using GpuCommandEncoderHandle = std::shared_ptr<GpuCommandEncoder>;

/** WebGPU sizes and byte views, shared by source records and platform destinations. */
inline std::size_t gpu_size(double value) {
    if (!std::isfinite(value) || value < 0 || std::trunc(value) != value ||
        value > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
        throw std::runtime_error("GPU extent is not a supported WebGPU size.");
    return static_cast<std::size_t>(value);
}
inline std::uint32_t gpu_u32(std::size_t value) {
    if (value > std::numeric_limits<std::uint32_t>::max())
        throw std::runtime_error("GPU extent exceeds the native API's 32-bit range.");
    return static_cast<std::uint32_t>(value);
}
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
    void write_texture(GpuObject& texture, std::span<const std::uint8_t> data,
                       const GpuTextureWriteLayout& layout, const GpuWriteExtent& size) {
        require_own_resource(texture);
        if (layout.offset > data.size())
            throw std::runtime_error("GPU texture write exceeds its source bytes.");
        texture.write_texture_bytes(data, layout, size);
    }
    void write_texture(const GpuTexelCopyTextureInfo& destination, const js::ArrayBuffer& data,
                       const GpuTexelCopyBufferLayout& layout, const GpuExtent3D& size) {
        if (!destination.texture)
            throw std::runtime_error("GPU texture write has no destination.");
        GpuTextureWriteLayout bytes{gpu_size(layout.offset.value_or(0)), {}, {}};
        if (layout.bytes_per_row)
            bytes.bytes_per_row = gpu_u32(gpu_size(*layout.bytes_per_row));
        if (layout.rows_per_image)
            bytes.rows_per_image = gpu_u32(gpu_size(*layout.rows_per_image));
        write_texture(*destination.texture, {data.data(), data.byte_length()}, bytes,
                      {gpu_u32(gpu_size(size.width)), gpu_u32(gpu_size(size.height)),
                       gpu_u32(gpu_size(size.depth_or_array_layers))});
    }
};
using GpuDeviceHandle = std::shared_ptr<GpuDevice>;

} // namespace bbl
