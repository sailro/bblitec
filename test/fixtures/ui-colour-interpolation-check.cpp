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

Rml::Colourb background(Rml::Element* element) {
    const auto* property = element->GetProperty(Rml::PropertyId::BackgroundColor);
    check(property && property->unit == Rml::Unit::COLOUR, "background-color is a colour");
    return property->Get<Rml::Colourb>();
}

bool is(Rml::Colourb colour, int red, int green, int blue, int alpha) {
    return colour.red == red && colour.green == green && colour.blue == blue &&
           colour.alpha == alpha;
}
} // namespace

int main() try {
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Colour interpolation fixture", 320, 240, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "window");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        const char* transition = "transition:background-color 100ms linear;";
        const auto rule = [&](const char* name, const char* colour) {
            ui_add_class_style(
                engine, sheet, name,
                (std::string("background-color:") + colour + ";" + transition).c_str());
        };
        rule("clear", "transparent");
        rule("red", "#ff0000");
        rule("blue", "#0000ff");
        rule("fading", "rgba(0,0,255,0)");
        rule("half", "rgba(0,255,0,.5)");
        const auto make = [&](const char* class_name) {
            auto h = ui_create_element(engine, "div");
            ui_set_attribute(engine, h, "style", "position:absolute;width:10px;height:10px;");
            ui_set_attribute(engine, h, "class", class_name);
            ui_append_to_root(engine, h);
            return h;
        };
        const auto appear = make("clear");
        const auto hue = make("red");
        const auto fade = make("red");
        const auto mixed = make("half");

        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        const auto raw = [&](auto h) { return runtime.projected_elements.at(h.value).element; };
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 320, 240); };
        update();
        ui_set_attribute(engine, appear, "class", "red");
        ui_set_attribute(engine, hue, "class", "blue");
        ui_set_attribute(engine, fade, "class", "fading");
        ui_set_attribute(engine, mixed, "class", "red");
        update();
        fixture_time = 1050;
        update();
        // A browser's computed values half-way (CSS Color 4 §12.3, premultiplied sRGB).
        check(is(background(raw(appear)), 255, 0, 0, 128),
              "transparent to red is red at half opacity");
        check(is(background(raw(hue)), 128, 0, 128, 255), "red to blue mixes in sRGB");
        check(is(background(raw(fade)), 255, 0, 0, 128),
              "a colour fading out keeps its channels, not the transparent end's");
        // (0,255,0)*.5 and (255,0,0)*1 average to (127.5,63.75,0) at alpha .75.
        // The .5 alpha parses to byte 127 or 128.
        const auto weighed = background(raw(mixed));
        check(weighed.red == 170 && weighed.green == 85 && weighed.blue == 0 &&
                  (weighed.alpha == 191 || weighed.alpha == 192),
              "translucent ends weigh their channels by their alpha");
        fixture_time = 1101;
        update();
        check(is(background(raw(hue)), 0, 0, 255, 255), "the transition ends at its colour");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "Colour interpolation failure: %s\n", error.what());
    return 1;
}
