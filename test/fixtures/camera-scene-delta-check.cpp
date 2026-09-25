// A camera's control hook advances by the delta of the scene attachControl
// pushed it onto: `fixedDeltaMs > 0 ? fixedDeltaMs : _currentDelta`, per
// scene, and not at all for a control installed without one.
#include <bblite/js_data.hpp>
#include "pal_camera_controls.hpp"
#include <cassert>
#include <iostream>
#include <vector>

#include "scene-callback-delta.hpp"

// The free branch asks SDL which keys are down; none are.
const bool* SDL_GetKeyboardState(int* count) {
    static const bool none[1]{false};
    if (count)
        *count = 0;
    return none;
}

int main() {
    bbl::Engine engine;
    engine.cameras.resize(2);
    const bbl::Scene fixed, live;
    fixed.state->fixed_delta_ms = 1000.0 / 60.0;
    std::vector<double> fixed_steps, live_steps;
    for (std::size_t index = 0; index < 2; ++index) {
        bbl::CameraRecord& camera = engine.cameras[index];
        camera.kind = bbl::CameraKind::free;
        std::vector<double>& steps = index == 0 ? fixed_steps : live_steps;
        camera.configurable_free_update = [&steps](bbl::CameraRecord&, double delta_ms,
                                                   const std::function<bool(std::string_view)>&) {
            steps.push_back(delta_ms);
        };
    }
    bbl::attach_control(engine, bbl::CameraHandle{0}, fixed);
    bbl::attach_control(engine, bbl::CameraHandle{1}, live);
    engine.current_delta_ms = 7.25;
    bbl::pal::update_attached_camera(engine, engine.cameras[0]);
    bbl::pal::update_attached_camera(engine, engine.cameras[1]);
    assert(fixed_steps == std::vector<double>{1000.0 / 60.0});
    assert(live_steps == std::vector<double>{7.25});
    // A control installed without a scene has no per-frame hook upstream.
    engine.cameras[1].controls_scene.reset();
    bbl::pal::update_attached_camera(engine, engine.cameras[1]);
    assert(live_steps.size() == 1);
    std::cout << "camera-scene-delta-check: ok\n";
}
