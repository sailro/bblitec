import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerMat4MultiplyWriterCpp } from "./pinned-function-lowerer.js";

export class CameraLowerer {
    public constructor(private readonly context: LoweringContext) {}

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
     * The camera-to-world writer both factories reach, and the two
     * constants the generated copy needs from it: the degenerate-length
     * epsilon that decides the identity fallback, and the up vector the
     * cross product is taken against. Reading them here is what makes the
     * generated matrix a port rather than a transcription — if upstream
     * moves either, generation fails instead of shading slightly wrong.
     */
    private readLookAtWorldContract(): {
        module: string;
        symbol: string;
        degenerateEpsilon: number;
        upVector: { x: number; y: number; z: number };
    } {
        const module = "src/math/mat4-look-at-world-lh.ts";
        const symbol = "mat4LookAtWorldLHToRef";
        const { file, declaration } =
            this.context.functionDeclaration(module, symbol);
        const epsilons = this.context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (expression) =>
                    (expression.operatorToken.kind ===
                        ts.SyntaxKind.GreaterThanEqualsToken ||
                        expression.operatorToken.kind ===
                            ts.SyntaxKind.LessThanToken) &&
                    ts.isIdentifier(expression.left) &&
                    /^[zx]Len$/.test(expression.left.text),
            )
            .map((expression) =>
                this.context.numericValue(expression.right, file),
            );
        if (
            epsilons.length !== 2 ||
            epsilons[0] !== epsilons[1]
        ) {
            this.context.contractError(
                declaration,
                "Expected one shared degenerate-length epsilon for the look-at basis.",
            );
        }
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
            module,
            symbol,
            degenerateEpsilon: epsilons[0]!,
            upVector: {
                x: component("x"),
                y: component("y"),
                z: component("z"),
            },
        };
    }

    public lowerArcRotateFactory(
        gltfCameras = false,
        highPrecisionMatrix = false,
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
        const poleAssignments = this.context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isIdentifier(expression.left) &&
                    expression.left.text === "sinB" &&
                    ts.isNumericLiteral(expression.right),
            );
        if (poleAssignments.length !== 1) {
            this.context.contractError(
                declaration,
                "Expected one ArcRotate pole fallback.",
            );
        }
        const poleEpsilon = this.context.numericValue(
            poleAssignments[0]!.right,
            file,
        );
        const {
            module: lookAtModule,
            symbol: lookAtSymbol,
            degenerateEpsilon,
            upVector,
        } = this.readLookAtWorldContract();
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
namespace {

${lowerMat4MultiplyWriterCpp(this.context)}

} // namespace

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
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl::upstream {

Vec3d arc_rotate_eye_position(const CameraRecord& camera) {
    if (camera.kind == CameraKind::free) return camera.position;
    const double cosine_alpha = std::cos(camera.alpha);
    const double sine_alpha = std::sin(camera.alpha);
    const double cosine_beta = std::cos(camera.beta);
    double sine_beta = std::sin(camera.beta);
    if (sine_beta == 0.0) sine_beta = ${this.context.doubleLiteral(poleEpsilon)};
    return Vec3d{
        camera.target.x + camera.radius * cosine_alpha * sine_beta,
        camera.target.y + camera.radius * cosine_beta,
        camera.target.z + camera.radius * sine_alpha * sine_beta,
    };
}

${parentArm}// ${this.context.provenance(lookAtModule, lookAtSymbol)}
// The camera-to-world matrix both factories write through
// \`createWorldMatrixState\`; with no parent the world matrix *is* this
// local one (\`src/scene/world-matrix-state.ts\` getWorldMatrix), and the
// storage is the \`allocateMat4()\` Float32Array. So every term is
// computed in double and stored once as float, and \`getViewMatrix\`
// downstream reads these rounded values exactly as the pin does.
std::array<CameraMatrixScalar, 16> ${gltfCameras ? "camera_local_matrix" : "camera_world_matrix"}(const CameraRecord& camera) {
    const Vec3d eye = arc_rotate_eye_position(camera);
    std::array<CameraMatrixScalar, 16> out{};
    out[3] = 0;
    out[7] = 0;
    out[11] = 0;
    out[12] = static_cast<CameraMatrixScalar>(eye.x);
    out[13] = static_cast<CameraMatrixScalar>(eye.y);
    out[14] = static_cast<CameraMatrixScalar>(eye.z);
    out[15] = 1;

    // Left-handed: +Z points from the eye towards the target.
    double zx = camera.target.x - eye.x;
    double zy = camera.target.y - eye.y;
    double zz = camera.target.z - eye.z;
    const double z_length = std::sqrt(zx * zx + zy * zy + zz * zz);
    double xx = 0.0;
    double xy = 0.0;
    double xz = 0.0;
    double x_length = 0.0;
    if (z_length >= ${this.context.doubleLiteral(degenerateEpsilon)}) {
        const double inverse_z = 1.0 / z_length;
        zx *= inverse_z;
        zy *= inverse_z;
        zz *= inverse_z;
        // xAxis = cross(up, zAxis), against the pinned Vec3Up.
        xx = ${this.context.doubleLiteral(upVector.y)} * zz - ${this.context.doubleLiteral(upVector.z)} * zy;
        xy = ${this.context.doubleLiteral(upVector.z)} * zx - ${this.context.doubleLiteral(upVector.x)} * zz;
        xz = ${this.context.doubleLiteral(upVector.x)} * zy - ${this.context.doubleLiteral(upVector.y)} * zx;
        x_length = std::sqrt(xx * xx + xy * xy + xz * xz);
    }
    if (x_length < ${this.context.doubleLiteral(degenerateEpsilon)}) {
        out[0] = 1;
        out[5] = 1;
        out[10] = 1;
        return out;
    }
    const double inverse_x = 1.0 / x_length;
    xx *= inverse_x;
    xy *= inverse_x;
    xz *= inverse_x;

    out[0] = static_cast<CameraMatrixScalar>(xx);
    out[1] = static_cast<CameraMatrixScalar>(xy);
    out[2] = static_cast<CameraMatrixScalar>(xz);
    // yAxis = cross(zAxis, xAxis) -- already unit, both operands are.
    out[4] = static_cast<CameraMatrixScalar>(zy * xz - zz * xy);
    out[5] = static_cast<CameraMatrixScalar>(zz * xx - zx * xz);
    out[6] = static_cast<CameraMatrixScalar>(zx * xy - zy * xx);
    out[8] = static_cast<CameraMatrixScalar>(zx);
    out[9] = static_cast<CameraMatrixScalar>(zy);
    out[10] = static_cast<CameraMatrixScalar>(zz);
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
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
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
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace bbl {
namespace {

Vec3 rotate_bounds_point(Vec3 point, Vec3 rotation) {
    const float sin_x = std::sin(rotation.x);
    const float cos_x = std::cos(rotation.x);
    const float sin_y = std::sin(rotation.y);
    const float cos_y = std::cos(rotation.y);
    const float sin_z = std::sin(rotation.z);
    const float cos_z = std::cos(rotation.z);
    point = Vec3{point.x, point.y * cos_x - point.z * sin_x, point.y * sin_x + point.z * cos_x};
    point = Vec3{point.x * cos_y + point.z * sin_y, point.y, -point.x * sin_y + point.z * cos_y};
    return Vec3{
        point.x * cos_z - point.y * sin_z,
        point.x * sin_z + point.y * cos_z,
        point.z,
    };
}

Vec3 transform_bounds_point(Vec3 point, const MeshRecord& mesh) {
    point = Vec3{
        point.x * mesh.scaling.x,
        point.y * mesh.scaling.y,
        point.z * mesh.scaling.z,
    };
    point = rotate_bounds_point(point, mesh.rotation);
    point = Vec3{
        static_cast<float>(
            static_cast<double>(point.x) + mesh.position.x),
        static_cast<float>(
            static_cast<double>(point.y) + mesh.position.y),
        static_cast<float>(
            static_cast<double>(point.z) + mesh.position.z),
    };
    point = rotate_bounds_point(point, mesh.outer_rotation);
    // The translation is the record's double; the sum is taken at that
    // width and stored once, as every other consumer of it does.
    return Vec3{
        static_cast<float>(
            static_cast<double>(point.x) +
            static_cast<double>(mesh.outer_position.x)),
        static_cast<float>(
            static_cast<double>(point.y) +
            static_cast<double>(mesh.outer_position.y)),
        static_cast<float>(
            static_cast<double>(point.z) +
            static_cast<double>(mesh.outer_position.z)),
    };
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

void clamp_camera_to_limits(CameraRecord& camera) {
    if (camera.lower_radius_limit && camera.radius < *camera.lower_radius_limit) {
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
    }
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
    constexpr double rotation_epsilon = ${dvalue(rotationEpsilon)};
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
    }
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
