#define main generated_main
#include "program.hpp"
#undef main
#include <bblite/pal_dom_events.hpp>
#include <cassert>

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
void start_engine(Engine& engine) {
    auto& input = dom_input(engine);
    const auto dispatch = [&] {
        unsigned calls = 0;
        const auto invoke = [&](auto& callback, const auto& event) { ++calls; callback(event); };
        input.keyboard.dispatch(dom_event(PlatformKeyboardEvent{}, "keydown", {DomEventTarget::window()}), invoke);
        input.keyboard.dispatch(dom_event(PlatformKeyboardEvent{}, "keyup", {DomEventTarget::window()}), invoke);
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "pointerdown", {DomEventTarget::document()}), invoke);
        input.pointer.dispatch(dom_event(PlatformMouseEvent{}, "pointerup", {DomEventTarget::canvas()}), invoke);
        return calls;
    };
    assert(dispatch() == 4);
    assert(engine.animation_frame_once_callbacks.size() == 1);
    const auto callbacks = std::move(engine.animation_frame_once_callbacks);
    engine.animation_frame_once_callbacks.clear();
    callbacks.front()(100.0);
    assert(dispatch() == 0);
}
}

int main() {
    assert(generated_main() == 0);
}
