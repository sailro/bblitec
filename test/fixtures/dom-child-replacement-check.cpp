#define main generated_main
#include "../../artifacts/dom-child-replacement/program.hpp"
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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    auto& engine = pal::window_document_engine();
    assert(generated_main() == 0);
    const auto list = ui_get_element_by_id(engine, "list");
    std::string order;
    for (const auto child : ui_element(engine, list).children)
        order += ui_get_attribute(engine, child, "id") + ";";
    // replaceChildren(...items, icon) after the earlier replacements.
    assert(order == "a;b;c;icon;");
    const auto input = ui_get_element_by_id(engine, "input");
    assert(ui_active_element(engine) == input);
    // The later option write cannot change the earlier focusVisible value.
    assert(engine.ui_focus_visible);
    // Each step's child count and text, as the program recorded them.
    assert(ui_element(engine, ui_get_element_by_id(engine, "log")).text == "3|1x3|1|S|4|F");
    return 0;
}
