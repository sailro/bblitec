#define main generated_main
#include "../../artifacts/dom-selected-receiver/program.hpp"
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
    const auto children = [&](std::string_view id) {
        std::string order;
        for (const auto child : ui_element(engine, ui_get_element_by_id(engine, std::string{id})).children)
            order += ui_get_attribute(engine, child, "id") + ";";
        return order;
    };
    // Each selection ran its test once and appended to the element it chose.
    assert(children("a") == "c;");
    assert(children("b") == "d;e;");
    assert(ui_element(engine, ui_get_element_by_id(engine, "log")).text == "2");
    return 0;
}
