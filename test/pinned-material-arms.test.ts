import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
    assertArmsCovered,
    composeGltfMaterials,
    composeScenePbrVariants,
    materialSubjects,
    unionArms,
    type PinnedMaterialArms,
} from "../src/pinned-material-arms.js";
import { pinnedSceneArms } from "../src/pinned-scene-arms.js";

const armNames: (keyof PinnedMaterialArms)[] = [
    "clearcoat",
    "clearcoatF0Remap",
    "sheen",
    "sheenAlbedoScaling",
    "iridescence",
    "occlusionUv2",
    "transmission",
    "dispersion",
];

/** The .glb a generated scene loads, when that scene has been generated. */
function sceneAsset(scene: string): string | undefined {
    const directory = join("generated", scene, "assets");
    if (!existsSync(directory)) return undefined;
    const glb = readdirSync(directory).find((name) => /\.glb$/i.test(name));
    return glb ? join(directory, glb) : undefined;
}

test("reports the arms a scene's own materials compose", async (t) => {
    const asset = sceneAsset("scene37");
    if (!asset) return t.skip("scene37 has not been generated");
    const materials = await composeGltfMaterials(asset);
    assert.equal(materials.length, 6);

    // The sofa: five sheen materials over a plain frame, one of them with its
    // occlusion on TEXCOORD_1.
    assert.equal(
        materials.filter((material) => material.arms.sheen).length,
        5,
    );
    assert.ok(
        materials.every(
            (material) => material.arms.sheen === material.arms.sheenAlbedoScaling,
        ),
        "a glTF sheen is always the albedo-scaling model",
    );
    const union = unionArms(materials);
    assert.deepEqual(
        armNames.filter((arm) => union[arm]),
        ["sheen", "sheenAlbedoScaling", "occlusionUv2"],
    );
});

test("a glTF clearcoat never asks for the base-F0 remap", async (t) => {
    const asset = sceneAsset("scene28");
    if (!asset) return t.skip("scene28 has not been generated");
    const materials = await composeGltfMaterials(asset);
    const coats = materials.filter((material) => material.arms.clearcoat);
    assert.ok(coats.length > 0, "scene 28 is the glTF clearcoat scene");
    // `gltf-ext-clearcoat.ts` is the single caller passing `useF0Remap: false`,
    // so a glTF coat reflects off the base's own F0. Scene 19's coat comes
    // from `setPbrClearCoat` and does want the remap, which is why the two
    // scenes emit different fragments.
    assert.ok(
        coats.every((coat) => !coat.arms.clearcoatF0Remap),
        "a glTF coat composes the no-remap arm",
    );
});

test("refuses an emitted fragment missing any arm a material composes", async (t) => {
    const asset = sceneAsset("scene253");
    if (!asset) return t.skip("scene253 has not been generated");
    const materials = await composeGltfMaterials(asset);
    const union = unionArms(materials);
    const reached = armNames.filter((arm) => union[arm]);
    assert.ok(reached.length > 0);

    // The full union passes, and dropping any single arm from it fails with
    // that arm named. This is the whole point of the gate: the failure says
    // which material and which arm, at generation time, instead of arriving
    // as a shading bias in a parity report.
    assert.doesNotThrow(() => assertArmsCovered(materials, union, "scene253"));
    for (const arm of reached) {
        assert.throws(
            () =>
                assertArmsCovered(
                    materials,
                    { ...union, [arm]: false },
                    "scene253",
                ),
            new RegExp(`needs '${arm}'`),
            `dropping '${arm}' should be refused`,
        );
    }
});

test("allows an emitted fragment carrying more than the assets need", async (t) => {
    const asset = sceneAsset("scene39");
    if (!asset) return t.skip("scene39 has not been generated");
    const materials = await composeGltfMaterials(asset);
    // Scene 21's cloth is the real case: its sheen comes from `setPbrSheen` in
    // scene code and its glTF material declares no extensions at all. So the
    // fragment is a union over scene code *and* assets, and only a shortfall
    // is an error.
    const everything: PinnedMaterialArms = {
        clearcoat: true,
        clearcoatF0Remap: true,
        sheen: true,
        sheenAlbedoScaling: true,
        iridescence: true,
        occlusionUv2: true,
        transmission: true,
        dispersion: true,
    };
    assert.doesNotThrow(() =>
        assertArmsCovered(materials, everything, "scene39"),
    );
});

test("scene-code occlusion strength controls the pin's ORM arm", async () => {
    const material = {
        materialsBefore: 0,
        gltfAssetsBefore: 0,
        hasBaseColorTexture: true,
        hasOrmTexture: true,
        metallicFactor: 1,
        roughnessFactor: 1,
        directIntensity: 1,
        environmentIntensity: 1,
        alpha: 1,
        reflectance: 0.04,
        doubleSided: false,
        transmission: 0,
        ior: 1.5,
        thickness: 0,
    };
    const arms = await pinnedSceneArms({
        lightKinds: [],
        multiLight: false,
        noLight: true,
        toneMapping: [false],
        environment: false,
        fog: false,
    });
    const disabled = await composeScenePbrVariants(
        [{ ...material, occlusionStrength: 0 }],
        arms,
    );
    const enabled = await composeScenePbrVariants(
        [{ ...material, occlusionStrength: 1 }],
        arms,
    );

    assert.doesNotMatch(disabled[0]!.fragmentWgsl, /orm\.r/);
    assert.match(enabled[0]!.fragmentWgsl, /orm\.r/);
});

test("scene-code specular AA controls the pin's derivative roughness arm", async () => {
    const material = {
        materialsBefore: 0,
        gltfAssetsBefore: 0,
        hasBaseColorTexture: true,
        hasOrmTexture: true,
        metallicFactor: 1,
        roughnessFactor: 1,
        directIntensity: 1,
        environmentIntensity: 1,
        alpha: 1,
        reflectance: 0.04,
        doubleSided: false,
        transmission: 0,
        ior: 1.5,
        thickness: 0,
    };
    const arms = await pinnedSceneArms({
        lightKinds: [],
        multiLight: false,
        noLight: true,
        toneMapping: [false],
        environment: false,
        fog: false,
    });
    const disabled = await composeScenePbrVariants([material], arms);
    const enabled = await composeScenePbrVariants(
        [{ ...material, enableSpecularAA: true }],
        arms,
    );

    assert.doesNotMatch(disabled[0]!.fragmentWgsl, /dpdx\(N\)/);
    assert.match(enabled[0]!.fragmentWgsl, /dpdx\(N\)/);
});

test("Scene 26 composes the pin's subsurface thickness arm", async () => {
    const arms = await pinnedSceneArms({
        lightKinds: ["point"],
        multiLight: false,
        noLight: false,
        toneMapping: [true],
        environment: true,
        fog: false,
    });
    const variants = await composeScenePbrVariants(
        [{
            materialsBefore: 0,
            gltfAssetsBefore: 1,
            hasBaseColorTexture: true,
            hasOrmTexture: true,
            metallicFactor: 1,
            roughnessFactor: 1,
            directIntensity: 1,
            environmentIntensity: 1,
            alpha: 1,
            reflectance: 0.04,
            doubleSided: false,
            enableSpecularAA: true,
            transmission: 0,
            ior: 1.5,
            thickness: 0,
            subsurface: {
                intensity: 1,
                color: [1, 1, 1],
                diffusionDistance: [1, 1, 1],
                hasThicknessTexture: true,
                minimumThickness: 0,
                maximumThickness: 2.2,
            },
        }],
        arms,
    );

    assert.ok(variants.some((variant) => variant.fragmentKey.includes("subsurface")));
    for (const variant of variants) {
        assert.match(variant.fragmentWgsl, /subsurfaceParams/);
        assert.match(variant.fragmentWgsl, /thicknessTexture_/);
        assert.match(variant.fragmentWgsl, /dpdx\(N\)/);
    }
});

test("creation-only metallic F0 does not register the reflectance arm", async () => {
    const arms = await pinnedSceneArms({
        lightKinds: [],
        multiLight: false,
        noLight: true,
        toneMapping: [false],
        environment: false,
        fog: false,
    });
    const variants = await composeScenePbrVariants(
        [{
            materialsBefore: 0,
            gltfAssetsBefore: 0,
            hasBaseColorTexture: true,
            hasOrmTexture: true,
            metallicFactor: 1,
            roughnessFactor: 1,
            directIntensity: 1,
            environmentIntensity: 1,
            alpha: 1,
            reflectance: 0.04,
            occlusionStrength: 0,
            metallicF0Factor: 0.95,
            doubleSided: false,
            transmission: 0,
            ior: 1.5,
            thickness: 0,
        }],
        arms,
    );

    assert.doesNotMatch(variants[0]!.fragmentWgsl, /metallicF0Factor/);
});

test("a metallic-reflectance setter globally registers dormant F0", async () => {
    const arms = await pinnedSceneArms({
        lightKinds: [],
        multiLight: false,
        noLight: true,
        toneMapping: [false],
        environment: false,
        fog: false,
    });
    const material = {
        materialsBefore: 0,
        gltfAssetsBefore: 0,
        hasBaseColorTexture: true,
        hasOrmTexture: true,
        metallicFactor: 1,
        roughnessFactor: 1,
        directIntensity: 1,
        environmentIntensity: 1,
        alpha: 1,
        reflectance: 0.04,
        occlusionStrength: 0,
        doubleSided: false,
        transmission: 0,
        ior: 1.5,
        thickness: 0,
    };
    const variants = await composeScenePbrVariants(
        [
            {
                ...material,
                metallicReflectance: {
                    hasColor: false,
                    hasMetallicTexture: false,
                    hasReflectanceTexture: false,
                },
            },
            { ...material, metallicF0Factor: 0.95 },
        ],
        arms,
    );

    assert.doesNotMatch(variants[0]!.fragmentWgsl, /metallicF0Factor/);
    assert.match(variants[1]!.fragmentWgsl, /metallicF0Factor/);
});

test("a glTF dielectric globally registers scene-material F0", async () => {
    // The asset's non-default IOR calls the same pinned setter before scene
    // materials are composed. Its process-global registration therefore
    // exposes a later creation-time F0 even when scene code never calls the
    // setter itself.
    const subjects = await materialSubjects({
        materials: [{
            extensions: {
                KHR_materials_ior: { ior: 1.209 },
                // This clears the IOR-seeded setter options, deliberately
                // exercising registration by an otherwise empty call.
                KHR_materials_specular: { specularFactor: 1 },
            },
        }],
    });
    assert.equal(subjects[0]!.metallicReflectanceRegistered, true);
    assert.equal(subjects[0]!.input["_metallicF0Factor"], undefined);

    const arms = await pinnedSceneArms({
        lightKinds: [],
        multiLight: false,
        noLight: true,
        toneMapping: [false],
        environment: false,
        fog: false,
    });
    const variants = await composeScenePbrVariants(
        [{
            materialsBefore: 0,
            gltfAssetsBefore: 1,
            hasBaseColorTexture: true,
            hasOrmTexture: true,
            metallicFactor: 1,
            roughnessFactor: 1,
            directIntensity: 1,
            environmentIntensity: 1,
            alpha: 1,
            reflectance: 0.04,
            occlusionStrength: 0,
            metallicF0Factor: 0.95,
            doubleSided: false,
            transmission: 0,
            ior: 1.5,
            thickness: 0,
        }],
        arms,
        1,
        undefined,
        {
            metallicReflectanceRegistered: subjects.some(
                (subject) => subject.metallicReflectanceRegistered,
            ),
        },
    );

    assert.match(variants[0]!.fragmentWgsl, /metallicF0Factor/);
});

test("scene metallic-reflectance maps compose both linear bindings", async () => {
    const arms = await pinnedSceneArms({
        lightKinds: [],
        multiLight: false,
        noLight: true,
        toneMapping: [false],
        environment: false,
        fog: false,
    });
    const variants = await composeScenePbrVariants(
        [{
            materialsBefore: 0,
            gltfAssetsBefore: 0,
            hasBaseColorTexture: true,
            hasOrmTexture: true,
            metallicFactor: 1,
            roughnessFactor: 1,
            directIntensity: 1,
            environmentIntensity: 1,
            alpha: 1,
            reflectance: 0.04,
            occlusionStrength: 0,
            metallicF0Factor: 0.95,
            doubleSided: false,
            transmission: 0,
            ior: 1.5,
            thickness: 0,
            metallicReflectance: {
                hasColor: true,
                hasMetallicTexture: true,
                hasReflectanceTexture: true,
                useOnlyMetallicFromTexture: true,
            },
        }],
        arms,
    );

    const fragment = variants[0]!.fragmentWgsl;
    assert.match(fragment, /var metallicReflectanceMap\s*:\s*texture_2d<f32>/);
    assert.match(fragment, /var reflectanceMap\s*:\s*texture_2d<f32>/);
    assert.match(fragment, /let rLinear = pow\(rSample\.rgb/);
    assert.doesNotMatch(fragment, /let mrLinear = pow\(mrSample\.rgb/);
});
