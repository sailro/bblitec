import { LoweredSource, LoweringContext } from "./context.js";

interface ArcRotateDefaults {
    fov: number;
    nearPlane: number;
    farPlane: number;
    inertia: number;
    panningInertia: number;
    angularSensibility: number;
    panningSensibility: number;
    wheelPrecision: number;
}

export class CameraLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerArcRotateFactory(): LoweredSource {
        const modulePath = "src/camera/arc-rotate.ts";
        const symbolName = "createArcRotateCamera";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const camera = this.context.objectInitializer(declaration, "cam");
        const number = (name: string): number =>
            this.context.numericValue(this.context.propertyInitializer(camera, name), file);
        const defaults: ArcRotateDefaults = {
            fov: number("fov"),
            nearPlane: number("nearPlane"),
            farPlane: number("farPlane"),
            inertia: number("inertia"),
            panningInertia: number("panningInertia"),
            angularSensibility: number("angularSensibility"),
            panningSensibility: number("panningSensibility"),
            wheelPrecision: number("wheelPrecision"),
        };
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

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
    camera.fov = ${value(defaults.fov)};
    camera.near_plane = ${value(defaults.nearPlane)};
    camera.far_plane = ${value(defaults.farPlane)};
    camera.inertia = ${value(defaults.inertia)};
    camera.panning_inertia = ${value(defaults.panningInertia)};
    camera.angular_sensibility = ${value(defaults.angularSensibility)};
    camera.panning_sensibility = ${value(defaults.panningSensibility)};
    camera.wheel_precision = ${value(defaults.wheelPrecision)};
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
        const radiusScale = this.context.extractNumber(
            source,
            /radius = diag \* ([0-9.]+)/,
            "camera radius scale",
        );
        const fallbackRadius = this.context.extractNumber(
            source,
            /radius = ([0-9.]+);\s*\n\s*center = vec3\(0, 0, 0\)/,
            "camera fallback radius",
        );
        const nearScale = this.context.extractNumber(
            source,
            /nearPlane = radius \* ([0-9.]+)/,
            "camera near scale",
        );
        const farScale = this.context.extractNumber(
            source,
            /farPlane = radius \* ([0-9.]+)/,
            "camera far scale",
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
        for (const Vec3 corner : corners) {
            extend_bounds(transform_bounds_point(corner, mesh), minimum, maximum);
        }
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

    const CameraHandle camera = create_arc_rotate_camera(
        engine,
        -pi / 2.0f,
        pi / 2.0f,
        radius,
        center);
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
}
