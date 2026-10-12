#pragma once
#include <bblite/pal_offscreen.hpp>
#include <bblite/joining_thread.hpp>
#include "pal_dawn_string.hpp"
#include <webgpu/webgpu.h>
#include <atomic>
#include <limits>
#include <memory>
#include <stdexcept>
#include <type_traits>

namespace bbl::pal {
struct DawnCompletionState {
    std::function<void(std::exception_ptr)> complete;
    std::atomic<bool> delivered = false;
    explicit DawnCompletionState(std::function<void(std::exception_ptr)> callback)
        : complete(std::move(callback)) {}
    void deliver(std::exception_ptr error) {
        if (!delivered.exchange(true))
            complete(error);
    }
};

/** Drive a native future even while the realm is awaiting its first rendered frame. */
struct DawnFutureCompletion final : OffscreenCompletion {
    JoiningThread waiter;
    static auto instance_owner(WGPUInstance instance) {
        wgpuInstanceAddRef(instance);
        return std::shared_ptr<std::remove_pointer_t<WGPUInstance>>(instance, wgpuInstanceRelease);
    }
    DawnFutureCompletion(WGPUInstance instance, WGPUFuture future,
                         std::shared_ptr<DawnCompletionState> state)
        : waiter([owner = instance_owner(instance), future, state = std::move(state)] {
              WGPUFutureWaitInfo info{};
              info.future = future;
              const auto status = wgpuInstanceWaitAny(owner.get(), 1, &info,
                                                      std::numeric_limits<std::uint64_t>::max());
              if (status != WGPUWaitStatus_Success)
                  state->deliver(std::make_exception_ptr(
                      std::runtime_error("Dawn asynchronous GPU completion wait failed.")));
          }) {}
};

/** `queue.onSubmittedWorkDone()`: `complete` runs once the queue's earlier submissions finish. */
inline std::unique_ptr<OffscreenCompletion>
dawn_queue_work_done(WGPUInstance instance, WGPUQueue queue,
                     std::function<void(std::exception_ptr)> complete) {
    auto state = std::make_shared<DawnCompletionState>(std::move(complete));
    WGPUQueueWorkDoneCallbackInfo callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_WaitAnyOnly;
    callback.userdata1 = new std::shared_ptr<DawnCompletionState>(state);
    callback.callback = [](WGPUQueueWorkDoneStatus status, WGPUStringView message, void* userdata,
                           void*) {
        const std::unique_ptr<std::shared_ptr<DawnCompletionState>> handler(
            static_cast<std::shared_ptr<DawnCompletionState>*>(userdata));
        (*handler)->deliver(status == WGPUQueueWorkDoneStatus_Success
                                ? std::exception_ptr{}
                                : std::make_exception_ptr(std::runtime_error(
                                      "GPU queue completion failed: " + view_text(message))));
    };
    const auto future = wgpuQueueOnSubmittedWorkDone(queue, callback);
    return std::make_unique<DawnFutureCompletion>(instance, future, std::move(state));
}

/** `buffer.mapAsync(READ, offset, size)`: `complete` runs once the range is mapped or failed. */
inline std::unique_ptr<OffscreenCompletion>
dawn_buffer_map_read(WGPUInstance instance, WGPUBuffer buffer, std::size_t offset,
                     std::size_t count, std::function<void(std::exception_ptr)> complete) {
    auto state = std::make_shared<DawnCompletionState>(std::move(complete));
    WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_WaitAnyOnly;
    callback.userdata1 = new std::shared_ptr<DawnCompletionState>(state);
    callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView message, void* data, void*) {
        const std::unique_ptr<std::shared_ptr<DawnCompletionState>> owner(
            static_cast<std::shared_ptr<DawnCompletionState>*>(data));
        (*owner)->deliver(status == WGPUMapAsyncStatus_Success
                              ? std::exception_ptr{}
                              : std::make_exception_ptr(std::runtime_error(
                                    "Dawn buffer mapping failed: " + view_text(message))));
    };
    const auto future = wgpuBufferMapAsync(buffer, WGPUMapMode_Read, offset, count, callback);
    return std::make_unique<DawnFutureCompletion>(instance, future, std::move(state));
}
} // namespace bbl::pal
