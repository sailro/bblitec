#include "normalization.hpp"
#include <bit>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <limits>

namespace {
// The pre-A22 CPU bake is the neutrality oracle, not the pin's JS normalizer.
bbl::Vec3 baseline(bbl::Vec3 value) {
    const float length = std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
    return length > 0.000001f
        ? bbl::Vec3{value.x / length, value.y / length, value.z / length}
        : bbl::Vec3{};
}

void same(float actual, float expected) {
    assert((std::isnan(actual) && std::isnan(expected)) ||
        std::bit_cast<std::uint32_t>(actual) == std::bit_cast<std::uint32_t>(expected));
}

void check(bbl::Vec3 value) {
    const auto expected = baseline(value);
    const auto actual = bbl::upstream::normalize_baked_direction(value);
    same(actual.x, expected.x);
    same(actual.y, expected.y);
    same(actual.z, expected.z);
}
}

int main() {
    constexpr float threshold = 0.000001f;
    const float below = std::nextafter(threshold, 0.0f);
    const float above = std::nextafter(threshold, 1.0f);
    for (float scale : {0.0f, -0.0f, std::numeric_limits<float>::denorm_min(),
            below, threshold, above, 1.0f, 1000.0f, std::numeric_limits<float>::max(),
            std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()}) {
        check({scale, 0.0f, -0.0f});
        check({0.0f, -scale, scale});
        check({scale, scale * 0.25f, -scale * 0.75f});
    }
    same(bbl::upstream::normalize_baked_direction({threshold, 0.0f, 0.0f}).x, 0.0f);
    same(bbl::upstream::normalize_baked_direction({above, 0.0f, 0.0f}).x, 1.0f);
    std::uint32_t state = 0x13ec429bu;
    const auto next = [&] {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return std::bit_cast<float>(state);
    };
    for (unsigned index = 0; index < 100000; ++index) check({next(), next(), next()});
    std::puts("pinned-vertex-normalization-check: ok");
}
