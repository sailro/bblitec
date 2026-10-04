#define main generated_main
#include "../../artifacts/executed-module-constants/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <array>
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
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] {
        initialize(realm);
        loop.close();
    });
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(generated_main() == 0);
    auto& engine = pal::window_document_engine();
    const auto body = ui_document_root(engine, UiDocumentPart::Body);
    const auto& rows = ui_element(engine, body).children;
    assert(rows.size() == 1);
    const auto& cells = ui_element(engine, rows[0]).children;
    const std::array<std::string_view, 3> actions{"left", "up", "right"};
    const std::array<std::string_view, 3> labels{"Left arrow", "Up arrow", "Right arrow"};
    assert(cells.size() == actions.size());
    for (std::size_t index = 0; index < cells.size(); ++index) {
        assert(ui_get_attribute(engine, cells[index], "data-action") == actions[index]);
        assert(ui_element(engine, cells[index]).text == labels[index]);
    }
}
