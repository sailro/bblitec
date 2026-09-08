import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { CameraMutationLowerer } from "./camera-mutation-lowerer.js";
import {
    lowerObjectComponents,
    lowerPinnedFunction,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { pinnedTrsComposition } from "./pinned-trs.js";

export class CameraLowerer {
    public constructor(private readonly context: LoweringContext, private readonly trackVersions = false) {}

    /**
     * The parented-world composition `camera_world_matrix` mirrors when a
     * record carries a parent: the pinned `getWorldMatrix`
     * (src/scene/world-matrix-state.ts) multiplies the parent's world by
     * the local through `mat4MultiplyInto(out, 0, parent, 0, local, 0)`.
     * The operand order is the whole contract — swapping it composes the
     * camera on the wrong side of its fixup node — so this reads the
     * pin's one multiply call and requires the parent world third and the
     * local matrix fifth.
     */
    private assertParentWorldComposition(): void {
        const module = "src/scene/world-matrix-state.ts";
        const file = this.context.sourceFile(module);
        const multiplies = this.context
            .findNodes(
                file,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "mat4MultiplyInto",
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
                    file,
                    parentOperand.text,
                ),
                "_parent.worldMatrix",
            ) ||
            !this.context.expressionMatchesShape(
                this.context.variableInitializer(
                    file,
                    localOperand.text,
                ),
                "getLocalMatrix()",
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
     * `mat4LookAtWorldLHToRef` translated whole, at the width the camera's
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
            kind: "record",
            cpp: name,
            cppType: "Vec3d",
            annotation: "Vec3",
        });
        return lowerPinnedFunction(
            this.context,
            "src/math/mat4-look-at-world-lh.ts",
            "mat4LookAtWorldLHToRef",
            [
                {
                    pinned: "out",
                    kind: "mat4",
                    cpp: "out",
                    cppType: "std::array<CameraMatrixScalar, 16>",
                    mutableRecord: true,
                    binding: {
                        cpp: "out",
                        type: highPrecisionMatrix ? "f64-buffer" : "f32",
                    },
                },
                vector("eye"),
                vector("target"),
                vector("up"),
            ],
            {
                cppName: "mat4_look_at_world_lh_to_ref",
                returns: "void",
                calls: pinnedNumericMathCalls(),
                memberBindings: new Map(
                    ["eye", "target", "up"].flatMap((record) =>
                        ["x", "y", "z"].map(
                            (component): [string, PinnedBinding] => [
                                `${record}.${component}`,
                                {
                                    cpp: `${record}.${component}`,
                                    type: "scalar",
                                },
                            ],
                        ),
                    ),
                ),
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
            ["alpha", "beta", "radius", "target.x", "target.y", "target.z"].map(
                (member): [string, PinnedBinding] => [
                    `cam.${member}`,
                    { cpp: `camera.${member}`, type: "scalar" },
                ],
            ),
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
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const upVector = this.readPinnedUpVector();
        const camera = this.context.objectInitializer(declaration, "cam");
        const number = (name: string): string =>
            this.context.doubleLiteral(
                this.context.numericValue(this.context.propertyInitializer(camera, name), file),
            );
        if (gltfCameras) {
            this.assertParentWorldComposition();
        }
        const parentArm = gltfCameras
            ? `
// src/scene/world-matrix-state.ts getWorldMatrix: with a parent the world
// is mat4MultiplyInto(out, 0, parent.worldMatrix, 0, local, 0) — parent
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
            header: `#pragma once

#include <bblite/runtime.hpp>

#include <array>

namespace bbl::upstream {

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

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl::upstream {

${this.lowerArcRotateEye()}

Vec3d arc_rotate_eye_position(const CameraRecord& camera) {
    ${geospatial
        ? `// Two of the three pinned factories hold the eye directly:
    // createFreeCamera and createGeospatialCamera each keep position as
    // their own state and look from it. Only the ArcRotate composes an
    // eye from alpha/beta/radius about its target.
    if (camera.kind != CameraKind::arc_rotate) return camera.position;`
        : "if (camera.kind == CameraKind::free) return camera.position;"}
    return arc_rotate_local_eye_position(camera);
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
${gltfCameras ? `
std::array<CameraMatrixScalar, 16> camera_world_matrix(
    const CameraRecord& camera) {
    const std::array<CameraMatrixScalar, 16> local =
        camera_local_matrix(camera);
    return camera.has_parent_world
        ? camera_parented_world(camera, local)
        : local;
}
` : ""}
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

    public lowerOrthographic(): LoweredSource {
        const modulePath = "src/camera/orthographic.ts";
        const symbolName = "enableOrthographicCamera";
        // The reached surface stores one extent and derives the four
        // planes from it, so the pinned default and that derivation are
        // the contract this lowering depends on. The emission below
        // stores exactly two facts — the `orthographic` flag and
        // `ortho_half_height` — and each assertion here is the reason
        // those two suffice; the pairings are named at each assert.
        const { declaration: enable } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const orthoAssignment = this.context
            .findNodes(
                enable,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .find(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "camera.ortho",
            );
        if (!orthoAssignment) {
            this.context.contractError(
                enable,
                "Expected the orthographic bounds to be published on the camera.",
            );
        }
        // ^ Paired with the emitted `record.orthographic = true`: the
        // record flag is the native form of the published bounds, the
        // one bit the projection branch dispatches on.
        const { declaration: bounds } =
            this.context.functionDeclaration(
                modulePath,
                "createOrthographicBounds",
            );
        // Paired with the compiler intrinsic (`enableOrthographicCamera`
        // in src/compiler/intrinsics/camera.ts), which seeds "1.0" when
        // the scene passes no options. The native factory takes the
        // already-resolved extent, so the default is consumed there, not
        // emitted here.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                bounds,
                "halfHeight",
            ),
            "options.halfHeight ?? 1",
            "Orthographic half-extent default",
        );
        const { declaration: writer } =
            this.context.functionDeclaration(
                modulePath,
                "writeOrthoProjection",
            );
        // This derivation and the seven projection arguments below are
        // the sufficiency proof for the emitted single-extent store:
        // every plane is ±halfWidth/±halfHeight with halfWidth derived
        // from the one stored extent, and near/far are the camera's own
        // scalars, already on the record — so `ortho_half_height` is the
        // only new state the native camera needs. They also guard the
        // renderer's orthographic branch (renderer-lowerer.ts, the
        // `if (camera.orthographic)` arm of build_view_projection),
        // which re-derives left/right/bottom/top from
        // `ortho_half_height * aspect` and hands them to the pinned
        // mat4 writer translated whole from its own AST; the plane
        // derivation is asserted only here.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                writer,
                "halfWidth",
            ),
            "halfHeight * aspectRatio",
            "Orthographic horizontal extent",
        );
        const projection = this.context
            .findNodes(
                writer,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node),
            )
            .find(
                (call) =>
                    this.context
                        .propertyPath(call.expression)
                        ?.join(".") ===
                    "mat4OrthoOffCenterLHToRef",
            );
        if (!projection) {
            this.context.contractError(
                writer,
                "Expected the orthographic writer to call mat4OrthoOffCenterLHToRef.",
            );
        }
        const planes = [
            "out",
            "b.left ?? -halfWidth",
            "b.right ?? halfWidth",
            "b.bottom ?? -halfHeight",
            "b.top ?? halfHeight",
            "camera.nearPlane",
            "camera.farPlane",
        ];
        if (projection.arguments.length !== planes.length) {
            this.context.contractError(
                projection,
                `Expected ${planes.length} orthographic projection arguments.`,
            );
        }
        planes.forEach((expected, index) => {
            this.context.assertExpressionShape(
                projection.arguments[index]!,
                expected,
                `Orthographic projection argument ${index}`,
            );
        });
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

CameraHandle enable_orthographic_camera(
    Engine& engine,
    CameraHandle camera,
    double half_height) {
    CameraRecord& record = engine.cameras[camera.value];
    record.orthographic = true;
    record.ortho_half_height = half_height;
    return camera;
}

} // namespace bbl
`,
        };
    }

    public lowerFreeFactory(): LoweredSource {
        const modulePath = "src/camera/free-camera.ts";
        const symbolName = "createFreeCamera";
        // The public factory is one call into the shared `_createFreeCamera`
        // with the world up vector; the banked camera passes its own. Only
        // the world-up arm is lowered, so the delegation is held to that
        // argument and the record is read off the shared body.
        const { declaration: publicFactory } =
            this.context.functionDeclaration(modulePath, symbolName);
        const delegation = this.context.callExpression(
            publicFactory,
            "_createFreeCamera",
        );
        this.context.assertExpressionShape(
            delegation,
            "_createFreeCamera(position, target, Vec3Up)",
            "Pinned free-camera delegation",
        );
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                "_createFreeCamera",
            );
        const camera = this.context.objectInitializer(
            declaration,
            "cam",
        );
        const number = (name: string): string =>
            this.context.doubleLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(
                        camera,
                        name,
                    ),
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
    const double dx = target.x - position.x;
    const double dy = target.y - position.y;
    const double dz = target.z - position.z;
    CameraRecord camera;
    camera.kind = CameraKind::free;
    camera.position = position;
    camera.target = target;
    camera.free_yaw = std::atan2(dx, dz);
    camera.free_pitch = std::atan2(
        dy,
        std::sqrt(dx * dx + dz * dz));
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
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const radiusExpression =
            this.context.variableInitializer(
                declaration,
                "radius",
            );
        this.context.assertExpressionShape(
            radiusExpression,
            "diag * 1.5",
            "Default camera radius",
        );
        const radiusBinary =
            this.context.unwrapExpression(radiusExpression);
        if (!ts.isBinaryExpression(radiusBinary)) {
            this.context.contractError(
                radiusExpression,
                "Expected computed default camera radius.",
            );
        }
        const radiusScale = this.context.numericValue(
            radiusBinary.right,
            file,
        );
        const assignments = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken,
        );
        const assignment = (
            path: string,
        ): ts.BinaryExpression => {
            const result = assignments.find(
                (candidate) =>
                    this.context
                        .propertyPath(candidate.left)
                        ?.join(".") === path,
            );
            if (!result) {
                this.context.contractError(
                    declaration,
                    `Expected assignment to '${path}'.`,
                );
            }
            return result;
        };
        const fallbackRadiusExpression =
            assignment("radius").right;
        const fallbackRadius =
            this.context.numericValue(
                fallbackRadiusExpression,
                file,
            );
        const createCamera = this.context.callExpression(
            declaration,
            "createArcRotateCamera",
        );
        const expectedArguments = [
            "-(Math.PI / 2)",
            "Math.PI / 2",
            "radius",
            "center",
        ];
        if (
            createCamera.arguments.length !==
            expectedArguments.length
        ) {
            this.context.contractError(
                createCamera,
                "Unexpected default camera arguments.",
            );
        }
        createCamera.arguments.forEach((argument, index) =>
            this.context.assertExpressionShape(
                argument,
                expectedArguments[index]!,
                `Default camera argument ${index}`,
            ),
        );
        const nearExpression =
            assignment("cam.nearPlane").right;
        const farExpression =
            assignment("cam.farPlane").right;
        this.context.assertExpressionShape(
            nearExpression,
            "radius * 0.01",
            "Default camera near plane",
        );
        this.context.assertExpressionShape(
            farExpression,
            "radius * 1000",
            "Default camera far plane",
        );
        if (
            !ts.isBinaryExpression(nearExpression) ||
            !ts.isBinaryExpression(farExpression)
        ) {
            this.context.contractError(
                declaration,
                "Expected scaled default camera planes.",
            );
        }
        const nearScale = this.context.numericValue(
            nearExpression.right,
            file,
        );
        const farScale = this.context.numericValue(
            farExpression.right,
            file,
        );
        const value = (input: number): string => this.context.floatLiteral(input);
        const dvalue = (input: number): string => this.context.doubleLiteral(input);
        const meshTrs = pinnedTrsComposition(this.context);
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace bbl {
namespace {

// src/scene/world-matrix-state.ts composeTrsLocalMatrix, translated whole:
// the pin composes in JavaScript-number width and stores once into its
// allocateMat4() Float32Array, so the locals here are double and the
// narrowing is the single store loop at the end.
std::array<float, 16> framed_local_matrix(const MeshRecord& mesh) {
${meshTrs.composeWorldBody}    return world;
}

// src/mesh/mesh-world-bounds.ts expandWorldAabbForMesh takes each
// object-local box through mesh.worldMatrix. The record splits that world
// into the mesh's own TRS and an imported clone root's outer transform,
// applied in the order the draw path applies them, each through the
// vertex stage's own f32 multiply.
Vec3 transform_bounds_point(Vec3 point, const MeshRecord& mesh) {
    return upstream::transform_position(
        upstream::outer_transform_matrix(
            mesh.outer_position, mesh.outer_rotation),
        upstream::transform_position(framed_local_matrix(mesh), point));
}

void extend_bounds(Vec3 point, Vec3& minimum, Vec3& maximum) {
    minimum.x = std::min(minimum.x, point.x);
    minimum.y = std::min(minimum.y, point.y);
    minimum.z = std::min(minimum.z, point.z);
    maximum.x = std::max(maximum.x, point.x);
    maximum.y = std::max(maximum.y, point.y);
    maximum.z = std::max(maximum.z, point.z);
}

} // namespace

CameraHandle create_default_camera(Engine& engine, Scene& scene) {
    Vec3 minimum{
        std::numeric_limits<float>::max(),
        std::numeric_limits<float>::max(),
        std::numeric_limits<float>::max(),
    };
    Vec3 maximum{
        std::numeric_limits<float>::lowest(),
        std::numeric_limits<float>::lowest(),
        std::numeric_limits<float>::lowest(),
    };
    bool has_bounds = false;
    for (const MeshHandle handle : scene.meshes) {
        if (handle.value >= engine.meshes.size()) continue;
        const MeshRecord& mesh = engine.meshes[handle.value];${nodeVisibility ? `
        // The pinned framing pass skips \`visible === false\` meshes, whether
        // scene source wrote the field or KHR_node_visibility materialized it.
        if (!mesh.visible) continue;` : ""}
        Vec3 local_min{};
        Vec3 local_max{};
        if (mesh.primitive == PrimitiveKind::gltf && mesh.geometry < engine.geometries.size()) {
            local_min = engine.geometries[mesh.geometry].${animatedWorldBounds ? "world_" : ""}bounds_min;
            local_max = engine.geometries[mesh.geometry].${animatedWorldBounds ? "world_" : ""}bounds_max;
        } else {
            local_min = Vec3{
                -mesh.dimensions.x * 0.5f,
                -mesh.dimensions.y * 0.5f,
                -mesh.dimensions.z * 0.5f,
            };
            local_max = Vec3{
                mesh.dimensions.x * 0.5f,
                mesh.dimensions.y * 0.5f,
                mesh.dimensions.z * 0.5f,
            };
        }
        // A reached scene may replace either public Mesh bound after the
        // factory/loader created it. Those values are object-local in the
        // pin and therefore take the same world-transform path as the
        // factory bounds they replace.
        apply_mesh_bound_overrides(mesh, local_min, local_max);
        const std::array<Vec3, 8> corners{
            Vec3{local_min.x, local_min.y, local_min.z},
            Vec3{local_max.x, local_min.y, local_min.z},
            Vec3{local_min.x, local_max.y, local_min.z},
            Vec3{local_max.x, local_max.y, local_min.z},
            Vec3{local_min.x, local_min.y, local_max.z},
            Vec3{local_max.x, local_min.y, local_max.z},
            Vec3{local_min.x, local_max.y, local_max.z},
            Vec3{local_max.x, local_max.y, local_max.z},
        };
        for (const Vec3 corner : corners) extend_bounds(transform_bounds_point(corner, mesh), minimum, maximum);
        has_bounds = true;
    }

    Vec3 center{};
    float radius = ${value(fallbackRadius)};
    if (has_bounds) {
        const float sx = maximum.x - minimum.x;
        const float sy = maximum.y - minimum.y;
        const float sz = maximum.z - minimum.z;
        const float diagonal = std::sqrt(sx * sx + sy * sy + sz * sz);
        radius = diagonal * ${value(radiusScale)};
        center = Vec3{
            minimum.x + sx * 0.5f,
            minimum.y + sy * 0.5f,
            minimum.z + sz * 0.5f,
        };
        if (!std::isfinite(radius) || radius == 0.0f) {
            radius = ${value(fallbackRadius)};
            center = Vec3{};
        }
    }
    // The framing box above is still accumulated in float from the baked
    // mesh bounds, where the pinned pass composes each object-local box
    // through its world matrix in JavaScript doubles. That difference is
    // the sizing entry in TODO.md; the camera scalars it feeds are
    // doubles here so the pinned view/projection chain below is exact for
    // every camera whose scalars the scene sets itself.
    const CameraHandle camera = create_arc_rotate_camera(
        engine,
        -pi_double / 2.0,
        pi_double / 2.0,
        radius,
        Vec3d{center.x, center.y, center.z});
    CameraRecord& record = engine.cameras[camera.value];
    record.near_plane = radius * ${dvalue(nearScale)};
    record.far_plane = radius * ${dvalue(farScale)};
    scene.camera = camera;
    return camera;
}

} // namespace bbl
`,
        };
    }

    /**
     * Anchors one pinned assignment: the write at `path` with `operator`
     * whose right side has `expectedRight`'s shape. The arc block requires
     * exactly one match; the free block accepts the first, because its
     * accumulations repeat per axis.
     */
    private requirePinnedWrite(
        list: readonly ts.BinaryExpression[],
        errorNode: ts.Node,
        exactlyOne: boolean,
        path: string,
        operator: ts.SyntaxKind,
        expectedRight: string,
        label: string,
    ): void {
        const matches = list.filter(
            (expression) =>
                expression.operatorToken.kind === operator &&
                this.context
                    .propertyPath(expression.left)
                    ?.join(".") === path,
        );
        if (exactlyOne ? matches.length !== 1 : matches.length === 0) {
            this.context.contractError(
                errorNode,
                exactlyOne ? `Expected one ${label}.` : `Expected ${label}.`,
            );
        }
        this.context.assertExpressionShape(
            matches[0]!.right,
            expectedRight,
            label,
        );
    }

    public lowerControls(): LoweredSource {
        const modulePath = "src/camera/arc-rotate-controls.ts";
        const symbolName = "attachControl";
        const freeModule = "src/camera/free-camera-controls.ts";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const numericConstant = (name: string): number =>
            this.context.numericValue(
                this.context.variableInitializer(
                    declaration,
                    name,
                ),
                file,
            );
        const rotationEpsilon = numericConstant(
            "ROTATION_EPSILON",
        );
        const radiusEpsilon = numericConstant(
            "RADIUS_EPSILON",
        );
        const panningEpsilon = numericConstant(
            "PANNING_EPSILON",
        );
        const assignments = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node),
        );
        if (
            !assignments.some(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskEqualsToken &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") ===
                        "camera.inertialAlphaOffset" &&
                    this.context
                        .propertyPath(expression.right)
                        ?.join(".") === "camera.inertia",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected ArcRotate inertia decay.",
            );
        }
        // The pinned applyInertia pole margin (`eps`) keeps beta strictly
        // inside (0, PI). The value flows into the emitted
        // `constexpr double epsilon` and the clamp shape (max against the
        // lower margin, min against the upper) is asserted against the
        // emitted beta line, with `eps` left symbolic so the margin has a
        // single owner.
        const betaClampEpsilon = this.context.numericValue(
            this.context.variableInitializer(
                declaration,
                "eps",
            ),
            file,
        );
        const betaClamps = assignments.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                this.context
                    .propertyPath(expression.left)
                    ?.join(".") === "camera.beta",
        );
        if (betaClamps.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one ArcRotate beta clamp.",
            );
        }
        this.context.assertExpressionShape(
            betaClamps[0]!.right,
            "Math.max(eps, Math.min(Math.PI - eps, camera.beta))",
            "ArcRotate beta clamp",
        );
        // The radius floor: the pin writes `Math.max(<floor>, ...)` after
        // both the inertial zoom and the direct pinch write. The emitted
        // `apply_arc_rotate_inertia` carries the zoom one; extracting
        // every occurrence and requiring one shared value means a pin
        // that splits them fails loudly instead of leaving the emission
        // silently mirroring the wrong surface.
        const radiusFloors = assignments
            .filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "camera.radius",
            )
            .map((expression) =>
                this.context.unwrapExpression(
                    expression.right,
                ),
            )
            .filter(
                (right): right is ts.CallExpression =>
                    ts.isCallExpression(right) &&
                    this.context
                        .propertyPath(right.expression)
                        ?.join(".") === "Math.max",
            )
            .map((call) => {
                if (
                    call.arguments.length !== 2 ||
                    this.context
                        .propertyPath(call.arguments[1]!)
                        ?.join(".") !== "camera.radius"
                ) {
                    this.context.contractError(
                        call,
                        "Expected the radius floor to clamp the radius itself.",
                    );
                }
                return this.context.numericValue(
                    call.arguments[0]!,
                    file,
                );
            });
        if (
            radiusFloors.length === 0 ||
            radiusFloors.some(
                (value) => value !== radiusFloors[0],
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected one shared ArcRotate radius floor.",
            );
        }
        const radiusFloor = radiusFloors[0]!;
        // The pan scale is proportional to the radius; the factor flows
        // into the emitted `pan_scale` line. The pan basis and the three
        // target increments are shape-asserted because the emission
        // inlines `rightX = -sinA` / `rightZ = cosA` into its own
        // `-sine * ...` / `cosine * ...` terms — the signs would
        // otherwise be trusted.
        const panScaleInitializer =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    declaration,
                    "panScale",
                ),
            );
        if (
            !ts.isBinaryExpression(panScaleInitializer) ||
            panScaleInitializer.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            this.context
                .propertyPath(panScaleInitializer.left)
                ?.join(".") !== "camera.radius"
        ) {
            this.context.contractError(
                panScaleInitializer,
                "Expected the pan scale to be proportional to the radius.",
            );
        }
        const panScaleFactor = this.context.numericValue(
            panScaleInitializer.right,
            file,
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "rightX",
            ),
            "-sinA",
            "ArcRotate pan basis X",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "rightZ",
            ),
            "cosA",
            "ArcRotate pan basis Z",
        );
        const requirePanIncrement = (
            path: string,
            expected: string,
            label: string,
        ): void => {
            const increments = assignments.filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.PlusEqualsToken &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === path,
            );
            if (increments.length !== 1) {
                this.context.contractError(
                    declaration,
                    `Expected one ${label}.`,
                );
            }
            this.context.assertExpressionShape(
                increments[0]!.right,
                expected,
                label,
            );
        };
        requirePanIncrement(
            "camera.target.x",
            "rightX * camera.inertialPanningX * panScale",
            "ArcRotate pan X increment",
        );
        requirePanIncrement(
            "camera.target.y",
            "camera.inertialPanningY * panScale",
            "ArcRotate pan Y increment",
        );
        requirePanIncrement(
            "camera.target.z",
            "rightZ * camera.inertialPanningX * panScale",
            "ArcRotate pan Z increment",
        );
        // The pointer and wheel handlers the platform layer routes into
        // the record (onPointerMove/onWheel). Each accumulation is stated
        // once in the pin, dividing the event delta by a sensibility
        // local snapshotted from the live camera field on that same
        // event — so the local initializers are asserted alongside the
        // accumulation shapes, and the emitted bodies read the record
        // fields directly.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "dx"),
            "e.clientX - lastX",
            "ArcRotate pointer delta X",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "dy"),
            "e.clientY - lastY",
            "ArcRotate pointer delta Y",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "angularSensibility",
            ),
            "camera.angularSensibility",
            "ArcRotate live angular sensibility",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "panningSensibility",
            ),
            "camera.panningSensibility",
            "ArcRotate live panning sensibility",
        );
        const requireArcAccumulation = (
            path: string,
            operator: ts.SyntaxKind,
            expectedRight: string,
            label: string,
        ): void =>
            this.requirePinnedWrite(
                assignments,
                declaration,
                true,
                path,
                operator,
                expectedRight,
                label,
            );
        requireArcAccumulation(
            "camera.inertialAlphaOffset",
            ts.SyntaxKind.MinusEqualsToken,
            "dx / angularSensibility",
            "ArcRotate orbit alpha accumulation",
        );
        requireArcAccumulation(
            "camera.inertialBetaOffset",
            ts.SyntaxKind.MinusEqualsToken,
            "dy / angularSensibility",
            "ArcRotate orbit beta accumulation",
        );
        requireArcAccumulation(
            "camera.inertialPanningX",
            ts.SyntaxKind.PlusEqualsToken,
            "-dx / panningSensibility",
            "ArcRotate pan X accumulation",
        );
        requireArcAccumulation(
            "camera.inertialPanningY",
            ts.SyntaxKind.PlusEqualsToken,
            "dy / panningSensibility",
            "ArcRotate pan Y accumulation",
        );
        // The wheel-zoom accumulation: the pin subtracts
        // (deltaY * radius) / (wheelPrecision * <scale>) from the radius
        // offset, reading wheelPrecision live. The scale flows into the
        // emitted apply_arc_rotate_wheel; the caller owns only the
        // translation of its platform wheel units into the DOM deltaY the
        // pin consumes.
        const wheelWrites = assignments.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.MinusEqualsToken &&
                this.context
                    .propertyPath(expression.left)
                    ?.join(".") === "camera.inertialRadiusOffset",
        );
        if (wheelWrites.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one ArcRotate wheel-zoom accumulation.",
            );
        }
        const wheelRight = this.context.unwrapExpression(
            wheelWrites[0]!.right,
        );
        if (
            !ts.isBinaryExpression(wheelRight) ||
            wheelRight.operatorToken.kind !== ts.SyntaxKind.SlashToken
        ) {
            this.context.contractError(
                wheelRight,
                "Expected the wheel zoom to divide by the precision term.",
            );
        }
        this.context.assertExpressionShape(
            wheelRight.left,
            "e.deltaY * camera.radius",
            "ArcRotate wheel-zoom numerator",
        );
        const wheelDivisor = this.context.unwrapExpression(
            wheelRight.right,
        );
        if (
            !ts.isBinaryExpression(wheelDivisor) ||
            wheelDivisor.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            this.context
                .propertyPath(wheelDivisor.left)
                ?.join(".") !== "camera.wheelPrecision"
        ) {
            this.context.contractError(
                wheelDivisor,
                "Expected the wheel zoom to scale the live wheel precision.",
            );
        }
        const wheelPrecisionScale = this.context.numericValue(
            wheelDivisor.right,
            file,
        );
        const { file: freeFile, declaration: attachFreeControl } =
            this.context.functionDeclaration(
                freeModule,
                "attachFreeControl",
            );
        const freeAssignments = this.context.findNodes(
            attachFreeControl,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node),
        );
        const requireAssignment = (
            path: string,
            operator: ts.SyntaxKind,
            expectedRight: string,
            label: string,
        ): void =>
            this.requirePinnedWrite(
                freeAssignments,
                attachFreeControl,
                false,
                path,
                operator,
                expectedRight,
                label,
            );
        requireAssignment(
            "camera._pitch",
            ts.SyntaxKind.EqualsToken,
            "Math.max(-maxPitch, Math.min(maxPitch, camera._pitch))",
            "FreeCamera pitch clamp",
        );
        requireAssignment(
            "camera.position.x",
            ts.SyntaxKind.PlusEqualsToken,
            "sinY * cosP * cdZ + cosY * cdX",
            "FreeCamera X movement",
        );
        requireAssignment(
            "cdX",
            ts.SyntaxKind.AsteriskEqualsToken,
            "inertia",
            "FreeCamera movement inertia",
        );
        // The look accumulation and its application signs. The pin
        // accumulates crY/crX from the pointer deltas and applies
        // _yaw += crY, _pitch -= crX; the record keeps both offsets in
        // apply-additive form (apply_free_camera_inertia adds them), so
        // the pitch sign folds into the emitted accumulator and both
        // pinned statements anchor that fold.
        this.context.assertExpressionShape(
            this.context.variableInitializer(attachFreeControl, "dx"),
            "e.clientX - lastPX",
            "FreeCamera pointer delta X",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(attachFreeControl, "dy"),
            "e.clientY - lastPY",
            "FreeCamera pointer delta Y",
        );
        requireAssignment(
            "crY",
            ts.SyntaxKind.PlusEqualsToken,
            "dx / camera.angularSensitivity",
            "FreeCamera yaw accumulation",
        );
        requireAssignment(
            "crX",
            ts.SyntaxKind.PlusEqualsToken,
            "dy / camera.angularSensitivity",
            "FreeCamera pitch accumulation",
        );
        requireAssignment(
            "camera._yaw",
            ts.SyntaxKind.PlusEqualsToken,
            "crY",
            "FreeCamera yaw application",
        );
        requireAssignment(
            "camera._pitch",
            ts.SyntaxKind.MinusEqualsToken,
            "crX",
            "FreeCamera pitch application",
        );
        // Each pressed key contributes exactly one moveSpeed step to a
        // direction accumulator; one axis anchors the shape, the platform
        // layer owns only the scancode translation.
        requireAssignment(
            "cdZ",
            ts.SyntaxKind.PlusEqualsToken,
            "moveSpeed",
            "FreeCamera forward accumulation",
        );
        // The pinned pitch ceiling is `Math.PI / 2 - <margin>`; the
        // quarter-turn divisor and the margin both flow into the emitted
        // `max_pitch` line (whose `pi_double` mirrors the pinned
        // Math.PI), so a retuned margin regenerates rather than
        // passing behind the shape assert above.
        const maxPitchInitializer =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    attachFreeControl,
                    "maxPitch",
                ),
            );
        if (
            !ts.isBinaryExpression(maxPitchInitializer) ||
            maxPitchInitializer.operatorToken.kind !==
                ts.SyntaxKind.MinusToken
        ) {
            this.context.contractError(
                maxPitchInitializer,
                "Expected the pitch ceiling to subtract a margin.",
            );
        }
        const pitchQuarterTurn = this.context.unwrapExpression(
            maxPitchInitializer.left,
        );
        if (
            !ts.isBinaryExpression(pitchQuarterTurn) ||
            pitchQuarterTurn.operatorToken.kind !==
                ts.SyntaxKind.SlashToken ||
            this.context
                .propertyPath(pitchQuarterTurn.left)
                ?.join(".") !== "Math.PI"
        ) {
            this.context.contractError(
                maxPitchInitializer,
                "Expected the pitch ceiling to divide Math.PI.",
            );
        }
        const pitchDivisor = this.context.numericValue(
            pitchQuarterTurn.right,
            freeFile,
        );
        const pitchMargin = this.context.numericValue(
            maxPitchInitializer.right,
            freeFile,
        );
        // The pinned stop thresholds both scale with the camera speed.
        // The emitted `apply_free_camera_inertia` uses one `epsilon` for
        // movement and rotation, so the two pinned scales must agree for
        // that sharing to stay faithful; the shared factor then flows.
        const freeStopScale = (name: string): number => {
            const initializer = this.context.unwrapExpression(
                this.context.variableInitializer(
                    attachFreeControl,
                    name,
                ),
            );
            if (
                !ts.isBinaryExpression(initializer) ||
                initializer.operatorToken.kind !==
                    ts.SyntaxKind.AsteriskToken ||
                this.context
                    .propertyPath(initializer.left)
                    ?.join(".") !== "camera.speed"
            ) {
                this.context.contractError(
                    initializer,
                    `Expected ${name} to scale with the camera speed.`,
                );
            }
            return this.context.numericValue(
                initializer.right,
                freeFile,
            );
        };
        const moveStopScale = freeStopScale("moveEpsilon");
        if (moveStopScale !== freeStopScale("rotEpsilon")) {
            this.context.contractError(
                attachFreeControl,
                "Expected one shared free-camera stop-threshold scale.",
            );
        }
        // The pinned per-frame move scale: update computes
        // moveSpeed = camera.speed * Math.sqrt((dt * dt) / <divisor>)
        // from dt = Math.max(deltaMs, <floor>). Both numbers flow into
        // the emitted free_camera_move_speed, which evaluates the pin's
        // own formula at full precision from whatever frame step the
        // caller hands in — the native loop's fixed cadence stays a
        // platform fact, never a hand-evaluated constant.
        const frameStep = this.context.unwrapExpression(
            this.context.variableInitializer(
                attachFreeControl,
                "dt",
            ),
        );
        if (
            !ts.isCallExpression(frameStep) ||
            this.context
                .propertyPath(frameStep.expression)
                ?.join(".") !== "Math.max" ||
            frameStep.arguments.length !== 2 ||
            this.context
                .propertyPath(frameStep.arguments[0]!)
                ?.join(".") !== "deltaMs"
        ) {
            this.context.contractError(
                frameStep,
                "Expected the free-camera frame step to floor deltaMs.",
            );
        }
        const frameStepFloor = this.context.numericValue(
            frameStep.arguments[1]!,
            freeFile,
        );
        const moveSpeed = this.context.unwrapExpression(
            this.context.variableInitializer(
                attachFreeControl,
                "moveSpeed",
            ),
        );
        if (
            !ts.isBinaryExpression(moveSpeed) ||
            moveSpeed.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            this.context
                .propertyPath(moveSpeed.left)
                ?.join(".") !== "camera.speed"
        ) {
            this.context.contractError(
                moveSpeed,
                "Expected the move speed to scale with the camera speed.",
            );
        }
        const moveSqrt = this.context.unwrapExpression(moveSpeed.right);
        if (
            !ts.isCallExpression(moveSqrt) ||
            this.context
                .propertyPath(moveSqrt.expression)
                ?.join(".") !== "Math.sqrt" ||
            moveSqrt.arguments.length !== 1
        ) {
            this.context.contractError(
                moveSpeed,
                "Expected the move scale to take a square root.",
            );
        }
        const moveRatio = this.context.unwrapExpression(
            moveSqrt.arguments[0]!,
        );
        if (
            !ts.isBinaryExpression(moveRatio) ||
            moveRatio.operatorToken.kind !== ts.SyntaxKind.SlashToken
        ) {
            this.context.contractError(
                moveRatio,
                "Expected the move scale to divide the squared step.",
            );
        }
        this.context.assertExpressionShape(
            moveRatio.left,
            "dt * dt",
            "FreeCamera move-scale numerator",
        );
        const moveScaleDivisor = this.context.numericValue(
            moveRatio.right,
            freeFile,
        );
        const dvalue = (input: number): string => this.context.doubleLiteral(input);
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

namespace bbl::upstream {

// Event accumulation from the pinned attachControl/attachFreeControl
// handlers. dx/dy are the pin's client-pixel pointer deltas and delta_y
// is the DOM WheelEvent deltaY; the platform layer translates its native
// events into those units and owns none of the math.
void apply_arc_rotate_pointer_rotation(
    CameraRecord& camera,
    double dx,
    double dy);
void apply_arc_rotate_pointer_pan(
    CameraRecord& camera,
    double dx,
    double dy);
void apply_arc_rotate_wheel(CameraRecord& camera, double delta_y);
void apply_free_camera_pointer_rotation(
    CameraRecord& camera,
    double dx,
    double dy);
// The pinned per-frame move scale from attachFreeControl's update; the
// caller hands in the frame step it runs at, in milliseconds.
double free_camera_move_speed(const CameraRecord& camera, double delta_ms);

void apply_arc_rotate_inertia(CameraRecord& camera);
void apply_free_camera_inertia(CameraRecord& camera);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName, `${freeModule}#attachFreeControl`)}
#include <bblite/upstream/camera_controls.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace bbl {

void clamp_camera_to_limits(CameraRecord& camera);
${this.trackVersions ? new CameraMutationLowerer(this.context).setters() : `
void write_camera_scalar(CameraRecord& camera, double CameraRecord::*field, double value) {
    camera.*field = value;
}
void write_camera_vector_component(CameraRecord& camera, Vec3d CameraRecord::*vector,
    double Vec3d::*component, double value) {
    (camera.*vector).*component = value;
}
void set_camera_vector(CameraRecord& camera, Vec3d CameraRecord::*vector, Vec3d value) {
    camera.*vector = value;
}`}

void clamp_camera_to_limits(CameraRecord& camera) {
${this.trackVersions ? new CameraMutationLowerer(this.context).clamp() : `    if (camera.lower_radius_limit && camera.radius < *camera.lower_radius_limit) {
        camera.radius = *camera.lower_radius_limit;
        camera.inertial_radius_offset = 0.0;
    } else if (camera.upper_radius_limit && camera.radius > *camera.upper_radius_limit) {
        camera.radius = *camera.upper_radius_limit;
        camera.inertial_radius_offset = 0.0;
    }
    if (camera.lower_beta_limit && camera.beta < *camera.lower_beta_limit) {
        camera.beta = *camera.lower_beta_limit;
        camera.inertial_beta_offset = 0.0;
    } else if (camera.upper_beta_limit && camera.beta > *camera.upper_beta_limit) {
        camera.beta = *camera.upper_beta_limit;
        camera.inertial_beta_offset = 0.0;
    }
    if (camera.lower_alpha_limit && camera.alpha < *camera.lower_alpha_limit) {
        camera.alpha = *camera.lower_alpha_limit;
        camera.inertial_alpha_offset = 0.0;
    } else if (camera.upper_alpha_limit && camera.alpha > *camera.upper_alpha_limit) {
        camera.alpha = *camera.upper_alpha_limit;
        camera.inertial_alpha_offset = 0.0;
    }`}
}

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
${this.trackVersions ? "    camera.limits_installed = true;" : ""}
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

// The pointer and wheel accumulations (attachControl's onPointerMove and
// onWheel): each event delta is divided by the sensibility the pin
// snapshots from the live camera field on that same event — so reading
// the record field here is the same value — and folded into the inertial
// accumulators the per-frame applyInertia integrates.
void apply_arc_rotate_pointer_rotation(
    CameraRecord& camera,
    double dx,
    double dy) {
    camera.inertial_alpha_offset -= dx / camera.angular_sensibility;
    camera.inertial_beta_offset -= dy / camera.angular_sensibility;
}

void apply_arc_rotate_pointer_pan(
    CameraRecord& camera,
    double dx,
    double dy) {
    camera.inertial_panning_x += -dx / camera.panning_sensibility;
    camera.inertial_panning_y += dy / camera.panning_sensibility;
}

void apply_arc_rotate_wheel(CameraRecord& camera, double delta_y) {
    camera.inertial_radius_offset -=
        (delta_y * camera.radius) /
        (camera.wheel_precision * ${dvalue(wheelPrecisionScale)});
}

void apply_arc_rotate_inertia(CameraRecord& camera) {
${this.trackVersions ? new CameraMutationLowerer(this.context).inertia() : `    constexpr double rotation_epsilon = ${dvalue(rotationEpsilon)};
    constexpr double radius_epsilon = ${dvalue(radiusEpsilon)};
    constexpr double panning_epsilon = ${dvalue(panningEpsilon)};
    if (camera.inertial_alpha_offset != 0.0 || camera.inertial_beta_offset != 0.0) {
        camera.alpha += camera.inertial_alpha_offset;
        camera.beta += camera.inertial_beta_offset;
        constexpr double epsilon = ${dvalue(betaClampEpsilon)};
        camera.beta = std::max(epsilon, std::min(pi_double - epsilon, camera.beta));
        bbl::clamp_camera_to_limits(camera);
        camera.inertial_alpha_offset *= camera.inertia;
        camera.inertial_beta_offset *= camera.inertia;
        if (std::abs(camera.inertial_alpha_offset) < rotation_epsilon) camera.inertial_alpha_offset = 0.0;
        if (std::abs(camera.inertial_beta_offset) < rotation_epsilon) camera.inertial_beta_offset = 0.0;
    }

    if (camera.inertial_radius_offset != 0.0) {
        camera.radius -= camera.inertial_radius_offset;
        camera.radius = std::max(${dvalue(radiusFloor)}, camera.radius);
        bbl::clamp_camera_to_limits(camera);
        camera.inertial_radius_offset *= camera.inertia;
        if (std::abs(camera.inertial_radius_offset) < radius_epsilon) camera.inertial_radius_offset = 0.0;
    }
    if (camera.inertial_panning_x != 0.0 || camera.inertial_panning_y != 0.0) {
        const double cosine = std::cos(camera.alpha);
        const double sine = std::sin(camera.alpha);
        const double pan_scale = camera.radius * ${dvalue(panScaleFactor)};
        camera.target.x += -sine * camera.inertial_panning_x * pan_scale;
        camera.target.y += camera.inertial_panning_y * pan_scale;
        camera.target.z += cosine * camera.inertial_panning_x * pan_scale;
        camera.inertial_panning_x *= camera.panning_inertia;
        camera.inertial_panning_y *= camera.panning_inertia;
        if (std::abs(camera.inertial_panning_x) < panning_epsilon) camera.inertial_panning_x = 0.0;
        if (std::abs(camera.inertial_panning_y) < panning_epsilon) camera.inertial_panning_y = 0.0;
    }`}
}

// src/camera/free-camera-controls.ts accumulates crY += dx / sensitivity
// and crX += dy / sensitivity, then applies _yaw += crY and
// _pitch -= crX. The record keeps both offsets in apply-additive form
// (apply_free_camera_inertia adds them), so the pinned pitch sign folds
// into this accumulation.
void apply_free_camera_pointer_rotation(
    CameraRecord& camera,
    double dx,
    double dy) {
    camera.inertial_yaw_offset += dx / camera.angular_sensibility;
    camera.inertial_pitch_offset -= dy / camera.angular_sensibility;
}

// The pinned per-frame move scale each pressed key contributes to the
// direction accumulator: update floors the frame step and takes
// camera.speed * sqrt(dt^2 / the pinned divisor), evaluated here at
// full double precision from whatever step the caller runs at.
double free_camera_move_speed(
    const CameraRecord& camera,
    double delta_ms) {
    const double dt = std::max(delta_ms, ${dvalue(frameStepFloor)});
    return camera.speed *
        std::sqrt((dt * dt) / ${dvalue(moveScaleDivisor)});
}

void apply_free_camera_inertia(CameraRecord& camera) {
    const bool has_rotation =
        camera.inertial_yaw_offset != 0.0 ||
        camera.inertial_pitch_offset != 0.0;
    const bool has_movement =
        camera.inertial_direction.x != 0.0 ||
        camera.inertial_direction.y != 0.0 ||
        camera.inertial_direction.z != 0.0;
    if (has_rotation) {
        camera.free_yaw += camera.inertial_yaw_offset;
        camera.free_pitch += camera.inertial_pitch_offset;
        constexpr double max_pitch = pi_double / ${dvalue(pitchDivisor)} - ${dvalue(pitchMargin)};
        camera.free_pitch =
            std::max(-max_pitch, std::min(max_pitch, camera.free_pitch));
    }
    const double cosine_yaw = std::cos(camera.free_yaw);
    const double sine_yaw = std::sin(camera.free_yaw);
    const double cosine_pitch = std::cos(camera.free_pitch);
    const double sine_pitch = std::sin(camera.free_pitch);
    if (has_movement) {
        camera.position.x +=
            sine_yaw * cosine_pitch * camera.inertial_direction.z +
            cosine_yaw * camera.inertial_direction.x;
        camera.position.y +=
            sine_pitch * camera.inertial_direction.z +
            camera.inertial_direction.y;
        camera.position.z +=
            cosine_yaw * cosine_pitch * camera.inertial_direction.z -
            sine_yaw * camera.inertial_direction.x;
    }
    if (has_movement || has_rotation) {
        camera.target = Vec3d{
            camera.position.x + sine_yaw * cosine_pitch,
            camera.position.y + sine_pitch,
            camera.position.z + cosine_yaw * cosine_pitch,
        };
    }
    camera.inertial_direction.x *= camera.inertia;
    camera.inertial_direction.y *= camera.inertia;
    camera.inertial_direction.z *= camera.inertia;
    camera.inertial_yaw_offset *= camera.inertia;
    camera.inertial_pitch_offset *= camera.inertia;
    const double epsilon = camera.speed * ${dvalue(moveStopScale)};
    if (std::abs(camera.inertial_direction.x) < epsilon) {
        camera.inertial_direction.x = 0.0;
    }
    if (std::abs(camera.inertial_direction.y) < epsilon) {
        camera.inertial_direction.y = 0.0;
    }
    if (std::abs(camera.inertial_direction.z) < epsilon) {
        camera.inertial_direction.z = 0.0;
    }
    if (std::abs(camera.inertial_yaw_offset) < epsilon) {
        camera.inertial_yaw_offset = 0.0;
    }
    if (std::abs(camera.inertial_pitch_offset) < epsilon) {
        camera.inertial_pitch_offset = 0.0;
    }
}

} // namespace bbl::upstream
`,
        };
    }
}
