#pragma once

#include "pal_dawn_resources.hpp"
#include <bblite/pal_gpu_timestamp.hpp>

namespace bbl::pal {

using DawnQuerySet = DawnOwned<WGPUQuerySet, wgpuQuerySetRelease>;

struct DawnGpuTimestampQuerySet final : GpuTimestampQuerySet {
    WGPUInstance instance;
    WGPUDevice device;
    WGPUQueue queue;
    DawnQuerySet queries;
    DawnBuffer resolve_buffer;
    std::uint32_t capacity;
    std::vector<DawnBuffer> readback_pool;

    DawnGpuTimestampQuerySet(WGPUInstance context, WGPUDevice owner, WGPUQueue submitted,
                             std::uint32_t count)
        : instance(context), device(owner), queue(submitted), capacity(count) {
        WGPUQuerySetDescriptor descriptor = WGPU_QUERY_SET_DESCRIPTOR_INIT;
        descriptor.type = WGPUQueryType_Timestamp;
        descriptor.count = count;
        queries = require_dawn_resource(wgpuDeviceCreateQuerySet(device, &descriptor),
                                        "GPU timestamp query set");
        WGPUBufferDescriptor buffer = WGPU_BUFFER_DESCRIPTOR_INIT;
        buffer.size = static_cast<std::uint64_t>(count) * sizeof(std::uint64_t);
        buffer.usage = WGPUBufferUsage_QueryResolve | WGPUBufferUsage_CopySrc;
        resolve_buffer = require_dawn_resource(wgpuDeviceCreateBuffer(device, &buffer),
                                               "GPU timestamp resolve buffer");
    }

    DawnBuffer acquire_readback() {
        if (!readback_pool.empty()) {
            auto buffer = std::move(readback_pool.back());
            readback_pool.pop_back();
            return buffer;
        }
        WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
        descriptor.size = static_cast<std::uint64_t>(capacity) * sizeof(std::uint64_t);
        descriptor.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
        return DawnBuffer{require_dawn_resource(wgpuDeviceCreateBuffer(device, &descriptor),
                                                "GPU timestamp readback buffer")};
    }
};

inline void encode_dawn_gpu_timestamp(WGPUCommandEncoder encoder, const GpuTimestampWrite& write) {
    const auto* queries = dynamic_cast<const DawnGpuTimestampQuerySet*>(write.query_set.get());
    if (!queries || write.index >= queries->capacity)
        throw std::runtime_error("GPU timestamp write requires a compatible live query set.");
    WGPUPassTimestampWrites timestamp = WGPU_PASS_TIMESTAMP_WRITES_INIT;
    timestamp.querySet = queries->queries;
    if (write.beginning)
        timestamp.beginningOfPassWriteIndex = write.index;
    else
        timestamp.endOfPassWriteIndex = write.index;
    WGPUComputePassDescriptor descriptor = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
    descriptor.timestampWrites = &timestamp;
    const auto pass = require_dawn_resource(
        wgpuCommandEncoderBeginComputePass(encoder, &descriptor), "GPU timestamp marker pass");
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
}

struct DawnGpuTimestampReadback final : GpuTimestampReadback {
    struct Completion {
        bool complete = false;
        std::string error;
    };
    std::shared_ptr<DawnGpuTimestampQuerySet> owner;
    DawnBuffer buffer;
    std::uint32_t count;
    std::shared_ptr<Completion> completion = std::make_shared<Completion>();
    WGPUFuture future{};

    DawnGpuTimestampReadback(std::shared_ptr<DawnGpuTimestampQuerySet> queries,
                             std::uint32_t query_count)
        : owner(std::move(queries)), buffer(owner->acquire_readback()), count(query_count) {
        if (!count || count > owner->capacity)
            throw std::runtime_error("GPU timestamp resolve range is invalid.");
        const auto byte_length = static_cast<std::uint64_t>(count) * sizeof(std::uint64_t);
        DawnCommandEncoder encoder{
            require_dawn_resource(wgpuDeviceCreateCommandEncoder(owner->device, nullptr),
                                  "GPU timestamp resolve encoder")};
        wgpuCommandEncoderResolveQuerySet(encoder, owner->queries, 0, count, owner->resolve_buffer,
                                          0);
        wgpuCommandEncoderCopyBufferToBuffer(encoder, owner->resolve_buffer, 0, buffer, 0,
                                             byte_length);
        DawnCommandBuffer command{require_dawn_resource(wgpuCommandEncoderFinish(encoder, nullptr),
                                                        "GPU timestamp resolve command")};
        submit_dawn_command(owner->queue, command);

        WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_WaitAnyOnly;
        callback.userdata1 = new std::shared_ptr<Completion>(completion);
        callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView message, void* userdata,
                               void*) {
            const std::unique_ptr<std::shared_ptr<Completion>> state(
                static_cast<std::shared_ptr<Completion>*>(userdata));
            (*state)->complete = true;
            if (status != WGPUMapAsyncStatus_Success)
                (*state)->error = "GPU timestamp readback mapping failed: " + view_text(message);
        };
        future = wgpuBufferMapAsync(buffer, WGPUMapMode_Read, 0,
                                    static_cast<std::size_t>(byte_length), callback);
    }

    ~DawnGpuTimestampReadback() override {
        if (buffer) {
            wgpuBufferDestroy(buffer);
            // Destruction cancels an outstanding map; service its callback without waiting.
            WGPUFutureWaitInfo info{};
            info.future = future;
            (void)wgpuInstanceWaitAny(owner->instance, 1, &info, 0);
        }
    }

    std::optional<std::vector<std::uint64_t>> poll() override {
        WGPUFutureWaitInfo info{};
        info.future = future;
        const auto status = wgpuInstanceWaitAny(owner->instance, 1, &info, 0);
        if (status == WGPUWaitStatus_TimedOut)
            return std::nullopt;
        if (status != WGPUWaitStatus_Success || !completion->complete)
            throw std::runtime_error("GPU timestamp readback polling failed.");
        if (!completion->error.empty())
            throw std::runtime_error(completion->error);
        const auto* values = static_cast<const std::uint64_t*>(wgpuBufferGetConstMappedRange(
            buffer, 0, static_cast<std::size_t>(count) * sizeof(std::uint64_t)));
        if (!values)
            throw std::runtime_error("GPU timestamp readback range is not mapped.");
        std::vector<std::uint64_t> result(values, values + count);
        wgpuBufferUnmap(buffer);
        owner->readback_pool.push_back(std::move(buffer));
        return result;
    }
};

} // namespace bbl::pal
