import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
} from "../shader-builtins-utility.js";
import {
    backgroundGroundFragmentWgsl,
    backgroundSkyboxFragmentWgsl,
} from "../shader-builtins-background.js";
import { materialVertexWgsl } from "../shader-builtins-material.js";
import { applyMaterialExtensionWgsl } from "../shader-builtins-material-extensions.js";
import { standardFragmentWgsl } from "../shader-builtins-standard.js";
import { pbrFragmentWgsl } from "../shader-builtins-pbr.js";
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

function uvTransformName(slot: string): string {
    return `bblUv${slot.charAt(0).toUpperCase()}${slot.slice(1)}`;
}

function replaceUvTransformMarker(
    source: string,
    marker: RegExp,
    replacement: string,
    label: string,
): string {
    if (!marker.test(source)) {
        throw new Error(`PBR UV transform marker changed: ${label}.`);
    }
    return source.replace(marker, () => replacement);
}

/**
 * Give every texture sample its own UV. Babylon Lite computes each slot's UV
 * from that slot's own matrix and offset (`txfUV` in the composed fragment), so
 * one material can rotate its normal map while its thickness map rotates the
 * other way. Applied after the material-extension fragments are composed, since
 * their samples are slots too.
 */
function applyPbrUvTransformWgsl(
    source: string,
    slots: ReadonlyArray<{ wgsl: string; cpp: string }>,
): string {
    const reached = new Set(slots.map((slot) => slot.wgsl));
    let result = replaceUvTransformMarker(
        source,
        /  imageProcessingOptions : vec4<f32>,/,
        "  imageProcessingOptions : vec4<f32>,\n" +
            slots
                .map(
                    (slot) =>
                        `  ${slot.wgsl}UVm : vec4<f32>,\n` +
                        `  ${slot.wgsl}UVt : vec4<f32>,`,
                )
                .join("\n"),
        "uniform block",
    );
    const declarations = slots
        .map(
            (slot) =>
                `  let ${uvTransformName(slot.wgsl)} = bblTxfUv(v_4, ` +
                `FragmentUniforms.${slot.wgsl}UVm, ` +
                `FragmentUniforms.${slot.wgsl}UVt.xy);`,
        )
        .join("\n");
    const signature = /fn main_inner\(([^)]*)\) \{/;
    const signatureMatch = signature.exec(result);
    if (!signatureMatch) {
        throw new Error("PBR UV transform marker changed: main_inner signature.");
    }
    result = result.replace(
        signature,
        () =>
            "fn bblTxfUv(uv : vec2<f32>, m : vec4<f32>, t : vec2<f32>) -> vec2<f32> {\n" +
            "  return vec2<f32>(dot(m.xy, uv), dot(m.zw, uv)) + t;\n" +
            "}\n\n" +
            `${signatureMatch[0]}\n${declarations}`,
    );
    // Each site names the slot whose transform it must sample at. The
    // derivative pairs belong to the normal-map slots: the cotangent frame is
    // built from the UV the normal map is sampled at.
    const sites: Array<{ slot: string; marker: RegExp; replacement: string }> = [
        {
            slot: "normal",
            marker: /textureSample\(normalTexture, normalSampler, v_4\)/,
            replacement: "textureSample(normalTexture, normalSampler, bblUvNormal)",
        },
        {
            slot: "normal",
            marker: /      let v_13 = dpdx\(v_4\);\r?\n      let v_14 = dpdy\(v_4\);/,
            replacement:
                "      let v_13 = dpdx(bblUvNormal);\n" +
                "      let v_14 = dpdy(bblUvNormal);",
        },
        {
            slot: "baseColor",
            marker: /textureSample\(baseColorTexture, baseColorSampler, v_4\)/,
            replacement:
                "textureSample(baseColorTexture, baseColorSampler, bblUvBaseColor)",
        },
        {
            slot: "orm",
            marker: /textureSample\(metallicRoughnessTexture, metallicRoughnessSampler, v_4\)/,
            replacement:
                "textureSample(metallicRoughnessTexture, metallicRoughnessSampler, bblUvOrm)",
        },
        // The emissive slot is deliberately absent. Its transform is parsed,
        // animated and uploaded like every other slot, but the pinned
        // fragment never samples through it: createEmissiveColorFragment
        // hardcodes `textureSample(emissiveTexture,emissiveSampler,input.uv)`,
        // and the composed shader an instrumented capture recovers computes
        // `emissiveUV` on the line above and then ignores it. Rewriting the
        // sample to the transformed UV made Scene 39's water scroll its
        // emissive texture where the browser holds it still.
        {
            slot: "refractionMap",
            marker: /      transmissionSampler,\r?\n      v_4,/,
            replacement: "      transmissionSampler,\n      bblUvRefractionMap,",
        },
        {
            slot: "thickness",
            marker: /      thicknessSampler,\r?\n      v_4,/,
            replacement: "      thicknessSampler,\n      bblUvThickness,",
        },
        {
            slot: "clearcoat",
            marker: /textureSample\(clearcoatTexture, clearcoatSampler, v_4\)/,
            replacement:
                "textureSample(clearcoatTexture, clearcoatSampler, bblUvClearcoat)",
        },
        {
            slot: "clearcoatRoughness",
            marker: /        clearcoatRoughnessSampler,\r?\n        v_4\)/,
            replacement:
                "        clearcoatRoughnessSampler,\n        bblUvClearcoatRoughness)",
        },
        {
            slot: "clearcoatNormal",
            marker: /  let cc_duv1 = dpdx\(v_4\);\r?\n  let cc_duv2 = dpdy\(v_4\);/,
            replacement:
                "  let cc_duv1 = dpdx(bblUvClearcoatNormal);\n" +
                "  let cc_duv2 = dpdy(bblUvClearcoatNormal);",
        },
        {
            slot: "clearcoatNormal",
            marker: /textureSample\(clearcoatNormalTexture, clearcoatNormalSampler, v_4\)/,
            replacement:
                "textureSample(clearcoatNormalTexture, clearcoatNormalSampler, bblUvClearcoatNormal)",
        },
        {
            slot: "sheen",
            marker: /textureSample\(sheenColorTexture, sheenColorSampler, v_4\)/,
            replacement:
                "textureSample(sheenColorTexture, sheenColorSampler, bblUvSheen)",
        },
        {
            slot: "sheenRoughness",
            marker: /textureSample\(sheenRoughnessTexture, sheenRoughnessSampler, v_4\)/,
            replacement:
                "textureSample(sheenRoughnessTexture, sheenRoughnessSampler, bblUvSheenRoughness)",
        },
        {
            slot: "iridescence",
            marker: /textureSample\(iridescenceTexture, iridescenceSampler, v_4\)/,
            replacement:
                "textureSample(iridescenceTexture, iridescenceSampler, bblUvIridescence)",
        },
        {
            slot: "iridescenceThickness",
            marker: /          iridescenceThicknessSampler,\r?\n          v_4\)/,
            replacement:
                "          iridescenceThicknessSampler,\n          bblUvIridescenceThickness)",
        },
    ];
    for (const site of sites) {
        if (!reached.has(site.slot)) continue;
        result = replaceUvTransformMarker(
            result,
            site.marker,
            site.replacement,
            `${site.slot} sample`,
        );
    }
    return result;
}

/**
 * Scale and tint the dielectric reflectance the way the pinned reflectance
 * fragment does. Its F0 block reads
 *
 *   dielectricF0 = reflectance * metallicF0Factor
 *   colorF0      = mix(vec3(dielectricF0) * metallicReflectanceColor,
 *                      baseColor, metallic)
 *   colorF90     = vec3(mix(specularWeight, 1.0, metallic))
 *   surfaceAlbedo = baseColor
 *                 * (1 - dielectricF0 * metallicReflectanceColor)
 *                 * (1 - metallic)
 *
 * which is the base template's own composition once the factor is one, the
 * weight is one and the tint is white — so the emitted branch is a
 * generalization of what it replaces rather than a second path.
 */
function applyPbrReflectanceWgsl(source: string): string {
    let result = replaceUvTransformMarker(
        source,
        /  imageProcessingOptions : vec4<f32>,/,
        "  imageProcessingOptions : vec4<f32>,\n" +
            "  reflectanceFactors : vec4<f32>,\n" +
            "  metallicReflectanceColor : vec4<f32>,",
        "reflectance uniform block",
    );
    result = replaceUvTransformMarker(
        result,
        /  let v_51 = FragmentUniforms\.normalOptions\.z;\r?\n  let v_52 = \(\(v_31 \* \(1\.0f - v_51\)\) \* \(1\.0f - v_36\)\);/,
        "  let bblSurfaceReflectivityColor = FragmentUniforms.metallicReflectanceColor.xyz;\n" +
            "  let v_51 = FragmentUniforms.normalOptions.z * FragmentUniforms.reflectanceFactors.x;\n" +
            "  let v_52 = ((v_31 * (vec3<f32>(1.0f) - (vec3<f32>(v_51) * bblSurfaceReflectivityColor))) * (1.0f - v_36));",
        "dielectric F0 and surface albedo",
    );
    result = replaceUvTransformMarker(
        result,
        /  let v_75 = mix\(vec3<f32>\(v_51, v_51, v_51\), v_31, vec3<f32>\(v_36, v_36, v_36\)\);\r?\n  let v_76 = \(vec3<f32>\(1\.0f\) - v_75\);/,
        "  let v_75 = mix((vec3<f32>(v_51, v_51, v_51) * bblSurfaceReflectivityColor), v_31, vec3<f32>(v_36, v_36, v_36));\n" +
            "  let v_76 = (vec3<f32>(mix(FragmentUniforms.reflectanceFactors.y, 1.0f, v_36)) - v_75);",
        "colorF0 and colorF90",
    );
    return result;
}

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
const pbrFogWgslModule = "src/material/pbr/pbr-fog-wgsl.ts";
const skyboxCubemapModule =
    "src/material/standard/skybox-cubemap.ts";
const orthoMatrixModule = "src/math/mat4-ortho-lh-to-ref.ts";
const standardVertexColorFragmentModule =
    "src/material/standard/fragments/std-vertex-color-fragment.ts";
const standardRenderableModule =
    "src/material/standard/standard-renderable.ts";
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

    public lowerRenderPlan(options: {
        transmission?: boolean;
        fog?: boolean;
        imageSkybox?: boolean;
        textureTransform?: boolean;
        materialSpecular?: boolean;
        occlusionUv2?: boolean;
        environmentRotation?: boolean;
        gpuInstancing?: boolean;
        multiLight?: boolean;
        clearcoat?: boolean;
        sheen?: boolean;
        sheenAlbedoScaling?: boolean;
        iridescence?: boolean;
        dispersion?: boolean;
        nodeVisibility?: boolean;
        standardLights?: number;
        standardLightLists?: boolean;
        standardDiffuseUv2?: boolean;
        standardBump?: boolean;
        standardSpotLights?: boolean;
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
        if (
            options.standardBump &&
            (options.transmission === true ||
                options.clearcoat === true ||
                options.sheen === true ||
                options.iridescence === true)
        ) {
            // The Standard bump pair appends after every PBR texture pair,
            // so its binding index is 12 only while none of those pairs
            // exist. A scene composing both would need the index computed
            // in the fragment rather than fixed, and none reaches it.
            throw new Error(
                "Standard bump mapping is lowered only for scenes without transmission or PBR material-extension textures.",
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
        // One uniform slot per Standard light the scene's assets carry,
        // never fewer than the two this block has always emitted.
        const standardLightSlots = Math.max(
            2,
            options.standardLights ?? 2,
        );
        const extraStandardLights = Array.from(
            { length: standardLightSlots - 2 },
            (_, index) => index + 3,
        );
        // Which slots hold a light is normally read off `light_direction.w`,
        // which every written light sets to one and an untouched slot leaves
        // at zero. A spot cone needs that component for its cosine, so a
        // scene reaching one tags the empty slots in the kind component
        // instead: the pinned kinds are 0 point, 1 directional, 2 spot and
        // 3 hemispheric, and -1 is none of them.
        const emptyLightData = options.standardSpotLights
            ? "{0.0f, 0.0f, 0.0f, -1.0f}"
            : "{}";
        const standardPositionalLight = options.standardSpotLights
            ? "positional"
            : "light.kind == LightKind::point";
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
            options.multiLight
                ? `    std::array<std::array<float, 4>, 7> extra_light_positions{};
    std::array<std::array<float, 4>, 7> extra_light_colors{};
    std::array<std::array<float, 4>, 7> extra_light_directions{};
`
                : "";
        // Under multi-light the extras loop owns every light past the
        // primary slot, so the second analytic slot stays disabled to
        // avoid double-counting scene.lights[1].
        const secondAnalyticLightFill =
            options.multiLight
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
            options.multiLight
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

struct StandardUniforms {
    std::array<float, 4> camera_position{};
    std::array<float, 4> camera_forward_near{};
    std::array<float, 4> view_right{};
    std::array<float, 4> view_up{};
    std::array<float, 4> view_forward{};
    std::array<float, 4> light_data${emptyLightData};
    std::array<float, 4> light_diffuse{};
    std::array<float, 4> light_specular{};
    std::array<float, 4> light_direction{};
    std::array<float, 4> light_data_2${emptyLightData};
    std::array<float, 4> light_diffuse_2{};
    std::array<float, 4> light_specular_2{};
    std::array<float, 4> light_direction_2{};${extraStandardLights.map((slot) => `
    std::array<float, 4> light_data_${slot}${emptyLightData};
    std::array<float, 4> light_diffuse_${slot}{};
    std::array<float, 4> light_specular_${slot}{};
    std::array<float, 4> light_direction_${slot}{};`).join("")}
    std::array<float, 4> diffuse_alpha{};
    std::array<float, 4> specular_power{};
    std::array<float, 4> emissive_level{};
    std::array<float, 4> ambient_level{};
    std::array<float, 4> texture_options{};
    std::array<float, 4> uv_options{};
    std::array<float, 4> material_options{};
    std::array<float, 4> reflection_options{};${options.standardDiffuseUv2 ? `
    std::array<float, 4> diffuse_uv_options{};` : ""}${options.standardBump ? `
    std::array<float, 4> bump_options{};` : ""}
${fogUniformFields}\
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
std::array<float, 16> build_view_projection(
    const CameraRecord& camera,
    float aspect,
    bool reverse_depth = false);
std::array<float, 16> build_skybox_view_projection(
    const CameraRecord& camera,
    float aspect);
${options.gpuInstancing
    ? `std::array<float, 16> build_instance_parent_world(
    const MeshRecord& mesh);
`
    : ""}\
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
CameraBasis camera_basis(const CameraRecord& camera) {
    const Vec3 eye = arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    const Vec3 right = normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, forward));
    return CameraBasis{eye, forward, right, cross(forward, right)};
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
    float aspect,
    bool reverse_depth) {
    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
    const Vec3& right = basis.right;
    const Vec3& up = basis.up;
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
        return multiply(projection, view);
    }
`
    : ""}\
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
    // A skybox follows the camera, so this view keeps the rotation and
    // drops the eye translation the other builders apply.
    const CameraBasis basis = camera_basis(camera);
    const Vec3& forward = basis.forward;
    const Vec3& right = basis.right;
    const Vec3& up = basis.up;
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

StandardUniforms build_standard_uniforms(
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const RenderItem& item) {
    StandardUniforms result;
    const CameraBasis basis = camera_basis(camera);
    const Vec3& eye = basis.eye;
    const Vec3& forward = basis.forward;
    const Vec3& right = basis.right;
    const Vec3& up = basis.up;
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
${fogUniforms}\
    if (scene.lights.size() > ${standardLightSlots}) {
        throw std::runtime_error(
            "Reached Standard material supports at most ${standardLightSlots} lights.");
    }
    const auto write_light =
        [](
            const LightRecord& light,
            std::array<float, 4>& light_data,
            std::array<float, 4>& light_diffuse,
            std::array<float, 4>& light_specular,
            std::array<float, 4>& light_direction) {${options.standardSpotLights ? `
        // A spot is positional like a point light and directional like a
        // directional one: it packs its position in the data slot and its
        // cone axis in the direction slot.
        const bool positional =
            light.kind == LightKind::point ||
            light.kind == LightKind::spot;` : ""}
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
        light_data = {
            ${standardPositionalLight}
                ? light.position.x
                : direction.x,
            ${standardPositionalLight}
                ? light.position.y
                : direction.y,
            ${standardPositionalLight}
                ? light.position.z
                : direction.z,
            light.kind == LightKind::hemispheric
                ? 3.0f
                : light.kind == LightKind::directional
                    ? 1.0f
                    : ${options.standardSpotLights ? `light.kind == LightKind::spot
                        ? 2.0f
                        : 0.0f` : "0.0f"},
        };
        light_diffuse = {
            light.diffuse_color.r * light.intensity,
            light.diffuse_color.g * light.intensity,
            light.diffuse_color.b * light.intensity,
            ${standardPositionalLight} ? light.range : 0.0f,
        };
        light_specular = {
            light.specular_color.r * light.intensity,
            light.specular_color.g * light.intensity,
            light.specular_color.b * light.intensity,
            ${options.standardSpotLights ? `light.kind == LightKind::spot
                ? light.exponent
                : 0.0f` : "0.0f"},
        };
        light_direction = {
            light.kind == LightKind::hemispheric
                ? light.ground_color.r
                : direction.x,
            light.kind == LightKind::hemispheric
                ? light.ground_color.g
                : direction.y,
            light.kind == LightKind::hemispheric
                ? light.ground_color.b
                : direction.z,
            ${options.standardSpotLights ? `light.kind == LightKind::spot
                ? light.cos_half_angle
                : 1.0f` : "1.0f"},
        };
    };
${options.standardLightLists ? `    // A light can name the meshes it applies to, so the slots hold this
    // mesh's light set rather than the scene's. That is the same set the
    // pinned template's \`min(mesh.lc, MAX_LIGHTS)\` loop walks.
    std::uint32_t light_slot = 0;
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size()) continue;
        const LightRecord& light = engine.lights[handle.value];
        const bool applies = light.included_meshes.empty()
            ? std::find(
                  light.excluded_meshes.begin(),
                  light.excluded_meshes.end(),
                  item.mesh.value) == light.excluded_meshes.end()
            : std::find(
                  light.included_meshes.begin(),
                  light.included_meshes.end(),
                  item.mesh.value) != light.included_meshes.end();
        if (!applies) continue;
        switch (light_slot) {
            case 0:
                write_light(
                    light,
                    result.light_data,
                    result.light_diffuse,
                    result.light_specular,
                    result.light_direction);
                break;
            case 1:
                write_light(
                    light,
                    result.light_data_2,
                    result.light_diffuse_2,
                    result.light_specular_2,
                    result.light_direction_2);
                break;${extraStandardLights.map((slot) => `
            case ${slot - 1}:
                write_light(
                    light,
                    result.light_data_${slot},
                    result.light_diffuse_${slot},
                    result.light_specular_${slot},
                    result.light_direction_${slot});
                break;`).join("")}
            default:
                break;
        }
        ++light_slot;
        if (light_slot >= ${standardLightSlots}u) break;
    }` : `    if (
        !scene.lights.empty() &&
        scene.lights[0].value < engine.lights.size()) {
        write_light(
            engine.lights[scene.lights[0].value],
            result.light_data,
            result.light_diffuse,
            result.light_specular,
            result.light_direction);
    }`}${options.standardLightLists ? "" : `
    if (
        scene.lights.size() > 1 &&
        scene.lights[1].value < engine.lights.size()) {
        write_light(
            engine.lights[scene.lights[1].value],
            result.light_data_2,
            result.light_diffuse_2,
            result.light_specular_2,
            result.light_direction_2);
    }${extraStandardLights.map((slot) => `
    if (
        scene.lights.size() > ${slot - 1} &&
        scene.lights[${slot - 1}].value < engine.lights.size()) {
        write_light(
            engine.lights[scene.lights[${slot - 1}].value],
            result.light_data_${slot},
            result.light_diffuse_${slot},
            result.light_specular_${slot},
            result.light_direction_${slot});
    }`).join("")}`}
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
        };${options.standardDiffuseUv2 ? `
        result.diffuse_uv_options = {
            static_cast<float>(material.diffuse_coord_index),
            0.0f,
            0.0f,
            0.0f,
        };` : ""}${options.standardBump ? `
        result.bump_options = {
            material.bump_scale,
            material.bump_texture.bytes.empty() ? 0.0f : 1.0f,
            0.0f,
            0.0f,
        };` : ""}
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
        transmission?: boolean;
        fog?: boolean;
        normalTextureScale?: boolean;
        shaderPrograms: CompiledShaderProgram[];
        standardMaterial: boolean;
        standardVertexColors?: boolean;
        standardLights?: number;
        standardDiffuseUv2?: boolean;
        standardBump?: boolean;
        standardSpotLights?: boolean;
        gridMaterial?: boolean;
        idDiagnostics: boolean;
        pbrDiagnostics: boolean;
        geometryOutputTasks: GeometryOutputTaskManifest[];
        frameGraph?: boolean;
        gpuDeformation?: boolean;
        morphStorage?: boolean;
        textureTransform?: boolean;
        environmentRotation?: boolean;
        gpuInstancing?: boolean;
        multiLight?: boolean;
        clearcoat?: boolean;
        sheen?: boolean;
        sheenAlbedoScaling?: boolean;
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
        standardMaterial: false,
        standardVertexColors: false,
        gridMaterial: false,
        idDiagnostics: true,
        pbrDiagnostics: true,
        geometryOutputTasks: [],
        gpuDeformation: false,
        morphStorage: false,
        textureTransform: false,
        environmentRotation: false,
        gpuInstancing: false,
        multiLight: false,
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
        if (
            options.standardMaterial &&
            standardTemplate.includes("@builtin(front_facing)")
        ) {
            throw new Error(
                "Pinned Standard double-sided normal semantics changed.",
            );
        }
        if (
            options.standardVertexColors &&
            options.geometryOutputTasks.length > 0
        ) {
            // standard-renderable.ts composes the vertex-colour fragment
            // for the geometry outputs too (its ALBEDO attachment writes
            // baseColor), but no reached scene combines them.
            throw new Error(
                "Standard vertex colors are lowered for the color fragment only; geometry outputs with vertex colors are not supported yet.",
            );
        }
        if (
            options.standardSpotLights &&
            options.geometryOutputTasks.length > 0
        ) {
            // The geometry fragments share the same lighting function, but
            // their slots keep the direction component as the occupied flag
            // the spot cone needs. No reached scene composes the two.
            throw new Error(
                "Standard spot lights are lowered for the color fragment only; geometry outputs with spot lights are not supported yet.",
            );
        }
        const gridModule = "src/material/grid/grid-material.ts";
        const gridMaterial = this.context.store.getSource(gridModule);
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
        if (options.standardSpotLights) {
            requiredUpstreamFormulas.push(
                [
                    standardTemplate,
                    "let c = max(0.0, dot(L.vLightDirection.xyz, -lv));",
                    "standard spot cone cosine",
                ],
                [
                    standardTemplate,
                    "if (c >= L.vLightDirection.w) { a *= max(0.0, pow(c, L.vLightSpecular.a)); } else { a = 0.0; }",
                    "standard spot cone falloff",
                ],
            );
        }
        if (options.standardVertexColors) {
            const standardVertexColorFragment =
                this.context.store.getSource(
                    standardVertexColorFragmentModule,
                );
            const standardRenderable =
                this.context.store.getSource(
                    standardRenderableModule,
                );
            requiredUpstreamFormulas.push(
                [
                    standardVertexColorFragment,
                    'let at = "baseColor *= input.vColor.rgb;"',
                    "standard vertex color base color",
                ],
                [
                    standardVertexColorFragment,
                    '_vertexSlots: { VB: "out.vColor = color;" }',
                    "standard vertex color passthrough",
                ],
                [
                    standardVertexColorFragment,
                    "if (hasVertexAlpha) {",
                    "standard vertex alpha opt-in",
                ],
                [
                    standardRenderable,
                    "const hasVertexColor = !!mesh._gpu.colorBuffer && !!_stdVertexColorFragment;",
                    "standard vertex color mesh condition",
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

        const sources: string[] = [];
        const result = sources.map((name) => ({
            output: `upstream/shaders/${name}`,
            data: readFileSync(resolve(templateRoot, name), "utf8"),
        }));
        result.push({
            output: "upstream/shaders/pbr.vert.native.wgsl",
            data: materialVertexWgsl(
                options.gpuDeformation,
                options.gpuInstancing,
                options.morphStorage,
            ),
        });
        // The template's directional branch and second analytic light
        // derive from the pinned single-light PBR block; assert the
        // upstream module still carries it.
        this.context.functionDeclaration(
            "src/material/pbr/fragments/singlelight-directional-wgsl.ts",
            "getSingleLightBlock",
        );
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
                "  let linearColor = select((((((((v_89 * v_52) * v_34) + v_101) + v_102) + ((((v_70 * v_52) * v_71) * v_81) * v_69)) + (bblExtraDiffuse + bblExtraSpecular)) + v_40), v_31, vec3<bool>(v_103, v_103, v_103));\n" +
                "  let v_104 = linearColor * FragmentUniforms.environmentFactors.x;\n" +
                convertedPbr.slice(transmissionEnd);
        }
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
                [options.pbrDiagnostics, "PBR diagnostics"],
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
            if (options.standardMaterial) {
                const stdFogSource = this.context.store.getSource(
                    "src/material/standard/std-fog-wgsl.ts",
                );
                for (const marker of [
                    "color = vec4<f32>(mix(scene.vFogColor.rgb, color.rgb, fog), color.a);",
                    'out.vf = (scene.view * vec4<f32>(out.vp, 1.0)).xyz;',
                    "let fog = calcFogFactor(input.vf);",
                ]) {
                    if (!stdFogSource.includes(marker)) {
                        throw new Error(
                            `Pinned Babylon Lite Standard fog blend changed: ${marker}`,
                        );
                    }
                }
            }
            const fogSource =
                this.context.store.getSource(fogWgslModule);
            for (const marker of [
                "const E_FOG: f32 = 2.71828;",
                "if (fogMode == 3.0) { fogCoeff = (fogEnd - dist) / (fogEnd - fogStart); }",
                "else if (fogMode == 1.0) { fogCoeff = 1.0 / pow(E_FOG, dist * fogDensity); }",
                "else if (fogMode == 2.0) { fogCoeff = 1.0 / pow(E_FOG, dist * dist * fogDensity * fogDensity); }",
            ]) {
                if (!fogSource.includes(marker)) {
                    throw new Error(
                        `Pinned Babylon Lite fog factor formula changed: ${marker}`,
                    );
                }
            }
            const pbrFogSource =
                this.context.store.getSource(pbrFogWgslModule);
            for (const marker of [
                "calcFogFactor((scene.view*vec4<f32>(input.worldPos,1.0)).xyz)",
                "fogFactor=pow(fogFactor,2.2)",
                "color=mix(pow(scene.vFogColor.rgb,vec3<f32>(2.2)),color,fogFactor)",
                "scene.vFogInfos.x>0.0",
            ]) {
                if (!pbrFogSource.includes(marker)) {
                    throw new Error(
                        `Pinned Babylon Lite PBR fog blend changed: ${marker}`,
                    );
                }
            }
            for (const marker of [
                "  imageProcessingOptions : vec4<f32>,",
                "@group(3u) @binding(0u) var<uniform> FragmentUniforms : S;",
                "  let v_104 = linearColor * FragmentUniforms.environmentFactors.x;",
                "    linearColor,\n    FragmentUniforms.imageProcessingOptions.x > 0.5f,",
            ]) {
                if (
                    !convertedPbr
                        .replaceAll("\r\n", "\n")
                        .includes(marker)
                ) {
                    throw new Error(
                        `PBR fog shader marker changed: ${marker}`,
                    );
                }
            }
            convertedPbr = convertedPbr.replace(
                /  imageProcessingOptions : vec4<f32>,/,
                "  imageProcessingOptions : vec4<f32>,\n" +
                    "  fogInfos : vec4<f32>,\n" +
                    "  fogColor : vec4<f32>,",
            );
            convertedPbr = convertedPbr.replace(
                "@group(3u) @binding(0u) var<uniform> FragmentUniforms : S;",
                `@group(3u) @binding(0u) var<uniform> FragmentUniforms : S;

// ${this.context.provenance(fogWgslModule, "WGSL_FOG", `${pbrFogWgslModule}#PBR_FOG_BLOCK`)}
const bblFogE : f32 = 2.71828f;

fn bblCalcFogFactor(fogDistance : vec3<f32>) -> f32 {
  var fogCoeff = 1.0f;
  let fogMode = FragmentUniforms.fogInfos.x;
  let fogStart = FragmentUniforms.fogInfos.y;
  let fogEnd = FragmentUniforms.fogInfos.z;
  let fogDensity = FragmentUniforms.fogInfos.w;
  let dist = length(fogDistance);
  if (fogMode == 3.0f) {
    fogCoeff = ((fogEnd - dist) / (fogEnd - fogStart));
  } else if (fogMode == 1.0f) {
    fogCoeff = (1.0f / pow(bblFogE, (dist * fogDensity)));
  } else if (fogMode == 2.0f) {
    fogCoeff = (1.0f / pow(bblFogE, (((dist * dist) * fogDensity) * fogDensity)));
  }
  return clamp(fogCoeff, 0.0f, 1.0f);
}`,
            );
            convertedPbr = convertedPbr.replace(
                /  let v_104 = linearColor \* FragmentUniforms\.environmentFactors\.x;/,
                `  var bblFoggedColor = linearColor;
  if ((FragmentUniforms.fogInfos.x > 0.0f)) {
    let bblFogView = (v_1 - FragmentUniforms.cameraPosition.xyz);
    var bblFogFactor = bblCalcFogFactor(vec3<f32>(
      dot(FragmentUniforms.viewRight.xyz, bblFogView),
      dot(FragmentUniforms.viewUp.xyz, bblFogView),
      dot(FragmentUniforms.viewForward.xyz, bblFogView),
    ));
    bblFogFactor = pow(bblFogFactor, 2.20000004768371582031f);
    bblFoggedColor = mix(
      pow(FragmentUniforms.fogColor.xyz, vec3<f32>(2.20000004768371582031f)),
      bblFoggedColor,
      vec3<f32>(bblFogFactor, bblFogFactor, bblFogFactor),
    );
  }
  let v_104 = bblFoggedColor * FragmentUniforms.environmentFactors.x;`,
            );
            convertedPbr = convertedPbr.replace(
                /    linearColor,\r?\n    FragmentUniforms\.imageProcessingOptions\.x > 0\.5f,/,
                "    bblFoggedColor,\n    FragmentUniforms.imageProcessingOptions.x > 0.5f,",
            );
        }
        if (options.multiLight) {
            const primaryPointAttenuation =
                /    let v_62 = max\(0\.0f, \(1\.0f - \(sqrt\(v_59\) \/ max\(FragmentUniforms\.groundColor\.w, 0\.00009999999747378752f\)\)\)\);/;
            if (!primaryPointAttenuation.test(convertedPbr)) {
                throw new Error(
                    "PBR primary point-light attenuation marker changed.",
                );
            }
            convertedPbr = convertedPbr.replace(
                primaryPointAttenuation,
                "    let v_62 = 1.0f / max(v_59, 0.0000001f);",
            );
            convertedPbr = convertedPbr.replace(
                    /  groundColor : vec4<f32>,/,
                    "  groundColor : vec4<f32>,\n" +
                        "  extraLightPositions : array<vec4<f32>, 7>,\n" +
                        "  extraLightColors : array<vec4<f32>, 7>,\n" +
                        "  extraLightDirections : array<vec4<f32>, 7>,",
            );
            const extraLights = Array.from(
                    { length: 7 },
                    (_, index) => `  {
    let extraColorIntensity = FragmentUniforms.extraLightColors[${index}u];
    if (extraColorIntensity.w > 0.0f) {
      let extraDelta = FragmentUniforms.extraLightPositions[${index}u].xyz - v_1;
      let extraDistanceSquared = dot(extraDelta, extraDelta);
      let extraDirection = normalize(extraDelta);
      let extraNdotL = max(dot(v_28, extraDirection), 0.0f);
      // Pinned spot falloff under physical light falloff, which is the mode
      // this inverse-square attenuation already is:
      // exp2(kappa * (spotCosine - 1)) with
      // kappa = 6.64385618977 / (1 - cos(angle / 2)). The exponent the pinned
      // standard-falloff branch applies is unreachable on this path, and a
      // glTF spot carries exponent 1 in any case.
      let extraCone = FragmentUniforms.extraLightDirections[${index}u];
      let extraSpotCosine = dot(extraCone.xyz, -extraDirection);
      let extraConeFalloff = select(
        1.0f,
        exp2(
          (6.64385618977f / max(1.0f - extraCone.w, 0.0001f)) *
            (extraSpotCosine - 1.0f),
        ),
        extraCone.w > -1.5f,
      );
      let extraAttenuation =
        extraConeFalloff / max(extraDistanceSquared, 0.0000001f);
      let extraHalf = normalize(v_41 + extraDirection);
      let extraNdotH = clamp(dot(v_28, extraHalf), 0.0000001f, 1.0f);
      let extraVdotH = clamp(dot(v_41, extraHalf), 0.0f, 1.0f);
      let extraFresnel = v_75 + v_76 * pow(1.0f - extraVdotH, 5.0f);
      let extraDistributionDenominator =
        extraNdotH * extraNdotH * (v_78 - 1.0f) + 1.0f;
      let extraDistribution =
        v_78 /
        (3.14159274101257324219f *
          extraDistributionDenominator *
          extraDistributionDenominator);
      let extraVisibility = 0.5f / (
        extraNdotL * sqrt(
          v_43 * (v_43 - v_78 * v_43) + v_78,
        ) +
        v_43 * sqrt(
          extraNdotL *
            (extraNdotL - v_78 * extraNdotL) +
            v_78,
        )
      );
      let extraScale =
        extraColorIntensity.w *
        extraAttenuation;
      let extraSpecular =
        extraFresnel *
        extraDistribution *
        extraVisibility *
        extraNdotL *
        extraColorIntensity.rgb *
        extraScale *
        mix(vec3<f32>(1.0f), v_100, vec3<f32>(v_88));
      let extraDiffuse =
        extraColorIntensity.rgb *
        v_52 *
        (extraNdotL * 0.31830987334251403809f) *
        extraScale;
      bblExtraSpecular += extraSpecular;
      bblExtraDiffuse += extraDiffuse;
    }
  }`,
            ).join("\n");
            const directMarker =
                    "  let v_103 = (FragmentUniforms.materialOptions.z > 0.5f);";
            if (!convertedPbr.includes(directMarker)) {
                    throw new Error(
                        "PBR direct-light output marker changed.",
                    );
            }
            convertedPbr = convertedPbr.replace(
                    directMarker,
                    `${extraLights}
${directMarker}`,
            );
            const alphaLuminance =
                "    let v_113 = dot((v_101 + v_102), " +
                "vec3<f32>(0.21259999275207519531f, " +
                "0.71520000696182250977f, " +
                "0.07220000028610229492f));";
            if (!convertedPbr.includes(alphaLuminance)) {
                throw new Error(
                    "PBR transparent alpha luminance marker changed.",
                );
            }
            convertedPbr = convertedPbr.replace(
                alphaLuminance,
                "    let v_113 = dot((v_101 + v_102 + " +
                    "bblExtraSpecular), " +
                    "vec3<f32>(0.21259999275207519531f, " +
                    "0.71520000696182250977f, " +
                    "0.07220000028610229492f));",
            );
        }
        if (options.environmentRotation) {
            const irradianceDirection =
                /      let v_85 = v_28\.y;\r?\n      let v_86 = v_28\.z;\r?\n      let v_87 = v_28\.x;/;
            if (!irradianceDirection.test(convertedPbr)) {
                throw new Error(
                    "PBR environment normal markers changed.",
                );
            }
            convertedPbr = convertedPbr.replace(
                irradianceDirection,
                "      let env_rotation = FragmentUniforms.imageProcessingOptions.y;\n" +
                    "      let env_cos = cos(env_rotation);\n" +
                    "      let env_sin = sin(env_rotation);\n" +
                    "      let env_normal = vec3<f32>(v_28.x * env_cos + v_28.z * env_sin, v_28.y, -v_28.x * env_sin + v_28.z * env_cos);\n" +
                    "      let v_85 = env_normal.y;\n" +
                    "      let v_86 = env_normal.z;\n" +
                    "      let v_87 = env_normal.x;",
            );
            const reflectionDirection =
                /  let v_90 = reflect\(-\(v_41\), v_28\);/;
            if (!reflectionDirection.test(convertedPbr)) {
                throw new Error(
                    "PBR environment reflection marker changed.",
                );
            }
            convertedPbr = convertedPbr.replace(
                reflectionDirection,
                "  let environment_reflection_raw = reflect(-(v_41), v_28);\n" +
                    "  let environment_rotation = FragmentUniforms.imageProcessingOptions.y;\n" +
                    "  let environment_cos = cos(environment_rotation);\n" +
                    "  let environment_sin = sin(environment_rotation);\n" +
                    "  let v_90 = vec3<f32>(environment_reflection_raw.x * environment_cos + environment_reflection_raw.z * environment_sin, environment_reflection_raw.y, -environment_reflection_raw.x * environment_sin + environment_reflection_raw.z * environment_cos);",
            );
            const horizonOcclusion =
                "  let v_99_horizon = clamp((1.0f + " +
                "(1.10000002384185791016f * dot(v_90, v_29))), " +
                "0.0f, 1.0f);";
            if (!convertedPbr.includes(horizonOcclusion)) {
                throw new Error(
                    "PBR environment horizon-occlusion marker changed.",
                );
            }
            convertedPbr = convertedPbr.replace(
                horizonOcclusion,
                "  let v_99_horizon = clamp((1.0f + " +
                    "(1.10000002384185791016f * " +
                    "dot(environment_reflection_raw, v_29))), " +
                    "0.0f, 1.0f);",
            );
        }
        if (
            options.sheen &&
            options.sheenAlbedoScaling !== true &&
            options.materialSpecular === true
        ) {
            // The legacy sheen arm attenuates its lobe by the dielectric
            // Fresnel term, which `KHR_materials_specular` moves. No reached
            // scene composes the two.
            throw new Error(
                "Legacy sheen composed with KHR_materials_specular is not lowered.",
            );
        }
        if (
            (options.clearcoat || options.sheen) &&
            options.multiLight
        ) {
            throw new Error(
                "Combined punctual multi-light and clearcoat/sheen PBR layer composition is not lowered.",
            );
        }
        convertedPbr = applyMaterialExtensionWgsl(convertedPbr, {
            transmission: options.transmission === true,
            environmentRotation: options.environmentRotation === true,
            clearcoat: options.clearcoat === true,
            sheen: options.sheen === true,
            sheenAlbedoScaling:
                options.sheenAlbedoScaling === true,
            iridescence: options.iridescence === true,
            dispersion: options.dispersion === true,
            occlusionUv2: options.occlusionUv2 === true,
        });
        // Both blocks insert after the same uniform-block marker, so the LAST
        // one written ends up FIRST in the emitted struct. The C++ mirror
        // declares the reflectance slice ahead of the UV pairs, so the UV pass
        // has to run before the reflectance pass for the two layouts to agree.
        if (options.textureTransform) {
            convertedPbr = applyPbrUvTransformWgsl(
                convertedPbr,
                reachedUvTransformSlots(options),
            );
        }
        if (options.materialSpecular) {
            convertedPbr = applyPbrReflectanceWgsl(convertedPbr);
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
                pbrFragmentWgsl(
                    convertedPbr,
                    { kind: "color" },
                    options.occlusionUv2 === true,
                ),
        });
        if (options.standardMaterial) {
            result.push({
                output: "upstream/shaders/standard.frag.native.wgsl",
                data: standardFragmentWgsl(
                    this.context.provenance(
                        standardTemplateModule,
                        "createStandardTemplate",
                    ),
                    undefined,
                    options.fog === true,
                    options.standardVertexColors === true,
                    Math.max(2, options.standardLights ?? 2),
                    options.standardDiffuseUv2 === true,
                    options.standardBump === true,
                    options.standardSpotLights === true,
                ),
            });
        }
        if (options.ground) {
            const groundProvenance = this.context.provenance(
                backgroundGroundModule,
                "buildBackgroundGroundRenderable",
            );
            result.push({
                output:
                    "upstream/shaders/background-ground.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(groundProvenance),
            });
            // The pinned position-seeded dither variant: the Dawn
            // backend compiles it bit-reproducibly (same compiler as
            // the reference); SDL_GPU keeps the undithered fragment
            // because its offline compilation decorrelates the noise.
            result.push({
                output:
                    "upstream/shaders/background-ground-dither.frag.native.wgsl",
                data: backgroundGroundFragmentWgsl(
                    groundProvenance,
                    true,
                ),
            });
        }
        if (options.skybox) {
            const skyboxProvenance = this.context.provenance(
                backgroundDdsModule,
                "buildDdsSkyboxRenderable",
                `${backgroundHdrModule}#buildHdrSkyboxRenderable`,
            );
            result.push({
                output:
                    "upstream/shaders/background-skybox.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(skyboxProvenance),
            });
            result.push({
                output:
                    "upstream/shaders/background-skybox-dither.frag.native.wgsl",
                data: backgroundSkyboxFragmentWgsl(
                    skyboxProvenance,
                    true,
                ),
            });
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
        if (options.pbrDiagnostics) {
            for (const variant of ["a", "b", "c"] as const) {
                result.push({
                    output:
                        `upstream/shaders/pbr-diagnostics-${variant}.frag.native.wgsl`,
                    data:
                        `// ${pbrProvenance}\n` +
                        pbrFragmentWgsl(
                            convertedPbr,
                            {
                                kind: "diagnostic",
                                group: variant,
                            },
                            options.occlusionUv2 === true,
                        ),
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
                    pbrFragmentWgsl(
                        convertedPbr,
                        {
                            kind: "geometry",
                            task,
                        },
                        options.occlusionUv2 === true,
                    ),
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
            ],
        };
    }
}
