import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
    assertArmsCovered,
    composeGltfMaterials,
    unionArms,
    type PinnedMaterialArms,
} from "../src/pinned-material-arms.js";

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
