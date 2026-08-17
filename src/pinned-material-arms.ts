/**
 * The PBR arms a scene's glTF materials actually compose, from the pin.
 *
 * The renderer emits one PBR fragment per scene and selects per-material
 * behaviour from uniform lanes inside it, where Babylon composes one fragment
 * per material feature set. That difference is why a missed arm reads as a
 * small systematic shading bias instead of a failure: the fragment still
 * compiles, still binds, still draws, and is simply missing a term.
 *
 * This closes that. Every material is run through the pin's own composer and
 * the arms it produces are compared against the ones the emitted fragment was
 * built with. A material that reaches an arm the fragment does not have is a
 * generation error, named after the material, rather than a number moving in
 * a parity report weeks later.
 *
 * The comparison is deliberately one-directional. The emitted fragment is a
 * union over the scene, and scene code can enable arms no glTF material asks
 * for — Scene 21's cloth gets its sheen from `setPbrSheen`, not its asset — so
 * a fragment carrying more than the assets need is normal. Carrying less is not.
 */
import { readFileSync } from "node:fs";
import {
    gltfAnimatedExtensionTargets,
    gltfAnimatedMaterialPointers,
    gltfImageResolver,
    pinnedMaterialInputFromGltf,
} from "./pinned-material-input.js";
import {
    composePinnedPbrVariant,
    type PinnedComposeOptions,
} from "./pinned-pbr-variants.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/**
 * The composer's material UBO spec as plain data.
 *
 * `_offsets` is a `Map<string, number>`, so it serializes to `{}` and any
 * consumer reading the JSON would have to recompute the layout from WGSL
 * alignment rules. The pin's own `_writeMaterialData` keys every field off this
 * map, which makes it the authority on where each field sits.
 */
function plainMaterialUboSpec(spec: unknown): unknown {
    const record = spec as
        | { _totalBytes?: number; _offsets?: unknown; _structBody?: string }
        | undefined;
    if (!record) return spec;
    const offsets: Record<string, number> = {};
    if (record._offsets instanceof Map) {
        for (const [name, offset] of record._offsets as Map<string, number>) {
            offsets[name] = offset;
        }
    }
    return {
        _totalBytes: record._totalBytes,
        _offsets: offsets,
        _structBody: record._structBody,
    };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

/** The arms the emitted fragment either has or does not have. */
export interface PinnedMaterialArms {
    clearcoat: boolean;
    /** The coat's base-F0 remap — `useF0Remap`, which no glTF coat asks for. */
    clearcoatF0Remap: boolean;
    sheen: boolean;
    sheenAlbedoScaling: boolean;
    iridescence: boolean;
    occlusionUv2: boolean;
    transmission: boolean;
    dispersion: boolean;
}

const noArms: PinnedMaterialArms = {
    clearcoat: false,
    clearcoatF0Remap: false,
    sheen: false,
    sheenAlbedoScaling: false,
    iridescence: false,
    occlusionUv2: false,
    transmission: false,
    dispersion: false,
};

/** One composed material: the pin's key for it, plus the name to blame. */
export interface PinnedComposedMaterial {
    name: string;
    fragmentKey: string;
    arms: PinnedMaterialArms;
    /**
     * The pin's own composed stages and material UBO layout for this variant.
     *
     * The composer already runs here to derive the arms; keeping its output is
     * what lets generation emit the pin's fragment instead of the transcription
     * under `templates/renderer/`. One entry per distinct `fragmentKey` is the
     * variant table the per-variant renderer needs.
     */
    vertexWgsl: string;
    fragmentWgsl: string;
    materialUboSpec: unknown;
}

interface GltfDocument {
    materials?: Record<string, unknown>[];
    animations?: unknown;
    textures?: unknown;
}

/** Reads a .glb's JSON chunk. Returns nothing for anything else. */
function glbDocument(path: string): GltfDocument | undefined {
    let bytes: Buffer;
    try {
        bytes = readFileSync(path);
    } catch {
        return undefined;
    }
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
        return undefined;
    }
    const jsonLength = bytes.readUInt32LE(12);
    if (bytes.length < 20 + jsonLength) return undefined;
    try {
        return JSON.parse(
            bytes.subarray(20, 20 + jsonLength).toString("utf8"),
        ) as GltfDocument;
    } catch {
        return undefined;
    }
}

/**
 * Composes every material in a glTF document and reports the arms each needs.
 *
 * The scene-shaped inputs the composer also takes — the light mode, the
 * environment, tone mapping — are deliberately left at their defaults. None of
 * them changes *which extension arms* a material composes, and the ones that
 * would need the scene's own lowered state rather than its asset.
 */
export async function composeGltfMaterials(
    path: string,
): Promise<readonly PinnedComposedMaterial[]> {
    const document = glbDocument(path);
    const materials = document?.materials;
    if (!materials?.length) return [];

    const { PBR_HAS_ENV, PBR_HAS_SHEEN_ALBEDO_SCALING } =
        await importPinnedModule<{
            PBR_HAS_ENV: number;
            PBR_HAS_SHEEN_ALBEDO_SCALING: number;
        }>("material/pbr/pbr-flag-bits.js");
    const record = document as unknown as Record<string, unknown>;
    const imageOf = gltfImageResolver(record);
    const animatedBaseColor = gltfAnimatedMaterialPointers(
        record,
        "pbrMetallicRoughness/baseColorFactor",
    );
    const animatedUvTransform = gltfAnimatedMaterialPointers(
        record,
        ".*/KHR_texture_transform/(?:offset|scale|rotation)",
    );
    const animatedEmissive = new Set([
        ...gltfAnimatedMaterialPointers(record, "emissiveFactor"),
        ...gltfAnimatedMaterialPointers(
            record,
            "extensions/KHR_materials_emissive_strength/emissiveStrength",
        ),
    ]);
    const animatedExtensions = gltfAnimatedExtensionTargets(record);

    const composed: PinnedComposedMaterial[] = [];
    for (const [index, material] of materials.entries()) {
        const input = pinnedMaterialInputFromGltf(material, {
            imageOf,
            animatedBaseColorFactor: animatedBaseColor.has(index),
            animatedEmissive: animatedEmissive.has(index),
            animatedUvTransform: animatedUvTransform.has(index),
            ...(animatedExtensions.has(index)
                ? { animatedExtensionTargets: animatedExtensions.get(index)! }
                : {}),
        });
        const options: PinnedComposeOptions = {
            sceneFeatures: PBR_HAS_ENV,
            uv2Mask: (input["_uv2Mask"] as number | undefined) ?? 0,
        };
        const variant = await composePinnedPbrVariant(input, options);
        const key = variant.fragmentKey;
        const coat = key.includes("clearcoat");
        composed.push({
            name: typeof material["name"] === "string"
                ? material["name"]
                : `material ${index}`,
            fragmentKey: key,
            arms: {
                clearcoat: coat,
                // `-X` in the coat's own key is PBR2_CC_F0_REMAP_OFF, which
                // every glTF coat sets; a coat without it wants the remap.
                clearcoatF0Remap: coat && !/clearcoat-[A-Z]*X/.test(key),
                sheen: key.includes("sheen"),
                // The two sheen models live inside one `sheen` arm, so the key
                // does not separate them and the bit has to be read. A glTF
                // sheen always takes the scaling one, because
                // `gltf-ext-sheen.ts` passes `albedoScaling: true` — but read
                // from the composition rather than asserted, so it follows the
                // pin if that ever stops being true.
                sheenAlbedoScaling:
                    (variant.features & PBR_HAS_SHEEN_ALBEDO_SCALING) !== 0,
                iridescence: key.includes("iridescence"),
                occlusionUv2:
                    ((input["_uv2Mask"] as number | undefined) ?? 0) !== 0,
                transmission: key.includes("refraction"),
                // Dispersion has no feature bit of its own. It rides on
                // `_subsurface.refraction.dispersion`, which the refraction
                // extension's `frag` reads off the material to choose the
                // chromatic sample, so it is read from the same place.
                dispersion:
                    (
                        asRecord(
                            asRecord(input["_subsurface"])?.["refraction"],
                        )?.["dispersion"]
                    ) !== undefined,
            },
            vertexWgsl: variant.vertexWgsl,
            fragmentWgsl: variant.fragmentWgsl,
            // `_offsets` is a Map, which serializes to `{}`. The pin's own
            // `_writeMaterialData` keys every field off it, so it is the
            // authority on where each field sits — carry it as an object rather
            // than recomputing the layout from alignment rules here.
            materialUboSpec: plainMaterialUboSpec(variant.materialUboSpec),
        });
    }
    return composed;
}

/** The union of arms every material in a set needs. */
export function unionArms(
    materials: readonly PinnedComposedMaterial[],
): PinnedMaterialArms {
    const union = { ...noArms };
    for (const material of materials) {
        for (const arm of Object.keys(union) as (keyof PinnedMaterialArms)[]) {
            union[arm] ||= material.arms[arm];
        }
    }
    return union;
}

/**
 * Fails when a material composes an arm the emitted fragment does not carry.
 *
 * `emitted` is what the fragment was actually built with. Extra arms there are
 * fine — the fragment is a scene-wide union and scene code contributes to it —
 * so only missing ones are reported, with the material that needs each.
 */
export function assertArmsCovered(
    materials: readonly PinnedComposedMaterial[],
    emitted: Partial<PinnedMaterialArms>,
    asset: string,
): void {
    const missing: string[] = [];
    for (const material of materials) {
        for (const arm of Object.keys(noArms) as (keyof PinnedMaterialArms)[]) {
            if (material.arms[arm] && emitted[arm] !== true) {
                missing.push(
                    `  ${JSON.stringify(material.name)} composes ` +
                        `${material.fragmentKey} and needs '${arm}'`,
                );
            }
        }
    }
    if (missing.length === 0) return;
    throw new Error(
        `The PBR fragment emitted for ${asset} is missing arms Babylon Lite ` +
            `composes for its own materials:\n${missing.join("\n")}\n` +
            "Each of these would render as a shading bias rather than a " +
            "failure, so it is refused here instead.",
    );
}
