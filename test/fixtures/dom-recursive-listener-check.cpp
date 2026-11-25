#define main generated_main
#include "../../artifacts/dom-recursive-listener/program.hpp"
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
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() {
    using namespace bbl;
    assert(generated_main() == 0);
    auto& engine = pal::window_document_engine();
    const auto status = ui_get_element_by_id(engine, "status");
    // Each panel's click repainted that panel's own rows through the listener's recursion.
    assert(ui_element(engine, status).text == "a,b*|a*,b");
    return 0;
}
