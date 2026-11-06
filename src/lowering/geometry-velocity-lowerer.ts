/**
 * `enableGeometryVelocity`'s per-frame behaviour, lowered from its modules.
 *
 * What the enabler installs into composition is the composer's
 * (`pinned-geometry-velocity.ts`). What it installs on the task, and what a
 * velocity renderable does every frame, is emitted here as
 * `geometry_velocity.hpp`:
 *
 *  - the enabler's task state: the previous-depth flag its params block
 *    carries (`_paramsData[18]`) and the perspective-camera check it wraps
 *    around `_validateCamera`;
 *  - `createPbrGeometryVelocity`: its construction statements and its
 *    `_update(worldChanged)`, translated from the pinned AST, over a state
 *    record mirroring its closure;
 *  - `createGeometryDeformationVelocity`'s `_update(neutral)`: the previous
 *    pose snapshots the vertex stage reads through `previousBoneSampler` and
 *    `previousMorph`.
 *
 * Every statement that creates, binds or uploads is asserted and answered
 * through a callback the backend supplies (`deformation`, `write`,
 * `write_bones`, `write_morph`), so a pin that grows one fails generation by
 * name. The renderable lifetime (built at a sync, carried while its forward
 * renderable stands) is the shared velocity history's
 * (`pal_gpu_velocity.hpp`).
 */
import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { sameSource } from "../compiler/syntax.js";
import { finalReturn } from "../compiler/loop-control.js";
import {
    GEOMETRY_DEFORMATION_VELOCITY_MODULE,
    GEOMETRY_VELOCITY_MODULE,
    PBR_GEOMETRY_VELOCITY_MODULE,
} from "../pinned-geometry-velocity.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";
import { pinnedErrorCode, pinnedErrorCodeOf } from "./pinned-error.js";

/** `createPbrGeometryVelocity`'s closure state, by the pin's names. */
const VELOCITY_STATE: ReadonlyMap<string, PinnedBinding> = new Map([
    ["inverseWorld", { cpp: "state.inverse_world", type: "f32" }],
    ["singularWorld", { cpp: "state.singular_world", type: "bool" }],
    ["previousWorld", { cpp: "state.previous_world", type: "f32" }],
    ["data", { cpp: "state.data", type: "f32" }],
    ["ready", { cpp: "state.ready", type: "bool" }],
    ["previousMotion", { cpp: "state.previous_motion", type: "bool" }],
]);

/** The returned object literal's method, by name. */
function returnedMethod(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    name: string,
): ts.MethodDeclaration & { body: ts.Block } {
    const returned = finalReturn(declaration.body)?.expression;
    const literal = returned && context.unwrapExpression(returned);
    if (!literal || !ts.isObjectLiteralExpression(literal))
        return context.contractError(
            declaration,
            `Expected ${declaration.name?.text ?? "the factory"} to return a record.`,
        );
    return context.objectMethod(literal, name);
}

/** The pin's error call spelling `message` inside `owner`, as its source reads. */
function pinnedThrow(
    context: LoweringContext,
    owner: ts.Node,
    message: string,
): string {
    return `ThrowLiteError(${pinnedErrorCodeOf(context, message, owner)});`;
}

export class GeometryVelocityLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        return pinnedHeader(
            [
                "<bblite/runtime.hpp>",
                "<bblite/upstream/pinned_matrix.hpp>",
                "",
                "<algorithm>",
                "<array>",
                "<cmath>",
                "<cstddef>",
                "<cstdint>",
                "<span>",
                "<stdexcept>",
                "<vector>",
            ],
            [
                this.enabler(),
                this.invert(),
                this.velocity(),
                this.deformation(),
            ].join("\n\n"),
        );
    }

    /**
     * The enabler's task state. Its refusals of a missing attachment, a
     * changed contract, a non-RGBA target and a registered scene are
     * generation's (`intrinsics/geometry-velocity.ts`); the camera check runs
     * where the task validates its camera, every executed frame.
     */
    private enabler(): string {
        const context = this.context;
        const { declaration } = context.functionDeclaration(
            GEOMETRY_VELOCITY_MODULE,
            "enableGeometryVelocity",
        );
        const flag = context.findNodes(
            declaration,
            (node): node is ts.ExpressionStatement =>
                ts.isExpressionStatement(node) &&
                sameSource(
                    node.expression,
                    "task._paramsData[18] = previousDepth ? 1 : 0",
                ),
        );
        const validation = context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                sameSource(node.expression, "camera.ortho"),
        );
        if (flag.length !== 1 || validation.length !== 1) {
            context.contractError(
                declaration,
                "Expected enableGeometryVelocity to set the params block's " +
                    "previous-depth lane and to refuse an orthographic camera.",
            );
        }
        context.assertStatementShapes(
            declaration,
            [validation[0]!],
            `if (camera.ortho) { ${pinnedThrow(context, validation[0]!, "Geometry previous-depth velocity requires a perspective camera.")} }`,
            "Geometry previous-depth camera",
        );
        const orthographic = `#${pinnedErrorCode(context, validation[0]!)}`;
        return `// ${context.provenance(GEOMETRY_VELOCITY_MODULE, "enableGeometryVelocity")}
// The contract is recorded once; its params lane is \`cameraNearFar.z\`.
inline void enable_geometry_velocity(Engine& engine, TaskHandle task, bool previous_depth) {
    FrameTaskRecord& record = handle_at(engine.frame_tasks, task);
    if (record.kind != FrameTaskKind::geometry)
        throw std::runtime_error("enableGeometryVelocity requires a geometry renderer task.");
    record.geometry.velocity_previous_depth = previous_depth;
}

/** The previous-depth lane \`task._paramsData[18]\`. */
inline float geometry_velocity_previous_depth_lane(const GeometryTaskOptions& task) {
    return task.velocity_previous_depth.value_or(false) ? 1.0f : 0.0f;
}

/** The \`_validateCamera\` the enabler installs under previous depth. */
inline void validate_geometry_velocity_camera(const GeometryTaskOptions& task, const CameraRecord& camera) {
    if (task.velocity_previous_depth.value_or(false) && camera.orthographic)
        throw std::runtime_error(${stringLiteral(orthographic)});
}`;
    }

    private invert(): string {
        return lowerPinnedFunction(
            this.context,
            "src/math/invert-mat4-to-ref.ts",
            "tryInvertMat4ToRef",
            [
                {
                    pinned: "input",
                    kind: "mat4Const",
                    annotation: "Mat4Storage",
                    cpp: "input",
                    cppType: "Matrix",
                },
                {
                    pinned: "result",
                    kind: "mat4",
                    annotation: "Mat4Storage",
                    cpp: "result",
                },
            ],
            {
                cppName: "try_invert_mat4_to_ref",
                inline: true,
                templateParameters: ["typename Matrix"],
                calls: new Map(),
                returns: {
                    type: "bool",
                    value: (lowerer, expression) =>
                        expression
                            ? lowerer.expression(expression)
                            : this.context.contractError(
                                  this.context.functionDeclaration(
                                      "src/math/invert-mat4-to-ref.ts",
                                      "tryInvertMat4ToRef",
                                  ).declaration,
                                  "Expected tryInvertMat4ToRef to return a boolean.",
                              ),
                },
            },
        );
    }

    private velocity(): string {
        const context = this.context;
        const { file, declaration } = context.functionDeclaration(
            PBR_GEOMETRY_VELOCITY_MODULE,
            "createPbrGeometryVelocity",
        );
        const statements = declaration.body!.statements;
        const declared = (name: string): ts.VariableStatement => {
            const found = statements.filter(
                (statement): statement is ts.VariableStatement =>
                    ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.length === 1 &&
                    ts.isIdentifier(
                        statement.declarationList.declarations[0]!.name,
                    ) &&
                    statement.declarationList.declarations[0]!.name.text ===
                        name,
            );
            if (found.length !== 1) {
                return context.contractError(
                    declaration,
                    `Expected createPbrGeometryVelocity to declare '${name}' once.`,
                );
            }
            return found[0]!;
        };
        const initializer = (name: string): ts.Expression =>
            declared(name).declarationList.declarations[0]!.initializer!;
        context.assertExpressionShape(
            initializer("tracked"),
            "(): boolean => mesh.visible !== false && !exclusions?.has(mesh)",
            "Geometry velocity tracking",
        );
        context.assertExpressionShape(
            initializer("inverseWorld"),
            "new F32(16)",
            "Geometry velocity inverse world",
        );
        context.assertExpressionShape(
            initializer("previousWorld"),
            "new F32(currentWorld)",
            "Geometry velocity previous world",
        );
        context.assertExpressionShape(
            initializer("data"),
            "new F32(20)",
            "Geometry velocity block",
        );
        for (const name of ["ready", "previousMotion"]) {
            context.assertExpressionShape(
                initializer(name),
                "false",
                `Geometry velocity '${name}'`,
            );
        }
        const singular = declared("singularWorld");
        const singularIndex = statements.indexOf(singular);
        const refusal = statements[singularIndex + 1];
        context.assertStatementShapes(
            declaration,
            [singular, refusal!],
            "let singularWorld = !tryInvertMat4ToRef(currentWorld, inverseWorld); " +
                `if (singularWorld && tracked()) { ${pinnedThrow(context, refusal!, "PBR geometry velocity cannot reproject a singular world transform.")} }`,
            "Geometry velocity singular world",
        );
        const blockIdentity = statements.indexOf(declared("data")) + 1;
        context.assertStatementShapes(
            declaration,
            [statements[blockIdentity]!],
            "data[0] = data[5] = data[10] = data[15] = 1;",
            "Geometry velocity block identity",
        );
        const update = returnedMethod(context, declaration, "_update");
        if (
            !context.hasNode(update, (node) =>
                sameSource(
                    node,
                    "multiplyMat4IntoBuffer(data, 0, previousWorld, 0, inverseWorld, 0)",
                ),
            )
        ) {
            context.contractError(
                update,
                "Expected the velocity block's previous-from-current product at offset zero.",
            );
        }
        const calls = new Map([
            [
                "tryInvertMat4ToRef",
                (args: readonly string[]) =>
                    `try_invert_mat4_to_ref(${args.join(", ")})`,
            ],
            ["tracked", () => "tracked"],
            [
                "multiplyMat4IntoBuffer",
                (args: readonly string[]) =>
                    `pbr_geometry_velocity_product(${args[0]}, ${args[2]}, ${args[4]})`,
            ],
        ]);
        const bindings = new Map<string, PinnedBinding>([
            ...VELOCITY_STATE,
            ["currentWorld", { cpp: "current_world", type: "f32" }],
            ["worldChanged", { cpp: "world_changed", type: "bool" }],
        ]);
        const scope = {
            bindings,
            calls,
            methods: new Map([
                // `previousWorld.set(currentWorld)`: both are sixteen floats.
                [
                    "set",
                    (receiver: string, args: readonly string[]) =>
                        `std::copy(${args[0]}.begin(), ${args[0]}.end(), ${receiver}.begin())`,
                ],
                [
                    "fill",
                    (receiver: string, args: readonly string[]) =>
                        `std::fill(${receiver}.begin(), ${receiver}.end(), static_cast<float>(${args[0]}))`,
                ],
            ]),
            statement: (
                statement: ts.Statement,
                _lowerer: PinnedNumericLowerer,
                indent: string,
            ): readonly string[] | undefined => {
                if (!ts.isExpressionStatement(statement)) return undefined;
                const expression = context.unwrapExpression(
                    statement.expression,
                );
                if (
                    sameSource(
                        expression,
                        "deformationVelocity?._update(!enabled)",
                    )
                ) {
                    return [`${indent}deformation(!enabled);`];
                }
                if (
                    sameSource(
                        expression,
                        "device.queue.writeBuffer(previousWorldUBO, 0, data as Float32Array<ArrayBuffer>)",
                    )
                ) {
                    return [`${indent}write();`];
                }
                return undefined;
            },
        };
        const creation = lowerPinnedBody(
            file,
            [refusal!, statements[blockIdentity]!],
            scope,
        );
        const updateBody = lowerPinnedBody(
            file,
            update.body!.statements,
            scope,
        );
        return `/** \`createPbrGeometryVelocity\`'s closure state; \`data\` is the \`gm\` block. */
struct PbrGeometryVelocity {
    std::array<float, 16> inverse_world{};
    bool singular_world = false;
    std::array<float, 16> previous_world{};
    std::array<float, 20> data{};
    bool ready = false;
    bool previous_motion = false;
};

/** \`multiplyMat4IntoBuffer(data, 0, a, 0, b, 0)\` over the block's matrix lanes. */
template <typename MatA, typename MatB>
inline void pbr_geometry_velocity_product(std::array<float, 20>& data, const MatA& a, const MatB& b) {
    std::array<float, 16> product{};
    mat4_multiply_into(product, 0, a, 0, b, 0);
    std::copy(product.begin(), product.end(), data.begin());
}

// ${context.provenance(PBR_GEOMETRY_VELOCITY_MODULE, "createPbrGeometryVelocity", "its construction")}
// \`current_world\` is the packed world the renderable's mesh block holds.
inline PbrGeometryVelocity create_pbr_geometry_velocity(const std::array<float, 16>& current_world, bool tracked) {
    PbrGeometryVelocity state;
    state.singular_world = !try_invert_mat4_to_ref(current_world, state.inverse_world);
    state.previous_world = current_world;
${creation}
    return state;
}

// ${context.provenance(PBR_GEOMETRY_VELOCITY_MODULE, "createPbrGeometryVelocity", "its _update")}
// \`deformation(neutral)\` advances the previous pose; \`write()\` uploads \`state.data\`.
template <typename Deformation, typename Write>
void update_pbr_geometry_velocity(PbrGeometryVelocity& state, const std::array<float, 16>& current_world, bool world_changed, bool tracked, Deformation&& deformation, Write&& write) {
${updateBody}
}`;
    }

    /**
     * The deformation `_update(neutral)`. Its first two statements refuse a
     * disposed pose and a replaced skeleton or morph set; no native mesh
     * disposes or replaces either, so both are asserted and hold.
     */
    private deformation(): string {
        const context = this.context;
        const { declaration } = context.functionDeclaration(
            GEOMETRY_DEFORMATION_VELOCITY_MODULE,
            "createGeometryDeformationVelocity",
        );
        const update = returnedMethod(context, declaration, "_update");
        const [disposed, changed, skeleton, morph, ...rest] =
            update.body!.statements;
        if (rest.length > 0) {
            context.contractError(
                update,
                "Expected the deformation update's four statements.",
            );
        }
        context.assertStatementShapes(
            update,
            [disposed!, changed!],
            "if (disposed || skeleton?._disposed || morph?._disposed) { " +
                `${pinnedThrow(context, disposed!, "Geometry deformation velocity cannot use disposed pose resources.")} } ` +
                "if (mesh.skeleton !== sourceSkeleton || mesh.morphTargets !== morph) { " +
                `${pinnedThrow(context, changed!, "Geometry deformation source changed; rebuild its geometry renderable.")} }`,
            "Geometry deformation velocity guards",
        );
        context.assertStatementShapes(
            update,
            [skeleton!, morph!],
            "if (skeleton) { if (neutral) { boneSnapshot!.set(skeleton.boneMatrices); } " +
                "device.queue.writeTexture({ texture: previousBones! }, boneSnapshot!, { bytesPerRow: skeleton.boneCount * 64 }, [skeleton.boneCount * 4, 1]); " +
                "boneSnapshot!.set(skeleton.boneMatrices); } " +
                "if (morph) { if (neutral) { morphSnapshot!.set(morph.weights); } " +
                "device.queue.writeBuffer(previousMorph!, 0, morphSnapshot!); " +
                "morphSnapshot!.set(morph.weights); }",
            "Geometry deformation velocity snapshots",
        );
        for (const [name, source] of [
            [
                "boneSnapshot",
                "skeleton ? new F32(skeleton.boneMatrices) : null",
            ],
            ["morphSnapshot", "morph ? new F32(morph.weights) : null"],
        ] as const) {
            context.assertExpressionShape(
                context.variableInitializer(declaration.body!, name),
                source,
                `Geometry deformation '${name}'`,
            );
        }
        return `/**
 * \`createGeometryDeformationVelocity\`'s snapshots, made from the pose at
 * the renderable's build; empty for an absent skeleton or morph set.
 */
struct GeometryDeformationVelocity {
    std::vector<float> bones;
    std::vector<float> morph;
};

inline GeometryDeformationVelocity create_geometry_deformation_velocity(std::span<const float> bones, std::span<const float> weights) {
    return {{bones.begin(), bones.end()}, {weights.begin(), weights.end()}};
}

// ${context.provenance(GEOMETRY_DEFORMATION_VELOCITY_MODULE, "createGeometryDeformationVelocity", "its _update")}
// \`bones\`/\`weights\` are the live pose; \`write_bones\`/\`write_morph\` upload a snapshot.
template <typename WriteBones, typename WriteMorph>
void update_geometry_deformation_velocity(GeometryDeformationVelocity& state, bool neutral, std::span<const float> bones, std::span<const float> weights, WriteBones&& write_bones, WriteMorph&& write_morph) {
    if (!bones.empty()) {
        if (neutral) {
            state.bones.assign(bones.begin(), bones.end());
        }
        write_bones(std::span<const float>(state.bones));
        state.bones.assign(bones.begin(), bones.end());
    }
    if (!weights.empty()) {
        if (neutral) {
            state.morph.assign(weights.begin(), weights.end());
        }
        write_morph(std::span<const float>(state.morph));
        state.morph.assign(weights.begin(), weights.end());
    }
}`;
    }
}
