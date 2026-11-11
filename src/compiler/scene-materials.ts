import {
    emissionArray,
    EmissionMap,
    journaled,
    writable,
    type Mutable,
} from "./emission-transaction.js";
import type {
    ScenePbrAnisotropyManifest,
    ScenePbrClearCoatManifest,
    ScenePbrIridescenceManifest,
    ScenePbrLightmapManifest,
    ScenePbrMaterialManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
    PbrMaterialStateWrites,
    PbrPluginAppend,
    PbrStateTarget,
} from "./types.js";
import {
    materialPluginListHolds,
    materialPluginListKey,
    type MaterialPluginManifest,
} from "../pinned-material-plugins.js";
import type { PinnedStandardMaterialInput } from "../pinned-standard-variants.js";

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
    return pbrMaterialView(source, materialsBefore, "noColorView");
}

/**
 * The ESM caster's view of one scene PBR material.
 *
 * `createPbrEsmShadowMaterialView` is the no-colour view's sibling: the same
 * record with one bit set -- `PBR2_ESM_SHADOW_OUTPUT` rather than
 * `PBR2_NO_COLOR_OUTPUT` -- and the blend bit cleared, because the fragment
 * it composes returns the exponential depth instead of a colour. Which of
 * the two a caster takes is the generator's filter, exactly as it is for the
 * Standard family.
 */
export function pbrEsmShadowView(
    source: ScenePbrMaterialManifest,
    materialsBefore: number,
): ScenePbrMaterialManifest {
    return pbrMaterialView(source, materialsBefore, "esmShadowView");
}

/**
 * A derived view of one scene PBR material: its source record copied whole
 * to a new slot, remembering the slot it was derived from, with the one
 * view bit set that names which fragment the copy composes.
 */
function pbrMaterialView(
    source: ScenePbrMaterialManifest,
    materialsBefore: number,
    view: "noColorView" | "esmShadowView",
): ScenePbrMaterialManifest {
    const derived: ScenePbrMaterialManifest = {
        ...source,
        materialsBefore,
        sourceMaterialsBefore:
            source.sourceMaterialsBefore ?? source.materialsBefore,
    };
    return view === "noColorView"
        ? { ...derived, noColorView: true }
        : { ...derived, esmShadowView: true };
}

/** Every write either entry records, once. */
export function mergePbrStateWrites(
    known: PbrMaterialStateWrites,
    added: PbrMaterialStateWrites,
): PbrMaterialStateWrites {
    const merged = <T>(left: readonly T[], right: readonly T[]) => [
        ...left,
        ...right.filter((value) => !left.includes(value)),
    ];
    return {
        target: known.target,
        alphaBlend: merged(known.alphaBlend, added.alphaBlend),
        alphaBelowOne: merged(known.alphaBelowOne, added.alphaBelowOne),
        baseColorFactor: known.baseColorFactor || added.baseColorFactor,
        bentNormalTexture:
            known.bentNormalTexture === "definite" ||
            added.bentNormalTexture === "definite"
                ? "definite"
                : known.bentNormalTexture || added.bentNormalTexture,
        pluginSignatures: merged(
            known.pluginSignatures,
            added.pluginSignatures,
        ),
        pluginAppends: merged(known.pluginAppends, added.pluginAppends),
    };
}

/**
 * The scene-material manifest recorders: the creation-ordered slot
 * counter every material family bumps, and the PBR entries the setter
 * intrinsics stamp. The entry orchestrator holds one instance and
 * delegates, so the intrinsic context surface is unchanged while the
 * recording rules live here.
 */
/**
 * A PBR setter handed a material no scene-code record stands for: one
 * of another family, or one that reached the call through storage. The
 * intrinsic call refuses with it (`compileRegisteredIntrinsic`).
 */
export class UnresolvedScenePbrMaterial extends Error {
    public constructor(setter: string) {
        super(
            `${setter} names no scene-code PBR material; only a value ` +
                "createPbrMaterial produced, or a mesh one was assigned " +
                "to, resolves which record to stamp.",
        );
    }
}

export class SceneMaterialRecorder {
    public readonly scenePbrMaterials: ScenePbrMaterialManifest[] =
        emissionArray([]);
    public readonly standardMaterialPlugins: MaterialPluginManifest[][] =
        emissionArray([]);
    public readonly standardMaterialPluginInputs: PinnedStandardMaterialInput[][] =
        emissionArray([]);
    private readonly pluginIndexByKey = new EmissionMap<string, number>();
    /** The PBR plugin lists material records hold, by signature from one. */
    public readonly pbrPluginSignatures: MaterialPluginManifest[][] =
        emissionArray([]);
    private readonly pbrPluginIndexByKey = new EmissionMap<string, number>();
    /** The distinct PBR plugins a list test or append names, by id from zero. */
    public readonly pbrPlugins: MaterialPluginManifest[] = emissionArray([]);
    private readonly pbrPluginIdByKey = new EmissionMap<string, number>();
    /** Composition-relevant PBR writes, one entry per target. */
    private readonly pbrStateWrites = new EmissionMap<
        string,
        PbrMaterialStateWrites
    >();

    /** The written state entries, in first-written order. */
    public get pbrMaterialStates(): PbrMaterialStateWrites[] {
        return [...this.pbrStateWrites.values()];
    }

    /** The PBR signature (from one) of a plugin list; zero is no plugin. */
    public pbrPluginSignature(
        plugins: readonly MaterialPluginManifest[],
    ): number {
        if (plugins.length === 0) return 0;
        const key = materialPluginListKey(plugins);
        const existing = this.pbrPluginIndexByKey.get(key);
        if (existing !== undefined) return existing;
        this.pbrPluginSignatures.push([...plugins]);
        const index = this.pbrPluginSignatures.length;
        this.pbrPluginIndexByKey.set(key, index);
        return index;
    }

    /** The id of one plugin a list test or append names. */
    public pbrPluginId(plugin: MaterialPluginManifest): number {
        const key = materialPluginListKey([plugin]);
        const existing = this.pbrPluginIdByKey.get(key);
        if (existing !== undefined) return existing;
        this.pbrPlugins.push(plugin);
        this.pbrPluginIdByKey.set(key, this.pbrPlugins.length - 1);
        return this.pbrPlugins.length - 1;
    }

    /**
     * Every signature appends can reach from the ones written, numbered
     * after them, and each list's growth by each appended plugin it does not
     * hold (a second copy of one refuses at run time). A record's signature
     * is a byte, and the pin's index has seven bits.
     */
    public closePbrPluginSignatures(): PbrPluginAppend[] {
        const appended = new Set(
            [...this.pbrStateWrites.values()].flatMap(
                (writes) => writes.pluginAppends,
            ),
        );
        const growth: PbrPluginAppend[] = [];
        for (
            let signature = 0;
            signature <= this.pbrPluginSignatures.length;
            ++signature
        ) {
            const list =
                signature === 0 ? [] : this.pbrPluginSignatures[signature - 1]!;
            for (const plugin of appended) {
                const manifest = this.pbrPlugins[plugin]!;
                if (materialPluginListHolds(list, manifest)) continue;
                const grown = this.pbrPluginSignature([...list, manifest]);
                if (grown > 127)
                    throw new Error(
                        "Appended PBR plugin lists exceed the pin's 127 plugin signatures.",
                    );
                growth.push({ signature, plugin, grown });
            }
        }
        return growth;
    }

    /**
     * The program's plugin list algebra over the closed signatures: which
     * plugins a signature holds (`plugins.includes`) and the signature a list
     * takes with one more plugin (`plugins = [...plugins, plugin]`).
     */
    public pbrPluginFunctionsCpp(): string {
        if (this.pbrPlugins.length === 0) return "";
        const growth = this.closePbrPluginSignatures();
        const lists = [[], ...this.pbrPluginSignatures];
        const contains = lists.flatMap((list, signature) =>
            this.pbrPlugins.flatMap((plugin, id) =>
                materialPluginListHolds(list, plugin)
                    ? [`        case ${signature * 256 + id}u: return true;`]
                    : [],
            ),
        );
        const appends = growth.map(
            ({ signature, plugin, grown }) =>
                `        case ${signature * 256 + plugin}u: return ${grown};`,
        );
        return [
            "namespace bblscene {",
            "",
            "// Whether the PBR plugin list `signature` holds plugin `plugin`.",
            "[[maybe_unused]] inline bool pbr_plugin_signature_contains(std::uint32_t signature, std::uint32_t plugin) {",
            "    switch (signature * 256u + plugin) {",
            ...contains,
            "        default: return false;",
            "    }",
            "}",
            "",
            "// The signature of list `signature` with plugin `plugin` appended.",
            "[[maybe_unused]] inline std::uint8_t pbr_plugin_signature_append(std::uint32_t signature, std::uint32_t plugin) {",
            "    switch (signature * 256u + plugin) {",
            ...appends,
            '        default: throw std::runtime_error("A PBR plugin list grew past the signatures generation composed.");',
            "    }",
            "}",
            "",
            "}  // namespace bblscene",
        ].join("\n");
    }

    /**
     * Adds what one composition-relevant write gives the materials of
     * `target`. Each entry is replaced whole, so a write a rolled-back
     * emission made leaves nothing behind.
     */
    public recordPbrStateWrite(
        target: PbrStateTarget,
        write: {
            alphaBlend?: readonly boolean[];
            alphaBelowOne?: readonly boolean[];
            baseColorFactor?: true;
            bentNormalTexture?: true | "definite";
            pluginSignature?: number;
            pluginAppend?: number;
        },
    ): void {
        const key =
            target.kind === "scene"
                ? `scene:${target.index}`
                : target.kind === "asset"
                  ? `asset:${target.output}:${target.container ?? ""}`
                  : "assets";
        const added: PbrMaterialStateWrites = {
            target,
            alphaBlend: write.alphaBlend ?? [],
            alphaBelowOne: write.alphaBelowOne ?? [],
            baseColorFactor: write.baseColorFactor === true,
            bentNormalTexture: write.bentNormalTexture ?? false,
            pluginSignatures:
                write.pluginSignature === undefined
                    ? []
                    : [write.pluginSignature],
            pluginAppends:
                write.pluginAppend === undefined ? [] : [write.pluginAppend],
        };
        const known = this.pbrStateWrites.get(key);
        this.pbrStateWrites.set(
            key,
            known ? mergePbrStateWrites(known, added) : added,
        );
    }
    @journaled private accessor sceneMaterialCount = 0;

    /** The final creation count across families, for the manifest. */
    public get count(): number {
        return this.sceneMaterialCount;
    }

    /** Stamps a plugin list on the scene PBR material the write names. */
    public recordScenePbrPlugins(
        plugins: readonly MaterialPluginManifest[],
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("material.plugins", index).plugins =
            plugins;
    }

    /**
     * The signature index a Standard material's plugin list carries, from
     * one, assigning it on first use.
     *
     * `registerStdPlugins` keys a per-signature cache and hands out
     * `++counter` on a miss while walking the scene's meshes, and it skips
     * every material that is not Standard — so the numbering is first-seen
     * order over Standard materials alone. This is that counter, kept here
     * because the generated material record has to carry the index before
     * any pinned module is loaded; composition then feeds the pin the same
     * lists in the same order and refuses if it disagreed.
     */
    public recordStandardMaterialPlugins(
        plugins: readonly MaterialPluginManifest[],
        material: PinnedStandardMaterialInput,
    ): number {
        const key = materialPluginListKey(plugins);
        const existing = this.pluginIndexByKey.get(key);
        if (existing !== undefined) {
            writable(material).pluginIndex = existing;
            const inputs = this.standardMaterialPluginInputs[existing - 1]!;
            if (!inputs.includes(material)) writable(inputs).push(material);
            return existing;
        }
        this.standardMaterialPlugins.push([...plugins]);
        const index = this.standardMaterialPlugins.length;
        writable(material).pluginIndex = index;
        this.standardMaterialPluginInputs.push([material]);
        this.pluginIndexByKey.set(key, index);
        return index;
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
    ): Mutable<ScenePbrMaterialManifest> {
        const material =
            index === undefined ? undefined : this.scenePbrMaterials[index];
        if (!material) throw new UnresolvedScenePbrMaterial(setter);
        return writable(material);
    }

    /**
     * Records a no-color view of the scene material the call names: the
     * pin's view is the same material record rendered with
     * `PBR2_NO_COLOR_OUTPUT`, so the derived entry copies its source and
     * appends in creation order. Returns the new entry's index, which is
     * the view's own compile-time identity.
     */
    public recordScenePbrNoColorView(sourceIndex: number | undefined): number {
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
        this.sceneMaterialForSetter("setPbrGammaAlbedo", index).gammaAlbedo =
            true;
    }

    public recordScenePbrAlphaCutoff(
        index: number | undefined,
        cutoff: number,
    ): Readonly<ScenePbrMaterialManifest> {
        const material = this.sceneMaterialForSetter(
            "setPbrAlphaCutoff",
            index,
        );
        material.alphaCutOff = cutoff;
        return material;
    }

    public recordScenePbrShadowOnly(
        index: number | undefined,
        options: NonNullable<ScenePbrMaterialManifest["shadowOnly"]>,
    ): void {
        this.sceneMaterialForSetter("setShadowOnly", index).shadowOnly =
            options;
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
        this.sceneMaterialForSetter("setPbrClearCoat", index).clearCoat =
            clearCoat;
    }

    public recordScenePbrEmissive(
        color: readonly [number, number, number] | undefined,
        index: number | undefined,
    ): void {
        const material = this.sceneMaterialForSetter("setPbrEmissive", index);
        material.hasEmissiveColor = true;
        if (color) material.emissiveColor = color;
    }

    public recordScenePbrIridescence(
        iridescence: ScenePbrIridescenceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("setPbrIridescence", index).iridescence =
            iridescence;
    }

    public recordScenePbrLightmap(
        lightmap: ScenePbrLightmapManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("setPbrLightmap", index).lightmap =
            lightmap;
    }

    public recordScenePbrSubsurface(
        subsurface: ScenePbrSubsurfaceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("setPbrSubsurface", index).subsurface =
            subsurface;
    }

    public recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("setPbrAnisotropy", index).anisotropy =
            anisotropy;
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
                ? reflectance.color
                    ? { color: reflectance.color }
                    : {}
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
