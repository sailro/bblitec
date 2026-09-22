#include <cassert>
#include <bblite/pal_compute_command.hpp>
struct Allocation final : bbl::pal::StorageBufferAllocation {
    std::vector<std::uint8_t> bytes;
    void destroy() override { bytes.clear(); }
    void write(std::size_t offset, std::span<const std::uint8_t> value) override {
        std::copy(value.begin(), value.end(), bytes.begin() + static_cast<std::ptrdiff_t>(offset));
    }
};
struct Staging final : bbl::pal::StorageReadback {
    std::vector<std::uint8_t> bytes;
    bool destroyed = false;
    int copies = 0, maps = 0, unmaps = 0;
    explicit Staging(std::size_t length) : bytes(length) {}
    std::size_t byte_length() const override { return bytes.size(); }
    void destroy() override { destroyed = true; }
    void copy_from(const std::shared_ptr<bbl::pal::StorageBufferAllocation>& allocation,
                   std::size_t offset, std::size_t target, std::size_t length,
                   const std::string&) override {
        auto input = std::dynamic_pointer_cast<Allocation>(allocation);
        assert(input && !destroyed);
        ++copies;
        std::copy_n(input->bytes.begin() + static_cast<std::ptrdiff_t>(offset), length,
                    bytes.begin() + static_cast<std::ptrdiff_t>(target));
    }
    std::unique_ptr<bbl::pal::OffscreenCompletion>
    map_async(std::size_t, std::size_t, std::function<void(std::exception_ptr)> complete) override {
        ++maps;
        complete({});
        return {};
    }
    std::span<const std::uint8_t> mapped_range(std::size_t offset, std::size_t length) override {
        if (destroyed)
            throw std::runtime_error("destroyed staging");
        return {bytes.data() + offset, length};
    }
    void unmap() override { ++unmaps; }
};
struct Device final : bbl::pal::OffscreenDevice {
    std::vector<std::shared_ptr<Staging>> staging;
    double maximum_storage_buffer_size() const override { return 4096; }
    std::shared_ptr<bbl::pal::StorageBufferAllocation>
    create_storage_buffer(const bbl::pal::StorageBufferDescriptor& descriptor,
                          std::optional<std::span<const std::uint8_t>> initial) override {
        auto value = std::make_shared<Allocation>();
        value->bytes.resize(descriptor.byte_length);
        if (initial)
            std::copy(initial->begin(), initial->end(), value->bytes.begin());
        return value;
    }
    std::shared_ptr<bbl::pal::StorageReadback>
    create_storage_readback(const bbl::pal::StorageReadbackDescriptor& descriptor) override {
        assert(descriptor.label == "payload-readback" && descriptor.usage == 9);
        auto value = std::make_shared<Staging>(descriptor.size);
        staging.push_back(value);
        return value;
    }
};
bbl::js::Promise<bool> rejected(bbl::js::Promise<bbl::js::ArrayBuffer> promise,
                                const std::string expected) {
    try {
        (void)co_await promise;
    } catch (const std::exception& error) {
        co_return std::string(error.what()).find(expected) != std::string::npos;
    }
    co_return false;
}
bbl::js::Promise<bbl::js::PromiseVoid> checks(bbl::pal::EventLoop& loop, bool& done) {
    auto engine = std::make_shared<bbl::Engine>();
    auto device = std::make_shared<Device>();
    engine->offscreen_run = std::make_shared<bbl::pal::OffscreenRun>(
        std::make_shared<bbl::pal::OffscreenSurface>(1, 1), device);
    bbl::StorageBufferOptions options;
    options.writable = true;
    options.label = "payload";
    std::vector<std::uint8_t> input(64);
    for (std::size_t i = 0; i < input.size(); ++i)
        input[i] = static_cast<std::uint8_t>(i);
    const auto buffer = bbl::create_gpu_storage_buffer(engine, {64, false, input}, options);
    auto first = bbl::read_gpu_storage_buffer(buffer, 4, 16),
         same = bbl::read_gpu_storage_buffer(buffer, 4, 16),
         next = bbl::read_gpu_storage_buffer(buffer, 20, 8);
    assert(first == same && !(first == next) && device->staging.size() == 1 &&
           device->staging[0]->copies == 1);
    auto previous = engine->offscreen_run;
    engine->offscreen_run = std::make_shared<bbl::pal::OffscreenRun>(
        std::make_shared<bbl::pal::OffscreenSurface>(1, 1), std::make_shared<Device>());
    auto changed = bbl::read_gpu_storage_buffer(buffer, 4, 16);
    engine->offscreen_run = previous;
    assert(co_await rejected(changed, "device changed"));
    const auto a = co_await first, b = co_await next;
    assert(a.byte_length() == 16 && a.data()[0] == 4 && a.data()[15] == 19 &&
           b.byte_length() == 8 && b.data()[0] == 20 && device->staging.size() == 1 &&
           device->staging[0]->maps == 2 && device->staging[0]->unmaps == 2);
    const auto whole = co_await bbl::read_gpu_storage_buffer(buffer);
    assert(whole.byte_length() == 64 && whole.data()[63] == 63 && device->staging.size() == 2 &&
           device->staging[0]->destroyed);
    const auto empty = co_await bbl::read_gpu_storage_buffer(buffer, 64, 0);
    assert(empty.byte_length() == 0 && device->staging.size() == 2);
    assert(co_await rejected(bbl::read_gpu_storage_buffer(buffer, 1, 4), "byteOffset"));
    assert(co_await rejected(bbl::read_gpu_storage_buffer(buffer, 0, 6), "byteLength"));
    assert(co_await rejected(bbl::read_gpu_storage_buffer(buffer, 60, 8), "64-byte capacity"));
    engine->current_compute_encoder = std::make_shared<bbl::pal::ComputeCommandEncoder>(device);
    auto active = bbl::read_gpu_storage_buffer(buffer);
    engine->current_compute_encoder.reset();
    assert(co_await rejected(active, "frame encoder is active"));
    options.writable = false;
    const auto readonly = bbl::create_gpu_storage_buffer(engine, {64, false, input}, options);
    assert(co_await rejected(bbl::read_gpu_storage_buffer(readonly), "requires a writable"));
    auto pending = bbl::read_gpu_storage_buffer(buffer);
    bbl::dispose_storage_buffer(*engine, buffer);
    assert(co_await rejected(pending, "destroyed staging"));
    assert(!engine->storage_buffers[buffer.value].gpu->readback_state->pending);
    assert(co_await rejected(bbl::read_gpu_storage_buffer(buffer), "not a live registered"));
    bbl::dispose_storage_buffer(*engine, readonly);
    done = true;
    loop.close();
    co_return bbl::js::PromiseVoid{};
}
int main() {
    bbl::js::RealmScope realm;
    bbl::pal::EventLoop loop;
    bool done = false;
    loop.run([&] { checks(loop, done); });
    assert(done);
}
