#include <bblite/upstream/pinned_look_direction.hpp>
#include <bblite/upstream/pinned_normalize_vec3.hpp>

#include <array>
#include <iomanip>
#include <iostream>

bool pinned_math_link_peer();

int main() {
    if (!pinned_math_link_peer() ||
        bbl::upstream::length_vec3({3.0, 4.0, 12.0}) != 13.0) {
        return 1;
    }
    struct TestCase {
        bbl::Vec3d forward;
        bbl::Vec3d up;
    };
    constexpr std::array<TestCase, 5> cases{{
        {{0.0, 0.0, 1.0}, {0.0, 1.0, 0.0}},
        {{3.0, -2.0, 8.0}, {0.2, 4.0, -1.0}},
        {{0.0, 0.0, 0.0}, {0.0, 1.0, 0.0}},
        {{0.0, 1.0, 0.0}, {0.0, 2.0, 0.0}},
        {{1e100, -2e100, 3e100}, {-4e99, 5e99, 6e99}},
    }};
    std::cout << std::setprecision(17);
    for (const auto& values : cases) {
        const auto quaternion =
            bbl::upstream::quat_from_look_direction_rh(
                values.forward,
                values.up);
        std::cout
            << quaternion[0] << ','
            << quaternion[1] << ','
            << quaternion[2] << ','
            << quaternion[3] << '\n';
    }
}
