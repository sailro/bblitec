#pragma once

#include <bblite/js_gc.hpp>
#include <optional>
#include <stdexcept>
#include <utility>

namespace bbl::js {

/** A closure can capture a lexical binding before its initializer completes.
 * Reads remain in the temporal dead zone until initialization succeeds. */
template <typename T>
class LexicalBinding {
public:
    void initialize(T value) {
        if (value_) throw std::logic_error("A lexical binding was initialized twice.");
        value_.emplace(std::move(value));
    }
    T& get() {
        if (!value_) throw std::runtime_error("Cannot access a lexical binding before initialization.");
        return *value_;
    }
    const T& get() const {
        if (!value_) throw std::runtime_error("Cannot access a lexical binding before initialization.");
        return *value_;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(value_); }
private:
    std::optional<T> value_;
};

} // namespace bbl::js
