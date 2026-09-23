#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Grid column fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto make = [&](const char* tag, const char* style) {
            const auto element = ui_create_element(engine, tag);
            ui_set_attribute(engine, element, "style", style);
            return element;
        };
        const auto grid = make(
            "label",
            "position:absolute;left:10px;top:10px;width:200px;display:grid;grid-template-columns:1fr auto;gap:10px;");
        const auto title = make("span", "height:20px;");
        const auto output = make("output", "width:40px;height:20px;");
        const auto range = make("input", "width:100%;grid-column:1 / 3;margin:0;");
        ui_set_attribute(engine, range, "type", "range");
        const auto next = make("span", "height:20px;");
        for (const auto child : {title, output, range, next})
            ui_append_child(engine, grid, child);
        ui_append_to_root(engine, grid);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto element) {
            return runtime.projected_elements.at(element.value).element;
        };
        const auto expect_near = [](float a, float b) {
            if (std::abs(a - b) >= .1f)
                std::fprintf(stderr, "Grid size/offset: %.3f expected %.3f\n", a, b);
            assert(std::abs(a - b) < .1f);
        };
        auto* range_identity = raw(range);
        expect_near(raw(title)->GetBox().GetSize().x, 150);
        expect_near(raw(output)->GetAbsoluteOffset(Rml::BoxArea::Content).x, 170);
        expect_near(raw(range)->GetAbsoluteOffset(Rml::BoxArea::Content).x, 10);
        expect_near(raw(range)->GetAbsoluteOffset(Rml::BoxArea::Content).y, 40);
        expect_near(raw(range)->GetBox().GetSize().x, 200);
        expect_near(raw(next)->GetAbsoluteOffset(Rml::BoxArea::Content).y, 66);
        assert(raw(range)->GetParentNode() == raw(grid));
        ui_set_style_property(engine, grid, "width", "340px");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_near(raw(title)->GetBox().GetSize().x, 290);
        expect_near(raw(range)->GetBox().GetSize().x, 340);
        ui_set_style_property(engine, range, "grid-column", "2 / 3");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        // A single-track range contributes its 129px native max-content width
        // to the auto column; the preceding spanning range did not size it.
        expect_near(raw(range)->GetAbsoluteOffset(Rml::BoxArea::Content).x, 221);
        expect_near(raw(range)->GetBox().GetSize().x, 129);
        assert(raw(range) == range_identity && ui_element(engine, range).parent == grid);
    }
    {
        Engine engine;
        const auto make = [&](const char* tag, const char* style) {
            const auto element = ui_create_element(engine, tag);
            ui_set_attribute(engine, element, "style", style);
            return element;
        };
        const auto panel = make("div", "width:310px;");
        const auto details = make("details", "");
        ui_set_boolean_attribute(engine, details, "open", true);
        const auto summary = make("summary", "");
        ui_set_text(engine, summary, "General");
        ui_append_child(engine, details, summary);
        const auto row = make("label", "display:grid;grid-template-columns:1fr auto;gap:10px;");
        const auto title = make("span", "width:20px;height:20px;");
        const auto output = make("output", "width:40px;height:20px;");
        const auto range = make("input", "width:100%;grid-column:1 / 3;margin:0;");
        ui_set_attribute(engine, range, "type", "range");
        for (const auto child : {title, output, range})
            ui_append_child(engine, row, child);
        ui_append_child(engine, details, row);
        ui_append_child(engine, panel, details);
        ui_append_to_root(engine, panel);
        const auto intrinsic =
            make("label", "display:inline-grid;grid-template-columns:1fr auto;gap:10px;");
        const auto intrinsic_title = make("span", "width:20px;height:20px;");
        const auto intrinsic_output = make("output", "width:40px;height:20px;");
        const auto intrinsic_range = make("input", "width:100%;grid-column:1 / 3;margin:0;");
        ui_set_attribute(engine, intrinsic_range, "type", "range");
        for (const auto child : {intrinsic_title, intrinsic_output, intrinsic_range})
            ui_append_child(engine, intrinsic, child);
        ui_append_to_root(engine, intrinsic);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto raw = [&](auto element) {
            return runtime.projected_elements.at(element.value).element;
        };
        const auto expect_intrinsic = [](float actual, float expected) {
            if (std::abs(actual - expected) >= .1f)
                std::fprintf(stderr, "Intrinsic span: %.3f expected %.3f\n", actual, expected);
            assert(std::abs(actual - expected) < .1f);
        };
        expect_intrinsic(raw(row)->GetBox().GetSize().x, 310);
        expect_intrinsic(raw(range)->GetBox().GetSize().x, 310);
        expect_intrinsic(raw(intrinsic)->GetBox().GetSize().x, 129);
        expect_intrinsic(raw(intrinsic_range)->GetBox().GetSize().x, 129);
        expect_intrinsic(raw(intrinsic_output)->GetAbsoluteOffset(Rml::BoxArea::Content).x -
                             raw(intrinsic)->GetAbsoluteOffset(Rml::BoxArea::Content).x,
                         89);
        ui_set_style_property(engine, intrinsic, "grid-template-columns", "1fr 2fr");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_intrinsic(raw(intrinsic)->GetBox().GetSize().x, 129);
        expect_intrinsic(raw(intrinsic_output)->GetAbsoluteOffset(Rml::BoxArea::Content).x -
                             raw(intrinsic)->GetAbsoluteOffset(Rml::BoxArea::Content).x,
                         10 + 119.f / 3);
        ui_set_style_property(engine, intrinsic, "grid-template-columns", "40px 30px 1fr");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_intrinsic(raw(intrinsic)->GetBox().GetSize().x, 90);
        expect_intrinsic(raw(intrinsic_range)->GetBox().GetSize().x, 80);
        auto* range_identity = raw(range);
        ui_set_style_property(engine, panel, "width", "180px");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_intrinsic(raw(range)->GetBox().GetSize().x, 180);
        assert(raw(range) == range_identity && ui_element(engine, range).parent == row);
        ui_set_boolean_attribute(engine, details, "open", false);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        ui_set_boolean_attribute(engine, details, "open", true);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect_intrinsic(raw(range)->GetBox().GetSize().x, 180);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Grid layout failed: %s\n", error.what());
    return 1;
}
