#include <bblite/js_data.hpp>
#include "pal_camera_controls.hpp"
#include <cassert>
#include <iostream>

namespace {
int rotations = 0;
double wheel_delta = 0;
} // namespace
namespace bbl::upstream {
void apply_arc_rotate_pointer_rotation(CameraRecord&, double, double) { ++rotations; }
void apply_arc_rotate_pointer_pan(CameraRecord&, double, double) {}
void apply_arc_rotate_wheel(CameraRecord&, double delta) { wheel_delta += delta; }
void apply_free_camera_pointer_rotation(CameraRecord&, double, double) { ++rotations; }
} // namespace bbl::upstream

int main() {
    bbl::PlatformMouseEvent mouse;
    mouse.client_x = 42;
    bbl::js::BorrowedEvent borrowed(mouse);
    const auto copy = borrowed;
    assert(&copy.as<bbl::PlatformMouseEvent>() == &mouse);
    copy.prevent_default();
    assert(mouse.default_prevented);
    bool rejected = false;
    try {
        (void)copy.as<bbl::PlatformKeyboardEvent>();
    } catch (const std::runtime_error&) {
        rejected = true;
    }
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
    allowed = true;
    const auto touch = [&](SDL_EventType type, SDL_FingerID id, float x, float y) {
        SDL_Event finger{};
        finger.type = type;
        finger.tfinger.touchID = 5;
        finger.tfinger.fingerID = id;
        finger.tfinger.x = x;
        finger.tfinger.y = y;
        bbl::pal::handle_camera_pointer_event(finger, camera, state, 800, 400);
    };
    touch(SDL_EVENT_FINGER_DOWN, 10, .25f, .5f);
    touch(SDL_EVENT_FINGER_MOTION, 10, .3f, .5f);
    assert(rotations == 2 && state.orbiting);
    touch(SDL_EVENT_FINGER_DOWN, 20, .7f, .5f);
    assert(!state.orbiting && state.touches.size() == 2);
    touch(SDL_EVENT_FINGER_MOTION, 20, .9f, .5f);
    assert(wheel_delta < 0 && rotations == 2); // Expand zooms in without orbiting.
    const double expanded = wheel_delta;
    touch(SDL_EVENT_FINGER_MOTION, 20, .7f, .5f);
    assert(wheel_delta > expanded && std::abs(wheel_delta) < .001); // Pinch reverses it.
    touch(SDL_EVENT_FINGER_UP, 20, .7f, .5f);
    assert(state.orbiting && state.touches.size() == 1);
    touch(SDL_EVENT_FINGER_MOTION, 10, .35f, .5f);
    assert(rotations == 3);
    touch(SDL_EVENT_FINGER_CANCELED, 10, .35f, .5f);
    assert(state.touches.empty() && !state.orbiting);
    touch(SDL_EVENT_FINGER_DOWN, 30, .5f, .5f);
    SDL_Event blur{};
    blur.type = SDL_EVENT_WINDOW_FOCUS_LOST;
    bbl::pal::handle_camera_pointer_event(blur, camera, state);
    assert(state.touches.empty() && !state.orbiting);
    std::cout << "editor-pointer-check: ok\n";
}
