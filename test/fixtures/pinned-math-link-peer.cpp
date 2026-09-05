#include <bblite/upstream/pinned_look_direction.hpp>
#include <bblite/upstream/pinned_normalize_vec3.hpp>

// A second consumer of both generated headers catches non-inline definitions
// that a one-translation-unit numerical fixture cannot expose.
bool pinned_math_link_peer() {
    const auto unit = bbl::upstream::normalize_vec3_object({3.0, 4.0, 12.0});
    const auto zero = bbl::upstream::normalize_vec3_object({0.0, 0.0, 0.0});
    const auto quaternion = bbl::upstream::quat_from_look_direction_rh(
        {0.0, 0.0, 1.0}, {0.0, 1.0, 0.0});
    return unit.x == 3.0 / 13.0 && unit.y == 4.0 / 13.0 &&
        unit.z == 12.0 / 13.0 && zero.x == 0.0 && zero.y == 0.0 &&
        zero.z == 0.0 && quaternion[3] == 1.0;
}
