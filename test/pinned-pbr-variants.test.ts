import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { captureIsCurrent } from "../src/capture-instrumented.js";
import {
    composePinnedPbrVariant,
    registeredPbrExtensionIds,
} from "../src/pinned-pbr-variants.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "../src/pinned-shader-composer.js";

/** Whitespace is not shader identity; the composer and the capture differ in it. */
const normalize = (source: string): string =>
    source.replace(/\s+/g, " ").trim();

test("registers every PBR extension the pin owns", async () => {
    // Sorted by id, which is the order `_getPbrExtsSorted` returns; the
    // registration order that decides the UBO and bind-group layout is the
    // separate insertion order in `materialExtensionModules`.
    assert.deepEqual(await registeredPbrExtensionIds(), [
        "alpha-test",
        "anisotropy",
        "clearcoat",
        // The clustered light field: both `detect` hooks answer zero without
        // a `_clusteredLightState` marker, so registering them is inert for
        // every scene that never reaches the feature.
        "clustered-lights",
        "clustered-spot-lights",
        "emissive-color",
        "gamma-albedo",
        "ibl",
        "iridescence",
        // The baked lightmap, whose opt-in registers it upstream. Its own
        // `detect` answers zero for a material with no `lightmapTexture`,
        // so registering it here is inert for every scene that never calls
        // `enablePbrLightmap()`.
        "lightmap",
        // Mesh extensions: `pbr-renderable.ts` drains these from its own scan
        // over the scene's meshes, after the environment and the scene hooks.
        "morph",
        // `setPbrParallaxOcclusion` registers it; inert without a material's
        // `_parallaxOcclusion`.
        "parallax-occlusion",
        // Registered last, where the first geometry view arms it; inert
        // without PBR2_GEOMETRY_OUTPUT.
        "pbr-geometry-params",
        // The emission seam's textured ext: its `frag` returns null without
        // the RECT_AREA_PBR_EMISSION bit only textured area arms carry.
        "rect-area-emission",
        // enableRectAreaLights' ext: its `frag` returns null without the
        // RECT_AREA_PBR_SCENE scene bit only an area-enabled scene's arms
        // carry.
        "rect-area-light",
        "reflectance",
        "refraction",
        "sheen",
        "skeleton",
        "skybox",
        "subsurface",
        "unlit",
        "uv-transform",
        // Baked vertex animation. Upstream `attachVat` self-registers it,
        // so the shared renderable never imports it; registering it here is
        // inert for every scene that never bakes one -- its `frag` returns
        // null without MSH_VAT and its `bind` returns the binding index
        // unchanged.
        "vat",
    ]);
});

test("derives a material's feature bits through the pin's own detect hooks", async () => {
    const { PBR_HAS_CLEARCOAT } = await importPinnedModuleWithExports<{
        PBR_HAS_CLEARCOAT: number;
    }>("material/pbr/fragments/clearcoat-fragment.js", ["PBR_HAS_CLEARCOAT"]);
    const { PBR_HAS_OCCLUSION } = await importPinnedModule<{
        PBR_HAS_OCCLUSION: number;
    }>("material/pbr/pbr-flag-bits.js");

    const plain = await composePinnedPbrVariant({});
    assert.equal(plain.features & PBR_HAS_CLEARCOAT, 0);

    // Nothing here names a clearcoat bit: the material carries `_clearCoat`
    // and the registered extension's own `detect` contributes the bit.
    const coated = await composePinnedPbrVariant({
        _clearCoat: { isEnabled: true, intensity: 1 },
    });
    assert.equal(coated.features & PBR_HAS_CLEARCOAT, PBR_HAS_CLEARCOAT);
    assert.equal(coated.features & PBR_HAS_OCCLUSION, PBR_HAS_OCCLUSION);
});

test("composes the pin's colourless thin-instance vertex arm", async () => {
    const meshBits = await importPinnedModule<{
        MSH_HAS_THIN_INSTANCES: number;
    }>("material/mesh-features.js");
    const variant = await composePinnedPbrVariant(
        {},
        {
            meshFeatures: meshBits.MSH_HAS_THIN_INSTANCES,
        },
    );

    assert.match(variant.vertexWgsl, /@location\(3\)world0:vec4<f32>/);
    assert.match(variant.vertexWgsl, /@location\(6\)world3:vec4<f32>/);
    assert.ok(
        variant.vertexWgsl.includes(
            "let instanceWorld=mat4x4<f32>(world0,world1,world2," + "world3);",
        ),
    );
    assert.ok(
        variant.vertexWgsl.includes("finalWorld=mesh.world*instanceWorld;"),
    );
});

test("composes Scene 17's coloured PBR thin-instance arm exactly", async () => {
    // Modules 6 and 7 are the browser's PBR cube stages. Their feature word
    // is the pin's thin-instance bit plus its nested instance-colour bit; the
    // exact match proves both vertex transport and fragment modulation come
    // from `_createThinInstanceFragment(true)` rather than a local formula.
    const capturedVertexPath = resolve(
        "artifacts",
        "capture",
        "scene17",
        "shaders",
        "06-module-6.wgsl",
    );
    const capturedFragmentPath = resolve(
        "artifacts",
        "capture",
        "scene17",
        "shaders",
        "07-module-7.wgsl",
    );
    // Only a capture of THIS pin is evidence; `CaptureMeta.pin` says why.
    if (
        !captureIsCurrent("scene17", resolve("artifacts", "capture", "scene17"))
    ) {
        return;
    }
    let capturedVertex: string;
    let capturedFragment: string;
    try {
        capturedVertex = readFileSync(capturedVertexPath, "utf8");
        capturedFragment = readFileSync(capturedFragmentPath, "utf8");
    } catch {
        // Captures are disposable artifacts; skip rather than fail a clean tree.
        return;
    }

    const meshBits = await importPinnedModule<{
        MSH_HAS_THIN_INSTANCES: number;
        MSH_HAS_INSTANCE_COLOR: number;
    }>("material/mesh-features.js");
    const { PBR_HAS_ENV } = await importPinnedModule<{
        PBR_HAS_ENV: number;
    }>("material/pbr/pbr-flag-bits.js");
    const hemispheric = await importPinnedModule<{
        SINGLE_LIGHT_STRUCTS: string;
        getSingleLightBlock: () => string;
    }>("material/pbr/fragments/singlelight-hemispheric-wgsl.js");

    const variant = await composePinnedPbrVariant(
        { occlusionStrength: 0 },
        {
            sceneFeatures: PBR_HAS_ENV,
            meshFeatures:
                meshBits.MSH_HAS_THIN_INSTANCES |
                meshBits.MSH_HAS_INSTANCE_COLOR,
            lightMode: 1,
            singleLightType: "hemispheric",
            singleLightWgsl: hemispheric.SINGLE_LIGHT_STRUCTS,
            singleLightBlock: hemispheric.getSingleLightBlock(),
        },
    );

    assert.equal(variant.vertexWgsl, capturedVertex);
    assert.equal(variant.fragmentWgsl, capturedFragment);
});

test("composes Scene 19's fragment exactly as the browser compiled it", async () => {
    // The instrumented capture is the browser's own composed module for
    // Scene 19's sphere, checked byte-for-byte against the committed golden
    // when it was taken. Reproducing it from a material record is what says
    // the composer is being driven correctly rather than plausibly.
    const capture = resolve(
        "artifacts",
        "capture",
        "scene19",
        "shaders",
        "02-module-2.wgsl",
    );
    let captured: string;
    try {
        captured = readFileSync(capture, "utf8");
    } catch {
        // Captures are disposable artifacts; skip rather than fail a clean tree.
        return;
    }

    const { PBR_HAS_ENV } = await importPinnedModule<{ PBR_HAS_ENV: number }>(
        "material/pbr/pbr-flag-bits.js",
    );
    const hemispheric = await importPinnedModule<{
        SINGLE_LIGHT_STRUCTS: string;
        getSingleLightBlock: () => string;
    }>("material/pbr/fragments/singlelight-hemispheric-wgsl.js");

    const variant = await composePinnedPbrVariant(
        {
            _clearCoat: {
                isEnabled: true,
                intensity: 1,
                roughness: 0,
                indexOfRefraction: 2,
            },
        },
        {
            // The environment is a scene bit, not a material one.
            sceneFeatures: PBR_HAS_ENV,
            lightMode: 1,
            singleLightType: "hemi",
            singleLightWgsl: hemispheric.SINGLE_LIGHT_STRUCTS,
            singleLightBlock: hemispheric.getSingleLightBlock(),
        },
    );

    assert.equal(variant.fragmentKey, "ibl|clearcoat");
    assert.equal(normalize(variant.fragmentWgsl), normalize(captured));
});

test("composes the pin's bent-normal IBL arm for a material holding the texture", async () => {
    const { PBR_HAS_ENV } = await importPinnedModule<{ PBR_HAS_ENV: number }>(
        "material/pbr/pbr-flag-bits.js",
    );
    const { pinnedMeshFeaturesFromPrimitive } =
        await import("../src/pinned-mesh-features.js");
    const tangents = await pinnedMeshFeaturesFromPrimitive({
        attributes: { POSITION: 0, NORMAL: 0, TANGENT: 0, TEXCOORD_0: 0 },
    });
    const occluded = {
        normalTexture: {},
        ormTexture: {},
        occlusionStrength: 1,
    };
    const compose = (
        material: Record<string, unknown>,
        meshFeatures = tangents,
        sceneFeatures = PBR_HAS_ENV,
    ) => composePinnedPbrVariant(material, { meshFeatures, sceneFeatures });

    // Without the texture the installed hooks compose the IBL arm unchanged.
    const plain = await compose(occluded);
    assert.doesNotMatch(plain.fragmentWgsl, /bentNormal/);
    assert.match(
        plain.fragmentWgsl,
        /let colorSpecularEnvReflectance=specularEnvironmentReflectance\*seo\*eho;/,
    );

    // With it, the pin's patch drops `seo` and scales the radiance by the
    // spherical-Gaussian cone term; the vertex TBN frames the sample.
    const bent = await compose({ ...occluded, bentNormalTexture: {} });
    assert.equal(bent.fragmentKey, "ibl");
    assert.match(
        bent.fragmentWgsl,
        /let colorSpecularEnvReflectance=specularEnvironmentReflectance\*eho;/,
    );
    assert.match(
        bent.fragmentWgsl,
        /mix\(1\.0,environmentBentNormalOcclusion\(bentNormalW,R_raw,N,NdotVUnclamped,occlusion,alphaG\),bentNormalStrength\)/,
    );
    assert.match(bent.fragmentWgsl, /let bnTBN=TBN;/);
    assert.match(bent.fragmentWgsl, /var bentNormalTexture_:texture_2d<f32>/);
    assert.equal(
        bent.meshBindingLayout.length,
        plain.meshBindingLayout.length + 2,
    );
    const offsets = (bent.materialUboSpec as { _offsets: Map<string, number> })
        ._offsets;
    assert.ok(offsets.has("bentNormalParams"));

    // A mesh without tangents takes the left-handed cotangent frame.
    const cotangent = await compose(
        { ...occluded, bentNormalTexture: {} },
        await pinnedMeshFeaturesFromPrimitive({
            attributes: { POSITION: 0, NORMAL: 0, TEXCOORD_0: 0 },
        }),
    );
    assert.match(
        cotangent.fragmentWgsl,
        /let bnT=bnDp2p\*bnDuv1\.x\+bnDp1p\*bnDuv2\.x;/,
    );

    // The pin's gate: an occlusion texture with a positive strength, and an
    // environment for the IBL arm to patch.
    const unoccluded = { ...occluded, occlusionStrength: 0 };
    assert.equal(
        (await compose({ ...unoccluded, bentNormalTexture: {} })).fragmentWgsl,
        (await compose(unoccluded)).fragmentWgsl,
    );
    assert.doesNotMatch(
        (await compose({ ...occluded, bentNormalTexture: {} }, tangents, 0))
            .fragmentWgsl,
        /bentNormal/,
    );
});
