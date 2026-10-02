#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    using namespace bbl::pal;
    const auto contrast = color_ui_filter("contrast", 0);
    assert(contrast.matrix[0] == 0 && contrast.offset[0] == .5f && contrast.matrix[15] == 1);
    const auto gray = color_ui_filter("grayscale", 1);
    assert(std::abs(gray.matrix[0] - .2126f) < .00001f && gray.matrix[0] == gray.matrix[4]);
    assert(color_ui_filter("opacity", 2).matrix[15] == 1);
    const std::string stylesheet =
        ".sample[data-note=';filter:blur(9px);}']{width:40px;/* } ; */filter:"
        "blur(calc(var(--Size, 2px) * 2)) /* ); } */;height:30px;}"
        ".other{filter:var(--Filter, ');}') drop-shadow(2px 3px);left:8px;}";
    const auto projected = project_css_outside_filters(stylesheet, rml_css_density_units);
    assert(projected == ".sample[data-note=';filter:blur(9px);}']{width:40dp;/* } ; */filter:"
                        "blur(calc(var(--Size, 2px) * 2)) /* ); } */;height:30dp;}"
                        ".other{filter:var(--Filter, ');}') drop-shadow(2px 3px);left:8dp;}");
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI filter fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, panel, "style",
            "position:absolute;left:80px;top:80px;width:160px;height:120px;background-color:#804020;filter:brightness(50%) contrast(150%);");
        ui_set_attribute(
            engine, child, "style",
            "width:60px;height:50px;background-color:#ffffff;filter:drop-shadow(8px 4px 3px rgba(0,0,255,.5)) drop-shadow(-4px 8px 0 red);");
        ui_append_child(engine, panel, child);
        ui_append_to_root(engine, panel);
        UiRmlRuntime runtime(engine, window, 640, 480);
        const auto& frame = record_ui_rml_frame(runtime, 640, 480);
        assert(frame.layer_count == 2 && frame.composites.size() == 2 &&
               frame.operations.size() == 4);
        const auto& inner = frame.composites[0];
        const auto& outer = frame.composites[1];
        assert(inner.source == 2 && inner.destination == 1 && outer.source == 1 &&
               outer.destination == 0);
        assert(inner.filters.size() == 2 && inner.filters[0].kind == UiFilterKind::DropShadow);
        assert(inner.filters[0].offset_x == 8 && inner.filters[0].offset_y == 4 &&
               inner.filters[0].sigma == 3);
        assert(inner.filters[0].color[2] > .49f &&
               inner.filters[0].color[2] == inner.filters[0].color[3]);
        assert(outer.filters.size() == 2 && outer.filters[0].matrix[0] == .5f &&
               outer.filters[1].matrix[0] == 1.5f);
        for (const auto& composite : frame.composites) {
            const auto plan = ui_filter_plan(composite);
            for (const auto& draw : plan.draws) {
                assert(draw.output != draw.input && draw.output != draw.secondary);
                assert(draw.width > 0 && draw.height > 0);
            }
        }
        std::vector<std::uint32_t> order;
        for_each_ui_segment(
            frame,
            [&](std::size_t first, std::size_t last, std::uint32_t layer) {
                assert(first < last);
                order.push_back(layer);
            },
            [&](const UiRenderOperation& operation) {
                if (operation.kind == UiRenderOperation::Kind::Composite)
                    order.push_back(10 + operation.index);
            });
        assert((order == std::vector<std::uint32_t>{1, 2, 10, 11}));
        ui_set_style_property(engine, child, "backdrop-filter", "blur(2px)");
        update_ui_rml_runtime(runtime, 640, 480);
        const auto& nested = record_ui_rml_frame(runtime, 640, 480);
        assert(nested.composites.size() == 4 && nested.backdrops.empty());
        assert(nested.composites[0].source == 1 && nested.composites[0].destination == 3);
        assert(nested.composites[1].source == 3 && nested.composites[1].destination == 2);
        ui_set_style_property(engine, panel, "filter", "none");
        ui_set_style_property(engine, child, "filter", "none");
        update_ui_rml_runtime(runtime, 640, 480);
        const auto& backdrop = record_ui_rml_frame(runtime, 640, 480);
        assert(backdrop.composites.empty() && backdrop.backdrops.size() == 1 &&
               backdrop.operations.size() == 2);
        ui_set_style_property(engine, child, "filter", "url(mask.svg)");
        bool refused = false;
        try {
            update_ui_rml_runtime(runtime, 640, 480);
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find("Unsupported retained UI filter value") !=
                      std::string::npos;
        }
        assert(refused);
    }
    {
        Engine engine;
        const auto parent = ui_create_element(engine, "div");
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(engine, parent, "style", "--Tone:.4;color:#2080c0;");
        ui_set_attribute(engine, child, "style", "width:40px;height:30px;background:#ffffff;");
        ui_set_attribute(engine, child, "class", "variable-filter");
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(
            engine, sheet, "variable-filter",
            "filter:brightness(clamp(.1,calc(var(--Missing, 1) - var(--Tone, 0) * .5),max(.9,1))) "
            "drop-shadow(2px 4px calc(var(--Tone) * 5px) currentColor) "
            "drop-shadow(-2px 0) drop-shadow(0 0 0 rgba(255,0,0,calc(var(--Tone) * .5)));"
            "margin-left:7px;");
        ui_append_child(engine, parent, child);
        ui_append_to_root(engine, parent);
        UiRmlRuntime runtime(engine, window, 640, 480);
        const auto inspect = [&](float brightness, float sigma, float blue, float alpha) {
            const auto& frame = record_ui_rml_frame(runtime, 640, 480);
            assert(frame.composites.size() == 1);
            const auto& filters = frame.composites[0].filters;
            assert(filters.size() == 4);
            assert(std::abs(filters[0].matrix[0] - brightness) < .0001f);
            assert(std::abs(filters[1].sigma - sigma) < .0001f);
            assert(std::abs(filters[1].color[2] - blue) < .005f);
            assert(filters[1].color == filters[2].color);
            assert(std::abs(filters[3].color[3] - alpha) < .005f);
        };
        inspect(.8f, 2, 192.f / 255, .2f);
        ui_set_style_property(engine, parent, "--Tone", ".8");
        ui_set_style_property(engine, parent, "color", "#40c080");
        update_ui_rml_runtime(runtime, 640, 480);
        inspect(.6f, 4, 128.f / 255, .4f);
        ui_set_style_property(engine, child, "filter", "brightness(calc(1 - var(--Tone) * .25))");
        update_ui_rml_runtime(runtime, 640, 480);
        const auto& changed = record_ui_rml_frame(runtime, 640, 480);
        assert(changed.composites.size() == 1 && changed.composites[0].filters.size() == 1);
        assert(std::abs(changed.composites[0].filters[0].matrix[0] - .8f) < .0001f);
        ui_remove_style_property(engine, child, "filter");
        update_ui_rml_runtime(runtime, 640, 480);
        inspect(.6f, 4, 128.f / 255, .4f);
        ui_set_style_property(engine, child, "filter",
                              "drop-shadow(0 0 rgba(255,0,0,calc(var(--Tone) * 2)))");
        update_ui_rml_runtime(runtime, 640, 480);
        const auto& opaque = record_ui_rml_frame(runtime, 640, 480);
        assert(opaque.composites[0].filters[0].color[3] == 1);
        ui_set_style_property(engine, parent, "--Radius", "3px");
        ui_set_style_property(engine, child, "filter", "blur(calc(var(--Radius) * 2))");
        update_ui_rml_runtime(runtime, 640, 480);
        const auto& radius = record_ui_rml_frame(runtime, 640, 480);
        assert(radius.composites[0].filters[0].sigma == 6);
    }
    for (const auto& [filter, variable, error_text] :
         std::vector<std::tuple<std::string, std::string, std::string>>{
             {"blur(var(--Unsafe))", "2em", "filter unit"},
             {"drop-shadow(var(--Unsafe) 0)", "-2em", "filter unit"},
             {"brightness(var(--Unsafe))", "2px", "filter arguments"},
             {"blur(var(--Unsafe))", "2", "filter arguments"},
             {"brightness(calc(var(--Unsafe) + 1))", "2px", "CSS math"},
         }) {
        Engine engine;
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(engine, child, "style", "width:40px;height:30px;background:white;");
        ui_append_to_root(engine, child);
        UiRmlRuntime runtime(engine, window, 640, 480);
        ui_set_style_property(engine, child, "filter", filter);
        ui_set_style_property(engine, child, "--Unsafe", variable);
        bool refused = false;
        try {
            update_ui_rml_runtime(runtime, 640, 480);
            static_cast<void>(record_ui_rml_frame(runtime, 640, 480));
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find(error_text) != std::string::npos;
        }
        assert(refused);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
