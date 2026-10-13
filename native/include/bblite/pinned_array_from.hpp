#pragma once

// `Array.from` as the record lowerer (src/lowering/pinned-record-lowerer.ts)
// spells it beyond `js::array_from_iterable`: a typed array read through its
// view, `{ length }` with a mapper, a tuple assertion and a typed-array set.

#include <bblite/js_data.hpp>
#include <bblite/js_json.hpp>
#include <bblite/pinned_records.hpp>
#include <bblite/pinned_values.hpp>

#include <cstddef>
#include <stdexcept>
#include <vector>

namespace bbl::pinned {

/**
 * `Array.from(typedArray)`: its elements as numbers, read through the view
 * (an array, a tuple or a collection view is `js::array_from_iterable`'s).
 */
template <class T, class V>
[[nodiscard]] js::Array<T> array_from_typed(const js::TypedArray<V>& values) {
    js::Array<T> items;
    items.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index)
        items.push_back(static_cast<T>(values.load(index)));
    return items;
}

/**
 * `Array.from({ length }, mapper)`: `mapper(undefined, index)` for each index
 * below ToLength(length), which must be a valid array length here.
 */
template <class R, class F>
[[nodiscard]] js::Array<R> array_from_length(double length, F&& mapper) {
    const std::size_t count = array_length(length);
    js::Array<R> items;
    items.reserve(count);
    for (std::size_t index = 0; index < count; ++index)
        items.push_back(mapper(js::JsonValue{}, static_cast<double>(index)));
    return items;
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
