#define main generated_main
#include "../../artifacts/dom-script-elements/program.hpp"
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
#define FIXTURE_APPLICATION_TIMEOUT_MS 5000
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window =
        SDL_CreateWindow("DOM script elements fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        // Each script's error ran in a later task than its append; the second call found the
        // first script by its data attribute; load, the detached script and the data block never
        // dispatched; removed and aborted listeners never ran.
        const auto& log = ui_element(engine, ui_get_element_by_id(engine, "log")).text;
        if (log != "asAQrI|Ee")
            std::fprintf(stderr, "log: %s\n", log.c_str());
        check(log == "asAQrI|Ee", "script element events");
        const auto head = ui_document_root(engine, UiDocumentPart::Head);
        const auto& children = ui_element(engine, head).children;
        check(children.size() == 2, "the external script and the data block are in the head");
        const auto script = children.front();
        check(ui_get_attribute(engine, script, "data-tag") == "T-1" &&
                  ui_has_attribute(engine, script, "async") && ui_script_async(engine, script),
              "the script keeps its attributes");
        // A script is retained but never rendered.
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* raw = runtime.projected_elements.at(script.value).element;
        check(raw && !raw->IsVisible(), "the script is not rendered");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "DOM script elements failure: %s\n", error.what());
    return 1;
}
