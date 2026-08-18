import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { RendererFidelityManifest } from "../fidelity.js";
import type {
    CompiledShaderProgram,
    GeometryOutputTaskManifest,
} from "../compiler.js";
import { emitNativeWgslProgram } from "../shader-wgsl-emitter.js";
import { lowerWgslShaderProgram } from "../shader-ir.js";
import type { ShaderProgramReflection } from "../shader-ir.js";
import {
    composeStandaloneWgsl,
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
    fogFactorWgsl,
    imageProcessingFragmentWgsl,
    imageProcessingMultisampledFragmentWgsl,
} from "../shader-builtins-utility.js";
import {
    backgroundGroundFragmentWgsl,
    backgroundSkyboxFragmentWgsl,
    readPinnedBackgroundGroundSource,
    readPinnedBackgroundSkyboxSource,
    readPinnedDitherWgsl,
    solidSkyboxFragmentWgsl,
    solidSkyboxVertexWgsl,
} from "../shader-builtins-background.js";
import type { PinnedSolidSkyboxSource } from "../shader-builtins-background.js";
import { materialVertexWgsl } from "../shader-builtins-standard.js";
import { LoweredSource, LoweringContext } from "./context.js";

/**
 * The texture slots a composed PBR fragment can sample, each with the material
 * record field holding its glTF texture transform. Babylon Lite keeps the
 * transform on the texture wrapper rather than on the material
 * (`gltf-ext-uv-transform.ts`), so slots on one material disagree freely and
 * each sample computes its own UV. `extension` names the option that composes
 * the fragment owning the slot, so a scene emits exactly the pairs its shader
 * reads — which is how upstream's per-fragment UBO slices behave.
 */
const pbrUvTransformSlots: ReadonlyArray<{
    wgsl: string;
    cpp: string;
    extension?: "clearcoat" | "sheen" | "iridescence" | "transmission";
}> = [
    { wgsl: "baseColor", cpp: "base_color" },
    { wgsl: "orm", cpp: "orm" },
    { wgsl: "normal", cpp: "normal" },
    { wgsl: "emissive", cpp: "emissive" },
    { wgsl: "clearcoat", cpp: "clearcoat", extension: "clearcoat" },
    {
        wgsl: "clearcoatRoughness",
        cpp: "clearcoat_roughness",
        extension: "clearcoat",
    },
    {
        wgsl: "clearcoatNormal",
        cpp: "clearcoat_normal",
        extension: "clearcoat",
    },
    { wgsl: "sheen", cpp: "sheen", extension: "sheen" },
    { wgsl: "sheenRoughness", cpp: "sheen_roughness", extension: "sheen" },
    { wgsl: "iridescence", cpp: "iridescence", extension: "iridescence" },
    {
        wgsl: "iridescenceThickness",
        cpp: "iridescence_thickness",
        extension: "iridescence",
    },
    {
        wgsl: "refractionMap",
        cpp: "transmission",
        extension: "transmission",
    },
    { wgsl: "thickness", cpp: "thickness", extension: "transmission" },
];

function reachedUvTransformSlots(options: {
    clearcoat?: boolean;
    sheen?: boolean;
    sheenAlbedoScaling?: boolean;
    iridescence?: boolean;
    transmission?: boolean;
}): ReadonlyArray<{ wgsl: string; cpp: string }> {
    return pbrUvTransformSlots.filter(
        (slot) =>
            (slot.extension === undefined ||
                options[slot.extension] === true) &&
            // The legacy sheen arm samples no separate roughness map, so
            // that slot's transform has nothing to transform.
            !(
                slot.wgsl === "sheenRoughness" &&
                options.sheenAlbedoScaling !== true
            ),
    );
}

const renderTaskModule = "src/frame-graph/render-task.ts";
const pbrTemplateModule = "src/material/pbr/pbr-template.ts";
const pbrTemplateExtModule = "src/material/pbr/pbr-template-ext.ts";
const pbrHelperCoreModule = "src/material/node/blocks/pbr-mr-helper-core.ts";
const iblFragmentModule = "src/material/pbr/fragments/ibl-fragment.ts";
const iblSkyboxModule = "src/material/pbr/fragments/ibl-skybox-wgsl.ts";
const refractionModule =
    "src/material/pbr/fragments/refraction-rtt-fragment.ts";
const dispersionWgslModule =
    "src/material/pbr/fragments/refraction-dispersion-wgsl.ts";
const clearcoatFragmentModule =
    "src/material/pbr/fragments/clearcoat-fragment.ts";
const sheenFragmentModule =
    "src/material/pbr/fragments/sheen-fragment.ts";
const iridescenceFragmentModule =
    "src/material/pbr/fragments/iridescence-fragment.ts";
const clearcoatLoaderModule = "src/loader-gltf/gltf-ext-clearcoat.ts";
const sheenLoaderModule = "src/loader-gltf/gltf-ext-sheen.ts";
const iridescenceLoaderModule = "src/loader-gltf/gltf-ext-iridescence.ts";
const dielectricLoaderModule = "src/loader-gltf/gltf-ext-dielectric.ts";
const transmissionFrameGraphModule = "src/frame-graph/transmission.ts";
const sceneUniformsModule = "src/frame-graph/scene-uniforms-pack.ts";
const fogWgslModule = "src/shader/wgsl-fog.ts";
const skyboxCubemapModule =
    "src/material/standard/skybox-cubemap.ts";
const orthoMatrixModule = "src/math/mat4-ortho-lh-to-ref.ts";
const backgroundGroundModule = "src/material/pbr/background-ground.ts";
const backgroundDdsModule = "src/material/pbr/background-dds-skybox.ts";
const backgroundHdrModule = "src/material/pbr/background-hdr-skybox.ts";
const backgroundSolidModule =
    "src/material/pbr/background-solid-skybox.ts";
const rgbdDecodeModule = "src/loader-env/rgbd-decode.ts";
const surfaceModule = "src/engine/surface.ts";
const shaderPipelineModule = "src/material/shader/shader-pipeline.ts";
const sceneUniformsSourceModule = "src/shader/scene-uniforms.ts";

interface LoweredShader {
    output: string;
    data: string;
}

export class RendererLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerRenderPlan(options: {
        transmission?: boolean;
        fog?: boolean;
        imageSkybox?: boolean;
        solidSkybox?: boolean;
        textureTransform?: boolean;
        materialSpecular?: boolean;
        occlusionUv2?: boolean;
        environmentRotation?: boolean;
        gpuInstancing?: boolean;
        punctualLights?: boolean;
        clearcoat?: boolean;
        sheen?: boolean;
        sheenAlbedoScaling?: boolean;
        clearcoatF0Remap?: boolean;
        pinnedHelpers?: Readonly<Record<string, string>>;
        iridescence?: boolean;
        dispersion?: boolean;
        nodeVisibility?: boolean;
        orthographicCamera?: boolean;
        background?: boolean;
        shaderPrograms?: CompiledShaderProgram[];
    } = {}): LoweredSource {
        for (const symbol of ["buildBindings", "sortTransparentBindings", "drawList"]) {
            this.context.functionDeclaration(
                renderTaskModule,
                symbol,
            );
        }
        if (options.gpuInstancing) {
            // The instance parent-world helper transcribes these pinned
            // modules; assert they still carry the composed symbols.
            this.context.functionDeclaration(
                "src/math/mat4-compose-into.ts",
                "mat4ComposeInto",
            );
            this.context.functionDeclaration(
                "src/math/mat4-multiply-into.ts",
                "mat4MultiplyInto",
            );
            this.context.functionDeclaration(
                "src/math/quat-euler.ts",
                "eulerToQuat",
            );
            this.context.functionDeclaration(
                "src/scene/world-matrix-state.ts",
                "composeTrsLocalMatrix",
            );
        }
        if (options.orthographicCamera && options.background) {
            // Environment backgrounds build their own view-projection,
            // which still writes the perspective form; an orthographic
            // scene would draw its skybox or ground through a different
            // projection than its meshes.
            throw new Error(
                "Orthographic cameras are lowered for the scene projection only; environment skyboxes and grounds still build a perspective view-projection.",
            );
        }
        if (options.orthographicCamera) {
            // The reverse-Z off-center writer the projection branch
            // transcribes term by term.
            const orthoSource = this.context.store.getSource(
                orthoMatrixModule,
            );
            for (const marker of [
                "out[0] = 2 / (right - left);",
                "out[5] = 2 / (top - bottom);",
                "out[10] = -1 / range;",
                "out[12] = (left + right) / (left - right);",
                "out[13] = (top + bottom) / (bottom - top);",
                "out[14] = far / range;",
                "out[15] = 1;",
            ]) {
                if (!orthoSource.includes(marker)) {
                    throw new Error(
                        `Pinned Babylon Lite orthographic projection changed: ${marker}`,
                    );
                }
            }
        }
        const { declaration: sortTransparentBindings } =
            this.context.functionDeclaration(
                renderTaskModule,
                "sortTransparentBindings",
            );
        const sortDistance = this.context.findNodes(
            sortTransparentBindings,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                this.context
                    .propertyPath(node.left)
                    ?.join(".") === "b._sortDistance",
        )[0];
        if (!sortDistance) {
            this.context.contractError(
                sortTransparentBindings,
                "Expected transparent depth assignment.",
            );
        }
        this.context.assertExpressionShape(
            sortDistance.right,
            "wc ? wc[0] * v[2] + wc[1] * v[6] + wc[2] * v[10] + v[14] : 0",
            "Transparent view-space depth",
        );
        const sortCall = this.context.findNodes(
            sortTransparentBindings,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                node.expression.name.text === "sort",
        )[0];
        const comparator = sortCall?.arguments[0];
        if (
            !comparator ||
            (!ts.isArrowFunction(comparator) &&
                !ts.isFunctionExpression(comparator)) ||
            ts.isBlock(comparator.body)
        ) {
            this.context.contractError(
                sortCall ?? sortTransparentBindings,
                "Expected transparent sort comparator.",
            );
        }
        this.context.assertExpressionShape(
            comparator.body,
            "b._sortDistance - a._sortDistance || a.renderable.order - b.renderable.order",
            "Transparent draw ordering",
        );
        const { file: surfaceFile, declaration: buildSurface } =
            this.context.functionDeclaration(
                surfaceModule,
                "_buildSurface",
            );
        const msaaExpression =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    buildSurface,
                    "msaaSamples",
                ),
            );
        this.context.assertExpressionShape(
            msaaExpression,
            "options?.msaaSamples === 1 ? 1 : 4",
            "Default MSAA selection",
        );
        if (!ts.isConditionalExpression(msaaExpression)) {
            this.context.contractError(
                msaaExpression,
                "Expected conditional MSAA selection.",
            );
        }
        const sampleCount = this.context.numericValue(
            msaaExpression.whenFalse,
            surfaceFile,
        );
        const reachedShaderPrograms =
            options.shaderPrograms ?? [];
        const uniformComponentCount = (type: string): number =>
            type === "f32"
                ? 1
                : type === "vec2<f32>"
                    ? 2
                    : type === "vec3<f32>"
                        ? 3
                        : type === "vec4<f32>"
                            ? 4
                            : 0;
        const shaderVariantTable = reachedShaderPrograms.map(
            (program) => {
                const reflection =
                    lowerWgslShaderProgram(program).reflection;
                // Canonical custom-uniform value layout: declaration
                // order, sized by component count. The material record
                // stores this flat vector; per-stage gathers map it into
                // the reflected vec4-slot block layout.
                const valueOffsets = new Map<string, number>();
                let valueCount = 0;
                for (const signature of program.uniforms) {
                    const separator = signature.indexOf(":");
                    if (separator < 1) continue;
                    const memberName = signature.slice(0, separator);
                    const componentCount = uniformComponentCount(
                        signature.slice(separator + 1),
                    );
                    valueOffsets.set(memberName, valueCount);
                    valueCount += componentCount;
                }
                const defaults = new Array<number>(valueCount).fill(0);
                for (const entry of program.uniformDefaults) {
                    const offset = valueOffsets.get(entry.name);
                    if (offset === undefined) continue;
                    entry.values.forEach((value, index) => {
                        defaults[offset + index] = value;
                    });
                }
                const stageBlock = (stage: "vertex" | "fragment") => {
                    const block = reflection.uniformBlocks.find(
                        (candidate) => candidate.stage === stage,
                    );
                    if (!block) {
                        return { present: false, systemMatrix: false, floatSize: 0, gather: [] as number[][] };
                    }
                    return {
                        present: true,
                        systemMatrix: block.systemMatrix,
                        floatSize: block.size / 4,
                        gather: block.members.map((member) => [
                            member.offset / 4,
                            valueOffsets.get(member.name) ?? 0,
                            member.size / 4,
                        ]),
                    };
                };
                return {
                    name: program.name,
                    alphaBlending: program.needAlphaBlending,
                    alphaTesting: program.needAlphaTesting,
                    backFaceCulling: program.backFaceCulling,
                    depthWrite: program.depthWrite,
                    clipMatrix: program.clipDepth === "matrix",
                    valueCount,
                    defaults,
                    vertex: stageBlock("vertex"),
                    fragment: stageBlock("fragment"),
                };
            },
        );
        const shaderBindingCases = shaderVariantTable.map((info, id) =>
            `        case ${id}u:
            return fragment_stage ? ${info.fragment.present ? 1 : 0}u : ${info.vertex.present ? 1 : 0}u;`,
        ).join("\n");
        const floatLiteral = (value: number): string =>
            Number.isInteger(value)
                ? `${value}.0f`
                : `${value}f`;
        const stageBlockLiteral = (block: {
            present: boolean;
            systemMatrix: boolean;
            floatSize: number;
            gather: number[][];
        }): string =>
            `ShaderVariantStageBlock{${block.present}, ${block.systemMatrix}, ${block.floatSize}u, {${block.gather
                .map(
                    ([blockOffset, valueOffset, count]) =>
                        `{${blockOffset}u, ${valueOffset}u, ${count}u}`,
                )
                .join(", ")}}}`;
        const shaderVariantEntries = shaderVariantTable.map(
            (info) =>
                `    ShaderVariantInfo{
        "${info.name}",
        ${info.alphaBlending},
        ${info.alphaTesting},
        ${info.backFaceCulling},
        ${info.depthWrite},
        ${info.clipMatrix},
        ${info.valueCount}u,
        {${info.defaults.map(floatLiteral).join(", ")}},
        ${stageBlockLiteral(info.vertex)},
        ${stageBlockLiteral(info.fragment)},
    },`,
        ).join("\n");
        const transmissionUniformFields = options.transmission
            ? `    std::array<float, 4> refraction_params{};
    std::array<float, 4> volume_params{};
    std::array<float, 4> transmission_options{};
    std::array<std::array<float, 4>, 4> view_projection{};
`
            : "";
        // The pinned reflectance ext's material-UBO slice: the F0 scale, its
        // grazing weight, and the dielectric tint, laid out as the fragment
        // reads them.
        const specularUniformField = options.materialSpecular
            ? "    std::array<float, 4> reflectance_factors{};\n"
            : "";
        const specularMaterialUniform = options.materialSpecular
            ? `        result.reflectance_factors = {
            material.metallic_f0_factor,
            material.specular_weight,
            0.0f,
            0.0f,
        };
        result.metallic_reflectance_color = {
            material.metallic_reflectance_color.r,
            material.metallic_reflectance_color.g,
            material.metallic_reflectance_color.b,
            0.0f,
        };
`
            : "";
        const specularColorUniformField = options.materialSpecular
            ? "    std::array<float, 4> metallic_reflectance_color{};\n"
            : "";
        const uvTransformSlots = reachedUvTransformSlots(options);
        const textureTransformUniformField =
            options.textureTransform
                ? uvTransformSlots
                      .map(
                          (slot) =>
                              `    std::array<float, 4> ${slot.cpp}_uv_m{};\n` +
                              `    std::array<float, 4> ${slot.cpp}_uv_t{};\n`,
                      )
                      .join("")
                : "";
        const fogUniformFields = options.fog
            ? `    std::array<float, 4> fog_infos{};
    std::array<float, 4> fog_color{};
`
            : "";
        const fogUniforms = options.fog
            ? `    result.fog_infos = {
        scene.fog_mode,
        scene.fog_start,
        scene.fog_end,
        scene.fog_density,
    };
    result.fog_color = {
        scene.fog_color.r,
        scene.fog_color.g,
        scene.fog_color.b,
        0.0f,
    };
`
            : "";
        // Pinned uv-transform writeOne: the rotation-free branch stores the
        // scales on the diagonal untouched, and the rotated branch composes
        // [c*sx, s*sy, -s*sx, c*sy] in JavaScript doubles before the
        // Float32Array store rounds each component once.
        const textureTransformMaterialUniform =
            options.textureTransform
                ? uvTransformSlots
                      .map(
                          (slot) => `        {
            const TextureTransform& slot = material.${slot.cpp}_transform;
            if (slot.rotation == 0.0f) {
                result.${slot.cpp}_uv_m = {
                    slot.u_scale,
                    0.0f,
                    0.0f,
                    slot.v_scale,
                };
            } else {
                const double angle = static_cast<double>(slot.rotation);
                const double cosine = std::cos(angle);
                const double sine = std::sin(angle);
                result.${slot.cpp}_uv_m = {
                    static_cast<float>(
                        cosine * static_cast<double>(slot.u_scale)),
                    static_cast<float>(
                        sine * static_cast<double>(slot.v_scale)),
                    static_cast<float>(
                        -sine * static_cast<double>(slot.u_scale)),
                    static_cast<float>(
                        cosine * static_cast<double>(slot.v_scale)),
                };
            }
            result.${slot.cpp}_uv_t = {
                slot.u_offset,
                slot.v_offset,
                0.0f,
                0.0f,
            };
        }
`,
                      )
                      .join("")
                : "";
        const multiLightUniformFields =
            options.punctualLights
                ? `    std::array<std::array<float, 4>, 7> extra_light_positions{};
    std::array<std::array<float, 4>, 7> extra_light_colors{};
    std::array<std::array<float, 4>, 7> extra_light_directions{};
`
                : "";
        // Under multi-light the extras loop owns every light past the
        // primary slot, so the second analytic slot stays disabled to
        // avoid double-counting scene.lights[1].
        const secondAnalyticLightFill =
            options.punctualLights
                ? ""
                : `    if (scene.lights.size() > 1) {
        write_pbr_light(
            scene.lights[1],
            result.light_direction_2,
            result.light_color_2,
            result.ground_color_2);
    }
`;
        const multiLightMaterialUniforms =
            options.punctualLights
                ? `        for (
            std::size_t light_index = 1;
            light_index < scene.lights.size() &&
            light_index <= result.extra_light_positions.size();
            ++light_index) {
            const LightHandle handle =
                scene.lights[light_index];
            if (handle.value >= engine.lights.size()) continue;
            const LightRecord& extra =
                engine.lights[handle.value];
            if (
                extra.kind != LightKind::point &&
                extra.kind != LightKind::spot) {
                continue;
            }
            const std::size_t output = light_index - 1;
            result.extra_light_positions[output] = {
                extra.position.x,
                extra.position.y,
                extra.position.z,
                extra.range,
            };
            result.extra_light_colors[output] = {
                extra.diffuse_color.r,
                extra.diffuse_color.g,
                extra.diffuse_color.b,
                extra.intensity * material.direct_intensity,
            };
            // A cosine lives in [-1, 1], so -2 is unambiguously "this slot
            // has no cone" and a point light keeps its bare inverse-square
            // falloff.
            result.extra_light_directions[output] = {
                extra.direction.x,
                extra.direction.y,
                extra.direction.z,
                extra.kind == LightKind::spot
                    ? extra.cos_half_angle
                    : -2.0f,
            };
        }
`
                : "";
        const transmissionMaterialUniforms = options.transmission
            ? `        const float ior = material.index_of_refraction;
        const float thickness_scale =
            item.mesh.value < engine.meshes.size()
                ? engine.meshes[item.mesh.value].baked_world_scale
                : 1.0f;
        result.refraction_params = {
            material.transmission_factor,
            1.0f / (material.use_thickness_as_depth && material.thickness > 0.0f
                ? ior
                : 1.0f),
            material.use_thickness_as_depth
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
            ${options.dispersion ? "material.dispersion" : "0.0f"},
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
        const materialExtensionUniformFields =
            `${options.clearcoat
                ? `    std::array<float, 4> clearcoat_params{};
    std::array<float, 4> clearcoat_refraction_params{};
`
                : ""}${options.sheen
                ? `    std::array<float, 4> sheen_params{};
    std::array<float, 4> sheen_params2{};
`
                : ""}${options.iridescence
                ? "    std::array<float, 4> iridescence_params{};\n" +
                  "    std::array<float, 4> iridescence_options{};\n"
                : ""}${options.occlusionUv2
                ? "    std::array<float, 4> occlusion_params{};\n"
                : ""}`;
        const materialExtensionUniforms =
            `${options.clearcoat
                ? `        result.clearcoat_params = {
            material.clearcoat_intensity,
            material.clearcoat_roughness,
            material.clearcoat_normal_scale,
            material.clearcoat_normal_texture.bytes.empty()
                ? 0.0f
                : 1.0f,
        };
        const float clearcoat_a =
            1.0f - material.clearcoat_index_of_refraction;
        const float clearcoat_b =
            1.0f + material.clearcoat_index_of_refraction;
        const float clearcoat_f0 =
            (-clearcoat_a / clearcoat_b) *
            (-clearcoat_a / clearcoat_b);
        result.clearcoat_refraction_params = {
            clearcoat_f0,
            1.0f / material.clearcoat_index_of_refraction,
            clearcoat_a,
            clearcoat_b,
        };
`
                : ""}${options.sheen
                ? `        result.sheen_params = {
            material.sheen_color.r,
            material.sheen_color.g,
            material.sheen_color.b,
            material.sheen_intensity,
        };
        result.sheen_params2 = {
            material.sheen_roughness,
            material.sheen_color_texture.bytes.empty()
                ? 0.0f
                : 1.0f,
            0.0f,
            0.0f,
        };
`
                : ""}${options.iridescence
                ? `        result.iridescence_params = {
            material.iridescence_intensity,
            material.iridescence_index_of_refraction,
            material.iridescence_minimum_thickness,
            material.iridescence_maximum_thickness,
        };
        result.iridescence_options = {
            material.iridescence_texture.bytes.empty() ? 0.0f : 1.0f,
            material.iridescence_thickness_texture.bytes.empty()
                ? 0.0f
                : 1.0f,
            0.0f,
            0.0f,
        };
`
                : ""}${options.occlusionUv2
                ? `        result.occlusion_params = {
            material.occlusion_texture_uv2 ? 1.0f : 0.0f,
            0.0f,
            0.0f,
            0.0f,
        };
`
                : ""}`;

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
    pbr_opaque_none_clockwise,
    pbr_transparent_back,
    pbr_transparent_none,
    pbr_transparent_none_clockwise,
    standard_opaque_back,
    standard_opaque_none,
    standard_transparent_back,
    standard_transparent_none,
    grid_opaque_back,
    grid_opaque_none,
    grid_transparent_back,
    grid_transparent_none,
    shader,
    shader_a2c,
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
    std::uint32_t shader_variant = 0;
    bool clockwise_front_face = false;
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
    bool shader_material = false;
};

// Generated per-scene shader-variant metadata: pipeline state from the
// pinned shader-pipeline mapping and the reflected per-stage uniform
// blocks ([optional 16-float worldViewProjection][vec4-slot-packed
// custom members]) with gathers from the material's flat value storage.
struct ShaderVariantStageBlock {
    bool present = false;
    bool system_matrix = false;
    std::uint32_t float_size = 0;
    // {block float offset, value float offset, float count}
    std::vector<std::array<std::uint32_t, 3>> gather;
};

struct ShaderVariantInfo {
    const char* name = "";
    bool alpha_blending = false;
    bool alpha_testing = false;
    bool back_face_culling = true;
    bool depth_write = true;
    bool clip_matrix = false;
    std::uint32_t value_count = 0;
    std::vector<float> defaults;
    ShaderVariantStageBlock vertex;
    ShaderVariantStageBlock fragment;
};

std::uint32_t shader_variant_count();
const ShaderVariantInfo& shader_variant_info(std::uint32_t variant);

struct PbrUniforms {
    std::array<float, 4> light_direction{};
    std::array<float, 4> light_color{};
    std::array<float, 4> ground_color{};
${multiLightUniformFields}\
    std::array<float, 4> light_direction_2{};
    std::array<float, 4> light_color_2{};
    std::array<float, 4> ground_color_2{};
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
${specularUniformField}\
${specularColorUniformField}\
${textureTransformUniformField}\
${fogUniformFields}\
${transmissionUniformFields}\
${materialExtensionUniformFields}\
    std::array<std::array<float, 4>, 9> spherical_harmonics{};
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
${options.solidSkybox
    ? `
struct SolidSkyboxPlan {
    std::array<std::array<float, 3>, 8> positions{};
    std::array<std::uint32_t, 36> indices{};
};

// src/material/pbr/background-solid-skybox.ts createSkyMeshUBO: the pinned
// 96-byte mesh block, field for field, so a native capture pairs against the
// browser's own buffer.
struct SolidSkyboxUniforms {
    std::array<float, 16> world{};
    std::array<float, 3> primary_color{};
    float pad = 0.0f;
    std::array<float, 3> sky_output_color{};
    float pad2 = 0.0f;
};

// src/shader/scene-uniforms.ts SCENE_UBO_WGSL, truncated at the last member
// the pinned skybox stages read. The vertex stage keeps the pin's own
// scene.viewProjection and scene.vEyePosition references, so this block is the
// pin's per-pass prefix rather than a native invention.
struct SolidSkyboxSceneUniforms {
    std::array<float, 16> view_projection{};
    std::array<float, 16> view{};
    std::array<float, 4> eye_position{};
};
`
    : ""}\
${options.imageSkybox
    ? `
struct ImageSkyboxPlan {
    std::array<std::array<float, 3>, 8> positions{};
    std::array<std::uint32_t, 36> indices{};
};

struct ImageSkyboxUniforms {
    std::array<float, 4> camera_position{};
    std::array<float, 4> view_right{};
    std::array<float, 4> view_up{};
    std::array<float, 4> view_forward{};
    std::array<float, 4> fog_infos{};
    std::array<float, 4> fog_color{};
};
`
    : ""}\

RenderPlan build_render_plan(const Scene& scene, const Engine& engine);
RenderFeatures build_render_features(
    const Scene& scene,
    const Engine& engine);
std::uint32_t shader_uniform_buffer_count(
    std::uint32_t variant,
    bool fragment_stage);
RenderDrawLists build_render_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine);
RenderDrawLists build_render_task_draw_lists(
    const std::vector<RenderItem>& items,
    const Engine& engine,
    const FrameTaskRecord& task);
struct CameraBasis {
    Vec3 eye;
    Vec3 forward;
    Vec3 right;
    Vec3 up;
};
CameraBasis camera_basis(const CameraRecord& camera);
void sort_transparent_draws(
    RenderDrawList& transparent,
    const Engine& engine,
    const CameraRecord& camera);
RenderItem bind_render_item(
    RenderItem item,
    const Engine& engine,
    MaterialHandle material);
std::uint32_t preferred_sample_count();
// The aspect ratio is a JavaScript number in
// src/camera/camera.ts getEffectiveAspectRatio, and the pinned
// projection writer divides by it before its single float32 store.
std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    double aspect,
    bool reverse_depth = false);
// The pin's scene.view, from the camera's own world matrix. Declared because
// the pinned PBR variants read it out of the scene block a PAL fills, where the
// transcribed fragment never needed it.
std::array<float, 16> build_view_matrix(
    const std::array<float, 16>& camera_world);
std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    double aspect);
${options.gpuInstancing
    ? `std::array<float, 16> build_instance_parent_world(
    const MeshRecord& mesh);
`
    : ""}\
// src/render/lights-ubo.ts affectsMesh: a light applies to the meshes its
// includedOnlyMeshesIds names, or to every mesh its excludedMeshesIds does
// not. One definition, because both the Standard slot writer and the pinned
// per-draw mesh block need the same per-mesh light set.
bool light_affects_mesh(
    const LightRecord& light,
    std::uint32_t mesh_index);
PbrUniforms build_pbr_uniforms(
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
${options.solidSkybox
    ? `SolidSkyboxPlan build_solid_skybox_plan(
    const EnvironmentState& environment);
SolidSkyboxUniforms build_solid_skybox_uniforms(
    const Scene& scene);
SolidSkyboxSceneUniforms build_solid_skybox_scene_uniforms(
    const CameraRecord& camera,
    double aspect);
`
    : ""}\
${options.imageSkybox
    ? `ImageSkyboxPlan build_image_skybox_plan(
    const EnvironmentState& environment);
ImageSkyboxUniforms build_image_skybox_uniforms(
    const Scene& scene,
    const CameraRecord& camera);
`
    : ""}\

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
#include <stdexcept>
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

} // namespace

// src/camera/camera.ts getViewMatrix: the rotation is the transpose of
// the world matrix's basis and the translation is that basis applied to
// the negated eye, computed from the float32 world matrix in JavaScript
// doubles and stored once into the float32 view cache.
//
// Outside the anonymous namespace because a PAL binding the pinned PBR
// variants fills the pin's own scene block, which carries scene.view.
std::array<float, 16> build_view_matrix(
    const std::array<float, 16>& world) {
    const double cx = static_cast<double>(world[12]);
    const double cy = static_cast<double>(world[13]);
    const double cz = static_cast<double>(world[14]);
    std::array<float, 16> view{};
    view[0] = world[0];
    view[1] = world[4];
    view[2] = world[8];
    view[3] = 0.0f;
    view[4] = world[1];
    view[5] = world[5];
    view[6] = world[9];
    view[7] = 0.0f;
    view[8] = world[2];
    view[9] = world[6];
    view[10] = world[10];
    view[11] = 0.0f;
    view[12] = static_cast<float>(
        -(static_cast<double>(world[0]) * cx +
          static_cast<double>(world[1]) * cy +
          static_cast<double>(world[2]) * cz));
    view[13] = static_cast<float>(
        -(static_cast<double>(world[4]) * cx +
          static_cast<double>(world[5]) * cy +
          static_cast<double>(world[6]) * cz));
    view[14] = static_cast<float>(
        -(static_cast<double>(world[8]) * cx +
          static_cast<double>(world[9]) * cy +
          static_cast<double>(world[10]) * cz));
    view[15] = 1.0f;
    return view;
}

namespace {

// src/math/mat4-multiply-into.ts mat4MultiplyInto: the pinned writer
// accumulates each term in double from two float32 matrices and stores
// once, where a float accumulator rounds after every product.
std::array<float, 16> multiply_into(
    const std::array<float, 16>& a,
    const std::array<float, 16>& b) {
    std::array<float, 16> out{};
    for (int column = 0; column < 4; ++column) {
        const double b0 = static_cast<double>(b[column * 4]);
        const double b1 = static_cast<double>(b[column * 4 + 1]);
        const double b2 = static_cast<double>(b[column * 4 + 2]);
        const double b3 = static_cast<double>(b[column * 4 + 3]);
        for (int row = 0; row < 4; ++row) {
            out[column * 4 + row] = static_cast<float>(
                static_cast<double>(a[row]) * b0 +
                static_cast<double>(a[4 + row]) * b1 +
                static_cast<double>(a[8 + row]) * b2 +
                static_cast<double>(a[12 + row]) * b3);
        }
    }
    return out;
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
                if (!double_sided) {
                    return RenderPipelineKind::pbr_transparent_back;
                }
                return item.clockwise_front_face
                    ? RenderPipelineKind::pbr_transparent_none_clockwise
                    : RenderPipelineKind::pbr_transparent_none;
            }
            if (!double_sided) {
                return RenderPipelineKind::pbr_opaque_back;
            }
            return item.clockwise_front_face
                ? RenderPipelineKind::pbr_opaque_none_clockwise
                : RenderPipelineKind::pbr_opaque_none;
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
            return item.alpha_to_coverage
                ? RenderPipelineKind::shader_a2c
                : RenderPipelineKind::shader;
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
        item.bucket == RenderBucket::alpha_blend ||
        item.transmissive
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
        case RenderPipelineKind::shader:
        case RenderPipelineKind::shader_a2c:
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
    features.shader_material |= material.shader_material;
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

namespace {

const std::array<ShaderVariantInfo, ${shaderVariantTable.length}> shader_variants{{
${shaderVariantEntries}
}};

} // namespace

std::uint32_t shader_variant_count() {
    return ${shaderVariantTable.length}u;
}

const ShaderVariantInfo& shader_variant_info(std::uint32_t variant) {
    if (variant >= shader_variants.size()) {
        throw std::runtime_error("Unknown shader variant id.");
    }
    return shader_variants[variant];
}

std::uint32_t shader_uniform_buffer_count(
    std::uint32_t variant,
    bool fragment_stage) {
    switch (variant) {
${shaderBindingCases}
        default:
            return 0u;
    }
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
    if (task.kind == FrameTaskKind::geometry) {
        RenderDrawLists result;
        result.opaque.commands.reserve(items.size());
        result.transparent.commands.reserve(items.size());
        for (std::size_t index = 0; index < items.size(); ++index) {
            const RenderItem item = bind_render_item(
                items[index],
                engine,
                items[index].material);
            if (
                item.material_kind != RenderMaterialKind::pbr &&
                item.material_kind != RenderMaterialKind::standard) {
                continue;
            }
            append_draw(
                result,
                static_cast<std::uint32_t>(index),
                item);
        }
        order_draw_lists(result);
        return result;
    }
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

// The view basis every camera-facing computation starts from: the eye the
// pinned ArcRotate formula puts the camera at, and the orthonormal frame
// looking at its target. Written once because a camera feature that
// changes it -- an orthographic volume, a different up axis -- has to
// change it everywhere at once.
// The basis is read out of the pinned camera world matrix rather than
// recomputed: src/math/mat4-look-at-world-lh.ts writes columns
// [xAxis, yAxis, zAxis, eye] and src/camera/camera.ts getCameraPosition
// reads the eye straight back out of column 3, so these are the same
// float32 values every pinned consumer sees.
CameraBasis camera_basis(const CameraRecord& camera) {
    const std::array<float, 16> world = camera_world_matrix(camera);
    return CameraBasis{
        Vec3{world[12], world[13], world[14]},
        Vec3{world[8], world[9], world[10]},
        Vec3{world[0], world[1], world[2]},
        Vec3{world[4], world[5], world[6]},
    };
}

void sort_transparent_draws(
    RenderDrawList& transparent,
    const Engine& engine,
    const CameraRecord& camera) {
    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
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
        }${options.nodeVisibility ? `
        // KHR_node_visibility, materialized per mesh by the loader and by
        // the animation pointer, exactly as the pinned setSubtreeVisible
        // materializes it per node.
        if (!mesh.visible) {
            continue;
        }` : ""}
        RenderItem item;
        item.mesh = handle;
        item.geometry = mesh.geometry;
        item.clockwise_front_face =
            mesh.clockwise_front_face;
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
    double aspect,
    bool reverse_depth) {
    const std::array<float, 16> view =
        build_view_matrix(camera_world_matrix(camera));

${options.orthographicCamera
    ? `    if (camera.orthographic) {
        // src/camera/orthographic.ts writeOrthoProjection derives every
        // plane from the half-extent, then writes
        // src/math/mat4-ortho-lh-to-ref.ts mat4OrthoOffCenterLHToRef.
        // The pinned writer runs in JavaScript doubles into a
        // Float32Array cache, so the terms are computed in double here
        // and stored as float, and the reverse-Z form (near -> 1,
        // far -> 0) is the pinned one; the native main pass keeps the
        // near -> 0 convention its perspective branch already uses.
        const double half_height =
            static_cast<double>(camera.ortho_half_height);
        const double half_width =
            half_height * static_cast<double>(aspect);
        const double left = -half_width;
        const double right = half_width;
        const double bottom = -half_height;
        const double top = half_height;
        const double near_plane =
            static_cast<double>(camera.near_plane);
        const double far_plane =
            static_cast<double>(camera.far_plane);
        const double range = far_plane - near_plane;
        std::array<float, 16> projection{};
        projection[0] = static_cast<float>(2.0 / (right - left));
        projection[5] = static_cast<float>(2.0 / (top - bottom));
        projection[10] = static_cast<float>(
            reverse_depth ? -1.0 / range : 1.0 / range);
        projection[12] =
            static_cast<float>((left + right) / (left - right));
        projection[13] =
            static_cast<float>((top + bottom) / (bottom - top));
        projection[14] = static_cast<float>(
            reverse_depth ? far_plane / range
                          : -near_plane / range);
        projection[15] = 1.0f;
        return multiply_into(projection, view);
    }
`
    : ""}\
    // src/math/mat4-perspective-lh-to-ref.ts mat4PerspectiveLHToRef, in
    // the same double-then-store-once shape as the rest of the chain.
    // Rows [10] and [14] are the one deliberate departure: the pin maps
    // near -> 1 and far -> 0, and the native main pass keeps its recorded
    // forward-Z convention. That row reaches clip z alone -- with
    // projection[11] = 1 and every other off-diagonal term zero, clip x,
    // y and w are products of rows [0], [5] and the view's z row -- so it
    // moves no interpolated varying and no coverage.
    const double focal = 1.0 / std::tan(camera.fov * 0.5);
    const double range = camera.far_plane - camera.near_plane;
    std::array<float, 16> projection{};
    projection[0] = static_cast<float>(focal / aspect);
    projection[5] = static_cast<float>(focal);
    projection[10] = static_cast<float>(
        reverse_depth ? -camera.near_plane / range
                      : camera.far_plane / range);
    projection[11] = 1.0f;
    projection[14] = static_cast<float>(
        reverse_depth
            ? (camera.far_plane * camera.near_plane) / range
            : (-camera.near_plane * camera.far_plane) / range);
    return multiply_into(projection, view);
}

std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    double aspect) {
    // A skybox follows the camera, so this view keeps the rotation and
    // drops the eye translation the other builders apply. The rotation
    // is the same transpose getViewMatrix writes, so it is taken from
    // the pinned world matrix rather than recomposed.
    std::array<float, 16> view =
        build_view_matrix(camera_world_matrix(camera));
    view[12] = 0.0f;
    view[13] = 0.0f;
    view[14] = 0.0f;

    const double focal = 1.0 / std::tan(camera.fov * 0.5);
    const double range = camera.far_plane - camera.near_plane;
    std::array<float, 16> projection{};
    projection[0] = static_cast<float>(focal / aspect);
    projection[5] = static_cast<float>(focal);
    projection[10] =
        static_cast<float>(camera.far_plane / range);
    projection[11] = 1.0f;
    projection[14] = static_cast<float>(
        (-camera.near_plane * camera.far_plane) / range);
    return multiply_into(projection, view);
}

${options.gpuInstancing
    ? `// src/scene/world-matrix-state.ts composeTrsLocalMatrix +
// src/math/mat4-compose-into.ts mat4ComposeInto: a thin-instanced mesh
// reaches the vertex stage's mesh.world (the instance parent-world
// uniform) from its record TRS, composed in JavaScript double precision
// and stored to f32 exactly like the pinned Float32Array world matrix.
// src/math/quat-euler.ts eulerToQuat converts Euler records the way the
// pinned Euler proxy writes the quaternion source of truth (non-zero
// Euler angles inherit the recorded std::sin/cos-versus-V8 ULP caveat).
// The pinned-parent multiply keeps the src/math/mat4-multiply-into.ts
// accumulation order, so a loader-built glTF pool (identity record TRS)
// reproduces instance_parent_matrix byte for byte and a user pool
// (identity parent) reproduces the composed TRS byte for byte.
std::array<float, 16> build_instance_parent_world(
    const MeshRecord& mesh) {
    if (!mesh.thin_instanced) {
        return mesh.instance_parent_matrix;
    }
    double qx = 0.0;
    double qy = 0.0;
    double qz = 0.0;
    double qw = 1.0;
    if (mesh.has_rotation_quaternion) {
        qx = mesh.rotation_quaternion.x;
        qy = mesh.rotation_quaternion.y;
        qz = mesh.rotation_quaternion.z;
        qw = mesh.rotation_quaternion.w;
    } else if (
        mesh.rotation.x != 0.0f ||
        mesh.rotation.y != 0.0f ||
        mesh.rotation.z != 0.0f) {
        const double half_x =
            static_cast<double>(mesh.rotation.x) * 0.5;
        const double half_y =
            static_cast<double>(mesh.rotation.y) * 0.5;
        const double half_z =
            static_cast<double>(mesh.rotation.z) * 0.5;
        const double cx = std::cos(half_x);
        const double sx = std::sin(half_x);
        const double cy = std::cos(half_y);
        const double sy = std::sin(half_y);
        const double cz = std::cos(half_z);
        const double sz = std::sin(half_z);
        qx = sx * cy * cz + cx * sy * sz;
        qy = cx * sy * cz - sx * cy * sz;
        qz = cx * cy * sz + sx * sy * cz;
        qw = cx * cy * cz - sx * sy * sz;
    }
    const double scale_x = mesh.scaling.x;
    const double scale_y = mesh.scaling.y;
    const double scale_z = mesh.scaling.z;
    const double xx = qx * qx;
    const double yy = qy * qy;
    const double zz = qz * qz;
    const double xy = qx * qy;
    const double xz = qx * qz;
    const double yz = qy * qz;
    const double wx = qw * qx;
    const double wy = qw * qy;
    const double wz = qw * qz;
    std::array<double, 16> local{};
    local[0] = (1.0 - 2.0 * (yy + zz)) * scale_x;
    local[1] = 2.0 * (xy + wz) * scale_x;
    local[2] = 2.0 * (xz - wy) * scale_x;
    local[4] = 2.0 * (xy - wz) * scale_y;
    local[5] = (1.0 - 2.0 * (xx + zz)) * scale_y;
    local[6] = 2.0 * (yz + wx) * scale_y;
    local[8] = 2.0 * (xz + wy) * scale_z;
    local[9] = 2.0 * (yz - wx) * scale_z;
    local[10] = (1.0 - 2.0 * (xx + yy)) * scale_z;
    local[12] = mesh.position.x;
    local[13] = mesh.position.y;
    local[14] = mesh.position.z;
    local[15] = 1.0;
    std::array<float, 16> result{};
    for (std::size_t column = 0; column < 4; ++column) {
        for (std::size_t row = 0; row < 4; ++row) {
            // Seed with the first product so signed zeros follow the
            // pinned a0*b0 + a4*b1 + a8*b2 + a12*b3 evaluation exactly.
            double sum =
                static_cast<double>(
                    mesh.instance_parent_matrix[row]) *
                local[column * 4];
            for (std::size_t term = 1; term < 4; ++term) {
                sum +=
                    static_cast<double>(
                        mesh.instance_parent_matrix[
                            term * 4 + row]) *
                    local[column * 4 + term];
            }
            result[column * 4 + row] =
                static_cast<float>(sum);
        }
    }
    return result;
}

`
    : ""}\
// src/render/lights-ubo.ts affectsMesh.
bool light_affects_mesh(
    const LightRecord& light,
    std::uint32_t mesh_index) {
    if (light.included_meshes.empty()) {
        return std::find(
                   light.excluded_meshes.begin(),
                   light.excluded_meshes.end(),
                   mesh_index) == light.excluded_meshes.end();
    }
    return std::find(
               light.included_meshes.begin(),
               light.included_meshes.end(),
               mesh_index) != light.included_meshes.end();
}

PbrUniforms build_pbr_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item) {
    PbrUniforms result;
    result.light_direction[1] = 1.0f;
    // Analytic light kinds encode in light_direction.w: 0 hemispheric,
    // 1 point, 2 directional (src/material/pbr/fragments/
    // singlelight-directional-wgsl.ts drives the directional block).
    const auto write_pbr_light =
        [&engine](
            const LightHandle handle,
            std::array<float, 4>& light_direction,
            std::array<float, 4>& light_color,
            std::array<float, 4>& ground_color) {
        if (handle.value >= engine.lights.size()) {
            return;
        }
        const LightRecord& light = engine.lights[handle.value];
        if (light.kind == LightKind::spot) {
            // The primary slot encodes its kind in lightDirection.w across
            // three branches and carries no cone; only the extra-light slots
            // do. No reached scene puts a spot first, so this refuses rather
            // than shading it as a directional light.
            throw std::runtime_error(
                "Reached PBR lighting supports a spot light only outside the primary slot.");
        }
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
        light_direction =
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
                      light.kind == LightKind::directional
                          ? 2.0f
                          : 0.0f,
                  };
        light_color = {
            light.diffuse_color.r,
            light.diffuse_color.g,
            light.diffuse_color.b,
            light.intensity,
        };
        ground_color = {
            light.ground_color.r,
            light.ground_color.g,
            light.ground_color.b,
            light.kind == LightKind::point ? light.range : 0.0f,
        };
    };
    if (!scene.lights.empty()) {
        write_pbr_light(
            scene.lights.front(),
            result.light_direction,
            result.light_color,
            result.ground_color);
    }
${secondAnalyticLightFill}    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
    const Vec3& right = basis.right;
    const Vec3& up = basis.up;
    result.camera_position = {
        eye.x,
        eye.y,
        eye.z,
        static_cast<float>(camera.far_plane),
    };
    result.camera_forward_near = {
        forward.x,
        forward.y,
        forward.z,
        static_cast<float>(camera.near_plane),
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
${options.environmentRotation
    ? `    result.image_processing_options[1] =
        scene.environment.rotation_y;
`
    : ""}\
${fogUniforms}\
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
        result.material_factors[2] = material.has_occlusion_texture
            ? material.occlusion_strength
            : 0.0f;
        result.material_factors[3] =
            scene.environment.has_irradiance
                ? material.environment_intensity
                : 0.0f;
        result.light_color[3] *= material.direct_intensity;
        // The pinned extra-light terms multiply material.directIntensity
        // explicitly (src/material/pbr/fragments/multilight-wgsl.ts), so
        // the second analytic slot folds it into its intensity scalar
        // exactly like the primary slot.
        result.light_color_2[3] *= material.direct_intensity;
${multiLightMaterialUniforms}\
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
${specularMaterialUniform}\
${textureTransformMaterialUniform}\
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
${materialExtensionUniforms}\
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
        ModelVertex{Vec3{center.x - half, center.y, center.z + half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 0.0f}},
        ModelVertex{Vec3{center.x + half, center.y, center.z + half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 0.0f}},
        ModelVertex{Vec3{center.x + half, center.y, center.z - half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 1.0f}},
        ModelVertex{Vec3{center.x - half, center.y, center.z - half}, Vec3{0.0f, 1.0f, 0.0f}, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 1.0f}},
    };
    result.indices = {0, 2, 1, 0, 3, 2};
    return result;
}

BackgroundUniforms build_background_uniforms(
    const EnvironmentState& environment,
    const CameraRecord& camera) {
    const Vec3 eye = camera_basis(camera).eye;
    BackgroundUniforms result;
    result.primary_color_alpha = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
        0.9f,
    };
    result.background_center = {
        0.0f,
        0.0f,
        0.0f,
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
    const Vec3 center = environment.skybox_uses_environment
        ? Vec3{}
        : environment.skybox_position;
    const auto vertex = [&](float x, float y, float z) {
        return ModelVertex{
            Vec3{
                center.x + x,
                center.y + y,
                center.z + z,
            },
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
    const Vec3 center = environment.skybox_uses_environment
        ? Vec3{}
        : environment.skybox_position;
    SkyboxUniforms result;
    result.primary_color_exposure = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
        environment.exposure,
    };
    result.background_center = {
        center.x,
        center.y,
        center.z,
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
${options.solidSkybox
    ? `
SolidSkyboxPlan build_solid_skybox_plan(
    const EnvironmentState& environment) {
    // createSkyboxBuffers(engine, skyHalfSize): the cube is authored around
    // the model origin and reaches world space through mesh.world, which the
    // vertex stage applies with w = 0 -- so the root translation drops out and
    // only the half extent reaches the buffer.
    const float half = environment.skybox_size * 0.5f;
    SolidSkyboxPlan result;
    result.positions = {{
        {-half, -half, -half},
        {half, -half, -half},
        {-half, half, -half},
        {half, half, -half},
        {-half, -half, half},
        {half, -half, half},
        {-half, half, half},
        {half, half, half},
    }};
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

SolidSkyboxUniforms build_solid_skybox_uniforms(const Scene& scene) {
    const EnvironmentState& environment = scene.environment;
    SolidSkyboxUniforms result;
    result.world[0] = 1.0f;
    result.world[5] = 1.0f;
    result.world[10] = 1.0f;
    result.world[15] = 1.0f;
    result.world[12] = environment.skybox_position.x;
    result.world[13] = environment.skybox_position.y;
    result.world[14] = environment.skybox_position.z;
    result.primary_color = {
        environment.primary_color.r,
        environment.primary_color.g,
        environment.primary_color.b,
    };
    // skyOutputColor is the scene clear colour, which this fragment writes
    // directly: the solid arm applies no image processing at all.
    result.sky_output_color = {
        scene.clear_color.r,
        scene.clear_color.g,
        scene.clear_color.b,
    };
    return result;
}

SolidSkyboxSceneUniforms build_solid_skybox_scene_uniforms(
    const CameraRecord& camera,
    double aspect) {
    const Vec3 eye = camera_basis(camera).eye;
    SolidSkyboxSceneUniforms result;
    // This one draw binds the pin's own reverse-Z clip row rather than the
    // renderer's. The cube is centred on the eye, so its side faces straddle
    // the near plane and are clipped -- and the clipper interpolates the
    // attributes of the vertices it generates from clip space, including z.
    // The dither seeds on that interpolated positionW, so a differing z row
    // decorrelates the noise across every clipped face while leaving the
    // unclipped one exact. The draw writes no depth and is first in the pass,
    // so the convention cannot reach the depth test.
    result.view_projection =
        build_view_projection(camera, aspect, true);
    result.view = build_view_matrix(camera_world_matrix(camera));
    result.eye_position = {eye.x, eye.y, eye.z, 0.0f};
    return result;
}
`
    : ""}\
${options.imageSkybox
    ? `
ImageSkyboxPlan build_image_skybox_plan(
    const EnvironmentState& environment) {
    // Pinned loadSkybox: createBoxData(size) spans plus/minus size/2
    // around the world origin with an identity world matrix.
    const float half = environment.image_skybox_size * 0.5f;
    ImageSkyboxPlan result;
    const std::array<std::array<float, 3>, 8> corners{{
        {-half, -half, -half},
        {half, -half, -half},
        {-half, half, -half},
        {half, half, -half},
        {-half, -half, half},
        {half, -half, half},
        {-half, half, half},
        {half, half, half},
    }};
    result.positions = corners;
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

ImageSkyboxUniforms build_image_skybox_uniforms(
    const Scene& scene,
    const CameraRecord& camera) {
    ImageSkyboxUniforms result;
    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
    const Vec3& right = basis.right;
    const Vec3& up = basis.up;
    result.camera_position = {eye.x, eye.y, eye.z, 0.0f};
    result.view_right = {right.x, right.y, right.z, 0.0f};
    result.view_up = {up.x, up.y, up.z, 0.0f};
    result.view_forward = {forward.x, forward.y, forward.z, 0.0f};
    result.fog_infos = {
        scene.fog_mode,
        scene.fog_start,
        scene.fog_end,
        scene.fog_density,
    };
    result.fog_color = {
        scene.fog_color.r,
        scene.fog_color.g,
        scene.fog_color.b,
        0.0f,
    };
    return result;
}
`
    : ""}\

} // namespace bbl::upstream
`,
        };
    }

    public lowerShaders(options: {
        ground: boolean;
        skybox: boolean;
        imageSkybox?: boolean;
        solidSkybox?: boolean;
        transmission?: boolean;
        fog?: boolean;
        normalTextureScale?: boolean;
        shaderPrograms: CompiledShaderProgram[];
        gridMaterial?: boolean;
        idDiagnostics: boolean;
        geometryOutputTasks: GeometryOutputTaskManifest[];
        frameGraph?: boolean;
        gpuDeformation?: boolean;
        morphStorage?: boolean;
        textureTransform?: boolean;
        environmentRotation?: boolean;
        gpuInstancing?: boolean;
        punctualLights?: boolean;
        clearcoat?: boolean;
        sheen?: boolean;
        sheenAlbedoScaling?: boolean;
        clearcoatF0Remap?: boolean;
        pinnedHelpers?: Readonly<Record<string, string>>;
        iridescence?: boolean;
        dispersion?: boolean;
        occlusionUv2?: boolean;
        materialSpecular?: boolean;
    } = {
        ground: true,
        skybox: true,
        transmission: true,
        normalTextureScale: true,
        shaderPrograms: shaderMaterialPrograms.map((program) => ({
            ...program,
            uniformDefaults: program.uniformDefaults ?? [],
        })),
        gridMaterial: false,
        idDiagnostics: true,
        geometryOutputTasks: [],
        gpuDeformation: false,
        morphStorage: false,
        textureTransform: false,
        environmentRotation: false,
        gpuInstancing: false,
        punctualLights: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        dispersion: false,
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
        const gridModule = "src/material/grid/grid-material.ts";
        const clearcoatFragment = this.context.store.getSource(
            clearcoatFragmentModule,
        );
        const sheenFragment = this.context.store.getSource(
            sheenFragmentModule,
        );
        const iridescenceFragment = this.context.store.getSource(
            iridescenceFragmentModule,
        );
        const dispersionWgsl = this.context.store.getSource(
            dispersionWgslModule,
        );
        const clearcoatLoader = this.context.store.getSource(
            clearcoatLoaderModule,
        );
        const sheenLoader = this.context.store.getSource(
            sheenLoaderModule,
        );
        const iridescenceLoader = this.context.store.getSource(
            iridescenceLoaderModule,
        );
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
            [iblSkybox, "let skyboxAlphaG = max(roughness * roughness, 0.000001)", "PBR skybox LOD alphaG"],
            [refraction, "let rd=refract(-V,N,material.refractionParams.y)", "scene-color refraction ray"],
            [refraction, "let ab=exp(material.volumeParams.rgb*th)", "Beer-Lambert attenuation"],
            [refraction, "colorSpecularEnvReflectance.rgb", "transmission Fresnel complement"],
            [dielectric, "((ior - 1) / (ior + 1)) ** 2 / 0.04", "glTF IOR Fresnel"],
            [transmissionFrameGraph, "updateTransmissionTexture(state, engine)", "scene-color copy ordering"],
            [sceneUniforms, "lodGenerationScale ?? 0.8", "environment LOD scale"],
            // The ground/skybox fragment *formulas* are no longer asserted
            // here: they are lifted from the modules' own literals, and the
            // lift throws naming the missing literal itself.
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
        if (options.morphStorage) {
            const morphCoreModule =
                "src/shader/fragments/morph-fragment-core.ts";
            const morphCore = this.context.store.getSource(morphCoreModule);
            const morphTargetsModule = "src/morph/create-morph-targets.ts";
            const morphTargets =
                this.context.store.getSource(morphTargetsModule);
            requiredUpstreamFormulas.push(
                [
                    morphCore,
                    "for (var i = 0u; i < morph.count; i = i + 1u)",
                    "storage morph accumulation loop",
                ],
                [
                    morphCore,
                    "let b = (i * morph.vertexCount + vertexIndex) * 6u;",
                    "storage morph delta indexing",
                ],
                [
                    morphCore,
                    "var<storage, read>",
                    "storage morph binding rewrite",
                ],
                [
                    morphTargets,
                    "MORPH_WEIGHTS_HEADER_BYTES = 16",
                    "morph weights header ABI",
                ],
            );
        }
        // The GridMaterial WGSL needs no marker rows: both stages are built
        // by evaluating the pinned template functions, which throws on any
        // shape the evaluator cannot fold.
        if (options.clearcoat) {
            requiredUpstreamFormulas.push(
                [
                    clearcoatFragment,
                    "return 0.25 / (VdotH_kl * VdotH_kl + 0.0000001);",
                    "clearcoat Kelemen visibility",
                ],
                [
                    clearcoatFragment,
                    "return f0 + (1.0 - f0) * (t2 * t2 * t);",
                    "clearcoat Schlick Fresnel",
                ],
                [
                    clearcoatFragment,
                    "ccDirectAttenuation = 1.0 - ccFresnel_dl * ccInt_dl;",
                    "clearcoat direct conservation",
                ],
                [
                    clearcoatFragment,
                    "let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;",
                    "clearcoat IBL conservation",
                ],
                [
                    clearcoatLoader,
                    "useF0Remap: false",
                    "glTF clearcoat F0 remap opt-out",
                ],
            );
        }
        if (options.sheen) {
            requiredUpstreamFormulas.push(
                [
                    sheenFragment,
                    "return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * 3.141592653589793);",
                    "sheen Charlie distribution",
                ],
                [
                    sheenFragment,
                    "return 1.0 / (4.0 * (NdotL_sh + NdotV_sh - NdotL_sh * NdotV_sh));",
                    "sheen Ashikhmin visibility",
                ],
                [
                    sheenFragment,
                    "sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;",
                    "sheen albedo scaling",
                ],
                [
                    sheenLoader,
                    "albedoScaling: true",
                    "glTF sheen albedo scaling",
                ],
            );
        }
        if (options.iridescence) {
            requiredUpstreamFormulas.push(
                [
                    iridescenceFragment,
                    "let opd=2.0*iridescenceIor*thickness*cosTheta2;",
                    "iridescence optical path difference",
                ],
                [
                    iridescenceFragment,
                    "colorF0=mix(colorF0,iriF0,iriIntensity);",
                    "iridescence base reflectance blend",
                ],
                [
                    iridescenceLoader,
                    "iridescenceThicknessMaximum ?? 400",
                    "glTF iridescence thickness range",
                ],
            );
        }
        if (options.dispersion) {
            requiredUpstreamFormulas.push(
                [
                    dispersionWgsl,
                    "let spread=0.04*material.volumeParams.w*(realIOR-1.0);",
                    "dispersion chromatic spread",
                ],
                [
                    dielectric,
                    "20.0 / dispersion",
                    "glTF dispersion Abbe mapping",
                ],
            );
        }
        for (const [source, formula, label] of requiredUpstreamFormulas) {
            if (!source.includes(formula)) {
                throw new Error(`Pinned Babylon Lite source is missing ${label}: ${formula}.`);
            }
            if (options.shaderPrograms.length > 0) {
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

        const result: Array<{ output: string; data: string }> = [];
        result.push({
            output: "upstream/shaders/pbr.vert.native.wgsl",
            data: materialVertexWgsl(
                options.gpuDeformation,
                options.gpuInstancing,
                options.morphStorage,
            ),
        });
        if (options.fog) {
            const unportedFogSurfaces: readonly (readonly [
                boolean | undefined,
                string,
            ])[] = [
                [options.gridMaterial, "GridMaterial"],
                [options.ground, "environment grounds"],
                [options.skybox, "environment skyboxes"],
                [options.transmission, "transmission"],
                [
                    options.geometryOutputTasks.length > 0,
                    "geometry outputs",
                ],
                [
                    options.shaderPrograms.length > 0,
                    "custom shader materials",
                ],
            ];
            for (const [reached, label] of unportedFogSurfaces) {
                if (reached) {
                    throw new Error(
                        `Scene fog is currently ported for PBR and Standard surfaces; ${label} with fog are not supported yet.`,
                    );
                }
            }
            // The falloff formula itself is not asserted here: every
            // consumer emits it through `fogFactorWgsl()`, which lifts the
            // pinned `WGSL_FOG` literal and throws if it changes shape.
        }
        if (options.ground) {
            const pinnedGround = readPinnedBackgroundGroundSource(
                this.context.store.packageRoot,
            );
            const groundProvenance = this.context.provenance(
                backgroundGroundModule,
                "buildBackgroundGroundRenderable",
                "the module's own groundFragSrc + WGSL_IMAGE_PROCESSING with shader/wgsl-helpers.ts WGSL_DITHER/WGSL_NO_DITHER",
            );
            // Both variants carry the pin's fragment; the pin itself selects
            // noise by composing WGSL_DITHER or WGSL_NO_DITHER in front of
            // the same body, so the undithered file is the pin's zero-noise
            // arm rather than an edited body. The PALs load the dithered
            // file for the ground, as upstream's enableNoise default does.
            result.push({
                output:
                    "upstream/shaders/background-ground.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(
                    groundProvenance,
                    pinnedGround,
                ),
            });
            result.push({
                output:
                    "upstream/shaders/background-ground-dither.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(
                    groundProvenance,
                    pinnedGround,
                    true,
                ),
            });
        }
        if (options.skybox) {
            const pinnedSkybox = readPinnedBackgroundSkyboxSource(
                this.context.store.packageRoot,
            );
            const skyboxProvenance = this.context.provenance(
                backgroundDdsModule,
                "buildDdsSkyboxRenderable",
                `${backgroundHdrModule}#buildHdrSkyboxRenderable, the modules' own ddsSkyboxFragSrc/skyboxHdrFragSrc with shader/wgsl-helpers.ts WGSL_DITHER`,
            );
            // One file per pinned arm, under the names the PALs select
            // between on `skybox_uses_environment`: the undithered file is
            // the environment-cubemap (HDR) fragment — the pin composes no
            // dither for it — and the dithered file is the DDS fragment,
            // whose image-processing block is the pin's own single
            // high-contrast arm.
            result.push({
                output:
                    "upstream/shaders/background-skybox.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(
                    skyboxProvenance,
                    pinnedSkybox,
                ),
            });
            result.push({
                output:
                    "upstream/shaders/background-skybox-dither.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(
                    skyboxProvenance,
                    pinnedSkybox,
                    true,
                ),
            });
        }
        if (options.solidSkybox) {
            const pinned = this.pinnedSolidSkyboxSource();
            this.context.functionDeclaration(
                backgroundSolidModule,
                "buildSolidSkyboxRenderable",
            );
            const provenance = this.context.provenance(
                backgroundSolidModule,
                "buildSolidSkyboxRenderable",
                "shaders/skybox.vertex.wgsl and the module's own skyboxFragSrc",
            );
            result.push(
                {
                    output:
                        "upstream/shaders/solid-skybox.vert.native.wgsl",
                    data: solidSkyboxVertexWgsl(provenance, pinned),
                },
                {
                    output:
                        "upstream/shaders/solid-skybox.frag.native.wgsl",
                    data: solidSkyboxFragmentWgsl(provenance, pinned),
                },
            );
        }
        if (options.imageSkybox) {
            // The skybox-cubemap WGSL ships as inlined string literals
            // in the compiled module (raw imports carry no source-map
            // entry), so the pinned contract is asserted against the
            // packaged text like the compiled scene-uniform WGSL.
            const imageSkyboxSource = readFileSync(
                resolve(
                    this.context.store.packageRoot,
                    "lib/material/standard/skybox-cubemap.js",
                ),
                "utf8",
            );
            for (const marker of [
                "let e=normalize(b.vPositionLocal);",
                "textureSample(c,d,e)",
                "if (scene.vFogInfos.x>0.0){let f=calcFogFactor(b.vFogDistance);",
                "mix(scene.vFogColor.rgb,a.rgb,f)",
                "a.vFogDistance=(scene.view*b).xyz;",
            ]) {
                if (!imageSkyboxSource.includes(marker)) {
                    throw new Error(
                        `Pinned Babylon Lite skybox-cubemap contract changed: ${marker}`,
                    );
                }
            }
            const imageSkyboxProvenance =
                this.context.provenance(
                    skyboxCubemapModule,
                    "buildSkyboxCubeMapGPU",
                    `${fogWgslModule}#WGSL_FOG`,
                );
            result.push(
                {
                    output:
                        "upstream/shaders/skybox-cubemap.vert.native.wgsl",
                    data: `// ${imageSkyboxProvenance}
struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) localPosition: vec3<f32>,
}

@vertex
fn mainVertex(@location(0) position: vec3<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.position =
        uniforms.viewProjection * vec4<f32>(position, 1.0);
    output.worldPosition = position;
    output.localPosition = position;
    return output;
}
`,
                },
                {
                    output:
                        "upstream/shaders/skybox-cubemap.frag.native.wgsl",
                    data: `// ${imageSkyboxProvenance}
@group(2) @binding(0) var skyboxTexture: texture_cube<f32>;
@group(2) @binding(1) var skyboxSampler: sampler;

struct FragmentUniforms {
    cameraPosition: vec4<f32>,
    viewRight: vec4<f32>,
    viewUp: vec4<f32>,
    viewForward: vec4<f32>,
    fogInfos: vec4<f32>,
    fogColor: vec4<f32>,
}
@group(3) @binding(0) var<uniform> uniforms: FragmentUniforms;

${fogFactorWgsl()}
struct FragmentInput {
    // D3D12 links vertex and fragment signatures by hardware register,
    // so the fragment must consume the position builtin to keep the
    // varying registers aligned with the shared vertex outputs.
    @builtin(position) position: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) localPosition: vec3<f32>,
}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let direction = normalize(input.localPosition);
    var color = textureSample(
        skyboxTexture,
        skyboxSampler,
        direction,
    );
    if (uniforms.fogInfos.x > 0.0) {
        let fogView =
            input.worldPosition - uniforms.cameraPosition.xyz;
        let fog = bblCalcFogFactor(vec3<f32>(
            dot(uniforms.viewRight.xyz, fogView),
            dot(uniforms.viewUp.xyz, fogView),
            dot(uniforms.viewForward.xyz, fogView),
        ));
        color = vec4<f32>(
            mix(uniforms.fogColor.xyz, color.rgb, fog),
            color.a,
        );
    }
    return color;
}
`,
                },
            );
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
                {
                    output:
                        "upstream/shaders/image-processing-ms.frag.native.wgsl",
                    data: imageProcessingMultisampledFragmentWgsl(),
                },
            );
        }
        if (options.gridMaterial) {
            const provenance = this.context.provenance(
                gridModule,
                "createGridMaterial",
            );
            const gridSource = this.context.sourceFile(gridModule);
            result.push(
                {
                    output: "upstream/shaders/grid.vert.native.wgsl",
                    data: gridVertexWgsl(provenance, gridSource),
                },
                {
                    output: "upstream/shaders/grid.frag.native.wgsl",
                    data: gridFragmentWgsl(provenance, gridSource),
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
        const sceneUniformsWgsl = options.shaderPrograms.length > 0
            ? this.compiledSceneUniformsWgsl()
            : "";
        for (const source of options.shaderPrograms) {
            const name = source.name;
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
        return result;
    }

    public compiledSceneUniformsWgsl(): string {
        const path = resolve(
            this.context.store.packageRoot,
            "lib/shader/scene-uniforms.js",
        );
        const file = ts.createSourceFile(
            path,
            readFileSync(path, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );
        const initializer =
            this.context.unwrapExpression(
                this.context.variableInitializer(
                    file,
                    "sceneUniformsWgsl",
                ),
            );
        if (
            !ts.isStringLiteral(initializer) &&
            !ts.isNoSubstitutionTemplateLiteral(initializer)
        ) {
            this.context.contractError(
                initializer,
                "Expected compiled scene-uniform WGSL text.",
            );
        }
        return initializer.text;
    }

    public shaderMaterialReflections(
        programs: CompiledShaderProgram[],
    ): ShaderProgramReflection[] {
        return programs.map(
            (program) =>
                lowerWgslShaderProgram(program).reflection,
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
        const clearcoatFragment = this.context.store.getSource(
            clearcoatFragmentModule,
        );
        const sheenFragment = this.context.store.getSource(
            sheenFragmentModule,
        );
        const iridescenceFragment = this.context.store.getSource(
            iridescenceFragmentModule,
        );
        const dispersionWgsl = this.context.store.getSource(
            dispersionWgslModule,
        );
        const transmissionFrameGraph = this.context.store.getSource(
            transmissionFrameGraphModule,
        );
        const clearcoatLoader = this.context.store.getSource(
            clearcoatLoaderModule,
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
                iblSkybox,
                "let skyboxAlphaG = max(roughness * roughness, 0.000001)",
                "PBR skybox LOD alphaG",
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
            [
                clearcoatFragment,
                "let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;",
                "clearcoat energy conservation",
            ],
            [
                clearcoatFragment,
                "colorF0 = mix(colorF0, remappedF0, ccInt_r);",
                "clearcoat base F0 remap",
            ],
            [
                clearcoatFragment,
                "return saturate((num / den) * (num / den));",
                "clearcoat F0 remap interface term",
            ],
            [
                clearcoatLoader,
                "useF0Remap: false",
                "glTF clearcoat F0 remap opt-out",
            ],
            [
                sheenFragment,
                "sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;",
                "sheen albedo scaling",
            ],
            [
                iridescenceFragment,
                "let opd=2.0*iridescenceIor*thickness*cosTheta2;",
                "iridescence optical path difference",
            ],
            [
                dispersionWgsl,
                "let spread=0.04*material.volumeParams.w*(realIOR-1.0);",
                "dispersion chromatic spread",
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
                        "Skybox-mode PBR materials sample the environment along the camera-to-fragment ray with a dedicated unbiased skyboxAlphaG LOD and omit diffuse irradiance.",
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
                    id: "clearcoat-layer",
                    upstreamModule: clearcoatFragmentModule,
                    upstreamMarker:
                        "let ccConservation_ibl = 1.0 - ccFresnelIBL * ccInt_ibl;",
                    nativeBehavior:
                        "KHR_materials_clearcoat adds a GGX/Kelemen direct lobe and a Jones analytical IBL lobe, attenuates the base layer by 1-F(ccF0)*intensity, and keeps the glTF loader's disabled F0 remap.",
                    validation: [
                        "source marker assertion",
                        "scene 28 GPU parity",
                    ],
                },
                {
                    id: "sheen-layer",
                    upstreamModule: sheenFragmentModule,
                    upstreamMarker:
                        "sheenAlbedoScaling = 1.0 - shMax * shBrdf.b;",
                    nativeBehavior:
                        "KHR_materials_sheen uses the Charlie distribution with Ashikhmin visibility, samples the BRDF LUT blue channel at sheen roughness, and scales the base layer by 1-maxSheenColor*brdf.b.",
                    validation: [
                        "source marker assertion",
                        "scene 29 GPU parity",
                    ],
                },
                {
                    id: "iridescence-thin-film",
                    upstreamModule: iridescenceFragmentModule,
                    upstreamMarker:
                        "let opd=2.0*iridescenceIor*thickness*cosTheta2;",
                    nativeBehavior:
                        "KHR_materials_iridescence evaluates Babylon's thin-film airy summation in XYZ and blends the result into base F0 by the iridescence intensity.",
                    validation: [
                        "source marker assertion",
                        "scene 178 GPU parity",
                    ],
                },
                {
                    id: "dispersion-chromatic-refraction",
                    upstreamModule: dispersionWgslModule,
                    upstreamMarker:
                        "let spread=0.04*material.volumeParams.w*(realIOR-1.0);",
                    nativeBehavior:
                        "KHR_materials_dispersion splits the refracted scene-color ray into per-RGB etas using Babylon's 20/dispersion Abbe strength.",
                    validation: [
                        "source marker assertion",
                        "scene 212 GPU parity",
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
                    validation: ["source marker assertions", "Scene 1 diagnostics"],
                },
                {
                    id: "ibl-specular-occlusion",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "let seo = clamp",
                    nativeBehavior: "Specular environment reflectance uses Babylon's NdotV and ambient-occlusion polynomial.",
                    validation: ["source marker assertions", "Scene 1 diagnostics"],
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
                    validation: ["source marker assertions", "Scene 1 reflectivity diagnostics"],
                },
                {
                    id: "environment-cubemap-orientation",
                    upstreamModule: iblFragmentModule,
                    upstreamMarker: "let R = rotateY(R_raw",
                    nativeBehavior: "Reflection and irradiance directions use Babylon's Y-axis environment rotation before cubemap sampling.",
                    validation: ["source marker assertions", "Scenes 1 and 8 parity"],
                },
                {
                    id: "rgbd-cubemap-y-flip",
                    upstreamModule: rgbdDecodeModule,
                    upstreamMarker: "select(g.y,d.y-1u-g.y,f)",
                    nativeBehavior: "RGBD cubemap rows are vertically reversed during SDL_GPU upload.",
                    validation: ["source marker assertion", "Scene 1 foreground parity"],
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
                {
                    id: "solid-skybox",
                    upstreamModule: backgroundSolidModule,
                    upstreamMarker: "buildSolidSkyboxRenderable",
                    nativeBehavior: "The clear-colour skybox an .env scene reaches without a DDS or HDR skybox is drawn as the pin's own cube, with its infinite-distance vertex stage and unconditional dither taken from the packaged WGSL.",
                    validation: ["packaged WGSL extraction", "scene 7 background attribution"],
                },
            ],
        };
    }

    /**
     * The solid skybox's two WGSL stages ship as `?raw` string literals with no
     * source-map entry, so they are read out of the packaged module text — the
     * vertex stage from the shared chunk `background-solid-skybox.js` imports,
     * which keeps the pin's content hash out of this file.
     */
    private pinnedSolidSkyboxSource(): PinnedSolidSkyboxSource {
        const packageRoot = this.context.store.packageRoot;
        const modulePath = resolve(
            packageRoot,
            "lib/material/pbr/background-solid-skybox.js",
        );
        const module = readFileSync(modulePath, "utf8");
        const chunk =
            /import \{ s as skyboxVertSrc \} from '(\.\.\/\.\.\/_chunks\/[^']+)'/.exec(
                module,
            );
        if (!chunk) {
            throw new Error(
                "Pinned Babylon Lite solid skybox no longer imports the shared skybox vertex chunk.",
            );
        }
        const vertexModule = readFileSync(
            resolve(packageRoot, "lib/material/pbr", chunk[1]!),
            "utf8",
        );
        return {
            vertex: rawWgslLiteral(vertexModule, "skyboxVertSrc"),
            fragment: rawWgslLiteral(module, "skyboxFragSrc"),
            sceneUniforms: this.compiledSceneUniformsWgsl(),
            dither: readPinnedDitherWgsl(packageRoot).dither,
        };
    }
}

/**
 * Read one `const <name> = "...";` WGSL literal out of a packaged module. The
 * bundler emits these as single-line double-quoted JavaScript strings, so the
 * value is recovered by scanning to the closing quote and parsing it as JSON
 * rather than by a regex that would have to model every escape.
 */
function rawWgslLiteral(source: string, name: string): string {
    const marker = `const ${name} = "`;
    const start = source.indexOf(marker);
    if (start < 0) {
        throw new Error(
            `Pinned Babylon Lite WGSL literal '${name}' was not found.`,
        );
    }
    let index = start + marker.length;
    let escaped = "";
    while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") {
            escaped += source[index]! + (source[index + 1] ?? "");
            index += 2;
            continue;
        }
        escaped += source[index];
        index += 1;
    }
    if (index >= source.length) {
        throw new Error(
            `Pinned Babylon Lite WGSL literal '${name}' is unterminated.`,
        );
    }
    return JSON.parse(`"${escaped}"`) as string;
}
