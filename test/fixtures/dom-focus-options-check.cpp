#define main generated_main
#include "../../artifacts/dom-focus-options/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace {
std::vector<bool> focus_visibility;
}

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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    auto& engine = window_document_engine();
    on_dom_pointer(
        engine, DomEventTarget::document(), "focus", 1,
        [&](const PlatformMouseEvent&) { focus_visibility.push_back(engine.ui_focus_visible); },
        true);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    assert(generated_main() == 0);
    assert((focus_visibility == std::vector<bool>{true, false, true, true, true, true, false, true,
                                                  true, false, true, false, true}));
    auto& engine = bbl::pal::window_document_engine();
    assert(bbl::ui_active_element(engine) == bbl::ui_get_element_by_id(engine, "target"));
}
