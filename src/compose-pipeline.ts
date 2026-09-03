import type {
    SceneMeshManifest,
    ScenePbrMaterialManifest,
    ShadowGeneratorManifest,
} from "./compiler/types.js";
import {
    pbrEsmShadowView,
    pbrNoColorView,
} from "./compiler/scene-materials.js";
// The pinned variant-composition orchestration.
//
// Everything between "the manifest and assets are settled" and "the
// emitter options are assembled" in a compile: the scene arms, the PBR
// variant table composed through the pin per (material, mesh, scene arm),
// the Standard family's composition, and the mesh-feature tables both key
// on. Moved here from `cli.ts` as text motion (the monolith-remainder
// audit item) along the same Context seam the compiler rounds used: the
// context mirrors the host's names (`result`, `outputPath`, ...) so the
// moved body reads exactly as it did inline, and the values the remainder
// of `main` consumes travel back in the returned record.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { executeModuleGraph } from "./executed-module-graph.js";
import {
    enablePinnedMaterialPlugins,
    type MaterialPluginSamplerManifest,
    standardPluginBindingTable,
} from "./pinned-material-plugins.js";
import { findRepositoryRoot } from "./upstream-source.js";
import type { AssetSpecializationFeatures } from "./asset-specializer.js";
import { glbDocument } from "./gltf-document.js";
import type { CompileAsset, CompileResult } from "./compiler.js";
import type { GeneratedTree } from "./generated-tree.js";
import {
    assertArmsCovered,
    composeGltfMaterials,
    composeRenderableVariants,
    composeScenePbrVariants,
    gltfHasImageBasedLight,
    gltfMaterialCount,
    gltfLightNodeCount,
    gltfLightmapMaterials,
    gltfRenderableFeatures,
    proceduralRenderableFeatures,
    type PinnedMaterialArms,
    type PinnedRenderableVariant,
} from "./pinned-material-arms.js";
import {
    expandRuntimeMeshFeatureSets,
    pinnedVatMeshFeatures,
    pinnedInstanceColorBit,
    pinnedMeshFeaturesFromPrimitive,
    pinnedReceiveShadowsBit,
    pinnedThinInstancesBit,
} from "./pinned-mesh-features.js";
import {
    nodeVariantStageStems,
    type NodeVariantManifestEntry,
} from "./pinned-node-material-cpp.js";
import { composeNodeMaterial } from "./pinned-node-material.js";
import type { PinnedVariantManifestEntry } from "./pinned-pbr-variant-output.js";
import { writePinnedPbrVariants } from "./pinned-pbr-variant-output.js";
import {
    pinnedSceneArms,
    pinnedSingleLightTypes,
    type PinnedSingleLightType,
} from "./pinned-scene-arms.js";
import {
    babylonRenderableCount,
    composeSceneStandardVariants,
    type StandardSceneComposition,
} from "./pinned-standard-variants.js";
import {
    pinnedShadowFilter,
    type ShadowLightSlot,
} from "./pinned-shadow-slots.js";
import {
    babylonLights,
    reachedDiffuseUv2,
    reachedStandardBump,
} from "./babylon-asset-features.js";
import { refusalReachedFrom } from "./upstream-lower.js";

/** What the moved orchestration reads from `main`, under `main`'s names. */
export interface ComposePipelineContext {
    result: CompileResult;
    outputPath: string;
    specializationFeatures: AssetSpecializationFeatures;
    emittedArms: PinnedMaterialArms;
    tree: GeneratedTree;
}

/**
 * Collapse successive generators that occupy the same receiver slot.
 *
 * Runtime topology replacement keeps historical generator records alive for
 * their task resources and caster-view handle order, but the material
 * receiver has one binding row per current `scene.lights` slot. Reusing that
 * slot is valid only while its statically composed filter contract agrees.
 */
export function receiverShadowLightSlots(
    generators: readonly Pick<
        ShadowGeneratorManifest,
        "kind" | "lightIndex"
    >[],
): ShadowLightSlot[] {
    const byIndex = new Map<number, ShadowLightSlot["shadowType"]>();
    for (const generator of generators) {
        const shadowType = pinnedShadowFilter(generator.kind);
        const previous = byIndex.get(generator.lightIndex);
        if (previous !== undefined && previous !== shadowType) {
            throw new Error(
                "A live shadow-light replacement changes receiver filter " +
                    `at scene light slot ${generator.lightIndex} from ` +
                    `${previous} to ${shadowType}; dynamic shadow-filter ` +
                    "variants are not lowered.",
            );
        }
        byIndex.set(generator.lightIndex, shadowType);
    }
    return [...byIndex].map(
        ([lightIndex, shadowType]) => ({ lightIndex, shadowType }),
    );
}

function standardPluginMeshFeatureValues(
    pluginCount: number,
    meshes: readonly SceneMeshManifest[],
    meshFeatures: readonly number[],
    thinInstancesBit: number,
    instanceColorBit: number,
): number[][] {
    return Array.from({ length: pluginCount }, (_, pluginIndex) => {
        const values = new Set<number>();
        for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
            const mesh = meshes[meshIndex]!;
            if (mesh.standardMaterialPluginIndex !== pluginIndex + 1) continue;
            const base = meshFeatures[meshIndex] ?? 0;
            if (mesh.thinInstances === undefined) {
                values.add(base);
                continue;
            }
            const thin = base | thinInstancesBit;
            if (mesh.thinInstances === "always") {
                values.add(
                    mesh.thinInstanceColors
                        ? thin | instanceColorBit
                        : thin,
                );
                continue;
            }
            values.add(base);
            values.add(thin);
            if (mesh.thinInstanceColors) {
                values.add(thin | instanceColorBit);
            }
        }
        return [...values];
    });
}

/** The values `main`'s remainder (emit options, activation inventory)
 *  consumes, under the names it consumed them by when they were inline. */
export interface ComposedScenePipeline {
    lightKinds: PinnedSingleLightType[];
    /** The upstream loader/runtime tone-mapping states this scene can reach. */
    toneMappingStates: boolean[];
    linearImageProcessing: boolean;
    gltfAssets: CompileAsset[];
    materialIndexBase: number;
    /**
     * How many caster material views `registerSceneWithShadowSupport` will
     * append past the scene's own materials. The runtime's material-handle
     * count includes them, because a PBR view's handle has to name a row.
     */
    casterViewCount: number;
    /**
     * The pin's mesh bits per PBR renderable, in the runtime's own handle
     * order: the primitive's attributes, plus `MSH_RECEIVE_SHADOWS` where
     * the mesh receives. Both halves of the pin's own key.
     */
    renderableMeshFeatures: number[];
    pinnedVariants: readonly PinnedVariantManifestEntry[];
    runtimeMeshFeatures: number | undefined;
    standardComposition: StandardSceneComposition | undefined;
    standardRenderableMeshFeatures: number[] | undefined;
    standardRuntimeMeshFeatures: number | undefined;
    /**
     * The composed plugin binding pairs each registered Standard plugin
     * list declares, by the compiler's own 1-based index. Undefined when
     * no plugin declares a sampler, which is what keeps the generated
     * header a plugin-free scene's byte-identical.
     */
    standardPluginBindings:
        | readonly (readonly MaterialPluginSamplerManifest[])[]
        | undefined;
    nodeVariants: readonly NodeVariantManifestEntry[];
}

/**
 * The light arms a statically known scene can select at draw time.
 *
 * A single light normally selects the single-light specialization. A mesh
 * receiving a shadow is the exception in the pin: `rebuildSingle` routes it
 * through the multi-light path so that path can bind the shadow rows. Keep
 * that exception here, where the static scene-arm optimization is decided.
 */
export function staticSceneLightArms(
    lightKinds: readonly PinnedSingleLightType[],
    hasShadowReceiver: boolean,
): {
    lightKinds: PinnedSingleLightType[];
    multiLight: boolean;
    noLight: boolean;
} {
    return {
        lightKinds:
            lightKinds.length === 1 ? [lightKinds[0]!] : [],
        multiLight:
            lightKinds.length > 1 ||
            (lightKinds.length === 1 && hasShadowReceiver),
        noLight: lightKinds.length === 0,
    };
}

/**
 * Every mesh shape a dynamically populated caster task can pair with one
 * asset material. The task may receive that asset's imported meshes or a
 * scene-code mesh retaining the asset material, and a thin-instance pool can
 * attach to either after registration.
 */
export function dynamicCasterFeatureSets(
    assetFeatures: readonly number[],
    sceneFeatures: readonly number[],
    runtimeBits: readonly number[],
): number[] {
    return expandRuntimeMeshFeatureSets(
        [...new Set([...assetFeatures, ...sceneFeatures])],
        runtimeBits,
    ).sort((left, right) => left - right);
}

/**
 * Runtime PBR keys one scene mesh can select.
 *
 * A matrix pool recorded as `always` removes the plain mesh arm, but a
 * reached colour setter is only evidence that the colour stream MAY exist:
 * it can sit behind a runtime branch. Keep the uncoloured thin-instance arm
 * beside the coloured one so either live record key has a composed stage.
 */
export function scenePbrMeshFeatureSets(
    base: number,
    thinInstances: "always" | "possible" | undefined,
    hasInstanceColors: boolean,
    thinInstancesBit: number,
    instanceColorBit: number,
): number[] {
    if (thinInstances === undefined) return [base];
    const thin = base | thinInstancesBit;
    const result = thinInstances === "possible" ? [base, thin] : [thin];
    if (hasInstanceColors && instanceColorBit !== 0) {
        result.push(thin | instanceColorBit);
    }
    return result;
}

// Every glTF material the scene loads, composed through Babylon Lite's own
// pipeline. An arm it reaches that the emitted fragment does not carry is
// refused here, where it names the material, rather than shipping as a
// shading bias nothing points at.
// The scene arms a renderable can reach: the light modes the scene compiles
// support for, and — with an environment loaded, which is what turns tone
// mapping on upstream — both tone-mapping states. Generation cannot know how
// many lights will end up affecting a given mesh, so it composes the arms
// and the runtime selects the one its own light walk produces.
export async function composeScenePipeline({
    result,
    outputPath,
    specializationFeatures,
    emittedArms,
    tree,
}: ComposePipelineContext): Promise<ComposedScenePipeline> {
    // `enableMaterialPlugins(scene)` is the pin's own opt-in and the only
    // thing that pulls the plugin bridges into a build, so registration
    // lands here — before anything composes, and only for a scene that
    // reached the call. A scene attaching plugins without it composes
    // plugin-free, which is upstream's behaviour rather than a refusal.
    let standardPluginBindings:
        | readonly (readonly MaterialPluginSamplerManifest[])[]
        | undefined;
    if (result.manifest.features.includes("material:plugins")) {
        await enablePinnedMaterialPlugins(
            result.manifest.standardMaterialPlugins,
        );
        const table = await standardPluginBindingTable();
        // A scene whose plugins declare no sampler emits no table at all,
        // which is what keeps its generated header the one it had before
        // this family bound anything.
        standardPluginBindings = table.some((list) => list.length > 0)
            ? table
            : undefined;
    }
    const hasEnvironment = result.manifest.features.includes(
        "environment:ibl",
    );
    const lightKinds = pinnedSingleLightTypes.filter((kind) =>
        result.manifest.features.includes(`light:${kind}`)
    );
    // Whether any light in this scene names the meshes it applies to, which
    // is what lets `light_affects_mesh` answer false and therefore what
    // lets a receiver reach the no-light arm. Two producers fill the pin's
    // one field: a `.babylon` document's own per-light mesh lists, and
    // scene code writing `light.includedOnlyMeshIds`.
    const perMeshLightLists =
        result.manifest.assets.some((entry) => entry.kind === "babylon") ||
        result.manifest.features.includes("light:included-meshes");
    // Runtime material/mesh handles advance on every load, including a
    // second load of the same compiled asset. Compose one row set per
    // container so the static selector order remains the runtime order.
    const uniqueGltfAssets = result.manifest.assets.filter(
        (asset) => asset.kind === "gltf",
    );
    const gltfAssets = uniqueGltfAssets
        .flatMap((asset) =>
            Array.from(
                { length: asset.containerCount ?? 1 },
                () => asset,
            ),
        );
    const gltfRenderableFeaturesByAsset = new Map<
        CompileAsset,
        ReturnType<typeof gltfRenderableFeatures>
    >();
    const gltfMaterialCountsByAsset = new Map<CompileAsset, number>();
    const gltfMaterialCompositionsByAsset = new Map<
        CompileAsset,
        ReturnType<typeof composeGltfMaterials>
    >();
    // Tone mapping is loader state, not an alias for IBL. The upstream .env
    // loader and EXT_lights_image_based enable it, whereas HDR explicitly
    // disables it and DDS leaves the scene default (off) in place. Preserve
    // every state reachable when loader kinds are mixed; an explicit scene
    // assignment makes both states reachable regardless of asset presence.
    const loaderEnablesToneMapping =
        result.manifest.features.includes("environment:env") ||
        uniqueGltfAssets.some((asset) =>
            gltfHasImageBasedLight(
                resolve(outputPath, "assets", asset.output),
            )
        );
    const loaderLeavesToneMappingOff =
        !hasEnvironment ||
        result.manifest.features.includes("environment:hdr") ||
        result.manifest.features.includes("environment:dds");
    const toneMappingStates = [
        ...(loaderLeavesToneMappingOff ||
                result.manifest.mutableToneMappingEnabled
            ? [false]
            : []),
        ...(loaderEnablesToneMapping ||
                result.manifest.mutableToneMappingEnabled
            ? [true]
            : []),
    ];
    // `environment:ibl` is only reached by one of the loader cases above,
    // but retaining the default makes this orchestration safe for a caller
    // constructing a minimal manifest directly.
    if (toneMappingStates.length === 0) toneMappingStates.push(false);
    const assetLightsReached =
        uniqueGltfAssets.some(
            (asset) =>
                gltfLightNodeCount(
                    resolve(outputPath, "assets", asset.output),
                ) > 0,
        ) || babylonLights(outputPath, result.manifest.assets).length > 0;
    const staticLightKinds =
        !result.manifest.dynamicSceneLights && !assetLightsReached
            ? result.manifest.sceneLightKinds
            : undefined;
    const staticArms = staticLightKinds
        ? staticSceneLightArms(
              staticLightKinds,
              result.manifest.shadowGenerators.length > 0 &&
                  (result.manifest.shadowReceiverMeshes.length > 0 ||
                      result.manifest.dynamicShadowReceivers),
          )
        : undefined;
    const sceneArms = await pinnedSceneArms({
        lightKinds: staticArms?.lightKinds ?? lightKinds,
        multiLight: staticArms?.multiLight ?? lightKinds.length > 0,
        noLight: staticArms?.noLight ?? true,
        toneMapping: toneMappingStates,
        ...(result.manifest.toneMapping
            ? { toneMappingName: result.manifest.toneMapping }
            : {}),
        environment: hasEnvironment,
        fog: result.manifest.features.includes("renderer:fog"),
    });
    // The pin's enableSceneTransmission marks every material in the scene
    // `_linearImageProcessing` (markPbrMaterialsLinear), so each composed
    // fragment wraps its processing tail in `if(scene.vImageInfos.w>=0.0)`
    // and the retargeted linear pass runs with w = -1. Transmission-capable
    // rendering alone does not imply that state: PBR skybox mode needs the
    // same renderer but never calls markPbrMaterialsLinear.
    const linearImageProcessing =
        result.manifest.features.includes(
            "material:pbr-linear-image-processing",
        ) ||
        // Asset-carried KHR_materials_transmission enables the runtime's
        // transmission exactly like the feature does (scene_core stamps
        // `transmission_enabled` from the same disjunction), and the pin
        // marks every material linear either way.
        specializationFeatures.assetTransmission;
    // The scene's clustered light field, if it added one. It travels beside
    // `linearImageProcessing` because it is the same kind of fact: a scene
    // property every material composed for this scene has to see.
    const clusteredLights = result.manifest.clusteredLights;
    const sceneComposeOptions = {
        linearImageProcessing,
        ...(clusteredLights ? { clusteredLights } : {}),
    };
    // The runtime keys the variant table by material handle, which is
    // creation order: each glTF load appends its materials, and a scene
    // material appends where its `createPbrMaterial` runs. The recorded glTF
    // load count at each scene material creation interleaves those two sources
    // into the same handle order the runtime assigns.
    const composedVariants: PinnedRenderableVariant[] = [];
    // The mesh half of the variant key, per runtime mesh handle: each glTF
    // load appends its renderables in the pinned loader's node-order walk,
    // and each scene-code builder appends one mesh of the fixed procedural
    // attribute set, in the same creation order the runtime hands out
    // handles. Scene-code meshes are inserted at the glTF load count recorded
    // when their builder ran, so interleaved creation retains handle order.
    // Computed before composition because a scene-code material can be assigned
    // to any of these renderables, so its variants compose over every distinct
    // set here.
    const renderableMeshFeatures: number[] = [];
    const gltfRenderableFeatureSets: (readonly number[])[] = [];
    const sceneMeshRows = new Array<number>(
        result.manifest.sceneMeshes.length,
    );
    const sceneMeshesByLoadCount = new Map<number, number[]>();
    result.manifest.sceneMeshes.forEach((mesh, index) => {
        if (
            mesh.gltfAssetsBefore < 0 ||
            mesh.gltfAssetsBefore > gltfAssets.length
        ) {
            throw new Error(
                "A scene-code mesh records an impossible glTF load count.",
            );
        }
        const bucket =
            sceneMeshesByLoadCount.get(mesh.gltfAssetsBefore) ?? [];
        bucket.push(index);
        sceneMeshesByLoadCount.set(mesh.gltfAssetsBefore, bucket);
    });
    const appendSceneMesh = async (index: number): Promise<void> => {
        const mesh = result.manifest.sceneMeshes[index]!;
        sceneMeshRows[index] = renderableMeshFeatures.length;
        if (mesh.kind === "from-data") {
            // The recorded streams, walked exactly the way a glTF primitive
            // is: normals are a required argument, so the flat-normal arm is
            // unreachable from this builder.
            renderableMeshFeatures.push(
                await pinnedMeshFeaturesFromPrimitive({
                    attributes: {
                        POSITION: 0,
                        NORMAL: 0,
                        TEXCOORD_0: 0,
                        ...(mesh.hasUv2 ? { TEXCOORD_1: 0 } : {}),
                        ...(mesh.hasTangents ? { TANGENT: 0 } : {}),
                        ...(mesh.hasColors ? { COLOR_0: 0 } : {}),
                    },
                }),
            );
            return;
        }
        renderableMeshFeatures.push(await proceduralRenderableFeatures());
    };
    for (let loadCount = 0; loadCount <= gltfAssets.length; loadCount += 1) {
        for (const index of sceneMeshesByLoadCount.get(loadCount) ?? []) {
            await appendSceneMesh(index);
        }
        const asset = gltfAssets[loadCount];
        if (asset) {
            let pendingFeatures =
                gltfRenderableFeaturesByAsset.get(asset);
            if (!pendingFeatures) {
                pendingFeatures = gltfRenderableFeatures(
                    resolve(outputPath, "assets", asset.output),
                );
                gltfRenderableFeaturesByAsset.set(
                    asset,
                    pendingFeatures,
                );
            }
            const features = await pendingFeatures;
            gltfRenderableFeatureSets.push(features);
            renderableMeshFeatures.push(...features);
        }
    }
    // Every reached generator stays in creation order for its resources and
    // caster material views. A live topology replacement can create two
    // successive generators for the same scene-light slot, though, and the
    // receiver still owns only one binding row for that slot.
    const generatorsByLight = [...result.manifest.shadowGenerators].sort(
        (left, right) => left.lightIndex - right.lightIndex,
    );
    const shadowLights = receiverShadowLightSlots(generatorsByLight);
    // `rebuildSingle` computes `receiveShadows` as `mesh.receiveShadows &&
    // hasSomeShadows`, so a scene with no generator composes no receiver
    // even where a mesh asked for one.
    const receiveShadowsBit = shadowLights.length > 0
        ? await pinnedReceiveShadowsBit()
        : 0;
    const dynamicReceiverBits =
        result.manifest.dynamicShadowReceivers && receiveShadowsBit !== 0
            ? [receiveShadowsBit]
            : [];
    // The runtime fallback for meshes created after registration is read
    // BEFORE the receive bit is ORed on, because it describes an ATTRIBUTE
    // set: a mesh a scene builds at run time carries the builders'
    // attributes and receives no shadow, so reading it after the OR would
    // make it ambiguous for every scene that has both a receiver and an
    // ordinary mesh. Scene code can keep creating meshes after registration
    // -- the runtime sweep spawns per-frame boxes from one compiled call
    // site -- so handles past the static table take this fallback when every
    // scene-code mesh shares one attribute set, and refuse otherwise.
    const sceneMeshAttributeValues = new Set(
        sceneMeshRows.map((row) => renderableMeshFeatures[row] ?? 0),
    );
    const runtimeMeshFeatures =
        result.manifest.sceneMeshes.length === 0
            ? await proceduralRenderableFeatures()
            : sceneMeshAttributeValues.size === 1
                ? [...sceneMeshAttributeValues][0]!
                : undefined;
    // Each receiver's bit onto its own row, in place: from here on this walk
    // is the pin's own composition key -- the primitive's attributes plus
    // `MSH_RECEIVE_SHADOWS` -- and both family tables read it. An asset
    // renderable reached through a runtime collection is handled by
    // `dynamicReceiverBits`, because it has no generation-known scene row.
    for (const index of result.manifest.shadowReceiverMeshes) {
        const row = sceneMeshRows[index]!;
        renderableMeshFeatures[row] =
            (renderableMeshFeatures[row] ?? 0) | receiveShadowsBit;
    }
    // Thin instances are different from the static attribute bits above:
    // scene code can attach a pool after a mesh was built. The pin composes
    // that as another mesh-feature arm, so scene-code PBR materials need both
    // the plain and decorated form of every base set they can be assigned to.
    // The runtime performs the matching OR from MeshRecord::thin_instanced;
    // this is the generation half of the same key.
    const hasRuntimeThinInstances =
        result.manifest.features.includes("mesh:thin-instances") ||
        result.manifest.features.includes("mesh:thin-instances-dynamic");
    const hasRuntimeThinInstanceColors =
        hasRuntimeThinInstances &&
        result.manifest.features.includes("mesh:thin-instance-colors");
    const thinInstancesBit = hasRuntimeThinInstances
        ? await pinnedThinInstancesBit()
        : 0;
    const instanceColorBit = hasRuntimeThinInstanceColors
        ? await pinnedInstanceColorBit()
        : 0;
    // `_computeMeshFeatures` nests the colour test under `mesh.thinInstances`:
    // 32 never exists by itself. Treat the coloured pool as a composite
    // runtime mask so the generic product below emits {plain, TI, TI+colour}
    // without inventing an impossible colour-only PBR variant.
    const runtimePbrMeshBits = [
        ...(thinInstancesBit !== 0 ? [thinInstancesBit] : []),
        ...(instanceColorBit !== 0
            ? [thinInstancesBit | instanceColorBit]
            : []),
    ];
    const runtimePbrCompositionBits = [
        ...runtimePbrMeshBits,
        ...dynamicReceiverBits,
    ];
    // A baked mesh composes under MSH_VAT where its own attributes say
    // MSH_HAS_SKELETON: `_computeMeshFeatures` writes the two as one
    // either/or, so this is a REWRITE of the asset's rows rather than
    // another bit in the runtime product. Only a scene that reached the
    // pin's own opt-in (`bakeVat`) composes them, and both PALs perform
    // the identical swap at the draw.
    const hasVat = result.manifest.features.includes("mesh:vat");
    const vatFeatureSets = async (
        features: readonly number[],
    ): Promise<readonly number[]> =>
        hasVat
            ? [
                ...new Set([
                    ...features,
                    ...(await pinnedVatMeshFeatures(features)),
                ]),
            ].sort((left, right) => left - right)
            : features;
    const assetMaterialMeshFeatures = expandRuntimeMeshFeatureSets(
        result.manifest.sceneMeshes.flatMap((mesh, index) =>
            mesh.assetPbrMaterial
                ? [renderableMeshFeatures[sceneMeshRows[index]!] ?? 0]
                : [],
        ),
        runtimePbrCompositionBits,
    );
    const geometryTasks = result.manifest.geometryOutputTasks.map(
        (task, index) => ({
            index,
            attachments: task.attachments,
            emitColor: task.emitColor,
        }),
    );
    const dynamicCasterViews = new Set<"no-color" | "esm-shadow">();
    for (const generator of generatorsByLight) {
        if (!generator.dynamicCasters) continue;
        dynamicCasterViews.add(
            pinnedShadowFilter(generator.kind) === "esm"
                ? "esm-shadow"
                : "no-color",
        );
    }
    const dynamicCasterSceneMeshFeatures =
        sceneMeshAttributeValues.size > 0
            ? [...sceneMeshAttributeValues]
            : [await proceduralRenderableFeatures()];
    const gltfMaterialCounts = gltfAssets.map((asset) => {
        const cached = gltfMaterialCountsByAsset.get(asset);
        if (cached !== undefined) return cached;
        const count = gltfMaterialCount(
            resolve(outputPath, "assets", asset.output),
        );
        gltfMaterialCountsByAsset.set(asset, count);
        return count;
    });
    const gltfMaterialPrefix = [0];
    for (const count of gltfMaterialCounts) {
        gltfMaterialPrefix.push(gltfMaterialPrefix.at(-1)! + count);
    }
    const sceneMaterialLoadCounts =
        result.manifest.sceneMaterialGltfAssetsBefore ??
        new Array(result.manifest.sceneMaterialCount).fill(
            gltfAssets.length,
        );
    if (
        sceneMaterialLoadCounts.length !==
        result.manifest.sceneMaterialCount
    ) {
        throw new Error(
            "Scene material creation-order metadata does not match its count.",
        );
    }
    for (const count of sceneMaterialLoadCounts) {
        if (count < 0 || count > gltfAssets.length) {
            throw new Error(
                "A scene material records an impossible glTF load count.",
            );
        }
    }
    const absoluteSceneMaterialIndex = (sceneIndex: number): number =>
        sceneIndex +
        gltfMaterialPrefix[sceneMaterialLoadCounts[sceneIndex]!]!;
    const assetMaterialBases = gltfAssets.map((_, assetIndex) =>
        gltfMaterialPrefix[assetIndex]! +
        sceneMaterialLoadCounts.filter(
            (count) => count <= assetIndex,
        ).length,
    );
    const totalAssetMaterials = gltfMaterialPrefix.at(-1)!;
    const absoluteScenePbrMaterials =
        result.manifest.scenePbrMaterials.map((material) => ({
            ...material,
            materialsBefore: absoluteSceneMaterialIndex(
                material.materialsBefore,
            ),
            ...(material.sourceMaterialsBefore === undefined
                ? {}
                : {
                      sourceMaterialsBefore: absoluteSceneMaterialIndex(
                          material.sourceMaterialsBefore,
                      ),
                  }),
        }));
    let assetMetallicReflectanceRegistered = false;
    for (const [assetIndex, asset] of gltfAssets.entries()) {
        const materialIndexBase = assetMaterialBases[assetIndex]!;
        const path = resolve(outputPath, "assets", asset.output);
        // The scene facts every material sees, plus the ones this container
        // alone carries: `setPbrUnlit` over its own flattened mesh list is
        // the container's, not the scene's, so it travels with the asset.
        const assetComposeOptions = {
            ...sceneComposeOptions,
            ...(asset.sceneUnlit
                ? { sceneUnlit: asset.sceneUnlit }
                : {}),
            // The lightmap walk's own filter, folded here against the
            // document: which renderables it reaches is the document's
            // answer, not the scene's, and PBR composition is settled per
            // material — so what the scene carried is the predicate and
            // what composition sees is the material set it selects.
            ...(asset.sceneLightmap
                ? {
                    sceneLightmap: {
                        materials: await gltfLightmapMaterials(
                            glbDocument(path) ?? {},
                            asset.sceneLightmap.meshNamePredicate,
                            asset.selectedVariant,
                        ),
                        options: asset.sceneLightmap.options,
                    },
                }
                : {}),
        };
        // The variant composer additionally takes the asset's selected
        // `KHR_materials_variants` name, which the material composer's own
        // options bag does not carry.
        const assetVariantOptions = {
            ...assetComposeOptions,
            ...(asset.selectedVariant
                ? { selectedVariant: asset.selectedVariant }
                : {}),
        };
        let pendingComposition =
            gltfMaterialCompositionsByAsset.get(asset);
        if (!pendingComposition) {
            pendingComposition = composeGltfMaterials(
                path,
                assetComposeOptions,
            );
            gltfMaterialCompositionsByAsset.set(
                asset,
                pendingComposition,
            );
        }
        const composed = await pendingComposition;
        assetMetallicReflectanceRegistered ||= composed.some(
            (material) => material.metallicReflectanceRegistered,
        );
        assertArmsCovered(composed, emittedArms, asset.output);
        const variants = await composeRenderableVariants(
            path,
            sceneArms,
            materialIndexBase,
            {
                ...assetVariantOptions,
                // The two are INDEPENDENT: a baked mesh rewrites its
                // skeleton bit to MSH_VAT, and a dynamic receiver widens
                // the same sets by the receiver bits. Chaining them as
                // else-arms dropped the VAT rewrite from any scene that
                // had both, and dropped the shadow lights from any scene
                // that had a baked mesh. The base rows go through the VAT
                // rewrite first, then the widening, then the light lists
                // ride along when there are receivers.
                ...(hasVat || dynamicReceiverBits.length > 0
                    ? {
                          meshFeatureSets: expandRuntimeMeshFeatureSets(
                              hasVat
                                  ? await vatFeatureSets(
                                        gltfRenderableFeatureSets[
                                            assetIndex
                                        ] ?? [],
                                    )
                                  : gltfRenderableFeatureSets[assetIndex] ??
                                    [],
                              // The runtime product beside the rewrite: a
                              // baked mesh that is also thin-instanced
                              // takes the per-instance VAT arm, which the
                              // pin derives from MSH_HAS_THIN_INSTANCES
                              // rather than from a bit of its own.
                              dynamicReceiverBits.length > 0
                                  ? dynamicReceiverBits
                                  : runtimePbrCompositionBits,
                          ),
                          ...(dynamicReceiverBits.length > 0
                              ? { shadowLights, perMeshLightLists }
                              : {}),
                      }
                    : {}),
            },
            // A PBR mesh drawn in a geometry-output task resolves the pin's
            // own MRT arm for that task's attachment list.
            geometryTasks,
        );
        composedVariants.push(...variants);
        // A fractured or otherwise rebuilt scene mesh can retain the PBR
        // material read from its source asset. The material handle remains
        // the asset's, while the mesh-feature half of the runtime key is the
        // new scene row, so compose that legal cross-product explicitly.
        if (assetMaterialMeshFeatures.length > 0) {
            composedVariants.push(
                ...(await composeRenderableVariants(
                    path,
                    sceneArms,
                    materialIndexBase,
                    {
                        ...assetVariantOptions,
                        meshFeatureSets: assetMaterialMeshFeatures,
                    },
                    geometryTasks,
                )),
            );
        }
        for (const materialView of dynamicCasterViews) {
            composedVariants.push(
                ...(await composeRenderableVariants(
                    path,
                    sceneArms,
                    materialIndexBase,
                    {
                        ...assetVariantOptions,
                        materialView,
                        meshFeatureSets: dynamicCasterFeatureSets(
                            gltfRenderableFeatureSets[assetIndex] ?? [],
                            dynamicCasterSceneMeshFeatures,
                            runtimePbrMeshBits,
                        ),
                    },
                )),
            );
        }
    }
    // The caster material VIEWS `registerSceneWithShadowSupport` appends at
    // run time, composed here because a PBR view resolves its variant by
    // material HANDLE and a handle the table never named resolves nothing.
    //
    // The order is the pin's own scheduling walk -- `scene.lights` in order,
    // and within each light its generator's casters in the order
    // `setShadowTaskCasterMeshes` named them -- which is the order the
    // generated `shadow.cpp` pushes them, so the handles line up by
    // construction rather than by a second rule. A Standard caster
    // contributes nothing: that family keys on feature bits and reads
    // `no_color` off the record, so its view resolves with no row at all.
    const casterViews: ScenePbrMaterialManifest[] = [];
    let casterViewCount = 0;
    for (const generator of generatorsByLight) {
        for (const caster of generator.casters) {
            // EVERY caster takes a handle: `build_shadow_task` appends a
            // view for each, whichever family the caster's material
            // belongs to. Only a scene-code PBR one needs a composed row,
            // so the counter and the row list advance apart -- a Standard
            // caster ahead of a PBR one would otherwise hand the PBR view
            // the Standard view's handle.
            const materialsBefore =
                totalAssetMaterials +
                result.manifest.sceneMaterialCount +
                casterViewCount;
            casterViewCount += 1;
            if (caster.pbrMaterial === null) continue;
            const source =
                absoluteScenePbrMaterials[caster.pbrMaterial];
            if (!source) {
                throw new Error(
                    "A shadow caster names scene PBR material " +
                        `${caster.pbrMaterial}, which the scene did not ` +
                        "create.",
                );
            }
            // Composed over its own caster's attribute set and no other:
            // the view is drawn on that mesh in the caster pass and
            // nowhere else, which is the narrowing the pin gets for free
            // by composing per renderable. The scene-wide product would
            // deploy a stage pair per arm and per attribute set, all but
            // one of them a `return;` fragment no draw can select.
            // Which view the caster takes is the generator's own filter,
            // exactly as it is for the Standard family: an ESM pass draws
            // the exponential-depth view, a PCF pass the depth-only one.
            const view = pinnedShadowFilter(generator.kind) === "esm"
                ? pbrEsmShadowView(source, materialsBefore)
                : pbrNoColorView(source, materialsBefore);
            casterViews.push({
                ...view,
                meshFeatureSets: expandRuntimeMeshFeatureSets(
                    [
                        // Without the receive bit, whatever the caster's
                        // own row says. `rebuildSingle` derives
                        // `receiveShadows` as `!shadowOutput && ...`, so a
                        // caster pass composes no shadow fragment even for
                        // a mesh that receives one in the colour pass --
                        // which is exactly what both PALs strip from the
                        // key before the lookup. A mesh that both casts
                        // and receives is where the two halves have to
                        // agree.
                        (renderableMeshFeatures[
                            sceneMeshRows[caster.meshIndex]!
                        ] ?? 0) & ~receiveShadowsBit,
                    ],
                    runtimePbrMeshBits,
                ),
            });
        }
    }
    for (const materialView of dynamicCasterViews) {
        for (const source of absoluteScenePbrMaterials) {
            if (source.noColorView || source.esmShadowView) continue;
            casterViews.push(
                materialView === "esm-shadow"
                    ? pbrEsmShadowView(source, source.materialsBefore)
                    : pbrNoColorView(source, source.materialsBefore),
            );
        }
    }
    const exactScenePbrMaterials = absoluteScenePbrMaterials.map(
        (material) => {
            if (material.unknownSceneMesh || !material.sceneMeshIndices) {
                return material;
            }
            const featureSets = new Set<number>();
            for (const meshIndex of material.sceneMeshIndices) {
                const row = result.manifest.sceneMeshes[meshIndex];
                const base = renderableMeshFeatures[
                    sceneMeshRows[meshIndex]!
                ] ?? 0;
                for (const features of scenePbrMeshFeatureSets(
                    base,
                    row?.thinInstances,
                    row?.thinInstanceColors === true,
                    thinInstancesBit,
                    instanceColorBit,
                )) {
                    featureSets.add(features);
                }
            }
            return {
                ...material,
                meshFeatureSets: [...featureSets].sort(
                    (left, right) => left - right,
                ),
            };
        },
    );
    const scenePbrMaterials = [
        ...exactScenePbrMaterials,
        ...casterViews,
    ];
    if (result.manifest.scenePbrMaterials.length > 0) {
        composedVariants.push(
            ...(await composeScenePbrVariants(
                scenePbrMaterials,
                sceneArms,
                0,
                expandRuntimeMeshFeatureSets(
                    [
                        ...renderableMeshFeatures,
                        await proceduralRenderableFeatures(),
                    ],
                    runtimePbrCompositionBits,
                ),
                {
                    linearImageProcessing,
                    metallicReflectanceRegistered:
                        assetMetallicReflectanceRegistered,
                    ...(shadowLights.length > 0
                        ? {
                            shadowLights,
                            perMeshLightLists,
                        }
                        : {}),
                },
            )),
        );
    }
    // The pin's own composed stages, one file per distinct variant. These are
    // the artifacts that replace `templates/renderer/pbr.frag.wgsl`: the
    // renderer selects per-material behaviour from uniform lanes inside one
    // fragment where Babylon composes a fragment per feature set, and this is
    // that set, written by the pin rather than transcribed here.
    const pinnedVariants = writePinnedPbrVariants(tree, composedVariants);
    // The Standard family's pinned composition: every standard scene
    // composes its variants through the pin, and both GPU PALs draw them —
    // the transcribed standard fragment is retired.
    let standardComposition: StandardSceneComposition | undefined;
    let standardRenderableMeshFeatures: number[] | undefined;
    let standardRuntimeMeshFeatures: number | undefined;
    // The scene-code rows the Standard table keys on: the same walk both
    // families read, sliced to the scene's own meshes.
    const standardSceneMeshFeatures = sceneMeshRows.map(
        (row) => renderableMeshFeatures[row] ?? 0,
    );
    if (result.manifest.features.includes("material:standard")) {
        const runtimeStandardFeatureValues = result.manifest.sceneMeshes
            .flatMap((mesh, index) =>
                mesh.standardMaterial
                    ? [standardSceneMeshFeatures[index] ?? 0]
                    : [],
            );
        const runtimeStandardFeatureSet = new Set(
            runtimeStandardFeatureValues,
        );
        standardRuntimeMeshFeatures =
            runtimeStandardFeatureSet.size === 1
                ? [...runtimeStandardFeatureSet][0]!
                : result.manifest.sceneMeshes.length === 0
                  ? await proceduralRenderableFeatures()
                  : undefined;
        const babylonAssets = result.manifest.assets
            .filter((asset) => asset.kind === "babylon")
            .map((asset) => resolve(outputPath, "assets", asset.output));
        const sceneStandardMaterials =
            result.manifest.sceneMaterialCount >
                result.manifest.scenePbrMaterials.length;
        standardComposition = await composeSceneStandardVariants(
            {
                babylonAssets,
                bumpTexture: reachedStandardBump(
                    outputPath,
                    result.manifest.assets,
                ),
                diffuseUv2: reachedDiffuseUv2(
                    outputPath,
                    result.manifest.assets,
                ),
                fog: result.manifest.features.includes("renderer:fog"),
                vertexColors: result.manifest.features.includes(
                    "material:standard-vertex-colors",
                ),
                noColorViews: result.manifest.features.includes(
                    "material:no-color-view",
                ),
                esmShadowViews: result.manifest.features.includes(
                    "shadow:esm",
                ),
                emissiveRenderTexture: result.manifest.features.includes(
                    "material:standard-emissive-render-texture",
                ),
                diffuseRenderTexture: result.manifest.features.includes(
                    "material:standard-diffuse-render-texture",
                ),
                diffusePixelsTexture: result.manifest.features.includes(
                    "material:standard-diffuse-pixels-texture",
                ),
                diffuseFileTexture: result.manifest.features.includes(
                    "material:standard-diffuse-file-texture",
                ),
                emissiveFileTexture: result.manifest.features.includes(
                    "material:standard-emissive-file-texture",
                ),
                uvTransform: result.manifest.features.includes(
                    "material:standard-uv-transform",
                ),
                standardMaterialPlugins:
                    result.manifest.standardMaterialPlugins,
                standardMaterialPluginInputs:
                    result.manifest.standardMaterialPluginInputs,
                standardMaterialPluginMeshFeatureValues:
                    standardPluginMeshFeatureValues(
                        result.manifest.standardMaterialPlugins.length,
                        result.manifest.sceneMeshes,
                        standardSceneMeshFeatures,
                        thinInstancesBit,
                        instanceColorBit,
                    ),
                thinInstances: hasRuntimeThinInstances,
                thinInstanceColors: hasRuntimeThinInstanceColors,
                morphTargets: result.manifest.features.includes(
                    "mesh:morph-targets",
                ),
                sceneMaterials: sceneStandardMaterials,
                sceneMeshFeatureValues: [
                    ...new Set(
                        expandRuntimeMeshFeatureSets(
                            standardSceneMeshFeatures,
                            dynamicReceiverBits,
                        ),
                    ),
                ],
                shadowLights,
                geometryTasks: result.manifest.geometryOutputTasks.map(
                    (task, index) => ({
                        index,
                        attachments: task.attachments,
                        emitColor: task.emitColor,
                    }),
                ),
            },
            (path) => readFileSync(path, "utf8"),
        );
        if (babylonAssets.length === 0) {
            // The PBR-family walk above is actually a shared mesh-feature
            // walk: with glTF plus scene builders it already follows runtime
            // creation order, including a scene mesh created before a later
            // glTF load. Standard reads the same pinned mesh bits, so retain
            // that exact interleaving instead of rebuilding assets-first.
            standardRenderableMeshFeatures = [...renderableMeshFeatures];
        } else {
            // `.babylon` records carry no composition-relevant bits. No
            // adopted `.babylon` scene interleaves a scene-code builder with
            // its load, and that format is not represented by the glTF load
            // count recorded on a builder, so retain its loader-order path.
            standardRenderableMeshFeatures = [];
            let gltfAssetIndex = 0;
            for (const asset of result.manifest.assets) {
                if (asset.kind === "gltf") {
                    standardRenderableMeshFeatures.push(
                        ...(gltfRenderableFeatureSets[gltfAssetIndex] ?? []),
                    );
                    gltfAssetIndex += 1;
                } else if (asset.kind === "babylon") {
                    const count = babylonRenderableCount(
                        readFileSync(
                            resolve(outputPath, "assets", asset.output),
                            "utf8",
                        ),
                    );
                    for (let index = 0; index < count; index += 1) {
                        standardRenderableMeshFeatures.push(0);
                    }
                }
            }
            standardRenderableMeshFeatures.push(...standardSceneMeshFeatures);
        }
    }
    // Every node graph the scene parsed, compiled by the pin's own emitter
    // and pipeline builder. The index is the scene's reach order, which is
    // what `create_node_material` was given.
    const nodeVariants: NodeVariantManifestEntry[] = [];
    const repositoryRoot = result.manifest.nodeMaterials.length > 0
        ? findRepositoryRoot(dirname(resolve(result.manifest.source)))
        : "";
    for (const [index, material] of result.manifest.nodeMaterials.entries()) {
        const graph = material.kind === "literal"
            ? material.graph
            : await executeModuleGraph({
                modulePath: resolve(repositoryRoot, material.module),
                exportName: material.exportName,
            });
        const label = material.kind === "literal"
            ? `${index}`
            : `${material.module}#${material.exportName}`;
        // Which lights this graph receives from, and whether the scene
        // casts a shadow from it: the receiver's bindings and the caster's
        // second module are both the pin's own answers, and both need the
        // scene's own generator list to ask for. Each generator's FILTER
        // comes off the pinned factory its kind names -- the same read the
        // composed families' slots make -- so a family added without a
        // receiver arm refuses rather than being taken for a neighbour.
        const graphShadowLights = material.shadowLights.map((light) => ({
            lightIndex: light.lightIndex,
            shadowType: pinnedShadowFilter(
                result.manifest.shadowGenerators[light.generatorIndex]!.kind,
            ),
        }));
        const castsEsmShadow = result.manifest.shadowGenerators.some(
            (generator) =>
                pinnedShadowFilter(generator.kind) === "esm" &&
                generator.casters.some(
                    (caster) => caster.nodeMaterial === index,
                ),
        );
        const castsPcfShadow = result.manifest.shadowGenerators.some(
            (generator) =>
                pinnedShadowFilter(generator.kind) === "pcf" &&
                generator.casters.some(
                    (caster) => caster.nodeMaterial === index,
                ),
        );
        const composed = await composeNodeMaterial(
            graph,
            label,
            {
                shadowLights: graphShadowLights,
                castsEsmShadow,
                blockEmitters: material.blockEmitters,
                castsPcfShadow,
            },
        );
        // The graph decides which bindings exist and the scene decides which
        // it supplies; only here are both known. Upstream raises the mismatch
        // at the first render, so raising it at generation is the same
        // contract moved to the moment that can carry a source-free message
        // naming the binding — plus the scene call site that first reached
        // the node-material family, from the manifest's featureSites record.
        const nodeSite = refusalReachedFrom(
            result.manifest.featureSites,
            "material:node",
        );
        for (const binding of composed.textures) {
            if (material.textureNames.includes(binding.name)) continue;
            throw new Error(
                `Node material '${label}' samples the texture binding ` +
                    `'${binding.name}', which the scene's 'textures' record ` +
                    `does not supply.${nodeSite}`,
            );
        }
        // Extra keys are inert upstream: parseNodeMaterialFromSnippet walks
        // the COMPILED texture bindings and looks each one up in
        // options.textures; it never walks the options record itself. Scene
        // 83 deliberately supplies PositionSample for a disconnected
        // TextureBlock, which the graph walk emits no binding for, so that
        // key is ignored while the reached AoDepth binding remains checked.
        nodeVariants.push({
            index,
            ...nodeVariantStageStems(index),
            composed,
        });
    }
    return {
        lightKinds,
        toneMappingStates,
        linearImageProcessing,
        gltfAssets,
        materialIndexBase: totalAssetMaterials,
        casterViewCount,
        renderableMeshFeatures,
        pinnedVariants,
        runtimeMeshFeatures,
        standardComposition,
        standardRenderableMeshFeatures,
        standardRuntimeMeshFeatures,
        standardPluginBindings,
        nodeVariants,
    };
}
