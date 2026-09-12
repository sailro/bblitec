#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-selector/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
int measured_rectangles = 0;
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
    SDL_Window* window = SDL_CreateWindow("Selector fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        engine.ui_measure_element = [](Engine& owner, UiElementHandle element) {
            ++pal::measured_rectangles;
            return UiClientRect{0, 0, ui_get_attribute(owner, element, "data-mode") == "a,b" ? 90.0 : 120.0, 40};
        };
        assert(generated_main() == 0);
        assert(pal::measured_rectangles == 2);
        engine.ui_measure_element = nullptr;
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto entry = ui_get_element_by_id(engine, "entry"), panel = ui_get_element_by_id(engine, "panel");
        const auto lead = ui_get_element_by_id(engine, "lead"), label = ui_get_element_by_id(engine, "label");
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto matches = [&](UiElementHandle handle, std::string_view selector) {
            bool found = false;
            runtime.for_each_matching_style_rule(handle, [&](const UiStyleRule& rule, std::size_t) {
                found = found || pal::ui_style_rule_selector(rule) == selector;
            });
            return found;
        };
        const auto background = [&](std::uint8_t r, std::uint8_t g, std::uint8_t b) {
            const auto actual = runtime.projected_elements.at(entry.value).element->GetProperty(Rml::PropertyId::BackgroundColor)->Get<Rml::Colourb>();
            assert(actual.red == r && actual.green == g && actual.blue == b);
        };
        update();
        assert(matches(entry, "button"));
        assert(matches(entry, ".panel.selected.extra > .entry[disabled]"));
        assert(matches(entry, ".lead + .entry"));
        assert(matches(entry, ".lead ~ .entry"));
        assert(matches(entry, ".entry[data-mode=\"a,b\"]"));
        assert(matches(label, ".panel .entry span"));
        assert(matches(lead, ".panel > button:nth-child(1)"));
        assert(matches(entry, ".panel > button:nth-last-child(1)"));
        assert(matches(lead, ".panel > button:nth-child(2n+1)"));
        assert(matches(lead, ".panel > button:nth-last-of-type(2)"));
        assert(matches(entry, ".entry:not(.muted, #blocked)"));
        assert(!matches(entry, ".entry:not(:disabled)"));
        assert(matches(label, ".entry > span:only-child"));
        assert(!matches(entry, ".entry:empty"));
        background(0x44, 0x55, 0x66);
        // Reordering invalidates both sibling relationships in the same update.
        ui_append_child(engine, panel, lead);
        update();
        assert(!matches(entry, ".lead + .entry"));
        assert(!matches(entry, ".lead ~ .entry"));
        assert(matches(entry, ".panel > button:nth-child(1)"));
        assert(matches(entry, ".panel > button:nth-child(2n+1)"));
        assert(!matches(lead, ".panel > button:nth-child(2n+1)"));
        ui_remove_attribute(engine, entry, "disabled");
        update();
        assert(matches(entry, ".entry:not(:disabled)"));
        background(0x11, 0x22, 0x33);
        runtime.context->ProcessMouseMove(30, 30, 0);
        update();
        assert(matches(entry, ".panel:hover .entry"));
        assert(matches(entry, ".panel :hover"));
        assert(!matches(panel, ".panel :hover"));
        background(0x77, 0x88, 0x99);
        runtime.context->ProcessMouseMove(400, 300, 0);
        ui_focus(engine, entry, true);
        update();
        assert(matches(label, ".entry:focus-visible span"));
        assert(matches(lead, ".panel:focus-within .lead"));
        const auto lead_color = runtime.projected_elements.at(lead.value).element->GetProperty(Rml::PropertyId::Color)->Get<Rml::Colourb>();
        assert(lead_color.red == 0xab && lead_color.green == 0xcd && lead_color.blue == 0xef);
        const auto color = runtime.projected_elements.at(label.value).element->GetProperty(Rml::PropertyId::Color)->Get<Rml::Colourb>();
        assert(color.red == 0xaa && color.green == 0xbb && color.blue == 0xcc);
        background(0x11, 0x22, 0x33);
        const auto outside = ui_create_element(engine, "button");
        ui_append_child(engine, ui_document_root(engine, UiDocumentPart::Body), outside);
        ui_focus(engine, outside, true);
        update();
        assert(!matches(lead, ".panel:focus-within .lead"));
        ui_remove(engine, label);
        update();
        assert(matches(entry, ".entry:empty"));
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
