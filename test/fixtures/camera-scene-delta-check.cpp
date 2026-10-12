// A camera's control hook advances by the delta of the scene attachControl
// pushed it onto: `fixedDeltaMs > 0 ? fixedDeltaMs : _currentDelta`, per
// scene. Disposing an attachment removes that exact hook.
#include <bblite/js_data.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include "pal_camera_controls.hpp"
#include <cassert>
#include <iostream>
#include <vector>

#include "scene-callback-delta.hpp"

int main() {
    bbl::Engine engine;
    engine.cameras.resize(2);
    bbl::Scene fixed, live;
    fixed.state->fixed_delta_ms = 1000.0 / 60.0;
    std::vector<double> fixed_steps, live_steps;
    for (std::size_t index = 0; index < 2; ++index) {
        bbl::CameraRecord& camera = engine.cameras[index];
        camera.kind = bbl::CameraKind::free;
    }
    auto fixed_expected = engine.cameras[0], live_expected = engine.cameras[1];
    const auto dispose_fixed = bbl::attach_free_control(engine, bbl::CameraHandle{0}, fixed);
    const auto dispose_live = bbl::attach_free_control(engine, bbl::CameraHandle{1}, live);
    engine.camera_control_bindings->entries[0]->key_down("KeyW");
    engine.camera_control_bindings->entries[1]->key_down("KeyW");
    fixed.before_render.push_back(
        [&fixed_steps](double delta_ms) { fixed_steps.push_back(delta_ms); });
    live.before_render.push_back(
        [&live_steps](double delta_ms) { live_steps.push_back(delta_ms); });
    engine.current_delta_ms = 7.25;
    bbl::run_scene_before_render(fixed, bbl::scene_callback_delta(fixed, engine.current_delta_ms));
    bbl::run_scene_before_render(live, bbl::scene_callback_delta(live, engine.current_delta_ms));
    assert(fixed_steps == std::vector<double>{1000.0 / 60.0});
    assert(live_steps == std::vector<double>{7.25});
    const auto forward = [](std::string_view key) { return key == "KeyW"; };
    bbl::upstream::free_camera_update(fixed_expected, 1000.0 / 60.0, forward);
    bbl::upstream::free_camera_update(live_expected, 7.25, forward);
    const auto matches = [](const auto& actual, const auto& expected) {
        assert(actual.position.x == expected.position.x);
        assert(actual.position.y == expected.position.y);
        assert(actual.position.z == expected.position.z);
        assert(actual.target.x == expected.target.x);
        assert(actual.target.y == expected.target.y);
        assert(actual.target.z == expected.target.z);
        assert(actual.world_matrix_version == expected.world_matrix_version);
    };
    matches(engine.cameras[0], fixed_expected);
    matches(engine.cameras[1], live_expected);
    dispose_fixed();
    dispose_live();
    bbl::run_scene_before_render(fixed, bbl::scene_callback_delta(fixed, engine.current_delta_ms));
    bbl::run_scene_before_render(live, bbl::scene_callback_delta(live, engine.current_delta_ms));
    matches(engine.cameras[0], fixed_expected);
    matches(engine.cameras[1], live_expected);
    assert(fixed.before_render.size() == 1 && live.before_render.size() == 1);
    assert(fixed_steps.size() == 2 && live_steps.size() == 2);

    bbl::Engine ordered_engine;
    const auto first = bbl::create_arc_rotate_camera(ordered_engine, 0, 1, 5, {0, 0, 0});
    const auto second = bbl::create_arc_rotate_camera(ordered_engine, 0, 1, 5, {0, 0, 0});
    const bbl::Scene ordered_scene;
    std::vector<int> input_order;
    const auto attach = [&](bbl::CameraHandle camera, int id) {
        bbl::CameraControlOptions options;
        options.should_handle_pointer_down = [&, id] {
            input_order.push_back(id);
            return false;
        };
        bbl::attach_control(ordered_engine, camera, ordered_scene, std::move(options));
    };
    attach(first, 1);
    attach(second, 2);
    attach(first, 3);
    SDL_Event down{};
    down.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    down.button.button = SDL_BUTTON_LEFT;
    bbl::pal::CameraPointerState primary_state;
    bbl::pal::SurfaceCameraPointerState surfaces;
    bbl::pal::dispatch_surface_camera_pointer(ordered_engine, down,
                                              &bbl::handle_at(ordered_engine.cameras, first),
                                              primary_state, surfaces);
    assert(input_order == pinned_camera_input_order);
    std::cout << "camera-scene-delta-check: ok\n";
}
