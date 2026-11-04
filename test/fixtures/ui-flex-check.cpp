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
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI flex fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, panel, "style",
            "display:flex;width:220px;height:120px;flex-flow:wrap row;align-content:start;align-items:start;column-gap:10px;row-gap:8px;");
        std::vector<UiElementHandle> children;
        for (int i = 0; i < 3; ++i) {
            const auto child = ui_create_element(engine, "div");
            ui_set_attribute(engine, child, "style", "flex:0 0 100px;height:20px;");
            ui_append_child(engine, panel, child);
            children.push_back(child);
        }
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&]() { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto element = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        const auto box = [&](size_t index, float x, float y, float width, float height) {
            update();
            auto* child = element(children.at(index));
            const auto offset = child->GetAbsoluteOffset(Rml::BoxArea::Border) -
                                element(panel)->GetAbsoluteOffset(Rml::BoxArea::Content);
            const auto size = child->GetBox().GetSize(Rml::BoxArea::Border);
            if (std::abs(offset.x - x) >= .1f || std::abs(offset.y - y) >= .1f ||
                std::abs(size.x - width) >= .1f || std::abs(size.y - height) >= .1f)
                std::fprintf(
                    stderr,
                    "Flex child %zu: actual %.2f %.2f %.2f %.2f; expected %.2f %.2f %.2f %.2f\n",
                    index, offset.x, offset.y, size.x, size.y, x, y, width, height);
            assert(std::abs(offset.x - x) < .1f && std::abs(offset.y - y) < .1f);
            assert(std::abs(size.x - width) < .1f && std::abs(size.y - height) < .1f);
        };
        box(0, 0, 0, 100, 20);
        box(1, 110, 0, 100, 20);
        box(2, 0, 28, 100, 20);
        ui_set_style_property(engine, panel, "width", "330px");
        box(2, 220, 0, 100, 20);
        ui_set_style_property(engine, panel, "width", "220px");
        ui_set_style_property(engine, panel, "flex-flow", "wrap-reverse row");
        box(2, 0, 0, 100, 20);
        box(0, 0, 28, 100, 20);
        ui_set_style_property(engine, panel, "align-content", "end");
        box(2, 0, 72, 100, 20);
        box(0, 0, 100, 100, 20);
        ui_set_style_property(engine, panel, "flex-flow", "row");
        update();
        assert(element(panel)->GetComputedValues().flex_wrap() == Rml::Style::FlexWrap::Nowrap);
        ui_set_style_property(engine, panel, "flex-flow", "wrap");
        update();
        assert(element(panel)->GetComputedValues().flex_direction() ==
               Rml::Style::FlexDirection::Row);

        // A new declaration list resets the inline layout in authored order.
        ui_set_attribute(
            engine, panel, "style",
            "display:flex;width:220px;height:100px;align-items:start;column-gap:10px;");
        ui_set_style_property(engine, panel, "flex-flow", "row-reverse nowrap");
        ui_set_style_property(engine, panel, "justify-content", "start");
        ui_set_style_property(engine, children[2], "display", "none");
        box(0, 110, 0, 100, 20);
        box(1, 0, 0, 100, 20);
        ui_set_style_property(engine, panel, "justify-content", "end");
        box(0, 120, 0, 100, 20);
        ui_set_style_property(engine, panel, "flex-flow", "row wrap-reverse");
        ui_set_style_property(engine, panel, "align-content", "end");
        ui_set_style_property(engine, children[0], "height", "40px");
        ui_set_style_property(engine, children[1], "align-self", "start");
        box(1, 120, 60, 100, 20);
        ui_set_style_property(engine, children[1], "align-self", "end");
        box(1, 120, 80, 100, 20);

        ui_set_style_property(engine, children[0], "flex", "1");
        update();
        const auto* basis = element(children[0])->GetProperty(Rml::PropertyId::FlexBasis);
        assert(basis->unit == Rml::Unit::PERCENT && basis->Get<float>() == 0.f);
        ui_set_style_property(engine, children[0], "flex", "none");
        update();
        assert(element(children[0])->GetComputedValues().flex_grow() == 0.f);
        assert(element(children[0])->GetComputedValues().flex_shrink() == 0.f);
        ui_set_style_property(engine, children[0], "flex", "initial");
        update();
        assert(element(children[0])->GetComputedValues().flex_shrink() == 1.f);

        // order lays items out and paints them in order-modified document order.
        ui_remove(engine, panel);
        const auto row = ui_create_element(engine, "div");
        ui_set_attribute(engine, row, "style",
                         "display:flex;width:330px;height:40px;align-items:start;column-gap:10px;");
        children.clear();
        for (const char* color : {"#ff0000", "#00ff00", "#0000ff"}) {
            const auto child = ui_create_element(engine, "div");
            ui_set_attribute(engine, child, "style",
                             std::string("flex:0 0 100px;height:20px;background-color:") + color);
            ui_append_child(engine, row, child);
            children.push_back(child);
        }
        ui_append_to_root(engine, row);
        const auto placed = [&](size_t index, float x) {
            update();
            const auto offset =
                element(children.at(index))->GetAbsoluteOffset(Rml::BoxArea::Border) -
                element(row)->GetAbsoluteOffset(Rml::BoxArea::Content);
            if (std::abs(offset.x - x) >= .1f)
                std::fprintf(stderr, "Ordered child %zu: actual %.2f; expected %.2f\n", index,
                             offset.x, x);
            assert(std::abs(offset.x - x) < .1f);
        };
        // Each child paints its own channel: red, green, blue.
        const auto painted = [&](std::initializer_list<int> order) {
            update();
            const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
            assert(frame.draws.size() == order.size());
            auto expected = order.begin();
            for (const auto& draw : frame.draws) {
                const auto& vertex = frame.vertices.at(frame.indices.at(draw.first_index));
                const int channels[] = {vertex.red, vertex.green, vertex.blue};
                for (int channel = 0; channel < 3; ++channel)
                    assert(channels[channel] == (channel == *expected ? 255 : 0));
                ++expected;
            }
        };
        ui_set_style_property(engine, children[2], "order", "-1");
        placed(2, 0);
        placed(0, 110);
        placed(1, 220);
        painted({2, 0, 1});
        // Equal orders keep document order; a positive order moves an item last.
        ui_set_style_property(engine, children[0], "order", "1");
        placed(2, 0);
        placed(1, 110);
        placed(0, 220);
        ui_set_style_property(engine, children[2], "order", "");
        ui_set_style_property(engine, children[0], "order", "");
        placed(0, 0);
        placed(2, 220);
        painted({0, 1, 2});

        // Shrink-to-fit flex containers measure their items' cyclic inline percentages as auto,
        // zero or none, then resolve them against the measured width.
        ui_remove(engine, row);
        const auto make = [&](const char* style) {
            const auto handle = ui_create_element(engine, "div");
            ui_set_attribute(engine, handle, "style", style);
            return handle;
        };
        const auto column =
            make("position:fixed;top:10px;right:18px;display:flex;flex-direction:column;"
                 "align-items:center;padding:14px 20px;box-sizing:border-box;");
        const auto column_inner =
            make("width:100%;display:flex;flex-direction:column;align-items:center;");
        const auto column_title = make("padding:7px 26px;min-width:0;");
        ui_append_child(engine, column_title, make("width:150px;height:10px;"));
        const auto column_fields = make("width:100%;display:grid;");
        const auto column_field =
            make("display:grid;grid-template-columns:82px minmax(0,1fr);gap:10px;");
        ui_append_child(engine, column_field, make("width:40px;height:10px;"));
        ui_append_child(engine, column_field, make("width:177px;height:10px;"));
        ui_append_child(engine, column_fields, column_field);
        ui_append_child(engine, column_inner, column_title);
        ui_append_child(engine, column_inner, column_fields);
        ui_append_child(engine, column, column_inner);
        ui_append_to_root(engine, column);
        const auto shrink_row =
            make("position:fixed;top:200px;right:18px;display:flex;align-items:start;");
        const auto half = make("width:50%;padding:0 5%;");
        ui_append_child(engine, half, make("width:100px;height:10px;"));
        const auto rest = make("");
        ui_append_child(engine, rest, make("width:60px;height:10px;"));
        ui_append_child(engine, shrink_row, half);
        ui_append_child(engine, shrink_row, rest);
        ui_append_to_root(engine, shrink_row);
        update();
        const auto measured = [&](UiElementHandle handle, float expected, const char* label) {
            const float width = element(handle)->GetBox().GetSize(Rml::BoxArea::Border).x;
            if (std::abs(width - expected) >= .1f) {
                std::fprintf(stderr, "%s: actual %.2f; expected %.2f\n", label, width, expected);
                std::exit(1);
            }
        };
        measured(column, 309, "column panel takes its content width");
        measured(column_inner, 269, "a full percentage width resolves against the measured panel");
        measured(column_title, 202, "a centered item keeps its content width");
        measured(shrink_row, 160, "row panel measures a percentage item by its content");
        measured(half, 96, "a half percentage width and its padding resolve against the row");
        const auto rest_x = element(rest)->GetAbsoluteOffset(Rml::BoxArea::Border).x -
                            element(shrink_row)->GetAbsoluteOffset(Rml::BoxArea::Content).x;
        if (std::abs(rest_x - 96) >= .1f) {
            std::fprintf(stderr, "row rest offset: actual %.2f; expected 96\n", rest_x);
            std::exit(1);
        }

        // An item's percentage min/max widths resolve against its flex container, not against the
        // zero base its own shrink-to-fit measurement sees.
        const auto clamped = [&](const char* panel_style, const char* item_style, int content) {
            const auto clamped_panel =
                make((std::string("position:fixed;top:300px;right:18px;width:356px;display:flex;"
                                  "padding:14px 28px;box-sizing:border-box;") +
                      panel_style)
                         .c_str());
            const auto clamped_inner =
                make("width:100%;display:flex;flex-direction:column;align-items:center;");
            const auto item = make((std::string("padding:7px 26px;border:10px solid transparent;"
                                                "box-sizing:border-box;min-width:0;") +
                                    item_style)
                                       .c_str());
            ui_append_child(engine, item,
                            make(("width:" + std::to_string(content) + "px;height:10px;").c_str()));
            ui_append_child(engine, clamped_inner, item);
            ui_append_child(engine, clamped_panel, clamped_inner);
            ui_append_to_root(engine, clamped_panel);
            return item;
        };
        const auto fits =
            clamped("flex-direction:column;align-items:center;", "max-width:100%;", 150);
        const auto wide =
            clamped("flex-direction:column;align-items:center;", "max-width:100%;", 400);
        const auto calc = clamped("flex-direction:column;align-items:center;",
                                  "max-width:calc(100% - 52px);", 400);
        const auto minimum =
            clamped("flex-direction:column;align-items:center;", "min-width:400px;", 150);
        const auto row_panel =
            make("position:fixed;top:360px;right:18px;width:356px;display:flex;align-items:start;"
                 "padding:14px 28px;box-sizing:border-box;");
        const auto row_max = make("max-width:50%;");
        ui_append_child(engine, row_max, make("width:400px;height:10px;"));
        ui_append_child(engine, row_panel, row_max);
        ui_append_to_root(engine, row_panel);
        update();
        measured(fits, 222, "a percentage maximum leaves fitting content alone");
        measured(wide, 300, "a percentage maximum caps wide content at its container");
        measured(calc, 248, "a percentage maximum in calc() resolves against its container");
        measured(minimum, 400, "a minimum width wins over the available width");
        measured(row_max, 150, "a row item's percentage maximum resolves against its row");

        // A shrink-to-fit row sums its items' max-content contributions: each max-content width,
        // bounded by the flex base size where the item cannot grow or shrink, then by min/max.
        struct Contribution {
            const char* label;
            const char* row;
            std::vector<std::pair<const char*, int>> items;
            float width;
        };
        const std::vector<Contribution> contributions{
            {"growable zero bases", "", {{"flex:1;", 100}, {"flex:1;", 60}}, 160},
            {"a fixed percentage basis", "", {{"flex:0 0 50%;", 100}, {"", 60}}, 160},
            {"zero bases and a gap",
             "column-gap:10px;",
             {{"flex:1 1 0px;", 100}, {"flex:1 1 0px;", 60}},
             170},
            {"an inflexible basis floors and caps", "", {{"flex:0 0 200px;", 100}}, 200},
            {"a definite width caps an inflexible item", "", {{"width:50px;", 100}}, 50},
            {"a maximum width clamps", "", {{"max-width:50px;", 100}}, 50},
            {"edges add to the contribution",
             "",
             {{"margin:0 7px;padding:0 3px;flex:1;", 100}},
             120},
        };
        std::vector<UiElementHandle> rows;
        for (const auto& contribution : contributions) {
            const auto measured_row =
                make((std::string(
                          "position:fixed;top:300px;right:18px;display:flex;align-items:start;") +
                      contribution.row)
                         .c_str());
            for (const auto& [style, content] : contribution.items) {
                const auto item = make(style);
                ui_append_child(
                    engine, item,
                    make(("width:" + std::to_string(content) + "px;height:10px;").c_str()));
                ui_append_child(engine, measured_row, item);
            }
            ui_append_to_root(engine, measured_row);
            rows.push_back(measured_row);
        }
        update();
        for (size_t index = 0; index < rows.size(); ++index)
            measured(rows[index], contributions[index].width, contributions[index].label);
        // Without automatic minimums the items share the measured width.
        const auto zero_minimums =
            make("position:fixed;top:400px;right:18px;display:flex;align-items:start;");
        std::vector<UiElementHandle> shared;
        for (const int content : {100, 60}) {
            shared.push_back(make("flex:1 1 0px;min-width:0;"));
            ui_append_child(engine, shared.back(),
                            make(("width:" + std::to_string(content) + "px;height:10px;").c_str()));
            ui_append_child(engine, zero_minimums, shared.back());
        }
        ui_append_to_root(engine, zero_minimums);
        update();
        measured(zero_minimums, 160, "zero minimums still measure their content");
        measured(shared[0], 80, "zero minimums share the measured width");
        measured(shared[1], 80, "zero minimums share the measured width equally");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
