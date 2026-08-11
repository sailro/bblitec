import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
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
import type {
    GeometryOutputTaskManifest,
    ShaderMaterialVariantName,
} from "./compiler.js";

class GeneratedSourceWriter {
    public constructor(
        private readonly outputRoot: string,
        private readonly store: UpstreamSourceStore,
    ) {}

    public emit(
        features: string[],
        options: {
            idDiagnostics: boolean;
            pbrDiagnostics: boolean;
            shaderVariants: ShaderMaterialVariantName[];
            geometryOutputTasks: GeometryOutputTaskManifest[];
            gpuDeformation: boolean;
            textureTransform: boolean;
            imageBasedLighting: boolean;
            gpuInstancing: boolean;
            multiLight: boolean;
            clearcoat: boolean;
            sheen: boolean;
            iridescence: boolean;
            dispersion: boolean;
        },
    ): void {
        const context = new LoweringContext(this.store);
        const generated: Array<{ modulePath: string; symbolName: string }> = [];
        const capabilitiesPath = resolve(
            this.outputRoot,
            "upstream/include/bblite/upstream/render_capabilities.hpp",
        );
        mkdirSync(dirname(capabilitiesPath), { recursive: true });
        writeFileSync(
            capabilitiesPath,
            `#pragma once

#define BBLITE_GPU_DEFORMATION ${options.gpuDeformation ? 1 : 0}
#define BBLITE_GPU_INSTANCING ${options.gpuInstancing ? 1 : 0}
#define BBLITE_MATERIAL_CLEARCOAT ${options.clearcoat ? 1 : 0}
#define BBLITE_MATERIAL_SHEEN ${options.sheen ? 1 : 0}
#define BBLITE_MATERIAL_IRIDESCENCE ${options.iridescence ? 1 : 0}
#define BBLITE_MATERIAL_DISPERSION ${options.dispersion ? 1 : 0}
`,
        );

        this.writeSource(
            "upstream/src/engine.cpp",
            new EngineLowerer(context).lowerCore(),
            generated,
        );
        this.writeSource(
            "upstream/src/scene_core.cpp",
            new SceneLowerer(context).lowerCore(),
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
                new CameraLowerer(context).lowerDefaultFactory(),
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
                gltf.lowerLoaderAdapter(),
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
                new BabylonLowerer(context).lowerLoaderAdapter(),
                generated,
            );
        }
        if (features.includes("renderer:pbr")) {
            const renderer = new RendererLowerer(context);
            this.writeSource(
                "upstream/src/renderer_plan.cpp",
                renderer.lowerRenderPlan({
                    transmission: features.includes("renderer:transmission"),
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
                }),
                generated,
                "upstream/include/bblite/upstream/renderer_plan.hpp",
            );
            const shaders = renderer.lowerShaders({
                ground: features.includes("background:ground"),
                skybox: features.includes("background:skybox"),
                transmission: features.includes("renderer:transmission"),
                normalTextureScale: features.includes("loader:gltf"),
                shaderVariants: options.shaderVariants,
                standardMaterial:
                    features.includes("material:standard") &&
                    features.includes("renderer:pbr"),
                gridMaterial: features.includes("material:grid"),
                idDiagnostics: options.idDiagnostics,
                pbrDiagnostics: options.pbrDiagnostics,
                geometryOutputTasks: options.geometryOutputTasks,
                frameGraph: features.includes("renderer:geometry-output"),
                gpuDeformation: options.gpuDeformation,
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
            });
            for (const shader of shaders) {
                const shaderPath = resolve(this.outputRoot, shader.output);
                mkdirSync(dirname(shaderPath), { recursive: true });
                writeFileSync(shaderPath, shader.data);
            }
            writeFileSync(
                resolve(
                    this.outputRoot,
                    "upstream/shaders/composition.json",
                ),
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
            if (options.shaderVariants.length > 0) {
                writeFileSync(
                    resolve(
                        this.outputRoot,
                        "upstream/shaders/shader-material-reflection.json",
                    ),
                    `${JSON.stringify(
                        renderer.shaderMaterialReflections(
                            options.shaderVariants,
                        ),
                        null,
                        2,
                    )}\n`,
                );
            }
            writeFileSync(
                resolve(this.outputRoot, "upstream/renderer-fidelity.json"),
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
            features.includes("mesh:ground") ||
            features.includes("mesh:plane") ||
            features.includes("mesh:sphere") ||
            features.includes("mesh:torus")
        ) {
            this.writeSource(
                "upstream/src/mesh_factories.cpp",
                factories.lowerMeshFactories(),
                generated,
            );
        }

        const provenancePath = resolve(this.outputRoot, "upstream/provenance.json");
        mkdirSync(dirname(provenancePath), { recursive: true });
        writeFileSync(
            provenancePath,
            `${JSON.stringify({ package: this.store.pin, generated }, null, 2)}\n`,
        );
    }

    private writeSource(
        relativeSource: string,
        lowered: LoweredSource,
        generated: Array<{ modulePath: string; symbolName: string }>,
        relativeHeader?: string,
    ): void {
        const sourcePath = resolve(this.outputRoot, relativeSource);
        mkdirSync(dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, lowered.source);
        if (relativeHeader && lowered.header) {
            const headerPath = resolve(this.outputRoot, relativeHeader);
            mkdirSync(dirname(headerPath), { recursive: true });
            writeFileSync(headerPath, lowered.header);
        }
        generated.push({ modulePath: lowered.modulePath, symbolName: lowered.symbolName });
    }
}

export function emitUpstreamGenerated(
    outputRoot: string,
    features: string[],
    options: {
        idDiagnostics: boolean;
        pbrDiagnostics: boolean;
        shaderVariants: ShaderMaterialVariantName[];
        geometryOutputTasks: GeometryOutputTaskManifest[];
        gpuDeformation: boolean;
        textureTransform: boolean;
        imageBasedLighting: boolean;
        gpuInstancing: boolean;
        multiLight: boolean;
        clearcoat: boolean;
        sheen: boolean;
        iridescence: boolean;
        dispersion: boolean;
    } = {
        idDiagnostics: false,
        pbrDiagnostics: false,
        shaderVariants: [],
        geometryOutputTasks: [],
        gpuDeformation: false,
        textureTransform: false,
        imageBasedLighting: false,
        gpuInstancing: false,
        multiLight: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        dispersion: false,
    },
): void {
    new GeneratedSourceWriter(outputRoot, new UpstreamSourceStore()).emit(
        features,
        options,
    );
}
