import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { RendererFidelityManifest } from "../fidelity.js";
import type {
    GeometryOutputTaskManifest,
    ShaderMaterialVariantName,
} from "../compiler.js";
import { emitNativeWgslProgram } from "../shader-wgsl-emitter.js";
import { lowerWgslShaderProgram } from "../shader-ir.js";
import type { ShaderProgramReflection } from "../shader-ir.js";
import {
    composeStandaloneWgsl,
    getShaderMaterialProgram,
    shaderMaterialPrograms,
} from "../shader-material-programs.js";
import {
    gridFragmentWgsl,
    gridVertexWgsl,
} from "../shader-builtins-grid.js";
import {
    blitFragmentWgsl,
    blitVertexWgsl,
    depthOnlyFragmentWgsl,
    diagnosticClusterFragmentWgsl,
    diagnosticIdFragmentWgsl,
    imageProcessingFragmentWgsl,
} from "../shader-builtins-utility.js";
import {
    backgroundGroundFragmentWgsl,
    backgroundSkyboxFragmentWgsl,
} from "../shader-builtins-background.js";
import { materialVertexWgsl } from "../shader-builtins-material.js";
import { standardFragmentWgsl } from "../shader-builtins-standard.js";
import { pbrFragmentWgsl } from "../shader-builtins-pbr.js";
import { LoweredSource, LoweringContext } from "./context.js";

const renderTaskModule = "src/frame-graph/render-task.ts";
const pbrTemplateModule = "src/material/pbr/pbr-template.ts";
const pbrTemplateExtModule = "src/material/pbr/pbr-template-ext.ts";
const pbrHelperCoreModule = "src/material/node/blocks/pbr-mr-helper-core.ts";
const iblFragmentModule = "src/material/pbr/fragments/ibl-fragment.ts";
const iblSkyboxModule = "src/material/pbr/fragments/ibl-skybox-wgsl.ts";
const refractionModule =
    "src/material/pbr/fragments/refraction-rtt-fragment.ts";
const dielectricLoaderModule = "src/loader-gltf/gltf-ext-dielectric.ts";
const transmissionFrameGraphModule = "src/frame-graph/transmission.ts";
const sceneUniformsModule = "src/frame-graph/scene-uniforms-pack.ts";
const backgroundGroundModule = "src/material/pbr/background-ground.ts";
const backgroundDdsModule = "src/material/pbr/background-dds-skybox.ts";
const backgroundHdrModule = "src/material/pbr/background-hdr-skybox.ts";
const rgbdDecodeModule = "src/loader-env/rgbd-decode.ts";
const surfaceModule = "src/engine/surface.ts";
const shaderPipelineModule = "src/material/shader/shader-pipeline.ts";
const sceneUniformsSourceModule = "src/shader/scene-uniforms.ts";
const templateRoot = fileURLToPath(new URL("../../../src/lowering/templates/renderer/", import.meta.url));

interface LoweredShader {
    output: string;
    data: string;
}

export class RendererLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerRenderPlan(options: { transmission?: boolean } = {}): LoweredSource {
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
        const shaderBindingCases = shaderMaterialPrograms.map((source) => {
            const reflection = lowerWgslShaderProgram(source).reflection;
            const vertex = reflection.uniformBlocks.some(
                ({ stage }) => stage === "vertex",
            ) ? 1 : 0;
            const fragment = reflection.uniformBlocks.some(
                ({ stage }) => stage === "fragment",
            ) ? 1 : 0;
            return `        case ShaderMaterialVariant::${source.name.replaceAll("-", "_")}:
            return fragment_stage ? ${fragment}u : ${vertex}u;`;
        }).join("\n");
        const transmissionUniformFields = options.transmission
            ? `    std::array<float, 4> refraction_params{};
    std::array<float, 4> volume_params{};
    std::array<float, 4> transmission_options{};
    std::array<std::array<float, 4>, 4> view_projection{};
`
            : "";
        const transmissionMaterialUniforms = options.transmission
            ? `        const float ior = std::max(material.index_of_refraction, 1.0001f);
        const float thickness_scale =
            item.mesh.value < engine.meshes.size()
                ? engine.meshes[item.mesh.value].baked_world_scale
                : 1.0f;
        result.refraction_params = {
            material.transmission_factor,
            1.0f / (material.has_volume && material.thickness > 0.0f
                ? ior
                : 1.0f),
            material.has_volume
                ? material.thickness * thickness_scale
                : 0.0f,
            1.0f / ior,
        };
        const float attenuation_distance =
            std::max(material.attenuation_distance, 0.0001f);
        result.volume_params = {
            std::log(std::max(material.attenuation_color.r, 0.000001f)) /
                attenuation_distance,
            std::log(std::max(material.attenuation_color.g, 0.000001f)) /
                attenuation_distance,
            std::log(std::max(material.attenuation_color.b, 0.000001f)) /
                attenuation_distance,
            0.0f,
        };
        result.transmission_options = {
            material.skybox_mode ? 1.0f : 0.0f,
            material.has_volume ? 1.0f : 0.0f,
            material.transmission_texture.bytes.empty() ? 0.0f : 1.0f,
            material.thickness_texture.bytes.empty() ? 0.0f : 1.0f,
        };
`
            : "";
        const transmissionViewProjection = options.transmission
            ? `    const std::array<float, 16> view_projection =
        build_view_projection(
            camera,
            static_cast<float>(engine.options.width) /
                std::max(engine.options.height, 1));
    for (std::size_t column = 0; column < 4; ++column) {
        for (std::size_t row = 0; row < 4; ++row) {
            result.view_projection[column][row] =
                view_projection[column * 4 + row];
        }
    }
`
            : "";

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
    bool transmissive = false;
    bool skybox_mode = false;
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
    std::array<float, 4> image_processing_options{};
${transmissionUniformFields}\
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
std::uint32_t shader_uniform_buffer_count(
    ShaderMaterialVariant variant,
    bool fragment_stage);
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
SkyboxUniforms build_skybox_uniforms(
    const EnvironmentState& environment,
    bool linear_image_processing);

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
    item.transmissive = material.transmission_factor > 0.0f ||
        !material.transmission_texture.bytes.empty();
    item.skybox_mode = material.skybox_mode;
    if (item.transmissive) {
        item.bucket = RenderBucket::alpha_blend;
    }
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

std::uint32_t shader_uniform_buffer_count(
    ShaderMaterialVariant variant,
    bool fragment_stage) {
    switch (variant) {
${shaderBindingCases}
    }
    return 0u;
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
        scene.environment.lod_generation_scale,
        scene.environment.tone_mapping_enabled ? 1.0f : 0.0f,
    };
    result.image_processing_options[0] =
        scene.transmission_enabled ? 1.0f : 0.0f;
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
            material.specular_aa ? 1.0f : 0.0f,
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
        const float dielectric_ratio =
            (material.index_of_refraction - 1.0f) /
            (material.index_of_refraction + 1.0f);
        result.normal_options[2] =
            material.has_ior
                ? dielectric_ratio * dielectric_ratio
                : material.reflectance;
        result.normal_options[3] = material.normal_texture_scale;
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
${transmissionMaterialUniforms}\
    }
${transmissionViewProjection}\
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

SkyboxUniforms build_skybox_uniforms(
    const EnvironmentState& environment,
    bool linear_image_processing) {
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
        linear_image_processing ? 1.0f : 0.0f,
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
        transmission?: boolean;
        normalTextureScale?: boolean;
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
        transmission: true,
        normalTextureScale: true,
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
        const iblSkybox = this.context.store.getSource(iblSkyboxModule);
        const refraction = this.context.store.getSource(refractionModule);
        const dielectric = this.context.store.getSource(
            dielectricLoaderModule,
        );
        const transmissionFrameGraph = this.context.store.getSource(
            transmissionFrameGraphModule,
        );
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
        const shaderPipeline = this.context.store.getSource(shaderPipelineModule);
        const sceneUniformsSource = this.context.store.getSource(
            sceneUniformsSourceModule,
        );
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
            [ibl, "environmentHorizonOcclusion", "IBL horizon occlusion"],
            [ibl, "let seo = clamp", "IBL specular occlusion"],
            [ibl, "vec2<f32>(NdotV, roughness)", "BRDF LUT coordinates"],
            [ibl, "let R = rotateY(R_raw", "environment cubemap rotation"],
            [iblSkybox, "let R = input.worldPos - scene.vEyePosition.xyz", "PBR skybox view ray"],
            [refraction, "let rd=refract(-V,N,material.refractionParams.y)", "scene-color refraction ray"],
            [refraction, "let ab=exp(material.volumeParams.rgb*th)", "Beer-Lambert attenuation"],
            [refraction, "colorSpecularEnvReflectance.rgb", "transmission Fresnel complement"],
            [dielectric, "((ior - 1) / (ior + 1)) ** 2 / 0.04", "glTF IOR Fresnel"],
            [transmissionFrameGraph, "updateTransmissionTexture(state, engine)", "scene-color copy ordering"],
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
            if (options.shaderVariants.length > 0) {
                for (const marker of [
                    "function buildShaderPrelude",
                    "@group(1) @binding(0) var<uniform> shaderSystem",
                    "@group(1) @binding(1) var<uniform> shaderUniforms",
                    "@location(${i}) ${attr}: ${attributeWgslType(attr)}",
                ]) {
                    if (!shaderPipeline.includes(marker)) {
                        throw new Error(
                            `Pinned custom shader composition changed: ${marker}.`,
                        );
                    }
                }
                if (!sceneUniformsSource.includes(
                    'import sceneUniformsWgsl from "../../shaders/scene-uniforms.wgsl?raw"',
                )) {
                    throw new Error("Pinned scene uniform WGSL import changed.");
                }
            }
        }

        const sources: string[] = [];
        const result = sources.map((name) => ({
            output: `upstream/shaders/${name}`,
            data: readFileSync(resolve(templateRoot, name), "utf8"),
        }));
        result.push({
            output: "upstream/shaders/pbr.vert.native.wgsl",
            data: materialVertexWgsl(),
        });
        let convertedPbr = readFileSync(
            resolve(templateRoot, "pbr.frag.wgsl"),
            "utf8",
        );
        if (!options.normalTextureScale) {
            convertedPbr = convertedPbr.replace(
                /  let v_8_raw = \(\(textureSample\(normalTexture, normalSampler, v_4\)\.xyz \* 2\.0f\) - vec3<f32>\(1\.0f\)\);\r?\n  let v_8 = vec3<f32>\(\r?\n    v_8_raw\.xy \* FragmentUniforms\.normalOptions\.w,\r?\n    v_8_raw\.z,\r?\n  \);/,
                "  let v_8 = ((textureSample(normalTexture, normalSampler, v_4).xyz * 2.0f) - vec3<f32>(1.0f));",
            );
        }
        if (!options.transmission) {
            convertedPbr = convertedPbr.replace(
                /@group\(2u\) @binding\(12u\)[\s\S]*?@group\(2u\) @binding\(17u\) var thicknessSampler : sampler;\r?\n\r?\n/,
                "",
            );
            convertedPbr = convertedPbr.replace(
                /  refractionParams : vec4<f32>,\r?\n  volumeParams : vec4<f32>,\r?\n  transmissionOptions : vec4<f32>,\r?\n  viewProjection : mat4x4<f32>,\r?\n/,
                "",
            );
            const transmissionStart = convertedPbr.indexOf(
                "  var shadedColor = ",
            );
            const transmissionEnd = convertedPbr.indexOf(
                "  var v_105 : vec3<f32>;",
                transmissionStart,
            );
            if (transmissionStart < 0 || transmissionEnd < 0) {
                throw new Error("PBR transmission shader markers changed.");
            }
            convertedPbr =
                convertedPbr.slice(0, transmissionStart) +
                "  let linearColor = select(((((((v_89 * v_52) * v_34) + v_101) + v_102) + ((((v_70 * v_52) * v_71) * v_81) * v_69)) + v_40), v_31, vec3<bool>(v_103, v_103, v_103));\n" +
                "  let v_104 = linearColor * FragmentUniforms.environmentFactors.x;\n" +
                convertedPbr.slice(transmissionEnd);
        }
        const pbrProvenance = this.context.provenance(
            pbrTemplateModule,
            "createPbrTemplate",
            `${iblFragmentModule}#getEnergyConservationFactor`,
        );
        result.push({
            output: "upstream/shaders/pbr.frag.native.wgsl",
            data:
                `// ${pbrProvenance}\n` +
                pbrFragmentWgsl(convertedPbr, { kind: "color" }),
        });
        if (options.standardMaterial) {
            result.push({
                output: "upstream/shaders/standard.frag.native.wgsl",
                data: standardFragmentWgsl(
                    this.context.provenance(
                        standardTemplateModule,
                        "createStandardTemplate",
                    ),
                ),
            });
        }
        if (options.ground) {
            result.push({
                output:
                    "upstream/shaders/background-ground.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(
                    this.context.provenance(
                        backgroundGroundModule,
                        "buildBackgroundGroundRenderable",
                    ),
                ),
            });
        }
        if (options.skybox) {
            result.push({
                output:
                    "upstream/shaders/background-skybox.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(
                    this.context.provenance(
                        backgroundDdsModule,
                        "buildDdsSkyboxRenderable",
                        `${backgroundHdrModule}#buildHdrSkyboxRenderable`,
                    ),
                ),
            });
        }
        if (options.transmission) {
            result.push(
                {
                    output:
                        "upstream/shaders/image-processing.vert.native.wgsl",
                    data: blitVertexWgsl(),
                },
                {
                    output:
                        "upstream/shaders/image-processing.frag.native.wgsl",
                    data: imageProcessingFragmentWgsl(),
                },
            );
        }
        if (options.gridMaterial) {
            const provenance = this.context.provenance(
                gridModule,
                "createGridMaterial",
            );
            result.push(
                {
                    output: "upstream/shaders/grid.vert.native.wgsl",
                    data: gridVertexWgsl(provenance),
                },
                {
                    output: "upstream/shaders/grid.frag.native.wgsl",
                    data: gridFragmentWgsl(provenance),
                },
            );
        }
        if (options.idDiagnostics) {
            result.push(
                {
                    output:
                        "upstream/shaders/diagnostic-id.frag.native.wgsl",
                    data: diagnosticIdFragmentWgsl(),
                },
                {
                    output:
                        "upstream/shaders/diagnostic-cluster.frag.native.wgsl",
                    data: diagnosticClusterFragmentWgsl(),
                },
            );
        }
        if (
            options.frameGraph ||
            options.geometryOutputTasks.length > 0
        ) {
            result.push(
                {
                    output: "upstream/shaders/blit.vert.native.wgsl",
                    data: blitVertexWgsl(),
                },
                {
                    output: "upstream/shaders/blit.frag.native.wgsl",
                    data: blitFragmentWgsl(),
                },
                {
                    output:
                        "upstream/shaders/depth-only.frag.native.wgsl",
                    data: depthOnlyFragmentWgsl(),
                },
            );
        }
        const sceneUniformsWgsl = options.shaderVariants.length > 0
            ? this.compiledSceneUniformsWgsl()
            : "";
        for (const name of options.shaderVariants) {
            const source = getShaderMaterialProgram(name);
            const program = lowerWgslShaderProgram(source);
            result.push(
                {
                    output: `upstream/shaders/${name}.vert.wgsl`,
                    data:
                        `// ${this.context.provenance(shaderPipelineModule, "buildShaderPrelude")}\n` +
                        composeStandaloneWgsl(
                            source,
                            sceneUniformsWgsl,
                            "vertex",
                        ),
                },
                {
                    output: `upstream/shaders/${name}.frag.wgsl`,
                    data:
                        `// ${this.context.provenance(shaderPipelineModule, "buildShaderPrelude")}\n` +
                        composeStandaloneWgsl(
                            source,
                            sceneUniformsWgsl,
                            "fragment",
                        ),
                },
                {
                    output: `upstream/shaders/${name}.vert.native.wgsl`,
                    data: emitNativeWgslProgram(program, "vertex"),
                },
                {
                    output: `upstream/shaders/${name}.frag.native.wgsl`,
                    data: emitNativeWgslProgram(program, "fragment"),
                },
            );
        }
        if (options.pbrDiagnostics) {
            for (const variant of ["a", "b", "c"] as const) {
                result.push({
                    output:
                        `upstream/shaders/pbr-diagnostics-${variant}.frag.native.wgsl`,
                    data:
                        `// ${pbrProvenance}\n` +
                        pbrFragmentWgsl(convertedPbr, {
                            kind: "diagnostic",
                            group: variant,
                        }),
                });
            }
        }
        for (const task of options.geometryOutputTasks) {
            result.push({
                output:
                    `upstream/shaders/pbr-geometry-${task.shaderIndex}.frag.native.wgsl`,
                data:
                    `// ${this.context.provenance(
                        pbrGeometryModule,
                        "attachmentExpr",
                    )}\n` +
                    pbrFragmentWgsl(convertedPbr, {
                        kind: "geometry",
                        task,
                    }),
            });
            if (options.standardMaterial) {
                result.push({
                    output:
                        `upstream/shaders/standard-geometry-${task.shaderIndex}.frag.native.wgsl`,
                    data: standardFragmentWgsl(
                        this.context.provenance(
                            standardGeometryModule,
                            "attachmentExpr",
                        ),
                        task,
                    ),
                });
            }
        }
        return result;
    }

    private compiledSceneUniformsWgsl(): string {
        const compiled = readFileSync(
            resolve(
                this.context.store.packageRoot,
                "lib/shader/scene-uniforms.js",
            ),
            "utf8",
        );
        const match = compiled.match(
            /const sceneUniformsWgsl = ("(?:[^"\\]|\\.)*");/,
        );
        if (!match?.[1]) {
            throw new Error("Pinned compiled scene uniform WGSL was not found.");
        }
        const parsed: unknown = JSON.parse(match[1]);
        if (typeof parsed !== "string") {
            throw new Error("Pinned compiled scene uniform WGSL is not text.");
        }
        return parsed;
    }

    public shaderMaterialReflections(
        variants: ShaderMaterialVariantName[],
    ): ShaderProgramReflection[] {
        return variants.map(
            (name) =>
                lowerWgslShaderProgram(getShaderMaterialProgram(name))
                    .reflection,
        );
    }

    public fidelityManifest(): RendererFidelityManifest {
        const rgbd = this.context.store.getSource(rgbdDecodeModule);
        const surface = this.context.store.getSource(surfaceModule);
        const iblSkybox = this.context.store.getSource(iblSkyboxModule);
        const refraction = this.context.store.getSource(refractionModule);
        const dielectric = this.context.store.getSource(
            dielectricLoaderModule,
        );
        const transmissionFrameGraph = this.context.store.getSource(
            transmissionFrameGraphModule,
        );
        if (!rgbd.includes("select(g.y,d.y-1u-g.y,f)")) {
            throw new Error("Pinned Babylon Lite RGBD vertical flip semantics changed.");
        }
        if (!surface.includes("Defaults to `4`.")) {
            throw new Error("Pinned Babylon Lite MSAA default changed.");
        }
        for (const [source, marker, label] of [
            [
                iblSkybox,
                "let R = input.worldPos - scene.vEyePosition.xyz",
                "PBR skybox mode",
            ],
            [
                refraction,
                "let ab=exp(material.volumeParams.rgb*th)",
                "volume attenuation",
            ],
            [
                dielectric,
                "((ior - 1) / (ior + 1)) ** 2 / 0.04",
                "IOR Fresnel",
            ],
            [
                transmissionFrameGraph,
                "updateTransmissionTexture(state, engine)",
                "scene-color copy",
            ],
        ] as const) {
            if (!source.includes(marker)) {
                throw new Error(`Pinned Babylon Lite ${label} changed.`);
            }
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
                    id: "pbr-skybox-mode",
                    upstreamModule: iblSkyboxModule,
                    upstreamMarker:
                        "let R = input.worldPos - scene.vEyePosition.xyz",
                    nativeBehavior:
                        "Skybox-mode PBR materials sample the environment along the camera-to-fragment ray and omit diffuse irradiance.",
                    validation: ["source marker assertion", "skybox gate parity"],
                },
                {
                    id: "scene-color-transmission",
                    upstreamModule: transmissionFrameGraphModule,
                    upstreamMarker:
                        "updateTransmissionTexture(state, engine)",
                    nativeBehavior:
                        "PAL renders linear RGBA16F scene color, copies completed opaque color and its pinned mip chain before the first transmissive draw, then applies image processing once to the final visible output.",
                    validation: [
                        "source marker assertion",
                        "scene-color gate parity",
                    ],
                },
                {
                    id: "ior-fresnel",
                    upstreamModule: dielectricLoaderModule,
                    upstreamMarker:
                        "((ior - 1) / (ior + 1)) ** 2 / 0.04",
                    nativeBehavior:
                        "KHR_materials_ior maps to dielectric F0=((ior-1)/(ior+1))^2 and the transmitted lobe uses the Fresnel complement.",
                    validation: ["source marker assertion", "IOR gate parity"],
                },
                {
                    id: "volume-beer-lambert",
                    upstreamModule: refractionModule,
                    upstreamMarker:
                        "let ab=exp(material.volumeParams.rgb*th)",
                    nativeBehavior:
                        "KHR_materials_volume attenuation uses exp(log(attenuationColor)/attenuationDistance * thickness).",
                    validation: [
                        "source marker assertion",
                        "volume gate parity",
                    ],
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
                    id: "ibl-horizon-occlusion",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "environmentHorizonOcclusion",
                    nativeBehavior: "Normal-mapped IBL squares Babylon's saturated reflection-to-geometric-normal horizon term.",
                    validation: ["source marker assertions", "BoomBox diagnostics"],
                },
                {
                    id: "ibl-specular-occlusion",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "let seo = clamp",
                    nativeBehavior: "Specular environment reflectance uses Babylon's NdotV and ambient-occlusion polynomial.",
                    validation: ["source marker assertions", "BoomBox diagnostics"],
                },
                {
                    id: "environment-lod",
                    upstreamModule: sceneUniformsModule,
                    upstreamMarker: "lodGenerationScale ?? 0.8",
                    nativeBehavior: "Cubemap mip selection uses log2(cubemapDim * alphaG) with the environment's pinned lodGenerationScale.",
                    validation: ["source marker assertions", "generated uniform tests"],
                },
                {
                    id: "brdf-lut-coordinates",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "vec2<f32>(NdotV, roughness)",
                    nativeBehavior: "The BRDF LUT is sampled with NdotV on X and perceptual roughness on Y.",
                    validation: ["source marker assertions", "BoomBox reflectivity diagnostics"],
                },
                {
                    id: "environment-cubemap-orientation",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "let R = rotateY(R_raw",
                    nativeBehavior: "Reflection and irradiance directions use Babylon's Y-axis environment rotation before cubemap sampling.",
                    validation: ["source marker assertions", "scene 8 and BoomBox parity"],
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
