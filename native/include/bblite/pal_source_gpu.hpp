#pragma once

#include <bblite/runtime.hpp>
#include <bblite/pal_gpu_retirement.hpp>
#include <bblite/pal_offscreen.hpp>

namespace bbl::pal {

inline GpuCompletion submitted_gpu_work(const std::shared_ptr<OffscreenDevice>& device) {
    struct Completion final : CompletionEvent {
        std::exception_ptr error;
        Completion(std::uint64_t id, std::exception_ptr failure)
            : CompletionEvent(id), error(failure) {}
    };
    struct Pending {
        std::shared_ptr<OffscreenDevice> device;
        std::unique_ptr<OffscreenCompletion> operation;
    };
    GpuCompletion result;
    auto& loop = EventLoop::current();
    auto pending = std::make_shared<Pending>(Pending{device, {}});
    const auto id =
        loop.register_completion([result, pending](std::unique_ptr<ExternalEvent> event) {
            auto* completion = dynamic_cast<Completion*>(event.get());
            if (!completion)
                throw std::logic_error("Incorrect GPU completion payload.");
            if (completion->error)
                result.reject(completion->error);
            else
                result.resolve(js::PromiseVoid{});
        });
    try {
        if (!device)
            throw std::runtime_error("Engine has no GPU device.");
        pending->operation = device->notify_submitted_work_done(
            [inbox = loop.inbox(), id](std::exception_ptr error) {
                inbox->post(std::make_unique<Completion>(id, std::move(error)));
            });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}

inline std::shared_ptr<GpuRetirementState> gpu_retirement_state(Engine& engine) {
    if (!engine.gpu_retirements) {
        auto state = std::make_shared<GpuRetirementState>();
        state->submitted_work_done = [&engine] {
            return submitted_gpu_work(engine.device_disposed ? std::shared_ptr<OffscreenDevice>{}
                                                             : engine.source_gpu_device);
        };
        engine.gpu_retirements = state;
        engine.flush_gpu_retirements = [state] {
            if (state->flush)
                state->flush(state);
        };
        engine.dispose_gpu_retirements = [state] { dispose_gpu_resource_retirements(state); };
    }
    return engine.gpu_retirements;
}

inline GpuCompletion submitted_gpu_work(const std::shared_ptr<OffscreenRun>& run) {
    try {
        return submitted_gpu_work(run ? std::shared_ptr<OffscreenDevice>(run, &run->device())
                                      : std::shared_ptr<OffscreenDevice>{});
    } catch (...) {
        GpuCompletion result;
        result.reject(std::current_exception());
        return result;
    }
}

inline OffscreenDevice& source_gpu_device(Engine& engine) {
    if (!engine.source_gpu_device || engine.device_disposed)
        throw std::runtime_error("Engine has no GPU device.");
    return *engine.source_gpu_device;
}

} // namespace bbl::pal
