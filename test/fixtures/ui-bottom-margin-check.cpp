#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Bottom margins", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        struct Case {
            const char* name;
            UiElementHandle parent, next;
            float height, next_y;
        };
        std::vector<Case> cases;
        const auto make = [&](const std::string& style, UiElementHandle parent = {}) {
            const auto element = ui_create_element(engine, "div");
            ui_set_attribute(engine, element, "style", style);
            if (parent.value == invalid_handle)
                ui_append_to_root(engine, element);
            else
                ui_append_child(engine, parent, element);
            return element;
        };
        const auto add_case = [&](const char* name, const char* parent_style,
                                  const char* child_style, float height, float next_y,
                                  const char* nested_style = nullptr) {
            const auto root = make("position:absolute;left:0;top:0;width:200px;");
            const auto parent = make(std::string("border-top:1px #000000;") + parent_style, root);
            const auto child_parent =
                nested_style ? make(std::string("border-top:1px #000000;") + nested_style, parent)
                             : parent;
            make(std::string("height:20px;") + child_style, child_parent);
            const auto next = make("height:10px;margin-top:8px;", root);
            cases.push_back({name, parent, next, height, next_y});
        };
        add_case("block child", "", "margin-bottom:8px;", 21, 29);
        add_case("grid child", "", "display:grid;margin-bottom:8px;", 21, 29);
        add_case("nested positive margins", "margin-bottom:4px;", "margin-bottom:12px;", 22, 34,
                 "margin-bottom:8px;");
        add_case("nested mixed margins", "margin-bottom:8px;", "margin-bottom:-5px;", 22, 27,
                 "margin-bottom:10px;");
        add_case("mixed following sibling", "margin-bottom:10px;", "margin-bottom:-5px;", 21, 26);
        add_case("nested negative margins", "margin-bottom:-4px;", "margin-bottom:-12px;", 22, 18,
                 "margin-bottom:-8px;");
        add_case("bottom padding barrier", "padding-bottom:4px;", "margin-bottom:8px;", 33, 41);
        add_case("bottom border barrier", "border-bottom:2px #000000;", "margin-bottom:8px;", 31,
                 39);
        add_case("top padding does not block bottom", "padding-top:4px;", "margin-bottom:8px;", 25,
                 33);
        add_case("definite height barrier", "height:40px;", "margin-bottom:8px;", 41, 49);
        add_case("minimum height barrier", "min-height:40px;", "margin-bottom:8px;", 41, 49);
        add_case("scroll context barrier", "overflow:auto;", "margin-bottom:8px;", 29, 37);
        add_case("flow-root context barrier", "display:flow-root;", "margin-bottom:8px;", 29, 37);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto verify = [&](const Case& item) {
            auto* parent = runtime.projected_elements.at(item.parent.value).element;
            auto* next = runtime.projected_elements.at(item.next.value).element;
            const float height = parent->GetBox().GetSize(Rml::BoxArea::Border).y;
            const float next_y = next->GetAbsoluteOffset(Rml::BoxArea::Border).y;
            if (std::abs(height - item.height) > .1f || std::abs(next_y - item.next_y) > .1f) {
                std::fprintf(stderr, "%s: height %.3f/%.3f, following %.3f/%.3f\n", item.name,
                             height, item.height, next_y, item.next_y);
                throw std::runtime_error("Bottom margin layout mismatch");
            }
        };
        for (const auto& item : cases)
            verify(item);
        ui_set_style_property(engine, cases[0].parent, "padding-bottom", "4px");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        verify({"live padding", cases[0].parent, cases[0].next, 33, 41});
        ui_remove_style_property(engine, cases[0].parent, "padding-bottom");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        verify(cases[0]);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Bottom margin fixture: %s\n", error.what());
    return 1;
}
