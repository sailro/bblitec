/**
 * Shared CPU vertex transforms for the PAL and both geometry loaders.
 * World-basis application stays f32 to model the pinned vertex shader,
 * rather than the double intermediates of JavaScript matrix helpers. The
 * two multiplies are scalarized from the pinned PBR vertex template's own
 * resolved outputs, normalization comes from the same shader IR, the
 * mirrored-basis determinant from the shared pinned mat4Determinant3
 * lowerer, and an imported clone root's outer transform is the pinned TRS
 * composition at both widths its consumers keep it at.
 */
import type { LoweringContext } from "./context.js";
import { lowerMat4Determinant3 } from "./pinned-mat4-decompose.js";
import { lowerMat4MultiplyWriterCpp } from "./pinned-function-lowerer.js";
import { packagedWgsl } from "../pinned-wgsl-build.js";
import { pinnedPbrVertexOutputs } from "../pinned-material-vertex.js";
import { emitShaderCppExpression } from "../shader-cpp-emitter.js";
import type { ShaderExpression } from "../shader-ir.js";
import { pinnedTrsComposition } from "./pinned-trs.js";
import { pinnedVertexNormalization } from "./pinned-vertex-normalization.js";

const PBR_TEMPLATE_MODULE = "src/material/pbr/pbr-template.ts";
const STANDARD_TEMPLATE_MODULE = "src/material/standard/standard-template.ts";

/**
 * The Standard template applies the same three basis columns to a normal
 * (`out.vn = normalize(normalWorld * normal)`), so the direction multiply
 * scalarized from the PBR template below serves both families. The
 * Standard arm is retained as the pin's packaged text because that
 * template is not parsed into shader IR here.
 */
const STANDARD_BASIS_MARKER = packagedWgsl`let normalWorld = mat3x3<f32>(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);`;

const isPath = (value: ShaderExpression, ...parts: string[]): boolean =>
    value.kind === "path" &&
    value.parts.length === parts.length &&
    value.parts.every((part, index) => part === parts[index]);

/**
 * One of the pin's two world multiplies, scalarized from the PBR vertex
 * template's resolved outputs: `worldPos = (mesh.world * vec4<f32>(pos,
 * 1.0)).xyz` and `worldNormal = (mesh.world * vec4<f32>(normalize(normal),
 * 0.0)).xyz`.
 *
 * `emitShaderCppExpression` scalarizes the vector operand; the matrix
 * application is the one WGSL operator it does not carry, and it is
 * spelled here from the operand it was asserted against: `mesh.world` is
 * the sixteen f32 cells in WGSL's column-major order, so lane r of the
 * product is the sum over the three basis columns c of `world[c * 4 + r]`
 * times the vector's lane c, plus the translation column where the
 * homogeneous lane is one and nothing where it is zero (a zero term
 * contributes no value). The direction operand binds the WHOLE
 * `normalize(normal)` call to the caller's value, because that
 * normalization is `normalize_baked_direction` below and a CPU bake
 * applies the two in sequence.
 */
function pinnedWorldMultiplyLanes(
    context: LoweringContext,
    template: ReturnType<typeof pinnedPbrVertexOutputs>,
    output: "worldPos" | "worldNormal",
): string[] {
    const fail = (): never =>
        context.contractError(
            template.declaration,
            `Pinned vertex-stage ${output} world multiply changed.`,
        );
    const world = template.outputs.get(output);
    if (
        world?.kind !== "member" ||
        world.member !== "xyz" ||
        world.expression.kind !== "binary" ||
        world.expression.operator !== "*" ||
        !isPath(world.expression.left, "mesh", "world")
    ) {
        return fail();
    }
    const homogeneous = world.expression.right;
    if (
        homogeneous.kind !== "construct" ||
        homogeneous.type !== "vec4<f32>" ||
        homogeneous.arguments.length !== 2 ||
        homogeneous.arguments[1]?.kind !== "number"
    ) {
        return fail();
    }
    const translated = Number(homogeneous.arguments[1].value);
    const vector = homogeneous.arguments[0]!;
    if (output === "worldPos") {
        if (translated !== 1 || !isPath(vector, template.position)) {
            return fail();
        }
    } else if (
        translated !== 0 ||
        vector.kind !== "call" ||
        vector.name !== "normalize" ||
        vector.arguments.length !== 1 ||
        !isPath(vector.arguments[0]!, template.normal)
    ) {
        return fail();
    }
    const operand = emitShaderCppExpression(
        { kind: "path", parts: ["value"] },
        new Map([
            [
                "value",
                ["x", "y", "z"].map((component) => ({
                    cpp: `value.${component}`,
                })),
            ],
        ]),
    );
    if (operand.components.length !== 3 || operand.declarations.length !== 0) {
        return fail();
    }
    return [0, 1, 2].map((row) => {
        const terms = operand.components.map(
            (lane, column) => `world[${column * 4 + row}] * ${lane}`,
        );
        if (translated === 1) terms.push(`world[${12 + row}]`);
        return terms.join(" + ");
    });
}

/**
 * The always-emitted header carrying the two world-basis multiplies, the
 * pinned determinant and the imported clone root's outer transform, for
 * every consumer on either side of the generated/PAL boundary.
 */
export function pinnedWorldTransformHeader(context: LoweringContext): string {
    if (
        !context.store
            .getSource(STANDARD_TEMPLATE_MODULE)
            .includes(STANDARD_BASIS_MARKER)
    ) {
        throw new Error(
            `Pinned Babylon Lite Standard world basis changed: ${STANDARD_BASIS_MARKER}`,
        );
    }
    const positionProvenance = context.provenance(
        PBR_TEMPLATE_MODULE,
        "createPbrTemplate",
        `${STANDARD_TEMPLATE_MODULE}#createStandardTemplate`,
    );
    const template = pinnedPbrVertexOutputs(context);
    const position = pinnedWorldMultiplyLanes(context, template, "worldPos");
    const direction = pinnedWorldMultiplyLanes(context, template, "worldNormal");
    const determinant = lowerMat4Determinant3(
        context,
        undefined,
        "pinned_mat4_determinant3",
        true,
    );
    const trs = pinnedTrsComposition(context);
    const multiply = lowerMat4MultiplyWriterCpp(context, "f64");
    return `#pragma once

// ${positionProvenance}

#include <bblite/runtime.hpp>

#include <array>
#include <cmath>
#include <cstdint>

namespace bbl::upstream {

${multiply}

// An imported clone root's outer position and rotation, composed the way
// src/scene/world-matrix-state.ts composeTrsLocalMatrix composes any
// SceneNode: the pinned Euler-to-quaternion and mat4ComposeInto walk over
// a unit scale and no quaternion source. Kept at the composition's own
// double width for the consumers that subtract an eye or fit a shadow
// volume before narrowing.
inline std::array<double, 16> outer_transform_local(
    const Vec3& position, const Vec3& rotation) {
    const struct {
        Vec3 rotation;
        Vec3 scaling{1.0f, 1.0f, 1.0f};
        Vec3 position;
        bool has_rotation_quaternion = false;
        Vec4 rotation_quaternion{};
    } mesh{.rotation = rotation, .position = position};
${trs.composeLocalBody}    return local;
}

// The same composition narrowed once: the allocateMat4() Float32Array
// store every GPU consumer reads.
inline std::array<float, 16> outer_transform_matrix(
    const Vec3& position, const Vec3& rotation) {
    const std::array<double, 16> local =
        outer_transform_local(position, rotation);
    std::array<float, 16> world{};
    for (std::size_t cell = 0; cell < 16; ++cell) {
        world[cell] = static_cast<float>(local[cell]);
    }
    return world;
}

// \`outer * world\` at double width: the clone root's composition on the
// left of a mesh's own world, the operand order world-matrix-state.ts
// getWorldMatrix multiplies a parent by (\`mat4MultiplyInto(out, 0,
// parent, 0, local, 0)\`), through the pinned writer's F64 storage arm.
inline std::array<double, 16> outer_transform_product(
    const Vec3& position,
    const Vec3& rotation,
    const std::array<double, 16>& world) {
    std::array<double, 16> product{};
    mat4_multiply_into_f64(
        product, 0, outer_transform_local(position, rotation), 0, world, 0);
    return product;
}

// The float application of a world basis, scalarized from the pinned PBR
// vertex template's resolved outputs. Float on purpose: the CPU bakes that
// call these stand in for the f32 shader multiply, so a double
// intermediate would disagree with the golden in the last bit.

/** \`mesh.world * vec4<f32>(pos, 1.0)\`, the pin's vertex-stage position multiply. */
inline Vec3 transform_position(
    const std::array<float, 16>& world,
    Vec3 value) {
    return Vec3{
${position.map((lane) => `        ${lane},`).join("\n")}
    };
}

/**
 * \`mesh.world * vec4<f32>(normalize(normal), 0.0)\` with the normalization
 * bound to the caller's value, which is what both pinned templates apply to
 * a normal and a tangent alike -- \`pbr-template.ts\` writes
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
${direction.map((lane) => `        ${lane},`).join("\n")}
    };
}

${determinant}

${pinnedVertexNormalization(context)}

} // namespace bbl::upstream
`;
}
