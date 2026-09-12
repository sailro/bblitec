#pragma once

#include <bblite/runtime.hpp>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementText.h>
#include <algorithm>

namespace bbl::pal {

inline bool ui_selector_sequence_matches(Rml::Element* element, const std::vector<UiSelectorStep>& steps);
inline bool ui_relative_selector_matches(Rml::Element& origin, const std::vector<UiSelectorStep>& steps);

inline bool ui_selector_uses_test(const std::vector<UiSelectorStep>& steps, UiSelectorTestKind kind) {
    for (const auto& step : steps) for (const auto& test : step.tests) {
        if (test.kind == kind) return true;
        for (const auto& alternative : test.alternatives) if (ui_selector_uses_test(alternative, kind)) return true;
    }
    return false;
}

inline bool ui_selector_position_matches(Rml::Element& element, const UiSelectorTest& test) {
    auto* parent = element.GetParentNode();
    if (!parent) return false;
    const bool of_type = test.kind == UiSelectorTestKind::NthOfType || test.kind == UiSelectorTestKind::NthLastOfType || test.kind == UiSelectorTestKind::OnlyOfType;
    std::int64_t position = 0, count = 0;
    for (int index = 0; index < parent->GetNumChildren(); ++index) {
        auto* child = parent->GetChild(index);
        if (child->GetPseudoElement() != Rml::Element::PseudoElement::None || child->GetTagName() == "#text" || (of_type && child->GetTagName() != element.GetTagName())) continue;
        ++count;
        if (child == &element) position = count;
    }
    if (!position) return false;
    if (test.kind == UiSelectorTestKind::OnlyChild || test.kind == UiSelectorTestKind::OnlyOfType) return count == 1;
    if (test.kind == UiSelectorTestKind::NthLastChild || test.kind == UiSelectorTestKind::NthLastOfType) position = count - position + 1;
    const auto delta = position - test.b;
    return test.a == 0 ? delta == 0 : delta % test.a == 0 && delta / test.a >= 0;
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
    case UiSelectorTestKind::FocusWithin: return element.IsPseudoClassSet("focus-within");
    case UiSelectorTestKind::Disabled: return element.IsPseudoClassSet("disabled");
    case UiSelectorTestKind::Checked: return element.IsPseudoClassSet("checked");
    case UiSelectorTestKind::Empty:
        for (int index = 0; index < element.GetNumChildren(); ++index) {
            auto* child = element.GetChild(index);
            if (child->GetPseudoElement() != Rml::Element::PseudoElement::None) continue;
            const auto* text = rmlui_dynamic_cast<Rml::ElementText*>(child);
            if (!text || !text->GetText().empty()) return false;
        }
        return true;
    case UiSelectorTestKind::NthChild: case UiSelectorTestKind::NthLastChild:
    case UiSelectorTestKind::NthOfType: case UiSelectorTestKind::NthLastOfType:
    case UiSelectorTestKind::OnlyChild: case UiSelectorTestKind::OnlyOfType:
        return ui_selector_position_matches(element, test);
    case UiSelectorTestKind::Not: case UiSelectorTestKind::Is: case UiSelectorTestKind::Where: case UiSelectorTestKind::Has: {
        if (test.alternatives.empty()) throw std::logic_error("A compiled selector function needs alternatives.");
        const bool matched = std::any_of(test.alternatives.begin(), test.alternatives.end(), [&](const auto& sequence) {
            return test.kind == UiSelectorTestKind::Has ? ui_relative_selector_matches(element, sequence) : ui_selector_sequence_matches(&element, sequence);
        });
        return test.kind == UiSelectorTestKind::Not ? !matched : matched;
    }
    }
    throw std::logic_error("Invalid compiled UI selector test.");
}

/** Follow relative combinators forward from :has()'s originating element. */
inline bool ui_relative_selector_matches(Rml::Element& origin, const std::vector<UiSelectorStep>& steps) {
    if (steps.empty()) throw std::logic_error("A relative selector needs a compound.");
    const auto match = [&](const auto& self, Rml::Element& current, std::size_t index) -> bool {
        const auto& step = steps[index];
        const auto accept = [&](Rml::Element& candidate) {
            if (!std::all_of(step.tests.begin(), step.tests.end(), [&](const auto& test) { return ui_selector_test_matches(candidate,test); })) return false;
            return index + 1 == steps.size() || self(self,candidate,index + 1);
        };
        const auto authored = [](const Rml::Element& candidate) {
            return candidate.GetPseudoElement() == Rml::Element::PseudoElement::None && candidate.GetTagName() != "#text";
        };
        if (step.relation == UiSelectorRelation::Child || step.relation == UiSelectorRelation::Descendant) {
            const auto visit = [&](const auto& recurse, Rml::Element& parent) -> bool {
                for (int child = 0; child < parent.GetNumChildren(); ++child) {
                    auto& candidate = *parent.GetChild(child);
                    if (!authored(candidate)) continue;
                    if (accept(candidate) || (step.relation == UiSelectorRelation::Descendant && recurse(recurse,candidate))) return true;
                }
                return false;
            };
            return visit(visit,current);
        }
        if (step.relation == UiSelectorRelation::Next || step.relation == UiSelectorRelation::Following) {
            auto* parent = current.GetParentNode();
            if (!parent) return false;
            bool following = false;
            for (int child = 0; child < parent->GetNumChildren(); ++child) {
                auto& candidate = *parent->GetChild(child);
                if (&candidate == &current) { following = true; continue; }
                if (!following || !authored(candidate)) continue;
                if (accept(candidate)) return true;
                if (step.relation == UiSelectorRelation::Next) break;
            }
            return false;
        }
        throw std::logic_error("A relative selector requires a combinator.");
    };
    return match(match,origin,0);
}

/** Match compiled terms on the same live tree used by RmlUi's public cascade.
 * No selector parsing or source callbacks occur during a layout update. */
inline bool ui_selector_sequence_matches(Rml::Element* element, const std::vector<UiSelectorStep>& steps) {
    if (steps.empty()) throw std::logic_error("A selector sequence must contain a compound.");
    const auto match = [&](const auto& self, Rml::Element* current, std::size_t index) -> bool {
        if (!current || current->GetPseudoElement() != Rml::Element::PseudoElement::None || current->GetTagName() == "#text") return false;
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
                if (candidate->GetPseudoElement() != Rml::Element::PseudoElement::None || candidate->GetTagName() == "#text") continue;
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
