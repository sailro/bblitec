#define main generated_main
#include "../../artifacts/dom-active-classes/program.hpp"
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
    // The focused element answers its own classes: the pill, then the plain button.
    assert(ui_element(engine, ui_get_element_by_id(engine, "log")).text == "pill other");
    return 0;
}
