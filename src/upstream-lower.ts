import { createHash } from "node:crypto";
import ts from "typescript";
import { CameraLowerer } from "./lowering/camera-lowerer.js";
import { LoweredSource, LoweringContext } from "./lowering/context.js";
import { EnvironmentLowerer } from "./lowering/environment-lowerer.js";
import { EngineLowerer } from "./lowering/engine-lowerer.js";
import { LightLowerer } from "./lowering/light-lowerer.js";
import { SceneLowerer } from "./lowering/scene-lowerer.js";
import { GltfLowerer } from "./lowering/gltf-lowerer.js";
import { BabylonLowerer } from "./lowering/babylon-lowerer.js";
import { FactoryLowerer } from "./lowering/factory-lowerer.js";
import { RendererLowerer } from "./lowering/renderer-lowerer.js";
import { BillboardLowerer } from "./lowering/billboard-lowerer.js";
import { SpriteLowerer } from "./lowering/sprite-lowerer.js";
import {
    billboardFragmentWgsl,
    billboardVertexWgsl,
} from "./shader-builtins-billboard.js";
import {
    spriteFragmentWgsl,
    spriteVertexWgsl,
} from "./shader-builtins-sprite.js";
import { GeometryOutputLowerer } from "./lowering/geometry-output-lowerer.js";
import { PostProcessLowerer } from "./lowering/post-process-lowerer.js";
import { AnimationLowerer } from "./lowering/animation-lowerer.js";
import { UpstreamSourceStore } from "./upstream-source.js";
import type { SpriteCustomShaderManifest } from "./compiler/types.js";
import { GeneratedTree } from "./generated-tree.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import {
    materialTextureSlotsHeader,
    meshUniformsBlock,
    lightUniformsBlock,
    pinnedPbrVariantsHeader,
    pinnedStandardVariantsHeader,
    sceneUniformsStruct,
    variantBindings,
} from "./pinned-pbr-variant-cpp.js";
import type { PinnedVariantManifestEntry } from "./pinned-pbr-variant-output.js";
import {
    pinnedNodeVariantsHeader,
    type NodeVariantManifestEntry,
} from "./pinned-node-material-cpp.js";
import {
    pinnedStandardSupportBlock,
    type PinnedStandardSelector,
    type PinnedStandardVariantManifestEntry,
} from "./pinned-standard-variants.js";
import type {
    ComposedComposite,
    ComposedPostProcess,
} from "./pinned-post-process.js";
import {
    extractPackagedTemplateLiteral,
    extractWgslFunction,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";

/**
 * The byte count `shader/scene-uniforms-size.ts` publishes for the scene block.
 * Read rather than assumed, so the mirrored layout is checked against the pin's
 * own allocation.
 */
/**
 * The word offset `lights-ubo.ts` writes a mesh's light indices from, read so
 * the mirrored mesh block is checked against the pin's own constant.
 */
/** The pin's own MAX_LIGHTS, so the lights buffer is sized by it. */
function pinnedMaxLights(context: LoweringContext): number {
    const file = context.sourceFile("src/light/types.ts");
    const initializer = context.unwrapExpression(
        context.variableInitializer(file, "MAX_LIGHTS"),
    );
    if (!ts.isNumericLiteral(initializer)) {
        context.contractError(
            initializer,
            "Expected MAX_LIGHTS to be a numeric constant.",
        );
    }
    return Number.parseInt(initializer.text, 10);
}

/** The pin's frozen MAX_LIGHTS, read for the activation inventory's
 *  max-lights refusal row so it records the constant's value beside
 *  the checked count. */
export function readPinnedMaxLights(): number {
    return pinnedMaxLights(new LoweringContext(new UpstreamSourceStore()));
}

function meshLightIndexWordOffset(context: LoweringContext): number {
    const file = context.sourceFile("src/render/lights-ubo.ts");
    const initializer = context.unwrapExpression(
        context.variableInitializer(file, "MSH_LIGHT_INDEX_WORD_OFFSET"),
    );
    if (!ts.isNumericLiteral(initializer)) {
        context.contractError(
            initializer,
            "Expected MSH_LIGHT_INDEX_WORD_OFFSET to be a numeric constant.",
        );
    }
    return Number.parseInt(initializer.text, 10);
}

function sceneUboBytes(context: LoweringContext): number {
    const file = context.sourceFile("src/shader/scene-uniforms-size.ts");
    const initializer = context.unwrapExpression(
        context.variableInitializer(file, "SCENE_UBO_BYTES"),
    );
    if (!ts.isNumericLiteral(initializer)) {
        context.contractError(
            initializer,
            "Expected SCENE_UBO_BYTES to be a numeric constant.",
        );
    }
    return Number.parseInt(initializer.text, 10);
}

/** The light kinds the pin writes an entry for, in its own order. */
const pinnedLightKinds = [
    "hemispheric",
    "directional",
    "point",
    "spot",
] as const;

/**
 * The pinned per-pass blocks, hoisted into whichever family header is emitted
 * first.
 *
 * All three composed families declare the same scene and lights blocks, and
 * the two material families also share the mesh block. Whichever header a
 * scene emits carries them; a TU never sees two copies, because the capability
 * defines gate the includes. `meshFragmentWgsl` is the composed fragment whose
 * `MeshUniforms` declaration is widest — absent for the node family, which
 * declares its own mesh block instead.
 */
function sharedPinnedMirrors(
    context: LoweringContext,
    features: readonly string[],
    meshFragmentWgsl?: string,
): string {
    const reachedKinds = pinnedLightKinds.filter((kind) =>
        features.includes(`light:${kind}`)
    );
    return `
// ---------------------------------------------------------------------------
// The shared pinned per-pass blocks, hoisted for a scene whose earlier family
// headers are not emitted.
${
        reachedKinds.length > 0
            ? "#include <bblite/upstream/light_matrix.hpp>\n"
            : ""
    }
namespace bbl::upstream {

using bbl::LightRecord;
using bbl::LightKind;

${
        sceneUniformsStruct(
            new RendererLowerer(context).compiledSceneUniformsWgsl(),
            sceneUboBytes(context),
        )
    }

${lightUniformsBlock(context, pinnedMaxLights(context), reachedKinds)}
${
        meshFragmentWgsl === undefined ? "" : `
${meshUniformsBlock(meshFragmentWgsl, meshLightIndexWordOffset(context))}
`
    }
} // namespace bbl::upstream
`;
}
import type {
    CompiledShaderProgram,
    GeometryOutputTaskManifest,
    PostProcessTaskManifest,
} from "./compiler.js";

/**
 * What a scene reached, as the emitters need to see it. Named once
 * because the entry function only forwards it: restating the shape at
 * both ends meant every new capability was declared twice.
 */
export interface UpstreamEmitOptions {
    idDiagnostics: boolean;
    /**
     * The largest per-asset `KHR_lights_punctual` light-node count. The pin
     * grows `MAX_LIGHTS` past its constant at run time (`setMaxLights` in
     * `gltf-feature-lights-punctual.ts`); this port freezes the constant and
     * the native writers stop at it, so a count beyond it must refuse at
     * generation rather than silently unlight the excess.
     */
    assetLightNodes?: { count: number; asset: string };
    shaderPrograms: CompiledShaderProgram[];
    geometryOutputTasks: GeometryOutputTaskManifest[];
    /**
     * The post-process passes a scene reached, in reach order. Each carries
     * the pinned factory and the options that reach its composed stage; the
     * stage itself arrives already composed, in `postProcessShaders`.
     */
    postProcessTasks: readonly PostProcessTaskManifest[];
    /**
     * One composed module per reached pass, indexed by `shaderIndex`, with
     * the layout its bind group declares. The pin's own `getShaderModule`
     * produced each, so nothing about them is restated here.
     */
    postProcessShaders: readonly ComposedPostProcess[];
    /**
     * What each reached composite's own factory built, in reach order. Its
     * passes are numbered after every plain pass, so one table indexes both.
     */
    postProcessComposites: readonly ComposedComposite[];
    gpuDeformation: boolean;
    /**
     * Whether the loader records live world boxes and default framing reads
     * them — asset animations alone, where `gpuDeformation` also covers
     * scene-source morph targets for the vertex layout and the define.
     */
    animatedWorldBounds: boolean;
    morphStorage: boolean;
    nonTrianglePrimitives: boolean;
    nodeVisibility: boolean;
    /**
     * The sprite-family custom fragment bodies scene code built, at most one
     * per family. Generation composes each into the pin's own builder; the
     * body itself is scene data, which is why it arrives rather than being
     * read out of the pin.
     */
    spriteCustomShaders: readonly SpriteCustomShaderManifest[];
    /**
     * Whether a layer or system draws with the stock program. A scene whose
     * every one opts into a custom shader never loads it, so it is not
     * composed here either.
     */
    plainSpriteLayer: boolean;
    plainBillboardSystem: boolean;
    animationPointer: boolean;
    animationPointerMaterials: boolean;
    assetTransmission: boolean;
    materialSpecular: boolean;
    /** The `KHR_materials_variants` a scene selected, or "" when unreached. */
    selectedMaterialVariant: string;
    standardLights: number;
    standardLightLists: boolean;
    standardDiffuseUv2: boolean;
    standardBump: boolean;
    textureTransform: boolean;
    imageBasedLighting: boolean;
    gpuInstancing: boolean;
    punctualLights: boolean;
    clearcoat: boolean;
    sheen: boolean;
    /**
     * The pin's own composed PBR variants. Emitted into the deployed shader
     * directory so the offline path compiles them for SDL_GPU and Dawn reads
     * them at startup, which is what the transcribed per-scene fragment is
     * being replaced with.
     */
    pinnedVariants?: readonly PinnedVariantManifestEntry[];
    /**
     * The pin's own composed Standard variants — the Standard mirror of
     * `pinnedVariants`, emitted as `standard_variants.hpp` plus the composed
     * stages. Absent only when the scene reaches no Standard material,
     * which also skips the header.
     */
    pinnedStandardVariants?: readonly PinnedStandardVariantManifestEntry[];
    /**
     * The selector rows for `pinnedStandardVariants`: how a native draw's
     * record-derived feature word and mesh bits resolve a variant index.
     * Emitted with the variants into `standard_variants.hpp`.
     */
    pinnedStandardSelectors?: readonly PinnedStandardSelector[];
    /**
     * The Standard family's mesh-feature bits per runtime mesh handle —
     * unlike `renderableMeshFeatures` it also covers `.babylon` renderables
     * (one row per loader-created record, zero bits) so the handle indexing
     * matches the runtime's creation order in loader scenes.
     */
    standardRenderableMeshFeatures?: readonly number[];
    /** The Standard fallback for meshes created past the static table. */
    standardRuntimeMeshFeatures?: number;
    /**
     * The pin's own composed node graphs — one module per graph, emitted as
     * `node_variants.hpp` plus the two stages each deploys under. Absent when
     * the scene reaches no node material.
     */
    nodeVariants?: readonly NodeVariantManifestEntry[];
    /** The runtime material-handle count the variant gate checks. */
    pinnedMaterialCount?: number;
    /** The mesh attribute bits per runtime mesh handle, creation-ordered. */
    renderableMeshFeatures?: readonly number[];
    /** The bits for meshes created past the static table, when one value
     *  covers every scene-code builder; undefined refuses them. */
    runtimeMeshFeatures?: number;
    iridescence: boolean;
    /** Any loaded material replaces metallic-roughness with spec-gloss. */
    specularGlossiness: boolean;
    dispersion: boolean;
    occlusionUv2: boolean;
}

class GeneratedSourceWriter {
    /** Native sources this run wrote, checked against the reached table. */
    private readonly emitted = new Set<string>();

    public constructor(
        private readonly tree: GeneratedTree,
        private readonly store: UpstreamSourceStore,
    ) {}

    public emit(
        features: string[],
        options: UpstreamEmitOptions,
    ): void {
        const context = new LoweringContext(this.store);
        const generated: Array<{ modulePath: string; symbolName: string }> = [];
        // Scene transmission is reached from the scene's own code and from a
        // loaded asset alike: the pin's `registerPbrTransmission` enables it for
        // any transmissive surface the asset carries, without the scene naming
        // it. That makes it an asset capability like the material extensions
        // beside it, so the compiled define lives here rather than being derived
        // from the reached-feature list alone.
        const transmission =
            features.includes("renderer:transmission") ||
            options.assetTransmission;
        // A composed Standard variant binding the pin's 2D reflection pair
        // (std-reflection-fragment.ts `rT`/`rS`) is exactly the condition
        // under which the record's reflection_texture needs a mesh slot, so
        // the capability is derived from the composed set rather than being
        // a separate reach signal.
        const standardReflection = (options.pinnedStandardVariants ?? [])
            .some((variant) =>
                variantBindings(
                    variant.vertexWgsl,
                    variant.fragmentWgsl,
                ).some((binding) => binding.name === "rT")
            );
        this.tree.write(
            "upstream/include/bblite/upstream/render_capabilities.hpp",
            `#pragma once

#define BBLITE_RENDERER_TRANSMISSION ${transmission ? 1 : 0}

#define BBLITE_GPU_DEFORMATION ${options.gpuDeformation ? 1 : 0}
#define BBLITE_GPU_MORPH_STORAGE ${options.morphStorage ? 1 : 0}
#define BBLITE_GPU_INSTANCING ${options.gpuInstancing ? 1 : 0}
#define BBLITE_MATERIAL_CLEARCOAT ${options.clearcoat ? 1 : 0}
#define BBLITE_MATERIAL_SHEEN ${options.sheen ? 1 : 0}
#define BBLITE_MATERIAL_IRIDESCENCE ${options.iridescence ? 1 : 0}
#define BBLITE_MATERIAL_DISPERSION ${options.dispersion ? 1 : 0}
#define BBLITE_MATERIAL_SPEC_GLOSS ${options.specularGlossiness ? 1 : 0}
#define BBLITE_MATERIAL_OCCLUSION_UV2 ${options.occlusionUv2 ? 1 : 0}
#define BBLITE_MATERIAL_STANDARD_BUMP ${options.standardBump ? 1 : 0}
#define BBLITE_MATERIAL_STANDARD_REFLECTION ${standardReflection ? 1 : 0}
#define BBLITE_IMAGE_SKYBOX ${features.includes("background:image-skybox") ? 1 : 0}
#define BBLITE_SOLID_SKYBOX ${features.includes("background:solid-skybox") ? 1 : 0}

// How many of Babylon Lite's own composed PBR variants this scene reaches.
// Zero for a scene with no glTF materials, which emits no variant header.
#define BBLITE_PBR_VARIANTS ${(options.pinnedVariants ?? []).length}

// The Standard family's composed variants, the same way. Zero until the
// scene composes them, which also skips standard_variants.hpp.
#define BBLITE_STANDARD_VARIANTS ${
                (options.pinnedStandardVariants ?? []).length
            }

// The node graphs the pin's own emitter compiled for this scene. Zero
// until one is parsed, which also skips node_variants.hpp.
#define BBLITE_NODE_VARIANTS ${(options.nodeVariants ?? []).length}

// Whether any draw goes through Babylon Lite's own group scheme: group 0
// the per-pass scene and lights blocks, group 1 the per-draw ones. The
// three composed families share that frame state, so the code building it
// is reached by their disjunction rather than by any one of them.
#define BBLITE_PINNED_MATERIALS (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 || BBLITE_NODE_VARIANTS > 0)

// The two material families alone: the thin-instance arm and the geometry
// contract. A node graph binds the frame state above and resolves its
// textures through the same scene-owned pairs, but reaches none of this, so
// the two are separate questions and a reader can tell which one an #if is
// asking.
#define BBLITE_PINNED_MATERIAL_VARIANTS (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0)
`,
        );
        // The texture-slot table both render backends execute. Emitted for
        // every scene beside the capability defines above (the base slots
        // serve the Standard family too, so it cannot ride pbr_variants.hpp,
        // which a scene with no glTF materials does not emit); the scene's
        // composed variants are the cross-check that every pinned binding
        // name is served.
        this.tree.write(
            "upstream/include/bblite/upstream/material_texture_slots.hpp",
            materialTextureSlotsHeader(
                {
                    transmission,
                    clearcoat: options.clearcoat,
                    sheen: options.sheen,
                    iridescence: options.iridescence,
                    specularGlossiness: options.specularGlossiness,
                    occlusionUv2: options.occlusionUv2,
                    standardBump: options.standardBump,
                    standardReflection,
                },
                options.pinnedVariants ?? [],
                "src/pinned-pbr-variant-cpp.ts materialTextureSlotsHeader",
            ),
        );

        this.writeSource(
            "upstream/src/engine.cpp",
            new EngineLowerer(context).lowerCore(),
            generated,
        );
        this.writeSource(
            "upstream/src/scene_core.cpp",
            new SceneLowerer(context).lowerCore({
                fog: features.includes("renderer:fog"),
            }),
            generated,
        );

        if (
            features.includes("camera:arc-rotate") ||
            features.includes("camera:default") ||
            features.includes("camera:free")
        ) {
            const cameraLowerer = new CameraLowerer(context);
            this.writeSource(
                "upstream/src/camera_arc_rotate.cpp",
                cameraLowerer.lowerArcRotateFactory(),
                generated,
                "upstream/include/bblite/upstream/camera_math.hpp",
            );
            this.writeSource(
                "upstream/src/camera_controls.cpp",
                cameraLowerer.lowerControls(),
                generated,
                "upstream/include/bblite/upstream/camera_controls.hpp",
            );
            if (features.includes("camera:free")) {
                this.writeSource(
                    "upstream/src/camera_free.cpp",
                    cameraLowerer.lowerFreeFactory(),
                    generated,
                );
            }
        }
        if (features.includes("camera:default")) {
            this.writeSource(
                "upstream/src/camera_default.cpp",
                new CameraLowerer(context).lowerDefaultFactory(
                    options.nodeVisibility,
                    options.animatedWorldBounds,
                ),
                generated,
            );
        }
        if (features.includes("camera:orthographic")) {
            this.writeSource(
                "upstream/src/camera_orthographic.cpp",
                new CameraLowerer(context).lowerOrthographic(),
                generated,
            );
        }
        if (features.includes("background:image-skybox")) {
            this.writeSource(
                "upstream/src/image_skybox.cpp",
                new EnvironmentLowerer(
                    context,
                ).lowerImageSkyboxAdapter(),
                generated,
            );
        }
        if (
            features.includes("environment:env") ||
            features.includes("environment:hdr") ||
            features.includes("environment:dds")
        ) {
            const environment = new EnvironmentLowerer(context);
            if (features.includes("environment:env")) {
                this.writeSource(
                    "upstream/src/env_parse.cpp",
                    environment.lowerParser(),
                    generated,
                    "upstream/include/bblite/upstream/env_parse.hpp",
                );
                this.writeSource(
                    "upstream/src/environment.cpp",
                    environment.lowerLoaderAdapter(),
                    generated,
                );
            }
            if (features.includes("environment:hdr")) {
                this.writeSource(
                    "upstream/src/environment_hdr.cpp",
                    environment.lowerHdrLoaderAdapter(),
                    generated,
                );
            }
            if (features.includes("environment:dds")) {
                this.writeSource(
                    "upstream/src/environment_dds.cpp",
                    environment.lowerDdsLoaderAdapter(),
                    generated,
                );
            }
        }
        if (
            features.includes("light:hemispheric") ||
            features.includes("light:directional") ||
            features.includes("light:spot") ||
            // The pinned point-light block writer also indexes the light's
            // world matrix (`write_point_light` calls
            // `local_matrix_from_direction`), so a point-only scene that
            // composes variants needs the builder too.
            features.includes("light:point")
        ) {
            const light = new LightLowerer(context);
            this.writeSource(
                "upstream/src/light_matrix.cpp",
                light.lowerMatrix(),
                generated,
                "upstream/include/bblite/upstream/light_matrix.hpp",
            );
        }
        if (features.includes("light:hemispheric")) {
            this.writeSource(
                "upstream/src/light_hemispheric.cpp",
                new LightLowerer(context).lowerFactory(),
                generated,
            );
        }
        if (features.includes("light:directional")) {
            this.writeSource(
                "upstream/src/light_directional.cpp",
                new LightLowerer(context).lowerDirectionalFactory(),
                generated,
            );
        }
        if (features.includes("light:point")) {
            this.writeSource(
                "upstream/src/light_point.cpp",
                new LightLowerer(context).lowerPointFactory(),
                generated,
            );
        }
        if (features.includes("light:spot")) {
            this.writeSource(
                "upstream/src/light_spot.cpp",
                new LightLowerer(context).lowerSpotFactory(),
                generated,
            );
        }
        if (features.includes("animation:gltf-groups")) {
            this.writeSource(
                "upstream/src/animation_group.cpp",
                new AnimationLowerer(context).lowerGroupOperations(),
                generated,
            );
        }
        if (features.includes("animation:property")) {
            this.writeSource(
                "upstream/src/animation_property.cpp",
                new AnimationLowerer(context).lowerPropertyAnimation(),
                generated,
            );
        }
        if (features.includes("loader:gltf")) {
            const gltf = new GltfLowerer(context);
            this.writeSource(
                "upstream/src/gltf_glb_parser.cpp",
                gltf.lowerGlbParser(),
                generated,
                "upstream/include/bblite/upstream/gltf_glb_parser.hpp",
            );
            this.writeSource(
                "upstream/src/gltf_loader.cpp",
                gltf.lowerLoaderAdapter(
                    options.nonTrianglePrimitives,
                    options.nodeVisibility,
                    options.animationPointer,
                    options.animatedWorldBounds,
                    options.animationPointerMaterials,
                    options.assetTransmission,
                    options.materialSpecular,
                    options.selectedMaterialVariant,
                ),
                generated,
            );
            generated.push({
                modulePath: "src/loader-gltf/gltf-sampler-desc.ts",
                symbolName: "gltfTexSamplerDesc",
            });
            generated.push(
                { modulePath: "src/animation/evaluate.ts", symbolName: "normalizeQuat4" },
                { modulePath: "src/animation/evaluate.ts", symbolName: "quatSlerp" },
                { modulePath: "src/animation/evaluate.ts", symbolName: "evaluateSampler" },
                { modulePath: "src/loader-gltf/gltf-ext-quantization.ts", symbolName: "readComponent" },
                { modulePath: "src/loader-gltf/gltf-color-normalize.ts", symbolName: "normalizeColorToVec4" },
                { modulePath: "src/loader-gltf/ibl-env-assembly.ts", symbolName: "polynomialToPreScaledHarmonics" },
                { modulePath: "src/loader-gltf/gltf-ext-lights-image-based.ts", symbolName: "applyAsset" },
                { modulePath: "src/loader-gltf/gltf-ext-dielectric.ts", symbolName: "applyMaterial" },
                { modulePath: "src/loader-gltf/gltf-ext-iridescence.ts", symbolName: "applyMaterial" },
                { modulePath: "src/math/mat4-multiply-into.ts", symbolName: "mat4MultiplyInto" },
                { modulePath: "src/math/mat4-compose-into.ts", symbolName: "mat4ComposeInto" },
                { modulePath: "src/loader-gltf/gltf-parser.ts", symbolName: "RH_TO_LH_ROOT" },
                { modulePath: "src/loader-gltf/gltf-ext-lights-image-based.ts", symbolName: "irradianceCoefficientsToPolynomial" },
                { modulePath: "src/loader-gltf/gltf-ext-lights-image-based.ts", symbolName: "envYawFromQuaternion" },
                { modulePath: "src/loader-gltf/ibl-env-assembly.ts", symbolName: "generateBrdfLut" },
                { modulePath: "src/loader-gltf/gltf-feature-lights-punctual.ts", symbolName: "applyAsset" },
                { modulePath: "src/light/spot-light.ts", symbolName: "createSpotLight" },
                { modulePath: "src/loader-gltf/gltf-parser.ts", symbolName: "computeNodeWorldMatrix" },
                { modulePath: "src/loader-gltf/gltf-material.ts", symbolName: "assembleMaterial" },
                { modulePath: "src/loader-gltf/gltf-pbr-builder.ts", symbolName: "uploadBaseColorFactorTexture,uploadOrmFactorTexture" },
                { modulePath: "src/math/color.ts", symbolName: "linearToSrgbByte" },
                { modulePath: "src/loader-gltf/gltf-ext-uv-transform.ts", symbolName: "wrapTexture" },
                { modulePath: "src/material/pbr/fragments/uv-transform-fragment.ts", symbolName: "writeOne" },
                { modulePath: "src/loader-gltf/gltf-ext-clearcoat.ts", symbolName: "applyMaterial" },
                { modulePath: "src/loader-gltf/gltf-ext-sheen.ts", symbolName: "applyMaterial" },
                { modulePath: "src/loader-gltf/gltf-ext-emissive-strength.ts", symbolName: "applyMaterial" },
            );
        }
        if (features.includes("loader:babylon")) {
            this.writeSource(
                "upstream/src/babylon_loader.cpp",
                new BabylonLowerer(context).lowerLoaderAdapter(
                    options.standardLightLists,
                    options.standardDiffuseUv2,
                    options.standardBump,
                ),
                generated,
            );
        }
        // Every WGSL module this run emits, whichever renderer produced it.
        const composedShaders: Array<{
            output: string;
            data: string;
        }> = [];
        if (features.includes("sprite:2d")) {
            const sprites = new SpriteLowerer(context);
            const custom = options.spriteCustomShaders.find(
                (entry) => entry.family === "sprite",
            );
            this.writeSource(
                "upstream/src/sprite_2d.cpp",
                sprites.lowerCore(),
                generated,
                "upstream/include/bblite/upstream/sprite_layer.hpp",
            );
            if (features.includes("renderer:sprite")) {
                const shader = sprites.shaderSource();
                const provenance = context.provenance(
                    "src/sprite/sprite-pipeline.ts",
                    "makeSpriteWgsl",
                );
                composedShaders.push({
                    output:
                        "upstream/shaders/sprite.vert.native.wgsl",
                    data: spriteVertexWgsl(provenance, shader),
                });
                // The stock fragment, only where a plain layer draws with
                // it: a custom layer keeps this vertex stage but brings its
                // own fragment, so a scene whose every layer opts in would
                // compile and deploy a stage nothing loads.
                if (options.plainSpriteLayer) {
                    composedShaders.push({
                        output:
                            "upstream/shaders/sprite.frag.native.wgsl",
                        data: spriteFragmentWgsl(
                            provenance,
                            shader,
                        ),
                    });
                }
                // The pin composes one module per descriptor, from the same
                // prologue with the caller's body spliced in, so the custom
                // program is a second file rather than an edit of the first
                // — a renderer can hold both, and a plain layer draws the
                // stock shader as it does when the fx hook is null.
                if (custom) {
                    const shader = sprites.shaderSource(
                        false,
                        custom.fragment,
                        custom.extraTextures,
                    );
                    const customProvenance = context.provenance(
                        "src/sprite/sprite-custom-shader.ts",
                        "makeCustomSpriteWgsl",
                    );
                    // Only the fragment: the pin composes the custom module
                    // from the same prologue, so the vertex stage is the
                    // stock text and a custom layer pairs the stock vertex
                    // with this fragment. That also keeps the uv-scroll
                    // vertex free to combine with it rather than needing a
                    // fourth file for the pair.
                    composedShaders.push({
                        output:
                            "upstream/shaders/sprite_custom.frag.native.wgsl",
                        data: spriteFragmentWgsl(
                            customProvenance,
                            shader,
                        ),
                    });
                    generated.push({
                        modulePath:
                            "src/sprite/sprite-custom-shader.ts",
                        symbolName: "makeCustomSpriteWgsl",
                    });
                }
                if (features.includes("sprite:uv-scroll")) {
                    // The scroll variant adds one attribute and one term to
                    // the sampled UV; the pin gates both on the same flag.
                    // Only the vertex stage differs: the pin adds the
                    // offset to the sampled UV there and leaves the fragment
                    // alone, so the widened layer shares sprite.frag.
                    const scroll = sprites.shaderSource(true);
                    composedShaders.push({
                        output:
                            "upstream/shaders/sprite_uvscroll.vert.native.wgsl",
                        data: spriteVertexWgsl(provenance, scroll),
                    });
                }
                generated.push({
                    modulePath: "src/sprite/sprite-pipeline.ts",
                    symbolName:
                        "makeSpritePrologueWgsl,makeSpriteWgsl,buildSpriteLayerUbo",
                });
            }
        }
        if (features.includes("sprite:billboard")) {
            // The billboard vertex stage reads the scene block, so it takes
            // the renderer's own copy of that WGSL rather than a second one.
            const billboards = new BillboardLowerer(
                context,
                new RendererLowerer(
                    context,
                ).compiledSceneUniformsWgsl(),
            );
            const customBillboard =
                options.spriteCustomShaders.find(
                    (entry) => entry.family === "billboard",
                );
            this.writeSource(
                "upstream/src/billboard_system.cpp",
                billboards.lowerCore(),
                generated,
                "upstream/include/bblite/upstream/billboard_system.hpp",
            );
            const shader = billboards.shaderSource();
            const provenance = context.provenance(
                "src/sprite/billboard-pipeline.ts",
                "makeBillboardWgsl",
            );
            // The stock pair, only where a plain system draws with it. Unlike
            // the 2D family a custom billboard brings its own vertex stage
            // too, so a scene whose every system opts in loads neither half.
            if (options.plainBillboardSystem) {
                composedShaders.push(
                    {
                        output:
                            "upstream/shaders/billboard.vert.native.wgsl",
                        data: billboardVertexWgsl(provenance, shader),
                    },
                    {
                        output:
                            "upstream/shaders/billboard.frag.native.wgsl",
                        data: billboardFragmentWgsl(provenance, shader),
                    },
                );
            }
            if (features.includes("sprite:billboard-cutout")) {
                // The cutout arm discards below the cutoff and is otherwise
                // the same stage, so like the second orientation it costs
                // one file rather than a pair.
                composedShaders.push({
                    output:
                        "upstream/shaders/billboard_cutout.frag.native.wgsl",
                    data: billboardFragmentWgsl(
                        provenance,
                        billboards.shaderSource("facing", "cutout"),
                    ),
                });
            }
            // The billboard mirror of the 2D custom program, and the one
            // place the two families differ: the pin's billboard composer
            // exposes `viewDist` and the world position to a custom body, so
            // its vertex stage writes two varyings the stock one does not and
            // the pair travels together.
            if (customBillboard) {
                const shader = billboards.shaderSource(
                    "facing",
                    "transparent",
                    customBillboard.fragment,
                    customBillboard.extraTextures,
                );
                const customProvenance = context.provenance(
                    "src/sprite/billboard-custom-shader.ts",
                    "makeCustomBillboardWgsl",
                );
                composedShaders.push(
                    {
                        output:
                            "upstream/shaders/billboard_custom.vert.native.wgsl",
                        data: billboardVertexWgsl(
                            customProvenance,
                            shader,
                        ),
                    },
                    {
                        output:
                            "upstream/shaders/billboard_custom.frag.native.wgsl",
                        data: billboardFragmentWgsl(
                            customProvenance,
                            shader,
                        ),
                    },
                );
                generated.push({
                    modulePath:
                        "src/sprite/billboard-custom-shader.ts",
                    symbolName: "makeCustomBillboardWgsl",
                });
            }
            if (features.includes("sprite:billboard-axis-locked")) {
                // The pin's composer swaps only the basis function; the
                // fragment stage is the same text, so the second orientation
                // costs one vertex stage rather than a pair.
                composedShaders.push({
                    output:
                        "upstream/shaders/billboard_axis_locked.vert.native.wgsl",
                    data: billboardVertexWgsl(
                        provenance,
                        billboards.shaderSource("axis-locked"),
                    ),
                });
            }
            generated.push({
                modulePath: "src/sprite/billboard-pipeline.ts",
                symbolName:
                    "makeBillboardWgsl,makeBillboardBasisWgsl,buildBillboardSystemUbo",
            });
        }
        if (features.includes("renderer:pbr")) {
            const renderer = new RendererLowerer(context);
            this.writeSource(
                "upstream/src/renderer_plan.cpp",
                renderer.lowerRenderPlan({
                    fog: features.includes("renderer:fog"),
                    imageSkybox: features.includes(
                        "background:image-skybox",
                    ),
                    solidSkybox: features.includes(
                        "background:solid-skybox",
                    ),
                    environmentRotation:
                        options.imageBasedLighting,
                    gpuInstancing:
                        options.gpuInstancing,
                    punctualLights:
                        options.punctualLights,
                    nodeVisibility: options.nodeVisibility,
                    orthographicCamera: features.includes(
                        "camera:orthographic",
                    ),
                    background:
                        features.includes(
                            "background:ground",
                        ) ||
                        features.includes(
                            "background:skybox",
                        ) ||
                        features.includes(
                            "background:image-skybox",
                        ) ||
                        features.includes(
                            "background:solid-skybox",
                        ),
                    shaderPrograms: options.shaderPrograms,
                }),
                generated,
                "upstream/include/bblite/upstream/renderer_plan.hpp",
            );
            const shaders = renderer.lowerShaders({
                ground: features.includes("background:ground"),
                skybox: features.includes("background:skybox"),
                imageSkybox: features.includes(
                    "background:image-skybox",
                ),
                solidSkybox: features.includes(
                    "background:solid-skybox",
                ),
                transmission: transmission,
                fog: features.includes("renderer:fog"),
                shaderPrograms: options.shaderPrograms,
                gridMaterial: features.includes("material:grid"),
                idDiagnostics: options.idDiagnostics,
                geometryOutputTasks: options.geometryOutputTasks,
                frameGraph: features.includes("renderer:geometry-output"),
                gpuDeformation: options.gpuDeformation,
                morphStorage: options.morphStorage,
                gpuInstancing:
                    options.gpuInstancing,
                clearcoat: options.clearcoat,
                sheen: options.sheen,
                iridescence: options.iridescence,
                dispersion: options.dispersion,
            });
            composedShaders.push(...shaders);
            // The Dawn backend's utility passes, deployed like every other
            // pinned shader instead of living as C++ strings invisible to
            // shader provenance: the mip-generator blit for every renderer
            // scene, and the transmission grab + per-sample image
            // processing wherever transmission compiles. SDL_GPU never
            // loads these (its API owns mip generation and the blit, and
            // its image processing rides the resolved-pixel pair above);
            // the offline pipeline still compiles them like any deployed
            // WGSL, which is what keeps them under the same provenance
            // and drift checks.
            const dawnUtility = dawnUtilityShaders(transmission);
            composedShaders.push(
                {
                    output: "upstream/shaders/mip-blit.vert.native.wgsl",
                    data: dawnUtility.mipBlitVertex,
                },
                {
                    output: "upstream/shaders/mip-blit.frag.native.wgsl",
                    data: dawnUtility.mipBlitFragment,
                },
            );
            generated.push({
                modulePath: "src/texture/generate-mipmaps.ts",
                symbolName: "BLIT_SHADER",
            });
            if (transmission) {
                composedShaders.push(
                    {
                        output:
                            "upstream/shaders/transmission-grab.vert.native.wgsl",
                        data: dawnUtility.grabVertex,
                    },
                    {
                        output:
                            "upstream/shaders/transmission-grab.frag.native.wgsl",
                        data: dawnUtility.grabFragment,
                    },
                    {
                        output:
                            "upstream/shaders/transmission-grab-single.frag.native.wgsl",
                        data: dawnUtility.grabFragmentSingle,
                    },
                    {
                        output:
                            "upstream/shaders/image-processing-samples.vert.native.wgsl",
                        data: dawnUtility.imageProcessingVertex,
                    },
                    {
                        output:
                            "upstream/shaders/image-processing-samples.frag.native.wgsl",
                        data: dawnUtility.imageProcessingFragment,
                    },
                    {
                        output:
                            "upstream/shaders/image-processing-samples-single.frag.native.wgsl",
                        data: dawnUtility.imageProcessingFragmentSingle,
                    },
                );
                generated.push(
                    {
                        modulePath: "src/frame-graph/transmission.ts",
                        symbolName: "BLIT_MSAA_SHADER",
                    },
                    {
                        modulePath:
                            "src/frame-graph/image-processing-task.ts",
                        symbolName: "ip",
                    },
                );
            }
            if (options.shaderPrograms.length > 0) {
                this.tree.write(
                    "upstream/shaders/shader-material-reflection.json",
                    `${JSON.stringify(
                        renderer.shaderMaterialReflections(
                            options.shaderPrograms,
                        ),
                        null,
                        2,
                    )}\n`,
                );
            }
            this.tree.write(
                "upstream/renderer-fidelity.json",
                `${JSON.stringify(renderer.fidelityManifest(), null, 2)}\n`,
            );
            generated.push(
                { modulePath: "src/material/pbr/pbr-template.ts", symbolName: "createPbrTemplate" },
                { modulePath: "src/material/pbr/pbr-template-ext.ts", symbolName: "baseColorMod" },
                { modulePath: "src/material/pbr/fragments/ibl-fragment.ts", symbolName: "makeIblCalculation" },
                { modulePath: "src/frame-graph/scene-uniforms-pack.ts", symbolName: "_packSceneUniforms" },
                { modulePath: "src/material/pbr/background-ground.ts", symbolName: "buildGroundRenderable" },
                { modulePath: "src/material/pbr/background-dds-skybox.ts", symbolName: "buildDdsSkyboxRenderable" },
                { modulePath: "src/loader-env/rgbd-decode.ts", symbolName: "uploadCubemapRGBD" },
            );
            if (features.includes("environment:hdr")) {
                generated.push(
                    {
                        modulePath: "src/loader-hdr/hdr-parser.ts",
                        symbolName: "parseRGBE,computeSHFromEquirect",
                    },
                    {
                        modulePath: "src/loader-hdr/hdr-ibl-pipeline.ts",
                        symbolName: "equirectToCubemapGPU,prefilterCubemapGPU",
                    },
                    {
                        modulePath: "src/material/pbr/background-hdr-skybox.ts",
                        symbolName: "buildHdrSkyboxRenderable",
                    },
                );
            }
        }
        if (features.includes("renderer:geometry-output")) {
            this.writeSource(
                "upstream/src/frame_graph_geometry.cpp",
                new GeometryOutputLowerer(context).lowerTaskRecords(),
                generated,
                "upstream/include/bblite/upstream/frame_graph_geometry.hpp",
            );
            generated.push(
                {
                    modulePath: "src/material/pbr/pbr-geometry-output-shader.ts",
                    symbolName: "attachmentExpr",
                },
                {
                    modulePath: "src/frame-graph/copy-to-texture-task.ts",
                    symbolName: "createCopyToTextureTask",
                },
            );
        }
        if (features.includes("renderer:post-process")) {
            this.writeSource(
                "upstream/src/frame_graph_post_process.cpp",
                new PostProcessLowerer(
                    context,
                    options.postProcessTasks,
                    options.postProcessComposites,
                ).lowerTaskRecords(),
                generated,
                "upstream/include/bblite/upstream/frame_graph_post_process.hpp",
            );
            // One stage table over both kinds of pass: the plain effects in
            // reach order, then each composite's own chain. A pass is a pass
            // once composed, so the deployed modules and the layout table do
            // not distinguish where it came from.
            const postProcessStages: ComposedPostProcess[] = [
                ...options.postProcessShaders,
                ...options.postProcessComposites.flatMap((composite) =>
                    composite.passes.map((pass) => ({
                        wgsl: pass.wgsl,
                        uniformByteLength: pass.uniformByteLength,
                        uniformBinding: pass.uniformBinding,
                    })),
                ),
            ];
            // Both stages of a pass live in one composed module: Tint takes
            // one entry point per file, so the same text is deployed twice and
            // each copy is compiled at the stage its name selects. The text is
            // the pin's own, in the pin's own groups, which is why the
            // register remap treats it exactly like a composed variant.
            //
            // A module is identified by that text rather than by the pass that
            // reached it: two blur passes differing only in `direction` -- a
            // uniform, not a define -- compose the same text, and deploying it
            // twice would compile it twice and build a second pipeline from it.
            // Each pass keeps its own record either way; only the module is
            // shared.
            const postProcessProvenance = context.provenance(
                "src/frame-graph/post-process-task.ts",
                "getShaderModule",
            );
            const postProcessModules = new Map<string, number>();
            for (const composed of postProcessStages) {
                if (postProcessModules.has(composed.wgsl)) continue;
                const index = postProcessModules.size;
                postProcessModules.set(composed.wgsl, index);
                for (const stage of ["vert", "frag"] as const) {
                    composedShaders.push({
                        output: `upstream/shaders/postprocess-${index}.${stage}.native.wgsl`,
                        data: `// ${postProcessProvenance}
${composed.wgsl}`,
                    });
                }
            }
            this.tree.write(
                "upstream/include/bblite/upstream/post_process_shaders.hpp",
                postProcessShadersHeader(
                    postProcessProvenance,
                    postProcessStages,
                    postProcessModules,
                ),
            );
        }
        const factories = new FactoryLowerer(context);
        if (features.includes("material:standard")) {
            this.writeSource(
                "upstream/src/material_standard.cpp",
                factories.lowerStandardMaterialFactory(),
                generated,
            );
        }
        if (features.includes("material:pbr")) {
            this.writeSource(
                "upstream/src/material_pbr.cpp",
                factories.lowerPbrMaterialFactory(),
                generated,
            );
        }
        if (features.includes("material:grid")) {
            this.writeSource(
                "upstream/src/material_grid.cpp",
                factories.lowerGridMaterialFactory(),
                generated,
            );
        }
        if (features.includes("texture:pixels")) {
            this.writeSource(
                "upstream/src/texture_pixels.cpp",
                factories.lowerPixelsTextureFactory(),
                generated,
            );
        }
        if (features.includes("material:shader")) {
            this.writeSource(
                "upstream/src/material_shader.cpp",
                factories.lowerShaderMaterialFactory(),
                generated,
            );
        }
        if (features.includes("material:node")) {
            this.writeSource(
                "upstream/src/material_node.cpp",
                factories.lowerNodeMaterialFactory(),
                generated,
            );
        }
        if (features.includes("material:no-color-view")) {
            this.writeSource(
                "upstream/src/material_views.cpp",
                factories.lowerNoColorMaterialViews(),
                generated,
            );
        }
        if (
            features.includes("mesh:box") ||
            features.includes("mesh:from-data") ||
            features.includes("mesh:ground") ||
            features.includes("mesh:morph-targets") ||
            features.includes("mesh:plane") ||
            features.includes("mesh:sphere") ||
            features.includes("mesh:thin-instances") ||
            features.includes("mesh:thin-instances-dynamic") ||
            features.includes("mesh:torus")
        ) {
            this.writeSource(
                "upstream/src/mesh_factories.cpp",
                factories.lowerMeshFactories(),
                generated,
            );
        }

        // The pin grows MAX_LIGHTS at run time when an asset carries more
        // punctual light nodes (`gltf-feature-lights-punctual.ts`,
        // `setMaxLights`). The constant is frozen here and the native light
        // writers stop at it, so the excess would render silently unlit —
        // refuse at generation, naming the asset and both counts.
        if (options.assetLightNodes !== undefined) {
            const maxLights = pinnedMaxLights(context);
            if (options.assetLightNodes.count > maxLights) {
                throw new Error(
                    `Asset ${options.assetLightNodes.asset} carries ` +
                        `${options.assetLightNodes.count} KHR_lights_punctual ` +
                        `light nodes, but the pinned MAX_LIGHTS is ` +
                        `${maxLights} and this port freezes it where the pin ` +
                        `grows the lights buffer (setMaxLights). Lights past ` +
                        `the constant would not shade; integrate the grown ` +
                        `constant or reduce the asset's light nodes.`,
                );
            }
        }

        // The pin's composed variants join the deployed shader set. They need
        // no specialization: the pinned Tint consumes their own
        // `@group`/`@binding` scheme unchanged for HLSL, MSL and SPIR-V, and
        // the HLSL register normalization already re-addresses them for
        // SDL_GPU's dense convention.
        if ((options.pinnedVariants ?? []).length > 0) {
            this.tree.write(
                "upstream/include/bblite/upstream/pbr_variants.hpp",
                pinnedPbrVariantsHeader(
                    context,
                    new RendererLowerer(context).compiledSceneUniformsWgsl(),
                    sceneUboBytes(context),
                    meshLightIndexWordOffset(context),
                    pinnedMaxLights(context),
                    "src/pinned-pbr-variant-cpp.ts pinnedPbrVariantsHeader",
                    options.pinnedVariants!,
                    ["hemispheric", "directional", "point", "spot"].filter(
                        (kind) => features.includes(`light:${kind}`),
                    ),
                    options.renderableMeshFeatures ?? [],
                    options.runtimeMeshFeatures,
                    options.pinnedMaterialCount,
                ),
            );
        }
        for (const variant of options.pinnedVariants ?? []) {
            composedShaders.push({
                output: `upstream/shaders/variant-${variant.vertex.replace(".wgsl", ".native.wgsl")}`,
                data: variant.vertexWgsl,
            });
            composedShaders.push({
                output: `upstream/shaders/variant-${variant.fragment.replace(".wgsl", ".native.wgsl")}`,
                data: variant.fragmentWgsl,
            });
        }
        // The Standard family's pinned variants, mirroring the PBR flow
        // above. The header carries the composed tables and lowered UBO
        // writers; the appended support block carries the selector and the
        // record-derived halves of its key; and for a scene with no PBR
        // variants the shared scene/lights/mesh mirrors are hoisted in too,
        // since they otherwise ride pbr_variants.hpp.
        if ((options.pinnedStandardVariants ?? []).length > 0) {
            // The mesh mirror must cover every composed variant's declaration:
            // the LINEAR_VELOCITY geometry arm appends previousWorld and
            // velocityEnabled after the light indices, and binding the base
            // 144-byte block to that variant is a validation error. The
            // largest declared struct is mirrored; the base variants read
            // its prefix, which is laid out identically.
            const widestStandardMesh = [...options.pinnedStandardVariants!]
                .sort((left, right) => {
                    const size = (text: string): number =>
                        /struct MeshUniforms\s*\{([\s\S]*?)\}/
                            .exec(text)?.[1]?.length ?? 0;
                    return size(right.fragmentWgsl) -
                        size(left.fragmentWgsl);
                })[0]!.fragmentWgsl;
            if (
                (options.pinnedVariants ?? []).length > 0 &&
                widestStandardMesh.includes("previousWorld")
            ) {
                throw new Error(
                    "A composed Standard velocity variant extends " +
                        "MeshUniforms past the PBR header's mirror; " +
                        "hoisting the widest struct for a scene that also " +
                        "emits pbr_variants.hpp is not wired yet.",
                );
            }
            const sharedMirrors = (options.pinnedVariants ?? []).length > 0
                ? ""
                : sharedPinnedMirrors(context, features, widestStandardMesh);
            this.tree.write(
                "upstream/include/bblite/upstream/standard_variants.hpp",
                pinnedStandardVariantsHeader(
                    context,
                    "src/pinned-pbr-variant-cpp.ts " +
                        "pinnedStandardVariantsHeader",
                    options.pinnedStandardVariants!,
                ) + sharedMirrors + pinnedStandardSupportBlock(context, {
                    selectors: options.pinnedStandardSelectors ?? [],
                    renderableMeshFeatures:
                        options.standardRenderableMeshFeatures ?? [],
                    runtimeMeshFeatures:
                        options.standardRuntimeMeshFeatures,
                }),
            );
            for (const variant of options.pinnedStandardVariants!) {
                // Deployed under the `variant-` prefix so
                // tools/compile-shaders.ps1 takes its pinned-variant arm
                // (Babylon's own `main` entry points, the register remap,
                // the `.slots` sidecar) exactly as it does for the PBR
                // stages.
                composedShaders.push({
                    output: `upstream/shaders/variant-std-${
                        variant.vertex.replace(".wgsl", ".native.wgsl")
                    }`,
                    data: variant.vertexWgsl,
                });
                composedShaders.push({
                    output: `upstream/shaders/variant-std-${
                        variant.fragment.replace(".wgsl", ".native.wgsl")
                    }`,
                    data: variant.fragmentWgsl,
                });
            }
        }
        if ((options.nodeVariants ?? []).length > 0) {
            // A node graph declares its own mesh block, but the per-pass
            // scene and lights blocks are the same ones the other two
            // composed families read, so a node-only scene hoists them here
            // exactly as a Standard-only scene hoists them into its own
            // header.
            // A node graph declares its own mesh block, but the per-pass
            // scene and lights blocks are the same ones the other two
            // composed families read, so a node-only scene hoists them.
            const sharedNodeMirrors =
                (options.pinnedVariants ?? []).length > 0 ||
                    (options.pinnedStandardVariants ?? []).length > 0
                    ? ""
                    : sharedPinnedMirrors(context, features);
            this.tree.write(
                "upstream/include/bblite/upstream/node_variants.hpp",
                pinnedNodeVariantsHeader(
                    "src/pinned-node-material-cpp.ts " +
                        "pinnedNodeVariantsHeader",
                    options.nodeVariants!,
                ) + sharedNodeMirrors,
            );
            for (const variant of options.nodeVariants!) {
                // One module carries both stages, so it deploys twice --
                // once per entry point, the way a composed post-process
                // pass does. The `node-` prefix is what makes
                // tools/compile-shaders.ps1 take the pin's own group
                // scheme through the register remap and publish the
                // `.slots` sidecar the SDL PAL binds against.
                for (
                    const stem of [variant.vertexStem, variant.fragmentStem]
                ) {
                    composedShaders.push({
                        output: `upstream/shaders/${stem}.native.wgsl`,
                        data: variant.composed.wgsl,
                    });
                }
            }
        }
        if (composedShaders.length > 0) {
            for (const shader of composedShaders) {
                this.tree.write(shader.output, shader.data);
            }
            this.tree.write(
                "upstream/shaders/composition.json",
                `${JSON.stringify(
                    {
                        modules: composedShaders
                            .filter(({ output }) =>
                                output.endsWith(".wgsl"))
                            .map(({ output, data }) => ({
                                output,
                                sha256: createHash("sha256")
                                    .update(data)
                                    .digest("hex"),
                            })),
                    },
                    null,
                    2,
                )}\n`,
            );
        }

        // The table in generated-sources.ts decides which sources a feature
        // set reaches, and the manifest and CMake feature list are built
        // from it. Checking the emission against it in both directions is
        // what keeps them from drifting: a source emitted but not declared
        // never reaches the build, and one declared but not emitted fails
        // the configure with a missing file.
        const declared = new Set(
            reachedGeneratedSources(features),
        );
        const missing = [...declared].filter(
            (source) => !this.emitted.has(source),
        );
        const undeclared = [...this.emitted].filter(
            (source) => !declared.has(source),
        );
        if (missing.length > 0 || undeclared.length > 0) {
            throw new Error(
                "Generated source table disagrees with what was emitted" +
                    (missing.length > 0
                        ? `; declared but not emitted: ${missing.join(", ")}`
                        : "") +
                    (undeclared.length > 0
                        ? `; emitted but not declared: ${undeclared.join(", ")}`
                        : "") +
                    ". Update src/generated-sources.ts alongside the emitter.",
            );
        }

        this.tree.write(
            "upstream/provenance.json",
            `${JSON.stringify({ package: this.store.pin, generated }, null, 2)}\n`,
        );
    }

    private writeSource(
        relativeSource: string,
        lowered: LoweredSource,
        generated: Array<{ modulePath: string; symbolName: string }>,
        relativeHeader?: string,
    ): void {
        this.emitted.add(relativeSource);
        this.tree.write(relativeSource, lowered.source);
        if (relativeHeader && lowered.header) {
            this.tree.write(relativeHeader, lowered.header);
        }
        generated.push({ modulePath: lowered.modulePath, symbolName: lowered.symbolName });
    }
}

/**
 * The Dawn backend's utility WGSL, lifted from the pinned package's own
 * string literals instead of living as C++ strings invisible to shader
 * provenance: the mip generator's fullscreen blit
 * (`texture/generate-mipmaps.ts` BLIT_SHADER), the transmission
 * scene-colour grab (`frame-graph/transmission.ts` BLIT_MSAA_SHADER),
 * and the per-sample image processing
 * (`frame-graph/image-processing-task.ts` `common` + its two fragments).
 *
 * Two mechanical re-homings, each asserted so a pinned change fails
 * generation: the entry points take this repository's
 * mainVertex/mainFragment names (tools/compile-shaders.ps1 keys the Tint
 * entry point on them), and each pinned module splits into one file per
 * stage so a stage never declares bindings it does not read (the compile
 * script cross-checks declared bindings against Tint's reflection). The
 * single-sample variants — reached under BBLITE_MSAA=1, where there is
 * one sample and nothing to average — substitute the plain-texture
 * binding and a plain load exactly as the pin's own non-MSAA arms do.
 */
function pinnedTextSlice(
    text: string,
    what: string,
    from: string,
    to?: string,
): string {
    const start = text.indexOf(from);
    if (start < 0) {
        throw new Error(`Pinned ${what} no longer contains '${from}'.`);
    }
    if (to === undefined) return text.slice(start);
    const end = text.indexOf(to, start);
    if (end < 0) {
        throw new Error(`Pinned ${what} no longer contains '${to}'.`);
    }
    return text.slice(start, end);
}

function renameEntryPoint(
    stage: string,
    what: string,
    pinnedName: string,
    nativeName: string,
): string {
    const marker = `fn ${pinnedName}(`;
    if (!stage.includes(marker)) {
        throw new Error(
            `Pinned ${what} no longer declares '${marker}'.`,
        );
    }
    return stage.split(marker).join(`fn ${nativeName}(`);
}

export interface DawnUtilityShaders {
    mipBlitVertex: string;
    mipBlitFragment: string;
    grabVertex: string;
    grabFragment: string;
    grabFragmentSingle: string;
    imageProcessingVertex: string;
    imageProcessingFragment: string;
    imageProcessingFragmentSingle: string;
}

export function dawnUtilityShaders(
    transmission: boolean,
): DawnUtilityShaders {
    // The mip generator's blit: bindings, varying struct, one stage each.
    const mipBlit = extractPackagedTemplateLiteral(
        readPinnedLibraryModule("texture/generate-mipmaps.js"),
        "BLIT_SHADER",
    );
    const mipProvenance =
        "// src/texture/generate-mipmaps.ts BLIT_SHADER, split per stage" +
        " with native entry-point names.\n";
    const mipStruct = pinnedTextSlice(
        mipBlit,
        "mip blit",
        "struct V{",
        "@vertex",
    );
    const mipBindings = pinnedTextSlice(
        mipBlit,
        "mip blit",
        "@group(0)@binding(0)",
        "struct V{",
    );
    const mipVertexStage = pinnedTextSlice(
        mipBlit,
        "mip blit",
        "@vertex fn vs(",
        "@fragment",
    );
    const mipFragmentStage = pinnedTextSlice(
        mipBlit,
        "mip blit",
        "@fragment fn fs(",
    );
    const shaders: DawnUtilityShaders = {
        mipBlitVertex:
            mipProvenance +
            mipStruct +
            renameEntryPoint(
                mipVertexStage,
                "mip blit vertex",
                "vs",
                "mainVertex",
            ),
        mipBlitFragment:
            mipProvenance +
            mipBindings +
            mipStruct +
            renameEntryPoint(
                mipFragmentStage,
                "mip blit fragment",
                "fs",
                "mainFragment",
            ),
        grabVertex: "",
        grabFragment: "",
        grabFragmentSingle: "",
        imageProcessingVertex: "",
        imageProcessingFragment: "",
        imageProcessingFragmentSingle: "",
    };
    if (!transmission) return shaders;

    // The scene-colour grab: the pin's per-texel sample average with
    // manual bilinear filtering, read straight from the multisampled
    // attachment.
    const grab = extractPackagedTemplateLiteral(
        readPinnedLibraryModule("frame-graph/transmission.js"),
        "BLIT_MSAA_SHADER",
    );
    const grabProvenance =
        "// src/frame-graph/transmission.ts BLIT_MSAA_SHADER, split per" +
        " stage with native entry-point names.\n";
    const grabBinding = pinnedTextSlice(
        grab,
        "transmission grab",
        "@group(0)@binding(0)var t:texture_multisampled_2d<f32>;",
        "struct V{",
    );
    const grabStruct = pinnedTextSlice(
        grab,
        "transmission grab",
        "struct V{",
        "@vertex",
    );
    const grabVertexStage = pinnedTextSlice(
        grab,
        "transmission grab",
        "@vertex fn vs(",
        "fn l(",
    );
    const grabAverage = pinnedTextSlice(
        grab,
        "transmission grab",
        "fn l(",
        "@fragment",
    );
    const grabFragmentStage = pinnedTextSlice(
        grab,
        "transmission grab",
        "@fragment fn fs(",
    );
    shaders.grabVertex =
        grabProvenance +
        grabStruct +
        renameEntryPoint(
            grabVertexStage,
            "transmission grab vertex",
            "vs",
            "mainVertex",
        );
    const grabFragment = renameEntryPoint(
        grabFragmentStage,
        "transmission grab fragment",
        "fs",
        "mainFragment",
    );
    shaders.grabFragment =
        grabProvenance + grabBinding + grabStruct + grabAverage +
        grabFragment;
    // The single-sample arm (BBLITE_MSAA=1): one sample, nothing to
    // average, so the binding is an ordinary texture and the fetch a
    // plain load; the manual bilinear body is the same pinned text.
    shaders.grabFragmentSingle =
        grabProvenance +
        "// Single-sample arm: the multisampled binding and the sample\n" +
        "// average reduce to a plain texture and a plain load.\n" +
        grabBinding.replace(
            "texture_multisampled_2d<f32>",
            "texture_2d<f32>",
        ) +
        grabStruct +
        "fn l(p:vec2i)->vec4f{return textureLoad(t,p,0);}" +
        grabFragment;

    // Per-sample image processing: exposure, optional tonemap, gamma,
    // contrast applied per MSAA sample, then averaged.
    const imageProcessing = readPinnedLibraryModule(
        "frame-graph/image-processing-task.js",
    );
    const ipProvenance =
        "// src/frame-graph/image-processing-task.ts shader text, split" +
        " per stage with native entry-point names.\n";
    const common = extractPackagedTemplateLiteral(
        imageProcessing,
        "common",
    );
    const ipStruct = "struct P{e:f32,c:f32,t:f32,p:f32}";
    const ipBinding = "@group(0)@binding(0)var<uniform> p:P;";
    if (
        !common.includes(ipStruct) ||
        !common.includes(ipBinding)
    ) {
        throw new Error(
            "Pinned image-processing parameter block changed.",
        );
    }
    const ip = extractWgslFunction(common, "ip");
    const ipVertexStage = pinnedTextSlice(
        common,
        "image processing",
        "@vertex fn vs(",
        "fn ip(",
    );
    const declarations = {
        multisampled:
            "@group(0)@binding(1)var s:texture_multisampled_2d<f32>;",
        single: "@group(0)@binding(1)var s:texture_2d<f32>;",
    };
    for (const declaration of Object.values(declarations)) {
        if (!imageProcessing.includes(declaration)) {
            throw new Error(
                "Pinned image-processing texture declaration changed.",
            );
        }
    }
    const fragments = [
        ...imageProcessing.matchAll(/`(@fragment fn fs[^`]*)`/g),
    ].map((match) => match[1]!);
    if (fragments.length !== 2) {
        throw new Error(
            "Pinned image-processing no longer carries exactly two " +
                "fragment arms.",
        );
    }
    const multisampledFragment = fragments.find((fragment) =>
        fragment.includes("textureNumSamples"),
    );
    const singleFragment = fragments.find(
        (fragment) => !fragment.includes("textureNumSamples"),
    );
    if (!multisampledFragment || !singleFragment) {
        throw new Error(
            "Pinned image-processing fragment arms changed shape.",
        );
    }
    shaders.imageProcessingVertex =
        ipProvenance +
        renameEntryPoint(
            ipVertexStage.trim() + "\n",
            "image processing vertex",
            "vs",
            "mainVertex",
        );
    shaders.imageProcessingFragment =
        ipProvenance +
        `${ipStruct}\n${ipBinding}\n${ip}\n` +
        `${declarations.multisampled}\n` +
        renameEntryPoint(
            multisampledFragment,
            "image processing fragment",
            "fs",
            "mainFragment",
        );
    shaders.imageProcessingFragmentSingle =
        ipProvenance +
        `${ipStruct}\n${ipBinding}\n${ip}\n` +
        `${declarations.single}\n` +
        renameEntryPoint(
            singleFragment,
            "image processing single-sample fragment",
            "fs",
            "mainFragment",
        );
    return shaders;
}

export function emitUpstreamGenerated(
    outputRoot: string,
    features: string[],
    options: UpstreamEmitOptions = {
        idDiagnostics: false,
        shaderPrograms: [],
        spriteCustomShaders: [],
        plainSpriteLayer: true,
        plainBillboardSystem: true,
        geometryOutputTasks: [],
        postProcessTasks: [],
        postProcessShaders: [],
        postProcessComposites: [],
        gpuDeformation: false,
        animatedWorldBounds: false,
        morphStorage: false,
        nonTrianglePrimitives: false,
        nodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        materialSpecular: false,
        selectedMaterialVariant: "",
        standardLights: 0,
        standardLightLists: false,
        standardDiffuseUv2: false,
        standardBump: false,
        textureTransform: false,
        imageBasedLighting: false,
        gpuInstancing: false,
        punctualLights: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        specularGlossiness: false,
        dispersion: false,
        occlusionUv2: false,
    },
    tree = new GeneratedTree(outputRoot),
): void {
    new GeneratedSourceWriter(tree, new UpstreamSourceStore()).emit(
        features,
        options,
    );
}

/**
 * The layout each reached post-process stage declares.
 *
 * Both backends need it before they can build a bind group, and the values
 * come from the pin's own composition — `_shader.uniformByteLength` and the
 * binding `getUniformBinding` derived — rather than from reading the WGSL
 * back. SDL_GPU still binds by the `.slots` sidecar the compaction wrote;
 * this says whether a block exists at all and how large it is.
 */
function postProcessShadersHeader(
    provenance: string,
    shaders: readonly ComposedPostProcess[],
    modules: ReadonlyMap<string, number>,
): string {
    const rows = shaders
        .map(
            (shader) =>
                `    PostProcessShaderInfo{${shader.uniformByteLength}u, ` +
                `${shader.uniformBinding}u, ` +
                `${modules.get(shader.wgsl)!}u},`,
        )
        .join("\n");
    return `// ${provenance}
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace bbl::upstream {

struct PostProcessShaderInfo {
    /** The block's size, rounded by the pin's own align16. */
    std::uint32_t uniform_byte_length = 0;
    /** The binding the pin's own getUniformBinding gives it. */
    std::uint32_t uniform_binding = 0;
    /**
     * The deployed module this pass loads, shared with every other pass whose
     * composed text came out identical.
     */
    std::uint32_t module_index = 0;
};

inline constexpr std::size_t post_process_shader_count = ${shaders.length}u;

inline constexpr std::array<PostProcessShaderInfo, post_process_shader_count>
    post_process_shader_infos{{
${rows}
}};

} // namespace bbl::upstream
`;
}
