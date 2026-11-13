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
 *    `previousMorph`;
 *  - for a program whose Standard velocity views compose both arms, the
 *    task preload that loads the deformation feature
 *    (`preloadGeometryDeformationVelocity`) and the program-wide flag it
 *    sets, which picks the arm a Standard renderable is built with.
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

const GEOMETRY_DEFORMATION_HOOKS_MODULE =
    "src/material/geometry-deformation-hooks.ts";
const STANDARD_GEOMETRY_VIEW_MODULE = "src/material/standard/geometry-view.ts";
const GEOMETRY_RENDERER_TASK_MODULE =
    "src/frame-graph/geometry-renderer-task.ts";
const STANDARD_GEOMETRY_RENDERABLE_MODULE =
    "src/material/standard/standard-geometry-renderable.ts";
const STANDARD_GEOMETRY_OUTPUT_MODULE =
    "src/material/standard/standard-geometry-output-shader.ts";
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

    /**
     * `preload`: the program's Standard velocity views compose both arms
     * (`StandardSceneComposition.velocityArms`), so the run-time preload
     * decides between them.
     */
    public header(preload = false): string {
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
                ...(preload ? ["<string_view>"] : []),
                "<vector>",
            ],
            [
                ...(preload ? [this.loadedFeature()] : []),
                this.enabler(preload),
                this.invert(),
                this.velocity(),
                this.deformation(),
                ...(preload ? [this.preload()] : []),
            ].join("\n\n"),
        );
    }

    /**
     * A geometry task's `_preload` and the deformation feature it loads. The
     * task's mesh list is the scene's (a native task takes no `meshes`); its
     * Standard family's preload hands it `preloadGeometryDeformationVelocity`,
     * which loads the feature once, for the program, when the task writes
     * velocity and a listed mesh is skinned or morphed and neither instanced
     * nor baked. The families are the task's material bridges: a family
     * first appearing after the preload re-runs it (`_lateLoad`).
     */
    private preload(): string {
        const context = this.context;
        const hooks = context.functionDeclaration(
            GEOMETRY_DEFORMATION_HOOKS_MODULE,
            "preloadGeometryDeformationVelocity",
        ).declaration;
        context.assertStatementShapes(
            hooks,
            hooks.body!.statements,
            "if (velocity && !_feature && meshes.some((mesh) => !mesh.thinInstances && !mesh.vat && (!!mesh.skeleton || !!mesh.morphTargets))) { " +
                '_feature = await import("./geometry-deformation-velocity.js"); }',
            "Geometry deformation velocity preload",
        );
        const standard = context.functionDeclaration(
            STANDARD_GEOMETRY_VIEW_MODULE,
            "preloadStandardGeometryFeatures",
        ).declaration;
        if (
            !context.hasNode(standard, (node) =>
                sameSource(
                    node,
                    "loads.push(preloadGeometryDeformationVelocity(meshes, needsVelocity))",
                ),
            )
        )
            context.contractError(
                standard,
                "Expected the Standard geometry preload to hand its mesh list to the deformation preload.",
            );
        const task = context.functionDeclaration(
            GEOMETRY_RENDERER_TASK_MODULE,
            "createGeometryRendererTask",
        ).declaration;
        const preloads = context.findNodes(
            task,
            (node): node is ts.MethodDeclaration =>
                ts.isMethodDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "_preload",
        );
        if (preloads.length !== 1)
            context.contractError(
                task,
                "Expected the geometry task's one _preload.",
            );
        const preload = preloads[0]!;
        context.assertExpressionShape(
            context.variableInitializer(preload.body!, "meshes"),
            "(config.meshes ?? sc.meshes) as readonly Mesh[]",
            "Geometry task preload meshes",
        );
        context.assertExpressionShape(
            context.variableInitializer(preload.body!, "family"),
            "resolveMaterialFamily(mesh.material)",
            "Geometry task preload family",
        );
        const standardCensus = context.findNodes(
            preload,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                sameSource(node.expression, 'family === "standard"'),
        );
        if (
            standardCensus.length !== 1 ||
            !context.hasNode(standardCensus[0]!.thenStatement, (node) =>
                sameSource(node, "hasStandard = true"),
            )
        )
            context.contractError(
                preload,
                "Expected the geometry task preload's family census.",
            );
        if (
            !context.hasNode(preload, (node) =>
                sameSource(
                    node,
                    "viewMod.preloadStandardGeometryFeatures(meshes, task._needsVelocity)",
                ),
            ) ||
            !context.hasNode(
                preload,
                (node) =>
                    ts.isIfStatement(node) &&
                    sameSource(node.expression, "hasStandard"),
            )
        )
            context.contractError(
                preload,
                "Expected the geometry task preload to run the Standard preload over its meshes when a Standard mesh is listed.",
            );
        const morphContext = `#${pinnedErrorCodeOf(
            context,
            "standard-geometry: morph targets require the scene Standard morph context",
            context.functionDeclaration(
                STANDARD_GEOMETRY_RENDERABLE_MODULE,
                "_ensureViewResources",
            ).declaration,
        )}`;
        const notPreloaded = `#${pinnedErrorCodeOf(
            context,
            "Standard geometry deformation velocity was not preloaded.",
            context.functionDeclaration(
                STANDARD_GEOMETRY_OUTPUT_MODULE,
                "createGeometryFragment",
            ).declaration,
        )}`;
        return `// ${context.provenance(GEOMETRY_DEFORMATION_HOOKS_MODULE, "preloadGeometryDeformationVelocity")}
inline void preload_geometry_deformation_velocity(const Engine& engine, std::span<const MeshHandle> meshes, bool velocity) {
    if (velocity && !geometry_deformation_velocity_loaded &&
        std::any_of(meshes.begin(), meshes.end(), [&](MeshHandle mesh) {
            if (mesh.value >= engine.meshes.size())
                return false;
            const MeshRecord& record = handle_at(engine.meshes, mesh);
            return !record.thin_instances && !record.has_vat &&
                   (record.skeleton_attached || record.morph_targets_attached || record.scene_morph_targets);
        })) {
        geometry_deformation_velocity_loaded = true;
    }
}

/** \`resolveMaterialFamily\`, one bit per family a geometry task bridges. */
inline constexpr std::uint32_t geometry_family_standard = 1u;
inline constexpr std::uint32_t geometry_family_pbr = 2u;
inline constexpr std::uint32_t geometry_family_node = 4u;

/** The families the task's mesh list draws. */
inline std::uint32_t geometry_task_families(const Engine& engine, std::span<const MeshHandle> meshes) {
    std::uint32_t families = 0;
    for (const MeshHandle mesh : meshes) {
        if (mesh.value >= engine.meshes.size())
            continue;
        const MaterialHandle material = handle_at(engine.meshes, mesh).material;
        if (material.value >= engine.materials.size())
            continue;
        const std::string_view family = material_family_name(handle_at(engine.materials, material));
        families |= family == "standard" ? geometry_family_standard
                    : family == "pbr"    ? geometry_family_pbr
                    : family == "node"   ? geometry_family_node
                                         : 0u;
    }
    return families;
}

// ${context.provenance(GEOMETRY_RENDERER_TASK_MODULE, "createGeometryRendererTask", "its _preload")}
// Returns the families it bridged.
inline std::uint32_t preload_geometry_task(const Engine& engine, const Scene& scene, const GeometryTaskOptions& task) {
    const std::span<const MeshHandle> meshes(scene.meshes);
    const std::uint32_t families = geometry_task_families(engine, meshes);
    if (families & geometry_family_standard) {
        preload_geometry_deformation_velocity(
            engine, meshes,
            std::any_of(task.attachments.begin(), task.attachments.end(), [](const GeometryTextureDescription& attachment) {
                return attachment.type == GeometryTextureType::linear_velocity;
            }));
    }
    return families;
}

// ${context.provenance(STANDARD_GEOMETRY_RENDERABLE_MODULE, "_ensureViewResources", `${STANDARD_GEOMETRY_OUTPUT_MODULE}#createGeometryFragment`)}
// A Standard velocity view of a skinned or morphed mesh composed before any
// preload loaded the feature. A morphed one first needs the scene's Standard
// morph context, which only a morphed mesh the preload skips (instanced or
// baked, which a geometry task here refuses) could have given it; a skinned
// one is the composer's own refusal.
inline void require_standard_deformation_velocity(bool morphed) {
    if (geometry_deformation_velocity_loaded)
        return;
    throw std::runtime_error(morphed ? ${stringLiteral(morphContext)} : ${stringLiteral(notPreloaded)});
}`;
    }

    /**
     * The enabler's task state. Its refusals of a missing attachment, a
     * changed contract, a non-RGBA target and a registered scene are
     * generation's (`intrinsics/geometry-velocity.ts`); the camera check runs
     * where the task validates its camera, every executed frame.
     */
    /** The pin's module state `_feature`, program-wide as the module is. */
    private loadedFeature(): string {
        return `// ${this.context.provenance(GEOMETRY_DEFORMATION_HOOKS_MODULE, "_feature")}
inline bool geometry_deformation_velocity_loaded = false;`;
    }

    private enabler(preload: boolean): string {
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
        if (
            !context.hasNode(declaration, (node) =>
                sameSource(
                    node,
                    "installGeometryDeformationVelocity(deformation, pbrVelocity.geometryVelocityOutput)",
                ),
            )
        )
            context.contractError(
                declaration,
                "Expected enableGeometryVelocity to install the deformation feature.",
            );
        return `// ${context.provenance(GEOMETRY_VELOCITY_MODULE, "enableGeometryVelocity")}
// The contract is recorded once; its params lane is \`cameraNearFar.z\`.
inline void enable_geometry_velocity(Engine& engine, TaskHandle task, bool previous_depth) {
    FrameTaskRecord& record = handle_at(engine.frame_tasks, task);
    if (record.kind != FrameTaskKind::geometry)
        throw std::runtime_error("enableGeometryVelocity requires a geometry renderer task.");
    record.geometry.velocity_previous_depth = previous_depth;${
        preload
            ? `
    // \`installGeometryDeformationVelocity\`: the feature, for the program.
    geometry_deformation_velocity_loaded = true;`
            : ""
    }
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
        const declared = (name: string): ts.VariableStatement =>
            context.declaredVariable(statements, name).statement!;
        const initializer = (name: string): ts.Expression =>
            context.declaredVariable(statements, name).initializer;
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
        const updateBody = lowerPinnedBody(file, update.body.statements, scope);
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
            update.body.statements;
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
