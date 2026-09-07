import assert from "node:assert/strict";
import test from "node:test";
import { asObject, GLTF_MATERIAL_EXTENSION_PAYLOAD, type JsonObject } from "../src/gltf-document.js";
import { packageMaterialExtensions } from "../src/gltf-material-extension-payload.js";
import { pinnedMaterialInputFromGltf } from "../src/pinned-material-input.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";

function payload(material: JsonObject): JsonObject {
    const result = asObject(material[GLTF_MATERIAL_EXTENSION_PAYLOAD]);
    assert.ok(result);
    return result;
}

test("packaging preserves anisotropy rotation, strength and its independent textureInfo", async () => {
    const texture = { index: 0, extensions: { KHR_texture_transform: { offset: [0.2, 0.7] } } };
    const material: JsonObject = { extensions: { KHR_materials_anisotropy: {
        anisotropyStrength: 0.65, anisotropyRotation: Math.PI / 2, anisotropyTexture: texture,
    } } };
    await packageMaterialExtensions({ materials: [material], textures: [{ source: 0 }], images: [{}] });
    const anisotropy = asObject(payload(material).anisotropy);
    assert.ok(anisotropy);
    assert.equal(anisotropy.intensity, 0.65);
    const direction = anisotropy.direction;
    assert.ok(Array.isArray(direction));
    assert.ok(Math.abs(Number(direction[0])) < 1e-15);
    assert.equal(direction[1], 1);
    assert.equal(asObject(anisotropy.texture)?.index, 0);
    assert.deepEqual(asObject(anisotropy.texture)?.extensions, texture.extensions);
    assert.equal(asObject(anisotropy.texture)?._hasTx, true);
});

test("diffuse transmission follows loaded-texture presence and uses zero thin-surface thickness", async () => {
    const materials: JsonObject[] = [
        { extensions: { KHR_materials_diffuse_transmission: {} } },
        { extensions: { KHR_materials_diffuse_transmission: { diffuseTransmissionTexture: { index: 0 } } } },
        { extensions: { KHR_materials_diffuse_transmission: { diffuseTransmissionColorTexture: { index: 0 }, diffuseTransmissionColorFactor: [0.2, 0.4] } } },
        { extensions: { KHR_materials_diffuse_transmission: { diffuseTransmissionTexture: { index: 1 } } } },
    ];
    await packageMaterialExtensions({ materials, textures: [{ source: 0 }], images: [{}] });
    assert.deepEqual(payload(materials[0]!), {});
    const subsurface = asObject(payload(materials[1]!).subsurface);
    assert.ok(subsurface);
    assert.deepEqual(subsurface.thickness, { min: 0, max: 0 });
    assert.equal(asObject(subsurface.translucency)?.intensity, 0);
    assert.equal(asObject(asObject(subsurface.translucency)?.intensityTexture)?.index, 0);
    assert.deepEqual(asObject(asObject(payload(materials[2]!).subsurface)?.translucency)?.color, [1, 1, 1]);
    assert.deepEqual(payload(materials[3]!), {});
});

test("dielectric's later material fragment replaces diffuse-transmission subsurface", async () => {
    const material: JsonObject = { extensions: {
        KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: 0.6 },
        KHR_materials_ior: { ior: 1.5 },
    } };
    await packageMaterialExtensions({ materials: [material] });
    assert.deepEqual(payload(material), {});
});

test("diffuse color and intensity maps compose distinct bindings with live UV matrices", async () => {
    const transform = { extensions: { KHR_texture_transform: { offset: [0.1, 0.3] } } };
    const material: JsonObject = { extensions: { KHR_materials_diffuse_transmission: {
        diffuseTransmissionFactor: 0.7,
        diffuseTransmissionColorFactor: [0.2, 0.4, 0.8],
        diffuseTransmissionColorTexture: { index: 0, ...transform },
        diffuseTransmissionTexture: { index: 1, ...transform },
    } } };
    await packageMaterialExtensions({ materials: [material], textures: [{ source: 0 }, { source: 1 }], images: [{}, {}] });
    const variant = await composePinnedPbrVariant(pinnedMaterialInputFromGltf(material, {
        imageOf: (index) => typeof index === "number" ? index : undefined,
    }));
    assert.match(variant.fragmentWgsl, /textureSample\(translucencyColorTexture_/);
    assert.match(variant.fragmentWgsl, /textureSample\(translucencyIntensityTexture_/);
    assert.match(variant.fragmentWgsl, /translucencyColorUVm/);
    assert.match(variant.fragmentWgsl, /translucencyIntensityUVm/);
});

test("ordinary assets are unchanged and source metadata collisions refuse", async () => {
    const ordinary: JsonObject = { materials: [{ pbrMetallicRoughness: { metallicFactor: 0.5 } }] };
    const before = JSON.stringify(ordinary);
    await packageMaterialExtensions(ordinary);
    assert.equal(JSON.stringify(ordinary), before);
    await assert.rejects(packageMaterialExtensions({ materials: [{
        extensions: { KHR_materials_anisotropy: {} },
        [GLTF_MATERIAL_EXTENSION_PAYLOAD]: {},
    }] }), /already carries compiler material extension metadata/);
});
