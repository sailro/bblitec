#pragma once

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/PropertyDefinition.h>
#include <RmlUi/Core/StyleSheetSpecification.h>
#include <RmlUi/Core/Transform.h>
#include <bblite/js_data.hpp>
#include <cctype>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl::pal {

inline void register_ui_background_properties() {
    Rml::StyleSheetSpecification::RegisterProperty("bbl-transform", "none", false)
        .AddParser("transform");
    Rml::StyleSheetSpecification::RegisterProperty("scale", "1", false).AddParser("number");
    Rml::StyleSheetSpecification::RegisterProperty("bbl-zero-clip", "0", false).AddParser("number");
    // The image longhands the PAL paints as a decorator, at their CSS initial values; the cascade
    // resolves their CSS-wide keywords (RmlUi patch 0066).
    for (const auto& [name, initial] :
         {std::pair{"bbl-background-image", "none"}, std::pair{"bbl-background-size", "auto"},
          std::pair{"bbl-background-position", "0% 0%"},
          std::pair{"bbl-background-repeat", "repeat"},
          std::pair{"bbl-background-origin", "padding-box"},
          std::pair{"bbl-background-attachment", "scroll"}})
        Rml::StyleSheetSpecification::RegisterProperty(name, initial, false).AddParser("string");
}

/**
 * A background position as the two offsets a sized decorator layer takes: keywords as
 * percentages, a single value centring the other axis (CSS Backgrounds 3 `<bg-position>`).
 */
inline Rml::String ui_background_offsets(std::string_view position) {
    std::vector<std::string> tokens;
    int depth = 0;
    for (const char character : position) {
        if (character == '(')
            ++depth;
        else if (character == ')')
            --depth;
        if (depth == 0 && std::isspace(static_cast<unsigned char>(character))) {
            if (!tokens.empty() && !tokens.back().empty())
                tokens.emplace_back();
            continue;
        }
        if (tokens.empty())
            tokens.emplace_back();
        tokens.back().push_back(js::ascii_lower(character));
    }
    if (!tokens.empty() && tokens.back().empty())
        tokens.pop_back();
    if (tokens.empty() || tokens.size() > 2)
        throw std::runtime_error("Unrepresented UI background position: " + std::string(position));
    if (tokens.size() == 1)
        tokens.emplace_back("center");
    if (tokens[0] == "top" || tokens[0] == "bottom" || tokens[1] == "left" || tokens[1] == "right")
        std::swap(tokens[0], tokens[1]);
    const auto offset = [](const std::string& token, std::string_view start,
                           std::string_view end) -> std::string {
        return token == "center" ? "50%" : token == start ? "0%" : token == end ? "100%" : token;
    };
    return offset(tokens[0], "left", "right") + " " + offset(tokens[1], "top", "bottom");
}

/** Whether an image function at `offset` is a gradient, ending at the returned index. */
inline std::optional<std::size_t> ui_background_gradient_at(std::string_view value,
                                                            std::size_t offset) {
    std::string name;
    std::size_t open = offset;
    for (; open < value.size() && value[open] != '(' && value[open] != ' ' && value[open] != ',';
         ++open)
        name += static_cast<char>(std::tolower(static_cast<unsigned char>(value[open])));
    if (open == value.size() || value[open] != '(')
        return std::nullopt;
    if (name.starts_with("repeating-"))
        name.erase(0, 10);
    if (name != "linear-gradient" && name != "radial-gradient" && name != "conic-gradient")
        return std::nullopt;
    int depth = 0;
    for (std::size_t index = open; index < value.size(); ++index) {
        if (value[index] == '(')
            ++depth;
        else if (value[index] == ')' && --depth == 0)
            return index + 1;
    }
    return std::nullopt;
}

/** A cascaded image led by a gradient is RmlUi decorator text; a raster image is a path. */
inline bool ui_background_gradient(std::string_view image) {
    const auto start = image.find_first_not_of(" \t\r\n");
    return start != std::string_view::npos && ui_background_gradient_at(image, start).has_value();
}

/** A comma-separated list of plain gradient images, each one layer without box tokens. */
inline bool ui_background_gradient_layers(std::string_view value) {
    std::size_t index = 0;
    for (;;) {
        index = value.find_first_not_of(" \t\r\n", index);
        if (index == std::string_view::npos)
            return false;
        const auto end = ui_background_gradient_at(value, index);
        if (!end)
            return false;
        index = value.find_first_not_of(" \t\r\n", *end);
        if (index == std::string_view::npos)
            return true;
        if (value[index] != ',')
            return false;
        ++index;
    }
}

/** One PAL-owned override restores the live stylesheet and source inline value on removal. */
struct UiScopedStyleProperty {
    std::optional<Rml::Property> original, applied;
    Rml::String spelling;

    bool set(Rml::Element& element, Rml::PropertyId id, const std::optional<Rml::Property>& next) {
        const auto& properties = element.GetLocalStyleProperties();
        const auto found = properties.find(id);
        const std::optional<Rml::Property> current =
            found == properties.end() ? std::nullopt : std::optional<Rml::Property>{found->second};
        if (!applied || current != applied)
            original = current;
        if (!next) {
            if (!applied)
                return false;
            if (original)
                element.SetProperty(id, *original);
            else
                element.RemoveProperty(id);
            applied.reset();
            spelling.clear();
            return true;
        }
        if (current == next) {
            applied = next;
            return false;
        }
        element.SetProperty(id, *next);
        applied = next;
        return true;
    }

    bool set_string(Rml::Element& element, const char* name,
                    const std::optional<Rml::String>& next) {
        const auto* definition = Rml::StyleSheetSpecification::GetProperty(name);
        if (!next)
            return set(element, definition->GetId(), std::nullopt);
        if (applied && spelling == *next)
            return set(element, definition->GetId(), applied);
        Rml::Property property;
        if (!definition->ParseValue(property, *next))
            throw std::runtime_error("Invalid native UI projection for " + Rml::String{name} +
                                     ": " + *next);
        spelling = *next;
        return set(element, definition->GetId(), property);
    }
};

struct UiBackgroundElementState {
    Rml::ObserverPtr<Rml::Element> element;
    UiScopedStyleProperty image, transform, opacity, pointer_events, display;
    Rml::TransformPtr source_transform;
    float source_scale = 1;
};

/** Bound image backgrounds, individual scale, and zero-area clipping retain CSS layout. */
class UiBackgroundStyles {
public:
    void clear() { states.clear(); }
    bool sync(Rml::Element& document) {
        bool changed = false;
        const auto visit = [&](const auto& self, Rml::Element& element, bool clipped) -> void {
            clipped = clipped || element.GetProperty<float>("bbl-zero-clip") != 0;
            const auto image = element.GetProperty<Rml::String>("bbl-background-image");
            const float scale = element.GetProperty<float>("scale");
            const bool transformed =
                element.GetLocalProperty("bbl-transform") || element.GetLocalProperty("scale");
            const bool shrink_to_fit = element.GetLocalProperty("--bbl-absolute-inline") &&
                                       !element.GetLocalProperty("--bbl-authored-display");
            if (clipped || image != "none" || transformed || shrink_to_fit ||
                states.contains(&element)) {
                auto& state = states[&element];
                if (state.element != &element) {
                    state = {};
                    state.element = element.GetObserverPtr();
                }
                std::optional<Rml::String> decorator;
                if (image != "none") {
                    const auto size = element.GetProperty<Rml::String>("bbl-background-size");
                    const auto repeat = element.GetProperty<Rml::String>("bbl-background-repeat");
                    if (size == "0px 0px" || size == "0dp 0dp" || size == "0 0")
                        decorator = "none";
                    // Gradient layers fill their box, as they do for the auto, contain and cover
                    // sizes the surface admits: sized layers carry their own boxes, plain ones
                    // paint in the decorator's padding box, exact for a padding-box clip (a
                    // border-box clip's repetition under the border is not represented).
                    else if (ui_background_gradient(image)) {
                        if (ui_background_gradient_layers(image) &&
                            element.GetProperty(Rml::PropertyId::BackgroundClip)->Get<int>() == 2)
                            throw std::runtime_error("A content-box clip of padding-box gradient "
                                                     "layers is not represented.");
                        decorator = image;
                    } else {
                        if (repeat == "repeat" && size != "auto")
                            throw std::runtime_error(
                                "Repeating sized UI backgrounds are not represented.");
                        const auto position =
                            element.GetProperty<Rml::String>("bbl-background-position");
                        // The style engine keeps the image path unquoted.
                        const auto source = '"' + image + '"';
                        // An explicit size is a layer with its own box the image fills,
                        // placed at the position's offsets (RmlUi patch 0025).
                        if (size != "auto" && size != "contain" && size != "cover")
                            decorator = "image(" + source + " fill) padding-box / " + size + " / " +
                                        ui_background_offsets(position);
                        else
                            decorator = "image(" + source + " " +
                                        (repeat == "repeat" ? "repeat"
                                         : size == "auto"   ? "scale-none"
                                                            : size) +
                                        " " + position + ") padding-box";
                    }
                }
                changed = state.image.set_string(element, "decorator", decorator) || changed;
                changed = state.opacity.set_string(element, "opacity",
                                                   clipped ? std::optional<Rml::String>{"0"}
                                                           : std::nullopt) ||
                          changed;
                changed = state.pointer_events.set_string(
                              element, "pointer-events",
                              clipped ? std::optional<Rml::String>{"none"} : std::nullopt) ||
                          changed;
                changed =
                    state.display.set_string(
                        element, "display",
                        shrink_to_fit ? std::optional<Rml::String>{element.HasAttribute("hidden")
                                                                       ? "none"
                                                                       : "inline-block"}
                                      : std::nullopt) ||
                    changed;
                if (transformed) {
                    const auto source =
                        element.GetLocalProperty("bbl-transform")
                            ? element.GetProperty<Rml::TransformPtr>("bbl-transform")
                        : state.transform.applied
                            ? state.source_transform
                            : element.GetProperty<Rml::TransformPtr>("transform");
                    if (!state.transform.applied || state.source_transform != source ||
                        state.source_scale != scale) {
                        Rml::Transform::PrimitiveList primitives;
                        if (scale != 1)
                            primitives.emplace_back(Rml::Transforms::Scale2D{scale});
                        if (source)
                            primitives.insert(primitives.end(), source->GetPrimitives().begin(),
                                              source->GetPrimitives().end());
                        const auto property =
                            primitives.empty()
                                ? *Rml::StyleSheetSpecification::GetProperty("transform")
                                       ->GetDefaultValue()
                                : Rml::Transform::MakeProperty(std::move(primitives));
                        changed =
                            state.transform.set(element, Rml::PropertyId::Transform, property) ||
                            changed;
                        state.source_transform = source;
                        state.source_scale = scale;
                    } else
                        changed = state.transform.set(element, Rml::PropertyId::Transform,
                                                      state.transform.applied) ||
                                  changed;
                } else
                    changed =
                        state.transform.set(element, Rml::PropertyId::Transform, std::nullopt) ||
                        changed;
            }
            for (int index = 0; index < element.GetNumChildren(true); ++index)
                self(self, *element.GetChild(index), clipped);
        };
        visit(visit, document, false);
        std::erase_if(states, [](const auto& entry) { return !entry.second.element; });
        return changed;
    }

private:
    std::unordered_map<Rml::Element*, UiBackgroundElementState> states;
};

} // namespace bbl::pal
