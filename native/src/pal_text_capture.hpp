#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pal {

struct TextGpuWrittenRange {
    std::size_t offset = 0, bytes = 0;
};
struct TextGpuWriteCapture {
    std::uint64_t sequence = 0, frame = 0;
    std::size_t offset = 0, bytes = 0;
};
struct TextGpuResourceCapture {
    std::uint64_t id = 0;
    std::string role;
    std::size_t allocation_bytes = 0, width = 0, rows = 0;
    bool destroyed = false;
    // Only written_ranges are observed bytes. Gaps in uploaded_bytes are
    // placeholders, not a claim about uninitialized native GPU memory.
    std::vector<std::uint8_t> uploaded_bytes;
    std::vector<TextGpuWrittenRange> written_ranges;
    std::vector<TextGpuWriteCapture> writes;
};
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

/** Observations of actual PAL operations, never a source-data reconstruction.
 * Enable only for a requested render capture, and stop after its serialization. */
class TextGpuCapture {
public:
    explicit TextGpuCapture(bool enabled = false) : enabled_(enabled) {}

    bool enabled() const noexcept { return enabled_; }
    void stop() noexcept { enabled_ = false; }
    std::uint64_t frame() const noexcept { return frame_; }
    const auto& resources() const noexcept { return resources_; }
    const auto& draws() const noexcept { return draws_; }

    std::uint64_t create_resource(std::string_view role, std::size_t allocation_bytes,
        std::size_t width = 0, std::size_t rows = 0) {
        if (!enabled_) return 0;
        TextGpuResourceCapture resource;
        resource.id = resources_.size() + 1;
        resource.role = role;
        resource.allocation_bytes = allocation_bytes;
        resource.width = width;
        resource.rows = rows;
        resources_.push_back(std::move(resource));
        return resources_.back().id;
    }

    void write(std::uint64_t id, std::size_t offset, std::span<const std::uint8_t> bytes) {
        if (!enabled_) return;
        auto& resource = find(id);
        if (offset > resource.allocation_bytes || bytes.size() > resource.allocation_bytes - offset) {
            throw std::runtime_error("Text upload receipt exceeds its resource allocation.");
        }
        resource.writes.push_back({++sequence_, frame_, offset, bytes.size()});
        if (bytes.empty()) return;
        resource.uploaded_bytes.resize(std::max(resource.uploaded_bytes.size(), offset + bytes.size()));
        std::copy(bytes.begin(), bytes.end(), resource.uploaded_bytes.begin() + static_cast<std::ptrdiff_t>(offset));
        auto& ranges = resource.written_ranges;
        ranges.push_back({offset, bytes.size()});
        std::sort(ranges.begin(), ranges.end(), [](const auto& a, const auto& b) { return a.offset < b.offset; });
        std::size_t count = 0;
        for (const auto range : ranges) {
            if (!count || ranges[count - 1].offset + ranges[count - 1].bytes < range.offset) {
                ranges[count++] = range;
            } else {
                auto& previous = ranges[count - 1];
                previous.bytes = std::max(previous.offset + previous.bytes, range.offset + range.bytes) - previous.offset;
            }
        }
        ranges.resize(count);
    }

    void destroy(std::uint64_t id) {
        if (enabled_) find(id).destroyed = true;
    }
    void begin_frame(std::uint64_t frame) {
        if (!enabled_) return;
        frame_ = frame;
        draws_.clear();
    }
    void draw(TextGpuDrawCapture receipt) {
        if (enabled_) draws_.push_back(std::move(receipt));
    }

private:
    TextGpuResourceCapture& find(std::uint64_t id) {
        if (!id || id > resources_.size()) throw std::runtime_error("Unknown text GPU capture resource.");
        return resources_[static_cast<std::size_t>(id - 1)];
    }
    bool enabled_ = false;
    std::uint64_t frame_ = 0, sequence_ = 0;
    std::vector<TextGpuResourceCapture> resources_;
    std::vector<TextGpuDrawCapture> draws_;
};

} // namespace bbl::pal
