#pragma once

#include <bblite/pal_ui.hpp>
#include <bblite/pal_dom_events.hpp>

#include <algorithm>
#include <cctype>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <string_view>
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
};

inline void ui_validate_svg_attribute(const UiElementRecord& record, std::string_view name,
                                      std::string_view value) {
    const auto one_of = [name](std::initializer_list<std::string_view> names) {
        return std::find(names.begin(), names.end(), name) != names.end();
    };
    const bool common = one_of(
        {"id", "class", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"});
    const bool root = record.tag == "svg" && one_of({"viewBox", "width", "height", "xmlns", "style",
                                                     "aria-hidden", "hidden"});
    const bool path = record.tag == "path" && name == "d";
    const bool rectangle =
        record.tag == "rect" && one_of({"x", "y", "width", "height", "rx", "ry"});
    const bool circle = record.tag == "circle" && one_of({"cx", "cy", "r"});
    const bool line = record.tag == "line" && one_of({"x1", "y1", "x2", "y2"});
    const bool ellipse = record.tag == "ellipse" && one_of({"cx", "cy", "rx", "ry"});
    const bool polygon = (record.tag == "polyline" || record.tag == "polygon") && name == "points";
    if (!(common || root || path || rectangle || circle || line || ellipse || polygon))
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
    case UiStyleSelectorKind::TagAttribute:
        add(Kind::Tag, rule.tag);
        add(Kind::Equals, rule.primary, rule.secondary);
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

inline UiSvgMarkup ui_svg_markup(const Engine& engine, const UiElementRecord& root) {
    UiSvgMarkup result;
    bool literal_paint = false;
    const auto validate_content = [](const UiElementRecord& record) {
        if (!record.text.empty() || !record.inner_rml.empty())
            throw std::runtime_error("Retained SVG accepts authored shape children only.");
        if (ui_svg_shape(record) &&
            (!record.style_properties.empty() || !record.event_callbacks.empty() ||
             !record.click_callbacks.empty()))
            throw std::runtime_error("SVG shape styles and listeners require SVG DOM projection.");
        for (const auto& [name, value] : record.attributes)
            ui_validate_svg_attribute(record, name, value);
    };
    validate_content(root);
    const auto paint = [](const UiElementRecord& record, const std::string& name,
                          std::string_view fallback) {
        const auto found = record.attributes.find(name);
        return found == record.attributes.end() ? std::string(fallback) : found->second;
    };
    for (const auto handle : root.children) {
        const auto& child = handle_at(engine.ui_elements, handle);
        if (engine.dom_input && engine.dom_input->pointer_elements.contains(handle.value))
            throw std::runtime_error("SVG shape listeners require SVG hit testing.");
        if (!ui_svg_shape(child) || !child.children.empty())
            throw std::runtime_error(
                "A retained SVG requires direct path, rect or circle children.");
        validate_content(child);
        for (const auto* name : {"fill", "stroke"}) {
            const auto value =
                paint(child, name,
                      paint(root, name, std::string_view(name) == "fill" ? "black" : "none"));
            const auto keyword = ui_svg_paint_keyword(value);
            if (keyword == "none")
                continue;
            if (keyword == "currentcolor")
                result.current_color = true;
            else
                literal_paint = true;
        }
        result.source += "<" + child.tag;
        // Stable XML avoids regenerating the plugin image when only container storage moved.
        std::vector<std::string> names;
        names.reserve(child.attributes.size());
        for (const auto& [name, value] : child.attributes) {
            static_cast<void>(value);
            names.push_back(name);
        }
        std::sort(names.begin(), names.end());
        for (const auto& name : names) {
            const auto& value = child.attributes.at(name);
            result.source +=
                " " + name + "=\"" +
                ui_escape_rml(name == "fill" || name == "stroke" ? ui_svg_paint(value) : value) +
                "\"";
        }
        result.source += "/>";
    }
    if (result.current_color && literal_paint)
        throw std::runtime_error("Retained SVG cannot mix currentColor and literal paints.");
    return result;
}

} // namespace bbl::pal
