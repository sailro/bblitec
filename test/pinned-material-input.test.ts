import assert from "node:assert/strict";
import test from "node:test";
import { pinnedMaterialInputFromGltf } from "../src/pinned-material-input.js";
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
        emissiveTexture: { index: 1 },
        occlusionTexture: { index: 2, strength: 0.5, texCoord: 1 },
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.25] },
    });
    assert.equal(input.doubleSided, true);
    assert.equal(input.alphaBlend, true);
    assert.equal(input.alpha, 0.25);
    assert.equal(input.occlusionStrength, 0.5);
    assert.equal(input["occlusionTexCoord"], 1);
    assert.ok(input.normalTexture);
    assert.ok(input.emissiveTexture);
});

test("marks a material whose slot carries KHR_texture_transform", async () => {
    const plain = pinnedMaterialInputFromGltf({
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
    });
    assert.equal(plain["_hasUvTx"], undefined);

    const transformed = pinnedMaterialInputFromGltf({
        pbrMetallicRoughness: {
            baseColorTexture: {
                index: 0,
                extensions: { KHR_texture_transform: { scale: [2, 2] } },
            },
        },
    });
    assert.equal(transformed["_hasUvTx"], true);
});
