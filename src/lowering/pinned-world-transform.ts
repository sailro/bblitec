/**
 * Shared CPU vertex transforms for the PAL and both geometry loaders.
 * World-basis application stays f32 to model the pinned vertex shader,
 * rather than the double intermediates of JavaScript matrix helpers.
 * Stage markers and typed direction projection validate that contract;
 * normalization comes from shader IR and the mirrored-basis determinant
 * from the shared pinned mat4Determinant3 lowerer.
 */
import type { LoweringContext } from "./context.js";
import { lowerMat4Determinant3 } from "./pinned-mat4-decompose.js";
import { packagedWgsl } from "../pinned-wgsl-build.js";
import { pinnedTrsComposition } from "./pinned-trs.js";
import { pinnedVertexNormalization } from "./pinned-vertex-normalization.js";

const PBR_TEMPLATE_MODULE = "src/material/pbr/pbr-template.ts";
const STANDARD_TEMPLATE_MODULE = "src/material/standard/standard-template.ts";

/**
 * Position and Standard basis markers retain the pin's package transform
 * and template placeholders. The PBR direction/normalization contract is
 * checked separately through typed shader IR.
 */
const PINNED_STAGE_MARKERS: readonly (readonly [
    string,
    string,
    string,
])[] = [
    [
        PBR_TEMPLATE_MODULE,
        packagedWgsl`let worldPos4 = finalWorld * vec4<f32>(\${posVar}, 1.0);`,
        "vertex-stage position multiply",
    ],
    [
        STANDARD_TEMPLATE_MODULE,
        packagedWgsl`let normalWorld = mat3x3<f32>(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);`,
        "Standard world basis",
    ],
];

/**
 * The always-emitted header carrying the two world-basis multiplies and
 * the pinned determinant, for every consumer on either side of the
 * generated/PAL boundary.
 */
export function pinnedWorldTransformHeader(context: LoweringContext): string {
    for (const [modulePath, marker, label] of PINNED_STAGE_MARKERS) {
        if (!context.store.getSource(modulePath).includes(marker)) {
            throw new Error(
                `Pinned Babylon Lite ${label} changed: ${marker}`,
            );
        }
    }
    const positionProvenance = context.provenance(
        PBR_TEMPLATE_MODULE,
        "createPbrTemplate",
        `${STANDARD_TEMPLATE_MODULE}#createStandardTemplate`,
    );
    const determinant = lowerMat4Determinant3(
        context,
        undefined,
        "pinned_mat4_determinant3",
        true,
    );
    return `#pragma once

// ${positionProvenance}

#include <bblite/runtime.hpp>

#include <array>
#include <cmath>

namespace bbl::upstream {

// Imported clone roots use the same intrinsic XYZ composition as SceneNode.
inline std::array<float, 16> outer_transform_matrix(
    const Vec3& position, const Vec3& rotation) {
    const struct {
        Vec3 rotation;
        Vec3 scaling{1.0f, 1.0f, 1.0f};
        Vec3 position;
        bool has_rotation_quaternion = false;
        Vec4 rotation_quaternion{};
    } mesh{.rotation = rotation, .position = position};
${pinnedTrsComposition(context).composeWorldBody}
    return world;
}

// The float application of a world basis, restated from the pinned WGSL
// vertex stages. Float on purpose: the CPU bakes that call these stand in
// for the f32 shader multiply, so a double intermediate would disagree
// with the golden in the last bit.

/** \`world * vec4(value, 1)\`, the pin's own vertex-stage position multiply. */
inline Vec3 transform_position(
    const std::array<float, 16>& world,
    Vec3 value) {
    return Vec3{
        world[0] * value.x + world[4] * value.y + world[8] * value.z +
            world[12],
        world[1] * value.x + world[5] * value.y + world[9] * value.z +
            world[13],
        world[2] * value.x + world[6] * value.y + world[10] * value.z +
            world[14],
    };
}

/**
 * \`world * vec4(value, 0)\`, which is what both pinned templates apply to a
 * normal and a tangent alike — \`pbr-template.ts\` writes
 * \`(finalWorld * vec4<f32>(normalize(normal), 0.0)).xyz\` and
 * \`standard-template.ts\` the \`mat3x3\` of the same three columns. Neither
 * divides by the scale: the pin transforms a normal by the plain world
 * basis rather than by an inverse transpose, and a port that divided
 * agreed with it only where a normal lines up with a scaling axis.
 */
inline Vec3 transform_direction(
    const std::array<float, 16>& world,
    Vec3 value) {
    return Vec3{
        world[0] * value.x + world[4] * value.y + world[8] * value.z,
        world[1] * value.x + world[5] * value.y + world[9] * value.z,
        world[2] * value.x + world[6] * value.y + world[10] * value.z,
    };
}

${determinant}

${pinnedVertexNormalization(context)}

} // namespace bbl::upstream
`;
}
