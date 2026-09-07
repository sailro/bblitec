#include <bblite/runtime.hpp>
#include <cassert>

int main() {
    using namespace bbl;
    Engine engine;
    Engine other;
    Scene scene;
    scene.engine = &engine;
    register_scene(scene);
    register_scene(scene);
    assert(scene.animation_seekers.size() == 1);

    // Managers created after scene registration must join the measured seek.
    double value = 0;
    double other_value = 0;
    auto manager = create_animation_manager(engine);
    auto other_manager = create_animation_manager(other);
    const auto clip = create_property_animation_clip("seek", {{PropertyAnimationPath::record_scalar,
        PropertyAnimationComponent::whole_lane, PropertyAnimationInterpolation::linear,
        false, {{0.0f, {0.0f}}, {1.0f, {10.0f}}}}}, 10.0f);
    const auto group = create_property_animation_group(manager, engine,
        {{PropertyAnimationTargetKind::callback, 0u, [&](float next) { value = next; }}},
        clip, {0.0f, 1.0f, 1.0f, false});
    create_property_animation_group(other_manager, other,
        {{PropertyAnimationTargetKind::callback, 0u, [&](float next) { other_value = next; }}},
        clip, {0.0f, 1.0f, 1.0f, false});
    start_animation_manager(manager, engine);
    scene.animation_seekers.front()(0.5f);
    assert(value == 5 && other_value == 0 && !group->playing);
    for (double now : {100.0, 350.0, 600.0}) {
        const auto callbacks = std::move(engine.animation_frame_once_callbacks);
        engine.animation_frame_once_callbacks.clear();
        for (const auto& callback : callbacks) callback(now);
    }
    assert(value == 5 && other_value == 0);
    stop_animation_manager(manager);
}
