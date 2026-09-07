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
/** The pinned module that builds the advanced thin-instance mesh half. */
const advancedMeshShaderModule = "picking/picking-advanced-shader.js";
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

interface AdvancedMeshShaderExports {
    pickingThinInstanceShaderSource(options?: {
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
 * The mesh picking module for a thin-instanced candidate.
 *
 * `gpu-picker.ts` selects the advanced pipeline as soon as a candidate owns
 * `thinInstances`; that pipeline calls this exact public builder with an empty
 * options object for the no-filter, no-discard, affine arm. The resulting
 * vertex stage composes `mesh.world * instances[instanceIndex]`, assigns one
 * id per active row, and forwards the same fragment contract as the regular
 * picker.
 */
export async function composeThinInstancePickingShader(): Promise<string> {
    const pinned =
        await importPinnedModule<AdvancedMeshShaderExports>(
            advancedMeshShaderModule,
        );
    return pinned.pickingThinInstanceShaderSource({});
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
 * passes it: no discard rule and no vertex projection. Deforming
 * candidates use the separately composed projection variants below.
 */
export async function composeDetailedMeshPickingShader(): Promise<string> {
    const pinned =
        await importPinnedModuleWithExports<DetailedPipelineExports>(
            detailedPipelineModule,
            ["shader"],
        );
    return pinned.shader(null, null);
}

/** A reached arm of the pin's regular deformation projection. */
export interface DeformPickingShader {
    skeleton: boolean;
    morph: boolean;
    mesh: string;
    detailed?: string;
}

/**
 * Execute the pin's projection factory and pass its shader to both picking
 * builders. Four influence skinning uses the existing integer joint quad;
 * morph-only meshes must use the pin's noskin arm, which declares no palette.
 * The device stub serves only the factory's layout/cache identity checks.
 */
export async function composeDeformPickingShaders(options: {
    meshFeatures: readonly number[];
    skeleton: boolean;
    morph: boolean;
    detailed: boolean;
}): Promise<DeformPickingShader[]> {
    if (!options.skeleton && !options.morph) return [];
    const bits = await importPinnedModule<{
        MSH_HAS_SKELETON: number;
        MSH_HAS_MORPH_TARGETS: number;
    }>("material/mesh-features.js");
    const mask = (options.skeleton ? bits.MSH_HAS_SKELETON : 0) |
        (options.morph ? bits.MSH_HAS_MORPH_TARGETS : 0);
    const shapes = [...new Set(options.meshFeatures.map((word) => word & mask))]
        .filter((word) => word !== 0).sort((left, right) => left - right);
    if (shapes.length === 0) return [];
    const projections = await importPinnedModule<DeformProjectionExports>(
        deformProjectionModule,
    );
    const basic = await importPinnedModule<MeshShaderExports>(meshShaderModule);
    const detailed = options.detailed
        ? await importPinnedModuleWithExports<DetailedPipelineExports>(
              detailedPipelineModule, ["shader"],
          )
        : undefined;
    const engine = { _device: { createBindGroupLayout: () => ({}) } };
    const result: DeformPickingShader[] = [];
    for (const shape of shapes) {
        const skeleton = (shape & bits.MSH_HAS_SKELETON) !== 0;
        const morph = (shape & bits.MSH_HAS_MORPH_TARGETS) !== 0;
        const projection = projections.getDeformPickingProjection(engine, {
            vat: null,
            skeleton: skeleton ? { joints1Buffer: null, weights1Buffer: null } : null,
            morphTargets: morph ? {} : null,
        });
        if (!projection) throw new Error("The pinned deformation projection declined its reached arm.");
        result.push({
            skeleton, morph,
            mesh: basic.pickingShaderSource({ _vertexProjection: projection.shader }),
            ...(detailed ? { detailed: detailed.shader(null, projection.shader) } : {}),
        });
    }
    return result;
}

/** One layout/selection record per deployed projection, shared by both PALs. */
export function deformPickingHeader(variants: readonly DeformPickingShader[]): string {
    return `#pragma once
#include <array>
namespace bbl::upstream {
struct PickDeformVariant {
    bool skeleton;
    bool morph;
    const char* vertex;
    const char* detailed_vertex;
};
inline constexpr std::array<PickDeformVariant, ${variants.length}> pick_deform_variants{{
${variants.map((variant, index) => `    {${variant.skeleton}, ${variant.morph}, "picking-deform-${index}.vert", ${variant.detailed === undefined ? "nullptr" : `"picking-detailed-deform-${index}.vert"`}},`).join("\n")}
}};
}
`;
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
