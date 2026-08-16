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
    textures: readonly string[];
}> = [
    {
        gltf: "KHR_materials_clearcoat",
        property: "_clearCoat",
        factor: "clearcoatFactor",
        textures: [
            "clearcoatTexture",
            "clearcoatRoughnessTexture",
            "clearcoatNormalTexture",
        ],
    },
    {
        gltf: "KHR_materials_sheen",
        property: "_sheen",
        factor: "sheenColorFactor",
        textures: ["sheenColorTexture", "sheenRoughnessTexture"],
    },
    {
        gltf: "KHR_materials_iridescence",
        property: "_iridescence",
        factor: "iridescenceFactor",
        textures: ["iridescenceTexture", "iridescenceThicknessTexture"],
    },
    {
        gltf: "KHR_materials_anisotropy",
        property: "_anisotropy",
        factor: "anisotropyStrength",
        textures: ["anisotropyTexture"],
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
 * True when any slot carries `KHR_texture_transform`.
 *
 * `needsGltfUvTransform` in `gltf-pbr-builder-ext.ts` tests exactly five slots
 * — base colour, normal, ORM, emissive and occlusion — and no extension's own
 * textures, so a clearcoat or transmission texture carrying a transform does
 * not make the material reach the uv-transform extension.
 */
function gltfMaterialHasTextureTransform(material: JsonObject): boolean {
    const pbr = asObject(material["pbrMetallicRoughness"]);
    const slots = [
        asObject(pbr?.["baseColorTexture"]),
        asObject(pbr?.["metallicRoughnessTexture"]),
        asObject(material["normalTexture"]),
        asObject(material["emissiveTexture"]),
        asObject(material["occlusionTexture"]),
    ];
    return slots.some(
        (slot) =>
            slot !== undefined &&
            asObject(slot["extensions"])?.["KHR_texture_transform"] !==
                undefined,
    );
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
        emissiveTexture: gltfEmissiveApplies(material)
            ? asObject(material["emissiveTexture"])
            : undefined,
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
        occlusionStrength: occlusion
            ? asNumber(occlusion["strength"]) ?? 1
            : 0,
    };
    // `occlusionTexture` on the pinned material is a *separate* carrier, and
    // the uv-transform extension splits occlusion onto its own UV whenever one
    // exists. A glTF material normally packs occlusion into the same image as
    // metallic-roughness, where the pin keeps reading the ORM slot and adds no
    // split — so the carrier exists only when the two reference different
    // images, which is the same distinction `buildDefaultPbrTexturesExt` draws.
    const metallicRoughness = asObject(pbr["metallicRoughnessTexture"]);
    if (
        occlusion &&
        occlusion["index"] !== metallicRoughness?.["index"]
    ) {
        input["occlusionTexture"] = occlusion;
        const texCoord = asNumber(occlusion["texCoord"]);
        if (texCoord) input["occlusionTexCoord"] = texCoord;
    }
    // `PBR2_HAS_UV_TRANSFORM` is contributed by the uv-transform extension's own
    // detect, which reads `_hasUvTx` — the marker the pinned loader sets on a
    // material any of whose slots carries KHR_texture_transform.
    if (gltfMaterialHasTextureTransform(material)) input["_hasUvTx"] = true;
    if (scene.linearImageProcessing) input["_linearImageProcessing"] = true;
    // `assemblePbrPropsExt` skips a default `[1,1,1,1]` factor, which is the
    // identity, so the presence of `baseColorFactor` — and with it
    // `PBR2_HAS_BASE_COLOR_FACTOR` — is narrower than the glTF slot.
    const defaultBaseColorFactor =
        baseColorFactor !== undefined &&
        baseColorFactor[0] === 1 &&
        baseColorFactor[1] === 1 &&
        baseColorFactor[2] === 1 &&
        baseColorFactor[3] === 1;
    if (baseColorFactor && !defaultBaseColorFactor) {
        input.baseColorFactor = baseColorFactor;
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
        // Each ext's `detect` tests its own texture properties for the map
        // bits, and the pinned property names differ from the glTF ones only
        // in that the pin drops the extension prefix on the first slot.
        for (const texture of entry.textures) {
            if (asObject(declared[texture])) props[texture] = declared[texture];
        }
        if (entry.property === "_anisotropy" && props["texture"] === undefined) {
            props["texture"] = declared["anisotropyTexture"];
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
