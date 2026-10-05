#define main generated_main
#include "../../artifacts/deferred-dom-node-boundaries/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
}
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
    int resumed = 0;
    try {
        const auto result = bbl::deferred_capability<std::string>("fixture:typed", "fixture");
        resumed += static_cast<int>(result.size());
    } catch (const bbl::DeferredCapabilityError& error) {
        assert(std::string_view(error.what()).find("fixture:typed") != std::string_view::npos);
    }
    assert(resumed == 0);
    assert(generated_main() == 0);
}
