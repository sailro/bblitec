import assert from "node:assert/strict";
import test from "node:test";
import { gltfSourceAlbedoIdentities, packageSourceAlbedoIdentities } from "../src/gltf-material-texture-identity.js";
import { GLTF_SOURCE_ALBEDO_IDENTITIES, type JsonObject } from "../src/gltf-document.js";

function textured(index = 0, texCoord = 0): JsonObject {
    return {pbrMetallicRoughness: {baseColorTexture: {index, texCoord}}};
}

test("pinned glTF image cache shares source objects without collapsing separate image producers", async () => {
    const result = await gltfSourceAlbedoIdentities({
        materials: [textured(), textured(1), textured(2)],
        textures: [{source: 0}, {source: 0}, {source: 1}],
        images: [{uri: "same.png"}, {uri: "same.png"}],
    });
    assert.deepEqual(result.materials, [0, 0, 1, 2]);
    assert.deepEqual(result.fallbackTexels, {2: [255, 255, 255, 255]});
});

test("pinned factor textures are fresh objects and retain actual sRGB upload bytes", async () => {
    const factor = {pbrMetallicRoughness: {baseColorFactor: [0.25, 0.5, 0.75, 0.5]}};
    const result = await gltfSourceAlbedoIdentities({materials: [factor, factor, {}, {}]});
    assert.deepEqual(result.materials, [0, 1, 2, 3, 4]);
    assert.deepEqual(result.fallbackTexels, {
        0: [137, 188, 225, 128], 1: [137, 188, 225, 128],
        2: [255, 255, 255, 255], 3: [255, 255, 255, 255], 4: [255, 255, 255, 255],
    });
});

test("sampler activation preserves the pin's default sharing and fresh sampled wrappers", async () => {
    const document: JsonObject = {
        materials: [textured(), textured()], textures: [{source: 0, sampler: 0}], images: [{}],
        samplers: [{magFilter: 9729, minFilter: 9729}],
    };
    // LINEAR alone does not activate the sampler extension in this pin.
    assert.deepEqual((await gltfSourceAlbedoIdentities(document)).materials, [0, 0, 1]);
    document.samplers = [{magFilter: 9729, minFilter: 9729}, {magFilter: 9728}];
    assert.deepEqual((await gltfSourceAlbedoIdentities(document)).materials, [0, 1, 2]);
    document.samplers = [{magFilter: 9729, minFilter: 9987}, {magFilter: 9728}];
    assert.deepEqual((await gltfSourceAlbedoIdentities(document)).materials, [0, 0, 1]);
});

test("UV2 clones retain distinct source wrapper identities", async () => {
    assert.deepEqual((await gltfSourceAlbedoIdentities({
        materials: [textured(), textured(0, 1), textured(0, 1)],
        textures: [{source: 0}], images: [{}],
    })).materials, [0, 1, 2, 3]);
});

test("packaging refuses metadata collisions and unrepresented extension producers", async () => {
    for (const value of [null, false, {}, []]) {
        await assert.rejects(packageSourceAlbedoIdentities({[GLTF_SOURCE_ALBEDO_IDENTITIES]: value}), /already carries/);
    }
    for (const extension of ["KHR_texture_transform", "KHR_texture_basisu", "KHR_materials_pbrSpecularGlossiness"]) {
        await assert.rejects(gltfSourceAlbedoIdentities({extensionsUsed: [extension]}), /does not yet represent/);
    }
    const document: JsonObject = {materials: [{}], extensionsUsed: ["KHR_lights_punctual"]};
    await packageSourceAlbedoIdentities(document);
    assert.deepEqual(document[GLTF_SOURCE_ALBEDO_IDENTITIES], {
        materials: [0, 1], fallbackTexels: {0: [255, 255, 255, 255], 1: [255, 255, 255, 255]},
    });
});
