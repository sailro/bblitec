#define main generated_main
#include "../../artifacts/dom-callback-factories/program.hpp"
#undef main
#include "../../artifacts/dom-callback-factories/visibility.hpp"
#include "pal_ui_rml.cpp"
#include <cassert>
#include <cstdio>

namespace bbl::pal {
struct FixtureHost final : HostServices {
    std::shared_ptr<AnimationFrameSource> frames = std::make_shared<AnimationFrameSource>();
    std::shared_ptr<AnimationFrameSource> animation_frame_source() const override { return frames; }
};
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
void update_window_document(bool) {}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    loop.use_fixed_animation_time(16);
    const auto host = std::make_shared<FixtureHost>();
    WorkerRealm realm(loop, {}, host);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.post([&] { initialize(realm); });
    while (loop.poll()) {
    }
    for (int frame = 0; frame < 3; ++frame) {
        host->frames->tick(EventLoop::Clock::now());
        while (loop.poll()) {
        }
    }
    return 0;
}
} // namespace bbl::pal

int run() {
    assert(generated_main() == 0);
    auto& engine = bbl::pal::window_document_engine();
    const auto log = bbl::ui_get_element_by_id(engine, "factory-log");
    assert(bbl::handle_at(engine.ui_elements, log).text == "complete");
    const auto note = bbl::ui_get_element_by_id(engine, "void-note");
    assert(bbl::handle_at(engine.ui_elements, note).text == "label-2");
    const auto first = bbl::ui_get_element_by_id(engine, "first-target");
    const auto second = bbl::ui_get_element_by_id(engine, "second-target");
    assert(bbl::handle_at(engine.ui_elements, first).text != "assigned");
    assert(bbl::handle_at(engine.ui_elements, second).text == "assigned");
    assert(bbl::ui_get_style_property(engine, second, "opacity") == "0.5");
    const auto visibility = bbl::ui_get_element_by_id(engine, "visibility-log");
    engine.visibility_change_callbacks.dispatch(true);
    engine.visibility_change_callbacks.dispatch(false);
    assert(bbl::handle_at(engine.ui_elements, visibility).text == "12");
    const auto fading = bbl::ui_get_element_by_id(engine, "transition-log");
    assert(bbl::handle_at(engine.ui_elements, fading).text == "3");
    const auto transition = [&](std::string property) {
        bbl::PlatformTransitionEvent event;
        event.property_name = std::move(property);
        auto payload = bbl::dom_event(std::move(event), "transitionend",
                                      bbl::dom_ui_path(engine, fading), true, false);
        engine.dom_input->transition.dispatch(
            payload, [](auto& callback, const auto& event) { callback(event); }, &engine);
    };
    transition("transform");
    assert(bbl::handle_at(engine.ui_elements, fading).text == "3");
    transition("opacity");
    transition("opacity");
    assert(bbl::handle_at(engine.ui_elements, fading).text == "312");
    return 0;
}

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::fputs(error.what(), stderr);
        return 1;
    }
}
