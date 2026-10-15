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
        auto& engine = bbl::pal::window_document_engine();
        std::size_t scripts = 0;
        for (std::uint32_t index = 0; index < engine.ui_elements.size(); ++index) {
            const auto& record = engine.ui_elements[index];
            if (record.tag != "script")
                continue;
            assert(record.script_started && !record.script_force_async);
            const bbl::UiElementHandle script{index};
            bbl::ui_remove(engine, script);
            bbl::ui_append_to_root(engine, script);
            ++scripts;
        }
        assert(scripts == 3);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
