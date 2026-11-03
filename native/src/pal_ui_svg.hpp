#pragma once

#include <bblite/pal_ui.hpp>
#include <bblite/pal_dom_events.hpp>
#include "pal_ui_svg_hit.hpp"
#include "pal_ui_svg_path.hpp"
#include <RmlUi/Core/StringUtilities.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <functional>
#include <initializer_list>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pal {

inline bool ui_svg_shape(const UiElementRecord& record) {
    return record.svg_namespace && record.tag != "svg";
}

inline std::string ui_svg_paint_keyword(std::string_view value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front())))
        value.remove_prefix(1);
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back())))
        value.remove_suffix(1);
    std::string result(value);
    std::transform(result.begin(), result.end(), result.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return result;
}

inline std::string ui_svg_paint(std::string_view value) {
    const auto keyword = ui_svg_paint_keyword(value);
    return keyword == "currentcolor" ? "white" : keyword == "none" ? "none" : std::string(value);
}

/** SVG descendants remain retained DOM records. RmlUi's SVG plugin consumes their XML. */
struct UiSvgMarkup {
    std::string source;
    bool current_color = false;
    // Each drawn element's geometry, in paint order, for hit testing and bounds.
    std::vector<UiSvgHitShape> hits;
    // The root's viewBox, which maps those user units into its content box.
    std::optional<std::array<double, 4>> view_box;
    // Whether the root's own box takes the pointer.
    bool takes_pointer = true;
};

/** The presentation properties a shape resolves; all but opacity inherit from the root. */
inline constexpr std::array<std::string_view, 9> ui_svg_presentation_properties{
    "fill",           "stroke",       "stroke-width", "stroke-linecap", "stroke-linejoin",
    "stroke-opacity", "fill-opacity", "paint-order",  "opacity"};

/** Whether a stylesheet or style write may set `property` on an SVG shape. */
inline bool ui_svg_shape_style_property(std::string_view property) {
    return property == "pointer-events" ||
           std::find(ui_svg_presentation_properties.begin(), ui_svg_presentation_properties.end(),
                     property) != ui_svg_presentation_properties.end();
}

/** A shape's cascaded stylesheet and style-write value of a property, empty when none sets it. */
using UiSvgCascade = std::function<std::string(UiElementHandle, std::string_view)>;

inline void ui_validate_svg_attribute(const UiElementRecord& record, std::string_view name,
                                      std::string_view value) {
    const auto one_of = [name](std::initializer_list<std::string_view> names) {
        return std::find(names.begin(), names.end(), name) != names.end();
    };
    const bool common =
        one_of({"id", "class", "fill", "stroke", "stroke-width", "stroke-linecap",
                "stroke-linejoin", "stroke-opacity", "fill-opacity", "paint-order", "opacity"});
    const bool root = record.tag == "svg" && one_of({"viewBox", "width", "height", "xmlns", "style",
                                                     "aria-hidden", "hidden"});
    const bool path = record.tag == "path" && name == "d";
    const bool rectangle =
        record.tag == "rect" && one_of({"x", "y", "width", "height", "rx", "ry"});
    const bool circle = record.tag == "circle" && one_of({"cx", "cy", "r"});
    const bool line = record.tag == "line" && one_of({"x1", "y1", "x2", "y2"});
    const bool ellipse = record.tag == "ellipse" && one_of({"cx", "cy", "rx", "ry"});
    const bool polygon = (record.tag == "polyline" || record.tag == "polygon") && name == "points";
    const bool typeset =
        (record.tag == "text" || record.tag == "textPath") &&
        one_of({"font-size", "font-family", "font-weight", "letter-spacing", "text-anchor"});
    const bool text = record.tag == "text" && one_of({"x", "y", "dx", "dy"});
    const bool text_path = record.tag == "textPath" && one_of({"href", "startOffset"});
    // Data attributes carry no rendering.
    const bool data = name.starts_with("data-");
    if (!(common || root || path || rectangle || circle || line || ellipse || polygon || typeset ||
          text || text_path || data))
        throw std::runtime_error("Unsupported retained SVG attribute '" + std::string(name) +
                                 "' on <" + record.tag + ">.");
    if (name == "fill" || name == "stroke") {
        const auto normalized = ui_svg_paint_keyword(value);
        if (normalized == "inherit" || normalized == "unset" || normalized == "initial" ||
            normalized == "revert" || normalized == "revert-layer" ||
            normalized == "context-fill" || normalized == "context-stroke" ||
            (normalized.find('(') != std::string::npos &&
             ((!normalized.starts_with("rgb(") && !normalized.starts_with("rgba(")) ||
              normalized.find('(', normalized.find('(') + 1) != std::string::npos)))
            throw std::runtime_error(
                "Retained SVG requires none, currentColor or a literal RGB paint.");
    }
    if (name == "xmlns" && value != "http://www.w3.org/2000/svg")
        throw std::runtime_error("Retained SVG xmlns cannot change namespace.");
}

/** The retained matcher inspects shape styles without inventing RmlUi child elements. */
inline std::vector<UiSelectorStep> ui_svg_style_sequence(const UiStyleRule& rule) {
    using Kind = UiSelectorTestKind;
    using Relation = UiSelectorRelation;
    if (rule.selector == UiStyleSelectorKind::Sequence)
        return rule.sequence;
    std::vector<UiSelectorStep> result{{Relation::Self, {}}};
    auto add = [&](Kind kind, const std::string& name, const std::string& value = {}) {
        result.back().tests.push_back({kind, name, value});
    };
    switch (rule.selector) {
    case UiStyleSelectorKind::Class:
        add(Kind::Class, rule.primary);
        break;
    case UiStyleSelectorKind::Id:
        add(Kind::Id, rule.primary);
        break;
    case UiStyleSelectorKind::CompoundClass:
        add(Kind::Class, rule.primary);
        add(Kind::Class, rule.secondary);
        break;
    case UiStyleSelectorKind::TagClass:
        add(Kind::Tag, rule.tag);
        add(Kind::Class, rule.primary);
        break;
    case UiStyleSelectorKind::ClassDescendantTag:
        add(Kind::Class, rule.primary);
        result.push_back({Relation::Descendant, {}});
        add(Kind::Tag, rule.tag);
        break;
    case UiStyleSelectorKind::IdDescendantClass:
        add(Kind::Id, rule.primary);
        result.push_back({Relation::Descendant, {}});
        add(Kind::Class, rule.secondary);
        break;
    case UiStyleSelectorKind::TagChildClass:
        add(Kind::Tag, rule.tag);
        result.push_back({Relation::Child, {}});
        add(Kind::Class, rule.primary);
        if (!rule.secondary.empty())
            add(Kind::Class, rule.secondary);
        break;
    case UiStyleSelectorKind::Sequence:
        break;
    }
    return result;
}

/** A face SVG text draws with: its family name in the SVG plugin, and its glyph advances. */
struct UiSvgFont {
    std::string family;
    std::function<double(char32_t codepoint, double size)> advance;
    // The face's ascender and descender in ems: a glyph cell's extent about the baseline.
    double ascent = 0.8;
    double descent = 0.2;
};

/** The face a CSS family list resolves to at a weight and style; nullopt when none loads. */
using UiSvgFonts = std::function<std::optional<UiSvgFont>(const std::string&, int, bool)>;

/** What a created SVG takes from its HTML element: color for currentColor, the font. */
struct UiSvgContext {
    std::string color;
    std::string font_family;
    double font_size = 16;
    int font_weight = 400;
    bool italic = false;
    std::string text_transform = "none";
    // The root's pointer-events, declared or inherited from its HTML parent.
    std::string pointer_events = "auto";
    UiSvgFonts fonts;
};

/** The text properties an SVG text resolves; all inherit. */
inline constexpr std::array<std::string_view, 6> ui_svg_text_properties{
    "font-size", "font-family", "font-weight", "letter-spacing", "text-transform", "text-anchor"};

/** Whether a stylesheet or style write may set `property` on an SVG text. */
inline bool ui_svg_text_style_property(std::string_view property) {
    return ui_svg_shape_style_property(property) || property == "text-shadow" ||
           std::find(ui_svg_text_properties.begin(), ui_svg_text_properties.end(), property) !=
               ui_svg_text_properties.end();
}

/** A UTF-8 text's characters with their code points, segmented as RmlUi iterates text. */
inline std::vector<std::pair<std::string, char32_t>> ui_svg_characters(std::string_view text) {
    std::vector<std::pair<std::string, char32_t>> characters;
    const char* end = text.data() + text.size();
    for (const char* cursor = text.data(); cursor < end;) {
        const char* next = Rml::StringUtilities::SeekForwardUTF8(cursor + 1, end);
        characters.emplace_back(
            std::string(cursor, next),
            static_cast<char32_t>(Rml::StringUtilities::ToCharacter(cursor, end)));
        cursor = next;
    }
    return characters;
}

/**
 * A length an SVG attribute or style spells (`12`, `12px`), in pixels; with `percent_of`, a
 * percentage of it too (`50%`).
 */
inline double ui_svg_pixels(std::string_view value, std::string_view property,
                            std::optional<double> percent_of = std::nullopt) {
    svg_path_detail::Reader reader(value);
    const auto number = reader.number();
    std::string_view unit = reader.rest();
    unit = unit.substr(0, unit.find_last_not_of(" \t\n\r") + 1);
    const bool percent = percent_of && unit == "%";
    if (!number || !std::isfinite(*number) || !(unit.empty() || unit == "px" || percent))
        throw std::runtime_error("Retained SVG text requires a pixel " +
                                 std::string(percent_of ? "or percentage " : "") +
                                 std::string(property) + ", not '" + std::string(value) + "'.");
    return percent ? *percent_of * *number / 100 : *number;
}

/**
 * The shapes' and texts' XML for RmlUi's SVG plugin. Each presentation property resolves as a
 * browser cascades it: the stylesheets and style writes (`cascade`), then the presentation
 * attribute, then the parent's value. currentColor alone keeps the plugin's tint (the root's color
 * follows without regenerating the image); beside literal paints it is the root's color. A text
 * draws with the face its font resolves to; one on a textPath places each glyph along the path,
 * which the plugin cannot.
 */
inline UiSvgMarkup ui_svg_markup(const Engine& engine, UiElementHandle root_handle,
                                 const UiSvgCascade& cascade, const UiSvgContext& context) {
    const auto& root = handle_at(engine.ui_elements, root_handle);
    UiSvgMarkup result;
    const auto text_element = [](const UiElementRecord& record) {
        return record.tag == "text" || record.tag == "textPath";
    };
    const auto validate_content = [&](const UiElementRecord& record) {
        if ((!record.text.empty() && !text_element(record)) || !record.inner_rml.empty())
            throw std::runtime_error("Retained SVG accepts authored shape and text children only.");
        // DOM input reaches a shape through its hit geometry; an RmlUi listener has no element.
        if (ui_svg_shape(record) &&
            (!record.event_callbacks.empty() || !record.click_callbacks.empty()))
            throw std::runtime_error("SVG shape listeners require DOM input.");
        for (const auto& [name, value] : record.style_properties)
            if (ui_svg_shape(record) && !(text_element(record) ? ui_svg_text_style_property(name)
                                                               : ui_svg_shape_style_property(name)))
                throw std::runtime_error("SVG shape styles require SVG DOM projection.");
        for (const auto& [name, value] : record.attributes)
            ui_validate_svg_attribute(record, name, value);
    };
    validate_content(root);
    const auto resolve = [&](UiElementHandle handle, const UiElementRecord& record,
                             std::string_view property, std::string_view inherited) {
        if (auto value = cascade(handle, property); !value.empty()) {
            if (property == "fill" || property == "stroke")
                ui_validate_svg_attribute(record, property, value);
            return value;
        }
        const auto found = record.attributes.find(std::string(property));
        if (found != record.attributes.end())
            return found->second;
        return property == "opacity" ? std::string{} : std::string(inherited);
    };
    using Presentation = std::array<std::string, ui_svg_presentation_properties.size()>;
    using Typography = std::array<std::string, ui_svg_text_properties.size()>;
    const auto presentation_of = [&](UiElementHandle handle, const UiElementRecord& record,
                                     const Presentation& parent) {
        Presentation values;
        for (std::size_t index = 0; index < values.size(); ++index)
            values[index] =
                resolve(handle, record, ui_svg_presentation_properties[index], parent[index]);
        return values;
    };
    const auto typography_of = [&](UiElementHandle handle, const UiElementRecord& record,
                                   const Typography& parent) {
        Typography values;
        for (std::size_t index = 0; index < values.size(); ++index)
            values[index] = resolve(handle, record, ui_svg_text_properties[index], parent[index]);
        return values;
    };
    Presentation inherited;
    for (std::size_t index = 0; index < inherited.size(); ++index) {
        const auto property = ui_svg_presentation_properties[index];
        inherited[index] = resolve(root_handle, root, property,
                                   property == "fill"     ? "black"
                                   : property == "stroke" ? "none"
                                                          : "");
    }
    const Typography root_typography =
        typography_of(root_handle, root,
                      {std::to_string(context.font_size), context.font_family,
                       std::to_string(context.font_weight), "0", context.text_transform, "start"});
    // Each drawn element: its paints, its XML given the presentation attributes, its geometry.
    struct Drawn {
        Presentation values;
        std::function<std::string(const std::string&)> element;
        UiSvgHitShape hit;
    };
    // pointer-events: auto is visiblePainted (SVG 1.1 §16.6), the one painted form represented.
    // As for HTML elements, a reached pointer listener opts an element in unless a declaration
    // decides; otherwise the value inherits.
    const auto takes_pointer = [&](UiElementHandle handle, const UiElementRecord& record,
                                   std::string_view inherited) {
        auto value = resolve(handle, record, "pointer-events", "");
        if (value.empty())
            value = engine.dom_input && engine.dom_input->pointer_elements.contains(handle.value)
                        ? "auto"
                        : std::string(inherited);
        const auto keyword = ui_svg_paint_keyword(value);
        if (keyword != "auto" && keyword != "visiblepainted" && keyword != "none")
            throw std::runtime_error("Retained SVG pointer-events supports auto, visiblePainted "
                                     "and none, not '" +
                                     value + "'.");
        return std::pair{value, keyword != "none"};
    };
    const auto [root_pointer, root_takes_pointer] =
        takes_pointer(root_handle, root, context.pointer_events);
    result.takes_pointer = root_takes_pointer;
    std::vector<Drawn> drawn;
    // The font of the element whose glyphs are drawn: the text itself, or its textPath.
    struct Face {
        UiSvgFont font;
        double size = 0;
        double spacing = 0;
        std::string transform;
        std::string attributes;
    };
    const auto face_of = [&](const Typography& typography) {
        const auto weight = ui_svg_paint_keyword(typography[2]);
        const auto font =
            context.fonts
                ? context.fonts(typography[1],
                                weight == "bold" ? 700
                                : weight == "normal"
                                    ? 400
                                    : static_cast<int>(ui_svg_pixels(typography[2], "font-weight")),
                                context.italic)
                : std::nullopt;
        if (!font)
            throw std::runtime_error("Retained SVG text requires a loaded font face for '" +
                                     typography[1] + "'.");
        const auto transform = ui_svg_paint_keyword(typography[4]);
        if (transform != "none" && transform != "uppercase" && transform != "lowercase")
            throw std::runtime_error(
                "Retained SVG text supports none, uppercase and lowercase text-transform.");
        return Face{*font, ui_svg_pixels(typography[0], "font-size"),
                    ui_svg_paint_keyword(typography[3]) == "normal"
                        ? 0.0
                        : ui_svg_pixels(typography[3], "letter-spacing"),
                    transform,
                    " font-family=\"" + ui_escape_rml(font->family) + "\" font-size=\"" +
                        ui_escape_rml(typography[0]) + "\""};
    };
    const auto transformed = [](const Face& face, const std::string& content) {
        return face.transform == "uppercase"   ? js::string_to_upper_case(content)
               : face.transform == "lowercase" ? js::string_to_lower_case(content)
                                               : content;
    };
    const auto text_of = [&](UiElementHandle text_handle, const UiElementRecord& text,
                             const Presentation& values, const Typography& typography) {
        const auto [text_pointer, text_takes_pointer] =
            takes_pointer(text_handle, text, root_pointer);
        if (text.children.empty()) {
            // The plugin lays out its own text.
            const Face face = face_of(typography);
            std::string attributes = face.attributes + " text-anchor=\"" +
                                     ui_escape_rml(typography[5]) + "\" letter-spacing=\"" +
                                     std::to_string(face.spacing) + "\"";
            for (const auto* name : {"x", "y", "dx", "dy"})
                if (const auto found = text.attributes.find(name); found != text.attributes.end())
                    attributes +=
                        std::string(" ") + name + "=\"" + ui_escape_rml(found->second) + "\"";
            const std::string content = ui_escape_rml(transformed(face, text.text));
            // Its glyph cells along the baseline from x and y, shifted by its anchor.
            const auto coordinate = [&](const char* name) {
                const auto found = text.attributes.find(name);
                return found == text.attributes.end() ? 0.0 : ui_svg_pixels(found->second, name);
            };
            UiSvgHitShape hit;
            hit.target = text_handle;
            hit.pointer = text_takes_pointer;
            double cursor = 0;
            for (const auto& [character, codepoint] :
                 ui_svg_characters(transformed(face, text.text))) {
                static_cast<void>(character);
                const double advance = face.font.advance(codepoint, face.size) + face.spacing;
                hit.cells.push_back({{cursor, 0},
                                     {1, 0},
                                     advance,
                                     face.font.ascent * face.size,
                                     face.font.descent * face.size});
                cursor += advance;
            }
            const auto anchor = ui_svg_paint_keyword(typography[5]);
            const double start = coordinate("x") + coordinate("dx") -
                                 (anchor == "middle" ? cursor / 2
                                  : anchor == "end"  ? cursor
                                                     : 0);
            for (auto& cell : hit.cells)
                cell.origin = {cell.origin.x + start, coordinate("y") + coordinate("dy")};
            drawn.push_back({values,
                             [attributes, content](const std::string& presentation) {
                                 return "<text" + attributes + presentation + ">" + content +
                                        "</text>";
                             },
                             std::move(hit)});
            return;
        }
        if (text.children.size() != 1 || !text.text.empty())
            throw std::runtime_error("A retained SVG text holds its text or one textPath.");
        const auto path_handle = text.children.front();
        const auto& on_path = handle_at(engine.ui_elements, path_handle);
        if (on_path.tag != "textPath" || !on_path.children.empty())
            throw std::runtime_error("A retained SVG text holds its text or one textPath.");
        validate_content(on_path);
        const Presentation path_values = presentation_of(path_handle, on_path, values);
        const Typography path_typography = typography_of(path_handle, on_path, typography);
        const Face face = face_of(path_typography);
        const auto href = on_path.attributes.find("href");
        if (href == on_path.attributes.end() || !href->second.starts_with("#"))
            throw std::runtime_error("A retained SVG textPath requires an href to a path.");
        const UiElementRecord* guide = nullptr;
        for (const auto sibling : root.children) {
            const auto& candidate = handle_at(engine.ui_elements, sibling);
            const auto id = candidate.attributes.find("id");
            if (candidate.tag == "path" && id != candidate.attributes.end() &&
                id->second == std::string_view(href->second).substr(1))
                guide = &candidate;
        }
        std::optional<UiSvgPolylines> lines;
        if (guide)
            if (const auto data = guide->attributes.find("d"); data != guide->attributes.end())
                lines = ui_svg_path_polylines(data->second);
        if (!lines)
            throw std::runtime_error("A retained SVG textPath requires a path of this SVG.");
        const double length = ui_svg_path_length(*lines);
        double offset = 0;
        if (const auto start = on_path.attributes.find("startOffset");
            start != on_path.attributes.end())
            offset = ui_svg_pixels(start->second, "startOffset", length);
        std::vector<std::string> glyphs;
        std::vector<double> advances;
        for (const auto& [character, codepoint] :
             ui_svg_characters(transformed(face, on_path.text))) {
            glyphs.push_back(character);
            advances.push_back(face.font.advance(codepoint, face.size) + face.spacing);
        }
        auto placed = ui_svg_text_path_layout(*lines, glyphs, advances, offset,
                                              ui_svg_paint_keyword(path_typography[5]));
        // Its glyphs belong to the textPath, which inherits the text's pointer-events.
        UiSvgHitShape hit;
        hit.target = path_handle;
        hit.pointer = takes_pointer(path_handle, on_path, text_pointer).second;
        for (const auto& glyph : placed)
            hit.cells.push_back({glyph.origin, glyph.direction, glyph.advance,
                                 face.font.ascent * face.size, face.font.descent * face.size});
        drawn.push_back({path_values,
                         [placed = std::move(placed),
                          typeface = face.attributes](const std::string& presentation) {
                             return ui_svg_positioned_text(placed, typeface + presentation);
                         },
                         std::move(hit)});
    };
    for (const auto handle : root.children) {
        const auto& child = handle_at(engine.ui_elements, handle);
        if (!ui_svg_shape(child) || (!child.children.empty() && child.tag != "text") ||
            child.tag == "textPath")
            throw std::runtime_error("A retained SVG requires direct shape and text children.");
        validate_content(child);
        const Presentation values = presentation_of(handle, child, inherited);
        if (child.tag == "text") {
            text_of(handle, child, values, typography_of(handle, child, root_typography));
            continue;
        }
        // Stable XML avoids regenerating the plugin image when only container storage moved.
        std::string geometry;
        std::vector<std::string> names;
        names.reserve(child.attributes.size());
        for (const auto& [name, value] : child.attributes) {
            static_cast<void>(value);
            if (!ui_svg_shape_style_property(name))
                names.push_back(name);
        }
        std::sort(names.begin(), names.end());
        for (const auto& name : names)
            geometry += " " + name + "=\"" + ui_escape_rml(child.attributes.at(name)) + "\"";
        const std::string tag = child.tag;
        // Painted geometry: a fill area (a line has none) and a stroke band of its width.
        UiSvgHitShape hit;
        hit.target = handle;
        hit.pointer = takes_pointer(handle, child, root_pointer).second;
        auto outline = ui_svg_shape_outline(child, [&](std::string_view name) {
            const auto found = child.attributes.find(std::string(name));
            return found == child.attributes.end() ? 0.0 : ui_svg_pixels(found->second, name);
        });
        if (!outline && hit.pointer)
            throw std::runtime_error("A retained SVG <" + tag +
                                     "> taking the pointer needs geometry its hit test "
                                     "flattens (M/L/H/V/A/C/Q/Z paths, numeric points).");
        hit.outline = std::move(outline).value_or(UiSvgPolylines{});
        hit.fill = tag != "line" && ui_svg_paint_keyword(values[0]) != "none";
        if (ui_svg_paint_keyword(values[1]) != "none")
            hit.stroke_width = values[2].empty() ? 1.0 : ui_svg_pixels(values[2], "stroke-width");
        drawn.push_back({values,
                         [tag, geometry](const std::string& presentation) {
                             return "<" + tag + geometry + presentation + "/>";
                         },
                         std::move(hit)});
    }
    bool current = false;
    bool literal = false;
    for (const Drawn& item : drawn)
        for (std::size_t index : {std::size_t{0}, std::size_t{1}}) {
            const auto keyword = ui_svg_paint_keyword(item.values[index]);
            if (keyword == "currentcolor")
                current = true;
            else if (keyword != "none")
                literal = true;
        }
    result.current_color = current && !literal;
    const auto paint = [&](const std::string& value) {
        return ui_svg_paint_keyword(value) == "currentcolor" && !result.current_color
                   ? context.color
                   : ui_svg_paint(value);
    };
    for (const Drawn& item : drawn) {
        const auto presentation = [&](std::string_view fill, std::string_view stroke) {
            std::string source;
            for (std::size_t index = 0; index < item.values.size(); ++index) {
                const auto property = ui_svg_presentation_properties[index];
                const std::string value = index == 0   ? std::string(fill)
                                          : index == 1 ? std::string(stroke)
                                                       : item.values[index];
                if (!value.empty() && property != "paint-order")
                    source += " " + std::string(property) + "=\"" + ui_escape_rml(value) + "\"";
            }
            return source;
        };
        const std::string fill = paint(item.values[0]);
        const std::string stroke = paint(item.values[1]);
        // The plugin paints fill then stroke; a stroke ordered first is drawn as its own copy.
        const auto order = ui_svg_paint_keyword(item.values[7]);
        if (order.starts_with("stroke") && fill != "none" && stroke != "none")
            result.source += item.element(presentation("none", stroke)) +
                             item.element(presentation(fill, "none"));
        else
            result.source += item.element(presentation(fill, stroke));
        result.hits.push_back(item.hit);
        result.hits.back().bounds = ui_svg_hit_bounds(result.hits.back());
    }
    result.view_box = ui_svg_view_box(root);
    return result;
}

} // namespace bbl::pal
