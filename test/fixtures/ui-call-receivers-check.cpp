#define main generated_main
#include "../../artifacts/ui-call-receivers/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cstdio>

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

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(generated_main() == 0, "program");
    auto& engine = pal::window_document_engine();
    const auto element = [&](const char* id) { return ui_get_element_by_id(engine, id); };
    check(ui_get_style_property(engine, element("a"), "--n") == "3", "setProperty on a call");
    static_cast<void>(element("b"));
    check(ui_has_class(engine, element("c"), "x"), "classList.add on a call");
    check(ui_has_class(engine, element("d"), "y"), "classList.toggle on a call");
    check(ui_get_style_property(engine, element("e"), "color") == "red", "style field on a call");
    check(ui_get_attribute(engine, element("g"), "data-state") == "on", "dataset on a call");
    check(ui_has_class(engine, element("h"), "z"), "classList on a selected call");
    check(!ui_find_element_by_id(engine, "unused"), "the unselected arm does not run");
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI call receivers failure: %s\n", error.what());
    return 1;
}
