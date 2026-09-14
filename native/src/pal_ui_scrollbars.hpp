#pragma once

#include <RmlUi/Core.h>
#include <RmlUi/Core/ElementText.h>
#include <RmlUi/Core/ElementScroll.h>
#include <RmlUi/Core/PropertyDefinition.h>
#include <RmlUi/Core/StyleSheetSpecification.h>

namespace bbl::pal {

struct UiScrollbarProperties {
    Rml::PropertyId width, thumb, track;
};

inline UiScrollbarProperties register_ui_scrollbar_properties() {
    // Use RmlUi's cascade and inheritance, including unbound innerHTML nodes.
    const auto width = Rml::StyleSheetSpecification::RegisterProperty("scrollbar-width", "auto", false)
        .AddParser("keyword", "auto, thin, none").GetId();
    const auto color = [](const char* name) {
        return Rml::StyleSheetSpecification::RegisterProperty(name, "auto", true)
            .AddParser("keyword", "auto").AddParser("color").GetId();
    };
    const auto thumb = color("bbl-scrollbar-thumb-color"), track = color("bbl-scrollbar-track-color");
    Rml::StyleSheetSpecification::RegisterShorthand("scrollbar-color",
        "bbl-scrollbar-thumb-color, bbl-scrollbar-track-color", Rml::ShorthandType::Replicate);
    return {width, thumb, track};
}

inline bool sync_ui_scrollbar_styles(Rml::Element& document, const UiScrollbarProperties& properties) {
    bool changed = false;
    const auto sync = [&](Rml::Element& element) {
        const int width = element.GetProperty(properties.width)->Get<int>();
        const auto* thumb = element.GetProperty(properties.thumb);
        const auto* track = element.GetProperty(properties.track);
        const bool colored = thumb && track && thumb->unit == Rml::Unit::COLOUR && track->unit == Rml::Unit::COLOUR;
        const auto pseudo = [&](const Rml::String& name, bool active) {
            if (element.IsPseudoClassSet(name) != active) {
                element.SetPseudoClass(name, active);
                changed = true;
            }
        };
        static const Rml::String standard_name = "bbl-standard-scrollbar", thin_name = "bbl-thin-scrollbar",
            hidden_name = "bbl-hidden-scrollbar", colored_name = "bbl-colored-scrollbar",
            thumb_name = "--bbl-scrollbar-thumb", track_name = "--bbl-scrollbar-track";
        pseudo(standard_name, width != 0 || colored);
        pseudo(thin_name, width == 1);
        pseudo(hidden_name, width == 2);
        pseudo(colored_name, colored);
        const auto variable = [&](const Rml::String& name, const Rml::Property* color) {
            const auto* previous = element.GetLocalProperty(name);
            if (colored) {
                const auto value = color->ToString();
                if (!previous || previous->Get<Rml::String>() != value) {
                    element.SetProperty(name, value);
                    changed = true;
                }
            } else if (previous) {
                element.RemoveProperty(name);
                changed = true;
            }
        };
        variable(thumb_name, thumb);
        variable(track_name, track);
    };
    const auto visit = [&](const auto& self, Rml::Element& element) -> void {
        auto* scroll = element.GetElementScroll();
        if (scroll->GetScrollbar(Rml::ElementScroll::VERTICAL) ||
            scroll->GetScrollbar(Rml::ElementScroll::HORIZONTAL)) sync(element);
        // Internal controls inherit the variables but are not scroll owners.
        for (int index = 0; index < element.GetNumChildren(); ++index) {
            auto* child = element.GetChild(index);
            if (!rmlui_dynamic_cast<Rml::ElementText*>(child)) self(self, *child);
        }
    };
    visit(visit, document);
    return changed;
}

} // namespace bbl::pal
