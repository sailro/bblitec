import type {
    ScenePbrAnisotropyManifest,
    ScenePbrClearCoatManifest,
    ScenePbrIridescenceManifest,
    ScenePbrMaterialManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
} from "./types.js";

/**
 * A no-colour view of one scene PBR material, at the runtime handle it will
 * hold.
 *
 * The pin's view is the same material record rendered with
 * `PBR2_NO_COLOR_OUTPUT`, so the derived entry copies its source whole and
 * differs only in that bit and in where it lands. Two callers build one:
 * `createPbrNoColorMaterialView` in scene code, whose handle is the next
 * creation slot, and the shadow task's caster views, whose handles come
 * after every scene-code material because `registerSceneWithShadowSupport`
 * appends them when the scene is registered.
 */
export function pbrNoColorView(
    source: ScenePbrMaterialManifest,
    materialsBefore: number,
): ScenePbrMaterialManifest {
    return { ...source, materialsBefore, noColorView: true };
}

/**
 * The scene-material manifest recorders: the creation-ordered slot
 * counter every material family bumps, and the PBR entries the setter
 * intrinsics stamp. The entry orchestrator holds one instance and
 * delegates, so the intrinsic context surface is unchanged while the
 * recording rules live here.
 */
export class SceneMaterialRecorder {
    public readonly scenePbrMaterials: ScenePbrMaterialManifest[] = [];
    private sceneMaterialCount = 0;

    /** The final creation count across families, for the manifest. */
    public get count(): number {
        return this.sceneMaterialCount;
    }

    /**
     * Stamps setter options on the scene-code material the call names, the
     * way the pin's `setPbrSheen`/`setPbrClearCoat` stamp the props object
     * onto the material object they are handed. `index` is that object
     * identity at compile time and rides the value the setter was passed,
     * so a material of another family — which owns no manifest entry to
     * stamp — is a named failure rather than a guess.
     */
    private sceneMaterialForSetter(
        setter: string,
        index: number | undefined,
    ): ScenePbrMaterialManifest {
        const material =
            index === undefined
                ? undefined
                : this.scenePbrMaterials[index];
        if (!material) {
            throw new Error(
                `${setter} names no scene-code PBR material; only a value ` +
                    "createPbrMaterial produced, or a mesh one was assigned " +
                    "to, resolves which record to stamp.",
            );
        }
        return material;
    }

    /**
     * Records a no-color view of the scene material the call names: the
     * pin's view is the same material record rendered with
     * `PBR2_NO_COLOR_OUTPUT`, so the derived entry copies its source and
     * appends in creation order. Returns the new entry's index, which is
     * the view's own compile-time identity.
     */
    public recordScenePbrNoColorView(
        sourceIndex: number | undefined,
    ): number {
        const source = this.sceneMaterialForSetter(
            "createPbrNoColorMaterialView",
            sourceIndex,
        );
        this.scenePbrMaterials.push(
            pbrNoColorView(source, this.recordSceneMaterialSlot()),
        );
        return this.scenePbrMaterials.length - 1;
    }

    /**
     * Counts one scene-code material creation of any family. Every creator
     * bumps this: material handles are creation-ordered across families, so
     * a standard material shifts the next PBR handle.
     */
    public recordSceneMaterialSlot(): number {
        return this.sceneMaterialCount++;
    }

    public recordScenePbrUnlit(index: number | undefined): void {
        this.sceneMaterialForSetter("setPbrUnlit", index).unlit = true;
    }

    public recordScenePbrSkybox(index: number | undefined): void {
        this.sceneMaterialForSetter("setPbrSkybox", index).skyboxMode = true;
    }

    public recordScenePbrGammaAlbedo(index: number | undefined): void {
        this.sceneMaterialForSetter(
            "setPbrGammaAlbedo",
            index,
        ).gammaAlbedo = true;
    }

    public recordScenePbrSheen(
        sheen: ScenePbrSheenManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("setPbrSheen", index).sheen = sheen;
    }

    public recordScenePbrClearCoat(
        clearCoat: ScenePbrClearCoatManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrClearCoat",
            index,
        ).clearCoat = clearCoat;
    }

    public recordScenePbrEmissive(
        color: readonly number[],
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrEmissive",
            index,
        ).emissiveColor = color;
    }

    public recordScenePbrIridescence(
        iridescence: ScenePbrIridescenceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrIridescence",
            index,
        ).iridescence = iridescence;
    }

    public recordScenePbrSubsurface(
        subsurface: ScenePbrSubsurfaceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrSubsurface",
            index,
        ).subsurface = subsurface;
    }

    public recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrAnisotropy",
            index,
        ).anisotropy = anisotropy;
    }

    public recordScenePbrMetallicReflectance(
        reflectance: ScenePbrMetallicReflectanceManifest,
        index: number | undefined,
    ): void {
        const material = this.sceneMaterialForSetter(
            "setPbrMetallicReflectance",
            index,
        );
        const previous = material.metallicReflectance;
        material.metallicReflectance = {
            hasColor: previous?.hasColor === true || reflectance.hasColor,
            hasMetallicTexture:
                previous?.hasMetallicTexture === true ||
                reflectance.hasMetallicTexture,
            hasReflectanceTexture:
                previous?.hasReflectanceTexture === true ||
                reflectance.hasReflectanceTexture,
            ...(reflectance.hasColor
                ? (reflectance.color
                    ? { color: reflectance.color }
                    : {})
                : previous?.color
                    ? { color: previous.color }
                    : {}),
            ...(reflectance.useOnlyMetallicFromTexture !== undefined
                ? {
                    useOnlyMetallicFromTexture:
                        reflectance.useOnlyMetallicFromTexture,
                }
                : previous?.useOnlyMetallicFromTexture !== undefined
                    ? {
                        useOnlyMetallicFromTexture:
                            previous.useOnlyMetallicFromTexture,
                    }
                    : {}),
        };
    }
}
