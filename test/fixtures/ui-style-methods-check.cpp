#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-style-methods/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() { static Engine document; return document; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("CSS declaration fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        const auto panel = ui_get_element_by_id(engine, "panel");
        const auto child = ui_get_element_by_id(engine, "child");
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(child.value).element;
        assert(raw->GetClientWidth() == 60.f);
        assert(raw->GetProperty<Rml::Colourb>("background-color") == Rml::Colourb(0, 0, 255));
        ui_set_style_property(engine, panel, "--Span", "80px");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw->GetClientWidth() == 80.f);
        assert(ui_remove_style_property(engine, panel, "--Span") == "80px");
        assert(ui_remove_style_property(engine, panel, "--Tone") == "blue");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw->GetClientWidth() == 20.f);
        assert(raw->GetProperty<Rml::Colourb>("background-color") == Rml::Colourb(0, 128, 0));
        assert(ui_get_style_property(engine, panel, "--span") == "5px");
        assert(runtime.projected_elements.at(panel.value).element->GetProperty<Rml::String>("--span") == "5dp");
        ui_set_attribute(engine, panel, "class", "changed");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw->GetClientWidth() == 20.f);
        assert(runtime.projected_elements.at(child.value).element == raw);
        ui_set_attribute(engine, panel, "style", "--Case:first;--Case:second;--case:lower;height:10px;height:30px");
        assert(ui_get_style_property(engine, panel, "--Case") == "second");
        assert(ui_get_style_property(engine, panel, "--case") == "lower");
        assert(ui_remove_style_property(engine, panel, "height") == "30px");
        assert(ui_get_style_property(engine, panel, "height").empty());
        ui_set_attribute(engine, panel, "style",
            R"css(--Text:'a;b';--Tokens:fn(a;b);--Nested:[{a;b}];--Escaped:"a\\";--Brace:'};--bbl-probe:/*text*/';height:20px)css");
        assert(ui_get_style_property(engine, panel, "--Text") == "'a;b'");
        assert(ui_remove_style_property(engine, panel, "--Tokens") == "fn(a;b)");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto projected_text = runtime.projected_elements.at(panel.value).element->GetProperty<Rml::String>("--Text");
        assert(projected_text == "'a;b'");
        auto* projected_panel = runtime.projected_elements.at(panel.value).element;
        assert(projected_panel->GetProperty<Rml::String>("--Nested") == "[{a;b}]");
        assert(projected_panel->GetProperty<Rml::String>("--Escaped") == R"css("a\\")css");
        assert(projected_panel->GetProperty<Rml::String>("--Brace") == "'};--bbl-probe:/*text*/'");
        assert(projected_panel->GetClientHeight() == 20.f);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
