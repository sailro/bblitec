import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { recordAt } from "../compiler/record-access.js";
import {
    absentBinding,
    type PinnedBinding,
    type PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";

const vertexModule = "src/picking/deformed-vertex.ts";
const mathModule = "src/picking/deformation-math.ts";

/**
 * The native views the pinned bodies index: flat reads over the geometry's
 * vertex rows, its morph rows, the record's live weights and palette. A
 * flat slot off an integer or past the end is the pin's `undefined`: NaN
 * where the pin stores it, absent where it takes `?? 0`.
 */
const views = `namespace deformed_vertex_detail {
inline bool flat_slot(double offset, std::size_t rows, std::size_t stride) {
    return offset == std::floor(offset) && offset >= 0.0 &&
           offset < static_cast<double>(rows) * static_cast<double>(stride);
}
/** \`mesh._cpuPositions[offset]\`. */
inline double position_component(const std::vector<ModelVertex>& vertices, double offset) {
    if (!flat_slot(offset, vertices.size(), 3u)) return std::numeric_limits<double>::quiet_NaN();
    const auto slot = static_cast<std::size_t>(offset);
    const Vec3& position = vertices[slot / 3u].position;
    return static_cast<double>(slot % 3u == 0u ? position.x : slot % 3u == 1u ? position.y : position.z);
}
/** \`morph.targets[t].positions[offset]\`. */
inline double delta_component(const std::vector<Vec3>& deltas, double offset) {
    if (!flat_slot(offset, deltas.size(), 3u)) return std::numeric_limits<double>::quiet_NaN();
    const auto slot = static_cast<std::size_t>(offset);
    const Vec3& delta = deltas[slot / 3u];
    return static_cast<double>(slot % 3u == 0u ? delta.x : slot % 3u == 1u ? delta.y : delta.z);
}
/** \`morph.weights\`: the live weights, the storage lane when it is filled. */
inline std::size_t morph_weight_count(const MeshRecord& record) {
    return record.morph_storage_weights.empty() ? record.morph_weights.size()
                                                : record.morph_storage_weights.size();
}
inline double morph_weight(const MeshRecord& record, double t) {
    const auto slot = static_cast<std::size_t>(t);
    return static_cast<double>(record.morph_storage_weights.empty() ? record.morph_weights[slot]
                                                                     : record.morph_storage_weights[slot]);
}
/** \`skeleton.weights[slot]\` and \`skeleton.joints[slot]\`, four per vertex row. */
inline double skin_weight(const std::vector<ModelVertex>& vertices, double slot) {
    const auto index = static_cast<std::size_t>(slot);
    const Vec4& weights = vertices[index / 4u].weights;
    const std::size_t lane = index % 4u;
    return static_cast<double>(lane == 0u ? weights.x : lane == 1u ? weights.y : lane == 2u ? weights.z : weights.w);
}
inline double skin_joint(const std::vector<ModelVertex>& vertices, double slot) {
    const auto index = static_cast<std::size_t>(slot);
    return static_cast<double>(vertices[index / 4u].joints[index % 4u]);
}
/** \`skeleton.boneMatrices[offset]\`: the live palette, sixteen per bone. */
inline double bone_component(const MeshRecord& record, double offset) {
    if (!flat_slot(offset, record.bone_matrices.size(), 16u)) return std::numeric_limits<double>::quiet_NaN();
    const auto slot = static_cast<std::size_t>(offset);
    return static_cast<double>(record.bone_matrices[slot / 16u][slot % 16u]);
}
} // namespace deformed_vertex_detail`;

/**
 * `values[slot] ?? fallback` over one of the native views: the view's read
 * where the slot is present, the pin's own fallback where it is not.
 */
function nullishSlot(
    node: ts.Expression,
    lowerer: PinnedNumericLowerer,
    arrays: ReadonlyMap<
        string,
        (slot: string) => { present: string; read: string }
    >,
): string | undefined {
    if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    )
        return undefined;
    const left = unwrapExpression(node.left);
    if (
        !ts.isElementAccessExpression(left) ||
        !ts.isIdentifier(left.expression)
    )
        return undefined;
    const view = arrays.get(left.expression.text);
    if (!view) return undefined;
    const { present, read } = view(lowerer.expression(left.argumentExpression));
    return `(${present} ? ${read} : ${lowerer.expression(node.right)})`;
}

/** A local the pin declares and a statement hook replaces, asserted at its shape. */
function localNamed(
    statement: ts.Statement,
    name: string,
): ts.VariableDeclaration | undefined {
    if (!ts.isVariableStatement(statement)) return undefined;
    const [declaration] = statement.declarationList.declarations;
    return declaration &&
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name
        ? declaration
        : undefined;
}

/**
 * `computeDeformedPositionToRef`: `deformVertexToRef` with no captured pose,
 * lowered from the pin with `addMorphDelta`, `skinVertexToRef` and
 * `transformByBoneToRef` over native views. `mesh._cpuPositions` is the
 * geometry's retained vertices, the morph state its target rows with the
 * live weights the renderer uploads, and `mesh.skeleton` the record's skin
 * flag (`attachVat` clears it) over its live palette. Native vertices carry
 * four joints, so `joints1`/`weights1` are absent. The scratch is the pin's
 * Float32Array, so each stage rounds where the pin stores; the bone
 * transform's scratch is a plain array, accumulated in double.
 */
export function lowerDeformedVertex(context: LoweringContext): string {
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
    const scratch: PinnedBinding = { cpp: "out", type: "f32" };
    const transform = lowerPinnedFunction(
        context,
        mathModule,
        "transformByBoneToRef",
        [
            {
                pinned: "boneMatrices",
                kind: "record",
                annotation: "Float32Array",
                cpp: "record",
                cppType: "MeshRecord",
                binding: {
                    cpp: "record",
                    type: "opaque",
                    indexedRead: (owner, index) =>
                        `deformed_vertex_detail::bone_component(${owner}, ${index})`,
                },
            },
            { pinned: "joint", kind: "number", cpp: "joint" },
            { pinned: "x", kind: "number", cpp: "x" },
            { pinned: "y", kind: "number", cpp: "y" },
            { pinned: "z", kind: "number", cpp: "z" },
            {
                pinned: "wCoord",
                kind: "number",
                annotation: "0 | 1",
                cpp: "wCoord",
            },
            {
                pinned: "out",
                kind: "record",
                annotation: "[number, number, number]",
                cpp: "out",
                cppType: "std::array<double, 3>",
                mutableRecord: true,
                binding: { cpp: "out", type: "f64-buffer" },
            },
        ],
        {
            cppName: "transform_by_bone_to_ref",
            returns: "void",
            inline: true,
        },
    );
    // `weights[base + i] ?? 0` and `joints[base + i] ?? 0`: a slot of the
    // vertex rows, absent off an integer or past the end.
    const skinSlots = new Map(
        (["weights", "joints"] as const).map((array) => [
            array as string,
            (slot: string) => ({
                present: `deformed_vertex_detail::flat_slot(${slot}, geometry.vertices.size(), 4u)`,
                read: `deformed_vertex_detail::skin_${array === "weights" ? "weight" : "joint"}(geometry.vertices, ${slot})`,
            }),
        ]),
    );
    const skin = lowerPinnedFunction(
        context,
        mathModule,
        "skinVertexToRef",
        [
            {
                pinned: "boneMatrices",
                kind: "record",
                annotation: "Float32Array",
                cpp: "record",
                cppType: "MeshRecord",
                binding: { cpp: "record", type: "opaque" },
            },
            {
                pinned: "joints",
                kind: "record",
                annotation: "Uint16Array | Uint8Array",
                cpp: "geometry",
                cppType: "ModelGeometry",
                binding: { cpp: "geometry", type: "opaque" },
            },
            {
                pinned: "weights",
                kind: "record",
                annotation: "Float32Array",
                cpp: "geometry",
                cppType: "ModelGeometry",
                specialized: true,
                binding: { cpp: "geometry", type: "opaque" },
            },
            {
                pinned: "joints1",
                kind: "record",
                annotation: "Uint16Array | Uint8Array | null",
                cpp: "joints1",
                specialized: true,
                binding: absentBinding("null"),
            },
            {
                pinned: "weights1",
                kind: "record",
                annotation: "Float32Array | null",
                cpp: "weights1",
                specialized: true,
                binding: absentBinding("null"),
            },
            { pinned: "vertexIndex", kind: "number", cpp: "vertexIndex" },
            { pinned: "x", kind: "number", cpp: "x" },
            { pinned: "y", kind: "number", cpp: "y" },
            { pinned: "z", kind: "number", cpp: "z" },
            {
                pinned: "wCoord",
                kind: "number",
                annotation: "0 | 1",
                cpp: "wCoord",
            },
            {
                pinned: "out",
                kind: "record",
                annotation: "Float32Array",
                cpp: "out",
                cppType: "std::array<float, 3>",
                mutableRecord: true,
                binding: scratch,
            },
            { pinned: "outOffset", kind: "number", cpp: "outOffset" },
        ],
        {
            cppName: "skin_vertex_to_ref",
            returns: "void",
            inline: true,
            // The pin's module scratch for one bone transform.
            leadingParameters: ["std::array<double, 3>& bone_transform"],
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "_boneTransformScratch",
                    { cpp: "bone_transform", type: "f64-buffer" },
                ],
            ]),
            expression: (node, lowerer) =>
                nullishSlot(node, lowerer, skinSlots),
            calls: new Map([
                [
                    "transformByBoneToRef",
                    (args: readonly string[]) =>
                        `transform_by_bone_to_ref(record, ${args.slice(1, 6).join(", ")}, bone_transform)`,
                ],
            ]),
        },
    );
    const morph = lowerPinnedFunction(
        context,
        mathModule,
        "addMorphDelta",
        [
            {
                pinned: "morph",
                kind: "record",
                annotation: "MorphState",
                cpp: "geometry",
                cppType: "ModelGeometry",
                binding: { cpp: "geometry", type: "opaque" },
            },
            {
                pinned: "out",
                kind: "record",
                annotation: "Float32Array",
                cpp: "out",
                cppType: "std::array<float, 3>",
                mutableRecord: true,
                binding: scratch,
            },
            { pinned: "outOffset", kind: "number", cpp: "outOffset" },
            {
                pinned: "componentOffset",
                kind: "number",
                cpp: "componentOffset",
            },
            {
                pinned: "weightsOverride",
                kind: "record",
                annotation: "ArrayLike<number> | null",
                cpp: "weightsOverride",
                absent: true,
            },
        ],
        {
            cppName: "add_morph_delta",
            returns: "void",
            inline: true,
            leadingParameters: ["const MeshRecord& record"],
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "morph.count",
                    {
                        cpp: "static_cast<double>(geometry.morph_positions.size())",
                        type: "scalar",
                    },
                ],
                [
                    "morph.targets.length",
                    {
                        cpp: "static_cast<double>(geometry.morph_positions.size())",
                        type: "scalar",
                    },
                ],
                [
                    "positions",
                    {
                        cpp: "positions",
                        type: "opaque",
                        indexedRead: (owner, index) =>
                            `deformed_vertex_detail::delta_component(${owner}, ${index})`,
                    },
                ],
            ]),
            // `activeWeights[t] ?? 0`: a live weight, absent past the count.
            expression: (node, lowerer) =>
                nullishSlot(
                    node,
                    lowerer,
                    new Map([
                        [
                            "activeWeights",
                            (slot: string) => ({
                                present: `${slot} < static_cast<double>(deformed_vertex_detail::morph_weight_count(record))`,
                                read: `deformed_vertex_detail::morph_weight(record, ${slot})`,
                            }),
                        ],
                    ]),
                ),
            statement(statement, _lowerer, indent) {
                const active = localNamed(statement, "activeWeights");
                if (active) {
                    // The live weights: no caller supplies an override.
                    context.assertExpressionShape(
                        active.initializer!,
                        "weightsOverride ?? morph.weights",
                        "Morph delta weights",
                    );
                    return [];
                }
                const positions = localNamed(statement, "positions");
                if (positions) {
                    context.assertExpressionShape(
                        positions.initializer!,
                        "morph.targets[t]!.positions",
                        "Morph delta target",
                    );
                    return [
                        `${indent}const std::vector<Vec3>& positions = geometry.morph_positions[static_cast<std::size_t>(t)];`,
                    ];
                }
                return undefined;
            },
        },
    );
    const deform = lowerPinnedFunction(
        context,
        vertexModule,
        "deformVertexToRef",
        [
            {
                pinned: "mesh",
                kind: "record",
                annotation: "Mesh",
                cpp: "record",
                cppType: "MeshRecord",
                binding: { cpp: "record", type: "opaque" },
            },
            { pinned: "vertexIndex", kind: "number", cpp: "vertexIndex" },
            {
                pinned: "out",
                kind: "vec3",
                annotation: "Vec3",
                cpp: "out",
                cppType: "Vec3d",
                mutableRecord: true,
                binding: { cpp: "out", type: "vec3" },
            },
            {
                pinned: "pose",
                kind: "record",
                annotation: "DeformPose | null",
                cpp: "pose",
                specialized: true,
                binding: absentBinding("null"),
            },
        ],
        {
            cppName: "deform_vertex_to_ref",
            returns: {
                type: "bool",
                value: (_lowerer, expression) => {
                    const value = expression?.kind;
                    if (value === ts.SyntaxKind.TrueKeyword) return "true";
                    if (value === ts.SyntaxKind.FalseKeyword) return "false";
                    return context.contractError(
                        expression ?? compute,
                        "Expected deformVertexToRef to return a literal boolean.",
                    );
                },
            },
            inline: true,
            leadingParameters: ["const ModelGeometry& geometry"],
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "mesh._cpuPositions",
                    {
                        cpp: "geometry.vertices",
                        type: "opaque",
                        absentCpp: "geometry.vertices.empty()",
                        indexedRead: (owner, index) =>
                            `deformed_vertex_detail::position_component(${owner}, ${index})`,
                    },
                ],
                [
                    "base.length",
                    {
                        cpp: "static_cast<double>(geometry.vertices.size()) * 3.0",
                        type: "scalar",
                    },
                ],
                [
                    "mesh.morphTargets",
                    {
                        cpp: "geometry",
                        type: "opaque",
                        absentCpp: "geometry.morph_positions.empty()",
                    },
                ],
                [
                    "mesh.skeleton",
                    {
                        cpp: "record",
                        type: "opaque",
                        absentCpp: "!record.skinned",
                    },
                ],
                ["skeleton.boneMatrices", { cpp: "record", type: "opaque" }],
                ["skeleton.joints", { cpp: "geometry", type: "opaque" }],
                ["skeleton.weights", { cpp: "geometry", type: "opaque" }],
                // Native vertices carry four joints.
                ["skeleton.joints1", absentBinding("null")],
                ["skeleton.weights1", absentBinding("null")],
            ]),
            // No caller captured a pose: its weights are absent, which
            // add_morph_delta's absent override already is.
            expression: (node) =>
                context.expressionMatchesShape(node, "pose?.morphWeights")
                    ? "std::nullopt"
                    : undefined,
            statement(statement, lowerer, indent) {
                const local = localNamed(statement, "scratch");
                if (!local) return undefined;
                lowerer.bindLocal(local.name as ts.Identifier, {
                    cpp: "scratch",
                    type: "f32",
                });
                context.assertExpressionShape(
                    local.initializer!,
                    "(_deformScratch ??= new Float32Array(3))",
                    "Deformed vertex scratch",
                );
                // The pin's two module scratches: the vertex's Float32Array,
                // and the plain array one bone transform lands in.
                return [
                    `${indent}std::array<float, 3> scratch{};`,
                    `${indent}std::array<double, 3> bone_transform{};`,
                ];
            },
            calls: new Map([
                [
                    "addMorphDelta",
                    (args: readonly string[]) =>
                        `add_morph_delta(record, geometry, scratch, ${args[2]}, ${args[3]})`,
                ],
                [
                    "skinVertexToRef",
                    (args: readonly string[]) =>
                        `skin_vertex_to_ref(bone_transform, record, geometry, ${args.slice(5, 10).join(", ")}, scratch, ${args[11]})`,
                ],
            ]),
        },
    );
    return `// ${context.provenance(vertexModule, "computeDeformedPositionToRef", `${vertexModule}#deformVertexToRef, ${mathModule}#addMorphDelta, ${mathModule}#skinVertexToRef and ${mathModule}#transformByBoneToRef`)}
${views}
${transform}
${skin}
${morph}
${deform}
DeformedPosition compute_deformed_position(const Engine& engine, MeshHandle mesh, double vertex_index,
                                           Vec3d out) {
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (record.geometry >= engine.geometries.size()) return {false, out};
    const bool found = deform_vertex_to_ref(engine.geometries[record.geometry], record, vertex_index, out);
    return {found, out};
}
`;
}
