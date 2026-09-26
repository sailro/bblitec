#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>

namespace bbl {
struct GpuWriteExtent {
    std::uint32_t width = 0, height = 1, depth_or_array_layers = 1;
};
struct GpuTextureWriteLayout {
    std::size_t offset = 0;
    std::optional<std::uint32_t> bytes_per_row, rows_per_image;
};

/** A GPU object a device created: a buffer, texture, view, bind group
 *  or layout, pipeline or render bundle. Generated code holds it by
 *  identity; only the backend that created it looks inside. */
struct GpuObject {
    /** `GPUBuffer.size`, in bytes; zero for every other object. */
    double size = 0;
    GpuObject() = default;
    GpuObject(const GpuObject&) = delete;
    GpuObject& operator=(const GpuObject&) = delete;
    virtual ~GpuObject() = default;
    virtual const void* device_identity() const { return nullptr; }
    /** A known buffer extent; borrowed platform destinations may leave it unknown. */
    virtual std::optional<std::size_t> buffer_capacity() const { return std::nullopt; }
    virtual void write_buffer_bytes(std::size_t, std::span<const std::uint8_t>) {
        throw std::runtime_error("GPU object is not a writable buffer.");
    }
    virtual void write_texture_bytes(std::span<const std::uint8_t>, const GpuTextureWriteLayout&,
                                     const GpuWriteExtent&) {
        throw std::runtime_error("GPU object is not a writable texture.");
    }
    /** `GPUBuffer.destroy()` / `GPUTexture.destroy()`. */
    virtual void destroy() {}
    /** `GPUTexture.createView()`. */
    virtual std::shared_ptr<GpuObject> create_view() {
        throw std::runtime_error("GPU object has no texture view.");
    }
};
using GpuHandle = std::shared_ptr<GpuObject>;

} // namespace bbl
