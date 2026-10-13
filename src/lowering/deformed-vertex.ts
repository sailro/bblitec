import type { LoweringContext } from "./context.js";
import { recordAt } from "../compiler/record-access.js";

const vertexModule = "src/picking/deformed-vertex.ts";
const mathModule = "src/picking/deformation-math.ts";

/**
 * `computeDeformedPositionToRef`: `deformVertexToRef` with no captured pose,
 * over the native CPU mirrors. `mesh._cpuPositions` is the geometry's
 * retained vertices, the morph state its target positions with the live
 * weights the renderer uploads (the uncapped storage lane when filled), and
 * `mesh.skeleton` the record's skin flag (`attachVat` clears it) over its
 * live palette. Native vertices carry four joints, so `joints1`/`weights1`
 * are absent.
 *
 * The pin indexes flat arrays with `vertexIndex * 3` and `* 4`: a fractional
 * offset reads `undefined`, which is NaN in a position and `?? 0` in a
 * weight or joint. The scratch is a Float32Array, so each stage's result is
 * rounded to float where the pin stores it; the bone transform accumulates
 * in double as the pin's plain-array scratch does.
 */
export function lowerDeformedVertex(context: LoweringContext): string {
    const deform = context.functionDeclaration(
        vertexModule,
        "deformVertexToRef",
    ).declaration;
    context.assertStatementShapes(
        deform.body!,
        deform.body!.statements,
        `
        const base = mesh._cpuPositions;
        if (!base) {
            return false;
        }
        const componentOffset = vertexIndex * 3;
        if (componentOffset < 0 || componentOffset + 2 >= base.length) {
            return false;
        }
        const scratch = (_deformScratch ??= new Float32Array(3));
        scratch[0] = base[componentOffset]!;
        scratch[1] = base[componentOffset + 1]!;
        scratch[2] = base[componentOffset + 2]!;
        const morph = mesh.morphTargets;
        if (morph) {
            addMorphDelta(morph, scratch, 0, componentOffset, pose?.morphWeights);
        }
        const skeleton = mesh.skeleton;
        if (skeleton) {
            skinVertexToRef(
                pose?.boneMatrices ?? skeleton.boneMatrices,
                skeleton.joints,
                skeleton.weights,
                skeleton.joints1,
                skeleton.weights1,
                vertexIndex,
                scratch[0]!,
                scratch[1]!,
                scratch[2]!,
                1,
                scratch,
                0
            );
        }
        out.x = scratch[0]!;
        out.y = scratch[1]!;
        out.z = scratch[2]!;
        return true;
    `,
        "Deformed vertex",
    );
    const compute = context.functionDeclaration(
        vertexModule,
        "computeDeformedPositionToRef",
    ).declaration;
    context.assertStatementShapes(
        compute.body!,
        compute.body!.statements,
        "return deformVertexToRef(mesh, vertexIndex, out, null);",
        "Live deformed vertex",
    );
    const morph = context.functionDeclaration(
        mathModule,
        "addMorphDelta",
    ).declaration;
    context.assertStatementShapes(
        morph.body!,
        morph.body!.statements,
        `
        let x = out[outOffset]!;
        let y = out[outOffset + 1]!;
        let z = out[outOffset + 2]!;
        const activeWeights = weightsOverride ?? morph.weights;
        const targetCount = Math.min(morph.count, morph.targets.length);
        for (let t = 0; t < targetCount; t++) {
            const weight = activeWeights[t] ?? 0;
            if (weight === 0) {
                continue;
            }
            const positions = morph.targets[t]!.positions;
            x += positions[componentOffset]! * weight;
            y += positions[componentOffset + 1]! * weight;
            z += positions[componentOffset + 2]! * weight;
        }
        out[outOffset] = x;
        out[outOffset + 1] = y;
        out[outOffset + 2] = z;
    `,
        "Morph delta",
    );
    const skin = context.functionDeclaration(
        mathModule,
        "skinVertexToRef",
    ).declaration;
    context.assertStatementShapes(
        skin.body!,
        skin.body!.statements,
        `
        let rx = 0;
        let ry = 0;
        let rz = 0;
        const base = vertexIndex * 4;
        for (let i = 0; i < 4; i++) {
            const weight = weights[base + i] ?? 0;
            if (weight !== 0) {
                transformByBoneToRef(boneMatrices, joints[base + i] ?? 0, x, y, z, wCoord, _boneTransformScratch);
                rx += _boneTransformScratch[0] * weight;
                ry += _boneTransformScratch[1] * weight;
                rz += _boneTransformScratch[2] * weight;
            }
        }
        if (joints1 && weights1) {
            for (let i = 0; i < 4; i++) {
                const weight = weights1[base + i] ?? 0;
                if (weight !== 0) {
                    transformByBoneToRef(boneMatrices, joints1[base + i] ?? 0, x, y, z, wCoord, _boneTransformScratch);
                    rx += _boneTransformScratch[0] * weight;
                    ry += _boneTransformScratch[1] * weight;
                    rz += _boneTransformScratch[2] * weight;
                }
            }
        }
        out[outOffset] = rx;
        out[outOffset + 1] = ry;
        out[outOffset + 2] = rz;
    `,
        "Vertex skinning",
    );
    const bone = context.functionDeclaration(
        mathModule,
        "transformByBoneToRef",
    ).declaration;
    context.assertStatementShapes(
        bone.body!,
        bone.body!.statements,
        `
        const o = joint * 16;
        out[0] = boneMatrices[o]! * x + boneMatrices[o + 4]! * y + boneMatrices[o + 8]! * z + boneMatrices[o + 12]! * wCoord;
        out[1] = boneMatrices[o + 1]! * x + boneMatrices[o + 5]! * y + boneMatrices[o + 9]! * z + boneMatrices[o + 13]! * wCoord;
        out[2] = boneMatrices[o + 2]! * x + boneMatrices[o + 6]! * y + boneMatrices[o + 10]! * z + boneMatrices[o + 14]! * wCoord;
    `,
        "Bone transform",
    );
    return `// ${context.provenance(vertexModule, "computeDeformedPositionToRef", `${vertexModule}#deformVertexToRef, ${mathModule}#addMorphDelta, ${mathModule}#skinVertexToRef and ${mathModule}#transformByBoneToRef`)}
DeformedPosition compute_deformed_position(const Engine& engine, MeshHandle mesh, double vertex_index,
                                           Vec3d out) {
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (record.geometry >= engine.geometries.size()) return {false, out};
    const ModelGeometry& geometry = engine.geometries[record.geometry];
    // \`mesh._cpuPositions\`.
    if (geometry.vertices.empty()) return {false, out};
    const double component_offset = vertex_index * 3.0;
    const double length = static_cast<double>(geometry.vertices.size()) * 3.0;
    if (component_offset < 0.0 || component_offset + 2.0 >= length) return {false, out};
    // A flat component the pin reads: \`undefined\` off an integer slot.
    const auto component = [](const auto& vertices, double offset, auto lane) -> double {
        if (offset != std::floor(offset)) return std::numeric_limits<double>::quiet_NaN();
        const auto slot = static_cast<std::size_t>(offset);
        if (slot / 3u >= vertices.size()) return std::numeric_limits<double>::quiet_NaN();
        return static_cast<double>(lane(vertices[slot / 3u], slot % 3u));
    };
    const auto position_lane = [](const ModelVertex& vertex, std::size_t lane) {
        return lane == 0u ? vertex.position.x : lane == 1u ? vertex.position.y : vertex.position.z;
    };
    const auto delta_lane = [](const Vec3& delta, std::size_t lane) {
        return lane == 0u ? delta.x : lane == 1u ? delta.y : delta.z;
    };
    std::array<float, 3> scratch{
        static_cast<float>(component(geometry.vertices, component_offset, position_lane)),
        static_cast<float>(component(geometry.vertices, component_offset + 1.0, position_lane)),
        static_cast<float>(component(geometry.vertices, component_offset + 2.0, position_lane))};
    // \`addMorphDelta\`: the live weights, the storage lane when it is filled.
    if (!geometry.morph_positions.empty()) {
        double x = scratch[0], y = scratch[1], z = scratch[2];
        const bool uncapped = !record.morph_storage_weights.empty();
        const std::size_t weight_count =
            uncapped ? record.morph_storage_weights.size() : record.morph_weights.size();
        for (std::size_t t = 0; t < geometry.morph_positions.size(); ++t) {
            const double weight = t < weight_count
                ? static_cast<double>(uncapped ? record.morph_storage_weights[t] : record.morph_weights[t])
                : 0.0;
            if (weight == 0.0) continue;
            const auto& positions = geometry.morph_positions[t];
            x += component(positions, component_offset, delta_lane) * weight;
            y += component(positions, component_offset + 1.0, delta_lane) * weight;
            z += component(positions, component_offset + 2.0, delta_lane) * weight;
        }
        scratch = {static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)};
    }
    // \`skinVertexToRef\` with wCoord 1, over the live palette.
    if (record.skinned) {
        const double x = scratch[0], y = scratch[1], z = scratch[2];
        double rx = 0.0, ry = 0.0, rz = 0.0;
        const double base = vertex_index * 4.0;
        for (std::size_t i = 0; i < 4u; ++i) {
            const double slot = base + static_cast<double>(i);
            // \`weights[base + i] ?? 0\` and \`joints[base + i] ?? 0\`.
            const bool present = slot == std::floor(slot) && slot >= 0.0 &&
                                 slot < static_cast<double>(geometry.vertices.size()) * 4.0;
            const ModelVertex* vertex = present ? &geometry.vertices[static_cast<std::size_t>(slot) / 4u] : nullptr;
            const std::size_t lane = present ? static_cast<std::size_t>(slot) % 4u : 0u;
            const double weight = vertex
                ? static_cast<double>(lane == 0u ? vertex->weights.x : lane == 1u ? vertex->weights.y
                                      : lane == 2u ? vertex->weights.z : vertex->weights.w)
                : 0.0;
            if (weight == 0.0) continue;
            const std::size_t joint = vertex ? vertex->joints[lane] : 0u;
            // \`transformByBoneToRef\`: a joint past the palette reads NaN.
            const auto matrix = [&](std::size_t index) -> double {
                return joint < record.bone_matrices.size()
                    ? static_cast<double>(record.bone_matrices[joint][index])
                    : std::numeric_limits<double>::quiet_NaN();
            };
            rx += (matrix(0) * x + matrix(4) * y + matrix(8) * z + matrix(12) * 1.0) * weight;
            ry += (matrix(1) * x + matrix(5) * y + matrix(9) * z + matrix(13) * 1.0) * weight;
            rz += (matrix(2) * x + matrix(6) * y + matrix(10) * z + matrix(14) * 1.0) * weight;
        }
        scratch = {static_cast<float>(rx), static_cast<float>(ry), static_cast<float>(rz)};
    }
    return {true, Vec3d{scratch[0], scratch[1], scratch[2]}};
}
`;
}
