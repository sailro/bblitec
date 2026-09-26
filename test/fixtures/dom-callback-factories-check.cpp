#define main generated_main
#include "../../artifacts/dom-callback-factories/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

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
void update_window_document() {}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
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
}
