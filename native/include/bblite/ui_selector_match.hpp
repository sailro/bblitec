#pragma once

#include <bblite/runtime.hpp>
#include <algorithm>

namespace bbl::pal {

/** Shared selector traversal for authored records and RmlUi's rendered tree.
 * The tree adapter owns attributes, interaction state and text-node identity.
 */
template<class Tree> class UiSelectorMatcher {
    using Node = typename Tree::Node;
    const Tree& tree;

    bool position(Node element, const UiSelectorTest& test) const {
        const auto parent = tree.parent(element);
        if (!tree.valid(parent)) return false;
        const bool of_type = test.kind == UiSelectorTestKind::NthOfType || test.kind == UiSelectorTestKind::NthLastOfType || test.kind == UiSelectorTestKind::OnlyOfType;
        std::int64_t index = 0, count = 0;
        for (std::size_t child = 0; child < tree.child_count(parent); ++child) {
            const auto candidate = tree.child(parent, child);
            if (!tree.element(candidate) || (of_type && tree.tag(candidate) != tree.tag(element))) continue;
            ++count;
            if (candidate == element) index = count;
        }
        if (!index) return false;
        if (test.kind == UiSelectorTestKind::OnlyChild || test.kind == UiSelectorTestKind::OnlyOfType) return count == 1;
        if (test.kind == UiSelectorTestKind::NthLastChild || test.kind == UiSelectorTestKind::NthLastOfType) index = count - index + 1;
        const auto delta = index - test.b;
        return test.a == 0 ? delta == 0 : delta % test.a == 0 && delta / test.a >= 0;
    }

    bool compound(Node element, const UiSelectorStep& step) const {
        return tree.element(element) && std::all_of(step.tests.begin(), step.tests.end(), [&](const auto& test) { return matches(element, test); });
    }

public:
    explicit UiSelectorMatcher(const Tree& source) : tree(source) {}

    bool matches(Node element, const UiSelectorTest& test) const {
        switch (test.kind) {
        case UiSelectorTestKind::Tag: return tree.tag(element) == test.name;
        case UiSelectorTestKind::Id: return tree.attribute(element, "id") == std::optional<std::string_view>{test.name};
        case UiSelectorTestKind::Class: return tree.has_class(element, test.name);
        case UiSelectorTestKind::Attribute: return tree.attribute(element, test.name).has_value();
        case UiSelectorTestKind::Equals: return tree.attribute(element, test.name) == std::optional<std::string_view>{test.value};
        case UiSelectorTestKind::Empty: return tree.empty(element);
        case UiSelectorTestKind::NthChild: case UiSelectorTestKind::NthLastChild:
        case UiSelectorTestKind::NthOfType: case UiSelectorTestKind::NthLastOfType:
        case UiSelectorTestKind::OnlyChild: case UiSelectorTestKind::OnlyOfType: return position(element, test);
        case UiSelectorTestKind::Not: case UiSelectorTestKind::Is: case UiSelectorTestKind::Where: case UiSelectorTestKind::Has: {
            if (test.alternatives.empty()) throw std::logic_error("A compiled selector function needs alternatives.");
            const bool found = std::any_of(test.alternatives.begin(), test.alternatives.end(), [&](const auto& steps) {
                return test.kind == UiSelectorTestKind::Has ? relative(element, steps) : sequence(element, steps);
            });
            return test.kind == UiSelectorTestKind::Not ? !found : found;
        }
        default: return tree.state(element, test.kind);
        }
    }

    bool sequence(Node element, const std::vector<UiSelectorStep>& steps) const {
        if (steps.empty()) throw std::logic_error("A selector sequence must contain a compound.");
        const auto visit = [&](const auto& self, Node current, std::size_t index) -> bool {
            const auto& step = steps[index];
            if (!compound(current, step)) return false;
            if (index == 0) return true;
            if (step.relation == UiSelectorRelation::Child || step.relation == UiSelectorRelation::Descendant) {
                for (auto parent = tree.parent(current); tree.valid(parent); parent = tree.parent(parent)) {
                    if (self(self, parent, index - 1)) return true;
                    if (step.relation == UiSelectorRelation::Child) break;
                }
            } else if (step.relation == UiSelectorRelation::Next || step.relation == UiSelectorRelation::Following) {
                const auto parent = tree.parent(current);
                if (!tree.valid(parent)) return false;
                Node previous{};
                for (std::size_t child = 0; child < tree.child_count(parent); ++child) {
                    const auto candidate = tree.child(parent, child);
                    if (candidate == current) break;
                    if (!tree.element(candidate)) continue;
                    if (step.relation == UiSelectorRelation::Following && self(self, candidate, index - 1)) return true;
                    previous = candidate;
                }
                if (step.relation == UiSelectorRelation::Next) return self(self, previous, index - 1);
            } else throw std::logic_error("A noninitial selector compound needs a combinator.");
            return false;
        };
        return visit(visit, element, steps.size() - 1);
    }

    bool relative(Node origin, const std::vector<UiSelectorStep>& steps) const {
        if (steps.empty()) throw std::logic_error("A relative selector needs a compound.");
        const auto visit = [&](const auto& self, Node current, std::size_t index) -> bool {
            const auto& step = steps[index];
            const auto accept = [&](Node candidate) {
                return compound(candidate, step) && (index + 1 == steps.size() || self(self, candidate, index + 1));
            };
            if (step.relation == UiSelectorRelation::Child || step.relation == UiSelectorRelation::Descendant) {
                const auto descendants = [&](const auto& recurse, Node parent) -> bool {
                    for (std::size_t child = 0; child < tree.child_count(parent); ++child) {
                        const auto candidate = tree.child(parent, child);
                        if (!tree.element(candidate)) continue;
                        if (accept(candidate) || (step.relation == UiSelectorRelation::Descendant && recurse(recurse, candidate))) return true;
                    }
                    return false;
                };
                return descendants(descendants, current);
            }
            if (step.relation == UiSelectorRelation::Next || step.relation == UiSelectorRelation::Following) {
                const auto parent = tree.parent(current);
                if (!tree.valid(parent)) return false;
                bool following = false;
                for (std::size_t child = 0; child < tree.child_count(parent); ++child) {
                    const auto candidate = tree.child(parent, child);
                    if (candidate == current) { following = true; continue; }
                    if (!following || !tree.element(candidate)) continue;
                    if (accept(candidate)) return true;
                    if (step.relation == UiSelectorRelation::Next) break;
                }
                return false;
            }
            throw std::logic_error("A relative selector requires a combinator.");
        };
        return visit(visit, origin, 0);
    }
};

} // namespace bbl::pal
