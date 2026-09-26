#pragma once

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/PropertyDefinition.h>
#include <RmlUi/Core/StyleSheetSpecification.h>
#include <RmlUi/Core/Transform.h>
#include <optional>
#include <stdexcept>
#include <unordered_map>

namespace bbl::pal {

inline void register_ui_background_properties() {
    Rml::StyleSheetSpecification::RegisterProperty("bbl-transform", "none", false)
        .AddParser("transform");
    Rml::StyleSheetSpecification::RegisterProperty("scale", "1", false).AddParser("number");
    Rml::StyleSheetSpecification::RegisterProperty("bbl-zero-clip", "0", false).AddParser("number");
}

inline Rml::String ui_background_default(const Rml::String& name) {
    if (name == "bbl-background-image")
        return "none";
    if (name == "bbl-background-size")
        return "auto";
    if (name == "bbl-background-position")
        return "0% 0%";
    if (name == "bbl-background-repeat")
        return "repeat";
    if (name == "bbl-background-origin")
        return "padding-box";
    if (name == "bbl-background-attachment")
        return "scroll";
    return "";
}

/** Resolve explicit CSS inheritance through the original, cascaded custom property. */
inline Rml::String ui_background_value(Rml::Element& element, const Rml::String& name) {
    const auto key = "--" + name;
    const auto value = element.GetLocalProperty(key) ? element.GetProperty<Rml::String>(key)
                                                     : ui_background_default(name);
    if (value != "inherit")
        return value;
    if (auto* parent = element.GetParentNode()) {
        if (name == "bbl-background-color" || name == "bbl-background-clip") {
            const auto inherited = ui_background_value(*parent, name);
            return inherited.empty() ? parent->GetProperty(name.substr(4))->ToString() : inherited;
        }
        return ui_background_value(*parent, name);
    }
    if (name == "bbl-background-color")
        return "transparent";
    if (name == "bbl-background-clip")
        return "border-box";
    return ui_background_default(name);
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
    UiScopedStyleProperty image, color, clip, transform, opacity, pointer_events, display;
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
            const auto image = ui_background_value(element, "bbl-background-image");
            const auto color = ui_background_value(element, "bbl-background-color");
            const auto clip = ui_background_value(element, "bbl-background-clip");
            const float scale = element.GetProperty<float>("scale");
            const bool transformed =
                element.GetLocalProperty("bbl-transform") || element.GetLocalProperty("scale");
            const bool shrink_to_fit = element.GetLocalProperty("--bbl-absolute-inline") &&
                !element.GetLocalProperty("--bbl-authored-display");
            if (clipped || image != "none" || !color.empty() || !clip.empty() || transformed ||
                shrink_to_fit || states.contains(&element)) {
                auto& state = states[&element];
                if (state.element != &element) {
                    state = {};
                    state.element = element.GetObserverPtr();
                }
                std::optional<Rml::String> decorator;
                if (image != "none") {
                    const auto size = ui_background_value(element, "bbl-background-size");
                    const auto repeat = ui_background_value(element, "bbl-background-repeat");
                    if (size == "0px 0px" || size == "0dp 0dp" || size == "0 0")
                        decorator = "none";
                    else {
                        if (repeat == "repeat" && size != "auto")
                            throw std::runtime_error(
                                "Repeating sized UI backgrounds are not represented.");
                        const auto fit = repeat == "repeat" ? "repeat"
                                         : size == "auto"   ? "scale-none"
                                                            : size;
                        const auto position =
                            ui_background_value(element, "bbl-background-position");
                        decorator = "image(" + image + " " + fit + " " + position + ") padding-box";
                    }
                }
                changed = state.image.set_string(element, "decorator", decorator) || changed;
                changed =
                    state.color.set_string(element, "background-color",
                                           color.empty() ? std::nullopt : std::optional{color}) ||
                    changed;
                changed =
                    state.clip.set_string(element, "background-clip",
                                          clip.empty() ? std::nullopt : std::optional{clip}) ||
                    changed;
                changed = state.opacity.set_string(element, "opacity",
                                                   clipped ? std::optional<Rml::String>{"0"}
                                                           : std::nullopt) ||
                          changed;
                changed = state.pointer_events.set_string(
                              element, "pointer-events",
                              clipped ? std::optional<Rml::String>{"none"} : std::nullopt) ||
                          changed;
                changed = state.display.set_string(element, "display",
                    shrink_to_fit ? std::optional<Rml::String>{
                        element.HasAttribute("hidden") ? "none" : "inline-block"} : std::nullopt) || changed;
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
