import { assetRootMutationStates } from "./types.js";
import {
    emissionArray,
    EmissionMap,
    journaled,
    writable,
} from "./emission-transaction.js";
import ts from "typescript";
import {
    registerAsset,
    resolveBundledAsset,
    type AssetRegistryContext,
} from "./assets.js";
import type { AssetDecoderConfiguration } from "../asset-decoders.js";
import type { CompileAsset, Feature, Value } from "./types.js";
import type { LoweringServices } from "./lowering-services.js";

/** What the asset registry reads of the compiler. */
export interface AssetRegistryOwnerContext
    extends
        AssetRegistryContext,
        Pick<
            LoweringServices,
            "hasFeature" | "isInRuntimeControlFlow" | "reachFeature"
        > {
    definiteCollectionMutation(): boolean;
    readonly features: ReadonlySet<Feature>;
    /** How many frame callbacks enclose the current emission. */
    readonly frameCallbackDepth: number;
    /** How many runtime control-flow constructs enclose it. */
    readonly runtimeControlFlowDepth: number;
}

/**
 * Registers packaged assets and records what generation stamps on them: decoder configuration,
 * glTF container order and camera activation, the selected material variant, the unlit arm, and
 * imported roots whose hierarchy setParent moved.
 */
export class AssetRegistry {
    constructor(private readonly context: AssetRegistryOwnerContext) {}

    public readonly assetDecoders = new EmissionMap<
        "configuration",
        AssetDecoderConfiguration
    >();
    public readonly decoderBootstrapDepths: number[] = emissionArray([]);
    /** The source-keyed record for the most recent `loadGltf` call. */
    @journaled private accessor lastGltfContainerAsset:
        CompileAsset | undefined;

    public setAssetDecoderConfiguration(
        configuration: AssetDecoderConfiguration,
        node: ts.Node,
    ): void {
        const current = this.assetDecoders.get("configuration");
        if (
            Object.entries(configuration).every(
                ([key, value]) =>
                    JSON.stringify(
                        current?.[key as keyof AssetDecoderConfiguration],
                    ) === JSON.stringify(value),
            )
        )
            return;
        if (
            (this.context.isInRuntimeControlFlow() &&
                this.decoderBootstrapDepths.at(-1) !==
                    this.context.runtimeControlFlowDepth) ||
            [...this.context.assets.values()].some(
                (asset) => asset.kind === "gltf" || asset.kind === "basis",
            )
        )
            this.context.fail(
                node,
                "Asset decoder configuration requires definite setup before compressed asset loads.",
            );
        this.assetDecoders.set("configuration", {
            ...current,
            ...configuration,
        });
    }

    public registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset {
        const asset = registerAsset(this.context, source, kind, faceSize);
        const decoders = this.assetDecoders.get("configuration");
        if (kind === "gltf" && decoders)
            writable(asset).assetDecoders = decoders;
        return asset;
    }

    /**
     * Records that `setParent` transferred this imported root's hierarchy.
     * The token follows aliases of this handle, rather than the source-keyed
     * asset record shared by repeated loads.
     */
    public markAssetRootReparented(root: Value, node: ts.Node): void {
        if (!root.assetRootState) {
            this.context.fail(
                node,
                "An imported root is missing its compile-time handle identity.",
            );
        }
        for (const state of assetRootMutationStates(root))
            writable(state).reparented = true;
    }

    /**
     * The current root setters address the asset's outer transform. After
     * `setParent`, the hierarchy follows the new TransformNode instead, so a
     * later write through the old root handle would mutate stale state.
     */
    public assertAssetRootWritable(root: Value, node: ts.Node): void {
        if (assetRootMutationStates(root).some((state) => state.reparented)) {
            this.context.fail(
                node,
                "Writing an imported root after setParent is not lowered; " +
                    "the hierarchy now follows its new TransformNode parent.",
            );
        }
    }

    public enableGltfCameras(node: ts.Node): void {
        if (!this.context.definiteCollectionMutation()) {
            this.context.fail(
                node,
                "glTF camera activation requires a definite setup call; runtime activation order is not represented by packaged assets.",
            );
        }
        this.context.reachFeature("loader:gltf-cameras", node);
        this.context.reachFeature("camera:free", node);
    }

    /**
     * Records one run-time glTF container while preserving the order that
     * generation can represent.
     *
     * The asset manifest is keyed by source, and composition expands each
     * record by `containerCount`. Contiguous repeats therefore preserve
     * A,A,B,B exactly, while an interleaved repeat such as A,B,A would be
     * emitted as A,A,B. Refuse the latter at its returning load instead of
     * assigning composed material/mesh handles to the wrong container.
     */
    public recordGltfContainerLoad(asset: CompileAsset, node: ts.Node): void {
        if (
            (asset.containerCount ?? 0) > 0 &&
            this.lastGltfContainerAsset !== asset
        ) {
            this.context.fail(
                node,
                `glTF asset '${asset.source}' is loaded again after a ` +
                    "different glTF source; repeated loads must be " +
                    "contiguous because generation groups containers by " +
                    "their source-keyed asset record.",
            );
        }
        // One record can back several containers, because assets are keyed
        // by source. A fact generation stamps on the record reaches all of
        // them, so the count is also what lets such a fact refuse instead of
        // widening silently.
        writable(asset).containerCount = (asset.containerCount ?? 0) + 1;
        if (this.context.hasFeature("loader:gltf-cameras"))
            writable(asset).gltfCameras = true;
        this.lastGltfContainerAsset = asset;
    }

    /**
     * Records the one `KHR_materials_variants` selection a scene makes.
     *
     * The fold represents a selection that holds for the whole run, so every
     * shape it cannot produce refuses here rather than compiling to a state
     * the pin never reaches: a second, differing selection on one asset (only
     * the last would render), a selection on a second asset (one name is
     * compiled in and the generated loader matches it against every document
     * it loads), and a selection made from a frame callback (per-frame
     * reassignment folded into frame zero).
     */
    public selectGltfVariant(
        asset: CompileAsset,
        variantName: string,
        node: ts.Node,
    ): void {
        if (this.context.frameCallbackDepth > 0) {
            this.context.fail(
                node,
                "selectVariant is folded to one selection for the whole run, " +
                    "so it cannot be called from a frame callback; that " +
                    "would need the pin's run-time variant table.",
            );
        }
        if (
            asset.selectedVariant !== undefined &&
            asset.selectedVariant !== variantName
        ) {
            this.context.fail(
                node,
                `selectVariant already chose '${asset.selectedVariant}' on ` +
                    "this asset; a second selection would need the pin's " +
                    "run-time variant table.",
            );
        }
        const other = [...this.context.assets.values()].find(
            (candidate) =>
                candidate !== asset && candidate.selectedVariant !== undefined,
        );
        if (other) {
            this.context.fail(
                node,
                `selectVariant already chose '${other.selectedVariant}' on ` +
                    `'${other.output}'; one name is compiled in for the ` +
                    "scene, so a second selecting asset would need the pin's " +
                    "run-time variant table.",
            );
        }
        writable(asset).selectedVariant = variantName;
    }

    /**
     * Records the `setPbrUnlit` a scene applied to a loaded container's
     * materials.
     *
     * The pin's setter flags the material object, and its extension's
     * `detect` reads that flag when the variant is composed — so for a
     * loaded material the flag has to reach generation, not just the
     * record. It is kept on the container because the reached shape is a
     * proven walk over every renderable it carries; a single loaded
     * material has no compile-time identity a setter could name.
     */
    public recordAssetSceneUnlit(
        asset: CompileAsset,
        tint: readonly [number, number, number] | undefined,
        node: ts.Node,
    ): void {
        // The record is shared by every `loadGltf` of one source, so a
        // second container would compose unlit without ever being walked.
        if ((asset.containerCount ?? 0) > 1) {
            this.context.fail(
                node,
                `'${asset.output}' is loaded more than once, and the unlit ` +
                    "arm is composed per document rather than per container, " +
                    "so stamping one container would compose the others " +
                    "unlit too.",
            );
        }
        const existing = asset.sceneUnlit;
        if (existing && existing.tint?.join() !== tint?.join()) {
            this.context.fail(
                node,
                "setPbrUnlit already tinted this container's materials " +
                    "differently; generation composes one unlit arm per " +
                    "document, so a second tint would need the tint to be a " +
                    "per-material record read.",
            );
        }
        writable(asset).sceneUnlit = tint ? { tint } : {};
    }

    public resolveBundledAsset(source: string): string {
        return resolveBundledAsset(
            source,
            this.context.options.fileName,
            this.context.options,
        );
    }

    /**
     * Whether a glTF has already been loaded at this point in the walk.
     *
     * The one question this compiler asks of the reached-feature set
     * *during* the walk rather than after it, and it is deliberately
     * narrow: the set is otherwise an accumulate-only inventory, and a
     * general "has this been reached yet" query would make every consumer
     * order-sensitive. `enableBoneControl` needs it because upstream the
     * call installs a builder hook, so only the loads after it carry
     * skeletons — and this port emits ONE loader for every load, so it
     * cannot give two assets different builders and refuses the order
     * instead.
     */
    public gltfAlreadyLoaded(): boolean {
        return this.context.features.has("loader:gltf");
    }
}
