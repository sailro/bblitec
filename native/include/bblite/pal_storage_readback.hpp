#pragma once
#include <bblite/pal_offscreen.hpp>
#include <limits>
#include <cmath>

namespace bbl::pal {
struct StorageReadbackDescriptor {
    std::string label;
    std::size_t size = 0;
    std::uint32_t usage = 0;
};
/** WebGPU staging/map operations; native callbacks contain no JavaScript values. */
struct StorageReadback {
    virtual ~StorageReadback() = default;
    virtual std::size_t byte_length() const = 0;
    virtual void destroy() = 0;
    virtual void copy_from(const std::shared_ptr<StorageBufferAllocation>&, std::size_t,
                           std::size_t, std::size_t, const std::string&) = 0;
    virtual std::unique_ptr<OffscreenCompletion>
    map_async(std::size_t, std::size_t, std::function<void(std::exception_ptr)>) = 0;
    virtual std::span<const std::uint8_t> mapped_range(std::size_t, std::size_t) = 0;
    virtual void unmap() = 0;
};
inline std::size_t storage_readback_size(double value) {
    if (!std::isfinite(value) || value < 0 || std::trunc(value) != value ||
        value >= static_cast<double>(std::numeric_limits<std::size_t>::max()))
        throw std::runtime_error("Storage readback range exceeds the native API.");
    return static_cast<std::size_t>(value);
}
struct StorageReadbackCopy {
    std::string label;
    std::shared_ptr<StorageBufferAllocation> source;
    std::shared_ptr<StorageReadback> target;
    std::size_t source_offset = 0, target_offset = 0, length = 0;
    bool finished = false;
    void copy(std::shared_ptr<StorageBufferAllocation> input, double offset,
              std::shared_ptr<StorageReadback> output, double to, double count) {
        source = std::move(input);
        target = std::move(output);
        source_offset = storage_readback_size(offset);
        target_offset = storage_readback_size(to);
        length = storage_readback_size(count);
    }
    void finish() {
        if (finished)
            throw std::runtime_error("Storage readback encoder was already finished.");
        finished = true;
    }
    void submit() {
        if (!finished || !source || !target)
            throw std::runtime_error("Storage readback copy is not ready.");
        target->copy_from(source, source_offset, target_offset, length, label);
    }
};
} // namespace bbl::pal
