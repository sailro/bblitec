import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CameraLowerer } from "./lowering/camera-lowerer.js";
import { LoweredSource, LoweringContext } from "./lowering/context.js";
import { EnvironmentLowerer } from "./lowering/environment-lowerer.js";
import { EngineLowerer } from "./lowering/engine-lowerer.js";
import { LightLowerer } from "./lowering/light-lowerer.js";
import { SceneLowerer } from "./lowering/scene-lowerer.js";
import { GltfLowerer } from "./lowering/gltf-lowerer.js";
import { UpstreamSourceStore } from "./upstream-source.js";

export type { LoweredSource } from "./lowering/context.js";

export function lowerLightMatrix(store = new UpstreamSourceStore()): LoweredSource {
    return new LightLowerer(new LoweringContext(store)).lowerMatrix();
}

export function lowerHemisphericFactory(store = new UpstreamSourceStore()): LoweredSource {
    return new LightLowerer(new LoweringContext(store)).lowerFactory();
}

export function lowerArcRotateFactory(store = new UpstreamSourceStore()): LoweredSource {
    return new CameraLowerer(new LoweringContext(store)).lowerArcRotateFactory();
}

export function lowerDefaultCameraFactory(store = new UpstreamSourceStore()): LoweredSource {
    return new CameraLowerer(new LoweringContext(store)).lowerDefaultFactory();
}

export function lowerEnvParser(store = new UpstreamSourceStore()): LoweredSource {
    return new EnvironmentLowerer(new LoweringContext(store)).lowerParser();
}

class GeneratedSourceWriter {
    public constructor(
        private readonly outputRoot: string,
        private readonly store: UpstreamSourceStore,
    ) {}

    public emit(features: string[]): void {
        const context = new LoweringContext(this.store);
        const generated: Array<{ modulePath: string; symbolName: string }> = [];

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

        if (features.includes("camera:arc-rotate") || features.includes("camera:default")) {
            const cameraLowerer = new CameraLowerer(context);
            this.writeSource(
                "upstream/src/camera_arc_rotate.cpp",
                cameraLowerer.lowerArcRotateFactory(),
                generated,
            );
            this.writeSource(
                "upstream/src/camera_controls.cpp",
                cameraLowerer.lowerControls(),
                generated,
                "upstream/include/bblite/upstream/camera_controls.hpp",
            );
        }
        if (features.includes("camera:default")) {
            this.writeSource(
                "upstream/src/camera_default.cpp",
                new CameraLowerer(context).lowerDefaultFactory(),
                generated,
            );
        }
        if (features.includes("environment:ibl")) {
            this.writeSource(
                "upstream/src/env_parse.cpp",
                new EnvironmentLowerer(context).lowerParser(),
                generated,
                "upstream/include/bblite/upstream/env_parse.hpp",
            );
        }
        if (features.includes("light:hemispheric")) {
            const light = new LightLowerer(context);
            this.writeSource(
                "upstream/src/light_matrix.cpp",
                light.lowerMatrix(),
                generated,
                "upstream/include/bblite/upstream/light_matrix.hpp",
            );
            this.writeSource(
                "upstream/src/light_hemispheric.cpp",
                light.lowerFactory(),
                generated,
            );
        }
        if (features.includes("loader:gltf")) {
            this.writeSource(
                "upstream/src/gltf_glb_parser.cpp",
                new GltfLowerer(context).lowerGlbParser(),
                generated,
                "upstream/include/bblite/upstream/gltf_glb_parser.hpp",
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

export function emitUpstreamGenerated(outputRoot: string, features: string[]): void {
    new GeneratedSourceWriter(outputRoot, new UpstreamSourceStore()).emit(features);
}
