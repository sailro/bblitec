#pragma once

// `Array.from` as the record lowerer (src/lowering/pinned-record-lowerer.ts)
// spells it: a fresh array of a source's elements, read once in order, then
// mapped by `array_map` when the pin passes a mapper.

#include <bblite/js_data.hpp>
#include <bblite/js_json.hpp>
#include <bblite/pinned_records.hpp>
#include <bblite/pinned_values.hpp>

#include <cstddef>
#include <stdexcept>
#include <vector>

namespace bbl::pinned {

/** `Array.from(array)`: a shallow copy. */
template <class T> [[nodiscard]] js::Array<T> array_from(const js::Array<T>& values) {
    return js::Array<T>(values.begin(), values.end());
}

/** `Array.from(typedArray)`: its elements as numbers. */
template <class T, class V> [[nodiscard]] js::Array<T> array_from(const js::TypedArray<V>& values) {
    std::vector<T> items;
    items.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index)
        items.push_back(static_cast<T>(values.load(index)));
    return js::Array<T>(items.begin(), items.end());
}

/** `Array.from(tuple)`: its elements. */
template <class T, class Tuple>
    requires requires(const Tuple& values) {
        values.size();
        static_cast<T>(values[0]);
    }
[[nodiscard]] js::Array<T> array_from(const Tuple& values) {
    std::vector<T> items;
    items.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index)
        items.push_back(static_cast<T>(values[index]));
    return js::Array<T>(items.begin(), items.end());
}

/** `Array.from(map.values())`: the values in insertion order. */
template <class K, class V> [[nodiscard]] js::Array<V> array_from_values(const js::Map<K, V>& map) {
    std::vector<V> items;
    for (const auto& entry : map)
        items.push_back(entry.second);
    return js::Array<V>(items.begin(), items.end());
}

/** `Array.from(map.keys())`: the keys in insertion order. */
template <class K, class V> [[nodiscard]] js::Array<K> array_from_keys(const js::Map<K, V>& map) {
    std::vector<K> items;
    for (const auto& entry : map)
        items.push_back(entry.first);
    return js::Array<K>(items.begin(), items.end());
}

/** `Array.from(set.values())`: the elements in insertion order. */
template <class T> [[nodiscard]] js::Array<T> array_from_values(const js::Set<T>& set) {
    std::vector<T> items;
    for (const auto& item : set)
        items.push_back(item);
    return js::Array<T>(items.begin(), items.end());
}

/**
 * `Array.from({ length }, mapper)`: `mapper(undefined, index)` for each index
 * below ToLength(length), which must be a valid array length here.
 */
template <class R, class F>
[[nodiscard]] js::Array<R> array_from_length(double length, F&& mapper) {
    const std::size_t count = array_length(length);
    std::vector<R> items;
    items.reserve(count);
    for (std::size_t index = 0; index < count; ++index)
        items.push_back(mapper(js::JsonValue{}, static_cast<double>(index)));
    return js::Array<R>(items.begin(), items.end());
}

/**
 * `Array.from(source) as [number, number, number]`: a tuple the pin asserts
 * the array is. A source of another length refuses, as the assertion would
 * be false.
 */
template <std::size_t N> [[nodiscard]] js::Tuple<N> array_tuple(const js::Array<double>& values) {
    if (values.size() != N)
        throw std::runtime_error("A pinned tuple assertion read an array of another length.");
    js::Tuple<N> tuple{};
    for (std::size_t index = 0; index < N; ++index)
        tuple[index] = values[index];
    return tuple;
}

/**
 * `%TypedArray%.prototype.set(source, offset)` from a number list of
 * another kind: each element converted as a store converts it, after the
 * RangeError check for a run that does not fit.
 */
template <class T, class Source>
void typed_set(js::TypedArray<T> target, const Source& source, double offset) {
    const auto start = js::array_index(offset);
    const std::size_t count = source.size();
    if (start > target.size() || count > target.size() - start)
        throw js::NamedError("RangeError", "offset is out of bounds");
    std::vector<double> values;
    values.reserve(count);
    for (std::size_t index = 0; index < count; ++index) {
        if constexpr (requires { source.load(index); })
            values.push_back(static_cast<double>(source.load(index)));
        else
            values.push_back(static_cast<double>(source[index]));
    }
    for (std::size_t index = 0; index < count; ++index)
        js::typed_array_write(target, static_cast<double>(start + index), values[index]);
}

} // namespace bbl::pinned
