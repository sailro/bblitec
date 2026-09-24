#include <bblite/js_data.hpp>
#include "pal_camera_controls.hpp"
#include <cassert>
#include <iostream>

namespace {
SDL_Event mouse_button(SDL_EventType type, Uint8 button) {
    SDL_Event event{};
    event.type = type;
    event.button.button = button;
    return event;
}

SDL_Event mouse_motion(float dx, float dy) {
    SDL_Event event{};
    event.type = SDL_EVENT_MOUSE_MOTION;
    event.motion.xrel = dx;
    event.motion.yrel = dy;
    return event;
}
} // namespace

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

    // The createArcRotateCamera tuning the handlers read.
    bbl::CameraRecord camera;
    camera.radius = 6;
    camera.angular_sensibility = 1000;
    camera.panning_sensibility = 50;
    camera.wheel_precision = 3;
    camera.controls_enabled = true;
    bbl::pal::CameraPointerState state;
    bool dragging = false, pending = true, allowed = true;
    camera.should_handle_pointer_down = [&] { return allowed; };
    camera.external_drag_active = [&] { return dragging; };
    camera.external_pick_pending = [&] { return pending; };
    const auto send = [&](const SDL_Event& event) {
        bbl::pal::handle_camera_pointer_event(event, camera, state);
    };
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_LEFT));
    assert(state.dragging && !state.panning);
    send(mouse_motion(12, 0));
    assert(camera.inertial_alpha_offset == 0); // A pending pick defers the orbit.
    pending = false;
    dragging = true;
    camera.inertial_alpha_offset = 0.3;
    camera.inertial_beta_offset = 0.2;
    camera.inertial_panning_x = 3;
    camera.inertial_panning_y = 2;
    send(mouse_motion(12, 0));
    assert(!state.dragging && !state.panning);
    assert(camera.inertial_alpha_offset == 0 && camera.inertial_beta_offset == 0);
    assert(camera.inertial_panning_x == 0 && camera.inertial_panning_y == 0);
    dragging = false;
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, SDL_BUTTON_LEFT));
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_LEFT));
    send(mouse_motion(12, 0));
    assert(camera.inertial_alpha_offset < 0);
    // A second button pressed and released inside the drag is a chord of
    // the same browser pointer: no new gesture and no early release.
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_RIGHT));
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, SDL_BUTTON_RIGHT));
    assert(state.dragging && !state.panning);
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, SDL_BUTTON_LEFT));
    assert(!state.dragging && state.buttons == 0);
    // attachControl assigns no gesture to the auxiliary button.
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_MIDDLE));
    assert(!state.dragging && !state.panning);
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, SDL_BUTTON_MIDDLE));
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_RIGHT));
    assert(state.panning && !state.dragging);
    send(mouse_motion(10, 0));
    assert(camera.inertial_panning_x < 0);
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, SDL_BUTTON_RIGHT));
    allowed = false;
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, SDL_BUTTON_LEFT));
    assert(!state.dragging);
    send(mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, SDL_BUTTON_LEFT));
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
    camera.inertial_alpha_offset = 0;
    touch(SDL_EVENT_FINGER_DOWN, 10, .25f, .5f);
    touch(SDL_EVENT_FINGER_MOTION, 10, .3f, .5f);
    const double orbited = camera.inertial_alpha_offset;
    assert(orbited < 0 && state.dragging);
    touch(SDL_EVENT_FINGER_DOWN, 20, .7f, .5f);
    assert(!state.dragging && state.touches.size() == 2);
    touch(SDL_EVENT_FINGER_MOTION, 20, .9f, .5f);
    // Expanding zooms in without orbiting.
    assert(camera.inertial_radius_offset > 0 && camera.inertial_alpha_offset == orbited);
    const double expanded = camera.inertial_radius_offset;
    touch(SDL_EVENT_FINGER_MOTION, 20, .7f, .5f);
    assert(camera.inertial_radius_offset < expanded); // Pinching reverses it.
    touch(SDL_EVENT_FINGER_UP, 20, .7f, .5f);
    assert(state.dragging && state.touches.size() == 1);
    touch(SDL_EVENT_FINGER_MOTION, 10, .35f, .5f);
    assert(camera.inertial_alpha_offset < orbited);
    touch(SDL_EVENT_FINGER_CANCELED, 10, .35f, .5f);
    assert(state.touches.empty() && !state.dragging);
    touch(SDL_EVENT_FINGER_DOWN, 30, .5f, .5f);
    SDL_Event blur{};
    blur.type = SDL_EVENT_WINDOW_FOCUS_LOST;
    bbl::pal::handle_camera_pointer_event(blur, camera, state);
    assert(state.touches.empty() && !state.dragging);

    // attachFreeControl looks on the primary, auxiliary and secondary
    // buttons alike, and takes no wheel.
    bbl::CameraRecord free_camera;
    free_camera.kind = bbl::CameraKind::free;
    free_camera.angular_sensibility = 2000;
    free_camera.controls_enabled = true;
    for (const int button : {SDL_BUTTON_LEFT, SDL_BUTTON_MIDDLE, SDL_BUTTON_RIGHT}) {
        bbl::pal::CameraPointerState look;
        free_camera.inertial_yaw_offset = 0;
        bbl::pal::handle_camera_pointer_event(
            mouse_button(SDL_EVENT_MOUSE_BUTTON_DOWN, static_cast<Uint8>(button)), free_camera,
            look);
        bbl::pal::handle_camera_pointer_event(mouse_motion(8, 0), free_camera, look);
        assert(look.dragging && free_camera.inertial_yaw_offset > 0);
        bbl::pal::handle_camera_pointer_event(
            mouse_button(SDL_EVENT_MOUSE_BUTTON_UP, static_cast<Uint8>(button)), free_camera, look);
        assert(!look.dragging);
    }
    SDL_Event wheel{};
    wheel.type = SDL_EVENT_MOUSE_WHEEL;
    wheel.wheel.y = 1;
    bbl::pal::CameraPointerState idle;
    bbl::pal::handle_camera_pointer_event(wheel, free_camera, idle);
    assert(free_camera.inertial_radius_offset == 0);
    std::cout << "editor-pointer-check: ok\n";
}
