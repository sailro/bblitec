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
import { findRepositoryRoot } from "./upstream-source.js";
import type { AssetSpecializationFeatures } from "./asset-specializer.js";
import type { CompileAsset, CompileResult } from "./compiler.js";
import type { GeneratedTree } from "./generated-tree.js";
import {
    assertArmsCovered,
    composeGltfMaterials,
    composeRenderableVariants,
    composeScenePbrVariants,
    gltfMaterialCount,
    gltfRenderableFeatures,
    proceduralRenderableFeatures,
    type PinnedMaterialArms,
    type PinnedRenderableVariant,
} from "./pinned-material-arms.js";
import { pinnedMeshFeaturesFromPrimitive } from "./pinned-mesh-features.js";
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
    reachedDiffuseUv2,
    reachedStandardBump,
} from "./babylon-asset-features.js";

/** What the moved orchestration reads from `main`, under `main`'s names. */
export interface ComposePipelineContext {
    result: CompileResult;
    outputPath: string;
    specializationFeatures: AssetSpecializationFeatures;
    emittedArms: PinnedMaterialArms;
    tree: GeneratedTree;
}

/** The values `main`'s remainder (emit options, activation inventory)
 *  consumes, under the names it consumed them by when they were inline. */
export interface ComposedScenePipeline {
    hasEnvironment: boolean;
    lightKinds: PinnedSingleLightType[];
    linearImageProcessing: boolean;
    gltfAssets: CompileAsset[];
    materialIndexBase: number;
    renderableMeshFeatures: number[];
    pinnedVariants: readonly PinnedVariantManifestEntry[];
    runtimeMeshFeatures: number | undefined;
    standardComposition: StandardSceneComposition | undefined;
    standardRenderableMeshFeatures: number[] | undefined;
    nodeVariants: readonly NodeVariantManifestEntry[];
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
    const hasEnvironment = result.manifest.features.includes(
        "environment:ibl",
    );
    const lightKinds = pinnedSingleLightTypes.filter((kind) =>
        result.manifest.features.includes(`light:${kind}`)
    );
    const sceneArms = await pinnedSceneArms({
        lightKinds,
        multiLight: lightKinds.length > 0,
        noLight: true,
        toneMapping: hasEnvironment ? [false, true] : [false],
        environment: hasEnvironment,
        fog: result.manifest.features.includes("renderer:fog"),
    });
    // The pin's enableSceneTransmission marks every material in the scene
    // `_linearImageProcessing` (markPbrMaterialsLinear), so each composed
    // fragment wraps its processing tail in `if(scene.vImageInfos.w>=0.0)`
    // and the retargeted linear pass runs with w = -1.
    const linearImageProcessing =
        result.manifest.features.includes("renderer:transmission") ||
        // Asset-carried KHR_materials_transmission enables the runtime's
        // transmission exactly like the feature does (scene_core stamps
        // `transmission_enabled` from the same disjunction), and the pin
        // marks every material linear either way.
        specializationFeatures.assetTransmission;
    // The runtime keys the variant table by material handle, which is
    // creation order: each glTF load appends its materials, and a scene
    // material appends where its `createPbrMaterial` runs. Every reached
    // scene creates its materials after every load, so the sequence is the
    // assets' materials in load order followed by the scene's; a material
    // created before a later load would interleave, and stays a named error.
    const composedVariants: PinnedRenderableVariant[] = [];
    const gltfAssets = result.manifest.assets.filter(
        (asset) => asset.kind === "gltf",
    );
    // The mesh half of the variant key, per runtime mesh handle: each glTF
    // load appends its renderables in the pinned loader's node-order walk,
    // and each scene-code builder appends one mesh of the fixed procedural
    // attribute set, in the same creation order the runtime hands out
    // handles. Computed before composition because a scene-code material can
    // be assigned to any of these renderables, so its variants compose over
    // every distinct set here.
    const renderableMeshFeatures: number[] = [];
    for (const asset of gltfAssets) {
        renderableMeshFeatures.push(
            ...(await gltfRenderableFeatures(
                resolve(outputPath, "assets", asset.output),
            )),
        );
    }
    for (const mesh of result.manifest.sceneMeshes) {
        if (mesh.gltfAssetsBefore !== gltfAssets.length) {
            throw new Error(
                "A scene-code mesh created before a later glTF load " +
                    "would interleave the renderable key; no scene " +
                    "reaches this yet.",
            );
        }
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
            continue;
        }
        renderableMeshFeatures.push(await proceduralRenderableFeatures());
    }
    let materialIndexBase = 0;
    for (const asset of gltfAssets) {
        const path = resolve(outputPath, "assets", asset.output);
        const composed = await composeGltfMaterials(path, {
            linearImageProcessing,
        });
        assertArmsCovered(composed, emittedArms, asset.output);
        const variants = await composeRenderableVariants(
            path,
            sceneArms,
            materialIndexBase,
            {
                linearImageProcessing,
                ...(asset.selectedVariant
                    ? { selectedVariant: asset.selectedVariant }
                    : {}),
            },
            // A PBR mesh drawn in a geometry-output task resolves the pin's
            // own MRT arm for that task's attachment list.
            result.manifest.geometryOutputTasks.map((task, index) => ({
                index,
                attachments: task.attachments,
                emitColor: task.emitColor,
            })),
        );
        composedVariants.push(...variants);
        materialIndexBase += gltfMaterialCount(path);
    }
    if (result.manifest.scenePbrMaterials.length > 0) {
        for (const material of result.manifest.scenePbrMaterials) {
            if (material.gltfAssetsBefore !== gltfAssets.length) {
                throw new Error(
                    "A scene-code PBR material created before a later glTF " +
                        "load would interleave the variant table's " +
                        "creation-order key; no scene reaches this yet.",
                );
            }
        }
        composedVariants.push(
            ...(await composeScenePbrVariants(
                result.manifest.scenePbrMaterials,
                sceneArms,
                materialIndexBase,
                [
                    ...new Set([
                        ...renderableMeshFeatures,
                        await proceduralRenderableFeatures(),
                    ]),
                ],
                { linearImageProcessing },
            )),
        );
    }
    // The pin's own composed stages, one file per distinct variant. These are
    // the artifacts that replace `templates/renderer/pbr.frag.wgsl`: the
    // renderer selects per-material behaviour from uniform lanes inside one
    // fragment where Babylon composes a fragment per feature set, and this is
    // that set, written by the pin rather than transcribed here.
    const pinnedVariants = writePinnedPbrVariants(tree, composedVariants);
    // Scene code can keep creating meshes after registration -- the runtime
    // sweep spawns per-frame boxes from one compiled call site -- so handles
    // past the static table take this fallback when every scene-code mesh
    // shares one attribute set, and refuse otherwise.
    const sceneMeshFeatureValues = new Set(
        renderableMeshFeatures.slice(
            renderableMeshFeatures.length -
                result.manifest.sceneMeshes.length,
        ),
    );
    const runtimeMeshFeatures =
        result.manifest.sceneMeshes.length === 0
            ? await proceduralRenderableFeatures()
            : sceneMeshFeatureValues.size === 1
                ? [...sceneMeshFeatureValues][0]!
                : undefined;
    // The Standard family's pinned composition: every standard scene
    // composes its variants through the pin, and both GPU PALs draw them —
    // the transcribed standard fragment is retired.
    let standardComposition: StandardSceneComposition | undefined;
    let standardRenderableMeshFeatures: number[] | undefined;
    if (result.manifest.features.includes("material:standard")) {
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
                emissiveRenderTexture: result.manifest.features.includes(
                    "renderer:geometry-output",
                ),
                thinInstances:
                    result.manifest.features.includes(
                        "mesh:thin-instances",
                    ) ||
                    result.manifest.features.includes(
                        "mesh:thin-instances-dynamic",
                    ),
                morphTargets: result.manifest.features.includes(
                    "mesh:morph-targets",
                ),
                sceneMaterials: sceneStandardMaterials,
                sceneMeshFeatureValues: [
                    ...new Set(
                        renderableMeshFeatures.slice(
                            renderableMeshFeatures.length -
                                result.manifest.sceneMeshes.length,
                        ),
                    ),
                ],
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
        // The Standard mesh table covers every runtime mesh handle in
        // creation order: each asset's renderables as its loader creates
        // them (`.babylon` records carry no composition-relevant bits, so
        // zero rows sized by the loader's own walk), then the scene-code
        // meshes.
        standardRenderableMeshFeatures = [];
        let gltfCursor = 0;
        for (const asset of result.manifest.assets) {
            if (asset.kind === "gltf") {
                const rows = await gltfRenderableFeatures(
                    resolve(outputPath, "assets", asset.output),
                );
                standardRenderableMeshFeatures.push(...rows);
                gltfCursor += rows.length;
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
        standardRenderableMeshFeatures.push(
            ...renderableMeshFeatures.slice(gltfCursor),
        );
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
        nodeVariants.push({
            index,
            ...nodeVariantStageStems(index),
            composed: await composeNodeMaterial(
                graph,
                material.kind === "literal"
                    ? `${index}`
                    : `${material.module}#${material.exportName}`,
            ),
        });
    }
    return {
        hasEnvironment,
        lightKinds,
        linearImageProcessing,
        gltfAssets,
        materialIndexBase,
        renderableMeshFeatures,
        pinnedVariants,
        runtimeMeshFeatures,
        standardComposition,
        standardRenderableMeshFeatures,
        nodeVariants,
    };
}
