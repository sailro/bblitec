#pragma once

#include "pal_gpu_capture.hpp"

namespace bbl::pal {

using TextGpuResourceCapture = GpuResourceCapture;
struct TextGpuConstantCapture {
    std::uint32_t id = 0;
    double value = 0;
};
struct TextGpuBindingCapture {
    std::uint32_t binding = 0;
    std::string role;
    std::uint64_t resource = 0, view = 0;
};
struct TextGpuDrawCapture {
    std::uint64_t pipeline = 0, group = 0, quad = 0, instances = 0;
    std::string color_format, depth_format, depth_compare;
    std::string topology, cull_mode, front_face;
    std::string color_src_factor, color_dst_factor, color_operation;
    std::string alpha_src_factor, alpha_dst_factor, alpha_operation;
    std::uint32_t samples = 0;
    std::uint32_t sample_mask = 0xffffffffu;
    bool depth_write = false, blend_enabled = false, alpha_to_coverage = false;
    std::vector<TextGpuConstantCapture> vertex_constants, fragment_constants;
    std::vector<TextGpuBindingCapture> bindings;
    std::uint32_t vertices = 0, instance_count = 0, first_vertex = 0, first_instance = 0;
    // SDL records the bytes passed to its uniform push for this draw. Dawn's
    // group resource ID identifies its actual queue-written uniform buffer.
    std::vector<std::uint8_t> pushed_uniform_bytes;
};

// Direct native fixtures include this header without pal.hpp's default and
// use the full capture, as they use the full PAL.
#if !defined(BBLITE_VISUAL_CAPTURE) || BBLITE_VISUAL_CAPTURE
/** Observations of actual PAL operations, never a source-data reconstruction.
 * Enable only for a requested render capture, and stop after its serialization. */
class TextGpuCapture : public GpuUploadCapture {
public:
    using GpuUploadCapture::GpuUploadCapture;
    const auto& draws() const noexcept { return draws_; }
    void begin_frame(std::uint64_t frame) {
        if (!enabled()) return;
        GpuUploadCapture::begin_frame(frame);
        draws_.clear();
    }
    void draw(TextGpuDrawCapture receipt) {
        if (enabled()) draws_.push_back(std::move(receipt));
    }

private:
    std::vector<TextGpuDrawCapture> draws_;
};
#else
/**
 * The shipping shape: no receipt is kept and `enabled()` is a constant
 * false, so every `capture.enabled()` branch of the text resource headers
 * folds away and a text record carries no capture storage.
 */
class TextGpuCapture {
public:
    explicit TextGpuCapture(bool = false) noexcept {}
    static constexpr bool enabled() noexcept { return false; }
    void stop() noexcept {}
    void begin_frame(std::uint64_t) noexcept {}
    std::uint64_t create_resource(
        std::string_view, std::size_t, std::size_t = 0, std::size_t = 0) noexcept {
        return 0;
    }
    void write(std::uint64_t, std::size_t, std::span<const std::uint8_t>) noexcept {}
    void destroy(std::uint64_t) noexcept {}
    void draw(TextGpuDrawCapture) noexcept {}
};
#endif

} // namespace bbl::pal
