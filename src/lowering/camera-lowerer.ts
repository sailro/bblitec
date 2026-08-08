import { LoweredSource, LoweringContext } from "./context.js";

export class CameraLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerArcRotateFactory(): LoweredSource {
        const modulePath = "src/camera/arc-rotate.ts";
        const symbolName = "createArcRotateCamera";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const source = this.context.store.getSource(modulePath);
        const poleEpsilon = this.context.extractNumber(
            source,
            /sinB = ([0-9.]+);/,
            "ArcRotate pole epsilon",
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

    public lowerDefaultFactory(): LoweredSource {
        const modulePath = "src/scene/scene-camera.ts";
        const symbolName = "createDefaultCamera";
        const source = this.context.store.getSource(modulePath);
        if (!source.includes("createArcRotateCamera(-(Math.PI / 2), Math.PI / 2, radius, center)")) {
            throw new Error("Upstream default ArcRotate camera angles changed.");
        }
        const radiusScale = this.context.extractNumber(source, /radius = diag \* ([0-9.]+)/, "camera radius scale");
        const fallbackRadius = this.context.extractNumber(
            source,
            /radius = ([0-9.]+);\s*\n\s*center = vec3\(0, 0, 0\)/,
            "camera fallback radius",
        );
        const nearScale = this.context.extractNumber(source, /nearPlane = radius \* ([0-9.]+)/, "camera near scale");
        const farScale = this.context.extractNumber(source, /farPlane = radius \* ([0-9.]+)/, "camera far scale");
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
    set_camera(scene, camera);
    return camera;
}

} // namespace bbl
`,
        };
    }

    public lowerControls(): LoweredSource {
        const modulePath = "src/camera/arc-rotate-controls.ts";
        const symbolName = "attachControl";
        const source = this.context.store.getSource(modulePath);
        const rotationEpsilon = this.context.extractNumber(source, /ROTATION_EPSILON = ([0-9.]+)/, "rotation epsilon");
        const radiusEpsilon = this.context.extractNumber(source, /RADIUS_EPSILON = ([0-9.]+)/, "radius epsilon");
        const panningEpsilon = this.context.extractNumber(source, /PANNING_EPSILON = ([0-9.]+)/, "panning epsilon");
        if (!source.includes("camera.inertialAlphaOffset *= camera.inertia")) {
            throw new Error("Upstream ArcRotate inertia semantics changed.");
        }
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <bblite/runtime.hpp>

namespace bbl::upstream {

void apply_arc_rotate_inertia(CameraRecord& camera);

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
    set_camera(scene, camera);
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

} // namespace bbl::upstream
`,
        };
    }
}
