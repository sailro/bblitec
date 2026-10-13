#define main generated_main
#include "../../artifacts/ui-element-writes/program.hpp"
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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    if (generated_main() != 0)
        throw std::runtime_error("The generated program failed");
    auto& engine = pal::window_document_engine();
    const auto value = [&](const char* id) {
        return ui_get_form_value(engine, ui_get_element_by_id(engine, id));
    };
    const auto require = [](bool condition, const char* what) {
        if (!condition)
            throw std::runtime_error(what);
    };
    // Every iteration wrote its element.
    require(value("x") == "Unavailable" && value("y") == "Unavailable", "for-of writes");
    require(ui_get_attribute(engine, ui_get_element_by_id(engine, "y"), "title") == "pose",
            "reflected title");
    require(value("a") == "0" && value("b") == "1", "forEach writes");
    require(value("i0") == "slot 0" && value("i1") == "slot 1", "indexed writes");
    require(value("m0") == "mixed" && value("m1") == "mixed", "union element writes");
    // The conditional receiver evaluated its condition once and wrote its arm.
    require(value("c0").empty() && value("c1") == "chosen" && value("picks") == "1",
            "conditional receiver write");
} catch (const std::exception& error) {
    std::fprintf(stderr, "Element writes: %s\n", error.what());
    return 1;
}
