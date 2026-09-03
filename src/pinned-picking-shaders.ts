/**
 * The two WGSL modules a GPU pick deploys, composed by the pin.
 *
 * Neither is written here. `pickingShaderSource` builds the mesh module
 * from five fragments its own file declares -- the scene block, the mesh
 * block, the discard input, a default `shouldDiscardPick` and the shared
 * fragment stage -- and its vertex stage forks on whether a deform
 * projection was supplied. `buildPickingWgsl` builds the cloud's module the
 * same way and then runs it through `applyGsFragments` with the pin's own
 * `gsGpuPickingFragment`, which is what replaces the alpha-blended colour
 * with the pick id and discards a transparent splat.
 *
 * So both are EXECUTED. Re-typing either would restate a splice, a
 * thirty-five-entry field mangler and two `?:` arms whose defaults are the
 * whole reason the module compiles -- and would agree with upstream only
 * until it moved. `buildPickingWgsl` is module-private, so it is re-exported
 * through the same `data:` URL rewrite every other pinned composition uses
 * rather than copied out.
 */
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "./pinned-shader-composer.js";

/** The pinned module that builds the mesh half. */
const meshShaderModule = "picking/picking-shader.js";
/** The pinned module that builds the cloud half. */
const cloudPipelineModule = "picking/gs-picking-pipeline.js";
/** The pinned module that builds a billboard system's half. */
const billboardPipelineModule = "picking/billboard-pick-pipeline.js";

interface MeshShaderExports {
    pickingShaderSource(options?: {
        discardWgsl?: string;
        storage?: readonly unknown[];
        _vertexProjection?: unknown;
    }): string;
}

interface CloudPipelineExports {
    buildPickingWgsl(detailed: boolean): string;
}

/** The pinned module that builds the DETAILED mesh half. */
const detailedPipelineModule = "picking/picking-detailed-pipeline.js";

interface DetailedPipelineExports {
    shader(rule: null, projection: null): string;
}

/** The orientations the pin's billboard basis forks on. */
export type BillboardPickOrientation = "facing" | "axis-locked";

interface BillboardPipelineExports {
    makeBillboardPickWgsl(
        orientation: BillboardPickOrientation,
        isCutout: boolean,
        detailed: boolean,
    ): string;
}

/**
 * The mesh picking module, at the reached slice: no discard predicate, no
 * storage bindings and no deform projection.
 *
 * Passing `{}` rather than nothing is deliberate -- it is what a pipeline
 * built with `getPickingPipelineSet(engine, null, null)` passes, so the
 * defaults that survive are the pin's own and not this port's reading of
 * them.
 */
export async function composeMeshPickingShader(): Promise<string> {
    const pinned = await importPinnedModule<MeshShaderExports>(
        meshShaderModule,
    );
    return pinned.pickingShaderSource({});
}

/**
 * The mesh picking module of the DETAILED pipeline.
 *
 * A different pinned MODULE rather than an option on the one above: the
 * pin keeps `picking-detailed-pipeline.ts` beside `picking-pipeline.ts`
 * and the picker dynamic-imports whichever `_detailedPicking` selected.
 * Its builder is module-private -- `getPickingPipelineSet` is the only
 * export -- so it is re-exported through the same `data:` URL rewrite
 * `buildPickingWgsl` takes rather than copied out. What that builder
 * writes and this port must not restate is the third attachment's
 * packing: `vec4u(primitiveIndex, bitcast<u32>(local.x), ...)` over a
 * varying the vertex stage forwards, plus the `enable primitive_index`
 * directive the fragment's builtin needs.
 *
 * `(null, null)` is what `getPickingPipelineSet(engine, null, null)`
 * passes it: no discard rule and no vertex projection, which is the
 * reached slice -- `pickAsync` refuses an options object, and a deform
 * projection needs the advanced pipeline this port does not compose.
 */
export async function composeDetailedMeshPickingShader(): Promise<string> {
    const pinned =
        await importPinnedModuleWithExports<DetailedPipelineExports>(
            detailedPipelineModule,
            ["shader"],
        );
    return pinned.shader(null, null);
}

/**
 * The Gaussian-cloud picking module.
 *
 * `false` is the non-detailed arm: the detailed one adds a third
 * `rgba32uint` attachment and the primitive index the barycentric readback
 * needs, which no reached scene composes.
 */
export async function composeCloudPickingShader(): Promise<string> {
    const pinned =
        await importPinnedModuleWithExports<CloudPipelineExports>(
            cloudPipelineModule,
            ["buildPickingWgsl"],
        );
    return pinned.buildPickingWgsl(false);
}

/**
 * One billboard system's picking module.
 *
 * The pin's own builder, for the same reason the other two are executed:
 * its vertex stage reproduces the RENDER shader's quad math term for term
 * -- corner, pivot, rotation, camera basis -- and a transcription that
 * drifted from it by one term would pick a pixel the renderer did not
 * draw. The basis is the one arm that forks, and it forks on the system's
 * orientation exactly as `makeBillboardBasisWgsl` does for the visible
 * stage.
 *
 * `false` for `detailed` is the same non-detailed arm the other two take;
 * `isCutout` is refused at generation rather than passed, because a cutout
 * system's pick draw binds the atlas its discard samples and no reached
 * scene composes one.
 */
export async function composeBillboardPickingShader(
    orientation: BillboardPickOrientation,
): Promise<string> {
    const pinned =
        await importPinnedModuleWithExports<BillboardPipelineExports>(
            billboardPipelineModule,
            ["makeBillboardPickWgsl"],
        );
    return pinned.makeBillboardPickWgsl(orientation, false, false);
}
