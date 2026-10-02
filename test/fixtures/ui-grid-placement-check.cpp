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
} // namespace

int main() try {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Grid placement fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto make = [&](const char* style) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            return h;
        };
        auto grid = make(
            "position:absolute;left:10px;top:10px;display:grid;width:200px;height:130px;grid-template-columns:40px 50px 60px;grid-template-rows:20px 30px 40px;gap:10px;align-content:start;justify-content:start;");
        auto first = make("background-color:red;pointer-events:auto;");
        auto span = make("grid-column:span 2;background-color:green;pointer-events:auto;");
        auto next = make("background-color:blue;pointer-events:auto;");
        auto reserved =
            make("grid-column:2;grid-row:1 / span 2;background-color:orange;pointer-events:auto;");
        for (auto h : {first, span, next, reserved})
            ui_append_child(engine, grid, h);
        ui_append_to_root(engine, grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto offset = [&](auto h) {
            return raw(h)->GetAbsoluteOffset(Rml::BoxArea::Content) -
                   raw(grid)->GetAbsoluteOffset(Rml::BoxArea::Content);
        };
        auto* identity = raw(span);
        expectNear(offset(first).x, 0, "auto placement reserves later authored areas");
        expectNear(offset(span).y, 70, "sparse spanning placement skips occupied rows");
        expectNear(raw(span)->GetBox().GetSize().x, 100, "column span includes its gutter");
        expectNear(offset(next).x, 110, "auto cursor follows column span");
        expectNear(offset(next).y, 70, "auto cursor follows row placement");
        expectNear(raw(reserved)->GetBox().GetSize().y, 60, "row span includes its gutter");
        assert(runtime.context->GetElementAtPoint({65, 45}) == raw(reserved));
        ui_set_style_property(engine, span, "grid-column", "1");
        ui_set_style_property(engine, span, "grid-row", "2");
        update();
        expectNear(offset(span).y, 30, "live definite row");
        expectNear(offset(next).x, 110, "live auto item moves into freed row");
        expectNear(offset(next).y, 0, "placement recomputes occupancy");
        assert(raw(span) == identity && raw(span)->GetParentNode() == raw(grid));
        ui_set_style_property(engine, span, "grid-column", "-2 / -1");
        ui_set_style_property(engine, span, "grid-row", "-2 / -1");
        update();
        expectNear(offset(span).x, 110, "negative explicit column lines");
        expectNear(offset(span).y, 70, "negative explicit row lines");
        ui_set_style_property(engine, grid, "grid-template-columns", "30px 40px 50px 60px");
        ui_set_style_property(engine, grid, "grid-template-rows", "10px 20px 30px 40px");
        update();
        expectNear(offset(span).x, 150, "negative column follows changed explicit grid");
        expectNear(offset(span).y, 90, "negative row follows changed explicit grid");
        ui_remove_style_property(engine, span, "grid-column");
        ui_remove_style_property(engine, span, "grid-row");
        ui_set_style_property(engine, first, "display", "none");
        update();
        expectNear(offset(span).x, 0, "removed placement and hidden predecessor");
        expectNear(offset(span).y, 0, "hidden item releases its occupied area");
        assert(raw(span) == identity && runtime.context->GetElementAtPoint({12, 12}) == identity);
    }
    {
        Engine engine;
        auto grid = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, grid, "style",
            "display:grid;width:210px;grid-template-columns:40px 50px;grid-template-rows:20px;grid-auto-columns:10px 20px;grid-auto-rows:11px 22px;gap:5px;justify-content:start;align-content:start;");
        auto leading = ui_create_element(engine, "div"),
             explicit_item = ui_create_element(engine, "div"),
             trailing = ui_create_element(engine, "div");
        ui_set_attribute(engine, leading, "style", "grid-column:-5;grid-row:-3;");
        ui_set_attribute(engine, explicit_item, "style", "grid-column:1;grid-row:1;");
        ui_set_attribute(engine, trailing, "style", "grid-column:4;grid-row:3;");
        for (auto h : {leading, explicit_item, trailing})
            ui_append_child(engine, grid, h);
        ui_append_to_root(engine, grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto offset = [&](auto h) {
            return raw(h)->GetAbsoluteOffset(Rml::BoxArea::Content) -
                   raw(grid)->GetAbsoluteOffset(Rml::BoxArea::Content);
        };
        expectNear(raw(leading)->GetBox().GetSize().x, 10, "leading implicit column pattern");
        expectNear(raw(leading)->GetBox().GetSize().y, 22,
                   "leading implicit row pattern runs backwards");
        expectNear(offset(explicit_item).x, 40, "explicit origin follows prepended columns");
        expectNear(offset(explicit_item).y, 27, "explicit origin follows prepended rows");
        expectNear(offset(trailing).x, 155, "trailing implicit column pattern");
        expectNear(offset(trailing).y, 68, "trailing implicit row pattern");
    }
    {
        Engine engine;
        auto grid = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, grid, "style",
            "display:grid;width:250px;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:10px;");
        auto first = ui_create_element(engine, "div"), second = ui_create_element(engine, "div");
        for (auto h : {first, second}) {
            ui_set_style_property(engine, h, "height", "10px");
            ui_append_child(engine, grid, h);
        }
        ui_append_to_root(engine, grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        expectNear(raw(first)->GetBox().GetSize().x, 120,
                   "auto-fit collapses unused track and gutters");
        ui_set_style_property(engine, grid, "width", "330px");
        ui_set_style_property(engine, second, "grid-column", "3");
        update();
        expectNear(raw(first)->GetBox().GetSize().x, 160,
                   "auto-fit recomputes count and collapses interior holes");
        expectNear(raw(second)->GetAbsoluteOffset().x - raw(first)->GetAbsoluteOffset().x, 170,
                   "collapsed interior gutters coalesce");
        ui_set_style_property(engine, grid, "grid-template-columns",
                              "repeat(auto-fill,minmax(70px,1fr))");
        update();
        expectNear(raw(first)->GetBox().GetSize().x, 75, "auto-fill retains empty tracks");
        expectNear(raw(second)->GetAbsoluteOffset().x - raw(first)->GetAbsoluteOffset().x, 170,
                   "auto-fill keeps explicit line identity");
        ui_set_style_property(engine, grid, "grid-template-columns",
                              "minmax(40px,100px) minmax(30px,auto) 1fr");
        ui_set_style_property(engine, second, "grid-column", "2");
        ui_set_style_property(engine, second, "width", "80px");
        ui_set_style_property(engine, grid, "width", "300px");
        update();
        expectNear(raw(first)->GetBox().GetSize().x, 100,
                   "finite maximum grows before flexible tracks");
        expectNear(raw(second)->GetAbsoluteOffset().x - raw(first)->GetAbsoluteOffset().x, 110,
                   "intrinsic maximum follows finite track");
        ui_set_style_property(engine, grid, "display", "inline-grid");
        ui_remove_style_property(engine, grid, "width");
        ui_set_style_property(engine, grid, "grid-template-columns", "auto auto");
        ui_set_style_property(engine, first, "grid-column", "span 2");
        ui_set_style_property(engine, first, "min-width", "100px");
        ui_set_style_property(engine, second, "display", "none");
        update();
        expectNear(raw(grid)->GetBox().GetSize().x, 100,
                   "intrinsic column span grows both auto tracks");
        ui_set_style_property(engine, first, "min-width", "200px");
        ui_set_style_property(engine, grid, "grid-template-columns", "minmax(auto,50px) auto");
        update();
        expectNear(raw(grid)->GetBox().GetSize().x, 200,
                   "intrinsic growth respects a finite maximum before redistributing");
        ui_set_style_property(engine, second, "display", "block");
        ui_set_style_property(engine, second, "width", "0px");
        ui_set_style_property(engine, second, "grid-column", "2");
        update();
        expectNear(raw(second)->GetAbsoluteOffset().x - raw(first)->GetAbsoluteOffset().x, 60,
                   "spanning minimum freezes the capped track");
        ui_set_style_property(engine, grid, "grid-template-columns",
                              "minmax(auto,50px) minmax(auto,50px)");
        update();
        expectNear(raw(grid)->GetBox().GetSize().x, 200,
                   "required minimum can exceed all finite growth limits");
        expectNear(raw(second)->GetAbsoluteOffset().x - raw(first)->GetAbsoluteOffset().x, 105,
                   "required minimum distributes beyond both caps");
        ui_set_style_property(engine, second, "display", "none");
        ui_set_style_property(engine, first, "grid-column", "1");
        ui_set_style_property(engine, first, "grid-row", "1 / 3");
        ui_remove_style_property(engine, first, "height");
        ui_set_style_property(engine, first, "min-height", "90px");
        ui_set_style_property(engine, grid, "grid-template-columns", "40px");
        ui_set_style_property(engine, grid, "grid-template-rows", "auto auto");
        update();
        expectNear(raw(grid)->GetBox().GetSize().y, 90,
                   "intrinsic row span grows both auto tracks");
        expectNear(raw(first)->GetBox().GetSize().y, 90,
                   "spanning item receives complete block cell");
    }
    {
        Engine engine;
        auto grid = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, grid, "style",
            "display:grid;width:40px;height:250px;grid-template-columns:40px;grid-template-rows:repeat(auto-fit,minmax(70px,1fr));gap:10px;");
        auto first = ui_create_element(engine, "div"), second = ui_create_element(engine, "div");
        ui_append_child(engine, grid, first);
        ui_append_child(engine, grid, second);
        ui_append_to_root(engine, grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        expectNear(raw(first)->GetBox().GetSize().y, 120, "block-axis auto-fit sizing");
        ui_set_style_property(engine, grid, "height", "330px");
        ui_set_style_property(engine, second, "grid-row", "3");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expectNear(raw(first)->GetBox().GetSize().y, 160, "block-axis collapsed track sizing");
        expectNear(raw(second)->GetAbsoluteOffset().y - raw(first)->GetAbsoluteOffset().y, 170,
                   "block-axis collapsed gutters");
        ui_set_style_property(engine, grid, "grid-template-rows", "none");
        ui_set_style_property(engine, grid, "grid-template-columns", "0px repeat(auto-fill,70px)");
        ui_set_style_property(engine, grid, "width", "320px");
        ui_set_style_property(engine, second, "grid-row", "auto");
        ui_set_style_property(engine, second, "grid-column", "-2 / -1");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expectNear(raw(second)->GetAbsoluteOffset().x - raw(first)->GetAbsoluteOffset().x, 250,
                   "zero fixed tracks outside auto-repeat preserve exact fitting count");
    }
    {
        Engine engine;
        auto grid = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, grid, "style",
            "display:grid;width:200px;grid-template-columns:20px 20px 20px;grid-template-rows:20px 20px;grid-auto-columns:20px;gap:10px;justify-content:start;");
        std::vector<UiElementHandle> items;
        for (const char* style : {"grid-column:2;grid-row:2;", "grid-column:span 2;grid-row:2;",
                                  "grid-row:1 / span 2;", "grid-row:2;"}) {
            auto item = ui_create_element(engine, "div");
            ui_set_attribute(engine, item, "style", style);
            ui_append_child(engine, grid, item);
            items.push_back(item);
        }
        ui_append_to_root(engine, grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        expectNear(raw(items[1])->GetAbsoluteOffset().x - raw(grid)->GetAbsoluteOffset().x, 60,
                   "row-locked span avoids definite cells");
        expectNear(raw(items[2])->GetAbsoluteOffset().x - raw(grid)->GetAbsoluteOffset().x, 0,
                   "row-spanning locked item fills an earlier free cell");
        expectNear(raw(items[3])->GetAbsoluteOffset().x - raw(grid)->GetAbsoluteOffset().x, 120,
                   "sparse locked-row cursor never retreats");
    }
    for (const auto* style :
         {"grid-template-columns:subgrid;", "grid-template-columns:repeat(auto-fit,1fr);",
          "grid-template-columns:repeat(auto-fit,0px);width:300px;"}) {
        bool refused = false;
        try {
            Engine engine;
            auto grid = ui_create_element(engine, "div");
            ui_set_attribute(engine, grid, "style", std::string("display:grid;") + style);
            ui_append_to_root(engine, grid);
            pal::UiRmlRuntime runtime(engine, window, 640, 480);
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find("UI grid tracks") != std::string::npos;
        }
        assert(refused);
    }
    for (const auto* placement : {"0", "+-1", "span 257", "header", "1 / 2 / 3"}) {
        bool refused = false;
        try {
            Engine engine;
            auto grid = ui_create_element(engine, "div"), item = ui_create_element(engine, "div");
            ui_set_style_property(engine, grid, "display", "grid");
            ui_set_style_property(engine, item, "grid-row", placement);
            ui_append_child(engine, grid, item);
            ui_append_to_root(engine, grid);
            pal::UiRmlRuntime runtime(engine, window, 640, 480);
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).find("UI grid placement") != std::string::npos;
        }
        assert(refused);
    }
    {
        Engine engine;
        const auto make = [&](const char* style) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            return h;
        };
        auto group = make(
            "position:absolute;left:20px;top:20px;width:100px;height:100px;isolation:isolate;");
        auto raised = make(
            "position:absolute;left:0;top:0;width:100px;height:100px;z-index:10;pointer-events:auto;background-color:red;");
        auto cover = make(
            "position:absolute;left:20px;top:20px;width:100px;height:100px;z-index:1;pointer-events:auto;background-color:blue;");
        ui_append_child(engine, group, raised);
        ui_append_to_root(engine, group);
        ui_append_to_root(engine, cover);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        auto* identity = raw(raised);
        assert(runtime.context->GetElementAtPoint({40, 40}) == raw(cover));
        ui_set_style_property(engine, group, "isolation", "auto");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.context->GetElementAtPoint({40, 40}) == identity);
        ui_set_style_property(engine, group, "isolation", "isolate");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.context->GetElementAtPoint({40, 40}) == raw(cover));
        ui_remove_style_property(engine, group, "isolation");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.context->GetElementAtPoint({40, 40}) == identity && raw(raised) == identity);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Grid placement failed: %s\n", error.what());
    return 1;
}
