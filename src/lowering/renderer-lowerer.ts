import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { RendererFidelityManifest } from "../fidelity.js";
import type {
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    ShaderMaterialVariantName,
} from "../compiler.js";
import { LoweredSource, LoweringContext } from "./context.js";

const renderTaskModule = "src/frame-graph/render-task.ts";
const pbrTemplateModule = "src/material/pbr/pbr-template.ts";
const pbrHelperCoreModule = "src/material/node/blocks/pbr-mr-helper-core.ts";
const iblFragmentModule = "src/material/pbr/fragments/ibl-fragment.ts";
const sceneUniformsModule = "src/frame-graph/scene-uniforms-pack.ts";
const backgroundGroundModule = "src/material/pbr/background-ground.ts";
const backgroundDdsModule = "src/material/pbr/background-dds-skybox.ts";
const rgbdDecodeModule = "src/loader-env/rgbd-decode.ts";
const surfaceModule = "src/engine/surface.ts";
const templateRoot = fileURLToPath(new URL("../../../src/lowering/templates/renderer/", import.meta.url));

interface LoweredShader {
    output: string;
    data: string;
}

function geometryExpression(
    type: GeometryTextureTypeName,
    language: "hlsl" | "msl",
): string {
    const uniforms = language === "hlsl" ? "" : "uniforms.";
    const vector4 = language === "hlsl" ? "float4" : "float4";
    const write = "(alpha > 0.4 ? 1.0 : 0.0)";
    switch (type) {
        case "IRRADIANCE":
            return `${vector4}(directDiffuse + finalIrradiance, ${write})`;
        case "WORLD_POSITION":
            return `${vector4}(input.worldPosition, ${write})`;
        case "LOCAL_POSITION":
            return `${vector4}(input.localPosition, ${write})`;
        case "REFLECTIVITY":
            return `${vector4}(f0, 1.0 - roughness) * ${write}`;
        case "VIEW_DEPTH":
            return `${vector4}(dot(input.worldPosition - ${uniforms}cameraPosition.xyz, ${uniforms}cameraForwardNear.xyz), 0.0, 0.0, ${write})`;
        case "NORMALIZED_VIEW_DEPTH":
            return `${vector4}((dot(input.worldPosition - ${uniforms}cameraPosition.xyz, ${uniforms}cameraForwardNear.xyz) - ${uniforms}cameraForwardNear.w) / max(${uniforms}cameraPosition.w - ${uniforms}cameraForwardNear.w, 0.0001), 0.0, 0.0, ${write})`;
        case "SCREENSPACE_DEPTH":
            return `${vector4}(1.0 - input.position.z, 0.0, 0.0, ${write})`;
        case "VIEW_NORMAL":
            return `${vector4}(normalize(float3(dot(normal, ${uniforms}viewRight.xyz), dot(normal, ${uniforms}viewUp.xyz), dot(normal, ${uniforms}viewForward.xyz))), ${write})`;
        case "WORLD_NORMAL":
            return `${vector4}(normal * 0.5 + 0.5, ${write})`;
        case "ALBEDO":
            return `${vector4}(surfaceAlbedo, ${write})`;
        case "LINEAR_VELOCITY":
            return `${vector4}(0.0, 0.0, 0.0, ${write})`;
    }
}

function geometryShaderPrefix(
    task: GeometryOutputTaskManifest,
    language: "hlsl" | "msl",
    provenance: string,
): string {
    const fields = task.attachments.map((_, index) =>
        language === "hlsl"
            ? `float4 f${index} : SV_Target${index};`
            : `float4 f${index} [[color(${index})]];`,
    );
    if (task.emitColor) {
        const index = task.attachments.length;
        fields.push(
            language === "hlsl"
                ? `float4 color : SV_Target${index};`
                : `float4 color [[color(${index})]];`,
        );
    }
    const writes = task.attachments.map(
        (type, index) =>
            `output.f${index} = ${geometryExpression(type, language)};`,
    );
    if (task.emitColor) {
        writes.push(
            language === "hlsl"
                ? "output.color = float4(color, materialOptions.x > 1.5 ? alpha : 1.0);"
                : "output.color = float4(color, uniforms.materialOptions.x > 1.5 ? alpha : 1.0);",
        );
    }
    return `// ${provenance}
#define BBLITE_GEOMETRY_OUTPUT 1
#define BBLITE_GEOMETRY_OUTPUT_STRUCT ${fields.join(" ")}
#define BBLITE_GEOMETRY_OUTPUT_WRITES ${writes.join(" ")}
`;
}

function standardGeometryExpression(
    type: GeometryTextureTypeName,
    language: "hlsl" | "msl",
): string {
    const uniforms = language === "hlsl" ? "" : "uniforms.";
    const write = "(alpha > 0.4 ? 1.0 : 0.0)";
    switch (type) {
        case "IRRADIANCE":
            return `float4(0.0, 0.0, 0.0, ${write})`;
        case "WORLD_POSITION":
            return `float4(input.worldPosition, ${write})`;
        case "LOCAL_POSITION":
            return `float4(input.localPosition, ${write})`;
        case "REFLECTIVITY":
            return `float4(pow(specularSample.rgb, ${
                language === "hlsl"
                    ? "float3(2.2, 2.2, 2.2)"
                    : "float3(2.2)"
            }), ${uniforms}textureOptions.y > 0.5 ? specularSample.a : 1.0) * ${write}`;
        case "VIEW_DEPTH":
            return `float4(dot(input.worldPosition - ${uniforms}cameraPosition.xyz, ${uniforms}cameraForwardNear.xyz), 0.0, 0.0, ${write})`;
        case "NORMALIZED_VIEW_DEPTH":
            return `float4((dot(input.worldPosition - ${uniforms}cameraPosition.xyz, ${uniforms}cameraForwardNear.xyz) - ${uniforms}cameraForwardNear.w) / max(${uniforms}cameraPosition.w - ${uniforms}cameraForwardNear.w, 0.0001), 0.0, 0.0, ${write})`;
        case "SCREENSPACE_DEPTH":
            return `float4(input.position.z, 0.0, 0.0, ${write})`;
        case "VIEW_NORMAL":
            return `float4(normalize(float3(dot(normalW, ${uniforms}viewRight.xyz), dot(normalW, ${uniforms}viewUp.xyz), dot(normalW, ${uniforms}viewForward.xyz))), ${write})`;
        case "WORLD_NORMAL":
            return `float4(normalW * 0.5 + 0.5, ${write})`;
        case "ALBEDO":
            return `float4(baseColor, ${write})`;
        case "LINEAR_VELOCITY":
            return `float4(0.0, 0.0, 0.0, ${write})`;
    }
}

function standardGeometryShaderPrefix(
    task: GeometryOutputTaskManifest,
    language: "hlsl" | "msl",
    provenance: string,
): string {
    const fields = task.attachments.map((_, index) =>
        language === "hlsl"
            ? `float4 f${index} : SV_Target${index};`
            : `float4 f${index} [[color(${index})]];`,
    );
    if (task.emitColor) {
        const index = task.attachments.length;
        fields.push(
            language === "hlsl"
                ? `float4 color : SV_Target${index};`
                : `float4 color [[color(${index})]];`,
        );
    }
    const writes = task.attachments.map(
        (type, index) =>
            `output.f${index} = ${standardGeometryExpression(type, language)};`,
    );
    if (task.emitColor) writes.push("output.color = color;");
    return `// ${provenance}
#define BBLITE_GEOMETRY_OUTPUT 1
#define BBLITE_GEOMETRY_OUTPUT_STRUCT ${fields.join(" ")}
#define BBLITE_GEOMETRY_OUTPUT_WRITES ${writes.join(" ")}
`;
}

export class RendererLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerRenderPlan(): LoweredSource {
        const source = this.context.store.getSource(renderTaskModule);
        const surface = this.context.store.getSource(surfaceModule);
        for (const symbol of ["buildBindings", "sortTransparentBindings", "drawList"]) {
            if (!source.includes(`function ${symbol}`)) {
                throw new Error(`${renderTaskModule} is missing ${symbol}.`);
            }
        }
        const sampleCount = this.context.extractNumber(
            surface,
            /const msaaSamples: 1 \| 4 = options\?\.msaaSamples === 1 \? 1 : ([0-9]+)/,
            "default MSAA sample count",
        );

        return {
            modulePath: renderTaskModule,
            symbolName: "buildBindings",
            header: `#pragma once

#include <bblite/runtime.hpp>

#include <array>
#include <vector>

namespace bbl::upstream {

struct RenderItem {
    MeshHandle mesh{};
    std::uint32_t geometry = invalid_handle;
    MaterialHandle material{};
};

struct PbrUniforms {
    std::array<float, 4> light_direction{};
    std::array<float, 4> light_color{};
    std::array<float, 4> ground_color{};
    std::array<float, 4> camera_position{};
    std::array<float, 4> camera_forward_near{};
    std::array<float, 4> view_right{};
    std::array<float, 4> view_up{};
    std::array<float, 4> view_forward{};
    std::array<float, 4> base_color_factor{};
    std::array<float, 4> emissive_factor{};
    std::array<float, 4> material_factors{};
    std::array<float, 4> environment_factors{};
    std::array<float, 4> material_options{};
    std::array<float, 4> normal_options{};
    std::array<std::array<float, 4>, 9> spherical_harmonics{};
};

struct StandardUniforms {
    std::array<float, 4> camera_position{};
    std::array<float, 4> camera_forward_near{};
    std::array<float, 4> view_right{};
    std::array<float, 4> view_up{};
    std::array<float, 4> view_forward{};
    std::array<float, 4> light_data{};
    std::array<float, 4> light_diffuse{};
    std::array<float, 4> light_specular{};
    std::array<float, 4> light_direction{};
    std::array<float, 4> diffuse_alpha{};
    std::array<float, 4> specular_power{};
    std::array<float, 4> emissive_level{};
    std::array<float, 4> ambient_level{};
    std::array<float, 4> texture_options{};
    std::array<float, 4> uv_options{};
    std::array<float, 4> material_options{};
    std::array<float, 4> reflection_options{};
};

struct BackgroundPlan {
    std::array<ModelVertex, 4> vertices{};
    std::array<std::uint32_t, 6> indices{};
};

struct BackgroundUniforms {
    std::array<float, 4> primary_color_alpha{};
    std::array<float, 4> background_center{};
    std::array<float, 4> camera_exposure{};
    std::array<float, 4> image_parameters{};
};

struct SkyboxPlan {
    std::array<ModelVertex, 8> vertices{};
    std::array<std::uint32_t, 36> indices{};
};

struct SkyboxUniforms {
    std::array<float, 4> primary_color_exposure{};
    std::array<float, 4> background_center{};
    std::array<float, 4> image_parameters{};
};

std::vector<RenderItem> build_render_plan(const Scene& scene, const Engine& engine);
std::uint32_t preferred_sample_count();
std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    float aspect,
    bool reverse_depth = false);
PbrUniforms build_pbr_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item);
StandardUniforms build_standard_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item);
BackgroundPlan build_background_plan(const EnvironmentState& environment);
BackgroundUniforms build_background_uniforms(
    const EnvironmentState& environment,
    const CameraRecord& camera);
SkyboxPlan build_skybox_plan(const EnvironmentState& environment);
SkyboxUniforms build_skybox_uniforms(const EnvironmentState& environment);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(
                renderTaskModule,
                "buildBindings",
                `${renderTaskModule}#sortTransparentBindings`,
            )}
#include <bblite/upstream/renderer_plan.hpp>
#include <bblite/upstream/camera_math.hpp>

#include <cmath>

namespace bbl::upstream {

namespace {

float dot(Vec3 left, Vec3 right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(dot(value, value));
    return length > 0.000001f
        ? Vec3{value.x / length, value.y / length, value.z / length}
        : Vec3{};
}

Vec3 cross(Vec3 left, Vec3 right) {
    return Vec3{
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    };
}

std::array<float, 16> multiply(
    const std::array<float, 16>& left,
    const std::array<float, 16>& right) {
    std::array<float, 16> result{};
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            for (int index = 0; index < 4; ++index) {
                result[column * 4 + row] +=
                    left[index * 4 + row] * right[column * 4 + index];
            }
        }
    }
    return result;
}

} // namespace

std::vector<RenderItem> build_render_plan(const Scene& scene, const Engine& engine) {
    std::vector<RenderItem> result;
    result.reserve(scene.meshes.size());
    for (const MeshHandle handle : scene.meshes) {
        if (handle.value >= engine.meshes.size()) {
            continue;
        }
        const MeshRecord& mesh = engine.meshes[handle.value];
        if (mesh.geometry >= engine.geometries.size()) {
            continue;
        }
        result.push_back(RenderItem{handle, mesh.geometry, mesh.material});
    }
    return result;
}

std::uint32_t preferred_sample_count() {
    return ${sampleCount}u;
}

std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    float aspect,
    bool reverse_depth) {
    const Vec3 eye = arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    const Vec3 right = normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, forward));
    const Vec3 up = cross(forward, right);
    std::array<float, 16> view{};
    view[0] = right.x;
    view[4] = right.y;
    view[8] = right.z;
    view[12] = -dot(right, eye);
    view[1] = up.x;
    view[5] = up.y;
    view[9] = up.z;
    view[13] = -dot(up, eye);
    view[2] = forward.x;
    view[6] = forward.y;
    view[10] = forward.z;
    view[14] = -dot(forward, eye);
    view[15] = 1.0f;

    const float focal = 1.0f / std::tan(camera.fov * 0.5f);
    std::array<float, 16> projection{};
    projection[0] = focal / aspect;
    projection[5] = focal;
    projection[10] = reverse_depth
        ? camera.near_plane /
            (camera.near_plane - camera.far_plane)
        : camera.far_plane /
            (camera.far_plane - camera.near_plane);
    projection[11] = 1.0f;
    projection[14] = reverse_depth
        ? (camera.near_plane * camera.far_plane) /
            (camera.far_plane - camera.near_plane)
        : (-camera.near_plane * camera.far_plane) /
            (camera.far_plane - camera.near_plane);
    return multiply(projection, view);
}

PbrUniforms build_pbr_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item) {
    PbrUniforms result;
    result.light_direction[1] = 1.0f;
    if (!scene.lights.empty() && scene.lights.front().value < engine.lights.size()) {
        const LightRecord& light = engine.lights[scene.lights.front().value];
        const Vec3 matrix_direction{
            light.local_matrix[8],
            light.local_matrix[9],
            light.local_matrix[10],
        };
        const float matrix_length = std::sqrt(
            matrix_direction.x * matrix_direction.x +
            matrix_direction.y * matrix_direction.y +
            matrix_direction.z * matrix_direction.z);
        const Vec3 direction = matrix_length > 0.000001f
            ? Vec3{
                  matrix_direction.x / matrix_length,
                  matrix_direction.y / matrix_length,
                  matrix_direction.z / matrix_length,
              }
            : light.direction;
        result.light_direction = {direction.x, direction.y, direction.z, 0.0f};
        result.light_color = {
            light.diffuse_color.r,
            light.diffuse_color.g,
            light.diffuse_color.b,
            light.intensity,
        };
        result.ground_color = {
            light.ground_color.r,
            light.ground_color.g,
            light.ground_color.b,
            0.0f,
        };
    }
    const Vec3 eye = arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    const Vec3 right = normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, forward));
    const Vec3 up = cross(forward, right);
    result.camera_position = {eye.x, eye.y, eye.z, camera.far_plane};
    result.camera_forward_near = {
        forward.x,
        forward.y,
        forward.z,
        camera.near_plane,
    };
    result.view_right = {right.x, right.y, right.z, 0.0f};
    result.view_up = {up.x, up.y, up.z, 0.0f};
    result.view_forward = {forward.x, forward.y, forward.z, 0.0f};
    result.base_color_factor = {1.0f, 1.0f, 1.0f, 1.0f};
    result.material_factors = {
        1.0f,
        1.0f,
        0.0f,
        scene.environment.has_irradiance ? 1.0f : 0.0f,
    };
    result.environment_factors = {
        scene.environment.exposure,
        scene.environment.contrast,
        0.8f,
        scene.environment.has_irradiance ? 1.0f : 0.0f,
    };
    if (item.material.value < engine.materials.size()) {
        const MaterialRecord& material = engine.materials[item.material.value];
        result.base_color_factor = {
            material.base_color_factor.r,
            material.base_color_factor.g,
            material.base_color_factor.b,
            material.base_color_factor.a,
        };
        result.emissive_factor = {
            material.emissive_factor.r,
            material.emissive_factor.g,
            material.emissive_factor.b,
            0.0f,
        };
        result.material_factors[0] = material.metallic_factor;
        result.material_factors[1] = material.roughness_factor;
        result.material_factors[2] = material.has_occlusion_texture ? 1.0f : 0.0f;
        result.material_factors[3] =
            scene.environment.has_irradiance
                ? material.environment_intensity
                : 0.0f;
        result.light_color[3] *= material.direct_intensity;
        result.material_options[2] = material.unlit ? 1.0f : 0.0f;
        result.material_options[3] = material.double_sided ? 1.0f : 0.0f;
        result.normal_options[1] =
            material.normal_texture.bytes.empty() ? 0.0f : 1.0f;
        if (
            item.geometry < engine.geometries.size() &&
            !engine.geometries[item.geometry].has_tangents &&
            !material.normal_texture.bytes.empty()) {
            result.normal_options[0] = 1.0f;
        }
        result.material_options[0] =
            material.alpha_mode == MaterialAlphaMode::blend
                ? 2.0f
                : material.alpha_mode == MaterialAlphaMode::mask
                    ? 1.0f
                    : 0.0f;
        result.material_options[1] = material.alpha_cutoff;
    }
    for (std::size_t index = 0; index < scene.environment.spherical_harmonics.size(); ++index) {
        result.spherical_harmonics[index] = {
            scene.environment.spherical_harmonics[index].r,
            scene.environment.spherical_harmonics[index].g,
            scene.environment.spherical_harmonics[index].b,
            0.0f,
        };
    }
    return result;
}

StandardUniforms build_standard_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item) {
    StandardUniforms result;
    const Vec3 eye = arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    const Vec3 right =
        normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, forward));
    const Vec3 up = cross(forward, right);
    result.camera_position = {
        eye.x,
        eye.y,
        eye.z,
        camera.far_plane,
    };
    result.camera_forward_near = {
        forward.x,
        forward.y,
        forward.z,
        camera.near_plane,
    };
    result.view_right = {right.x, right.y, right.z, 0.0f};
    result.view_up = {up.x, up.y, up.z, 0.0f};
    result.view_forward = {forward.x, forward.y, forward.z, 0.0f};
    if (
        !scene.lights.empty() &&
        scene.lights.front().value < engine.lights.size()) {
        const LightRecord& light =
            engine.lights[scene.lights.front().value];
        const Vec3 matrix_direction{
            light.local_matrix[8],
            light.local_matrix[9],
            light.local_matrix[10],
        };
        const float matrix_length = std::sqrt(
            matrix_direction.x * matrix_direction.x +
            matrix_direction.y * matrix_direction.y +
            matrix_direction.z * matrix_direction.z);
        const Vec3 direction = matrix_length > 0.000001f
            ? Vec3{
                  matrix_direction.x / matrix_length,
                  matrix_direction.y / matrix_length,
                  matrix_direction.z / matrix_length,
              }
            : light.direction;
        result.light_data = {
            light.kind == LightKind::point
                ? light.position.x
                : direction.x,
            light.kind == LightKind::point
                ? light.position.y
                : direction.y,
            light.kind == LightKind::point
                ? light.position.z
                : direction.z,
            light.kind == LightKind::hemispheric
                ? 3.0f
                : light.kind == LightKind::directional
                    ? 1.0f
                    : 0.0f,
        };
        result.light_diffuse = {
            light.diffuse_color.r * light.intensity,
            light.diffuse_color.g * light.intensity,
            light.diffuse_color.b * light.intensity,
            light.kind == LightKind::point ? light.range : 0.0f,
        };
        result.light_specular = {
            light.specular_color.r * light.intensity,
            light.specular_color.g * light.intensity,
            light.specular_color.b * light.intensity,
            0.0f,
        };
        result.light_direction = {
            light.kind == LightKind::hemispheric
                ? light.ground_color.r
                : direction.x,
            light.kind == LightKind::hemispheric
                ? light.ground_color.g
                : direction.y,
            light.kind == LightKind::hemispheric
                ? light.ground_color.b
                : direction.z,
            0.0f,
        };
    }
    if (item.material.value < engine.materials.size()) {
        const MaterialRecord& material =
            engine.materials[item.material.value];
        result.diffuse_alpha = {
            material.diffuse_color.r,
            material.diffuse_color.g,
            material.diffuse_color.b,
            material.base_color_factor.a,
        };
        result.specular_power = {
            material.specular_color.r,
            material.specular_color.g,
            material.specular_color.b,
            material.specular_power,
        };
        result.emissive_level = {
            material.emissive_factor.r,
            material.emissive_factor.g,
            material.emissive_factor.b,
            material.diffuse_level,
        };
        result.ambient_level = {
            material.ambient_color.r,
            material.ambient_color.g,
            material.ambient_color.b,
            material.ambient_level,
        };
        result.texture_options = {
            material.base_color_texture.bytes.empty() ? 0.0f : 1.0f,
            material.specular_texture.bytes.empty() ? 0.0f : 1.0f,
            material.opacity_texture.bytes.empty() ? 0.0f : 1.0f,
            material.ambient_texture.bytes.empty() ? 0.0f : 1.0f,
        };
        result.uv_options = {
            material.diffuse_u_scale,
            material.diffuse_v_scale,
            static_cast<float>(material.specular_coord_index),
            static_cast<float>(material.ambient_coord_index),
        };
        result.material_options = {
            material.double_sided ? 1.0f : 0.0f,
            material.alpha_cutoff,
            material.opacity_level,
            material.disable_lighting ? 1.0f : 0.0f,
        };
        result.reflection_options = {
            material.reflection_cube == invalid_handle ? 0.0f : 1.0f,
            material.reflection_level,
            (
                !material.emissive_texture.bytes.empty() ||
                material.has_emissive_render_texture
            ) ? 1.0f : 0.0f,
            material.has_emissive_render_texture ? 1.0f : 0.0f,
        };
    }
    return result;
}

BackgroundPlan build_background_plan(const EnvironmentState& environment) {
    const float half = environment.ground_size * 0.5f;
    const Vec3 center = environment.ground_position;
    BackgroundPlan result;
    result.vertices = {
        ModelVertex{Vec3{center.x - half, center.y, center.z - half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 0.0f}},
        ModelVertex{Vec3{center.x + half, center.y, center.z - half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 0.0f}},
        ModelVertex{Vec3{center.x + half, center.y, center.z + half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 1.0f}},
        ModelVertex{Vec3{center.x - half, center.y, center.z + half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 1.0f}},
    };
    result.indices = {0, 2, 1, 0, 3, 2};
    return result;
}

BackgroundUniforms build_background_uniforms(
    const EnvironmentState& environment,
    const CameraRecord& camera) {
    const Vec3 eye = arc_rotate_eye_position(camera);
    BackgroundUniforms result;
    result.primary_color_alpha = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
        0.9f,
    };
    result.background_center = {
        environment.ground_position.x,
        environment.ground_position.y,
        environment.ground_position.z,
        0.0f,
    };
    result.camera_exposure = {
        eye.x,
        eye.y,
        eye.z,
        environment.exposure,
    };
    result.image_parameters = {environment.contrast, 1.0f, 0.0f, 0.0f};
    return result;
}

SkyboxPlan build_skybox_plan(const EnvironmentState& environment) {
    const float half = environment.skybox_size * 0.5f;
    const Vec3 center = environment.ground_position;
    const auto vertex = [center](float x, float y, float z) {
        return ModelVertex{
            Vec3{center.x + x, center.y + y, center.z + z},
            Vec3{0.0f, 1.0f, 0.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{},
        };
    };
    SkyboxPlan result;
    result.vertices = {
        vertex(-half, -half, -half),
        vertex(half, -half, -half),
        vertex(-half, half, -half),
        vertex(half, half, -half),
        vertex(-half, -half, half),
        vertex(half, -half, half),
        vertex(-half, half, half),
        vertex(half, half, half),
    };
    result.indices = {
        6, 4, 5, 7, 6, 5,
        0, 2, 3, 1, 0, 3,
        5, 1, 3, 7, 5, 3,
        0, 4, 6, 2, 0, 6,
        3, 2, 6, 7, 3, 6,
        0, 1, 5, 4, 0, 5,
    };
    return result;
}

SkyboxUniforms build_skybox_uniforms(const EnvironmentState& environment) {
    SkyboxUniforms result;
    result.primary_color_exposure = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
        environment.exposure,
    };
    result.background_center = {
        environment.ground_position.x,
        environment.ground_position.y,
        environment.ground_position.z,
        0.0f,
    };
    result.image_parameters = {environment.contrast, 0.0f, 0.0f, 0.0f};
    return result;
}

} // namespace bbl::upstream
`,
        };
    }

    public lowerShaders(options: {
        ground: boolean;
        skybox: boolean;
        shaderVariants: ShaderMaterialVariantName[];
        standardMaterial: boolean;
        idDiagnostics: boolean;
        pbrDiagnostics: boolean;
        geometryOutputTasks: GeometryOutputTaskManifest[];
        frameGraph?: boolean;
    } = {
        ground: true,
        skybox: true,
        shaderVariants: ["alpha-card", "circular-cutout"],
        standardMaterial: false,
        idDiagnostics: true,
        pbrDiagnostics: true,
        geometryOutputTasks: [],
    }): LoweredShader[] {
        const pbr = this.context.store.getSource(pbrTemplateModule);
        const pbrHelper = this.context.store.getSource(pbrHelperCoreModule);
        const ibl = this.context.store.getSource(iblFragmentModule);
        const sceneUniforms = this.context.store.getSource(sceneUniformsModule);
        const backgroundGround = this.context.store.getSource(backgroundGroundModule);
        const backgroundDds = this.context.store.getSource(backgroundDdsModule);
        const pbrGeometryModule =
            "src/material/pbr/pbr-geometry-output-shader.ts";
        const pbrGeometry = this.context.store.getSource(pbrGeometryModule);
        const standardGeometryModule =
            "src/material/standard/standard-geometry-output-shader.ts";
        const standardTemplateModule =
            "src/material/standard/standard-template.ts";
        const standardGeometry = this.context.store.getSource(
            standardGeometryModule,
        );
        const standardTemplate = this.context.store.getSource(
            standardTemplateModule,
        );
        const requiredUpstreamFormulas: Array<
            readonly [string, string, string]
        > = [
            [pbr, "roughness*roughness+0.0005", "GGX roughness"],
            [pbr, "0.5/(gl+gv)", "Smith geometry"],
            [pbrHelper, "1.590579", "image-processing calibration"],
            [ibl, "log2(cubemapDim * alphaG) * scene.vImageInfos.z", "IBL mip selection"],
            [ibl, "getEnergyConservationFactor", "IBL energy conservation"],
            [sceneUniforms, "lodGenerationScale ?? 0.8", "environment LOD scale"],
            [backgroundGround, "tonemappingCalibration: f32 = 1.590579", "background image processing"],
            [backgroundGround, "ground renders last", "background ordering"],
            [backgroundDds, "GPUTextureFormat = \"rgba16float\"", "DDS cubemap format"],
            [backgroundDds, "pass.drawIndexed(36)", "DDS skybox draw"],
            [pbrGeometry, "directDiffuse + finalIrradiance", "geometry irradiance"],
            [pbrGeometry, "colorF0, 1.0 - roughness", "geometry reflectivity"],
            [pbrGeometry, "input.clipPos.z", "geometry screen depth"],
        ];
        if (options.standardMaterial) {
            requiredUpstreamFormulas.push(
                [
                    standardTemplate,
                    "diffuseBase * diffuseColor + emissiveContrib + mat.ac",
                    "standard diffuse lighting",
                ],
                [
                    standardGeometry,
                    "BJS Standard material can't split irradiance",
                    "standard zero irradiance output",
                ],
                [
                    standardGeometry,
                    "pow(mat.sc.rgb, vec3<f32>(2.2))",
                    "standard reflectivity output",
                ],
            );
        }
        for (const [source, formula, label] of requiredUpstreamFormulas) {
            if (!source.includes(formula)) {
                throw new Error(`Pinned Babylon Lite source is missing ${label}: ${formula}.`);
            }
        }

        const sources = [
            "pbr.vert.hlsl",
            "pbr.frag.hlsl",
            "pbr.vert.msl",
            "pbr.frag.msl",
        ];
        if (options.ground) {
            sources.push("background-ground.frag.hlsl", "background-ground.frag.msl");
        }
        if (options.skybox) {
            sources.push("background-skybox.frag.hlsl", "background-skybox.frag.msl");
        }
        if (options.shaderVariants.includes("alpha-card")) {
            sources.push(
                "alpha-card.vert.hlsl",
                "alpha-card.frag.hlsl",
                "alpha-card.vert.msl",
                "alpha-card.frag.msl",
            );
        }
        if (options.shaderVariants.includes("circular-cutout")) {
            sources.push(
                "circular-cutout.vert.hlsl",
                "circular-cutout.frag.hlsl",
                "circular-cutout.vert.msl",
                "circular-cutout.frag.msl",
            );
        }
        if (options.standardMaterial) {
            sources.push("standard.frag.hlsl", "standard.frag.msl");
        }
        if (options.idDiagnostics) {
            sources.push(
                "diagnostic-id.frag.hlsl",
                "diagnostic-id.frag.msl",
                "diagnostic-cluster.frag.hlsl",
                "diagnostic-cluster.frag.msl",
            );
        }
        if (
            options.frameGraph ||
            options.geometryOutputTasks.length > 0
        ) {
            sources.push(
                "blit.vert.hlsl",
                "blit.frag.hlsl",
                "blit.vert.msl",
                "blit.frag.msl",
                "depth-only.frag.hlsl",
                "depth-only.frag.msl",
            );
        }
        const result = sources.map((name) => ({
            output: `upstream/shaders/${name}`,
            data: readFileSync(resolve(templateRoot, name), "utf8"),
        }));
        for (const extension of options.pbrDiagnostics ? (["hlsl", "msl"] as const) : []) {
            for (const variant of ["A", "B"] as const) {
                result.push({
                    output:
                        `upstream/shaders/pbr-diagnostics-${variant.toLowerCase()}.frag.${extension}`,
                    data:
                        `#define BBLITE_DIAGNOSTICS_${variant} 1\n` +
                        readFileSync(resolve(templateRoot, `pbr.frag.${extension}`), "utf8"),
                });
            }
        }
        for (const task of options.geometryOutputTasks) {
            for (const extension of ["hlsl", "msl"] as const) {
                result.push({
                    output:
                        `upstream/shaders/pbr-geometry-${task.shaderIndex}.frag.${extension}`,
                    data:
                        geometryShaderPrefix(
                            task,
                            extension,
                            this.context.provenance(
                                pbrGeometryModule,
                                "attachmentExpr",
                            ),
                        ) +
                        readFileSync(
                            resolve(templateRoot, `pbr.frag.${extension}`),
                            "utf8",
                        ),
                });
            }
            if (options.standardMaterial) {
                for (const extension of ["hlsl", "msl"] as const) {
                    result.push({
                        output:
                            `upstream/shaders/standard-geometry-${task.shaderIndex}.frag.${extension}`,
                        data:
                            standardGeometryShaderPrefix(
                                task,
                                extension,
                                this.context.provenance(
                                    standardGeometryModule,
                                    "attachmentExpr",
                                ),
                            ) +
                            readFileSync(
                                resolve(
                                    templateRoot,
                                    `standard.frag.${extension}`,
                                ),
                                "utf8",
                            ),
                    });
                }
            }
        }
        return result;
    }

    public fidelityManifest(): RendererFidelityManifest {
        const rgbd = this.context.store.getSource(rgbdDecodeModule);
        const surface = this.context.store.getSource(surfaceModule);
        if (!rgbd.includes("select(g.y,d.y-1u-g.y,f)")) {
            throw new Error("Pinned Babylon Lite RGBD vertical flip semantics changed.");
        }
        if (!surface.includes("Defaults to `4`.")) {
            throw new Error("Pinned Babylon Lite MSAA default changed.");
        }
        return {
            sourceLanguage: "WGSL",
            emittedSources: ["HLSL", "MSL"],
            compiledArtifacts: ["DXIL", "SPIR-V"],
            bindingContract: {
                vertexUniformSpace: 1,
                sampledTextureSpace: 2,
                fragmentUniformSpace: 3,
            },
            textureContract: {
                baseColor: "sRGB",
                emissive: "sRGB",
                normal: "linear",
                metallicRoughness: "linear",
                environment: "linear-rgba16f",
                brdfLut: "linear-rgba32f",
            },
            invariants: [
                {
                    id: "surface-msaa",
                    upstreamModule: surfaceModule,
                    upstreamMarker: "Defaults to `4`.",
                    nativeBehavior: "SDL_GPU requests 4x MSAA and resolves into the single-sample presentation or capture target.",
                    validation: ["source marker assertion", "edge MAD attribution"],
                },
                {
                    id: "ggx-smith",
                    upstreamModule: pbrTemplateModule,
                    upstreamMarker: "roughness*roughness+0.0005; 0.5/(gl+gv)",
                    nativeBehavior: "GGX distribution and Smith correlated geometry use Babylon alphaG conventions.",
                    validation: ["source marker assertions", "GPU parity"],
                },
                {
                    id: "ibl-energy-conservation",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "getEnergyConservationFactor",
                    nativeBehavior: "BRDF LUT reflectance is multiplied by Babylon's energy-conservation factor.",
                    validation: ["source marker assertions", "GPU parity"],
                },
                {
                    id: "environment-lod",
                    upstreamModule: sceneUniformsModule,
                    upstreamMarker: "lodGenerationScale ?? 0.8",
                    nativeBehavior: "Cubemap mip selection uses log2(cubemapDim * alphaG) with scale 0.8.",
                    validation: ["source marker assertions", "generated uniform tests"],
                },
                {
                    id: "rgbd-cubemap-y-flip",
                    upstreamModule: rgbdDecodeModule,
                    upstreamMarker: "select(g.y,d.y-1u-g.y,f)",
                    nativeBehavior: "RGBD cubemap rows are vertically reversed during SDL_GPU upload.",
                    validation: ["source marker assertion", "BoomBox foreground parity"],
                },
                {
                    id: "image-processing",
                    upstreamModule: pbrHelperCoreModule,
                    upstreamMarker: "1.590579",
                    nativeBehavior: "Exposure, exponential tone mapping, gamma, and contrast follow Babylon constants and order.",
                    validation: ["source marker assertions", "GPU parity"],
                },
            ],
        };
    }
}
