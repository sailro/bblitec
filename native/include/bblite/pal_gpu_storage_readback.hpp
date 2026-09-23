#pragma once
#include <bblite/pal_gpu_storage_buffer.hpp>
#include <bblite/pal_storage_readback.hpp>
#include <bblite/js_promise.hpp>

namespace bbl::pal {
struct StorageReadbackState {
    std::shared_ptr<StorageReadback> staging;
    std::shared_ptr<OffscreenDevice> device;
    std::optional<js::Promise<js::ArrayBuffer>> pending;
    std::optional<double> offset, length;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(pending); }
};
inline js::Promise<js::PromiseVoid>
map_storage_readback(const std::shared_ptr<StorageReadback>& staging, double mode, double offset,
                     double length) {
    if (mode != 1)
        throw std::runtime_error("Storage readback only supports read mapping.");
    struct Completion final : CompletionEvent {
        std::exception_ptr error;
        Completion(std::uint64_t id, std::exception_ptr value)
            : CompletionEvent(id), error(value) {}
    };
    struct Pending {
        std::shared_ptr<StorageReadback> staging;
        std::unique_ptr<OffscreenCompletion> operation;
    };
    js::Promise<js::PromiseVoid> result;
    auto pending = std::make_shared<Pending>(Pending{staging, {}});
    auto& loop = EventLoop::current();
    const auto id =
        loop.register_completion([result, pending](std::unique_ptr<ExternalEvent> event) {
            auto* completion = dynamic_cast<Completion*>(event.get());
            if (!completion)
                throw std::logic_error("Incorrect storage map completion payload.");
            if (completion->error)
                result.reject(completion->error);
            else
                result.resolve(js::PromiseVoid{});
        });
    try {
        pending->operation =
            staging->map_async(storage_readback_size(offset), storage_readback_size(length),
                               [inbox = loop.inbox(), id](std::exception_ptr error) {
                                   inbox->post(std::make_unique<Completion>(id, std::move(error)));
                               });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}
inline js::ArrayBuffer copy_mapped_storage_readback(const std::shared_ptr<StorageReadback>& staging,
                                                    double offset, double length) {
    const auto bytes =
        staging->mapped_range(storage_readback_size(offset), storage_readback_size(length));
    return js::ArrayBuffer(std::vector<std::uint8_t>(bytes.begin(), bytes.end()));
}
} // namespace bbl::pal
namespace bbl {
js::Promise<js::ArrayBuffer> read_gpu_storage_buffer(StorageBufferHandle,
                                                     std::optional<double> offset = {},
                                                     std::optional<double> length = {});
}
