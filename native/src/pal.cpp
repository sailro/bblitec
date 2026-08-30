#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <vector>
#include <utility>

#include <SDL3/SDL_filesystem.h>

namespace bbl {

/**
 * `setTimeout(callback, 0)`: queue a callback to run once, at the next
 * frame boundary.
 *
 * Not generated, because `setTimeout` is not a Babylon symbol -- there is
 * no pinned declaration to lower from. It is a platform service the frame
 * conductor provides, so it lives here beside the engine record that
 * holds the queue, and only the scenes that reach it pay for it.
 */
void defer_callback(Engine& engine, std::function<void()> callback) {
    engine.deferred_callbacks.push_back(std::move(callback));
}

void run_deferred_callbacks(Engine& engine) {
    if (engine.deferred_callbacks.empty()) {
        return;
    }
    // Moved out first: a callback that queues another is served on the
    // NEXT frame, which is what a browser does with a zero-delay timeout
    // queued from inside one. Draining in place would run it now.
    std::vector<std::function<void()>> due;
    due.swap(engine.deferred_callbacks);
    for (const auto& callback : due) {
        callback();
    }
}

double set_timeout(
    Engine& engine,
    std::function<void()> callback,
    double delay_ms) {
    if (!std::isfinite(delay_ms) || delay_ms < 0.0) {
        throw std::runtime_error("setTimeout requires a finite non-negative delay.");
    }
    const std::uint64_t id = engine.next_timeout_id++;
    engine.timeout_callbacks.push_back(Engine::TimeoutCallback{
        id,
        pal::performance_milliseconds() + delay_ms,
        std::move(callback),
    });
    return static_cast<double>(id);
}

void run_timeout_callbacks(Engine& engine) {
    const double now_ms = engine.animation_frame_timestamp_ms;
    std::vector<std::function<void()>> due;
    std::erase_if(
        engine.timeout_callbacks,
        [&](Engine::TimeoutCallback& timeout) {
            if (now_ms < timeout.due_ms) return false;
            due.push_back(std::move(timeout.callback));
            return true;
        });
    for (const auto& callback : due) {
        callback();
    }
}

double set_interval(
    Engine& engine,
    std::function<void()> callback,
    double period_ms) {
    if (!std::isfinite(period_ms) || period_ms < 0.0) {
        throw std::runtime_error("setInterval requires a finite non-negative delay.");
    }
    const std::uint64_t id = engine.next_interval_id++;
    const double clamped_period_ms = std::max(1.0, period_ms);
    engine.interval_callbacks.push_back(Engine::IntervalCallback{
        id,
        clamped_period_ms,
        pal::performance_milliseconds() + clamped_period_ms,
        std::move(callback),
        true,
    });
    return static_cast<double>(id);
}

void clear_interval(Engine& engine, double id) {
    const std::uint64_t numeric_id = static_cast<std::uint64_t>(id);
    for (Engine::IntervalCallback& interval : engine.interval_callbacks) {
        if (interval.id == numeric_id) {
            interval.active = false;
            break;
        }
    }
}

void run_interval_callbacks(Engine& engine) {
    const double now_ms = engine.animation_frame_timestamp_ms;
    std::vector<std::uint64_t> due;
    for (Engine::IntervalCallback& interval : engine.interval_callbacks) {
        if (!interval.active || now_ms < interval.next_due_ms) continue;
        do {
            interval.next_due_ms += interval.period_ms;
        } while (interval.next_due_ms <= now_ms);
        due.push_back(interval.id);
    }
    for (const std::uint64_t id : due) {
        const auto found = std::find_if(
            engine.interval_callbacks.begin(),
            engine.interval_callbacks.end(),
            [id](const Engine::IntervalCallback& interval) {
                return interval.id == id && interval.active;
            });
        if (found != engine.interval_callbacks.end()) {
            const std::function<void()> callback = found->callback;
            callback();
        }
    }
    std::erase_if(
        engine.interval_callbacks,
        [](const Engine::IntervalCallback& interval) {
            return !interval.active;
        });
}

}  // namespace bbl

namespace bbl::pal {

std::string environment_variable(const char* name);

// Every scene reaches the engine through here, so this is where the
// executable reports which sources it was built from. bblitec sets
// BBLITE_BUILD_STAMP_OUT before a measured run and refuses the result
// when the stamp no longer matches the generated tree on disk.
static void report_build_stamp() {
    const std::string path =
        environment_variable("BBLITE_BUILD_STAMP_OUT");
    if (path.empty()) {
        return;
    }
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) {
        throw std::runtime_error(
            "Unable to write the build stamp to '" + path + "'.");
    }
    // Through the one stamp-owning TU (pal_build_stamp.cpp), so this
    // object too stays byte-identical across scenes.
    stream << bblite_build_stamp();
}

Engine create_engine(EngineOptions options) {
    report_build_stamp();
    Engine engine;
    engine.options = std::move(options);
    return engine;
}

std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("Unable to open file '" + path + "'.");
    }
    return std::vector<std::uint8_t>(
        std::istreambuf_iterator<char>(stream),
        std::istreambuf_iterator<char>());
}

std::string join_path(const std::string& root, const std::string& relative_path) {
    return (std::filesystem::path(root) / relative_path).lexically_normal().string();
}

std::string parent_path(const std::string& path) {
    return std::filesystem::path(path).parent_path().string();
}

std::string executable_directory() {
    const char* base_path = SDL_GetBasePath();
    if (!base_path || !*base_path) {
        throw std::runtime_error("SDL_GetBasePath failed.");
    }
    return std::filesystem::path(base_path).lexically_normal().string();
}

std::string environment_variable(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t length = 0;
    if (_dupenv_s(&value, &length, name) != 0 || !value) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    const char* value = std::getenv(name);
    return value ? value : "";
#endif
}

double monotonic_milliseconds() {
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    return std::chrono::duration<double, std::milli>(now).count();
}

namespace {

struct PerformanceClockState {
    bool initialized = false;
    bool fixed = false;
    double milliseconds = 0.0;
};

PerformanceClockState& performance_clock_state() {
    static thread_local PerformanceClockState state;
    if (!state.initialized) {
        const std::string fixed_delta =
            environment_variable("BBLITE_FRAME_DELTA_MS");
        state.fixed = !fixed_delta.empty() &&
            std::strtod(fixed_delta.c_str(), nullptr) > 0.0;
        state.milliseconds = state.fixed ? 0.0 : monotonic_milliseconds();
        state.initialized = true;
    }
    return state;
}

} // namespace

double performance_milliseconds() {
    auto& state = performance_clock_state();
    return state.fixed ? state.milliseconds : monotonic_milliseconds();
}

void advance_performance_milliseconds(float delta_ms) {
    auto& state = performance_clock_state();
    if (state.fixed && delta_ms > 0.0f) {
        state.milliseconds += static_cast<double>(delta_ms);
    }
}

} // namespace bbl::pal
