#define main generated_main
#include "../../artifacts/optional-dom-parent/program.hpp"
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
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] { initialize(realm); });
    if (failure)
        std::rethrow_exception(failure);
    return 0;
}
} // namespace bbl::pal

int main() {
    try {
        assert(generated_main() == 0);
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
