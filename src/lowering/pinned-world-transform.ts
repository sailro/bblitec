/**
 * The pinned TRS composition, emitted once at the double width the pin
 * composes at, for every record and consumer that needs a local matrix: the
 * render plan's meshes and transform nodes, an imported clone root's outer
 * transform, the default camera's framing and the .babylon node. Beside it
 * sits the mirrored-basis determinant from the shared pinned mat4Determinant3
 * lowerer.
 */
import type { LoweringContext } from "./context.js";
import { lowerMat4Determinant3 } from "./pinned-mat4-decompose.js";
import { lowerMat4MultiplyWriterCpp } from "./pinned-function-lowerer.js";
import { pinnedTrsComposition } from "./pinned-trs.js";

/**
 * The always-emitted header carrying the pinned TRS composition, the pinned
 * determinant and the imported clone root's outer transform, for every
 * consumer on either side of the generated/PAL boundary.
 */
export function pinnedWorldTransformHeader(context: LoweringContext): string {
    const determinant = lowerMat4Determinant3(
        context,
        undefined,
        "pinned_mat4_determinant3",
        true,
    );
    const trs = pinnedTrsComposition(context);
    const multiply = lowerMat4MultiplyWriterCpp(context, "f64");
    return `#pragma once

// ${context.provenance("src/scene/world-matrix-state.ts", "composeTrsLocalMatrix")}

#include <bblite/runtime.hpp>

#include <array>
#include <cmath>
#include <cstdint>

namespace bbl::upstream {

${multiply}

// The lanes src/scene/world-matrix-state.ts composeTrsLocalMatrix reads off
// a SceneNode, for a transform that is not a record's own: an imported
// clone root's outer position and rotation, a .babylon node's TRS.
struct TrsLanes {
    Vec3 rotation{};
    Vec3 scaling{1.0f, 1.0f, 1.0f};
    Vec3d position{};
    bool has_rotation_quaternion = false;
    Vec4 rotation_quaternion{0.0f, 0.0f, 0.0f, 1.0f};
};

// Observable imported-root values remain JavaScript numbers until matrix storage.
struct TrsLanes64 {
    Vec3d rotation{};
    Vec3d scaling{1, 1, 1};
    Vec3d position{};
    bool has_rotation_quaternion = false;
    Vec4d rotation_quaternion{0, 0, 0, 1};
};

// src/scene/world-matrix-state.ts composeTrsLocalMatrix, translated whole
// over whichever record carries the lanes -- a mesh, a transform node or
// TrsLanes: the pin composes in JavaScript-number width and stores once
// into its allocateMat4() Float32Array, so the locals are double and the
// result is left at that width for the consumers that subtract an eye or
// fit a shadow volume before narrowing.
template <typename Record>
std::array<double, 16> trs_local_matrix(const Record& mesh) {
${trs.composeLocalBody}    return local;
}

// The allocateMat4() Float32Array store: the composition narrowed once,
// which is what every GPU consumer reads.
inline std::array<float, 16> narrow_mat4(
    const std::array<double, 16>& local) {
    std::array<float, 16> world{};
    for (std::size_t cell = 0; cell < 16; ++cell) {
        world[cell] = static_cast<float>(local[cell]);
    }
    return world;
}

// One record's local matrix as the pin stores it. Every mesh world goes
// through this rather than rotating basis vectors by the record's
// quaternion or Euler triple: a parent's transform composes as a matrix
// product, and a negative scale above a rotation is not expressible as the
// child's own scale-rotate pair.
template <typename Record>
std::array<float, 16> trs_matrix(const Record& mesh) {
    return narrow_mat4(trs_local_matrix(mesh));
}

// world-matrix-state.ts getWorldMatrix: parent * local, with f32 matrix storage.
inline std::array<float, 16> light_world_matrix(const LightRecord& light) {
    const auto local = trs_matrix(light);
    if (!light.parent_world_matrix) return local;
    const auto parent = light.parent_world_matrix();
    std::array<double, 16> world{};
    mat4_multiply_into_f64(world, 0, parent, 0, local, 0);
    return narrow_mat4(world);
}

inline bool outer_transform_is_identity(const MeshRecord& mesh) {
    const auto& position = mesh.outer_position;
    const auto& scale = mesh.outer_scaling;
    const auto& rotation = mesh.outer_rotation;
    const auto& quaternion = mesh.outer_rotation_quaternion;
    return position.x == 0 && position.y == 0 && position.z == 0 &&
        scale.x == 1 && scale.y == 1 && scale.z == 1 &&
        (mesh.outer_has_rotation_quaternion
            ? quaternion.x == 0 && quaternion.y == 0 && quaternion.z == 0 && quaternion.w == 1
            : rotation.x == 0 && rotation.y == 0 && rotation.z == 0);
}

inline std::array<double, 16> outer_transform_local(const MeshRecord& mesh) {
    return trs_local_matrix(TrsLanes64{
        .rotation = mesh.outer_rotation,
        .scaling = mesh.outer_scaling,
        .position = mesh.outer_position,
        .has_rotation_quaternion = mesh.outer_has_rotation_quaternion,
        .rotation_quaternion = mesh.outer_rotation_quaternion});
}

inline std::array<float, 16> outer_transform_matrix(const MeshRecord& mesh) {
    return narrow_mat4(outer_transform_local(mesh));
}

inline std::array<double, 16> outer_transform_product(
    const MeshRecord& mesh, const std::array<double, 16>& world) {
    if (outer_transform_is_identity(mesh)) return world;
    std::array<double, 16> result{};
    mat4_multiply_into_f64(result, 0, outer_transform_local(mesh), 0, world, 0);
    return result;
}

${determinant}

} // namespace bbl::upstream
`;
}
