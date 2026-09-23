#pragma once

#include "pal_sdl_gpu_shared.hpp"
#include <bblite/pal_gpu_timestamp.hpp>
#include <algorithm>
#include <cstring>
#include <limits>

#ifndef SDL_BBLITE_GPU_TIMESTAMPS
#error Rebuild SDL with the maintained gpu-timestamp-queries.patch.
#endif

namespace bbl::pal {

/** Exact integer conversion, including frequencies whose fractional product overflows uint64. */
inline std::uint64_t sdl_timestamp_nanoseconds(std::uint64_t ticks, std::uint64_t frequency) {
    constexpr std::uint64_t scale = 1000000000;
    if (!frequency || ticks / frequency > std::numeric_limits<std::uint64_t>::max() / scale)
        throw std::runtime_error("GPU timestamp duration or frequency is invalid.");
    const auto seconds = ticks / frequency;
    const auto remainder = ticks % frequency;
    std::uint64_t fraction = 0;
    if (remainder <= std::numeric_limits<std::uint64_t>::max() / scale) {
        fraction = remainder * scale / frequency;
    } else {
        std::uint64_t residual = 0;
        for (std::uint64_t bit = 1ULL << 29; bit; bit >>= 1) {
            fraction *= 2;
            if (residual >= frequency - residual) {
                residual -= frequency - residual;
                ++fraction;
            } else {
                residual += residual;
            }
            if ((scale & bit) != 0) {
                if (residual >= frequency - remainder) {
                    residual -= frequency - remainder;
                    ++fraction;
                } else {
                    residual += remainder;
                }
            }
        }
    }
    const auto result = seconds * scale;
    if (fraction > std::numeric_limits<std::uint64_t>::max() - result)
        throw std::runtime_error("GPU timestamp duration exceeds the nanosecond range.");
    return result + fraction;
}

/** Keep backward samples backward so the source timer can reject them. */
inline void normalize_sdl_timestamps(std::vector<std::uint64_t>& values, std::uint64_t frequency) {
    if (values.empty())
        return;
    const auto origin = *std::min_element(values.begin(), values.end());
    for (auto& value : values)
        value = sdl_timestamp_nanoseconds(value - origin, frequency);
}

struct SdlGpuTimestampTransfer {
    OwnedSdlTransfer buffer;
    OwnedSdlFence fence;
    explicit SdlGpuTimestampTransfer(SDL_GPUDevice* device, Uint32 count)
        : buffer(nullptr, {device}), fence(nullptr, {device}) {
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
        info.size = count * static_cast<Uint32>(sizeof(Uint64));
        buffer.reset(SDL_CreateGPUTransferBuffer(device, &info));
        if (!buffer)
            gpu_error("SDL timestamp readback allocation");
    }
};

struct SdlGpuTimestampQuerySet final : GpuTimestampQuerySet {
    SDL_GPUDevice* device;
    SDL_GPUTimestampQueryPool* pool;
    const std::uint32_t count;
    const std::uint64_t frequency;
    std::vector<std::shared_ptr<SdlGpuTimestampTransfer>> transfers;

    SdlGpuTimestampQuerySet(SDL_GPUDevice* owner, std::uint32_t capacity)
        : device(owner), pool(SDL_BBLiteCreateGPUTimestampQueryPool(owner, capacity)),
          count(capacity), frequency(SDL_BBLiteGetGPUTimestampFrequency(owner)) {
        if (!pool)
            gpu_error("SDL timestamp query allocation");
    }
    ~SdlGpuTimestampQuerySet() override {
        // The timer reuses its pool. Final release can also follow an aborted frame.
        SDL_WaitForGPUIdle(device);
        SDL_BBLiteReleaseGPUTimestampQueryPool(device, pool);
    }

    std::shared_ptr<SdlGpuTimestampTransfer> acquire_transfer() {
        for (const auto& transfer : transfers) {
            if (transfer.use_count() == 1 &&
                (!transfer->fence || SDL_QueryGPUFence(device, transfer->fence.get()))) {
                transfer->fence.reset();
                return transfer;
            }
        }
        auto transfer = std::make_shared<SdlGpuTimestampTransfer>(device, count);
        transfers.push_back(transfer);
        return transfer;
    }
};

inline void encode_sdl_gpu_timestamp(SDL_GPUCommandBuffer* command,
                                     const GpuTimestampWrite& write) {
    const auto* queries = dynamic_cast<const SdlGpuTimestampQuerySet*>(write.query_set.get());
    if (!queries || write.index >= queries->count)
        throw std::runtime_error("SDL timestamp query index or backend is invalid.");
    if (!SDL_BBLiteWriteGPUTimestamp(command, queries->pool, write.index))
        gpu_error("SDL timestamp write");
}

/** Every resolve owns distinct storage while the query heap is reused on the queue. */
struct SdlGpuTimestampReadback final : GpuTimestampReadback {
    std::shared_ptr<SdlGpuTimestampQuerySet> queries;
    std::shared_ptr<SdlGpuTimestampTransfer> transfer;
    std::uint32_t count;

    SdlGpuTimestampReadback(std::shared_ptr<SdlGpuTimestampQuerySet> source, std::uint32_t length)
        : queries(std::move(source)), count(length) {
        if (!count || count > queries->count ||
            count > std::numeric_limits<Uint32>::max() / sizeof(Uint64))
            throw std::runtime_error("SDL timestamp resolve range is invalid.");
        transfer = queries->acquire_transfer();
        SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(queries->device)};
        if (!command)
            gpu_error("SDL timestamp resolve command");
        if (!SDL_BBLiteResolveGPUTimestamps(command, queries->pool, count, transfer->buffer.get()))
            gpu_error("SDL timestamp resolve");
        transfer->fence.reset(command.submit_with_fence());
        if (!transfer->fence)
            gpu_error("SDL timestamp resolve submit");
    }

    std::optional<std::vector<std::uint64_t>> poll() override {
        if (!SDL_QueryGPUFence(queries->device, transfer->fence.get()))
            return std::nullopt;
        std::vector<std::uint64_t> values(count);
        const auto* mapped = static_cast<const Uint64*>(
            SDL_MapGPUTransferBuffer(queries->device, transfer->buffer.get(), false));
        if (!mapped)
            gpu_error("SDL timestamp readback map");
        std::memcpy(values.data(), mapped, values.size() * sizeof(Uint64));
        SDL_UnmapGPUTransferBuffer(queries->device, transfer->buffer.get());
        normalize_sdl_timestamps(values, queries->frequency);
        return values;
    }
};

} // namespace bbl::pal
