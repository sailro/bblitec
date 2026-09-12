#pragma once

#include <bblite/runtime.hpp>
#include <RmlUi/Core/Element.h>

namespace bbl::pal {

inline bool ui_selector_test_matches(Rml::Element& element, const UiSelectorTest& test) {
    switch (test.kind) {
    case UiSelectorTestKind::Tag: return element.GetTagName() == test.name;
    case UiSelectorTestKind::Id: return element.GetId() == test.name;
    case UiSelectorTestKind::Class: return element.IsClassSet(test.name);
    case UiSelectorTestKind::Attribute: return element.HasAttribute(test.name);
    case UiSelectorTestKind::Equals: {
        const auto* attribute = element.GetAttribute(test.name);
        return attribute && attribute->Get<Rml::String>() == test.value;
    }
    case UiSelectorTestKind::Hover: return element.IsPseudoClassSet("hover");
    case UiSelectorTestKind::Active: return element.IsPseudoClassSet("active");
    case UiSelectorTestKind::Focus: return element.IsPseudoClassSet("focus");
    case UiSelectorTestKind::FocusVisible: return element.IsPseudoClassSet("focus-visible");
    case UiSelectorTestKind::Disabled: return element.IsPseudoClassSet("disabled");
    case UiSelectorTestKind::Checked: return element.IsPseudoClassSet("checked");
    }
    throw std::logic_error("Invalid compiled UI selector test.");
}

/** Match compiled terms on the same live tree used by RmlUi's public cascade.
 * No selector parsing or source callbacks occur during a layout update. */
inline bool ui_selector_sequence_matches(Rml::Element* element, const std::vector<UiSelectorStep>& steps) {
    if (steps.empty()) throw std::logic_error("A selector sequence must contain a compound.");
    const auto match = [&](const auto& self, Rml::Element* current, std::size_t index) -> bool {
        if (!current || current->GetTagName() == "#text") return false;
        const auto& step = steps[index];
        for (const auto& test : step.tests) if (!ui_selector_test_matches(*current, test)) return false;
        if (index == 0) return true;
        if (step.relation == UiSelectorRelation::Child || step.relation == UiSelectorRelation::Descendant) {
            for (auto* parent = current->GetParentNode(); parent; parent = parent->GetParentNode()) {
                if (self(self, parent, index - 1)) return true;
                if (step.relation == UiSelectorRelation::Child) break;
            }
        } else if (step.relation == UiSelectorRelation::Next || step.relation == UiSelectorRelation::Following) {
            auto* parent = current->GetParentNode();
            if (!parent) return false;
            Rml::Element* previous = nullptr;
            for (int sibling = 0; sibling < parent->GetNumChildren(); ++sibling) {
                auto* candidate = parent->GetChild(sibling);
                if (candidate == current) break;
                if (candidate->GetTagName() == "#text") continue;
                if (step.relation == UiSelectorRelation::Following && self(self, candidate, index - 1)) return true;
                previous = candidate;
            }
            if (step.relation == UiSelectorRelation::Next) return self(self, previous, index - 1);
        } else throw std::logic_error("A noninitial selector compound needs a combinator.");
        return false;
    };
    return match(match, element, steps.size() - 1);
}

} // namespace bbl::pal
