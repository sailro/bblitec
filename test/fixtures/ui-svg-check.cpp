#define main generated_main
#include "../../artifacts/ui-svg/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected SVG asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int run() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Retained SVG", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        const auto svg = ui_get_element_by_id(engine, "icon");
        const auto circle = ui_element(engine, svg).children.at(0);
        assert(ui_element(engine, svg).svg_namespace && ui_element(engine, circle).svg_namespace);
        assert(ui_get_attribute(engine, circle, "r") == "6");
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        auto* raw = runtime.projected_elements.at(svg.value).element;
        assert(raw && raw->GetNumChildren() == 0);
        const auto pixels = [&] {
            const auto& frame = pal::record_ui_rml_frame(runtime, 320, 240);
            std::vector<std::uint8_t> result;
            for (const auto& draw : frame.draws) {
                if (!draw.texture_id)
                    continue;
                const auto found = std::find_if(
                    frame.textures.begin(), frame.textures.end(),
                    [&](const auto& texture) { return texture.id == draw.texture_id; });
                assert(found != frame.textures.end() && found->rgba && !found->rgba->empty());
                result.insert(result.end(), found->rgba->begin(), found->rgba->end());
                for (auto i = draw.first_index; i < draw.first_index + draw.index_count; ++i) {
                    const auto& vertex = frame.vertices.at(frame.indices.at(i));
                    result.insert(result.end(),
                                  {vertex.red, vertex.green, vertex.blue, vertex.alpha});
                }
            }
            return result;
        };
        const auto red = pixels();
        assert(std::any_of(red.begin(), red.end(), [](auto value) { return value != 0; }));
        assert(raw->GetComputedValues().image_color() == Rml::Colourb(255, 0, 0));
        ui_set_style_property(engine, svg, "color", "rgb(0,0,255)");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto blue = pixels();
        assert(blue != red && raw->GetComputedValues().image_color() == Rml::Colourb(0, 0, 255));
        ui_set_attribute(engine, circle, "r", "10");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto bigger = pixels();
        assert(bigger != blue && runtime.projected_elements.at(svg.value).element == raw);
        const auto rectangle = ui_create_svg_element(engine, "rect");
        for (const auto& [name, value] :
             std::array<std::pair<const char*, const char*>, 5>{{{"x", "2"},
                                                                 {"y", "2"},
                                                                 {"width", "20"},
                                                                 {"height", "20"},
                                                                 {"fill", "currentColor"}}})
            ui_set_attribute(engine, rectangle, name, value);
        ui_replace_children(engine, svg);
        ui_append_child(engine, svg, rectangle);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(pixels() != bigger && ui_element(engine, circle).parent.value == invalid_handle);
        ui_set_attribute(engine, rectangle, "fill", "#00ff00");
        ui_set_attribute(engine, rectangle, "stroke", " NONE ");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto green = pixels();
        assert(!raw->HasAttribute("data-bbl-current-color") &&
               raw->GetComputedValues().image_color() == Rml::Colourb(255, 255, 255));
        ui_set_attribute(engine, svg, "viewBox", "0 0 48 48");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(pixels() != green);
        ui_remove_attribute(engine, svg, "viewbox");
        assert(ui_has_attribute(engine, svg, "viewBox"));
        const auto refuses = [](auto action) {
            bool failed = false;
            try {
                action();
            } catch (const std::runtime_error&) {
                failed = true;
            }
            assert(failed);
        };
        refuses([&] { static_cast<void>(ui_get_client_rect(engine, rectangle)); });
        refuses([&] { static_cast<void>(ui_computed_style(engine, rectangle, "display")); });
        refuses([&] { ui_set_attribute(engine, rectangle, "href", "remote.svg"); });
        refuses([&] { ui_set_attribute(engine, rectangle, "fill", "url(#paint)"); });
        for (const auto* paint : {"inherit", "UNSET", "initial", "revert", "revert-layer",
                                  "var(--paint)", "rgb(var(--red),0,0)", "context-fill"})
            refuses([&] { ui_set_attribute(engine, rectangle, "fill", paint); });
        const auto html = ui_create_element(engine, "div");
        refuses([&] { ui_set_attribute(engine, html, "HIDDEN", "until-found"); });
        const auto style = ui_create_element(engine, "style");
        ui_set_attribute(engine, rectangle, "class", "painted");
        ui_add_class_style(engine, style, "painted", "opacity:0.5;");
        ui_append_to_root(engine, style);
        refuses([&] { pal::update_ui_rml_runtime(runtime, 320, 240); });
        ui_remove(engine, style);
        ui_append_child(engine, svg, circle);
        refuses([&] { pal::update_ui_rml_runtime(runtime, 320, 240); });
        ui_remove(engine, circle);
        on_dom_pointer(engine, DomEventTarget::node(circle.value), "click", 1,
                       [](const PlatformMouseEvent&) {});
        ui_append_child(engine, svg, circle);
        refuses([&] { pal::update_ui_rml_runtime(runtime, 320, 240); });
        ui_remove(engine, circle);
        ui_remove(engine, svg);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        assert(!runtime.projected_elements.at(svg.value).element);
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
