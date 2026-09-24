import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { CameraMutationLowerer } from "./camera-mutation-lowerer.js";
import { lowerFreeCameraControls } from "./configurable-camera-controls.js";
import {
    lowerWorldAabbHelpers,
    worldAabbLaneBindings,
} from "./world-bounds-lowerer.js";

import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { pinnedHeader } from "./pinned-header.js";
import {
    lowerObjectComponents,
    lowerPinnedFunction,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";

const arcRotateEyeMembers = [
    "alpha",
    "beta",
    "radius",
    "target.x",
    "target.y",
    "target.z",
] as const;

export class CameraLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * The parented-world composition `camera_world_matrix` mirrors when a
     * record carries a parent: the pinned `getWorldMatrix`
     * (src/scene/world-matrix-state.ts) multiplies the parent's world by
     * the local through `multiplyMat4IntoBuffer(out, 0, parent, 0, local, 0)`.
     * The operand order is the whole contract — swapping it composes the
     * camera on the wrong side of its fixup node — so this reads the
     * pin's one multiply call and requires the parent world third and the
     * local matrix fifth.
     */
    private assertParentWorldComposition(): void {
        const module = "src/scene/world-matrix-state.ts";
        const file = this.context.sourceFile(module);
        const multiplies = this.context.findNodes(
            file,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "multiplyMat4IntoBuffer",
        );
        if (multiplies.length !== 1) {
            this.context.contractError(
                multiplies[1] ?? file,
                "Expected one world composition multiply in world-matrix-state.",
            );
        }
        const call = multiplies[0]!;
        const operand = (index: number): ts.Expression =>
            this.context.unwrapExpression(call.arguments[index]!);
        const parentOperand = operand(2);
        const localOperand = operand(4);
        let composition: ts.Node = call;
        while (composition.parent && !ts.isMethodDeclaration(composition))
            composition = composition.parent;
        if (
            call.arguments.length !== 6 ||
            !ts.isIdentifier(parentOperand) ||
            !ts.isIdentifier(localOperand)
        ) {
            this.context.contractError(
                call,
                "Expected the pinned world composition to multiply two named matrices at offset zero.",
            );
        }
        if (
            !this.context.expressionMatchesShape(
                this.context.variableInitializer(
                    composition,
                    parentOperand.text,
                ),
                "_parent.worldMatrix",
            ) ||
            !this.context.expressionMatchesShape(
                this.context.unwrapExpression(
                    this.context.variableInitializer(
                        composition,
                        localOperand.text,
                    ),
                ),
                "_cachedLocal ??= getLocalMatrix()",
            )
        ) {
            this.context.contractError(
                call,
                "Expected the pinned world composition to take the parent world on the left and the local matrix on the right.",
            );
        }
    }

    /**
     * The up vector both public factories look at their target against
     * (`Vec3Up`, the constant `createArcRotateCamera` and `createFreeCamera`
     * hand the camera-to-world writer): the record default the ArcRotate
     * factory stores, so a banked free camera can carry the caller's own
     * in the same slot.
     */
    private readPinnedUpVector(): { x: number; y: number; z: number } {
        const upModule = "src/math/vec3-up.ts";
        const upFile = this.context.sourceFile(upModule);
        const upInitializer = this.context.variableInitializer(
            upFile,
            "Vec3Up",
        );
        const up = this.context.unwrapExpression(upInitializer);
        if (!ts.isObjectLiteralExpression(up)) {
            this.context.contractError(
                upInitializer,
                "Expected Vec3Up to be an object literal.",
            );
        }
        const component = (name: "x" | "y" | "z"): number =>
            this.context.numericValue(
                this.context.propertyInitializer(up, name),
                upFile,
            );
        return {
            x: component("x"),
            y: component("y"),
            z: component("z"),
        };
    }

    /**
     * `writeLookAtWorldMat4LHIntoBuffer` translated whole, at the width the camera's
     * world is kept at. The pin's `allocateMat4()` storage is a Float32Array
     * by default and a Float64Array once an engine asks for
     * `useHighPrecisionMatrix`, and the translation binds `out` to the store
     * width of whichever this scene's engine asked for: an f32 store rounds
     * where the pin's does, and the F64 store carries the unrounded basis to
     * the view transpose. The degenerate-length epsilons, the cross
     * products and the identity fallback all come from the declaration.
     */
    private lowerLookAtWorld(highPrecisionMatrix: boolean): string {
        const vector = (name: string): PinnedFunctionParameter => ({
            pinned: name,
            kind: "vec3",
            cpp: name,
        });
        return lowerPinnedFunction(
            this.context,
            "src/math/write-look-at-world-mat4-lh-into-buffer.ts",
            "writeLookAtWorldMat4LHIntoBuffer",
            [
                {
                    pinned: "out",
                    kind: highPrecisionMatrix ? "mat4F64" : "mat4",
                    cpp: "out",
                    cppType: "std::array<CameraMatrixScalar, 16>",
                    mutableRecord: true,
                },
                vector("eye"),
                vector("target"),
                vector("up"),
            ],
            {
                cppName: "mat4_look_at_world_lh_to_ref",
                returns: "void",
                calls: pinnedNumericMathCalls(),
            },
        );
    }

    /**
     * The ArcRotate's eye, translated whole from the `localEyePosition`
     * the pinned factory declares inside itself over the record it closes
     * over: the pole fallback, the trigonometry and the target offset all
     * come from that declaration, with `cam` read as the native record.
     */
    private lowerArcRotateEye(): string {
        const module = "src/camera/arc-rotate.ts";
        const symbol = "localEyePosition";
        const members = new Map<string, PinnedBinding>(
            arcRotateEyeMembers.map((member): [string, PinnedBinding] => [
                `cam.${member}`,
                { cpp: `camera.${member}`, type: "scalar" },
            ]),
        );
        return lowerPinnedFunction(this.context, module, symbol, [], {
            cppName: "arc_rotate_local_eye_position",
            enclosing: "createArcRotateCamera",
            leadingParameters: ["const CameraRecord& camera"],
            calls: pinnedNumericMathCalls(),
            memberBindings: members,
            returns: {
                type: "Vec3d",
                value: (lowerer, expression) =>
                    `Vec3d{${lowerObjectComponents(
                        this.context,
                        lowerer,
                        expression ??
                            this.context.contractError(
                                this.context.functionDeclaration(
                                    module,
                                    "createArcRotateCamera",
                                ).declaration,
                                `Expected pinned ${symbol} to return a value.`,
                            ),
                        ["x", "y", "z"],
                    ).join(", ")}}`,
            },
        });
    }

    public lowerArcRotateFactory(
        gltfCameras = false,
        highPrecisionMatrix = false,
        geospatial = false,
    ): LoweredSource {
        const modulePath = "src/camera/arc-rotate.ts";
        const symbolName = "createArcRotateCamera";
        // Anchored rather than transcribed: `camera_position` below is
        // this two-line function, and a pin that stopped reading the
        // world matrix would have to fail here.
        const positionModule = "src/camera/camera.ts";
        const positionSymbol = "getCameraPosition";
        this.context.functionDeclaration(positionModule, positionSymbol);
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const upVector = this.readPinnedUpVector();
        const camera = this.context.objectInitializer(declaration, "cam");
        const number = (name: string): string =>
            this.context.doubleLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(camera, name),
                    file,
                ),
            );
        if (gltfCameras) {
            this.assertParentWorldComposition();
        }
        const parentArm = gltfCameras
            ? `
// src/scene/world-matrix-state.ts getWorldMatrix: with a parent the world
// is multiplyMat4IntoBuffer(out, 0, parent.worldMatrix, 0, local, 0) — parent
// on the left, the camera's own look-at local on the right. The record's
// parent_world is the imported camera's fixup-node world, written by the
// glTF loader.
std::array<CameraMatrixScalar, 16> camera_parented_world(
    const CameraRecord& camera,
    const std::array<CameraMatrixScalar, 16>& local) {
    std::array<CameraMatrixScalar, 16> world{};
    mat4_multiply_into(world, 0, camera.parent_world, 0, local, 0);
    return world;
}
`
            : "";
        return {
            modulePath,
            symbolName,
            header: pinnedHeader(
                ["<bblite/runtime.hpp>", "", "<array>"],
                `
Vec3d arc_rotate_eye_position(const CameraRecord& camera);
/**
 * The width the camera's world matrix is kept at.
 *
 * The pin's \`allocateMat4()\` returns a Float32Array by default and a
 * Float64Array once an engine asks for \`useHighPrecisionMatrix\`, and
 * \`getViewMatrix\` reads the world back at whichever width it was stored
 * in. So under HPM the transpose sees the unrounded basis and the view is
 * narrowed once, at the GPU store -- narrowing the world first would round
 * twice, which shows on a silhouette.
 */
using CameraMatrixScalar = ${highPrecisionMatrix ? "double" : "float"};

std::array<CameraMatrixScalar, 16> camera_world_matrix(
    const CameraRecord& camera);
Vec3d camera_position(const CameraRecord& camera);
`,
            ),
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/runtime.hpp>

${highPrecisionMatrix ? "#include <bit>\n" : ""}#include <cmath>

namespace bbl::upstream {

${this.lowerArcRotateEye()}

Vec3d arc_rotate_eye_position(const CameraRecord& camera) {
    ${
        geospatial
            ? `// Two of the three pinned factories hold the eye directly:
    // createFreeCamera and createGeospatialCamera each keep position as
    // their own state and look from it. Only the ArcRotate composes an
    // eye from alpha/beta/radius about its target.
    if (camera.kind != CameraKind::arc_rotate) return camera.position;`
            : "if (camera.kind == CameraKind::free) return camera.position;"
    }
${
    highPrecisionMatrix
        ? `    // Memoize the translated eye by its exact F64 inputs.
    const std::array<std::uint64_t, ${arcRotateEyeMembers.length}> key{
        ${arcRotateEyeMembers.map((member) => `std::bit_cast<std::uint64_t>(camera.${member})`).join(",\n        ")}};
    static thread_local std::optional<std::pair<decltype(key), Vec3d>> cached;
    if (!cached || cached->first != key) {
        cached.emplace(key, arc_rotate_local_eye_position(camera));
    }
    return cached->second;`
        : "    return arc_rotate_local_eye_position(camera);"
}
}

${parentArm}${this.lowerLookAtWorld(highPrecisionMatrix)}

// The camera-to-world matrix both pinned factories write through
// \`createWorldMatrixState\` (src/camera/arc-rotate.ts cameraLocalWorldMatrix,
// src/camera/free-camera.ts _createFreeCamera): the ArcRotate looks from
// its composed eye and the free camera from its own position, each against
// the up vector it was created with -- Vec3Up for both public factories,
// the caller's for a banked free camera, which the record carries in one
// slot. With no parent the world matrix *is* this local one
// (\`src/scene/world-matrix-state.ts\` getWorldMatrix), and the storage is
// the \`allocateMat4()\` array the translation above stores at, so
// \`getViewMatrix\` downstream reads exactly what the pin stored.
std::array<CameraMatrixScalar, 16> ${gltfCameras ? "camera_local_matrix" : "camera_world_matrix"}(const CameraRecord& camera) {
    std::array<CameraMatrixScalar, 16> out{};
    mat4_look_at_world_lh_to_ref(
        out, arc_rotate_eye_position(camera), camera.target, camera.up_vector);
    return out;
}
${
    gltfCameras
        ? `
std::array<CameraMatrixScalar, 16> camera_world_matrix(
    const CameraRecord& camera) {
    const std::array<CameraMatrixScalar, 16> local =
        camera_local_matrix(camera);
    return camera.has_parent_world
        ? camera_parented_world(camera, local)
        : local;
}
`
        : ""
}
// ${this.context.provenance(positionModule, positionSymbol)}
// \`const w = camera.worldMatrix; return { x: w[12], y: w[13], z: w[14] }\`.
// The lanes are read out of the STORED matrix, so what a scene observes is
// the rounded store rather than the double the eye was composed at -- which
// is the whole reason this reads the matrix instead of recomposing the eye.
// One composition, not three: every caller wants all three lanes.
Vec3d camera_position(const CameraRecord& camera) {
    const std::array<CameraMatrixScalar, 16> world =
        camera_world_matrix(camera);
    return Vec3d{
        static_cast<double>(world[12]),
        static_cast<double>(world[13]),
        static_cast<double>(world[14])};
}

} // namespace bbl::upstream

namespace bbl {

CameraHandle create_arc_rotate_camera(
    Engine& engine,
    double alpha,
    double beta,
    double radius,
    Vec3d target) {
    CameraRecord camera;
    camera.alpha = alpha;
    camera.beta = beta;
    camera.radius = radius;
    camera.target = target;
    camera.up_vector = Vec3d{${this.context.doubleLiteral(upVector.x)}, ${this.context.doubleLiteral(upVector.y)}, ${this.context.doubleLiteral(upVector.z)}};
    camera.fov = ${number("fov")};
    camera.near_plane = ${number("nearPlane")};
    camera.far_plane = ${number("farPlane")};
    camera.inertia = ${number("inertia")};
    camera.panning_inertia = ${number("panningInertia")};
    camera.angular_sensibility = ${number("angularSensibility")};
    camera.panning_sensibility = ${number("panningSensibility")};
    camera.wheel_precision = ${number("wheelPrecision")};
    engine.cameras.push_back(camera);
    return CameraHandle{static_cast<std::uint32_t>(engine.cameras.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    /** Translate the source projector, including each nullable plane fallback. */
    public lowerOrthographicProjection(): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/camera/orthographic.ts",
            "writeOrthoProjection",
        );
        return lowerPinnedBody(
            file,
            declaration.body!.statements,
            {
                bindings: new Map<string, PinnedBinding>([
                    ["camera.ortho", { cpp: "camera", type: "opaque" }],
                    [
                        "b.halfHeight",
                        { cpp: "camera.ortho_half_height", type: "scalar" },
                    ],
                    ["aspectRatio", { cpp: "aspect", type: "scalar" }],
                    ["out", { cpp: "projection", type: "opaque" }],
                    [
                        "camera.nearPlane",
                        { cpp: "camera.near_plane", type: "scalar" },
                    ],
                    [
                        "camera.farPlane",
                        { cpp: "camera.far_plane", type: "scalar" },
                    ],
                ]),
                calls: new Map([
                    [
                        "writeOrthoOffCenterMat4LHIntoBuffer",
                        (args) =>
                            `mat4_ortho_off_center_lh_to_ref(${args.join(", ")})`,
                    ],
                ]),
                expression: (node, lowerer) => {
                    if (
                        !ts.isBinaryExpression(node) ||
                        node.operatorToken.kind !==
                            ts.SyntaxKind.QuestionQuestionToken ||
                        !ts.isPropertyAccessExpression(node.left) ||
                        node.left.expression.getText(file) !== "b"
                    )
                        return undefined;
                    const plane = node.left.name.text;
                    if (!["left", "right", "bottom", "top"].includes(plane))
                        this.context.contractError(
                            node,
                            "Unknown orthographic plane.",
                        );
                    return `camera.ortho_${plane}.value_or(${lowerer.expression(node.right)})`;
                },
            },
            "        ",
        );
    }

    public lowerOrthographic(): LoweredSource {
        const modulePath = "src/camera/orthographic.ts";
        const symbolName = "enableOrthographicCamera";
        const { declaration: enable } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const publication = this.context.findNodes(
            enable,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                this.context.propertyPath(node.left)?.join(".") ===
                    "camera.ortho",
        )[0];
        if (!publication)
            this.context.contractError(
                enable,
                "Missing orthographic bounds publication.",
            );
        this.context.assertExpressionShape(
            publication,
            "camera.ortho = ortho",
            "Orthographic bounds publication",
        );
        this.context.assertExpressionShape(
            this.context.callExpression(enable, "invalidateProjection"),
            "invalidateProjection(camera)",
            "Orthographic projection invalidation",
        );
        const { declaration: bounds } = this.context.functionDeclaration(
            modulePath,
            "createOrthographicBounds",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(bounds, "halfHeight"),
            "options.halfHeight ?? 1",
            "Orthographic half-extent default",
        );
        const planes = this.context.objectInitializer(bounds, "planes");
        for (const plane of ["left", "right", "bottom", "top"])
            this.context.assertExpressionShape(
                this.context.propertyInitializer(planes, plane),
                `options.${plane} ?? null`,
                `Orthographic ${plane} default`,
            );
        const { file, declaration: invalidate } =
            this.context.functionDeclaration(
                modulePath,
                "invalidateProjection",
            );
        const invalidation = lowerPinnedBody(
            file,
            invalidate.body!.statements,
            {
                bindings: new Map([
                    [
                        "camera._projRev",
                        { cpp: "record.projection_revision", type: "scalar" },
                    ],
                ]),
                calls: new Map(),
            },
        );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
namespace bbl {
CameraHandle enable_orthographic_camera(Engine& engine, CameraHandle camera, double half_height,
    std::optional<double> left, std::optional<double> right, std::optional<double> bottom, std::optional<double> top) {
    CameraRecord& record = engine.cameras[camera.value];
    record.orthographic = true;
    record.ortho_half_height = half_height;
    record.ortho_left = left;
    record.ortho_right = right;
    record.ortho_bottom = bottom;
    record.ortho_top = top;
${invalidation}
    return camera;
}
} // namespace bbl
`,
        };
    }

    /**
     * The initial orientation `_createFreeCamera` derives from position and
     * target: the `_yaw`/`_pitch` closure variables its accessors back, and
     * the locals they are computed from, lowered in source order. The
     * accessors' storage is the record's, so each initializer is stored
     * there.
     */
    private lowerFreeOrientation(
        file: ts.SourceFile,
        factory: ts.FunctionDeclaration,
    ): string {
        const storage = new Map([
            ["_yaw", "camera.free_yaw"],
            ["_pitch", "camera.free_pitch"],
        ]);
        const declared = new Map<string, ts.VariableStatement>();
        for (const statement of factory.body!.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations)
                if (ts.isIdentifier(declaration.name))
                    declared.set(declaration.name.text, statement);
        }
        const selected = new Set<ts.VariableStatement>();
        const include = (name: string): void => {
            const statement =
                declared.get(name) ??
                this.context.contractError(
                    factory,
                    `Expected _createFreeCamera to declare '${name}'.`,
                );
            if (selected.has(statement)) return;
            selected.add(statement);
            for (const identifier of this.context.findNodes(
                statement,
                ts.isIdentifier,
            ))
                if (
                    identifier.text !== name &&
                    declared.has(identifier.text) &&
                    !(
                        ts.isPropertyAccessExpression(identifier.parent) &&
                        identifier.parent.name === identifier
                    )
                )
                    include(identifier.text);
        };
        for (const name of storage.keys()) include(name);
        const bindings = new Map<string, PinnedBinding>([
            ["position", { cpp: "position", type: "vec3" }],
            ["target", { cpp: "target", type: "vec3" }],
            ...[...storage].map(([name, cpp]): [string, PinnedBinding] => [
                name,
                { cpp, type: "scalar" },
            ]),
        ]);
        return lowerPinnedBody(
            file,
            factory.body!.statements.filter(
                (statement): statement is ts.VariableStatement =>
                    ts.isVariableStatement(statement) &&
                    selected.has(statement),
            ),
            {
                bindings,
                calls: pinnedNumericMathCalls(),
                statement: (statement, lowerer, indent) => {
                    if (!ts.isVariableStatement(statement)) return undefined;
                    const [declaration] =
                        statement.declarationList.declarations;
                    const field =
                        declaration && ts.isIdentifier(declaration.name)
                            ? storage.get(declaration.name.text)
                            : undefined;
                    if (
                        !field ||
                        statement.declarationList.declarations.length !== 1 ||
                        !declaration!.initializer
                    )
                        return undefined;
                    return [
                        `${indent}${field} = ${lowerer.expression(declaration!.initializer)};`,
                    ];
                },
            },
        );
    }

    public lowerFreeFactory(): LoweredSource {
        const modulePath = "src/camera/free-camera.ts";
        const symbolName = "createFreeCamera";
        // The public factory is one call into the shared `_createFreeCamera`
        // with the world up vector; the banked camera passes its own. Only
        // the world-up arm is lowered, so the delegation is held to that
        // argument and the record is read off the shared body.
        const { declaration: publicFactory } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const delegation = this.context.callExpression(
            publicFactory,
            "_createFreeCamera",
        );
        this.context.assertExpressionShape(
            delegation,
            "_createFreeCamera(position, target, Vec3Up)",
            "Pinned free-camera delegation",
        );
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            "_createFreeCamera",
        );
        const camera = this.context.objectInitializer(declaration, "cam");
        const number = (name: string): string =>
            this.context.doubleLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(camera, name),
                    file,
                ),
            );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl {

CameraHandle create_free_camera(
    Engine& engine,
    Vec3d position,
    Vec3d target) {
    CameraRecord camera;
    camera.kind = CameraKind::free;
    camera.position = position;
    camera.target = target;
${this.lowerFreeOrientation(file, declaration)}
    camera.fov = ${number("fov")};
    camera.near_plane = ${number("nearPlane")};
    camera.far_plane = ${number("farPlane")};
    camera.speed = ${number("speed")};
    camera.angular_sensibility = ${number("angularSensitivity")};
    camera.inertia = ${number("inertia")};
    engine.cameras.push_back(camera);
    return CameraHandle{
        static_cast<std::uint32_t>(engine.cameras.size() - 1)};
}

CameraHandle create_banked_free_camera(
    Engine& engine,
    Vec3d position,
    Vec3d target,
    Vec3d up) {
    const CameraHandle camera = create_free_camera(engine, position, target);
    engine.cameras[camera.value].up_vector = up;
    return camera;
}

} // namespace bbl
`,
        };
    }

    public lowerDefaultFactory(
        nodeVisibility = false,
        animatedWorldBounds = false,
    ): LoweredSource {
        const modulePath = "src/scene/scene-camera.ts";
        const symbolName = "createDefaultCamera";
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const body = lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map<string, PinnedBinding>([
                ["scene", { cpp: "scene", type: "opaque" }],
                ["scene.camera", { cpp: "scene.camera", type: "opaque" }],
                ["Math.PI", { cpp: "pi_double", type: "scalar" }],
                ["cam", { cpp: "cam", type: "opaque" }],
                [
                    "cam.nearPlane",
                    {
                        cpp: "engine.cameras[cam.value].near_plane",
                        type: "scalar",
                    },
                ],
                [
                    "cam.farPlane",
                    {
                        cpp: "engine.cameras[cam.value].far_plane",
                        type: "scalar",
                    },
                ],
                ...worldAabbLaneBindings(this.context, "acc", "acc"),
            ]),
            calls: new Map([
                ...pinnedNumericMathCalls(),
                ["emptyWorldAabb", () => "empty_world_aabb()"],
                [
                    "expandWorldAabbForMesh",
                    (args: readonly string[]) =>
                        `expand_world_aabb_for_mesh(${args[0]}, ` +
                        `default_camera_world_aabb_mesh(engine, ${args[1]}))`,
                ],
                [
                    "isFinite",
                    (args: readonly string[]) =>
                        `std::isfinite(${args.join(", ")})`,
                ],
                [
                    "vec3",
                    (args: readonly string[]) => `Vec3d{${args.join(", ")}}`,
                ],
            ]),
            callShapes: new Map<string, PinnedBinding["type"]>([
                ["emptyWorldAabb", "f64-buffer"],
                ["vec3", "vec3"],
            ]),
            booleanOr: true,
            forOf: (iterated, element) =>
                iterated === "scene.meshes"
                    ? {
                          range: "scene.meshes",
                          bindings: new Map<string, PinnedBinding>([
                              [element, { cpp: element, type: "opaque" }],
                              [
                                  `${element}.visible === false`,
                                  nodeVisibility
                                      ? {
                                            cpp:
                                                `(${element}.value < engine.meshes.size() && ` +
                                                `!engine.meshes[${element}.value].visible)`,
                                            type: "bool",
                                        }
                                      : // Nothing writes `visible` in a
                                        // scene without the feature.
                                        {
                                            cpp: "false",
                                            type: "bool",
                                            staticBoolean: false,
                                        },
                              ],
                          ]),
                      }
                    : undefined,
            // `createArcRotateCamera` returns the native camera's handle.
            statement: (statement, lowerer, indent) => {
                if (!ts.isVariableStatement(statement)) return undefined;
                const [camera] = statement.declarationList.declarations;
                if (
                    !camera ||
                    !ts.isIdentifier(camera.name) ||
                    camera.name.text !== "cam"
                )
                    return undefined;
                const call = camera.initializer
                    ? this.context.unwrapExpression(camera.initializer)
                    : undefined;
                if (
                    !call ||
                    !ts.isCallExpression(call) ||
                    call.expression.getText(file) !== "createArcRotateCamera"
                )
                    return this.context.contractError(
                        camera,
                        "Expected the default camera from createArcRotateCamera.",
                    );
                return [
                    `${indent}const CameraHandle cam = create_arc_rotate_camera(engine, ${call.arguments
                        .map((argument) => lowerer.expression(argument))
                        .join(", ")});`,
                ];
            },
            returnValue: (node, lowerer) =>
                node
                    ? lowerer.expression(node)
                    : this.context.contractError(
                          declaration,
                          "Expected createDefaultCamera to return its camera.",
                      ),
        });
        const bounds = animatedWorldBounds ? "world_bounds" : "bounds";
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <array>
#include <cmath>
#include <limits>
#include <optional>

namespace bbl {
namespace {

${lowerWorldAabbHelpers(this.context, { emptyAccumulator: true })}

// The Mesh members the framing reads, off the native record. A loaded glTF
// primitive keeps its node world baked into its vertices, so its box is
// that world box (the live one an animated asset records) under the
// record's own identity transform; a createMeshFromData mesh -- every
// factory's -- keeps its local box. A .babylon mesh has neither bound
// upstream (load-babylon.ts builds it without them), so it frames nothing
// unless the scene assigns them. A scene may replace either public bound.
// The world matrix is the record's composition under its parents, with an
// imported clone root's outer transform on the left, as the draw path
// applies it.
WorldAabbMesh default_camera_world_aabb_mesh(const Engine& engine, MeshHandle handle) {
    WorldAabbMesh result{};
    if (handle.value >= engine.meshes.size()) return result;
    const MeshRecord& mesh = engine.meshes[handle.value];
    const auto lanes = [](const Vec3& value) {
        return std::array<float, 3>{value.x, value.y, value.z};
    };
    if (mesh.primitive == PrimitiveKind::gltf && mesh.geometry < engine.geometries.size()) {
        result.bound_min = lanes(engine.geometries[mesh.geometry].${bounds}_min);
        result.bound_max = lanes(engine.geometries[mesh.geometry].${bounds}_max);
    }
    if (mesh.has_bounds_min_override) result.bound_min = lanes(mesh.bounds_min_override);
    if (mesh.has_bounds_max_override) result.bound_max = lanes(mesh.bounds_max_override);
    const std::array<float, 16> world = upstream::mesh_world_matrix(engine, mesh);
    result.world_matrix = upstream::outer_transform_is_identity(mesh)
        ? world
        : upstream::matrix_product(upstream::outer_transform_matrix(mesh), world);
    return result;
}

} // namespace

CameraHandle create_default_camera(Engine& engine, Scene& scene) {
${body}
}

} // namespace bbl
`,
        };
    }

    public lowerControls(): LoweredSource {
        const modulePath = "src/camera/arc-rotate-controls.ts";
        const symbolName = "attachControl";
        const freeModule = "src/camera/free-camera-controls.ts";
        const mutations = new CameraMutationLowerer(this.context);
        const free = lowerFreeCameraControls(this.context);
        return {
            modulePath,
            symbolName,
            header: pinnedHeader(
                ["<bblite/runtime.hpp>", "", "<functional>", "<string_view>"],
                `
// ${this.context.provenance(modulePath, symbolName)}
// The handlers of the pinned attachControl closure. The drag flags are the
// platform layer's pointer state; the button is a DOM
// \`PointerEvent.button\`, the deltas relative client motion and
// \`delta_y\` a DOM \`WheelEvent.deltaY\`.
void arc_rotate_pointer_down(
    CameraRecord& camera,
    bool& is_dragging,
    bool& is_panning,
    double button,
    bool touch);
void arc_rotate_pointer_move(
    CameraRecord& camera,
    bool& is_dragging,
    bool& is_panning,
    double touch_count,
    double delta_x,
    double delta_y);
void arc_rotate_pointer_up(bool& is_dragging, bool& is_panning);
void apply_arc_rotate_wheel(CameraRecord& camera, double delta_y);
void apply_arc_rotate_inertia(CameraRecord& camera);
${free.declarations}`,
            ),
            source: `// ${this.context.provenance(modulePath, symbolName, `${freeModule}#attachFreeControl`)}
#include <bblite/upstream/camera_controls.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <optional>
#include <stdexcept>
#include <string_view>

namespace bbl {

void clamp_camera_to_limits(CameraRecord& camera);
${mutations.setters()}

void clamp_camera_to_limits(CameraRecord& camera) {
${mutations.clamp()}
}

// setCameraLimits: the compiled presence mask stands in for the pin's
// \`in\` tests, and the record's flag is the self-clamp hook the scalar
// setters call.
void set_camera_limits(
    Engine& engine,
    CameraHandle handle,
    std::uint32_t present_mask,
    const std::array<double, 6>& limits) {
    if (handle.value >= engine.cameras.size()) {
        throw std::runtime_error("Invalid camera handle.");
    }
    CameraRecord& camera = engine.cameras[handle.value];
    if ((present_mask & (1u << 0u)) != 0u) camera.lower_alpha_limit = limits[0];
    if ((present_mask & (1u << 1u)) != 0u) camera.upper_alpha_limit = limits[1];
    if ((present_mask & (1u << 2u)) != 0u) camera.lower_beta_limit = limits[2];
    if ((present_mask & (1u << 3u)) != 0u) camera.upper_beta_limit = limits[3];
    if ((present_mask & (1u << 4u)) != 0u) camera.lower_radius_limit = limits[4];
    if ((present_mask & (1u << 5u)) != 0u) camera.upper_radius_limit = limits[5];
    camera.limits_installed = true;
    clamp_camera_to_limits(camera);
}

// Both attach hooks register input on the camera they are handed and
// nothing else: the pinned attachControl/attachFreeControl install canvas
// listeners and push an inertia hook onto scene._beforeRender, and neither
// makes their camera the scene's. A scene that attaches controls to a
// second camera -- an anaglyph's left eye -- renders through the camera it
// assigned, which is what the pin does.
void attach_control(Engine& engine, CameraHandle camera) {
    if (camera.value >= engine.cameras.size()) {
        throw std::runtime_error("Invalid camera handle.");
    }
    engine.cameras[camera.value].controls_enabled = true;
}

// The free-camera entry point is a separate pinned symbol reaching a separate
// input handler, and the same one line of runtime state.
void attach_free_control(Engine& engine, CameraHandle camera) {
    attach_control(engine, camera);
}

} // namespace bbl

namespace bbl::upstream {

void arc_rotate_pointer_down(
    CameraRecord& camera,
    bool& is_dragging,
    bool& is_panning,
    double button,
    bool touch) {
${mutations.pointerDown()}
}

void arc_rotate_pointer_move(
    CameraRecord& camera,
    bool& is_dragging,
    bool& is_panning,
    double touch_count,
    double delta_x,
    double delta_y) {
${mutations.pointerMove()}
}

void arc_rotate_pointer_up(bool& is_dragging, bool& is_panning) {
${mutations.pointerUp()}
}

void apply_arc_rotate_wheel(CameraRecord& camera, double delta_y) {
${mutations.wheel()}
}

void apply_arc_rotate_inertia(CameraRecord& camera) {
${mutations.inertia()}
}
${free.definitions}
} // namespace bbl::upstream
`,
        };
    }
}
