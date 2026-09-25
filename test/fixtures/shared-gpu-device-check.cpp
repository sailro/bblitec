#include <bblite/gpu.hpp>
#include <bblite/pal_offscreen.hpp>
#include <cassert>
#include <limits>

using namespace bbl;

struct Device final : GpuDevice {
    const void* owner;
    explicit Device(const void* identity) : owner(identity) {}
    const void* device_identity() const override { return owner; }
};
struct Buffer final : pal::StorageBufferAllocation {
    const void* owner;
    std::vector<std::uint8_t> bytes = std::vector<std::uint8_t>(32, 0xcc);
    unsigned writes = 0;
    bool destroyed = false;
    explicit Buffer(const void* identity) : owner(identity) {}
    const void* device_identity() const override { return owner; }
    std::optional<std::size_t> buffer_capacity() const override { return bytes.size(); }
    void destroy() override { destroyed = true; }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> source) override {
        if (destroyed)
            throw std::runtime_error("destroyed buffer");
        ++writes;
        std::copy(source.begin(), source.end(),
                  bytes.begin() + static_cast<std::ptrdiff_t>(offset));
    }
};
struct Texture final : GpuObject {
    const void* owner;
    std::vector<std::uint8_t> bytes;
    unsigned writes = 0;
    explicit Texture(const void* identity) : owner(identity) {}
    const void* device_identity() const override { return owner; }
    void write_texture_bytes(std::span<const std::uint8_t> source,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        assert(layout.offset == 4 && layout.bytes_per_row == 8 && layout.rows_per_image == 3);
        assert(extent.width == 4 && extent.height == 2 && extent.depth_or_array_layers == 2);
        ++writes;
        for (std::size_t layer = 0; layer < 2; ++layer)
            for (std::size_t row = 0; row < 2; ++row) {
                const auto offset = layout.offset + layer * 24 + row * 8;
                bytes.insert(bytes.end(), source.begin() + static_cast<std::ptrdiff_t>(offset),
                             source.begin() + static_cast<std::ptrdiff_t>(offset + 4));
            }
    }
};
template <class Call> void refused(Call call) {
    bool threw = false;
    try {
        call();
    } catch (const std::runtime_error&) {
        threw = true;
    }
    assert(threw);
}
int main() {
    static_assert(std::is_base_of_v<GpuDevice, pal::OffscreenDevice>);
    int first = 1, second = 2;
    Device device(&first), foreign(&second);
    auto buffer = std::make_shared<Buffer>(&first);
    auto texture = std::make_shared<Texture>(&first);
    std::vector<std::uint8_t> pattern(64);
    for (std::size_t i = 0; i < pattern.size(); ++i)
        pattern[i] = static_cast<std::uint8_t>(i);
    js::ArrayBuffer source(pattern);

    // The source record's ArrayBuffer call and compute's byte-view call share one destination.
    device.write_buffer(buffer, 4, source, 8, 8);
    device.write_buffer(buffer, 16, std::span<const std::uint8_t>(pattern).subspan(24, 4));
    assert(buffer->writes == 2 && buffer->bytes[3] == 0xcc && buffer->bytes[12] == 0xcc);
    assert(buffer->bytes[4] == 8 && buffer->bytes[11] == 15 && buffer->bytes[16] == 24);
    refused([&] { device.write_buffer(buffer, 28, source, 0, 8); });
    refused([&] { device.write_buffer(buffer, 0, source, 60, 8); });
    refused([&] { device.write_buffer(buffer, -1, source, 0, 4); });
    refused([&] { device.write_buffer(buffer, 0, source, 0.5, 4); });
    refused([&] {
        device.write_buffer(buffer, 0, source, 0, std::numeric_limits<double>::infinity());
    });
    refused([&] { foreign.write_buffer(buffer, 0, source, 0, 4); });
    refused([&] { device.write_buffer(GpuHandle{}, 0, source, 0, 4); });
    assert(buffer->writes == 2);

    device.write_texture({texture}, source, {4, 8, 3}, {4, 2, 2});
    assert((texture->bytes ==
            std::vector<std::uint8_t>{4, 5, 6, 7, 12, 13, 14, 15, 28, 29, 30, 31, 36, 37, 38, 39}));
    refused([&] { foreign.write_texture({texture}, source, {4, 8, 3}, {4, 2, 2}); });
    refused([&] { device.write_texture({texture}, source, {65, 8, 3}, {4, 2, 2}); });
    assert(texture->writes == 1);

    buffer->destroy();
    refused([&] { device.write_buffer(buffer, 0, source, 0, 4); });
    assert(buffer->writes == 2);
}
