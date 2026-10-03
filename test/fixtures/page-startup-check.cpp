#define main generated_main
#include "../../artifacts/page-startup/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
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
    WorkerRealm realm(loop);
    int errors = 0;
    loop.on_error([&](std::exception_ptr error) {
        if (js::error_message(error) != "expected startup error")
            std::rethrow_exception(error);
        ++errors;
    });
    loop.run([&] { initialize(realm); });
    assert(errors == 1);
    return 0;
}
} // namespace bbl::pal

int main() {
    try {
        assert(generated_main() == 0);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
