#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-optional-calls/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() { static Engine document; return document; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) { failure = error; loop.close(); });
    loop.run([&] { initialize(realm); });
    if (failure) std::rethrow_exception(failure);
    return 0;
}
}

int main() {
    assert(generated_main() == 0);
    const auto& engine = bbl::pal::window_document_engine();
    assert(engine.ui_root_children.empty());
    assert(engine.ui_elements.size() == 6);
    assert(engine.ui_elements.at(0).children.size() == 1);
    assert(engine.ui_elements.at(1).text == "child");
    assert(engine.ui_elements.at(2).children.size() == 1);
    assert(engine.ui_elements.at(2).children.at(0).value == 3);
    assert(engine.ui_elements.at(5).attributes.at("class") == "swatch active");
}
