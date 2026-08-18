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

test("a declared extension composes its layer, factor or not", async () => {
    // Every one of the four loader extensions reads the same way —
    // `if (!c) return null;` then `setPbrX(out, { isEnabled: true, ... })` —
    // so presence alone enables the layer and the factor only sets its
    // intensity. Scene 253's Volume and IOR spheres both declare
    // `KHR_materials_iridescence: {}` with no factor at all, and both of
    // their captured fragments carry `iridescenceParams`.
    for (const [extension, key] of [
        // `-X` is the no-remap arm: `gltf-ext-clearcoat.ts` is the one caller
        // that passes `useF0Remap: false`, so a glTF coat and a scene-code
        // coat compose different fragments.
        ["KHR_materials_clearcoat", "ibl|clearcoat-XA"],
        ["KHR_materials_iridescence", "ibl|iridescence"],
        ["KHR_materials_sheen", "ibl|sheen"],
    ] as const) {
        assert.equal(
            (await environmentVariant({ extensions: { [extension]: {} } }))
                .fragmentKey,
            key,
            `${extension} with no factor should still compose its layer`,
        );
    }
});

test("a factor changes the intensity, not the variant", async () => {
    // The same key either way — what the factor decides is what gets written
    // into the UBO, which is not this module's concern.
    for (const extension of [
        { KHR_materials_clearcoat: { clearcoatFactor: 1 } },
        { KHR_materials_clearcoat: { clearcoatFactor: 0 } },
    ]) {
        assert.equal(
            (await environmentVariant({ extensions: extension })).fragmentKey,
            "ibl|clearcoat-XA",
        );
    }
});

test("a sheen roughness map that is the tint map is dropped", async () => {
    // `gltf-ext-sheen.ts` compares index *and* transform identity, because the
    // legacy packing reads roughness out of the tint texture's alpha.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }, { source: 1 }] });
    const sheenOf = (roughIndex: number) =>
        (pinnedMaterialInputFromGltf({
            extensions: {
                KHR_materials_sheen: {
                    sheenColorFactor: [1, 1, 1],
                    sheenColorTexture: { index: 0 },
                    sheenRoughnessTexture: { index: roughIndex },
                },
            },
        }, { imageOf })["_sheen"] as Record<string, unknown>)["roughnessTexture"];
    assert.equal(sheenOf(0), undefined, "same texture: read from the tint alpha");
    assert.ok(sheenOf(1), "a different texture is its own map");
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
    // No base colour image, so the factor is baked into the uploaded texel
    // and the material declares no `baseColorFactor` field — `alpha` above
    // still comes from it, because the blend predicate reads the factor
    // whether or not the field survives.
    assert.equal(input.baseColorFactor, undefined);
});

test("attaches the emissive texture but gates the emissive colour", async () => {
    // The texture comes from the image alone, so PBR_HAS_EMISSIVE and the
    // emissive binding pair are unconditional — Scene 253's module 9 binds an
    // emissive texture. `needsGltfEmissive` gates only `setPbrEmissive`, which
    // writes `_emissiveColor` and contributes PBR_HAS_EMISSIVE_COLOR.
    for (const emissiveFactor of [undefined, [0, 0, 0], [1, 1, 1]]) {
        const input = pinnedMaterialInputFromGltf({
            emissiveTexture: { index: 1 },
            ...(emissiveFactor ? { emissiveFactor } : {}),
        });
        assert.ok(input.emissiveTexture, "the texture is always attached");
        assert.equal(
            input["_emissiveColor"],
            undefined,
            `factor ${JSON.stringify(emissiveFactor)} over a texture applies nothing`,
        );
    }
    // With no texture, a full-white factor is a real emissive colour.
    assert.deepEqual(
        pinnedMaterialInputFromGltf({ emissiveFactor: [1, 1, 1] })[
            "_emissiveColor"
        ],
        [1, 1, 1],
    );
    // An animated emissive needs the field however the load-time factor reads.
    assert.ok(
        pinnedMaterialInputFromGltf(
            { emissiveTexture: { index: 1 }, emissiveFactor: [1, 1, 1] },
            { animatedEmissive: true },
        )["_emissiveColor"],
    );
});

test("skips a default base colour factor", async () => {
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });
    const withFactor = (baseColorFactor: number[]) =>
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: {
                baseColorFactor,
                baseColorTexture: { index: 0 },
            },
        }, { imageOf }).baseColorFactor;
    assert.equal(withFactor([1, 1, 1, 1]), undefined);
    assert.deepEqual(withFactor([1, 0.5, 1, 1]), [1, 0.5, 1, 1]);
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

test("the emissive slot's transform and uv2 bit ignore the factor", async () => {
    // `buildDefaultPbrTexturesExt` attaches the emissive texture from the
    // image alone, and `needsGltfUvTransform`/`uv2Mask` read the *built*
    // texture — so a neutral `[1,1,1]` factor (which writes no
    // `_emissiveColor`) still composes the transform arm and the uv2 bit.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });
    const transformed = pinnedMaterialInputFromGltf(
        {
            emissiveFactor: [1, 1, 1],
            emissiveTexture: {
                index: 0,
                extensions: { KHR_texture_transform: { scale: [2, 2] } },
            },
        },
        { imageOf },
    );
    assert.equal(transformed["_hasUvTx"], true);
    assert.equal(transformed["_emissiveColor"], undefined);

    const onUv2 = pinnedMaterialInputFromGltf(
        { emissiveTexture: { index: 0, texCoord: 1 } },
        { imageOf },
    );
    assert.equal((onUv2["_uv2Mask"] as number) & 8, 8);
});

test("a declared emissive-strength extension always writes the colour", async () => {
    // `gltf-ext-emissive-strength.ts` calls `setPbrEmissive(layer,
    // factor * strength)` whenever the extension is declared —
    // `emissiveStrength ?? 1`, factor default `[0,0,0]` — and the later
    // opt-in gate stands down on the already-written property.
    const strong = pinnedMaterialInputFromGltf({
        emissiveFactor: [1, 1, 1],
        emissiveTexture: { index: 0 },
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 } },
    });
    assert.deepEqual(strong["_emissiveColor"], [2, 2, 2]);

    // Declared empty: strength defaults to 1 and the colour is still written,
    // where the bare neutral-over-texture factor writes nothing.
    const declared = pinnedMaterialInputFromGltf({
        emissiveFactor: [1, 1, 1],
        emissiveTexture: { index: 0 },
        extensions: { KHR_materials_emissive_strength: {} },
    });
    assert.deepEqual(declared["_emissiveColor"], [1, 1, 1]);

    // Even a black factor carries the property, as the pin's ext does.
    const black = pinnedMaterialInputFromGltf({
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
    });
    assert.deepEqual(black["_emissiveColor"], [0, 0, 0]);
});

test("a declared-but-empty transform splits the occlusion carrier", async () => {
    // `occlusionNeedsSplit` tests `occ.extensions?.KHR_texture_transform !=
    // null` — declaration, not `_hasTx` — so an empty transform object splits
    // the shared ORM image into a dedicated occlusion carrier even though it
    // patches no field and stamps no `_hasTx`.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });
    const shared = {
        pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } },
    };
    const plain = pinnedMaterialInputFromGltf(
        { ...shared, occlusionTexture: { index: 0 } },
        { imageOf },
    );
    assert.equal(plain["occlusionTexture"], undefined);

    const declared = pinnedMaterialInputFromGltf(
        {
            ...shared,
            occlusionTexture: {
                index: 0,
                extensions: { KHR_texture_transform: {} },
            },
        },
        { imageOf },
    );
    assert.ok(declared["occlusionTexture"], "the empty transform splits");
    assert.equal(
        declared["_hasUvTx"],
        undefined,
        "but it patches no field, so no UV-transform arm composes",
    );
});

test("an extension texture reaches the pin under the pin's own property name", async () => {
    // Each `detect` reads its own names — the coat's normal map is
    // `bumpTexture`, the sheen tint and the iridescence map are both plain
    // `texture` — so copying under the glTF name leaves every map bit clear.
    // That composes a variant that looks plausible and samples nothing.
    const imageOf = gltfImageResolver({
        textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
    });
    const iridescence = pinnedMaterialInputFromGltf({
        extensions: {
            KHR_materials_iridescence: {
                iridescenceFactor: 1,
                iridescenceTexture: { index: 0 },
                iridescenceThicknessTexture: { index: 1, texCoord: 1 },
            },
        },
    }, { imageOf });
    const iri = iridescence["_iridescence"] as Record<string, unknown>;
    assert.ok(iri["texture"], "iridescenceTexture becomes `texture`");
    assert.ok(
        iri["thicknessTexture"],
        "iridescenceThicknessTexture becomes `thicknessTexture`",
    );
    assert.equal(
        (iri["thicknessTexture"] as Record<string, unknown>)["_texCoord"],
        1,
        "`detect` reads _texCoord off the built texture",
    );

    const clearcoat = pinnedMaterialInputFromGltf({
        extensions: {
            KHR_materials_clearcoat: {
                clearcoatFactor: 1,
                clearcoatNormalTexture: {
                    index: 2,
                    extensions: { KHR_texture_transform: { scale: [2, 2] } },
                },
            },
        },
    }, { imageOf });
    const coat = clearcoat["_clearCoat"] as Record<string, unknown>;
    assert.ok(coat["bumpTexture"], "clearcoatNormalTexture becomes `bumpTexture`");
    assert.equal(
        (coat["bumpTexture"] as Record<string, unknown>)["_hasTx"],
        true,
    );

    // The map arms then really compose: the fragment samples them.
    const { PBR_HAS_ENV } = await importPinnedModule<{ PBR_HAS_ENV: number }>(
        "material/pbr/pbr-flag-bits.js",
    );
    const variant = await composePinnedPbrVariant(iridescence, {
        sceneFeatures: PBR_HAS_ENV,
    });
    assert.match(variant.fragmentWgsl, /textureSample\(iridescenceTexture/);
    assert.match(
        variant.fragmentWgsl,
        /textureSample\(iridescenceThicknessTexture/,
    );

    // A slot with no image behind it builds no texture, so it stamps nothing.
    const noImage = pinnedMaterialInputFromGltf({
        extensions: {
            KHR_materials_sheen: {
                sheenColorFactor: [1, 1, 1],
                sheenColorTexture: { index: 0 },
            },
        },
    });
    assert.equal(
        (noImage["_sheen"] as Record<string, unknown>)["texture"],
        undefined,
    );
});

test("a texture transform counts only when it patches a field", async () => {
    // `gltf-ext-uv-transform.ts` builds a patch from scale/offset/rotation and
    // stamps `_hasTx` only if the patch is non-empty. Scene 39's Grass
    // material declares `KHR_texture_transform: {}` — the values would arrive
    // by animation if at all — and the browser's fragment for it has no
    // `txfUV` helper and no UV matrix fields.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });
    const transformed = (transform: unknown) =>
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: {
                baseColorTexture: {
                    index: 0,
                    extensions: { KHR_texture_transform: transform },
                },
            },
        }, { imageOf })["_hasUvTx"];

    assert.equal(transformed({}), undefined, "an empty transform patches nothing");
    // `rotation` is read for truthiness upstream, so zero is the same as absent.
    assert.equal(transformed({ rotation: 0 }), undefined);
    assert.equal(transformed({ rotation: 0.5 }), true);
    assert.equal(transformed({ scale: [1, 1] }), true);
    assert.equal(transformed({ offset: [0, 0] }), true);
});

test("an animated transform forces the UV fields the animation writes into", async () => {
    // `gltf-feature-animation-pointer.ts` calls `enableMaterialUvTransform`
    // for any material an animated `KHR_texture_transform` pointer targets,
    // which sets `_hasUvTx` outright. Scene 253's TextureTransform material
    // declares an empty transform and animates offset and scale, so the
    // static rule and this one disagree exactly where it matters.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });
    const material = {
        pbrMetallicRoughness: {
            baseColorTexture: {
                index: 0,
                extensions: { KHR_texture_transform: {} },
            },
        },
    };
    assert.equal(
        pinnedMaterialInputFromGltf(material, { imageOf })["_hasUvTx"],
        undefined,
    );
    assert.equal(
        pinnedMaterialInputFromGltf(material, {
            imageOf,
            animatedUvTransform: true,
        })["_hasUvTx"],
        true,
    );
});

test("the dielectric reflectance is what the executed pin set", async () => {
    // `gltf-ext-dielectric.ts` executes here, so the IOR Fresnel is the pin's
    // own `((ior - 1) / (ior + 1)) ** 2 / 0.04` — Scene 253's Transmission
    // sphere composes a reflectance arm purely because its ior is 1.209.
    const ior = pinnedMaterialInputFromGltf({
        extensions: { KHR_materials_ior: { ior: 1.209 } },
    });
    assert.equal(
        ior["_metallicF0Factor"],
        ((1.209 - 1) / (1.209 + 1)) ** 2 / 0.04,
    );
    assert.equal(ior["_specularWeight"], 1);
    assert.deepEqual(ior["_subsurface"], {
        refraction: { indexOfRefraction: 1.209 },
    });

    // An explicit specular factor of exactly 1 *clears* what the ior set —
    // the pin deletes both options before the reflectance gate runs.
    const cleared = pinnedMaterialInputFromGltf({
        extensions: {
            KHR_materials_ior: { ior: 1.209 },
            KHR_materials_specular: { specularFactor: 1 },
        },
    });
    assert.equal(cleared["_metallicF0Factor"], undefined);
    assert.equal(cleared["_specularWeight"], undefined);

    // The default ior of 1.5 composes no reflectance arm at all.
    const neutral = pinnedMaterialInputFromGltf({
        extensions: { KHR_materials_ior: { ior: 1.5 } },
    });
    assert.equal(neutral["_metallicF0Factor"], undefined);
});

test("an animated ior seeds the pin's own Fresnel", async () => {
    // `seedExtMaterials` executes over a one-material view, so the second
    // carrier of the IOR Fresnel is also the pin's `iorToF0Factor`, wired
    // through `setPbrMetallicReflectance` exactly as `prepareExtMaterials`
    // wires it.
    const input = pinnedMaterialInputFromGltf(
        { extensions: { KHR_materials_ior: { ior: 1.31 } } },
        { animatedExtensionTargets: { ior: true } },
    );
    assert.equal(
        input["_metallicF0Factor"],
        ((1.31 - 1) / (1.31 + 1)) ** 2 / 0.04,
    );
    assert.equal(input["_specularWeight"], 1);
    // The seed's `??=` keeps the refraction the dielectric builder made.
    assert.deepEqual(input["_subsurface"], {
        refraction: { indexOfRefraction: 1.31 },
    });
});

test("dispersion carries the pin's 20/dispersion through the volume gate", async () => {
    // `needsDispersion` demands an ior or transmission, a volume, and a
    // positive thickness; the refraction then carries `20 / dispersion` —
    // `setPbrDispersion`'s own argument, executed.
    const input = pinnedMaterialInputFromGltf({
        extensions: {
            KHR_materials_ior: { ior: 1.4 },
            KHR_materials_volume: { thicknessFactor: 0.5 },
            KHR_materials_dispersion: { dispersion: 0.25 },
        },
    });
    const subsurface = input["_subsurface"] as Record<string, unknown>;
    const refraction = subsurface["refraction"] as Record<string, unknown>;
    assert.equal(refraction["dispersion"], 20 / 0.25);
    // Without the volume, the same dispersion composes nothing.
    const gated = pinnedMaterialInputFromGltf({
        extensions: {
            KHR_materials_ior: { ior: 1.4 },
            KHR_materials_dispersion: { dispersion: 0.25 },
        },
    });
    const gatedRefraction = (gated["_subsurface"] as Record<string, unknown>)[
        "refraction"
    ] as Record<string, unknown>;
    assert.equal(gatedRefraction["dispersion"], undefined);
});

test("a base colour factor is carried only over a base colour image", async () => {
    // `gltf-pbr-builder-ext.ts`: `_baseColorImage && !isDefaultBaseColorFactor`.
    // With no image the factor is baked into the 1x1 texel the slot samples,
    // so the material declares no field — Scene 39's Rock is coloured and
    // textureless, and the browser's fragment reads `baseColorSample.rgb`
    // with nothing multiplied in.
    const imageOf = gltfImageResolver({ textures: [{ source: 0 }] });
    const factor = [0.78, 0.78, 0.78, 1];
    assert.equal(
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: { baseColorFactor: factor },
        }, { imageOf }).baseColorFactor,
        undefined,
        "no image: the factor is baked into the texel",
    );
    assert.deepEqual(
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: {
                baseColorFactor: factor,
                baseColorTexture: { index: 0 },
            },
        }, { imageOf }).baseColorFactor,
        factor,
    );
    // An animated factor needs the field however the load-time value reads.
    assert.deepEqual(
        pinnedMaterialInputFromGltf({
            pbrMetallicRoughness: { baseColorFactor: factor },
        }, { imageOf, animatedBaseColorFactor: true }).baseColorFactor,
        factor,
    );
});
