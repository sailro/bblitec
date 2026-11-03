#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool result, const char* message) {
        if (!result)
            throw std::runtime_error(message);
    };
    const auto expect = [&](double actual, double wanted, const char* message) {
        if (std::abs(actual - wanted) > .1) {
            std::fprintf(stderr, "%s: %.3f != %.3f\n", message, actual, wanted);
            check(false, message);
        }
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Zoom fixture", 1280, 720, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto make = [&](const char* style, const char* classes = "") {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            ui_set_attribute(engine, h, "class", classes);
            return h;
        };
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(engine, sheet, "zoomed", "zoom:2;");
        ui_add_class_style(engine, sheet, "tile",
                           "width:50px;height:20px;border:1px solid #ffffff;border-radius:4px;");
        ui_add_class_style(engine, sheet, "scaled", "--scale:1.5;zoom:var(--scale);");
        // The effective zoom multiplies down the tree; percentages stay of the zoomed box.
        const auto outer =
            make("position:absolute;left:0;top:0;width:400px;font-size:10px;line-height:12px;",
                 "zoomed");
        const auto tile = make("", "tile");
        const auto half = make("width:50%;height:4px;");
        const auto inner = make("zoom:150%;");
        const auto nested = make("font-size:2em;", "tile");
        const auto varied = make("width:10px;height:10px;", "scaled");
        const auto unzoomed = make("width:10px;height:10px;zoom:0;");
        const auto scroller = make("width:40px;height:30px;overflow:auto;");
        const auto content = make("width:10px;height:200px;");
        ui_append_child(engine, outer, tile);
        ui_append_child(engine, outer, half);
        ui_append_child(engine, outer, inner);
        ui_append_child(engine, inner, nested);
        ui_append_child(engine, outer, varied);
        ui_append_child(engine, outer, unzoomed);
        ui_append_child(engine, outer, scroller);
        ui_append_child(engine, scroller, content);
        ui_append_to_root(engine, outer);
        for (const auto handle : {tile, nested})
            static_cast<void>(ui_get_client_rect(engine, handle));
        pal::UiRmlRuntime runtime(engine, window, 1280, 720);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 1280, 720); };
        update();
        const auto raw = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        const auto width = [&](UiElementHandle handle) {
            return raw(handle)->GetBox().GetSize(Rml::BoxArea::Border).x;
        };
        expect(width(outer), 800, "an element's own lengths carry its zoom");
        expect(width(tile), 104, "a child's lengths carry the inherited zoom");
        expect(width(half), 400, "a percentage is of the zoomed containing block");
        expect(width(nested), 156, "zooms multiply down the tree");
        expect(width(varied), 30, "a zoom substituted through a custom property");
        expect(width(unzoomed), 20, "a zero zoom is no zoom");
        expect(raw(tile)->GetComputedValues().font_size(), 20, "an inherited font size zooms");
        expect(raw(inner)->GetComputedValues().font_size(), 30,
               "an inherited font size takes the element's own zoom");
        expect(raw(nested)->GetComputedValues().font_size(), 60,
               "em font sizes are of the zoomed parent font size");
        expect(raw(inner)->GetComputedValues().line_height().value, 36,
               "an inherited absolute line height takes the element's own zoom");
        expect(raw(tile)->GetRenderBox(Rml::BoxArea::Border).GetBorderRadius()[0].x, 8,
               "border radii zoom");

        // Client rectangles are zoomed; offset and client extents are not.
        update();
        const auto rect = ui_get_client_rect(engine, nested);
        expect(rect.zoom, 3, "the measured box records its effective zoom");
        expect(rect.offset_width, 156, "client rectangles include the zoom");
        expect(rect.unzoomed().offset_width, 52, "offsetWidth is without the zoom");
        expect(rect.unzoomed().width, 50, "clientWidth is without the zoom");

        // Scroll offsets are CSS pixels of the element: RmlUi scrolls them zoomed.
        ui_set_scroll_offset(engine, scroller, false, 25);
        update();
        expect(raw(scroller)->GetScrollTop(), 50, "a scroll write zooms");
        update();
        expect(ui_scroll_offset(engine, scroller, false), 25, "a scroll read is without the zoom");

        // Live zoom changes rescale the subtree, and removing them restores the cascade.
        auto* raw_tile = raw(tile);
        ui_set_style_property(engine, outer, "zoom", "1");
        update();
        expect(width(outer), 400, "an inline zoom overrides the class zoom");
        expect(width(tile), 52, "descendants follow a zoom change");
        // 1.5-pixel borders snap down to whole pixels, as a border width does.
        expect(width(nested), 77, "nested zooms follow an ancestor's change");
        expect(raw(nested)->GetComputedValues().font_size(), 30, "font sizes follow a zoom change");
        expect(raw(tile)->GetRenderBox(Rml::BoxArea::Border).GetBorderRadius()[0].x, 4,
               "border radii follow a zoom change");
        ui_set_style_property(engine, varied, "--scale", "0.5");
        update();
        expect(width(varied), 5, "a changed custom property rescales its zoom");
        ui_remove_style_property(engine, outer, "zoom");
        update();
        expect(width(outer), 800, "the class zoom returns");
        expect(width(nested), 156, "the subtree returns to the class zoom");
        expect(width(varied), 10, "the substituted zoom composes with the restored one");
        check(raw(tile) == raw_tile, "zoom changes keep element identity");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Zoom fixture: %s\n", error.what());
    return 1;
}
