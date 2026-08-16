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

/** Every texture-info slot a glTF material can carry, including its extensions'. */
function* gltfTextureSlots(material: JsonObject): Generator<JsonObject> {
    const pbr = asObject(material["pbrMetallicRoughness"]);
    const direct = [
        asObject(pbr?.["baseColorTexture"]),
        asObject(pbr?.["metallicRoughnessTexture"]),
        asObject(material["normalTexture"]),
        asObject(material["occlusionTexture"]),
        asObject(material["emissiveTexture"]),
    ];
    for (const slot of direct) if (slot) yield slot;
    for (const extension of Object.values(
        asObject(material["extensions"]) ?? {},
    )) {
        const declared = asObject(extension);
        if (!declared) continue;
        for (const value of Object.values(declared)) {
            const slot = asObject(value);
            if (slot && slot["index"] !== undefined) yield slot;
        }
    }
}

/** True when any slot carries `KHR_texture_transform`. */
function gltfMaterialHasTextureTransform(material: JsonObject): boolean {
    for (const slot of gltfTextureSlots(material)) {
        if (asObject(slot["extensions"])?.["KHR_texture_transform"]) return true;
    }
    return false;
}

/**
 * Builds the pinned material input for one glTF material.
 *
 * `alpha` and `_alphaCutOff` follow the pin's own blend predicate:
 * `alphaBlend === true || ((_alphaCutOff ?? 0) <= 0 && alpha < 1)`, so a MASK
 * material carries its cutoff and a BLEND material carries its alpha.
 */
export function pinnedMaterialInputFromGltf(
    material: JsonObject,
): PinnedMaterialInput {
    const pbr = asObject(material["pbrMetallicRoughness"]) ?? {};
    const baseColorFactor = asNumbers(pbr["baseColorFactor"]);
    const alphaMode = material["alphaMode"];
    const occlusion = asObject(material["occlusionTexture"]);
    const extensions = asObject(material["extensions"]) ?? {};

    const input: PinnedMaterialInput = {
        emissiveTexture: asObject(material["emissiveTexture"]),
        normalTexture: asObject(material["normalTexture"]),
        doubleSided: material["doubleSided"] === true,
        occlusionStrength: occlusion
            ? asNumber(occlusion["strength"]) ?? 1
            : 1,
    };
    if (occlusion) {
        // The uv-transform extension splits occlusion onto its own UV unless the
        // slot is on TEXCOORD_1, so it reads both the carrier and the texCoord.
        input["occlusionTexture"] = occlusion;
        const texCoord = asNumber(occlusion["texCoord"]);
        if (texCoord) input["occlusionTexCoord"] = texCoord;
    }
    // `PBR2_HAS_UV_TRANSFORM` is contributed by the uv-transform extension's own
    // detect, which reads `_hasUvTx` — the marker the pinned loader sets on a
    // material any of whose slots carries KHR_texture_transform.
    if (gltfMaterialHasTextureTransform(material)) input["_hasUvTx"] = true;
    if (baseColorFactor) {
        input.baseColorFactor = baseColorFactor;
        input.alpha = baseColorFactor[3] ?? 1;
    }
    if (alphaMode === "BLEND") input.alphaBlend = true;
    if (alphaMode === "MASK") {
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
