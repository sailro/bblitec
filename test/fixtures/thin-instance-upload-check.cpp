#include <bblite/gpu.hpp>
#include <bblite/thin_instance.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <cassert>
#include <functional>
#include <iostream>

using namespace bbl;
std::vector<std::function<void()>> retired;
namespace bbl::pal {
std::shared_ptr<GpuRetirementState> gpu_retirement_state(Engine&) { return {}; }
} // namespace bbl::pal
namespace bbl {
void retire_gpu_resources(std::shared_ptr<pal::GpuRetirementState>, pal::GpuRetirement release) {
    retired.push_back(std::move(release));
}
} // namespace bbl
void flush_retired() {
    auto pending = std::move(retired);
    retired.clear();
    for (const auto& release : pending)
        release();
}
struct RecordingBuffer final : GpuObject {
    unsigned id;
    bool& fail_write;
    RecordingBuffer(unsigned index, double bytes, bool& fail) : id(index), fail_write(fail) {
        size = bytes;
    }
    std::optional<std::size_t> buffer_capacity() const override {
        return static_cast<std::size_t>(size);
    }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        if (fail_write) {
            fail_write = false;
            std::cout << "F," << id << ',' << offset << ',' << bytes.size() << '\n';
            throw std::runtime_error("fixture write failure");
        }
        std::cout << "W," << id << ',' << offset;
        for (const auto byte : bytes)
            std::cout << ',' << static_cast<unsigned>(byte);
        std::cout << '\n';
    }
    void destroy() override { std::cout << "D," << id << '\n'; }
};
struct RecordingDevice final : GpuDevice {
    unsigned next_buffer = 0;
    bool fail_write = false;
    GpuHandle create_buffer(const GpuBufferDescriptor& descriptor) override {
        const auto id = next_buffer++;
        std::cout << "C," << id << ',' << descriptor.size << ',' << descriptor.usage << '\n';
        return std::make_shared<RecordingBuffer>(id, descriptor.size, fail_write);
    }
};
void snapshot(const ThinInstancePoolData& pool) {
    std::cout << "S," << pool.count << ',' << pool.capacity << ',' << pool.version << ','
              << pool.gpu_version << ',' << pool.dirty_min << ',' << pool.dirty_max << ','
              << pool.color_version << ',' << pool.color_gpu_version << ',' << pool.color_dirty_min
              << ',' << pool.color_dirty_max << ',' << pool.draw_args_instance_count.value_or(-99)
              << ',' << (pool.upload_f32.has_value() ? pool.upload_f32.value().size() : 0) << '\n';
}
#include "thin-source.hpp"
int main() {
    std::cout << std::unitbuf;
#include "operations.inc"
    assert(retired.empty());
}
