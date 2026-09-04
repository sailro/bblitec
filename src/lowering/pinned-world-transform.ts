/**
 * The float world-basis application and the mirrored-basis determinant,
 * emitted once into a header every scene carries.
 *
 * Three consumers apply a world matrix to loaded geometry on the CPU: the
 * PAL's vertex bake (`pal_gpu_shared.hpp`), the glTF loader's node bake and
 * the `.babylon` loader's pivot bake. All three had hand-typed the same two
 * multiplies, term for term, and the glTF loader had also hand-typed the
 * upper-left-3x3 determinant along a DIFFERENT cofactor row than the fold
 * the mirrored-mesh watcher executes — so the load-time and run-time
 * answers to "is this basis mirrored" did not round alike. One emission
 * here means one rounding everywhere.
 *
 * The pair is FLOAT deliberately. The reference for a CPU vertex bake is
 * the pinned WGSL vertex stage, which multiplies the f32 `finalWorld`
 * against f32 lanes — not `transformCoordinatesToRef`, whose JavaScript
 * numbers would lower to double and disagree with the shader in the last
 * bit. The markers below are the pinned stage lines the pair restates;
 * either changing upstream refuses generation.
 *
 * The determinant is the pin's own `mat4Determinant3`, through the one
 * fold `pinned-mat4-decompose.ts` owns for the reason that file states: a
 * second expansion of one pinned function is two answers to "is this
 * mirrored" waiting to disagree.
 */
import type { LoweringContext } from "./context.js";
import { lowerMat4Determinant3 } from "./pinned-mat4-decompose.js";

const PBR_TEMPLATE_MODULE = "src/material/pbr/pbr-template.ts";
const STANDARD_TEMPLATE_MODULE = "src/material/standard/standard-template.ts";

/**
 * The pinned vertex-stage lines the emitted pair restates in C++. The
 * templates build WGSL out of string literals, so the contract is textual:
 * the position multiply, the direction multiply, and the Standard basis
 * that spells the same three columns as a `mat3x3`.
 */
const PINNED_STAGE_MARKERS: readonly (readonly [
    string,
    string,
    string,
])[] = [
    [
        PBR_TEMPLATE_MODULE,
        "let worldPos4=finalWorld*vec4<f32>(" + "${posVar},1.0);",
        "vertex-stage position multiply",
    ],
    [
        PBR_TEMPLATE_MODULE,
        "out.worldNormal=(finalWorld*vec4<f32>(normalize(" +
            "${normVar}),0.0)).xyz;",
        "vertex-stage direction multiply",
    ],
    [
        STANDARD_TEMPLATE_MODULE,
        "let normalWorld=mat3x3<f32>(finalWorld[0].xyz," +
            "finalWorld[1].xyz,finalWorld[2].xyz);",
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

namespace bbl::upstream {

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

} // namespace bbl::upstream
`;
}
