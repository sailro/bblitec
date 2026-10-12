#pragma once

#include <bblite/pal_iteration.hpp>
#include <bblite/pal_source_gpu.hpp>

namespace bbl::pal {

/** Execute each legacy renderer turn, including its submit, before the microtask checkpoint. */
inline Iteration<int> source_gpu_iterations(Engine& engine, Iteration<int> frames) {
    if (!engine.source_gpu_loop) {
        engine.source_gpu_loop = std::make_shared<EventLoop>();
        engine.source_gpu_loop->defer_cleanup(
            [state = gpu_retirement_state(engine)] { dispose_gpu_resource_retirements(state); });
    }
    const auto loop = engine.source_gpu_loop;
    for (;;) {
        bool completed = false, advanced = false;
        loop->post([&] {
            advanced = frames.advance();
            completed = true;
        });
        while (!completed) {
            if (!loop->poll())
                throw std::runtime_error("The GPU frame task was not dispatched.");
        }
        if (!advanced)
            co_return frames.result();
        co_yield true;
    }
}

} // namespace bbl::pal
