#define main generated_main
#include "../../artifacts/ui-background-keywords/program.hpp"
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
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Background keywords", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto raw = [&](const char* id) {
            return runtime.projected_elements.at(ui_get_element_by_id(engine, id).value).element;
        };
        const auto clip = [&](const char* id) {
            return raw(id)->GetProperty(Rml::PropertyId::BackgroundClip)->Get<int>();
        };
        assert(clip("parent") != 0);
        for (const auto* id : {"inherit", "written"}) {
            assert(raw(id)->GetComputedValues().background_color() ==
                   Rml::Colourb(0x12, 0x34, 0x56));
            assert(clip(id) == clip("parent"));
        }
        for (const auto* id : {"initial", "unset", "revert"}) {
            assert(raw(id)->GetComputedValues().background_color().alpha == 0);
            assert(clip(id) == 0);
        }
        ui_set_style_property(engine, ui_get_element_by_id(engine, "parent"), "background-color",
                              "#abcdef");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        for (const auto* id : {"inherit", "written"})
            assert(raw(id)->GetComputedValues().background_color() ==
                   Rml::Colourb(0xab, 0xcd, 0xef));
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
