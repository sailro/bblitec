// The one step that joins what the assets carry into the scene's features.
//
// Babylon Lite activates a unit through one of two entry paths that end at
// the same registration: a scene call, or the loader's own trigger reading
// the asset (`gltf-feature-registry.ts`, `load-babylon.ts`). The compiler's
// walk sees the first path; this step owns the second. It runs as soon as
// the assets are materialized, before anything past compilation reads the
// feature list, and it gives each feature it adds what the compiler gives a
// reached one: its implications, its runtime and generated sources and
// `features.cmake`, and its feature-keyed adaptation rows. The capabilities
// an asset and a scene call can both activate are decided here once, with
// their reasons, as the activation plan every consumer reads.
import type { CompileAsset, CompileResult } from "./compiler.js";
import type { Feature } from "./compiler/types.js";
import {
    featureKeyedAdaptations,
    splatHarmonicsSidecarAdaptation,
} from "./compiler/adaptations.js";
import {
    asFeatures,
    impliedFeatures,
    projectFeatures,
} from "./compiler/output-projection.js";
import {
    gltfAssetDocument,
    gltfHasCompressedImages,
    gltfHasGaussianSplats,
    type AssetSpecializationFeatures,
} from "./asset-specializer.js";
import { babylonLights, type BabylonLight } from "./babylon-asset-features.js";
import { SPLAT_CONTAINERS } from "./compiler/assets.js";
import type { JsonRecord } from "./gltf-document.js";
import {
    packagedGltfTransmissionPlan,
    selectedGltfTransmission,
} from "./gltf-transmission-plan.js";
import {
    gltfHasImageBasedLight,
    gltfNodeLights,
    type PinnedMaterialArms,
} from "./pinned-material-arms.js";
import {
    parseFlowGraphs,
    type FlowGraphAssetPrograms,
} from "./pinned-flow-graph.js";

/** A merged capability and every reason that turned it on. */
export interface Activation {
    readonly value: boolean;
    readonly reasons: readonly string[];
}

function activation(
    parts: ReadonlyArray<readonly [boolean, string]>,
): Activation {
    const reasons = parts.filter(([on]) => on).map(([, reason]) => reason);
    return { value: reasons.length > 0, reasons };
}

/**
 * The capabilities a scene call and an asset can both turn on, each decided
 * once from both halves.
 */
export interface ActivationPlan {
    /** The deformation vertex layout and palette-as-world transport. */
    gpuDeformation: Activation;
    /** The storage-buffer morph mechanism, the pin's only one. */
    morphStorage: Activation;
    /** The per-instance vertex stream. */
    gpuInstancing: Activation;
    /** The per-mesh visibility the render plan and camera framing skip on. */
    nodeVisibility: Activation;
    /** `_linearImageProcessing` on every composed material. */
    linearImageProcessing: Activation;
    /**
     * The transmission renderer: the linear retarget, the image-processing
     * resolve and the scene-colour grab. Decided after composition by
     * `sceneTransmission`.
     */
    transmission: Activation;
}

/** The plan as the join decides it, before composition has run. */
type JoinedActivationPlan = Omit<ActivationPlan, "transmission">;

/**
 * The transmission renderer, from the pin's two ways in: the scene
 * transmission unit (`enableSceneTransmission`, which a loaded transmissive
 * material's scene hook reaches too), and a composed variant carrying the
 * refraction fragment that samples the grab.
 */
export function sceneTransmission(
    features: readonly string[],
    composedArms: Pick<PinnedMaterialArms, "transmission">,
): Activation {
    return activation([
        [
            features.includes("renderer:transmission"),
            "the scene reaches renderer:transmission (enableSceneTransmission)",
        ],
        [
            composedArms.transmission,
            "a composed PBR variant carries the pin's refraction fragment",
        ],
    ]);
}

export interface AssetFeatureJoin {
    /** Each joined feature and the asset output that carried it. */
    joined: ReadonlyMap<string, string>;
    /** The KHR_interactivity graphs the pin's parser kept, per asset. */
    flowGraphs: FlowGraphAssetPrograms[];
    /** The asset registering the most punctual light nodes, if any does. */
    assetLightNodes: { count: number; asset: string } | undefined;
    /** Any glTF asset installs its own EXT_lights_image_based environment. */
    imageBasedLight: boolean;
    /** Every `.babylon` asset's own lights, in asset order. */
    babylonLights: BabylonLight[];
    plan: JoinedActivationPlan;
}

interface AssetFeatureJoinInputs {
    result: CompileResult;
    outputPath: string;
    /** Each glTF asset's packaged document, parsed once for generation. */
    documents: ReadonlyMap<string, JsonRecord>;
    specialization: AssetSpecializationFeatures;
    /** The splat container whose parse answered spherical harmonics. */
    splatHarmonics: CompileAsset | undefined;
}

/**
 * Join every asset-carried feature into `result`, re-project the finished
 * list, and decide the activation plan.
 *
 * Joined features are appended in join order after the compiled ones, each
 * behind the features it implies; a feature scene source already reached is
 * not re-attributed to an asset.
 */
export async function joinAssetFeatures({
    result,
    outputPath,
    documents,
    specialization,
    splatHarmonics,
}: AssetFeatureJoinInputs): Promise<AssetFeatureJoin> {
    const { manifest } = result;
    const compiled = asFeatures(manifest.features);
    const joined = new Map<string, string>();
    const join = (feature: Feature, asset: string): void => {
        if (manifest.features.includes(feature)) return;
        for (const implied of impliedFeatures(feature)) join(implied, asset);
        manifest.features.push(feature);
        joined.set(feature, asset);
    };

    // A glTF asset's own triggers, each read off its packaged document once:
    // the lights its executed light plan registers (the pin's loader creates
    // them exactly like scene code does), EXT_lights_image_based's own
    // environment, the Gaussian clouds packaging converted, the transcoded
    // KHR_texture_basisu images, and the KHR_interactivity graphs the pin's
    // parser keeps -- an empty result activates nothing.
    const flowGraphs: FlowGraphAssetPrograms[] = [];
    let assetLightNodes: AssetFeatureJoin["assetLightNodes"];
    let imageBasedLight = false;
    for (const asset of manifest.assets) {
        if (asset.kind !== "gltf") continue;
        const document = gltfAssetDocument(documents, asset);
        const nodeLights = gltfNodeLights(document);
        if (nodeLights.count > (assetLightNodes?.count ?? 0)) {
            assetLightNodes = { count: nodeLights.count, asset: asset.output };
        }
        for (const kind of nodeLights.kinds)
            join(`light:${kind}`, asset.output);
        if (gltfHasImageBasedLight(document)) {
            imageBasedLight = true;
            join("environment:ibl", asset.output);
        }
        if (gltfHasGaussianSplats(document)) join("loader:splat", asset.output);
        if (gltfHasCompressedImages(document))
            join("texture:compressed", asset.output);
        const graphs = await parseFlowGraphs(asset.output, document);
        if (graphs.length > 0) {
            flowGraphs.push({ asset: asset.output, graphs });
            join("flow-graph:interactivity", asset.output);
        }
        // A material the loader makes transmissive calls setPbrTransmission,
        // whose scene hook enables scene transmission exactly as
        // enableSceneTransmission does -- the selection packaging recorded
        // by running the pin's own loader over this document.
        const transmission = packagedGltfTransmissionPlan(document);
        if (
            transmission !== undefined &&
            selectedGltfTransmission(transmission, asset.selectedVariant)
        )
            join("renderer:transmission", asset.output);
    }
    // A splat container that parsed to a non-zero degree is what
    // `attachParsedSplat` forks on; no scene API names it. The row names the
    // parser of the container that answered, which a container kind states
    // in its own table row; anything else came through the plain PLY loader.
    if (splatHarmonics !== undefined) {
        join("loader:splat-sh", splatHarmonics.output);
        manifest.adaptations.push(
            splatHarmonicsSidecarAdaptation(
                SPLAT_CONTAINERS.get(splatHarmonics.kind)?.parser ??
                    "convertCompressedPlyToParsedSplat",
            ),
        );
    }
    // A `.babylon` document's own lights are the scene's lights the way a
    // glTF's are: the generated loader fills point LightRecords (`type: 0` is
    // the only kind it accepts) for the pinned lights block to consume.
    const assetBabylonLights: BabylonLight[] = [];
    for (const asset of manifest.assets) {
        if (asset.kind !== "babylon") continue;
        const lights = babylonLights(outputPath, [asset]);
        assetBabylonLights.push(...lights);
        if (lights.some((light) => light.type === 0))
            join("light:point", asset.output);
    }

    if (joined.size > 0) {
        const features = asFeatures(manifest.features);
        const projected = projectFeatures(
            features,
            manifest.sourceUnits.map(({ path }) => path),
        );
        manifest.runtimeSources = projected.runtimeSources;
        manifest.generatedSources = projected.generatedSources;
        result.cmake = projected.cmake;
        const compiledRows = new Set(
            featureKeyedAdaptations(compiled).map(({ id }) => id),
        );
        manifest.adaptations.push(
            ...featureKeyedAdaptations(features).filter(
                ({ id }) => !compiledRows.has(id),
            ),
        );
    }

    const has = (feature: Feature): boolean =>
        manifest.features.includes(feature);
    return {
        joined,
        flowGraphs,
        assetLightNodes,
        imageBasedLight,
        babylonLights: assetBabylonLights,
        plan: {
            // Initial skin and morph state needs the local-vertex transport
            // animated nodes use, and so does a scene-authored deformation.
            gpuDeformation: activation([
                [
                    specialization.gpuDeformation,
                    "a glTF asset carries animations",
                ],
                [
                    has("mesh:morph-targets"),
                    "scene-source morph targets need the deformation " +
                        "vertex layout",
                ],
                [
                    has("mesh:skeleton"),
                    "a scene-authored skeleton needs the deformation " +
                        "vertex layout's joint and weight lanes",
                ],
            ]),
            // The pinned morph fragment reads its deltas and weights from
            // storage buffers, for scene-code targets as for an asset's.
            morphStorage: activation([
                [
                    specialization.morphStorage,
                    "a glTF asset runs the pinned morph feature",
                ],
                [
                    has("mesh:morph-targets"),
                    "scene source reached mesh:morph-targets (the pinned " +
                        "standard morph fragment reads storage buffers)",
                ],
            ]),
            gpuInstancing: activation([
                [
                    specialization.gpuInstancing,
                    "an asset uses EXT_mesh_gpu_instancing",
                ],
                [
                    has("mesh:thin-instances"),
                    "scene source reached mesh:thin-instances",
                ],
                [
                    has("mesh:thin-instances-dynamic"),
                    "scene source reached mesh:thin-instances-dynamic",
                ],
            ]),
            // An asset's KHR_node_visibility materializes the cascade at
            // load; scene code writes the same per-mesh boolean directly.
            nodeVisibility: activation([
                [
                    specialization.nodeVisibility,
                    "an asset uses KHR_node_visibility",
                ],
                [has("mesh:visible"), "scene code writes mesh.visible"],
            ]),
            // The pin marks every material linear when the scene enables
            // transmission and when a loaded material registers it alike.
            linearImageProcessing: activation([
                [
                    has("material:pbr-linear-image-processing"),
                    "scene source reached linear PBR image processing",
                ],
                [
                    specialization.assetTransmission,
                    "asset-carried KHR_materials_transmission enables the " +
                        "runtime's transmission exactly like the feature",
                ],
            ]),
        },
    };
}
