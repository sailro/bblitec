#pragma once

// Plain-data JavaScript runtime support for compiled scene logic: dynamic
// arrays, nullable objects, readonly views, all-number tuples, JavaScript
// Math semantics, and the deterministic seeded Math.random replacement.
// Header-only; reached only when the entry scene compiles plain-data code.

#include <array>
#include <cassert>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <type_traits>
#include <vector>

namespace bbl::js {

template <typename T>
using Array = std::vector<T>;

template <typename T>
using Nullable = std::optional<T>;

template <typename T>
using Span = std::span<T>;

template <std::size_t N>
using Tuple = std::array<double, N>;

// Primitive number interpolation for JavaScript template strings. The
// finite path uses the shortest round-trippable spelling supplied by
// `to_chars`; the exceptional spellings follow ECMAScript rather than the
// implementation-defined C library names.
[[nodiscard]] inline std::string number_to_string(double value) {
    if (std::isnan(value)) return "NaN";
    if (value == std::numeric_limits<double>::infinity()) return "Infinity";
    if (value == -std::numeric_limits<double>::infinity()) return "-Infinity";
    if (value == 0.0) return "0";
    char buffer[64];
    const auto converted = std::to_chars(
        buffer, buffer + sizeof(buffer), value,
        std::chars_format::general);
    assert(converted.ec == std::errc{});
    return std::string(buffer, converted.ptr);
}

// `Record<Union, T>` — one fixed slot per member of a string-literal
// union. The compiler lays the slots out in the union's own member
// order, which is the order its enum tags are numbered in, so a tag
// indexes its slot directly. Unlike an Array it never grows: the key
// space is closed at compile time.
template <typename T, std::size_t N>
using EnumMap = std::array<T, N>;

template <typename T, std::size_t N, typename Tag>
[[nodiscard]] inline const T& enum_map_at(
    const EnumMap<T, N>& slots, Tag tag) {
    const auto index = static_cast<std::size_t>(tag);
    assert(index < N);
    return slots[index];
}

template <typename T, std::size_t N, typename Tag>
[[nodiscard]] inline T& enum_map_at(
    EnumMap<T, N>& slots, Tag tag) {
    const auto index = static_cast<std::size_t>(tag);
    assert(index < N);
    return slots[index];
}

template <typename T>
[[nodiscard]] inline double array_length(const Array<T>& values) {
    return static_cast<double>(values.size());
}

template <typename T>
[[nodiscard]] inline double array_length(Span<const T> values) {
    return static_cast<double>(values.size());
}

// `array.indexOf(value)` — the first strictly-equal element, or -1.
// JavaScript compares primitives by value and objects by identity, and
// every element type reaching here is a scalar or a handle id, so a
// plain `==` is that comparison. NaN matches nothing in either
// language, for the same reason.
// The needle is non-deduced so the element type always comes from the
// container: a literal argument then converts to it instead of
// deducing a second, conflicting T.
template <typename T>
[[nodiscard]] inline double array_index_of(
    const Array<T>& values,
    const std::type_identity_t<T>& value) {
    for (std::size_t index = 0; index < values.size();
         ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

template <typename T>
[[nodiscard]] inline double array_index_of(
    Span<const T> values,
    const std::type_identity_t<T>& value) {
    for (std::size_t index = 0; index < values.size();
         ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

// Constant arrays materialize as `std::array`, so searching one needs
// no conversion at the call site.
template <typename T, std::size_t N>
[[nodiscard]] inline double array_index_of(
    const std::array<T, N>& values,
    const std::type_identity_t<T>& value) {
    for (std::size_t index = 0; index < N; ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

// `array.pop()!` — the compiled subset asserts the array is non-empty.
template <typename T>
inline T array_pop(Array<T>& values) {
    assert(!values.empty());
    T last = values.back();
    values.pop_back();
    return last;
}

// `array.fill(value)` on an existing array.
template <typename T>
inline void array_fill(Array<T>& values, const T& value) {
    for (T& entry : values) {
        entry = value;
    }
}

// `new Array<T>(count).fill(value)`.
template <typename T>
[[nodiscard]] inline Array<T> array_filled(double count, const T& value) {
    return Array<T>(static_cast<std::size_t>(count), value);
}

// `array.splice(index, 1)` — remove one element and shift the tail down,
// the removal form the reached subset compiles (the particle sweep).
template <typename T>
inline void array_splice_one(Array<T>& values, double index) {
    const auto position = static_cast<std::size_t>(index);
    assert(position < values.size());
    values.erase(values.begin() + static_cast<std::ptrdiff_t>(position));
}

// `array.length = count` — the reached subset only shrinks (truncation).
template <typename T>
inline void array_truncate(Array<T>& values, double count) {
    const auto size = static_cast<std::size_t>(count);
    assert(size <= values.size());
    values.resize(size);
}

[[nodiscard]] inline std::size_t array_index(double index) {
    return static_cast<std::size_t>(index);
}

// JavaScript `%` (remainder keeps the dividend sign, like std::fmod).
[[nodiscard]] inline double remainder_js(double left, double right) {
    return std::fmod(left, right);
}

// JavaScript Math.round: a half rounds toward +Infinity, where std::round
// rounds it away from zero. The two disagree at -0.5, -1.5, ...
[[nodiscard]] inline double round_number(double value) {
    return std::floor(value + 0.5);
}

// Numeric `a || b`: 0 and NaN fall through to the fallback.
[[nodiscard]] inline double or_number(double value, double fallback) {
    return (value != 0.0 && !std::isnan(value)) ? value : fallback;
}

// JavaScript typed arrays reached by the compiled subset.
using F32Array = std::vector<float>;
using U16Array = std::vector<std::uint16_t>;
using U32Array = std::vector<std::uint32_t>;

// ECMAScript ToUint32: modulo 2^32 with truncation toward zero.
[[nodiscard]] inline std::uint32_t to_uint32(double value) {
    if (!std::isfinite(value)) {
        return 0u;
    }
    const double truncated = std::trunc(value);
    const double wrapped = std::fmod(truncated, 4294967296.0);
    return static_cast<std::uint32_t>(
        wrapped < 0.0 ? wrapped + 4294967296.0 : wrapped);
}

[[nodiscard]] inline std::uint16_t to_uint16(double value) {
    return static_cast<std::uint16_t>(to_uint32(value));
}

[[nodiscard]] inline F32Array f32_array_sized(double count) {
    return F32Array(static_cast<std::size_t>(count), 0.0f);
}

[[nodiscard]] inline U16Array u16_array_sized(double count) {
    return U16Array(static_cast<std::size_t>(count), 0u);
}

[[nodiscard]] inline U32Array u32_array_sized(double count) {
    return U32Array(static_cast<std::size_t>(count), 0u);
}

[[nodiscard]] inline U16Array u16_array_from(const Array<double>& values) {
    U16Array result;
    result.reserve(values.size());
    for (const double value : values) {
        result.push_back(to_uint16(value));
    }
    return result;
}

[[nodiscard]] inline F32Array f32_array_from(const Array<double>& values) {
    F32Array result;
    result.reserve(values.size());
    for (double value : values) {
        result.push_back(static_cast<float>(value));
    }
    return result;
}

[[nodiscard]] inline U32Array u32_array_from(const Array<double>& values) {
    U32Array result;
    result.reserve(values.size());
    for (double value : values) {
        result.push_back(to_uint32(value));
    }
    return result;
}

/**
 * `Math.round`, at ECMA-262's own rule rather than C's.
 *
 * The two differ on a negative tie: JavaScript rounds halves toward
 * +Infinity (`Math.round(-0.5)` is `-0`), while `std::round` rounds halves
 * away from zero (`-1`). The spec's rule is "the integer closest to x, ties
 * toward +Infinity", which is `floor(x) + (x - floor(x) >= 0.5)` -- written
 * that way rather than as `floor(x + 0.5)` because the addition is not
 * exact for large magnitudes, where `floor(x) == x` makes this branch return
 * `x` unchanged, as the spec requires.
 */
[[nodiscard]] inline double round_js(double value) {
    if (!std::isfinite(value) || value == 0.0) {
        return value;
    }
    const double floored = std::floor(value);
    return value - floored >= 0.5 ? floored + 1.0 : floored;
}

// Deterministic Math.random: mulberry32 over a pinned seed. The browser
// reference capture installs the identical generator before module load, so
// both sides consume the same sequence (recorded as a fidelity adaptation).
inline std::uint32_t& random_state() {
    static std::uint32_t state = 1u;
    return state;
}

inline void seed_random(std::uint32_t seed) {
    random_state() = seed;
}

[[nodiscard]] inline double random_js() {
    std::uint32_t& state = random_state();
    state += 0x6D2B79F5u;
    std::uint32_t t = state;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>((t ^ (t >> 14))) / 4294967296.0;
}

}  // namespace bbl::js
