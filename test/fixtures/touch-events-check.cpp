#define main generated_main
#include "../../artifacts/touch-events/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include "finger-events.hpp"
#include <cassert>
#include <iostream>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

namespace {
void expect(const std::string& actual, const std::string& expected) {
    if (actual == expected)
        return;
    std::cerr << "expected: " << expected << "\nactual:   " << actual << '\n';
    std::abort();
}
} // namespace

// The compiled page: Chromium's order for every SDL finger event, read by its listeners.
int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Touch events fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        pal::update_engine_canvas_metrics(engine, 640, 480, 1, 1);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto log = ui_get_element_by_id(engine, "log"),
                   pad = ui_get_element_by_id(engine, "pad");
        assert(engine.dom_input->hit_path(60, 60).front() == DomEventTarget::node(pad.value));
        const auto send = [&](SDL_Event event) {
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            assert(batch);
            dispatch_dom_batch(engine, batch);
            assert(batch->ready());
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto touch = [&](SDL_EventType type, SDL_FingerID finger, float x, float y,
                               Uint64 timestamp = 0) {
            send(finger_event(type, 7, finger, x / 640, y / 480, SDL_GetWindowID(window),
                              timestamp));
        };
        // A press on the pad, released at (x, y) after `held` nanoseconds.
        const auto tap = [&](float x, float y, Uint64 held = 0) {
            touch(SDL_EVENT_FINGER_DOWN, 1, 60, 60);
            touch(SDL_EVENT_FINGER_UP, 1, x, y, held);
        };
        // What the listeners record during `gestures`, with `cancel` naming the type they cancel.
        const auto sequence = [&](const std::string& cancel, auto&& gestures) {
            ui_set_attribute(engine, pad, "data-cancel", cancel);
            const auto before = ui_element(engine, log).text.size();
            gestures();
            return ui_element(engine, log).text.substr(before);
        };
        const std::string pressed = "ODwSp0/0/0@60,60pd";
        // A tap: pointer events, then the touch event, then the compatibility mouse events and
        // click. A list reads as one object; the passive listener cannot cancel, nor the
        // Document's, passive by default. `once` ends the second touchend listener; the aborted
        // touchmove listener never runs.
        expect(sequence("", [&] { tap(62, 52); }), pressed + "ULEp//01ovmuK");
        // A canceled touchstart withholds the tap; pointer and touch events still run.
        expect(sequence("touchstart", [&] { tap(60, 60); }), "ODwSp0/0/0@60,60pd!ULEp//0");
        // A canceled pointerdown withholds the compatibility mouse events, never the touch
        // events or the click.
        expect(sequence("pointerdown", [&] { tap(60, 60); }), pressed + "ULEp//0K");
        // A contact held past Chromium's long press does not tap.
        expect(sequence("", [&] { tap(60, 60, dom_touch_long_press_ns + 1); }),
               pressed + "ULEp//0");
        // Two contacts: each event lists the surface's touches, its target's and its change.
        // A second contact ends the tap.
        expect(sequence("",
                        [&] {
                            touch(SDL_EVENT_FINGER_DOWN, 1, 60, 60);
                            touch(SDL_EVENT_FINGER_DOWN, 2, 350, 60);
                            touch(SDL_EVENT_FINGER_MOTION, 1, 70, 55);
                            touch(SDL_EVENT_FINGER_UP, 1, 70, 55);
                            touch(SDL_EVENT_FINGER_UP, 2, 350, 60);
                        }),
               pressed + "wSo01/1/1d" + "VMp01/0/0" + "ULEp1//0" + "ho//1");
        // A touch keeps its touchstart target and its pointer its implicit capture; leaving the
        // slop ends the tap.
        expect(sequence("",
                        [&] {
                            touch(SDL_EVENT_FINGER_DOWN, 1, 60, 60);
                            touch(SDL_EVENT_FINGER_MOTION, 1, 350, 60);
                            touch(SDL_EVENT_FINGER_UP, 1, 350, 60);
                        }),
               pressed + "VMp0/0/0" + "ULEp//0");
        // Focus loss cancels the contact: pointercancel, then a touchcancel no one can cancel.
        expect(sequence("",
                        [&] {
                            touch(SDL_EVENT_FINGER_DOWN, 1, 60, 60);
                            SDL_Event blur{};
                            blur.type = SDL_EVENT_WINDOW_FOCUS_LOST;
                            send(blur);
                        }),
               pressed + "LCp//0");
        assert(engine.dom_input->touches.empty() && engine.dom_input->canceled_taps.empty());
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
