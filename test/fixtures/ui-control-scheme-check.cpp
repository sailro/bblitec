#include "pal_ui_rml.cpp"
#include <cassert>
#include <cstdio>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {
using bbl::pal::UiRgba;

bool same(UiRgba actual, UiRgba expected) { return actual == expected; }

bool same(Rml::Colourb actual, UiRgba expected) {
    return actual.red == expected.r && actual.green == expected.g && actual.blue == expected.b &&
           actual.alpha == expected.a;
}

void require(bool condition, const char* what) {
    if (!condition)
        throw std::runtime_error(what);
}
} // namespace

int main() try {
    using namespace bbl;
    using namespace bbl::pal;
    // Accent derivation, measured in Chromium 152: the palette selection and
    // the hover/press lightness moves.
    const UiControlColors dark_accent{&ui_dark_control_palette, UiRgba{88, 198, 255}};
    require(same(dark_accent.accent_color(UiControlState::Normal), {88, 198, 255}), "accent");
    require(same(dark_accent.accent_color(UiControlState::Hovered), {144, 217, 255}),
            "dark hovered accent");
    require(same(dark_accent.accent_color(UiControlState::Pressed), {32, 179, 255}),
            "dark pressed accent");
    require(same(dark_accent.accent_color(UiControlState::Disabled), {117, 117, 117}),
            "disabled accent");
    const UiControlColors light_accent{&ui_light_control_palette, UiRgba{160, 80, 80}};
    require(same(light_accent.accent_color(UiControlState::Hovered), {123, 61, 61}),
            "light hovered accent");
    require(same(light_accent.accent_color(UiControlState::Pressed), {184, 112, 112}),
            "light pressed accent");
    require(same(UiControlColors{&ui_dark_control_palette, UiRgba{240, 240, 240}}.accent_color(
                     UiControlState::Hovered),
                 {255, 255, 255}),
            "clamped lightness");
    require(&ui_accent_palette({138, 138, 138}, false) == &ui_light_control_palette,
            "3:1 against the light fill keeps the light palette");
    require(&ui_accent_palette({139, 139, 139}, false) == &ui_dark_control_palette,
            "under 3:1 against the light fill selects the dark palette");
    require(&ui_accent_palette({132, 132, 132}, true) == &ui_light_control_palette,
            "under 3:1 against the dark fill selects the light palette");
    require(&ui_accent_palette({133, 133, 133}, true) == &ui_dark_control_palette,
            "3:1 against the dark fill keeps the dark palette");
    require(&ui_accent_palette({88, 198, 255}, false) == &ui_dark_control_palette,
            "a light accent darkens a light page's control");

    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Control scheme fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto dark = ui_create_element(engine, "div");
        ui_set_attribute(engine, dark, "style", "color-scheme:dark;");
        ui_append_to_root(engine, dark);
        const auto add =
            [&](UiElementHandle parent, std::string_view tag,
                std::initializer_list<std::pair<const char*, const char*>> attributes) {
                const auto handle = ui_create_element(engine, tag);
                for (const auto& [name, value] : attributes)
                    ui_set_attribute(engine, handle, name, value);
                ui_append_child(engine, parent, handle);
                return handle;
            };
        const auto select = add(dark, "select", {});
        const auto option = add(select, "option", {{"value", "low"}});
        ui_set_text(engine, option, "Lower memory");
        const auto checkbox = add(dark, "input", {{"type", "checkbox"}, {"checked", ""}});
        const auto accent_checkbox =
            add(dark, "input",
                {{"type", "checkbox"}, {"checked", ""}, {"style", "accent-color:#202020"}});
        const auto range_style = "display:block;width:200px;height:16px;margin:0;";
        const auto dark_range =
            add(dark, "input", {{"type", "range"}, {"value", "25"}, {"style", range_style}});
        const auto light = ui_create_element(engine, "div");
        ui_append_to_root(engine, light);
        const auto light_select = add(light, "select", {});
        const auto light_option = add(light_select, "option", {{"value", "low"}});
        ui_set_text(engine, light_option, "Lower memory");
        // The accent and light ranges are read back by their raster widths.
        add(light, "input",
            {{"type", "range"},
             {"value", "25"},
             {"style", "display:block;width:201px;height:16px;margin:0;"
                       "accent-color:#58c6ff;"}});
        add(light, "input",
            {{"type", "range"},
             {"value", "25"},
             {"style", "display:block;width:202px;height:16px;margin:0;"}});
        const auto link = add(light, "a", {{"href", "#credit"}, {"class", "credit"}});
        ui_set_text(engine, link, "credit");
        ui_add_host_style_rule(engine, UiStyleSelectorKind::Class, "credit", "", "", false, -1,
                               "color:#eaf1f5;text-decoration:none;");

        UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { update_ui_rml_runtime(runtime, 640, 480); };
        const auto element = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        update();
        static_cast<void>(record_ui_rml_frame(runtime, 640, 480));

        // The dark user-agent rules follow their light rules at equal specificity.
        const auto& select_style = element(select)->GetComputedValues();
        require(same(select_style.background_color(), {59, 59, 59}), "dark select background");
        require(same(select_style.border_top_color(), {133, 133, 133}), "dark select border");
        require(same(select_style.color(), {255, 255, 255}), "dark select text");
        require(
            same(element(light_select)->GetComputedValues().background_color(), {255, 255, 255}),
            "light select background");
        require(same(element(checkbox)->GetComputedValues().background_color(), {153, 200, 255}),
                "dark checked checkbox");
        require(
            same(element(accent_checkbox)->GetComputedValues().background_color(), {32, 32, 32}),
            "accent checkbox");
        const auto& props = runtime.control_scheme_properties;
        require(same(ui_control_colors(*element(checkbox), props, false).palette->checkmark,
                     {59, 59, 59}),
                "dark checkmark");
        require(same(ui_control_colors(*element(accent_checkbox), props, false).palette->checkmark,
                     {255, 255, 255}),
                "a dark accent selects the light checkmark");
        // An author class rule outranks the user-agent link color.
        const auto& link_style = element(link)->GetComputedValues();
        require(same(link_style.color(), {234, 241, 245}), "author link color");
        require(link_style.text_decoration() == Rml::Style::TextDecoration::None,
                "author link decoration");
        // Chromium's select: the font's normal line height, 1px internal padding
        // above and below, its border, and no CSS line-height.
        const auto face = element(select)->GetFontFaceHandle();
        const float line = Rml::GetFontEngineInterface()->GetFontMetrics(face).line_spacing;
        require(element(select)->GetBox().GetSize(Rml::BoxArea::Border).y == line + 4.f,
                "select intrinsic height");

        const auto pixel = [&](std::uint32_t width, int x, int y) {
            for (const auto& texture : runtime.render_interface.frame.textures)
                if (texture.width == width && texture.height == 16 && texture.rgba) {
                    const auto index = (static_cast<std::size_t>(y) * width + x) * 4;
                    const auto& rgba = *texture.rgba;
                    return UiRgba{rgba[index], rgba[index + 1], rgba[index + 2], rgba[index + 3]};
                }
            throw std::runtime_error("Missing native range raster");
        };
        // Track fill, opaque border and value fill of the dark palette.
        require(same(pixel(200, 150, 8), {59, 59, 59}), "dark range fill");
        require(same(pixel(200, 150, 4), {133, 133, 133}), "dark range border");
        require(same(pixel(200, 10, 8), {153, 200, 255}), "dark range value");
        // A light accent on a light page selects the dark track.
        require(same(pixel(201, 150, 8), {59, 59, 59}), "accent range fill");
        require(same(pixel(201, 10, 8), {88, 198, 255}), "accent range value");
        // The light border is drawn at alpha 0x80 over the fill.
        require(same(pixel(202, 150, 8), {239, 239, 239}), "light range fill");
        require(same(pixel(202, 150, 4), {178, 178, 178}), "light range border");

        // A preference-dependent list and a translucent accent refuse.
        bool refused = false;
        ui_set_style_property(engine, dark_range, "color-scheme", "light dark");
        try {
            update();
        } catch (const std::runtime_error& error) {
            refused = std::string_view(error.what()).find("color-scheme") != std::string_view::npos;
        }
        require(refused, "a scheme list refuses");
        static_cast<void>(ui_remove_style_property(engine, dark_range, "color-scheme"));
        update();
        refused = false;
        ui_set_style_property(engine, dark_range, "accent-color", "rgba(88,198,255,0.5)");
        try {
            update();
        } catch (const std::runtime_error& error) {
            refused = std::string_view(error.what()).find("translucent accent-color") !=
                      std::string_view::npos;
        }
        require(refused, "a translucent accent refuses");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Control scheme: %s\n", error.what());
    return 1;
}
