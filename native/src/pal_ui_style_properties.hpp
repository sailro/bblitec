#pragma once

#include <RmlUi/Core/PropertyDefinition.h>
#include <RmlUi/Core/StyleSheetSpecification.h>

namespace bbl::pal {

inline void register_ui_style_properties() {
    Rml::StyleSheetSpecification::RegisterProperty("appearance", "auto", false)
        .AddParser("keyword", "auto, none");
    Rml::StyleSheetSpecification::RegisterShorthand("-webkit-appearance", "appearance",
                                                    Rml::ShorthandType::Replicate);
    // The retained box formatter uses horizontal left-to-right layout. Logical
    // spacing shares its physical properties, including cascade and removal.
    for (const Rml::String family : {"padding", "margin"}) {
        const auto shorthand = [&](const char* suffix, const Rml::String& properties) {
            Rml::StyleSheetSpecification::RegisterShorthand(family + suffix, properties,
                                                            Rml::ShorthandType::Replicate);
        };
        shorthand("-inline", family + "-left, " + family + "-right");
        shorthand("-block", family + "-top, " + family + "-bottom");
        shorthand("-inline-start", family + "-left");
        shorthand("-inline-end", family + "-right");
        shorthand("-block-start", family + "-top");
        shorthand("-block-end", family + "-bottom");
    }
}

} // namespace bbl::pal
