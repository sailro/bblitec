/**
 * Lowerings a test reads as a right-handed program does. The compiler reads
 * the pin under its process's conditions (`compiler-node-flags.ts`), so a
 * left-handed test process runs these in a child started under
 * `babylon-lite-rh` (`right-handed-process.ts`), which prints their results.
 */
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { lowerCameraMatrixCaches } from "../src/lowering/camera-matrix-cache.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerRootedWorldCpp } from "../src/lowering/gltf/matrix-leaves.js";
import { lowerMeshFeatures } from "../src/lowering/mesh-attribute-features.js";
import { lowerPhysicsMesh } from "../src/lowering/physics-mesh-lowerer.js";
import { lowerPipelineFrontFaces } from "../src/lowering/pipeline-front-face.js";
import { lowerShaderSystemBlockFinish } from "../src/lowering/shader-system-cache.js";
import { isMainModule } from "../src/tooling/flags.js";
import { DoctoredStore } from "./doctored-store.js";

type Probe = (context: LoweringContext, argument?: string | boolean) => unknown;

const probes = {
    rightHanded: (context) => context.store.rightHanded(),
    pinnedSource: (context, module) => context.store.getSource(`${module}`),
    shaderSystemBlockFinish: (context) => lowerShaderSystemBlockFinish(context),
    pipelineFrontFaces: (context, mirroredMeshes) =>
        lowerPipelineFrontFaces(context, mirroredMeshes === true),
    cameraMatrixCaches: (context) => lowerCameraMatrixCaches(context, false),
    arcRotateFactory: (context) =>
        new CameraLowerer(context).lowerArcRotateFactory().source,
    meshFeatures: (context) => lowerMeshFeatures(context),
    physicsMeshHelpers: (context) => lowerPhysicsMesh(context).helpers,
    gltfRootedWorld: (context) =>
        lowerRootedWorldCpp(
            context.store.getSourceFile("src/loader-gltf/gltf-parser.ts"),
        ),
} satisfies Record<string, Probe>;

type RightHandedProbe = keyof typeof probes;

/** One probe run: its name, its argument, and exact edits to the pin it reads. */
export interface ProbeRequest {
    probe: RightHandedProbe;
    argument?: string | boolean;
    edits?: ReadonlyArray<readonly [string, readonly [string, string]]>;
}

export type ProbeOutcome = { value: unknown } | { error: string };

if (isMainModule(import.meta.url)) {
    const requests = JSON.parse(process.argv[2]!) as ProbeRequest[];
    const outcomes = requests.map(
        ({ probe, argument, edits = [] }): ProbeOutcome => {
            const run: Probe = probes[probe];
            try {
                return {
                    value: run(
                        new LoweringContext(
                            new DoctoredStore().withEdits(new Map(edits)),
                        ),
                        argument,
                    ),
                };
            } catch (error: unknown) {
                return {
                    error:
                        error instanceof Error ? error.message : String(error),
                };
            }
        },
    );
    process.stdout.write(JSON.stringify(outcomes));
}
