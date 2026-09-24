#pragma once

// JavaScript semantics the record lowerer (src/lowering/pinned-record-lowerer.ts)
// spells over the runtime's containers: absence as null handles and empty
// optionals, lazy `??`, Array/TypedArray reads past the end and a stable
// comparator sort. Closures are `js::Callback`s over environment structs,
// whose captured bindings a closure may read before their declaration are
// `js::LexicalBinding`s.

#include <bblite/js_binding.hpp>
#include <bblite/js_data.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>

namespace bbl::pinned {

/** A JavaScript object the pin keeps only for its identity (`{}`). */
struct PlainObject {};

template <class T> struct IsOptional : std::false_type {};
template <class T> struct IsOptional<std::optional<T>> : std::true_type {};

/** `x !== undefined && x !== null`: presence of an optional or a handle. */
template <class T> [[nodiscard]] bool truthy_object(const T& value) {
    if constexpr (IsOptional<T>::value)
        return value.has_value();
    else
        return static_cast<bool>(value);
}

/** JavaScript truthiness of a lowered value. */
[[nodiscard]] inline bool truthy(double value) { return js::number_truthy(value); }
[[nodiscard]] inline bool truthy(bool value) { return value; }
[[nodiscard]] inline bool truthy(const std::string& value) { return !value.empty(); }
/** Every other value is an object, and an object is truthy. */
template <class T>
    requires(std::is_class_v<T> && !IsOptional<T>::value)
[[nodiscard]] bool truthy(const T&) {
    return true;
}
template <class T> [[nodiscard]] bool truthy(const std::optional<T>& value) {
    return value.has_value() && truthy(*value);
}
template <class T> [[nodiscard]] bool truthy(const std::shared_ptr<T>& value) {
    return static_cast<bool>(value);
}
template <class R, class... A> [[nodiscard]] bool truthy(const std::function<R(A...)>& value) {
    return static_cast<bool>(value);
}
template <class R, class... A> [[nodiscard]] bool truthy(const js::Callback<R(A...)>& value) {
    return static_cast<bool>(value);
}

/** A value the pin proved present (`x!`, a guarded optional). */
template <class T> [[nodiscard]] T& present(std::optional<T>& value) {
    if (!value)
        throw std::runtime_error("Pinned value read while absent.");
    return *value;
}
template <class T> [[nodiscard]] const T& present(const std::optional<T>& value) {
    if (!value)
        throw std::runtime_error("Pinned value read while absent.");
    return *value;
}

/** `left ?? right`, with `right` evaluated only when `left` is absent. */
template <class R, class L, class F> [[nodiscard]] R nullish(const L& left, F right) {
    if constexpr (IsOptional<L>::value)
        return left.has_value() ? R(*left) : R(right());
    else
        return left ? R(left) : R(right());
}

/** `slot ??= make()`, yielding the slot's value. */
template <class L, class F> decltype(auto) nullish_assign(L& slot, F make) {
    if constexpr (IsOptional<L>::value) {
        if (!slot.has_value())
            slot = make();
        return (*slot);
    } else {
        if (!slot)
            slot = make();
        return (slot);
    }
}

template <class T> struct AbsentAsNull : std::false_type {};
template <class T> struct AbsentAsNull<std::shared_ptr<T>> : std::true_type {};
template <class R, class... A> struct AbsentAsNull<std::function<R(A...)>> : std::true_type {};
template <class R, class... A> struct AbsentAsNull<js::Callback<R(A...)>> : std::true_type {};

/** `map.get(key)`: null for an absent handle, an empty optional otherwise. */
template <class K, class V, class Q>
[[nodiscard]] auto map_get(const js::Map<K, V>& map, const Q& key) {
    const auto found = map.get(K(key));
    if constexpr (AbsentAsNull<V>::value)
        return found.has_value() ? V(*found) : V{};
    else
        return found.has_value() ? std::optional<V>(*found) : std::optional<V>{};
}

/** WeakMap reads and writes keyed by an object handle's identity. */
template <class V, class K>
[[nodiscard]] auto weak_get(const js::WeakMap<V>& map, const std::shared_ptr<K>& key) {
    const auto found = map.get(std::weak_ptr<const void>(key));
    if constexpr (AbsentAsNull<V>::value)
        return found.has_value() ? V(*found) : V{};
    else
        return found.has_value() ? std::optional<V>(*found) : std::optional<V>{};
}
template <class V, class K>
[[nodiscard]] bool weak_has(const js::WeakMap<V>& map, const std::shared_ptr<K>& key) {
    return map.get(std::weak_ptr<const void>(key)).has_value();
}
template <class V, class K>
js::WeakMap<V>& weak_set(js::WeakMap<V>& map, const std::shared_ptr<K>& key, const V& value) {
    return map.set(std::weak_ptr<const void>(key), value);
}
template <class V, class K> bool weak_delete(js::WeakMap<V>& map, const std::shared_ptr<K>& key) {
    return map.erase(std::weak_ptr<const void>(key));
}

/** `new Array(length)` and friends: a JavaScript array length or index. */
[[nodiscard]] inline std::size_t array_length(double value) {
    if (!(value >= 0.0 && value <= 4294967295.0) || std::trunc(value) != value)
        throw std::runtime_error("RangeError: invalid array length.");
    return static_cast<std::size_t>(value);
}

/** `array.pop()`: the removed element, absent on an empty array. */
template <class T> [[nodiscard]] auto array_pop(js::Array<T>& values) {
    if constexpr (AbsentAsNull<T>::value) {
        if (values.empty())
            return T{};
        T last = values.back();
        values.pop_back();
        return last;
    } else {
        if (values.empty())
            return std::optional<T>{};
        std::optional<T> last(values.back());
        values.pop_back();
        return last;
    }
}

/** `array.sort(compare)`: the specified sort is stable over the comparator's sign. */
template <class T, class Compare>
js::Array<T>& array_sort(js::Array<T>& values, const Compare& compare) {
    std::stable_sort(values.begin(), values.end(),
                     [&](const T& a, const T& b) { return compare(a, b) < 0.0; });
    return values;
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

/** `target.set(source, offset)` between typed arrays of one element type. */
template <class T>
void typed_set(js::TypedArray<T>& target, const js::TypedArray<T>& source, double offset = 0.0) {
    const auto at = array_length(offset);
    if (at > target.size() || source.size() > target.size() - at)
        throw std::runtime_error("RangeError: typed array set exceeds its target.");
    if (source.size() == 0)
        return;
    auto to = target.buffer();
    const auto from = source.buffer();
    std::memmove(to.data() + target.byte_offset() + at * sizeof(T),
                 from.data() + source.byte_offset(), source.size() * sizeof(T));
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
