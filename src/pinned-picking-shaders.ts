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

/**
 * One vertex projection's shader half, as `picking-advanced-shader.ts`
 * declares it. Only the regular arm is read here: the thin arm belongs to
 * a thin-instanced candidate, which the detailed pipeline refuses.
 */
interface PickingVertexProjectionShader {
    regularDeclarations: string;
    regularInputs: string;
    regularBody: string;
}

interface DetailedPipelineExports {
    shader(
        rule: null,
        projection: PickingVertexProjectionShader | null,
    ): string;
}

/** The pinned module that builds a deforming mesh's pick projection. */
const deformProjectionModule = "picking/deform-picking-projection.js";

interface DeformProjectionExports {
    getDeformPickingProjection(
        engine: unknown,
        mesh: unknown,
    ): { shader: PickingVertexProjectionShader } | null;
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
 * The DETAILED mesh picking module of a DEFORMING candidate.
 *
 * The same pinned builder as above, handed the pin's own deform vertex
 * projection instead of null. `deform-picking-projection.ts` is where
 * upstream keeps it -- a lazily imported module the picker reaches only
 * when a candidate carries a skeleton or morph targets -- and its whole
 * point is stated in its own header: the skinning WGSL is imported from
 * the shared render fragment rather than restated, "so the pick pose can
 * never drift from the rendered pose". Executing it keeps that property
 * here; transcribing the projection would give it up.
 *
 * The projection is built for a mesh that skins from FOUR influences:
 * `GpuVertex` holds one joint/weight quad, and the eight-influence tail
 * is already the recorded `four-influence-skinning` adaptation. `morph`
 * is the scene's morph-storage transport rather than one mesh's target
 * list, which is what lets one composed arm serve every deforming mesh
 * in a scene: both backends bind the storage pair for every one of them,
 * an empty weights header for a mesh with no targets of its own, and
 * that header's `count` of zero makes the pin's accumulation loop a
 * no-op. A scene whose assets carry no targets at all composes the pin's
 * `nomorph` arm instead, whose group is the bone palette alone --
 * both backends size their bind group to the composed arm rather than to
 * the morph one.
 *
 * The stub device records nothing: `createProjection` builds a bind-group
 * layout and this reads only the WGSL beside it, so the object merely has
 * to exist and stay identity-stable WITHIN the one call, which is what
 * the pin's own device-invalidation check compares against.
 */
export async function composeDeformDetailedMeshPickingShader(
    morph: boolean,
): Promise<string> {
    const projections =
        await importPinnedModule<DeformProjectionExports>(
            deformProjectionModule,
        );
    const device = { createBindGroupLayout: () => ({}) };
    const projection = projections.getDeformPickingProjection(
        { _device: device },
        {
            vat: null,
            skeleton: {
                joints1Buffer: null,
                weights1Buffer: null,
            },
            morphTargets: morph ? {} : null,
        },
    );
    if (!projection) {
        throw new Error(
            "The pinned deform picking projection declined a mesh " +
                "carrying a skeleton.",
        );
    }
    const pinned =
        await importPinnedModuleWithExports<DetailedPipelineExports>(
            detailedPipelineModule,
            ["shader"],
        );
    return pinned.shader(null, projection.shader);
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
