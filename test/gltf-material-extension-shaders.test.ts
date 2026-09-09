import assert from "node:assert/strict";
import test from "node:test";
import type {JsonObject} from "../src/gltf-document.js";
import {ensurePinnedLoaderExecution, pinnedMaterialInputFromGltf} from "../src/pinned-material-input.js";
import {composePinnedPbrVariant} from "../src/pinned-pbr-variants.js";

test("diffuse color and intensity maps compose distinct bindings with live UV matrices", async () => {
    await ensurePinnedLoaderExecution();
    const transform = { extensions: { KHR_texture_transform: { offset: [0.1, 0.3] } } };
    const material: JsonObject = { extensions: { KHR_materials_diffuse_transmission: {
        diffuseTransmissionFactor: 0.7,
        diffuseTransmissionColorFactor: [0.2, 0.4, 0.8],
        diffuseTransmissionColorTexture: { index: 0, ...transform },
        diffuseTransmissionTexture: { index: 1, ...transform },
    } } };
    const variant = await composePinnedPbrVariant(pinnedMaterialInputFromGltf(material, {
        imageOf: (index) => typeof index === "number" ? index : undefined,
    }));
    assert.match(variant.fragmentWgsl, /textureSample\(translucencyColorTexture_/);
    assert.match(variant.fragmentWgsl, /textureSample\(translucencyIntensityTexture_/);
    assert.match(variant.fragmentWgsl, /translucencyColorUVm/);
    assert.match(variant.fragmentWgsl, /translucencyIntensityUVm/);
});
