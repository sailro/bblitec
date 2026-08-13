#pragma once

// Plain-data JavaScript runtime support for compiled scene logic: dynamic
// arrays, nullable objects, readonly views, all-number tuples, JavaScript
// Math semantics, and the deterministic seeded Math.random replacement.
// Header-only; reached only when the entry scene compiles plain-data code.

#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
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

template <typename T>
[[nodiscard]] inline double array_length(const Array<T>& values) {
    return static_cast<double>(values.size());
}

template <typename T>
[[nodiscard]] inline double array_length(Span<const T> values) {
    return static_cast<double>(values.size());
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
