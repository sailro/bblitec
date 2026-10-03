#define main generated_main
#include "../../artifacts/ui-registration-boundaries/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <source_location>

namespace bbl {
std::string asset_path(const std::string&) { throw std::runtime_error("Unexpected asset read"); }
} // namespace bbl
namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::vector<std::uint8_t> read_binary_file(const std::string&) {
    throw std::runtime_error("Unexpected image read");
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

void expect(bool condition, std::source_location location = std::source_location::current()) {
    if (!condition) {
        throw std::runtime_error("UI registration assertion at line " +
                                 std::to_string(location.line()));
    }
}

int run() {
    using namespace bbl;
    expect(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI registration", 640, 480, SDL_WINDOW_HIDDEN);
    expect(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* metadata = runtime.document->GetElementById("metadata");
        expect(metadata && metadata->GetAttribute<Rml::String>("role", "") == "status");
        expect(metadata->GetAttribute<Rml::String>("aria-live", "") == "polite");
        expect(metadata->GetAttribute<Rml::String>("aria-hidden", "") == "false");
        expect(metadata->GetAttribute<Rml::String>("data-mode", "") == "ready");
        auto* emphasis = runtime.document->GetElementById("emphasis");
        expect(emphasis &&
               emphasis->GetComputedValues().font_weight() == Rml::Style::FontWeight::Bold);
        expect(emphasis->GetComputedValues().color() == Rml::Colourb(255, 0, 0, 255));
        auto* inactive = runtime.document->GetElementById("inactive");
        expect(inactive && inactive->HasAttribute("disabled"));
        expect(inactive->GetParentNode() == metadata);
        auto* concealed = runtime.document->GetElementById("concealed");
        expect(concealed && concealed->GetDisplay() == Rml::Style::Display::None);
        auto* hint = runtime.document->GetElementById("hint");
        expect(hint && hint->GetAttribute<Rml::String>("draggable", "") == "false");
        expect(hint->GetAttribute<Rml::String>("fetchpriority", "") == "high");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
