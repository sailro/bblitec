#pragma once
// Browser form-control palettes per color-scheme and accent-color, adapted from
// Chromium 152.0.7977.76 (ui/native_theme/native_theme_base.cc,
// ui/color/color_provider_utils.cc) and measured in that capture browser for
// every state below. BSD-3-Clause notice: native/notices/Chromium.txt.
#include <RmlUi/Core/Colour.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementText.h>
#include <RmlUi/Core/Property.h>
#include <RmlUi/Core/PropertyDefinition.h>
#include <RmlUi/Core/StyleSheetSpecification.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

namespace bbl::pal {

struct UiControlSchemeProperties {
    Rml::PropertyId scheme, accent;
};

inline UiControlSchemeProperties register_ui_control_scheme_properties() {
    // Both inherit as in CSS, through RmlUi's cascade, innerHTML nodes included.
    // A preference-dependent scheme list has no native preference to follow.
    const auto scheme =
        Rml::StyleSheetSpecification::RegisterProperty("color-scheme", "normal", true)
            .AddParser("keyword", "normal, light, dark")
            .GetId();
    const auto accent = Rml::StyleSheetSpecification::RegisterProperty("accent-color", "auto", true)
                            .AddParser("keyword", "auto")
                            .AddParser("color")
                            .GetId();
    return {scheme, accent};
}

struct UiRgba {
    std::uint8_t r = 0, g = 0, b = 0, a = 255;
    friend bool operator==(const UiRgba&, const UiRgba&) = default;
};

enum class UiControlState : std::uint8_t { Normal, Hovered, Pressed, Disabled };

/** One scheme's control colors, indexed by UiControlState. */
struct UiControlPalette {
    std::array<UiRgba, 4> accent, fill, border;
    UiRgba checkmark;
};

// The light border is drawn at alpha 0x80 unless the control is disabled.
inline constexpr UiControlPalette ui_light_control_palette{
    {{{0, 117, 255, 255}, {0, 92, 200, 255}, {55, 147, 255, 255}, {203, 203, 203, 255}}},
    {{{239, 239, 239, 255}, {229, 229, 229, 255}, {245, 245, 245, 255}, {239, 239, 239, 77}}},
    {{{118, 118, 118, 128}, {79, 79, 79, 128}, {141, 141, 141, 128}, {118, 118, 118, 77}}},
    {255, 255, 255, 255},
};

inline constexpr UiControlPalette ui_dark_control_palette{
    {{{153, 200, 255, 255}, {209, 230, 255, 255}, {97, 169, 255, 255}, {117, 117, 117, 255}}},
    {{{59, 59, 59, 255}, {59, 59, 59, 255}, {59, 59, 59, 255}, {54, 54, 54, 255}}},
    {{{133, 133, 133, 255}, {172, 172, 172, 255}, {110, 110, 110, 255}, {98, 98, 98, 255}}},
    {59, 59, 59, 255},
};

inline double ui_relative_luminance(UiRgba color) {
    const auto linear = [](std::uint8_t channel) {
        const double value = channel / 255.0;
        return value <= 0.04045 ? value / 12.92 : std::pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

inline double ui_contrast_ratio(UiRgba first, UiRgba second) {
    const double a = ui_relative_luminance(first), b = ui_relative_luminance(second);
    return (std::max(a, b) + 0.05) / (std::min(a, b) + 0.05);
}

/**
 * Chromium keeps an accent visible against its control: an accent under 3:1
 * contrast with the light palette's fill selects the dark palette, and one
 * under 3:1 with the dark fill the light palette; otherwise the scheme's own.
 */
inline const UiControlPalette& ui_accent_palette(UiRgba accent, bool dark) {
    constexpr double minimum_visible_contrast = 3.0;
    if (ui_contrast_ratio(accent, ui_light_control_palette.fill[0]) < minimum_visible_contrast)
        return ui_dark_control_palette;
    if (ui_contrast_ratio(accent, ui_dark_control_palette.fill[0]) < minimum_visible_contrast)
        return ui_light_control_palette;
    return dark ? ui_dark_control_palette : ui_light_control_palette;
}

/** The color with its HSL lightness moved by `delta`, hue and saturation kept. */
inline UiRgba ui_shift_lightness(UiRgba color, double delta) {
    const double r = color.r / 255.0, g = color.g / 255.0, b = color.b / 255.0;
    const double maximum = std::max({r, g, b}), minimum = std::min({r, g, b});
    double hue = 0, saturation = 0, lightness = (maximum + minimum) / 2;
    if (maximum != minimum) {
        const double range = maximum - minimum;
        saturation =
            lightness > 0.5 ? range / (2 - maximum - minimum) : range / (maximum + minimum);
        hue = maximum == r   ? (g - b) / range + (g < b ? 6 : 0)
              : maximum == g ? (b - r) / range + 2
                             : (r - g) / range + 4;
        hue /= 6;
    }
    lightness = std::clamp(lightness + delta, 0.0, 1.0);
    const auto channel = [](double value) {
        return static_cast<std::uint8_t>(std::lround(std::clamp(value, 0.0, 1.0) * 255));
    };
    if (saturation == 0)
        return {channel(lightness), channel(lightness), channel(lightness), 255};
    const double q = lightness < 0.5 ? lightness * (1 + saturation)
                                     : lightness + saturation - lightness * saturation;
    const double p = 2 * lightness - q;
    const auto component = [p, q](double t) {
        t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
        if (t < 1.0 / 6)
            return p + (q - p) * 6 * t;
        if (t < 0.5)
            return q;
        if (t < 2.0 / 3)
            return p + (q - p) * (2.0 / 3 - t) * 6;
        return p;
    };
    return {channel(component(hue + 1.0 / 3)), channel(component(hue)),
            channel(component(hue - 1.0 / 3)), 255};
}

/** An element's control colors: its scheme's palette, adjusted for an accent. */
struct UiControlColors {
    const UiControlPalette* palette = &ui_light_control_palette;
    std::optional<UiRgba> accent;

    /**
     * A disabled control ignores the accent. Otherwise hovering moves an
     * accent's HSL lightness 0.11 away from the palette's fill (darker in the
     * light palette, lighter in the dark one) and pressing moves it back.
     */
    UiRgba accent_color(UiControlState state) const {
        if (!accent || state == UiControlState::Disabled)
            return palette->accent[static_cast<std::size_t>(state)];
        if (state == UiControlState::Normal)
            return *accent;
        const bool darker =
            (state == UiControlState::Hovered) == (palette == &ui_light_control_palette);
        return ui_shift_lightness(*accent, darker ? -0.11 : 0.11);
    }
};

inline bool ui_dark_color_scheme(Rml::Element& element,
                                 const UiControlSchemeProperties& properties) {
    const auto* scheme = element.GetProperty(properties.scheme);
    return scheme && scheme->Get<int>() == 2;
}

/** The authored accent-color, absent for auto; a translucent one refuses. */
inline std::optional<UiRgba> ui_accent_color(Rml::Element& element,
                                             const UiControlSchemeProperties& properties) {
    const auto* accent = element.GetProperty(properties.accent);
    if (!accent || accent->unit != Rml::Unit::COLOUR)
        return std::nullopt;
    const auto colour = accent->Get<Rml::Colourb>();
    if (colour.alpha != 255)
        throw std::runtime_error("A translucent accent-color is not represented by the native "
                                 "control palette.");
    return UiRgba{colour.red, colour.green, colour.blue, 255};
}

inline UiControlColors ui_control_colors(Rml::Element& element,
                                         const UiControlSchemeProperties& properties,
                                         bool disabled) {
    const bool dark = ui_dark_color_scheme(element, properties);
    const auto accent = disabled ? std::nullopt : ui_accent_color(element, properties);
    if (!accent)
        return {dark ? &ui_dark_control_palette : &ui_light_control_palette, std::nullopt};
    return {&ui_accent_palette(*accent, dark), accent};
}

/**
 * Exposes each element's scheme and enabled accent to the user-agent sheet:
 * `:bbl-dark-scheme` and `:bbl-accent` with `--bbl-accent`, so author rules
 * keep their precedence over the control defaults.
 */
inline bool sync_ui_control_schemes(Rml::Element& document,
                                    const UiControlSchemeProperties& properties) {
    static const Rml::String dark_name = "bbl-dark-scheme", accent_name = "bbl-accent",
                             accent_variable = "--bbl-accent";
    bool changed = false;
    const auto pseudo = [&](Rml::Element& element, const Rml::String& name, bool active) {
        if (element.IsPseudoClassSet(name) != active) {
            element.SetPseudoClass(name, active);
            changed = true;
        }
    };
    const auto visit = [&](const auto& self, Rml::Element& element) -> void {
        pseudo(element, dark_name, ui_dark_color_scheme(element, properties));
        const auto accent = element.IsPseudoClassSet("disabled")
                                ? std::nullopt
                                : ui_accent_color(element, properties);
        pseudo(element, accent_name, accent.has_value());
        const auto* previous = element.GetLocalProperty(accent_variable);
        if (accent) {
            const auto value = "rgb(" + std::to_string(accent->r) + "," +
                               std::to_string(accent->g) + "," + std::to_string(accent->b) + ")";
            if (!previous || previous->Get<Rml::String>() != value) {
                element.SetProperty(accent_variable, value);
                changed = true;
            }
        } else if (previous) {
            element.RemoveProperty(accent_variable);
            changed = true;
        }
        for (int index = 0; index < element.GetNumChildren(); ++index) {
            auto* child = element.GetChild(index);
            if (!rmlui_dynamic_cast<Rml::ElementText*>(child))
                self(self, *child);
        }
    };
    visit(visit, document);
    return changed;
}

} // namespace bbl::pal
