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

void check(bool ok, const std::string& what) {
    if (!ok)
        throw std::runtime_error(what);
}

bool within(float actual, float expected, float tolerance) {
    return std::abs(actual - expected) <= tolerance;
}

Rml::Mesh border_mesh(Rml::Element& element) {
    const auto& computed = element.GetComputedValues();
    const Rml::ColourbPremultiplied colors[] = {computed.border_top_color().ToPremultiplied(),
                                                computed.border_right_color().ToPremultiplied(),
                                                computed.border_bottom_color().ToPremultiplied(),
                                                computed.border_left_color().ToPremultiplied()};
    const Rml::Style::BorderStyle styles[] = {
        computed.border_top_style(), computed.border_right_style(), computed.border_bottom_style(),
        computed.border_left_style()};
    Rml::Mesh mesh;
    Rml::MeshUtilities::GenerateBackgroundBorder(mesh, element.GetRenderBox(Rml::BoxArea::Padding),
                                                 Rml::ColourbPremultiplied(0), colors, styles);
    return mesh;
}

// Whether any triangle of the mesh covers the point (positions are relative to the border box).
bool covered(const Rml::Mesh& mesh, Rml::Vector2f point) {
    const auto cross = [](Rml::Vector2f o, Rml::Vector2f u, Rml::Vector2f v) {
        return (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
    };
    for (std::size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        const auto a = mesh.vertices[mesh.indices[i]].position;
        const auto b = mesh.vertices[mesh.indices[i + 1]].position;
        const auto c = mesh.vertices[mesh.indices[i + 2]].position;
        // A zero-area triangle covers nothing, as a rasterizer draws it.
        if (std::abs(cross(a, b, c)) < 1e-4f)
            continue;
        const float d1 = cross(a, b, point), d2 = cross(b, c, point), d3 = cross(c, a, point);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)))
            return true;
    }
    return false;
}

// The covered runs [start, end] of a path `length` long, sampled every tenth of a pixel; a closed path's end is its start.
template <typename Point>
std::vector<std::pair<float, float>> runs(const Rml::Mesh& mesh, float length, Point point,
                                          bool closed = false) {
    std::vector<std::pair<float, float>> result;
    bool on = false;
    const int steps = static_cast<int>(length * 10);
    for (int i = 0; i < steps + (closed ? 0 : 1); i++) {
        const float s = length * static_cast<float>(i) / static_cast<float>(steps);
        const bool hit = covered(mesh, point(s));
        if (hit && !on)
            result.push_back({s, s});
        if (hit)
            result.back().second = s;
        on = hit;
    }
    return result;
}

void expect_widths(Rml::Element& element, float top, float right, float bottom, float left) {
    const auto& computed = element.GetComputedValues();
    if (computed.border_top_width() != top || computed.border_right_width() != right ||
        computed.border_bottom_width() != bottom || computed.border_left_width() != left)
        throw std::runtime_error("border widths " + std::to_string(computed.border_top_width()) +
                                 " " + std::to_string(computed.border_right_width()) + " " +
                                 std::to_string(computed.border_bottom_width()) + " " +
                                 std::to_string(computed.border_left_width()));
}

} // namespace

int run() {
    using namespace bbl;
    check(SDL_Init(SDL_INIT_VIDEO), "SDL_Init(SDL_INIT_VIDEO)");
    SDL_Window* window = SDL_CreateWindow("UI border style fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window, "window");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "widthless",
                           "width:20px;height:20px;border-width:4px;border-color:#ffffff;");
        ui_add_class_style(engine, sheet, "styled",
                           "width:20px;height:20px;border-style:solid;border-color:#ffffff;");
        ui_add_class_style(
            engine, sheet, "hidden-top",
            "width:20px;height:20px;border:2px solid #ffffff;border-top-style:hidden;");
        ui_add_class_style(engine, sheet, "square",
                           "width:96px;height:16px;border:2px dashed #ffffff;");
        ui_add_class_style(
            engine, sheet, "mixed",
            "width:96px;height:16px;border:2px solid #ffffff;border-top-style:dashed;");
        ui_add_class_style(engine, sheet, "ring",
                           "width:32px;height:32px;border:4px dashed #ffffff;border-radius:50%;");
        ui_add_class_style(engine, sheet, "outlined",
                           "width:20px;height:20px;--bbl-outline:2px dashed #ffffff;");
        ui_append_to_root(engine, sheet);
        const auto make = [&](const char* name, int top) {
            const auto element = ui_create_element(engine, "div");
            ui_set_attribute(engine, element, "class", name);
            ui_set_attribute(engine, element, "style",
                             "position:absolute;left:20px;top:" + std::to_string(top) + "px;");
            ui_append_to_root(engine, element);
            return element;
        };
        const auto widthless = make("widthless", 10);
        const auto styled = make("styled", 40);
        const auto hidden_top = make("hidden-top", 70);
        const auto square = make("square", 100);
        const auto mixed = make("mixed", 130);
        const auto ring = make("ring", 160);
        const auto outlined = make("outlined", 220);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto raw = [&](UiElementHandle handle) -> Rml::Element& {
            auto* element = runtime.projected_elements.at(handle.value).element;
            check(element, "element");
            return *element;
        };

        // A side without a drawn style has no width; a drawn one without a width is medium.
        expect_widths(raw(widthless), 0, 0, 0, 0);
        expect_widths(raw(styled), 3, 3, 3, 3);
        expect_widths(raw(hidden_top), 0, 2, 2, 2);

        // Square: each side dashes its whole outer edge from its top or left end, a dash at both ends. A 100px top at 2px
        // width fits ten 6px dashes; a 20px side picks the 1px gap closest to 4px: dashes at 0, 7 and 14.
        const auto square_mesh = border_mesh(raw(square));
        const auto top = runs(square_mesh, 100, [](float s) { return Rml::Vector2f(s, 1); });
        if (top.size() != 10 || !within(top.front().first, 0, .05f) ||
            !within(top.back().second, 100, .05f) || !within(top[1].first, 10.44f, .1f) ||
            !within(top[1].second - top[1].first, 6, .15f))
            throw std::runtime_error("square top runs " + std::to_string(top.size()));
        const auto left = runs(square_mesh, 20, [](float s) { return Rml::Vector2f(1, s); });
        if (left.size() != 3 || !within(left[1].first, 7, .1f) || !within(left[2].second, 20, .05f))
            throw std::runtime_error("square left runs " + std::to_string(left.size()));
        // Between dashes nothing is drawn, at the miter the corner square splits between its sides.
        check(
            !covered(square_mesh, {8, 1}) && covered(square_mesh, {1.5f, .5f}) &&
                covered(square_mesh, {.5f, 1.5f}),
            "!covered(square_mesh, {8, 1}) && covered(square_mesh, {1.5f, .5f}) && covered(square_mesh, {.5f, 1.5f})");

        // A solid side beside a dashed one fills its whole region.
        const auto mixed_mesh = border_mesh(raw(mixed));
        check(runs(mixed_mesh, 100, [](float s) { return Rml::Vector2f(s, 19); }).size() == 1,
              "runs(mixed_mesh, 100, [](float s) { return Rml::Vector2f(s, 19); }).size() == 1");
        check(runs(mixed_mesh, 100, [](float s) { return Rml::Vector2f(s, 1); }).size() == 10,
              "runs(mixed_mesh, 100, [](float s) { return Rml::Vector2f(s, 1); }).size() == 10");

        // Round: the 18px centerline circle (113px) is one closed path from the top, clockwise: nine 8px dashes.
        const auto ring_mesh = border_mesh(raw(ring));
        const float radius = 18, circumference = 2 * Rml::Math::RMLUI_PI * radius;
        const auto around = runs(
            ring_mesh, circumference,
            [&](float s) {
                const float a = -.5f * Rml::Math::RMLUI_PI + s / radius;
                return Rml::Vector2f(20 + radius * std::cos(a), 20 + radius * std::sin(a));
            },
            true);
        if (around.size() != 9 || !within(around.front().first, 0, .05f) ||
            !within(around.front().second, 8, .2f))
            throw std::runtime_error("ring runs " + std::to_string(around.size()));

        // A dashed outline draws its ring's border dashed.
        auto* ring_element = raw(outlined).QuerySelector("bbl-outline");
        check(ring_element, "ring_element");
        const auto& outline = ring_element->GetComputedValues();
        check(
            outline.border_top_style() == Rml::Style::BorderStyle::Dashed &&
                outline.border_top_width() == 2,
            "outline.border_top_style() == Rml::Style::BorderStyle::Dashed && outline.border_top_width() == 2");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "UI border style failure: %s\n", error.what());
        return 1;
    }
}
