import type { ScenePbrMaterialManifest } from "./compiler/types.js";
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
    gltfLightNodeCount,
    gltfRenderableFeatures,
    proceduralRenderableFeatures,
    type PinnedMaterialArms,
    type PinnedRenderableVariant,
} from "./pinned-material-arms.js";
import {
    expandRuntimeMeshFeatureSets,
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
import { pinnedShadowFilter } from "./pinned-shadow-slots.js";
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

/** The values `main`'s remainder (emit options, activation inventory)
 *  consumes, under the names it consumed them by when they were inline. */
export interface ComposedScenePipeline {
    hasEnvironment: boolean;
    lightKinds: PinnedSingleLightType[];
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
    const gltfAssets = result.manifest.assets.filter(
        (asset) => asset.kind === "gltf",
    );
    const assetLightsReached =
        gltfAssets.some(
            (asset) =>
                gltfLightNodeCount(
                    resolve(outputPath, "assets", asset.output),
                ) > 0,
        ) || babylonLights(outputPath, result.manifest.assets).length > 0;
    const staticLightKinds =
        !result.manifest.dynamicSceneLights && !assetLightsReached
            ? result.manifest.sceneLightKinds
            : undefined;
    const singleStaticLight =
        staticLightKinds?.length === 1
            ? [staticLightKinds[0]!] as PinnedSingleLightType[]
            : [];
    const sceneArms = await pinnedSceneArms({
        lightKinds: staticLightKinds ? singleStaticLight : lightKinds,
        multiLight: staticLightKinds
            ? staticLightKinds.length > 1
            : lightKinds.length > 0,
        noLight: staticLightKinds
            ? staticLightKinds.length === 0
            : true,
        toneMapping:
            hasEnvironment && !result.manifest.mutableToneMappingEnabled
                ? [true]
                : hasEnvironment
                    ? [false, true]
                    : [false],
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
    // The runtime keys the variant table by material handle, which is
    // creation order: each glTF load appends its materials, and a scene
    // material appends where its `createPbrMaterial` runs. Every reached
    // scene creates its materials after every load, so the sequence is the
    // assets' materials in load order followed by the scene's; a material
    // created before a later load would interleave, and stays a named error.
    const composedVariants: PinnedRenderableVariant[] = [];
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
    // The generators in `scene.lights` order, which is the ordinal every
    // shadow contract names: the composed receiver's group-2 rows, the
    // shadow task's own scheduling, and the caster views it appends. One
    // list, so the composition and the runtime cannot disagree about which
    // generator is light `n`.
    const generatorsByLight = [...result.manifest.shadowGenerators].sort(
        (left, right) => left.lightIndex - right.lightIndex,
    );
    const shadowLights = generatorsByLight.map(
        (generator) => ({
            lightIndex: generator.lightIndex,
            // The filter comes off the pinned factory the manifest's kind
            // names, which is the same `_shadowType` field `pbr-renderable.ts`
            // reads to build its own slots -- so a generator family added
            // here without a receiver arm refuses rather than composing a
            // neighbour's fragment.
            shadowType: pinnedShadowFilter(generator.kind),
        }),
    );
    // `rebuildSingle` computes `receiveShadows` as `mesh.receiveShadows &&
    // hasSomeShadows`, so a scene with no generator composes no receiver
    // even where a mesh asked for one.
    const receiveShadowsBit = shadowLights.length > 0
        ? await pinnedReceiveShadowsBit()
        : 0;
    // The scene's own meshes follow every asset renderable, in creation
    // order, so a receiver's row is its creation index in that tail.
    const sceneMeshRowBase =
        renderableMeshFeatures.length - result.manifest.sceneMeshes.length;
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
        renderableMeshFeatures.slice(sceneMeshRowBase),
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
    // renderable never carries the bit, because an imported mesh refuses at
    // the assignment.
    for (const index of result.manifest.shadowReceiverMeshes) {
        const row = sceneMeshRowBase + index;
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
    const runtimePbrMeshBits = hasRuntimeThinInstances
        ? [await pinnedThinInstancesBit()]
        : [];
    const thinInstancesBit = runtimePbrMeshBits[0] ?? 0;
    let materialIndexBase = 0;
    let assetMetallicReflectanceRegistered = false;
    for (const asset of gltfAssets) {
        const path = resolve(outputPath, "assets", asset.output);
        const composed = await composeGltfMaterials(path, {
            linearImageProcessing,
        });
        assetMetallicReflectanceRegistered ||= composed.some(
            (material) => material.metallicReflectanceRegistered,
        );
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
                result.manifest.sceneMaterialCount + casterViewCount;
            casterViewCount += 1;
            if (caster.pbrMaterial === null) continue;
            const source =
                result.manifest.scenePbrMaterials[caster.pbrMaterial];
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
                        renderableMeshFeatures[
                            sceneMeshRowBase + caster.meshIndex
                        ] ?? 0,
                    ],
                    runtimePbrMeshBits,
                ),
            });
        }
    }
    const exactScenePbrMaterials = result.manifest.scenePbrMaterials.map(
        (material) => {
            if (material.unknownSceneMesh || !material.sceneMeshIndices) {
                return material;
            }
            const featureSets = new Set<number>();
            for (const meshIndex of material.sceneMeshIndices) {
                const row = result.manifest.sceneMeshes[meshIndex];
                const base = renderableMeshFeatures[
                    sceneMeshRowBase + meshIndex
                ] ?? 0;
                if (row?.thinInstances === "always") {
                    featureSets.add(base | thinInstancesBit);
                } else {
                    featureSets.add(base);
                    if (row?.thinInstances === "possible") {
                        featureSets.add(base | thinInstancesBit);
                    }
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
                scenePbrMaterials,
                sceneArms,
                materialIndexBase,
                expandRuntimeMeshFeatureSets(
                    [
                        ...renderableMeshFeatures,
                        await proceduralRenderableFeatures(),
                    ],
                    runtimePbrMeshBits,
                ),
                {
                    linearImageProcessing,
                    metallicReflectanceRegistered:
                        assetMetallicReflectanceRegistered,
                    ...(shadowLights.length > 0
                        ? {
                            shadowLights,
                            // `light_affects_mesh` can answer false only for
                            // a light naming the meshes it applies to, and
                            // only the `.babylon` loader fills those lists --
                            // so without such an asset every light in
                            // `scene.lights` affects every mesh, and a scene
                            // with a generator has at least one. The
                            // no-light arm is then unreachable for a
                            // receiver, exactly as the single-light one is.
                            perMeshLightLists: result.manifest.assets.some(
                                (asset) => asset.kind === "babylon",
                            ),
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
    // The scene-code rows the Standard table keys on: the same walk both
    // families read, sliced to the scene's own meshes.
    const standardSceneMeshFeatures = renderableMeshFeatures.slice(
        sceneMeshRowBase,
    );
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
                    ...new Set(standardSceneMeshFeatures),
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
        // The Standard mesh table covers every runtime mesh handle in
        // creation order: each asset's renderables as its loader creates
        // them (`.babylon` records carry no composition-relevant bits, so
        // zero rows sized by the loader's own walk), then the scene-code
        // meshes.
        standardRenderableMeshFeatures = [];
        for (const asset of result.manifest.assets) {
            if (asset.kind === "gltf") {
                standardRenderableMeshFeatures.push(
                    ...(await gltfRenderableFeatures(
                        resolve(outputPath, "assets", asset.output),
                    )),
                );
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
        // A node graph composes only the ESM caster: `buildNodeRenderables`
        // re-compiles its own bodies under the ESM bit, and there is no
        // depth-only node module for a PCF task to draw it through.
        for (const generator of result.manifest.shadowGenerators) {
            if (
                pinnedShadowFilter(generator.kind) === "esm" ||
                !generator.casters.some(
                    (caster) => caster.nodeMaterial === index,
                )
            ) {
                continue;
            }
            throw new Error(
                "A node material casts into a " +
                    `${pinnedShadowFilter(generator.kind)} shadow map, ` +
                    "which composes no caster module: the pin re-compiles " +
                    "the graph's own bodies under the ESM bit and has no " +
                    "depth-only node view." +
                    refusalReachedFrom(
                        result.manifest.featureSites,
                        "material:node",
                    ),
            );
        }
        const castsEsmShadow = result.manifest.shadowGenerators.some(
            (generator) =>
                pinnedShadowFilter(generator.kind) === "esm" &&
                generator.casters.some(
                    (caster) => caster.nodeMaterial === index,
                ),
        );
        const composed = await composeNodeMaterial(
            graph,
            label,
            graphShadowLights,
            castsEsmShadow,
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
        for (const name of material.textureNames) {
            if (composed.textures.some((binding) => binding.name === name)) {
                continue;
            }
            throw new Error(
                `Node material '${label}' is given a texture named ` +
                    `'${name}', which its graph declares no binding for.` +
                    nodeSite,
            );
        }
        nodeVariants.push({
            index,
            ...nodeVariantStageStems(index),
            composed,
        });
    }
    return {
        hasEnvironment,
        lightKinds,
        linearImageProcessing,
        gltfAssets,
        materialIndexBase,
        casterViewCount,
        renderableMeshFeatures,
        pinnedVariants,
        runtimeMeshFeatures,
        standardComposition,
        standardRenderableMeshFeatures,
        nodeVariants,
    };
}
