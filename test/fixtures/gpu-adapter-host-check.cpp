#include <bblite/pal_worker.hpp>
#include <cassert>

namespace {
struct Services final : bbl::pal::HostServices {
    bool fail = false;
    const void* graphics_identity() const override { return this; }
    std::optional<bbl::pal::GpuAdapterInfo> graphics_adapter_info() const override {
        if (fail)
            throw std::runtime_error("metadata query failed");
        return bbl::pal::GpuAdapterInfo{"apple", {}, {}, "Unrelated description"};
    }
};
} // namespace
int main() {
    using namespace bbl;
    assert(pal::gpu_adapter_vendor(0x106b) == "apple");
    assert(pal::gpu_adapter_vendor(0).empty());
    assert(pal::gpu_adapter_vendor(0xffff) == "0xffff");
    assert(pal::gpu_adapter_hex_id(0).empty());
    const js::RealmScope scope;
    {
        pal::EventLoop loop;
        pal::WorkerRealm realm(loop);
        bool synchronous = true, observed = false;
        loop.run([&] {
            realm.request_graphics_adapter().then([&](const auto& value) {
                assert(!synchronous && !value.has_value());
                observed = true;
                loop.close();
            });
            synchronous = false;
        });
        assert(observed);
    }
    {
        pal::EventLoop loop;
        auto services = std::make_shared<Services>();
        pal::WorkerRealm realm(loop, "", services);
        bool observed = false;
        loop.run([&] {
            realm.request_graphics_adapter().then([&](const auto& adapter) {
                assert(adapter.has_value());
                auto info = adapter.value()->info;
                js::collect_cycles();
                assert(info == adapter.value()->info && info->vendor == "apple");
                services->fail = true;
                realm.request_graphics_adapter().catch_error([&](std::exception_ptr error) {
                    try {
                        std::rethrow_exception(error);
                    } catch (const std::runtime_error& failure) {
                        assert(std::string(failure.what()) == "metadata query failed");
                    }
                    observed = true;
                    loop.close();
                    return js::Nullable<pal::GpuAdapterHandle>{std::nullopt};
                });
            });
        });
        assert(observed);
    }
    {
        pal::EventLoop loop;
        pal::WorkerRealm realm(loop, "", std::make_shared<Services>());
        std::shared_ptr<pal::Worker> worker;
        bool observed = false;
        loop.run([&] {
            worker = realm.create_worker([](pal::WorkerRealm& child) {
                child.request_graphics_adapter().then([&child](const auto& adapter) {
                    assert(adapter.has_value());
                    child.post_message(js::serialize_message(adapter.value()->info->vendor));
                    child.close();
                });
            });
            worker->add_message_listener([&](const pal::WorkerMessage& event) {
                assert(event->data<std::string>() == "apple");
                observed = true;
                loop.close();
            });
        });
        assert(observed);
    }
}
