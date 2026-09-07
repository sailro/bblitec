#define main generated_main
#include "primed.hpp"
#undef main
#include <cassert>

namespace bbl {
void run_deferred_callbacks(Engine& engine) {
    auto callbacks = std::move(engine.deferred_callbacks);
    engine.deferred_callbacks.clear();
    for (const auto& callback : callbacks) callback();
}
void run_timeout_callbacks(Engine&) {}
void run_interval_callbacks(Engine&) {}
}
namespace bbl::pal {
double performance_milliseconds() { return 16.0; }
// Execute the real conductor, with GPU work replaced by the observing scene.
#include "dispatch.hpp"
}

namespace bbl {
std::vector<js::Callback<void(float)>> render_callbacks;
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
void on_before_render(Scene&, js::Callback<void(float)> callback) {
    render_callbacks.push_back(std::move(callback));
}
void defer_start_continuation(Engine& engine, std::function<void()> callback) {
    engine.deferred_callbacks.push_back(std::move(callback));
}
void start_engine(Engine& engine) {
    for (int frame = 0; frame < 4; ++frame) {
        pal::run_animation_frame_callbacks(engine);
        for (const auto& callback : render_callbacks) callback(16.0f);
        pal::finish_frame(engine);
    }
    assert(engine.animation_frame_once_callbacks.empty());
    assert(engine.post_render_animation_frame_once_callbacks.empty());
    render_callbacks.clear();
}
}

int main() {
    // Advancing one engine must not select the phase of another engine's RAF.
    bbl::Engine first;
    bbl::Engine second;
    bbl::pal::finish_frame(first);
    unsigned first_calls = 0;
    unsigned second_calls = 0;
    bbl::request_animation_frame(first, [&](double) { ++first_calls; });
    bbl::request_animation_frame(second, [&](double) { ++second_calls; });
    bbl::pal::run_animation_frame_callbacks(first);
    bbl::pal::run_animation_frame_callbacks(second);
    assert(first_calls == 0 && second_calls == 1);
    bbl::pal::finish_frame(first);
    assert(first_calls == 1);

    const auto initial = bbl::js::managed_node_count();
    assert(generated_main() == 0);
    bbl::js::collect_cycles();
    assert(bbl::js::managed_node_count() == initial);
}
