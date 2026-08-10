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
const pbrTemplateExtModule = "src/material/pbr/pbr-template-ext.ts";
const pbrHelperCoreModule = "src/material/node/blocks/pbr-mr-helper-core.ts";
const iblFragmentModule = "src/material/pbr/fragments/ibl-fragment.ts";
const sceneUniformsModule = "src/frame-graph/scene-uniforms-pack.ts";
const backgroundGroundModule = "src/material/pbr/background-ground.ts";
const backgroundDdsModule = "src/material/pbr/background-dds-skybox.ts";
const backgroundHdrModule = "src/material/pbr/background-hdr-skybox.ts";
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
        for (const marker of [
            "b._sortDistance = wc ?",
            "b._sortDistance! - a._sortDistance!",
            "a.renderable.order - b.renderable.order",
        ]) {
            if (!source.includes(marker)) {
                throw new Error(
                    `${renderTaskModule} transparent sorting changed: ${marker}.`,
                );
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

enum class RenderMaterialKind {
    pbr,
    standard,
    grid,
    shader,
};

enum class RenderBucket {
    opaque,
    alpha_mask,
    alpha_blend,
};

enum class RenderCullMode {
    back,
    none,
};

enum class RenderPipelineKind {
    pbr_opaque_back,
    pbr_opaque_none,
    pbr_transparent_back,
    pbr_transparent_none,
    standard_opaque_back,
    standard_opaque_none,
    standard_transparent_back,
    standard_transparent_none,
    grid_opaque_back,
    grid_opaque_none,
    grid_transparent_back,
    grid_transparent_none,
    shader_alpha_card,
    shader_alpha_card_a2c,
    shader_circular_cutout,
};

enum class RenderStage {
    skybox,
    opaque,
    transparent,
    ground,
};

struct RenderItem {
    MeshHandle mesh{};
    std::uint32_t geometry = invalid_handle;
    MaterialHandle material{};
    RenderMaterialKind material_kind = RenderMaterialKind::pbr;
    RenderBucket bucket = RenderBucket::opaque;
    RenderCullMode cull_mode = RenderCullMode::back;
    ShaderMaterialVariant shader_variant = ShaderMaterialVariant::alpha_card;
    bool alpha_to_coverage = false;
    std::uint32_t order = 0;
};

struct RenderDrawCommand {
    std::uint32_t item_index = invalid_handle;
    RenderItem item{};
    RenderPipelineKind pipeline =
        RenderPipelineKind::pbr_opaque_back;
    float sort_distance = 0.0f;
};

struct RenderDrawList {
    std::vector<RenderDrawCommand> commands;
};

struct RenderDrawLists {
    RenderDrawList opaque;
    RenderDrawList transparent;
};

struct RenderPlan {
    std::vector<RenderItem> items;
    RenderDrawLists draw_lists;
    std::array<RenderStage, 4> stages{
        RenderStage::skybox,
        RenderStage::opaque,
        RenderStage::transparent,
        RenderStage::ground,
    };
};

struct RenderFeatures {
    bool standard_material = false;
    bool grid_material = false;
    bool no_color_material = false;
    bool shader_alpha_card = false;
    bool shader_circular_cutout = false;
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

struct GridUniforms {
    std::array<float, 4> grid_control{};
    std::array<float, 4> main_color{};
    std::array<float, 4> line_color{};
    std::array<float, 4> grid_offset_visibility{};
    std::array<float, 4> options{};
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

RenderPlan build_render_plan(const Scene& scene, const Engine& engine);
RenderFeatures build_render_features(
    const Scene& scene,
    const Engine& engine);
RenderDrawLists build_render_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine);
RenderDrawLists build_render_task_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine,
    const FrameTaskRecord& task);
void sort_transparent_draws(
    RenderDrawList& transparent,
    const Engine& engine,
    const CameraRecord& camera);
RenderItem bind_render_item(
    RenderItem item,
    const Engine& engine,
    MaterialHandle material);
std::uint32_t preferred_sample_count();
std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    float aspect,
    bool reverse_depth = false);
std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    float aspect);
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
GridUniforms build_grid_uniforms(
    const Engine& engine,
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

#include <algorithm>
#include <cmath>
#include <iterator>

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

Vec3 rotate_euler(Vec3 value, const Vec3& rotation) {
    const float sin_x = std::sin(rotation.x);
    const float cos_x = std::cos(rotation.x);
    value = Vec3{
        value.x,
        value.y * cos_x - value.z * sin_x,
        value.y * sin_x + value.z * cos_x,
    };
    const float sin_y = std::sin(rotation.y);
    const float cos_y = std::cos(rotation.y);
    value = Vec3{
        value.x * cos_y + value.z * sin_y,
        value.y,
        -value.x * sin_y + value.z * cos_y,
    };
    const float sin_z = std::sin(rotation.z);
    const float cos_z = std::cos(rotation.z);
    return Vec3{
        value.x * cos_z - value.y * sin_z,
        value.x * sin_z + value.y * cos_z,
        value.z,
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

RenderItem bind_render_item(
    RenderItem item,
    const Engine& engine,
    MaterialHandle material_handle) {
    item.material = material_handle;
    if (material_handle.value >= engine.materials.size()) {
        return item;
    }
    const MaterialRecord& material = engine.materials[material_handle.value];
    item.material_kind = material.grid_material
        ? RenderMaterialKind::grid
        : material.shader_material
            ? RenderMaterialKind::shader
            : material.standard_material
            ? RenderMaterialKind::standard
            : RenderMaterialKind::pbr;
    item.bucket =
        material.alpha_mode == MaterialAlphaMode::blend
            ? RenderBucket::alpha_blend
            : material.alpha_mode == MaterialAlphaMode::mask
                ? RenderBucket::alpha_mask
                : RenderBucket::opaque;
    item.cull_mode = material.double_sided
        ? RenderCullMode::none
        : RenderCullMode::back;
    item.shader_variant = material.shader_variant;
    item.alpha_to_coverage = material.alpha_to_coverage;
    return item;
}

namespace {

RenderPipelineKind render_pipeline_kind(const RenderItem& item) {
    const bool transparent =
        item.bucket == RenderBucket::alpha_blend;
    const bool double_sided =
        item.cull_mode == RenderCullMode::none;
    switch (item.material_kind) {
        case RenderMaterialKind::pbr:
            if (transparent) {
                return double_sided
                    ? RenderPipelineKind::pbr_transparent_none
                    : RenderPipelineKind::pbr_transparent_back;
            }
            return double_sided
                ? RenderPipelineKind::pbr_opaque_none
                : RenderPipelineKind::pbr_opaque_back;
        case RenderMaterialKind::standard:
            if (transparent) {
                return double_sided
                    ? RenderPipelineKind::standard_transparent_none
                    : RenderPipelineKind::standard_transparent_back;
            }
            return double_sided
                ? RenderPipelineKind::standard_opaque_none
                : RenderPipelineKind::standard_opaque_back;
        case RenderMaterialKind::grid:
            if (transparent) {
                return double_sided
                    ? RenderPipelineKind::grid_transparent_none
                    : RenderPipelineKind::grid_transparent_back;
            }
            return double_sided
                ? RenderPipelineKind::grid_opaque_none
                : RenderPipelineKind::grid_opaque_back;
        case RenderMaterialKind::shader:
            switch (item.shader_variant) {
                case ShaderMaterialVariant::alpha_card:
                    return item.alpha_to_coverage
                        ? RenderPipelineKind::shader_alpha_card_a2c
                        : RenderPipelineKind::shader_alpha_card;
                case ShaderMaterialVariant::circular_cutout:
                    return RenderPipelineKind::shader_circular_cutout;
            }
    }
    return RenderPipelineKind::pbr_opaque_back;
}

void append_draw(
    RenderDrawLists& result,
    std::uint32_t item_index,
    const RenderItem& item) {
    RenderDrawCommand command;
    command.item_index = item_index;
    command.item = item;
    command.pipeline = render_pipeline_kind(item);
    RenderDrawList& list =
        item.bucket == RenderBucket::alpha_blend
            ? result.transparent
            : result.opaque;
    list.commands.push_back(command);
}

std::uint32_t pipeline_order(RenderPipelineKind kind) {
    switch (kind) {
        case RenderPipelineKind::pbr_opaque_back:
        case RenderPipelineKind::pbr_transparent_back:
            return 0;
        case RenderPipelineKind::pbr_opaque_none:
        case RenderPipelineKind::pbr_transparent_none:
            return 1;
        case RenderPipelineKind::standard_opaque_back:
        case RenderPipelineKind::standard_transparent_back:
            return 2;
        case RenderPipelineKind::standard_opaque_none:
        case RenderPipelineKind::standard_transparent_none:
            return 3;
        case RenderPipelineKind::grid_opaque_back:
        case RenderPipelineKind::grid_transparent_back:
            return 4;
        case RenderPipelineKind::grid_opaque_none:
        case RenderPipelineKind::grid_transparent_none:
            return 5;
        case RenderPipelineKind::shader_alpha_card:
        case RenderPipelineKind::shader_alpha_card_a2c:
        case RenderPipelineKind::shader_circular_cutout:
            return 6;
    }
    return 7;
}

void order_draw_lists(RenderDrawLists& lists) {
    const auto compare = [](
                             const RenderDrawCommand& left,
                             const RenderDrawCommand& right) {
        return pipeline_order(left.pipeline) <
            pipeline_order(right.pipeline);
    };
    std::stable_sort(
        lists.opaque.commands.begin(),
        lists.opaque.commands.end(),
        compare);
}

} // namespace

void include_material_features(
    RenderFeatures& features,
    const Engine& engine,
    MaterialHandle handle) {
    if (handle.value >= engine.materials.size()) return;
    const MaterialRecord& material = engine.materials[handle.value];
    features.standard_material |= material.standard_material;
    features.grid_material |= material.grid_material;
    features.no_color_material |= material.no_color;
    features.shader_alpha_card |=
        material.shader_material &&
        material.shader_variant == ShaderMaterialVariant::alpha_card;
    features.shader_circular_cutout |=
        material.shader_material &&
        material.shader_variant == ShaderMaterialVariant::circular_cutout;
}

RenderFeatures build_render_features(
    const Scene& scene,
    const Engine& engine) {
    RenderFeatures result;
    for (const MeshHandle handle : scene.meshes) {
        if (handle.value < engine.meshes.size()) {
            include_material_features(
                result,
                engine,
                engine.meshes[handle.value].material);
        }
    }
    for (const FrameTaskRecord& task : engine.frame_tasks) {
        for (const RenderTaskMesh& entry : task.render_meshes) {
            include_material_features(result, engine, entry.material);
        }
    }
    return result;
}

RenderDrawLists build_render_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine) {
    RenderDrawLists result;
    result.opaque.commands.reserve(items.size());
    result.transparent.commands.reserve(items.size());
    for (std::size_t index = 0; index < items.size(); ++index) {
        append_draw(
            result,
            static_cast<std::uint32_t>(index),
            bind_render_item(
                items[index],
                engine,
                items[index].material));
    }
    order_draw_lists(result);
    return result;
}

RenderDrawLists build_render_task_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine,
    const FrameTaskRecord& task) {
    if (task.kind != FrameTaskKind::render) {
        return build_render_draw_lists(items, engine);
    }
    if (task.render_meshes.empty()) {
        return task.render.auto_mirror
            ? build_render_draw_lists(items, engine)
            : RenderDrawLists{};
    }
    RenderDrawLists result;
    result.opaque.commands.reserve(task.render_meshes.size());
    result.transparent.commands.reserve(task.render_meshes.size());
    for (const RenderTaskMesh& entry : task.render_meshes) {
        const auto found = std::find_if(
            items.begin(),
            items.end(),
            [&](const RenderItem& item) {
                return item.mesh.value == entry.mesh.value;
            });
        if (found == items.end()) {
            continue;
        }
        const std::uint32_t item_index =
            static_cast<std::uint32_t>(
                std::distance(items.begin(), found));
        append_draw(
            result,
            item_index,
            bind_render_item(*found, engine, entry.material));
    }
    order_draw_lists(result);
    return result;
}

void sort_transparent_draws(
    RenderDrawList& transparent,
    const Engine& engine,
    const CameraRecord& camera) {
    const Vec3 eye = arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    for (RenderDrawCommand& command : transparent.commands) {
        if (
            command.item.mesh.value >= engine.meshes.size() ||
            command.item.geometry >= engine.geometries.size()) {
            command.sort_distance = 0.0f;
            continue;
        }
        const MeshRecord& mesh = engine.meshes[command.item.mesh.value];
        const ModelGeometry& geometry =
            engine.geometries[command.item.geometry];
        Vec3 center{
            (geometry.bounds_min.x + geometry.bounds_max.x) * 0.5f *
                mesh.scaling.x,
            (geometry.bounds_min.y + geometry.bounds_max.y) * 0.5f *
                mesh.scaling.y,
            (geometry.bounds_min.z + geometry.bounds_max.z) * 0.5f *
                mesh.scaling.z,
        };
        center = rotate_euler(center, mesh.rotation);
        center.x += mesh.position.x;
        center.y += mesh.position.y;
        center.z += mesh.position.z;
        const Vec3 delta{
            center.x - eye.x,
            center.y - eye.y,
            center.z - eye.z,
        };
        command.sort_distance = dot(delta, forward);
    }
    std::stable_sort(
        transparent.commands.begin(),
        transparent.commands.end(),
        [](const RenderDrawCommand& left, const RenderDrawCommand& right) {
            return left.sort_distance > right.sort_distance ||
                (left.sort_distance == right.sort_distance &&
                 left.item.order < right.item.order);
        });
}

RenderPlan build_render_plan(const Scene& scene, const Engine& engine) {
    RenderPlan result;
    result.items.reserve(scene.meshes.size());
    for (const MeshHandle handle : scene.meshes) {
        if (handle.value >= engine.meshes.size()) {
            continue;
        }
        const MeshRecord& mesh = engine.meshes[handle.value];
        if (mesh.geometry >= engine.geometries.size()) {
            continue;
        }
        RenderItem item;
        item.mesh = handle;
        item.geometry = mesh.geometry;
        item.order = static_cast<std::uint32_t>(result.items.size());
        result.items.push_back(
            bind_render_item(item, engine, mesh.material));
    }
    result.draw_lists =
        build_render_draw_lists(result.items, engine);
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

std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    float aspect) {
    const Vec3 eye = arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    const Vec3 right =
        normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, forward));
    const Vec3 up = cross(forward, right);
    std::array<float, 16> view{};
    view[0] = right.x;
    view[4] = right.y;
    view[8] = right.z;
    view[1] = up.x;
    view[5] = up.y;
    view[9] = up.z;
    view[2] = forward.x;
    view[6] = forward.y;
    view[10] = forward.z;
    view[15] = 1.0f;

    const float focal = 1.0f / std::tan(camera.fov * 0.5f);
    std::array<float, 16> projection{};
    projection[0] = focal / aspect;
    projection[5] = focal;
    projection[10] =
        camera.far_plane /
        (camera.far_plane - camera.near_plane);
    projection[11] = 1.0f;
    projection[14] =
        (-camera.near_plane * camera.far_plane) /
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
        result.light_direction =
            light.kind == LightKind::point
                ? std::array<float, 4>{
                      light.position.x,
                      light.position.y,
                      light.position.z,
                      1.0f,
                  }
                : std::array<float, 4>{
                      direction.x,
                      direction.y,
                      direction.z,
                      0.0f,
                  };
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
            light.kind == LightKind::point ? light.range : 0.0f,
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
        scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
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
        result.normal_options[2] = material.reflectance;
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

GridUniforms build_grid_uniforms(
    const Engine& engine,
    const RenderItem& item) {
    GridUniforms result;
    if (item.material.value >= engine.materials.size()) {
        return result;
    }
    const MaterialRecord& material =
        engine.materials[item.material.value];
    result.grid_control = {
        material.grid_control.x,
        material.grid_control.y,
        material.grid_control.z,
        material.grid_control.w,
    };
    result.main_color = {
        material.grid_main_color.r,
        material.grid_main_color.g,
        material.grid_main_color.b,
        0.0f,
    };
    result.line_color = {
        material.grid_line_color.r,
        material.grid_line_color.g,
        material.grid_line_color.b,
        0.0f,
    };
    result.grid_offset_visibility = {
        material.grid_offset.x,
        material.grid_offset.y,
        material.grid_offset.z,
        material.grid_visibility,
    };
    result.options = {
        material.alpha_mode == MaterialAlphaMode::blend
            ? 1.0f
            : 0.0f,
        material.grid_antialias ? 1.0f : 0.0f,
        material.grid_use_max_line ? 1.0f : 0.0f,
        material.grid_pre_multiply_alpha ? 1.0f : 0.0f,
    };
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
    const auto vertex = [](float x, float y, float z) {
        return ModelVertex{
            Vec3{x, y, z},
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
        0.0f,
        0.0f,
        0.0f,
        0.0f,
    };
    result.image_parameters = {
        environment.contrast,
        environment.skybox_uses_environment ? 1.0f : 0.0f,
        environment.tone_mapping_enabled ? 1.0f : 0.0f,
        0.0f,
    };
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
        gridMaterial?: boolean;
        idDiagnostics: boolean;
        pbrDiagnostics: boolean;
        geometryOutputTasks: GeometryOutputTaskManifest[];
        frameGraph?: boolean;
    } = {
        ground: true,
        skybox: true,
        shaderVariants: ["alpha-card", "circular-cutout"],
        standardMaterial: false,
        gridMaterial: false,
        idDiagnostics: true,
        pbrDiagnostics: true,
        geometryOutputTasks: [],
    }): LoweredShader[] {
        const pbr = this.context.store.getSource(pbrTemplateModule);
        const pbrExt = this.context.store.getSource(pbrTemplateExtModule);
        const pbrHelper = this.context.store.getSource(pbrHelperCoreModule);
        const ibl = this.context.store.getSource(iblFragmentModule);
        const sceneUniforms = this.context.store.getSource(sceneUniformsModule);
        const backgroundGround = this.context.store.getSource(backgroundGroundModule);
        const backgroundDds = this.context.store.getSource(backgroundDdsModule);
        const backgroundHdr = this.context.store.getSource(backgroundHdrModule);
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
        const gridModule = "src/material/grid/grid-material.ts";
        const gridMaterial = this.context.store.getSource(gridModule);
        const requiredUpstreamFormulas: Array<
            readonly [string, string, string]
        > = [
            [pbr, "roughness*roughness+0.0005", "GGX roughness"],
            [pbr, "0.5/(gl+gv)", "Smith geometry"],
            [pbr, "luminanceOverAlpha+=dot", "transparent alpha luminance"],
            [pbr, "finalAlpha=saturate", "transparent alpha fold"],
            [pbrExt, "baseColor *= input.vColor.rgb", "vertex color base color"],
            [pbrExt, "alpha *= input.vColor.a", "vertex color alpha"],
            [pbrHelper, "1.590579", "image-processing calibration"],
            [ibl, "log2(cubemapDim * alphaG) * scene.vImageInfos.z", "IBL mip selection"],
            [ibl, "getEnergyConservationFactor", "IBL energy conservation"],
            [ibl, "finalRadianceScaled", "transparent IBL alpha contribution"],
            [sceneUniforms, "lodGenerationScale ?? 0.8", "environment LOD scale"],
            [backgroundGround, "tonemappingCalibration: f32 = 1.590579", "background image processing"],
            [backgroundGround, "ground renders last", "background ordering"],
            [backgroundDds, "GPUTextureFormat = \"rgba16float\"", "DDS cubemap format"],
            [backgroundDds, "pass.drawIndexed(36)", "DDS skybox draw"],
            [backgroundDds, "order: 0", "DDS skybox ordering"],
            [backgroundHdr, "order: 0", "HDR skybox ordering"],
            [backgroundHdr, "buildHdrSkyboxRenderable", "HDR skybox renderable"],
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
        if (options.gridMaterial) {
            requiredUpstreamFormulas.push(
                [
                    gridMaterial,
                    "fr=clamp(fr,-1.0,1.0);return 0.5+0.5*cos(fr*PI);",
                    "GridMaterial cosine antialiasing",
                ],
                [
                    gridMaterial,
                    "if(abs(fr)<SQRT2/4.0){return 1.0;}",
                    "GridMaterial hard line cutoff",
                ],
                [
                    gridMaterial,
                    "let grid=clamp(max(max(x,y),z),0.0,1.0);",
                    "GridMaterial max-line composition",
                ],
                [
                    gridMaterial,
                    "opacity=clamp(grid,0.08,shaderUniforms.gridControl.w*grid);",
                    "GridMaterial transparent opacity",
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
        if (options.gridMaterial) {
            sources.push(
                "grid.vert.hlsl",
                "grid.frag.hlsl",
                "grid.vert.msl",
                "grid.frag.msl",
            );
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
            data:
                (name.startsWith("grid.")
                    ? `// ${this.context.provenance(
                          gridModule,
                          "createGridMaterial",
                      )}\n`
                    : "") +
                readFileSync(resolve(templateRoot, name), "utf8"),
        }));
        for (const extension of options.pbrDiagnostics ? (["hlsl", "msl"] as const) : []) {
            for (const variant of ["A", "B", "C"] as const) {
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
                {
                    id: "hdr-cubemap-skybox",
                    upstreamModule: backgroundHdrModule,
                    upstreamMarker: "buildHdrSkyboxRenderable",
                    nativeBehavior: "Compiled HDR RGBA16F cubemap mip zero is reused for the generated cubemap skybox with exposure, gamma, and contrast.",
                    validation: ["source marker assertions", "scene 8 GPU parity"],
                },
            ],
        };
    }
}
