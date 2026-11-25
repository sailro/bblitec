#include "pal_ui_rml.cpp"

namespace {
double fixture_time = 1000;
} // namespace

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return fixture_time; }
} // namespace bbl::pal

namespace {
using namespace bbl;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "%s\n", message);
        throw std::runtime_error(message);
    }
}

bool close_to(float value, float expected) { return std::abs(value - expected) < .05f; }

const Rml::BoxShadowList& shadows(Rml::Element* element) {
    const auto* property = element->GetProperty(Rml::PropertyId::BoxShadow);
    check(property && property->unit == Rml::Unit::BOXSHADOWLIST, "box-shadow is a shadow list");
    return property->value.GetReference<Rml::BoxShadowList>();
}
} // namespace

int main() try {
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Box shadow animation fixture", 320, 240, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "window");
    {
        Engine engine;
        const auto make = [&](const char* style, const char* class_name) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", style);
            ui_set_attribute(engine, h, "class", class_name);
            ui_append_to_root(engine, h);
            return h;
        };
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        const char* box = "position:absolute;left:20px;top:20px;width:40px;height:40px;";
        ui_add_class_style(
            engine, sheet, "ring",
            "box-shadow:inset 0 0 0 3px #9a5116;transition:box-shadow 100ms linear;");
        ui_add_class_style(
            engine, sheet, "wide",
            "box-shadow:inset 0 0 0 7px #9a5116;transition:box-shadow 100ms linear;");
        ui_add_class_style(engine, sheet, "bare", "transition:box-shadow 100ms linear;");
        ui_add_class_style(
            engine, sheet, "glow",
            "box-shadow:2px 4px 6px 8px #ff0000;transition:box-shadow 100ms linear;");
        ui_add_class_style(engine, sheet, "outer",
                           "box-shadow:0 0 0 4px #00ff00;transition:box-shadow 100ms linear;");
        ui_add_class_style(
            engine, sheet, "inner",
            "box-shadow:inset 0 0 0 8px #00ff00;transition:box-shadow 100ms linear;");
        ui_set_style_keyframes(engine, sheet,
                               "@keyframes pulse{0%,100%{box-shadow:inset 0 0 0 3px #9a5116}"
                               "50%{box-shadow:inset 0 0 0 7px #9a5116}}");
        ui_add_class_style(engine, sheet, "pulse", "animation:pulse 100ms linear 1;");
        const auto ring = make(box, "ring");
        const auto bare = make(box, "bare");
        const auto outer = make(box, "outer");
        const auto pulse = make(box, "ring");

        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 320, 240); };
        update();

        ui_set_attribute(engine, ring, "class", "wide");
        ui_set_attribute(engine, bare, "class", "glow");
        ui_set_attribute(engine, outer, "class", "inner");
        ui_set_attribute(engine, pulse, "class", "pulse");
        update();
        fixture_time = 1025;
        update();
        {
            const auto& list = shadows(raw(pulse));
            check(list.size() == 1 && list[0].inset && close_to(list[0].spread_distance.number, 5),
                  "a keyframe pulse is half-way to its 50% key at a quarter");
            const auto& before = shadows(raw(outer));
            check(before.size() == 1 && !before[0].inset,
                  "an outer shadow holds before the midpoint");
        }
        fixture_time = 1050;
        update();
        {
            const auto& list = shadows(raw(ring));
            check(list.size() == 1 && list[0].inset, "a transition keeps one inset shadow");
            check(close_to(list[0].spread_distance.number, 5), "the spread is half-way at 5px");
            check(list[0].color == Rml::Colourb(0x9a, 0x51, 0x16).ToPremultiplied(),
                  "an unchanged colour stays");
            const auto& glow = shadows(raw(bare));
            check(glow.size() == 1 && !glow[0].inset, "none pads to one outer shadow");
            check(close_to(glow[0].offset_x.number, 1) && close_to(glow[0].offset_y.number, 2) &&
                      close_to(glow[0].blur_radius.number, 3) &&
                      close_to(glow[0].spread_distance.number, 4),
                  "the padding shadow's zero lengths interpolate half-way");
            check(glow[0].color == Rml::Colourb(255, 0, 0, 128).ToPremultiplied(),
                  "the transparent padding shadow lends its alpha, not its channels");
            const auto& swapped = shadows(raw(outer));
            check(swapped.size() == 1 && swapped[0].inset &&
                      close_to(swapped[0].spread_distance.number, 8),
                  "an outer shadow and an inset swap at the midpoint");
            const auto& peak = shadows(raw(pulse));
            check(peak.size() == 1 && close_to(peak[0].spread_distance.number, 7),
                  "the pulse reaches its 50% key");
        }
        fixture_time = 1101;
        update();
        check(close_to(shadows(raw(ring))[0].spread_distance.number, 7),
              "the transition ends at 7px");
        check(close_to(shadows(raw(bare))[0].blur_radius.number, 6) &&
                  shadows(raw(bare))[0].color == Rml::Colourb(255, 0, 0).ToPremultiplied(),
              "the padded transition ends at its declared shadow");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Box shadow animation failure: %s\n", error.what());
    return 1;
}
