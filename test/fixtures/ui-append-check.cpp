#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-append/program.hpp"
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

std::string text_content(Rml::Element& element) {
    if (auto* text = rmlui_dynamic_cast<Rml::ElementText*>(&element)) return text->GetText();
    std::string result;
    for (int index = 0; index < element.GetNumChildren(); ++index) result += text_content(*element.GetChild(index));
    return result;
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI append fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    assert(generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        const auto panel = ui_get_element_by_id(engine, "panel");
        const auto child = ui_element(engine, panel).children.at(0);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(panel.value).element;
        auto* child_raw = runtime.projected_elements.at(child.value).element;
        assert(text_content(*raw) == "prefixfirstchildlast");
        assert(text_content(*runtime.document).starts_with("rootprefixfirstchildlast"));
        const auto ordered = ui_get_element_by_id(engine, "ordered");
        const auto other = ui_get_element_by_id(engine, "other");
        assert(text_content(*runtime.projected_elements.at(ordered.value).element) == "AB");
        assert(ui_element(engine, other).children.empty());
        ui_append_child(engine, panel, ui_create_text_node(engine, " &lt;<b>tail</b>"));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(text_content(*raw) == "prefixfirstchildlast &lt;<b>tail</b>");
        assert(runtime.projected_elements.at(child.value).element == child_raw);
        ui_set_text(engine, child, "updated");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(text_content(*raw) == "prefixfirstupdatedlast &lt;<b>tail</b>");
        ui_set_style_property(engine, panel, "display", "flex");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(text_content(*raw) == "prefixfirstupdatedlast &lt;<b>tail</b>");
        assert(runtime.projected_elements.at(child.value).element == child_raw);
        ui_set_style_property(engine, panel, "display", "block");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.projected_elements.at(child.value).element == child_raw);
        ui_set_text(engine, panel, "replacement");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(text_content(*raw) == "replacement" && ui_element(engine, panel).children.empty());
        const auto flex = ui_create_element(engine, "div");
        ui_set_attribute(engine, flex, "style", "display:flex;width:200px;height:40px;");
        const auto label = ui_create_text_node(engine, "visible");
        ui_append_child(engine, flex, label);
        ui_append_to_root(engine, flex);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* label_raw = runtime.projected_elements.at(label.value).element;
        assert(label_raw->GetBox().GetSize().x > 0.f);
        assert(label_raw->GetBox().GetSize().y > 0.f);
        ui_append_text(engine, flex, " adjacent");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(ui_element(engine, flex).children.size() == 1);
        assert(text_content(*runtime.projected_elements.at(flex.value).element) == "visible adjacent");
        ui_set_text(engine, label, " \t");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.projected_elements.at(label.value).element->GetComputedValues().display() == Rml::Style::Display::None);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
