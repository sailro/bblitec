#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

void expect_near(float actual, float expected) { assert(std::abs(actual - expected) < .001f); }

void expect_ellipse(Rml::Element& element, float width, float height, float border,
                    float percentage = 50) {
    const auto box = element.GetRenderBox(Rml::BoxArea::Padding);
    expect_near(box.GetFillSize().x, width - 2 * border);
    expect_near(box.GetFillSize().y, height - 2 * border);
    for (const auto radius : box.GetBorderRadius()) {
        expect_near(radius.x, width * percentage * .01f);
        expect_near(radius.y, height * percentage * .01f);
    }
    Rml::Mesh mesh;
    const Rml::ColourbPremultiplied colors[] = {
        Rml::ColourbPremultiplied(198, 239, 255, 255), Rml::ColourbPremultiplied(42, 48, 51, 51),
        Rml::ColourbPremultiplied(42, 48, 51, 51), Rml::ColourbPremultiplied(42, 48, 51, 51)};
    Rml::MeshUtilities::GenerateBackgroundBorder(mesh, box, Rml::ColourbPremultiplied(0), colors);
    assert(mesh.vertices.size() > 16 && !mesh.indices.empty());
    const Rml::Vector2f centre(width * .5f, height * .5f);
    for (const auto& vertex : mesh.vertices) {
        const auto delta = vertex.position - centre;
        const auto on_ellipse = [&](float inset) {
            const float x = delta.x / (centre.x - inset);
            const float y = delta.y / (centre.y - inset);
            return std::abs(x * x + y * y - 1.f) < .001f;
        };
        assert(on_ellipse(0) || on_ellipse(border));
    }
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI border radius fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "spinner",
                           "width:48px;height:48px;border:4px rgba(210,239,255,0.2);"
                           "border-top-color:#c6efff;border-radius:50%;");
        ui_add_class_style(engine, sheet, "outlined",
                           "--bbl-outline:2px solid #fff;--bbl-outline-offset:1px;");
        ui_append_to_root(engine, sheet);
        const auto spinner = ui_create_element(engine, "div");
        ui_set_attribute(engine, spinner, "style", "position:absolute;left:20px;top:20px;");
        ui_set_attribute(engine, spinner, "class", "spinner");
        ui_append_to_root(engine, spinner);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(spinner.value).element;
        assert(raw);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        expect_ellipse(*raw, 56, 56, 4);

        // Percentages use both border-box axes and follow later layout changes.
        ui_set_style_property(engine, spinner, "width", "96px");
        update();
        expect_ellipse(*raw, 104, 56, 4);
        ui_set_style_property(engine, spinner, "box-sizing", "border-box");
        update();
        expect_ellipse(*raw, 96, 48, 4);
        ui_set_style_property(engine, spinner, "border-radius", "75%");
        update();
        expect_ellipse(*raw, 96, 48, 4, 75);

        // Absolute radii keep fractional precision; each shorthand corner resolves independently.
        ui_set_style_property(engine, spinner, "border-radius", "12.5px 25% 10% 0");
        update();
        const auto corners = raw->GetRenderBox(Rml::BoxArea::Border).GetBorderRadius();
        expect_near(corners[0].x, 12.5f);
        expect_near(corners[0].y, 12.5f);
        expect_near(corners[1].x, 24);
        expect_near(corners[1].y, 12);
        expect_near(corners[2].x, 9.6f);
        expect_near(corners[2].y, 4.8f);
        assert(corners[3] == Rml::Vector2f(0));

        ui_set_style_property(engine, spinner, "border-radius", "50%");
        ui_set_attribute(engine, spinner, "class", "spinner outlined");
        update();
        auto* outline = raw->QuerySelector("bbl-outline");
        assert(outline);
        const auto outline_radii = outline->GetRenderBox(Rml::BoxArea::Border).GetBorderRadius();
        for (const auto radius : outline_radii) {
            expect_near(radius.x, 51);
            expect_near(radius.y, 27);
        }
        ui_set_attribute(engine, spinner, "class", "spinner");
        ui_set_style_property(engine, spinner, "box-shadow", "0 0 0 3px #fff");
        update();
        const auto& shadow_frame = pal::record_ui_rml_frame(runtime, 640, 480);
        assert(!shadow_frame.draws.empty() && !shadow_frame.textures.empty());
        const auto& shadow = shadow_frame.textures.front();
        assert(shadow.width == 102 && shadow.height == 54 && shadow.rgba);
        assert(shadow.rgba->at(3) == 0);
        assert(shadow.rgba->at((shadow.width + shadow.width / 2) * 4 + 3) == 255);
        ui_set_style_property(engine, spinner, "width", "120px");
        update();
        expect_ellipse(*raw, 120, 48, 4);
        assert(!pal::record_ui_rml_frame(runtime, 640, 480).textures.empty());
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
