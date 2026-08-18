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
import { SpriteLowerer } from "./lowering/sprite-lowerer.js";
import {
    spriteFragmentWgsl,
    spriteVertexWgsl,
} from "./shader-builtins-sprite.js";
import { GeometryOutputLowerer } from "./lowering/geometry-output-lowerer.js";
import { AnimationLowerer } from "./lowering/animation-lowerer.js";
import { UpstreamSourceStore } from "./upstream-source.js";
import { GeneratedTree } from "./generated-tree.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import {
    materialTextureSlotsHeader,
    meshUniformsBlock,
    lightUniformsBlock,
    pinnedPbrVariantsHeader,
    pinnedStandardVariantsHeader,
    sceneUniformsStruct,
} from "./pinned-pbr-variant-cpp.js";
import type { PinnedVariantManifestEntry } from "./pinned-pbr-variant-output.js";
import {
    pinnedStandardSupportBlock,
    type PinnedStandardSelector,
    type PinnedStandardVariantManifestEntry,
} from "./pinned-standard-variants.js";

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
import type {
    CompiledShaderProgram,
    GeometryOutputTaskManifest,
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
    animationPointer: boolean;
    animationPointerMaterials: boolean;
    assetTransmission: boolean;
    materialSpecular: boolean;
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
    sheenAlbedoScaling: boolean;
    clearcoatF0Remap: boolean;
    /** The pin's own helper declarations; see `pinnedShaderHelpers()`. */
    pinnedHelpers?: Readonly<Record<string, string>>;
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
     * stages. Nothing sets this yet: the transcribed standard fragment stays
     * live until wave D wires the PALs over, so the default-absent option
     * keeps the generated tree byte-identical.
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
    /** The runtime material-handle count the variant gate checks. */
    pinnedMaterialCount?: number;
    /** The mesh attribute bits per runtime mesh handle, creation-ordered. */
    renderableMeshFeatures?: readonly number[];
    /** The bits for meshes created past the static table, when one value
     *  covers every scene-code builder; undefined refuses them. */
    runtimeMeshFeatures?: number;
    iridescence: boolean;
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
#define BBLITE_MATERIAL_OCCLUSION_UV2 ${options.occlusionUv2 ? 1 : 0}
#define BBLITE_MATERIAL_STANDARD_BUMP ${options.standardBump ? 1 : 0}
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
                    occlusionUv2: options.occlusionUv2,
                    standardBump: options.standardBump,
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
                composedShaders.push(
                    {
                        output:
                            "upstream/shaders/sprite.vert.native.wgsl",
                        data: spriteVertexWgsl(
                            provenance,
                            shader,
                        ),
                    },
                    {
                        output:
                            "upstream/shaders/sprite.frag.native.wgsl",
                        data: spriteFragmentWgsl(
                            provenance,
                            shader,
                        ),
                    },
                );
                generated.push({
                    modulePath: "src/sprite/sprite-pipeline.ts",
                    symbolName:
                        "makeSpritePrologueWgsl,makeSpriteWgsl,buildSpriteLayerUbo",
                });
            }
        }
        if (features.includes("renderer:pbr")) {
            const renderer = new RendererLowerer(context);
            this.writeSource(
                "upstream/src/renderer_plan.cpp",
                renderer.lowerRenderPlan({
                    transmission: transmission,
                    fog: features.includes("renderer:fog"),
                    imageSkybox: features.includes(
                        "background:image-skybox",
                    ),
                    solidSkybox: features.includes(
                        "background:solid-skybox",
                    ),
                    textureTransform:
                        options.textureTransform,
                    materialSpecular: options.materialSpecular,
                    occlusionUv2: options.occlusionUv2,
                    environmentRotation:
                        options.imageBasedLighting,
                    gpuInstancing:
                        options.gpuInstancing,
                    punctualLights:
                        options.punctualLights,
                    clearcoat: options.clearcoat,
                    sheen: options.sheen,
                    sheenAlbedoScaling:
                        options.sheenAlbedoScaling,
                    clearcoatF0Remap:
                        options.clearcoatF0Remap,
                    ...(options.pinnedHelpers === undefined
                        ? {}
                        : {
                            pinnedHelpers:
                                options.pinnedHelpers,
                        }),
                    iridescence: options.iridescence,
                    dispersion: options.dispersion,
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
                normalTextureScale: features.includes("loader:gltf"),
                shaderPrograms: options.shaderPrograms,
                gridMaterial: features.includes("material:grid"),
                idDiagnostics: options.idDiagnostics,
                geometryOutputTasks: options.geometryOutputTasks,
                frameGraph: features.includes("renderer:geometry-output"),
                gpuDeformation: options.gpuDeformation,
                morphStorage: options.morphStorage,
                textureTransform:
                    options.textureTransform,
                materialSpecular: options.materialSpecular,
                environmentRotation:
                    options.imageBasedLighting,
                gpuInstancing:
                    options.gpuInstancing,
                punctualLights:
                    options.punctualLights,
                clearcoat: options.clearcoat,
                sheen: options.sheen,
                sheenAlbedoScaling: options.sheenAlbedoScaling,
                clearcoatF0Remap: options.clearcoatF0Remap,
                ...(options.pinnedHelpers === undefined
                    ? {}
                    : {
                        pinnedHelpers:
                            options.pinnedHelpers,
                    }),
                iridescence: options.iridescence,
                dispersion: options.dispersion,
                occlusionUv2: options.occlusionUv2,
            });
            composedShaders.push(...shaders);
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
        if (features.includes("material:shader")) {
            this.writeSource(
                "upstream/src/material_shader.cpp",
                factories.lowerShaderMaterialFactory(),
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
                : `
// ---------------------------------------------------------------------------
// The shared pinned scene/lights/mesh blocks, hoisted for a scene that emits
// no pbr_variants.hpp (both families' composed stages declare the same three
// blocks; a TU never sees this and the PBR copy together, the capability
// defines gate the includes).
${
                    ["hemispheric", "directional", "point", "spot"].some(
                        (kind) => features.includes(`light:${kind}`),
                    )
                        ? "#include <bblite/upstream/light_matrix.hpp>\n"
                        : ""
                }
namespace bbl::upstream {

using bbl::LightRecord;
using bbl::LightKind;

${
                    sceneUniformsStruct(
                        new RendererLowerer(context)
                            .compiledSceneUniformsWgsl(),
                        sceneUboBytes(context),
                    )
                }

${
                    lightUniformsBlock(
                        context,
                        pinnedMaxLights(context),
                        ["hemispheric", "directional", "point", "spot"]
                            .filter(
                                (kind) =>
                                    features.includes(`light:${kind}`),
                            ),
                    )
                }

${
                    meshUniformsBlock(
                        widestStandardMesh,
                        meshLightIndexWordOffset(context),
                    )
                }

} // namespace bbl::upstream
`;
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

export function emitUpstreamGenerated(
    outputRoot: string,
    features: string[],
    options: UpstreamEmitOptions = {
        idDiagnostics: false,
        shaderPrograms: [],
        geometryOutputTasks: [],
        gpuDeformation: false,
        animatedWorldBounds: false,
        morphStorage: false,
        nonTrianglePrimitives: false,
        nodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        materialSpecular: false,
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
        sheenAlbedoScaling: false,
        clearcoatF0Remap: false,
        iridescence: false,
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
