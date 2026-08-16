/**
 * Maps a glTF material to the shape Babylon Lite's own feature derivation
 * reads.
 *
 * This module deliberately contains no feature bits. Each extension's `detect`
 * hook reads a named property off the material — `_clearCoat.isEnabled`,
 * `_sheen.isEnabled`, `_iridescence.isEnabled`, `_anisotropy.isEnabled`,
 * `_metallicReflectanceTexture` — and contributes its own bits, so all this has
 * to get right is which glTF extension populates which property. Anything it
 * gets wrong shows up as a different `fragmentKey`, which is checkable against
 * an instrumented capture rather than against intent.
 */
import type { PinnedMaterialInput } from "./pinned-pbr-variants.js";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;

const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;

const asNumbers = (value: unknown): number[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "number")
        ? (value as number[])
        : undefined;

/**
 * The glTF extension that populates each pinned material property, and the
 * extension property whose presence upstream treats as "enabled".
 *
 * `KHR_materials_clearcoat` is enabled by a non-zero factor upstream, so the
 * factor decides `isEnabled` rather than the extension's mere presence — a
 * material declaring the extension at factor zero composes no coat, which is
 * the same gate `setPbrClearCoat`'s `isEnabled` expresses from scene code.
 */
const materialExtensions: ReadonlyArray<{
    gltf: string;
    property: string;
    factor: string;
    /**
     * `[glTF slot, pinned property]` for each texture the extension's `detect`
     * tests. The two names differ per extension — the coat's normal map is
     * `bumpTexture` upstream, the sheen tint is plain `texture` — so they are
     * listed rather than derived. Copying under the glTF name instead leaves
     * every map bit clear, which composes a variant that looks plausible and
     * is missing an arm.
     */
    textures: ReadonlyArray<readonly [string, string]>;
}> = [
    {
        gltf: "KHR_materials_clearcoat",
        property: "_clearCoat",
        factor: "clearcoatFactor",
        // `CC_TEX` in clearcoat-fragment.ts.
        textures: [
            ["clearcoatTexture", "texture"],
            ["clearcoatRoughnessTexture", "roughnessTexture"],
            ["clearcoatNormalTexture", "bumpTexture"],
        ],
    },
    {
        gltf: "KHR_materials_sheen",
        property: "_sheen",
        factor: "sheenColorFactor",
        // sheen-fragment.ts reads `sh.texture` and `sh.roughnessTexture`.
        textures: [
            ["sheenColorTexture", "texture"],
            ["sheenRoughnessTexture", "roughnessTexture"],
        ],
    },
    {
        gltf: "KHR_materials_iridescence",
        property: "_iridescence",
        factor: "iridescenceFactor",
        // `IRI_TEX` in iridescence-fragment.ts.
        textures: [
            ["iridescenceTexture", "texture"],
            ["iridescenceThicknessTexture", "thicknessTexture"],
        ],
    },
    {
        gltf: "KHR_materials_anisotropy",
        property: "_anisotropy",
        factor: "anisotropyStrength",
        textures: [["anisotropyTexture", "texture"]],
    },
];

/**
 * True when an extension's enabling factor is present and non-zero.
 *
 * Every factor above defaults to zero in glTF — `clearcoatFactor`,
 * `iridescenceFactor` and `anisotropyStrength` are `0`, `sheenColorFactor` is
 * `[0,0,0]` — so an extension declared without its factor is *disabled*, not
 * enabled. Defaulting the other way is not a harmless over-approximation: it
 * composes an extra layer into the fragment and changes the variant, which is
 * how Scene 253's Volume and IOR spheres both came out as iridescent.
 */
function extensionEnabled(extension: JsonObject, factor: string): boolean {
    const value = extension[factor];
    const scalar = asNumber(value);
    if (scalar !== undefined) return scalar !== 0;
    const vector = asNumbers(value);
    if (vector !== undefined) return vector.some((entry) => entry !== 0);
    return false;
}

/**
 * `needsGltfEmissive`: whether a glTF material's emissive is applied at all.
 *
 * `emissiveFactor` multiplies the emissive texture, so `[1,1,1]` alongside a
 * texture is a no-op and the pin attaches nothing — which is why an emissive
 * texture alone does not put `PBR_HAS_EMISSIVE` on the material, and why the
 * composed UBO then declares no `emissiveUVm` pair. With no texture, `[1,1,1]`
 * is a real full-white emissive and does apply; the glTF default is `[0,0,0]`,
 * which never does.
 */
function gltfEmissiveApplies(material: JsonObject): boolean {
    const factor = asNumbers(material["emissiveFactor"]) ?? [0, 0, 0];
    const hasTexture = asObject(material["emissiveTexture"]) !== undefined;
    const black =
        factor[0] === 0 && factor[1] === 0 && factor[2] === 0;
    const neutralOverTexture =
        hasTexture && factor[0] === 1 && factor[1] === 1 && factor[2] === 1;
    return !(black || neutralOverTexture);
}

/**
 * The markers `KHR_texture_transform`'s loader extension stamps on a texture,
 * ported term for term from `loader-gltf/gltf-ext-uv-transform.ts`.
 *
 * The distinctions here are all load-bearing and none of them are guessable:
 *
 * - `_hasTx` is set only when the transform contributes a *field*. A declared
 *   but empty `KHR_texture_transform: {}` patches nothing, so it composes no
 *   UV-transform arm — Scene 39's Grass material is exactly that case, and
 *   treating the extension's presence as the test composed four UBO fields
 *   and a `txfUV` helper the browser's fragment does not have.
 * - `rotation` is read for truthiness, so a rotation of `0` also patches
 *   nothing, the same as omitting it.
 * - `_texCoord` comes from the transform's own `texCoord` when it has one and
 *   the slot's otherwise, and only a value of exactly `1` is stamped.
 */
function pinnedTexturePatch(slot: JsonObject | undefined): {
    _hasTx?: true;
    _texCoord?: 1;
} {
    if (slot === undefined) return {};
    const transform = asObject(
        asObject(slot["extensions"])?.["KHR_texture_transform"],
    );
    const patched =
        transform !== undefined &&
        (transform["scale"] !== undefined ||
            transform["offset"] !== undefined ||
            Boolean(transform["rotation"]));
    const texCoord = asNumber(transform?.["texCoord"]) ??
        asNumber(slot["texCoord"]);
    return {
        ...(patched ? { _hasTx: true as const } : {}),
        ...(texCoord === 1 ? { _texCoord: 1 as const } : {}),
    };
}

const hasTransform = (slot: JsonObject | undefined): boolean =>
    pinnedTexturePatch(slot)._hasTx === true;

/**
 * Which of the pinned texture slots `buildDefaultPbrTexturesExt` actually
 * builds, and whether each carries a UV transform.
 *
 * This is the half that cannot be read off the glTF material alone, because
 * occlusion and metallic-roughness share one ORM slot and which of them fills
 * it depends on the *images* behind them:
 *
 * - occlusion on a non-zero texCoord with no metallic-roughness image becomes
 *   its own carrier and the ORM slot falls back to a factor texel;
 * - occlusion with no metallic-roughness image otherwise *becomes* the ORM
 *   texture, and there is no separate carrier at all;
 * - a separate carrier appears alongside metallic-roughness only when the two
 *   name the same image through different texture objects, or occlusion has a
 *   transform of its own — the orm-unpack case, so the two can be animated
 *   apart.
 */
function pinnedTextureSlots(
    material: JsonObject,
    imageOf: (textureIndex: unknown) => number | undefined,
): {
    hasOcclusionCarrier: boolean;
    hasUvTransform: boolean;
} {
    const pbr = asObject(material["pbrMetallicRoughness"]) ?? {};
    const baseColor = asObject(pbr["baseColorTexture"]);
    const metallicRoughness = asObject(pbr["metallicRoughnessTexture"]);
    const normal = asObject(material["normalTexture"]);
    const emissive = gltfEmissiveApplies(material)
        ? asObject(material["emissiveTexture"])
        : undefined;
    const occlusion = asObject(material["occlusionTexture"]);

    const occlusionImage = imageOf(occlusion?.["index"]);
    const metallicRoughnessImage = imageOf(metallicRoughness?.["index"]);
    const occlusionTexCoord = asNumber(occlusion?.["texCoord"]) ?? 0;

    const occlusionOnUv2 =
        occlusionTexCoord !== 0 &&
        occlusionImage !== undefined &&
        metallicRoughnessImage === undefined;
    const sharesOrmImage =
        occlusionImage !== undefined &&
        occlusionImage === metallicRoughnessImage &&
        (occlusion?.["index"] !== metallicRoughness?.["index"] ||
            hasTransform(occlusion));
    const hasOcclusionCarrier = occlusionOnUv2 || sharesOrmImage;

    // The ORM slot is whichever texture built it, so its transform is that
    // texture's — metallic-roughness when there is one, otherwise the occlusion
    // image standing in for it.
    const ormSlot = metallicRoughnessImage !== undefined
        ? metallicRoughness
        : occlusionOnUv2
            ? undefined
            : occlusion;

    // `needsGltfUvTransform` reads `_hasTx` off the *built* textures, so a
    // transform on a slot the assembly never builds does not count — and a
    // factor-only base colour is an uploaded texel carrying none.
    const hasUvTransform =
        (imageOf(baseColor?.["index"]) !== undefined &&
            hasTransform(baseColor)) ||
        (imageOf(normal?.["index"]) !== undefined && hasTransform(normal)) ||
        hasTransform(ormSlot) ||
        (imageOf(emissive?.["index"]) !== undefined &&
            hasTransform(emissive)) ||
        (hasOcclusionCarrier && hasTransform(occlusion));

    return { hasOcclusionCarrier, hasUvTransform };
}

/**
 * Builds the pinned material input for one glTF material.
 *
 * `alpha` and `_alphaCutOff` follow the pin's own blend predicate:
 * `alphaBlend === true || ((_alphaCutOff ?? 0) <= 0 && alpha < 1)`, so a MASK
 * material carries its cutoff and a BLEND material carries its alpha.
 */
export interface PinnedMaterialSceneContext {
    /**
     * True when the scene renders linear because some material transmits.
     * Upstream this is a property of the material, but it is decided by the
     * scene: enabling transmission retargets the frame graph's colour buffer to
     * a linear one, so *every* material in that scene composes the linear
     * image-processing arm, not just the transmissive ones. The refraction
     * extension reads it as `_linearImageProcessing`.
     */
    linearImageProcessing?: boolean;
    /**
     * Resolves a glTF texture index to the image index behind it. The texture
     * assembly branches on whether occlusion and metallic-roughness share an
     * *image*, which two distinct texture objects can, so the slot indices are
     * not enough on their own.
     */
    imageOf?: (textureIndex: unknown) => number | undefined;
    /**
     * True when `KHR_animation_pointer` drives this material's base colour
     * factor. An animated factor has to live in the material UBO, so the field
     * exists even when its load-time value is the default the assembly would
     * otherwise skip — Scene 242's material carries `[1,1,1,1]` at load and the
     * browser's fragment still declares `baseColorFactor`.
     */
    animatedBaseColorFactor?: boolean;
    /**
     * True when `KHR_animation_pointer` drives a `KHR_texture_transform` on
     * this material. `gltf-feature-animation-pointer.ts` calls
     * `enableMaterialUvTransform`, which sets `_hasUvTx` outright — the same
     * shape as the base-colour exception above, and for the same reason: the
     * animation writes into a UBO field, so the field has to exist.
     *
     * The load-time transform is typically the *empty* object in this case —
     * Scene 253's NormalScale and TextureTransform materials both declare
     * `KHR_texture_transform: {}` and animate offset and scale — so the
     * static rule and this one disagree exactly where it matters.
     */
    animatedUvTransform?: boolean;
    /**
     * The `animation-pointer-ext.ts` pointer families targeting this material,
     * from `gltfAnimatedExtensionTargets`. Each one makes `seedExtMaterials`
     * change the material's shape so the animation has somewhere to write.
     */
    animatedExtensionTargets?: PinnedAnimatedExtensionTargets;
    /**
     * True when `KHR_animation_pointer` drives this material's emissive factor
     * or its `KHR_materials_emissive_strength`. The emissive extension reads
     * `_emissiveColor` for `PBR_HAS_EMISSIVE_COLOR`, and an animated emissive
     * needs that field however the load-time factor reads — Scene 242 animates
     * both halves and its captured fragment declares `emissiveColor`.
     */
    animatedEmissive?: boolean;
}

/** The material indices a `KHR_animation_pointer` channel drives a pointer into. */
export function gltfAnimatedMaterialPointers(
    document: JsonObject,
    pointerSuffix: string,
): ReadonlySet<number> {
    return gltfAnimatedPointers(
        document,
        new RegExp(`^/materials/(\\d+)/${pointerSuffix}$`),
    );
}

/** Material indices whose animated pointer matches `pattern`. */
function gltfAnimatedPointers(
    document: JsonObject,
    pattern: RegExp,
): ReadonlySet<number> {
    const animated = new Set<number>();
    const animations = Array.isArray(document["animations"])
        ? (document["animations"] as JsonObject[])
        : [];
    for (const animation of animations) {
        const channels = Array.isArray(animation["channels"])
            ? (animation["channels"] as JsonObject[])
            : [];
        for (const channel of channels) {
            const pointer = asObject(
                asObject(asObject(channel["target"])?.["extensions"])?.[
                    "KHR_animation_pointer"
                ],
            )?.["pointer"];
            if (typeof pointer !== "string") continue;
            const match = pattern.exec(pointer);
            if (match) animated.add(Number(match[1]));
        }
    }
    return animated;
}

/**
 * Which of `animation-pointer-ext.ts`'s pointer families target a material.
 *
 * These are not the same list as the plain pointers: `animatedTargets` picks
 * out five specific ones because each makes `seedExtMaterials` *change the
 * material's shape* so the animation has a UBO field to write into. That is a
 * second-order effect the material alone cannot show — Scene 253's
 * OcclusionStrength sphere is an ordinary occlusion material whose composed
 * fragment reads no occlusion at all, purely because its strength animates.
 */
export interface PinnedAnimatedExtensionTargets {
    occlusionStrength?: boolean;
    transmission?: boolean;
    ior?: boolean;
    volumeThickness?: boolean;
    volumeTint?: boolean;
}

const extensionPointerFamilies: ReadonlyArray<
    readonly [keyof PinnedAnimatedExtensionTargets, RegExp]
> = [
    ["occlusionStrength", /^\/materials\/(\d+)\/occlusionTexture\/strength$/],
    [
        "transmission",
        /^\/materials\/(\d+)\/extensions\/KHR_materials_transmission\/transmissionFactor$/,
    ],
    ["ior", /^\/materials\/(\d+)\/extensions\/KHR_materials_ior\/ior$/],
    [
        "volumeThickness",
        /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/thicknessFactor$/,
    ],
    [
        "volumeTint",
        /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/(?:attenuationColor|attenuationDistance)$/,
    ],
];

/** `animatedTargets`, by material index. */
export function gltfAnimatedExtensionTargets(
    document: JsonObject,
): ReadonlyMap<number, PinnedAnimatedExtensionTargets> {
    const targets = new Map<number, PinnedAnimatedExtensionTargets>();
    for (const [family, pattern] of extensionPointerFamilies) {
        for (const material of gltfAnimatedPointers(document, pattern)) {
            const entry = targets.get(material) ?? {};
            entry[family] = true;
            targets.set(material, entry);
        }
    }
    return targets;
}

/**
 * `seedExtMaterials`, ported term for term.
 *
 * Runs after the ordinary mapping and uses the same "only if absent" merges
 * upstream does, so a material that already declares transmission or volume
 * keeps what the builder gave it and only gains what the animation needs.
 */
function seedAnimatedExtensions(
    input: PinnedMaterialInput,
    material: JsonObject,
    animated: PinnedAnimatedExtensionTargets,
): void {
    const extensions = asObject(material["extensions"]) ?? {};
    const subsurface = (): JsonObject =>
        (input["_subsurface"] ??= {}) as JsonObject;

    if (animated.occlusionStrength) {
        input.occlusionStrength =
            asNumber(asObject(material["occlusionTexture"])?.["strength"]) ?? 1;
        // `setReflectance(pm, {})` registers the reflectance extension without
        // setting a single property, and `_occlStrengthAnimated` is what that
        // extension's own `detect` reads for PBR2_HAS_REFLECTANCE_FACTORS.
        // The reflectance arm then *takes over* occlusion: `pbr-compose.ts`
        // forces `_hasOcclusion` false whenever it composes.
        input["_occlStrengthAnimated"] = true;
    }
    if (animated.transmission) {
        input["_transmissive"] = true;
        const surface = subsurface();
        surface["refraction"] ??= {
            intensity:
                asNumber(
                    asObject(extensions["KHR_materials_transmission"])?.[
                        "transmissionFactor"
                    ],
                ) ?? 0,
            indexOfRefraction:
                asNumber(asObject(extensions["KHR_materials_ior"])?.["ior"]) ??
                    1.5,
        };
    }
    if (animated.ior) {
        const ior =
            asNumber(asObject(extensions["KHR_materials_ior"])?.["ior"]) ?? 1.5;
        const surface = subsurface();
        surface["refraction"] ??= { intensity: 0, indexOfRefraction: ior };
        input["_metallicF0Factor"] = ((ior - 1) / (ior + 1)) ** 2 / 0.04;
        input["_specularWeight"] = 1;
    }
    if (animated.volumeThickness || animated.volumeTint) {
        const surface = subsurface();
        const volume = asObject(extensions["KHR_materials_volume"]) ?? {};
        if (animated.volumeThickness) {
            surface["thickness"] ??= {
                min: 0,
                max: asNumber(volume["thicknessFactor"]) ?? 0,
                useGlTFChannel: true,
            };
            const refraction = asObject(surface["refraction"]);
            if (refraction) refraction["useThicknessAsDepth"] = true;
        }
        if (animated.volumeTint) {
            surface["tint"] ??= {
                color: asNumbers(volume["attenuationColor"]) ?? [1, 1, 1],
                atDistance: asNumber(volume["attenuationDistance"]) ?? 1,
            };
        }
    }
}

/** Builds an `imageOf` resolver from a glTF document's `textures` array. */
export function gltfImageResolver(
    document: JsonObject,
): (textureIndex: unknown) => number | undefined {
    const textures = Array.isArray(document["textures"])
        ? (document["textures"] as JsonObject[])
        : [];
    return (textureIndex) => {
        if (typeof textureIndex !== "number") return undefined;
        const texture = textures[textureIndex];
        const source = texture?.["source"];
        return typeof source === "number" ? source : textureIndex;
    };
}

export function pinnedMaterialInputFromGltf(
    material: JsonObject,
    scene: PinnedMaterialSceneContext = {},
): PinnedMaterialInput {
    const pbr = asObject(material["pbrMetallicRoughness"]) ?? {};
    const baseColorFactor = asNumbers(pbr["baseColorFactor"]);
    const alphaMode = material["alphaMode"];
    const occlusion = asObject(material["occlusionTexture"]);
    const extensions = asObject(material["extensions"]) ?? {};

    const input: PinnedMaterialInput = {
        // `buildDefaultPbrTexturesExt` attaches the emissive texture from the
        // image alone; `needsGltfEmissive` gates only `setPbrEmissive`, which
        // writes `_emissiveColor`. So the texture — and with it
        // `PBR_HAS_EMISSIVE` and the emissive binding pair — is unconditional,
        // and Scene 253's module 9 shows exactly that: an emissive texture
        // bound, and no `emissiveUVm` beside it.
        emissiveTexture: asObject(material["emissiveTexture"]),
        normalTexture: asObject(material["normalTexture"]),
        doubleSided: material["doubleSided"] === true,
        // `gltf-pbr-builder.ts` and its slow-path sibling both set this
        // unconditionally, so it is a property of the glTF loader rather than
        // of the material: every glTF PBR material composes the specular-AA
        // block that derives `alphaG` from the normal's screen-space slope.
        enableSpecularAA: true,
        // `_computePbrMaterialFeatures` sets PBR_HAS_OCCLUSION from
        // `(occlusionStrength ?? 1) > 0`, so a material with no occlusion
        // texture has to carry zero rather than the glTF slot default of one:
        // otherwise the fragment samples `orm.r` for an occlusion the material
        // does not have, where the pin composes a constant `1.0`.
        // `assemblePbrPropsExt` writes `mat._occlusionImage ? 1.0 : 0` — the
        // glTF `strength` is not what this field carries, only whether an
        // occlusion image was decoded at all.
        //
        // Scene 253 disagrees and is left disagreeing rather than tuned away:
        // its one occlusion-textured material composes `occlusion = orm.r`
        // here, while all fifteen captured fragments carry `occlusion = 1.0`.
        // Forcing the field to zero matches that but costs a distinct variant
        // and gains no exact match, so the source keeps the vote until a
        // capture explains which materials actually reach `_occlusionImage`.
        occlusionStrength: occlusion ? 1 : 0,
    };
    // `setPbrEmissive` writes `_emissiveColor`, which is what the emissive
    // extension reads for its bit. The load-time factor decides it through
    // `needsGltfEmissive`, and an animated one needs the field regardless.
    const emissiveFactor = asNumbers(material["emissiveFactor"]);
    if (scene.animatedEmissive || gltfEmissiveApplies(material)) {
        input["_emissiveColor"] = emissiveFactor ?? [1, 1, 1];
    }
    const imageOf = scene.imageOf ?? ((): undefined => undefined);
    const slots = pinnedTextureSlots(material, imageOf);
    if (slots.hasOcclusionCarrier && occlusion) {
        input["occlusionTexture"] = occlusion;
        const texCoord = asNumber(occlusion["texCoord"]);
        if (texCoord) input["occlusionTexCoord"] = texCoord;
    }
    // `PBR2_HAS_UV_TRANSFORM` is contributed by the uv-transform extension's own
    // detect, which reads `_hasUvTx` — the marker the pinned loader stamps on
    // the textures it actually built.
    if (slots.hasUvTransform || scene.animatedUvTransform) {
        input["_hasUvTx"] = true;
    }
    if (scene.linearImageProcessing) input["_linearImageProcessing"] = true;
    // `gltf-pbr-builder-ext.ts` states the rule outright:
    //   `mat._baseColorImage && !isDefaultBaseColorFactor(...)`
    // Both halves matter. A default `[1,1,1,1]` is the identity and is
    // skipped; and a factor with *no image* behind it is not carried either,
    // because `uploadBaseColorFactorTexture` bakes it into the 1x1 texel the
    // slot samples instead — so a coloured, textureless material like Scene
    // 39's Rock declares no `baseColorFactor` field at all.
    const defaultBaseColorFactor =
        baseColorFactor === undefined ||
        (baseColorFactor[0] === 1 &&
            baseColorFactor[1] === 1 &&
            baseColorFactor[2] === 1 &&
            baseColorFactor[3] === 1);
    const hasBaseColorImage =
        imageOf(asObject(pbr["baseColorTexture"])?.["index"]) !== undefined;
    if (
        (hasBaseColorImage && !defaultBaseColorFactor) ||
        scene.animatedBaseColorFactor
    ) {
        input.baseColorFactor = baseColorFactor ?? [1, 1, 1, 1];
    }
    // The pin takes alpha from the factor for both blended and masked
    // materials, and carries the cutoff through the alpha-test setter.
    if (alphaMode === "BLEND") {
        input.alphaBlend = true;
        input.alpha = baseColorFactor?.[3] ?? 1;
    }
    if (alphaMode === "MASK") {
        input.alpha = baseColorFactor?.[3] ?? 1;
        input._alphaCutOff = asNumber(material["alphaCutoff"]) ?? 0.5;
    }
    if (asObject(pbr["metallicRoughnessTexture"])) {
        // The ORM slot is the metallic-roughness image; the pin reads it off
        // the material rather than through an extension.
        input["ormTexture"] = asObject(pbr["metallicRoughnessTexture"]);
    }
    if (asObject(pbr["baseColorTexture"])) {
        input["baseColorTexture"] = asObject(pbr["baseColorTexture"]);
    }

    for (const entry of materialExtensions) {
        const declared = asObject(extensions[entry.gltf]);
        if (!declared || !extensionEnabled(declared, entry.factor)) continue;
        const props: JsonObject = { isEnabled: true, ...declared };
        for (const [gltfSlot, pinnedProperty] of entry.textures) {
            const slot = asObject(declared[gltfSlot]);
            // A slot with no image behind it builds no texture, so the pin
            // has nothing to test — the same rule `pinnedTextureSlots`
            // applies to the base slots.
            if (!slot || imageOf(slot["index"]) === undefined) continue;
            // `detect` reads `_hasTx` and `_texCoord` off the built texture,
            // not off the glTF slot, so the slot carries what the loader's
            // own extension would have stamped on it.
            props[pinnedProperty] = { ...slot, ...pinnedTexturePatch(slot) };
        }
        input[entry.property] = props;
    }

    // Transmission is not a material extension upstream: `set-transmission.ts`
    // registers a scene hook, because enabling it retargets the frame graph's
    // colour buffer. Its extension still reads the material, through
    // `_transmissive` and `_subsurface.refraction`, and it is that pair rather
    // than the glTF extension's presence that decides whether a refraction
    // fragment composes — `intensity <= 0` composes none.
    const transmission = asObject(extensions["KHR_materials_transmission"]);
    if (transmission) {
        const intensity = asNumber(transmission["transmissionFactor"]) ?? 0;
        if (intensity > 0) {
            input["_transmissive"] = true;
            const refraction: JsonObject = { intensity };
            if (asObject(transmission["transmissionTexture"])) {
                refraction["texture"] = transmission["transmissionTexture"];
            }
            const volume = asObject(extensions["KHR_materials_volume"]);
            const subsurface: JsonObject = { refraction };
            if (volume) {
                const thickness: JsonObject = {
                    value: asNumber(volume["thicknessFactor"]) ?? 0,
                };
                if (asObject(volume["thicknessTexture"])) {
                    thickness["texture"] = volume["thicknessTexture"];
                    thickness["useGlTFChannel"] = true;
                }
                subsurface["thickness"] = thickness;
            }
            input["_subsurface"] = subsurface;
        }
    }

    if (scene.animatedExtensionTargets) {
        seedAnimatedExtensions(input, material, scene.animatedExtensionTargets);
    }

    if (asObject(extensions["KHR_materials_specular"])) {
        // The reflectance ext reads these two directly off the material.
        const specular = asObject(extensions["KHR_materials_specular"]) ?? {};
        if (asObject(specular["specularTexture"])) {
            input["_metallicReflectanceTexture"] = specular["specularTexture"];
        }
        if (asObject(specular["specularColorTexture"])) {
            input["_reflectanceTexture"] = specular["specularColorTexture"];
        }
    }
    return input;
}
