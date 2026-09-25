#pragma once

// JavaScript semantics the record lowerer (src/lowering/pinned-record-lowerer.ts)
// spells over the runtime's containers: absence as null handles and empty
// nullable values, lazy `??`, Array/TypedArray reads past the end and a stable
// comparator sort. Closures are `js::Callback`s over environment structs,
// whose captured bindings a closure may read before their declaration are
// `js::LexicalBinding`s.

#include <bblite/js_binding.hpp>
#include <bblite/js_data.hpp>

#include <algorithm>
#include <cmath>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>

namespace bbl::pinned {

/** A JavaScript object the pin keeps only for its identity (`{}`). */
struct PlainObject {};

/** `x !== undefined && x !== null`: presence of an optional or a handle. */
template <class T> [[nodiscard]] bool truthy_object(const T& value) {
    return static_cast<bool>(value);
}

/** JavaScript truthiness of a lowered value. */
[[nodiscard]] inline bool truthy(double value) { return js::number_truthy(value); }
[[nodiscard]] inline bool truthy(bool value) { return value; }
[[nodiscard]] inline bool truthy(const std::string& value) { return !value.empty(); }
/** Every other value is an object, and an object is truthy. */
template <class T>
    requires(std::is_class_v<T> && !js::IsNullable<T>::value)
[[nodiscard]] bool truthy(const T&) {
    return true;
}
template <class T> [[nodiscard]] bool truthy(const std::shared_ptr<T>& value) {
    return static_cast<bool>(value);
}
template <class T> [[nodiscard]] bool truthy(const js::Ref<T>& value) {
    return static_cast<bool>(value);
}
template <class T> [[nodiscard]] bool truthy(const std::weak_ptr<T>& value) {
    return !value.expired();
}
template <class R, class... A> [[nodiscard]] bool truthy(const std::function<R(A...)>& value) {
    return static_cast<bool>(value);
}
template <class R, class... A> [[nodiscard]] bool truthy(const js::Callback<R(A...)>& value) {
    return static_cast<bool>(value);
}
template <class T> [[nodiscard]] bool truthy(const js::Nullable<T>& value) {
    return value.has_value() && truthy(*value);
}

/** A value the pin proved present (`x!`, a guarded optional). */
template <class T> [[nodiscard]] T& present(js::Nullable<T>& value) { return value.value(); }
template <class T> [[nodiscard]] const T& present(const js::Nullable<T>& value) {
    return value.value();
}

/** `left ?? right`, with `right` evaluated only when `left` is absent. */
template <class R, class L, class F> [[nodiscard]] R nullish(const L& left, F right) {
    if constexpr (js::IsNullable<L>::value)
        return left.has_value() ? R(*left) : R(right());
    else
        return left ? R(left) : R(right());
}

/** `slot ??= make()`, yielding the slot's value. */
template <class L, class F> decltype(auto) nullish_assign(L& slot, F make) {
    if constexpr (js::IsNullable<L>::value) {
        if (!slot.has_value())
            slot = make();
        return (*slot);
    } else {
        if (!slot)
            slot = make();
        return (slot);
    }
}

/** `new Array(length)` and friends: a JavaScript array length or index. */
[[nodiscard]] inline std::size_t array_length(double value) {
    if (!(value >= 0.0 && value <= 4294967295.0) || std::trunc(value) != value)
        throw std::runtime_error("RangeError: invalid array length.");
    return static_cast<std::size_t>(value);
}

/** `array.sort(compare)`: the specified sort is stable over the comparator's sign. */
template <class T, class Compare>
js::Array<T>& array_sort(js::Array<T>& values, const Compare& compare) {
    std::stable_sort(values.begin(), values.end(),
                     [&](const T& a, const T& b) { return compare(a, b) < 0.0; });
    return values;
}

/** A value element read the pin may find absent: past the end is `undefined`. */
template <class T>
[[nodiscard]] js::Nullable<T> array_at_optional(const js::Array<T>& values, double index) {
    return js::array_has_index(values, index)
               ? js::Nullable<T>(values[static_cast<std::size_t>(index)])
               : js::Nullable<T>{};
}

/** A numeric array read: an absent element is `undefined`, NaN as a number. */
[[nodiscard]] inline double number_at(const js::Array<double>& values, double index) {
    return js::array_has_index(values, index) ? values[static_cast<std::size_t>(index)]
                                              : std::numeric_limits<double>::quiet_NaN();
}

/** A typed-array read, including views; past the end reads NaN. */
template <class T> [[nodiscard]] double typed_get(const js::TypedArray<T>& values, double index) {
    return js::array_has_index(values, index)
               ? static_cast<double>(values.load(static_cast<std::size_t>(index)))
               : std::numeric_limits<double>::quiet_NaN();
}

/** `typed.fill(value)`: every element, stored as its element type stores it. */
template <class T> js::TypedArray<T>& typed_fill(js::TypedArray<T>& values, double value) {
    for (std::size_t index = 0; index < values.size(); ++index)
        js::typed_array_write(values, static_cast<double>(index), value);
    return values;
}

/** A tuple read; past the end reads NaN. */
template <std::size_t N> [[nodiscard]] double tuple_at(const js::Tuple<N>& values, double index) {
    if (!js::array_has_index(values, index))
        return std::numeric_limits<double>::quiet_NaN();
    return values[static_cast<std::size_t>(index)];
}

inline void console_part(std::string& line, const std::string& value) { line += value; }
inline void console_part(std::string& line, const char* value) { line += value; }
inline void console_part(std::string& line, double value) { line += js::number_to_string(value); }

/** `console.error/warn(...)`: the arguments' string forms, space separated, on stderr. */
template <class... Parts> void console_line(const Parts&... parts) {
    std::string line;
    bool first = true;
    ((line += first ? "" : " ", first = false, console_part(line, parts)), ...);
    std::cerr << line << '\n';
}

} // namespace bbl::pinned
