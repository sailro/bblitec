import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class CameraLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerArcRotateFactory(): LoweredSource {
        const modulePath = "src/camera/arc-rotate.ts";
        const symbolName = "createArcRotateCamera";
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
        const camera = this.context.objectInitializer(declaration, "cam");
        const number = (name: string): string =>
            this.context.floatLiteral(
                this.context.numericValue(this.context.propertyInitializer(camera, name), file),
            );
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

namespace bbl::upstream {

Vec3 arc_rotate_eye_position(const CameraRecord& camera);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/camera_math.hpp>
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl::upstream {

Vec3 arc_rotate_eye_position(const CameraRecord& camera) {
    if (camera.kind == CameraKind::free) return camera.position;
    const float cosine_alpha = std::cos(camera.alpha);
    const float sine_alpha = std::sin(camera.alpha);
    const float cosine_beta = std::cos(camera.beta);
    float sine_beta = std::sin(camera.beta);
    if (sine_beta == 0.0f) sine_beta = ${this.context.floatLiteral(poleEpsilon)};
    return Vec3{
        camera.target.x + camera.radius * cosine_alpha * sine_beta,
        camera.target.y + camera.radius * cosine_beta,
        camera.target.z + camera.radius * sine_alpha * sine_beta,
    };
}

} // namespace bbl::upstream

namespace bbl {

CameraHandle create_arc_rotate_camera(
    Engine& engine,
    float alpha,
    float beta,
    float radius,
    Vec3 target) {
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
            this.context.floatLiteral(
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
    Vec3 position,
    Vec3 target) {
    const float dx = target.x - position.x;
    const float dy = target.y - position.y;
    const float dz = target.z - position.z;
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

    public lowerDefaultFactory(): LoweredSource {
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
    return Vec3{
        point.x + mesh.position.x,
        point.y + mesh.position.y,
        point.z + mesh.position.z,
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
        const MeshRecord& mesh = engine.meshes[handle.value];
        Vec3 local_min{};
        Vec3 local_max{};
        if (mesh.primitive == PrimitiveKind::gltf && mesh.geometry < engine.geometries.size()) {
            local_min = engine.geometries[mesh.geometry].bounds_min;
            local_max = engine.geometries[mesh.geometry].bounds_max;
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
    const CameraHandle camera = create_arc_rotate_camera(engine, -pi / 2.0f, pi / 2.0f, radius, center);
    CameraRecord& record = engine.cameras[camera.value];
    record.near_plane = radius * ${value(nearScale)};
    record.far_plane = radius * ${value(farScale)};
    scene.camera = camera;
    return camera;
}

} // namespace bbl
`,
        };
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
        const { declaration: attachFreeControl } =
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
        ): void => {
            const expression = freeAssignments.find(
                (candidate) =>
                    candidate.operatorToken.kind === operator &&
                    this.context
                        .propertyPath(candidate.left)
                        ?.join(".") === path,
            );
            if (!expression) {
                this.context.contractError(
                    attachFreeControl,
                    `Expected ${label}.`,
                );
            }
            this.context.assertExpressionShape(
                expression.right,
                expectedRight,
                label,
            );
        };
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
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

namespace bbl::upstream {

void apply_arc_rotate_inertia(CameraRecord& camera);
void apply_free_camera_inertia(CameraRecord& camera);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/camera_controls.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace bbl {

void attach_control(Engine& engine, CameraHandle camera, Scene& scene) {
    if (camera.value >= engine.cameras.size()) throw std::runtime_error("Invalid camera handle.");
    engine.cameras[camera.value].controls_enabled = true;
    scene.camera = camera;
}

void attach_free_control(
    Engine& engine,
    CameraHandle camera,
    Scene& scene) {
    if (camera.value >= engine.cameras.size()) {
        throw std::runtime_error("Invalid camera handle.");
    }
    CameraRecord& record = engine.cameras[camera.value];
    record.kind = CameraKind::free;
    record.controls_enabled = true;
    scene.camera = camera;
}

} // namespace bbl

namespace bbl::upstream {

void apply_arc_rotate_inertia(CameraRecord& camera) {
    constexpr float rotation_epsilon = ${value(rotationEpsilon)};
    constexpr float radius_epsilon = ${value(radiusEpsilon)};
    constexpr float panning_epsilon = ${value(panningEpsilon)};
    if (camera.inertial_alpha_offset != 0.0f || camera.inertial_beta_offset != 0.0f) {
        camera.alpha += camera.inertial_alpha_offset;
        camera.beta += camera.inertial_beta_offset;
        constexpr float epsilon = 0.01f;
        camera.beta = std::max(epsilon, std::min(pi - epsilon, camera.beta));
        camera.inertial_alpha_offset *= camera.inertia;
        camera.inertial_beta_offset *= camera.inertia;
        if (std::abs(camera.inertial_alpha_offset) < rotation_epsilon) camera.inertial_alpha_offset = 0.0f;
        if (std::abs(camera.inertial_beta_offset) < rotation_epsilon) camera.inertial_beta_offset = 0.0f;
    }

    if (camera.inertial_radius_offset != 0.0f) {
        camera.radius -= camera.inertial_radius_offset;
        camera.radius = std::max(0.01f, camera.radius);
        camera.inertial_radius_offset *= camera.inertia;
        if (std::abs(camera.inertial_radius_offset) < radius_epsilon) camera.inertial_radius_offset = 0.0f;
    }
    if (camera.inertial_panning_x != 0.0f || camera.inertial_panning_y != 0.0f) {
        const float cosine = std::cos(camera.alpha);
        const float sine = std::sin(camera.alpha);
        const float pan_scale = camera.radius * 0.001f;
        camera.target.x += -sine * camera.inertial_panning_x * pan_scale;
        camera.target.y += camera.inertial_panning_y * pan_scale;
        camera.target.z += cosine * camera.inertial_panning_x * pan_scale;
        camera.inertial_panning_x *= camera.panning_inertia;
        camera.inertial_panning_y *= camera.panning_inertia;
        if (std::abs(camera.inertial_panning_x) < panning_epsilon) camera.inertial_panning_x = 0.0f;
        if (std::abs(camera.inertial_panning_y) < panning_epsilon) camera.inertial_panning_y = 0.0f;
    }
}

void apply_free_camera_inertia(CameraRecord& camera) {
    const bool has_rotation =
        camera.inertial_yaw_offset != 0.0f ||
        camera.inertial_pitch_offset != 0.0f;
    const bool has_movement =
        camera.inertial_direction.x != 0.0f ||
        camera.inertial_direction.y != 0.0f ||
        camera.inertial_direction.z != 0.0f;
    if (has_rotation) {
        camera.free_yaw += camera.inertial_yaw_offset;
        camera.free_pitch += camera.inertial_pitch_offset;
        constexpr float max_pitch = pi / 2.0f - 0.01f;
        camera.free_pitch =
            std::max(-max_pitch, std::min(max_pitch, camera.free_pitch));
    }
    const float cosine_yaw = std::cos(camera.free_yaw);
    const float sine_yaw = std::sin(camera.free_yaw);
    const float cosine_pitch = std::cos(camera.free_pitch);
    const float sine_pitch = std::sin(camera.free_pitch);
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
        camera.target = Vec3{
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
    const float epsilon = camera.speed * 0.001f;
    if (std::abs(camera.inertial_direction.x) < epsilon) {
        camera.inertial_direction.x = 0.0f;
    }
    if (std::abs(camera.inertial_direction.y) < epsilon) {
        camera.inertial_direction.y = 0.0f;
    }
    if (std::abs(camera.inertial_direction.z) < epsilon) {
        camera.inertial_direction.z = 0.0f;
    }
    if (std::abs(camera.inertial_yaw_offset) < epsilon) {
        camera.inertial_yaw_offset = 0.0f;
    }
    if (std::abs(camera.inertial_pitch_offset) < epsilon) {
        camera.inertial_pitch_offset = 0.0f;
    }
}

} // namespace bbl::upstream
`,
        };
    }
}
