import assert from "node:assert/strict";
import test from "node:test";
import {
    gltfImageResolver,
    pinnedMaterialInputFromGltf,
} from "../src/pinned-material-input.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

const environmentVariant = async (material: Record<string, unknown>) => {
    const { PBR_HAS_ENV } = await importPinnedModule<{ PBR_HAS_ENV: number }>(
        "material/pbr/pbr-flag-bits.js",
    );
    return composePinnedPbrVariant(pinnedMaterialInputFromGltf(material), {
        sceneFeatures: PBR_HAS_ENV,
    });
};

test("an extension declared without its factor is disabled", async () => {
    // Every one of these factors defaults to zero in glTF, so a material that
    // merely declares the extension composes no layer. Defaulting the other way
    // is not conservative — it adds a layer to the fragment, which is how
    // Scene 253's Volume and IOR spheres both composed as iridescent.
    for (const extension of [
        "KHR_materials_clearcoat",
        "KHR_materials_iridescence",
        "KHR_materials_anisotropy",
        "KHR_materials_sheen",
    ]) {
        const variant = await environmentVariant({
            extensions: { [extension]: {} },
        });
        assert.equal(
            variant.fragmentKey,
            "ibl",
            `${extension} with no factor should compose nothing`,
        );
    }
});

test("a non-zero factor reaches the extension's own detect", async () => {
    assert.equal(
        (
            await environmentVariant({
                extensions: {
                    KHR_materials_clearcoat: { clearcoatFactor: 1 },
                },
            })
        ).fragmentKey,
        "ibl|clearcoat-A",
    );
    assert.equal(
        (
            await environmentVariant({
                extensions: {
                    KHR_materials_iridescence: { iridescenceFactor: 1 },
                },
            })
        ).fragmentKey,
        "ibl|iridescence",
    );
    // A vector factor counts as enabled when any channel is non-zero.
    assert.equal(
        (
            await environmentVariant({
                extensions: {
                    KHR_materials_sheen: { sheenColorFactor: [0, 0, 0] },
                },
            })
        ).fragmentKey,
        "ibl",
    );
    assert.equal(
        (
            await environmentVariant({
                extensions: {
                    KHR_materials_sheen: { sheenColorFactor: [0, 0, 0.5] },
                },
            })
        ).fragmentKey,
        "ibl|sheen",
    );
});

test("an alpha-cutoff material reaches the alpha-test fragment", async () => {
    const variant = await environmentVariant({
        alphaMode: "MASK",
        alphaCutoff: 0.5,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
    });
    assert.equal(variant.fragmentKey, "alpha-test|ibl");
});

test("maps the material fields the base feature derivation reads", async () => {
    const input = pinnedMaterialInputFromGltf({
        doubleSided: true,
        alphaMode: "BLEND",
        normalTexture: { index: 0 },
        // A factor that is neither black nor neutral-over-texture, so the pin's
        // own predicate applies the emissive.
        emissiveTexture: { index: 1 },
        emissiveFactor: [0.5, 0.5, 0.5],
        occlusionTexture: { index: 2, strength: 0.5, texCoord: 1 },
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.25] },
    }, {
        imageOf: gltfImageResolver({
            textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
        }),
    });
    assert.equal(input.doubleSided, true);
    assert.equal(input.alphaBlend, true);
    assert.equal(input.alpha, 0.25);
    // The pin carries "was an occlusion image decoded", not the glTF strength.
    assert.equal(input.occlusionStrength, 1);
    // texCoord 1 with no metallic-roughness image makes occlusion its own
    // carrier rather than the ORM texture.
    assert.equal(input["occlusionTexCoord"], 1);
    assert.ok(input.normalTexture);
    assert.ok(input.emissiveTexture);
    assert.equal(input.baseColorFactor?.[3], 0.25);
});

test("drops an emissive the pin would not apply", async () => {
    // `[1,1,1]` multiplying a texture is the identity, and `[0,0,0]` is the
    // glTF default; neither reaches setPbrEmissive, so neither puts
    // PBR_HAS_EMISSIVE on the material or an emissiveUVm pair in its UBO.
    for (const emissiveFactor of [undefined, [0, 0, 0], [1, 1, 1]]) {
        const input = pinnedMaterialInputFromGltf({
            emissiveTexture: { index: 1 },
            ...(emissiveFactor ? { emissiveFactor } : {}),
        });
        assert.equal(input.emissiveTexture, undefined);
    }
    // With no texture, a full-white factor is a real emissive.
    assert.equal(
        pinnedMaterialInputFromGltf({ emissiveFactor: [1, 1, 1] })
            .emissiveTexture,
        undefined,
    );
});

test("skips a default base colour factor", async () => {
    assert.equal(
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
        }).baseColorFactor,
        undefined,
    );
    assert.deepEqual(
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 1, 1] },
        }).baseColorFactor,
        [1, 0.5, 1, 1],
    );
});

test("marks a material whose built texture carries KHR_texture_transform", async () => {
    // `_hasUvTx` reads `_hasTx` off the textures the assembly actually built,
    // so it needs an image behind the slot, not just a transform on it.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });

    const plain = pinnedMaterialInputFromGltf(
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        { imageOf },
    );
    assert.equal(plain["_hasUvTx"], undefined);

    const transformed = pinnedMaterialInputFromGltf(
        {
            pbrMetallicRoughness: {
                baseColorTexture: {
                    index: 0,
                    extensions: { KHR_texture_transform: { scale: [2, 2] } },
                },
            },
        },
        { imageOf },
    );
    assert.equal(transformed["_hasUvTx"], true);

    // A transform on a slot with no image behind it builds no texture, so it
    // stamps nothing — a factor-only base colour is an uploaded texel.
    const noImage = pinnedMaterialInputFromGltf({
        pbrMetallicRoughness: {
            baseColorTexture: {
                index: 0,
                extensions: { KHR_texture_transform: { scale: [2, 2] } },
            },
        },
    });
    assert.equal(noImage["_hasUvTx"], undefined);
});

test("occlusion becomes the ORM texture when there is no metallic-roughness image", async () => {
    const imageOf = gltfImageResolver({
        textures: [{ source: 0 }, { source: 1 }],
    });
    // No metallic-roughness image and texCoord 0: occlusion fills the ORM slot
    // and there is no separate carrier.
    const folded = pinnedMaterialInputFromGltf(
        { occlusionTexture: { index: 0 } },
        { imageOf },
    );
    assert.equal(folded["occlusionTexture"], undefined);

    // texCoord 1 with no metallic-roughness image: occlusion is its own carrier.
    const uv2 = pinnedMaterialInputFromGltf(
        { occlusionTexture: { index: 0, texCoord: 1 } },
        { imageOf },
    );
    assert.ok(uv2["occlusionTexture"]);
});
