#include <bblite/js_data.hpp>
#include "pal_camera_controls.hpp"
#include <cassert>
#include <iostream>

namespace {
int rotations = 0;
}
namespace bbl::upstream {
void apply_arc_rotate_pointer_rotation(CameraRecord&, double, double) { ++rotations; }
void apply_arc_rotate_pointer_pan(CameraRecord&, double, double) {}
void apply_arc_rotate_wheel(CameraRecord&, double) {}
void apply_free_camera_pointer_rotation(CameraRecord&, double, double) { ++rotations; }
}

int main() {
    bbl::PlatformMouseEvent mouse;
    mouse.client_x = 42;
    bbl::js::BorrowedEvent borrowed(mouse);
    const auto copy = borrowed;
    assert(&copy.as<bbl::PlatformMouseEvent>() == &mouse);
    copy.prevent_default();
    assert(mouse.default_prevented);
    bool rejected = false;
    try { (void)copy.as<bbl::PlatformKeyboardEvent>(); }
    catch (const std::runtime_error&) { rejected = true; }
    assert(rejected);

    bbl::CameraRecord camera;
    camera.controls_enabled = true;
    bbl::pal::CameraPointerState state;
    bool dragging = false, pending = true, allowed = true;
    camera.should_handle_pointer_down = [&] { return allowed; };
    camera.external_drag_active = [&] { return dragging; };
    camera.external_pick_pending = [&] { return pending; };
    SDL_Event event{};
    event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    event.button.button = SDL_BUTTON_LEFT;
    bbl::pal::handle_camera_pointer_event(event, camera, state);
    assert(state.orbiting);
    event.type = SDL_EVENT_MOUSE_MOTION;
    event.motion.xrel = 12;
    bbl::pal::handle_camera_pointer_event(event, camera, state);
    assert(rotations == 0);
    pending = false;
    dragging = true;
    camera.inertial_alpha_offset = 0.3;
    camera.inertial_beta_offset = 0.2;
    camera.inertial_panning_x = 3;
    camera.inertial_panning_y = 2;
    bbl::pal::handle_camera_pointer_event(event, camera, state);
    assert(!state.orbiting && !state.panning && rotations == 0);
    assert(camera.inertial_alpha_offset == 0 && camera.inertial_beta_offset == 0);
    assert(camera.inertial_panning_x == 0 && camera.inertial_panning_y == 0);
    dragging = false;
    event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    event.button.button = SDL_BUTTON_LEFT;
    bbl::pal::handle_camera_pointer_event(event, camera, state);
    event.type = SDL_EVENT_MOUSE_MOTION;
    bbl::pal::handle_camera_pointer_event(event, camera, state);
    assert(rotations == 1);
    allowed = false;
    event.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    event.button.button = SDL_BUTTON_LEFT;
    bbl::pal::handle_camera_pointer_event(event, camera, state);
    assert(!state.orbiting);
    std::cout << "editor-pointer-check: ok\n";
}
