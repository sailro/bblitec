import { createHash } from "node:crypto";
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
import { GeometryOutputLowerer } from "./lowering/geometry-output-lowerer.js";
import { AnimationLowerer } from "./lowering/animation-lowerer.js";
import { UpstreamSourceStore } from "./upstream-source.js";
import { GeneratedTree } from "./generated-tree.js";
import { reachedGeneratedSources } from "./generated-sources.js";
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
    pbrDiagnostics: boolean;
    shaderPrograms: CompiledShaderProgram[];
    geometryOutputTasks: GeometryOutputTaskManifest[];
    gpuDeformation: boolean;
    morphStorage: boolean;
    nonTrianglePrimitives: boolean;
    nodeVisibility: boolean;
    animationPointer: boolean;
    standardLights: number;
    standardLightLists: boolean;
    standardDiffuseUv2: boolean;
    standardBump: boolean;
    textureTransform: boolean;
    imageBasedLighting: boolean;
    gpuInstancing: boolean;
    multiLight: boolean;
    clearcoat: boolean;
    sheen: boolean;
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
        this.tree.write(
            "upstream/include/bblite/upstream/render_capabilities.hpp",
            `#pragma once

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
`,
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
                    options.gpuDeformation,
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
            features.includes("environment:hdr")
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
        }
        if (
            features.includes("light:hemispheric") ||
            features.includes("light:directional")
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
                    options.gpuDeformation,
                ),
                generated,
            );
            generated.push({
                modulePath: "src/loader-gltf/gltf-sampler-desc.ts",
                symbolName: "gltfTexSamplerDesc",
            });
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
        if (features.includes("renderer:pbr")) {
            const renderer = new RendererLowerer(context);
            this.writeSource(
                "upstream/src/renderer_plan.cpp",
                renderer.lowerRenderPlan({
                    transmission: features.includes("renderer:transmission"),
                    fog: features.includes("renderer:fog"),
                    imageSkybox: features.includes(
                        "background:image-skybox",
                    ),
                    textureTransform:
                        options.textureTransform,
                    environmentRotation:
                        options.imageBasedLighting,
                    gpuInstancing:
                        options.gpuInstancing,
                    multiLight:
                        options.multiLight,
                    clearcoat: options.clearcoat,
                    sheen: options.sheen,
                    iridescence: options.iridescence,
                    dispersion: options.dispersion,
                    nodeVisibility: options.nodeVisibility,
                    standardLights: options.standardLights,
                    standardLightLists: options.standardLightLists,
                    standardDiffuseUv2: options.standardDiffuseUv2,
                    standardBump: options.standardBump,
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
                transmission: features.includes("renderer:transmission"),
                fog: features.includes("renderer:fog"),
                normalTextureScale: features.includes("loader:gltf"),
                shaderPrograms: options.shaderPrograms,
                standardMaterial:
                    features.includes("material:standard") &&
                    features.includes("renderer:pbr"),
                standardVertexColors: features.includes(
                    "material:standard-vertex-colors",
                ),
                standardLights: options.standardLights,
                standardDiffuseUv2: options.standardDiffuseUv2,
                standardBump: options.standardBump,
                gridMaterial: features.includes("material:grid"),
                idDiagnostics: options.idDiagnostics,
                pbrDiagnostics: options.pbrDiagnostics,
                geometryOutputTasks: options.geometryOutputTasks,
                frameGraph: features.includes("renderer:geometry-output"),
                gpuDeformation: options.gpuDeformation,
                morphStorage: options.morphStorage,
                textureTransform:
                    options.textureTransform,
                environmentRotation:
                    options.imageBasedLighting,
                gpuInstancing:
                    options.gpuInstancing,
                multiLight:
                    options.multiLight,
                clearcoat: options.clearcoat,
                sheen: options.sheen,
                iridescence: options.iridescence,
                dispersion: options.dispersion,
                occlusionUv2: options.occlusionUv2,
            });
            for (const shader of shaders) {
                this.tree.write(shader.output, shader.data);
            }
            this.tree.write(
                "upstream/shaders/composition.json",
                `${JSON.stringify(
                    {
                        modules: shaders
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
        pbrDiagnostics: false,
        shaderPrograms: [],
        geometryOutputTasks: [],
        gpuDeformation: false,
        morphStorage: false,
        nonTrianglePrimitives: false,
        nodeVisibility: false,
        animationPointer: false,
        standardLights: 0,
        standardLightLists: false,
        standardDiffuseUv2: false,
        standardBump: false,
        textureTransform: false,
        imageBasedLighting: false,
        gpuInstancing: false,
        multiLight: false,
        clearcoat: false,
        sheen: false,
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
