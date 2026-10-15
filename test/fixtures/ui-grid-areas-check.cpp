#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {
void expectNear(float actual, float expected, const char* message) {
    if (std::abs(actual - expected) > .1f) {
        std::fprintf(stderr, "%s: %.3f expected %.3f\n", message, actual, expected);
        throw std::runtime_error(message);
    }
}
void check(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
} // namespace

int main() try {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Grid areas fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto make = [&](const char* style) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            return h;
        };
        // Areas from a sheet rule, placed by class rules out of document order.
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(
            engine, sheet, "row",
            "display:grid;grid-template-columns:40px 100px 60px;"
            "grid-template-rows:20px 30px;grid-template-areas:\"icon copy progress\" "
            "'icon reward reward';column-gap:10px;row-gap:4px;");
        ui_add_class_style(engine, sheet, "icon", "grid-area:icon;");
        ui_add_class_style(engine, sheet, "copy", "grid-area: copy ;");
        ui_add_class_style(engine, sheet, "reward", "grid-area:reward;");
        ui_add_class_style(engine, sheet, "progress", "grid-area:progress;");
        auto row = make("position:absolute;left:10px;top:10px;width:300px;");
        ui_set_attribute(engine, row, "class", "row");
        auto reward = make("");
        auto progress = make("");
        auto copy = make("");
        auto icon = make("");
        ui_set_attribute(engine, reward, "class", "reward");
        ui_set_attribute(engine, progress, "class", "progress");
        ui_set_attribute(engine, copy, "class", "copy");
        ui_set_attribute(engine, icon, "class", "icon");
        for (auto h : {reward, progress, copy, icon})
            ui_append_child(engine, row, h);
        ui_append_to_root(engine, row);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto offset = [&](auto h, auto parent) {
            return raw(h)->GetAbsoluteOffset(Rml::BoxArea::Border) -
                   raw(parent)->GetAbsoluteOffset(Rml::BoxArea::Content);
        };
        const auto size = [&](auto h) { return raw(h)->GetBox().GetSize(Rml::BoxArea::Border); };
        update();
        expectNear(offset(icon, row).x, 0, "icon area column");
        expectNear(offset(icon, row).y, 0, "icon area row");
        expectNear(size(icon).y, 54, "icon area spans both rows and the row gap");
        expectNear(offset(copy, row).x, 50, "copy area follows the column gap");
        expectNear(size(copy).x, 100, "copy area width");
        expectNear(offset(progress, row).x, 160, "progress area column");
        expectNear(offset(reward, row).x, 50, "reward area start column");
        expectNear(offset(reward, row).y, 24, "reward area second row");
        expectNear(size(reward).x, 170, "reward area spans two columns and the gap");
        expectNear(size(reward).y, 30, "reward area row height");

        // Live area grid, inline grid-area and its removal.
        ui_set_style_property(engine, row, "grid-template-areas",
                              "\"copy progress icon\" \"reward reward icon\"");
        update();
        expectNear(offset(icon, row).x, 160, "icon follows the rewritten areas");
        expectNear(offset(copy, row).x, 0, "copy follows the rewritten areas");
        expectNear(size(reward).x, 150, "reward spans the first two columns");
        ui_set_style_property(engine, copy, "grid-area", "2 / 3");
        update();
        expectNear(offset(copy, row).x, 160, "numeric grid-area column start");
        expectNear(offset(copy, row).y, 24, "numeric grid-area row start");
        ui_set_style_property(engine, copy, "grid-area", "1 / 1 / 3 / 2");
        update();
        expectNear(size(copy).y, 54, "four-line grid-area rows");
        expectNear(size(copy).x, 40, "four-line grid-area columns");
        ui_set_style_property(engine, copy, "grid-row", "reward");
        update();
        expectNear(offset(copy, row).y, 24, "a later grid-row overrides the area row");
        expectNear(offset(copy, row).x, 0, "the area column stays");
        ui_set_style_property(engine, copy, "grid-row", "");
        ui_set_style_property(engine, copy, "grid-area", "");
        update();
        expectNear(offset(copy, row).x, 0, "removed grid-area falls back to the copy rule");

        // An undefined name resolves to the first line after the explicit grid.
        ui_set_style_property(engine, progress, "grid-area", "missing");
        ui_set_style_property(engine, row, "grid-auto-columns", "25px");
        ui_set_style_property(engine, row, "grid-auto-rows", "15px");
        update();
        expectNear(offset(progress, row).x, 230, "undefined area column is implicit");
        expectNear(offset(progress, row).y, 58, "undefined area row is implicit");
        expectNear(size(progress).x, 25, "implicit column uses grid-auto-columns");

        // Areas beyond the sized tracks extend the explicit grid with grid-auto tracks.
        ui_set_style_property(engine, progress, "grid-area", "");
        ui_set_style_property(engine, row, "grid-template-columns", "40px");
        ui_set_style_property(engine, row, "grid-template-areas",
                              "\"icon copy . progress\" \"icon reward reward progress\"");
        update();
        expectNear(offset(copy, row).x, 50, "area-only column follows the sized one");
        expectNear(size(copy).x, 25, "area-only column is sized by grid-auto-columns");
        expectNear(offset(progress, row).x, 120, "a null cell keeps its track");
        expectNear(size(progress).y, 54, "progress spans both area rows");

        // Stacked items share one cell, like an image over its frame.
        auto stack = make("position:absolute;left:10px;top:200px;display:grid;width:100px;");
        auto under = make("grid-area:1 / 1;width:56px;height:56px;");
        auto over = make("grid-area:1 / 1;width:56px;height:56px;");
        ui_append_child(engine, stack, under);
        ui_append_child(engine, stack, over);
        ui_append_to_root(engine, stack);
        update();
        expectNear(offset(over, stack).x, 0, "stacked item column");
        expectNear(offset(over, stack).y, 0, "stacked item row");
        expectNear(raw(stack)->GetBox().GetSize().y, 56, "stacked items share one row");

        ui_set_style_property(engine, row, "grid-template-areas", "\"a b\" \"b a\"");
        bool refused = false;
        try {
            update();
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find("grid-template-areas") != std::string::npos;
        }
        check(refused, "non-rectangular areas refuse");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Grid areas failure: %s\n", error.what());
    return 1;
}
