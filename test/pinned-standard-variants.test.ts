/**
 * The pinned Standard composition path: variants obtained from the pin's own
 * `composeStandardShader`, never re-derived.
 *
 * These assertions look for the pin's own markers — the LIGHTING_FN light
 * dispatch, the std-* fragment ids and slot text — so a variant that stops
 * carrying them is a pin change to see, and a repo input the composer cannot
 * yet be fed fails by name rather than composing a plausible neighbour.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    composePinnedStandardVariant,
    pinnedStandardMaterialFeatures,
    pinnedStandardVariantManifestEntry,
    registeredStandardExtensionIds,
} from "../src/pinned-standard-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

test("registers the pin's eight Standard material extensions", async () => {
    // Sorted by id — `_getStdExtsSorted` localeCompares — which is the
    // iteration order that decides fragment order and bind-group order.
    // `stdSkeletonExt` is deliberately absent: upstream registers it only
    // through enableStandardSkeleton(), which no reached scene calls.
    assert.deepEqual(await registeredStandardExtensionIds(), [
        "normal-map",
        "std-ambient",
        "std-cube-reflection",
        "std-emissive",
        "std-lightmap",
        "std-opacity",
        "std-reflection",
        "std-specular",
    ]);
});

test("derives feature bits through the pin's own detect", async () => {
    const flags = await importPinnedModule<{
        HAS_DIFFUSE_TEXTURE: number;
        DIFFUSE_USES_UV2: number;
        DOUBLE_SIDED: number;
        MATERIAL_ALPHA_BLEND: number;
        NEEDS_UV: number;
    }>("material/standard/standard-flags.js");
    const plain = await pinnedStandardMaterialFeatures({});
    assert.equal(plain, 0);
    const textured = await pinnedStandardMaterialFeatures({
        diffuseTexture: {},
        diffuseCoordIndex: 1,
    });
    assert.equal(
        textured & flags.HAS_DIFFUSE_TEXTURE,
        flags.HAS_DIFFUSE_TEXTURE,
    );
    assert.equal(textured & flags.DIFFUSE_USES_UV2, flags.DIFFUSE_USES_UV2);
    assert.notEqual(textured & flags.NEEDS_UV, 0);
    // The normalized defaults are the pin's: backFaceCulling true and alpha
    // 1, so an input naming neither flips neither bit.
    assert.equal(plain & flags.DOUBLE_SIDED, 0);
    assert.equal(plain & flags.MATERIAL_ALPHA_BLEND, 0);
    const doubleSided = await pinnedStandardMaterialFeatures({
        backFaceCulling: false,
        alpha: 0.5,
    });
    assert.equal(doubleSided & flags.DOUBLE_SIDED, flags.DOUBLE_SIDED);
    assert.equal(
        doubleSided & flags.MATERIAL_ALPHA_BLEND,
        flags.MATERIAL_ALPHA_BLEND,
    );
});

test("a textured two-light-shaped variant is the pin's own text", async () => {
    // Two lights (directional + hemispheric) are runtime data to the pinned
    // Standard fragment: it declares the MAX_LIGHTS array, loops
    // min(mesh.lc, MAX_LIGHTS) and dispatches the kind off vLightData.w —
    // there is no per-count shader. The composed text carries all of that.
    const types = await importPinnedModule<{ MAX_LIGHTS: number }>(
        "light/types.js",
    );
    const variant = await composePinnedStandardVariant({
        diffuseTexture: {},
    });
    // No extension fragment composes for a diffuse-only material: the
    // template itself owns the diffuse sample, so the pin's key is empty.
    assert.equal(variant.fragmentKey, "");
    const fragment = variant.fragmentWgsl;
    // LIGHTING_FN, verbatim markers: the hemispheric arm, the directional
    // arm, the point/spot shared falloff, the spot cone gate.
    assert.match(fragment, /fn computeLighting\(/);
    assert.match(fragment, /if \(t == 3u\)/);
    assert.match(fragment, /if \(t == 1u\)/);
    assert.match(fragment, /if \(t == 2u\)/);
    assert.match(
        fragment,
        /if \(c >= L\.vLightDirection\.w\) \{ a \*= max\(0\.0, pow\(c, L\.vLightSpecular\.a\)\); \} else \{ a = 0\.0; \}/,
    );
    // The multi-slot expression of a point-light scene like Scene 9: the
    // pin's own loop over the mesh's light selection, not unrolled slots.
    assert.ok(
        fragment.includes(
            `array<LightEntry, ${types.MAX_LIGHTS}>`,
        ),
    );
    assert.ok(fragment.includes(`min(mesh.lc, ${types.MAX_LIGHTS}u)`));
    assert.match(fragment, /for \(var li = 0u; li < lc; li\+\+\)/);
    assert.match(fragment, /let lightIndex = mli\(li\);/);
    assert.match(
        fragment,
        /fn mli\(i: u32\) -> u32 \{ return mesh\.li\[i \/ 4u\]\[i % 4u\]; \}/,
    );
    // The template's own diffuse sample and material block.
    assert.match(fragment, /textureSample\(dT, dS, input\.vu\)/);
    assert.match(fragment, /struct matUniforms \{/);
    // The vertex stage carries the uv passthrough against the up block.
    assert.match(
        variant.vertexWgsl,
        /out\.vu = uv \* up\.u\.xy \+ up\.u\.zw;/,
    );
});

test("extension fragments compose under the pin's ids", async () => {
    const variant = await composePinnedStandardVariant({
        diffuseTexture: {},
        emissiveTexture: {},
        bumpTexture: {},
        specularTexture: {},
        ambientTexture: {},
        opacityTexture: {},
        reflectionCubeTexture: {},
    });
    // Sorted-id order is the composed order.
    assert.equal(
        variant.fragmentKey,
        "normal-map|std-ambient|std-cube-reflection|std-emissive|" +
            "std-opacity|std-specular",
    );
    const fragment = variant.fragmentWgsl;
    // The pin's perturbNormal helper and its AC-slot call, verbatim.
    assert.match(fragment, /fn perturbNormal\(/);
    assert.match(
        fragment,
        /normalW = perturbNormal\(input\.vn, input\.vp, input\.vu, mat\.bs\);/,
    );
    assert.match(
        fragment,
        /emissiveContrib = mat\.ec \+ textureSample\(eT, eS, input\.vu\)\.rgb \* mat\.tl;/,
    );
    assert.match(
        fragment,
        /reflectionColor=textureSample\(cRT,cRS,reflect\(v,normalW\)\)\.rgb\*mat\.rLvl;/,
    );
});

test("fog composes the pin's scene-shader fragment", async () => {
    const variant = await composePinnedStandardVariant(
        { diffuseTexture: {} },
        { fog: true },
    );
    assert.equal(variant.fragmentKey, "std-fog");
    assert.match(variant.fragmentWgsl, /fn calcFogFactor\(/);
    assert.match(
        variant.fragmentWgsl,
        /color = vec4<f32>\(mix\(scene\.vFogColor\.rgb, color\.rgb, fog\), color\.a\);/,
    );
    assert.match(
        variant.vertexWgsl,
        /out\.vf = \(scene\.view \* vec4<f32>\(out\.vp, 1\.0\)\)\.xyz;/,
    );
});

test("vertex colours compose the pin's opt-in fragment", async () => {
    const variant = await composePinnedStandardVariant(
        { diffuseTexture: {} },
        { vertexColors: { vertexAlpha: false } },
    );
    assert.equal(variant.fragmentKey, "std-vertex-color");
    assert.match(variant.fragmentWgsl, /baseColor \*= input\.vColor\.rgb;/);
    assert.match(variant.vertexWgsl, /out\.vColor = color;/);
    // The vertex-alpha arm adds the pin's discard against the diffuse
    // sample's alpha and the blend bits.
    const flags = await importPinnedModule<{
        VERTEX_ALPHA: number;
        MATERIAL_ALPHA_BLEND: number;
    }>("material/standard/standard-flags.js");
    const alpha = await composePinnedStandardVariant(
        { diffuseTexture: {} },
        { vertexColors: { vertexAlpha: true } },
    );
    assert.equal(alpha.features & flags.VERTEX_ALPHA, flags.VERTEX_ALPHA);
    assert.equal(
        alpha.features & flags.MATERIAL_ALPHA_BLEND,
        flags.MATERIAL_ALPHA_BLEND,
    );
    assert.match(alpha.fragmentWgsl, /alpha \*= input\.vColor\.a;/);
    assert.match(
        alpha.fragmentWgsl,
        /if \(_ds\.a \* input\.vColor\.a < mat\.aCut\) \{ discard; \}/,
    );
});

test("the geometry MRT arm is the pin's own rewrite", async () => {
    const variant = await composePinnedStandardVariant(
        { diffuseTexture: {} },
        {
            geometry: {
                attachments: ["WORLD_NORMAL", "ALBEDO"],
                emitColor: false,
            },
        },
    );
    assert.match(variant.fragmentWgsl, /-> FragmentOutput/);
    assert.match(variant.fragmentWgsl, /struct FragmentOutput \{/);
    assert.match(
        variant.fragmentWgsl,
        /out\.f0 = vec4<f32>\(normalW \* 0\.5 \+ vec3<f32>\(0\.5\), select\(0\.0, 1\.0, alpha > 0\.4\)\);/,
    );
    assert.match(
        variant.fragmentWgsl,
        /out\.f1 = vec4<f32>\(baseColor, select\(0\.0, 1\.0, alpha > 0\.4\)\);/,
    );
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            { geometry: { attachments: ["NOT_A_TYPE"], emitColor: false } },
        ),
        /Unknown geometry texture type 'NOT_A_TYPE'/,
    );
});

test("composition is deterministic", async () => {
    const compose = () =>
        composePinnedStandardVariant(
            {
                diffuseTexture: {},
                emissiveTexture: {},
                bumpTexture: {},
            },
            { fog: true, vertexColors: { vertexAlpha: false } },
        );
    const first = await compose();
    const second = await compose();
    assert.deepEqual(second, first);
});

test("inputs the pin needs but this repo cannot supply throw by name", async () => {
    const meshBits = await importPinnedModule<{
        MSH_HAS_SKELETON: number;
        MSH_RECEIVE_SHADOWS: number;
        MSH_HAS_THIN_INSTANCES: number;
    }>("material/mesh-features.js");
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            { meshFeatures: meshBits.MSH_HAS_SKELETON },
        ),
        /enableStandardSkeleton/,
    );
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            { meshFeatures: meshBits.MSH_RECEIVE_SHADOWS },
        ),
        /createStdShadowFragment/,
    );
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            { meshFeatures: meshBits.MSH_HAS_THIN_INSTANCES },
        ),
        /thin instances/,
    );
    const flags = await importPinnedModule<{
        ESM_SHADOW_OUTPUT: number;
    }>("material/standard/standard-flags.js");
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            { passFeatures: flags.ESM_SHADOW_OUTPUT },
        ),
        /_esmShadowDepthCode/,
    );
});

test("the depth-only view composes the pin's NO_COLOR_OUTPUT arm", async () => {
    const flags = await importPinnedModule<{ NO_COLOR_OUTPUT: number }>(
        "material/standard/standard-flags.js",
    );
    const variant = await composePinnedStandardVariant(
        {},
        { passFeatures: flags.NO_COLOR_OUTPUT },
    );
    // `_noColorOutput` drops the colour return entirely; the varyings still
    // number themselves `@location(n)`, so the return type is the marker.
    assert.ok(!variant.fragmentWgsl.includes("-> @location(0)"));
    assert.match(variant.fragmentWgsl, /fn main\(input: FragmentInput\) \{/);
});

test("manifest entries carry deterministic file stems", async () => {
    const variant = await composePinnedStandardVariant(
        { diffuseTexture: {}, bumpTexture: {} },
        { fog: true },
    );
    const entry = pinnedStandardVariantManifestEntry(variant);
    assert.equal(
        entry.vertex,
        `normal-map-std-fog-f${variant.features}.vert.wgsl`,
    );
    assert.equal(
        entry.fragment,
        `normal-map-std-fog-f${variant.features}.frag.wgsl`,
    );
    assert.equal(entry.vertexWgsl, variant.vertexWgsl);
    assert.equal(entry.fragmentWgsl, variant.fragmentWgsl);
});
