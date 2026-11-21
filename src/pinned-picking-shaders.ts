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
import { stringLiteral } from "./cpp-literals.js";
import { contentKey } from "./content-key.js";
import type { PickDiscardRuleManifest } from "./compiler/types.js";

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
        storage?: readonly { name: string; type: string }[];
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

/** What the pin's pick shader builders read of a `PickDiscardRule`. */
interface PickDiscardShaderRule {
    wgsl: string;
    storage: readonly { name: string; type: string }[];
}

interface DetailedPipelineExports {
    shader(
        rule: PickDiscardShaderRule | null,
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
type BillboardPickOrientation = "facing" | "axis-locked";

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
    const pinned =
        await importPinnedModule<MeshShaderExports>(meshShaderModule);
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
    const pinned = await importPinnedModule<AdvancedMeshShaderExports>(
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
    const pinned = await importPinnedModuleWithExports<DetailedPipelineExports>(
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
    const mask =
        (options.skeleton ? bits.MSH_HAS_SKELETON : 0) |
        (options.morph ? bits.MSH_HAS_MORPH_TARGETS : 0);
    const shapes = [...new Set(options.meshFeatures.map((word) => word & mask))]
        .filter((word) => word !== 0)
        .sort((left, right) => left - right);
    if (shapes.length === 0) return [];
    const projections = await importPinnedModule<DeformProjectionExports>(
        deformProjectionModule,
    );
    const basic = await importPinnedModule<MeshShaderExports>(meshShaderModule);
    const detailed = options.detailed
        ? await importPinnedModuleWithExports<DetailedPipelineExports>(
              detailedPipelineModule,
              ["shader"],
          )
        : undefined;
    const engine = { _device: { createBindGroupLayout: () => ({}) } };
    const result: DeformPickingShader[] = [];
    for (const shape of shapes) {
        const skeleton = (shape & bits.MSH_HAS_SKELETON) !== 0;
        const morph = (shape & bits.MSH_HAS_MORPH_TARGETS) !== 0;
        const projection = projections.getDeformPickingProjection(engine, {
            vat: null,
            skeleton: skeleton
                ? { joints1Buffer: null, weights1Buffer: null }
                : null,
            morphTargets: morph ? {} : null,
        });
        if (!projection)
            throw new Error(
                "The pinned deformation projection declined its reached arm.",
            );
        result.push({
            skeleton,
            morph,
            mesh: basic.pickingShaderSource({
                _vertexProjection: projection.shader,
            }),
            ...(detailed
                ? { detailed: detailed.shader(null, projection.shader) }
                : {}),
        });
    }
    return result;
}

/** One layout/selection record per deployed projection, shared by both PALs. */
export function deformPickingHeader(
    variants: readonly DeformPickingShader[],
): string {
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
    const pinned = await importPinnedModuleWithExports<CloudPipelineExports>(
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

/** The pinned module that builds a VAT mesh's pick projection. */
const vatProjectionModule = "picking/vat-picking-pipeline.js";

interface VatProjectionExports {
    getVatPickingProjection(
        engine: unknown,
        mesh: unknown,
    ): {
        key: string;
        shader: PickingVertexProjectionShader;
        vertexBuffers: readonly {
            arrayStride: number;
            attributes: readonly {
                shaderLocation: number;
                offset: number;
                format: string;
            }[];
        }[];
    } | null;
}

interface AdvancedVariantExports {
    pickingShaderVariantSource(
        thinInstance: boolean,
        options: {
            discardWgsl: string | undefined;
            worldAdjustWgsl: string | undefined;
            storage: readonly { name: string; type: string }[] | undefined;
            vertexDataComponents: number;
            exposeVertexData: boolean;
            detailed: boolean;
            _vertexProjection: unknown;
        },
    ): string;
}

/** A reached arm of the pin's VAT pick projection, and its picking module. */
export interface VatPickingShader {
    thin: boolean;
    instanceStorage: boolean;
    module: string;
}

/**
 * Execute the pin's VAT projection factory per reached arm and hand its
 * shader to the advanced builder, as `createPipeline` does for a basic
 * (non-detailed, rule-free) pick: a VAT candidate always takes the advanced
 * pipeline. Native vertices carry four joints, so every arm is the
 * four-bone one, and its two skin attributes are the native vertex's
 * joint and weight quads. A thin candidate reads its clip params from the
 * published instance storage or, without one, the instance texture.
 */
export async function composeVatPickingShaders(options: {
    regular: boolean;
    thinTexture: boolean;
    thinStorage: boolean;
}): Promise<VatPickingShader[]> {
    const arms = [
        ...(options.regular ? [[false, false] as const] : []),
        ...(options.thinTexture ? [[true, false] as const] : []),
        ...(options.thinStorage ? [[true, true] as const] : []),
    ];
    if (arms.length === 0) return [];
    const projections =
        await importPinnedModule<VatProjectionExports>(vatProjectionModule);
    const advanced = await importPinnedModule<AdvancedVariantExports>(
        advancedMeshShaderModule,
    );
    const result: VatPickingShader[] = [];
    for (const [thin, instanceStorage] of arms) {
        const projection = projections.getVatPickingProjection(
            { _device: { createBindGroupLayout: () => ({}) } },
            {
                vat: {
                    joints1Buffer: null,
                    weights1Buffer: null,
                    _instanceStorage: instanceStorage ? {} : undefined,
                    instanceTexture: thin && !instanceStorage ? {} : null,
                },
                thinInstances: thin ? {} : null,
            },
        );
        if (!projection)
            throw new Error(
                "The pinned VAT projection declined its reached arm.",
            );
        const skin = JSON.stringify(projection.vertexBuffers);
        if (
            skin !==
            JSON.stringify([
                {
                    arrayStride: 16,
                    attributes: [
                        { shaderLocation: 1, offset: 0, format: "uint32x4" },
                    ],
                },
                {
                    arrayStride: 16,
                    attributes: [
                        { shaderLocation: 2, offset: 0, format: "float32x4" },
                    ],
                },
            ])
        )
            throw new Error(
                `The pinned VAT projection reads other skin attributes: ${skin}.`,
            );
        result.push({
            thin,
            instanceStorage,
            module: advanced.pickingShaderVariantSource(thin, {
                discardWgsl: undefined,
                worldAdjustWgsl: undefined,
                storage: undefined,
                vertexDataComponents: 0,
                exposeVertexData: false,
                detailed: false,
                _vertexProjection: projection.shader,
            }),
        });
    }
    return result;
}

/** The deployed VAT arms, in the order both PALs select them. */
export function vatPickingHeader(
    variants: readonly VatPickingShader[],
): string {
    return `#pragma once
#include <array>
namespace bbl::upstream {
struct PickVatVariant {
    bool thin;
    bool instance_storage;
    const char* vertex;
    const char* fragment;
};
inline constexpr std::array<PickVatVariant, ${variants.length}> pick_vat_variants{{
${variants.map((variant, index) => `    {${variant.thin}, ${variant.instanceStorage}, "picking-vat-${index}.vert", "picking-vat-${index}.frag"},`).join("\n")}
}};
}
`;
}

/** One composed `discard` rule and the module each pick pipeline it reaches draws. */
export interface PickDiscardShader {
    rule: PickDiscardRuleManifest;
    /** Whether the rule takes the advanced pipeline for every candidate. */
    advanced: boolean;
    /**
     * The components of the rule's `vertexData` attribute and the location
     * the vertex stage reads it at (`vertexDataLayout`), 0 without one.
     */
    vertexDataComponents: number;
    vertexDataLocation: number;
    /** The regular mesh module: `picking-pipeline.ts`'s, or the advanced one's. */
    regular: string;
    /** The advanced thin-instance module, where thin instances pick. */
    thin?: string;
    /** The detailed mesh module, where a pick is detailed. */
    detailed?: string;
    /** The regular and detailed modules for a mesh without the `vertexData` attribute. */
    regularBare?: string;
    detailedBare?: string;
}

/** A composed rule's pick pipelines, in the order both PALs index them. */
export const pickDiscardPipelines = [
    "regular",
    "thin",
    "detailed",
    "regularBare",
    "detailedBare",
] as const;

interface AdvancedPipelineExports {
    vertexDataLayout(
        attribute: string,
        interleave: undefined,
    ): {
        components: number;
        layout: { attributes: readonly { shaderLocation: number }[] };
    };
}

/**
 * Each rule's modules from the pin's own builders, called with the options
 * its pipelines pass. A rule with a world adjustment, vertex data or
 * vertex-visible storage takes the advanced pipeline for every candidate
 * (`needsAdvancedPipeline`): its regular and detailed modules are
 * `createPipeline`'s, with the attribute's components where the mesh has
 * it (`getPickingRegularPipeline`) and none where it does not. Any other
 * rule's are `getPickingPipelineSet(engine, rule)`'s of the regular and
 * detailed modules. The thin-instance module is the advanced pipeline's
 * `thinInstancePipeline` either way.
 */
export async function composePickDiscardShaders(
    rules: readonly PickDiscardRuleManifest[],
    options: { thin: boolean; detailed: boolean },
): Promise<PickDiscardShader[]> {
    if (rules.length === 0) return [];
    const basic = await importPinnedModule<MeshShaderExports>(meshShaderModule);
    const advanced = await importPinnedModule<AdvancedVariantExports>(
        advancedMeshShaderModule,
    );
    const pipeline =
        await importPinnedModuleWithExports<AdvancedPipelineExports>(
            "picking/picking-advanced-pipeline.js",
            ["vertexDataLayout"],
        );
    const detailedModule = options.detailed
        ? await importPinnedModuleWithExports<DetailedPipelineExports>(
              detailedPipelineModule,
              ["shader"],
          )
        : undefined;
    return rules.map((rule) => {
        const variant = (
            thinInstance: boolean,
            vertexDataComponents: number,
            detailed: boolean,
        ): string =>
            advanced.pickingShaderVariantSource(thinInstance, {
                discardWgsl: rule.wgsl,
                worldAdjustWgsl: rule.worldAdjustWgsl,
                storage: rule.storage,
                vertexDataComponents,
                exposeVertexData: rule.vertexData !== undefined,
                detailed,
                _vertexProjection: undefined,
            });
        const layout =
            rule.vertexData === undefined
                ? undefined
                : pipeline.vertexDataLayout(rule.vertexData, undefined);
        const components = layout?.components ?? 0;
        const thin = options.thin ? { thin: variant(true, 0, false) } : {};
        if (
            rule.worldAdjustWgsl === undefined &&
            rule.vertexData === undefined &&
            !rule.storage.some((entry) => entry.vertex)
        )
            return {
                rule,
                advanced: false,
                vertexDataComponents: 0,
                vertexDataLocation: 0,
                regular: basic.pickingShaderSource({
                    discardWgsl: rule.wgsl,
                    storage: rule.storage,
                }),
                ...thin,
                ...(detailedModule
                    ? { detailed: detailedModule.shader(rule, null) }
                    : {}),
            };
        return {
            rule,
            advanced: true,
            vertexDataComponents: components,
            vertexDataLocation:
                layout?.layout.attributes[0]?.shaderLocation ?? 0,
            regular: variant(false, components, false),
            ...thin,
            ...(options.detailed
                ? { detailed: variant(false, components, true) }
                : {}),
            ...(components > 0
                ? {
                      regularBare: variant(false, 0, false),
                      ...(options.detailed
                          ? { detailedBare: variant(false, 0, true) }
                          : {}),
                  }
                : {}),
        };
    });
}

/** The deployed stem of a composed rule's module for one pipeline. */
export function pickDiscardStem(
    index: number,
    pipeline: (typeof pickDiscardPipelines)[number],
): string {
    const suffix = pipeline.replace(
        /[A-Z]/g,
        (letter) => `-${letter.toLowerCase()}`,
    );
    return `picking-discard-${index}${pipeline === "regular" ? "" : `-${suffix}`}`;
}

/**
 * The content key (`contentKey`) of what a rule's modules splice: its WGSL,
 * its world adjustment (empty where absent), then each storage entry's name
 * and type, each text ended by a NUL. The native pick frames the rule it is
 * handed the same way (`prepare_pick_discard`).
 */
export function pickDiscardContentKey(rule: PickDiscardRuleManifest): string {
    return contentKey(
        new TextEncoder().encode(
            [
                rule.wgsl,
                rule.worldAdjustWgsl ?? "",
                ...rule.storage.flatMap((entry) => [entry.name, entry.type]),
            ]
                .map((text) => `${text}\0`)
                .join(""),
        ),
    );
}

/**
 * The composed rules in the order both PALs select them by key: the
 * members the pin's pipeline cache keys on (`ruleKey`), the content key of
 * what their modules splice and each pipeline's deployed stem.
 */
export function pickDiscardHeader(
    variants: readonly PickDiscardShader[],
): string {
    const stems = (variant: PickDiscardShader, index: number): string =>
        pickDiscardPipelines
            .map((pipeline) =>
                variant[pipeline] === undefined
                    ? "nullptr"
                    : JSON.stringify(pickDiscardStem(index, pipeline)),
            )
            .join(", ");
    return `#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
namespace bbl::upstream {
struct PickDiscardVariant {
    const char* key;
    /** The rule's \`vertexData\`, or nullptr, its components and location (\`vertexDataLayout\`). */
    const char* vertex_data;
    std::size_t vertex_data_components;
    std::uint32_t vertex_data_location;
    bool world_adjust;
    /** Each storage entry's stage in declaration order: \`v\` vertex-visible, \`f\` fragment-only. */
    const char* stages;
    std::size_t storage_count;
    /** Each storage entry's WGSL variable, which binds it at group 2 in declaration order. */
    const char* const* storage_names;
    /** \`content_key\` of the WGSL, world adjustment and storage layout the modules splice. */
    const char* content;
    /** Each pipeline's stem in \`pickDiscardPipelines\` order, null where not composed. */
    std::array<const char*, ${pickDiscardPipelines.length}> stems;
};
${variants
    .map((variant, index) =>
        variant.rule.storage.length === 0
            ? ""
            : `inline constexpr std::array<const char*, ${variant.rule.storage.length}> pick_discard_storage_${index}{${variant.rule.storage.map((entry) => stringLiteral(entry.name)).join(", ")}};
`,
    )
    .join(
        "",
    )}inline constexpr std::array<PickDiscardVariant, ${variants.length}> pick_discard_variants{{
${variants
    .map(
        (variant, index) =>
            `    {${stringLiteral(variant.rule.key)}, ${variant.rule.vertexData === undefined ? "nullptr" : stringLiteral(variant.rule.vertexData)}, ${variant.vertexDataComponents}, ${variant.vertexDataLocation}, ${variant.rule.worldAdjustWgsl !== undefined}, "${variant.rule.storage.map((entry) => (entry.vertex ? "v" : "f")).join("")}", ${variant.rule.storage.length}, ${variant.rule.storage.length === 0 ? "nullptr" : `pick_discard_storage_${index}.data()`}, ${stringLiteral(pickDiscardContentKey(variant.rule))}, {${stems(variant, index)}}},`,
    )
    .join("\n")}
}};
}
`;
}
