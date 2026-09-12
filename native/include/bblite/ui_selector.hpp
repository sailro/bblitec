#pragma once

#include <bblite/ui_selector_match.hpp>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementText.h>

namespace bbl::pal {
inline bool ui_selector_uses_test(const std::vector<UiSelectorStep>& steps, UiSelectorTestKind kind) {
    for (const auto& step : steps) for (const auto& test : step.tests) {
        if (test.kind == kind) return true;
        for (const auto& alternative : test.alternatives) if (ui_selector_uses_test(alternative, kind)) return true;
    }
    return false;
}

inline std::uint32_t ui_selector_sequence_specificity(const std::vector<UiSelectorStep>& steps) {
    std::uint32_t result = 0;
    for (const auto& step : steps) for (const auto& test : step.tests) {
        if (test.kind == UiSelectorTestKind::Where) continue;
        if (test.kind == UiSelectorTestKind::Not || test.kind == UiSelectorTestKind::Is || test.kind == UiSelectorTestKind::Has) {
            std::uint32_t alternative = 0;
            for (const auto& sequence : test.alternatives) alternative = std::max(alternative, ui_selector_sequence_specificity(sequence));
            result += alternative;
        } else result += test.kind == UiSelectorTestKind::Id ? 0x10000u : test.kind == UiSelectorTestKind::Tag ? 1u : 0x100u;
    }
    return result;
}

struct RmlUiSelectorTree {
    using Node = Rml::Element*;
    bool valid(Node node) const { return node != nullptr; }
    bool element(Node node) const { return node && node->GetPseudoElement() == Rml::Element::PseudoElement::None && node->GetTagName() != "#text"; }
    std::string_view tag(Node node) const { return node->GetTagName(); }
    Node parent(Node node) const { return node->GetParentNode(); }
    std::size_t child_count(Node node) const { return static_cast<std::size_t>(node->GetNumChildren()); }
    Node child(Node node, std::size_t index) const { return node->GetChild(static_cast<int>(index)); }
    std::optional<std::string> attribute(Node node, const std::string& name) const {
        const auto* value = node->GetAttribute(name);
        return value ? std::optional<std::string>{value->Get<Rml::String>()} : std::nullopt;
    }
    bool has_class(Node node, const std::string& name) const { return node->IsClassSet(name); }
    bool empty(Node node) const {
        for (int index = 0; index < node->GetNumChildren(); ++index) {
            auto* candidate = node->GetChild(index);
            if (candidate->GetPseudoElement() != Rml::Element::PseudoElement::None) continue;
            const auto* text = rmlui_dynamic_cast<Rml::ElementText*>(candidate);
            if (!text || !text->GetText().empty()) return false;
        }
        return true;
    }
    bool state(Node node, UiSelectorTestKind kind) const {
        switch (kind) {
        case UiSelectorTestKind::Hover: return node->IsPseudoClassSet("hover");
        case UiSelectorTestKind::Active: return node->IsPseudoClassSet("active");
        case UiSelectorTestKind::Focus: return node->IsPseudoClassSet("focus");
        case UiSelectorTestKind::FocusVisible: return node->IsPseudoClassSet("focus-visible");
        case UiSelectorTestKind::FocusWithin: return node->IsPseudoClassSet("focus-within");
        case UiSelectorTestKind::Disabled: return node->IsPseudoClassSet("disabled");
        case UiSelectorTestKind::Checked: return node->IsPseudoClassSet("checked");
        default: throw std::logic_error("Invalid compiled UI selector state.");
        }
    }
};

/** Match compiled terms on RmlUi's live tree without parsing during layout. */
inline bool ui_selector_sequence_matches(Rml::Element* element, const std::vector<UiSelectorStep>& steps) {
    const RmlUiSelectorTree tree;
    return UiSelectorMatcher{tree}.sequence(element, steps);
}

} // namespace bbl::pal
