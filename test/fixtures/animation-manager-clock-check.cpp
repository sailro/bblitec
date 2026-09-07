#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
#include <vector>

namespace bbl { void mark_mesh_runtime_transform(Engine&, MeshHandle) {} }

struct Observation { double value; double step; };
int main() {
    using namespace bbl;
    Engine engine;
    double value = 0;
    std::vector<Observation> observations;
    auto manager = create_animation_manager(engine, {0.0, [&](double step) { observations.push_back({value, step}); }});
    const auto clip = create_property_animation_clip("clock", {{PropertyAnimationPath::record_scalar,
        PropertyAnimationComponent::whole_lane, PropertyAnimationInterpolation::linear,
        false, {{0.0f, {0.0f}}, {1.0f, {10.0f}}}}}, 10.0f);
    const auto group = create_property_animation_group(manager, engine,
        {{PropertyAnimationTargetKind::callback, 0u, [&](float next) { value = next; }}},
        clip, {0.0f, 1.0f, 1.0f, false});
    const auto frame = [&](double now) {
        const auto callbacks = std::move(engine.animation_frame_once_callbacks);
        engine.animation_frame_once_callbacks.clear();
        for (const auto& callback : callbacks) callback(now);
    };
    go_to_frame(group, engine, 5.0f);
    assert(value == 5 && observations.empty());
    play_animation(group);
    update_animation_manager(manager, engine, 100.0);
    assert(std::abs(value - 6.0) < 0.00001 && observations.empty());
    start_animation_manager(manager, engine);
    start_animation_manager(manager, engine);
    assert(engine.animation_frame_once_callbacks.size() == 1);
    frame(100.0);
    frame(125.0);
    frame(115.0);
    assert(observations.size() == 3);
    assert(observations[0].step == 0 && std::abs(observations[0].value - 6.0) < 0.00001);
    assert(observations[1].step == 25 && std::abs(observations[1].value - 6.25) < 0.00001);
    assert(observations[2].step == -10 && observations[2].value == observations[1].value);
    stop_animation_manager(manager);
    frame(1000.0);
    assert(observations.size() == 3 && engine.animation_frame_once_callbacks.empty());
    start_animation_manager(manager, engine);
    frame(2000.0);
    frame(2250.0);
    assert(observations[3].step == 0 && observations[4].step == 250);
    assert(std::abs(value - 8.75) < 0.00001);
    stop_animation_manager(manager);
    for (int i = 0; i < 10000; ++i) { start_animation_manager(manager, engine); stop_animation_manager(manager); }
    assert(engine.animation_frame_once_callbacks.empty());

    value = 0;
    observations.clear();
    auto fixed = create_animation_manager(engine, {100.0, [&](double step) { observations.push_back({value, step}); }});
    create_property_animation_group(fixed, engine,
        {{PropertyAnimationTargetKind::callback, 1u, [&](float next) { value = next; }}},
        clip, {0.0f, 1.0f, 1.0f, false});
    start_animation_manager(fixed, engine);
    frame(100.0);
    assert(value == 1 && observations.size() == 1 && observations[0].step == 100);
    update_animation_manager(fixed, engine, -500.0);
    update_animation_manager(fixed, engine, std::numeric_limits<double>::quiet_NaN());
    assert(std::abs(value - 3.0) < 0.00001 && observations.size() == 1);
    stop_animation_manager(fixed);

    int first_calls = 0;
    int second_calls = 0;
    PropertyAnimationManager second;
    auto first = create_animation_manager(engine, {0.0, [&](double) {
        if (++first_calls == 1) { stop_animation_manager(second); start_animation_manager(second, engine); }
    }});
    second = create_animation_manager(engine, {0.0, [&](double) { ++second_calls; }});
    start_animation_manager(first, engine);
    start_animation_manager(second, engine);
    frame(3000.0);
    assert(second_calls == 0);
    frame(3100.0);
    assert(second_calls == 1);
    stop_animation_manager(first);
    stop_animation_manager(second);

    engine.animation_frame_after_render = true;
    start_animation_manager(manager, engine);
    assert(engine.animation_frame_once_callbacks.empty() && engine.post_render_animation_frame_once_callbacks.size() == 1);
    stop_animation_manager(manager);
    assert(engine.post_render_animation_frame_once_callbacks.empty());
    engine.animation_frame_after_render = false;
    int ordered = 0;
    auto observing = create_animation_manager(engine, {0.0, [&](double) { assert(ordered == 1); }});
    request_animation_frame(engine, [&](double) { ordered = 1; });
    start_animation_manager(observing, engine);
    frame(4000);
    stop_animation_manager(observing);

    int restarted_calls = 0;
    PropertyAnimationManager restarting;
    restarting = create_animation_manager(engine, {0.0, [&](double) {
        if (++restarted_calls == 1) {
            stop_animation_manager(restarting);
            start_animation_manager(restarting, engine);
        }
    }});
    start_animation_manager(restarting, engine);
    frame(5000);
    assert(restarted_calls == 1 && engine.animation_frame_once_callbacks.size() == 2);
    frame(5100);
    assert(restarted_calls == 3);
    stop_animation_manager(restarting);
    frame(5200);
    assert(restarted_calls == 3 && engine.animation_frame_once_callbacks.empty());
    std::cout << "animation-manager-clock-check: ok\n";
}
