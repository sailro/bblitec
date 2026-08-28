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
    babylonRenderableCount,
    composePinnedStandardVariant,
    composeSceneStandardVariants,
    pinnedStandardMaterialFeatures,
    pinnedStandardSupportBlock,
    pinnedStandardVariantManifestEntry,
    registeredStandardExtensionIds,
} from "../src/pinned-standard-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

test("registers the pin's nine Standard material extensions", async () => {
    // Sorted by id — `_getStdExtsSorted` localeCompares — which is the
    // iteration order that decides fragment order and bind-group order.
    // `stdUvTransformExt` sorts first and contributes nothing to a material
    // `enableMaterialUvTransform` did not mark, which is what lets it be
    // registered unconditionally beside the eight `_detect` ones.
    // `stdSkeletonExt` is deliberately absent: upstream registers it only
    // through enableStandardSkeleton(), which no reached scene calls.
    assert.deepEqual(await registeredStandardExtensionIds(), [
        "0-std-uv-transform",
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

test("getAlphaFromRGB composes the pin's luminance opacity arm", async () => {
    const flags = await importPinnedModule<{
        HAS_OPACITY_TEXTURE: number;
        OPACITY_FROM_RGB: number;
    }>("material/standard/standard-flags.js");
    // The .a arm without the flag, unchanged.
    const plain = await composePinnedStandardVariant({
        opacityTexture: {},
    });
    assert.equal(plain.features & flags.OPACITY_FROM_RGB, 0);
    assert.ok(
        plain.fragmentWgsl.includes(
            "alpha *= textureSample(oT, oS, input.vu).a * mat.opLvl;",
        ),
    );
    // The flag selects the pin's dot() luminance arm
    // (std-opacity-fragment.ts createStdOpacityFragment(fromRGB)) — the
    // Sponza chain/plant/Deg masks, browser module 18-module-18.wgsl.
    const fromRgb = await composePinnedStandardVariant({
        opacityTexture: {},
        opacityFromRGB: true,
    });
    assert.equal(
        fromRgb.features &
            (flags.HAS_OPACITY_TEXTURE | flags.OPACITY_FROM_RGB),
        flags.HAS_OPACITY_TEXTURE | flags.OPACITY_FROM_RGB,
    );
    assert.ok(
        fromRgb.fragmentWgsl.includes(
            "{ let opSample = textureSample(oT, oS, input.vu); " +
                "alpha *= dot(opSample.rgb, " +
                "vec3<f32>(0.3, 0.59, 0.11)) * mat.opLvl; }",
        ),
    );
    assert.ok(
        !fromRgb.fragmentWgsl.includes(
            "textureSample(oT, oS, input.vu).a",
        ),
    );
    // Fragment-only fork: the vertex stage is byte-identical either way.
    assert.equal(fromRgb.vertexWgsl, plain.vertexWgsl);
});

test("a 2D reflection composes the pin's std-reflection arm", async () => {
    const flags = await importPinnedModule<{
        HAS_REFLECTION_TEXTURE: number;
        HAS_CUBE_REFLECTION: number;
    }>("material/standard/standard-flags.js");
    const variant = await composePinnedStandardVariant({
        diffuseTexture: {},
        reflectionTexture: {},
    });
    assert.equal(
        variant.features & flags.HAS_REFLECTION_TEXTURE,
        flags.HAS_REFLECTION_TEXTURE,
    );
    assert.equal(variant.features & flags.HAS_CUBE_REFLECTION, 0);
    assert.equal(variant.fragmentKey, "std-reflection");
    const fragment = variant.fragmentWgsl;
    // The pin's own AD slot (std-reflection-fragment.ts): the coordinate
    // mode is a uniform fork (rCm < 1.5 spherical, else planar), not a
    // composition fork — Sponza carries both modes through one arm.
    assert.ok(
        fragment.includes("if (mat.rCm < 1.5) { reflCoords = " +
            "computeSphericalCoords(input.vp, normalW); }"),
    );
    assert.ok(
        fragment.includes(
            "else { reflCoords = computePlanarCoords(input.vp, normalW); }",
        ),
    );
    assert.ok(
        fragment.includes(
            "reflectionColor = textureSample(rT, rS, reflCoords).rgb " +
                "* mat.rLvl;",
        ),
    );
    // Both helper derivations, verbatim from the pin's REFLECTION_HELPERS.
    assert.match(
        fragment,
        /fn computeSphericalCoords\(worldPos: vec3<f32>, worldNormal: vec3<f32>\) -> vec2<f32> \{/,
    );
    assert.match(fragment, /r\.z = r\.z - 1\.0;/);
    assert.match(
        fragment,
        /return vec2<f32>\(coords\.x, 1\.0 - coords\.y\);/,
    );
    // The bindings are the pin's rT/rS 2D pair, not the cube's.
    assert.match(fragment, /var rT:texture_2d<f32>;/);
    assert.match(fragment, /var rS:sampler;/);
    assert.ok(!fragment.includes("cRT"));
    // Fragment-only fork: the vertex stage matches the same word without
    // the reflection (reflCoords derive from the vp/vn varyings already
    // carried, so no vertex-stage arm exists to compose).
    const without = await composePinnedStandardVariant({
        diffuseTexture: {},
    });
    assert.equal(variant.vertexWgsl, without.vertexWgsl);
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
        MSH_HAS_INSTANCE_COLOR: number;
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
    // `_computeMeshFeatures` sets the instance-colour bit only from
    // `mesh.thinInstances.colors`, so it cannot arrive without the pool
    // bit: the slot is spliced into the thin-instance fragment.
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            { meshFeatures: meshBits.MSH_HAS_INSTANCE_COLOR },
        ),
        /rides its thin-instance one/,
    );
    // The CSM receiver is the one shadow filter still refused: it resolves
    // through the cascaded receiver registry rather than through
    // `createShadowFragment`'s own two arms.
    await assert.rejects(
        composePinnedStandardVariant(
            {},
            {
                meshFeatures: meshBits.MSH_RECEIVE_SHADOWS,
                shadowLights: [{ lightIndex: 0, shadowType: "csm" }],
            },
        ),
        /cascaded receiver registry/,
    );
});

test("the ESM caster arm composes the pin's own depth code", async () => {
    const flags = await importPinnedModule<{
        ESM_SHADOW_OUTPUT: number;
    }>("material/standard/standard-flags.js");
    const variant = await composePinnedStandardVariant(
        {},
        { passFeatures: flags.ESM_SHADOW_OUTPUT },
    );
    assert.equal(
        variant.features & flags.ESM_SHADOW_OUTPUT,
        flags.ESM_SHADOW_OUTPUT,
    );
    // Verbatim from `createStandardEsmShadowMaterialView`: the exponential
    // depth the ESM map stores, which is what makes this a colour pass
    // rather than the depth-only one a PCF caster takes.
    assert.ok(
        variant.fragmentWgsl.includes(
            "let depthSM = clamp(exp(-min(87.0, " +
                "shadowParams.biasAndScale.z * depthMetricSM)), 0.0, 1.0);",
        ),
    );
});

test("the colourless thin-instance arm composes the pin's fragment", async () => {
    // `rebuildSingle` splices `tiFragment(false)` for a pool with no
    // instance colours -- the runtime sweep's lattices are exactly that.
    const meshBits = await importPinnedModule<{
        MSH_HAS_THIN_INSTANCES: number;
    }>("material/mesh-features.js");
    const variant = await composePinnedStandardVariant(
        {},
        { meshFeatures: meshBits.MSH_HAS_THIN_INSTANCES },
    );
    // The pin's per-instance matrix arrives as four vec4 attributes and
    // multiplies into finalWorld before the world-position product.
    assert.ok(
        variant.vertexWgsl.includes(
            "let instanceWorld = mat4x4<f32>(world0, world1, world2, " +
                "world3);",
        ),
    );
    assert.ok(
        variant.vertexWgsl.includes(
            "finalWorld = mesh.world * instanceWorld;",
        ),
    );
    const plain = await composePinnedStandardVariant({}, {});
    assert.notEqual(variant.vertexWgsl, plain.vertexWgsl);
});

test("a coloured pool composes the Standard family's own colour slot", async () => {
    // `rebuildSingle` builds `tiFragment(true)` and then REPLACES its
    // fragment slots with a `BC` one of its own -- Standard applies the
    // instance colour to the final colour where PBR applies it to the
    // base -- so the composed fragment must carry that text and not the
    // shared fragment's `AT` slot.
    const meshBits = await importPinnedModule<{
        MSH_HAS_THIN_INSTANCES: number;
        MSH_HAS_INSTANCE_COLOR: number;
    }>("material/mesh-features.js");
    const variant = await composePinnedStandardVariant(
        {},
        {
            meshFeatures: meshBits.MSH_HAS_THIN_INSTANCES |
                meshBits.MSH_HAS_INSTANCE_COLOR,
        },
    );
    assert.ok(variant.vertexWgsl.includes("out.vInstanceColor = instanceColor;"));
    assert.ok(
        variant.fragmentWgsl.includes(
            "color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, " +
                "color.a * input.vInstanceColor.a);",
        ),
    );
    // The shared fragment's own base-colour slot is the PBR family's and
    // must not survive the replacement.
    assert.ok(
        !variant.fragmentWgsl.includes("baseColor *= input.vInstanceColor.rgb"),
    );
    const colourless = await composePinnedStandardVariant(
        {},
        { meshFeatures: meshBits.MSH_HAS_THIN_INSTANCES },
    );
    assert.notEqual(variant.fragmentWgsl, colourless.fragmentWgsl);
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

test("the scene driver composes, dedups and keys a runtime-sweep shape", async () => {
    const meshBits = await importPinnedModule<{
        MSH_HAS_THIN_INSTANCES: number;
    }>("material/mesh-features.js");
    const flags = await importPinnedModule<{
        DISABLE_LIGHTING: number;
    }>("material/standard/standard-flags.js");
    const composition = await composeSceneStandardVariants(
        {
            babylonAssets: [],
            bumpTexture: false,
            diffuseUv2: false,
            fog: false,
            vertexColors: false,
            noColorViews: false,
            esmShadowViews: false,
            emissiveRenderTexture: false,
            diffuseRenderTexture: false,
            diffusePixelsTexture: false,
            diffuseFileTexture: false,
            emissiveFileTexture: false,
            uvTransform: false,
            standardMaterialPlugins: [],
            thinInstances: true,
            thinInstanceColors: false,
            morphTargets: false,
            sceneMaterials: true,
            sceneMeshFeatureValues: [0],
            geometryTasks: [],
        shadowLights: [],
        },
        () => {
            throw new Error("no assets to read");
        },
    );
    // Scene-code feature space is the setter closure {0, DISABLE_LIGHTING,
    // DOUBLE_SIDED, ALPHA_BLEND, ...}; only DISABLE_LIGHTING changes the
    // composed text, so the plain and thin-instanced lit/unlit pairs are
    // four distinct variants while every selector key resolves.
    assert.ok(composition.variants.length >= 4);
    const lit = composition.selectors.find(
        (selector) =>
            selector.features === 0 &&
            selector.meshFeatures === meshBits.MSH_HAS_THIN_INSTANCES,
    );
    assert.ok(lit, "the thin-instanced lit row exists");
    const unlit = composition.selectors.find(
        (selector) =>
            selector.features === flags.DISABLE_LIGHTING &&
            selector.meshFeatures === 0,
    );
    assert.ok(unlit, "the unlit plain row exists");
    assert.notEqual(
        composition.variants[lit.variant]!.vertexWgsl,
        composition.variants[unlit.variant]!.vertexWgsl,
    );
    // DOUBLE_SIDED and ALPHA_BLEND are pipeline state, not text: their rows
    // must resolve to the same variant index as the plain lit row.
    const doubleSidedFlags = await pinnedStandardMaterialFeatures({
        backFaceCulling: false,
    });
    const plain = composition.selectors.find(
        (selector) =>
            selector.features === 0 && selector.meshFeatures === 0,
    );
    const doubleSided = composition.selectors.find(
        (selector) =>
            selector.features === doubleSidedFlags &&
            selector.meshFeatures === 0,
    );
    assert.ok(plain && doubleSided);
    assert.equal(doubleSided.variant, plain.variant);
    // Determinism: the same inputs compose the same bytes and rows.
    const again = await composeSceneStandardVariants(
        {
            babylonAssets: [],
            bumpTexture: false,
            diffuseUv2: false,
            fog: false,
            vertexColors: false,
            noColorViews: false,
            esmShadowViews: false,
            emissiveRenderTexture: false,
            diffuseRenderTexture: false,
            diffusePixelsTexture: false,
            diffuseFileTexture: false,
            emissiveFileTexture: false,
            uvTransform: false,
            standardMaterialPlugins: [],
            thinInstances: true,
            thinInstanceColors: false,
            morphTargets: false,
            sceneMaterials: true,
            sceneMeshFeatureValues: [0],
            geometryTasks: [],
        shadowLights: [],
        },
        () => {
            throw new Error("no assets to read");
        },
    );
    assert.deepEqual(again, composition);
});

test("the babylon walk mirrors the generated loader's records", async () => {
    const document = JSON.stringify({
        materials: [
            {
                id: "walls",
                diffuseTexture: { name: "walls.jpg" },
                ambientTexture: { name: "ao.jpg", coordinatesIndex: 1 },
                backFaceCulling: true,
            },
            {
                id: "glass",
                alpha: 0.4,
                reflectionTexture: { name: "sky", isCube: true },
            },
            {
                // Sponza's chain shape: a luminance opacity mask.
                id: "chain",
                diffuseTexture: { name: "chain.jpg" },
                opacityTexture: {
                    name: "chain_mask.jpg",
                    getAlphaFromRGB: true,
                },
            },
            {
                // Sponza's vase shape: a 2D reflection (isCube absent).
                id: "vase",
                diffuseTexture: { name: "vase.jpg" },
                reflectionTexture: {
                    name: "ref.jpg",
                    level: 0.07,
                    coordinatesMode: 1,
                },
            },
        ],
        meshes: [
            {
                positions: [0, 0, 0],
                normals: [0, 1, 0],
                indices: [0, 0, 0],
                materialId: "walls",
                subMeshes: [
                    { materialIndex: 0, indexStart: 0, indexCount: 3 },
                    // Out-of-range submeshes create no record.
                    { materialIndex: 1, indexStart: 3, indexCount: 3 },
                ],
            },
            { positions: [0], normals: [0], indices: [] },
            { isVisible: false, positions: [0], normals: [0], indices: [0] },
        ],
    });
    assert.equal(babylonRenderableCount(document), 1);
    const flags = await importPinnedModule<{
        HAS_DIFFUSE_TEXTURE: number;
        HAS_AMBIENT_TEXTURE: number;
        AMBIENT_USES_UV2: number;
        HAS_CUBE_REFLECTION: number;
        MATERIAL_ALPHA_BLEND: number;
        HAS_OPACITY_TEXTURE: number;
        OPACITY_FROM_RGB: number;
        HAS_REFLECTION_TEXTURE: number;
    }>("material/standard/standard-flags.js");
    const composition = await composeSceneStandardVariants(
        {
            babylonAssets: ["asset.babylon"],
            bumpTexture: false,
            diffuseUv2: false,
            fog: false,
            vertexColors: false,
            noColorViews: false,
            esmShadowViews: false,
            emissiveRenderTexture: false,
            diffuseRenderTexture: false,
            diffusePixelsTexture: false,
            diffuseFileTexture: false,
            emissiveFileTexture: false,
            uvTransform: false,
            standardMaterialPlugins: [],
            thinInstances: false,
            thinInstanceColors: false,
            morphTargets: false,
            sceneMaterials: false,
            sceneMeshFeatureValues: [],
            geometryTasks: [],
        shadowLights: [],
        },
        () => document,
    );
    const words = composition.selectors.map(
        (selector) => selector.features,
    );
    assert.ok(
        words.includes(
            flags.HAS_DIFFUSE_TEXTURE | flags.HAS_AMBIENT_TEXTURE |
                flags.AMBIENT_USES_UV2,
        ),
        "the walls material's word composes",
    );
    assert.ok(
        words.includes(
            flags.HAS_CUBE_REFLECTION | flags.MATERIAL_ALPHA_BLEND,
        ),
        "the glass material's word composes",
    );
    assert.ok(
        words.includes(
            flags.HAS_DIFFUSE_TEXTURE | flags.HAS_OPACITY_TEXTURE |
                flags.OPACITY_FROM_RGB,
        ),
        "the chain material's getAlphaFromRGB word composes",
    );
    assert.ok(
        words.includes(
            flags.HAS_DIFFUSE_TEXTURE | flags.HAS_REFLECTION_TEXTURE,
        ),
        "the vase material's 2D-reflection word composes",
    );
    // The loader's lazily-created fallback material composes the plain word.
    assert.ok(words.includes(0));
});

test("the native-support block flows from the pin's own declarations", async () => {
    const context = new LoweringContext(new UpstreamSourceStore());
    const flags = await importPinnedModule<{
        NEEDS_UV: number;
        NO_COLOR_OUTPUT: number;
        HAS_DIFFUSE_TEXTURE: number;
        DISABLE_LIGHTING: number;
        MATERIAL_ALPHA_BLEND: number;
    }>("material/standard/standard-flags.js");
    const meshBits = await importPinnedModule<{
        MSH_HAS_MORPH_TARGETS: number;
        MSH_HAS_THIN_INSTANCES: number;
    }>("material/mesh-features.js");
    const block = pinnedStandardSupportBlock(context, {
        selectors: [
            { features: 0, meshFeatures: 0, variant: 0 },
            {
                features: flags.DISABLE_LIGHTING,
                meshFeatures: 0,
                geometryTask: 1,
                variant: 1,
            },
        ],
        uvTransform: false,
        plugins: false,
        renderableMeshFeatures: [0, 0, 4],
        runtimeMeshFeatures: 0,
    });
    // The pinned values, evaluated from their own declarations rather than
    // restated: NEEDS_UV, the pass bit, and the MSH_* runtime OR bits.
    assert.ok(
        block.includes(
            `inline constexpr std::uint32_t standard_needs_uv_mask = ` +
                `${flags.NEEDS_UV}u;`,
        ),
    );
    assert.ok(block.includes(`${flags.NO_COLOR_OUTPUT}u`));
    assert.ok(
        block.includes(`${meshBits.MSH_HAS_MORPH_TARGETS}u`),
    );
    assert.ok(
        block.includes(`${meshBits.MSH_HAS_THIN_INSTANCES}u`),
    );
    // The lowered derivation carries the pin's own structure: the diffuse
    // presence guard, the alpha-blend comparison, the disable-lighting flag
    // -- and none of the branches the loader cannot feed (no lightmap).
    assert.ok(
        block.includes(
            "if (material.base_color_texture.has_image() || " +
                "material.has_diffuse_render_texture) {",
        ),
    );
    assert.ok(
        block.includes(
            `features |= ${flags.HAS_DIFFUSE_TEXTURE}u; // ` +
                "HAS_DIFFUSE_TEXTURE",
        ),
    );
    assert.ok(
        block.includes("if (material.alpha < 1.0f) {"),
    );
    assert.ok(
        block.includes(
            `features |= ${flags.MATERIAL_ALPHA_BLEND}u; // ` +
                "MATERIAL_ALPHA_BLEND",
        ),
    );
    assert.ok(!block.includes("LIGHTMAP"));
    // The record-gap closures: the alpha lane and the pin-default fields
    // left untouched. bump_level is one-to-one — the record stores the
    // authored level and the pinned writer derives 1 / level itself.
    assert.ok(
        block.includes("props.bump_level = material.bump_scale;"),
    );
    assert.ok(
        block.includes("props.alpha = material.alpha;"),
    );
    assert.ok(!block.includes("props.lightmap_level"));
    // The rCm lane flows from the record's own field (the .babylon
    // loader's coordinatesMode === 2 write over the pin's default 1).
    assert.ok(
        block.includes(
            "props.reflection_coord_mode = material.reflection_coord_mode;",
        ),
    );
    // The lowered derivation reaches both new record sources: the nested
    // OPACITY_FROM_RGB arm and the 2D reflection presence.
    assert.ok(block.includes("if (material.opacity_from_rgb) {"));
    assert.ok(
        block.includes(
            "if (material.reflection_texture.has_image()) {",
        ),
    );
    // The composed variants' rT/rS pair resolves through the slot table,
    // not the cube path.
    assert.ok(
        block.includes(
            '{"rT", "rS", MaterialTextureSource::standard_reflection, ' +
                "false},",
        ),
    );
    // Selector rows and tables land as given.
    assert.ok(block.includes(`{${flags.DISABLE_LIGHTING}u, 0u, 1, 1},`));
    assert.ok(block.includes("standard_renderable_mesh_features"));
    // Deterministic emission.
    assert.equal(
        pinnedStandardSupportBlock(context, {
            selectors: [
                { features: 0, meshFeatures: 0, variant: 0 },
                {
                    features: flags.DISABLE_LIGHTING,
                    meshFeatures: 0,
                    geometryTask: 1,
                    variant: 1,
                },
            ],
            uvTransform: false,
            plugins: false,
            renderableMeshFeatures: [0, 0, 4],
            runtimeMeshFeatures: 0,
        }),
        block,
    );
});
