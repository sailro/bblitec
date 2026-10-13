#pragma once

// A pinned body's `unknown`: the dynamic JSON value (`bbl::js::JsonValue`)
// a parsed document is, interrogated as the record lowerer
// (src/lowering/pinned-record-lowerer.ts) spells JavaScript's questions:
// truthiness, `typeof`, `Array.isArray`, `Object.keys`/`entries`,
// `hasOwnProperty`, the iteration methods of an array, and the reads a
// checker narrowed to a primitive, which assert the narrowing.

#include <bblite/js_json.hpp>
#include <bblite/pinned_values.hpp>

#include <cmath>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pinned {

[[nodiscard]] inline bool truthy(const js::JsonValue& value) { return value.truthy(); }

/** `value !== undefined && value !== null`. */
[[nodiscard]] inline bool truthy_object(const js::JsonValue& value) {
    return !value.is_undefined() && !value.is_null();
}

/** An error passed where `unknown` is taken: the dynamic value holding it. */
[[nodiscard]] inline js::JsonValue json_error(const js::Error& error) {
    const std::exception_ptr thrown = error;
    if (!thrown)
        return {};
    try {
        std::rethrow_exception(thrown);
    } catch (const ThrownValue& value) {
        return value.payload ? *std::static_pointer_cast<const js::JsonValue>(value.payload)
                             : js::JsonValue{};
    } catch (...) {
        return js::JsonValue::from_native(error);
    }
}

/** `value instanceof Error` over a dynamic value. */
[[nodiscard]] inline bool json_is_error(const js::JsonValue& value) {
    return value.instance_of<js::Error>();
}

/**
 * A dynamic value thrown or rejected with (`throw reason`): the error it
 * holds, or the value itself as a thrown non-Error.
 */
[[nodiscard]] inline js::Error error_of(const js::JsonValue& value) {
    if (json_is_error(value))
        return value.asserted_instance<js::Error>();
    return std::make_exception_ptr(
        ThrownValue(value.is_undefined() ? nullptr : std::make_shared<const js::JsonValue>(value)));
}

/** A template literal's substitution of a dynamic value: its ToString. */
[[nodiscard]] inline std::string template_part(const js::JsonValue& value) {
    return value.to_string();
}

/** A read the checker narrowed to `number` (`typeof x === "number"`, `x as number`). */
[[nodiscard]] inline double json_number(const js::JsonValue& value) {
    if (!value.is_number())
        throw std::logic_error("A pinned value narrowed to a number holds " + value.type_of() +
                               ".");
    return value.to_number();
}

[[nodiscard]] inline std::string json_string(const js::JsonValue& value) {
    if (!value.is_string())
        throw std::logic_error("A pinned value narrowed to a string holds " + value.type_of() +
                               ".");
    return value.string_value();
}

[[nodiscard]] inline bool json_boolean(const js::JsonValue& value) {
    if (!value.is_boolean())
        throw std::logic_error("A pinned value narrowed to a boolean holds " + value.type_of() +
                               ".");
    return value.truthy();
}

/** An array the pin asserted as an N-number tuple, as the number tuple it is. */
template <std::size_t N> [[nodiscard]] js::Tuple<N> json_tuple(const js::JsonValue& value) {
    if (!value.is_array() || value.length() != static_cast<double>(N))
        throw std::logic_error("A pinned value narrowed to a tuple is not one.");
    auto numbers = std::make_shared<std::vector<double>>();
    numbers->reserve(N);
    for (std::size_t index = 0; index < N; ++index)
        numbers->push_back(json_number(value.at(static_cast<double>(index))));
    return js::Tuple<N>(std::move(numbers));
}

[[nodiscard]] inline bool json_is_finite(const js::JsonValue& value) {
    return value.is_number() && std::isfinite(value.to_number());
}
[[nodiscard]] inline bool json_is_integer(const js::JsonValue& value) {
    return value.is_number() && js::number_is_integer(value.to_number());
}
[[nodiscard]] inline bool json_is_safe_integer(const js::JsonValue& value) {
    return value.is_number() && js::number_is_safe_integer(value.to_number());
}
[[nodiscard]] inline bool json_is_nan(const js::JsonValue& value) {
    return value.is_number() && std::isnan(value.to_number());
}

/** `Object.entries(value)`: its own enumerable keys and values, read once. */
[[nodiscard]] inline std::vector<std::pair<std::string, js::JsonValue>>
json_entries(const js::JsonValue& value) {
    std::vector<std::pair<std::string, js::JsonValue>> entries;
    for (const auto& key : value.own_keys())
        entries.emplace_back(key, value.get(key));
    return entries;
}

/** The parsed object a WeakMap or WeakSet keys; a primitive is a TypeError. */
[[nodiscard]] inline std::weak_ptr<const void> weak_key(const js::JsonValue& value) {
    auto identity = value.shared_identity();
    if (!identity)
        throw js::NamedError("TypeError", "Invalid value used as weak key");
    return identity;
}

[[noreturn]] inline void json_not_callable(std::string_view method) {
    throw js::NamedError("TypeError", std::string(method) + " is not a function");
}

/** A narrowed `any[]` holds an array; anything else has no such method. */
inline void json_require_array(const js::JsonValue& value, std::string_view method) {
    if (!value.is_array())
        json_not_callable(method);
}

/** The elements `for...of` visits over a narrowed `any[]`. */
[[nodiscard]] inline js::Array<js::JsonValue> json_iterated_array(const js::JsonValue& value) {
    json_require_array(value, "Symbol.iterator");
    return value.array_value();
}

template <class R, class F>
[[nodiscard]] js::Array<R> json_map(const js::JsonValue& value, F&& callback) {
    json_require_array(value, "map");
    const std::size_t length = static_cast<std::size_t>(value.length());
    std::vector<R> result;
    result.reserve(length);
    for (std::size_t index = 0; index < length; ++index)
        result.push_back(
            callback(value.at(static_cast<double>(index)), static_cast<double>(index)));
    return js::Array<R>(result.begin(), result.end());
}

template <class F> void json_for_each(const js::JsonValue& value, F&& callback) {
    json_require_array(value, "forEach");
    const std::size_t length = static_cast<std::size_t>(value.length());
    for (std::size_t index = 0; index < length; ++index)
        callback(value.at(static_cast<double>(index)), static_cast<double>(index));
}

template <class F> [[nodiscard]] bool json_every(const js::JsonValue& value, F&& callback) {
    json_require_array(value, "every");
    const std::size_t length = static_cast<std::size_t>(value.length());
    for (std::size_t index = 0; index < length; ++index)
        if (!truthy(callback(value.at(static_cast<double>(index)), static_cast<double>(index))))
            return false;
    return true;
}

template <class F> [[nodiscard]] bool json_some(const js::JsonValue& value, F&& callback) {
    json_require_array(value, "some");
    const std::size_t length = static_cast<std::size_t>(value.length());
    for (std::size_t index = 0; index < length; ++index)
        if (truthy(callback(value.at(static_cast<double>(index)), static_cast<double>(index))))
            return true;
    return false;
}

} // namespace bbl::pinned
