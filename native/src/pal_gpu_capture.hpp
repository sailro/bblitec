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

struct GpuWrittenRange { std::size_t offset = 0, bytes = 0; };
struct GpuWriteCapture {
    std::uint64_t sequence = 0, frame = 0;
    std::size_t offset = 0, bytes = 0;
};
struct GpuResourceCapture {
    std::uint64_t id = 0;
    std::string role;
    std::size_t allocation_bytes = 0, width = 0, rows = 0;
    bool destroyed = false;
    // Gaps are placeholders; only written_ranges describe observed memory.
    std::vector<std::uint8_t> uploaded_bytes;
    std::vector<GpuWrittenRange> written_ranges;
    std::vector<GpuWriteCapture> writes;
};

/** Receipts of actual PAL allocations and writes, enabled only on request. */
class GpuUploadCapture {
public:
    explicit GpuUploadCapture(bool enabled = false) : enabled_(enabled) {}
    bool enabled() const noexcept { return enabled_; }
    void stop() noexcept { enabled_ = false; }
    std::uint64_t frame() const noexcept { return frame_; }
    const auto& resources() const noexcept { return resources_; }

    std::uint64_t create_resource(std::string_view role, std::size_t allocation_bytes,
        std::size_t width = 0, std::size_t rows = 0) {
        if (!enabled_) return 0;
        GpuResourceCapture resource;
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
            throw std::runtime_error("GPU upload receipt exceeds its resource allocation.");
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

    void destroy(std::uint64_t id) { if (enabled_) find(id).destroyed = true; }
    void begin_frame(std::uint64_t frame) { if (enabled_) frame_ = frame; }

private:
    GpuResourceCapture& find(std::uint64_t id) {
        if (!id || id > resources_.size()) throw std::runtime_error("Unknown GPU capture resource.");
        return resources_[static_cast<std::size_t>(id - 1)];
    }
    bool enabled_ = false;
    std::uint64_t frame_ = 0, sequence_ = 0;
    std::vector<GpuResourceCapture> resources_;
};

} // namespace bbl::pal
