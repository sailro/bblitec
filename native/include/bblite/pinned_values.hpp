#pragma once

// JavaScript semantics the record lowerer (src/lowering/pinned-record-lowerer.ts)
// spells beyond the plain records of `pinned_records.hpp`: the iteration
// methods of arrays over callbacks the pin passes inline, spreads, a
// read-only `ArrayLike<number>` over any number list, and the library
// predicates a pin passes as values. Included by lowered code that reaches
// them.

#include <bblite/pinned_records.hpp>

#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pinned {

/**
 * `ArrayLike<number>`: what the pin indexes a typed array, tuple or array
 * through. A view retains the list it reads (copies of the runtime's
 * containers share their storage), so a read is the list's current element;
 * past the end reads NaN, as `undefined` converts.
 */
class NumberArrayLike {
public:
    NumberArrayLike() = default;
    template <class T>
    NumberArrayLike(const js::TypedArray<T>& values)
        : owner_(std::make_shared<js::TypedArray<T>>(values)), size_([](const void* list) {
              return static_cast<const js::TypedArray<T>*>(list)->size();
          }),
          load_([](const void* list, std::size_t index) {
              return static_cast<double>(static_cast<const js::TypedArray<T>*>(list)->load(index));
          }) {}
    template <std::size_t N>
    NumberArrayLike(const js::Tuple<N>& values)
        : owner_(std::make_shared<js::Tuple<N>>(values)), size_([](const void*) { return N; }),
          load_([](const void* list, std::size_t index) {
              return (*static_cast<const js::Tuple<N>*>(list))[index];
          }) {}
    NumberArrayLike(const js::Array<double>& values)
        : owner_(std::make_shared<js::Array<double>>(values)), size_([](const void* list) {
              return static_cast<const js::Array<double>*>(list)->size();
          }),
          load_([](const void* list, std::size_t index) {
              return (*static_cast<const js::Array<double>*>(list))[index];
          }) {}

    [[nodiscard]] std::size_t size() const { return owner_ ? size_(owner_.get()) : 0; }
    [[nodiscard]] double at(double index) const {
        if (!js::array_has_index(*this, index))
            return std::numeric_limits<double>::quiet_NaN();
        return load_(owner_.get(), static_cast<std::size_t>(index));
    }

private:
    std::shared_ptr<const void> owner_;
    std::size_t (*size_)(const void*) = nullptr;
    double (*load_)(const void*, std::size_t) = nullptr;
};

// ── Thrown values ─────────────────────────────────────────────────────

/**
 * A thrown value that is not an Error (`throw reason` of a dynamic value,
 * or `reject(undefined)`), carried as its own exception. `payload` is the
 * dynamic value (`js::JsonValue`, see `pinned_json.hpp`); null is
 * `undefined`.
 */
struct ThrownValue final : std::exception {
    explicit ThrownValue(std::shared_ptr<const void> value = {}) : payload(std::move(value)) {}
    [[nodiscard]] const char* what() const noexcept override { return "Uncaught non-Error value"; }
    std::shared_ptr<const void> payload;
};

/** `error !== undefined`: an empty error is no error. */
[[nodiscard]] inline bool truthy_object(const js::Error& error) {
    return static_cast<std::exception_ptr>(error) != nullptr;
}
[[nodiscard]] inline bool truthy(const js::Error& error) { return truthy_object(error); }

/** `error ?? fallback`, the fallback evaluated only for an absent error. */
template <class R, class F> [[nodiscard]] R nullish(const js::Error& left, F right) {
    return truthy_object(left) ? R(left) : R(right());
}

/** `throw error`: the thrown object itself, with its identity. */
[[noreturn]] inline void throw_error(const js::Error& error) {
    const std::exception_ptr thrown = error;
    if (!thrown)
        throw ThrownValue();
    std::rethrow_exception(thrown);
}

/** `value instanceof Error` over a thrown value. */
[[nodiscard]] inline bool is_error(const js::Error& error) {
    const std::exception_ptr thrown = error;
    if (!thrown)
        return false;
    try {
        std::rethrow_exception(thrown);
    } catch (const ThrownValue&) {
        return false;
    } catch (...) {
        return true;
    }
}

/** An authored `class X extends Error` instance as the error it is thrown as. */
template <class T> [[nodiscard]] js::Error class_error(const std::shared_ptr<T>& instance) {
    if (!instance)
        return {};
    return js::make_object_error(instance, "Error");
}

/** `error instanceof X` for an authored error class: its instance, or null. */
template <class T> [[nodiscard]] std::shared_ptr<T> error_instance(const js::Error& error) {
    return js::error_object<std::shared_ptr<T>>(error);
}

/** The numbers a spread of a number list passes, read when the spread evaluates. */
template <class T>
[[nodiscard]] std::vector<double> spread_numbers(const js::TypedArray<T>& values) {
    std::vector<double> result;
    result.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index)
        result.push_back(static_cast<double>(values.load(index)));
    return result;
}
template <std::size_t N>
[[nodiscard]] std::vector<double> spread_numbers(const js::Tuple<N>& values) {
    return std::vector<double>(values.begin(), values.end());
}
[[nodiscard]] inline std::vector<double> spread_numbers(const js::Array<double>& values) {
    return std::vector<double>(values.begin(), values.end());
}

/** `[...a, b, ...c]`: a fresh array, its parts appended in source order. */
template <class T> class ArrayBuilder {
public:
    ArrayBuilder& add(T value) {
        values_.push_back(std::move(value));
        return *this;
    }
    template <class Range> ArrayBuilder& spread(const Range& range) {
        // Spreading snapshots the source first, so a source that aliases the
        // result still yields its elements once.
        std::vector<T> items;
        for (const auto& item : range)
            items.push_back(static_cast<T>(item));
        for (auto& item : items)
            values_.push_back(std::move(item));
        return *this;
    }
    template <class V> ArrayBuilder& spread(const js::TypedArray<V>& range) {
        for (std::size_t index = 0; index < range.size(); ++index)
            values_.push_back(static_cast<T>(range.load(index)));
        return *this;
    }
    /** `...map.values()` / `...map.keys()`: one part of each entry, in insertion order. */
    template <class K, class V> ArrayBuilder& spread_values(const js::Map<K, V>& map) {
        std::vector<T> items;
        for (const auto& entry : map)
            items.push_back(entry.second);
        for (auto& item : items)
            values_.push_back(std::move(item));
        return *this;
    }
    template <class K, class V> ArrayBuilder& spread_keys(const js::Map<K, V>& map) {
        std::vector<T> items;
        for (const auto& entry : map)
            items.push_back(entry.first);
        for (auto& item : items)
            values_.push_back(std::move(item));
        return *this;
    }
    [[nodiscard]] js::Array<T> array() { return js::Array<T>(values_.begin(), values_.end()); }
    template <std::size_t N> [[nodiscard]] js::Tuple<N> tuple() {
        if (values_.size() != N)
            throw std::runtime_error("A spread tuple has another length.");
        return js::Tuple<N>(std::make_shared<std::vector<double>>(values_.begin(), values_.end()));
    }

private:
    std::vector<T> values_;
};

// ── Array iteration over callbacks ────────────────────────────────────
//
// Each method reads the length once, then visits the indices below it the
// array still has (an index the callback removed is skipped, as
// HasProperty is false for it), passing the element and its index.

template <class R, class T, class F>
[[nodiscard]] js::Array<R> array_map(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    std::vector<R> result;
    result.reserve(length);
    for (std::size_t index = 0; index < length; ++index) {
        if (index >= values.size())
            throw std::runtime_error(
                "An array shrank under Array.prototype.map; its holes are not represented.");
        result.push_back(callback(values[index], static_cast<double>(index)));
    }
    return js::Array<R>(result.begin(), result.end());
}

template <class T, class F>
[[nodiscard]] js::Array<T> array_filter(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    js::Array<T> result;
    for (std::size_t index = 0; index < length && index < values.size(); ++index) {
        T element = values[index];
        if (truthy(callback(element, static_cast<double>(index))))
            result.push_back(std::move(element));
    }
    return result;
}

template <class T, class F> void array_for_each(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    for (std::size_t index = 0; index < length && index < values.size(); ++index)
        callback(values[index], static_cast<double>(index));
}

template <class T, class F>
[[nodiscard]] bool array_some(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    for (std::size_t index = 0; index < length && index < values.size(); ++index)
        if (truthy(callback(values[index], static_cast<double>(index))))
            return true;
    return false;
}

template <class T, class F>
[[nodiscard]] bool array_every(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    for (std::size_t index = 0; index < length && index < values.size(); ++index)
        if (!truthy(callback(values[index], static_cast<double>(index))))
            return false;
    return true;
}

/** `find`: the first element the callback accepts, as `R` (a handle or a nullable value). */
template <class R, class T, class F>
[[nodiscard]] R array_find(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    for (std::size_t index = 0; index < length && index < values.size(); ++index) {
        T element = values[index];
        if (truthy(callback(element, static_cast<double>(index))))
            return R(std::move(element));
    }
    return R{};
}

template <class T, class F>
[[nodiscard]] double array_find_index(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    for (std::size_t index = 0; index < length && index < values.size(); ++index)
        if (truthy(callback(values[index], static_cast<double>(index))))
            return static_cast<double>(index);
    return -1.0;
}

/** `reduce(callback, initial)`. */
template <class A, class T, class F>
[[nodiscard]] A array_reduce(const js::Array<T>& values, F&& callback, A accumulator) {
    const std::size_t length = values.size();
    for (std::size_t index = 0; index < length && index < values.size(); ++index)
        accumulator = callback(std::move(accumulator), values[index], static_cast<double>(index));
    return accumulator;
}

/** `reduce(callback)`: the first element seeds it; an empty array is a TypeError. */
template <class A, class T, class F>
[[nodiscard]] A array_reduce_first(const js::Array<T>& values, F&& callback) {
    const std::size_t length = values.size();
    if (length == 0)
        throw js::NamedError("TypeError", "Reduce of empty array with no initial value");
    A accumulator = values[0];
    for (std::size_t index = 1; index < length && index < values.size(); ++index)
        accumulator = callback(std::move(accumulator), values[index], static_cast<double>(index));
    return accumulator;
}

/** `array.sort(compare)` over an array value the pin did not name (a fresh slice). */
template <class T, class Compare>
js::Array<T> sort_array(js::Array<T> values, const Compare& compare) {
    array_sort(values, compare);
    return values;
}

/** `split(separator, limit)`: at most ToUint32(limit) parts. */
[[nodiscard]] inline js::Array<std::string> array_limit(const js::Array<std::string>& parts,
                                                        double limit) {
    const std::size_t count = std::min<std::size_t>(js::to_uint32(limit), parts.size());
    return js::Array<std::string>(parts.begin(),
                                  parts.begin() + static_cast<std::ptrdiff_t>(count));
}

/** `array.shift()`: the first element, or absence. */
template <class R, class T> R array_shift(js::Array<T>& values) {
    if (values.empty())
        return R{};
    R first(std::move(values[0]));
    values.erase(values.begin());
    return first;
}

/** `new Float32Array(source)`: a fresh copy, each element converted as a store converts it. */
template <class T, class V>
[[nodiscard]] js::TypedArray<T> typed_copy(const js::TypedArray<V>& source) {
    js::TypedArray<T> result(source.size());
    for (std::size_t index = 0; index < source.size(); ++index)
        js::typed_array_write(result, static_cast<double>(index),
                              static_cast<double>(source.load(index)));
    return result;
}
template <class T, class Values>
    requires requires(const Values& values) { static_cast<double>(values[0]); }
[[nodiscard]] js::TypedArray<T> typed_copy(const Values& source) {
    js::TypedArray<T> result(source.size());
    for (std::size_t index = 0; index < source.size(); ++index)
        js::typed_array_write(result, static_cast<double>(index),
                              static_cast<double>(source[index]));
    return result;
}

/**
 * A `for (let ...)` loop's next iteration environment: a copy of the
 * current one (its bindings' values and its enclosing scope), so closures
 * of the finished iteration keep theirs.
 */
template <class Environment>
[[nodiscard]] std::shared_ptr<Environment>
next_iteration(const std::shared_ptr<Environment>& current) {
    return js::make_gc_shared<Environment>(*current);
}

/** A template literal's substitution: ToString of a primitive or of `undefined`. */
[[nodiscard]] inline std::string template_part(double value) { return js::number_to_string(value); }
[[nodiscard]] inline std::string template_part(bool value) { return value ? "true" : "false"; }
[[nodiscard]] inline std::string template_part(const std::string& value) { return value; }
template <class T> [[nodiscard]] std::string template_part(const js::Nullable<T>& value) {
    return value ? template_part(*value) : std::string("undefined");
}

/** `tuple[index] = value`: an element of its fixed length (growing it is not represented). */
template <std::size_t N> void tuple_write(js::Tuple<N>& values, double index, double value) {
    if (!js::array_has_index(values, index))
        throw std::runtime_error("A pinned tuple write outside its length is not represented.");
    values[static_cast<std::size_t>(index)] = value;
}

/** `ArrayLike<number>[index]`. */
[[nodiscard]] inline double array_like_get(const NumberArrayLike& values, double index) {
    return values.at(index);
}

/** `Number.isInteger`. */
[[nodiscard]] inline bool number_is_integer(double value) { return js::number_is_integer(value); }

/** `Number(string)`. */
[[nodiscard]] inline double number_of(const std::string& value) {
    return js::number_from_string(value);
}
[[nodiscard]] inline double number_of(double value) { return value; }
[[nodiscard]] inline double number_of(bool value) { return value ? 1.0 : 0.0; }

/** A JavaScript object reference as the weak key a WeakMap or WeakSet files it under. */
template <class T>
[[nodiscard]] std::weak_ptr<const void> weak_key(const std::shared_ptr<T>& value) {
    if (!value)
        throw js::NamedError("TypeError", "Invalid value used as weak key");
    return std::weak_ptr<const void>(value);
}

} // namespace bbl::pinned
